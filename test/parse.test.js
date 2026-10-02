import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAircraftJson } from '../server/sources/parse.js';
import { expandUrl } from '../server/sources/http.js';
import { SimulatorSource } from '../server/sources/simulator.js';
import { DEFAULT_CONFIG } from '../server/config.js';
import { distanceM } from '../shared/geo.js';

test('readsb aircraft.json', () => {
  const { now, aircraft } = parseAircraftJson({
    now: 1_790_000_000.5,
    messages: 12345,
    aircraft: [
      {
        hex: 'A1B2C3',
        type: 'adsb_icao',
        flight: 'UAL1234 ',
        r: 'N12345',
        t: 'b38m',
        alt_baro: 34000,
        alt_geom: 34500,
        gs: 455.2,
        track: 92.3,
        baro_rate: -64,
        squawk: '3421',
        emergency: 'none',
        category: 'A3',
        lat: 47.5,
        lon: -122.1,
        seen_pos: 0.4,
        seen: 0.1,
        dbFlags: 0,
        mlat: [],
      },
      { hex: 'abcdef', alt_baro: 'ground', lat: 47.4, lon: -122.3, seen: 1 },
      { hex: '~2fffff', lat: 47, lon: -122, seen: 3, tisb: ['lat', 'lon'] },
      { hex: 'nope' },
      { hex: 'c0ffee', seen: 2 },
    ],
  });
  assert.equal(now, 1_790_000_000_500);
  assert.equal(aircraft.length, 4);
  const [a, g, t, nopos] = aircraft;
  assert.equal(a.hex, 'a1b2c3');
  assert.equal(a.callsign, 'UAL1234');
  assert.equal(a.type, 'B38M');
  assert.equal(a.altFt, 34000);
  assert.equal(a.emergency, null);
  assert.equal(a.vertRateFpm, -64);
  assert.equal(g.onGround, true);
  assert.equal(g.altFt, 0);
  assert.equal(t.nonIcao, true);
  assert.equal(t.tisb, true);
  assert.equal(nopos.lat, null);
  assert.equal(nopos.seenPos, null);
});

test('v2 API format ({ ac: [...] }, now in ms) and legacy dump1090 fields', () => {
  const { now, aircraft } = parseAircraftJson({
    now: 1_790_000_000_123,
    ac: [
      { hex: '4ca7b1', flight: 'RYR12', altitude: 12000, speed: 300, vert_rate: 900, lat: 53, lon: -6, seen: 0 },
      { hex: 'ae1234', dbFlags: 1, lat: 38, lon: -77, alt_baro: 20000, seen: 0 },
    ],
  });
  assert.equal(now, 1_790_000_000_123);
  assert.equal(aircraft[0].altFt, 12000);
  assert.equal(aircraft[0].gsKt, 300);
  assert.equal(aircraft[0].vertRateFpm, 900);
  assert.equal(aircraft[1].military, true);
});

test('rejects payloads without an aircraft list', () => {
  assert.throws(() => parseAircraftJson({ foo: 1 }), /no "aircraft"/);
  assert.throws(() => parseAircraftJson(null));
});

test('API URL placeholders', () => {
  const url = expandUrl('https://api.adsb.lol/v2/point/{lat}/{lon}/{radiusNm}?km={radiusKm}', {
    lat: 47.60621,
    lon: -122.33207,
    radiusKm: 64.37,
  });
  assert.equal(url, 'https://api.adsb.lol/v2/point/47.6062/-122.3321/35?km=65');
  // the public APIs cap the radius at 250 nm
  assert.match(expandUrl('{radiusNm}', { lat: 0, lon: 0, radiusKm: 2000 }), /^250$/);
});

test('simulator produces moving traffic around the receiver with routes', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const sim = new SimulatorSource({ getConfig: () => config, seed: 42, count: 12 });
  const first = sim.tick(1_000_000);
  assert.equal(first.aircraft.length, 12);
  const rangeM = config.map.rangeKm * 1000;
  for (const a of first.aircraft) {
    assert.ok(distanceM(config.receiver.lat, config.receiver.lon, a.lat, a.lon) < rangeM * 1.15);
    assert.ok(a.type);
  }
  const later = sim.tick(1_010_000);
  const moved = later.aircraft.find((a) => a.hex === first.aircraft[0].hex);
  assert.ok(moved && (moved.lat !== first.aircraft[0].lat || moved.lon !== first.aircraft[0].lon));
  const airline = first.aircraft.find((a) => /^[A-Z]{3}\d/.test(a.callsign));
  if (airline) assert.equal(sim.lookupRoute(airline.callsign).airports.length, 2);
});
