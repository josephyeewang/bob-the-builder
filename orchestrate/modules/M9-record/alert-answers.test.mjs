// alert-answers.test.mjs — L130 m15, L135 sites C, D and E, and L168 M-1: an alert that isn't delivered (it answers false, or it
// throws) never leaves a "told" mark or a done step that nothing asks about again. Each site runs with a sink that
// loses the alert, then with one that delivers it.
//
// Two forms (L130, L133):
//   - a told mark written only when the alert answered something other than false (lapseClaims' once-a-day marks, the
//     outbox store_error mark, the store's told-once set): a lost alert is simply sent again the next time;
//   - a step done once and never redone (a file moved to quarantine, a torn diary line cut, a claim broken): the alert is
//     kept in unsent-alerts.jsonl and sent again at the start of every later transaction until it is delivered.
// The stand-in sink below answers false or throws; it moves to #93's fakeAlert once that lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openRecord } from './writer.mjs';
import { PRODUCT, UID, claimCard, iso, must, outboxFile, product, readyCard, runCard, seed, sessionClaim, setup } from './fixtures.test-helper.mjs';

const LOST = ['false', 'throws'];
const MIN = 60000;
// mode: 'ok' delivers, 'false' answers false, 'throws' throws.
function sink(mode = 'ok') {
  const s = { mode, calls: [] };
  s.alert = (a) => { s.calls.push(a); if (s.mode === 'throws') throw new Error('the alert could not be sent'); return s.mode !== 'false'; };
  s.of = (type) => s.calls.filter((a) => a.type === type);
  return s;
}
const open = (s, opts = {}) => setup({ prefix: 'm9-l135-', ...opts, extra: { alert: s.alert, ...(opts.extra ?? {}) } });
const card = (extra = {}) => ({ state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, ...extra });
const unsent = (env) => readFileSync(join(env.root, 'unsent-alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const waiting = (env) => { const u = unsent(env); const done = new Set(u.filter((x) => x.outcome === 'sent').map((x) => x.id)); return u.filter((x) => x.outcome === 'unsent' && !done.has(x.id)); };
const pass = (env) => env.store.transaction(() => null);

// One kept alert, lost twice more, then delivered once (marked resent) and never again.
function keptThenDelivered(env, s, type, mode) {
  assert.equal(s.of(type).length, 1, `${mode}: ${type} was tried`);
  assert.deepEqual(waiting(env).map((x) => x.event.type), [type], `${mode}: ${type} is kept, not dropped`);
  pass(env);
  assert.equal(s.of(type).length, 2, `${mode}: tried again at the next transaction`);
  assert.equal(waiting(env).length, 1, `${mode}: still kept while the sink loses it`);
  s.mode = 'ok';
  pass(env);
  assert.equal(s.of(type).length, 3, `${mode}: delivered`);
  assert.equal(s.of(type)[2].resent, true, `${mode}: the late one says it was resent`);
  assert.deepEqual(waiting(env), [], `${mode}: nothing kept once delivered`);
  pass(env);
  pass(env);
  assert.equal(s.of(type).length, 3, `${mode}: sent once, not every pass`);
}

test('L135 D: a tamper alert that is lost after the file went to quarantine is kept and sent again until delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = open(s);
    seed(env, 'card', 'C-1', card());
    seed(env, 'card', 'C-1', card({ module: 'M2' }));
    unlinkSync(join(env.root, 'docs', 'card', 'C-1.json'));
    s.mode = mode;
    env.record.write({ actor: 'approvals', entity: 'card', id: 'C-1', expectRev: 2, doc: card({ module: 'M2', state: 'cancelled', cancel_reason: 'x' }) });
    assert.equal(env.record.read('card', 'C-1').doc.module, 'M2', `${mode}: restored from the diary all the same`);
    keptThenDelivered(env, s, 'tamper', mode);
  }
  // Delivered the first time: nothing is kept.
  const s = sink();
  const env = open(s);
  seed(env, 'card', 'C-1', card());
  seed(env, 'card', 'C-1', card({ module: 'M2' }));
  unlinkSync(join(env.root, 'docs', 'card', 'C-1.json'));
  env.record.write({ actor: 'approvals', entity: 'card', id: 'C-1', expectRev: 2, doc: card({ module: 'M2', state: 'cancelled', cancel_reason: 'x' }) });
  assert.equal(s.of('tamper').length, 1);
  assert.deepEqual(waiting(env), []);
  pass(env);
  assert.equal(s.of('tamper').length, 1, 'a delivered alert is not sent again');
});

