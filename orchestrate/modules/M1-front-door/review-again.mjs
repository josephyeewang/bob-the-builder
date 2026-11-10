// review-again.mjs — the owner's [Review again] tap (R-0b-164; LEAD-CALLS L69, L70 points 2 and 3, L71 points 5 and C1;
// fixes for audit-pr284 r1 under L725).
//
// WHAT. When a reviewer or auditor ends without handing in a verdict, the review runner holds that head and puts an alert
// in its status with `{ action: 'review-again', session_id }` (M4 review-runner.mjs). The phone card shows that alert with
// a [Review again] button. The tap reaches this plain handler, which runs as the owner's own Mac user, never as the AI:
// it writes `<session>.json` into the runner's taps folder, in the shape the runner's readJoeTaps reads (its doc comment
// in review-runner-main.mjs is the one home for it). The runner ties the session to its card, role and head itself, and
// sets it aside only if it is still a silent end; then the next request starts one new session.
//
// ONE TAPS FOLDER. The handler's config names only the runner's own config file (`runnerConfig`), read with the runner's
// own reader (readConfig). The taps folder, the owner's uid, the status file and the review user all come from there, so
// the handler writes exactly where the runner reads (#284 r1 M2). A runner with no taps folder set (`ownerTaps` is
// optional for the runner) refuses the tap and says so; a handler config that names its own taps folder is refused.
//
// WHY A PLAIN HANDLER, AND WHERE IT RUNS (#284 r1 m4). The Front Door also runs as the owner, so a tap file written by its
// tools would look the same to the runner, and this handler can't tell who started it. What keeps the AI out is lane 2's
// render-settings for the Front Door: the filesystem write-deny on the taps folder (an Edit/Write deny alone would not
// stop `node review-again.mjs tap ...` from its Bash). So the phone's route (R-0b-162) must start this handler outside the
// Front Door's sandbox, or a real tap fails as refused.
//
// WHAT IT CHECKS. The runner checks everything again, so nothing here can start a review the runner would refuse.
// These checks only give the owner a plain answer at once:
//   - the session is one the runner offers "review again" for: a review-again alert in its status (a status that is old,
//     or not the runner's, refuses the tap: readReviewStatus), not running, and not already set aside (the runner's
//     set-aside records). The status keeps only the runner's last 50 alerts, so an offer that has dropped off is refused
//     here although the runner might take it; the card says the list is the runner's recent alerts (#284 r1 m1);
//   - the taps folder is the runner's own (above) and passes the runner's own folder check (readJoeTaps).
// What the runner does with a tap it refuses is told by the runner (lane 2, L725 M1), not here.
// Each tap is a fresh file (written under a name the runner skips, then renamed over `<session>.json`), so a second tap
// for the same session is a new tap with a new key, and the runner reads it once. A tap the runner has read (its key
// is in the status's `taps_read`) is removed by `clearReadTaps`, which never removes a tap written since (#284 r1 m2).
//
// Run, as the owner:  node review-again.mjs tap <config.json> <session>   |   node review-again.mjs clear <config.json>
// config: { "runnerConfig": "/abs/the review runner's config.json" }
// What starts it from the phone is the wiring's (R-0b-162): this file is only the handler.

import { closeSync, constants, fstatSync, linkSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig as readRunnerConfig, readJoeTaps } from '../M4-workshop/launcher/review-runner-main.mjs';
import { FOLDERS, readReviewStatus } from '../M4-workshop/launcher/review-runner.mjs';
import { reviewUid } from '../M9-record/outbox.mjs';
import { SESSION_ID } from '../../shared/record.mjs';

export const REVIEW_AGAIN = 'review-again';
export const REVIEW_AGAIN_BUTTON = 'Review again';
// The one session id rule (shared record-names.mjs); the runner's tap name is `<that>.json`.
const okId = (s) => typeof s === 'string' && SESSION_ID.test(s);
const clip = (s, n = 600) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

