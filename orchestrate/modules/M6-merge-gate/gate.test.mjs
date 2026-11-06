// gate.test.mjs — the Merge Gate's pass against a real M9 record (every write through the writer) and a fake GitHub:
// a clean card merges through the paired write and is marked; the outside check shut stops everything; a red check,
// a GitHub refusal and a stopped pass each end where they should; behind main catches up; the queue order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, product, leadCard, runCard, outboxFile, put, must, plan, PRODUCT, fingerprintFor, fullTimeouts, runnerLaunch, runnerEndedRecord, runnerAsideRecord, launch } from '../M9-record/fixtures.test-helper.mjs';
import { chmodSync } from 'node:fs';
import { fakeRules, allow, deny, makeRules } from '../../shared/rules.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { rulesFromText } from '../M10-rules/from-text.mjs';
import { fakeGateGitHub } from './fixtures/fake-gate-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { blobSha } from '../M10-rules/reader.mjs';
import { ROBOT_FACT, NO_PUSH_FACT } from '../M12-sensors/outside-watch.mjs';
import { gatePass, queueOrder, NOT_GREEN_LINE, MERGE_LIMIT_TOLD_FACT, FINAL_NOTE, GITHUB_NO_NOTE, CHECK_CUT_NOTE, WAIT_CAP_TIMES, DEFAULT_WAIT_LIMIT_MIN, waitCapNote } from './gate.mjs';
import { readMark } from './mark.mjs';
import { readNeedsJoe } from './checker-entry.mjs';
import { gatherFacts } from './gather.mjs';
import { timeLimits, requestMerges } from '../M11-dispatcher/merges.mjs';
import { MERGED_OUTSIDE, MERGED_OUTSIDE_UNTOLD, settleMerge, reconcileMerge } from './merge-outcome.mjs';
import { markReverted } from './undo.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';

const POLICY = 'tiers: {}\n';
const CLEAN = { correct: 'clean', well_built: 'clean', works_for_user: 'clean', holds_up: 'clean' };

function world({ values = {}, mergeAnswer } = {}) {
  const env = setup({ prefix: 'm6-gate-' });
  product(env);
  const g = fakeGateGitHub();
  const root = g.commit([], { 'orchestrate/policy.yaml': POLICY, 'src/a.mjs': 'one' });
  g.main = root;
  const vals = {
    timeouts: fullTimeouts(),
    'approvals.plan_go.go_free.lead_daily_card': ['docs/daily/*.md'],
    'approvals.plan_go.go_free.exact_reverse': true,
    'product.cutover_stage': 'second',
    'product_profile.required_checks': ['test'],
    'product_profile.robot': { bot_user_id: g.robotId },
    effect_paths: { first_customer_visible: { new_files_under: ['app/pages/'] } },
    'rules.adopted': { blob: blobSha(Buffer.from(POLICY)) },
    ...values,
  };
  const rules = fakeRules({ values: vals, answers: { merge: mergeAnswer ?? allow('in lane') } });
  const facts = new Map([[ROBOT_FACT(PRODUCT), { product: PRODUCT, green: true, red_since: null, last_green_at: new Date(env.clock.t).toISOString() }],
    [NO_PUSH_FACT, { green: true, at: new Date(env.clock.t).toISOString() }]]);
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const alerts = [];
  // The gate's view of the Record knows the review user, as in production (its moves back to verified read the verdict
  // file again, L66 M1); env.record is the same store.
  const ctx = { record: env.review, rules, product: PRODUCT, gh: g.gh, owner: 'sample-org', repo: 'sample-app', view, now: () => env.clock.t, alert: (a) => alerts.push(a), readFact: (id) => facts.get(id) ?? null,
    reviewLaunches: { root: env.launchRoot, uids: env.reviewUids, outbox: env.outRoot } };
  return { env, g, ctx, facts, alerts, root, values: vals };
}

// A card built, reviewed by a reviewer the review runner launched (its own record, L65) through the review outbox,
// verified, and asked to merge as pull #7.
function verifiedCard(w, id = 'C-1', { pr = 7, files = { 'src/a.mjs': 'two' }, undo, request = true } = {}) {
  const { env, g } = w;
  if (undo) {
    // The Dispatcher's undo card, from an authenticated audit issue (lane 2 makes it; here it is made the same way).
    must(env.record.write({ actor: 'sensors', entity: 'fact', id: `undo-issue-${id}`, expectRev: 0, doc: { type: 'undo_issue', authenticated: true, commit: undo } }), 'issue');
    must(env.record.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'exact_reverse', source: { fact: `undo-issue-${id}` }, ...plan({ files: Object.keys(files) }) } }), 'undo card');
  } else {
    const doc = leadCard(env, id, { files: Object.keys(files) });
    must(env.record.write({ actor: 'approvals', entity: 'go', id: `go-${id}`, expectRev: 0, doc: { product: PRODUCT, card_id: id, plan_fingerprint: fingerprintFor(id, doc), files: Object.keys(files), tier: 2, rows: {} } }), 'go');
  }
  must(put(env.record, 'dispatcher', 'card', id, { state: 'ready' }), 'ready');
  runCard(env, id);
  const head = g.commit([g.main], files, { from: g.main });
  g.openPull({ number: pr, head, files });
  must(put(env.record, 'workshop', 'card', id, { head }), 'head');
  must(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: id }, outboxFile(env, 'worker', 'S-1', `handin-${id}.md`, `${JSON.stringify({ entity: 'card', id, from_state: 'running', to_state: 'in_review' })}\n`)), 'in review');
  const sid = `R-${id}`;
  runnerLaunch(env, id, sid, 'reviewer', head);
  const hdr = `${JSON.stringify({ entity: 'verdict', card: id, expectRev: env.record.read('card', id).rev, fields: { head, pass: true, checklist: CLEAN, material: 0 } })}\n`;
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: sid, card: id }, outboxFile(env, 'reviewer', sid, `verdict-${id}.md`, hdr)), 'verdict');
  runnerEndedRecord(env, id, sid, 'reviewer', head);
  must(put(env.review, 'dispatcher', 'card', id, { state: 'verified' }), 'verified');
  if (request) requestMerge(w, id, pr, head);
  return head;
}

function requestMerge(w, id, pr, head) {
  const { env } = w;
  must(env.record.write({ actor: 'dispatcher', entity: 'merge_request', id: `mr-${id}`, expectRev: 0, doc: { card: id, pr, session_id: 'S-1', head, rev: env.record.read('card', id).rev, requested_at: new Date(env.clock.t).toISOString() } }), 'request');
  return head;
}

// M10's real engine on its sample policy answers the merge and the classification; the values stay the world's.
const here = dirname(fileURLToPath(import.meta.url));
function realRules(w, { deep, state = () => ({ state: 'active' }) }) {
  const policy = parsePolicy(readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8'));
  assert.ok(policy.ok, policy.reason);
  const eng = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => ({ status: 'ok', policy: policy.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: state, running: () => 0, rolesDir: join(here, '../M10-rules/roles'), clock: () => w.env.clock.t, deepMerge: deep }));
  w.ctx.rules = fakeRules({ values: w.values, answers: { merge: (sub) => eng.may('merge', sub) }, classify: (c) => eng.classify(c) });
}

const mergeOf = (w, id = 'C-1') => w.env.record.list('merge').find((m) => m.doc.card === id);

test('a clean card merges: paired write, squash merge of the judged head, card merged, the robot\'s mark', async () => {
  const w = world();
  const head = verifiedCard(w);
  const mainBefore = w.g.main;
  const r = await gatePass(w.ctx);
  assert.equal(r.ran, true);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged', JSON.stringify({ did: r.did, alerts: w.alerts }));
  assert.deepEqual(r.did.map((d) => d.step), ['requested', 'queued', 'checking', 'merging', 'merged', 'marked']);
  // The needs-joe status the GitHub-side checker reads: a Tier-2 change that needed no Approve says so.
  assert.deepEqual(await readNeedsJoe({ gh: w.g.gh, owner: 'sample-org', repo: 'sample-app', sha: m.doc.merge_commit, robotBotId: w.g.robotId }), { needsJoe: false, tier: 2, reason: 'robot status' });
  const card = w.env.record.read('card', 'C-1').doc;
  assert.equal(card.state, 'merged');
  assert.equal(card.merge_commit, m.doc.merge_commit);
  assert.equal(w.g.main, m.doc.merge_commit);
  const puts = w.g.writes.filter(([k]) => k === 'put');
  assert.deepEqual(puts.map(([, p, b]) => [p, b]), [['/repos/sample-org/sample-app/pulls/7/merge', { sha: head, merge_method: 'squash' }]]);
  assert.equal(m.doc.judged_main, mainBefore);
  const mark = await readMark({ gh: w.g.gh, owner: 'sample-org', repo: 'sample-app', sha: m.doc.merge_commit, robotBotId: w.g.robotId });
  assert.deepEqual(mark, { ok: true, card: 'C-1', head, pr: 7 });
  assert.deepEqual(w.alerts, []);

  // The audit result comes only from a Sensors audit_run fact for that commit.
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'audit_flagged');
  assert.deepEqual(w.alerts, []);
});

test('the undo route: a flagged merge\'s exact reverse goes first, merges with no Approve, and the undone card is reverted', async () => {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'audit_flagged');
  must(put(w.env.record, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  // An ordinary card waiting since earlier, and the undo card: the undo is served first.
  w.env.clock.t += 60_000;
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  w.env.clock.t += 60_000;
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
  w.ctx.rules = fakeRules({ values: w.values, answers: { merge: allow('in lane') } });
  const r = await gatePass(w.ctx);
  const u = mergeOf(w, 'U-1');
  assert.equal(u.doc.state, 'merged', JSON.stringify({ did: r.did, reasons: u.doc.reasons, alerts: w.alerts }));
  assert.equal(mergeOf(w, 'C-2').doc.state, 'queued');
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'reverted');
  assert.ok(r.did.some((d) => d.step === 'reverted' && d.card === 'C-1'));
  assert.equal(w.g.repo.files(w.g.main).get('src/a.mjs').text, 'one');
});

// L595: the whole way on a paused product, on M10's real engine reading the Record's state. The undo card goes ready,
// runs, is reviewed and merges; an ordinary change queued before the pause does not.
for (const stage of ['first', 'second']) test(`L595: on a paused product the undo merges through the real gate and an ordinary change does not (${stage} cutover)`, async () => {
  const w = world({ values: { 'product.cutover_stage': stage } });
  const DOC = 'docs/note.md';
  w.g.main = w.g.commit([w.g.main], { [DOC]: 'one' }, { from: w.g.main });
  verifiedCard(w, 'C-1', { files: { [DOC]: 'two' } });
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  assert.ok(flagged, JSON.stringify(mergeOf(w).doc));
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'audit_flagged');
  must(put(w.env.record, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  w.env.clock.t += 60_000;
  verifiedCard(w, 'C-2', { pr: 8, files: { 'docs/other.md': 'b' } });
  must(w.env.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: w.env.record.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  realRules(w, { deep: stage === 'second', state: () => w.env.record.read('product', PRODUCT).doc });
  await gatePass(w.ctx);
  assert.ok(mergeOf(w, 'C-2').doc.reasons?.some((x) => /product is paused/.test(x)), JSON.stringify(mergeOf(w, 'C-2').doc));
  w.env.clock.t += 60_000;
  verifiedCard(w, 'U-1', { pr: 9, files: { [DOC]: 'one' }, undo: flagged });
  const r = await gatePass(w.ctx);
  const u = mergeOf(w, 'U-1');
  assert.equal(u.doc.state, 'merged', JSON.stringify({ did: r.did, reasons: u.doc.reasons, alerts: w.alerts }));
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'reverted');
  assert.equal(w.g.repo.files(w.g.main).get(DOC).text, 'one');
  assert.notEqual(w.env.record.read('card', 'C-2').doc.state, 'merged');
});

// An undo skips refusal 1, so refusal 2 is what stops it: main is never green on a list that names no check.
test('L96 m-1: an undo card does not merge when the rules name an empty list of required checks, or none, and its hold says so (L531)', async () => {
  for (const list of [[], null, ['  '], ['test', ''], [' test']]) {
    const w = world();
    verifiedCard(w);
    await gatePass(w.ctx);
    const flagged = mergeOf(w).doc.merge_commit;
    must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
    await gatePass(w.ctx);
    must(put(w.env.record, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
    w.env.clock.t += 60_000;
    verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
    w.values['product_profile.required_checks'] = list;
    w.ctx.rules = fakeRules({ values: w.values, answers: { merge: allow('in lane') } });
    await gatePass(w.ctx);
    const u = mergeOf(w, 'U-1');
    assert.notEqual(u.doc.state, 'merged', JSON.stringify(list));
    assert.match(JSON.stringify(u.doc), /2: the rules name no required checks/, JSON.stringify(u.doc));
  }
});

// L135 site G: the undo card merged, but marking the undone card reverted failed, and the alert saying so was lost
// (false, or a throw). The gate tries again each pass until the mark holds or the alert is delivered, then stops.
async function undoWithBlockedMark(lost) {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  must(put(w.env.record, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  w.env.clock.t += 60_000;
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
  w.ctx.rules = fakeRules({ values: w.values, answers: { merge: allow('in lane') } });
  const real = w.ctx.record;
  const lose = { mark: true, alert: lost };
  // The record is frozen: a wrapper with every method bound, and write refusing only the reverted mark.
  const wrap = {};
  for (const k of Object.keys(real)) wrap[k] = typeof real[k] === 'function' ? real[k].bind(real) : real[k];
  wrap.write = (req) => (lose.mark && req.entity === 'card' && req.id === 'C-1' && req.doc?.state === 'reverted' ? { ok: false, reason: 'planted refusal' } : real.write(req));
  w.ctx.record = wrap;
  w.ctx.alert = (a) => {
    w.alerts.push(a);
    if (a.type !== 'undo_not_marked' || lose.alert === 'ok') return true;
    if (lose.alert === 'throws') throw new Error('the alert could not be sent');
    return false;
  };
  const tries = () => w.alerts.filter((a) => a.type === 'undo_not_marked').length;
  const settled = () => mergeOf(w, 'U-1').doc.revert_settled_at;
  return { w, lose, tries, settled };
}

test('L135 G: a lost undo_not_marked alert is retried each pass; the mark landing later settles it once', async () => {
  for (const lost of [false, 'throws']) {
    const { w, lose, tries, settled } = await undoWithBlockedMark(lost);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w, 'U-1').doc.state, 'merged', `${lost}: the undo merged`);
    assert.equal(w.env.record.read('card', 'C-1').doc.state, 'closed', `${lost}: the mark was refused`);
    assert.equal(tries(), 1);
    assert.equal(settled(), undefined, `${lost}: not settled while the alert is lost`);
    await gatePass(w.ctx);
    assert.equal(tries(), 2, `${lost}: tried again next pass`);
    lose.mark = false;
    const r = await gatePass(w.ctx);
    assert.equal(w.env.record.read('card', 'C-1').doc.state, 'reverted', `${lost}: marked once the write holds`);
    assert.ok(r.did.some((d) => d.step === 'reverted' && d.card === 'C-1'));
    assert.ok(settled(), `${lost}: settled`);
    await gatePass(w.ctx);
    assert.equal(tries(), 2, `${lost}: no more tries once settled`);
  }
});

test('L135 G: a delivered undo_not_marked alert settles the merge; the gate does not keep asking', async () => {
  const { w, lose, tries, settled } = await undoWithBlockedMark(false);
  lose.alert = 'ok';
  await gatePass(w.ctx);
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'closed');
  assert.equal(tries(), 1);
  assert.ok(settled(), 'told the owner, so settled');
  await gatePass(w.ctx);
  await gatePass(w.ctx);
  assert.equal(tries(), 1, 'told once');
});

// L168 M-4: the "main moved under the merge" alert carries the Undo? ask. The view says the merge commit's parent is
// not the judged main (only for that commit). A lost or throwing one leaves the parent check
// unmarked, so each later pass checks and tells again until it is delivered; then parent_checked_at stops it.
function movedParent(w, mode) {
  const real = w.ctx.view;
  const moved = 'f'.repeat(40);
  // The view is frozen: a wrapper with every method bound, and commit() changed only for the merge commit.
  const view = {};
  for (const k of Object.keys(real)) view[k] = typeof real[k] === 'function' ? real[k].bind(real) : real[k];
  view.commit = async (sha) => { const k = await real.commit(sha); return sha === mergeOf(w)?.doc?.merge_commit ? { ...k, parents: [moved] } : k; };
  w.ctx.view = view;
  const lose = { mode };
  const tries = [];
  w.ctx.alert = (a) => {
    w.alerts.push(a);
    if (a.type !== 'merge_parent_moved') return true;
    tries.push(a);
    if (lose.mode === 'throws') throw new Error('the alert could not be sent');
    return lose.mode !== 'false';
  };
  return { lose, tries };
}

test('L168 M-4: a lost merge_parent_moved alert is told again each pass until delivered, then not again', async () => {
  for (const mode of ['false', 'throws']) {
    const w = world();
    verifiedCard(w);
    const { lose, tries } = movedParent(w, mode);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'merged', `${mode}: the merge stands`);
    assert.equal(tries.length, 1, `${mode}: told`);
    assert.equal(tries[0].ask_owner, 'Undo?');
    assert.equal(mergeOf(w).doc.parent_checked_at, undefined, `${mode}: not marked while the alert is lost`);
    await gatePass(w.ctx);
    assert.equal(tries.length, 2, `${mode}: told again on the next pass`);
    lose.mode = 'ok';
    await gatePass(w.ctx);
    assert.equal(tries.length, 3, `${mode}: delivered`);
    assert.ok(mergeOf(w).doc.parent_checked_at, `${mode}: marked once delivered`);
    await gatePass(w.ctx);
    await gatePass(w.ctx);
    assert.equal(tries.length, 3, `${mode}: not told again`);
  }
});

// L172: the merge commit's read fails while `down` says so. The parent answers `parent` when it works.
function blip(w, sink = 'ok') {
  const real = w.ctx.view;
  const view = {};
  for (const k of Object.keys(real)) view[k] = typeof real[k] === 'function' ? real[k].bind(real) : real[k];
  const state = { down: false, parent: null, sink, sent: [], undo: [] };
  view.commit = async (sha) => {
    if (sha !== mergeOf(w)?.doc?.merge_commit) return real.commit(sha);
    if (state.down) throw new Error('GitHub is down');
    const k = await real.commit(sha);
    return state.parent ? { ...k, parents: [state.parent] } : k;
  };
  w.ctx.view = view;
  const note = (x) => {
    w.alerts.push(x);
    if (x.type === 'merge_parent_moved') state.undo.push(x);
    if (x.type === 'merge_gate_unsure') state.sent.push(x);
    return x.type === 'merge_gate_unsure';
  };
  w.ctx.alert = fakeAlert({
    throws: (x) => note(x) && state.sink === 'throws' && 'the alert could not be sent',
    answer: (x) => x.type !== 'merge_gate_unsure' || state.sink !== 'false',
  });
  return state;
}

test('L172: one failed read of the merge commit tells nothing and marks nothing, and the next pass still asks Undo?', async () => {
  const w = world();
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
  assert.equal(mergeOf(w).doc.parent_read_failures, 1);
  assert.equal(mergeOf(w).doc.parent_checked_at, undefined, 'not marked, so the next pass reads again');
  assert.deepEqual([s.undo.length, s.sent.length], [0, 0], 'a failed read is not a moved main');
  s.down = false;
  s.parent = 'f'.repeat(40);
  await gatePass(w.ctx);
  assert.equal(s.undo.length, 1);
  assert.equal(s.undo[0].ask_owner, 'Undo?');
  assert.equal(s.undo[0].parent, s.parent);
  assert.ok(mergeOf(w).doc.parent_checked_at);
});

test('L172, L601: the third failed read tells the owner, the next day\'s pass tells again, and a read that works is still checked', async () => {
  const w = world();
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  await gatePass(w.ctx);
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 0, 'two failures say nothing');
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 1, 'told on the third');
  assert.match(s.sent[0].note, /could not check the parent of .+: 3 reads failed/);
  assert.equal(s.sent[0].merge, mergeOf(w).id);
  const rev = mergeOf(w).rev;
  assert.ok(rev > 0);
  await gatePass(w.ctx);
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 1, 'told once that day');
  assert.equal(mergeOf(w).rev, rev, 'nothing more is written that day while it stays down');
  assert.equal(mergeOf(w).doc.parent_checked_at, undefined);
  w.env.clock.t += 23 * 3_600_000;
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 1, 'not yet a day');
  w.env.clock.t += 3_600_000;
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 2, 'told again a day on');
  assert.match(s.sent[1].note, /reads are still failing/);
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 2, 'then quiet for another day');
  s.down = false;
  s.parent = 'f'.repeat(40);
  await gatePass(w.ctx);
  assert.equal(s.undo.length, 1, 'the check still happens');
  assert.ok(mergeOf(w).doc.parent_checked_at);
});

test('L172: a lost "could not check" alert is told again each pass until delivered, then not again', async () => {
  for (const mode of ['false', 'throws']) {
    const w = world();
    verifiedCard(w);
    const s = blip(w, mode);
    s.down = true;
    for (let i = 0; i < 4; i += 1) await gatePass(w.ctx);
    assert.equal(s.sent.length, 2, `${mode}: tried on the third and fourth`);
    assert.equal(mergeOf(w).doc.parent_unread_told_at, undefined, `${mode}: not marked while lost`);
    s.sink = 'ok';
    await gatePass(w.ctx);
    assert.equal(s.sent.length, 3, `${mode}: delivered`);
    assert.ok(mergeOf(w).doc.parent_unread_told_at, `${mode}: marked once delivered`);
    await gatePass(w.ctx);
    assert.equal(s.sent.length, 3, `${mode}: not told again`);
  }
});

test('L601: a told mark in the future does not hold back the next day\'s word (L329)', async () => {
  const w = world();
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  for (let i = 0; i < 3; i += 1) await gatePass(w.ctx);
  assert.equal(s.sent.length, 1);
  const m = mergeOf(w);
  must(recOf(w).write({ actor: 'merge_gate', entity: 'merge', id: m.id, expectRev: m.rev, doc: { ...m.doc, parent_unread_told_at: new Date(w.env.clock.t + 3_600_000 * 72).toISOString() } }), 'a mark from the future');
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 2);
});

test('L601: with the start gate shut, the parent check still reads, counts, tells and asks Undo?, and nothing else moves', async () => {
  const w = world(limited());
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  await gatePass(w.ctx);
  tick(w, 121);   // the outside check has not been green for 2 h: the start gate is shut
  const marksBefore = w.g.writes.length;
  for (const want of [2, 3, 3]) {
    const r = await gatePass(w.ctx);
    assert.equal(r.ran, false, 'the gate is shut');
    assert.equal(mergeOf(w).doc.parent_read_failures, want, 'the count goes on while the gate is shut');
  }
  assert.equal(s.sent.length, 1, '"could not check" is told while the gate is shut');
  s.down = false;
  s.parent = 'f'.repeat(40);
  await gatePass(w.ctx);
  assert.equal(s.undo.length, 1, 'Undo? is asked while the gate is shut');
  assert.ok(mergeOf(w).doc.parent_checked_at);
  assert.equal(w.g.writes.length, marksBefore, 'no GitHub write went out, so complete() stayed below the gate');
});

