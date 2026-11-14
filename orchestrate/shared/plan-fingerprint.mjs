// plan-fingerprint.mjs — the one fingerprint of a card's plan, which the owner's go binds to (0b-5 M7, 0b-2 R2-M12, R2-M5).
//
// WHY. A go from the owner counts only for the plan they saw. M2 Approvals stores the fingerprint on the go; M9 Record
// recomputes it from the card's current fields at `draft → ready` and finds a go with the same hash. Both import this
// file, so the two can't disagree. The card stores no trusted fingerprint of its own.
//
//   planFingerprint({ product, card_id, tier, files, done_when, plan_sha256, main_commit })
//     → { ok: true, sha256, canonical, inputs } | { ok: false, reason }
//   card_id is the ROOT card's id: a fix card inherits its root's go (R2-M5), so callers pass the root id.
//
// Canonical form: JSON with keys sorted at every level, strings in Unicode NFC, no spaces; sha256 of its UTF-8 bytes.
//   files     sorted, de-duplicated POSIX paths; no "./", no trailing "/", case kept. A folder pattern (*, ?, [, {) is
//             refused, so the whole go is refused.
//   done_bar  [done_when] for Tier 2; [done_when, "audited until 0 Material"] for Tier 1.
//   Tier 1 also binds plan_sha256 (64 hex) and main_commit (40 hex); Tier 2 has both null.

import { createHash } from 'node:crypto';

export const TIER1_BAR = 'audited until 0 Material';
/** A SHA-256 as 64 lower-case hex: the one pattern every fingerprint, bundle and file check uses (I7: one home). */
export const SHA256 = /^[0-9a-f]{64}$/;
/** A git object id (commit, blob) as 40 lower-case hex. */
export const SHA40 = /^[0-9a-f]{40}$/;
/** The refusal when a plan can't be fingerprinted (go.mjs, setup/go-card.mjs): one text (I7). */
export const unfingerprinted = (reason) => `the plan can't be fingerprinted: ${reason}`;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

export function canonicalJson(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('not a finite number'); return JSON.stringify(v); }
  if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  throw new Error(`cannot fingerprint a ${typeof v}`);
}

// A path's shape, before any plan rule: one relative POSIX path with no empty, "." or ".." name, no folder pattern
// (*, ?, [, {), no backslash, no control character or line separator, no Unicode format character (\p{Cf}), and
// well formed (no lone surrogate: the disk writes each as U+FFFD, so three spellings are one file; L105 M-2). NFC.
// Also refused, as M10 pathProblem and M11's start gate refuse them, so a plan never passes here and then stops later
// (audit-pr133 m-2 and the pre-existing case, L289): over 4096 characters, a leading `~` (a home folder), any `:` (a
// drive letter, and the Finder shows `:` as `/`), and a path that is only spaces.
// Returns the path in NFC with any leading "./" taken off, or null.
// Exported as the one rule for a character no screen should be trusted to show (M2's question box too, L798).
export const UNPRINTED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
function shapeClean(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || !p.isWellFormed()) return null;
  let q = p.normalize('NFC');
  while (q.startsWith('./')) q = q.slice(2);
  if (!q.trim() || q.startsWith('~') || q.includes(':') || q.endsWith('/') || q.startsWith('/') || /[*?[\]{}]/.test(q) || q.includes('\\') || UNPRINTED.test(q) || q.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return q;
}

// The one rule for a plan's file path, exported so a plan's wave check (M3) compares the same cleaned form (L87 M-1).
// Returns the cleaned path, or null when it is not one plain path. Besides the shape rules, a plan path is plain
// printable ASCII only (L105): the same rule M10's pathProblem applies to a change's files, so a plan can't name a file
// M10 would send to Joe. That closes, by its root, every character that draws nothing or looks like another one
// (format characters, fillers, variation selectors, non-ASCII spaces, combining marks, fullwidth slashes; L95 Minor 4).
const PLAIN = /^[\x20-\x7e]+$/;
export function cleanPath(p) {
  const q = shapeClean(p);
  return q !== null && PLAIN.test(q) ? q : null;
}

