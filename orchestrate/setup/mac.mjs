// The setup commands' one door to the Mac: running a program, reading and changing folders, asking who is root.
// Everything the setup does to the machine goes through an `io` like this one, so a test can stand in for the Mac (a
// fake root folder prefix and a stand-in for dscl, see setup.test.mjs) and `--dry-run` can print instead of act.
//
//   io.at(path)             the real place of a logical path (prefix + path); the prefix is '' on the Mini
//   io.run(cmd, args)       → { status, stdout, stderr }; a fixed PATH, no shell, a time limit
//   io.lstat/mkdir          on the logical path
//   io.secure(path, want)   set a folder's owner and mode WITHOUT following a link (L90 M4): see secureFolder
//   io.secureFile(path, want)   the same for a file: see secureFile
//   io.readText/write/copyFile/copyTree/rm/list/readlink   on the logical path (write and copyFile make a NEW file and
//                           never follow a link or overwrite: see writeNewFile)
//   io.euid()               who this process runs as
//   io.rootUid              the uid root has (0; a test stands one in)
//   io.nodeProblem()        null, or why the node running this is not one root may run (L90 minor a)
//
// There is no chown or chmod here that takes a path: both follow a link, and a Mac user that owns a parent folder can
// swap a child for a link between the plan and the change. Every change opens the folder itself (O_NOFOLLOW, folder
// only), checks it is the very folder the plan saw, and changes it through that handle.

import { closeSync, constants, cpSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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

/** Why root should not run the node program that is running now, or null: its file, and every folder above it, must be root's alone (L90 m4). */
/**
 * One line typed at the terminal itself (/dev/tty, so a pipe or a log cannot stand in for it) with the echo off. The text is
 * returned and nothing else ever holds it: it is not printed, and no program is given it. Echo is turned back on whatever
 * happens. Refuses (nothing read) if there is no terminal or the echo cannot be turned off.
 */
export function readSecretFromTty(prompt, { maxBytes = 1024 } = {}) {
  let fd;
  try { fd = openSync('/dev/tty', 'r+'); } catch { throw new Error('there is no terminal to type the token into; run this in the Terminal app'); }
  try {
    const stty = (arg) => spawnSync('/bin/stty', [arg], { stdio: [fd, 'ignore', 'ignore'] });
    writeSync(fd, prompt);
    if (stty('-echo').status !== 0) throw new Error('the terminal\'s echo could not be turned off, so nothing was read');
    const bytes = []; const one = Buffer.alloc(1);
    try {
      for (;;) {
        if (readSync(fd, one, 0, 1, null) !== 1) break;
        if (one[0] === 10 || one[0] === 13) break;
        if (bytes.length >= maxBytes) throw new Error('that is far longer than a token; nothing was saved');
        bytes.push(one[0]);
      }
    } finally { stty('echo'); writeSync(fd, '\n'); }
    return Buffer.from(bytes).toString('utf8');
  } finally { closeSync(fd); }
}

export function nodeProblemOf(execPath, { rootUid = 0, top = '/', lstat = lstatSync, realpath = realpathSync } = {}) {
  let real; try { real = realpath(execPath); } catch { return `could not find the real place of ${execPath}`; }
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
    nodeProblem: () => nodeProblemOf(process.execPath),
    readSecret: (prompt) => readSecretFromTty(prompt),
    // Plain fetch for the one place the setup talks to GitHub (prove-token). → { status, text }; a time limit; redirects are not followed.
    fetch: async (url, init) => { const r = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); return { status: r.status, text: await r.text() }; },
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
