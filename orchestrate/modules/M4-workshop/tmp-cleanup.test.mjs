// The guard: M4's and M11's tests leave no temp folder behind. It runs every other test file in the
// two folders with the system temp folder pointed at a fresh empty one, then checks nothing named
// orch-*, m4-* or m11-* is left there. A left-behind folder fails it, by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpFolder } from './tmp-folders.test-helper.mjs';

const HERE = dirname(new URL(import.meta.url).pathname);
const CHILD = 'ORCH_TMP_GUARD_CHILD';
const OURS = /^(orch-|m4-|m11-)/;

function testFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.name.endsWith('.test.mjs') && p !== new URL(import.meta.url).pathname) out.push(p);
  }
  return out;
}

test('no test in M4 or M11 leaves a temp folder behind', { skip: process.env[CHILD] === '1', timeout: 900_000 }, () => {
  const scratch = tmpFolder('guard-');
  const files = [...testFiles(HERE), ...testFiles(join(HERE, '..', 'M11-dispatcher'))];
  assert.ok(files.length > 20, 'the test files were found');
  // The runner's own marker is dropped, or the inner run reports to this one and runs nothing.
  const { NODE_TEST_CONTEXT: _, ...vars } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
    env: { ...vars, TMPDIR: `${scratch}/`, [CHILD]: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `the tests themselves failed:\n${r.stdout.slice(-4000)}`);
  const ran = Number(/ℹ pass (\d+)/.exec(r.stdout)?.[1] ?? 0);
  assert.ok(ran > 300, `the inner run really ran the tests (${ran} passed)`);
  const left = readdirSync(scratch).filter((n) => OURS.test(n));
  assert.deepEqual(left, [], `left behind in the temp folder: ${left.join(', ')}`);
});
