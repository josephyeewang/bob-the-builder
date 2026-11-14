// Part C, runner step 5: the worker runner's real ports (start, saveWork, pauseLead, outboxDrained, size), as
// review-runner-main.mjs realPorts is for the review runner. groupGone and stopGroup are runner-loop.mjs's (step 4).
//
// What each one does, and what is still another lane's (each such piece is a port that refuses until it is given, so no
// session ever runs on a guess; the list is in the step-5 PR and on the lead's Mini list):
//   start({ card, kind, product, sessionId, live, undoCommit? }) → { ok: true, pid, pgid, pidStart, head, base, outbox, signin, configDir, copy }
//     1. the card is read from the Record (read only) and must be claimed for this very session (claim.session_id): a
//        launch request for a card claimed by another session starts nothing;
//     2. the copy's start commit comes from `startCommit` (default cardStartCommit, L825: a Tier 1 card, or one with no
//        tier, starts on its plan's main_commit, which must be 40 hex; any other card on the mirror's main). An undo
//        launch's reversed commit (undoCommit, L976) must be in the mirror and an ancestor of that start commit
//        (undoCommitProblem, safe-git; L985), or the start is refused with no copy made. promptFor is handed it (it is asked
//        once the copy and outbox exist, L970), and so is launch check 12, which holds it to the commit the card's source names. Then M4's
//        prepareWorkerCopy makes <copiesRoot>/<product>/<card> (never over a folder that is there). The answer's `base` names that
//        commit; it is kept in the runner's own session row and its answer (#364 r1 m2). The launch record has no field
//        for it yet (writeLaunch, lane 2), and the status file's session fields don't carry it;
//        The copy is <copiesRoot>/<product>/<card> and the outbox <outboxRoot>/<product>/<role>/<sessionId> (L836,
//        owner-status.mjs runnerPlaces), so each product's copies and outboxes are one folder a session can be denied whole;
//     3. the outbox <outboxRoot>/<product>/<role>/<sessionId> is made, 0o700 (the role folder's access list lets intake read it);
//     4. the session's settings: walledLaunchSettings (step 2's wall) with the product's fixed paths from the config and
//        this session's copy and outbox, the other cards' copies that are there at this start denied, written 0o600
//        under the runner's own folder, which the wall denies to every session. Every other product's mirror, copies
//        folder and outbox folder is denied whole (#364 r1 M1, L836: cross-product reads are the line held), and the config
//        must name the Record, key and home deny entries (runner-main.mjs, r1 M2).
//        KNOWN GAP, accepted (#364 r1 M1 ruling (a)), inside one product only: a copy of this product made after this
//        start is not in this session's list. Every session runs as the owner's own Mac user, the same user that owns
//        every copy, so no access list can tell one session from another, and the list is fixed when the session starts
//        (a deny on the product's whole copies folder would deny its own copy too, since a deny wins over an allow). A Mac
//        user per session would close it: a choice not taken ("we chose not to", no expiry).
//        Across products (#378 r1 M1) the line is held at the start instead: a product's folders added after a session
//        of another product started are not on that session's list, so a start of product Q is refused while any live
//        session of another product has settings that do not deny Q's copies and outbox folders whole (liveWallProblem;
//        the worker runner passes its live sessions as `live`), and the runner itself does not start while a session it
//        carries over has such settings for any product in its config (runner-main.mjs carriedOverProblem);
//     5. M4's launch(), checks 1 to 13, with the worker checks from `checksFor` (runner-checks.mjs workerChecks, joined
//        by runner-main.mjs; none by default); a check that applies and has no port is refused there. Just before
//        claude starts, `beforeStart` runs checks 1, 2, 3 and 8 again (runner-main.mjs RECHECK; #369 M1, r1 m1 and m2),
//        since checks 4 and 11 run the branch's own code;
//     6. claude is spawned detached (review-launch.mjs spawnClaude), so it leads its own process group (pid = pgid), with
//        the prompt from `promptFor` (by default workerPromptText, M5 worker-prompt.mjs; it is asked once the copy
//        and the outbox exist, with the copy's head and the outbox, L970; its reason is told when it gives none). Its start time is read at once
//        (runner-loop.mjs leaderStart, in UTC, the one reader the stop checks against); one that can't be read gets the group killed and the start refused, since the runner tells its own
//        group from a reused number only by that time (step-4 review M3).
//     A refusal once the copy is made removes the copy, the outbox and the settings file this start made (claude never ran in
//     them as a session), so the card's next start is not refused for a copy left over.
//   saveWork(session): M4 save-work (createSaveWork) on the session's copy, into its outbox. It runs only through the
//     lock-down runner (runner-locked.mjs `runLocked`, L969), under the session's own settings file; without it save-work
//     refuses, as it says it must. runner-main.mjs lockedWiring gives it the same runLocked as launch check 4.
//   pauseLead({ product }): the Lead's WRAP flow (lead-restart.mjs through sendSafe) needs the activity tracker's feed,
//     which nothing gives the runner yet; it refuses ("not wired").
//   outboxDrained(session): true when the outbox is gone, or every file in it (dot files count) has the Record's intake
//     fact for it in a done state with the sha256 of its bytes now (L852, drainedPort below, read with M4 readFactFile).
//     Any other file keeps the outbox open and its session listed: it fails safe, never closing on a hand-in not taken.
//     It answers why (`{ drained: false, cause }`, a DRAIN_CAUSES name, L896), so the runner can tell it once it lasts.
//   size(session): the session's conversation file, read by M11 transcript.mjs, and its last write time. The activity
//     state is left out (the tracker is not fed in the runner), so the Dispatcher's probe reads "can't tell" and the
//     stop step waits for its late hard stop, never a guess of "safe".
// Capability note (Principle 9): where Claude Code keeps a conversation (<config dir>/projects/<the working folder with
// each character but a letter or digit made "-">/<session id>.jsonl) is CHECKED AGAINST NOTHING YET, as transcript.mjs's
// line shapes are; void at the next pin. TRANSCRIPT_PLACE_CHECKED_AGAINST names the version once the live proof runs.
// Read in 2.1.316's own code, 13 Nov 2026: that is its rule, applied to the working folder's real path put in NFC, and
// a folder name over 200 characters is cut and given a hash suffix. projectFolderName (claude-folder-name.mjs, which
// sets the rule out step by step) does the NFC step and the cut as read there; the real-path step it leaves to runner-main.mjs, which refuses to start unless copiesRoot is its own real
// path (L1134, L1141; checked: claude-code 2.1.316). Not yet proved on a live session: the constant stays null until
// the live proof (setup/live-proofs/transcript-place.mjs) finds every case's transcript where this code says.

import { fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync, closeSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn as childSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { RUNNER_ROLE_OF, UNDO_COMMIT, runnerCopy, runnerOutbox, runnerPlaces } from './owner-status.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { USED_STATES } from '../modules/M11-dispatcher/intake-facts.mjs';
import { DRAIN_CAUSES } from '../modules/M11-dispatcher/drain-alerts.mjs';
import { walledLaunchSettings } from './runner-launch.mjs';
import { SESSION_ID } from '../shared/record.mjs';
import { CARD_ID } from '../modules/M9-record/outbox.mjs';
import { leaderStart } from './runner-loop.mjs';
import { readTranscriptFile } from '../modules/M11-dispatcher/transcript.mjs';
import { folderNameAsGiven, projectFolderName } from './claude-folder-name.mjs';
import { launch } from '../modules/M4-workshop/launcher/launch.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { prepareWorkerCopy } from '../modules/M4-workshop/launcher/worker-copy.mjs';
import { sessionArgs, spawnClaude } from '../modules/M4-workshop/launcher/review-launch.mjs';
import { accountInUse } from '../modules/M4-workshop/launcher/accounts.mjs';
import { roleEnv } from '../modules/M4-workshop/launcher/env-check.mjs';
import { readCardFile } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { createSaveWork } from '../modules/M4-workshop/git/save-work.mjs';
import { cardBranch } from '../modules/M4-workshop/git/branch.mjs';
import { git } from '../modules/M4-workshop/git/safe-git.mjs';
import { PUSH_FACT, bundleName } from '../modules/M4-workshop/git/push.mjs';
import { PRODUCT_OUTBOX_ROLES } from '../shared/product-paths.mjs';
import { workerPrompt } from '../modules/M5-review-audit/worker-prompt.mjs';

export const TRANSCRIPT_PLACE_CHECKED_AGAINST = null;
const refuse = (reason) => ({ ok: false, reason });
const notWired = (what) => refuse(`not wired: ${what}`);
const SHA = /^[0-9a-f]{40}$/;

export { folderNameAsGiven, projectFolderName };
export const transcriptPath = ({ configDir, copy, sessionId }) => join(configDir, 'projects', projectFolderName(copy), `${sessionId}.jsonl`);

/** size(session) → { size, lastWriteAt }, or a throw (the pass then lists no size). */
export function sizePort({ read = readTranscriptFile, lstat = lstatSync } = {}) {
  return (s) => {
    const file = transcriptPath({ configDir: s.config_dir, copy: s.copy, sessionId: s.id });
    const st = lstat(file);
    if (!st.isFile()) throw new Error(`session ${s.id}'s conversation file is not a plain file`);
    const size = read(file);
    if (!size) throw new Error(`session ${s.id}'s conversation file can't be read`);
    return { size, lastWriteAt: st.mtimeMs };
  };
}

/**
 * outboxDrained(session) → true once the Record has taken or told every file in the outbox (L835), else { drained:
 * false, cause } naming why for the first file that holds it open (a DRAIN_CAUSES name, M11 drain-alerts.mjs, L896). Intake
 * keeps every hand-in (push and M6 gather read them from the outbox), so an empty folder is not the sign: each file
 * must have the Record's own `intake-applied-<session>-<name>` fact (M11 outbox-intake.mjs), naming this session and
 * file, in a state intake is done with (INTAKE_DONE), and with the sha256 of the bytes in the outbox now. Read only.
 * A file with no such fact, a fact with another sha256 or still in flight (applying, starting), a file that is
 * not a plain one, or a Record that can't be read: not drained. No files, or the outbox gone: drained.
 * `waiting` is done only for a worker or script session (#388 r1 m2): intake writes it only for a Lead's queued
 * request or plan, which starts by itself later, so a Lead's outbox would close on a hand-in not yet taken. The fact
 * is read first and the file hashed only when its fact is done (#388 r1 m3), so a file never taken is never read.
 * The card's bundle (`bundle-<card>.bundle`, M4 push.mjs) is never an intake file: it counts as taken once the push of
 * this session's attempt (read from the Record's session doc, `readSession`, M4 readSessionFile) is `pushed` with the
 * sha256 of these bytes (`bundle_sha256`, L898), for a worker or script session only. No session reader, no attempt, no
 * such push, a refused one, one whose card head was not noted (head_refused), an older fact without the hash, or other
 * bytes: it stays open.
 * `readFact(id)` is the Record's read-only fact reader, `{ ok: true, doc } | { ok: false, missing?, reason }` as
 * M4 review-runner-main.mjs readFactFile answers (runner-main.mjs wires it). Left out, every read fails and an outbox
 * holding a file stays open: it fails safe, never closing one the Record has not taken.
 */
// The states intake is done with (L852): lane 2's one list (M11 intake-facts.mjs USED_STATES), which lead-restart reads too.
export const INTAKE_DONE = USED_STATES;
// The roles whose sessions are a card's own work: 'waiting' is done for them (#388 r1 m2), and only theirs carry the
// card's bundle (#388 r2 m1). The one list (L1006 M1): PRODUCT_OUTBOX_ROLES, which M4 push and M11 intake read too.
const WAITING_DONE_FOR = new Set(PRODUCT_OUTBOX_ROLES);
const doneFor = (s, state) => INTAKE_DONE.has(state) && (state !== 'waiting' || WAITING_DONE_FOR.has(s.role));
const noFactReader = () => ({ ok: false, reason: 'no Record fact reader is wired' });
const noSessionReader = () => ({ ok: false, reason: 'no Record session reader is wired' });
const SHA256 = /^[0-9a-f]{64}$/;
// Not drained, and why (L896): a DRAIN_CAUSES name, so the runner can tell it once it lasts.
const held = (cause) => {
  if (!DRAIN_CAUSES.includes(cause)) throw new Error(`no drain cause ${cause}`);
  return { drained: false, cause };
};
// A file that could not be hashed: not a plain one (a folder, a link, a pipe), or not readable.
const hashCause = (e) => (/not a plain file/.test(e?.message ?? '') || e?.code === 'ELOOP' ? 'not-a-plain-file' : 'file-unreadable');
// A fact read that is not ok: missing is "never taken" (a dot file told as its own), anything else unreadable.
const readCause = (f, name) => (f?.missing === true ? (name.startsWith('.') ? 'dot-name' : 'not-taken') : 'record-unreadable');
// The fact id rule the Record reads by (M4 readFactFile): a name it can't hold is told by what is wrong with it (L896).
const FACT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const IN_FLIGHT = new Set(['applying', 'starting']);
function nameCause(id, name) {
  if (name.includes('\uFFFD')) return 'name-not-utf8';
  if (id.length > 200) return 'fact-id-too-long';
  return FACT_ID.test(id) ? null : 'name-not-a-fact-id';
}
// The bundle taken by its push (L898): the attempt from the session's own doc, its push fact pushed with these bytes.
// → null when taken, else its cause.
function bundleHeld(s, path, { readFact, readSession, hashOf }) {
  let sd; try { sd = readSession(s.id); } catch { return 'record-unreadable'; }
  if (sd?.ok !== true) return sd?.missing === true ? 'bundle-no-attempt' : 'record-unreadable';
  const doc = sd.doc;
  const att = doc?.card === s.card ? doc.attempt : undefined;
  if (typeof att !== 'string' || !att) return 'bundle-no-attempt';
  let f; try { f = readFact(PUSH_FACT(s.card, att)); } catch { return 'record-unreadable'; }
  if (f?.ok !== true) return f?.missing === true ? 'bundle-not-pushed' : 'record-unreadable';
  const d = f.doc;
  // A push that could not note the card's head is not done (push.mjs reads it so too): it is pushed again (#388 r2 m2).
  if (d?.result !== 'pushed' || d.head_refused || !SHA256.test(String(d.bundle_sha256))) return 'bundle-not-pushed';
  let hash; try { hash = hashOf(path); } catch (e) { return hashCause(e); }
  return hash === d.bundle_sha256 ? null : 'bundle-changed';
}
function fileSha256(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); return createHash('sha256').update(readFileSync(fd)).digest('hex'); } finally { closeSync(fd); }
}
export function drainedPort({ list = readdirSync, readFact = noFactReader, readSession = noSessionReader, hashOf = fileSha256 } = {}) {
  return (s) => {
    let names; try { names = list(s.outbox); } catch (e) { return e?.code === 'ENOENT' ? true : held('outbox-unreadable'); }
    for (const name of names) {
      if (WAITING_DONE_FOR.has(s.role) && typeof s.card === 'string' && name === bundleName(s.card)) {
        const why = bundleHeld(s, join(s.outbox, name), { readFact, readSession, hashOf });
        if (why) return held(why);
        continue;
      }
      const id = `intake-applied-${s.id}-${name}`;
      const bad = nameCause(id, name);
      if (bad) return held(bad);
      let f; try { f = readFact(id); } catch { return held('record-unreadable'); }
      if (f?.ok !== true) return held(readCause(f, name));
      const d = f.doc;
      if (!d || d.session !== s.id || d.name !== name) return held('other');
      // A Lead's 'waiting' is a queued request not yet started (#388 r1 m2): still in flight.
      if (!doneFor(s, d.state)) return held(IN_FLIGHT.has(d.state) || d.state === 'waiting' ? 'in-flight' : 'other');
      let hash; try { hash = hashOf(join(s.outbox, name)); } catch (e) { return held(hashCause(e)); }
      if (d.sha256 !== hash) return held('hash-mismatch');
    }
    return true;
  };
}

