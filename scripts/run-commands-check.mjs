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
//      to the folder the command runs in: the workflow's or job's `defaults.run.working-directory`, the step's own
//      `working-directory:`, and any literal `cd <folder>` earlier in the same command or block;
//   2. a Python file run as a script has a `__main__` block, unless it is plainly a script (top-level code beyond
//      imports, definitions and constants). A file of only imports, or one that defines main() and never calls it,
//      is the "imports cleanly, does nothing" shape.
// Not judged (counted as skipped): paths or folders built from variables ($X, ${{ … }}), absolute or ~ paths, build
// output (dist/, build/, out/, .next/, node_modules/, target/, or a folder the project's .gitignore lists — it does
// not exist on a clean checkout), and `python -m` of a module that is not a package in the project (an installed tool).
// Calibrated before it shipped (D-033): two fresh reviews tried many healthy command shapes on purpose (monorepo
// filters, continued Makefile lines, heredocs, nested shells, Windows paths …), and each shape it got wrong was fixed
// by skipping what it cannot read for sure; it then raised no false alarm on the real projects it was tried on. It
// prefers missing a break to crying wolf. Shapes it does not read: pyproject.toml entry points, and folder changes
// made any way other than a literal cd.
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/run-commands-check.mjs" [DIR]
// Exit: 0 = every run command that names a project file points at one that runs (or nothing runs a project file
//       directly, e.g. only `vite build`) · 1 = REFUSED · 2 = cannot run (no package.json, workflow or Makefile to
//       read — nothing read is not a pass, Rule 29).

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const rel = (p) => path.relative(DIR, p) || '.';
const problems = [];
const skipped = [];
let checked = 0;
let sources = 0;

