#!/usr/bin/env node
// one-home-check.mjs — Bob checks on itself that each kind of content still has ONE home (D-027, D-028, D-030, D-032).
//
// WHY. On 29 Oct 2026 the templates, rules, modes and reference sections were each given one home, and the core
// (read by every session) was cut to an index plus pointers. A fresh audit the same day found the drift that a
// second copy turns into: the lens list was kept in three places, two had fallen behind, and the newest lens could
// never be picked for an audit. It also found Bob commands written as `scripts/x`, which only resolve inside Bob's
// own folder, never in the user's project where the session runs. Nothing checked any of this. This does.
//
// CHECKS (all on the Bob repo at --root; default: the folder above this script):
//   1. rule index  — every row of the core's rule index names a rule that rules.md holds, in the group it says, and
//                    every rule in rules.md has a row.
//   2. lens list   — every lens file is listed in audit-lenses/README.md and named in _selection-rubric.md (a lens
//                    the rubric never names is never put on a panel).
//   3. one list    — no file other than audit-lenses/README.md carries a lens band table ("| 1. Engineering … | L01").
//   4. Bob paths   — in the files a session reads or opens (the core, rules.md, skill/SKILL.md, modes/, reference/,
//                    templates/, audit-lenses/), a command that runs a Bob script works from the user's project:
//                    `node "$(realpath ~/.claude/skills/bob/..)/scripts/x.mjs"` (node does not follow the link, so
//                    `node ~/.claude/skills/bob/../…` fails) and `bash|sh|python3 ~/.claude/skills/bob/../scripts/x`,
//                    never `scripts/x`. Lines inside fenced code blocks count too. Every path written in either form
//                    must exist in Bob. (A plain mention of a Bob file needs neither form: the core's "Paths" note
//                    says a bare path means Bob's folder.)
//   5. stubs       — the core, rules.md and SKILL.md cite moved appendices by their file in reference/, not as "Appendix X" (a one-line
//                    pointer since D-030); "(was Appendix X)" is allowed.
//   6. counts      — every "N ready-made audits" / "N-audit library" / "the full N" in README.md equals the lens files.
// A SKIP entry that hides nothing while its section is still there is itself a problem, so a fixed section cannot stay skipped.
// Text owned by another session and not yet fixed is listed in SKIP below, with the date it was set; remove a line
// once that text is fixed. Exit 1 on any problem.
//
// Usage: node scripts/one-home-check.mjs [--root DIR]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));
const problems = [];
const bad = (check, where, what) => problems.push(`  ✗ [${check}] ${where}: ${what}`);

// Sections of session-read files that another session owns and has not fixed yet (checks 4 and 5 only).
// Each entry: file, the heading that starts the skipped section (to the next "## " heading), or '*' for the whole file.
const DEFAULT_SKIP = [
  // 2026-10-29: the NEW steps and the startup steps are being rewritten by the ORCHESTRATE session (D-032). Its paths
  // in the NEW steps are already fixed, so only its "Appendix K" wording waits.
  { file: 'build-protocol-core.md', heading: '## MODE: NEW', checks: ['stubs'] },
  // 2026-10-29: build-protocol.md Part II (the NEW steps in full) has two Bob commands in a form that fails from a
  // project (the merge-guard test command and `scripts/coherence-check.sh <docs-dir>`); same owner.
  { file: 'build-protocol.md', heading: '## PART II', checks: ['Bob paths'] },
];
// --skip FILE replaces the list with a JSON array of the same shape (the self-tests use it, so they keep working
// when an entry above is deleted).
const si = args.indexOf('--skip');
const SKIP = si >= 0 ? JSON.parse(fs.readFileSync(args[si + 1], 'utf8')) : DEFAULT_SKIP;
function skipped(file, lineNo, lines, check) {
  for (const s of SKIP) {
    if (s.file !== file || !s.checks.includes(check)) continue;
    if (s.heading === '*') return s;
    let cur = null;
    for (let i = 0; i <= lineNo; i++) if (lines[i].startsWith('## ')) cur = lines[i];
    // The heading must end where the entry's does ("## PART II" must not match "## PART III").
    if (cur && cur.startsWith(s.heading) && /^($|[\s:.—-])/.test(cur.slice(s.heading.length))) return s;
  }
  return null;
}
// Check 5 (appendix pointers) reads only the files every session loads; lenses and templates may cite appendices by history.
const sessionCoreFiles = new Set(['build-protocol-core.md', 'rules.md', 'skill/SKILL.md']);

