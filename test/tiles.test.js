import test from 'node:test';
import assert from 'node:assert/strict';
import { tileSpec } from '../shared/tiles.js';

test('keyed providers get the key in the tile URL, and no background without one', () => {
  for (const tiles of ['stadia', 'maptiler', 'carto']) {
    assert.equal(tileSpec({ tiles, tileApiKey: '' }, 'dark'), null, tiles);
    assert.equal(tileSpec({ tiles, tileApiKey: '  ' }, 'light'), null, tiles);
    const spec = tileSpec({ tiles, tileApiKey: ' a b+c ' }, 'dark');
    assert.match(spec.url, /=a%20b%2Bc$/, tiles);
  }
});

test('CARTO uses Voyager in both themes, inverted at night', () => {
  const voyager = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=k';
  const dark = tileSpec({ tiles: 'carto', tileApiKey: 'k' }, 'dark');
  assert.equal(dark.url, voyager);
  assert.equal(dark.subdomains, 'abcd');
  assert.match(dark.filter, /^invert\(1\)/);
  const light = tileSpec({ tiles: 'carto', tileApiKey: 'k' }, 'light');
  assert.equal(light.url, voyager);
  assert.equal(light.filter, '');
});

test('keyless and custom tiles', () => {
  assert.equal(tileSpec({ tiles: 'none', tileApiKey: 'k' }, 'dark'), null);
  assert.match(tileSpec({ tiles: 'osm', tileApiKey: '' }, 'dark').filter, /^invert\(1\)/);
  assert.equal(tileSpec({ tiles: 'stadia', tileApiKey: 'k' }, 'dark').filter, '');
  assert.equal(tileSpec({ tiles: 'custom', customTileUrl: '' }, 'dark'), null);
  assert.equal(
    tileSpec({ tiles: 'custom', customTileUrl: 'https://t/{z}/{x}/{y}.png' }, 'dark').url,
    'https://t/{z}/{x}/{y}.png',
  );
});
