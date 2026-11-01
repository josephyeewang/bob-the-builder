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

function usedIds(io, except = null) {
  const read = (path, key) => {
    const r = dscl(io, ['-list', path, key]);
    if (r.status !== 0) throw new Error(`could not list ${path} (${r.stderr.trim().slice(0, 120)})`);
    return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((w) => w[0] !== except).map((w) => Number(w[1])).filter(Number.isInteger);
  };
  return new Set([...read('/Users', 'UniqueID'), ...read('/Users', 'PrimaryGroupID'), ...read('/Groups', 'PrimaryGroupID')]);
}

const op = (text, run) => ({ text, run });
const dsclOp = (io, args) => op(`dscl . ${args.map((a) => (/^[\w/.:-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`, () => {
  const r = dscl(io, args);
  if (r.status !== 0) throw new Error(`dscl ${args.slice(0, 2).join(' ')} failed (${r.stderr.trim().slice(0, 160)})`);
});

// A record read: every attribute the setup writes, so a half-made one shows which are still missing. A missing record
// reads as exit 56; a missing attribute is just absent from the answer (the real dscl prints "No such key" and exits 0).
const USER_KEYS = ['UniqueID', 'PrimaryGroupID', 'UserShell', 'NFSHomeDirectory', 'IsHidden', 'RealName', 'Password'];
const GROUP_KEYS = ['PrimaryGroupID', 'Password'];
function readRecord(io, kind, name, keys) {
  const r = dscl(io, ['-read', `/${kind}/${name}`, ...keys]);
  if (r.status !== 0) return { exists: false, error: r.status === 56 ? null : r.stderr.trim().slice(0, 200), attrs: {} };
  const attrs = parseDscl(r.stdout);
  for (const k of Object.keys(attrs)) if (attrs[k] === '') delete attrs[k];
  return { exists: true, attrs };
}

/**
 * Users: { ops, problems, ids: { name: { uid, gid } } } for the three users and `cfg.owner`.
 * A user or group that is only partly there (a run cut off half way) is FINISHED, never deleted or overwritten: if every
 * attribute already set matches the table, only the missing ones are written; if any set one differs, nothing is
 * changed and the problem names it. An admin is refused whatever else is true.
 */
export function planUsers(io, cfg) {
  const ops = []; const problems = []; const ids = {};
  const owner = readUser(io, cfg.owner);
  if (!owner.exists) problems.push(`the owner's Mac user ${cfg.owner} was not found${owner.error ? ` (${owner.error})` : ''}`);
  else ids.owner = { uid: owner.uid, gid: owner.gid };
  let used = null;
  for (const name of USERS) {
    const U = readRecord(io, 'Users', name, USER_KEYS); const G = readRecord(io, 'Groups', name, GROUP_KEYS);
    if (U.error || G.error) { problems.push(`could not look up ${name}: ${U.error ?? G.error}`); continue; }
    const home = homeOf(cfg, name);
    const bad = [];
    const idWords = [['its group', G.attrs.PrimaryGroupID], ['its id', U.attrs.UniqueID], ['its main group', U.attrs.PrimaryGroupID]].filter(([, v]) => v !== undefined);
    if (new Set(idWords.map(([, v]) => v)).size > 1) {
      if (U.attrs.PrimaryGroupID !== undefined && G.attrs.PrimaryGroupID !== undefined && U.attrs.PrimaryGroupID !== G.attrs.PrimaryGroupID) bad.push(`its main group is ${U.attrs.PrimaryGroupID}, not the group ${name} (${G.attrs.PrimaryGroupID})`);
      else bad.push(`its ids disagree (${idWords.map(([w, v]) => `${w} ${v}`).join(', ')})`);
    }
    let id = idWords.length ? Number(idWords[0][1]) : null;
    if (id !== null && !Number.isInteger(id)) { bad.push(`its id ${idWords[0][1]} is not a number`); id = null; }
    if (id === 0) bad.push('its id is root\'s');
    if (U.exists) {
      if (U.attrs.UserShell !== undefined && U.attrs.UserShell !== NO_SHELL) bad.push(`its shell is ${U.attrs.UserShell}, not ${NO_SHELL}`);
      if (U.attrs.IsHidden !== undefined && U.attrs.IsHidden !== '1') bad.push('it is not hidden');
      if (U.attrs.NFSHomeDirectory !== undefined && U.attrs.NFSHomeDirectory !== home) bad.push(`its home is ${U.attrs.NFSHomeDirectory}, not ${home}`);
      if (adminAnswer(io, name) !== 'no') bad.push('it is an admin (or that could not be checked)');
    }
    if (bad.length) { problems.push(`${name} exists but is not as needed: ${bad.join('; ')}. Nothing was changed; fix it in System Settings or delete the user, then run again`); continue; }
    try {
      if (id !== null) { if (usedIds(io, name).has(id)) { problems.push(`${name}: its id ${id} is also used by another user or group; nothing was changed`); continue; } }
      else {
        used ??= usedIds(io);
        id = USER_ID_RANGE.low;
        while (id <= USER_ID_RANGE.high && used.has(id)) id += 1;
        if (id > USER_ID_RANGE.high) { problems.push(`no free id between ${USER_ID_RANGE.low} and ${USER_ID_RANGE.high} for ${name}`); continue; }
        used.add(id);
      }
    } catch (e) { problems.push(e.message); continue; }
    ids[name] = { uid: id, gid: id };
    // Fresh, or finishing a half-made one: write only what is missing, group first (so a cut-off run leaves the same shapes).
    const want = (rec, kind, pairs) => {
      if (!rec.exists) ops.push(dsclOp(io, ['-create', `/${kind}/${name}`]));
      for (const [k, v] of pairs) if (rec.attrs[k] === undefined) ops.push(dsclOp(io, ['-create', `/${kind}/${name}`, k, v]));
    };
    want(G, 'Groups', [['PrimaryGroupID', String(id)], ['Password', '*']]);
    want(U, 'Users', [['UserShell', NO_SHELL], ['RealName', name], ['UniqueID', String(id)], ['PrimaryGroupID', String(id)], ['NFSHomeDirectory', home], ['IsHidden', '1'], ['Password', '*']]);
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
