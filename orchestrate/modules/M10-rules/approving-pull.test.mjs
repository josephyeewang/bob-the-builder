// approving-pull.test.mjs — 0b-1 R3-M2: a rules version is adopted only through the one merged pull request that
// put it on main, for all three merge methods; a copied direct push or a mismatched head is not, with one alert each.
// Run: node --test orchestrate/modules/M10-rules/approving-pull.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeReader, findApprovingPull, pullRequestVerifier, allowListVerifier, RULES_PATH } from './reader.mjs';
import { fakeRepo } from './fixtures/fake-repo.mjs';

const V1 = readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8');
const V2 = V1.replace('  editing_per_mac: 5', '  editing_per_mac: 4');
const V3 = V1.replace('  editing_per_mac: 5', '  editing_per_mac: 3');
const PRODUCT = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };

function setup() {
  const r = fakeRepo();
  const m0 = r.commit([], { [RULES_PATH]: V1, 'docs/a.md': 'a' });
  r.main = m0;
  const alerts = [];
  const judged = [];
  const reader = makeReader({ gh: r.gh, stateDir: mkdtempSync(join(tmpdir(), 'm10-pulls-')), products: [PRODUCT],
    alert: (a) => alerts.push(a), verifyApproved: pullRequestVerifier({ judge: (q) => { judged.push(q.pr); return true; } }) });
  return { r, m0, alerts, judged, reader };
}
const blobOn = (r, sha) => r.files(sha).get(RULES_PATH).blob;
const lookup = (r, commit) => findApprovingPull({ gh: r.gh, owner: 'sample-org', repo: 'sample-app', commit, blob: blobOn(r, commit) });

test('squash merge: adopted through its pull request', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  const squash = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  s.r.pull({ number: 11, merged: true, head: b1, merge_commit_sha: squash, commits: [b1] });
  s.r.linkPull(squash, 11);
  s.r.main = squash;
  assert.deepEqual(await lookup(s.r, squash), { ok: true, pr: 11, head: b1, merge_commit: squash });
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 4);
  assert.deepEqual(s.judged, [11]);
  assert.deepEqual(s.alerts, []);
});

test('merge commit: the branch commit is found, and the merge commit is on main', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  const m1 = s.r.commit([s.m0], { 'docs/a.md': 'a2' });
  const mc = s.r.commit([m1, b1], { [RULES_PATH]: V2 }, { from: m1 });
  s.r.pull({ number: 12, merged: true, head: b1, merge_commit_sha: mc, commits: [b1] });
  s.r.main = mc;
  assert.deepEqual(await lookup(s.r, mc), { ok: true, pr: 12, head: b1, merge_commit: mc });
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'ok');
});

test('rebase merge of two commits: the last rebased commit leads to the pull request', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V3 });
  const b2 = s.r.commit([b1], { [RULES_PATH]: V2 });
  const r1 = s.r.commit([s.m0], { [RULES_PATH]: V3 });
  const r2 = s.r.commit([r1], { [RULES_PATH]: V2 });
  s.r.pull({ number: 13, merged: true, head: b2, merge_commit_sha: r2, commits: [b1, b2] });
  s.r.linkPull(r1, 13); s.r.linkPull(r2, 13);
  s.r.main = r2;
  assert.deepEqual(await lookup(s.r, r2), { ok: true, pr: 13, head: b2, merge_commit: r2 });
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 4);
});

test('a copied change pushed straight to main is not adopted: one alert, even after several reads', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  s.r.pull({ number: 14, merged: false, head: b1, commits: [b1] });       // the reviewed pull request, never merged
  const direct = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  s.r.main = direct;
  assert.match((await lookup(s.r, direct)).reason, /0 merged pull requests/);
  await s.reader.refresh(); await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'deny_all');
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].reason, 'unapproved_rules_change');
  assert.match(s.alerts[0].detail, /0 merged pull requests/);
  assert.deepEqual(s.judged, [], 'Joe\'s Approve is never even judged');
});

test('a merge whose result differs from the reviewed head is not adopted: one alert', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  const m1 = s.r.commit([s.m0], { 'docs/a.md': 'a2' });
  const mc = s.r.commit([m1, b1], { [RULES_PATH]: V3 }, { from: m1 });   // the merge wrote a version nobody reviewed
  s.r.pull({ number: 15, merged: true, head: b1, merge_commit_sha: mc, commits: [b1] });
  s.r.linkPull(mc, 15);
  s.r.main = mc;
  assert.match((await lookup(s.r, mc)).reason, /head is not the version on main/);
  await s.reader.refresh(); await s.reader.refresh();
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].detail, /#15/);
});

