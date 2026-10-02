import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_CONFIG } from '../server/config.js';
import { categoryFromDesc, splitIcaoName, TypeDb } from '../server/enrich/types.js';
import {
  isAirlineCallsign,
  normalizeAdsbdbRoute,
  normalizeAdsbLolRoute,
  resolveLeg,
  RouteResolver,
} from '../server/enrich/routes.js';
import { normalizePlanespotters, PhotoResolver } from '../server/enrich/photos.js';
import { findTypeImage } from '../server/enrich/wikipedia.js';
import { AircraftDb, ensureDbFile, readJsonMaybeGzip } from '../server/enrich/tar1090db.js';
import { cleanAirlineName } from '../server/enrich/index.js';
import { fakeFetch, quietLog, tmpDir, waitFor } from './helpers.js';

const config = () => structuredClone(DEFAULT_CONFIG);

// ---- types ------------------------------------------------------------------------

test('ICAO type names are split into manufacturer and model', () => {
  assert.deepEqual(splitIcaoName('BOEING 737 MAX 8'), { manufacturer: 'Boeing', model: '737 MAX 8' });
  assert.deepEqual(splitIcaoName('AIRBUS HELICOPTERS EC-135/635'), {
    manufacturer: 'Airbus Helicopters',
    model: 'EC-135/635',
  });
  assert.deepEqual(splitIcaoName('DE HAVILLAND DHC-8-400 Dash 8'), {
    manufacturer: 'De Havilland',
    model: 'DHC-8-400 Dash 8',
  });
  assert.deepEqual(splitIcaoName('MCDONNELL-DOUGLAS MD-600N'), { manufacturer: 'McDonnell-Douglas', model: 'MD-600N' });
  assert.deepEqual(splitIcaoName('Glider'), { manufacturer: '', model: 'Glider' });
});

test('silhouette category from ICAO description codes', () => {
  assert.equal(categoryFromDesc('L2J', 'M', 'BOEING 737-800'), 'narrowbody');
  assert.equal(categoryFromDesc('L2J', 'H', 'BOEING 787-9'), 'widebody');
  assert.equal(categoryFromDesc('L4J', 'H', 'BOEING 747-8'), 'heavy4');
  assert.equal(categoryFromDesc('L2J', 'M', 'GULFSTREAM G650'), 'bizjet');
  assert.equal(categoryFromDesc('L2T', 'M', 'ATR 72'), 'turboprop');
  assert.equal(categoryFromDesc('L1P', 'L', 'CESSNA 172'), 'light');
  assert.equal(categoryFromDesc('H1P', 'L', 'ROBINSON R-44'), 'helicopter');
});

test('TypeDb prefers the curated table, then the ICAO table, then ADS-B category', () => {
  const db = new TypeDb();
  db.setIcaoTable({
    B38M: ['BOEING 737 MAX 8', 'L2J', 'M'],
    PA46: ['PIPER PA-46', 'L1P', 'L'],
    ZZZ9: ['ACME Rocket 9', 'L2J', 'L'],
  });
  const max = db.describe('B38M');
  assert.equal(max.manufacturer, 'Boeing');
  assert.equal(max.model, '737 MAX 8');
  assert.equal(max.wiki, 'Boeing 737 MAX');
  assert.equal(max.wtc, 'M');
  const rocket = db.describe('ZZZ9');
  assert.equal(rocket.manufacturer, 'Acme');
  assert.equal(rocket.model, 'Rocket 9');
  assert.equal(rocket.category, 'bizjet');
  const unknown = db.describe('QQQQ', 'SOME THING X1', 'A7');
  assert.equal(unknown.category, 'helicopter');
  assert.equal(db.describe(null, null, 'A5').category, 'widebody');
  assert.equal(db.describe(null, null, null), null);
});

// ---- aircraft database -------------------------------------------------------------

test('AircraftDb parses tar1090 csv rows', () => {
  const db = new AircraftDb();
  db.loadText(
    [
      'A1B2C3;N12345;B38M;00;BOEING 737 MAX 8;2019;United Airlines;',
      'AE0001;;C17;10;;;USAF;',
      '000001;;;10;;;Miscode;',
    ].join('\n'),
  );
  assert.deepEqual(db.lookup('a1b2c3'), {
    reg: 'N12345',
    type: 'B38M',
    desc: 'BOEING 737 MAX 8',
    year: '2019',
    ownOp: 'United Airlines',
    military: false,
  });
  assert.equal(db.lookup('ae0001').military, true);
  assert.equal(db.lookup('000001'), null);
  assert.equal(db.size, 2);
});

