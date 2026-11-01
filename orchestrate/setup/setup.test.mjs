// Tests for setup part 1 (R-0b-05). They run on a stand-in Mac (fake-mac.test-helper.mjs) under a throwaway folder, never
// as root and never against this Mac's users. Each "PLANT" test breaks one clause of the setup and says which check
// catches it. The last tests run the real read-only tools (dscl -read, dseditgroup, ls -led, chmod -h, stat) on this Mac.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_USER } from '../modules/M4-workshop/launcher/review-user.mjs';
import { readOutboxFile } from '../modules/M9-record/outbox.mjs';
import { AI_ROLES } from '../shared/record.mjs';
import { REVIEW_ROLES } from '../shared/review-roles.mjs';
import { BASE_MARKER, ORCHESTRATE_READ_ACL, ROOT_CONFIG_PATH, USERS, USER_ID_RANGE, WORKER_ROLES, aclText, folderTable, homeOf, parseConfig } from './layout.mjs';
import { nodeProblemOf, realIo, secureFolder } from './mac.mjs';
import { aclEntries, adminAnswer, apply, check, parseDscl, plan, readUser } from './users-folders.mjs';
import { runProofs } from './proofs.mjs';
import { main } from './setup.mjs';
import { fakeMac } from './fake-mac.test-helper.mjs';

const RAW = { base: '/Library/orch-test', owner: 'sam', products: ['alpha', 'beta'] };
const cfg = parseConfig(RAW);
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };
const cfgFile = () => { const d = mkdtempSync(join(tmpdir(), 'setup-cfg-')); const f = join(d, 'c.json'); writeFileSync(f, JSON.stringify(RAW)); return f; };
// As root the command reads the root-owned config at the fixed place and takes no --config (NEW-1); without root it is given one.
const putRootConfig = (mac, raw = RAW) => { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return f; };
const run = (mac, args, raw = RAW) => {
  const s = sink(); let argv = args;
  if (mac.as === 0) putRootConfig(mac, raw); else argv = [...args, '--config', cfgFile()];
  const code = main(argv, { io: mac, out: s.out, err: s.err });
  return { code, text: s.lines.join('\n') };
};
const applied = () => { const mac = fakeMac(); const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text); return mac; };
const fails = (mac) => check(mac, cfg).filter((r) => !r.ok);
const isDarwin = process.platform === 'darwin';
const P = (s) => `${cfg.base}/${s}`;
const uidOf = (mac, u) => Number(mac.users.get(u).UniqueID);

test('the setup\'s review user is the launcher\'s', () => {
  assert.ok(USERS.includes(REVIEW_USER));
  assert.deepEqual([...USERS], ['orchestrate', 'pages', 'review']);
});

test('config: refusals', () => {
  for (const bad of [
    { ...RAW, base: '/Users/x/orch' }, { ...RAW, base: '/Applications/orch' }, { ...RAW, base: '/tmp/x' }, { ...RAW, base: 'Library/x' },
    { ...RAW, base: '/Library/../x' }, { ...RAW, base: '/Library/has space' }, { ...RAW, base: '/Library' }, { ...RAW, base: '/Library//x' },
    { ...RAW, owner: 'review' }, { ...RAW, owner: 'root' }, { ...RAW, owner: 'Bad Name' },
    { ...RAW, products: ['a', 'a'] }, { ...RAW, products: ['../x'] }, { ...RAW, products: 'x' }, null, [],
  ]) assert.throws(() => parseConfig(bad), /config/, JSON.stringify(bad));
  assert.deepEqual(parseConfig({ base: '/Library/x/', owner: 'sam' }), { base: '/Library/x', owner: 'sam', products: [] });
});

