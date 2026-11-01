// go.mjs — the owner's go on a plan, and the merge-time check that a change stays inside it (R-0b-52, R-0b-53; 0b-5 spec
// review round 1 M6/M7, round 2 M2-4/m2-8, round 3 m3-3/m3-4, LEAD-CALLS N20).
//
// WHY. A go counts only for the plan the owner saw: this card, these files, this pass test, this tier (and, for Tier 1,
// this checked plan document and main commit). The fingerprint (shared/plan-fingerprint.mjs) binds all of that; M9
// recomputes it at draft → ready. This file asks for the go, records it once answered, and at merge checks that the
// change didn't step outside it — wider files, a higher tier, or a weaker test in its own row file.
//
//   approveNeeded({ risky, needsJoe, tier, module }, rules, product) → { needed, why: [...] }   the Approve-ask trigger (M6)
//   doneBar(rows) → string           the rows' done_when texts, sorted by row id, joined with "\n---\n" (m2-8)
//   await raiseGo(ctx, { cardId, rows, view, mainSha, planCheck }) → { ok, id } | { ok: false, reason }
//     the title shown is the card's own `what` (L84 2): no caller can put a title the reviewer never saw over a pass
//       Tier 2 → a go_t2 tap ask; Tier 1 → a go_t1 decision pull request (N20). `rows` = { id → row } at go time (m3-4).
//       A Tier-1 go is asked only after a fresh plan reviewer passed the plan with 0 Material (R-0b-138): `planCheck`
//       = { pass: true, material: 0, card, fingerprint, plan_sha256, reviewer_session, author_session }, kept on the ask
//       as plan_check; card and fingerprint must be this card's and its whole plan fingerprint now (audit r1 M-2).
//   goFingerprint(ctx, cardId) → { ok, card, fingerprint, plan_sha256, inputs } | { ok: false, reason }
//       what a plan reviewer names in its pass: the plan it read, as the go would bind it
//   recordGo(ctx, askId) → { ok, go } | { ok: false, reason }           an answered "go" → the go record; the ask consumed
//   await goCheck({ go, card, changed, headRows, tier, view, mainSha }) → { ok, reasons, newGo }   at merge (refusal 10)
//   await tier1Changed(ctx, { cardId, view, mainTip }) → { ok, changed: [paths] }   did a listed file change on main?
//   recordRecheck(ctx, { cardId, mainCommit, planSha256, files }) → { ok, newGo }   unchanged plan → rechecked (m3-3)
// ctx = { record, rules, product, now, alert } (+ gh, owner, repo for a Tier-1 go's decision pull request)

import { canonicalJson, planFingerprint } from '../../shared/plan-fingerprint.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { createAsk } from './binding.mjs';
import { planCheckProblem } from '../../shared/plan-review.mjs';

// What a change may edit in its own row file without a new go (M2-4): status only. Every other field is the plan.
export const ROW_STATUS_FIELDS = Object.freeze(['status', 'done', 'receipts', 'progress', 'date', 'done_at']);
export const ROW_FILE = /^docs\/blueprint\/rows\/([^/]+)\.yaml$/i;   // the same pattern M10's lane rule uses
export const rowFile = (id) => `docs/blueprint/rows/${id}.yaml`;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const iso = (ms) => new Date(ms).toISOString();
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const goId = (card) => `go-${card}`;

export function approveNeeded({ risky = [], needsJoe = false, tier, module } = {}, rules, product) {
  const why = [];
  if (!Array.isArray(risky)) return { needed: true, why: ['the risky list is unreadable'] };
  if (risky.length) why.push(`risky: ${risky.join(', ')}`);
  if (needsJoe === true) why.push('the card needs the owner');
  if (tier !== 1 && tier !== 2) why.push('the tier is unknown');
  if (tier === 1) {
    const proven = typeof module === 'string' && module ? rules?.get?.(`live_check.${module}.proven_at`, { product }) : undefined;
    if (typeof proven !== 'string' || !proven) why.push(`Tier 1 on ${module || 'an unknown module'}, whose live check isn't proven`);
  }
  return { needed: why.length > 0, why };
}

export function doneBar(rows) {
  const ids = Object.keys(rows ?? {}).sort();
  return ids.map((id) => rows[id]?.done_when).join('\n---\n');
}

