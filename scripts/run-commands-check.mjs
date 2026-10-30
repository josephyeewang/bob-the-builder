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
// raises false alarms on healthy projects faster than they can be fixed (wrappers, subshells, monorepo filters, files
// made at run time …), so this version never parses commands. It compares the working tree with a base commit and asks
// two questions whose answers come from git, not from guessing:
//   1. a file that was deleted or renamed since the base — is its path, or its file name, still written in a run
//      config (package.json, .github/workflows/*.yml, Makefile, Procfile, Dockerfile, docker-compose*.yml,
//      .gitlab-ci.yml, vercel.json, netlify.toml, fly.toml, pyproject.toml, crontab files)? A bare file name counts
//      only when it is unambiguous (no other file of that name in the project), so a command run from a sub-folder
//      is still caught and a same-named file elsewhere is not mistaken for it;
//   2. a Python file that had a `__main__` block at the base and no longer does — is it still named in a run config?
// It does not judge commands that were already broken before the change.
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/run-commands-check.mjs" [DIR] [--base REF]
//        REF defaults to where this branch left main (git merge-base HEAD main), or HEAD on main itself — so it
//        checks the uncommitted and unmerged change. At a phase gate, pass the commit the phase started from.
// Exit: 0 = no run command points at something this change moved, deleted or gutted · 1 = REFUSED · 2 = cannot run
//       (not a git repository, or the base commit cannot be found — nothing compared is not a pass, Rule 29).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const bi = args.findIndex((a) => a === '--base' || a.startsWith('--base='));
const baseArg = bi < 0 ? null : args[bi].includes('=') ? args[bi].split('=')[1] : args[bi + 1];
const DIR = path.resolve(args.filter((a, i) => !a.startsWith('--') && (bi < 0 || i !== bi + 1))[0] ?? '.');

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
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* no commits yet */ }
  if (branch !== 'main' && branch !== 'master') {
    for (const ref of ['main', 'origin/main', 'master', 'origin/master']) {
      try { base = git('merge-base', 'HEAD', ref).trim(); break; } catch { /* try the next */ }
    }
  }
  base ??= 'HEAD';
}
try { git('rev-parse', '--verify', `${base}^{commit}`); } catch { cannot(`the base commit "${base}" cannot be found (pass one with --base REF)`); }

// What changed since the base, working tree included: D = deleted, R = renamed (old → new), M = modified.
const changes = git('diff', '-M', '--name-status', base, '--').split('\n').filter(Boolean).map((l) => l.split('\t'));
const gone = []; // [old path, new path or null]
const modifiedPy = [];
for (const [st, a, b] of changes) {
  if (st === 'D') gone.push([a, null]);
  else if (st.startsWith('R')) { gone.push([a, b]); if (b.endsWith('.py')) modifiedPy.push([a, b]); }
  else if (st === 'M' && a.endsWith('.py')) modifiedPy.push([a, a]);
}

// The run configs, as they are now.
const CONFIG = /(^|\/)(package\.json|Makefile|makefile|GNUmakefile|Procfile|Dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.gitlab-ci\.yml|vercel\.json|netlify\.toml|fly\.toml|pyproject\.toml|crontab|[\w.-]+\.cron)$/;
const tracked = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
const configs = tracked.filter((f) => (CONFIG.test(f) && !f.includes('node_modules/')) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map((f) => ({ f, lines: fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n') }));
const filesNamed = new Map();
for (const f of tracked) if (fs.existsSync(path.join(ROOT, f))) filesNamed.set(path.basename(f), [...(filesNamed.get(path.basename(f)) ?? []), f]);

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Where a config names `p`: the path from the project root or from the config's own folder, or (when nothing of that
// name is left anywhere, or the only one is p itself) the bare file name. Word edges are path edges: "a/x.py" and "x.py" match, "max.py" does not.
function mentions(p) {
  const hits = [];
  for (const { f, lines } of configs) {
    const fromConfig = path.relative(path.dirname(f), p);
    const forms = [p, fromConfig, `./${p}`, `./${fromConfig}`];
    const same = filesNamed.get(path.basename(p)) ?? [];
    if (!same.length || (same.length === 1 && same[0] === p)) forms.push(path.basename(p)); // the name is unambiguous
    const re = new RegExp(`(^|[\\s"'=(/:])(?:${[...new Set(forms)].map(esc).join('|')})(?=$|[\\s"';),:])`);
    lines.forEach((l, i) => { if (re.test(l) && !/^\s*#/.test(l)) hits.push(`${f}:${i + 1}`); });
  }
  return hits;
}

const problems = [];
for (const [oldPath, newPath] of gone) {
  if (!/\.(mjs|cjs|js|ts|mts|py|sh|rb)$/.test(oldPath)) continue;
  for (const where of mentions(oldPath))
    problems.push(`${where} still runs ${oldPath}, which this change ${newPath ? `moved to ${newPath}` : 'deleted'}`);
}
const hasMain = (src) => /__name__\s*==\s*['"]__main__['"]/.test(src);
for (const [oldPath, newPath] of modifiedPy) {
  let before = '';
  try { before = git('show', `${base}:${oldPath}`); } catch { continue; }
  const now = fs.existsSync(path.join(ROOT, newPath)) ? fs.readFileSync(path.join(ROOT, newPath), 'utf8') : '';
  if (!hasMain(before) || hasMain(now)) continue;
  for (const where of new Set([...mentions(newPath), ...(oldPath !== newPath ? mentions(oldPath) : [])]))
    problems.push(`${where} runs ${newPath}, which lost its \`if __name__ == "__main__":\` block in this change — it would import cleanly, exit 0 and do nothing`);
}

if (problems.length) {
  console.log(`run-commands-check: REFUSED — ${problems.length} run command(s) point at a file this change moved, deleted or emptied (compared with ${base.slice(0, 12)})`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`run-commands-check: OK — compared with ${base.slice(0, 12)}: ${gone.length} file(s) moved or deleted, ${modifiedPy.length} Python file(s) changed; no run config still points at one that moved, went or lost its run block`);
