// research-intake.mjs — a research report from the proposals folder, taken in only while its ask is open, onto one
// go-free research_copy card (R-0b-135; L284, L286).
//
// WHY. The owner runs a research ask ("run research ask R-12") in their own desktop session, which leaves
// `research-R-12.md` in the proposals folder. That report goes into the product's docs/research/ with no go, so the
// one thing that makes it safe is that what merges is exactly the owner's file, at the one path the ask names, and
// nothing else. So no AI writes the copy (L284 d): the card carries the file's bytes as proof (sha256 and git blob
// id, both from the very bytes the intake hashed), the merge gate's refusal 10 lets the change touch only the card's
// one path and only with that blob (M6 refusals.mjs researchCopyProblem), and the commit is made mechanically from the
// proposals file, the sha256 checked again first (lane 2's push.mjs copier, L286; not built yet). The start loop never
// hands a research_copy card to a worker (pass.mjs starts).
//
//   researchHandler({ rules }) → the proposals intake's `research` handler:
//     ({ rec, product, id, name, text, sha256, now }) → { ok: true, card } | { ok: false, reason }
//   researchPass({ rec, now }) → [[card, what]]   each pass: a research_copy card left in draft is moved to ready, and
//                                                  an ask whose card exists leaves the waiting list (restart-safe)
//   researchCardDoc({ askId, product, name, sha256, blob, size }) → the one card shape (tests build theirs with it)
//   researchPath(askId) → the card's one allowed path (M2's); the blob id is M10 reader.mjs blobSha's
//
// A refusal goes back to the intake, which records it and tells the owner once (proposals-intake.mjs `refuse`). It is
// refused when: the rules don't turn research copies on (fail closed: only `approvals.plan_go.go_free.research_copy:
// true` does, ready.mjs goFreeOn); the file is not plain UTF-8 (the text the intake read must hash back to its bytes,
// or the copy would not be those bytes); there is no open research ask by that number that is still waiting on the
// owner (M2 researchBrief); the ask is another product's; or the ask already has its card for other bytes.

import { createHash } from 'node:crypto';
import { move } from './moves.mjs';
import { researchBrief, researchFileName, researchPath, landResearch, RESEARCH_ID } from '../M2-approvals/research-ask.mjs';
import { goFreeOn, GO_FREE_KEY } from '../M9-record/ready.mjs';
// Git's blob id for a file's bytes; GitHub's compare lists the same id per file as `sha` (M6 gather `blob`).
import { blobSha } from '../M10-rules/reader.mjs';

export { researchPath };
export const RESEARCH_CARD = (askId) => `research-${askId}`;
/** A copy is Tier 2: the docs lane takes it (like the undo card, M11 undo.mjs UNDO_TIER). */
export const RESEARCH_TIER = 2;
/** The Record needs a card's module; a copy belongs to the product's docs. */
export const RESEARCH_MODULE = 'docs';
export const RESEARCH_OFF = `research copies are off: the rules don't set ${GO_FREE_KEY}.research_copy to true`;

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The one shape of a research_copy card, written in draft. */
export function researchCardDoc({ askId, product, name, sha256, blob, size }) {
  return { state: 'draft', kind: 'research_copy', research_ask: askId, product, module: RESEARCH_MODULE, tier: RESEARCH_TIER,
    files: [researchPath(askId)], source: { file: name, sha256, blob, size }, what: `copy research ask ${askId}'s report to ${researchPath(askId)}` };
}

export function researchHandler({ rules }) {
  return function research({ rec, product, id, name, text, sha256, now = Date.now() }) {
    if (!goFreeOn(rules, product, 'research_copy')) return { ok: false, reason: RESEARCH_OFF };
    if (!RESEARCH_ID.test(String(id)) || name !== researchFileName(id)) return { ok: false, reason: 'a research report is named research-R-<number>.md, after its ask' };
    // The copy must be the bytes the intake hashed: text that doesn't hash back to them was not plain UTF-8.
    const bytes = Buffer.from(String(text ?? ''), 'utf8');
    if (typeof text !== 'string' || sha256Of(bytes) !== sha256) return { ok: false, reason: 'the report is not plain UTF-8 text, so it can\'t be copied byte for byte' };
    const brief = researchBrief(rec, id);
    if (!brief.ok) return { ok: false, reason: brief.reason };
    if (brief.product !== product) return { ok: false, reason: `research ask ${id} is for product ${brief.product}, not this one` };
    const cardId = RESEARCH_CARD(id);
    const have = rec.read('card', cardId);
    if (have) {
      // A pass that wrote the card and stopped before landing it: the same bytes go on; any other bytes are refused.
      if (have.corrupt || have.doc?.source?.sha256 !== sha256) return { ok: false, reason: `research ask ${id} already has its research_copy card` };
    } else {
      const w = rec.write({ actor: 'dispatcher', entity: 'card', id: cardId, expectRev: 0, kind: 'research_card',
        doc: researchCardDoc({ askId: id, product, name, sha256, blob: blobSha(bytes), size: bytes.length }) });
      if (!w.ok) return { ok: false, reason: `the research_copy card could not be recorded: ${w.reason}` };
    }
    // Ready and landed now if it can be; researchPass tries again on later passes, so the file still counts as used.
    settle(rec, cardId, id, now);
    return { ok: true, card: cardId };
  };
}

function settle(rec, cardId, askId, now) {
  const out = [];
  const c = rec.read('card', cardId);
  if (c?.doc?.state === 'draft') {
    const r = move(rec, 'card', cardId, { state: 'ready' }, { kind: 'research_ready' });
    out.push(r.ok ? 'ready' : `not ready: ${r.reason}`);
  }
  const l = landResearch({ record: rec, now: () => now }, askId);
  if (l.ok && !l.already) out.push('landed');
  else if (!l.ok) out.push(`not landed: ${l.reason}`);
  return out;
}

export function researchPass({ rec, now = Date.now() }) {
  const out = [];
  for (const c of rec.list('card')) {
    if (c.doc?.kind !== 'research_copy' || typeof c.doc.research_ask !== 'string') continue;
    if (c.doc.state !== 'draft' && !researchBrief(rec, c.doc.research_ask).ok) continue;
    for (const what of settle(rec, c.id, c.doc.research_ask, now)) out.push([c.id, what]);
  }
  return out;
}
