// setup.mjs managed-settings (L1029, L1031): the machine-wide production-write guard, for every Claude Code session on
// this Mac, every Mac user's, the owner's own included.
//
// What it places, as root:
//   <base>/machine-wide-rules.json   the rules copy the guard reads: the runner config's `rules`, as a rules snapshot
//                                    (hooks/snapshot.mjs), root's 0644 in the base (root's), written once, never refreshed
//   /Library/Application Support/ClaudeCode/managed-settings.json   one PreToolUse hook on every tool: the guard in its
//                                    machine-wide form (render-settings.mjs machineWideSettings), root's 0644
//
// Every session on the Mac is blocked while the guard can't read its copy, so the order is the lock-out guard (L1031):
//   (a) the copy is written and read back first, as the guard will read it, and the guard is run on it for real (a harmless
//       call must pass, a production one must be blocked); only then is managed-settings.json placed. A step that fails
//       stops the run with managed-settings.json as it was.
//   (b) the guard itself fails closed on a missing or unreadable copy, and its message names the way out (hooks/lib.mjs
//       MACHINE_WIDE_WAY_OUT).
//   (c) the way out, in the README and in what this prints: from the Terminal app, sudo rm the file.
//
// It never overwrites a managed-settings.json it did not write: one holding anything but this guard is refused, untouched.

