// Daily traffic log: every aircraft that passes through the map range is
// recorded once per visit and saved to data/traffic/YYYY-MM-DD.json, so the
// control panel can show what flew over today (or any earlier day).
//
// Days follow the server's local time (set TZ in docker-compose.yml).
import fs from 'node:fs/promises';
import path from 'node:path';
import { distanceM } from '../shared/geo.js';
import { explore } from './traffic-explore.js';

// A plane not seen for this long that turns up again counts as a new visit.
const VISIT_GAP_MS = 20 * 60_000;
const SAVE_MS = 60_000;
const RETENTION_DAYS = 400;
const NEW_TYPE_LOOKBACK_DAYS = 30;
const TOP_N = 10;
const MAX_ROWS = 150;
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
// Low passes near the home airport are recorded out to this distance and up to
// this height above it; the settings choose what counts within that.
const AIRPORT_AREA_KM = 40;
const AIRPORT_AREA_FT = 10_000;
// Climbing or descending by more than this while near the airport tells a
// take-off from a landing when the route doesn't.
const CLIMB_FT = 800;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date of a timestamp: "2026-10-02". */
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-02" shifted by `days` calendar days. */
export function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + days, 12).getTime());
}

export const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const airportCode = (a) => (a ? a.code || a.iata || a.icao || null : null);
const airportBrief = (a) => (a ? { code: airportCode(a), icao: a.icao ?? null, city: a.city ?? a.name ?? null } : null);
const isAirport = (a, code) => !!a && (a.code === code || a.icao === code);

function top(counts, n = TOP_N) {
  return [...counts.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(b.label)).slice(0, n);
}

function bump(map, key, label, extra = {}, hour = null) {
  if (!key) return;
  const e = map.get(key) ?? { key, label, count: 0, ...extra, ...(hour != null ? { hourly: Array(24).fill(0) } : {}) };
  e.count++;
  if (hour != null) e.hourly[hour]++;
  map.set(key, e);
}

/**
 * How a visit used the home airport `apt`, or null if it never came low near it.
 * { phase: 'departure' | 'arrival' | 'low', other: the airport at the far end,
 *   scheduled: true if its route includes the airport, false if not (a
 *   diversion, say), null if it has no known route (private, training, medical) }
 */
export function airportMovement(v, apt) {
  const p = v.airport;
  if (!apt?.code || p?.code !== apt.code || p.minFt > apt.maxHeightFt || p.minKm > apt.radiusKm) return null;
  const from = isAirport(v.from, apt.code);
  const to = isAirport(v.to, apt.code);
  if (from && !to) return { phase: 'departure', other: v.to, scheduled: true };
  if (to && !from) return { phase: 'arrival', other: v.from, scheduled: true };
  const rise = (p.lastFt ?? p.firstFt) - p.firstFt;
  const phase = rise > CLIMB_FT ? 'departure' : rise < -CLIMB_FT ? 'arrival' : 'low';
  // A multi-stop flight whose current leg was taken to be the other one.
  const via = v.via ?? [];
  const i = via.indexOf(apt.code);
  const other = i < 0 ? null : phase === 'departure' ? via[i + 1] : phase === 'arrival' ? via[i - 1] : null;
  if (other) return { phase, other: { code: other, city: null }, scheduled: true };
  return { phase, other: null, scheduled: v.from || v.to ? false : null };
}

const visitBrief = (v, extra) => ({
  hex: v.hex,
  callsign: v.callsign ?? null,
  flight: v.flight ?? null,
  reg: v.reg ?? null,
  type: v.type ?? null,
  typeName: v.typeName ?? null,
  airline: v.airline ?? null,
  from: v.from ?? null,
  to: v.to ?? null,
  first: v.first,
  airport: v.airport,
  ...extra,
});

/**
 * One day at the home airport: departures by destination, arrivals by origin,
 * low flights with no known route, and flights that used it off-schedule.
 */
