// Setup part 6c: the owner's answer job (L609, L614, L727; LEAD-CALLS L1051). The Sensors run as orchestrate, which can't look
// into the owner's home, so a small job running AS THE OWNER asks Claude Code who is signed in and how much of the plan is used,
// and writes the answer to <base>/owner-answer/owner-answer.json (wiring/owner-answer.mjs). Without a fresh answer the
// Dispatcher starts nothing (signed-in and usage read as not known).
//
//   the job      <label>.owner-answer, in the owner's own login session (launchd's gui/<owner uid> domain): not root's, not
//                orchestrate's. Its file is <owner home>/Library/LaunchAgents/<label>.owner-answer.plist, the owner's 0644.
//                node <copy>/bin/node <copy>/wiring/owner-answer.mjs --to <answer file>, every 300 s and at load (two rounds
//                fit inside the answer's 10 minutes, sensors-ports.mjs ANSWER_STALE_MS), HOME the owner's home, PATH with the
//                owner's ~/.local/bin (where Claude Code's installer puts `claude`). Logs in <owner home>/Library/Logs.
//   who runs it  the owner, WITHOUT sudo: `node setup.mjs owner-job place|load|unload|check`. Root never writes in the
//                owner's home (a folder the owner controls is no place for root to write by name), and the owner's own
//                session is the one launchd domain that can reach the owner's sign-in. Root refuses the command.
//   place        writes the job file (whole beside the name, then renamed over it); a loaded job whose file changed is
//                taken out and loaded again, so launchd runs the file as it is now.
//   load         `launchctl bootstrap gui/<uid> <file>`, unless loaded; refuses unless the file is exactly the built one and
//                the installed copy has node and owner-answer.mjs. The login session must be open (the Mini stays logged in).
//   check        the file, the job loaded and its last run ended 0, and the answer fresh (answerRows; `daemons check` asks
//                the same of the answer whenever the Sensors job is in its list).
//
// On exactly when the Sensors are (the setup config's `dispatcher` entry). Nothing here names a product or a person.

