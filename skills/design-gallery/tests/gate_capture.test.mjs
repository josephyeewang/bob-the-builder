// Self-test for ../scripts/gate-capture.mjs. The pure checks run anywhere; the browser cases need Playwright with
// Chromium: set GATE_TOOLS to a folder whose node_modules holds playwright (Bob's CI job does), else they are skipped.
//   GATE_TOOLS=/path/to/tools node --test skills/design-gallery/tests/gate_capture.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, parseArgs } from '../scripts/gate-capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'gate-capture.mjs');
const FIXTURE = join(HERE, 'gate-fixture.html');
const TOOLS = process.env.GATE_TOOLS;

test('judge: clean numbers pass; each planted fault is named', () => {
  const ok = { drawnFonts: { Lora: 120 }, lockedFonts: ['Lora'], lcpMs: 900, lcpBudgetMs: 2500, bytes: 50_000, maxKb: 500 };
  assert.deepEqual(judge(ok), []);
  assert.match(judge({ ...ok, drawnFonts: { Lora: 100, 'Times New Roman': 20 } }).join(), /fonts: drawn Times New Roman/);
  assert.match(judge({ ...ok, lcpMs: 4000 }).join(), /paint: .*4000 ms/);
  assert.match(judge({ ...ok, lcpMs: 0 }).join(), /no main-content paint time/);
  assert.match(judge({ ...ok, bytes: 900_000 }).join(), /weight: .* over the 500 KB budget/);
  assert.deepEqual(judge({ ...ok, lockedFonts: null, maxKb: null }), []);
});

test('parseArgs: refuses a missing page, a missing --out and a bad number', () => {
  assert.throws(() => parseArgs(['--out', 'x']), /give the page/);
  assert.throws(() => parseArgs(['p.html']), /--out DIR is required/);
  assert.throws(() => parseArgs(['p.html', '--out', 'x', '--lcp-ms', 'soon']), /--lcp-ms must be a number/);
});

function capture(extra) {
  const out = mkdtempSync(join(tmpdir(), 'gate-'));
  const args = [SCRIPT, FIXTURE, '--out', out, '--tools', TOOLS, '--stops', '.stop', '--settle-ms', '100', ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240_000 });
  const report = r.status === 0 || r.status === 1 ? JSON.parse(readFileSync(join(out, 'gate-report.json'), 'utf8')) : null;
  return { ...r, out, report };
}

test('browser: the clean fixture passes and every width, stop and reduced-motion view is captured', { skip: !TOOLS && 'GATE_TOOLS not set' }, () => {
  const r = capture(['--lcp-ms', '10000', '--max-kb', '200']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pngs = readdirSync(r.out).filter((f) => f.endsWith('.png'));
  for (const w of [1440, 1024, 768, 390]) assert.ok(pngs.some((f) => f.startsWith(`w${w}-s`)), `no capture at ${w}px`);
  for (const w of [1440, 390]) assert.ok(pngs.some((f) => f.startsWith(`rm-w${w}-s`)), `no reduced-motion capture at ${w}px`);
  assert.ok(pngs.filter((f) => f.startsWith('w1440-')).length >= 3, 'expected one capture per section at 1440px');
  assert.ok(Object.keys(r.report.fonts.drawn).length >= 1, 'no drawn font was read from the browser');
  assert.ok(r.report.phone.lcpMs > 0 && r.report.phone.bytes > 0, 'phone paint time and weight were not measured');
});

test('browser: a planted font, paint and weight fault each fail the page', { skip: !TOOLS && 'GATE_TOOLS not set' }, () => {
  const r = capture(['--fonts', 'Planted Missing Face', '--lcp-ms', '1', '--max-kb', '0.1']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const all = r.report.failures.join('\n');
  assert.match(all, /fonts: drawn .* not in the locked fonts \(Planted Missing Face\)/);
  assert.match(all, /paint: main content painted at/);
  assert.match(all, /weight: .* over the 0\.1 KB budget/);
});
