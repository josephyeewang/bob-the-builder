// test-tmp.mjs — temp folders for tests that are always removed, pass or fail.
//
// WHY. Test temp folders that were never removed filled a Mac's disk (lead, 29 Oct 2026). Every test that needs a
// folder asks here; tmp-guard.test.mjs fails any test file in these folders that calls mkdtemp itself.
//
//   import { tempDir } from '../../shared/test-tmp.mjs';
//   const dir = tempDir('m10-reader-');   // removed by an after() hook when this test file ends, even on failure
//
// After removing them, the hook checks each folder is gone and fails the run if one is left. Import this module at
// the top of the test file (a static import), never inside a test.

import { mkdtempSync, rmSync, existsSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];
// Hooked when this file is first imported, at the top level: an after() first called inside a test body belongs to that
// test only, so the folders later tests make would be left (seen 29 Oct 2026: 57 folders left by one run). The exit
// handler catches a run that ends without the hook (a crash, or a process.exit in a test).
after(removeAll);
process.on('exit', () => { try { removeAll(); } catch { /* the after hook already failed the run */ } });

// A test may have taken write permission off a folder; give it back so the folder can be removed.
function unlock(dir) {
  try { chmodSync(dir, 0o700); } catch { /* gone or not ours */ }
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) unlock(p);
    else if (!st.isSymbolicLink()) { try { chmodSync(p, 0o600); } catch { /* ignore */ } }
  }
}

export function removeAll() {
  for (const dir of made.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { unlock(dir); rmSync(dir, { recursive: true, force: true }); }
    if (existsSync(dir)) throw new Error(`test temp folder left behind: ${dir}`);
  }
}

export function tempDir(prefix) {
  if (typeof prefix !== 'string' || !/^m(10|9|2|6)-[a-z0-9-]+-$/.test(prefix)) throw new Error(`temp prefix must look like m10-name-: ${prefix}`);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
