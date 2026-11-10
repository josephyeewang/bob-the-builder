// A worker's outbox: the one check on it (#219 audit M-1). The Dispatcher runs it on what the launcher answers, and the
// push script on what the session record says, so a push can never read a bundle from another session's folder, such
// as an older attempt's: that would send stale work under the new attempt, and the new work would never be read.
//
// The outbox is <outbox root>/<product>/<role>/<session id> (L836, shared/product-paths.mjs), where role is the one the
// session runs and hands in as: worker, or script for a script card (L767: a script has its own outbox, so tag.role
// names one thing, the folder, the kinds it may write and the actor). workerOutboxProblem checks a path against the
// product's own folder; outboxProblemFor finds that folder from the root. Without a root only the path's shape can be
// checked; with it, the real folder must be that exact one, through any link.

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runnerPlaces } from '../../../shared/product-paths.mjs';

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

/**
 * workerOutboxProblem for a session of `product`, whose outboxes are its own folder under the outbox root (`outboxRoot`
 * is the root, not the product's folder, #378 r1 m2; L836:
 * <outboxRoot>/<product>/<role>/<session id>, shared/product-paths.mjs runnerPlaces). With no root, only the shape is
 * checked, as workerOutboxProblem does; a product the runner's folders can't hold has no outbox, and is said so.
 */
export function outboxProblemFor(outbox, sessionId, { outboxRoot, product, role, realpath } = {}) {
  const opts = { ...(role !== undefined ? { role } : {}), ...(realpath ? { realpath } : {}) };
  if (outboxRoot === undefined || outboxRoot === null) return workerOutboxProblem(outbox, sessionId, opts);
  // A root that is no full path (an empty one, or one read against wherever the process runs) is no place (L836 c3).
  if (typeof outboxRoot !== 'string' || !isAbsolute(outboxRoot)) return 'has no product folder to be in (the outbox root is not a full path)';
  let root;
  try { root = runnerPlaces({ copiesRoot: '/', outboxRoot, product }).outboxes; } catch (e) { return `has no product folder to be in (${e?.message ?? e})`; }
  return workerOutboxProblem(outbox, sessionId, { ...opts, root });
}
