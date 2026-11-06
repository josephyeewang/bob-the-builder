// merges-ask.test.mjs — the "refused twice" ask, over the real Record (M9 setup, real permissions) and real tick().
// Built from the audit r5 probes P-D and P-F (L127).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, ACCOUNT_FACT } from './tick.mjs';
import { dispatcherPass } from './pass.mjs';
import { requestMerges, ASK_REFUSED_FACT } from './merges.mjs';
import { settleMerge } from '../M6-merge-gate/merge-outcome.mjs';
import { REFUSED_FACT } from './refused-writes.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, usageFact, withAlerts } from './fixtures.test-helper.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { setup, product, readyCard, outboxFile, passingVerdict, put, must, HEAD, PRODUCT, iso } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const MIN = 60_000;
const ACCT = 'acct-a';
const HOST = 'mac-a';
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const GREEN = { band: 'green', own_building: 'open', pace: 0.5, prodBlocked: false };

// refuseWait: the Record refuses every card write to waiting (as a rev race or a refused move would), so the ask is
// refused on every pass. M9 lets an approved card wait since #79, so an approved card no longer does this (L134).
// refuseIf: refuses what it answers true for, so a test can turn a write back on.
function world({ refuseWait = false, refuseIf = null } = {}) {
  const E = setup({ prefix: 'm11-mergeask-', probe: { kill() {}, pidStart: () => 'start' }, host: HOST });
  const real = E.record;
  const waits = (x) => x?.entity === 'card' && x?.doc?.state === 'waiting';
  const no = refuseIf ?? ((x) => waits(x) || (x?.also ?? []).some(waits));
  const rec = !refuseWait && !refuseIf ? real : { ...Object.fromEntries(Object.keys(real).map((k) => [k, typeof real[k] === 'function' ? real[k].bind(real) : real[k]])),
    write: (x) => (no(x) ? { ok: false, reason: 'the wait write is refused in this test' } : real.write(x)) };
  product(E);
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  must(rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: E.clock.t }) }), 'usage');
  must(rec.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { account: ACCT, observed_at: iso(E.clock.t) } }), 'account');
  const launched = [];
  let n = 0;
  const pass = () => withAlerts(rec, E.clock.t, () => {}, (alert) => dispatcherPass({
    rec, rules, now: E.clock.t, account: ACCT, sessions: [], probe: () => idle, host: HOST,
    launch: async (x) => { n += 1; launched.push({ card: x.card.id, sessionId: x.sessionId }); return { ok: true, sessionId: x.sessionId, outbox: `/outbox-root/worker/${x.sessionId}`, pid: 1000 + n, pidStart: 'start', pgid: 100 + n, head: HEAD }; },
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: true }), filesOf: () => [], alert,
  }));
  const delivered = [];
  const empty = tempDir('m11-mergeaske-');
  const ports = {
    alert: (t) => { delivered.push(typeof t === 'string' ? t : t.text); return true; },
    board: () => [], healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [], sessions: () => [], probe: () => idle,
    launch: async () => ({ ok: false, reason: 'no launches in this test' }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true, requestId: 'Q' }),
    filesOf: () => [], sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null, cleanup: { copiesRoot: empty, sealRoot: empty, mirrorFor: () => null },
    approvals: () => [], // no products for Approvals here (L221; production must give the port)
  };
  const runTick = () => tick({ rec, rules, now: E.clock.t, ports });
  return { E, rec, rules, launched, pass, runTick, delivered };
}

