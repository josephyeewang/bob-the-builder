#!/usr/bin/env node
// phase-report-check.mjs — Bob Rule 4 (reconciliation is non-optional) and Phase Gate item 13: a phase report is
// not finished while a required section is missing, empty, or still holds the template's placeholder text.
//
// WHY. Rule 4 says every build phase reconciles, and "if there's nothing to reconcile, explicitly state 'No
// divergences found.' Never silently skip it." The template marks the sections that must always be there with [A].
// Until 2026-10-29 (D-033) nothing checked either: a report could skip "Spec Deviations" or leave
// "- [list EVERY difference from specs …]" in place and the phase gate still passed, because a written rule
// nobody runs is a wish (Rule 33). This compares the report with the template it was made from.
//
// CHECKS (the template is read from Bob's own templates/phase-report.md, so the list of sections has one home):
//   1. every [A] section of the template has a heading in the report (omission is a failure condition);
//   2. every [A] or [C] section present in the report has text of its own, not only lines copied from the template
//      (a skipped [C] section says "N/A — reason");
//   3. no line in the report is still the template's placeholder line, e.g. "- [list everything built — …]".
// Headings match on their name, at level 2–4, numbered or not, with any status mark after it: "### [A] Built",
// "## Built", "### 1. Built" and "### Built ✅" are all "Built". A section line that starts "N/A", "None" or "No
// divergences found" always counts as the section's own text.
//
// --abbreviated checks the short report the Minimum Viable Process allows ("Full Phase Report — use abbreviated"):
// only Built, Spec Deviations, Validation Results, Hot Path Results and Regression Check are required.
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/phase-report-check.mjs" <phase-report.md> [--abbreviated] [--template FILE]
// Exit: 0 = complete · 1 = REFUSED (each problem listed) · 2 = cannot run (no report, or the template is missing).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ti = args.indexOf('--template');
const ABBREVIATED = args.includes('--abbreviated');
const TEMPLATE = ti >= 0 ? args[ti + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'phase-report.md');
const report = args.filter((a, i) => !a.startsWith('--') && (ti < 0 || i !== ti + 1))[0];

function cannot(message) {
  process.stderr.write(`phase-report-check: ${message}\n`);
  process.exit(2);
}
if (!report) cannot('usage: phase-report-check.mjs <phase-report.md> [--template FILE]');
if (!fs.existsSync(report)) cannot(`no report at ${report} — nothing to check is not a pass (Rule 29)`);
if (!fs.existsSync(TEMPLATE)) cannot(`template not found at ${TEMPLATE}`);

// "### [A] Global Invariant Check *(use …)*" → { kind: 'A', name: 'global invariant check' }
// Any of "## Built", "### 1. Built", "### Built ✅" or "#### [A] Built (phase 3)" is the section "built".
function heading(line) {
  const m = line.match(/^#{2,4}\s+(?:\d+[.)]\s+)?(?:\[([ACO])\]\s+)?(.+?)\s*$/);
  if (!m) return null;
  const name = m[2].split(/\s+\(|\s+—|\s+\*|\s+-\s|\s*:/)[0].replace(/[*_`]/g, '').replace(/[^\p{L}\p{N}/ -]+/gu, '').trim().toLowerCase();
  return { kind: m[1] ?? null, name };
}
// A report heading matches a template section when its name starts with the template's ("built" ⊂ "built so far").
const same = (mine, tpl) => mine === tpl || mine.startsWith(`${tpl} `);

// A placeholder line is a list or heading line whose text is a [bracketed instruction], not a link, a tick box or a marker.
const PLACEHOLDER = /\[(?![ xX]\])(?![ACO]\])[^\]]*[a-zA-Z][^\]]*\](?!\()/;
const norm = (l) => l.trim().replace(/\s+/g, ' ');

function sections(text) {
  const out = [];
  let cur = null;
  text.split('\n').forEach((line, i) => {
    const h = heading(line);
    if (h) { cur = { ...h, line: i + 1, body: [] }; out.push(cur); return; }
    if (/^#\s/.test(line)) { cur = null; return; }
    if (cur) cur.body.push(line);
  });
  return out;
}

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
const tplSections = sections(tpl);
const kindOf = new Map(tplSections.map((s) => [s.name, s.kind]));
const tplLines = new Map(tplSections.map((s) => [s.name, new Set(s.body.map(norm))]));
const placeholders = new Set();
for (const l of tpl.split('\n')) if (/^\s*(?:[-*]|\d+\.|#{1,3})\s/.test(l) && PLACEHOLDER.test(l)) placeholders.add(norm(l));

const text = fs.readFileSync(report, 'utf8');
const mine = sections(text);
const problems = [];

// --abbreviated: the short report the Minimum Viable Process allows under time pressure keeps only the sections it
// lists as never skipped (what was built, what diverged, whether it passed, hot paths, regressions).
const SHORT = ['built', 'spec deviations', 'validation results', 'hot path results', 'regression check'];
const required = tplSections.filter((s) => s.kind === 'A' && (!ABBREVIATED || SHORT.includes(s.name)));
for (const s of required)
  if (!mine.some((m) => same(m.name, s.name)))
    problems.push(`missing the "${s.name}" section — the template marks it [A], always required${ABBREVIATED ? ' (even in a short report)' : ''}`);

for (const m of mine) {
  const tplName = [...kindOf.keys()].find((n) => same(m.name, n));
  const kind = m.kind ?? kindOf.get(tplName);
  if (kind !== 'A' && kind !== 'C') continue;
  // Text of its own: not blank, not an italic instruction, and not a line copied unchanged from the template's section.
  // A line saying the section does not apply ("N/A — …", "None") always counts, even when the template suggests it.
  const says = (l) => /^\s*(?:[-*]\s*)*\**\s*(N\/A|None|No divergences found)\b/i.test(l);
  const own = m.body.filter((l) => l.trim() && (says(l) || (!/^\s*\*[^*].*\*\s*$/.test(l) && !placeholders.has(norm(l)) && !tplLines.get(tplName)?.has(norm(l)))));
  if (!own.length)
    problems.push(`line ${m.line}: the "${m.name}" section has nothing of its own${kind === 'C' ? ' — if it does not apply, write "N/A — <reason>"' : ''}${m.name === 'spec deviations' ? ' — if there were none, write "None" (Rule 4: "No divergences found")' : ''}`);
}

text.split('\n').forEach((l, i) => {
  if (placeholders.has(norm(l))) problems.push(`line ${i + 1}: still the template's placeholder: ${norm(l).slice(0, 90)}`);
});

if (problems.length) {
  console.log(`phase-report-check: REFUSED — ${report} is not finished (${problems.length} problem(s))`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`phase-report-check: OK — ${report} has every required section filled in`);