function checkRows(rows, card) {
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return 'the rows the card names are missing';
  const ids = Object.keys(rows);
  if (!ids.length) return 'a go names at least one row';
  for (const id of ids) {
    const r = rows[id];
    if (!ROW_ID.test(id)) return `row id ${JSON.stringify(id.slice(0, 40))} is not plain`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `row ${id} is not a row`;
    if (r.id !== undefined && r.id !== id) return `row ${id} names itself ${r.id}`;
    if (typeof r.done_when !== 'string' || !r.done_when.trim()) return `row ${id} has no done_when`;
  }
  if (Array.isArray(card.rows) && canonicalJson([...card.rows].sort()) !== canonicalJson([...ids].sort())) return 'the rows given are not the rows the card names';
  if (card.done_when !== doneBar(rows)) return 'the card\'s done_when is not its rows\' pass tests';
  return null;
}

function fingerprintOf(product, cardId, d) {
  return planFingerprint({ product, card_id: cardId, tier: d.tier, files: d.files, done_when: d.done_when, plan_sha256: d.plan_sha256, main_commit: d.main_commit });
}

// No entry in a go's file list may be a folder (M7): a pattern or unsafe path is refused by the fingerprint itself; a
// plain name that is a folder in main's tree is refused here. Any error reading the tree refuses too.
async function folderIn(view, sha, files) {
  if (!view || !SHA.test(sha ?? '')) return 'no main commit to check the file list against';
  try {
    for (const f of files) if (await view.isDir(sha, f)) return `${f} is a folder; a go names files`;
  } catch (e) {
    return `could not check the file list: ${String(e?.message ?? e).slice(0, 200)}`;
  }
  return null;
}

const MAX_GO_REASKS = 20;
// Closed: withdrawn, expired, answered with anything but go, or used for a go the card has since replaced (a plan
// A → B → A asks again for A; audit round 2 MAT-1).
const closedGoAsk = (st, cardId, a) => ['withdrawn', 'expired'].includes(a.doc.state)
  || (a.doc.state === 'answered' && a.doc.answer?.approves !== true)
  || (a.doc.state === 'consumed' && st.go(`go-${cardId}`)?.doc.ask !== a.id);

export function goFingerprint(ctx, cardId) {
  const c = ctx.record.read('card', cardId);
  if (!c || c.corrupt || !c.doc) return fail(`no card ${cardId}`);
  if (c.doc.product !== ctx.product) return fail(`card ${cardId} belongs to product ${c.doc.product}`);
  const fp = fingerprintOf(ctx.product, cardId, c.doc);
  if (!fp.ok) return fail(`the plan can't be fingerprinted: ${fp.reason}`);
  return { ok: true, card: cardId, fingerprint: fp.sha256, plan_sha256: fp.inputs.plan_sha256, inputs: fp.inputs };
}

export async function raiseGo(ctx, { cardId, rows, view, mainSha, planCheck } = {}) {
  const c = ctx.record.read('card', cardId);
  if (!c || c.corrupt || !c.doc) return fail(`no card ${cardId}`);
  const d = c.doc;
  if (d.product !== ctx.product) return fail(`card ${cardId} belongs to product ${d.product}`);
  // A fix card runs on its root's go (M9: its plan is the root's, unchanged), so it is never asked for one.
  if (d.kind === 'fix') return fail('a fix card runs on its root card\'s go');
  const bad = checkRows(rows, d);
  if (bad) return fail(bad);
  const fp = fingerprintOf(ctx.product, cardId, d);
  if (!fp.ok) return fail(`the plan can't be fingerprinted: ${fp.reason}`);
  if (d.tier === 1) { const no = planCheckProblem(planCheck, { fingerprint: fp.sha256, card: cardId, planSha256: fp.inputs.plan_sha256 }); if (no) return fail(no); }
  // Tier 1 checks folders at the plan's main commit; Tier 2 at main as it is now.
  const folder = await folderIn(view, d.tier === 1 ? d.main_commit : mainSha, fp.inputs.files);
  if (folder) return fail(folder);
  // One live ask per plan. A plan the owner said "not now" to, or whose ask was withdrawn or ran out, is asked again
  // under a new id when the Lead raises it again (audit round 1 M-3); otherwise the card would hang on a closed ask.
  const base = `go-${cardId}-${fp.sha256.slice(0, 12)}`;
  const st = askStore(ctx.record);
  let id = base;
  for (let n = 2; ; n++) {
    const prev = st.ask(id);
    if (!prev) break;
    if (!closedGoAsk(st, cardId, prev)) return { ok: true, id, existing: true };
    if (n > MAX_GO_REASKS) return fail(`plan ${base} has been asked ${MAX_GO_REASKS} times`);
    id = `${base}-${n}`;
  }
  const kind = d.tier === 1 ? 'go_t1' : 'go_t2';
  const r = createAsk(ctx, { id, kind, card: cardId, title: typeof d.what === 'string' ? d.what : cardId, tier: d.tier,
    fingerprint: fp.sha256, files: fp.inputs.files, extra: { fingerprint_inputs: fp.inputs, rows: structuredClone(rows), ...(d.tier === 1 ? { plan_check: structuredClone(planCheck) } : {}) } });
  // A Tier-1 go's decision pull request goes out in the next push window (schedule.mjs); its file holds the plan.
  return r.ok ? { ok: true, id } : r;
}

