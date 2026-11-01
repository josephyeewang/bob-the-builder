// review-runner-main.test.mjs — lead call L65: the review runner's real ports, its installed-copy check, the account
// copy and the two LaunchDaemon files. Nothing here starts claude, runs as another user or touches the system folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { templateFile } from './review-settings.mjs';
import { installProblem, programsProblem, readCardFile, recordVerdictTaken, adminAnswer, sessionsFrom, realPorts, readConfig, readInstallStamp, readJoeTaps, readyProblem, reviewCopyPath, prepareReviewCopy, WIRING_EXPORTS, holdersOf, main } from './review-runner-main.mjs';
import { parseSnapshot } from '../hooks/snapshot.mjs';
import { readOutboxFile } from '../../M9-record/outbox.mjs';
import { STAMP, installStamp } from './review-daemons.mjs';
import { reviewDaemonPlists } from './review-daemons.mjs';
import { readAccountFile, copyAccountTo, copyFromInstalledCopy, useAccount, ACCOUNT_FILE } from './accounts.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { git, gitOk } from '../git/safe-git.mjs';

const ME = process.getuid();
// R-0b-163: the keys readConfig now also requires, with the snapshot inside each config's own root.
const withR163 = (c) => ({ snapshot: join(c.root, 'rules-snapshot.json'), bobFolder: '/b', deny: ['/d'], reviewCopies: '/rc', workerCopies: '/wc', pin: '2.1.316', machineWide: '/ms.json', rules: { production: { env_files: [], programs: [], hosts: [] } }, ...c });

test('L65: the installed copy must be root\'s alone, with the runner, config and wiring inside it', () => {
  const base = tempDir('m4-install-');
  mkdirSync(join(base, 'a', 'b'), { recursive: true });
  writeFileSync(join(base, 'a', 'b', 'x.mjs'), '');
  for (const p of [base, join(base, 'a'), join(base, 'a', 'b')]) chmodSync(p, 0o755);
  chmodSync(join(base, 'a', 'b', 'x.mjs'), 0o644);
  // This test's user stands in for root.
  assert.equal(installProblem(base, [join(base, 'a', 'b', 'x.mjs')], { owner: ME, top: base }), null);
  // The real owner check wants root, which this user is not. The walk stops at the test's folder, so what is above the
  // temp folder on this machine (a link, or a folder anyone can write) can't answer first.
  assert.match(installProblem(base, [], { top: base }), /is not owned by root/);
  assert.match(installProblem(base, ['/elsewhere/wiring.mjs'], { owner: ME, top: base }), /not inside the installed copy/);
  assert.match(installProblem(base, [join(base, '..', 'x')], { owner: ME, top: base }), /not inside the installed copy/);
  chmodSync(join(base, 'a', 'b', 'x.mjs'), 0o664);
  assert.match(installProblem(base, [], { owner: ME, top: base }), /x\.mjs can be written by others than root/);
  chmodSync(join(base, 'a', 'b', 'x.mjs'), 0o644);
  symlinkSync('/tmp', join(base, 'a', 'l'));
  assert.match(installProblem(base, [], { owner: ME, top: base }), /a\/l is a link/);
});

