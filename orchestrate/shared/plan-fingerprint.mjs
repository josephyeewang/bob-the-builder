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

// The one rule for a plan's file path, exported so a plan's wave check (M3) compares the same cleaned form (L87 M-1).
// Returns the cleaned path, or null when it is not one plain path. Refused besides the shape rules: control characters,
// line and paragraph separators, and every Unicode format character (\p{Cf}: zero-width spaces and joiners U+200B-200F,
// direction overrides U+202A-202E and isolates U+2066-2069, the byte-order mark U+FEFF, soft hyphen and the rest).
// Those draw nothing on screen, so a path holding one reads to Joe as a different file from the one it names (L95 Minor 4).
const UNPRINTED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
export function cleanPath(p) {
  if (typeof p !== 'string' || !p) return null;
  let q = p.normalize('NFC');
  while (q.startsWith('./')) q = q.slice(2);
  if (!q || q.endsWith('/') || q.startsWith('/') || /[*?[\]{}]/.test(q) || q.includes('\\') || UNPRINTED.test(q) || q.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return q;
}

// The one key two plan paths are compared by (L93 m-1): the cleaned path, fully case-folded, in NFC. The Mac's default
// disk ignores case, so two cards naming `straße.js` and `STRASSE.js`, or `ς.js` and `σ.js`, touch one file. A plain
// toLowerCase misses both (ß stays ß; final ς stays ς), so this folds through upper case first (ß → SS → ss, ς → Σ → σ,
// ﬁ → FI → fi), then NFC again, since a case change can leave text out of NFC. It folds slightly MORE than Unicode's
// own case folding (dotless ı and i become one), which can only report a collision that isn't there, never miss one.
// The fingerprint keeps case (cleanPath); this key answers "is it the same file", never what the worker is told.
export function pathKey(p) {
  const q = cleanPath(p);
  return q === null ? null : q.toUpperCase().toLowerCase().normalize('NFC');
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
