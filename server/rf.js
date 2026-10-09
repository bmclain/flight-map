// How well your ADS-B receiver is doing: reads readsb's stats.json (and the
// 24-hour range outline) from the Pi every minute, keeps two days of history,
// compares what your antenna hears with the online feed when that's filling
// in, and turns it all into plain-English checks for the RF status page.
import fs from 'node:fs/promises';
import path from 'node:path';
import { bearingDeg, distanceM } from '../shared/geo.js';
import { fetchJson } from './util/fetch.js';

const SAMPLE_MS = 60_000;
const KEEP_MS = 48 * 3600_000;
const SAVE_MS = 10 * 60_000;
const COVERAGE_WINDOW_MS = 60 * 60_000; // coverage and signal-vs-distance are judged over the last hour
const OUTLINE_TTL = 5 * 60_000;

/** Distance bands (km) for "what share of the planes out there does your antenna hear". */
export const BANDS = [
  [0, 50],
  [50, 100],
  [100, 150],
  [150, 250],
  [250, 400],
];

/** The Pi's data folder from its aircraft.json URL: ".../data/aircraft.json" → ".../data/". */
export function dataBase(url) {
  const m = /^(https?:\/\/.+\/)aircraft\.json(\?.*)?$/.exec(url ?? '');
  return m ? m[1] : null;
}

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** The numbers that matter from one readsb stats window (last1min, last15min…). */
export function radioNumbers(stats, window = 'last1min') {
  const w = stats?.[window];
  if (!w) return null;
  const secs = Math.max(1, (w.end ?? 0) - (w.start ?? 0));
  const local = w.local ?? {};
  const valid = w.messages_valid ?? w.messages ?? 0;
  return {
    gainDb: r1(stats.gain_db),
    ppm: r1(stats.estimated_ppm),
    signalDb: r1(local.signal),
    noiseDb: r1(local.noise),
    peakDb: r1(local.peak_signal),
    snrDb: local.signal != null && local.noise != null ? r1(local.signal - local.noise) : null,
    // Messages above -3 dBFS: a few are normal close in; many means overload.
    strongPct: valid ? r1((100 * (local.strong_signals ?? 0)) / valid) : null,
    msgsPerSec: r1(valid / secs),
    positionsPerMin: r1(((w.position_count_total ?? 0) * 60) / secs),
    // Share of decode attempts that failed (noise that looked like a message).
    badPct: local.modes ? r1((100 * (local.bad ?? 0)) / local.modes) : null,
    droppedSamples: (local.samples_dropped ?? 0) + (local.samples_lost ?? 0),
    maxRangeKm: w.max_distance != null ? r1(w.max_distance / 1000) : null,
    aircraftWithPos: stats.aircraft_with_pos ?? null,
  };
}

/** Planes in the air by distance band: how many there were, how many your antenna heard. */
export function coverageOf(aircraft) {
  const bands = BANDS.map(() => ({ heard: 0, total: 0 }));
  let farthestHeard = null;
  let farthestThere = null;
  for (const a of aircraft) {
    if (a.onGround || a.distanceKm == null || !a.via) continue;
    const i = BANDS.findIndex(([lo, hi]) => a.distanceKm >= lo && a.distanceKm < hi);
    if (i < 0) continue;
    bands[i].total++;
    if (a.via === 'antenna') {
      bands[i].heard++;
      farthestHeard = Math.max(farthestHeard ?? 0, a.distanceKm);
    }
    // High enough to be heard that far: a fair test of range.
    if ((a.altFt ?? 0) >= 20_000) farthestThere = Math.max(farthestThere ?? 0, a.distanceKm);
  }
  return { bands, farthestHeard: r1(farthestHeard), farthestThere: r1(farthestThere) };
}

const pct = (heard, total) => (total ? Math.round((100 * heard) / total) : null);

/**
 * Plain-English checks from the latest numbers (15-minute window) and the last
 * hour's coverage. Each: { id, status: 'ok' | 'warn' | 'bad' | 'info', title, detail, advice? }.
 */
