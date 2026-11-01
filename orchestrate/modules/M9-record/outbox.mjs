// outbox.mjs — read one AI session's outbox file safely (0b-2 M-3, R2-M8, R2-M9, R2-M10, R3-m7).
//
// WHY. AI sessions never write the record. They drop files in their own outbox, `<outboxRoot>/<role>/<sessionId>/`,
// and the Dispatcher hands each file to the Store Writer. The file is written by an AI, so it is read as hostile:
//   - the role and session come from where the file really is (realpath), never from what it says;
//   - it is opened without following a link, and must be a plain file with one name, owned by the role's user, ≤ 256 KB,
//     so a link to a key file can't be copied into the record;
//   - its kind comes from its name, and must be listed for that role in shared OUTBOX_KINDS.
//
//   readOutboxFile({ outboxRoot, uids, tag, file }) →
//     { ok: true, key, kind, spec, header, body, sha256, realpath } | { ok: false, key, reason }
//   `key` is the file's identity for "seen before": its real path and sha256 (R3-m7). An unsafe file that can't be read
//   is keyed by its path and the reason, so the same refusal is reported once.
//   `uids` maps a role to the uid that must own its files (the owner's user in production).
//
// A VERDICT (lead call L44). Every other role writes as the same Mac user, so a worker could forge a reviewer's verdict.
// A verdict kind is read only when the review roles (REVIEW_ROLES) have a Mac user of their own: the role's uid is set
// and is no other role's uid, and the role and session folders are owned by it and writable by no one else. The
// result carries `owner_uid` (the review user) so the record can show where the verdict came from. Whether the session
// was launched as a reviewer on that head is the record's check (writer.mjs), made in the same transaction.
//
// THE RUNNER'S LAUNCH RECORDS (lead call L65). The review runner (M4 review-runner.mjs) runs as `review`, makes each
// review session's id itself, and writes `<launches folder>/<session id>.json` into a folder only `review` can write.
// A verdict counts only when such a record names the same session, role, card and head. The Record's own `launch`
// entries are written by the Dispatcher, which runs as the workers' Mac user, so for a review they never count. These
// checks live here and nowhere else: the record's intake and verdict rule (writer.mjs) and the Merge Gate (M6
// gather.mjs) call them.
//
//   reviewUid(uids) → { ok, uid } | { ok: false, reason }       the one Mac user both review roles run as
//   runnerLaunchFor({ root, uids, role, card, head, sessionId }) → { ok, launch, key } | { ok: false, reason }
//     `uid` in place of `uids`: the review user the intake already proved (a verdict's outbox_uid), for the verdict rule.
//   runnerLaunches({ root, uids }) → { ok, launches: [{ doc, key }], refused: [{ name, reason }] } | { ok: false, reason }
//
// THE VERDICT ITSELF (lead call L66, M1). The Record is written by the Dispatcher, as the workers' Mac user, so what a
// verdict row says (pass, checklist, head, who wrote it) is never what counts. `verdictFromFile` re-reads the file the
// row came from, with every check readOutboxFile makes, and needs it to be the very file the row names (its
// `source_key`: real path and sha256). What counts is what the file says, and the session and role come from the folder
// it sits in. A session folder holding more than one verdict file counts none (one verdict per session, D12), so a row
// can't pick the file the intake refused. The Merge Gate (M6 gather.mjs) and the record's verdict rule call it.
//
//   verdictFields(header) → { ok, card, head, pass, notes, checklist, material } | { ok: false, reason }
//   verdictFromFile({ outboxRoot, uids, row }) →
//     { ok, verdict: { role, session_id, card, head, pass, checklist, material, created_by, outbox_uid, source_key } } | { ok: false, reason }
//
// THE WORST VERDICT (lead call L68). Taking any passing verdict made every extra start on one head a fresh chance to
// pass. So what a head's review says is read from review's own stores only, never from the Record: every session the
// runner launched for that card and head (its launch records), and each one's verdict file in review's outbox. A role
// passes a head only when at least one of its sessions handed in a pass, none failed, and none is unsettled. A verdict
// file that can't be counted (a second file, a wrong card or head, a failed check) counts as a failure, so it can't be
// outrun by a new start either. An extra start can now only add a chance to fail. The Merge Gate (M6) and the record's
// verify rule both judge this way.
//
// SILENCE IS A FAILURE, AND THE END PINS THE FILE (lead call L69). A session that ran and ended with no verdict file (a
// crash, a context-limit stop or a kill counts too) is a failure: it holds the head, and Joe is told. Only Joe's
// "review again" sets it aside (`<runner folder>/set-aside/<session>.json`, written by the runner), and then it has no
// say. When a session ends the runner writes its ended record (`ended/<session>.json`: the launch record's fields,
// `ended_at`, and `verdict_sha256`, the verdict file's sha256 then, or `none`, or `refused`). The ended record is read
// first: a session not yet ended blocks, file or not; a file that differs from the one the end saw can't be counted. A
// failing verdict covers every head with the same tree (the launch record names it), so an amend with no code change
// can't buy a new roll. A launch record that fails its checks refuses only the card it belongs to.
//
//   ENDED_FOLDER, endedFolderOf(launchesRoot), ASIDE_FOLDER, asideFolderOf(launchesRoot)   beside the launch records
//   runnerEnded({ root, uids | uid, role, card, head, sessionId }) → { ok, ended } | { ok: false, none, reason }
//   runnerAside({ root, uids | uid, card, role?, head?, sessionId }) → { ok, aside } | { ok: false, none, reason }
//   headReviews({ launches, outboxRoot, uids, card, head, tree? }) →
//     { ok, sessions: [{ role, session_id, head, tree, aside, ended, silent, verdict | null, problem | null }], skipped }
//     | { ok: false, reason }
//   worstVerdict(sessions, role, passes, { needPass = true }) → null | reason   (passes(verdict) is the role's own pass)
//   PASSES { reviewer, auditor }, checklistClean(verdict)    each role's own pass, the one definition (L69 point 6)

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CHECKLIST_LEVELS, OUTBOX_KINDS, SESSION_ID, VERDICT_CHECKLIST } from '../../shared/record.mjs';
import { REVIEW_ROLES } from '../../shared/review-roles.mjs';

