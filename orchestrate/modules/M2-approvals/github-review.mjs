// github-review.mjs — when the owner's GitHub Approve counts (R-0b-49; 0b-5 spec review round 1 M4, round 2 m2-3/m2-4).
//
// WHY. A risky change, a decision and a Tier-1 go are answered only by the owner's own Approve on GitHub, on the exact
// change. The robot can't forge that review, and a typed line in any terminal never reaches it.
//
// THE RULE. The owner is the account with the numeric id accounts.joe.github_id, of type "User" (a login can be renamed;
// an app or bot account is never the owner). Only the owner's reviews submitted at or after the ask was raised count;
// raised = the time GitHub logged the robot's review request for the owner (read back from the timeline, never the
// Mac's clock). In order, DISMISSED included, the owner's latest review that is not a plain comment decides:
//   APPROVED       → counts, if its commit is the pull request's head now, or carries over to it (M10 carryOver: the
//                    change's own files identical, and only recorded catch-up merges between);
//   CHANGES_REQUESTED → "changes requested" (a decision PR records it as declined);
//   DISMISSED      → nothing counts.
// Any review of the owner's made through an app (performed_via_github_app) refuses the count. An Approve given only
// before the ask was raised counts nothing; the owner is told APPROVE_AGAIN_LINE. Any GitHub error → no count.
//
//   await requestReview({ gh, owner, repo, pr, githubId }) → { ok, raised_at } | { ok: false, reason }
//   await ownerVerdict({ gh, owner, repo, pr, githubId, raisedAt }) → { ok, verdict: 'approved'|'changes_requested'|
//     'none', review?, head, line? } | { ok: false, reason }
//   await countApprove({ gh, view, owner, repo, pr, githubId, raisedAt, catchUps }) → { ok, head, review, carried }
//     | { ok: false, reason, line? }            the count for a merge: the exact head it is for is returned (M4)
// `gh` is a GitHub client ({ get, post, … } → { status, json }); `view` is M10's git view of the same repository.

import { carryOver } from '../M10-rules/carry-over.mjs';
import { APPROVE_AGAIN_LINE } from './kinds.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAX_PAGES = 10;
const MAX_BETWEEN = 100;
const ms = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

async function read(gh, path) {
  const r = await gh.get(path);
  if (r?.status !== 200 || r.json === null || typeof r.json !== 'object') throw new Error(`GitHub answered ${r?.status} for ${path}`);
  return r.json;
}