/** The save-phase settings file of a session (L991 M1): no `..` in it, so it keeps to the settings folder's plain names; a session
 * id holds none, so it is no other session's file. */
export const saveSettingsName = (id) => `${id}.save.json`;

/**
 * saveWork(session, { onGroup }?) → M4 save-work's answer. `runLocked` is the lock-down runner; left out, save-work
 * refuses. The save runs under the session's save-phase settings (L991 M1: the session's walls with the network off),
 * the file the start wrote and whose hash it kept in the row (`save_settings_sha`, #463 r1 m3), in the copy's `.git`,
 * so it writes there and in the outbox only. A row with no such hash (a session started before it was kept) is refused.
 * onGroup: told the job's process groups (#463 r1 m2, r2 M1; worker-runner.mjs keeps them). The copy's `.git` must be a
 * real folder (no link) owned by the runner's user before the job runs there, and the job runs in its real path
 * (#463 r2 m3), so a .git a worker swapped for a link never moves the save's folder elsewhere.
 */
export function saveWorkPort({ mirrorOf, runLocked, settingsDir, make = createSaveWork, lstat = lstatSync, realpath = realpathSync, uid = process.getuid() } = {}) {
  return async (s, { onGroup } = {}) => {
    const mirror = mirrorOf?.(s.product);
    if (typeof mirror !== 'string' || !mirror) return refuse(`product ${s.product} has no mirror in the runner's config`);
    if (typeof runLocked === 'function' && (typeof s.save_settings_sha !== 'string' || !SHA256.test(s.save_settings_sha))) return refuse(`session ${s.id} has no save settings kept by its start, so its work can't be saved inside the lock-down`);
    const bound = typeof runLocked === 'function'
      ? (j) => {
        const git = join(s.copy, '.git');
        let st; try { st = lstat(git); } catch (e) { throw new Error(`the copy's .git can't be read (${e?.code ?? e?.message})`); }
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('the copy\'s .git is not a real folder');
        if (st.uid !== uid) throw new Error('the copy\'s .git is not the runner\'s own');
        let cwd; try { cwd = realpath(git); } catch (e) { throw new Error(`the copy's .git can't be read (${e?.code ?? e?.message})`); }
        return runLocked({ ...j, sessionId: s.id, role: RUNNER_ROLE_OF[s.kind], settingsFile: typeof settingsDir === 'string' ? join(settingsDir, saveSettingsName(s.id)) : undefined,
          // cwd .git: see runner-locked.mjs's capability note (read in claude 2.1.322 and the pin, 2.1.316, which deny
          // <cwd>/.git/config and hooks; checked: claude-code 2.1.316; Mini proof 9 runs it).
          settingsSha: s.save_settings_sha, cwd, ...(typeof onGroup === 'function' ? { onGroup } : {}) });
      }
      : undefined;
    return make({ runLocked: bound })({ clone: s.copy, mirror, card: s.card, branch: cardBranch(s.card), outbox: s.outbox });
  };
}

