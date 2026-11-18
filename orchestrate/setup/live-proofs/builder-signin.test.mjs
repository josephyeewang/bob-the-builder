// The builder sign-in live proof (L1261), with fakes for claude, the config and the file: the refusals, PASS and FAIL,
// the value only in claude's environment (never its arguments or the output), and claude's own words masked if they hold it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT, judge, main, proofArgs } from './builder-signin.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { registerSecret } from '../../shared/secret-guard.mjs';

const VALUE = `sk-ant-oat01-${'Pq7_r-'.repeat(15)}YY`;   // made up: the shape only
const UID = 603; const PIN = '2.1.316';
const C = { ownDir: '/b/worker-runner', pin: PIN, claudeBin: '/b/claude', home: '/b/home/builder', path: '/usr/bin:/bin', signinFile: '/b/builder-signin/claude-signin' };
const ok = { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }), stderr: '' };

function deps(over = {}) {
  const runs = [];
  return {
    runs,
    d: {
      readConfig: () => C, uid: () => UID, ownerOf: () => UID, version: () => PIN, tmp: () => tempDir('orch-bsproof-'),
      account: () => ({ account: 'a', dir: '/b/home/builder/.claude', env: { CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODE_OAUTH_TOKEN: VALUE }, signinToken: true }),
      run: (bin, args, o) => { runs.push({ bin, args, o }); return ok; },
      ...over,
    },
  };
}
const go = (argv, d) => { let out = ''; const code = main(argv, { print: (t) => { out += t; }, deps: d }); return { code, out }; };
const ARGV = ['--config', '/b/worker-runner.json'];

test('PASS: the pinned claude, once, no tools, one turn; the sign-in only in its environment, never its arguments or the output', () => {
  const x = deps();
  const r = go(ARGV, x.d);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^PASS: claude signed in with the builder sign-in file and answered, on claude 2\.1\.316\n$/);
  assert.equal(x.runs.length, 1);
  const [one] = x.runs;
  assert.equal(one.bin, C.claudeBin); assert.deepEqual(one.args, proofArgs());
  assert.deepEqual(one.args.slice(0, 4), ['-p', PROMPT, '--tools', '']);
  assert.equal(one.o.env.CLAUDE_CODE_OAUTH_TOKEN, VALUE); assert.equal(one.o.env.HOME, C.home);
  assert.ok(!JSON.stringify(one.args).includes(VALUE.slice(0, 20)) && !r.out.includes(VALUE.slice(0, 20)));
});

test('NOT DONE before claude is started: root, another user, no config, no pin match, no signinFile, no sign-in', () => {
  const cases = [
    [[], {}, /^Usage:/, 2],
    [ARGV, { uid: () => 0 }, /runs as root/, 1],
    [ARGV, { ownerOf: () => 501 }, /runs as uid 603, but the worker runner's own folder/, 1],
    [ARGV, { readConfig: () => { throw new Error('no such file'); } }, /config can't be read \(no such file\)/, 1],
    [ARGV, { version: () => '2.1.400' }, /claude is 2\.1\.400, but the config's pin is 2\.1\.316/, 1],
    [ARGV, { readConfig: () => ({ ...C, signinFile: undefined }) }, /names no builder sign-in file/, 1],
    [ARGV, { account: () => ({ account: null, reason: 'the builder sign-in file /b is missing' }) }, /no builder sign-in \(the builder sign-in file \/b is missing\)/, 1],
    [ARGV, { account: () => ({ account: 'a', dir: '/x', env: {} }) }, /no builder sign-in/, 1],
  ];
  for (const [argv, over, want, code] of cases) {
    const x = deps(over); const r = go(argv, x.d);
    assert.equal(r.code, code, r.out); assert.match(r.out, want); assert.equal(x.runs.length, 0, `claude was started: ${r.out}`);
  }
});

test('FAIL with claude\'s words; masked when they hold the sign-in', () => {
  const x = deps({ run: () => ({ status: 1, stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }), stderr: '' }) });
  const r = go(ARGV, x.d); assert.equal(r.code, 1); assert.match(r.out, /^FAIL: claude ended with 1: Invalid API key/);
  const un = judge({ status: 1, stdout: '', stderr: `bad token ${VALUE}` }).why;   // not registered here: masked by its shape
  assert.match(un, /withheld/); assert.ok(!un.includes(VALUE.slice(0, 16)));
  registerSecret(VALUE);
  const reg = judge({ status: 1, stdout: '', stderr: `x\n${'y'.repeat(190)} ${VALUE}` }).why;   // registered: withheld whole, before any cut
  assert.match(reg, /withheld: it held the sign-in/); assert.ok(!reg.includes(VALUE.slice(0, 16)));
  assert.equal(judge({ status: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'Sure.' }) }).result, 'FAIL');
  assert.equal(judge({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }).why, 'claude could not be run (ETIMEDOUT)');
  assert.equal(judge(ok).result, 'PASS');
});
