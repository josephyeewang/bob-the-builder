#!/usr/bin/env node
// run-commands-check.mjs — Bob Rule 26 and Engineering Principle 8b: a refactor must keep the runnable entry point,
// not just the importable names. Every command the project RUNS must point at a file that exists and still runs.
//
// WHY. Moving or wrapping code breaks the places it is *run* from — a package script, a CI step, a Makefile target —
// and the type-checker never sees them. The worst case imports cleanly, exits 0 and does nothing: a compatibility
// file that re-exports the names but dropped Python's `if __name__ == "__main__":` block, so a scheduled job
// "succeeds" while doing no work. Rule 26 said to trace these by hand; this traces them (D-033).
//
// CHECKS on the project at DIR (default: the current folder):
//   1. every script file run by package.json "scripts", a .github/workflows/*.yml `run:` step or a Makefile recipe
//      (`node x.mjs`, `python3 x.py`, `bash x.sh`, `tsx x.ts`, `./x.sh`, `python -m pkg.mod` …) exists — relative
//      to the project, or to the step's `working-directory:` when the workflow sets one;
//   2. a Python file run as a script has a `__main__` block, unless it is plainly a script (top-level code beyond
//      imports, definitions and constants). A file of only imports, or one that defines main() and never calls it,
//      is the "imports cleanly, does nothing" shape.
// Paths built from variables ($X, ${{ … }}) or absolute paths are not judged (they are listed as skipped).
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/run-commands-check.mjs" [DIR]
// Exit: 0 = every run command points at a file that runs · 1 = REFUSED · 2 = cannot run (no run commands found —
//       nothing checked is not a pass, Rule 29).

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const rel = (p) => path.relative(DIR, p) || '.';
const problems = [];
const skipped = [];
let checked = 0;

// Collect [source, command, base folder] for every run command.
const runs = [];
if (fs.existsSync(path.join(DIR, 'package.json'))) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) runs.push([`package.json "${k}"`, String(v), DIR]);
  } catch (e) {
    problems.push(`package.json is not valid JSON (${e.message})`);
  }
}
const wfDir = path.join(DIR, '.github', 'workflows');
if (fs.existsSync(wfDir)) {
  for (const f of fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n');
    let jobWd = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^  [\w-]+:\s*$/.test(l)) jobWd = null; // a new job (two-space key under jobs:)
      const d = l.match(/^(\s*)defaults:\s*$/);
      if (d) {
        for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > d[1].length); j++) {
          const w = lines[j].match(/^\s*working-directory:\s*["']?([^"'#\s]+)/);
          if (w) jobWd = w[1];
        }
      }
      const m = l.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
      if (!m) continue;
      // The step's own working-directory: anywhere in the same step (from its "- " line to the next step).
      const runIndent = m[1].length;
      let start = i;
      if (!/^\s*-\s/.test(l)) while (start > 0 && !(/^\s*-\s/.test(lines[start]) && lines[start].search(/\S/) < runIndent)) start--;
      const dash = lines[start].search(/\S/);
      let end = i + 1;
      while (end < lines.length) {
        const e = lines[end], ind = e.search(/\S/);
        if (e.trim() && !e.trim().startsWith('#') && (ind < dash || (ind === dash && /^\s*-\s/.test(e)))) break;
        end++;
      }
      let stepWd = null;
      for (let j = start; j < end; j++) {
        const w = lines[j].match(/^\s*(?:-\s*)?working-directory:\s*["']?([^"'#\s]+)/);
        if (w) stepWd = w[1];
      }
      const base = path.join(DIR, stepWd ?? jobWd ?? '.');
      const where = `.github/workflows/${f}:${i + 1}`;
      if (m[2].trim() && !/^[|>][-+]?\s*$/.test(m[2].trim())) runs.push([where, m[2], base]);
      else {
        const indent = (lines[i + 1] ?? '').search(/\S/);
        for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) >= indent); j++)
          runs.push([`.github/workflows/${f}:${j + 1}`, lines[j], base]);
      }
    }
  }
}
for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
  if (!fs.existsSync(path.join(DIR, mk))) continue;
  fs.readFileSync(path.join(DIR, mk), 'utf8').split('\n').forEach((l, i) => {
    if (l.startsWith('\t')) runs.push([`${mk}:${i + 1}`, l.trim().replace(/^[@-]+/, ''), DIR]);
  });
}

