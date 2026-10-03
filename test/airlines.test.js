import test from 'node:test';
import assert from 'node:assert/strict';
import { callsignAirline, flightCode, knownAirline } from '../shared/airlines.js';
import { mapColor, parseHex, rgbToOklch } from '../shared/colors.js';
import { airlineColor, planeGroup, summarize } from '../shared/plane-groups.js';
import { AirlineDirectory, normalizeAdsbdbAirline } from '../server/enrich/airlines.js';
import { Enricher } from '../server/enrich/index.js';
import { DEFAULT_CONFIG } from '../server/config.js';
import { fakeFetch, quietLog, tmpDir, waitFor } from './helpers.js';

// ---- flight codes -------------------------------------------------------------------------

test('callsigns become the flight numbers passengers see', () => {
  assert.equal(flightCode('WJA347', 'WS'), 'WS347');
  assert.equal(flightCode('KLM0639', 'KL'), 'KL639');
  assert.equal(flightCode('ASA12B', 'AS'), null, 'letters on the end are radio shorthand, not a flight number');
  assert.equal(flightCode('CGWHN', 'XX'), null);
  assert.equal(flightCode('WJA347', null), null);
  assert.equal(callsignAirline('WEN3463'), 'WEN');
  assert.equal(callsignAirline('CGWHN'), null);
});

test('regional airlines fly under their brand code and colour', () => {
  const encore = knownAirline('WEN');
  assert.equal(encore.name, 'WestJet Encore');
  assert.equal(encore.iata, 'WS');
  assert.deepEqual(encore.brand, { icao: 'WJA', name: 'WestJet', color: '#00aaa5' });
  assert.equal(knownAirline('JZA').iata, 'AC');
  assert.equal(knownAirline('XYZ'), null);
});

test('the enricher gives each airliner its flight code, using adsbdb for airlines not listed', async () => {
  const fetchImpl = fakeFetch([
    [
      'https://api.adsbdb.com/v0/airline/KEW',
      () => ({ body: { response: [{ name: 'Keewatin Air', icao: 'KEW', iata: 'FK' }] } }),
    ],
  ]);
  const cfg = structuredClone(DEFAULT_CONFIG);
  const enricher = new Enricher({ dataDir: await tmpDir(), getConfig: () => cfg, log: quietLog, fetchImpl });
  enricher.operators = {
    WEN: { n: 'Westjet Encore', c: 'Canada' },
    KEW: { n: 'Keewatin Air', c: 'Canada' },
  };
  const wen = enricher.enrich({ hex: 'c00001', callsign: 'WEN3463' }, { lookup: false });
  assert.equal(wen.flight, 'WS3463');
  assert.equal(wen.airline.name, 'WestJet Encore');
  assert.equal(wen.airline.brand.icao, 'WJA');

  // Not listed: no code until adsbdb answers.
  assert.equal(enricher.enrich({ hex: 'c00002', callsign: 'KEW201' }, { lookup: false }).flight, null);
  await waitFor(() => enricher.airlines.cache.size);
  const kew = enricher.enrich({ hex: 'c00002', callsign: 'KEW201' }, { lookup: false });
  assert.equal(kew.flight, 'FK201');
  assert.equal(kew.airline.brand, null);
});

test('adsbdb airlines whose name has nothing in common with ours are ignored', () => {
  const rouge = { response: [{ name: 'Transportes Aereos I.R. Crusoe', iata: null }] };
  assert.equal(normalizeAdsbdbAirline(rouge, 'Air Canada Rouge'), null);
  const fedex = { response: [{ name: 'FedEx Express', iata: 'FX' }] };
  assert.deepEqual(normalizeAdsbdbAirline(fedex, 'Federal Express'), { name: 'FedEx Express', iata: 'FX' });
  assert.deepEqual(normalizeAdsbdbAirline(fedex), { name: 'FedEx Express', iata: 'FX' });
  assert.equal(normalizeAdsbdbAirline({ response: 'unknown airline' }), null);
});