export function recordGo(ctx, askId) {
  const st = askStore(ctx.record);
  const a = st.ask(askId);
  if (!a) return fail(`no trusted ask ${askId}`);
  const k = activeKind(a.doc.kind);
  if (!k?.go) return fail(`a ${a.doc.kind} ask is not a go`);
  const doc = a.doc;
  const id = goId(doc.card);
  const existing = st.go(id);
  if (doc.state === 'consumed') {
    return existing?.doc.ask === askId && existing.doc.plan_fingerprint === doc.fingerprint ? { ok: true, go: id, already: true } : fail(`ask ${askId} was used already`);
  }
  if (doc.state !== 'answered' || doc.answer?.approves !== true || doc.answer?.choice !== k.choices[0]) return fail(`ask ${askId} holds no go`);
  // The plan must still be the one the owner saw (a go on A never satisfies B; a changed plan needs a new go).
  const c = ctx.record.read('card', doc.card);
  if (!c || c.corrupt || !c.doc) return fail(`no card ${doc.card}`);
  const fp = fingerprintOf(ctx.product, doc.card, c.doc);
  if (!fp.ok || fp.sha256 !== doc.fingerprint) return fail('the card\'s plan changed since the go was asked; it needs a new go');
  if (ctx.record.read('go', id) && !existing) return fail(`go ${id} was written by someone other than approvals`);
  if (!(existing?.doc.ask === askId && existing.doc.plan_fingerprint === fp.sha256)) {
    const binding = doc.answer.binding ?? { kind: 'tap', session_id: doc.answer.session_id, tool_use_id: doc.answer.tool_use_id, at: doc.answer.at };
    const goDoc = { product: ctx.product, card_id: doc.card, plan_fingerprint: fp.sha256, fingerprint_inputs: fp.inputs, ask: askId, binding,
      rows: structuredClone(doc.rows), tier: fp.inputs.tier, files: fp.inputs.files, done_bar: fp.inputs.done_bar, main_commit: fp.inputs.main_commit,
      rechecked: [], at: iso(ctx.now()) };
    const w = writeDoc(ctx.record, 'go', existing ?? { id, rev: 0 }, goDoc);
    if (!w.ok) return fail(`the record refused the go: ${w.reason}`);
  }
  const w = writeDoc(ctx.record, 'ask', a, { ...doc, state: 'consumed' });
  if (!w.ok) return fail(`the go is recorded, but the ask could not be closed: ${w.reason}`);
  return { ok: true, go: id };
}

// The card's root: a fix card's go is its root's (M9 R2-M5).
function rootId(record, cardId) {
  let c = record.read('card', cardId);
  for (let i = 0; i < 64 && c?.doc && typeof c.doc.fix_of === 'string'; i++) c = record.read('card', c.doc.fix_of);
  return c?.doc && typeof c.doc.fix_of !== 'string' ? c.id : null;
}

function planFieldsDiffer(goRow, headRow) {
  const keys = new Set([...Object.keys(goRow), ...Object.keys(headRow)]);
  return [...keys].filter((k) => !ROW_STATUS_FIELDS.includes(k) && canonicalJson(goRow[k] ?? null) !== canonicalJson(headRow[k] ?? null)).sort();
}