export { REVIEW_ROLES };
export const MAX_OUTBOX_BYTES = 256 * 1024;
export const MAX_LAUNCH_BYTES = 16 * 1024;
export const LAUNCH_NAME = /^([A-Za-z0-9-]{1,128})\.json$/;
// A card id: letters, digits, dot, dash and underscore, never `..` (L66), so it can't climb out of a folder it names.
// The one definition: the review runner and the Dispatcher's requests use it too.
export const CARD_ID = /^(?!.*\.\.)[A-Za-z0-9._-]{1,200}$/;
const HEX40 = /^[0-9a-f]{40}$/;

// Is the review user a separate Mac user? null when it is, else the reason (L44). Also used by the Merge Gate.
export function reviewUserProblem(uids, role) {
  if (!REVIEW_ROLES.includes(role)) return `${role} is not a review role`;
  const own = uids?.[role];
  if (!Number.isInteger(own)) return `no review user configured for ${role}`;
  if (own === 0) return 'the review user may not be root';
  const shared = Object.entries(uids ?? {}).filter(([r, u]) => !REVIEW_ROLES.includes(r) && u === own).map(([r]) => r);
  if (shared.length) return `the review user is not a separate Mac user (shared with ${shared.join(', ')})`;
  return null;
}

// The one Mac user both review roles run as: the runner is one process, so the reviewer and the auditor share it.
export function reviewUid(uids) {
  for (const r of REVIEW_ROLES) { const p = reviewUserProblem(uids, r); if (p) return { ok: false, reason: p }; }
  if (new Set(REVIEW_ROLES.map((r) => uids[r])).size !== 1) return { ok: false, reason: 'the reviewer and the auditor must run as the same review user' };
  return { ok: true, uid: uids[REVIEW_ROLES[0]] };
}

export function launchesFolderProblem(root, uid) {
  if (typeof root !== 'string' || !root.startsWith('/')) return 'no review launches folder is configured';
  let st;
  try { st = lstatSync(root); } catch { return 'the review launches folder is missing'; }
  if (st.isSymbolicLink()) return 'the review launches folder is a link';
  if (!st.isDirectory()) return 'the review launches folder is not a folder';
  if (st.uid !== uid) return 'the review launches folder is not owned by the review user';
  if (st.mode & 0o022) return 'the review launches folder can be written by others than the review user';
  return null;
}

