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
// FILES (L234). The same reach, with hooks named in the role templates and config-named wiring modules (CONFIG_ENTRIES)
// as entry points too, must cover every production file under modules/ and shared/, or its folder is on UNWIRED_FILES
// with its row and the exact count of files not reached yet. Fixtures and fakes are left out by name.
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
  gatePass: 'L221: R-0b-162 wiring, lane 4',
  heartbeatOnce: 'L221: R-0b-162 wiring, lane 4',
  watchOnce: 'L221: R-0b-162 wiring, lane 4',
  planPass: 'L221: R-0b-142 (the Lead turns a plan reviewer PASS into M2 plan check), no code calls it yet; lead to place',
  installStep: 'L221: R-0b-162 wiring (a worker launch with an install phase), lane 4',
});

// L234: every production file under modules/ and shared/ is reached from an entry point (a node program, a hook named
// in the role settings, a config-named wiring), or its folder is here with the row that will run it and the EXACT
// number of its files not reached yet. One more unreached file fails (name it or wire it); one fewer fails too
// (lower the count), so the list stays true while staying short. Fixtures and fakes are left out by name.
export const UNWIRED_FILES = Object.freeze({
  'modules/M1-front-door/': { files: 6, why: 'R-0b-162 D: the Front Door ports (frontDoorAlive, restartFrontDoor, sendFrontDoor); no job runs M1 yet' },
  'modules/M2-approvals/': { files: 4, why: 'R-0b-136 research-ask, R-0b-140 undo-flag, L135 transcript-copy, L86 required-keys: lead to place' },
  'modules/M3-lead/': { files: 4, why: 'R-0b-162 C: the Lead ports (leads, startLead) start the Lead that uses these (R-0b-142, R-0b-143)' },
  'modules/M4-workshop/': { files: 6, why: 'R-0b-162 C/D: agent-seam (launch), send-safe (sendFrontDoor), save-work (saveWork); R-0b-147 review-walls-proof' },
  'modules/M6-merge-gate/': { files: 5, why: 'L236: gatePass in the robot job, once the robot App exists (R-0b-02)' },
  'modules/M9-record/': { files: 1, why: 'L86: required-keys, lead to place' },
  'modules/M10-rules/': { files: 4, why: 'R-0b-106 first-cutover fit check and known-gaps, L104 from-text, the hook rules snapshot: lead to place' },
  'modules/M11-dispatcher/': { files: 4, why: 'R-0b-162 C: account-ports, headless-result (worker exit); R-0b-65 login-job; R-0b-169 read-facts' },
  'modules/M12-sensors/': { files: 13, why: 'R-0b-169: the Sensors job and its probes (#89)' },
  'modules/M13-ledger/': { files: 2, why: 'L237: alerts.mjs through lane 3 deliverAlertsPass; R-0b-77 waiting' },
});
const isFixture = (f) => /(?:^|[/-])(?:fixtures?|fakes?|png-fixture|test-tmp)\.mjs$/.test(f);

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

// Hooks are run by Claude Code, named in the role settings templates (`/__orch_hooks__/<name>.mjs`), not imported.
const TEMPLATES = join(ORCH, 'modules', 'M4-workshop', 'launcher', 'templates');
const HOOKS = join(ORCH, 'modules', 'M4-workshop', 'hooks');
export const HOOK_ENTRIES = [...new Set(readdirSync(TEMPLATES).filter((n) => n.endsWith('.json'))
  .flatMap((n) => [...readFileSync(join(TEMPLATES, n), 'utf8').matchAll(/__orch_hooks__\/([\w.-]+\.mjs)/g)].map((m) => join(HOOKS, m[1]))))];

