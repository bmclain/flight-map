import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigStore, DEFAULT_CONFIG, mergeConfig } from '../server/config.js';
import { Tracker } from '../server/tracker.js';
import { App } from '../server/app.js';
import { createHttpServer } from '../server/http.js';
import { parseAircraftJson } from '../server/sources/parse.js';
import { destinationPoint } from '../shared/geo.js';
import { fakeFetch, quietLog, sleep, tmpDir, waitFor } from './helpers.js';

// ---- config -------------------------------------------------------------------------

test('mergeConfig keeps valid fields and reports invalid ones', () => {
  const { config, errors } = mergeConfig(DEFAULT_CONFIG, {
    display: { cycleSeconds: '12', facingDeg: 400, units: 'furlongs', spotlight: { enabled: true } },
    receiver: { lat: 51.5 },
    unknownSection: { x: 1 },
  });
  assert.equal(config.display.cycleSeconds, 12);
  assert.equal(config.display.facingDeg, DEFAULT_CONFIG.display.facingDeg);
  assert.equal(config.display.units, DEFAULT_CONFIG.display.units);
  assert.equal(config.display.spotlight.enabled, true);
  assert.equal(config.display.spotlight.rangeKm, DEFAULT_CONFIG.display.spotlight.rangeKm);
  assert.equal(config.receiver.lat, 51.5);
  assert.equal(config.unknownSection, undefined);
  assert.deepEqual(errors.map((e) => e.field).sort(), ['display.facingDeg', 'display.units']);
});

test('mergeConfig cross-field checks', () => {
  const { errors } = mergeConfig(DEFAULT_CONFIG, {
    display: { minAltitudeFt: 20000, maxAltitudeFt: 10000 },
    map: { tiles: 'custom', customTileUrl: 'not a url' },
  });
  assert.deepEqual(errors.map((e) => e.field).sort(), ['display.minAltitudeFt', 'map.customTileUrl']);
});

test('ConfigStore seeds from the environment on first run and persists updates', async () => {
  const dir = await tmpDir();
  const store = new ConfigStore(dir, {
    env: { RECEIVER_LAT: '51.47', RECEIVER_LON: '-0.45', SOURCE_URL: 'http://pi.local/tar1090/data/aircraft.json' },
    log: quietLog,
  });
  const cfg = await store.load();
  assert.equal(cfg.receiver.lat, 51.47);
  assert.equal(cfg.source.type, 'aircraft-json');
  let changed = null;
  store.onChange((next) => (changed = next));
  await store.update({ display: { facingDeg: 135 } });
  assert.equal(changed.display.facingDeg, 135);
  await assert.rejects(
    store.update({ display: { cycleSeconds: 1 } }),
    (err) => err.errors?.[0]?.field === 'display.cycleSeconds',
  );
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.display.facingDeg, 135);
  assert.equal(onDisk.display.cycleSeconds, DEFAULT_CONFIG.display.cycleSeconds);
  // env only applies on first run
  const again = new ConfigStore(dir, { env: { RECEIVER_LAT: '10' }, log: quietLog });
  assert.equal((await again.load()).receiver.lat, 51.47);
});

// ---- tracker ----------------------------------------------------------------------------

test('Tracker computes geometry, filters by range and keeps trails', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const { lat, lon } = cfg.receiver;
  const near = destinationPoint(lat, lon, 90, 5000);
  const far = destinationPoint(lat, lon, 0, 200_000);
  const tracker = new Tracker({ getConfig: () => cfg });
  const frame = (p, seenPos = 0.5) =>
    parseAircraftJson({
      aircraft: [
        {
          hex: 'aaaaaa',
          lat: p.lat,
          lon: p.lon,
          alt_baro: 5000,
          alt_geom: 5000,
          seen: 0.1,
          seen_pos: seenPos,
          track: 270,
        },
        { hex: 'bbbbbb', lat: far.lat, lon: far.lon, alt_baro: 30000, seen: 0.1, seen_pos: 0.1 },
        { hex: 'cccccc', alt_baro: 30000, seen: 0.1 },
      ],
    });
  tracker.ingest(frame(near), 0);
  const moved = destinationPoint(lat, lon, 90, 4000);
  tracker.ingest(frame(moved), 5000);
  const snap = tracker.snapshot({ trails: true, now: 5000 });
  assert.equal(snap.length, 1);
  const a = snap[0];
  assert.equal(a.hex, 'aaaaaa');
  assert.ok(Math.abs(a.distanceKm - 4) < 0.01);
  assert.ok(Math.abs(a.bearingDeg - 90) < 0.5);
  // 5000 ft (≈1524 m) above a receiver at 30 m, 4 km away ≈ 20.5°
  assert.ok(Math.abs(a.elevationDeg - 20.5) < 0.5, `elevation ${a.elevationDeg}`);
  assert.equal(a.trail.length, 2);
  // stale positions are dropped
  tracker.ingest(frame(moved, 90), 10_000);
  assert.equal(tracker.snapshot({ now: 10_000 }).length, 0);
});

// ---- HTTP API ------------------------------------------------------------------------------