// One launch record, read as the outbox reads a file: no link, a plain file with one name, review's own and writable by
// no one else, small, and naming itself (the session id in the file is the one in its name). The launch, ended and
// set-aside records are all read here.
//
// A record that fails its checks still says what it can (L69 point 3): `sid` from its name, and `tie`, the card (and
// role, head and tree, when well formed) its bytes name. Only review can write in these folders, so the bytes are the
// runner's; what fails is usually the file's standing (a hard link someone made to it raises its link count). So a bad
// record refuses only the card it belongs to, not every card.
function readLaunch(root, uid, name, fstat = fstatSync) {
  const m = LAUNCH_NAME.exec(name);
  let tie = null;
  const no = (reason, none = false) => ({ ok: false, reason, none, sid: m ? m[1] : null, tie });
  if (!m) return no(`${name.slice(0, 80)} is not a launch record name`);
  let fd;
  try { fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return no(e?.code === 'ELOOP' ? 'the launch record is a link' : e?.code === 'ENOENT' ? 'no launch record' : `the launch record can't be opened (${e?.code ?? 'error'})`, e?.code === 'ENOENT');
  }
  let buf; let standing = null;
  try {
    const st = fstat(fd);
    if (!st.isFile()) return no('the launch record is not a plain file');
    if (st.size > MAX_LAUNCH_BYTES) return no(`the launch record is over ${MAX_LAUNCH_BYTES} bytes`);
    standing = st.nlink !== 1 ? 'the launch record has more than one name (a hard link)'
      : st.uid !== uid ? 'the launch record is not owned by the review user'
        : st.mode & 0o022 ? 'the launch record can be written by others than the review user' : null;
    buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, got); if (!n) break; got += n; }
    buf = buf.subarray(0, got);
  } finally { closeSync(fd); }
  let doc = null;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf)); } catch { doc = null; }
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && typeof doc.card === 'string' && CARD_ID.test(doc.card)) {
    tie = { card: doc.card };
    if (REVIEW_ROLES.includes(doc.role) && HEX40.test(doc.head ?? '') && doc.session_id === m[1]) Object.assign(tie, { role: doc.role, head: doc.head, tree: HEX40.test(doc.tree ?? '') ? doc.tree : null });
  }
  if (standing) return no(standing);
  if (doc === null) return no('the launch record is not JSON');
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('the launch record is not a JSON object');
  if (doc.session_id !== m[1]) return no('the launch record names another session than its file name');
  if (!REVIEW_ROLES.includes(doc.role)) return no('the launch record names no review role');
  if (typeof doc.card !== 'string' || !CARD_ID.test(doc.card)) return no('the launch record names no card');
  if (typeof doc.head !== 'string' || !HEX40.test(doc.head)) return no('the launch record names no 40-hex head');
  if (doc.tree !== undefined && (typeof doc.tree !== 'string' || !HEX40.test(doc.tree))) return no('the launch record names a tree that is not 40 hex');
  return { ok: true, doc, key: createHash('sha256').update(buf).digest('hex') };
}

/** The runner's launch record for one session, matching role, card and head; anything else is a refusal, never a throw. */
// `fstat` is a port, so a test can stand in for a record another user owns (L66).
export function runnerLaunchFor({ root, uids, uid, role, card, head, sessionId, fstat } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!REVIEW_ROLES.includes(role)) return no(`${role} is not a review role`);
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return no('no session id of letters, digits and dashes');
  const u = uid !== undefined ? (Number.isInteger(uid) && uid > 0 ? { ok: true, uid } : { ok: false, reason: 'no review user id' }) : reviewUid(uids);
  if (!u.ok) return no(u.reason);
  const bad = launchesFolderProblem(root, u.uid);
  if (bad) return no(bad);
  const r = readLaunch(root, u.uid, `${sessionId}.json`, fstat);
  if (!r.ok) return no(`${r.reason} for session ${sessionId}`);
  const d = r.doc;
  if (d.role !== role) return no(`the runner launched session ${sessionId} as ${d.role}, not ${role}`);
  if (d.card !== card) return no(`the runner launched session ${sessionId} on another card`);
  if (d.head !== head) return no(`the runner launched session ${sessionId} on head ${d.head.slice(0, 7)}, not ${String(head).slice(0, 7)}`);
  return { ok: true, launch: d, key: r.key };
}