// Collect { where, text, base } for every run command; base null = the folder is built from a variable.
const runs = [];
const wd = (base, dir) => (base === null || /[$`{}~]/.test(dir) ? null : path.resolve(base, dir));
if (fs.existsSync(path.join(DIR, 'package.json'))) {
  sources++;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) runs.push({ where: `package.json "${k}"`, text: String(v), base: DIR });
  } catch (e) {
    problems.push(`package.json is not valid JSON (${e.message})`);
  }
}
const wfDir = path.join(DIR, '.github', 'workflows');
const workflows = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
sources += workflows.length;
const defaultsWd = (lines, i) => {
  // `defaults:` → `run:` → `working-directory: X`, all indented under the defaults line.
  const ind = lines[i].search(/\S/);
  for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > ind); j++) {
    const w = lines[j].match(/^\s*working-directory:\s*["']?([^"'#\s]+)/);
    if (w) return w[1];
  }
  return null;
};
for (const f of workflows) {
  const lines = fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n');
  let topKey = null, workflowWd = null, jobWd = null, jobIndent = null;
  // Folders a checkout step fills (`path: tools`) hold files that only exist once the job runs.
  const checkedOut = new Set();
  lines.forEach((l, i) => {
    if (!/uses:\s*actions\/checkout/.test(l)) return;
    for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 8); j++) {
      const pm = lines[j].match(/^\s*path:\s*["']?([^"'#\s]+)/);
      if (pm) checkedOut.add(pm[1].split('/')[0]);
    }
  });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const top = l.match(/^([\w-]+):/);
    if (top) { topKey = top[1]; jobIndent = null; if (topKey === 'defaults') workflowWd = defaultsWd(lines, i); continue; }
    if (topKey === 'jobs' && l.trim() && !l.trim().startsWith('#')) {
      const ind = l.search(/\S/);
      if (jobIndent === null) jobIndent = ind;
      if (ind === jobIndent && /^\s*[\w-]+:\s*$/.test(l)) { jobWd = null; continue; } // a new job, at any indent
      if (ind > jobIndent && /^\s*defaults:\s*$/.test(l)) { jobWd = defaultsWd(lines, i); continue; }
    }
    const m = l.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!m || topKey !== 'jobs') continue;
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
    let base = DIR;
    for (const d of [workflowWd, jobWd, stepWd]) if (d) base = wd(base, d);
    const where = `.github/workflows/${f}:${i + 1}`;
    if (m[2].trim() && !/^[|>][-+]?\s*$/.test(m[2].trim())) runs.push({ where, text: m[2].trim().replace(/^(["'])(.*)\1$/, '$2'), base, checkedOut });
    else {
      const indent = (lines[i + 1] ?? '').search(/\S/);
      const block = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) >= indent); j++) block.push(lines[j]);
      runs.push({ where, text: block.join('\n'), base, checkedOut });
    }
  }
}
const seenMake = new Set();
for (const mk of ['GNUmakefile', 'Makefile', 'makefile']) {
  const p = path.join(DIR, mk);
  if (!fs.existsSync(p) || seenMake.has(fs.statSync(p).ino)) continue; // one file on a case-insensitive disk
  seenMake.add(fs.statSync(p).ino);
  sources++;
  const ml = fs.readFileSync(p, 'utf8').split('\n');
  for (let i = 0; i < ml.length; i++) {
    if (!ml[i].startsWith('\t')) continue;
    // A recipe line ending in "\" continues on the next line: `cd backend && \` + `python manage.py test` is one command.
    const start = i;
    let text = ml[i].trim().replace(/^[@-]+/, '');
    while (text.endsWith('\\') && i + 1 < ml.length) text = `${text.slice(0, -1)} ${ml[++i].trim()}`;
    runs.push({ where: `${mk}:${start + 1}`, text, base: DIR });
  }
}

if (!sources) {
  process.stderr.write(`run-commands-check: no package.json, .github/workflows/*.yml or Makefile in ${DIR} — nothing to read, which is not a pass (Rule 29).\n`);
  process.exit(2);
}

// Build output and ignored folders do not exist on a clean checkout, so a command that runs from them is not judged.
const BUILT = new Set(['dist', 'build', 'out', '.next', '.nuxt', '.output', 'node_modules', 'target', 'coverage', '.venv', 'venv']);
for (const l of fs.existsSync(path.join(DIR, '.gitignore')) ? fs.readFileSync(path.join(DIR, '.gitignore'), 'utf8').split('\n') : []) {
  const t = l.trim().replace(/^\/|\/$/g, '');
  if (t && !t.startsWith('#') && !t.startsWith('!') && !/[*?[\]]/.test(t) && !t.includes('/')) BUILT.add(t);
}

// Only a command that STARTS with an interpreter and a file is judged, so `echo "usage: node cli.js"` is not a command.
// Anything this cannot read for sure is skipped, never guessed: a nested shell (`bash -c "…"`), inline code (-e, -c),
// a monorepo filter (--filter, --prefix, --workspace, -w, -C, --dir), a Windows path, a path built from a variable.
const INTERPS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'deno', 'python', 'python3', 'bash', 'sh', 'zsh', 'ruby']);
const WRAPPERS = /^(?:(?:time|exec|sudo|env|command|nohup)\s+|npx\s+(?:--yes\s+|-y\s+)?|bunx\s+|pnpm\s+exec\s+|npm\s+exec\s+(?:--\s+)?|yarn\s+(?:exec\s+)?|uv\s+run\s+|poetry\s+run\s+|pipenv\s+run\s+|deno\s+run\s+(?:-\S+\s+)*|bun\s+run\s+)/;
const UNKNOWN_DIR = /(?:^|\s)(?:--filter|--prefix|--workspace|--dir|--cwd|-w|-C)(?:[=\s]|$)/;
const VALUE_OPTS = new Set(['--import', '-r', '--require', '--loader', '--experimental-loader', '--env-file', '-W', '-X', '--inspect-port']);
const INLINE = new Set(['-e', '--eval', '-p', '--print', '-c']);
const SCRIPT = /\.(?:mjs|cjs|js|ts|mts|py|sh|rb)$/;
const unquote = (t) => t.replace(/^(["'])(.*)\1$/, '$2');

// → { file } or { module } or null (not a command that runs a project file, or not readable for sure)
function target(piece) {
  let c = piece.trim().replace(/^\(\s*/, '').replace(/\)\s*$/, '');
  c = c.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ''); // FOO=1 node x.js
  if (UNKNOWN_DIR.test(c.split(/\s+/).slice(0, 4).join(' '))) return null;
  for (let k = 0; k < 4 && WRAPPERS.test(c); k++) c = c.replace(WRAPPERS, '').replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
  const toks = c.split(/\s+/).map(unquote);
  if (!toks[0]) return null;
  if (/^\.\.?\//.test(toks[0])) return SCRIPT.test(toks[0]) ? { file: toks[0] } : null; // ./run.sh
  if (!INTERPS.has(toks[0])) return null;
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k];
    if (INLINE.has(t)) return null;
    if (t === '-m' && /^python/.test(toks[0])) return toks[k + 1] ? { module: toks[k + 1] } : null;
    if (VALUE_OPTS.has(t)) { k++; continue; }
    if (t.startsWith('-')) continue;
    return SCRIPT.test(t) ? { file: t } : null;
  }
  return null;
}

