import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AeroApiLedger, currentFlight, FEES, FlightAware, routeFromFlight } from '../server/enrich/flightaware.js';
import { AirportDb, parseCsvLine } from '../server/enrich/airports.js';
import { Enricher } from '../server/enrich/index.js';
import { DEFAULT_CONFIG, mergeConfig } from '../server/config.js';
import { fakeFetch, quietLog, tmpDir, waitFor } from './helpers.js';

const DAY = 24 * 3600_000;
const T = Date.UTC(2026, 9, 7, 21, 30); // 7 Oct 2026, 25 days left in the month (incl. today)

const config = (patch = {}) => mergeConfig(DEFAULT_CONFIG, { source: { type: 'aircraft-json' }, ...patch }).config;

// A real answer for WJA344 (trimmed), Calgary → Saskatoon.
const WJA344 = {
  flights: [
    {
      ident: 'WJA344',
      ident_iata: 'WS344',
      fa_flight_id: 'WJA344-1791177782-airline-611p',
      status: 'On The Way! / Delayed',
      scheduled_off: '2026-10-07T20:35:00Z',
      actual_off: '2026-10-07T21:17:02Z',
      estimated_on: '2026-10-07T22:15:00Z',
      scheduled_on: '2026-10-07T21:29:00Z',
      actual_on: null,
      departure_delay: 1740,
      arrival_delay: 2100,
      origin: {
        code: 'CYYC',
        code_icao: 'CYYC',
        code_iata: 'YYC',
        timezone: 'America/Edmonton',
        name: "Calgary Int'l",
        city: 'Calgary',
      },
      destination: {
        code: 'CYXE',
        code_icao: 'CYXE',
        code_iata: 'YXE',
        timezone: 'America/Regina',
        name: "Saskatoon Int'l",
        city: 'Saskatoon',
      },
    },
    {
      ident: 'WJA344',
      fa_flight_id: 'WJA344-older',
      scheduled_off: '2026-10-07T02:00:00Z',
      actual_off: '2026-10-07T02:05:00Z',
      actual_on: '2026-10-07T03:00:00Z',
      origin: { code_icao: 'CYYC' },
      destination: { code_icao: 'CYXE' },
    },
  ],
  links: null,
  num_pages: 1,
};

const AIRPORTS_CSV = `"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"
1957,"CYXE","large_airport","Saskatoon John G. Diefenbaker International Airport",52.170723,-106.700793,1653,"NA","CA","CA-SK","Saskatoon","yes","CYXE","YXE","CYXE",,,"",
1973,"CYYC","large_airport","Calgary International Airport",51.118822,-114.009933,3557,"NA","CA","CA-AB","Calgary","yes","CYYC","YYC","CYYC",,,"","McCall Field"
6523,"00A","heliport","Total RF Heliport",40.070985,-74.933689,11,"NA","US","US-PA","Bensalem","no",,,"K00A","00A",,,`;

test('airport positions come from the OurAirports CSV', () => {
  assert.deepEqual(parseCsvLine('1,"a, b","say ""hi""",,x'), ['1', 'a, b', 'say "hi"', '', 'x']);
  const db = new AirportDb();
  assert.equal(db.loadCsv(AIRPORTS_CSV) > 0, true);
  assert.equal(db.get('CYXE').city, 'Saskatoon');
  assert.equal(db.get('nope', 'CYYC').iata, 'YYC');
  assert.equal(db.get('00A'), null, 'heliports are left out');
});

test('the flight in the air now is picked from FlightAware’s list', () => {
  assert.equal(currentFlight(WJA344.flights, T).fa_flight_id, 'WJA344-1791177782-airline-611p');
  assert.equal(currentFlight([WJA344.flights[1]], T), null, 'only a landed flight');
  const db = new AirportDb();
  db.loadCsv(AIRPORTS_CSV);
  const r = routeFromFlight(WJA344.flights[0], db);
  assert.equal(r.origin.iata, 'YYC');
  assert.equal(r.origin.tz, 'America/Edmonton');
  assert.equal(r.destination.lat, 52.170723);
  assert.equal(r.times.takeoff, Date.parse('2026-10-07T21:17:02Z'));
  assert.equal(r.times.landing, Date.parse('2026-10-07T22:15:00Z'));
  assert.equal(r.times.arrivalDelayMin, 35);
  assert.equal(r.flightIata, 'WS344');
  assert.equal(r.source, 'flightaware');
});

