// sensors-ports.mjs — the `orchestrate` side of the owner's answer (L609, L611, L614): the Sensors loop's
// `whoIsSignedIn` and `readUsage` ports, read from `<answer folder>/owner-answer.json` (written by owner-answer.mjs).
//
//   readOwnerAnswer({ file, ownerUid, now?, staleMs?, acl? }) → { ok: true, answer } | { ok: false, reason }
//   sensorsPorts({ file, ownerUid, now?, staleMs?, stored? }) → { whoIsSignedIn, readUsage, lastReason }
//     stored(account) → the usage fact the Record holds for that account, or null (storedUsage(rec) builds it): the marks
//                       the window checks compare with, so they hold across runs (L746 M-A). Left out, only this process's
//     whoIsSignedIn() → { account, signed_in, observed_at?, reason? }: signed_in false only when the answer says plainly
//                       that the named account is signed out; null (couldn't tell) with the reason for everything else
//     readUsage(account) → { source, h5, week, week_from, observed_at } | null
//
// THE ANSWER'S OWN TIME (L728 M1). Both ports hand on the answer's observed_at, and state-facts.mjs stores the earlier of
// it and its own read time. So M11's stale_after_min counts from when the owner's job asked Claude Code, never from
// when this side read the file: a 14-minute-old answer read now is 16 minutes old two minutes later.
//
// Each port reads the file afresh and answers null for anything not known: a file that is missing, too old, from the
// future, not the owner's, writable by others, or not the shape below. The Sensors loop writes null as unknown, and M11
// then starts nothing new (who is signed in) or keeps Tier-1 blocked (usage). `lastReason()` says why the last read
// gave null, for the pass's problem line ("says so", L611).
//
// A missing 5-hour row stays null, never 0% (L611): readUsage hands it on as null figures, and M11 refuses a reading
// without an h5 percent. The week is the highest weekly row (owner-answer.mjs), and `source` names that row.
//
// THE FILE IS A CLAIM (L614). The folder and file are the owner's user's, and work sessions may run as that user too.
// The checks here stop a file from anyone else, one left writable to others, an old one and one dated ahead; they can't
// stop the owner's user itself writing a false one. There is NO time bound on that: the user can rewrite the file every
// round, or lock it (`chflags uchg`) so the real round can't overwrite it (L728). A false file can name the other set-up
// account (the Dispatcher starts sessions on it); say signed in when not (a session start fails and the Dispatcher's own
// checks catch it); or claim low usage, which lets Tier-1 work and new starts run past a real amber or red band until
// the plan's limit itself stops them. Two checks narrow the last one: within one usage window (the same reset time, the
// same row) a lower percent than one already seen is refused and said, and so is a reset time moved back or moved later
// while the window seen is still open (L728 m1, L746 M-A and m-A); and a locked file goes stale within ANSWER_STALE_MS.
// What was seen is the usage fact in the Record (`stored`), so it holds across runs, each of which is a new process; this
// process's own marks are kept too. A refusal lasts until the window seen has passed (the weekly one can run for days):
// the stored fact then ages and M11 reads usage as not known, which holds new starts back, never lets them run. The
// owner's user can't reach the Record, the robot's key or merges: those are other users' files. Access lists on the folder and file are checked on every read
// with M4's `aclProblem` (an access list can be added after setup's check ran); setup check checks the folder too.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_NAMES } from '../modules/M4-workshop/launcher/accounts.mjs';
import { aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { ANSWER_VERSION } from './owner-answer.mjs';
import { USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';

/** The `stored` reader over a Record: the usage fact it holds for the account, or null. Never throws. */
export const storedUsage = (rec) => (account) => { try { return rec.read('fact', USAGE_FACT(account))?.doc ?? null; } catch { return null; } };
const SOURCE = 'claude /usage';

// Two of the owner's rounds (5 minutes each): a file older than that means the owner's job stopped writing. Not a copy of
// the rules' stale_after_min (L728 m5): M11 applies that itself, counting from the answer's own time.
export const ANSWER_STALE_MS = 10 * 60_000;
export const SAME_WINDOW_MS = 60_000;            // reset times this close are one window (the server's times carry ms)
export const ANSWER_AHEAD_MS = 2 * 60_000;       // clock drift allowed; later than this is refused as a future time
const MAX_BYTES = 4096;
const refuse = (reason) => ({ ok: false, reason });
const isTime = (t) => typeof t === 'string' && Number.isFinite(Date.parse(t));
const pct = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
const ROW = /^(weekly_all|weekly_scoped:[A-Za-z0-9._-]{1,40})$/;

function shapeProblem(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'the answer is not an object';
  const known = new Set(['v', 'account', 'signed_in', 'observed_at', 'usage', 'usage_reason']);
  const extra = Object.keys(a).filter((k) => !known.has(k));
  if (extra.length) return `the answer has fields this reader does not know: ${extra.join(', ')}`;
  if (a.v !== ANSWER_VERSION) return `the answer is version ${JSON.stringify(a.v)}, not ${ANSWER_VERSION}`;
  if (a.account !== null && !ACCOUNT_NAMES.includes(a.account)) return 'the answer names neither a nor b';
  if (![true, false, null].includes(a.signed_in)) return 'signed_in is not yes, no or not known';
  if (!isTime(a.observed_at)) return 'observed_at is not a time';
  if (a.signed_in === true && a.account === null) return 'the answer says signed in but names no account';
  if (a.usage_reason !== undefined && typeof a.usage_reason !== 'string') return 'usage_reason is not text';
  if (a.usage === null) return null;
  if (!a.usage || typeof a.usage !== 'object' || Array.isArray(a.usage)) return 'usage is not an object';
  if (Object.keys(a.usage).some((k) => k !== 'h5' && k !== 'week' && k !== 'week_from')) return 'usage has a window this reader does not know';
  if (a.usage.week_from != null && !(typeof a.usage.week_from === 'string' && ROW.test(a.usage.week_from))) return 'week_from is not a row this reader knows';
  for (const k of ['h5', 'week']) {
    const w = a.usage[k];
    if (w === null || w === undefined) continue;
    if (typeof w !== 'object' || !pct(w.used_pct)) return `the ${k} percent is not 0 to 100`;
    if (w.resets_at !== null && !isTime(w.resets_at)) return `the ${k} reset time is not a time`;
  }
  if (a.usage.week && a.usage.week_from == null) return 'the week has no week_from';
  return null;
}

export function readOwnerAnswer({ file, ownerUid, now = () => new Date(), staleMs = ANSWER_STALE_MS, acl = aclProblem }) {
  if (typeof file !== 'string' || !file.startsWith('/')) return refuse('no answer file is configured');
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0) return refuse('no owner uid is configured');
  const dir = dirname(file);
  let ds;
  try { ds = lstatSync(dir); } catch { return refuse(`${dir} is missing`); }
  if (ds.isSymbolicLink() || !ds.isDirectory()) return refuse(`${dir} is not a plain folder`);
  if (ds.uid !== ownerUid) return refuse(`${dir} is not the owner's`);
  if (ds.mode & 0o022) return refuse(`${dir} can be written by others`);
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return refuse(e?.code === 'ENOENT' ? 'the owner\'s answer is missing (is the owner\'s job running?)' : e?.code === 'ELOOP' ? `${file} is a link` : `${file} can't be read (${e?.code ?? e})`);
  }
  let text;
  try {
    const st = fstatSync(fd);
    if (st.uid !== ownerUid) return refuse(`${file} is not the owner's`);
    if (!st.isFile() || st.nlink !== 1) return refuse(`${file} is not a plain file with one name`);
    if (st.mode & 0o022) return refuse(`${file} can be written by others`);
    if (st.size > MAX_BYTES) return refuse(`${file} is too big`);
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_BYTES) return refuse(`${file} is too big`);
    text = buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
  const listed = acl([dir, file]);
  if (listed) return refuse(listed);
  let a;
  try { a = JSON.parse(text); } catch { return refuse(`${file} is not JSON`); }
  const bad = shapeProblem(a);
  if (bad) return refuse(bad);
  const age = now().getTime() - Date.parse(a.observed_at);
  if (age < -ANSWER_AHEAD_MS) return refuse('the owner\'s answer is dated in the future');
  if (age > staleMs) return refuse(`the owner's answer is ${Math.round(age / 60_000)} min old (the owner's job may be failing to write; see its log)`);
  return { ok: true, answer: a };
}