test('config: every forbidden folder is refused, in any letter case (K15: /Volumes, /opt and /usr/local included)', () => {
  for (const f of ['/Users', '/Applications', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/Volumes', '/opt', '/usr/local']) {
    for (const b of [`${f}/x`, `${f.toLowerCase()}/x`, `${f.toUpperCase()}/x`]) assert.throws(() => parseConfig({ ...RAW, base: b }), /must not be under/, b);
  }
  assert.doesNotThrow(() => parseConfig({ ...RAW, base: '/Library/orchestrate' }));
});

test('the folder table: parents first, exact modes and owners, one outbox root with one folder per role, nothing outside the base', () => {
  const t = folderTable(cfg);
  const seen = new Set();
  for (const r of t) {
    assert.ok(r.path === cfg.base || r.path.startsWith(`${cfg.base}/`), r.path);
    assert.ok(!seen.has(r.path), `twice: ${r.path}`);
    if (r.path !== cfg.base) assert.ok(seen.has(r.path.slice(0, r.path.lastIndexOf('/'))), `parent of ${r.path} comes first`);
    seen.add(r.path);
    assert.ok([0o700, 0o750, 0o755].includes(r.mode), `${r.path} ${r.mode.toString(8)}`);
    assert.ok(['root', 'owner', ...USERS].includes(r.owner));
    assert.ok(Array.isArray(r.acl));
  }
  const by = (s) => t.find((r) => r.path === `${cfg.base}/${s}`);
  // the exact owner and mode of the rows a mutation once changed without any test noticing (K12-K14)
  assert.deepEqual([by('keys').owner, by('keys').mode], ['orchestrate', 0o700]);
  assert.deepEqual([by('private').owner, by('private').mode], ['orchestrate', 0o700]);
  assert.deepEqual([by('products/alpha/store').owner, by('products/alpha/store').mode], ['orchestrate', 0o755]);
  assert.deepEqual([by('products/alpha/pages').owner], ['pages']);
  assert.deepEqual([by('worker-copies').owner], ['owner']);
  assert.deepEqual([by('review').owner, by('review-copies').owner], ['review', 'review']);
  for (const u of USERS) assert.equal(by(`home/${u}`).path, homeOf(cfg, u));
  // L71 / L90 M1: the outbox root is root's 0755; reviewer/ and auditor/ are review's; every other role's is the workers' user's
  assert.deepEqual([by('outboxes').owner, by('outboxes').mode], ['root', 0o755]);
  assert.equal(by('review-outbox'), undefined);
  for (const r of REVIEW_ROLES) assert.deepEqual([by(`outboxes/${r}`).owner, by(`outboxes/${r}`).mode, by(`outboxes/${r}`).acl], ['review', 0o755, []]);
  assert.deepEqual([...WORKER_ROLES].sort(), AI_ROLES.filter((r) => !REVIEW_ROLES.includes(r)).sort());
  assert.ok(WORKER_ROLES.includes('worker') && WORKER_ROLES.includes('lead'));
  for (const r of WORKER_ROLES) assert.deepEqual([by(`outboxes/${r}`).owner, by(`outboxes/${r}`).mode, by(`outboxes/${r}`).acl], ['owner', 0o750, [ORCHESTRATE_READ_ACL]]);
});

test('parseDscl reads the shapes dscl prints', () => {
  assert.deepEqual(parseDscl('UniqueID: 501\nNFSHomeDirectory:\n /Users/with space\ndsAttrTypeNative:IsHidden: 1\nNo such key: Foo\n'), { UniqueID: '501', NFSHomeDirectory: '/Users/with space', IsHidden: '1' });
});

test('dry run: prints every step, changes nothing, needs no root', () => {
  const mac = fakeMac({ euid: 501 });
  const r = run(mac, ['users-folders', '--dry-run']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /would run: check that every folder above \/Library\/orch-test is root's alone/);
  assert.match(r.text, /would run: dscl \. -create \/Users\/review UserShell \/usr\/bin\/false/);
  assert.match(r.text, /would run: mkdir -m 700 \/Library\/orch-test\/outboxes\/reviewer/);
  assert.match(r.text, /set owner and mode of \/Library\/orch-test\/outboxes\/reviewer: chown 602:602, chmod 755/);
  assert.match(r.text, /set the access list of \/Library\/orch-test\/outboxes\/worker to user:orchestrate allow delete_child,directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search/);
  assert.match(r.text, /dry run: \d+ step\(s\), nothing changed/);
  assert.equal(mac.log.length, 0, 'no changing call was made');
  assert.equal(mac.users.size, 1);
  assert.equal(check(mac, cfg).filter((x) => x.ok && /exists/.test(x.what)).length, 1, 'only the owner exists');
});

test('refuses clearly without root, and changes nothing', () => {
  const mac = fakeMac({ euid: 501 });
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 2);
  assert.match(r.text, /must run as root/);
  assert.equal(mac.log.length, 0);
});

test('the stand-in refuses what the real tools refuse', () => {
  const mac = fakeMac({ euid: 501 });
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-create', '/Users/x', 'UserShell', '/usr/bin/false']).status, 40);   // not root
  assert.equal(mac.run('/usr/bin/sudo', ['-n', '-l', '-U', 'x']).status, 1);                                       // sudo needs root here
  mac.as = 0;
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-create', '/Foo/x', 'A', 'b']).status, 40);                      // bad path
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-create', '/Users/x', 'Key']).status, 40);                       // a key with no value
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-read', '/Users/nobody-here']).status, 56);                      // no such record
  assert.equal(mac.run('/usr/sbin/dseditgroup', ['-o', 'checkmember', '-m', 'x', 'admin']).stdout.split(' ')[0], 'no');
  assert.throws(() => mac.mkdir('/no/parent/here', 0o700), /ENOENT/);
  mkdirSync(mac.at('/Library/f'), { mode: 0o700 });
  mac.as = 501;
  assert.throws(() => mac.secure('/Library/f', { uid: 1, mode: 0o755 }), /EPERM/);                                   // chown needs root
  mac.as = 0;
  rmSync(mac.at('/Library/f'), { recursive: true }); mkdirSync(mac.at('/Library/real'));
  symlinkSync(mac.at('/Library/real'), mac.at('/Library/f'));
  assert.throws(() => mac.secure('/Library/f', { uid: 1, mode: 0o755 }), /now a link/);                              // never through a link
  writeFileSync(mac.at('/Library/file'), 'x');
  assert.throws(() => mac.secure('/Library/file', { uid: 1, mode: 0o755 }), /not a folder/);
  if (isDarwin) assert.notEqual(mac.run('/bin/chmod', ['+a', 'user:no-such-user-zz9 allow list', mac.at('/Library/real')]).status, 0);   // an unknown name in an access list
});

test('apply as root: every check passes, ids are 600-699 and all different, then a second run does nothing', () => {
  const mac = fakeMac();
  const first = run(mac, ['users-folders']);
  assert.equal(first.code, 0, first.text);
  assert.match(first.text, /all \d+ items PASS/);
  assert.deepEqual(fails(mac), []);
  for (const u of USERS) {
    const a = mac.users.get(u);
    assert.equal(a.UserShell, '/usr/bin/false'); assert.equal(a.IsHidden, '1'); assert.equal(a.Password, '*');
    assert.equal(a.UniqueID, a.PrimaryGroupID); assert.equal(a.NFSHomeDirectory, homeOf(cfg, u));
    assert.ok(Number(a.UniqueID) >= USER_ID_RANGE.low && Number(a.UniqueID) <= USER_ID_RANGE.high);
    assert.equal(mac.groups.get(u).PrimaryGroupID, a.UniqueID);
  }
  assert.deepEqual([USER_ID_RANGE.low, USER_ID_RANGE.high], [600, 699]);
  assert.equal(new Set(USERS.map((u) => mac.users.get(u).UniqueID)).size, 3, 'three different ids');
  const n = mac.log.length;
  const second = run(mac, ['users-folders']);
  assert.equal(second.code, 0, second.text);
  assert.match(second.text, /nothing to do/);
  assert.equal(mac.log.length, n, 'the second run made no changing call');
  assert.equal(plan(mac, cfg).ops.length, 0);
});

test('every folder ends with the table\'s owner, group and mode, and its exact access list (K8, K13, K14)', () => {
  const mac = applied();
  const ids = { root: { uid: mac.rootUid, gid: 0 }, owner: { uid: uidOf(mac, 'sam'), gid: 0 } };   // the person's folders are pinned to wheel (m1)
  for (const u of USERS) ids[u] = { uid: uidOf(mac, u), gid: uidOf(mac, u) };
  for (const row of folderTable(cfg)) {
    const st = mac.lstat(row.path);
    assert.equal(st.uid, ids[row.owner].uid, `${row.path} owner`);
    assert.equal(st.gid, ids[row.owner].gid, `${row.path} group`);
    assert.equal(st.mode & 0o7777, row.mode, `${row.path} mode`);
    assert.deepEqual(aclEntries(mac, row.path).entries, row.acl.map(aclText).sort(), `${row.path} access list`);
  }
});

test('users skip ids already taken by a user OR a group (K10)', () => {
  const mac = fakeMac({ users: { other: { UniqueID: '600', PrimaryGroupID: '601' } } });
  mac.groups.set('stray', { PrimaryGroupID: '602' });
  assert.equal(run(mac, ['users-folders']).code, 0);
  const ids = USERS.map((u) => Number(mac.users.get(u).UniqueID));
  assert.deepEqual(ids, [603, 604, 605]);
});

test('PLANT a half-made user whose group id another GROUP uses → refused naming it (K10: ids are checked against /Groups)', () => {
  const mac = fakeMac(); mac.groups.set('other-group', { PrimaryGroupID: '650' }); mac.groups.set('pages', { PrimaryGroupID: '650' });
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /pages: its id 650 is also used by another user or group/); assert.deepEqual(mac.log, []);
});

