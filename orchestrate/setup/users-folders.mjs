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
//
// Root never works under a folder others can change (L90 M3): the first step of every run is the chain check on the
// folders above the base, and it is the first op of the apply as well. Folders are never changed through a link (M4): see
// mac.mjs `secure`. New folders are made while still root's, parents first; owners and modes are set deepest first, so
// a parent that a robot user will own is handed over last.

import { BASE_MARKER, NO_SHELL, USERS, USER_ID_RANGE, aclText, baseMarkerPath, folderTable, homeOf } from './layout.mjs';
import { baseChainProblem, guardOp } from './guard.mjs';

const DSCL = '/usr/bin/dscl';
const DSEDIT = '/usr/sbin/dseditgroup';
const SUDO = '/usr/bin/sudo';
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

/** Every id in use: { uids: [[name, id]], ugids: [[name, id]] (users' main groups), gids: [[name, id]] }. Throws if a list cannot be read. */
function census(io) {
  const read = (path, key) => {
    const r = dscl(io, ['-list', path, key]);
    if (r.status !== 0) throw new Error(`could not list ${path} (${r.stderr.trim().slice(0, 120)})`);
    return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((w) => w.length >= 2).map((w) => [w[0], Number(w[1])]).filter(([, n]) => Number.isInteger(n));
  };
  return { uids: read('/Users', 'UniqueID'), ugids: read('/Users', 'PrimaryGroupID'), gids: read('/Groups', 'PrimaryGroupID') };
}
const usedIds = (c, except = null) => new Set([...c.uids, ...c.ugids, ...c.gids].filter(([n]) => n !== except).map(([, id]) => id));

const op = (text, run) => ({ text, run });
const dsclOp = (io, args) => op(`dscl . ${args.map((a) => (/^[\w/.:-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`, () => {
  const r = dscl(io, args);
  if (r.status !== 0) throw new Error(`dscl ${args.slice(0, 2).join(' ')} failed (${r.stderr.trim().slice(0, 160)})`);
});

// A record read: every attribute the setup writes, so a half-made one shows which are still missing. A missing record
// reads as exit 56; a missing attribute is just absent from the answer (the real dscl prints "No such key" and exits 0).
const USER_KEYS = ['UniqueID', 'PrimaryGroupID', 'UserShell', 'NFSHomeDirectory', 'IsHidden', 'RealName', 'Password'];
const GROUP_KEYS = ['PrimaryGroupID', 'Password', 'GroupMembership', 'NestedGroups'];   // a robot's own group has no members (L100 m9)
const LOGIN_KEYS = ['AuthenticationAuthority', 'ShadowHashData'];   // a password or other way to sign in; a robot user has neither
function readRecord(io, kind, name, keys) {
  const r = dscl(io, ['-read', `/${kind}/${name}`, ...keys]);
  if (r.status !== 0) return { exists: false, error: r.status === 56 ? null : r.stderr.trim().slice(0, 200), attrs: {} };
  const attrs = parseDscl(r.stdout);
  for (const k of Object.keys(attrs)) if (attrs[k] === '') delete attrs[k];
  return { exists: true, attrs };
}

const inRange = (n) => Number.isInteger(n) && n >= USER_ID_RANGE.low && n <= USER_ID_RANGE.high;

/**
 * Users: { ops, problems, ids: { name: { uid, gid } } } for the three users and `cfg.owner`.
 * A user or group that is only partly there (a run cut off half way) is FINISHED, never deleted or overwritten: if every
 * attribute already set matches the table, only the missing ones are written; if any set one differs, nothing is
 * changed and the problem names it. An admin is refused whatever else is true. New ids come from USER_ID_RANGE; an id in
 * use by any other user or group, or by two of the three, is refused.
 */
