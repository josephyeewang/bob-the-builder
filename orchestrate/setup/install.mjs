// Setup part 2a (PR 2): the install. Makes the layout of install-check.mjs and runs the updater's first run as root.
//
//   <base>/install/                  root's folder; holds the copy's link, its versioned folders and the clone
//   <base>/install/orchestrate       the link (installRoot) → orchestrate.v-<commit>, made by the updater's --first
//   <base>/install/clone.git         the updater's own bare clone
//   <base>/install-work/             made and removed by the install: `bootstrap/` (the updater's three files) and `seed/`
//                                    (the copy's own items: bin/node, updater.json, review.json and the extras)
//
// `add-to-install` (planAddToInstall) puts the pinned Claude Code and the hooks into a copy that is already installed, in
// place: no update, no flip, no job touched. See that function.
//
// Root never runs code from a folder anyone else writes. The updater is run from `bootstrap/`, a root-owned copy of its
// three files (review-updater.mjs, install-check.mjs, safe-git.mjs: the set the updater's test pins), with a node that
// is a root-owned copy of the one running this command. The updater then writes the real copy from `main` on GitHub.
// The files copied in come from this repository's checkout, which the person running the install has chosen to trust.
// All constants (names, layout, the script paths) are imported from the launcher's own modules; none is repeated here.

import { dirname, join, posix, relative } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABEL, SCRIPTS } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { MODULE_HOMES, NODE, RUNNER_CONFIG, RUNNER_MODULES, STAMP, UPDATER_CONFIG, aclProblem, copyModuleProblem, currentCopy, installProblem, readInstallStamp } from '../modules/M4-workshop/launcher/install-check.mjs';
import { MUST_KEEP, RUNNER_NAMES, readUpdaterConfig } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { installHooks, pinnedBinary } from '../modules/M4-workshop/launcher/hooks-check.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { uidsProblem } from '../modules/M4-workshop/launcher/review-user.mjs';
import { reviewUserProblem } from '../modules/M9-record/outbox.mjs';
import { PLAN_REVIEW_ROLE, RUNNER_ROLES } from '../shared/review-roles.mjs';
import { COPY_CLAUDE_CODE as CLAUDE_CODE, COPY_HOOKS as HOOKS, parseConfig, scannerDir } from './layout.mjs';
import { parseRobot } from './robot-setup.mjs';
import { DISPATCHER_CONFIG, dispatcherConfigFor, dispatcherConfigText, dispatcherSourcePath, parseDispatcher } from './dispatcher-setup.mjs';
import { readUser } from './users-folders.mjs';
import { pinProblem } from './review-config.mjs';   // a cycle (review-config reads installPaths): both are used only when called

const HERE = dirname(fileURLToPath(import.meta.url));
const KNOWN_ROLES = Object.freeze([...new Set([...Object.keys(DESIGN_PROFILES), ...RUNNER_ROLES])]);
export const ORCH_ROOT = join(HERE, '..');   // this repository's orchestrate/ folder
// The updater's module set, relative to orchestrate/ (review-updater.mjs imports the other two by these relative paths).
const UPDATER_DIR = posix.dirname(SCRIPTS.updater);
export const BOOTSTRAP_FILES = Object.freeze([SCRIPTS.updater, posix.join(UPDATER_DIR, 'install-check.mjs'), posix.join(UPDATER_DIR, '../git/safe-git.mjs')].map((p) => posix.normalize(p)));
// The jobs' label rule is review-daemons.mjs's own (it exports it), so there is one.
export const LABEL_RE = LABEL;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/;
const PLAIN_ABS = (p) => typeof p === 'string' && p.startsWith('/') && posix.normalize(p) === p && !p.includes('\0') && !p.includes('\n') && p !== '/';
const KEEP_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;

