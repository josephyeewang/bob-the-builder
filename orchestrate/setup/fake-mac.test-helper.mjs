// A stand-in for the Mac, for the setup tests: a throwaway folder as the root prefix, an in-memory user directory that
// answers like dscl and dseditgroup, and folder owners kept in a table (a test is not root, so it cannot chown for real).
// Owners fail closed (L149 m9): a path nobody gave an owner to belongs to no one (uid -1), and a file just written has no owner until
// the code sets one, so a missing chown shows as a failure instead of passing as "root's by default".
// A stand-in refuses what the real tool refuses (L-brief): dscl writes need root, a path outside /Users and /Groups is
// invalid, a write with no value is a bad call, a record that is not there reads as exit 56; chown needs root; mkdir
// needs the parent and refuses an existing folder (those two are the real mkdir's own refusals, since it is the real one).

import { renameSync, unlinkSync, chmodSync, cpSync, fchmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { openRead } from '../wiring/owner-status.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { tempDir } from '../shared/test-tmp.mjs';
import { nodeProblemOf, readConfigFile, secureFile, secureFolder, writeNewFile } from './mac.mjs';

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
  const prefix = realpathSync(tempDir('orch-setup-mac-'));   // real: the updater compares real paths
  const mac = {
    as, prefix, rootUid: process.getuid(),
    users: new Map(Object.entries({ sam: { UniqueID: '65001', PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/sam' }, ...users })),
    groups: new Map([['staff', { PrimaryGroupID: '20' }], ['admin', { PrimaryGroupID: '80' }]]),
    admins: new Set(admins),
    owners: new Map(),          // logical path → { uid, gid } set by chown
    log: [],                    // every changing call, in order
    failNextDsclCreate: false,  // a test sets this to make the next dscl -create fail once
    fetchLog: [], github: null,
    // Programs run as another user that a test stands in for: mac.programs.set('<full path>', (who, args) => ({ status, stdout, stderr })).
    programs: new Map(),
    gitSafeOther: [],          // safe.directory values from the system file or an include: seen by a read of ALL scopes, never by --global
    gitSafe: new Map(),        // user → their `git config --global` safe.directory values
    secretInput: null,          // what the stand-in terminal returns for the hidden read (null = there is no terminal)
    secretPrompts: [],          // every prompt shown
    sudoRules: new Set(),      // users a sudo rule names (`sudo -l -U` then says they may run sudo)
    nodeProblemText: null,      // a test sets this to make the node program look like one root must not run
    // Access-list names that exist only on the always-on Mac are stood in for by a real user here: orchestrate, and the review
    // user and the owners the tests name, for the rules-in-force folder (L1002).
    aclPrincipals: { orchestrate: 'daemon', review: 'nobody', sam: '_www', joe: '_ftp', builder: '_uucp' },
    privacyBlocked: new Set(),  // paths macOS's privacy protection refuses whatever the permissions say (a cloud folder): /bin/cat fails with EPERM
  };
  const at = (p) => join(prefix, p);
  mkdirSync(at('/Library/LaunchDaemons'), { recursive: true });
  for (const p of ['/Library', '/Library/LaunchDaemons']) mac.owners.set(p, { uid: mac.rootUid, gid: 0 });
  // As on every Mac, /etc is a link to /private/etc (#556 r1 M1): a path through it is a path through a link.
  mkdirSync(at('/private/etc'), { recursive: true }); symlinkSync('private/etc', at('/etc'));
  for (const p of ['/private', '/private/etc']) mac.owners.set(p, { uid: mac.rootUid, gid: 0 });
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
  // It knows /usr/bin/true, `/bin/test -w|-r|-x <path>`, `/bin/cat <path>` and `/bin/ls <path>`. (An access list lets a read through, never a write; `-x` and the folder walk of `cat` look at the mode bits only, never an access list.)
  const asUser = (who, [prog, ...rest]) => {
    const rec = mac.users.get(who);
    if (!rec) return { status: 1, stdout: '', stderr: `sudo: unknown user ${who}` };
    const uid = Number(rec.UniqueID); const gid = Number(rec.PrimaryGroupID);
    if (prog === '/usr/bin/true') return { status: 0, stdout: '', stderr: '' };
    const can = (p, write, exec = false) => {
      let st; try { st = lstatSync(at(p)); } catch { return false; }
      const o = mac.owners.get(p) ?? { uid: -1, gid: -1 };
      const bits = exec ? [0o100, 0o010, 0o001] : write ? [0o200, 0o020, 0o002] : [0o400, 0o040, 0o004];
      if (exec) return !!(st.mode & (o.uid === uid ? bits[0] : o.gid === gid ? bits[1] : bits[2]));
      if (st.mode & (o.uid === uid ? bits[0] : o.gid === gid ? bits[1] : bits[2])) return true;
      // An access list entry for this user (the real `ls -le` shows it) lets a read through; it never lets a write through here
      // (the setup only ever grants list/search/read), and the Mini's `orchestrate` is stood in for by a real user of this Mac.
      if (write) return false;
      const principal = mac.aclPrincipals[who] ?? who;
      const shown = real('/bin/ls', ['-led', at(p)]).stdout;
      return new RegExp(`^\\s+\\d+: user:${principal} allow .*\\blist\\b`, 'm').test(shown);
    };
    // Every path is reached through its folders: each one above needs search (x), as on the Mac (#528 r1 M1: a folder under
    // a home the builder can't enter is refused on the way in, by ls and test alike).
    const reach = (f) => { for (let d = dirname(f); d !== '/'; d = dirname(d)) if (!can(d, false, true)) return false; return true; };
    if (prog === '/bin/test' && rest[0] === '-w') return { status: reach(rest[1]) && can(rest[1], true) ? 0 : 1, stdout: '', stderr: '' };
    if (prog === '/bin/test' && rest[0] === '-r') return { status: reach(rest[1]) && can(rest[1], false) ? 0 : 1, stdout: '', stderr: '' };
    if (prog === '/bin/test' && rest[0] === '-x') return { status: reach(rest[1]) && can(rest[1], false, true) ? 0 : 1, stdout: '', stderr: '' };
    // `head -c 1 <file>` (the proofs' read, L1079) is a read as `cat` is: the folder walk, then the file's read bits; a folder it can read answers "Error reading", as macOS's head does.
    if (prog === '/usr/bin/head' && rest[0] === '-c' && rest[1] === '1') {
      const f = rest[2];
      for (let d = dirname(f); d !== '/'; d = dirname(d)) if (!can(d, false, true)) return { status: 1, stdout: '', stderr: `head: ${f}: Permission denied` };
      if (!can(f, false)) return { status: 1, stdout: '', stderr: `head: ${f}: Permission denied` };
      // A folder it may read opens, then the read fails: exit 1, but not a permission refusal (macOS's own answer, #528 r1 M1).
      if (lstatSync(at(f)).isDirectory()) return { status: 1, stdout: '', stderr: `head: Error reading ${f}` };
      return { status: 0, stdout: readFileSync(at(f), 'utf8').slice(0, 1), stderr: '' };
    }
    if (prog === '/bin/cat' && mac.privacyBlocked.has(rest[0])) return { status: 1, stdout: '', stderr: `cat: ${rest[0]}: Operation not permitted` };
    // A real open needs search (x) on every folder above the file: the stand-in checks that too, below the stand-in's own
    // '/' (the throwaway prefix folder, private to this test process; the real '/' lets everyone search it).
    if (prog === '/bin/cat') for (let d = dirname(rest[0]); d !== '/'; d = dirname(d)) if (!can(d, false, true)) return { status: 1, stdout: '', stderr: `cat: ${rest[0]}: Permission denied` };
    if (prog === '/bin/cat') return can(rest[0], false) ? { status: 0, stdout: readFileSync(at(rest[0]), 'utf8'), stderr: '' } : { status: 1, stdout: '', stderr: `cat: ${rest[0]}: Permission denied` };
    if (prog === '/bin/ls') return reach(rest[0]) && can(rest[0], false) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: `ls: ${rest[0]}: Permission denied` };
    if (prog === '/usr/bin/git' && rest[0] === 'config' && rest[1] === '--includes' && rest[2] === '--get-all' && rest[3] === 'safe.directory') {
      // every scope (system, global, included files), as the real git reads them: nothing else is set here
      const all = [...mac.gitSafeOther, ...(mac.gitSafe.get(who) ?? [])];
      return all.length ? { status: 0, stdout: `${all.join('\n')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (prog === '/usr/bin/git' && rest[0] === 'config' && rest[1] === '--global') {
      // git's own answers: a key that is not set exits 1; an add with no value is a usage error (129).
      const store = mac.gitSafe.get(who) ?? [];
      if (rest[2] === '--get-all' && rest[3] === 'safe.directory') return store.length ? { status: 0, stdout: `${store.join('\n')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
      if (rest[2] === '--add' && rest[3] === 'safe.directory' && rest[4]) { mac.log.push(`git config --global --add safe.directory ${rest[4]} (as ${who})`); mac.gitSafe.set(who, [...store, rest[4]]); return { status: 0, stdout: '', stderr: '' }; }
      return { status: 129, stdout: '', stderr: 'usage: git config [<options>]' };
    }
    const stand = mac.programs.get(prog); if (stand) return stand(who, rest);
    return { status: 127, stdout: '', stderr: `fake mac: ${prog} is not stood in for` };
  };
  const ports = (p) => ({
    chown: (fd, uid, gid) => {
      if (mac.as !== 0) { const e = new Error('EPERM: operation not permitted, fchown'); e.code = 'EPERM'; throw e; }
      mac.log.push(`chown ${uid}:${gid} ${p}`); mac.owners.set(p, { uid, gid });
    },
    chmod: (fd, mode) => { mac.log.push(`chmod ${mode.toString(8)} ${p}`); fchmodSync(fd, mode); },
  });
  Object.assign(mac, {
    at, euid: () => mac.as,
    run(cmd, args) {
      if (cmd === '/usr/bin/dscl') { if (args[0] !== '.') return { status: 40, stdout: '', stderr: 'bad datasource' }; return dscl(args.slice(1)); }
      if (cmd === '/usr/sbin/dseditgroup') {
        const who = args[args.indexOf('-m') + 1];
        return mac.admins.has(who) ? { status: 0, stdout: `yes ${who} is a member of admin\n`, stderr: '' } : { status: 67, stdout: `no ${who} is NOT a member of admin\n`, stderr: '' };
      }
      // `id -Gn <user>`: its own group's name and the groups every local user is in, unless a test sets mac.groupNames[user]
      // (a list, or a { status, stderr } answer).
      if (cmd === '/usr/bin/id' && args[0] === '-Gn') {
        const who = args[1]; const set = mac.groupNames?.[who];
        if (set && !Array.isArray(set)) return { stdout: '', ...set };
        if (!mac.users.get(who)) return { status: 1, stdout: '', stderr: `id: ${who}: no such user` };
        return { status: 0, stdout: `${(set ?? [who, 'everyone', 'localaccounts', '_lpoperator']).join(' ')}\n`, stderr: '' };
      }
      if (cmd === '/usr/bin/sudo') {
        if (mac.as !== 0) return { status: 1, stdout: '', stderr: 'sudo: a password is required' };
        if (args.includes('-u')) {
          if (!args.includes('-H')) return { status: 1, stdout: '', stderr: 'fake mac: sudo -u without -H keeps the caller\'s HOME; every call here must say -H (L150 P7)' };
          return asUser(args[args.indexOf('-u') + 1], args.slice(args.indexOf('-u') + 2));
        }
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
    prefix,
    lstat(p) {
      const st = lstatSync(at(p)); const o = mac.owners.get(p);
      return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), isSymbolicLink: () => st.isSymbolicLink(), mode: st.mode, size: st.size, nlink: st.nlink, ino: st.ino, dev: st.dev, uid: o ? o.uid : -1, gid: o ? o.gid : -1 };
    },
    stat(p) { const st = statSync(at(p)); return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), isSymbolicLink: () => false, mode: st.mode }; },
    realpath(p) { const r = realpathSync(at(p)); return r.startsWith(`${prefix}/`) ? r.slice(prefix.length) : r; },
    openRead: (p) => openRead(at(p)),
    mkdir(p, mode) { mac.log.push(`mkdir ${p}`); mkdirSync(at(p), { mode }); mac.owners.set(p, mac.as === 0 ? { uid: mac.rootUid, gid: 0 } : { uid: mac.as, gid: 20 }); },
    // The setup's one way to change an owner and mode: the real handle-based change, with chown stood in for (a test is not root).
    secure(p, want) { secureFolder(at(p), want, ports(p)); },
    secureFile(p, want) { (mac.reopened ??= []).push(p); secureFile(at(p), want, ports(p)); },   // reopens the name: a test can see it
    // The real reader (links, plain file, owner, mode, folders above); `configOwner` stands in for the file's owner (a test is not root).
    readConfig: (p, { strict = false } = {}) => readConfigFile(strict ? at(p) : p, { strict, rootUid: mac.rootUid, top: prefix, ownerOf: (st) => mac.configOwner ?? st.uid, what: strict ? "root's setup config" : 'the setup config' }),
    configOwner: null,
    sourceOwner: null,   // stands in for the runner config's owner (a test is not root)
    nodeProblem: () => mac.nodeProblemText,
    // A stand-in for GitHub: a test sets mac.github = (url, init) => ({ status, text }). Every call is kept (the token is in init.headers).
    fetch: async (url, init) => { mac.fetchLog.push({ url, method: init?.method ?? 'GET' }); if (!mac.github) throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); return mac.github(url, init); },
    readSecret(prompt) { mac.secretPrompts.push(prompt); if (mac.secretInput === null) throw new Error('there is no terminal to type the token into; run this in the Terminal app'); return mac.secretInput; },
    // The real checks on a node program the config names, for the file's own owner (the test process) and mode, in its own folder.
    nodeBinProblem: (p) => nodeProblemOf(p, { exact: true, rootUid: mac.rootUid, top: (() => { try { return dirname(realpathSync(p)); } catch { return '/'; } })() }),
    // The runner config is a real file outside the prefix. The real reader (links, plain file, size); as root also its owner and mode.
    readRules: (p) => readConfigFile(p, { strict: false, what: 'the rules file' }),
    readSourceStrict: (p) => readConfigFile(p, { strict: true, rootUid: mac.rootUid, top: dirname(p), ownerOf: (st) => mac.sourceOwner ?? st.uid, what: 'the runner config' }),
    readSource: (p) => readConfigFile(p, { strict: mac.as === 0, rootUid: mac.rootUid, top: dirname(p), ownerOf: (st) => mac.sourceOwner ?? st.uid, what: 'the runner config' }),
    // The install and the job files. The real calls, on the prefixed place; a write needs the parent folder (like the real one)
    // and makes a NEW file only (like the real one: it never overwrites or follows a link).
    readText: (p) => readFileSync(at(p), 'utf8'),
    writeOwned(p, text, own) { mac.log.push(`write ${p}`); writeNewFile(at(p), text, own.mode, own, ports(p)); },
    unlink(p) { mac.log.push(`unlink ${p}`); try { unlinkSync(at(p)); } catch (e) { if (e?.code !== 'ENOENT') throw e; } mac.owners.delete(p); },
    rename(from, to) { mac.log.push(`rename ${from} ${to}`); renameSync(at(from), at(to)); const o = mac.owners.get(from); mac.owners.delete(from); if (o) mac.owners.set(to, o); else mac.owners.delete(to); },   // the real call
    write(p, text, mode) { mac.log.push(`write ${p}`); writeNewFile(at(p), text, mode); mac.owners.set(p, mac.as === 0 ? { uid: -2, gid: -2 } : { uid: mac.as, gid: 20 }); },   // root's: no owner until the code sets one; a user's is that user's
    copyFile(src, p, mode) { mac.log.push(`copy ${p}`); writeNewFile(at(p), readFileSync(src), mode); mac.owners.set(p, { uid: -2, gid: -2 }); },
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
  mac.guiLoaded = new Map();   // "<uid>/<label>" → { state, lastExit }
  mac.guiClosed = new Set();   // uids with no open login session: bootstrap in gui/<uid> fails as the real one does
  const gui = (args) => {
    const [verb, a, b] = args;
    const err = (status, stderr) => ({ status, stdout: '', stderr });
    const m = /^gui\/(\d+)(?:\/(.+))?$/.exec(a ?? ''); const uid = Number(m[1]);
    if (verb === 'print') {
      const key = `${uid}/${m[2]}`; const j = mac.guiLoaded.get(key);
      if (!m[2]) return err(64, 'Usage: launchctl print <domain-target>');
      if (!j) return err(113, `Could not find service "${m[2]}" in domain for user gui: ${uid}`);
      return { status: 0, stdout: `gui/${key} = {\n\tstate = ${j.state}\n\tlast exit code = ${j.lastExit ?? '(never exited)'}\n}\n`, stderr: '' };
    }
    if (mac.as !== 0 && mac.as !== uid) return err(1, `${verb === 'bootstrap' ? 'Bootstrap' : 'Boot-out'} failed: 1: Operation not permitted`);
    mac.log.push(`launchctl ${args.join(' ')}`);
    if (verb === 'bootstrap') {
      if (m[2] || !b) return err(64, 'Usage: launchctl bootstrap <domain> <path>');
      if (mac.guiClosed.has(uid)) return err(125, 'Bootstrap failed: 125: Domain does not support specified action');
      let st; let text;
      try { st = lstatSync(b); text = readFileSync(b, 'utf8'); } catch { return err(5, 'Bootstrap failed: 5: Input/output error'); }
      const logical = b.startsWith(prefix) ? b.slice(prefix.length) : b; const o = mac.owners.get(logical);
      if (!st.isFile() || ![uid, mac.rootUid].includes(o ? o.uid : -1) || (st.mode & 0o022)) return err(5, 'Bootstrap failed: 5: Input/output error');
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
      if (!label || mac.guiLoaded.has(`${uid}/${label}`)) return err(5, 'Bootstrap failed: 5: Input/output error');
      mac.guiLoaded.set(`${uid}/${label}`, { state: 'running', text });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'bootout') {
      if (!m[2]) return err(64, 'Usage: launchctl bootout <domain-target>');
      if (!mac.guiLoaded.delete(`${uid}/${m[2]}`)) return err(3, 'Boot-out failed: 3: No such process');
      return { status: 0, stdout: '', stderr: '' };
    }
    return err(64, 'Usage: launchctl <subcommand>');
  };
  mac.launchctl = (args) => {
    const [verb, a, b] = args;
    const err = (status, stderr) => ({ status, stdout: '', stderr });
    if (['print', 'bootstrap', 'bootout'].includes(verb) && /^gui\/\d+(\/|$)/.test(a ?? '')) return gui(args);
    if (verb === 'print') {
      const m = /^system\/(.+)$/.exec(a ?? '');
      if (!m) return err(64, 'Usage: launchctl print <domain-target>');
      if (!mac.loaded.has(m[1])) return err(113, `Could not find service "${m[1]}" in domain for system`);
      return { status: 0, stdout: `system/${m[1]} = {\n\tstate = ${mac.loaded.get(m[1]).state}\n\tlast exit code = ${mac.loaded.get(m[1]).lastExit ?? '(never exited)'}\n${mac.loaded.get(m[1]).pid ? `\tpid = ${mac.loaded.get(m[1]).pid}\n` : ''}${mac.loaded.get(m[1]).runs !== undefined ? `\truns = ${mac.loaded.get(m[1]).runs}\n` : ''}}\n`, stderr: '' };
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
      if (mac.failBootstrap?.has(label)) return err(5, 'Bootstrap failed: 5: Input/output error');   // a test makes the load fail
      if (mac.bootstrapLies?.has(label)) return { status: 0, stdout: '', stderr: '' };   // ... or say yes and leave nothing loaded

      mac.loaded.set(label, { state: 'running', pid: 4000 + mac.loaded.size, ageS: 5 });   // RunAtLoad: launchd starts it at once
      return { status: 0, stdout: '', stderr: '' };
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
  // ps: only `ps -o etime= -p <pid>`, the time a launched job's process has been running ([[dd-]hh:]mm:ss); an unknown pid exits 1 with nothing
  mac.ps = (args) => {
    const pid = args[0] === '-o' && args[1] === 'etime=' && args[2] === '-p' ? Number(args[3]) : NaN;
    if (!Number.isInteger(pid)) return { status: 64, stdout: '', stderr: 'usage: ps -o etime= -p <pid>' };
    const j = [...mac.loaded.values()].find((x) => x.pid === pid);
    if (!j) return { status: 1, stdout: '', stderr: '' };
    const s = j.ageS ?? 0; const dd = Math.floor(s / 86400); const r = s % 86400; const hh = Math.floor(r / 3600); const mm = Math.floor((r % 3600) / 60); const ss = r % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return { status: 0, stdout: `${dd ? `${dd}-${p2(hh)}:` : hh ? `${p2(hh)}:` : ''}${p2(mm)}:${p2(ss)}\n`, stderr: '' };
  };
  mac.run = (cmd, args) => (cmd === '/bin/launchctl' ? mac.launchctl(args) : cmd === '/bin/ps' ? mac.ps(args) : baseRun(cmd, args));
  return mac;
}