/** The session's environment (#463 r1 m6): the one form, for the start and the lock-down runner. */
export const sessionEnv = (c, who, base = process.env) => roleEnv(base, { path: c.path, extra: { ...who.env, HOME: c.home } });

/** pauseLead({ product }): not wired (see the top of this file). */
export const pauseLeadPort = () => async () => notWired('the Lead\'s wrap-up needs the activity tracker\'s feed, which the runner does not have yet');

/**
 * Spawns claude as the leader of its own process group and reads its start time. `kill(pgid, signal)` signals a group.
 * → { ok: true, pid, pgid, pidStart } | { ok: false, reason }
 */
export const SPAWN_KILL_WAIT_MS = 2_000;
/** Is process group g there? Signal 0; only ESRCH shows it gone (EPERM: there, but not ours to signal). */
export const groupThere = (g, signal = (x, s) => process.kill(x, s)) => { try { signal(-g, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; } };
export async function spawnLeader({ spawn = childSpawn, bin, args, cwd, env, pidStartOf = leaderStart, kill = (g, sig) => process.kill(-g, sig),
  there = groupThere, killWaitMs = SPAWN_KILL_WAIT_MS }) {
  const s = await spawnClaude(spawn, bin, args, { cwd, env });
  if (!s.ok) return s;
  let at = null;
  try { at = pidStartOf(s.pid); } catch { at = null; }
  if (typeof at !== 'string' || !at) {
    try { kill(s.pid, 'SIGKILL'); } catch { /* already gone, or shown below */ }
    // Refused only once the group is shown gone (#364 r1 m3); one that may still run is answered as running, so the
    // start keeps what it made and the runner keeps the request waiting and the claim held.
    const until = Date.now() + killWaitMs;
    let on = true;
    for (;;) { try { on = there(s.pid); } catch { on = true; } if (!on || Date.now() >= until) break; await new Promise((r) => setTimeout(r, 50)); }
    if (on) return { ok: false, running: true, pgid: s.pid, reason: 'claude started, its start time could not be read, and its group could not be shown gone after a kill' };
    return refuse('claude started, but its start time could not be read, so its group was killed');
  }
  return { ok: true, pid: s.pid, pgid: s.pid, pidStart: at };
}

/**
 * The commit a card's copy starts on (L825): a Tier 1 card's plan names it (main_commit, 40 hex; a fix card may carry no
 * tier, L228, and is held to the same rule); any other card starts on the mirror's main. → the commit, or a throw.
 */
export async function cardStartCommit({ mirror, cardDoc }, { main = mirrorMain } = {}) {
  // Only 1, 2 or none (#364 r1 m1): any other tier is refused, never read as the less strict path.
  if (![undefined, null, 1, 2].includes(cardDoc?.tier)) throw new Error(`the card's tier ${JSON.stringify(cardDoc?.tier)} is not 1 or 2`);
  if (cardDoc?.tier === undefined || cardDoc?.tier === null || cardDoc.tier === 1) {
    if (typeof cardDoc?.main_commit !== 'string' || !SHA.test(cardDoc.main_commit)) throw new Error('a Tier 1 card needs its plan\'s main_commit (40 hex)');
    return cardDoc.main_commit;
  }
  return main(mirror);
}

/**
 * An undo's reversed commit in the mirror (L976, L985): there as a commit, and an ancestor of the start commit, so the
 * copy holds what the undo reverses. → null, or the plain reason the start is refused. Asked before the copy is made.
 * Both commits must be 40 lower-case hex, or it refuses without running git (#468 m3).
 */
export async function undoCommitProblem({ mirror, commit, head }, { run = git } = {}) {
  // #468 m3: its own inputs are checked before git sees them, so a value starting with '-' is never read as an option.
  if (!(typeof commit === 'string' && UNDO_COMMIT.test(commit))) return 'the reversed commit is not 40 lower-case hex';
  if (!(typeof head === 'string' && SHA.test(head))) return 'the start commit is not 40 lower-case hex';
  const at = { gitDir: mirror, purpose: 'runner-undo-commit', timeoutMs: 30_000 };
  const short = String(commit).slice(0, 12);
  // -t, never -e with ^{commit}: an annotated tag's id peels to a commit, and is still not the commit reversed.
  const there = await run(['cat-file', '-t', commit], at);
  if (there?.code === 128 || there?.code === 1 || (there?.code === 0 && String(there?.stdout ?? '').trim() !== 'commit')) return `the reversed commit ${short} is not a commit in the mirror`;
  if (there?.code !== 0) return `the reversed commit ${short} can't be looked up in the mirror (git ${there?.code})`;
  const up = await run(['merge-base', '--is-ancestor', commit, head], at);
  if (up?.code === 1) return `the reversed commit ${short} is not an ancestor of the start commit ${String(head).slice(0, 12)}`;
  if (up?.code !== 0) return `the reversed commit ${short} can't be checked against the start commit (git ${up?.code})`;
  return null;
}

/** The mirror's main, as a fresh copy starts on it. → the commit, or a throw. */
export async function mirrorMain(mirror, { run = git } = {}) {
  const r = await run(['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}'], { gitDir: mirror, purpose: 'runner-start-commit', timeoutMs: 30_000 });
  const h = String(r?.stdout ?? '').trim();
  if (r?.code !== 0 || !SHA.test(h)) throw new Error('the mirror has no main commit');
  return h;
}

// A file made new (never over one that is there, never through a link), 0o600.
function writeNew(file, text) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { const b = Buffer.from(text, 'utf8'); for (let o = 0; o < b.length;) o += writeSync(fd, b, o, b.length - o); } finally { closeSync(fd); }
}