/** Config for the install and the jobs: the setup config (layout.mjs) plus these keys. */
export function parseInstallConfig(raw) {
  const base = parseConfig(raw);
  const { address, gitBin = '/usr/bin/git', label, runnerConfig, extras = [], nodeBin = realpathSync(process.execPath), robot, dispatcher } = raw;
  if (typeof address !== 'string' || !HTTPS.test(address)) throw new Error('config: address must be the https address of the repository');
  if (!PLAIN_ABS(gitBin)) throw new Error('config: gitBin must be a full path');
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new Error('config: label must be letters, digits, . and - (it starts the jobs\' names)');
  if (!PLAIN_ABS(runnerConfig)) throw new Error('config: runnerConfig must be the full path of the review runner\'s prepared config file');
  if (!PLAIN_ABS(nodeBin)) throw new Error('config: nodeBin must be a full path');
  // A code home's name is main's alone (L257 (B)), in any case (lane 2 on #144: macOS's disk ignores case), and said so.
  const home = Array.isArray(extras) ? extras.find((e) => typeof e === 'string' && MODULE_HOMES.includes(posix.basename(e).toLowerCase())) : undefined;
  if (home) throw new Error(`config: extras must not hold ${home}: ${posix.basename(home)} is the name of a folder of the copy's own code (main's alone)`);
  if (!Array.isArray(extras) || extras.length > 20 || extras.some((e) => !PLAIN_ABS(e) || !KEEP_NAME.test(posix.basename(e)) || [...Object.keys(MUST_KEEP), STAMP, UPDATER_CONFIG, RUNNER_CONFIG, DISPATCHER_CONFIG].map((n) => n.toLowerCase()).includes(posix.basename(e).toLowerCase()))) {
    throw new Error('config: extras must be full paths of files or folders to carry into the copy (the review runner\'s claude program and its hooks), each with a plain name of its own');
  }
  // The robot job (robot-setup.mjs): on only when asked, and only with its config among the extras.
  // The Dispatcher job (dispatcher-setup.mjs): on only with its entry, which names what setup can't know itself.
  const d = parseDispatcher(dispatcher, base);
  return { ...base, address, gitBin, label, runnerConfig, extras, nodeBin, ...(parseRobot(robot, extras) ? { robot: true } : {}), ...(d ? { dispatcher: d } : {}) };
}

export function installPaths(cfg) {
  const install = join(cfg.base, 'install');
  return {
    install, installRoot: join(install, 'orchestrate'), clone: join(install, 'clone.git'), work: join(cfg.base, 'install-work'),
    bootstrap: join(cfg.base, 'install-work', 'bootstrap'), seed: join(cfg.base, 'install-work', 'seed'),
    logDir: join(cfg.base, 'logs'), accountCopy: join(cfg.base, 'account-copy.json'), reviewRoot: join(cfg.base, 'review'),
  };
}

/** The entries the install and the jobs put directly under the base, so `check` does not call them strangers (r3 n4). The scanner's folder is `scanner`'s (L1083). */
// The base dispatcher.json only with a dispatcher entry: a leftover one from a removed entry is then a stranger check names (L807 c2).
// `dispatcher`: whether the config has a dispatcher entry (check reads the config without the install's keys, so main says).
export const rootMadeEntries = (cfg, { dispatcher = cfg.dispatcher !== undefined } = {}) => { const P = installPaths(cfg); return [P.install, P.work, P.logDir, P.accountCopy, scannerDir(cfg), ...(dispatcher ? [dispatcherSourcePath(cfg)] : [])]; };

const op = (text, run) => ({ text, run });
/** Why `p` (a real path outside the prefix) cannot be carried into the copy, or null: it must exist, be a plain file or folder, and hold no link anywhere inside (the copy is root's alone and carries no links). */
function linkProblem(io, p, depth = 0) {
  let st; try { st = io.lstatReal(p); } catch (e) { return e?.code === 'ENOENT' ? 'does not exist' : `could not be read (${e?.code ?? 'error'})`; }
  if (st.isSymbolicLink()) return depth === 0 ? 'is a link (a shortcut). Name the real file it points to; the install does not carry links in' : `${p} is a link inside it; the install does not carry links in`;
  if (st.isDirectory()) {
    if (depth > 8) return 'is nested too deeply';
    for (const n of io.listReal(p)) { const why = linkProblem(io, join(p, n), depth + 1); if (why) return why; }
  } else if (!st.isFile()) return 'is neither a plain file nor a folder';
  return null;
}
// Owner and mode are set through an open handle (never by path, which would follow a link): a folder or a file, root:wheel.
const rootOwned = (io, p, mode, kind = 'file') => [op(`set owner and mode of ${p}: chown 0:0, chmod ${mode.toString(8)}`, () => { const want = { uid: io.rootUid, gid: 0, mode }; if (kind === 'dir') io.secure(p, want); else io.secureFile(p, want); })];

/** Every file and folder under `p` made root's, with no write for group or other (the copy is root's alone). A folder is locked
 *  before anything inside it is touched; a link anywhere in it is refused. */
