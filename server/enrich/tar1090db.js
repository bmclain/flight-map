// Downloads and loads the open aircraft databases published by the tar1090
// project (https://github.com/wiedehopf/tar1090-db):
//   - aircraft.csv.gz:           ICAO hex → registration, type, description
//   - icao_aircraft_types2.js:   type designator → name, engine class, wake category
//   - operators.js:              airline ICAO code → airline name
// Files are cached under data/cache/tar1090 and refreshed weekly.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { downloadFile, fileAgeMs } from '../util/fetch.js';

const BASE = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db';
export const TAR1090_FILES = {
  aircraft: { url: `${BASE}/csv/aircraft.csv.gz`, file: 'aircraft.csv.gz' },
  types: { url: `${BASE}/master/db/icao_aircraft_types2.js`, file: 'icao_aircraft_types2.json.gz' },
  operators: { url: `${BASE}/master/db/operators.js`, file: 'operators.json.gz' },
};
const REFRESH_MS = 7 * 24 * 3600 * 1000;

/** Make sure a database file is present (and fresh-ish). Returns its path or null. */
export async function ensureDbFile(cacheDir, key, { log = console, fetchImpl = fetch, maxAgeMs = REFRESH_MS } = {}) {
  const { url, file } = TAR1090_FILES[key];
  const target = path.join(cacheDir, file);
  const age = await fileAgeMs(target);
  if (age < maxAgeMs) return target;
  try {
    log.info(`aircraft db: downloading ${url}`);
    await downloadFile(url, target, { fetchImpl });
    return target;
  } catch (err) {
    if (age !== Infinity) {
      log.warn(`aircraft db: refresh of ${file} failed (${err.message}); using cached copy`);
      return target;
    }
    log.warn(`aircraft db: could not download ${file} (${err.message})`);
    return null;
  }
}

/** Read a JSON file that may or may not be gzip-compressed. */
export function readJsonMaybeGzip(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

/** ICAO hex → { reg, type, desc, ownOp, military } from aircraft.csv.gz. */
export class AircraftDb {
  constructor() {
    this.rows = new Map();
  }

  get size() {
    return this.rows.size;
  }

  /** Parse `icao;reg;type;flags;desc;year;ownop;` rows. */
  async load(file) {
    const rows = new Map();
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) this.#addLine(rows, line);
    this.rows = rows;
    return rows.size;
  }

  /** For tests: load from an in-memory CSV string. */
  loadText(text) {
    const rows = new Map();
    for (const line of text.split('\n')) this.#addLine(rows, line);
    this.rows = rows;
  }

  #addLine(rows, line) {
    const semi = line.indexOf(';');
    if (semi !== 6) return;
    const rest = line.slice(7);
    // skip rows with neither registration nor type
    if (rest.startsWith(';;')) return;
    rows.set(line.slice(0, 6).toLowerCase(), rest);
  }

  lookup(hex) {
    const row = this.rows.get(hex);
    if (!row) return null;
    const [reg, type, flags, desc, year, ownOp] = row.split(';');
    return {
      reg: reg || null,
      type: type || null,
      desc: desc || null,
      year: year || null,
      ownOp: ownOp || null,
      military: flags?.[0] === '1',
    };
  }
}