test('L66 M2: what a review runs (claude, node, the hooks folder) must be inside the installed copy and root\'s alone', async () => {
  // The copy as the updater lays it out (L75 M-1): a versioned folder and root's link to it, named through the link.
  const top = tempDir('m4-progs-');
  const C = 'c'.repeat(40);
  // L92 item 4: the link names orchestrate/ inside the versioned folder; the stamp is at the top of that folder.
  const vFolder = join(top, `inst.v-${C}`);
  const realBase = join(vFolder, 'orchestrate');
  mkdirSync(realBase, { recursive: true, mode: 0o755 });
  const base = join(top, 'inst');
  symlinkSync(`inst.v-${C}/orchestrate`, base);
  writeFileSync(join(vFolder, STAMP), installStamp(C), { mode: 0o644 });
  const out = tempDir('m4-progs-out-');
  for (const d of ['bin', 'hooks', 'modules']) mkdirSync(join(base, d), { mode: 0o755 });
  const files = { self: join(base, 'modules', 'runner.mjs'), config: join(base, 'review.json'), wiring: join(base, 'modules', 'wiring.mjs'), claude: join(base, 'bin', 'claude'), node: join(base, 'bin', 'node') };
  for (const f of Object.values(files)) writeFileSync(f, '', { mode: 0o644 });
  writeFileSync(join(base, 'hooks', 'plain-files.mjs'), '', { mode: 0o644 });
  // Each review role's settings template (L67), where the updater copies it in with the rest of the folder.
  const tdir = dirname(templateFile(base, 'reviewer'));
  mkdirSync(tdir, { recursive: true });
  for (const r of ['reviewer', 'auditor']) writeFileSync(templateFile(base, r), '{}', { mode: 0o644 });
  for (const p of [base, join(base, 'bin'), join(base, 'hooks'), join(base, 'modules'), join(base, 'modules', 'M4-workshop'), dirname(tdir), tdir]) chmodSync(p, 0o755);
  for (const p of [out]) chmodSync(p, 0o755);
  const c = { installRoot: base, wiring: files.wiring, claudeBin: files.claude, hooksDir: join(base, 'hooks'), reviewCopies: '/rc' };
  const check = (over = {}, node = files.node) => programsProblem({ ...c, ...over }, { self: files.self, config: files.config, node, owner: ME, top });
  // This test's user stands in for root; with everything inside, nothing is wrong.
  assert.equal(check(), null);
  // The stamp must be the commit the folder is named for; and a plain folder where the link should be is refused (c-7).
  writeFileSync(join(vFolder, STAMP), installStamp('d'.repeat(40)), { mode: 0o644 });
  assert.match(check(), /the copy's commit stamp \(d{40}\) is not the commit its folder is named for \(c{40}\)/);
  writeFileSync(join(vFolder, STAMP), installStamp(C), { mode: 0o644 });
  const byReal = (f) => f.replace(base, realBase);
  assert.match(programsProblem({ installRoot: realBase, wiring: byReal(files.wiring), claudeBin: byReal(files.claude), hooksDir: join(realBase, 'hooks') },
    { self: byReal(files.self), config: byReal(files.config), node: byReal(files.node), owner: ME, top }), /inst\.v-c{40}\/orchestrate is a plain folder, not the installed copy's link/);
  // A template that is missing, or one others can write, refuses by name (L67).
  unlinkSync(templateFile(base, 'auditor'));
  assert.match(check(), /templates\/auditor\.settings\.json is missing/);
  writeFileSync(templateFile(base, 'auditor'), '{}', { mode: 0o644 });
  chmodSync(templateFile(base, 'reviewer'), 0o666);
  assert.match(check(), /templates\/reviewer\.settings\.json can be written by others than root/);
  chmodSync(templateFile(base, 'reviewer'), 0o644);
  assert.equal(check(), null);
  assert.match(programsProblem(c, { self: files.self, config: files.config, node: files.node }), /is not owned by root/);
  // Each one outside the installed copy refuses, by name.
  writeFileSync(join(out, 'claude'), '', { mode: 0o644 });
  mkdirSync(join(out, 'hooks'), { mode: 0o755 });
  writeFileSync(join(out, 'node'), '', { mode: 0o644 });
  assert.match(check({ claudeBin: join(out, 'claude') }), new RegExp(`${join(out, 'claude')} is not inside the installed copy`));
  assert.match(check({ hooksDir: join(out, 'hooks') }), new RegExp(`${join(out, 'hooks')} is not inside the installed copy`));
  assert.match(check({}, join(out, 'node')), new RegExp(`${join(out, 'node')} is not inside the installed copy`));
  assert.match(check({ hooksDir: `${base}/../${out.split('/').pop()}/hooks` }), /is not inside the installed copy/);
  // One that others can write refuses, inside or not; so does a missing one, and the installed copy itself.
  chmodSync(join(base, 'hooks'), 0o775);
  assert.match(check(), new RegExp(`${join(base, 'hooks')} can be written by others than root`));
  chmodSync(join(base, 'hooks'), 0o755);
  chmodSync(files.claude, 0o666);
  assert.match(check(), /bin\/claude can be written by others than root/);
  chmodSync(files.claude, 0o644);
  assert.match(check({ claudeBin: join(base, 'bin', 'gone') }), /bin\/gone is missing/);
  assert.match(check({ hooksDir: base }), /is not inside the installed copy/);
  // L132 M-1: the wiring and the budget module, which the runner imports, must be the copy's own code files, .mjs files
  // under its modules/ or shared/ folder. A copy item the install step put at the top of the copy, a folder or the
  // config is refused: the runner would import it and fail on its first import of the copy's own files.
  const own = /is not one of the copy's own code files \(a \.mjs file under its modules\/ or shared\/ folder\)/;
  writeFileSync(join(base, 'kept-wiring.mjs'), '', { mode: 0o644 });
  writeFileSync(join(base, 'modules', 'x.js'), '', { mode: 0o644 });
  mkdirSync(join(base, 'shared'), { mode: 0o755 });
  chmodSync(join(base, 'shared'), 0o755);
  writeFileSync(join(base, 'shared', 'b.mjs'), '', { mode: 0o644 });
  mkdirSync(join(base, 'modules', 'dir.mjs'), { mode: 0o755 });
  chmodSync(join(base, 'modules', 'dir.mjs'), 0o755);
  for (const k of ['wiring', 'budget']) {
    const at = (p) => check({ [k]: p });
    const says = (p, re) => assert.match(at(p), new RegExp(`^the runner's ${k}, ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, ${re.source}`), `${k} = ${p}`);
    says(join(base, 'kept-wiring.mjs'), own);
    says(files.config, own);
    says(join(base, 'modules', 'M4-workshop'), own);
    says(join(base, 'modules', 'dir.mjs'), /is not a file/);
    says(join(base, 'modules', 'x.js'), own);
    // One of the copy's own modules is accepted, under modules/ or shared/, named through the link or by its real path.
    assert.equal(at(files.self), null, `${k}: a module under modules/`);
    assert.equal(at(join(base, 'shared', 'b.mjs')), null, `${k}: a module under shared/`);
    assert.equal(at(byReal(files.self)), null, `${k}: by its real path`);
  }
  // m-b (audit r2 N22): the budget module is on the root's-alone check like the wiring. One outside the copy, others can
  // write, or a link is refused by that check, by name; without the budget on it, these pass.
  writeFileSync(join(out, 'budget.mjs'), '', { mode: 0o644 });
  assert.match(check({ budget: join(out, 'budget.mjs') }), new RegExp(`^${join(out, 'budget.mjs')} is not inside the installed copy`));
  assert.match(check({ budget: join(base, 'modules', 'gone.mjs') }), new RegExp(`^${join(base, 'modules', 'gone.mjs')} is missing`));
  symlinkSync(files.self, join(base, 'modules', 'link.mjs'));
  assert.match(check({ budget: join(base, 'modules', 'link.mjs') }), new RegExp(`^${join(base, 'modules', 'link.mjs')} is a link`));
  unlinkSync(join(base, 'modules', 'link.mjs'));
  for (const p of [join(base, 'kept-wiring.mjs'), join(base, 'modules', 'x.js'), join(base, 'shared', 'b.mjs')]) unlinkSync(p);
  rmSync(join(base, 'modules', 'dir.mjs'), { recursive: true });
  rmSync(join(base, 'shared'), { recursive: true });
  assert.equal(check(), null);
  // The ports hand what was checked to the wiring's start.
  let got;
  const ports = realPorts({ ...c, uids: { reviewer: ME } }, { start: (x) => { got = x; return { ok: true, pid: 1 }; } }, { node: files.node, owner: ME });
  await ports.start({ role: 'reviewer', sessionId: 'rev-1' });
  const { settingsFor, copy, spawn: sp, makeCopy, launchInputs: li, ...rest } = got;
  // What the launch checks read (L83 M-3): the same hooks folder the settings name, the runner's pin and walls.
  assert.equal(li.hooksDir, join(realBase, 'hooks'));
  assert.deepEqual([li.pin, li.snapshot, li.machineWide, li.reviewHome, li.bobFolder], [c.pin, c.snapshot, c.machineWide, c.reviewHome, c.bobFolder]);
  assert.equal(li.busy, holdersOf);
  assert.deepEqual(li.uids, { reviewer: ME });
  assert.equal(li.budget, null, 'no budget module: check 12 gets no port');
  assert.equal(li.bobManifest, null, 'no Bob file list: check 13 gets no port');
  assert.equal(typeof makeCopy, 'function', 'the step that fills the review copy from the mirror');
  assert.equal(typeof sp, 'function');
  assert.equal(copy, join(c.reviewCopies, 'rev-1'), 'the review copy\'s one path, <reviewCopies>/<session>');
  // The hooks by the copy folder's real path (L75 M-1), as the session's settings name them.
  assert.deepEqual(rest, { role: 'reviewer', sessionId: 'rev-1', claudeBin: files.claude, node: files.node, hooksDir: join(realBase, 'hooks') });
  assert.equal(typeof settingsFor, 'function', 'and the settings maker, bound to this session (review-settings.test.mjs)');
});

test('item 20(b) planted: every folder above the installed copy, up to /, must be root\'s, written by no one else, and not a link', () => {
  const base = tempDir('m4-above-');
  const inst = join(base, 'p', 'q', 'inst');
  mkdirSync(inst, { recursive: true });
  for (const p of [base, join(base, 'p'), join(base, 'p', 'q'), inst]) chmodSync(p, 0o755);
  const check = (opts = {}, root = inst) => installProblem(root, [], { owner: ME, top: base, ...opts });
  assert.equal(check(), null);
  chmodSync(join(base, 'p'), 0o775);
  assert.match(check(), new RegExp(`${join(base, 'p')}, above the installed copy, can be written by others than root`));
  chmodSync(join(base, 'p'), 0o757);
  assert.match(check(), /p, above the installed copy, can be written by others than root/);
  chmodSync(join(base, 'p'), 0o755);
  chmodSync(base, 0o777);
  assert.match(check(), new RegExp(`${base}, above the installed copy, can be written by others than root`), 'up to and with the top');
  chmodSync(base, 0o755);
  // Another user's folder above the copy (the stat port stands in for that user).
  const other = (p) => { const st = lstatSync(p); return p === join(base, 'p', 'q') ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: ME + 1 }) : st; };
  assert.match(check({ lstat: other }), new RegExp(`q, above the installed copy, is not owned by uid ${ME}`));
  // A link above the copy.
  symlinkSync(join(base, 'p'), join(base, 'lp'));
  assert.match(check({}, join(base, 'lp', 'q', 'inst')), /lp, above the installed copy, is a link/);
  // The real check runs to /, which this throwaway folder's parents fail.
  assert.match(installProblem(inst, [], { owner: ME }), /above the installed copy/);
  assert.match(check({}, '/elsewhere'), /is not under/);
});

