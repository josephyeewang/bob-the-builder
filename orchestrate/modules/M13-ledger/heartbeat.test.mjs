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

test('review-0b-8 MAT-9: each pass writes the status fact the trip check reads (reachable, signed in, time)', async () => {
  const { STATUS_FACT } = await import('./heartbeat.mjs');
  const h = setup();
  await h.pass();
  const s = h.writer.get(STATUS_FACT('product 1'));
  assert.equal(s.at, '2026-11-03T12:00:00.000Z');
  assert.equal(s.front_door_reachable, true);
  assert.equal(s.signed_in, true);
  assert.equal(s.login, 'account A');
  h.world.fd = false; h.world.account = { signedIn: false }; h.tick(10);
  await h.pass();
  const s2 = h.writer.get(STATUS_FACT('product 1'));
  assert.deepEqual([s2.front_door_reachable, s2.signed_in, s2.login], [false, false, null]);
  assert.ok(s2.red.includes('front-door'));
});

// ---- L143: the new login is saved only once its change alert went out ----

// A plain alert stand-in that can lose the alert (L145): `decide(alert)` gives the raise's answer, or throws. It answers
// what the real raise answers ('opened' … or false), never `true` (L152 m1, Principle 10).
function sink(decide = () => 'opened') {
  const raise = async (a) => { raise.texts.push(a); const r = decide(a); raise.answers.push(r); return r; };
  raise.texts = []; raise.answers = [];
  raise.reset = () => { raise.texts.length = 0; raise.answers.length = 0; };
  return raise;
}
const downWhen = (cond) => (a) => { if (cond(a)) throw new Error('github down'); return 'opened'; };

// The record writer runs on its own fixed clock, apart from the heartbeat's tick (L143). `refuse` makes the record
// refuse writes to fact ids it matches.
function lossSetup(raise, refuse = () => false) {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const now = () => new Date(t);
  const base = memoryRecord();
  const rec = { read: (...a) => base.read(...a), list: (...a) => base.list(...a), write: (w) => (refuse(w.id) ? { ok: false, reason: 'refused (test)' } : base.write(w)) };
  const writer = makeFactWriter(rec, { actor: 'ledger', now: () => new Date('2026-01-01T00:00:00Z') });
  const world = { login: 'account A' };
  const probes = {
    dispatcherLastGood: async () => new Date(t - 60e3).toISOString(),
    rulesReadable: async () => true,
    frontDoorReachable: async () => true,
    account: async () => ({ signedIn: true, login: world.login }),
    usage: async () => null,
  };
  let planned = null;
  // The real clear can answer false (L143); nothing the pass saves may hang on it (L152 m1).
  const alerts = { raise, clear: async () => false };
  const pass = () => heartbeatOnce({ product: 'product 1', writer, gh: fakeIssues(), alerts, owner: 'owner', probes, plannedSwitch: planned, now });
  return { base, writer, world, pass, tick: () => { t += 10 * 60e3; }, plan: (p) => { planned = p; } };
}
const changed = (raise) => raise.texts.filter((a) => /\|heartbeat\|account-changed-/.test(a.key)).map((a) => a.key.split('-').pop());
const savedLogin = (h) => h.writer.get('heartbeat-account-product-1')?.login;

test('L143: an account change whose raise answered false keeps the old login, so the next pass raises it again', async () => {
  let lose = true;
  const raise = sink(() => (lose ? false : 'opened'));
  const h = lossSetup(raise);
  await h.pass();
  h.world.login = 'account B';
  h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account B']);
  assert.equal(savedLogin(h), 'account A');
  lose = false;
  h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account B', 'account B'], 'raised again');
  assert.equal(savedLogin(h), 'account B');
  h.tick(); await h.pass();
  assert.equal(changed(raise).length, 2, 'sent: not raised a third time');
});