// What the card says of where its button comes from (#284 r1 m1): the runner's status keeps its recent alerts, not a
// list of what it holds now, so the card says the runner checks again.
export const OFFER_NOTE = 'This button comes from the review runner\'s recent alerts. The runner checks the session again when you tap, and starts nothing if the review has moved on.';

/**
 * The runner's status → the sessions it offers "review again" for, newest last, one per session. A session the status
 * lists as running, or one the runner has already set aside (`asideIds`: its set-aside records), is not offered.
 */
export function reviewAgainOffers(status, { asideIds = new Set() } = {}) {
  const out = new Map();
  const running = new Set((Array.isArray(status?.running) ? status.running : []).map((r) => r?.session_id));
  for (const a of Array.isArray(status?.alerts) ? status.alerts : []) {
    if (a?.action !== REVIEW_AGAIN || !okId(a.session_id)) continue;
    if (running.has(a.session_id) || asideIds.has(a.session_id)) { out.delete(a.session_id); continue; }
    out.delete(a.session_id);
    out.set(a.session_id, { session_id: a.session_id, text: clip(a.text), at: typeof a.at === 'string' ? a.at : null });
  }
  return [...out.values()];
}

/** One offer → the phone card: the runner's own words, and the one button. */
export function reviewAgainCard(offer) {
  return { session_id: offer.session_id, text: offer.text, note: OFFER_NOTE, buttons: [REVIEW_AGAIN_BUTTON], tap: { action: REVIEW_AGAIN, session_id: offer.session_id } };
}

/**
 * The plain handler's write. → { ok: true, file } | { ok: false, reason }. Never throws.
 * `offers`: reviewAgainOffers of a status read just now. `rand` is a port for a test.
 */
