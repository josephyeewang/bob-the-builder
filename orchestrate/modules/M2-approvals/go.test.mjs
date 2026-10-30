// go.test.mjs — R-0b-52 / R-0b-53: a go binds one plan of one card; only risky classes, needs_joe or an unproven Tier-1
// module raise an Approve ask; at merge a change stays inside its go; a Tier-1 plan is re-checked when main moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, OWNER_ID, PRODUCT, must } from './fixtures.test-helper.mjs';
import { leadCard, product, put, roadmap } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { writeDoc, askStore } from './ask-store.mjs';
import { openDecision, readDecision } from './decision.mjs';
import { approveNeeded, doneBar, goCheck, raiseGo, recordGo, recordRecheck, rowFile, tier1Changed } from './go.mjs';

const MIN = 60_000;
const row = (id, over = {}) => ({ id, what: `row ${id}`, module: 'M1', tier: 2, done_when: `tests pass for ${id}`, status: 'planned', ...over });

function world(values = {}) {
  const t = env({ values });
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one', 'src/b.mjs': 'one', 'lib/deep/c.mjs': 'one', 'docs/other.md': 'x' });
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  return { t, g, view, M0 };
}

function card(w, id, over = {}, rows = { 'R-1': row('R-1') }) {
  leadCard(w.t, id, { done_when: doneBar(rows), files: ['src/a.mjs'], ...over });
  return rows;
}

// The owner's tap on a go_t2 box, as binding.mjs records it.
function tapGo(w, askId, choice = 'Go') {
  const a = askStore(w.t.record).ask(askId);
  must(writeDoc(w.t.record, 'ask', a, { ...a.doc, state: 'pushed', raised_at: new Date(w.t.clock.t).toISOString(), raised_reask: 0 }));
  const b = askStore(w.t.record).ask(askId);
  must(writeDoc(w.t.record, 'ask', b, { ...b.doc, state: 'answered', answer: { channel: 'tap', choice, approves: choice === 'Go', session_id: 'S-1', tool_use_id: 'toolu_1', at: new Date(w.t.clock.t).toISOString() } }));
}

async function goFor(w, id, rows) {
  const r = await raiseGo(w.t.ctx, { cardId: id, rows, view: w.view, mainSha: w.M0 });
  assert.equal(r.ok, true, r.reason);
  tapGo(w, r.id);
  const g = recordGo(w.t.ctx, r.id);
  assert.equal(g.ok, true, g.reason);
  return { ask: r.id, go: w.t.record.read('go', g.go).doc };
}

test('an Approve ask is raised only for risky classes, needs_joe, or Tier 1 on a module whose live check is unproven', () => {
  const rules = env({ values: { 'live_check.M2.proven_at': '2026-10-01' } }).ctx.rules;
  assert.equal(approveNeeded({ risky: ['secrets'], tier: 2, module: 'M1' }, rules, PRODUCT).needed, true);
  assert.equal(approveNeeded({ needsJoe: true, tier: 2, module: 'M1' }, rules, PRODUCT).needed, true);
  assert.equal(approveNeeded({ tier: 1, module: 'M1' }, rules, PRODUCT).needed, true, 'M1 unproven');
  assert.equal(approveNeeded({ tier: 1, module: 'M2' }, rules, PRODUCT).needed, false, 'M2 proven');
  assert.equal(approveNeeded({ tier: 2, module: 'M1' }, rules, PRODUCT).needed, false, 'a Tier-2 non-risky change raises no ask');
  assert.equal(approveNeeded({ tier: 1 }, rules, PRODUCT).needed, true, 'no module: unproven');
  assert.equal(approveNeeded({ risky: 'secrets', tier: 2 }, rules, PRODUCT).needed, true, 'an unreadable list fails closed');
});

