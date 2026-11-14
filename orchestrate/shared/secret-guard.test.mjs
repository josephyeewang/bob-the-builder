// secret-guard.test.mjs — a registered secret can't reach a program's command line (R-0b-179, L1176).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile, execFileSync, exec, execSync, fork } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tempDir } from './test-tmp.mjs';
import { registerSecret, holdsSecret, refuseSecretArgs, guardInstalled, MIN_SECRET } from './secret-guard.mjs';
import { limitedSync } from '../modules/M11-dispatcher/sync-limit.mjs';
import { safeGitEnv } from '../modules/M4-workshop/git/safe-git.mjs';
import { tokenConfig } from '../modules/M4-workshop/git/push.mjs';
import { envGit } from '../wiring/review-ports.mjs';
import { tokenFile } from '../modules/M6-merge-gate/watch-only.mjs';
import { mintInstallationToken } from '../modules/M6-merge-gate/token.mjs';

// A fresh value per call, so one test's registration can't make another pass for the wrong reason.
const fresh = (p = 'ghs_') => `${p}${randomBytes(18).toString('hex')}`;
const REFUSED = /refused to start a program .*would hold a secret/;
const refusedWithout = (secret) => (e) => { assert.match(e.message, REFUSED); assert.ok(!e.message.includes(secret), 'the refusal never carries the value'); return true; };

test('loading the module wraps every start function, and the named imports this file holds are the wrapped ones', () => {
  assert.equal(guardInstalled(), true);
  const s = registerSecret(fresh());
  assert.throws(() => spawnSync('/bin/echo', [s]), refusedWithout(s));
});