test('L135 E: the alert for a torn diary line cut is kept and sent again until delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = open(s);
    seed(env, 'card', 'C-1', card());
    appendFileSync(join(env.root, 'diary.jsonl'), '{"seq":2,"half a li');
    s.mode = mode;
    pass(env);
    assert.equal(env.store.lines().length, 1, `${mode}: the torn bytes were cut all the same`);
    keptThenDelivered(env, s, 'diary_torn_line_cut', mode);
  }
});

// The claims set-up from claims.test.mjs: a fake process table and ended sessions.
const err = (code) => Object.assign(new Error(code), { code });
const fakeProbe = (dead) => ({ kill(pid) { if (dead.includes(pid)) throw err('ESRCH'); }, pidStart: () => 'Thu Oct  1 11:00:00 2026' });
function claimsBoard(s, deadPids, ids) {
  const env = open(s, { prefix: 'm9-l135-', probe: fakeProbe(deadPids) });
  product(env);
  for (const id of ids) readyCard(env, id);
  ids.forEach((id, i) => {
    runCard(env, id, sessionClaim({ session_id: `S-${i}`, pid: 100 + i }));
    const t = env.clock.t;
    env.clock.t = t - 600 * MIN;
    seed(env, 'session', `S-${i}`, { state: 'ended', role: 'worker', pid: 100 + i, pid_start: 'Thu Oct  1 11:00:00 2026', card: null, last_activity: iso(env.clock.t) });
    env.clock.t = t;
  });
  return env;
}

test('L135 C: a claim_broken alert that is lost after the break is kept and sent again until delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = claimsBoard(s, [100], ['C-1', 'C-2']);
    s.mode = mode;
    const r = must(env.record.breakIfDead({ card: 'C-1' }), `${mode}: broken`);
    assert.equal(r.told, false, `${mode}: the answer says the owner was not told`);
    assert.equal(env.record.read('card', 'C-1').doc.state, 'ready', `${mode}: the break stands`);
    keptThenDelivered(env, s, 'claim_broken', mode);
  }
  const s = sink();
  const env = claimsBoard(s, [100], ['C-1', 'C-2']);
  assert.equal(must(env.record.breakIfDead({ card: 'C-1' }), 'broken').told, true);
  assert.deepEqual(waiting(env), []);
});

// L168 M-1: lapseClaims' two once-a-day alerts (#68's copies of the m15 form). A lost one leaves no mark, so the
// next pass tells again; once delivered, it is not told again that day. (The claims_outage mark moved to M11
// outage.mjs, whose outage.test.mjs covers a lost outage alert through tellThen.)
test('L168 M-1: unlaunched_claim_held is marked only once delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = open(s);
    product(env);
    for (const id of ['C-1', 'C-2']) readyCard(env, id);
    claimCard(env, 'C-1');
    const t0 = env.clock.t;
    s.mode = mode;
    env.record.lapseClaims(t0 + 5 * MIN + 1);
    env.record.lapseClaims(t0 + 5 * MIN + 2);
    assert.equal(s.of('unlaunched_claim_held').length, 2, `${mode}: not marked, so the next pass tells again`);
    s.mode = 'ok';
    env.record.lapseClaims(t0 + 5 * MIN + 3);
    env.record.lapseClaims(t0 + 5 * MIN + 4);
    env.record.lapseClaims(t0 + 5 * MIN + 5);
    assert.equal(s.of('unlaunched_claim_held').length, 3, `${mode}: delivered once, then not again that day`);
    assert.equal(env.record.read('card', 'C-1').doc.state, 'claimed', `${mode}: the claim is held all the same`);
  }
});