async function startServer(t, { adminPassword = '' } = {}) {
  const dataDir = await tmpDir();
  const fetchImpl = fakeFetch([
    [
      'http://pi.test/aircraft.json',
      () => ({
        body: {
          now: Date.now() / 1000,
          aircraft: [{ hex: 'a00001', lat: 47.6, lon: -122.3, alt_baro: 3000, seen: 0 }],
        },
      }),
    ],
  ]);
  const app = new App({ dataDir, log: quietLog, env: {}, fetchImpl });
  await app.start({ loadDatabases: false });
  const server = createHttpServer(app, { adminPassword });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    server.close();
    await app.stop();
  });
  return { app, base, dataDir };
}

test('API: config, aircraft, status, static files', async (t) => {
  const { base } = await startServer(t);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.config.source.type, 'simulator');
  assert.equal(cfg.authRequired, false);

  let res = await fetch(`${base}/api/config`, {
    method: 'PUT',
    body: JSON.stringify({ display: { cycleSeconds: 1 } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors[0].field, 'display.cycleSeconds');

  res = await fetch(`${base}/api/config`, { method: 'PUT', body: JSON.stringify({ display: { cycleSeconds: 8 } }) });
  assert.equal((await res.json()).config.display.cycleSeconds, 8);

  const ac = await (await fetch(`${base}/api/aircraft?trails`)).json();
  assert.ok(ac.aircraft.length > 0, 'simulator traffic is visible');
  assert.ok(Array.isArray(ac.aircraft[0].trail));

  const hex = ac.aircraft[0].hex;
  assert.equal((await fetch(`${base}/api/aircraft/${hex}/lookup`, { method: 'POST' })).status, 202);
  assert.equal((await fetch(`${base}/api/aircraft/000000/lookup`, { method: 'POST' })).status, 404);

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.source.type, 'simulator');

  res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  for (const p of [
    '/display',
    '/admin',
    '/js/display.js',
    '/shared/cycler.js',
    '/css/display.css',
    '/vendor/leaflet/leaflet.css',
    '/manifest.webmanifest',
  ]) {
    res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
  res = await fetch(`${base}/vendor/fonts/inter/inter-latin-400-normal.woff2`);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
  for (const p of ['/js/..%2f..%2fpackage.json', '/shared/../server/config.js', '/images/airframes/..%2fconfig.json']) {
    res = await fetch(base + p);
    assert.equal(res.status, 404, p);
  }
});

test('API: switching to a receiver URL and testing the connection', async (t) => {
  const { app, base } = await startServer(t);
  // Simulated traffic is shown but never written to the daily traffic log.
  await waitFor(() => app.tracker.snapshot().length > 1);
  await sleep(1200);
  assert.equal(app.traffic.status().today, 0);
  const test1 = await (
    await fetch(`${base}/api/source/test`, {
      method: 'POST',
      body: JSON.stringify({ type: 'aircraft-json', url: 'http://pi.test/aircraft.json' }),
    })
  ).json();
  assert.deepEqual(
    { ok: test1.ok, aircraft: test1.aircraft, withPosition: test1.withPosition },
    { ok: true, aircraft: 1, withPosition: 1 },
  );
  const bad = await (
    await fetch(`${base}/api/source/test`, {
      method: 'POST',
      body: JSON.stringify({ type: 'aircraft-json', url: 'http://nope.test/x' }),
    })
  ).json();
  assert.equal(bad.ok, false);

  await fetch(`${base}/api/config`, {
    method: 'PUT',
    body: JSON.stringify({ source: { type: 'aircraft-json', url: 'http://pi.test/aircraft.json' } }),
  });
  assert.equal(app.source.type, 'aircraft-json');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(app.status().source.positionCount, 1);
  // The simulated planes are dropped straight away, and real ones are logged.
  assert.deepEqual(
    app.tracker.snapshot().map((a) => a.hex),
    ['a00001'],
  );
  await waitFor(() => app.traffic.status().today === 1, { timeoutMs: 3000 });
});

test('API: admin password protects changes', async (t) => {
  const { base } = await startServer(t, { adminPassword: 's3cret' });
  const body = JSON.stringify({ display: { facingDeg: 90 } });
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', body })).status, 401);
  assert.equal(
    (await fetch(`${base}/api/config`, { method: 'PUT', body, headers: { authorization: 'Bearer wrong!' } })).status,
    401,
  );
  const ok = await fetch(`${base}/api/config`, { method: 'PUT', body, headers: { authorization: 'Bearer s3cret' } });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/api/config`)).status, 200, 'reading stays open for displays');
});

test('API: live stream sends hello, aircraft and config events', async (t) => {
  const { base } = await startServer(t);
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (re) => {
    while (!re.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      text += decoder.decode(value);
    }
  };
  await until(/event: hello\ndata: /);
  await until(/event: aircraft\ndata: /);
  await fetch(`${base}/api/config`, { method: 'PUT', body: JSON.stringify({ display: { facingDeg: 45 } }) });
  await until(/event: config\ndata: .*"facingDeg":45/);
  const hello = JSON.parse(/event: hello\ndata: (.*)\n/.exec(text)[1]);
  assert.ok(hello.bootId);
  assert.ok(Array.isArray(hello.aircraft));
  controller.abort();
});
