// Part C, runner step 5: the worker runner's real ports (start, saveWork, pauseLead, outboxDrained, size), as
// review-runner-main.mjs realPorts is for the review runner. groupGone and stopGroup are runner-loop.mjs's (step 4).
//
// What each one does, and what is still another lane's (each such piece is a port that refuses until it is given, so no
// session ever runs on a guess; the list is in the step-5 PR and on the lead's Mini list):
//   start({ card, kind, product, sessionId }) → { ok: true, pid, pgid, pidStart, head, base, outbox, signin, configDir, copy }
//     1. the card is read from the Record (read only) and must be claimed for this very session (claim.session_id): a
//        launch request for a card claimed by another session starts nothing;
//     2. the copy's start commit comes from `startCommit` (default cardStartCommit, L825: a Tier 1 card, or one with no
//        tier, starts on its plan's main_commit, which must be 40 hex; any other card on the mirror's main), then M4's
//        prepareWorkerCopy makes <copiesRoot>/<card> (never over a folder that is there). The answer's `base` names that
//        commit; it is kept in the runner's own session row and its answer (#364 r1 m2). The launch record has no field
//        for it yet (writeLaunch, lane 2), and the status file's session fields don't carry it;
//     3. the outbox <outboxRoot>/<role>/<sessionId> is made, 0o700 (the role folder's access list lets intake read it);
//     4. the session's settings: walledLaunchSettings (step 2's wall) with the product's fixed paths from the config and
//        this session's copy and outbox, the other cards' copies that are there at this start denied, written 0o600
//        under the runner's own folder, which the wall denies to every session. Every other product's mirror is denied
//        too (#364 r1 M1), and the config must name the Record, key and home deny entries (runner-main.mjs, r1 M2).
//        KNOWN GAP, accepted (#364 r1 M1 ruling (a)): a copy made after this start is not in this session's list. Every
//        session runs as the owner's own Mac user, the same user that owns every copy, so no access list can tell one
//        session from another, and the list is fixed when the session starts (a deny on all of <copiesRoot> would deny
//        its own copy too, since a deny wins over an allow). All copies share one copies folder, so this holds for another
//        product's copy made after the start as well as this product's. A Mac user per session or per product would close
//        it: a choice not taken ("we chose not to", no expiry);
//     5. M4's launch(), checks 1 to 13, with the worker checks from `checksFor` (runner-checks.mjs workerChecks, joined
//        by runner-main.mjs; none by default); a check that applies and has no port is refused there. Just before
//        claude starts, `beforeStart` runs check 2 again (runner-main.mjs startDeps; #369 M1), since checks 4 and 11
//        run the branch's own code;
//     6. claude is spawned detached (review-launch.mjs spawnClaude), so it leads its own process group (pid = pgid), with
//        the prompt from `promptFor` (another lane's; none, and nothing starts). Its start time is read at once
//        (runner-loop.mjs leaderStart, in UTC, the one reader the stop checks against); one that can't be read gets the group killed and the start refused, since the runner tells its own
//        group from a reused number only by that time (step-4 review M3).
//     A refusal once the copy is made removes the copy, the outbox and the settings file this start made (claude never ran in
//     them as a session), so the card's next start is not refused for a copy left over.
//   saveWork(session): M4 save-work (createSaveWork) on the session's copy, into its outbox. It runs only through the
//     lock-down runner (`runLocked`), which is not built; without it save-work refuses, as it says it must.
//   pauseLead({ product }): the Lead's WRAP flow (lead-restart.mjs through sendSafe) needs the activity tracker's feed,
//     which nothing gives the runner yet; it refuses ("not wired").
//   outboxDrained(session): true when the outbox holds no file (dot files count) or is gone. Intake keeps its own keys
//     and may delete a hand-in it took (its access list has delete_child, setup/layout.mjs); until intake does, or tells
//     the runner some other way, an outbox with a file in it stays open and its session stays listed. A lead question.
//   size(session): the session's conversation file, read by M11 transcript.mjs, and its last write time. The activity
//     state is left out (the tracker is not fed in the runner), so the Dispatcher's probe reads "can't tell" and the
//     stop step waits for its late hard stop, never a guess of "safe".
// Capability note (Principle 9): where Claude Code keeps a conversation (<config dir>/projects/<the working folder with
// each character but a letter or digit made "-">/<session id>.jsonl) is CHECKED AGAINST NOTHING YET, as transcript.mjs's
// line shapes are; void at the next pin. TRANSCRIPT_PLACE_CHECKED_AGAINST names the version once the live proof runs.

import { lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync, closeSync, constants, fstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn as childSpawn } from 'node:child_process';
import { join } from 'node:path';
import { RUNNER_ROLE_OF } from './owner-status.mjs';
import { walledLaunchSettings } from './runner-launch.mjs';
import { SESSION_ID } from '../shared/record.mjs';
import { CARD_ID } from '../modules/M9-record/outbox.mjs';
import { leaderStart } from './runner-loop.mjs';
import { readTranscriptFile } from '../modules/M11-dispatcher/transcript.mjs';
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

export const TRANSCRIPT_PLACE_CHECKED_AGAINST = null;
const refuse = (reason) => ({ ok: false, reason });
const notWired = (what) => refuse(`not wired: ${what}`);
const SHA = /^[0-9a-f]{40}$/;

/** Claude Code's folder for a working folder's conversations (unchecked: see the capability note above). */
export const projectFolderName = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
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
 * outboxDrained(session) → true once the Record has taken or told every file in the outbox (L835), else false. Intake
 * keeps every hand-in (push and M6 gather read them from the outbox), so an empty folder is not the sign: each file
 * must have the Record's own `intake-applied-<session>-<name>` fact (M11 outbox-intake.mjs), naming this session and
 * file, in a state intake is done with (INTAKE_DONE), and with the sha256 of the bytes in the outbox now. Read only.
 * A file with no such fact, a fact with another sha256 or still in flight (applying, starting), a file that is
 * not a plain one, or a Record that can't be read: not drained. No files, or the outbox gone: drained.
 * `readFact(id)` is the Record's read-only fact reader, `{ ok: true, doc } | { ok: false, missing?, reason }` as
 * review-runner-main.mjs readCardFile answers for a card. None is exported for facts yet (lane 2's), so by default
 * every read fails and an outbox holding a file stays open: it fails safe, never closing one the Record has not taken.
 */
// The states lead-restart.mjs leadInFlight counts as used (L852): `interrupted` is told once and kept, and `waiting` is a
// request held by a refusal, which may wait a week. Lane 2 is to export this one set with readFactFile; until then this
// is its copy, pinned equal to lead-restart's by runner-ports.test.mjs.
export const INTAKE_DONE = Object.freeze(['applied', 'refused', 'interrupted', 'waiting']);
const noFactReader = () => ({ ok: false, reason: 'no Record fact reader is wired' });
function fileSha256(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); return createHash('sha256').update(readFileSync(fd)).digest('hex'); } finally { closeSync(fd); }
}
export function drainedPort({ list = readdirSync, readFact = noFactReader, hashOf = fileSha256 } = {}) {
  return (s) => {
    let names; try { names = list(s.outbox); } catch (e) { return e?.code === 'ENOENT'; }
    for (const name of names) {
      let hash; try { hash = hashOf(join(s.outbox, name)); } catch { return false; }
      let f; try { f = readFact(`intake-applied-${s.id}-${name}`); } catch { return false; }
      const d = f?.ok === true ? f.doc : null;
      if (!d || d.session !== s.id || d.name !== name || !INTAKE_DONE.includes(d.state) || d.sha256 !== hash) return false;
    }
    return true;
  };
}

