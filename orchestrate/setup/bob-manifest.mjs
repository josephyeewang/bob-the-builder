// The Bob method folder the sessions read, and its pinned file list (launch check 13, L994, L995):
//
//   sudo /usr/local/bin/node setup.mjs bob --from <a Bob checkout> --commit <40-hex sha> [--dry-run]      (root)
//
// One step puts both in place from one source, so what was installed is what check 13 checks:
//   - the folder: every file of that commit, read from the checkout's git (run as the owner, never as root, replace refs
//     off: root only reads the raw objects git prints, checks each against its id and walks the folders itself), written into bobPath (layout.mjs; orchestrate's, 0755, its files root's). Left out, as
//     launch.mjs checkBobFolder refuses them: any SKILL.md and anything under a skill/ or skills/ folder (any case). A
//     link or another repository (a submodule) anywhere else is refused, and so is a commit whose paths would land on
//     one another on a disk that ignores case;
//   - the list: `{ path: sha256 }` of what LANDED in the new folder (each file read back from the disk, not from git),
//     and the commit beside it, in the installed copy (BOB_MANIFEST, BOB_COMMIT: root's, 0644), and both added to the
//     updater's keep so an update carries them. review-config names BOB_MANIFEST as the runner's bobManifest.
// --commit must be 40 lower-case hex characters naming a commit present in --from. Changing Bob means running this again.
//
// The pair moves together. Everything new is made beside the old first (.bob-new, *.adding); then the old folder is
// renamed aside, the new one into place, and the list over the old list. A step that fails puts the old folder back, so
// the old pair stays in force. The one window this can't close is a crash between those renames: the folder is then
// new (or missing) and the list old, which check 13 refuses ("differs from the pinned Bob commit", "is missing"); it
// never passes a folder against a list that is not its own. A run after a crash first puts a missing folder back from
// .bob-old (or, with both there, keeps the one that matches the list in force), then builds the pair afresh. The commit file is renamed after the list: a failure between leaves the new
// pair in force and says so (run it again).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { UPDATER_CONFIG, currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { readUpdaterConfig } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { foldKey } from '../shared/plan-fingerprint.mjs';
import { bobPath } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';

export const BOB_MANIFEST = 'bob-manifest.json';
export const BOB_COMMIT = 'bob-commit.txt';
export const BOB_NEW = '.bob-new';
export const BOB_OLD = '.bob-old';
const ADDING = '.adding';
// The review runner reads the list whole, up to its own cap (review-runner-main.mjs MAX_CARD_BYTES): a longer one it refuses.
export const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20000;
const SHA = /^[0-9a-f]{40}$/;
const SUDO = '/usr/bin/sudo';
const ENV = '/usr/bin/env';
const GIT_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const absPath = (p) => typeof p === 'string' && isAbsolute(p) && posix.normalize(p) === p && p !== '/' && !p.includes('\0') && !p.includes('\n');
const op = (text, run) => ({ text, run });

/** Where the list sits in the installed copy (what review-config names as bobManifest). */
export const bobManifestPath = (cfg) => join(installPaths(cfg).installRoot, BOB_MANIFEST);

/** Left out of the folder, exactly as launch.mjs checkBobFolder refuses them: a SKILL.md, or a skill/ or skills/ folder, in any case. */
export function leftOut(path) {
  const parts = path.split('/');
  return parts.at(-1).toLowerCase() === 'skill.md' || parts.slice(0, -1).some((p) => ['skill', 'skills'].includes(p.toLowerCase()));
}

/** A path from the tree is written only when each part is a plain name: no empty part, `.`, `..` or `.git`, no NUL or newline. */
const plainPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !/[\0\n\r]/.test(p)
  && p.split('/').every((x) => x !== '' && x !== '.' && x !== '..' && foldKey(x) !== '.git');

/**
 * The checkout's git, as its owner (L995: root only reads what it prints). `git(args, input)` → { status, stdout: Buffer, stderr }.
 * As root it runs through sudo as `cfg.owner`; without root (a dry run) as whoever runs it.
 */
