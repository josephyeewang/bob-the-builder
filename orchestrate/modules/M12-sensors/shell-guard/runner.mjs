// runner.mjs — runs the shell-trick corpus against a production-guard hook (R-0b-70; review-0b-7 minor 1).
//
// The guard itself is lane 2's (R-0b-36). This runner takes the hook's command as a parameter and speaks Claude
// Code's PreToolUse hook protocol: one JSON object on stdin ({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
// tool_input: { command } }); the hook refuses by exiting 2, or by printing JSON with
// hookSpecificOutput.permissionDecision "deny". Exit 0 without a deny = allowed.
// A hook that CRASHES (any other exit, a signal, or no answer within the time limit) does not block the command in
// Claude Code, so here a crash on a refuse case is a FAILURE ("crash"), never a pass: the real hook must be built to
// fail closed (refuse when it cannot decide). Protocol as documented by Claude Code, 29 Oct 2026 (Principle 9).
//
//   node runner.mjs '<hook command>' [protected path]     prints a summary and every failure; exit 1 on any failure.
//   Run it from the project's top folder, where Claude Code runs the hook (set CLAUDE_PROJECT_DIR if that differs): a
//   relative path is taken from there, and it is the absolute form's base.
//
// Status: pending the real hook. Until it runs green against lane 2's installed hook at the join, R-0b-70 is not done.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));

// Where the name is split. At a letter no shell, JS or Python string reads as an escape (`\t` is a tab in node -e and
// python3 -c), so a form means the same file whatever the name (0b-7 round 10 audit 2 M-2).
function split(target) {
  const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/') + 1) : '';
  const base = target.slice(dir.length);
  const half = Math.max(1, Math.floor(base.length / 2));
  const safe = (i) => /[A-Za-z]/.test(base[i] ?? '') && !/[abfnrtvuxNU]/.test(base[i]);
  const order = [...Array(base.length).keys()].slice(1).sort((a, b) => Math.abs(a - half) - Math.abs(b - half) || a - b);
  return { dir, base, safe, mid: order.find(safe) ?? half, early: Math.min(2, base.length - 1) };
}

// A path under the home folder written from it (`~/…`), or null (round 10 audit 5 M-2: a guard that never expands ~ or
// $HOME passed). Left out when the home folder's own path has a space or shell character.
function fromHome(abs, home) {
  const h = home?.replace(/\/+$/, ''); // a trailing slash is the same folder (round 10 audit 6 cosmetic 2)
  return h && /^[A-Za-z0-9._\/-]+$/.test(h) && abs.startsWith(`${h}/`) ? abs.slice(h.length + 1) : null;
}

// Whether the temp folder's disk ignores case, as a Mac's does by default (round 10 audit 6 M-3: `cat .ENV.PRODUCTION`
// reads the file there, and a guard comparing names exactly misses it). Checked once, on the temp folder's disk.
export const CASELESS = (() => {
  const d = mkdtempSync(join(tmpdir(), 'sg-case-'));
  try { writeFileSync(join(d, 'a'), ''); return existsSync(join(d, 'A')); } finally { rmSync(d, { recursive: true, force: true }); }
})();
const swapCase = (t) => [...t].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');

