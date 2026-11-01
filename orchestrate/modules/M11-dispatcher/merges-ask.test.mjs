// merges-ask.test.mjs — the "refused twice" ask, over the real Record (M9 setup, real permissions) and real tick().
// Built from the audit r5 probes P-D and P-F (L127).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, ACCOUNT_FACT } from './tick.mjs';
import { dispatcherPass } from './pass.mjs';
import { requestMerges, ASK_REFUSED_FACT } from './merges.mjs';
import { settleMerge } from '../M6-merge-gate/merge-outcome.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, usageFact, withAlerts } from './fixtures.test-helper.mjs';
import { setup, product, readyCard, outboxFile, passingVerdict, put, must, HEAD, PRODUCT, iso } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const MIN = 60_000;
const ACCT = 'acct-a';
const HOST = 'mac-a';
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const GREEN = { band: 'green', own_building: 'open', pace: 0.5, prodBlocked: false };

function world() {
  const E = setup({ prefix: 'm11-mergeask-', probe: { kill() {}, pidStart: () => 'start' }, host: HOST });
  const rec = E.record;
  product(E);
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  must(rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: E.clock.t }) }), 'usage');
  must(rec.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { account: ACCT, observed_at: iso(E.clock.t) } }), 'account');
  const launched = [];
  let n = 0;
  const pass = () => withAlerts(rec, E.clock.t, () => {}, (alert) => dispatcherPass({
    rec, rules, now: E.clock.t, account: ACCT, sessions: [], probe: () => idle, host: HOST,
    launch: async (x) => { n += 1; launched.push({ card: x.card.id, sessionId: x.sessionId }); return { ok: true, sessionId: x.sessionId, pid: 1000 + n, pidStart: 'start', pgid: 100 + n, head: HEAD }; },
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
const toldCount = (w) => w.delivered.filter((t) => askText.test(t)).length;

// P-D: an approved card refused twice (the Record does not let approved wait yet) whose "could not ask" alert the queue
// did not take: the told note is not written, so a later pass tells Joe, once.
test('audit r5 P-D: the could-not-ask alert answering false writes no told note; Joe is told once on a later tick', async () => {
  const w = world();
  await verifiedCard(w);
  gateRefuses(w, 'MG-1', '409'); gateRefuses(w, 'MG-2', '409');
  must(put(w.E.review, 'approvals', 'card', 'C-1', { state: 'approved' }), 'approved');
  w.E.clock.t += MIN;
  const r = requestMerges({ rec: w.rec, rules: w.rules, now: w.E.clock.t, b: GREEN, running: [], alert: () => false });
  assert.match(r[0][1], /^not sent to joe/);
  assert.equal(w.rec.read('fact', ASK_REFUSED_FACT('C-1', 2)), null, 'no told note while untold');
  for (let i = 0; i < 5; i++) { w.E.clock.t += MIN; await w.runTick(); }
  assert.equal(toldCount(w), 1, JSON.stringify(w.delivered));
  assert.ok(w.rec.read('fact', ASK_REFUSED_FACT('C-1', 2)), 'noted once delivered');
  assert.equal(w.rec.list('merge_request').length, 0, 'not requested again');
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
