// Tests for setup part 1 (R-0b-05). They run on a stand-in Mac (fake-mac.test-helper.mjs) under a throwaway folder, never
// as root and never against this Mac's users. Each "PLANT" test breaks one clause of the setup and says which check
// catches it. The last tests run the real read-only tools (dscl -read, dseditgroup, ls -led, chmod -h, stat) on this Mac.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { REVIEW_USER } from '../modules/M4-workshop/launcher/review-user.mjs';
import { readOutboxFile } from '../modules/M9-record/outbox.mjs';
import { AI_ROLES } from '../shared/record.mjs';
import { RUNNER_ROLES } from '../shared/review-roles.mjs';
import { BASE_MARKER, FLAT_OUTBOX_ROLES, ORCHESTRATE_READ_ACL, PRODUCT_OUTBOX_ROLES, ROOT_CONFIG_PATH, USERS, USER_ID_RANGE, WORKER_ROLES, aclText, folderTable, homeOf, parseConfig } from './layout.mjs';
import { nodeProblemOf, realIo, secureFolder } from './mac.mjs';
import { aclEntries, adminAnswer, apply, check, parseDscl, plan, readUser } from './users-folders.mjs';
import { WALK_MAX, changedWhy, groupsProblem, hopsOn, kindOn, proofCommands, proofInputs, proofList, proveList, refusedWhy, runProofs, stickyOn, walkOn } from './proofs.mjs';
import { main } from './setup.mjs';
import { parseDispatcher } from './dispatcher-setup.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';

const RAW = { base: '/Library/orch-test', owner: 'sam', products: ['alpha', 'beta'] };
const cfg = parseConfig(RAW);
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };
const cfgFile = () => { const d = tempDir('orch-setup-cfg-'); const f = join(d, 'c.json'); writeFileSync(f, JSON.stringify(RAW)); return f; };
// As root the command reads the root-owned config at the fixed place and takes no --config (NEW-1); without root it is given one.
const putRootConfig = (mac, raw = RAW) => { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return f; };
const run = (mac, args, raw = RAW) => {
  const s = sink(); let argv = args;
  if (mac.as === 0) putRootConfig(mac, raw); else argv = [...args, '--config', cfgFile()];
  const code = main(argv, { io: mac, out: s.out, err: s.err });
  return { code, text: s.lines.join('\n') };
};
const applied = () => { const mac = fakeMac(); const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text); return mac; };
// The proofs' Mac (L1079): set up, with the owner's home (0750, its own) holding a production file the installed review.json's
// rules name, so every proof has something to try. `files`: what the rules name (default the one there).
const SECRET = '/Users/sam/app/.env.production';
const proven = ({ files = [SECRET], mac = applied() } = {}) => {
  const sam = { uid: uidOf(mac, 'sam'), gid: 20 };
  for (const [d, mode] of [['/Users', 0o755], ['/Users/sam', 0o750], ['/Users/sam/app', 0o755]]) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), mode); mac.owners.set(d, d === '/Users' ? { uid: mac.rootUid, gid: 80 } : sam); }
  writeFileSync(mac.at(SECRET), 'x'); chmodSync(mac.at(SECRET), 0o600); mac.owners.set(SECRET, sam);
  // The proposals folders (#528 r2 m2): /Users/Shared as on a real Mac (root's, sticky), then setup's own `proposals`.
  mkdirSync(mac.at('/Users/Shared'), { recursive: true }); chmodSync(mac.at('/Users/Shared'), 0o1777); mac.owners.set('/Users/Shared', { uid: mac.rootUid, gid: 0 });
  const pr = run(mac, ['proposals']); assert.equal(pr.code, 0, pr.text);
  const root = P('install/orchestrate'); mkdirSync(mac.at(root), { recursive: true });
  writeFileSync(mac.at(`${root}/review.json`), JSON.stringify({ rules: { production: { env_files: files }, secrets: { paths: [] } } }));
  return mac;
};
const fails = (mac) => check(mac, cfg).filter((r) => !r.ok);
const isDarwin = process.platform === 'darwin';
const P = (s) => `${cfg.base}/${s}`;
const uidOf = (mac, u) => Number(mac.users.get(u).UniqueID);

test('the setup\'s review user is the launcher\'s', () => {
  assert.ok(USERS.includes(REVIEW_USER));
  assert.deepEqual([...USERS], ['orchestrate', 'pages', 'review', 'builder']);   // L1079
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

test('the folder table: parents first, exact modes and owners, one outbox root with a folder per role and per product, nothing outside the base', () => {
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
  assert.deepEqual([by('worker-copies').owner], ['builder']);   // L1079
  assert.deepEqual([by('review').owner, by('review-copies').owner], ['review', 'review']);
  for (const u of USERS) assert.equal(by(`home/${u}`).path, homeOf(cfg, u));
  // L71 / L90 M1: the outbox root is root's 0755; reviewer/ and auditor/ are review's; every other role's is the workers' user's
  assert.deepEqual([by('outboxes').owner, by('outboxes').mode], ['root', 0o755]);
  assert.equal(by('review-outbox'), undefined);
  // L722: every role the review runner starts (the plan reviewer too, named here, not read from the list) is review's.
  for (const r of new Set([...RUNNER_ROLES, 'reviewer', 'auditor', 'plan_reviewer'])) assert.deepEqual([by(`outboxes/${r}`)?.owner, by(`outboxes/${r}`)?.mode, by(`outboxes/${r}`)?.acl], ['review', 0o755, []], r);
  assert.deepEqual([...WORKER_ROLES].sort(), AI_ROLES.filter((r) => !RUNNER_ROLES.includes(r)).sort());
  assert.ok(WORKER_ROLES.includes('worker') && WORKER_ROLES.includes('lead'));
  for (const r of ['reviewer', 'auditor', 'plan_reviewer']) assert.ok(!WORKER_ROLES.includes(r), `${r} is not a worker role`);
  // L914: the worker runner's roles have no flat folder; theirs are each product's (L836, the L836 test below).
  assert.deepEqual([...FLAT_OUTBOX_ROLES].sort(), WORKER_ROLES.filter((r) => !PRODUCT_OUTBOX_ROLES.includes(r)).sort());
  assert.ok(PRODUCT_OUTBOX_ROLES.includes('worker') && PRODUCT_OUTBOX_ROLES.includes('script') && FLAT_OUTBOX_ROLES.includes('lead'));
  for (const r of FLAT_OUTBOX_ROLES) assert.deepEqual([by(`outboxes/${r}`).owner, by(`outboxes/${r}`).mode, by(`outboxes/${r}`).acl], ['owner', 0o750, [ORCHESTRATE_READ_ACL]]);
  for (const r of PRODUCT_OUTBOX_ROLES) assert.equal(by(`outboxes/${r}`), undefined, `no flat ${r} folder (L914)`);
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
  assert.match(r.text, /set the access list of \/Library\/orch-test\/outboxes\/lead to user:orchestrate allow delete_child,directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search/);
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
    assert.equal(a.UserShell, u === 'builder' ? '/bin/zsh' : '/usr/bin/false'); assert.equal(a.IsHidden, '1');   // #487 r5 m1: builder's shell is zsh assert.equal(a.Password, '*');
    assert.equal(a.UniqueID, a.PrimaryGroupID); assert.equal(a.NFSHomeDirectory, homeOf(cfg, u));
    assert.ok(Number(a.UniqueID) >= USER_ID_RANGE.low && Number(a.UniqueID) <= USER_ID_RANGE.high);
    assert.equal(mac.groups.get(u).PrimaryGroupID, a.UniqueID);
  }
  assert.deepEqual([USER_ID_RANGE.low, USER_ID_RANGE.high], [600, 699]);
  assert.equal(new Set(USERS.map((u) => mac.users.get(u).UniqueID)).size, USERS.length, 'all different ids');
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
    assert.equal(st.gid, ids[row.group ?? row.owner].gid, `${row.path} group`);   // a row may name another user's group (L1079 outboxes)
    assert.equal(st.mode & 0o7777, row.mode, `${row.path} mode`);
    assert.deepEqual(aclEntries(mac, row.path).entries, row.acl.map(aclText).sort(), `${row.path} access list`);
  }
});