test('L143: an account change whose raise threw keeps the old login', async () => {
  let down = true;
  const raise = sink(downWhen((a) => down && /account-changed/.test(a.key)));
  const h = lossSetup(raise);
  await h.pass();
  h.world.login = 'account B';
  h.tick(); await assert.rejects(h.pass(), /github down/);
  assert.equal(savedLogin(h), 'account A');
  down = false;
  h.tick(); await h.pass();
  assert.equal(changed(raise).length, 2);
  assert.equal(savedLogin(h), 'account B');
});

test('L143: a planned switch whose push request the record refused keeps the old login, so the next pass writes it', async () => {
  let refuse = true;
  const raise = sink();
  const h = lossSetup(raise, (id) => refuse && id.startsWith('push-request-'));
  await h.pass();
  h.plan({ to: 'account B', at: '2026-11-03' });
  h.world.login = 'account B';
  h.tick(); await h.pass();
  assert.equal(h.base.list('fact').filter((f) => f.doc.kind === 'fact.push-request').length, 0);
  assert.equal(savedLogin(h), 'account A');
  refuse = false;
  h.tick(); await h.pass();
  assert.equal(h.base.list('fact').filter((f) => f.doc.kind === 'fact.push-request').length, 1);
  assert.equal(savedLogin(h), 'account B');
  assert.deepEqual(changed(raise), [], 'a planned switch raises nothing');
});

// ---- L152: through the real alerts, every unplanned switch is its own notice ----

const acctIssues = (gh) => [...gh.issues.entries()].filter(([, i]) => /account changed/.test(i.title));
const notices = (gh) => gh.calls.filter(([c]) => c === 'open' || c === 'comment').length; // what notifies the owner

test('L152 MAT-1: A→B, the owner closes it, B→A, A→B again: the second A→B is a fresh notice, through the real alerts', async () => {
  const h = setup();
  await h.pass();
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(acctIssues(h.gh).length, 1);
  assert.equal(h.writer.get('heartbeat-account-product-1').login, 'account B', "the real raise answers 'opened', which is told");
  h.gh.ownerCloses(acctIssues(h.gh)[0][0]);
  h.world.account = { signedIn: true, login: 'account A' }; h.tick(10); await h.pass();
  assert.equal(acctIssues(h.gh).length, 2);
  const before = notices(h.gh);
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(notices(h.gh) - before, 1, 'the owner is told again');
  assert.equal(acctIssues(h.gh).length, 3, 'a new issue, not the one the owner closed');
  assert.match(acctIssues(h.gh)[2][1].body, /now signed in as account B \(was account A\)/);
  assert.equal(h.writer.get('heartbeat-account-product-1').login, 'account B');
  assert.equal(h.writer.get('heartbeat-account-product-1').switches, 3);
  h.tick(10); await h.pass();
  assert.equal(notices(h.gh) - before, 1, 'no switch, no notice');
});

test('L152 MAT-1: the same with the first notice left open: the second A→B opens its own issue, not a silent edit', async () => {
  const h = setup();
  await h.pass();
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  h.world.account = { signedIn: true, login: 'account A' }; h.tick(10); await h.pass();
  const before = notices(h.gh);
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(notices(h.gh) - before, 1);
  assert.equal(acctIssues(h.gh).length, 3);
  assert.equal(acctIssues(h.gh)[0][1].closed, false, 'the first notice is left as it was');
});

test('L152 MAT-1: a lost raise is retried under the same switch number, so one switch is one notice', async () => {
  const h = setup();
  await h.pass();
  const open = h.gh.open;
  h.gh.open = async (x) => (/account changed/.test(x.title) ? undefined : open(x));
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(h.writer.get('heartbeat-account-product-1').login, 'account A');
  h.gh.open = open; h.tick(10); await h.pass();
  h.tick(10); await h.pass();
  assert.equal(acctIssues(h.gh).length, 1);
  assert.deepEqual([h.writer.get('heartbeat-account-product-1').login, h.writer.get('heartbeat-account-product-1').switches], ['account B', 1]);
});