// At merge (M6 refusal 10 calls this). `changed` = the change's files [{ path, previous_path?, status }]; `headRows` =
// { id → row | null } parsed at the change's head for every row the go names and every row file the change touches;
// `tier` = M10's computed tier for the change. Every reason refuses; `newGo` says the card goes back for a new go.
export async function goCheck({ go, card, changed, headRows, tier, view, mainSha } = {}) {
  const reasons = [];
  try {
    if (!go || typeof go !== 'object' || !card?.doc) return { ok: false, reasons: ['no go record or card'], newGo: true };
    const d = card.doc;
    const root = card.root ?? card.id;
    if (go.card_id !== root) reasons.push(`the go is for ${go.card_id}, not ${root}`);
    const fp = fingerprintOf(d.product, root, d);
    if (!fp.ok) reasons.push(`the plan can't be fingerprinted: ${fp.reason}`);
    else if (fp.sha256 !== go.plan_fingerprint) reasons.push('the card\'s plan is not the one the go was given for');
    const goRows = go.rows && typeof go.rows === 'object' ? go.rows : {};
    const rowsHead = headRows && typeof headRows === 'object' ? headRows : {};
    for (const id of Object.keys(goRows).sort()) {
      const h = rowsHead[id];
      if (!h || typeof h !== 'object') { reasons.push(`row ${id} is missing at the change's head`); continue; }
      const diff = planFieldsDiffer(goRows[id], h);
      if (diff.length) reasons.push(`row ${id} changed ${diff.join(', ')}; only ${ROW_STATUS_FIELDS.join(', ')} may change without a new go`);
    }
    if (!Array.isArray(changed) || !changed.length) reasons.push('no file list for the change');
    const allowed = new Set(go.files ?? []);
    for (const f of Array.isArray(changed) ? changed : []) {
      for (const p of [f?.path, ...(f?.previous_path !== undefined ? [f.previous_path] : [])]) {
        if (typeof p !== 'string' || !p) { reasons.push('a file in the change has no path'); continue; }
        const row = ROW_FILE.exec(p);
        if (row) {
          if (!Object.hasOwn(goRows, row[1]) || p !== rowFile(row[1])) reasons.push(`${p} is a row the go doesn't name`);
          else if (f.status !== 'added' && f.status !== 'modified') reasons.push(`${p} may only be added or edited`);
          continue;
        }
        if (!allowed.has(p)) reasons.push(`${p} is outside the go's file list`);
      }
    }
    if (tier !== 1 && tier !== 2) reasons.push('the change\'s tier is unknown');
    else if (tier === 1 && go.tier !== 1) reasons.push('the change is Tier 1; the go was for Tier 2');
    const folder = await folderIn(view, mainSha, go.files ?? []);
    if (folder) reasons.push(folder);
  } catch (e) {
    reasons.push(`the go check failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  return { ok: reasons.length === 0, reasons, newGo: reasons.length > 0 };
}

function trustedGo(ctx, cardId) {
  const root = rootId(ctx.record, cardId);
  if (!root) return fail(`no card ${cardId}`);
  const g = askStore(ctx.record).go(goId(root));
  return g ? { ok: true, g } : fail(`no trusted go for ${root}`);
}

// Tier 1 only: the go's files that changed on main since the go (or its newest re-check). Any change → the Lead
// re-checks the plan before the build (R-0b-53).
export async function tier1Changed(ctx, { cardId, view, mainTip } = {}) {
  const t = trustedGo(ctx, cardId); if (!t.ok) return t;
  const go = t.g.doc;
  if (go.tier !== 1) return fail('only a Tier-1 go is re-checked');
  const from = (go.rechecked ?? []).at(-1)?.main_commit ?? go.main_commit;
  if (!SHA.test(from ?? '') || !SHA.test(mainTip ?? '')) return fail('no commits to compare');
  try {
    if (from === mainTip) return { ok: true, changed: [] };
    const files = await view.files(from, mainTip);
    const listed = new Set(go.files);
    const hit = new Set();
    for (const f of files) for (const p of [f.path, f.previous_path]) if (listed.has(p)) hit.add(p);
    return { ok: true, changed: [...hit].sort() };
  } catch (e) {
    return fail(`could not compare main: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// After the Lead's re-check: the same plan (plan_sha256 and file list) is noted beside the go and needs no new go; a
// changed plan needs a new go (a new fingerprint, so a new decision pull request).
export function recordRecheck(ctx, { cardId, mainCommit, planSha256, files } = {}) {
  const t = trustedGo(ctx, cardId); if (!t.ok) return t;
  const go = t.g.doc;
  if (go.tier !== 1) return fail('only a Tier-1 go is re-checked');
  if (!SHA.test(mainCommit ?? '')) return fail('the re-check names no main commit');
  const same = planSha256 === go.fingerprint_inputs?.plan_sha256 && Array.isArray(files)
    && canonicalJson([...new Set(files)].sort()) === canonicalJson(go.files);
  if (!same) return { ok: true, newGo: true };
  const w = writeDoc(ctx.record, 'go', t.g, { ...go, rechecked: [...(go.rechecked ?? []), { main_commit: mainCommit, at: iso(ctx.now()) }] });
  return w.ok ? { ok: true, newGo: false } : fail(`the record refused the re-check: ${w.reason}`);
}
