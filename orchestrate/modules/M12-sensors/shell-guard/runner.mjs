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
//   Run it from the folder a relative path is taken from: that folder is the hook's cwd and, for a relative path, the
//   absolute form's base.
//
// Status: pending the real hook. Until it runs green against lane 2's installed hook at the join, R-0b-70 is not done.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));

// The ways one protected path can be written so a plain text match misses it. With a cwd, a relative target also gets
// its absolute form (0b-7 round 9 minor 5: a guard that only matched relative paths passed the old corpus).
export function pathForms(target, cwd) {
  const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/') + 1) : '';
  const base = target.slice(dir.length);
  // Split at a letter no shell, JS or Python string reads as an escape (`\t` is a tab in node -e and python3 -c), so a
  // form means the same file whatever the name (0b-7 round 10 audit 2 M-2); the middle if no letter qualifies.
  const half = Math.max(1, Math.floor(base.length / 2));
  const safe = (i) => /[A-Za-z]/.test(base[i] ?? '') && !/[abfnrtvuxNU]/.test(base[i]);
  const order = [...Array(base.length).keys()].slice(1).sort((a, b) => Math.abs(a - half) - Math.abs(b - half) || a - b);
  const mid = order.find(safe) ?? half;
  const hex = [...target].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  return {
    plain: target,
    ...(isAbsolute(target) ? {} : { 'dot-slash': `./${target}` }), // "./" before "/abs" would make it relative
    'double-quoted': `"${target}"`,
    'split-quotes': `${dir}${base.slice(0, mid)}"${base.slice(mid)}"`,
    'empty-quotes': `${dir}${base.slice(0, mid)}''${base.slice(mid)}`,
    backslash: `${dir}${base.slice(0, mid)}\\${base.slice(mid)}`,
    glob: `${dir}${base.slice(0, mid)}*`,
    qmark: `${dir}${base.slice(0, mid)}?${base.slice(mid + 1)}`,
    bracket: `${dir}${base.slice(0, mid)}[${base[mid]}]${base.slice(mid + 1)}`,
    'dot-dot': `${dir}x/../${base}`,
    'command-sub': `$(printf '%s' '${target}')`,
    'hex-printf': `$(printf '${hex}')`,
    'ansi-c': `$'${hex}'`,
    'brace': `${dir}{${base},nothing}`,
    ...(cwd && !isAbsolute(target) ? { absolute: resolve(cwd, target) } : {}),
  };
}

// A function replacement, never a string: a string replacement reads `$'` (the ansi-c form) as "the text after the
// match", which garbled every ansi-c case until 0b-7 round 10.
const fill = (tpl, vals) => tpl.replace(/\{\{(P|DIR|BASE)\}\}/g, (_, k) => vals[k]);

// The path forms and folders are put into commands unquoted, so a path with a space or a shell character would make
// cases that touch nothing, and no precise guard could pass them (0b-7 round 10 M-2): refuse to run instead.
export function checkPath(p) {
  if (!/^[A-Za-z0-9._\/-]+$/.test(p)) throw new Error(`"${p}" has a space or shell character; run from a folder whose path has none (a link to it works)`);
  return p;
}

// A template and form pair no shell turns into a touch of the file (a glob in a redirection, a form that breaks the
// quotes around it) proves nothing, so it is left out; corpus.dead lists them and a test checks the list both ways
// (0b-7 round 10).
const live = (tpl, form) => !(corpus.dead[tpl] ?? []).includes(form);

// cwd: the folder the hook is asked from (a relative target is taken from there).
export function cases(target, cwd = process.cwd()) {
  const out = [];
  const abs = checkPath(resolve(cwd, target));
  const forms = pathForms(target, cwd);
  for (const [group, list] of Object.entries(corpus.refuse)) {
    for (const tpl of list) for (const [form, p] of Object.entries(forms)) if (live(tpl, form)) out.push({ expect: 'refuse', group, form, tpl, command: fill(tpl, { P: p }) });
  }
  // Change folder first, then name the file by its short name (in each form). Asked from the folder above, so a guard
  // that ignores the cd and reads the short name from its own folder misses it (0b-7 round 10 M-1).
  const up = dirname(dirname(abs));
  for (const tpl of corpus.refuse_after_cd) {
    for (const [form, p] of Object.entries(pathForms(basename(abs)))) if (live(tpl, form)) out.push({ expect: 'refuse', group: 'after-cd', form, tpl, cwd: up, command: fill(tpl, { DIR: dirname(abs), BASE: p }) });
  }
  for (const command of corpus.allow) out.push({ expect: 'allow', group: 'allow', form: '-', command });
  return out;
}

export function askHook(hookCommand, command, { timeoutMs = 5000, cwd } = {}) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: cwd ?? process.cwd() });
  const r = spawnSync('/bin/sh', ['-c', hookCommand], { input, encoding: 'utf8', timeout: timeoutMs, cwd });
  // A hook that exits before reading its input makes the input write fail (EPIPE); its exit code still decides.
  const pipeOnly = r.error?.code === 'EPIPE' && Number.isInteger(r.status);
  if ((r.error && !pipeOnly) || r.signal) return 'crash';
  if (r.status === 2) return 'refuse';
  if (r.status !== 0) return 'crash';
  try {
    const j = JSON.parse(r.stdout || '{}');
    if (j?.hookSpecificOutput?.permissionDecision === 'deny' || j?.decision === 'block') return 'refuse';
  } catch { /* plain output: not a deny */ }
  return 'allow';
}

// hook: the hook's shell command, or (for Bob's own tests) a function (command, cwd) → 'refuse' | 'allow' | 'crash'.
// cwd: the folder each case is asked from; after-cd cases carry their own.
export function runCorpus(hook, { target = '.env.production', ...opts } = {}) {
  const ask = typeof hook === 'function' ? hook : (command, cwd) => askHook(hook, command, { ...opts, cwd });
  const results = cases(target, opts.cwd).map((c) => ({ ...c, got: ask(c.command, c.cwd ?? opts.cwd ?? process.cwd()) }));
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
