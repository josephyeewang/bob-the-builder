// state-facts.mjs — the readings the Dispatcher (M11) decides on, written into the record (R-0b-168).
//
// WHY. M11 reads facts it never writes: the usage numbers, the signed-in account, whether the network, the Front Door
// and Mini Base are up, and a limit hit's reset time. Before this file M11's tests seeded those facts by hand, so a
// field the Sensors never wrote (observed_at above all) could be missing in real use while every test passed. Each
// writer here takes its reading from an injected port (the device read on the Mini; a fake in tests), then stamps
// observed_at from the injected clock AFTER the port has returned, so a slow read is never dated before it ended.
// The fact ids are M11's own (imported, not copied), and every fact passes the allow-list in fact-shapes.mjs.
//
// Ports (each may be async):
//   readUsage(account)  → { h5: { used_pct, resets_at }, week: { used_pct, resets_at }, source } | null
//   whoIsSignedIn()     → the account name, or null when nobody is signed in or it can't be read
//   probe()             → true | false | null (null = could not tell; M11 reads it as unknown)
// The limit-hit writer takes the worker's exit result instead of a port: the worker learns the reset time, and the
// Sensors write it (M9 lists limit-hit- under the sensors family, so the Sensors are its one writer).

import { USAGE_FACT } from '../M11-dispatcher/usage.mjs';
import { ACCOUNT_FACT } from '../M11-dispatcher/tick.mjs';
import { FACTS } from '../M11-dispatcher/phone-link.mjs';
import { LIMIT_FACT } from '../M11-dispatcher/pass.mjs';

const stamp = (now) => now().toISOString();
const nameOk = (a) => typeof a === 'string' && a.length > 0;

export async function writeUsageFact(writer, readUsage, account, { now = () => new Date() } = {}) {
  if (!nameOk(account)) return { ok: false, reason: 'no account to read usage for' };
  const r = await readUsage(account);
  const observed_at = stamp(now);
  if (!r) return { ok: false, reason: `no usage reading for ${account}` };
  const win = (w) => ({ used_pct: w?.used_pct ?? null, resets_at: w?.resets_at ?? null });
  return writer.put(USAGE_FACT(account), { kind: 'fact.usage', account, observed_at, source: r.source ?? null, h5: win(r.h5), week: win(r.week) });
}

export async function writeSignedInAccount(writer, whoIsSignedIn, { now = () => new Date() } = {}) {
  const a = await whoIsSignedIn();
  const observed_at = stamp(now);
  return writer.put(ACCOUNT_FACT, { kind: 'fact.signed-in-account', account: nameOk(a) ? a : null, observed_at });
}

// One writer per value fact, so each kind is written out in full (l25.test.mjs finds every kind by its literal name).
const VALUE_KINDS = Object.freeze({ network: 'fact.network-up', reachable: 'fact.frontdoor-reachable', minibase: 'fact.minibase-running' });

export async function writeReading(writer, which, probe, { now = () => new Date() } = {}) {
  if (!Object.hasOwn(VALUE_KINDS, which)) throw new Error(`no reading called ${which}`);
  const v = await probe();
  const observed_at = stamp(now);
  return writer.put(FACTS[which], { kind: VALUE_KINDS[which], value: v === true || v === false ? v : null, observed_at });
}

// exit: the worker's exit result, { account, resets_at, source }. Nothing is written without a reset time: M11
// resumes a card only after it, so a guessed one would resume too early.
export async function writeLimitHit(writer, exit, { now = () => new Date() } = {}) {
  const observed_at = stamp(now);
  if (!nameOk(exit?.account)) return { ok: false, reason: 'the limit hit names no account' };
  if (typeof exit.resets_at !== 'string' || !Number.isFinite(Date.parse(exit.resets_at))) return { ok: false, reason: 'the limit hit has no reset time' };
  return writer.put(LIMIT_FACT(exit.account), { kind: 'fact.limit-hit', account: exit.account, resets_at: exit.resets_at, observed_at, source: exit.source ?? null });
}

// The writer for each family M11 reads, by its M9 family prefix (what lane 2's READ_FACTS names). The coverage test
// checks this against M11's list both ways.
export const WRITERS = Object.freeze({
  'pr-': 'pr-facts.mjs writePrFact',
  'usage-': 'state-facts.mjs writeUsageFact',
  'signed-in-account': 'state-facts.mjs writeSignedInAccount',
  'network-up': 'state-facts.mjs writeReading network',
  'frontdoor-reachable': 'state-facts.mjs writeReading reachable',
  'minibase-running': 'state-facts.mjs writeReading minibase',
  'limit-hit-': 'state-facts.mjs writeLimitHit',
});
