// The ports that start, find and stop a worker (PR C and the worker half of D), and the cleanup group.
//
// `wire()` calls `workerPorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_WORKER, in the same change. dispatcher-wiring.mjs stays as it is.

import { isRefusing, refusing } from './not-wired.mjs';

export const NOT_WIRED_WORKER = Object.freeze(['sessions', 'probe', 'launch', 'stopGroup', 'saveWork', 'hostLock', 'pauseLead',
  'board', 'outboxSessions', 'reviewEnded', 'stopSession']);
// What the cleanup step reads, and which of those aren't wired yet. To wire one: answer it in `cleanup` below and take it off
// NOT_WIRED_CLEANUP.
export const CLEANUP_PORTS = Object.freeze(['mirrorFor', 'git', 'saveWork', 'copiesRoot']);
export const NOT_WIRED_CLEANUP = Object.freeze([...CLEANUP_PORTS]);

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
  // cleanupPass reads a missing copies folder as "nothing to clean" (cleanup.mjs), which would pass in silence. So the
  // folder itself refuses: the tick spreads this object into the step, and the read throws inside the step.
  const cleanup = Object.defineProperty(Object.fromEntries(NOT_WIRED_CLEANUP.filter((k) => k !== 'copiesRoot').map((k) => [k, refusing(`cleanup.${k}`)])), 'copiesRoot',
    { enumerable: true, get: refusing('cleanup.copiesRoot') });
  return { cleanup };
}
