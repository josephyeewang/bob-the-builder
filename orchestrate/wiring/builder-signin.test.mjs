// The builder sessions' sign-in file (L1261): the shape check, the runner's fresh read (one handle, never a link, the
// user's own 0600 file in its own 0700 folder, the chain above root's), and the value reaching only claude's environment.
// PLANT tests break one clause each and name the check that catches it. The value is a made-up one, never real.

import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SIGNIN_MAX, SIGNIN_MIN, SIGNIN_TOKEN_VAR, readSigninFile, signinFileRows, signinShapeProblem } from './builder-signin.mjs';
import { checkRoleEnv, startEnv } from '../modules/M4-workshop/launcher/env-check.mjs';
import { sessionEnv, workerAccount } from './runner-ports.mjs';
import { signinTold, workerCheckInputs } from './runner-main.mjs';
import { workerChecks } from './runner-checks.mjs';
import { holdsSecret } from '../shared/secret-guard.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

export const VALUE = `sk-ant-oat01-${'Ab3_x-'.repeat(15)}QQ`;   // made up: the shape only
const me = process.getuid();
const noChain = () => null;   // the temp folder's chain is this user's, not root's: the chain is its own test below

function place({ dirMode = 0o700, fileMode = 0o600, text = `${VALUE}\n` } = {}) {
  const d = realpathSync(tempDir('orch-signin-'));
  const dir = join(d, 'builder-signin'); mkdirSync(dir); chmodSync(dir, dirMode);
  const file = join(dir, 'claude-signin');
  if (text !== null) { writeFileSync(file, text); chmodSync(file, fileMode); }
  return { d, dir, file, done: () => rmSync(d, { recursive: true, force: true }) };
}
const read = (file, o = {}) => readSigninFile(file, { uid: me, chain: noChain, ...o });
const noValue = (s) => { assert.ok(!String(s).includes(VALUE) && !String(s).includes(VALUE.slice(0, 24)), `the value leaked: ${s}`); };

test('signinShapeProblem: a Claude sign-in token passes; anything else is refused without repeating what it saw', () => {
  assert.equal(signinShapeProblem(VALUE), null);
  for (const bad of ['', 'hunter2-is-my-password-and-long-enough-to-pass', `${VALUE} x`, `${VALUE}\n`, `ghp_${'a'.repeat(40)}`, `sk-ant-api03-${'a'.repeat(60)}`,
    `sk-ant-oat01-${'a'.repeat(SIGNIN_MAX)}`, 'sk-ant-oat01-short', null, undefined, 5]) {
    const why = signinShapeProblem(bad); assert.ok(why, `refused: ${String(bad).slice(0, 20)}`);
    if (typeof bad === 'string' && bad.length > 4) assert.ok(!why.includes(bad.slice(0, 20)) || bad.startsWith('sk-ant-oat'.slice(0, 20)) && !why.includes(bad), 'the message repeats what was typed');
  }
  assert.ok(SIGNIN_MIN < VALUE.length && VALUE.length < SIGNIN_MAX);
});

test('readSigninFile: the user\'s own 0600 file in its own 0700 folder is read; the value only in .value, registered with the guard', () => {
  const p = place();
  try {
    const r = read(p.file);
    assert.deepEqual(r, { ok: true, value: VALUE });
    assert.equal(holdsSecret(`x ${VALUE} y`), true, 'registered: no program can be started with it on its command line');
    // Without the trailing line break as well.
    writeFileSync(p.file, VALUE); assert.deepEqual(read(p.file), { ok: true, value: VALUE });
  } finally { p.done(); }
});

