// required-keys.test.mjs — the Workshop's key list matches what the module reads (L165, L601): every key any non-test
// file reads is listed, and every listed key is read. The reader is M10's rules-reads.test-helper.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_KEYS, OPTIONAL_KEYS, policyProblems } from './required-keys.mjs';
import { moduleReads, moduleSources } from '../M10-rules/rules-reads.test-helper.mjs';

const LIST = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
const SOURCES = moduleSources(new URL('./', import.meta.url));
const UNNAMED = {
  'launcher/review-runner-main.mjs': { count: 1, why: 'minutes(budget.rules, KEYS.inReviewNoReviewerMin): the Dispatcher\'s own key, passed in budget, on M11\'s list' },
};

test('every rules key any file in the Workshop reads is on its list, and every listed key is read (L601)', () => {
  assert.ok(SOURCES.some((s) => s.file === 'git/push.mjs') && !SOURCES.some((s) => /\.test/.test(s.file)), 'every non-test file, and no test');
  const { keys, problems } = moduleReads(SOURCES, { unnamed: UNNAMED });
  assert.deepEqual(problems, []);
  for (const k of keys) assert.ok(LIST.includes(k), `M4 reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of LIST) assert.ok(keys.has(k), `required-keys.mjs lists ${k}, which no file in the Workshop reads`);
});

test('anything but true for product.onboarded is a reason, as push.mjs refuses it (M10 says a missing key once)', () => {
  const rules = (v) => ({ flag: () => v });
  assert.equal(policyProblems(rules(false), 'p').length, 1);
  assert.deepEqual(policyProblems(rules(true), 'p'), []);
  assert.equal(policyProblems(rules(undefined), 'p').length, 1);
});
