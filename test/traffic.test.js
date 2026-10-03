import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../server/config.js';
import { TrafficLog, addDays, airportMovement, dayKey, summarize } from '../server/traffic.js';
import { destinationPoint } from '../shared/geo.js';
import { quietLog, tmpDir } from './helpers.js';

const cfg = structuredClone(DEFAULT_CONFIG);
const at = (h, m = 0, day = 2) => new Date(2026, 9, day, h, m).getTime();

const plane = (hex, extra = {}) => ({
  hex,
  callsign: 'ASA123',
  reg: 'N123AS',
  typeInfo: { code: 'B739', name: 'Boeing 737-900', category: 'narrowbody' },
  airline: { icao: 'ASA', name: 'Alaska Airlines' },
  route: { origin: { iata: 'SEA', city: 'Seattle' }, destination: { iata: 'SFO', city: 'San Francisco' } },
  distanceKm: 10,
  altFt: 9000,
  gsKt: 300,
  onGround: false,
  ...extra,
});

test('dayKey and addDays use local calendar days', () => {
  assert.equal(dayKey(at(23, 59)), '2026-10-02');
  assert.equal(addDays('2026-10-02', 1), '2026-10-03');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('TrafficLog counts one visit per pass and tracks the closest point', async () => {
  const log = new TrafficLog({ dataDir: await tmpDir(), getConfig: () => cfg, log: quietLog });
  log.observe([plane('aaaaaa', { distanceKm: 30, altFt: 12000 })], at(8));
  log.observe([plane('aaaaaa', { distanceKm: 4, altFt: 6000 })], at(8, 1));
  log.observe([plane('aaaaaa', { distanceKm: 20, altFt: 3000 })], at(8, 2));
  // back an hour later: a new visit
  log.observe([plane('aaaaaa', { distanceKm: 50 })], at(9, 5));
  // same airframe, new flight number straight away: also a new visit
  log.observe([plane('aaaaaa', { callsign: 'ASA456', distanceKm: 50 })], at(9, 6));
  log.observe(
    [plane('bbbbbb', { callsign: 'UAL1', airline: { icao: 'UAL', name: 'United Airlines' }, route: null })],
    at(9, 10),
  );

  const s = await log.summary('2026-10-02', at(12));
  assert.equal(s.totals.flights, 4);
  assert.equal(s.totals.aircraft, 2);
  assert.equal(s.totals.overhead, 2); // cycle range is 24 km
  const first = s.flights[0];
  assert.equal(first.minKm, 4);
  assert.equal(first.altAtClosestFt, 6000);
  assert.equal(first.minAltFt, 3000);
  assert.equal(first.maxAltFt, 12000);
  assert.equal(s.hourly[8], 1);
  assert.equal(s.hourly[9], 3);
  assert.deepEqual(s.busiestHour, { hour: 9, flights: 3 });
  assert.equal(s.airlines[0].label, 'Alaska Airlines');
  assert.equal(s.airlines[0].count, 3);
  assert.equal(s.airlines[0].hourly[9], 2);
  assert.equal(s.types[0].code, 'B739');
  assert.equal(s.topRoutes[0].label, 'SEA → SFO');
  assert.equal(s.notable.closest.minKm, 4);
  assert.equal(s.isToday, true);
});

test('TrafficLog persists days, survives restarts and flags new types', async () => {
  const dir = await tmpDir();
  const a = new TrafficLog({ dataDir: dir, getConfig: () => cfg, log: quietLog });
  a.observe([plane('aaaaaa')], at(10, 0, 1));
  a.observe(
    [plane('cccccc', { typeInfo: { code: 'A388', name: 'Airbus A380-800', category: 'heavy4' } })],
    at(10, 0, 2),
  );
  await a.save();
  const files = (await fs.readdir(path.join(dir, 'traffic'))).sort();
  assert.deepEqual(files, ['2026-10-01.json', '2026-10-02.json']);

  // Restart a few minutes later while cccccc is still around: not a second visit.
  const b = new TrafficLog({ dataDir: dir, getConfig: () => cfg, log: quietLog });
  await b.start(at(10, 5, 2));
  b.observe(
    [plane('cccccc', { typeInfo: { code: 'A388', name: 'Airbus A380-800', category: 'heavy4' } })],
    at(10, 5, 2),
  );
  b.observe([plane('aaaaaa')], at(11, 0, 2));
  const s = await b.summary('2026-10-02', at(12, 0, 2));
  await b.stop();
  assert.equal(s.totals.flights, 2);
  assert.deepEqual(
    s.notable.newTypes.map((v) => v.type),
    ['A388'],
  );
  assert.equal(s.history.at(-2).date, '2026-10-01');
  assert.equal(s.history.at(-2).flights, 1);
  assert.equal(s.averageFlights, 1);
});

test('summarize handles an empty day', () => {
  const s = summarize('2026-10-02', []);
  assert.equal(s.totals.flights, 0);
  assert.equal(s.busiestHour, null);
  assert.equal(s.notable.closest, null);
});

test('home airport: departures by destination, arrivals by origin, diversions', async () => {
  const conf = structuredClone(DEFAULT_CONFIG);
  const yxe = { code: 'YXE', lat: 52.1708, lon: -106.6997, elevationFt: 1653, maxHeightFt: 5000, radiusKm: 30 };
  conf.traffic.airport = yxe;
  const log = new TrafficLog({ dataDir: await tmpDir(), getConfig: () => conf, log: quietLog });
  const near = (km, bearing = 90) => {
    const p = destinationPoint(yxe.lat, yxe.lon, bearing, km * 1000);
    return { lat: p.lat, lon: p.lon };
  };
  const ap = (iata, city) => ({ iata, city });
  const routes = {
    wja: { origin: ap('YXE', 'Saskatoon'), destination: ap('YYC', 'Calgary') },
    aca: { origin: ap('YYZ', 'Toronto'), destination: ap('YXE', 'Saskatoon') },
    over: { origin: ap('YYC', 'Calgary'), destination: ap('YYZ', 'Toronto') },
    stop: {
      origin: ap('YYC', 'Calgary'),
      destination: ap('YYZ', 'Toronto'),
      via: ['YYC', 'YXE', 'YYZ'],
    },
  };
  const pass = (hex, route, points, t0) =>
    points.forEach(([km, altFt], i) => log.observe([plane(hex, { route, altFt, ...near(km) })], t0 + i * 60_000));

  pass(
    'c00001',
    routes.wja,
    [
      [1, 2200],
      [8, 6000],
      [20, 11000],
    ],
    at(8),
  ); // take-off to Calgary
  pass(
    'c00002',
    routes.wja,
    [
      [2, 2400],
      [12, 7000],
    ],
    at(9),
  ); // and another
  pass(
    'c00003',
    routes.aca,
    [
      [25, 9000],
      [5, 3000],
      [1, 2000],
    ],
    at(10),
  ); // landing from Toronto
  pass(
    'c00004',
    routes.over,
    [
      [20, 37000],
      [5, 37000],
    ],
    at(11),
  ); // overflight
  pass(
    'c00005',
    routes.over,
    [
      [30, 9500],
      [10, 5000],
      [3, 2500],
    ],
    at(12),
  ); // came down off-schedule
  pass(
    'c00006',
    null,
    [
      [4, 2800],
      [6, 2900],
    ],
    at(13),
  ); // private, no route
  pass(
    'c00007',
    routes.stop,
    [
      [2, 2300],
      [9, 6500],
    ],
    at(14),
  ); // multi-stop, leaving YXE for YYZ
  pass('c00008', routes.wja, [[45, 2000]], at(15)); // low, but too far away
  pass('c00009', routes.wja, [[5, 9500]], at(16)); // near, but too high (7,850 ft above)

  const s = await log.summary('2026-10-02', at(20));
  const counts = (rows) => Object.fromEntries(rows.map((r) => [r.code, r.count]));
  assert.equal(s.airport.city, 'Saskatoon');
  assert.deepEqual(counts(s.airport.departures), { YYC: 2, YYZ: 1 });
  assert.equal(s.airport.departures[0].label, 'Calgary');
  assert.deepEqual(counts(s.airport.arrivals), { YYZ: 1 });
  assert.deepEqual(s.airport.unrouted, { departure: 0, arrival: 0, low: 1 });
  assert.equal(s.airport.unusual.length, 1);
  assert.equal(s.airport.unusual[0].hex, 'c00005');
  assert.equal(s.airport.unusual[0].movement, 'arrival');
  assert.equal(s.airport.unusual[0].airport.minFt, 2500 - 1653);
  assert.deepEqual(counts(s.airport30.departures), { YYC: 2, YYZ: 1 });

  // Tighter settings apply to what's already recorded.
  conf.traffic.airport = { ...yxe, maxHeightFt: 700 };
  const tight = await log.summary('2026-10-02', at(20));
  assert.deepEqual(counts(tight.airport.departures), { YYC: 1, YYZ: 1 });
  assert.equal(tight.airport.unusual.length, 0);

  // Off: no airport section.
  conf.traffic.airport = { ...yxe, code: '' };
  assert.equal((await log.summary('2026-10-02', at(20))).airport, null);
});

test('airportMovement falls back to climbing/descending without a matching route', () => {
  const apt = { code: 'YXE', maxHeightFt: 5000, radiusKm: 30 };
  const pass = (firstFt, lastFt, minFt = Math.min(firstFt, lastFt)) => ({
    code: 'YXE',
    firstFt,
    lastFt,
    minFt,
    minKm: 3,
  });
  assert.equal(airportMovement({ airport: pass(3000, 400) }, apt).phase, 'arrival');
  assert.equal(airportMovement({ airport: pass(400, 4000) }, apt).phase, 'departure');
  assert.equal(airportMovement({ airport: pass(1500, 1600) }, apt).phase, 'low');
  assert.equal(airportMovement({ airport: pass(1500, 1600) }, apt).scheduled, null);
  assert.equal(airportMovement({ airport: { ...pass(400, 4000), code: 'YYC' } }, apt), null);
  // ICAO codes match too
  const v = { airport: pass(400, 4000), from: { code: 'YXE', icao: 'CYXE' }, to: { code: 'YYC' } };
  assert.equal(airportMovement(v, { ...apt, code: 'CYXE' }), null); // recorded under YXE
  assert.deepEqual(airportMovement(v, apt), { phase: 'departure', other: { code: 'YYC' }, scheduled: true });
});
