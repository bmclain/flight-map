import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySpecial, matchesEntry } from '../server/special.js';
import { DEFAULT_CONFIG, mergeConfig } from '../server/config.js';

const sps = { match: 'C-FSPS', kind: 'police', name: 'Saskatoon Police plane', alert: true };
const stars = { match: 'STAR*', kind: 'ambulance', name: 'STARS air ambulance', alert: false };

test('list entries match registration (with or without dash), callsign prefix or hex', () => {
  assert.ok(matchesEntry('C-FSPS', { hex: 'c03121', reg: 'C-FSPS', callsign: 'CFSPS' }));
  assert.ok(matchesEntry('cfsps', { hex: 'c03121', reg: null, callsign: 'CFSPS' }));
  assert.ok(matchesEntry('C03121', { hex: 'c03121' }));
  assert.ok(matchesEntry('STAR*', { hex: 'c009b6', reg: 'C-FDRP', callsign: 'STAR11' }));
  assert.ok(!matchesEntry('STAR*', { hex: 'c009b6', reg: 'C-FDRP', callsign: 'SWA11' }));
  assert.ok(!matchesEntry('C-FSP', { hex: 'c03121', reg: 'C-FSPS', callsign: 'CFSPS' }));
  assert.ok(!matchesEntry('', { hex: 'c03121' }));
});

test('your list wins, then the military flag, then operator keywords', () => {
  const ac = { hex: 'c03121', reg: 'C-FSPS', callsign: 'CFSPS' };
  assert.deepEqual(classifySpecial(ac, {}, [stars, sps]), {
    kind: 'police',
    name: 'Saskatoon Police plane',
    alert: true,
  });
  assert.equal(classifySpecial(ac, {}, []), null);
  assert.deepEqual(classifySpecial({ hex: 'ae1234' }, { military: true, ownOp: null }), {
    kind: 'military',
    name: null,
    alert: false,
  });

  const op = (ownOp, airlineName) => classifySpecial({ hex: 'c00000' }, { ownOp, airlineName })?.kind ?? null;
  assert.equal(op('SHOCK TRAUMA AIR RESCUE SERVICE'), 'ambulance');
  assert.equal(op(null, 'Saskatchewan Government Air Ambulance Service'), 'ambulance');
  assert.equal(op('THE BOARD OF POLICE COMMISSIONERS IN AND FOR THE CITY OF REGINA'), 'police');
  assert.equal(op('Government of Canada, Royal Canadian Mounted Police'), 'police');
  assert.equal(op('PROVINCE OF ONTARIO, MINISTRY OF THE SOLICITOR GENERAL (ONTARIO PROVINCIAL POLICE)'), 'police');
  assert.equal(op('SASKATCHEWAN PUBLIC SAFETY AGENCY (AIR OPERATIONS)'), 'firefighting');
  assert.equal(op(null, 'Canadian Armed Forces'), 'military');
  assert.equal(op(null, 'Transport Canada'), 'government');
  assert.equal(op('GOVERNMENT OF CANADA, DEPARTMENT OF TRANSPORT'), 'government');
  assert.equal(op(null, 'Air Canada'), null);
  assert.equal(op(null, 'Firefly'), null);
  assert.equal(op('102170826 SASKATCHEWAN LTD.'), null);
  // Shouty database names are tidied for the screen.
  assert.equal(
    classifySpecial({ hex: 'c00000' }, { ownOp: 'SHOCK TRAUMA AIR RESCUE SERVICE' }).name,
    'Shock Trauma Air Rescue Service',
  );
});

test('special aircraft list is validated', () => {
  const ok = mergeConfig(DEFAULT_CONFIG, {
    special: { aircraft: [{ match: ' c-fsps ', kind: 'police', name: ' Police plane ', alert: 1 }] },
  });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.special.aircraft, [
    { match: 'C-FSPS', kind: 'police', name: 'Police plane', alert: true },
  ]);
  // Rows not filled in yet are dropped.
  assert.deepEqual(
    mergeConfig(DEFAULT_CONFIG, { special: { aircraft: [{ match: ' ', kind: 'police' }] } }).config.special.aircraft,
    [],
  );
  for (const bad of [
    { match: 'C FSPS', kind: 'police' },
    { match: 'C-FSPS', kind: 'spaceship' },
  ]) {
    const res = mergeConfig(DEFAULT_CONFIG, { special: { aircraft: [bad] } });
    assert.equal(res.errors[0]?.field, 'special.aircraft', JSON.stringify(bad));
  }
});
