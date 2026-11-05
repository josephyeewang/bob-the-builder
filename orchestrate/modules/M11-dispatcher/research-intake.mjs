// research-intake.mjs — a research report from the proposals folder, taken in only while its ask is open, onto one
// go-free research_copy card (R-0b-135; L284, L286).
//
// WHY. The owner runs a research ask ("run research ask R-12") in their own desktop session, which leaves
// `research-R-12.md` in the proposals folder. That report goes into the product's docs/research/ with no go, so the
// one thing that makes it safe is that what merges is exactly the owner's file, at the one path the ask names, and
// nothing else. So no AI writes the copy (L284 d), and this handler never sees the file's text or bytes (L290 M-1): the
// intake hands it the sha256, git blob id and size of the raw bytes, all from its one read of one handle, and the card
// carries them as proof. The merge gate's refusal 10 lets the change touch only the card's
// one path and only with that blob (M6 refusals.mjs researchCopyProblem), and the commit is made mechanically from the
// proposals file, the sha256 checked again first (M4 push.mjs pushResearch, L286). The start loop never hands a
// research_copy card to a worker (pass.mjs starts), so researchCopyPass is what stops one sitting in ready untold (L313).
//
//   researchHandler({ rules }) → the proposals intake's `research` handler:
//     ({ rec, product, id, name, sha256, blob, size, now }) → { ok: true, card } | { ok: false, reason }   (`fenced` is read only to see that it is not blank; `now` is the pass's clock, required; an empty or blank report is refused)
//   researchPass({ rec, now })  (now required) → [[card, what]]   each pass: a research_copy card left in draft is moved to ready, and
//                                                  an ask whose card exists leaves the waiting list (restart-safe)
//   researchCopyPass({ rec, rules, pushResearch, alert, now, host })  (now required) → [[card, what]]   each pass, for each
//                                                  ready card: not yet pushed, it is pushed, at most every RETRY_MS while
//                                                  refused and never while the rules have copies off. A report whose bytes
//                                                  changed is told once, at once. A card a day in ready is told, then daily,
//                                                  until it leaves ready, pushed or not (L313, shared stillWaiting)
//                                                  A pushed card whose head is written goes to review in the same pass
//                                                  (routeCopy, L387), with a launch record, role copy_run. A failed move
//                                                  stays told by that same daily tell. A run that lapsed to waiting is
//                                                  taken back to ready and goes on (L441 M1). The tell's clock starts at
//                                                  the first held pass and survives every move on the way (L441 M2).
//   researchCardDoc({ askId, product, name, sha256, blob, size }) → the one card shape (tests build theirs with it)
//   researchPath(askId) → the card's one allowed path (M2's); the blob id is M10 reader.mjs blobSha's, made by the intake
//
// A refusal goes back to the intake, which records it and tells the owner once (proposals-intake.mjs `refuse`). It is
// refused when: the rules don't turn research copies on (fail closed: only `approvals.plan_go.go_free.research_copy:
// true` does, ready.mjs goFreeOn); the intake did not hand on a sha256, blob id and size of the right shapes; there is no open research ask by that number that is still waiting on the
// owner (M2 researchBrief); the ask is another product's; or the ask already has its card for other bytes. A report
// need not be UTF-8: the copy is of bytes, never of text.

