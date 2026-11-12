// The host.lock copier (L757 fallback, README Part 6 step 5; L1029 E). host.lock stays in the synced folder, because the
// lock between the Macs needs the sync, but macOS's privacy protection guards that folder, so the Dispatcher's background
// job (orchestrate) can't read it there. A small job of the owner's own copies it, every 60 s, to a plain folder of the
// owner's outside the guarded ones; the setup config's `hostLockPath` names the copy, and `hostLockSource` the synced file.
//
// - The copy mirrors the source: the source's text when it is there, and no copy when it is not (the Dispatcher reads a
//   missing host.lock as "no host claimed"). It is the owner's file, so the Dispatcher's owner check holds; 0644, so
//   orchestrate can read it; written beside its name and renamed over it, so a reader never finds it half written.
// - Each run that read the source (or saw it missing) writes a stamp beside the copy (`<copy>.copied`): when, and whether
//   the source was there. A run that couldn't read it writes nothing, so the copy is left as it was and the stamp ages.
//   check-dispatcher refuses a stamp older than COPY_MAX_AGE_MS, or one it can't read: a copier that stopped, or that
//   macOS stops reading the synced folder, is told rather than read as a still-current copy.
// - The source is read as the Dispatcher reads host.lock (worker-ports.mjs): opened without following a link, one plain
//   file of this user's own with one name, of at most HOST_LOCK_MAX bytes. Anything else is refused and nothing is written.
//
// The job: `node host-lock-copy.mjs <setup config>`, as the owner (a LaunchAgent, setup.mjs host-lock-copier), from the
// installed copy. It reads the same setup config the rest of setup reads, so the two paths have one source.

import * as realFs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_LOCK_MAX } from '../wiring/worker-ports.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';

export const STAMP_SUFFIX = '.copied';
export const stampPath = (copy) => `${copy}${STAMP_SUFFIX}`;
/** The job runs every 60 s (loginJobPlist's beat); five missed runs is a copier that stopped. */
export const COPY_MAX_AGE_MS = 5 * 60_000;
/** How far ahead of this Mac's clock a stamp may be (a stamp from the future is not a fresh one). */
export const COPY_AHEAD_MS = 60_000;
export const COPIER_JOB = 'host-lock-copy';
export const COPIER_SCRIPT = 'setup/host-lock-copy.mjs';
const MODE = 0o644;

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = realFs.constants;

