// The verdict file (R-0b-144, L65): what a review session writes into its own folder in review's outbox, the one file
// the Merge Gate reads (refusal 5, through M9 `sessionVerdict` and `verdictFields`). Line 1 is a JSON header naming
// the card and the head reviewed; the rest is the session's notes, for people. Built here and checked with M9's own
// reading, so the format the reviewer is told is the format the gate counts (one definition: M9 verdictFields).

import { verdictFields } from '../M9-record/outbox.mjs';
import { SESSION_ID, VERDICT_CHECKLIST, CHECKLIST_LEVELS } from '../../shared/record.mjs';

export const REVIEW_ROLES_HERE = Object.freeze(['reviewer', 'auditor']);

/** The file's one name in the session's folder; a second verdict file there means none counts. */
export function verdictFileName(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('not a session id');
  return `verdict-${sessionId}.md`;
}

/**
 * The file's text. A reviewer says the four checklist lines, an auditor its Material count; both say pass true or
 * false. Throws when M9 would refuse the header, so nothing writes a verdict the gate can't count.
 */
export function verdictFileText({ role, card, head, pass, checklist, material, notes = '' }) {
  if (!REVIEW_ROLES_HERE.includes(role)) throw new Error(`${role} is not a review role`);
  const fields = { head, pass, ...(role === 'reviewer' ? { checklist } : { material }) };
  const header = { entity: 'verdict', card, expectRev: 0, fields };
  const v = verdictFields(header);
  if (!v.ok) throw new Error(`not a verdict the gate can count: ${v.reason}`);
  return `${JSON.stringify(header)}\n${String(notes).trim()}\n`;
}

/** The format as the reviewer's prompt states it: an example header line for this card and head, and the rules. */
export function verdictFormat({ role, card, head }) {
  const example = role === 'reviewer'
    ? { entity: 'verdict', card, expectRev: 0, fields: { head, pass: true, checklist: Object.fromEntries(VERDICT_CHECKLIST.map((k) => [k, 'clean'])) } }
    : { entity: 'verdict', card, expectRev: 0, fields: { head, pass: true, material: 0 } };
  const say = role === 'reviewer'
    ? `"checklist" has exactly the four lines ${VERDICT_CHECKLIST.join(', ')}, each one of ${CHECKLIST_LEVELS.join(', ')}. pass is true only when no line is material.`
    : '"material" is the whole number of Material findings. pass is true only when it is 0.';
  return [
    `Line 1 is this JSON on one line, with your own values; nothing else may be added to it:`,
    JSON.stringify(example),
    say,
    `"head" stays exactly ${head}: a verdict for any other commit is not counted. From line 2 on, write your findings for people, worst first.`,
  ].join('\n');
}