function ownTree(io, p) {
  const st = io.lstat(p);
  if (st.isSymbolicLink()) throw new Error(`${p} is a link, which the install does not carry in`);
  if (st.isDirectory()) {
    io.secure(p, { uid: io.rootUid, gid: 0, mode: 0o755 });
    for (const n of io.list(p)) ownTree(io, join(p, n));
  } else io.secureFile(p, { uid: io.rootUid, gid: 0, mode: (st.mode & 0o111) ? 0o755 : 0o644 });
}

/** The updater's own config, as the copy keeps it. Paths are the ones the updater will see (io.at). */
export function updaterConfigFor(io, cfg) {
  const P = installPaths(cfg);
  return { installRoot: io.at(P.installRoot), clone: io.at(P.clone), address: cfg.address, keep: ['bin', UPDATER_CONFIG, RUNNER_CONFIG, ...(cfg.dispatcher ? [DISPATCHER_CONFIG] : []), ...cfg.extras.map((e) => posix.basename(e))], gitBin: cfg.gitBin };
}

/**
 * The names this setup's updater config keeps (updaterConfigFor) that the installed copy's updater does not: [] when it keeps
 * them all, null when there is no copy or its updater.json can't be read. The keep list is fixed when the copy is first
 * installed, so a file set up later (dispatcher.json, robot.json, another extra) is never carried into the copy, and the
 * next update would drop one put there by hand (L1029; the 12 Nov rehearsal's bug B).
 */
export function keepsNot(io, cfg) {
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) return null;
  let keep; try { keep = JSON.parse(io.readText(join(P.installRoot, UPDATER_CONFIG)))?.keep; } catch { return null; }
  if (!Array.isArray(keep)) return null;
  return updaterConfigFor(io, cfg).keep.filter((n) => !keep.includes(n));
}
/** How a copy whose keep list lacks a name is put right: the one statement, said by install and dispatcher-config (L1029). */
export const reinstallSteps = (cfg) => `install again, before the pinned Claude Code and add-to-install (a new install throws both away): unload the jobs (sudo node setup.mjs daemons unload), remove ${installPaths(cfg).install}, put the --for-install review.json at runnerConfig, run install, then put the full review.json back and run add-to-install (README, part 6)`;
/** The warning for a copy that does not keep `names`. */
export const keepsNotWarning = (cfg, names) => `the installed copy's updater does not keep ${names.join(', ')} (its keep list is fixed at the first install), so the copy never gets ${names.length > 1 ? 'them' : 'it'} and an update would drop ${names.length > 1 ? 'them' : 'it'}: ${reinstallSteps(cfg)}`;

/**
 * The runner config, read and checked: it must name this copy, the copy's own code by its place from main, and every other path
 * inside one of the `carried` top-level items. Adds to `problems`; never quotes the file. → { rc, rcText }.
 */
function readRunnerConfig(io, cfg, { readSource, carried, problems }) {
  const P = installPaths(cfg);
  let rc; let rcText = null;
  try { rcText = readSource(cfg.runnerConfig); } catch (e) { problems.push(`${e.message} (${cfg.runnerConfig})`); }   // the reader's messages never quote the file
  let parsed = false;
  if (rcText !== null) { try { rc = JSON.parse(rcText); parsed = true; } catch { problems.push(`the runner config ${cfg.runnerConfig} is not valid JSON`); } }   // never the parser's message: it quotes the file
  // null, 0, false and "" are JSON too, and a test for truth would let them skip every check below (#243 r1 Minor 1).
  if (parsed && (rc === null || typeof rc !== 'object')) { problems.push(`the runner config ${cfg.runnerConfig} must be one JSON object`); rc = undefined; }
  if (rc && rc.installRoot !== io.at(P.installRoot)) problems.push(`the runner config's installRoot must be ${io.at(P.installRoot)}`);
  if (rc) { const why = runnerUidsProblem(io, rc.uids); if (why) problems.push(why); }   // L726: the role-to-user map, for an install and an add alike
  const names = rc ? RUNNER_NAMES.filter((n) => typeof rc[n] === 'string') : [];
  const inCopy = io.at(P.installRoot);
  for (const n of names) {
    if (RUNNER_MODULES.includes(n)) {   // the wiring and the budget module are the copy's own code files from main, never extras (#82)
      const rel = rc[n].startsWith(`${inCopy}/`) ? rc[n].slice(inCopy.length + 1) : null;
      const why = rel === null ? `is not inside ${inCopy}` : copyModuleProblem(rel);
      if (why) problems.push(`the runner config's ${n} (${rc[n]}) ${why}; name it ${inCopy}/modules/... (the first update would refuse it)`);
    } else if (!carried.some((c) => rc[n] === `${inCopy}/${c}` || rc[n].startsWith(`${inCopy}/${c}/`))) problems.push(`the runner config's ${n} (${rc[n]}) is not inside any of the extras the copy carries, so the first update would refuse it`);
  }
  return { rc, rcText };
}