/** Every launch record that passes the checks; a bad file is listed under `refused` (with its `sid` and `tie`), a bad folder refuses the lot. */
export function runnerLaunches({ root, uids, fstat } = {}) {
  const u = reviewUid(uids);
  if (!u.ok) return { ok: false, reason: u.reason };
  const bad = launchesFolderProblem(root, u.uid);
  if (bad) return { ok: false, reason: bad };
  let names;
  try { names = readdirSync(root).sort(); } catch { return { ok: false, reason: 'the review launches folder could not be listed' }; }
  const launches = []; const refused = [];
  for (const name of names) {
    // The runner writes `.<name>.tmp` first and renames it into place, so a half-written record is never under its name.
    if (name.startsWith('.')) continue;
    const r = readLaunch(root, u.uid, name, fstat);
    if (r.ok) launches.push({ doc: r.doc, key: r.key }); else refused.push({ name, reason: r.reason, sid: r.sid, tie: r.tie });
  }
  return { ok: true, launches, refused };
}

export const ENDED_FOLDER = 'ended';
/** The runner's ended records folder: beside its launch records, in the runner's own folder (L68). */
export const endedFolderOf = (launchesRoot) => join(dirname(String(launchesRoot)), ENDED_FOLDER);
export const ASIDE_FOLDER = 'set-aside';
/** The runner's set-aside records folder (L69): sessions Joe set aside with "review again", beside the launch records. */
export const asideFolderOf = (launchesRoot) => join(dirname(String(launchesRoot)), ASIDE_FOLDER);
// What an ended record says of the verdict file (L69 point 2): its sha256 when the session ended, `none` when it left no
// file, `refused` when the file it left could not be counted.
export const ENDED_VERDICT = /^(?:[0-9a-f]{64}|none|refused)$/;

function reviewUidOf(uids, uid) {
  return uid !== undefined ? (Number.isInteger(uid) && uid > 0 ? { ok: true, uid } : { ok: false, reason: 'no review user id' }) : reviewUid(uids);
}

// One record of the runner's, by session, in a folder it makes when it first writes there: no folder or no record is
// `none`; a record that fails its checks is a refusal with its reason.
function runnerRecord(what, root, uid, sessionId, fstat) {
  const no = (reason, none = false) => ({ ok: false, reason, none });
  try { lstatSync(root); } catch (e) { if (e?.code === 'ENOENT') return no('none', true); }
  const bad = launchesFolderProblem(root, uid);
  if (bad) return no(`the ${what} records: ${bad}`);
  const r = readLaunch(root, uid, `${sessionId}.json`, fstat);
  if (!r.ok) return r.none ? no('none', true) : { ...no(`the ${what} record of session ${sessionId}: ${r.reason}`), tie: r.tie };
  return { ok: true, doc: r.doc };
}

/**
 * The runner's record that a session it launched has ended (L68), read with every check a launch record gets, and
 * naming the same session, role, card and head. `none` when there is no such record (the session may still be running).
 * It says what the verdict file was when the session ended (`verdict_sha256`, L69).
 */
export function runnerEnded({ root, uids, uid, role, card, head, sessionId, fstat } = {}) {
  const no = (reason, none = false) => ({ ok: false, reason, none });
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return no('no session id of letters, digits and dashes');
  const u = reviewUidOf(uids, uid);
  if (!u.ok) return no(u.reason);
  const r = runnerRecord('ended', root, u.uid, sessionId, fstat);
  if (!r.ok) return r.none ? no(`the runner has not marked session ${sessionId} ended`, true) : no(r.reason);
  const d = r.doc;
  if (d.role !== role || d.card !== card || d.head !== head) return no(`the ended record of session ${sessionId} is for another role, card or head`);
  if (!Number.isFinite(Date.parse(d.ended_at ?? ''))) return no(`the ended record of session ${sessionId} has no ended_at`);
  if (typeof d.verdict_sha256 !== 'string' || !ENDED_VERDICT.test(d.verdict_sha256)) return no(`the ended record of session ${sessionId} does not say what verdict file it ended with`);
  return { ok: true, ended: d };
}

/**
 * Joe's "review again" (L69 point 1): the runner's record that Joe set a session aside, so it has no say. Read with
 * every check a launch record gets, for the same session and card (and role and head, when given).
 */
export function runnerAside({ root, uids, uid, role, card, head, sessionId, fstat } = {}) {
  const no = (reason, none = false) => ({ ok: false, reason, none });
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return no('no session id of letters, digits and dashes');
  const u = reviewUidOf(uids, uid);
  if (!u.ok) return no(u.reason);
  const r = runnerRecord('set-aside', root, u.uid, sessionId, fstat);
  if (!r.ok) return r.none ? no(`Joe has not set session ${sessionId} aside`, true) : no(r.reason);
  const d = r.doc;
  if (d.card !== card || (role !== undefined && d.role !== role) || (head !== undefined && d.head !== head)) return no(`the set-aside record of session ${sessionId} is for another role, card or head`);
  if (d.by !== 'joe' || !Number.isFinite(Date.parse(d.set_aside_at ?? ''))) return no(`the set-aside record of session ${sessionId} does not say Joe set it aside, and when`);
  return { ok: true, aside: d };
}

