import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { explore, MAX_GROUPS } from '../server/traffic-explore.js';
import { dimKey, dimLabel } from '../shared/traffic-dims.js';
import { TrafficLog, dayKey, addDays } from '../server/traffic.js';
import { DEFAULT_CONFIG } from '../server/config.js';
import { quietLog, tmpDir } from './helpers.js';

const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime(); // October 2026, local time
const V = (o) => ({ hex: o.hex ?? Math.random().toString(16).slice(2, 8), first: o.t, last: o.t + 600_000, ...o });

const visits = [
  V({
    hex: 'c00001',
    t: at(8, 9),
    day: '2026-10-08',
    callsign: 'WJA344',
    airline: { icao: 'WJA', name: 'WestJet' },
    type: 'B737',
    typeName: 'Boeing 737-700',
    category: 'narrowbody',
    from: { code: 'YYC', city: 'Calgary' },
    to: { code: 'YXE', city: 'Saskatoon' },
    minKm: 4,
    altAtClosestFt: 3000,
    maxGsKt: 250,
    overhead: true,
    antenna: true,
  }),
  V({
    hex: 'c00001',
    t: at(9, 18),
    day: '2026-10-09',
    callsign: 'WJA345',
    airline: { icao: 'WJA', name: 'WestJet' },
    type: 'B737',
    typeName: 'Boeing 737-700',
    category: 'narrowbody',
    from: { code: 'YXE' },
    to: { code: 'YYC' },
    minKm: 12,
    altAtClosestFt: 9000,
    maxGsKt: 320,
    overhead: true,
    antenna: true,
  }),
  V({
    hex: 'c00002',
    t: at(9, 18, 30),
    day: '2026-10-09',
    callsign: 'ACA1108',
    airline: { icao: 'ACA', name: 'Air Canada' },
    type: 'BCS3',
    typeName: 'Airbus A220-300',
    category: 'narrowbody',
    minKm: 80,
    altAtClosestFt: 36000,
    maxGsKt: 480,
    online: true,
  }),
  V({
    hex: 'c00003',
    t: at(9, 7),
    day: '2026-10-09',
    callsign: 'CGKRO',
    reg: 'C-GKRO',
    type: 'C172',
    typeName: 'Cessna 172 Skyhawk',
    category: 'light',
    minKm: 2,
    altAtClosestFt: 1500,
    maxGsKt: 100,
    overhead: true,
    antenna: true,
  }),
  V({
    hex: 'c00004',
    t: at(9, 7, 15),
    day: '2026-10-09',
    callsign: 'FDX1980',
    airline: { icao: 'FDX', name: 'FedEx' },
    cargo: true,
    type: 'B77L',
    typeName: 'Boeing 777F',
    category: 'widebody',
    minKm: 150,
    altAtClosestFt: 41000,
    maxGsKt: 520,
    online: true,
  }),
];
const dates = ['2026-10-08', '2026-10-09'];

test('flights are grouped by any dimension, biggest first', () => {
  const r = explore(visits, { group: 'airline', dates });
  assert.deepEqual(
    r.groups.map((g) => [g.label, g.flights, g.aircraft]),
    [
      ['WestJet', 2, 1],
      ['Air Canada', 1, 1],
      ['FedEx', 1, 1],
      ['No airline', 1, 1],
    ],
  );
  assert.equal(r.totals.flights, 5);
  assert.equal(r.totals.aircraft, 4);
  assert.equal(r.totals.antenna, 3);
  assert.equal(r.totals.withinCardRange, 3);
  // Counting different aircraft instead.
  assert.equal(explore(visits, { group: 'airline', measure: 'aircraft', dates }).total, 4);
});

test('hours, weekdays and bands keep their natural order, empty steps included', () => {
  const byHour = explore(visits, { group: 'hour', dates });
  assert.equal(byHour.groups.length, 24);
  assert.equal(byHour.groups[7].flights, 2);
  assert.equal(byHour.groups[18].flights, 2);
  assert.equal(byHour.groups[7].label, '7 AM');
  const byAlt = explore(visits, { group: 'altitude', dates });
  assert.deepEqual(
    byAlt.groups.map((g) => g.flights),
    [2, 1, 0, 0, 1, 1],
  );
  assert.equal(dimLabel('altitude', '0', { units: 'imperial' }), 'Under 5,000 ft');
  assert.equal(dimLabel('distance', '6', { units: 'metric' }), '200 km and up');
  assert.equal(dimLabel('who', dimKey('who', visits[4])), 'Cargo');
  assert.equal(dimLabel('source', dimKey('source', visits[2])), 'Online feed only');
});

test('filters and search narrow everything at once', () => {
  const r = explore(visits, { group: 'type', filters: { who: ['airline', 'cargo'], source: ['online'] }, dates });
  assert.deepEqual(
    r.groups.map((g) => g.label),
    ['Airbus A220-300', 'Boeing 777F'],
  );
  assert.equal(r.flights.length, 2);
  assert.equal(r.trend.points.find((p) => p.key === '2026-10-09').flights, 2);
  const q = explore(visits, { group: 'route', q: 'calgary', dates });
  assert.deepEqual(
    q.groups.map((g) => g.label),
    ['YYC → YXE'],
  );
  // '' is the "unknown" key: flights without a route.
  const noRoute = explore(visits, { group: 'type', filters: { route: [''] }, dates });
  assert.equal(noRoute.totals.flights, 3);
});

test('the long tail is folded into Other; trend, grid and spreads come along', () => {
  const many = Array.from({ length: MAX_GROUPS + 5 }, (_, i) =>
    V({ t: at(9, 12), day: '2026-10-09', type: `T${i}`, typeName: `Type ${i}`, minKm: 30, altAtClosestFt: 25000 }),
  );
  const r = explore(many, { group: 'type', dates });
  assert.equal(r.groups.length, MAX_GROUPS);
  assert.deepEqual(r.other, { groups: 5, flights: 5, aircraft: 5 });
  assert.equal(r.trend.unit, 'day');
  assert.equal(r.heat[4][12], MAX_GROUPS + 5, 'Friday at noon');
  assert.equal(r.altitude.counts[3], MAX_GROUPS + 5);
  assert.equal(r.distance.counts[3], MAX_GROUPS + 5);
  assert.equal(explore(many, { group: 'type', dates: ['2026-10-09'] }).trend.unit, 'hour');
});

test('the traffic log explores its day files', async () => {
  const dir = await tmpDir();
  const now = at(9, 20);
  const traffic = new TrafficLog({ dataDir: dir, getConfig: () => DEFAULT_CONFIG, log: quietLog });
  await fs.mkdir(path.join(dir, 'traffic'), { recursive: true });
  for (const date of dates) {
    const day = visits.filter((v) => v.day === date).map(({ day, ...v }) => v);
    await fs.writeFile(path.join(dir, 'traffic', `${date}.json`), JSON.stringify({ date, visits: day }));
  }
  const r = await traffic.explore({ from: '2026-10-01', to: '2026-10-09', group: 'airline' }, {}, now);
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.to, '2026-10-09');
  assert.equal(r.trend.points.length, 9);
  assert.equal(r.totals.flights, 5);
  // At most 90 days.
  const long = await traffic.explore({ from: '2026-01-01', to: '2026-10-09', group: 'airline' }, {}, now);
  assert.equal(long.from, addDays('2026-10-09', -89));
  assert.equal(dayKey(now), '2026-10-09');
  const day = JSON.parse(await fs.readFile(path.join(dir, 'traffic', '2026-10-09.json'), 'utf8'));
  assert.equal(day.visits[0].day, undefined, 'files untouched');
});