test('database files are downloaded once and gzip is detected', async () => {
  const dir = await tmpDir();
  const gz = zlib.gzipSync(JSON.stringify({ UAL: { n: 'United Airlines' } }));
  const fetchImpl = fakeFetch([['https://raw.githubusercontent.com/', () => ({ body: gz })]]);
  const file = await ensureDbFile(dir, 'operators', { fetchImpl, log: quietLog });
  assert.deepEqual(readJsonMaybeGzip(file), { UAL: { n: 'United Airlines' } });
  await ensureDbFile(dir, 'operators', { fetchImpl, log: quietLog });
  assert.equal(fetchImpl.calls.length, 1, 'second call uses the cached copy');
  await fs.writeFile(path.join(dir, 'plain.json'), '{"a":1}');
  assert.deepEqual(readJsonMaybeGzip(path.join(dir, 'plain.json')), { a: 1 });
});

// ---- routes ------------------------------------------------------------------------------

const ADSBLOL_SFO_SEA = {
  _airport_codes_iata: 'SFO-SEA',
  _airports: [
    {
      alt_feet: 13,
      countryiso2: 'US',
      iata: 'SFO',
      icao: 'KSFO',
      lat: 37.619,
      location: 'San Francisco',
      lon: -122.375,
      name: 'San Francisco International Airport',
    },
    {
      alt_feet: 433,
      countryiso2: 'US',
      iata: 'SEA',
      icao: 'KSEA',
      lat: 47.449,
      location: 'Seattle',
      lon: -122.309,
      name: 'Seattle-Tacoma International Airport',
    },
  ],
  airline_code: 'UAL',
  airport_codes: 'KSFO-KSEA',
  callsign: 'UAL1234',
  number: '1234',
  plausible: 1,
};

const ADSBDB_ASA = {
  response: {
    flightroute: {
      callsign: 'ASA328',
      callsign_icao: 'ASA328',
      callsign_iata: 'AS328',
      airline: {
        name: 'Alaska Airlines',
        icao: 'ASA',
        iata: 'AS',
        country: 'United States',
        country_iso: 'US',
        callsign: 'ALASKA',
      },
      origin: {
        country_iso_name: 'US',
        country_name: 'United States',
        elevation: 433,
        iata_code: 'SEA',
        icao_code: 'KSEA',
        latitude: 47.449,
        longitude: -122.309,
        municipality: 'Seattle',
        name: 'Seattle-Tacoma International Airport',
      },
      destination: {
        country_iso_name: 'US',
        country_name: 'United States',
        elevation: 17,
        iata_code: 'SAN',
        icao_code: 'KSAN',
        latitude: 32.7338,
        longitude: -117.1933,
        municipality: 'San Diego',
        name: 'San Diego International Airport',
      },
    },
  },
};

test('route providers are normalised to the same shape', () => {
  const a = normalizeAdsbLolRoute(ADSBLOL_SFO_SEA);
  assert.equal(a.airports[0].city, 'San Francisco');
  assert.equal(a.airports[1].iata, 'SEA');
  assert.equal(normalizeAdsbLolRoute({ callsign: 'X', airport_codes: 'unknown', _airports: [] }), null);
  const b = normalizeAdsbdbRoute(ADSBDB_ASA);
  assert.equal(b.airports[1].city, 'San Diego');
  assert.equal(b.airline.name, 'Alaska Airlines');
  assert.equal(b.flightIata, 'AS328');
  assert.equal(normalizeAdsbdbRoute({ response: 'unknown callsign' }), null);
});

test('airline callsigns vs registrations', () => {
  assert.equal(isAirlineCallsign('UAL1234'), true);
  assert.equal(isAirlineCallsign('ASA12B'), true);
  assert.equal(isAirlineCallsign('N12345'), false);
  assert.equal(isAirlineCallsign('CGXYZ'), false);
  assert.equal(isAirlineCallsign(null), false);
});

test('resolveLeg picks the leg being flown and flags implausible routes', () => {
  const route = {
    airports: [
      { iata: 'SFO', lat: 37.62, lon: -122.37 },
      { iata: 'DEN', lat: 39.86, lon: -104.67 },
      { iata: 'ORD', lat: 41.98, lon: -87.9 },
    ],
    source: 'test',
  };
  const overNebraska = resolveLeg(route, { lat: 41.0, lon: -98.0 });
  assert.equal(overNebraska.origin.iata, 'DEN');
  assert.equal(overNebraska.destination.iata, 'ORD');
  assert.deepEqual(overNebraska.via, ['SFO', 'DEN', 'ORD']);
  assert.equal(overNebraska.plausible, true);
  const overFlorida = resolveLeg(route, { lat: 27.9, lon: -82.5 });
  assert.equal(overFlorida.plausible, false);
});

