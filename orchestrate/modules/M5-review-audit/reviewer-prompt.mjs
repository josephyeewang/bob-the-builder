// The reviewer's prompt (R-0b-144): what a review session is told, built from the package and the verdict format.
// Its three rules are Bob's Rule 25(f), put for a reviewer: the three small rules that keep "clean" honest.

import { verdictFileName, verdictFormat } from './verdict-file.mjs';

export const REVIEW_RULES = Object.freeze([
  'A review with no findings is suspect. Before you write that there are none, look again from a different angle (another lens, the user\'s view, only the output) and say in your notes which angle you used.',
  'Your verdict covers exactly the commit named below and only what you read. Say what you did not read; never pass a change on what it says it does.',
  'Done is the effect you saw, not the claim. Run the change\'s tests and checks yourself and judge what they show; a passing check proves only what it checks.',
]);

const ROLE_JOB = {
  reviewer: 'You review one change for the Merge Gate: is it correct, well built, does it work for its user, does it hold up.',
  auditor: 'You audit one change that touches numbers people act on (Tier 1): count every Material finding, one that would change a displayed number, a decision or data completeness.',
};

/** → the prompt text. `pkg` is reviewPackage's answer; `earlier` is the runner's block of notes from earlier rounds. */
export function reviewerPrompt({ role, card, head, sessionId, outbox, pkg, earlier = '' }) {
  if (!ROLE_JOB[role]) throw new Error(`${role} has no review prompt`);
  if (!pkg?.ok || pkg.head !== head) throw new Error('the review package is not for this head');
  const files = pkg.files.map((f) => `  ${f.status} ${f.path}`).join('\n') || '  (none)';
  return [
    `${ROLE_JOB[role]}`,
    `Card ${card}, head ${head}. Your working folder holds that commit; main is beside it as refs/heads/main.`,
    `The change runs from ${pkg.base} (where it left main) to the head. It touches ${pkg.files.length} file(s):\n${files}`,
    `The whole diff is in ${pkg.diffFile} (${pkg.diffBytes} bytes). Read it, and read the files around it.`,
    `Three rules:\n${REVIEW_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
    `Hand in your verdict as one file, ${outbox}/${verdictFileName(sessionId)}, written once. Any other file there named verdict- means none counts.`,
    verdictFormat({ role, card, head }),
    earlier,
  ].filter(Boolean).join('\n\n');
}
