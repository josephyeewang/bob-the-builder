// M4's reader for the rules snapshot (launch check 8; review 0b-3 M4, m9).
//
// The rules publish a snapshot file the hooks and the launcher read instead of asking anything
// live. Shape assumed until lane 1's shared reader lands: { written_at: ISO, hash, rules } with
// hash = sha256 of JSON.stringify(rules). Missing, unreadable, bad hash, or older than 5 minutes
// means refuse.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const refuse = (reason) => ({ ok: false, reason });

export const snapshotHash = (rules) => createHash('sha256').update(JSON.stringify(rules)).digest('hex');

export function parseSnapshot(text, { now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  let s; try { s = JSON.parse(text); } catch { return refuse('rules snapshot is not JSON'); }
  if (!s || typeof s !== 'object' || !s.rules || typeof s.rules !== 'object') return refuse('rules snapshot has no rules');
  if (typeof s.hash !== 'string' || snapshotHash(s.rules) !== s.hash) return refuse('rules snapshot hash does not match');
  const at = Date.parse(s.written_at);
  if (!Number.isFinite(at)) return refuse('rules snapshot has no time');
  const age = now - at;
  if (age > maxAgeMs) return refuse(`rules snapshot is stale (${Math.round(age / 1000)} s old)`);
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
