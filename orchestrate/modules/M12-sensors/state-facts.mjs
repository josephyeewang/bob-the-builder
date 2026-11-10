// state-facts.mjs — the readings the Dispatcher (M11) decides on, written into the record (R-0b-168).
//
// WHY. M11 reads facts it never writes: the usage numbers, the signed-in account, whether the network, the Front Door
// and Mini Base are up, and a limit hit's reset time. Before this file M11's tests seeded those facts by hand, so a
// field the Sensors never wrote (observed_at above all) could be missing in real use while every test passed. Each
// writer here takes its reading from an injected port (the device read on the Mini; a fake in tests). observed_at is
// taken from the injected clock just BEFORE the port is called (LEAD-CALLS L97 M-2): a reading is never dated later than
// the moment its read began, so M11 can tell a reading that started before a merge attempt or a wait from one after.
// The fact ids are M11's own (imported, not copied), and every fact passes the allow-list in fact-shapes.mjs.
//
// Ports (each may be async):
//   readUsage(account)  → { h5: { used_pct, resets_at }, week: { used_pct, resets_at }, source, observed_at? } | null
//   whoIsSignedIn()     → the account name, or { account, signed_in?, reason?, observed_at? }, or null when it can't be read
// The account fact tells "nobody is signed in" apart from "couldn't tell" (L730, #289 r1 M1): signed_in is true (an
// account of M4's), false (the port said plainly nobody is), or null (couldn't tell), and `reason` says why when it is
// not true. A bare null or a name that isn't M4's is "couldn't tell", never "nobody". M11 reads a null account as
// nobody either way, which is safe; the difference is what Joe is told.
// A port that hands back an observed_at of its own is a relay of an earlier reading (the owner's answer, L728 M1): the
// fact keeps the EARLIER of that time and the read's start, so a reading is never made younger by being passed on. An
// observed_at that is there but not a time is refused, never replaced by the read time.
//   probe()             → true | false | null (null = could not tell; M11 reads it as unknown)
// The limit-hit writer takes the worker's exit result instead of a port: the worker learns the reset time, and the
// Sensors write it (M9 lists limit-hit- under the sensors family, so the Sensors are its one writer).
//
// An account is one of M4's account names (`a`, `b`) or nothing (L97 m-2): a label or an email would make a fact id the
// Record refuses (usage would then stay unknown) and put private text in the record.

import { USAGE_FACT } from '../M11-dispatcher/usage.mjs';
import { ACCOUNT_FACT } from '../M11-dispatcher/tick.mjs';
import { FACTS } from '../M11-dispatcher/phone-link.mjs';
import { LIMIT_FACT } from '../M11-dispatcher/pass.mjs';
import { ACCOUNT_NAMES } from '../M4-workshop/launcher/accounts.mjs';
import { writePrFact } from './pr-facts.mjs';

const stamp = (now) => now().toISOString();
export const accountOk = (a) => typeof a === 'string' && ACCOUNT_NAMES.includes(a);
const timeOrNull = (t) => (typeof t === 'string' && Number.isFinite(Date.parse(t)) ? t : null);
// The earlier of our stamp and the port's own time; undefined when the port's time is there but unreadable.
const relayed = (ours, theirs) => {
  if (theirs === undefined || theirs === null) return ours;
  if (!timeOrNull(theirs)) return undefined;
  return Date.parse(theirs) < Date.parse(ours) ? new Date(Date.parse(theirs)).toISOString() : ours;
};

// A usage window with a figure and a reset time; a window missing either says nothing about its window.
const known = (w) => Number.isFinite(w?.used_pct) && timeOrNull(w?.resets_at) !== null;

/**
 * The usage fact. Never unknown over known (L757, audit #283 r3 M-1): while a stored window is still open (its reset time
 * not passed), a reading that has nothing for that window (no reading at all, the loop's own unknown when the read failed
 * or ran late, no row, or no reset time) hands on the stored window instead, and the fact keeps the earlier of the two
 * times. So the marks the owner's-answer check compares against (sensors-ports.mjs) are never wiped by a gap, and a forged
 * low reading after one is still refused; the handed-on reading ages as before, and M11 then reads usage as not known.
 * Once the stored window's reset time passes, an unknown is written as unknown.
 */
export async function writeUsageFact(writer, readUsage, account, { now = () => new Date() } = {}) {
  if (!accountOk(account)) return { ok: false, reason: 'no known account to read usage for' };
  const started = stamp(now);
  const r = await readUsage(account);
  if (!r) return { ok: false, reason: `no usage reading for ${account}` };
  let observed_at = relayed(started, r.observed_at);
  if (!observed_at) return { ok: false, reason: `the usage reading for ${account} has an observed_at that is not a time` };
  const win = (w) => ({ used_pct: w?.used_pct ?? null, resets_at: w?.resets_at ?? null });
  // A stored fact that can't be read is never taken as none: that would write over the marks (self-review Minor).
  let stored = null; try { stored = typeof writer.get === 'function' ? writer.get(USAGE_FACT(account)) : null; } catch (e) {
    return { ok: false, reason: `the stored usage for ${account} could not be read, so nothing was written over it (${String(e?.message ?? e).slice(0, 80)})` };
  }
  const at = Date.parse(started);
  const open = (w) => known(w) && Date.parse(w.resets_at) > at;
  const doc = { kind: 'fact.usage', account, observed_at, source: r.source ?? null, h5: win(r.h5), week: win(r.week) };
  const handedOn = stored && timeOrNull(stored.observed_at) ? ['h5', 'week'].filter((k) => !known(r[k]) && open(stored[k])) : [];
  for (const k of handedOn) doc[k] = win(stored[k]);
  if (handedOn.length) {
    doc.observed_at = relayed(observed_at, stored.observed_at);
    if (handedOn.length === 2) doc.source = stored.source ?? null;
  }
  return writer.put(USAGE_FACT(account), doc);
}