import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPaths } from './install.mjs';
import { COPY_HOOKS, managedRulesPath } from './layout.mjs';
import { rulesProblems } from './review-config.mjs';
import { CLAUDE_FILE, machineWideFileProblem } from '../modules/M4-workshop/launcher/env-check.mjs';
import { machineWideSettings } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { makeSnapshot, readSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';

/** The node every Mac user's session runs the guard with: nodejs.org's, root's, at its fixed place (setup's README). */
export const NODE_BIN = '/usr/local/bin/node';
export const GUARD = 'production-write-guard.mjs';
/** The way out (L1031 guard c), said after every run and in the README. */
export const WAY_OUT = `To switch the machine-wide guard off: open the Terminal app (not Claude) and run  sudo rm "${CLAUDE_FILE}"  then start Claude again.`;

const op = (text, run) => ({ text, run });
const rootOwned = (io, p, mode, kind = 'file') => op(`set owner and mode of ${p}: chown 0:0, chmod ${mode.toString(8)}`, () => {
  const want = { uid: io.rootUid, gid: 0, mode }; if (kind === 'dir') io.secure(p, want); else io.secureFile(p, want);
});
const lstatOrNull = (f) => { try { return f(); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

/** A managed-settings.json this command wrote, at any copy path: the one guard hook and nothing else. */
export function isOurs(obj) {
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : null);
  if (keys(obj)?.join() !== 'hooks' || keys(obj.hooks)?.join() !== 'PreToolUse') return false;
  const pre = obj.hooks.PreToolUse;
  if (!Array.isArray(pre) || pre.length !== 1 || keys(pre[0])?.sort().join() !== 'hooks,matcher' || pre[0].matcher !== '*') return false;
  const hs = pre[0].hooks;
  return Array.isArray(hs) && hs.length === 1 && typeof hs[0]?.command === 'string'
    && new RegExp(`^\\S+ \\S+/${GUARD.replace('.', '\\.')} --machine-wide --snapshot \\S+ \\|\\| exit 2$`).test(hs[0].command);
}

/**
 * The calls the guard is tried on before the file is placed: one it must let through, and one naming the first production
 * name the rules hold (a host, else a program, else a settings file), which it must block. `block` is null when the rules
 * name nothing at all (the guard then blocks nothing; said as a WARNING).
 */
export function probeCalls(rules) {
  const p = rules.production;
  const pass = { tool_name: 'Bash', tool_input: { command: 'true' }, cwd: '/' };
  const block = p.hosts.length ? { tool_name: 'WebFetch', tool_input: { url: `https://${p.hosts[0]}/` }, cwd: '/' }
    : p.programs.length ? { tool_name: 'Bash', tool_input: { command: `${p.programs[0]} --version` }, cwd: '/' }
    : p.env_files.length ? { tool_name: 'Read', tool_input: { file_path: p.env_files[0] }, cwd: '/' } : null;
  return { pass, block };
}

/** Runs the guard for real, as a session would: → its exit code (2 also for a time-out or a failure to start, as `|| exit 2` makes it). */
export function runGuard({ node, hook, copy, input }) {
  const r = spawnSync(node, [hook, '--machine-wide', '--snapshot', copy], { input: JSON.stringify(input), timeout: 10_000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { code: r.status === 0 ? 0 : 2, stderr: String(r.stderr ?? r.error?.message ?? '') };
}

/**
 * The plan: { ops, problems, notes }. `readSource` reads the runner config as root reads it; `nodeBin` and `guard` (runGuard)
 * are ports for a test. Nothing is changed when there is a problem.
 */
export function planManagedSettings(io, cfg, { readSource = (p) => io.readSource(p), nodeBin = NODE_BIN, guard = runGuard, now = () => new Date() } = {}) {
  const problems = [];
  const P = installPaths(cfg);
  const copy = managedRulesPath(cfg);
  const claudeDir = dirname(CLAUDE_FILE);
  const hooksDir = join(io.at(P.installRoot), COPY_HOOKS);
  const hook = join(hooksDir, GUARD);

  // The rules: the installed runner config's, its one source (review-config built it from the owner's input).
  let rc;
  try { rc = JSON.parse(readSource(cfg.runnerConfig)); } catch (e) { problems.push(e instanceof SyntaxError ? `the runner config ${cfg.runnerConfig} is not valid JSON` : `${e.message} (${cfg.runnerConfig})`); }   // never the parser's message: it quotes the file
  if (rc !== undefined && (rc === null || typeof rc !== 'object' || Array.isArray(rc))) { problems.push(`the runner config ${cfg.runnerConfig} must be one JSON object`); rc = undefined; }
  if (rc) {
    if (rc.hooksDir !== hooksDir) problems.push(`the runner config's hooksDir must be ${hooksDir}: run review-config without --for-install, put it in place, and run add-to-install first (the guard is one of the hooks it installs)`);
    if (rc.machineWide !== CLAUDE_FILE) problems.push(`the runner config's machineWide must be ${CLAUDE_FILE}`);
    problems.push(...rulesProblems(rc.rules, `the runner config ${cfg.runnerConfig}`));
  }
  // The guard every session will run, and the node it runs with: root's, written by no one else.
  const st = lstatOrNull(() => io.lstatReal(hook));
  if (!st) problems.push(`the guard ${hook} is not there: run add-to-install first`);
  else if (!st.isFile() || st.uid !== io.rootUid || (st.mode & 0o022)) problems.push(`the guard ${hook} is not a plain file that is root's alone`);
  const nodeWhy = io.nodeBinProblem(nodeBin);
  if (nodeWhy) problems.push(`${nodeBin} can't be the node every session runs the guard with: ${nodeWhy}. Install node from nodejs.org (it goes to ${NODE_BIN})`);
  // Claude's folder: its parent must be there; it may be missing (made here), but a link or a file there is refused.
  if (!lstatOrNull(() => io.lstat(dirname(claudeDir)))) problems.push(`${dirname(claudeDir)} is not there`);
  const dirSt = lstatOrNull(() => io.lstat(claudeDir));
  if (dirSt && !dirSt.isDirectory()) problems.push(`${claudeDir} is not a plain folder`);
  // A managed-settings.json already there: replaced only when it is this guard (an earlier run), never anything else.
  let had = null;
  const fileSt = dirSt?.isDirectory() ? lstatOrNull(() => io.lstat(CLAUDE_FILE)) : null;
  if (fileSt && !fileSt.isFile()) problems.push(`${CLAUDE_FILE} is not a plain file; nothing was changed`);
  else if (fileSt) {
    try { had = io.readText(CLAUDE_FILE); } catch (e) { problems.push(`${CLAUDE_FILE} can't be read (${e?.code ?? 'error'})`); }
    let obj = null; try { obj = JSON.parse(had); } catch { /* refused below */ }
    if (had !== null && !isOurs(obj)) problems.push(`${CLAUDE_FILE} holds settings this command did not write; it is left as it is. Move what it holds elsewhere and remove it (sudo rm "${CLAUDE_FILE}"), then run this again`);
  }
  if (problems.length) return { ops: [], problems };

  const rules = rc.rules;
  const realCopy = io.at(copy);
  const text = `${JSON.stringify(machineWideSettings({ node: nodeBin, hooksDir, snapshot: realCopy }), null, 1)}\n`;
  // Already in place: the same file, and a copy that reads back with the same rules.
  const have = readSnapshot(realCopy, { maxAgeMs: Infinity, ownerUid: io.rootUid });
  if (had === text && have.ok && JSON.stringify(have.rules) === JSON.stringify(rules)) return { ops: [], problems: [], installed: true };

  const probes = probeCalls(rules);
  const side = (p) => join(dirname(p), `.${p.split('/').pop()}.writing`);
  const place = (p, body) => [
    op(`rm ${side(p)}   (left by a cut-off run, if any)`, () => io.unlink(side(p))),
    op(`write ${side(p)}`, () => io.write(side(p), body, 0o644)),
    rootOwned(io, side(p), 0o644),
    op(`rename ${side(p)} → ${p}`, () => io.rename(side(p), p)),
  ];
  const ops = [
    ...place(copy, `${makeSnapshot(rules, now())}\n`),
    // Guard (a): read back as the guard reads it, and the guard tried on it, BEFORE managed-settings.json is placed.
    op(`read back ${copy} as the guard will (root's alone, its fingerprint, the same rules); stop here if it does not`, () => {
      const r = readSnapshot(realCopy, { maxAgeMs: Infinity, ownerUid: io.rootUid });
      if (!r.ok) throw new Error(`the rules copy ${copy} did not read back (${r.reason}), so ${CLAUDE_FILE} was not placed`);
      if (JSON.stringify(r.rules) !== JSON.stringify(rules)) throw new Error(`the rules copy ${copy} read back with other rules, so ${CLAUDE_FILE} was not placed`);
    }),
    op(`run the guard on the copy: a harmless call must pass${probes.block ? ' and a production one must be blocked' : ''}; stop here if not`, () => {
      const ok = guard({ node: nodeBin, hook, copy: realCopy, input: probes.pass });
      if (ok.code !== 0) throw new Error(`the guard blocked a harmless call (${ok.stderr.trim().slice(0, 1200)}), so ${CLAUDE_FILE} was not placed`);
      if (probes.block) { const no = guard({ node: nodeBin, hook, copy: realCopy, input: probes.block }); if (no.code !== 2) throw new Error(`the guard let a production call through, so ${CLAUDE_FILE} was not placed`); }
    }),
    ...(dirSt ? [] : [op(`mkdir ${claudeDir}`, () => io.mkdir(claudeDir, 0o700))]),
    rootOwned(io, claudeDir, 0o755, 'dir'),
    ...place(CLAUDE_FILE, text),
  ];
  return { ops, problems: [], warnings: probes.block ? [] : ['the rules name no production host, program or settings file, so the guard blocks nothing'] };
}

/** After the run (and its read-only form): what is in place, as rows { what, ok, why }. */
export function checkManagedSettings(io, cfg) {
  const copy = managedRulesPath(cfg);
  const rows = [];
  const r = readSnapshot(io.at(copy), { maxAgeMs: Infinity, ownerUid: io.rootUid });
  rows.push({ what: `the rules copy ${copy} reads back as the guard reads it`, ok: r.ok, why: r.ok ? '' : r.reason });
  let obj = null; let why = '';
  try { obj = JSON.parse(io.readText(CLAUDE_FILE)); } catch (e) { why = `it can't be read as JSON (${e?.code ?? 'not JSON'})`; }
  const p = obj ? machineWideFileProblem(obj, GUARD) : null;
  if (obj && p) why = p.reason;
  else if (obj && !isOurs(obj)) why = 'it holds more than the one guard hook';
  else if (obj && !obj.hooks.PreToolUse[0].hooks[0].command.includes(` --snapshot ${io.at(copy)} `)) why = `its guard does not read ${copy}`;
  rows.push({ what: `${CLAUDE_FILE} carries the machine-wide guard (launch check 10's own test of the file)`, ok: !why, why });
  let st = null; try { st = io.lstat(CLAUDE_FILE); } catch { /* said above */ }
  rows.push({ what: `${CLAUDE_FILE} is root's 0644`, ok: !!st && st.isFile() && st.uid === io.rootUid && (st.mode & 0o777) === 0o644, why: 'run managed-settings again' });
  return rows;
}