test('L601: a count that can\'t be saved still tells "could not check", and says so', async () => {
  const w = world();
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  const real = w.ctx.record;
  const wrap = {};
  for (const k of Object.keys(real)) wrap[k] = typeof real[k] === 'function' ? real[k].bind(real) : real[k];
  wrap.write = (req) => (req.entity === 'merge' && req.doc?.parent_read_failures !== undefined ? { ok: false, reason: 'planted refusal' } : real.write(req));
  w.ctx.record = wrap;
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].note, /a read failed and the count could not be saved/);
  assert.equal(w.alerts.filter((a) => a.type === 'merge_gate_write_refused').length, 1);
  assert.equal(mergeOf(w).doc.parent_read_failures, undefined);
});

test('L601: with the start gate shut, a merge whose marks failed gets no GitHub write until the gate opens', async () => {
  const w = world(limited());
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  w.g.answer.status = () => ({ status: 500, json: null });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.marked_at, undefined, 'the marks failed');
  w.g.answer.status = null;
  tick(w, 121);
  const before = w.g.writes.length;
  for (let i = 0; i < 3; i += 1) assert.equal((await gatePass(w.ctx)).ran, false);
  assert.equal(w.g.writes.length, before, 'complete() runs only past the start gate');
  assert.equal(mergeOf(w).doc.marked_at, undefined);
  assert.equal(mergeOf(w).doc.parent_read_failures, 3, 'the parent check still ran');
});

test('L601: with the start gate shut, an audit-passed merge whose parent was never checked is still read', async () => {
  for (const state of ['audited_ok', 'audit_flagged']) {
    const w = world(limited());
    verifiedCard(w);
    const s = blip(w);
    s.down = true;
    await gatePass(w.ctx);
    const m = mergeOf(w);
    const conclusion = state === 'audited_ok' ? 'success' : 'failure';
    must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion } }), 'fact');
    must(put(w.env.record, 'merge_gate', 'merge', m.id, { state }, { data: { fact: 'audit-run-1' } }), state);
    assert.equal(mergeOf(w).doc.parent_checked_at, undefined, 'never checked before the gate shuts');
    tick(w, 121);
    s.down = false;
    s.parent = 'f'.repeat(40);
    assert.equal((await gatePass(w.ctx)).ran, false);
    assert.equal(s.undo.length, 1, `${state}: Undo? is asked`);
    assert.ok(mergeOf(w).doc.parent_checked_at, state);
  }
});

test('L601: a count refused on the third read tells "could not check" once, not twice', async () => {
  const w = world();
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  await gatePass(w.ctx);
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 0);
  const real = w.ctx.record;
  const wrap = {};
  for (const k of Object.keys(real)) wrap[k] = typeof real[k] === 'function' ? real[k].bind(real) : real[k];
  wrap.write = (req) => (req.entity === 'merge' && req.doc?.parent_read_failures !== undefined ? { ok: false, reason: 'planted refusal' } : real.write(req));
  w.ctx.record = wrap;
  await gatePass(w.ctx);
  assert.equal(s.sent.length, 1, 'the third read is told once');
  assert.match(s.sent[0].note, /3 reads failed/);
});

test('L172: a read that works after failures, with the parent as judged, ends it with no alert', async () => {
  const w = world();
  verifiedCard(w);
  const s = blip(w);
  s.down = true;
  await gatePass(w.ctx);
  await gatePass(w.ctx);
  s.down = false;
  await gatePass(w.ctx);
  assert.ok(mergeOf(w).doc.parent_checked_at);
  assert.deepEqual([s.undo.length, s.sent.length], [0, 0]);
});

test('L168 M-4: a parent that matches is marked checked at once, with no alert', async () => {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  assert.ok(mergeOf(w).doc.parent_checked_at);
  assert.equal(w.alerts.filter((a) => a.type === 'merge_parent_moved').length, 0);
});

test('an undo card whose change is not the exact reverse is refused (9) and never merged', async () => {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(put(w.env.record, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'something else' }, undo: flagged });
  await gatePass(w.ctx);
  const u = mergeOf(w, 'U-1');
  assert.equal(u.doc.state, 'refused');
  assert.ok(u.doc.reasons.some((x) => x.startsWith('9:')), u.doc.reasons.join(' | '));
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'closed');
});

// L123 m-1: the go-free read at gather (gather.mjs, refusal 10) goes by the value as the rules file gives it, text.
// `exact_reverse: false` there is the text 'false', which is not go-free: the undo card still needs a go.
test('L123 m-1: exact_reverse "false" in the rules still needs a go for an undo card; "true" skips it', async () => {
  for (const [v, skipped] of [['false', false], [false, false], ['yes', false], ['true', true], [true, true]]) {
    const w = world({ values: { 'approvals.plan_go.go_free.exact_reverse': v } });
    verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: w.root });
    await gatePass(w.ctx);   // the gate takes the request in, so there is a merge to gather facts for
    if (!skipped) assert.ok(mergeOf(w, 'U-1').doc.reasons?.some((x) => x.startsWith('10:')), `${v}: refused for no go`);
    // L134 c-2: go-free means the pass gave no refusal 10 at all, not just that gather skipped the go.
    else assert.ok(!(mergeOf(w, 'U-1').doc.reasons ?? []).some((x) => x.startsWith('10:')), `${v}: no refusal 10: ${JSON.stringify(mergeOf(w, 'U-1').doc.reasons)}`);
    const f = await gatherFacts(w.ctx, mergeOf(w, 'U-1'));
    assert.equal(f.card.doc.kind, 'exact_reverse');
    if (skipped) assert.deepEqual(f.go, { ok: true, reasons: [], skipped: true }, String(v));
    else {
      assert.equal(f.go?.skipped, undefined, String(v));
      assert.equal(f.go?.ok, false, String(v));
      assert.ok(f.go.reasons.some((x) => /no go for U-1/.test(x)), `${v}: ${JSON.stringify(f.go)}`);
    }
  }
});

test('the outside check not green in 2 h: nothing happens at all', async () => {
  const w = world();
  verifiedCard(w);
  w.env.clock.t += 121 * 60_000;
  const r = await gatePass(w.ctx);
  assert.equal(r.ran, false);
  assert.equal(r.reason, NOT_GREEN_LINE);
  assert.equal(w.env.record.list('merge').length, 0);
  assert.equal(w.g.writes.length, 0);
});

test('a red required check refuses with its number; the card stays verified and a new request is taken', async () => {
  const w = world();
  const head = verifiedCard(w);
  w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' }]);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('1:')), m.doc.reasons.join(' | '));
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'verified');
  assert.equal(w.g.writes.filter(([k]) => k === 'put').length, 0);
  assert.ok(w.alerts.some((a) => a.type === 'merge_refused'));
  // The same request is never taken twice.
  await gatePass(w.ctx);
  assert.equal(w.env.record.list('merge').length, 1);
});

test('GitHub refuses the merge: refused, card back to verified, nothing marked', async () => {
  const w = world();
  verifiedCard(w);
  w.g.answer.merge = () => ({ status: 405, json: { message: 'Base branch was modified' } });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'verified');
  assert.equal([...w.g.statuses.values()].flat().length, 0);
});

// L94: the gate's own recovery decides through M6 settleMerge, the Dispatcher's function, with the same clock. Only
// GitHub's explicit "no" (405, 409, 422) refuses at once; any other answer leaves the merge merging until GitHub shows
// what happened. Every test here runs on the real Record.
const LIMIT_MIN = 15;
const limited = () => ({ values: { 'timeouts.merging_open_max_min': LIMIT_MIN } });
const gatePuts = (w) => w.g.writes.filter(([k, p]) => k === 'put' && p.endsWith('/merge')).length;
// GitHub takes the merge call but the answer never comes back (`merged` says whether GitHub did the merge).
function loseAnswer(w, { merged }) {
  const realPut = w.g.gh.put;
  w.g.gh.put = async (p, b) => {
    if (!p.endsWith('/merge')) return realPut(p, b);
    if (merged) await realPut(p, b); else w.g.writes.push(['put', p, b]);
    throw new Error('connection reset');
  };
  return realPut;
}
const recOf = (w) => w.env.record;
const cardOf = (w, id = 'C-1') => recOf(w).read('card', id).doc;
const tick = (w, min) => { w.env.clock.t += min * 60_000; };
const nowIso = (w, offsetMin = 0) => new Date(w.env.clock.t + offsetMin * 60_000).toISOString();

test('L94: a lost merge answer, then GitHub shows it merged: merging and one alert, then merged on the next pass, with the marks, the audit and an Undo to follow', async () => {
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: true });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging');
  assert.equal(cardOf(w).state, 'merging');
  assert.deepEqual(w.alerts.map((a) => a.type), ['merge_gate_unsure']);
  tick(w, 1);
  const r = await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged', JSON.stringify(r.did));
  assert.match(m.doc.merge_commit, /^[0-9a-f]{40}$/);
  assert.equal(m.doc.merge_commit, w.g.main);
  assert.ok(m.doc.marked_at, 'the robot\'s mark and the needs-joe status are posted');
  // Undo works from the card's merge_commit (M11 undo.mjs), so the card must carry it.
  assert.equal(cardOf(w).state, 'merged');
  assert.equal(cardOf(w).merge_commit, m.doc.merge_commit);
  assert.equal(gatePuts(w), 1, 'one merge call');
  assert.deepEqual(w.alerts.map((a) => a.type), ['merge_gate_unsure']);
  must(recOf(w).write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'audit_flagged');
});

test('L94: a lost merge answer and the PR stays open: merging under the limit; past it, refused (interrupted) with one alert and the card put back', async () => {
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging');
  tick(w, 5);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging', 'open under the limit: the outcome is not known yet');
  assert.equal(cardOf(w).state, 'merging');
  assert.deepEqual(w.alerts.map((a) => a.type), ['merge_gate_unsure']);
  tick(w, LIMIT_MIN - 5);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused');
  assert.deepEqual(m.doc.reasons, ['interrupted']);
  assert.equal(cardOf(w).state, 'verified');
  assert.deepEqual(cardOf(w).attempts?.merge_refusals, ['interrupted']);
  assert.deepEqual(w.alerts.map((a) => a.type), ['merge_gate_unsure', 'merge_interrupted']);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.deepEqual(w.alerts.map((a) => a.type), ['merge_gate_unsure', 'merge_interrupted'], 'told once');
  assert.equal(gatePuts(w), 1);
});

// The merge time limit read from M10's real engine (L110 M-1): a per-product key, which the engine answers only when the
// product is named. The fixture policy is parsed for real; its schema does not list timeouts.merging_open_max_min yet
// (M10's to add), so the value is set on the parsed policy, as an adopted file would give it.
test('L110 M-1: the gate reads merging_open_max_min for its product from the real engine, so a merge past the limit is refused', async () => {
  const KEY = 'timeouts.merging_open_max_min';
  const w = world();
  const parsed = parsePolicy(readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8'));
  assert.ok(parsed.ok, parsed.reason);
  const pol = structuredClone(parsed.policy);
  pol.timeouts = { ...pol.timeouts, merging_open_max_min: LIMIT_MIN };
  const eng = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => ({ status: 'ok', policy: pol, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, '../M10-rules/roles'), clock: () => w.env.clock.t }));
  assert.equal(eng.get(KEY), undefined, 'the engine gives no per-product value without a product');
  assert.equal(eng.get(KEY, { product: PRODUCT }), LIMIT_MIN);
  // The world's rules, with this one key answered by the engine, built on makeRules so num() reads the same override
  // (L148 item 1: a get-only stand-in let the merging limit go unread, and the merge was never refused).
  const base = w.ctx.rules;
  w.ctx.rules = makeRules({ get rev() { return base.rev; }, may: (a, s) => base.may(a, s), classify: (c) => base.classify(c),
    get: (k, o) => (k === KEY ? eng.get(k, o) : base.get(k, o)) });
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging');
  tick(w, LIMIT_MIN - 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging', 'under the limit');
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused', 'past the limit the engine gave for this product');
  assert.deepEqual(mergeOf(w).doc.reasons, ['interrupted']);
  assert.equal(cardOf(w).state, 'verified');
});

// L148 item 5: with no timeouts.merging_open_max_min in the rules, an open merge is never refused as interrupted, so
// the owner is told once per merge that the limit is missing. The told fact is written only once the alert was taken:
// a refused alert tells again on the next pass, and once told, no pass tells again.
// The third case reads the real rules file with its merging limit line taken out (the fixture gains one in #97), the
// key answered by M10's engine through rulesFromText, as the L110 M-1 test above does with the limit present.
const FIXTURE_TEXT = readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8');
for (const [refuseFirst, realFile] of [[false, false], [true, false], [false, true]]) {
  test(`L148 item 5: a lost merge answer with no merging limit in the rules tells the owner once${refuseFirst ? ', after a refused first alert' : ''}${realFile ? ', the line taken out of the real rules file' : ''}`, async () => {
    const w = world();
    if (realFile) {
      const KEY = 'timeouts.merging_open_max_min';
      const text = FIXTURE_TEXT.replace(/^  merging_open_max_min: .*\n/m, '');
      assert.doesNotMatch(text, /merging_open_max_min/, 'the line is out of the file');
      const real = rulesFromText({ [PRODUCT]: text }, { clock: () => w.env.clock.t });
      assert.equal(real.get(KEY, { product: PRODUCT }), undefined, 'the real engine has no limit');
      const base = w.ctx.rules;
      w.ctx.rules = makeRules({ get rev() { return base.rev; }, may: (a, s) => base.may(a, s), classify: (c) => base.classify(c),
        get: (k, o) => (k === KEY ? real.get(k, o) : base.get(k, o)) });
    }
    assert.equal(w.ctx.rules.num('timeouts.merging_open_max_min', { product: PRODUCT }), undefined, 'the rules lack the limit');
    let refuse = refuseFirst;
    const push = w.ctx.alert;
    w.ctx.alert = (a) => {
      if (a.type === 'merge_limit_missing' && refuse) { refuse = false; return false; }
      return push(a);
    };
    verifiedCard(w);
    loseAnswer(w, { merged: false });
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'merging');
    const missingTold = () => w.alerts.filter((a) => a.type === 'merge_limit_missing');
    assert.deepEqual(missingTold(), [], 'the merge call pass says it is unsure, nothing more');
    const id = mergeOf(w).id;
    for (let i = 0; i < 4; i++) {
      tick(w, 2);
      const r = await gatePass(w.ctx);
      assert.equal(mergeOf(w).doc.state, 'merging', 'never refused with no limit');
      assert.ok(r.did.some((d) => d.step === 'outcome_unknown'), JSON.stringify(r.did));
      const told = recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(id));
      if (refuseFirst && i === 0) assert.equal(told, null, 'a refused alert writes no told fact');
      else assert.equal(told?.doc?.merge, id, `pass ${i}: told is recorded`);
    }
    assert.equal(missingTold().length, 1, 'told exactly once');
    assert.equal(missingTold()[0].merge, id);
    assert.match(missingTold()[0].note, /timeouts\.merging_open_max_min/);
    assert.equal(gatePuts(w), 1, 'one merge call');
  });
}

// G14 (L110 m-6): a pass that stopped after the checking write, before any merge call, left the merge in checking.
// GitHub was never asked to merge, so a pull request still open is no unknown outcome: refused at once, the card put
// back, with no wait for the merging limit and no merge call.
test('L110 m-6 (G14): a merge stopped in checking, its PR still open, is refused at once on the next pass', async () => {
  const w = world(limited());
  verifiedCard(w);
  // The process stops right after the checking write: its next read of the Record never returns.
  const base = w.ctx.record;
  w.ctx.record = Object.create(base, { read: { value: (e, id) => {
    if (e === 'card' && mergeOf(w)?.doc.state === 'checking') throw new Error('the gate process stopped');
    return base.read(e, id);
  } } });
  await gatePass(w.ctx).catch(() => {});
  w.ctx.record = base;
  assert.equal(mergeOf(w).doc.state, 'checking', 'the stopped pass left the merge in checking');
  assert.equal(cardOf(w).state, 'merging');
  assert.equal(gatePuts(w), 0, 'GitHub was never asked to merge');
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused', 'refused at once, well under the merging limit');
  assert.deepEqual(m.doc.reasons, ['GitHub did not merge the judged head']);
  assert.equal(cardOf(w).state, 'verified');
  assert.equal(gatePuts(w), 0);
});

// L130 M5: recover() writes MERGED_OUTSIDE ("the owner was told") only when its alert was taken; an alert that answers
// false, or throws, leaves MERGED_OUTSIDE_UNTOLD, which the Dispatcher tells (merges.mjs, alert-answer.test S3).
for (const [name, answer, want] of [['taken', () => true, MERGED_OUTSIDE], ['not queued', () => false, MERGED_OUTSIDE_UNTOLD],
  ['thrown', () => { throw new Error('queue gone'); }, MERGED_OUTSIDE_UNTOLD],
  // L583 (5): no alert wired at all is "not delivered", never told (the gate's own default).
  ['none wired', null, MERGED_OUTSIDE_UNTOLD]]) {
  test(`L130: a stopped checking merge GitHub shows merged at another head is refused; the alert ${name} -> ${want === MERGED_OUTSIDE ? 'told' : 'untold'}`, async () => {
    const w = world(limited());
    verifiedCard(w);
    const base = w.ctx.record;
    w.ctx.record = Object.create(base, { read: { value: (e, id) => {
      if (e === 'card' && mergeOf(w)?.doc.state === 'checking') throw new Error('the gate process stopped');
      return base.read(e, id);
    } } });
    await gatePass(w.ctx).catch(() => {});
    w.ctx.record = base;
    assert.equal(mergeOf(w).doc.state, 'checking');
    // Merged on GitHub, outside the gate, at a head the gate never judged.
    const pr = w.g.pulls.get(7);
    Object.assign(pr, { head: w.g.commit([w.g.main], { 'src/a.mjs': 'three' }, { from: w.g.main }), state: 'closed', merged: true, merge_commit_sha: 'e'.repeat(40) });
    let asked = 0;
    if (answer) w.ctx.alert = (a) => { asked += 1; w.alerts.push(a); return answer(); };
    else delete w.ctx.alert;
    tick(w, 1);
    await gatePass(w.ctx);
    const m = mergeOf(w);
    assert.equal(m.doc.state, 'refused');
    assert.deepEqual(m.doc.reasons, [want]);
    assert.equal(asked, answer ? 1 : 0);
    assert.equal(cardOf(w).state, 'verified');
    assert.equal(gatePuts(w), 0, 'the gate never merged it');
  });
}

for (const status of [405, 409, 422]) {
  test(`L94: GitHub's explicit no (${status}) refuses at once, the card put back with the reason counted`, async () => {
    const w = world(limited());
    verifiedCard(w);
    w.g.answer.merge = () => ({ status, json: { message: 'no' } });
    await gatePass(w.ctx);
    const m = mergeOf(w);
    assert.equal(m.doc.state, 'refused');
    assert.deepEqual(m.doc.reasons, [`GitHub refused the merge (${status}: no)`]);
    assert.equal(cardOf(w).state, 'verified');
    assert.deepEqual(cardOf(w).attempts?.merge_refusals, [`GitHub refused the merge (${status}: no)`]);
    assert.deepEqual(w.alerts.map((a) => a.type), ['merge_refused']);
  });
}

for (const [name, answer] of [['a 5xx', () => ({ status: 502, json: { message: 'bad gateway' } })], ['a 200 that does not say merged', () => ({ status: 200, json: { merged: false } })]]) {
  test(`L94: ${name} from the merge call is not a refusal: the merge stays merging`, async () => {
    const w = world(limited());
    verifiedCard(w);
    w.g.answer.merge = answer;
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'merging');
    assert.equal(cardOf(w).state, 'merging');
    assert.deepEqual(w.alerts.map((a) => a.type), ['merge_gate_unsure']);
  });
}

for (const merged of [true, false]) {
  test(`L94: the gate restarts in the middle of a merge (GitHub ${merged ? 'merged' : 'did not merge'}): the same outcome as a lost answer`, async () => {
    const w = world(limited());
    verifiedCard(w);
    const realPut = w.g.gh.put;
    // The first process stops inside the merge call: its pass never returns.
    w.g.gh.put = async (p, b) => {
      if (!p.endsWith('/merge')) return realPut(p, b);
      if (merged) await realPut(p, b); else w.g.writes.push(['put', p, b]);
      return new Promise(() => {});
    };
    gatePass(w.ctx);
    for (let i = 0; i < 200 && gatePuts(w) === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(gatePuts(w), 1);
    assert.equal(mergeOf(w).doc.state, 'merging');
    // A new process, the same Record.
    w.g.gh.put = realPut;
    tick(w, 1);
    await gatePass({ ...w.ctx });
    if (merged) {
      assert.equal(mergeOf(w).doc.state, 'merged');
      assert.equal(cardOf(w).state, 'merged');
    } else {
      assert.equal(mergeOf(w).doc.state, 'merging');
      tick(w, LIMIT_MIN);
      await gatePass({ ...w.ctx });
      assert.deepEqual(mergeOf(w).doc.reasons, ['interrupted']);
      assert.equal(cardOf(w).state, 'verified');
    }
    assert.equal(gatePuts(w), 1, 'never a second merge call');
  });
}

// The first merge refused as interrupted, and the Dispatcher's next request for the card (it was put back).
async function interruptedThenAskedAgain(w, head) {
  const realPut = loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  const first = mergeOf(w);
  assert.deepEqual(first.doc.reasons, ['interrupted']);
  w.g.gh.put = realPut;
  must(recOf(w).write({ actor: 'dispatcher', entity: 'merge_request', id: 'mr-C-1-again', expectRev: 0, doc: { card: 'C-1', pr: 7, session_id: 'S-1', head, rev: recOf(w).read('card', 'C-1').rev, requested_at: nowIso(w) } }), 'again');
  return { first, realPut };
}
function sensorsReads(w, doc) {
  const cur = recOf(w).read('fact', 'pr-7');
  must(recOf(w).write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: cur?.rev ?? 0, doc }), 'pr reading');
}

test('L102: after an interrupted refusal, a later GitHub merge of that PR is reconciled exactly once, and no second merge call goes out while the reading is older than the refusal', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  const { first, realPut } = await interruptedThenAskedAgain(w, head);
  // A reading from before the refusal does not count.
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, -60) });
  tick(w, 1);
  let r = await gatePass(w.ctx);
  const again = recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  assert.equal(again.doc.state, 'queued');
  assert.ok(r.did.some((d) => d.merge === again.id && d.step === 'waiting'), JSON.stringify(r.did));
  assert.equal(gatePuts(w), 1, 'no second merge call while the reading is older than the refusal');
  // GitHub finishes the first merge late; Sensors reads it.
  await realPut('/repos/sample-org/sample-app/pulls/7/merge', { sha: head, merge_method: 'squash' });
  const sha = w.g.pulls.get(7).merge_commit_sha;
  tick(w, 1);
  sensorsReads(w, { state: 'closed', merged: true, merge_commit_sha: sha, head_sha: head, observed_at: nowIso(w) });
  r = await gatePass(w.ctx);
  assert.ok(r.did.some((d) => d.merge === again.id && d.step === 'waiting'), 'a reading that shows merged is the reconcile\'s, never a second merge');
  const limits = fakeRules({ values: { 'timeouts.checking_max_min': 10, 'timeouts.reporting_max_min': 10, 'timeouts.in_review_no_reviewer_min': 10, 'timeouts.merging_open_max_min': LIMIT_MIN } });
  const said = [];
  const run = () => timeLimits({ rec: recOf(w), rules: limits, now: w.env.clock.t, b: {}, gateAlive: () => true, alert: (t) => said.push(t) });
  const d1 = await run();
  assert.ok(d1.some(([id, what]) => id === first.id && what === 'interrupted, then merged: reconciled'), JSON.stringify(d1));
  const m1 = recOf(w).read('merge', first.id).doc;
  assert.equal(m1.state, 'merged');
  assert.equal(m1.merge_commit, sha);
  assert.ok(m1.reconciled_at, 'a reconciled merge says so (c-2)');
  assert.equal(cardOf(w).state, 'merged');
  tick(w, 1);
  const d2 = await run();
  assert.ok(!d2.some(([id]) => id === first.id), 'reconciled once');
  await gatePass(w.ctx);
  assert.equal(recOf(w).read('merge', again.id).doc.state, 'refused');
  assert.match(recOf(w).read('merge', again.id).doc.reasons[0], /already merged/);
  assert.equal(gatePuts(w), 2, 'the gate sent one merge call; the other is GitHub finishing on its own');
  assert.deepEqual(said, []);
});

