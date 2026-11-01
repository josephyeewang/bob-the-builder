// Setup part 1 (R-0b-05): the three plain-script Mac users and their folders. Three things, all through an `io` (mac.mjs):
//
//   plan(io, cfg)    reads the Mac and returns what would change: { ops, problems }. Reads only. `--dry-run` prints this.
//   apply(io, ops)   does the ops, in order. The caller has checked for root.
//   check(io, cfg)   reads only; one PASS or FAIL per item. Exit non-zero on any FAIL (setup.mjs).
//
// Safe to run twice: a user or folder that is already right adds no op. Something that exists but is wrong is a
// problem for a person to look at, not something to overwrite, with one exception: a folder under the base (root's, so
// nobody else made it) gets its owner, mode and access list put right, since the base is where these folders live.
// Users: hidden, no login shell (/usr/bin/false), a password that matches nothing ('*'), not in the admin group, and a
// group of the same name as their only group. Never an admin; a user that is one is refused, not changed.

import { dirname } from 'node:path';
import { aclProblem, chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { NO_SHELL, USERS, USER_ID_RANGE, folderTable, homeOf } from './layout.mjs';

const DSCL = '/usr/bin/dscl';
const DSEDIT = '/usr/sbin/dseditgroup';
const dscl = (io, args) => io.run(DSCL, ['.', ...args]);

/** `dscl -read` output → { key: value }. Tolerates "dsAttrTypeNative:" prefixes and a value on the next line. */
export function parseDscl(out) {
  const lines = String(out).split('\n');
  const res = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:dsAttrType(?:Native|Standard):)?([A-Za-z]\w*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    res[m[1]] = m[2] !== '' ? m[2].trim() : (lines[i + 1]?.startsWith(' ') ? lines[++i].trim() : '');
  }
  return res;
}

export function readUser(io, name) {
  const r = dscl(io, ['-read', `/Users/${name}`, 'UniqueID', 'PrimaryGroupID', 'UserShell', 'NFSHomeDirectory', 'IsHidden']);
  if (r.status !== 0) return { exists: false, error: r.status === 56 ? null : r.stderr.trim().slice(0, 200) };
  const a = parseDscl(r.stdout);
  return { exists: true, uid: Number(a.UniqueID), gid: Number(a.PrimaryGroupID), shell: a.UserShell ?? '', home: a.NFSHomeDirectory ?? '', hidden: a.IsHidden === '1' };
}

export function readGroup(io, name) {
  const r = dscl(io, ['-read', `/Groups/${name}`, 'PrimaryGroupID']);
  if (r.status !== 0) return { exists: false };
  return { exists: true, gid: Number(parseDscl(r.stdout).PrimaryGroupID) };
}

/** Does the Mac count `name` as an admin? The same question the review runner asks (review-runner-main.mjs): the answer must start with "no". */
export function adminAnswer(io, name) {
  const r = io.run(DSEDIT, ['-o', 'checkmember', '-m', name, 'admin']);
  const word = r.stdout.trim().split(/\s+/)[0];
  return word === 'no' ? 'no' : (word === 'yes' ? 'yes' : 'unknown');
}

function usedIds(io) {
  const read = (path, key) => {
    const r = dscl(io, ['-list', path, key]);
    if (r.status !== 0) throw new Error(`could not list ${path} (${r.stderr.trim().slice(0, 120)})`);
    return r.stdout.split('\n').map((l) => Number(l.trim().split(/\s+/)[1])).filter(Number.isInteger);
  };
  return new Set([...read('/Users', 'UniqueID'), ...read('/Users', 'PrimaryGroupID'), ...read('/Groups', 'PrimaryGroupID')]);
}

const op = (text, run) => ({ text, run });
const dsclOp = (io, args) => op(`dscl . ${args.map((a) => (/^[\w/.:-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`, () => {
  const r = dscl(io, args);
  if (r.status !== 0) throw new Error(`dscl ${args.slice(0, 2).join(' ')} failed (${r.stderr.trim().slice(0, 160)})`);
});

