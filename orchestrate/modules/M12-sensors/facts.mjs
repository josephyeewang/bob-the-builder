// facts.mjs — the one way the Sensors (and the Ledger) write a fact into the record.
//
// Every fact passes its kind's allow-list first (fact-shapes.mjs, lead call L25: fields outside the shape are masked),
// then every string and key at any depth is masked by token shape and known value (R-0b-125), so no caller can
// forget. Masking by field name is not repeated there: the allow-list already did it (round 7 M-2). Outside text fields are
// fenced by the caller with prepare() (escape.mjs), because only the caller knows which fields came from outside.
// Facts are entity 'fact' under actor 'sensors' or 'ledger' (orchestrate/shared/record.mjs). A write is "only if
// unchanged since read": read the rev, write with it, and retry once if another pass wrote in between.

import { makeMasker } from './mask.mjs';
import { shapeFact } from './fact-shapes.mjs';

/** Who reports the Record refusing alert writes. Each has its own alert (M13 alerts.mjs reportTrouble), so a caller using
 * another's name would close what that one opened. Kept here because the watcher doesn't import M13. */
export const TROUBLE_SOURCES = Object.freeze({ CHANNEL: 'alert-channel', HEARTBEAT: 'heartbeat', WATCHER: 'prod-watcher' });

/** Whether the Record holds what put was given: it took the write, or it already holds exactly that (M9's "nothing changed"). */
export const wasSaved = (answer) => answer?.ok === true || answer?.reason === 'nothing changed';

/**
 * A fact's document from a Record read, or null when the Record holds none. Throws when the read failed: M9's read never
 * throws, it answers `{ corrupt: true }` with no document, which `?.doc ?? null` takes as none (L781, audit #283 r4 M-1).
 * For a caller that must never take a failed read as no fact.
 */
export function knownDoc(row, what = 'the fact') {
  if (row == null) return null;
  if (row.corrupt === true || row.doc == null || typeof row.doc !== 'object') {
    throw new Error(`${what} could not be read (${String(row.reason ?? 'no document').slice(0, 120)})`);
  }
  return row.doc;
}

export function makeFactWriter(rec, { actor = 'sensors', masker = makeMasker(), now = () => new Date() } = {}) {
  function put(id, doc, kind = 'fact') {
    const masked = masker.maskValues(shapeFact({ ...doc, ts: doc.ts ?? now().toISOString() }, (k) => masker.maskSecrets(k).text));
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = rec.read('fact', id);
      const r = rec.write({ actor, entity: 'fact', id, expectRev: cur?.rev ?? 0, doc: masked, kind });
      if (r.ok || !/changed since read/.test(r.reason ?? '')) return r;
    }
    return { ok: false, reason: 'changed since read twice' };
  }
  function get(id) { return rec.read('fact', id)?.doc ?? null; }
  // As get, but a failed read throws instead of reading as none (L781).
  function getKnown(id) { return knownDoc(rec.read('fact', id), `the fact ${id}`); }
  return Object.freeze({ put, get, getKnown });
}
