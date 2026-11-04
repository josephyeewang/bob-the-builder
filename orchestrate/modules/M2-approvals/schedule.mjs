// schedule.mjs — when the owner is asked, re-asked, and when an ask or an approval runs out (R-0b-51, R-0b-53; 0b-5 spec
// review round 1 M5/M8/m2, round 2 m2-11, round 3 m3-1/m3-6, LEAD-CALLS L12).
//
// WHY. The owner is interrupted twice a day, not all day: an ask goes out only in a push window (08:00, 17:00 in the
// owner's zone, or the trip zone while away). Urgent kinds (undo, incident repair) go out at once and every 2 hours
// until answered. Nothing waits forever: a lapsing ask unanswered 12 hours after it was raised is re-asked once, in the
// next window, then expires. A merge approval not used within 24 hours of being raised goes back the same way. All
// clocks run from raised_at (GitHub's time for a review request; the first push or bound box for a tap), so a pass
// that runs late — the Mini was down — lapses an ask exactly as an on-time pass would, and an answer given after the
// lapse counts nothing (decision.mjs, readApprove below). A tap ask whose created_at can't be read is asked again from
// now, and Joe is told why, before anything else happens to it (reaskUnreadable, L362).
//
//   await schedulePass(ctx) → { ok, events } | { ok: false, reason, events }    one pass; the dispatcher runs it often
//     first makes the product's record when its rules file says `onboarding.state: active` and it has none (onboard.mjs)
//   await readApprove(ctx, askId, { view, catchUps }) → { ok, counted, head? }  a risky_approve ask's GitHub Approve
//   await approvalStands(ctx, askId, { head, view, catchUps }) → { ok } | { ok: false, reason }   may this head merge on it now?
//     + unreadable: true, cause when a GitHub read threw (L205); the Merge Gate classes `cause`
// ctx = { record, rules, product, now, alert, gh, owner, repo, stateDir, push }
//   push(event) → true when the owner's phone was sent `event` ({ ask, card, kind, urgent, line?, view? }; `view` is a
//   go's text from go-view.mjs goText, R-0b-138/139, or an owner-flagged undo's undoPushText, R-0b-140); anything else is
//   "not sent", and the ask is tried again next pass.
//
// HELD DECISIONS (R-0b-53, round 1 M8). A decision ask that carries `modules` (the modules of the decided.yaml entries
// its change touches) is not raised while any open card is on one of those modules. A card with no module is open on
// every module; a decision whose modules are unknown (empty, or not plain names) is held. Open = any state except
// merged, closed, cancelled, closed_no_answer and reverted; never the decision's own card.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { answerCounts } from '../../shared/approval.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { releaseBoxes, releaseSessions } from './binding.mjs';
import { CLOSE_DUE, closeDecisionPr, openDecision } from './decision.mjs';
import { goText, goView, undoPushText } from './go-view.mjs';
import { onboard, onboardNotices } from './onboard.mjs';
import { countApprove, requestReview } from './github-review.mjs';
import { MERGE_APPROVE_MS, TIME_REASKED_LINE, UNDO_OPEN_QUESTION_LINE, URGENT_REPUSH_MS, dueWindow, lapseAt, outsideTime, readConfig, zoneFor } from './kinds.mjs';
import { pastTime } from '../../shared/still-waiting.mjs';