test('users skip ids already taken by a user OR a group (K10)', () => {
  const mac = fakeMac({ users: { other: { UniqueID: '600', PrimaryGroupID: '601' } } });
  mac.groups.set('stray', { PrimaryGroupID: '602' });
  assert.equal(run(mac, ['users-folders']).code, 0);
  const ids = USERS.map((u) => Number(mac.users.get(u).UniqueID));
  assert.deepEqual(ids, [603, 604, 605, 606]);
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
  const put = (dir, name, text) => { const d = join(root, ...dir); mkdirSync(d, { recursive: true }); const f = join(d, name); writeFileSync(f, text, { mode: 0o644 }); chmodSync(f, 0o644); return f; };
  // A worker's outbox is in its product's folder (L836, L895 m1); a reviewer's is flat.
  const workerFile = put(['alpha', 'worker', 'sess-1'], 'report-x.md', 'a report\n');
  const w = readOutboxFile({ outboxRoot: root, uids: { worker: me, reviewer: me + 1, auditor: me + 1 }, tag: { role: 'worker', product: 'alpha', sessionId: 'sess-1' }, file: workerFile });
  assert.equal(w.ok, true, w.reason);
  const verdictFile = put(['reviewer', 'sess-2'], 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', fields: {} })}\nbody\n`);
  chmodSync(join(root, 'reviewer', 'sess-2'), 0o755);
  const v = readOutboxFile({ outboxRoot: root, uids: { worker: me + 1, reviewer: me, auditor: me }, tag: { role: 'reviewer', sessionId: 'sess-2' }, file: verdictFile });
  assert.equal(v.ok, true, v.reason);
  // and each role has its folder under that one root (no other root is needed): the worker runner's roles in each
  // product's folder (L836, L914), the rest flat
  for (const r of AI_ROLES) assert.ok(statSync(PRODUCT_OUTBOX_ROLES.includes(r) ? join(root, 'alpha', r) : join(root, r)).isDirectory(), r);
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
  assert.ok(w.includes(`${USERS.join(', ')}, the owner and root all have different ids`), w.join(' | '));
  assert.ok(w.includes(`user review's id is in 600-699`));
  assert.ok(run(mac, ['check']).code === 1);
});

test('PLANT P4: orchestrate and review share one id → caught by "belongs to no other user" and "all have different ids"', () => {
  const mac = applied(); mac.users.get('orchestrate').UniqueID = mac.users.get('review').UniqueID;
  const f = fails(mac); const w = f.map((x) => x.what);
  assert.ok(w.includes(`${USERS.join(', ')}, the owner and root all have different ids`), w.join(' | '));
  assert.ok(w.includes(`user orchestrate's id belongs to no other user`)); assert.ok(w.includes(`user review's id belongs to no other user`));
});

test('PLANT two of the three share one GROUP id → caught by "have different groups" and "belongs to no other group"', () => {
  const mac = applied();
  mac.groups.get('pages').PrimaryGroupID = mac.groups.get('review').PrimaryGroupID; mac.users.get('pages').PrimaryGroupID = mac.groups.get('review').PrimaryGroupID;
  const w = fails(mac).map((x) => x.what);
  assert.ok(w.includes(`${USERS.join(', ')} have different groups`), w.join(' | ')); assert.ok(w.includes(`group review's id belongs to no other group`));
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

test('PLANT worker-copies owned by root instead of the builder → caught by the owner column', () => {
  const mac = applied(); mac.owners.set(P('worker-copies'), { uid: mac.rootUid, gid: 0 });
  assert.match(fails(mac)[0].why, new RegExp(`want ${uidOf(mac, 'builder')}`));
});

test('PLANT L722: the plan reviewer\'s outbox made the workers\' user\'s (as a worker role\'s is) → caught by the owner and mode; apply refuses to take it over and changes nothing', () => {
  const mac = applied(); const d = P('outboxes/plan_reviewer');
  mac.owners.set(d, { uid: uidOf(mac, 'sam'), gid: 0 }); chmodSync(mac.at(d), 0o750);
  const f = fails(mac).filter((x) => x.what.includes(d)); assert.ok(f.length >= 1, JSON.stringify(fails(mac)));
  const whys = f.map((x) => x.why).join('\n');
  assert.match(whys, new RegExp(`owner is uid ${uidOf(mac, 'sam')}, want ${uidOf(mac, 'review')}`)); assert.match(whys, /mode is 750, want 755/);
  // A folder the workers' user owns is never taken over (a worker could have put files in it): root must look first.
  const r = run(mac, ['users-folders']); assert.equal(r.code, 1, r.text); assert.match(r.text, /plan_reviewer is owned by uid \d+, who is neither root nor review, so it is not taken over: .* Look inside it, remove it by hand, then run users-folders again\. Nothing was changed/);
  assert.deepEqual(mac.owners.get(d), { uid: uidOf(mac, 'sam'), gid: 0 }); assert.ok(fails(mac).some((x) => x.what.includes(d)));
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
  assert.deepEqual(aclEntries(mac, P('outboxes/lead')).entries, [want]);
  assert.deepEqual(aclEntries(mac, P('outboxes/alpha/worker')).entries, [want]);
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
  const mac = applied(); assert.equal(spawnSync('/bin/chmod', ['-h', '+a', 'everyone allow write,delete_child', mac.at(P('outboxes/lead'))]).status, 0);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /access list has an entry that is not wanted: group:everyone allow/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
  assert.deepEqual(aclEntries(mac, P('outboxes/lead')).entries, [aclText(ORCHESTRATE_READ_ACL)]);
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
  // make a new folder under outboxes/lead (which carries the inheriting entry) and look at it: it shows `inherited`
  const sub = mac.at(P('outboxes/lead/sess')); mkdirSync(sub);
  assert.match(spawnSync('/bin/ls', ['-led', sub], { encoding: 'utf8' }).stdout, /inherited allow/);
  assert.ok(aclEntries(mac, P('outboxes/lead/sess')).entries[0].includes(' inherited '), 'the check reads an inherited entry as an entry, so a table folder that has one FAILs');
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
  assert.equal(r.code, 2, r.text); assert.match(r.text, /folder root's setup config is in is not root's alone/);
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
  const d = tempDir('orch-setup-link-'); const target = join(d, 't'); mkdirSync(target);
  assert.equal(spawnSync('/bin/chmod', ['+a', 'user:daemon allow list,search', target]).status, 0);
  symlinkSync(target, join(d, 'l'));
  const r = spawnSync('/bin/chmod', ['-h', '-N', join(d, 'l')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(spawnSync('/bin/ls', ['-led', target], { encoding: 'utf8' }).stdout, /user:daemon allow list,search/, 'the target\'s access list was removed through the link');
  rmSync(d, { recursive: true });
});

test('secureFolder: refuses a link, a file, a replaced folder; changes a real one through its handle', () => {
  const d = tempDir('orch-setup-secure-'); const f = join(d, 'f'); mkdirSync(f, { mode: 0o700 });
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
test('proofs (L1079): the builder cannot write the record, hooks, settings, launcher, lead-main, claude-code copies, read the keys, the owner\'s home or its production files; the controls pass first', () => {
  const mac = proven(); const res = runProofs(mac, cfg);
  assert.deepEqual(res.filter((r) => !r.ok), [], JSON.stringify(res.filter((r) => !r.ok)));
  const w = res.map((r) => r.what);
  for (const d of ['hooks', 'settings', 'launcher', 'lead-main', 'claude-code', 'worker-runner']) assert.ok(w.some((x) => x.includes(`cannot write ${P(d)}`)), d);  // worker-runner: #433 r1 m2
  assert.ok(w.some((x) => x.includes(`cannot write the record ${P('products/alpha/store')}`)));
  assert.ok(w.some((x) => x.includes('cannot read the robot keys')));
  assert.ok(w.some((x) => x === 'builder cannot list the owner\'s home /Users/sam'));
  assert.ok(w.some((x) => x === `builder cannot read ${SECRET}`));
  assert.ok(w.some((x) => /builder's groups are its own/.test(x)));
  assert.match(run(mac, ['proofs']).text, /all \d+ proofs PASS: containment is proven/);
});

test('PLANT a folder the builder can write (hooks is the builder\'s) → the proof FAILs; a broken control makes every proof FAIL', () => {
  const mac = proven(); mac.owners.set(P('hooks'), { uid: uidOf(mac, 'builder'), gid: 20 });
  const bad = runProofs(mac, cfg).filter((r) => !r.ok); assert.equal(bad.length, 1); assert.match(bad[0].what, /cannot write .*hooks/); assert.match(bad[0].why, /CAN do this/);
  assert.equal(run(mac, ['proofs']).code, 1);
  const mac2 = proven(); mac2.owners.set(P('worker-copies'), { uid: mac2.rootUid, gid: 0 });   // the control: the builder must be able to write its own folder
  const all = runProofs(mac2, cfg); assert.equal(all[1].ok, false); assert.ok(all.slice(2, -2).every((r) => !r.ok && /not proven/.test(r.why)));
});

test('L836 proofs: per product, the builder CAN write its copies folder and its worker runner outbox folders (controls), and can NOT write its outbox folder', () => {
  const mac = proven(); const list = proofList(cfg, { kindOf: kindOn(mac) }); const res = runProofs(mac, cfg);
  assert.deepEqual(res.filter((r) => !r.ok), [], JSON.stringify(res.filter((r) => !r.ok)));
  const lastControl = list.map((x) => !!x.control).lastIndexOf(true);
  assert.ok(list.slice(0, lastControl + 1).every((x) => x.control), 'every control comes before every proof it guards');
  for (const prod of cfg.products) {
    for (const d of [`worker-copies/${prod}`, `outboxes/${prod}/worker`, `outboxes/${prod}/script`]) {
      const x = list.find((y) => y.args?.at(-1) === P(d)); assert.ok(x, d); assert.equal(x.control, true, d); assert.equal(x.expect, 'ok', d); assert.deepEqual(x.args, ['/bin/test', '-w', P(d)]);
    }
    const no = list.find((y) => y.args?.at(-1) === P(`outboxes/${prod}`)); assert.ok(no, prod); assert.equal(no.expect, 'fail'); assert.ok(!no.control);
    assert.match(no.what, new RegExp(`cannot write ${prod}'s outbox folder`));
  }
});

test('L836 PLANT: a product\'s outbox folder the builder can write → that proof FAILs; its copies folder not the builder\'s → its control fails and nothing after counts', () => {
  const mac = proven(); mac.owners.set(P('outboxes/beta'), { uid: uidOf(mac, 'builder'), gid: 20 });
  const bad = runProofs(mac, cfg).filter((r) => !r.ok); assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.match(bad[0].what, /cannot write beta's outbox folder/); assert.match(bad[0].why, /CAN do this/);
  assert.equal(run(mac, ['proofs']).code, 1);
  const mac2 = proven(); mac2.owners.set(P('worker-copies/alpha'), { uid: mac2.rootUid, gid: 0 });
  const all = runProofs(mac2, cfg); const at = all.findIndex((r) => r.what.includes(`write ${P('worker-copies/alpha')} `));
  assert.ok(at > 1 && all[at].ok === false, JSON.stringify(all[at]));
  assert.ok(all.slice(at + 1, -2).length > 0 && all.slice(at + 1, -2).every((r) => !r.ok && /not proven/.test(r.why)), JSON.stringify(all.slice(at + 1)));
});

test('L836 check: the workers\' copies folder holds only the config\'s product folders; a flat copy from before, or a dropped product\'s, FAILs by name and is not removed', () => {
  const mac = applied();
  const row = (c = cfg) => check(mac, c).find((i) => i.what.startsWith(`${P('worker-copies')} holds only`));
  assert.equal(row().ok, true);
  mkdirSync(mac.at(P('worker-copies/card-41')));
  let i = row(); assert.equal(i.ok, false);
  assert.match(i.why, new RegExp(`holds an entry that is no product folder of this config .*: ${P('worker-copies/card-41')}\\. Check that each holds nothing unsaved .* then remove it; setup removes nothing itself`));
  assert.equal(run(mac, ['check']).code, 1);
  assert.ok(existsSync(mac.at(P('worker-copies/card-41'))), 'setup removes nothing');
  rmSync(mac.at(P('worker-copies/card-41')), { recursive: true });
  // beta dropped from the config: its copies folder is named too.
  const one = parseConfig({ ...RAW, products: ['alpha'] });
  i = row(one); assert.equal(i.ok, false); assert.match(i.why, new RegExp(`: ${P('worker-copies/beta')}\\.`));
  assert.equal(row().ok, true);
  // Several, sorted, cut off after five; a stray file counts; Finder's .DS_Store does not (review m3, m5).
  const C = (n) => P(`worker-copies/${n}`);
  writeFileSync(mac.at(C('.DS_Store')), ''); assert.equal(row().ok, true, '.DS_Store is let be');
  mkdirSync(mac.at(C('.card-9'))); assert.match(row().why, new RegExp(`^holds an entry .*: ${C('.card-9')}\\. Check`), 'any other hidden entry is named'); rmSync(mac.at(C('.card-9')), { recursive: true });
  writeFileSync(mac.at(C('notes.txt')), 'x'); mkdirSync(mac.at(C('card-7')));
  assert.match(row().why, new RegExp(`^holds 2 entries that are no product folder .*: ${C('card-7')}, ${C('notes.txt')}\\. Check`));
  for (const n of ['card-1', 'card-2', 'card-3', 'card-4', 'card-5']) mkdirSync(mac.at(C(n)));
  assert.match(row().why, new RegExp(`^holds 7 entries .*: ${['card-1', 'card-2', 'card-3', 'card-4', 'card-5'].map(C).join(', ')} and 2 more\\. Check`));
  for (const n of ['notes.txt', 'card-7', 'card-1', 'card-2', 'card-3', 'card-4', 'card-5']) rmSync(mac.at(C(n)), { recursive: true });
  assert.equal(row().ok, true);
  // A flat copy whose card is named as a product looks like that product's folder, but it is a copy (review m4).
  mkdirSync(mac.at(C('alpha/.git'))); assert.match(row().why, new RegExp(`^holds an entry .*: ${C('alpha')}\\. Check`));
  rmSync(mac.at(C('alpha/.git')), { recursive: true }); assert.equal(row().ok, true);
  // A product's name in another letter case is not that product's folder (review r1 m2). This Mac's disk ignores case, so
  // the listing a case-sensitive volume would give (Alpha beside alpha) is handed to check.
  { const ls = mac.list; mac.list = (d) => (d === P('worker-copies') ? [...ls(d), 'Alpha'] : ls(d));
    assert.match(row().why, new RegExp(`^holds an entry .*: ${C('Alpha')}\\. Check`)); mac.list = ls; }
  assert.equal(row().ok, true);
  // A folder that cannot be listed FAILs rather than drops the row (review m2).
  const list = mac.list; mac.list = (d) => { if (d === P('worker-copies')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return list(d); };
  assert.deepEqual(row(), { ok: false, what: `${P('worker-copies')} holds only the config's product folders (L836)`, why: 'its contents could not be listed' });
  mac.list = list;
});

test('L914 check: a flat outbox folder of a worker runner role, left from before, FAILs naming what it holds and is not removed', () => {
  const mac = applied();
  const row = (r) => check(mac, cfg).find((i) => i.what.startsWith(`${P(`outboxes/${r}`)} is gone`));
  // Gone (a fresh install never had them): no row at all, PASS or FAIL (#433 r1 c2).
  for (const r of PRODUCT_OUTBOX_ROLES) assert.equal(row(r), undefined, r);
  assert.deepEqual(check(mac, cfg).filter((i) => !i.ok), []);
  // Left from before with a hand-in in it: named, and the outbox root's own row does not FAIL on it too.
  const W = (s = '') => mac.at(P(`outboxes/worker${s}`));
  mkdirSync(W('/sess-1'), { recursive: true }); writeFileSync(W('/sess-1/report.md'), 'x'); writeFileSync(W('/.DS_Store'), '');
  let i = row('worker'); assert.equal(i.ok, false);
  assert.match(i.why, new RegExp(`^it is still there and holds an entry: ${P('outboxes/worker/sess-1')}\\. Check that it holds nothing unsaved \\(a hand-in not yet taken in\\), then remove it; setup removes nothing itself$`));
  assert.deepEqual(check(mac, cfg).filter((x) => !x.ok).map((x) => x.what), [i.what], 'only this row FAILs: not the outbox root\'s');
  assert.equal(run(mac, ['check']).code, 1);
  // The apply leaves it too, and says it still FAILs (the owner clears it by hand).
  { const r = run(mac, ['users-folders']); assert.equal(r.code, 1, r.text); assert.match(r.text, /1 item\(s\) still FAIL after the run/); }
  assert.ok(existsSync(W('/sess-1/report.md')), 'setup removes nothing');
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) mkdirSync(W(`/${n}`));
  assert.match(row('worker').why, new RegExp(`^it is still there and holds 7 entries: ${['a', 'b', 'c', 'd', 'e'].map((n) => P(`outboxes/worker/${n}`)).join(', ')} and 2 more\\. Check that each holds`));
  rmSync(W(), { recursive: true });
  // Empty, a file, a link: each named; gone again: PASS.
  mkdirSync(mac.at(P('outboxes/script')));
  assert.match(row('script').why, /^it is still there, empty\. Check that it holds nothing unsaved/);
  rmSync(mac.at(P('outboxes/script')), { recursive: true }); writeFileSync(mac.at(P('outboxes/script')), 'x');
  assert.match(row('script').why, /^it is still there \(not a folder\)\. Check that it holds nothing unsaved, then remove it; setup removes nothing itself$/);
  assert.deepEqual(check(mac, cfg).filter((x) => !x.ok).map((x) => x.what), [row('script').what], 'a file there FAILs only on its own row');
  rmSync(mac.at(P('outboxes/script'))); symlinkSync(mac.at(P('outboxes/alpha/script')), mac.at(P('outboxes/script')));
  assert.match(row('script').why, /^it is still there \(a link\)\./);
  assert.deepEqual(check(mac, cfg).filter((x) => !x.ok).map((x) => x.what), [row('script').what], 'a link there FAILs only on its own row');
  rmSync(mac.at(P('outboxes/script'))); assert.equal(row('script'), undefined, 'gone again: no row');
  // A folder that cannot be listed or looked at FAILs rather than passes.
  mkdirSync(W());
  const list = mac.list; mac.list = (d) => { if (d === P('outboxes/worker')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return list(d); };
  assert.equal(row('worker').why, 'it is still there, and its contents could not be listed'); mac.list = list;
  const lstat = mac.lstat; mac.lstat = (q) => { if (q === P('outboxes/worker')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return lstat(q); };
  assert.equal(row('worker').why, 'it could not be looked at (EACCES)'); mac.lstat = lstat;
  rmSync(W(), { recursive: true }); assert.deepEqual(check(mac, cfg).filter((x) => !x.ok), []);
  // Any other entry in the root-owned outbox root still FAILs on the root's row (the L914 names are the only ones let be).
  mkdirSync(mac.at(P('outboxes/stray')));
  assert.match(check(mac, cfg).find((x) => !x.ok).why, /holds an entry the setup did not make: stray/);
  rmSync(mac.at(P('outboxes/stray')), { recursive: true });
});

test('L1035 c4: a .bob-new or .bob-old a cut-off bob run left in the base FAILs the base saying to run bob again; any other stray does not', () => {
  const mac = applied();
  const baseRow = () => check(mac, cfg).find((x) => !x.ok && x.what.startsWith(`${cfg.base} `));
  assert.equal(baseRow(), undefined, 'a clean base passes');
  mkdirSync(mac.at(P('.bob-new')));
  assert.match(baseRow().why, /holds an entry the setup did not make: \.bob-new; \.bob-new was left by a cut-off bob run: run bob again/);
  mkdirSync(mac.at(P('.bob-old')));
  assert.match(baseRow().why, /\.bob-new and \.bob-old were left by a cut-off bob run: run bob again/);
  rmSync(mac.at(P('.bob-new')), { recursive: true }); rmSync(mac.at(P('.bob-old')), { recursive: true });
  mkdirSync(mac.at(P('stray')));
  assert.doesNotMatch(baseRow().why, /cut-off bob run/, 'another stray is not called a bob leftover');
  rmSync(mac.at(P('stray')), { recursive: true });
  // The hint is the base's own: the same name in another root-owned folder is just a stray.
  mkdirSync(mac.at(P('outboxes/.bob-new')));
  const other = check(mac, cfg).find((x) => !x.ok);
  assert.match(other.why, /holds an entry the setup did not make: \.bob-new/); assert.doesNotMatch(other.why, /cut-off bob run/);
});

test('L921: the worker runner\'s requests, own and snapshots folders: each apart, no links, under a root-owned parent, as the runner and the Dispatcher read them', async () => {
  const { WORKER_REQUESTS_ACL, WORKER_RUNNER_FOLDERS, mirrorPath, outboxRootPath, workerCopiesPath, workerRunnerPath, workerRunnerPaths } = await import('./layout.mjs');
  const { runnerWallDirs } = await import('../modules/M4-workshop/launcher/render-settings.mjs');
  const t = folderTable(cfg); const row = (p) => t.find((r) => r.path === p);
  const w = workerRunnerPaths(cfg);
  assert.deepEqual(Object.keys(w), ['requests', 'state', 'snapshots']);
  assert.deepEqual(Object.keys(WORKER_RUNNER_FOLDERS), Object.keys(w));
  assert.deepEqual([row(workerRunnerPath(cfg)).owner, row(workerRunnerPath(cfg)).mode, row(workerRunnerPath(cfg)).acl], ['root', 0o755, []]);
  assert.deepEqual([row(w.requests).owner, row(w.requests).mode, row(w.requests).acl, row(w.requests).group], ['builder', 0o700, [WORKER_REQUESTS_ACL], undefined]);   // L1079
  assert.deepEqual([row(w.state).owner, row(w.state).mode, row(w.state).acl], ['builder', 0o755, []]);
  assert.deepEqual([row(w.snapshots).owner, row(w.snapshots).mode, row(w.snapshots).acl], ['builder', 0o755, []]);
  // orchestrate only goes in and adds a file (owner-status.mjs requestWriter writes exclusively): no list, read, delete or inherit.
  assert.deepEqual([...WORKER_REQUESTS_ACL.perms].sort(), ['add_file', 'search']);
  assert.equal(WORKER_REQUESTS_ACL.who, 'user:orchestrate');
  // The Dispatcher reads the status through owner-status.mjs readOwnerStatus: the folder must be the owner's and not
  // writable by others (plainOwned), or every pass refuses.
  assert.equal(row(w.state).mode & 0o022, 0);
  // Each apart from the others and from every copies, outbox and mirror folder (none is in another, either way round).
  const inside = (a, b) => a === b || a.startsWith(`${b}/`);
  const others = [workerCopiesPath(cfg), outboxRootPath(cfg), mirrorPath(cfg), join(cfg.base, 'review'), join(cfg.base, 'review-copies')];
  const runner = Object.values(w);
  for (const a of runner) {
    for (const b of runner) if (a !== b) assert.ok(!inside(a, b) && !inside(b, a), `${a} apart from ${b}`);
    for (const b of others) assert.ok(!inside(a, b) && !inside(b, a), `${a} apart from ${b}`);
  }
  // Every table row under them is one of these: nothing else is made in the runner's folders.
  assert.deepEqual(t.filter((r) => inside(r.path, workerRunnerPath(cfg))).map((r) => r.path), [workerRunnerPath(cfg), ...runner]);
  // As the runner's wall reads them (render-settings.mjs runnerWallDirs): plain, below a folder of their own, two apart.
  const wall = runnerWallDirs({ requestsDir: w.requests, statusFile: join(w.state, 'status.json') });
  assert.deepEqual(wall, { ok: true, dirs: [w.requests, w.state] });
  // Made on the Mac as the table says, no link anywhere on the way.
  const mac = applied();
  for (const p of [workerRunnerPath(cfg), ...runner]) assert.ok(mac.lstat(p).isDirectory() && !mac.lstat(p).isSymbolicLink(), p);
  assert.deepEqual(check(mac, cfg).filter((x) => !x.ok), []);
  // A link put in place of one FAILs (its row), and setup does not follow it.
  rmSync(mac.at(w.snapshots), { recursive: true }); symlinkSync(mac.at(w.state), mac.at(w.snapshots));
  assert.ok(check(mac, cfg).some((x) => !x.ok && x.what.includes(w.snapshots)), 'a link in place of the snapshots folder FAILs');
  // and the apply does not follow it: it refuses, and the folder the link leads to keeps its owner and mode.
  const before = mac.lstat(w.state);
  const r = run(mac, ['users-folders']); assert.notEqual(r.code, 0, r.text); assert.match(r.text, /is a link; nothing was changed/);
  const after = mac.lstat(w.state); assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);
});

test('PLANT the keys folder readable by the builder (mode 755) → the proof FAILs', () => {
  const mac = proven(); chmodSync(mac.at(P('keys')), 0o755);
  assert.ok(runProofs(mac, cfg).some((r) => !r.ok && /read the robot keys/.test(r.what)));
});

test('L1079 PLANTs: the owner\'s home or a production file the builder can read → FAIL; the builder in staff, or groups unreadable → FAIL', () => {
  const one = (mac, re) => { const bad = runProofs(mac, cfg).filter((r) => !r.ok); assert.equal(bad.length, 1, JSON.stringify(bad)); assert.match(bad[0].what, re); return bad[0]; };
  const bads = (mac) => runProofs(mac, cfg).filter((r) => !r.ok).map((r) => r.what);
  let mac = proven(); chmodSync(mac.at('/Users/sam'), 0o755); assert.deepEqual(bads(mac), ['builder cannot list the owner\'s home /Users/sam', 'builder cannot pass through /Users/sam']);
  // #528 r1 m3: a home that can be passed through but not listed (0751) is caught on its own, and then only the file's mode stops the read.
  mac = proven(); chmodSync(mac.at('/Users/sam'), 0o751); assert.deepEqual(bads(mac), ['builder cannot pass through /Users/sam']);
  chmodSync(mac.at(SECRET), 0o644); assert.deepEqual(bads(mac), ['builder cannot pass through /Users/sam', `builder cannot read ${SECRET}`]);
  mac = proven(); mac.groupNames = { builder: ['builder', 'everyone', 'staff'] }; assert.match(one(mac, /groups are its own/).why, /in staff/);
  mac = proven(); mac.groupNames = { builder: { status: 1, stderr: 'id: no' } }; assert.match(one(mac, /groups are its own/).why, /could not be read/);
  mac = proven(); mac.groupNames = { builder: [] }; assert.match(one(mac, /groups are its own/).why, /empty/, 'an empty list is never "no bad groups"');
  // #487 r5 m1: the builder's shell is zsh; bash or none → FAIL.
  for (const sh of ['/bin/bash', '/usr/bin/false']) { mac = proven(); mac.users.get('builder').UserShell = sh; assert.match(one(mac, /builder's shell is \/bin\/zsh/).why, new RegExp(`its shell is ${sh}`)); }
  assert.equal(run(mac, ['proofs']).code, 1);
});

test('#528 r1 M1 PLANT: only the Mac\'s "Permission denied" proves a read refused; a folder the rules name is proven by listing and passing through', () => {
  // macOS's head on a folder it may read: exit 1, "Error reading" — a failure, but not a refusal.
  const hx = { args: ['/usr/bin/head', '-c', '1', '/x'], expect: 'denied' };
  assert.match(refusedWhy(hx, { status: 1, stderr: 'head: Error reading /x\n' }), /not with the Mac's own "Permission denied"/);
  assert.equal(refusedWhy(hx, { status: 1, stderr: 'head: /x: Permission denied\n' }), null);
  assert.match(refusedWhy(hx, { status: 1, stderr: 'cat: /x: Operation not permitted\n' }), /not proven/);
  assert.equal(refusedWhy({ args: ['/bin/test', '-w', '/x'], expect: 'fail' }, { status: 1, stderr: '' }), null);
  assert.match(refusedWhy({ args: ['/bin/test', '-w', '/x'], expect: 'fail' }, { status: 2, stderr: 'test: bad' }), /did not answer a plain no/);
  const dir = '/Users/sam/app';
  let mac = proven({ files: [dir] });   // 0755 under a home the builder can't enter: refused on the way in
  assert.deepEqual(runProofs(mac, cfg).filter((r) => !r.ok).map((r) => r.what), []);
  mac = proven({ files: [dir] }); chmodSync(mac.at('/Users/sam'), 0o751);   // now the folder itself can be listed: FAIL, never PASS
  const bad = runProofs(mac, cfg).filter((r) => !r.ok).map((r) => r.what);
  assert.ok(bad.includes(`builder cannot list ${dir}`) && bad.includes(`builder cannot pass through ${dir}`), JSON.stringify(bad));
  // The stand-in's head answers as macOS's: a folder it may read, read as a file, is "Error reading", which must not count.
  const h = mac.run('/usr/bin/sudo', ['-n', '-H', '-u', 'builder', '/usr/bin/head', '-c', '1', dir]);
  assert.equal(h.status, 1); assert.match(h.stderr, /Error reading/); assert.notEqual(refusedWhy({ args: ['/usr/bin/head', '-c', '1', dir], expect: 'denied' }, h), null);
});

test('#528 r1 m8 and L1112 (3): a place root can\'t look at is NOT TRIED with its reason, never "not there"; the Dispatcher\'s rules state and approvals are on the cannot-read list', () => {
  const dcfg = { ...cfg, dispatcher: { rulesStateDir: P('private/rules-state'), approvalsStateDir: P('private/approvals') } };
  const list = proofList(dcfg, { ownerHome: '/Users/sam', rules: { files: [SECRET] }, kindOf: (f) => (f === SECRET ? { kind: 'error:EACCES', real: null } : { kind: 'dir', real: f }), walkOf: () => ({ links: [], named: [] }) });
  const nt = list.filter((x) => x.notTried);
  assert.equal(nt.length, 1); assert.match(nt[0].notTried, /root could not look at it \(EACCES\)/); assert.doesNotMatch(nt[0].notTried, /not on this Mac/);
  for (const d of [P('private/rules-state'), P('private/approvals')]) {
    assert.ok(list.some((x) => x.what === `builder cannot list ${d}` && x.expect === 'denied'), d);
    assert.ok(list.some((x) => x.what === `builder cannot pass through ${d}`), d);
  }
  assert.ok(!proofList(cfg, { kindOf: (f) => ({ kind: 'dir', real: f }) }).some((x) => /rules-state|approvals/.test(x.what)), 'no dispatcher entry: neither exists, nothing claimed');
  const home = proofList(cfg, { ownerHome: '/Users/sam', kindOf: () => ({ kind: 'error:EPERM', real: null }) }).find((x) => /owner's home/.test(x.what));
  assert.match(home.notTried, /root could not look at it \(EPERM\)/);
});

test('#528 r2 M1 REAL: a rules entry that is a link to a folder one may pass through but not list is judged as a folder; head on it is refused while a file inside reads', { skip: process.platform !== 'darwin' || process.getuid?.() === 0 }, () => {
  // macOS only: the proofs run on the Mac, and the refusal checked is macOS head's own wording (GNU head says "cannot open
  // … for reading", which refusedWhy rightly reads as not proven). CI's macOS job runs it.
  const d = tempDir('orch-r2m1-'); const dir = join(d, 'keys'); const link = join(d, 'keys-link');
  mkdirSync(dir); writeFileSync(join(dir, 'key'), 'k'); symlinkSync(dir, link); chmodSync(dir, 0o100);   // pass through, no listing (0100: this user's own, as 0711 is to others)
  try {
    const io = realIo();
    const k = kindOn(io)(link); assert.deepEqual([k.kind, k.real], ['dir', realpathSync(dir)], 'judged by what it leads to');
    assert.ok(k.steps.includes(link.replace(/^\/var\//, '/private/var/')) && k.steps.at(-1) === realpathSync(dir), 'r5: the link and where it leads are on the way');
    // The bug, shown on this Mac as this user: the old file proof reads as refused, though the file inside reads.
    const head = spawnSync('/usr/bin/head', ['-c', '1', link], { encoding: 'utf8' });
    assert.equal(refusedWhy({ args: ['/usr/bin/head', '-c', '1', link], expect: 'denied' }, head), null, 'the old proof would PASS');
    assert.equal(readFileSync(join(link, 'key'), 'utf8'), 'k', 'yet the key reads');
    // The fix: the folder proofs, and the pass-through one answers yes, so it FAILs.
    const ps = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [link] }, kindOf: kindOn(io), walkOf: () => ({ links: [], named: [] }) }).filter((x) => x.what.includes(link));   // the walk is r4's own test
    assert.deepEqual(ps.map((x) => x.args[0]), ['/bin/ls', '/bin/test', '/bin/ls', '/bin/test'], 'the name and its real place (#528 r3)');
    assert.equal(ps[2].args[1], realpathSync(dir));
    assert.equal(spawnSync(ps[1].args[0], ps[1].args.slice(1)).status, 0, 'test -x on it says yes: the proof FAILs, never PASS');
  } finally { chmodSync(dir, 0o700); }
});

test('#528 r2 m8 PLANTs: kindOn tells an error from "not there" and a link by what it leads to; an error is NOT TRIED, never a file proof', () => {
  // The stand-in: the name asked about answers `lstat`; a place in `links` is a link that says where it goes (#528 r5:
  // kindOn follows the way one link at a time too); any other place is a plain folder.
  const dirSt = { isSymbolicLink: () => false, isDirectory: () => true };
  const io = (lstat, stat = () => { throw new Error('no stat'); }, realpath = (f) => f, links = { '/x': '/y' }) => ({
    lstat: (p) => (p === '/x' || p === '/home/proj/d' ? lstat(p) : links[p] ? link : dirSt), stat, realpath, readlink: (p) => links[p] });
  const err = (code) => () => { throw Object.assign(new Error(code), { code }); };
  const link = { isSymbolicLink: () => true, isDirectory: () => false };
  const plain = (dir) => () => ({ isSymbolicLink: () => false, isDirectory: () => dir });
  const kr = (x) => (x ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'steps')) : x);   // kind and real place; the steps are checked below
  assert.deepEqual(kr(kindOn(io(err('EACCES')))('/x')), { kind: 'error:EACCES', real: null }, 'P4: EACCES is not "not there"');
  assert.equal(kindOn(io(err('ENOENT')))('/x'), null);
  assert.deepEqual(kr(kindOn(io(plain(true)))('/x')), { kind: 'dir', real: '/x' });
  assert.deepEqual(kr(kindOn(io(plain(false)))('/x')), { kind: 'file', real: '/x', names: 1 });
  assert.deepEqual(kindOn(io(() => link, () => ({ isDirectory: () => true }), () => '/y'))('/x'), { kind: 'dir', real: '/y', steps: ['/x', '/y'] }, 'M1: a link to a folder (r5: the link and where it leads, both on the way)');
  assert.deepEqual(kr(kindOn(io(() => link, () => ({ isDirectory: () => false }), () => '/y'))('/x')), { kind: 'file', real: '/y', names: 1 });
  assert.deepEqual(kr(kindOn(io(() => link, () => ({ isDirectory: () => true }), err('ENOENT')))('/x')), { kind: 'error:a link that leads nowhere', real: null });
  assert.deepEqual(kr(kindOn(io(() => link, () => ({ isDirectory: () => true }), err('EACCES')))('/x')), { kind: 'error:EACCES', real: null });
  assert.deepEqual(kr(kindOn(io(() => link, err('EACCES'), () => '/y'))('/x')), { kind: 'error:EACCES', real: null });
  // #528 r3 M1: a link higher up the path (the name itself is no link): the real place and the real target's kind.
  assert.deepEqual(kindOn(io(plain(false), () => ({ isDirectory: () => true }), () => '/elsewhere/proj/d', { '/home': '/elsewhere' }))('/home/proj/d'), { kind: 'dir', real: '/elsewhere/proj/d', steps: ['/home', '/elsewhere', '/elsewhere/proj', '/elsewhere/proj/d'] });
  // r5: a way root can't follow one link at a time the same as realpath did is an error, never a guess.
  assert.match(kindOn(io(plain(false), () => ({ isDirectory: () => true }), () => '/elsewhere/d', {}))('/home/proj/d').kind, /could not be followed one link at a time/);
  // P5: an error is NOT TRIED with its reason, never given a file's head proof.
  const one = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/zz-key'] }, kindOf: (f) => (f === '/zz-key' ? { kind: 'error:EIO', real: null } : { kind: 'dir', real: f }) }).filter((x) => x.what.includes('/zz-key'));
  assert.equal(one.length, 1); assert.equal(one[0].args, null); assert.match(one[0].notTried, /root could not look at it \(EIO\)/);
  // P7: a sharing group (or any group not the allowed ones) FAILs.
  assert.match(groupsProblem({ status: 0, stdout: 'builder everyone com.apple.sharepoint.group.1\n' }), /in com\.apple\.sharepoint\.group\.1/);
  assert.equal(groupsProblem({ status: 0, stdout: 'builder everyone localaccounts _lpoperator\n' }), null);
});

test('#528 r2 m6: only the program\'s own refusal for this path passes; sudo\'s words, another path, or a test that speaks prove nothing', () => {
  const ls = { args: ['/bin/ls', '/k'], expect: 'denied' }; const t = { args: ['/bin/test', '-w', '/k'], expect: 'fail' };
  assert.equal(refusedWhy(ls, { status: 1, stderr: 'ls: /k: Permission denied\n' }), null);
  for (const stderr of ['sudo: unable to execute /bin/ls: Permission denied', 'ls: /other: Permission denied', 'ls: /k: Permission denied\nls: /j: Permission denied', 'x\nls: /k: Permission denied'])
    assert.notEqual(refusedWhy(ls, { status: 1, stderr }), null, stderr);
  assert.notEqual(refusedWhy(ls, { status: 2, stderr: 'ls: /k: Permission denied' }), null);
  assert.notEqual(refusedWhy(t, { status: 1, stderr: 'sudo: a password is required' }), null, 'a sudo error exits 1 too, but speaks');
  assert.notEqual(refusedWhy(t, { status: 137, stderr: '' }), null, 'killed: not a no');
});

test('#528 r2 m5 REAL: a program killed by a signal is 128 + its number, never 1 (which a test proof reads as "no")', { skip: process.platform === 'win32' }, () => {
  const r = realIo().run('/bin/sh', ['-c', 'kill -KILL $$']);
  assert.equal(r.status, 137);
  assert.notEqual(refusedWhy({ args: ['/bin/test', '-w', '/k'], expect: 'fail' }, r), null);
});

test('#528 r2 m2, m8: the proposals folders and the owner\'s outbox folders are on the cannot lists; one the builder can reach FAILs', () => {
  const props = ['/Users/Shared/orchestrate-proposals', ...cfg.products.map((p) => `/Users/Shared/orchestrate-proposals/${p}`)];
  let res = runProofs(proven(), cfg);
  for (const d of props) for (const w of [`builder cannot write the proposals folder ${d}`, `builder cannot list the proposals folder ${d}`]) assert.ok(res.some((r) => r.what === w && r.ok), w);
  // A proposals folder the builder can list (P): FAIL.
  let mac = proven(); chmodSync(mac.at(props[1]), 0o755);
  assert.deepEqual(runProofs(mac, cfg).filter((r) => !r.ok).map((r) => r.what), [`builder cannot list the proposals folder ${props[1]}`]);
  // Not made yet: NOT TRIED, never PASS.
  mac = proven(); rmSync(mac.at(props[1]), { recursive: true });
  assert.ok(runProofs(mac, cfg).some((r) => r.notTried && r.what.includes(props[1]) && /not made yet/.test(r.why)));
  // P8: an owner's outbox folder the builder can write → that proof FAILs.
  mac = proven(); res = runProofs(mac, cfg);
  const ob = res.filter((r) => /cannot write the owner's outbox folder/.test(r.what)); assert.equal(ob.length, FLAT_OUTBOX_ROLES.length); assert.ok(ob.every((r) => r.ok));
  const d = ob[0].what.replace(/^.* folder /, ''); mac.owners.set(d, { uid: uidOf(mac, 'builder'), gid: 20 });
  assert.deepEqual(runProofs(mac, cfg).filter((r) => !r.ok).map((r) => r.what), [ob[0].what]);
});

test('#528 r2 m1: proofs run through main keep the Dispatcher entry, so its rules-state and approvals folders are proven (one open to all FAILs); an entry its parser refuses is refused', () => {
  const raw = { ...RAW, hostLockPath: '/Users/sam/host.lock', dispatcher: { product: 'alpha' } };
  const d = parseDispatcher(raw.dispatcher, parseConfig(raw));
  const mac = proven();
  for (const f of [d.rulesStateDir, d.approvalsStateDir]) { mkdirSync(mac.at(f), { recursive: true }); chmodSync(mac.at(f), 0o777); mac.owners.set(f, { uid: uidOf(mac, 'orchestrate'), gid: 0 }); }
  // Their parent (the private folder) shuts the builder out on its own; the plant opens it to pass-through too, so the
  // proofs of the two folders are what must catch it.
  const parent = dirname(d.rulesStateDir); const was = statSync(mac.at(parent)).mode & 0o7777; chmodSync(mac.at(parent), 0o711);
  const t = run(mac, ['proofs'], raw); assert.equal(t.code, 1, t.text);
  for (const f of [d.rulesStateDir, d.approvalsStateDir]) assert.match(t.text, new RegExp(`FAIL  builder cannot list ${f} `), f);
  chmodSync(mac.at(parent), was);
  for (const f of [d.rulesStateDir, d.approvalsStateDir]) chmodSync(mac.at(f), 0o700);
  const ok = run(mac, ['proofs'], raw); assert.equal(ok.code, 0, ok.text);
  for (const f of [d.rulesStateDir, d.approvalsStateDir]) assert.match(ok.text, new RegExp(`PASS  builder cannot list ${f}\n`), f);
  assert.match(run(mac, ['proofs', '--dry-run'], raw).text, new RegExp(`/bin/ls ${d.rulesStateDir} `));
  const bad = run(mac, ['proofs'], { ...raw, dispatcher: { product: 'nope' } }); assert.equal(bad.code, 2); assert.match(bad.text, /dispatcher entry can't be read/);
});

test('#528 r2: a rules entry that is not text gets its own NOT TRIED line, never dropped', () => {
  const mac = proven(); writeFileSync(mac.at(P('install/orchestrate/review.json')), JSON.stringify({ rules: { production: { env_files: [SECRET, 7] }, secrets: { paths: [null] } } }));
  const nt = runProofs(mac, cfg).filter((r) => r.notTried);
  assert.deepEqual(nt.map((r) => r.what), ['builder cannot read the rules entry 7', 'builder cannot read the rules entry null']);
  assert.ok(nt.every((r) => /not text/.test(r.why)));
  assert.equal(run(mac, ['proofs']).code, 1);
});

test('L1079: a rules entry that names nothing on this Mac is NOT TRIED, never PASS, and the run exits 1', () => {
  const nt = (files) => runProofs(proven({ files }), cfg).filter((r) => r.notTried);
  assert.deepEqual(nt([]).map((r) => r.what), ['builder cannot read the product\'s production files and secrets']);
  assert.match(nt(['.env.local'])[0].why, /relative name/);
  assert.match(nt(['/Users/sam/app/*.env'])[0].why, /pattern/);
  assert.match(nt(['/Users/sam/app/gone.env'])[0].why, /not on this Mac/);
  assert.deepEqual(nt([SECRET]), []);
  const mac = applied();   // no installed review.json, no owner home on this stand-in
  const res = runProofs(mac, cfg).filter((r) => r.notTried);
  assert.ok(res.some((r) => /could not be read/.test(r.why)), JSON.stringify(res));
  assert.ok(res.some((r) => /owner's home/.test(r.what)), 'a home that is not there proves nothing');
  const t = run(mac, ['proofs']); assert.equal(t.code, 1); assert.match(t.text, /NOT TRIED: containment is not proven/);
});

test('proofs: dry run prints the commands and runs none; without root it is refused', () => {
  const mac = fakeMac({ euid: 501 });
  // Before setup the folders are not there: each is said NOT TRIED (#528 r3: a missing place proves nothing).
  const d = run(mac, ['proofs', '--dry-run']); assert.equal(d.code, 0); assert.match(d.text, /not tried: builder cannot write \/Library\/orch-test\/hooks \(not there/);
  const d2 = run(proven(), ['proofs', '--dry-run']); assert.equal(d2.code, 0); assert.match(d2.text, /would run: sudo -n -H -u builder \/bin\/test -w \/Library\/orch-test\/hooks   \(must fail\)/);
  const r = run(mac, ['proofs']); assert.equal(r.code, 2); assert.match(r.text, /must run as root/);
});

test('usage errors exit 2, and an unknown argument is never echoed (it could be a secret)', () => {
  for (const args of [[], ['nope'], ['check'], ['check', '--dry-run', '--config', 'x'], ['users-folders', '--bogus'], ['users-folders', '--config']]) {
    const s = sink(); assert.equal(main(args, { io: fakeMac(), out: s.out, err: s.err }), 2, args.join(' '));
  }
  const s = sink(); assert.equal(main(['users-folders', 'sk-ant-SECRETSECRET', '--config', cfgFile()], { io: fakeMac(), out: s.out, err: s.err }), 2);
  assert.ok(!s.lines.join('\n').includes('SECRETSECRET'), 'an unknown argument was printed');
  const bad = join(tempDir('orch-setup-cfg-'), 'c.json'); writeFileSync(bad, '{"base":"/Users/x","owner":"sam"}');
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
  const d = tempDir('orch-setup-acl-'); const f = join(d, 'f'); mkdirSync(f);
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

// What this Mac really has, read with dscl directly, not through the code under test: a Mac the setup ran on has the three users, a
// clean one (CI) has none. Their real base stands in for the config's on the first; the config's is the wrong one to set up against.
const realUsers = () => Object.fromEntries(USERS.map((name) => {
  const r = spawnSync('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'UniqueID', 'NFSHomeDirectory'], { encoding: 'utf8' });
  return [name, r.status === 0 ? { uid: Number(/^UniqueID: (\d+)$/m.exec(r.stdout)[1]), home: /^NFSHomeDirectory: (.+)$/m.exec(r.stdout)[1] } : null];
}));
const realBase = (users) => { const homes = Object.values(users).filter(Boolean).map((u) => dirname(dirname(u.home))); return homes[0] ?? cfg.base; };

test('REAL check on this Mac with a real throwaway prefix: reads only, says what dscl says of each user, FAILs a user set up elsewhere, changes nothing', { skip: !isDarwin }, () => {
  const prefix = realpathOf(tempDir('orch-setup-real-'));
  mkdirSync(join(prefix, 'Library'));
  const io = realIo({ prefix });
  io.rootUid = process.getuid();
  const users = realUsers(); const base = realBase(users);
  const res = check(io, { ...cfg, base, owner: 'root' });
  const row = (what) => res.find((r) => r.what === what);
  for (const [name, u] of Object.entries(users)) {
    assert.equal(row(`user ${name} exists`)?.ok, u !== null, `the check and dscl differ on ${name}`);
    assert.equal(row(`user ${name} is not root`)?.ok, u === null ? undefined : true, name);
    if (u !== null) assert.equal(row(`user ${name}'s home is ${u.home}`)?.ok, true, name);
    else assert.ok(!res.some((r) => r.what === `user ${name} has no sudo rule`), 'sudo is not asked about a user that is not there');
  }
  assert.ok(res.some((r) => !r.ok && /missing/.test(r.why ?? '')), 'folders are not there');
  assert.ok(res.some((r) => r.ok && /owner root exists/.test(r.what)), 'real dscl read worked');
  // A user who is here but set up under another folder is the wrong user: the check must say so.
  const wrong = check(io, { ...cfg, base: '/Library/orch-other', owner: 'root' });
  for (const [name, u] of Object.entries(users)) {
    if (u !== null) assert.equal(wrong.find((r) => r.what === `user ${name}'s home is /Library/orch-other/home/${name}`)?.ok, false, name);
  }
  // stat and ls -led on a real folder, the same reads the check's folder rows use.
  const st = spawnSync('/usr/bin/stat', ['-f', '%u %Lp', prefix], { encoding: 'utf8' });
  assert.equal(st.stdout.trim().split(' ')[0], String(process.getuid()));
  const ls = spawnSync('/bin/ls', ['-led', prefix], { encoding: 'utf8' });
  assert.equal(ls.status, 0); assert.ok(!/^ \d+: /m.test(ls.stdout));
});

test('REAL plan with a real throwaway prefix on this Mac: reads only; a user that is here keeps its real id, one that is not gets a free id in 600-699, a user set up elsewhere is refused, nothing is made', { skip: !isDarwin }, () => {
  const prefix = realpathOf(tempDir('orch-setup-real-'));
  mkdirSync(join(prefix, 'Library'));
  const io = realIo({ prefix }); io.rootUid = process.getuid();
  const users = realUsers(); const base = realBase(users);
  const p = plan(io, { ...cfg, base, owner: 'root' });
  // the throwaway prefix is owned by the person running the test, standing in for root: the chain check passes, so the plan lists its steps
  assert.deepEqual(p.problems, []);
  const made = p.ops.map((o) => /dscl \. -create \/Users\/(\w+) UniqueID (\d+)/.exec(o.text)).filter(Boolean).map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(made.map(([n]) => n).sort(), USERS.filter((n) => users[n] === null).sort(), 'only a missing user is made');
  const ids = USERS.map((n) => users[n]?.uid ?? Object.fromEntries(made)[n]);
  assert.equal(new Set(ids).size, USERS.length);
  assert.ok(ids.every((n) => n >= 600 && n <= 699), ids.join(','));
  assert.equal(existsSync(join(prefix, base.slice(1))), false, 'a plan makes nothing');
  const wrong = plan(io, { ...cfg, base: '/Library/orch-other', owner: 'root' });
  for (const [name, u] of Object.entries(users)) assert.equal(wrong.problems.some((x) => x.startsWith(`${name} exists but is not as needed: its home is`)), u !== null, name);
});

test('the CLI file runs: --help-less call with no args prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, [new URL('./setup.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /usage: node setup.mjs/);
});

function realpathOf(p) { return realpathSync(p); }

test('L836: each product has its own worker copies folder and outbox folder, made as the folders above them', async () => {
  const { COPIES_CLEANUP_ACL, PRODUCT_OUTBOX_ROLES, outboxRootPath, workerCopiesPath } = await import('./layout.mjs');
  const { RUNNER_ROLE_OF, runnerPlaces } = await import('../wiring/owner-status.mjs');
  assert.deepEqual([...PRODUCT_OUTBOX_ROLES].sort(), [...new Set(Object.values(RUNNER_ROLE_OF))].sort(), 'the roles the worker runner starts');
  const t = folderTable(cfg);
  const row = (p) => t.find((r) => r.path === p);
  const shape = (r) => r && [r.owner, r.mode, JSON.stringify(r.acl)];
  for (const prod of cfg.products) {
    const places = runnerPlaces({ copiesRoot: workerCopiesPath(cfg), outboxRoot: outboxRootPath(cfg), product: prod });
    assert.deepEqual(shape(row(places.copies)), ['builder', 0o755, JSON.stringify([COPIES_CLEANUP_ACL])], `${prod} copies`);
    assert.deepEqual(shape(row(places.copies)), shape(row(workerCopiesPath(cfg))), `${prod} copies as the copies folder`);
    assert.deepEqual(shape(row(places.outboxes)), shape(row(outboxRootPath(cfg))), `${prod} outboxes as the outbox root`);
    for (const r of PRODUCT_OUTBOX_ROLES) {
      assert.equal(row(join(outboxRootPath(cfg), r)), undefined, `no flat ${r} folder (L914)`);
      // L1079: the builder writes a product's worker outboxes; orchestrate reads them through its group and the access list.
      assert.deepEqual(shape(row(join(places.outboxes, r))), ['builder', 0o750, JSON.stringify([ORCHESTRATE_READ_ACL])], `${prod} ${r}`);
      assert.equal(row(join(places.outboxes, r)).group, 'orchestrate', `${prod} ${r} group`);
    }
  }
  // A product named as a role would share that role's outbox folder.
  for (const r of ['worker', 'script', 'lead']) assert.throws(() => parseConfig({ ...RAW, products: ['alpha', r] }), /may not be named as a role/, r);
});

// ---- L1079: the builder user ----

const BUILDER_ROWS = () => folderTable(cfg).filter((r) => r.owner === 'builder').map((r) => r.path);
// A Mac set up before L1079: every folder the builder now owns is still the owner's own.
const beforeBuilder = () => { const mac = applied(); const sam = { uid: uidOf(mac, 'sam'), gid: 20 }; for (const p of BUILDER_ROWS()) mac.owners.set(p, sam); return mac; };

test('L1079: the builder owns what the worker runner writes; each product\'s worker and script outbox folder is builder:orchestrate 0750 with the robot\'s read entry', () => {
  const mac = applied(); const b = uidOf(mac, 'builder'); const orchGid = Number(mac.users.get('orchestrate').PrimaryGroupID);
  for (const d of ['worker-copies', 'worker-copies/alpha', 'worker-runner/requests', 'worker-runner/runner', 'worker-runner/snapshots']) assert.equal(mac.owners.get(P(d)).uid, b, d);
  for (const prod of cfg.products) for (const role of PRODUCT_OUTBOX_ROLES) {
    const d = P(`outboxes/${prod}/${role}`);
    assert.deepEqual(mac.owners.get(d), { uid: b, gid: orchGid }, d);
    assert.equal(statSync(mac.at(d)).mode & 0o777, 0o750, d);
    assert.deepEqual(aclEntries(mac, d).entries, [aclText(ORCHESTRATE_READ_ACL)], d);
  }
  for (const role of FLAT_OUTBOX_ROLES) assert.equal(mac.owners.get(P(`outboxes/${role}`)).uid, uidOf(mac, 'sam'), `${role}: the owner's own interactive role`);
  assert.deepEqual(fails(mac), []);
});

test('L1079 PLANT: a builder folder left the owner\'s, or the outbox group left the owner\'s, FAILs check', () => {
  let mac = applied(); mac.owners.set(P('worker-copies/alpha'), { uid: uidOf(mac, 'sam'), gid: 20 });
  assert.ok(fails(mac).some((r) => r.what.includes(P('worker-copies/alpha'))), JSON.stringify(fails(mac)));
  mac = applied(); mac.owners.set(P('outboxes/alpha/worker'), { uid: uidOf(mac, 'builder'), gid: 20 });
  assert.ok(fails(mac).some((r) => r.what.includes(P('outboxes/alpha/worker')) && /group is 20/.test(r.why)), JSON.stringify(fails(mac)));
});

test('L1079 start clean: owner-owned builder folders holding only the table\'s own folders are handed to the builder', () => {
  const mac = beforeBuilder();
  const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text);
  for (const p of BUILDER_ROWS()) assert.equal(mac.owners.get(p).uid, uidOf(mac, 'builder'), p);
  assert.deepEqual(fails(mac), []);
});

test('L1079 start clean PLANT: a copy left in an owner-owned builder folder → refused by name, nothing changed, nothing moved', () => {
  const mac = beforeBuilder(); mkdirSync(mac.at(P('worker-copies/alpha/card-7')));
  const before = new Map(BUILDER_ROWS().map((p) => [p, mac.owners.get(p)]));
  const r = run(mac, ['users-folders']); assert.notEqual(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`${P('worker-copies/alpha')} is still the owner's .* holds an entry from then: ${P('worker-copies/alpha/card-7')}`));
  assert.match(r.text, /Moving the workers to the builder user/);
  for (const [p, o] of before) assert.deepEqual(mac.owners.get(p), o, `${p} was changed`);
  assert.ok(existsSync(mac.at(P('worker-copies/alpha/card-7'))), 'never moved or removed');
});

test('L1079 PLANT: users-folders refuses while the worker runner\'s status lists a live session, or can\'t be read; an ended one passes that check and is left to start clean', () => {
  const status = P('worker-runner/runner/status.json');
  const at = (text) => { const mac = beforeBuilder(); writeFileSync(mac.at(status), text); return mac; };
  for (const [text, re] of [
    [JSON.stringify({ sessions: [{ id: 's-1', alive: true }] }), /lists 1 live session \(s-1\)/],
    [JSON.stringify({ sessions: [{ id: 's-2' }] }), /lists 1 live session/],
    [JSON.stringify({ nope: 1 }), /is not what the runner writes/],
    // #528 r2 m3: an entry that is not a session is refused, never skipped as "not live".
    [JSON.stringify({ sessions: [null] }), /is not what the runner writes/],
    [JSON.stringify({ sessions: ['abc', { id: 's-5', ended: true }] }), /is not what the runner writes/],
    [JSON.stringify({ sessions: [42] }), /is not what the runner writes/],
    ['{', /is not what the runner writes/],
  ]) {
    const mac = at(text); const sam = uidOf(mac, 'sam');
    const r = run(mac, ['users-folders']); assert.notEqual(r.code, 0, r.text); assert.match(r.text, re);
    for (const p of BUILDER_ROWS()) assert.equal(mac.owners.get(p).uid, sam, `${p} was changed`);
  }
  // #528 r1 m5, m6: a status that can't be read, is a link, or is a folder is never "no live session".
  for (const [make, re] of [
    [(mac) => { writeFileSync(mac.at(status), JSON.stringify({ sessions: [] })); chmodSync(mac.at(status), 0o000); }, /could not be opened \(EACCES\)/],
    [(mac) => { writeFileSync(mac.at(`${status}.real`), JSON.stringify({ sessions: [] })); symlinkSync(mac.at(`${status}.real`), mac.at(status)); }, /is a link/],
    [(mac) => { mkdirSync(mac.at(status)); }, /is not a plain file/],
  ]) {
    const mac = beforeBuilder(); make(mac); const sam = uidOf(mac, 'sam');
    const r = run(mac, ['users-folders']); assert.notEqual(r.code, 0, r.text); assert.match(r.text, re); assert.match(r.text, /not known that no session is live/);
    for (const p of BUILDER_ROWS()) assert.equal(mac.owners.get(p).uid, sam, `${p} was changed`);
  }
  // Ended sessions pass the live check, but start clean still names the old status file: setup moves nothing, so it is moved by hand.
  const ended = at(JSON.stringify({ sessions: [{ id: 's-3', alive: false }, { id: 's-4', ended: true }] }));
  const r = run(ended, ['users-folders']); assert.notEqual(r.code, 0, r.text);
  assert.doesNotMatch(r.text, /live session/); assert.match(r.text, new RegExp(`holds an entry from then: ${status}`));
});

// ───────────────────────────── #528 r3 (L1130): every place judged by what it reaches, never by its name

test('#528 r3 M1: a place whose real place differs is proven at both, each with the real target\'s proofs, and both must be refused', () => {
  const look = (m) => (f) => m[f] ?? { kind: 'dir', real: f };
  const kinds = look({ '/h/prod.cred': { kind: 'file', real: '/out/real.cred' }, '/h/creds': { kind: 'dir', real: '/out/d' }, '/h/proj/x.cred': { kind: 'file', real: '/out/proj/x.cred' } });
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/h/prod.cred', '/h/creds', '/h/proj/x.cred'] }, kindOf: kinds, walkOf: () => ({ links: [], named: [] }) });
  const of = (f) => list.filter((x) => x.what.includes(f)).map((x) => x.args.join(' '));
  assert.deepEqual(of('/h/prod.cred'), ['/usr/bin/head -c 1 /h/prod.cred', '/usr/bin/head -c 1 /out/real.cred']);
  assert.deepEqual(of('/h/creds'), ['/bin/ls /h/creds', '/bin/test -x /h/creds', '/bin/ls /out/d', '/bin/test -x /out/d'], 'a link to a folder: the folder proofs at both');
  assert.deepEqual(of('/h/proj/x.cred'), ['/usr/bin/head -c 1 /h/proj/x.cred', '/usr/bin/head -c 1 /out/proj/x.cred'], 'a link higher up the path');
  assert.ok(list.find((x) => x.args?.at(-1) === '/out/real.cred').what.endsWith('(where /h/prod.cred leads)'));
  assert.deepEqual(list.find((x) => x.args?.at(-1) === '/out/real.cred').look, { at: '/h/prod.cred', kind: 'file', real: '/out/real.cred' });
  // The class (L1130): every "cannot" place takes the same rule, the setup's own folders and homes too.
  const all = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [] , why: 'none' }, kindOf: (f) => ({ kind: 'dir', real: `/r${f}` }) });
  for (const x of all.filter((y) => y.args && !y.control && !y.above)) assert.ok(x.look, x.what);   // a folder above (r4 m4) is proven as itself
  for (const x of all.filter((y) => y.args && !y.control && !y.above && !y.what.includes('(where'))) assert.ok(all.some((y) => y.args?.at(-1) === `/r${x.args.at(-1)}` && y.args[0] === x.args[0]), `${x.what}: its real place is proven too`);
  // One that root could not find the real place of is NOT TRIED.
  const nr = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/h/a'] }, kindOf: (f) => (f === '/h/a' ? { kind: 'file', real: null } : { kind: 'dir', real: f }) }).filter((x) => x.what.includes('/h/a'));
  assert.equal(nr.length, 1); assert.match(nr[0].notTried, /could not find where it really is/);
});

test('#528 r3 M1: a missing place the builder must not write is NOT TRIED, never PASS', () => {
  const list = proofList(cfg, { ownerHome: '/Users/sam', kindOf: (f) => (f === P('hooks') ? null : { kind: 'dir', real: f }) });
  const h = list.filter((x) => x.what === `builder cannot write ${P('hooks')}`); assert.equal(h.length, 1); assert.equal(h[0].args, null); assert.match(h[0].notTried, /not there/);
});

test('#528 r3 m1: just before each proof root looks again; a place changed since the list was made is NOT TRIED, never run', () => {
  assert.equal(changedWhy({ at: '/a', kind: 'file', real: '/b' }, { kind: 'file', real: '/b' }), null);
  assert.match(changedWhy({ at: '/a', kind: 'file', real: '/b' }, { kind: 'dir', real: '/c' }), /was file at \/b .* is dir at \/c now/);
  assert.match(changedWhy({ at: '/a', kind: 'file', real: '/b' }, { kind: 'file', real: '/c' }), /nothing was proven/);
  assert.match(changedWhy({ at: '/a', kind: 'file', real: '/b' }, null), /gone now/);
  const ran = []; const io = { run: (c, a) => { ran.push(a.at(-1)); return { status: 1, stdout: '', stderr: `head: ${a.at(-1)}: Permission denied` }; } };
  const look = { at: '/a', kind: 'file', real: '/b' };
  const list = [{ what: 'n', args: ['/usr/bin/head', '-c', '1', '/a'], expect: 'denied', look }, { what: 'r', args: ['/usr/bin/head', '-c', '1', '/b'], expect: 'denied', look }];
  assert.deepEqual(proveList(io, list, () => ({ kind: 'file', real: '/b' })).map((r) => r.ok), [true, true]);
  ran.length = 0;
  const res = proveList(io, list, () => ({ kind: 'dir', real: '/c' }));
  assert.deepEqual(res.map((r) => [r.ok, !!r.notTried]), [[false, true], [false, true]]); assert.deepEqual(ran, [], 'nothing was run');
});

test('#528 r3 m2: through main, every NOT TRIED line prints NOT TRIED, never PASS, and the run exits 1', () => {
  const mac = proven({ files: ['/Users/sam/app/not-there.cred', 'relative.cred'] });
  const r = run(mac, ['proofs']); assert.equal(r.code, 1, r.text);
  const lines = r.text.split('\n'); const nt = lines.filter((l) => /not-there\.cred|relative\.cred/.test(l));
  assert.equal(nt.length, 2, r.text); for (const l of nt) assert.match(l, /^NOT TRIED {2}/, l);
  assert.ok(!lines.some((l) => /^PASS .*(not-there|relative)\.cred/.test(l)));
  assert.match(r.text, /2 NOT TRIED: containment is not proven/);
  // And the result itself (P19): a NOT TRIED line is never ok, so no reader that takes ok first can call it PASS.
  const res = runProofs(mac, cfg).filter((x) => x.notTried); assert.equal(res.length, 2); for (const x of res) assert.equal(x.ok, false, x.what);
});

test('#528 r3 (minor): the worker runner\'s per-product rules are proven too, the union with review.json\'s', () => {
  const mac = proven();
  const wf = mac.at(P('install/orchestrate/worker-runner.json'));
  writeFileSync(wf, JSON.stringify({ products: { alpha: { rules: { production: { env_files: ['/Users/Shared/worker.cred'] }, secrets: { paths: [SECRET] } } } } }));
  assert.deepEqual(proofInputs(mac, cfg).rules.files.sort(), [SECRET, '/Users/Shared/worker.cred'].sort());
  writeFileSync(mac.at('/Users/Shared/worker.cred'), 'w'); chmodSync(mac.at('/Users/Shared/worker.cred'), 0o644); mac.owners.set('/Users/Shared/worker.cred', { uid: uidOf(mac, 'sam'), gid: 20 });
  const bad = runProofs(mac, cfg).filter((r) => !r.ok);
  assert.ok(bad.some((r) => /cannot read \/Users\/Shared\/worker\.cred/.test(r.what)), JSON.stringify(bad));
  writeFileSync(wf, '{not json'); const nt = proofList(cfg, { ...proofInputs(mac, cfg), kindOf: kindOn(mac) }).filter((x) => /worker runner's production/.test(x.what));
  assert.equal(nt.length, 1); assert.match(nt[0].notTried, /could not be read \(not JSON\)/);
  rmSync(wf); assert.equal(proofInputs(mac, cfg).rules.workerWhy, null, 'no worker runner set up: nothing to add, no line');
});

// The real-Mac cases (#528 r3, the auditor's H, H2, I and J), run as this user, not root: the list is made while the folder
// above is open (root sees through it), then the folder is shut (mode 0, refused even to its owner) and each proof is run as
// this user, as the builder would run it. macOS only: the refusal wording is macOS's own.
const REAL_MAC = { skip: process.platform !== 'darwin' || process.getuid?.() === 0 };
const realCase = (setup) => {
  const T = realpathSync(tempDir('orch-r3-')); const { entry, shut } = setup(T);
  const io = realIo(); const k = kindOn(io); const seen = new Map(); const rootView = (f) => (seen.has(f) ? seen.get(f) : (seen.set(f, k(f)), seen.get(f)));
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [entry] }, kindOf: rootView, walkOf: walkOn(io) }).filter((x) => x.what.includes(entry) && !x.above);
  chmodSync(shut, 0);
  try {
    const asMe = { run: (c, a) => io.run(a[4], a.slice(5)) };   // drop `sudo -n -H -u builder`
    return { T, list, res: proveList(asMe, list, rootView, walkOn(io)) };
  } finally { chmodSync(shut, 0o700); }
};
const judged = (res) => (res.some((r) => r.notTried) ? 'NOT TRIED' : res.every((r) => r.ok) ? 'PASS' : 'FAIL');

test('#528 r3 M1 REAL H: a link in a shut folder to a readable file outside FAILs (the old proof PASSed at the name)', REAL_MAC, () => {
  const { T, list, res } = realCase((T) => { mkdirSync(join(T, 'home')); writeFileSync(join(T, 'real.cred'), 'S'); symlinkSync(join(T, 'real.cred'), join(T, 'home/prod.cred')); return { entry: join(T, 'home/prod.cred'), shut: join(T, 'home') }; });
  assert.deepEqual(list.map((x) => x.args.at(-1)), [join(T, 'home/prod.cred'), join(T, 'real.cred')]);
  assert.equal(res[0].ok, true, 'at the name: refused at the shut folder, as the old proof saw it');
  assert.equal(res[1].ok, false); assert.match(res[1].why, /CAN do this/); assert.equal(judged(res), 'FAIL');
  assert.equal(readFileSync(join(T, 'real.cred'), 'utf8'), 'S', 'and the target does read');
});

test('#528 r3 M1 REAL H2: a link in a shut folder to an open folder outside FAILs', REAL_MAC, () => {
  const { T, list, res } = realCase((T) => { mkdirSync(join(T, 'home')); mkdirSync(join(T, 'real')); writeFileSync(join(T, 'real/k'), 'S'); symlinkSync(join(T, 'real'), join(T, 'home/creds')); return { entry: join(T, 'home/creds'), shut: join(T, 'home') }; });
  assert.deepEqual(list.map((x) => x.args.join(' ')), [`/bin/ls ${join(T, 'home/creds')}`, `/bin/test -x ${join(T, 'home/creds')}`, `/bin/ls ${join(T, 'real')}`, `/bin/test -x ${join(T, 'real')}`]);
  assert.deepEqual(res.map((r) => r.ok), [true, true, false, false]); assert.equal(judged(res), 'FAIL');
});

test('#528 r3 M1 REAL I: a link higher up the path (shut/proj → an open folder) FAILs', REAL_MAC, () => {
  const { T, list, res } = realCase((T) => { mkdirSync(join(T, 'home')); mkdirSync(join(T, 'real')); writeFileSync(join(T, 'real/prod.cred'), 'S'); symlinkSync(join(T, 'real'), join(T, 'home/proj')); return { entry: join(T, 'home/proj/prod.cred'), shut: join(T, 'home') }; });
  assert.deepEqual(list.map((x) => x.args.at(-1)), [join(T, 'home/proj/prod.cred'), join(T, 'real/prod.cred')]);
  assert.deepEqual(res.map((r) => r.ok), [true, false]); assert.equal(judged(res), 'FAIL');
});

test('#528 r3 m1 REAL J: a link changed between making the list and proving (file 0000 → folder 0100) is NOT TRIED, never PASS', REAL_MAC, () => {
  const T = realpathSync(tempDir('orch-r3j-'));
  mkdirSync(join(T, 'J')); writeFileSync(join(T, 'J/k'), 'k'); writeFileSync(join(T, 'Jf'), 'x'); chmodSync(join(T, 'Jf'), 0); symlinkSync(join(T, 'Jf'), join(T, 'Jl'));
  const io = realIo();
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [join(T, 'Jl')] }, kindOf: kindOn(io) }).filter((x) => x.what.includes(join(T, 'Jl')));
  assert.deepEqual(list.map((x) => x.args.at(-1)), [join(T, 'Jl'), join(T, 'Jf')]);
  unlinkSync(join(T, 'Jl')); symlinkSync(join(T, 'J'), join(T, 'Jl')); chmodSync(join(T, 'J'), 0o100);
  try {
    // The old way, run as is: both refused (head on a 0100 folder, head on a 0000 file), though J/k reads.
    const asMe = { run: (c, a) => io.run(a[4], a.slice(5)) };
    assert.ok(list.every((x) => refusedWhy(x, io.run(x.args[0], x.args.slice(1))) === null), 'unlooked, it would PASS');
    assert.equal(readFileSync(join(T, 'Jl/k'), 'utf8'), 'k');
    const res = proveList(asMe, list, kindOn(io));
    assert.ok(res.every((r) => r.notTried), JSON.stringify(res)); assert.match(res[0].why, /was file at .*Jf .* is dir at .*J now/);
  } finally { chmodSync(join(T, 'J'), 0o700); chmodSync(join(T, 'Jf'), 0o600); }
});

// ───────────────────────────── #528 r4 (L1143)

const EMPTY_WALK = () => ({ links: [], named: [] });
const REVIEW_LINE = /builder cannot read the product's production files and secrets/;

test('#528 r4 m1: review.json\'s problem is always said, even when the worker runner\'s entries are proven (union U1/U2)', () => {
  // The list itself: a reason and files both there → the NOT TRIED line and the files' proofs.
  const both = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [SECRET], odd: [], why: 'the installed review.json could not be read (EACCES)' }, kindOf: (f) => ({ kind: f === SECRET ? 'file' : 'dir', real: f, names: 1 }), walkOf: EMPTY_WALK });
  const nt = both.filter((x) => REVIEW_LINE.test(x.what)); assert.equal(nt.length, 1); assert.match(nt[0].notTried, /could not be read \(EACCES\)/);
  assert.ok(both.some((x) => x.args?.at(-1) === SECRET), 'and the worker side is still proven');
  // Through a fake Mac: U1, review.json unreadable; U2, review.json with no rules. The worker runner names a file each time.
  const mac = proven(); const root = P('install/orchestrate');
  writeFileSync(mac.at(`${root}/worker-runner.json`), JSON.stringify({ products: { alpha: { rules: { production: { env_files: [SECRET] } } } } }));
  for (const [label, text, why] of [['U1', '{not json', /could not be read \(not JSON\)/], ['U2', JSON.stringify({}), /names no rules/]]) {
    writeFileSync(mac.at(`${root}/review.json`), text);
    const res = runProofs(mac, cfg);
    const line = res.filter((r) => REVIEW_LINE.test(r.what)); assert.equal(line.length, 1, label); assert.equal(line[0].notTried, true, label); assert.match(line[0].why, why, label);
    const r = run(mac, ['proofs']); assert.equal(r.code, 1, `${label}: ${r.text}`); assert.doesNotMatch(r.text, /containment is proven/, label);
  }
});

test('#528 r4 m2: a folder is judged by what is inside it: a link out is its own place; a file with another name, or a walk that can\'t finish, is NOT TRIED', () => {
  const kinds = { '/k': { kind: 'dir', real: '/k' }, '/k/l': { kind: 'file', real: '/open/key', names: 1 }, '/k/d': { kind: 'dir', real: '/open/d' } };
  const kindOf = (f) => kinds[f] ?? { kind: 'dir', real: f };
  const walks = { '/k': { links: [{ at: '/k/l', real: '/open/key' }, { at: '/k/d', real: '/open/d' }], named: ['/k/h'] }, '/open/d': { links: [{ at: '/open/d/back', real: '/k' }], named: [] } };
  const walkOf = (d) => walks[d] ?? { links: [], named: [] };
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/k'] }, kindOf, walkOf });
  const args = list.filter((x) => x.args && !x.above).map((x) => x.args.join(' '));
  for (const want of ['/bin/ls /k', '/bin/test -x /k', '/usr/bin/head -c 1 /k/l', '/usr/bin/head -c 1 /open/key', '/bin/ls /k/d', '/bin/ls /open/d']) assert.ok(args.includes(want), want);
  assert.ok(list.find((x) => x.args?.at(-1) === '/open/key').what.includes('(a link inside /k)'));
  assert.match(list.find((x) => x.what.includes('/k/h')).notTried, /another name for this file exists/);
  assert.equal(list.filter((x) => x.args?.join(' ') === '/bin/ls /k').length, 1, 'the link back into /k ends: each real folder is walked once');
  assert.ok(list.find((x) => x.args?.join(' ') === '/bin/ls /k').look.walk, 'the folder\'s proofs keep what the walk saw');
  // A name that leads to /k: the real place is walked, not the name (plant R15).
  const via = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/n'] }, kindOf: (f) => (f === '/n' ? { kind: 'dir', real: '/k' } : kindOf(f)), walkOf });
  assert.ok(via.some((x) => x.args?.join(' ') === '/usr/bin/head -c 1 /open/key'), 'the link inside the real place is proven');
  // A walk that can't finish: the folder is NOT TRIED, and nothing is proven of it.
  const cant = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/k'] }, kindOf, walkOf: () => ({ error: 'EACCES' }) }).filter((x) => / \/k$/.test(x.what));   // not the setup's own keys folder
  assert.equal(cant.length, 1); assert.match(cant[0].notTried, /could not look through what is inside it \(EACCES\)/);
  // The keys folder is walked too.
  const keys = proofList(cfg, { ownerHome: '/Users/sam', kindOf: (f) => ({ kind: 'dir', real: f }), walkOf: (d) => (d === P('keys') ? { links: [{ at: P('keys/k'), real: '/open/k' }], named: [] } : { links: [], named: [] }) });
  assert.ok(keys.some((x) => x.what.includes(`${P('keys/k')} (a link inside ${P('keys')})`)));
  // Just before the proof: what is inside changed (a link came) → NOT TRIED, nothing run.
  const ran = []; const io = { run: (c, a) => { ran.push(a); return { status: 1, stdout: '', stderr: a[4] === '/bin/ls' ? `ls: ${a.at(-1)}: Permission denied` : '' }; } };   // ls refused; test a plain no
  const one = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/q'] }, kindOf: (f) => ({ kind: 'dir', real: f }), walkOf: EMPTY_WALK }).filter((x) => x.args?.at(-1) === '/q');
  assert.ok(proveList(io, one, (f) => ({ kind: 'dir', real: f }), EMPTY_WALK).every((r) => r.ok));
  ran.length = 0;
  const res = proveList(io, one, (f) => ({ kind: 'dir', real: f }), () => ({ links: [{ at: '/q/new', real: '/open' }], named: [] }));
  assert.ok(res.every((r) => r.notTried && !r.ok)); assert.match(res[0].why, /what is inside it changed/); assert.deepEqual(ran, []);
});

test('#528 r4 m2: walkOn finds links that lead out (or nowhere) and files with another name, in folders below; links in stay', () => {
  const T = realpathSync(tempDir('orch-r4w-')); const d = join(T, 'sec');
  mkdirSync(join(d, 'sub'), { recursive: true }); writeFileSync(join(d, 'in.key'), 'i'); writeFileSync(join(T, 'out.key'), 'o'); writeFileSync(join(d, 'sub/h.key'), 'h');
  symlinkSync(join(T, 'out.key'), join(d, 'sub/out')); symlinkSync(join(d, 'in.key'), join(d, 'in')); symlinkSync(join(T, 'gone'), join(d, 'dead')); linkSync(join(d, 'sub/h.key'), join(T, 'h2'));
  const w = walkOn(realIo())(d);
  assert.deepEqual(w.links.sort((a, b) => a.at.localeCompare(b.at)), [{ at: join(d, 'dead'), real: null }, { at: join(d, 'sub/out'), real: join(T, 'out.key') }]);
  assert.deepEqual(w.named, [join(d, 'sub/h.key')]);
  assert.match(walkOn({ list: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } })(d).error, /EACCES/);
  const many = walkOn({ list: () => Array.from({ length: WALK_MAX + 1 }, (_, i) => `f${i}`), lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => false, nlink: 1 }) })('/x');
  assert.match(many.error, /too many/, 'a walk that does not end is an error, never "nothing found"');
});

test('#528 r4 m3: a file with another name is NOT TRIED, in the list and when looked at again', () => {
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/h/x.cred'] }, kindOf: (f) => (f === '/h/x.cred' ? { kind: 'file', real: f, names: 2 } : { kind: 'dir', real: f }), walkOf: EMPTY_WALK }).filter((x) => x.what.includes('/h/x.cred'));
  assert.equal(list.length, 1); assert.match(list[0].notTried, /another name for this file exists \(it has 2\)/);
  assert.match(changedWhy({ at: '/a', kind: 'file', real: '/a' }, { kind: 'file', real: '/a', names: 2 }), /another name for this file exists now/);
  assert.equal(changedWhy({ at: '/a', kind: 'file', real: '/a' }, { kind: 'file', real: '/a', names: 1 }), null);
  const T = realpathSync(tempDir('orch-r4n-')); writeFileSync(join(T, 'a'), 'a'); linkSync(join(T, 'a'), join(T, 'b'));
  assert.equal(kindOn(realIo())(join(T, 'a')).names, 2, 'kindOn reads the link count');
});

test('#528 r4 m4: every folder above a place is proven not writable and not the builder\'s, once each; in a shared folder, the name in it not the builder\'s', () => {
  const kindOf = (f) => (f === '/h/a/x.cred' ? { kind: 'file', real: '/r/b/x.cred', names: 1 } : { kind: 'dir', real: f });
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/h/a/x.cred', '/h/a/y.cred'] }, kindOf, walkOf: EMPTY_WALK, stickyOf: (d) => d === '/r' });
  const ab = list.filter((x) => x.above).map((x) => (x.ownerOf ? `root: owner of ${x.ownerOf}` : x.args.join(' ')));
  for (const want of ['/bin/test -w /h/a', '/bin/test -O /h/a', '/bin/test -w /h', '/bin/test -O /h', '/bin/test -w /', '/bin/test -O /', '/bin/test -w /r/b', '/bin/test -O /r', '/bin/test -O /r/b', 'root: owner of /r/b']) assert.ok(ab.includes(want), want);
  assert.ok(!ab.includes('/bin/test -w /r'), 'a shared folder: anyone may write it, so its proof is who owns the name in it');
  // A file right in the shared folder: the name in it is the file itself; root looks at its owner, not followed (r5 M-1).
  const top = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/r/z.cred'] }, kindOf: (f) => (f === '/r/z.cred' ? { kind: 'file', real: f, names: 1 } : { kind: 'dir', real: f }), walkOf: EMPTY_WALK, stickyOf: (d) => d === '/r' });
  const named = top.find((x) => /in the shared folder \/r,/.test(x.what));
  assert.equal(named?.ownerOf, '/r/z.cred', 'the shared folder\'s proof is on the name in it (plant R12)'); assert.equal(named.args, undefined, 'never test -O, which follows a link');
  assert.equal(new Set(ab).size, ab.length, 'each folder once');
  assert.ok(list.filter((x) => x.above).every((x) => x.expect === 'fail' && !x.look));
  // On a fake Mac: a rules file the builder can't read, in a folder the builder owns, FAILs.
  const mac = proven({ files: [SECRET, '/Users/Shared/bw/k.cred'] });
  mkdirSync(mac.at('/Users/Shared/bw')); chmodSync(mac.at('/Users/Shared/bw'), 0o755); mac.owners.set('/Users/Shared/bw', { uid: uidOf(mac, 'builder'), gid: 20 });
  writeFileSync(mac.at('/Users/Shared/bw/k.cred'), 'k'); chmodSync(mac.at('/Users/Shared/bw/k.cred'), 0o600); mac.owners.set('/Users/Shared/bw/k.cred', { uid: uidOf(mac, 'sam'), gid: 20 });
  const res = runProofs(mac, cfg);
  assert.equal(res.find((r) => r.what === 'builder cannot read /Users/Shared/bw/k.cred').ok, true, 'the read itself is refused');
  const bad = res.filter((r) => !r.ok).map((r) => r.what);   // test -O on bw is one proof (each folder once)
  assert.ok(bad.some((w) => /cannot write \/Users\/Shared\/bw \(a folder above/.test(w)), bad.join('\n'));
  assert.ok(bad.some((w) => /does not own \/Users\/Shared\/bw \(a folder above/.test(w)), bad.join('\n'));
  assert.match(res.find((r) => /does not own the name \/Users\/Shared\/bw itself/.test(r.what))?.why ?? '', /builder owns it/, 'root\'s look at the name in the shared folder FAILs');
  assert.ok(stickyOn(mac)('/Users/Shared') && !stickyOn(mac)('/Users') && !stickyOn(mac)('/no/such'));
});

test('#528 r4 m5 (plant P17): a place that must be a folder and is a file is NOT TRIED "not a folder", for the keys and the owner\'s home', () => {
  const list = proofList(cfg, { ownerHome: '/Users/sam', kindOf: (f) => (f === P('keys') || f === '/Users/sam' ? { kind: 'file', real: f, names: 1 } : { kind: 'dir', real: f }), walkOf: EMPTY_WALK });
  for (const re of [/cannot read the robot keys/, /cannot list the owner's home/]) {
    const x = list.filter((y) => re.test(y.what)); assert.equal(x.length, 1, String(re)); assert.match(x[0].notTried, /not a folder/);
  }
});

// The real-Mac cases (#528 r4, the auditor's CONTENTS and HARD), as this user; root's walk is the one made with the folder open.
const realCase4 = (setup) => {
  const T = realpathSync(tempDir('orch-r4-')); const { entry, shut } = setup(T);
  const io = realIo(); const k = kindOn(io); const w = walkOn(io); const seen = new Map(); const walks = new Map();
  const rootView = (f) => (seen.has(f) ? seen.get(f) : (seen.set(f, k(f)), seen.get(f)));
  const walkView = (d) => (walks.has(d) ? walks.get(d) : (walks.set(d, w(d)), walks.get(d)));
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [entry] }, kindOf: rootView, walkOf: walkView }).filter((x) => x.what.includes(entry) && !x.above);
  chmodSync(shut, 0);
  try { return { T, list, res: proveList({ run: (c, a) => io.run(a[4], a.slice(5)) }, list, rootView, walkView) }; } finally { chmodSync(shut, 0o700); }
};

test('#528 r4 m2 REAL CONTENTS: a shut secrets folder holding a link to a readable key outside FAILs (it PASSed on its own path)', REAL_MAC, () => {
  const { T, list, res } = realCase4((T) => { mkdirSync(join(T, 'sec')); writeFileSync(join(T, 'key'), 'S'); symlinkSync(join(T, 'key'), join(T, 'sec/k')); return { entry: join(T, 'sec'), shut: join(T, 'sec') }; });
  assert.ok(list.some((x) => x.args?.join(' ') === `/usr/bin/head -c 1 ${join(T, 'key')}`), JSON.stringify(list.map((x) => x.args)));
  assert.equal(res.find((r) => r.what === `builder cannot list ${join(T, 'sec')}`).ok, true, 'the folder itself is refused');
  assert.equal(judged(res), 'FAIL'); assert.equal(readFileSync(join(T, 'key'), 'utf8'), 'S');
});

test('#528 r4 m3 REAL HARD: a file in a shut folder with another name in an open one is NOT TRIED', REAL_MAC, () => {
  const { res } = realCase4((T) => { mkdirSync(join(T, 'home')); writeFileSync(join(T, 'home/prod.cred'), 'S'); linkSync(join(T, 'home/prod.cred'), join(T, 'pub')); return { entry: join(T, 'home/prod.cred'), shut: join(T, 'home') }; });
  assert.equal(judged(res), 'NOT TRIED'); assert.match(res[0].why, /another name for this file exists/);
});

test('#528 r4 m4 REAL: the folders above are proven as the asking user: a system folder is refused, one this user owns FAILs', REAL_MAC, () => {
  const io = realIo(); const me = { run: (c, a) => io.run(a[4], a.slice(5)) };
  const sys = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: ['/usr/bin/true'] }, kindOf: kindOn(io), walkOf: walkOn(io), stickyOf: stickyOn(io) }).filter((x) => x.above && x.args && /^\/usr/.test(x.args.at(-1)));
  assert.ok(sys.length >= 4); assert.ok(proveList(me, sys).every((r) => r.ok), 'test -w and -O on /usr and /usr/bin: a plain no');
  const T = realpathSync(tempDir('orch-r4a-')); writeFileSync(join(T, 'x'), 'x');
  const mine = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [join(T, 'x')] }, kindOf: kindOn(io), walkOf: walkOn(io), stickyOf: stickyOn(io) }).filter((x) => x.above && x.args.at(-1) === T);
  assert.equal(mine.length, 2); assert.ok(proveList(me, mine).every((r) => !r.ok && /CAN do this/.test(r.why)));
  assert.equal(stickyOn(io)('/private/tmp'), true, 'the real shared folder');
});