// The ways one protected path can be written so a plain text match misses it. With a cwd, a relative target also gets
// its absolute form (0b-7 round 9 minor 5: a guard that only matched relative paths passed the old corpus).
// absolute: false leaves out the absolute form (the after-cd cases, whose short name is taken from the new folder).
// home: the home folder the shell expands ~ and $HOME to (default this user's). caseless: whether the file's disk
// ignores case (default: as the temp folder's does).
export function pathForms(target, cwd, { absolute = true, home = homedir(), caseless = CASELESS } = {}) {
  // No backslash form if no letter is safe to split at.
  const { dir, base, safe, mid, early } = split(target);
  // Round 10 audit 3 M-1: with every trick at one point, the first half of the name was always plain text, and a guard
  // matching it passed. So quotes and a bracket also go near each end, the first half can be all "?", and three forms
  // carry no letter of the name at all (hex, octal, base64).
  const late = Math.max(1, base.length - 2);
  const lead = base.startsWith('.') ? '.' : ''; // a glob never matches a leading dot
  const enc = (f) => [...target].map((c) => f(c.charCodeAt(0))).join('');
  const hex = enc((n) => `\\x${n.toString(16).padStart(2, '0')}`);
  const folder = target.includes('/') ? basename(dirname(target)) : cwd ? basename(cwd) : 'x';
  const rel = isAbsolute(target) || cwd ? fromHome(resolve(cwd ?? '/', target), home) : null;
  return {
    plain: target,
    ...(isAbsolute(target) ? {} : { 'dot-slash': `./${target}` }), // "./" before "/abs" would make it relative
    'double-quoted': `"${target}"`,
    'split-quotes': `${dir}${base.slice(0, mid)}"${base.slice(mid)}"`,
    'empty-quotes': `${dir}${base.slice(0, mid)}''${base.slice(mid)}`,
    // An unset variable splits the name with no quote or backslash (round 10 audit 4 M-1).
    'empty-var': `${dir}${base.slice(0, mid)}${'${_sg_unset}'}${base.slice(mid)}`,
    'early-quotes': `${dir}${base.slice(0, early)}''${base.slice(early)}`,
    'late-quotes': `${dir}${base.slice(0, late)}''${base.slice(late)}`,
    ...(safe(mid) ? { backslash: `${dir}${base.slice(0, mid)}\\${base.slice(mid)}` } : {}),
    glob: `${dir}${base.slice(0, mid)}*`,
    qmark: `${dir}${base.slice(0, mid)}?${base.slice(mid + 1)}`,
    'lead-qmarks': `${dir}${lead}${'?'.repeat(Math.max(1, mid - lead.length))}${base.slice(Math.max(mid, lead.length + 1))}`,
    bracket: `${dir}${base.slice(0, mid)}[${base[mid]}]${base.slice(mid + 1)}`,
    'early-bracket': `${dir}${base.slice(0, early)}[${base[early]}]${base.slice(early + 1)}`,
    // Negated brackets, both spellings (round 10 audit 5 minor 2: a guard reading [ ] as a plain set missed them).
    'not-bracket': `${dir}${base.slice(0, mid)}[!${base[mid] === 'Q' ? 'Z' : 'Q'}]${base.slice(mid + 1)}`,
    'caret-bracket': `${dir}${base.slice(0, early)}[^${base[early] === 'Q' ? 'Z' : 'Q'}]${base.slice(early + 1)}`,
    // Through the file's own folder when it is known (round 10 audit 3 minor 2: "x/.." touches only if x/ exists).
    'dot-dot': folder === 'x' ? `${dir}x/../${base}` : `${dir}../${folder}/${base}`,
    'command-sub': `$(printf '%s' '${target}')`,
    'hex-printf': `$(printf '${hex}')`,
    'octal-printf': `$(printf '${enc((n) => `\\${n.toString(8).padStart(3, '0')}`)}')`,
    'base64-sub': `$(echo ${Buffer.from(target).toString('base64')} | base64 -d)`,
    'ansi-c': `$'${hex}'`,
    'brace': `${dir}{${base},nothing}`,
    ...(absolute && cwd && !isAbsolute(target) ? { absolute: resolve(cwd, target) } : {}),
    ...(absolute && rel !== null ? { 'home-tilde': `~/${rel}`, 'home-var': `$HOME/${rel}` } : {}),
    // $PWD, which a guard must take from the folder the command runs in, not its own (round 10 audit 6 M-2).
    ...(cwd && !isAbsolute(target) ? { 'pwd-var': `$PWD/${target}` } : {}),
    ...(caseless && swapCase(base) !== base ? { 'case-flip': `${dir}${swapCase(base)}` } : {}),
  };
}