/** The source's bytes, null when it is not there, or throws with the reason (nothing is written then). Bytes, not text, so the copy is the file byte for byte. */
function readSource(fs, from, uid) {
  let fd;
  try { fd = fs.openSync(from, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch (e) {
    if (e?.code === 'ENOENT') {
      // Missing is "no host claimed" only when its folder is there: a wrong path is told, never copied as "no host".
      let up; try { up = fs.statSync(dirname(from)); } catch (u) { throw new Error(`the synced host.lock's folder ${dirname(from)} can't be read (${u?.code ?? u})`); }
      if (!up.isDirectory()) throw new Error(`the synced host.lock's folder ${dirname(from)} is not a folder`);
      return null;
    }
    if (e?.code === 'ELOOP') throw new Error(`the synced host.lock ${from} is a link; it must be the file itself`);
    // Never "give node Full Disk Access" (L1029 E review M1): the Dispatcher, robot and watch jobs run the installed copy's
    // same node as orchestrate, so that grant would open the guarded folders to all of them. A refused read stops here.
    if (e?.code === 'EPERM' || e?.code === 'EACCES') throw new Error(`the synced host.lock ${from} can't be read (${e.code}). If macOS's privacy protection is refusing this job too, stop and tell the lead: do not give the installed copy's node Full Disk Access, since the Dispatcher's, robot's and watch jobs run that same node (README, Part 6 step 5)`);
    throw new Error(`the synced host.lock ${from} can't be read (${e?.code ?? e})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.uid !== uid) throw new Error(`the synced host.lock ${from} is not this user's file (its owner is uid ${st.uid})`);
    if (!st.isFile()) throw new Error(`the synced host.lock ${from} is not a plain file`);
    if (st.nlink !== 1) throw new Error(`the synced host.lock ${from} has another name too (a hard link)`);
    const b = Buffer.alloc(HOST_LOCK_MAX + 1); let n = 0;
    for (;;) { const k = fs.readSync(fd, b, n, b.length - n, null); if (k === 0) break; n += k; if (n === b.length) break; }
    if (n > HOST_LOCK_MAX) throw new Error(`the synced host.lock ${from} is over ${HOST_LOCK_MAX} bytes`);
    return Buffer.from(b.subarray(0, n));
  } finally { fs.closeSync(fd); }
}

/**
 * Writes `data` at `to`, 0644, beside its name first and renamed over it. A leftover `.new` from a cut-off run is replaced.
 * One temp name, not one per run: launchd never starts a job's next run while one is going, and a per-run name would leave
 * a file behind for each cut-off run.
 */
function putFile(fs, to, data) {
  const tmp = join(dirname(to), `.${basename(to)}.new`);
  try { fs.unlinkSync(tmp); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, MODE);
  try { fs.writeSync(fd, data); fs.fchmodSync(fd, MODE); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, to);
}

/** The copy's folder must be a plain folder of this user's own that only they can write: anyone else could swap the copy. */
function folderProblem(fs, dir, uid) {
  let st; try { st = fs.lstatSync(dir); } catch (e) { return `the copy's folder ${dir} can't be read (${e?.code ?? e}); make it first (README, Part 6)`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `the copy's folder ${dir} is not a plain folder`;
  if (st.uid !== uid) return `the copy's folder ${dir} is not this user's (its owner is uid ${st.uid})`;
  if (st.mode & 0o022) return `the copy's folder ${dir} can be written by its group or others`;
  return null;
}

/**
 * One run: { from, to, now?, fs?, uid? } → { ok: true, did: 'copied' | 'same' | 'removed' | 'none' } or { ok: false, why }.
 * On a refusal nothing is written, the stamp included.
 */
export function copyHostLock({ from, to, now = Date.now(), fs = realFs, uid = process.getuid() }) {
  try {
    if (typeof from !== 'string' || typeof to !== 'string' || !from.startsWith('/') || !to.startsWith('/') || from === to) throw new Error('the copier needs the synced host.lock and the copy, two different full paths');
    const bad = folderProblem(fs, dirname(to), uid);
    if (bad) throw new Error(bad);
    const bytes = readSource(fs, from, uid);
    let did;
    if (bytes === null) {
      try { fs.unlinkSync(to); did = 'removed'; } catch (e) { if (e?.code !== 'ENOENT') throw e; did = 'none'; }
    } else {
      let cur = null;
      try { const st = fs.lstatSync(to); if (st.isFile() && st.uid === uid && st.nlink === 1 && (st.mode & 0o777) === MODE) cur = fs.readFileSync(to); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      if (cur !== null && Buffer.compare(cur, bytes) === 0) did = 'same'; else { putFile(fs, to, bytes); did = 'copied'; }
    }
    putFile(fs, stampPath(to), `${JSON.stringify({ at: new Date(now).toISOString(), source: bytes === null ? 'absent' : 'present' })}\n`);
    return { ok: true, did };
  } catch (e) { return { ok: false, why: e?.message ?? String(e) }; }
}

/**
 * Why the copier's stamp beside `copy` does not show a run within COPY_MAX_AGE_MS, or null. `io.lstat` and `io.readText`
 * read it; `ownerUid` is the owner's (the copier runs as them).
 */
export function stampProblem(io, copy, { now, ownerUid }) {
  const p = stampPath(copy);
  let st; try { st = io.lstat(p); } catch (e) {
    return e?.code === 'ENOENT' ? `the copier has never finished a run (${p} is not there): load its job (setup.mjs host-lock-copier) and read its log` : `${p} can't be looked at (${e?.code ?? e})`;
  }
  if (!st.isFile()) return `${p} is not a plain file`;
  if (st.uid !== ownerUid) return `${p} is not the owner's (its owner is uid ${st.uid}), so the owner's copier did not write it`;
  let at;
  try { at = Date.parse(JSON.parse(io.readText(p))?.at); } catch { at = NaN; }
  if (!Number.isFinite(at)) return `${p} can't be read as the copier's stamp`;
  if (at - now > COPY_AHEAD_MS) return `${p} says the copier ran at ${new Date(at).toISOString()}, ahead of this Mac's clock`;
  if (now - at > COPY_MAX_AGE_MS) return `the copier's last good run was at ${new Date(at).toISOString()}, over ${COPY_MAX_AGE_MS / 60_000} minutes ago, so the copy may be old. The job has stopped, or it can't read the synced host.lock: read its log (${join(dirname(copy), `${COPIER_JOB}.err.log`)})`;
  return null;
}

/**
 * The copier's LaunchAgent text: the owner's own job (no UserName), from the installed copy's node and this script, with the
 * setup config as its one argument. Its logs and working folder are the copy's folder, the owner's own (the install's log
 * folder is root's). `installRoot` is installPaths(cfg).installRoot; `node` its NODE.
 */
export function copierPlist({ label, installRoot, node, configPath, copy, home }) {
  return loginJobPlist({
    label: `${label}.${COPIER_JOB}`, node: join(installRoot, node), script: join(installRoot, COPIER_SCRIPT), config: configPath,
    path: '/usr/bin:/bin', logDir: dirname(copy), workDir: dirname(copy), logName: COPIER_JOB, home, umask: 0o022,
  });
}

// The job's entry: one run, one line, exit 1 on a refusal so launchd shows the last run failed.
const isMain = (() => { try { return !!process.argv[1] && realFs.realpathSync(process.argv[1]) === realFs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  // A read that hangs (a synced file macOS has not fetched yet) must not hold the job: launchd starts no next run while one
  // is going, so a stuck run would stop the copier for good. 20 s, well inside the 60 s beat; the stamp then ages and is told.
  setTimeout(() => { process.stderr.write(`${new Date().toISOString()} host.lock copier: gave up after 20 s (the synced host.lock did not answer)\n`); process.exit(1); }, 20_000).unref();
  const { parseConfig } = await import('./layout.mjs');
  let cfg;
  try { cfg = parseConfig(JSON.parse(realFs.readFileSync(process.argv[2], 'utf8'))); } catch (e) {
    process.stderr.write(`${new Date().toISOString()} host.lock copier: the setup config can't be read (${e?.message ?? e})\n`); process.exit(1);
  }
  if (cfg.hostLockSource === undefined) { process.stderr.write(`${new Date().toISOString()} host.lock copier: the setup config names no hostLockSource\n`); process.exit(1); }
  const r = copyHostLock({ from: cfg.hostLockSource, to: cfg.hostLockPath });
  if (!r.ok) { process.stderr.write(`${new Date().toISOString()} host.lock copier: refused: ${r.why}\n`); process.exit(1); }
  if (r.did !== 'same' && r.did !== 'none') process.stdout.write(`${new Date().toISOString()} host.lock copier: ${r.did}\n`);
}
