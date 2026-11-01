// What the installed copy must be, and the few facts about it that root's updater and the review runner both read
// (L66, item 19, L73). Root runs this file (review-updater.mjs imports it), so it imports nothing but Node's own
// modules: root runs only the updater's own small module set, from main (L73 point 5; review-updater.test.mjs checks
// every import).
//
// The layout (L73 point 1). `installRoot` is a link, root's, in a folder only root can write. It names a folder beside
// it, `<name>.v-<commit>`, which holds the copy. The updater makes a new versioned folder, then flips the link with one
// rename, which the system makes atomic: every path a LaunchDaemon starts from (installRoot/bin/node and the scripts)
// names a whole copy at every moment of an update, and a run cut off anywhere leaves the link on the old copy or the
// new one, never on nothing. A plain folder at installRoot is still a copy to these checks; only the updater needs the
// link.
//
//   currentCopy(installRoot)            → { real, link, commit } | { missing } | { problem }
//   installProblem(installRoot, files)  → null, or why the copy (and the folders above it) is not root's alone
//   chainProblem(path)                  → null, or why `path` and every folder above it is not root's alone
//   aclProblem(paths)                   → null, or the first path that has an access list (ACL)
//   readInstallStamp(installRoot)       → the 40-hex commit stamp, or null
//   readMainSeen(file), nextMainSeen(prev, now), behindSince(state, main) → root's record of when main moved ahead

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

export const NODE = 'bin/node';
// The updater's own config and the review runner's config: two of the copy's own items (review-updater.mjs `keep`),
// at fixed names so the updater can refuse a `keep` that would drop either (L73 point 4).
export const UPDATER_CONFIG = 'updater.json';
export const RUNNER_CONFIG = 'review.json';
// The commit stamp (L66): the commit the copy was made from, 40 hex and a newline, in this file at the top of the copy,
// root's like the rest. The runner shows it in its status; the Dispatcher tells Joe when it is not main's.
export const STAMP = 'installed-commit';
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
 * Where the copy is. A plain folder at installRoot is the copy itself. A link must be `owner`'s and name a versioned
 * folder beside it (a plain name, `<name>.v-<commit>`, nothing else), which must be a folder. Nothing there →
 * { missing }. `lstat` and `readlink` are ports for a test.
 */
export function currentCopy(installRoot, { owner = 0, lstat = lstatSync, readlink = readlinkSync } = {}) {
  let st; try { st = lstat(installRoot); } catch { return { missing: true, problem: `${installRoot} is missing` }; }
  if (st.isDirectory()) return { real: installRoot, link: false, commit: null };
  if (!st.isSymbolicLink()) return { problem: `${installRoot} is neither a folder nor the copy's link` };
  if (st.uid !== owner) return { problem: `${installRoot}, the copy's link, is not owned by ${ownerName(owner)}` };
  let to; try { to = readlink(installRoot); } catch (e) { return { problem: `${installRoot} can't be read (${e.code ?? e.message})` }; }
  const commit = versionCommit(installRoot, to);
  if (commit === null) return { problem: `${installRoot} points at ${JSON.stringify(String(to).slice(0, 200))}, not a copy folder beside it` };
  const real = join(dirname(installRoot), to);
  let t; try { t = lstat(real); } catch { return { problem: `${installRoot} points at ${to}, which is missing` }; }
  if (!t.isDirectory()) return { problem: `${real}, which ${installRoot} points at, is not a folder` };
  return { real, link: true, commit };
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
  const seen = [];
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
  return walk(real) ?? acl(seen);
}

/**
 * The installed copy's commit stamp (`STAMP`), read as root's plain file: 40 hex, or null when it is missing or not
 * root's alone (the status then shows none, and the Dispatcher tells Joe). Through the copy's link, if it has one: only
 * the stamp itself may not be a link.
 */
export function readInstallStamp(installRoot, { owner = 0 } = {}) {
  const t = readRootFile(join(installRoot, STAMP), { owner, max: 64 });
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

export function readMainSeen(file, { owner = 0 } = {}) {
  const t = readRootFile(file, { owner, max: 4096 });
  if (t === null) return null;
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
