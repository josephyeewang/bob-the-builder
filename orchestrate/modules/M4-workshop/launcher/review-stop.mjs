// The Dispatcher's stop request to the review runner (L933 item 3, L935). The Dispatcher's stop step does not reach a
// reviewer or auditor (they carry no product); it asks the review runner to end one, by the request id the Dispatcher
// started it on. The runner (review-runner.mjs) counts a stop only for a reviewer or auditor it is running under that very
// id, which it keeps in its own memory and shows no one, so the id is the proof the Dispatcher asked; never a card id
// (L927). A stop for an id it doesn't know, or one already ended, does nothing and says why in the status.
//
//   writeStopRequest({ dir, requestId }) → { ok, name } | { ok: false, reason }
//     dir: the runner's requests/ folder. Writes stop-<new id>.json holding exactly { request_id, stop: true }, whole
//     under a hidden name and then given its own, never over another file, readable by the runner (0644 whatever the
//     writer's umask: the Dispatcher's job runs with 077).
//
// Nothing calls it yet: lane 2's worker-ports wires it to the Dispatcher's stop step. Writing a file is all it does.

import { closeSync, constants, fchmodSync, fstatSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { REQUEST_ID, REQUEST_NAME, STOP_KEYS, STOP_PREFIX } from './review-runner.mjs';

export { STOP_KEYS, STOP_PREFIX };

export function writeStopRequest({ dir, requestId, newName = randomUUID, tmpId = randomUUID }) {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return { ok: false, reason: 'the request id is not letters, digits and dashes' };
  const name = `${STOP_PREFIX}${newName()}.json`;
  if (!REQUEST_NAME.test(name)) return { ok: false, reason: 'the new file name is not letters, digits and dashes' };
  // The hidden name holds no request id: the runner skips dot names, and no one but the writer needs to know it.
  const tmp = join(dir, `.${STOP_PREFIX}${tmpId()}.tmp`);
  const body = JSON.stringify(Object.fromEntries(STOP_KEYS.map((k) => [k, k === 'stop' ? true : requestId])));
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
