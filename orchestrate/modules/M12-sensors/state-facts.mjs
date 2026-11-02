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
//   readUsage(account)  → { h5: { used_pct, resets_at }, week: { used_pct, resets_at }, source } | null
//   whoIsSignedIn()     → the account name, or null when nobody is signed in or it can't be read
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

export async function writeUsageFact(writer, readUsage, account, { now = () => new Date() } = {}) {
  if (!accountOk(account)) return { ok: false, reason: 'no known account to read usage for' };
  const observed_at = stamp(now);
  const r = await readUsage(account);
  if (!r) return { ok: false, reason: `no usage reading for ${account}` };
  const win = (w) => ({ used_pct: w?.used_pct ?? null, resets_at: w?.resets_at ?? null });
  return writer.put(USAGE_FACT(account), { kind: 'fact.usage', account, observed_at, source: r.source ?? null, h5: win(r.h5), week: win(r.week) });
}

export async function writeSignedInAccount(writer, whoIsSignedIn, { now = () => new Date() } = {}) {
  const observed_at = stamp(now);
  const a = await whoIsSignedIn();
  return writer.put(ACCOUNT_FACT, { kind: 'fact.signed-in-account', account: accountOk(a) ? a : null, observed_at });
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
// time (L97 M-3): then resets_at is null, which replaces an older hit's time. M11 resumes a card only on a hit observed
// after the card began to wait, with a reset time that has passed, so a null keeps it waiting (never resumes early on
// yesterday's reset). Only a hit that names no known account is refused: there is no fact id to write it under.
export async function writeLimitHit(writer, exit, { now = () => new Date() } = {}) {
  const observed_at = stamp(now);
  if (!accountOk(exit?.account)) return { ok: false, reason: 'the limit hit names no known account' };
  return writer.put(LIMIT_FACT(exit.account), { kind: 'fact.limit-hit', account: exit.account, resets_at: timeOrNull(exit.resets_at), observed_at, source: exit.source ?? null });
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
