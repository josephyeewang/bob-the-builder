// carry-over.test.mjs — 0b-9 M7, 0b-5 M3, 0b-1 R2-M9: a review carries over a catch-up merge only when the change's
// own files are identical and the catch-up touched none of them. Run:
// node --test orchestrate/modules/M10-rules/carry-over.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryOver } from './carry-over.mjs';
import { makeGitView } from './git-view.mjs';
import { fakeRepo } from './fixtures/fake-repo.mjs';

// main: m0. The change branches from m0 (H0 edits docs/guide.md). Main then moves on (m1); the robot merges main
// into the branch (H1 = catch-up). Each test picks what m1 changes.
function world(mainEdit, { changeEdit = { 'docs/guide.md': 'new guide' }, from } = {}) {
  const r = fakeRepo();
  const m0 = r.commit([], { 'docs/guide.md': 'guide', 'docs/other.md': 'other', 'lib/x.ts': 'x', 'run.sh': 'echo' });
  const H0 = r.commit([m0], changeEdit);
  const m1 = r.commit([m0], mainEdit);
  // The catch-up merge: branch tree = H0's change applied over m1 (or a given resolution).
  const H1 = r.commit([H0, m1], from ?? { ...mainEdit, ...changeEdit }, { from: m1 });
  r.main = m1;
  const gh = makeGitView({ gh: r.gh, owner: 'sample-org', repo: 'sample-app' });
  const args = { reviewed: { base: m0, head: H0 }, current: { base: m1, head: H1 }, between: [H1],
    catchUps: [{ pr: 7, before_sha: H0, after_sha: H1 }], tier1MergesSince: 0, gh };
  return { r, m0, m1, H0, H1, gh, args };
}

test('an edit to another file on main carries over (review and audit)', async () => {
  const w = world({ 'docs/other.md': 'other, edited' });
  assert.deepEqual(await carryOver(w.args), { review: true, audit: true, reasons: [] });
});

test('an edit to the same file on main does not carry over', async () => {
  const w = world({ 'docs/guide.md': 'guide, edited above the hunk' }, { from: { 'docs/guide.md': 'new guide' } });
  const r = await carryOver(w.args);
  assert.equal(r.review, false);
  assert.match(r.reasons.join(), /main changed docs\/guide\.md/);
});

test('a rename carries over when main left both names alone, and not when main touched the old name', async () => {
  const rename = { 'docs/guide.md': null, 'docs/handbook.md': 'guide' };
  const ok = world({ 'lib/x.ts': 'x2' }, { changeEdit: rename });
  assert.equal((await carryOver(ok.args)).review, true);
  const bad = world({ 'docs/guide.md': 'guide, edited' }, { changeEdit: rename, from: { 'lib/x.ts': 'x', ...rename } });
  const r = await carryOver(bad.args);
  assert.equal(r.review, false);
  assert.match(r.reasons.join(), /docs\/guide\.md/);
});

test('a mode-only change counts: main changing the mode of a changed file blocks; the change own mode must match', async () => {
  const exec = { 'run.sh': { text: 'echo', mode: '100755' } };
  const w = world({ 'docs/other.md': 'o2' }, { changeEdit: exec });
  assert.equal((await carryOver(w.args)).review, true);
  // The catch-up quietly dropped the change's mode flip: own diff no longer identical.
  const lost = world({ 'docs/other.md': 'o2' }, { changeEdit: exec, from: { 'docs/other.md': 'o2' } });
  const r = await carryOver(lost.args);
  assert.equal(r.review, false);
  assert.match(r.reasons.join(), /different files|run\.sh differs/);
});

test('a catch-up merge that auto-resolved a conflict in one of the change files does not carry over', async () => {
  // Main edits the same file; the merge resolved it to the change's own text, so H1's file equals H0's. Still refused:
  // the version at the base moved, so what Joe read sat on a different base.
  const w = world({ 'docs/guide.md': 'guide v2' }, { from: { 'docs/guide.md': 'new guide' } });
  const r = await carryOver(w.args);
  assert.equal(r.review, false);
  assert.match(r.reasons.join(), /docs\/guide\.md differs between the reviewed and current base|main changed docs\/guide\.md/);
});

test('a push that is not a recorded catch-up is refused, even with an identical diff', async () => {
  const w = world({ 'docs/other.md': 'other, edited' });
  assert.match((await carryOver({ ...w.args, catchUps: [] })).reasons.join(), /not a recorded catch-up/);
  // Someone else's commit with the same tree as the catch-up, pushed instead of it.
  const fake = w.r.commit([w.H0, w.m1], { 'docs/other.md': 'other, edited', 'docs/guide.md': 'new guide' }, { from: w.m1 });
  assert.match((await carryOver({ ...w.args, current: { base: w.m1, head: fake }, between: [fake] })).reasons.join(), /not a recorded catch-up/);
  // A catch-up record whose commit is not a merge onto the reviewed head.
  const single = w.r.commit([w.H0], { 'docs/other.md': 'other, edited' });
  assert.match((await carryOver({ ...w.args, current: { base: w.m1, head: single }, between: [single],
    catchUps: [{ pr: 7, before_sha: w.H0, after_sha: single }] })).reasons.join(), /not a merge onto/);
  assert.match((await carryOver({ ...w.args, between: [] })).reasons.join(), /do not end at the current head/);
  // A recorded catch-up whose FIRST parent is main, not the reviewed head (audit round 2).
  const flipped = w.r.commit([w.m1, w.H0], { 'docs/other.md': 'other, edited', 'docs/guide.md': 'new guide' }, { from: w.m1 });
  assert.match((await carryOver({ ...w.args, current: { base: w.m1, head: flipped }, between: [flipped],
    catchUps: [{ pr: 7, before_sha: w.H0, after_sha: flipped }] })).reasons.join(), /not a merge onto/);
});

