// A worker's outbox: the one check on it (#219 audit M-1). The Dispatcher runs it on what the launcher answers, and the
// push script on what the session record says, so a push can never read a bundle from another session's folder, such
// as an older attempt's: that would send stale work under the new attempt, and the new work would never be read.
//
// The outbox is <outbox root>/<role>/<session id>, where role is the one the session runs and hands in as: worker, or
// script for a script card (L767: a script has its own outbox, so tag.role names one thing, the folder, the kinds it may
// write and the actor). setup/layout.mjs makes the root's role folders. Without the root only the path's shape can be
// checked; with it, the real folder must be that exact one, through any link.

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The roles a worker-runner session hands in as, each with its own outbox folder (L767). */
export const WORKER_OUTBOX_ROLES = Object.freeze(['worker', 'script']);

/**
 * What is wrong with `outbox` as session `sessionId`'s own outbox, in words, or null when it is right. `role` is the
 * role it must be under (default worker), or a list of them for a reader that does not know which (the push script:
 * the session record says worker for a script card too, L759).
 */
export function workerOutboxProblem(outbox, sessionId, { root, realpath = realpathSync, role = 'worker' } = {}) {
  const roles = typeof role === 'string' ? [role] : role;
  if (!Array.isArray(roles) || !roles.length || roles.some((r) => !WORKER_OUTBOX_ROLES.includes(r))) return 'was checked against no runner role';
  if (typeof outbox !== 'string' || !outbox) return 'was not named';
  if (!isAbsolute(outbox)) return 'is not a full path';
  const parts = outbox.split('/').slice(1);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'is not a plain path';
  if (typeof sessionId !== 'string' || !sessionId || parts.at(-1) !== sessionId) return "is not this session's own folder";
  const under = parts.at(-2);
  if (!roles.includes(under)) return `is not a ${roles.join(' or ')} outbox`;
  if (root === undefined || root === null) return null;
  try {
    if (realpath(outbox) !== join(realpath(root), under, sessionId)) return 'is not inside the outbox root';
  } catch (e) { return `could not be read (${e?.code ?? e?.message ?? e})`; }
  return null;
}
