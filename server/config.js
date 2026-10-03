// Configuration: defaults, validation and persistence (data/config.json).
import fs from 'node:fs/promises';
import path from 'node:path';
import { SPECIAL_KINDS } from './special.js';

export const DEFAULT_CONFIG = {
  receiver: {
    name: 'Backyard',
    lat: 47.6062,
    lon: -122.3321,
    altitudeM: 30,
  },
  source: {
    // 'aircraft-json' — readsb / dump1090-fa / tar1090 on the Pi
    // 'adsb-api'      — an online readsb-style API (handy before the Pi is set up)
    // 'simulator'     — fake traffic for testing the display
    type: 'simulator',
    url: 'http://raspberrypi.local/tar1090/data/aircraft.json',
    apiUrl: 'https://api.adsb.lol/v2/point/{lat}/{lon}/{radiusNm}',
    pollSeconds: 1,
  },
  display: {
    cycleSeconds: 10,
    cycleRangeKm: 24.14, // 15 mi
    minAltitudeFt: 0,
    maxAltitudeFt: 50000,
    hideGround: true,
    spotlight: { enabled: false, rangeKm: 3.22, maxAltitudeFt: 8000 }, // 2 mi
    // Compass direction a person faces while looking at the screen.
    facingDeg: 0,
    units: 'imperial',
    theme: 'auto',
    layout: 'card',
    clock24h: false,
  },
  map: {
    rangeKm: 64.37, // 40 mi
    everyCards: 5,
    seconds: 15,
    idle: 'map',
    orientation: 'north-up',
    // 'stadia' / 'maptiler' / 'carto' need a free API key in tileApiKey;
    // without one the map shows no background.
    tiles: 'stadia',
    tileApiKey: '',
    customTileUrl: '',
    trailMinutes: 5,
    labels: true,
    // Small map of the flight's route on each aircraft card.
    miniMap: true,
  },
  enrichment: {
    aircraftDb: true,
    routes: true,
    // adsb.im first (what tar1090 uses), adsbdb as a fallback. 'adsblol' is also
    // accepted but its route API currently answers with an empty body.
    routeProviders: ['adsbim', 'adsbdb'],
    hideImplausibleRoutes: true,
    // 'airframe' = photo of the exact plane (planespotters.net), falling back to the type photo
    // 'type'     = one consistent photo per aircraft type (Wikipedia / your own library)
    // 'off'      = silhouettes only
    photoMode: 'airframe',
  },
  special: {
    // Aircraft to point out: `match` is a registration, callsign or hex code
    // (end with * to match the start, e.g. "STAR*"); `alert` shows a notice on
    // the display whenever it's in range.
    aircraft: [],
  },
  traffic: {
    // Your local airport. Flights seen low near it count as its departures and
    // arrivals on the traffic page, by destination and origin. Empty code = off.
    airport: {
      code: '',
      lat: 0,
      lon: 0,
      elevationFt: 0,
      // "Low near the airport": below this height above it, within this distance.
      maxHeightFt: 5000,
      radiusKm: 30,
    },
  },
};

// ---- validators ------------------------------------------------------------

const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

const num =
  (min, max, { int = false } = {}) =>
  (v) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return bad('must be a number');
    if (n < min || n > max) return bad(`must be between ${min} and ${max}`);
    return ok(int ? Math.round(n) : n);
  };
const bool = () => (v) => (typeof v === 'boolean' ? ok(v) : bad('must be true or false'));
const str = (max) => (v) =>
  typeof v === 'string' && v.length <= max ? ok(v.trim()) : bad(`must be text up to ${max} characters`);
const oneOf = (options) => (v) => (options.includes(v) ? ok(v) : bad(`must be one of ${options.join(', ')}`));
const airportCode = () => (v) =>
  typeof v === 'string' && /^([A-Za-z0-9]{3,4})?$/.test(v.trim())
    ? ok(v.trim().toUpperCase())
    : bad('must be a 3- or 4-letter airport code');
const specialList = () => (v) => {
  if (!Array.isArray(v) || v.length > 100) return bad('must be a list of up to 100 aircraft');
  const out = [];
  for (const e of v) {
    const match = typeof e?.match === 'string' ? e.match.trim().toUpperCase() : '';
    if (!match) continue; // a row not filled in yet
    if (!/^[A-Z0-9-]{1,10}\*?$/.test(match))
      return bad(`"${e?.match ?? ''}" isn't a registration, callsign or hex code`);
    if (!SPECIAL_KINDS.includes(e.kind)) return bad(`kind must be one of ${SPECIAL_KINDS.join(', ')}`);
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 60) : '';
    out.push({ match, kind: e.kind, name, alert: !!e.alert });
  }
  return ok(out);
};
const subsetOf = (options) => (v) =>
  Array.isArray(v) && v.every((x) => options.includes(x))
    ? ok([...new Set(v)])
    : bad(`must be a list drawn from ${options.join(', ')}`);

