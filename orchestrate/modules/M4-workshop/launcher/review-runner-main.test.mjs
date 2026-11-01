// review-runner-main.test.mjs — lead call L65: the review runner's real ports, its installed-copy check, the account
// copy and the two LaunchDaemon files. Nothing here starts claude, runs as another user or touches the system folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { installProblem, programsProblem, readCardFile, recordVerdictTaken, adminAnswer, sessionsFrom, realPorts, readConfig, readInstallStamp } from './review-runner-main.mjs';
import { readOutboxFile } from '../../M9-record/outbox.mjs';
import { STAMP, installStamp } from './review-daemons.mjs';
import { reviewDaemonPlists } from './review-daemons.mjs';
import { readAccountFile, copyAccountTo, useAccount, ACCOUNT_FILE } from './accounts.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { git, gitOk } from '../git/safe-git.mjs';

const ME = process.getuid();

test('L65: the installed copy must be root\'s alone, with the runner, config and wiring inside it', () => {
  const base = tempDir('m4-install-');
  mkdirSync(join(base, 'a', 'b'), { recursive: true });
  writeFileSync(join(base, 'a', 'b', 'x.mjs'), '');
  for (const p of [base, join(base, 'a'), join(base, 'a', 'b')]) chmodSync(p, 0o755);
  chmodSync(join(base, 'a', 'b', 'x.mjs'), 0o644);
  // This test's user stands in for root.
  assert.equal(installProblem(base, [join(base, 'a', 'b', 'x.mjs')], { owner: ME, top: base }), null);
  // The real check wants root, which this user is not.
  assert.match(installProblem(base, [], {}), /is not owned by root/);
  assert.match(installProblem(base, ['/elsewhere/wiring.mjs'], { owner: ME, top: base }), /not inside the installed copy/);
  assert.match(installProblem(base, [join(base, '..', 'x')], { owner: ME, top: base }), /not inside the installed copy/);
  chmodSync(join(base, 'a', 'b', 'x.mjs'), 0o664);
  assert.match(installProblem(base, [], { owner: ME, top: base }), /x\.mjs can be written by others than root/);
  chmodSync(join(base, 'a', 'b', 'x.mjs'), 0o644);
  symlinkSync('/tmp', join(base, 'a', 'l'));
  assert.match(installProblem(base, [], { owner: ME, top: base }), /a\/l is a link/);
});

test('L66 M2: what a review runs (claude, node, the hooks folder) must be inside the installed copy and root\'s alone', async () => {
  const base = tempDir('m4-progs-');
  const out = tempDir('m4-progs-out-');
  for (const d of ['bin', 'hooks', 'modules']) mkdirSync(join(base, d), { mode: 0o755 });
  const files = { self: join(base, 'modules', 'runner.mjs'), config: join(base, 'review.json'), wiring: join(base, 'wiring.mjs'), claude: join(base, 'bin', 'claude'), node: join(base, 'bin', 'node') };
  for (const f of Object.values(files)) writeFileSync(f, '', { mode: 0o644 });
  writeFileSync(join(base, 'hooks', 'plain-files.mjs'), '', { mode: 0o644 });
  for (const p of [base, join(base, 'bin'), join(base, 'hooks'), join(base, 'modules')]) chmodSync(p, 0o755);
  for (const p of [out]) chmodSync(p, 0o755);
  const c = { installRoot: base, wiring: files.wiring, claudeBin: files.claude, hooksDir: join(base, 'hooks') };
  const check = (over = {}, node = files.node) => programsProblem({ ...c, ...over }, { self: files.self, config: files.config, node, owner: ME, top: base });
  // This test's user stands in for root; with everything inside, nothing is wrong.
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
  // The ports hand what was checked to the wiring's start.
  let got;
  const ports = realPorts({ ...c, uids: { reviewer: ME } }, { start: (x) => { got = x; return { ok: true, pid: 1 }; } }, { node: files.node });
  await ports.start({ role: 'reviewer' });
  assert.deepEqual(got, { role: 'reviewer', claudeBin: files.claude, node: files.node, hooksDir: join(base, 'hooks') });
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
  assert.match(check({ lstat: other }), /q, above the installed copy, is not owned by root/);
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
  // A session with no outbox folder has handed nothing in, and that is a failed try, never a throw.
  const h = p.handedIn({ role: 'reviewer', sessionId: 'S-1', card: 'C-1', head: 'a'.repeat(40) });
  assert.equal(h.ok, false);
  assert.equal(h.none, true);
  assert.match(h.reason, /no verdict was handed in \(no outbox folder\)/);
});

test('L65: the config names every path as a full path', () => {
  const d = tempDir('m4-cfg-');
  const good = { installRoot: '/i', root: '/r', outboxRoot: '/o', reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' };
  writeFileSync(join(d, 'c.json'), JSON.stringify(good));
  assert.equal(readConfig(join(d, 'c.json')).mirror, '/m');
  writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, mirror: 'm' }));
  assert.throws(() => readConfig(join(d, 'c.json')), /mirror must be an absolute path/);
  const { hooksDir, ...noHooks } = good;
  writeFileSync(join(d, 'c.json'), JSON.stringify(noHooks));
  assert.throws(() => readConfig(join(d, 'c.json')), /hooksDir must be an absolute path/);
  writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, recordUid: '5' }));
  assert.throws(() => readConfig(join(d, 'c.json')), /recordUid must be a uid/);
});

test('L68 planted: the runner\'s folder and review\'s outbox are two walls: one inside the other, or the same, is refused', () => {
  const d = realpathSync(tempDir('m4-cfg-'));
  const good = { installRoot: '/i', root: join(d, 'review'), outboxRoot: join(d, 'outbox'), reviewHome: '/h', uids: {}, recordRoot: '/x', recordUid: 5, mirror: '/m', claudeBin: '/c', hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: 5, wiring: '/i/w.mjs' };
  const cfg = (over) => { writeFileSync(join(d, 'c.json'), JSON.stringify({ ...good, ...over })); return () => readConfig(join(d, 'c.json')); };
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
  assert.match(p.accountCopy, /<string>copy-to<\/string><string>\/I\/account<\/string><string>--home<\/string><string>\/W<\/string><string>--owner<\/string><string>501<\/string>/);
  assert.match(p.accountCopy, /<key>WatchPaths<\/key><array><string>\/W\/\.claude-account<\/string><\/array>/);
  for (const t of [p.runner, p.accountCopy]) assert.doesNotMatch(t, /homebrew|\/usr\/local/);
  assert.throws(() => reviewDaemonPlists({ label: 'x y' }), /bad job label/);
  assert.throws(() => reviewDaemonPlists({ label: 'x', installRoot: 'I' }), /installRoot must be an absolute path/);
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
