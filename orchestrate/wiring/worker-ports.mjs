// The ports that start, find and stop a worker (PR C and the worker half of D), and the cleanup group.
//
// `wire()` calls `workerPorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_WORKER, in the same change. dispatcher-wiring.mjs stays as it is.

import { isRefusing, refusing } from './not-wired.mjs';

export const NOT_WIRED_WORKER = Object.freeze(['sessions', 'probe', 'launch', 'stopGroup', 'saveWork', 'hostLock', 'pauseLead',
  'board', 'outboxSessions', 'reviewEnded', 'stopSession']);
// What the cleanup step reads (cleanupPass's own parameters, less what the tick gives every step: a test pins the two
// together), and which of those aren't wired yet. To wire one: answer it in `cleanup` below and take it off NOT_WIRED_CLEANUP.
export const CLEANUP_PORTS = Object.freeze(['mirrorFor', 'git', 'saveWork', 'copiesRoot', 'sealRoot']);
export const NOT_WIRED_CLEANUP = Object.freeze([...CLEANUP_PORTS]);
// The folders: cleanupPass reads a missing one as "nothing to do" (no copies, no staging to sweep), so each refuses on
// read rather than being left out (audit #127 r2 m-C: a sealRoot left out would never sweep, in silence).
const CLEANUP_FOLDERS = Object.freeze(['copiesRoot', 'sealRoot']);

/** Why the cleanup group can't start, or null. The same rules as the tick's ports, inside the one port the tick reads as a group. */
export function cleanupProblem(cleanup) {
  const d = Object.getOwnPropertyDescriptors(cleanup);
  const refuses = (k) => isRefusing(d[k]?.get ?? d[k]?.value);
  const names = (list) => list.map((k) => `cleanup.${k}`).join(', ');
  const listed = CLEANUP_PORTS.filter((k) => NOT_WIRED_CLEANUP.includes(k) && !refuses(k));
  if (listed.length) return `these ports are wired but still listed as not wired: ${names(listed)}`;
  const neither = CLEANUP_PORTS.filter((k) => !NOT_WIRED_CLEANUP.includes(k) && (!d[k] || refuses(k)));
  if (neither.length) return `nothing answers or lists these ports, which the tick needs: ${names(neither)}`;
  const other = Object.keys(d).filter((k) => !CLEANUP_PORTS.includes(k));
  return other.length ? `no tick step reads these ports: ${names(other)}` : null;
}

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function workerPorts(ctx) {
  void ctx;
  // cleanupPass reads a missing folder as nothing to do (cleanup.mjs), which would pass in silence. So each folder itself
  // refuses: the tick spreads this object into the step, and the read throws inside the step.
  const cleanup = Object.fromEntries(NOT_WIRED_CLEANUP.filter((k) => !CLEANUP_FOLDERS.includes(k)).map((k) => [k, refusing(`cleanup.${k}`)]));
  for (const k of NOT_WIRED_CLEANUP.filter((n) => CLEANUP_FOLDERS.includes(n))) Object.defineProperty(cleanup, k, { enumerable: true, get: refusing(`cleanup.${k}`) });
  return { cleanup };
}
