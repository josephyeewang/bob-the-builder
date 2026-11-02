// approval.mjs — the one answer to "does this recorded answer count as the owner's approval?" (LEAD-CALLS L81).
//
// WHY. M10's count_approval reads top-level `ask_kind`, `channel`, `tier` and `risky`, and answers "ask" at the tier
// the channel means (github_review → 1, tap → 2); anything else is a deny. Each caller once built that question by
// hand, and two built it in a shape M10 never reads, so the real engine denied every one. Every caller now asks here:
// M2 when it records an answer (binding.mjs, decision.mjs, schedule.mjs), M11 before it acts on one (undo.mjs,
// cleanup.mjs).
//
//   answerCounts(rules, ask, { product?, approves? }) → { ok: true, tier, verdict } | { ok: false, reason, verdict? }
//     ask       the ask's doc WITH its answer: { kind, card, tier, risky, product, answer: { channel, approves, … } }.
//               M2 passes the answer it is about to write; M11 the one the Record holds.
//     product   defaults to the ask's own `product`.
//     approves  true: the answer must also approve (`answer.approves === true`), as an Undo or a delete needs.
//   countSubject(ask, product) → the exact subject count_approval reads (exported for tests and for the sweep).
//
// The channel is read from `answer.channel` only: no other field names it (no top-level `via`).

export const CHANNEL_TIER = Object.freeze({ github_review: 1, tap: 2 });

const text = (e) => { try { return String(e?.message ?? e); } catch { return 'unreadable error'; } };

export function countSubject(ask, product = ask?.product) {
  return { product, card: ask?.card ?? null, ask_kind: ask?.kind, channel: ask?.answer?.channel, tier: ask?.tier ?? null, risky: ask?.risky ?? [] };
}

export function answerCounts(rules, ask, { product = ask?.product, approves = false } = {}) {
  const answer = ask?.answer;
  if (!answer || typeof answer !== 'object') return { ok: false, reason: 'the ask has no recorded answer' };
  const channel = answer.channel;
  if (typeof channel !== 'string' || !Object.hasOwn(CHANNEL_TIER, channel)) return { ok: false, reason: `the answer names no channel the rules know (${JSON.stringify(channel ?? null)})` };
  if (approves && answer.approves !== true) return { ok: false, reason: 'the answer does not approve' };
  let verdict;
  try { verdict = rules.may('count_approval', countSubject(ask, product)); } catch (e) { return { ok: false, reason: `the rules could not be asked (${text(e)})` }; }
  const tier = CHANNEL_TIER[channel];
  if (verdict?.decision !== 'ask' || verdict.tier !== tier) return { ok: false, reason: verdict?.reason ?? 'the rules gave no answer', verdict };
  return { ok: true, tier, verdict };
}