// A function replacement, never a string: a string replacement reads `$'` (the ansi-c form) as "the text after the
// match", which garbled every ansi-c case until 0b-7 round 10.
const fill = (tpl, vals) => tpl.replace(/\{\{(P|DIR|BASE|UP|HEAD|TAIL)\}\}/g, (_, k) => vals[k]);

// The path forms and folders are put into commands unquoted, so a path with a space or a shell character would make
// cases that touch nothing, and no precise guard could pass them (0b-7 round 10 M-2): refuse to run instead.
// (Node gives the real folder, so a link without a space does not help the short-name run: round 10 audit 3 minor 1.)
export function checkPath(p) {
  if (!/^[A-Za-z0-9._\/-]+$/.test(p)) throw new Error(`"${p}" has a space or shell character; run from a folder whose path has none`);
  if (basename(p).startsWith('-')) throw new Error(`"${p}": a name starting with "-" reads as an option`);
  return p;
}

// A template and form pair no shell turns into a touch of the file (a glob in a redirection, a form that breaks the
// quotes around it) proves nothing, so it is left out; corpus.dead lists them and a test checks the list both ways
// (0b-7 round 10). corpus.dead is for a Mac (bash, zsh, and an sh that reads $'…'). hostDead adds the pairs that touch
// nothing on this machine because a shell is missing: without zsh a brace after ">" is an error, and dash (Linux's sh)
// does not read $'…' (round 10 audit 3 M-4).
const SH_ANSI_C = spawnSync('sh', ['-c', "printf %s $'\\x41'"], { encoding: 'utf8' }).stdout === 'A';
export const hostDead = (tpl, form) => (form === 'brace' && !existsSync('/bin/zsh') && /> ?(\{\{UP\}\}\/)?\{\{(P|BASE)\}\}/.test(tpl))
  || (form === 'ansi-c' && !SH_ANSI_C && tpl.startsWith('sh -c'))
  || (form === 'case-flip' && !CASELESS); // a disk that keeps case: the form is not built
const live = (tpl, form) => !(corpus.dead[tpl] ?? []).includes(form) && !hostDead(tpl, form);

