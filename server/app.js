// Wires together config, the aircraft source, the tracker, enrichment and
// the live stream to displays.
import crypto from 'node:crypto';
import { ConfigStore } from './config.js';
import { Tracker } from './tracker.js';
import { TrafficLog } from './traffic.js';
import { Enricher } from './enrich/index.js';
import { HttpSource, expandUrl } from './sources/http.js';
import { SimulatorSource } from './sources/simulator.js';

const BROADCAST_MS = 1000;

export class App {
  constructor({ dataDir, log = console, env = process.env, fetchImpl = fetch }) {
    this.dataDir = dataDir;
    this.log = log;
    this.env = env;
    this.fetch = fetchImpl;
    this.configStore = new ConfigStore(dataDir, { env, log });
    this.getConfig = () => this.configStore.get();
    this.enricher = new Enricher({ dataDir, getConfig: this.getConfig, log, fetchImpl });
    this.tracker = new Tracker({ getConfig: this.getConfig, enricher: this.enricher });
    this.traffic = new TrafficLog({ dataDir, getConfig: this.getConfig, log });
    this.clients = new Set();
    this.source = null;
    this.startedAt = Date.now();
    // Displays reload themselves when this changes (i.e. after a restart/upgrade).
    this.bootId = crypto.randomUUID();
  }

  async start({ loadDatabases = true } = {}) {
    await this.configStore.load();
    await this.enricher.init({ loadDatabases });
    await this.traffic.start();
    this.#startSource();
    this.configStore.onChange((next, prev) => {
      if (JSON.stringify(next.source) !== JSON.stringify(prev.source)) this.#startSource();
      if (next.enrichment.aircraftDb && !prev.enrichment.aircraftDb) this.enricher.loadDatabases();
      this.broadcast('config', { config: next });
    });
    this.broadcastTimer = setInterval(() => this.#broadcastAircraft(), BROADCAST_MS);
    this.keepAliveTimer = setInterval(() => this.#keepAlive(), 15_000);
  }

  async stop() {
    clearInterval(this.broadcastTimer);
    clearInterval(this.keepAliveTimer);
    this.source?.stop();
    await this.traffic.stop();
    for (const res of this.clients) res.end();
    this.clients.clear();
    await this.enricher.shutdown();
  }

  /** Build a source for the given source config (also used by "Test connection"). */
  createSource(sourceCfg, onData = () => {}) {
    const getConfig = this.getConfig;
    if (sourceCfg.type === 'simulator') {
      return new SimulatorSource({ getConfig, pollSeconds: sourceCfg.pollSeconds, onData, log: this.log });
    }
    const url =
      sourceCfg.type === 'adsb-api'
        ? () => {
            const { receiver, map, display } = getConfig();
            return expandUrl(sourceCfg.apiUrl, {
              lat: receiver.lat,
              lon: receiver.lon,
              radiusKm: Math.max(map.rangeKm, display.cycleRangeKm),
            });
          }
        : () => sourceCfg.url;
    return new HttpSource({
      type: sourceCfg.type,
      url,
      pollSeconds: sourceCfg.pollSeconds,
      onData,
      log: this.log,
      fetchImpl: this.fetch,
    });
  }

  #startSource() {
    this.source?.stop();
    // Don't carry planes over from the old source (simulated ones in particular).
    this.tracker.clear();
    const cfg = this.getConfig().source;
    this.source = this.createSource(cfg, (data) => this.tracker.ingest(data));
    this.enricher.routes.override = this.source.lookupRoute ? (cs) => this.source.lookupRoute(cs) : null;
    this.log.info(`source: ${cfg.type}${cfg.type === 'simulator' ? '' : ` (${this.source.status().url})`}`);
    this.source.start();
  }

  // ---- live stream -----------------------------------------------------------

  addClient(res) {
    this.clients.add(res);
    this.#send(res, 'hello', {
      bootId: this.bootId,
      config: this.getConfig(),
      serverTime: Date.now(),
      aircraft: this.tracker.snapshot({ trails: true }),
      status: this.#briefStatus(),
    });
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  #send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #broadcastAircraft() {
    // Runs even with no display connected: keeps enrichment warm and the traffic log going.
    const aircraft = this.tracker.snapshot();
    // Simulated traffic stays out of the daily traffic log.
    if (this.getConfig().source.type !== 'simulator') {
      try {
        this.traffic.observe(aircraft);
      } catch (err) {
        this.log.warn(`traffic: ${err.message}`);
      }
    }
    if (!this.clients.size) return;
    this.broadcast('aircraft', {
      serverTime: Date.now(),
      aircraft,
      status: this.#briefStatus(),
    });
  }

  #keepAlive() {
    for (const res of this.clients) res.write(': keep-alive\n\n');
  }

  #briefStatus() {
    const s = this.source?.status() ?? {};
    return {
      sourceType: s.type,
      sourceOk: !!s.lastOkAt && Date.now() - s.lastOkAt < 15_000,
      sourceError: s.lastError ?? null,
      lastOkAt: s.lastOkAt ?? null,
    };
  }

  status() {
    return {
      startedAt: this.startedAt,
      serverTime: Date.now(),
      source: this.source?.status() ?? null,
      tracker: { tracked: this.tracker.count, lastUpdate: this.tracker.lastUpdate },
      enrichment: this.enricher.status(),
      traffic: this.traffic.status(),
      displays: this.clients.size,
    };
  }
}
