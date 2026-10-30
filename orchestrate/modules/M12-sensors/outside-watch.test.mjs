import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { watchOutside, robotMergesGreen, ROBOT_FACT, ROBOT_GREEN_MIN, STOPPED_MIN } from './outside-watch.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');

function setup({ names } = {}) {
  let t = T0;
  const rec = memoryRecord();
  const home = fakeIssues(); const p1 = fakeIssues();
  const homeAlerts = makeAlerts({ rec, gh: home, owner: 'o', now: () => new Date(t) });
  const productAlerts = { 'product 1': makeAlerts({ rec, gh: p1, owner: 'o', now: () => new Date(t) }) };
  // The outside check runs hourly at :17 until stopped; each run's steps come from `steps`.
  const runs = []; let steps = [{ name: 'product 1 / heartbeat', conclusion: 'success' }];
  let stopped = false; let id = 0;
  const tick = (min) => {
    for (let i = 0; i < min; i++) {
      t += 60e3;
      if (!stopped && new Date(t).getUTCMinutes() === 17) runs.unshift({ id: ++id, created_at: new Date(t).toISOString(), status: 'completed', steps: steps.map((s) => ({ ...s })) });
    }
  };
  const fetchJson = async (path) => {
    if (path.includes('/workflows/')) return { workflow_runs: runs.slice(0, 10).map(({ steps: _s, ...r }) => r) };
    const m = /\/runs\/(\d+)\/jobs/.exec(path);
    return { jobs: [{ name: 'check', steps: runs.find((r) => r.id === Number(m[1])).steps }] };
  };
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  const pass = () => watchOutside({ fetchJson, repo: 'owner/outside-check', homeAlerts, productAlerts, ...(names ? { writer, productNames: names } : {}), now: () => t });
  const gate = (product = 'test-product') => robotMergesGreen({ read: (i) => rec.read('fact', i)?.doc, product, now: () => t });
  return { home, p1, tick, pass, gate, fact: (p = 'test-product') => rec.read('fact', ROBOT_FACT(p))?.doc, now: () => t, stop: () => { stopped = true; }, setSteps: (s) => { steps = s; } };
}

test('stop the check on purpose → the Mini alerts within ~2 h (10-minute passes), once', async () => {
  const w = setup();
  w.tick(60);
  await w.pass();
  assert.equal(w.home.issues.size, 0);
  w.stop();
  let alertedAt = null;
  for (let m = 10; m <= 240; m += 10) {
    w.tick(10);
    await w.pass();
    if (alertedAt === null && w.home.issues.size) alertedAt = m;
  }
  assert.ok(alertedAt !== null && alertedAt <= 120, `alerted after ${alertedAt} min`);
  assert.equal(w.home.issues.size, 1, 'one issue, updated, not one per pass');
  assert.equal(w.home.issues.get(1).comments.length, 0, 'the growing age edits silently, never comments (0b-7 audit M-3)');
  assert.match(w.home.issues.get(1).title, /stopped/);
  assert.ok(STOPPED_MIN < 120);
});

test('a failing check step opens a robot issue in that product\'s repo; passing again closes it', async () => {
  const w = setup();
  w.setSteps([{ name: 'product 1 / heartbeat', conclusion: 'failure' }, { name: 'product 1 / deploys', conclusion: 'success' }, { name: 'product 2 / heartbeat', conclusion: 'failure' }]);
  w.tick(60);
  for (let i = 0; i < 6; i++) { await w.pass(); w.tick(10); }
  assert.equal(w.p1.issues.size, 1);
  assert.match(w.p1.issues.get(1).title, /heartbeat/);
  assert.equal(w.home.issues.size, 0, 'product 2 has no repo in config: nothing raised anywhere');
  w.setSteps([{ name: 'product 1 / heartbeat', conclusion: 'success' }]);
  w.tick(60); await w.pass();
  assert.equal(w.p1.issues.get(1).closed, true);
});

test('no run at all → stopped alert', async () => {
  const w = setup();
  w.stop();
  await w.pass();
  assert.equal(w.home.issues.size, 1);
  assert.match(w.home.issues.get(1).body, /no scheduled run/);
});

// ---- robot-merges last-green fact (lead calls L19, L20) ----
const RM = (c) => [{ name: 'product 1 / heartbeat', conclusion: 'success' }, { name: 'product 1 / robot-merges', conclusion: c }];

test('L20: a green robot-merges step writes last_green_at; the Merge Gate opens, then shuts 2 h after the check stops', async () => {
  const w = setup({ names: { 'product 1': 'test-product' } });
  w.setSteps(RM('success'));
  w.tick(20); await w.pass();
  const f = w.fact();
  assert.equal(f.green, true); assert.equal(f.last_green_at, f.run_at);
  assert.equal(w.gate().open, true);
  w.stop();
  w.tick(ROBOT_GREEN_MIN - 10); await w.pass();
  assert.equal(w.gate().open, true);
  w.tick(15); await w.pass();
  const g = w.gate();
  assert.equal(g.open, false); assert.match(g.problems.join(), /more than 120 min/);
});

test('L20 planted: a failed step → green:false, earlier last_green_at kept, gate shut at once; green again reopens', async () => {
  const w = setup({ names: { 'product 1': 'test-product' } });
  w.setSteps(RM('success')); w.tick(20); await w.pass();
  const firstGreen = w.fact().last_green_at;
  w.setSteps(RM('failure')); w.tick(60); await w.pass();
  assert.equal(w.fact().green, false); assert.equal(w.fact().last_green_at, firstGreen);
  assert.match(w.gate().problems.join(), /not green \(step failure\)/);
  w.setSteps(RM('success')); w.tick(60); await w.pass();
  assert.equal(w.gate().open, true); assert.notEqual(w.fact().last_green_at, firstGreen);
});

test('L20 planted: no robot-merges step, no fact, a future time or an unreadable record → gate shut', async () => {
  const w = setup({ names: { 'product 1': 'test-product' } });
  w.tick(20); await w.pass();
  assert.equal(w.fact().green, false); assert.equal(w.fact().last_green_at, null);
  assert.match(w.gate().problems.join(), /no robot-merges step/); assert.match(w.gate().problems.join(), /never green/);
  assert.match(w.gate('other').problems.join(), /no fact yet/);
  const fut = { green: true, last_green_at: new Date(w.now() + 3600e3).toISOString() };
  assert.match(robotMergesGreen({ read: () => fut, product: 'x', now: w.now }).problems.join(), /future/);
  assert.equal(robotMergesGreen({ read: () => { throw new Error('x'); }, product: 'x' }).open, false);
});

test('without a writer the watch writes no fact (alerts unchanged)', async () => {
  const w = setup();
  w.setSteps(RM('success')); w.tick(20); await w.pass();
  assert.equal(w.fact(), undefined);
});
