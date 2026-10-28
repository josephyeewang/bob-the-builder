#!/usr/bin/env node
// check-bar.mjs — Bob Phase Gate item 12: the done-criteria ("the bar") are frozen when a phase
// starts. Moving them later is allowed, but never silently.
//
// Idea ported from pullboard's frozen acceptance bar (pullboard-dev/pullboard @ 1694efbc, MIT,
// Copyright (c) 2026 Corey Olson — third_party/pullboard/LICENSE). Written for Bob by Joe Wang,
// 2026-10; zero dependencies.
//
// The phase report (templates/phase-report.md) carries an "Acceptance Bar" block:
//
//   <!-- bar:start -->
//   - criterion one
//   - criterion two
//   <!-- bar:end -->
//   bar-sha256: <64 hex characters, written by --stamp at phase start>
//   - 2026-10-27 bar changed because <reason> → bar-sha256: <new 64 hex>   (zero or more)
//
// The fingerprint is sha256 of the text between the markers, with line endings normalised,
// trailing spaces trimmed and blank lines dropped (so re-wrapping whitespace is not a "change").
//
// Usage:
//   node scripts/check-bar.mjs --stamp <report.md>            phase start: record the fingerprint
//   node scripts/check-bar.mjs <report.md>                    phase gate: verify (exit 0 / 1)
//   node scripts/check-bar.mjs --change "<reason>" <report.md>  record a dated, explained change
//
// Exit: 0 = bar unchanged (or every change explained) · 1 = REFUSED · 2 = cannot run.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const START = '<!-- bar:start -->';
const END = '<!-- bar:end -->';
const STAMP = /^\s*(?:[-*]\s*)?bar-sha256:\s*`?([0-9a-f]{64}|UNSET)`?\s*$/mu;
const CHANGE_LINE = /bar changed because/iu;
const CHANGE = /^\s*[-*]\s*(\d{4}-\d{2}-\d{2})\s+bar changed because\s+(.+?)\s*(?:→|->)\s*bar-sha256:\s*`?([0-9a-f]{64})`?\s*$/iu;

function fail(code, message) {
  process.stderr.write(`check-bar: ${message}\n`);
  process.exit(code);
}

export function barText(report) {
  const from = report.indexOf(START);
  const to = report.indexOf(END);
  if (from < 0 || to < 0 || to < from) return null;
  return report.slice(from + START.length, to)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}

export function fingerprint(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  let mode = 'check';
  let reason = '';
  let file = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--stamp') mode = 'stamp';
    else if (args[i] === '--change') { mode = 'change'; reason = args[i + 1] ?? ''; i += 1; }
    else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split('\n')
        .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n');
      process.exit(0);
    } else if (!file) file = args[i];
    else fail(2, `unexpected argument "${args[i]}"`);
  }
  if (!file) fail(2, 'give the phase report path (try --help)');
  if (!existsSync(file)) fail(2, `${file} does not exist`);
  const report = readFileSync(file, 'utf8');
  const bar = barText(report);
  if (bar === null) fail(2, `${file} has no "${START}" … "${END}" block — copy the Acceptance Bar block from templates/phase-report.md`);
  if (bar.length === 0) fail(1, 'REFUSED — the bar block is empty; write the done-criteria before stamping');
  const current = fingerprint(bar);
  const stamp = STAMP.exec(report);

  if (mode === 'stamp') {
    if (!stamp) fail(2, `${file} has no "bar-sha256:" line to fill in`);
    if (stamp[1] !== 'UNSET') fail(1, `REFUSED — the bar was already stamped (${stamp[1].slice(0, 12)}…). To change it, use --change "<reason>".`);
    writeFileSync(file, report.replace(STAMP, (line) => line.replace('UNSET', current)));
    process.stdout.write(`check-bar: stamped ${file}\n  bar-sha256: ${current}\n`);
    return;
  }

  if (!stamp || stamp[1] === 'UNSET') fail(1, 'REFUSED — the bar was never stamped at phase start (run with --stamp when the phase begins)');

  // Change lines are read only from the stamp line down to the next heading, so explanatory text
  // elsewhere in the report that mentions the phrase is never mistaken for a change record.
  const allLines = report.split(/\r?\n/u);
  const stampAt = allLines.findIndex((line) => STAMP.test(line));
  const changeLines = [];
  for (let i = stampAt + 1; i < allLines.length && !/^\s*#/u.test(allLines[i]); i += 1) {
    if (CHANGE_LINE.test(allLines[i])) changeLines.push(allLines[i]);
  }
  const changes = [];
  for (const line of changeLines) {
    const parsed = CHANGE.exec(line);
    if (!parsed) fail(1, `REFUSED — malformed change line (needs "- YYYY-MM-DD bar changed because <reason> → bar-sha256: <hash>"):\n  ${line.trim()}`);
    if (parsed[2].replace(/[.…\s]/gu, '').length === 0) fail(1, `REFUSED — a bar change must say WHY:\n  ${line.trim()}`);
    changes.push({ date: parsed[1], reason: parsed[2], sha: parsed[3] });
  }
  const recorded = changes.length ? changes[changes.length - 1].sha : stamp[1];

  if (mode === 'change') {
    if (reason.trim().length === 0) fail(2, '--change needs a reason in quotes');
    if (recorded === current) fail(1, 'REFUSED — the bar has not changed, so there is nothing to explain');
    const line = `- ${today()} bar changed because ${reason.trim()} → bar-sha256: ${current}`;
    const after = report.replace(STAMP, (match) => {
      const lastChange = changeLines.length ? changeLines[changeLines.length - 1] : null;
      return lastChange ? match : `${match}\n${line}`;
    });
    const updated = changeLines.length
      ? after.replace(changeLines[changeLines.length - 1], `${changeLines[changeLines.length - 1]}\n${line}`)
      : after;
    writeFileSync(file, updated);
    process.stdout.write(`check-bar: recorded change in ${file}\n  ${line}\n`);
    return;
  }

  if (recorded !== current) {
    fail(1, `REFUSED — the done-criteria changed since they were recorded (${recorded.slice(0, 12)}… → now ${current.slice(0, 12)}…) and no dated "bar changed because…" line explains it.\n  Fix: node scripts/check-bar.mjs --change "<why the bar moved>" ${file}`);
  }
  const note = changes.length ? ` (${changes.length} explained change${changes.length > 1 ? 's' : ''}, latest ${changes[changes.length - 1].date})` : ' (unchanged since phase start)';
  process.stdout.write(`check-bar: OK — bar matches ${current.slice(0, 12)}…${note}\n`);
}

main();