test('L102: an interrupted refusal, then a reading after it that shows the PR open: the gate merges it again', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  tick(w, 1);
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w) });
  await gatePass(w.ctx);
  const again = recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  assert.equal(again.doc.state, 'merged');
  assert.equal(cardOf(w).state, 'merged');
});

test('behind main: catch up with the expected head; a conflict returns it to the builder', async () => {
  const w = world();
  verifiedCard(w);
  w.g.main = w.g.commit([w.g.main], { 'docs/other.md': 'x' }, { from: w.g.main });
  await gatePass(w.ctx);
  let m = mergeOf(w);
  assert.equal(m.doc.state, 'catching_up');
  const up = w.g.writes.find(([, p]) => p.endsWith('/update-branch'));
  assert.equal(up[2].expected_head_sha, m.doc.catch_up_from);
  // Caught up, it is served in the same pass, before a younger change can put it behind again. The caught-up head
  // carries the review over (M10 carry-over: only main's changes came in), and merges.
  const r2 = await gatePass(w.ctx);
  m = mergeOf(w);
  assert.equal(m.doc.catch_ups.length, 1);
  assert.equal(m.doc.catch_ups[0].before_sha, w.env.record.read('card', 'C-1').doc.head);
  assert.equal(m.doc.state, 'merged', JSON.stringify({ did: r2.did, reasons: m.doc.reasons, alerts: w.alerts }));
  assert.equal(m.doc.judged_head, m.doc.catch_ups[0].after_sha);
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'merged');

  const w2 = world();
  verifiedCard(w2);
  w2.g.main = w2.g.commit([w2.g.main], { 'src/a.mjs': 'conflict' }, { from: w2.g.main });
  w2.g.answer.update = () => ({ status: 422, json: { message: 'merge conflict' } });
  await gatePass(w2.ctx);
  assert.equal(mergeOf(w2).doc.state, 'returned_to_builder');
});

test('rules not adopted at main: held, then queued again in its place once they are', async () => {
  const w = world({ values: { 'rules.adopted': { blob: 'f'.repeat(40) } } });
  verifiedCard(w);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'held');
  assert.equal(mergeOf(w).doc.hold, 'rules_not_adopted');
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'verified');
  const since = mergeOf(w).doc.queue_since;
  w.ctx.rules = fakeRules({ values: { ...w.values, 'rules.adopted': { blob: blobSha(Buffer.from(POLICY)) } }, answers: { merge: allow('in lane') } });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
  assert.equal(mergeOf(w).doc.queue_since, since);
});

test('queue order: undo, the daily card on a freshness alarm, Tier 1, Tier 2; then who waited longest', () => {
  const cards = { U: { kind: 'exact_reverse' }, D: { kind: 'lead_daily_card', tier: 2 }, T1: { tier: 1 }, T2a: { tier: 2 }, T2b: { tier: 2 } };
  const m = (card, since) => ({ id: `m-${card}`, doc: { card, queue_since: since } });
  const q = [m('T2b', '2026-10-01T02:00:00Z'), m('T2a', '2026-10-01T01:00:00Z'), m('T1', '2026-10-01T03:00:00Z'), m('D', '2026-10-01T04:00:00Z'), m('U', '2026-10-01T05:00:00Z')];
  assert.deepEqual(queueOrder(q, { cardOf: (id) => cards[id], freshnessAlarm: true }).map((x) => x.doc.card), ['U', 'D', 'T1', 'T2a', 'T2b']);
  assert.deepEqual(queueOrder(q, { cardOf: (id) => cards[id] }).map((x) => x.doc.card), ['U', 'T1', 'T2a', 'T2b', 'D']);
});

test('the gate never writes a git ref: it merges only through the pull request merge call', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(text, /\/git\/refs|update-ref|git push|\.patch\(/, `${f} writes a ref`);
  }
});

// R-0b-98, the Merge Gate's half (the push script's half is lane 2's, R-0b-45): proposals handed in as if from the
// owner's own tabs get every refusal a worker's change would. Each planted change is reviewed, verified and asked to
// merge exactly like a worker's, then judged by M10's real engine on the sample policy, at both cutovers.
const PLANTED = {
  'touches a workflow file': { files: { '.github/workflows/ci.yml': 'on: push' } },
  'adds a link': { files: { 'docs/guide.md': { text: '../../.ssh/config', mode: '120000' } } },
  'a risky act with no Approve': { files: { 'db/migrations/001.sql': 'drop table users;' } },
  'a Tier-1 change with no go on its plan': { files: { 'orchestrate/tool.mjs': 'export const x = 1;' } },
};
for (const deep of [false, true]) {
  for (const [name, plant] of Object.entries(PLANTED)) {
    test(`planted proposal (${deep ? 'second' : 'first'} cutover), ${name}: refused, never merged`, async () => {
      const w = world({ values: { 'product.cutover_stage': deep ? 'second' : 'first' } });
      realRules(w, { deep });
      verifiedCard(w, 'C-1', { files: plant.files });
      const mainBefore = w.g.main;
      await gatePass(w.ctx);
      const m = mergeOf(w);
      assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
      assert.equal(w.g.main, mainBefore);
      assert.ok(!w.g.writes.some(([verb, path]) => verb === 'put' && path.endsWith('/merge')), 'no merge call');
      const ns = new Set(m.doc.reasons.map((x) => Number.parseInt(x, 10)));
      if (!deep) assert.ok(ns.has(9), `first cutover: out of the docs lane (${m.doc.reasons.join(' | ')})`);
      else if (name.includes('Tier-1')) assert.ok(ns.has(10), `the go is for a Tier-2 plan (${m.doc.reasons.join(' | ')})`);
      else assert.ok(ns.has(8) || ns.has(9), `needs the owner (${m.doc.reasons.join(' | ')})`);
    });
  }
}

// Audit round 1, M1: a change held at the front steps aside; the Tier-2 change behind it merges in the same pass.
test('a change held for the Tier-1 hours steps aside and the change behind it merges', async () => {
  const w = world({ mergeAnswer: (s) => (s.card?.id === 'C-1' ? deny('held_tier1_hours') : allow('in lane')) });
  verifiedCard(w);
  w.env.clock.t += 60_000;
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merged');
  assert.equal(mergeOf(w, 'C-1').doc.state, 'held');
});

// Audit round 1, M3: a mark that didn't post is posted on a later pass, and the merge is then marked.
test('a failed mark is retried on the next pass until both statuses are on the merge commit', async () => {
  const w = world();
  verifiedCard(w);
  w.g.answer.status = () => ({ status: 500, json: null });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged');
  assert.equal(m.doc.marked_at, undefined);
  assert.ok(w.alerts.some((a) => a.type === 'merge_mark_failed'));
  w.g.answer.status = null;
  const r = await gatePass(w.ctx);
  assert.ok(r.did.some((d) => d.step === 'marked'));
  assert.equal((await readMark({ gh: w.g.gh, owner: 'sample-org', repo: 'sample-app', sha: m.doc.merge_commit, robotBotId: w.g.robotId })).ok, true);
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'merged');
});

// Audit round 1, M2: a Tier-1 merge that landed after the main the review read voids the audit's carry-over, even
// when the merge request came after that merge.
test('a Tier-1 merge after the reviewed main stops the audit carrying over, whenever the request was made', async () => {
  for (const tier of [2, 1]) {
    const w = world();
    verifiedCard(w);
    // C-2 is built and reviewed on the first main, but not yet asked to merge.
    const head2 = verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' }, request: false });
    await gatePass(w.ctx);
    const m1 = mergeOf(w);
    assert.equal(m1.doc.state, 'merged');
    if (tier === 1) must(w.env.record.write({ actor: 'merge_gate', entity: 'merge', id: m1.id, expectRev: m1.rev, doc: { ...m1.doc, tier: 1 } }), 'tier');
    w.env.clock.t += 60_000;
    requestMerge(w, 'C-2', 8, head2);
    await gatePass(w.ctx);   // behind main: catch-up asked
    await gatePass(w.ctx);   // caught up: queued, then judged
    const m2 = mergeOf(w, 'C-2');
    const f = await gatherFacts(w.ctx, { ...m2, doc: { ...m2.doc } });
    assert.equal(f.carried?.review, true, JSON.stringify({ m2: m2.doc, carried: f.carried }));
    assert.equal(f.carried.audit, tier === 2, `tier ${tier}: ${JSON.stringify(f.carried)}`);
  }
});

// Audit round 2, Material: a card id the mark can't name is refused before merging, and the gate keeps serving.
test('a card id too long for the mark is refused before merging; the change behind it merges', async () => {
  const w = world();
  const long = 'C-' + 'x'.repeat(86);
  verifiedCard(w, long);
  w.env.clock.t += 60_000;
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w, long).doc.state, 'refused');
  assert.ok(!w.g.writes.some(([verb, path]) => verb === 'put' && path.endsWith('/pulls/7/merge')), 'never merged');
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merged');
});

// Audit round 2, minor: a mark still missing when the audit result lands is posted anyway, and the owner is told.
test('a mark that failed until the audit result landed is still posted, with an alert to re-run the audit', async () => {
  const w = world();
  verifiedCard(w);
  w.g.answer.status = () => ({ status: 500, json: null });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
  w.g.answer.status = null;
  await gatePass(w.ctx);
  const after = mergeOf(w);
  assert.equal(after.doc.state, 'audit_flagged');
  assert.ok(after.doc.marked_at);
  assert.ok(w.alerts.some((a) => a.type === 'merge_marked_after_audit'));
});

// #91 r2 audit (L129, plant D15): the late-mark check reads Sensors audit runs only. An audit_run another writer made
// for the commit is not an audit, so a mark posted late on a still-merged merge asks for no re-run.
test('L129: a Ledger audit_run for the commit does not make a late mark ask for a re-run', async () => {
  const w = world();
  verifiedCard(w);
  w.g.answer.status = () => ({ status: 500, json: null });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  must(w.env.record.write({ actor: 'ledger', entity: 'fact', id: 'alert-audit-0', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'ledger fact');
  w.g.answer.status = null;
  await gatePass(w.ctx);
  const after = mergeOf(w);
  assert.equal(after.doc.state, 'merged');
  assert.ok(after.doc.marked_at);
  assert.equal(after.doc.late_mark_alert, undefined);
  assert.ok(!w.alerts.some((a) => a.type === 'merge_marked_after_audit'), JSON.stringify(w.alerts));
});

// L130 m17: the late-mark alert's answer counts. A refused (false) or thrown alert leaves it owed and it is sent again
// on the next pass; once taken it is marked told and never sent again.
test('L130 m17: a late-mark alert that is refused or throws is sent again next pass, then never again', async () => {
  for (const fail of ['false', 'throw']) {
    const w = world();
    let refuse = true;
    const sent = [];
    w.ctx.alert = (a) => {
      if (a.type === 'merge_marked_after_audit' && refuse) { if (fail === 'throw') throw new Error('queue busy'); return false; }
      sent.push(a);
      return true;
    };
    verifiedCard(w);
    w.g.answer.status = () => ({ status: 500, json: null });
    await gatePass(w.ctx);
    const m = mergeOf(w);
    must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
    w.g.answer.status = null;
    await gatePass(w.ctx);
    let after = mergeOf(w);
    assert.ok(after.doc.marked_at, fail);
    assert.equal(after.doc.late_mark_alert, 'owed', fail);
    assert.ok(!sent.some((a) => a.type === 'merge_marked_after_audit'), fail);
    refuse = false;
    await gatePass(w.ctx);
    after = mergeOf(w);
    assert.equal(after.doc.late_mark_alert, 'told', fail);
    assert.equal(sent.filter((a) => a.type === 'merge_marked_after_audit').length, 1, fail);
    await gatePass(w.ctx);
    assert.equal(sent.filter((a) => a.type === 'merge_marked_after_audit').length, 1, `${fail}: sent once only`);
  }
});

// Audit round 3, Material: on M10's real engine a clean docs change with a Tier-2 go merges as Tier 2 (the card's
// declared tier reaches the classification), and the needs-joe status says so.
test('real rules: a clean docs change with a Tier-2 go merges, recorded and marked as Tier 2', async () => {
  const w = world();
  realRules(w, { deep: false });
  verifiedCard(w, 'C-1', { files: { 'docs/guide.md': 'more words' } });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged', JSON.stringify(m.doc));
  assert.equal(m.doc.tier, 2);
  const nj = await readNeedsJoe({ gh: w.g.gh, owner: 'sample-org', repo: 'sample-app', sha: m.doc.merge_commit, robotBotId: w.g.robotId });
  assert.equal(nj.tier, 2);
});

// Audit round 4, Material: the rules file gives an ignored check's app id as text ("777"); the gate still ignores it,
// on the change's head and on main.
test('an ignored check named in the rules with a text app id is ignored, on the head and on main', async () => {
  const w = world({ values: { 'product_profile.checks_ignored': [{ app_id: '777', name: 'preview' }] } });
  const head = verifiedCard(w);
  const red = (sha) => [
    { name: 'test', app: { id: 1 }, head_sha: sha, status: 'completed', conclusion: 'success' },
    { name: 'preview', app: { id: 777 }, head_sha: sha, status: 'completed', conclusion: 'failure' },
  ];
  w.g.checks.set(head, red(head));
  w.g.checks.set(w.g.main, red(w.g.main));
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged', JSON.stringify(m.doc.reasons));
});

// ---- Lead call L65: the gate counts only the review runner's own launch records ----

test('L65 planted: a verdict whose only launch is the Dispatcher\'s Record copy is refused (5) and never merged', async () => {
  const w = world();
  const head = verifiedCard(w);
  // The runner's record is gone; the Dispatcher's copy in the Record says the same thing, and must not count.
  unlinkSync(join(w.env.launchRoot, 'R-C-1.json'));
  must(w.env.record.write({ actor: 'dispatcher', entity: 'launch', id: 'R-C-1', expectRev: 0, doc: { session_id: 'R-C-1', role: 'reviewer', card: 'C-1', head, rev: 1, launched_at: new Date(w.env.clock.t).toISOString() } }), 'the Record copy');
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.notEqual(m.doc.state, 'merged');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /no reviewer session handed in a pass/.test(x)), m.doc.reasons.join(' | '));
  assert.equal(w.g.writes.filter(([k]) => k === 'put').length, 0);
  // The gathered facts hold no session from the Record.
  const f = await gatherFacts(w.ctx, m);
  assert.deepEqual(f.reviews, []);
  void launch;
});

test('L66 M1 planted: a verdict row that says pass while its outbox file says fail is refused (5)', async () => {
  const w = world();
  verifiedCard(w);
  // As if the reviewer had said fail and the Record row (which the workers' Mac user can write) were edited to pass: the
  // file now says fail, and the row names that file, so only the file's own word differs.
  const v = w.env.record.list('verdict')[0];
  const file = v.doc.source_key.slice(0, v.doc.source_key.lastIndexOf('\0'));
  writeFileSync(file, readFileSync(file, 'utf8').replace('"pass":true', '"pass":false'));
  const key = `${file}\0${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  w.env.store.transaction((tx) => tx.commit([{ entity: 'verdict', id: v.id, doc: { ...v.doc, source_key: key } }], { actor: v.doc.role + ':' + v.doc.session_id, kind: 'verdict' }));
  assert.equal(w.env.record.read('verdict', v.id).doc.pass, true, 'the row says pass');
  await gatePass(w.ctx);
  let m = mergeOf(w);
  assert.notEqual(m.doc.state, 'merged');
  // Changed after the end, the file can't be counted at all (L69 point 2).
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /R-C-1's verdict can't be counted, so it counts as a failure: its verdict file changed after the session ended/.test(x)), m.doc.reasons.join(' | '));
  // As if it had said fail by the end (the ended record names the failing file): the file's fail decides, whatever the
  // row says.
  const w1 = world();
  verifiedCard(w1);
  const v1 = w1.env.record.list('verdict')[0];
  const file1 = v1.doc.source_key.slice(0, v1.doc.source_key.lastIndexOf('\0'));
  writeFileSync(file1, readFileSync(file1, 'utf8').replace('"pass":true', '"pass":false'));
  unlinkSync(join(w1.env.base, 'ended', 'R-C-1.json'));
  runnerEndedRecord(w1.env, 'C-1', 'R-C-1', 'reviewer', w1.env.record.read('card', 'C-1').doc.head);
  w1.env.store.transaction((tx) => tx.commit([{ entity: 'verdict', id: v1.id, doc: { ...v1.doc, source_key: `${file1}\0${createHash('sha256').update(readFileSync(file1)).digest('hex')}` } }], { actor: `reviewer:${v1.doc.session_id}`, kind: 'verdict' }));
  await gatePass(w1.ctx);
  m = mergeOf(w1);
  assert.notEqual(m.doc.state, 'merged');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /the reviewer session R-C-1 did not pass/.test(x)), m.doc.reasons.join(' | '));
  // The file gone: refused, and refusal 5 says the file the session ended with is gone (the row is never read, L68).
  const w2 = world();
  verifiedCard(w2);
  const v2 = w2.env.record.list('verdict')[0];
  unlinkSync(v2.doc.source_key.slice(0, v2.doc.source_key.lastIndexOf('\0')));
  await gatePass(w2.ctx);
  const m2 = mergeOf(w2);
  assert.notEqual(m2.doc.state, 'merged');
  assert.ok(m2.doc.reasons.some((x) => x.startsWith('5:') && /R-C-1's verdict can't be counted, so it counts as a failure: its verdict file is gone since the session ended/.test(x)), m2.doc.reasons.join(' | '));
});

// Not known yet (L164): held as waiting, with the reason in waiting_on, and no merge call.
function waits5(w, re) {
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'held', JSON.stringify(m.doc));
  assert.equal(m.doc.hold, 'waiting');
  assert.ok((m.doc.waiting_on ?? []).some((x) => x.startsWith('5:') && re.test(x)), (m.doc.waiting_on ?? []).join(' | '));
  assert.equal(w.g.writes.filter(([k]) => k === 'put').length, 0);
}

// The review records could not be read: not known yet, so held and judged again each pass (L164), never merged.
test('L65: with no review launches folder set, the gate holds (5) and says why, never reading the Record', async () => {
  const w = world();
  verifiedCard(w);
  delete w.ctx.reviewLaunches;
  await gatePass(w.ctx);
  waits5(w, /records could not be read: the gate has no review launches folder set/);
  // A folder that fails M9's check holds the same way.
  const w2 = world();
  verifiedCard(w2);
  w2.ctx.reviewLaunches = { root: w2.env.launchRoot, uids: { ...w2.env.reviewUids, worker: w2.env.reviewUids.reviewer } };
  await gatePass(w2.ctx);
  waits5(w2, /shared with worker/);
});

// ---- Lead call L68: the worst verdict, read from review's own stores ----

// A second reviewer the runner launched on the same head, with its own verdict file (or none), marked ended by the
// runner unless `ended: false`.
function secondReviewer(w, head, sid, { pass, checklist = CLEAN, ended = true } = {}) {
  runnerLaunch(w.env, 'C-1', sid, 'reviewer', head);
  const f = pass === undefined ? null
    : outboxFile(w.env, 'reviewer', sid, `verdict-${sid}.md`, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head, pass, checklist } })}\n`);
  if (ended) runnerEndedRecord(w.env, 'C-1', sid, 'reviewer', head);
  return f;
}
const refusal5 = (w, re) => { const m = mergeOf(w); assert.notEqual(m.doc.state, 'merged'); assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && re.test(x)), m.doc.reasons.join(' | ')); };

test('L68 planted: try 1 fails and try 2 passes on one head → refused (5), never merged', async () => {
  const w = world();
  const head = verifiedCard(w);
  // Try 1 said fail (its file is in review's outbox, and it ended); try 2 (R-C-1, taken by the Record) passed.
  secondReviewer(w, head, 'R-try1', { pass: false });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.notEqual(m.doc.state, 'merged');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /the reviewer session R-try1 did not pass/.test(x)), m.doc.reasons.join(' | '));
  assert.equal(w.g.writes.filter(([k]) => k === 'put').length, 0);
});

test('L68 planted: a failing verdict whose Record row is gone (or never taken) still refuses (5)', async () => {
  const w = world();
  const head = verifiedCard(w);
  secondReviewer(w, head, 'R-gone', { pass: false });
  assert.ok(!w.env.record.list('verdict').some((v) => v.doc.session_id === 'R-gone'), 'the Record holds no row for the failing verdict');
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.notEqual(m.doc.state, 'merged');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /R-gone did not pass/.test(x)), m.doc.reasons.join(' | '));
});

// L69 point 1 reverses L68 point 2: a session that ran and ended with no file is a failure. Only Joe's "review again"
// sets it aside, and then it has no say.
test('L69 planted: a reviewer not ended blocks (held, L164); one that ended with no verdict is refused (5); Joe\'s set-aside has no say', async () => {
  const w = world();
  const head = verifiedCard(w);
  secondReviewer(w, head, 'R-quiet', { ended: false });
  await gatePass(w.ctx);
  waits5(w, /R-quiet has not ended yet/);
  // A passing file from a session not yet ended blocks the same way.
  const w1 = world();
  const head1 = verifiedCard(w1);
  secondReviewer(w1, head1, 'R-early', { pass: true, ended: false });
  await gatePass(w1.ctx);
  waits5(w1, /R-early has not ended yet/);
  // Ended with no file: a failure, beside the pass.
  const w2 = world();
  const head2 = verifiedCard(w2);
  secondReviewer(w2, head2, 'R-quiet');
  await gatePass(w2.ctx);
  refusal5(w2, /the reviewer session R-quiet ended without handing in a verdict, which counts as a failure/);
  // Joe taps "review again": that session is set aside, and the pass alone decides.
  const w3 = world();
  const head3 = verifiedCard(w3);
  secondReviewer(w3, head3, 'R-quiet');
  runnerAsideRecord(w3.env, 'C-1', 'R-quiet', 'reviewer', head3);
  await gatePass(w3.ctx);
  assert.equal(mergeOf(w3).doc.state, 'merged', JSON.stringify(mergeOf(w3).doc.reasons));
});

// L69 point 7: the gate-level cases P2, P3, P9 and P10.
test('L69 P2 planted: an ended record that fails its checks refuses (5)', async () => {
  const w = world();
  const head = verifiedCard(w);
  secondReviewer(w, head, 'R-bad', { pass: true, ended: false });
  writeFileSync(join(w.env.base, 'ended', 'R-bad.json'), '{', { mode: 0o644 });
  await gatePass(w.ctx);
  refusal5(w, /R-bad's verdict can't be counted, so it counts as a failure: the ended record of session R-bad: the launch record is not JSON/);
});

test('L69 P3 planted: an ended record for another head refuses (5)', async () => {
  const w = world();
  const head = verifiedCard(w);
  secondReviewer(w, head, 'R-other', { pass: true, ended: false });
  runnerEndedRecord(w.env, 'C-1', 'R-other', 'reviewer', 'e'.repeat(40));
  await gatePass(w.ctx);
  refusal5(w, /R-other's verdict can't be counted, so it counts as a failure: the ended record of session R-other is for another role, card or head/);
});

