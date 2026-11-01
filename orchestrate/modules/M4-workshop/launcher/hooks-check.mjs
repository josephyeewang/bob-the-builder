// Launch checks 7 and 8 (R-0b-37, R-0b-40).
//
// Check 7: every policy hook in the role file blocks on failure with a 10 s limit; every script
// sits in the Do-plane hook folder, readable and runnable, byte-identical to the module's copy;
// each one, run once on a harmless and on a harmful canned call, answers in time and correctly
// (so a broken, missing, slow or always-passing hook stops the launch). Claude Code is the pinned
// version, at least the floor, and runs from its own versioned folder.
// Check 8: the rules snapshot is present and fresh (hooks/snapshot.mjs).

import { readFileSync, readdirSync, accessSync, copyFileSync, chmodSync, mkdirSync, constants as C } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { POLICY_HOOKS, HOOK_TIMEOUT, HOOK_FAILS_CLOSED } from './render-settings.mjs';
import { SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E, MIN_CLAUDE_CODE, FLAGS } from './settings-names.mjs';
import { sha256 } from './role-profiles.mjs';
import { readSnapshot } from '../hooks/snapshot.mjs';

export const HOOKS_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const refuse = (reason) => ({ ok: false, reason });
const isScript = (n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs');

/** Copies the hook folder (scripts only, no tests) into the Do-plane folder, mode 755. */
export function installHooks(dest, source = HOOKS_SOURCE) {
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(source).filter(isScript)) { copyFileSync(join(source, n), join(dest, n)); chmodSync(join(dest, n), 0o755); }
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
const VERSION = /^\d+\.\d+\.\d+$/;

/** The pinned copy's folder layout: <root>/claude-code/<pin>/claude. */
export const pinnedBinary = (root, pin) => join(root, 'claude-code', pin, 'claude');

export function checkVersion({ claudeBin, root, pin, run = (bin, a) => execFileSync(bin, a, { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' } }) }) {
  if (typeof pin !== 'string' || !VERSION.test(pin)) return refuse('the rules pin no Claude Code version');
  if (compareVersions(pin, MIN_CLAUDE_CODE) < 0) return refuse(`the pinned version ${pin} is below ${MIN_CLAUDE_CODE}`);
  if (claudeBin !== pinnedBinary(root, pin)) return refuse('Claude Code is not started from its pinned folder');
  let out; try { out = run(claudeBin, [FLAGS.version]); } catch { return refuse('Claude Code did not report its version'); }
  const m = /(\d+\.\d+\.\d+)/.exec(String(out));
  if (!m) return refuse('Claude Code did not report its version');
  if (m[1] !== pin) return refuse(`Claude Code is ${m[1]}, the rules pin ${pin}`);
  return { ok: true, version: m[1] };
}

// One harmless and one harmful canned call per hook. The harmful one must be blocked (exit 2).
export function probes({ copy, outbox, kind }) {
  return {
    'plain-files': [{ tool_name: 'Write', tool_input: { file_path: `${outbox}${sep}${kind}probe-1.md` } }, { tool_name: 'Write', tool_input: { file_path: `${copy ?? outbox}${sep}.git${sep}config` } }],
    'secret-file-block': [{ tool_name: 'Bash', tool_input: { command: 'true' } }, { tool_name: 'Read', tool_input: { file_path: `${outbox}${sep}.env` } }],
    'production-write-guard': [{ tool_name: 'Bash', tool_input: { command: 'true' } }, null],
    'merge-guard': [{ tool_name: 'Bash', tool_input: { command: 'true' } }, { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } }],
    'no-verify-block': [{ tool_name: 'Bash', tool_input: { command: 'true' } }, { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } }],
  };
}

// render-settings refuses spaces inside paths. Every command must end with HOOK_FAILS_CLOSED (L75 (c)), so a hook that
// can't run blocks; the words before it are the node, the script and its arguments. → the words, or null.
function splitCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.endsWith(HOOK_FAILS_CLOSED)) return null;
  return cmd.slice(0, -HOOK_FAILS_CLOSED.length).split(' ');
}

/** The production guard's harmful probe: run the first program the rules list as production. */
export const productionProbe = (rules) => {
  const prog = rules?.production?.programs?.[0];
  return typeof prog === 'string' ? { tool_name: 'Bash', tool_input: { command: `${prog} deploy` } } : null;
};

/**
 * Check 7 for one role file. `settings` is the role file as read back; `hooksDir` the Do-plane
 * folder; `harmfulProduction` is the production guard's harmful probe (productionProbe).
 * `timeoutMs` is the probe limit; it is the hook limit except in tests.
 */
