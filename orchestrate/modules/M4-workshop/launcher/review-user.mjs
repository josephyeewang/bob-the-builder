// The review user (lead call L44). Every other AI role writes its outbox as the same Mac user, so a worker could
// hand in a forged reviewer's verdict. So every reviewer and auditor session runs as a third plain Mac user,
// `review`, and writes into an outbox folder only `review` can write. The record (M9) and the Merge Gate (M6) accept
// a verdict only from such a folder, and only from a session the Dispatcher recorded as a reviewer on that exact
// head (M11 merges.mjs `recordReviewerLaunch`). This file is the launcher's half:
//
//   reviewUser({ role, uids, self })   → { ok, runAs: { user, uid } } for a review role, { ok, runAs: null } otherwise
//   startCommand({ bin, args, runAs }) → the command that starts the session as that user (sudo, never asking)
//   reviewOutbox({ outboxRoot, role, sessionId }) → the session's outbox folder, <root>/<role>/<session id>
//   prepareReviewOutbox({ ..., uid, run, stat }) → makes that folder as the review user, then checks it
//   checkReviewOutbox({ ..., uid, stat })       → the role and session folders are review's alone
//
// `uids` maps each role to the Mac user id that runs it (the same map M9's outbox reader takes). The review user
// must have a uid of its own: not root, not any other role's, and not the launcher's own (then a switch to it would
// change nothing). Making the Mac user, its role folders and the rule that lets the scripts start it are Joe's steps
// (README, R-0b-05). A start never asks for a password: sudo -n fails at once instead, so a missing rule can't hang.

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_ID } from '../../../shared/record.mjs';

export const REVIEW_ROLES = Object.freeze(['reviewer', 'auditor']);
export const REVIEW_USER = 'review';
export const SUDO = '/usr/bin/sudo';
export const MKDIR = '/bin/mkdir';
const refuse = (reason) => ({ ok: false, reason });
const ownUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

export function reviewUser({ role, uids, self = ownUid() }) {
  if (!REVIEW_ROLES.includes(role)) return { ok: true, runAs: null };
  const own = uids?.[role];
  if (!Number.isInteger(own) || own < 0) return refuse(`no review user id is set for ${role}`);
  if (own === 0) return refuse('the review user may not be root');
  if (own === self) return refuse('the review user is the launcher\'s own user, so the switch would change nothing');
  const shared = Object.entries(uids).filter(([r, u]) => !REVIEW_ROLES.includes(r) && u === own).map(([r]) => r);
  if (shared.length) return refuse(`the review user is not a separate Mac user (shared with ${shared.join(', ')})`);
  return { ok: true, runAs: { user: REVIEW_USER, uid: own } };
}

/** The start as the review user: `sudo -n -H -u review -- <bin> <args>`; unchanged when `runAs` is null. */
export function startCommand({ bin, args, runAs }) {
  if (typeof bin !== 'string' || !bin.startsWith('/')) throw new Error('startCommand: bin must be a full path');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error('startCommand: args must be strings');
  if (runAs == null) return { bin, args: [...args] };
  if (runAs.user !== REVIEW_USER || !Number.isInteger(runAs.uid) || runAs.uid <= 0) throw new Error('startCommand: runAs is not the review user');
  return { bin: SUDO, args: ['-n', '-H', '-u', REVIEW_USER, '--', bin, ...args] };
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

/**
 * Makes the session's outbox as the review user, then checks it. `run({ bin, args })` runs one command with a time
 * limit and no input and returns { status }; the real one wraps spawnSync. A folder that is already there is refused:
 * a session id is never reused, so a folder for it means someone made it first.
 */
export function prepareReviewOutbox({ outboxRoot, role, sessionId, uid, run, stat = lstatSync }) {
  let dir;
  try { dir = reviewOutbox({ outboxRoot, role, sessionId }); } catch (e) { return refuse(e.message); }
  let there = true;
  try { stat(dir); } catch { there = false; }
  if (there) return refuse(`an outbox folder for session ${sessionId} is already there; a session id is never reused`);
  let r;
  try { r = run({ bin: SUDO, args: ['-n', '-u', REVIEW_USER, '--', MKDIR, '-m', '0755', dir] }); } catch (e) { r = { status: null, error: e.message }; }
  if (r?.status !== 0) return refuse(`the review user could not make the outbox folder (${r?.error ?? `exit ${r?.status}`})`);
  return checkReviewOutbox({ outboxRoot, role, sessionId, uid, stat });
}
