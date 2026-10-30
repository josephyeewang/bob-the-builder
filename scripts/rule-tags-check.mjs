#!/usr/bin/env node
// rule-tags-check.mjs — Bob Rule 33 (Bob dogfoods Bob — an unenforced rule is a wish): the core's rule index says how
// each rule is enforced. A tag that claims a script must name one that exists and actually runs.
//
// WHY. The index tags each rule PROSE (nothing enforces it), SCRIPT, HOOK or GATE. The honest count of PROSE rules
// is the point of the tags, and it is only honest if the other tags are true. Until 2026-10-29 (D-033) nothing
// checked that a SCRIPT rule's text names its script, that the script exists, or that anything ever runs it.
//
// CHECKS (on the Bob repo at --root; default: the folder above this script):
//   1. every rule the index tags SCRIPT, HOOK or GATE names at least one Bob script in its rules.md text
//      (scripts/…, or templates/….mjs), and every script it names exists;
//   2. every script so named is run by Bob's CI (.github/workflows/) or its self-test (scripts/selftest-gate-scripts.sh)
//      — a check nothing runs is a wish with a file name;
//   3. where a rule in rules.md carries its own tag ("31. `PROSE` — …"), it matches the index.
// It ends by printing how many rules are still written-only.
//
// Usage: node scripts/rule-tags-check.mjs [--root DIR]
// Exit: 0 = every tag is true · 1 = a tag claims an enforcer that is missing or never run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const rd = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');
const problems = [];

const index = new Map();
for (const l of rd('build-protocol-core.md').split('\n')) {
  const m = l.match(/^\| (\d+) \|.*\|\s*([^|]*`(?:PROSE|SCRIPT|HOOK|GATE)`[^|]*)\|\s*\d+\s*\|\s*$/);
  if (m) index.set(Number(m[1]), m[2].trim());
}
if (!index.size) {
  console.log('rule-tags-check: no rule index rows found in build-protocol-core.md');
  process.exit(1);
}

const body = new Map();
const parts = rd('rules.md').split(/^<!-- Rule (\d+) -->$/m);
for (let i = 1; i < parts.length; i += 2) body.set(Number(parts[i]), parts[i + 1].split(/^## /m)[0]);

const runners = [
  ...fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => rd(`.github/workflows/${f}`)),
  rd('scripts/selftest-gate-scripts.sh'),
].join('\n');
const SCRIPT_REF = /(?:~\/\.claude\/skills\/bob\/\.\.\/)?((?:scripts\/[\w./-]+|templates\/[\w.-]+)\.(?:mjs|js|sh|py))(?![\w.])/g;

let prose = 0;
for (const [n, tag] of index) {
  const enforced = /`(SCRIPT|HOOK|GATE)`/.test(tag);
  if (!enforced) prose++;
  const text = body.get(n) ?? '';
  const own = text.match(new RegExp(`^${n}\\. (\`[A-Z]+\`)`, 'm'))?.[1];
  if (own && !tag.startsWith(own)) problems.push(`Rule ${n}: rules.md tags it ${own} but the index says ${tag}`);
  if (!enforced) continue;
  const named = [...new Set([...text.matchAll(SCRIPT_REF)].map((m) => m[1]))];
  if (!named.length) { problems.push(`Rule ${n} is tagged ${tag} but its text in rules.md names no script`); continue; }
  for (const s of named) {
    if (!fs.existsSync(path.join(ROOT, s))) { problems.push(`Rule ${n} names ${s}, which does not exist`); continue; }
    if (!runners.includes(path.basename(s))) problems.push(`Rule ${n} names ${s}, but neither CI nor the self-test ever runs it`);
  }
}

if (problems.length) {
  console.log(`rule-tags-check: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`rule-tags-check: OK — every enforcement tag names a script that exists and runs; ${prose} of ${index.size} rules are still written-only (PROSE)`);
