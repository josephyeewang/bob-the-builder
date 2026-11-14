// handoff-copy.mjs — the Ledger's half of the read-only handoff copy (R-1-31; design v4 §7.2 R6).
//
// For an orchestrated product the record's Lead handoff IS the handoff. The Ledger writes the newest one, word for word,
// to `<its folder>/<product>.md`; the read-only copier (handoff-copier.mjs, R-1-32, a plain script run as the owner's
// user) puts that file in Dropbox's `handoffs/` and takes write permission away, so the phone can read it and nothing
// on the Mini writes to it. The Ledger never writes into Dropbox itself.
//
// Fail closed (I1): a handoff list that can't be read, or a newest handoff with no text, writes nothing and says why, so
// the copy stays the last good one rather than becoming a wrong or empty one. A product name not on the record's own
// pattern, or a folder that is a link or not a folder, is refused before anything is written.
//
// NOT WIRED YET: no Ledger pass calls writeHandoffCopy; it is called each pass (every 15 minutes) once one does.

import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT } from '../../shared/product-paths.mjs';

export const COPY_MODE = 0o644;

/** The newest Lead handoff in the product's record → { ok: true, id, text } | { ok: true, none: true } | { ok: false, reason }. */
export function newestLeadHandoff(rec) {
  let all;
  try { all = rec.list('handoff'); } catch (e) { return { ok: false, reason: `the record's handoffs can't be read: ${e?.message ?? e}` }; }
  const bad = all.find((h) => h?.corrupt);
  if (bad) return { ok: false, reason: `a handoff in the record can't be read (${bad.id ?? 'the list'}: ${bad.reason ?? 'corrupt'})` };
  // list() gives the order the Record took them in (create-only, indexed from the diary): the last Lead one is the newest.
  const lead = all.filter((h) => h?.doc?.role === 'lead');
  if (!lead.length) return { ok: true, none: true };
  const h = lead.at(-1);
  if (typeof h.doc.text !== 'string' || !h.doc.text.trim()) return { ok: false, reason: `the newest Lead handoff ${h.id} has no text` };
  return { ok: true, id: h.id, text: h.doc.text };
}

export const nodeCopyFs = () => ({
  lstat: (p) => lstatSync(p),
  // Written to a new temp file, flushed, then renamed over the copy: a reader sees the old copy or the new, never half.
  replace: (dir, name, text, mode) => {
    const tmp = join(dir, `.${name}.tmp-${process.pid}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, join(dir, name));
    } catch (e) { rmSync(tmp, { force: true }); throw e; }
  },
});

/** → { ok: true, wrote: '<file>', id } | { ok: true, none: true } | { ok: false, reason } */
export function writeHandoffCopy({ rec, product, dir, fs = nodeCopyFs() }) {
  if (typeof product !== 'string' || !PRODUCT.test(product)) return { ok: false, reason: `not a product name: ${JSON.stringify(product)}` };
  let st;
  try { st = fs.lstat(dir); } catch (e) { return { ok: false, reason: `the Ledger's handoff folder can't be read: ${e?.code ?? e}` }; }
  if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, reason: 'the Ledger\'s handoff folder is a link or not a folder' };
  const h = newestLeadHandoff(rec);
  if (!h.ok || h.none) return h;
  const name = `${product}.md`;
  try { fs.replace(dir, name, h.text, COPY_MODE); } catch (e) { return { ok: false, reason: `the copy could not be written: ${e?.code ?? e?.message ?? e}` }; }
  return { ok: true, wrote: join(dir, name), id: h.id };
}
