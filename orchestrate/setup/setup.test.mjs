// Tests for setup part 1 (R-0b-05). They run on a stand-in Mac (fake-mac.test-helper.mjs) under a throwaway folder, never
// as root and never against this Mac's users. Each "PLANT" test breaks one clause of the setup and says which check
// catches it. The last tests run the real read-only tools (dscl -read, dseditgroup, ls -led, stat) on this Mac.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_USER } from '../modules/M4-workshop/launcher/review-user.mjs';
import { USERS, folderTable, homeOf, parseConfig } from './layout.mjs';
import { realIo } from './mac.mjs';
import { adminAnswer, check, parseDscl, plan, readUser } from './users-folders.mjs';
import { main } from './setup.mjs';
import { fakeMac } from './fake-mac.test-helper.mjs';

const RAW = { base: '/Library/orch-test', owner: 'joe', products: ['alpha', 'beta'] };
const cfg = parseConfig(RAW);
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };
const cfgFile = () => { const d = mkdtempSync(join(tmpdir(), 'setup-cfg-')); const f = join(d, 'c.json'); writeFileSync(f, JSON.stringify(RAW)); return f; };
const run = (mac, args) => { const s = sink(); const code = main([...args, '--config', cfgFile()], { io: mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') }; };
const applied = () => { const mac = fakeMac(); const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text); return mac; };
const fails = (mac) => check(mac, cfg).filter((r) => !r.ok);
const isDarwin = process.platform === 'darwin';

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
  assert.deepEqual(parseConfig({ base: '/Library/x/', owner: 'joe' }), { base: '/Library/x', owner: 'joe', products: [] });
});

test('the folder table: parents first, exact modes, nothing outside the base, one definition each', () => {
  const t = folderTable(cfg);
  const seen = new Set();
  for (const r of t) {
    assert.ok(r.path === cfg.base || r.path.startsWith(`${cfg.base}/`), r.path);
    assert.ok(!seen.has(r.path), `twice: ${r.path}`);
    if (r.path !== cfg.base) assert.ok(seen.has(r.path.slice(0, r.path.lastIndexOf('/'))), `parent of ${r.path} comes first`);
    seen.add(r.path);
    assert.ok([0o700, 0o755].includes(r.mode), `${r.path} ${r.mode.toString(8)}`);
    assert.ok(['root', 'owner', ...USERS].includes(r.owner));
  }
  const by = (s) => t.find((r) => r.path === `${cfg.base}/${s}`);
  assert.deepEqual([by('review-outbox').owner, by('review-outbox').mode], ['review', 0o755]);
  assert.deepEqual([by('keys').owner, by('keys').mode], ['orchestrate', 0o700]);
  assert.deepEqual([by('products/alpha/pages').owner], ['pages']);
  assert.deepEqual([by('worker-copies').owner], ['owner']);
  for (const u of USERS) assert.equal(by(`home/${u}`).path, homeOf(cfg, u));
});

test('parseDscl reads the shapes dscl prints', () => {
  assert.deepEqual(parseDscl('UniqueID: 501\nNFSHomeDirectory:\n /Users/with space\ndsAttrTypeNative:IsHidden: 1\nNo such key: Foo\n'), { UniqueID: '501', NFSHomeDirectory: '/Users/with space', IsHidden: '1' });
});

test('dry run: prints every step, changes nothing, needs no root', () => {
  const mac = fakeMac({ euid: 501 });
  const r = run(mac, ['users-folders', '--dry-run']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /would run: dscl \. -create \/Users\/review UserShell \/usr\/bin\/false/);
  assert.match(r.text, /would run: mkdir -m 700 \/Library\/orch-test\/review-outbox/);
  assert.match(r.text, /chown 303:303 \/Library\/orch-test\/review-outbox/);
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
  mac.as = 0;
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-create', '/Foo/x', 'A', 'b']).status, 40);                      // bad path
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-create', '/Users/x', 'Key']).status, 40);                       // a key with no value
  assert.equal(mac.run('/usr/bin/dscl', ['.', '-read', '/Users/nobody-here']).status, 56);                      // no such record
  assert.equal(mac.run('/usr/sbin/dseditgroup', ['-o', 'checkmember', '-m', 'x', 'admin']).stdout.split(' ')[0], 'no');
  mac.as = 501;
  assert.throws(() => mac.chown('/x', 1, 1), /EPERM/);
  assert.throws(() => mac.mkdir('/no/parent/here', 0o700), /ENOENT/);
});

