// The setup commands' one door to the Mac: running a program, reading and changing folders, asking who is root.
// Everything the setup does to the machine goes through an `io` like this one, so a test can stand in for the Mac (a
// fake root folder prefix and a stand-in for dscl, see setup.test.mjs) and `--dry-run` can print instead of act.
//
//   io.at(path)             the real place of a logical path (prefix + path); the prefix is '' on the real Mac
//   io.readConfig(path, {strict})   the config text; strict = root's own file at the fixed place (see readConfigFile)
//   io.write/secureFile/list   make a new file (never overwrites), set a file's owner and mode, list a folder
//   io.run(cmd, args)       → { status, stdout, stderr }; a fixed PATH, no shell, a time limit
//   io.lstat/mkdir          on the logical path
//   io.secure(path, want)   set a folder's owner and mode WITHOUT following a link (L90 M4): see secureFolder
//   io.secureFile(path, want)   the same for a file: see secureFile
//   io.readText/write/copyFile/copyTree/rm/list/readlink   on the logical path (write and copyFile make a NEW file and
//                           never follow a link or overwrite: see writeNewFile)
//   io.euid()               who this process runs as
//   io.rootUid              the uid root has (0; a test stands one in)
//   io.nodeProblem()        null, or why the node running this is not one root may run (L90 minor a)
//   io.nodeBinProblem(path) the same for a node program the config names (it is copied in and root runs the copy)
//   io.readSourceStrict(path)  io.readSource's read with root's rules whoever runs it (a dry run's way to say what root would refuse)
//   io.readSource(path)     a file of this machine outside the prefix that root reads (the runner config): through one handle,
//                           never through a link, a plain file, not too big; as root also root's own and written by no one else.
//                           Errors never show a byte of the file.
//
// There is no chown or chmod here that takes a path: both follow a link, and a Mac user that owns a parent folder can
// swap a child for a link between the plan and the change. Every change opens the folder itself (O_NOFOLLOW, folder
// only), checks it is the very folder the plan saw, and changes it through that handle.