// Strip heredoc bodies, and name the files a block writes (curl -o x, > x, tee x, cat > x) so running them is not judged.
function prepare(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const h = lines[i].match(/<<-?\s*["']?(\w+)["']?/);
    if (h) while (i + 1 < lines.length && lines[i + 1].trim() !== h[1]) i++;
  }
  const body = out.join('\n');
  const written = new Set();
  for (const m of body.matchAll(/(?:\s-o|--output[=\s]|>{1,2}|\btee(?:\s+-a)?)\s*["']?([^\s"';|&]+)/g)) written.add(path.normalize(m[1]));
  return { body, written };
}

function pyDoesNothing(src) {
  if (/__name__\s*==\s*['"]__main__['"]/.test(src)) return false;
  const top = src.split('\n').filter((l) => l.trim() && !/^\s/.test(l) && !l.startsWith('#'));
  const inert = (l) => /^(import |from |def |async def |class |@|__all__|[A-Z_][A-Z0-9_]*\s*[:=]|"""|'''|\)|\]|\})/.test(l);
  return top.length > 0 && top.every(inert) && (top.every((l) => /^(import |from |__all__)/.test(l)) || /^def main\s*\(/m.test(src));
}

function judge(where, file, base, made = new Set()) {
  if (base === null || /[$`{}*\\]/.test(file) || path.isAbsolute(file) || file.startsWith('~')) { skipped.push(`${where}: ${file}`); return; }
  const full = path.resolve(base, file);
  if (rel(full).split(path.sep).some((seg) => BUILT.has(seg) || made.has(seg)) || made.has(path.normalize(file))) { skipped.push(`${where}: ${file} (made at run time)`); return; }
  checked++;
  if (!fs.existsSync(full)) { problems.push(`${where}: runs ${file}, which does not exist (looked in ${rel(base)}/)`); return; }
  if (full.endsWith('.py') && pyDoesNothing(fs.readFileSync(full, 'utf8')))
    problems.push(`${where}: runs ${file}, which has no \`if __name__ == "__main__":\` block and only imports or defines — it would import cleanly, exit 0 and do nothing`);
}

function judgeModule(where, mod, base) {
  if (base === null) { skipped.push(`${where}: python -m ${mod}`); return; }
  const parts = mod.split('.');
  const p = parts.join('/');
  for (const root of ['', 'src/']) {
    const at = (x) => path.resolve(base, root + x);
    if (parts.length === 1 && fs.existsSync(at(`${p}.py`))) {
      checked++;
      if (pyDoesNothing(fs.readFileSync(at(`${p}.py`), 'utf8'))) problems.push(`${where}: runs python -m ${mod}; ${root}${p}.py has no __main__ block and only imports or defines — it would do nothing`);
      return;
    }
    // Only a package that lives in the project is judged; anything else is an installed tool (pip, alembic, uvicorn …).
    if (!fs.existsSync(at(`${parts[0]}/__init__.py`))) continue;
    checked++;
    if (fs.existsSync(at(`${p}/__main__.py`))) return;
    if (parts.length > 1 && fs.existsSync(at(`${p}.py`))) {
      if (pyDoesNothing(fs.readFileSync(at(`${p}.py`), 'utf8'))) problems.push(`${where}: runs python -m ${mod}; ${root}${p}.py has no __main__ block and only imports or defines — it would do nothing`);
      return;
    }
    problems.push(`${where}: runs python -m ${mod}, but neither ${root}${p}.py nor ${root}${p}/__main__.py exists`);
    return;
  }
}

for (const { where, text, base, checkedOut } of runs) {
  const { body, written } = prepare(text.replace(/(^|\s)#.*$/gm, '$1'));
  const made = new Set([...written, ...(checkedOut ?? [])]);
  // Walk the command piece by piece so an earlier `cd folder` moves where later pieces run.
  let cwd = base;
  for (const piece of body.split(/\n|&&|\|\||;/)) {
    const cd = piece.match(/^\s*\(?\s*(?:cd|pushd)\s+["']?([^\s"';)]+)/);
    if (cd) { cwd = cd[1] === '-' ? null : wd(cwd, cd[1]); continue; }
    const t = target(piece);
    if (t?.file) judge(where, t.file, cwd, made);
    else if (t?.module) judgeModule(where, t.module, cwd);
  }
}

if (problems.length) {
  console.log(`run-commands-check: REFUSED — ${problems.length} run command(s) point at a file that is missing or does nothing`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
const note = skipped.length ? ` (${skipped.length} not judged: built from variables, absolute, or build output)` : '';
if (!checked) console.log(`run-commands-check: OK — nothing here runs a project file directly (only tools such as \`vite build\`)${note}`);
else console.log(`run-commands-check: OK — ${checked} run command(s) point at files that exist and run${note}`);
