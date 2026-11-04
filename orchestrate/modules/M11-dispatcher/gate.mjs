// The start gate (R-0b-61, R-0b-67; design v4 §6.2, G4, §14.1.3 check 12; review 0b-6 M13, M14, M20, m11).
// One function decides whether a session may start: the usage band, the caps, and the files-don't-
// overlap check. The pass calls it, and so does M4's launch check 12 (`check12`), so there is one
// answer (m11). It reads; it never writes.
//
// Sessions it counts are the running ones the pass hands in: { id, product, kind, card, lead, files,
// bundle_files }. kind is editing | undo | script | readonly | review | audit | merge | undo_merge | lead | front_door.

import { posix } from 'node:path';
import { KEYS, MissingKey, need } from './keys.mjs';
import { wholeNumber } from '../../shared/rules.mjs';
import { mayStart } from './usage.mjs';
import { foldKey, matchForm } from '../../shared/plan-fingerprint.mjs';
import { STATES } from '../../shared/record-names.mjs';

const refuse = (reason) => ({ ok: false, reason });
const ROW_FILE = /^docs\/blueprint\/rows\/([^/]+)\.yaml$/;

/** A repo path, normalised and folded by the one shared fold (shared/plan-fingerprint.mjs foldKey; L105 M-3), as the
 * Mac's disk compares names. Null for a path outside the repo or one that is not well formed. */
export function normPath(p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return null;
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n === '..' || n.startsWith('../') || n === '.' || n.endsWith('/')) return null;
  return foldKey(n);
}

/** `**` matches any depth, `*` one name. Patterns are folded like paths (foldKey); one that can't be folded matches
 * everything, so it counts as an overlap, never as none. Both sides are compared in the shared matchForm (NFD), so `docs/cafe*` still matches
 * `docs/café.md`, whose é is e plus an accent there (audit-pr133-r2 Minor 2). */
