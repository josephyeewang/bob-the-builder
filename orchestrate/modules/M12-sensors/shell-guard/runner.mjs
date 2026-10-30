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
//
// Status: pending the real hook. Until it runs green against lane 2's installed hook at the join, R-0b-70 is not done.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));

// The ways one protected path can be written so a plain text match misses it.
export function pathForms(target) {
  const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/') + 1) : '';
  const base = target.slice(dir.length);
  const mid = Math.max(1, Math.floor(base.length / 2));
  const hex = [...target].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  return {
    plain: target,
    'dot-slash': `./${target}`,
    'double-quoted': `"${target}"`,
    'split-quotes': `${dir}${base.slice(0, mid)}"${base.slice(mid)}"`,
    'empty-quotes': `${dir}${base.slice(0, mid)}''${base.slice(mid)}`,
    backslash: `${dir}${base.slice(0, mid)}\\${base.slice(mid)}`,
    glob: `${dir}${base.slice(0, mid)}*`,
    'dot-dot': `${dir}x/../${base}`,
    'command-sub': `$(printf '%s' '${target}')`,
    'hex-printf': `$(printf '${hex}')`,
    'ansi-c': `$'${hex}'`,
    'brace': `${dir}{${base},nothing}`,
  };
}

export function cases(target) {
  const out = [];
  const forms = pathForms(target);
  for (const [group, list] of Object.entries(corpus.refuse)) {
    for (const tpl of list) for (const [form, p] of Object.entries(forms)) out.push({ expect: 'refuse', group, form, command: tpl.replaceAll('{{P}}', p) });
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

// hook: the hook's shell command, or (for Bob's own tests) a function command → 'refuse' | 'allow' | 'crash'.
export function runCorpus(hook, { target = '.env.production', ...opts } = {}) {
  const ask = typeof hook === 'function' ? hook : (command) => askHook(hook, command, opts);
  const results = cases(target).map((c) => ({ ...c, got: ask(c.command) }));
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