test('M9\'s own reader reads the table\'s paths: one worker file and one verdict, both through the one outbox root (L90 M1)', () => {
  const mac = applied();
  const me = process.getuid();
  const root = mac.at(P('outboxes'));
  const put = (role, sid, name, text) => { const d = join(root, role, sid); mkdirSync(d, { recursive: true }); const f = join(d, name); writeFileSync(f, text, { mode: 0o644 }); chmodSync(f, 0o644); return f; };
  const workerFile = put('worker', 'sess-1', 'report-x.md', 'a report\n');
  const w = readOutboxFile({ outboxRoot: root, uids: { worker: me, reviewer: me + 1, auditor: me + 1 }, tag: { role: 'worker', sessionId: 'sess-1' }, file: workerFile });
  assert.equal(w.ok, true, w.reason);
  const verdictFile = put('reviewer', 'sess-2', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', fields: {} })}\nbody\n`);
  chmodSync(join(root, 'reviewer', 'sess-2'), 0o755);
  const v = readOutboxFile({ outboxRoot: root, uids: { worker: me + 1, reviewer: me, auditor: me }, tag: { role: 'reviewer', sessionId: 'sess-2' }, file: verdictFile });
  assert.equal(v.ok, true, v.reason);
  // and each role has its folder under that one root (no other root is needed)
  for (const r of AI_ROLES) assert.ok(statSync(join(root, r)).isDirectory(), r);
});

test('a run cut off at ANY step is finished by the next run: nothing deleted, only the missing attributes written', () => {
  const total = (() => { const m = fakeMac(); assert.equal(run(m, ['users-folders']).code, 0); return m.log.filter((l) => l.startsWith('dscl -create')).length; })();
  assert.ok(total >= 30, String(total));
  for (let cut = 1; cut <= total; cut++) {
    const mac = fakeMac();
    let calls = 0;
    const real = mac.run;
    mac.run = (c, a) => { if (c === '/usr/bin/dscl' && a[1] === '-create' && ++calls === cut) return { status: 1, stdout: '', stderr: 'injected failure' }; return real(c, a); };
    const r1 = run(mac, ['users-folders']);
    assert.equal(r1.code, 1, `cut ${cut}`);
    assert.match(r1.text, /stopped: .*Run it again/);
    mac.run = real;
    const before = mac.log.length;
    const r2 = run(mac, ['users-folders']);
    assert.equal(r2.code, 0, `cut ${cut}: ${r2.text}`);
    assert.deepEqual(fails(mac), [], `cut ${cut}`);
    // finishing writes only what was missing: no attribute is written twice over the two runs
    const creates = mac.log.filter((l) => l.startsWith('dscl -create') && l.split(' ').length > 3);
    assert.equal(new Set(creates).size, creates.length, `cut ${cut}: an attribute was written twice`);
    assert.ok(mac.log.slice(before).every((l) => !l.includes('-delete')), 'nothing is ever deleted');
  }
});

test('a run cut off in the FOLDER steps (after the users) is finished by the next run too', () => {
  const total = (() => { const m = fakeMac(); assert.equal(run(m, ['users-folders']).code, 0); return m.log.filter((l) => /^(mkdir|chown|chmod)/.test(l)).length; })();
  for (let cut = 1; cut <= total; cut += 7) {
    const mac = fakeMac(); let n = 0; const realSecure = mac.secure; const realMkdir = mac.mkdir;
    mac.secure = (...a) => { if (++n === cut) throw new Error('injected stop'); return realSecure(...a); };
    mac.mkdir = (...a) => { if (++n === cut) throw new Error('injected stop'); return realMkdir(...a); };
    run(mac, ['users-folders']);
    mac.secure = realSecure; mac.mkdir = realMkdir;
    const r2 = run(mac, ['users-folders']);
    assert.equal(r2.code, 0, `cut ${cut}: ${r2.text}`);
    assert.deepEqual(fails(mac), [], `cut ${cut}`);
  }
});

test('check on an untouched Mac: FAIL lines and exit 1', () => {
  const mac = fakeMac();
  const r = run(mac, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL  user review exists/);
  assert.match(r.text, /FAIL  \/Library\/orch-test.*missing/);
  assert.match(r.text, /\d+ of \d+ FAILED/);
});

test('check: exit 0 and PASS lines only when all is right; the sudo item is SKIPped, not failed, without root', () => {
  const mac = applied();
  mac.as = 501;
  const r = run(mac, ['check']);
  assert.equal(r.code, 3, `exit 3: nothing failed, but some items could not be seen without root\n${r.text}`);
  assert.match(r.text, /PASS  user review is not an admin/);
  assert.match(r.text, /PASS  \/Library\/orch-test\/outboxes\/reviewer \(review, 755\)/);
  assert.match(r.text, /NEEDS ROOT  user review has no sudo rule — needs root/);
  assert.match(r.text, /NEEDS ROOT  user review has no sign-in record — needs root to read the password hash/, 'the password hash is hidden from a non-root check (m5)');
  assert.ok(!/PASS  user review has no sign-in record/.test(r.text) && !/PASS  user review has no sudo rule/.test(r.text), 'never PASS for what could not be seen');
  assert.ok(!/FAIL/.test(r.text)); assert.match(r.text, /could not be checked without root/);
  mac.as = 0;
  const rr = run(mac, ['check']);
  assert.equal(rr.code, 0, rr.text);
  assert.match(rr.text, /PASS  user review has no sudo rule/); assert.match(rr.text, /PASS  user review has no sign-in record/);
});

// ---- PLANTS: one fault per clause; each says which check catches it. -------------------------------------------------

test('PLANT user is an admin → caught by "is not an admin"; apply refuses it', () => {
  const mac = applied(); mac.admins.add('review');
  assert.deepEqual(fails(mac).map((f) => f.what), ['user review is not an admin']);
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /review exists but is not as needed: it is an admin/);
});

test('PLANT a login shell → caught by "has no login shell"', () => {
  const mac = applied(); mac.users.get('pages').UserShell = '/bin/zsh';
  assert.deepEqual(fails(mac).map((f) => f.what), ['user pages has no login shell']);
  assert.match(run(mac, ['users-folders']).text, /pages exists but is not as needed: its shell is \/bin\/zsh/);
});

test('PLANT a visible user → caught by "is hidden"', () => {
  const mac = applied(); delete mac.users.get('orchestrate').IsHidden;
  assert.deepEqual(fails(mac).map((f) => f.what), ['user orchestrate is hidden']);
});