/** Removes a folder whole (#369 r2 m1, self-review m1, m2): removed at once; only when that fails are its folders made
 * writable again, by /bin/chmod -R -P (never through a link, so nothing outside is changed), and it is removed once
 * more. One still there is told with `log` and left until this card's next start removes it, which cleanup does not.
 * → true when it is gone. */
/** A folder's tree made owner-writable again, never through a link (-P). */
export const chmodTree = (d) => execFileSync('/bin/chmod', ['-R', '-P', 'u+rwx', d], { stdio: 'ignore', timeout: 60_000 });
export function removeAll(fs, dir, log = () => {}) {
  try { fs.rm(dir, { recursive: true, force: true }); return true; } catch { /* made writable, then once more */ }
  try { fs.chmodTree(dir); } catch { /* the removal says */ }
  try { fs.rm(dir, { recursive: true, force: true }); return true; } catch (e) {
    log(`the baseline's throwaway copy ${dir} can't be removed (${e?.code ?? e?.message}); it is left until this card's next start`);
    return false;
  }
}

/**
 * Whether a session's settings deny a product's folders whole (#378 r1 M1): its shell's read-deny list holds each one, or
 * a folder above it, and so do Claude's own Read and Edit denies. → null, or what is not denied.
 */
export function productWallGap(settings, places) {
  const shell = settings?.[S.sandbox]?.[S.filesystem]?.[S.denyRead];
  const perms = settings?.[S.permissions]?.[S.deny];
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const over = (dirs, f) => dirs.some((d) => f === d || f.startsWith(`${d.replace(/\/+$/, '')}/`));
  // Claude's form is Read(//path/**) (render-settings.mjs denyPair).
  const tool = (verb) => list(perms).map((e) => e.match(new RegExp(`^${verb}\\(/(/.*)/\\*\\*\\)$`))?.[1]).filter(Boolean);
  // The product's mirror too, when given (#378 self-review M1): every other product's mirror is denied as its copies are.
  for (const f of [places.copies, places.outboxes, places.mirror].filter((v) => typeof v === 'string')) {
    if (!over(list(shell), f)) return `its shell may read ${f}`;
    for (const verb of ['Read', 'Edit']) if (!over(tool(verb), f)) return `its ${verb} may reach ${f}`;
  }
  return null;
}

/** A live session's settings file as the start port wrote it: never through a link, a plain file, JSON. `name`: its
 *  session settings by default, or its save settings (saveSettingsName, #463 r2 m5). */
