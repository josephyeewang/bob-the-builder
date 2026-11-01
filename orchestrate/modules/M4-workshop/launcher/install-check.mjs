// What the installed copy must be, and the few facts about it that root's updater and the review runner both read
// (L66, item 19, L73). Root runs this file (review-updater.mjs and accounts.mjs import it), so it imports nothing but
// Node's own modules. Root runs two small module sets from the installed copy, each checked import by import in
// review-updater.test.mjs: the updater's (review-updater.mjs, this file, safe-git.mjs) and the account copy's
// (accounts.mjs and this file), and nothing else of the repository (L73 point 5, c-1).
//
// The layout (L73 point 1, L92 item 4). `installRoot` is a link, root's, in a folder only root can write. It names
// `<name>.v-<commit>/orchestrate`, inside a versioned folder beside it. The versioned folder mirrors the repository: its
// `orchestrate/` is the copy, and beside it are the few files outside orchestrate/ that the code imports (OUTSIDE_FILES,
// at their repository paths), so an import such as `../../../scripts/blueprint/yaml-lite.mjs` lands inside the versioned
// folder (Node loads a module from its real path). The commit stamp is at the top of the versioned folder. The updater makes a new versioned folder, then flips the link with one
// rename, which the system makes atomic: every path a LaunchDaemon starts from (installRoot/bin/node and the scripts)
// names a whole copy at every moment of an update, and a run cut off anywhere leaves the link on the old copy or the
// new one, never on nothing. A plain folder at installRoot is still a copy to these checks; the updater and the review
// runner refuse one (L75 c-7), since only a link can be flipped whole.
//
//   currentCopy(installRoot)            → { real, folder, link, commit } | { missing } | { problem, old? }
//   copyReady(installRoot)              → null, or why the copy is not one a LaunchDaemon may run: the link, and a
//                                         stamp that is the commit its folder is named for (L106 m-1)
//   copyPath(installRoot, cur, p)       → `p` named through the link, as the same path in the folder it names
//   installProblem(installRoot, files)  → null, or why the copy (and the folders above it) is not root's alone
//   chainProblem(path)                  → null, or why `path` and every folder above it is not root's alone
//   aclProblem(paths)                   → null, or the first path that has an access list (ACL)
//   readInstallStamp(installRoot)       → the 40-hex commit stamp, or null
//   readMainSeen(file), nextMainSeen(prev, now), behindSince(state, main) → root's record of when main moved ahead

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

// The repository folder the copy is made of, and the folder inside the versioned folder that the link names.
export const SOURCE = 'orchestrate';
// The files outside SOURCE that the installed code imports, at their repository paths (L92 item 4, the install
// closure). The updater installs exactly these beside SOURCE. review-install-closure.test.mjs installs a copy as the
// updater does, deletes the repository it came from, and imports every non-test module of the copy for real; it fails
// when any of them loads a file outside the copy, or names one in a way that only runs later (a dynamic import of a
// name made at run time, a path leading out of SOURCE) that is not listed here (L106 M-1). Copying one into orchestrate/
// instead would make two sources of it.
export const OUTSIDE_FILES = Object.freeze(['scripts/blueprint/yaml-lite.mjs']);

