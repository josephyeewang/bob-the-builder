#!/usr/bin/env node
// The Mini's one-time setup commands (R-0b-05, part 1: the users and their folders).
//
//   node setup.mjs users-folders --config <file> [--dry-run]    make the three Mac users and their folders (needs root)
//   node setup.mjs check         --config <file>                read only: PASS or FAIL per item; exit 1 on any FAIL
//   node setup.mjs proofs        --config <file> [--dry-run]    read only, needs root: the owner's own Mac user cannot write
//                                                               the record, hooks, settings, launcher... or read the keys
//
// Safe to run twice; --dry-run prints exactly what would be done, changes nothing and needs no root. `--root-prefix` is
// for tests only (every folder path is put under it; the Mac's user records are not) and is refused when running as root:
// under sudo it would move where root writes while every printed path still read /Library/... (L90 minor b).
// Exit: 0 fine, 1 a check failed or a problem was found, 2 usage or not root.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseConfig } from './layout.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { apply, check, plan } from './users-folders.mjs';
import { proofCommands, runProofs } from './proofs.mjs';

const USAGE = 'usage: node setup.mjs <users-folders|check|proofs> --config <file> [--dry-run]';

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, config: null, dry: false, prefix: '' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--config' || a === '--root-prefix') {
      const v = rest[++i];
      if (typeof v !== 'string' || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--config') o.config = v; else o.prefix = v;
    } else throw new Error(`argument ${i + 1} is not one this command takes (it is not shown, in case it is a secret)`);
  }
  if (!['users-folders', 'check', 'proofs'].includes(cmd)) throw new Error('first word must be users-folders, check or proofs');
  if (!o.config) throw new Error('--config <file> is required');
  if (cmd === 'check' && o.dry) throw new Error('check never changes anything, so --dry-run does not apply');
  return o;
}

/** Runs one command. `io` is a port for tests. → exit code. */
export function main(argv, { io: given, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  let o; let cfg;
  try {
    o = parseArgs(argv);
    cfg = parseConfig(JSON.parse(readFileSync(o.config, 'utf8')));
  } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const io = given ?? realIo({ prefix: o.prefix });
  if (o.prefix && io.euid() === 0) { err('refused: --root-prefix is for tests and may not be used as root'); return 2; }

  if (o.cmd === 'check') {
    const res = check(io, cfg);
    for (const r of res) out(r.skip ? `SKIP  ${r.what} — ${r.why}` : r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`);
    const bad = res.filter((r) => !r.ok).length; const skipped = res.filter((r) => r.skip).length;
    out(`${bad ? `${bad} of ${res.length} FAILED` : `all ${res.length - skipped} PASS`}${skipped ? ` (${skipped} skipped: they need root)` : ''}`);
    return bad ? 1 : 0;
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
  const { ops, problems } = plan(io, cfg);
  for (const p of problems) err(`PROBLEM  ${p}`);
  if (problems.length) { err('nothing was changed.'); return 1; }
  if (!ops.length) out('nothing to do: the users and folders are already as needed.');
  if (o.dry) { for (const x of ops) out(`would run: ${x.text}`); out(`dry run: ${ops.length} step(s), nothing changed.`); return 0; }
  try { apply(ops, { log: (t) => out(`run: ${t}`) }); } catch (e) { err(`stopped: ${e.message}. Run it again after fixing that; it picks up where it stopped.`); return 1; }
  const res = check(io, cfg);
  const bad = res.filter((r) => !r.ok);
  for (const r of bad) err(`FAIL  ${r.what} — ${r.why}`);
  out(bad.length ? `${bad.length} item(s) still FAIL after the run.` : `done: all ${res.length} items PASS.`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
