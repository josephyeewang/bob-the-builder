// schedule.mjs — when the owner is asked, re-asked, and when an ask or an approval runs out (R-0b-51, R-0b-53; 0b-5 spec
// review round 1 M5/M8/m2, round 2 m2-11, round 3 m3-1/m3-6, LEAD-CALLS L12).
//
// WHY. The owner is interrupted twice a day, not all day: an ask goes out only in a push window (08:00, 17:00 in the
// owner's zone, or the trip zone while away). Urgent kinds (undo, incident repair) go out at once and every 2 hours
// until answered. Nothing waits forever: a lapsing ask unanswered 12 hours after it was raised is re-asked once, in the
// next window, then expires. A merge approval not used within 24 hours of being raised goes back the same way. All
// clocks run from raised_at (GitHub's time for a review request; the first push or bound box for a tap), so a pass
// that runs late — the Mini was down — lapses an ask exactly as an on-time pass would, and an answer given after the
// lapse counts nothing (decision.mjs, readApprove below).
//
//   await schedulePass(ctx) → { ok, events } | { ok: false, reason, events }    one pass; the dispatcher runs it often
//   await readApprove(ctx, askId, { view, catchUps }) → { ok, counted, head? }  a risky_approve ask's GitHub Approve
//   await approvalStands(ctx, askId, { head, view, catchUps }) → { ok } | { ok: false, reason }   may this head merge on it now?
// ctx = { record, rules, product, now, alert, gh, owner, repo, stateDir, push }
//   push(event) → true when the owner's phone was sent `event` ({ ask, card, kind, urgent, line? }); anything else is
//   "not sent", and the ask is tried again next pass.
//
// HELD DECISIONS (R-0b-53, round 1 M8). A decision ask that carries `modules` (the modules of the decided.yaml entries
// its change touches) is not raised while any open card is on one of those modules. A card with no module is open on
// every module; a decision whose modules are unknown (empty, or not plain names) is held. Open = any state except
// merged, closed, cancelled, closed_no_answer and reverted; never the decision's own card.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeKind } from '../../shared/asks.mjs';
import { answerCounts } from '../../shared/approval.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { releaseBoxes, releaseSessions } from './binding.mjs';
import { openDecision } from './decision.mjs';
import { countApprove, requestReview } from './github-review.mjs';
import { MERGE_APPROVE_MS, UNDO_OPEN_QUESTION_LINE, URGENT_REPUSH_MS, dueWindow, lapseAt, readConfig, zoneFor } from './kinds.mjs';

