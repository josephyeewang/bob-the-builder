#!/usr/bin/env node
// recurrence-check.mjs — Bob Rule 31 (the intervention ladder): a class of defect that has been fixed twice may not
// be closed again by writing the rule down (rung 1) or adding a grep-style check (rung 2).
//
// WHY. A field census found a defect class with a standing written rule that recurred ~40 times across six fixes.
// Rule 31's own text named the missing enforcer: "mechanical detection of recurrence — a class name appearing in 2+
// separate fix commits". This is it (D-033). It reads the fix commits' own words, so it needs one habit: a fix
// commit says which class it fixes and which rung closed it, as two lines of their own (not indented, not in a code
// block) anywhere in the message — usually just above the Co-Authored-By line:
//
//     Class: read-error-treated-as-missing
//     Rung: 3            (if there is no Rung: line, "closed at rung 3" in the message, outside code blocks)
//
// Several classes go on one line, comma-separated, or on several Class: lines.
//
// A fix commit carries both lines; a commit with a Class: line and no rung is a mention (listed, not counted). Put the
// lines on the one commit that is the fix, not on its review follow-ups, or one fix counts twice.
// CHECK: for every class with two or more fix commits, the NEWEST of them must record rung 3 (a fresh-context read
// at the moment the class can come back) or rung 4 (the defect made unrepresentable). Rung 1, rung 2 or no rung =
// REFUSED, listing the commits.
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/recurrence-check.mjs" [DIR] [--since DATE]
// Exit: 0 = every recurring class was closed at rung 3 or 4 · 1 = REFUSED · 2 = cannot run (not a git repo, or no
//       commit carries a "Class:" line yet — nothing to judge is not a pass, Rule 29).

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const si = args.findIndex((a) => a === '--since' || a.startsWith('--since='));
const since = si < 0 ? null : args[si].includes('=') ? args[si].slice('--since='.length) : args[si + 1];
if (si >= 0 && (!since || since.startsWith('--'))) { process.stderr.write('recurrence-check: --since needs a date, e.g. --since 2026-09-01\n'); process.exit(2); }
const unknown = args.find((a) => a.startsWith('--') && !a.startsWith('--since'));
const DIR = path.resolve(args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1 || args[si].includes('=')))[0] ?? '.');

function cannot(message) {
  process.stderr.write(`recurrence-check: ${message}\n`);
  process.exit(2);
}

if (unknown) cannot(`unknown option ${unknown} (only --since DATE)`);
try {
  execFileSync('git', ['-C', DIR, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  cannot(`${DIR} is not a git repository (or git is not installed)`);
}
let log = '';
try {
  const cmd = ['-C', DIR, 'log', '--no-merges', '--format=%H%x1f%cs%x1f%s%x1f%b%x1e'];
  if (since) cmd.push(`--since=${since}`);
  log = execFileSync('git', cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  cannot(`${DIR} has no commits yet`);
}

const byClass = new Map();
const mentionsOnly = [];
for (const rec of log.split('\x1e')) {
  const [sha, date, subject, rawBody] = rec.replace(/^\n/, '').split('\x1f');
  if (!sha || rawBody === undefined) continue;
  if (/\(cherry picked from commit [0-9a-f]+\)/.test(rawBody)) continue; // a backport of a fix already counted
  // Lines that start with "Class:" / "Rung:", anywhere in the message (above a Co-Authored-By line is fine) but not
  // inside a ``` code block and not indented, so a docs commit that quotes an example does not count.
  const body = rawBody.replace(/```[\s\S]*?```/g, '');
  const field = (key) => [...body.matchAll(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'gim'))].map((m) => m[1]);
  const classes = field('Class').flatMap((v) => v.split(',')).map((c) => c.trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[.;!?]+$/, '').replace(/\s+/g, '-')).filter(Boolean);
  if (!classes.length) continue;
  // The Rung: line wins; otherwise "closed at rung N" in the message.
  const trailer = field('Rung').map((r) => r.match(/(\d)/)?.[1]).filter(Boolean).map(Number); // "3", "R3 (fresh read)"
  const prose = [...body.matchAll(/closed at rung\s*(\d)\b/gi)].map((m) => Number(m[1]));
  const rungs = trailer.length ? trailer : prose;
  const rung = rungs.length ? Math.max(...rungs) : null;
  // A fix carries both lines. A Class: line with no rung (a docs commit, a follow-up) is a mention, not a fix.
  if (rung === null) { mentionsOnly.push(`${sha.slice(0, 9)} ${subject.slice(0, 60)}`); continue; }
  for (const c of new Set(classes)) {
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push({ sha: sha.slice(0, 9), date, subject, rung });
  }
}

const note = mentionsOnly.length ? `\n  ⚠ ${mentionsOnly.length} commit(s) name a class with no Rung: line, so they were not counted as fixes: ${mentionsOnly.slice(0, 3).join('; ')}${mentionsOnly.length > 3 ? ' …' : ''}` : '';
if (!byClass.size && mentionsOnly.length) cannot(`${mentionsOnly.length} commit(s) name a class, but none records a Rung: line, so none counts as a fix and recurrence cannot be judged.${note}`);
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
  if (note) console.log(note.trimStart());
  process.exit(1);
}
console.log(`recurrence-check: OK — ${byClass.size} class(es) named in fix commits, ${recurring} recurring, each closed at rung 3 or 4` + note);
