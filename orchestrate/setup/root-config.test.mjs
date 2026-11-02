// Tests for the audit round-2 fixes (L100): root takes orders only from its own file (NEW-1), a base this setup did not make
// is never adopted, and the smaller fixes (m1-m9). Each PLANT breaks one clause and says which check catches it. The pattern
// for every NEW-1 plant: the command must stop with ZERO root steps (the stand-in's log is empty, no user, no folder).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { BASE_MARKER, ORCHESTRATE_READ_ACL, ROOT_CONFIG_PATH, USERS, WORKER_ROLES, baseMarkerPath, folderTable, parseConfig } from './layout.mjs';
import { nodeProblemOf, readConfigFile, realIo } from './mac.mjs';
import { apply, check, plan } from './users-folders.mjs';
import { proofList } from './proofs.mjs';
import { main } from './setup.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';

const RAW = { base: '/Library/orch-test', owner: 'sam', products: ['alpha'] };
const cfg = parseConfig(RAW);
const isDarwin = process.platform === 'darwin';
const P = (s) => `${cfg.base}/${s}`;
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };
const putConfig = (mac, raw = RAW) => { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return f; };
// Runs main as the stand-in's current user with NO config written for it: the test sets up the config (or its fault) itself.
const go = (mac, args) => { const s = sink(); const code = main(args, { io: mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') }; };
const applied = () => { const mac = fakeMac(); putConfig(mac); const r = go(mac, ['users-folders']); assert.equal(r.code, 0, r.text); return mac; };
const noRootStep = (mac) => { assert.deepEqual(mac.log, [], 'a root step ran'); assert.equal(mac.users.size, 1, 'a user was made'); assert.equal(existsSync(mac.at(cfg.base)), false, 'the base was made'); };

test('the happy path: root reads its own config at the fixed place and the whole setup passes', () => {
  const mac = applied();
  assert.deepEqual(check(mac, cfg).filter((r) => !r.ok), []);
  const st = statSync(mac.at(baseMarkerPath(cfg)));
  assert.equal(st.mode & 0o7777, 0o444); assert.deepEqual(mac.owners.get(baseMarkerPath(cfg)), { uid: mac.rootUid, gid: 0 });
});

test('PLANT NEW-1 user-owned config → root refuses it, zero steps (caught by: readConfigFile owner check)', () => {
  const mac = fakeMac(); putConfig(mac); mac.configOwner = mac.rootUid + 1;
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /not owned by root/); noRootStep(mac);
});

test('PLANT NEW-1 linked config → refused, not followed, zero steps (caught by: O_NOFOLLOW)', () => {
  const mac = fakeMac(); const real = join(mac.at('/Library'), 'elsewhere.json'); writeFileSync(real, JSON.stringify(RAW)); chmodSync(real, 0o644);
  symlinkSync(real, mac.at(ROOT_CONFIG_PATH));
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /a link is not followed/); noRootStep(mac);
});

test('PLANT NEW-1 group-writable config → refused, zero steps (caught by: the mode check)', () => {
  const mac = fakeMac(); const f = putConfig(mac); chmodSync(f, 0o664);
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /written by others than root/); noRootStep(mac);
  chmodSync(f, 0o646); assert.equal(go(mac, ['users-folders']).code, 2);
});

test('PLANT NEW-1 config in a folder others can write → refused (caught by: the folder chain check)', () => {
  const mac = fakeMac(); putConfig(mac); chmodSync(mac.at('/Library'), 0o777);
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /folder root's setup config is in is not root's alone/); noRootStep(mac);
});

test('PLANT NEW-1 no config at the fixed place → refused with a plain reason; a config in a home folder is never read as root', () => {
  const mac = fakeMac();
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /config file was not found/); noRootStep(mac);
  const home = join(tempDir('orch-setup-home-'), 'c.json'); writeFileSync(home, JSON.stringify(RAW));
  const r2 = go(mac, ['users-folders', '--config', home]);
  assert.equal(r2.code, 2, r2.text); assert.match(r2.text, /as root this reads only/); noRootStep(mac);
  assert.equal(go(mac, ['check', '--config', home]).code, 2, 'also for a sudo check');
});

test('a config that does not parse is reported without a byte of the file (m4); a folder or a link is no config either', () => {
  const mac = fakeMac(); mac.as = 501;
  const dir = tempDir('orch-setup-cfg-'); const bad = join(dir, 'c.json'); writeFileSync(bad, '{"token": "SECRETVALUE-123" oops');
  const r = go(mac, ['check', '--config', bad]);
  assert.equal(r.code, 2); assert.match(r.text, /not valid JSON/); assert.ok(!/SECRETVALUE/.test(r.text));
  const link = join(dir, 'l.json'); symlinkSync(bad, link);
  assert.match(go(mac, ['check', '--config', link]).text, /a link is not followed/);
  assert.match(go(mac, ['check', '--config', dir]).text, /not a plain file|could not be opened/);
  mac.as = 0; putConfig(mac); writeFileSync(mac.at(ROOT_CONFIG_PATH), '{"x": "SECRETVALUE-456" !'); chmodSync(mac.at(ROOT_CONFIG_PATH), 0o644);
  const r2 = go(mac, ['users-folders']); assert.match(r2.text, /not valid JSON/); assert.ok(!/SECRETVALUE/.test(r2.text));
});