/**
 * L726: the runner config's role-to-user map (`uids`), written by hand, must name every role the runner checks
 * (M4's uidsProblem with the plan reviewer asked for: the design table and RUNNER_ROLES), and every role the runner starts
 * must name the one `review` user, review's own uid. Each runner role also passes M9's reviewUserProblem, the rule the runner
 * applies when it starts a session (not root, not shared with another role), and no other role may be root (L737 m1). A map
 * without plan_reviewer would make the runner refuse every plan review on the Mini. When the review user can't be read the
 * map can't be checked, and that is said, never passed (L737 m2). Null, or what to put right (never quoting the file).
 */
export function runnerUidsProblem(io, uids) { return runnerUids(io, uids).why; }

/**
 * runnerUidsProblem's answer with `unknownOnly`: true when the one thing wrong is a key no role is called, which the runner
 * does not read as a role (check-install says so as a WARNING). A flag, never a match on the message, which quotes the
 * keys as typed. A key no role is called that carries review's id is not harmless: the runner counts it as a second role
 * sharing the review user and refuses every review (M9 reviewUid reads the whole map), so that FAILS.
 */
function runnerUids(io, uids) {
  const said = (why) => ({ why, unknownOnly: false });
  const fix = 'add each as "<role>": <its Mac user id> (every role the runner starts names review\'s)';
  const why = uidsProblem(uids, { plan: true }); if (why) return said(`review.json: ${why}; ${fix}`);
  const unknown = Object.keys(uids).filter((k) => !KNOWN_ROLES.includes(k));
  const extra = unknown.length ? ` (it also names ${unknown.join(', ')}, which no role is called)` : '';
  const ids = new Set(RUNNER_ROLES.map((r) => uids[r]));
  if (ids.size !== 1) return said(`review.json: ${RUNNER_ROLES.join(', ')} must all name the one review user's id${extra}`);
  const known = Object.fromEntries(Object.entries(uids).filter(([k]) => KNOWN_ROLES.includes(k)));   // a misspelt key is named below, never read as a role
  for (const r of RUNNER_ROLES) { const bad = reviewUserProblem(known, r); if (bad) return said(`review.json: ${r}: ${bad}; every role the runner starts names review's id, which no other role names${extra}`); }
  const root = Object.keys(uids).filter((k) => uids[k] === 0);
  if (root.length) return said(`review.json: ${root.join(', ')} may not be root (0); name the owner's id${extra}`);
  const review = readUser(io, 'review');
  if (!review.exists) return said(`review.json: couldn't read the review user (${review.error ?? 'there is no Mac user called review'}), so the map can't be checked against it; run users-folders first, then this again`);
  if (uids[RUNNER_ROLES[0]] !== review.uid) return said(`review.json: ${RUNNER_ROLES.join(', ')} must name ${review.uid}, review's id${extra}`);
  const sharing = unknown.filter((k) => uids[k] === review.uid);
  if (sharing.length) return said(`review.json: it names ${sharing.join(', ')}, which no role is called, with review's id ${review.uid}; the runner reads that as another role sharing the review user and refuses every review; take ${sharing.length > 1 ? 'them' : 'it'} out or fix the spelling`);
  if (!unknown.length) return { why: null, unknownOnly: false };
  return { why: `review.json: it names ${unknown.join(', ')}, which no role is called; take ${unknown.length > 1 ? 'them' : 'it'} out or fix the spelling`, unknownOnly: true };
}

/**
 * L737 M1: an install made before the plan reviewer existed has a copy whose review.json leaves out only plan_reviewer, and
 * the updater carries that file forward on every update. check-install says so as a WARNING, not a FAIL, so the jobs still
 * load (the runner still does reviews and audits; it refuses plan reviews). Anything else wrong with the map stays a FAIL.
 * Null (the map does not lack only plan_reviewer), { warn } with the steps that put it right, or { fail } when the rest
 * of that old map is wrong too (the other problem first: adding plan_reviewer alone would not put it right).
 */
