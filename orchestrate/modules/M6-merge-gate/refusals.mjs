// refusals.mjs — the Merge Gate's fourteen refusals, judged over facts already gathered (R-0b-87, R-0b-88, R-0b-89,
// R-0b-90, R-0b-97; design v4 §14.1.7; 0b-9 review rounds 1–3; L44).
//
// WHY. The gate must say no for a reason a person can read, and every reason must be checkable on its own. So judging is
// one pure function over a plain facts object (gather.mjs builds it from GitHub, the record and the rules): a planted
// facts object is refused for exactly one reason in a test, with no network and no record. Anything the gatherer
// couldn't read arrives as null or { ok: false } and is never a pass: it holds the change to be judged again (see FINAL
// OR NOT YET below); nothing here throws a pass.
//
//   judge(facts) → { decision: 'merge' | 'hold' | 'refuse', refusals: [{ n, reason, temporary? }], hold: reason | null, notes: [line] }
//   verdictProblem(facts) → reason | null        refusal 5 alone: M9's verdict rule plus the four-line checklist (L44)
//   REFUSALS → { n: short name }                 the numbers are design v4 §14.1.7's
//   WAITING_HOLD                                  the hold for a change that can't be judged yet (L164)
//
// FINAL OR NOT YET (L164). A refusal is final only when it is about the change itself: a red check, a failing review, a
// draft, a merge conflict, out of lane. A final refusal stays refused until the card changes. Anything that only says
// "not known yet" is marked temporary: GitHub or the record could not be read, a check or a review session has not
// finished, GitHub has not worked out yet whether the PR is mergeable, or main is red (main's state, not the change's).
// A change with temporary refusals and no final one is held (WAITING_HOLD), so the gate judges it again on its next
// pass instead of refusing it for good.
//
// THE FACTS (gather.mjs fills them; a missing one refuses whatever reads it):
//   cutoverStage 'first' | 'second'          product.cutover_stage, missing = first
//   card { id, doc }                         doc.head is H0, the head the review and the request were for
//   request { id, doc, createdBy } | null    the merge_request (refusal 11)
//   movesSinceRequest [{ actor, entity, id }] | null   diary lines on this card or its merge after the request's rev
//   pr { number, state, draft, base: { ref }, head: { sha }, mergeable, mergeable_state } | null
//   main { sha, green: bool | null }         main's head and whether its own checks are green (refusal 2)
//   checks [{ name, app_id, head_sha, status, conclusion }] | null   check runs on the PR head (refusals 1, 6)
//   statuses [{ context, state }] | null     commit statuses on the PR head (refusal 1)
//   requiredChecks [name], checksIgnored [{ app_id, name }]
//   compareStatus 'ahead' | 'behind' | 'diverged' | 'identical' | null   main...head (refusal 12)
//   carried { review, audit, unread?, reasons } | null   carry-over from H0 to the PR head (read only when they differ;
//                                            unread: true when it could not be read, which is not yet)
//   reviews [{ role, session_id, head, tree, aside, ended, silent, verdict | null, problem | null }] | null   every
//                                            session the review runner launched for this card at H0 or H0's tree, with
//                                            its own verdict file (M9 headReviews, L68, L69); null when they could not
//                                            be read, with reviewsProblem saying why
//   prReviews (same shape) | null            the same at the PR head and its tree, read only when it is not H0 (L69);
//                                            null when they could not be read, with prReviewsProblem saying why
//   tier 1 | 2 | null                        M10's computed tier for the change
//   exactReverse bool                        the change recomputes as an exact reverse (M10 exact-reverse.mjs)
//   reversesGateMerge bool                   the reversed commit carries the robot's mark (first-cutover undo)
//   lane { decision, reason, tier }          rules.may('merge', subject): M10 picks docs lane or deep by cutover
//   approve { needed, why, stands, reason }  M2 approveNeeded + approvalStands (refusals 8, 13, 14)
//   go { ok, reasons, skipped } | null       M2 goCheck, or skipped for a go-free kind (refusal 10)
//   threads { ok, unresolved } | null        unresolved human review threads, GraphQL (refusal 7)
//   rulesAdopted bool | null                 the adopted rules blob equals policy.yaml at main (else a hold)
//   files [{ path, status }] | null          the change's files
//   firstCustomerNewFiles [prefix] | null    effect_paths.first_customer_visible.new_files_under

