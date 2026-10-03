import test from 'node:test';
import assert from 'node:assert/strict';
import { TILE_PROVIDERS, mapStyle, tileSpec } from '../shared/tiles.js';

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

test('daytime and night styles: chosen, defaulted, or ignored when unknown', () => {
  const carto = { tiles: 'carto', tileApiKey: 'k' };
  assert.equal(mapStyle(carto, 'light').id, 'voyager');
  assert.equal(mapStyle(carto, 'dark').id, 'voyager-night');
  const picked = { ...carto, dayStyle: 'positron', nightStyle: 'dark-matter-bright' };
  assert.equal(tileSpec(picked, 'light').url, 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=k');
  assert.equal(tileSpec(picked, 'light').filter, '');
  assert.equal(tileSpec(picked, 'dark').url, 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=k');
  assert.match(tileSpec(picked, 'dark').filter, /^brightness/);
  // a night style by day keeps its filter
  assert.match(tileSpec({ ...carto, dayStyle: 'voyager-night' }, 'light').filter, /^invert/);
  // a style from another provider (or a typo) falls back to the default
  assert.equal(mapStyle({ ...carto, dayStyle: 'smooth' }, 'light').id, 'voyager');
  // every provider's defaults exist
  for (const [name, p] of Object.entries(TILE_PROVIDERS)) {
    assert.ok(p.styles[p.day] && p.styles[p.night], name);
  }
});