test('the airline directory looks each airline up once', async () => {
  const fetchImpl = fakeFetch([['https://api.adsbdb.com/v0/airline/', () => ({ status: 404, body: {} })]]);
  const dir = new AirlineDirectory({ log: quietLog, fetchImpl });
  assert.equal(dir.get('ZZZ'), undefined);
  assert.equal(dir.get('ZZZ'), undefined);
  await waitFor(() => dir.cache.size);
  assert.equal(dir.get('ZZZ'), null);
  assert.equal(fetchImpl.calls.length, 1);
});

// ---- colours and the map summary --------------------------------------------------------------

test('brand colours are moved into a lightness that shows up on each map', () => {
  const L = (hex) => rgbToOklch(parseHex(hex))[0];
  const porterNavy = '#1b2f5b';
  assert.ok(L(mapColor(porterNavy, 'dark')) > 0.59, 'navy is lightened on the dark map');
  assert.equal(mapColor('#f01428', 'dark'), '#f01428', 'Air Canada stays red on the dark map');
  const spiritYellow = '#ffec00';
  assert.ok(L(mapColor(spiritYellow, 'light')) <= 0.59, 'yellow is darkened on the light map');
  // The hue stays recognisable.
  const hue = (hex) => rgbToOklch(parseHex(hex))[2];
  assert.ok(Math.abs(hue(mapColor(porterNavy, 'dark')) - hue(porterNavy)) < 12);
  // Airlines we don't know still get a steady colour.
  const unknown = planeGroup({ airline: { icao: 'KEW', name: 'Keewatin Air' } });
  assert.equal(airlineColor(unknown, 'dark'), airlineColor(unknown, 'dark'));
  assert.match(airlineColor(unknown, 'light'), /^#[0-9a-f]{6}$/);
});

test('planes are grouped by special kind, then by the airline brand they fly as, else private', () => {
  const encore = planeGroup({ airline: { icao: 'WEN', name: 'WestJet Encore', brand: knownAirline('WEN').brand } });
  const westjet = planeGroup({ airline: { icao: 'WJA', name: 'WestJet', brand: knownAirline('WJA').brand } });
  assert.equal(encore.key, westjet.key);
  assert.equal(encore.label, 'WestJet');
  assert.equal(planeGroup({ airline: { icao: 'SLG' }, special: { kind: 'ambulance' } }).key, 'ambulance');
  assert.equal(planeGroup({ military: true }).key, 'military');
  assert.equal(planeGroup({ callsign: 'CGWHN' }).key, 'private');
});

test('the summary lists every airline, then police, ambulance, government, military and private', () => {
  const wj = { airline: { icao: 'WJA', brand: knownAirline('WJA').brand } };
  const delta = { airline: { icao: 'DAL', brand: knownAirline('DAL').brand } };
  const rows = summarize([wj, delta, wj, { special: { kind: 'firefighting' } }, {}].map(planeGroup));
  assert.deepEqual(
    rows.map((r) => `${r.group.label} ${r.count}`),
    [
      'WestJet 2',
      'Delta 1',
      'Police 0',
      'Air ambulance 0',
      'Government 0',
      'Military 0',
      'Firefighting 1',
      'Private 1',
    ],
  );
});

test('military and other special aircraft get no passenger flight code', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const enricher = new Enricher({
    dataDir: await tmpDir(),
    getConfig: () => cfg,
    log: quietLog,
    fetchImpl: fakeFetch([]),
  });
  enricher.operators = { RCH: { n: 'Air Mobility Command', c: 'United States' } };
  enricher.airlines.cache.set('RCH', { name: 'Air Mobility Command', iata: 'MC' }, 60_000);
  const reach = enricher.enrich({ hex: 'ae0001', callsign: 'RCH661', military: true }, { lookup: false });
  assert.equal(reach.flight, null);
});