/** Users: { ops, problems, ids: { name: { uid, gid } } } for the three users and `cfg.owner`. */
export function planUsers(io, cfg) {
  const ops = []; const problems = []; const ids = {};
  const owner = readUser(io, cfg.owner);
  if (!owner.exists) problems.push(`the owner's Mac user ${cfg.owner} was not found${owner.error ? ` (${owner.error})` : ''}`);
  else ids.owner = { uid: owner.uid, gid: owner.gid };
  let used = null;
  for (const name of USERS) {
    const u = readUser(io, name); const g = readGroup(io, name);
    if (u.exists) {
      const bad = [];
      if (!g.exists) bad.push('it has no group of its own name');
      else if (u.gid !== g.gid) bad.push(`its main group is ${u.gid}, not the group ${name} (${g.gid})`);
      if (u.uid === 0) bad.push('its id is root\'s');
      if (u.shell !== NO_SHELL) bad.push(`its shell is ${u.shell || 'unset'}, not ${NO_SHELL}`);
      if (!u.hidden) bad.push('it is not hidden');
      if (u.home !== homeOf(cfg, name)) bad.push(`its home is ${u.home || 'unset'}, not ${homeOf(cfg, name)}`);
      if (adminAnswer(io, name) !== 'no') bad.push('it is an admin (or that could not be checked)');
      if (bad.length) problems.push(`${name} exists but is not as needed: ${bad.join('; ')}. Nothing was changed; fix it in System Settings or delete the user, then run again`);
      else ids[name] = { uid: u.uid, gid: u.gid };
      continue;
    }
    if (u.error) { problems.push(`could not look up ${name}: ${u.error}`); continue; }
    if (g.exists) { problems.push(`a group named ${name} exists without the user; nothing was changed`); continue; }
    try { used ??= usedIds(io); } catch (e) { problems.push(e.message); continue; }
    let id = USER_ID_RANGE.low;
    while (id <= USER_ID_RANGE.high && used.has(id)) id += 1;
    if (id > USER_ID_RANGE.high) { problems.push(`no free id between ${USER_ID_RANGE.low} and ${USER_ID_RANGE.high} for ${name}`); continue; }
    used.add(id);
    ids[name] = { uid: id, gid: id };
    ops.push(
      dsclOp(io, ['-create', `/Groups/${name}`]),
      dsclOp(io, ['-create', `/Groups/${name}`, 'PrimaryGroupID', String(id)]),
      dsclOp(io, ['-create', `/Groups/${name}`, 'Password', '*']),
      dsclOp(io, ['-create', `/Users/${name}`]),
      dsclOp(io, ['-create', `/Users/${name}`, 'UserShell', NO_SHELL]),
      dsclOp(io, ['-create', `/Users/${name}`, 'RealName', name]),
      dsclOp(io, ['-create', `/Users/${name}`, 'UniqueID', String(id)]),
      dsclOp(io, ['-create', `/Users/${name}`, 'PrimaryGroupID', String(id)]),
      dsclOp(io, ['-create', `/Users/${name}`, 'NFSHomeDirectory', homeOf(cfg, name)]),
      dsclOp(io, ['-create', `/Users/${name}`, 'IsHidden', '1']),
      dsclOp(io, ['-create', `/Users/${name}`, 'Password', '*']),
    );
  }
  return { ops, problems, ids };
}

const ownerIds = (io, ids, who) => (who === 'root' ? { uid: io.rootUid, gid: 0 } : ids[who]);
const aclOf = (io, path) => aclProblem([io.at(path)], { run: (c, a) => io.run(c, a) });
const modeText = (m) => m.toString(8).padStart(3, '0');

