import test from 'node:test';
import assert from 'node:assert/strict';
import { checks, coverageOf, dataBase, radioNumbers, RfMonitor, verdict } from '../server/rf.js';
import { fakeFetch, quietLog, tmpDir } from './helpers.js';
import { DEFAULT_CONFIG, mergeConfig } from '../server/config.js';

// readsb stats.json from the Pi with the rain-damaged antenna (trimmed).
const STATS = {
  now: 1791496915.0,
  gain_db: 36.4,
  estimated_ppm: 32.8,
  aircraft_with_pos: 5,
  last1min: {
    start: 1791496855.0,
    end: 1791496915.0,
    local: {
      samples_dropped: 0,
      samples_lost: 0,
      modes: 2036578,
      bad: 1481711,
      accepted: [647, 155],
      signal: -16.0,
      noise: -30.9,
      peak_signal: -8.4,
      strong_signals: 0,
    },
    messages_valid: 802,
    position_count_total: 177,
    max_distance: 143246,
  },
  last15min: {
    start: 1791496015.0,
    end: 1791496915.0,
    local: {
      samples_dropped: 0,
      samples_lost: 0,
      modes: 30629262,
      bad: 22298537,
      signal: -15.4,
      noise: -30.8,
      peak_signal: -8.2,
      strong_signals: 0,
    },
    messages_valid: 5202,
    position_count_total: 1393,
    max_distance: 170000,
  },
};

test('the Pi’s data folder comes from its aircraft.json URL', () => {
  assert.equal(dataBase('http://192.168.1.199:8080/data/aircraft.json'), 'http://192.168.1.199:8080/data/');
  assert.equal(dataBase('http://pi/tar1090/data/aircraft.json?x=1'), 'http://pi/tar1090/data/');
  assert.equal(dataBase('http://pi/something.json'), null);
});

test('readsb stats become the numbers that matter', () => {
  const n = radioNumbers(STATS, 'last1min');
  assert.equal(n.msgsPerSec, 13.4);
  assert.equal(n.noiseDb, -30.9);
  assert.equal(n.snrDb, 14.9);
  assert.equal(n.strongPct, 0);
  assert.equal(n.badPct, 72.8);
  assert.equal(n.maxRangeKm, 143.2);
  assert.equal(n.ppm, 32.8);
  assert.equal(radioNumbers(STATS, 'last5min'), null);
});

test('coverage by distance: what the antenna heard of what was there', () => {
  const c = coverageOf([
    { via: 'antenna', distanceKm: 10, altFt: 30000 },
    { via: 'online', distanceKm: 40, altFt: 6000 },
    { via: 'online', distanceKm: 120, altFt: 36000 },
    { via: 'antenna', distanceKm: 160, altFt: 37000 },
    { via: 'online', distanceKm: 190, altFt: 38000 },
    { via: 'antenna', distanceKm: 5, onGround: true },
    { via: null, distanceKm: 20 }, // simulator: no source
  ]);
  assert.deepEqual(
    c.bands.map((b) => [b.heard, b.total]),
    [
      [1, 2],
      [0, 0],
      [0, 1],
      [1, 2],
      [0, 0],
    ],
  );
  assert.equal(c.farthestHeard, 160);
  assert.equal(c.farthestThere, 190);
});

test('a receiver missing most planes past 100 km gets a poor verdict, with reasons', () => {
  const coverage = {
    bands: [
      { heard: 30, total: 32 },
      { heard: 20, total: 36 },
      { heard: 6, total: 60 },
      { heard: 0, total: 70 },
      { heard: 0, total: 0 },
    ],
    farthestHeard: 143,
    farthestThere: 199,
  };
  const list = checks({ now: radioNumbers(STATS, 'last15min'), coverage, merged: true });
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(byId['coverage-near'].status, 'warn'); // 50 of 68
  assert.equal(byId['coverage-far'].status, 'bad'); // 6 of 130
  assert.match(byId['coverage-far'].advice, /coax/);
  assert.equal(byId.range.status, 'warn'); // 143 of 199 km
  assert.equal(byId.overload.status, 'ok');
  assert.equal(byId.ppm.status, 'warn');
  assert.equal(byId.snr.status, 'ok');
  assert.equal(verdict(list), 'poor');
});

