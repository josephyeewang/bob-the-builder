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

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const refuse = (reason) => ({ ok: false, reason });

export const snapshotHash = (rules) => createHash('sha256').update(JSON.stringify(rules)).digest('hex');

export function staleReason(ageMs, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  return `rules snapshot is stale (${Math.round(ageMs / 1000)} s old, the limit is ${Math.round(maxAgeMs / 1000)} s), `
    + 'so every call is refused until it is rewritten; the loop rewrites it every pass, so a stale one means the loop '
    + 'has stopped, or a run that wrote its own snapshot outlasted it (keep it fresh with keepSnapshotFresh)';
}

export function parseSnapshot(text, { now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  let s; try { s = JSON.parse(text); } catch { return refuse('rules snapshot is not JSON'); }
  if (!s || typeof s !== 'object' || !s.rules || typeof s.rules !== 'object') return refuse('rules snapshot has no rules');
  if (typeof s.hash !== 'string' || snapshotHash(s.rules) !== s.hash) return refuse('rules snapshot hash does not match');
  const at = Date.parse(s.written_at);
  if (!Number.isFinite(at)) return refuse('rules snapshot has no time');
  const age = now - at;
  if (age > maxAgeMs) return refuse(staleReason(age, maxAgeMs));
  if (age < -60000) return refuse('rules snapshot is from the future');
  return { ok: true, rules: s.rules, writtenAt: s.written_at, hash: s.hash };
}

export function readSnapshot(path, opts = {}) {
  let text; try { text = readFileSync(path, 'utf8'); } catch { return refuse('rules snapshot is missing or unreadable'); }
  return parseSnapshot(text, opts);
}

/** For tests and the fake: builds a snapshot file body. */
export function makeSnapshot(rules, at = new Date()) {
  return JSON.stringify({ written_at: at.toISOString(), hash: snapshotHash(rules), rules });
}

/** Writes a snapshot whole: to a side file first, then renamed, so a hook never reads half of one. */
export function writeSnapshot(path, rules, at = new Date()) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, makeSnapshot(rules, at));
  renameSync(tmp, path);
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
