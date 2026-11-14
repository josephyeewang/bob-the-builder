#!/usr/bin/env node
// quality-tools-e2e.mjs — prove Bob's quality checks (templates/quality/) on a real test product with the real tools:
// each planted fault must fail its check, and the clean product must pass. Rule 28 applied to Bob's own checks.
//
//   node scripts/quality-tools-e2e.mjs --tools DIR
//
// DIR holds node_modules with the pinned playwright, axe-core, knip and jscpd, and Chromium installed for that
// playwright (Bob's CI job "Bob's quality tools prove their planted cases" sets it up). Each case copies
// fixtures/quality-app into a fresh temp folder, adopts the checks the way a product does (templates/quality/README.md),
// plants one fault and runs one command. The product listens on 127.0.0.1:4173, so the cases run one at a time.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BOB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(BOB, 'fixtures/quality-app');
const TEMPLATES = join(BOB, 'templates/quality');
// What a product copies (templates/quality/README.md, "Adopt").
export const ADOPT = {
  'scripts/quality': ['quality-lib.mjs', 'run.mjs', 'smoke.mjs', 'visual-check.mjs', 'png.mjs', 'a11y-scan.mjs', 'speed-budget.mjs', 'code-scan.mjs', 'live-figures-check.mjs'],
  '.github/workflows': ['quality-check.yml'],
};

const toolsArg = process.argv.indexOf('--tools');
const TOOLS = toolsArg > 0 ? resolve(process.argv[toolsArg + 1] ?? '') : null;
if (!TOOLS || !existsSync(join(TOOLS, 'node_modules'))) {
  console.log('usage: node scripts/quality-tools-e2e.mjs --tools DIR   (DIR/node_modules holds the pinned tools)');
  process.exit(2);
}

const ROOT = mkdtempSync(join(tmpdir(), 'bob-quality-e2e-'));
let n = 0, failed = 0;

function product({ references = null, baseline = null } = {}) {
  const dir = join(ROOT, `p${++n}`);
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [dest, files] of Object.entries(ADOPT)) {
    mkdirSync(join(dir, dest), { recursive: true });
    for (const f of files) cpSync(join(TEMPLATES, f), join(dir, dest, f));
  }
  symlinkSync(join(TOOLS, 'node_modules'), join(dir, 'node_modules'), 'dir');
  if (references) cpSync(references, join(dir, '.quality/reference'), { recursive: true });
  if (baseline) cpSync(baseline, join(dir, '.quality/code-scan-baseline.json'));
  return dir;
}

// Replace one exact piece of text; a plant that changes nothing would make its case pass for the wrong reason.
function plant(dir, file, from, to) {
  const p = join(dir, file);
  const text = readFileSync(p, 'utf8');
  if (!text.includes(from)) throw new Error(`plant failed: "${from}" not found in ${file}`);
  writeFileSync(p, text.replace(from, to));
}

function run(dir, args) {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function expect(name, dir, args, wantCode, pattern) {
  const { code, out } = run(dir, args);
  const ok = code === wantCode && (!pattern || pattern.test(out));
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failed++;
    console.log(`        exit ${code}, wanted ${wantCode}; pattern ${pattern ?? 'none'}`);
    console.log(out.split('\n').map((l) => `        | ${l}`).join('\n'));
  }
  return out;
}

const RUN = 'scripts/quality/run.mjs';
const SCAN = 'scripts/quality/code-scan.mjs';
const FIG = 'scripts/quality/live-figures-check.mjs';

