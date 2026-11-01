// A stand-in for the Mac, for the setup tests: a throwaway folder as the root prefix, an in-memory user directory that
// answers like dscl and dseditgroup, and folder owners kept in a table (a test is not root, so it cannot chown for real).
// A stand-in refuses what the real tool refuses (L-brief): dscl writes need root, a path outside /Users and /Groups is
// invalid, a write with no value is a bad call, a record that is not there reads as exit 56; chown needs root; mkdir
// needs the parent and refuses an existing folder (those two are the real mkdir's own refusals, since it is the real one).

import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeMac({ euid: as = 0, users = {}, admins = [] } = {}) {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'setup-test-')));   // real: the updater compares real paths
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
  mkdirSync(at('/Library/LaunchDaemons'), { recursive: true });
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
    prefix,
    lstat(p) {
      const st = lstatSync(at(p)); const o = mac.owners.get(p);
      return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), isSymbolicLink: () => st.isSymbolicLink(), mode: st.mode, uid: o ? o.uid : mac.rootUid, gid: o ? o.gid : 0 };
    },
    mkdir(p, mode) { mac.log.push(`mkdir ${p}`); mkdirSync(at(p), { mode }); mac.owners.set(p, { uid: mac.rootUid, gid: 0 }); },
    chmod(p, mode) { mac.log.push(`chmod ${mode.toString(8)} ${p}`); chmodSync(at(p), mode); },
    chown(p, uid, gid) {
      if (mac.as !== 0) { const e = new Error('EPERM: operation not permitted, chown'); e.code = 'EPERM'; throw e; }
      lstatSync(at(p));   // like the real one: a path that is not there is refused
      mac.log.push(`chown ${uid}:${gid} ${p}`); mac.owners.set(p, { uid, gid });
    },
    // The install and the job files. The real calls, on the prefixed place; a write needs the parent folder (like the real one).
    readText: (p) => readFileSync(at(p), 'utf8'),
    write(p, text, mode) { mac.log.push(`write ${p}`); writeFileSync(at(p), text, { mode }); chmodSync(at(p), mode); mac.owners.set(p, { uid: mac.as === 0 ? mac.rootUid : mac.rootUid + 1, gid: 0 }); },
    copyFile(src, p, mode) { mac.log.push(`copy ${p}`); copyFileSync(src, at(p)); chmodSync(at(p), mode); },
    copyTree(src, p) { mac.log.push(`copytree ${p}`); cpSync(src, at(p), { recursive: true, dereference: false, errorOnExist: true, force: false }); },
    rm(p) { mac.log.push(`rm ${p}`); rmSync(at(p), { recursive: true, force: true }); for (const k of [...mac.owners.keys()]) if (k === p || k.startsWith(`${p}/`)) mac.owners.delete(k); },
    list: (p) => readdirSync(at(p)),
    readlink: (p) => readlinkSync(at(p)),
    lstatReal: (abs) => lstatSync(abs),
    listReal: (abs) => readdirSync(abs),
  });
  // launchctl: loaded jobs by label. Refuses what the real one refuses: bootstrap and bootout need root; bootstrap wants the
  // job file to be root's and not writable by group or other, and refuses a job already loaded; bootout refuses one that is
  // not loaded; print of one launchd does not know exits 113.
  mac.loaded = new Map();
  mac.launchctl = (args) => {
    const [verb, a, b] = args;
    const err = (status, stderr) => ({ status, stdout: '', stderr });
    if (verb === 'print') {
      const m = /^system\/(.+)$/.exec(a ?? '');
      if (!m) return err(64, 'Usage: launchctl print <domain-target>');
      if (!mac.loaded.has(m[1])) return err(113, `Could not find service "${m[1]}" in domain for system`);
      return { status: 0, stdout: `system/${m[1]} = {\n\tstate = ${mac.loaded.get(m[1]).state}\n\tlast exit code = 0\n}\n`, stderr: '' };
    }
    if (verb === 'bootstrap' || verb === 'bootout') {
      if (mac.as !== 0) return err(1, `${verb === 'bootstrap' ? 'Bootstrap' : 'Boot-out'} failed: 1: Operation not permitted`);
      mac.log.push(`launchctl ${args.join(' ')}`);
    }
    if (verb === 'bootstrap') {
      if (a !== 'system' || !b) return err(64, 'Usage: launchctl bootstrap <domain> <path>');
      let st; let text;
      try { st = lstatSync(b); text = readFileSync(b, 'utf8'); } catch { return err(5, 'Bootstrap failed: 5: Input/output error'); }
      const logical = b.startsWith(prefix) ? b.slice(prefix.length) : b; const o = mac.owners.get(logical);
      if (!st.isFile() || (o ? o.uid : mac.rootUid) !== mac.rootUid || (st.mode & 0o022)) return err(5, 'Bootstrap failed: 5: Input/output error');
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
      if (!label) return err(5, 'Bootstrap failed: 5: Input/output error');
      if (mac.loaded.has(label)) return err(5, 'Bootstrap failed: 5: Input/output error');
      mac.loaded.set(label, { state: 'waiting' }); return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'bootout') {
      const m = /^system\/(.+)$/.exec(a ?? '');
      if (!m) return err(64, 'Usage: launchctl bootout <domain-target>');
      if (!mac.loaded.has(m[1])) return err(3, 'Boot-out failed: 3: No such process');
      mac.loaded.delete(m[1]); return { status: 0, stdout: '', stderr: '' };
    }
    return err(64, 'Usage: launchctl <subcommand>');
  };
  const baseRun = mac.run;
  mac.run = (cmd, args) => (cmd === '/bin/launchctl' ? mac.launchctl(args) : baseRun(cmd, args));
  return mac;
}
