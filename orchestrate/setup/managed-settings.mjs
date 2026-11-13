// setup.mjs managed-settings (L1029, L1031, L1044): the machine-wide production-write guard, for every Claude Code session on
// this Mac, every Mac user's, the owner's own included. It blocks production names only (L1044 M1): a production settings
// file, program or host; role sessions keep their full role guard through their own settings.
//
// What it places, as root:
//   <base>/machine-wide-guard/       the guard's own folder (layout.mjs managedGuardDir), root's 0755, outside `install`, so
//                                    no reinstall or updater step removes it (L1044 M2). In it, each root's 0644:
//     production-write-guard.mjs, lib.mjs, snapshot.mjs   the guard and the two modules it imports, copied from the
//                                    installed copy's hooks (add-to-install put them there)
//     rules.json                     the rules copy the guard reads: the runner config's production rules, as a rules
//                                    snapshot (hooks/snapshot.mjs), written by this command alone, never refreshed
//   /Library/Application Support/ClaudeCode/managed-settings.json   one PreToolUse hook on every tool: the guard in its
//                                    machine-wide form (render-settings.mjs machineWideSettings), root's 0644
//
// Every session on the Mac is blocked while the guard can't run or can't read its copy, so the order is the lock-out guard
// (L1031):
//   (a) everything is first made in a side folder (`.next` in the guard's folder), read back as the guard will read it, and
//       the guard run from there for real (a harmless call must pass; a production one must be blocked by the guard's own
//       rule). Only then do the files replace the live ones, one rename each (L1044 m2: a bad copy never goes live), and the
//       guard is run once more where it now lives, before managed-settings.json is placed. A step that fails stops the run.
//   (b) the guard fails closed on a missing or unreadable copy, naming the way out (hooks/lib.mjs MACHINE_WIDE_WAY_OUT); and
//       when it can't run at all (its script missing), the hook command says the way out itself (MACHINE_WIDE_FAILS_CLOSED).
//   (c) the way out, in the README and in what this prints: from the Terminal app, sudo rm the file.
//
// It never overwrites a managed-settings.json it did not write: one holding anything but this guard is refused, untouched.
// A change to the runner config's rules needs this run again: the after-check says when the copy no longer matches (m4).