test('the audit carries over only with no computed Tier-1 merge since; anything unknown means no', async () => {
  const w = world({ 'docs/other.md': 'o2' });
  assert.deepEqual(await carryOver({ ...w.args, tier1MergesSince: 1 }), { review: true, audit: false, reasons: ['1 Tier-1 merge(s) landed since the audit'] });
  assert.equal((await carryOver({ ...w.args, tier1MergesSince: undefined })).audit, false);
  assert.equal((await carryOver({ ...w.args, tier1MergesSince: '0' })).audit, false);
});

test('no catch-up at all: the same head carries over; errors and bad input never do', async () => {
  const w = world({ 'docs/other.md': 'o2' });
  const same = { ...w.args, current: { base: w.m0, head: w.H0 }, between: [] };
  assert.equal((await carryOver(same)).review, true);
  assert.equal((await carryOver({ ...same, between: [w.H1] })).review, false);
  assert.equal((await carryOver({ ...w.args, reviewed: { base: 'abc', head: w.H0 } })).review, false);
  assert.equal((await carryOver({ ...w.args, gh: null })).review, false);
  assert.equal((await carryOver()).review, false);
  w.r.down = true;
  assert.match((await carryOver(w.args)).reasons.join(), /could not check/);
});

// The rules overlap on real repositories (a base change usually shows in both the base check and the catch-up check),
// so each rule is also proven alone, on a scripted view where every other rule passes.
const S = (c) => c.repeat(40);
const [B0, H0, B1, H1] = [S('a'), S('b'), S('c'), S('d')];
function scripted({ d0, d1, main = [], entries = {}, parents = [H0, S('e')] }) {
  const e = { blob: S('f'), mode: '100644' };
  return {
    files: async (b, h) => (b === B0 && h === H0 ? d0 : b === B1 && h === H1 ? d1 : b === B0 && h === B1 ? main : null),
    entry: async (sha, p) => (Object.hasOwn(entries, `${sha}:${p}`) ? entries[`${sha}:${p}`] : e),
    commit: async () => ({ parents }),
  };
}
const base = (gh) => ({ reviewed: { base: B0, head: H0 }, current: { base: B1, head: H1 }, between: [H1],
  catchUps: [{ pr: 7, before_sha: H0, after_sha: H1 }], tier1MergesSince: 0, gh });
const edit = [{ path: 'docs/g.md', status: 'modified' }];

test('a base given as the head itself (an empty change) never carries over (audit minor 3)', async () => {
  const w = world({ 'docs/other.md': 'o2' });
  const r = await carryOver({ ...w.args, reviewed: { base: w.H0, head: w.H0 }, current: { base: w.H1, head: w.H1 } });
  assert.equal(r.review, false);
  assert.match(r.reasons.join(), /no files/);
});

test('each rule alone: the scripted baseline carries over', async () => {
  assert.equal((await carryOver(base(scripted({ d0: edit, d1: edit })))).review, true);
});

test('each rule alone: a different file list, rename or status', async () => {
  const r = await carryOver(base(scripted({ d0: edit, d1: [{ path: 'docs/g.md', status: 'added' }] })));
  assert.match(r.reasons.join(), /different files/);
  const ren = await carryOver(base(scripted({ d0: [{ path: 'b.md', previous_path: 'a.md', status: 'renamed' }], d1: [{ path: 'b.md', previous_path: 'c.md', status: 'renamed' }] })));
  assert.match(ren.reasons.join(), /different files/);
});

test('each rule alone: the head version differs (a catch-up rewrote the change)', async () => {
  const r = await carryOver(base(scripted({ d0: edit, d1: edit, entries: { [`${H1}:docs/g.md`]: { blob: S('9'), mode: '100644' } } })));
  assert.deepEqual(r.reasons, ['docs/g.md differs between the reviewed and current head']);
  const mode = await carryOver(base(scripted({ d0: edit, d1: edit, entries: { [`${H1}:docs/g.md`]: { blob: S('f'), mode: '100755' } } })));
  assert.deepEqual(mode.reasons, ['docs/g.md differs between the reviewed and current head'], 'a mode-only difference counts');
});

test('each rule alone: the base version differs', async () => {
  const r = await carryOver(base(scripted({ d0: edit, d1: edit, entries: { [`${B1}:docs/g.md`]: null } })));
  assert.deepEqual(r.reasons, ['docs/g.md differs between the reviewed and current base']);
});

test('each rule alone: main renamed away one of the change files (old name counts)', async () => {
  const r = await carryOver(base(scripted({ d0: edit, d1: edit, main: [{ path: 'docs/moved.md', previous_path: 'docs/g.md', status: 'renamed' }] })));
  assert.deepEqual(r.reasons, ['main changed docs/g.md since the review']);
});

test('each rule alone: a catch-up record that does not chain from the reviewed head', async () => {
  const gh = scripted({ d0: edit, d1: edit });
  const r = await carryOver({ ...base(gh), catchUps: [{ pr: 7, before_sha: S('0'), after_sha: H1 }] });
  assert.match(r.reasons.join(), /does not follow/);
});