export function planReviewerOnlyMissing(io, uids, installRoot) {
  if (!uids || typeof uids !== 'object' || (Number.isInteger(uids[PLAN_REVIEW_ROLE]) && uids[PLAN_REVIEW_ROLE] >= 0) || uidsProblem(uids) !== null) return null;
  const rest = runnerUids(io, { ...uids, [PLAN_REVIEW_ROLE]: uids[RUNNER_ROLES[0]] });
  if (rest.why !== null && !rest.unknownOnly) return { fail: `${rest.why} (it also leaves out ${PLAN_REVIEW_ROLE})` };
  const also = rest.unknownOnly ? `. Also, ${rest.why.replace(/^review\.json: /, '')}` : '';
  return { warn: `the copy's review.json leaves out ${PLAN_REVIEW_ROLE}, so the runner refuses every plan review (reviews and audits still run). `
    + `Re-running install does not change it (the copy is kept, and every update carries its review.json forward). To put it right: add "${PLAN_REVIEW_ROLE}": <review's id> `
    + `to the uids of your checked review.json, then sudo install -o root -g wheel -m 0644 <that file> ${installRoot}/${RUNNER_CONFIG}, then check-install again${also}` };
}

/**
 * What the install does: { ops, problems, installed }. Reads only. `readSource(path)` reads a file of this machine outside
 * the prefix (the runner config) and `runUpdater(io, {node, script, config, seed})` is the updater's first run (ports for a test).
 */
