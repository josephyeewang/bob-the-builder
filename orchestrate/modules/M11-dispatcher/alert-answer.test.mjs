// alert-answer.test.mjs — L130: whatever marks told, waits on Joe or records "the owner was told" happens only after the
// alert answered something other than false. Real Record (M9 setup, real permissions), real outbox() and real tick().
// The one stand-in refuses ONE kind of write, the queue write of the unsent-alerts fact, while `busy.on`, as "store busy
// after the lock wait" would. Each case runs once with the queue working (the control) and once with it refused on the
// first pass: both must tell Joe exactly once. Built from the lead's class-sweep probes S0 to S4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, ACCOUNT_FACT, actOnDead } from './tick.mjs';
import { outbox, ALERT_QUEUE_FACT } from './alerts.mjs';
import { RECONCILED_FACT } from './merges.mjs';
import { WAIT_TELL_FACT } from './joe-waits.mjs';
import { settleMerge, MERGED_OUTSIDE_UNTOLD } from '../M6-merge-gate/merge-outcome.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, usageFact } from './fixtures.test-helper.mjs';
import { setup, product, readyCard, runCard, put, must, HEAD, PRODUCT, iso } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const MIN = 60_000;
const ACCT = 'acct-a';
const HOST = 'mac-a';
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };

// The real record, with the queue write refused while `busy.on`.
function refusingQueue(real, busy) {
  const out = Object.create(null);
  for (const k of Object.keys(real)) out[k] = typeof real[k] === 'function' ? real[k].bind(real) : real[k];
  out.write = (w) => {
    if (busy.on && w?.entity === 'fact' && w?.id === ALERT_QUEUE_FACT) { busy.refused += 1; return { ok: false, reason: 'the store is busy: the lock was not free after 10000 ms' }; }
    return real.write(w);
  };
  return out;
}

function world() {
  const E = setup({ prefix: 'm11-alertanswer-', probe: { kill() {}, pidStart: () => 'start' }, host: HOST });
  const busy = { on: false, refused: 0 };
  const rec = refusingQueue(E.record, busy);
  product(E);
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  must(E.record.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: E.clock.t }) }), 'usage');
  must(E.record.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { account: ACCT, observed_at: iso(E.clock.t) } }), 'account');
  const delivered = [];
  const empty = tempDir('m11-alertanswere-');
  const ports = (over = {}) => ({
    alert: (t) => { delivered.push(typeof t === 'string' ? t : t.text); return true; },
    board: () => [], healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [], sessions: () => [], probe: () => idle,
    launch: async () => ({ ok: false, reason: 'no launches in this test' }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true, requestId: 'Q' }),
    filesOf: () => [], sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null, cleanup: { copiesRoot: empty, sealRoot: empty, mirrorFor: () => null },
    ...over,
  });
  const runTick = (over) => tick({ rec, rules, now: E.clock.t, ports: ports(over) });
  return { E, rec, busy, rules, delivered, runTick };
}

test('S0: the real outbox over the real Record queues, a real tick delivers, and a refused queue write answers false', async () => {
  const w = world();
  assert.equal(outbox(w.rec, w.E.clock.t)('control alert'), true);
  w.E.clock.t += MIN; await w.runTick();
  assert.ok(w.delivered.includes('control alert'), JSON.stringify(w.delivered));
  w.busy.on = true;
  assert.equal(outbox(w.rec, w.E.clock.t)('second'), false);
  w.busy.on = false;
});

// L130 M1, tick.mjs actOnDead (through joe-waits.mjs): the card put on Joe is told once, queue working or not.
for (const refused of [false, true]) {
  test(`S1 tick.mjs: a dead card put on Joe is told once${refused ? ', though the first queue write was refused' : ''}`, async () => {
    const w = world();
    readyCard(w.E, 'C-1');
    runCard(w.E, 'C-1');
    w.busy.on = refused;
    const r = actOnDead({ rec: w.rec, rules: w.rules, now: w.E.clock.t, restart: [], asks: ['C-1'], alert: outbox(w.rec, w.E.clock.t) });
    w.busy.on = false;
    assert.deepEqual(r, [['C-1', 'waiting on Joe']]);
    assert.equal(w.busy.refused, refused ? 1 : 0);
    for (let i = 0; i < 6; i++) { w.E.clock.t += MIN; await w.runTick(); }
    assert.equal(w.rec.read('card', 'C-1').doc.wait?.who, 'joe');
    assert.equal(w.delivered.filter((t) => /card C-1: its session stopped/.test(t)).length, 1, JSON.stringify(w.delivered));
    assert.equal(w.rec.read('fact', WAIT_TELL_FACT('C-1')).doc.told_since, w.rec.read('card', 'C-1').doc.wait.since, 'marked told for this wait');
  });
}

