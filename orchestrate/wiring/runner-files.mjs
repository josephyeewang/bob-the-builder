// Part C, runner step 2 (L763, #320 m2): how the worker runner writes its status and reads a request. The workers run as
// the runner's own Mac user. A real sandbox-exec probe showed that a hard link to the runner's status or a request file,
// made outside the sandbox, lets a sandboxed shell write through it: the deny rules match the path, not the file.
//   - The status is never written in place: the runner writes a new file beside it and renames it over the old one. A
//     link anyone made to the old file keeps the old file, never the runner's next status.
//   - A request (or a status) with more than one name, or that is a link, a pipe or anything but a plain file, is never
//     read. A request must also be owned by the orchestrate user (the Dispatcher writes them, never the owner's user),
//     writable by no one else, and a JSON object.
// The Dispatcher's own read of the status (owner-status.mjs openRead) refuses a second name the same way.
// The bound (L769, #328 r1 M1): a forged status needs an unsandboxed process running as the owner; that is outside the wall's job. A process that made such a link could hold the file open, remove the link
// and write through the open file with one name again; only the runner's next rename ends that, so the runner rewrites
// its status at least every RUNNER_STATUS_EVERY_MS (owner-status.mjs). A sandboxed shell can't make the link at all:
// runner-launch.test.mjs pins that under macOS's own sandbox. The lasting fix is L751's: workers off the runner's user.

import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** The largest request read: the Dispatcher's are a few hundred bytes. */
export const REQUEST_MAX_BYTES = 16_384;

/**
 * Write the status: a new file in the same folder (created, never opened through a link or over an existing one), synced,
 * then renamed over `file`. → nothing; any failure throws and leaves the old status as it was.
 */
export function writeStatus(file, text, { fs = { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync }, tag = () => randomBytes(6).toString('hex') } = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('the status file is not a full path');
  const tmp = join(dirname(file), `.${basename(file)}.${tag()}.tmp`);
  const fd = fs.openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  let closed = false; let done = false;
  try {
    const buf = Buffer.from(text, 'utf8');
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    closed = true; fs.closeSync(fd);
    fs.renameSync(tmp, file);
    done = true;
  } finally {
    // Never close the same number twice (review m1): by then it may be another file's.
    if (!done) { if (!closed) { try { fs.closeSync(fd); } catch { /* gone */ } } try { fs.unlinkSync(tmp); } catch { /* not made */ } }
  }
  // The rename itself survives a crash only once the folder is synced; a failure here leaves a status already in place.
  try { const d = fs.openSync(dirname(file), constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* best effort */ }
}

/**
 * Read one request file as the runner: opened once, never through a link and never waiting; that open file must be a
 * plain file with one name, owned by `orchestrateUid`, and small. → the parsed request, or { refused: reason }.
 */
export function readRequest(file, { orchestrateUid, open = openSync, fstat = fstatSync, read = readFileSync, close = closeSync } = {}) {
  if (!Number.isInteger(orchestrateUid) || orchestrateUid < 0) throw new Error('the orchestrate user\'s uid is not known, so no request can be trusted');
  let fd;
  try { fd = open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return { refused: e?.code === 'ELOOP' ? 'the request is a link' : `the request can't be opened (${e?.code ?? e?.message})` };
  }
  try {
    const st = fstat(fd);
    if (!st.isFile()) return { refused: 'the request is not a plain file' };
    if (st.nlink !== 1) return { refused: `the request has ${st.nlink} names; a second name is a way to write it from elsewhere` };
    if (st.uid !== orchestrateUid) return { refused: 'the request is not the orchestrate user\'s' };
    if (st.mode & 0o022) return { refused: 'the request can be written by others' };
    if (st.size > REQUEST_MAX_BYTES) return { refused: 'the request is larger than any the Dispatcher writes' };
    const text = read(fd, 'utf8');
    if (Buffer.byteLength(text) > REQUEST_MAX_BYTES) return { refused: 'the request is larger than any the Dispatcher writes' };
    let r; try { r = JSON.parse(text); } catch { return { refused: 'the request can\'t be read' }; }
    return r && typeof r === 'object' && !Array.isArray(r) && !Object.hasOwn(r, 'refused') ? r : { refused: 'the request is not what the Dispatcher writes' };
  } finally { close(fd); }
}