async function pages(gh, path) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await read(gh, `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(j)) throw new Error(`${path} is not a list`);
    out.push(...j);
    if (j.length < 100) return out;
  }
  throw new Error(`${path} has more than ${MAX_PAGES * 100} entries`);
}

const validPr = (pr) => Number.isSafeInteger(pr) && pr > 0;

export async function requestReview({ gh, owner, repo, pr, githubId }) {
  try {
    if (!validPr(pr)) return fail('bad pull request number');
    const u = await read(gh, `/user/${githubId}`);
    if (u.id !== githubId || u.type !== 'User' || typeof u.login !== 'string' || !u.login) return fail('the owner\'s GitHub account is not a user account');
    const base = `/repos/${owner}/${repo}`;
    const r = await gh.post(`${base}/pulls/${pr}/requested_reviewers`, { reviewers: [u.login] });
    if (r?.status !== 201 && r?.status !== 200) return fail(`GitHub answered ${r?.status} to the review request`);
    // The raised time is GitHub's own record of the request (round 1 M4): the latest review_requested for the owner.
    const events = await pages(gh, `${base}/issues/${pr}/timeline`);
    const asked = events.filter((e) => e?.event === 'review_requested' && e.requested_reviewer?.id === githubId && ms(e.created_at) !== null);
    if (!asked.length) return fail('GitHub shows no review request for the owner');
    const at = asked.map((e) => ms(e.created_at)).sort((a, b) => a - b).at(-1);
    return { ok: true, raised_at: new Date(at).toISOString() };
  } catch (e) {
    return fail(`could not ask for the review: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

export async function ownerVerdict({ gh, owner, repo, pr, githubId, raisedAt }) {
  try {
    if (!validPr(pr)) return fail('bad pull request number');
    const raised = ms(raisedAt);
    if (raised === null) return fail('the ask has no raised time');
    const base = `/repos/${owner}/${repo}`;
    const p = await read(gh, `${base}/pulls/${pr}`);
    const head = p.head?.sha;
    if (typeof head !== 'string' || !SHA.test(head)) return fail('the pull request has no head commit');
    if (p.state !== 'open' || p.merged) return fail(`the pull request is ${p.merged ? 'merged' : p.state}`);
    const all = await pages(gh, `${base}/pulls/${pr}/reviews`);
    const own = all.filter((r) => r?.user?.id === githubId);
    if (own.some((r) => r.user.type !== 'User')) return fail('a review under the owner\'s id is not from a user account');
    const submitted = own.filter((r) => ms(r.submitted_at) !== null);
    if (submitted.some((r) => r.performed_via_github_app !== null && r.performed_via_github_app !== undefined)) return fail('a review of the owner\'s was made through an app');
    const order = (a, b) => ms(a.submitted_at) - ms(b.submitted_at) || a.id - b.id;
    const after = submitted.filter((r) => ms(r.submitted_at) >= raised).sort(order);
    const decisive = after.filter((r) => r.state !== 'COMMENTED').at(-1);
    if (!decisive) {
      const before = submitted.some((r) => r.state === 'APPROVED' && ms(r.submitted_at) < raised);
      return { ok: true, verdict: 'none', head, ...(before ? { line: APPROVE_AGAIN_LINE } : {}) };
    }
    const review = { id: decisive.id, state: decisive.state, commit_id: decisive.commit_id, submitted_at: decisive.submitted_at, body: typeof decisive.body === 'string' ? decisive.body : '' };
    if (decisive.state === 'APPROVED') {
      // A "Request changes" from any account after the owner's Approve refuses (round 1 M4 item 5; fail closed). Another
      // account's dismissed review counts as one: a dismissal can't revive the Approve (audit round 2 m-1).
      const after = all.filter((r) => (r?.state === 'CHANGES_REQUESTED' || (r?.state === 'DISMISSED' && r.user?.id !== githubId)) && r.id !== decisive.id && ms(r.submitted_at) !== null && ms(r.submitted_at) >= ms(decisive.submitted_at));
      if (after.length) return { ok: true, verdict: 'none', blocked: 'changes were requested after the owner\'s Approve', review, head };
      return { ok: true, verdict: 'approved', review, head };
    }
    if (decisive.state === 'CHANGES_REQUESTED') return { ok: true, verdict: 'changes_requested', review, head };
    return { ok: true, verdict: 'none', review, head };
  } catch (e) {
    return fail(`could not read the reviews: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// The commits after `from` up to `to`, oldest first, by first parent (round 2 m2-4); null if `from` isn't reached.
async function firstParentsBetween(view, from, to) {
  const out = [];
  let c = to;
  while (c !== from) {
    if (out.length >= MAX_BETWEEN) return null;
    out.unshift(c);
    const commit = await view.commit(c);
    if (!commit.parents.length) return null;
    c = commit.parents[0];
  }
  return out;
}

export async function countApprove({ gh, view, owner, repo, pr, githubId, raisedAt, catchUps = [] }) {
  const v = await ownerVerdict({ gh, owner, repo, pr, githubId, raisedAt });
  if (!v.ok) return v;
  if (v.verdict !== 'approved') return fail(v.blocked ?? (v.verdict === 'changes_requested' ? 'the owner asked for changes' : 'no Approve from the owner since the ask was raised'), v.line ? { line: v.line } : {});
  const H0 = v.review.commit_id; const H1 = v.head;
  if (typeof H0 !== 'string' || !SHA.test(H0)) return fail('the Approve names no commit');
  if (H0 === H1) return { ok: true, head: H1, review: v.review, carried: false };
  try {
    const main = await read(gh, `/repos/${owner}/${repo}/git/ref/heads/main`);
    const tip = main.object?.sha;
    if (!SHA.test(tip ?? '')) return fail('main has no commit');
    const [c0, c1] = await Promise.all([view.compare(tip, H0), view.compare(tip, H1)]);
    const between = await firstParentsBetween(view, H0, H1);
    if (!between) return fail('the approved commit is not on the pull request\'s first-parent history');
    const r = await carryOver({ reviewed: { base: c0.mergeBase, head: H0 }, current: { base: c1.mergeBase, head: H1 }, between, catchUps, tier1MergesSince: 0, gh: view });
    if (!r.review) return fail(`the Approve was on an older commit and does not carry over: ${r.reasons.join('; ')}`);
    return { ok: true, head: H1, review: v.review, carried: true };
  } catch (e) {
    return fail(`could not check the Approve carries over: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
