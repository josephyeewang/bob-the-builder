// workflow-route.test.mjs — only the exact approved workflow change may be pushed (R-0b-91, fingerprint part). Run:
// node --test orchestrate/modules/M6-merge-gate/workflow-route.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRepo } from '../M10-rules/fixtures/fake-repo.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { workflowFingerprint, fingerprintOfBranch, checkRoutePush, decisionBody } from './workflow-route.mjs';

const CI = '.github/workflows/ci.yml';
const OLD = '.github/workflows/old.yml';
const ciNew = 'name: ci\non: pull_request\npermissions: read-all\njobs: {}\n';

// A base, and the approved decision branch: ci.yml changed, old.yml deleted.
function setup() {
  const r = fakeRepo();
  const base = r.commit([], { [CI]: 'name: ci\n', [OLD]: 'name: old\n', 'src/app.mjs': 'x' });
  const decision = r.commit([base], { [CI]: ciNew, [OLD]: null });
  const view = makeGitView({ gh: r.gh, owner: 'sample-org', repo: 'sample-app' });
  return { r, base, decision, view };
}
const B = (c) => c.repeat(40);

test('workflowFingerprint: the same files in any order give the same fingerprint; odd lists are refused', () => {
  const a = { path: CI, mode: '100644', blob: B('a') };
  const b = { path: '.github/workflows/b.yml', mode: '100755', blob: B('b') };
  const one = workflowFingerprint({ changed: [a, b], deleted: [OLD, '.github/x.yml'] });
  const two = workflowFingerprint({ changed: [b, a], deleted: ['.github/x.yml', OLD] });
  assert.equal(one.ok, true);
  assert.match(one.sha256, /^[0-9a-f]{64}$/);
  assert.equal(one.sha256, two.sha256);
  assert.notEqual(workflowFingerprint({ changed: [a], deleted: [] }).sha256, workflowFingerprint({ changed: [{ ...a, mode: '100755' }], deleted: [] }).sha256);
  const bad = [
    { changed: [a, a], deleted: [] }, { changed: [a], deleted: [CI] }, { changed: [{ ...a, blob: 'abc' }], deleted: [] },
    { changed: [{ ...a, mode: '160000' }], deleted: [] }, { changed: [{ ...a, mode: '644' }], deleted: [] }, { changed: [], deleted: [] },
    { changed: [{ ...a, path: '../x' }], deleted: [] }, { changed: null, deleted: [] }, { changed: [], deleted: [OLD, OLD] },
  ];
  for (const x of bad) assert.equal(workflowFingerprint(x).ok, false, JSON.stringify(x));
  assert.equal(workflowFingerprint().ok, false);
});

test('fingerprintOfBranch: changed files with their head blob and mode, deletions counted', async () => {
  const { base, decision, view } = setup();
  const fp = await fingerprintOfBranch({ view, base, head: decision });
  assert.equal(fp.ok, true);
  assert.deepEqual(fp.deleted, [OLD]);
  assert.deepEqual(fp.changed.map((c) => [c.path, c.mode]), [[CI, '100644']]);
  // The deletion is part of the fingerprint: the same change without it differs.
  const withoutDelete = workflowFingerprint({ changed: fp.changed, deleted: [] });
  assert.notEqual(withoutDelete.sha256, fp.sha256);
});

test('the same result from a differently made branch (another patch, other commits) passes', async () => {
  const { r, base, decision, view } = setup();
  const approved = await fingerprintOfBranch({ view, base, head: decision });
  // Two commits, an intermediate version of ci.yml on the way: the patch text differs, the result doesn't.
  const step1 = r.commit([base], { [CI]: 'name: ci\n# draft\n' });
  const pushed = r.commit([step1], { [CI]: ciNew, [OLD]: null });
  assert.equal((await fingerprintOfBranch({ view, base, head: pushed })).sha256, approved.sha256);
  assert.deepEqual(await checkRoutePush({ view, base, head: pushed, approvedSha256: approved.sha256, approvedPaths: [CI, OLD] }), { ok: true });
});

