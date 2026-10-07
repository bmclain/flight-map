// Origin / destination lookup by callsign, using free community databases:
//   - adsb.im route API (batch POST, the data tar1090 shows; adsb.lol serves
//     the same API but currently answers with an empty body)
//   - adsbdb.com (also returns the airline name and IATA flight number)
// Results are cached for hours; a route is checked against the aircraft's
// position so obviously stale routes can be hidden.
import tzlookup from '@photostructure/tz-lookup';
import { distanceM, routeDetourM } from '../../shared/geo.js';
import { fetchJson, RateLimiter } from '../util/fetch.js';
import { TtlCache } from '../util/cache.js';

const HOUR = 3600_000;

/** Batch "routeset" endpoints that share the adsb.im / adsb.lol format. */
const ROUTESET = {
  adsbim: { url: 'https://adsb.im/api/0/routeset', label: 'adsb.im' },
  adsblol: { url: 'https://api.adsb.lol/api/0/routeset', label: 'adsb.lol' },
};
const FOUND_TTL = 12 * HOUR;
const MISSING_TTL = 3 * HOUR;
const ERROR_TTL = 10 * 60_000;

/** Callsigns that look like airline flights (ICAO prefix + number), e.g. UAL1234, ASA12B. */
export function isAirlineCallsign(cs) {
  return typeof cs === 'string' && /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(cs);
}

const stripAirportWords = (name) =>
  name
    ?.replace(/\b(international|intercontinental|regional|municipal|airport|airfield|field)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || null;

function airport({ icao, iata, name, city, country, lat, lon }) {
  return {
    icao: icao || null,
    iata: iata || null,
    name: name || null,
    city: city || stripAirportWords(name),
    country: country || null,
    lat: typeof lat === 'number' ? lat : null,
    lon: typeof lon === 'number' ? lon : null,
  };
}

/** adsb.im / adsb.lol `/api/0/routeset` entry → route (or null when unknown). */
export function normalizeRoutesetEntry(entry, source = 'adsb.im') {
  const airports = Array.isArray(entry?._airports) ? entry._airports : [];
  if (airports.length < 2) return null;
  return {
    airports: airports.map((a) =>
      airport({
        icao: a.icao,
        iata: a.iata,
        name: a.name,
        city: a.location,
        country: a.countryiso2,
        lat: a.lat,
        lon: a.lon,
      }),
    ),
    airline: null,
    flightIata: null,
    source,
  };
}

/** adsbdb `/v0/callsign/{cs}` response → route (or null when unknown). */
export function normalizeAdsbdbRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr?.origin || !fr?.destination) return null;
  const ap = (a) =>
    airport({
      icao: a.icao_code,
      iata: a.iata_code,
      name: a.name,
      city: a.municipality,
      country: a.country_iso_name,
      lat: a.latitude,
      lon: a.longitude,
    });
  const airports = [ap(fr.origin)];
  if (fr.midpoint) airports.push(ap(fr.midpoint));
  airports.push(ap(fr.destination));
  return {
    airports,
    airline: fr.airline ? { name: fr.airline.name, icao: fr.airline.icao, iata: fr.airline.iata } : null,
    flightIata: fr.callsign_iata || null,
    source: 'adsbdb',
  };
}

const zones = new Map();

/** IANA time zone at an airport ("America/Regina"), so the card can show its local time. */
export function airportTimeZone(ap) {
  if (ap?.lat == null || ap?.lon == null) return null;
  const key = `${ap.lat},${ap.lon}`;
  if (!zones.has(key)) {
    let tz = null;
    try {
      tz = tzlookup(ap.lat, ap.lon);
    } catch {
      // Out-of-range coordinates: leave the time in the viewer's zone.
    }
    zones.set(key, tz);
  }
  return zones.get(key);
}

const withTimeZone = (ap) => (ap.tz !== undefined ? ap : { ...ap, tz: airportTimeZone(ap) });

/**
 * Choose the leg of a (possibly multi-stop) route the aircraft is most likely
 * flying, and judge whether the route fits the aircraft's position at all.
 */
export function resolveLeg(route, pos) {
  const aps = route.airports;
  let i = 0;
  const havePos = pos && pos.lat != null && aps.every((a) => a.lat != null);
  if (havePos && aps.length > 2) {
    let best = Infinity;
    for (let k = 0; k < aps.length - 1; k++) {
      const d = routeDetourM(aps[k], aps[k + 1], pos);
      if (d < best) {
        best = d;
        i = k;
      }
    }
  }
  const origin = withTimeZone(aps[i]);
  const destination = withTimeZone(aps[i + 1]);
  let plausible = true;
  if (havePos) {
    const leg = distanceM(origin.lat, origin.lon, destination.lat, destination.lon);
    plausible = routeDetourM(origin, destination, pos) <= Math.max(150_000, 0.3 * leg);
  }
  return {
    origin,
    destination,
    via: aps.length > 2 ? aps.map((a) => a.iata || a.icao) : null,
    airline: route.airline,
    flightIata: route.flightIata,
    source: route.source,
    plausible,
  };
}

