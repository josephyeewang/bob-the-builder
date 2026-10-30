// limitedSync: a synchronous port's command never blocks past its limit (lead's item 3 for 0b-6).
// The hung children here are real processes, started in a throwaway folder and killed by the limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitedSync, SYNC_PORT_MAX_BUFFER } from './sync-limit.mjs';
import { main } from './main.mjs';

const node = process.execPath;
// A mark of its own, so the clean-up below ends only this file's children.
const MARK = `synclimit${process.pid}x${Date.now()}`;
const HANG = `/*${MARK}*/ setInterval(() => {}, 1e9)`;

test('a hung child is killed at its limit and answers "no answer"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-limit-'));
  try {
    const run = limitedSync(spawnSync);
    const t = Date.now();
    const r = run(node, ['-e', HANG], { timeoutMs: 400, cwd: dir });
    const took = Date.now() - t;
    assert.equal(r.ok, false);
    assert.match(r.why, /no answer within 400 ms/);
    assert.ok(took < 5_000, `returned in ${took} ms`);
    // A child that ignores the polite stop is still ended: the kill cannot be caught.
    const t2 = Date.now();
    const r2 = run(node, ['-e', `process.on('SIGTERM', () => {}); ${HANG}`], { timeoutMs: 400, cwd: dir });
    assert.equal(r2.ok, false);
    assert.ok(Date.now() - t2 < 5_000, 'a child that ignores SIGTERM is killed too');
    // A child whose own child keeps the output open still returns at the limit.
    const t3 = Date.now();
    const r3 = run('/bin/sh', ['-c', `"${node}" -e '${HANG}' & "${node}" -e '${HANG}'`], { timeoutMs: 400, cwd: dir });
    assert.equal(r3.ok, false);
    assert.ok(Date.now() - t3 < 5_000, 'a grandchild holding the output does not hold the port');
  } finally {
    // The grandchildren the limit does not reach (the kill goes to the child it started).
    spawnSync('/usr/bin/pkill', ['-9', '-f', MARK]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the options every run carries: limit, uncatchable kill, output cap', () => {
  const seen = [];
  const run = limitedSync((cmd, args, opts) => { seen.push(opts); return { status: 0, stdout: 'ok' }; });
  assert.deepEqual(run('x', [], {}), { ok: true, stdout: 'ok' });
  run('x', [], { timeoutMs: 1234 });
  assert.equal(seen[0].timeout, 20_000, 'a default limit');
  assert.equal(seen[1].timeout, 1234);
  for (const o of seen) {
    assert.equal(o.killSignal, 'SIGKILL');
    assert.equal(o.maxBuffer, SYNC_PORT_MAX_BUFFER);
    assert.equal(o.shell, false);
  }
  for (const bad of [0, -1, Infinity, NaN, '5']) assert.equal(run('x', [], { timeoutMs: bad }).ok, false, `limit ${bad}`);
  assert.equal(seen.length, 2, 'a run with no usable limit starts nothing');
  assert.throws(() => limitedSync(undefined), /needs the spawnSync/);
});

test('every failure is "no answer", never a throw', () => {
  const cases = [
    [{ error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }, /no answer within/],
    [{ error: Object.assign(new Error('b'), { code: 'ENOBUFS' }) }, /more than the limit/],
    [{ error: new Error('nope') }, /could not run/],
    [{ signal: 'SIGKILL', status: null }, /stopped by SIGKILL/],
    [{ status: 3 }, /exited 3/],
  ];
  for (const [res, why] of cases) {
    const r = limitedSync(() => res)('x');
    assert.equal(r.ok, false);
    assert.match(r.why, why);
  }
  assert.match(limitedSync(() => { throw new Error('boom'); })('x').why, /could not run: boom/);
  // Real: a missing program and too much output.
  assert.equal(limitedSync(spawnSync)('/nonexistent/prog').ok, false);
  const big = limitedSync(spawnSync)(node, ['-e', `process.stdout.write('x'.repeat(${SYNC_PORT_MAX_BUFFER + 10}))`]);
  assert.match(big.why, /more than the limit/);
});

test('main hands limitedSync to the wiring', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-limit-main-'));
  try {
    writeFileSync(join(dir, 'wiring.mjs'), "export async function wire(config, helpers) { globalThis.__helpers = helpers; throw new Error('stop here'); }\n");
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ wiring: join(dir, 'wiring.mjs'), lockFile: join(dir, 'l.lock') }));
    assert.equal(await main([join(dir, 'config.json')], { log: () => {} }), 1);
    assert.equal(globalThis.__helpers?.limitedSync, limitedSync);
  } finally {
    delete globalThis.__helpers;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('r5 m3: a time limit above the most allowed is refused before anything runs', async () => {
  const { SYNC_PORT_MAX_TIMEOUT_MS } = await import('./sync-limit.mjs');
  let ran = 0;
  const run = limitedSync(() => { ran += 1; return { status: 0, stdout: '' }; });
  assert.match(run('x', [], { timeoutMs: SYNC_PORT_MAX_TIMEOUT_MS + 1 }).why, /above the most allowed/);
  assert.match(run('x', [], { timeoutMs: Infinity }).why, /no time limit given/);
  assert.equal(ran, 0);
  assert.equal(run('x', [], { timeoutMs: SYNC_PORT_MAX_TIMEOUT_MS }).ok, true);
});