export function planUsers(io, cfg) {
  const ops = []; const problems = []; const ids = {};
  const owner = readUser(io, cfg.owner);
  if (!owner.exists) problems.push(`the owner's Mac user ${cfg.owner} was not found${owner.error ? ` (${owner.error})` : ''}`);
  else ids.owner = { uid: owner.uid, gid: owner.gid };
  let c;
  try { c = census(io); } catch (e) { return { ops, problems: [...problems, e.message], ids }; }
  const allocated = new Set();
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
    // Every id already set must be a number in the setup's range, never root's: a stray one (an old group, a user cut off
    // with a bad number) is named, not taken over.
    for (const [w, v] of idWords) {
      const n = Number(v);
      if (!Number.isInteger(n)) bad.push(`${w} ${v} is not a number`);
      else if (n === 0) bad.push(`${w} is root's id (0)`);
      else if (!inRange(n)) bad.push(`${w} ${n} is outside ${USER_ID_RANGE.low}-${USER_ID_RANGE.high}, the numbers this setup uses`);
    }
    for (const k of ['GroupMembership', 'NestedGroups']) if (G.attrs[k] !== undefined) bad.push(`its group has ${k} set (${k === 'GroupMembership' ? 'members' : 'nested groups'}); it must have none`);
    let id = idWords.length ? Number(idWords[0][1]) : null;
    if (U.exists) {
      if (U.attrs.UserShell !== undefined && U.attrs.UserShell !== NO_SHELL) bad.push(`its shell is ${U.attrs.UserShell}, not ${NO_SHELL}`);
      if (U.attrs.IsHidden !== undefined && U.attrs.IsHidden !== '1') bad.push('it is not hidden');
      if (U.attrs.NFSHomeDirectory !== undefined && U.attrs.NFSHomeDirectory !== home) bad.push(`its home is ${U.attrs.NFSHomeDirectory}, not ${home}`);
      if (U.attrs.Password !== undefined && U.attrs.Password !== '*') bad.push('it has a password set (it must be \'*\', which matches nothing)');
      if (adminAnswer(io, name) !== 'no') bad.push('it is an admin (or that could not be checked)');
    }
    if (bad.length) { problems.push(`${name} exists but is not as needed: ${bad.join('; ')}. Nothing was changed; fix it in System Settings or delete the user, then run again`); continue; }
    if (id !== null) {
      if (usedIds(c, name).has(id) || allocated.has(id)) { problems.push(`${name}: its id ${id} is also used by another user or group; nothing was changed`); continue; }
    } else {
      const used = usedIds(c);
      id = USER_ID_RANGE.low;
      while (id <= USER_ID_RANGE.high && (used.has(id) || allocated.has(id))) id += 1;
      if (id > USER_ID_RANGE.high) { problems.push(`no free id between ${USER_ID_RANGE.low} and ${USER_ID_RANGE.high} for ${name}`); continue; }
    }
    allocated.add(id);
    ids[name] = { uid: id, gid: id };
    // Fresh, or finishing a half-made one: write only what is missing, group first (so a cut-off run leaves the same shapes).
    const want = (rec, kind, pairs) => {
      if (!rec.exists) ops.push(dsclOp(io, ['-create', `/${kind}/${name}`]));
      for (const [k, v] of pairs) if (rec.attrs[k] === undefined) ops.push(dsclOp(io, ['-create', `/${kind}/${name}`, k, v]));
    };
    want(G, 'Groups', [['PrimaryGroupID', String(id)], ['Password', '*']]);
    // The safe settings first (no shell, hidden, no password), the number last: a record cut off half way is never a usable account (L100 m6).
    want(U, 'Users', [['UserShell', NO_SHELL], ['IsHidden', '1'], ['Password', '*'], ['RealName', name], ['NFSHomeDirectory', home], ['PrimaryGroupID', String(id)], ['UniqueID', String(id)]]);
  }
  return { ops, problems, ids };
}

