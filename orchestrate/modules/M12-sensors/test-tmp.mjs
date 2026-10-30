// test-tmp.mjs — throwaway folders for this lane's tests, always removed (lead, 29 Oct 2026: leftover test folders
// filled a disk). Every folder a test file makes is removed in an `after` hook, which runs even when a test fails, and
// the hook then checks none is left: a folder still there fails the run.

import { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempFolders() {
  const made = [];
  after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
    assert.deepEqual(made.filter((d) => existsSync(d)), [], 'test folders left behind');
  });
  // prefix: a short name (e.g. 'hist-'); the folder is a new one under the system's temp folder, real path.
  return (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(d); return d; };
}