// Files a program loads by the path its config names (L235): each with the program and its exact import call, so a
// row whose call is gone from its loader fails, and every such call in production code needs a row.
export const CONFIG_ENTRIES = Object.freeze([
  { file: 'wiring/dispatcher-wiring.mjs', loader: 'modules/M11-dispatcher/main.mjs', call: 'import(pathToFileURL(config.wiring).href)' },
  { file: 'wiring/robot-wiring.mjs', loader: 'wiring/robot-main.mjs', call: 'import(pathToFileURL(config.wiring).href)' },
  { file: 'modules/M4-workshop/launcher/review-wiring.mjs', loader: 'modules/M4-workshop/launcher/review-runner-main.mjs', call: 'import(pathToFileURL(c.wiring).href)' },
  // No file yet: check 12's budget module is written when its inputs exist (L83 M-3).
  { file: null, loader: 'modules/M4-workshop/launcher/review-runner-main.mjs', call: 'import(pathToFileURL(c.budget).href)', why: 'L83 M-3: check 12 budget module not written yet' },
]);

const ENTRIES = [...FILES.filter((f) => isEntry(SRC.get(f))), ...HOOK_ENTRIES,
  ...CONFIG_ENTRIES.filter((e) => e.file).map((e) => join(ORCH, e.file))];

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

const unreachedFiles = (reach) => FILES.map(rel)
  .filter((r) => (r.startsWith('modules' + sep) || r.startsWith('shared' + sep)) && !isFixture(r) && !reach.has(join(ORCH, r)));

test('L234: every production file is reached from an entry point, or its folder is on UNWIRED_FILES with its exact count', () => {
  const left = unreachedFiles(reachable());
  const problems = [];
  const counted = Object.fromEntries(Object.keys(UNWIRED_FILES).map((k) => [k, []]));
  for (const r of left) {
    const row = Object.keys(UNWIRED_FILES).find((k) => r.split(sep).join('/').startsWith(k));
    if (row) counted[row].push(r); else problems.push(`${r}: no entry point reaches it; wire it, or name its folder on UNWIRED_FILES with its row`);
  }
  for (const [k, { files }] of Object.entries(UNWIRED_FILES)) {
    if (counted[k].length !== files) problems.push(`${k}: ${counted[k].length} file(s) not reached, UNWIRED_FILES says ${files}${counted[k].length ? ` (${counted[k].join(', ')})` : '; take the row off'}`);
  }
  assert.deepEqual(problems, []);
});

test('L234: every UNWIRED_FILES row is a folder that exists and names a row or lead call', () => {
  for (const [k, { files, why }] of Object.entries(UNWIRED_FILES)) {
    assert.ok(k.endsWith('/') && existsSync(join(ORCH, k)), `${k} is a folder of orchestrate/`);
    assert.ok(Number.isInteger(files) && files > 0, `${k}: a positive count`);
    assert.match(why, /\b(L\d+|R-0b-\d+)\b/, `${k}: say which row or lead call runs it`);
  }
});

test('L234: the hook and config entry points are real', () => {
  assert.ok(HOOK_ENTRIES.length >= 5, 'the role templates name the hooks');
  for (const h of HOOK_ENTRIES) assert.ok(SRC.has(h), `${rel(h)}, named by a role template, is a hook file`);
  for (const e of CONFIG_ENTRIES) {
    const src = SRC.get(join(ORCH, e.loader));
    assert.ok(src, `${e.loader} exists`);
    assert.ok(src.replace(/\s+/g, '').includes(e.call.replace(/\s+/g, '')), `${e.loader} still makes the call ${e.call}`);
    if (e.file) assert.ok(SRC.has(join(ORCH, e.file)), `${e.file} exists`);
    else assert.match(e.why ?? '', /\b(L\d+|R-0b-\d+)\b/, `${e.call}: no file yet, so name the row that writes it`);
  }
});

test('L235: every config-named import in production code has a CONFIG_ENTRIES row', () => {
  const rows = new Set(CONFIG_ENTRIES.map((e) => `${e.loader}|${e.call.replace(/\s+/g, '')}`));
  const missing = [];
  for (const [f, src] of SRC) {
    for (const m of strip(src).matchAll(/import\(\s*pathToFileURL\([^)]*\)\.href\s*\)/g)) {
      if (!rows.has(`${rel(f)}|${m[0].replace(/\s+/g, '')}`)) missing.push(`${rel(f)}: ${m[0]}`);
    }
  }
  assert.deepEqual(missing, [], 'a program loads a config-named file wired.test does not know; add it to CONFIG_ENTRIES');
});