test('readConfigFile: a plain file only, not too big, and the strict rules need root\'s own file', () => {
  const dir = tempDir('orch-setup-cfg-'); const f = join(dir, 'c.json'); writeFileSync(f, '{}'); chmodSync(f, 0o644);
  assert.equal(readConfigFile(f), '{}');
  assert.equal(readConfigFile(f, { strict: true, rootUid: process.getuid(), top: dir }), '{}');
  assert.throws(() => readConfigFile(f, { strict: true, rootUid: process.getuid() + 1, top: dir }), /not owned by root/);
  writeFileSync(join(dir, 'big.json'), 'x'.repeat(70000)); assert.throws(() => readConfigFile(join(dir, 'big.json')), /far bigger/);
  assert.throws(() => readConfigFile(join(dir, 'nope.json')), /not found/);
});

test('PLANT N1 base pointed at an existing root-owned folder (0750, with an access list) → refused, never adopted, zero steps (caught by: baseProblem, no marker)', { skip: !isDarwin }, () => {
  const mac = fakeMac(); putConfig(mac);
  mkdirSync(mac.at(cfg.base)); chmodSync(mac.at(cfg.base), 0o750); mac.owners.set(cfg.base, { uid: mac.rootUid, gid: 0 });
  assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'user:daemon allow list,search,readattr', mac.at(cfg.base)]).status, 0);
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /was not made by this setup/); assert.match(r.text, /nothing was changed/);
  assert.deepEqual(mac.log, []); assert.equal(mac.users.size, 1);
  assert.equal(statSync(mac.at(cfg.base)).mode & 0o7777, 0o750, 'the folder was left as it was');
});

test('PLANT N2 base pointed at an existing user-owned folder holding a planted hooks file → refused, zero steps (caught by: baseProblem)', () => {
  const mac = fakeMac(); putConfig(mac);
  mkdirSync(mac.at(P('hooks')), { recursive: true }); writeFileSync(mac.at(P('hooks/pre-tool.mjs')), 'console.log("planted")\n');
  mac.owners.set(cfg.base, { uid: mac.rootUid + 1, gid: 20 }); mac.owners.set(P('hooks'), { uid: mac.rootUid + 1, gid: 20 });
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /was not made by this setup/);
  assert.deepEqual(mac.log, []); assert.equal(mac.users.size, 1);
  assert.equal(existsSync(mac.at(P('hooks/pre-tool.mjs'))), true, 'nothing was deleted either');
  assert.deepEqual(plan(mac, cfg).ops, [], 'the plan has no op');
});

test('PLANT a forged marker: a user-owned, a linked, a group-writable and a folder marker are all refused (caught by: baseProblem)', () => {
  for (const make of [
    (mac, m) => { writeFileSync(m, 'x'); chmodSync(m, 0o444); mac.owners.set(cfg.base + '/' + BASE_MARKER, { uid: mac.rootUid + 1, gid: 20 }); },
    (mac, m) => { writeFileSync(`${m}.real`, 'x'); symlinkSync(`${m}.real`, m); },
    (mac, m) => { writeFileSync(m, 'x'); chmodSync(m, 0o464); },
    (mac, m) => { mkdirSync(m); },
  ]) {
    const mac = fakeMac(); putConfig(mac); mkdirSync(mac.at(cfg.base)); mac.owners.set(cfg.base, { uid: mac.rootUid, gid: 0 });
    make(mac, mac.at(baseMarkerPath(cfg)));
    const r = go(mac, ['users-folders']);
    assert.equal(r.code, 1, r.text); assert.match(r.text, /was not made by this setup/); assert.deepEqual(mac.log, []);
  }
});

test('the marker is written right after root makes the base, and only on a fresh base; a run cut off after it is picked up', () => {
  const mac = fakeMac(); putConfig(mac);
  const p = plan(mac, cfg);
  const texts = p.ops.map((o) => o.text);
  const i = texts.findIndex((t) => t.startsWith(`mkdir -m 700 ${cfg.base}`));
  assert.ok(i > 0); assert.match(texts[i + 1], /^write .*\.made-by-setup/);
  // cut off after the base and its note: the next run finds the note and finishes the rest
  apply(p.ops.slice(0, i + 2), { log: () => {} });
  const again = plan(mac, cfg);
  assert.deepEqual(again.problems, []); assert.ok(!again.ops.some((o) => /\.made-by-setup/.test(o.text)), 'no second note');
  assert.equal(go(mac, ['users-folders']).code, 0);
  assert.deepEqual(check(mac, cfg).filter((r) => !r.ok), []);
});

