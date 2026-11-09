// review-again.mjs — the owner's [Review again] tap (R-0b-164; LEAD-CALLS L69, L70 points 2 and 3, L71 points 5 and C1).
//
// WHAT. When a reviewer or auditor ends without handing in a verdict, the review runner holds that head and puts an alert
// in its status with `{ action: 'review-again', session_id }` (M4 review-runner.mjs). The phone card shows that alert with
// a [Review again] button. The tap reaches this plain handler, which runs as the owner's own Mac user, never as the AI:
// it writes `<session>.json` holding `{ "session_id": "<session>", "tapped_at", "nonce" }` into the owner's taps folder (runner setting
// `ownerTaps`). The runner reads it with readJoeTaps, ties the session to its card, role and head itself, and sets it
// aside only if it is still a silent end; then the next request starts one new session.
//
// WHY A PLAIN HANDLER. The Front Door also runs as the owner, so a tap file written by its own tools would look the same
// to the runner. Its settings deny Edit and Write on the taps folder (lane 2's render-settings, on lane 3's request), so
// only this handler, started by the tap and not by the AI, can write there.
//
// WHAT IT CHECKS. The runner checks everything again, so nothing here can start a review the runner would refuse.
// These checks only give the owner a plain answer at once:
//   - the session is one the runner's current status offers "review again" for (a status that is old, or not the
//     runner's, refuses the tap: readReviewStatus);
//   - the taps folder passes the runner's own folder check (readJoeTaps, the one home for it), so a tap is never
//     written where the runner would not read it.
// Each tap is a fresh file (written under a name the runner skips, then renamed over `<session>.json`), so a second tap
// for the same session is a new tap with a new key, and the runner reads it once. A tap the runner has read (its key
// is in the status's `taps_read`) is removed by `clearReadTaps`; nothing else removes one.
//
// Run, as the owner:  node review-again.mjs tap <config.json> <session>   |   node review-again.mjs clear <config.json>
// config: { "ownerTaps": "/abs", "ownerUid": <uid>, "reviewStatus": "/abs/status.json", "reviewUid": <uid> }
// What starts it from the phone is the wiring's (R-0b-162): this file is only the handler.

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJoeTaps } from '../M4-workshop/launcher/review-runner-main.mjs';
import { readReviewStatus } from '../M4-workshop/launcher/review-runner.mjs';
import { SESSION_ID } from '../../shared/record.mjs';

export const REVIEW_AGAIN = 'review-again';
export const REVIEW_AGAIN_BUTTON = 'Review again';
// The one session id rule (shared record-names.mjs); the runner's tap name is `<that>.json`.
const okId = (s) => typeof s === 'string' && SESSION_ID.test(s);
const clip = (s, n = 600) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

/** The runner's status → the sessions it offers "review again" for, newest last, one per session. */
export function reviewAgainOffers(status) {
  const out = new Map();
  for (const a of Array.isArray(status?.alerts) ? status.alerts : []) {
    if (a?.action !== REVIEW_AGAIN || !okId(a.session_id)) continue;
    out.delete(a.session_id);
    out.set(a.session_id, { session_id: a.session_id, text: clip(a.text), at: typeof a.at === 'string' ? a.at : null });
  }
  return [...out.values()];
}

/** One offer → the phone card: the runner's own words, and the one button. */
export function reviewAgainCard(offer) {
  return { session_id: offer.session_id, text: offer.text, buttons: [REVIEW_AGAIN_BUTTON], tap: { action: REVIEW_AGAIN, session_id: offer.session_id } };
}

/**
 * The plain handler's write. → { ok: true, file } | { ok: false, reason }. Never throws.
 * `offers`: reviewAgainOffers of a status read just now. `rand` is a port for a test.
 */
