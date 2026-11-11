// A worker's outbox: the one check on it (#219 audit M-1). The Dispatcher runs it on what the launcher answers, and the
// push script on what the session record says, so a push can never read a bundle from another session's folder, such
// as an older attempt's: that would send stale work under the new attempt, and the new work would never be read.
//
// The outbox is <outbox root>/<product>/<role>/<session id> (L836, shared/product-paths.mjs), where role is the one the
// session runs and hands in as: worker, or script for a script card (L767: a script has its own outbox, so tag.role
// names one thing, the folder, the kinds it may write and the actor). workerOutboxProblem checks a path against the
// product's own folder; outboxProblemFor checks it is the session's own product's. Without a root, the path's shape and
// its product folder's name are checked (#403 r1 M1); with it, the real folder must be that exact one, through any link.

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PRODUCT_OUTBOX_ROLES, runnerOutbox, runnerPlaces } from '../../../shared/product-paths.mjs';

/** The roles a worker-runner session hands in as, each with its own outbox folder (L767): the one list, PRODUCT_OUTBOX_ROLES (L910 m3). */
export const WORKER_OUTBOX_ROLES = PRODUCT_OUTBOX_ROLES;

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
 * <outboxRoot>/<product>/<role>/<session id>, shared/product-paths.mjs runnerPlaces). A product the runner's folders
 * can't hold has no outbox, and is said so. With no root, the shape is checked as workerOutboxProblem does, and the
 * folder above the role must be named for this product (#403 r1 M1: the old flat place, or another product's, is not
 * this session's own). That is a check by name only, so a caller that can know the root passes it: the pass and the
 * push both do (the push requires it). With a root, the real outbox must be runnerOutbox under the real root, through
 * any link in the outbox or the root (#403 r1 m3).
 */
export function outboxProblemFor(outbox, sessionId, { outboxRoot, product, role, realpath = realpathSync } = {}) {
  const opts = { ...(role !== undefined ? { role } : {}), realpath };
  const noRoot = outboxRoot === undefined || outboxRoot === null;
  // A root that is no full path (an empty one, or one read against wherever the process runs) is no place (L836 c3).
  if (!noRoot && (typeof outboxRoot !== 'string' || !isAbsolute(outboxRoot))) return 'has no product folder to be in (the outbox root is not a full path)';
  try { runnerPlaces({ copiesRoot: '/', outboxRoot: noRoot ? '/' : outboxRoot, product }); } catch (e) { return `has no product folder to be in (${e?.message ?? e})`; }
  const shape = workerOutboxProblem(outbox, sessionId, opts);
  if (shape) return shape;
  const under = outbox.split('/').at(-2);
  if (noRoot) return outbox.split('/').at(-3) === product ? null : `is not in product ${product}'s own folder`;
  let own;
  try { own = runnerOutbox({ outboxRoot: realpath(outboxRoot), product, role: under, sessionId }); } catch (e) { return `could not be read (${e?.code ?? e?.message ?? e})`; }
  try { if (realpath(outbox) !== own) return 'is not inside the outbox root'; } catch (e) { return `could not be read (${e?.code ?? e?.message ?? e})`; }
  return null;
}