import { move } from './moves.mjs';
import { researchBrief, researchFileName, researchPath, landResearch, RESEARCH_ID } from '../M2-approvals/research-ask.mjs';
import { goFreeOn, GO_FREE_KEY } from '../M9-record/ready.mjs';
import { REPORT_CHANGED } from '../M4-workshop/git/push.mjs';
import { tellThen, dropCause, isQueued } from './alerts.mjs';
import { HOLD_FACT, putFact, writeLaunch } from './pass.mjs';
import { hostname } from 'node:os';
import { stillWaiting, pastTime, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';

export { researchPath };
export const RESEARCH_CARD = (askId) => `research-${askId}`;
/** A copy is Tier 2: the docs lane takes it (like the undo card, M11 undo.mjs UNDO_TIER). */
export const RESEARCH_TIER = 2;
/** The Record needs a card's module; a copy belongs to the product's docs. */
export const RESEARCH_MODULE = 'docs';
/** M10's push_branch denies a card with no lane; a copy lands in docs/, the docs lane's. */
export const RESEARCH_LANE = 'docs';
/** How long a refused copy rests before the next try: each try reads GitHub. */
export const RETRY_MS = 15 * 60_000;
export const RESEARCH_OFF = `research copies are off: the rules don't set ${GO_FREE_KEY}.research_copy to true`;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
// The empty file's sha256 and git blob id: a report with either is empty whatever size it claims (#154 r2 cosmetic 1).
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
// The intake's fenced copy is the text inside one outside-text wrapper (M12 escape.mjs), escaped so it holds no closing tag.
const FENCED = /^<outside-text source="[^"<>]*">([\s\S]*)<\/outside-text>$/;
/** True when a fenced copy holds nothing but blank space; null when it is not a fenced copy at all. */
export function fencedBlank(fenced) {
  const m = FENCED.exec(typeof fenced === 'string' ? fenced : '');
  return m ? m[1].trim() === '' : null;
}

/** The one shape of a research_copy card, written in draft. */
export function researchCardDoc({ askId, product, name, sha256, blob, size }) {
  return { state: 'draft', kind: 'research_copy', research_ask: askId, product, module: RESEARCH_MODULE, lane: RESEARCH_LANE, tier: RESEARCH_TIER,
    files: [researchPath(askId)], source: { file: name, sha256, blob, size }, what: `copy research ask ${askId}'s report to ${researchPath(askId)}` };
}

