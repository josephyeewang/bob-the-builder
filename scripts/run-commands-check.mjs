#!/usr/bin/env node
// run-commands-check.mjs — Bob Rule 26 and Engineering Principle 8b: a refactor must keep the runnable entry point,
// not just the importable names. A change that moves, deletes or guts a file the project RUNS must not leave a run
// command pointing at it.
//
// WHY. Moving or wrapping code breaks the places it is *run* from — a package script, a CI step, a Makefile target, a
// schedule — and the type-checker never sees them. The worst case imports cleanly, exits 0 and does nothing: a
// compatibility file that re-exports the names but dropped Python's `if __name__ == "__main__":` block, so a scheduled
// job "succeeds" while doing no work. Rule 26 said to trace these by hand; this traces them (D-033).
//
// HOW. It judges the CHANGE, not every command. Three fresh reviews showed that reading arbitrary shell commands
// raises false alarms on healthy projects faster than they can be fixed, so this version does not parse commands. It
// asks git what changed since a base commit, then looks for that file's name in the places that run things:
//   1. a script file that was deleted or renamed (an executable with no extension counts too) — is it still named?
//   2. a Python file that had a `__main__` block at the base and no longer does — is it still named?
// "Named" means written in a run config: package.json "scripts", "bin" and "main"; .github/workflows/*.yml (not their
// `paths:` filters); Makefile, Procfile, Dockerfile, compose files, .gitlab-ci.yml, vercel.json, netlify.toml,
// fly.toml, crontab files; pyproject.toml's [project.scripts] / [tool.poetry.scripts]. Comments are ignored. A file is
// named by its path, its path from the config's folder, its Python module (`python -m pkg.job`, `"pkg.job:main"`), or
// a tail of its path that no other file shares (so `cd jobs && python job.py` counts, and dist/index.js never stands
// for src/index.js). For a lost __main__ block only a mention that runs the file as a script counts (python x.py,
// ./x.py, python -m x) — `uvicorn app.main:app`, `pytest tests/x.py` and entry points import it and never needed one.
// It is a text match, not a parse: it cannot see a command that was broken before the change, a name built from a
// variable, or a file named somewhere other than the configs above.
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/run-commands-check.mjs" [DIR] [--base REF]
//        Without --base it compares with where this branch left main or master (git merge-base). On main or master
//        itself it needs --base. At a phase gate, pass the commit the phase started from.
// Exit: 0 = nothing named in a run config was moved, deleted or gutted · 1 = REFUSED · 2 = cannot run (not a git
//       repository; or no base — on main or master, or in a shallow CI clone, without --base: nothing compared is not
//       a pass, Rule 29).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const bi = args.findIndex((a) => a === '--base' || a.startsWith('--base='));
const inline = bi >= 0 && args[bi].includes('=');
const baseArg = bi < 0 ? null : inline ? args[bi].slice('--base='.length) : args[bi + 1];
if (bi >= 0 && (!baseArg || baseArg.startsWith('--'))) { process.stderr.write('run-commands-check: --base needs a commit, e.g. --base main\n'); process.exit(2); }
const DIR = path.resolve(args.filter((a, i) => !a.startsWith('--') && (bi < 0 || inline || i !== bi + 1))[0] ?? '.');

