// Adds human-friendly details to raw aircraft: type name, airline, route, photo.
import path from 'node:path';
import { AircraftDb, ensureDbFile, readJsonMaybeGzip } from './tar1090db.js';
import { TypeDb } from './types.js';
import { RouteResolver } from './routes.js';
import { PhotoResolver } from './photos.js';

const DB_REFRESH_MS = 24 * 3600_000;

/** "Jetblue Airways Corporation" → "Jetblue Airways", "Horizon Air Industries" → "Horizon Air". */
export function cleanAirlineName(name) {
  if (!name) return name;
  const cleaned = name
    .replace(
      /,?\s+(corporation|corp\.?|incorporated|inc\.?|limited|ltd\.?|llc|plc|co\.?|company|industries|s\.a\.?|ag|gmbh)$/i,
      '',
    )
    .trim();
  return cleaned || name;
}
const CACHE_SAVE_MS = 5 * 60_000;

export class Enricher {
  constructor({ dataDir, getConfig, log = console, fetchImpl = fetch }) {
    this.dataDir = dataDir;
    this.dbDir = path.join(dataDir, 'cache', 'tar1090');
    this.getConfig = getConfig;
    this.log = log;
    this.fetch = fetchImpl;
    this.aircraftDb = new AircraftDb();
    this.types = new TypeDb();
    this.operators = {};
    this.routes = new RouteResolver({
      cacheFile: path.join(dataDir, 'cache', 'routes.json'),
      getConfig,
      log,
      fetchImpl,
    });
    this.photos = new PhotoResolver({ dataDir, getConfig, log, fetchImpl });
    this.dbState = { types: 0, operators: 0, aircraft: 0, loading: false, lastError: null };
    this.timers = [];
  }

  async init({ loadDatabases = true } = {}) {
    await this.routes.load();
    await this.photos.init();
    if (loadDatabases) {
      this.loadDatabases();
      this.timers.push(setInterval(() => this.loadDatabases(), DB_REFRESH_MS));
    }
    this.timers.push(setInterval(() => this.saveCaches(), CACHE_SAVE_MS));
    for (const t of this.timers) t.unref?.();
  }

  /** Download (if needed) and load the tar1090 databases. Runs in the background. */
  async loadDatabases() {
    if (this.dbState.loading) return;
    this.dbState.loading = true;
    const opts = { log: this.log, fetchImpl: this.fetch };
    try {
      const typesFile = await ensureDbFile(this.dbDir, 'types', opts);
      if (typesFile) {
        this.types.setIcaoTable(readJsonMaybeGzip(typesFile));
        this.dbState.types = this.types.size;
      }
      const opsFile = await ensureDbFile(this.dbDir, 'operators', opts);
      if (opsFile) {
        this.operators = readJsonMaybeGzip(opsFile);
        this.dbState.operators = Object.keys(this.operators).length;
      }
      if (this.getConfig().enrichment.aircraftDb) {
        const acFile = await ensureDbFile(this.dbDir, 'aircraft', opts);
        if (acFile) {
          const started = Date.now();
          this.dbState.aircraft = await this.aircraftDb.load(acFile);
          this.log.info(`aircraft db: ${this.dbState.aircraft} aircraft loaded in ${Date.now() - started} ms`);
        }
      }
      this.dbState.lastError = null;
    } catch (err) {
      this.dbState.lastError = err.message;
      this.log.warn(`aircraft db: ${err.message}`);
    } finally {
      this.dbState.loading = false;
    }
  }

  /** Airline for an ICAO-style callsign ("UAL1234" → United Airlines). */
  airline(callsign) {
    const m = /^([A-Z]{3})\d/.exec(callsign ?? '');
    if (!m) return null;
    const op = this.operators[m[1]];
    return op ? { icao: m[1], name: cleanAirlineName(op.n), country: op.c ?? null, iata: null } : null;
  }

  /**
   * Static + cached details for one aircraft. Never blocks on the network.
   * With `lookup: false` (aircraft only on the map, too far away to get a card)
   * no route or photo lookups are made, to go easy on the free community APIs.
   */
  enrich(ac, { lookup = true } = {}) {
    const db = this.getConfig().enrichment.aircraftDb ? this.aircraftDb.lookup(ac.hex) : null;
    const reg = ac.reg ?? db?.reg ?? null;
    const typeCode = ac.type ?? db?.type ?? null;
    const typeInfo = this.types.describe(typeCode, ac.desc ?? db?.desc ?? null, ac.category);
    const { status: routeStatus, route } = this.routes.get(ac.callsign, ac, { lookup });
    const airline = route?.airline?.name ? route.airline : this.airline(ac.callsign);
    const photo = lookup ? this.photos.get({ hex: ac.hex, reg, typeInfo }) : null;
    return {
      reg,
      typeInfo,
      airline,
      military: ac.military || !!db?.military,
      route,
      routeStatus,
      photo,
    };
  }

  async saveCaches() {
    try {
      await Promise.all([this.routes.save(), this.photos.save()]);
    } catch (err) {
      this.log.warn(`cache save failed: ${err.message}`);
    }
  }

  async shutdown() {
    for (const t of this.timers) clearInterval(t);
    this.photos.stop();
    await this.saveCaches();
  }

  status() {
    return {
      databases: { ...this.dbState },
      routes: this.routes.status(),
      photos: this.photos.status(),
    };
  }
}