/**
 * Every session the runner launched for this card at this head, or at any head with the same tree (L69 point 4), each
 * settled from review's own stores (L68, L69). Nothing is read from the Record. For each session, in this order:
 *   1. a set-aside record from Joe → it has no say (`aside`);
 *   2. its ended record, read FIRST: none → not ended, and it blocks whether or not a file is there;
 *   3. the verdict file, which must be the one the ended record names (its sha256): a file changed or gone since the end,
 *      or one that appeared after a session ended with none, can't be counted; `none` with no file is a silent end.
 * `tree` is the head's tree (the Merge Gate reads it from git). Without it, the trees the launch records at this head name
 * stand in. A launch record that fails its checks refuses only the card it belongs to (its own bytes say which, or else
 * its session's ended record or verdict file); one that can't be tied to any card is skipped and listed in `skipped`.
 * → { ok, sessions: [{ role, session_id, head, tree, aside, ended, silent, verdict | null, problem | null }], skipped }
 *   | { ok: false, reason }
 */
export function headReviews({ launches, outboxRoot, uids, card, head, tree, fstat } = {}) {
  const rl = runnerLaunches({ root: launches, uids, fstat });
  if (!rl.ok) return { ok: false, reason: rl.reason };
  const uid = uids[REVIEW_ROLES[0]];
  const endedRoot = endedFolderOf(launches);
  const asideRoot = asideFolderOf(launches);
  const trees = HEX40.test(tree ?? '') ? [tree]
    : [...new Set(rl.launches.filter((l) => l.doc.card === card && l.doc.head === head && l.doc.tree).map((l) => l.doc.tree))];
  // A bad record: whose card is it? Its own bytes first; then its session's ended record or verdict file.
  const tiedCard = (r) => {
    if (r.tie?.card) return r.tie.card;
    if (!r.sid) return null;
    const e = readLaunchQuiet(endedRoot, uid, r.sid, fstat);
    if (e) return e;
    for (const role of REVIEW_ROLES) {
      const v = sessionVerdict({ outboxRoot, uids, role, sessionId: r.sid, card: null, head: null });
      if (v.card) return v.card;
    }
    return null;
  };
  const skipped = [];
  for (const r of rl.refused) {
    const c = tiedCard(r);
    if (c === null) { skipped.push({ name: r.name, reason: r.reason }); continue; }
    if (c !== card) continue;
    if (r.sid && runnerAside({ root: asideRoot, uid, sessionId: r.sid, card, role: r.tie?.role, head: r.tie?.head, fstat }).ok) continue;
    return { ok: false, reason: `the launch record ${r.name} of card ${card} fails its checks, so no review of this card can be counted (${r.reason})` };
  }
  const sessions = [];
  for (const l of rl.launches) {
    const d = l.doc;
    if (d.card !== card || !(d.head === head || (d.tree && trees.includes(d.tree)))) continue;
    const s = { role: d.role, session_id: d.session_id, head: d.head, tree: d.tree ?? null, aside: false, ended: false, silent: false, verdict: null, problem: null };
    sessions.push(s);
    const a = runnerAside({ root: asideRoot, uid, role: d.role, card, head: d.head, sessionId: d.session_id, fstat });
    if (a.ok) { s.aside = true; continue; }
    if (!a.none) { s.problem = a.reason; continue; }
    const e = runnerEnded({ root: endedRoot, uid, role: d.role, card, head: d.head, sessionId: d.session_id, fstat });
    if (!e.ok) { if (!e.none) s.problem = e.reason; continue; }
    s.ended = true;
    const want = e.ended.verdict_sha256;
    const v = sessionVerdict({ outboxRoot, uids, role: d.role, sessionId: d.session_id, card, head: d.head });
    if (want === 'refused') s.problem = `its verdict could not be counted when it ended${v.ok || v.none ? '' : ` (${v.reason})`}`;
    else if (want === 'none') { if (v.none) s.silent = true; else s.problem = v.ok ? 'a verdict file was left after the session ended with none' : v.reason; }
    else if (!v.ok) s.problem = v.none ? 'its verdict file is gone since the session ended' : v.reason;
    else if (v.verdict.sha256 !== want) s.problem = 'its verdict file changed after the session ended; only the version written by the end counts, and it is gone';
    else s.verdict = v.verdict;
  }
  return { ok: true, sessions, skipped };
}