export function bobGit(io, cfg, from, { run = spawnSync } = {}) {
  return (args, input) => {
    const cmd = [cfg.gitBin ?? '/usr/bin/git', '--no-replace-objects', '-C', from, ...args];
    // sudo resets the environment, so git's own is set after it, through env (PR-1 r1 m1).
    const [file, argv] = io.euid() === 0 ? [SUDO, ['-n', '-H', '-u', cfg.owner, ENV, ...Object.entries(GIT_ENV).map(([k, v]) => `${k}=${v}`), ...cmd]] : [cmd[0], cmd.slice(1)];
    const r = run(file, argv, { input, env: GIT_ENV,
      timeout: 300_000, maxBuffer: MAX_TOTAL_BYTES + 64 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
  };
}

/** A git object's id, as git computes it (sha1 of `<type> <size>\0` and the bytes): root checks every object git hands it. */
const objectId = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Objects by id, through one `cat-file --batch`: → { got: Map(oid → { type, bytes }), problem }. Each is refused unless its
 * bytes hash to the id asked for (PR-1 r1 M1: git trusts its own storage and its replace refs; root trusts neither).
 */
function readObjects(git, oids, said) {
  const cat = git(['cat-file', '--batch'], Buffer.from(oids.map((o) => `${o}\n`).join('')));
  if (cat.status !== 0) return { got: null, problem: `the commit's objects could not be read (${said(cat)})` };
  const out = cat.stdout; let at = 0; const got = new Map();
  for (const oid of oids) {
    const nl = out.indexOf(0x0a, at);
    const head = nl < 0 ? '' : out.subarray(at, nl).toString('utf8');
    if (head === `${oid} missing`) { got.set(oid, { type: 'missing', bytes: null }); at = nl + 1; continue; }
    const m = /^([0-9a-f]{40}) (blob|tree|commit|tag) (\d+)$/.exec(head);
    if (!m || m[1] !== oid) return { got: null, problem: `git gave something other than object ${oid}` };
    const size = Number(m[3]);
    if (size > MAX_FILE_BYTES) return { got: null, problem: `object ${oid} is over ${MAX_FILE_BYTES} bytes` };
    const bytes = Buffer.from(out.subarray(nl + 1, nl + 1 + size));
    if (bytes.length !== size || out[nl + 1 + size] !== 0x0a) return { got: null, problem: `git gave object ${oid} cut short` };
    if (objectId(m[2], bytes) !== oid) return { got: null, problem: `git gave object ${oid} with contents that are not its own (a replaced or changed object)` };
    got.set(oid, { type: m[2], bytes });
    at = nl + 2 + size;
  }
  return { got, problem: null };
}

/** A tree object's entries: [{ mode, name, oid }], or null when it is not in git's form or a name is not UTF-8. */
function treeEntries(bytes) {
  const out = []; let at = 0;
  while (at < bytes.length) {
    const sp = bytes.indexOf(0x20, at); const nul = sp < 0 ? -1 : bytes.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > bytes.length) return null;
    const mode = bytes.subarray(at, sp).toString('latin1'); const raw = bytes.subarray(sp + 1, nul); const name = raw.toString('utf8');
    if (!/^[0-7]{5,6}$/.test(mode) || !Buffer.from(name, 'utf8').equals(raw) || name.includes('/')) return null;
    out.push({ mode: mode.padStart(6, '0'), name, oid: bytes.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return out;
}

/**
 * The commit's files, read through `git` as raw objects, each checked against its id in root, the trees walked here
 * (never git's own listing): → { files: [{ path, exec, bytes }], skipped, problems }. Never quotes git's output beyond a path.
 */
export function readCommit(git, commit) {
  const problems = [];
  const said = (r) => r.stderr.trim().split('\n')[0]?.slice(0, 200) || `exit ${r.status}`;
  const top = readObjects(git, [commit], said);
  if (top.problem) return { files: [], skipped: 0, problems: [top.problem] };
  const c = top.got.get(commit);
  if (c.type !== 'commit') return { files: [], skipped: 0, problems: [`--commit ${commit} is not a commit in --from (it is ${c.type === 'missing' ? 'missing' : `a ${c.type}`})`] };
  const tm = /^tree ([0-9a-f]{40})\n/.exec(c.bytes.toString('latin1'));
  if (!tm) return { files: [], skipped: 0, problems: ['the commit is not in the form git gives'] };
  const entries = []; let skipped = 0; let trees = 0;
  let level = [{ oid: tm[1], prefix: '' }];
  while (level.length && !problems.length) {
    trees += level.length;
    if (trees > MAX_FILES) { problems.push(`the commit holds more than ${MAX_FILES} folders`); break; }
    const r = readObjects(git, [...new Set(level.map((t) => t.oid))], said);
    if (r.problem) return { files: [], skipped, problems: [r.problem] };
    const next = [];
    for (const t of level) {
      const o = r.got.get(t.oid);
      const list = o.type === 'tree' ? treeEntries(o.bytes) : null;
      if (!list) { problems.push(`the commit's folder ${t.prefix || '(top)'} is not a tree in the form git gives`); break; }
      for (const e of list) {
        const path = `${t.prefix}${e.name}`;
        if (e.mode === '040000') { if (!plainPath(path)) problems.push(`the commit holds a path that is not plain (${JSON.stringify(path.slice(0, 200))})`); else next.push({ oid: e.oid, prefix: `${path}/` }); continue; }
        if (!plainPath(path)) { problems.push(`the commit holds a path that is not plain (${JSON.stringify(path.slice(0, 200))})`); continue; }
        if (leftOut(path)) { skipped++; continue; }
        if (e.mode === '120000') { problems.push(`the commit holds a link (${path}); the Bob folder holds none`); continue; }
        if (e.mode === '160000') { problems.push(`the commit holds another repository (${path}); the Bob folder holds plain files only`); continue; }
        if (e.mode !== '100644' && e.mode !== '100755') { problems.push(`the commit holds ${path} as ${e.mode}, not a plain file`); continue; }
        entries.push({ path, oid: e.oid, exec: e.mode === '100755' });
        if (entries.length > MAX_FILES) break;
      }
      if (entries.length > MAX_FILES) break;
    }
    level = next;
    if (entries.length > MAX_FILES) break;
  }
  if (entries.length > MAX_FILES) problems.push(`the commit holds more than ${MAX_FILES} files`);
  if (!entries.length && !problems.length) problems.push('the commit holds no file the Bob folder would keep');
  // Two paths that differ only in case, or in how an accented letter is spelled, are one path on the Mac's disk.
  const seen = new Map();
  for (const e of problems.length ? [] : entries) {
    const parts = e.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const shown = parts.slice(0, i).join('/'); const key = foldKey(shown); const kind = i === parts.length ? 'file' : 'dir';
      const was = seen.get(key);
      if (was && (was.kind !== kind || was.shown !== shown || kind === 'file')) { problems.push(`the commit's ${shown} and ${was.shown} would land on one another on a disk that ignores case`); break; }
      seen.set(key, { kind, shown });
    }
  }
  if (problems.length) return { files: [], skipped, problems };
  let total = 0;
  const blobs = readObjects(git, [...new Set(entries.map((e) => e.oid))], said);
  if (blobs.problem) return { files: [], skipped, problems: [blobs.problem] };
  const files = [];
  for (const e of entries) {
    const b = blobs.got.get(e.oid);
    if (b.type !== 'blob') return { files: [], skipped, problems: [`git gave something other than ${e.path}'s contents`] };
    total += b.bytes.length;
    if (total > MAX_TOTAL_BYTES) return { files: [], skipped, problems: [`the commit's files come to more than ${MAX_TOTAL_BYTES} bytes`] };
    files.push({ path: e.path, exec: e.exec, bytes: b.bytes });
  }
  return { files, skipped, problems: [] };
}

/** `{ path: sha256 }` for every file under `real`, read from the disk as launch.mjs listFiles walks it; a link or anything not a plain file throws. */
export function landedList(real) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n); const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${relative(real, p)} landed as a link`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relative(real, p)] = sha256(readFileSync(p));
      else throw new Error(`${relative(real, p)} landed as neither a file nor a folder`);
    }
  };
  walk(real);
  return out;
}

/** The list as written: its keys in order, one JSON object. */
export const manifestText = (list) => `${JSON.stringify(Object.fromEntries(Object.keys(list).sort().map((k) => [k, list[k]])), null, 1)}\n`;

const exists = (io, p) => { try { io.lstat(p); return true; } catch { return false; } };
/** Whether the folder holds exactly the list's files (false when either can't be read). */
const matchesList = (io, folder, list) => { try { return manifestText(landedList(io.at(folder))) === manifestText(JSON.parse(readFileSync(io.at(list), 'utf8'))); } catch { return false; } };

/**
 * The plan: { ops, problems, installed }. `git` is bobGit's port (a test's stand-in). Every refusal comes before any change.
 */
export function planBob(io, cfg, { from, commit, git }) {
  const problems = [];
  if (typeof commit !== 'string' || !SHA.test(commit)) problems.push('--commit must be the full commit: 40 lower-case hex characters');
  if (!absPath(from)) problems.push('--from must be the full path of a Bob checkout, in its simplest form');
  else { let st = null; try { st = lstatSync(from); } catch { /* below */ } if (!st?.isDirectory() || st.isSymbolicLink()) problems.push(`--from ${from} is not a folder (a link is not taken: name the folder itself)`); }
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing) problems.push(`${P.installRoot} is not installed yet: run install first`);
  else if (cur.problem || !cur.link) problems.push(`${P.installRoot}: ${cur.problem ?? 'is a plain folder, not the link the updater flips'}`);
  const orch = readUser(io, 'orchestrate');
  if (!orch?.exists || !Number.isInteger(orch.uid) || orch.uid <= 0) problems.push('the Mac user orchestrate (the Bob folder\'s owner) was not found; run users-folders first');
  if (problems.length) return { ops: [], problems: problems.map((p) => `${p}. Nothing was changed`), installed: false };

  const copy = join(P.install, relative(realpathSync(io.at(P.install)), cur.real));   // the real folder, by its own name: the link can't redirect a step
  let keep = null;
  try { keep = readUpdaterConfig(io.at(join(copy, UPDATER_CONFIG))); } catch (e) { problems.push(`the copy's ${UPDATER_CONFIG} was refused: ${e.message}`); }
  const got = readCommit(git, commit);
  problems.push(...got.problems);
  const want = Object.fromEntries(got.files.map((f) => [f.path, sha256(f.bytes)]));
  const text = manifestText(want);
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) problems.push(`the file list comes to ${Buffer.byteLength(text)} bytes, over the review runner's ${MAX_MANIFEST_BYTES}`);
  if (problems.length) return { ops: [], problems: problems.map((p) => `${p}. Nothing was changed`), installed: false };

  const bob = bobPath(cfg); const fresh = join(cfg.base, BOB_NEW); const aside = join(cfg.base, BOB_OLD);
  const temp = (n) => join(copy, `${n}${ADDING}`);
  const updater = { ...keep, keep: [...new Set([...keep.keep, BOB_MANIFEST, BOB_COMMIT])] };
  const rootFile = (p, data, mode) => { io.write(p, data, mode); io.secureFile(p, { uid: io.rootUid, gid: 0, mode }); };
  const ops = [
    op(`rm -rf ${fresh} and ${copy}/*${ADDING}; put ${aside} back if ${bob} is missing, else remove it   (leftovers of a cut-off run)`, () => {
      io.rm(fresh);
      for (const n of [BOB_MANIFEST, BOB_COMMIT, UPDATER_CONFIG]) io.rm(temp(n));
      if (exists(io, aside)) {
        // Both there: a crash came after the new folder went in and before the list. Keep whichever matches the list in force (PR-1 r1 m2).
        if (!exists(io, bob) || (matchesList(io, aside, join(copy, BOB_MANIFEST)) && !matchesList(io, bob, join(copy, BOB_MANIFEST)))) { io.rm(bob); io.rename(aside, bob); } else io.rm(aside);
      }
    }),
    op(`write the ${got.files.length} files of ${commit} into ${fresh} (left out: ${got.skipped} skill file(s))`, () => {
      io.mkdir(fresh, 0o755); io.secure(fresh, { uid: io.rootUid, gid: 0, mode: 0o755 });
      const made = new Set();
      for (const f of got.files) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const d = join(fresh, ...parts.slice(0, i));
          if (made.has(d)) continue;
          io.mkdir(d, 0o755); io.secure(d, { uid: io.rootUid, gid: 0, mode: 0o755 }); made.add(d);
        }
        rootFile(join(fresh, f.path), f.bytes, f.exec ? 0o755 : 0o644);
      }
    }),
    op(`read back what landed in ${fresh}: it must be exactly the commit's files`, () => {
      const landed = landedList(io.at(fresh));
      if (manifestText(landed) !== text) {
        const extra = Object.keys(landed).filter((k) => !Object.hasOwn(want, k)); const gone = Object.keys(want).filter((k) => !Object.hasOwn(landed, k));
        const changed = Object.keys(want).filter((k) => Object.hasOwn(landed, k) && landed[k] !== want[k]);
        throw new Error(`what landed in ${fresh} is not the commit's files (${[...extra.slice(0, 3).map((k) => `extra ${k}`), ...gone.slice(0, 3).map((k) => `missing ${k}`), ...changed.slice(0, 3).map((k) => `changed ${k}`)].join(', ')}); the old Bob folder and list are as they were`);
      }
    }),
    op(`write ${temp(BOB_MANIFEST)}, ${temp(BOB_COMMIT)} and ${temp(UPDATER_CONFIG)} (root's, 0644)`, () => {
      rootFile(temp(BOB_MANIFEST), text, 0o644); rootFile(temp(BOB_COMMIT), `${commit}\n`, 0o644);
      rootFile(temp(UPDATER_CONFIG), `${JSON.stringify(updater, null, 1)}\n`, 0o644);
    }),
    op(`set owner and mode of ${fresh}: orchestrate's, 0755 (layout.mjs)`, () => io.secure(fresh, { uid: orch.uid, gid: orch.gid, mode: 0o755 })),
    op(`swap in together: ${bob} → ${aside}, ${fresh} → ${bob}, then ${temp(BOB_MANIFEST)} → ${join(copy, BOB_MANIFEST)}; a failure puts the old folder back`, () => {
      const had = exists(io, bob);
      if (had) io.rename(bob, aside);
      const undo = (e, steps) => {
        try { steps(); } catch (u) { throw new Error(`${e.message}; putting the old Bob folder back failed too (${u.message}): ${bob} may be missing, with the old folder at ${aside}. Run it again: it puts that back first`); }
      };
      try { io.rename(fresh, bob); } catch (e) { undo(e, () => { if (had) io.rename(aside, bob); }); throw e; }
      try { io.rename(temp(BOB_MANIFEST), join(copy, BOB_MANIFEST)); } catch (e) {
        undo(e, () => { io.rename(bob, fresh); if (had) io.rename(aside, bob); });
        throw new Error(`${e.message}; the old Bob folder and list are as they were`);
      }
    }),
    op(`rename ${temp(BOB_COMMIT)} → ${join(copy, BOB_COMMIT)}, then ${temp(UPDATER_CONFIG)} → ${join(copy, UPDATER_CONFIG)} (it keeps both across an update)`, () => {
      try { io.rename(temp(BOB_COMMIT), join(copy, BOB_COMMIT)); io.rename(temp(UPDATER_CONFIG), join(copy, UPDATER_CONFIG)); } catch (e) {
        throw new Error(`${e.message}; the new Bob folder and list are in force, but the commit record or the updater's keep is not: run it again`);
      }
    }),
    op(`rm -rf ${aside}`, () => io.rm(aside)),
  ];
  return { ops, problems: [], installed: true };
}

