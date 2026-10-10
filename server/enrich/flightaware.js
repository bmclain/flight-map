// FlightAware AeroAPI: a paid fallback for what the free sources and our own
// receiver don't have — the route of a flight adsb.im and adsbdb don't know,
// its real take-off time and FlightAware's landing estimate, and (when a
// plane is tapped) the part of its flight path adsb.lol never saw.
//
// AeroAPI charges per query. The Personal plan waives the first $5 a month and
// allows 10 queries a minute; anything beyond is billed. So every query here
// goes through a ledger that is written to disk *before* the request is sent,
// and is refused unless it fits:
//   - the monthly budget (settings, at most $10), spread evenly over the days
//     left in the month so one busy afternoon can't use it all;
//   - a per-minute limit below FlightAware's;
//   - one page per query (max_pages=1, never following "next" links), so a
//     query costs exactly its list price.
// FlightAware's own usage figure (GET /account/usage, free) is checked every
// hour; if it's higher than ours (say the key is also used elsewhere), we go
// by theirs.
import path from 'node:path';
import { TtlCache } from '../util/cache.js';
import { SpendLedger } from '../util/ledger.js';

const API = 'https://aeroapi.flightaware.com/aeroapi';

// List price per result set (one page), USD — flightaware.com/commercial/aeroapi, October 2026.
export const FEES = {
  flights: 0.005, // GET /flights/{ident}
  track: 0.012, // GET /flights/{id}/track
  usage: 0, // GET /account/usage
};
export const MAX_BUDGET_USD = 10; // the most FlightAware waives (for ADS-B feeders)
export const MAX_PER_MINUTE = 8; // FlightAware's Personal limit is 10

const HOUR = 3600_000;
const FOUND_TTL = 6 * HOUR;
const NONE_TTL = 6 * HOUR;
const ERROR_TTL = 30 * 60_000;
const TRACK_TTL = 30 * 60_000;
const RECONCILE_MS = HOUR;

const isoSeconds = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

/** FlightAware's ledger (see server/util/ledger.js). */
export class AeroApiLedger extends SpendLedger {
  constructor(opts) {
    super({ name: 'flightaware', ...opts });
  }
}

const ms = (iso) => (iso ? Date.parse(iso) : null);

/**
 * The flight a plane in the air is flying now, from a /flights/{ident} answer:
 * taken off and not landed, else the latest one that should be in the air.
 */
export function currentFlight(flights, now = Date.now()) {
  const list = (flights ?? []).filter((f) => f && !f.blocked && !f.cancelled);
  const airborne = list.filter((f) => f.actual_off && !f.actual_on);
  if (airborne.length) return airborne.sort((a, b) => ms(b.actual_off) - ms(a.actual_off))[0];
  const due = list.filter((f) => {
    const off = ms(f.scheduled_off ?? f.scheduled_out);
    const on = ms(f.estimated_on ?? f.scheduled_on);
    return off && off <= now && (!on || on >= now - 30 * 60_000) && !f.actual_on;
  });
  return due.sort((a, b) => ms(b.scheduled_off ?? b.scheduled_out) - ms(a.scheduled_off ?? a.scheduled_out))[0] ?? null;
}

/** A FlightAware flight → the route shape routes.js gives the display, with times. */
export function routeFromFlight(f, airports) {
  const end = (a) => {
    if (!a) return null;
    const known = airports?.get(a.code_icao, a.code, a.code_lid) ?? null;
    return {
      icao: a.code_icao ?? known?.icao ?? a.code ?? null,
      iata: a.code_iata ?? known?.iata ?? null,
      name: a.name ?? known?.name ?? null,
      city: a.city ?? known?.city ?? null,
      country: known?.country ?? null,
      lat: known?.lat ?? null,
      lon: known?.lon ?? null,
      tz: a.timezone ?? null,
    };
  };
  const origin = end(f.origin);
  const destination = end(f.destination);
  if (!origin || !destination) return null;
  return {
    origin,
    destination,
    via: null,
    airline: null,
    flightIata: f.ident_iata ?? null,
    source: 'flightaware',
    plausible: true,
    faFlightId: f.fa_flight_id,
    times: {
      takeoff: ms(f.actual_off),
      landing: ms(f.actual_on ?? f.estimated_on),
      landed: !!f.actual_on,
      scheduledTakeoff: ms(f.scheduled_off),
      scheduledLanding: ms(f.scheduled_on),
      departureDelayMin: f.departure_delay != null ? Math.round(f.departure_delay / 60) : null,
      arrivalDelayMin: f.arrival_delay != null ? Math.round(f.arrival_delay / 60) : null,
    },
  };
}