/** Folders: { ops, problems }, given the ids from planUsers. Parents first, so a made folder is there for the next. */
export function planFolders(io, cfg, ids) {
  const ops = []; const problems = [];
  for (const row of folderTable(cfg)) {
    const want = ownerIds(io, ids, row.owner);
    if (!want) { problems.push(`${row.path}: no id for ${row.owner}, so its owner can't be set`); continue; }
    let st = null;
    try { st = io.lstat(row.path); } catch (e) { if (e?.code !== 'ENOENT') { problems.push(`${row.path} could not be read (${e?.code ?? e})`); continue; } }
    if (st === null) {
      ops.push(
        op(`mkdir -m 700 ${row.path}`, () => io.mkdir(row.path, 0o700)),
        op(`chown ${want.uid}:${want.gid} ${row.path}   (${row.owner})`, () => io.chown(row.path, want.uid, want.gid)),
        op(`chmod ${modeText(row.mode)} ${row.path}`, () => io.chmod(row.path, row.mode)),
      );
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) { problems.push(`${row.path} exists but is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}; nothing was changed`); continue; }
    const wantGid = row.owner === 'owner' ? undefined : want.gid;
    if (st.uid !== want.uid || (wantGid !== undefined && st.gid !== wantGid)) ops.push(op(`chown ${want.uid}:${wantGid ?? st.gid} ${row.path}   (${row.owner})`, () => io.chown(row.path, want.uid, wantGid ?? st.gid)));
    if ((st.mode & 0o7777) !== row.mode) ops.push(op(`chmod ${modeText(row.mode)} ${row.path}`, () => io.chmod(row.path, row.mode)));
    if (aclOf(io, row.path)) ops.push(op(`chmod -N ${row.path}   (clear its access list)`, () => {
      const r = io.run('/bin/chmod', ['-N', io.at(row.path)]);
      if (r.status !== 0) throw new Error(`could not clear the access list of ${row.path} (${r.stderr.trim().slice(0, 120)})`);
    }));
  }
  return { ops, problems };
}

/** Both parts: { ops, problems }. Folders are planned against the ids the users will have, so one dry run shows everything. */
export function plan(io, cfg) {
  const u = planUsers(io, cfg);
  const f = planFolders(io, cfg, u.ids);
  return { ops: [...u.ops, ...f.ops], problems: [...u.problems, ...f.problems] };
}

export function apply(ops, { log = () => {} } = {}) {
  for (const o of ops) { log(o.text); o.run(); }
}

/** Read only. → [{ ok, what, why? }], one per item. */
export function check(io, cfg) {
  const out = [];
  const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const ids = {};
  for (const name of USERS) {
    const u = readUser(io, name); const g = readGroup(io, name);
    item(u.exists, `user ${name} exists`, u.error ?? 'not found');
    if (!u.exists) continue;
    ids[name] = { uid: u.uid, gid: u.gid };
    item(u.uid !== 0, `user ${name} is not root`, 'its id is 0');
    item(g.exists && g.gid === u.gid, `user ${name}'s main group is the group ${name}`, `group ${name}: ${g.exists ? g.gid : 'missing'}, user's main group: ${u.gid}`);
    item(u.shell === NO_SHELL, `user ${name} has no login shell`, `shell is ${u.shell || 'unset'}`);
    item(u.hidden, `user ${name} is hidden`, 'IsHidden is not 1');
    item(u.home === homeOf(cfg, name), `user ${name}'s home is ${homeOf(cfg, name)}`, `home is ${u.home || 'unset'}`);
    const a = adminAnswer(io, name);
    item(a === 'no', `user ${name} is not an admin`, a === 'yes' ? 'it is an admin' : 'the admin check gave no clear answer');
  }
  const o = readUser(io, cfg.owner);
  item(o.exists, `owner ${cfg.owner} exists`, 'not found');
  if (o.exists) ids.owner = { uid: o.uid, gid: o.gid };
  const above = chainProblem(io.at(dirname(cfg.base)), { owner: io.rootUid, top: io.prefix || '/' });
  item(above === null, `folders above ${cfg.base} are root's alone, no links, no access lists`, above);
  for (const row of folderTable(cfg)) {
    const what = `${row.path} (${row.owner}, ${modeText(row.mode)})`;
    let st; try { st = io.lstat(row.path); } catch { item(false, what, 'missing'); continue; }
    if (st.isSymbolicLink()) { item(false, what, 'is a link'); continue; }
    if (!st.isDirectory()) { item(false, what, 'is not a folder'); continue; }
    const want = ownerIds(io, ids, row.owner);
    const why = [];
    if (!want) why.push(`no id for ${row.owner}`);
    else {
      if (st.uid !== want.uid) why.push(`owner is uid ${st.uid}, want ${want.uid} (${row.owner})`);
      if (row.owner !== 'owner' && st.gid !== want.gid) why.push(`group is ${st.gid}, want ${want.gid}`);
    }
    if ((st.mode & 0o7777) !== row.mode) why.push(`mode is ${modeText(st.mode & 0o7777)}, want ${modeText(row.mode)}`);
    const acl = aclOf(io, row.path);
    if (acl) why.push(acl.replace(/^.*? has an access list.*$/, 'has an access list (ACL)'));
    item(why.length === 0, what, why.join('; '));
  }
  return out;
}
