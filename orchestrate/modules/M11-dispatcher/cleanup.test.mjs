import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync, symlinkSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { cleanupCopy, cleanupPass, ASK_ID, hashCopy, mirrorTree, ownCopy } from './cleanup.mjs';
import { createSaveWork } from '../M4-workshop/git/save-work.mjs';
import { git as safeGit, callLog } from '../M4-workshop/git/safe-git.mjs';
import { PR_FACT } from './merges.mjs';
import { rulesWith, recWith, T0, MIN, iso } from './fixtures.test-helper.mjs';
import { tmpFolder } from '../M4-workshop/tmp-folders.test-helper.mjs';

// Test set-up only: plain git with no user or machine config, in a throwaway folder.
function world() {
  const dir = tmpFolder('m11-cleanup-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };
  const run = (args, cwd = dir) => execFileSync('git', args, { cwd, env }).toString().trim();
  const mirror = join(dir, 'mirror.git');
  run(['init', '-q', '--bare', '-b', 'main', mirror]);
  const work = join(dir, 'work');
  run(['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'a.txt'), 'one\n');
  run(['add', '.'], work); run(['commit', '-q', '-m', 'base'], work);
  run(['push', '-q', mirror, 'main'], work);
  const B = run(['rev-parse', 'HEAD'], work);
  const copiesRoot = join(dir, 'copies');
  mkdirSync(copiesRoot);
  const copy = join(copiesRoot, 'C-1');
  run(['clone', '-q', mirror, copy]);
  run(['checkout', '-q', '-b', 'card/c-1'], copy);
  writeFileSync(join(copy, 'b.txt'), 'two\n');
  run(['add', '.'], copy); run(['commit', '-q', '-m', 'card work'], copy);
  const H = run(['rev-parse', 'HEAD'], copy);
  run(['push', '-q', mirror, 'card/c-1:refs/orchestrate/remote/card/c-1'], copy);
  // The Merge Gate's squash merge: a new commit on main with the branch's tree.
  const M = run(['commit-tree', `${H}^{tree}`, '-p', B, '-m', 'squash'], mirror);
  run(['update-ref', 'refs/heads/main', M], mirror);
  return { dir, run, mirror, copiesRoot, copy, sealRoot: join(dir, 'sealed'), B, H, M };
}

const ASK = { decision: 'ask', tier: 2, reason: 'an unproven copy needs Joe' };
const R = rulesWith({}, { delete_copy: ASK });
const locked = createSaveWork({ runLocked: (fn) => fn() }); // stands in for the lock-down runner

function recFor(w, { attempt = {}, pr = {}, card = {} } = {}) {
  return recWith([
    ['card', 'C-1', { state: 'merged', copy: w.copy, ...card }],
    ...(attempt ? [['merge', 'M-1', { card: 'C-1', pr: 7, state: 'audited_ok', head_sha: w.H, merge_commit_sha: w.M, changed_at: iso(T0 - 10 * MIN), ...attempt }]] : []),
    ...(pr ? [['fact', PR_FACT(7), { state: 'closed', merged: true, merge_commit_sha: w.M, head_sha: w.H, observed_at: iso(T0 - 5 * MIN), ...pr }]] : []),
  ]);
}

// The fake runner: any git whose repository or working folder is inside a copy fails the test.
const guardedGit = (copiesRoot) => (args, opts) => {
  for (const k of ['gitDir', 'cwd', 'workTree']) {
    const p = opts?.[k];
    if (p && (resolve(p) + sep).startsWith(resolve(copiesRoot) + sep)) assert.fail(`git ${args[0]} ran with ${k} inside a copy: ${p}`);
  }
  return safeGit(args, opts);
};

async function clean(w, rec, over = {}) {
  const alerts = [];
  const calls = [];
  const saveWork = over.saveWork ?? (async (a) => { calls.push(a); return locked(a); });
  const from = callLog.length;
  const r = await cleanupCopy({ rec, rules: over.rules ?? R, now: T0, card: 'C-1', copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirror: w.mirror,
    git: guardedGit(w.copiesRoot), saveWork, alert: (t) => alerts.push(t) });
  // Every git call made, save-work's included: none has its working folder inside a copy, and only
  // save-work names a copy's repository.
  for (const c of callLog.slice(from)) {
    for (const k of ['cwd', 'workTree']) if (c[k]) assert.ok(!(resolve(c[k]) + sep).startsWith(resolve(w.copiesRoot) + sep), `${c.purpose}: ${k} inside a copy`);
    if ((resolve(c.gitDir) + sep).startsWith(resolve(w.copiesRoot) + sep)) assert.equal(c.purpose, 'save-work');
  }
  return { ...r, alerts, calls };
}

const theAsk = (rec) => rec.read('ask', ASK_ID('C-1'))?.doc ?? null;
function assertSealed(rec) {
  const a = theAsk(rec);
  assert.equal(a.kind, 'delete_copy');
  assert.equal(a.state, 'open');
  assert.equal(a.tier, 2);
  assert.ok(existsSync(a.sealed.path));
  assert.equal(statSync(a.sealed.path).mode & 0o222, 0, 'sealed bundle is read-only');
  assert.equal(createHash('sha256').update(readFileSync(a.sealed.path)).digest('hex'), a.sealed.sha256);
  return a;
}

test('M12 case 1: merged clean (squash merge) -> the copy is deleted', async () => {
  const w = world();
  mkdirSync(join(w.copy, '.claude'));
  writeFileSync(join(w.copy, '.claude', 'settings.json'), '{}'); // main's own copy, put back by the launcher
  const rec = recFor(w);
  const r = await clean(w, rec);
  assert.equal(r.result, 'deleted', r.reasons.join('; '));
  assert.equal(existsSync(w.copy), false);
  assert.equal(theAsk(rec), null);
  assert.match(rec.read('fact', 'cleanup-C-1').doc.text, /deleted/);
  assert.deepEqual(readdirSync(w.sealRoot), [], 'nothing left sealed or staged');
});

test('M12 case 2 / m15: PR open or the merge not yet audited -> kept, no bundle made', async () => {
  const w = world();
  for (const state of ['requested', 'checking', 'merging', 'merged']) {
    const r = await clean(w, recFor(w, { attempt: { state } }));
    assert.equal(r.result, 'kept', state);
    assert.equal(r.calls.length, 0);
  }
  const noAttempt = await clean(w, recFor(w, { attempt: null, pr: { state: 'open', merged: false }, card: { state: 'in_review' } }));
  assert.equal(noAttempt.result, 'kept');
  assert.ok(existsSync(w.copy));
});

test('M12 case 3: PR closed unmerged -> sealed and asked; nothing deleted', async () => {
  const w = world();
  const rec = recFor(w, { attempt: { state: 'refused', reason: 'interrupted', merge_commit_sha: null }, pr: { state: 'closed', merged: false, merge_commit_sha: null }, card: { state: 'closed' } });
  const r = await clean(w, rec);
  assert.equal(r.result, 'asked');
  assert.ok(existsSync(w.copy));
  assertSealed(rec);
  // a cancelled card that never reached a PR is asked about too
  const w2 = world();
  const rec2 = recFor(w2, { attempt: null, pr: null, card: { state: 'cancelled' } });
  assert.equal((await clean(w2, rec2)).result, 'asked');
});

test('M12 case 4: an extra commit after the merged head -> sealed and asked', async () => {
  const w = world();
  writeFileSync(join(w.copy, 'c.txt'), 'late\n');
  w.run(['add', '.'], w.copy); w.run(['commit', '-q', '-m', 'late'], w.copy);
  const rec = recFor(w);
  const r = await clean(w, rec);
  assert.equal(r.result, 'asked');
  assert.match(r.reasons.join(), /commits after the merged head/);
  assert.ok(existsSync(w.copy));
  // the sealed bundle keeps the late commit
  const a = assertSealed(rec);
  assert.match(w.run(['bundle', 'list-heads', a.sealed.path]), /refs\/heads\/card\/c-1/);
});

test('M12 case 5: uncommitted edits -> sealed and asked (a changed file, a new file, a mode change)', async () => {
  for (const edit of [
    (c) => writeFileSync(join(c, 'a.txt'), 'changed\n'),
    (c) => writeFileSync(join(c, 'new.txt'), 'new\n'),
    (c) => rmSync(join(c, 'b.txt')),
    (c) => execFileSync('chmod', ['+x', join(c, 'a.txt')]),
    (c) => symlinkSync('a.txt', join(c, 'link')),
  ]) {
    const w = world();
    edit(w.copy);
    const rec = recFor(w);
    const r = await clean(w, rec);
    assert.equal(r.result, 'asked', String(edit));
    assert.match(r.reasons.join(), /never committed/);
    assert.ok(existsSync(w.copy));
    assertSealed(rec);
  }
});

test('M12 case 6: a worker that died with no bundle gets one written in the lock-down first, then the decision', async () => {
  const w = world();
  const order = [];
  const saveWork = async (a) => { order.push('save-work'); const r = await locked(a); order.push(existsSync(a.clone) ? 'copy still there' : 'copy gone'); return r; };
  const r = await clean(w, recFor(w), { saveWork });
  assert.equal(r.result, 'deleted');
  assert.deepEqual(order, ['save-work', 'copy still there']);
  // save-work fails (a .git pointer file): nothing to seal, never deleted, asked
  const w2 = world();
  rmSync(join(w2.copy, '.git'), { recursive: true });
  writeFileSync(join(w2.copy, '.git'), 'gitdir: /somewhere\n');
  const rec2 = recFor(w2);
  const r2 = await clean(w2, rec2);
  assert.equal(r2.result, 'asked');
  assert.match(r2.reasons.join(), /no fresh bundle/);
  assert.equal(theAsk(rec2).sealed, null);
  assert.ok(existsSync(w2.copy));
});

test('M12 case 7: the bundle carries another ref -> asked', async () => {
  const w = world();
  const saveWork = async ({ outbox, card }) => {
    const out = join(outbox, `bundle-${card}.bundle`);
    w.run(['bundle', 'create', '-q', out, 'refs/heads/card/c-1', 'refs/heads/main'], w.copy);
    return { ok: true, bundle: out };
  };
  const rec = recFor(w);
  const r = await clean(w, rec, { saveWork });
  assert.equal(r.result, 'asked');
  assert.match(r.reasons.join(), /exactly one branch/);
  assertSealed(rec);
  // a bundle outside the staging folder, or an old one, is not fresh
  const w2 = world();
  const old = join(w2.dir, 'old.bundle');
  w2.run(['bundle', 'create', '-q', old, 'refs/heads/card/c-1'], w2.copy);
  const r2 = await clean(w2, recFor(w2), { saveWork: async () => ({ ok: true, bundle: old }) });
  assert.equal(r2.result, 'asked');
  assert.match(r2.reasons.join(), /no fresh bundle/);
});

test('M12 case 8: the record says merged but the PR fact or the mirror says not -> asked', async () => {
  const w = world();
  const rec = recFor(w, { pr: { merged: false, state: 'open' } });
  assert.equal((await clean(w, rec)).result, 'asked');
  const w2 = world();
  assert.match((await clean(w2, recFor(w2, { pr: { merge_commit_sha: w2.B } }))).reasons.join(), /PR fact does not agree/);
  const w3 = world();
  w3.run(['update-ref', 'refs/heads/main', w3.B], w3.mirror);
  assert.match((await clean(w3, recFor(w3))).reasons.join(), /not on the mirror's main/);
  const w4 = world();
  assert.match((await clean(w4, recFor(w4, { attempt: { merge_commit_sha: null } }))).reasons.join(), /names no merge commit/);
});

test("M12 (e): a folder that is not this card's copy is never bundled, sealed or deleted", async () => {
  const w = world();
  const elsewhere = join(w.dir, 'elsewhere');
  execFileSync('mv', [w.copy, elsewhere]);
  symlinkSync(elsewhere, w.copy);
  const r = await clean(w, recFor(w));
  assert.equal(r.result, 'refused');
  assert.equal(r.calls.length, 0);
  assert.ok(existsSync(elsewhere));
  const w2 = world();
  const r2 = await clean(w2, recFor(w2, { card: { copy: join(w2.dir, 'other') } }));
  assert.equal(r2.result, 'refused');
  assert.match(r2.reasons.join(), /another copy/);
  assert.ok(existsSync(w2.copy));
});

const COUNTED = rulesWith({}, { count_approval: { decision: 'allow', reason: 'counted' } });

test("the ask: one per copy; Joe's answer is acted on once; a refusal to ask keeps the copy with an alert", async () => {
  const w = world();
  writeFileSync(join(w.copy, 'a.txt'), 'changed\n');
  const rec = recFor(w);
  await clean(w, rec);
  const again = await clean(w, rec);
  assert.equal(again.result, 'kept');
  assert.equal(again.calls.length, 0, 'no second bundle while the ask is open');
  const cur = rec.read('ask', ASK_ID('C-1'));
  rec.write({ actor: 'joe', entity: 'ask', id: ASK_ID('C-1'), expectRev: cur.rev, doc: { ...cur.doc, state: 'answered', answer: 'delete' } });
  // audit: a "delete" is acted on only when the rules count it as Joe's approval
  assert.equal((await clean(w, rec, { rules: rulesWith({}, { count_approval: { decision: 'deny', reason: 'not counted' } }) })).result, 'refused');
  assert.ok(existsSync(w.copy));
  assert.equal((await clean(w, rec, { rules: COUNTED })).result, 'deleted');
  assert.equal(existsSync(w.copy), false);
  assert.equal(theAsk(rec).state, 'consumed');
  // "keep" keeps it
  const w2 = world();
  writeFileSync(join(w2.copy, 'a.txt'), 'changed\n');
  const rec2 = recFor(w2);
  await clean(w2, rec2);
  const c2 = rec2.read('ask', ASK_ID('C-1'));
  rec2.write({ actor: 'joe', entity: 'ask', id: ASK_ID('C-1'), expectRev: c2.rev, doc: { ...c2.doc, state: 'answered', answer: 'keep' } });
  assert.equal((await clean(w2, rec2)).result, 'kept');
  assert.ok(existsSync(w2.copy));
  const later = await clean(w2, rec2);
  assert.deepEqual([later.result, later.calls.length], ['kept', 0], 'a kept copy is not asked about again while the card is unchanged');
  assert.ok(existsSync(w2.copy));
  // the rules deny the ask: kept, one alert, no ask entry; an "allow" is still only an ask
  const w3 = world();
  writeFileSync(join(w3.copy, 'a.txt'), 'changed\n');
  const rec3 = recFor(w3);
  const r3 = await clean(w3, rec3, { rules: rulesWith({}, { delete_copy: { decision: 'deny', reason: 'no' } }) });
  assert.equal(r3.result, 'kept');
  assert.equal(r3.alerts.length, 1);
  assert.equal(theAsk(rec3), null);
  const w4 = world();
  writeFileSync(join(w4.copy, 'a.txt'), 'changed\n');
  const r4 = await clean(w4, recFor(w4), { rules: rulesWith({}, { delete_copy: { decision: 'allow', reason: 'fine' } }) });
  assert.equal(r4.result, 'asked');
  assert.ok(existsSync(w4.copy));
});

test('hashing a copy without git matches git\'s own tree', async () => {
  const w = world();
  const tree = await mirrorTree(safeGit, w.mirror, w.H);
  assert.equal(tree.size, 2);
  const mine = hashCopy(w.copy);
  assert.deepEqual([...mine].sort(), [...tree].sort());
  assert.equal(await mirrorTree(safeGit, w.mirror, '0'.repeat(40)), null);
});

test('cleanupPass goes through every copy folder and skips one with no record', async () => {
  const w = world();
  mkdirSync(join(w.copiesRoot, 'C-9'));
  const rec = recFor(w);
  const out = await cleanupPass({ rec, rules: R, now: T0, copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirrorFor: () => w.mirror,
    git: guardedGit(w.copiesRoot), saveWork: locked, alert: () => {} });
  assert.deepEqual(out.map(([c, r]) => [c, r.result]), [['C-1', 'deleted'], ['C-9', 'kept']]);
  assert.ok(existsSync(join(w.copiesRoot, 'C-9')));
});

test('audit MIN-17: each copy-ownership check refuses on its own', () => {
  const dir = tmpFolder('m11-own-');
  const copiesRoot = join(dir, 'copies');
  mkdirSync(join(copiesRoot, 'C-1'), { recursive: true });
  mkdirSync(join(copiesRoot, 'C-2'));
  const real = join(copiesRoot, 'C-1');
  assert.deepEqual(ownCopy(real, copiesRoot, 'C-1', { copy: real }), { ok: true });
  // a link that resolves to the right folder is still refused: only the real folder is the copy
  const link = join(dir, 'link');
  symlinkSync(real, link);
  assert.deepEqual(ownCopy(link, copiesRoot, 'C-1', { copy: link }), { ok: false, reason: 'the copy is not a real folder' });
  // a real folder that is another card's copy
  assert.match(ownCopy(join(copiesRoot, 'C-2'), copiesRoot, 'C-1', {}).reason, /not this card's/);
  assert.match(ownCopy(join(copiesRoot, 'C-2'), copiesRoot, 'C-1', { copy: join(copiesRoot, 'C-2') }).reason, /not this card's/);
  // the record names another copy, or has no card
  assert.match(ownCopy(real, copiesRoot, 'C-1', { copy: join(copiesRoot, 'C-2') }).reason, /another copy/);
  assert.match(ownCopy(real, copiesRoot, 'C-1', null).reason, /not in the record/);
  assert.match(ownCopy(join(copiesRoot, 'C-9'), copiesRoot, 'C-9', {}).reason, /no copy folder/);
  writeFileSync(join(copiesRoot, 'C-3'), 'a file');
  assert.match(ownCopy(join(copiesRoot, 'C-3'), copiesRoot, 'C-3', {}).reason, /not a real folder/);
});

test('audit MIN-20 (C10): an old bundle, or one outside the staging folder, is not proof; the copy is kept and asked about', async () => {
  const w = world();
  const old = await clean(w, recFor(w), { saveWork: async (a) => { const r = await locked(a); if (r.ok) utimesSync(r.bundle, new Date(T0 - 60 * MIN), new Date(T0 - 60 * MIN)); return r; } });
  assert.notEqual(old.result, 'deleted');
  assert.ok(existsSync(w.copy));
  assert.match(old.reasons.join(), /not fresh/);
  const w2 = world();
  const stray = join(w2.dir, 'stray.bundle');
  const out = await clean(w2, recFor(w2), { saveWork: async (a) => { const r = await locked(a); if (r.ok) execFileSync('cp', [r.bundle, stray]); return { ...r, bundle: stray }; } });
  assert.notEqual(out.result, 'deleted');
  assert.ok(existsSync(w2.copy));
  assert.match(out.reasons.join(), /no fresh bundle/);
});

test('audit 0b-6 r2 MAT-5 / MAT-8 (C2): any answer but delete keeps the copy without re-asking, until the card moves again', async () => {
  for (const answer of ['no', 'not yet', '']) {
    const w = world();
    writeFileSync(join(w.copy, 'a.txt'), 'changed\n');
    const rec = recFor(w, { card: { changed_at: iso(T0 - 20 * MIN) } });
    await clean(w, rec);
    const a = rec.read('ask', ASK_ID('C-1'));
    rec.write({ actor: 'joe', entity: 'ask', id: ASK_ID('C-1'), expectRev: a.rev, doc: { ...a.doc, state: 'answered', answer } });
    assert.equal((await clean(w, rec)).result, 'kept', answer);
    const later = await clean(w, rec);
    assert.deepEqual([later.result, later.calls.length], ['kept', 0], `${JSON.stringify(answer)}: not bundled or asked again`);
    assert.equal(theAsk(rec).state, 'consumed');
    // the card moves: the copy is looked at, and asked about, again
    const c = rec.read('card', 'C-1');
    rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: c.rev, doc: { ...c.doc, changed_at: iso(T0 - MIN) } });
    const moved = await clean(w, rec);
    assert.ok(moved.calls.length > 0, `${JSON.stringify(answer)}: bundled again after the card moved`);
    assert.equal(theAsk(rec).state, 'open');
    assert.ok(existsSync(w.copy));
  }
});

test('the staging folder is removed even when saving the work throws (temp-folder cleanup)', async () => {
  const w = world();
  await assert.rejects(clean(w, recFor(w), { saveWork: async () => { throw new Error('save-work crashed'); } }), /save-work crashed/);
  assert.deepEqual(readdirSync(w.sealRoot).filter((n) => n.startsWith('.staging-')), [], 'no staging folder left behind');
});