test('a Tier-2 go: the tap ask carries the file list; the go record binds the plan; M9 lets the card reach ready', async () => {
  const w = world();
  const rows = card(w, 'A');
  const r = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  const a = askStore(w.t.record).ask(r.id).doc;
  assert.equal(a.kind, 'go_t2');
  assert.match(a.payload.questions[0].options[0].description, /src\/a\.mjs/, 'M2 renders the file list into the box itself');
  tapGo(w, r.id);
  const g = recordGo(w.t.ctx, r.id);
  assert.equal(g.ok, true, g.reason);
  const go = w.t.record.read('go', 'go-A').doc;
  assert.deepEqual([go.card_id, go.tier, go.files, go.done_bar, go.main_commit], ['A', 2, ['src/a.mjs'], ['tests pass for R-1'], null]);
  assert.equal(askStore(w.t.record).ask(r.id).doc.state, 'consumed');
  assert.deepEqual(recordGo(w.t.ctx, r.id), { ok: true, go: 'go-A', already: true }, 'recording twice is harmless');
  product(w.t);
  must(put(w.t.record, 'dispatcher', 'card', 'A', { state: 'ready' }), 'A ready');
});

test('"Change" or "Not now" is no go', async () => {
  const w = world();
  const rows = card(w, 'A');
  const r = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  tapGo(w, r.id, 'Not now');
  assert.equal(recordGo(w.t.ctx, r.id).ok, false);
  assert.equal(w.t.record.read('go', 'go-A'), null);
});

test('a go on A does not satisfy B, even with the same plan', async () => {
  const w = world();
  const rows = card(w, 'A');
  card(w, 'B');
  const { go } = await goFor(w, 'A', rows);
  product(w.t);
  assert.equal(put(w.t.record, 'dispatcher', 'card', 'B', { state: 'ready' }).ok, false, 'M9 finds no go for B');
  const b = { id: 'B', doc: w.t.record.read('card', 'B').doc };
  const c = await goCheck({ go, card: b, changed: [{ path: 'src/a.mjs', status: 'modified' }], headRows: { 'R-1': row('R-1') }, tier: 2, view: w.view, mainSha: w.M0 });
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(';'), /for A, not B/);
});

test('a plan changed after the go was asked needs a new go', async () => {
  const w = world();
  const rows = card(w, 'A');
  const r = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  tapGo(w, r.id);
  must(roadmap(w.t, { id: 'A', expectRev: w.t.record.read('card', 'A').rev, fields: { files: ['src/a.mjs', 'src/b.mjs'] } }), 'plan edit');
  const g = recordGo(w.t.ctx, r.id);
  assert.equal(g.ok, false);
  assert.match(g.reason, /new go/);
});

test('folder patterns, unsafe paths and folders in main are refused for the whole go', async () => {
  for (const files of [['src/*'], ['src/**'], ['src/'], ['../x.mjs'], ['/etc/x'], ['src'], ['lib/deep'], ['src/a.mjs', 'lib']]) {
    const w = world();
    const rows = card(w, 'A', { files });
    const r = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
    assert.equal(r.ok, false, files.join(','));
    assert.equal(askStore(w.t.record).asks().length, 0);
  }
});

test('the rows given must be the rows the card names, and its done_when their pass tests', async () => {
  const w = world();
  card(w, 'A');
  assert.equal((await raiseGo(w.t.ctx, { cardId: 'A', rows: { 'R-2': row('R-2') }, view: w.view, mainSha: w.M0 })).ok, false);
  assert.equal((await raiseGo(w.t.ctx, { cardId: 'A', rows: { 'R-1': row('R-1', { done_when: 'weaker' }) }, view: w.view, mainSha: w.M0 })).ok, false);
});

test('several rows: done_bar is their done_when texts sorted by row id, joined with ---', () => {
  assert.equal(doneBar({ 'R-2': row('R-2'), 'R-1': row('R-1') }), 'tests pass for R-1\n---\ntests pass for R-2');
});

async function merged(w, id = 'A', rows) {
  const { go } = await goFor(w, id, rows);
  const c = { id, doc: w.t.record.read('card', id).doc };
  return (changed, headRows, tier = 2) => goCheck({ go, card: c, changed, headRows, tier, view: w.view, mainSha: w.M0 });
}

test('at merge: inside the file list passes; a file outside it returns the card for a new go', async () => {
  const w = world();
  const check = await merged(w, 'A', card(w, 'A'));
  const ok = await check([{ path: 'src/a.mjs', status: 'modified' }], { 'R-1': row('R-1') });
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  const out = await check([{ path: 'src/a.mjs', status: 'modified' }, { path: 'src/b.mjs', status: 'modified' }], { 'R-1': row('R-1') });
  assert.deepEqual([out.ok, out.newGo], [false, true]);
  const moved = await check([{ path: 'src/a.mjs', previous_path: 'src/b.mjs', status: 'renamed' }], { 'R-1': row('R-1') });
  assert.equal(moved.ok, false, 'an old name outside the list counts too');
});