import { PASSES, worstVerdict } from '../M9-record/outbox.mjs';
import { HOLD_REASONS } from '../../shared/rules.mjs';
import { compileList } from '../M10-rules/paths.mjs';

export const REFUSALS = Object.freeze({
  1: 'required checks red', 2: 'main red', 3: 'draft, out of date or not mergeable', 4: 'stacked', 5: 'no reviewer verdict',
  6: 'checks for another commit', 7: 'unresolved review threads', 8: 'needs the owner\'s Approve', 9: 'out of lane',
  10: 'go mismatch', 11: 'no merge request', 12: 'behind main', 13: 'fix card (stand-in)', 14: 'new customer-visible file (stand-in)',
});

export const NOT_BUILT_LINE = 'refusal 13/14 not built: Joe\'s Approve used';
export const FIRST_LANE_LINE = 'first cutover: docs lane only';
export const DAILY_CARD_LINE = 'the daily card does not merge through the gate yet (pending the lead\'s call, R3-M2a)';

export const WAITING_HOLD = 'waiting';

const SHA = /^[0-9a-f]{40}$/;
const GOOD = new Set(['success', 'neutral', 'skipped']);
const final = (reason) => ({ reason, temporary: false });
const notYet = (reason) => ({ reason, temporary: true });
const MERGEABLE = new Set(['clean', 'unstable', 'has_hooks']);

// A check is ignored only by an exact (app id, name) pair from the rules; a name alone could be any app's.
const ignored = (c, list) => (Array.isArray(list) ? list : []).some((x) => Number.isInteger(x?.app_id) && x.app_id === c?.app_id && typeof x.name === 'string' && x.name === c?.name);

// Red comes first: a red check or status is about the change, whatever else is still running. What is left after that
// (a check that has not run or not finished, a pending status) is not known yet.
function checksProblem(f) {
  if (!Array.isArray(f.checks) || !Array.isArray(f.statuses)) return notYet('the checks could not be read');
  if (!Array.isArray(f.requiredChecks)) return notYet('the rules name no required checks');
  const runs = f.checks.filter((c) => !ignored(c, f.checksIgnored));
  const runRed = (c) => c?.status === 'completed' && !GOOD.has(c.conclusion);
  const stPending = (x) => x?.state === 'pending';
  const stRed = (x) => x?.state !== 'success' && !stPending(x);
  for (const name of f.requiredChecks) {
    if (runs.some((c) => c?.name === name && runRed(c)) || f.statuses.some((x) => x?.context === name && stRed(x))) return final(`required check ${name} is not green`);
  }
  const red = runs.find(runRed);
  if (red) return final(`check ${red.name} concluded ${red.conclusion}`);
  const bad = f.statuses.find(stRed);
  if (bad) return final(`status ${bad?.context} is ${bad?.state}`);
  for (const name of f.requiredChecks) {
    const mine = runs.filter((c) => c?.name === name);
    const st = f.statuses.filter((x) => x?.context === name);
    if (!mine.length && !st.length) return notYet(`required check ${name} has not run`);
    if (mine.some((c) => c.status !== 'completed') || st.some(stPending)) return notYet(`required check ${name} has not finished`);
  }
  const pending = runs.find((c) => c?.status !== 'completed');
  if (pending) return notYet(`check ${pending?.name} has not finished`);
  const waiting = f.statuses.find(stPending);
  if (waiting) return notYet(`status ${waiting?.context} is pending`);
  return null;
}

// The role's own pass (a reviewer with a clean four-line checklist, an auditor with 0 Material) is M9's, the one
// definition the record's move to verified uses too (L69 point 6).
export { PASSES };

