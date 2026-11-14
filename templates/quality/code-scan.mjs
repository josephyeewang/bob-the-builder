#!/usr/bin/env node
// code-scan.mjs — the dead-code scan (Knip) and the duplicate-code scan (jscpd), with a baseline: the findings the
// code already had when the scan was adopted are written once to .quality/code-scan-baseline.json, and only NEW
// findings fail. Fixing an old finding never fails; it just leaves a stale baseline line (rewrite the baseline to drop it).
//
//   node scripts/quality/code-scan.mjs                     fail on any finding not in the baseline
//   node scripts/quality/code-scan.mjs --update-baseline   write today's findings as the baseline (commit it)
//
// Fail closed: a tool that is missing, exits with an error or writes output that can't be read fails the scan, and so
// does a missing or unreadable baseline. Knip and jscpd come from the product's node_modules (the check job installs
// the pinned versions); nothing is downloaded here.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMain } from './quality-lib.mjs';

export const BASELINE_PATH = '.quality/code-scan-baseline.json';
const JSCPD_IGNORE = '**/node_modules/**,**/.next/**,**/dist/**,**/build/**,**/coverage/**,**/.quality/**,**/.git/**';

// Knip's JSON: { issues: [{ file, <type>: [ {name} | [{name}...] ] }] }. One key per finding: type, file and name,
// so a finding keeps its key when lines move.
export function knipKeys(report) {
  if (!report || !Array.isArray(report.issues)) throw new Error('Knip output has no "issues" list');
  const keys = [];
  for (const issue of report.issues) {
    if (typeof issue.file !== 'string') throw new Error('a Knip issue has no file');
    for (const [type, items] of Object.entries(issue)) {
      if (type === 'file' || !Array.isArray(items)) continue;
      for (const item of items) {
        const name = Array.isArray(item) ? item.map((i) => i.name).join('+') : item?.name;
        if (typeof name !== 'string') throw new Error(`a Knip ${type} finding in ${issue.file} has no name`);
        keys.push(`${type}:${issue.file}:${name}`);
      }
    }
  }
  return [...new Set(keys)].sort();
}

// jscpd's JSON: { duplicates: [{ firstFile: {name}, secondFile: {name} }] }. Counted per pair of files, so a clone
// keeps its key when lines move; a pair with more clones than its baseline count has a new one.
export function duplicateCounts(report) {
  if (!report || !Array.isArray(report.duplicates)) throw new Error('jscpd output has no "duplicates" list');
  const counts = {};
  for (const d of report.duplicates) {
    const a = d?.firstFile?.name, b = d?.secondFile?.name;
    if (typeof a !== 'string' || typeof b !== 'string') throw new Error('a jscpd duplicate has no file names');
    const key = [a, b].sort().join(' | ');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function checkBaseline(baseline) {
  if (!baseline || !Array.isArray(baseline.deadCode) || !baseline.duplicates || typeof baseline.duplicates !== 'object' ||
      Object.values(baseline.duplicates).some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error(`${BASELINE_PATH} must hold "deadCode" (a list) and "duplicates" (file pair → count)`);
  }
  return baseline;
}

export function newFindings(found, baseline) {
  const known = new Set(baseline.deadCode);
  const out = found.deadCode.filter((k) => !known.has(k)).map((k) => `dead code: ${k}`);
  for (const [pair, n] of Object.entries(found.duplicates)) {
    const was = baseline.duplicates[pair] ?? 0;
    if (n > was) out.push(`duplicated code: ${pair} (${n} clone${n > 1 ? 's' : ''}, baseline ${was})`);
  }
  return out;
}

function bin(name, cwd) {
  const p = join(cwd, 'node_modules', '.bin', name);
  if (!existsSync(p)) throw new Error(`${name} is not installed; the check job installs it (templates/quality/quality-check.yml)`);
  return p;
}

export function runScans(cwd = process.cwd()) {
  const knip = spawnSync(bin('knip', cwd), ['--reporter', 'json', '--no-progress'], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (knip.error || ![0, 1].includes(knip.status)) {
    throw new Error(`Knip failed (exit ${knip.status ?? knip.error?.message}): ${(knip.stderr || knip.stdout || '').slice(0, 2000)}`);
  }
  let knipReport;
  try { knipReport = JSON.parse(knip.stdout); } catch { throw new Error(`Knip's output is not JSON: ${knip.stdout.slice(0, 500)}`); }

  const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
  try {
    const jscpd = spawnSync(bin('jscpd', cwd), ['.', '--reporters', 'json', '--output', out, '--silent', '--ignore', JSCPD_IGNORE],
      { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (jscpd.error || jscpd.status !== 0) {
      throw new Error(`jscpd failed (exit ${jscpd.status ?? jscpd.error?.message}): ${(jscpd.stderr || jscpd.stdout || '').slice(0, 2000)}`);
    }
    let dupReport;
    try { dupReport = JSON.parse(readFileSync(join(out, 'jscpd-report.json'), 'utf8')); } catch (e) {
      throw new Error(`jscpd wrote no readable report: ${e.message}`);
    }
    return { deadCode: knipKeys(knipReport), duplicates: duplicateCounts(dupReport) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function main(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const update = argv.includes('--update-baseline');
  if (argv.some((a) => a !== '--update-baseline')) { log(`FAIL unknown option: ${argv.join(' ')}`); return 2; }
  let found;
  try { found = runScans(cwd); } catch (e) { log(`FAIL code scan could not run: ${e.message}`); return 1; }
  const path = join(cwd, BASELINE_PATH);
  if (update) {
    writeFileSync(path, `${JSON.stringify({
      _doc: 'Findings the code had when the dead/duplicate scan was adopted (templates/quality/code-scan.mjs). Only new ones fail. Rewrite with --update-baseline only to drop fixed ones.',
      ...found,
    }, null, 2)}\n`);
    log(`wrote ${BASELINE_PATH}: ${found.deadCode.length} dead-code findings, ${Object.keys(found.duplicates).length} duplicated file pairs`);
    return 0;
  }
  let baseline;
  try { baseline = checkBaseline(JSON.parse(readFileSync(path, 'utf8'))); } catch (e) {
    log(`FAIL no usable baseline (${e.code === 'ENOENT' ? `${BASELINE_PATH} is missing; run with --update-baseline once and commit it` : e.message})`);
    return 1;
  }
  const fresh = newFindings(found, baseline);
  if (fresh.length === 0) { log(`PASS code scan: no new dead or duplicated code (${baseline.deadCode.length} older findings stay in the baseline)`); return 0; }
  log('FAIL code scan: new findings');
  for (const f of fresh) log(`      ${f}`);
  return 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