test('L152 MAT-1: a saved login from before the count (no switches field) counts from 0', async () => {
  const h = setup();
  h.writer.put('heartbeat-account-product-1', { kind: 'fact.heartbeat-account', product: 'product 1', login: 'account A' });
  h.world.account = { signedIn: true, login: 'account B' }; await h.pass();
  assert.equal(acctIssues(h.gh).length, 1);
  assert.equal(h.writer.get('heartbeat-account-product-1').switches, 1);
});

test('L152 m3: a pinned-issue open with no issue number is not saved, and the next pass opens it again', async () => {
  for (const lost of [undefined, false, null, 0, '7']) {
    const h = setup();
    const open = h.gh.open;
    h.gh.open = async (x) => (/pinned/.test(x.title) ? lost : open(x));
    await h.pass();
    assert.equal(h.writer.get('heartbeat-issue-product-1'), null, `open answered ${JSON.stringify(lost)}`);
    h.gh.open = open; h.tick(10); await h.pass();
    assert.equal(h.writer.get('heartbeat-issue-product-1').issue, 1);
    h.tick(10); await h.pass();
    assert.equal(h.gh.calls.filter(([c]) => c === 'open').length, 1, 'then edited, not opened again');
  }
});

// ---- L153: the usage and red-fact raises, lost (false, then a throw), are tried again on the next pass ----
// Through the real alerts: GitHub's open answers no issue number (raise answers false) or throws.

function lossyGh(h, match, how) {
  const st = { on: true };
  const open = h.gh.open; const comment = h.gh.comment;
  const lose = async () => { if (how === 'throw') throw new Error('github down'); return how === 'false' ? false : undefined; };
  h.gh.open = async (x) => (st.on && match.test(x.title) ? lose() : open(x));
  h.gh.comment = async (i, text) => (st.on && match.test(h.gh.issues.get(i).title) ? lose() : comment(i, text));
  return st;
}
const issuesFor = (h, re) => [...h.gh.issues.values()].filter((i) => re.test(i.title));

for (const how of ['false', 'throw']) {
  test(`L153: a usage raise whose open ${how === 'throw' ? 'threw' : 'was lost'} is raised on the next pass`, async () => {
    const h = setup();
    await h.pass();
    const st = lossyGh(h, /usage past/, how);
    h.world.usage = { window: 'weekly', pct: 60 }; h.tick(10);
    if (how === 'throw') await assert.rejects(h.pass(), /github down/); else await h.pass();
    assert.equal(issuesFor(h, /usage past/).length, 0);
    st.on = false; h.tick(10); await h.pass();
    assert.equal(issuesFor(h, /usage past/).length, 1, 'opened on the next pass');
  });

  test(`L153: a higher usage step whose comment ${how === 'throw' ? 'threw' : 'was lost'} is commented on the next pass`, async () => {
    const h = setup();
    h.world.usage = { window: 'weekly', pct: 60 }; await h.pass();
    const st = lossyGh(h, /usage past/, how === 'throw' ? 'throw' : 'false');
    h.world.usage = { window: 'weekly', pct: 80 }; h.tick(10);
    if (how === 'throw') await assert.rejects(h.pass(), /github down/); else await h.pass();
    assert.equal(issuesFor(h, /usage past/)[0].comments.length, 0);
    st.on = false; h.tick(10); await h.pass();
    assert.equal(issuesFor(h, /usage past/)[0].comments.length, 1, 'the 75 % step told on the next pass');
    h.tick(10); await h.pass();
    assert.equal(issuesFor(h, /usage past/)[0].comments.length, 1, 'and only once');
  });

  test(`L153: a red front-door raise whose open ${how === 'throw' ? 'threw' : 'was lost'} is raised on the next pass`, async () => {
    const h = setup();
    await h.pass();
    const st = lossyGh(h, /red: front-door/, how);
    h.world.fd = false; h.tick(10);
    if (how === 'throw') await assert.rejects(h.pass(), /github down/); else await h.pass();
    assert.equal(issuesFor(h, /red: front-door/).length, 0);
    st.on = false; h.tick(10); await h.pass();
    assert.equal(issuesFor(h, /red: front-door/).length, 1, 'opened on the next pass');
  });
}
