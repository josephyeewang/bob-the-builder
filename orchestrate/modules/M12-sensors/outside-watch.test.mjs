import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { watchOutside, robotMergesGreen, ROBOT_FACT, ROBOT_GREEN_MIN, STOPPED_MIN } from './outside-watch.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const TAG = 'slottag01';
const NAMES = { 'product 1': { product: 'test-product', tag: TAG } };

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
  // The outside repo's owner file: the slot tag, and a clear set at install (the first pass on a Mini latches).
  let owner = { tags: { 'product 1': TAG }, cleared: { 'product 1': new Date(T0).toISOString() } };
  const fetchJson = async (path) => {
    if (path.endsWith('/contents/robot-merges-owner.json')) { if (owner === null) throw Object.assign(new Error('x'), { status: 404 }); return { content: Buffer.from(JSON.stringify(owner)).toString('base64') }; }
    if (path.includes('/workflows/')) return { workflow_runs: runs.slice(0, 10).map(({ steps: _s, ...r }) => r) };
    const m = /\/runs\/(\d+)\/jobs/.exec(path);
    return { jobs: [{ name: 'check', steps: runs.find((r) => r.id === Number(m[1])).steps }] };
  };
  const writer = makeFactWriter(rec, { masker: makeMasker({ env: {} }) });
  const pass = () => watchOutside({ fetchJson, repo: 'owner/outside-check', homeAlerts, productAlerts, ...(names ? { writer, productNames: names } : {}), now: () => t });
  const gate = (product = 'test-product') => robotMergesGreen({ read: (i) => rec.read('fact', i)?.doc, product, now: () => t });
  return { home, p1, tick, pass, gate, fact: (p = 'test-product') => rec.read('fact', ROBOT_FACT(p))?.doc, now: () => t, stop: () => { stopped = true; }, setSteps: (s) => { steps = s; }, setOwner: (o) => { owner = o; } };
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
  const w = setup({ names: NAMES });
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
  const w = setup({ names: NAMES });
  w.setSteps(RM('success')); w.tick(20); await w.pass();
  const firstGreen = w.fact().last_green_at;
  w.setSteps(RM('failure')); w.tick(60); await w.pass();
  assert.equal(w.fact().green, false); assert.equal(w.fact().last_green_at, firstGreen);
  assert.match(w.gate().problems.join(), /not green \(step failure\)/);
  w.setSteps(RM('success')); w.tick(60); await w.pass();
  assert.equal(w.gate().open, true); assert.notEqual(w.fact().last_green_at, firstGreen);
});

test('L20 planted: no robot-merges step, no fact, a future time or an unreadable record → gate shut', async () => {
  const w = setup({ names: NAMES });
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

test('round 3 minor 5: a cancelled or timed-out run, or steps that cannot be read, raise a home alert', async () => {
  const rec = memoryRecord(); const home = fakeIssues();
  const homeAlerts = makeAlerts({ rec, gh: home, owner: 'o', now: () => new Date(T0) });
  const runs = [{ id: 1, created_at: new Date(T0 - 60e3).toISOString(), status: 'completed', conclusion: 'cancelled' }];
  let jobs = { jobs: [] };
  const fetchJson = async (path) => (path.includes('/workflows/') ? { workflow_runs: runs } : jobs);
  const pass = () => watchOutside({ fetchJson, repo: 'o/c', homeAlerts, productAlerts: {}, now: () => T0 });
  await pass();
  assert.ok([...home.issues.values()].some((i) => /did not finish/.test(i.title) && !i.closed));
  jobs = { message: 'Not Found' };
  await pass();
  assert.ok([...home.issues.values()].some((i) => /cannot read the outside check's steps/.test(i.title) && !i.closed));
});

// ---- 0b-7 audit round 4 ----
test('0b-7 audit round 4 M-2: a slot whose tag is not this product\'s (swapped, empty, or the owner file unreadable) never opens the gate', async () => {
  const w = setup({ names: { 'product 1': { product: 'real-product', tag: 'realtag01' } } });
  w.setSteps(RM('success')); w.tick(20); await w.pass();
  assert.equal(w.fact('real-product').green, false);
  assert.match(w.fact('real-product').reason, /slot tag does not match/);
  assert.equal(w.gate('real-product').open, false);
  const legacy = setup({ names: { 'product 1': 'test-product' } });
  legacy.setSteps(RM('success')); legacy.tick(20); await legacy.pass();
  assert.equal(legacy.gate().open, false, 'a name with no tag is not bound');
  const w2 = setup({ names: NAMES });
  w2.setOwner(null); w2.setSteps(RM('success')); w2.tick(20); await w2.pass();
  assert.match(w2.fact().reason, /cannot read robot-merges-owner.json/);
  assert.equal(w2.gate().open, false);
});

test('0b-7 audit round 4 M-3: two failed runs latch the gate shut; green again is not enough until the owner clears it', async () => {
  const w = setup({ names: NAMES });
  w.setSteps(RM('success')); w.tick(20); await w.pass();
  assert.equal(w.gate().open, true);
  w.setSteps(RM('failure'));
  w.tick(60); await w.pass(); await w.pass();
  assert.equal(w.fact().red_since, null, 'one failed run (seen twice) does not latch');
  w.setSteps(RM('success')); w.tick(60); await w.pass();
  assert.equal(w.gate().open, true, 'a single blip clears by itself');
  w.setSteps(RM('failure')); w.tick(60); await w.pass(); w.tick(60); await w.pass();
  const redSince = w.fact().red_since;
  assert.ok(redSince);
  // 8 days later the bad merge is out of the check's window and the step passes again: still shut.
  w.setSteps(RM('success'));
  for (let d = 0; d < 8 * 24; d++) { w.tick(60); await w.pass(); }
  assert.equal(w.fact().green, true);
  const g = w.gate();
  assert.equal(g.open, false); assert.match(g.problems.join(), /stays shut until the owner clears it/);
  w.setOwner({ tags: { 'product 1': TAG }, cleared: { 'product 1': new Date(Date.parse(redSince) - 60e3).toISOString() } });
  w.tick(60); await w.pass();
  assert.equal(w.gate().open, false, 'a clear older than the red does not count');
  w.setOwner({ tags: { 'product 1': TAG }, cleared: { 'product 1': new Date(w.now()).toISOString() } });
  w.tick(60); await w.pass();
  assert.equal(w.gate().open, true);
});

test('0b-7 audit round 4 M-3: the first pass on a Mini, or a gap of more than 5 days, latches until a clear', async () => {
  const w = setup({ names: NAMES });
  w.setOwner({ tags: { 'product 1': TAG }, cleared: {} });
  w.setSteps(RM('success')); w.tick(20); await w.pass();
  assert.match(w.gate().problems.join(), /no earlier result on this Mini/);
  w.setOwner({ tags: { 'product 1': TAG }, cleared: { 'product 1': new Date(w.now()).toISOString() } });
  w.tick(60); await w.pass();
  assert.equal(w.gate().open, true);
  w.tick(6 * 24 * 60); await w.pass();
  assert.match(w.gate().problems.join(), /saw nothing for more than 5 days/);
});
