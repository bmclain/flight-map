import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { serviceOf, UsageLog, usageDay } from '../server/util/usage.js';
import { quietLog, tmpDir } from './helpers.js';

test('requests are put down to the service they went to', () => {
  assert.equal(serviceOf('https://api.adsb.lol/v2/point/52/-106/108'), 'adsb.lol');
  assert.equal(serviceOf('https://adsb.lol/data/traces/0a/trace_full_c0ffee.json'), 'adsb.lol');
  assert.equal(serviceOf('https://aeroapi.flightaware.com/aeroapi/flights/WJA344'), 'flightaware');
  assert.equal(serviceOf('https://adsb.im/api/0/routeset'), 'adsb.im');
  assert.equal(serviceOf('https://api.adsbdb.com/v0/callsign/WJA344'), 'adsbdb');
  assert.equal(serviceOf('https://api.planespotters.net/pub/photos/hex/c0ffee'), 'planespotters');
  assert.equal(serviceOf('https://upload.wikimedia.org/x.jpg'), 'wikipedia');
  // Your own network isn't an outside service.
  assert.equal(serviceOf('http://192.168.1.199:8080/data/aircraft.json'), null);
  assert.equal(serviceOf('http://whisper:8080/inference'), null);
  assert.equal(serviceOf('http://sky-snitch.local/data/stats.json'), null);
  assert.equal(serviceOf('not a url'), null);
});

test('the metered fetch counts requests, errors and rate limiting', async () => {
  const usage = new UsageLog({ file: null, log: quietLog });
  const answers = [200, 429, 500, 404];
  const fetchImpl = usage.meter(async () => new Response('{}', { status: answers.shift() }));
  for (let i = 0; i < 4; i++) await fetchImpl('https://api.adsb.lol/v2/point/1/2/3');
  const failing = usage.meter(async () => {
    throw new Error('offline');
  });
  await assert.rejects(failing('https://adsb.lol/data/traces/x'));
  await fetchImpl.call(null, 'http://192.168.1.199/data/aircraft.json').catch(() => {});
  const { services } = usage.summary();
  assert.deepEqual(
    {
      requests: services['adsb.lol'].today.requests,
      errors: services['adsb.lol'].today.errors,
      rateLimited: services['adsb.lol'].today.rateLimited,
    },
    { requests: 5, errors: 3, rateLimited: 1 },
    '404 is an answer, not an error',
  );
  assert.equal(Object.keys(services).length, 1, 'your own receiver is not counted');
});

test('money and tokens add up by day and month, and are kept on disk', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'usage.json');
  const usage = new UsageLog({ file, log: quietLog });
  await usage.load();
  const now = new Date(2026, 9, 10, 12).getTime();
  const yesterday = now - 24 * 3600_000;
  const lastMonth = new Date(2026, 8, 28, 12).getTime();
  usage.record('anthropic', { requests: 1, costUsd: 0.00007, inputTokens: 512, outputTokens: 34 }, now);
  usage.record('anthropic', { requests: 2, costUsd: 0.00014, inputTokens: 1000, outputTokens: 70 }, yesterday);
  usage.record('anthropic', { requests: 1, costUsd: 0.5 }, lastMonth);
  usage.record('flightaware', { costUsd: 0.005 }, now);
  const s = usage.summary(now);
  assert.equal(s.today, usageDay(now));
  assert.equal(s.services.anthropic.today.requests, 1);
  assert.equal(s.services.anthropic.month.costUsd, 0.00021);
  assert.equal(s.services.anthropic.month.inputTokens, 1512);
  assert.equal(s.services.anthropic.kept.costUsd, 0.50021);
  assert.equal(s.services.anthropic.daily.length, 30);
  assert.equal(s.services.anthropic.daily.at(-1).date, usageDay(now));
  assert.equal(s.services.anthropic.daily.at(-2).requests, 2);
  assert.equal(s.services.flightaware.today.costUsd, 0.005);
  await usage.stop();

  const again = new UsageLog({ file, log: quietLog });
  await again.load();
  assert.equal(again.summary(now).services.anthropic.kept.costUsd, 0.50021);
  await again.stop();
});