// K1-K4: a COMPLETE existing user that is wrong is refused by the PLAN (not only found by the check afterwards), with nothing changed.
for (const [name, mutate, want] of [
  ['not hidden (K1)', (u) => { u.IsHidden = '0'; }, /review exists but is not as needed: it is not hidden/],
  ['id 0 (K2)', (u) => { u.UniqueID = '0'; }, /root's id/],
  ['another home folder (K3)', (u) => { u.NFSHomeDirectory = '/Users/review'; }, /its home is \/Users\/review/],
  ['another main group (K4)', (u) => { u.PrimaryGroupID = '20'; }, /main group is 20, not the group review \(602\)/],
  ['a password set', (u) => { u.Password = '********'; }, /has a password set/],
]) {
  test(`PLANT a finished user that is ${name} → the plan refuses it, nothing changed`, () => {
    const mac = applied(); mutate(mac.users.get('review'));
    const n = mac.log.length;
    const r = run(mac, ['users-folders']);
    assert.equal(r.code, 1, r.text); assert.match(r.text, want); assert.match(r.text, /nothing was changed/i);
    assert.equal(mac.log.length, n, 'something was changed');
  });
}

test('PLANT the group\'s id differs from the user\'s main group → caught by "main group" (K7), with both numbers', () => {
  const mac = applied(); mac.groups.get('review').PrimaryGroupID = '690';
  const f = fails(mac).find((x) => /review's main group is the group review/.test(x.what));
  assert.ok(f, JSON.stringify(fails(mac))); assert.match(f.why, /group review: 690, user's main group: 602/);
});

test('PLANT the user\'s main group is not its own → caught by "main group"', () => {
  const mac = applied(); mac.users.get('review').PrimaryGroupID = '20';
  assert.ok(fails(mac).some((f) => /review's main group/.test(f.what)));
});

test('PLANT a user with id 0 → caught by "is not root"', () => {
  const mac = applied(); mac.users.get('review').UniqueID = '0';
  assert.ok(fails(mac).some((f) => f.what === 'user review is not root'));
});

test('PLANT wrong home → caught by "home is"', () => {
  const mac = applied(); mac.users.get('review').NFSHomeDirectory = '/Users/review';
  assert.ok(fails(mac).some((f) => /review's home/.test(f.what)));
});

// M5
test('PLANT P3: review has the owner\'s own id → caught: the ids must all differ, and the id must be in range', () => {
  const mac = applied(); mac.users.get('review').UniqueID = mac.users.get('sam').UniqueID;
  const w = fails(mac).map((f) => f.what);
  assert.ok(w.includes('the three users, the owner and root all have different ids'), w.join(' | '));
  assert.ok(w.includes(`user review's id is in 600-699`));
  assert.ok(run(mac, ['check']).code === 1);
});

test('PLANT P4: orchestrate and review share one id → caught by "belongs to no other user" and "all have different ids"', () => {
  const mac = applied(); mac.users.get('orchestrate').UniqueID = mac.users.get('review').UniqueID;
  const f = fails(mac); const w = f.map((x) => x.what);
  assert.ok(w.includes('the three users, the owner and root all have different ids'), w.join(' | '));
  assert.ok(w.includes(`user orchestrate's id belongs to no other user`)); assert.ok(w.includes(`user review's id belongs to no other user`));
});

test('PLANT two of the three share one GROUP id → caught by "have different groups" and "belongs to no other group"', () => {
  const mac = applied();
  mac.groups.get('pages').PrimaryGroupID = mac.groups.get('review').PrimaryGroupID; mac.users.get('pages').PrimaryGroupID = mac.groups.get('review').PrimaryGroupID;
  const w = fails(mac).map((x) => x.what);
  assert.ok(w.includes('the three users have different groups'), w.join(' | ')); assert.ok(w.includes(`group review's id belongs to no other group`));
});

test('PLANT another account has the same id as a robot user → caught by "belongs to no other user"', () => {
  const mac = applied(); mac.users.set('apple-thing', { UniqueID: String(uidOf(mac, 'pages')), PrimaryGroupID: '20' });
  assert.ok(fails(mac).some((f) => f.what === `user pages's id belongs to no other user` && /apple-thing/.test(f.why)));
});

test('PLANT a half-made user with an id outside 600-699 → refused (the old range, 301-499, is not taken over)', () => {
  const mac = fakeMac(); mac.groups.set('pages', { PrimaryGroupID: '333' });
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /its group 333 is outside 600-699/); assert.deepEqual(mac.log, []);
});

// m6: no way to sign in
test('PLANT a password hash on a robot user → caught by "has no password" and "no sign-in record"', () => {
  const mac = applied(); Object.assign(mac.users.get('pages'), { Password: '********', ShadowHashData: 'abc', AuthenticationAuthority: ';ShadowHash;' });
  const w = fails(mac).map((f) => f.what);
  assert.ok(w.includes(`user pages has no password (it is '*')`)); assert.ok(w.includes('user pages has no sign-in record'));
});

test('PLANT a sudo rule for a robot user → caught by "has no sudo rule" (needs root; skipped without it)', () => {
  const mac = applied(); mac.sudoRules.add('review');
  assert.deepEqual(fails(mac).map((f) => f.what), ['user review has no sudo rule']);
  mac.as = 501; assert.deepEqual(fails(mac), [], 'without root the item is skipped, not failed');
});

// folders
test('PLANT outboxes/reviewer owned by the wrong user → caught by the owner column; apply puts it right', () => {
  const mac = applied(); mac.owners.set(P('outboxes/reviewer'), { uid: 501, gid: 20 });
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /owner is uid 501, want 602/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT a folder with the wrong GROUP → caught ("group is"); the plan\'s step and the apply put it right (K8)', () => {
  const mac = applied(); mac.owners.set(P('keys'), { uid: uidOf(mac, 'orchestrate'), gid: 999 });
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /group is 999, want 600/);
  const p = plan(mac, cfg); assert.ok(p.ops.some((o) => /set owner and mode of .*\/keys: chown 600:600/.test(o.text)), p.ops.map((o) => o.text).join('\n'));
  assert.equal(run(mac, ['users-folders']).code, 0); assert.equal(mac.owners.get(P('keys')).gid, 600); assert.deepEqual(fails(mac), []);
});

test('PLANT worker-copies owned by root instead of the owner → caught by the owner column', () => {
  const mac = applied(); mac.owners.set(P('worker-copies'), { uid: mac.rootUid, gid: 0 });
  assert.match(fails(mac)[0].why, /want 65001/);
});

test('PLANT mode 777 on outboxes/reviewer → caught by the exact mode; apply puts it right', () => {
  const mac = applied(); chmodSync(mac.at(P('outboxes/reviewer')), 0o777);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /mode is 777, want 755/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT mode 755 where 700 is wanted (keys) → caught: "more open" is a fail too', () => {
  const mac = applied(); chmodSync(mac.at(P('keys')), 0o755);
  assert.match(fails(mac)[0].why, /mode is 755, want 700/);
});

test('PLANT a link in place of a folder → caught by "is a link"; apply refuses, changes nothing', () => {
  const mac = applied(); const p = mac.at(P('keys'));
  rmSync(p, { recursive: true }); symlinkSync(mac.at(P('private')), p);
  assert.ok(fails(mac).some((f) => f.why === 'is a link'));
  const n = mac.log.length;
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /keys exists but is a link/); assert.equal(mac.log.length, n);
});

test('PLANT a missing folder → caught by "missing"; apply makes it', () => {
  const mac = applied(); rmSync(mac.at(P('products/beta/store')), { recursive: true });
  assert.ok(fails(mac).some((f) => f.why === 'missing'));
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

// M2: the access-list column
test('worker outbox folders carry exactly the one orchestrate entry: apply SETS it (it is not stripped), check compares it exactly', { skip: !isDarwin }, () => {
  const mac = applied();
  const want = aclText(ORCHESTRATE_READ_ACL);
  assert.deepEqual(aclEntries(mac, P('outboxes/worker')).entries, [want]);
  assert.deepEqual(aclEntries(mac, P('outboxes/reviewer')).entries, []);
  assert.deepEqual(fails(mac), []);
  // a second run leaves it alone
  const n = mac.log.length; assert.match(run(mac, ['users-folders']).text, /nothing to do/); assert.equal(mac.log.length, n);
});

test('PLANT the orchestrate entry missing → caught ("is missing"); apply sets it', { skip: !isDarwin }, () => {
  const mac = applied(); assert.equal(spawnSync('/bin/chmod', ['-h', '-N', mac.at(P('outboxes/lead'))]).status, 0);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /access list is missing: user:orchestrate allow/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT an EXTRA entry beside the orchestrate one → caught ("not wanted"); apply removes it and keeps the wanted one', { skip: !isDarwin }, () => {
  const mac = applied(); assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'everyone allow write,delete_child', mac.at(P('outboxes/worker'))]).status, 0);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /access list has an entry that is not wanted: group:everyone allow/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
  assert.deepEqual(aclEntries(mac, P('outboxes/worker')).entries, [aclText(ORCHESTRATE_READ_ACL)]);
});

test('PLANT the orchestrate entry with the wrong permissions (it can also write) → caught as one missing and one not wanted', { skip: !isDarwin }, () => {
  const mac = applied(); const f = mac.at(P('outboxes/scout'));
  assert.equal(spawnSync('/bin/chmod', ['-h', '-N', f]).status, 0);
  assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'user:daemon allow list,search,add_file,readattr,readextattr,readsecurity,file_inherit,directory_inherit', f]).status, 0);
  const r = fails(mac); assert.equal(r.length, 1); assert.match(r[0].why, /missing.*not wanted|not wanted.*missing/);
});

test('PLANT an access list on a folder that should have none → caught by the ACL read; apply clears it', { skip: !isDarwin }, () => {
  const mac = applied(); const p = mac.at(P('outboxes/reviewer'));
  const r = spawnSync('/bin/chmod', ['+a', 'everyone allow write,delete_child', p]);
  assert.equal(r.status, 0, String(r.stderr));
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /access list has an entry that is not wanted/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('a made folder does not keep an access list it inherited (c3)', { skip: !isDarwin }, () => {
  const mac = fakeMac();
  // the base's parent gives every new folder under it an inherited entry; the apply must clear it from the folders it makes
  assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'user:daemon allow list,search,readattr,file_inherit,directory_inherit', mac.at('/Library')]).status, 0);
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 2, 'the folders above the base must be free of access lists, so root refuses before it starts');
  assert.match(r.text, /access list/);
});