// 1. rule index
if (has('build-protocol-core.md') && has('rules.md')) {
  const groupOf = new Map();
  let g = null;
  for (const l of rd('rules.md').split('\n')) {
    const h = l.match(/^## (\d+)\. /); if (h) g = Number(h[1]);
    const r = l.match(/^<!-- Rule (\d+) -->/); if (r) groupOf.set(Number(r[1]), g);
  }
  const rows = new Map();
  for (const l of rd('build-protocol-core.md').split('\n')) {
    const m = l.match(/^\| (\d+) \|.*\| *(\d+) *\|\s*$/);
    if (m && /`(PROSE|SCRIPT|HOOK|GATE)`/.test(l)) rows.set(Number(m[1]), Number(m[2]));
  }
  if (!rows.size) bad('rule index', 'build-protocol-core.md', 'no rule index rows found');
  for (const [n, grp] of rows) {
    if (!groupOf.has(n)) bad('rule index', 'build-protocol-core.md', `Rule ${n} is in the index but not in rules.md`);
    else if (groupOf.get(n) !== grp) bad('rule index', 'build-protocol-core.md', `Rule ${n} says group ${grp}; rules.md files it in group ${groupOf.get(n)}`);
  }
  for (const n of groupOf.keys()) if (!rows.has(n)) bad('rule index', 'rules.md', `Rule ${n} has no row in the core's index`);
}

// 2. lens list
if (has('audit-lenses')) {
  const ids = fs.readdirSync(path.join(ROOT, 'audit-lenses'))
    .filter((f) => /^L\d\d-.*\.md$/.test(f) && !f.includes('stack-checklists')).map((f) => f.slice(0, 3)).sort();
  const readme = has('audit-lenses/README.md') ? rd('audit-lenses/README.md') : '';
  const rubric = has('audit-lenses/_selection-rubric.md') ? rd('audit-lenses/_selection-rubric.md') : '';
  // A lens counts as named when its ID appears, or falls inside a range such as "L01-L10" or "L01–L14".
  const named = (text) => {
    const set = new Set(text.match(/\bL\d\d\b/g) || []);
    for (const m of text.matchAll(/\bL(\d\d) ?[-–] ?L(\d\d)\b/g))
      for (let n = Number(m[1]); n <= Number(m[2]); n++) set.add(`L${String(n).padStart(2, '0')}`);
    return set;
  };
  const inReadme = named(readme), inRubric = named(rubric);
  for (const id of ids) {
    if (!inReadme.has(id)) bad('lens list', 'audit-lenses/README.md', `${id} is not listed`);
    if (!inRubric.has(id)) bad('lens list', 'audit-lenses/_selection-rubric.md', `${id} is never named, so no panel can include it`);
  }
}

// 3. one lens band table
const mdFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['.git', 'node_modules', '.claude'].includes(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel); else if (e.name.endsWith('.md')) mdFiles.push(rel);
  }
})('');
const HISTORY = /^(CHANGELOG\.md|decision-log\.md|audit-log\.md|evolutions\/|retros\/|lens-retros\/|fixtures\/)/;
for (const f of mdFiles) {
  if (f === 'audit-lenses/README.md' || HISTORY.test(f)) continue;
  rd(f).split('\n').forEach((l, i) => {
    if (/^\| *\*{0,2}\d\. [A-Z][^|]*\| *L\d\d/.test(l)) bad('one list', `${f}:${i + 1}`, 'a lens band table; the list lives only in audit-lenses/README.md');
  });
}

// 4 + 5. paths and stubs in the files a session reads (and the templates, lenses and reference files it opens)
const listIn = (dir, exts, deep = false) => (has(dir)
  ? fs.readdirSync(path.join(ROOT, dir), { recursive: deep }).map(String).filter((f) => exts.some((e) => f.endsWith(e))).map((f) => `${dir}/${f}`)
  : []);
const sessionFiles = ['build-protocol-core.md', 'rules.md', 'skill/SKILL.md', 'build-protocol.md',
  ...listIn('modes', ['.md']), ...listIn('reference', ['.md']), ...listIn('templates', ['.md', '.json']),
  ...listIn('audit-lenses', ['.md'], true), ...listIn('skills', ['.md'], true)].filter(has);
