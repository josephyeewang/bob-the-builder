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
import { gatePass, queueOrder, NOT_GREEN_LINE, MERGE_LIMIT_TOLD_FACT } from './gate.mjs';
import { readMark } from './mark.mjs';
import { readNeedsJoe } from './checker-entry.mjs';
import { gatherFacts } from './gather.mjs';
import { timeLimits, requestMerges } from '../M11-dispatcher/merges.mjs';
import { MERGED_OUTSIDE, MERGED_OUTSIDE_UNTOLD } from './merge-outcome.mjs';

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
function realRules(w, { deep }) {
  const policy = parsePolicy(readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8'));
  assert.ok(policy.ok, policy.reason);
  const eng = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => ({ status: 'ok', policy: policy.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, '../M10-rules/roles'), clock: () => w.env.clock.t, deepMerge: deep }));
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
  ['thrown', () => { throw new Error('queue gone'); }, MERGED_OUTSIDE_UNTOLD]]) {
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
    w.ctx.alert = (a) => { asked += 1; w.alerts.push(a); return answer(); };
    tick(w, 1);
    await gatePass(w.ctx);
    const m = mergeOf(w);
    assert.equal(m.doc.state, 'refused');
    assert.deepEqual(m.doc.reasons, [want]);
    assert.equal(asked, 1);
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
    must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
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

test('L65: with no review launches folder set, the gate refuses (5) and says why, never reading the Record', async () => {
  const w = world();
  verifiedCard(w);
  delete w.ctx.reviewLaunches;
  await gatePass(w.ctx);
  const m = mergeOf(w);
  assert.notEqual(m.doc.state, 'merged');
  assert.ok(m.doc.reasons.some((x) => x.startsWith('5:') && /records could not be read: the gate has no review launches folder set/.test(x)), m.doc.reasons.join(' | '));
  // A folder that fails M9's check refuses the same way.
  const w2 = world();
  verifiedCard(w2);
  w2.ctx.reviewLaunches = { root: w2.env.launchRoot, uids: { ...w2.env.reviewUids, worker: w2.env.reviewUids.reviewer } };
  await gatePass(w2.ctx);
  const m2 = mergeOf(w2);
  assert.ok(m2.doc.reasons.some((x) => x.startsWith('5:') && /shared with worker/.test(x)), m2.doc.reasons.join(' | '));
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
test('L69 planted: a reviewer not ended blocks; one that ended with no verdict is refused (5); Joe\'s set-aside has no say', async () => {
  const w = world();
  const head = verifiedCard(w);
  secondReviewer(w, head, 'R-quiet', { ended: false });
  await gatePass(w.ctx);
  refusal5(w, /R-quiet has not ended yet/);
  // A passing file from a session not yet ended blocks the same way.
  const w1 = world();
  const head1 = verifiedCard(w1);
  secondReviewer(w1, head1, 'R-early', { pass: true, ended: false });
  await gatePass(w1.ctx);
  refusal5(w1, /R-early has not ended yet/);
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
  // This card's own bad record refuses it.
  const w2 = world();
  verifiedCard(w2);
  writeFileSync(join(w2.env.launchRoot, 'R-z.json'), JSON.stringify({ session_id: 'R-z', card: 'C-1', head: 'e'.repeat(40) }), { mode: 0o644 });
  await gatePass(w2.ctx);
  refusal5(w2, /the launch record R-z\.json of card C-1 fails its checks, so no review of this card can be counted \(the launch record names no review role\)/);
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

// The refusal here is about the change (a red check), so not asking again is right. A temporary refusal (checks or
// threads unreadable, mergeable unknown, main red) currently stalls the same way and is never retried. Known gap,
// fixed under LEAD-CALLS L164 before the first cutover; no test pins that stall.
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