test('at merge: a change that loosens its own row\'s done_when is refused; one that only sets done: true passes', async () => {
  const w = world();
  const check = await merged(w, 'A', card(w, 'A'));
  const own = [{ path: 'src/a.mjs', status: 'modified' }, { path: rowFile('R-1'), status: 'modified' }];
  const done = await check(own, { 'R-1': row('R-1', { done: true, status: 'done', receipts: ['PR 9'] }) });
  assert.equal(done.ok, true, done.reasons.join('; '));
  for (const over of [{ done_when: 'it runs' }, { what: 'other' }, { tier: 1 }, { module: 'M3' }, { owner: 'someone' }]) {
    const r = await check(own, { 'R-1': row('R-1', over) });
    assert.equal(r.ok, false, JSON.stringify(over));
  }
  assert.equal((await check(own, { 'R-1': null })).ok, false, 'a row missing at the head');
  assert.equal((await check([...own, { path: rowFile('R-9'), status: 'added' }], { 'R-1': row('R-1'), 'R-9': row('R-9') })).ok, false, 'a row the go does not name');
  assert.equal((await check([{ path: rowFile('R-1'), status: 'removed' }], { 'R-1': row('R-1') })).ok, false, 'its own row removed');
});

test('at merge: a change M10 computes as Tier 1 is refused on a Tier-2 go', async () => {
  const w = world();
  const check = await merged(w, 'A', card(w, 'A'));
  assert.equal((await check([{ path: 'src/a.mjs', status: 'modified' }], { 'R-1': row('R-1') }, 1)).ok, false);
});

test('Tier 1: the go is a decision pull request; a listed file changed on main is re-checked; an unchanged plan needs no new go', async () => {
  const w = world();
  const plan = { tier: 1, plan_sha256: 'e'.repeat(64), main_commit: w.M0, files: ['src/a.mjs'] };
  const rows = card(w, 'T', plan, { 'R-1': row('R-1', { tier: 1 }) });
  const r = await raiseGo(w.t.ctx, { cardId: 'T', rows, view: w.view, mainSha: w.M0 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(askStore(w.t.record).ask(r.id).doc.kind, 'go_t1');
  const { pr } = await openDecision(w.t.ctx, r.id);
  const file = JSON.parse(w.g.repo.files(w.g.pulls.get(pr).head).get('decisions/go-T.json').text);
  assert.equal(file.plan.plan_sha256, 'e'.repeat(64), 'the committed file holds the plan the fingerprint binds');
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: w.t.clock.t + MIN });
  assert.equal((await readDecision(w.t.ctx, r.id)).counted, true);
  assert.equal(recordGo(w.t.ctx, r.id).ok, true);
  assert.equal(w.t.record.read('go', 'go-T').doc.main_commit, w.M0);

  const M1 = w.g.repo.commit([w.M0], { 'docs/other.md': 'y' }, { from: w.M0 });
  assert.deepEqual((await tier1Changed(w.t.ctx, { cardId: 'T', view: w.view, mainTip: M1 })).changed, [], 'an unlisted file needs no re-check');
  const M2 = w.g.repo.commit([M1], { 'src/a.mjs': 'two' }, { from: M1 });
  assert.deepEqual((await tier1Changed(w.t.ctx, { cardId: 'T', view: w.view, mainTip: M2 })).changed, ['src/a.mjs']);
  assert.deepEqual(recordRecheck(w.t.ctx, { cardId: 'T', mainCommit: M2, planSha256: 'e'.repeat(64), files: ['src/a.mjs'] }), { ok: true, newGo: false });
  assert.deepEqual((await tier1Changed(w.t.ctx, { cardId: 'T', view: w.view, mainTip: M2 })).changed, [], 'compared from the newest re-check');
  assert.equal(w.t.record.read('go', 'go-T').doc.plan_fingerprint, askStore(w.t.record).ask(r.id).doc.fingerprint, 'the go keeps its fingerprint');
  assert.deepEqual(recordRecheck(w.t.ctx, { cardId: 'T', mainCommit: M2, planSha256: 'd'.repeat(64), files: ['src/a.mjs'] }), { ok: true, newGo: true });
  assert.deepEqual(recordRecheck(w.t.ctx, { cardId: 'T', mainCommit: M2, planSha256: 'e'.repeat(64), files: ['src/a.mjs', 'src/b.mjs'] }), { ok: true, newGo: true });
});