test('L168 M-1: heartbeat_stale_unreadable is marked only once delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = open(s, { values: { 'proposals.heartbeat_stale_min': 'x' } });
    product(env);
    readyCard(env, 'C-1');
    claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
    const t0 = env.clock.t;
    s.mode = mode;
    env.record.lapseClaims(t0 + 10 * MIN);
    env.record.lapseClaims(t0 + 11 * MIN);
    assert.equal(s.of('heartbeat_stale_unreadable').length, 2, `${mode}: not marked, so the next pass tells again`);
    s.mode = 'ok';
    env.record.lapseClaims(t0 + 12 * MIN);
    env.record.lapseClaims(t0 + 13 * MIN);
    env.record.lapseClaims(t0 + 14 * MIN);
    assert.equal(s.of('heartbeat_stale_unreadable').length, 3, `${mode}: delivered once, then not again that day`);
  }
});

test('L130: the outbox store-error mark is written only after the refusal alert is delivered', () => {
  for (const mode of LOST) {
    const s = sink(mode);
    const env = open(s, { faultAt: 'readback_wrong' });
    const tag = { role: 'worker', sessionId: 'S-1' };
    const f = outboxFile(env, 'worker', 'S-1', 'report-throws.md', 'body');
    for (let i = 0; i < 2; i++) assert.match(env.record.applyOutbox(tag, f).reason, /store error.*tried again/);
    assert.equal(s.of('refused').length, 2, `${mode}: lost, so told again on the next try`);
    s.mode = 'ok';
    env.record.applyOutbox(tag, f);
    env.record.applyOutbox(tag, f);
    env.record.applyOutbox(tag, f);
    assert.equal(s.of('refused').length, 3, `${mode}: told once it is delivered, then not again`);
  }
});

test('L130: the store\'s told-once alert (a layout problem) is only told once delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = open(s);
    seed(env, 'card', 'C-0', card());
    renameSync(join(env.root, 'refusals.jsonl'), join(env.base, 'refusals-away.jsonl'));
    mkdirSync(join(env.root, 'refusals.jsonl'));
    s.mode = mode;
    const write = () => env.record.write({ actor: 'approvals', entity: 'card', id: 'C-0', expectRev: 1, doc: card({ state: 'cancelled', cancel_reason: 'test' }) });
    assert.equal(write().ok, false);
    assert.equal(write().ok, false);
    assert.equal(s.of('store_layout').length, 2, `${mode}: lost, so told again`);
    s.mode = 'ok';
    write();
    write();
    assert.equal(s.of('store_layout').length, 3, `${mode}: told once delivered, then not again`);
  }
});

test('L135: a kept alert survives a restart: a new writer on the same store sends it', () => {
  const s = sink();
  const env = open(s);
  seed(env, 'card', 'C-1', card());
  appendFileSync(join(env.root, 'diary.jsonl'), '{"seq":2,"half');
  s.mode = 'false';
  pass(env);
  assert.equal(waiting(env).length, 1);
  // A new process: a fresh writer on the same folder, with its own sink.
  const s2 = sink();
  const other = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: s2.alert, now: () => env.clock.t, host: 'mac-a' });
  other.store.transaction(() => null);
  assert.equal(s2.of('diary_torn_line_cut').length, 1, 'the new process sends the kept alert');
  assert.deepEqual(waiting(env), []);
});

test('L168 Minor: when even the append to unsent-alerts.jsonl fails, the alert is held in memory and resent in the same process', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = open(s);
    seed(env, 'card', 'C-1', card());
    const file = join(env.root, 'unsent-alerts.jsonl');
    chmodSync(file, 0o444);
    try {
      appendFileSync(join(env.root, 'diary.jsonl'), '{"seq":2,"half a li');
      s.mode = mode;
      pass(env);
      assert.equal(s.of('diary_torn_line_cut').length, 1, `${mode}: tried`);
      assert.deepEqual(waiting(env), [], `${mode}: the append failed, so nothing is in the file`);
      pass(env);
      assert.equal(s.of('diary_torn_line_cut').length, 2, `${mode}: held here, so tried again`);
      s.mode = 'ok';
      pass(env);
      assert.equal(s.of('diary_torn_line_cut').length, 3, `${mode}: delivered`);
      assert.equal(s.of('diary_torn_line_cut')[2].resent, true);
      pass(env);
      pass(env);
      assert.equal(s.of('diary_torn_line_cut').length, 3, `${mode}: sent once, not every pass`);
    } finally { chmodSync(file, 0o644); }
  }
});