function cannot(message) {
  process.stderr.write(`run-commands-check: ${message}\n`);
  process.exit(2);
}
const git = (...a) => execFileSync('git', ['-C', DIR, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
let ROOT;
try { ROOT = git('rev-parse', '--show-toplevel').trim(); } catch { cannot(`${DIR} is not a git repository`); }

let base = baseArg;
if (!base) {
  let branch = '';
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { cannot(`${DIR} has no commits yet`); }
  if (branch === 'main' || branch === 'master') cannot(`on ${branch} there is no branch point to compare with — pass --base REF (the commit the phase started from)`);
  else {
    for (const ref of ['main', 'origin/main', 'master', 'origin/master']) {
      try { base = git('merge-base', 'HEAD', ref).trim(); break; } catch { /* try the next */ }
    }
    if (!base) cannot(`cannot tell where this change starts (no main or master to compare with — a shallow CI clone?). Pass --base REF`);
    // Already merged into main (fast-forward) and nothing uncommitted: the branch point is HEAD itself, so there is
    // nothing to compare. (A new branch with uncommitted work is compared with HEAD, as it should be.)
    if (base === git('rev-parse', 'HEAD').trim() && !git('status', '--porcelain').trim()) cannot('this branch adds nothing to main (its branch point is HEAD) — pass --base REF (the commit the phase started from)');
  }
}
try { base = git('rev-parse', '--verify', `${base}^{commit}`).trim(); } catch { cannot(`the base commit "${base}" cannot be found (pass one with --base REF)`); }

// What changed since the base, working tree included: D = deleted, R = renamed (old → new), M = modified.
const changes = git('diff', '-M', '--name-status', base, '--').split('\n').filter(Boolean).map((l) => l.split('\t'));
const SCRIPT = /\.(mjs|cjs|js|ts|mts|py|sh|rb)$/;
const executable = (p) => { try { return /^100755 /.test(git('ls-tree', base, '--', p)); } catch { return false; } };
const ignored = (p) => { try { git('check-ignore', '-q', '--', p); return true; } catch { return false; } };
const gone = []; // [old path, new path or null]
const modifiedPy = [];
for (const [st, a, b] of changes) {
  if (st === 'D') {
    // Untracked but still on disk, or now ignored (a build output taken out of git), is not gone.
    if (!fs.existsSync(path.join(ROOT, a)) && !ignored(a) && (SCRIPT.test(a) || executable(a))) gone.push([a, null]);
  } else if (st.startsWith('R')) {
    // The old path may live on as build output (lib/foo.js → src/foo.ts, lib/ now ignored and rebuilt): not gone.
    if ((SCRIPT.test(a) || executable(a)) && !fs.existsSync(path.join(ROOT, a)) && !ignored(a)) gone.push([a, b]);
    if (b.endsWith('.py')) modifiedPy.push([a, b]);
  } else if (st === 'M' && a.endsWith('.py')) modifiedPy.push([a, a]);
}

// The run configs, as they are now, reduced to the lines that run things.
const tracked = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
const CONFIG = /(^|\/)(package\.json|Makefile|makefile|GNUmakefile|Procfile|Dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.gitlab-ci\.yml|vercel\.json|netlify\.toml|fly\.toml|pyproject\.toml|crontab|[\w.-]+\.cron)$/;
const stripComment = (l) => (/^\s*#/.test(l) ? '' : l.replace(/\s#.*$/, ''));
function runLines(f, text) {
  const base = path.basename(f);
  if (base === 'package.json') {
    // Only the keys that run something; "files", "exports" and the like are lists of paths, not commands.
    try {
      const pkg = JSON.parse(text);
      const out = [];
      for (const [k, v] of Object.entries(pkg.scripts ?? {})) out.push([`scripts.${k}`, String(v)]);
      const bin = typeof pkg.bin === 'string' ? { bin: pkg.bin } : pkg.bin ?? {};
      for (const [k, v] of Object.entries(bin)) out.push([`bin.${k}`, String(v)]);
      if (typeof pkg.main === 'string') out.push(['main', pkg.main]);
      return out;
    } catch { return []; }
  }
  const lines = text.split('\n');
  if (base === 'pyproject.toml') {
    // Only the entry-point tables: [project.scripts], [project.gui-scripts], [tool.poetry.scripts].
    let on = false;
    return lines.flatMap((l, i) => {
      const t = l.match(/^\s*\[([^\]]+)\]/);
      if (t) { on = /^(project\.(gui-)?scripts|tool\.poetry\.scripts)$/.test(t[1].trim()); return []; }
      return on ? [[i + 1, stripComment(l)]] : [];
    });
  }
  // YAML and the rest: drop comments, and a workflow's `paths:` / `paths-ignore:` trigger filters.
  let filter = -1;
  return lines.flatMap((l, i) => {
    const ind = l.search(/\S/);
    // A filter's list ends at a line no deeper than its key — except a "- item" at the same indent (zero-indented YAML).
    if (filter >= 0 && l.trim() && (ind < filter || (ind === filter && !/^\s*-\s/.test(l)))) filter = -1;
    const k = l.match(/^(\s*)(paths|paths-ignore|branches|tags):/);
    if (k) { filter = k[1].length; return []; }
    return filter >= 0 ? [] : [[i + 1, stripComment(l)]];
  });
}
const configs = tracked.filter((f) => (CONFIG.test(f) && !f.includes('node_modules/')) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map((f) => ({ f, lines: runLines(f, fs.readFileSync(path.join(ROOT, f), 'utf8')) }));
const existing = tracked.filter((f) => fs.existsSync(path.join(ROOT, f)));

// A config's run lines as they were at the base, to tell a line this change wrote from one it left alone.
const baseCache = new Map();
function baseLines(f) {
  if (!baseCache.has(f)) {
    let text = null;
    try { text = git('show', `${base}:${f}`); } catch { /* the config is new in this change */ }
    baseCache.set(f, new Set(text === null ? [] : runLines(f, text).map(([, l]) => l.trim())));
  }
  return baseCache.get(f);
}
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The Python module a file is run as: pkg/job.py → pkg.job, src/pkg/job.py → pkg.job, pkg/__main__.py and
// pkg/__init__.py → pkg.
function moduleOf(p) {
  if (!p.endsWith('.py')) return [];
  const parts = p.replace(/\.py$/, '').split('/');
  if (parts.at(-1) === '__main__' || parts.at(-1) === '__init__') parts.pop();
  if (!parts.length) return [];
  const mods = [parts.join('.')];
  if (parts[0] === 'src' && parts.length > 1) mods.push(parts.slice(1).join('.'));
  return mods;
}
// Does a path written in a config mean `p`? It does when, read from the project root or from the config's folder, it
// is p; or when it is a whole-segment tail of p ("scripts/build.sh" or "build.sh" for web/scripts/build.sh — a command
// run from a sub-folder) that no other file in the project also ends with. "dist/index.js" is not a tail of
// src/index.js, so a build output never stands for its source.
// `movedTo` (a rename's new path) is left out of that "no other file" test: the moved file is the same file.
function means(written, p, f, movedTo = null) {
  const w = written.replace(/^\.\//, '');
  if (!w || /[$*{}]/.test(w)) return false;
  if (w === p || path.normalize(path.join(path.dirname(f), w)) === p) return true;
  if (!p.endsWith(`/${w}`)) return false;
  // An executable with no extension (bin/test, scripts/deploy) is named only as a path or as ./name, never by a bare
  // word — "test" or "dev" in a config is almost always something else.
  if (!/\.\w+$/.test(p) && !w.includes('/') && !written.startsWith('./')) return false;
  return !existing.some((o) => o !== p && o !== movedTo && (o === w || o.endsWith(`/${w}`)));
}
const TOKEN = /[^\s"'=(),;:`[\]{}]+/g;
// Where the run configs name `p`. asScript: count only a mention that runs the file as a script — after python (and
// its flags) or uv/poetry run, as ./path, or as `-m module` — because only then does a lost __main__ block matter.
// `uvicorn app.main:app`, `pytest tests/x.py` or a pyproject entry point import the file; they never needed the block.
function mentions(p, asScript = false, movedTo = null) {
  const hits = [];
  const mods = moduleOf(p);
  for (const { f, lines } of configs) {
    if (asScript && path.basename(f) === 'pyproject.toml') continue;
    const unchanged = baseLines(f);
    for (const [at, l] of lines) {
      let hit = false;
      for (const m of l.matchAll(TOKEN)) {
        if (!means(m[0], p, f, movedTo)) continue;
        // A bare name that is also the moved file's own name is ambiguous: `working-directory: scripts` + `./build.sh`
        // after build.sh → scripts/build.sh names the new file; `python report.py` from jobs/ after jobs/report.py →
        // jobs/core/report.py is now broken. The line tells them apart: one this change wrote was pointed at the new
        // place on purpose; one it left untouched still points where the file used to be.
        const w = m[0].replace(/^\.\//, '');
        if (movedTo && !w.includes('/') && (movedTo === w || movedTo.endsWith(`/${w}`)) && !unchanged.has(l.trim())) continue;
        const before = l.slice(0, m.index);
        if (!asScript || m[0].startsWith('./') || /(?:(?:^|[\s"'(/])(?:python[\d.]*|uv run(?: python[\d.]*)?|poetry run python[\d.]*)|\$[({]?PYTHON\w*[)}]?)(?:\s+-(?!m\b)[\w-]+(?:\s+[^\s"'-]\S*)?)*\s+["']?$/.test(before)) { hit = true; break; }
      }
      if (!hit && mods.length) {
        const modRun = new RegExp(`-m\\s+["']?(?:${mods.map(esc).join('|')})(?=$|[\\s"'])`);
        const modRef = new RegExp(`(?:^\\s*[\\w-]+\\s*=\\s*["']|["'\\s])(?:${mods.map(esc).join('|')}):`);
        hit = modRun.test(l) || (!asScript && modRef.test(l));
      }
      if (hit) hits.push(`${f}:${at}`);
    }
  }
  return hits;
}

const problems = [];
for (const [oldPath, newPath] of gone)
  for (const where of mentions(oldPath, false, newPath))
    problems.push(`${where} still names ${oldPath}, which this change ${newPath ? `moved to ${newPath}` : 'deleted'}`);
const hasMain = (src) => /^\s*if\s+__name__\s*==\s*['"]__main__['"]/m.test(src);
for (const [oldPath, newPath] of modifiedPy) {
  let before = '';
  try { before = git('show', `${base}:${oldPath}`); } catch { continue; }
  const now = fs.existsSync(path.join(ROOT, newPath)) ? fs.readFileSync(path.join(ROOT, newPath), 'utf8') : '';
  if (newPath.endsWith('__main__.py') || !hasMain(before) || hasMain(now)) continue;
  for (const where of new Set([...mentions(newPath, true), ...(oldPath !== newPath ? mentions(oldPath, true) : [])]))
    problems.push(`${where} names ${newPath}, which lost its \`if __name__ == "__main__":\` block in this change — run as a script it would import cleanly, exit 0 and do nothing`);
}

if (problems.length) {
  console.log(`run-commands-check: REFUSED — ${problems.length} run config line(s) name a file this change moved, deleted or emptied (compared with ${base.slice(0, 12)})`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`run-commands-check: OK — compared with ${base.slice(0, 12)}: ${gone.length} script(s) moved or deleted, ${modifiedPy.length} Python file(s) changed; no run config still names one that moved, went or lost its run block`);