import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { installPaths } from './install.mjs';
import { COPY_HOOKS, managedGuardDir, managedRulesPath } from './layout.mjs';
import { rulesProblems } from './review-config.mjs';
import { CLAUDE_FILE, checkMachineWide, listDropIns, readPlist } from '../modules/M4-workshop/launcher/env-check.mjs';
import { machineWideSettings, MACHINE_WIDE_FAILS_CLOSED } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { makeSnapshot, readSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';

/** The node every Mac user's session runs the guard with: nodejs.org's, root's, at its fixed place (setup's README). */
export const NODE_BIN = '/usr/local/bin/node';
export const GUARD = 'production-write-guard.mjs';
/** The guard and the modules it imports (only node's own beyond these two): what its folder holds besides the copy. */
export const GUARD_FILES = Object.freeze([GUARD, 'lib.mjs', 'snapshot.mjs']);
export const RULES_FILE = 'rules.json';
const NEXT = '.next';
/** The way out (L1031 guard c), said after every run and in the README. */
export const WAY_OUT = `To switch the machine-wide guard off: open the Terminal app (not Claude) and run  sudo rm "${CLAUDE_FILE}"  then start Claude again.`;

const op = (text, run) => ({ text, run });
const rootOwned = (io, p, mode, kind = 'file') => op(`set owner and mode of ${p}: chown 0:0, chmod ${mode.toString(8)}`, () => {
  const want = { uid: io.rootUid, gid: 0, mode }; if (kind === 'dir') io.secure(p, want); else io.secureFile(p, want);
});
const lstatOrNull = (f) => { try { return f(); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rules the copy carries: the production block alone (L1044 M1, c1), the one part the machine-wide form reads. */
export const copyRules = (rules) => ({ production: rules.production });

/** A managed-settings.json this command wrote, at any guard path: the one guard hook and nothing else. */
export function isOurs(obj) {
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : null);
  if (keys(obj)?.join() !== 'hooks' || keys(obj.hooks)?.join() !== 'PreToolUse') return false;
  const pre = obj.hooks.PreToolUse;
  if (!Array.isArray(pre) || pre.length !== 1 || keys(pre[0])?.sort().join() !== 'hooks,matcher' || pre[0].matcher !== '*') return false;
  const hs = pre[0].hooks;
  // This form, or r1's (` || exit 2`, from a run before L1044), so a rerun may replace either.
  return Array.isArray(hs) && hs.length === 1 && typeof hs[0]?.command === 'string'
    && new RegExp(`^\\S+ \\S+/${esc(GUARD)} --machine-wide --snapshot \\S+(?:${esc(MACHINE_WIDE_FAILS_CLOSED)}| \\|\\| exit 2)$`).test(hs[0].command);
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

/**
 * Runs the guard for real, as a session would. → { code, stderr }: code 0 only when it exited 0; 2 for anything else (a
 * block, a crash, a time-out, a failure to start), as the hook command makes it. A caller that needs to tell the guard's
 * own block from a crash reads `blockedByRule`.
 */
export function runGuard({ node, hook, copy, input }) {
  const r = spawnSync(node, [hook, '--machine-wide', '--snapshot', copy], { input: JSON.stringify(input), timeout: 10_000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { code: r.status === 0 ? 0 : 2, stderr: String(r.stderr ?? r.error?.message ?? ''), status: r.status };
}
/** The guard blocked by its own rule (hooks/lib.mjs runHook's line), not by an error of its own or a crash (L1044 m6 A9). */
export const blockedByRule = (r) => r.code === 2 && (r.status === undefined || r.status === 2) && /^\[orchestrate\] blocked: /m.test(r.stderr) && !/hook error/.test(r.stderr);

/** The guard tried on a copy, from a folder: a harmless call passes and the production one is blocked by rule; else it throws. */
function trial(guard, { node, hook, copy, probes, where }) {
  const ok = guard({ node, hook, copy, input: probes.pass });
  if (ok.code !== 0) throw new Error(`the guard ${where} blocked a harmless call (${ok.stderr.trim().slice(0, 1200)}), so ${CLAUDE_FILE} was not placed`);
  if (probes.block) {
    const no = guard({ node, hook, copy, input: probes.block });
    if (!blockedByRule(no)) throw new Error(`the guard ${where} did not block a production call by its own rule (${no.code === 0 ? 'it let it through' : no.stderr.trim().slice(0, 600)}), so ${CLAUDE_FILE} was not placed`);
  }
}

/**
 * The plan: { ops, problems, notes }. `readSource` reads the runner config as root reads it; `nodeBin` and `guard` (runGuard)
 * are ports for a test. Nothing is changed when there is a problem.
 */
export function planManagedSettings(io, cfg, { readSource = (p) => io.readSource(p), nodeBin = NODE_BIN, guard = runGuard, now = () => new Date() } = {}) {
  const problems = [];
  const P = installPaths(cfg);
  const dir = managedGuardDir(cfg);
  const copy = managedRulesPath(cfg);
  const claudeDir = dirname(CLAUDE_FILE);
  const hooksDir = join(io.at(P.installRoot), COPY_HOOKS);

  // The rules: the prepared runner config's (the one add-to-install put in the installed copy), its one source.
  let rc;
  try { rc = JSON.parse(readSource(cfg.runnerConfig)); } catch (e) { problems.push(e instanceof SyntaxError ? `the runner config ${cfg.runnerConfig} is not valid JSON` : `${e.message} (${cfg.runnerConfig})`); }   // never the parser's message: it quotes the file
  if (rc !== undefined && (rc === null || typeof rc !== 'object' || Array.isArray(rc))) { problems.push(`the runner config ${cfg.runnerConfig} must be one JSON object`); rc = undefined; }
  if (rc) {
    if (rc.hooksDir !== hooksDir) problems.push(`the runner config's hooksDir must be ${hooksDir}: run review-config without --for-install, put it in place, and run add-to-install first (the guard is one of the hooks it installs)`);
    if (rc.machineWide !== CLAUDE_FILE) problems.push(`the runner config's machineWide must be ${CLAUDE_FILE}`);
    problems.push(...rulesProblems(rc.rules, `the runner config ${cfg.runnerConfig}`));
  }
  // The guard's files, from the installed copy: each root's alone, written by no one else (copied from there into its folder).
  for (const n of GUARD_FILES) {
    const src = join(hooksDir, n);
    const st = lstatOrNull(() => io.lstatReal(src));
    if (!st) problems.push(`the guard's ${src} is not there: run add-to-install first`);
    else if (!st.isFile() || st.uid !== io.rootUid || (st.mode & 0o022)) problems.push(`the guard's ${src} is not a plain file that is root's alone`);
  }
  const nodeWhy = io.nodeBinProblem(nodeBin);
  if (nodeWhy) problems.push(`${nodeBin} can't be the node every session runs the guard with: ${nodeWhy}. Install node from nodejs.org (it goes to ${NODE_BIN})`);
  // The guard's folder: it may be missing (made here); a link or a file there is refused.
  const dirSt0 = lstatOrNull(() => io.lstat(dir));
  if (dirSt0 && !dirSt0.isDirectory()) problems.push(`${dir} is not a plain folder`);
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

  const rules = copyRules(rc.rules);
  const realDir = io.at(dir);
  const realCopy = io.at(copy);
  const hook = join(realDir, GUARD);
  const text = `${JSON.stringify(machineWideSettings({ node: nodeBin, hooksDir: realDir, snapshot: realCopy }), null, 1)}\n`;
  // A guard file (logical path) against the installed one (a real path, outside any prefix), byte for byte.
  const sameBytes = (a, b) => { try { return io.readText(a) === readFileSync(b, 'utf8'); } catch { return false; } };
  // Already in place: the same file, the same guard files, and a copy that reads back with the same rules.
  const have = readSnapshot(realCopy, { maxAgeMs: Infinity, ownerUid: io.rootUid });
  if (had === text && have.ok && JSON.stringify(have.rules) === JSON.stringify(rules)
    && GUARD_FILES.every((n) => sameBytes(join(dir, n), join(hooksDir, n)))) return { ops: [], problems: [], installed: true };

  const probes = probeCalls(rules);
  const next = join(dir, NEXT);
  const realNext = io.at(next);
  const side = (p) => join(dirname(p), `.${p.split('/').pop()}.writing`);
  const ops = [
    ...(dirSt0 ? [] : [op(`mkdir ${dir}`, () => io.mkdir(dir, 0o700))]),
    rootOwned(io, dir, 0o755, 'dir'),
    // (a) made and tried in the side folder first, so nothing live changes until it has passed (m2).
    op(`rm -r ${next}   (left by a cut-off run, if any)`, () => io.rm(next)),
    op(`mkdir ${next}`, () => io.mkdir(next, 0o700)),
    rootOwned(io, next, 0o755, 'dir'),
    ...GUARD_FILES.flatMap((n) => [
      op(`copy ${join(hooksDir, n)} → ${join(next, n)}`, () => io.copyFile(join(hooksDir, n), join(next, n), 0o644)),
      rootOwned(io, join(next, n), 0o644),
    ]),
    op(`write ${join(next, RULES_FILE)}`, () => io.write(join(next, RULES_FILE), `${makeSnapshot(rules, now())}\n`, 0o644)),
    rootOwned(io, join(next, RULES_FILE), 0o644),
    op(`read back ${next} as the guard will (the copy root's alone, its fingerprint, the same rules; each guard file as installed); stop here if not`, () => {
      const r = readSnapshot(join(realNext, RULES_FILE), { maxAgeMs: Infinity, ownerUid: io.rootUid });
      if (!r.ok) throw new Error(`the rules copy ${join(next, RULES_FILE)} did not read back (${r.reason}), so ${CLAUDE_FILE} was not placed`);
      if (JSON.stringify(r.rules) !== JSON.stringify(rules)) throw new Error(`the rules copy ${join(next, RULES_FILE)} read back with other rules, so ${CLAUDE_FILE} was not placed`);
      for (const n of GUARD_FILES) if (!sameBytes(join(next, n), join(hooksDir, n))) throw new Error(`${join(next, n)} did not read back as installed, so ${CLAUDE_FILE} was not placed`);
    }),
    op(`run the guard in ${next} on its copy: a harmless call must pass${probes.block ? ' and a production one must be blocked by its rule' : ''}; stop here if not`, () => {
      trial(guard, { node: nodeBin, hook: join(realNext, GUARD), copy: join(realNext, RULES_FILE), probes, where: `in ${next}` });
    }),
    // Then live, one rename each: the modules first, the guard, the copy last.
    ...['lib.mjs', 'snapshot.mjs', GUARD, RULES_FILE].map((n) => op(`rename ${join(next, n)} → ${join(dir, n)}`, () => io.rename(join(next, n), join(dir, n)))),
    op(`rm -r ${next}`, () => io.rm(next)),
    op(`read back ${copy} and run the guard where it now lives; stop here if not`, () => {
      const r = readSnapshot(realCopy, { maxAgeMs: Infinity, ownerUid: io.rootUid });
      if (!r.ok || JSON.stringify(r.rules) !== JSON.stringify(rules)) throw new Error(`the rules copy ${copy} did not read back (${r.ok ? 'other rules' : r.reason}), so ${CLAUDE_FILE} was not placed`);
      trial(guard, { node: nodeBin, hook, copy: realCopy, probes, where: `in ${dir}` });
    }),
    ...(dirSt ? [] : [op(`mkdir ${claudeDir}`, () => io.mkdir(claudeDir, 0o700))]),
    rootOwned(io, claudeDir, 0o755, 'dir'),
    op(`rm ${side(CLAUDE_FILE)}   (left by a cut-off run, if any)`, () => io.unlink(side(CLAUDE_FILE))),
    op(`write ${side(CLAUDE_FILE)}`, () => io.write(side(CLAUDE_FILE), text, 0o644)),
    rootOwned(io, side(CLAUDE_FILE), 0o644),
    op(`rename ${side(CLAUDE_FILE)} → ${CLAUDE_FILE}`, () => io.rename(side(CLAUDE_FILE), CLAUDE_FILE)),
  ];
  return { ops, problems: [], warnings: probes.block ? [] : ['the rules name no production host, program or settings file, so the guard blocks nothing'] };
}

/** The readers check 10 (checkMachineWide) uses here, through `io` so a test's prefix holds: the person who ran sudo's homes. */
export function managedReaders(io) {
  const who = process.env.SUDO_USER || userInfo().username;
  return { readFile: (p) => io.readText(p), listDir: (d) => listDropIns(io.at(d)), plist: (p) => readPlist(io.at(p)), user: () => who,
    home: () => (process.env.SUDO_USER ? `/Users/${process.env.SUDO_USER}` : process.env.HOME), claudeFile: CLAUDE_FILE };
}

/** After the run (and its read-only form): what is in place, as rows { what, ok, why }. `readers` and `readSource` are ports. */
export function checkManagedSettings(io, cfg, { readers = managedReaders(io), readSource = (p) => io.readSource(p) } = {}) {
  const dir = managedGuardDir(cfg);
  const copy = managedRulesPath(cfg);
  const rows = [];
  // The folder and each guard file: root's, written by no one else (0755 / 0644), plain (no link).
  const plain = (p, kind, mode) => { let st = null; try { st = io.lstat(p); } catch { /* missing */ }
    return !!st && (kind === 'dir' ? st.isDirectory() : st.isFile()) && st.uid === io.rootUid && (st.mode & 0o777) === mode; };
  rows.push({ what: `the guard's folder ${dir} is root's 0755`, ok: plain(dir, 'dir', 0o755), why: 'run managed-settings again' });
  for (const n of GUARD_FILES) rows.push({ what: `${join(dir, n)} is root's 0644`, ok: plain(join(dir, n), 'file', 0o644), why: 'run managed-settings again' });
  const r = readSnapshot(io.at(copy), { maxAgeMs: Infinity, ownerUid: io.rootUid });
  rows.push({ what: `the rules copy ${copy} reads back as the guard reads it`, ok: r.ok, why: r.ok ? '' : r.reason });
  // m4: the copy against the runner config's rules today: a rules change needs this command run again.
  let want = null; try { want = copyRules(JSON.parse(readSource(cfg.runnerConfig)).rules); } catch { /* said below */ }
  rows.push({ what: `the rules copy holds the runner config's production rules (${cfg.runnerConfig})`, ok: r.ok && !!want && JSON.stringify(r.rules) === JSON.stringify(want),
    why: want ? 'the runner config\'s rules changed since the copy was made: run managed-settings again' : 'the runner config can\'t be read' });
  // m3: launch check 10 itself (the file, its drop-ins, the managed preferences, the remote cache), then this guard's paths.
  const c10 = checkMachineWide({ ...readers, path: CLAUDE_FILE, guardScript: GUARD });
  let why = c10.ok ? '' : c10.reason;
  let obj = null;
  if (!why) { try { obj = JSON.parse(io.readText(CLAUDE_FILE)); } catch (e) { why = `it can't be read as JSON (${e?.code ?? 'not JSON'})`; } }
  if (!why && !isOurs(obj)) why = 'it holds more than the one guard hook';
  else if (!why && !obj.hooks.PreToolUse[0].hooks[0].command.endsWith(` ${join(io.at(dir), GUARD)} --machine-wide --snapshot ${io.at(copy)}${MACHINE_WIDE_FAILS_CLOSED}`)) why = `its hook does not run ${join(dir, GUARD)} on ${copy}`;
  rows.push({ what: `${CLAUDE_FILE} carries the machine-wide guard, and no other source overrides it (launch check 10)`, ok: !why, why });
  let st = null; try { st = io.lstat(CLAUDE_FILE); } catch { /* said above */ }
  rows.push({ what: `${CLAUDE_FILE} is root's 0644`, ok: !!st && st.isFile() && st.uid === io.rootUid && (st.mode & 0o777) === 0o644, why: 'run managed-settings again' });
  return rows;
}