export async function writeSignedInAccount(writer, whoIsSignedIn, { now = () => new Date() } = {}) {
  const started = stamp(now);
  const got = await whoIsSignedIn();
  const o = got && typeof got === 'object' ? got : { account: got };
  const observed_at = relayed(started, got && typeof got === 'object' ? got.observed_at : undefined);
  if (!observed_at) return { ok: false, reason: 'the signed-in account reading has an observed_at that is not a time' };
  const said = typeof o.reason === 'string' && o.reason ? o.reason.slice(0, 200) : null;
  let account = null; let signed_in = null; let reason;
  if (got === null || got === undefined) reason = 'the account read gave no answer';
  else if (o.signed_in === false) { signed_in = false; reason = said ?? 'nobody is signed in'; }
  else if (accountOk(o.account) && o.signed_in !== null) { account = o.account; signed_in = true; reason = null; }
  else reason = said ?? (o.account == null ? 'who is signed in could not be told' : 'the account read named no account of M4\'s');
  return writer.put(ACCOUNT_FACT, { kind: 'fact.signed-in-account', account, signed_in, reason, observed_at });
}

// One writer per value fact, so each kind is written out in full (l25.test.mjs finds every kind by its literal name).
const VALUE_KINDS = Object.freeze({ network: 'fact.network-up', reachable: 'fact.frontdoor-reachable', minibase: 'fact.minibase-running' });

export async function writeReading(writer, which, probe, { now = () => new Date() } = {}) {
  if (!Object.hasOwn(VALUE_KINDS, which)) throw new Error(`no reading called ${which}`);
  const observed_at = stamp(now);
  const v = await probe();
  return writer.put(FACTS[which], { kind: VALUE_KINDS[which], value: v === true || v === false ? v : null, observed_at });
}

// exit: the worker's exit result, { account, resets_at, source }. A hit is always written, even with no readable reset
// time (L97 M-3). M11 resumes a card only on a hit observed after the card's run began (the wait's run_started, which
// M9 sets from the claim; MAT-1), with a reset time that has passed; a hit with no reset time puts the card on Joe. A
// reset time already more than PAST_SLACK_MS before the hit is unreadable too (#78 r2 m-3: "resets 1am" read at 11pm as
// today's 1am would resume the card a minute later, hit again, and loop every pass). One more than a week after the hit
// is written as given; M11 reads it as unreadable (pass.mjs LIMIT_RESET_MAX_MS, audit #125 r1 MAT-A).
// With no readable time, the stored hit's reset time is kept if it is still ahead. ASSUMPTION, not checked (#78 r2
// c-2): a reset still ahead belongs to the same limit window as this hit; the fact stores no window to check it by. It
// is kept so a second worker hitting the limit does not throw away the time the first one learned, or the card would
// wait for good (lane 3 review of r2). Otherwise resets_at is null, so yesterday's past reset never resumes a card early.
// A newer readable time always wins over the kept one.
// Only a hit that names no known account is refused: there is no fact id to write it under. A writer with no get()
// cannot apply the keep rule, so it is refused outright (#78 r2 m-4), never silently skipped.
export const PAST_SLACK_MS = 10_000;
export async function writeLimitHit(writer, exit, { now = () => new Date() } = {}) {
  if (typeof writer?.get !== 'function') throw new Error('writeLimitHit needs a fact writer with get() (the keep rule reads the stored hit)');
  const observed_at = stamp(now);
  if (!accountOk(exit?.account)) return { ok: false, reason: 'the limit hit names no known account' };
  let resets_at = timeOrNull(exit.resets_at);
  if (resets_at !== null && Date.parse(resets_at) < Date.parse(observed_at) - PAST_SLACK_MS) resets_at = null;
  if (resets_at === null) {
    const kept = timeOrNull(writer.get(LIMIT_FACT(exit.account))?.resets_at);
    if (kept && Date.parse(kept) > Date.parse(observed_at)) resets_at = kept;
  }
  return writer.put(LIMIT_FACT(exit.account), { kind: 'fact.limit-hit', account: exit.account, resets_at, observed_at, source: exit.source ?? null });
}

// The writer for each family M11 reads, by its M9 family name (M11 READ_FACTS' `family`): the function itself, called
// as (writer, port, opts), never a name (L97 m-4). The coverage test calls each one and checks it writes that family.
export const WRITERS = Object.freeze({
  'pr-': (writer, gh, { number, ...o } = {}) => writePrFact(writer, gh, number, o),
  'usage-': (writer, readUsage, { account, ...o } = {}) => writeUsageFact(writer, readUsage, account, o),
  'signed-in-account': writeSignedInAccount,
  'network-up': (writer, probe, o) => writeReading(writer, 'network', probe, o),
  'frontdoor-reachable': (writer, probe, o) => writeReading(writer, 'reachable', probe, o),
  'minibase-running': (writer, probe, o) => writeReading(writer, 'minibase', probe, o),
  'limit-hit-': writeLimitHit,
});
