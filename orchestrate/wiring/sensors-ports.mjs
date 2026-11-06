// sensors-ports.mjs — the `orchestrate` side of the owner's answer (L609, L611, L614): the Sensors loop's
// `whoIsSignedIn` and `readUsage` ports, read from `<answer folder>/owner-answer.json` (written by owner-answer.mjs).
//
//   readOwnerAnswer({ file, ownerUid, now?, staleMs?, acl? }) → { ok: true, answer } | { ok: false, reason }
//   sensorsPorts({ file, ownerUid, now?, staleMs? }) → { whoIsSignedIn, readUsage, lastReason }
//
// Each port reads the file afresh and answers null for anything not known: a file that is missing, too old, from the
// future, not the owner's, writable by others, or not the shape below. The Sensors loop writes null as unknown, and M11
// then starts nothing new (who is signed in) or keeps Tier-1 blocked (usage). `lastReason()` says why the last read
// gave null, for the pass's problem line ("says so", L611).
//
// A missing 5-hour row stays null, never 0% (L611): readUsage hands it on as null figures, and M11 refuses a reading
// without an h5 percent.
//
// THE FILE IS A CLAIM (L614). The folder and file are the owner's user's, and work sessions may run as that user too.
// The checks here stop a file from anyone else, one left writable to others, an old one and one dated ahead; they can't
// stop the owner's user itself writing a false one. What a false file could still do, until the next real round
// overwrites it (5 minutes): name the other set-up account (the Dispatcher starts sessions on it); say signed in when not
// (a session start fails and the Dispatcher's own checks catch it); or claim low usage, which lets Tier-1 work and new
// starts run past a real amber or red band until the plan's limit itself stops them. It can't reach the Record, the
// robot's key or merges: those are other users' files. Access lists on the folder and file are checked on every read
// with M4's `aclProblem` (an access list can be added after setup's check ran); setup check checks the folder too.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACCOUNT_NAMES } from '../modules/M4-workshop/launcher/accounts.mjs';
import { aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { ANSWER_VERSION } from './owner-answer.mjs';

export const ANSWER_STALE_MS = 15 * 60_000;     // the rules' stale_after_min (A8); an answer this old is unknown
export const ANSWER_AHEAD_MS = 2 * 60_000;       // clock drift allowed; later than this is refused as a future time
const MAX_BYTES = 4096;
const refuse = (reason) => ({ ok: false, reason });
const isTime = (t) => typeof t === 'string' && Number.isFinite(Date.parse(t));
const pct = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

function shapeProblem(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'the answer is not an object';
  const known = new Set(['v', 'account', 'signed_in', 'observed_at', 'usage', 'usage_reason']);
  const extra = Object.keys(a).filter((k) => !known.has(k));
  if (extra.length) return `the answer has fields this reader does not know: ${extra.join(', ')}`;
  if (a.v !== ANSWER_VERSION) return `the answer is version ${JSON.stringify(a.v)}, not ${ANSWER_VERSION}`;
  if (a.account !== null && !ACCOUNT_NAMES.includes(a.account)) return 'the answer names neither a nor b';
  if (![true, false, null].includes(a.signed_in)) return 'signed_in is not yes, no or not known';
  if (!isTime(a.observed_at)) return 'observed_at is not a time';
  if (a.usage_reason !== undefined && typeof a.usage_reason !== 'string') return 'usage_reason is not text';
  if (a.usage === null) return null;
  if (!a.usage || typeof a.usage !== 'object' || Array.isArray(a.usage)) return 'usage is not an object';
  if (Object.keys(a.usage).some((k) => k !== 'h5' && k !== 'week')) return 'usage has a window this reader does not know';
  for (const k of ['h5', 'week']) {
    const w = a.usage[k];
    if (w === null || w === undefined) continue;
    if (typeof w !== 'object' || !pct(w.used_pct)) return `the ${k} percent is not 0 to 100`;
    if (w.resets_at !== null && !isTime(w.resets_at)) return `the ${k} reset time is not a time`;
  }
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
  if (age > staleMs) return refuse(`the owner's answer is ${Math.round(age / 60_000)} min old`);
  return { ok: true, answer: a };
}

export function sensorsPorts({ file, ownerUid, now = () => new Date(), staleMs = ANSWER_STALE_MS, acl = aclProblem }) {
  let why = null;
  const read = () => {
    const r = readOwnerAnswer({ file, ownerUid, now, staleMs, acl });
    why = r.ok ? null : r.reason;
    return r.ok ? r.answer : null;
  };
  return {
    whoIsSignedIn: async () => {
      const a = read();
      if (!a) return null;
      if (a.signed_in !== true) { why = a.signed_in === false ? `account ${a.account} is not signed in` : 'who is signed in is not known'; return null; }
      return a.account;
    },
    readUsage: async (account) => {
      const a = read();
      if (!a) return null;
      if (a.signed_in !== true || a.account !== account) { why = `the owner's answer is not about a signed-in account ${account}`; return null; }
      if (!a.usage) { why = `usage: ${a.usage_reason ?? 'not read'}`; return null; }
      const w = (x) => (x ? { used_pct: x.used_pct, resets_at: x.resets_at } : null);
      if (!a.usage.h5) why = 'usage: the report had no 5-hour row, so it stays unknown';
      return { source: 'claude /usage', h5: w(a.usage.h5), week: w(a.usage.week) };
    },
    lastReason: () => why,
  };
}
