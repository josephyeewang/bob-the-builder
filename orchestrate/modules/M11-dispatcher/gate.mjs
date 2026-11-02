// The start gate (R-0b-61, R-0b-67; design v4 §6.2, G4, §14.1.3 check 12; review 0b-6 M13, M14, M20, m11).
// One function decides whether a session may start: the usage band, the caps, and the files-don't-
// overlap check. The pass calls it, and so does M4's launch check 12 (`check12`), so there is one
// answer (m11). It reads; it never writes.
//
// Sessions it counts are the running ones the pass hands in: { id, product, kind, card, lead, files,
// bundle_files }. kind is editing | script | readonly | review | audit | lead | front_door.

import { posix } from 'node:path';
import { KEYS, need } from './keys.mjs';
import { wholeNumber } from '../../shared/rules.mjs';
import { mayStart } from './usage.mjs';

const refuse = (reason) => ({ ok: false, reason });
const ROW_FILE = /^docs\/blueprint\/rows\/([^/]+)\.yaml$/;

/** A repo path, normalised and case-folded (macOS names ignore case). Null for a path outside the repo. */
export function normPath(p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return null;
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n === '..' || n.startsWith('../') || n === '.' || n.endsWith('/')) return null;
  return n.toLowerCase();
}

/** `**` matches any depth, `*` one name. Patterns are case-folded like paths. */
export function matches(pattern, path) {
  const p = String(pattern).toLowerCase();
  const re = new RegExp(`^${p.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  return re.test(path);
}

/** A card's own file set, or a refusal. The daily card also carries its patterns. */
export function fileSet(card, { dailyPatterns }) {
  const out = new Set();
  const named = new Set((card.rows ?? []).map((r) => String(r).toLowerCase()));
  for (const f of card.files ?? []) {
    const n = normPath(f);
    if (!n) return refuse(`the card names a path outside the repo (${f})`);
    const row = ROW_FILE.exec(n);
    if (row && !named.has(row[1])) return refuse(`the card touches row ${row[1]} without naming it`);
    out.add(n);
  }
  for (const id of named) out.add(`docs/blueprint/rows/${id}.yaml`);
  return { ok: true, files: out, patterns: card.kind === 'daily' ? dailyPatterns : [] };
}

function overlaps(a, b) {
  for (const f of a.files) if (b.files.has(f)) return f;
  for (const p of a.patterns) for (const f of b.files) if (matches(p, f)) return f;
  for (const p of b.patterns) for (const f of a.files) if (matches(p, f)) return f;
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
// An exact-reverse undo's own limit, in place of the editing caps (L199): one at a time per product.
export const UNDOS_PER_PRODUCT = 1;
// The research lane's copy card (L204-c, R-0b-135): its own limit, in place of the editing caps, and the one folder it
// may touch. It starts as an editing session; its card's kind is what marks it.
export const COPIES_PER_PRODUCT = 1;
export const RESEARCH_DIR = 'docs/research/';
const isCopy = (card) => card?.kind === 'research_copy';

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
  const stateCap = Object.hasOwn(perState, state) ? wholeNumber(perState[state]) : undefined;
  if (stateCap === undefined) throw Object.assign(new Error(`no per-state cap for ${state}`), { key: KEYS.perState });
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
    // An undo that is an exact reverse is a safety act, never held by the editing caps (L199, L31): the first
    // cutover's rules set caps.editing_per_product to 0. Its own limit is one undo running per product. A running
    // undo still counts toward the caps for every other editing start (isEditing). A missing cap value is still
    // named for it (L40), so Joe is told. The files-don't-overlap check below is safety and still runs.
    const exactUndo = kind === 'undo' && exactReverse === true;
    // The research lane's copy card is never held by the editing caps either (L204-c, the L199 pattern): the first
    // cutover's whole point is the research and docs lane, at caps.editing_per_product 0. It may touch only
    // docs/research/ (R-0b-135), and one runs at a time per product. A running copy still counts toward the caps for
    // every other editing start (it is an editing session). A missing cap value is named for it, as for an undo.
    const copy = kind === 'editing' && isCopy(card);
    if (copy) {
      const files = card.files ?? [];
      const outside = files.find((f) => !normPath(f)?.startsWith(RESEARCH_DIR));
      if (!files.length || outside !== undefined) return refuse(`a research copy card may touch only ${RESEARCH_DIR} (${outside ?? 'it names no file'})`);
    }
    let lim = null;
    let capMissing = null;
    try { lim = editingLimits({ rules, product, productDoc, amberCaps: band.amberCaps }); } catch (e) { if (!((exactUndo || copy) && e.key)) throw e; capMissing = e.key; }
    if (exactUndo) {
      const undos = mine.filter((s) => s.kind === 'undo').length;
      if (undos >= UNDOS_PER_PRODUCT) return refuse(`the product already runs ${undos} undo(s) (one at a time)`);
    } else if (copy) {
      // A running copy is an editing session whose card is a research_copy. An editing session whose card the record
      // can't give makes the count unknown, and an unknown count holds the start, never lets it through.
      const cards = mine.filter((s) => s.kind === 'editing').map((s) => [s, s.card ? rec.read('card', s.card)?.doc : null]);
      const unknown = cards.find(([, doc]) => !doc);
      if (unknown) return refuse(`a running worker's card (${unknown[0].card ?? '?'}) is not in the record, so the research copies running can't be counted`);
      const copies = cards.filter(([, doc]) => isCopy(doc)).length;
      if (copies >= COPIES_PER_PRODUCT) return refuse(`the product already runs ${copies} research copy session(s) (one at a time)`);
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
    return { ...refuse(`the rules have no value for ${missing}: start nothing`), missing };
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