// ── #528 r5 (L1159) ──────────────────────────────────────────────────────────────────────────────────────────────────

test('#528 r5 M-1 REAL: a link this user owns in /private/tmp, leading to a shut folder, FAILs "does not own the name itself" (test -O would follow it and pass)', REAL_MAC, () => {
  const T = realpathSync(tempDir('orch-r5s-')); mkdirSync(join(T, 'sec')); writeFileSync(join(T, 'sec/k'), 'S');
  const L = `/private/tmp/orch-r5-${process.pid}`; symlinkSync(join(T, 'sec'), L);
  try {
    const io = realIo(); const entry = `${L}/k`;
    const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [entry] }, kindOf: kindOn(io), walkOf: walkOn(io), stickyOf: stickyOn(io) }).filter((x) => x.ownerOf === L);
    assert.equal(list.length, 1, 'root looks at the link in the shared folder');
    const asMe = { lstat: (p) => io.lstat(p), run: () => { throw new Error('no program runs for this proof'); } };
    const [r] = proveList(asMe, list, kindOn(io), walkOn(io), { builderUid: process.getuid() });
    assert.equal(r.ok, false); assert.match(r.why, /owns it \(a link it can re-point\)/);
    // The bug, on this Mac: test -O follows the link to the folder, whose owner is this user too here, so ask about one it does not own.
    const [other] = proveList(asMe, list, kindOn(io), walkOn(io), { builderUid: process.getuid() + 4242 });
    assert.equal(other.ok, true, 'someone else\'s link: PASS');
  } finally { rmSync(L); }
});

