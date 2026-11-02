// The one place the Dispatcher reads a Sensors reading it acts on (L74 addendum): the usage, the signed-in account, a
// limit hit, the phone link's readings and a pull request's state. A reading counts only when its id is in Sensors'
// family AND Sensors made it (M9 `factFrom`), never by its id or `type` alone, so a look-alike written by another role
// under a Sensors id (which M9 refuses anyway) or a hand-edited entry is not taken as a reading. Not one: a missing
// reading, the same as no word yet.

import { factFrom } from '../M9-record/permissions.mjs';

/** The Record entry for Sensors' fact `id` ({ id, doc, rev }), or null when it is missing or not Sensors' own. */
export function sensorsFact(rec, id, family) {
  const f = rec.read('fact', id);
  if (!f?.doc || f.corrupt) return null;
  return factFrom('sensors', { id, createdBy: rec.meta?.('fact', id)?.createdBy ?? null }, family) ? f : null;
}