export function researchHandler({ rules }) {
  return function research({ rec, product, id, name, fenced, sha256, blob, size, now }) {
    // The pass's own clock, handed on by the intake, never this machine's at call time (#154 audit, cosmetic).
    if (!Number.isFinite(now)) return { ok: false, reason: 'the intake did not hand on its clock, so the report was not used' };
    if (!goFreeOn(rules, product, 'research_copy')) return { ok: false, reason: RESEARCH_OFF };
    if (!RESEARCH_ID.test(String(id)) || name !== researchFileName(id)) return { ok: false, reason: 'a research report is named research-R-<number>.md, after its ask' };
    // The proof the copy is checked against: the intake's, from the raw bytes it read (L290 M-1).
    if (!HEX64.test(String(sha256)) || !HEX40.test(String(blob)) || !Number.isSafeInteger(size) || size < 0) return { ok: false, reason: 'the intake did not hand on the report\'s sha256, blob id and size, so its copy could not be checked' };
    // An empty file is not a report, and nor is one of only blank space: refused, so the ask stays open and Joe is told
    // (#154 audit Minor 6; r2 Minor 1 and cosmetic 1). The blank check reads the fenced copy, never the raw text.
    const blank = fencedBlank(fenced);
    if (blank === null) return { ok: false, reason: 'the intake did not hand on the report\'s fenced text, so it could not be checked' };
    if (size === 0 || sha256 === EMPTY_SHA256 || blob === EMPTY_BLOB || blank) return { ok: false, reason: `the research report for ${id} is empty or only blank space, so there is nothing to copy; the ask stays open` };
    const brief = researchBrief(rec, id);
    if (!brief.ok) return { ok: false, reason: brief.reason };
    if (brief.product !== product) return { ok: false, reason: `research ask ${id} is for product ${brief.product}, not this one` };
    const cardId = RESEARCH_CARD(id);
    const have = rec.read('card', cardId);
    if (have) {
      // A pass that wrote the card and stopped before landing it: the same bytes go on; any other bytes are refused.
      if (have.corrupt || have.doc?.source?.sha256 !== sha256 || have.doc?.source?.blob !== blob) return { ok: false, reason: `research ask ${id} already has its research_copy card` };
    } else {
      const w = rec.write({ actor: 'dispatcher', entity: 'card', id: cardId, expectRev: 0, kind: 'research_card',
        doc: researchCardDoc({ askId: id, product, name, sha256, blob, size }) });
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

export function researchPass({ rec, now }) {
  if (!Number.isFinite(now)) throw new Error('researchPass needs the pass\'s clock (now)');
  const out = [];
  for (const c of rec.list('card')) {
    if (c.doc?.kind !== 'research_copy' || typeof c.doc.research_ask !== 'string') continue;
    if (c.doc.state !== 'draft' && !researchBrief(rec, c.doc.research_ask).ok) continue;
    for (const what of settle(rec, c.id, c.doc.research_ask, now)) out.push([c.id, what]);
  }
  return out;
}

// The copy's fact, as the push script names it: one per card and bytes.
function copyDoc(rec, c) {
  const sha = c.doc.source?.sha256;
  const f = typeof sha === 'string' ? rec.read('fact', `push.${c.id}.r-${sha.slice(0, 12)}`) : null;
  return f?.corrupt ? null : f?.doc ?? null;
}
/** The two causes, on holds' own facts (hold_alert): the bytes changed, and a day in ready. */
export const BYTES_FACT = (cardId) => HOLD_FACT(`research-bytes-${cardId}`);
export const READY_FACT = (cardId) => HOLD_FACT(`research-ready-${cardId}`);

/** The copy's run: names the tab claim and the launch record. One per card and bytes, so a retry finds its own. */
export const COPY_RUN = (cardId, sha) => `copy-${cardId}-r-${sha.slice(0, 12)}`;
export const COPY_ROLE = 'copy_run';
const ROUTE_STATES = Object.freeze(['ready', 'claimed', 'running']);
// M9's wait for a lapsed tab claim (writer.mjs lapseClaims). A lapse ends the claim, so this is how the card is known;
// only researchCopyPass makes tab claims, so on a research_copy card it can only be this card's own run.
const LAPSED_RUN = 'tab claim lapsed';
const lapsedRun = (doc) => doc.state === 'waiting' && doc.wait?.what === LAPSED_RUN && doc.wait?.return_to === 'ready';

/**
 * A pushed copy goes to review by the three existing moves (L387), in one pass; a stop between them is picked up next
 * pass from wherever the card is. -> null, or why it stopped. readyCheck runs again at claimed, in the Record.
 */
function routeCopy(rec, c, doc, { host, now }) {
  const run = COPY_RUN(c.id, c.doc.source.sha256);
  const step = (patch, kind) => { const m = move(rec, 'card', c.id, patch, { kind }); return m.ok ? { rev: m.rev } : { why: m.reason }; };
  let state = c.doc.state;
  let rev = c.rev;
  if (state === 'ready') {
    const r = step({ state: 'claimed', claim: { kind: 'tab', claim_id: run, host } }, 'claim');
    if (r.why) return r.why;
    state = 'claimed';
  }
  if (state === 'claimed') {
    const r = step({ state: 'running' }, 'started');
    if (r.why) return r.why;
    state = 'running';
    rev = r.rev;
  }
  if (!rec.read('launch', run)) {
    const l = writeLaunch(rec, { sessionId: run, role: COPY_ROLE, kind: COPY_ROLE, card: c.id, head: doc.tip, rev, product: c.doc.product, now });
    if (!l.ok) return `its launch could not be recorded (${l.reason})`;
  }
  const r = step({ state: 'in_review' }, 'copy_handed_in');
  return r.why ?? null;
}

export async function researchCopyPass({ rec, rules, pushResearch, alert, now, host = hostname() }) {
  if (!Number.isFinite(now)) throw new Error('researchCopyPass needs the pass\'s clock (now)');
  const out = [];
  for (const listed of rec.list('card')) {
    if (listed.corrupt || listed.doc?.kind !== 'research_copy') continue;
    let c = listed;
    let stopped = null;
    if (lapsedRun(c.doc)) {
      const back = move(rec, 'card', c.id, { state: 'ready' }, { kind: 'copy_run_lapsed' });
      if (back.ok) c = rec.read('card', c.id);
      else stopped = `its lapsed run could not be taken back (${back.reason})`;
      out.push([c.id, stopped ?? 'taken back after its run lapsed']);
    }
    const { product, research_ask: ask, state } = c.doc;
    const ready = state === 'ready';
    const ours = c.doc.source?.sha256 && c.doc.claim?.claim_id === COPY_RUN(c.id, c.doc.source.sha256);
    const held = ready || Boolean(stopped) || (ours && ROUTE_STATES.includes(state));
    const on = goFreeOn(rules, product, 'research_copy');
    let doc = held ? copyDoc(rec, c) : null;
    // A refused head write is retried like a refused push: the next try of the same bytes finishes it.
    const redo = doc?.result !== 'pushed' || doc.head_refused;
    const lastTry = doc?.result === 'refused' || doc?.head_refused ? pastTime(doc.at, now) : null;
    if (ready && on && redo && (lastTry === null || now - lastTry >= RETRY_MS)) {
      let r;
      try { r = await pushResearch({ product, card: c.id }); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
      out.push([c.id, r?.ok ? 'pushed' : `not pushed: ${r?.reason ?? 'no answer'}`]);
      doc = copyDoc(rec, c);
      // Told once (L290): the owner has to act, and the daily tell below keeps saying why it is not copied.
      if (r?.ok === false && r.reason === REPORT_CHANGED && rec.read('fact', BYTES_FACT(c.id))?.doc?.told_at == null && !isQueued(rec, BYTES_FACT(c.id))) {
        const text = `${product}: the report for research ask ${ask} changed after it was taken in, so it was not copied. Put the original back, or ask again.`;
        tellThen(alert, text, { fact: BYTES_FACT(c.id), fields: { text, told_at: new Date(now).toISOString() }, kind: 'hold_alert' });
      }
    }
    if (doc?.result === 'pushed' || !ready) dropCause(rec, BYTES_FACT(c.id));
    // Held at the card's head: a push with no head goes nowhere, and the daily tell below says so.
    const fresh = rec.read('card', c.id);
    const headed = doc?.result === 'pushed' && fresh?.doc?.head === doc.tip;
    let waiting = held;
    if (on && held && headed && !stopped) {
      stopped = routeCopy(rec, fresh, doc, { host, now });
      out.push([c.id, stopped ? `not sent to review: ${stopped}` : 'sent to review']);
      waiting = Boolean(stopped);
    }
    const mark = READY_FACT(c.id);
    // The card's own clock restarts at every move, and a failing route moves it every tick, so the wait's start is kept
    // on the fact, from the first held pass (L441 M2). A card has one set of bytes (researchHandler), so this start is
    // theirs. While that write is refused the push's own time stands in, never the card's clock on a pushed card: that
    // clock restarts at every move, and the next pass tries the write again (L528). A card not pushed yet doesn't move.
    const stateSince = rec.meta?.('card', c.id)?.stateSince;
    const seen = rec.read('fact', mark)?.doc;
    if (waiting && seen?.waiting_since === undefined) putFact(rec, mark, { ...seen, waiting_since: stateSince ?? new Date(now).toISOString() }, 'hold_waiting', seen);
    stillWaiting({
      now,
      waiting,
      after: { since: rec.read('fact', mark)?.doc?.waiting_since ?? (doc?.result === 'pushed' ? doc.at : stateSince), limit: STILL_WAITING_MS },
      read: () => rec.read('fact', mark)?.doc,
      tell: (fields) => {
        const pushed = doc?.result === 'pushed' && (stopped ? `it is on branch ${doc.branch} but could not go to review (${stopped})` : headed ? `it is on branch ${doc.branch} but has not merged` : `it is on branch ${doc.branch} but its card could not take the new head (${doc.head_refused ?? 'the card names another head'})`);
        const why = pushed || `it has not been copied (${on ? doc?.reason ?? 'not tried yet' : RESEARCH_OFF})`;
        const text = `${product}: the report for research ask ${ask} has waited over a day: ${why}.`;
        return tellThen(alert, text, { fact: mark, fields: { text, ...fields }, kind: 'hold_alert' });
      },
      clear: () => {
        dropCause(rec, mark);
        const cur = rec.read('fact', mark);
        if (cur?.doc?.told_at != null) putFact(rec, mark, { ...cur.doc, told_at: null }, 'hold_cleared', cur.doc, ['told_at']);
      },
    });
    // Over: the start goes too, so a card that comes back to ready later starts a new wait.
    const done = rec.read('fact', mark)?.doc;
    if (!waiting && done?.waiting_since !== undefined) {
      const { waiting_since: _, ...rest } = done;
      putFact(rec, mark, rest, 'hold_cleared', done);
    }
  }
  return out;
}
