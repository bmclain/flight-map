import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { addTrackPoint, trackSince, TRACK_KEEP_MS } from '../shared/track.js';
import { destinationPoint } from '../shared/geo.js';
import { altitudeColor, altitudeHue } from '../shared/altitude-colors.js';
import { currentFlight, FlightTracks, mergeTraces, parseTrace, thinTrack } from '../server/enrich/flighttrack.js';
import { DEFAULT_CONFIG } from '../server/config.js';
import { Tracker } from '../server/tracker.js';
import { parseAircraftJson } from '../server/sources/parse.js';
import { fakeFetch, quietLog, tmpDir } from './helpers.js';

// ---- tracks -----------------------------------------------------------------------------

/** Fly from (lat, lon) for `seconds` at 250 m/s, turning `turnDegPerS`, a point every 4 s. */
function fly(track, { lat = 52, lon = -106, heading = 90, seconds = 600, turnDegPerS = 0, t0 = 0 } = {}) {
  let p = { lat, lon };
  for (let s = 0; s <= seconds; s += 4) {
    addTrackPoint(track, p.lat, p.lon, t0 + s * 1000);
    p = destinationPoint(p.lat, p.lon, heading, 1000);
    heading += turnDegPerS * 4;
  }
  return p;
}

test('straight flight is stored as a few points, turns keep their shape', () => {
  const straight = [];
  fly(straight, { seconds: 600 });
  // 150 positions over 10 minutes; straight runs are cut every 2 minutes.
  assert.ok(straight.length <= 7, `${straight.length} points`);
  assert.equal(straight[straight.length - 1][2], 600_000);

  const turning = [];
  fly(turning, { seconds: 360, turnDegPerS: 0.5 });
  // A 180° turn needs many points to look round, but fewer than one per position.
  assert.ok(turning.length > 30 && turning.length < 90, `${turning.length} points`);
});

test('tracks skip points that are too soon or too close, and forget old ones', () => {
  const track = [];
  assert.equal(addTrackPoint(track, 52, -106, 0), true);
  assert.equal(addTrackPoint(track, 52.1, -106, 1000), false); // too soon
  assert.equal(addTrackPoint(track, 52.00001, -106, 8000), false); // hasn't moved
  fly(track, { t0: 10_000, seconds: 60, heading: 0 });
  fly(track, { t0: TRACK_KEEP_MS + 60_000, seconds: 60, heading: 180 });
  assert.ok(track[0][2] >= 60_000, 'points older than the keep window are dropped');
});

test('trackSince starts just before the cut-off so the line reaches back to it', () => {
  const track = [
    [52, -106, 0],
    [52, -105.9, 60_000],
    [52, -105.8, 120_000],
  ];
  assert.deepEqual(
    trackSince(track, 90_000).map((p) => p[2]),
    [60_000, 120_000],
  );
  assert.equal(trackSince(track, 0).length, 3);
});

test('Tracker keeps the whole track (not just the trail shown) and restores it after a restart', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.map.trailMinutes = 1;
  const tracker = new Tracker({ getConfig: () => cfg });
  const frame = (p) =>
    parseAircraftJson({
      aircraft: [{ hex: 'aaaaaa', lat: p.lat, lon: p.lon, alt_baro: 9000, seen: 0, seen_pos: 0, track: 0 }],
    });
  let p = { lat: cfg.receiver.lat, lon: cfg.receiver.lon };
  for (let s = 0; s <= 600; s += 5) {
    tracker.ingest(frame(p), s * 1000);
    // zig-zag so every point is kept
    p = destinationPoint(p.lat, p.lon, s % 10 ? 30 : 330, 300);
  }
  const trail = tracker.snapshot({ trails: true, now: 600_000 })[0].trail;
  assert.equal(trail[0][2], 0, 'ten minutes kept although the map shows one');

  const file = path.join(await tmpDir(), 'tracks.json');
  await tracker.saveTracks(file, 600_000);
  const after = new Tracker({ getConfig: () => cfg });
  assert.equal(await after.loadTracks(file, 660_000), 1);
  after.ingest(frame(p), 661_000);
  const restored = after.snapshot({ trails: true, now: 661_000 })[0];
  assert.equal(restored.firstSeen, 0);
  assert.equal(restored.trail.length, trail.length + 1);
  // Too old to be useful: ignored.
  assert.equal(await new Tracker({ getConfig: () => cfg }).loadTracks(file, 600_000 + 3600_000), 0);
});

// ---- flight tracks (adsb.lol) ---------------------------------------------------------------