// The card a record of the runner's names, whatever its standing; null when it names none.
function readLaunchQuiet(root, uid, sid, fstat) {
  try { lstatSync(root); } catch { return null; }
  const r = readLaunch(root, uid, `${sid}.json`, fstat);
  return r.ok ? r.doc.card : r.tie?.card ?? null;
}

/**
 * The worst verdict for one role (L68, L69): Joe's set-aside sessions have no say; of the rest, a verdict that can't be
 * counted, a session that has not ended (file or not), a session that ended without a verdict (a crash, a context-limit
 * stop or a kill counts too) and a failing verdict each refuse; with `needPass`, so does having no passing session.
 * null when the role passes.
 */
export function worstVerdict(sessions, role, passes, { needPass = true } = {}) {
  const mine = (Array.isArray(sessions) ? sessions : []).filter((s) => s?.role === role && s.aside !== true);
  for (const s of mine) {
    if (s.problem) return `the ${role} session ${s.session_id}'s verdict can't be counted, so it counts as a failure: ${s.problem}`;
    if (s.ended !== true) return `the ${role} session ${s.session_id} has not ended yet, so what it says is not known`;
    if (s.silent || !s.verdict) return `the ${role} session ${s.session_id} ended without handing in a verdict, which counts as a failure`;
    if (!passes(s.verdict)) return `the ${role} session ${s.session_id} did not pass`;
  }
  if (needPass && !mine.some((s) => s.verdict && passes(s.verdict))) return `no ${role} session handed in a pass`;
  return null;
}

/** Every line of the four-line checklist (L44) at a known level, none of them material. */
export const checklistClean = (v) => !!v?.checklist && typeof v.checklist === 'object'
  && VERDICT_CHECKLIST.every((k) => CHECKLIST_LEVELS.includes(v.checklist[k]) && v.checklist[k] !== 'material');

/**
 * Each role's own pass, the one definition (L69 point 6): a reviewer passes with a clean four-line checklist (L44), an
 * auditor with 0 Material. The Merge Gate (M6 refusals.mjs) and the record's move to verified both use it.
 */
export const PASSES = Object.freeze({
  reviewer: (v) => v?.pass === true && checklistClean(v),
  auditor: (v) => v?.pass === true && v.material === 0,
});

// The longest listed kind the name starts with (so `report-compact-x` is report-compact-, not report-).
export function kindOf(name) {
  let best = null;
  for (const k of Object.keys(OUTBOX_KINDS)) if (name.startsWith(k) && name.length > k.length && (!best || k.length > best.length)) best = k;
  return best;
}