export const HELD_CLOSED_STATES = Object.freeze(['merged', 'closed', 'cancelled', 'closed_no_answer', 'reverted']);
const MAX_WINDOW_MARKS = 20;
const MODULE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// The config alert goes out once per distinct problem, not every pass (round 2 m2-6), then again each day while that
// problem stands (L315: no ask is raised while the config is bad, so a once-ever message is a silent hold). The mark
// is stillWaiting's, its `since` naming the problem, kept only when the sink did not answer false (L130); a throw stops
// before the write. It goes once the config reads fine. A file that can't be read counts as nothing told.
function configAlert(ctx, reason) {
  const file = join(ctx.stateDir, 'config-alert.json');
  stillWaiting({
    waiting: reason !== null,
    since: reason ?? undefined,
    now: ctx.now?.() ?? Date.now(),
    read: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    tell: (mark) => {
      if (ctx.alert({ type: 'approvals_config', reason }) === false) return false;
      mkdirSync(ctx.stateDir, { recursive: true });
      writeFileSync(`${file}.new`, `${JSON.stringify(mark)}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
      return true;
    },
    clear: () => rmSync(file, { force: true }),
  });
}

// A push that can't go out (no phone channel, GitHub refused, the go can't be shown...) is told once per ask and cause,
// then again each day while the ask still waits (L295 Minor 1, re-ruled L309 MAT-2: the holdAlert pattern, M11
// pass.mjs). An urgent undo is re-tried every pass and a window ask four or five times, and each would otherwise reach
// Joe as a message; an ask never pushed has no time limit, so a once-ever message would be a silent hold. The cause is
// the alert's type and reason with its numbers out; its mark is stillWaiting's, kept only once the sink took it
// (answered true). An ask's marks go once it is pushed or stops waiting, so a later failure is told at once. Kept in
// ctx.stateDir (ask-alerts.json): a file that can't be read or parsed counts as nothing told, so it tells; with no
// stateDir, told every pass. A file that can't be saved throws: the step fails and the tick tells that once per day.
const ASK_ALERTS = 'ask-alerts.json';
const causeOf = (e) => `${e.type}:${String(e.reason ?? '').replace(/\d+/g, 'N')}`;
function askOnce(ctx) {
  const file = ctx.stateDir ? join(ctx.stateDir, ASK_ALERTS) : null;
  let marks = {};
  try { marks = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) ?? {} : {}; } catch { marks = {}; }
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) marks = {};
  const now = ctx.now?.() ?? Date.now();
  const before = JSON.stringify(marks);
  return {
    alert(ask, e) {
      const key = causeOf(e);
      const told = marks[ask] && typeof marks[ask] === 'object' && !Array.isArray(marks[ask]) ? marks[ask] : {};
      const said = stillWaiting({
        waiting: true,
        now,
        read: () => (file ? told[key] : null),
        tell: (mark) => {
          // Kept as told only when the sink took it (answered true); a refusal or a throw answers false and marks nothing.
          try { if (ctx.alert(e) !== true) return false; } catch { return false; }
          if (file) marks[ask] = Object.fromEntries([...Object.entries(told).filter(([k]) => k !== key), [key, mark]].slice(-MAX_WINDOW_MARKS));
          return true;
        },
        clear: () => {},
      });
      return said.answer;   // quiet: nothing was sent, so there is no answer
    },
    pushed(ask) { delete marks[ask]; },
    save(waiting) {
      if (!file) return;
      for (const id of Object.keys(marks)) if (!waiting.has(id)) delete marks[id];
      if (JSON.stringify(marks) === before) return;
      mkdirSync(ctx.stateDir, { recursive: true });
      // Replaced whole, so a file that could not be read is replaced by one that can (L309 Minor 2).
      writeFileSync(`${file}.new`, `${JSON.stringify(marks)}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
    },
  };
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

// A decision answered while its close did not go through carries CLOSE_DUE (decision.mjs, L135); the pass tries the
// close again, and takes the mark off once it closed or Joe was told it did not.
async function retryClose(ctx, a, events) {
  if (!(await closeDecisionPr(ctx, a.id, a.doc))) return;
  const { [CLOSE_DUE]: _due, ...rest } = a.doc;
  write(ctx, a, rest, events, { type: 'decision_pr_close_retried', ask: a.id, card: a.doc.card });
}

// A tap ask whose created_at can't be read or lies in the future: no box can bind on it (binding.mjs), so left alone it
// would expire with Joe never told (L362 MAT-2). It is raised afresh: created_at = now, open, no raised time, its boxes
// released, and not counted as the one re-ask, since Joe was never really asked. Joe is told first; a tell that didn't
// go through leaves the ask as it is, and the next pass tells again. True when this pass is done with the ask.
function reaskUnreadable(ctx, a, nowMs, events) {
  const doc = a.doc;
  if (activeKind(doc.kind).channel !== 'tap' || (doc.state !== 'open' && doc.state !== 'pushed') || pastTime(doc.created_at, nowMs) !== null) return false;
  let told = false;
  try { told = ctx.alert({ type: 'ask_time_unreadable', ask: a.id, card: doc.card, text: `The question about ${doc.card} [ask ${a.id}] is being asked again because its time could not be read. An earlier copy of it no longer counts.` }) === true; } catch { told = false; }
  if (!told) return true;
  const next = structuredClone(doc);
  releaseBoxes(next, 'time_unreadable', nowMs, { moveBack: false });
  delete next.raised_at;
  delete next.raised_reask;
  Object.assign(next, { state: 'open', created_at: iso(nowMs), time_reasked_at: iso(nowMs) });
  write(ctx, a, next, events, { type: 'reasked_time_unreadable', ask: a.id, card: doc.card, line: TIME_REASKED_LINE });
  return true;
}

// An unanswered lapsing ask 12 hours after it was raised this round, or an unused merge approval 24 hours after:
// the first time it goes back to open to be re-asked once (reask_count 1); the second time it expires. A raised_at that
// can't be read or lies in the future runs out now (L329: pastTime; an expiry never waits on a time it can't trust).
async function runOut(ctx, a, nowMs, events) {
  const doc = a.doc;
  const k = activeKind(doc.kind);
  const unanswered = k.lapse && (doc.state === 'open' || doc.state === 'pushed') && nowMs >= lapseAt(doc, nowMs);
  const raised = pastTime(doc.raised_at, nowMs);
  const unused = k.merge_approve && doc.state === 'answered' && (raised === null || nowMs >= raised + MERGE_APPROVE_MS);
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
    // Close first (L133 m-2); expired is written only once the close worked or Joe was told it did not.
    if (await closeDecisionPr(ctx, a.id, doc)) write(ctx, a, next, events, { type: 'expired', ask: a.id, card: doc.card });
  }
  return true;
}

async function push(ctx, a, { urgent, win, anyBound, nowMs, once }, events) {
  const doc = a.doc;
  const k = activeKind(doc.kind);
  const first = !raisedThisRound(doc);
  const mark = (d) => {
    d.last_push_at = iso(nowMs);
    if (win && !urgent) d.window_pushes = [...(d.window_pushes ?? []), win.key].slice(-MAX_WINDOW_MARKS);
  };
  if (k.channel === 'tap') {
    if (typeof ctx.push !== 'function') { once.alert(a.id, { type: 'approvals_no_push', ask: a.id }); return; }
    // A go push carries the go view (R-0b-138/139): the plan in three lines and the files it allows. One that can't be
    // shown is held, never sent bare.
    let view = null;
    if (k.go) { const v = goView(doc); if (!v.ok) { once.alert(a.id, { type: 'go_not_shown', ask: a.id, reason: v.reason }); return; } view = goText(v); }
    // An undo the owner flagged (R-0b-140) carries its pull request, so its push says which change and what Undo does.
    if (doc.kind === 'undo' && Number.isSafeInteger(doc.pr)) view = undoPushText({ card: doc.card, title: doc.title, pr: doc.pr });
    const event = { ask: a.id, card: doc.card, kind: doc.kind, urgent, ...(doc.kind === 'undo' && anyBound ? { line: UNDO_OPEN_QUESTION_LINE } : {}), ...(view ? { view } : {}) };
    let sent = false;
    try { sent = (await ctx.push(event)) === true; } catch { sent = false; }
    if (!sent) { once.alert(a.id, { type: 'push_not_sent', ask: a.id }); return; }
    const next = structuredClone(doc);
    // A re-push never restarts the 12-hour clock: raised_at is set only by the first push or box of a round.
    if (first) Object.assign(next, { state: 'pushed', raised_at: iso(nowMs), raised_reask: next.reask_count, first_pushed_at: next.first_pushed_at ?? iso(nowMs) });
    mark(next);
    if (write(ctx, a, next, events, { type: first ? 'pushed' : 'repushed', ...event })) once.pushed(a.id);
    return;
  }
  // GitHub kinds: the first round of a decision opens its pull request; a re-ask (or a risky change) requests the
  // owner's review again, and GitHub's time for that request is the new raised_at.
  if (k.decision_pr && !Number.isSafeInteger(doc.pr)) {
    const o = await openDecision(ctx, a.id);
    if (!o.ok) { once.alert(a.id, { type: 'decision_pr_not_opened', ask: a.id, reason: o.reason }); return; }
    const cur = askStore(ctx.record).ask(a.id);
    const next = structuredClone(cur.doc); mark(next);
    if (write(ctx, cur, next, events, { type: 'pushed', ask: a.id, card: doc.card, kind: doc.kind, pr: o.pr })) once.pushed(a.id);
    return;
  }
  if (!Number.isSafeInteger(doc.pr)) { once.alert(a.id, { type: 'approvals_no_pull_request', ask: a.id }); return; }
  const cfg = readConfig(ctx.rules, ctx.product);
  const r = await requestReview({ gh: ctx.gh, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId, now: nowMs });
  if (!r.ok) { once.alert(a.id, { type: 'review_not_requested', ask: a.id, reason: r.reason }); return; }
  const next = structuredClone(doc);
  Object.assign(next, { state: 'pushed', raised_at: r.raised_at, raised_reask: next.reask_count, first_pushed_at: next.first_pushed_at ?? iso(nowMs) });
  mark(next);
  if (write(ctx, a, next, events, { type: 'pushed', ask: a.id, card: doc.card, kind: doc.kind, pr: doc.pr })) once.pushed(a.id);
}

export async function schedulePass(ctx) {
  const events = [];
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) { configAlert(ctx, cfg.reason); return fail(cfg.reason, { events }); }
  configAlert(ctx, null);
  // A product whose rules file says it is on gets its record, once (L204-b, L209), after the config read (L221 m-3,
  // ratified): a product whose owner can't be asked is not started. Before the product read below, so the record the
  // rest of the pass reads is the one just made (pinned: onboarded is events[0]). Joe is told once (onboard.mjs).
  const made = onboard(ctx);
  if (made) events.push(made);
  onboardNotices(ctx, made);
  const nowMs = ctx.now();
  const p = ctx.record.read('product', ctx.product);
  const win = dueWindow(nowMs, zoneFor(cfg, p && !p.corrupt ? p.doc : null), cfg.windows);
  events.push(...releaseSessions(ctx));

  const st = askStore(ctx.record);
  if (st.untrusted.length) ctx.alert({ type: 'approvals_untrusted', items: st.untrusted });
  for (const a of st.asks()) {
    if (!activeKind(a.doc.kind)) continue;
    // A close still due is retried first; the ask's run-out waits for the next pass (one write per ask per pass).
    if (a.doc[CLOSE_DUE] === true) { await retryClose(ctx, a, events); continue; }
    if (reaskUnreadable(ctx, a, nowMs, events)) continue;
    await runOut(ctx, a, nowMs, events);
  }
  // Re-read: the run-outs above changed states.
  const asks = askStore(ctx.record).asks().filter((a) => activeKind(a.doc.kind));
  const anyBound = asks.some((a) => liveBox(a.doc));
  const once = askOnce(ctx);
  for (const a of asks) {
    const doc = a.doc;
    if (doc.state !== 'open' && doc.state !== 'pushed') continue;
    if (liveBox(doc)) continue;
    const held = heldBy(ctx.record, doc);
    if (held) { events.push({ type: 'held', ask: a.id, reason: held }); continue; }
    const urgent = cfg.urgent.includes(doc.kind);
    let due;
    // A stored time that can't be read or lies in the future counts as long past (L329: pastTime): the push goes out
    // now, never held back by it. Before, an unreadable created_at kept a non-urgent ask out of every window.
    const pushed = pastTime(doc.last_push_at, nowMs);
    const since = pastTime(doc.lapsed_at ?? doc.created_at, nowMs);
    if (urgent) due = !raisedThisRound(doc) || pushed === null || nowMs - pushed >= URGENT_REPUSH_MS;
    else due = win !== null && !raisedThisRound(doc) && (since === null || since <= win.start);
    if (due) await push(ctx, a, { urgent, win, anyBound, nowMs, once }, events);
  }
  // Marks are kept only for asks still waiting to be pushed; re-read, since a push moved some on.
  once.save(new Set(askStore(ctx.record).asks().filter((a) => a.doc.state === 'open' || a.doc.state === 'pushed').map((a) => a.id)));
  return { ok: true, events };
}

export async function readApprove(ctx, id, { view, catchUps = [] } = {}) {
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) return fail(cfg.reason);
  const a = askStore(ctx.record).ask(id);
  if (!a) return fail(`no trusted ask ${id}`);
  const doc = a.doc;
  if (doc.kind !== 'risky_approve') return fail(`a ${doc.kind} ask is not a merge approval`);
  if (doc.state !== 'pushed' || !Number.isSafeInteger(doc.pr)) return { ok: true, counted: false };
  if (!raisedThisRound(doc)) return { ok: true, counted: false, reason: 'the ask has no readable raised time this round' };   // L362 m2
  const c = await countApprove({ gh: ctx.gh, view, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId, raisedAt: doc.raised_at, catchUps });
  if (!c.ok) return { ok: true, counted: false, reason: c.reason, ...(c.line ? { line: c.line } : {}) };
  if ((ms(c.review.submitted_at) ?? Infinity) >= lapseAt(doc, ctx.now())) return { ok: true, counted: false, lapsed: true };
  const binding = { kind: 'github_review', pr: doc.pr, review_id: c.review.id, commit_id: c.review.commit_id, submitted_at: iso(outsideTime(c.review.submitted_at, ctx.now())), carried: c.carried };
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
  const raised = pastTime(doc.raised_at, ctx.now());   // unreadable or in the future: lapsed (L329)
  if (raised === null || ctx.now() >= raised + MERGE_APPROVE_MS) return fail('the approval lapsed: no merge within 24 hours');
  const c = await countApprove({ gh: ctx.gh, view, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId, raisedAt: doc.raised_at, catchUps });
  // GitHub could not be read: whether it stands is not known, which the Merge Gate waits out (L205).
  if (!c.ok && c.unreadable === true) return fail(`whether the approval stands could not be read from GitHub: ${c.reason}`, { unreadable: true, cause: c.cause });
  if (!c.ok || c.head !== head) return fail(`the approval no longer stands on GitHub: ${c.reason ?? 'the pull request moved to another head'}`);
  if ((ms(c.review.submitted_at) ?? Infinity) >= lapseAt(doc, ctx.now())) return fail('the standing Approve came after the ask lapsed');
  return { ok: true };
}
