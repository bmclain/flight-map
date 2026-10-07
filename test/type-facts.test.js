import test from 'node:test';
import assert from 'node:assert/strict';
import { CURATED_TYPES } from '../server/enrich/curatedTypes.js';
import { FACT_CODES, typeFacts } from '../shared/type-facts.js';

test('every curated aircraft type has at least one fact', () => {
  const missing = Object.keys(CURATED_TYPES).filter((code) => !typeFacts(code).length);
  assert.deepEqual(missing, []);
});

test('facts are short, complete sentences with no repeats for a type', () => {
  for (const code of FACT_CODES) {
    const facts = typeFacts(code);
    assert.equal(new Set(facts).size, facts.length, `${code} repeats a fact`);
    for (const f of facts) {
      assert.ok(f.length <= 180, `${code}: too long to read at a glance (${f.length}): ${f}`);
      assert.match(f, /^[A-Z“0-9].*[.!]$/u, `${code}: not a sentence: ${f}`);
    }
  }
});

test('typeFacts merges family and variant facts and ignores case', () => {
  const max8 = typeFacts('b38m');
  assert.ok(
    max8.some((f) => f.includes('LEAP-1B')),
    'MAX facts',
  );
  assert.ok(
    max8.some((f) => f.includes('first flew in 1967')),
    '737 family facts',
  );
  assert.deepEqual(typeFacts('ZZZZ'), []);
  assert.deepEqual(typeFacts(null), []);
});
