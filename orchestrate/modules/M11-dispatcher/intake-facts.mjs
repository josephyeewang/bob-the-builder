// The names of the proposals intake's facts. On its own, with nothing to import, so the push script (M4) can read the
// fact a bundle is held in while the intake imports the push script's limits. Fact ids (L233 M-4): a product name may
// hold a hyphen, so `a` + `b-x.md` and `a-b` + `x.md` must not share one. Each id is its role plus a hash of its parts,
// each part length-prefixed, so no two different pairs, and no file and folder, can meet.
import { createHash } from 'node:crypto';

export const idHash = (...parts) => createHash('sha256').update(parts.map((p) => `${String(p).length}:${p}`).join('|')).digest('hex').slice(0, 32);
/** The fact a file's intake is kept in. */
export const intakeFactId = (product, name) => `intake-applied-proposals-file-${idHash(product, name)}`;