export function checks({ now: n, coverage, merged, gainMax = 49.6 }) {
  const out = [];
  if (!n) return out;

  // Coverage against the online feed: the clearest sign of how well the antenna works.
  if (merged && coverage) {
    const near = coverage.bands
      .slice(0, 2)
      .reduce((s, b) => ({ heard: s.heard + b.heard, total: s.total + b.total }), { heard: 0, total: 0 });
    const mid = coverage.bands
      .slice(2, 4)
      .reduce((s, b) => ({ heard: s.heard + b.heard, total: s.total + b.total }), { heard: 0, total: 0 });
    const nearPct = pct(near.heard, near.total);
    const midPct = pct(mid.heard, mid.total);
    if (near.total >= 5) {
      out.push({
        id: 'coverage-near',
        status: nearPct >= 85 ? 'ok' : nearPct >= 60 ? 'warn' : 'bad',
        title: `Within 100 km: hearing ${nearPct}% of the planes adsb.lol sees`,
        detail: `${near.heard} of ${near.total} sightings in the last hour.`,
        advice:
          nearPct >= 85
            ? null
            : 'Planes this close should almost all be heard. Check the antenna, the coax and its connectors (water, corrosion, a loose centre pin), and that the antenna is outside with a clear view of the sky.',
      });
    }
    if (mid.total >= 5) {
      out.push({
        id: 'coverage-far',
        status: midPct >= 60 ? 'ok' : midPct >= 25 ? 'warn' : 'bad',
        title: `100–250 km: hearing ${midPct}% of the planes adsb.lol sees`,
        detail: `${mid.heard} of ${mid.total} sightings in the last hour.`,
        advice:
          midPct >= 60
            ? null
            : 'Distant planes are the first to go when signal is lost along the way: a wet or damaged coax, a poor connector, a low antenna or one hemmed in by buildings and trees.',
      });
    }
  } else if (!merged) {
    out.push({
      id: 'coverage',
      status: 'info',
      title: 'No online feed to compare with',
      detail:
        'Turn on "Also fill in the planes my antenna doesn\'t hear" (Settings → Aircraft data) to see what share of the planes around you your antenna catches.',
    });
  }

  // Range: airliners at cruise are normally heard 250–400 km out, so the
  // furthest one the online feed had nearby (within the map range) should be heard.
  if (coverage?.farthestThere != null && coverage.farthestThere >= 120) {
    const heard = coverage.farthestHeard ?? 0;
    const share = heard / coverage.farthestThere;
    out.push({
      id: 'range',
      status: share >= 0.8 ? 'ok' : share >= 0.5 ? 'warn' : 'bad',
      title: `Furthest plane heard in the last hour: ${Math.round(heard)} km`,
      detail: `The online feed had planes above 20,000 ft out to ${Math.round(coverage.farthestThere)} km (as far as the map range reaches).`,
      advice: share >= 0.8 ? null : 'A clear, high antenna normally hears airliners at cruise 250–400 km away.',
    });
  }

  if (n.droppedSamples > 0) {
    out.push({
      id: 'dropped',
      status: 'bad',
      title: 'Samples dropped by the receiver',
      detail: `${n.droppedSamples} in the last 15 minutes.`,
      advice:
        "The Pi isn't keeping up with the radio: check its power supply and USB connection, and that nothing else is using the CPU heavily.",
    });
  }

  // Overload: too much gain (or a strong transmitter nearby) clips the strongest signals.
  if (n.strongPct != null) {
    out.push({
      id: 'overload',
      status: n.strongPct > 10 ? 'bad' : n.strongPct > 5 ? 'warn' : 'ok',
      title:
        n.strongPct > 5
          ? `Overloaded: ${n.strongPct}% of messages near full scale`
          : `No overload (${n.strongPct}% of messages near full scale)`,
      detail: `Peak signal ${n.peakDb ?? '–'} dBFS.`,
      advice:
        n.strongPct > 5
          ? 'Lower the gain; with a stick that has its own amplifier (like the AirNav), lower gains often work better.'
          : null,
    });
  }

  // Weak signals even with the gain turned all the way up: the antenna side is losing them.
  if (n.gainDb != null && n.gainDb >= gainMax - 0.5 && (n.peakDb ?? -99) < -10) {
    out.push({
      id: 'gain-max',
      status: 'bad',
      title: 'Gain at maximum and signals still weak',
      detail: `Gain ${n.gainDb} dB, strongest signal only ${n.peakDb} dBFS.`,
      advice: 'Autogain has nothing left to give: the problem is before the stick — antenna, coax or connectors.',
    });
  } else if (n.gainDb != null) {
    out.push({
      id: 'gain',
      status: 'info',
      title: `Gain ${n.gainDb} dB`,
      detail: 'Set by autogain, which aims for a quiet noise floor without clipping strong signals.',
    });
  }

  if (n.snrDb != null) {
    out.push({
      id: 'snr',
      status: n.snrDb >= 10 ? 'ok' : n.snrDb >= 6 ? 'warn' : 'bad',
      title: `Signal ${n.snrDb} dB above the noise`,
      detail: `Average signal ${n.signalDb} dBFS, noise floor ${n.noiseDb} dBFS.`,
      advice:
        n.snrDb >= 10
          ? null
          : 'Messages are only just above the noise: weak signal from the antenna side, or a noisy environment.',
    });
  }

  if (n.ppm != null) {
    const off = Math.abs(n.ppm);
    out.push({
      id: 'ppm',
      status: off <= 10 ? 'ok' : 'warn',
      title: `Tuning ${off <= 10 ? 'accurate' : 'off'}: ${n.ppm} ppm`,
      detail:
        off <= 10
          ? 'The stick is on frequency.'
          : "Sticks with a precision crystal (TCXO), like the AirNav FlightStick, are normally within ±2 ppm. ADS-B copes with this much error, so it isn't why planes are missed, but it can be a sign of a damaged or knock-off stick.",
    });
  }

  return out;
}