test('the inherited entry on a NEW folder under an allowed parent is cleared (c3): a made folder under the base', { skip: !isDarwin }, () => {
  const mac = applied();
  // make a new folder under outboxes/worker (which carries the inheriting entry) and look at it: it shows `inherited`
  const sub = mac.at(P('outboxes/worker/sess')); mkdirSync(sub);
  assert.match(spawnSync('/bin/ls', ['-led', sub], { encoding: 'utf8' }).stdout, /inherited allow/);
  assert.ok(aclEntries(mac, P('outboxes/worker/sess')).entries[0].includes(' inherited '), 'the check reads an inherited entry as an entry, so a table folder that has one FAILs');
});

test('PLANT the folder above the base writable by others → caught by the chain check', () => {
  const mac = applied(); chmodSync(mac.at('/Library'), 0o777);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].what, /folders above/); assert.match(f[0].why, /written by others|can be written/);
});

// M3: the chain comes first
test('PLANT P1: /Library writable by others → the run stops before ANY step: no user, no folder, nothing logged', () => {
  const mac = fakeMac(); chmodSync(mac.at('/Library'), 0o777);
  const r = run(mac, ['users-folders']);
  // Root's own config sits in /Library, so the config is refused first (exit 2); the plan's own chain check is tested on its own below.
  assert.equal(r.code, 2, r.text); assert.match(r.text, /folder the config is in is not root's alone/);
  assert.deepEqual(mac.log, [], 'a root step ran'); assert.equal(mac.users.size, 1); assert.equal(existsSync(mac.at(cfg.base)), false);
  const p = plan(mac, cfg); assert.deepEqual(p.ops, []); assert.match(p.problems.join(), /folders above \/Library\/orch-test are not safe for root to work in/);
});

test('PLANT P7: /Library is a link → the run stops before ANY step', () => {
  const mac = fakeMac(); rmSync(mac.at('/Library'), { recursive: true }); mkdirSync(mac.at('/elsewhere')); symlinkSync(mac.at('/elsewhere'), mac.at('/Library'));
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /is a link/);
  assert.deepEqual(mac.log, []); assert.equal(mac.users.size, 1); assert.deepEqual(existsSync(mac.at('/elsewhere/orch-test')), false);
});

test('PLANT /Library changed AFTER the plan → the guard (the first step of the run) stops it with nothing done', () => {
  const mac = fakeMac(); const p = plan(mac, cfg);
  assert.ok(p.ops.length > 30); assert.deepEqual(p.problems, []);
  chmodSync(mac.at('/Library'), 0o777);
  assert.throws(() => apply(p.ops), /not safe for root to work in/);
  assert.deepEqual(mac.log, []);
});

test('the chain check also runs in dry-run, so a dry run shows the problem too', () => {
  const mac = fakeMac({ euid: 501 }); chmodSync(mac.at('/Library'), 0o777);
  const r = run(mac, ['users-folders', '--dry-run']);
  assert.equal(r.code, 1); assert.match(r.text, /not safe for root/);
});

// M4: never follow a link
test('PLANT P2: a folder swapped for a link to a 0700 victim BETWEEN the plan and the apply → refused, the victim untouched', () => {
  const mac = applied(); chmodSync(mac.at(P('keys')), 0o755);
  const p = plan(mac, cfg);
  assert.ok(p.ops.some((o) => /set owner and mode of .*\/keys/.test(o.text)));
  const victim = mac.at(P('victim')); mkdirSync(victim, { mode: 0o700 }); chmodSync(victim, 0o700);
  rmSync(mac.at(P('keys')), { recursive: true }); symlinkSync(victim, mac.at(P('keys')));
  const n = mac.log.length;
  assert.throws(() => apply(p.ops), /is now a link/);
  assert.equal(statSync(victim).mode & 0o7777, 0o700, 'the victim was changed');
  assert.equal(mac.owners.get(P('victim')), undefined);
  assert.equal(mac.log.length, n, 'a change was made');
});

