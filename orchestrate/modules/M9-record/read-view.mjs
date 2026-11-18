// read-view.mjs — the Record read only, by a user who is not its owner (L995, L998): one card, product, fact or session,
// and the list of cards, straight from the document files the Store Writer keeps (store.mjs docPathOf, the one statement
// of the layout). Nothing is written, moved or created: a missing or odd folder or file is an answer, never fixed here.
//
// The safety checks are here once (moved unchanged from M4 review-runner-main.mjs, L998), and every reader goes
// through them:
//   - each folder on the way (the root, docs/, docs/<entity>/) is a plain folder of the Record's owner that no one else
//     writes (recordFolderProblem);
//   - the file is opened without following a link, and must be a plain file with one name (nlink 1), of the Record's
//     owner, written by no one else, no larger than MAX_DOC_BYTES, and JSON `{ entity, id, doc, rev }` naming the very
//     document asked for (readRecordFile);
//   - the exact name is found in the folder's listing before anything opens it: on a disk that ignores case, `c-1`
//     would open the file of `C-1`.
// The Store Writer's own diary check (store.mjs read) is not made here: a reader that is not the owner can't open the
// diary's lock. What is read is what the owner's files say now.
//
//   readDocFile({ recordRoot, recordUid, entity, id, missing }) → { ok: true, doc, rev } | { ok: false, missing?, reason }
//   readProductFile({ recordRoot, recordUid, product })        → the same, for docs/product/<id>.json
//   listDocFiles({ recordRoot, recordUid, entity })            → { ok: true, docs: [{ id, doc, rev }], unread: [{ id, reason }] } | { ok: false, reason }
//                                                                (cards, for check 12's gate; products, for the runner's requestGapMs)
//   readMeta({ recordRoot, recordUid, entity, id })            → { ok: true, meta: { createdBy, createdKind, stateSince, ts, seq } | null } | { ok: false, reason }
//   recordView({ recordRoot, recordUid })                      → { read(entity, id), list(entity), meta(entity, id) }: M11 gate.mjs's `rec`, read only
//
// meta is the diary's own answer (who created the document): read line by line, never whole (it grows without limit),
// and replayed by store.mjs's own parser, absorbDiaryLine (L999). A line that is cut short or doesn't follow the one
// before it ends the replay: a document created before it is answered, any other is refused, never "no creator".
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { absorbDiaryLine, docPathOf } from './store.mjs';

export const MAX_DOC_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9._-]{1,200}$/;
// The entities a reader may name: those check 12's gate reads (card, product, fact, and merge for an undo's exact reverse,
// M11 undo.mjs mergeOf), and the session the worker runner's drain reads.
export const READ_ENTITIES = Object.freeze(['card', 'product', 'fact', 'merge', 'session']);

// A folder of the Record: a plain folder of the Record's owner that no one else writes. Null, or the problem.
export function recordFolderProblem(d, recordUid) {
  let st; try { st = lstatSync(d); } catch { return `${d} is missing`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${d} is not a plain folder`;
  if (st.uid !== recordUid || st.mode & 0o022) return `${d} is not the Record owner's alone`;
  return null;
}

// One document of the Record, read only: a plain file of the Record's owner that no one else writes, never a link.
export function readRecordFile(p, recordUid, entity, id, missing) {
  let fd;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return { ok: false, ...(e?.code === 'ENOENT' ? { missing: true } : {}), reason: e?.code === 'ENOENT' ? missing : `it can't be read (${e?.code ?? e})` }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== recordUid || st.mode & 0o022 || st.size > MAX_DOC_BYTES) return { ok: false, reason: 'its file is not the Record\'s own plain file' };
    const d = JSON.parse(readFileSync(fd, 'utf8'));
    // An id that isn't the one asked for is no such document: on a disk that ignores case, `c-1` opens the file of `C-1`.
    if (d?.entity !== entity || d?.id !== id || !d.doc || typeof d.doc !== 'object') return { ok: false, ...(d?.entity === entity && typeof d.id === 'string' && d.id !== id ? { missing: true } : {}), reason: `its file is not a ${entity} document` };
    return { ok: true, doc: d.doc, rev: Number.isInteger(d.rev) ? d.rev : null };
  } catch { return { ok: false, reason: 'its file is not JSON' }; } finally { closeSync(fd); }
}