test('item 20(a): whether the Record took a session\'s verdict is read from its verdict row and the file it names', () => {
  const rec = tempDir('m4-rectaken-');
  const outboxRoot = tempDir('m4-rectaken-out-');
  const uids = { reviewer: ME, auditor: ME };
  const H = 'a'.repeat(40);
  mkdirSync(join(rec, 'docs'), { mode: 0o755 });
  for (const p of [rec, join(rec, 'docs'), outboxRoot]) chmodSync(p, 0o755);
  const ask = (over = {}) => recordVerdictTaken({ recordRoot: rec, recordUid: ME, outboxRoot, uids, role: 'reviewer', sessionId: 'S-1', card: 'C-1', head: H, ...over });
  assert.deepEqual(ask(), { ok: false, reason: 'the Record holds no verdicts yet' });
  mkdirSync(join(rec, 'docs', 'verdict'), { mode: 0o755 });
  chmodSync(join(rec, 'docs', 'verdict'), 0o755);
  assert.equal(ask().reason, 'the Record holds no verdict of session S-1');
  // The session's verdict file, and the row the intake would write for it.
  for (const p of [join(outboxRoot, 'reviewer'), join(outboxRoot, 'reviewer', 'S-1')]) { mkdirSync(p, { mode: 0o755 }); chmodSync(p, 0o755); }
  const file = join(outboxRoot, 'reviewer', 'S-1', 'verdict-S-1.md');
  writeFileSync(file, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 2, fields: { head: H, pass: true } })}\n`, { mode: 0o644 });
  const f = readOutboxFile({ outboxRoot, uids, tag: { role: 'reviewer', sessionId: 'S-1' }, file });
  assert.equal(f.ok, true, f.reason);
  const row = (doc, id = 'verdict-S-1-7') => writeFileSync(join(rec, 'docs', 'verdict', `${id}.json`), JSON.stringify({ entity: 'verdict', id, rev: 1, doc }), { mode: 0o644 });
  const good = { session_id: 'S-1', role: 'reviewer', card: 'C-1', head: H, pass: true, source_key: f.key };
  row(good);
  assert.deepEqual(ask(), { ok: true });
  // Another head, card or role is not this start's verdict.
  assert.match(ask({ head: 'b'.repeat(40) }).reason, /names reviewer on C-1 at aaaaaaa/);
  assert.match(ask({ card: 'C-2' }).reason, /names reviewer on C-1/);
  assert.match(ask({ role: 'auditor' }).reason, /names reviewer on C-1/);
  // A session whose id starts the same (S-1-2) is another session: its good verdict is not S-1's.
  unlinkSync(join(rec, 'docs', 'verdict', 'verdict-S-1-7.json'));
  for (const p of [join(outboxRoot, 'reviewer', 'S-1-2')]) { mkdirSync(p, { mode: 0o755 }); chmodSync(p, 0o755); }
  const file2 = join(outboxRoot, 'reviewer', 'S-1-2', 'verdict-S-1-2.md');
  writeFileSync(file2, readFileSync(file), { mode: 0o644 });
  const f2 = readOutboxFile({ outboxRoot, uids, tag: { role: 'reviewer', sessionId: 'S-1-2' }, file: file2 });
  row({ ...good, session_id: 'S-1-2', source_key: f2.key }, 'verdict-S-1-2-8');
  assert.deepEqual(ask({ sessionId: 'S-1-2' }), { ok: true });
  assert.equal(ask().reason, 'the Record holds no verdict of session S-1');
  row(good);
  // A row whose file has changed since (a second file written over the first) does not count.
  writeFileSync(file, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 2, fields: { head: H, pass: false } })}\n`, { mode: 0o644 });
  assert.match(ask().reason, /is not the one handed in/);
  // A Record that isn't its owner's alone throws: the runner refuses the request and counts nothing.
  chmodSync(join(rec, 'docs'), 0o775);
  assert.throws(() => ask(), /is not the Record owner's alone/);
  chmodSync(join(rec, 'docs'), 0o755);
  assert.equal(ask({ sessionId: '../x' }).reason, 'the start names no session');
});