test('PLANT a NEW folder swapped for a link right after it is made and before it is handed over → refused, the victim untouched', () => {
  const mac = fakeMac(); const p = plan(mac, cfg);
  const victim = mac.at(P('victim'));
  let swapped = false;
  assert.throws(() => {
    for (const o of p.ops) {
      if (!swapped && /^set owner and mode of/.test(o.text)) {   // all the folders are made by now; swap one before any is handed over
        mkdirSync(victim, { mode: 0o700 }); chmodSync(victim, 0o700);
        rmSync(mac.at(P('private')), { recursive: true }); symlinkSync(victim, mac.at(P('private'))); swapped = true;
      }
      o.run();
    }
  }, /is now a link/);
  assert.equal(statSync(victim).mode & 0o7777, 0o700); assert.equal(mac.owners.get(P('victim')), undefined);
});

test('PLANT a NEW folder replaced by a DIFFERENT folder after it is made → refused (same name, not the folder the plan made)', () => {
  const mac = fakeMac(); const p = plan(mac, cfg);
  let swapped = false;
  assert.throws(() => {
    for (const o of p.ops) {
      if (!swapped && /^set owner and mode of/.test(o.text)) { rmSync(mac.at(P('private')), { recursive: true }); mkdirSync(mac.at(P('private')), { mode: 0o700 }); swapped = true; }
      o.run();
    }
  }, /not the folder the plan saw/);
});

test('PLANT an existing folder replaced by a different folder between plan and apply → refused', () => {
  const mac = applied(); chmodSync(mac.at(P('keys')), 0o755);
  const p = plan(mac, cfg);
  rmSync(mac.at(P('keys')), { recursive: true }); mkdirSync(mac.at(P('keys')), { mode: 0o755 });
  assert.throws(() => apply(p.ops), /not the folder the plan saw/);
});

test('PLANT the access-list step finds a link where the folder was → refused, the target\'s access list untouched', { skip: !isDarwin }, () => {
  const mac = applied(); assert.equal(spawnSync('/bin/chmod', ['-h', '-N', mac.at(P('outboxes/lead'))]).status, 0);
  const p = plan(mac, cfg);
  assert.ok(p.ops.some((o) => /set the access list of .*\/outboxes\/lead/.test(o.text)));
  const victim = mac.at(P('victim')); mkdirSync(victim, { mode: 0o700 });
  assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'user:daemon allow list,search', victim]).status, 0);
  rmSync(mac.at(P('outboxes/lead')), { recursive: true }); symlinkSync(victim, mac.at(P('outboxes/lead')));
  assert.throws(() => apply(p.ops), /now a link/);
  assert.match(spawnSync('/bin/ls', ['-led', victim], { encoding: 'utf8' }).stdout, /user:daemon allow list,search/, 'the victim\'s list was changed');
});

test('REAL chmod -h -N on a link acts on the link, not on what it points to (the flag the setup relies on)', { skip: !isDarwin }, () => {
  const d = mkdtempSync(join(tmpdir(), 'setup-link-')); const target = join(d, 't'); mkdirSync(target);
  assert.equal(spawnSync('/bin/chmod', ['+a', 'user:daemon allow list,search', target]).status, 0);
  symlinkSync(target, join(d, 'l'));
  const r = spawnSync('/bin/chmod', ['-h', '-N', join(d, 'l')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(spawnSync('/bin/ls', ['-led', target], { encoding: 'utf8' }).stdout, /user:daemon allow list,search/, 'the target\'s access list was removed through the link');
  rmSync(d, { recursive: true });
});

test('secureFolder: refuses a link, a file, a replaced folder; changes a real one through its handle', () => {
  const d = mkdtempSync(join(tmpdir(), 'setup-secure-')); const f = join(d, 'f'); mkdirSync(f, { mode: 0o700 });
  const calls = [];
  const ports = { chown: (fd, u, g) => calls.push(['chown', u, g]), chmod: (fd, m) => calls.push(['chmod', m]) };
  const ino = statSync(f).ino; const dev = statSync(f).dev;
  secureFolder(f, { uid: 5, gid: 6, mode: 0o750, ino, dev }, ports);
  assert.deepEqual(calls, [['chown', 5, 6], ['chmod', 0o750]]);
  assert.throws(() => secureFolder(f, { uid: 5, mode: 0o750, ino: ino + 1, dev }, ports), /not the folder the plan saw/);
  symlinkSync(f, join(d, 'l')); assert.throws(() => secureFolder(join(d, 'l'), { uid: 5, mode: 0o750 }, ports), /now a link/);
  writeFileSync(join(d, 'file'), 'x'); assert.throws(() => secureFolder(join(d, 'file'), { uid: 5, mode: 0o750 }, ports), /not a folder/);
  assert.equal(calls.length, 2, 'nothing else was changed');
});

test('order: every folder is made (parents first) before any owner is set, and a child is handed over before its parent', () => {
  const mac = fakeMac(); const p = plan(mac, cfg);
  const texts = p.ops.map((o) => o.text);
  const lastMkdir = texts.map((t, i) => (t.startsWith('mkdir') ? i : -1)).reduce((a, b) => Math.max(a, b));
  const firstSet = texts.findIndex((t) => t.startsWith('set owner and mode'));
  assert.ok(lastMkdir < firstSet, 'a folder was handed over before the last one was made');
  const at = (path) => texts.findIndex((t) => t.startsWith(`set owner and mode of ${path}:`));
  assert.ok(at(P('products/alpha/store')) < at(P('products/alpha')), 'a robot-owned parent must be handed over after its children');
  assert.ok(at(P('products/alpha')) < at(P('products')) && at(P('products')) < at(P('')) || at(P('products/alpha')) < at(P('products')));
  assert.ok(at(P('home/review')) < at(P('home')));
});

test('PLANT the owner user missing → refused, nothing changed', () => {
  const mac = fakeMac(); mac.users.delete('sam');
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /owner's Mac user sam was not found/); assert.equal(mac.log.length, 0);
});

test('a group named like a user, with no user yet: the user is made to match it (its id is kept)', () => {
  const mac = fakeMac(); mac.groups.set('pages', { PrimaryGroupID: '633' });
  const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text);
  assert.equal(mac.users.get('pages').UniqueID, '633'); assert.equal(mac.users.get('pages').PrimaryGroupID, '633');
  assert.deepEqual(fails(mac), []);
});

// FINISH-A-HALF-MADE-USER plants: each set attribute that differs from the table must stop the run, naming it, changing nothing.
const half = (user, group) => { const mac = fakeMac(); mac.users.set('pages', user); if (group) mac.groups.set('pages', group); return mac; };
for (const [name, mac, want] of [
  ['a login shell already set', () => half({ UserShell: '/bin/zsh' }), /pages exists but is not as needed: its shell is \/bin\/zsh/],
  ['a visible user (IsHidden 0)', () => half({ IsHidden: '0' }), /it is not hidden/],
  ['another home folder', () => half({ NFSHomeDirectory: '/Users/pages' }), /its home is \/Users\/pages/],
  ['the user\'s id and its group\'s id disagree', () => half({ UniqueID: '640', PrimaryGroupID: '640' }, { PrimaryGroupID: '641' }), /main group is 640, not the group pages \(641\)/],
  ['the user\'s id differs from its main group (no group yet)', () => half({ UniqueID: '640', PrimaryGroupID: '641' }), /ids disagree/],
  ['root\'s id', () => half({ UniqueID: '0', PrimaryGroupID: '0' }), /root's id/],
  ['a group id another group already uses (staff, 20)', () => half({}, { PrimaryGroupID: '20' }), /outside 600-699/],
  ['an admin', () => { const m = half({ UniqueID: '640', PrimaryGroupID: '640' }, { PrimaryGroupID: '640' }); m.admins.add('pages'); return m; }, /it is an admin/],
]) {
  test(`PLANT finish-a-half-made-user: ${name} → refused naming it, nothing changed, nothing deleted`, () => {
    const m = mac(); const r = run(m, ['users-folders']);
    assert.equal(r.code, 1, r.text); assert.match(r.text, want); assert.match(r.text, /nothing was changed/i);
    assert.deepEqual(m.log, [], 'something was changed');
  });
}

test('finish-a-half-made-user: a user with only some attributes set (all matching) is completed, and a second run does nothing', () => {
  const mac = half({ UserShell: '/usr/bin/false', IsHidden: '1' }, { PrimaryGroupID: '650' });
  const dry = run(mac, ['users-folders', '--dry-run']);
  assert.equal(dry.code, 0, dry.text); assert.equal(mac.log.length, 0);
  assert.ok(!/dscl \. -create \/Users\/pages UserShell/.test(dry.text), 'rewrote a set attribute');
  assert.match(dry.text, /UniqueID 650/);
  const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text);
  assert.deepEqual(fails(mac), []);
  const n = mac.log.length;
  assert.match(run(mac, ['users-folders']).text, /nothing to do/);
  assert.equal(mac.log.length, n);
});

// m2, m4
test('--root-prefix is refused when running as root (a test-only flag may not move where root writes)', () => {
  const mac = fakeMac(); const s = sink();
  const code = main(['users-folders', '--root-prefix', '/tmp/x', '--config', cfgFile()], { io: mac, out: s.out, err: s.err });
  assert.equal(code, 2); assert.match(s.lines.join('\n'), /--root-prefix is for tests and may not be used as root/); assert.deepEqual(mac.log, []);
  const s2 = sink(); mac.as = 501;   // not root: allowed (a test), the flag only changes where the paths are read
  assert.notEqual(main(['check', '--root-prefix', '/tmp/x', '--config', cfgFile()], { io: mac, out: s2.out, err: s2.err }), 2);
});

test('root refuses a node program that others can change, before it does anything (L90 minor a)', () => {
  const mac = fakeMac(); mac.nodeProblemText = 'the node program /opt/homebrew/Cellar/node/bin/node: /opt/homebrew/bin is not owned by root';
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /root must not run a node program others can change/); assert.match(r.text, /nodejs\.org/); assert.deepEqual(mac.log, []);
  assert.equal(run(mac, ['check']).code, 2, 'a `sudo check` runs code as root too (L100 m3)');
  mac.as = 501;
  assert.equal(run(mac, ['users-folders', '--dry-run']).code, 0, 'a dry run without root needs no node check');
});