export function writeTap({ dir, ownerUid, sessionId, offers, now = () => Date.now(), rand = () => randomBytes(6).toString('hex') }) {
  const no = (reason) => ({ ok: false, reason: `Review again for ${clip(sessionId, 80)}: ${reason}. Nothing was asked.` });
  if (!okId(sessionId)) return no('that is not a session id');
  if (!Array.isArray(offers) || !offers.some((o) => o.session_id === sessionId)) return no('the review runner\'s recent alerts do not offer it for that session (it may be running, already set aside, or more than 50 alerts old; a new push gets a new review)');
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
 * again since has a new key and stays, even one that lands while this runs (#284 r1 m2): each read tap is first moved
 * into a private folder inside the taps folder, its key is read again there by readJoeTaps (the same name, time and
 * bytes, so the same key), and only a tap whose key is still a read one is removed; any other is put back, unless a
 * newer tap for that session is already in place. → { removed: [session_id], error? }. Never throws.
 */
export function clearReadTaps({ dir, ownerUid, tapsRead, unlink = unlinkSync, beforeMove = () => {} }) {
  if (!Array.isArray(tapsRead)) return { removed: [], error: 'the status gives no list of taps read' };
  const read = new Set(tapsRead.filter((k) => typeof k === 'string'));
  let taps;
  try { taps = readJoeTaps({ dir, ownerUid }); } catch (e) { return { removed: [], error: clip(e?.message ?? e, 200) }; }
  const removed = [];
  for (const t of taps) {
    if (!read.has(t.key)) continue;
    const name = `${t.session_id}.json`;
    let box;
    try { box = mkdtempSync(join(dir, '.clearing-')); } catch (e) { return { removed, error: `a tap could not be set apart to clear (${clip(e?.code ?? e, 60)})` }; }
    try {
      beforeMove(t);   // a port for a test: a re-tap landing between the list and the move
      try { renameSync(join(dir, name), join(box, name)); } catch { continue; }   // gone already: nothing to clear
      let again = [];
      try { again = readJoeTaps({ dir: box, ownerUid }); } catch { /* unreadable: put back below */ }
      if (again.length === 1 && read.has(again[0].key)) {
        try { unlink(join(box, name)); removed.push(t.session_id); continue; } catch { /* put back below */ }
      }
      // Not the tap that was read (or it could not be removed): back where it was, never over a newer tap.
      try { linkSync(join(box, name), join(dir, name)); } catch { /* a newer tap for this session is in place */ }
      try { unlinkSync(join(box, name)); } catch { /* moved */ }
    } finally { try { rmdirSync(box); } catch { /* left for the next clear */ } }
  }
  return { removed };
}

/**
 * The handler's config → what the runner's own config says (#284 r1 M2). `readRunner` is the runner's reader (a port for
 * a test, whose folders can't be root's). → { taps, ownerUid, statusFile, asideDir, reviewUid } or a throw saying why.
 */
export function handlerSetup(file, { readRunner = readRunnerConfig } = {}) {
  const h = JSON.parse(readFileSync(file, 'utf8'));
  const keys = Object.keys(h ?? {});
  if (keys.some((k) => k !== 'runnerConfig')) throw new Error(`config: only "runnerConfig" belongs here; the taps folder and the rest come from the review runner's own config (${clip(keys.filter((k) => k !== 'runnerConfig').join(', '), 80)})`);
  if (typeof h.runnerConfig !== 'string' || !isAbsolute(h.runnerConfig)) throw new Error('config: runnerConfig must be the absolute path of the review runner\'s config');
  let c;
  try { c = readRunner(h.runnerConfig); } catch (e) { throw new Error(`the review runner's config can't be used: ${clip(e?.message ?? e, 200)}`); }
  if (c.ownerTaps === undefined) throw new Error('the review runner has no taps folder set (ownerTaps in its config), so it would never read a tap');
  const u = reviewUid(c.uids);
  if (!u.ok) throw new Error(`the review runner's config: ${u.reason}`);
  return { taps: c.ownerTaps, ownerUid: c.ownerUid, statusFile: join(c.root, FOLDERS.status), asideDir: join(c.root, FOLDERS.aside), reviewUid: u.uid };
}

// The sessions the runner has set aside (its set-aside records, one `<session>.json` each). No folder yet → none.
function asideIdsOf(dir) {
  try { return new Set(readdirSync(dir).filter((n) => !n.startsWith('.') && n.endsWith('.json')).map((n) => n.slice(0, -5))); } catch (e) {
    if (e?.code === 'ENOENT') return new Set();
    throw new Error(`the review runner's set-aside records can't be listed (${e?.code ?? e})`);
  }
}

/** → exit code: 0 done, 1 refused or could not run. Says why on `say`. */
export async function main(argv, { say = (s) => process.stdout.write(`${s}\n`), now = () => Date.now(), readRunner } = {}) {
  const [verb, cfgFile, sessionId] = argv;
  let c;
  try { c = handlerSetup(cfgFile, { readRunner }); } catch (e) { say(`review again: not run: ${clip(e?.message ?? e, 300)}. Nothing was asked.`); return 1; }
  let status;
  try { status = readReviewStatus({ file: c.statusFile, now: now(), uid: c.reviewUid }); } catch (e) { say(`review again: the review runner's status can't be used: ${clip(e?.message ?? e, 200)}. Nothing was asked.`); return 1; }
  if (verb === 'tap') {
    let asideIds;
    try { asideIds = asideIdsOf(c.asideDir); } catch (e) { say(`review again: ${clip(e?.message ?? e, 200)}. Nothing was asked.`); return 1; }
    const r = writeTap({ dir: c.taps, ownerUid: c.ownerUid, sessionId, offers: reviewAgainOffers(status, { asideIds }) });
    say(r.ok ? `Review again asked for ${sessionId}. The review runner checks it on its next pass.` : r.reason);
    return r.ok ? 0 : 1;
  }
  if (verb === 'clear') {
    // readReviewStatus does not give `taps_read` yet (lane 2, asked 9 Nov); until it does, clear says so and removes nothing.
    const r = clearReadTaps({ dir: c.taps, ownerUid: c.ownerUid, tapsRead: status.taps_read });
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
