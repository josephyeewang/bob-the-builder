// alert-answers.test.mjs — L130 m15 and L135 sites C, D and E: an alert that isn't delivered (it answers false, or it
// throws) never leaves a "told" mark or a done step that nothing asks about again. Each site runs with a sink that
// loses the alert, then with one that delivers it.
//
// Two forms (L130, L133):
//   - a told mark written only when the alert answered something other than false (m15 claims_outage, the outbox
//     store_error mark, the store's told-once set): a lost alert is simply sent again the next time;
//   - a step done once and never redone (a file moved to quarantine, a torn diary line cut, a claim broken): the alert is
//     kept in unsent-alerts.jsonl and sent again at the start of every later transaction until it is delivered.
// The stand-in sink below answers false or throws; it moves to #93's fakeAlert once that lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openRecord } from './writer.mjs';
import { PRODUCT, UID, iso, must, outboxFile, product, readyCard, runCard, seed, sessionClaim, setup } from './fixtures.test-helper.mjs';

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

test('L130 m15: the once-a-day claims_outage mark is written only after the alert is delivered', () => {
  for (const mode of LOST) {
    const s = sink();
    const env = claimsBoard(s, [100, 101, 102], ['C-1', 'C-2', 'C-3', 'C-4']);
    s.mode = mode;
    assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /none is broken \(outage\)/);
    env.record.breakIfDead({ card: 'C-2' });
    assert.equal(s.of('claims_outage').length, 2, `${mode}: not marked, so the next pass tells again`);
    s.mode = 'ok';
    env.record.breakIfDead({ card: 'C-3' });
    assert.equal(s.of('claims_outage').length, 3, `${mode}: delivered`);
    env.record.breakIfDead({ card: 'C-1' });
    env.record.breakIfDead({ card: 'C-2' });
    assert.equal(s.of('claims_outage').length, 3, `${mode}: once delivered, once a day`);
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