test('L65: a card is read from the Record read only, as the Record owner\'s plain file', () => {
  const root = tempDir('m4-recread-');
  mkdirSync(join(root, 'docs', 'card'), { recursive: true });
  for (const p of [root, join(root, 'docs'), join(root, 'docs', 'card')]) chmodSync(p, 0o755);
  const put = (id, body, mode = 0o644) => { const p = join(root, 'docs', 'card', `${id}.json`); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), { mode }); chmodSync(p, mode); return p; };
  put('C-1', { entity: 'card', id: 'C-1', rev: 3, doc: { state: 'in_review', head: 'a'.repeat(40), tier: 1 } });
  const read = (card, uid = ME) => readCardFile({ recordRoot: root, recordUid: uid, card });
  assert.deepEqual(read('C-1'), { ok: true, doc: { state: 'in_review', head: 'a'.repeat(40), tier: 1 }, rev: 3 });
  assert.match(read('C-2').reason, /no such card/);
  assert.match(read('../x').reason, /not a card id/);
  assert.match(read('C-1', ME + 1).reason, /not the Record owner's alone/);
  put('C-3', { entity: 'card', id: 'C-1', doc: {} });
  assert.match(read('C-3').reason, /not a card document/);
  put('C-4', '{');
  assert.match(read('C-4').reason, /not JSON/);
  put('C-5', { entity: 'card', id: 'C-5', doc: {} }, 0o666);
  assert.match(read('C-5').reason, /not the Record's own plain file/);
  symlinkSync(join(root, 'docs', 'card', 'C-1.json'), join(root, 'docs', 'card', 'C-6.json'));
  assert.match(read('C-6').reason, /ELOOP/);
  linkSync(join(root, 'docs', 'card', 'C-1.json'), join(root, 'docs', 'card', 'C-7.json'));
  assert.match(read('C-7').reason, /not the Record's own plain file/);
});

test('L65 m-3: the admin answer is yes, no, or an error (which the runner counts as an admin)', () => {
  assert.equal(adminAnswer({ status: 0, stdout: 'yes review is a member of admin\n' }), true);
  assert.equal(adminAnswer({ status: 1, stdout: 'no review is NOT a member of admin\n' }), false);
  assert.throws(() => adminAnswer({ status: null, stdout: '', error: { code: 'ETIMEDOUT' } }), /no answer \(ETIMEDOUT\)/);
  assert.throws(() => adminAnswer({ status: 64, stdout: 'Group not found.' }), /no answer \(exit 64\)/);
});

test('L65 m-7: the session list keeps the pinned claude\'s processes, with their session ids', () => {
  const bin = '/opt/pinned/claude';
  const text = ['  101 /opt/pinned/claude -p --session-id S-1 --x', '  102 /opt/pinned/claude', '  103 /bin/zsh -c x',
    '  104 /opt/pinned/claude-other', `  ${process.pid} /opt/pinned/claude --session-id me`, '  105 /opt/pinned/claude --session-id=S-2'].join('\n');
  assert.deepEqual(sessionsFrom(text, bin), [{ pid: 101, sessionId: 'S-1' }, { pid: 102 }, { pid: 105, sessionId: 'S-2' }]);
});

test('L65 m-5: the account copy is a or b, root\'s; the runner falls back to the owner\'s own file, read only', () => {
  const home = tempDir('m4-acct-');
  chmodSync(home, 0o755);
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.claude-b'));
  const to = join(home, 'copy');
  // No account file means a.
  assert.deepEqual(copyAccountTo({ home, uid: ME, to, dirOwner: ME }), { ok: true, account: 'a' });
  assert.equal(useAccount({ home, name: 'b' }).ok, true);
  // The owner's file can be read by others now (it says a or b, no secret).
  assert.equal(lstatSync(join(home, ACCOUNT_FILE)).mode & 0o777, 0o644);
  assert.deepEqual(copyAccountTo({ home, uid: ME, to, dirOwner: ME }), { ok: true, account: 'b' });
  assert.equal(readFileSync(to, 'utf8'), 'b\n');
  assert.equal(lstatSync(to).mode & 0o777, 0o644);
  assert.deepEqual(readAccountFile({ file: to, uid: ME }), { ok: true, account: 'b' });
  assert.match(readAccountFile({ file: to, uid: 0 }).reason, /not owned by uid 0/);
  assert.match(copyAccountTo({ home, uid: ME + 1, to, dirOwner: ME }).reason, /not owned by uid/);
  writeFileSync(join(home, 'odd'), 'c\n', { mode: 0o644 });
  assert.match(readAccountFile({ file: join(home, 'odd'), uid: ME }).reason, /neither a nor b/);
  symlinkSync(to, join(home, 'link'));
  assert.match(readAccountFile({ file: join(home, 'link'), uid: ME }).reason, /is a link/);
  // The runner's port: the copy first (root's, so here it fails), then the owner's file.
  const c = { root: '/r', outboxRoot: '/o', reviewHome: '/h', uids: { reviewer: ME }, recordRoot: '/x', recordUid: ME, mirror: '/m', claudeBin: '/c', accountCopy: to, ownerHome: home, ownerUid: ME };
  assert.equal(realPorts(c, {}).accountInUse(), 'b');
  assert.equal(realPorts({ ...c, ownerUid: ME + 1 }, {}).accountInUse(), null);
  assert.equal(realPorts({ ...c, ownerHome: join(home, 'nobody') }, {}).accountInUse(), 'a');
});

test('L66: root\'s account copy goes only into a folder of root\'s alone, as a fresh file, never through a link', () => {
  const home = tempDir('m4-acct-');
  chmodSync(home, 0o755);
  const dir = join(home, 'root-only');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const to = join(dir, 'copy');
  assert.deepEqual(copyAccountTo({ home, uid: ME, to, dirOwner: ME }), { ok: true, account: 'a' });
  // The folder must be root's (here this test's user stands in for root) ...
  assert.match(copyAccountTo({ home, uid: ME, to }).reason, new RegExp(`${dir} is not owned by uid 0`));
  // ... and no one else may write it.
  chmodSync(dir, 0o775);
  assert.match(copyAccountTo({ home, uid: ME, to, dirOwner: ME }).reason, /can be written by others/);
  chmodSync(dir, 0o755);
  // A link put where the new file is made, or a file left there, is never written through or over.
  const bait = join(home, 'bait');
  writeFileSync(bait, 'x\n', { mode: 0o644 });
  symlinkSync(bait, `${to}.${process.pid}.tmp`);
  assert.match(copyAccountTo({ home, uid: ME, to, dirOwner: ME }).reason, /could not be made fresh \(EEXIST\)/);
  assert.equal(readFileSync(bait, 'utf8'), 'x\n');
  // The folder as a link, or missing, refuses.
  symlinkSync(dir, join(home, 'dir-link'));
  assert.match(copyAccountTo({ home, uid: ME, to: join(home, 'dir-link', 'copy'), dirOwner: ME }).reason, /is not a plain folder/);
  assert.match(copyAccountTo({ home, uid: ME, to: join(home, 'none', 'copy'), dirOwner: ME }).reason, /is not a plain folder/);
});

test('L75 c-1: root\'s account copy runs only from the installed copy, root\'s alone, with its own node', () => {
  const top = tempDir('m4-acctcopy-');
  chmodSync(top, 0o755);
  const C = 'c'.repeat(40);
  const real = join(top, `inst.v-${C}`, 'orchestrate');
  mkdirSync(join(real, 'bin'), { recursive: true, mode: 0o755 });
  const install = join(top, 'inst');
  symlinkSync(`inst.v-${C}/orchestrate`, install);
  const self = join(real, 'accounts.mjs');
  const node = join(real, 'bin', 'node');
  for (const f of [self, node]) writeFileSync(f, '', { mode: 0o644 });
  const stamp = join(top, `inst.v-${C}`, STAMP);
  writeFileSync(stamp, `${C}\n`, { mode: 0o644 });
  const home = join(top, 'home');
  mkdirSync(home, { mode: 0o755 });
  const dir = join(top, 'root-only');
  mkdirSync(dir, { mode: 0o755 });
  const to = join(dir, 'copy');
  const go = (over = {}) => copyFromInstalledCopy({ install, home, uid: ME, to, self, node, owner: ME, top, ...over });
  assert.deepEqual(go(), { ok: true, account: 'a' });
  assert.equal(readFileSync(to, 'utf8'), 'a\n');
  assert.match(go({ self: join(top, 'accounts.mjs') }).reason, /runs only from the installed copy, root's alone: .*accounts\.mjs is not inside the installed copy/);
  assert.match(go({ node: process.execPath }).reason, /is not inside the installed copy/);
  chmodSync(self, 0o666);
  assert.match(go().reason, /accounts\.mjs can be written by others than root/);
  chmodSync(self, 0o644);
  assert.match(go({ owner: ME + 1 }).reason, /is not owned by uid/);
  assert.match(go({ install: undefined }).reason, /copy-to needs --install <the installed copy>/);
  // L106 m-1: a copy the updater did not finish (no stamp, or another commit's) is refused, as the runner refuses it.
  unlinkSync(stamp);
  assert.match(go().reason, /runs only from an installed copy the updater finished: the copy's commit stamp \(none at .*installed-commit\) is not the commit its folder is named for/);
  writeFileSync(stamp, `${'d'.repeat(40)}\n`, { mode: 0o644 });
  assert.match(go().reason, /stamp \(d{40}\) is not the commit/);
  writeFileSync(stamp, `${C}\n`, { mode: 0o644 });
  assert.deepEqual(go(), { ok: true, account: 'a' });
  // Run as the script from the repository, as a mistaken plist would: refused, and nothing is written.
  const script = join(dirname(new URL(import.meta.url).pathname), 'accounts.mjs');
  const to2 = join(dir, 'copy2');
  const r = spawnSync(process.execPath, [script, 'copy-to', to2, '--home', home, '--owner', String(ME), '--install', install], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: home } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Refused: it runs only from the installed copy, root's alone/);
  assert.equal(existsSync(to2), false);
  const r2 = spawnSync(process.execPath, [script, 'copy-to', to2, '--home', home, '--owner', String(ME)], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: home } });
  assert.match(r2.stderr, /copy-to needs --install/);
});

test('L66 version stamp: the install writes the commit; the runner reads it only as root\'s plain file', () => {
  const C = 'e'.repeat(40);
  assert.equal(installStamp(C), `${C}\n`);
  for (const bad of ['main', 'E'.repeat(40), undefined]) assert.throws(() => installStamp(bad), /40-hex commit/);
  const d = tempDir('m4-stamp-');
  const f = join(d, STAMP);
  assert.equal(readInstallStamp(d, { owner: ME }), null, 'missing');
  writeFileSync(f, installStamp(C), { mode: 0o644 });
  assert.equal(readInstallStamp(d, { owner: ME }), C);
  assert.equal(readInstallStamp(d), null, 'not root\'s');
  chmodSync(f, 0o666);
  assert.equal(readInstallStamp(d, { owner: ME }), null, 'writable by others');
  chmodSync(f, 0o644);
  writeFileSync(f, 'main\n');
  assert.equal(readInstallStamp(d, { owner: ME }), null, 'not a commit');
  // The port hands it to the pass.
  writeFileSync(f, installStamp(C));
  assert.equal(realPorts({ installRoot: d, uids: { reviewer: ME } }, {}).installedCommit(), null, 'the real port wants root\'s');
});

test('L66 pid contract: the real port reads a process\'s command, and the verdict check is M9\'s', async () => {
  const p = realPorts({ uids: { reviewer: ME }, claudeBin: '/pinned/claude', outboxRoot: '/nowhere' }, {});
  assert.equal(p.claudeBin, '/pinned/claude');
  assert.match(p.processName(process.pid), /node/);
  for (const pid of [0, -1, 1.5, '12']) assert.equal(p.processName(pid), null);
  // A session whose outbox folder is gone can't be counted (L71 point 1): never a silence, never a throw.
  const h = p.handedIn({ role: 'reviewer', sessionId: 'S-1', card: 'C-1', head: 'a'.repeat(40) });
  assert.equal(h.ok, false);
  assert.equal(h.none, false);
  assert.match(h.reason, /its outbox folder is gone/);
});

// The wall check on root and outboxRoot (L71) stood in for: every folder is a plain folder of root's that no one else writes.
const OPEN_WALLS = { lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 0, mode: 0o40755 }), acl: () => null };

