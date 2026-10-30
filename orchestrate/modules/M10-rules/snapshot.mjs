// snapshot.mjs — a small signed-off copy of the current rules on the Mini's disk, for checks that run inside a hook
// and must answer in milliseconds without the network (spec review 0b-1: MAT-9; round 2: R2-M6).
//
// WHY. A hook (for example the production-write guard) can't wait on GitHub. So the Do-plane writes this file every
// pass, and the hook reads it. The file is refused, never "trusted anyway", if it is missing, damaged, not the
// format we wrote, older than 300 s, from the future, a link, or if the file or its folder is writable by anyone but
// its owner. It answers only hook-time questions; starting a session needs the live state (product pause, running
// count, usage) and is answered by the Do-plane only (R2-M6(a)).
//
//   publishSnapshot(dir, { products: { <p>: { status, rules, rev } }, mac, pin_ok }, now)
//   readSnapshot(dir, now)                       → { ok: true, body } | { ok: false, reason }
//   snapshotAnswer(readSnapshot(dir, now), action, { product })   → a decision, same shape as rules.may()
//
// snapshotAnswer is the ONLY way a hook reads the snapshot (0b-1 R3-m1): reading protected_files straight from the
// body would miss M10's built-in protected floor. A hook question added later becomes a named action here, includes
// the floor, and gets a test that it equals the live answer.
//
// This file imports nothing that can reach the network (a test checks the import list).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, statSync, chmodSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { allow, deny } from '../../shared/rules.mjs';

export const SNAPSHOT_FILE = 'rules-snapshot.json';
export const FORMAT = 1;
export const MAX_AGE_MS = 300_000;
export const MAX_FUTURE_MS = 60_000;
export const STATUSES = Object.freeze(['ok', 'last_good', 'deny_all']);
export const HOOK_ACTIONS = Object.freeze(['write_production', 'snapshot_fresh']);

// JSON with keys in a fixed order, so the same body always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const hash = (body) => createHash('sha256').update(canonical(body)).digest('hex');

function checkBody(body) {
  if (!body || typeof body !== 'object' || !body.products || typeof body.products !== 'object') throw new Error('snapshot body needs products');
  for (const [p, e] of Object.entries(body.products)) {
    if (!e || !STATUSES.includes(e.status)) throw new Error(`snapshot ${p}: bad status`);
    if (e.status === 'deny_all' && e.rules !== null) throw new Error(`snapshot ${p}: deny_all carries no rules`);
    if (e.status !== 'deny_all' && (!e.rules || typeof e.rev !== 'string')) throw new Error(`snapshot ${p}: rules and rev needed`);
  }
}

export function publishSnapshot(dir, body, now = Date.now()) {
  checkBody(body);
  const doc = { format: FORMAT, written_at: new Date(now).toISOString(), body, sha256: hash(body) };
  const f = join(dir, SNAPSHOT_FILE);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o644 });
  chmodSync(tmp, 0o644);                     // the umask can't loosen or tighten it
  renameSync(tmp, f);
}

export function readSnapshot(dir, now = Date.now()) {
  const f = join(dir, SNAPSHOT_FILE);
  const mine = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();
  // The folder too (MAT-9): anyone who can write the folder can swap the file for another.
  let ds;
  try { ds = statSync(dir); } catch { return { ok: false, reason: 'snapshot missing' }; }
  if (!ds.isDirectory() || (ds.mode & 0o022) !== 0) return { ok: false, reason: 'snapshot folder is writable by others' };
  if (!mine(ds)) return { ok: false, reason: 'snapshot folder owned by someone else' };
  // Open once, refusing a symlink, then check and read that same open file, so it can't be swapped in between.
  let fd; let doc;
  try { fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'snapshot missing' : 'snapshot is a link or unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o022) !== 0) return { ok: false, reason: 'snapshot is writable by others' };
    if (!mine(st)) return { ok: false, reason: 'snapshot owned by someone else' };
    try { doc = JSON.parse(readFileSync(fd, 'utf8')); } catch { return { ok: false, reason: 'snapshot unreadable' }; }
  } finally { closeSync(fd); }
  if (!doc || doc.format !== FORMAT) return { ok: false, reason: 'snapshot format unknown' };
  if (typeof doc.sha256 !== 'string' || hash(doc.body) !== doc.sha256) return { ok: false, reason: 'snapshot damaged' };
  const at = Date.parse(doc.written_at);
  if (!Number.isFinite(at)) return { ok: false, reason: 'snapshot has no time' };
  if (now - at > MAX_AGE_MS) return { ok: false, reason: 'snapshot stale' };
  if (at - now > MAX_FUTURE_MS) return { ok: false, reason: 'snapshot from the future' };
  try { checkBody(doc.body); } catch (e) { return { ok: false, reason: e.message }; }
  return { ok: true, body: doc.body };
}

// Hook-time answers, from a readSnapshot() result. Pure: no file or clock reads here.
//   snapshot_fresh   → allow when the snapshot read cleanly (and, if a product is named, its rules are usable).
//   write_production → always deny in 0b (MAT-5); a broken snapshot is reported as such, not hidden behind that rule.
export function snapshotAnswer(snap, action, subject = {}) {
  if (!HOOK_ACTIONS.includes(action)) return { ...deny(`${action} is not answered from the snapshot`), rev: null };
  if (!snap?.ok) return { ...deny(snap?.reason ?? 'snapshot unread'), rev: null };
  if (action === 'snapshot_fresh' && subject.product === undefined) return { ...allow('snapshot fresh'), rev: null };
  const entry = Object.hasOwn(snap.body.products, subject.product ?? '') ? snap.body.products[subject.product] : null;
  if (!entry) return { ...deny('unknown product'), rev: null };
  if (entry.status === 'deny_all') return { ...deny('rules unusable for this product'), rev: null };
  if (action === 'snapshot_fresh') return { ...allow('snapshot fresh'), rev: entry.rev };
  return { ...deny('production writes are not allowed in this phase'), rev: entry.rev };
}
