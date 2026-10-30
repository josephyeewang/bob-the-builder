import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { watchOutside, STOPPED_MIN } from './outside-watch.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');

function setup() {
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
  const pass = () => watchOutside({ fetchJson, repo: 'owner/outside-check', homeAlerts, productAlerts, now: () => t });
  return { home, p1, tick, pass, stop: () => { stopped = true; }, setSteps: (s) => { steps = s; } };
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
