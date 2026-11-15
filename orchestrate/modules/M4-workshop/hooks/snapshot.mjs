// M4's reader for the rules snapshot (launch check 8; review 0b-3 M4, m9).
//
// The rules publish a snapshot file the hooks and the launcher read instead of asking anything
// live. Shape assumed until lane 1's shared reader lands: { written_at: ISO, hash, rules } with
// hash = sha256 of JSON.stringify(rules). Missing, unreadable, bad hash, or older than 5 minutes
// means refuse.
//
// A stale snapshot refuses EVERY call, even `ls`, by design: the loop rewrites it every pass, so a
// stale one means nothing is keeping the rules current. The refusal says so (lane 3 corpus run).
// A run that writes its own snapshot (a test corpus, a fake) and lasts longer than the limit keeps
// it fresh with `keepSnapshotFresh`, never by raising the limit.

import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fstatSync, closeSync, lstatSync, readlinkSync, realpathSync, constants as FS } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const refuse = (reason) => ({ ok: false, reason });
/** What a root-owned read's refusals call the file by default: the machine-wide copy (L1031). */
const MACHINE_WIDE_COPY = 'the machine-wide rules copy';
/** What they call the worker sessions' snapshot, which root's worker-rules job writes (L1226). */
export const WORKER_RULES_COPY = 'the worker sessions\' rules snapshot (root\'s worker-rules job writes it)';

export const snapshotHash = (rules) => createHash('sha256').update(JSON.stringify(rules)).digest('hex');

// The worker sessions' snapshot is root's worker-rules job's (setup/worker-rules.mjs, every 60 s while the worker runner
// runs, L1226); the runner no longer writes one (L1252). keepSnapshotFresh stays for a run that writes its own.
export function staleReason(ageMs, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  return `rules snapshot is stale (${Math.round(ageMs / 1000)} s old, the limit is ${Math.round(maxAgeMs / 1000)} s), `
    + 'so every call is refused until it is rewritten; the loop rewrites it every pass for its own sessions, and '
    + 'root\'s worker-rules job every minute for the worker sessions while the worker runner runs (is it loaded? setup.mjs '
    + 'daemons check), so a stale one means whichever wrote it has stopped, or a run that wrote its own snapshot outlasted '
    + 'it (keep it fresh with keepSnapshotFresh)';
}
/** A refusal with a stale snapshot's age taken out (L1254 m1): the same refusal a second later reads the same, so whoever
 * tells a refusal once (runner-main.mjs rootSnapshots) does not tell it again only because the age grew. */
export const withoutAge = (reason) => String(reason).replace(/\(\d+ s old, the limit is (\d+) s\)/g, '(older than the limit of $1 s)');