test('L69 P9 planted: a review outbox that exists but can\'t be listed refuses (5)', async () => {
  const w = world();
  verifiedCard(w);
  const dir = join(w.env.outRoot, 'reviewer', 'R-C-1');
  chmodSync(dir, 0o000);
  try {
    await gatePass(w.ctx);
  } finally { chmodSync(dir, 0o755); }
  // The listing failure itself is the reason, not the pinned sha catching a file that seems gone (L69 P9).
  refusal5(w, /R-C-1's verdict can't be counted, so it counts as a failure: its outbox folder could not be listed/);
  assert.equal(w.g.writes.filter(([k]) => k === 'put').length, 0);
});

test('L69 P10 planted: one bad launch record refuses only its own card; one tied to no card is skipped and logged', async () => {
  const w = world();
  verifiedCard(w);
  // Another card's record fails its checks: this card still merges.
  writeFileSync(join(w.env.launchRoot, 'R-x.json'), JSON.stringify({ session_id: 'R-x', card: 'C-2', head: 'e'.repeat(40) }), { mode: 0o644 });
  // One that names no card and is no session of this card: skipped, and said in the notes.
  writeFileSync(join(w.env.launchRoot, 'R-y.json'), '{', { mode: 0o644 });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged', JSON.stringify(mergeOf(w).doc.reasons));
  const f = await gatherFacts(w.ctx, mergeOf(w));
  assert.deepEqual(f.reviewsSkipped, ['R-y.json: the launch record is not JSON']);
  // This card's own bad record holds it: its reviews can't be read, so it is not known yet (L164), and never merged.
  const w2 = world();
  verifiedCard(w2);
  writeFileSync(join(w2.env.launchRoot, 'R-z.json'), JSON.stringify({ session_id: 'R-z', card: 'C-1', head: 'e'.repeat(40) }), { mode: 0o644 });
  await gatePass(w2.ctx);
  waits5(w2, /the launch record R-z\.json of card C-1 fails its checks, so no review of this card can be counted \(the launch record names no review role\)/);
});

// L69 point 5: the pull request's head has its own say, even when the review carries over to it.
test('L69 planted: a failing reviewer at the caught-up head refuses (5), even with a passing carry-over', async () => {
  const w = world();
  verifiedCard(w);
  w.g.main = w.g.commit([w.g.main], { 'docs/other.md': 'x' }, { from: w.g.main });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up');
  const after = w.g.pulls.get(7).head;
  secondReviewer(w, after, 'R-after', { pass: false });
  await gatePass(w.ctx);
  refusal5(w, /the reviewer session R-after did not pass at the pull request's head/);
  assert.equal(w.g.writes.filter(([k, path]) => k === 'put' && path.endsWith('/merge')).length, 0, 'never merged');
});

// L69 point 4 at the gate: the head's tree comes from git (the gate's view), so a fail at an earlier head with the same
// tree refuses, even though this head's own launch record names no tree.
test('L69 planted: the gate reads the head\'s tree; a fail at another head with the same tree refuses (5)', async () => {
  const w = world();
  const head = verifiedCard(w);
  const tree = (await w.ctx.view.commit(head)).tree;
  const A = 'f'.repeat(40);
  runnerLaunch(w.env, 'C-1', 'R-old', 'reviewer', A, { tree });
  outboxFile(w.env, 'reviewer', 'R-old', 'verdict-R-old.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: A, pass: false, checklist: CLEAN } })}\n`);
  runnerEndedRecord(w.env, 'C-1', 'R-old', 'reviewer', A, { tree });
  await gatePass(w.ctx);
  refusal5(w, /the reviewer session R-old did not pass/);
  assert.equal(w.g.writes.filter(([k, p]) => k === 'put' && /\/merge$/.test(p)).length, 0);
  // The control: the same fail on another tree has no say here.
  const w2 = world();
  const h2 = verifiedCard(w2);
  runnerLaunch(w2.env, 'C-1', 'R-old', 'reviewer', A, { tree: 'd'.repeat(40) });
  outboxFile(w2.env, 'reviewer', 'R-old', 'verdict-R-old.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: A, pass: false, checklist: CLEAN } })}\n`);
  runnerEndedRecord(w2.env, 'C-1', 'R-old', 'reviewer', A, { tree: 'd'.repeat(40) });
  assert.notEqual((await w2.ctx.view.commit(h2)).tree, 'd'.repeat(40));
  await gatePass(w2.ctx);
  assert.equal(mergeOf(w2).doc.state, 'merged', mergeOf(w2).doc.reasons?.join(' | '));
});

// L70 point 1, the round-2 attack at the gate: a worker gives review's failing verdict file a second name. That can't
// change review's bytes, so the fail is read and counts (refusal 5 "did not pass"), never "can't be counted".
test('L70 planted: a failing verdict file with a second name still refuses the merge as a fail (5)', async () => {
  const w = world();
  verifiedCard(w);
  const v = w.env.record.list('verdict')[0];
  const file = v.doc.source_key.slice(0, v.doc.source_key.lastIndexOf('\0'));
  writeFileSync(file, readFileSync(file, 'utf8').replace('"pass":true', '"pass":false'));
  unlinkSync(join(w.env.base, 'ended', 'R-C-1.json'));
  runnerEndedRecord(w.env, 'C-1', 'R-C-1', 'reviewer', w.env.record.read('card', 'C-1').doc.head);
  linkSync(file, join(w.env.base, 'worker-made-name'));
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.notEqual(m.doc.state, 'merged');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /the reviewer session R-C-1 did not pass/.test(x)), m.doc.reasons.join(' | '));
  assert.ok(!m.doc.reasons.some((x) => /can't be counted|more than one name/.test(x)), m.doc.reasons.join(' | '));
});

// L138 MAT-2: every way the gate puts a card back ends its merge, so the Dispatcher's next pass asks for the merge again
// (M11 requestMerges, its real id rule, over this real Record); a merge ended while the card did not change is not
// asked for on every pass.
const M11_RULES = fakeRules({ values: { 'usage.red_runs': [] } });
const GREEN_BAND = { band: 'green', own_building: 'open', prodBlocked: false };
function dispatcherAsks(w, id = 'C-1', { pr = 7, head } = {}) {
  const { env } = w;
  if (!env.record.read('launch', 'launch-S-1')) launch(env, id, 'S-1', 'worker');
  const f = env.record.read('fact', `pr-${pr}`);
  const reading = { type: 'pr', head_sha: head, state: 'open', merged: false, observed_at: new Date(env.clock.t).toISOString() };
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: `pr-${pr}`, expectRev: f?.rev ?? 0, doc: reading }), 'pr reading');
  return requestMerges({ rec: env.record, rules: M11_RULES, now: env.clock.t, b: GREEN_BAND, alert: (t) => assert.fail(`unexpected alert: ${t}`) });
}
const mergesOf = (w, id = 'C-1') => w.env.record.list('merge').filter((m) => m.doc.card === id).sort((a, b) => (a.id < b.id ? -1 : 1));

test('L138 MAT-2: check() refuses at the lock and puts the card back; the next Dispatcher pass asks again, and that merge lands', async () => {
  const w = world();
  const head = verifiedCard(w, 'C-1', { request: false });
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested']]);
  // The check turns red between the queue's judgement and the one under the lock.
  const base = w.ctx.record;
  w.ctx.record = Object.create(base, { write: { value: (x) => {
    const r = base.write(x);
    if (r.ok && x.entity === 'merge' && x.doc?.state === 'checking') w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' }]);
    return r;
  } } });
  await gatePass(w.ctx);
  w.ctx.record = base;
  assert.deepEqual(mergesOf(w).map((m) => m.doc.state), ['refused']);
  assert.equal(cardOf(w).state, 'verified', 'put back by check()');
  assert.equal((cardOf(w).attempts?.merge_refusals ?? []).length, 0, 'not a refusal the repeat ask counts (L116 m7)');
  w.g.checks.delete(head);
  tick(w, 1);
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested again']]);
  assert.equal(w.env.record.list('merge_request').length, 2);
  await gatePass(w.ctx);
  assert.deepEqual(mergesOf(w).map((m) => m.doc.state), ['refused', 'merged']);
  assert.equal(cardOf(w).state, 'merged');
});

test('L138 MAT-2: recover() refuses a merge stopped in checking and puts the card back; the next Dispatcher pass asks again', async () => {
  const w = world(limited());
  const head = verifiedCard(w, 'C-1', { request: false });
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested']]);
  const base = w.ctx.record;
  w.ctx.record = Object.create(base, { read: { value: (e, id) => {
    if (e === 'card' && mergeOf(w)?.doc.state === 'checking') throw new Error('the gate process stopped');
    return base.read(e, id);
  } } });
  await gatePass(w.ctx).catch(() => {});
  w.ctx.record = base;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.deepEqual(mergesOf(w).map((m) => [m.doc.state, m.doc.reasons]), [['refused', ['GitHub did not merge the judged head']]]);
  assert.equal(cardOf(w).state, 'verified', 'put back by recover()');
  tick(w, 1);
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested again']]);
  await gatePass(w.ctx);
  assert.equal(cardOf(w).state, 'merged');
});

test('L138 MAT-2: refusal 8 sets needs_joe; once Joe approves the card at the same head, the next Dispatcher pass asks again', async () => {
  const w = world({ values: { 'product.cutover_stage': 'second' } });
  realRules(w, { deep: true });
  const head = verifiedCard(w, 'C-1', { files: PLANTED['a risky act with no Approve'].files, request: false });
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested']]);
  await gatePass(w.ctx);
  const first = mergesOf(w);
  assert.deepEqual(first.map((m) => m.doc.state), ['refused']);
  assert.ok(first[0].doc.reasons.some((x) => x.startsWith('8:')), first[0].doc.reasons.join(' | '));
  assert.equal(cardOf(w).needs_joe, true);
  // While it waits on his Approve the Record takes no request for it (M9), and says so each pass.
  tick(w, 1);
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge request not recorded: card C-1 is verified and needs the owner; no merge request yet']]);
  assert.equal(w.env.record.list('merge_request').length, 1);
  // Joe approves (the same head): asked again.
  must(put(w.env.review, 'approvals', 'card', 'C-1', { state: 'approved' }), 'approved');
  tick(w, 1);
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested again']]);
  assert.equal(w.env.record.list('merge_request').length, 2);
});

// The refusal here is about the change (a red check), so not asking again is right. What is only not known yet (checks
// or threads unreadable, mergeable unknown, main red) is held instead and judged again each pass (L164, the tests at
// the end of this file).
test('L138 MAT-2: a merge the gate refused while the card did not change is not asked for again on every pass', async () => {
  const w = world();
  const head = verifiedCard(w, 'C-1', { request: false });
  w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' }]);
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested']]);
  await gatePass(w.ctx);
  assert.deepEqual(mergesOf(w).map((m) => m.doc.state), ['refused']);
  assert.equal(cardOf(w).state, 'verified', 'refused in the queue: the card never left verified');
  for (let i = 0; i < 3; i++) {
    tick(w, 1);
    assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'not requested again: the gate ended its merge and the card has not changed since']]);
    await gatePass(w.ctx);
  }
  assert.equal(w.env.record.list('merge_request').length, 1);
  assert.equal(w.env.record.list('merge').length, 1, 'no refusal (and no alert) per pass');
  // The card changes (an edit at the same head): asked again.
  must(put(w.env.record, 'dispatcher', 'card', 'C-1', { attempts: { merge_asks: 0 } }), 'a change');
  tick(w, 1);
  assert.deepEqual(dispatcherAsks(w, 'C-1', { head }), [['C-1', 'merge requested again']]);
});

// ---- L164: what is only not known yet is held, never refused for good; the owner hears of a long wait once ----------
// L168, L170: a refusal the owner must hear of is told until its alert is taken (an answer of false, or a throw, is not).

// The owner's alert queue does not take the first `n` alerts of one type: it answers false, or throws. Every try is kept.
function flakyAlert(w, type, mode, n = 1) {
  const push = w.ctx.alert;
  const tries = [];
  // fakeAlert asks `throws` first on every call, so the tries are kept there; a lost one answers false or throws.
  const lose = (a) => a.type === type && n > 0 && (n -= 1, true);
  w.ctx.alert = fakeAlert({
    throws: (a) => { if (a.type === type) tries.push(a); return mode === 'throw' && lose(a) && 'queue gone'; },
    answer: (a) => (mode !== 'throw' && lose(a) ? false : push(a)),
  });
  return tries;
}
const told = (w, type) => w.alerts.filter((a) => a.type === type);
const waitingHeld = (m, re) => {
  assert.equal(m.doc.state, 'held', JSON.stringify(m.doc));
  assert.equal(m.doc.hold, 'waiting');
  assert.ok((m.doc.waiting_on ?? []).some((x) => re.test(x)), (m.doc.waiting_on ?? []).join(' | '));
};

test('L164 PROBE-D: GitHub down for a pass holds the merge (never refuses it) and stops the queue; GitHub back, it merges', async () => {
  const w = world(limited());
  verifiedCard(w);
  tick(w, 1);
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  w.g.down = true;
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  assert.equal(mergeOf(w, 'C-2').doc.state, 'queued', 'an outage stops the queue: the next merge is not judged against it');
  assert.equal(cardOf(w).state, 'verified');
  assert.equal(gatePuts(w), 0);
  assert.deepEqual(told(w, 'merge_refused'), []);
  w.g.down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged', 'judged again once GitHub answers');
  assert.equal(cardOf(w).state, 'merged');
  assert.deepEqual(told(w, 'merge_refused'), []);
  assert.deepEqual(told(w, 'merge_waiting_long'), []);
});

for (const mode of ['taken', 'false', 'throw']) {
  test(`L164: a merge GitHub can't yet call mergeable waits, judged again each pass; past the limit the owner is told once (alert ${mode})`, async () => {
    const w = world(limited());
    verifiedCard(w);
    w.g.pulls.get(7).mergeable_state = 'unknown';
    const tries = flakyAlert(w, 'merge_waiting_long', mode, mode === 'taken' ? 0 : 1);
    await gatePass(w.ctx);
    const since = mergeOf(w).doc.waiting_since;
    waitingHeld(mergeOf(w), /^3: .*mergeable/);
    assert.equal(since, nowIso(w));
    for (let i = 0; i < 3; i++) {
      tick(w, 4);
      await gatePass(w.ctx);
      waitingHeld(mergeOf(w), /^3: .*mergeable/);
      assert.equal(mergeOf(w).doc.waiting_since, since, 'the wait keeps the time it began');
    }
    assert.equal(tries.length, 0, 'under the limit: nothing told');
    tick(w, 4);
    await gatePass(w.ctx);
    assert.equal(tries.length, 1);
    assert.equal(!!mergeOf(w).doc.wait_told_at, mode === 'taken', 'wait_told_at only once the alert was taken');
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(tries.length, mode === 'taken' ? 1 : 2, 'a lost alert is sent again on the next pass');
    assert.ok(mergeOf(w).doc.wait_told_at);
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(told(w, 'merge_waiting_long').length, 1, 'told once');
    assert.match(told(w, 'merge_waiting_long')[0].note, /judged again on every pass/);
    assert.equal(gatePuts(w), 0);
    w.g.pulls.get(7).mergeable_state = 'clean';
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'merged');
  });
}

// L184: until the rules carry the limit, a wait reads the gate's default (told once that it does), told past it and
// refused past 3 times it.
test('L164 + L184: a waiting merge with no merging limit in the rules is told once that the default is in use, then timed by it', async () => {
  const w = world();
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  const D = DEFAULT_WAIT_LIMIT_MIN;
  // Passes at 0, D - 1, D and 3D - 1 minutes: held each time, told it waits from D on.
  for (const [step, longTold] of [[0, 0], [D - 1, 0], [1, 1], [WAIT_CAP_TIMES * D - 1 - D, 1]]) {
    tick(w, step);
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^3: /);
    assert.equal(told(w, 'merge_waiting_long').length, longTold);
  }
  assert.equal(told(w, 'merge_limit_missing').length, 1);
  assert.match(told(w, 'merge_limit_missing')[0].note, new RegExp(`waiting to be judged .*timeouts\\.merging_open_max_min.*default of ${D} min`));
  assert.equal(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(mergeOf(w).id))?.doc?.merge, mergeOf(w).id);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused', JSON.stringify(mergeOf(w).doc));
  assert.equal(mergeOf(w).doc.tell_note, waitCapNote(D * 60_000));
  assert.equal(told(w, 'merge_refused').length, 1);
  assert.equal(told(w, 'merge_limit_missing').length, 1, 'told once');
});

// L188 Minor: the two missing-limit notes are each told once per merge. A merge told while it waited is told again
// when its pull request is open after the merge call, and neither note twice.
test('L188: a merge told of the missing limit while waiting is told again when open after the merge call, each once', async () => {
  const w = world();
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  const id = mergeOf(w).id;
  assert.equal(told(w, 'merge_limit_missing').length, 1);
  assert.match(told(w, 'merge_limit_missing')[0].note, /waiting to be judged/);
  assert.deepEqual(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(id))?.doc?.told, ['waiting']);
  w.g.pulls.get(7).mergeable_state = 'clean';
  loseAnswer(w, { merged: false });
  for (let i = 0; i < 4; i++) { tick(w, 2); await gatePass(w.ctx); }
  const notes = told(w, 'merge_limit_missing').map((a) => a.note);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.match(notes[1], /still open after the merge call/);
  assert.deepEqual(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(id))?.doc?.told, ['waiting', 'open']);
});

test('L188 follow-up: rules that cannot answer the wait limit while a merge waits are told once a pass, and never refuse it or tell the long wait', async () => {
  const KEY = 'timeouts.merging_open_max_min';
  const w = world(limited());
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  const base = w.ctx.rules;
  const broken = (k) => { if (k === KEY) throw new Error('the rules engine stopped'); };
  w.ctx.rules = Object.create(base, {
    get: { value: (k, o) => { broken(k); return base.get(k, o); } },
    num: { value: (k, o) => { broken(k); return base.num(k, o); } },
  });
  for (let pass = 1; pass <= 3; pass++) {
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^3: /);
    assert.equal(told(w, 'merge_gate_unsure').filter((a) => /could not answer timeouts\.merging_open_max_min/.test(a.note)).length, pass, `one a pass: ${JSON.stringify(w.alerts)}`);
    tick(w, 1);
  }
  assert.deepEqual(told(w, 'merge_refused'), []);
  assert.deepEqual(told(w, 'merge_waiting_long'), []);
  assert.deepEqual(told(w, 'merge_limit_missing'), []);
  w.ctx.rules = base;
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'told of the long wait once the rules answer');
});

test('L188 control: a told fact from before the waiting note stands for the open note only', async () => {
  const w = world();
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  // Rewrite the fact the old way (no told list), as a merge told only the open note before L188 would have it.
  const fid = MERGE_LIMIT_TOLD_FACT(mergeOf(w).id);
  must(recOf(w).write({ actor: 'merge_gate', entity: 'fact', id: fid, expectRev: recOf(w).read('fact', fid).rev, doc: { type: 'merge_limit_told', merge: mergeOf(w).id } }), 'old form');
  tick(w, 2);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_limit_missing').length, 2, 'the waiting note is told: an old fact is the open note\'s');
  assert.deepEqual(recOf(w).read('fact', fid)?.doc?.told, ['open', 'waiting']);
  w.g.pulls.get(7).mergeable_state = 'clean';
  loseAnswer(w, { merged: false });
  for (let i = 0; i < 4; i++) { tick(w, 2); await gatePass(w.ctx); }
  assert.equal(told(w, 'merge_limit_missing').length, 2, 'the open note is not told again');
});

// L168 (1): the three refusal sites that tell the owner, each with a lost first alert.
const redCheck = (w, head) => w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' }]);
const LONG_ID = 'C-' + 'x'.repeat(86);
for (const [site, make, note] of [
  ['a red check', (w) => redCheck(w, verifiedCard(w)), FINAL_NOTE],
  ['a card id too long for the mark', (w) => verifiedCard(w, LONG_ID), FINAL_NOTE],
  ['GitHub refusing the merge (405)', (w) => { verifiedCard(w); w.g.answer.merge = () => ({ status: 405, json: { message: 'Base branch was modified' } }); }, GITHUB_NO_NOTE],
]) {
  for (const mode of ['false', 'throw']) {
    test(`L168: ${site}: a lost merge_refused alert (${mode}) is sent again until taken, then never again`, async () => {
      const w = world();
      const tries = flakyAlert(w, 'merge_refused', mode, 1);
      make(w);
      const only = () => { const ms = recOf(w).list('merge'); assert.equal(ms.length, 1); return ms[0]; };
      await gatePass(w.ctx);
      assert.equal(only().doc.state, 'refused');
      assert.equal(only().doc.tell_owner, true);
      assert.equal(only().doc.told_at, undefined, 'not told: no mark');
      assert.equal(tries.length, 1);
      tick(w, 1);
      await gatePass(w.ctx);
      assert.equal(tries.length, 2, 'sent again on the next pass');
      assert.ok(only().doc.told_at, 'told: marked');
      for (let i = 0; i < 2; i++) { tick(w, 1); await gatePass(w.ctx); }
      assert.equal(tries.length, 2, 'never again once told');
      assert.equal(told(w, 'merge_refused').length, 1);
      assert.equal(told(w, 'merge_refused')[0].note, note);
      assert.deepEqual(told(w, 'merge_refused')[0].reasons, only().doc.reasons);
    });
  }
}

// L188 m1: pass 3b re-tells a lost refusal even while another merge sits stuck in merging (3b runs before the busy return).
test('L188 m1: a lost merge_refused alert is told again next pass while another merge is stuck in merging', async () => {
  const w = world();
  const tries = flakyAlert(w, 'merge_refused', 'false', 1);
  redCheck(w, verifiedCard(w));
  tick(w, 1);
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  if (mergeOf(w, 'C-2').doc.state !== 'merging') { tick(w, 1); await gatePass(w.ctx); }
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.equal(mergeOf(w).doc.told_at, undefined, 'the alert was lost: not marked');
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merging', 'C-2 is stuck: no limit in the rules, its pull request open');
  const before = tries.length;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merging', 'still stuck');
  assert.equal(tries.length, before + 1, 'told again in the pass the busy merge returns from');
  assert.ok(mergeOf(w).doc.told_at, 'marked told');
  assert.equal(told(w, 'merge_refused').length, 1);
});

// L188 m4: a told_at write that is refused alerts merge_gate_write_refused, and the refusal is told again next pass.
test('L188 m4: a refused told_at write in tellRefused is alerted, and the refusal is told again on the next pass', async () => {
  const w = world();
  const rec = w.ctx.record; const orig = rec.write.bind(rec);
  let refused = 0;
  w.ctx.record = { ...rec, write: (x) => { if (x.entity === 'merge' && x.doc?.told_at && refused === 0) { refused += 1; return { ok: false, reason: 'refused (L188 m4 test)' }; } return orig(x); } };
  redCheck(w, verifiedCard(w));
  await gatePass(w.ctx);
  assert.equal(refused, 1);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.equal(mergeOf(w).doc.told_at, undefined);
  assert.equal(told(w, 'merge_gate_write_refused').filter((a) => a.to === 'told' && a.merge === mergeOf(w).id).length, 1, JSON.stringify(w.alerts));
  assert.equal(told(w, 'merge_refused').length, 1);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_refused').length, 2, 'told again: the mark was not written');
  assert.ok(mergeOf(w).doc.told_at, 'marked this time');
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_refused').length, 2, 'never again once marked');
});

