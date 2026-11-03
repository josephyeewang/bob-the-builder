// job-config.mjs — the one checked reader for a job's config (LEAD-CALLS L253): the Dispatcher (M11 main.mjs), the
// robot job (wiring/robot-main.mjs), the Sensors loop (M12 loop.mjs) and the review runner (review-runner-main.mjs).
//
// WHY. Each of those programs imports the code file its config names (`wiring`, the runner's `budget`). A config, or a
// named file, that anyone but root or the job's own user could write would run that writer's code as the job, which
// holds the Record and, for the robot job, the write tokens. Before L253 three of the four read their config with a bare
// JSON.parse; only the review runner checked. Now all four check here, and there is no unchecked path to fall back to.
//
// WHAT. readJobConfig(file, { code }) answers the parsed config, or throws one line naming the file and the reason:
//   - the config is opened by descriptor, never through a link (O_NOFOLLOW), and checked with fstat on that descriptor:
//     a plain file, not written by group or others, owned by the copy's owner; the descriptor read is the one checked
//     (same device and inode as the name the folder checks walk);
//   - `installRoot` (in the config) is the installed copy (install-check.mjs currentCopy). Every file checked here is
//     owned by root or by the reading process's own user (`ownUid`), one of the two for all of them (L257): never the
//     owner's user unless this process is it (the owner-side runner, L248), since a worker session runs as the owner
//     (L238) and could otherwise rewrite a config an orchestrate job loads. 3 Nov's layout has root own the copy;
//   - the config and every code file it names (`code`: keys whose values are paths) are inside that copy, root's (or the
//     job user's) alone, no links, no access lists, with the copy itself walked whole (install-check.mjs installProblem);
//   - each code file is one of the copy's own code files (copyModuleProblem: not a test, not a fixture);
//   - every folder above the copy, up to /, is a plain folder of root or that user, written by no one else (a sticky
//     world-writable /tmp included: production never uses one, L257 (A)), with no access list.
// The ports (lstat, fstat, open, list, readlink, acl, ownUid) are for a test only; every production caller passes none.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { aclProblem, copyModuleProblem, currentCopy, installProblem, ownerName } from '../modules/M4-workshop/launcher/install-check.mjs';

const inside = (base, p) => { const r = relative(base, p); return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r : null; };
const READ_ID = Symbol('job config file read');

/**
 * A config file read by descriptor (never through a link) and checked on that descriptor: a plain file no one but its
 * owner writes. → { value: the parsed JSON, st: the fstat }, or throws through `fail`. Shared by readJobConfig and the
 * review runner's readConfig (L253), so no job parses a config it opened by name.
 */
