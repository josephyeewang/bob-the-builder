// selfcheck.test.mjs — L117 m-3 and m-4: a shell run that can't say what it did is never "touched nothing", each retry
// gets a new folder, and a timeout kills every process the case started. M12 speed (lead, 1 Nov 2026): a check that
// runs out of its time budget fails, "guard not verified", never passes; a folder that can't be removed is said so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { removeFolder, runShell, touchCheck } from './selfcheck.mjs';

const ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };

const hangShell = () => {
  const bin = tempDir('sg-bin-');
  const hang = join(bin, 'hangsh');
  writeFileSync(hang, '#!/bin/sh\nsleep 5\n'); chmodSync(hang, 0o755);
  return hang;
};
const counting = () => {
  const made = [];
  return { made, newFolder: () => { const f = tempDir('sg-run-'); made.push(f); return f; } };
};

test('L117 m-3: a shell that cannot start, or that is killed, is unsure, never a clean run', async () => {
  const d = tempDir('sg-sc-');
  assert.equal((await runShell('/no/such/shell', ['-c', 'true'], { cwd: d, env: ENV, timeout: 5000 })).unsure, true, 'cannot start');
  assert.equal((await runShell('/bin/sh', ['-c', 'kill -9 $$'], { cwd: d, env: ENV, timeout: 5000 })).unsure, true, 'killed');
  assert.equal((await runShell('/bin/sh', ['-c', 'sleep 5'], { cwd: d, env: ENV, timeout: 200 })).unsure, true, 'timed out');
  const big = await runShell('/bin/sh', ['-c', 'yes'], { cwd: d, env: ENV, timeout: 20_000 });
  assert.equal(big.unsure, true, 'too much output');
  assert.equal(big.r.error?.code, 'ENOBUFS', 'stopped for its output, not by the timeout');
  const ok = await runShell('/bin/sh', ['-c', 'echo hi; exit 3'], { cwd: d, env: ENV, timeout: 5000 });
  assert.equal(ok.unsure, false, 'a normal exit, any status, is a real run');
  assert.equal(ok.r.stdout, 'hi\n');
  assert.equal(ok.r.status, 3);
  assert.equal((await runShell('/bin/sh', ['-c', 'exit 127'], { cwd: d, env: ENV, timeout: 5000 })).unsure, false, 'a case\'s own 127 is real');
});

test('L117 m-4: a timeout kills the background processes the case started, so none writes afterwards', async () => {
  const d = tempDir('sg-sc-');
  const late = join(d, 'late');
  const { unsure } = await runShell('/bin/sh', ['-c', `(sleep 1; echo x > ${late}) & sleep 5`], { cwd: d, env: ENV, timeout: 300 });
  assert.equal(unsure, true);
  spawnSync('/bin/sleep', ['1.6']);
  assert.equal(existsSync(late), false, 'the background child was killed with the shell');
});

test('L117 m-3, m-4: a case that can never finish stops the check, naming it, after one new folder per attempt', async () => {
  const hang = hangShell();
  const { made, newFolder } = counting();
  await assert.rejects(touchCheck('.env', { shells: [hang], newFolder, timeouts: [100, 100, 100], atOnce: 1 }), /could not tell, .*hangsh could not run it 3 times/);
  assert.equal(made.length, 4, 'the stand-in folder, then a new folder for each of the three attempts');
  assert.equal(new Set(made).size, 4);
  for (const f of made) assert.equal(existsSync(f), false, `${f} was removed`);
});

test('L124 c1: after a normal exit the case\'s background processes are killed too, so none writes afterwards', async () => {
  const d = tempDir('sg-sc-');
  const late = join(d, 'late');
  const { unsure, r } = await runShell('/bin/sh', ['-c', `(sleep 1; echo x > ${late}) > /dev/null 2>&1 & exit 0`], { cwd: d, env: ENV, timeout: 5000 });
  assert.equal(unsure, false, 'a normal exit is a real run');
  assert.equal(r.status, 0);
  spawnSync('/bin/sleep', ['1.6']);
  assert.equal(existsSync(late), false, 'the background child left behind was killed with the group');
});

test('M12 speed 1: a self-check stopped by its time budget reports failure, "guard not verified", never a pass', async () => {
  // A shell that never finishes, long per-attempt times, a short budget: the cut attempt is out of time, not "untouched".
  const hang = hangShell();
  const { made, newFolder } = counting();
  const t = Date.now();
  await assert.rejects(touchCheck('.env', { shells: [hang], newFolder, timeouts: [10_000, 10_000], budgetMs: 400, atOnce: 3 }), /^Error: guard not verified: the self-check ran out of time \(400 ms\) after 0 of \d+ runs$/);
  assert.ok(Date.now() - t < 5000, 'the budget cut the 10 s attempts short');
  for (const f of made) assert.equal(existsSync(f), false, `${f} was removed`);
  // A real shell with no time left fails too, before any run starts: running out of time is never "touched nothing".
  const before = made.length;
  await assert.rejects(touchCheck('.env', { shells: ['/bin/sh'], newFolder, budgetMs: 0 }), /guard not verified: the self-check ran out of time \(0 ms\) after 0 of/);
  assert.equal(made.length - before, 1, 'only the stand-in folder: no run was started with no time left');
});

test('M12 speed 2: a folder that can\'t be removed is said so, with the reason, never swallowed', () => {
  const d = tempDir('sg-rm-');
  const locked = join(d, 'locked');
  mkdirSync(locked); writeFileSync(join(locked, 'f'), 'x'); chmodSync(locked, 0o500);
  try {
    assert.throws(() => removeFolder(d), /^Error: could not remove .*sg-rm-.*: E[A-Z]+$/);
    assert.equal(existsSync(join(locked, 'f')), true);
  } finally { chmodSync(locked, 0o700); }
  removeFolder(d);
  assert.equal(existsSync(d), false);
});