test('PLANT a table folder owned by someone who is neither root nor its owner → refused, not taken over (caught by: planFolders)', () => {
  const mac = applied(); const before = mac.log.length;
  mac.owners.set(P('hooks'), { uid: mac.rootUid + 1, gid: 20 });
  const r = go(mac, ['users-folders']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /neither root nor orchestrate/); assert.equal(mac.log.length, before, 'no step ran');
  assert.ok(check(mac, cfg).some((x) => !x.ok && /hooks/.test(x.what)), 'check FAILs it too');
});

test('PLANT an entry planted in a folder only root writes → check FAILs it (caught by: the root-folder contents check)', () => {
  const mac = applied();
  writeFileSync(mac.at(P('rogue.mjs')), 'x'); mkdirSync(mac.at(P('outboxes/rogue')));
  const bad = check(mac, cfg).filter((r) => !r.ok);
  assert.ok(bad.some((r) => /rogue\.mjs/.test(r.why)), JSON.stringify(bad));
  assert.ok(bad.some((r) => /outboxes/.test(r.what) && /rogue/.test(r.why)), JSON.stringify(bad));
});

test('m1 PLANT: a worker outbox folder in the wrong group → check FAILs it and the run puts it right (caught by: the group comparison)', () => {
  const mac = applied(); const w = P(`outboxes/${WORKER_ROLES[0]}`);
  mac.owners.set(w, { uid: mac.owners.get(w).uid, gid: 20 });
  assert.ok(check(mac, cfg).some((x) => !x.ok && x.what.includes(w) && /group is 20, want 0/.test(x.why)));
  assert.equal(go(mac, ['users-folders']).code, 0);
  assert.equal(mac.owners.get(w).gid, 0);
});

test('m2: every table row\'s parent is root\'s, or the row is a direct child of a folder of its own owner (no one can rename another\'s folder away)', () => {
  const rows = folderTable(parseConfig({ ...RAW, products: ['alpha', 'beta'] })); const by = new Map(rows.map((r) => [r.path, r]));
  for (const r of rows) {
    if (r.path === cfg.base) continue;
    const parent = by.get(r.path.slice(0, r.path.lastIndexOf('/')));
    assert.ok(parent, `${r.path} has no parent row`);
    assert.ok(parent.owner === 'root' || parent.owner === r.owner, `${r.path} (${r.owner}) sits in ${parent.path} (${parent.owner})`);
  }
});

test('m2 PLANT: a folder swapped for another between the plan and the access-list step → that step refuses (caught by: the inode check in aclOp)', { skip: !isDarwin }, () => {
  const mac = applied(); const w = P(`outboxes/${WORKER_ROLES[0]}`);
  assert.equal(spawnSync('/bin/chmod', ['-h', '-N', mac.at(w)]).status, 0);
  const p = plan(mac, cfg); assert.deepEqual(p.problems, []);
  const acl = p.ops.find((o) => o.text.startsWith(`set the access list of ${w}`)); assert.ok(acl);
  renameSync(mac.at(w), mac.at(`${w}-moved`)); mkdirSync(mac.at(w));
  assert.throws(() => acl.run(), /not the folder the plan saw/);
});

test('m5: a non-root check never PASSes what it could not see (the password hash), and the stand-in hides it from non-root like the real dscl', () => {
  const mac = applied(); mac.users.get('pages').ShadowHashData = 'abc'; mac.as = 501;
  const bad = check(mac, cfg);
  assert.ok(bad.some((r) => r.skip && /pages has no sign-in record/.test(r.what)));
  assert.ok(!bad.some((r) => r.ok && !r.skip && /pages has no sign-in record/.test(r.what)));
  mac.as = 0;
  assert.ok(check(mac, cfg).some((r) => !r.ok && /pages has no sign-in record/.test(r.what) && /ShadowHashData/.test(r.why)), 'root sees it');
});

test('m6: the safe settings are written before the number (shell, hidden, password first; UniqueID last)', () => {
  const mac = fakeMac(); putConfig(mac);
  const t = plan(mac, cfg).ops.map((o) => o.text).filter((x) => x.startsWith('dscl . -create /Users/review '));
  const keys = t.map((x) => x.split(' ')[4]);
  assert.ok(keys.indexOf('UserShell') < keys.indexOf('UniqueID') && keys.indexOf('IsHidden') < keys.indexOf('UniqueID') && keys.indexOf('Password') < keys.indexOf('UniqueID'), keys.join(','));
  assert.equal(keys.at(-1), 'UniqueID');
});