test('#528 r5 M-1: on a fake Mac, a link the builder owns in /Users/Shared FAILs; the name is never asked with test -O', () => {
  const mac = proven({ files: [SECRET, '/Users/Shared/bl/k.cred'] });
  mkdirSync(mac.at('/opt/s'), { recursive: true }); chmodSync(mac.at('/opt/s'), 0o700); mac.owners.set('/opt/s', { uid: uidOf(mac, 'sam'), gid: 20 });
  writeFileSync(mac.at('/opt/s/k.cred'), 'k'); chmodSync(mac.at('/opt/s/k.cred'), 0o600); mac.owners.set('/opt/s/k.cred', { uid: uidOf(mac, 'sam'), gid: 20 });
  symlinkSync(mac.at('/opt/s'), mac.at('/Users/Shared/bl')); mac.owners.set('/Users/Shared/bl', { uid: uidOf(mac, 'builder'), gid: 20 });
  const res = runProofs(mac, cfg);
  const r = res.find((x) => /does not own the name \/Users\/Shared\/bl itself/.test(x.what));
  assert.equal(r?.ok, false, res.filter((x) => /bl/.test(x.what)).map((x) => `${x.ok} ${x.what}`).join('\n')); assert.match(r.why, /builder owns it \(a link it can re-point\)/);
  assert.ok(!proofCommands(mac, cfg).some((c) => /test -O \/Users\/Shared\/bl$/.test(c.split('   ')[0])), 'never test -O on the name');
  assert.ok(proofCommands(mac, cfg).some((c) => c.startsWith('root looks at who owns /Users/Shared/bl itself')));
});

