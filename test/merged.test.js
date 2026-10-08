import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAircraft, MergedSource } from '../server/sources/merged.js';
import { fakeFetch, quietLog, waitFor } from './helpers.js';

const ac = (hex, extra = {}) => ({ hex, lat: 52, lon: -106, seen: 0.5, seenPos: 0.5, ...extra });

test('the antenna’s planes are kept; the online feed fills in the rest', () => {
  const now = 100_000;
  const local = { at: now, data: { aircraft: [ac('aaaaaa'), ac('bbbbbb', { lat: null, lon: null, seenPos: null })] } };
  const online = {
    at: now - 4000, // fetched 4 s ago
    data: { aircraft: [ac('aaaaaa', { seenPos: 1 }), ac('bbbbbb', { seenPos: 2 }), ac('cccccc', { seenPos: 3 })] },
  };
  const merged = Object.fromEntries(mergeAircraft(local, online, now).map((a) => [a.hex, a]));
  assert.equal(merged.aaaaaa.via, 'antenna', 'heard with a position: the antenna’s');
  assert.equal(merged.aaaaaa.seenPos, 0.5);
  assert.equal(merged.bbbbbb.via, 'online', 'heard but no position: the online one');
  assert.equal(merged.bbbbbb.heardByAntenna, true);
  assert.equal(merged.cccccc.via, 'online');
  assert.equal(merged.cccccc.seenPos, 7, 'aged by the time since it was fetched');
  assert.equal(mergeAircraft(local, null, now).length, 2, 'no online data: just the antenna');
});

test('a stale antenna position gives way to a fresher online one', () => {
  const now = 100_000;
  const local = { at: now, data: { aircraft: [ac('aaaaaa', { seenPos: 40 })] } };
  const online = { at: now, data: { aircraft: [ac('aaaaaa', { seenPos: 1, lat: 53 })] } };
  const [only] = mergeAircraft(local, online, now);
  assert.equal(only.via, 'online');
  assert.equal(only.lat, 53);
});

test('the merged source polls both and keeps going on the online feed when the antenna drops out', async () => {
  let antennaUp = true;
  const fetchImpl = fakeFetch([
    [
      'http://pi.local',
      () =>
        antennaUp
          ? { body: { now: 1, messages: 100, aircraft: [{ hex: 'aaaaaa', lat: 52, lon: -106, seen: 0, seen_pos: 0 }] } }
          : { status: 503 },
    ],
    [
      'https://api.example',
      () => ({
        body: {
          now: Date.now(),
          ac: [
            { hex: 'aaaaaa', lat: 52, lon: -106, seen: 1, seen_pos: 1 },
            { hex: 'cccccc', lat: 53, lon: -107, seen: 1, seen_pos: 1 },
          ],
        },
      }),
    ],
  ]);
  const batches = [];
  const src = new MergedSource({
    url: () => 'http://pi.local/data/aircraft.json',
    onlineUrl: () => 'https://api.example/v2/point',
    pollSeconds: 0.5,
    onlineSeconds: 5,
    onData: (d) => batches.push(d),
    log: quietLog,
    fetchImpl,
  });
  src.start();
  try {
    const both = await waitFor(() => batches.find((b) => b.aircraft.length === 2));
    assert.deepEqual(both.aircraft.map((a) => [a.hex, a.via]).sort(), [
      ['aaaaaa', 'antenna'],
      ['cccccc', 'online'],
    ]);
    const st = src.status();
    assert.equal(st.type, 'merged');
    assert.equal(st.antenna.ok, true);
    assert.equal(st.online.ok, true);
    // The online feed is polled far less often than the antenna.
    const calls = (prefix) => fetchImpl.calls.filter((c) => c.url.startsWith(prefix)).length;
    assert.ok(calls('http://pi.local') > calls('https://api.example'));

    // Test connection reports both.
    const tested = await src.pollOnce();
    assert.equal(tested.online.aircraft.length, 2);

    antennaUp = false;
    await waitFor(() => src.status().antenna.lastError);
    assert.equal(src.status().lastError, null, 'not an error for the display while the online feed works');
  } finally {
    src.stop();
  }
});