export function planInstall(io, cfg, { readSource, runUpdater }) {
  const P = installPaths(cfg); const ops = []; const problems = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (!cur.missing) {
    const why = cur.problem ?? (cur.link ? null : 'is a plain folder, not the link the updater flips');
    if (why) problems.push(`${P.installRoot}: ${why}. Nothing was changed`);
    // A copy made before something this setup now carries (the Dispatcher's config, the robot's, another extra): install does
    // nothing, so say what it would take (L1029).
    const missing = why ? null : keepsNot(io, cfg);
    return { ops, problems, installed: !why, warnings: missing?.length ? [keepsNotWarning(cfg, missing)] : [] };
  }
  const { rcText } = readRunnerConfig(io, cfg, { readSource, carried: cfg.extras.map((e) => posix.basename(e)), problems });
  // Everything root would copy in is checked NOW, before any root step (L149 m4, m6): a linked program or a node root may not run
  // used to fail only after the install had made its folders and run the updater.
  const nodeWhy = io.nodeBinProblem(cfg.nodeBin); if (nodeWhy) problems.push(`nodeBin ${cfg.nodeBin}: ${nodeWhy}. Leave nodeBin out of the config to use the node running this command`);
  for (const e of cfg.extras) { const why = linkProblem(io, e); if (why) problems.push(`the extra ${e}: ${why}`); }
  // The Dispatcher's config (dispatcher-setup.mjs): written first by dispatcher-config, root's in the base, and still what this setup writes.
  let dText = null;
  if (cfg.dispatcher) {
    const built = dispatcherConfigFor(io, cfg); const src = dispatcherSourcePath(cfg);
    let st = null; try { st = io.lstat(src); } catch { /* below */ }
    let have = null; if (st && st.isFile() && !st.isSymbolicLink() && st.uid === io.rootUid && (st.mode & 0o7777) === 0o644 && st.nlink === 1) { try { have = io.readText(src); } catch { /* below */ } }
    if (built.problems.length) problems.push(...built.problems);
    else if (have !== dispatcherConfigText(built.config)) problems.push(`${src} is not there, not root's 0644, or not the config this setup writes now: run dispatcher-config first`);
    else dText = have;
  }
  if (problems.length) return { ops, problems, installed: false };

  const dir = (p, mode, text) => [op(text ?? `mkdir ${p}`, () => { try { io.mkdir(p, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; } }), ...rootOwned(io, p, mode, 'dir')];
  ops.push(...dir(P.install, 0o755), op(`rm -rf ${P.work}   (leftovers of a cut-off install)`, () => io.rm(P.work)), ...dir(P.work, 0o755), ...dir(P.bootstrap, 0o755), ...dir(P.seed, 0o755));
  const made = new Set();
  const dirs = (root, rel) => { const parts = posix.dirname(rel).split('/').filter((x) => x !== '.'); let at = root; return parts.flatMap((x) => { at = join(at, x); if (made.has(at)) return []; made.add(at); return dir(at, 0o755); }); };
  for (const f of BOOTSTRAP_FILES) ops.push(...dirs(P.bootstrap, f), op(`copy ${f} → ${join(P.bootstrap, f)}`, () => io.copyFile(join(ORCH_ROOT, f), join(P.bootstrap, f), 0o644)), ...rootOwned(io, join(P.bootstrap, f), 0o644));
  ops.push(...dir(join(P.seed, 'bin'), 0o755), op(`copy node ${cfg.nodeBin} → ${join(P.seed, NODE)}`, () => io.copyFile(cfg.nodeBin, join(P.seed, NODE), 0o755)), ...rootOwned(io, join(P.seed, NODE), 0o755));
  const uc = updaterConfigFor(io, cfg);
  ops.push(op(`write ${join(P.seed, UPDATER_CONFIG)}`, () => io.write(join(P.seed, UPDATER_CONFIG), `${JSON.stringify(uc, null, 1)}\n`, 0o644)), ...rootOwned(io, join(P.seed, UPDATER_CONFIG), 0o644));
  ops.push(op(`copy ${cfg.runnerConfig} → ${join(P.seed, RUNNER_CONFIG)}`, () => io.write(join(P.seed, RUNNER_CONFIG), rcText, 0o644)), ...rootOwned(io, join(P.seed, RUNNER_CONFIG), 0o644));
  if (dText !== null) ops.push(op(`copy ${dispatcherSourcePath(cfg)} → ${join(P.seed, DISPATCHER_CONFIG)}`, () => io.write(join(P.seed, DISPATCHER_CONFIG), dText, 0o644)), ...rootOwned(io, join(P.seed, DISPATCHER_CONFIG), 0o644));
  for (const e of cfg.extras) { const to = join(P.seed, posix.basename(e)); ops.push(op(`copy ${e} → ${to}`, () => { io.copyTree(e, to); ownTree(io, to); })); }
  ops.push(op(`run the updater's first run as root: ${join(P.seed, NODE)} ${join(P.bootstrap, SCRIPTS.updater)} ${join(P.seed, UPDATER_CONFIG)} --first ${P.seed}`, () => {
    const r = runUpdater(io, { node: join(P.seed, NODE), script: join(P.bootstrap, SCRIPTS.updater), config: join(P.seed, UPDATER_CONFIG), seed: P.seed });
    if (r.status !== 0) throw new Error(`the updater's first run failed (exit ${r.status}): ${String(r.stderr).trim().slice(-300)}`);
  }), op(`rm -rf ${P.work}`, () => io.rm(P.work)));
  return { ops, problems, installed: false };
}

const fingerprint = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ADDING = '.adding';

/**
 * Puts the pinned Claude Code and the hook scripts into the copy that is installed now, adds both to the updater's `keep`, and
 * replaces the copy's review.json with the prepared runner config, checked as `install` checks it (L573). The review runner refuses a program or hook folder outside the copy, and the install carries extras only on its
 * first run. Writes only in the real folder (never through the link, so a flip can't redirect it): `claude-code/`, `hooks/`,
 * `updater.json` and `review.json`. Everything is made under a temporary name first and review.json goes last, so a cut-off
 * run leaves the copy working, and a second run finishes it. No update, no flip, no launchctl, no job file: what the
 * watch-only job runs stays byte for byte as it was.
 * The hooks come from the copy's own modules, so they match it. `keep` carries them across an update as they are: when an
 * update changes a hook, launch check 7 refuses by name until this runs again.
 */
export function planAddToInstall(io, cfg, { pin, sha256, readSource }) {
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing) return { ops: [], problems: [`${P.installRoot} is not installed yet: run install first. Nothing was changed`], installed: false };
  const why = cur.problem ?? (cur.link ? null : 'is a plain folder, not the link the updater flips');
  if (why) return { ops: [], problems: [`${P.installRoot}: ${why}. Nothing was changed`], installed: false };

  const copy = join(P.install, relative(realpathSync(io.at(P.install)), cur.real));   // the real folder, by its own name: the link can't redirect a step
  const inCopy = io.at(P.installRoot);
  const source = pinnedBinary(cfg.base, pin);
  const hookSource = join(copy, 'modules/M4-workshop/hooks');
  const problems = [];
  // The pin the role tool lists were checked on, as review-config asks (#243 audit m1): found here, not when the runner starts.
  const pinWhy = pinProblem(pin); if (pinWhy) problems.push(pinWhy);
  // The fingerprint is refused here when it is missing or malformed, by a caller that skipped parsing too (#243 audit c2):
  // every refusal comes before any change, never only at the copy step.
  const shaOk = typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256);
  if (!shaOk) problems.push('add-to-install needs --sha256: the pinned program\'s fingerprint, 64 lower-case hex characters');
  const link = linkProblem(io, io.at(source));
  if (link) problems.push(`the pinned program ${source} ${link}`);
  else if (shaOk && fingerprint(readFileSync(io.at(source))) !== sha256) problems.push(`the pinned program ${source} does not have the fingerprint given`);
  let keep = null; let scripts = [];
  try { keep = readUpdaterConfig(io.at(join(copy, UPDATER_CONFIG))); } catch (e) { problems.push(`the copy's ${UPDATER_CONFIG} was refused: ${e.message}`); }
  try { scripts = io.list(hookSource); } catch { /* reported below */ }
  if (!scripts.length) problems.push(`the copy has no hook scripts at ${hookSource}`);
  // What the updater already carries counts too: the bob step's list (bobManifest, L1035 m1) is one of keep once it ran.
  const { rc, rcText } = readRunnerConfig(io, cfg, { readSource, carried: [CLAUDE_CODE, HOOKS, ...(Array.isArray(keep?.keep) ? keep.keep : [])], problems });
  if (rc && typeof rc === 'object') {
    const want = { pin, claudeBin: pinnedBinary(inCopy, pin), hooksDir: join(inCopy, HOOKS) };
    for (const [k, v] of Object.entries(want)) if (rc[k] !== v) problems.push(`the runner config's ${k} must be ${v}`);
    // The copy is here to look in: a wiring or budget it does not hold would pass the plan and fail only after every step (#243 r1 Minor 2).
    for (const n of RUNNER_MODULES) {
      if (typeof rc[n] !== 'string' || !rc[n].startsWith(`${inCopy}/`)) continue;   // its form was refused above
      let st = null; try { st = io.lstatReal(io.at(join(copy, rc[n].slice(inCopy.length + 1)))); } catch { /* missing */ }
      if (!st?.isFile()) problems.push(`the runner config's ${n} (${rc[n]}) is not a file in the copy`);
    }
  }
  if (problems.length) return { ops: [], problems, installed: false };

  const temp = (n) => join(copy, `${n}${ADDING}`);
  const made = join(temp(CLAUDE_CODE), pin, 'claude');
  const updater = { ...keep, keep: [...new Set([...keep.keep, CLAUDE_CODE, HOOKS])] };
  const newFile = (n, text) => [op(`write ${temp(n)}`, () => io.write(temp(n), text, 0o644)), ...rootOwned(io, temp(n), 0o644)];
  const swapIn = (n) => [
    op(`rm -rf ${join(copy, n)}`, () => io.rm(join(copy, n))),
    op(`rename ${temp(n)} → ${join(copy, n)}`, () => io.rename(temp(n), join(copy, n))),
  ];
  const ops = [
    op(`rm -rf ${copy}/*${ADDING}   (leftovers of a cut-off run)`, () => { for (const n of [CLAUDE_CODE, HOOKS, UPDATER_CONFIG, RUNNER_CONFIG]) io.rm(temp(n)); }),
    op(`mkdir ${dirname(made)}`, () => { io.mkdir(temp(CLAUDE_CODE), 0o755); io.mkdir(dirname(made), 0o755); }),
    op(`copy ${source} → ${made}`, () => {
      io.copyFile(io.at(source), made, 0o755);
      if (fingerprint(readFileSync(io.at(made))) !== sha256) throw new Error(`the copy at ${made} does not have the fingerprint given`);
    }),
    op(`set owner and mode of ${temp(CLAUDE_CODE)}`, () => ownTree(io, temp(CLAUDE_CODE))),
    op(`copy the hook scripts of ${hookSource} → ${temp(HOOKS)}`, () => { installHooks(io.at(temp(HOOKS)), io.at(hookSource)); ownTree(io, temp(HOOKS)); }),
    ...newFile(UPDATER_CONFIG, `${JSON.stringify(updater, null, 1)}\n`),
    ...newFile(RUNNER_CONFIG, rcText),
    ...swapIn(CLAUDE_CODE), ...swapIn(HOOKS),
    op(`rename ${temp(UPDATER_CONFIG)} → ${join(copy, UPDATER_CONFIG)}`, () => io.rename(temp(UPDATER_CONFIG), join(copy, UPDATER_CONFIG))),
    op(`rename ${temp(RUNNER_CONFIG)} → ${join(copy, RUNNER_CONFIG)}   (last: it names the two above)`, () => io.rename(temp(RUNNER_CONFIG), join(copy, RUNNER_CONFIG))),
  ];
  return { ops, problems: [], installed: true };
}

