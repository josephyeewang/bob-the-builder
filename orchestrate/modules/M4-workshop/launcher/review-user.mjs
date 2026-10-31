// The review user (lead calls L44, L65). Every other AI role writes its outbox as the same Mac user, so a worker could
// hand in a forged reviewer's verdict. So every reviewer and auditor session runs as a third plain Mac user,
// `review`, and writes into an outbox folder only `review` can write. There is no sudo rule: the review runner
// (review-runner.mjs) runs as `review` from a LaunchDaemon and is the only thing that starts these sessions, so the
// launcher accepts a review role only when it is itself running as the review user. This file is that half:
//
//   reviewUser({ role, uids, self })   → { ok, runAs: { user, uid } } for a review role, { ok, runAs: null } otherwise
//   reviewOutbox({ outboxRoot, role, sessionId }) → the session's outbox folder, <root>/<role>/<session id>
//   checkReviewOutbox({ ..., uid, stat })       → the role and session folders are review's alone
//
// `uids` maps each role to the Mac user id that runs it (the same map M9's outbox reader takes); M9's
// `reviewUserProblem` is the one check that the review user is a separate, non-root user. Making the Mac user and
// installing the runner are Joe's steps (README).

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_ID } from '../../../shared/record.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { reviewUserProblem } from '../../M9-record/outbox.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';

export { REVIEW_ROLES };
export const REVIEW_USER = 'review';
const refuse = (reason) => ({ ok: false, reason });
const ownUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * A review role starts only from the review runner, which runs as the review user: `self` (this process's uid; tests
 * pass it, production never does, m-2) must be that user's. Every other role gets runAs null.
 */
export function reviewUser({ role, uids, self = ownUid() }) {
  if (!REVIEW_ROLES.includes(role)) return { ok: true, runAs: null };
  const bad = uidsProblem(uids) ?? reviewUserProblem(uids, role);
  if (bad) return refuse(bad);
  const own = uids[role];
  if (own !== self) return refuse(`a ${role} is started only by the review runner, running as the review user (uid ${own}), not uid ${self}`);
  return { ok: true, runAs: { user: REVIEW_USER, uid: own } };
}

/**
 * m-1: the map must name the Mac user of every role in the design table, or a role left out could share the review
 * user without the shared-user check seeing it. Null, or what is missing.
 */
export function uidsProblem(uids) {
  if (!uids || typeof uids !== 'object') return 'no map of role to Mac user id is set';
  const missing = Object.keys(DESIGN_PROFILES).filter((r) => !Number.isInteger(uids[r]) || uids[r] < 0);
  return missing.length ? `the map of role to Mac user id leaves out ${missing.join(', ')}` : null;
}

export function reviewOutbox({ outboxRoot, role, sessionId }) {
  if (!REVIEW_ROLES.includes(role)) throw new Error(`reviewOutbox: ${role} is not a review role`);
  if (typeof outboxRoot !== 'string' || !outboxRoot.startsWith('/')) throw new Error('reviewOutbox: outboxRoot must be a full path');
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('reviewOutbox: a session id is letters, digits and dashes, at most 128');
  return join(outboxRoot, role, sessionId);
}

/** The role folder and the session folder: present, plain folders (not links), owned by `uid`, writable by no one else. */
export function checkReviewOutbox({ outboxRoot, role, sessionId, uid, stat = lstatSync }) {
  let session;
  try { session = reviewOutbox({ outboxRoot, role, sessionId }); } catch (e) { return refuse(e.message); }
  for (const [what, d] of [['role', join(outboxRoot, role)], ['session', session]]) {
    let st; try { st = stat(d); } catch { return refuse(`the ${role} ${what} outbox folder is missing`); }
    if (st.isSymbolicLink()) return refuse(`the ${role} ${what} outbox folder is a link`);
    if (!st.isDirectory()) return refuse(`the ${role} ${what} outbox folder is not a folder`);
    if (st.uid !== uid) return refuse(`the ${role} ${what} outbox folder is not owned by the review user`);
    if (st.mode & 0o022) return refuse(`the ${role} ${what} outbox folder can be written by others than the review user`);
  }
  return { ok: true, outbox: session };
}
