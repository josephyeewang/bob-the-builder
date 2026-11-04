// plan-cards.mjs — a Lead's plan file as card writes (R-0b-170, L450, L460), read by the Record's outbox rule (writer.mjs);
// the writes are checked first and committed as one diary line, all of them or none.
//
//   planCards({ text, sha256, mainCommit, product, read, cards }) →
//     { ok: true, writes: [{ id, expectRev, doc }], created, updated, dropped } | { ok: false, reason }
//   `read(id)` is the card as the Record holds it, `cards` every card.
//
// M11's intake runs the plan check (M3 checkPlan) on the same bytes before the Record takes the file. What is here is
// only what these writes need. plan_sha256 and main_commit are never read from the plan: `sha256` is the file's own
// and `mainCommit` the Lead's launch record's, so anything typed under those names is ignored. A plan's wave is the
// plan check's and the reviewer's; a card carries its order as depends_on.

import { OPEN_CARD_STATES } from '../../shared/record.mjs';
import { CARD_MODULE, TIERS } from '../../shared/record-names.mjs';
import { same } from './guard.mjs';

const bad = (reason) => ({ ok: false, reason });

/** Why a Lead can't change the plan of a card whose go moved it to ready (L473). Both ways in, plan- and roadmap-, say this. */
export const hasItsGo = (card) => card.doc.state === 'ready' && card.doc.kind === 'ordinary';
export const PLAN_FROZEN = (id) => `card ${id} already has the owner's go and is ready to start, so its plan can't change`;

/** The fields a later plan may change on a draft card. */
const planFields = (c, sha256, mainCommit) => ({ tier: c.tier, files: c.brief?.files, done_when: c.brief?.done_when, plan_sha256: sha256, main_commit: mainCommit, brief: c.brief });

export function planCards({ text, sha256, mainCommit, product, read, cards }) {
  let plan;
  try { plan = JSON.parse(text); } catch { return bad('the plan is not JSON'); }
  if (!Array.isArray(plan?.cards) || !plan.cards.length) return bad('the plan has no cards');
  const writes = [];
  const created = [];
  const updated = [];
  for (const c of plan.cards) {
    if (typeof c?.id !== 'string' || !TIERS.includes(c.tier) || !CARD_MODULE.test(String(c.module ?? ''))) return bad(`card ${String(c?.id).slice(0, 80)} needs an id, a tier and a module`);
    const cur = read(c.id);
    if (cur?.tampered) return bad(cur.reason);
    const fields = planFields(c, sha256, mainCommit);
    if (!cur) {
      writes.push({ id: c.id, expectRev: 0, doc: { state: 'draft', product, module: c.module, kind: 'ordinary', depends_on: c.depends_on ?? [], what: c.brief?.goal, ...fields } });
      created.push(c.id);
      continue;
    }
    // One plain reason for each case, so the Lead reads why the whole plan was turned down.
    if (cur.doc.kind !== 'ordinary') return bad(`card ${c.id} is a ${cur.doc.kind} card, so no plan may change it; nothing in this plan was applied`);
    if (hasItsGo(cur)) return bad(`${PLAN_FROZEN(c.id)}; nothing in this plan was applied`);
    if (cur.doc.state !== 'draft') return bad(`card ${c.id} is ${cur.doc.state}, so no plan may change it; nothing in this plan was applied`);
    if (cur.doc.module !== c.module) return bad(`card ${c.id} is in module ${cur.doc.module}, and that can't change; nothing in this plan was applied`);
    if (!same(cur.doc.depends_on ?? [], c.depends_on ?? [])) return bad(`card ${c.id}'s depends_on can't change once it exists; nothing in this plan was applied`);
    const doc = { ...cur.doc, ...fields };
    if (same(doc, cur.doc)) continue;
    writes.push({ id: c.id, expectRev: cur.rev, doc });
    updated.push(c.id);
  }
  const ids = new Set(plan.cards.map((c) => c.id));
  const dropped = cards.filter((c) => c.doc?.kind === 'ordinary' && typeof c.doc.plan_sha256 === 'string' && OPEN_CARD_STATES.includes(c.doc.state) && !ids.has(c.id)).map((c) => c.id);
  return { ok: true, writes, created, updated, dropped };
}
