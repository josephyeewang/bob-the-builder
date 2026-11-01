// The setup commands' one door to the Mac: running a program, reading and changing folders, asking who is root.
// Everything the setup does to the machine goes through an `io` like this one, so a test can stand in for the Mac (a
// fake root folder prefix and a stand-in for dscl, see setup.test.mjs) and `--dry-run` can print instead of act.
//
//   io.at(path)             the real place of a logical path (prefix + path); the prefix is '' on the Mini
//   io.run(cmd, args)       → { status, stdout, stderr }; a fixed PATH, no shell, a time limit
//   io.lstat/mkdir/chmod/chown/readText/write/copyFile/copyTree/rm/list/readlink   on the logical path
//   io.euid()               who this process runs as
//   io.rootUid              the uid root has (0; a test stands one in)

import { chmodSync, chownSync, copyFileSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
    chmod: (p, mode) => chmodSync(at(p), mode),
    chown: (p, uid, gid) => chownSync(at(p), uid, gid),
    // For the install and the job files. `src` is a real path outside the prefix (a file of this repository, the node program).
    readText: (p) => readFileSync(at(p), 'utf8'),
    write: (p, text, mode) => { writeFileSync(at(p), text, { mode, flag: 'w' }); chmodSync(at(p), mode); },
    copyFile: (src, p, mode) => { copyFileSync(src, at(p)); chmodSync(at(p), mode); },
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
  return io.euid() === 0 ? null : 'this changes the Mac\'s users and root-owned folders, so it must run as root (put sudo in front of the command). Use --dry-run to see what it would do without root.';
}
