import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter, TROUBLE_SOURCES } from '../M12-sensors/facts.mjs';
import { makeAlerts, fakeIssues } from './alerts.mjs';
import { heartbeatOnce, DISPATCHER_LATE_MIN, STATUS_FACT } from './heartbeat.mjs';

// `wrap` lets a test change what the pass reads from the record (#98 r2 P6: a saved record with no time).
function setup({ wrap = (w) => w, alertWrap = (w) => w } = {}) {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const now = () => new Date(t);
  const rec = memoryRecord();
  const gh = fakeIssues({ now });
  const writer = wrap(makeFactWriter(rec, { actor: 'ledger', now }));
  const alerts = makeAlerts({ rec, gh, owner: 'owner', now, writer: alertWrap(makeFactWriter(rec, { actor: 'ledger', now })) });
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
  return { rec, gh, writer, world, probes, pass, tick, plan: (p) => { planned = p; }, now };
}
const refusingPin = (world) => (w) => ({ get: w.get, put: (id, doc, kind) => (world.refuse && doc.kind === 'fact.heartbeat-issue' ? { ok: false, reason: 'the store is full' } : w.put(id, doc, kind)) });
const pinnedIssues = (gh) => [...gh.issues.values()].filter((i) => /heartbeat \(pinned\)/.test(i.title));
const alertIssues = (gh) => [...gh.issues.values()].filter((i) => !/heartbeat \(pinned\)/.test(i.title));

