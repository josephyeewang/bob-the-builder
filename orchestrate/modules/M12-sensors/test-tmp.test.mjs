// Lead, 29 Oct 2026: leftover test folders filled a disk. This runs this lane's quick test files, and one that fails on
// purpose, with the temp folder pointed at a new empty one, and checks nothing is left in it afterwards. (The slow
// shell-guard file runs its own after-check: test-tmp.mjs fails the file if any folder it made is still there.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempFolders } from './test-tmp.mjs';

const tmp = tempFolders();
const here = (f) => fileURLToPath(new URL(f, import.meta.url));

test('nothing a test file makes is left in the temp folder, even when a test fails', () => {
  const files = ['./history.test.mjs', '../M1-front-door/round4.test.mjs', './fixtures/fails-with-tmp.mjs'];
  for (const f of files) {
    const t = tmp('tmpcheck-');
    // Without NODE_TEST_CONTEXT, which would make the child report to this runner and exit 0 whatever happened.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const r = spawnSync(process.execPath, ['--test', here(f)], { env: { ...env, TMPDIR: t, TMP: t, TEMP: t }, encoding: 'utf8' });
    assert.equal(r.status === 0, !f.includes('fails-with'), `${f} exit ${r.status}\n${r.stdout.slice(-800)}`);
    assert.deepEqual(readdirSync(t), [], `${f} left this in the temp folder`);
  }
});
