// Change numbers for the hook tracker (R-0b-155b): every hook line the tracker takes for a session's current launch, and
// every launch, gets the next number of that session's rising change number, and the change is kept with the launch id it
// came under, the hook event's name and (for user-prompt-submit) the line's promptHash, never the prompt text. R-0b-154's
// "took" check notes the number before it types, then asks tookSince() whether the typed prompt's own user-prompt-submit
// has come since. Pure: the tracker (activity.mjs) calls these, and the hook store saves the record they return.
//
// Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../../M12-sensors/third_party/herdr/NOTICE.
// Source: src/api/wait.rs:364-514 (wait_for_resolved_agent: a wait reads only the events after its last sequence number,
// and ends "not running" when the pane closes or its agent's identity changes), ported from Rust to JavaScript, with
// changes:
//   - herdr numbers every event of its hub in memory; ours numbers each session's own changes and saves the number with
//     the session's record, so a runner restart carries on from it and it never goes backwards;
//   - herdr re-reads the agent's identity (terminal, name, agent); ours compares the launch id: a change after the wait's
//     start under another launch, a session-end, or a record now under another launch or terminated ends the wait as
//     aborted;
//   - herdr waits for a status; ours waits for the user-prompt-submit whose promptHash is the typed prompt's;
//   - only the last KEEP_CHANGES changes are kept: a wait whose start has fallen off the list, or a number that went
//     backwards, reads unknown, never took.

export const KEEP_CHANGES = 64;
/** The change a launch (beginLaunch, or a session added again) is numbered as: no hook line carries this event. */
export const LAUNCH_EVENT = 'launch';
const HASH = /^[0-9a-f]{64}$/;

const seqOf = (rec) => {
  if (rec?.seq === undefined) return 0; // a record saved before R-0b-155b
  if (!Number.isSafeInteger(rec.seq) || rec.seq < 0) throw new Error(`session ${rec.id ?? '?'}: its change number ${JSON.stringify(rec.seq)} is not a whole number, so no change is numbered`);
  return rec.seq;
};

/** The record with one more change: { seq, launchId, event, at, promptHash (user-prompt-submit only) }. */
export function withChange(rec, { event, launchId, at, promptHash }) {
  const seq = seqOf(rec) + 1;
  const change = { seq, launchId: launchId ?? null, event, at,
    ...(event === 'user-prompt-submit' && typeof promptHash === 'string' && HASH.test(promptHash) ? { promptHash } : {}) };
  return { ...rec, seq, changes: [...(Array.isArray(rec?.changes) ? rec.changes : []), change].slice(-KEEP_CHANGES) };
}

/** The number a "took" wait starts from. */
export const changeNumber = (rec) => seqOf(rec);

/**
 * Has the prompt typed under `launchId` (its sha256 `promptHash`) taken, since change `fromSeq`?
 * → 'took' | 'pending' | 'aborted' (relaunched, ended or gone: it never will) | 'unknown' (the changes can't say).
 */
export function tookSince(rec, { fromSeq, launchId, promptHash }) {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new TypeError('tookSince: fromSeq must be a whole number');
  if (typeof launchId !== 'string' || !launchId) throw new TypeError('tookSince: launchId must be named');
  if (typeof promptHash !== 'string' || !HASH.test(promptHash)) throw new TypeError('tookSince: promptHash must be a sha256');
  if (!rec || rec.terminated || rec.launchId !== launchId) return 'aborted';
  let seq;
  try { seq = seqOf(rec); } catch { return 'unknown'; }
  const after = (Array.isArray(rec.changes) ? rec.changes : []).filter((c) => c?.seq > fromSeq).sort((a, b) => a.seq - b.seq);
  // Every change since the start must still be on the list, one per number, or the answer could miss one (a number
  // that went back below the start fails this too).
  if (after.length !== seq - fromSeq || after.some((c, i) => c.seq !== fromSeq + 1 + i)) return 'unknown';
  for (const c of after) {
    if (c.launchId !== launchId || c.event === LAUNCH_EVENT || c.event === 'session-end') return 'aborted';
    if (c.event === 'user-prompt-submit' && c.promptHash === promptHash) return 'took';
  }
  return 'pending';
}
