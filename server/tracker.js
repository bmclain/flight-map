// Keeps the latest state of every aircraft heard, their recent trails, and
// builds the enriched list that is pushed to the displays.
import { bearingDeg, distanceM, elevationDeg, M_PER_FT } from '../shared/geo.js';

const MAX_POSITION_AGE_S = 60;
const FORGET_AFTER_MS = 90_000;
const TRAIL_STEP_MS = 4000;

const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export class Tracker {
  constructor({ getConfig, enricher = null }) {
    this.getConfig = getConfig;
    this.enricher = enricher;
    this.planes = new Map();
    this.lastUpdate = null;
    this.wanted = new Map(); // hex → expiry: someone tapped it, look it up even if far away
  }

  ingest({ aircraft }, now = Date.now()) {
    const trailMs = Math.max(1, this.getConfig().map.trailMinutes) * 60_000;
    const seenNow = new Set();
    for (const ac of aircraft) {
      seenNow.add(ac.hex);
      let s = this.planes.get(ac.hex);
      if (!s) {
        s = { firstSeen: now, trail: [] };
        this.planes.set(ac.hex, s);
      }
      s.ac = ac;
      s.lastSeen = now - ac.seen * 1000;
      if (ac.lat != null && ac.seenPos != null && ac.seenPos < MAX_POSITION_AGE_S) {
        const t = now - ac.seenPos * 1000;
        const last = s.trail[s.trail.length - 1];
        if (!last || t - last[2] >= TRAIL_STEP_MS) s.trail.push([round(ac.lat, 5), round(ac.lon, 5), t]);
        while (s.trail.length && now - s.trail[0][2] > trailMs) s.trail.shift();
      }
    }
    for (const [hex, s] of this.planes) {
      if (!seenNow.has(hex) && now - s.lastSeen > FORGET_AFTER_MS) this.planes.delete(hex);
    }
    this.lastUpdate = now;
  }

  /**
   * Aircraft with a recent position inside the larger of the map and cycle
   * ranges, nearest first, with geometry relative to the receiver.
   */
  snapshot({ trails = false, now = Date.now() } = {}) {
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
        if (this.enricher) extra = this.enricher.enrich(ac, { lookup: dist / 1000 <= lookupKm || this.wanted.has(hex) });
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
      if (trails) item.trail = s.trail.map(([lat, lon, t]) => [lat, lon, t]);
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