test('#528 r5 M-1: the builder\'s id unknown, or the name gone when looked at, is NOT TRIED', () => {
  const pr = { what: 'w', ownerOf: '/r/n', expect: 'fail', above: true };
  const io = { lstat: () => ({ uid: 7, isSymbolicLink: () => true }) };
  assert.equal(proveList(io, [pr], () => null, EMPTY_WALK, { builderUid: null })[0].notTried, true);
  const gone = proveList({ lstat: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }, [pr], () => null, EMPTY_WALK, { builderUid: 7 })[0];
  assert.equal(gone.notTried, true); assert.match(gone.why, /ENOENT/);
  assert.equal(proveList(io, [pr], () => null, EMPTY_WALK, { builderUid: 7 })[0].ok, false);
  assert.equal(proveList(io, [pr], () => null, EMPTY_WALK, { builderUid: 8 })[0].ok, true);
});

test('#528 r5 M-2: a 2-link chain: the folder holding the middle link is proven, and a builder who can write it FAILs', () => {
  // Real files: a/l1 → m/l2 → z. The way is followed one link at a time, so m is met.
  const T = realpathSync(tempDir('orch-r5h-'));
  for (const d of ['a', 'm', 'z']) mkdirSync(join(T, d)); writeFileSync(join(T, 'z/p'), 's');
  symlinkSync(join(T, 'm/l2'), join(T, 'a/l1')); symlinkSync(join(T, 'z'), join(T, 'm/l2'));
  const io = realIo(); const h = hopsOn(io)(join(T, 'a/l1/p'));
  assert.equal(h.real, join(T, 'z/p')); assert.ok(h.steps.includes(join(T, 'm/l2')), JSON.stringify(h.steps));
  const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files: [join(T, 'a/l1/p')] }, kindOf: kindOn(io), walkOf: walkOn(io), stickyOf: stickyOn(io) });
  assert.ok(list.some((x) => x.args?.join(' ') === `/bin/test -w ${join(T, 'm')}`), 'the middle link\'s folder is proven');
  // On a fake Mac: only m is the builder's to write; the proofs FAIL on it.
  const mac = proven({ files: [SECRET, '/opt/a/l1/p'] }); const sam = { uid: uidOf(mac, 'sam'), gid: 20 };
  for (const [d, o] of [['/opt', { uid: mac.rootUid, gid: 0 }], ['/opt/a', sam], ['/opt/m', { uid: uidOf(mac, 'builder'), gid: 20 }], ['/opt/z', sam]]) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), 0o755); mac.owners.set(d, o); }
  writeFileSync(mac.at('/opt/z/p'), 's'); chmodSync(mac.at('/opt/z/p'), 0o600); mac.owners.set('/opt/z/p', sam);
  symlinkSync(mac.at('/opt/m/l2'), mac.at('/opt/a/l1')); symlinkSync(mac.at('/opt/z'), mac.at('/opt/m/l2'));
  const bad = runProofs(mac, cfg).filter((r) => !r.ok).map((r) => r.what);
  assert.ok(bad.some((w) => /cannot write \/opt\/m \(a folder above/.test(w)), bad.join('\n'));
});