test('all green: one pinned heartbeat issue whose body is rewritten every 10 min with mini_alive_at', async () => {
  const h = setup();
  h.world.usage = { window: 'weekly', pct: 10 }; // every line known: all green needs a usage reading too (L730 M2)
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

test('no usage fact (R-0b-66 not built yet) → "usage: unknown", not red, and never all green (L730 #289 M2)', async () => {
  const h = setup();
  const { red, body } = await h.pass();
  assert.deepEqual(red, []);
  assert.match(body, /usage: unknown/);
  // Audit probe B: everything else current, no usage reading. Not known is never a pass.
  assert.doesNotMatch(body, /ok {4}usage/);
  assert.doesNotMatch(body, /All green/);
  assert.match(body, /Nothing red; not known: usage\./);
  assert.equal(h.writer.get(STATUS_FACT('product 1')).usage ?? null, null);
  assert.equal(alertIssues(h.gh).length, 0);
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
  const reported = [];
  const alerts = { raise, clear: async () => false, cacheTrouble: () => null, reportTrouble: async (...a) => { reported.push(a); return 'none'; } };
  // One GitHub for the whole test: a fresh one per pass forgot the pinned issue the last pass opened (the strict
  // read found it, #98 r1 m2).
  const gh = fakeIssues();
  const pass = () => heartbeatOnce({ product: 'product 1', writer, gh, alerts, owner: 'owner', probes, plannedSwitch: planned, now });
  return { base, writer, world, pass, reported, tick: () => { t += 10 * 60e3; }, plan: (p) => { planned = p; } };
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

const pushReqs = (h) => h.rec.list('fact').filter((f) => f.doc.kind === 'fact.push-request');
const acctRec = (h) => h.writer.get('heartbeat-account-product-1');

test('L158 MAT-A: a plan to B that stays in config: A→B pushes, B→A alerts, A→B again pushes again, through the real alerts', async () => {
  const h = setup();
  h.plan({ to: 'account B', at: '2026-11-03T11:00:00Z' });
  await h.pass();
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(pushReqs(h).length, 1);
  h.world.account = { signedIn: true, login: 'account A' }; h.tick(10); await h.pass();
  assert.equal(acctIssues(h.gh).length, 1, 'B→A was not planned: an alert');
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(pushReqs(h).length, 2, 'the second A→B is its own push request, not the first one found again');
  assert.deepEqual([acctRec(h).login, acctRec(h).switches], ['account B', 3], 'every switch, planned or not, is counted');
  for (let i = 0; i < 3; i++) { h.tick(10); await h.pass(); }
  assert.equal(pushReqs(h).length, 2, 'no switch, no push');
  assert.equal(acctRec(h).switches, 3);
});

test('L158 m1: A → signed out → B is one notice and one counted switch, through the real alerts', async () => {
  const h = setup();
  await h.pass();
  h.world.account = { signedIn: false }; h.tick(10); await h.pass();
  assert.equal(acctRec(h).login, 'account A', 'a signed-out pass leaves the saved login alone');
  const before = acctIssues(h.gh).length;
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(acctIssues(h.gh).length - before, 1);
  assert.match(acctIssues(h.gh).at(-1)[1].body, /now signed in as account B \(was account A\)/);
  assert.deepEqual([acctRec(h).login, acctRec(h).switches], ['account B', 1]);
});

test('L158 m3: a count lost to a rewrite (an older build, a hand edit) never reuses a closed alert: the next A→B is told', async () => {
  for (const lost of [{}, { switches: 0 }, { switches: 'x' }]) {
    const h = setup();
    await h.pass();
    h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
    h.gh.ownerCloses(acctIssues(h.gh)[0][0]);
    h.writer.put('heartbeat-account-product-1', { kind: 'fact.heartbeat-account', product: 'product 1', login: 'account A', ...lost });
    const before = notices(h.gh);
    h.tick(10); await h.pass();
    assert.equal(notices(h.gh) - before, 1, `rewritten with ${JSON.stringify(lost)}: the owner is told`);
    assert.equal(acctIssues(h.gh).length, 2, 'a new issue, not the closed one answering "suppressed"');
    assert.equal(acctRec(h).login, 'account B');
  }
});

test('#98 r2 Minor 1 (P6): a record with no time, or not a time, and its count lost, twice: the second A→B is still told', async () => {
  for (const ts of [undefined, 'not a time', '[REDACTED:wrong-shape]']) {
    // The pass reads the account record without its time (or with a wrong one), as an older build or a hand edit leaves it.
    const wrap = (w) => ({ put: w.put, get: (id) => {
      const d = w.get(id);
      if (!d || !id.startsWith('heartbeat-account-')) return d;
      const { ts: _drop, ...rest } = d;
      return ts === undefined ? rest : { ...rest, ts };
    } });
    const h = setup({ wrap });
    await h.pass();
    for (let round = 1; round <= 2; round++) {
      h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
      assert.equal(acctIssues(h.gh).length, round, `ts ${ts}, round ${round}: a new issue, not the closed one answering "suppressed"`);
      h.gh.ownerCloses(acctIssues(h.gh).at(-1)[0]);
      // The count is lost too, and the login is back to A.
      h.writer.put('heartbeat-account-product-1', { kind: 'fact.heartbeat-account', product: 'product 1', login: 'account A' });
      h.world.account = { signedIn: true, login: 'account A' };
    }
  }
});

test('L158 m3: the same on the planned path: a lost count with the plan still standing pushes the next A→B again', async () => {
  const h = setup();
  h.plan({ to: 'account B', at: '2026-11-03T11:00:00Z' });
  await h.pass();
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  assert.equal(pushReqs(h).length, 1);
  h.writer.put('heartbeat-account-product-1', { kind: 'fact.heartbeat-account', product: 'product 1', login: 'account A' });
  h.tick(10); await h.pass();
  assert.equal(pushReqs(h).length, 2, 'not the first switch\'s push request found again');
  assert.equal(acctRec(h).login, 'account B');
});

test('L158 m3: an alert that went out but whose account save was refused is retried under the same key, so one switch is one notice', async () => {
  let refuse = false;
  const raise = sink();
  const h = lossSetup(raise, (id) => refuse && /^heartbeat-account-/.test(id));
  await h.pass();
  h.world.login = 'account B'; refuse = true; h.tick(); await h.pass();
  assert.equal(savedLogin(h), 'account A', 'the save was refused');
  refuse = false; h.tick(); await h.pass();
  const keys = raise.texts.filter((a) => /\|heartbeat\|account-changed-/.test(a.key)).map((a) => a.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'the retry finds the same alert (a silent repeat), not a second notice');
  assert.equal(savedLogin(h), 'account B');
});

test('#98 r2 Minor 2 (P15): a planned switch whose push went out but whose account save was refused: the retry saves B, and a later B→A alerts', async () => {
  let refuse = false;
  const raise = sink();
  const h = lossSetup(raise, (id) => refuse && /^heartbeat-account-/.test(id));
  h.plan({ to: 'account B', at: '2026-11-03' });
  await h.pass();
  h.world.login = 'account B'; refuse = true; h.tick(); await h.pass();
  const pushes = () => h.base.list('fact').filter((f) => f.doc.kind === 'fact.push-request').length;
  assert.equal(pushes(), 1, 'the push request was written');
  assert.equal(savedLogin(h), 'account A', 'the save was refused');
  refuse = false; h.tick(); await h.pass();
  assert.equal(pushes(), 1, 'the retry finds the same push request, so one switch is one push');
  assert.equal(savedLogin(h), 'account B', 'an existing push request counts as told, so the retry saves B');
  h.world.login = 'account A'; h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account A'], 'B→A was not planned: one alert');
  assert.equal(savedLogin(h), 'account A');
});

test('L158 m2: a saved pinned issue that is not an issue number reopens without asking GitHub about it', async () => {
  for (const bad of ['[REDACTED:wrong-shape]', '7', 0, -1, 1.5, null]) {
    const h = setup();
    h.writer.put('heartbeat-issue-product-1', { kind: 'fact.heartbeat-issue', product: 'product 1', issue: bad });
    const asked = [];
    const { read } = h.gh;
    h.gh.read = async (i) => { asked.push(i); return read(i); };
    await h.pass();
    assert.deepEqual(asked, [], `issue ${JSON.stringify(bad)}: never asked`);
    assert.equal(h.gh.calls.filter(([c]) => c === 'open').length, 1, 'opened a fresh pinned issue');
    assert.equal(h.writer.get('heartbeat-issue-product-1').issue, 1);
  }
});

test('L158 m2: the stand-in GitHub refuses questions that are not about an issue number, and an issue it never opened is gone', async () => {
  const gh = fakeIssues();
  assert.equal(await gh.read(1), null);
  await assert.rejects(gh.read('[REDACTED:wrong-shape]'), /not an issue number/);
  const i = await gh.open({ title: 't', body: 'b' });
  assert.equal((await gh.read(i)).open, true);
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

// ---- P11 (L166): a notice went out, its account save was refused, and the Mini switched back before the retry ----

const toldLogin = (h) => h.writer.get('heartbeat-product-1')?.login_told;

test('P11: A→B told but its save refused, then back to A within 10 min: the switch back is told, once', async () => {
  let refuse = false;
  const raise = sink();
  const h = lossSetup(raise, (id) => refuse && /^heartbeat-account-/.test(id));
  await h.pass();
  h.world.login = 'account B'; refuse = true; h.tick(); await h.pass();
  assert.equal(savedLogin(h), 'account A', 'the save was refused');
  assert.equal(toldLogin(h), 'account B', 'the owner was told B');
  refuse = false; h.world.login = 'account A'; h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account B', 'account A'], 'the switch back is its own notice');
  assert.match(raise.texts.at(-1).body, /signed in as account A \(was account B\)/);
  h.tick(); await h.pass(); h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account B', 'account A'], 'and only once');
  assert.deepEqual([savedLogin(h), toldLogin(h)], ['account A', 'account A']);
});

test('P11: the switch-back notice is lost (raise answers false): the next pass tells it again under the same key', async () => {
  let refuse = false; let lose = false;
  const raise = sink((a) => (lose && /account-changed-/.test(a.key) ? false : 'opened'));
  const h = lossSetup(raise, (id) => refuse && /^heartbeat-account-/.test(id));
  await h.pass();
  h.world.login = 'account B'; refuse = true; h.tick(); await h.pass();
  refuse = false; lose = true; h.world.login = 'account A'; h.tick(); await h.pass();
  assert.equal(toldLogin(h), 'account B', 'a lost notice leaves what the owner heard');
  lose = false; h.tick(); await h.pass();
  const keys = raise.texts.filter((a) => /account-changed-/.test(a.key)).map((a) => a.key);
  assert.equal(keys.length, 3);
  assert.equal(keys[1], keys[2], 'the resend is the same notice');
  assert.equal(toldLogin(h), 'account A');
  h.tick(); await h.pass();
  assert.equal(raise.texts.filter((a) => /account-changed-/.test(a.key)).length, 3);
});

test('P11: a planned A→B whose push went out but whose save was refused, then back to A: one alert (A was not planned)', async () => {
  let refuse = false;
  const raise = sink();
  const h = lossSetup(raise, (id) => refuse && /^heartbeat-account-/.test(id));
  h.plan({ to: 'account B', at: '2026-11-03' });
  await h.pass();
  h.world.login = 'account B'; refuse = true; h.tick(); await h.pass();
  refuse = false; h.world.login = 'account A'; h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account A']);
  assert.match(raise.texts.at(-1).body, /\(was account B\)/);
});

test('P11: a B the owner never heard of (its raise answered false), then back to A: nothing to tell', async () => {
  const raise = sink((a) => (/account-changed-/.test(a.key) ? false : 'opened'));
  const h = lossSetup(raise);
  await h.pass();
  h.world.login = 'account B'; h.tick(); await h.pass();
  assert.equal(toldLogin(h), 'account A');
  h.world.login = 'account A'; h.tick(); await h.pass(); h.tick(); await h.pass();
  assert.deepEqual(changed(raise), ['account B'], 'only the lost B, no A');
});

test('P11: A→B told, save refused, signed out, then A: the owner still hears it is A again, through the real alerts', async () => {
  const { STATUS_FACT } = await import('./heartbeat.mjs');
  const h = setup({ wrap: (w) => ({ get: (id) => w.get(id), put: (id, doc) => (/^heartbeat-account-/.test(id) && doc.login === 'account B' ? { ok: false } : w.put(id, doc)) }) });
  await h.pass();
  h.world.account = { signedIn: true, login: 'account B' }; h.tick(10); await h.pass();
  h.world.account = { signedIn: false }; h.tick(10); await h.pass();
  assert.equal(h.writer.get(STATUS_FACT('product 1')).login_told, 'account B', 'kept while signed out');
  h.world.account = { signedIn: true, login: 'account A' }; h.tick(10); await h.pass();
  const changes = alertIssues(h.gh).filter((i) => /account changed/.test(i.title));
  assert.equal(changes.length, 2, changes.map((i) => i.body).join(' / '));
  assert.match(changes[1].body, /signed in as account A \(was account B\)/);
});

// L393: the pinned issue's number is what stops a new issue each pass, so a refused save is found again by its marker.
test('L393: a pinned issue whose number the Record refused: one issue over many passes, red on it, and the number saved once it takes it', async () => {
  const world = { refuse: true };
  const h = setup({ wrap: refusingPin(world) });
  for (let i = 0; i < 6; i++) {
    const r = await h.pass();
    assert.ok(r.red.includes('alert-not-saved'));
    h.tick(10);
  }
  assert.equal(pinnedIssues(h.gh).length, 1);
  assert.match(pinnedIssues(h.gh)[0].body, /RED +alerts: the Record refused to save the pinned issue's number: the store is full/);
  world.refuse = false;
  const r = await h.pass();
  assert.deepEqual(r.red, []);
  assert.equal(pinnedIssues(h.gh).length, 1);
  assert.doesNotMatch(pinnedIssues(h.gh)[0].body, /RED/);
  assert.doesNotMatch(r.body, /orch:heartbeat/, 'the marker is on the post, not in what the pass answers');
});

test('L393: a list GitHub refuses opens no pinned issue this pass; the next one does', async () => {
  const h = setup();
  const findOpen = h.gh.findOpen;
  h.gh.findOpen = async () => false;
  await h.pass();
  assert.equal(pinnedIssues(h.gh).length, 0);
  h.gh.findOpen = findOpen;
  h.tick(10);
  await h.pass();
  assert.equal(pinnedIssues(h.gh).length, 1);
});

// L402: alerts the owner can't be told show on the pinned issue, since an alert is what failed.
const NOT_TOLD = 'alert-not-told';

test('L402 owed: a notice stuck on a failed read is red on every pass, with GitHub\'s answer, and one comment over them all', async () => {
  const h = setup();
  h.world.usage = { window: 'weekly', pct: 60 };
  await h.pass();
  h.world.usage = { window: 'weekly', pct: 80 }; h.tick(10);
  const usage = issuesFor(h, /usage past/)[0];
  const { edit, latestOwnComment } = h.gh;
  let n = 0;
  h.gh.edit = async (i, b) => { if (h.gh.issues.get(i) === usage) { n += 1; if (n === 2) return false; } return edit(i, b); };
  assert.ok((await h.pass()).red.includes(NOT_TOLD), 'the note went out, its last edit did not');
  h.gh.edit = edit;
  h.gh.lastAnswer = 'GitHub answered 403 to GET /issues/1/comments';
  h.gh.latestOwnComment = async () => false;
  for (let i = 0; i < 3; i++) {
    h.tick(10);
    const r = await h.pass();
    assert.ok(r.red.includes(NOT_TOLD), `pass ${i}`);
    assert.match(r.body, /RED +alerts: GitHub answered 403 to GET \/issues\/1\/comments; the next pass tries again/);
    assert.match(pinnedIssues(h.gh)[0].body, /RED: .*alert-not-told/);
  }
  assert.equal(usage.comments.length, 1);
  h.gh.latestOwnComment = latestOwnComment;
  h.tick(10);
  assert.deepEqual((await h.pass()).red, []);
  assert.equal(usage.comments.length, 1, 'found on GitHub, so not sent twice');
  h.tick(10);
  assert.doesNotMatch(pinnedIssues(h.gh)[0].body, /RED/);
});

test('r4 m2: a robot login that could not be read is red on the pinned issue, with why', async () => {
  const h = setup();
  h.gh.loginTrouble = 'the robot\'s own login could not be read (GitHub answered 401), so any bot\'s issue counts';
  const { red, body } = await h.pass();
  assert.ok(red.includes('robot-login-unknown'));
  assert.match(body, /RED +alerts: the robot's own login could not be read/);
  h.gh.loginTrouble = null;
  h.tick(10);
  assert.ok(!(await h.pass()).red.includes('robot-login-unknown'));
});

test('r5 m1: a client that only learns the login on its first call: the first check of the pass still shows it red', async () => {
  const h = setup();
  h.gh.loginTrouble = null;
  h.gh.ready = async () => { h.gh.loginTrouble = 'the robot\'s own login could not be read (GitHub answered 401)'; };
  const { red, body } = await h.pass();
  assert.ok(red.includes('robot-login-unknown'));
  assert.match(body, /RED +alerts: the robot's own login could not be read/);
});

test('r5 m2: the heartbeat reports the Record\'s trouble under its own name', async () => {
  const h = lossSetup(sink(() => 'opened'));
  await h.pass();
  assert.deepEqual(h.reported, [['product 1', TROUBLE_SOURCES.HEARTBEAT]]);
});

test('L402: any alert lost shows red once a pass, with no reason given or several lost', async () => {
  const h = lossSetup(sink(() => false));
  h.world.fd = false;
  const { red, body } = await h.pass();
  assert.equal(red.filter((k) => k === NOT_TOLD).length, 1);
  assert.match(body, /RED +alerts: GitHub lost an alert; the next pass tries again/);
});

test('L402: the Record refusing alert writes: red on the pinned issue every pass, one alert from the second on, and both go when it recovers', async () => {
  const world = { refuse: true };
  const h = setup({ alertWrap: (w) => ({ get: w.get, put: (id, doc) => (world.refuse && doc.kind === 'fact.alert' ? { ok: false, reason: 'the store is full' } : w.put(id, doc)) }) });
  await h.pass();
  h.world.fd = false; h.tick(10);
  const first = await h.pass();
  assert.ok(first.red.includes('alert-not-saved'));
  assert.match(first.body, /RED +alerts: the Record refused to save where an alert is: the store is full/);
  for (let i = 0; i < 3; i++) { h.tick(10); await h.pass(); }
  assert.equal(issuesFor(h, /refusing alert writes/).length, 1);
  assert.equal(issuesFor(h, /red: front-door/).length, 1, 'found on GitHub each pass');
  world.refuse = false; h.tick(10);
  const r = await h.pass();
  assert.ok(!r.red.includes('alert-not-saved'));
  assert.equal(issuesFor(h, /refusing alert writes/)[0].closed, true);
  assert.equal(issuesFor(h, /red: front-door/).length, 1);
});

test('L604: a probe that answers null says not known: no alert, no signed-out fact, and not "All green"', async () => {
  const h = setup();
  h.world.fd = null; h.world.account = null;
  await h.pass();
  const s = h.writer.get(STATUS_FACT('product 1'));
  assert.deepEqual([s.front_door_reachable, s.signed_in, s.login, s.red], [null, null, null, []]);
  assert.ok(!h.writer.get('signed-out-product-1'));
  const [{ body }] = pinnedIssues(h.gh);
  assert.match(body, /Nothing red; not known: front door, account, usage\./);
  assert.doesNotMatch(body, /All green/);
  assert.match(body, /Front Door reachable from the phone: unknown/);
  assert.match(body, /signed-in account: unknown/);
  assert.equal(alertIssues(h.gh).length, 0);
});

test('L604: signed out and then not known: the fact and its alert stay as they were', async () => {
  const h = setup();
  h.world.account = { signedIn: false, login: null };
  await h.pass();
  h.world.account = null; h.tick(10); await h.pass();
  assert.equal(h.writer.get('signed-out-product-1').signed_out, true);
  assert.deepEqual(alertIssues(h.gh).map((i) => i.closed), [false]);
});

test('L604: a probe that throws is still red, not unknown', async () => {
  const h = setup();
  h.probes.frontDoorReachable = async () => { throw new Error('broken'); };
  await h.pass();
  const s = h.writer.get(STATUS_FACT('product 1'));
  assert.equal(s.front_door_reachable, false);
  assert.ok(s.red.includes('front-door'));
});

// ── L730 (#289 r1): one rule for "late", the stop in the status, told per alert ───────────────────────────────────────

test('L730 m2: with a dispatcherLate answer, that one rule decides: a live pass inside its limit is not red', async () => {
  const h = setup();
  h.world.usage = { window: 'weekly', pct: 10 };
  let late = null;
  h.probes.dispatcherLate = async () => late;
  // Audit probe D: the last full pass is 20 minutes old, and a live pass holds the lock (the caller's rule says on time).
  h.world.dispatcherRunning = false; h.world.stoppedAt = new Date(h.now().getTime() - 20 * 60e3).toISOString();
  const r = await h.pass();
  assert.ok(!r.red.includes('dispatcher'), JSON.stringify(r.red));
  assert.equal(alertIssues(h.gh).length, 0, 'no "heartbeat red: dispatcher" issue');
  assert.match(r.body, /last good Dispatcher pass: 20 min ago \(a pass is running, inside its time limit\)/);
  // The caller's rule says late: red, with its own text.
  late = { since: Date.parse(h.world.stoppedAt), text: 'the Dispatcher\'s last full pass was 20 minutes ago' };
  h.tick(10);
  const r2 = await h.pass();
  assert.ok(r2.red.includes('dispatcher'));
  assert.match(alertIssues(h.gh)[0].body, /last full pass was 20 minutes ago/);
  // A dispatcherLate that throws is red: whether it is running could not be read.
  h.probes.dispatcherLate = async () => { throw new Error('lock unreadable'); };
  h.tick(10);
  assert.ok((await h.pass()).red.includes('dispatcher'));
});

test('L730 m3: a new stop after Joe closed the last one is a new notice; the same stop he closed stays quiet here', async () => {
  const h = setup();
  await h.pass();
  h.world.dispatcherRunning = false; h.world.stoppedAt = h.now().toISOString();
  h.tick(20);
  const first = await h.pass();
  assert.equal(first.told.dispatcher, 'opened');
  const [al] = alertIssues(h.gh);
  h.gh.ownerCloses(al.number ?? [...h.gh.issues.entries()].find(([, i]) => i === al)[0]);
  h.tick(10);
  assert.equal((await h.pass()).told.dispatcher, 'suppressed', 'the caller hears it was not told, and tells it its own way');
  // The Dispatcher ran once between two beats and stopped again: no green pass cleared the alert, but it is a new stop
  // (a new start time in the status), so it is a new notice, though Joe closed the last one.
  h.world.stoppedAt = new Date(h.now().getTime() - 16 * 60e3).toISOString();
  h.tick(1);
  assert.equal((await h.pass()).told.dispatcher, 'opened', 'a new stop with no green pass between');
  assert.equal(alertIssues(h.gh).filter((i) => !i.closed).length, 1);
  h.gh.ownerCloses([...h.gh.issues.entries()].find(([, i]) => !i.closed && /red: dispatcher/.test(i.title))[0]);
  // Back, then a second stop: its own start time, so a new status and a new issue, though Joe closed the first.
  h.world.dispatcherRunning = true; h.tick(10); await h.pass();
  h.world.dispatcherRunning = false; h.world.stoppedAt = h.now().toISOString();
  h.tick(20);
  assert.equal((await h.pass()).told.dispatcher, 'opened');
  assert.equal(alertIssues(h.gh).filter((i) => !i.closed).length, 1);
});

test('L730 m4: told is per alert: one lost alert does not make the others not told', async () => {
  const h = setup();
  h.world.usage = { window: 'weekly', pct: 10 };
  h.world.dispatcherRunning = false; h.world.stoppedAt = new Date(h.now().getTime() - 30 * 60e3).toISOString();
  h.world.fd = false;
  const open = h.gh.open.bind(h.gh);
  h.gh.open = async (x) => (/red: front-door/.test(x.title) ? false : open(x));
  const r = await h.pass();
  assert.equal(r.told.dispatcher, 'opened');
  assert.equal(r.told['front-door'], false);
  assert.ok(r.red.includes('alert-not-told'), 'the lost one still shows on the pinned issue');
  assert.equal(r.told.rules, 'none', 'a green kind answers its clear');
});

test('#451 r1 m1: posted says whether GitHub took the pinned body: opened, edited, or found again by its marker and edited', async () => {
  const world = { refuse: true };   // the Record keeps no issue number, so each pass finds the issue by its marker
  const h = setup({ wrap: refusingPin(world) });
  const first = await h.pass();
  assert.equal(first.posted, true, 'a new issue opens with the body');
  assert.equal(first.postedWhy, null);
  const r = await h.pass();
  assert.equal(r.posted, true, "found again by its marker and edited");
  const edit = h.gh.edit;
  h.gh.edit = async () => false;
  const refused = await h.pass();
  assert.equal(refused.posted, false, 'found again, but GitHub refused the edit');
  assert.equal(typeof refused.postedWhy, 'string');
  world.refuse = false; h.gh.edit = edit;
  await h.pass();                    // the number is kept now
  h.gh.edit = async () => false;
  assert.equal((await h.pass()).posted, false, 'the kept issue, its edit refused');
  const blind = setup();
  blind.gh.findOpen = async () => false;
  assert.equal((await blind.pass()).posted, false, 'a list GitHub refused opens nothing and posts nothing');
  const shut = setup();
  shut.gh.open = async () => false;
  assert.equal((await shut.pass()).posted, false, 'an open GitHub refused posts nothing');
});
