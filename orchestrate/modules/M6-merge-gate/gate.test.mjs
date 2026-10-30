// gate.test.mjs — the Merge Gate's pass against a real M9 record (every write through the writer) and a fake GitHub:
// a clean card merges through the paired write and is marked; the outside check shut stops everything; a red check,
// a GitHub refusal and a stopped pass each end where they should; behind main catches up; the queue order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, product, leadCard, runCard, outboxFile, put, must, plan, PRODUCT, fingerprintFor, fullTimeouts } from '../M9-record/fixtures.test-helper.mjs';
import { fakeRules, allow, deny, makeRules } from '../../shared/rules.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { fakeGateGitHub } from './fixtures/fake-gate-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { blobSha } from '../M10-rules/reader.mjs';
import { ROBOT_FACT, NO_PUSH_FACT } from '../M12-sensors/outside-watch.mjs';
import { gatePass, queueOrder, NOT_GREEN_LINE } from './gate.mjs';
import { readMark } from './mark.mjs';
import { readNeedsJoe } from './checker-entry.mjs';
import { gatherFacts } from './gather.mjs';

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
    'approvals.plan_go.go_free': ['lead_daily_card', 'exact_reverse'],
    'product.cutover_stage': 'second',
    'product_profile.required_checks': ['test'],
    'product_profile.robot': { bot_user_id: g.robotId },
    effect_paths: { first_customer_visible: { new_files_under: ['app/pages'] } },
    'rules.adopted': { blob: blobSha(Buffer.from(POLICY)) },
    ...values,
  };
  const rules = fakeRules({ values: vals, answers: { merge: mergeAnswer ?? allow('in lane') } });
  const facts = new Map([[ROBOT_FACT(PRODUCT), { product: PRODUCT, green: true, red_since: null, last_green_at: new Date(env.clock.t).toISOString() }],
    [NO_PUSH_FACT, { green: true, at: new Date(env.clock.t).toISOString() }]]);
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const alerts = [];
  const ctx = { record: env.record, rules, product: PRODUCT, gh: g.gh, owner: 'sample-org', repo: 'sample-app', view, now: () => env.clock.t, alert: (a) => alerts.push(a), readFact: (id) => facts.get(id) ?? null };
  return { env, g, ctx, facts, alerts, root, values: vals };
}

// A card built, reviewed by a launched reviewer through the review outbox, verified, and asked to merge as pull #7.
function verifiedCard(w, id = 'C-1', { pr = 7, files = { 'src/a.mjs': 'two' }, undo, request = true } = {}) {
  const { env, g } = w;
  if (undo) {
    // The Dispatcher's undo card, from an authenticated audit issue (lane 2 makes it; here it is made the same way).
    must(env.record.write({ actor: 'sensors', entity: 'fact', id: `issue-${id}`, expectRev: 0, doc: { type: 'undo_issue', authenticated: true, commit: undo } }), 'issue');
    must(env.record.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'exact_reverse', source: { fact: `issue-${id}` }, ...plan({ files: Object.keys(files) }) } }), 'undo card');
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
  must(env.record.write({ actor: 'dispatcher', entity: 'launch', id: `launch-${sid}`, expectRev: 0, doc: { session_id: sid, role: 'reviewer', card: id, head, rev: 1, launched_at: new Date(env.clock.t).toISOString() } }), 'launch');
  const hdr = `${JSON.stringify({ entity: 'verdict', card: id, expectRev: env.record.read('card', id).rev, fields: { head, pass: true, checklist: CLEAN, material: 0 } })}\n`;
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: sid, card: id }, outboxFile(env, 'reviewer', sid, `verdict-${id}.md`, hdr)), 'verdict');
  must(put(env.record, 'dispatcher', 'card', id, { state: 'verified' }), 'verified');
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
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'audit_flagged');
});

test('the undo route: a flagged merge\'s exact reverse goes first, merges with no Approve, and the undone card is reverted', async () => {
  const w = world();
  verifiedCard(w);
  await gatePass(w.ctx);
  const flagged = mergeOf(w).doc.merge_commit;
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-1', expectRev: 0, doc: { type: 'audit_run', commit: flagged, conclusion: 'failure' } }), 'fact');
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

test('a pass stopped after GitHub merged: the next pass finishes the merge from what GitHub says', async () => {
  const w = world();
  verifiedCard(w);
  // GitHub merges, but its answer is lost.
  w.g.answer.merge = (pr, body) => { w.g.answer.merge = null; return null; };
  const realPut = w.g.gh.put;
  w.g.gh.put = async (p, b) => { const r = await realPut(p, b); if (p.endsWith('/merge')) throw new Error('connection reset'); return r; };
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'merged');
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'merged');
});

test('a merge left in merging by a stopped pass, not merged on GitHub: refused, card back to verified', async () => {
  const w = world();
  verifiedCard(w);
  w.g.gh.put = async () => { throw new Error('stopped'); };
  w.g.down = false;
  // First pass: GitHub can't be reached for the merge; it reads the pull request, sees it open, and refuses.
  await gatePass(w.ctx);
  assert.equal(mergeOf(w).doc.state, 'refused');
  assert.equal(w.env.record.read('card', 'C-1').doc.state, 'verified');
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
  must(w.env.record.write({ actor: 'sensors', entity: 'fact', id: 'run-1', expectRev: 0, doc: { type: 'audit_run', commit: m.doc.merge_commit, conclusion: 'failure' } }), 'fact');
  w.g.answer.status = null;
  await gatePass(w.ctx);
  const after = mergeOf(w);
  assert.equal(after.doc.state, 'audit_flagged');
  assert.ok(after.doc.marked_at);
  assert.ok(w.alerts.some((a) => a.type === 'merge_marked_after_audit'));
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