// A freighter that flew Japan → Anchorage, sat on the ground, then took off for Chicago.
const BASE = 1_791_000_000;
const TRACE_FULL = {
  icao: '780da8',
  timestamp: BASE,
  trace: [
    [0, 35.5, 133.0, 31000, 480, 45, 0, 0, null],
    [3600, 45.0, 160.0, 33000, 480, 45, 0, 0, null],
    [20000, 61.17, -150.0, 'ground', 10, 0, 2, null, null],
    [21000, 61.18, -149.99, 'ground', 140, 0, 0, null, null],
    [21100, 61.3, -149.5, 4000, 200, 60, 0, 2000, null],
    [24000, 58.0, -125.0, 33000, 480, 110, 0, 0, null],
  ],
};
const TRACE_RECENT = {
  icao: '780da8',
  timestamp: BASE + 23000,
  trace: [
    [1000, 58.0, -125.0, 33000, 480, 110, 0, 0, null],
    [2000, 56.0, -118.0, 33000, 480, 110, 0, 0, null],
    [2003, 56.0, -118.001, 33000, 480, 110, 0, 0, null],
  ],
};

test('the current flight starts at the last take-off', () => {
  const merged = mergeTraces(parseTrace(TRACE_FULL), parseTrace(TRACE_RECENT));
  assert.equal(merged.length, 8);
  const flight = currentFlight(merged);
  assert.deepEqual([flight[0].lat, flight[0].lon], [61.18, -149.99]);
  assert.equal(flight[flight.length - 1].lat, 56.0);
  assert.deepEqual(thinTrack(flight)[4], [56, -118.001, (BASE + 25003) * 1000, 33000]);
  assert.equal(thinTrack(flight)[0][3], 0, 'on the ground at Anchorage');
  assert.deepEqual(parseTrace({ nope: 1 }), []);
});

test('flight tracks drop points within 500 m of the last one kept, but keep the end', () => {
  const pt = (lat, lon, t) => ({ lat, lon, t, alt: null });
  const thin = thinTrack([
    pt(56, -118, 0),
    pt(56, -118.001, 1),
    pt(56.003, -118, 2),
    pt(57, -118, 3),
    pt(57, -118.0001, 4),
  ]);
  assert.deepEqual(
    thin.map((p) => p[2]),
    [0, 3, 4],
  );
});

test('FlightTracks fetches both trace files once and caches the result', async () => {
  const fetchImpl = fakeFetch([
    ['https://adsb.lol/data/traces/a8/trace_full_780da8.json', () => ({ body: TRACE_FULL })],
    ['https://adsb.lol/data/traces/a8/trace_recent_780da8.json', () => ({ body: TRACE_RECENT })],
    ['https://adsb.lol/data/traces/', () => ({ status: 404, body: {} })],
  ]);
  const cfg = structuredClone(DEFAULT_CONFIG);
  const tracks = new FlightTracks({ getConfig: () => cfg, log: quietLog, fetchImpl });
  const [a, b] = await Promise.all([tracks.get('780da8'), tracks.get('780da8')]);
  assert.equal(a, b);
  assert.equal(a.source, 'adsb.lol');
  assert.deepEqual(a.points[0].slice(0, 2), [61.18, -149.99]);
  await tracks.get('780da8');
  assert.equal(fetchImpl.calls.length, 2);

  assert.equal(await tracks.get('c0ffee'), null, 'unknown to adsb.lol');
  cfg.enrichment.flightTracks = false;
  assert.equal(await tracks.get('780da8'), null, 'turned off in Settings');
});

test('track points carry altitude, and a climb keeps enough points to colour it', () => {
  const track = [];
  let p = { lat: 52, lon: -106 };
  // Straight ahead for two minutes, climbing 2,000 ft a minute.
  for (let s = 0; s <= 120; s += 4) {
    addTrackPoint(track, p.lat, p.lon, s * 1000, 3000 + (s / 60) * 2000);
    p = destinationPoint(p.lat, p.lon, 90, 600);
  }
  assert.ok(track.length >= 4, `${track.length} points`);
  assert.equal(track[track.length - 1][3], 7000);
  for (let i = 1; i < track.length; i++) assert.ok(track[i][3] - track[i - 1][3] <= 1200);
});

test('altitude colours run orange, yellow, green, blue to purple', () => {
  const hue = (ft) => altitudeHue(ft);
  assert.equal(hue(0), 20);
  assert.ok(hue(5000) > 40 && hue(5000) < 60, 'yellow at 5,000 ft');
  assert.ok(hue(11000) === 140, 'green at 11,000 ft');
  assert.equal(hue(40000), 300);
  assert.equal(hue(45000), 300);
  assert.equal(altitudeColor(12000, 'dark'), altitudeColor(12100, 'dark'), '500 ft steps');
  assert.notEqual(altitudeColor(30000, 'dark'), altitudeColor(30000, 'light'));
  assert.match(altitudeColor(null), /^#[0-9a-f]{6}$/);
});
