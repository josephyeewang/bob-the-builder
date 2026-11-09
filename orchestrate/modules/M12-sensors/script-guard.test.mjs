// script-guard.test.mjs — #261 r2 Minor 1 class, in lane 3's folders: a "run as a script?" check that does not resolve a
// link does nothing when the script is started through one (it prints nothing and exits 0). Every such check in M1, M12
// and M13 resolves argv[1] first, and the Air's health script really runs through a link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';

const MODULES = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDERS = ['M1-front-door', 'M12-sensors', 'M13-ledger'];

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...sources(p)); }
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.includes('.test-helper.')) out.push(p);
  }
  return out;
}

test('#261 class: every script check in lane 3\'s folders resolves argv[1] before comparing it', () => {
  const bad = [];
  let checks = 0;
  for (const f of FOLDERS.flatMap((d) => sources(join(MODULES, d)))) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!/process\.argv\[1\]/.test(line) || !/import\.meta\.url/.test(line)) continue;
      checks++;
      if (!/realpathSync\(process\.argv\[1\]\)/.test(line)) bad.push(`${f.slice(MODULES.length + 1)}: ${line.trim()}`);
    }
  }
  assert.ok(checks >= 6, `found only ${checks} script checks; the scan is not reading the files`);
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