/** The folder of one entity's documents, through store.mjs's layout. */
const entityDir = (recordRoot, entity) => dirname(docPathOf(recordRoot, entity, 'x'));

/** Each folder from the root down to docs/<entity>/: null, or the first problem. */
function foldersProblem(recordRoot, recordUid, entity) {
  const dir = entityDir(recordRoot, entity);
  for (const d of [recordRoot, dirname(dir), dir]) {
    const bad = recordFolderProblem(d, recordUid);
    if (bad) return bad;
  }
  return null;
}

/**
 * One document, read only. `missing` is the reason given when there is none ("no such card"). The id's own form is the
 * caller's to check first (its entity's id rule); here it must at least be a plain name.
 */
export function readDocFile({ recordRoot, recordUid, entity, id, missing = `no such ${entity}` }) {
  if (!READ_ENTITIES.includes(entity)) return { ok: false, reason: `${String(entity).slice(0, 40)} is not an entity this view reads` };
  if (typeof id !== 'string' || !ID.test(id) || id.startsWith('.')) return { ok: false, missing: true, reason: `not a ${entity} id` };
  const bad = foldersProblem(recordRoot, recordUid, entity);
  if (bad) return { ok: false, reason: bad };
  const dir = entityDir(recordRoot, entity);
  let names;
  try { names = readdirSync(dir); } catch (e) { return { ok: false, reason: `the ${entity} folder could not be listed (${e?.code ?? e?.message})` }; }
  if (!names.includes(`${id}.json`)) return { ok: false, missing: true, reason: missing };
  return readRecordFile(docPathOf(recordRoot, entity, id), recordUid, entity, id, missing);
}

/** A product from the Record, read only: docs/product/<id>.json. */
export const readProductFile = ({ recordRoot, recordUid, product }) => readDocFile({ recordRoot, recordUid, entity: 'product', id: product, missing: 'no such product' });

// The entities a list may name.
export const LIST_ENTITIES = Object.freeze(['card', 'product', 'merge']);

/**
 * Every card (or product, or merge), read only. A file that fails a check is listed in `unread` with its reason, never read as a
 * document, so a caller that needs every one (check 12's disjoint files) can refuse rather than pass on part of the list.
 * A folder not made yet is no documents: the Store Writer makes docs/<entity>/ at its first write of one.
 */
export function listDocFiles({ recordRoot, recordUid, entity }) {
  if (!LIST_ENTITIES.includes(entity)) return { ok: false, reason: `${String(entity).slice(0, 40)} is not an entity this view lists` };
  const dir = entityDir(recordRoot, entity);
  for (const d of [recordRoot, dirname(dir)]) { const bad = recordFolderProblem(d, recordUid); if (bad) return { ok: false, reason: bad }; }
  try { lstatSync(dir); } catch (e) { if (e?.code === 'ENOENT') return { ok: true, docs: [], unread: [] }; }
  const bad = recordFolderProblem(dir, recordUid);
  if (bad) return { ok: false, reason: bad };
  let names;
  try { names = readdirSync(dir); } catch (e) { return { ok: false, reason: `the ${entity} folder could not be listed (${e?.code ?? e?.message})` }; }
  const docs = []; const unread = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) { unread.push({ id: n.slice(0, 80), reason: 'not a document file' }); continue; }
    const id = n.slice(0, -'.json'.length);
    if (!ID.test(id) || id.startsWith('.')) { unread.push({ id: id.slice(0, 80), reason: `not a ${entity} id` }); continue; }
    const r = readRecordFile(docPathOf(recordRoot, entity, id), recordUid, entity, id, 'it is gone');
    if (r.ok) docs.push({ id, doc: r.doc, rev: r.rev }); else unread.push({ id, reason: r.reason });
  }
  return { ok: true, docs, unread };
}

