// Wires together config, the aircraft source, the tracker, enrichment and
// the live stream to displays.
import crypto from 'node:crypto';
import path from 'node:path';
import { ConfigStore } from './config.js';
import { Tracker } from './tracker.js';
import { TrafficLog } from './traffic.js';
import { Enricher } from './enrich/index.js';
import { AtcService } from './atc/index.js';
import { HttpSource, expandUrl } from './sources/http.js';
import { MergedSource } from './sources/merged.js';
import { RfMonitor } from './rf.js';
import { UsageLog } from './util/usage.js';
import { SimulatorSource } from './sources/simulator.js';

const BROADCAST_MS = 1000;

export class App {
  constructor({ dataDir, log = console, env = process.env, fetchImpl = fetch }) {
    this.dataDir = dataDir;
    this.log = log;
    this.env = env;
    // Every request to an outside service is counted (Settings → Overview → API usage).
    this.usage = new UsageLog({ file: path.join(dataDir, 'cache', 'usage.json'), log });
    fetchImpl = this.usage.meter(fetchImpl);
    this.fetch = fetchImpl;
    this.configStore = new ConfigStore(dataDir, { env, log });
    this.getConfig = () => this.configStore.get();
    this.enricher = new Enricher({ dataDir, getConfig: this.getConfig, log, fetchImpl, env, usage: this.usage });
    this.tracker = new Tracker({ getConfig: this.getConfig, enricher: this.enricher });
    this.traffic = new TrafficLog({ dataDir, getConfig: this.getConfig, log });
    this.atc = new AtcService({
      dataDir,
      getConfig: this.getConfig,
      candidates: () => this.#radioCandidates(),
      log,
      fetchImpl,
      env,
      usage: this.usage,
    });
    this.tracker.radio = (hex) => this.atc.brief(hex);
    this.rf = new RfMonitor({ dataDir, getConfig: this.getConfig, tracker: this.tracker, log, fetchImpl });
    this.tracksFile = path.join(dataDir, 'cache', 'tracks.json');
    this.clients = new Set();
    this.source = null;
    this.startedAt = Date.now();
    // Displays reload themselves when this changes (i.e. after a restart/upgrade).
    this.bootId = crypto.randomUUID();
  }