/**
 * After a run: the folder holds exactly the list's files, and both are where the runners read them. → [{ ok, what, why }].
 */
export function checkBob(io, cfg, { commit: commitWanted = null } = {}) {
  const P = installPaths(cfg); const out = [];
  const item = (ok, what, why) => out.push({ ok, what, why });
  let list = null;
  try { list = JSON.parse(readFileSync(io.at(join(P.installRoot, BOB_MANIFEST)), 'utf8')); } catch (e) { item(false, `the Bob file list ${bobManifestPath(cfg)} can be read`, e?.code ?? 'not JSON'); return out; }
  item(true, `the Bob file list ${bobManifestPath(cfg)} can be read`);
  // As check 13 refuses them (launch.mjs checkBobFolder): an empty list, and a top that is a link or not a folder (PR-1 r2 m1).
  const isList = list !== null && typeof list === 'object' && !Array.isArray(list);
  item(isList && Object.keys(list).length > 0, `the Bob file list ${bobManifestPath(cfg)} names at least one file`, isList ? 'it is empty' : 'it is not a list');
  let top = null; try { top = io.lstat(bobPath(cfg)); } catch { /* below */ }
  if (!top || top.isSymbolicLink() || !top.isDirectory()) { item(false, `the Bob folder ${bobPath(cfg)} is a plain folder`, top ? 'it is a link or not a folder' : 'it is missing'); return out; }
  let landed = null;
  try { landed = landedList(io.at(bobPath(cfg))); } catch (e) { item(false, `the Bob folder ${bobPath(cfg)} holds only plain files`, e.message); return out; }
  item(manifestText(landed) === manifestText(list), `the Bob folder ${bobPath(cfg)} holds exactly the list's files`, 'it differs from the list');
  const want = typeof commitWanted === 'string' ? commitWanted : null;
  let commit = ''; try { commit = readFileSync(io.at(join(P.installRoot, BOB_COMMIT)), 'utf8').trim(); } catch { /* below */ }
  item(want === null ? SHA.test(commit) : commit === want, `the Bob commit${want === null ? '' : ` ${want}`} is recorded beside the list (${BOB_COMMIT})`, commit ? `it records ${commit.slice(0, 40)}` : 'it is missing');
  let keep = null; try { keep = readUpdaterConfig(io.at(join(P.installRoot, UPDATER_CONFIG))).keep; } catch { /* below */ }
  item([BOB_MANIFEST, BOB_COMMIT].every((n) => keep?.includes(n)), `the updater keeps ${BOB_MANIFEST} and ${BOB_COMMIT} across an update (${UPDATER_CONFIG})`, keep ? 'its keep list lacks them' : 'it can\'t be read');
  return out;
}

