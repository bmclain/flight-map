// The whole flight so far, from take-off, for the mini map on the aircraft
// card. Our own receiver only hears a plane for the last few hundred km; the
// adsb.lol community network usually has the rest. Its map serves each
// aircraft's track as readsb "trace" files: trace_full (the last day or so,
// rewritten every few minutes) and trace_recent (the last few minutes).
// adsb.lol data is open data (ODbL), so the mini map credits it.
import { distanceM } from '../../shared/geo.js';
import { fetchJson, RateLimiter } from '../util/fetch.js';
import { TtlCache } from '../util/cache.js';

const TRACE_URL = 'https://adsb.lol/data/traces';
// The older part of a flight doesn't change, and the displays add our own
// receiver's track to the end, so there's no need to fetch often.
const FOUND_TTL = 10 * 60_000;
const MISSING_TTL = 20 * 60_000;
const ERROR_TTL = 5 * 60_000;
// readsb marks the first point of each flight ("leg") in the point's flags.
const LEG_START_FLAG = 2;
// Without a take-off in the data, a gap this long starts a new flight.
const NEW_FLIGHT_GAP_MS = 3 * 3600_000;
const MIN_STEP_M = 500;

/** readsb trace JSON → [{ lat, lon, t, ground, legStart }] (t in ms). */
export function parseTrace(json) {
  const base = json?.timestamp;
  if (!Number.isFinite(base) || !Array.isArray(json.trace)) return [];
  return json.trace
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))
    .map((p) => ({
      lat: p[1],
      lon: p[2],
      t: Math.round((base + p[0]) * 1000),
      ground: p[3] === 'ground',
      legStart: (p[6] & LEG_START_FLAG) !== 0,
    }));
}

/** trace_full plus whatever trace_recent has that is newer. */
export function mergeTraces(full, recent) {
  const lastT = full.length ? full[full.length - 1].t : -Infinity;
  return [...full, ...recent.filter((p) => p.t > lastT)];
}

/** Only the current flight: from the last time the plane was on the ground (or a leg marker). */
export function currentFlight(points) {
  let end = points.length - 1;
  // Already landed? Then the flight is the one that just ended.
  while (end > 0 && points[end].ground) end--;
  let start = 0;
  for (let i = end; i > 0; i--) {
    if (points[i].ground || points[i].legStart) {
      start = i;
      break;
    }
    if (points[i].t - points[i - 1].t > NEW_FLIGHT_GAP_MS) {
      start = i;
      break;
    }
  }
  return points.slice(start);
}

/** Thin out points closer together than MIN_STEP_M (keeping the last one) → [[lat, lon, t]]. */
export function thinTrack(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    if (prev && i < points.length - 1 && distanceM(prev[0], prev[1], p.lat, p.lon) < MIN_STEP_M) continue;
    out.push([Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5, p.t]);
  }
  return out;
}

export class FlightTracks {
  constructor({ getConfig, log = console, fetchImpl = fetch }) {
    this.getConfig = getConfig;
    this.log = log;
    this.fetch = fetchImpl;
    this.cache = new TtlCache({ maxEntries: 500 });
    this.pending = new Map();
    this.limiter = new RateLimiter({ concurrency: 1, minIntervalMs: 1000 });
    this.loggedAt = 0;
    this.stats = { lookups: 0, found: 0, errors: 0, lastError: null };
  }

  /**
   * The current flight of aircraft `hex` as { points: [[lat, lon, t]], source },
   * or null when adsb.lol doesn't have it.
   */
  async get(hex) {
    if (!this.getConfig().enrichment.flightTracks) return null;
    const hit = this.cache.lookup(hex);
    if (hit) return hit.value;
    if (this.pending.has(hex)) return this.pending.get(hex);
    const job = this.limiter
      .run(() => this.#fetch(hex))
      .then(
        (track) => {
          if (track) this.stats.found++;
          this.cache.set(hex, track, track ? FOUND_TTL : MISSING_TTL);
          return track;
        },
        (err) => {
          this.#error(err);
          this.cache.set(hex, null, ERROR_TTL);
          return null;
        },
      )
      .finally(() => this.pending.delete(hex));
    this.pending.set(hex, job);
    return job;
  }

  async #fetch(hex) {
    this.stats.lookups++;
    const load = (kind) =>
      fetchJson(`${TRACE_URL}/${hex.slice(-2)}/trace_${kind}_${hex}.json`, { fetchImpl: this.fetch }).catch((err) => {
        if (err.status === 404) return null;
        throw err;
      });
    const [full, recent] = await Promise.all([load('full'), load('recent')]);
    const points = thinTrack(currentFlight(mergeTraces(parseTrace(full), parseTrace(recent))));
    return points.length >= 2 ? { points, source: 'adsb.lol' } : null;
  }

  #error(err) {
    const now = Date.now();
    this.stats.errors++;
    this.stats.lastError = { message: `adsb.lol: ${err.message}`, at: now };
    if (now - this.loggedAt > 60_000) {
      this.log.warn(`flight tracks: ${err.message}`);
      this.loggedAt = now;
    }
  }

  status() {
    return { cached: this.cache.size, pending: this.pending.size, ...this.stats };
  }
}
