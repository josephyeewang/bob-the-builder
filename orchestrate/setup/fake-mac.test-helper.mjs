// A stand-in for the Mac, for the setup tests: a throwaway folder as the root prefix, an in-memory user directory that
// answers like dscl and dseditgroup, and folder owners kept in a table (a test is not root, so it cannot chown for real).
// A stand-in refuses what the real tool refuses (L-brief): dscl writes need root, a path outside /Users and /Groups is
// invalid, a write with no value is a bad call, a record that is not there reads as exit 56; chown needs root; mkdir
// needs the parent and refuses an existing folder (those two are the real mkdir's own refusals, since it is the real one).

import { realpathSync, fchmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { tempDir } from '../shared/test-tmp.mjs';
import { readConfigFile, secureFile, secureFolder, writeNewFile } from './mac.mjs';

// The stand-in runs the Mac's own `ls -le` and `chmod +a` for the access-list items. A machine that is not a Mac (the Linux
// check on GitHub) has neither, so a test that reaches them is SKIPPED with the reason on show, never passed; the macOS job
// (.github/workflows/scripts-ci.yml, guarded by ci-job.test.mjs) runs every one of them. SETUP_FORCE_NOT_MAC=1 makes a Mac
// behave like that machine, to see which tests skip.
export const NEEDS_MAC = 'needs macOS tools; run by the macOS job';
export const notMac = () => process.platform !== 'darwin' || process.env.SETUP_FORCE_NOT_MAC === '1';
let hitMacTool = false;
/** `test`, except a test that needed a Mac tool this machine lacks is skipped (said aloud) instead of failing. */
export function macTest(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return test(name, opts, async (t) => {
    hitMacTool = false;
    try { await fn(t); } catch (e) { if (hitMacTool) { t.skip(NEEDS_MAC); return; } throw e; }
  });
}

export function fakeMac({ euid: as = 0, users = {}, admins = [] } = {}) {
  const prefix = realpathSync(tempDir('orch-setup-mac-'));
  const mac = {
    as, prefix, rootUid: process.getuid(),
    users: new Map(Object.entries({ sam: { UniqueID: '65001', PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/sam' }, ...users })),
    groups: new Map([['staff', { PrimaryGroupID: '20' }], ['admin', { PrimaryGroupID: '80' }]]),
    admins: new Set(admins),
    owners: new Map(),          // logical path → { uid, gid } set by chown
    log: [],                    // every changing call, in order
    failNextDsclCreate: false,  // a test sets this to make the next dscl -create fail once
    sudoRules: new Set(),       // users a sudo rule names (`sudo -l -U` then says they may run sudo)
    nodeProblemText: null,      // a test sets this to make the node program look like one root must not run
    aclPrincipals: { orchestrate: 'daemon' },   // access-list names that exist only on the always-on Mac are stood in for by a real user here
  };
  const at = (p) => join(prefix, p);
  mkdirSync(at('/Library'), { recursive: true });
  const dscl = (args) => {
    const [flag, path, ...rest] = args;
    const m = /^\/(Users|Groups)(?:\/([A-Za-z0-9_.-]+))?$/.exec(path ?? '');
    if (!m) return { status: 40, stdout: '', stderr: '<dscl_cmd> DS Error: -14009 (eDSUnknownNodeName)' };
    const table = m[1] === 'Users' ? mac.users : mac.groups; const name = m[2];
    if (flag === '-list') {
      const key = rest[0];
      return { status: 0, stdout: [...table].map(([n, a]) => `${n}  ${a[key] ?? ''}`).join('\n') + '\n', stderr: '' };
    }
    if (flag === '-read') {
      if (!name || !table.has(name)) return { status: 56, stdout: '', stderr: '<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)' };
      const a = table.get(name);
      // the real dscl says "No such key" on stderr and exits 0
      // The password hash is readable by root only: for anyone else the real dscl answers as if it were not there.
      const seen = (k) => a[k] !== undefined && !(k === 'ShadowHashData' && mac.as !== 0);
      return { status: 0, stdout: rest.filter(seen).map((k) => `${k}: ${a[k]}\n`).join(''), stderr: rest.filter((k) => !seen(k)).map((k) => `No such key: ${k}\n`).join('') };
    }
    if (flag === '-create') {
      if (mac.as !== 0) return { status: 40, stdout: '', stderr: '<main> attribute status: eDSPermissionError\n<dscl_cmd> DS Error: -14120 (eDSPermissionError)' };
      if (!name) return { status: 40, stdout: '', stderr: '<dscl_cmd> DS Error: -14009 (eDSUnknownNodeName)' };
      if (rest.length === 1) return { status: 40, stdout: '', stderr: 'Create: Invalid number of arguments' };
      if (mac.failNextDsclCreate) { mac.failNextDsclCreate = false; return { status: 1, stdout: '', stderr: 'injected failure' }; }
      mac.log.push(`dscl ${args.join(' ')}`);
      if (!table.has(name)) table.set(name, {});
      if (rest.length) table.get(name)[rest[0]] = rest.slice(1).join(' ');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 40, stdout: '', stderr: 'Invalid Command' };
  };
  const real = (cmd, args) => {
    if (notMac()) { hitMacTool = true; throw new Error(`${cmd}: ${NEEDS_MAC}`); }
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
  };
  // `sudo -n -u <user> <program> ...`: the unix rules (owner, group, other bits) applied to the stand-in's owners table.
  // It knows /usr/bin/true, `/bin/test -w <path>` and `/bin/ls <path>`, which is all the proofs run. (An access list is not applied.)
  const asUser = (who, [prog, ...rest]) => {
    const rec = mac.users.get(who);
    if (!rec) return { status: 1, stdout: '', stderr: `sudo: unknown user ${who}` };
    const uid = Number(rec.UniqueID); const gid = Number(rec.PrimaryGroupID);
    if (prog === '/usr/bin/true') return { status: 0, stdout: '', stderr: '' };
    const can = (p, write) => {
      let st; try { st = lstatSync(at(p)); } catch { return false; }
      const o = mac.owners.get(p) ?? { uid: mac.rootUid, gid: 0 };
      const bits = write ? [0o200, 0o020, 0o002] : [0o400, 0o040, 0o004];
      return Boolean(st.mode & (o.uid === uid ? bits[0] : o.gid === gid ? bits[1] : bits[2]));
    };
    if (prog === '/bin/test' && rest[0] === '-w') return { status: can(rest[1], true) ? 0 : 1, stdout: '', stderr: '' };
    if (prog === '/bin/ls') return can(rest[0], false) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: `ls: ${rest[0]}: Permission denied` };
    return { status: 127, stdout: '', stderr: `fake mac: ${prog} is not stood in for` };
  };
  Object.assign(mac, {
    at, euid: () => mac.as,
    run(cmd, args) {
      if (cmd === '/usr/bin/dscl') { if (args[0] !== '.') return { status: 40, stdout: '', stderr: 'bad datasource' }; return dscl(args.slice(1)); }
      if (cmd === '/usr/sbin/dseditgroup') {
        const who = args[args.indexOf('-m') + 1];
        return mac.admins.has(who) ? { status: 0, stdout: `yes ${who} is a member of admin\n`, stderr: '' } : { status: 67, stdout: `no ${who} is NOT a member of admin\n`, stderr: '' };
      }
      if (cmd === '/usr/bin/sudo') {
        if (mac.as !== 0) return { status: 1, stdout: '', stderr: 'sudo: a password is required' };
        if (args.includes('-u')) return asUser(args[args.indexOf('-u') + 1], args.slice(args.indexOf('-u') + 2));
        const who = args[args.indexOf('-U') + 1];
        return mac.sudoRules.has(who) ? { status: 0, stdout: `User ${who} may run the following commands on this-mac:\n    (ALL) ALL\n`, stderr: '' } : { status: 1, stdout: `User ${who} is not allowed to run sudo on this-mac.\n`, stderr: '' };
      }
      // The real ls and chmod, so their refusals are the real ones. A principal that exists only on the always-on Mac (orchestrate)
      // is swapped for a real user of this Mac on the way in and back on the way out.
      if (cmd === '/bin/ls') {
        const r = real(cmd, args);
        for (const [from, to] of Object.entries(mac.aclPrincipals)) r.stdout = r.stdout.replace(new RegExp(`^(\\s+\\d+: (?:user|group):)${to}( )`, 'gm'), `$1${from}$2`);
        return r;
      }
      if (cmd === '/bin/chmod') {
        return real(cmd, args.map((a) => Object.entries(mac.aclPrincipals).reduce((x, [from, to]) => x.replace(`:${from} `, `:${to} `), a)));
      }
      return { status: 127, stdout: '', stderr: `fake mac: ${cmd} is not stood in for` };
    },
    lstat(p) {
      const st = lstatSync(at(p)); const o = mac.owners.get(p);
      return { isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink(), mode: st.mode, ino: st.ino, dev: st.dev, uid: o ? o.uid : mac.rootUid, gid: o ? o.gid : 0 };
    },
    mkdir(p, mode) { mac.log.push(`mkdir ${p}`); mkdirSync(at(p), { mode }); mac.owners.set(p, { uid: mac.rootUid, gid: 0 }); },
    // The setup's one way to change a folder's owner and mode: the real handle-based change, with chown stood in for (a test is not root).
    secure(p, want) {
      secureFolder(at(p), want, {
        chown: (fd, uid, gid) => {
          if (mac.as !== 0) { const e = new Error('EPERM: operation not permitted, fchown'); e.code = 'EPERM'; throw e; }
          mac.log.push(`chown ${uid}:${gid} ${p}`); mac.owners.set(p, { uid, gid });
        },
        chmod: (fd, mode) => { mac.log.push(`chmod ${mode.toString(8)} ${p}`); fchmodSync(fd, mode); },
      });
    },
    // A new file (never over an existing one or a link) and its owner and mode, as the real ones do it.
    write(p, text, mode) { mac.log.push(`write ${p}`); writeNewFile(at(p), text, mode); mac.owners.set(p, { uid: mac.rootUid, gid: 0 }); },
    secureFile(p, want) {
      secureFile(at(p), want, {
        chown: (fd, uid, gid) => {
          if (mac.as !== 0) { const e = new Error('EPERM: operation not permitted, fchown'); e.code = 'EPERM'; throw e; }
          mac.log.push(`chown ${uid}:${gid} ${p}`); mac.owners.set(p, { uid, gid });
        },
        chmod: (fd, mode) => { mac.log.push(`chmod ${mode.toString(8)} ${p}`); fchmodSync(fd, mode); },
      });
    },
    list: (p) => readdirSync(at(p)),
    // The real reader (links, plain file, owner, mode, folders above); `configOwner` stands in for the file's owner (a test is not root).
    readConfig: (p, { strict = false } = {}) => readConfigFile(strict ? at(p) : p, { strict, rootUid: mac.rootUid, top: prefix, ownerOf: (st) => mac.configOwner ?? st.uid }),
    configOwner: null,
    nodeProblem: () => mac.nodeProblemText,
  });
  return mac;
}
