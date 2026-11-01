#!/usr/bin/env node
// The always-on Mac's one-time setup commands (R-0b-05 and the install). Every command has a --dry-run (changing commands)
// or is read only; every changing command is safe to run twice and refuses clearly when it needs root and does not have it.
//
//   users-folders        [--dry-run]    the three Mac users and their folders                                  (root)
//   check                               PASS, FAIL or NEEDS ROOT per item for the above; exit 3 if some need root (read only)
//   proofs               [--dry-run]    the owner's own Mac user cannot write the record, hooks,
//                                       settings, launcher... or read the keys                                 (root, read only)
//   install              [--dry-run]    the link layout, then the updater's first run                          (root)
//   check-install        [--main <sha>] the copy, its link, every install folder, access lists                 (read only)
//   daemons place|load|unload  [--dry-run]   the three background jobs' files; load; unload                    (root)
//   daemons list                        loaded or not, per job                                                 (read only)
//   daemons check                       the job files are exact and the jobs are loaded                        (read only)
//
// The config: as root, ONLY the root-owned file at ROOT_CONFIG_PATH (layout.mjs), opened without following links, owned
// by root, written by no one else, in folders only root writes (NEW-1). Without sudo, `--config <file>` may name another
// file (for a --dry-run before the real one is put in place).
//
// `--root-prefix <dir>` is for tests only (every folder path is put under it; the Mac's user records are not) and is
// refused when running as root: under sudo it would move where root writes while every printed path still read
// /Library/... (L90 minor b). Exit: 0 fine, 1 a check failed or a problem was found, 2 usage or not root.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT_CONFIG_PATH, parseConfig } from './layout.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { guarded } from './guard.mjs';
import { apply, check, plan } from './users-folders.mjs';
import { proofCommands, runProofs } from './proofs.mjs';
import { checkInstall, parseInstallConfig, planInstall, spawnUpdater } from './install.mjs';
import { checkDaemons, list, planLoad, planPlace, planUnload } from './daemons.mjs';

const USAGE = 'usage: node setup.mjs <users-folders|check|proofs|install|check-install|daemons place|load|unload|list|check> [--config <file>, without sudo only] [--dry-run] [--main <commit>]';
const DAEMON_SUBS = ['place', 'load', 'unload', 'list', 'check'];
const COMMANDS = ['users-folders', 'check', 'proofs', 'install', 'check-install', 'daemons'];

export function parseArgs(argv) {
  const cmd = argv[0];
  if (!COMMANDS.includes(cmd)) throw new Error(`first word must be ${COMMANDS.join(', ')}`);
  let rest = argv.slice(1); let sub = null;
  if (cmd === 'daemons') { sub = rest[0]; rest = rest.slice(1); if (!DAEMON_SUBS.includes(sub)) throw new Error(`daemons needs one of ${DAEMON_SUBS.join(', ')}`); }
  const o = { cmd, sub, config: null, dry: false, prefix: '', main: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--config' || a === '--root-prefix' || a === '--main') {
      const v = rest[++i];
      if (typeof v !== 'string' || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--config') o.config = v; else if (a === '--main') { if (!/^[0-9a-f]{40}$/.test(v)) throw new Error('--main must be a 40-hex commit'); o.main = v; } else o.prefix = v;
    } else throw new Error(`argument ${i + 1} is not one this command takes (it is not shown, in case it is a secret)`);
  }
  const readOnly = cmd === 'check' || cmd === 'check-install' || (cmd === 'daemons' && (sub === 'list' || sub === 'check'));
  if (readOnly && o.dry) throw new Error('this command never changes anything, so --dry-run does not apply');
  if (o.main && cmd !== 'check-install') throw new Error('--main is only for check-install');
  return o;
}

