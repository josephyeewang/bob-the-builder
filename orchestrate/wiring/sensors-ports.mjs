// sensors-ports.mjs — the `orchestrate` side of the owner's answer (L609, L611, L614): the Sensors loop's
// `whoIsSignedIn` and `readUsage` ports, read from `<answer folder>/owner-answer.json` (written by owner-answer.mjs).
//
//   readOwnerAnswer({ file, ownerUid, now?, staleMs?, acl? }) → { ok: true, answer } | { ok: false, reason }
//   sensorsPorts({ file, ownerUid, now?, staleMs?, stored }) → { whoIsSignedIn, readUsage, lastReason }
//     stored(account) → the usage fact the Record holds for that account, or null (storedUsage(rec) builds it): the marks
//                       the window checks compare with, so they hold across runs (L746 M-A); a failed read throws, never null
//                       (L781). Required: missing, it throws.
//     whoIsSignedIn() → { account, signed_in, observed_at?, reason? }: signed_in false only when the answer says plainly
//                       that the named account is signed out; null (couldn't tell) with the reason for everything else
//     readUsage(account) → { source, h5, week, week_from, observed_at, h5_none?: true, reset_note?: text } | null
//                       reset_note: the drop(s) within one window taken as a reset (L1358), in plain words
//
// THE ANSWER'S OWN TIME (L728 M1). Both ports hand on the answer's observed_at, and state-facts.mjs stores the earlier of
// it and its own read time. So M11's stale_after_min counts from when the owner's job asked Claude Code, never from
// when this side read the file: a 14-minute-old answer read now is 16 minutes old two minutes later.
//
// Each port reads the file afresh and answers null for anything not known: a file that is missing, too old, from the
// future, not the owner's, writable by others, or not the shape below. The Sensors loop writes null as unknown, and M11
// then starts nothing new (who is signed in) or keeps Tier-1 blocked (usage). `lastReason()` says why the last read
// gave null or handed on a stored or partial reading (a refusal, a gap): the Sensors pass logs it as a problem line
// (sensors-wiring.mjs hands it on as `usageReason`; "says so", L611). A drop taken as a reset is not a reason: it rides
// on the reading as `reset_note` (below).
//
// A missing 5-hour row stays null, never 0% (L611). When the owner's answer says the report listed no 5-hour row at all
// (`h5_none: true`, L1331: a clean report with a weekly row and no `session` row), readUsage hands that on, and M11
// judges the band by the week alone. Any other gap (no weekly row, no reset time) is handed on as null figures, and M11
// refuses it as unknown. The week is the highest weekly row (owner-answer.mjs), and `source` names that row.
//
// THE FILE IS A CLAIM (L614). The folder and file are the owner's user's, and work sessions may run as that user too.
// The checks here stop a file from anyone else, one left writable to others, an old one and one dated ahead; they can't
// stop the owner's user itself writing a false one. There is NO time bound on that: the user can rewrite the file every
// round, or lock it (`chflags uchg`) so the real round can't overwrite it (L728). A false file can name the other set-up
// account (the Dispatcher starts sessions on it); say signed in when not (a session start fails and the Dispatcher's own
// checks catch it); or claim low usage, which lets Tier-1 work and new starts run past a real amber or red band until
// the plan's limit itself stops them. Checks narrow the last one: a reset time further out than one window from the
// reading is refused; a reset time moved back, or moved later without a drop on the same row, while the window seen (the
// same reset time; the week is one window whatever row it names, since M11 reads the week alone) is still open is refused
// and said (L728 m1, L746 m-A); a drop that comes with a change of row is refused; and a locked file goes stale within
// ANSWER_STALE_MS.
//
// A DROP WITHIN ONE WINDOW IS TAKEN AS A RESET (L1358). Until L1358 a lower percent than one already seen in the same
// window was refused too (L728 m1, L746 M-A). That guarded against one thing: a false file, written by the owner's user or
// a work session running as it, claiming lower usage than real so that new starts and Tier-1 work run past a real amber
// or red band. But usage can really go down within a window: the account owner or Anthropic can reset it. The old rule
// then refused every true reading until the week's window passed (days), handed on the stale high reading, and held all
// work back (L1358: a reset to 0% read as "0% after 100%, refused"). So a drop is now accepted: the reading passes, the
// marks start again from the new figure, and the drop is written down in plain words (`reset_note` on the reading, kept
// in the usage fact, so the diary shows "usage for <row> went from X% to Y% this week; taken as a reset"), and M11 tells
// Joe once. Only a drop on the same row counts: a drop that comes with a change of weekly row is still refused (the
// answer takes the highest weekly row, so a row coming and going is not a reset). A reset that also moved the weekly
// reset time later, on the same row, is a restarted window and is taken too; see checkWindow below.
// What that gives up: a false low file is no longer stopped by this check, only seen. That is acceptable because the
// file is the owner's own job's output, read only when the owner's user owns it, nobody else can write it and it has no
// access list (the checks below), and that same user could already rewrite or lock it every round, which no check here
// stops (above). The plan's own limit still stops real overuse.
//
// What was seen is the usage fact in the Record (`stored`), so it holds across runs, each of which is a new process; this
// process's own marks are kept too. A refusal hands on the stored reading again with its own time, and the usage writer
// (M12 writeUsageFact, L757) never writes unknown over a stored window still open: no reading, an answer about another
// account, no row or no reset time all hand that window on, so a gap does not wipe the marks until its window has passed.
// A passed reading keeps the window's first reset time, so they can't creep. A refusal lasts until the window
// seen has passed (the weekly one can run for days): the stored fact then ages and M11 reads usage as not known, which
// holds new starts back, never lets them run. The
// owner's user can't reach the Record, the robot's key or merges: those are other users' files. Access lists on the folder and file are checked on every read
// with M4's `aclProblem` (an access list can be added after setup's check ran); setup check checks the folder too.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_NAMES } from '../modules/M4-workshop/launcher/accounts.mjs';
import { aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { ANSWER_VERSION } from './owner-answer.mjs';
import { USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { knownDoc } from '../modules/M12-sensors/facts.mjs';
import { pastTime } from '../shared/still-waiting.mjs';

/**
 * The `stored` reader over a Record: the usage fact it holds for the account, or null when it holds none. A failed read
 * throws (L781, audit #283 r4 M-1): M9's read answers `{ corrupt: true }` rather than throw, and taking that as none would
 * drop the marks a reading is held to (a moved reset time is refused against them; a drop is said against them, L1358).
 */
export const storedUsage = (rec) => (account) => knownDoc(rec.read('fact', USAGE_FACT(account)), `the stored usage for ${account}`);
const SOURCE = 'claude /usage';

// Two of the owner's rounds (5 minutes each): a file older than that means the owner's job stopped writing. Not a copy of
// the rules' stale_after_min (L728 m5): M11 applies that itself, counting from the answer's own time.
export const ANSWER_STALE_MS = 10 * 60_000;
export const SAME_WINDOW_MS = 60_000;            // reset times this close are one window (the server's times carry ms)
// The longest a window can still run from the reading's own time (L746 r3 self-review): a reset time further out is refused,
// so one bad reading can't hold usage unknown for longer than a real window would.
export const WINDOW_MS = { h5: 5 * 3600e3, week: 7 * 86400e3 };
const MAX_BYTES = 4096;
const refuse = (reason) => ({ ok: false, reason });
const isTime = (t) => typeof t === 'string' && Number.isFinite(Date.parse(t));
const pct = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
const ROW = /^(weekly_all|weekly_scoped:[A-Za-z0-9._-]{1,40})$/;
/** The plain words for a drop taken as a reset (L1358): in the usage fact, the Sensors' log and Joe's alert. */
export const resetNote = ({ slot, row, from, to }) => `usage for ${row} went from ${from}% to ${to}% ${slot === 'session' ? 'in this 5-hour window' : 'this week'}; taken as a reset`;

export function shapeProblem(a) {
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
  if (Object.keys(a.usage).some((k) => !['h5', 'week', 'week_from', 'h5_none'].includes(k))) return 'usage has a window this reader does not know';
  // L1331: written only as true, and only with no 5-hour figure and a weekly row (owner-answer.mjs parseUsageReport).
  if (a.usage.h5_none !== undefined && (a.usage.h5_none !== true || a.usage.h5 != null || a.usage.week == null)) return 'h5_none is not true with no 5-hour row and a weekly one';
  if (a.usage.week_from != null && !(typeof a.usage.week_from === 'string' && ROW.test(a.usage.week_from))) return 'week_from is not a row this reader knows';
  for (const k of ['h5', 'week']) {
    const w = a.usage[k];
    if (w === null || w === undefined) continue;
    if (typeof w !== 'object' || !pct(w.used_pct)) return `the ${k} percent is not 0 to 100`;
    if (w.resets_at !== null && !isTime(w.resets_at)) return `the ${k} reset time is not a time`;
    if (w.resets_at !== null && Date.parse(w.resets_at) - Date.parse(a.observed_at) > WINDOW_MS[k] + SAME_WINDOW_MS) return `the ${k} reset time is further out than one ${k === 'h5' ? '5-hour' : 'weekly'} window from the reading`;
  }
  if (a.usage.week && a.usage.week_from == null) return 'the week has no week_from';
  return null;
}

// The answer's rules, one definition for the Sensors (readOwnerAnswer) and for setup's check (answerRows, #502 r1 m3): the
// folder, the file and the time. Each takes what its reader already has (a stat, the parsed answer) and gives the reason
// to refuse, or null.
/** The answer's folder: a plain folder of the owner's that others can't write. */
export function answerFolderProblem(ds, ownerUid, dir) {
  if (ds.isSymbolicLink() || !ds.isDirectory()) return `${dir} is not a plain folder`;
  if (ds.uid !== ownerUid) return `${dir} is not the owner's`;
  if (ds.mode & 0o022) return `${dir} can be written by others`;
  return null;
}
/** The answer file: the owner's plain file with one name, that others can't write, and small. */
export function answerFileProblem(st, ownerUid, file) {
  if (st.uid !== ownerUid) return `${file} is not the owner's`;
  if (!st.isFile() || st.nlink !== 1) return `${file} is not a plain file with one name`;
  if (st.mode & 0o022) return `${file} can be written by others`;
  if (st.size > MAX_BYTES) return `${file} is too big`;
  return null;
}
/** The answer, parsed: its shape, then its time, neither ahead of this clock nor older than staleMs. */
export function answerProblem(a, nowMs, staleMs = ANSWER_STALE_MS) {
  const bad = shapeProblem(a);
  if (bad) return bad;
  // One clock (L1099 I4, I7): pastTime's 60 s skew allowance. The shape check has read the time, so null means ahead.
  const t = pastTime(a.observed_at, nowMs);
  if (t === null) return 'the owner\'s answer is dated in the future';
  const age = nowMs - t;
  if (age > staleMs) return `the owner's answer is ${Math.round(age / 60_000)} min old (the owner's job may be failing to write; see its log)`;
  return null;
}

export function readOwnerAnswer({ file, ownerUid, now = () => new Date(), staleMs = ANSWER_STALE_MS, acl = aclProblem }) {
  if (typeof file !== 'string' || !file.startsWith('/')) return refuse('no answer file is configured');
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0) return refuse('no owner uid is configured');
  const dir = dirname(file);
  let ds;
  try { ds = lstatSync(dir); } catch { return refuse(`${dir} is missing`); }
  const dirBad = answerFolderProblem(ds, ownerUid, dir);
  if (dirBad) return refuse(dirBad);
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return refuse(e?.code === 'ENOENT' ? 'the owner\'s answer is missing (is the owner\'s job running?)' : e?.code === 'ELOOP' ? `${file} is a link` : `${file} can't be read (${e?.code ?? e})`);
  }
  let text;
  try {
    const fileBad = answerFileProblem(fstatSync(fd), ownerUid, file);
    if (fileBad) return refuse(fileBad);
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_BYTES) return refuse(`${file} is too big`);
    text = buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
  const listed = acl([dir, file]);
  if (listed) return refuse(listed);
  let a;
  try { a = JSON.parse(text); } catch { return refuse(`${file} is not JSON`); }
  const bad = answerProblem(a, now().getTime(), staleMs);
  if (bad) return refuse(bad);
  return { ok: true, answer: a };
}

