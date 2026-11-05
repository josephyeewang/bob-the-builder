// A proposal's way through at the first cutover (R-0b-128 part 2; lead call L325). The intake (proposals-intake.mjs)
// asks docsCheck whether a proposal's change is the docs lane's; anything else stays with MAIN, who merges code by hand.
//
// The list of files is the push script's own, read from the bytes the intake holds (L77 m1), never one a proposal
// declares. The answer is M10's, the same rule the merge gate asks at merge, so the two can't disagree on what a docs
// change is.
//
//   createDocsCheck({ record, rules, pushProposal }) -> docsCheck({ product, card, bundle })
//     null                 the change is the docs lane's
//     'why'                it is not, or the look refused it for good
//     { retry: 'why' }     the look could not finish (GitHub, the mirror, the robot key): the file waits

export function createDocsCheck({ record, rules, pushProposal }) {
  return async function docsCheck({ product, card, bundle }) {
    const seen = await pushProposal({ product, card }, { look: true });
    if (!seen.ok) return seen.retry ? { retry: seen.reason } : seen.reason;
    // The look read the fact again: bytes that changed since this pass checked them are for the next pass to judge.
    if (seen.sha256 !== bundle?.sha256) return 'the bundle held is not the one this pass checked';
    const c = record.read('card', card);
    if (!c?.doc || c.corrupt) return `card ${card} could not be read`;
    const d = rules.may('merge', { product, card: { id: card, ...c.doc }, truncated: false, labels: [], declared_tier: c.doc.tier, kind: c.doc.kind, files: seen.files });
    return d.decision === 'allow' ? null : d.reason;
  };
}