const SCHEMA = {
  receiver: {
    name: str(60),
    lat: num(-90, 90),
    lon: num(-180, 180),
    altitudeM: num(-500, 9000),
  },
  source: {
    type: oneOf(['aircraft-json', 'adsb-api', 'simulator']),
    url: str(500),
    apiUrl: str(500),
    pollSeconds: num(0.5, 60),
  },
  display: {
    cycleSeconds: num(3, 600),
    cycleRangeKm: num(0.5, 500),
    minAltitudeFt: num(-2000, 100000),
    maxAltitudeFt: num(0, 100000),
    hideGround: bool(),
    spotlight: {
      enabled: bool(),
      rangeKm: num(0.1, 50),
      maxAltitudeFt: num(0, 100000),
    },
    facingDeg: num(0, 360),
    units: oneOf(['imperial', 'aviation', 'metric']),
    theme: oneOf(['auto', 'dark', 'light']),
    layout: oneOf(['card', 'split']),
    clock24h: bool(),
  },
  map: {
    rangeKm: num(1, 600),
    everyCards: num(0, 100, { int: true }),
    seconds: num(3, 600),
    idle: oneOf(['map', 'clock']),
    orientation: oneOf(['north-up', 'facing-up']),
    tiles: oneOf(['stadia', 'maptiler', 'carto', 'osm', 'none', 'custom']),
    tileApiKey: str(200),
    customTileUrl: str(500),
    trailMinutes: num(0, 60),
    labels: bool(),
    miniMap: bool(),
  },
  enrichment: {
    aircraftDb: bool(),
    routes: bool(),
    routeProviders: subsetOf(['adsbim', 'adsblol', 'adsbdb']),
    hideImplausibleRoutes: bool(),
    photoMode: oneOf(['airframe', 'type', 'off']),
  },
  special: {
    aircraft: specialList(),
  },
  traffic: {
    airport: {
      code: airportCode(),
      lat: num(-90, 90),
      lon: num(-180, 180),
      elevationFt: num(-1500, 15000),
      maxHeightFt: num(500, 10000),
      radiusKm: num(2, 40),
    },
  },
};

/**
 * Merge `patch` over `base`, keeping only valid, known fields.
 * Returns the merged config and a list of field errors.
 */
export function mergeConfig(base, patch, schema = SCHEMA, prefix = '') {
  const out = {};
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    const field = prefix ? `${prefix}.${key}` : key;
    const baseVal = base?.[key];
    const patchVal = patch?.[key];
    if (typeof rule === 'function') {
      if (patchVal === undefined) {
        out[key] = baseVal;
        continue;
      }
      const res = rule(patchVal);
      if (res.ok) out[key] = res.value;
      else {
        out[key] = baseVal;
        errors.push({ field, error: res.error });
      }
    } else {
      const sub = mergeConfig(baseVal, patchVal, rule, field);
      out[key] = sub.config;
      errors.push(...sub.errors);
    }
  }
  if (!prefix && out.display.minAltitudeFt > out.display.maxAltitudeFt) {
    errors.push({ field: 'display.minAltitudeFt', error: 'must be below the maximum altitude' });
  }
  if (!prefix && out.map.tiles === 'custom' && !/^https?:\/\/.+\{z\}.+/.test(out.map.customTileUrl)) {
    errors.push({ field: 'map.customTileUrl', error: 'must be a tile URL containing {z}, {x} and {y}' });
  }
  return { config: out, errors };
}

/** Initial values that can be supplied by environment variables on first run. */
function envSeed(env) {
  const seed = { receiver: {}, source: {} };
  if (env.RECEIVER_LAT) seed.receiver.lat = Number(env.RECEIVER_LAT);
  if (env.RECEIVER_LON) seed.receiver.lon = Number(env.RECEIVER_LON);
  if (env.RECEIVER_ALT_M) seed.receiver.altitudeM = Number(env.RECEIVER_ALT_M);
  if (env.SOURCE_URL) {
    seed.source.type = 'aircraft-json';
    seed.source.url = env.SOURCE_URL;
  }
  return seed;
}

export class ConfigStore {
  constructor(dataDir, { env = process.env, log = console } = {}) {
    this.file = path.join(dataDir, 'config.json');
    this.env = env;
    this.log = log;
    this.config = structuredClone(DEFAULT_CONFIG);
    this.listeners = new Set();
  }

  async load() {
    let stored = null;
    try {
      stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`config: could not read ${this.file}: ${err.message}`);
    }
    const { config, errors } = mergeConfig(DEFAULT_CONFIG, stored ?? envSeed(this.env));
    for (const e of errors) this.log.warn(`config: ignoring ${e.field} (${e.error})`);
    this.config = config;
    if (!stored) await this.#write();
    return this.config;
  }

  get() {
    return this.config;
  }

  /** Validate and apply a (partial) update. Throws with `.errors` on invalid input. */
  async update(patch) {
    const { config, errors } = mergeConfig(this.config, patch);
    if (errors.length) {
      const err = new Error('Invalid configuration');
      err.errors = errors;
      throw err;
    }
    const previous = this.config;
    this.config = config;
    await this.#write();
    for (const fn of this.listeners) fn(config, previous);
    return config;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async #write() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.config, null, 2)}\n`);
    await fs.rename(tmp, this.file);
  }
}