// `stored` is required (L746 r3 self-review): every Sensors run is a new process, so without the stored usage fact the
// window marks would never hold. Pass storedUsage(rec); a test with no Record passes () => null on purpose.
export function sensorsPorts({ file, ownerUid, now = () => new Date(), staleMs = ANSWER_STALE_MS, acl = aclProblem, stored }) {
  if (typeof stored !== 'function') throw new TypeError('sensorsPorts needs stored: storedUsage(rec), the stored usage fact');
  let why = null;
  // `${account}|${slot}` → { resets: ms, pct, row }: the latest percent accepted in that window (L1358: a reset lowers it),
  // and the row it came from (the session slot's row is always `session`).
  const seen = new Map();
  // The row the stored week came from: the usage fact's source ends "week from <row>" (state-facts.mjs keeps the stored
  // source whenever it hands the stored week on). null when it can't be told, which counts as another row.
  const storedRow = (d) => { const m = / \| week from (\S+)$/.exec(typeof d?.source === 'string' ? d.source : ''); return m && ROW.test(m[1]) ? m[1] : null; };
  // The marks a reading is held to: this process's, and the stored usage fact's (L746 M-A). The week is one slot whatever
  // row it came from (L746 r3 self-review): M11 reads the week alone, so a change of row must not start it afresh.
  const marksOf = (account, slot) => {
    const out = []; const m = seen.get(`${account}|${slot}`); if (m) out.push(m);
    // Stored marks that can't be read are never taken as none (that would let a moved reset time or a row's drop through):
    // the read fails, and the usage writer hands the stored reading on, or refuses when it can't read it either.
    let d = null; try { d = stored(account); } catch (e) { throw new Error(`the stored usage marks could not be read (${String(e?.message ?? e).slice(0, 80)})`); }
    const sw = slot === 'session' ? d?.h5 : d?.week;
    const r = Date.parse(sw?.resets_at ?? '');
    if (sw && Number.isFinite(r) && Number.isFinite(sw.used_pct)) out.push({ resets: r, pct: sw.used_pct, row: slot === 'session' ? 'session' : storedRow(d) });
    return out;
  };
  // What a reading's window is, against every mark (L728 m1, L746 m-A, L1358). → { refuse: reason } | { down } | null.
  //   - Same reset time (one window), percent up or the same: fine.
  //   - Same reset time, percent DOWN, from the same row as the mark: TAKEN AS A RESET (L1358). The owner or Anthropic can
  //     reset plan usage, so a drop is real: the reading passes, its marks start again from the new figure, and the drop
  //     is said (`down`). From another row it is refused, as before (L746 r3, the #671 audit's M1): the owner's answer
  //     takes the highest weekly row, so a scoped row coming and going would otherwise flip the band and name the wrong row.
  //   - The weekly reset time moved LATER, the percent DOWN, the same row (L1358 m3): a restarted window (a reset that also
  //     started the week again), taken with the same note. Its new reset time is still held to one window from the reading
  //     (shapeProblem).
  //   - Any other moved reset time while the window seen is still open is refused (L746 m-A: a new window starts only once
  //     the old one has passed): moved back; moved later with the percent up or the same; moved later from another row;
  //     and a moved 5-hour reset time, which a real 5-hour window ends within hours anyway.
  // A window with no reset time (`resets_at` null) is not checked here: it is a gap, handed on as unknown (the usage writer
  // keeps the stored window), so it can neither pass as a reset nor wipe the marks.
  // This process's marks are written only by commit(), once the reading passes; the stored one by the usage fact.
  const checkWindow = (account, slot, row, w) => {
    const r = Date.parse(w?.resets_at ?? '');
    if (!w || !Number.isFinite(r)) return null;
    let top = null;
    for (const m of marksOf(account, slot)) {
      const sameRow = m.row === row;
      if (Math.abs(r - m.resets) <= SAME_WINDOW_MS) {
        if (w.used_pct >= m.pct) continue;
        if (!sameRow) return { refuse: `usage: the ${row} row went down within one window (${w.used_pct}% after ${m.pct}%), so it is refused` };
        if (top === null || m.pct > top) top = m.pct;
        continue;
      }
      if (m.resets <= now().getTime()) continue;
      if (slot === 'week' && r > m.resets && sameRow && w.used_pct < m.pct) { if (top === null || m.pct > top) top = m.pct; continue; }
      return { refuse: `usage: the ${row} row's reset time moved ${r < m.resets ? 'back' : 'later'} while the window seen (to ${new Date(m.resets).toISOString()}) is still open, so it is refused` };
    }
    return top === null ? null : { down: { slot, row, from: top, to: w.used_pct } };
  };
  // A reading that passed is handed on with the window's first reset time, so the stored fact can't creep up to a minute
  // per run toward an early end (L746 r3 self-review). The earliest mark of the same window is the first one seen.
  const anchored = (account, slot, w) => {
    const r = Date.parse(w?.resets_at ?? '');
    if (!w || !Number.isFinite(r)) return w;
    const same = marksOf(account, slot).filter((m) => Math.abs(r - m.resets) <= SAME_WINDOW_MS).map((m) => m.resets);
    return same.length ? { ...w, resets_at: new Date(Math.min(...same)).toISOString() } : w;
  };
  const commit = (account, slot, w, row) => {
    const r = Date.parse(w?.resets_at ?? '');
    if (!w || !Number.isFinite(r)) return;
    const k = `${account}|${slot}`; const m = seen.get(k);
    // The accepted figure is the mark, a drop included (L1358: a reset starts the marks again from the new value).
    seen.set(k, m && Math.abs(r - m.resets) <= SAME_WINDOW_MS ? { resets: m.resets, pct: w.used_pct, row } : { resets: r, pct: w.used_pct, row });
  };
  // A refused reading must not wipe the marks (L746 r3 self-review): the pass writes a null reading as unknown usage, over
  // the stored fact. So the stored reading is handed on again, with its own older time: the writer keeps that time, M11
  // counts it stale on schedule (then unknown, which holds starts back), and the marks stay until the window passes.
  const kept = (account) => {
    let d = null; try { d = stored(account); } catch { d = null; }
    if (!d || !isTime(d.observed_at) || (d.h5?.used_pct == null && d.week?.used_pct == null)) return null;
    const w = (x) => (x ? { used_pct: x.used_pct ?? null, resets_at: x.resets_at ?? null } : null);
    // Never the no-5-hour marker (L1331 r3): the reading refused here may itself have shown a 5-hour row.
    return { source: typeof d.source === 'string' ? d.source : null, h5: w(d.h5), week: w(d.week), observed_at: d.observed_at };
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
      if (a.signed_in === false) {
        why = `account ${a.account} is not signed in`;
        return { account: null, signed_in: false, reason: why, observed_at: a.observed_at };
      }
      if (a.signed_in !== true) {
        // L1329: the sign-in could not be confirmed, but the answer names the account new sessions start on. That account is
        // handed on with signed_in null (not confirmed), so starts are not all off; usage stays unknown (readUsage below
        // needs signed_in true), which still holds every Tier-1 start. Signed out in so many words still names no account.
        why = `who is signed in is not confirmed (${a.usage_reason ?? 'no reason given'})`;
        return { account: a.account ?? null, signed_in: null, reason: why, observed_at: a.observed_at };
      }
      return { account: a.account, signed_in: true, observed_at: a.observed_at };
    },
    readUsage: async (account) => {
      const a = read();
      if (!a) return null;
      if (a.signed_in !== true || a.account !== account) { why = `the owner's answer is not about a signed-in account ${account}`; return null; }
      if (!a.usage) { why = `usage: ${a.usage_reason ?? 'not read'}`; return null; }
      const w = (x) => (x ? { used_pct: x.used_pct, resets_at: x.resets_at } : null);
      const from = a.usage.week_from ?? null;
      const h5in = w(a.usage.h5); const weekIn = w(a.usage.week);
      const checks = [checkWindow(account, 'session', 'session', h5in), from ? checkWindow(account, 'week', from, weekIn) : null];
      const refused = checks.find((c) => c?.refuse)?.refuse;
      if (refused) { why = refused; return kept(account); }
      // L1358: each drop taken as a reset, said in plain words. It rides on the reading into the usage fact (the diary keeps
      // it; M11 tells Joe once and ends a limit wait on it). It is not this read's reason: lastReason() stays what was wrong.
      const resets = checks.filter((c) => c?.down).map(({ down: d }) => resetNote(d));
      const h5 = anchored(account, 'session', h5in); const week = from ? anchored(account, 'week', weekIn) : weekIn;
      commit(account, 'session', h5, 'session');
      if (from) commit(account, 'week', week, from);
      // A reading with a part missing is still handed on (M11 refuses it as unknown), with the reason (L728 m4).
      // A report that lists no 5-hour row (L1331) is not a gap: the week alone decides.
      const none = a.usage.h5_none === true;
      const gaps = [!h5 && !none && 'no 5-hour row', h5 && !h5.resets_at && 'no 5-hour reset time', !week && 'no weekly row',
        week && !week.resets_at && 'no weekly reset time'].filter(Boolean);
      if (gaps.length) why = `usage: the report had ${gaps.join(', ')}, so it stays unknown`;
      const note = resets.length ? resets.join('; ') : null;
      return { source: from ? `${SOURCE} | week from ${from}` : SOURCE, h5, week, week_from: from, observed_at: a.observed_at,
        ...(none ? { h5_none: true } : {}), ...(note ? { reset_note: note } : {}) };
    },
    lastReason: () => why,
  };
}
