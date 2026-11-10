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
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRecordWithStore } from './writer.mjs';
import { KEEP_PER_WINDOW, KEPT_BACK_STEPS } from './store.mjs';
import { readUnsent } from './unsent.mjs';
import { makeRecord } from '../../shared/record.mjs';
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
const fakeProbe = (dead) => ({ kill(pid) { if (dead.includes(pid)) throw err('ESRCH'); }, pidStart: () => '2026-10-01T11:00:00Z' });
function claimsBoard(s, deadPids, ids) {
  const env = open(s, { prefix: 'm9-l135-', probe: fakeProbe(deadPids) });
  product(env);
  for (const id of ids) readyCard(env, id);
  ids.forEach((id, i) => {
    runCard(env, id, sessionClaim({ session_id: `S-${i}`, pid: 100 + i }));
    const t = env.clock.t;
    env.clock.t = t - 600 * MIN;
    seed(env, 'session', `S-${i}`, { state: 'ended', role: 'worker', pid: 100 + i, pid_start: '2026-10-01T11:00:00Z', card: null, last_activity: iso(env.clock.t) });
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
  const other = openRecordWithStore({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: s2.alert, now: () => env.clock.t, host: 'mac-a' });
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

// L545: keepAlert, for an alert the queue would not take. It answers nothing and needs no Record write.
const DAY = 24 * 60 * MIN;
const quiet = () => open(sink('false'), { prefix: 'm9-keep-' });
const keptOf = (env, type) => readUnsent(env.root).filter((x) => x.event.type === type);
const bumped = (env) => { env.clock.t += 1; };

test('L545: one line per key a day, judged from the file: a repeat is nothing, and a day on it is kept again', () => {
  const env = quiet();
  const seq = env.store.lines().length;
  for (let i = 0; i < 5; i += 1) { assert.equal(env.record.keepAlert('the band is red', 'stop-1'), undefined); bumped(env); }
  assert.equal(keptOf(env, 'alert_not_queued').length, 1);
  assert.equal(keptOf(env, 'alert_not_queued')[0].event.text, 'the band is red');
  assert.equal(env.store.lines().length, seq, 'no Record write');
  env.clock.t += DAY;
  env.record.keepAlert('the band is red', 'stop-1');
  assert.equal(keptOf(env, 'alert_not_queued').length, 2);
});

test('L545: a delivered line still counts toward the day, so a resend is not a new issue', () => {
  const env = quiet();
  env.record.keepAlert('one', 'k');
  markSentFor(env);
  bumped(env);
  env.record.keepAlert('one', 'k');
  assert.equal(readUnsent(env.root).length, 0);
});
const markSentFor = (env) => { for (const x of readUnsent(env.root)) appendFileSync(join(env.root, 'unsent-alerts.jsonl'), `${JSON.stringify({ id: x.id, outcome: 'sent', at: iso(env.clock.t) })}\n`); };

test('L545: past the total, keys are held back and the owner hears "at least N" at each step', () => {
  const env = quiet();
  const each = KEEP_PER_WINDOW + 150;
  for (let i = 0; i < each; i += 1) { env.record.keepAlert(`alert ${i}`, `key-${i}`); bumped(env); }
  assert.equal(keptOf(env, 'alert_not_queued').length, KEEP_PER_WINDOW);
  assert.deepEqual(keptOf(env, 'alerts_kept_back').map((x) => Number(/at least (\d+) more/.exec(x.event.text)?.[1])), KEPT_BACK_STEPS.slice(0, 3));
  const backLines = readFileSync(join(env.root, 'unsent-alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.outcome === 'kept_back');
  assert.equal(backLines[0].text, `alert ${KEEP_PER_WINDOW}`, 'the text of a held-back alert stays on the computer (L553)');
  assert.match(keptOf(env, 'alerts_kept_back')[0].event.text, /unsent-alerts\.jsonl.*held-back lines/, 'and the owner is told where');
  env.record.keepAlert('y'.repeat(5000), 'a-long-one');
  assert.ok(JSON.parse(readFileSync(join(env.root, 'unsent-alerts.jsonl'), 'utf8').trim().split('\n').at(-1)).text.length <= 300, 'the copy is cut');
  // The same held-back key again is the same alert: not counted twice.
  for (let i = 0; i < 9; i += 1) { env.record.keepAlert('alert 21', 'key-21'); bumped(env); }
  assert.equal(readFileSync(join(env.root, 'unsent-alerts.jsonl'), 'utf8').split('\n').filter((l) => /kept_back/.test(l) && /"cap_key":"key-21"/.test(l)).length, 1);
});

test('L545: counting stops at the last step, so a text that changes every pass cannot grow the file for ever', () => {
  const env = quiet();
  const file = join(env.root, 'unsent-alerts.jsonl');
  const mark = iso(env.clock.t);
  appendFileSync(file, Array.from({ length: KEEP_PER_WINDOW }, (_, i) => `${JSON.stringify({ id: `f${i}`, outcome: 'unsent', event: { type: 'alert_not_queued', text: 'x' }, cap_key: `f${i}`, at: mark })}\n`).join(''));
  const last = KEPT_BACK_STEPS.at(-1);
  appendFileSync(file, Array.from({ length: last }, (_, i) => `${JSON.stringify({ outcome: 'kept_back', cap_key: `b${i}`, at: mark })}\n`).join(''));
  const size = readFileSync(file, 'utf8').length;
  bumped(env);
  env.record.keepAlert('one more', 'another');
  assert.equal(readFileSync(file, 'utf8').length, size);
});

test('L545: a line in the file that is not whole JSON is no line to the cap, and the alert is kept', () => {
  const env = quiet();
  appendFileSync(join(env.root, 'unsent-alerts.jsonl'), '{"cap_key":"k","at\n');
  env.record.keepAlert('kept', 'k');
  assert.equal(keptOf(env, 'alert_not_queued').length, 1);
});

test('L545: the shape: a text and a key in, nothing back, and no way to the store (writer.mjs: never the raw store)', () => {
  const env = quiet();
  assert.equal(env.record.keepAlert('a', 'k'), undefined);
  assert.equal(env.impl.keepAlert('b', 'k2'), undefined, 'the Writer hands nothing from the store');
  assert.equal(env.impl.keepAlert.length, 2);
  let got;
  const rec = makeRecord({ keepAlert: (...a) => { got = a; return { paths: 'the raw store' }; } });
  assert.equal(rec.keepAlert({ a: 1 }, 7, 'a third'), undefined, 'the Record hands nothing back');
  assert.deepEqual(got, ['[object Object]', '7'], 'only a text and a key reach it, as strings');
  assert.equal(makeRecord({}).keepAlert('a', 'k'), undefined, 'a Record with no store: nothing');
  assert.equal(makeRecord({ keepAlert: () => { throw new Error('no'); } }).keepAlert('a', 'k'), undefined, 'never throws');
  const doc = env.record.read('fact', 'k');
  assert.equal(doc ?? null, null, 'no document made');
});

test('L545 (lane 1): a step is told once a day at most, however long the count sits at it', () => {
  const env = quiet();
  const file = join(env.root, 'unsent-alerts.jsonl');
  const stepLines = () => keptOf(env, 'alerts_kept_back').length;
  const seed = (t) => {
    appendFileSync(file, Array.from({ length: KEEP_PER_WINDOW }, (_, i) => `${JSON.stringify({ id: `f${t}-${i}`, outcome: 'unsent', event: { type: 'alert_not_queued', text: 'x' }, cap_key: `f${t}-${i}`, at: iso(t) })}\n`).join(''));
    appendFileSync(file, Array.from({ length: 9 }, (_, i) => `${JSON.stringify({ outcome: 'kept_back', cap_key: `b${t}-${i}`, at: iso(t) })}\n`).join(''));
  };
  seed(env.clock.t);
  env.clock.t += 60_000;
  env.record.keepAlert('tenth', 'k-10');
  assert.equal(stepLines(), 1, 'the tenth is told');
  // Old lines leave the day one by one, so a new key finds the count at 10 again and again: seen as a count held there.
  const heldAt = env.clock.t;
  for (let i = 0; i < 5; i += 1) {
    const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const firstBack = raw.findIndex((l) => /"outcome":"kept_back"/.test(l));
    writeBack(file, raw.filter((_, n) => n !== firstBack));
    env.clock.t += 1;
    env.record.keepAlert(`again ${i}`, `k-again-${i}`);
  }
  assert.equal(stepLines(), 1, 'the count sat at the step: no second line in the day');
  env.clock.t = heldAt + DAY + MIN;
  seed(env.clock.t);
  env.clock.t += 60_000;
  env.record.keepAlert('next day', 'k-next');
  assert.equal(stepLines(), 2, 'the fault lasts: told again the next day');
});
const writeBack = (file, lines) => { writeFileSync(file, `${lines.join('\n')}\n`); };

test('L545 (lane 1): a line dated ahead of the clock is no line to the cap: it silences nothing', () => {
  const env = quiet();
  const file = join(env.root, 'unsent-alerts.jsonl');
  const ahead = iso(env.clock.t + 10 * DAY);
  appendFileSync(file, `${JSON.stringify({ id: 'z', outcome: 'unsent', event: { type: 'alert_not_queued', text: 'old' }, cap_key: 'k', at: ahead })}\n`);
  appendFileSync(file, Array.from({ length: KEEP_PER_WINDOW }, (_, i) => `${JSON.stringify({ id: `z${i}`, outcome: 'unsent', event: { type: 'alert_not_queued', text: 'old' }, cap_key: `z${i}`, at: ahead })}\n`).join(''));
  env.record.keepAlert('told now', 'k');
  assert.ok(keptOf(env, 'alert_not_queued').some((x) => x.event.text === 'told now'));
});

// One simulated day: `calls` keepAlert calls spread across it, then the step lines that day added.
const dayOf = (env, keys) => {
  const before = readFileSync(join(env.root, 'unsent-alerts.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const steps = keptOf(env, 'alerts_kept_back').length;
  const gap = Math.floor(DAY / keys.length);
  for (const k of keys) { env.record.keepAlert(`alert ${k}`, k); env.clock.t += gap; }
  const added = readFileSync(join(env.root, 'unsent-alerts.jsonl'), 'utf8').split('\n').filter(Boolean).slice(before).filter((l) => !/"outcome":"kept_back"/.test(l));
  return { steps: keptOf(env, 'alerts_kept_back').length - steps, lines: added.length };
};

test('L558 M1: while a fault lasts, every day with alerts held back tells the owner, at any count', () => {
  for (const perDay of [25, 35, 50, 120]) {
    for (const stuck of [false, true]) {
      const env = quiet();
      const heldDays = [];
      for (let day = 0; day < 5; day += 1) {
        // A stuck cause tells every pass; here a pass is two hours. New keys arrive once each.
        const keys = stuck ? Array.from({ length: 12 }).flatMap(() => Array.from({ length: perDay }, (_, i) => `cause-${i}`)) : Array.from({ length: perDay }, (_, i) => `d${day}-${i}`);
        heldDays.push(dayOf(env, keys).steps);
      }
      assert.ok(heldDays.every((n) => n >= 1), `${perDay} a day, stuck ${stuck}: told each day, got ${heldDays}`);
    }
  }
});

test('L558 M1 stays bounded (L555): a heavy fault is about 21 to 24 lines a day, for days', () => {
  const env = quiet();
  for (let day = 0; day < 3; day += 1) {
    const { lines } = dayOf(env, Array.from({ length: 1100 }, (_, i) => `d${day}-${i}`));
    assert.ok(lines >= 21 && lines <= 24, `day ${day}: ${lines} lines`);
  }
});

test('L558 M1: a count that jumped past a step (two processes at once) still tells that step', () => {
  const env = quiet();
  const file = join(env.root, 'unsent-alerts.jsonl');
  const at = iso(env.clock.t);
  appendFileSync(file, Array.from({ length: KEEP_PER_WINDOW }, (_, i) => `${JSON.stringify({ id: `f${i}`, outcome: 'unsent', event: { type: 'alert_not_queued', text: 'x' }, cap_key: `f${i}`, at })}\n`).join(''));
  appendFileSync(file, Array.from({ length: 11 }, (_, i) => `${JSON.stringify({ outcome: 'kept_back', cap_key: `b${i}`, at })}\n`).join(''));
  env.clock.t += 1;
  env.record.keepAlert('next', 'k-next');
  assert.match(keptOf(env, 'alerts_kept_back')[0].event.text, /at least 10 more alerts/);
});

test('L558 Minor 1: two long alerts that differ only past the cut stay two', () => {
  const env = quiet();
  env.record.keepAlert(`${'y'.repeat(400)}a`, `${'y'.repeat(400)}a`);
  env.record.keepAlert(`${'y'.repeat(400)}b`, `${'y'.repeat(400)}b`);
  assert.equal(keptOf(env, 'alert_not_queued').length, 2);
});

test('L566 A12: a step is told on its own count, not one before', () => {
  const env = quiet();
  for (let i = 0; i < KEEP_PER_WINDOW + 9; i += 1) { env.record.keepAlert(`a${i}`, `k${i}`); env.clock.t += 1; }
  assert.doesNotMatch(keptOf(env, 'alerts_kept_back').map((x) => x.event.text).join(), /at least 10 /);
  env.record.keepAlert('a10', 'k-tenth');
  assert.match(keptOf(env, 'alerts_kept_back').map((x) => x.event.text).join(), /at least 10 more alerts/);
});