  async start({ loadDatabases = true } = {}) {
    await this.configStore.load();
    await this.usage.load();
    await this.enricher.init({ loadDatabases });
    await this.traffic.start();
    try {
      const n = await this.tracker.loadTracks(this.tracksFile);
      if (n) this.log.info(`tracks: picked up ${n} aircraft tracks from before the restart`);
    } catch (err) {
      this.log.warn(`tracks: ${err.message}`);
    }
    this.#startSource();
    await this.atc.start();
    await this.rf.start();
    this.configStore.onChange((next, prev) => {
      if (JSON.stringify(next.source) !== JSON.stringify(prev.source)) {
        // Don't carry planes over from the old source (simulated ones in particular).
        this.tracker.clear();
        this.#startSource();
      }
      if (next.enrichment.aircraftDb && !prev.enrichment.aircraftDb) this.enricher.loadDatabases();
      const atcSource = (c) =>
        JSON.stringify([c.atc.enabled, c.atc.source, c.atc.folder, c.atc.streamUrl, c.atc.whisperUrl]);
      if (atcSource(next) !== atcSource(prev)) this.atc.restart();
      this.broadcast('config', { config: next });
    });
    this.broadcastTimer = setInterval(() => this.#broadcastAircraft(), BROADCAST_MS);
    this.keepAliveTimer = setInterval(() => this.#keepAlive(), 15_000);
  }

  async stop() {
    clearInterval(this.broadcastTimer);
    clearInterval(this.keepAliveTimer);
    this.source?.stop();
    this.atc.stop();
    await this.rf.stop();
    await this.usage.stop();
    await this.traffic.stop();
    await this.tracker.saveTracks(this.tracksFile).catch((err) => this.log.warn(`tracks: ${err.message}`));
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
    const apiUrl = () => {
      const { receiver, map, display } = getConfig();
      return expandUrl(sourceCfg.apiUrl, {
        lat: receiver.lat,
        lon: receiver.lon,
        radiusKm: Math.max(map.rangeKm, display.cycleRangeKm),
      });
    };
    // Your receiver, with the planes it doesn't hear filled in from the online feed.
    if (sourceCfg.type === 'aircraft-json' && sourceCfg.supplement) {
      return new MergedSource({
        url: () => sourceCfg.url,
        onlineUrl: apiUrl,
        pollSeconds: sourceCfg.pollSeconds,
        onlineSeconds: sourceCfg.onlineSeconds,
        onData,
        log: this.log,
        fetchImpl: this.fetch,
      });
    }
    // One feed: every plane came from it.
    const via = sourceCfg.type === 'adsb-api' ? 'online' : 'antenna';
    return new HttpSource({
      type: sourceCfg.type,
      url: sourceCfg.type === 'adsb-api' ? apiUrl : () => sourceCfg.url,
      pollSeconds:
        sourceCfg.type === 'adsb-api'
          ? Math.max(sourceCfg.pollSeconds, sourceCfg.onlineSeconds)
          : sourceCfg.pollSeconds,
      onData: (data) => onData({ ...data, aircraft: data.aircraft.map((a) => ({ ...a, via })) }),
      log: this.log,
      fetchImpl: this.fetch,
    });
  }

  #startSource() {
    this.source?.stop();
    const cfg = this.getConfig().source;
    this.source = this.createSource(cfg, (data) => this.tracker.ingest(data));
    this.enricher.routes.override = this.source.lookupRoute ? (cs) => this.source.lookupRoute(cs) : null;
    this.log.info(`source: ${cfg.type}${cfg.type === 'simulator' ? '' : ` (${this.source.status().url})`}`);
    this.source.start();
  }

  /**
   * Aircraft that might be on the radio, nearest first, with the airline's
   * radio name ("WJA347" → "WESTJET") and what the summary needs to know.
   */
  #radioCandidates() {
    return this.tracker.snapshot({ radio: false }).map((a) => ({
      hex: a.hex,
      callsign: a.callsign,
      reg: a.reg,
      telephony: this.enricher.operators[(a.callsign ?? '').slice(0, 3)]?.r ?? null,
      typeName: a.typeInfo?.name ?? null,
      airline: a.airline?.name ?? null,
      onGround: a.onGround,
      altFt: a.altFt ?? a.altGeomFt,
      vertRateFpm: a.vertRateFpm,
      gsKt: a.gsKt,
      distanceKm: a.distanceKm,
    }));
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
      // Antenna plus online fill-in: whether each is coming through.
      ...(s.type === 'merged'
        ? { antennaOk: s.antenna.ok, antennaError: s.antenna.lastError, onlineOk: s.online.ok }
        : {}),
    };
  }

  /**
   * What the outside services have been used for: daily counts (all services),
   * plus the budgets and billing-month spend the paid ones are held to.
   */
  usageReport(now = Date.now()) {
    const fa = this.enricher.flightaware.status();
    const claude = this.atc.summarizer.status();
    const { source } = this.getConfig();
    const onlineInUse = source.type === 'adsb-api' || (source.type === 'aircraft-json' && source.supplement);
    return {
      ...this.usage.summary(now),
      flightaware: {
        configured: fa.configured,
        active: fa.active,
        budgetUsd: fa.budgetUsd,
        spentThisMonthUsd: fa.spentThisMonthUsd,
        spentTodayUsd: fa.spentTodayUsd,
        leftTodayUsd: fa.leftTodayUsd,
        reported: fa.reported,
        calls: fa.calls,
        lastRefusal: fa.lastRefusal,
      },
      anthropic: {
        configured: claude.available,
        model: claude.model,
        budgetUsd: claude.budgetUsd,
        spentThisMonthUsd: claude.spentThisMonthUsd,
        spentTodayUsd: claude.spentTodayUsd,
        leftTodayUsd: claude.leftTodayUsd,
        lastRefusal: claude.lastRefusal,
      },
      adsbLol: {
        // The live feed's interval (it also serves flight paths for the mini map).
        liveFeedSeconds: onlineInUse ? Math.max(5, source.onlineSeconds) : null,
      },
    };
  }

  /** How much of the sky your antenna hears: its planes, the online-only ones, its furthest. */
  #coverage() {
    const aircraft = this.tracker.snapshot({ radio: false });
    const antenna = aircraft.filter((a) => a.via === 'antenna');
    return {
      antenna: antenna.length,
      online: aircraft.filter((a) => a.via === 'online').length,
      farthestAntennaKm: antenna.length ? Math.max(...antenna.map((a) => a.distanceKm)) : null,
    };
  }

  status() {
    return {
      startedAt: this.startedAt,
      serverTime: Date.now(),
      source: this.source?.status() ?? null,
      tracker: { tracked: this.tracker.count, lastUpdate: this.tracker.lastUpdate },
      coverage: this.#coverage(),
      enrichment: this.enricher.status(),
      traffic: this.traffic.status(),
      atc: this.atc.status(),
      rf: this.rf.status(),
      displays: this.clients.size,
    };
  }
}