const ownerIds = (io, ids, who) => (who === 'root' ? { uid: io.rootUid, gid: 0 } : ids[who]);
/** The group a folder must have, or undefined when the person's own group is taken as it comes: a robot user's own, or wheel where the table pins it (L100 m1). */
const wantGidOf = (row, want) => (row.group === 'root' ? 0 : row.owner === 'owner' ? undefined : want.gid);
const modeText = (m) => m.toString(8).padStart(3, '0');
const expectedAcl = (row) => row.acl.map(aclText).sort();

/**
 * The access-list entries `ls -led` shows on `path`, normalised: { entries: ['user:x allow a,b'], error }. An entry that came
 * from the folder above (`inherited`) is shown as such, so it never equals an expected entry (a made folder may not keep one).
 */
export function aclEntries(io, path) {
  const r = io.run('/bin/ls', ['-led', io.at(path)]);
  if (r.status !== 0) return { entries: [], error: `could not read the access list (${r.stderr.trim().slice(0, 100)})` };
  const entries = [];
  for (const line of r.stdout.split('\n')) {
    if (!/^\s+\d+: /.test(line)) continue;
    const m = /^\s+\d+: (user|group):(\S+) (inherited )?(allow|deny) (\S+)\s*$/.exec(line);
    entries.push(m ? `${m[1]}:${m[2]}${m[3] ? ' inherited' : ''} ${m[4]} ${m[5].split(',').sort().join(',')}` : `unreadable entry: ${line.trim().slice(0, 80)}`);
  }
  return { entries: entries.sort(), error: null };
}