test('#528 r5 M-2: hopsOn follows "..", relative and absolute links, and stops a loop (ELOOP)', () => {
  const T = realpathSync(tempDir('orch-r5l-')); mkdirSync(join(T, 'd/e'), { recursive: true }); writeFileSync(join(T, 'd/f'), 'f');
  symlinkSync('../f', join(T, 'd/e/up')); symlinkSync(join(T, 'x2'), join(T, 'x1')); symlinkSync(join(T, 'x1'), join(T, 'x2'));
  const io = realIo();
  assert.equal(hopsOn(io)(join(T, 'd/e/up')).real, join(T, 'd/f'));
  assert.equal(hopsOn(io)(`${T}/d/e/../f`).real, join(T, 'd/f'));
  assert.ok(!hopsOn(io)(`${T}/d/e/../f`).steps.includes(`${T}/d/e/..`), 'c-1: no ".." name on the way');
  assert.throws(() => hopsOn(io)(join(T, 'x1')), { code: 'ELOOP' });
  assert.throws(() => hopsOn(io)(join(T, 'd/f/g')), { code: 'ENOTDIR' });
  assert.equal(kindOn(io)(join(T, 'x1')).kind, 'error:ELOOP');
});

test('#528 r5 M-2: walkOn: a link inside that leaves through a folder outside and comes back counts as leaving', () => {
  const T = realpathSync(tempDir('orch-r5w-')); const d = join(T, 'sec');
  mkdirSync(join(d, 'in'), { recursive: true }); mkdirSync(join(T, 'out'));
  symlinkSync(join(d, 'in'), join(T, 'out/back'));        // outside: out/back → sec/in
  symlinkSync(join(T, 'out/back'), join(d, 'via'));       // inside: via → out/back → sec/in (ends inside, leaves on the way)
  symlinkSync(join(d, 'in'), join(d, 'stay'));            // inside, straight
  const w = walkOn(realIo())(d);
  assert.deepEqual(w.links.map((x) => x.at), [join(d, 'via')]);
});

