import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync, symlinkSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { cleanupCopy, cleanupPass, ASK_ID, CLEANUP_FACT, hashCopy, mirrorTree, namedCopy, ownCopy, STALE_STAGING_MS, sweepStaging } from './cleanup.mjs';
import { createSaveWork } from '../M4-workshop/git/save-work.mjs';
import { git as safeGit, callLog } from '../M4-workshop/git/safe-git.mjs';
import { PR_FACT } from './merges.mjs';
import { rulesWith, recWith, change, setClock, T0, MIN, iso } from './fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';

// Test set-up only: plain git with no user or machine config, in a throwaway folder. It never asks for a
// password, never shares this run's terminal and is stopped at a minute (no test may hang, 30 Oct 2026).
function world() {
  const dir = tempDir('m11-cleanup-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GCM_INTERACTIVE: 'never' };
  const run = (args, cwd = dir) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).toString().trim();
  const mirror = join(dir, 'mirror.git');
  run(['init', '-q', '--bare', '-b', 'main', mirror]);
  const work = join(dir, 'work');
  run(['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'a.txt'), 'one\n');
  run(['add', '.'], work); run(['commit', '-q', '-m', 'base'], work);
  run(['push', '-q', mirror, 'main'], work);
  const B = run(['rev-parse', 'HEAD'], work);
  const copiesRoot = join(dir, 'copies');
  mkdirSync(join(copiesRoot, 'p1'), { recursive: true });
  // The card's copy is in its own product's folder (L836: <copiesRoot>/<product>/<card>).
  const copy = join(copiesRoot, 'p1', 'C-1');
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
// Joe's answers as M2 records them (channel, choice, approves).
const YES = { channel: 'tap', choice: 'Yes', approves: true };
const KEEP = { channel: 'tap', choice: 'No', approves: false };
const locked = createSaveWork({ runLocked: (fn) => fn() }); // stands in for the lock-down runner

// The copy the record names for C-1 is on its worker launch (the card has no copy field, L72).
const launchFor = (copy, id = 'L-1', at = T0 - 60 * MIN) => ['launch', id, { session_id: `S-${id}`, role: 'worker', card: 'C-1', head: 'a'.repeat(40), rev: 1, copy, launched_at: iso(at) }];
function recFor(w, { attempt = {}, pr = {}, card = {}, copy = w.copy } = {}) {
  return recWith([
    // A card names its product, as every real card does: the delete ask M2 makes carries it to count_approval (L81).
    ['card', 'C-1', { state: 'merged', product: 'p1', ...card }],
    // The products whose copies folders the pass enters (L836 self-review m2: only a product the Record holds).
    ['product', 'p1', { state: 'active' }], ['product', 'p2', { state: 'active' }], ['product', 'p3', { state: 'active' }],
    ...(copy ? [launchFor(copy)] : []),
    ...(attempt ? [['merge', 'M-1', { card: 'C-1', pr: 7, state: 'audited_ok', judged_head: w.H, merge_commit: w.M, changed_at: iso(T0 - 10 * MIN), ...attempt }]] : []),
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
  const r = await cleanupCopy({ rec, rules: over.rules ?? R, now: T0, card: 'C-1', product: over.product ?? 'p1', copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirror: w.mirror,
    git: guardedGit(w.copiesRoot), saveWork, alert: (t) => alerts.push(t) });
  // Every git call made, save-work's included: none has its working folder inside a copy, and only
  // save-work names a copy's repository.
  for (const c of callLog.slice(from)) {
    for (const k of ['cwd', 'workTree']) if (c[k]) assert.ok(!(resolve(c[k]) + sep).startsWith(resolve(w.copiesRoot) + sep), `${c.purpose}: ${k} inside a copy`);
    if ((resolve(c.gitDir) + sep).startsWith(resolve(w.copiesRoot) + sep)) assert.equal(c.purpose, 'save-work');
  }
  return { ...r, alerts, calls };
}

// Joe answers as M2 records it: the ask is shown first (open -> pushed), then answered (M9's ask moves).
function answerAsk(rec, answer) {
  for (const doc of [{ state: 'pushed' }, { state: 'answered', answer }]) {
    const cur = rec.read('ask', ASK_ID('C-1'));
    const r = rec.write({ actor: 'approvals', entity: 'ask', id: ASK_ID('C-1'), expectRev: cur.rev, doc: { ...cur.doc, ...doc } });
    assert.equal(r.ok, true, `the ask ${doc.state}: ${r.reason}`);
  }
}
const theAsk = (rec) => rec.read('ask', ASK_ID('C-1'))?.doc ?? null;
function assertSealed(rec) {
  const a = theAsk(rec);
  // M2's yes/no tap, for deleting the copy (L74: only approvals writes asks).
  assert.equal(a.kind, 'tap_yes_no');
  assert.equal(a.purpose, 'delete_copy');
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
  const rec = recFor(w, { attempt: { state: 'refused', reason: 'interrupted', merge_commit: null }, pr: { state: 'closed', merged: false, merge_commit_sha: null }, card: { state: 'closed' } });
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
  assert.match((await clean(w4, recFor(w4, { attempt: { merge_commit: null } }))).reasons.join(), /names no merge commit/);
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
  const r2 = await clean(w2, recFor(w2, { copy: join(w2.dir, 'other') }));
  assert.equal(r2.result, 'refused');
  assert.match(r2.reasons.join(), /another copy/);
  assert.ok(existsSync(w2.copy));
});

// The delete answer is counted by M10's real engine (fixtures.test-helper.mjs, L81).
const COUNTED = rulesWith();

test("the ask: one per copy; Joe's answer is acted on once; a refusal to ask keeps the copy with an alert", async () => {
  const w = world();
  writeFileSync(join(w.copy, 'a.txt'), 'changed\n');
  const rec = recFor(w);
  await clean(w, rec);
  const again = await clean(w, rec);
  assert.equal(again.result, 'kept');
  assert.equal(again.calls.length, 0, 'no second bundle while the ask is open');
  const cur = rec.read('ask', ASK_ID('C-1'));
  answerAsk(rec, YES);
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
  answerAsk(rec2, KEEP);
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
  mkdirSync(join(w.copiesRoot, 'p1', 'C-9'));
  const rec = recFor(w);
  const out = await cleanupPass({ rec, rules: R, now: T0, copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirrorFor: () => w.mirror,
    git: guardedGit(w.copiesRoot), saveWork: locked, alert: () => {} });
  assert.deepEqual(out.map(([c, r]) => [c, r.result]), [['C-1', 'deleted'], ['C-9', 'kept']]);
  assert.ok(existsSync(join(w.copiesRoot, 'p1', 'C-9')));
});

test('audit MIN-17: each copy-ownership check refuses on its own', () => {
  const dir = tempDir('m11-own-');
  const copiesRoot = join(dir, 'copies');
  const p1 = join(copiesRoot, 'p1');
  mkdirSync(join(p1, 'C-1'), { recursive: true });
  mkdirSync(join(p1, 'C-2'));
  const real = join(p1, 'C-1');
  assert.deepEqual(ownCopy(real, copiesRoot, 'C-1', { copy: real }, 'p1'), { ok: true });
  // a link that resolves to the right folder is still refused: only the real folder is the copy
  const link = join(dir, 'link');
  symlinkSync(real, link);
  assert.deepEqual(ownCopy(link, copiesRoot, 'C-1', { copy: link }, 'p1'), { ok: false, reason: 'the copy is not a real folder' });
  // a real folder that is another card's copy
  assert.match(ownCopy(join(p1, 'C-2'), copiesRoot, 'C-1', {}, 'p1').reason, /not this card's/);
  assert.match(ownCopy(join(p1, 'C-2'), copiesRoot, 'C-1', { copy: join(p1, 'C-2') }, 'p1').reason, /not this card's/);
  // the record names another copy, or has no card
  assert.match(ownCopy(real, copiesRoot, 'C-1', { copy: join(p1, 'C-2') }, 'p1').reason, /another copy/);
  assert.match(ownCopy(real, copiesRoot, 'C-1', null, 'p1').reason, /not in the record/);
  assert.match(ownCopy(join(p1, 'C-9'), copiesRoot, 'C-9', {}, 'p1').reason, /no copy folder/);
  writeFileSync(join(p1, 'C-3'), 'a file');
  assert.match(ownCopy(join(p1, 'C-3'), copiesRoot, 'C-3', {}, 'p1').reason, /not a real folder/);
  // L836: the card's folder in another product's folder, the old flat place, or a product with no folder, is not its copy.
  mkdirSync(join(copiesRoot, 'p2', 'C-1'), { recursive: true });
  mkdirSync(join(copiesRoot, 'C-1'));
  assert.match(ownCopy(join(copiesRoot, 'p2', 'C-1'), copiesRoot, 'C-1', {}, 'p1').reason, /not this card's/);
  assert.match(ownCopy(real, copiesRoot, 'C-1', {}, 'p2').reason, /not this card's/);
  assert.match(ownCopy(join(copiesRoot, 'C-1'), copiesRoot, 'C-1', {}, 'p1').reason, /not this card's/);
  for (const product of [undefined, 'P1', '..', 'worker']) assert.match(ownCopy(real, copiesRoot, 'C-1', {}, product).reason, /not this card's/, String(product));
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
    const rec = recFor(w);
    await clean(w, rec);
    answerAsk(rec, answer);
    assert.equal((await clean(w, rec)).result, 'kept', answer);
    const later = await clean(w, rec);
    assert.deepEqual([later.result, later.calls.length], ['kept', 0], `${JSON.stringify(answer)}: not bundled or asked again`);
    assert.equal(theAsk(rec).state, 'consumed');
    // the card changes (the Record stamps it later by its own clock): the copy is looked at, and asked about, again
    setClock(rec, T0 + MIN);
    change(rec, 'card', 'C-1', { needs_joe: true });
    const moved = await clean(w, rec);
    assert.ok(moved.calls.length > 0, `${JSON.stringify(answer)}: bundled again after the card moved`);
    assert.equal(rec.read('ask', `${ASK_ID('C-1')}-2`)?.doc.state, 'open', 'asked anew under the next id');
    assert.ok(existsSync(w.copy));
  }
});

test('the staging folder is removed even when saving the work throws (temp-folder cleanup)', async () => {
  const w = world();
  await assert.rejects(clean(w, recFor(w), { saveWork: async () => { throw new Error('save-work crashed'); } }), /save-work crashed/);
  assert.deepEqual(readdirSync(w.sealRoot).filter((n) => n.startsWith('.staging-')), [], 'no staging folder left behind');
});

test('audit 0b-6 r3 MIN-6: a staging folder left by a killed run is removed at the next pass; a fresh one, a file and a link are left', async () => {
  const dir = tempDir('m11-staging-');
  const sealRoot = join(dir, 'sealed');
  const copiesRoot = join(dir, 'copies');
  mkdirSync(copiesRoot);
  mkdirSync(join(sealRoot, '.staging-C-1-old', 'deep'), { recursive: true });
  writeFileSync(join(sealRoot, '.staging-C-1-old', 'deep', 'x.bundle'), 'b');
  mkdirSync(join(sealRoot, '.staging-C-2-fresh'));
  writeFileSync(join(sealRoot, '.staging-file'), 'not a folder');
  mkdirSync(join(dir, 'elsewhere'));
  symlinkSync(join(dir, 'elsewhere'), join(sealRoot, '.staging-link'));
  const now = Date.now();
  const old = (now - STALE_STAGING_MS - 60_000) / 1000;
  for (const n of ['.staging-C-1-old', '.staging-file']) utimesSync(join(sealRoot, n), old, old);
  // The link's target is old too, so only the "never a link" check keeps the link.
  utimesSync(join(dir, 'elsewhere'), old, old);
  const out = await cleanupPass({ rec: recWith(), rules: R, now, copiesRoot, sealRoot, mirrorFor: () => null, alert: () => {} });
  assert.deepEqual(out, [['.staging-C-1-old', { result: 'removed', reasons: ['a staging folder left by a killed run'] }]]);
  assert.deepEqual(readdirSync(sealRoot).sort(), ['.staging-C-2-fresh', '.staging-file', '.staging-link']);
  assert.ok(existsSync(join(dir, 'elsewhere')));
});

test("audit 0b-6 r3 MIN-5 (J7): Joe's delete is refused when the record now names another copy for the card; the copy stays", async () => {
  const w = world();
  writeFileSync(join(w.copy, 'a.txt'), 'changed\n');
  const rec = recFor(w);
  await clean(w, rec);
  const cur = rec.read('ask', ASK_ID('C-1'));
  answerAsk(rec, YES);
  const [, lid, ldoc] = launchFor(join(w.dir, 'another'), 'L-2', T0 - MIN);
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'launch', id: lid, expectRev: 0, doc: ldoc }).ok, true, 'a newer launch names another copy');
  const r = await clean(w, rec, { rules: COUNTED });
  assert.equal(r.result, 'refused');
  assert.match(r.reasons.join(' '), /record names another copy/);
  assert.ok(existsSync(w.copy));
});

// L367: the copy is the one on the launch the Record took last, whatever launched_at says.
test('L367: a launch stamped far ahead does not outrank a later launch', () => {
  const rec = recWith([launchFor('/copies/old', 'L-1', T0 + 365 * 24 * 60 * MIN), launchFor('/copies/new', 'L-2', T0 - MIN)]);
  assert.equal(namedCopy(rec, 'C-1'), '/copies/new');
  // L412 m3: launches that can't be read never read as none.
  const broken = Object.create(rec, { list: { value: (e) => { if (e === 'launch') throw new Error('the launches could not be read'); return rec.list(e); } } });
  assert.throws(() => namedCopy(broken, 'C-1'), /the launches could not be read/);
});

// L744 3: a copies folder that is missing is nothing to do; one that can't be read fails the step, never "no copies".
test('L744 3: cleanupPass reads a missing copies folder as nothing to do, and fails on one it cannot read', { skip: process.getuid?.() === 0 ? 'root reads any folder' : false }, async () => {
  const dir = tempDir('m11-l744-');
  const args = (copiesRoot) => ({ rec: recWith(), rules: R, now: T0, copiesRoot, sealRoot: null, mirrorFor: () => null, alert: fakeAlert() });
  assert.deepEqual(await cleanupPass(args(join(dir, 'none'))), []);
  const shut = join(dir, 'copies');
  mkdirSync(join(shut, 'C-1'), { recursive: true });
  chmodSync(shut, 0o000);
  try {
    await assert.rejects(cleanupPass(args(shut)), /the copies folder could not be read \(EACCES\)/);
  } finally { chmodSync(shut, 0o755); }
  const file = join(dir, 'a-file'); writeFileSync(file, 'x');
  await assert.rejects(cleanupPass(args(file)), /the copies folder could not be read \(ENOTDIR\)/);
});

// L755 (audit #311/314/315 r1 m2): the seal folder, as L744 3 the copies folder. Missing is nothing to sweep; one that can't
// be read fails the step (the tick tells it), never "nothing to sweep", and never before a stale staging folder is seen.
test('L755: sweepStaging reads a missing seal folder as nothing to do, and fails on one it cannot read', { skip: process.getuid?.() === 0 ? 'root reads any folder' : false }, async () => {
  const dir = tempDir('m11-l755-');
  const copies = join(dir, 'copies'); mkdirSync(copies);
  const args = (sealRoot) => ({ rec: recWith(), rules: R, now: T0, copiesRoot: copies, sealRoot, mirrorFor: () => null, alert: fakeAlert() });
  assert.deepEqual(sweepStaging(join(dir, 'none'), T0), []);
  assert.deepEqual(await cleanupPass(args(join(dir, 'none'))), []);
  const seal = join(dir, 'seal');
  mkdirSync(join(seal, '.staging-old'), { recursive: true });
  chmodSync(seal, 0o000);
  try {
    assert.throws(() => sweepStaging(seal, T0), /the seal folder could not be read \(EACCES\)/);
    await assert.rejects(cleanupPass(args(seal)), /the seal folder could not be read \(EACCES\)/);
  } finally { chmodSync(seal, 0o755); }
  const file = join(dir, 'a-file'); writeFileSync(file, 'x');
  await assert.rejects(cleanupPass(args(file)), /the seal folder could not be read \(ENOTDIR\)/);
});

// L836: copies are <copiesRoot>/<product>/<card>. The pass walks each product's folder; a copy in another product's
// folder, a folder at the top that is no product's, or a product folder that is a link, is never touched.
test('L836: cleanupPass walks each product\'s folder and touches no copy outside its card\'s own product', { skip: process.getuid?.() === 0 ? 'root reads any folder' : false }, async () => {
  const w = world();
  // C-1 is product p1's; a folder of that name in p2's folder is not its copy.
  mkdirSync(join(w.copiesRoot, 'p2', 'C-1'), { recursive: true });
  writeFileSync(join(w.copiesRoot, 'p2', 'C-1', 'x'), 'p2');
  mkdirSync(join(w.copiesRoot, 'C-7'));             // the old flat layout: no product's folder
  mkdirSync(join(w.copiesRoot, 'c-8'));             // a flat card folder with a product's shape, but no product (m2)
  writeFileSync(join(w.copiesRoot, 'c-8', 'x'), 'flat');
  mkdirSync(join(w.copiesRoot, 'worker'));          // a role's name is no product's
  mkdirSync(join(w.dir, 'elsewhere', 'C-1'), { recursive: true });
  symlinkSync(join(w.dir, 'elsewhere'), join(w.copiesRoot, 'p3'));
  writeFileSync(join(w.copiesRoot, 'p4'), 'a file');
  const rec = recFor(w);
  // m4: every copy handed to saveWork, and every ask made, is recorded, so p2's C-1 is shown never bundled nor asked.
  const saved = [];
  const saveWork = async (x, ...rest) => { saved.push(x); return locked(x, ...rest); };
  const alerts = [];
  const out = await cleanupPass({ rec, rules: R, now: T0, copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirrorFor: () => w.mirror,
    git: guardedGit(w.copiesRoot), saveWork, alert: (a) => alerts.push(a) });
  const by = (k) => out.filter(([c]) => c === k).map(([, r]) => r);
  assert.deepEqual(out.map(([c, r]) => [c, r.result]), [['C-7', 'kept'], ['c-8', 'kept'], ['C-1', 'deleted'], ['C-1', 'kept'], ['p3', 'kept'], ['p4', 'kept'], ['worker', 'kept']]);
  assert.match(by('C-1')[1].reasons.join(), /the copy is in product p2's folder, but the card is product p1's/);
  assert.match(by('C-7')[0].reasons.join(), /not a product's copies folder/);
  assert.match(by('c-8')[0].reasons.join(), /no product of that name/);
  assert.equal(readFileSync(join(w.copiesRoot, 'c-8', 'x'), 'utf8'), 'flat', 'a flat folder is never entered');
  const p2copy = join(w.copiesRoot, 'p2', 'C-1');
  assert.ok(!JSON.stringify(saved).includes(p2copy), 'another product\'s folder is never bundled');
  assert.ok(!JSON.stringify(alerts).includes(p2copy), 'nor asked about');
  // m1: the mismatch is kept with no note, so it does not grow the Record on every pass.
  assert.ok(!/p2's folder/.test(JSON.stringify(rec.read('fact', CLEANUP_FACT('C-1'))?.doc ?? null)), 'no note names it');
  assert.match(by('worker')[0].reasons.join(), /named as a role/);
  assert.match(by('p3')[0].reasons.join(), /not a real folder/);
  assert.ok(!existsSync(w.copy), 'its own copy, proven, is deleted');
  assert.equal(readFileSync(join(w.copiesRoot, 'p2', 'C-1', 'x'), 'utf8'), 'p2', 'another product\'s folder is untouched');
  for (const p of ['C-7', 'worker', join('..', 'elsewhere', 'C-1')]) assert.ok(existsSync(join(w.copiesRoot, p)), p);
  // A product folder that can't be read fails the step, as the copies folder does (L744 3).
  chmodSync(join(w.copiesRoot, 'p2'), 0o000);
  try {
    await assert.rejects(cleanupPass({ rec, rules: R, now: T0, copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirrorFor: () => w.mirror, git: guardedGit(w.copiesRoot), saveWork: locked, alert: () => {} }),
      /product p2's copies folder could not be read \(EACCES\)/);
  } finally { chmodSync(join(w.copiesRoot, 'p2'), 0o755); }
});

test('L836: cleanupCopy refuses a card or product that names no plain place, and a card of another product', async () => {
  const w = world();
  const rec = recFor(w);
  // A card whose own product names no folder the runner can hold has no copy place (product-paths runnerCopy).
  for (const odd of ['..', 'Worker', 'P1']) {
    const r = await clean(w, recFor(w, { card: { product: odd } }), { product: odd });
    assert.equal(r.result, 'refused', odd);
    assert.match(r.reasons.join(), /the copy has no place/, odd);
  }
  for (const [product, why] of [['P1', /the copy is in product P1's folder, but the card is product p1's/]]) {
    const r = await clean(w, rec, { product });
    assert.equal(r.result, 'kept', String(product));
    assert.match(r.reasons.join(), why, String(product));
  }
  const noProduct = recFor(w, { card: { product: undefined } });
  const r = await clean(w, noProduct, { product: '..' });
  assert.match(r.reasons.join(), /the card is no product's/);
  assert.ok(existsSync(w.copy), 'nothing was deleted');
  const none = await cleanupCopy({ rec, rules: R, now: T0, card: 'C-1', copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirror: w.mirror, git: guardedGit(w.copiesRoot), saveWork: locked, alert: () => {} });
  assert.equal(none.result, 'kept', 'no product folder named: never the card\'s own by default');
  assert.ok(existsSync(w.copy));
  const bad = await cleanupCopy({ rec, rules: R, now: T0, card: '../C-1', product: 'p1', copiesRoot: w.copiesRoot, sealRoot: w.sealRoot, mirror: w.mirror, git: guardedGit(w.copiesRoot), saveWork: locked, alert: () => {} });
  assert.deepEqual(bad.reasons, ['bad card id']);
});
