// The wall before any root step (L90 M3, the L73 rule): before root writes, renames, changes or deletes anything, every
// folder above the base must be root's alone: not a link, not writable by others, no access list. Each setup command that
// changes the Mac (users-folders now; the install, the jobs, the proposals and token steps later) plans through this and
// carries the guard as its FIRST step, so a folder changed between the plan and the run stops the run before it begins.

import { dirname } from 'node:path';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';

/** Null, or why root must not work under cfg.base. Reads only, on real paths (the prefix a test uses is the top). */
export function baseChainProblem(io, cfg) {
  return chainProblem(io.at(dirname(cfg.base)), { owner: io.rootUid, top: io.prefix || '/' });
}

/**
 * The wall around a whole plan: a problem above the base gives NO steps (nothing is changed); otherwise the guard goes
 * first, so a folder changed between the plan and the run stops the run before it begins. A plan with no steps stays empty.
 */
export function guarded(io, cfg, res) {
  const p = baseChainProblem(io, cfg);
  if (p) return { ...res, ops: [], installed: false, problems: [`the folders above ${cfg.base} are not safe for root to work in (${p}). Nothing was changed.`] };
  return res.ops.length ? { ...res, ops: [guardOp(io, cfg), ...res.ops] } : res;
}

/** The first step of every root run: the same check, again, right before anything changes. */
export function guardOp(io, cfg) {
  return {
    text: `check that every folder above ${cfg.base} is root's alone (no link, not writable by others, no access list)`,
    run: () => { const p = baseChainProblem(io, cfg); if (p) throw new Error(`the folders above ${cfg.base} are not safe for root to work in (${p}); nothing was changed`); },
  };
}
