// A stand-in for the Mac, for the setup tests: a throwaway folder as the root prefix, an in-memory user directory that
// answers like dscl and dseditgroup, and folder owners kept in a table (a test is not root, so it cannot chown for real).
// A stand-in refuses what the real tool refuses (L-brief): dscl writes need root, a path outside /Users and /Groups is
// invalid, a write with no value is a bad call, a record that is not there reads as exit 56; chown needs root; mkdir
// needs the parent and refuses an existing folder (those two are the real mkdir's own refusals, since it is the real one).

import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeMac({ euid: as = 0, users = {}, admins = [] } = {}) {
  const prefix = mkdtempSync(join(tmpdir(), 'setup-test-'));
  const mac = {
    as, prefix, rootUid: process.getuid(),
    users: new Map(Object.entries({ joe: { UniqueID: '65001', PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/joe' }, ...users })),
    groups: new Map([['staff', { PrimaryGroupID: '20' }], ['admin', { PrimaryGroupID: '80' }]]),
    admins: new Set(admins),
    owners: new Map(),          // logical path → { uid, gid } set by chown
    log: [],                    // every changing call, in order
    failNextDsclCreate: false,  // a test sets this to make the next dscl -create fail once
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
      return { status: 0, stdout: rest.map((k) => (a[k] === undefined ? `No such key: ${k}\n` : `${k}: ${a[k]}\n`)).join(''), stderr: '' };
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
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
  };
  Object.assign(mac, {
    at, euid: () => mac.as,
    run(cmd, args) {
      if (cmd === '/usr/bin/dscl') { if (args[0] !== '.') return { status: 40, stdout: '', stderr: 'bad datasource' }; return dscl(args.slice(1)); }
      if (cmd === '/usr/sbin/dseditgroup') {
        const who = args[args.indexOf('-m') + 1];
        return mac.admins.has(who) ? { status: 0, stdout: `yes ${who} is a member of admin\n`, stderr: '' } : { status: 67, stdout: `no ${who} is NOT a member of admin\n`, stderr: '' };
      }
      if (cmd === '/bin/ls') return real(cmd, args);
      if (cmd === '/bin/chmod') return real(cmd, args);
      return { status: 127, stdout: '', stderr: `fake mac: ${cmd} is not stood in for` };
    },
    lstat(p) {
      const st = lstatSync(at(p)); const o = mac.owners.get(p);
      return { isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink(), mode: st.mode, uid: o ? o.uid : mac.rootUid, gid: o ? o.gid : 0 };
    },
    mkdir(p, mode) { mac.log.push(`mkdir ${p}`); mkdirSync(at(p), { mode }); mac.owners.set(p, { uid: mac.rootUid, gid: 0 }); },
    chmod(p, mode) { mac.log.push(`chmod ${mode.toString(8)} ${p}`); chmodSync(at(p), mode); },
    chown(p, uid, gid) {
      if (mac.as !== 0) { const e = new Error('EPERM: operation not permitted, chown'); e.code = 'EPERM'; throw e; }
      mac.log.push(`chown ${uid}:${gid} ${p}`); mac.owners.set(p, { uid, gid });
    },
  });
  return mac;
}