// The worst verdict (L68, L69): every session the review runner launched for this card at this head, or at any head with
// the same tree, has its say, so an extra start (or an amend with no code change) can only add a chance to fail. A role
// passes only when one of its sessions passed, none failed, none ended silent and none is unsettled (M9 worstVerdict).
// An auditor that ran on a Tier-2 change still has its say: a failing one refuses. When the pull request's head is not
// H0, every session at that head (or its tree) has its say too, even when the review carries over (L69 point 5).
// A role's worst verdict, final or not yet: while one of its sessions is still running, it may yet hand in a pass, so
// only a failure among the sessions that are settled is final.
function roleProblem(sessions, role, passes, needPass) {
  const p = worstVerdict(sessions, role, passes, { needPass });
  if (!p) return null;
  const running = (x) => x?.role === role && x.aside !== true && x.never_ran !== true && !x.problem && x.ended !== true;
  if (!sessions.some(running)) return final(p);
  const settled = worstVerdict(sessions.filter((x) => !running(x)), role, passes, { needPass: false });
  return settled ? final(settled) : notYet(p);
}
const reworded = (x, text) => ({ ...x, reason: text(x.reason) });

function verdictCheck(f) {
  const head = f.card?.doc?.head;
  if (!SHA.test(head ?? '')) return final('the card has no head');
  if (!Array.isArray(f.reviews)) return notYet(`the review runner's records could not be read: ${f.reviewsProblem ?? 'not gathered'}`);
  const at = ` at ${head.slice(0, 7)}`;
  const rp = roleProblem(f.reviews, 'reviewer', PASSES.reviewer, true);
  if (rp) return reworded(rp, (r) => `${r}${at} (a pass needs a clean four-line checklist)`);
  if (f.tier !== 1 && f.tier !== 2) return notYet('the change\'s tier is unknown');
  const ap = roleProblem(f.reviews, 'auditor', PASSES.auditor, f.tier === 1);
  if (ap) return reworded(ap, (r) => `${f.tier === 1 ? 'Tier 1: ' : ''}${r}${at} (a pass needs 0 Material)`);
  const prHead = f.pr?.head?.sha;
  if (prHead !== head) {
    if (!SHA.test(prHead ?? '')) return notYet('the pull request\'s head could not be read');
    const there = ` at the pull request's head ${prHead.slice(0, 7)}`;
    if (!Array.isArray(f.prReviews)) return notYet(`the review runner's records${there} could not be read: ${f.prReviewsProblem ?? 'not gathered'}`);
    const pp = roleProblem(f.prReviews, 'reviewer', PASSES.reviewer, false) ?? roleProblem(f.prReviews, 'auditor', PASSES.auditor, false);
    if (pp) return reworded(pp, (r) => `${r}${there}`);
    if (!f.carried || f.carried.unread === true) return notYet(`whether the review carries over to ${prHead.slice(0, 7)} could not be read`);
    if (f.carried.review !== true) return final(`the review was for ${head.slice(0, 7)}; it does not carry over to ${prHead.slice(0, 7)}`);
    if (f.tier === 1 && f.carried.audit !== true) return final(`the Tier-1 audit does not carry over to ${prHead.slice(0, 7)}`);
  }
  return null;
}
export function verdictProblem(f) { return verdictCheck(f)?.reason ?? null; }

