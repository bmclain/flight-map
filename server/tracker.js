// Keeps the latest state of every aircraft heard and the track each has flown
// since we first heard it, and builds the enriched list that is pushed to the
// displays.
import fs from 'node:fs/promises';
import path from 'node:path';
import { bearingDeg, distanceM, elevationDeg, M_PER_FT } from '../shared/geo.js';
import { addTrackPoint } from '../shared/track.js';

const MAX_POSITION_AGE_S = 60;
const FORGET_AFTER_MS = 90_000;
// Tracks saved at shutdown are picked up again if the server is back this soon.
const RESTORE_WITHIN_MS = 10 * 60_000;

const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Altitude for a track point: 0 on the ground, to the nearest 25 ft. */
const trackAltFt = (ac) => {
  const ft = ac.onGround ? 0 : (ac.altFt ?? ac.altGeomFt);
  return ft == null ? null : Math.round(ft / 25) * 25;
};

export class Tracker {
  constructor({ getConfig, enricher = null }) {
    this.getConfig = getConfig;
    this.enricher = enricher;
    this.planes = new Map();
    this.lastUpdate = null;
    this.wanted = new Map(); // hex → expiry: someone tapped it, look it up even if far away
    this.restored = new Map(); // hex → { firstSeen, trail } saved before a restart
    this.radio = null; // (hex) => what's been heard from it on the radio lately, or null
  }

  ingest({ aircraft }, now = Date.now()) {
    const seenNow = new Set();
    for (const ac of aircraft) {
      seenNow.add(ac.hex);
      let s = this.planes.get(ac.hex);
      if (!s) {
        s = this.restored.get(ac.hex) ?? { firstSeen: now, trail: [] };
        this.restored.delete(ac.hex);
        this.planes.set(ac.hex, s);
      }
      s.ac = ac;
      s.lastSeen = now - ac.seen * 1000;
      if (ac.lat != null && ac.seenPos != null && ac.seenPos < MAX_POSITION_AGE_S) {
        addTrackPoint(s.trail, round(ac.lat, 5), round(ac.lon, 5), now - ac.seenPos * 1000, trackAltFt(ac));
      }
    }
    for (const [hex, s] of this.planes) {
      if (!seenNow.has(hex) && now - s.lastSeen > FORGET_AFTER_MS) this.planes.delete(hex);
    }
    this.lastUpdate = now;
  }

  /** Forget every aircraft, e.g. when the data source changes. */
  clear() {
    this.planes.clear();
    this.restored.clear();
  }

  /** Save every aircraft's track, so a restart doesn't wipe the trails off the map. */
  async saveTracks(file, now = Date.now()) {
    const planes = [...this.planes].map(([hex, s]) => [hex, s.firstSeen, s.trail]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ savedAt: now, planes }));
    await fs.rename(`${file}.tmp`, file);
  }

  /** Pick up tracks saved by saveTracks(), if they are recent enough to still be useful. */
  async loadTracks(file, now = Date.now()) {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    if (!(now - saved.savedAt < RESTORE_WITHIN_MS)) return 0;
    for (const [hex, firstSeen, trail] of saved.planes) this.restored.set(hex, { firstSeen, trail });
    // Aircraft that don't turn up again soon have flown off.
    setTimeout(() => this.restored.clear(), FORGET_AFTER_MS).unref?.();
    return this.restored.size;
  }

  /**
   * Aircraft with a recent position inside the larger of the map and cycle
   * ranges, nearest first, with geometry relative to the receiver.
   */
  snapshot({ trails = false, radio = true, now = Date.now() } = {}) {
    const { receiver, map, display } = this.getConfig();
    const rangeKm = Math.max(map.rangeKm, display.cycleRangeKm);
    const lookupKm = display.cycleRangeKm * 1.5;
    for (const [hex, until] of this.wanted) if (until < now) this.wanted.delete(hex);
    const out = [];
    for (const [hex, s] of this.planes) {
      const ac = s.ac;
      if (ac.lat == null || ac.seenPos == null) continue;
      const posAge = ac.seenPos + (now - this.lastUpdate) / 1000;
      if (posAge > MAX_POSITION_AGE_S) continue;
      const dist = distanceM(receiver.lat, receiver.lon, ac.lat, ac.lon);
      if (dist / 1000 > rangeKm) continue;
      const altFt = ac.altGeomFt ?? ac.altFt;
      const elevation = ac.onGround
        ? null
        : altFt == null
          ? null
          : elevationDeg(dist, altFt * M_PER_FT, receiver.altitudeM);
      let extra = { reg: ac.reg, typeInfo: null };
      try {
        // Only look up routes/photos for aircraft that may soon get a card.
        if (this.enricher)
          extra = this.enricher.enrich(ac, { lookup: dist / 1000 <= lookupKm || this.wanted.has(hex) });
      } catch (err) {
        this.#enrichError(err);
      }
      const item = {
        hex,
        callsign: ac.callsign,
        squawk: ac.squawk,
        emergency: ac.emergency,
        category: ac.category,
        lat: round(ac.lat, 5),
        lon: round(ac.lon, 5),
        onGround: ac.onGround,
        altFt: ac.altFt,
        altGeomFt: ac.altGeomFt,
        gsKt: ac.gsKt,
        trackDeg: ac.trackDeg,
        vertRateFpm: ac.vertRateFpm,
        distanceKm: round(dist / 1000, 3),
        bearingDeg: round(bearingDeg(receiver.lat, receiver.lon, ac.lat, ac.lon), 1),
        elevationDeg: round(elevation, 1),
        posAge: round(posAge, 1),
        mlat: ac.mlat,
        firstSeen: s.firstSeen,
        ...extra,
      };
      if (trails) item.trail = s.trail.map((p) => p.slice());
      const heard = radio && this.radio?.(hex);
      if (heard) item.radio = heard;
      out.push(item);
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
  }

  /** Look up route and photo for this aircraft for the next few minutes, wherever it is. */
  want(hex, now = Date.now()) {
    if (!this.planes.has(hex)) return false;
    this.wanted.set(hex, now + 5 * 60_000);
    return true;
  }

  #enrichError(err) {
    const now = Date.now();
    if (!this.lastEnrichErrorAt || now - this.lastEnrichErrorAt > 60_000) console.warn('enrichment failed:', err);
    this.lastEnrichErrorAt = now;
  }

  get count() {
    return this.planes.size;
  }
}