/** The real first run: a child process, no shell, the paths as arguments. */
export function updaterCommand(io, { node, script, config, seed }) {
  return { file: io.at(node), args: [io.at(script), io.at(config), '--first', io.at(seed)], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } };
}
export function spawnUpdater(io, spec) {
  const c = updaterCommand(io, spec);
  const r = spawnSync(c.file, c.args, { encoding: 'utf8', env: c.env, timeout: 600_000 });
  return { status: r.status ?? 1, stderr: String(r.stderr ?? r.error?.message ?? '') };
}

/** Every folder in the copy and above it, to the top: all that must be root's alone (and without an access list). */
function folderList(io, cfg) {
  const P = installPaths(cfg); const out = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  const top = io.prefix || '/';
  for (let p = io.at(dirname(P.installRoot)); ; p = dirname(p)) { out.push(p); if (p === top || p === dirname(p)) break; }
  if (cur.real) {
    out.push(io.at(P.installRoot));
    const walk = (d) => { out.push(d); for (const n of io.listReal(d)) { const q = join(d, n); if (io.lstatReal(q).isDirectory()) walk(q); } };
    walk(cur.real);
  }
  return out;
}

/**
 * Read only → [{ ok, what, why? }]. `main` is a commit the stamp must equal, when the caller knows it. `watchOnly` checks only
 * what the hourly watch job uses (L1026): the copy whole and root's, its stamp, no access lists, review.json readable and
 * naming this copy. It leaves out the review runner's role-to-user map (L726) and the runner's files (RUNNER_NAMES), which
 * the full review.json brings on cutover night; the watch job never starts the runner. Every other caller keeps the full check.
 */