test('PLANT each wrong owner, mode, link or chain → refused with a reason that holds no byte of the value', () => {
  const cases = [
    ['file 0644 (others could read it)', () => place({ fileMode: 0o644 }), (p) => read(p.file), /is 644, want 600/],
    ['file 0640', () => place({ fileMode: 0o640 }), (p) => read(p.file), /is 640, want 600/],
    ['folder 0755', () => place({ dirMode: 0o755 }), (p) => read(p.file), /its folder .* is 755, want 700/],
    ['file another user\'s', () => place(), (p) => read(p.file, { uid: me + 1, lstat: (x) => ({ ...lstatOwn(x), uid: me + 1 }) }), /is not this user's own \(uid \d+, want \d+\)/],
    ['folder another user\'s', () => place(), (p) => read(p.file, { uid: me + 1 }), /its folder .* is not this user's own/],
    ['a folder above not root\'s alone', () => place(), (p) => read(p.file, { chain: () => '/x is not owned by root' }), /a folder above it is not root's alone \(\/x is not owned by root\)/],
    ['the file is a link to the value', () => { const p = place({ text: null }); const real = join(p.d, 'elsewhere'); writeFileSync(real, `${VALUE}\n`); chmodSync(real, 0o600); symlinkSync(real, p.file); return p; }, (p) => read(p.file), /is a link, which is never followed/],
    ['the folder is a link', () => { const p = place(); const alias = join(p.d, 'alias'); symlinkSync(p.dir, alias); return { ...p, file: join(alias, 'claude-signin') }; }, (p) => read(p.file), /is not a plain folder/],
    ['a second name (hard link)', () => { const p = place(); linkSync(p.file, join(p.dir, 'other')); return p; }, (p) => read(p.file), /has another name/],
    ['missing', () => place({ text: null }), (p) => read(p.file), /is missing \(make it: claude setup-token as the owner, then sudo \/usr\/local\/bin\/node setup.mjs builder-signin\)/],
    ['empty', () => place({ text: '' }), (p) => read(p.file), /is not the size of one sign-in token/],
    ['not a token (a password of the right size)', () => place({ text: `${'p'.repeat(60)}\n` }), (p) => read(p.file), /does not hold one sign-in token: it does not start the way/],
    ['two tokens', () => place({ text: `${VALUE}\n${VALUE}\n` }), (p) => read(p.file), /does not hold one sign-in token|is not the size/],
    ['a folder where the file goes', () => { const p = place({ text: null }); mkdirSync(p.file); return p; }, (p) => read(p.file), /is not a plain file|can't be opened/],
  ];
  for (const [name, make, run, want] of cases) {
    const p = make();
    try {
      const r = run(p);
      assert.equal(r.ok, false, name); assert.equal(r.value, undefined, name); assert.match(r.reason, want, name); noValue(r.reason);
    } finally { p.done(); }
  }
});
// An lstat whose uid this user is, for the file-owner case: the folder passes, the file's own fstat then sees the real uid.
function lstatOwn(x) { return Object.assign(Object.create(null), { isSymbolicLink: () => false, isDirectory: () => true, uid: me, mode: 0o40700, x }); }

test('PLANT the chain check is the real one by default: a temp folder (this user\'s) above the folder is refused as not root\'s', () => {
  const p = place();
  try {
    const r = readSigninFile(p.file, { uid: me });
    assert.equal(r.ok, false); assert.match(r.reason, /a folder above it is not root's alone/);
  } finally { p.done(); }
});

test('check 9: the sign-in name passes only when allowed, and only that name; the review start path still refuses it', () => {
  const env = { HOME: '/h', PATH: '/usr/bin', [SIGNIN_TOKEN_VAR]: VALUE };
  assert.equal(checkRoleEnv(env).ok, false, 'not allowed by default');
  assert.match(checkRoleEnv(env).reason, /refused variables in the role's environment: CLAUDE_CODE_OAUTH_TOKEN/);
  noValue(checkRoleEnv(env).reason);
  assert.deepEqual(checkRoleEnv(env, { allowSigninToken: true }), { ok: true });
  assert.equal(checkRoleEnv({ ...env, ANTHROPIC_API_KEY: 'x' }, { allowSigninToken: true }).ok, false, 'another key is still refused');
  assert.equal(checkRoleEnv({ ...env, GH_TOKEN: 'x' }, { allowSigninToken: true }).ok, false, 'another token-like name is still refused');
  assert.equal(checkRoleEnv({ ...env, [SIGNIN_TOKEN_VAR]: '' }, { allowSigninToken: true }).ok, false, 'an empty value is refused');
  assert.equal(checkRoleEnv(env, { allowSigninToken: 'yes' }).ok, false, 'only exactly true allows it');
  assert.equal(startEnv({ HOME: '/h' }, { extra: { [SIGNIN_TOKEN_VAR]: VALUE } }).ok, false);
  assert.equal(startEnv({ HOME: '/h', [SIGNIN_TOKEN_VAR]: VALUE }, { allowSigninToken: true }).env[SIGNIN_TOKEN_VAR], undefined, 'never taken from the parent');
});

const C = { home: '/h/builder', path: '/usr/bin:/bin' };

test('workerAccount with signinFile: the file is read fresh at every call; no Keychain or account-file is asked; account a\'s folder', () => {
  let reads = 0;
  const readSignin = (f) => { reads += 1; assert.equal(f, '/b/builder-signin/claude-signin'); return { ok: true, value: VALUE }; };
  const c = { ...C, signinFile: '/b/builder-signin/claude-signin', accountCopy: '/copy' };
  const no = () => { throw new Error('not asked with a sign-in file'); };
  const a = workerAccount(c, { readSignin, readCopy: no, inUse: no, setUp: no });
  assert.deepEqual(a, { account: 'a', dir: '/h/builder/.claude', env: { [SIGNIN_TOKEN_VAR]: VALUE }, signinToken: true });
  workerAccount(c, { readSignin, readCopy: no, inUse: no, setUp: no });
  assert.equal(reads, 2, 'read fresh each time, never kept');
  const held = workerAccount(c, { readSignin: () => ({ ok: false, reason: 'the builder sign-in file /b is missing' }) });
  assert.deepEqual(held, { account: null, reason: 'the builder sign-in file /b is missing' });
  assert.equal(workerAccount(c, { readSignin: () => { throw Object.assign(new Error(VALUE), { code: 'EIO' }); } }).reason, 'the builder sign-in file can\'t be read (EIO)', 'a throw is told by its code only');
  assert.equal(workerAccount(c, { readSignin: () => ({ ok: true, value: '' }) }).account, null, 'an empty value holds the start');
});

test('sessionEnv: the value reaches the session\'s environment (and nothing else of it) only with the sign-in; without it, check 9 still refuses the name', () => {
  const who = { account: 'a', dir: '/h/builder/.claude', env: { [SIGNIN_TOKEN_VAR]: VALUE }, signinToken: true };
  const b = sessionEnv(C, who, { HOME: '/x', USER: 'builder', CLAUDECODE: '1', [SIGNIN_TOKEN_VAR]: 'from-the-parent-not-taken-0000000000' });
  assert.equal(b.ok, true, b.reason);
  assert.deepEqual(Object.keys(b.env).sort(), ['HOME', 'PATH', 'USER', SIGNIN_TOKEN_VAR].sort());
  assert.equal(b.env[SIGNIN_TOKEN_VAR], VALUE); assert.equal(b.env.HOME, C.home);
  // A who that hands the name without saying it is the sign-in (any other account path) is refused by check 9.
  const sly = sessionEnv(C, { ...who, signinToken: undefined });
  assert.equal(sly.ok, false); assert.match(sly.reason, /refused variables/); noValue(sly.reason);
});

test('workerChecks port 9 lets the sign-in through only when the config names the file (workerCheckInputs)', async () => {
  const c = { home: '/h', products: { p: { mirror: '/m', render: { paths: { hooksDir: '/hk' } } } } };
  const env = { HOME: '/h', PATH: '/usr/bin', [SIGNIN_TOKEN_VAR]: VALUE };
  const x = { product: 'p', env, copy: '/c', outbox: '/o', sessionId: 'S' };
  const off = workerChecks(workerCheckInputs(c, x));
  assert.equal((await off[9]()).ok, false, 'a config without signinFile: refused');
  const on = workerChecks(workerCheckInputs({ ...c, signinFile: '/b/claude-signin' }, x));
  assert.deepEqual(await on[9](), { ok: true });
  const other = workerChecks(workerCheckInputs({ ...c, signinFile: '/b/claude-signin' }, { ...x, env: { ...env, GH_TOKEN: 'z' } }));
  assert.equal((await other[9]()).ok, false, 'only that one name');
});

test('signinTold: each reason told once, again when it changes, and once when it reads fine; never the value', () => {
  const lines = []; let answer = { account: null, reason: 'the builder sign-in file /b is missing' };
  const acct = signinTold({}, { log: (s) => lines.push(s), account: () => answer });
  acct(); acct(); acct();
  assert.equal(lines.length, 1); assert.match(lines[0], /no sign-in, so no session starts: the builder sign-in file \/b is missing/);
  answer = { account: null, reason: 'the builder sign-in file /b is 644, want 600' }; acct(); acct();
  assert.equal(lines.length, 2);
  answer = { account: 'a', dir: '/h/.claude', env: { [SIGNIN_TOKEN_VAR]: VALUE }, signinToken: true };
  const got = acct(); acct();
  assert.equal(got, answer, 'the answer is passed on unchanged');
  assert.equal(lines.length, 3); assert.match(lines[2], /the builder sign-in file: read, builder's own/);
  answer = { account: null, reason: 'the builder sign-in file /b is missing' }; acct();
  assert.equal(lines.length, 4, 'a hold after a good read is told again');
  noValue(lines.join('\n'));
});

test('signinFileRows: lstat only; every wrong owner, mode, link or access list is a FAIL; the value is never opened', () => {
  const p = place();
  const io = { lstat: (x) => lstatReal(x), rootUid: me, at: (x) => x, prefix: '' };
  const acl = () => ({ entries: [], error: null });
  const rows = (o = {}) => signinFileRows({ ...io, ...o.io }, { file: p.file, builderUid: o.uid ?? me, acl: o.acl ?? acl, chain: o.chain ?? (() => null) });
  try {
    assert.deepEqual(rows().filter((r) => !r.ok), []);
    assert.equal(rows().length, 3);
    chmodSync(p.file, 0o644); assert.match(rows().find((r) => !r.ok).why, /mode is 644, want 600/); chmodSync(p.file, 0o600);
    chmodSync(p.dir, 0o750); assert.match(rows().find((r) => !r.ok).why, /mode is 750, want 700/); chmodSync(p.dir, 0o700);
    assert.match(rows({ uid: me + 1 }).filter((r) => !r.ok).map((r) => r.why).join(), /owner is uid \d+, want \d+/);
    assert.match(rows({ chain: () => '/x is a link' }).find((r) => !r.ok).why, /\/x is a link/);
    assert.match(rows({ acl: (x) => ({ entries: x === p.file ? ['user:other allow read'] : [], error: null }) }).find((r) => !r.ok).why, /has an access list/);
    linkSync(p.file, join(p.dir, 'second')); assert.match(rows().find((r) => !r.ok).why, /another name/); rmSync(join(p.dir, 'second'));
    rmSync(p.file); assert.match(rows().find((r) => !r.ok).why, /missing: as the owner run claude setup-token, then sudo \/usr\/local\/bin\/node setup.mjs builder-signin/);
    noValue(JSON.stringify(rows()));
  } finally { p.done(); }
});
import { lstatSync as lstatReal } from 'node:fs';