test('L65: the config names every path as a full path', () => {
  const d = tempDir('m4-cfg-');
  const good = withR163({ installRoot: '/i', root: '/r', outboxRoot: '/o', reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' });
  writeFileSync(join(d, 'c.json'), JSON.stringify(good));
  assert.equal(readConfig(join(d, 'c.json'), OPEN_WALLS).mirror, '/m');
  writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, mirror: 'm' }));
  assert.throws(() => readConfig(join(d, 'c.json'), OPEN_WALLS), /mirror must be an absolute path/);
  const { hooksDir, ...noHooks } = good;
  writeFileSync(join(d, 'c.json'), JSON.stringify(noHooks));
  assert.throws(() => readConfig(join(d, 'c.json'), OPEN_WALLS), /hooksDir must be an absolute path/);
  writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, recordUid: '5' }));
  assert.throws(() => readConfig(join(d, 'c.json'), OPEN_WALLS), /recordUid must be a uid/);
});

test('L68 planted: the runner\'s folder and review\'s outbox are two walls: one inside the other, or the same, is refused', () => {
  const d = realpathSync(tempDir('m4-cfg-'));
  const good = withR163({ installRoot: '/i', root: join(d, 'review'), outboxRoot: join(d, 'outbox'), reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' });
  const cfg = (over) => { writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, ...over })); return () => readConfig(join(d, 'c.json'), OPEN_WALLS); };
  assert.equal(cfg({})().root, join(d, 'review'), 'two folders side by side');
  assert.equal(cfg({ outboxRoot: join(d, 'review-outbox') })().outboxRoot, join(d, 'review-outbox'), 'a name that only starts the same is not inside');
  const walls = /root .* and outboxRoot .* must be two separate folders, neither inside the other/;
  assert.throws(cfg({ outboxRoot: join(d, 'review', 'outbox') }), walls, 'the outbox inside the runner\'s folder');
  assert.throws(cfg({ root: join(d, 'outbox', 'review') }), walls, 'the runner\'s folder inside the outbox');
  assert.throws(cfg({ outboxRoot: join(d, 'review') }), walls, 'the same folder');
  assert.throws(cfg({ outboxRoot: `${join(d, 'review')}/./x/..` }), walls, 'the same folder, spelled another way');
  // A link that names the outbox's place inside the runner's folder is seen through.
  mkdirSync(join(d, 'review'));
  symlinkSync(join(d, 'review'), join(d, 'alias'));
  assert.throws(cfg({ outboxRoot: join(d, 'alias', 'outbox') }), walls, 'through a link');
});