test('the ledger spreads the budget over the month and enforces the per-minute limit', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'ledger.json');
  const ledger = new AeroApiLedger({ file, log: quietLog });
  await ledger.load(T);
  const limits = { budget: 5, perMinute: 2 };
  // $5 over the 25 days left: $0.20 today.
  assert.deepEqual(ledger.allowance(5, T), { month: 5, today: 0.2 });
  assert.equal(ledger.refusal(FEES.flights, limits, T), null);
  await ledger.charge('flights', FEES.flights, T);
  await ledger.charge('flights', FEES.flights, T + 1000);
  const r = ledger.refusal(FEES.flights, limits, T + 2000);
  assert.equal(r.reason, 'per-minute limit');
  assert.equal(r.retryAt, T + 60_000);
  assert.equal(ledger.refusal(FEES.flights, limits, T + 61_000), null, 'a minute later');

  // Today's share runs out; tomorrow brings a new share.
  for (let i = 0; i < 38; i++) await ledger.charge('flights', FEES.flights, T + 120_000 + i);
  assert.equal(ledger.spentToday(T + 200_000), 0.2);
  assert.equal(
    ledger.refusal(FEES.flights, { budget: 5, perMinute: 100 }, T + 200_000).reason,
    "today's share of the budget used up",
  );
  assert.equal(ledger.refusal(FEES.flights, { budget: 5, perMinute: 100 }, T + DAY), null);

  // It's all on disk: a restart doesn't forget.
  const again = new AeroApiLedger({ file, log: quietLog });
  await again.load(T + 300_000);
  assert.equal(again.state.spent, 0.2);
  assert.equal(again.state.calls.flights, 40);

  // The month's budget is a hard stop: on the last day all that's left is today's.
  const last = Date.UTC(2026, 9, 31, 12);
  const tight = new AeroApiLedger({ file: path.join(dir, 'tight.json'), log: quietLog });
  await tight.load(last);
  await tight.charge('flights', 0.995, last - DAY);
  assert.equal(tight.refusal(FEES.flights, { budget: 1, perMinute: 100 }, last), null, 'exactly $1.000 is fine');
  await tight.charge('flights', FEES.flights, last);
  assert.equal(tight.refusal(FEES.flights, { budget: 1, perMinute: 100 }, last).reason, 'monthly budget used up');
  assert.equal(tight.refusal(0.001, { budget: 1, perMinute: 100 }, last).reason, 'monthly budget used up');

  // A new month starts afresh.
  assert.deepEqual(tight.allowance(1, Date.UTC(2026, 10, 1, 12)), { month: 1, today: 0.033333 });
  // A spend earlier in the month leaves less for each day after.
  const paced = new AeroApiLedger({ file: path.join(dir, 'paced.json'), log: quietLog });
  await paced.load(T);
  await paced.charge('flights', 0.995, T - DAY);
  assert.equal(
    paced.refusal(FEES.flights, { budget: 1, perMinute: 100 }, T).reason,
    "today's share of the budget used up",
  );
});

test('FlightAware’s own usage figure wins when it is higher', async () => {
  const dir = await tmpDir();
  const ledger = new AeroApiLedger({ file: path.join(dir, 'l.json'), log: quietLog });
  await ledger.load(T);
  await ledger.charge('flights', 0.01, T);
  await ledger.reconcile(0.5, T);
  assert.equal(ledger.state.spent, 0.5);
  assert.equal(ledger.spentToday(T), 0.5, 'the difference counts against today');
  await ledger.reconcile(0.1, T);
  assert.equal(ledger.state.spent, 0.5, 'never goes down');
});

function aeroApi({ flights = WJA344, usage = 0 } = {}) {
  return fakeFetch([
    [(u) => u.includes('/account/usage'), () => ({ body: { total_cost: usage, total_calls: 0 } })],
    [
      (u) => /\/flights\/[^/]+\/track/.test(u),
      () => ({
        body: {
          positions: [
            { latitude: 51.1, longitude: -114.0, altitude: 50, timestamp: '2026-10-07T21:18:00Z' },
            { latitude: 51.5, longitude: -112.0, altitude: 300, timestamp: '2026-10-07T21:30:00Z' },
          ],
        },
      }),
    ],
    [(u) => /\/flights\/[^/?]+\?/.test(u), () => ({ body: flights })],
  ]);
}

async function makeFa({ cfg = config(), fetchImpl = aeroApi(), apiKey = 'k' } = {}) {
  const dir = await tmpDir();
  const db = new AirportDb();
  db.loadCsv(AIRPORTS_CSV);
  const fa = new FlightAware({ apiKey, dataDir: dir, getConfig: () => cfg, airports: db, log: quietLog, fetchImpl });
  await fa.ledger.load();
  return { fa, fetchImpl, dir };
}

