// The ports that start, find and stop a worker (PR C and the worker half of D), and the cleanup group.
//
// `wire()` calls `workerPorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_WORKER, in the same change. dispatcher-wiring.mjs stays as it is.

import { refusing } from './not-wired.mjs';

export const NOT_WIRED_WORKER = Object.freeze(['sessions', 'probe', 'launch', 'stopGroup', 'saveWork', 'hostLock', 'pauseLead',
  'board', 'outboxSessions', 'reviewEnded', 'stopSession']);
export const NOT_WIRED_CLEANUP = Object.freeze(['mirrorFor', 'git', 'saveWork']);

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function workerPorts(ctx) {
  void ctx;
  // cleanupPass reads a missing copies folder as "nothing to clean" (cleanup.mjs), which would pass in silence. So the
  // folder itself refuses: the tick spreads this object into the step, and the read throws inside the step.
  const cleanup = Object.defineProperty(Object.fromEntries(NOT_WIRED_CLEANUP.map((k) => [k, refusing(`cleanup.${k}`)])), 'copiesRoot',
    { enumerable: true, get: refusing('cleanup.copiesRoot') });
  return { cleanup };
}