function requestProblem(f) {
  const r = f.request;
  if (!r?.doc) return final('no merge request');
  if (r.createdBy !== 'dispatcher') return final('the merge request was not written by the Dispatcher');
  if (r.doc.card !== f.card.id) return final('the merge request is for another card');
  // An unread pull request is refusal 3's to say (not yet), never "another pull request".
  if (f.pr && r.doc.pr !== f.pr.number) return final('the merge request is for another pull request');
  if (r.doc.head !== f.card.doc.head) return final('the merge request is for another head');
  // A tab's claim is named tab:<claim_id> and must be the live claim. M9 refuses a request for a card with a claim, so
  // this path is closed today (README, known gaps); the check stays so opening it can't skip it.
  const sid = r.doc.session_id;
  if (typeof sid !== 'string' || !sid) return final('the merge request names no session');
  if (sid.startsWith('tab:') && sid !== `tab:${f.card.doc.claim?.claim_id ?? ''}`) return final('the merge request names a tab claim that is not the card\'s claim');
  if (!Array.isArray(f.movesSinceRequest)) return notYet('the record since the request could not be read');
  const other = f.movesSinceRequest.find((m) => m?.actor !== 'merge_gate');
  if (other) return final(`the card moved since the request (${other.actor} wrote ${other.entity} ${other.id})`);
  return null;
}

// The list is read as M10 reads it: patterns (M10 paths.mjs), so `app/`, `app/**` and `app/pages/*.tsx` mean what
// they mean to the classification. A pattern M10 can't read makes this unknown, which refuses.
function customerFiles(f) {
  if (!Array.isArray(f.files) || !Array.isArray(f.firstCustomerNewFiles)) return null;
  let match;
  try { match = compileList(f.firstCustomerNewFiles); } catch { return null; }
  return f.files.filter((x) => x?.status !== 'removed' && typeof x?.path === 'string' && match(x.path) !== null);
}