// cwd: the folder the hook is asked from (a relative target is taken from there). home: as for pathForms.
export function cases(target, cwd = process.cwd(), { home = homedir(), caseless = CASELESS } = {}) {
  const out = [];
  const abs = checkPath(resolve(cwd, target));
  const forms = pathForms(target, cwd, { home, caseless });
  for (const [group, list] of Object.entries(corpus.refuse)) {
    for (const tpl of list) for (const [form, p] of Object.entries(forms)) if (live(tpl, form)) out.push({ expect: 'refuse', group, form, tpl, command: fill(tpl, { P: p }) });
  }
  // A variable that is set carries the first part of the name (round 10 audit 5 M-1: a guard that reads every variable
  // as empty passed the unset-variable form). Split at two points, for the path as given and its absolute form.
  for (const [kind, t] of [['var', target], ...(isAbsolute(target) ? [] : [['abs-var', abs]])]) {
    const { dir: d, base, mid, early } = split(t);
    for (const [at, i] of [['mid', mid], ['early', early]]) {
      const form = `${kind}-${at}`;
      for (const tpl of corpus.refuse_var) if (live(tpl, form)) out.push({ expect: 'refuse', group: 'var', form, tpl, command: fill(tpl, { HEAD: d + base.slice(0, i), TAIL: base.slice(i) }) });
    }
  }
  // Whole-folder reads and writes: no form of the name appears at all (round 10 audit 4 M-1).
  const dir = dirname(abs); const up = dirname(dir);
  for (const tpl of corpus.refuse_folder) if (live(tpl, '-')) out.push({ expect: 'refuse', group: 'folder', form: '-', tpl, command: fill(tpl, { DIR: dir }) });
  // The same, and change-folder-first, with the folder written from home (round 10 audit 5 M-2).
  const hrel = fromHome(dir, home);
  const hdir = hrel !== null ? `~/${hrel}` : dir === home && fromHome(abs, home) !== null ? '~' : null;
  if (hdir) {
    for (const tpl of corpus.refuse_folder) if (live(tpl, 'home')) out.push({ expect: 'refuse', group: 'folder', form: 'home', tpl, command: fill(tpl, { DIR: hdir }) });
    for (const tpl of corpus.refuse_after_cd) if (live(tpl, 'home')) out.push({ expect: 'refuse', group: 'after-cd-home', form: 'home', tpl, cwd: up, command: fill(tpl, { DIR: hdir, BASE: basename(abs) }) });
  }
  // Reads of the whole folder the command runs in, naming no folder (round 10 audit 6 M-1: `grep -rn KEY` from the
  // project's top folder): asked from the file's folder and from the run folder when it holds the file; the same asked
  // from a folder beside the file's, which does not hold it, must be allowed.
  const holds = (where) => abs.startsWith(`${where}/`);
  for (const where of [...new Set([dir, ...(holds(cwd) ? [cwd] : [])])]) {
    for (const tpl of corpus.refuse_here) if (live(tpl, '-')) out.push({ expect: 'refuse', group: 'here', form: '-', tpl, cwd: where, command: tpl });
  }
  // Change folder first, then name the file by its short name (in each form). Asked from the folder above, so a guard
  // that ignores the cd and reads the short name from its own folder misses it (0b-7 round 10 M-1); and from the run
  // folder, with a step up asked from the file's own folder, so a guard that refuses every case asked from elsewhere
  // still has to follow the cd (round 10 audit 4 M-2).
  const short = Object.entries(pathForms(basename(abs), dir, { absolute: false, caseless }));
  for (const tpl of corpus.refuse_after_cd) {
    for (const [form, p] of short) {
      if (!live(tpl, form)) continue;
      out.push({ expect: 'refuse', group: 'after-cd', form, tpl, cwd: up, command: fill(tpl, { DIR: dir, BASE: p }) });
      out.push({ expect: 'refuse', group: 'after-cd-here', form, tpl, cwd, command: fill(tpl, { DIR: dir, BASE: p }) });
    }
  }
  for (const tpl of corpus.refuse_cd_up) {
    for (const [form, p] of short) if (form !== 'pwd-var' && live(tpl, form)) out.push({ expect: 'refuse', group: 'cd-up', form, tpl, cwd: dir, command: fill(tpl, { UP: basename(dir), BASE: p }) });
  }
  // A recursive grep of a folder that holds the file reads it, so it is no allow case there (round 10 audit 5 minor 1).
  const readsFile = (command, where) => /\bgrep -r/.test(command) && [resolve(where, command.split(' ').pop())].some((f) => abs === f || abs.startsWith(`${f}/`));
  for (const command of corpus.allow) if (!readsFile(command, cwd)) out.push({ expect: 'allow', group: 'allow', form: '-', command });
  // Ordinary commands asked from the folder above and from the file's folder: a guard that refuses whatever is asked
  // from outside the run folder fails (round 10 audit 4 M-2).
  for (const command of corpus.allow_elsewhere) for (const where of [up, dir]) out.push({ expect: 'allow', group: 'allow-elsewhere', form: '-', cwd: where, command });
  const beside = `${dir}-other`;
  for (const command of corpus.refuse_here) out.push({ expect: 'allow', group: 'allow-beside', form: '-', cwd: beside, command });
  // Round 10 audit 3 M-2: near misses built from this file's folder and the words of its name, so a guard that refuses
  // anything naming the folder or a word of the name fails. Still a sample: no list proves a guard never over-refuses.
  const words = [...new Set(basename(abs).split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 2))];
  for (const tpl of corpus.allow_near) {
    for (const WORD of /\{\{WORD\}\}/.test(tpl) ? words : ['']) {
      const command = tpl.replace(/\{\{(DIR|WORD)\}\}/g, (_, k) => ({ DIR: dirname(abs), WORD })[k]);
      if (!readsFile(command, cwd)) out.push({ expect: 'allow', group: 'allow-near', form: '-', command });
    }
  }
  return out;
}