test('#528 r5 m-1 (probe-walked): a folder whose walk can\'t finish is NOT TRIED for every name that reaches it, in either order', () => {
  const kindOf = (f) => (f === '/s2' ? { kind: 'dir', real: '/s' } : { kind: 'dir', real: f });
  const walkOf = (d) => (d === '/s' ? { error: 'too many' } : { links: [], named: [] });
  for (const files of [['/s', '/s2'], ['/s2', '/s']]) {
    const list = proofList(cfg, { ownerHome: '/Users/sam', rules: { files }, kindOf, walkOf }).filter((x) => /cannot read \/s2?$/.test(x.what) || /\/s2?( |$)/.test(x.what) && !x.above);
    assert.ok(list.length >= 2 && list.every((x) => x.notTried && /could not look through/.test(x.notTried)), `${files}: ${JSON.stringify(list)}`);
  }
});

test('#528 r5 m-2: on a fake Mac, a real loop of folder links is walked once each; a link inside a linked folder is walked further', () => {
  const mac = proven({ files: [SECRET, '/opt/k'] }); const sam = { uid: uidOf(mac, 'sam'), gid: 20 };
  for (const d of ['/opt/k', '/opt/o/d', '/opt/far']) { mkdirSync(mac.at(d), { recursive: true }); mac.owners.set(d, sam); }
  writeFileSync(mac.at('/opt/far/key'), 'k'); mac.owners.set('/opt/far/key', sam);
  symlinkSync(mac.at('/opt/o/d'), mac.at('/opt/k/d'));     // k/d → o/d
  symlinkSync(mac.at('/opt/k'), mac.at('/opt/o/d/back'));  // o/d/back → k: a loop
  symlinkSync(mac.at('/opt/far/key'), mac.at('/opt/o/d/x'));   // inside the linked folder, a link further out
  const walked = []; const w = walkOn(mac);
  const list = proofList(cfg, { ...proofInputs(mac, cfg), kindOf: kindOn(mac), walkOf: (d) => (walked.push(d), w(d)), stickyOf: stickyOn(mac) });
  assert.equal(walked.filter((d) => d === '/opt/k').length, 1, 'A6: the loop ends: /opt/k is walked once');
  assert.equal(walked.filter((d) => d === '/opt/o/d').length, 1, 'and /opt/o/d once');
  assert.ok(list.some((x) => x.args?.join(' ') === '/bin/ls /opt/o/d'), 'the linked folder is proven');
  assert.ok(list.some((x) => x.args?.join(' ') === '/usr/bin/head -c 1 /opt/far/key'), 'A10: the link inside the linked folder is proven, as a file');
});