export function judge(f) {
  const refusals = [];
  const notes = [];
  const no = (n, reason) => refusals.push({ n, reason });
  const wait = (n, reason) => refusals.push({ n, reason, temporary: true });
  const add = (n, x) => { if (x) (x.temporary ? wait : no)(n, x.reason); };
  try {
    // A review launch record no card can be tied to was skipped by M9's check (L69 point 3): logged with the decision.
    for (const x of Array.isArray(f?.reviewsSkipped) ? f.reviewsSkipped : []) notes.push(`a review launch record that names no card was skipped (${x})`);
    if (!f?.card?.id || !f.card.doc) return { decision: 'refuse', refusals: [{ n: 11, reason: 'no card' }], hold: null, notes };
    const first = f.cutoverStage !== 'second';
    const reverse = f.exactReverse === true;
    const kind = f.card.doc.kind ?? 'ordinary';
    if (kind === 'lead_daily_card') return { decision: 'refuse', refusals: [{ n: 9, reason: DAILY_CARD_LINE }], hold: null, notes };
    if (kind === 'exact_reverse' && !reverse) no(9, 'an undo card whose change is not an exact reverse');
    else if (first && kind === 'exact_reverse' && f.reversesGateMerge !== true) no(9, 'first cutover: an undo merges only when it reverses a merge the gate made');

    // 1, 6. The checks, on this commit. An exact reverse skips 1 (it must be able to undo a red main), never 6.
    if (!reverse) add(1, checksProblem(f));
    const prHead = f.pr?.head?.sha;
    // A PR head that could not be read is refusal 3's to say (not yet); 6 compares only against a head that was read.
    if (!Array.isArray(f.checks)) { if (reverse) wait(6, 'the checks could not be read'); } else if (SHA.test(prHead ?? '') && f.checks.some((c) => c?.head_sha !== prHead)) no(6, 'a check result is for another commit');
    // 2. main. Red or unread, it is main's state, not the change's: not yet.
    if (f.main?.green !== true) wait(2, f.main?.green === false ? 'main is red' : 'main\'s checks could not be read');
    // 3, 4. The pull request. GitHub works out mergeable in the background, so null or 'unknown' is not yet.
    const pr = f.pr;
    if (!pr) wait(3, 'the pull request could not be read');
    else {
      if (pr.state !== 'open') no(3, `the pull request is ${pr.state}`);
      else if (pr.draft !== false) no(3, 'the pull request is a draft');
      else if (pr.mergeable == null || pr.mergeable_state == null || pr.mergeable_state === 'unknown') wait(3, `GitHub has not worked out yet whether the pull request is mergeable (${pr.mergeable_state ?? 'unknown'})`);
      else if (pr.mergeable !== true || !MERGEABLE.has(pr.mergeable_state)) no(3, `the pull request is not mergeable (${pr.mergeable_state})`);
      if (pr.base?.ref !== 'main') no(4, `stacked on ${pr.base?.ref ?? 'an unknown branch'}, not main`);
    }
    // 5. The review (and the Tier-1 audit).
    if (!reverse) add(5, verdictCheck(f));
    // 7. Human review threads (fail closed).
    if (f.threads?.ok !== true) wait(7, 'the review threads could not be read');
    else if (!(f.threads.unresolved === 0)) no(7, `${f.threads.unresolved} review thread(s) unresolved`);
    // 9 and the holds. M10's merge answer; a hold keeps the place in the queue.
    const lane = f.lane;
    let hold = null;
    if (!lane || !['allow', 'ask', 'deny'].includes(lane.decision)) wait(9, 'the rules gave no merge answer');
    else if (lane.decision === 'deny') {
      if (HOLD_REASONS.includes(lane.reason)) hold = lane.reason;
      else no(9, first ? `${FIRST_LANE_LINE} (${lane.reason})` : lane.reason);
    }
    if (f.rulesAdopted !== true) hold = hold ?? 'rules_not_adopted';
    // 8, 13, 14. The owner's Approve. An exact reverse is exempt from the needs-the-owner and live-check triggers, but
    // M10's own ask for a reverse still needs it (R2-M3).
    const ap = f.approve;
    const stands = ap?.stands === true;
    if (!stands) {
      if (lane?.decision === 'ask') no(8, `the rules ask for the owner's Approve: ${lane.reason}`);
      // With the change's files unread, M10 calls every change unclassifiable, so "needs the Approve" is not known yet
      // (PROBE-D, L164): it waits for a pass that reads them.
      else if (!reverse && ap?.needed === true && !Array.isArray(f.files)) wait(8, 'the change\'s files could not be read, so whether it needs the owner\'s Approve is not known yet');
      else if (!reverse && ap?.needed === true) no(8, `needs the owner's Approve: ${(ap.why ?? []).join('; ')}${ap.reason ? ` (${ap.reason})` : ''}`);
      else if (!reverse && ap?.needed !== false) wait(8, 'the Approve check could not run');
    }
    if (kind === 'fix') { if (stands) notes.push(NOT_BUILT_LINE); else no(13, 'a fix card needs the owner\'s Approve until refusal 13 is built'); }
    const cf = customerFiles(f);
    if (cf === null) wait(14, 'the change\'s files or the first-customer paths could not be read');
    else if (cf.length) { if (stands) { if (!notes.includes(NOT_BUILT_LINE)) notes.push(NOT_BUILT_LINE); } else no(14, `${cf[0].path} is customer-visible; needs the owner's Approve until refusal 14 is built`); }
    // 10. The go.
    if (!f.go) wait(10, 'the go could not be checked');
    else if (f.go.ok !== true && f.go.skipped !== true) no(10, (Array.isArray(f.go.reasons) && f.go.reasons.length ? f.go.reasons : ['go mismatch']).join('; '));
    // 11. The request.
    if (!reverse) add(11, requestProblem(f));
    // 12. Behind main.
    if (f.compareStatus !== 'ahead') (f.compareStatus ? no : wait)(12, f.compareStatus ? `the branch is ${f.compareStatus} main` : 'the branch could not be compared with main');

    // Any final refusal refuses, and lists the not-yet ones too; only not-yet ones hold the change to be judged again.
    if (refusals.some((x) => !x.temporary)) return { decision: 'refuse', refusals, hold: null, notes };
    if (refusals.length) return { decision: 'hold', refusals, hold: WAITING_HOLD, notes };
    return { decision: hold ? 'hold' : 'merge', refusals, hold, notes };
  } catch (e) {
    return { decision: 'refuse', refusals: [...refusals, { n: 0, reason: `judging failed: ${String(e?.message ?? e).slice(0, 200)}` }], hold: null, notes };
  }
}