test('L65: the two LaunchDaemons run the installed copy and its own node, the runner as review', () => {
  const p = reviewDaemonPlists({ label: 'org.example.orch', installRoot: '/I', config: '/I/review.json', reviewRoot: '/R', reviewHome: '/H', accountCopy: '/I/account', ownerHome: '/W', ownerUid: 501, logDir: '/L' });
  assert.match(p.runner, /<key>UserName<\/key><string>review<\/string>/);
  assert.match(p.runner, /<array><string>\/I\/bin\/node<\/string><string>\/I\/modules\/M4-workshop\/launcher\/review-runner-main\.mjs<\/string><string>\/I\/review\.json<\/string><\/array>/);
  assert.match(p.runner, /<key>WatchPaths<\/key><array><string>\/R\/requests<\/string><\/array>/);
  assert.match(p.runner, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.doesNotMatch(p.accountCopy, /UserName/);
  assert.match(p.accountCopy, /<string>copy-to<\/string><string>\/I\/account<\/string><string>--home<\/string><string>\/W<\/string><string>--owner<\/string><string>501<\/string><string>--install<\/string><string>\/I<\/string>/);
  assert.match(p.accountCopy, /<key>WatchPaths<\/key><array><string>\/W\/\.claude-account<\/string><\/array>/);
  for (const t of [p.runner, p.accountCopy]) assert.doesNotMatch(t, /homebrew|\/usr\/local/);
  assert.throws(() => reviewDaemonPlists({ label: 'x y' }), /bad job label/);
  assert.throws(() => reviewDaemonPlists({ label: 'x', installRoot: 'I' }), /installRoot must be an absolute path/);
  // The runner's config is the one the updater's `keep` carries over (L73 point 4), at its fixed name in the copy.
  assert.throws(() => reviewDaemonPlists({ label: 'x', installRoot: '/I', config: '/I/config.json', reviewRoot: '/R', reviewHome: '/H', accountCopy: '/I/account', ownerHome: '/W', ownerUid: 501, logDir: '/L' }), /config must be \/I\/review\.json/);
  assert.throws(() => reviewDaemonPlists({ label: 'x', installRoot: '/I', config: '/elsewhere/review.json', reviewRoot: '/R', reviewHome: '/H', accountCopy: '/I/account', ownerHome: '/W', ownerUid: 501, logDir: '/L' }), /config must be \/I\/review\.json/);
});

test('L73 point 7(a): root and outboxRoot are compared on the disk\'s own real paths, so a change of case can\'t set them apart', (t) => {
  const d = realpathSync.native(tempDir('m4-case-'));
  mkdirSync(join(d, 'review', 'outbox'), { recursive: true });
  const upper = join(dirname(d), basename(d).toUpperCase());
  if (!existsSync(upper)) { t.skip('this disk tells case apart'); return; }
  const good = withR163({ installRoot: '/i', root: join(d, 'review'), outboxRoot: join(d, 'outbox'), reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' });
  const file = join(d, 'c.json');
  const cfg = (over) => { writeFileSync(file, JSON.stringify({ ...good, ...over })); return () => readConfig(file, OPEN_WALLS); };
  assert.equal(cfg({})().root, join(d, 'review'), 'the control');
  assert.throws(cfg({ outboxRoot: join(upper, 'review', 'outbox') }), /must be two separate folders/);
  assert.throws(cfg({ outboxRoot: join(upper, 'REVIEW', 'outbox') }), /must be two separate folders/);
  assert.throws(cfg({ root: join(upper, 'review', 'outbox', 'r'), outboxRoot: join(d, 'review') }), /must be two separate folders/, 'a part not made yet keeps its case');
});

// L69 point 4: the runner keys one start per card, tree and role. The real port reads the head's tree through safe-git
// (no inherited settings, no prompts, no network), in a throwaway repository.
test('L69: the real tree port reads a head\'s tree from the mirror; an amend with no code change has the same tree', async () => {
  const d = tempDir('m4-tree-');
  const gd = join(d, '.git');
  const out = async (args, o = {}) => (await git(args, { gitDir: gd, workTree: d, cwd: d, ...o })).stdout.toString('utf8').trim();
  await gitOk(['init', '-q', d], { gitDir: gd });
  writeFileSync(join(d, 'a.txt'), 'one\n');
  await gitOk(['add', 'a.txt'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'one'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['branch', 'card/c-1'], { gitDir: gd, workTree: d, cwd: d });
  const ports = realPorts({ mirror: gd, uids: { reviewer: process.getuid() } }, {});
  const head = await ports.currentHead('C-1');
  assert.match(head, /^[0-9a-f]{40}$/);
  const tree = await ports.treeOf('C-1', head);
  assert.equal(tree, await out(['rev-parse', `${head}^{tree}`]));
  // An amend with only a new message: a new head, the same tree.
  await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--amend', '-m', 'one, again'], { gitDir: gd, workTree: d, cwd: d });
  const amend = await out(['rev-parse', 'HEAD']);
  assert.notEqual(amend, head);
  assert.equal(await ports.treeOf('C-1', amend), tree);
  // A code change: a new tree.
  writeFileSync(join(d, 'a.txt'), 'two\n');
  await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'two'], { gitDir: gd, workTree: d, cwd: d });
  assert.notEqual(await ports.treeOf('C-1', await out(['rev-parse', 'HEAD'])), tree);
  // A head git does not have, or one that is not 40 hex, is a throw (the runner refuses the request).
  await assert.rejects(ports.treeOf('C-1', 'e'.repeat(40)), /the head's tree is not in the mirror/);
  await assert.rejects(ports.treeOf('C-1', 'HEAD'), /the head is not 40 hex/);
  // Joe's taps: none until the phone link is wired.
  assert.deepEqual(ports.setAsideByJoe(), []);
});

// L70 point 3: a "review again" tap is a file of Joe's own Mac user, in a folder of his that no one else writes. Nothing
// the workers' Mac user writes can be one.
test('L70 planted: Joe\'s taps are read only as the owner\'s own files, in the owner\'s own folder', () => {
  const ME = process.getuid();
  const base = tempDir('m4-taps-');
  chmodSync(base, 0o755);
  const dir = join(base, 'taps');
  mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755);
  const tap = (sid, doc = { session_id: sid }, mode = 0o644) => { const p = join(dir, `${sid}.json`); writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode }); chmodSync(p, mode); return p; };
  assert.deepEqual(readJoeTaps({ dir: undefined, ownerUid: ME }), [], 'none configured: none');
  const p1 = tap('S-1');
  let got = readJoeTaps({ dir, ownerUid: ME });
  assert.deepEqual(got.map((t) => t.session_id), ['S-1']);
  assert.match(got[0].key, /^S-1\.json:[0-9.]+:[0-9a-f]{64}$/);
  assert.equal(readJoeTaps({ dir, ownerUid: ME })[0].key, got[0].key, 'the same tap has the same key');
  // The folder: the owner's, a plain folder, written by no one else; the same for the folder above it.
  assert.throws(() => readJoeTaps({ dir, ownerUid: ME + 1 }), /the taps folder is not owned by the owner/);
  chmodSync(dir, 0o777);
  try { assert.throws(() => readJoeTaps({ dir, ownerUid: ME }), /the taps folder can be written by others than the owner/); } finally { chmodSync(dir, 0o755); }
  chmodSync(dir, 0o775);
  try { assert.throws(() => readJoeTaps({ dir, ownerUid: ME }), /the taps folder can be written by others than the owner/); } finally { chmodSync(dir, 0o755); }
  chmodSync(base, 0o777);
  try { assert.throws(() => readJoeTaps({ dir, ownerUid: ME }), /the folder above the taps folder can be written by others than the owner/); } finally { chmodSync(base, 0o755); }
  symlinkSync(dir, join(base, 'alias'));
  assert.throws(() => readJoeTaps({ dir: join(base, 'alias'), ownerUid: ME }), /the taps folder is not a plain folder/);
  assert.throws(() => readJoeTaps({ dir: join(base, 'missing'), ownerUid: ME }), /the taps folder is missing/);
  const above = (uid) => (p) => { const st = lstatSync(p); return p === base ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid }) : st; };
  assert.throws(() => readJoeTaps({ dir, ownerUid: ME, lstat: above(ME + 7) }), /the folder above the taps folder is not owned by the owner/);
  assert.equal(readJoeTaps({ dir, ownerUid: ME, lstat: above(0) }).length, 1, 'the folder above may be root\'s');
  // A file of another user (the workers') is ignored; so is one others may write, a link, a misnamed or bad one.
  const ino = lstatSync(p1).ino;
  const other = (fd) => { const st = fstatSync(fd); return st.ino === ino ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: ME + 1 }) : st; };
  assert.deepEqual(readJoeTaps({ dir, ownerUid: ME, fstat: other }), [], 'a tap file owned by the workers\' user is ignored');
  chmodSync(p1, 0o666);
  try { assert.deepEqual(readJoeTaps({ dir, ownerUid: ME }), []); } finally { chmodSync(p1, 0o644); }
  unlinkSync(p1);
  writeFileSync(join(base, 'elsewhere.json'), JSON.stringify({ session_id: 'S-2' }), { mode: 0o644 });
  symlinkSync(join(base, 'elsewhere.json'), join(dir, 'S-2.json'));
  tap('S-3', { session_id: 'S-4' });
  tap('S-5', '{');
  tap('S-6', { session_id: 'S-6', pad: 'x'.repeat(5000) });
  writeFileSync(join(dir, 'S-7.txt'), JSON.stringify({ session_id: 'S-7' }), { mode: 0o644 });
  mkdirSync(join(dir, 'S-8.json'));
  tap('S-9');
  assert.deepEqual(readJoeTaps({ dir, ownerUid: ME }).map((t) => t.session_id), ['S-9']);
  // The config names the folder as an absolute path, or not at all.
  const d = realpathSync(tempDir('m4-cfg-'));
  const good = withR163({ installRoot: '/i', root: join(d, 'review'), outboxRoot: join(d, 'outbox'), reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' });
  const cfg = (over) => { writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, ...over })); return () => readConfig(join(d, 'c.json'), OPEN_WALLS); };
  assert.equal(cfg({})().ownerTaps, undefined);
  assert.equal(cfg({ ownerTaps: '/t' })().ownerTaps, '/t');
  assert.throws(cfg({ ownerTaps: 'taps' }), /ownerTaps must be an absolute path/);
});