test('a healthy receiver gets a good verdict', () => {
  const healthy = {
    ...radioNumbers(STATS, 'last15min'),
    ppm: 0.4,
    strongPct: 1.2,
  };
  const coverage = {
    bands: [
      { heard: 40, total: 41 },
      { heard: 50, total: 52 },
      { heard: 45, total: 50 },
      { heard: 40, total: 55 },
      { heard: 0, total: 0 },
    ],
    farthestHeard: 198,
    farthestThere: 199,
  };
  const list = checks({ now: healthy, coverage, merged: true });
  assert.equal(verdict(list), 'good', JSON.stringify(list.filter((c) => c.status !== 'ok' && c.status !== 'info')));
});

test('overload and a maxed-out gain are called out', () => {
  const loud = checks({ now: { ...radioNumbers(STATS, 'last15min'), strongPct: 12 }, coverage: null, merged: false });
  assert.equal(loud.find((c) => c.id === 'overload').status, 'bad');
  assert.equal(loud.find((c) => c.id === 'coverage').status, 'info', 'no online feed to compare with');
  const deaf = checks({
    now: { ...radioNumbers(STATS, 'last15min'), gainDb: 49.6, peakDb: -14 },
    coverage: null,
    merged: false,
  });
  assert.equal(deaf.find((c) => c.id === 'gain-max').status, 'bad');
});

test('the RF monitor samples the Pi every minute and reports', async () => {
  const dir = await tmpDir();
  const config = mergeConfig(DEFAULT_CONFIG, {
    receiver: { lat: 52.1158, lon: -106.5613 },
    source: { type: 'aircraft-json', url: 'http://pi.test/data/aircraft.json', supplement: true },
  }).config;
  const fetchImpl = fakeFetch([
    ['http://pi.test/data/stats.json', () => ({ body: STATS })],
    [
      'http://pi.test/data/outline.json',
      () => ({
        body: {
          actualRange: {
            last24h: {
              points: [
                [53.0, -106.56, 35000],
                [52.1158, -104.5, 37000],
              ],
            },
          },
        },
      }),
    ],
  ]);
  const planes = [
    { hex: 'a', via: 'antenna', distanceKm: 30, rssi: -14, altFt: 33000, lat: 52.4, lon: -106.5, callsign: 'WJA1' },
    { hex: 'b', via: 'online', distanceKm: 160, rssi: null, altFt: 37000, lat: 53.5, lon: -106.5, callsign: 'ACA2' },
  ];
  const tracker = { snapshot: () => planes };
  const rf = new RfMonitor({ dataDir: dir, getConfig: () => config, tracker, log: quietLog, fetchImpl });
  const entry = await rf.sample(Date.now());
  assert.equal(entry.msgsPerSec, 13.4);
  assert.deepEqual(entry.bands[0], [1, 1]);
  const report = await rf.report();
  assert.equal(report.available, true);
  assert.equal(report.graphsUrl, 'http://pi.test/graphs1090/');
  assert.equal(report.numbers.msgsPerSec, 5.8, '15-minute window');
  assert.deepEqual(report.outline[0], [0, 98.3], 'north, 98 km');
  assert.deepEqual(report.signal, [[30, -14]], 'only planes the antenna heard');
  assert.deepEqual(
    report.planes.map((p) => [p.label, p.heard]),
    [
      ['WJA1', true],
      ['ACA2', false],
    ],
  );
  assert.equal(report.history.length, 1);
  await rf.stop();

  const sim = new RfMonitor({ dataDir: dir, getConfig: () => DEFAULT_CONFIG, tracker, log: quietLog, fetchImpl });
  const off = await sim.report();
  assert.equal(off.available, false);
  assert.match(off.reason, /My receiver/);
});