function report(res, out) {
  for (const r of res) out(r.skip ? `NEEDS ROOT  ${r.what} — ${r.why}` : r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`);
  const bad = res.filter((r) => !r.ok).length; const skipped = res.filter((r) => r.skip).length;
  // A check that could not look is not a pass: with any NEEDS ROOT line the summary says so and the exit code is not 0.
  out(`${bad ? `${bad} of ${res.length} FAILED` : skipped ? `${res.length - skipped} PASS, but ${skipped} could not be checked without root (run it again with sudo)` : `all ${res.length} PASS`}`);
  return bad ? 1 : skipped ? 3 : 0;
}

/**
 * The plan for a changing command: { ops, problems, installed? }. Every command that changes the Mac goes through here, and
 * every one of them starts with the same wall (L90 M3): the folders above the base must be root's alone, checked now (a
 * problem gives no steps at all) and again as the FIRST step of the run.
 */
export function planCommand(io, cfg, o, { readSource = (p) => readFileSync(p, 'utf8'), runUpdater = spawnUpdater } = {}) {
  if (o.cmd === 'users-folders') return plan(io, cfg);   // carries the wall itself
  const res = o.cmd === 'install' ? planInstall(io, cfg, { readSource, runUpdater })
    : o.sub === 'place' ? planPlace(io, cfg) : o.sub === 'load' ? planLoad(io, cfg) : planUnload(io, cfg);
  return guarded(io, cfg, res);
}

/** Runs one command. `io` and `runUpdater` are ports for tests. → exit code. */
export function main(argv, { io: given, runUpdater = spawnUpdater, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  let o; let cfg;
  try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const io = given ?? realIo({ prefix: o.prefix });
  const asRoot = io.euid() === 0;
  if (o.prefix && asRoot) { err('refused: --root-prefix is for tests and may not be used as root'); return 2; }
  // Root takes orders only from the root-owned config at the fixed place (NEW-1): never from a file named on the command
  // line, and never from a home folder. And root must not be running a node program others can change, whatever the command
  // (a `sudo check` runs code as root as well; L100 m3).
  if (asRoot) {
    if (o.config) { err(`refused: as root this reads only ${ROOT_CONFIG_PATH}, which must be root's own file; --config is for a run without sudo (see the README)`); return 2; }
    const p = io.nodeProblem?.();
    if (p) { err(`refused: root must not run a node program others can change: ${p}. Use the node from nodejs.org in /usr/local/bin/node by its full path.`); return 2; }
  }
  try {
    const text = io.readConfig(o.config ?? ROOT_CONFIG_PATH, { strict: asRoot || !o.config });
    let raw; try { raw = JSON.parse(text); } catch { throw new Error('the config is not valid JSON'); }   // never the parser's own message: it quotes the file
    cfg = ['users-folders', 'check', 'proofs'].includes(o.cmd) ? parseConfig(raw) : parseInstallConfig(raw);
  } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }

  if (o.cmd === 'check') return report(check(io, cfg), out);
  if (o.cmd === 'check-install') return report(checkInstall(io, cfg, { main: o.main }), out);
  if (o.cmd === 'daemons' && o.sub === 'check') return report(checkDaemons(io, cfg), out);
  if (o.cmd === 'daemons' && o.sub === 'list') {
    for (const j of list(io, cfg)) out(j.loaded ? `${j.label}: loaded, ${j.state}, last exit ${j.lastExit}` : `${j.label}: not loaded${j.error ? ` (${j.error})` : ''}`);
    return 0;
  }

  if (o.cmd === 'proofs') {
    if (o.dry) { for (const c of proofCommands(cfg)) out(`would run: ${c}`); out('dry run: nothing was run.'); return 0; }
    const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; }
    const res = runProofs(io, cfg);
    for (const r of res) out(r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`);
    const bad = res.filter((r) => !r.ok).length;
    out(bad ? `${bad} of ${res.length} proofs FAILED` : `all ${res.length} proofs PASS`);
    return bad ? 1 : 0;
  }

  if (!o.dry) { const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; } }
  const planned = planCommand(io, cfg, o, { runUpdater });
  for (const p of planned.problems) err(`PROBLEM  ${p}`);
  if (planned.problems.length) { err('nothing was changed.'); return 1; }
  if (!planned.ops.length) out(planned.installed ? 'nothing to do: already installed.' : 'nothing to do: already as needed.');
  if (o.dry) { for (const x of planned.ops) out(`would run: ${x.text}`); out(`dry run: ${planned.ops.length} step(s), nothing changed.`); return 0; }
  try { apply(planned.ops, { log: (t) => out(`run: ${t}`) }); } catch (e) { err(`stopped: ${e.message}. Run it again after fixing that; it picks up where it stopped.`); return 1; }
  const after = o.cmd === 'users-folders' ? check(io, cfg) : o.cmd === 'install' ? checkInstall(io, cfg)
    : o.sub === 'place' ? checkDaemons(io, cfg).filter((r) => !/is loaded$/.test(r.what)) : o.sub === 'load' ? checkDaemons(io, cfg).filter((r) => /is loaded$/.test(r.what)) : null;
  if (!after) { out('done.'); return 0; }
  const bad = after.filter((r) => !r.ok);
  for (const r of bad) err(`FAIL  ${r.what} — ${r.why}`);
  out(bad.length ? `${bad.length} item(s) still FAIL after the run.` : `done: all ${after.length} items PASS.`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