export const NODE = 'bin/node';
// The updater's own config and the review runner's config: two of the copy's own items (review-updater.mjs `keep`),
// at fixed names so the updater can refuse a `keep` that would drop either (L73 point 4).
export const UPDATER_CONFIG = 'updater.json';
export const RUNNER_CONFIG = 'review.json';
// The commit stamp (L66): the commit the copy was made from, 40 hex and a newline, in this file at the top of the
// versioned folder (beside SOURCE and the outside files, written after both), root's like the rest. The runner shows it in its status; the Dispatcher tells Joe when it is not main's.
export const STAMP = 'installed-commit';
// The runner's config keys that name a module the runner itself imports (L132 M-1): the wiring and the budget module.
export const RUNNER_MODULES = Object.freeze(['wiring', 'budget']);
// Each must be one of the copy's own code files from the repository: a .mjs file under one of these folders of the
// copy. A copy item the install step puts at the top of the copy (`keep`), a folder or the config is refused: the
// runner imports the module from the copy, and only a file among the copy's own finds the files it imports.
export const MODULE_HOMES = Object.freeze(['modules', 'shared']);
/** Null, or why `rel` (a path inside the copy, relative to it) is not one of the copy's own code files. */
export function copyModuleProblem(rel) {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  if (parts.length >= 2 && MODULE_HOMES.includes(parts[0]) && !parts.some((s) => s === '' || s === '.' || s === '..') && rel.endsWith('.mjs')) return null;
  return `is not one of the copy's own code files (a .mjs file under its ${MODULE_HOMES.map((h) => `${h}/`).join(' or ')} folder), so it can't find the files it loads`;
}
const HEX40 = /^[0-9a-f]{40}$/;

export function installStamp(commit) {
  if (typeof commit !== 'string' || !HEX40.test(commit)) throw new Error('the commit stamp must be a 40-hex commit');
  return `${commit}\n`;
}

/** The folder name of the copy made from `commit`, beside `installRoot`. */
export const versionName = (installRoot, commit) => `${basename(installRoot)}.v-${commit}`;
/** The commit a versioned folder's name holds, or null when the name is not one. */
export function versionCommit(installRoot, name) {
  const pre = `${basename(installRoot)}.v-`;
  return typeof name === 'string' && name.startsWith(pre) && HEX40.test(name.slice(pre.length)) ? name.slice(pre.length) : null;
}

// Whom a check wants as owner, in its messages (root, or the uid a test stands in with).
export const ownerName = (owner) => (owner === 0 ? 'root' : `uid ${owner}`);

/**
 * Where the copy is. A plain folder at installRoot is the copy itself (and its own versioned folder). A link must be
 * `owner`'s and name exactly `<name>.v-<commit>/orchestrate` (L92 item 4): a versioned folder beside it, then SOURCE,
 * nothing else (no `..`, no other folder, no deeper path). Both must be real folders, not links, and `owner`'s.
 * Nothing there → { missing }. `real` is the copy (the folder the link names); `folder` is the versioned folder that
 * holds it, the outside files and the stamp. `lstat` and `readlink` are ports for a test.
 */
export function currentCopy(installRoot, { owner = 0, lstat = lstatSync, readlink = readlinkSync } = {}) {
  let st; try { st = lstat(installRoot); } catch { return { missing: true, problem: `${installRoot} is missing` }; }
  if (st.isDirectory()) return { real: installRoot, folder: installRoot, link: false, commit: null };
  if (!st.isSymbolicLink()) return { problem: `${installRoot} is neither a folder nor the copy's link` };
  if (st.uid !== owner) return { problem: `${installRoot}, the copy's link, is not owned by ${ownerName(owner)}` };
  let to; try { to = readlink(installRoot); } catch (e) { return { problem: `${installRoot} can't be read (${e.code ?? e.message})` }; }
  const parts = String(to).split('/');
  if (parts.length === 1 && versionCommit(installRoot, parts[0]) !== null) return { problem: oldInstall(installRoot, parts[0]), old: true };
  const commit = parts.length === 2 && parts[1] === SOURCE ? versionCommit(installRoot, parts[0]) : null;
  if (commit === null) return { problem: `${installRoot} points at ${JSON.stringify(String(to).slice(0, 200))}, not ${SOURCE} in a copy folder beside it` };
  const folder = join(dirname(installRoot), parts[0]);
  const real = join(folder, SOURCE);
  for (const [p, what] of [[folder, parts[0]], [real, to]]) {
    let t; try { t = lstat(p); } catch { return { problem: `${installRoot} points at ${to}, and ${what} is missing` }; }
    if (t.isSymbolicLink() || !t.isDirectory()) return { problem: `${p}, which ${installRoot} points into, is not a folder` };
    if (t.uid !== owner) return { problem: `${p}, which ${installRoot} points into, is not owned by ${ownerName(owner)}` };
  }
  return { real, folder, link: true, commit };
}