export function matches(pattern, path) {
  const p = matchForm(String(pattern));
  if (p === null) return true;
  const re = new RegExp(`^${p.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  return re.test(matchForm(String(path)) ?? '');
}

/** A card's own file set, or a refusal. The daily card also carries its patterns. */
export function fileSet(card, { dailyPatterns }) {
  const out = new Set();
  const named = new Set((card.rows ?? []).map((r) => foldKey(String(r))));
  if (named.has(null)) return refuse('the card names a row id that is not well formed');
  for (const f of card.files ?? []) {
    if (typeof f === 'string' && !f.isWellFormed()) return refuse(`the card names a path that is not well formed (${JSON.stringify(f)})`);
    const n = normPath(f);
    if (!n) return refuse(`the card names a path outside the repo (${f})`);
    const row = ROW_FILE.exec(n);
    if (row && !named.has(row[1])) return refuse(`the card touches row ${row[1]} without naming it`);
    out.add(n);
  }
  for (const id of named) out.add(`docs/blueprint/rows/${id}.yaml`);
  return { ok: true, files: out, patterns: card.kind === 'daily' ? dailyPatterns : [] };
}

// A pattern hit names a pattern that can't be folded, so a run held by it says why (L247).
const byPattern = (p, f) => (foldKey(String(p)) === null ? `${f} (daily pattern ${JSON.stringify(String(p))} can't be folded, so it counts as every file)` : f);
function overlaps(a, b) {
  for (const f of a.files) if (b.files.has(f)) return f;
  for (const p of a.patterns) for (const f of b.files) if (matches(p, f)) return byPattern(p, f);
  for (const p of b.patterns) for (const f of a.files) if (matches(p, f)) return byPattern(p, f);
  return null;
}

// Undo workers are worker-profile sessions too (M14, audit MIN-7): a running one counts toward the editing caps
// for every other editing start. An exact-reverse undo's own start is not held by those caps (L199): see startGate.
// Overnight runs edit files too (audit 0b-6 r2, L27): they count toward the caps, never around them.
const isEditing = (s) => s.kind === 'editing' || s.kind === 'undo' || s.kind === 'overnight';
// Every session that writes files takes part in the files-don't-overlap check (audit MIN-16).
// Sessions that finish work or answer the owner; they write no product files, so the caps do not apply.
const CAP_FREE = Object.freeze(['review', 'audit', 'merge', 'undo_merge', 'lead', 'front_door']);
const writesFiles = (s) => isEditing(s) || s.kind === 'script';
// The product states the Record knows (shared/record-names.mjs). A product with no state, or one not in this list,
// is read as paused, as M10 reads it (L210).
const PRODUCT_STATES = STATES.product;
// An undo card in one of these states is taken or running: it counts toward the one-undo limit even when the
// running-sessions list does not hold it (a launch that timed out leaves its card claimed; #117 audit m2).
const UNDO_LIVE = Object.freeze(['claimed', 'running']);

/**
 * The card's tier and risky classes, failing closed (audit MAT-3, MIN-15): the risky set is the card's
 * own plus what rules.classify finds in its files, and the tier is the stricter of the two. A card with
 * no tier is Tier 1. No card (a Lead's read-only session) is tier null.
 */
export function riskOf(rules, card) {
  if (!card) return { tier: null, risky: [] };
  const own = card.tier === 2 ? 2 : 1;
  const c = rules.classify({ product: card.product, files: (card.files ?? []).map((path) => ({ path, status: 'modified' })), declared_tier: card.tier });
  return { tier: own === 2 && c.tier === 2 ? 2 : 1, risky: [...new Set([...(card.risky ?? []), ...(c.risky ?? [])])] };
}

/** The editing caps for a product (M14). */
export function editingLimits({ rules, product, productDoc, amberCaps }) {
  const state = productDoc?.state;
  // per_state is a map, so its values come as the rules file's text; each is read by the shared whole-number rule (L123).
  const perState = need(rules, KEYS.perState, { product, type: 'object' });
  const has = Object.hasOwn(perState, state);
  const stateCap = has ? wholeNumber(perState[state]) : undefined;
  // `unreadable`: the state's value is there but is not a whole number, a rule nobody can read (L210 point 3).
  if (stateCap === undefined) throw has ? new MissingKey(KEYS.perState, `value for ${state} is unreadable`, { unreadable: true }) : new MissingKey(KEYS.perState, `has no value for ${state}`);
  const forProduct = [need(rules, KEYS.editingPerProduct, { product }), stateCap];
  const forMac = [need(rules, KEYS.editingPerMac)];
  if (amberCaps) {
    forProduct.push(need(rules, KEYS.amberEditingPerProduct, { product }));
    forMac.push(need(rules, KEYS.amberEditingPerMac));
  }
  if (need(rules, KEYS.shakedown, { product, type: 'boolean' })) forProduct.push(need(rules, KEYS.shakedownWorkers, { product }));
  return { product: Math.min(...forProduct), mac: Math.min(...forMac) };
}

/**
 * May this start now? `card` is the card doc (with id) or null for a session with no card; `kind` as
 * above; `b` the bands from usage.mjs; `running` the running sessions Mac-wide; `lead` the asking
 * Lead's session id for a read-only session. `exactReverse` is true only when the caller has checked
 * that an undo card is the exact reverse of a merge in the record (undo.mjs `exactReverse`).
 */
export function startGate({ rules, rec, card, kind, product, b, running, lead, exactReverse = false }) {
  try {
    // An undo needs no band value, so a missing red_runs never holds it (audit 0b-6 r3 MAT-3, L31).
    const redRuns = kind === 'undo' || kind === 'undo_merge' ? [] : need(rules, KEYS.redRuns, { type: 'list' });
    const { tier, risky } = riskOf(rules, card);
    const band = mayStart({ b, kind, tier, risky, repair: card?.kind === 'repair', redRuns });
    if (!band.ok) return band;
    const mine = running.filter((s) => s.product === product);
    if (kind === 'readonly') {
      // M20: a Lead's thinking sessions count against its own read-only swarm, never the editing caps.
      if (!lead) return refuse('a read-only session needs the asking Lead');
      const cap = need(rules, KEYS.readonlyPerSession, { product });
      const n = running.filter((s) => s.kind === 'readonly' && s.lead === lead).length;
      return n >= cap ? refuse(`the Lead already has ${n} read-only sessions (cap ${cap})`) : { ok: true };
    }
    if (kind === 'script') {
      const perProduct = need(rules, KEYS.scriptsPerProduct, { product });
      const perMac = need(rules, KEYS.scriptsPerMac);
      if (mine.filter((s) => s.kind === 'script').length >= perProduct) return refuse(`the product already runs ${perProduct} script(s)`);
      if (running.filter((s) => s.kind === 'script').length >= perMac) return refuse(`the Mac already runs ${perMac} scripts`);
      return disjoint({ rules, card, product, others: mine.filter(writesFiles), rec });
    }
    // Only named kinds skip the caps; any other kind is refused, not let through (audit 0b-6 r2, L27).
    if (CAP_FREE.includes(kind)) return { ok: true };
    if (!isEditing({ kind })) return refuse(`unknown session kind ${kind}: start nothing`);
    const productDoc = rec.read('product', product)?.doc;
    if (!productDoc) return refuse(`no product record for ${product}`);
    // The shared undo rule (L31, L199, L210): an undo (an exact-reverse card) is never refused
    // by the product's state or the editing caps, a cap of 0 included. Its own limit: at most one undo running per
    // product. A running undo still counts toward the caps for every other editing start (isEditing). A paused
    // product starts its undo, the same way push and merge already let an exact reverse through; every other
    // editing start on a paused product is refused. A product with no state, or a state the Record doesn't know, is
    // read as paused. A missing cap value is still named for the undo (L40), so Joe is told; a cap value that is
    // there but unreadable, whichever cap it is, is a rule nobody can read, and refuses the undo too (L228). The
    // files-don't-overlap check below is safety and still runs. This gate does not read M10's product-state rules
    // (an unknown merge or start rule): production asks M10 first (pass.mjs starts()), and M10 refuses those.
    const exactUndo = kind === 'undo' && exactReverse === true && card?.kind === 'exact_reverse';
    const paused = !PRODUCT_STATES.includes(productDoc.state) || productDoc.state === 'paused';
    let lim = null;
    let capMissing = null;
    // A state read as paused is looked up as paused, so an unknown state names no rule of its own.
    try { lim = editingLimits({ rules, product, productDoc: paused ? { ...productDoc, state: 'paused' } : productDoc, amberCaps: band.amberCaps }); } catch (e) { if (!(exactUndo && e.key && !e.unreadable)) throw e; capMissing = e.key; }
    // After the caps are read, so a broken or missing value for any state is still named (M10's readers check).
    if (paused && !exactUndo) return refuse(`${product} is paused: only its undo starts`);
    if (exactUndo) {
      // The one-undo limit comes after the state check. It counts this product's undos in the running list and its
      // exact-reverse cards the Record holds as claimed or running (#117 audit m2): the list comes from the
      // sessions port, and a launch that timed out leaves its card claimed and out of the list. A count that can't
      // be read refuses.
      const live = new Set(mine.filter((s) => s.kind === 'undo').map((s) => s.card ?? s.id));
      let cards;
      try { cards = rec.list('card'); } catch (e) { return refuse(`the running undos could not be counted (${e?.message ?? e})`); }
      if (!Array.isArray(cards)) return refuse('the running undos could not be counted');
      for (const c of cards) if (c.doc?.product === product && c.doc?.kind === 'exact_reverse' && UNDO_LIVE.includes(c.doc?.state)) live.add(c.id);
      // This card itself is not another undo: its own claim (the pass claims before it launches) never holds it.
      live.delete(card.id);
      if (live.size) return refuse(`an undo is already running for ${product} (one at a time)`);
    } else if (lim) {
      const onProduct = mine.filter(isEditing);
      if (onProduct.length >= lim.product) return refuse(`the product already runs ${onProduct.length} editing worker(s) (cap ${lim.product})`);
      const onMac = running.filter(isEditing).length;
      if (onMac >= lim.mac) return refuse(`the Mac already runs ${onMac} editing workers (cap ${lim.mac})`);
    }
    const d = disjoint({ rules, card, product, others: mine.filter(writesFiles), rec });
    return capMissing ? { ...d, missing: capMissing } : d;
  } catch (e) {
    // `missing` names the key, so the caller can tell Joe once (audit 0b-6 r3 MAT-3); a refusal alone was silent.
    const missing = e.key ?? `the rules (${e.message})`;
    return { ...refuse(e.unreadable === true ? `the rules' value for ${missing} is unreadable: start nothing` : `the rules have no value for ${missing}: start nothing`), missing };
  }
}

/** The files-don't-overlap check against the product's running editing sessions (M13). */
export function disjoint({ rules, card, product, others, rec }) {
  if (!card) return refuse('an editing session needs its card');
  const dailyPatterns = need(rules, KEYS.leadDailyCard, { product, type: 'list' });
  const empty = (c) => c.kind !== 'daily' && !(c.files?.length) && !(c.rows?.length);
  if (empty(card) && others.length) return refuse('a card with no file list runs alone');
  const mine = fileSet(card, { dailyPatterns });
  if (!mine.ok) return mine;
  for (const s of others) {
    const other = s.card ? rec.read('card', s.card)?.doc : null;
    if (!other) return refuse(`a running worker's card (${s.card ?? '?'}) is not in the record`);
    if (empty(other)) return refuse(`card ${s.card} has no file list and runs alone`);
    const theirs = fileSet({ ...other, files: [...(other.files ?? []), ...(s.bundle_files ?? [])] }, { dailyPatterns });
    if (!theirs.ok) return refuse(`card ${s.card}: ${theirs.reason}`);
    const hit = overlaps(mine, theirs);
    if (hit) return refuse(`shares ${hit} with running card ${s.card}`);
  }
  return { ok: true };
}

/**
 * M4's launch check 12, as a port: the same answer the pass got. M4 launches only reviewers and auditors
 * (review-launch.mjs GATE_KIND), so no undo comes this way and `exactReverse` is never needed here.
 */
export function check12({ rules, rec, bandsNow, runningNow }) {
  return (ctx) => startGate({ rules, rec, card: ctx.card, kind: ctx.kind, product: ctx.product, b: bandsNow(), running: runningNow(), lead: ctx.lead });
}
