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
//   3. where a rule in rules.md carries its own tag ("31. `PROSE` — …"), the whole tag matches the index.
// "Run" means a line of CI or the self-test calls it (node/bash/sh/python), directly or through a variable;
// a mention in a comment does not count.
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

// Lines that run something: comments are dropped, so naming a script in a comment does not count as running it.
const runners = [
  ...fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => rd(`.github/workflows/${f}`)),
  rd('scripts/selftest-gate-scripts.sh'),
].join('\n').split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*(printf|echo|cat)\b/.test(l));
// A script runs when a line calls it: `node scripts/x.mjs`, `bash "$HERE/x.sh"`, `python3 x.py`, or `X="$HERE/x.mjs"` then `node "$X"`.
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The script's own path (scripts/x.mjs, ../templates/x.mjs) or, inside the self-test, "$HERE/x.mjs" for one in scripts/.
// "foo-x.mjs" or "templates/x.mjs" is a different file and does not count as running scripts/x.mjs.
const runs = (rel) => {
  const forms = [escRe(rel)];
  if (rel.startsWith('scripts/')) forms.push(`\\$\\{?HERE\\}?"?/${escRe(rel.slice('scripts/'.length))}`);
  const P = `(?:${forms.join('|')})(?=$|[\\s"';)])`;
  const call = (target) => new RegExp(`\\b(node|bash|sh|python3?)\\s+(--\\S+\\s+)*["']?(?:[^\\s"']*/)?${target}`);
  if (runners.some((l) => call(P).test(l) || call(`[^\\s"']*${P}`).test(l))) return true;
  const vars = runners.map((l) => l.match(new RegExp(`^\\s*([A-Z_][A-Z0-9_]*)=["']?(?:[^\\s"']*/)?${P}`))?.[1]).filter(Boolean);
  return vars.some((v) => runners.some((l) => new RegExp(`\\b(node|bash|sh|python3?)\\s+["']?\\$\\{?${v}\\b`).test(l)));
};
const SCRIPT_REF = /(?:~\/\.claude\/skills\/bob\/\.\.\/)?((?:scripts\/[\w./-]+|templates\/[\w.-]+)\.(?:mjs|js|sh|py))(?![\w.])/g;

let prose = 0;
for (const [n, tag] of index) {
  const enforced = /`(SCRIPT|HOOK|GATE)`/.test(tag);
  if (!enforced) prose++;
  const text = body.get(n) ?? '';
  // Compare the whole tag, ignoring emphasis marks: "`SCRIPT` *(in part)*" in rules.md = "`SCRIPT` (in part)" in the index.
  const ownFull = text.match(new RegExp(`^${n}\\. ((?:\`[A-Z]+\`|\\*?\\([^)]*\\)\\*?|\\s)+) —`, 'm'))?.[1];
  const flat = (t) => t.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  if (ownFull && flat(ownFull) !== flat(tag)) problems.push(`Rule ${n}: rules.md tags it ${flat(ownFull)} but the index says ${flat(tag)}`);
  if (!enforced) continue;
  const named = [...new Set([...text.matchAll(SCRIPT_REF)].map((m) => m[1]))];
  if (!named.length) { problems.push(`Rule ${n} is tagged ${tag} but its text in rules.md names no script`); continue; }
  for (const s of named) {
    if (!fs.existsSync(path.join(ROOT, s))) { problems.push(`Rule ${n} names ${s}, which does not exist`); continue; }
    if (!runs(s)) problems.push(`Rule ${n} names ${s}, but neither CI nor the self-test ever runs it`);
  }
}

if (problems.length) {
  console.log(`rule-tags-check: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`rule-tags-check: OK — every enforcement tag names a script that exists and runs; ${prose} of ${index.size} rules have no script at all (some others are checked only in part)`);
