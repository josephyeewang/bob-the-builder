#!/usr/bin/env node
// The Mini's one-time setup commands (R-0b-05 and the install). Every command has a --dry-run (changing commands) or is
// read only; every changing command is safe to run twice and refuses clearly when it needs root and does not have it.
//
//   users-folders        --config <f> [--dry-run]    the three Mac users and their folders                 (root)
//   check                --config <f>                PASS or FAIL per item for the above                   (read only)
//   install              --config <f> [--dry-run]    the link layout, then the updater's first run         (root)
//   check-install        --config <f> [--main <sha>] the copy, its link, every install folder, access lists (read only)
//   daemons place|load|unload  --config <f> [--dry-run]   the three background jobs' files; load; unload   (root)
//   daemons list         --config <f>                loaded or not, per job                                (read only)
//   daemons check        --config <f>                the job files are exact and the jobs are loaded       (read only)
//
// `--root-prefix <dir>` is for tests only: every path is put under it. Exit: 0 fine, 1 a check failed or a problem was
// found, 2 usage or not root.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseConfig } from './layout.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { apply, check, plan } from './users-folders.mjs';
import { checkInstall, parseInstallConfig, planInstall, spawnUpdater } from './install.mjs';
import { checkDaemons, list, planLoad, planPlace, planUnload } from './daemons.mjs';

const USAGE = 'usage: node setup.mjs <users-folders|check|install|check-install|daemons place|load|unload|list|check> --config <file> [--dry-run] [--main <commit>]';
const DAEMON_SUBS = ['place', 'load', 'unload', 'list', 'check'];

export function parseArgs(argv) {
  const cmd = argv[0];
  if (!['users-folders', 'check', 'install', 'check-install', 'daemons'].includes(cmd)) throw new Error('first word must be users-folders, check, install, check-install or daemons');
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
    } else throw new Error(`unknown argument ${JSON.stringify(a).slice(0, 80)}`);
  }
  if (!o.config) throw new Error('--config <file> is required');
  const readOnly = cmd === 'check' || cmd === 'check-install' || (cmd === 'daemons' && (sub === 'list' || sub === 'check'));
  if (readOnly && o.dry) throw new Error('this command never changes anything, so --dry-run does not apply');
  if (o.main && cmd !== 'check-install') throw new Error('--main is only for check-install');
  return o;
}

function report(res, out) {
  for (const r of res) out(r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`);
  const bad = res.filter((r) => !r.ok).length;
  out(bad ? `${bad} of ${res.length} FAILED` : `all ${res.length} PASS`);
  return bad ? 1 : 0;
}

/** Runs one command. `io` and `runUpdater` are ports for tests. → exit code. */
export function main(argv, { io: given, runUpdater = spawnUpdater, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  let o; let raw;
  try { o = parseArgs(argv); raw = JSON.parse(readFileSync(o.config, 'utf8')); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  let cfg;
  try { cfg = (o.cmd === 'users-folders' || o.cmd === 'check') ? parseConfig(raw) : parseInstallConfig(raw); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const io = given ?? realIo({ prefix: o.prefix });

  if (o.cmd === 'check') return report(check(io, cfg), out);
  if (o.cmd === 'check-install') return report(checkInstall(io, cfg, { main: o.main }), out);
  if (o.cmd === 'daemons' && o.sub === 'check') return report(checkDaemons(io, cfg), out);
  if (o.cmd === 'daemons' && o.sub === 'list') {
    for (const j of list(io, cfg)) out(j.loaded ? `${j.label}: loaded, ${j.state}, last exit ${j.lastExit}` : `${j.label}: not loaded${j.error ? ` (${j.error})` : ''}`);
    return 0;
  }

  if (!o.dry) { const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; } }
  const readSource = (p) => readFileSync(p, 'utf8');
  const planned = o.cmd === 'users-folders' ? plan(io, cfg)
    : o.cmd === 'install' ? planInstall(io, cfg, { readSource, runUpdater })
      : o.sub === 'place' ? planPlace(io, cfg) : o.sub === 'load' ? planLoad(io, cfg) : planUnload(io, cfg);
  for (const p of planned.problems) err(`PROBLEM  ${p}`);
  if (planned.problems.length) { err('nothing was changed.'); return 1; }
  if (!planned.ops.length) out(planned.installed ? 'nothing to do: already installed.' : 'nothing to do: already as needed.');
  if (o.dry) { for (const x of planned.ops) out(`would run: ${x.text}`); out(`dry run: ${planned.ops.length} step(s), nothing changed.`); return 0; }
  try { apply(planned.ops, { log: (t) => out(`run: ${t}`) }); } catch (e) { err(`stopped: ${e.message}. Run it again after fixing that.`); return 1; }
  const after = o.cmd === 'users-folders' ? check(io, cfg) : o.cmd === 'install' ? checkInstall(io, cfg)
    : o.sub === 'place' ? checkDaemons(io, cfg).filter((r) => !/is loaded$/.test(r.what)) : o.sub === 'load' ? checkDaemons(io, cfg).filter((r) => /is loaded$/.test(r.what)) : null;
  if (!after) { out('done.'); return 0; }
  const bad = after.filter((r) => !r.ok);
  for (const r of bad) err(`FAIL  ${r.what} — ${r.why}`);
  out(bad.length ? `${bad.length} item(s) still FAIL after the run.` : `done: all ${after.length} items PASS.`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