test('two merged pull requests, a merge into another branch, or a merge commit off main are not adopted', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  const squash = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  s.r.linkPull(squash, 16); s.r.linkPull(squash, 17);
  s.r.pull({ number: 16, merged: true, head: b1, merge_commit_sha: squash });
  s.r.pull({ number: 17, merged: true, head: b1, merge_commit_sha: squash });
  assert.match((await lookup(s.r, squash)).reason, /2 merged pull requests/);

  const t = setup();
  const c1 = t.r.commit([t.m0], { [RULES_PATH]: V2 });
  t.r.pull({ number: 18, merged: true, base: 'staging', head: c1, merge_commit_sha: c1, commits: [c1] });
  assert.match((await lookup(t.r, c1)).reason, /0 merged pull requests/);

  const o = setup();                                                     // an open pull request is never the approving one
  const e1 = o.r.commit([o.m0], { [RULES_PATH]: V2 });
  const sq = o.r.commit([o.m0], { [RULES_PATH]: V2 });
  o.r.pull({ number: 21, merged: false, head: e1, merge_commit_sha: sq, commits: [e1] });
  o.r.linkPull(sq, 21);
  o.r.main = sq;
  assert.match((await lookup(o.r, sq)).reason, /0 merged pull requests/);

  const u = setup();
  const d1 = u.r.commit([u.m0], { [RULES_PATH]: V2 });
  const elsewhere = u.r.commit([u.m0], { 'docs/a.md': 'x' });
  u.r.pull({ number: 19, merged: true, head: d1, merge_commit_sha: elsewhere, commits: [d1] });
  assert.match((await lookup(u.r, d1)).reason, /merge commit is not on main/);
});

test('when Joe has not approved the pull request, it is not adopted; GitHub errors mean not approved', async () => {
  const s = setup();
  const b1 = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  const squash = s.r.commit([s.m0], { [RULES_PATH]: V2 });
  s.r.pull({ number: 20, merged: true, head: b1, merge_commit_sha: squash, commits: [b1] });
  s.r.linkPull(squash, 20);
  const verify = pullRequestVerifier({ judge: () => false });
  const q = { gh: s.r.gh, owner: 'sample-org', repo: 'sample-app', commit: squash, blob: blobOn(s.r, squash) };
  assert.match((await verify(q)).reason, /#20 has no Approve/);
  s.r.down = true;
  assert.match((await lookup(s.r, squash)).reason, /could not look up/);
  assert.equal((await findApprovingPull({ gh: s.r.gh, owner: 'o', repo: 'r', commit: 'abc', blob: 'def' })).ok, false);
});

// Audit M-1: git's history for the file follows the parent whose version is unchanged, so a direct-pushed merge that
// takes an old pull request's version leads the lookup back to that old (approved) pull request.
test('an older approved version brought back by a direct-pushed merge is not adopted: one alert', async () => {
  const s = setup();
  const LOOSE = V1.replace('  editing_per_mac: 5', '  editing_per_mac: 9');
  const h10 = s.r.commit([s.m0], { [RULES_PATH]: LOOSE });
  const mc10 = s.r.commit([s.m0, h10], { [RULES_PATH]: LOOSE }, { from: s.m0 });
  s.r.pull({ number: 10, merged: true, head: h10, merge_commit_sha: mc10, commits: [h10] });
  s.r.main = mc10;
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 9);
  const h11 = s.r.commit([mc10], { [RULES_PATH]: V2 });
  const sq11 = s.r.commit([mc10], { [RULES_PATH]: V2 });
  s.r.pull({ number: 11, merged: true, head: h11, merge_commit_sha: sq11, commits: [h11] });
  s.r.linkPull(sq11, 11);
  s.r.main = sq11;
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 4);

  const evil = s.r.commit([sq11, h10], { [RULES_PATH]: LOOSE }, { from: sq11 });   // no pull request, no Approve
  s.r.main = evil;
  assert.equal((await lookup(s.r, evil)).pr, 10, 'the fake follows git: the history leads to the old pull request');
  await s.reader.refresh(); await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'last_good');
  assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 4);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].detail, /#10 landed before the last good rules/);
});

test('the stopgap allow-list only moves forward: an older pinned version pushed again is not adopted', async () => {
  const r = fakeRepo();
  const dir = mkdtempSync(join(tmpdir(), 'm10-allow-'));
  const a0 = r.commit([], { [RULES_PATH]: V3 });
  r.main = a0;
  const pin = (...shas) => writeFileSync(join(dir, 'approved-rules.json'), JSON.stringify({ 'sample-app': shas.map((c) => blobOn(r, c)) }));
  pin(a0);
  const alerts = [];
  const reader = makeReader({ gh: r.gh, stateDir: dir, products: [PRODUCT], alert: (a) => alerts.push(a) });
  await reader.refresh();
  assert.equal(reader.state('sample-app').policy.caps.editing_per_mac, 3);
  const a1 = r.commit([a0], { [RULES_PATH]: V2 });
  r.main = a1;
  pin(a0, a1);
  await reader.refresh();
  assert.equal(reader.state('sample-app').policy.caps.editing_per_mac, 4);
  const a2 = r.commit([a1], { [RULES_PATH]: V3 });                       // the old pinned text, pushed forward
  r.main = a2;
  await reader.refresh();
  assert.equal(reader.state('sample-app').status, 'last_good');
  assert.equal(reader.state('sample-app').policy.caps.editing_per_mac, 4);
  assert.deepEqual(alerts.map((a) => a.reason), ['unapproved_rules_change']);
  // The verifier on its own: a version missing from the list, or a current version missing from it, approves nothing.
  const v = allowListVerifier(join(dir, 'approved-rules.json'));
  assert.equal(v({ product: 'sample-app', blob: blobOn(r, a1), lastGoodBlob: blobOn(r, a0) }), true);
  assert.equal(v({ product: 'sample-app', blob: blobOn(r, a1), lastGoodBlob: 'f'.repeat(40) }), false);
});