export class FlightAware {
  constructor({ apiKey, dataDir, getConfig, airports = null, log = console, fetchImpl = fetch, usage = null }) {
    this.usage = usage;
    this.apiKey = apiKey || '';
    this.getConfig = getConfig;
    this.airports = airports;
    this.log = log;
    this.fetch = fetchImpl;
    this.ledger = new AeroApiLedger({ file: path.join(dataDir, 'cache', 'flightaware-ledger.json'), log });
    this.flights = new TtlCache({ maxEntries: 2000 });
    this.tracks = new TtlCache({ maxEntries: 200 });
    this.queue = new Map(); // ident → { kind } waiting for a query
    this.busy = false;
    this.disabledReason = null; // e.g. the key was rejected
    this.stats = { flights: 0, tracks: 0, found: 0, refused: 0, lastRefusal: null, lastError: null };
  }

  get cfg() {
    return this.getConfig().flightaware;
  }

  /** Configured, switched on, and not looking at simulated traffic. */
  get active() {
    const cfg = this.getConfig();
    return !!this.apiKey && cfg.flightaware.enabled && cfg.source.type !== 'simulator' && !this.disabledReason;
  }

  async init() {
    await this.ledger.load();
    if (!this.apiKey) return;
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS);
    this.reconcileTimer.unref?.();
    this.reconcile();
  }

  stop() {
    clearInterval(this.reconcileTimer);
    clearTimeout(this.wakeTimer);
  }

  /** Check FlightAware's own usage figure (free). */
  async reconcile() {
    if (!this.apiKey) return;
    try {
      const usage = await this.#get('/account/usage', {}, 'usage');
      if (usage && Number.isFinite(usage.total_cost)) await this.ledger.reconcile(usage.total_cost);
    } catch (err) {
      this.#error(err);
    }
  }

  /**
   * Route and times for an aircraft the free sources couldn't place.
   * Never blocks: unknown idents are queued and appear on a later call.
   * @param {string} ident  airline callsign ("WJA344") or registration ("C-GSAV")
   * @param {'designator'|'registration'} kind
   */
  route(ident, kind) {
    if (!this.active || !ident) return { status: 'off', route: null };
    const hit = this.flights.lookup(ident);
    if (hit) return hit.value ? { status: 'found', route: hit.value } : { status: 'none', route: null };
    if (!this.queue.has(ident)) {
      this.queue.set(ident, { kind });
      // Recent requests first; the oldest have probably flown off.
      while (this.queue.size > 20) this.queue.delete(this.queue.keys().next().value);
      this.#pump();
    }
    return { status: 'pending', route: null };
  }

  /** Make one query from the queue, if the ledger allows. */
  async #pump() {
    if (this.busy || !this.queue.size || !this.active) return;
    const refused = this.ledger.refusal(FEES.flights, this.#limits());
    if (refused) {
      this.#refused(refused.reason);
      if (refused.retryAt) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = setTimeout(() => this.#pump(), Math.max(1000, refused.retryAt - Date.now()));
        this.wakeTimer.unref?.();
      } else {
        // Out of budget: let the queue go rather than send it all later.
        this.queue.clear();
      }
      return;
    }
    this.busy = true;
    const [ident, { kind }] = this.queue.entries().next().value;
    this.queue.delete(ident);
    try {
      await this.#query(ident, kind);
    } finally {
      this.busy = false;
      if (this.queue.size) setTimeout(() => this.#pump(), 2000).unref?.();
    }
  }

  /** Like route(), but waits for the answer (when the ledger allows a query now). */
  async resolve(ident, kind) {
    if (!this.active || !ident) return null;
    const hit = this.flights.lookup(ident);
    if (hit) return hit.value;
    if (this.resolving?.ident === ident) return this.resolving.job;
    this.queue.delete(ident);
    const job = this.#query(ident, kind).finally(() => {
      this.resolving = null;
    });
    this.resolving = { ident, job };
    return job;
  }

  /** One /flights/{ident} query → the current flight's route (also cached), or null. */
  async #query(ident, kind) {
    try {
      const now = Date.now();
      const json = await this.#get(
        `/flights/${encodeURIComponent(ident)}`,
        {
          ident_type: kind,
          // Only flights that could be in the air now, so the answer fits on one page.
          start: isoSeconds(now - 20 * HOUR),
          end: isoSeconds(now + 2 * HOUR),
        },
        'flights',
      );
      this.stats.flights++;
      const f = currentFlight(json?.flights, now);
      const route = f ? routeFromFlight(f, this.airports) : null;
      if (route) this.stats.found++;
      this.flights.set(ident, route, route ? FOUND_TTL : NONE_TTL);
      return route;
    } catch (err) {
      if (!err.refused) {
        this.#error(err);
        this.flights.set(ident, null, ERROR_TTL);
      }
      return null;
    }
  }

  /**
   * The flight path FlightAware has for a flight, as [[lat, lon, t, altFt]], or
   * null. Costs a query, so only for a plane someone has tapped.
   */
  async track(faFlightId) {
    if (!this.active || !this.cfg.tracks || !faFlightId) return null;
    const hit = this.tracks.lookup(faFlightId);
    if (hit) return hit.value;
    if (this.trackPending?.id === faFlightId) return this.trackPending.job;
    const job = (async () => {
      try {
        const json = await this.#get(`/flights/${encodeURIComponent(faFlightId)}/track`, {}, 'track');
        this.stats.tracks++;
        const points = (json?.positions ?? [])
          .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
          .map((p) => [
            p.latitude,
            p.longitude,
            Date.parse(p.timestamp),
            Number.isFinite(p.altitude) ? p.altitude * 100 : null,
          ]);
        const result = points.length >= 2 ? points : null;
        this.tracks.set(faFlightId, result, TRACK_TTL);
        return result;
      } catch (err) {
        if (!err.refused) {
          this.#error(err);
          this.tracks.set(faFlightId, null, ERROR_TTL);
        }
        return null;
      } finally {
        this.trackPending = null;
      }
    })();
    this.trackPending = { id: faFlightId, job };
    return job;
  }

  #limits() {
    return {
      budget: Math.min(this.cfg.monthlyBudgetUsd, MAX_BUDGET_USD),
      perMinute: Math.min(this.cfg.perMinute, MAX_PER_MINUTE),
    };
  }

  /** Every request goes through here: checked against the ledger and booked before it's sent. */
  async #get(pathname, params, endpoint) {
    const cost = FEES[endpoint];
    if (cost == null) throw new Error(`no fee known for ${endpoint}`);
    if (cost > 0) {
      const refused = this.ledger.refusal(cost, this.#limits());
      if (refused) {
        this.#refused(refused.reason);
        throw Object.assign(new Error(refused.reason), { refused: true });
      }
      await this.ledger.charge(endpoint, cost);
      this.usage?.record('flightaware', { costUsd: cost });
    }
    const url = new URL(`${API}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (cost > 0) url.searchParams.set('max_pages', '1');
    const res = await this.fetch(url, {
      headers: { 'x-apikey': this.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      this.disabledReason = `FlightAware rejected the API key (HTTP ${res.status})`;
      throw new Error(this.disabledReason);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`FlightAware: HTTP ${res.status}`);
    return res.json();
  }

  #refused(reason) {
    this.stats.refused++;
    this.stats.lastRefusal = { reason, at: Date.now() };
  }

  #error(err) {
    this.stats.lastError = { message: err.message, at: Date.now() };
    this.log.warn(`flightaware: ${err.message}`);
  }

  status() {
    const cfg = this.cfg;
    const s = this.ledger.state;
    const left = this.ledger.allowance(Math.min(cfg.monthlyBudgetUsd, MAX_BUDGET_USD));
    return {
      configured: !!this.apiKey,
      active: this.active,
      disabledReason: this.disabledReason,
      budgetUsd: Math.min(cfg.monthlyBudgetUsd, MAX_BUDGET_USD),
      spentThisMonthUsd: s.spent,
      spentTodayUsd: this.ledger.spentToday(),
      leftTodayUsd: left.today,
      leftThisMonthUsd: left.month,
      reported: s.reported,
      calls: s.calls,
      queue: this.queue.size,
      ...this.stats,
    };
  }
}