export function airportDay(visits, apt, date) {
  const departures = new Map();
  const arrivals = new Map();
  const unrouted = { departure: 0, arrival: 0, low: 0 };
  const unusual = [];
  let city = null;
  for (const v of visits) {
    for (const a of [v.from, v.to]) if (!city && isAirport(a, apt.code) && a.city) city = a.city;
    const m = airportMovement(v, apt);
    if (!m) continue;
    if (m.scheduled === null) unrouted[m.phase]++;
    else if (!m.scheduled) unusual.push(visitBrief(v, { movement: m.phase, date }));
    else {
      const code = m.other?.code ?? '?';
      bump(m.phase === 'departure' ? departures : arrivals, code, m.other?.city ?? code, { code });
    }
  }
  return {
    code: apt.code,
    city,
    departures: top(departures, MAX_ROWS),
    arrivals: top(arrivals, MAX_ROWS),
    unrouted,
    unusual,
  };
}

/** Add up several days of airportDay() results. */
export function mergeAirportDays(days) {
  const sum = (pick) => {
    const m = new Map();
    for (const d of days) {
      for (const r of pick(d)) {
        const e = m.get(r.key) ?? { ...r, count: 0 };
        e.count += r.count;
        m.set(r.key, e);
      }
    }
    return top(m, MAX_ROWS);
  };
  const unrouted = { departure: 0, arrival: 0, low: 0 };
  for (const d of days) for (const k of Object.keys(unrouted)) unrouted[k] += d.unrouted[k];
  return {
    code: days[0]?.code ?? null,
    city: days.find((d) => d.city)?.city ?? null,
    departures: sum((d) => d.departures),
    arrivals: sum((d) => d.arrivals),
    unrouted,
    unusual: days.flatMap((d) => d.unusual).sort((a, b) => b.first - a.first),
  };
}

/** Summary of one day's visits. `newTypes` lists type codes not seen in the previous weeks. */
export function summarize(date, visits, { newTypes = new Set() } = {}) {
  const hourly = Array(24).fill(0);
  const airlines = new Map();
  const types = new Map();
  const routes = new Map();
  const airports = new Map();
  const categories = new Map();
  const hexes = new Set();
  let overhead = 0;
  let cargo = 0;
  let military = 0;
  let closest = null;
  let highest = null;
  let fastest = null;
  const emergencies = [];
  const newTypeVisits = new Map();

  for (const v of visits) {
    hexes.add(v.hex);
    const hour = new Date(v.first).getHours();
    hourly[hour]++;
    if (v.overhead) overhead++;
    if (v.cargo) cargo++;
    if (v.military) military++;
    // Like a bird log: how many of each, and when in the day they came by.
    bump(
      airlines,
      v.airline?.icao ?? v.airline?.name,
      v.airline?.name ?? v.airline?.icao,
      { icao: v.airline?.icao ?? null },
      hour,
    );
    bump(types, v.type, v.typeName ?? v.type, { code: v.type, category: v.category ?? null }, hour);
    bump(categories, v.category, v.category, {}, hour);
    const from = airportCode(v.from);
    const to = airportCode(v.to);
    if (from && to)
      bump(routes, `${from}-${to}`, `${from} → ${to}`, { from: airportBrief(v.from), to: airportBrief(v.to) });
    if (from) bump(airports, from, v.from.city ?? from, { code: from });
    if (to) bump(airports, to, v.to.city ?? to, { code: to });
    if (v.minKm != null && !v.ground && (!closest || v.minKm < closest.minKm)) closest = v;
    if (v.maxAltFt != null && (!highest || v.maxAltFt > highest.maxAltFt)) highest = v;
    if (v.maxGsKt != null && (!fastest || v.maxGsKt > fastest.maxGsKt)) fastest = v;
    if (v.squawk7x00) emergencies.push(v);
    if (v.type && newTypes.has(v.type) && !newTypeVisits.has(v.type)) newTypeVisits.set(v.type, v);
  }

  const busiest = hourly.reduce((best, n, h) => (n > hourly[best] ? h : best), 0);
  const sorted = [...visits].sort((a, b) => a.first - b.first);
  return {
    date,
    totals: {
      flights: visits.length,
      aircraft: hexes.size,
      overhead,
      airlines: airlines.size,
      types: types.size,
      cargo,
      military,
    },
    hourly,
    busiestHour: visits.length ? { hour: busiest, flights: hourly[busiest] } : null,
    airlines: top(airlines, MAX_ROWS),
    types: top(types, MAX_ROWS),
    topRoutes: top(routes),
    topAirports: top(airports),
    categories: top(categories, 20),
    notable: {
      closest,
      highest,
      fastest,
      first: sorted[0] ?? null,
      last: sorted.at(-1) ?? null,
      newTypes: [...newTypeVisits.values()],
      emergencies,
      special: visits.filter((v) => v.special),
    },
    flights: sorted,
  };
}

