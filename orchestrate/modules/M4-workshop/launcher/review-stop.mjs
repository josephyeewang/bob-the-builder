// The Dispatcher's stop request to the review runner (L933 item 3, L935). The Dispatcher's stop step does not reach a
// reviewer or auditor (they carry no product); it asks the review runner to end one. The proof the Dispatcher asked is
// the file's owner: the runner (review-runner.mjs) counts a stop only when the file is the Dispatcher's Mac user's
// (L935 re-review 2 M1). By request id, it reaches the session started on that id, which the runner keeps in its own
// memory and shows no one: a second layer. By card, role and head (L946), it reaches every reviewer or auditor running
// for exactly those, whoever's request started it. A stop that reaches no running session is kept 30 minutes, so a
// request it names is refused, not started, in that time (by id the first such request; by card, role and head every
// one); the status says what each did.
//
//   writeStopRequest({ dir, requestId } | { dir, target: { card, role, head } }) → { ok, name } | { ok: false, reason }
//     dir: the runner's requests/ folder. Writes stop-<new id>.json holding exactly { request_id, stop: true } (or
//     { card, head, role, stop: true }), whole
//     under a hidden name and then given its own, never over another file, readable by the runner (0644 whatever the
//     writer's umask: the Dispatcher's job runs with 077).
//
// Called by the Dispatcher's stop step through M11 review-requests.mjs reviewPorts.stopReview (L946). Writing a file is all it does.

import { closeSync, constants, fchmodSync, fstatSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CARD_ID, REQUEST_ID, REQUEST_NAME, STOP_KEYS, STOP_PREFIX, STOP_TARGET_KEYS } from './review-runner.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';

export { STOP_KEYS, STOP_PREFIX, STOP_TARGET_KEYS };

export function writeStopRequest({ dir, requestId, target, newName = randomUUID, tmpId = randomUUID }) {
  let doc;
  if (target !== undefined) {
    if (requestId !== undefined) return { ok: false, reason: 'a stop names a request id or a card, role and head, not both' };
    const { card, role, head } = target ?? {};
    if (typeof card !== 'string' || !CARD_ID.test(card) || card.startsWith('.')) return { ok: false, reason: 'the card id is not a plain id' };
    if (!REVIEW_ROLES.includes(role)) return { ok: false, reason: `a stop names a role of ${REVIEW_ROLES.join(' or ')}` };
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return { ok: false, reason: 'the head is not 40 hex' };
    doc = { card, head, role, stop: true };
  } else {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return { ok: false, reason: 'the request id is not letters, digits and dashes' };
    doc = Object.fromEntries(STOP_KEYS.map((k) => [k, k === 'stop' ? true : requestId]));
  }
  const name = `${STOP_PREFIX}${newName()}.json`;
  if (!REQUEST_NAME.test(name)) return { ok: false, reason: 'the new file name is not letters, digits and dashes' };
  // The hidden name holds no request id: the runner skips dot names, and no one but the writer needs to know it.
  const tmp = join(dir, `.${STOP_PREFIX}${tmpId()}.tmp`);
  const body = JSON.stringify(doc);
  let made = false;
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    made = true;
    try {
      if (!fstatSync(fd).isFile()) throw new Error('not a plain file');
      fchmodSync(fd, 0o644);
      const buf = Buffer.from(body);
      let n = 0;
      while (n < buf.length) n += writeSync(fd, buf, n, buf.length - n);
    } finally { closeSync(fd); }
    linkSync(tmp, join(dir, name));
  } catch (e) {
    return { ok: false, reason: `the stop request could not be written (${e?.code ?? e?.message ?? e})` };
  } finally { if (made) try { unlinkSync(tmp); } catch { /* gone */ } }
  return { ok: true, name };
}