test('nodeProblemOf: the program and every folder above it must be root\'s alone', () => {
  const st = (uid, mode, link = false) => ({ uid, mode, isSymbolicLink: () => link });
  const world = (m) => (p) => { const s = m[p]; if (!s) throw new Error('ENOENT'); return s; };
  const root = { '/usr/local/bin/node': st(0, 0o100755), '/usr/local/bin': st(0, 0o40755), '/usr/local': st(0, 0o40755), '/usr': st(0, 0o40755), '/': st(0, 0o40755) };
  const port = (m) => ({ lstat: world(m), realpath: (p) => p, acl: () => null });
  assert.equal(nodeProblemOf('/usr/local/bin/node', port(root)), null);
  assert.match(nodeProblemOf('/usr/local/bin/node', port({ ...root, '/usr/local/bin/node': st(501, 0o100755) })), /is not root's/);
  assert.match(nodeProblemOf('/usr/local/bin/node', port({ ...root, '/usr/local/bin/node': st(0, 0o100775) })), /written by others/);
  assert.match(nodeProblemOf('/usr/local/bin/node', port({ ...root, '/usr/local/bin': st(501, 0o40755) })), /not owned by root/);
  assert.match(nodeProblemOf('/usr/local/bin/node', port({ ...root, '/usr/local': st(0, 0o40777) })), /can be written by others/);
});

test('REAL: this Mac\'s Homebrew node is NOT one root may run (the check says so), so the setup would refuse to run it as root', { skip: !(isDarwin && process.execPath.startsWith('/opt/homebrew')) }, () => {
  assert.match(nodeProblemOf(process.execPath) ?? '', /not owned by root|not root's|can be written/);
});

// m8: the proofs
test('proofs: the owner\'s user cannot write the record, hooks, settings, launcher, lead-main, claude-code copies or read the keys; the controls pass first', () => {
  const mac = applied(); const res = runProofs(mac, cfg);
  assert.deepEqual(res.filter((r) => !r.ok), [], JSON.stringify(res.filter((r) => !r.ok)));
  const w = res.map((r) => r.what);
  for (const d of ['hooks', 'settings', 'launcher', 'lead-main', 'claude-code']) assert.ok(w.some((x) => x.includes(`cannot write ${P(d)}`)), d);
  assert.ok(w.some((x) => x.includes(`cannot write the record ${P('products/alpha/store')}`)));
  assert.ok(w.some((x) => x.includes('cannot read the robot keys')));
  assert.match(run(mac, ['proofs']).text, /all \d+ proofs PASS/);
});

test('PLANT a folder the owner can write (hooks is the owner\'s) → the proof FAILs; a broken control makes every proof FAIL', () => {
  const mac = applied(); mac.owners.set(P('hooks'), { uid: uidOf(mac, 'sam'), gid: 20 });
  const bad = runProofs(mac, cfg).filter((r) => !r.ok); assert.equal(bad.length, 1); assert.match(bad[0].what, /cannot write .*hooks/); assert.match(bad[0].why, /CAN do this/);
  assert.equal(run(mac, ['proofs']).code, 1);
  const mac2 = applied(); mac2.owners.set(P('worker-copies'), { uid: mac2.rootUid, gid: 0 });   // the control: the owner must be able to write its own folder
  const all = runProofs(mac2, cfg); assert.equal(all[1].ok, false); assert.ok(all.slice(2).every((r) => !r.ok && /not proven/.test(r.why)));
});

test('PLANT the keys folder readable by the owner (mode 755) → the proof FAILs', () => {
  const mac = applied(); chmodSync(mac.at(P('keys')), 0o755);
  assert.ok(runProofs(mac, cfg).some((r) => !r.ok && /read the robot keys/.test(r.what)));
});

test('proofs: dry run prints the commands and runs none; without root it is refused', () => {
  const mac = fakeMac({ euid: 501 });
  const d = run(mac, ['proofs', '--dry-run']); assert.equal(d.code, 0); assert.match(d.text, /would run: sudo -n -u sam \/bin\/test -w \/Library\/orch-test\/hooks   \(must fail\)/);
  const r = run(mac, ['proofs']); assert.equal(r.code, 2); assert.match(r.text, /must run as root/);
});

test('usage errors exit 2, and an unknown argument is never echoed (it could be a secret)', () => {
  for (const args of [[], ['nope'], ['check'], ['check', '--dry-run', '--config', 'x'], ['users-folders', '--bogus'], ['users-folders', '--config']]) {
    const s = sink(); assert.equal(main(args, { io: fakeMac(), out: s.out, err: s.err }), 2, args.join(' '));
  }
  const s = sink(); assert.equal(main(['users-folders', 'sk-ant-SECRETSECRET', '--config', cfgFile()], { io: fakeMac(), out: s.out, err: s.err }), 2);
  assert.ok(!s.lines.join('\n').includes('SECRETSECRET'), 'an unknown argument was printed');
  const bad = join(mkdtempSync(join(tmpdir(), 'setup-cfg-')), 'c.json'); writeFileSync(bad, '{"base":"/Users/x","owner":"sam"}');
  const s2 = sink(); assert.equal(main(['check', '--config', bad], { io: fakeMac(), out: s2.out, err: s2.err }), 2);
});

// ---- The real read-only tools, on this Mac. -------------------------------------------------------------------------

test('REAL dscl -read: the root user reads as uid 0; a missing user reads as not there', { skip: !isDarwin }, () => {
  const io = realIo();
  const root = readUser(io, 'root');
  assert.equal(root.exists, true); assert.equal(root.uid, 0);
  const none = readUser(io, 'no-such-user-zz9');
  assert.deepEqual(none, { exists: false, error: null });
});

test('REAL dscl -read: the service user `daemon` parses as no login shell and not hidden (a missing IsHidden is "No such key")', { skip: !isDarwin }, () => {
  const d = readUser(realIo(), 'daemon');
  assert.equal(d.exists, true); assert.equal(d.uid, 1); assert.equal(d.shell, '/usr/bin/false'); assert.equal(d.hidden, false); assert.equal(d.home, '/var/root');
  const raw = spawnSync('/usr/bin/dscl', ['.', '-read', '/Users/daemon', 'IsHidden'], { encoding: 'utf8' });
  assert.equal(raw.status, 0); assert.equal(raw.stdout, ''); assert.match(raw.stderr, /No such key: IsHidden/);   // the real tool says it on stderr, so a missing key reads as absent
});

test('REAL dscl -list: both lists the id census reads give "name  number" lines', { skip: !isDarwin }, () => {
  for (const [path, key] of [['/Users', 'UniqueID'], ['/Users', 'PrimaryGroupID'], ['/Groups', 'PrimaryGroupID']]) {
    const r = spawnSync('/usr/bin/dscl', ['.', '-list', path, key], { encoding: 'utf8' });
    assert.equal(r.status, 0); const rows = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
    assert.ok(rows.length > 5 && rows.every((w) => w.length === 2 && Number.isInteger(Number(w[1]))), `${path} ${key}`);
  }
});

test('REAL ls -led: the access-list lines the check reads have the shape aclEntries parses (an inherited entry shows `inherited`)', { skip: !isDarwin }, () => {
  const d = mkdtempSync(join(tmpdir(), 'setup-acl-')); const f = join(d, 'f'); mkdirSync(f);
  assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'user:daemon allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit', f]).status, 0);
  const io = realIo();
  assert.deepEqual(aclEntries(io, f).entries, ['user:daemon allow directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search']);
  mkdirSync(join(f, 'sub'));
  assert.match(aclEntries(io, join(f, 'sub')).entries[0], /^user:daemon inherited allow /);
  assert.deepEqual(aclEntries(io, d).entries, []);
  rmSync(d, { recursive: true });
});

