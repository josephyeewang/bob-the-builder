// A proposal's way through at the first cutover (R-0b-128 part 2; lead call L325). The intake (proposals-intake.mjs)
// asks docsCheck whether a proposal's change is the docs lane's; anything else stays with MAIN, who merges code by hand.
//
// The list of files is the push script's own, read from the bytes the intake holds (L77 m1), never one a proposal
// declares. The answer is M10's, the same rule the merge gate asks at merge, so the two can't disagree on what a docs
// change is.
//
// Only a real answer about the change is final (L597 (2)). Anything that may pass by itself is a wait: the look could
// not finish, the card could not be read this once, the bytes moved during the check, or M10 refused for a reason that
// is not the change (a pause, an hours window, its own error). The intake keeps the file and tells Joe once, then daily.
//
//   createDocsCheck({ record, rules, pushProposal }) -> docsCheck({ product, card, bundle })
//     null                 the change is the docs lane's
//     'why'                it is not: MAIN merges it by hand (FIRST_CUTOVER at the intake)
//     { refuse: 'why' }    the push script's look refused the bundle for good (it touches a file no card may, say)
//     { retry: 'why' }     nothing final could be said this pass: the file waits

import { plainError } from '../M4-workshop/git/push.mjs';

// The start of M10's one answer that is about the change itself (engine.mjs mergeDocsLane). Any other deny is about the
// product or the rules at this moment, and passes by itself.
export const NOT_THIS_LANE = 'not this lane\'s change';
// M10's docs-lane check says these when its rules can't be read or name no lane (lane-check.mjs docsLaneProblem): a
// rules fault worded as an answer about the change. Fixed in the rules, the same bytes pass, so each is a wait (L669).
const LANE_RULES_FAULTS = [/^could not be read \(/, /^no readable rules$/, /^the rules name no docs or research lane$/];
const LANE_PREFIX = `${NOT_THIS_LANE}; MAIN merges it as today: `;

export function createDocsCheck({ record, rules, pushProposal }) {
  return async function docsCheck({ product, card, bundle }) {
    const seen = await pushProposal({ product, card }, { look: true });
    if (!seen.ok) return seen.retry ? { retry: seen.reason } : { refuse: seen.reason };
    // The look read the fact again: bytes that changed since this pass checked them are for the next pass to judge.
    if (seen.sha256 !== bundle?.sha256) return { retry: 'the bundle held changed while it was checked' };
    let c;
    try { c = record.read('card', card); } catch (e) { return { retry: `card ${card} could not be read (${plainError(e?.message ?? e)})` }; }
    if (!c?.doc || c.corrupt) return { retry: `card ${card} could not be read` };
    const d = rules.may('merge', { product, card: { id: card, ...c.doc }, truncated: false, labels: [], declared_tier: c.doc.tier, kind: c.doc.kind, files: seen.files });
    if (d.decision === 'allow') return null;
    // An ask is about the change too (a deep check that wants a person): it is not the docs lane's.
    const reason = String(d.reason);
    if (reason.startsWith(LANE_PREFIX) && LANE_RULES_FAULTS.some((re) => re.test(reason.slice(LANE_PREFIX.length)))) return { retry: `the rules could not say: ${plainError(reason.slice(LANE_PREFIX.length))}` };
    if (d.decision === 'ask' || reason.startsWith(NOT_THIS_LANE)) return reason;
    return { retry: `the rules said no for now: ${plainError(reason)}` };
  };
}