import { dirname, join, posix } from 'node:path';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { NODE, aclProblem, currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { ANSWER_STALE_MS, answerFileProblem, answerFolderProblem, answerProblem } from '../wiring/sensors-ports.mjs';
import { installPaths } from './install.mjs';
import { LAUNCHCTL } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { DISPATCHER_OFF } from './dispatcher-setup.mjs';
import { answerFileOf } from './sensors-setup.mjs';

export const OWNER_JOB = 'owner-answer';
export const OWNER_SCRIPT = 'wiring/owner-answer.mjs';
export const OWNER_EVERY_S = 300;
export const OWNER_JOB_SUBS = Object.freeze(['place', 'load', 'unload', 'check']);
const LOG_NAME = 'orchestrate-owner-answer';
const op = (text, run) => ({ text, run });
const failText = (r) => (r.stderr.trim() || r.stdout.trim()).slice(0, 200);
// Two of the owner's rounds must fit inside the time the Sensors still believe an answer (else every other read is stale).
if (OWNER_EVERY_S * 2 > ANSWER_STALE_MS / 1000) throw new Error('the owner job runs too seldom for the answer\'s time limit');

/** The owner's Mac user, as the job needs it: { uid, home } or { problem }. */
function ownerOf(io, cfg) {
  const u = readUser(io, cfg.owner);
  if (!u.exists || !Number.isInteger(u.uid) || u.uid <= 0) return { problem: `the owner's Mac user ${cfg.owner} was not found` };
  if (typeof u.home !== 'string' || !u.home.startsWith('/') || posix.normalize(u.home) !== u.home) return { problem: `the owner's Mac user ${cfg.owner} has no plain home folder` };
  return { uid: u.uid, home: u.home };
}
export const ownerLabel = (cfg) => `${cfg.label}.${OWNER_JOB}`;
export const ownerJobPath = (home, cfg) => join(home, 'Library', 'LaunchAgents', `${ownerLabel(cfg)}.plist`);

/** The job file's text: M11's builder, every 300 s, with `--to <answer file>`, HOME and the owner's PATH. No UserName: launchd's
 *  gui domain runs it as the session's user. */
export function ownerJobPlist(cfg, { home }) {
  const P = installPaths(cfg);
  return loginJobPlist({
    label: ownerLabel(cfg), node: join(P.installRoot, NODE), script: join(P.installRoot, OWNER_SCRIPT), configFlag: '--to', config: answerFileOf(cfg),
    path: `${join(home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, logDir: join(home, 'Library', 'Logs'), logName: LOG_NAME, workDir: home, home, every: OWNER_EVERY_S,
  });
}

/** → { loaded, state, lastExit } in the owner's gui domain, or { error }. */
export function ownerJobState(io, cfg, uid) {
  const r = io.run(LAUNCHCTL, ['print', `gui/${uid}/${ownerLabel(cfg)}`]);
  if (r.status !== 0) return { loaded: false, error: r.status === 113 ? null : failText(r) };
  return { loaded: true, state: /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown', lastExit: /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown' };
}

/** Null, or why the job file is not exactly `text`, the owner's 0644 plain file with one name. */
function fileProblem(io, f, text, uid) {
  let st; try { st = io.lstat(f); } catch { return `${f} is not there (run owner-job place)`; }
  if (st.isSymbolicLink() || !st.isFile()) return `${f} is not a plain file`;
  if (st.uid !== uid) return `${f} is owned by uid ${st.uid}, not the owner's (${uid})`;
  if ((st.mode & 0o7777) !== 0o644) return `${f} has mode ${(st.mode & 0o7777).toString(8)}, want 644`;
  if (st.nlink !== 1) return `${f} has ${st.nlink} names`;
  let t; try { t = io.readText(f); } catch { return `${f} can't be read`; }
  return t === text ? null : `${f} is not the job file this setup builds now (run owner-job place)`;
}

/** The common start: on, run as the owner (never root), the owner's user and home known. → { uid, home, file, text } or { problems }.
 *  Unload alone runs with the Dispatcher off: it is the way out after the Dispatcher's entry is gone (#502 r1 m1). */
function start(io, cfg, { off = false } = {}) {
  if (!cfg.dispatcher && !off) return { problems: [DISPATCHER_OFF] };
  const o = ownerOf(io, cfg); if (o.problem) return { problems: [o.problem] };
  const me = io.euid();
  if (me === 0) return { problems: [`the owner's answer job is the owner's own: run owner-job as ${cfg.owner}, without sudo (root never writes in the owner's home)`] };
  if (me !== o.uid) return { problems: [`owner-job runs as the owner, ${cfg.owner} (uid ${o.uid}); this is uid ${me}`] };
  return { uid: o.uid, home: o.home, file: ownerJobPath(o.home, cfg), text: ownerJobPlist(cfg, o) };
}

/** Why the job may not start now, or null: the installed copy has the node and the script the job file names. */
function copyProblem(io, cfg) {
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) return 'the install is not there yet (run the install first), so the job would start against nothing';
  for (const rel of [NODE, OWNER_SCRIPT]) { try { if (!io.lstat(join(P.installRoot, rel)).isFile()) throw new Error(); } catch { return `${join(P.installRoot, rel)} is not in the installed copy (install a copy that has it)`; } }
  return null;
}

const bootstrap = (io, cfg, s) => [
  op(`launchctl bootstrap gui/${s.uid} ${s.file}`, () => { const r = io.run(LAUNCHCTL, ['bootstrap', `gui/${s.uid}`, io.at(s.file)]); if (r.status !== 0) throw new Error(`could not load ${ownerLabel(cfg)} in gui/${s.uid} (${failText(r)}); the owner's login session must be open`); }),
  op(`read back: ${ownerLabel(cfg)} is loaded`, () => { const x = ownerJobState(io, cfg, s.uid); if (x.error || !x.loaded) throw new Error(`${ownerLabel(cfg)} is NOT loaded after the load${x.error ? ` (${x.error})` : ''}. Run: owner-job load`); }),
];
const bootout = (io, cfg, s) => op(`launchctl bootout gui/${s.uid}/${ownerLabel(cfg)}`, () => { const r = io.run(LAUNCHCTL, ['bootout', `gui/${s.uid}/${ownerLabel(cfg)}`]); if (r.status !== 0) throw new Error(`could not unload ${ownerLabel(cfg)} (${failText(r)})`); });

/** `owner-job place`: the folder and the job file; a loaded job whose file changes is loaded again from the new file. */
export function planOwnerPlace(io, cfg) {
  const s = start(io, cfg); if (s.problems) return { ops: [], problems: s.problems };
  const why = copyProblem(io, cfg); if (why) return { ops: [], problems: [why] };
  const ops = []; const dir = dirname(s.file);
  let st = null; try { st = io.lstat(dir); } catch (e) { if (e?.code !== 'ENOENT') return { ops: [], problems: [`${dir} could not be read (${e?.code ?? e})`] }; }
  if (st && (st.isSymbolicLink() || !st.isDirectory() || st.uid !== s.uid)) return { ops: [], problems: [`${dir} is not a plain folder of the owner's`] };
  if (!st) ops.push(op(`mkdir ${dir}`, () => io.mkdir(dir, 0o755)));
  if (fileProblem(io, s.file, s.text, s.uid) === null) return { ops, problems: [] };
  const state = ownerJobState(io, cfg, s.uid);
  if (state.error) return { ops: [], problems: [`could not ask launchd about ${ownerLabel(cfg)}: ${state.error}`] };
  const tmp = join(dir, `.${posix.basename(s.file)}.new`);
  ops.push(op(`write ${s.file}   (the owner's, 0644)`, () => {
    io.unlink(tmp);
    try { io.write(tmp, s.text, 0o644); io.rename(tmp, s.file); } catch (e) { try { io.unlink(tmp); } catch { /* the first error is the one */ } throw e; }
  }));
  // launchd keeps running what it first read: a loaded job is taken out and loaded again from the file as it is now.
  if (state.loaded) ops.push(bootout(io, cfg, s), ...bootstrap(io, cfg, s));
  return { ops, problems: [] };
}

/** `owner-job load`: bootstrap in the owner's session, unless loaded. */
export function planOwnerLoad(io, cfg) {
  const s = start(io, cfg); if (s.problems) return { ops: [], problems: s.problems };
  const problems = [];
  const why = copyProblem(io, cfg); if (why) problems.push(why);
  const f = fileProblem(io, s.file, s.text, s.uid); if (f) problems.push(f);
  if (problems.length) return { ops: [], problems };
  const state = ownerJobState(io, cfg, s.uid);
  if (state.error) return { ops: [], problems: [`could not ask launchd about ${ownerLabel(cfg)}: ${state.error}`] };
  return { ops: state.loaded ? [] : bootstrap(io, cfg, s), problems: [] };
}

/** `owner-job unload`: take the job out of the owner's session, if loaded. The file stays (it loads again at the next login). */
export function planOwnerUnload(io, cfg) {
  const s = start(io, cfg, { off: true }); if (s.problems) return { ops: [], problems: s.problems };
  const state = ownerJobState(io, cfg, s.uid);
  if (state.error) return { ops: [], problems: [`could not ask launchd about ${ownerLabel(cfg)}: ${state.error}`] };
  return { ops: state.loaded ? [bootout(io, cfg, s)] : [], problems: [] };
}

/**
 * The answer's rows: fresh (the owner's own plain file, not writable by others, the answer's shape, written within the Sensors'
 * time limit and not ahead of this clock), and a WARNING when it says no one is signed in or its sign-in is not known (the
 * Dispatcher then starts nothing). Read only; root or the owner may run it.
 */
export function answerRows(io, cfg, { now = Date.now() } = {}) {
  const file = answerFileOf(cfg); const what = `the owner's answer ${file} is fresh (the owner's job wrote it within ${ANSWER_STALE_MS / 60_000} minutes)`;
  const fail = (why) => [{ ok: false, what, why }];
  const o = ownerOf(io, cfg); if (o.problem) return fail(o.problem);
  // The Sensors' own rules (wiring/sensors-ports.mjs), so this check passes only where the Sensors believe the answer (#502 r1 m3).
  const dir = dirname(file);
  let ds; try { ds = io.lstat(dir); } catch (e) { return fail(`${dir} can't be read (${e?.code ?? e})`); }
  const dirBad = answerFolderProblem(ds, o.uid, dir); if (dirBad) return fail(dirBad);
  let st; try { st = io.lstat(file); } catch (e) { return fail(e?.code === 'ENOENT' ? 'it is not there: is the owner\'s job loaded (node setup.mjs owner-job check, as the owner)?' : `it can't be read (${e?.code ?? e})`); }
  if (st.isSymbolicLink()) return fail(`${file} is a link`);
  const fileBad = answerFileProblem(st, o.uid, file); if (fileBad) return fail(fileBad);
  const listed = aclProblem([io.at(dir), io.at(file)]); if (listed) return fail(listed);
  let a; try { a = JSON.parse(io.readText(file)); } catch { return fail(`${file} is not JSON`); }
  const bad = answerProblem(a, now); if (bad) return fail(`${bad}${/min old/.test(bad) ? ` (look in ~${cfg.owner}/Library/Logs/${LOG_NAME}.err.log)` : ''}`);
  const rows = [{ ok: true, what }];
  if (a.signed_in !== true) rows.push({ ok: true, warn: true, what: 'the owner\'s answer says who is signed in', why: `${a.signed_in === false ? 'it says no one is signed in' : 'it says who is signed in is not known'}${a.usage_reason ? ` (${String(a.usage_reason).slice(0, 120)})` : ''}, so the Dispatcher starts nothing until it is` });
  return rows;
}

/** `owner-job check`: the job file, the job loaded and its last run ended 0, then the answer. Read only. */
export function checkOwnerJob(io, cfg, { now = Date.now() } = {}) {
  const s = start(io, cfg);
  if (s.problems) return [{ ok: false, what: 'owner-job check runs as the owner, with the Sensors on', why: s.problems.join('; ') }];
  const f = fileProblem(io, s.file, s.text, s.uid);
  const state = ownerJobState(io, cfg, s.uid);
  const exit = state.lastExit;
  return [
    { ok: f === null, what: `${s.file} is exactly the built job file, the owner's 0644`, ...(f ? { why: f } : {}) },
    { ok: !state.error && state.loaded, what: `${ownerLabel(cfg)} is loaded in the owner's session (gui/${s.uid})`, ...(state.error || !state.loaded ? { why: state.error ?? 'it is not loaded: run owner-job load' } : {}) },
    ...(state.loaded ? [{ ok: exit === '0' || exit === '(never exited)', what: `${ownerLabel(cfg)}'s last run ended with exit 0`, ...(exit === '0' || exit === '(never exited)' ? {} : { why: `its last exit code is ${exit}; look in ${join(s.home, 'Library', 'Logs', `${LOG_NAME}.err.log`)}` }) }] : []),
    ...answerRows(io, cfg, { now }),
  ];
}