/** saveWork(session) → M4 save-work's answer. `runLocked` is the lock-down runner; left out, save-work refuses. */
export function saveWorkPort({ mirrorOf, runLocked, make = createSaveWork } = {}) {
  const saveWork = make({ runLocked });
  return async (s) => {
    const mirror = mirrorOf?.(s.product);
    if (typeof mirror !== 'string' || !mirror) return refuse(`product ${s.product} has no mirror in the runner's config`);
    return saveWork({ clone: s.copy, mirror, card: s.card, branch: cardBranch(s.card), outbox: s.outbox });
  };
}

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

/**
 * The start port. c (the runner's config, checked by runner-main.mjs): { copiesRoot, outboxRoot, settingsDir, home, path,
 * claudeBin, recordRoot, recordUid, workerRunner: { requestsDir, statusFile },
 * products: { <name>: { repo, mirror, render: { paths, product, rulesHosts, productionFiles, proposalOutboxes } } } }.
 * deps (ports; production passes only what is built): readCard, startCommit, prepare, checksFor(x) → { [n]: check },
 * promptFor(x) → text, names ({ version, confirmed? }, launch check 0; the flags are sessionArgs'), account, spawn, pidStartOf, kill, there, launchFn,
 * walled, fs ({ mkdir, rm, writeNew, list }), ownUid, stopped (true once the runner is stopping: nothing more is spawned,
 * #364 self-review M1).
 */
