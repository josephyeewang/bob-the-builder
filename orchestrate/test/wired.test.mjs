// wired.test.mjs — every module pass something production runs, or a named row that will (lead call L221).
// Run: node --test orchestrate/test/wired.test.mjs
//
// WHY. #121's audit found M2's schedulePass fully built and tested, yet nothing on the Mini ever called it: the tick
// had no approvals step, so the product record was never made. A census of main then found more passes with no
// production caller. Unit tests can't see this (they call the pass directly), so this test looks from the other end.
//
// HOW. Entry points are the non-test files Node runs directly (a `#!/usr/bin/env node` line or a process.argv[1]
// check), outside orchestrate/test/. From them it follows static imports to every reachable file. A pass is an
// exported function whose name ends in Pass, Once, Step or Sweep, in orchestrate/modules/ or orchestrate/shared/.
// It counts as run when a reachable file other than its own imports it by name (or reads it off `* as NS`), or when
// its own file is reached and calls it. Anything else must be in UNWIRED with the row or call that will run it,
// and an UNWIRED name that is now run fails too, so the list stays true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ORCH, 'test');

// name → why it is not run yet. Each names the row or lead call that gives it a running home.
export const UNWIRED = Object.freeze({
  schedulePass: 'L221: tick approvals step, lane 1 on #121',
  deliverAlertsPass: 'L236: the robot job runs it last in each round (deliverWith), lane 4 on R-0b-162',
  gatePass: 'L221: R-0b-162 wiring, lane 4',
  heartbeatOnce: 'L221: R-0b-162 wiring, lane 4',
  caughtUpOnce: 'L221: R-0b-162 wiring, lane 4',
  watchOnce: 'L221: R-0b-162 wiring, lane 4',
  planPass: 'L221: R-0b-142 (the Lead turns a plan reviewer PASS into M2 plan check), no code calls it yet; lead to place',
  installStep: 'L221: R-0b-162 wiring (a worker launch with an install phase), lane 4',
});

const isTest = (f) => /\.test\.mjs$|test-helper/.test(f);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'fixtures' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs') && !isTest(e.name)) out.push(p);
  }
  return out;
}

const FILES = walk(ORCH).filter((f) => !f.startsWith(TEST_DIR + sep));
const SRC = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
// Code without comments, for counting calls: a pass named in a comment (`// await schedulePass(ctx) → …`) is not a call.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const rel = (f) => relative(ORCH, f);

const isEntry = (src) => /^#!\/usr\/bin\/env node/.test(src) || /process\.argv\[1\]/.test(src);
const ENTRIES = FILES.filter((f) => isEntry(SRC.get(f)));

// Static imports and re-exports with a relative path; `import('…')` with a literal path counts too.
const IMPORT_RE = /(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
function importsOf(f) {
  const out = [];
  for (const m of SRC.get(f).matchAll(IMPORT_RE)) {
    const p = resolve(dirname(f), m[1] ?? m[2]);
    if (existsSync(p) && statSync(p).isFile()) out.push(p);
  }
  return out;
}

function reachable() {
  const seen = new Set();
  const stack = [...ENTRIES];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !SRC.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  return seen;
}

const PASS_RE = /^export (?:async )?function ([A-Za-z0-9_]+(?:Pass|Once|Step|Sweep))\b/gm;
function passes() {
  const out = [];
  for (const [f, src] of SRC) {
    const r = rel(f);
    if (!r.startsWith('modules' + sep) && !r.startsWith('shared' + sep)) continue;
    for (const m of src.matchAll(PASS_RE)) out.push({ name: m[1], file: f });
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function runBy(pass, reach) {
  const named = new RegExp(`import\\s*\\{[^}]*\\b${pass.name}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`, 'g');
  for (const f of reach) {
    if (f === pass.file) continue;
    const src = SRC.get(f);
    for (const m of src.matchAll(named)) if (resolve(dirname(f), m[1]) === pass.file) return rel(f);
    for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from\s*['"]([^'"]+)['"]/g)) {
      if (resolve(dirname(f), m[2]) === pass.file && new RegExp(`\\b${esc(m[1])}\\.${pass.name}\\b`).test(src)) return rel(f);
    }
  }
  // Called inside its own file, and that file is reached (a helper the reached code uses). One match is the definition.
  if (reach.has(pass.file)) {
    const calls = strip(SRC.get(pass.file)).match(new RegExp(`\\b${pass.name}\\(`, 'g')) ?? [];
    if (calls.length > 1) return rel(pass.file);
  }
  return null;
}

test('L221: the scan finds the entry points and the passes it should', () => {
  const entries = ENTRIES.map(rel);
  assert.ok(entries.includes(join('modules', 'M11-dispatcher', 'main.mjs')), 'the Dispatcher main is an entry');
  const names = passes().map((p) => p.name);
  for (const n of ['dispatcherPass', 'intakePass', 'cleanupPass', 'schedulePass']) assert.ok(names.includes(n), `${n} is found`);
  const reach = reachable();
  assert.ok(reach.has(join(ORCH, 'modules', 'M11-dispatcher', 'tick.mjs')), 'tick.mjs is reached from main.mjs');
});

test('L221: every module pass is run by production code, or named in UNWIRED with the row that will run it', () => {
  const reach = reachable();
  const missing = [];
  const stale = [];
  for (const p of passes()) {
    const by = runBy(p, reach);
    if (!by && !UNWIRED[p.name]) missing.push(`${p.name} (${rel(p.file)})`);
    if (by && UNWIRED[p.name]) stale.push(`${p.name} is now run by ${by}: take it off UNWIRED`);
  }
  assert.deepEqual(missing, [], 'a pass nothing in production runs; wire it, or add it to UNWIRED with its row');
  assert.deepEqual(stale, []);
});

test('L221: every UNWIRED name is a pass that exists and names a row or lead call', () => {
  const names = new Set(passes().map((p) => p.name));
  for (const [n, why] of Object.entries(UNWIRED)) {
    assert.ok(names.has(n), `${n} is not a pass any more; take it off UNWIRED`);
    assert.match(why, /\b(L\d+|R-0b-\d+)\b/, `${n}: say which row or lead call runs it`);
  }
});
