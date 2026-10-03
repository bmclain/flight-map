// Two-letter (IATA) airline codes for airlines not in shared/airlines.js, from
// adsbdb, so a callsign like KLM639 can be shown as flight KL639. Looked up
// once per airline and remembered for a month.
import { fetchJson, RateLimiter } from '../util/fetch.js';
import { TtlCache } from '../util/cache.js';

const FOUND_TTL = 30 * 24 * 3600_000;
const MISSING_TTL = 7 * 24 * 3600_000;
const ERROR_TTL = 30 * 60_000;

const words = (s) =>
  new Set(
    String(s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !['air', 'airlines', 'airways', 'the'].includes(w)),
  );

/**
 * adsbdb `/v0/airline/{icao}` response → { name, iata } (or null). adsbdb now
 * and then has a different airline under the same code, so when we already
 * know the airline's name and adsbdb's has no word in common with it, its
 * answer is ignored.
 */
export function normalizeAdsbdbAirline(json, knownName = null) {
  const list = json?.response;
  const a = Array.isArray(list) ? list[0] : list;
  if (!a || typeof a !== 'object' || !a.name) return null;
  if (knownName) {
    const known = words(knownName);
    if (known.size && ![...words(a.name)].some((w) => known.has(w))) return null;
  }
  return { name: a.name, iata: /^[A-Z0-9]{2}$/.test(a.iata ?? '') ? a.iata : null };
}

export class AirlineDirectory {
  constructor({ cacheFile = null, log = console, fetchImpl = fetch }) {
    this.cache = new TtlCache({ file: cacheFile, maxEntries: 5000 });
    this.log = log;
    this.fetch = fetchImpl;
    this.pending = new Set();
    this.limiter = new RateLimiter({ concurrency: 1, minIntervalMs: 500 });
    this.loggedAt = 0;
  }

  async load() {
    try {
      await this.cache.load();
    } catch (err) {
      this.log.warn(`airlines: cache unreadable (${err.message})`);
    }
  }

  save() {
    return this.cache.save();
  }

  /**
   * { name, iata } for an ICAO airline code, null if adsbdb doesn't know it,
   * or undefined while it's being looked up. Never blocks.
   */
  get(icao, knownName = null) {
    const hit = this.cache.lookup(icao);
    if (hit) return hit.value;
    if (!this.pending.has(icao)) this.#lookup(icao, knownName);
    return undefined;
  }

  #lookup(icao, knownName) {
    this.pending.add(icao);
    this.limiter
      .run(() => fetchJson(`https://api.adsbdb.com/v0/airline/${encodeURIComponent(icao)}`, { fetchImpl: this.fetch }))
      .then(
        (json) => {
          const airline = normalizeAdsbdbAirline(json, knownName);
          this.cache.set(icao, airline, airline ? FOUND_TTL : MISSING_TTL);
        },
        (err) => {
          if (err.status === 404) {
            this.cache.set(icao, null, MISSING_TTL);
            return;
          }
          this.cache.set(icao, null, ERROR_TTL);
          if (Date.now() - this.loggedAt > 60_000) {
            this.log.warn(`airlines: adsbdb: ${err.message}`);
            this.loggedAt = Date.now();
          }
        },
      )
      .finally(() => this.pending.delete(icao));
  }
}
