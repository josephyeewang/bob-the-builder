// record-read.mjs — the one way to read a Record document that tells "absent" from "failed" (L781, L791).
//
// M9's read never throws: a store error comes back as { id, entity, corrupt: true, reason } with no doc, so the common
// `rec.read(e, id)?.doc ?? null` reads a failed read as "no document", and a try/catch around it never fires. Use readDoc
// where the two must differ (a mark, a keep rule, an "already done" check), or docOrThrow to fail closed by throwing.

/** Thrown by docOrThrow: the read failed, so "absent" is not known. `reason` is the Record's own. */
export class RecordReadError extends Error {
  constructor(what, reason) {
    super(`${what} could not be read (${String(reason ?? 'no document').slice(0, 120)})`);
    this.name = 'RecordReadError';
    this.reason = reason ?? null;
  }
}

/**
 * One read, three answers: { state: 'found', doc, rev } | { state: 'absent' } | { state: 'failed', reason }.
 * Failed: a corrupt answer, a row with no object doc, a Record that throws (one not wrapped by makeRecord),
 * or no Record at all. Never throws.
 */
export function readDoc(rec, entity, id) {
  // One try round the whole read (audit #346 m1): a thrown value with no text form, or a row whose fields throw when read,
  // is a failed read too, never an exception.
  try {
    let row;
    try { row = rec.read(entity, id); } catch (e) { return { state: 'failed', reason: `record error: ${errText(e)}` }; }
    if (row == null) return { state: 'absent' };
    if (row.corrupt) return { state: 'failed', reason: row.reason ?? 'corrupt' };
    if (row.doc == null || typeof row.doc !== 'object') return { state: 'failed', reason: 'no document' };
    return { state: 'found', doc: row.doc, rev: row.rev ?? null };
  } catch (e) { return { state: 'failed', reason: `the read's answer could not be checked: ${errText(e)}` }; }
}

function errText(e) { try { return String(e?.message ?? e).slice(0, 300); } catch { return 'unreadable error'; } }

/** The document, or null when the Record holds none; throws RecordReadError when the read failed. */
export function docOrThrow(rec, entity, id, what = `${entity} ${id}`) {
  const r = readDoc(rec, entity, id);
  if (r.state === 'failed') throw new RecordReadError(what, r.reason);
  return r.state === 'found' ? r.doc : null;
}