// The one case fold for "is it the same file" (L93 m-1, L105 M-1, L297): NFC first, then lower, upper, lower, every
// final ς as σ, then NFC again. NFC comes first because a case change can split one file's two spellings: `ᾴ` typed
// as α + iota subscript + accent upper-cases the subscript to Ι before the accent, and folded to αί, not άι
// (audit-pr133-r2 Minor 1).
// The Mac's default disk
// ignores case and Unicode normalization. A plain toLowerCase misses ß/SS and final ς/σ; upper-then-lower misses the
// capital sharp S (ẞ → ß, but ß → SS). Measured against the Mac's own disk on 16,627 names (audit-pr84 r1): 0 groups
// the disk treats as one file get two keys. One false collision is known (dotless ı and i), the safe direction: it can
// only call two files one. Null for a string that is not well formed. Every module compares paths by this or by
// pathKey, never by a fold of its own (the guard test in plan-fingerprint.test.mjs). Final ς becomes σ because the
// fold picks σ or ς from the letters around it, and a pattern's `*` changes those: `docs/aσ*` folded to `docs/aς*` and
// missed `docs/aσb.md` (audit-pr133 m-1). The disk treats ς and σ as one letter anyway.
export function foldKey(s) {
  if (typeof s !== 'string' || !s.isWellFormed()) return null;
  return s.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().replaceAll('ς', 'σ').normalize('NFC');
}

// The form a pattern and a path are matched in (M11's start gate): foldKey, then NFD, so a pattern's plain letter
// still matches the same letter with an accent, as `docs/cafe*` matches `docs/café.md` (audit-pr133-r2 Minor 2).
// Null when foldKey is.
export function matchForm(s) {
  const k = foldKey(s);
  return k === null ? null : k.normalize('NFD');
}

// The one key two plan paths are compared by (M3's duplicate and wave checks): the path's shape cleaned, then foldKey.
// It does not apply the ASCII rule, so it answers "is it the same file" for any path; a caller that needs a plan path
// also asks cleanPath (M3 filesProblems does). M11's start gate keys paths with its own shape rules (normPath) and this
// same foldKey. With NFC first in foldKey (L297), the two keys were identical wherever pathKey accepts a path, and two
// spellings of one name never got two keys, on 300,000 simulated paths (audit-pr133-r2; before it, 178 of 400,000
// Greek-heavy paths disagreed). That is a measurement, not a proof. The fingerprint keeps case (cleanPath); this key
// is never what the worker is told.
export function pathKey(p) {
  const q = shapeClean(p);
  return q === null ? null : foldKey(q);
}

export function planFingerprint(plan) {
  try {
    const { product, card_id: cardId, tier, files, done_when: doneWhen, plan_sha256: planSha, main_commit: mainCommit } = plan ?? {};
    if (typeof product !== 'string' || !product) return { ok: false, reason: 'no product' };
    if (typeof cardId !== 'string' || !cardId) return { ok: false, reason: 'no card id' };
    if (tier !== 1 && tier !== 2) return { ok: false, reason: 'tier must be 1 or 2' };
    if (!Array.isArray(files) || !files.length) return { ok: false, reason: 'no file list' };
    const list = [];
    for (let i = 0; i < files.length; i++) {
      const c = cleanPath(files[i]);
      if (!c) return { ok: false, reason: `file ${JSON.stringify(String(files[i]).slice(0, 80))} is not one plain path` };
      list.push(c);
    }
    if (typeof doneWhen !== 'string' || !doneWhen.trim()) return { ok: false, reason: 'no done_when' };
    if (tier === 1 && !(typeof planSha === 'string' && HEX(64).test(planSha))) return { ok: false, reason: 'Tier 1 needs plan_sha256 (64 hex)' };
    if (tier === 1 && !(typeof mainCommit === 'string' && HEX(40).test(mainCommit))) return { ok: false, reason: 'Tier 1 needs main_commit (40 hex)' };
    const inputs = {
      product, card_id: cardId, tier,
      files: [...new Set(list)].sort(),
      done_bar: tier === 1 ? [doneWhen, TIER1_BAR] : [doneWhen],
      plan_sha256: tier === 1 ? planSha : null,
      main_commit: tier === 1 ? mainCommit : null,
    };
    const canonical = canonicalJson(inputs);
    return { ok: true, sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'), canonical, inputs };
  } catch (e) {
    return { ok: false, reason: `cannot fingerprint: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}