export class TrafficLog {
  constructor({ dataDir, getConfig, log = console }) {
    this.dir = path.join(dataDir, 'traffic');
    this.getConfig = getConfig;
    this.log = log;
    /** date → { visits: [], dirty } for days still being written */
    this.days = new Map();
    /** hex → the visit in progress */
    this.open = new Map();
    /** date → { flights, aircraft, types: Set } for finished days (their files no longer change) */
    this.pastCache = new Map();
  }

  #file(date) {
    return path.join(this.dir, `${date}.json`);
  }

  async start(now = Date.now()) {
    await fs.mkdir(this.dir, { recursive: true });
    // Pick up where we left off so a restart doesn't count everything twice.
    for (const date of [addDays(dayKey(now), -1), dayKey(now)]) {
      const visits = await this.#read(date);
      if (!visits) continue;
      this.days.set(date, { visits, dirty: false });
      for (const v of visits) {
        if (now - v.last < VISIT_GAP_MS && (!this.open.get(v.hex) || this.open.get(v.hex).last < v.last)) {
          this.open.set(v.hex, v);
        }
      }
    }
    this.saveTimer = setInterval(() => this.save().catch((err) => this.log.warn(`traffic: ${err.message}`)), SAVE_MS);
    this.saveTimer.unref?.();
    await this.prune(now);
  }

  async stop() {
    clearInterval(this.saveTimer);
    await this.save();
  }

  /** Record a tracker snapshot (enriched aircraft inside the map range). */
  observe(aircraft, now = Date.now()) {
    const { display, traffic } = this.getConfig();
    const cycleKm = display.cycleRangeKm;
    const apt = traffic?.airport?.code ? traffic.airport : null;
    for (const ac of aircraft) {
      let v = this.open.get(ac.hex);
      const callsignChanged = v && ac.callsign && v.callsign && ac.callsign !== v.callsign;
      if (!v || now - v.last > VISIT_GAP_MS || callsignChanged) {
        v = { hex: ac.hex, first: now, last: now, minKm: null, minAltFt: null, maxAltFt: null, maxGsKt: null };
        this.open.set(ac.hex, v);
        this.#day(dayKey(now)).visits.push(v);
      }
      this.#update(v, ac, cycleKm, now);
      if (apt) this.#airportPass(v, ac, apt, now);
      this.#day(dayKey(v.first)).dirty = true;
    }
    if (now - (this.lastSweep ?? 0) > 60_000) this.#sweep(now);
  }

  #day(date) {
    let d = this.days.get(date);
    if (!d) {
      d = { visits: [], dirty: false };
      this.days.set(date, d);
    }
    return d;
  }

  #update(v, ac, cycleKm, now) {
    v.last = now;
    v.callsign ??= ac.callsign ?? null;
    v.flight ??= ac.flight ?? null;
    v.reg ??= ac.reg ?? null;
    if (ac.typeInfo) {
      v.type ??= ac.typeInfo.code ?? null;
      v.typeName ??= ac.typeInfo.name ?? null;
      v.category ??= ac.typeInfo.category ?? null;
    }
    if (ac.airline && !v.airline) v.airline = { icao: ac.airline.icao ?? null, name: ac.airline.name ?? null };
    if (ac.route && !v.from) {
      v.from = airportBrief(ac.route.origin);
      v.to = airportBrief(ac.route.destination);
    }
    if (ac.route?.via) v.via ??= ac.route.via;
    // Where it was seen: your antenna, or only the online feed (with antenna + online fill-in).
    if (ac.via === 'antenna') v.antenna = true;
    else if (ac.via === 'online') v.online = true;
    if (ac.cargo) v.cargo = true;
    if (ac.military) v.military = true;
    if (ac.special && !v.special) v.special = { kind: ac.special.kind, name: ac.special.name };
    if (ac.squawk && EMERGENCY_SQUAWKS.has(ac.squawk)) v.squawk7x00 = ac.squawk;
    if (ac.onGround) v.ground = true;
    const altFt = ac.onGround ? null : (ac.altFt ?? ac.altGeomFt);
    if (ac.distanceKm != null && (v.minKm == null || ac.distanceKm < v.minKm)) {
      v.minKm = ac.distanceKm;
      v.closestAt = now;
      v.altAtClosestFt = altFt;
    }
    if (ac.distanceKm != null && ac.distanceKm <= cycleKm) v.overhead = true;
    if (altFt != null) {
      if (v.minAltFt == null || altFt < v.minAltFt) v.minAltFt = altFt;
      if (v.maxAltFt == null || altFt > v.maxAltFt) v.maxAltFt = altFt;
    }
    if (ac.gsKt != null && (v.maxGsKt == null || ac.gsKt > v.maxGsKt)) v.maxGsKt = ac.gsKt;
  }

  /**
   * Lowest point near the home airport, and the height on entering and leaving
   * that area (to tell a take-off from a landing when the route doesn't say).
   */
  #airportPass(v, ac, apt, now) {
    if (ac.lat == null) return;
    const km = distanceM(apt.lat, apt.lon, ac.lat, ac.lon) / 1000;
    const alt = ac.onGround ? apt.elevationFt : (ac.altGeomFt ?? ac.altFt);
    if (alt == null || km > AIRPORT_AREA_KM) return;
    const ft = Math.round(alt - apt.elevationFt);
    if (ft > AIRPORT_AREA_FT) return;
    let p = v.airport;
    if (p?.code !== apt.code) {
      p = v.airport = { code: apt.code, firstFt: ft, firstAt: now, minFt: ft, minKm: null, minAt: now };
    }
    if (ft <= p.minFt) Object.assign(p, { minFt: ft, minKm: Math.round(km * 10) / 10, minAt: now });
    p.lastFt = ft;
    p.lastAt = now;
  }

  /** Close finished visits and let go of days nobody is writing to any more. */
  #sweep(now) {
    this.lastSweep = now;
    for (const [hex, v] of this.open) if (now - v.last > VISIT_GAP_MS) this.open.delete(hex);
    const today = dayKey(now);
    const stillOpen = new Set([...this.open.values()].map((v) => dayKey(v.first)));
    for (const [date, d] of this.days) {
      if (date === today || stillOpen.has(date) || d.dirty) continue;
      this.days.delete(date);
    }
  }

  async save() {
    for (const [date, d] of this.days) {
      if (!d.dirty) continue;
      d.dirty = false;
      const tmp = `${this.#file(date)}.tmp`;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({ date, visits: d.visits }));
      await fs.rename(tmp, this.#file(date));
      this.pastCache.delete(date);
    }
  }

  async #read(date) {
    try {
      const json = JSON.parse(await fs.readFile(this.#file(date), 'utf8'));
      return Array.isArray(json.visits) ? json.visits : [];
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`traffic: could not read ${date}: ${err.message}`);
      return null;
    }
  }

  async #visits(date) {
    return this.days.get(date)?.visits ?? (await this.#read(date)) ?? [];
  }

  /** Flight/aircraft counts, type codes and home-airport tally of a day (cached once the day is over). */
  async #brief(date, now = Date.now()) {
    const apt = this.#airport();
    const aptKey = apt ? JSON.stringify(apt) : '';
    const cached = this.pastCache.get(date);
    if (cached && cached.aptKey === aptKey) return cached;
    const visits = await this.#visits(date);
    const brief = {
      flights: visits.length,
      aircraft: new Set(visits.map((v) => v.hex)).size,
      types: new Set(visits.map((v) => v.type).filter(Boolean)),
      airport: apt ? airportDay(visits, apt, date) : null,
      aptKey,
    };
    if (date < dayKey(now) && !this.days.has(date)) this.pastCache.set(date, brief);
    return brief;
  }

  /** Full summary for one day. */
  async summary(date = dayKey(Date.now()), now = Date.now()) {
    const visits = await this.#visits(date);
    const seenBefore = new Set();
    for (let i = 1; i <= NEW_TYPE_LOOKBACK_DAYS; i++) {
      for (const t of (await this.#brief(addDays(date, -i), now)).types) seenBefore.add(t);
    }
    // Only call a type "new" once there is some history to compare with.
    const haveHistory = (await this.history(addDays(date, -1), NEW_TYPE_LOOKBACK_DAYS, now)).some((d) => d.flights);
    const newTypes = new Set(haveHistory ? visits.map((v) => v.type).filter((t) => t && !seenBefore.has(t)) : []);
    const s = summarize(date, visits, { newTypes });
    s.history = await this.history(date, 30, now);
    const prior = s.history.slice(0, -1).filter((d) => d.flights);
    s.averageFlights = prior.length ? Math.round(prior.reduce((sum, d) => sum + d.flights, 0) / prior.length) : null;
    s.isToday = date === dayKey(now);
    const apt = this.#airport();
    if (apt) {
      const days = [];
      for (let i = 0; i < 30; i++) days.push((await this.#brief(addDays(date, -i), now)).airport);
      s.airport = { ...airportDay(visits, apt, date), maxHeightFt: apt.maxHeightFt, radiusKm: apt.radiusKm };
      s.airport30 = mergeAirportDays(days);
    } else {
      s.airport = null;
      s.airport30 = null;
    }
    return s;
  }

  #airport() {
    const apt = this.getConfig().traffic?.airport;
    return apt?.code ? apt : null;
  }

  /**
   * The explorer: the days from `from` to `to` (at most 90), filtered and
   * grouped (see server/traffic-explore.js). `ctx.manufacturer(code)` names
   * a type's maker.
   */
  async explore({ from, to, ...opts }, ctx = {}, now = Date.now()) {
    const last = to && to <= dayKey(now) ? to : dayKey(now);
    let first = from && from <= last ? from : last;
    if (addDays(first, 89) < last) first = addDays(last, -89);
    const dates = [];
    for (let d = first; d <= last; d = addDays(d, 1)) dates.push(d);
    const visits = [];
    for (const date of dates) {
      // A copy with its day, so the live visits (saved to disk) aren't touched.
      for (const v of await this.#exploreVisits(date, now)) visits.push({ ...v, day: date });
    }
    return { from: first, to: last, ...explore(visits, { ...opts, dates }, ctx) };
  }

  /** A day's visits; finished days are kept in memory once read (the last 100). */
  async #exploreVisits(date, now) {
    if (date >= dayKey(now) || this.days.has(date)) return this.#visits(date);
    this.visitCache ??= new Map();
    let visits = this.visitCache.get(date);
    if (!visits) {
      visits = (await this.#read(date)) ?? [];
      this.visitCache.set(date, visits);
      if (this.visitCache.size > 100) this.visitCache.delete(this.visitCache.keys().next().value);
    }
    return visits;
  }

  /** Flight counts for the `days` days ending with `date`, oldest first. */
  async history(date, days = 30, now = Date.now()) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(date, -i);
      const { flights, aircraft } = await this.#brief(d, now);
      out.push({ date: d, flights, aircraft });
    }
    return out;
  }

  /** Delete day files older than the retention period. */
  async prune(now = Date.now()) {
    const cutoff = addDays(dayKey(now), -RETENTION_DAYS);
    let files = [];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m && m[1] < cutoff) await fs.rm(path.join(this.dir, f), { force: true });
    }
  }

  status() {
    return { today: this.days.get(dayKey(Date.now()))?.visits.length ?? 0, inProgress: this.open.size };
  }
}