export function readOutboxFile({ outboxRoot, uids = {}, tag, file }) {
  const given = typeof file === 'string' ? file : '';
  const no = (reason, key = `${given}\0${reason}`) => ({ ok: false, key, reason });
  if (!given) return no('no file');
  if (!tag || typeof tag.role !== 'string' || typeof tag.sessionId !== 'string' || !SESSION_ID.test(tag.sessionId)) return no('bad outbox tag');
  if (typeof outboxRoot !== 'string' || !outboxRoot) return no('no outbox root configured');

  let real; let folder;
  try { real = realpathSync(given); } catch { return no('file not found'); }
  // The role and session folders themselves may not be links: a session folder linked to another's would hand that
  // session's files in under this tag (0b-2 audit MIN-5).
  try {
    for (const p of [join(outboxRoot, tag.role), join(outboxRoot, tag.role, tag.sessionId)]) if (lstatSync(p).isSymbolicLink()) return no(`outbox folder ${basename(p)} is a link`);
    folder = realpathSync(join(outboxRoot, tag.role, tag.sessionId));
  } catch { return no(`no outbox folder for ${tag.role} ${tag.sessionId}`); }
  if (dirname(real) !== folder) return no(`file is not directly inside the ${tag.role} outbox of session ${tag.sessionId}`);
  // The name given must be the file itself, not a link to it: realpath follows links, O_NOFOLLOW checks the last part.
  if (basename(given) !== basename(real)) return no('file is a link');

  const name = basename(real);
  const kind = kindOf(name);
  if (!kind) return no(`no outbox kind for file name ${name.slice(0, 80)}`);
  const spec = OUTBOX_KINDS[kind];
  if (!spec.roles.includes(tag.role)) return no(`outbox kind ${kind} is not listed for ${tag.role}`);
  if (!spec.entity) return no(`outbox kind ${kind} has no record rule yet`);

  const owner = uids[tag.role];
  if (!Number.isInteger(owner)) return no(`no owner uid configured for ${tag.role} outboxes`);
  if (spec.entity === 'verdict') {
    const p = reviewUserProblem(uids, tag.role);
    if (p) return no(`verdict refused: ${p}`);
    try {
      for (const d of [join(outboxRoot, tag.role), join(outboxRoot, tag.role, tag.sessionId)]) {
        const st = lstatSync(d);
        if (st.uid !== owner) return no(`verdict refused: outbox folder ${basename(d)} is not owned by the review user`);
        if (st.mode & 0o022) return no(`verdict refused: outbox folder ${basename(d)} is writable by others than the review user`);
      }
    } catch { return no('verdict refused: the outbox folder could not be checked'); }
  }
  let fd;
  // O_NONBLOCK: a FIFO can't hang the pass (0b-2 audit round 9 M5).
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return no(e?.code === 'ELOOP' ? 'file is a link' : `can't open file (${e?.code ?? 'error'})`); }
  let buf;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return no('not a plain file');
    if (st.nlink !== 1) return no('file has more than one name (a hard link)');
    if (st.uid !== owner) return no(`file is owned by uid ${st.uid}, not the ${tag.role} outbox owner`);
    if (st.size > MAX_OUTBOX_BYTES) return no(`file is ${st.size} bytes, over ${MAX_OUTBOX_BYTES}`);
    buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, got); if (!n) break; got += n; }
    // A file that grew past the limit after fstat is cut at the size fstat saw; a second read finds the rest.
    if (readSync(fd, Buffer.alloc(1), 0, 1, got) !== 0) return no('file changed while being read');
    buf = buf.subarray(0, got);
  } finally { closeSync(fd); }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const key = `${real}\0${sha256}`;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return no('file is not valid UTF-8 text', key); }

  if (spec.mode === 'create') return { ok: true, key, kind, spec, header: null, body: text, sha256, realpath: real, owner_uid: owner };
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  let header;
  try { header = JSON.parse(first); } catch { return no('the first line is not a JSON header', key); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return no('the header is not a JSON object', key);
  if (header.entity !== spec.entity) return no(`a ${kind} file's header must name entity ${spec.entity}`, key);
  if (header.fields !== undefined && (!header.fields || typeof header.fields !== 'object' || Array.isArray(header.fields))) return no('header fields must be an object', key);
  return { ok: true, key, kind, spec, header, body: nl < 0 ? '' : text.slice(nl + 1), sha256, realpath: real, owner_uid: owner };
}