export function verdict(list) {
  const rank = { bad: 3, warn: 2, ok: 1 };
  const worst = list.reduce((w, c) => Math.max(w, rank[c.status] ?? 0), 0);
  return worst === 3 ? 'poor' : worst === 2 ? 'fair' : worst === 1 ? 'good' : 'unknown';
}

export class RfMonitor {
  constructor({ dataDir, getConfig, tracker, log = console, fetchImpl = fetch }) {
    this.file = path.join(dataDir, 'cache', 'rf-history.json');
    this.getConfig = getConfig;
    this.tracker = tracker;
    this.log = log;
    this.fetch = fetchImpl;
    this.history = []; // { t, ...radioNumbers(last1min), bands, farthestHeard }
    this.signal = []; // [t, distanceKm, rssi] for planes the antenna heard, last hour
    this.latest = null; // { at, stats }
    this.outline = null; // { at, points: [[bearing, km]] }
    this.lastError = null;
  }

  get base() {
    const src = this.getConfig().source;
    return src.type === 'aircraft-json' ? dataBase(src.url) : null;
  }

  async start() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(saved.history)) this.history = saved.history.filter((s) => Date.now() - s.t < KEEP_MS);
    } catch {
      // No history yet.
    }
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref?.();
    this.saveTimer = setInterval(() => this.save(), SAVE_MS);
    this.saveTimer.unref?.();
    this.sample();
  }

  async stop() {
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    await this.save();
  }

  async save() {
    if (!this.history.length) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, JSON.stringify({ history: this.history }));
      await fs.rename(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log.warn(`rf: ${err.message}`);
    }
  }

  /** One minute's reading: the receiver's numbers and what the antenna heard. */
  async sample(now = Date.now()) {
    const base = this.base;
    if (!base) return null;
    let stats;
    try {
      stats = await fetchJson(`${base}stats.json`, { fetchImpl: this.fetch, timeoutMs: 8000 });
      this.lastError = null;
    } catch (err) {
      this.lastError = { message: `Can't read ${base}stats.json: ${err.message}`, at: now };
      return null;
    }
    this.latest = { at: now, stats };
    const aircraft = this.tracker.snapshot({ radio: false, now });
    const cov = coverageOf(aircraft);
    const entry = {
      t: now,
      ...radioNumbers(stats, 'last1min'),
      bands: cov.bands.map((b) => [b.heard, b.total]),
      farthestHeard: cov.farthestHeard,
      farthestThere: cov.farthestThere,
    };
    this.history.push(entry);
    this.history = this.history.filter((s) => now - s.t < KEEP_MS);
    for (const a of aircraft) {
      if (a.via === 'antenna' && a.rssi != null && a.distanceKm != null) this.signal.push([now, a.distanceKm, a.rssi]);
    }
    this.signal = this.signal.filter(([t]) => now - t < COVERAGE_WINDOW_MS);
    return entry;
  }

  async #outline(now) {
    if (this.outline && now - this.outline.at < OUTLINE_TTL) return this.outline.points;
    const { receiver } = this.getConfig();
    try {
      const json = await fetchJson(`${this.base}outline.json`, { fetchImpl: this.fetch, timeoutMs: 8000 });
      const pts = json?.actualRange?.last24h?.points ?? [];
      const points = pts.map(([lat, lon]) => [
        Math.round(bearingDeg(receiver.lat, receiver.lon, lat, lon)),
        r1(distanceM(receiver.lat, receiver.lon, lat, lon) / 1000),
      ]);
      this.outline = { at: now, points };
    } catch {
      this.outline = { at: now, points: [] };
    }
    return this.outline.points;
  }

  /** Everything the RF status page shows. */
  async report(now = Date.now()) {
    const base = this.base;
    const src = this.getConfig().source;
    if (!base) {
      return {
        available: false,
        reason:
          src.type === 'aircraft-json'
            ? `Can't tell where the receiver's stats are from ${src.url} (expected …/data/aircraft.json).`
            : 'RF status needs your own receiver as the aircraft source (Settings → Aircraft data → My receiver).',
      };
    }
    if (!this.latest || now - this.latest.at > 2 * SAMPLE_MS) await this.sample(now);
    if (!this.latest)
      return { available: false, reason: this.lastError?.message ?? 'No reading from the receiver yet.' };
    const merged = !!src.supplement;
    const recent = this.history.filter((s) => now - s.t < COVERAGE_WINDOW_MS);
    // Coverage over the last hour: each minute's sightings added up.
    const coverage = {
      bands: BANDS.map((range, i) => {
        const heard = recent.reduce((sum, s) => sum + (s.bands?.[i]?.[0] ?? 0), 0);
        const total = recent.reduce((sum, s) => sum + (s.bands?.[i]?.[1] ?? 0), 0);
        return { range, heard, total, pct: pct(heard, total) };
      }),
      farthestHeard: recent.reduce((m, s) => Math.max(m, s.farthestHeard ?? 0), 0) || null,
      farthestThere: recent.reduce((m, s) => Math.max(m, s.farthestThere ?? 0), 0) || null,
      minutes: recent.length,
    };
    const numbers = radioNumbers(this.latest.stats, 'last15min');
    const list = checks({ now: numbers, coverage, merged });
    const { receiver } = this.getConfig();
    return {
      available: true,
      at: this.latest.at,
      verdict: verdict(list),
      checks: list,
      numbers,
      coverage,
      merged,
      graphsUrl: base.replace(/data\/$/, 'graphs1090/'),
      outline: await this.#outline(now),
      // Right now: where each plane is, and whether the antenna hears it.
      planes: this.tracker
        .snapshot({ radio: false, now })
        .filter((a) => !a.onGround && a.via)
        .map((a) => ({
          bearing: Math.round(bearingDeg(receiver.lat, receiver.lon, a.lat, a.lon)),
          km: a.distanceKm,
          heard: a.via === 'antenna',
          label: a.flight || a.callsign || a.reg || a.hex,
        })),
      signal: this.signal.map(([, km, rssi]) => [r1(km), r1(rssi)]),
      history: this.history.map((s) => ({
        t: s.t,
        msgsPerSec: s.msgsPerSec,
        noiseDb: s.noiseDb,
        signalDb: s.signalDb,
        gainDb: s.gainDb,
        maxRangeKm: s.maxRangeKm,
        // Share of planes within 250 km the antenna heard, that minute.
        coveragePct: (() => {
          const b = (s.bands ?? []).slice(0, 4);
          const total = b.reduce((x, [, t]) => x + t, 0);
          return merged && total >= 3
            ? pct(
                b.reduce((x, [h]) => x + h, 0),
                total,
              )
            : null;
        })(),
      })),
    };
  }

  status() {
    return { base: this.base, samples: this.history.length, lastError: this.lastError };
  }
}