export const sessionSettingsOf = (settingsDir, name = (id) => `${id}.json`) => (id) => {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('not a session id');
  const fd = openSync(join(settingsDir, name(id)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
};

/**
 * → null, or why product's start must wait (#378 r1 M1): a live session of another product whose settings do not deny
 * the product's folders whole. live: [{ id, product, unstarted? }]; `unstarted` marks a start not known to have reached
 * claude (a waiting request), whose settings file missing means no claude was started with it (it is written first),
 * with or without a product named (a row from before rows named one). places: runnerPlaces and the product's mirror.
 * A session whose settings can't be read, or that names no product, can't be told about, so the start waits too.
 */
export function liveWallProblem(live, product, places, read) {
  for (const s of Array.isArray(live) ? live : []) {
    if (s?.product === product) continue;
    const who = `session ${s?.id}`;
    let set; let err;
    try { set = read(s?.id); } catch (e) { err = e; }
    if (err && s?.unstarted === true && err?.code === 'ENOENT') continue;
    if (typeof s?.product !== 'string') return `${who} names no product, so whether it may read product ${product}'s folders can't be told`;
    if (err) return `${who}'s settings can't be read (${err?.code ?? err?.message}), so whether it may read product ${product}'s folders can't be told`;
    const gap = productWallGap(set, places);
    if (gap) return s.unstarted === true
      // A waiting row never ends (#378 r2 c1): the owner removes its settings file once no claude runs with it (then ENOENT: skipped).
      ? `${who} (product ${s.product}), a start from an earlier run still waiting, left settings that don't deny product ${product}'s folders (${gap}); once no claude runs with them, the owner removes that settings file (${s.id}.json in the runner's settings folder), and product ${product}'s sessions can start`
      : `${who} (product ${s.product}) started before product ${product}'s folders were on its deny list (${gap}); start product ${product}'s sessions once it has ended`;
  }
  return null;
}

/**
 * The start port. c (the runner's config, checked by runner-main.mjs): { copiesRoot, outboxRoot, settingsDir, home, path,
 * claudeBin, recordRoot, recordUid, workerRunner: { requestsDir, statusFile },
 * products: { <name>: { repo, mirror, render: { paths, product, rulesHosts, productionFiles, proposalOutboxes, registryHosts? } } } }.
 * deps (ports; production passes only what is built): readCard, startCommit, prepare, checksFor(x) → { [n]: check },
 * promptFor(x) → text (asked once the copy and outbox exist, with { head, outbox }; may be async, and may answer
 * { ok: false, reason }, which undoes the start), names ({ version, confirmed? }, launch check 0; the flags are sessionArgs'), account, spawn, pidStartOf, kill, there, launchFn,
 * mainOf(mirror) → the mirror's main commit (read before and after the copy is made, #369 r1 m3), beforeStart(x) → null
 * or the reason claude must not start,
 * walled, fs ({ mkdir, rm, writeNew, list, lstat, chmodTree, rename }), ownUid, stopped (true once the runner is stopping: nothing more is spawned,
 * #364 self-review M1), log (what is told, such as a throwaway that can't be removed), productHeld(product) → null or why
 * the product starts no session (runner-main.mjs keepSnapshots, #369 r2 m2; asked at the start and again before claude),
 * readSettings(id) → a live session's settings (#378 r1 M1).
 * The request: { card, kind, product, sessionId, live, undoCommit?, onGroup? } (live: the runner's other live sessions, liveWallProblem;
 * undoCommit: the reversed commit, 40 hex, an undo's only, L976; onGroup: told check 4's install process groups, #463 r3 m1).
 */
/** The start's default prompt (L970): the worker prompt's text, or null (and the start is refused) when it gives none. */
export const workerPromptText = (x) => { const p = workerPrompt(x); return p.ok ? p.text : { ok: false, reason: p.reason }; };

export function startPort(c, deps = {}) {
  const {
    readCard = (card) => readCardFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, card }),
    startCommit = cardStartCommit, prepare = prepareWorkerCopy, checksFor = () => ({}), promptFor = workerPromptText,
    names = {}, account = () => accountInUse({ home: c.home }), spawn = childSpawn, pidStartOf = leaderStart, kill, there, launchFn = launch,
    walled = walledLaunchSettings, ownUid = () => process.getuid(), stopped = () => false, beforeStart, mainOf = mirrorMain,
    readSettings = sessionSettingsOf(c.settingsDir), undoCheck = undoCommitProblem,
  } = deps;
  const fs = { mkdir: mkdirSync, rm: rmSync, writeNew, list: readdirSync, lstat: lstatSync, chmodTree, rename: renameSync, ...(deps.fs ?? {}) };
  const log = deps.log ?? (() => {});
  return async ({ card, kind, product, sessionId, live = [], undoCommit, onGroup } = {}) => {
    if (stopped()) return refuse('the worker runner is stopping');
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return refuse('the session id is not one the Dispatcher makes');
    if (typeof card !== 'string' || !CARD_ID.test(card) || card.startsWith('.')) return refuse('not a card id');
    if (!Object.hasOwn(RUNNER_ROLE_OF, kind)) return refuse(`the worker runner does not start ${JSON.stringify(kind)} sessions`);
    if (kind === 'undo' && !(typeof undoCommit === 'string' && UNDO_COMMIT.test(undoCommit))) return refuse('the undo launch names no reversed commit');
    if (kind !== 'undo' && undoCommit !== undefined) return refuse('only an undo launch names a reversed commit');
    const role = RUNNER_ROLE_OF[kind];
    const profile = DESIGN_PROFILES[role];
    const p = Object.hasOwn(c.products ?? {}, product) ? c.products[product] : null;
    if (!p || typeof p.repo !== 'string' || typeof p.mirror !== 'string' || !p.render?.paths) return refuse(`product ${product} is not in the runner's config`);
    // A product whose rules snapshot is not kept fresh starts no session (#369 r2 m2): its hooks would refuse every call. Asked before anything is read.
    const held = deps.productHeld?.(product);
    if (held) return refuse(held);
    const cd = readCard(card);
    if (!cd?.ok) return refuse(`the card can't be read from the Record (${cd?.reason ?? 'no answer'})`);
    if (cd.doc?.state !== 'claimed' || cd.doc?.claim?.session_id !== sessionId) return refuse('the card is not claimed for this session');
    if (cd.doc.product !== product) return refuse(cd.doc.product === undefined ? 'the card names no product' : 'the card is another product\'s');
    const who = account();
    if (!who?.account) return refuse(`no sign-in to start with (${who?.reason ?? 'no answer'})`);
    let commit; try { commit = await startCommit({ mirror: p.mirror, card, cardDoc: cd.doc }); } catch (e) { return refuse(`the copy's start commit can't be read (${e?.message ?? e})`); }
    if (kind === 'undo') {
      let why; try { why = await undoCheck({ mirror: p.mirror, commit: undoCommit, head: commit }); } catch (e) { why = `the reversed commit can't be checked (${e?.message ?? e})`; }
      if (why) return refuse(why);
    }
    let mine; let copy; let outbox;
    try {
      mine = runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: c.outboxRoot, product });
      copy = runnerCopy({ copiesRoot: c.copiesRoot, product, card });
      outbox = runnerOutbox({ outboxRoot: c.outboxRoot, product, role, sessionId });
    } catch (e) { return refuse(e.message); }
    const wall = liveWallProblem(live, product, { ...mine, mirror: p.mirror }, readSettings);
    if (wall) return refuse(wall);
    const settingsFile = join(c.settingsDir, `${sessionId}.json`);
    // Setup makes each product's folders (setup/layout.mjs, L836); the start never does, so one missing is refused here.
    for (const f of [mine.copies, dirname(outbox)]) { let st; try { st = fs.lstat(f); } catch { st = null; } if (!st?.isDirectory()) return refuse(`setup has made no folder ${f} for product ${product}`); }
    // The main the copy's setup files are restored from (#369 r1 m3): read before and after the copy is made, so checks 2
    // compare with that commit, and main moving meanwhile is said as such, never read as the branch's tampering.
    let mainAt; try { mainAt = await mainOf(p.mirror); } catch (e) { return refuse(`the mirror's main can't be read (${e?.message ?? e})`); }
    const sameMain = async () => { try { return (await mainOf(p.mirror)) === mainAt; } catch { return false; } };
    const making = { product: { repo: p.repo, mirror: p.mirror }, card: { id: card, repo: p.repo, commit, branch: cardBranch(card) } };
    const made = await prepare({ ...making, dest: copy });
    if (!made?.ok) return refuse(`the copy can't be made (${made?.reason ?? 'no answer'})`);
    const ours = [copy];
    const undo = (reason) => { for (const f of ours) { try { fs.rm(f, { recursive: true, force: true }); } catch { /* left for cleanup */ } } return refuse(reason); };
    if (!(await sameMain())) return undo('main changed during launch; retry');
    try { fs.mkdir(outbox, { mode: 0o700 }); ours.push(outbox); } catch (e) { return undo(`the outbox can't be made (${e?.code ?? e?.message})`); }
    // The worker's prompt (L970): built once the copy's head and the outbox exist, since the builder names both. A string,
    // or { ok: false, reason }; either way no prompt takes the copy and the outbox away again, and says the builder's reason.
    let given; try { given = await promptFor({ role, kind, card, cardDoc: cd.doc, product, ...(kind === 'undo' ? { undoCommit } : {}), head: made.head, outbox }); } catch (e) { given = { ok: false, reason: e?.message ?? String(e) }; }
    if (typeof given !== 'string' || !given) {
      const why = given && typeof given === 'object' && typeof given.reason === 'string' && given.reason ? ` (${given.reason.slice(0, 300)})` : '';
      return undo(`not wired: no worker prompt is given to the runner${why}`);
    }
    const prompt = given;
    // This card's throwaways left by an earlier start (#369 r2 m1): one session per card, so none of them runs now.
    // One that can't be removed is told and left until the next start; the new one has its own name, so the card is never stuck on it.
    try { for (const n of fs.list(mine.copies)) if (n.startsWith(`${card}..baseline-`)) removeAll(fs, join(mine.copies, n), log); } catch { /* listed again below */ }
    let others; try { others = fs.list(mine.copies).filter((n) => n !== card).map((n) => join(mine.copies, n)); } catch (e) { return undo(`the product's copies folder can't be listed (${e?.code ?? e?.message})`); }
    // Every other folder under the copies root and the outbox root, whole (#378 m1): a product setup made but this config
    // leaves out, and anything left in the old flat layout, as well as the config's other products.
    for (const top of [c.copiesRoot, c.outboxRoot]) {
      let names; try { names = fs.list(top); } catch (e) { return undo(`${top} can't be listed (${e?.code ?? e?.message})`); }
      for (const n of names) if (n !== product) others.push(join(top, n));
    }
    // Every other product's mirror, copies folder and outbox folder, whole (#364 r1 M1, L836): known at start from the config.
    for (const [q, o] of Object.entries(c.products)) {
      if (q === product) continue;
      let theirs; try { theirs = runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: c.outboxRoot, product: q }); } catch (e) { return undo(`product ${q}'s folders can't be named (${e.message})`); }
      others.push(theirs.copies, theirs.outboxes);
      if (typeof o?.mirror === 'string') others.push(o.mirror);
    }
    // The baseline's throwaway place (#369 r1 M1), in the product's own copies folder (L836). `..` is in no card id
    // (CARD_ID refuses it), so no card's copy is named so, and the name keeps to the plain path letters the settings
    // renderer takes ([A-Za-z0-9._-], L889: a `~` was refused there). Its name is this session's (#369 r2 m1), so one
    // left behind never refuses a later start of the card.
    const spare = join(mine.copies, `${card}..baseline-${sessionId}`);
    others.push(spare);
    others = [...new Set(others)];
    const r = p.render;
    const settingsFor = (at, box, deny, phase = {}) => walled({ kind, workerRunner: c.workerRunner, profile, product: r.product, rulesHosts: r.rulesHosts, productionFiles: r.productionFiles, proposalOutboxes: r.proposalOutboxes, ...phase,
      paths: { ...r.paths, copy: at, outbox: box, deny: { ...(r.paths.deny ?? {}), otherCopies: [...(r.paths.deny?.otherCopies ?? []), ...deny] } } });
    const w = settingsFor(copy, outbox, others);
    if (!w?.ok) return undo(w?.reason ?? 'not walled: no answer');
    try { fs.writeNew(settingsFile, `${JSON.stringify(w.settings, null, 2)}\n`); ours.push(settingsFile); } catch (e) { return undo(`the settings file can't be written (${e?.code ?? e?.message})`); }
    // The save's settings (L991 M1): the session's walls, the network off; written new beside the session's, and its
    // hash answered for the row, so each save can show it is this file (#463 r1 m3).
    const ws = settingsFor(copy, outbox, others, { phase: 'save' });
    if (!ws?.ok) return undo(`the save's settings are not walled (${ws?.reason ?? 'no answer'})`);
    const saveFile = join(c.settingsDir, saveSettingsName(sessionId));
    const saveText = `${JSON.stringify(ws.settings, null, 2)}\n`;
    try { fs.writeNew(saveFile, saveText); ours.push(saveFile); } catch (e) { return undo(`the save's settings file can't be written (${e?.code ?? e?.message})`); }
    const saveSha = createHash('sha256').update(saveText).digest('hex');
    const env = sessionEnv(c, who);
    // A throwaway copy of the same commit for the baseline (#369 r1 M1), with settings that allow writes there and in its
    // own outbox only, and deny the session's copy and outbox; done() removes it. The session's own settings deny it.
    const throwaway = async () => {
      const spareSettings = join(c.settingsDir, `${sessionId}..baseline.json`);
      const done = async () => { removeAll(fs, spare, log); try { fs.rm(spareSettings, { force: true }); } catch (e) { log(`the baseline's settings file ${spareSettings} can't be removed (${e?.code ?? e?.message})`); } };
      const no = async (reason) => { await done(); return refuse(`the baseline's throwaway copy ${reason}`); };
      try { fs.mkdir(spare, { mode: 0o700 }); } catch (e) { return refuse(`the baseline's throwaway copy can't be made (${e?.code ?? e?.message})`); }
      const at = join(spare, 'copy'); const box = join(spare, 'outbox');
      const t = await prepare({ ...making, dest: at });
      if (!t?.ok) return no(`can't be made (${t?.reason ?? 'no answer'})`);
      if (t.head !== made.head) return no('holds another commit than the session\'s copy');
      try { fs.mkdir(box, { mode: 0o700 }); } catch (e) { return no(`has no outbox (${e?.code ?? e?.message})`); }
      const tw = settingsFor(at, box, [...others.filter((o) => o !== spare), copy, outbox]);
      if (!tw?.ok) return no(`is not walled (${tw?.reason ?? 'no answer'})`);
      try { fs.writeNew(spareSettings, `${JSON.stringify(tw.settings, null, 2)}\n`); } catch (e) { return no(`has no settings file (${e?.code ?? e?.message})`); }
      return { ok: true, copy: at, settingsFile: spareSettings, done };
    };
    // Check 4 (L969, installStep): 'install' renders the same walled settings with the product's registry hosts; 'session'
    // is the very settings written above, so the file put back after the install is byte for byte what check 5 reads back.
    const renderPhase = (phase) => (phase === 'session' ? { ok: true, settings: w.settings }
      : phase === 'install' ? settingsFor(copy, outbox, others, { phase: 'install', registryHosts: Array.isArray(r.registryHosts) ? r.registryHosts : [] }) : refuse('bad phase'));
    // c1: launch.mjs installStep checks the registry gone in the settings it rendered, not in the file; the two are one
    // only because this write reads the file back and compares it with them, byte for byte.
    // c4: a runner that dies during the install leaves the install-phase file (the registry's hosts allowed) as this
    // session's settings. No claude starts with it again: a session id's settings are written new only once, and the
    // undo (ours) removes it on every refusal; the owner removes it with the session's other files.
    const writeSettings = (settings) => {
      const text = `${JSON.stringify(settings, null, 2)}\n`;
      const next = `${settingsFile}.next`;
      // c2: in `ours`, so an undo removes it when the removal below fails.
      if (!ours.includes(next)) ours.push(next);
      try { fs.rm(next, { force: true }); fs.writeNew(next, text); fs.rename(next, settingsFile); } catch (e) { try { fs.rm(next, { force: true }); } catch { /* left */ } return refuse(`not written (${e?.code ?? e?.message})`); }
      let back; try { back = readSettings(sessionId); } catch (e) { return refuse(`not read back (${e?.code ?? e?.message})`); }
      return `${JSON.stringify(back, null, 2)}\n` === text ? { ok: true } : refuse('not read back as written');
    };
    const x = { role, profile, kind, sessionId, card, cardDoc: cd.doc, product, ...(kind === 'undo' ? { undoCommit } : {}), copy, outbox, env, head: made.head, mainAt, claudeBin: c.claudeBin, settings: { file: settingsFile, settings: w.settings }, ownUid, throwaway, renderPhase, writeSettings,
      // Told the install's process groups (check 4, #463 r3 m1), kept by the runner as a save's are (worker-runner.mjs `installs`).
      ...(typeof onGroup === 'function' ? { onGroup } : {}) };
    let l;
    try {
      // Launch check 0 sees the very flags claude is started with (#364 self-review m5), as review-wiring.mjs does.
      const args = sessionArgs({ profile, settingsFile, sessionId, prompt });
      l = await launchFn({ role, profile, checks: checksFor(x) ?? {}, names: { ...names, flags: args.filter((a) => a.startsWith('--')), settings: w.settings }, ownUid,
        start: async () => {
          // Checks 1, 2, 3 and 8 once more (#369 M1, r1 m1 and m2): checks 4 and 11 ran the branch's own code.
          // The product held back since the checks began (self-review m4: a refresher that died during the baseline), with
          // or without a beforeStart (#369 merge review minor 2).
          const h = deps.productHeld?.(product);
          if (h) return refuse(h);
          if (beforeStart) {
            const p = await beforeStart(x);
            // The check's own reason is kept (#369 r2 m3): every check compares with mainAt, so main moving is only told beside it.
            if (p) return refuse(`a check failed again just before claude was to start, so it was not started: ${p}${(await sameMain()) ? '' : ' (main also moved during launch, or can\'t be read)'}`);
          }
          return stopped() ? refuse('the worker runner is stopping, so claude was not started') : spawnLeader({ spawn, bin: c.claudeBin, args, cwd: copy, env, pidStartOf, ...(kill ? { kill } : {}), ...(there ? { there } : {}) });
        } });
    } catch (e) { return undo(`the launch failed (${e?.message ?? e})`); }
    // A claude that may still run keeps its copy, outbox and settings (#364 r1 m3); the runner keeps the request waiting.
    if (l?.started?.running === true) return { ok: false, running: true, pgid: l.started.pgid, reason: l.started.reason };
    if (!l?.ok) return undo(l?.reason ?? 'the launch gave no answer');
    const s = l.started;
    if (!s?.ok) return undo(s?.reason ?? 'claude was not started');
    return { ok: true, pid: s.pid, pgid: s.pgid, pidStart: s.pidStart, head: made.head, base: commit, outbox, signin: who.account, configDir: who.dir, copy, saveSettingsSha: saveSha };
  };
}
