// script-guard.test.mjs — #261 r2 Minor 1 class, across orchestrate/ (#286 r1 p1): a "run as a script?" check that does
// not resolve a link does nothing when the script is started through one (it prints nothing and exits 0). Every use of
// process.argv[1] in production code resolves it on the same line (realpathSync, realOf, or the hooks' isMain), so a
// check spelled over two lines (`const me = …; if (process.argv[1] === me)`) is caught too (#286 r1 p2). And the Air's
// health script really runs through a link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';

const MODULES = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORCH = join(MODULES, '..');
// What resolves argv[1]: node's realpath, or the two shared helpers that wrap it.
const RESOLVES = /realpathSync(\.native)?\(process\.argv\[1\]\)|realOf\(process\.argv\[1\]\)|isMain\(|argv1 = process\.argv\[1\]/;

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...sources(p)); }
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.includes('.test-helper.')) out.push(p);
  }
  return out;
}

test('#261 class: every use of argv[1] in orchestrate/ production code resolves it first', () => {
  const bad = [];
  let uses = 0;
  for (const f of sources(ORCH)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!/process\.argv\[1\]/.test(line)) continue;
      uses++;
      if (!RESOLVES.test(line)) bad.push(`${f.slice(ORCH.length + 1)}: ${line.trim()}`);
    }
  }
  assert.ok(uses >= 20, `found only ${uses} uses of argv[1]; the scan is not reading the files`);
  assert.deepEqual(bad, []);
});

test('#261 class: the Air\'s health script started through a link still writes its file', () => {
  const base = tempDir('m12-script-link-');
  const out = join(base, 'out'); mkdirSync(out);
  const link = join(base, 'air-health.mjs');
  symlinkSync(join(MODULES, 'M12-sensors', 'air-health.mjs'), link);
  const r = spawnSync(process.execPath, [link, '0', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^request-airhealth-/);
  assert.equal(readdirSync(out).length, 1);
});