test('RouteResolver batches adsb.lol lookups and falls back to adsbdb', async () => {
  const cfg = config();
  cfg.enrichment.routeProviders = ['adsblol', 'adsbdb'];
  const fetchImpl = fakeFetch([
    [
      'https://api.adsb.lol/api/0/routeset',
      (url, init) => {
        const { planes } = JSON.parse(init.body);
        return {
          body: planes.map((p) =>
            p.callsign === 'UAL1234' ? ADSBLOL_SFO_SEA : { callsign: p.callsign, _airports: [] },
          ),
        };
      },
    ],
    ['https://api.adsbdb.com/v0/callsign/ASA328', () => ({ body: ADSBDB_ASA })],
    ['https://api.adsbdb.com/v0/callsign/', () => ({ status: 404, body: { response: 'unknown callsign' } })],
  ]);
  const r = new RouteResolver({ getConfig: () => cfg, log: quietLog, fetchImpl, batchDelayMs: 10 });
  const seattle = { lat: 47.6, lon: -122.33 };
  assert.equal(r.get('UAL1234', seattle).status, 'pending');
  assert.equal(r.get('ASA328', seattle).status, 'pending');
  assert.equal(r.get('DAL9', seattle).status, 'pending');
  assert.equal(r.get('N12345', seattle).status, 'none');
  assert.equal(r.get('SWA42', seattle, { lookup: false }).status, 'skipped');
  await waitFor(() => r.get('DAL9', seattle).status !== 'pending');
  const ual = r.get('UAL1234', { lat: 46.5, lon: -122.4 });
  assert.equal(ual.status, 'found');
  assert.equal(ual.route.origin.city, 'San Francisco');
  assert.equal(ual.route.destination.city, 'Seattle');
  const asa = r.get('ASA328', { lat: 45, lon: -121.5 });
  assert.equal(asa.route.airline.name, 'Alaska Airlines');
  assert.equal(r.get('DAL9', seattle).status, 'unknown');
  const batchCalls = fetchImpl.calls.filter((c) => c.url.includes('routeset'));
  assert.equal(batchCalls.length, 1, 'one batched request for all three callsigns');
  // an implausible match is hidden by default
  assert.equal(r.get('UAL1234', { lat: 25.8, lon: -80.3 }).status, 'implausible');
  cfg.enrichment.hideImplausibleRoutes = false;
  assert.equal(r.get('UAL1234', { lat: 25.8, lon: -80.3 }).route.plausible, false);
});

test('RouteResolver honours the simulator override and the routes switch', () => {
  const cfg = config();
  const r = new RouteResolver({ getConfig: () => cfg, log: quietLog, fetchImpl: fakeFetch([]) });
  r.override = (cs) =>
    cs === 'SIM1'
      ? {
          airports: [
            { iata: 'AAA', lat: 0, lon: 0 },
            { iata: 'BBB', lat: 1, lon: 1 },
          ],
          source: 'simulator',
        }
      : null;
  assert.equal(r.get('SIM1', { lat: 50, lon: 50 }).route.destination.iata, 'BBB');
  cfg.enrichment.routes = false;
  assert.equal(r.get('SIM1', null).status, 'none');
});

// ---- photos ------------------------------------------------------------------------------

test('planespotters responses', () => {
  const p = normalizePlanespotters({
    photos: [
      {
        id: '1',
        thumbnail: { src: 'https://t.plnspttrs.net/1_t.jpg', size: { width: 200, height: 133 } },
        thumbnail_large: { src: 'https://t.plnspttrs.net/1_280.jpg', size: { width: 420, height: 280 } },
        link: 'https://www.planespotters.net/photo/1',
        photographer: 'Jane Doe',
      },
    ],
  });
  assert.equal(p.url, 'https://t.plnspttrs.net/1_280.jpg');
  assert.equal(p.credit, '© Jane Doe · planespotters.net');
  assert.equal(normalizePlanespotters({ photos: [] }), null);
});