test('m9 PLANT: a robot\'s group with a member or nested group → refused by the plan, FAILed by check', () => {
  for (const k of ['GroupMembership', 'NestedGroups']) {
    const mac = fakeMac(); putConfig(mac);
    mac.groups.set('pages', { PrimaryGroupID: '600', [k]: 'sam' }); mac.users.set('pages', { UniqueID: '600', PrimaryGroupID: '600' });
    const r = go(mac, ['users-folders']);
    assert.equal(r.code, 1, r.text); assert.match(r.text, new RegExp(`its group has ${k}`)); assert.deepEqual(mac.log, []);
    assert.ok(check(mac, cfg).some((x) => !x.ok && /group pages has no members/.test(x.what)));
  }
});

test('m3: a `sudo check` and a `sudo proofs --dry-run` refuse a node program others can change too', () => {
  const mac = fakeMac(); putConfig(mac); mac.nodeProblemText = 'the node program /opt/x/node: /opt/x is not owned by root';
  for (const a of [['check'], ['proofs'], ['proofs', '--dry-run'], ['users-folders', '--dry-run']]) {
    const r = go(mac, a); assert.equal(r.code, 2, `${a.join(' ')}: ${r.text}`); assert.match(r.text, /root must not run a node program/);
  }
});

test('m7: the real io is wired to the real checks (secure goes through secureFolder; nodeProblem through nodeProblemOf)', () => {
  const dir = tempDir('orch-setup-io-'); const sub = join(dir, 'f'); mkdirSync(sub); chmodSync(sub, 0o777);
  const io = realIo({ prefix: dir });
  io.secure('/f', { uid: process.getuid(), mode: 0o700 });
  assert.equal(statSync(sub).mode & 0o7777, 0o700);
  symlinkSync(sub, join(dir, 'l'));
  assert.throws(() => io.secure('/l', { uid: process.getuid(), mode: 0o700 }), /now a link|not a folder/);
  assert.equal(io.nodeProblem(), nodeProblemOf(process.execPath));
  // a program root's alone is fine, one others can write is not (the same function the wiring calls)
  const st = (uid, mode) => ({ uid, mode, isSymbolicLink: () => false });
  const lstat = (p) => (p === '/usr/local/bin/node' ? st(0, 0o100775) : st(0, 0o40755));
  assert.match(nodeProblemOf('/usr/local/bin/node', { lstat, realpath: (p) => p }), /written by others/);
});

test('n2: the real io reads the fixed config strictly and its mkdir refuses a folder that already exists (plants C10, B16)', { skip: process.getuid?.() === 0 }, () => {
  const dir = tempDir('orch-setup-io2-');
  const io = realIo({ prefix: dir });
  writeFileSync(join(dir, 'cfg.json'), '{"base":"/x"}', { mode: 0o644 });
  // strict (the fixed place): a file this user owns is NOT root's → refused. A non-strict read (--config, no sudo) takes it.
  // A realIo that read strict paths non-strictly (C10) would accept it, and this fails.
  assert.throws(() => io.readConfig('/cfg.json', { strict: true }), /root|owner|owned/i);
  assert.match(String(io.readConfig(join(dir, 'cfg.json'), { strict: false })), /"base":"\/x"/);
  // mkdir is not recursive and not quiet about an existing folder (B16): a base someone else made must stop the run.
  io.mkdir('/fresh', 0o755);
  assert.throws(() => io.mkdir('/fresh', 0o755), /EEXIST|exists/);
  assert.throws(() => io.mkdir('/no/parent', 0o755), /ENOENT|no such/i);
});

test('m8 and the table: the orchestrate entry on a worker outbox folder can list, read and clear (delete_child), nothing more; the proofs cover the outbox folders', () => {
  assert.deepEqual([...ORCHESTRATE_READ_ACL.perms].sort(), ['delete_child', 'directory_inherit', 'file_inherit', 'list', 'readattr', 'readextattr', 'readsecurity', 'search']);
  const names = proofList(cfg).map((p) => p.what).join('\n');
  for (const d of ['outboxes', 'outboxes/reviewer', 'outboxes/auditor']) assert.ok(names.includes(P(d)), d);
});

test('c1: the README\'s FAIL count is the real one (before setup, one product)', () => {
  const mac = fakeMac(); mac.as = 501;
  const res = check(mac, parseConfig({ ...RAW, products: ['alpha'] }));
  const fail = res.filter((r) => !r.ok).length;
  const readme = spawnSync('/usr/bin/grep', ['-o', 'lists [0-9]* FAILs of [0-9]* items', new URL('./README.md', import.meta.url).pathname], { encoding: 'utf8' }).stdout.trim();
  assert.equal(readme, `lists ${fail} FAILs of ${res.length} items`);
});