const CHUNK = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Who created one document, from the diary: read only, a chunk at a time, each complete line replayed by store.mjs's
 * absorbDiaryLine. Created before a line that is cut short or refused: answered (a creator never changes once set).
 * Only createdBy and createdKind are sure then: ts, seq and stateSince are as of the last sound line, and a later move
 * may be in what was not read (L1042 c3), so no caller may decide on those from such an answer.
 * Not found by then: refused, saying where the diary stopped. Not in a whole, sound diary: { ok: true, meta: null }.
 */
export function readMeta({ recordRoot, recordUid, entity, id }) {
  if (!READ_ENTITIES.includes(entity)) return { ok: false, reason: `${String(entity).slice(0, 40)} is not an entity this view reads` };
  if (typeof id !== 'string' || !ID.test(id) || id.startsWith('.')) return { ok: false, reason: `not a ${entity} id` };
  const bad = recordFolderProblem(recordRoot, recordUid);
  if (bad) return { ok: false, reason: bad };
  const p = join(recordRoot, 'diary.jsonl');
  let fd;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return { ok: false, reason: `the diary can't be read (${e?.code ?? e})` }; }
  const index = new Map();
  const key = `${entity}/${id}`;
  const answer = () => { const e = index.get(key); return { ok: true, meta: e ? { createdBy: e.createdBy, createdKind: e.createdKind, stateSince: e.stateSince, ts: e.ts, seq: e.seq } : null }; };
  const stopped = (why) => (index.has(key) ? answer() : { ok: false, reason: `the diary ${why}, so who created ${key} can't be told` });
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== recordUid || st.mode & 0o022) return { ok: false, reason: 'the diary is not the Record\'s own plain file' };
    let lastSeq = 0; let pos = 0; let rest = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (!n) break;
      pos += n;
      let data = Buffer.concat([rest, buf.subarray(0, n)]);
      let at;
      while ((at = data.indexOf(0x0a)) >= 0) {
        const raw = data.subarray(0, at).toString('utf8');
        data = data.subarray(at + 1);
        let line;
        try { line = JSON.parse(raw); } catch { return stopped(`has a line after seq ${lastSeq} that is not JSON`); }
        try { lastSeq = absorbDiaryLine(index, lastSeq, line); } catch (e) { return stopped(`stops at a line it refuses (${String(e?.message ?? e).slice(0, 120)})`); }
      }
      if (data.length > MAX_LINE_BYTES) return stopped(`has a line after seq ${lastSeq} longer than ${MAX_LINE_BYTES} bytes`);
      rest = Buffer.from(data);
    }
    // A last line with no newline is one being written, or one cut short: what it holds is not known yet.
    if (rest.length) return stopped(`ends in a line cut short after seq ${lastSeq}`);
    return answer();
  } finally { closeSync(fd); }
}

/**
 * The Record as check 12's gate reads it (M11 gate.mjs `rec`): read(entity, id) → { id, doc, rev } | null, and
 * list('card' | 'product') → [{ id, doc, rev }], and meta(entity, id) → the diary's { createdBy, ... } | null. A document
 * whose file fails a check throws rather than read as missing, and so does a list with any document unread, and a
 * meta the diary can't answer: the gate refuses, never decides on part of the Record.
 */
export function recordView({ recordRoot, recordUid }) {
  return Object.freeze({
    read(entity, id) {
      const r = readDocFile({ recordRoot, recordUid, entity, id });
      if (r.ok) return { id, doc: r.doc, rev: r.rev };
      if (r.missing) return null;
      throw new Error(`the Record's ${entity} ${String(id).slice(0, 80)} can't be read: ${r.reason}`);
    },
    list(entity) {
      const r = listDocFiles({ recordRoot, recordUid, entity });
      if (!r.ok) throw new Error(`the Record's ${entity} documents can't be listed: ${r.reason}`);
      if (r.unread.length) throw new Error(`the Record's ${entity} documents can't all be read (${r.unread.slice(0, 3).map((u) => `${u.id}: ${u.reason}`).join('; ')})`);
      return r.docs;
    },
    meta(entity, id) {
      const r = readMeta({ recordRoot, recordUid, entity, id });
      if (!r.ok) throw new Error(`the Record's ${entity} ${String(id).slice(0, 80)}: ${r.reason}`);
      return r.meta;
    },
  });
}