test('a go is asked once per plan', async () => {
  const w = world();
  const rows = card(w, 'A');
  const r = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  assert.equal(r.ok, true);
  assert.equal((await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 })).existing, true);
  assert.equal(askStore(w.t.record).asks().length, 1);
});

test('after "Not now" the same plan can be asked again under a new id; a live or used ask is not re-raised (audit round 1 M-3)', async () => {
  const w = world();
  const rows = card(w, 'A');
  const r1 = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  assert.equal((await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 })).existing, true, 'still open');
  tapGo(w, r1.id, 'Not now');
  const r2 = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.existing, undefined);
  assert.equal(r2.id, `${r1.id}-2`);
  tapGo(w, r2.id);
  assert.equal(recordGo(w.t.ctx, r2.id).ok, true);
  const r3 = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  assert.deepEqual([r3.id, r3.existing], [r2.id, true], 'a used go is not asked again');
});

test('at merge: a go whose fingerprint is not the card\'s plan is refused, even on the same card', async () => {
  const w = world();
  const rows = card(w, 'A');
  const { go } = await goFor(w, 'A', rows);
  const c = { id: 'A', doc: w.t.record.read('card', 'A').doc };
  const r = await goCheck({ go: { ...go, plan_fingerprint: '0'.repeat(64) }, card: c, changed: [{ path: 'src/a.mjs', status: 'modified' }], headRows: { 'R-1': row('R-1') }, tier: 2, view: w.view, mainSha: w.M0 });
  assert.equal(r.ok, false);
});

test('a plan A → B → A gets a go again; a withdrawn or expired go ask is asked again (audit round 2 MAT-1, m-3)', async () => {
  const w = world();
  const rows = card(w, 'A');
  const plan = (files) => must(roadmap(w.t, { id: 'A', expectRev: w.t.record.read('card', 'A').rev, fields: { files } }), 'plan edit');
  const a1 = (await goFor(w, 'A', rows)).ask;
  plan(['src/a.mjs', 'src/b.mjs']);
  await goFor(w, 'A', rows);
  plan(['src/a.mjs']);
  const again = await raiseGo(w.t.ctx, { cardId: 'A', rows, view: w.view, mainSha: w.M0 });
  assert.equal(again.ok, true, again.reason);
  assert.deepEqual([again.id, again.existing], [`${a1}-2`, undefined]);
  tapGo(w, again.id);
  assert.equal(recordGo(w.t.ctx, again.id).ok, true);
  assert.equal(w.t.record.read('go', 'go-A').doc.ask, again.id);
  for (const state of ['withdrawn', 'expired']) {
    const v = world();
    const r = card(v, 'K');
    const first = await raiseGo(v.t.ctx, { cardId: 'K', rows: r, view: v.view, mainSha: v.M0 });
    let cur = askStore(v.t.record).ask(first.id);
    if (state === 'expired') {
      must(writeDoc(v.t.record, 'ask', cur, { ...cur.doc, state: 'pushed', raised_at: new Date(v.t.clock.t).toISOString(), raised_reask: 0 }), 'push');
      cur = askStore(v.t.record).ask(first.id);
      must(writeDoc(v.t.record, 'ask', cur, { ...cur.doc, state: 'open', reask_count: 1, lapsed_at: new Date(v.t.clock.t).toISOString() }), 'lapse');
      cur = askStore(v.t.record).ask(first.id);
    }
    must(writeDoc(v.t.record, 'ask', cur, { ...cur.doc, state }), state);
    const next = await raiseGo(v.t.ctx, { cardId: 'K', rows: r, view: v.view, mainSha: v.M0 });
    assert.deepEqual([next.id, next.existing], [`${first.id}-2`, undefined], state);
  }
});