test('every query asks for one page only, with the key, and is booked first', async () => {
  const { fa, fetchImpl, dir } = await makeFa();
  assert.equal(fa.route('WJA344', 'designator').status, 'pending');
  const found = await waitFor(() => fa.route('WJA344', 'designator').route);
  assert.equal(found.destination.city, 'Saskatoon');
  const call = fetchImpl.calls.find((c) => c.url.includes('/flights/WJA344'));
  const url = new URL(call.url);
  assert.equal(url.searchParams.get('max_pages'), '1');
  assert.equal(url.searchParams.get('ident_type'), 'designator');
  assert.ok(url.searchParams.get('start') && url.searchParams.get('end'), 'a narrow time window');
  assert.equal(call.init.headers['x-apikey'], 'k');
  // Answered from the cache afterwards: no second charge.
  fa.route('WJA344', 'designator');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('/flights/WJA344')).length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'cache', 'flightaware-ledger.json'), 'utf8'));
  assert.equal(saved.spent, FEES.flights);
  assert.equal(fa.status().spentThisMonthUsd, FEES.flights);
});

test('no queries without a key, when switched off, or with simulated traffic', async () => {
  for (const [why, opts] of [
    ['no key', { apiKey: '' }],
    ['switched off', { cfg: config({ flightaware: { enabled: false } }) }],
    ['simulator', { cfg: mergeConfig(DEFAULT_CONFIG, { source: { type: 'simulator' } }).config }],
  ]) {
    const { fa, fetchImpl } = await makeFa(opts);
    assert.equal(fa.route('WJA344', 'designator').status, 'off', why);
    assert.equal(await fa.resolve('WJA344', 'designator'), null, why);
    assert.equal(fetchImpl.calls.length, 0, why);
  }
});

test('a zero budget means no paid queries at all', async () => {
  const { fa, fetchImpl } = await makeFa({ cfg: config({ flightaware: { monthlyBudgetUsd: 0 } }) });
  fa.route('WJA344', 'designator');
  assert.equal(await fa.resolve('ACA1108', 'designator'), null);
  assert.equal(await fa.track('WJA344-1791177782-airline-611p'), null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetchImpl.calls.filter((c) => !c.url.includes('/account/usage')).length, 0);
  assert.match(fa.status().lastRefusal.reason, /budget/);
});

test('the per-minute limit holds however many planes want looking up', async () => {
  const { fa, fetchImpl } = await makeFa({ cfg: config({ flightaware: { perMinute: 3 } }) });
  for (let i = 0; i < 10; i++) fa.route(`ACA${100 + i}`, 'designator');
  // Queries are 2 s apart: three go out, then the fourth waits for the minute to pass.
  await waitFor(() => fa.status().refused > 0, { timeoutMs: 15_000 });
  await new Promise((r) => setTimeout(r, 3000));
  const sent = fetchImpl.calls.filter((c) => c.url.includes('/flights/'));
  assert.equal(sent.length, 3);
  assert.equal(fa.status().lastRefusal.reason, 'per-minute limit');
  fa.stop();
});

test('a rejected key stops all queries', async () => {
  const fetchImpl = fakeFetch([[() => true, () => ({ status: 401, body: { title: 'Unauthorized' } })]]);
  const { fa } = await makeFa({ fetchImpl });
  assert.equal(await fa.resolve('WJA344', 'designator'), null);
  assert.equal(fa.active, false);
  assert.match(fa.status().disabledReason, /rejected the API key/);
  assert.equal(fa.route('ACA1', 'designator').status, 'off');
});