export function startPort(c, deps = {}) {
  const {
    readCard = (card) => readCardFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, card }),
    startCommit = cardStartCommit, prepare = prepareWorkerCopy, checksFor = () => ({}), promptFor = () => null,
    names = {}, account = () => accountInUse({ home: c.home }), spawn = childSpawn, pidStartOf = leaderStart, kill, there, launchFn = launch,
    walled = walledLaunchSettings, ownUid = () => process.getuid(), stopped = () => false, beforeStart,
  } = deps;
  const fs = { mkdir: mkdirSync, rm: rmSync, writeNew, list: readdirSync, ...(deps.fs ?? {}) };
  return async ({ card, kind, product, sessionId } = {}) => {
    if (stopped()) return refuse('the worker runner is stopping');
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return refuse('the session id is not one the Dispatcher makes');
    if (typeof card !== 'string' || !CARD_ID.test(card) || card.startsWith('.')) return refuse('not a card id');
    if (!Object.hasOwn(RUNNER_ROLE_OF, kind)) return refuse(`the worker runner does not start ${JSON.stringify(kind)} sessions`);
    const role = RUNNER_ROLE_OF[kind];
    const profile = DESIGN_PROFILES[role];
    const p = Object.hasOwn(c.products ?? {}, product) ? c.products[product] : null;
    if (!p || typeof p.repo !== 'string' || typeof p.mirror !== 'string' || !p.render?.paths) return refuse(`product ${product} is not in the runner's config`);
    const cd = readCard(card);
    if (!cd?.ok) return refuse(`the card can't be read from the Record (${cd?.reason ?? 'no answer'})`);
    if (cd.doc?.state !== 'claimed' || cd.doc?.claim?.session_id !== sessionId) return refuse('the card is not claimed for this session');
    if (cd.doc.product !== product) return refuse(cd.doc.product === undefined ? 'the card names no product' : 'the card is another product\'s');
    const prompt = promptFor({ role, kind, card, cardDoc: cd.doc, product });
    if (typeof prompt !== 'string' || !prompt) return notWired('no worker prompt is given to the runner');
    const who = account();
    if (!who?.account) return refuse(`no sign-in to start with (${who?.reason ?? 'no answer'})`);
    let commit; try { commit = await startCommit({ mirror: p.mirror, card, cardDoc: cd.doc }); } catch (e) { return refuse(`the copy's start commit can't be read (${e?.message ?? e})`); }
    const copy = join(c.copiesRoot, card);
    const outbox = join(c.outboxRoot, role, sessionId);
    const settingsFile = join(c.settingsDir, `${sessionId}.json`);
    const made = await prepare({ product: { repo: p.repo, mirror: p.mirror }, card: { id: card, repo: p.repo, commit, branch: cardBranch(card) }, dest: copy });
    if (!made?.ok) return refuse(`the copy can't be made (${made?.reason ?? 'no answer'})`);
    const ours = [copy];
    const undo = (reason) => { for (const f of ours) { try { fs.rm(f, { recursive: true, force: true }); } catch { /* left for cleanup */ } } return refuse(reason); };
    try { fs.mkdir(outbox, { mode: 0o700 }); ours.push(outbox); } catch (e) { return undo(`the outbox can't be made (${e?.code ?? e?.message})`); }
    let others; try { others = fs.list(c.copiesRoot).filter((n) => n !== card).map((n) => join(c.copiesRoot, n)); } catch (e) { return undo(`the copies folder can't be listed (${e?.code ?? e?.message})`); }
    // Every other product's mirror (#364 r1 M1): known at start from the config.
    for (const [q, o] of Object.entries(c.products)) if (q !== product && typeof o?.mirror === 'string') others.push(o.mirror);
    const r = p.render;
    const w = walled({ kind, workerRunner: c.workerRunner, profile, product: r.product, rulesHosts: r.rulesHosts, productionFiles: r.productionFiles, proposalOutboxes: r.proposalOutboxes,
      paths: { ...r.paths, copy, outbox, deny: { ...(r.paths.deny ?? {}), otherCopies: [...(r.paths.deny?.otherCopies ?? []), ...others] } } });
    if (!w?.ok) return undo(w?.reason ?? 'not walled: no answer');
    try { fs.writeNew(settingsFile, `${JSON.stringify(w.settings, null, 2)}\n`); ours.push(settingsFile); } catch (e) { return undo(`the settings file can't be written (${e?.code ?? e?.message})`); }
    const env = roleEnv(process.env, { path: c.path, extra: { ...who.env, HOME: c.home } });
    const x = { role, profile, kind, sessionId, card, cardDoc: cd.doc, product, copy, outbox, env, head: made.head, claudeBin: c.claudeBin, settings: { file: settingsFile, settings: w.settings }, ownUid };
    let l;
    try {
      // Launch check 0 sees the very flags claude is started with (#364 self-review m5), as review-wiring.mjs does.
      const args = sessionArgs({ profile, settingsFile, sessionId, prompt });
      l = await launchFn({ role, profile, checks: checksFor(x) ?? {}, names: { ...names, flags: args.filter((a) => a.startsWith('--')), settings: w.settings }, ownUid,
        start: async () => {
          // Check 2 once more (#369 M1): checks 4 and 11 ran the branch's own code, which could write the copy's setup files.
          if (beforeStart) { const p = await beforeStart(x); if (p) return refuse(`the copy's setup files changed after check 2, so claude was not started: ${p}`); }
          return stopped() ? refuse('the worker runner is stopping, so claude was not started') : spawnLeader({ spawn, bin: c.claudeBin, args, cwd: copy, env, pidStartOf, ...(kill ? { kill } : {}), ...(there ? { there } : {}) });
        } });
    } catch (e) { return undo(`the launch failed (${e?.message ?? e})`); }
    // A claude that may still run keeps its copy, outbox and settings (#364 r1 m3); the runner keeps the request waiting.
    if (l?.started?.running === true) return { ok: false, running: true, pgid: l.started.pgid, reason: l.started.reason };
    if (!l?.ok) return undo(l?.reason ?? 'the launch gave no answer');
    const s = l.started;
    if (!s?.ok) return undo(s?.reason ?? 'claude was not started');
    return { ok: true, pid: s.pid, pgid: s.pgid, pidStart: s.pidStart, head: made.head, base: commit, outbox, signin: who.account, configDir: who.dir, copy };
  };
}