test('apply as root: every check passes, then a second run does nothing', () => {
  const mac = fakeMac();
  const first = run(mac, ['users-folders']);
  assert.equal(first.code, 0, first.text);
  assert.match(first.text, /all \d+ items PASS/);
  assert.deepEqual(fails(mac), []);
  for (const u of USERS) {
    const a = mac.users.get(u);
    assert.equal(a.UserShell, '/usr/bin/false'); assert.equal(a.IsHidden, '1'); assert.equal(a.Password, '*');
    assert.equal(a.UniqueID, a.PrimaryGroupID); assert.equal(a.NFSHomeDirectory, homeOf(cfg, u));
    assert.ok(Number(a.UniqueID) >= 301 && Number(a.UniqueID) <= 499);
    assert.equal(mac.groups.get(u).PrimaryGroupID, a.UniqueID);
  }
  assert.equal(new Set(USERS.map((u) => mac.users.get(u).UniqueID)).size, 3, 'three different ids');
  const n = mac.log.length;
  const second = run(mac, ['users-folders']);
  assert.equal(second.code, 0, second.text);
  assert.match(second.text, /nothing to do/);
  assert.equal(mac.log.length, n, 'the second run made no changing call');
  assert.equal(plan(mac, cfg).ops.length, 0);
});

test('users skip ids already taken', () => {
  const mac = fakeMac({ users: { other: { UniqueID: '301', PrimaryGroupID: '302' } } });
  assert.equal(run(mac, ['users-folders']).code, 0);
  const ids = USERS.map((u) => Number(mac.users.get(u).UniqueID));
  assert.ok(!ids.includes(301) && !ids.includes(302), String(ids));
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

test('check on an untouched Mac: FAIL lines and exit 1', () => {
  const mac = fakeMac();
  const r = run(mac, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL  user review exists/);
  assert.match(r.text, /FAIL  \/Library\/orch-test.*missing/);
  assert.match(r.text, /\d+ of \d+ FAILED/);
});

test('check: exit 0 and PASS lines only when all is right', () => {
  const mac = applied();
  const r = run(mac, ['check']);
  assert.equal(r.code, 0);
  assert.match(r.text, /PASS  user review is not an admin/);
  assert.match(r.text, /PASS  \/Library\/orch-test\/review-outbox \(review, 755\)/);
  assert.ok(!/FAIL/.test(r.text));
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

test('PLANT review-outbox owned by the wrong user → caught by the owner column; apply puts it right', () => {
  const mac = applied(); mac.owners.set(`${cfg.base}/review-outbox`, { uid: 501, gid: 20 });
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /owner is uid 501, want 30\d/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT worker-copies owned by root instead of the owner → caught by the owner column', () => {
  const mac = applied(); mac.owners.set(`${cfg.base}/worker-copies`, { uid: mac.rootUid, gid: 0 });
  assert.match(fails(mac)[0].why, /want 65001/);
});

test('PLANT mode 777 on review-outbox → caught by the exact mode; apply puts it right', () => {
  const mac = applied(); chmodSync(mac.at(`${cfg.base}/review-outbox`), 0o777);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /mode is 777, want 755/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT mode 755 where 700 is wanted (keys) → caught: "more open" is a fail too', () => {
  const mac = applied(); chmodSync(mac.at(`${cfg.base}/keys`), 0o755);
  assert.match(fails(mac)[0].why, /mode is 755, want 700/);
});

test('PLANT a link in place of a folder → caught by "is a link"; apply refuses, changes nothing', () => {
  const mac = applied(); const p = mac.at(`${cfg.base}/keys`);
  rmSync(p, { recursive: true }); symlinkSync(mac.at(`${cfg.base}/private`), p);
  assert.ok(fails(mac).some((f) => f.why === 'is a link'));
  const n = mac.log.length;
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /keys exists but is a link/); assert.equal(mac.log.length, n);
});

test('PLANT a missing folder → caught by "missing"; apply makes it', () => {
  const mac = applied(); rmSync(mac.at(`${cfg.base}/products/beta/store`), { recursive: true });
  assert.ok(fails(mac).some((f) => f.why === 'missing'));
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT the folder above the base writable by others → caught by the chain check', () => {
  const mac = applied(); chmodSync(mac.at('/Library'), 0o777);
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].what, /folders above/); assert.match(f[0].why, /written by others|can be written/);
});

test('PLANT an access list on a folder → caught by the ACL read; apply clears it', { skip: !isDarwin }, () => {
  const mac = applied(); const p = mac.at(`${cfg.base}/review-outbox`);
  const r = spawnSync('/bin/chmod', ['+a', 'everyone allow write,delete_child', p]);
  assert.equal(r.status, 0, String(r.stderr));
  const f = fails(mac); assert.equal(f.length, 1); assert.match(f[0].why, /access list/);
  assert.equal(run(mac, ['users-folders']).code, 0); assert.deepEqual(fails(mac), []);
});

test('PLANT the owner user missing → refused, nothing changed', () => {
  const mac = fakeMac(); mac.users.delete('joe');
  const r = run(mac, ['users-folders']);
  assert.equal(r.code, 1); assert.match(r.text, /owner's Mac user joe was not found/); assert.equal(mac.log.length, 0);
});

test('a group named like a user, with no user yet: the user is made to match it (its id is kept)', () => {
  const mac = fakeMac(); mac.groups.set('pages', { PrimaryGroupID: '333' });
  const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text);
  assert.equal(mac.users.get('pages').UniqueID, '333'); assert.equal(mac.users.get('pages').PrimaryGroupID, '333');
  assert.deepEqual(fails(mac), []);
});

// FINISH-A-HALF-MADE-USER plants: each set attribute that differs from the table must stop the run, naming it, changing nothing.
const half = (user, group) => { const mac = fakeMac(); mac.users.set('pages', user); if (group) mac.groups.set('pages', group); return mac; };
for (const [name, mac, want] of [
  ['a login shell already set', () => half({ UserShell: '/bin/zsh' }), /pages exists but is not as needed: its shell is \/bin\/zsh/],
  ['a visible user (IsHidden 0)', () => half({ IsHidden: '0' }), /it is not hidden/],
  ['another home folder', () => half({ NFSHomeDirectory: '/Users/pages' }), /its home is \/Users\/pages/],
  ['the user\'s id and its group\'s id disagree', () => half({ UniqueID: '400', PrimaryGroupID: '400' }, { PrimaryGroupID: '401' }), /main group is 400, not the group pages \(401\)/],
  ['the user\'s id differs from its main group (no group yet)', () => half({ UniqueID: '400', PrimaryGroupID: '401' }), /ids disagree/],
  ['root\'s id', () => half({ UniqueID: '0', PrimaryGroupID: '0' }), /its id is root's/],
  ['a group id another group already uses (staff, 20)', () => half({}, { PrimaryGroupID: '20' }), /also used by another user or group/],
  ['an admin', () => { const m = half({ UniqueID: '400', PrimaryGroupID: '400' }, { PrimaryGroupID: '400' }); m.admins.add('pages'); return m; }, /it is an admin/],
]) {
  test(`PLANT finish-a-half-made-user: ${name} → refused naming it, nothing changed, nothing deleted`, () => {
    const m = mac(); const r = run(m, ['users-folders']);
    assert.equal(r.code, 1, r.text); assert.match(r.text, want); assert.match(r.text, /nothing was changed/i);
    assert.deepEqual(m.log, [], 'something was changed');
  });
}

test('finish-a-half-made-user: a user with only some attributes set (all matching) is completed, and a second run does nothing', () => {
  const mac = half({ UserShell: '/usr/bin/false', IsHidden: '1' }, { PrimaryGroupID: '350' });
  const dry = run(mac, ['users-folders', '--dry-run']);
  assert.equal(dry.code, 0, dry.text); assert.equal(mac.log.length, 0);
  assert.ok(!/dscl \. -create \/Users\/pages UserShell/.test(dry.text), 'rewrote a set attribute');
  assert.match(dry.text, /UniqueID 350/);
  const r = run(mac, ['users-folders']); assert.equal(r.code, 0, r.text);
  assert.deepEqual(fails(mac), []);
  const n = mac.log.length;
  assert.match(run(mac, ['users-folders']).text, /nothing to do/);
  assert.equal(mac.log.length, n);
});

test('usage errors exit 2', () => {
  for (const args of [[], ['nope'], ['check'], ['check', '--dry-run', '--config', 'x'], ['users-folders', '--bogus'], ['users-folders', '--config']]) {
    const s = sink(); assert.equal(main(args, { io: fakeMac(), out: s.out, err: s.err }), 2, args.join(' '));
  }
  const bad = join(mkdtempSync(join(tmpdir(), 'setup-cfg-')), 'c.json'); writeFileSync(bad, '{"base":"/Users/x","owner":"joe"}');
  const s = sink(); assert.equal(main(['check', '--config', bad], { io: fakeMac(), out: s.out, err: s.err }), 2);
});

// ---- The real read-only tools, on this Mac. -------------------------------------------------------------------------

test('REAL dscl -read: the root user reads as uid 0; a missing user reads as not there', { skip: !isDarwin }, () => {
  const io = realIo();
  const root = readUser(io, 'root');
  assert.equal(root.exists, true); assert.equal(root.uid, 0);
  const none = readUser(io, 'no-such-user-zz9');
  assert.deepEqual(none, { exists: false, error: null });
});

test('REAL dseditgroup: a service user is not an admin; the answer is "no"', { skip: !isDarwin }, () => {
  assert.equal(adminAnswer(realIo(), 'daemon'), 'no');
  assert.notEqual(adminAnswer(realIo(), 'root'), 'no');   // root is in admin: the check never reports root as safe
});

test('REAL check on this Mac with a real throwaway prefix: reads only, FAILs for the users that do not exist, changes nothing', { skip: !isDarwin }, () => {
  const prefix = mkdtempSync(join(tmpdir(), 'setup-real-'));
  mkdirSync(join(prefix, 'Library'));
  const io = realIo({ prefix });
  io.rootUid = process.getuid();
  const res = check(io, { ...cfg, owner: 'root' });
  assert.ok(res.some((r) => !r.ok && r.what === 'user review exists'), 'users are not on this Mac');
  assert.ok(res.some((r) => !r.ok && /missing/.test(r.why ?? '')), 'folders are not there');
  assert.ok(res.some((r) => r.ok && /owner root exists/.test(r.what)), 'real dscl read worked');
  // stat and ls -led on a real folder, the same reads the check's folder rows use.
  const st = spawnSync('/usr/bin/stat', ['-f', '%u %Lp', prefix], { encoding: 'utf8' });
  assert.equal(st.stdout.trim().split(' ')[0], String(process.getuid()));
  const ls = spawnSync('/bin/ls', ['-led', prefix], { encoding: 'utf8' });
  assert.equal(ls.status, 0); assert.ok(!/^ \d+: /m.test(ls.stdout));
});

test('the CLI file runs: --help-less call with no args prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, [new URL('./setup.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /usage: node setup.mjs/);
});