test('REAL dseditgroup: a service user is not an admin; the answer is "no"', { skip: !isDarwin }, () => {
  assert.equal(adminAnswer(realIo(), 'daemon'), 'no');
  assert.notEqual(adminAnswer(realIo(), 'root'), 'no');   // root is in admin: the check never reports root as safe
});

test('REAL check on this Mac with a real throwaway prefix: reads only, FAILs for the users that do not exist, changes nothing', { skip: !isDarwin }, () => {
  const prefix = realpathOf(mkdtempSync(join(tmpdir(), 'setup-real-')));
  mkdirSync(join(prefix, 'Library'));
  const io = realIo({ prefix });
  io.rootUid = process.getuid();
  const res = check(io, { ...cfg, owner: 'root' });
  assert.ok(res.some((r) => !r.ok && r.what === 'user review exists'), 'users are not on this Mac');
  assert.ok(res.some((r) => !r.ok && /missing/.test(r.why ?? '')), 'folders are not there');
  assert.ok(res.some((r) => r.ok && /owner root exists/.test(r.what)), 'real dscl read worked');
  assert.ok(!res.some((r) => /has no sudo rule/.test(r.what)), 'sudo is not asked about users that are not there');
  // stat and ls -led on a real folder, the same reads the check's folder rows use.
  const st = spawnSync('/usr/bin/stat', ['-f', '%u %Lp', prefix], { encoding: 'utf8' });
  assert.equal(st.stdout.trim().split(' ')[0], String(process.getuid()));
  const ls = spawnSync('/bin/ls', ['-led', prefix], { encoding: 'utf8' });
  assert.equal(ls.status, 0); assert.ok(!/^ \d+: /m.test(ls.stdout));
});

test('REAL plan with a real throwaway prefix on this Mac: reads only; the real dscl lists give three different ids in 600-699 and nothing is made', { skip: !isDarwin }, () => {
  const prefix = realpathOf(mkdtempSync(join(tmpdir(), 'setup-real-')));
  mkdirSync(join(prefix, 'Library'));
  const io = realIo({ prefix }); io.rootUid = process.getuid();
  const p = plan(io, { ...cfg, owner: 'root' });
  // the throwaway prefix is owned by the person running the test, standing in for root: the chain check passes, so the plan lists its steps
  assert.deepEqual(p.problems, []);
  const ids = p.ops.map((o) => /dscl \. -create \/Users\/(\w+) UniqueID (\d+)/.exec(o.text)).filter(Boolean).map((m) => Number(m[2]));
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((n) => n >= 600 && n <= 699), ids.join(','));
  assert.equal(existsSync(join(prefix, 'Library', 'orch-test')), false, 'a plan makes nothing');
});

test('the CLI file runs: --help-less call with no args prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, [new URL('./setup.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /usage: node setup.mjs/);
});

import { realpathSync } from 'node:fs';
function realpathOf(p) { return realpathSync(p); }