test('enrichment asks FlightAware only about flights the free sources could not place', async () => {
  const dir = await tmpDir();
  const cfg = config();
  const fetchImpl = fakeFetch([
    // adsb.im and adsbdb: know ACA1108, not WJA344.
    [
      'https://adsb.im/api/0/routeset',
      (u, init) => {
        const planes = JSON.parse(init.body).planes;
        return {
          body: planes.map((p) =>
            p.callsign === 'ACA1108'
              ? {
                  callsign: 'ACA1108',
                  plausible: true,
                  _airports: [
                    { iata: 'YYZ', icao: 'CYYZ', lat: 43.68, lon: -79.63, location: 'Toronto' },
                    { iata: 'YVR', icao: 'CYVR', lat: 49.19, lon: -123.18, location: 'Vancouver' },
                  ],
                }
              : { callsign: p.callsign, _airports: [] },
          ),
        };
      },
    ],
    ['https://api.adsbdb.com', () => ({ status: 404, body: { response: 'unknown callsign' } })],
    [
      (u) => u.includes('aeroapi'),
      (u) => (u.includes('/account/usage') ? { body: { total_cost: 0 } } : { body: WJA344 }),
    ],
  ]);
  const enricher = new Enricher({
    dataDir: dir,
    getConfig: () => cfg,
    log: quietLog,
    fetchImpl,
    env: { FLIGHTAWARE_API_KEY: 'k' },
  });
  await enricher.init({ loadDatabases: false });
  enricher.airports.loadCsv(AIRPORTS_CSV);
  const near = { lat: 52.0, lon: -108.5, onGround: false, gsKt: 420 };
  const enrichAll = () => [
    enricher.enrich({ hex: 'c00001', callsign: 'WJA344', ...near }),
    enricher.enrich({ hex: 'c00002', callsign: 'ACA1108', ...near }),
    enricher.enrich({ hex: 'c00003', callsign: 'CGABC', reg: 'C-GABC', type: 'C172', ...near, gsKt: 110 }),
    enricher.enrich({ hex: 'c00004', callsign: 'WJA999', ...near, onGround: true, gsKt: 10 }),
  ];
  enrichAll();
  const wja = await waitFor(() => {
    const [w] = enrichAll();
    return w.route?.source === 'flightaware' && w;
  });
  assert.equal(wja.route.destination.iata, 'YXE');
  const [, aca, cessna, ground] = enrichAll();
  assert.equal(aca.route.source, 'adsb.im', 'free route found: FlightAware not asked');
  assert.equal(cessna.route, null, 'light aircraft: not asked');
  assert.notEqual(ground.route?.source, 'flightaware', 'on the ground: not asked');
  const paid = fetchImpl.calls.filter((c) => c.url.includes('aeroapi') && !c.url.includes('/account/usage'));
  assert.deepEqual(
    paid.map((c) => new URL(c.url).pathname),
    ['/aeroapi/flights/WJA344'],
  );
  await enricher.shutdown();
});

test('a tapped plane’s missing flight path is filled in from FlightAware', async () => {
  const dir = await tmpDir();
  const cfg = config();
  const fetchImpl = fakeFetch([
    ['https://adsb.lol/data/traces', () => ({ status: 404, body: {} })],
    [(u) => u.includes('/account/usage'), () => ({ body: { total_cost: 0 } })],
    [
      (u) => u.includes('/track'),
      () => ({
        body: {
          positions: [
            { latitude: 51.1, longitude: -114.0, altitude: 50, timestamp: '2026-10-07T21:18:00Z' },
            { latitude: 51.5, longitude: -112.0, altitude: 300, timestamp: '2026-10-07T21:30:00Z' },
          ],
        },
      }),
    ],
    [(u) => u.includes('aeroapi'), () => ({ body: WJA344 })],
  ]);
  const enricher = new Enricher({
    dataDir: dir,
    getConfig: () => cfg,
    log: quietLog,
    fetchImpl,
    env: { FLIGHTAWARE_API_KEY: 'k' },
  });
  await enricher.init({ loadDatabases: false });
  const ac = { hex: 'c00001', callsign: 'WJA344', route: { origin: { lat: 51.12, lon: -114.0 } } };
  assert.equal(await enricher.trackFor(ac), null, 'not tapped: adsb.lol only, nothing paid');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('aeroapi') && !c.url.includes('usage')).length, 0);
  const track = await enricher.trackFor(ac, { tapped: true });
  assert.equal(track.source, 'FlightAware');
  assert.deepEqual(track.points[1], [51.5, -112.0, Date.parse('2026-10-07T21:30:00Z'), 30000]);
  assert.equal(enricher.flightaware.status().spentThisMonthUsd, FEES.flights + FEES.track);
  // Again: from the cache, no new charges.
  await enricher.trackFor(ac, { tapped: true });
  assert.equal(enricher.flightaware.status().spentThisMonthUsd, FEES.flights + FEES.track);
  await enricher.shutdown();
});

test('FlightAware settings are capped', () => {
  const { errors } = mergeConfig(DEFAULT_CONFIG, { flightaware: { monthlyBudgetUsd: 50, perMinute: 10 } });
  assert.deepEqual(errors.map((e) => e.field).sort(), ['flightaware.monthlyBudgetUsd', 'flightaware.perMinute']);
  assert.equal(DEFAULT_CONFIG.flightaware.monthlyBudgetUsd, 4);
});