export function writeTap({ dir, ownerUid, sessionId, offers, now = () => Date.now(), rand = () => randomBytes(6).toString('hex') }) {
  const no = (reason) => ({ ok: false, reason: `Review again for ${clip(sessionId, 80)}: ${reason}. Nothing was asked.` });
  if (!okId(sessionId)) return no('that is not a session id');
  if (!Array.isArray(offers) || !offers.some((o) => o.session_id === sessionId)) return no('the review runner does not offer it for that session now');
  if (typeof dir !== 'string' || !isAbsolute(dir)) return no('the taps folder is not set');
  // The runner's own folder check; a folder it would refuse gets no tap.
  try { readJoeTaps({ dir, ownerUid }); } catch (e) { return no(clip(e?.message ?? e, 200)); }
  if (ownerUid !== process.getuid()) return no('this handler is not running as the owner');
  const nonce = rand();
  const tmp = join(dir, `.tap-${sessionId}-${nonce}`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    // The time and nonce make each tap's bytes new, so the runner's key (name, time, sha256) is new for every tap.
    writeSync(fd, `${JSON.stringify({ session_id: sessionId, tapped_at: new Date(now()).toISOString(), nonce })}\n`);
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o022)) throw new Error('the tap file came out writable by others');
  } catch (e) {
    try { if (fd !== undefined) closeSync(fd); } catch { /* closed */ }
    fd = undefined;
    try { unlinkSync(tmp); } catch { /* not made */ }
    return no(`the tap could not be written (${clip(e?.code ?? e?.message ?? e, 120)})`);
  } finally { if (fd !== undefined) closeSync(fd); }
  const file = join(dir, `${sessionId}.json`);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } return no(`the tap could not be put in place (${clip(e?.code ?? e, 60)})`); }
  return { ok: true, file };
}

/**
 * Removes the taps the runner has read (their key, name:mtime:sha256, is in the status's `taps_read`). A tap written
 * again since has a new key and stays. → { removed: [session_id], error? }. Never throws.
 */
export function clearReadTaps({ dir, ownerUid, tapsRead, unlink = unlinkSync }) {
  if (!Array.isArray(tapsRead)) return { removed: [], error: 'the status gives no list of taps read' };
  const read = new Set(tapsRead.filter((k) => typeof k === 'string'));
  let taps;
  try { taps = readJoeTaps({ dir, ownerUid }); } catch (e) { return { removed: [], error: clip(e?.message ?? e, 200) }; }
  const removed = [];
  for (const t of taps) {
    if (!read.has(t.key)) continue;
    try { unlink(join(dir, `${t.session_id}.json`)); removed.push(t.session_id); } catch { /* left for the next clear */ }
  }
  return { removed };
}

function readConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['ownerTaps', 'reviewStatus']) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  for (const k of ['ownerUid', 'reviewUid']) if (!Number.isInteger(c?.[k]) || c[k] < 0) throw new Error(`config: ${k} must be a uid`);
  return c;
}

/** → exit code: 0 done, 1 refused or could not run. Says why on `say`. */
export async function main(argv, { say = (s) => process.stdout.write(`${s}\n`), now = () => Date.now() } = {}) {
  const [verb, cfgFile, sessionId] = argv;
  let c;
  try { c = readConfig(cfgFile); } catch (e) { say(`review again: not run: ${clip(e?.message ?? e, 200)}`); return 1; }
  let status;
  try { status = readReviewStatus({ file: c.reviewStatus, now: now(), uid: c.reviewUid }); } catch (e) { say(`review again: the review runner's status can't be used: ${clip(e?.message ?? e, 200)}. Nothing was asked.`); return 1; }
  if (verb === 'tap') {
    const r = writeTap({ dir: c.ownerTaps, ownerUid: c.ownerUid, sessionId, offers: reviewAgainOffers(status) });
    say(r.ok ? `Review again asked for ${sessionId}. The review runner checks it on its next pass.` : r.reason);
    return r.ok ? 0 : 1;
  }
  if (verb === 'clear') {
    // readReviewStatus does not give `taps_read` yet (lane 2, asked 9 Nov); until it does, clear says so and removes nothing.
    const r = clearReadTaps({ dir: c.ownerTaps, ownerUid: c.ownerUid, tapsRead: status.taps_read });
    say(r.error ? `review again: taps not cleared: ${r.error}` : `review again: ${r.removed.length} tap(s) the runner has read removed`);
    return r.error ? 1 : 0;
  }
  say('review again: use "tap <config> <session>" or "clear <config>"');
  return 1;
}

// Run as a script, also through a link (#261 r2 Minor 1): argv[1] is resolved before it is compared.
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