export const HELD_CLOSED_STATES = Object.freeze(['merged', 'closed', 'cancelled', 'closed_no_answer', 'reverted']);
const MAX_WINDOW_MARKS = 20;
const MODULE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// The config alert goes out once per distinct problem, not every pass (round 2 m2-6).
function configAlert(ctx, reason) {
  const file = join(ctx.stateDir, 'config-alert.json');
  if (reason === null) { rmSync(file, { force: true }); return; }
  let last = null;
  try { last = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).reason : null; } catch { last = null; }
  if (last === reason) return;
  ctx.alert({ type: 'approvals_config', reason });
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ reason })}\n`);
}

export function heldBy(record, doc) {
  if (doc.kind !== 'decision' || !Object.hasOwn(doc, 'modules')) return null;
  const mods = doc.modules;
  if (!Array.isArray(mods) || !mods.length || !mods.every((m) => typeof m === 'string' && MODULE.test(m))) return 'its modules are unknown';
  for (const c of record.list('card')) {
    if (c.id === doc.card) continue;
    const state = c.corrupt ? null : c.doc?.state;
    if (HELD_CLOSED_STATES.includes(state)) continue;
    const m = c.corrupt ? undefined : c.doc?.module;
    if (typeof m !== 'string' || !m || mods.includes(m)) return `card ${c.id} is open on ${typeof m === 'string' && m ? m : 'every module'}`;
  }
  return null;
}

const liveBox = (doc) => (doc.boxes ?? []).some((b) => b.status === 'bound');
const raisedThisRound = (doc) => ms(doc.raised_at) !== null && doc.raised_reask === doc.reask_count;

function write(ctx, cur, doc, events, event) {
  const w = writeDoc(ctx.record, 'ask', cur, doc);
  if (!w.ok) { ctx.alert({ type: 'approvals_write_refused', ask: cur.id, reason: w.reason }); return false; }
  if (event) events.push(event);
  return true;
}

async function closeDecisionPr(ctx, id, doc) {
  if (!activeKind(doc.kind)?.decision_pr || !Number.isSafeInteger(doc.pr)) return;
  const c = await ctx.gh.patch(`/repos/${ctx.owner}/${ctx.repo}/pulls/${doc.pr}`, { state: 'closed' }).catch((e) => ({ status: String(e?.message ?? e) }));
  if (c?.status !== 200) ctx.alert({ type: 'decision_pr_not_closed', ask: id, pr: doc.pr, reason: String(c?.status) });
}

// An unanswered lapsing ask 12 hours after it was raised this round, or an unused merge approval 24 hours after:
// the first time it goes back to open to be re-asked once (reask_count 1); the second time it expires.
async function runOut(ctx, a, nowMs, events) {
  const doc = a.doc;
  const k = activeKind(doc.kind);
  const unanswered = k.lapse && (doc.state === 'open' || doc.state === 'pushed') && nowMs >= lapseAt(doc);
  const unused = k.merge_approve && doc.state === 'answered' && ms(doc.raised_at) !== null && nowMs >= ms(doc.raised_at) + MERGE_APPROVE_MS;
  if (!unanswered && !unused) return false;
  const next = structuredClone(doc);
  if (doc.reask_count === 0) {
    releaseBoxes(next, 'lapsed', nowMs, { moveBack: false });
    delete next.answer;
    Object.assign(next, { state: 'open', reask_count: 1, lapsed_at: iso(nowMs) });
    write(ctx, a, next, events, { type: unused ? 'approval_lapsed' : 'lapsed', ask: a.id, card: doc.card });
  } else {
    releaseBoxes(next, 'expired', nowMs, { moveBack: false });
    next.state = 'expired';
    if (write(ctx, a, next, events, { type: 'expired', ask: a.id, card: doc.card })) await closeDecisionPr(ctx, a.id, doc);
  }
  return true;
}

async function push(ctx, a, { urgent, win, anyBound, nowMs }, events) {
  const doc = a.doc;
  const k = activeKind(doc.kind);
  const first = !raisedThisRound(doc);
  const mark = (d) => {
    d.last_push_at = iso(nowMs);
    if (win && !urgent) d.window_pushes = [...(d.window_pushes ?? []), win.key].slice(-MAX_WINDOW_MARKS);
  };
  if (k.channel === 'tap') {
    if (typeof ctx.push !== 'function') { ctx.alert({ type: 'approvals_no_push', ask: a.id }); return; }
    const event = { ask: a.id, card: doc.card, kind: doc.kind, urgent, ...(doc.kind === 'undo' && anyBound ? { line: UNDO_OPEN_QUESTION_LINE } : {}) };
    let sent = false;
    try { sent = (await ctx.push(event)) === true; } catch { sent = false; }
    if (!sent) { ctx.alert({ type: 'push_not_sent', ask: a.id }); return; }
    const next = structuredClone(doc);
    // A re-push never restarts the 12-hour clock: raised_at is set only by the first push or box of a round.
    if (first) Object.assign(next, { state: 'pushed', raised_at: iso(nowMs), raised_reask: next.reask_count, first_pushed_at: next.first_pushed_at ?? iso(nowMs) });
    mark(next);
    write(ctx, a, next, events, { type: first ? 'pushed' : 'repushed', ...event });
    return;
  }
  // GitHub kinds: the first round of a decision opens its pull request; a re-ask (or a risky change) requests the
  // owner's review again, and GitHub's time for that request is the new raised_at.
  if (k.decision_pr && !Number.isSafeInteger(doc.pr)) {
    const o = await openDecision(ctx, a.id);
    if (!o.ok) { ctx.alert({ type: 'decision_pr_not_opened', ask: a.id, reason: o.reason }); return; }
    const cur = askStore(ctx.record).ask(a.id);
    const next = structuredClone(cur.doc); mark(next);
    write(ctx, cur, next, events, { type: 'pushed', ask: a.id, card: doc.card, kind: doc.kind, pr: o.pr });
    return;
  }
  if (!Number.isSafeInteger(doc.pr)) { ctx.alert({ type: 'approvals_no_pull_request', ask: a.id }); return; }
  const cfg = readConfig(ctx.rules, ctx.product);
  const r = await requestReview({ gh: ctx.gh, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId });
  if (!r.ok) { ctx.alert({ type: 'review_not_requested', ask: a.id, reason: r.reason }); return; }
  const next = structuredClone(doc);
  Object.assign(next, { state: 'pushed', raised_at: r.raised_at, raised_reask: next.reask_count, first_pushed_at: next.first_pushed_at ?? iso(nowMs) });
  mark(next);
  write(ctx, a, next, events, { type: 'pushed', ask: a.id, card: doc.card, kind: doc.kind, pr: doc.pr });
}

export async function schedulePass(ctx) {
  const events = [];
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) { configAlert(ctx, cfg.reason); return fail(cfg.reason, { events }); }
  configAlert(ctx, null);
  const nowMs = ctx.now();
  const p = ctx.record.read('product', ctx.product);
  const win = dueWindow(nowMs, zoneFor(cfg, p && !p.corrupt ? p.doc : null), cfg.windows);
  events.push(...releaseSessions(ctx));

  const st = askStore(ctx.record);
  if (st.untrusted.length) ctx.alert({ type: 'approvals_untrusted', items: st.untrusted });
  for (const a of st.asks()) {
    if (!activeKind(a.doc.kind)) continue;
    await runOut(ctx, a, nowMs, events);
  }
  // Re-read: the run-outs above changed states.
  const asks = askStore(ctx.record).asks().filter((a) => activeKind(a.doc.kind));
  const anyBound = asks.some((a) => liveBox(a.doc));
  for (const a of asks) {
    const doc = a.doc;
    if (doc.state !== 'open' && doc.state !== 'pushed') continue;
    if (liveBox(doc)) continue;
    const held = heldBy(ctx.record, doc);
    if (held) { events.push({ type: 'held', ask: a.id, reason: held }); continue; }
    const urgent = cfg.urgent.includes(doc.kind);
    let due;
    if (urgent) due = !raisedThisRound(doc) || nowMs - (ms(doc.last_push_at) ?? 0) >= URGENT_REPUSH_MS;
    else due = win !== null && !raisedThisRound(doc) && (ms(doc.lapsed_at ?? doc.created_at) ?? Infinity) <= win.start;
    if (due) await push(ctx, a, { urgent, win, anyBound, nowMs }, events);
  }
  return { ok: true, events };
}

export async function readApprove(ctx, id, { view, catchUps = [] } = {}) {
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) return fail(cfg.reason);
  const a = askStore(ctx.record).ask(id);
  if (!a) return fail(`no trusted ask ${id}`);
  const doc = a.doc;
  if (doc.kind !== 'risky_approve') return fail(`a ${doc.kind} ask is not a merge approval`);
  if (doc.state !== 'pushed' || !Number.isSafeInteger(doc.pr) || !raisedThisRound(doc)) return { ok: true, counted: false };
  const c = await countApprove({ gh: ctx.gh, view, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId, raisedAt: doc.raised_at, catchUps });
  if (!c.ok) return { ok: true, counted: false, reason: c.reason, ...(c.line ? { line: c.line } : {}) };
  if ((ms(c.review.submitted_at) ?? Infinity) >= lapseAt(doc)) return { ok: true, counted: false, lapsed: true };
  const binding = { kind: 'github_review', pr: doc.pr, review_id: c.review.id, commit_id: c.review.commit_id, submitted_at: c.review.submitted_at, carried: c.carried };
  const answer = { channel: 'github_review', choice: 'approve', approves: true, declined: false, head: c.head, binding, at: iso(ctx.now()) };
  // The one approval check, on the answer as it will be recorded (L81).
  const counted = answerCounts(ctx.rules, { ...doc, answer }, { product: ctx.product });
  if (!counted.ok) { ctx.alert({ type: 'approval_not_counted', ask: id, reason: counted.reason }); return { ok: true, counted: false }; }
  const w = writeDoc(ctx.record, 'ask', a, { ...doc, state: 'answered', answer });
  if (!w.ok) return fail(`the record refused the answer: ${w.reason}`);
  return { ok: true, counted: true, head: c.head };
}

// Re-reads GitHub every time (audit round 1 M-1): a "Request changes" or a dismissal after the count withdraws it.
export async function approvalStands(ctx, id, { head, view, catchUps = [] } = {}) {
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) return fail(cfg.reason);
  const a = askStore(ctx.record).ask(id);
  if (!a) return fail(`no trusted ask ${id}`);
  const doc = a.doc;
  if (!activeKind(doc.kind)?.merge_approve) return fail(`a ${doc.kind} ask does not approve a merge`);
  if (doc.state !== 'answered' || doc.answer?.approves !== true) return fail(`ask ${id} is ${doc.state}`);
  if (typeof head !== 'string' || doc.answer.head !== head) return fail('the approval is for another head');
  const raised = ms(doc.raised_at);
  if (raised === null || ctx.now() >= raised + MERGE_APPROVE_MS) return fail('the approval lapsed: no merge within 24 hours');
  const c = await countApprove({ gh: ctx.gh, view, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId, raisedAt: doc.raised_at, catchUps });
  if (!c.ok || c.head !== head) return fail(`the approval no longer stands on GitHub: ${c.reason ?? 'the pull request moved to another head'}`);
  if ((ms(c.review.submitted_at) ?? Infinity) >= lapseAt(doc)) return fail('the standing Approve came after the ask lapsed');
  return { ok: true };
}