// L188 m6: a merge GitHub shows merged or closed is settled even while the rules can't answer the merging limit.
for (const [how, merged] of [['merged', true], ['closed', false]]) {
  test(`L188 m6: a pull request ${how} after a lost merge answer settles while the rules can't answer the limit`, async () => {
    const KEY = 'timeouts.merging_open_max_min';
    const w = world(limited());
    verifiedCard(w);
    loseAnswer(w, { merged });
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'merging');
    if (!merged) w.g.pulls.get(7).state = 'closed';
    const base = w.ctx.rules;
    const broken = (k) => { if (k === KEY) throw new Error('the rules engine stopped'); };
    w.ctx.rules = Object.create(base, {
      get: { value: (k, o) => { broken(k); return base.get(k, o); } },
      num: { value: (k, o) => { broken(k); return base.num(k, o); } },
    });
    const unsure = () => told(w, 'merge_gate_unsure').filter((a) => /could not answer/.test(a.note)).length;
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, merged ? 'merged' : 'refused', JSON.stringify(mergeOf(w).doc));
    assert.equal(unsure(), 0, 'the limit was not asked: the pull request is final');
    if (merged) assert.equal(cardOf(w).state, 'merged');
  });
}

test('L168: a refusal told at once is marked in the same pass and never sent again', async () => {
  const w = world();
  redCheck(w, verifiedCard(w));
  await gatePass(w.ctx);
  assert.ok(mergeOf(w).doc.told_at);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_refused').length, 1);
});

// L164 m2: only a missing key reads as "the rules have no limit"; rules that fail to answer say the gate is unsure.
test('L164 m2: rules that fail to answer the merging limit during recovery say the gate is unsure, never that the limit is missing', async () => {
  const KEY = 'timeouts.merging_open_max_min';
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging');
  const base = w.ctx.rules;
  const broken = (k) => { if (k === KEY) throw new Error('the rules engine stopped'); };
  w.ctx.rules = Object.create(base, {
    get: { value: (k, o) => { broken(k); return base.get(k, o); } },
    num: { value: (k, o) => { broken(k); return base.num(k, o); } },
  });
  tick(w, LIMIT_MIN + 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merging', 'not refused on a limit the rules could not give');
  assert.ok(told(w, 'merge_gate_unsure').some((a) => /could not answer timeouts\.merging_open_max_min: the rules engine stopped/.test(a.note)), JSON.stringify(w.alerts));
  assert.deepEqual(told(w, 'merge_limit_missing'), []);
  assert.equal(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(mergeOf(w).id)), null);
  w.ctx.rules = base;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.deepEqual(mergeOf(w).doc.reasons, ['interrupted']);
});

// L164 m3: the missing-limit alert that throws is sent again; a told fact the gate did not make does not count.
test('L164 m3: a merge_limit_missing alert that throws writes no told fact and is sent again on the next pass', async () => {
  const w = world();
  const tries = flakyAlert(w, 'merge_limit_missing', 'throw', 1);
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  const id = mergeOf(w).id;
  tick(w, 2);
  await gatePass(w.ctx);
  assert.equal(tries.length, 1);
  assert.equal(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(id)), null, 'a thrown alert writes no told fact');
  for (let i = 0; i < 3; i++) { tick(w, 2); await gatePass(w.ctx); }
  assert.equal(tries.length, 2);
  assert.equal(told(w, 'merge_limit_missing').length, 1);
  assert.equal(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(id))?.doc?.merge, id);
});

test('L164 m3: a told fact the gate did not make is not counted: the owner is still told the limit is missing', async () => {
  const w = world();
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  const id = mergeOf(w).id;
  const fid = MERGE_LIMIT_TOLD_FACT(id);
  // The fact is there, but the Record says another role made it (factFrom reads who created it).
  must(recOf(w).write({ actor: 'merge_gate', entity: 'fact', id: fid, expectRev: 0, doc: { type: 'merge_limit_told', merge: id } }), 'planted');
  const plantRev = recOf(w).read('fact', fid).rev;
  const base = w.ctx.record;
  w.ctx.record = Object.create(base, { meta: { value: (e, x) => {
    const m = base.meta(e, x);
    return e === 'fact' && x === fid && base.read('fact', fid)?.rev === plantRev ? { ...m, createdBy: 'sensors' } : m;
  } } });
  tick(w, 2);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_limit_missing').length, 1, 'told despite the foreign fact');
  tick(w, 2);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_limit_missing').length, 1, 'the gate\'s own told fact then counts');
});

// L182 M-1: a list GitHub answers in full health but that is too long to judge is a fact about the change, so the
// refusals that need it are final (and told), never a wait that no later pass ends. A read that fails still waits.
const COMPARE_PATH = /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/;
function compareAnswer(w, change) {
  const get = w.g.gh.get;
  w.g.gh.get = async (path) => {
    const r = await get(path);
    return COMPARE_PATH.test(path) ? change(r) : r;
  };
}
const padTo = (n) => (r) => (r?.status === 200 ? { ...r, json: { ...r.json, files: [...r.json.files, ...Array.from({ length: n - r.json.files.length }, (_, i) => ({ filename: `src/more-${i}.mjs`, status: 'added', patch: '+x' }))] } } : r);
const refusedFor = (w, re) => {
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
  assert.equal(m.doc.tell_owner, true);
  assert.ok(m.doc.reasons.some((x) => re.test(x)), m.doc.reasons.join(' | '));
  assert.equal(told(w, 'merge_refused').length, 1, 'the owner is told');
  assert.equal(gatePuts(w), 0);
  assert.deepEqual(told(w, 'merge_waiting_long'), []);
};

test('L182 M-1: a change of 300 files, GitHub otherwise fine, is refused for good and the owner told to split it', async () => {
  const w = world(limited());
  verifiedCard(w);
  compareAnswer(w, padTo(300));
  await gatePass(w.ctx);
  refusedFor(w, /^(8|9|10|14): the change has 300 or more files.*split the change/);
  for (const n of ['9', '10', '14']) assert.ok(mergeOf(w).doc.reasons.some((x) => x.startsWith(`${n}: the change has 300 or more files`)), `${n} final: ${mergeOf(w).doc.reasons.join(' | ')}`);
  tick(w, 3 * LIMIT_MIN);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused', 'it stays refused');
  assert.equal(told(w, 'merge_refused').length, 1, 'told once');
});

