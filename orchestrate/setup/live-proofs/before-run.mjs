// before-run.mjs — the before-run refusals the live proofs share (L1164, I7: one definition per text).
//
// Every live proof here runs as the worker runner's own Mac user, on the config's pinned claude, with the runner's lock
// held, and writes a record of its run. settings-names.mjs and runlocked.mjs refuse the same things in the same words;
// each text is defined once, here. Each proof keeps its own order of checks and its own other refusals, so which refusal
// a run gets, and what it decides, is unchanged.

/** The run is not the worker runner's own user: the folder's owner is not this uid, or null. */
export const notOwnUser = ({ c, uid, ownDirUid }) => (ownDirUid !== uid
  ? `it runs as uid ${uid}, but the worker runner's own folder ${c?.ownDir} is uid ${ownDirUid}'s. Run it as that user`
  : null);

/** The config names no pin, or claude is not the pinned version, or null. */
export const pinProblem = ({ c, claudeVersion }) => {
  if (typeof c?.pin !== 'string') return 'the config names no claude pin (pin)';
  if (claudeVersion !== c.pin) return `claude is ${claudeVersion ?? 'not readable'}, but the config's pin is ${c.pin}. Run it with the pinned claude`;
  return null;
};

/** The worker runner's config could not be read. */
export const configUnreadable = (e) => `the worker runner's config can't be read (${e?.message ?? e})`;

/** The runner's lock could not be taken: the runner holds it (busy), or another reason. */
export const lockRefused = (e) => (/busy/.test(e?.message ?? '')
  ? 'the worker runner is running. Stop it first, then run this again'
  : `the worker runner's lock can't be taken (${e?.message ?? e})`);

/** The run's record could not be written; the caller says what follows. */
export const recordUnwritten = (e) => `The record of this run could not be written (${e?.code ?? e?.message})`;