test('a pushed branch that differs from the approval is refused: extra path, other blob, mode change, non-.github path', async () => {
  const { r, base, decision, view } = setup();
  const approved = (await fingerprintOfBranch({ view, base, head: decision })).sha256;
  const push = (files) => checkRoutePush({ view, base, head: r.commit([base], { [CI]: ciNew, [OLD]: null, ...files }), approvedSha256: approved, approvedPaths: [CI, OLD] });

  const extra = await push({ '.github/workflows/extra.yml': 'name: extra\n' });
  assert.equal(extra.ok, false);
  assert.match(extra.reason, /extra\.yml was not in the approved change/);

  const otherBlob = await push({ [CI]: `${ciNew}# one more line\n` });
  assert.equal(otherBlob.ok, false);
  assert.match(otherBlob.reason, /differs from the approved fingerprint/);

  const modeChange = await push({ [CI]: { text: ciNew, mode: '100755' } });
  assert.equal(modeChange.ok, false);
  assert.match(modeChange.reason, /differs from the approved fingerprint/);

  const outside = await push({ 'src/app.mjs': 'y' });
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /src\/app\.mjs is outside \.github\//);

  // Leaving out the approved deletion is a different change too.
  const kept = await checkRoutePush({ view, base, head: r.commit([base], { [CI]: ciNew }), approvedSha256: approved, approvedPaths: [CI, OLD] });
  assert.equal(kept.ok, false);
  assert.match(kept.reason, /differs from the approved fingerprint/);
});

test('checkRoutePush fails closed: no approval, an unrelated base, GitHub down', async () => {
  const { r, base, decision, view } = setup();
  const approved = (await fingerprintOfBranch({ view, base, head: decision })).sha256;
  assert.equal((await checkRoutePush({ view, base, head: decision, approvedSha256: 'abc', approvedPaths: [CI, OLD] })).ok, false);
  assert.equal((await checkRoutePush({ view, base, head: decision, approvedSha256: approved, approvedPaths: [] })).ok, false);
  assert.equal((await checkRoutePush({ view: null, base, head: decision, approvedSha256: approved, approvedPaths: [CI, OLD] })).ok, false);
  const stranger = r.commit([], { [CI]: ciNew });
  const unrelated = await checkRoutePush({ view, base: stranger, head: decision, approvedSha256: approved, approvedPaths: [CI, OLD] });
  assert.equal(unrelated.ok, false);
  const r2 = setup();
  r2.r.down = true;
  const down = await checkRoutePush({ view: r2.view, base: r2.base, head: r2.decision, approvedSha256: approved, approvedPaths: [CI, OLD] });
  assert.equal(down.ok, false);
  assert.match(down.reason, /network down/);
  assert.equal((await checkRoutePush()).ok, false);
});

test('decisionBody shows the patch as text in a fence it cannot break out of, plus the fingerprint', () => {
  const sha = 'f'.repeat(64);
  const patch = 'diff --git a/x b/x\n+```\n+# Approve me\n+````\n';
  const body = decisionBody({ patchText: patch, sha256: sha });
  assert.ok(body.includes('`````diff\n'), 'fence longer than any backtick run in the patch');
  const fences = body.split('\n').filter((l) => /^`{3,}/.test(l));
  assert.deepEqual(fences, ['`````diff', '`````']);
  assert.ok(body.includes(`\`${sha}\``));
  assert.ok(decisionBody({ patchText: '+a\n', sha256: sha }).includes('```diff\n+a\n```'));
  assert.throws(() => decisionBody({ patchText: '', sha256: sha }));
  assert.throws(() => decisionBody({ patchText: 'x', sha256: 'nope' }));
  assert.throws(() => decisionBody({ patchText: 'x'.repeat(70000), sha256: sha }), /too long/);
});
