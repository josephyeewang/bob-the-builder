// refusals.mjs — the Merge Gate's fourteen refusals, judged over facts already gathered (R-0b-87, R-0b-88, R-0b-89,
// R-0b-90, R-0b-97; design v4 §14.1.7; 0b-9 review rounds 1–3; L44).
//
// WHY. The gate must say no for a reason a person can read, and every reason must be checkable on its own. So judging is
// one pure function over a plain facts object (gather.mjs builds it from GitHub, the record and the rules): a planted
// facts object is refused for exactly one reason in a test, with no network and no record. Anything the gatherer
// couldn't read arrives as null or { ok: false } and refuses (fail closed); nothing here throws a pass.
//
//   judge(facts) → { decision: 'merge' | 'hold' | 'refuse', refusals: [{ n, reason }], hold: reason | null, notes: [line] }
//   verdictProblem(facts) → reason | null        refusal 5 alone: M9's verdict rule plus the four-line checklist (L44)
//   REFUSALS → { n: short name }                 the numbers are design v4 §14.1.7's
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
//   carried { review, audit, reasons, head } | null   carry-over from H0 to the PR head (read only when they differ;
//                                            gather `carriedFrom`); `head` is the head it was worked out for (L80)
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

const SHA = /^[0-9a-f]{40}$/;
const GOOD = new Set(['success', 'neutral', 'skipped']);
const MERGEABLE = new Set(['clean', 'unstable', 'has_hooks']);

// A check is ignored only by an exact (app id, name) pair from the rules; a name alone could be any app's.
const ignored = (c, list) => (Array.isArray(list) ? list : []).some((x) => Number.isInteger(x?.app_id) && x.app_id === c?.app_id && typeof x.name === 'string' && x.name === c?.name);

