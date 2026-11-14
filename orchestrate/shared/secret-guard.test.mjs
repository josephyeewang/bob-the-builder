// secret-guard.test.mjs — a registered secret can't reach a program's command line (R-0b-179, L1176).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync, execFile, execFileSync, exec, execSync, fork } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tempDir } from './test-tmp.mjs';
import { registerSecret, holdsSecret, refuseSecretArgs, guardInstalled, MIN_SECRET, partsOf, pinned } from './secret-guard.mjs';
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

test('a registered value in its common encodings is refused too: base64 (standard, URL-safe, any alignment, padded or not), hex, percent (L1191)', () => {
  // Three lengths, one per byte alignment of the value's end; the last has bytes whose base64 holds + and /, so the
  // URL-safe form differs from the standard one.
  const values = [fresh(), fresh('gho_x'), `pat~~~${randomBytes(6).toString('hex')}ûÿþ?>/`];
  assert.ok(values.map((v) => Buffer.byteLength(v) % 3).sort().join() === '0,1,2', 'one value per alignment of its end');
  assert.match(Buffer.from(values[2]).toString('base64'), /[+/]/);
  for (const raw of values) {
    const s = registerSecret(raw);
    const forms = [];
    // the value after 0, 1 or 2 other bytes, and before 0, 1 or 2: every alignment of its start and end in the run
    for (const pre of ['', 'a', 'ab']) for (const post of ['', 'z', 'zy']) {
      const b = Buffer.from(`${pre}${s}${post}`);
      const std = b.toString('base64');
      forms.push(std, std.replace(/=+$/, ''), b.toString('base64url'), `${b.toString('base64url')}==`);
    }
    // a header made from it (`Basic base64(user:token)`), as push.mjs makes one
    forms.push(`Authorization: Basic ${Buffer.from(`x-access-token:${s}`).toString('base64')}`);
    const hex = Buffer.from(s).toString('hex');
    forms.push(hex, hex.toUpperCase(), `0x${hex.slice(0, 8).toUpperCase()}${hex.slice(8)}`);
    forms.push(encodeURIComponent(s), hex.replace(/../g, '%$&'), hex.toUpperCase().replace(/../g, '%$&'), `https://h/?t=${encodeURIComponent(s)}`);
    for (const f of forms) {
      assert.equal(holdsSecret(`--x=${f}`), true, `${JSON.stringify(f)} of a value ${Buffer.byteLength(s)} bytes long`);
      assert.throws(() => spawnSync('/bin/echo', ['ok', `--x=${f}`]), refusedWithout(s));
    }
  }
  // Another value's encodings, and ordinary encoded text, still start.
  const other = fresh();
  for (const f of [Buffer.from(other).toString('base64'), Buffer.from(other).toString('hex'), encodeURIComponent(other), Buffer.from('plain text, nothing secret').toString('base64')]) {
    assert.equal(holdsSecret(f), false, f);
    assert.equal(spawnSync('/bin/echo', [f]).status, 0);
  }
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

// --- L1196 (the #581 audit) ----------------------------------------------------------------------------------------

test('L1196 M1: a value with only some characters percent-encoded, or in encodeURI\'s, escape\'s or a query string\'s form, is refused; a malformed % never throws past the check', () => {
  const s = registerSecret(fresh());
  const one = `%${s.charCodeAt(0).toString(16)}${s.slice(1)}`;                                    // the first character only
  const every = [...s].map((c, i) => (i % 2 ? `%${c.charCodeAt(0).toString(16)}` : c)).join('');  // every other one
  const upper = [...s].map((c, i) => (i % 3 ? c : `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('');
  for (const [name, text] of [['one', one], ['every other', every], ['upper case, every third', upper]]) {
    assert.equal(holdsSecret(`x=${text}`), true, name);
    assert.throws(() => spawnSync('/bin/echo', [`--token=${text}`]), refusedWithout(s), name);
  }
  // A PEM-like value: newlines and spaces, as encodeURI, escape and URLSearchParams write them.
  const pem = registerSecret(`-----BEGIN TEST KEY-----\n${randomBytes(48).toString('base64')}\n${randomBytes(48).toString('base64')}\n-----END TEST KEY-----\n`);
  const spellings = {
    encodeURI: encodeURI(pem), escape: escape(pem),
    URLSearchParams: new URLSearchParams({ k: pem }).toString(),
    encodeURIComponent: encodeURIComponent(pem),
  };
  for (const [name, text] of Object.entries(spellings)) {
    assert.ok(text !== pem, name);
    assert.equal(holdsSecret(text), true, name);
    assert.throws(() => spawnSync('/bin/echo', [text]), refusedWithout(pem), name);
  }
  // A % that starts no run (and bytes that are not UTF-8) don't throw, and don't hide a value next to them.
  for (const junk of ['%', '%G1', '%u12', '%ff%fe', '100%']) {
    assert.doesNotThrow(() => holdsSecret(`${junk}abc`), junk);
    assert.equal(holdsSecret(`${junk}${one}${junk}`), true, junk);
    assert.equal(holdsSecret(`${junk} plain text`), false, junk);
  }
  assert.equal(holdsSecret('a%20b+c%2Bd, nothing secret'), false);
});

test('L1196 Minor 1: fork\'s execArgv and execPath, options after a skipped argument list, a shell named by path, and ChildProcess.prototype.spawn are checked', () => {
  const s = registerSecret(fresh());
  const dir = tempDir('orch-secret-guard-fork-'); const mod = join(dir, 'child.mjs'); writeFileSync(mod, '');
  assert.throws(() => fork(mod, [], { execArgv: [`--title=${s}`] }), refusedWithout(s));
  assert.throws(() => fork(mod, { execArgv: [`--title=${s}`] }), refusedWithout(s), 'options in the arguments\' place');
  assert.throws(() => fork(mod, [], { execPath: `/tmp/${s}/node` }), refusedWithout(s));
  assert.throws(() => spawn('/bin/echo', undefined, { argv0: s }), refusedWithout(s));
  assert.throws(() => spawnSync('/bin/echo', null, { argv0: s }), refusedWithout(s));
  assert.throws(() => execFileSync('/bin/echo', undefined, { argv0: s }), refusedWithout(s));
  assert.throws(() => execSync('true', { shell: `/tmp/${s}/sh` }), refusedWithout(s));
  // ChildProcess.prototype.spawn, called on a ChildProcess made directly.
  const child = new ChildProcess();
  assert.throws(() => child.spawn({ file: '/bin/echo', args: ['/bin/echo', s], envPairs: [], stdio: 'ignore' }), (e) => { assert.match(e.message, /refused to start a program \(ChildProcess\.spawn\)/); assert.ok(!e.message.includes(s)); return true; });
  assert.equal(ChildProcess.prototype.spawn[Symbol.for('orchestrate.secret-guard.wrapped')], true);
  // The ordinary forms still start.
  assert.equal(spawnSync('/bin/echo', undefined, { encoding: 'utf8' }).status, 0);
  assert.equal(execSync('echo ok', { shell: '/bin/sh', encoding: 'utf8' }).trim(), 'ok');
});

test('L1196 Minor 2: a PEM key is also refused trimmed and as its base64 body alone, on one line or wrapped', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = registerSecret(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  assert.ok(pem.endsWith('\n') && body.length > 500);
  assert.throws(() => spawnSync('/bin/echo', [pem.trim()]), refusedWithout(body));
  assert.throws(() => spawnSync('/bin/echo', [body]), refusedWithout(body));
  assert.throws(() => spawnSync('/bin/echo', [`--key=${body}`]), refusedWithout(body));
  assert.throws(() => spawnSync('/bin/echo', [pem.replace(/\n/g, '\r\n')]), refusedWithout(body), 'CRLF lines: the body, whitespace out, is the same');
  // The key's own bytes (the body decoded) in their encodings: URL-safe base64, and hex.
  const der = Buffer.from(body, 'base64');
  assert.equal(holdsSecret(der.toString('base64url')), true, 'URL-safe');
  assert.equal(holdsSecret(der.toString('hex')), true, 'hex');
  assert.equal(holdsSecret(der.toString('hex').toUpperCase()), true, 'hex, upper case');
});

test('L1196 Minor 3: base64 wrapped at 64 or 76 columns and hex with spaces between the bytes are refused (the text with its whitespace out)', () => {
  const s = registerSecret(fresh());
  const b64 = Buffer.from(`prefix that pushes the value onto a second line ${s} and a tail`).toString('base64');
  const wrap = (t, n, nl = '\n') => t.match(new RegExp(`.{1,${n}}`, 'g')).join(nl);
  for (const n of [64, 76]) {
    assert.equal(holdsSecret(wrap(b64, n)), true, `wrapped at ${n}`);
    assert.equal(holdsSecret(wrap(b64, n, '\r\n')), true, `wrapped at ${n}, CRLF`);
    assert.throws(() => spawnSync('/bin/echo', [wrap(b64, n)]), refusedWithout(s), `wrapped at ${n}`);
  }
  const hex = Buffer.from(s).toString('hex');
  assert.equal(holdsSecret(hex.match(/../g).join(' ')), true, 'hex with spaces');
  assert.equal(holdsSecret(hex.toUpperCase().match(/../g).join(' ')), true, 'upper hex with spaces');
  assert.equal(holdsSecret(hex.match(/.{1,32}/g).join('\n')), true, 'hex wrapped (xxd -p)');
  assert.equal(holdsSecret(wrap(Buffer.from('nothing secret at all, just text that is long enough').toString('base64'), 64)), false);
});

// --- L1206 (the #581 r2 audit) ---------------------------------------------------------------------------------------

test('L1206 m1: a big argument with a % in it is checked in linear time', () => {
  registerSecret(fresh());
  for (const big of ['%'.repeat(1 << 20), `${'a%2'.repeat(350_000)}`, `${'%41'.repeat(350_000)}`, `${'x'.repeat(1 << 20)}%`]) {
    const t0 = process.hrtime.bigint();
    assert.equal(holdsSecret(big), false);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 150, `${big.slice(0, 6)}… took ${ms.toFixed(1)} ms`);
  }
});

test('L1206 m2: a query string\'s form, + for each space, is refused', () => {
  const s = registerSecret('my secret pass phrase 42');
  assert.equal(holdsSecret('k=my+secret+pass+phrase+42'), true);
  assert.equal(holdsSecret('k=my+secret%20pass+phrase%2042'), true, 'mixed with %20');
  assert.throws(() => spawnSync('/bin/echo', ['k=my+secret+pass+phrase+42']), refusedWithout(s));
});

test('L1206 m3: each part is made a string once; the start gets exactly the string that was checked', () => {
  const s = registerSecret(fresh());
  const shifty = () => { let n = 0; return { calls: () => n, toString() { n += 1; return n <= 2 ? 'harmless text' : s; } }; };
  const evil = shifty();
  const r = spawnSync('/bin/echo', [evil], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'harmless text', 'the checked string is the one that ran');
  assert.equal(evil.calls(), 1, 'read once');
  const evil2 = shifty();
  assert.equal(execFileSync('/bin/echo', [evil2], { encoding: 'utf8' }).trim(), 'harmless text');
  // pinned: strings in, the caller's objects untouched.
  const opts = { argv0: shifty(), execArgv: [shifty()], shell: '/bin/sh', env: {} };
  const b = pinned(['/bin/echo', [shifty(), 'b'], opts]);
  assert.deepEqual(b[1], ['harmless text', 'b']);
  assert.equal(b[2].argv0, 'harmless text'); assert.deepEqual(b[2].execArgv, ['harmless text']); assert.equal(b[2].shell, '/bin/sh');
  assert.notEqual(b[2], opts); assert.equal(typeof opts.argv0, 'object', 'the caller\'s options are copied, not changed');
  assert.deepEqual(pinned(['ls', undefined, { argv0: undefined, shell: true }]), ['ls', undefined, { argv0: undefined, shell: true }]);
  // ChildProcess.prototype.spawn pins its options in place.
  const evil3 = shifty(); const o = { file: '/bin/echo', args: ['/bin/echo', evil3], envPairs: [], stdio: 'ignore' };
  const child = new ChildProcess();
  child.spawn(o);
  assert.deepEqual(o.args, ['/bin/echo', 'harmless text']); assert.equal(evil3.calls(), 1);
  child.kill();
});

test('L1206: each layer fails on its own: partsOf reads execArgv, execPath, a skipped list\'s options and a shell; trim and the PEM body each register a form only they give', () => {
  const S = 'x'.repeat(4);   // partsOf is plain text plumbing: no secret needed
  assert.deepEqual(partsOf('fork', ['m.mjs', [], { execArgv: [`--a=${S}`] }]), ['m.mjs', `--a=${S}`]);
  assert.deepEqual(partsOf('fork', ['m.mjs', { execPath: `/p/${S}` }]), ['m.mjs', `/p/${S}`]);
  assert.deepEqual(partsOf('spawn', ['/bin/echo', undefined, { argv0: S }]), ['/bin/echo', S]);
  assert.deepEqual(partsOf('spawn', ['/bin/echo', null, { argv0: S }]), ['/bin/echo', S]);
  assert.deepEqual(partsOf('execSync', ['true', { shell: `/sh/${S}` }]), ['true', `/sh/${S}`]);
  assert.deepEqual(partsOf('execSync', ['true', { shell: true }]), ['true']);
  // Trim: a value read with its newline; the trimmed text alone is held only because the trimmed form is registered.
  const v = fresh(); registerSecret(`${v}\n`);
  assert.equal(holdsSecret(`--t=${v}`), true);
  // The PEM body's own text forms (its hex) come only from the body's registration; the DER's hex only from the bytes'.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = registerSecret(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  assert.equal(holdsSecret(Buffer.from(body).toString('hex')), true, 'the body as text, in hex');
  assert.equal(holdsSecret(Buffer.from(body, 'base64').toString('hex')), true, 'the key bytes, in hex');
});
