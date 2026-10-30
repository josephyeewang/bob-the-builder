// outbox.mjs — read one AI session's outbox file safely (0b-2 M-3, R2-M8, R2-M9, R2-M10, R3-m7).
//
// WHY. AI sessions never write the record. They drop files in their own outbox, `<outboxRoot>/<role>/<sessionId>/`,
// and the Dispatcher hands each file to the Store Writer. The file is written by an AI, so it is read as hostile:
//   - the role and session come from where the file really is (realpath), never from what it says;
//   - it is opened without following a link, and must be a plain file with one name, owned by the role's user, ≤ 256 KB,
//     so a link to a key file can't be copied into the record;
//   - its kind comes from its name, and must be listed for that role in shared OUTBOX_KINDS.
//
//   readOutboxFile({ outboxRoot, uids, tag, file }) →
//     { ok: true, key, kind, spec, header, body, sha256, realpath } | { ok: false, key, reason }
//   `key` is the file's identity for "seen before": its real path and sha256 (R3-m7). An unsafe file that can't be read
//   is keyed by its path and the reason, so the same refusal is reported once.
//   `uids` maps a role to the uid that must own its files (the owner's user in production).

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { OUTBOX_KINDS, SESSION_ID } from '../../shared/record.mjs';

export const MAX_OUTBOX_BYTES = 256 * 1024;

// The longest listed kind the name starts with (so `report-compact-x` is report-compact-, not report-).
export function kindOf(name) {
  let best = null;
  for (const k of Object.keys(OUTBOX_KINDS)) if (name.startsWith(k) && name.length > k.length && (!best || k.length > best.length)) best = k;
  return best;
}

export function readOutboxFile({ outboxRoot, uids = {}, tag, file }) {
  const given = typeof file === 'string' ? file : '';
  const no = (reason, key = `${given}\0${reason}`) => ({ ok: false, key, reason });
  if (!given) return no('no file');
  if (!tag || typeof tag.role !== 'string' || typeof tag.sessionId !== 'string' || !SESSION_ID.test(tag.sessionId)) return no('bad outbox tag');
  if (typeof outboxRoot !== 'string' || !outboxRoot) return no('no outbox root configured');

  let real; let folder;
  try { real = realpathSync(given); } catch { return no('file not found'); }
  // The role and session folders themselves may not be links: a session folder linked to another's would hand that
  // session's files in under this tag (0b-2 audit MIN-5).
  try {
    for (const p of [join(outboxRoot, tag.role), join(outboxRoot, tag.role, tag.sessionId)]) if (lstatSync(p).isSymbolicLink()) return no(`outbox folder ${basename(p)} is a link`);
    folder = realpathSync(join(outboxRoot, tag.role, tag.sessionId));
  } catch { return no(`no outbox folder for ${tag.role} ${tag.sessionId}`); }
  if (dirname(real) !== folder) return no(`file is not directly inside the ${tag.role} outbox of session ${tag.sessionId}`);
  // The name given must be the file itself, not a link to it: realpath follows links, O_NOFOLLOW checks the last part.
  if (basename(given) !== basename(real)) return no('file is a link');

  const name = basename(real);
  const kind = kindOf(name);
  if (!kind) return no(`no outbox kind for file name ${name.slice(0, 80)}`);
  const spec = OUTBOX_KINDS[kind];
  if (!spec.roles.includes(tag.role)) return no(`outbox kind ${kind} is not listed for ${tag.role}`);
  if (!spec.entity) return no(`outbox kind ${kind} has no record rule yet`);

  const owner = uids[tag.role];
  if (!Number.isInteger(owner)) return no(`no owner uid configured for ${tag.role} outboxes`);
  let fd;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { return no(e?.code === 'ELOOP' ? 'file is a link' : `can't open file (${e?.code ?? 'error'})`); }
  let buf;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return no('not a plain file');
    if (st.nlink !== 1) return no('file has more than one name (a hard link)');
    if (st.uid !== owner) return no(`file is owned by uid ${st.uid}, not the ${tag.role} outbox owner`);
    if (st.size > MAX_OUTBOX_BYTES) return no(`file is ${st.size} bytes, over ${MAX_OUTBOX_BYTES}`);
    buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, got); if (!n) break; got += n; }
    // A file that grew past the limit after fstat is cut at the size fstat saw; a second read finds the rest.
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) return no('file changed while being read');
    buf = buf.subarray(0, got);
  } finally { closeSync(fd); }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const key = `${real}\0${sha256}`;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return no('file is not valid UTF-8 text', key); }

  if (spec.mode === 'create') return { ok: true, key, kind, spec, header: null, body: text, sha256, realpath: real };
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  let header;
  try { header = JSON.parse(first); } catch { return no('the first line is not a JSON header', key); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return no('the header is not a JSON object', key);
  if (header.entity !== spec.entity) return no(`a ${kind} file's header must name entity ${spec.entity}`, key);
  if (header.fields !== undefined && (!header.fields || typeof header.fields !== 'object' || Array.isArray(header.fields))) return no('header fields must be an object', key);
  return { ok: true, key, kind, spec, header, body: nl < 0 ? '' : text.slice(nl + 1), sha256, realpath: real };
}
