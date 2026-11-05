// A worker's outbox: the one check on it (#219 audit M-1). The Dispatcher runs it on what the launcher answers, and the
// push script on what the session record says, so a push can never read a bundle from another session's folder, such
// as an older attempt's: that would send stale work under the new attempt, and the new work would never be read.
//
// The outbox is <outbox root>/worker/<session id> (setup/layout.mjs makes the root's role folders). Without the root
// only the path's shape can be checked; with it, the real folder must be that exact one, through any link.

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** What is wrong with `outbox` as session `sessionId`'s own worker outbox, in words, or null when it is right. */
export function workerOutboxProblem(outbox, sessionId, { root, realpath = realpathSync } = {}) {
  if (typeof outbox !== 'string' || !outbox) return 'was not named';
  if (!isAbsolute(outbox)) return 'is not a full path';
  const parts = outbox.split('/').slice(1);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'is not a plain path';
  if (typeof sessionId !== 'string' || !sessionId || parts.at(-1) !== sessionId) return "is not this session's own folder";
  if (parts.at(-2) !== 'worker') return 'is not a worker outbox';
  if (root === undefined || root === null) return null;
  try {
    if (realpath(outbox) !== join(realpath(root), 'worker', sessionId)) return 'is not inside the outbox root';
  } catch (e) { return `could not be read (${e?.code ?? e?.message ?? e})`; }
  return null;
}