export class RouteResolver {
  constructor({ cacheFile = null, getConfig, log = console, fetchImpl = fetch, batchDelayMs = 1500 }) {
    this.cache = new TtlCache({ file: cacheFile });
    this.getConfig = getConfig;
    this.log = log;
    this.fetch = fetchImpl;
    this.batchDelayMs = batchDelayMs;
    this.pending = new Set();
    this.batch = new Map(); // callsign → position, waiting for a routeset batch
    this.batchTimer = null;
    this.adsbdbLimiter = new RateLimiter({ concurrency: 2, minIntervalMs: 250 });
    this.override = null; // (callsign) => route, used by the simulator
    this.loggedAt = new Map();
    this.stats = { lookups: 0, found: 0, errors: 0, lastError: null };
  }

  async load() {
    try {
      await this.cache.load();
    } catch (err) {
      this.log.warn(`routes: cache unreadable (${err.message})`);
    }
  }

  save() {
    return this.cache.save();
  }

  /**
   * Route for an aircraft, or a status explaining why there isn't one.
   * Never blocks: unknown callsigns are queued and appear on a later call.
   */
  get(callsign, pos, { lookup = true } = {}) {
    const cfg = this.getConfig().enrichment;
    if (!cfg.routes || !callsign) return { status: 'none', route: null };
    const sim = this.override?.(callsign);
    if (sim) return { status: 'found', route: { ...resolveLeg(sim, null), plausible: true } };
    if (!isAirlineCallsign(callsign)) return { status: 'none', route: null };

    const hit = this.cache.lookup(callsign);
    if (hit) {
      if (!hit.value) return { status: 'unknown', route: null };
      const leg = resolveLeg(hit.value, pos);
      if (!leg.plausible && cfg.hideImplausibleRoutes) return { status: 'implausible', route: null };
      return { status: 'found', route: leg };
    }
    if (!lookup) return { status: 'skipped', route: null };
    if (!this.pending.has(callsign)) this.#queue(callsign, pos, cfg.routeProviders);
    return { status: 'pending', route: null };
  }

  #queue(callsign, pos, providers) {
    if (!providers.length) return;
    this.pending.add(callsign);
    if (ROUTESET[providers[0]]) {
      this.batch.set(callsign, pos);
      this.batchTimer ??= setTimeout(() => this.#flushBatch(providers), this.batchDelayMs);
    } else {
      this.#adsbdb(callsign);
    }
  }

  async #flushBatch(providers) {
    this.batchTimer = null;
    const entries = [...this.batch].slice(0, 100);
    for (const [cs] of entries) this.batch.delete(cs);
    if (this.batch.size) this.batchTimer = setTimeout(() => this.#flushBatch(providers), this.batchDelayMs);

    const planes = entries.map(([callsign, pos]) => ({ callsign, lat: pos?.lat ?? 0, lng: pos?.lon ?? 0 }));
    const fallback = providers.includes('adsbdb');
    const api = ROUTESET[providers[0]];
    this.stats.lookups += planes.length;
    let results = [];
    try {
      results = await fetchJson(api.url, {
        fetchImpl: this.fetch,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planes }),
      });
      if (!Array.isArray(results)) throw new Error('unexpected routeset response');
    } catch (err) {
      this.#error(api.label, err);
      for (const [cs] of entries) {
        if (fallback) this.#adsbdb(cs);
        else this.#settle(cs, null, ERROR_TTL);
      }
      return;
    }
    const byCallsign = new Map(
      results.map((r) => [
        String(r.callsign ?? '')
          .trim()
          .toUpperCase(),
        r,
      ]),
    );
    for (const [cs] of entries) {
      const entry = byCallsign.get(cs);
      // The service flags routes that don't fit the aircraft's position.
      const route = entry?.plausible === false ? null : normalizeRoutesetEntry(entry, api.label);
      if (route) this.#settle(cs, route, FOUND_TTL);
      else if (fallback) this.#adsbdb(cs);
      else this.#settle(cs, null, MISSING_TTL);
    }
  }

  #adsbdb(callsign) {
    this.adsbdbLimiter
      .run(() =>
        fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, { fetchImpl: this.fetch }),
      )
      .then(
        (json) => {
          const route = normalizeAdsbdbRoute(json);
          this.#settle(callsign, route, route ? FOUND_TTL : MISSING_TTL);
        },
        (err) => {
          if (err.status === 404) this.#settle(callsign, null, MISSING_TTL);
          else {
            this.#error('adsbdb', err);
            this.#settle(callsign, null, ERROR_TTL);
          }
        },
      );
  }

  #settle(callsign, route, ttl) {
    this.pending.delete(callsign);
    if (route) this.stats.found++;
    this.cache.set(callsign, route, ttl);
  }

  #error(provider, err) {
    const now = Date.now();
    this.stats.errors++;
    const msg = `${provider}: ${err.message}`;
    if (now - (this.loggedAt.get(provider) ?? 0) > 60_000) {
      this.log.warn(`routes: ${msg}`);
      this.loggedAt.set(provider, now);
    }
    this.stats.lastError = { message: msg, at: now };
  }

  status() {
    return { cached: this.cache.size, pending: this.pending.size, ...this.stats };
  }
}