// C-1 built, reviewed and verified at HEAD, with Sensors' open reading for PR 7.
async function verifiedCard(w) {
  readyCard(w.E, 'C-1');
  await w.pass();
  const [l] = w.launched;
  must(put(w.rec, 'workshop', 'card', 'C-1', { head: HEAD }), 'head');
  must(w.rec.applyOutbox({ role: 'worker', sessionId: l.sessionId, card: 'C-1' }, outboxFile(w.E, 'worker', l.sessionId, 'handin-1.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`)), 'hand-in');
  passingVerdict(w.E, 'C-1', 'R-1', HEAD);
  must(put(w.E.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
  must(w.rec.write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: 0, doc: { type: 'pr', head_sha: HEAD, state: 'open', merged: false, at: iso(w.E.clock.t), observed_at: iso(w.E.clock.t) } }), 'pr reading');
}
// The gate takes a merge to checking and M6's settleMerge refuses it for `reason` (the card goes back to verified).
function gateRefuses(w, mgId, reason) {
  must(w.rec.write({ actor: 'merge_gate', entity: 'merge', id: mgId, expectRev: 0, doc: { state: 'requested', card: 'C-1', pr: 7, head: HEAD, product: PRODUCT } }), `${mgId} requested`);
  must(put(w.rec, 'merge_gate', 'merge', mgId, { state: 'queued' }), `${mgId} queued`);
  const mg = w.rec.read('merge', mgId);
  const cd = w.rec.read('card', 'C-1');
  must(w.rec.write({ actor: 'merge_gate', entity: 'merge', id: mgId, expectRev: mg.rev, doc: { ...mg.doc, state: 'checking', judged_head: HEAD },
    also: [{ entity: 'card', id: 'C-1', expectRev: cd.rev, doc: { ...cd.doc, state: 'merging' } }] }), `${mgId} checking`);
  const r = settleMerge({ record: w.E.review, now: w.E.clock.t }, mgId, { reason });
  assert.equal(r.ok, true, r.reason);
}
const askText = /card C-1: the merge was refused twice for the same reason \(409\), but the card could not be put on you/;
const putOnYou = /a card could not be put on you: C-1/;
const toldCount = (w) => w.delivered.filter((t) => askText.test(t)).length;

// P-D, L405 m2: a card refused twice whose ask the Record refuses (here every wait write is refused; L134: an approved
// card is no longer one, M9 lets it wait). Where no watcher saw the refusal, the ask tells it, and a queue that did not
// take that alert writes no told note. Under the real tick the watcher tells it, so the ask adds no second alert.
test('audit r5 P-D: a could-not-ask alert not taken writes no told note; one no watcher saw is told by the ask', async () => {
  const w = world({ refuseWait: true });
  await verifiedCard(w);
  gateRefuses(w, 'MG-1', '409'); gateRefuses(w, 'MG-2', '409');
  must(put(w.E.review, 'approvals', 'card', 'C-1', { state: 'approved' }), 'approved');
  w.E.clock.t += MIN;
  const r = requestMerges({ rec: w.rec, rules: w.rules, now: w.E.clock.t, b: GREEN, running: [], alert: () => false });
  assert.match(r[0][1], /^not sent to joe: the wait write is refused in this test/);
  assert.equal(w.rec.read('fact', ASK_REFUSED_FACT('C-1', 2)), null, 'no told note while untold');
  const said = fakeAlert();
  requestMerges({ rec: w.rec, rules: w.rules, now: w.E.clock.t, b: GREEN, running: [], alert: said });
  assert.equal(said.calls.filter(([t]) => askText.test(t)).length, 1, 'no watcher here, so the ask tells it');
  for (let i = 0; i < 5; i++) { w.E.clock.t += MIN; await w.runTick(); }
  assert.equal(toldCount(w), 0, JSON.stringify(w.delivered));
  assert.equal(w.delivered.filter((t) => putOnYou.test(t)).length, 1, JSON.stringify(w.delivered));
  assert.equal(w.rec.list('merge_request').length, 0, 'not requested again');
});

// L405 m3, m2: the tell refused, then the tell taken with the card write still refused. The tell's clearing must not
// end the promise the first alert made: the ask's own card write is watched too.
test('L405: a refused ask stays told each day when its tell lands and its card write does not; one alert, then cleared once it lands', async () => {
  const down = { tell: true, wait: true };
  const w = world({ refuseIf: (x) => (down.tell && x?.kind === 'wait_tell') || (down.wait && x?.kind === 'merge_repeat_ask') });
  await verifiedCard(w);
  gateRefuses(w, 'MG-1', '409'); gateRefuses(w, 'MG-2', '409');
  must(put(w.E.review, 'approvals', 'card', 'C-1', { state: 'approved' }), 'approved');
  const told = () => w.delivered.filter((t) => putOnYou.test(t)).length;
  w.E.clock.t += MIN; await w.runTick();
  assert.equal(told(), 1, JSON.stringify(w.delivered));
  assert.equal(toldCount(w), 0, 'one alert for a refused tell');
  down.tell = false;
  w.E.clock.t += MIN; await w.runTick();
  assert.deepEqual(w.rec.read('fact', REFUSED_FACT('joe_wait')).doc.items.map((x) => `${x.entity}/${x.id}`), ['card/C-1'], 'still held by the card write');
  assert.equal(told(), 1, 'quiet within the day');
  assert.equal(toldCount(w), 0, 'one alert for a refused card write');
  w.E.clock.t += 24 * 60 * MIN; await w.runTick();
  assert.equal(told(), 2, 'told again a day on');
  down.wait = false;
  w.E.clock.t += MIN; await w.runTick();
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'waiting');
  assert.deepEqual(w.rec.read('fact', REFUSED_FACT('joe_wait')).doc.items, [], 'cleared once it lands');
});

// P-F: requestMerges lists the card as refused twice, but the gate (another process) records a newer, different
// refusal before askOnRepeat re-reads it: there is nothing to ask, the ask is null, and nothing is listed.
for (const race of [false, true]) {
  test(`audit r5 P-F: ${race ? 'a newer different refusal between the list and the re-read leaves nothing to ask' : 'control: with no race the card is asked about'}`, async () => {
    const w = world();
    await verifiedCard(w);
    gateRefuses(w, 'MG-1', '409'); gateRefuses(w, 'MG-2', '409');
    const real = w.rec;
    let raced = false;
    const proxy = { ...Object.fromEntries(Object.keys(real).map((k) => [k, typeof real[k] === 'function' ? real[k].bind(real) : real[k]])),
      read: (e, id, ...rest) => {
        if (race && e === 'card' && id === 'C-1' && !raced) {
          raced = true;
          const cur = w.E.review.read('card', 'C-1');
          must(w.E.review.write({ actor: 'merge_gate', entity: 'card', id: 'C-1', expectRev: cur.rev, doc: { ...cur.doc, attempts: { ...cur.doc.attempts, merge_refusals: [...cur.doc.attempts.merge_refusals, '422'] } } }), 'gate refusal');
        }
        return real.read(e, id, ...rest);
      } };
    const out = requestMerges({ rec: proxy, rules: w.rules, now: w.E.clock.t, b: GREEN, running: [], alert: () => true });
    assert.equal(raced, race);
    if (race) assert.deepEqual(out, [], 'the guard lists nothing; without it a null would be listed');
    else assert.deepEqual(out, [['C-1', 'waiting on joe']]);
  });
}
