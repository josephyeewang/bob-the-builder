// selfcheck.test.mjs — L117 m-3 and m-4: a shell run that can't say what it did is never "touched nothing", each retry
// gets a new folder, and a timeout kills every process the case started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { runShell, touchCheck } from './selfcheck.mjs';

const ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };

test('L117 m-3: a shell that cannot start, or that is killed, is unsure, never a clean run', () => {
  const d = tempDir('sg-sc-');
  assert.equal(runShell('/no/such/shell', ['-c', 'true'], { cwd: d, env: ENV, timeout: 5000 }).unsure, true, 'cannot start');
  assert.equal(runShell('/bin/sh', ['-c', 'kill -9 $$'], { cwd: d, env: ENV, timeout: 5000 }).unsure, true, 'killed');
  assert.equal(runShell('/bin/sh', ['-c', 'sleep 5'], { cwd: d, env: ENV, timeout: 200 }).unsure, true, 'timed out');
  const ok = runShell('/bin/sh', ['-c', 'echo hi; exit 3'], { cwd: d, env: ENV, timeout: 5000 });
  assert.equal(ok.unsure, false, 'a normal exit, any status, is a real run');
  assert.equal(ok.r.stdout, 'hi\n');
  assert.equal(runShell('/bin/sh', ['-c', 'exit 127'], { cwd: d, env: ENV, timeout: 5000 }).unsure, false, 'a case\'s own 127 is real');
});

test('L117 m-4: a timeout kills the background processes the case started, so none writes afterwards', () => {
  const d = tempDir('sg-sc-');
  const late = join(d, 'late');
  const { unsure } = runShell('/bin/sh', ['-c', `(sleep 1; echo x > ${late}) & sleep 5`], { cwd: d, env: ENV, timeout: 300 });
  assert.equal(unsure, true);
  spawnSync('/bin/sleep', ['1.6']);
  assert.equal(existsSync(late), false, 'the background child was killed with the shell');
});

test('L117 m-3, m-4: a case that can never finish stops the check, naming it, after one new folder per attempt', () => {
  const bin = tempDir('sg-bin-');
  const hang = join(bin, 'hangsh');
  writeFileSync(hang, '#!/bin/sh\nsleep 5\n'); chmodSync(hang, 0o755);
  const made = [];
  const newFolder = () => { const f = tempDir('sg-run-'); made.push(f); return f; };
  assert.throws(() => touchCheck('.env', { shells: [hang], newFolder, timeouts: [100, 100, 100] }), /could not tell, .*hangsh could not run it 3 times/);
  assert.equal(made.length, 4, 'the stand-in folder, then a new folder for each of the three attempts');
  assert.equal(new Set(made).size, 4);
  for (const f of made) assert.equal(existsSync(f), false, `${f} was removed`);
});

test('L124 c1: after a normal exit the case\'s background processes are killed too, so none writes afterwards', () => {
  const d = tempDir('sg-sc-');
  const late = join(d, 'late');
  const { unsure, r } = runShell('/bin/sh', ['-c', `(sleep 1; echo x > ${late}) > /dev/null 2>&1 & exit 0`], { cwd: d, env: ENV, timeout: 5000 });
  assert.equal(unsure, false, 'a normal exit is a real run');
  assert.equal(r.status, 0);
  spawnSync('/bin/sleep', ['1.6']);
  assert.equal(existsSync(late), false, 'the background child left behind was killed with the group');
});