// Real files in the commit, so every one has its tree entry: 299 is a list GitHub gives whole and merges; 300 is not.
const manyFiles = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${i}.mjs`, `v${i}`]));
for (const [n, want] of [[299, 'merged'], [300, 'refused']]) {
  test(`L182 M-1: a change of ${n} real files is ${want}`, async () => {
    const w = world(limited());
    verifiedCard(w, 'C-1', { files: manyFiles(n) });
    await gatePass(w.ctx);
    const doc = mergeOf(w).doc;
    assert.equal(doc.state, want, JSON.stringify({ reasons: doc.reasons, waiting_on: doc.waiting_on }));
    if (want === 'refused') assert.ok(doc.reasons.some((x) => /^(8|9|10|14): the change has 300 or more files/.test(x)), doc.reasons.join(' | '));
  });
}

test('L182 M-1 control: the compare call failing holds the merge to be judged again, never refused', async () => {
  const w = world(limited());
  verifiedCard(w);
  let down = true;
  compareAnswer(w, (r) => (down ? { status: 502, json: null } : r));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^12: /);
  assert.ok(!mergeOf(w).doc.waiting_on.some((x) => /300 or more|split/.test(x)), mergeOf(w).doc.waiting_on.join(' | '));
  assert.deepEqual(told(w, 'merge_refused'), []);
  down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged', 'judged again once compare answers');
});

test('L182 class: a listed file missing from its commit\'s file list is refused for good, not waited on', async () => {
  const w = world(limited());
  verifiedCard(w);
  compareAnswer(w, (r) => (r?.status === 200 ? { ...r, json: { ...r.json, files: [...r.json.files, { filename: 'src/ghost.mjs', status: 'modified', patch: '+x' }] } } : r));
  await gatePass(w.ctx);
  refusedFor(w, /src\/ghost\.mjs is not in its commit's file list/);
});

test('L182 class: 100 check runs on the head is refused for good (refusal 1), not waited on', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  w.g.checks.set(head, Array.from({ length: 100 }, (_, i) => ({ name: i ? `c${i}` : 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' })));
  await gatePass(w.ctx);
  refusedFor(w, /^1: the commit has 100 check runs; the gate reads at most 99; run fewer checks on this commit$/);
});

test('L182 class: 100 review threads is refused for good (refusal 7), not waited on', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.threads = Array.from({ length: 100 }, () => ({ isResolved: true, comments: { nodes: [{ author: { __typename: 'User' } }] } }));
  await gatePass(w.ctx);
  refusedFor(w, /^7: the pull request has 100 review threads; the gate reads at most 99; open a new pull request; resolved threads still count toward GitHub's total$/);
});

test('L182 class control: a review-thread read that fails still waits', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  w.g.gh.post = async (path, body) => (path === '/graphql' ? { status: 502, json: null } : post(path, body));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^7: the review threads could not be read/);
  assert.deepEqual(told(w, 'merge_refused'), []);
});

// L184: one cap on every wait the gate can't end by itself. Each listed hold waits (told once past the limit), and is
// refused for good past WAIT_CAP_TIMES times the limit, told once, with what it waited on as the reasons.
function wrapGet(w, change) {
  const get = w.g.gh.get;
  w.g.gh.get = async (path) => change(path, await get(path));
}
async function cappedAfter(w, re) {
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), re);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 1);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), re);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'past the limit: told once that it waits');
  assert.deepEqual(told(w, 'merge_refused'), [], 'under the cap: not refused');
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
  assert.equal(m.doc.tell_owner, true);
  assert.equal(m.doc.tell_note, waitCapNote(LIMIT_MIN * 60_000));
  assert.ok(m.doc.reasons.some((x) => re.test(x)), m.doc.reasons.join(' | '));
  assert.equal(told(w, 'merge_refused').length, 1);
  assert.deepEqual(told(w, 'merge_refused')[0].reasons, m.doc.reasons);
  assert.equal(gatePuts(w), 0);
  tick(w, 5);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused', 'it stays refused');
  assert.equal(told(w, 'merge_refused').length, 1, 'told once');
}
const redRun = (sha) => [{ name: 'test', app: { id: 1 }, head_sha: sha, status: 'completed', conclusion: 'failure' }];
const HOLDS = [
  ['the head\'s file tree comes back truncated', (w) => wrapGet(w, (p, r) => (/\/git\/trees\//.test(p) && r?.status === 200 ? { ...r, json: { ...r.json, truncated: true } } : r)), /^9: the rules gave no merge answer/],
  ['main is red', (w) => w.g.checks.set(w.g.main, redRun(w.g.main)), /^2: main is red/],
  ['main has 100 check runs', (w) => w.g.checks.set(w.g.main, Array.from({ length: 100 }, (_, i) => ({ name: i ? `c${i}` : 'test', app: { id: 1 }, head_sha: w.g.main, status: 'completed', conclusion: 'success' }))), /^2: main's checks could not be read/],
  ['the rules name no required checks', (w) => { w.values['product_profile.required_checks'] = null; }, /^1: the rules name no required checks/],
  ['the rules name an empty list of required checks', (w) => { w.values['product_profile.required_checks'] = []; }, /^1: the rules name no required checks/],
  ['the rules give no merge answer', (w) => { w.ctx.rules = Object.create(w.ctx.rules, { may: { value: () => { throw new Error('the engine stopped'); } } }); }, /^9: the rules gave no merge answer/],
  ['the go check fails', (w) => { const base = w.ctx.record; w.ctx.record = Object.create(base, { read: { value: (e, id) => { if (e === 'go') throw new Error('go store gone'); return base.read(e, id); } } }); }, /^10: the go could not be checked/],
  ['GitHub never works out mergeable', (w) => { w.g.pulls.get(7).mergeable_state = 'unknown'; }, /^3: GitHub has not worked out/],
  ['a required check never runs', (w, head) => w.g.checks.set(head, []), /^1: required check test has not run/],
  ['a review session never ends', (w, head) => runnerLaunch(w.env, 'C-1', 'R-C-1-again', 'reviewer', head), /^5: /],
  ['the rules have no first-customer paths', (w) => { w.values.effect_paths = {}; }, /^14: the change's files or the first-customer paths could not be read/],
  // L187: the review runner's records unreadable, and a tier M10 can't give for files the gate did read.
  ['the review runner\'s records can\'t be read', (w) => { w.ctx.reviewLaunches = Object.create(w.ctx.reviewLaunches, { root: { get() { throw new Error('launch folder unreadable'); } } }); }, /^5: the review runner's records could not be read: the review records could not be read/],
];
for (const [name, make, re] of HOLDS) {
  test(`L184: ${name}: waits, told once past the limit, refused for good after ${WAIT_CAP_TIMES} times it`, async () => {
    const w = world(limited());
    const head = verifiedCard(w);
    make(w, head);
    await cappedAfter(w, re);
  });
}

// L188: the cap's refusal is told as any refusal is (tellRefused, gatePass 3b): a lost alert is sent again next pass.
for (const mode of ['false', 'throw']) {
  test(`L188: a cap refusal whose merge_refused alert is lost (${mode}) is told again next pass, then never again`, async () => {
    const w = world(limited());
    verifiedCard(w);
    w.g.pulls.get(7).mergeable_state = 'unknown';
    const tries = flakyAlert(w, 'merge_refused', mode, 1);
    await gatePass(w.ctx);
    tick(w, WAIT_CAP_TIMES * LIMIT_MIN);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'refused');
    assert.equal(mergeOf(w).doc.tell_note, waitCapNote(LIMIT_MIN * 60_000));
    assert.equal(tries.length, 1, 'tried once');
    assert.equal(mergeOf(w).doc.told_at, undefined, 'not marked told: the alert was lost');
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(tries.length, 2, 'sent again');
    assert.ok(mergeOf(w).doc.told_at, 'marked told once taken');
    assert.equal(told(w, 'merge_refused').length, 1);
    assert.equal(told(w, 'merge_refused')[0].note, waitCapNote(LIMIT_MIN * 60_000));
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(tries.length, 2, 'not sent a third time');
  });
}

// L186: a failed thread read or carry-over read is a pass with GitHub unreadable: past the cap it still waits, and it
// merges (or is judged on what it reads) once the reads return.
test('L186 control: a carry-over read that fails past the cap never refuses', async () => {
  const w = world(limited());
  const h0 = verifiedCard(w);
  // The pull request's head moved on from the reviewed head, and the carry-over's compare of main with H0 fails.
  const h1 = w.g.commit([h0], { 'src/a.mjs': 'three' }, { from: h0 });
  w.g.pulls.get(7).head = h1;
  const view = w.ctx.view;
  let down = true;
  // A real failed read: the connection dropped (as Node's fetch throws it). A plain Error is git-view's own answer
  // and counts toward the cap (#108 r3 M-r3).
  w.ctx.view = Object.create(view, { compare: { value: (b, h) => (down && h === h0 ? Promise.reject(new TypeError('fetch failed')) : view.compare(b, h)) } });
  const re = /^5: whether the review carries over .* could not be read/;
  for (const step of [0, WAIT_CAP_TIMES * LIMIT_MIN, 5]) {
    tick(w, step);
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), re);
  }
  assert.equal(mergeOf(w).doc.stuck_since, null);
  assert.deepEqual(told(w, 'merge_refused'), []);
  down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  // Read once the compare answers, and judged on it: here the review does not carry over (a final refusal, not the cap).
  assert.equal(mergeOf(w).doc.state, 'refused', JSON.stringify(mergeOf(w).doc));
  assert.deepEqual(mergeOf(w).doc.reasons, ['5: the review was for ' + h0.slice(0, 7) + '; it does not carry over to ' + h1.slice(0, 7)]);
  assert.equal(mergeOf(w).doc.tell_note, FINAL_NOTE);
});

test('L186 control: a GraphQL-only outage longer than the cap never refuses, and the merge goes through once reads return', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  let down = true;
  w.g.gh.post = async (path, body) => (down && path === '/graphql' ? { status: 502, json: null } : post(path, body));
  for (const step of [0, LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN, 5]) {
    tick(w, step);
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^7: the review threads could not be read/);
  }
  assert.equal(mergeOf(w).doc.stuck_since, null, 'a failed thread read does not start the cap\'s clock');
  assert.deepEqual(told(w, 'merge_refused'), []);
  down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
  assert.deepEqual(told(w, 'merge_refused'), []);
});

test('L186 control: a thread read that fails for one pull request holds only that one; the change behind it merges in the same pass', async () => {
  const w = world(limited());
  verifiedCard(w);
  tick(w, 1);
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  const post = w.g.gh.post;
  w.g.gh.post = async (path, body) => (path === '/graphql' && body?.variables?.pr === 7 ? { status: 502, json: null } : post(path, body));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w, 'C-1'), /^7: the review threads could not be read/);
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merged', 'a failed read for one pull request is not an outage that stops the queue');
});

// L187 c1: a check or status list too long to read is a fact about that one change (refusal 1, final), not GitHub
// down, so the queue doesn't stop for a pass behind it: the change after it is judged in the same pass.
for (const which of ['checks', 'statuses']) {
  test(`L187 c1: 100 ${which} on one change refuses it, and the change behind it merges in the same pass`, async () => {
    const w = world(limited());
    const head = verifiedCard(w);
    tick(w, 1);
    verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
    if (which === 'checks') w.g.checks.set(head, Array.from({ length: 100 }, (_, i) => ({ name: i ? `c${i}` : 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' })));
    else w.g.statuses.set(head, Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: 'success' })));
    await gatePass(w.ctx);
    assert.equal(mergeOf(w, 'C-1').doc.state, 'refused', JSON.stringify(mergeOf(w, 'C-1').doc));
    assert.ok(mergeOf(w, 'C-1').doc.reasons.some((x) => new RegExp(`^1: the commit has 100 ${which === 'checks' ? 'check runs' : 'statuses'}`).test(x)), mergeOf(w, 'C-1').doc.reasons.join(' | '));
    assert.equal(mergeOf(w, 'C-2').doc.state, 'merged', 'a list too long to read is not an outage that stops the queue');
  });
}

test('L187 c1 control: a check-run read that fails still stops the queue for the pass', async () => {
  const w = world(limited());
  verifiedCard(w);
  tick(w, 1);
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  const get = w.g.gh.get;
  w.g.gh.get = async (path) => (/\/check-runs/.test(path) ? { status: 502, json: null } : get(path));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w, 'C-1'), /^1: the checks could not be read/);
  assert.notEqual(mergeOf(w, 'C-2')?.doc.state, 'merged', 'GitHub down for check runs stops the queue for the pass');
});

// L187: M10 gives the tier from the files, so with them read, no tier is final (refusal 5), not a wait.
test('L187: no tier for files the gate read is refused for good (refusal 5), told', async () => {
  const w = world(limited());
  verifiedCard(w);
  const r = w.ctx.rules;
  w.ctx.rules = Object.create(r, { classify: { value: (x) => ({ ...r.classify(x), tier: null }) } });
  await gatePass(w.ctx);
  refusedFor(w, /^5: the rules give no tier for the change's files$/);
});

// L187: a compare that fails for one pull request is that change's, not GitHub down: it holds that one (not counted
// toward the cap, as a failed thread read), and the change behind it is judged in the same pass.
test('L187: a compare that fails for one pull request holds only that one; the change behind it merges in the same pass', async () => {
  const w = world(limited());
  const h1 = verifiedCard(w);
  tick(w, 1);
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  wrapGet(w, (p, r) => (new RegExp(`/compare/[0-9a-f]{40}\\.\\.\\.${h1}$`).test(p) ? { status: 404, json: null } : r));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w, 'C-1'), /^12: the branch could not be compared with main/);
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merged', 'a compare that fails for one pull request does not stop the queue');
});

test('L187 control: a compare that fails past the cap never refuses, and merges once it reads', async () => {
  const w = world(limited());
  verifiedCard(w);
  let down = true;
  wrapGet(w, (p, r) => (down && /\/compare\//.test(p) ? { status: 502, json: null } : r));
  for (const step of [0, LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN, 5]) {
    tick(w, step);
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^12: the branch could not be compared with main/);
  }
  assert.equal(mergeOf(w).doc.stuck_since, null, 'a failed compare does not start the cap\'s clock');
  assert.deepEqual(told(w, 'merge_refused'), []);
  down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
});

test('L184 control: a wait that clears before the cap still merges', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 1);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  w.g.pulls.get(7).mergeable_state = 'clean';
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
  assert.deepEqual(told(w, 'merge_refused'), []);
});

test('L184 control: GitHub down past the cap never refuses; the cap\'s clock starts at the first pass with GitHub readable', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.down = true;
  for (let i = 0; i < 4; i++) {
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^3: the pull request could not be read/);
    tick(w, LIMIT_MIN);
  }
  assert.equal(mergeOf(w).doc.stuck_since, null, 'an outage pass does not start the cap\'s clock');
  assert.deepEqual(told(w, 'merge_refused'), []);
  // GitHub back, but the PR's mergeable state still unknown: a new wait, timed from now, not from the outage.
  w.g.down = false;
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: GitHub has not worked out/);
  assert.equal(mergeOf(w).doc.stuck_since, nowIso(w));
  w.g.down = true;
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: the pull request could not be read/);
  assert.deepEqual(told(w, 'merge_refused'), [], 'past the cap, but GitHub unreadable: still never refused');
  w.g.down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused', 'an outage in the middle doesn\'t start the clock again');
  assert.equal(told(w, 'merge_refused').length, 1);
});

test('L184 control: a hold of another kind in between starts the cap\'s clock again', async () => {
  const w = world(limited());
  verifiedCard(w);
  const pr = w.g.pulls.get(7);
  pr.mergeable_state = 'unknown';
  await gatePass(w.ctx);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 1);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  // One pass held for the rules not being adopted (not a wait): the wait is over.
  const adopted = w.values['rules.adopted'];
  pr.mergeable_state = 'clean';
  w.values['rules.adopted'] = { blob: 'f'.repeat(40) };
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'held');
  assert.equal(mergeOf(w).doc.hold, 'rules_not_adopted');
  assert.equal(mergeOf(w).doc.stuck_since, null);
  // Waiting again: a new wait, timed from now.
  w.values['rules.adopted'] = adopted;
  pr.mergeable_state = 'unknown';
  tick(w, 1);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  assert.deepEqual(told(w, 'merge_refused'), []);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
});

// L174 m2 (the r5 audit's local test, kept): tellLimitMissing writes its told fact only after a delivered alert. A sink
// that answers false then true, one that throws then answers true, a told-fact write refused once, and a sink that
// answers false forever: one attempt per pass until the fact is written, then none; never written while it is lost.
for (const mode of ['false-then-true', 'throw-then-true', 'write-refused-once', 'false-forever']) {
  test(`L174 m2: tellLimitMissing is told again each pass until delivered and recorded (${mode})`, async () => {
    const w = world();
    const sent = []; const delivered = [];
    let k = -1;
    const mine = (a) => a?.type === 'merge_limit_missing';
    const alert = fakeAlert({
      // throws is asked first on every call, so it numbers the merge_limit_missing calls.
      throws: (a) => { if (!mine(a)) return false; k += 1; sent.push(k); return mode === 'throw-then-true' && k === 0 && 'outbox down'; },
      answer: (a) => { if (!mine(a)) return true; if (mode === 'false-forever' || (mode === 'false-then-true' && k === 0)) return false; delivered.push(k); return true; },
    });
    w.ctx.alert = alert;
    let refusedWrites = 0;
    if (mode === 'write-refused-once') {
      const rec = w.ctx.record; const orig = rec.write.bind(rec);
      w.ctx.record = { ...rec, write: (x) => { if (x.entity === 'fact' && String(x.id).startsWith('merge-limit-told-') && refusedWrites === 0) { refusedWrites += 1; return { ok: false, reason: 'refused (L174 test)' }; } return orig(x); } };
    }
    verifiedCard(w);
    loseAnswer(w, { merged: false });
    await gatePass(w.ctx);
    const id = mergeOf(w).id;
    const toldAt = [];
    for (let i = 0; i < 5; i++) {
      tick(w, 2);
      await gatePass(w.ctx);
      toldAt.push(recOf(w).read('fact', MERGE_LIMIT_TOLD_FACT(id)) ? 1 : 0);
    }
    const writeRefused = alert.texts.filter((a) => a?.type === 'merge_gate_write_refused' && a.to === 'told').length;
    if (mode === 'false-forever') {
      assert.equal(delivered.length, 0);
      assert.deepEqual(toldAt, [0, 0, 0, 0, 0], 'never recorded while lost');
      assert.equal(sent.length, 5, 'tried every pass');
      return;
    }
    assert.ok(delivered.length >= 1, 'delivered at least once');
    const firstTold = toldAt.indexOf(1);
    assert.ok(firstTold >= 0, 'the told fact is written once an alert is delivered');
    assert.equal(sent.length, firstTold + 1, 'one attempt per pass until the fact is written, then none');
    assert.equal(toldAt[0], 0, 'not recorded on the first pass');
    assert.ok(toldAt.slice(firstTold).every((x) => x === 1), 'stays recorded');
    if (mode === 'write-refused-once') {
      assert.equal(refusedWrites, 1);
      assert.equal(writeRefused, 1, 'the refused write is told');
      assert.equal(delivered.length, 2, 'told again after the refused write, then recorded');
    } else {
      assert.equal(delivered.length, 1, 'delivered exactly once');
      assert.equal(writeRefused, 0);
    }
  });
}

test('L182 class (r2 probe): 100 statuses on the head is refused for good (refusal 1), told', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  w.g.statuses.set(head, Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: 'success' })));
  await gatePass(w.ctx);
  refusedFor(w, /^1: the commit has 100 statuses/);
});

// ───────────────────────────── L190: #108 r1. The auditor's probes (A1-A8, C1) as written, plus B1 as ruled.

// A1 (M1): a wait that cleared (main red, then fixed) is followed by a catch-up and a fresh CI wait on the new head.
// The new wait must be timed from its own start, not inherit the old stuck_since.
test('L190 probe A1: after main red clears and the merge catches up, a fresh CI wait is not refused on the old clock', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.checks.set(w.g.main, redRun(w.g.main));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^2: main is red/);
  const t0 = mergeOf(w).doc.stuck_since;
  assert.ok(t0);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 5);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^2: main is red/);
  // main is fixed by a new commit: green, and the pull request is now behind it.
  w.g.main = w.g.commit([w.g.main], { 'docs/fix.md': 'x' }, { from: w.g.main });
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up', JSON.stringify(mergeOf(w).doc));
  // CI on the caught-up head has not run yet.
  w.g.checks.set(w.g.pulls.get(7).head, []);
  tick(w, 5);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.notEqual(m.doc.state, 'refused', `refused for good ${Math.round((w.env.clock.t - Date.parse(t0)) / 60000)} min after an old wait began, 5 min into a new one: ${JSON.stringify(m.doc.reasons)}`);
  // Lane 2's addition: the new wait has its own clock and its own notice.
  waitingHeld(m, /^1: /);
  assert.equal(Date.parse(m.doc.stuck_since), w.env.clock.t, 'the new wait starts its own clock');
  assert.equal(m.doc.wait_told_at ?? null, null, 'and has told nothing yet');
});

// A2 (M2): under the lock (check()), a GraphQL blip makes judge hold; that pass is unreadable, so it can't refuse.
test('L190 probe A2: a GraphQL blip under the lock past the cap does not refuse for good', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 1);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^3: /);
  // The wait clears; in this pass the second thread read (the one under the lock) fails.
  w.g.pulls.get(7).mergeable_state = 'clean';
  const post = w.g.gh.post;
  let n = 0;
  w.g.gh.post = async (path, body) => (path === '/graphql' && ++n >= 2 ? { status: 502, json: null } : post(path, body));
  tick(w, 2);
  await gatePass(w.ctx);
  assert.notEqual(mergeOf(w).doc.state, 'refused', `refused for good on a GraphQL blip: ${JSON.stringify(mergeOf(w).doc.reasons)}`);
});

// A3 (M2): the same blip under the lock with no earlier wait must not start the cap's clock.
test('L190 probe A3: a GraphQL blip under the lock does not start the cap clock', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  let n = 0;
  w.g.gh.post = async (path, body) => (path === '/graphql' && ++n >= 2 ? { status: 502, json: null } : post(path, body));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^7: the review threads could not be read/);
  assert.equal(mergeOf(w).doc.stuck_since ?? null, null, `stuck_since started on an outage: ${mergeOf(w).doc.stuck_since}`);
});

// A4 (M3): a thread read that SUCCEEDS but comes back incomplete counts toward the cap (L186).
test('L190 probe A4: a thread list whose count never matches is refused after the cap, not waited on forever', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  w.g.gh.post = async (path, body) => {
    const r = await post(path, body);
    if (path !== '/graphql') return r;
    const t = r.json.data.repository.pullRequest.reviewThreads;
    return { ...r, json: { data: { repository: { pullRequest: { reviewThreads: { ...t, totalCount: t.nodes.length + 1 } } } } } };
  };
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^7: /);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN + 1);
  await gatePass(w.ctx);
  tick(w, 5);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused', `waits forever: stuck_since=${mergeOf(w).doc.stuck_since}`);
  // Lane 2's addition: the reason says the list came back incomplete, not that it could not be read.
  assert.ok(mergeOf(w).doc.reasons.some((x) => /^7: the review threads came back incomplete \(GitHub counts \d+ review threads but lists \d+\)/.test(x)), mergeOf(w).doc.reasons.join(' | '));
});

// A5 (M4): a FAILED read of main's check runs (5xx), with everything else readable, is an outage pass.
test('L190 probe A5: main\'s check-run read failing (5xx) past the cap never refuses', async () => {
  const w = world(limited());
  verifiedCard(w);
  const main = w.g.main;
  wrapGet(w, (p, r) => (p.includes(`/commits/${main}/check-runs`) ? { status: 502, json: null } : r));
  for (const step of [0, WAIT_CAP_TIMES * LIMIT_MIN, 5]) {
    tick(w, step);
    await gatePass(w.ctx);
  }
  assert.notEqual(mergeOf(w).doc.state, 'refused', `refused for good on a failed read: ${JSON.stringify(mergeOf(w).doc.reasons)}`);
});

// A6: outage flapping never resets the clock; refused once 3x passes with GitHub readable.
test('L190 probe A6: flapping outage passes do not reset the clock; refused once 3x passes with GitHub readable', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  const t0 = mergeOf(w).doc.stuck_since;
  for (let i = 0; i < 6; i++) {
    w.g.down = i % 2 === 0;
    tick(w, 7);
    await gatePass(w.ctx);
    if (mergeOf(w).doc.state === 'refused') break;
    assert.equal(mergeOf(w).doc.stuck_since, t0, `pass ${i}`);
  }
  w.g.down = false;
  tick(w, 5);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.equal(told(w, 'merge_refused').length, 1);
  assert.equal(told(w, 'merge_waiting_long').length, 1);
});

// A7: the default-limit note and the long-wait note are each told once over many passes.
test('L190 probe A7: with no limit in the rules, the default note and the long wait are each told once over many passes', async () => {
  const w = world();
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  for (let i = 0; i < 15; i++) { await gatePass(w.ctx); tick(w, 7); }
  assert.equal(told(w, 'merge_limit_missing').length, 1);
  assert.equal(told(w, 'merge_waiting_long').length, 1);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.equal(told(w, 'merge_refused').length, 1);
});

// A8: 99 check runs on the head are read and judged (not refused for length).
test('L190 probe A8: 99 check runs is judged, not refused as too long', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  w.g.checks.set(head, Array.from({ length: 99 }, (_, i) => ({ name: i ? `c${i}` : 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' })));
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged', JSON.stringify(mergeOf(w).doc));
});

// C1 (M4): the reviewed head's commit read failing (view.commit) is a failed read: an outage pass.
test('L190 probe C1: the reviewed head\'s commit read failing past the cap never refuses', async () => {
  const w = world(limited());
  const h0 = verifiedCard(w);
  const view = w.ctx.view;
  w.ctx.view = Object.create(view, { commit: { value: (s) => (s === h0 ? Promise.reject(new Error('HTTP 502')) : view.commit(s)) } });
  for (const step of [0, WAIT_CAP_TIMES * LIMIT_MIN, 5]) { tick(w, step); await gatePass(w.ctx); }
  assert.notEqual(mergeOf(w).doc.state, 'refused', `refused for good on a failed read: ${JSON.stringify(mergeOf(w).doc.reasons)}`);
});

// C1 controls (M4): the same read in git-view's own failed-read wording is an outage pass too; a tree GitHub answered
// but cut off counts toward the cap (git-view "file list ... is cut off"; L190, retiring L186's tree to-do).
test('L190 C1 controls: git-view\'s failed read is an outage pass; its cut-off tree counts toward the cap', async () => {
  for (const [message, refused] of [['GitHub answered 502 for /repos/o/r/git/commits/x', false], ['file list of 1234567 is cut off or unknown', true]]) {
    const w = world(limited());
    const h0 = verifiedCard(w);
    const view = w.ctx.view;
    w.ctx.view = Object.create(view, { commit: { value: (s) => (s === h0 ? Promise.reject(new Error(message)) : view.commit(s)) } });
    for (const step of [0, WAIT_CAP_TIMES * LIMIT_MIN, 5]) { tick(w, step); await gatePass(w.ctx); }
    assert.equal(mergeOf(w).doc.state === 'refused', refused, `${message}: ${JSON.stringify(mergeOf(w).doc)}`);
  }
});

// M4: a head check list GitHub answered but cut off counts toward the cap, with a reason that says so; a failed one
// (502) is an outage pass that holds and never refuses.
test('L190 M4: a cut-off head check list is a wait capped like any other; a failed head check read never refuses', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  wrapGet(w, (p, r) => (p.includes(`/commits/${head}/check-runs`) && r?.status === 200 ? { ...r, json: { ...r.json, total_count: r.json.check_runs.length + 1 } } : r));
  await cappedAfter(w, /^1: the check runs are cut off \(\d+ listed of \d+\); GitHub's count doesn't match its list/);

  const w2 = world(limited());
  const head2 = verifiedCard(w2);
  wrapGet(w2, (p, r) => (p.includes(`/commits/${head2}/check-runs`) ? { status: 502, json: null } : r));
  for (const step of [0, WAIT_CAP_TIMES * LIMIT_MIN, 5]) { tick(w2, step); await gatePass(w2.ctx); }
  assert.equal(mergeOf(w2).doc.state, 'held', JSON.stringify(mergeOf(w2).doc));
  assert.equal(mergeOf(w2).doc.stuck_since ?? null, null, 'an outage never starts the clock');
});

// B1, as ruled in L190: a catch-up GitHub accepts (202) but whose head never moves is capped from the request: told
// once past the limit, refused for good at WAIT_CAP_TIMES times it with CATCH_UP_STUCK. Outage passes don't count.
const stuckCatchUp = (w) => {
  w.g.main = w.g.commit([w.g.main], { 'docs/other.md': 'x' }, { from: w.g.main });
  w.g.answer.update = () => ({ status: 202, json: { message: 'Updating pull request branch.' } });
};
test('L190 B1 (auditor probe): a catch-up GitHub accepts but never makes is capped or told', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  for (let i = 0; i < 10; i++) { await gatePass(w.ctx); tick(w, 10); }
  const m = mergeOf(w);
  const toldAny = w.alerts.filter((a) => a.merge === m.id);
  assert.ok(m.doc.state !== 'catching_up' || toldAny.length > 0, `100 min in catching_up, state=${m.doc.state}, alerts=${JSON.stringify(w.alerts)}`);
});
test('L190 B1: a stuck catch-up is told once past the limit and refused for good at the cap, timed from the request', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  await gatePass(w.ctx);
  const asked = mergeOf(w);
  assert.equal(asked.doc.state, 'catching_up');
  assert.equal(Date.parse(asked.doc.stuck_since), w.env.clock.t, 'the clock starts at the request');
  tick(w, LIMIT_MIN - 1);
  await gatePass(w.ctx);
  assert.deepEqual(told(w, 'merge_waiting_long'), [], 'under the limit: nothing told');
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'past the limit: told once');
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - LIMIT_MIN - 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up', 'one minute under the cap: still waiting');
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'told once');
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
  assert.deepEqual(m.doc.reasons, ['GitHub accepted the branch update but the head never moved']);
  assert.equal(m.doc.tell_owner, true);
  assert.equal(m.doc.tell_note, waitCapNote(LIMIT_MIN * 60_000));
  assert.equal(told(w, 'merge_refused').length, 1);
  tick(w, 5);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_refused').length, 1, 'told once');
  assert.equal(gatePuts(w), 0, 'never merged');
});
test('L190 B1 blip control: a head that moves late (past the limit, under the cap) is caught up and merged, never refused', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  await gatePass(w.ctx);
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up');
  // GitHub makes the commit at last.
  const pr = w.g.pulls.get(7);
  pr.head = w.g.commit([pr.head, w.g.main], pr.files, { from: w.g.main });
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged', JSON.stringify(m.doc));
  assert.equal(m.doc.catch_ups.length, 1);
  assert.deepEqual(told(w, 'merge_refused'), []);
  assert.equal(m.doc.stuck_since ?? null, null, 'the catch-up\'s clock is cleared when the head moves');
});
test('L190 B1 outage control: the pull request unreadable while catching up, past the cap, never refuses', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  await gatePass(w.ctx);
  const t0 = mergeOf(w).doc.stuck_since;
  w.g.down = true;
  for (const step of [LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN, 5]) { tick(w, step); await gatePass(w.ctx); }
  assert.equal(mergeOf(w).doc.state, 'catching_up', JSON.stringify(mergeOf(w).doc));
  assert.deepEqual(told(w, 'merge_refused'), []);
  assert.equal(mergeOf(w).doc.stuck_since, t0, 'an outage neither refuses nor resets the clock');
});

// M1, lane 2's additions: each way out of a wait clears all of its fields, not only the one a probe reads.
test('L190 M1: a stuck catch-up after a long wait that was told gets its own notice', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.checks.set(w.g.main, redRun(w.g.main));
  await gatePass(w.ctx);
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^2: main is red/);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'the first wait is told');
  stuckCatchUp(w);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up');
  assert.equal(mergeOf(w).doc.wait_told_at ?? null, null, 'the catch-up starts with nothing told');
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_waiting_long').length, 2, 'the stuck catch-up is told on its own');
});
test('L190 M1: a merge that waited and then merged keeps no wait fields', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.pulls.get(7).mergeable_state = 'unknown';
  await gatePass(w.ctx);
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_waiting_long').length, 1);
  w.g.pulls.get(7).mergeable_state = 'clean';
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged', JSON.stringify(m.doc));
  for (const k of ['waiting_on', 'waiting_since', 'wait_told_at', 'stuck_since']) assert.equal(m.doc[k] ?? null, null, `${k} is cleared`);
});

// ---- L205 (#108 r2): a check whose GitHub read failed is not GitHub's "no" ----------------------------------------
// M2's go and Approve checks, M10's exact-reverse and carry-over checks and the robot's mark turned a failed read into a
// "no" with a reason, so one 502 refused a merge for good. The read is now classed: a failed read holds the merge and
// does not count toward the cap; a 4xx other than 401, 403 and 429 is GitHub's answer, so its wait counts (Minor 1).
const failOnce = (w, method, match, err) => {
  const view = w.ctx.view;
  const state = { left: 1 };
  w.ctx.view = Object.create(view, { [method]: { value: (...a) => (state.left > 0 && match(...a) ? (state.left -= 1, Promise.reject(err())) : view[method](...a)) } });
  return state;
};
const ghErr = (status) => () => new Error(`GitHub answered ${status} for /repos/sample-org/sample-app/git/trees/t?recursive=1`);

test('L205: a single 502 on the go check\'s folder read leaves the merge held, not refused; the next pass merges', async () => {
  const w = world(limited());
  verifiedCard(w);
  const s = failOnce(w, 'isDir', () => true, ghErr(502));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^10: the go could not be checked/);
  assert.equal(s.left, 0, 'the folder read was the one that failed');
  assert.equal(mergeOf(w).doc.stuck_since, null, 'a failed read does not start the cap\'s clock');
  assert.deepEqual(told(w, 'merge_refused'), []);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged', JSON.stringify(mergeOf(w).doc));
});

test('L205: a go check whose folder read keeps failing past the cap never refuses; it merges once the read returns', async () => {
  const w = world(limited());
  verifiedCard(w);
  const s = failOnce(w, 'isDir', () => true, ghErr(502));
  for (const step of [0, LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN, 5]) {
    s.left = 1;
    tick(w, step);
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^10: the go could not be checked/);
  }
  assert.equal(mergeOf(w).doc.stuck_since, null);
  assert.deepEqual(told(w, 'merge_refused'), []);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
});

// Minor 1: GitHub answered (a 404 here); the check could not finish, so 10 waits, and that wait counts toward the cap.
test('L205 Minor 1: a 404 on the go check\'s folder read is an answer: the wait counts toward the cap', async () => {
  const w = world(limited());
  verifiedCard(w);
  const view = w.ctx.view;
  w.ctx.view = Object.create(view, { isDir: { value: () => Promise.reject(ghErr(404)()) } });
  await cappedAfter(w, /^10: the go could not be checked/);
});

// defaultReadRow: a row file read that fails (not 200, not 404) is unknown, so 10 waits; read, it is judged.
test('L205: a row file read that fails holds the merge on 10; read, the change is judged on the row', async () => {
  const w = world(limited());
  verifiedCard(w, 'C-1', { files: { 'src/a.mjs': 'two', 'docs/blueprint/rows/R-1.yaml': 'id: R-1\n' } });
  let down = true;
  wrapGet(w, (p, r) => (down && p.includes('/contents/docs/blueprint/rows/R-1.yaml') ? { status: 502, json: null } : r));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^10: the go could not be checked/);
  assert.equal(mergeOf(w).doc.stuck_since, null);
  down = false;
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.ok(mergeOf(w).doc.reasons.some((x) => /^10: docs\/blueprint\/rows\/R-1\.yaml is a row the go doesn't name/.test(x)), mergeOf(w).doc.reasons.join(' | '));
});

// The undo route with one read under the exact-reverse check failing: held on 9, never refused; next pass it merges.
test('L205: a failed read in the exact-reverse check holds the undo on 9; the next pass merges it', async () => {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  must(put(w.env.record, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  w.env.clock.t += 60_000;
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
  w.ctx.rules = fakeRules({ values: w.values, answers: { merge: allow('in lane') } });
  const s = failOnce(w, 'onHistory', (sha) => sha === flagged, ghErr(502));
  await gatePass(w.ctx);
  assert.equal(s.left, 0);
  const u = mergeOf(w, 'U-1');
  assert.equal(u.doc.state, 'held', JSON.stringify(u.doc));
  assert.ok((u.doc.waiting_on ?? []).some((x) => /^9: whether the undo is an exact reverse could not be read/.test(x)), (u.doc.waiting_on ?? []).join(' | '));
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w, 'U-1').doc.state, 'merged', JSON.stringify(mergeOf(w, 'U-1').doc));
});

// L205 Minor 2, a tripwire: the real git view's error for a GitHub answer is what failedRead classes. If git-view's
// message or shape changes, this fails here rather than every failed read quietly counting toward the cap.
test('L205 Minor 2: the real makeGitView\'s errors are classed by failedRead: 5xx, 401, 403, 429 failed; 404, 422 answered', async () => {
  const { failedRead } = await import('./gather.mjs');
  for (const [status, failed] of [[502, true], [500, true], [401, true], [403, true], [429, true], [404, false], [422, false]]) {
    const view = makeGitView({ gh: { get: async () => ({ status, json: null }) }, owner: 'sample-org', repo: 'sample-app' });
    for (const read of [() => view.isDir('a'.repeat(40), 'src'), () => view.commit('a'.repeat(40)), () => view.compare('a'.repeat(40), 'b'.repeat(40))]) {
      const e = await read().then(() => null, (x) => x);
      assert.ok(e, `${status}: the read threw`);
      assert.equal(failedRead(e), failed, `${status}: ${e?.message}`);
    }
  }
  const dropped = makeGitView({ gh: { get: async () => { throw new TypeError('fetch failed'); } }, owner: 'sample-org', repo: 'sample-app' });
  assert.equal(failedRead(await dropped.commit('a'.repeat(40)).then(() => null, (x) => x)), true, 'no answer at all');
});

// Lane 1's review of the L205 M2 diff, note 1: M2 marks any read that threw `unreadable`, with the error as `cause`;
// the Merge Gate classes the cause. This drives M2's real countApprove with GitHub answering each status on the pull
// request read: a 404, 410 or 422 is GitHub's answer (the wait counts toward the cap, so a gone pull request is refused
// at the cap, never held forever); a 5xx, 401, 403 or 429 is a failed read (held, no clock).
test('L205 lane 1 note 1: M2\'s unreadable Approve is classed by its cause: 404/410/422 answered, 5xx/401/403/429 failed', async () => {
  const { failedRead } = await import('./gather.mjs');
  const { countApprove } = await import('../M2-approvals/github-review.mjs');
  for (const [status, failed] of [[404, false], [410, false], [422, false], [500, true], [502, true], [401, true], [403, true], [429, true]]) {
    const gh = { get: async () => ({ status, json: null }) };
    const v = await countApprove({ gh, view: null, owner: 'sample-org', repo: 'sample-app', pr: 12, githubId: 1, raisedAt: '2026-11-01T00:00:00Z' });
    assert.deepEqual([v.ok, v.unreadable], [false, true], `${status}: ${JSON.stringify(v)}`);
    assert.match(String(v.cause?.message), new RegExp(`^GitHub answered ${status} for /repos/sample-org/sample-app/pulls/12`));
    assert.equal(failedRead(v.cause), failed, `${status}: ${v.cause?.message}`);
  }
});

// The Approve, through the gate (L205 r2 plants Q8, Q10): an answered Approve ask whose reviews read fails holds the
// merge on 8, with no clock, and merges once the read returns; a reviews read GitHub answers with a 404 is an answer,
// so the wait counts toward the cap.
const OWNER_ID = 4242;
function approveAsk(w, { head, pr = 7, id = 'R-1', card = 'C-1' }) {
  const rec = recOf(w);
  const base = { kind: 'risky_approve', card, title: 'Change the schema', tier: 2, risky: ['schema'], pr, raised_at: nowIso(w), reask_count: 0 };
  must(rec.write({ actor: 'approvals', entity: 'ask', id, expectRev: 0, doc: { ...base, state: 'open' } }), 'ask open');
  must(put(rec, 'approvals', 'ask', id, { state: 'pushed' }), 'ask pushed');
  must(put(rec, 'approvals', 'ask', id, { state: 'answered', answer: { approves: true, head } }), 'ask answered');
}
function approveWorld(reviews) {
  const w = world(limited());
  const r = w.ctx.rules;
  w.ctx.rules = Object.create(r, { classify: { value: (x) => ({ ...r.classify(x), risky: ['schema'] }) } });
  const head = verifiedCard(w);
  approveAsk(w, { head });
  const values = { ...w.values, 'accounts.joe.github_id': OWNER_ID, 'accounts.joe.tz': 'UTC', 'approvals.push_windows': ['08:00'], 'approvals.decisions_dir': 'docs/decisions' };
  const approved = { status: 200, json: [{ id: 1, user: { id: OWNER_ID, type: 'User' }, state: 'APPROVED', commit_id: head, submitted_at: nowIso(w, 1) }] };
  const gh = { ...w.g.gh, get: async (p) => (/\/pulls\/\d+\/reviews/.test(p) ? reviews(approved) : w.g.gh.get(p)) };
  w.ctx.approvals = { record: recOf(w), rules: fakeRules({ values }), product: PRODUCT, now: w.ctx.now, alert: fakeAlert(), gh, owner: 'sample-org', repo: 'sample-app' };
  return w;
}
test('L205: an Approve whose reviews read fails holds the merge on 8 with no clock; read, the Approve stands and it merges', async () => {
  let down = true;
  const w = approveWorld((ok) => (down ? { status: 502, json: null } : ok));
  await gatePass(w.ctx);
  waitingHeld(mergeOf(w), /^8: the Approve could not be read from GitHub: GitHub answered 502/);
  assert.equal(mergeOf(w).doc.stuck_since, null, 'a failed read does not start the cap\'s clock');
  assert.deepEqual(told(w, 'merge_refused'), []);
  down = false;
  tick(w, 2);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged', JSON.stringify(mergeOf(w).doc));
});
test('L205 Minor 1: an Approve whose reviews read GitHub answers with a 404 waits on 8, and the wait counts toward the cap', async () => {
  const w = approveWorld(() => ({ status: 404, json: null }));
  await cappedAfter(w, /^8: the Approve could not be read from GitHub: GitHub answered 404/);
});

// The robot's mark on an undo at the first cutover (plant Q17): a failed statuses read leaves "does it reverse a gate
// merge?" unknown, so the undo waits on 9; the next pass reads the mark and merges it.
test('L205: at the first cutover, a failed read of the reversed commit\'s mark holds the undo on 9; the next pass merges it', async () => {
  const w = world({ values: { 'product.cutover_stage': 'first' } });
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(recOf(w).write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  must(put(recOf(w), 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  tick(w, 1);
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
  w.ctx.rules = fakeRules({ values: w.values, answers: { merge: allow('in lane') } });
  let left = 1;
  wrapGet(w, (p, r) => (left > 0 && p.includes(`/commits/${flagged}/statuses`) ? (left -= 1, { status: 502, json: null }) : r));
  await gatePass(w.ctx);
  assert.equal(left, 0, 'the mark read was the one that failed');
  const u = mergeOf(w, 'U-1');
  assert.equal(u.doc.state, 'held', JSON.stringify(u.doc));
  assert.ok((u.doc.waiting_on ?? []).some((x) => /^9: /.test(x)), (u.doc.waiting_on ?? []).join(' | '));
  assert.equal(u.doc.stuck_since, null);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w, 'U-1').doc.state, 'merged', JSON.stringify(mergeOf(w, 'U-1').doc));
});

// S16, L548: the mark read goes straight to the client, not through git-view, so a throw there is marked in watchReads.
const undoAwaitingMark = async (w) => {
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(recOf(w).write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  must(put(recOf(w), 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  tick(w, 1);
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
  w.ctx.rules = fakeRules({ values: w.values, answers: { merge: allow('in lane') } });
  return flagged;
};
test('S16, L548: a raw throw on the mark read is not read, never an answer: the wait does not count, and the next pass merges', async () => {
  for (const msg of ['socket hang up', 'read ECONNRESET', 'Unexpected end of JSON input', 'the token file could not be read']) {
    const w = world({ values: { 'product.cutover_stage': 'first' } });
    const flagged = await undoAwaitingMark(w);
    let left = 1;
    wrapGet(w, (p, r) => { if (left > 0 && p.includes(`/commits/${flagged}/statuses`)) { left -= 1; throw new Error(msg); } return r; });
    await gatePass(w.ctx);
    assert.equal(left, 0, `${msg}: the mark read was the one that threw`);
    const u = mergeOf(w, 'U-1');
    assert.equal(u.doc.state, 'held', `${msg}: ${JSON.stringify(u.doc)}`);
    assert.ok((u.doc.waiting_on ?? []).some((x) => /^9: /.test(x)), (u.doc.waiting_on ?? []).join(' | '));
    assert.equal(u.doc.stuck_since, null, `${msg}: a failed read does not start the cap`);
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w, 'U-1').doc.state, 'merged', JSON.stringify(mergeOf(w, 'U-1').doc));
  }
});
test('S16, L548: the same throw sustained past the cap never refuses the undo, and the owner is told it waits', async () => {
  const lim = limited();
  const w = world({ ...lim, values: { ...lim.values, 'product.cutover_stage': 'first' } });
  const flagged = await undoAwaitingMark(w);
  wrapGet(w, (p, r) => { if (p.includes(`/commits/${flagged}/statuses`)) throw new Error('socket hang up'); return r; });
  for (const step of [0, 5, WAIT_CAP_TIMES * LIMIT_MIN, 5]) { tick(w, step); await gatePass(w.ctx); }
  assert.equal(mergeOf(w, 'U-1').doc.state, 'held', JSON.stringify(mergeOf(w, 'U-1').doc));
  assert.equal(told(w, 'merge_refused').length, 0);
  assert.ok(told(w, 'merge_waiting_long').length >= 1, 'a long wait on a failed read is told');
});

// The review threads (plant Q25): a GraphQL answer of 404 is GitHub's answer, so the wait on 7 counts toward the cap.
test('L205 Minor 1: a review-thread read GitHub answers with a 404 waits on 7, and the wait counts toward the cap', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  w.g.gh.post = async (path, body) => (path === '/graphql' ? { status: 404, json: null } : post(path, body));
  await cappedAfter(w, /^7: the review threads could not be read/);
});

// #108 r3 (LEAD-CALLS L225): git-view's own answers about the change, thrown from a watched read, are not failed reads.
// The wait they cause counts toward the cap, as the same error from an unwatched read does, so the merge is
// refused at the cap, never held for ever. failedRead is the one judge.
const CUT_OFF = (sha = 'abcdef1') => new Error(`file list of ${sha} is cut off or unknown`);
const OVER_300 = () => new Error('compare lists 300 files; GitHub cuts the list at 300');
test('#108 r3 R3-a: the go check\'s folder read finds main\'s tree cut off: the wait on 10 counts toward the cap', async () => {
  const w = world(limited());
  verifiedCard(w);
  const view = w.ctx.view;
  w.ctx.view = Object.create(view, { isDir: { value: () => Promise.reject(CUT_OFF()) } });
  await cappedAfter(w, /^10: the go could not be checked/);
});
test('#108 r3 R3-b: a carry-over whose files read is cut off at 300 (main moved since the review): the wait on 5 counts toward the cap', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.main = w.g.commit([w.g.main], { 'docs/other.md': 'x' }, { from: w.g.main });
  const newMain = w.g.main;
  const view = w.ctx.view;
  w.ctx.view = Object.create(view, { files: { value: (b, h) => (h === newMain ? Promise.reject(OVER_300()) : view.files(b, h)) } });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.ok(m.doc.stuck_since !== null || m.doc.state === 'refused', `the wait counts toward the cap: ${JSON.stringify(m.doc)}`);
  for (const step of [LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN]) { tick(w, step); await gatePass(w.ctx); }
  assert.equal(mergeOf(w).doc.state, 'refused', JSON.stringify(mergeOf(w).doc));
  assert.ok(mergeOf(w).doc.reasons.some((x) => /^5: /.test(x)), mergeOf(w).doc.reasons.join(' | '));
  assert.equal(told(w, 'merge_refused').length, 1);
});
test('S1, L543: a carry-over whose files read says "not an ancestor", from the real git view: the wait counts toward the cap, then refused and told', async () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const diverged = makeGitView({ gh: { get: async () => ({ status: 200, json: { status: 'diverged', merge_base_commit: { sha: 'd'.repeat(40) }, files: [] } }) }, owner: 'o', repo: 'r' });
  const notAncestor = await diverged.files(A, B).then(() => null, (e) => e);
  assert.match(notAncestor?.message ?? '', /is not an ancestor of/);
  const w = world(limited());
  verifiedCard(w);
  w.g.main = w.g.commit([w.g.main], { 'docs/other.md': 'x' }, { from: w.g.main });
  const newMain = w.g.main;
  const view = w.ctx.view;
  w.ctx.view = Object.create(view, { files: { value: (b, h) => (h === newMain ? Promise.reject(notAncestor) : view.files(b, h)) } });
  await gatePass(w.ctx);
  assert.notEqual(mergeOf(w).doc.stuck_since ?? null, null, `the wait counts toward the cap: ${JSON.stringify(mergeOf(w).doc)}`);
  for (const step of [LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN]) { tick(w, step); await gatePass(w.ctx); }
  assert.equal(mergeOf(w).doc.state, 'refused', JSON.stringify(mergeOf(w).doc));
  assert.equal(told(w, 'merge_refused').length, 1);
});
test('#108 r3 R3-c: an undo whose exact-reverse compare lists 300 files: the wait counts toward the cap and the undo is refused, told', async () => {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  const rec = recOf(w);
  must(rec.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  must(put(rec, 'dispatcher', 'card', 'C-1', { state: 'closed' }), 'closed');
  tick(w, 1);
  verifiedCard(w, 'U-1', { pr: 9, files: { 'src/a.mjs': 'one' }, undo: flagged });
  w.ctx.rules = fakeRules({ values: { ...w.values, 'timeouts.merging_open_max_min': LIMIT_MIN }, answers: { merge: allow('in lane') } });
  const view = w.ctx.view;
  w.ctx.view = Object.create(view, { onHistory: { value: (s, t) => (s === flagged ? Promise.reject(OVER_300()) : view.onHistory(s, t)) } });
  await gatePass(w.ctx);
  assert.equal(mergeOf(w, 'U-1').doc.state, 'held', JSON.stringify(mergeOf(w, 'U-1').doc));
  assert.notEqual(mergeOf(w, 'U-1').doc.stuck_since, null, 'the cap\'s clock runs');
  for (const step of [LIMIT_MIN, WAIT_CAP_TIMES * LIMIT_MIN]) { tick(w, step); await gatePass(w.ctx); }
  assert.equal(mergeOf(w, 'U-1').doc.state, 'refused', JSON.stringify(mergeOf(w, 'U-1').doc));
  assert.equal(told(w, 'merge_refused').filter((a) => a.card === 'U-1' || JSON.stringify(a).includes('U-1')).length, 1);
});

// L231 (#108 r3): under the lock, a hold whose move is refused, with the write-refused alert lost too, was left in
// checking; the next pass refused it as "GitHub did not merge the judged head" with nothing told. Both ways out:
// the hold's write alone refused (ended refused now, with what the check found), and every write out of checking
// refused that pass (recover() ends it next pass). Either way Joe is told once, when the alert gets through.
test('L231: a hold under the lock whose move is refused ends refused, and Joe is told once the alert gets through', async () => {
  for (const all of [false, true]) {
    const w = world(limited());
    verifiedCard(w);
    // The second thread read (the one under the lock) fails, so the check under the lock holds (L190 probe A3).
    const post = w.g.gh.post;
    let n = 0;
    w.g.gh.post = async (path, body) => (path === '/graphql' && ++n >= 2 ? { status: 502, json: null } : post(path, body));
    const rec = w.ctx.record; const orig = rec.write.bind(rec);
    let pass = 0; let refusedWrites = 0;
    w.ctx.record = { ...rec, write: (x) => {
      const from = x.entity === 'merge' ? rec.read('merge', x.id)?.doc?.state : null;
      if (pass === 0 && from === 'checking' && (x.doc?.state === 'held' || (all && x.doc?.state !== 'checking'))) { refusedWrites += 1; return { ok: false, reason: 'refused (L231 test)' }; }
      return orig(x);
    } };
    flakyAlert(w, 'merge_gate_write_refused', 'false', 99);
    flakyAlert(w, 'merge_refused', 'false', 1);
    await gatePass(w.ctx);
    assert.ok(refusedWrites >= 1, 'a write out of checking was refused');
    assert.equal(mergeOf(w).doc.state, all ? 'checking' : 'refused', `all=${all}`);
    assert.equal(cardOf(w).state, 'verified', 'the card is put back');
    assert.deepEqual(told(w, 'merge_gate_write_refused'), [], 'the write-refused alerts were lost');
    for (pass = 1; pass < 4 && !mergeOf(w).doc.told_at; pass++) { tick(w, 1); await gatePass(w.ctx); }
    const m = mergeOf(w);
    assert.ok(m.doc.told_at, `all=${all}: told in the end: ${JSON.stringify(m.doc)}`);
    assert.equal(told(w, 'merge_refused').length, 1, `all=${all}: told once`);
    if (all) assert.deepEqual([m.doc.reasons, m.doc.tell_note], [['GitHub did not merge the judged head'], CHECK_CUT_NOTE]);
    else {
      assert.ok(m.doc.reasons.some((r) => /^7: the review threads could not be read/.test(r)), m.doc.reasons.join(' | '));
      assert.equal(m.doc.tell_note, CHECK_CUT_NOTE);
      assert.equal(m.doc.stuck_since, null, 'the wait clock is cleared');
    }
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(told(w, 'merge_refused').length, 1, 'not told again');
    assert.equal(gatePuts(w), 0, 'nothing was merged');
  }
});


// L315 (class audit, told once ever while still waiting): a wait the owner was told of is told again every 24 h while it lasts,
// and its marks are cleared when it ends. Ticks of hours keep the outside check green, as the real watcher would.
const DAY_MIN = 24 * 60;
function stayGreen(w) {
  const at = new Date(w.env.clock.t).toISOString();
  w.facts.set(ROBOT_FACT(PRODUCT), { product: PRODUCT, green: true, red_since: null, last_green_at: at });
  w.facts.set(NO_PUSH_FACT, { green: true, at });
}
const later = async (w, min) => { tick(w, min); stayGreen(w); return gatePass(w.ctx); };

test('L315 S-M6a: a wait while GitHub can\'t be read is told at the limit, quiet at +2 h, told again at +25 h naming it, and cleared when reads return', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  let down = true;
  w.g.gh.post = async (path, body) => (down && path === '/graphql' ? { status: 502, json: null } : post(path, body));
  await later(w, 0);
  assert.equal(told(w, 'merge_waiting_long').length, 0, 'not yet at the limit');
  await later(w, LIMIT_MIN);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'told at the limit');
  await later(w, 120);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'quiet at +2 h');
  await later(w, DAY_MIN + 60 - 120);
  assert.equal(told(w, 'merge_waiting_long').length, 2, 'told again at +25 h');
  assert.match(told(w, 'merge_waiting_long')[1].note, /GitHub can't be read/);
  await later(w, 60);
  assert.equal(told(w, 'merge_waiting_long').length, 2, 'quiet again after the re-tell');
  assert.equal(mergeOf(w).doc.stuck_since, null, 'an outage never starts the cap');
  assert.deepEqual(told(w, 'merge_refused'), [], 'an outage never refuses');
  down = false;
  await later(w, 1);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merged');
  for (const f of ['waiting_on', 'waiting_since', 'wait_told_at', 'stuck_since']) assert.equal(m.doc[f] ?? null, null, f);
  await later(w, DAY_MIN + 60);
  assert.equal(told(w, 'merge_waiting_long').length, 2, 'never told again once it ended');
});

test('L315 S-M6b: the wait on an interrupted pull request\'s reading has a clock: told after the limit, then daily, never refused, cleared when the reading lands', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  const again = () => recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  const waits = () => told(w, 'merge_waiting_long').filter((a) => a.merge === again()?.id);
  await later(w, 1);
  assert.equal(again().doc.state, 'queued');
  assert.ok(Number.isFinite(Date.parse(again().doc.waiting_since)), 'the wait has a start time');
  assert.equal(waits().length, 0, 'quiet before the limit');
  await later(w, LIMIT_MIN);
  assert.equal(waits().length, 1, 'told after the limit');
  assert.match(waits()[0].note, /interrupted/);
  await later(w, 120);
  assert.equal(waits().length, 1, 'quiet at +2 h');
  await later(w, DAY_MIN + 60 - 120);
  assert.equal(waits().length, 2, 'told again at +25 h');
  await later(w, WAIT_CAP_TIMES * LIMIT_MIN);
  assert.equal(again().doc.state, 'queued', 'never refused: the earlier merge may still land');
  assert.equal(gatePuts(w), 1, 'no second merge call');
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, 1) });
  await later(w, 1);
  const m = again();
  assert.equal(m.doc.state, 'merged');
  for (const f of ['waiting_on', 'waiting_since', 'wait_told_at', 'stuck_since']) assert.equal(m.doc[f] ?? null, null, f);
  await later(w, DAY_MIN + 60);
  assert.equal(waits().length, 2, 'never told again once it ended');
});

test('L315 S-M6b: the interrupted alert is sent again each pass until it is taken, then not again', async () => {
  const w = world(limited());
  verifiedCard(w);
  const tries = flakyAlert(w, 'merge_interrupted', 'false', 2);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  assert.deepEqual(mergeOf(w).doc.reasons, ['interrupted']);
  assert.equal(tries.length, 1);
  assert.equal(told(w, 'merge_interrupted').length, 0, 'the first was lost');
  await later(w, 1);
  assert.equal(told(w, 'merge_interrupted').length, 0, 'the second was lost');
  await later(w, 1);
  assert.equal(told(w, 'merge_interrupted').length, 1, 'sent again until taken');
  await later(w, 1);
  await later(w, DAY_MIN);
  assert.equal(told(w, 'merge_interrupted').length, 1, 'once taken, not again');
  assert.equal(tries.length, 3);
});

test('L315 minor: with no limit in the rules, the open-after-the-merge-call note is told again every 24 h while it stays open, and not once it settles', async () => {
  const w = world();
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  const open = () => told(w, 'merge_limit_missing').filter((a) => /still open after the merge call/.test(a.note));
  await gatePass(w.ctx);
  await later(w, 1);
  assert.equal(open().length, 1, 'told once it is open');
  await later(w, 120);
  assert.equal(open().length, 1, 'quiet at +2 h');
  await later(w, DAY_MIN + 60 - 120);
  assert.equal(open().length, 2, 'told again at +25 h');
  assert.equal(open()[1].again, true);
  assert.match(open()[1].note, /^still: .*told again every 24 h/);
  await later(w, 60);
  assert.equal(open().length, 2, 'quiet again after the re-tell');
  w.g.pulls.get(7).state = 'closed';
  await later(w, 1);
  await later(w, DAY_MIN + 60);
  assert.equal(open().length, 2, 'never told again once it settled');
});

// #154 audit Minor 2 (L290 M-1): each gathered file's blob is the one compare named for it, git's own id for its bytes;
// a file compare gives no sha for has no blob, so refusal 10 waits on it instead of matching anything.
test('gather: each file\'s blob is compare\'s sha for it, git\'s id of its bytes; no sha, no blob', async () => {
  const files = { 'src/a.mjs': 'two', 'docs/b.md': 'line\r\nnext\r\n' };
  const w = world();
  verifiedCard(w, 'C-1', { files });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  const f = await gatherFacts(w.ctx, m);
  assert.ok(Array.isArray(f.files) && f.files.length === 2, JSON.stringify(f.filesProblem));
  for (const x of f.files) assert.equal(x.blob, blobSha(Buffer.from(files[x.path])), x.path);
  // The same ids the compare answer gave, file by file.
  const real = w.g.gh.get.bind(w.g.gh);
  let seen = null;
  w.g.gh.get = async (path) => { const r = await real(path); if (/\/compare\//.test(path)) seen = r.json.files; return r; };
  const again = await gatherFacts(w.ctx, m);
  assert.ok(seen, 'compare was read');
  assert.deepEqual(again.files.map((x) => [x.path, x.blob]).sort(), seen.map((x) => [x.filename, x.sha]).sort());
  // Compare names no sha: the file has no blob at all.
  w.g.gh.get = async (path) => { const r = await real(path); return /\/compare\//.test(path) && r.status === 200 ? { ...r, json: { ...r.json, files: r.json.files.map(({ sha, ...x }) => x) } } : r; };
  const none = await gatherFacts(w.ctx, m);
  assert.equal(none.files.length, 2);
  for (const x of none.files) assert.equal('blob' in x, false, x.path);
});

// L329 (the pastTime sweep): every stored time the gate reads goes through shared pastTime. A time that can't be read,
// or one stamped 1 h ahead, counts as old enough: the gate acts or tells on that pass, never waits it out.
const BAD_TIMES = (w) => [['unreadable', 'not a time'], ['1 h ahead', nowIso(w, 60)]];
function plantMerge(w, fields) {
  const m = mergeOf(w);
  must(recOf(w).write({ actor: 'merge_gate', entity: 'merge', id: m.id, expectRev: m.rev, doc: { ...m.doc, ...fields } }), 'planted');
}

for (const name of ['unreadable', '1 h ahead']) {
  test(`L329 gate.mjs hold cap: a stuck_since that is ${name} fires the cap on the first pass, not a restarted clock`, async () => {
    const w = world(limited());
    verifiedCard(w);
    w.g.checks.set(w.g.main, redRun(w.g.main));
    await gatePass(w.ctx);
    waitingHeld(mergeOf(w), /^2: main is red/);
    plantMerge(w, { stuck_since: Object.fromEntries(BAD_TIMES(w))[name] });
    tick(w, 1);
    await gatePass(w.ctx);
    const m = mergeOf(w);
    assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
    assert.equal(m.doc.tell_note, waitCapNote(LIMIT_MIN * 60_000));
    assert.equal(told(w, 'merge_refused').length, 1);
  });

  test(`L329 gate.mjs catch-up cap: a stuck_since that is ${name} fires the cap on the first pass`, async () => {
    const w = world(limited());
    verifiedCard(w);
    stuckCatchUp(w);
    await gatePass(w.ctx);
    assert.equal(mergeOf(w).doc.state, 'catching_up');
    plantMerge(w, { stuck_since: Object.fromEntries(BAD_TIMES(w))[name] });
    tick(w, 1);
    await gatePass(w.ctx);
    const m = mergeOf(w);
    assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
    assert.deepEqual(m.doc.reasons, ['GitHub accepted the branch update but the head never moved']);
    assert.equal(told(w, 'merge_refused').length, 1);
  });

  test(`L329 gate.mjs waitedLong: a waiting_since that is ${name} is told on that pass`, async () => {
    const w = world(limited());
    verifiedCard(w);
    w.g.checks.set(w.g.main, redRun(w.g.main));
    await gatePass(w.ctx);
    assert.deepEqual(told(w, 'merge_waiting_long'), [], 'a fresh wait is under the limit');
    plantMerge(w, { waiting_since: Object.fromEntries(BAD_TIMES(w))[name] });
    tick(w, 1);
    await gatePass(w.ctx);
    assert.equal(told(w, 'merge_waiting_long').length, 1, 'told now, not waited out');
    assert.equal(mergeOf(w).doc.state, 'held', 'only the wait\'s own clock was bad: the cap clock is fine');
  });
}

// L353: an ABSENT stuck_since is old enough too (L321), never "start the clock": the catch-up cap fires on that pass.
test('L353 gate.mjs catch-up cap: a catch-up with no stuck_since at all fires the cap on that pass', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up');
  const { stuck_since, ...rest } = mergeOf(w).doc;
  must(recOf(w).write({ actor: 'merge_gate', entity: 'merge', id: mergeOf(w).id, expectRev: mergeOf(w).rev, doc: rest }), 'planted');
  assert.equal('stuck_since' in mergeOf(w).doc, false, 'planted with no stuck_since');
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'refused', JSON.stringify(m.doc));
  assert.deepEqual(m.doc.reasons, ['GitHub accepted the branch update but the head never moved']);
  assert.equal(told(w, 'merge_refused').length, 1);
});

// L356 MAT-1 (the auditor's probe E): where the cap can't be judged, only the cap's clock is stamped. waiting_since and
// the told mark are the wait's own (L330), so a 10-day wait is not made new and its told mark is kept.
test('L356 MAT-1 gate.mjs catch-up cap: with no limit, an absent stuck_since is stamped, and waiting_since and the told mark are left alone', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  await gatePass(w.ctx);
  const old = nowIso(w, -10 * DAY_MIN);
  const toldAt = nowIso(w, -60);
  plantMerge(w, { stuck_since: null, waiting_since: old, wait_told_at: toldAt });
  const base = w.ctx.rules;
  const broken = (k) => { if (k === 'timeouts.merging_open_max_min') throw new Error('the rules engine stopped'); };
  w.ctx.rules = Object.create(base, {
    get: { value: (k, o) => { broken(k); return base.get(k, o); } },
    num: { value: (k, o) => { broken(k); return base.num(k, o); } },
  });
  tick(w, 1);
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'catching_up');
  assert.equal(Date.parse(m.doc.stuck_since), w.env.clock.t, 'the cap clock is stamped, to be judged once the rules answer');
  assert.equal(m.doc.waiting_since, old, 'waiting_since is not made new');
  assert.equal(m.doc.wait_told_at, toldAt, 'the told mark is kept');
  w.ctx.rules = base;
});

// L356 MAT-2 (the auditor's probe F): the interrupted-PR wait borrows only the told clock of a merge that is catching
// up; its catch-up clock (stuck_since) is kept, and the catch-up wait is timed from it again when the reading lands.
test('L356 MAT-2 gate.mjs: a catch-up that meets the interrupted-PR wait keeps its catch-up clock through it, and is not refused at once after', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  const again = () => recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  await later(w, 1);
  assert.ok(again().doc.wait_reading, 'waits for the reading');
  // It was catching up (two merges of one pull request at once), with its catch-up clock running.
  const a = again();
  const clock = nowIso(w, -5);
  must(recOf(w).write({ actor: 'merge_gate', entity: 'merge', id: a.id, expectRev: a.rev, doc: { ...a.doc, wait_reading: null, state: 'catching_up', catch_up_from: head, stuck_since: clock } }), 'catching up');
  tick(w, 1);
  await gatePass(w.ctx);
  assert.ok(again().doc.wait_reading, 'the wait began again');
  assert.equal(again().doc.stuck_since, clock, 'the wait leaves the catch-up clock alone');
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, 1) });
  tick(w, 2);
  await gatePass(w.ctx);
  const back = again();
  assert.notEqual(back.doc.state, 'refused', `refused at once: ${JSON.stringify(back.doc)}`);
  assert.equal(back.doc.wait_reading ?? null, null, 'that wait is over');
  assert.equal(back.doc.stuck_since, clock, 'the catch-up clock was kept');
  assert.equal(back.doc.waiting_since, clock, 'the catch-up wait is timed from it again');
  assert.deepEqual(back.doc.waiting_on, ['GitHub accepted the branch update but the head never moved']);
});

// L356 MAT-3 (the auditor's probe G): a catch-up whose pull request can't be read is an outage pass: never refused, but
// told after the limit and every 24 h.
test('L356 MAT-3 gate.mjs: a catch-up whose pull request can\'t be read is told after the limit and again at +25 h, and never refused', async () => {
  const w = world(limited());
  verifiedCard(w);
  stuckCatchUp(w);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'catching_up');
  const get = w.g.gh.get.bind(w.g.gh);
  w.g.gh.get = async (path) => { if (/\/pulls\/7$/.test(path)) throw new Error('GitHub is down'); return get(path); };
  await later(w, LIMIT_MIN);
  const waits = () => told(w, 'merge_waiting_long').filter((a) => a.merge === mergeOf(w).id);
  assert.equal(waits().length, 1, 'told after the limit');
  assert.equal(waits()[0].outage, true);
  await later(w, 120);
  assert.equal(waits().length, 1, 'quiet at +2 h');
  for (let m = 0; m < DAY_MIN; m += 60) await later(w, 60);
  assert.equal(waits().length, 2, 'told again a day on');
  assert.equal(mergeOf(w).doc.state, 'catching_up', 'never refused while it can\'t be read');
  assert.deepEqual(told(w, 'merge_refused'), []);
});

// L356 m3 P5: a told mark the Record refuses is alerted (L323), never dropped quietly.
test('L356 m3 P5 gate.mjs: a refused wait_told write is alerted', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.checks.set(w.g.main, redRun(w.g.main));
  await gatePass(w.ctx);
  const rec = recOf(w);
  const refuses = (a) => a.entity === 'merge' && a.doc?.wait_told_at && a.doc.wait_told_at !== rec.read('merge', a.id)?.doc?.wait_told_at;
  w.ctx.record = Object.create(rec, { write: { value: (a) => (refuses(a) ? { ok: false, reason: 'planted refusal' } : rec.write(a)) } });
  tick(w, LIMIT_MIN);
  await gatePass(w.ctx);
  w.ctx.record = rec;
  assert.equal(told(w, 'merge_waiting_long').length, 1);
  assert.ok(w.alerts.some((a) => a.type === 'merge_gate_write_refused' && a.to === 'wait_told' && /planted refusal/.test(a.reason)), 'the refused mark is alerted');
});

// L356 m3 P6: when the reading lands the interrupted-PR wait is cleared, so a later wait gets its own clock and notice.
test('L356 m3 P6 gate.mjs: the clear when the reading lands gives the next wait its own start and no told mark', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  const again = () => recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  await later(w, 1);
  await later(w, LIMIT_MIN);
  assert.ok(again().doc.wait_told_at, 'the interrupted-PR wait was told');
  // The reading lands, and main is red: the merge is held in a new wait.
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, 1) });
  tick(w, 2);
  w.g.checks.set(w.g.main, redRun(w.g.main));
  await gatePass(w.ctx);
  const m = again();
  assert.equal(m.doc.state, 'held', JSON.stringify(m.doc));
  assert.equal(m.doc.wait_reading ?? null, null);
  assert.equal(Date.parse(m.doc.waiting_since), w.env.clock.t, 'the new wait starts now');
  assert.equal(m.doc.wait_told_at ?? null, null, 'with nothing told yet');
});

// L356 m3 P8: the cut check reads with the clock, so a reading stamped in the future never ends the wait.
test('L356 m3 P8 gate.mjs: a reading stamped 1 h ahead does not end the interrupted-PR wait, and no second merge call goes out', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  const again = () => recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  await later(w, 1);
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, 60) });
  await later(w, 1);
  assert.equal(again().doc.state, 'queued');
  assert.ok(again().doc.wait_reading, 'still waiting for a reading it can trust');
  assert.equal(gatePuts(w), 1, 'no second merge call');
});

// L356 m3 P11 and c3: telling never restamps waiting_since (L330), and the re-tell counts the hours from it.
test('L356 m3 P11 gate.mjs: the waiting alert leaves waiting_since alone, and the re-tell says how many hours', async () => {
  const w = world(limited());
  verifiedCard(w);
  const post = w.g.gh.post;
  w.g.gh.post = async (path, body) => (path === '/graphql' ? { status: 502, json: null } : post(path, body));
  await later(w, 0);
  const t0 = mergeOf(w).doc.waiting_since;
  assert.ok(t0);
  await later(w, LIMIT_MIN);
  assert.equal(told(w, 'merge_waiting_long').length, 1);
  assert.equal(mergeOf(w).doc.waiting_since, t0, 'not restamped by the tell');
  await later(w, DAY_MIN + 60);
  const notes = told(w, 'merge_waiting_long');
  assert.equal(notes.length, 2);
  assert.equal(mergeOf(w).doc.waiting_since, t0, 'not restamped by the re-tell');
  const hours = Math.floor((w.env.clock.t - Date.parse(t0)) / 3_600_000);
  assert.match(notes[1].note, new RegExp(`waited to be judged for ${hours} h`));
});

// L356 m5: the told mark names its wait, so a mark left by another wait never quiets this one.
test('L356 m5 gate.mjs: a told mark from another wait does not quiet this one', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.checks.set(w.g.main, redRun(w.g.main));
  await gatePass(w.ctx);
  plantMerge(w, { waiting_since: nowIso(w, -2 * LIMIT_MIN), wait_told_at: nowIso(w, -1), wait_told_since: nowIso(w, -DAY_MIN) });
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'told: the mark was another wait\'s');
  assert.equal(mergeOf(w).doc.wait_told_since, mergeOf(w).doc.waiting_since, 'the mark now names this wait');
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'then quiet');
});

// L357 (b): an interrupted refusal settled by another caller (M11's open-too-long refusal) is told by step 3b, with
// its note written in the refusal itself, and sent again after an alert that wasn't taken.
test('L357 gate.mjs: an interrupted_note written with a refusal settled outside the gate is delivered by step 3b, and re-sent after a lost alert', async () => {
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merging');
  const out = settleMerge({ record: recOf(w), alert: w.ctx.alert, now: () => w.env.clock.t }, m.id, {
    pr: { state: 'open', merged: false, merge_commit_sha: null, head_sha: m.doc.judged_head }, reason: 'interrupted', openTooLong: true,
    fields: { interrupted_note: 'still open after the merge call (settled outside the gate)', interrupted_told_at: null } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(mergeOf(w).doc.interrupted_note, 'still open after the merge call (settled outside the gate)', 'written in the refusal itself');
  const tries = flakyAlert(w, 'merge_interrupted', 'false', 1);
  await later(w, 1);
  assert.equal(tries.length, 1);
  assert.equal(told(w, 'merge_interrupted').length, 0, 'the first was lost');
  await later(w, 1);
  assert.equal(told(w, 'merge_interrupted').length, 1, 'sent again by 3b, with no merge in progress');
  assert.equal(told(w, 'merge_interrupted')[0].note, 'still open after the merge call (settled outside the gate)');
  assert.ok(mergeOf(w).doc.interrupted_told_at);
  await later(w, DAY_MIN);
  assert.equal(told(w, 'merge_interrupted').length, 1, 'once taken, not again');
});

// L357 end to end: M11's open-too-long refusal carries its note, a first alert that isn't taken is sent on the next
// pass, and once it is marked nothing more goes out. M11 itself tells nothing.
test('L357 M11 + gate.mjs: an open-too-long refusal by M11 is told by step 3b, again after a lost alert, and quiet once marked', async () => {
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.equal(m.doc.state, 'merging');
  tick(w, LIMIT_MIN + 1);
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: m.doc.judged_head, observed_at: nowIso(w, 0) });
  const said = fakeAlert();
  await timeLimits({ rec: recOf(w), rules: w.ctx.rules, now: w.env.clock.t, b: {}, gateAlive: () => false, hasReviewer: () => true, requestReview: () => ({ ok: true }), alert: said });
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.deepEqual(said.texts.filter((t) => /still open/.test(t)), [], 'M11 tells nothing itself');
  const note = mergeOf(w).doc.interrupted_note;
  assert.match(note, /still open after \d+ min, with no merge/);
  const tries = flakyAlert(w, 'merge_interrupted', 'false', 1);
  await later(w, 1);
  assert.equal(tries.length, 1);
  assert.equal(told(w, 'merge_interrupted').length, 0, 'the first was lost');
  await later(w, 1);
  assert.deepEqual(told(w, 'merge_interrupted').map((a) => a.note), [note], 'sent on the next pass');
  assert.ok(mergeOf(w).doc.interrupted_told_at);
  await later(w, DAY_MIN);
  assert.equal(told(w, 'merge_interrupted').length, 1, 'quiet once marked');
});

// L348: a partial reading (GitHub's answer without a real merged) is no reading, so it holds the new merge of an
// interrupted PR, and that wait is told past the limit like any other.
test('L348 gate.mjs: a partial reading of an interrupted pull request holds the new merge, and the wait is told past the limit', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  const again = () => recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  await later(w, 1);
  sensorsReads(w, { state: 'closed', merged: 'true', merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, 0) });
  await later(w, 1);
  assert.equal(again().doc.state, 'queued');
  assert.ok(again().doc.wait_reading, 'still waiting for a real reading');
  assert.equal(gatePuts(w), 1, 'no second merge call');
  assert.equal(told(w, 'merge_waiting_long').length, 0, 'under the limit');
  await later(w, DEFAULT_WAIT_LIMIT_MIN + 1);
  assert.equal(again().doc.state, 'queued');
  assert.equal(gatePuts(w), 1);
  assert.equal(told(w, 'merge_waiting_long').length, 1, 'told past the limit');
  assert.match(told(w, 'merge_waiting_long')[0].note, /was interrupted; waiting for a reading/);
});

// L358: the start gate stops merging, not telling. With robot merges not green, a lost refusal alert and an
// interrupted note are both sent again, and nothing else happens.
test('L358 gate.mjs: with the start gate shut, a lost refusal alert and an interrupted note are sent again, and nothing merges', async () => {
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  const m = mergeOf(w);
  must(settleMerge({ record: recOf(w), alert: w.ctx.alert, now: () => w.env.clock.t }, m.id, {
    pr: { state: 'open', merged: false, merge_commit_sha: null, head_sha: m.doc.judged_head }, reason: 'interrupted', openTooLong: true,
    fields: { interrupted_note: 'still open after the merge call', interrupted_told_at: null, tell_owner: true } }), 'settled outside the gate');
  // A second, ready card waits with its merge request: it must not be taken in while the gate is shut.
  verifiedCard(w, 'C-2', { pr: 8, files: { 'src/b.mjs': 'b' } });
  const card2 = cardOf(w, 'C-2').state;
  assert.equal(recOf(w).list('merge_request').filter((q) => q.doc.card === 'C-2').length, 1, 'C-2 is queued');
  const puts = gatePuts(w);
  const writes = w.g.writes.length;
  const merges = recOf(w).list('merge').length;
  const lost = flakyAlert(w, 'merge_refused', 'false', 1);
  tick(w, 121);   // the outside check has not been green for 2 h: the start gate is shut
  const r1 = await gatePass(w.ctx);
  assert.equal(r1.ran, false);
  assert.equal(r1.reason, NOT_GREEN_LINE);
  assert.equal(lost.length, 1, 'the refusal alert was tried with the gate shut');
  assert.equal(told(w, 'merge_refused').length, 0, 'and lost');
  assert.equal(told(w, 'merge_interrupted').length, 1, 'the interrupted note is delivered with the gate shut');
  tick(w, 1);
  const r2 = await gatePass(w.ctx);
  assert.equal(r2.ran, false);
  assert.equal(told(w, 'merge_refused').length, 1, 'the lost refusal alert is sent again with the gate shut');
  assert.ok(mergeOf(w).doc.told_at);
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(told(w, 'merge_refused').length, 1, 'once taken, not again');
  assert.equal(told(w, 'merge_interrupted').length, 1);
  assert.equal(gatePuts(w), puts, 'no merge call');
  assert.equal(w.g.writes.length, writes, 'no GitHub write');
  assert.equal(recOf(w).list('merge').length, merges, 'no merge taken in');
  assert.equal(mergeOf(w, 'C-2'), undefined, 'C-2 is not taken in');
  assert.equal(cardOf(w, 'C-2').state, card2, 'and its card has not moved');
  assert.equal(mergeOf(w).doc.state, 'refused');
  // The control: C-2 was ready all along, so it is the shut gate that held it. With the gate open its merge call goes
  // out on the next pass (its answer is lost like C-1's, so it stops at merging).
  stayGreen(w);
  await gatePass(w.ctx);
  assert.equal(gatePuts(w), puts + 1, 'C-2\'s merge call goes out once the gate opens');
  assert.equal(mergeOf(w, 'C-2').doc.state, 'merging');
});

test('L329 gate.mjs hold cap: where the cap can\'t be judged (the rules can\'t answer the limit), a bad stuck_since is restamped, then judged from it', async () => {
  const w = world(limited());
  verifiedCard(w);
  w.g.checks.set(w.g.main, redRun(w.g.main));
  await gatePass(w.ctx);
  plantMerge(w, { stuck_since: 'not a time' });
  const base = w.ctx.rules;
  const broken = (k) => { if (k === 'timeouts.merging_open_max_min') throw new Error('the rules engine stopped'); };
  w.ctx.rules = Object.create(base, {
    get: { value: (k, o) => { broken(k); return base.get(k, o); } },
    num: { value: (k, o) => { broken(k); return base.num(k, o); } },
  });
  tick(w, 1);
  await gatePass(w.ctx);
  const restamped = mergeOf(w);
  assert.equal(restamped.doc.state, 'held');
  assert.equal(Date.parse(restamped.doc.stuck_since), w.env.clock.t, 'restamped to now');
  w.ctx.rules = base;
  tick(w, WAIT_CAP_TIMES * LIMIT_MIN - 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'held', 'judged from the restamp: under the cap');
  tick(w, 1);
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
});

test('L329 merge-outcome.mjs: openTooLong counts a last write that is unreadable or 1 h ahead as old enough; prReadingAfter never takes a reading stamped ahead as fresh', async () => {
  const { openTooLong, prReadingAfter } = await import('./merge-outcome.mjs');
  const T0 = Date.parse('2026-11-03T08:00:00.000Z');
  const LIMIT = 30 * 60_000;
  const iso = (min) => new Date(T0 + min * 60_000).toISOString();
  assert.equal(openTooLong({ meta: () => ({ ts: iso(-1) }) }, 'M-1', T0, LIMIT), false, 'a fresh write is not too long');
  assert.equal(openTooLong({ meta: () => ({ ts: 'not a time' }) }, 'M-1', T0, LIMIT), true, 'unreadable');
  assert.equal(openTooLong({ meta: () => ({ ts: iso(60) }) }, 'M-1', T0, LIMIT), true, '1 h ahead');
  const recOfReading = (observed) => ({
    read: (e, id) => (e === 'fact' ? { id, rev: 1, doc: { state: 'open', merged: false, observed_at: observed } } : null),
    meta: (e) => (e === 'fact' ? { createdBy: 'sensors' } : { ts: iso(-1) }),
  });
  assert.ok(prReadingAfter(recOfReading(iso(0)), 7, 'M-1', T0), 'a reading after the write, not ahead of now, counts');
  assert.equal(prReadingAfter(recOfReading(iso(60)), 7, 'M-1', T0), null, 'a reading stamped 1 h ahead is not fresh');
  assert.equal(prReadingAfter(recOfReading('not a time'), 7, 'M-1', T0), null, 'an unreadable reading is not fresh');
});

// L379 n2 (L323): the told mark on an interrupted note, refused by the Record. The note was taken, so the owner has heard
// it, but nothing says so: the refusal is alerted, and the note goes out again until the mark is written.
test('L323 gate.mjs: a refused interrupted_told_at write is alerted, the note goes out again, and the next good write ends it', async () => {
  const w = world(limited());
  verifiedCard(w);
  loseAnswer(w, { merged: false });
  await gatePass(w.ctx);
  const rec = recOf(w);
  let refuse = true;
  w.ctx.record = Object.create(rec, { write: { value: (a) => (refuse && a.entity === 'merge' && a.doc?.interrupted_told_at ? { ok: false, reason: 'planted' } : rec.write(a)) } });
  const refused = () => told(w, 'merge_gate_write_refused').filter((a) => a.to === 'interrupted_told');
  tick(w, LIMIT_MIN); stayGreen(w); await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.ok(!mergeOf(w).doc.interrupted_told_at);
  assert.equal(told(w, 'merge_interrupted').length, 1);
  assert.equal(refused().length, 1);
  assert.equal(refused()[0].reason, 'planted');
  await later(w, 1);
  assert.equal(told(w, 'merge_interrupted').length, 2, 'not marked, so sent again');
  assert.equal(refused().length, 2);
  refuse = false;
  await later(w, 1);
  assert.equal(told(w, 'merge_interrupted').length, 3);
  assert.ok(mergeOf(w).doc.interrupted_told_at);
  await later(w, 1);
  assert.equal(told(w, 'merge_interrupted').length, 3, 'marked, so told no more');
  assert.equal(refused().length, 2);
});

// L379 n3 (L356): the reading landed, but the write that ends the wait is refused. The Record still says it waits, so
// the merge steps aside: no merge call on that pass. The next pass clears it and goes on.
test('L356 gate.mjs: a refused clear of the landed reading steps aside with an alert and no merge call, and the next pass goes on', async () => {
  const w = world(limited());
  const head = verifiedCard(w);
  await interruptedThenAskedAgain(w, head);
  const again = () => recOf(w).list('merge').find((m) => m.doc.request === 'mr-C-1-again');
  await later(w, 1);
  assert.ok(again().doc.wait_reading, 'waits for the reading');
  const rec = recOf(w);
  let refuse = true;
  const clears = (a) => a.entity === 'merge' && a.doc?.wait_reading === null && !!rec.read('merge', a.id)?.doc?.wait_reading;
  w.ctx.record = Object.create(rec, { write: { value: (a) => (refuse && clears(a) ? { ok: false, reason: 'planted' } : rec.write(a)) } });
  sensorsReads(w, { state: 'open', merged: false, merge_commit_sha: null, head_sha: head, observed_at: nowIso(w, 1) });
  const before = again().doc;
  const puts = gatePuts(w);
  await later(w, 2);
  const refused = () => told(w, 'merge_gate_write_refused').filter((a) => a.to === 'wait_reading_cleared');
  assert.equal(refused().length, 1);
  assert.equal(refused()[0].reason, 'planted');
  assert.equal(again().doc.state, before.state, 'stepped aside');
  assert.equal(again().doc.wait_reading, before.wait_reading, 'the Record still says it waits');
  assert.equal(gatePuts(w), puts, 'no merge call from a record that still says it waits');
  refuse = false;
  await later(w, 1);
  assert.equal(again().doc.wait_reading ?? null, null, 'cleared on the next pass');
  assert.equal(gatePuts(w), puts + 1, 'and it went on');
  assert.equal(refused().length, 1);
});

// L583 (5): an M6 call with no alert wired answers "not told", so its caller tells the owner itself, never "told".
test('L583: markReverted, reconcileMerge and settleMerge with no alert wired: told false, nothing thrown', () => {
  const none = { read: () => null };
  assert.deepEqual(markReverted({ record: none }, 'card-9'), { ok: false, reason: 'not a merged undo card', told: false });
  const m = { id: 'merge-1', rev: 2, doc: { state: 'refused', reasons: ['interrupted'], pr: 7, judged_head: 'a'.repeat(40) } };
  const rec = { read: (e) => (e === 'merge' ? m : null) };
  const r = reconcileMerge({ record: rec, now: 0 }, 'merge-1', { pr: { merged: true, merge_commit_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) } });
  assert.equal(r.ok, false);
  assert.equal(r.told, false);
  // settleMerge: a refused write with no alert wired is answered, not thrown.
  const checking = { id: 'merge-2', rev: 1, doc: { state: 'checking', pr: 8, judged_head: 'a'.repeat(40) } };
  const refusing = { read: (e) => (e === 'merge' ? checking : null), write: () => ({ ok: false, reason: 'planted refusal' }) };
  assert.deepEqual(settleMerge({ record: refusing, now: 0 }, 'merge-2', { pr: { merged: true, merge_commit_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40) } }),
    { ok: false, reason: 'the move to merging was refused' });
});