import { closeSync, constants, cpSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';

/**
 * Set the owner and mode of the folder at `real` through an open handle. Refuses a link, anything that is not a folder, and
 * (when `ino` is given) a folder other than the one the plan saw. `want` = { uid, gid?, mode, ino?, dev? }; a missing gid
 * keeps the folder's. `chown` is a port: a test cannot chown for real, and it must refuse what the real one refuses.
 */
export function secureFolder(real, want, { chown = fchownSync, chmod = fchmodSync } = {}) {
  let fd;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); } catch (e) {
    // macOS answers ENOTDIR (Linux ELOOP) for a link opened with O_NOFOLLOW|O_DIRECTORY, so look at what is there to say which.
    const isLink = e?.code === 'ELOOP' || (e?.code === 'ENOTDIR' && (() => { try { return lstatSync(real).isSymbolicLink(); } catch { return false; } })());
    throw new Error(isLink ? `${real} is now a link; nothing was changed` : e?.code === 'ENOTDIR' ? `${real} is not a folder; nothing was changed` : `${real} could not be opened (${e?.code ?? e})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`${real} is not a folder; nothing was changed`);
    if (want.ino !== undefined && (st.ino !== want.ino || st.dev !== want.dev)) throw new Error(`${real} is not the folder the plan saw (it was replaced); nothing was changed`);
    chown(fd, want.uid, want.gid ?? st.gid);
    chmod(fd, want.mode);
  } finally { closeSync(fd); }
}

/** The same for a file: refuses a link, a folder, and (when `ino` is given) a file other than the one the plan saw. */
export function secureFile(real, want, { chown = fchownSync, chmod = fchmodSync } = {}) {
  let fd;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) {
    throw new Error(e?.code === 'ELOOP' ? `${real} is now a link; nothing was changed` : `${real} could not be opened (${e?.code ?? e})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${real} is not a plain file; nothing was changed`);
    if (want.ino !== undefined && (st.ino !== want.ino || st.dev !== want.dev)) throw new Error(`${real} is not the file the plan saw (it was replaced); nothing was changed`);
    chown(fd, want.uid, want.gid ?? st.gid);
    chmod(fd, want.mode);
  } finally { closeSync(fd); }
}

/** Makes a NEW file: refuses to overwrite anything or to follow a link at the name. The caller then sets owner and mode with secureFile. */
export function writeNewFile(real, data, mode) {
  const fd = openSync(real, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); let off = 0; while (off < b.length) off += writeSync(fd, b, off, b.length - off); } finally { closeSync(fd); }
}

/**
 * The text of a config file, read through ONE open handle and never through a link (NEW-1, L100 m4). Always: a plain file,
 * not too big. `strict` (root, and the fixed config place): also root's own, written by no one else, and every folder above
 * it root's alone. Errors name the problem and never show a byte of the file (it may hold anything). `ownerOf` and `chain`
 * are ports for a test, which is not root.
 */
export function readConfigFile(real, { strict = false, rootUid = 0, top = '/', ownerOf = (st) => st.uid, chain = chainProblem, what = 'the config' } = {}) {
  let fd;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) {
    throw new Error(e?.code === 'ELOOP' ? `${what} is a link, and a link is not followed` : e?.code === 'ENOENT' ? `${what} file was not found` : `${what} could not be opened (${e?.code ?? 'error'})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${what} is not a plain file`);
    if (st.size > 65536) throw new Error(`${what} is far bigger than a config can be`);
    if (strict) {
      if (ownerOf(st) !== rootUid) throw new Error(`${what} is not owned by root, so root will not take orders from it`);
      if (st.mode & 0o022) throw new Error(`${what} can be written by others than root, so root will not take orders from it`);
      const above = chain(dirname(real), { owner: rootUid, top });
      if (above) throw new Error(`the folder ${what} is in is not root's alone (${above})`);
    }
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** Why root should not run the node program that is running now, or null: its file, and every folder above it, must be root's alone (L90 m4). */
export function nodeProblemOf(execPath, { rootUid = 0, top = '/', lstat = lstatSync, realpath = realpathSync, exact = false } = {}) {
  let real; try { real = realpath(execPath); } catch { return `could not find the real place of ${execPath}`; }
  // `exact`: a program the config NAMES is copied from that name, so the name must be the checked file itself, not a link someone can re-point (L160 m6)
  if (exact && real !== execPath) return `${execPath} is not the program's own real place (it leads to ${real}); name ${real} itself`;
  const st = (() => { try { return lstat(real); } catch { return null; } })();
  if (!st) return `${real} is missing`;
  if (st.uid !== rootUid) return `the node program ${real} is not root's`;
  if (st.mode & 0o022) return `the node program ${real} can be written by others than root`;
  const above = chainProblem(real.slice(0, real.lastIndexOf('/')) || '/', { owner: rootUid, top, lstat });
  return above ? `the node program ${real}: ${above}` : null;
}

export function realIo({ prefix = '' } = {}) {
  const at = (p) => (prefix ? join(prefix, p) : p);
  return {
    prefix,
    at,
    rootUid: 0,
    euid: () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      return { status: r.status ?? (r.error ? 127 : 1), stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
    },
    lstat: (p) => lstatSync(at(p)),
    mkdir: (p, mode) => mkdirSync(at(p), { mode }),
    secure: (p, want) => secureFolder(at(p), want),
    secureFile: (p, want) => secureFile(at(p), want),
    // The fixed config place is a logical path (under the prefix); a path the person named with --config is a real one.
    readConfig: (p, { strict = false } = {}) => readConfigFile(strict ? at(p) : p, { strict, rootUid: 0, top: prefix || '/', what: strict ? "root's setup config" : 'the setup config' }),
    nodeProblem: () => nodeProblemOf(process.execPath),
    nodeBinProblem: (p) => nodeProblemOf(p, { exact: true }),
    // The same read as root's, whoever runs it: a dry run uses it to say exactly what root would refuse.
    readSourceStrict: (p) => readConfigFile(p, { strict: true, rootUid: 0, top: '/', what: 'the runner config' }),
    readSource: (p) => readConfigFile(p, { strict: (typeof process.geteuid === 'function' ? process.geteuid() : -1) === 0, rootUid: 0, top: '/', what: 'the runner config' }),
    // For the install and the job files. `src` is a real path outside the prefix (a file of this repository, the node program).
    readText: (p) => readFileSync(at(p), 'utf8'),
    write: (p, text, mode) => writeNewFile(at(p), text, mode),
    copyFile: (src, p, mode) => writeNewFile(at(p), readFileSync(src), mode),
    copyTree: (src, p) => cpSync(src, at(p), { recursive: true, dereference: false, errorOnExist: true, force: false }),
    rm: (p) => rmSync(at(p), { recursive: true, force: true }),
    list: (p) => readdirSync(at(p)),
    readlink: (p) => readlinkSync(at(p)),
    lstatReal: (abs) => lstatSync(abs),     // a path already real (prefix included), such as one read out of a config
    listReal: (abs) => readdirSync(abs),
  };
}

/** The refusal a command that changes the Mac gives when it is not root, or null. */
export function rootProblem(io) {
  if (io.euid() !== 0) return 'this changes the Mac\'s users and root-owned folders, so it must run as root (put sudo in front of the command). Use --dry-run to see what it would do without root.';
  const n = io.nodeProblem?.();
  return n ? `root must not run a node program others can change: ${n}. Install node from nodejs.org (its installer puts it in /usr/local/bin, root's) and run this with that node's full path.` : null;
}
