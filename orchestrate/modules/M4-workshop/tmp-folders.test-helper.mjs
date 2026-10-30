// Test-only: every temp folder a test makes, removed when the test file's process ends, a failed
// test included. node --test runs each file in its own process, so each file cleans up its own.
// M4's and M11's tests use this; `tmp-cleanup.test.mjs` checks that nothing is left behind.

import { mkdtempSync, rmSync, chmodSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];

// A folder a test made read-only cannot be emptied, so give the owner write access back first.
function writable(p) {
  let s;
  try { s = lstatSync(p); } catch { return; }
  if (s.isSymbolicLink() || !s.isDirectory()) return;
  try { chmodSync(p, 0o700); } catch { /* not ours to change */ }
  let names = [];
  try { names = readdirSync(p); } catch { return; }
  for (const n of names) writable(join(p, n));
}

export function removeAll() {
  for (const d of made.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { writable(d); rmSync(d, { recursive: true, force: true }); }
    if (existsSync(d)) throw new Error(`test temp folder left behind: ${d}`);
  }
}

// Hooked at the top level when first imported, so it runs after every test in the file and fails the
// run if a folder cannot be removed; the exit handler catches a run that ends without the hook.
after(removeAll);
process.once('exit', () => { try { removeAll(); } catch { /* the after hook already failed the run */ } });

/** A fresh temp folder named `<prefix>XXXXXX` in the system temp folder (or `base`), removed at exit. */
export function tmpFolder(prefix, base = tmpdir()) {
  const d = mkdtempSync(join(base, prefix));
  made.push(d);
  return d;
}