/**
 * What Joe is told about an install from before L92 item 4, whose link names the versioned folder `v` itself (L106
 * m-3). Nothing is changed: the updater, the runner and the account copy refuse it, and the install step refuses
 * while the link is there. Removing the link (only the link: no slash at the end) lets the install step make the new
 * shape; it clears the old folder itself.
 */
export function oldInstall(installRoot, v) {
  return `${installRoot} is an install from before the copy's layout changed: its link points at the folder ${v} instead of ${v}/${SOURCE} inside it. Nothing was changed, and reviews do not start until it is put right. To put it right, remove the old link (only the link; the old folder is cleared for you), then run the Mac setup's install step again, the same step that first made this copy, which makes it in the new layout. The removal, to paste in Terminal: sudo /bin/rm ${shellQuote(installRoot)}`;
}
export const shellQuote = (p) => (/^[A-Za-z0-9_./-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`);

/**
 * The installed copy as a LaunchDaemon may run it (L106 m-1): the copy's link, not a plain folder (L75 c-7), and a
 * commit stamp that is the commit its folder is named for. A copy whose stamp is missing or another's was not
 * finished by the updater (which writes the stamp last), or was made by hand. The updater itself does not ask this:
 * it must still be able to replace such a copy. Null, or the problem. `lstat` and `readlink` are ports for a test.
 */
export function copyReady(installRoot, { owner = 0, lstat = lstatSync, readlink = readlinkSync } = {}) {
  const cur = currentCopy(installRoot, { owner, lstat, readlink });
  if (!cur.real) return cur.problem;
  if (!cur.link) return `${installRoot} is a plain folder, not the installed copy's link (the install step makes the link)`;
  const stamp = readInstallStamp(installRoot, { owner });
  if (stamp !== cur.commit) return `the copy's commit stamp (${stamp ?? `none at ${join(cur.folder, STAMP)}`}) is not the commit its folder is named for (${cur.commit})`;
  return null;
}

/**
 * `p`, named through installRoot (the copy's link), as the same path in the folder the link names now (`cur.real`,
 * from currentCopy). A path already inside cur.real, or outside the copy, comes back as it is, for the caller's
 * own check. A review session's settings name node and the hooks this way (L75 M-1): by the folder's real path, which
 * the updater keeps through one more update (review-updater.mjs `PREVIOUS`).
 */
export function copyPath(installRoot, cur, p) {
  if (typeof p !== 'string' || !cur?.real) return p;
  const rel = relative(installRoot, p);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? p : join(cur.real, rel);
}

const LS_BATCH = 200;
const ACL_LINE = /^ \d+: /;            // macOS `ls -le`: one line per access-list entry, after its file's line
const ACL_MARK = /^[-bcdlps][-rwxsStT]{9}\+/;   // other systems' `ls -l`: a `+` after the mode (macOS shows `@` instead when there are extended attributes)

function lsShowsAcl(paths, run, platform) {
  const r = run('/bin/ls', [platform === 'darwin' ? '-led' : '-ld', '--', ...paths],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { error: String(r.error?.message ?? r.stderr ?? `exit ${r.status}`).trim().slice(0, 200) };
  return { acl: String(r.stdout).split('\n').some((l) => ACL_LINE.test(l) || ACL_MARK.test(l)) };
}

/**
 * The first of `paths` that has an access list (ACL), read with /bin/ls -led (L73 point 7(c)). The mode bits the other
 * checks read don't show one, and an inherited entry can let another user write a folder whose mode says 0755. Any
 * entry is refused, even a deny: the install clears them (chmod -N). A list that can't be read is a refusal too.
 * `run` and `platform` are ports for a test.
 */
export function aclProblem(paths, { run = spawnSync, platform = process.platform } = {}) {
  for (let i = 0; i < paths.length; i += LS_BATCH) {
    const batch = paths.slice(i, i + LS_BATCH);
    const r = lsShowsAcl(batch, run, platform);
    if (r.error) return `the access lists (ACL) of ${batch[0]}${batch.length > 1 ? ' and others' : ''} could not be read: ${r.error}`;
    if (!r.acl) continue;
    for (const p of batch) {
      const one = lsShowsAcl([p], run, platform);
      if (one.error || one.acl) return `${p} has an access list (ACL), which can let others write it (clear it with chmod -N)`;
    }
    return `${batch[0]}${batch.length > 1 ? ' or another path with it' : ''} has an access list (ACL)`;
  }
  return null;
}

/**
 * `p` and every folder above it, up to and including `top`: no link, owned by `owner`, written by no one else, and no
 * access list. For git, the clone, the folders root writes in, and the updater's own config. Null, or the first
 * problem. `lstat` and `acl` are ports for a test.
 */
export function chainProblem(p, { owner = 0, top = '/', lstat = lstatSync, acl = aclProblem } = {}) {
  const seen = [];
  for (let at = p; ; at = dirname(at)) {
    let st; try { st = lstat(at); } catch { return `${at} is missing`; }
    if (st.isSymbolicLink()) return `${at} is a link`;
    if (st.uid !== owner) return `${at} is not owned by ${ownerName(owner)}`;
    if (st.mode & 0o022) return `${at} can be written by others than root`;
    seen.push(at);
    if (at === top || at === dirname(at)) break;
  }
  return acl(seen);
}

/**
 * The installed copy: every folder and file in it owned by `owner` (root) and written by no one else, no links; each
 * of `files` inside it (named through installRoot or through the folder its link names); every folder above it, up to
 * `top` (/), root's, written by no one else and not a link (item 20(b)); and none of them with an access list (L73
 * point 7(c)). When installRoot is the copy's link, the link must be root's and the walk is of the folder it names.
 * `lstat`, `list`, `readlink` and `acl` are ports so a test can stand in for root, and `top` lets a test stop in its own
 * throwaway folder. Null, or the first problem.
 */
export function installProblem(installRoot, files, { owner = 0, lstat = lstatSync, list = readdirSync, readlink = readlinkSync, acl = aclProblem, top = '/' } = {}) {
  const above = (p) => { const r = relative(top, p); return r === '..' || r.startsWith('../') || isAbsolute(r); };
  if (!isAbsolute(top) || typeof installRoot !== 'string' || !isAbsolute(installRoot) || above(installRoot)) return `${installRoot} is not under ${top}`;
  const cur = currentCopy(installRoot, { owner, lstat, readlink });
  if (cur.problem) return cur.problem;
  const real = cur.real;
  const inside = (base, f) => { const rel = relative(base, f); return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : join(real, rel); };
  for (const f of files) {
    const p = typeof f === 'string' && isAbsolute(f) ? (inside(installRoot, f) ?? inside(real, f)) : null;
    if (!p) return `${f} is not inside the installed copy ${installRoot}`;
    // Each named file itself too, so a missing one is named rather than passed over by the walk below.
    let st; try { st = lstat(p); } catch { return `${f} is missing`; }
    if (st.isSymbolicLink()) return `${f} is a link`;
    if (st.uid !== owner) return `${f} is not owned by ${ownerName(owner)}`;
    if (st.mode & 0o022) return `${f} can be written by others than root`;
  }
  // The copy's link too, when it is one: an access list on it is refused like one on any folder above (c-4).
  const seen = cur.link ? [installRoot] : [];
  for (let p = dirname(installRoot); !above(p); p = dirname(p)) {
    let st; try { st = lstat(p); } catch { return `${p}, above the installed copy, is missing`; }
    if (st.isSymbolicLink()) return `${p}, above the installed copy, is a link (name the copy by its real path)`;
    if (!st.isDirectory()) return `${p}, above the installed copy, is not a folder`;
    if (st.uid !== owner) return `${p}, above the installed copy, is not owned by ${ownerName(owner)}`;
    if (st.mode & 0o022) return `${p}, above the installed copy, can be written by others than root`;
    seen.push(p);
    if (p === top || p === dirname(p)) break;
  }
  const walk = (p) => {
    let st; try { st = lstat(p); } catch { return `${p} is missing`; }
    if (st.isSymbolicLink()) return `${p} is a link`;
    if (st.uid !== owner) return `${p} is not owned by ${ownerName(owner)}`;
    if (st.mode & 0o022) return `${p} can be written by others than root`;
    seen.push(p);
    if (!st.isDirectory()) return null;
    for (const n of list(p)) { const bad = walk(join(p, n)); if (bad) return bad; }
    return null;
  };
  // The whole versioned folder: the copy, the outside files it imports and the stamp (L92 item 4).
  return walk(cur.folder) ?? acl(seen);
}

/**
 * The installed copy's commit stamp (`STAMP`), read as root's plain file: 40 hex, or null when it is missing or not
 * root's alone (the status then shows none, and the Dispatcher tells Joe). It is read at the top of the versioned
 * folder the copy's link names (currentCopy `folder`), not inside the copy; a link of any other shape → null.
 */
export function readInstallStamp(installRoot, { owner = 0 } = {}) {
  const cur = currentCopy(installRoot, { owner });
  if (!cur.folder) return null;
  const t = readRootFile(join(cur.folder, STAMP), { owner, max: 64 });
  return t !== null && HEX40.test(t.trim()) ? t.trim() : null;
}

/** A small plain file of `owner`'s that no one else writes, as text, or null. No link at the end; a hard link can't change root's bytes. */
function readRootFile(file, { owner, max }) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== owner || st.mode & 0o022 || st.size > max) return null;
    return readFileSync(fd, 'utf8');
  } catch { return null; } finally { closeSync(fd); }
}

