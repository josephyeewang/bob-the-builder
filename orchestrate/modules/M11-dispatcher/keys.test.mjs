// keys.test.mjs — need()'s at-least-one rule (L164 m1): a wait before something is given up on can't be 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRules } from '../../shared/rules.mjs';
import { need, minutes, MissingKey, KEYS, AT_LEAST_ONE } from './keys.mjs';

const P = 'sample-app';
const rulesWith = (values) => fakeRules({ values });

test('L164 m1: the claim and merging limits read as whole minutes, at least 1; 0, text or a fraction is missing, with the reason', () => {
  assert.deepEqual([...AT_LEAST_ONE], [KEYS.claimsStuckMin, KEYS.mergingOpenMaxMin]);
  for (const key of AT_LEAST_ONE) {
    for (const v of [1, 30, '30']) assert.equal(need(rulesWith({ [key]: v }), key, { product: P }), Number(v), `${key}: ${v}`);
    assert.equal(minutes(rulesWith({ [key]: 2 }), key, { product: P }), 120_000);
    assert.throws(() => need(rulesWith({ [key]: 0 }), key, { product: P }),
      (e) => e instanceof MissingKey && e.key === key && e.message === `the rules' ${key} is 0; it must be at least 1`);
    for (const v of ['soon', -1, 1.5, '0']) assert.throws(() => need(rulesWith({ [key]: v }), key, { product: P }), MissingKey, `${key}: ${v}`);
    assert.throws(() => need(rulesWith({}), key, { product: P }), (e) => e instanceof MissingKey && e.message === `the rules have no value for ${key}`);
  }
});

test('L164 m1: other minute limits keep 0 as a value (only the waits before giving up must be at least 1)', () => {
  assert.equal(need(rulesWith({ [KEYS.cancelGraceMin]: 0 }), KEYS.cancelGraceMin, { product: P }), 0);
});
