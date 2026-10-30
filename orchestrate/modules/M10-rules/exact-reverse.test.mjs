// exact-reverse.test.mjs — 0b-9 M4 / 0b-1 R3-M3: an undo is recognised only by recomputing the files, never by who
// opened it. Run: node --test orchestrate/modules/M10-rules/exact-reverse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExactReverse } from './exact-reverse.mjs';
import { makeGitView } from './git-view.mjs';
import { fakeRepo } from './fixtures/fake-repo.mjs';

// main: root → flagged change (edits a, renames b→c, makes run.sh executable) → an unrelated later change.
function world() {
  const r = fakeRepo();
  const root = r.commit([], { 'app/a.ts': 'one', 'app/b.ts': 'bee', 'run.sh': 'echo', 'docs/x.md': 'x' });
  const flagged = r.commit([root], { 'app/a.ts': 'two', 'app/b.ts': null, 'app/c.ts': 'bee', 'run.sh': { text: 'echo', mode: '100755' } });
  const later = r.commit([flagged], { 'docs/x.md': 'x2' });
  r.main = later;
  const view = makeGitView({ gh: r.gh, owner: 'sample-org', repo: 'sample-app' });
  const undoFiles = { 'app/a.ts': 'one', 'app/c.ts': null, 'app/b.ts': 'bee', 'run.sh': { text: 'echo', mode: '100644' } };
  return { r, root, flagged, later, view, undoFiles };
}
const check = (w, merged, reverses = w.flagged) => checkExactReverse({ view: w.view, reverses, merged });

test('the exact reverse of a flagged commit is recognised (edit, rename and mode change all put back)', async () => {
  const w = world();
  const undo = w.r.commit([w.later], w.undoFiles);
  assert.deepEqual(await check(w, undo), { ok: true, reasons: [] });
  // The same reverse landed as a merge commit (second parent = the robot's branch) is recognised too.
  const branch = w.r.commit([w.later], w.undoFiles);
  const viaMerge = w.r.commit([w.later, branch], w.undoFiles);
  assert.equal((await check(w, viaMerge)).ok, true);
});

test('a reverse that also touches another file is not exact', async () => {
  const w = world();
  const undo = w.r.commit([w.later], { ...w.undoFiles, 'docs/x.md': 'sneaked in' });
  const r = await check(w, undo);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /touches docs\/x\.md/);
});

test('a partial reverse, a wrong version or a missed mode change is not exact', async () => {
  const w = world();
  const { 'run.sh': _mode, ...noMode } = w.undoFiles;
  assert.match((await check(w, w.r.commit([w.later], noMode))).reasons.join(), /run\.sh is not back/);
  assert.match((await check(w, w.r.commit([w.later], { ...w.undoFiles, 'app/a.ts': 'three' }))).reasons.join(), /app\/a\.ts is not back/);
  assert.match((await check(w, w.r.commit([w.later], { ...w.undoFiles, 'app/c.ts': 'bee' }))).reasons.join(), /app\/c\.ts is not back/);
});

test('if a path changed again after the flagged commit, the "undo" would wipe later work: not exact', async () => {
  const w = world();
  const again = w.r.commit([w.later], { 'app/a.ts': 'two-and-a-half' });
  const undo = w.r.commit([again], w.undoFiles);
  assert.match((await check(w, undo)).reasons.join(), /app\/a\.ts changed again/);
});

test('the flagged commit must be on main before the merge; ids must be full; any read error means no', async () => {
  const w = world();
  const side = w.r.commit([w.root], { 'app/a.ts': 'side' });
  const undo = w.r.commit([w.later], w.undoFiles);
  assert.match((await check(w, undo, side)).reasons.join(), /not on main/);
  assert.match((await check(w, undo, 'abc123')).reasons.join(), /full commit ids/);
  assert.match((await check(w, w.flagged, w.flagged)).reasons.join(), /cannot reverse itself/);
  assert.match((await check(w, undo, w.root)).reasons.join(), /no parent/);
  w.r.down = true;
  assert.match((await check(w, undo)).reasons.join(), /could not check: network down/);
});

test('a cut-off file list or tree is refused, not trusted', async () => {
  const w = world();
  const undo = w.r.commit([w.later], w.undoFiles);
  w.r.override = (p) => (p.includes('/git/trees/') ? { status: 200, json: { tree: [], truncated: true } } : null);
  assert.match((await check(w, undo)).reasons.join(), /cut off/);
  const many = { status: 'ahead', merge_base_commit: { sha: w.root }, files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'added' })) };
  w.r.override = (p) => (p.includes('/compare/') ? { status: 200, json: many } : null);
  assert.match((await check(w, undo)).reasons.join(), /cuts the list at 300/);
  w.r.override = (p) => (p.includes('/compare/') ? { status: 200, json: { ...many, files: [{ filename: 'a', status: 'mystery' }] } } : null);
  assert.match((await check(w, undo)).reasons.join(), /odd file/);
});