const wikiFetch = () =>
  fakeFetch([
    [
      (u) => u.includes('api.php') && u.includes('prop=pageimages'),
      () => ({
        body: {
          query: {
            pages: [
              {
                title: 'Boeing 737 MAX',
                pageimage: 'N8704Q_737_MAX.jpg',
                fullurl: 'https://en.wikipedia.org/wiki/Boeing_737_MAX',
              },
            ],
          },
        },
      }),
    ],
    [
      (u) => u.includes('api.php') && u.includes('prop=imageinfo'),
      () => ({
        body: {
          query: {
            pages: [
              {
                title: 'File:N8704Q_737_MAX.jpg',
                imageinfo: [
                  {
                    thumburl: 'https://upload.wikimedia.org/thumb/x/N8704Q_737_MAX.jpg/1280px-N8704Q_737_MAX.jpg',
                    url: 'https://upload.wikimedia.org/x/N8704Q_737_MAX.jpg',
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:N8704Q_737_MAX.jpg',
                    mime: 'image/jpeg',
                    extmetadata: {
                      Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">Jane &amp; John</a>' },
                      LicenseShortName: { value: 'CC BY-SA 4.0' },
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    ],
    [
      'https://upload.wikimedia.org/',
      () => ({ body: Buffer.from('fake-jpeg'), headers: { 'content-type': 'image/jpeg' } }),
    ],
  ]);

test('Wikipedia type image lookup', async () => {
  const found = await findTypeImage({ title: 'Boeing 737 MAX' }, { fetchImpl: wikiFetch() });
  assert.equal(found.imageUrl, 'https://upload.wikimedia.org/thumb/x/N8704Q_737_MAX.jpg/1280px-N8704Q_737_MAX.jpg');
  assert.equal(found.artist, 'Jane & John');
  assert.equal(found.license, 'CC BY-SA 4.0');
});

test('PhotoResolver: local library, planespotters, then Wikipedia', async () => {
  const dataDir = await tmpDir();
  const cfg = config();
  const fetchImpl = fakeFetch([
    [
      'https://api.planespotters.net/pub/photos/hex/A1B2C3',
      () => ({
        body: {
          photos: [
            {
              thumbnail_large: { src: 'https://t.plnspttrs.net/9.jpg' },
              link: 'https://planespotters.net/p/9',
              photographer: 'P',
            },
          ],
        },
      }),
    ],
    ['https://api.planespotters.net/', () => ({ body: { photos: [] } })],
  ]);
  const wiki = wikiFetch();
  const both = async (url, init) => (String(url).includes('planespotters') ? fetchImpl(url, init) : wiki(url, init));

  const r = new PhotoResolver({ dataDir, getConfig: () => cfg, log: quietLog, fetchImpl: both });
  await r.init();
  const typeInfo = { code: 'B38M', name: 'Boeing 737 MAX 8', wiki: 'Boeing 737 MAX' };

  // airframe mode: planespotters first
  assert.equal(r.get({ hex: 'a1b2c3', reg: 'N1', typeInfo }), null, 'pending at first');
  const airframe = await waitFor(() => r.get({ hex: 'a1b2c3', reg: 'N1', typeInfo }));
  assert.equal(airframe.source, 'planespotters');

  // no airframe photo → falls through to the Wikipedia type photo
  const typePhoto = await waitFor(() => r.get({ hex: 'ffffff', reg: null, typeInfo }));
  assert.equal(typePhoto.source, 'wikipedia');
  assert.match(typePhoto.url, /^\/images\/types\/B38M\?v=\d+$/);
  assert.match(typePhoto.credit, /CC BY-SA 4.0/);
  assert.ok(r.typeImagePath('B38M').endsWith(path.join('type-images', 'B38M.jpg')));

  // your own photos win
  await fs.writeFile(path.join(dataDir, 'images', 'types', 'B38M.png'), 'x');
  await fs.writeFile(path.join(dataDir, 'images', 'airframes', 'N777.jpg'), 'x');
  await r.rescan();
  assert.ok(r.typeImagePath('b38m').endsWith(path.join('images', 'types', 'B38M.png')));
  assert.equal(r.get({ hex: '123456', reg: 'N777', typeInfo }).url, '/images/airframes/N777.jpg');
  cfg.enrichment.photoMode = 'type';
  assert.deepEqual(r.get({ hex: 'a1b2c3', reg: 'N1', typeInfo }), {
    url: '/images/types/B38M',
    credit: null,
    source: 'local',
    scope: 'type',
  });
  assert.equal(r.airframeImagePath('../config.json'), null);
  cfg.enrichment.photoMode = 'off';
  assert.equal(r.get({ hex: 'a1b2c3', reg: 'N1', typeInfo }), null);
  r.stop();
});

test('airline names lose corporate suffixes', () => {
  assert.equal(cleanAirlineName('Jetblue Airways Corporation'), 'Jetblue Airways');
  assert.equal(cleanAirlineName('Horizon Air Industries'), 'Horizon Air');
  assert.equal(cleanAirlineName('Delta Air Lines'), 'Delta Air Lines');
  assert.equal(cleanAirlineName('Southwest Airlines Co.'), 'Southwest Airlines');
});