// L71 point 1: the runner's folder and review's outbox root, and every folder above each up to the top, are root's or
// review's, written by no one else, and not links. The test's user stands in for review; the top is a throwaway folder.
test('L71 planted: root and outboxRoot, and every folder above them, are root\'s or review\'s alone', () => {
  const d = realpathSync(tempDir('m4-cfg-'));
  chmodSync(d, 0o755);
  const mid = join(d, 'srv');
  mkdirSync(join(mid, 'review'), { recursive: true });
  mkdirSync(join(mid, 'outbox'));
  for (const p of [mid, join(mid, 'review'), join(mid, 'outbox')]) chmodSync(p, 0o755);
  const uidsOf = (reviewer) => ({ ...Object.fromEntries(['lead', 'worker', 'front_door', 'learning', 'writer', 'incident', 'scout', 'thinking'].map((r) => [r, ME + 1])), reviewer, auditor: reviewer });
  const good = withR163({ installRoot: '/i', root: join(mid, 'review'), outboxRoot: join(mid, 'outbox'), reviewHome: '/h', uids: uidsOf(ME), recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' });
  const cfg = (over = {}, opts = { top: d }) => { writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, ...over })); return () => readConfig(join(d, 'c.json'), opts); };
  assert.equal(cfg()().outboxRoot, join(mid, 'outbox'), 'the control: review\'s folders, under review\'s and root\'s');
  // The outbox root open to others: a worker could rename reviewer/ away.
  chmodSync(join(mid, 'outbox'), 0o775);
  assert.throws(cfg(), /config: outboxRoot: .*\/srv\/outbox can be written by others/);
  chmodSync(join(mid, 'outbox'), 0o755);
  // A folder above it open to others: the whole outbox could be swapped.
  chmodSync(mid, 0o777);
  assert.throws(cfg(), /config: root: .*\/srv, above it, can be written by others/);
  chmodSync(mid, 0o755);
  chmodSync(d, 0o775);
  assert.throws(cfg(), /config: root: .*, above it, can be written by others/, 'up to the top too');
  chmodSync(d, 0o755);
  // Owned by someone who is neither root nor review (here: the review uid named is another user's).
  assert.throws(cfg({ uids: uidsOf(ME + 1) }), /config: root: .*\/srv\/review is not owned by root or the review user/);
  // A link, the folder or one above it.
  symlinkSync(join(mid, 'outbox'), join(d, 'outbox-link'));
  assert.throws(cfg({ outboxRoot: join(d, 'outbox-link') }), /config: outboxRoot: .*outbox-link is a link \(name the folder by its real path\)/);
  symlinkSync(mid, join(d, 'srv-link'));
  assert.throws(cfg({ root: join(d, 'srv-link', 'review') }), /config: root: .*srv-link, above it, is a link/);
  // Missing, or not under the top.
  assert.throws(cfg({ outboxRoot: join(mid, 'none') }), /config: outboxRoot: .*\/srv\/none is missing/);
  assert.throws(cfg({}, { top: join(d, 'elsewhere') }), /is not under/);
  // An access list on the outbox root or a folder above it (L73 point 7(c)), which the mode bits don't show.
  const out = join(mid, 'outbox');
  assert.throws(cfg({}, { top: d, acl: (ps) => (ps.includes(out) ? `${out} has an access list (ACL)` : null) }), /config: outboxRoot: .*\/srv\/outbox has an access list/);
  if (process.platform === 'darwin') {
    assert.equal(spawnSync('/bin/chmod', ['+a', 'everyone allow add_file', mid]).status, 0);
    try { assert.throws(cfg(), /config: root: .*\/srv has an access list/); } finally { spawnSync('/bin/chmod', ['-N', mid]); }
    assert.equal(cfg()().outboxRoot, out);
  }
  // The real walk, with no ports: with the review uid named as another user's, the test's own throwaway folder (checked
  // first) is neither root's nor review's, so the walk refuses on any machine, whatever the folders above the temp folder.
  assert.throws(cfg({ uids: uidsOf(ME + 1) }, {}), /config: root: .*\/srv\/review is not owned by root or the review user/);
});

// L71 point 4: a second name for the install stamp can't change root's bytes, so it reads the same.
test('L71 planted: the install stamp reads the same with a second name', () => {
  const C = 'e'.repeat(40);
  const d = tempDir('m4-stamp-');
  writeFileSync(join(d, STAMP), installStamp(C), { mode: 0o644 });
  linkSync(join(d, STAMP), join(d, 'second-name'));
  assert.equal(readInstallStamp(d, { owner: ME }), C);
});

