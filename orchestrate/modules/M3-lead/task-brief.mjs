// A card's task brief (R-0b-142, R-0b-143): what the Lead writes for each card, the one text a worker starts from.
//
// A brief says what the card is for, how anyone will know it is done, which files it is expected to touch, and what is
// left out. A card that waits says on whom (FIRST-RUNBOOK-notes item (b)): `wait.who` takes only the values pinned in
// shared/record.mjs WAIT_WHO, the same list the Store Writer checks, so an unknown value is refused here before it is
// ever written. `date` also needs a reason.

import { WAIT_FIELDS, WAIT_WHO } from '../../shared/record.mjs';

const SECTIONS = Object.freeze([['goal', 'Goal'], ['done_when', 'Done when'], ['files', 'Files it is expected to touch'], ['not_in_scope', 'Not in scope']]);
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/** Problems with a predicted file list: each a plain path inside the product, not a folder or a pattern. */
export function filesProblems(files) {
  if (!Array.isArray(files) || !files.length) return ['the predicted file list is empty'];
  const out = [];
  for (const f of files) {
    if (!text(f) || f.startsWith('/') || f.endsWith('/') || /(^|\/)\.\.(\/|$)/.test(f) || /[*?\n]/.test(f)) out.push(`"${f}" is not a plain path inside the product`);
  }
  if (new Set(files).size !== files.length) out.push('a file is listed twice');
  return out;
}

/** Problems with a wait: every field there, and `who` one of the pinned values. */
export function waitProblems(wait) {
  if (!wait || typeof wait !== 'object') return ['a wait must be an object'];
  const out = WAIT_FIELDS.filter((f) => !text(wait[f])).map((f) => `the wait has no ${f}`);
  if (!WAIT_WHO.includes(wait.who)) out.push(`wait.who must be one of ${WAIT_WHO.join(', ')}, not "${wait.who}"`);
  if (wait.who === 'date' && !text(wait.reason)) out.push('a wait on a date needs a reason');
  return out;
}

/** → [] when the brief is complete. */
export function briefProblems(b) {
  if (!b || typeof b !== 'object') return ['no brief'];
  const out = SECTIONS.filter(([k]) => k !== 'files' && !text(b[k])).map(([, h]) => `the brief has no "${h}"`);
  out.push(...filesProblems(b.files));
  if (b.wait !== undefined) out.push(...waitProblems(b.wait));
  return out;
}

/** The brief as the worker reads it. Throws on an incomplete brief, so a half brief is never handed out. */
export function briefText(card, b) {
  const p = briefProblems(b);
  if (p.length) throw new Error(`card ${card}: ${p.join('; ')}`);
  const body = SECTIONS.map(([k, h]) => `## ${h}\n${k === 'files' ? b.files.map((f) => `- ${f}`).join('\n') : b[k].trim()}`);
  if (b.wait) body.push(`## Waiting on\n${b.wait.who}: ${b.wait.what} (since ${b.wait.since}; next check ${b.wait.next_check}${b.wait.reason ? `; ${b.wait.reason}` : ''})`);
  return `# Card ${card}\n\n${body.join('\n\n')}\n`;
}
