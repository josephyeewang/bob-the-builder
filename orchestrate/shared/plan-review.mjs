// plan-review.mjs — the one shape of a fresh plan reviewer's pass, which a Tier-1 go needs (L87, from the R-0b-142/143
// audit M-4; L80 (3); L84).
//
// WHY. M3's plan reviewer answers in words: PASS, or one numbered question. It never names a card, a fingerprint or a
// session, and it must not: those come from places the reviewer can't write. The card and fingerprint come from the plan
// inputs (M13 goFingerprint); the two sessions come from the launch records. M2 counts a Tier-1 go only with a pass in
// this shape. Builder and checker live here together, so M3, the wiring (R-0b-162) and M2 can't disagree.
//
//   planPass(review, { card, fingerprint, plan_sha256, reviewer_session, author_session })
//     review: what M3's readPlanReview returned for this card's plan, { ok, pass, ... }.
//     → { ok: true, pass: { pass: true, material: 0, card, fingerprint, plan_sha256, reviewer_session, author_session } }
//     | { ok: false, reason }
//   planCheckProblem(check, { card, fingerprint, planSha256 }) → null when the pass counts for this go, else the reason.
//
// PASS means 0 Material: the reviewer's wording allows PASS only with nothing Material left, so `material` is 0 exactly
// when the reviewer passed. One review covers one card's plan; a plan with several cards gets one review per card.

const SHA256 = /^[0-9a-f]{64}$/;
const text = (v) => typeof v === 'string' && v.length > 0;

export function planCheckProblem(check, { fingerprint, card, planSha256 } = {}) {
  if (!check || typeof check !== 'object') return 'a Tier-1 go needs a fresh plan reviewer\'s pass first';
  if (check.pass !== true || check.material !== 0) return 'the plan reviewer has not passed the plan with 0 Material';
  if (!text(card) || check.card !== card) return 'the plan reviewer passed another card\'s plan';
  if (!SHA256.test(String(check.fingerprint ?? '')) || check.fingerprint !== fingerprint
    || !SHA256.test(String(check.plan_sha256 ?? '')) || check.plan_sha256 !== planSha256) return 'the plan or its file list changed after review';
  const rev = check.reviewer_session; const by = check.author_session;
  if (!text(rev) || !text(by)) return 'the plan check names its reviewer and the plan\'s author';
  if (rev === by) return 'the plan was checked by the session that wrote it; a fresh reviewer must check it';
  return null;
}

export function planPass(review, { card, fingerprint, plan_sha256: planSha256, reviewer_session: rev, author_session: by } = {}) {
  if (!review || review.ok !== true) return { ok: false, reason: 'the plan reviewer\'s answer could not be read' };
  if (review.pass !== true) return { ok: false, reason: 'the plan reviewer asked a question; the plan has not passed' };
  const pass = { pass: true, material: 0, card, fingerprint, plan_sha256: planSha256, reviewer_session: rev, author_session: by };
  const bad = planCheckProblem(pass, { card, fingerprint, planSha256 });
  return bad ? { ok: false, reason: bad } : { ok: true, pass };
}
