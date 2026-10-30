#!/usr/bin/env node
// recurrence-check.mjs — Bob Rule 31 (the intervention ladder): a class of defect that has been fixed twice may not
// be closed again by writing the rule down (rung 1) or adding a grep-style check (rung 2).
//
// WHY. A field census found a defect class with a standing written rule that recurred ~40 times across six fixes.
// Rule 31's own text named the missing enforcer: "mechanical detection of recurrence — a class name appearing in 2+
// separate fix commits". This is it (D-033). It reads the fix commits' own words, so it needs one habit: a fix
// commit says which class it fixes and which rung closed it, as trailer lines at the end of the message:
//
//     Class: read-error-treated-as-missing
//     Rung: 3            (or anywhere in the message: "closed at rung 3")
//
// CHECK: for every class named in two or more commits, the NEWEST of them must record rung 3 (a fresh-context read
// at the moment the class can come back) or rung 4 (the defect made unrepresentable). Rung 1, rung 2 or no rung =
// REFUSED, listing the commits.
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/recurrence-check.mjs" [DIR] [--since DATE]
// Exit: 0 = every recurring class was closed at rung 3 or 4 · 1 = REFUSED · 2 = cannot run (not a git repo, or no
//       commit carries a "Class:" line yet — nothing to judge is not a pass, Rule 29).

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const si = args.indexOf('--since');
const since = si >= 0 ? args[si + 1] : null;
const DIR = path.resolve(args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1))[0] ?? '.');

function cannot(message) {
  process.stderr.write(`recurrence-check: ${message}\n`);
  process.exit(2);
}

let log;
try {
  const cmd = ['-C', DIR, 'log', '--no-merges', '--format=%H%x1f%cs%x1f%s%x1f%B%x1e'];
  if (since) cmd.push(`--since=${since}`);
  log = execFileSync('git', cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  cannot(`${DIR} is not a git repository (or git is not installed)`);
}

const byClass = new Map();
for (const rec of log.split('\x1e')) {
  const [sha, date, subject, body] = rec.replace(/^\n/, '').split('\x1f');
  if (!sha || body === undefined) continue;
  const classes = [...body.matchAll(/^\s*Class:\s*(.+?)\s*$/gim)].map((m) => m[1].toLowerCase().replace(/\s+/g, '-'));
  if (!classes.length) continue;
  const rungs = [...body.matchAll(/^\s*Rung:\s*(\d)\b|closed at rung\s*(\d)\b/gim)].map((m) => Number(m[1] ?? m[2]));
  const rung = rungs.length ? Math.max(...rungs) : null;
  for (const c of new Set(classes)) {
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push({ sha: sha.slice(0, 9), date, subject, rung });
  }
}

if (!byClass.size) cannot(`no commit in ${DIR}${since ? ` since ${since}` : ''} carries a "Class:" line yet, so recurrence cannot be judged. Add "Class: <name>" and "Rung: <1-4>" to fix commits.`);

const problems = [];
let recurring = 0;
for (const [c, commits] of byClass) {
  if (commits.length < 2) continue;
  recurring++;
  const newest = commits[0]; // git log lists newest first
  if (newest.rung === null || newest.rung < 3) {
    const list = commits.map((x) => `${x.sha} ${x.date} rung ${x.rung ?? '?'} — ${x.subject.slice(0, 70)}`).join('\n      ');
    problems.push(`class "${c}" has been fixed ${commits.length} times and the newest fix is closed at ${newest.rung ? `rung ${newest.rung}` : 'no recorded rung'}. A recurring class needs rung 3 (a fresh-context read where it can come back) or rung 4 (make it impossible):\n      ${list}`);
  }
}

if (problems.length) {
  console.log(`recurrence-check: REFUSED — ${problems.length} recurring class(es) closed below rung 3`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`recurrence-check: OK — ${byClass.size} class(es) named in fix commits, ${recurring} recurring, each closed at rung 3 or 4`);
