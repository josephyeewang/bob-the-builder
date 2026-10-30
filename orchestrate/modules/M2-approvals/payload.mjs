// payload.mjs — the exact question box M2 asks the owner, written on the ask when it is created (0b-5 spec review round 2
// M2-1, round 3 m3-5, round 5 M5-3, M5-5).
//
// WHY. A tap counts only on a box M2 itself worded. An AI session reads the payload from the record and passes it to
// AskUserQuestion unchanged; M2 binds the box only if its input canonicalises to exactly this payload. A paraphrase, a
// second question, an extra or reordered option binds nothing. Two versions are written at creation, the plain one and
// one with the fixed "Still open" line first; either binds, and M2 never rewrites them (M5-3).
//
//   renderPayload({ askId, kind, card, title, choices, fingerprint, files }) → { ok, payload, payload_sha256,
//     payload_still_open, payload_still_open_sha256 } | { ok: false, reason }
//   payloadSha(input) → sha256 of the canonical JSON of a box's input (or null if it can't be made canonical)
//   askIdOf(questionText) → the ask id a question names, or null
//
// The shape is AskUserQuestion's input: { questions: [{ question, header, options: [{ label, description }], multiSelect }] }.
// The question's first line is `[ask <id>] <card in plain words> (<card id>)`; a go adds the plan's first 12 hex; a Tier-2
// go lists its files itself (m3-5), so the list the owner reads is the list the go binds.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/plan-fingerprint.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { STILL_OPEN_LINE } from './kinds.mjs';

const ID = /^[A-Za-z0-9._-]{1,200}$/;
const HEADERS = { go_t2: 'Go', tap_yes_no: 'Yes or no', undo: 'Undo', incident_repair: 'Repair', back_to_active: 'Active' };
const MAX_FILES_SHOWN = 200;

export function payloadSha(input) {
  try { return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex'); } catch { return null; }
}

export function askIdOf(question) {
  const m = typeof question === 'string' ? /^(?:Still open: [^\n]*\n)?\[ask ([A-Za-z0-9._-]{1,200})\]/.exec(question) : null;
  return m ? m[1] : null;
}

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

export function renderPayload({ askId, kind, card, title, choices, fingerprint, files } = {}) {
  const k = activeKind(kind);
  if (!k) return { ok: false, reason: `unknown or inactive ask kind "${kind}"` };
  if (k.channel !== 'tap') return { ok: false, reason: `a ${kind} ask is answered on GitHub, not in a question box` };
  if (typeof askId !== 'string' || !ID.test(askId)) return { ok: false, reason: 'bad ask id' };
  if (typeof card !== 'string' || !ID.test(card)) return { ok: false, reason: 'a question box names its card' };
  if (typeof title !== 'string' || !oneLine(title)) return { ok: false, reason: 'a question box names its card in plain words' };
  const labels = choices ?? k.choices;
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 4 || new Set(labels).size !== labels.length
    || !labels.every((l) => typeof l === 'string' && l.trim() === l && l)) return { ok: false, reason: 'a box has 2 to 4 distinct choices' };
  let question = `[ask ${askId}] ${oneLine(title)} (${card})`;
  const options = labels.map((label) => ({ label, description: '' }));
  if (k.go) {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return { ok: false, reason: 'a go names its plan fingerprint' };
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES_SHOWN || !files.every((f) => typeof f === 'string' && f)) return { ok: false, reason: `a go lists its files (1 to ${MAX_FILES_SHOWN})` };
    question += ` — plan ${fingerprint.slice(0, 12)}`;
    options[0].description = `Files: ${files.join(', ')}`;
  }
  const payload = { questions: [{ question, header: HEADERS[kind], options, multiSelect: false }] };
  const stillOpen = { questions: [{ ...payload.questions[0], question: `${STILL_OPEN_LINE}\n${question}` }] };
  const a = payloadSha(payload); const b = payloadSha(stillOpen);
  if (!a || !b) return { ok: false, reason: 'payload could not be made canonical' };
  return { ok: true, payload, payload_sha256: a, payload_still_open: stillOpen, payload_still_open_sha256: b };
}