const bobScripts = new Set(has('scripts') ? fs.readdirSync(path.join(ROOT, 'scripts'), { recursive: true }).map(String) : []);
const used = new Map(SKIP.map((s) => [s, 0]));
const NODE_OK = '"$(realpath ~/.claude/skills/bob/..)/scripts/';
for (const f of sessionFiles) {
  const lines = rd(f).split('\n');
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return; }
    const skip = (check) => {
      const s = skipped(f, i, lines, check);
      if (s) used.set(s, used.get(s) + 1);
      return Boolean(s);
    };
    const where = `${f}:${i + 1}`;
    // Commands: inside backticks, or anywhere on a line inside a fenced block.
    const spans = (fenced || f.endsWith('.json')) ? [l] : [...l.matchAll(/`[^`]*`/g)].map((m) => m[0]);
    for (const span of spans) {
      for (const m of span.matchAll(/\bnode (?:--test )?(?:"\$\(realpath ~\/\.claude\/skills\/bob\/\.\.\)\/|~\/\.claude\/skills\/bob\/\.\.\/|\.\/)?scripts\/([^\s`"]+)/g)) {
        if (bobScripts.has(m[1]) && !m[0].includes(NODE_OK) && !skip('Bob paths'))
          bad('Bob paths', where, `\`node … scripts/${m[1]}\` fails from a project (node does not follow the link); write node ${NODE_OK}${m[1]}"`);
      }
      // A bare `scripts/x …` with arguments is a command too (`scripts/coherence-check.sh <docs-dir>`).
      for (const m of span.matchAll(fenced ? /^\s*(?:\.\/)?scripts\/([^\s`"]+) \S/g : /^`(?:\.\/)?scripts\/([^\s`"]+) [^`]+`$/g)) {
        if (bobScripts.has(m[1]) && !skip('Bob paths'))
          bad('Bob paths', where, `\`scripts/${m[1]} …\` only works inside Bob's folder; write ~/.claude/skills/bob/../scripts/${m[1]} (node: the realpath form)`);
      }
      for (const m of span.matchAll(/\b(?:bash|sh|python3?) (?:\.\/)?scripts\/([^\s`"]+)/g)) {
        if (bobScripts.has(m[1]) && !skip('Bob paths'))
          bad('Bob paths', where, `\`scripts/${m[1]}\` only works inside Bob's folder; write ~/.claude/skills/bob/../scripts/${m[1]}`);
      }
    }
    for (const m of l.matchAll(/(?:~\/\.claude\/skills\/bob\/\.\.\/|\$\(realpath ~\/\.claude\/skills\/bob\/\.\.\)\/)([A-Za-z0-9_./-]+)/g)) {
      const p = m[1].replace(/[.,;:)]+$/, '');
      const rest = l.slice(m.index + m[0].length, m.index + m[0].length + 1);
      if (/[…<{*]/.test(p + rest)) continue;
      if (!has(p) && !skip('Bob paths')) bad('Bob paths', where, `${m[0]} names ${p}, which does not exist in Bob`);
    }
    for (const m of l.matchAll(/(was )?Appendix ([AEGJKL])\b/g)) {
      if (!m[1] && sessionCoreFiles.has(f) && !skip('stubs')) bad('stubs', where, `"Appendix ${m[2]}" is a one-line pointer since D-030; name its file in reference/`);
    }
  });
}
// Stale only while its section is still there; once the section moves away the entry is dead and harmless.
const sectionThere = (s) => has(s.file) && (s.heading === '*' || rd(s.file).split('\n').some((l) => l.startsWith(s.heading)));
for (const [s, n] of used) if (n === 0 && sectionThere(s)) bad('SKIP', 'scripts/one-home-check.mjs', `the SKIP entry for ${s.file} ${s.heading} (${s.checks.join(', ')}) no longer hides anything; delete it`);

// 6. public counts — the README's lens count matches the lens files (it said 34 when there were 38).
if (has('README.md') && has('audit-lenses')) {
  const n = fs.readdirSync(path.join(ROOT, 'audit-lenses')).filter((f) => /^L\d\d-.*\.md$/.test(f) && !f.includes('stack-checklists')).length;
  rd('README.md').split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/\b(\d+)(?: ready-made audits|-audit library)|\bthe full (\d+)\b/g))
      if (Number(m[1] ?? m[2]) !== n) bad('counts', `README.md:${i + 1}`, `says ${m[1] ?? m[2]} audits; there are ${n} lens files`);
  });
}

if (problems.length) {
  console.log(`one-home-check: ${problems.length} problem(s)`);
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('one-home-check: OK — rule index, lens list, one band table, Bob paths, appendix pointers, README counts');