/** A verdict file's header, checked: the one reading of what a verdict says, for the intake and for every later read. */
export function verdictFields(h) {
  const no = (reason) => ({ ok: false, reason });
  if (!h || typeof h !== 'object' || Array.isArray(h) || h.entity !== 'verdict') return no('the header is not a verdict\'s');
  const fields = h.fields ?? {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return no('header fields must be an object');
  const extra = Object.keys(fields).filter((k) => !['head', 'pass', 'notes', 'checklist', 'material'].includes(k));
  if (extra.length) return no(`a verdict may not set ${extra.join(', ')}`);
  if (typeof h.card !== 'string' || !CARD_ID.test(h.card) || h.card.split('.').includes('')) return no('a verdict names its card');
  if (typeof fields.head !== 'string' || !HEX40.test(fields.head)) return no('a verdict names the 40-hex head it reviewed');
  if (typeof fields.pass !== 'boolean') return no('a verdict says pass: true or false');
  if (fields.checklist !== undefined) {
    const cl = fields.checklist;
    if (!cl || typeof cl !== 'object' || Array.isArray(cl) || Object.keys(cl).some((k) => !VERDICT_CHECKLIST.includes(k))
      || Object.values(cl).some((v) => !CHECKLIST_LEVELS.includes(v))) return no(`checklist lines are ${VERDICT_CHECKLIST.join(', ')}, each ${CHECKLIST_LEVELS.join('|')}`);
  }
  if (fields.material !== undefined && !(Number.isInteger(fields.material) && fields.material >= 0)) return no('material is a whole-number count');
  return { ok: true, card: h.card, head: fields.head, pass: fields.pass, notes: fields.notes ?? null, checklist: fields.checklist ?? null, material: fields.material ?? null };
}

/**
 * A review session's own verdict, judged as the intake judges it (L66): the one verdict file in its outbox folder, read
 * with every check, for the card and head it was launched on. The review runner calls this when a session ends and
 * writes the file's sha256 (or none, or refused) into the ended record; a verdict the intake would refuse, or none at
 * all, holds the head (L69). The Merge Gate calls it again and counts the file only if its sha256 is the one recorded.
 * → { ok, verdict (with its sha256) } | { ok: false, none, reason, card? } (`none` when nothing was handed in; `card`
 * when the file names another card than asked, or the question named none)
 */
export function sessionVerdict({ outboxRoot, uids, role, sessionId, card, head } = {}) {
  const no = (reason, none = false) => ({ ok: false, none, reason });
  try {
    if (!REVIEW_ROLES.includes(role)) return no(`${role} is not a review role`);
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return no('no session id of letters, digits and dashes');
    const dir = join(outboxRoot, role, sessionId);
    let names;
    // No folder at all is nothing handed in; any other failure to list it is a refusal.
    try { names = readdirSync(dir).filter((n) => !n.startsWith('.') && kindOf(n) === 'verdict-'); } catch (e) { return e?.code === 'ENOENT' ? no('no verdict was handed in (no outbox folder)', true) : no('its outbox folder could not be listed'); }
    if (!names.length) return no('no verdict was handed in', true);
    if (names.length > 1) return no('more than one verdict file was left, so none counts');
    const f = readOutboxFile({ outboxRoot, uids, tag: { role, sessionId }, file: join(dir, names[0]) });
    if (!f.ok) return no(f.reason);
    const v = verdictFields(f.header);
    if (!v.ok) return no(v.reason);
    if (v.card !== card) return { ...no(`the verdict names card ${v.card}, not ${card}`), card: v.card };
    if (v.head !== head) return no(`the verdict names head ${v.head.slice(0, 7)}, not ${String(head).slice(0, 7)}`);
    return { ok: true, verdict: { ...v, role, session_id: sessionId, outbox_uid: f.owner_uid, source_key: f.key, sha256: f.sha256 } };
  } catch (e) { return no(`the verdict could not be read (${e?.code ?? e?.message ?? e})`); }
}

/** What a verdict row's own file says, read again with every check (L66 M1); a row whose file fails is a refusal, never a throw. */
export function verdictFromFile({ outboxRoot, uids, row } = {}) {
  const no = (reason) => ({ ok: false, reason });
  try {
    const d = row?.doc;
    if (!d || typeof d !== 'object') return no('no verdict row');
    if (!REVIEW_ROLES.includes(d.role)) return no('the verdict row names no review role');
    if (typeof d.session_id !== 'string' || !SESSION_ID.test(d.session_id)) return no('the verdict row names no session');
    const cut = typeof d.source_key === 'string' ? d.source_key.lastIndexOf('\0') : -1;
    if (cut <= 0) return no(`the verdict row of session ${d.session_id} names no file`);
    const file = d.source_key.slice(0, cut);
    const f = readOutboxFile({ outboxRoot, uids, tag: { role: d.role, sessionId: d.session_id }, file });
    if (!f.ok) return no(`the verdict file of session ${d.session_id} fails its checks: ${f.reason}`);
    if (f.key !== d.source_key) return no(`the verdict file of session ${d.session_id} is not the one handed in (its content changed)`);
    if (f.kind !== 'verdict-') return no(`the file of session ${d.session_id} is not a verdict`);
    let names;
    try { names = readdirSync(dirname(f.realpath)); } catch { return no(`the outbox of session ${d.session_id} could not be listed`); }
    if (names.filter((n) => !n.startsWith('.') && kindOf(n) === 'verdict-').length !== 1) return no(`session ${d.session_id} left more than one verdict file, so none counts`);
    const v = verdictFields(f.header);
    if (!v.ok) return no(`the verdict file of session ${d.session_id}: ${v.reason}`);
    return { ok: true, verdict: { role: d.role, session_id: d.session_id, card: v.card, head: v.head, pass: v.pass, checklist: v.checklist, material: v.material,
      created_by: `${d.role}:${d.session_id}`, outbox_uid: f.owner_uid, source_key: f.key } };
  } catch (e) { return no(`the verdict file could not be read (${e?.code ?? e?.message ?? e})`); }
}