export function checkInstall(io, cfg, { main = null, watchOnly = false } = {}) {
  const P = installPaths(cfg); const out = [];
  const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const top = io.prefix || '/';
  const root = io.at(P.installRoot);
  const cur = currentCopy(root, { owner: io.rootUid });
  item(!cur.missing && !cur.problem && cur.link, `${P.installRoot} is root's link to a ${posix.basename(P.installRoot)}.v-<commit> folder beside it`, cur.problem ?? 'is not a link');
  if (!cur.link) return out;
  const files = [NODE, UPDATER_CONFIG, RUNNER_CONFIG].map((n) => join(root, n));
  const bad = installProblem(root, files, { owner: io.rootUid, top });
  item(bad === null, 'the copy and every folder above it are root\'s, written by no one else, no links', bad);
  const stamp = readInstallStamp(root, { owner: io.rootUid });
  item(stamp !== null, `the commit stamp (${STAMP}) is there and root's`, 'missing or not root\'s alone');
  if (main) item(stamp === main, 'the stamp is main\'s commit', `stamp ${stamp ?? 'none'}, main ${main}`);
  const dirs = folderList(io, cfg);
  const acl = aclProblem(dirs);
  item(acl === null, `none of the ${dirs.length} install folders has an access list`, acl);
  let rc = null; try { rc = JSON.parse(io.readText(join(P.installRoot, RUNNER_CONFIG))); } catch { /* reported below */ }
  item(rc !== null && rc.installRoot === root, 'the copy\'s review.json is JSON and names this copy', 'unreadable or names another installRoot');
  if (watchOnly) return out;
  if (rc !== null) {
    const what = 'review.json names a Mac user for every role, and every role the runner starts (the plan reviewer too) names review';
    const old = planReviewerOnlyMissing(io, rc.uids, P.installRoot);
    // A key no role is called, with every real key right, is a WARNING, so the jobs still load: the runner does not read it
    // as a role (unless it carries review's id, which runnerUids FAILS).
    const now = old?.warn || old?.fail ? null : runnerUids(io, rc.uids);
    if (old?.warn || now?.unknownOnly) out.push({ ok: true, warn: true, what, why: old?.warn ?? now.why }); else item((old?.fail ?? now.why) === null, what, old?.fail ?? now.why);
  }
  for (const n of RUNNER_NAMES) if (rc && typeof rc[n] === 'string') { let here = true; try { io.lstatReal(rc[n]); } catch { here = false; } item(here, `review.json's ${n} exists in the copy`, `${rc[n]} is missing`); }
  return out;
}