function checksProblem(f) {
  if (!Array.isArray(f.checks) || !Array.isArray(f.statuses)) return 'the checks could not be read';
  if (!Array.isArray(f.requiredChecks)) return 'the rules name no required checks';
  const runs = f.checks.filter((c) => !ignored(c, f.checksIgnored));
  for (const name of f.requiredChecks) {
    const mine = runs.filter((c) => c?.name === name);
    const st = f.statuses.filter((s) => s?.context === name);
    if (!mine.length && !st.length) return `required check ${name} has not run`;
    if (mine.some((c) => c.status !== 'completed' || !GOOD.has(c.conclusion)) || st.some((s) => s.state !== 'success')) return `required check ${name} is not green`;
  }
  const red = runs.find((c) => c?.status === 'completed' && !GOOD.has(c.conclusion));
  if (red) return `check ${red.name} concluded ${red.conclusion}`;
  const pending = runs.find((c) => c?.status !== 'completed');
  if (pending) return `check ${pending?.name} has not finished`;
  const bad = f.statuses.find((s) => s?.state !== 'success');
  if (bad) return `status ${bad?.context} is ${bad?.state}`;
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
export function verdictProblem(f) {
  const head = f.card?.doc?.head;
  if (!SHA.test(head ?? '')) return 'the card has no head';
  if (!Array.isArray(f.reviews)) return `the review runner's records could not be read: ${f.reviewsProblem ?? 'not gathered'}`;
  const at = ` at ${head.slice(0, 7)}`;
  const rp = worstVerdict(f.reviews, 'reviewer', PASSES.reviewer);
  if (rp) return `${rp}${at} (a pass needs a clean four-line checklist)`;
  if (f.tier !== 1 && f.tier !== 2) return 'the change\'s tier is unknown';
  const ap = worstVerdict(f.reviews, 'auditor', PASSES.auditor, { needPass: f.tier === 1 });
  if (ap) return `${f.tier === 1 ? 'Tier 1: ' : ''}${ap}${at} (a pass needs 0 Material)`;
  const prHead = f.pr?.head?.sha;
  if (prHead !== head) {
    const there = ` at the pull request's head ${String(prHead).slice(0, 7)}`;
    if (!Array.isArray(f.prReviews)) return `the review runner's records${there} could not be read: ${f.prReviewsProblem ?? 'not gathered'}`;
    const pp = worstVerdict(f.prReviews, 'reviewer', PASSES.reviewer, { needPass: false }) ?? worstVerdict(f.prReviews, 'auditor', PASSES.auditor, { needPass: false });
    if (pp) return `${pp}${there}`;
    if (f.carried?.review !== true) return `the review was for ${head.slice(0, 7)}; it does not carry over to ${String(prHead).slice(0, 7)}`;
    // The short re-audit (L80 (A), R-0b-146): when the review carried over to exactly this head and only the audit did
    // not, a passing auditor at the pull request's head counts in its place. Every auditor there still has its say.
    if (f.tier === 1 && f.carried.audit !== true) {
      const no = `the Tier-1 audit does not carry over to ${String(prHead).slice(0, 7)}`;
      if (f.carried.head !== prHead) return no;
      const re = worstVerdict(f.prReviews, 'auditor', PASSES.auditor, { needPass: true });
      if (re) return `${no}, and no short re-audit passed there (${re})`;
    }
  }
  return null;
}

function requestProblem(f) {
  const r = f.request;
  if (!r?.doc) return 'no merge request';
  if (r.createdBy !== 'dispatcher') return 'the merge request was not written by the Dispatcher';
  if (r.doc.card !== f.card.id) return 'the merge request is for another card';
  if (r.doc.pr !== f.pr?.number) return 'the merge request is for another pull request';
  if (r.doc.head !== f.card.doc.head) return 'the merge request is for another head';
  // A tab's claim is named tab:<claim_id> and must be the live claim. M9 refuses a request for a card with a claim, so
  // this path is closed today (README, known gaps); the check stays so opening it can't skip it.
  const sid = r.doc.session_id;
  if (typeof sid !== 'string' || !sid) return 'the merge request names no session';
  if (sid.startsWith('tab:') && sid !== `tab:${f.card.doc.claim?.claim_id ?? ''}`) return 'the merge request names a tab claim that is not the card\'s claim';
  if (!Array.isArray(f.movesSinceRequest)) return 'the record since the request could not be read';
  const other = f.movesSinceRequest.find((m) => m?.actor !== 'merge_gate');
  if (other) return `the card moved since the request (${other.actor} wrote ${other.entity} ${other.id})`;
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
    if (!reverse) { const p = checksProblem(f); if (p) no(1, p); }
    const prHead = f.pr?.head?.sha;
    if (!Array.isArray(f.checks)) { if (reverse) no(6, 'the checks could not be read'); } else if (f.checks.some((c) => c?.head_sha !== prHead)) no(6, 'a check result is for another commit');
    // 2. main.
    if (f.main?.green !== true) no(2, f.main?.green === false ? 'main is red' : 'main\'s checks could not be read');
    // 3, 4. The pull request.
    const pr = f.pr;
    if (!pr) no(3, 'the pull request could not be read');
    else {
      if (pr.state !== 'open') no(3, `the pull request is ${pr.state}`);
      else if (pr.draft !== false) no(3, 'the pull request is a draft');
      else if (pr.mergeable !== true || !MERGEABLE.has(pr.mergeable_state)) no(3, `the pull request is not mergeable (${pr.mergeable_state ?? 'unknown'})`);
      if (pr.base?.ref !== 'main') no(4, `stacked on ${pr.base?.ref ?? 'an unknown branch'}, not main`);
    }
    // 5. The review (and the Tier-1 audit).
    if (!reverse) { const p = verdictProblem(f); if (p) no(5, p); }
    // 7. Human review threads (fail closed).
    if (f.threads?.ok !== true) no(7, 'the review threads could not be read');
    else if (!(f.threads.unresolved === 0)) no(7, `${f.threads.unresolved} review thread(s) unresolved`);
    // 9 and the holds. M10's merge answer; a hold keeps the place in the queue.
    const lane = f.lane;
    let hold = null;
    if (!lane || !['allow', 'ask', 'deny'].includes(lane.decision)) no(9, 'the rules gave no merge answer');
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
      else if (!reverse && ap?.needed !== false) no(8, ap?.needed === true ? `needs the owner's Approve: ${(ap.why ?? []).join('; ')}${ap.reason ? ` (${ap.reason})` : ''}` : 'the Approve check could not run');
    }
    if (kind === 'fix') { if (stands) notes.push(NOT_BUILT_LINE); else no(13, 'a fix card needs the owner\'s Approve until refusal 13 is built'); }
    const cf = customerFiles(f);
    if (cf === null) no(14, 'the change\'s files or the first-customer paths could not be read');
    else if (cf.length) { if (stands) { if (!notes.includes(NOT_BUILT_LINE)) notes.push(NOT_BUILT_LINE); } else no(14, `${cf[0].path} is customer-visible; needs the owner's Approve until refusal 14 is built`); }
    // 10. The go.
    if (!f.go) no(10, 'the go could not be checked');
    else if (f.go.ok !== true && f.go.skipped !== true) no(10, (Array.isArray(f.go.reasons) && f.go.reasons.length ? f.go.reasons : ['go mismatch']).join('; '));
    // 11. The request.
    if (!reverse) { const p = requestProblem(f); if (p) no(11, p); }
    // 12. Behind main.
    if (f.compareStatus !== 'ahead') no(12, f.compareStatus ? `the branch is ${f.compareStatus} main` : 'the branch could not be compared with main');

    if (refusals.length) return { decision: 'refuse', refusals, hold: null, notes };
    return { decision: hold ? 'hold' : 'merge', refusals, hold, notes };
  } catch (e) {
    return { decision: 'refuse', refusals: [...refusals, { n: 0, reason: `judging failed: ${String(e?.message ?? e).slice(0, 200)}` }], hold: null, notes };
  }
}
