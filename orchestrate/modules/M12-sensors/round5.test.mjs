// round5.test.mjs — planted cases for the 0b-7 audit round 5 findings (the robot-merges latch and count-like names).
// Each test fails on the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { watchOutside, robotMergesGreen, ROBOT_FACT, NO_PUSH_FACT } from './outside-watch.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';
import { FAKE } from './fakes.mjs';

const TAG = 'slottag01';
// One outside-check run an hour (a call to run()); the Mini's pass is a call to pass().
function world(cleared) {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const rec = memoryRecord();
  const mk = () => makeAlerts({ rec, gh: fakeIssues(), owner: 'o', now: () => new Date(t) });
  const homeAlerts = mk(); const productAlerts = { 'product 1': mk() };
  const runs = []; let id = 0; let conc = 'success'; let jobsBroken = false;
  const owner = { tags: { 'product 1': TAG }, cleared };
  const fetchJson = async (path) => {
    if (path.endsWith('/contents/robot-merges-owner.json')) return { content: Buffer.from(JSON.stringify(owner)).toString('base64') };
    if (path.includes('/workflows/')) return { workflow_runs: runs.slice(0, 10).map(({ c: _c, ...r }) => r) };
    if (jobsBroken) throw Object.assign(new Error('rate limited'), { status: 403 });
    const r = runs.find((x) => x.id === Number(/\/runs\/(\d+)\/jobs/.exec(path)[1]));
    return { jobs: [{ name: 'check', steps: [{ name: 'product 1 / robot-merges', conclusion: r.c }, { name: 'product 1 / repo-guard', conclusion: 'success' }] }] };
  };
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  const productNames = { 'product 1': { product: 'real-product', tag: TAG } };
  return {
    run: () => { t += 60 * 60e3; runs.unshift({ id: ++id, created_at: new Date(t - 60e3).toISOString(), status: 'completed', conclusion: conc === 'success' ? 'success' : 'failure', c: conc }); },
    pass: () => watchOutside({ fetchJson, repo: 'o/c', homeAlerts, productAlerts, writer, productNames, now: () => t }),
    gate: () => robotMergesGreen({ read: (i) => (i === NO_PUSH_FACT ? { green: true, at: new Date(t).toISOString() } : rec.read('fact', i)?.doc), product: 'real-product', now: () => t }),
    fact: () => rec.read('fact', ROBOT_FACT('real-product'))?.doc,
    clearNow: () => { owner.cleared = { 'product 1': new Date(t).toISOString() }; },
    set: (c) => { conc = c; }, breakJobs: (b) => { jobsBroken = b; }, tick: (m) => { t += m * 60e3; },
  };
}

test('0b-7 audit round 5 MAT-1: a cleared time written before the Mini noticed never opens a first-pass latch', async () => {
  const w = world({ 'product 1': '2026-09-01T00:00:00Z' });
  w.run(); await w.pass();
  assert.equal(w.gate().open, false);
  assert.match(w.gate().problems.join(), /no earlier result on this Mini/);
  w.run(); await w.pass();
  assert.equal(w.gate().open, false, 'still shut on the next green run');
  w.clearNow(); w.run(); await w.pass();
  assert.equal(w.gate().open, true, 'a clear after the Mini noticed opens it');
});

test('0b-7 audit round 5 MAT-2: an unread or skipped step between failed runs does not reset the count', async () => {
  for (const between of ['unread', 'skipped']) {
    const w = world({}); w.run(); await w.pass(); w.clearNow(); w.run(); await w.pass();
    assert.equal(w.gate().open, true, between);
    for (let h = 0; h < 3; h++) {
      w.set('failure'); w.run(); await w.pass();
      if (between === 'unread') { w.tick(10); w.breakJobs(true); await w.pass(); w.breakJobs(false); }
      else { w.set('skipped'); w.run(); await w.pass(); }
    }
    assert.ok(w.fact().red_since, `${between}: latched`);
    w.set('success'); w.run(); await w.pass();
    assert.equal(w.gate().open, false, `${between}: green again is not enough without a clear`);
  }
});

test('0b-7 audit round 5 MAT-3: more than 5 days between outside-check runs latches even while the Mini kept passing', async () => {
  const w = world({}); w.run(); await w.pass(); w.clearNow(); w.run(); await w.pass();
  assert.equal(w.gate().open, true);
  for (let i = 0; i < 8 * 24 * 6; i++) { w.tick(10); await w.pass(); }
  w.run(); await w.pass();
  assert.equal(w.gate().open, false);
  assert.match(w.gate().problems.join(), /more than 5 days between outside-check runs/);
});

test('0b-7 audit round 5 MAT-4: text under a count-like secret name is masked; numbers there are kept', () => {
  const { maskDeep } = makeMasker({ env: {} });
  const plain = 'hunter2'.repeat(2) + 'xx';
  for (const k of ['access_tokens', 'refresh_tokens', 'api_tokens', 'tokens_vercel', 'secret_count_x']) {
    for (const v of [plain, FAKE.dbPassword]) assert.equal(maskDeep({ [k]: v })[k], '[REDACTED:named-key]', k);
  }
  assert.equal(maskDeep({ input_tokens: 1234 }).input_tokens, 1234);
  assert.equal(maskDeep({ token_count: '42' }).token_count, '42');
});

test('0b-7 audit round 5 minor 4: a fact written under another product name that shares the id never opens this gate', () => {
  const doc = { product: 'a.b', green: true, red_since: null, last_green_at: new Date(1e12).toISOString() };
  const np = { green: true, at: new Date(1e12).toISOString() };
  const read = (i) => (i === NO_PUSH_FACT ? np : doc);
  const g = robotMergesGreen({ read, product: 'a-b', now: () => 1e12 });
  assert.equal(g.open, false);
  assert.equal(robotMergesGreen({ read, product: 'a.b', now: () => 1e12 }).open, true);
});