export function parseSnapshot(text, { now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  let s; try { s = JSON.parse(text); } catch { return refuse('rules snapshot is not JSON'); }
  if (!s || typeof s !== 'object' || !s.rules || typeof s.rules !== 'object') return refuse('rules snapshot has no rules');
  if (typeof s.hash !== 'string' || snapshotHash(s.rules) !== s.hash) return refuse('rules snapshot hash does not match');
  const at = Date.parse(s.written_at);
  if (!Number.isFinite(at)) return refuse('rules snapshot has no time');
  const age = now - at;
  if (age > maxAgeMs) return refuse(staleReason(age, maxAgeMs));
  // A copy read with no age limit (the machine-wide one, L1031) is not judged by the clock at all: a clock stepped back after
  // it was written would otherwise block every session on the Mac until it caught up (L1044 m1).
  if (age < -60000 && Number.isFinite(maxAgeMs)) return refuse('rules snapshot is from the future');
  // `product` and `source_sha256` are the worker sessions' snapshot's own (setup/worker-rules.mjs, L1226): the worker
  // runner's check 8 compares them with its own (source_sha256: the sha256 of the bytes of the worker-runner.json root
  // read, L1238 m3); other snapshots have neither, and these are then undefined.
  return { ok: true, rules: s.rules, writtenAt: s.written_at, hash: s.hash, product: s.product, sourceSha256: s.source_sha256 };
}

/**
 * Reads the snapshot through one open handle, and only a plain file with one name (#439 m4): a second name (a hard link
 * made elsewhere) would let whoever holds that name change the rules the hooks read, from outside the walled folder.
 * The runner replaces the file by rename, so the snapshot it writes always has one name.
 */
export function readSnapshot(path, opts = {}) {
  const { ownerUid, what = MACHINE_WIDE_COPY, ...parseOpts } = opts;
  // The machine-wide copy (L1031): written once by root and never refreshed, so whoever could change it or rename it away
  // could switch the guard off for every session. Every folder above it must be root's and written by no one else. The
  // worker sessions' snapshot (L1226) is read the same way, root's alone, named by `what` in what a refusal says.
  if (ownerUid !== undefined) { const why = rootChainProblem(path, ownerUid, what); if (why) return refuse(why); }
  // Opened without waiting (O_NONBLOCK), so a pipe planted at the name can't hang a hook; it is then refused as not a file.
  // The machine-wide copy is also opened without following a link (O_NOFOLLOW): its one name is the root-owned file itself.
  let fd; try { fd = openSync(path, FS.O_RDONLY | FS.O_NONBLOCK | (ownerUid !== undefined ? FS.O_NOFOLLOW : 0)); } catch { return refuse('rules snapshot is missing or unreadable'); }
  try {
    let st; try { st = fstatSync(fd); } catch { return refuse('rules snapshot is missing or unreadable'); }
    if (!st.isFile()) return refuse('rules snapshot is not a plain file');
    if (st.nlink !== 1) return refuse(`rules snapshot has ${st.nlink} names (a hard link); it must have one`);
    if (ownerUid !== undefined && (st.uid !== ownerUid || (st.mode & 0o022))) return refuse(`${what} is not root's alone (it must be owned by ${ownerUid === 0 ? 'root' : `uid ${ownerUid}, standing in for root,`} and written by no one else)`);
    let text; try { text = readFileSync(fd, 'utf8'); } catch { return refuse('rules snapshot is missing or unreadable'); }
    return parseSnapshot(text, parseOpts);
  } finally { try { closeSync(fd); } catch { /* closed */ } }
}

/**
 * The snapshot a hook's arguments name (lib.mjs parseArgs): with `--snapshot-owner U`, a worker session's (L1226), it is
 * taken only when it is U's alone, every folder above it too, as the machine-wide copy is; without it, as before.
 */
export const readHookSnapshot = (args) => readSnapshot(args.snapshot, args.snapshotOwner !== undefined ? { ownerUid: args.snapshotOwner, what: WORKER_RULES_COPY } : {});

/**
 * Why a folder above `path` could let someone other than root swap the file, or null (L1031): each one, from the file's
 * real folder up to /, must be a folder owned by root (or `ownerUid`, which a test stands in for root) and written by no
 * one else. The real folder is used, so a linked folder on the way (/var on a Mac) is judged where it leads.
 * #610 r1 m3: the path as written is walked too, since a link on it is where the real one is decided: each folder on it
 * is held to the same test. #610 r2 m1: and the only links it may hold are the Mac's own, /var, /tmp and /etc, root's,
 * each pointing at its twin in /private (SYSTEM_LINKS). Any other link is refused, however deep a chain of them would go:
 * a link's target can be another link, through a folder neither walk ever sees. The rules copy and the worker snapshots
 * are named by their real folders under the base (layout.mjs managedRulesPath, workerRulesPath), so none needs one.
 */
const SYSTEM_LINKS = Object.freeze({ '/var': ['private/var', '/private/var'], '/tmp': ['private/tmp', '/private/tmp'], '/etc': ['private/etc', '/private/etc'] });
const systemLink = (dir, st) => {
  if (!Object.hasOwn(SYSTEM_LINKS, dir) || st.uid !== 0) return false;
  try { return SYSTEM_LINKS[dir].includes(readlinkSync(dir)); } catch { return false; }
};
export function rootChainProblem(path, ownerUid = 0, what = MACHINE_WIDE_COPY) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) return `the path of ${what} is not a full path in its simplest form`;
  const owner = ownerUid === 0 ? 'root' : `root or uid ${ownerUid}, standing in for root,`;
  const bad = (st) => (st.uid !== 0 && st.uid !== ownerUid) || (st.mode & 0o022);
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    let st; try { st = lstatSync(dir); } catch { return 'rules snapshot is missing or unreadable'; }
    if (st.isSymbolicLink()) { if (!systemLink(dir, st)) return `the link ${dir} on the way to ${what} is not one of the Mac's own (/var, /tmp or /etc, root's, into /private); name the file by its real folders`; }
    else if (!st.isDirectory() || bad(st)) return `the folder ${dir} above ${what} is not root's alone (it must be owned by ${owner} and written by no one else)`;
    if (dirname(dir) === dir) break;
  }
  let dir; try { dir = realpathSync.native(dirname(path)); } catch { return 'rules snapshot is missing or unreadable'; }
  for (;;) {
    let st; try { st = lstatSync(dir); } catch { return 'rules snapshot is missing or unreadable'; }
    if (!st.isDirectory() || bad(st)) return `the folder ${dir} above ${what} is not root's alone (it must be owned by ${owner} and written by no one else)`;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** For tests and the fake: builds a snapshot file body. */
export function makeSnapshot(rules, at = new Date()) {
  return JSON.stringify({ written_at: at.toISOString(), hash: snapshotHash(rules), rules });
}

/**
 * Writes a snapshot whole: to a side file first, then renamed, so a hook never reads half of one (L921). The side file
 * is made new ('wx': refused if anything is at that name, a link included, so nothing planted there is written through)
 * under a random name nobody can guess ahead; if the write or the rename fails, the side file is removed and the error
 * thrown, so no half-written side file is left behind.
 */
export function writeSnapshot(path, rules, at = new Date()) {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, makeSnapshot(rules, at), { flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    // Only a side file this call made is removed: one refused by 'wx' was never ours (EEXIST).
    if (e?.code !== 'EEXIST') { try { unlinkSync(tmp); } catch { /* not made, or gone */ } }
    throw e;
  }
}

/**
 * For a run that writes its own snapshot and may outlast the limit (a test corpus, the fake loop):
 * writes it now and again every `everyMs` (default a minute, well inside the limit) until `stop()`.
 * The timer never keeps the process alive. A rewrite that fails stops the refresher and is kept in
 * `error()`, so a deleted folder can't throw from a timer; the snapshot then goes stale and every
 * call is refused, as it should be.
 */
export function keepSnapshotFresh(path, rules, { everyMs = 60_000, clock = () => new Date(), timers = { setInterval, clearInterval } } = {}) {
  if (!(typeof everyMs === 'number' && everyMs > 0 && everyMs < SNAPSHOT_MAX_AGE_MS)) throw new Error(`keepSnapshotFresh: everyMs must be a number above 0 and below ${SNAPSHOT_MAX_AGE_MS}`);
  writeSnapshot(path, rules, clock());
  let failed = null;
  const t = timers.setInterval(() => {
    try { writeSnapshot(path, rules, clock()); } catch (e) { failed = e; timers.clearInterval(t); }
  }, everyMs);
  t?.unref?.();
  return { stop: () => timers.clearInterval(t), error: () => failed };
}
