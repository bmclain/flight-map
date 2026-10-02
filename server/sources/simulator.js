// Fake traffic around the receiver so the display can be developed and tested
// without a radio. Produces readsb-style records and knows each fake flight's
// route, so the whole pipeline (enrichment, cycling, map) gets exercised.
import { bearingDeg, destinationPoint, distanceM, normalizeDeg, relativeBearing } from '../../shared/geo.js';
import { parseAircraftJson } from './parse.js';

const AIRPORTS = [
  ['KSEA', 'SEA', 'Seattle–Tacoma International Airport', 'Seattle', 'US', 47.4502, -122.3088],
  ['KSFO', 'SFO', 'San Francisco International Airport', 'San Francisco', 'US', 37.6189, -122.375],
  ['KLAX', 'LAX', 'Los Angeles International Airport', 'Los Angeles', 'US', 33.9425, -118.4081],
  ['KJFK', 'JFK', 'John F. Kennedy International Airport', 'New York', 'US', 40.6413, -73.7781],
  ['KORD', 'ORD', "Chicago O'Hare International Airport", 'Chicago', 'US', 41.9786, -87.9048],
  ['KDEN', 'DEN', 'Denver International Airport', 'Denver', 'US', 39.8561, -104.6737],
  ['KATL', 'ATL', 'Hartsfield–Jackson Atlanta International Airport', 'Atlanta', 'US', 33.6407, -84.4277],
  ['KDFW', 'DFW', 'Dallas/Fort Worth International Airport', 'Dallas', 'US', 32.8998, -97.0403],
  ['KBOS', 'BOS', 'Logan International Airport', 'Boston', 'US', 42.3656, -71.0096],
  ['KPHX', 'PHX', 'Phoenix Sky Harbor International Airport', 'Phoenix', 'US', 33.4342, -112.0116],
  ['KLAS', 'LAS', 'Harry Reid International Airport', 'Las Vegas', 'US', 36.084, -115.1537],
  ['PANC', 'ANC', 'Ted Stevens Anchorage International Airport', 'Anchorage', 'US', 61.1743, -149.9963],
  ['PHNL', 'HNL', 'Daniel K. Inouye International Airport', 'Honolulu', 'US', 21.3187, -157.9225],
  ['KMSP', 'MSP', 'Minneapolis–Saint Paul International Airport', 'Minneapolis', 'US', 44.8848, -93.2223],
  ['KSLC', 'SLC', 'Salt Lake City International Airport', 'Salt Lake City', 'US', 40.7899, -111.9791],
  ['KPDX', 'PDX', 'Portland International Airport', 'Portland', 'US', 45.5898, -122.5951],
  ['KSAN', 'SAN', 'San Diego International Airport', 'San Diego', 'US', 32.7338, -117.1933],
  ['CYVR', 'YVR', 'Vancouver International Airport', 'Vancouver', 'CA', 49.1967, -123.1815],
  ['KMIA', 'MIA', 'Miami International Airport', 'Miami', 'US', 25.7959, -80.287],
  ['KIAH', 'IAH', 'George Bush Intercontinental Airport', 'Houston', 'US', 29.9902, -95.3368],
  ['RJTT', 'HND', 'Tokyo Haneda Airport', 'Tokyo', 'JP', 35.5494, 139.7798],
  ['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.47, -0.4543],
  ['RKSI', 'ICN', 'Incheon International Airport', 'Seoul', 'KR', 37.4602, 126.4407],
  ['MMMX', 'MEX', 'Mexico City International Airport', 'Mexico City', 'MX', 19.4361, -99.0719],
].map(([icao, iata, name, city, country, lat, lon]) => ({ icao, iata, name, city, country, lat, lon }));

const FLEETS = [
  { kind: 'airline', icao: 'UAL', types: ['B38M', 'B739', 'A320', 'B789', 'B77W', 'B752'] },
  { kind: 'airline', icao: 'DAL', types: ['A321', 'B739', 'A21N', 'B752', 'A359', 'BCS1'] },
  { kind: 'airline', icao: 'AAL', types: ['B38M', 'A321', 'B738', 'B789'] },
  { kind: 'airline', icao: 'ASA', types: ['B38M', 'B739', 'B39M', 'B738'] },
  { kind: 'airline', icao: 'SWA', types: ['B38M', 'B737', 'B738'] },
  { kind: 'airline', icao: 'JBU', types: ['A20N', 'A21N', 'BCS3'] },
  { kind: 'airline', icao: 'QXE', types: ['E75L', 'DH8D'] },
  { kind: 'airline', icao: 'SKW', types: ['E75L', 'CRJ9', 'CRJ7'] },
  { kind: 'airline', icao: 'FDX', types: ['B763', 'B77L', 'MD11'] },
  { kind: 'airline', icao: 'UPS', types: ['B744', 'B763', 'B748'] },
  { kind: 'airline', icao: 'ACA', types: ['BCS3', 'B38M', 'A333'] },
  { kind: 'airline', icao: 'KAL', types: ['B748', 'A359', 'B77W'] },
  { kind: 'ga', types: ['C172', 'SR22', 'P28A', 'DA40', 'BE36', 'C182'] },
  { kind: 'turboprop', types: ['PC12', 'C208', 'BE20', 'TBM9'] },
  { kind: 'bizjet', types: ['C56X', 'GLF6', 'CL35', 'E55P', 'C68A', 'HDJT'] },
  { kind: 'heli', types: ['R44', 'EC35', 'B407', 'AS50'] },
];
const FLEET_WEIGHTS = [5, 5, 4, 5, 3, 2, 3, 3, 2, 1, 1, 1, 4, 2, 2, 2];

const PROFILE = {
  airline: { alt: [4000, 38000], gs: [250, 490], cat: 'A3' },
  ga: { alt: [1500, 8500], gs: [90, 160], cat: 'A1' },
  turboprop: { alt: [5000, 24000], gs: [180, 290], cat: 'A1' },
  bizjet: { alt: [9000, 45000], gs: [280, 480], cat: 'A2' },
  heli: { alt: [500, 1500], gs: [60, 130], cat: 'A7' },
};
const HEAVY = new Set(['B789', 'B77W', 'A359', 'B763', 'B77L', 'MD11', 'B744', 'B748', 'A333']);

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
const between = ([lo, hi], rnd) => lo + (hi - lo) * rnd();

function weightedPick(items, weights, rnd) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Deterministic PRNG so tests can reproduce a scenario. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatorSource {
  constructor({ getConfig, pollSeconds = 1, onData, count = 16, seed = Date.now(), log = console }) {
    this.type = 'simulator';
    this.getConfig = getConfig;
    this.pollMs = Math.max(500, pollSeconds * 1000);
    this.onData = onData;
    this.count = count;
    this.rnd = mulberry32(seed);
    this.log = log;
    this.planes = [];
    this.routes = new Map();
    this.messages = 0;
    this.timer = null;
    this.lastTick = null;
    this.state = { lastOkAt: null, lastError: null, aircraftCount: 0, positionCount: 0, messageRate: null };
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Route for a simulated callsign, in the same shape the route providers return. */
  lookupRoute(callsign) {
    return this.routes.get(callsign) ?? null;
  }

  tick(now = Date.now()) {
    const { receiver, map, display } = this.getConfig();
    const rangeM = Math.max(map.rangeKm, display.cycleRangeKm) * 1000;
    const dt = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;

    for (const p of this.planes) this.#move(p, dt);
    this.planes = this.planes.filter((p) => distanceM(receiver.lat, receiver.lon, p.lat, p.lon) < rangeM * 1.15);
    while (this.planes.length < this.count) {
      this.planes.push(this.#spawn(receiver, rangeM, display.cycleRangeKm * 1000, !dt));
    }

    const records = this.planes.map((p) => this.#record(p));
    this.messages += records.length * 12;
    const data = parseAircraftJson({ now: now / 1000, messages: this.messages, aircraft: records });
    this.state = {
      lastOkAt: now,
      lastError: null,
      aircraftCount: records.length,
      positionCount: records.length,
      messageRate: (records.length * 12) / (this.pollMs / 1000),
    };
    this.onData?.(data);
    return data;
  }

  status() {
    return { type: 'simulator', url: null, ...this.state };
  }

  #spawn(receiver, rangeM, cycleRangeM, initial) {
    const rnd = this.rnd;
    const fleet = weightedPick(FLEETS, FLEET_WEIGHTS, rnd);
    const kind = fleet.kind;
    const profile = PROFILE[kind];
    const type = pick(fleet.types, rnd);
    // Start inside the area on the first tick so the display has something to show,
    // afterwards enter from the edge.
    const fromBearing = rnd() * 360;
    const startDist = initial ? rangeM * (0.1 + 0.85 * rnd()) : rangeM * 1.05;
    const start = destinationPoint(receiver.lat, receiver.lon, fromBearing, startDist);
    // Aim at a point near the receiver so most aircraft pass through the cycle range.
    const aim = destinationPoint(receiver.lat, receiver.lon, rnd() * 360, cycleRangeM * 0.9 * rnd());
    const track = bearingDeg(start.lat, start.lon, aim.lat, aim.lon);

    const reg = this.#registration();
    const hex = Math.floor(0xa00000 + rnd() * 0xdf7c7).toString(16);
    let callsign = reg;
    if (kind === 'airline') {
      callsign = `${fleet.icao}${Math.floor(10 + rnd() * 2900)}`;
      this.routes.set(callsign, this.#route(receiver, track, HEAVY.has(type)));
    }
    let alt = Math.round(between(profile.alt, rnd) / 100) * 100;
    let vr = 0;
    if (kind === 'airline' && alt < 20000) vr = rnd() < 0.5 ? -1200 : 1800;
    if (HEAVY.has(type)) alt = Math.max(alt, 24000);
    return {
      hex,
      callsign,
      reg,
      type,
      category: HEAVY.has(type) ? 'A5' : profile.cat,
      lat: start.lat,
      lon: start.lon,
      track,
      gs: Math.round(between(profile.gs, rnd)),
      alt,
      vr,
      squawk: Array.from({ length: 4 }, () => Math.floor(rnd() * 8)).join(''),
      rssi: -10 - rnd() * 20,
    };
  }

  #move(p, dt) {
    const next = destinationPoint(p.lat, p.lon, p.track, p.gs * 0.514444 * dt);
    p.lat = next.lat;
    p.lon = next.lon;
    if (p.vr) {
      p.alt = Math.min(39000, Math.max(1500, p.alt + (p.vr * dt) / 60));
      if (p.alt >= 39000 || p.alt <= 1500) p.vr = 0;
    }
    p.track = normalizeDeg(p.track + (this.rnd() - 0.5) * 0.2 * dt);
  }

  #record(p) {
    return {
      hex: p.hex,
      flight: p.callsign.padEnd(8, ' '),
      r: p.reg,
      t: p.type,
      category: p.category,
      alt_baro: Math.round(p.alt / 25) * 25,
      alt_geom: Math.round((p.alt + 150) / 25) * 25,
      gs: p.gs,
      track: Math.round(p.track * 10) / 10,
      baro_rate: p.vr,
      squawk: p.squawk,
      lat: p.lat,
      lon: p.lon,
      seen: 0.1,
      seen_pos: 0.2,
      rssi: Math.round(p.rssi * 10) / 10,
    };
  }

  #registration() {
    const rnd = this.rnd;
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digits = String(Math.floor(100 + rnd() * 899));
    const tail =
      rnd() < 0.6 ? letters[Math.floor(rnd() * letters.length)] + letters[Math.floor(rnd() * letters.length)] : '';
    return `N${digits}${tail}`;
  }

  /** Pick an origin behind the aircraft and a destination ahead of it. */
  #route(receiver, track, longHaul) {
    const far = AIRPORTS.filter((a) => distanceM(receiver.lat, receiver.lon, a.lat, a.lon) > 150_000);
    const score = (target) => (a) =>
      Math.abs(relativeBearing(bearingDeg(receiver.lat, receiver.lon, a.lat, a.lon), target)) +
      (longHaul ? 0 : distanceM(receiver.lat, receiver.lon, a.lat, a.lon) / 100_000) +
      this.rnd() * 25;
    const best = (target) => [...far].sort((a, b) => score(target)(a) - score(target)(b))[0];
    const destination = best(track) ?? AIRPORTS[0];
    let origin = best(normalizeDeg(track + 180)) ?? AIRPORTS[1];
    if (origin.icao === destination.icao) origin = AIRPORTS.find((a) => a.icao !== destination.icao);
    return { airports: [origin, destination], airline: null, flightIata: null, source: 'simulator' };
  }
}