// C-1 verified at HEAD, and merge MG-1 (PR 7) checking with the card merging.
async function stageChecking(w) {
  const { outboxFile, passingVerdict } = await import('../M9-record/fixtures.test-helper.mjs');
  const { dispatcherPass } = await import('./pass.mjs');
  readyCard(w.E, 'C-1');
  let sid = null;
  await dispatcherPass({ rec: w.E.record, rules: w.rules, now: w.E.clock.t, account: ACCT, sessions: [], probe: () => idle, host: HOST,
    launch: async (x) => { sid = x.sessionId; return { ok: true, sessionId: x.sessionId, pid: 1001, pidStart: 'start', pgid: 101, head: HEAD }; },
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: true }), filesOf: () => [], alert: outbox(w.E.record, w.E.clock.t) });
  must(put(w.E.record, 'workshop', 'card', 'C-1', { head: HEAD }), 'head');
  must(w.E.record.applyOutbox({ role: 'worker', sessionId: sid, card: 'C-1' }, outboxFile(w.E, 'worker', sid, 'handin-1.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`)), 'hand-in');
  passingVerdict(w.E, 'C-1', 'R-1', HEAD);
  must(put(w.E.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
  must(w.E.record.write({ actor: 'merge_gate', entity: 'merge', id: 'MG-1', expectRev: 0, doc: { state: 'requested', card: 'C-1', pr: 7, head: HEAD, product: PRODUCT } }), 'requested');
  must(put(w.E.record, 'merge_gate', 'merge', 'MG-1', { state: 'queued' }), 'queued');
  const mg = w.E.record.read('merge', 'MG-1'); const cd = w.E.record.read('card', 'C-1');
  must(w.E.record.write({ actor: 'merge_gate', entity: 'merge', id: 'MG-1', expectRev: mg.rev, doc: { ...mg.doc, state: 'checking', judged_head: HEAD },
    also: [{ entity: 'card', id: 'C-1', expectRev: cd.rev, doc: { ...cd.doc, state: 'merging' } }] }), 'checking');
}
const OTHER = 'c'.repeat(40);
function prMergedElsewhere(w) {
  must(w.E.record.write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: w.E.record.read('fact', 'pr-7')?.rev ?? 0,
    doc: { type: 'pr', head_sha: OTHER, state: 'closed', merged: true, merge_commit_sha: 'd'.repeat(40), at: iso(w.E.clock.t), observed_at: iso(w.E.clock.t) } }), 'pr reading');
}
async function run7(w, refused) {
  w.busy.on = refused;
  await w.runTick({ gateAlive: () => false });
  w.busy.on = false;
  for (let i = 0; i < 6; i++) { w.E.clock.t += MIN; await w.runTick({ gateAlive: () => false }); }
  return w.delivered.filter((t) => /MG-1/.test(t) || /#7 merged/.test(t)).length;
}

// L130 M2 (merges.mjs refused-but-merged) and M4 (M6 reconcileMerge's `told` is the alert's own answer).
for (const refused of [false, true]) {
  test(`S2 merges.mjs + M6 reconcileMerge: an interrupted merge GitHub shows merged at an unjudged head is told once${refused ? ', though the first queue write was refused' : ''}`, async () => {
    const w = world();
    await stageChecking(w);
    assert.equal(settleMerge({ record: w.E.review, now: w.E.clock.t }, 'MG-1', { reason: 'interrupted' }).ok, true);
    w.E.clock.t += MIN; prMergedElsewhere(w);
    w.E.clock.t += MIN;
    const told = await run7(w, refused);
    assert.equal(w.busy.refused, refused ? 1 : 0);
    assert.equal(told, 1, JSON.stringify(w.delivered));
    assert.ok(w.rec.read('fact', RECONCILED_FACT('MG-1')), 'the told note is written once delivered');
    assert.equal(w.rec.read('merge', 'MG-1').doc.state, 'refused');
  });
}

// L130 M6 (M6 settleMerge): MERGED_OUTSIDE ("the owner was told") only when the alert was taken; otherwise the
// untold reason, which the Dispatcher tells with no newer reading.
for (const refused of [false, true]) {
  test(`S3 M6 settleMerge: a merging PR GitHub shows merged at an unjudged head is told once${refused ? ', though the first queue write was refused' : ''}`, async () => {
    const w = world();
    await stageChecking(w);
    must(put(w.E.record, 'merge_gate', 'merge', 'MG-1', { state: 'merging' }), 'merging');
    w.E.clock.t += MIN; prMergedElsewhere(w);
    w.E.clock.t += MIN;
    const told = await run7(w, refused);
    assert.equal(told, 1, JSON.stringify(w.delivered));
    assert.equal(w.rec.read('merge', 'MG-1').doc.reasons.includes(MERGED_OUTSIDE_UNTOLD), refused);
  });
}

// L130 m18: an entry dropped by its own queueing at the untried cap answers false (the drop is still counted).
test('S4 alerts.mjs: at the untried cap, a new cause-tied entry dropped by its own queueing answers false', () => {
  const w = world();
  const alert = outbox(w.rec, w.E.clock.t);
  for (let i = 0; i < 200; i++) assert.equal(alert(`one-off ${i}`), true);
  const ok = alert('a cause-tied alert', { mark: { fact: 'hold-probe', fields: { told_at: iso(w.E.clock.t) }, kind: 'hold_alert' } });
  const q = w.rec.read('fact', ALERT_QUEUE_FACT).doc;
  assert.equal(q.entries.some((e) => e.text === 'a cause-tied alert'), false, 'the entry is the one dropped');
  assert.equal(ok, false);
  assert.ok(q.dropped_causes.some((c) => c.key === 'hold-probe:told_at'), 'its drop is counted');
});