/**
 * Root's record of main (L73 point 7(b)), beside the copy: `{ commit, since, installed, checked_at }`, written by the
 * updater after each fetch. `commit` is main's head as the updater last fetched it, `installed` the copy's stamp after
 * that run, `checked_at` when (ms). `since` is when the updater first saw main ahead of the copy, by its own clock: it is
 * kept while the copy stays behind at the same commit, so a main that keeps moving can't keep restarting it, and it
 * never comes from a commit's date, which the commit's author sets. Anyone may read it; only root writes it.
 */
export const mainSeenFile = (installRoot) => `${installRoot}.main-seen.json`;

export function readMainSeen(file, { owner = 0, top = '/', lstat = lstatSync, acl = aclProblem } = {}) {
  const t = readRootFile(file, { owner, max: 4096 });
  if (t === null) return null;
  // Root's alone the whole way (c-5): its folder and every folder above it, and no access list on the file or on them.
  if (chainProblem(dirname(file), { owner, top, lstat, acl: (ps) => acl([file, ...ps]) })) return null;
  let s; try { s = JSON.parse(t); } catch { return null; }
  if (!s || typeof s.commit !== 'string' || !HEX40.test(s.commit)) return null;
  if (!Number.isSafeInteger(s.since) || !Number.isSafeInteger(s.checked_at)) return null;
  if (s.installed !== null && (typeof s.installed !== 'string' || !HEX40.test(s.installed))) return null;
  return { commit: s.commit, since: s.since, installed: s.installed, checked_at: s.checked_at };
}

/** The record after a run that fetched main at `commit` and left the copy at `installed` (null: none), at `now`. */
export function nextMainSeen(prev, { commit, installed, now }) {
  const behind = installed !== commit;
  const stillBehind = behind && prev && prev.installed !== prev.commit && prev.installed === installed && prev.since <= now;
  return { commit, since: stillBehind ? prev.since : now, installed: installed ?? null, checked_at: now };
}

/**
 * The `since` the Dispatcher's stamp alert waits from (M11 review-requests.mjs `mainHead`), for main at `main`: the
 * record's own `since` when the updater has seen that head; otherwise the updater's last fetch, since main moved after
 * it (an updater that stops fetching is then told once the grace is over). No record → null (told at once).
 */
export function behindSince(state, main) {
  if (!state) return null;
  return state.commit === main ? state.since : state.checked_at;
}