test('#528 r5 m-3: a link inside the keys folder is proven by its target\'s kind: a file is read, never listed', () => {
  const list = proofList(cfg, { ownerHome: '/Users/sam', kindOf: (f) => (f === P('keys/k') ? { kind: 'file', real: '/open/k', names: 1 } : { kind: 'dir', real: f }), walkOf: (d) => (d === P('keys') ? { links: [{ at: P('keys/k'), real: '/open/k' }], named: [] } : { links: [], named: [] }) });
  const mine = list.filter((x) => x.args?.at(-1) === '/open/k' && !x.above).map((x) => x.args[0]);
  assert.deepEqual(mine, ['/usr/bin/head']);
});

test('#528 r5 m-4: a file whose names are all inside the walked folder is fine; one with a name outside is NOT TRIED', () => {
  const T = realpathSync(tempDir('orch-r5n-')); const d = join(T, 'sec'); mkdirSync(join(d, 'sub'), { recursive: true });
  writeFileSync(join(d, 'a'), 'a'); linkSync(join(d, 'a'), join(d, 'sub/a2'));   // both names inside
  writeFileSync(join(d, 'b'), 'b'); linkSync(join(d, 'b'), join(T, 'b-out'));    // one name outside
  assert.deepEqual(walkOn(realIo())(d).named, [join(d, 'b')]);
});

test('#528 r5 M-2: a link on the way that now goes elsewhere is NOT TRIED when looked at again', () => {
  const look = { at: '/a', kind: 'dir', real: '/z', steps: ['/a', '/z'] };
  assert.equal(changedWhy(look, { kind: 'dir', real: '/z', steps: ['/a', '/z'] }), null);
  assert.match(changedWhy(look, { kind: 'dir', real: '/z', steps: ['/a', '/m', '/z'] }), /the way to it changed/);
});
