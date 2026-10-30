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
  return Object.freeze({ put, get });
}
