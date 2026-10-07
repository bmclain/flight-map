// Where airports are, from the OurAirports open data (public domain,
// https://ourairports.com/data/). FlightAware gives a flight's airports by code
// only; the card needs their positions for the mini map and plausibility
// checks. Downloaded to data/cache/airports.csv and refreshed monthly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fileAgeMs } from '../util/fetch.js';

const URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const REFRESH_MS = 30 * 24 * 3600_000;
const SKIP_TYPES = new Set(['heliport', 'balloonport', 'closed', 'seaplane_base']);

/** One CSV line → fields (handles quoted fields with commas and doubled quotes). */
export function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

export class AirportDb {
  constructor() {
    this.byCode = new Map(); // ICAO / GPS / local code → airport
  }

  get size() {
    return this.byCode.size;
  }

  /** Load from CSV text. */
  loadCsv(text) {
    const lines = text.split(/\r?\n/);
    const head = parseCsvLine(lines[0]);
    const col = Object.fromEntries(head.map((h, i) => [h, i]));
    const byCode = new Map();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = parseCsvLine(lines[i]);
      if (SKIP_TYPES.has(f[col.type])) continue;
      const ap = {
        icao: f[col.icao_code] || f[col.gps_code] || f[col.ident] || null,
        iata: f[col.iata_code] || null,
        name: f[col.name] || null,
        city: f[col.municipality] || null,
        country: f[col.iso_country] || null,
        lat: Number(f[col.latitude_deg]),
        lon: Number(f[col.longitude_deg]),
      };
      if (!Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) continue;
      for (const code of [f[col.ident], f[col.icao_code], f[col.gps_code], f[col.local_code]]) {
        if (code && !byCode.has(code)) byCode.set(code, ap);
      }
    }
    this.byCode = byCode;
    return byCode.size;
  }

  /** Download if needed and load. Returns the number of codes, or 0. */
  async load(cacheDir, { log = console, fetchImpl = fetch } = {}) {
    const file = path.join(cacheDir, 'airports.csv');
    const age = await fileAgeMs(file);
    if (age > REFRESH_MS) {
      try {
        log.info(`airports: downloading ${URL}`);
        await downloadFile(URL, file, { fetchImpl });
      } catch (err) {
        if (age === Infinity) {
          log.warn(`airports: could not download (${err.message})`);
          return 0;
        }
        log.warn(`airports: refresh failed (${err.message}); using cached copy`);
      }
    }
    return this.loadCsv(await fs.readFile(file, 'utf8'));
  }

  /** Airport by any of its codes ("CYXE", "KSEA", "0S9"), or null. */
  get(...codes) {
    for (const c of codes) if (c && this.byCode.has(c)) return this.byCode.get(c);
    return null;
  }
}
