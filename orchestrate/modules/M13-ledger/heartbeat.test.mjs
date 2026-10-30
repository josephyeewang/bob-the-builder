import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { makeAlerts, fakeIssues } from './alerts.mjs';
import { heartbeatOnce, DISPATCHER_LATE_MIN } from './heartbeat.mjs';

function setup() {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const now = () => new Date(t);
  const rec = memoryRecord();
  const gh = fakeIssues();
  const writer = makeFactWriter(rec, { actor: 'ledger', now });
  const alerts = makeAlerts({ rec, gh, owner: 'owner', now });
  const world = { lastPass: () => new Date(t - 60e3).toISOString(), rules: true, fd: true, account: { signedIn: true, login: 'account A' }, usage: null, dispatcherRunning: true };
  const probes = {
    dispatcherLastGood: async () => (world.dispatcherRunning ? new Date(t - 60e3).toISOString() : world.stoppedAt),
    rulesReadable: async () => { if (!world.rules) throw new Error('parse error'); return true; },
    frontDoorReachable: async () => world.fd,
    account: async () => world.account,
    usage: async () => world.usage,
  };
  let planned = null;
  const pass = () => heartbeatOnce({ product: 'product 1', writer, gh, alerts, owner: 'owner', probes, plannedSwitch: planned, now });
  const tick = (min) => { t += min * 60e3; };
  return { rec, gh, writer, world, pass, tick, plan: (p) => { planned = p; }, now };
}
const alertIssues = (gh) => [...gh.issues.values()].filter((i) => !/heartbeat \(pinned\)/.test(i.title));

test('all green: one pinned heartbeat issue whose body is rewritten every 10 min with mini_alive_at', async () => {
  const h = setup();
  for (let i = 0; i < 12; i++) { await h.pass(); h.tick(10); }
  assert.equal(h.gh.issues.size, 1);
  const hb = h.gh.issues.get(1);
  assert.match(hb.title, /pinned/);
  assert.match(hb.body, /^mini_alive_at: 2026-11-03T13:50:00.000Z$/m);
  assert.match(hb.body, /All green/);
  assert.equal(h.gh.calls.filter(([c]) => c === 'edit').length, 11);
});

test('stop the Dispatcher → heartbeat red and one alert; restart → cleared', async () => {
  const h = setup();
  await h.pass();
  h.world.dispatcherRunning = false; h.world.stoppedAt = h.now().toISOString();
  for (let i = 0; i < 6; i++) { h.tick(10); await h.pass(); }
  const al = alertIssues(h.gh);
  assert.equal(al.length, 1);
  assert.match(al[0].title, /red: dispatcher/);
  assert.match(h.gh.issues.get(1).body, /RED: dispatcher/);
  assert.equal(al[0].comments.length, 0, 'a changing "N minutes ago" edits silently, never comments (0b-7 audit M-3)');
  h.world.dispatcherRunning = true; h.tick(10); await h.pass();
  assert.equal(al[0].closed, true);
  assert.ok(DISPATCHER_LATE_MIN === 15);
});

test('corrupt the rules file → heartbeat red and one alert (separately from the Dispatcher)', async () => {
  const h = setup();
  h.world.rules = false;
  await h.pass(); h.tick(10); await h.pass();
  const al = alertIssues(h.gh);
  assert.deepEqual(al.map((i) => i.title), ['product 1: heartbeat red: rules']);
});

test('Front Door unreachable through the phone link → red', async () => {
  const h = setup();
  h.world.fd = false;
  const { red } = await h.pass();
  assert.deepEqual(red, ['front-door']);
});

test('sign the Mini out → one issue within 10 min, a signed_out fact, no restart loop', async () => {
  const h = setup();
  await h.pass();
  h.world.account = { signedIn: false, login: null };
  h.tick(10);
  await h.pass();
  const al = alertIssues(h.gh);
  assert.equal(al.length, 1);
  assert.match(al[0].title, /signed-out/);
  assert.equal(h.writer.get('signed-out-product-1').signed_out, true);
  const since = h.writer.get('signed-out-product-1').since;
  for (let i = 0; i < 6; i++) { h.tick(10); await h.pass(); }
  assert.equal(alertIssues(h.gh).length, 1);
  assert.equal(h.writer.get('signed-out-product-1').since, since, 'since stays at the first pass');
  h.world.account = { signedIn: true, login: 'account A' }; h.tick(10); await h.pass();
  assert.equal(h.writer.get('signed-out-product-1').signed_out, false);
});

test('planned account switch → one "switch the phone app to account B too" push request, never twice', async () => {
  const h = setup();
  await h.pass();
  h.plan({ to: 'account B', at: '2026-11-03' });
  h.world.account = { signedIn: true, login: 'account B' };
  for (let i = 0; i < 4; i++) { h.tick(10); await h.pass(); }
  const pushes = h.rec.list('fact').filter((f) => f.doc.kind === 'fact.push-request');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].doc.text, /^The Mini switched to account B: switch the phone app to account B too\.$/);
  assert.equal(alertIssues(h.gh).length, 0);
});

test('unplanned account change → an alert, no push', async () => {
  const h = setup();
  await h.pass();
  h.world.account = { signedIn: true, login: 'account C' };
  h.tick(10); await h.pass();
  assert.match(alertIssues(h.gh)[0].title, /account changed/);
  assert.equal(h.rec.list('fact').filter((f) => f.doc.kind === 'fact.push-request').length, 0);
});

test('usage warnings at 50/75/90/95: one issue per window, one comment per higher step, cleared by a new window', async () => {
  const h = setup();
  h.world.usage = { window: 'weekly', pct: 10 };
  await h.pass();
  for (const pct of [52, 55, 76, 80, 91, 96, 99]) { h.world.usage = { window: 'weekly', pct }; h.tick(10); await h.pass(); }
  const al = alertIssues(h.gh);
  assert.equal(al.length, 1);
  assert.equal(al[0].comments.length, 3, '75, 90, 95 each comment once');
  h.world.usage = { window: 'weekly', pct: 3 }; h.tick(10); await h.pass();
  assert.equal(al[0].closed, true);
});

test('no usage fact (R-0b-66 not built yet) → "usage: unknown", not red', async () => {
  const h = setup();
  const { red, body } = await h.pass();
  assert.deepEqual(red, []);
  assert.match(body, /usage: unknown/);
});

test('if the pinned issue is closed, the next pass opens a fresh one rather than editing a closed issue', async () => {
  const h = setup();
  await h.pass();
  h.gh.ownerCloses(1);
  h.tick(10); await h.pass();
  assert.equal(h.gh.issues.size, 2);
  assert.equal(h.gh.issues.get(2).closed, false);
});
