import test from 'node:test';
import assert from 'node:assert/strict';
import { Cycler, selectPools } from '../shared/cycler.js';

const ac = (hex, distanceKm, extra = {}) => ({ hex, distanceKm, altFt: 10_000, onGround: false, ...extra });
const ctx = (pool, opts = {}) => ({ pool, spotlight: [], cycleMs: 10_000, mapEvery: 0, mapMs: 15_000, ...opts });

test('selectPools filters by range, altitude and ground', () => {
  const display = {
    cycleRangeKm: 20,
    minAltitudeFt: 1000,
    maxAltitudeFt: 30_000,
    hideGround: true,
    spotlight: { enabled: true, rangeKm: 3, maxAltitudeFt: 5000 },
  };
  const list = [
    ac('a', 5),
    ac('b', 25),
    ac('c', 5, { altFt: 500 }),
    ac('d', 5, { altFt: 38_000 }),
    ac('e', 2, { onGround: true, altFt: 0 }),
    ac('f', 2, { altFt: 3000 }),
    ac('g', 8, { altFt: null }),
  ];
  const { pool, spotlight } = selectPools(list, display);
  assert.deepEqual(
    pool.map((a) => a.hex),
    ['a', 'f', 'g'],
  );
  assert.deepEqual(
    spotlight.map((a) => a.hex),
    ['f'],
  );
  const withGround = selectPools(list, { ...display, hideGround: false });
  assert.ok(withGround.pool.some((a) => a.hex === 'e'));
});

test('round-robin: every aircraft is shown before any repeats, closest first', () => {
  const c = new Cycler();
  const pool = [ac('far', 15), ac('near', 2), ac('mid', 8)];
  const seen = [];
  let t = 0;
  for (let i = 0; i < 6; i++) {
    const v = c.update(t, ctx(pool));
    seen.push(v.hex);
    t += 10_000;
  }
  assert.deepEqual(seen, ['near', 'mid', 'far', 'near', 'mid', 'far']);
});

test('slot is kept until it expires', () => {
  const c = new Cycler();
  const pool = [ac('a', 1), ac('b', 2)];
  assert.equal(c.update(0, ctx(pool)).hex, 'a');
  assert.equal(c.update(9_999, ctx(pool)).hex, 'a');
  assert.equal(c.update(10_000, ctx(pool)).hex, 'b');
});

test('newly arrived aircraft jump the queue', () => {
  const c = new Cycler();
  let pool = [ac('a', 1), ac('b', 2)];
  c.update(0, ctx(pool));
  c.update(10_000, ctx(pool));
  pool = [...pool, ac('new', 9)];
  assert.equal(c.update(20_000, ctx(pool)).hex, 'new');
});

test('an aircraft leaving the area ends its slot immediately', () => {
  const c = new Cycler();
  c.update(0, ctx([ac('a', 1), ac('b', 2)]));
  assert.equal(c.update(1000, ctx([ac('b', 2)])).hex, 'b');
});

test('map is interleaved every N cards', () => {
  const c = new Cycler();
  const pool = [ac('a', 1), ac('b', 2), ac('c', 3)];
  const kinds = [];
  let t = 0;
  for (let i = 0; i < 4; i++) {
    const v = c.update(t, ctx(pool, { mapEvery: 2 }));
    kinds.push(v.kind);
    t = v.end;
  }
  assert.deepEqual(kinds, ['card', 'card', 'map', 'card']);
});

test('idle when nothing is in range, cards resume when something appears', () => {
  const c = new Cycler();
  assert.equal(c.update(0, ctx([])).kind, 'idle');
  assert.equal(c.update(60_000, ctx([])).kind, 'idle');
  assert.equal(c.update(61_000, ctx([ac('x', 4)])).hex, 'x');
});

test('a single aircraft stays on screen', () => {
  const c = new Cycler();
  const pool = [ac('solo', 3)];
  assert.equal(c.update(0, ctx(pool)).hex, 'solo');
  assert.equal(c.update(10_000, ctx(pool)).hex, 'solo');
});

test('spotlight takes over and interrupts the map', () => {
  const c = new Cycler();
  const pool = [ac('a', 1), ac('b', 10), ac('c', 12)];
  c.update(0, ctx(pool, { mapEvery: 1 }));
  assert.equal(c.update(10_000, ctx(pool, { mapEvery: 1 })).kind, 'map');
  const v = c.update(11_000, ctx(pool, { mapEvery: 1, spotlight: [pool[1]] }));
  assert.equal(v.kind, 'card');
  assert.equal(v.hex, 'b');
  // only spotlight aircraft are shown while it lasts
  assert.equal(c.update(21_000, ctx(pool, { mapEvery: 1, spotlight: [pool[1]] })).hex, 'b');
});

test('next, prev and pin', () => {
  const c = new Cycler();
  const pool = [ac('a', 1), ac('b', 2), ac('c', 3)];
  assert.equal(c.update(0, ctx(pool)).hex, 'a');
  assert.equal(c.next(1000, ctx(pool)).hex, 'b');
  assert.equal(c.next(2000, ctx(pool)).hex, 'c');
  assert.equal(c.prev(3000, ctx(pool)).hex, 'b');
  c.pin('b', 4000);
  assert.equal(c.update(100_000, ctx(pool)).hex, 'b');
  // pin is released when the aircraft leaves
  assert.notEqual(c.update(101_000, ctx([pool[0], pool[2]])).hex, 'b');
  assert.equal(c.pinned, null);
});

test('show() brings up a tapped aircraft, even outside the cycle range, then cycling resumes', () => {
  const c = new Cycler();
  const pool = [ac('a', 1), ac('b', 2)];
  const far = ac('far', 50);
  const all = [...pool, far];
  c.update(0, ctx(pool, { all }));
  assert.equal(c.show('far', 1000, ctx(pool, { all })).hex, 'far');
  assert.equal(c.update(5000, ctx(pool, { all })).hex, 'far', 'stays for its slot');
  assert.notEqual(c.update(11_000, ctx(pool, { all })).hex, 'far', 'then cycling resumes');
  c.show('far', 12_000, ctx(pool, { all }));
  assert.notEqual(c.update(13_000, ctx(pool, { all: pool })).hex, 'far', 'leaves when the plane disappears');
});