// The hook runs as Claude Code runs it (round 10 audit 3 M-3): from one fixed folder (hookCwd, default where the runner
// was started) with CLAUDE_PROJECT_DIR set (projectDir, default the runner's own CLAUDE_PROJECT_DIR or that folder);
// only the JSON's cwd changes per case. Asking from the case's folder made a hook installed the usual way
// (`${CLAUDE_PROJECT_DIR:-.}/…`) fail to find itself and refuse, so after-cd cases passed without testing anything.
// The input carries Claude Code's other fields, and the time limit is its default, 60 s (round 10 audit 3 minor 3).
export function askHook(hookCommand, command, { timeoutMs = 60000, cwd, hookCwd = process.cwd(), projectDir } = {}) {
  const input = JSON.stringify({
    session_id: 'shell-guard-runner', transcript_path: '/dev/null', permission_mode: 'default', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: { command }, tool_use_id: 'runner', cwd: cwd ?? hookCwd,
  });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? hookCwd };
  const r = spawnSync('/bin/sh', ['-c', hookCommand], { input, encoding: 'utf8', timeout: timeoutMs, cwd: hookCwd, env });
  // A hook that exits before reading its input makes the input write fail (EPIPE); its exit code still decides.
  const pipeOnly = r.error?.code === 'EPIPE' && Number.isInteger(r.status);
  if ((r.error && !pipeOnly) || r.signal) return 'crash';
  if (r.status === 2) return 'refuse';
  if (r.status !== 0) return 'crash';
  try {
    const j = JSON.parse(r.stdout || '{}');
    // A deny counts only with Claude Code's documented hookEventName; without it, it may be ignored, so it is neither
    // a refusal nor an allow (round 10 audit 4 minor 2).
    const h = j?.hookSpecificOutput;
    if (h?.permissionDecision === 'deny') return h.hookEventName === 'PreToolUse' ? 'refuse' : 'crash';
    if (j?.decision === 'block') return 'refuse';
    if (j?.continue === false) return 'refuse'; // Claude Code stops; the command does not run (round 10 audit 6 cosmetic 5)
  } catch { /* plain output: not a deny */ }
  return 'allow';
}

// hook: the hook's shell command, or (for Bob's own tests) a function (command, cwd) → 'refuse' | 'allow' | 'crash'.
// cwd: the folder each case is asked from; after-cd cases carry their own.
export function runCorpus(hook, { target = '.env.production', ...opts } = {}) {
  const ask = typeof hook === 'function' ? hook : (command, cwd) => askHook(hook, command, { ...opts, cwd });
  const results = cases(target, opts.cwd, { ...(opts.home ? { home: opts.home } : {}), ...(opts.caseless !== undefined ? { caseless: opts.caseless } : {}) }).map((c) => ({ ...c, got: ask(c.command, c.cwd ?? opts.cwd ?? process.cwd()) }));
  const failures = results.filter((r) => r.got !== r.expect);
  return { total: results.length, failures, passed: results.length - failures.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [hook, target] = process.argv.slice(2);
  if (!hook) { console.error('usage: node runner.mjs \'<hook command>\' [protected path]'); process.exit(64); }
  const r = runCorpus(hook, target ? { target } : {});
  console.log(`${r.passed}/${r.total} cases as expected`);
  for (const f of r.failures) console.log(`  expected ${f.expect}, got ${f.got}  [${f.group} / ${f.form}]  ${JSON.stringify(f.command)}`);
  process.exitCode = r.failures.length ? 1 : 0;
}