// R-0b-163: the keys the wiring, the snapshot and the review copies need, refused at daemon start when missing or not
// full paths, so a config that would only fail at the first start never gets that far.
test('R-0b-163 planted: readConfig refuses each of snapshot, bobFolder, deny, reviewCopies and workerCopies, missing or relative', () => {
  const d = realpathSync(tempDir('m4-cfg163-'));
  const good = withR163({ installRoot: '/i', root: join(d, 'review'), outboxRoot: join(d, 'outbox'), reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' });
  const cfg = (c) => { writeFileSync(join(d, 'c.json'), JSON.stringify(c)); return () => readConfig(join(d, 'c.json'), OPEN_WALLS); };
  assert.equal(cfg(good)().snapshot, join(d, 'review', 'rules-snapshot.json'));
  for (const k of ['snapshot', 'bobFolder', 'reviewCopies', 'workerCopies']) {
    const { [k]: _, ...missing } = good;
    assert.throws(cfg(missing), new RegExp(`${k} must be an absolute path`), `${k} missing`);
    assert.throws(cfg({ ...good, [k]: 'rel/x' }), new RegExp(`${k} must be an absolute path`), `${k} relative`);
  }
  const { deny: _d, ...noDeny } = good;
  assert.throws(cfg(noDeny), /deny must list absolute paths/, 'deny missing');
  assert.throws(cfg({ ...good, deny: [] }), /deny must list absolute paths/, 'deny empty');
  assert.throws(cfg({ ...good, deny: ['/d', 'rel'] }), /deny must list absolute paths/, 'deny relative');
  // The rules the hooks read: production's three lists, full paths where they are paths.
  const { rules: _r, ...noRules } = good;
  assert.throws(cfg(noRules), /rules.production must list env_files, programs and hosts/);
  assert.throws(cfg({ ...good, rules: { production: { env_files: [], programs: [] } } }), /rules.production must list/);
  assert.throws(cfg({ ...good, rules: { production: { env_files: ['prod-file'], programs: [], hosts: [] } } }), /env_files and secrets.paths must be absolute/);
  assert.throws(cfg({ ...good, rules: { ...good.rules, secrets: { paths: ['keys'] } } }), /env_files and secrets.paths must be absolute/);
  assert.equal(cfg({ ...good, rules: { ...good.rules, secrets: { paths: ['/k'] } } })().rules.secrets.paths[0], '/k');
  // The snapshot is the runner's own file, inside its folder; anywhere else a session could write it.
  const outside = /snapshot .* must be a file inside root/;
  assert.throws(cfg({ ...good, snapshot: join(d, 'outbox', 'rules-snapshot.json') }), outside, 'in the outbox');
  assert.throws(cfg({ ...good, snapshot: join(d, 'rules-snapshot.json') }), outside, 'beside root');
  assert.throws(cfg({ ...good, snapshot: join(d, 'review') }), outside, 'root itself');
  assert.throws(cfg({ ...good, snapshot: `${join(d, 'review')}/../x.json` }), outside, 'out of root, spelled inside');
  // The review copies and the workers' copies are two folders.
  const apart = /reviewCopies and workerCopies must be two separate folders/;
  assert.throws(cfg({ ...good, reviewCopies: '/wc/review' }), apart);
  assert.throws(cfg({ ...good, workerCopies: '/rc' }), apart);
});

test('L83 minor 3 planted: readConfig refuses / itself, and a review copies folder or Bob folder standing over a wall', () => {
  const d = realpathSync(tempDir('m4-cfg83-'));
  const good = withR163({ installRoot: '/i', root: join(d, 'review'), outboxRoot: join(d, 'outbox'), reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs', reviewCopies: join(d, 'rc'), bobFolder: join(d, 'bob') });
  const cfg = (c) => { writeFileSync(join(d, 'c.json'), JSON.stringify(c)); return () => readConfig(join(d, 'c.json'), OPEN_WALLS); };
  assert.equal(cfg(good)().reviewCopies, join(d, 'rc'));
  assert.throws(cfg({ ...good, bobFolder: '/' }), /bobFolder may not be \/ itself/);
  assert.throws(cfg({ ...good, deny: ['/d', '/'] }), /deny may not be \/ itself/);
  assert.throws(cfg({ ...good, deny: ['/./'] }), /deny may not be \/ itself/, 'spelled another way');
  assert.throws(cfg({ ...good, workerCopies: '/' }), /may not be \/ itself|reviewCopies and workerCopies/);
  const sep = (k) => new RegExp(`reviewCopies and ${k} must be two separate folders`);
  assert.throws(cfg({ ...good, reviewCopies: join(d, 'review', 'copies') }), sep('root'), 'inside the runner\'s folder');
  assert.throws(cfg({ ...good, reviewCopies: join(d, 'outbox', 'copies') }), sep('outboxRoot'), 'inside the outbox root');
  assert.throws(cfg({ ...good, reviewCopies: d }), sep('root'), 'holding the runner\'s folder');
  assert.throws(cfg({ ...good, bobFolder: join(d, 'rc', 'bob') }), /bobFolder and reviewCopies must be two separate folders/, 'the Bob folder inside a copy');
  assert.throws(cfg({ ...good, reviewCopies: join(d, 'bob', 'rc') }), /bobFolder and reviewCopies must be two separate folders/, 'the copies inside the Bob folder');
});

test('L83 minor 1 planted: main() refuses a wiring with a second export before any pass, and writes the snapshot before one', async () => {
  const d = realpathSync(tempDir('m4-main-'));
  const config = join(d, 'c.json'); writeFileSync(config, '{}');
  const two = join(d, 'two.mjs'); writeFileSync(two, 'export function start() {}\nexport const settingsFor = () => ({});\n');
  const one = join(d, 'one.mjs'); writeFileSync(one, 'export function start() { return { ok: false, reason: "x" }; }\n');
  const c = { wiring: two, snapshot: join(d, 'rules.json'), rules: { production: { env_files: [], programs: [], hosts: [] } }, uids: { reviewer: ME } };
  const run = async (cfg, extra = {}) => {
    const logs = []; const passes = []; const writes = [];
    const code = await main([config], { log: (s) => logs.push(s), ports: { readConfigFn: () => cfg, programs: () => null, write: (p, r) => writes.push([p, r]), pass: async (ports) => { passes.push(ports); return { ok: true, started: [], refused: [] }; }, ...extra } });
    return { code, logs, passes, writes };
  };
  const bad = await run(c);
  assert.equal(bad.code, 1);
  assert.match(bad.logs.join('\n'), /the wiring must export only start, not settingsFor, start/);
  assert.equal(bad.passes.length, 0, 'no pass runs');
  assert.equal(bad.writes.length, 0);
  const good = await run({ ...c, wiring: one });
  assert.equal(good.code, 0, good.logs.join('\n'));
  assert.deepEqual(good.writes, [[c.snapshot, c.rules]], 'the snapshot is written before the pass');
  assert.equal(good.passes.length, 1);
  assert.equal(typeof good.passes[0].start, 'function');
  // A budget module that hands back no budget leaves check 12 without a port, said in the log; the pass still runs.
  const budget = join(d, 'budget.mjs'); writeFileSync(budget, 'export const budget = () => ({ rules: {} });\n');
  const noBudget = await run({ ...c, wiring: one, budget });
  assert.match(noBudget.logs.join('\n'), /the budget module gave no rules, rec, bandsNow and runningNow; no review starts/);
  assert.equal(noBudget.passes.length, 1);
  // A config the walls refuse, or programs not root's alone, stops it before the wiring is even loaded.
  assert.equal((await run(c, { readConfigFn: () => { throw new Error('config: no'); } })).code, 1);
  const notRoot = await run({ ...c, wiring: one }, { programs: () => 'claude is not root\'s' });
  assert.equal(notRoot.code, 1);
  assert.equal(notRoot.passes.length, 0);
});

test('R-0b-163 (L78) planted: the loaded wiring must export exactly start; a second export or a default is refused', () => {
  assert.deepEqual(WIRING_EXPORTS, ['start']);
  const writes = [];
  const c = { snapshot: '/r/rules-snapshot.json', rules: { production: { env_files: [], programs: [], hosts: [] } } };
  const write = (p, r) => writes.push([p, r]);
  const start = () => ({ ok: true, pid: 1 });
  assert.equal(readyProblem(c, { start }, { write }), null);
  assert.match(readyProblem(c, { start, settingsFor: () => ({}) }, { write }), /the wiring must export only start, not settingsFor, start/);
  assert.match(readyProblem(c, { start, default: start }, { write }), /the wiring must export only start, not default, start/);
  assert.match(readyProblem(c, {}, { write }), /the wiring must export only start, not nothing/);
  assert.match(readyProblem(c, { start: 'start' }, { write }), /the wiring has no start/);
  assert.equal(writes.length, 1, 'a refused wiring writes no snapshot');
});

test('R-0b-163 planted: each pass writes the rules snapshot from the runner\'s own config, and the hooks read it fresh', () => {
  const d = tempDir('m4-snap-');
  const rules = { production: { env_files: ['/srv/app/prod-settings'], programs: ['vercel'], hosts: ['prod.example.invalid'] }, secrets: { paths: ['/k'] } };
  const c = { snapshot: join(d, 'rules-snapshot.json'), rules };
  assert.equal(existsSync(c.snapshot), false);
  assert.equal(readyProblem(c, { start: () => ({}) }), null);
  const snap = parseSnapshot(readFileSync(c.snapshot, 'utf8'));
  assert.equal(snap.ok, true, snap.reason);
  assert.deepEqual(snap.rules, rules);
  // A snapshot that can't be written stops the pass: a missing one would leave every hook refusing, unexplained.
  assert.match(readyProblem({ snapshot: join(d, 'gone', 'x.json'), rules }, { start: () => ({}) }), /the rules snapshot could not be written/);
});

test('R-0b-163: a review copy\'s one path is <reviewCopies>/<session>; anything not a session id is refused', () => {
  assert.equal(reviewCopyPath({ reviewCopies: '/rc' }, 'S-1'), '/rc/S-1');
  for (const bad of ['../x', 'a/b', '', undefined, '.']) assert.throws(() => reviewCopyPath({ reviewCopies: '/rc' }, bad), /not a session id/);
});

test('R-0b-163: the review copy holds the card\'s head with main beside it; a folder already there, or a head the mirror lacks, is refused', async () => {
  const d = tempDir('m4-rcopy-');
  const src = join(d, 'src');
  const gd = join(src, '.git');
  const g = (args) => gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { gitDir: gd, workTree: src, cwd: src });
  mkdirSync(src);
  await gitOk(['init', '-q', src], { gitDir: gd });
  writeFileSync(join(src, 'a.txt'), 'main\n');
  await g(['add', 'a.txt']); await g(['commit', '-q', '-m', 'main']); await g(['branch', '-M', 'main']);
  await g(['switch', '-q', '-c', 'card/c-1']);
  writeFileSync(join(src, 'a.txt'), 'card\n');
  await g(['commit', '-q', '-am', 'card']);
  const head = (await gitOk(['rev-parse', 'HEAD'], { gitDir: gd })).trim();
  const dest = join(d, 'copies', 'S-1');
  mkdirSync(join(d, 'copies'));
  const r = await prepareReviewCopy({ mirror: gd, card: 'C-1', head, dest });
  assert.equal(r.ok, true, r.reason);
  assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'card\n');
  assert.equal(lstatSync(dest).mode & 0o777, 0o700);
  const dg = { gitDir: join(dest, '.git') };
  assert.equal((await gitOk(['rev-parse', 'HEAD'], dg)).trim(), head);
  assert.match((await gitOk(['rev-parse', 'refs/heads/main'], dg)).trim(), /^[0-9a-f]{40}$/, 'main is there for the diff');
  assert.match((await prepareReviewCopy({ mirror: gd, card: 'C-1', head, dest })).reason, /is there already/, 'never reused');
  const lost = join(d, 'copies', 'S-2');
  const r2 = await prepareReviewCopy({ mirror: gd, card: 'C-1', head: 'e'.repeat(40), dest: lost });
  assert.equal(r2.ok, false);
  assert.equal(existsSync(lost), false, 'a failed copy leaves nothing behind');
  assert.match((await prepareReviewCopy({ mirror: gd, card: 'C-1', head: 'HEAD', dest: lost })).reason, /not 40 hex/);
  assert.match((await prepareReviewCopy({ mirror: gd, card: '../x', head, dest: lost })).reason, /not a card id/);
});
