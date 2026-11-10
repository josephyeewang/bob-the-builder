// The names of the proposals intake's facts. On its own, with nothing to import, so the push script (M4) can read the
// fact a bundle is held in while the intake imports the push script's limits. Fact ids (L233 M-4): a product name may
// hold a hyphen, so `a` + `b-x.md` and `a-b` + `x.md` must not share one. Each id is its role plus a hash of its parts,
// each part length-prefixed, so no two different pairs, and no file and folder, can meet.
import { createHash } from 'node:crypto';

export const idHash = (...parts) => createHash('sha256').update(parts.map((p) => `${String(p).length}:${p}`).join('|')).digest('hex').slice(0, 32);
/** The fact a file's intake is kept in. */
export const intakeFactId = (product, name) => `intake-applied-proposals-file-${idHash(product, name)}`;

/**
 * The states of an outbox file's intake fact (intake-applied-<session>-<name>) that mean the intake is done with the
 * file for now (L852): applied, refused, interrupted (it may have run; the next pass told it), and waiting (a held
 * plan file with no launch record, or a read-only request queued on a refusal: it waits on something outside the
 * session). The one list: the Lead's restart (lead-restart.mjs leadInFlight) and the runner's drain (wiring) both read it.
 */
// Read only to its importers: its own add, delete and clear throw, so no importer changes the list by mistake (a
// deliberate Set.prototype.add.call still could: a frozen Set's contents are not frozen).
const readOnly = (set) => { for (const m of ['add', 'delete', 'clear']) Object.defineProperty(set, m, { value: () => { throw new Error('USED_STATES is read only'); } }); return Object.freeze(set); };
export const USED_STATES = readOnly(new Set(['applied', 'refused', 'interrupted', 'waiting']));