export function openJobJson(file, fail, { open = openSync, fstat = fstatSync } = {}) {
  let fd; let text; let st;
  try { fd = open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    fail(e?.code === 'ELOOP' ? 'is a link (name the file itself)' : `can't be opened (${e?.code ?? e?.message ?? e})`);
  }
  try {
    st = fstat(fd);
    if (!st.isFile()) fail('is not a plain file');
    if (st.mode & 0o022) fail('can be written by group or others');
    text = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  let value; try { value = JSON.parse(text); } catch (e) { fail(`is not JSON (${e.message})`); }
  if (value && typeof value === 'object') Object.defineProperty(value, READ_ID, { value: { dev: st.dev, ino: st.ino } });
  return { value, st };
}

/** Null, or why `file` (by name, now) is not the file `config` was read from by openJobJson. */
export function readChangedProblem(file, config, { lstat = lstatSync } = {}) {
  const id = config?.[READ_ID];
  if (!id) return 'was not read by descriptor';
  let st; try { st = lstat(file); } catch { return 'went missing while it was read'; }
  return st.dev === id.dev && st.ino === id.ino ? null : 'changed while it was read';
}

/**
 * Null, or why `p`, a path inside the installed copy (installProblem has checked it is there, root's alone, no link),
 * is not one of the copy's own code files (copyModuleProblem; L132 M-1): the code a job imports from its config.
 */
export function codeFileProblem(installRoot, p, { owner = 0, lstat = lstatSync, readlink } = {}) {
  const cur = currentCopy(installRoot, { owner, lstat, ...(readlink ? { readlink } : {}) });
  if (!cur.real) return null;
  const rel = inside(installRoot, p) ?? inside(cur.real, p);
  if (rel === null) return null;
  const why = copyModuleProblem(rel.split('\\').join('/'));
  if (why) return why;
  let st; try { st = lstat(join(cur.real, rel)); } catch { return 'is missing'; }
  return st.isFile() ? null : 'is not a file';
}

/** Null, or why a folder above the copy (from `from` up to /) is not root's or `owner`'s alone. */
function aboveProblem(from, owner, { lstat, acl }) {
  const seen = [];
  for (let p = from; ; p = dirname(p)) {
    let st; try { st = lstat(p); } catch { return `${p}, above the installed copy, is missing`; }
    if (st.isSymbolicLink()) return `${p}, above the installed copy, is a link (name the copy by its real path)`;
    if (!st.isDirectory()) return `${p}, above the installed copy, is not a folder`;
    if (st.uid !== 0 && st.uid !== owner) return `${p}, above the installed copy, is owned by uid ${st.uid}, not root or ${ownerName(owner)}`;
    if (st.mode & 0o022) return `${p}, above the installed copy, can be written by group or others`;
    seen.push(p);
    if (p === dirname(p)) break;
  }
  return acl(seen);
}

/**
 * The job's config, checked (see the top of this file). `code`: the config keys naming a code file the job imports,
 * each required; `optionalCode`: the same, checked only when the config has the key. → the parsed config, or throws.
 */
export function readJobConfig(file, { code = ['wiring'], optionalCode = [], ownUid = process.getuid?.(), lstat = lstatSync, fstat = fstatSync,
  open = openSync, list = readdirSync, readlink = readlinkSync, acl = aclProblem } = {}) {
  const fail = (why) => { throw new Error(`job config ${file}: ${why}`); };
  if (typeof file !== 'string' || !isAbsolute(file)) fail('must be a full path');
  if (!Number.isInteger(ownUid)) fail('this job\'s own user id could not be read');
  const { value: c, st } = openJobJson(file, fail, { open, fstat });
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('must be a JSON object');
  if (typeof c.installRoot !== 'string' || !isAbsolute(c.installRoot)) fail('installRoot must be a full path (the installed copy the job runs from)');
  let rootSt; try { rootSt = lstat(c.installRoot); } catch { fail(`installRoot ${c.installRoot} is missing`); }
  const owner = rootSt.uid;
  if (owner !== 0 && owner !== ownUid) fail(`the installed copy ${c.installRoot} is owned by uid ${owner}, not root or this job's own user (uid ${ownUid})`);
  if (st.uid !== owner) fail(`is owned by uid ${st.uid}, not by the installed copy's owner (${ownerName(owner)})`);
  const keys = [...code, ...optionalCode.filter((k) => c[k] !== undefined)];
  for (const k of keys) if (typeof c[k] !== 'string' || !isAbsolute(c[k])) fail(`${k} must be a full path`);
  const ports = { owner, lstat, list, readlink, acl };
  const bad = installProblem(c.installRoot, [file, ...keys.map((k) => c[k])], { ...ports, top: dirname(c.installRoot) });
  if (bad) fail(bad);
  // The descriptor read must be the file the folder checks walked: no swap between the two looks.
  const swapped = readChangedProblem(file, c, { lstat });
  if (swapped) fail(swapped);
  const cur = currentCopy(c.installRoot, { owner, lstat, readlink });
  for (const k of keys) {
    const why = inside(c.installRoot, c[k]) === null && inside(cur.real, c[k]) === null ? 'is not inside the installed copy'
      : codeFileProblem(c.installRoot, c[k], { owner, lstat, readlink });
    if (why) fail(`${k}, ${c[k]}, ${why}`);
  }
  const up = dirname(dirname(c.installRoot));
  if (up !== dirname(c.installRoot)) { const a = aboveProblem(up, owner, { lstat, acl }); if (a) fail(a); }
  return c;
}