test('an unregistered argument starts as before', () => {
  const r = spawnSync('/bin/echo', ['plain text, nothing secret'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'plain text, nothing secret');
});

test('every start function refuses a registered value in an argument, inside a longer argument too', async () => {
  const s = registerSecret(fresh());
  const inside = `--header=Authorization: Bearer ${s}`;
  assert.throws(() => spawn('/bin/echo', [inside]), refusedWithout(s));
  assert.throws(() => spawnSync('/bin/echo', ['ok', inside]), refusedWithout(s));
  assert.throws(() => execFile('/bin/echo', [inside], () => {}), refusedWithout(s));
  assert.throws(() => execFileSync('/bin/echo', [inside]), refusedWithout(s));
  assert.throws(() => fork('/dev/null', [inside]), refusedWithout(s));
  // a command string (exec, execSync) is one text: the value anywhere in it is refused
  assert.throws(() => exec(`/bin/echo ${s}`, () => {}), refusedWithout(s));
  assert.throws(() => execSync(`/bin/echo ${s}`), refusedWithout(s));
  // util.promisify uses exec's and execFile's own promisified forms, which start the program by another road
  await assert.rejects(async () => promisify(execFile)('/bin/echo', [inside]), refusedWithout(s));
  await assert.rejects(async () => promisify(exec)(`/bin/echo ${s}`), refusedWithout(s));
});

test('argv0 and the program itself are on the command line too', () => {
  const s = registerSecret(fresh());
  assert.throws(() => spawnSync('/bin/echo', ['x'], { argv0: s }), refusedWithout(s));
  assert.throws(() => spawnSync('/bin/echo', { argv0: `x${s}` }), refusedWithout(s));
  assert.throws(() => spawnSync(`/tmp/${s}`, []), refusedWithout(s));
  assert.throws(() => execFileSync(s), refusedWithout(s));
});

test('the environment is not the command line: a secret there still starts', () => {
  const s = registerSecret(fresh());
  const r = spawnSync('/bin/sh', ['-c', 'test -n "$T"'], { env: { T: s } });
  assert.equal(r.status, 0);
});

test('a short value is not registered (it would match ordinary text), and a Buffer argument is read as text', () => {
  const short = 'x'.repeat(MIN_SECRET - 1);
  registerSecret(short);
  assert.equal(holdsSecret(`a ${short} b`), false);
  const s = registerSecret(fresh());
  assert.equal(holdsSecret(Buffer.from(`a${s}b`)), true);
  assert.throws(() => refuseSecretArgs('a program (test)', ['ok', Buffer.from(s)]), refusedWithout(s));
});

test('limitedSync checks for itself: a spawnSync taken before the guard loaded is never called with a secret', () => {
  const s = registerSecret(fresh());
  const calls = [];
  const run = limitedSync((...a) => { calls.push(a); return { status: 0, stdout: '' }; });
  const r = run('/bin/echo', ['x', s]);
  assert.equal(r.ok, false);
  assert.match(r.why, REFUSED);
  assert.ok(!r.why.includes(s));
  assert.equal(calls.length, 0, 'the handed-in spawnSync was never called');
  assert.equal(run('/bin/echo', ['x']).ok, true);
});

// The path L1176's sizing flagged: filesOf runs `env -i K=V … git`, each K=V built from safe-git's environment, so a
// token given to safe-git as extraConfig (push.mjs's header) lands on env's command line as GIT_CONFIG_VALUE_n=….
test('review-ports env -i K=V: a token through extraConfig is refused (the header made from it is registered too)', () => {
  const token = registerSecret(fresh());
  const header = tokenConfig(token)[0][1];
  assert.ok(!header.includes(token), 'the header holds the token only in base64, so the token alone would not be seen');
  const env = safeGitEnv({ extraConfig: tokenConfig(token) });
  assert.ok(Object.values(env).some((v) => String(v).includes(header.split(' ').pop())), 'the header is in the environment as built');
  for (const run of [limitedSync(spawnSync), (cmd, args, o) => { const r = spawnSync(cmd, args, o); return { ok: r.status === 0 }; }]) {
    let r;
    try { r = envGit(run, env, ['--version']); } catch (e) { r = { ok: false, why: e.message }; }
    assert.equal(r.ok, false);
    assert.match(r.why, REFUSED);
    assert.ok(!r.why.includes(token) && !r.why.includes(header));
  }
  // the same call with no token goes ahead
  assert.equal(envGit(limitedSync(spawnSync), safeGitEnv(), ['--version']).ok, true);
});

test('the watch-only token file\'s reader registers what it reads', () => {
  const dir = tempDir('sg-');
  const f = join(dir, 'token');
  const t = fresh('github_pat_');
  writeFileSync(f, `${t}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
  assert.equal(holdsSecret(t), false);
  assert.equal(tokenFile(f)(), t);
  assert.equal(holdsSecret(t), true);
});

test('the robot\'s mint registers its key, its signed request and the installation token', async () => {
  const dir = tempDir('sg-');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(join(dir, 'robot-app.pem'), pem, { mode: 0o600 });
  const token = fresh();
  let jwt = null;
  const http = {
    post: async (_p, _b, h) => { jwt = h.Authorization.slice('Bearer '.length); return { status: 201, json: { token, expires_at: 'x' } }; },
    get: async () => ({ status: 200, json: { slug: 'robot' } }),
  };
  const uid = process.getuid();
  const m = await mintInstallationToken({ keyDir: dir, appId: '1', installationId: '2', http, uid, scriptsUid: uid });
  assert.equal(m.ok, true, m.reason);
  for (const x of [token, jwt, pem]) assert.equal(holdsSecret(x), true);
  assert.equal(readFileSync(join(dir, 'robot-app.pem'), 'utf8'), pem);
});

// readSecretFromTty and setup's token steps need a terminal or root; each read is wrapped where it happens, and this
// reads those lines so an edit that drops the wrapping fails here.
test('setup registers the token it reads from the terminal and from the token file', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const mac = src('../setup/mac.mjs');
  assert.match(mac, /const typed = Buffer\.from\(bytes\)\.toString\('utf8'\);\n\s*registerSecret\(typed\.trim\(\)\);\n\s*return typed;/);
  const extras = src('../setup/extras.mjs');
  const reads = extras.split('\n').filter((l) => /io\.readSecret\(|String\(r\.stdout\)\.trim\(\)/.test(l));
  assert.equal(reads.length, 2, 'the two places setup reads the watch-only token');
  for (const l of reads) assert.match(l, /registerSecret\(/);
});

test('a program started in a process that loaded safe-git has the guard on', () => {
  const url = new URL('../modules/M4-workshop/git/safe-git.mjs', import.meta.url).href;
  const g = new URL('./secret-guard.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); const { guardInstalled } = await import(${JSON.stringify(g)}); console.log(guardInstalled());`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'true', r.stderr);
});
