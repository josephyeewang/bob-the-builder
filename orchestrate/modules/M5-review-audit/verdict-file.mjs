// The verdict file (R-0b-144, L65): what a review session writes into its own folder in review's outbox, the one file
// the Merge Gate reads (refusal 5, through M9 `sessionVerdict` and `verdictFields`). It is one line of JSON naming the
// card and the head reviewed. Its findings go in `fields.notes`, a list: the runner hands a failing verdict's notes to
// the next round's prompt (review-runner.mjs `earlier`), and the finding-checker reads them (R-0b-145). Built here and
// checked with M9's own reading, so the format the reviewer is told is the format the gate counts (M9 verdictFields).

import { verdictFields } from '../M9-record/outbox.mjs';
import { SESSION_ID, VERDICT_CHECKLIST, CHECKLIST_LEVELS } from '../../shared/record.mjs';

export const REVIEW_ROLES_HERE = Object.freeze(['reviewer', 'auditor']);
export const FINDING_LEVELS = Object.freeze(['material', 'minor', 'cosmetic']);

/** The file's one name in the session's folder; a second verdict file there means none counts. */
export function verdictFileName(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('not a session id');
  return `verdict-${sessionId}.md`;
}

/** A finding: { level, says, file?, line?, quote?, on? (a reviewer's checklist line) }. → reason | null */
export function findingProblem(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'a finding is an object';
  if (!FINDING_LEVELS.includes(f.level)) return `a finding's level is one of ${FINDING_LEVELS.join(', ')}`;
  if (typeof f.says !== 'string' || !f.says.trim()) return 'a finding says what is wrong';
  if (f.file !== undefined && (typeof f.file !== 'string' || !f.file || f.file.startsWith('/') || f.file.split('/').includes('..'))) return 'a finding\'s file is a path inside the change';
  if (f.line !== undefined && !(Number.isInteger(f.line) && f.line > 0)) return 'a finding\'s line is a whole number from 1';
  if (f.quote !== undefined && (typeof f.quote !== 'string' || !f.quote.trim())) return 'a finding\'s quote is text from the file';
  if (f.on !== undefined && !VERDICT_CHECKLIST.includes(f.on)) return `a finding is on one of ${VERDICT_CHECKLIST.join(', ')}`;
  return null;
}

/**
 * The file's text. A reviewer says the four checklist lines, an auditor its Material count; both say pass true or
 * false, and list their findings. Throws when M9 would refuse the header, so nothing writes a verdict the gate can't count.
 */
export function verdictFileText({ role, card, head, pass, checklist, material, findings = [] }) {
  if (!REVIEW_ROLES_HERE.includes(role)) throw new Error(`${role} is not a review role`);
  if (!Array.isArray(findings)) throw new Error('findings are a list');
  for (const f of findings) { const p = findingProblem(f); if (p) throw new Error(p); }
  const fields = { head, pass, ...(role === 'reviewer' ? { checklist } : { material }), notes: findings };
  const header = { entity: 'verdict', card, expectRev: 0, fields };
  const v = verdictFields(header);
  if (!v.ok) throw new Error(`not a verdict the gate can count: ${v.reason}`);
  return `${JSON.stringify(header)}\n`;
}

/**
 * The format as the reviewer's prompt states it: an example line for this card and head, and the rules. The example
 * only shows the shape (audit R-0b-147 minor 4): it fails, with one made-up finding, so a session that copies it as it
 * is hands in a fail, never a pass it did not judge.
 */
export function verdictFormat({ role, card, head }) {
  const finding = { level: 'material', says: 'what is wrong, and why it matters', file: 'path/in/the/change', line: 12, quote: 'the exact text on that line', ...(role === 'reviewer' ? { on: 'correct' } : {}) };
  const example = role === 'reviewer'
    ? { entity: 'verdict', card, expectRev: 0, fields: { head, pass: false, checklist: Object.fromEntries(VERDICT_CHECKLIST.map((k) => [k, k === 'correct' ? 'material' : 'clean'])), notes: [finding] } }
    : { entity: 'verdict', card, expectRev: 0, fields: { head, pass: false, material: 1, notes: [finding] } };
  const say = role === 'reviewer'
    ? `"checklist" has exactly the four lines ${VERDICT_CHECKLIST.join(', ')}, each one of ${CHECKLIST_LEVELS.join(', ')}. pass is true only when no line is material.`
    : '"material" is the whole number of Material findings. pass is true only when it is 0.';
  return [
    'The file is JSON on one line, shaped like the example below, with your own values; nothing else may be added to it. The example only shows the shape: its pass, checklist and finding are made up, not a judgment of this change.',
    JSON.stringify(example),
    say,
    `"notes" lists every finding, worst first, each like ${JSON.stringify(finding)}. level is one of ${FINDING_LEVELS.join(', ')}.${role === 'reviewer' ? ' "on" is the checklist line it is about.' : ''} Name the file, line and an exact quote wherever you can: a finding whose file, line or quote is not in the change is dropped as noise.`,
    `"head" stays exactly ${head}: a verdict for any other commit is not counted.`,
  ].join('\n');
}