const INTERP = String.raw`(?:node|nodejs|deno run(?:\s+-\S+)*|bun(?: run)?|tsx|ts-node|npx\s+(?:tsx|ts-node)|python3?|uv run(?: python3?)?|poetry run python3?|bash|sh|zsh|ruby)`;
const FILE = String.raw`["']?([^\s"';|&()<>]+\.(?:mjs|cjs|js|ts|mts|py|sh|rb))["']?`;
const RUN_FILE = new RegExp(String.raw`(?:^|[\s;&|(])${INTERP}(?:\s+-[^\s]+)*\s+${FILE}`, 'g');
const DOT_SLASH = new RegExp(String.raw`(?:^|[\s;&|(])(\.\.?\/[^\s"';|&()<>]+\.(?:sh|py|mjs|js|rb))`, 'g');
const PY_M = /(?:^|[\s;&|(])python3?\s+(?:-[A-Za-z]+\s+)*-m\s+([A-Za-z_][\w.]*)/g;
const STDLIB_M = new Set(['pip', 'venv', 'pytest', 'unittest', 'http.server', 'json.tool', 'build', 'twine', 'black', 'ruff', 'mypy', 'coverage', 'pyflakes', 'flake8', 'isort', 'pre_commit', 'site', 'ensurepip', 'compileall', 'doctest', 'timeit', 'cProfile', 'pdb', 'zipfile', 'tarfile', 'webbrowser', 'uvicorn', 'gunicorn', 'flask', 'django', 'streamlit', 'playwright', 'spacy', 'nltk']);

function pyDoesNothing(src) {
  if (/__name__\s*==\s*['"]__main__['"]/.test(src)) return false;
  const top = src.split('\n').filter((l) => l.trim() && !/^\s/.test(l) && !l.startsWith('#'));
  const inert = (l) => /^(import |from |def |async def |class |@|__all__|[A-Z_][A-Z0-9_]*\s*[:=]|"""|'''|\)|\]|\})/.test(l);
  return top.length > 0 && top.every(inert) && (top.every((l) => /^(import |from |__all__)/.test(l)) || /^def main\s*\(/m.test(src));
}

function judge(where, file, base) {
  if (/[$`{}*]/.test(file) || path.isAbsolute(file) || file.startsWith('~')) { skipped.push(`${where}: ${file}`); return; }
  const full = path.resolve(base, file);
  checked++;
  if (!fs.existsSync(full)) { problems.push(`${where}: runs ${file}, which does not exist (looked in ${rel(base)}/)`); return; }
  if (full.endsWith('.py') && pyDoesNothing(fs.readFileSync(full, 'utf8')))
    problems.push(`${where}: runs ${file}, which has no \`if __name__ == "__main__":\` block and only imports or defines — it would import cleanly, exit 0 and do nothing`);
}

for (const [where, cmd, base] of runs) {
  const c = cmd.replace(/#.*$/, '');
  // `bash ./x.sh` matches both patterns; judge each file once per command.
  for (const f of new Set([...c.matchAll(RUN_FILE), ...c.matchAll(DOT_SLASH)].map((m) => m[1]))) judge(where, f, base);
  for (const m of c.matchAll(PY_M)) {
    const mod = m[1];
    if (STDLIB_M.has(mod) || STDLIB_M.has(mod.split('.')[0])) continue;
    const p = mod.replace(/\./g, '/');
    const cands = [`${p}.py`, `${p}/__main__.py`, `src/${p}.py`, `src/${p}/__main__.py`];
    const found = cands.find((x) => fs.existsSync(path.resolve(base, x)));
    // A module that is not in the project is an installed package; only judge ones whose top folder is here.
    const top = mod.split('.')[0];
    if (!found && (fs.existsSync(path.resolve(base, top)) || fs.existsSync(path.resolve(base, 'src', top)))) {
      checked++;
      problems.push(`${where}: runs python -m ${mod}, but neither ${p}.py nor ${p}/__main__.py exists`);
    } else if (found) {
      checked++;
      if (found.endsWith('.py') && !found.endsWith('__main__.py') && pyDoesNothing(fs.readFileSync(path.resolve(base, found), 'utf8')))
        problems.push(`${where}: runs python -m ${mod}; ${found} has no __main__ block and only imports or defines — it would do nothing`);
    }
  }
}

if (problems.length) {
  console.log(`run-commands-check: REFUSED — ${problems.length} run command(s) point at a file that is missing or does nothing`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
if (!checked) {
  process.stderr.write(`run-commands-check: found no run commands that name a project file in ${DIR} (package.json scripts, .github/workflows, Makefile) — nothing checked is not a pass.\n`);
  process.exit(2);
}
console.log(`run-commands-check: OK — ${checked} run command(s) point at files that exist and run${skipped.length ? ` (${skipped.length} built from variables or absolute paths, not judged)` : ''}`);