try {
  console.log('Bob quality tools, end to end on fixtures/quality-app');

  // References and baseline come from the clean product, made here so they match this machine's fonts.
  const clean = product();
  expect('a page with no reference image fails the visual check (fail closed)', clean, [RUN, 'visual'], 1, /no reference image/);
  expect('writing reference images from the clean product', clean, [RUN, 'visual', '--update-references'], 0, /wrote reference home\.png/);
  expect('a missing code-scan baseline fails (fail closed)', clean, [SCAN], 1, /baseline/);
  // The adopted check files must add no findings of their own: an adopter should never have to baseline Bob's code.
  expect('writing the code-scan baseline from the clean product: the adopted checks add no findings', clean, [SCAN, '--update-baseline'], 0,
    /0 dead-code findings, 0 duplicated file pairs/);
  const references = join(clean, '.quality/reference');
  const baseline = join(clean, '.quality/code-scan-baseline.json');

  // R-1-57: the check job's build + start with test data, and the "does each page load" smoke.
  expect('clean product: build with the test data', product(), [RUN, 'build'], 0, /PASS build/);
  expect('clean product: smoke, visual, a11y and speed all pass', product({ references }), [RUN, 'smoke', 'visual', 'a11y', 'speed'], 0,
    /PASS smoke[\s\S]*PASS visual[\s\S]*PASS a11y[\s\S]*PASS speed/);
  let p = product();
  plant(p, 'server.mjs', "res.writeHead(200, { 'content-type': 'application/json' });", "res.writeHead(500, { 'content-type': 'application/json' });");
  expect('planted: a route that returns a server error fails the smoke', p, [RUN, 'smoke'], 1, /route \/api\/health \(\/api\/health\) answered 500/);
  p = product();
  plant(p, '.quality/test-data', 'PORT=4173', 'PORT=4999');
  expect('planted: test data that starts the product on the wrong address fails (never "all clear")', p, [RUN, 'smoke'], 1, /nothing answered|exited/);

  // R-1-58: visual check against the reference images.
  p = product({ references });
  plant(p, 'src/pages.mjs', 'h1 { color: #1f4e8c;', 'h1 { color: #b0361d;');
  expect('planted: a screen that drifts from its reference fails the visual check', p, [RUN, 'visual'], 1, /page home drifts from its reference/);
  p = product({ references });
  plant(p, 'src/pages.mjs', 'width: 400px; height: 120px;', 'width: 400px; height: 180px;');
  expect('planted: a layout change fails the visual check', p, [RUN, 'visual'], 1, /page home drifts from its reference/);

  // R-1-59: accessibility scan.
  p = product();
  plant(p, 'src/pages.mjs', '<label for="email">Email</label> ', '');
  expect('planted: a form control with no label fails the accessibility scan', p, [RUN, 'a11y'], 1, /page form: (serious|critical) — label/);

  // R-1-60: speed budget.
  p = product();
  plant(p, 'server.mjs', 'const delayMs = 0;', 'const delayMs = 1500;');
  expect('planted: a page slower than its 1 s budget fails the speed check', p, [RUN, 'speed'], 1, /page home loads in \d+ ms, over its 1000 ms budget/);

  // R-1-61: dead and duplicated code, baselined.
  expect('clean product: no new dead or duplicated code', product({ baseline }), [SCAN], 0, /PASS code scan/);
  p = product({ baseline });
  plant(p, 'src/figures.mjs', 'export function total', 'export function unusedHelper() {\n  return 42;\n}\n\nexport function total');
  expect('planted: a dead export fails the code scan', p, [SCAN], 1, /dead code: exports:src\/figures\.mjs:unusedHelper/);
  p = product({ baseline });
  const block = 'export function priceWithTax(items, rate) {\n  let subtotal = 0;\n  for (const item of items) {\n    if (item.quantity > 0 && item.price > 0) {\n      subtotal += item.quantity * item.price;\n    }\n  }\n  const tax = Math.round(subtotal * rate * 100) / 100;\n  return { subtotal, tax, total: subtotal + tax };\n}\n';
  writeFileSync(join(p, 'src/dup-a.mjs'), block);
  writeFileSync(join(p, 'src/dup-b.mjs'), block.replace('priceWithTax', 'costWithTax'));
  plant(p, 'server.mjs', "import { total } from './src/figures.mjs';",
    "import { total } from './src/figures.mjs';\nimport { priceWithTax } from './src/dup-a.mjs';\nimport { costWithTax } from './src/dup-b.mjs';\nconsole.log(priceWithTax, costWithTax);");
  expect('planted: a duplicated block fails the code scan', p, [SCAN], 1, /duplicated code: src\/dup-a\.mjs \| src\/dup-b\.mjs/);
  // An old finding stays quiet once baselined; only a new one fails.
  p = product();
  plant(p, 'src/figures.mjs', 'export function total', 'export function oldUnused() {\n  return 1;\n}\n\nexport function total');
  expect('baselining the existing code\'s findings', p, [SCAN, '--update-baseline'], 0, /1 dead-code finding/);
  expect('an existing (baselined) finding passes', p, [SCAN], 0, /PASS code scan/);
  plant(p, 'src/figures.mjs', 'export function total', 'export function newUnused() {\n  return 2;\n}\n\nexport function total');
  const out = expect('a new finding next to a baselined one fails, naming only the new one', p, [SCAN], 1, /newUnused/);
  if (/oldUnused/.test(out)) { failed++; console.log('  FAIL  the baselined finding was reported as new'); }

  // R-1-62: the live-figure list.
  expect('the test product\'s filled live-figure list validates', product(), [FIG, '.quality/live-figures.json'], 0, /PASS/);
  p = product();
  plant(p, '.quality/live-figures.json', '"secondWayQuery": "select sum(value) from sample_values"', '"secondWayQuery": ""');
  expect('planted: an empty field fails validation', p, [FIG, '.quality/live-figures.json'], 1, /secondWayQuery is empty/);
  expect('the blank template fails validation (every field empty)', product(), [FIG, join(TEMPLATES, 'live-figures.json')], 1, /figure is empty/);
} catch (e) {
  failed++;
  console.log(`  FAIL  ${e.message}`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} case(s) failed` : '\nall cases passed');
process.exit(failed ? 1 : 0);