export function checkHooks({ settings, hooksDir, source = HOOKS_SOURCE, kinds, copy, outbox, run = spawnSync, harmfulProduction, timeoutMs = HOOK_TIMEOUT * 1000 }) {
  const pre = settings?.[S.hooks]?.[E.preToolUse];
  if (!Array.isArray(pre)) return refuse('the role file has no tool hooks');
  // Byte identity of the whole folder, both ways.
  let srcFiles; let dstFiles;
  try { srcFiles = readdirSync(source).filter(isScript).sort(); dstFiles = readdirSync(hooksDir).filter((n) => n.endsWith('.mjs')).sort(); } catch { return refuse('the hook folder is missing'); }
  if (JSON.stringify(srcFiles) !== JSON.stringify(dstFiles)) return refuse('the hook folder holds different files from the module copy');
  for (const n of srcFiles) {
    let a; let b;
    try { a = readFileSync(join(source, n)); b = readFileSync(join(hooksDir, n)); } catch { return refuse(`hook ${n} is unreadable`); }
    if (sha256(a) !== sha256(b)) return refuse(`hook ${n} differs from the module copy`);
  }
  if (!Array.isArray(kinds) || !kinds.length) return refuse('the role has no outbox kinds');
  const canned = probes({ copy, outbox, kind: kinds[0] });
  canned['production-write-guard'][1] = harmfulProduction;
  for (const [name, matcher] of Object.entries(POLICY_HOOKS)) {
    const entry = pre.find((m) => m?.[H.matcher] === matcher && m?.[H.hooks]?.some((h) => h?.[H.command]?.includes(`/${name}.mjs `)));
    if (!entry) return refuse(`the ${name} hook is not in the role file`);
    for (const h of entry[H.hooks]) {
      if (h[H.type] !== 'command') return refuse(`the ${name} hook is not a command`);
      if (h[H.onFailure] !== 'block') return refuse(`the ${name} hook does not block on failure`);
      if (h[H.timeout] !== HOOK_TIMEOUT) return refuse(`the ${name} hook's time limit is not ${HOOK_TIMEOUT} s`);
      const words = splitCommand(h[H.command]);
      if (!words) return refuse(`the ${name} hook does not exit 2 when it fails to run`);
      const [node, script, ...argv] = words;
      if (script !== join(hooksDir, `${name}.mjs`)) return refuse(`the ${name} hook runs a script outside the hook folder`);
      try { accessSync(script, C.R_OK | C.X_OK); } catch { return refuse(`the ${name} hook is not readable and runnable`); }
      const [good, bad] = canned[name];
      if (!bad) return refuse(`no harmful probe for the ${name} hook`);
      for (const [input, want] of [[good, 0], [bad, 2]]) {
        // Every call carries the session's folder, as Claude Code's do; the guards refuse a shell call without one.
        const r = run(node, [script, ...argv], { input: JSON.stringify({ cwd: copy ?? outbox, ...input }), encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
        if (r.error || r.signal) return refuse(`the ${name} hook did not answer within ${HOOK_TIMEOUT} s`);
        if (r.status !== want) return refuse(`the ${name} hook answered ${r.status} to a ${want === 0 ? 'harmless' : 'harmful'} call`);
        if (want === 0 && r.stdout && r.stdout.trim()) {
          try { JSON.parse(r.stdout); } catch { return refuse(`the ${name} hook printed something that is not an answer`); }
        }
      }
    }
  }
  // The compaction hooks are not probed (a harmless call writes a note), but they must block on
  // failure, keep the limit and run from the hook folder too.
  for (const [event, list] of Object.entries(settings[S.hooks])) {
    if (event === E.preToolUse) continue;
    for (const m of list ?? []) for (const h of m?.[H.hooks] ?? []) {
      if (h[H.type] !== 'command' || h[H.onFailure] !== 'block' || h[H.timeout] !== HOOK_TIMEOUT) return refuse(`a ${event} hook does not block on failure within ${HOOK_TIMEOUT} s`);
      const words = splitCommand(h[H.command]);
      if (!words) return refuse(`a ${event} hook does not exit 2 when it fails to run`);
      const script = words[1];
      if (script !== join(hooksDir, 'compact-note.mjs')) return refuse(`a ${event} hook runs a script outside the hook folder`);
      try { accessSync(script, C.R_OK | C.X_OK); } catch { return refuse(`the ${event} hook is not readable and runnable`); }
    }
  }
  return { ok: true };
}

/** Check 8. */
export const checkSnapshot = (path, opts) => readSnapshot(path, opts);