/** Set a folder's access list to exactly `row.acl`, on the folder itself (never through a link). */
function aclOp(io, row, seen = null) {
  return op(`set the access list of ${row.path} to ${row.acl.length ? row.acl.map(aclText).join('; ') : 'none'}`, () => {
    const st = io.lstat(row.path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${row.path} is now ${st.isSymbolicLink() ? 'a link' : 'not a folder'}; its access list was not touched`);
    // The very folder the plan saw (L100 m2): one swapped in since is not touched.
    const want = seen?.() ?? null;
    if (want && (st.ino !== want.ino || st.dev !== want.dev)) throw new Error(`${row.path} is not the folder the plan saw (it was replaced); its access list was not touched`);
    const run = (args) => {
      const r = io.run('/bin/chmod', ['-h', ...args, io.at(row.path)]);
      if (r.status !== 0) throw new Error(`could not set the access list of ${row.path} (${r.stderr.trim().slice(0, 120)})`);
    };
    // -h: act on the path itself even if it was swapped for a link a moment ago.
    run(['-N']);
    for (const e of row.acl) run(['+a', `${e.who} allow ${e.perms.join(',')}`]);
  });
}

/** Folders: { ops, problems }, given the ids from planUsers. New folders first (parents first), then owners and modes deepest first. */
export function planFolders(io, cfg, ids, rows = folderTable(cfg), { afterBase = [] } = {}) {
  const problems = []; const made = new Map();
  const makes = []; const fixes = [];
  for (const row of rows) {
    const want = ownerIds(io, ids, row.owner);
    if (!want) { problems.push(`${row.path}: no id for ${row.owner}, so its owner can't be set`); continue; }
    let st = null;
    try { st = io.lstat(row.path); } catch (e) { if (e?.code !== 'ENOENT') { problems.push(`${row.path} could not be read (${e?.code ?? e})`); continue; } }
    const modeDo = (gid, ino) => op(`set owner and mode of ${row.path}: chown ${want.uid}:${gid ?? 'same group'}, chmod ${modeText(row.mode)}   (${row.owner})`,
      () => io.secure(row.path, { uid: want.uid, gid, mode: row.mode, ...(ino ?? made.get(row.path) ?? {}) }));
    if (st === null) {
      makes.push(op(`mkdir -m 700 ${row.path}`, () => { io.mkdir(row.path, 0o700); const s = io.lstat(row.path); made.set(row.path, { ino: s.ino, dev: s.dev }); }));
      if (row.path === cfg.base) makes.push(...afterBase);   // root's note goes in the moment root has made the base
      fixes.push([modeDo(wantGidOf(row, want)), aclOp(io, row, () => made.get(row.path))]);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) { problems.push(`${row.path} exists but is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}; nothing was changed`); continue; }
    // A folder under the base is root's or the one user it is for (NEW-1): one owned by anyone else was put there by someone
    // else, and is not adopted (that would hand root's later work, and the next owner, to whoever made it).
    if (st.uid !== io.rootUid && st.uid !== want.uid) { problems.push(`${row.path} is owned by uid ${st.uid}, who is neither root nor ${row.owner}; it was not made by this setup and is not taken over. Nothing was changed`); continue; }
    const wantGid = wantGidOf(row, want);
    const group = [];
    if (st.uid !== want.uid || (wantGid !== undefined && st.gid !== wantGid) || (st.mode & 0o7777) !== row.mode) group.push(modeDo(wantGid, { ino: st.ino, dev: st.dev }));
    const acl = aclEntries(io, row.path);
    if (acl.error) { problems.push(`${row.path}: ${acl.error}`); continue; }
    if (JSON.stringify(acl.entries) !== JSON.stringify(expectedAcl(row))) group.push(aclOp(io, row, () => ({ ino: st.ino, dev: st.dev })));
    if (group.length) fixes.push(group);
  }
  return { ops: [...makes, ...fixes.reverse().flat()], problems };
}

/**
 * Null, or why the base is not one this setup made; `fresh` when it does not exist yet (root will make it). A base that is
 * already there must hold root's note (BASE_MARKER): a plain file, root's, written by no one else. Without it the folder was
 * made by someone else (perhaps with hooks already planted in it) and is refused, never adopted (NEW-1).
 */
export function baseProblem(io, cfg) {
  let st;
  try { st = io.lstat(cfg.base); } catch (e) { return e?.code === 'ENOENT' ? { fresh: true } : { problem: `${cfg.base} could not be read (${e?.code ?? e})` }; }
  const m = baseMarkerPath(cfg);
  const why = `${cfg.base} already exists but was not made by this setup (it has no root-owned ${BASE_MARKER} note in it). It is not taken over. If it is yours, move it away or pick another base in the config; nothing was changed`;
  if (st.isSymbolicLink() || !st.isDirectory()) return { problem: `${cfg.base} exists but is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}; nothing was changed` };
  let ms; try { ms = io.lstat(m); } catch { return { problem: why }; }
  if (ms.isSymbolicLink() || ms.isDirectory() || ms.uid !== io.rootUid || (ms.mode & 0o022)) return { problem: why };
  return {};
}

/** Both parts: { ops, problems }. The chain above the base is checked first; with a problem there, no op at all. */
export function plan(io, cfg) {
  const above = baseChainProblem(io, cfg);
  if (above) return { ops: [], problems: [`the folders above ${cfg.base} are not safe for root to work in: ${above}. Nothing was changed.`] };
  const b = baseProblem(io, cfg);
  if (b.problem) return { ops: [], problems: [b.problem] };
  const u = planUsers(io, cfg);
  // Root's note goes in right after root makes the base (so a run cut off half way can be picked up, and a base that was
  // there before the run never has one).
  const marker = [{
    text: `write ${baseMarkerPath(cfg)} (root's note that this setup made ${cfg.base})`,
    run: () => { io.write(baseMarkerPath(cfg), 'made by the orchestrate setup; delete the whole folder to start over\n', 0o444); io.secureFile(baseMarkerPath(cfg), { uid: io.rootUid, gid: 0, mode: 0o444 }); },
  }];
  const f = planFolders(io, cfg, u.ids, folderTable(cfg), { afterBase: b.fresh ? marker : [] });
  const ops = [...u.ops, ...f.ops];
  return { ops: ops.length ? [guardOp(io, cfg), ...ops] : ops, problems: [...u.problems, ...f.problems] };
}

export function apply(ops, { log = () => {} } = {}) {
  for (const o of ops) { log(o.text); o.run(); }
}

const SUDO_NOT_ALLOWED = /is not allowed to run sudo/;

/** Read only. → [{ ok, what, why?, skip? }], one per item. A `skip` item is not a FAIL: it needs root to be read. */
export function check(io, cfg, { alsoKnown = [] } = {}) {
  const out = [];
  const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const skip = (what, why) => out.push({ ok: true, skip: true, what, why });
  const ids = {};
  let c = null; let censusError = null;
  try { c = census(io); } catch (e) { censusError = e.message; }
  for (const name of USERS) {
    const u = readUser(io, name); const g = readGroup(io, name);
    item(u.exists, `user ${name} exists`, u.error ?? 'not found');
    if (!u.exists) continue;
    ids[name] = { uid: u.uid, gid: u.gid };
    item(u.uid !== 0, `user ${name} is not root`, 'its id is 0');
    item(inRange(u.uid), `user ${name}'s id is in ${USER_ID_RANGE.low}-${USER_ID_RANGE.high}`, `id is ${u.uid}`);
    item(g.exists && g.gid === u.gid, `user ${name}'s main group is the group ${name}`, `group ${name}: ${g.exists ? g.gid : 'missing'}, user's main group: ${u.gid}`);
    if (c) {
      const sharers = c.uids.filter(([n, id]) => id === u.uid && n !== name).map(([n]) => n);
      item(sharers.length === 0, `user ${name}'s id belongs to no other user`, `also the id of ${sharers.join(', ')}`);
      const groupSharers = c.gids.filter(([n, id]) => id === u.gid && n !== name).map(([n]) => n);
      item(groupSharers.length === 0, `group ${name}'s id belongs to no other group`, `also the id of group ${groupSharers.join(', ')}`);
    } else item(false, `user ${name}'s id is used by no other account`, censusError);
    item(u.shell === NO_SHELL, `user ${name} has no login shell`, `shell is ${u.shell || 'unset'}`);
    item(u.hidden, `user ${name} is hidden`, 'IsHidden is not 1');
    item(u.home === homeOf(cfg, name), `user ${name}'s home is ${homeOf(cfg, name)}`, `home is ${u.home || 'unset'}`);
    const a = adminAnswer(io, name);
    item(a === 'no', `user ${name} is not an admin`, a === 'yes' ? 'it is an admin' : 'the admin check gave no clear answer');
    // No way to sign in: a password that matches nothing, and no authentication record or password hash.
    const rec = readRecord(io, 'Users', name, ['Password', ...LOGIN_KEYS]);
    item(rec.attrs.Password === '*', `user ${name} has no password (it is '*')`, `Password is ${rec.attrs.Password === undefined ? 'unset' : 'something else'}`);
    // The password hash can be read by root only: a check that cannot see it says so (NEEDS ROOT), it never says PASS (L100 m5).
    const login = (io.euid() === 0 ? LOGIN_KEYS : LOGIN_KEYS.filter((k) => k !== 'ShadowHashData')).filter((k) => rec.attrs[k] !== undefined);
    if (login.length) item(false, `user ${name} has no sign-in record`, `it has ${login.join(', ')}`);
    else if (io.euid() === 0) item(true, `user ${name} has no sign-in record`);
    else skip(`user ${name} has no sign-in record`, 'needs root to read the password hash; run check with sudo');
    const grec = readRecord(io, 'Groups', name, GROUP_KEYS);
    const members = ['GroupMembership', 'NestedGroups'].filter((k) => grec.attrs[k] !== undefined);
    item(members.length === 0, `group ${name} has no members and no nested groups`, `it has ${members.join(', ')}`);
    if (io.euid() === 0) {
      const s = io.run(SUDO, ['-n', '-l', '-U', name]);
      item(SUDO_NOT_ALLOWED.test(`${s.stdout}\n${s.stderr}`), `user ${name} has no sudo rule`, `sudo says: ${`${s.stdout} ${s.stderr}`.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    } else skip(`user ${name} has no sudo rule`, 'needs root to read; run check with sudo');
  }
  const o = readUser(io, cfg.owner);
  item(o.exists, `owner ${cfg.owner} exists`, 'not found');
  if (o.exists) ids.owner = { uid: o.uid, gid: o.gid };
  {
    const uids = [0, ...(ids.owner ? [ids.owner.uid] : []), ...USERS.filter((n) => ids[n]).map((n) => ids[n].uid)];
    const gids = USERS.filter((n) => ids[n]).map((n) => ids[n].gid);
    const dup = uids.filter((x, i) => uids.indexOf(x) !== i);
    item(dup.length === 0, 'the three users, the owner and root all have different ids', `shared id(s): ${[...new Set(dup)].join(', ')}`);
    item(new Set(gids).size === gids.length, 'the three users have different groups', `shared group id(s) among ${gids.join(', ')}`);
  }
  const above = baseChainProblem(io, cfg);
  item(above === null, `folders above ${cfg.base} are root's alone, no links, no access lists`, above);
  { const b = baseProblem(io, cfg); item(!b.problem && !b.fresh, `${cfg.base} was made by this setup (root's ${BASE_MARKER} note is in it)`, b.problem ?? 'the base does not exist'); }
  const tableRows = folderTable(cfg);
  folderChecks(io, tableRows, ids, item, { known: new Set([...tableRows.map((r) => r.path), baseMarkerPath(cfg), ...alsoKnown]) });
  return out;
}

/** The owner, group, mode and exact access list of each row's folder → item(ok, what, why). Read only. `known`: the paths a root-owned folder may hold. */
export function folderChecks(io, rows, ids, item, { known = new Set(rows.map((r) => r.path)) } = {}) {
  for (const row of rows) {
    const what = `${row.path} (${row.owner}, ${modeText(row.mode)})`;
    let st; try { st = io.lstat(row.path); } catch { item(false, what, 'missing'); continue; }
    if (st.isSymbolicLink()) { item(false, what, 'is a link'); continue; }
    if (!st.isDirectory()) { item(false, what, 'is not a folder'); continue; }
    const want = ownerIds(io, ids, row.owner);
    const why = [];
    if (!want) why.push(`no id for ${row.owner}`);
    else {
      if (st.uid !== want.uid) why.push(`owner is uid ${st.uid}, want ${want.uid} (${row.owner})`);
      const wantGid = wantGidOf(row, want);
      if (wantGid !== undefined && st.gid !== wantGid) why.push(`group is ${st.gid}, want ${wantGid}`);
    }
    // A folder only root writes holds only what the table names (and the base its note): anything else was put there by
    // someone, and could be code root or a robot will run (NEW-1).
    if (row.owner === 'root') {
      let names = null; try { names = io.list(row.path); } catch { why.push('its contents could not be listed'); }
      const extra = (names ?? []).filter((n) => !known.has(`${row.path}/${n}`));
      if (extra.length) why.push(`holds ${extra.length === 1 ? 'an entry' : 'entries'} the setup did not make: ${extra.slice(0, 5).join(', ')}`);
    }
    if ((st.mode & 0o7777) !== row.mode) why.push(`mode is ${modeText(st.mode & 0o7777)}, want ${modeText(row.mode)}`);
    const acl = aclEntries(io, row.path);
    if (acl.error) why.push(acl.error);
    else {
      const want2 = expectedAcl(row);
      const missing = want2.filter((e) => !acl.entries.includes(e)); const extra = acl.entries.filter((e) => !want2.includes(e));
      if (missing.length) why.push(`access list is missing: ${missing.join('; ')}`);
      if (extra.length) why.push(`access list has an entry that is not wanted: ${extra.join('; ')}`);
    }
    item(why.length === 0, what, why.join('; '));
  }
}
