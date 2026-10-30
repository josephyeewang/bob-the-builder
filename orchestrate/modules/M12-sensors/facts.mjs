// facts.mjs — the one way the Sensors (and the Ledger) write a fact into the record.
//
// Every fact is masked at every depth before the write (R-0b-125), so no caller can forget. Outside text fields are
// fenced by the caller with prepare() (escape.mjs), because only the caller knows which fields came from outside.
// Facts are entity 'fact' under actor 'sensors' or 'ledger' (orchestrate/shared/record.mjs). A write is "only if
// unchanged since read": read the rev, write with it, and retry once if another pass wrote in between.

import { makeMasker } from './mask.mjs';

export function makeFactWriter(rec, { actor = 'sensors', masker = makeMasker(), now = () => new Date() } = {}) {
  function put(id, doc, kind = 'fact') {
    const masked = masker.maskDeep({ ...doc, ts: doc.ts ?? now().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = rec.read('fact', id);
      const r = rec.write({ actor, entity: 'fact', id, expectRev: cur?.rev ?? 0, doc: masked, kind });
      if (r.ok || !/changed since read/.test(r.reason ?? '')) return r;
    }
    return { ok: false, reason: 'changed since read twice' };
  }
  function get(id) { return rec.read('fact', id)?.doc ?? null; }
  return Object.freeze({ put, get });
}
