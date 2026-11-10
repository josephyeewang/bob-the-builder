// required-keys.test.mjs — the Workshop's key list matches what the module reads (L165, L601): every key any non-test
// file reads is listed, and every listed key is read. The reader is M10's rules-reads.test-helper.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_KEYS, OPTIONAL_KEYS, policyProblems, VERCEL_PROJECT_LINE } from './required-keys.mjs';
import { vercelFact } from './git/start-gate.mjs';
import { fakeRules } from '../../shared/rules.mjs';
import { moduleReads, moduleSources } from '../M10-rules/rules-reads.test-helper.mjs';

const LIST = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
const SOURCES = moduleSources(new URL('./', import.meta.url));
const UNNAMED = {
  // Both are the Dispatcher's own keys, read through M11's KEYS from the rules handed in budget, and on M11's list:
  // minutes(budget.rules, KEYS.inReviewNoReviewerMin) and, for the plan-review cap (L735), need(budget.rules,
  // KEYS.readonlyPerSession), the same cap the Dispatcher's start gate reads (gate.mjs).
  'launcher/review-runner-main.mjs': { count: 2, why: 'KEYS.inReviewNoReviewerMin and KEYS.readonlyPerSession: the Dispatcher\'s own keys, passed in budget, on M11\'s list' },
};

test('every rules key any file in the Workshop reads is on its list, and every listed key is read (L601)', () => {
  assert.ok(SOURCES.some((s) => s.file === 'git/push.mjs') && !SOURCES.some((s) => /\.test/.test(s.file)), 'every non-test file, and no test');
  const { keys, problems } = moduleReads(SOURCES, { unnamed: UNNAMED });
  assert.deepEqual(problems, []);
  for (const k of keys) assert.ok(LIST.includes(k), `M4 reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of LIST) assert.ok(keys.has(k), `required-keys.mjs lists ${k}, which no file in the Workshop reads`);
});

// L719 m4 (L612): the go/no-go check and the start gate agree on the Vercel project. Every value the gate refuses is a
// problem here, and every value it takes is not.
test('L719: a Vercel project the start gate refuses is a go/no-go problem, and one it takes is not', () => {
  const P = 'p1';
  const gate = (v) => vercelFact({ record: { read: () => null }, kind: 'vercel_skip', product: P, vercelProject: v, now: 0 });
  const rulesWith = (v) => ({ get: (k, o) => { assert.deepEqual([k, o], ['product.vercel_project', { product: P }]); return v; } });
  for (const bad of [undefined, null, '', 7, true, ['prj_1'], { id: 'prj_1' }]) {
    assert.match(gate(bad).reason, /rules name no Vercel project/, String(bad));
    assert.deepEqual(policyProblems(rulesWith(bad), P), [VERCEL_PROJECT_LINE], JSON.stringify(bad));
  }
  for (const good of ['prj_1', 'sample-app']) {
    assert.doesNotMatch(gate(good).reason, /rules name no Vercel project/, good);
    assert.deepEqual(policyProblems(rulesWith(good), P), [], good);
  }
  assert.deepEqual(policyProblems({ get: () => { throw new Error('no rules'); } }, P), [VERCEL_PROJECT_LINE]);
  assert.deepEqual(policyProblems(fakeRules({ values: { 'product.vercel_project': 'prj_1' } }), P), []);
});