export function sensorsPorts({ file, ownerUid, now = () => new Date(), staleMs = ANSWER_STALE_MS, acl = aclProblem, stored = null }) {
  let why = null;
  const seen = new Map();   // `${account}|${row}` → { resets: ms, pct }: the highest percent accepted in that window
  // The marks a reading is held to: this process's, and the stored usage fact's (L746 M-A). The stored week row is the
  // same row only when its source names it.
  const marksOf = (account, row) => {
    const out = []; const m = seen.get(`${account}|${row}`); if (m) out.push(m);
    let d = null; try { d = typeof stored === 'function' ? stored(account) : null; } catch { d = null; }
    const sw = row === 'session' ? d?.h5 : (d?.source === `${SOURCE} | week from ${row}` ? d?.week : null);
    const r = Date.parse(sw?.resets_at ?? '');
    if (sw && Number.isFinite(r) && Number.isFinite(sw.used_pct)) out.push({ resets: r, pct: sw.used_pct });
    return out;
  };
  // A lower percent than one already seen in the same window, or a reset time moved back or later while the window seen
  // is still open, is refused (L728 m1; L746 m-A: a new window starts only once the old one has passed). → a reason, or
  // null. This process's marks are written only by commit(), once the reading passes; the stored one by the usage fact.
  const dropped = (account, row, w) => {
    const r = Date.parse(w?.resets_at ?? '');
    if (!w || !Number.isFinite(r)) return null;
    for (const m of marksOf(account, row)) {
      if (Math.abs(r - m.resets) <= SAME_WINDOW_MS) { if (w.used_pct < m.pct) return `usage: the ${row} row went down within one window (${w.used_pct}% after ${m.pct}%), so it is refused`; continue; }
      if (m.resets > now().getTime()) return `usage: the ${row} row's reset time moved ${r < m.resets ? 'back' : 'later'} while the window seen (to ${new Date(m.resets).toISOString()}) is still open, so it is refused`;
    }
    return null;
  };
  const commit = (account, row, w) => {
    const r = Date.parse(w?.resets_at ?? '');
    if (!w || !Number.isFinite(r)) return;
    const k = `${account}|${row}`; const m = seen.get(k);
    seen.set(k, m && Math.abs(r - m.resets) <= SAME_WINDOW_MS ? { resets: m.resets, pct: Math.max(m.pct, w.used_pct) } : { resets: r, pct: w.used_pct });
  };
  const read = () => {
    const r = readOwnerAnswer({ file, ownerUid, now, staleMs, acl });
    why = r.ok ? null : r.reason;
    return r.ok ? r.answer : null;
  };
  return {
    whoIsSignedIn: async () => {
      const a = read();
      if (!a) return { account: null, signed_in: null, reason: why };
      if (a.signed_in !== true) {
        why = a.signed_in === false ? `account ${a.account} is not signed in` : `who is signed in is not known (${a.usage_reason ?? 'no reason given'})`;
        return { account: null, signed_in: a.signed_in, reason: why, observed_at: a.observed_at };
      }
      return { account: a.account, signed_in: true, observed_at: a.observed_at };
    },
    readUsage: async (account) => {
      const a = read();
      if (!a) return null;
      if (a.signed_in !== true || a.account !== account) { why = `the owner's answer is not about a signed-in account ${account}`; return null; }
      if (!a.usage) { why = `usage: ${a.usage_reason ?? 'not read'}`; return null; }
      const w = (x) => (x ? { used_pct: x.used_pct, resets_at: x.resets_at } : null);
      const h5 = w(a.usage.h5); const week = w(a.usage.week); const from = a.usage.week_from ?? null;
      const down = dropped(account, 'session', h5) ?? (from ? dropped(account, from, week) : null);
      if (down) { why = down; return null; }
      commit(account, 'session', h5);
      if (from) commit(account, from, week);
      // A reading with a part missing is still handed on (M11 refuses it as unknown), with the reason (L728 m4).
      const gaps = [!h5 && 'no 5-hour row', h5 && !h5.resets_at && 'no 5-hour reset time', !week && 'no weekly row',
        week && !week.resets_at && 'no weekly reset time'].filter(Boolean);
      if (gaps.length) why = `usage: the report had ${gaps.join(', ')}, so it stays unknown`;
      return { source: from ? `${SOURCE} | week from ${from}` : SOURCE, h5, week, week_from: from, observed_at: a.observed_at };
    },
    lastReason: () => why,
  };
}
