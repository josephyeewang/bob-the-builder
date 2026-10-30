// outbox.mjs — the three files the Front Door may leave in its outbox, and the check intake runs on each
// (R-0b-81; review-0b-8 MAT-6, MAT-7, minors 4, 5 and 7).
//
// The Front Door has no shell: the skill writes these files with its Write tool, in exactly the shapes below.
// Intake (lane 1/2's R-0b-56, after lane 2's readOutboxFile has checked the name, owner and links) calls
// checkOutboxFile on the text and refuses anything else. The three schemas are a join item with lanes 1 and 2.
//
//   state-<id>.json    { "product": "<name>", "state": "paused" | "away", "until": "<ISO date>" | null, "tz": "<IANA>" | null }
//                      Never "active": only Joe's tap returns a product to active (MAT-7). `until` is information and a
//                      return reminder; nothing goes back to active on a date. A tz that is not a valid IANA name
//                      becomes null, which holds number work (MAT-8, minor 10).
//   request-<what>-<id>.json   { "request": "resume" | "wrapup" | "rotate", "product": "<name>" | null, "name": "<KEY_NAME>" | null }
//                      rotate carries the key's NAME only; any text that looks like a key refuses the whole file (B11).
//   request-airhealth-<id>.json  { "request": "airhealth", "product": null, "name": null, "red_count": <0-999> }
//                      the red count Joe read off /configaudit on the Air; the Ledger turns it into the dated air-health
//                      fact (trip.mjs airFactFromRequest; 0b-8 audit round 3 M-4).
//   idea-<id>.md       the idea exactly as Joe said it, quoted ("> " on every line), masked; never acted on as an
//                      instruction. Intake hands the quoted text on through cleanOutside (source "idea-file").

import { makeMasker } from '../M12-sensors/mask.mjs';
import { checkTimeZone } from './timezone.mjs';

export const FRONT_DOOR_KINDS = Object.freeze(['request', 'state', 'idea']);
export const STATES_ALLOWED = Object.freeze(['paused', 'away']);
export const REQUESTS = Object.freeze(['resume', 'wrapup', 'rotate', 'airhealth']);
// The id the skill writes: date, time, two letters (20261103-0915-kq). Nothing longer fits, so a key can't ride in a file
// name into the record's diary (0b-8 audit round 3 M-2).
export const OUTBOX_ID = /^\d{8}-\d{4}-[a-z]{2}$/;
const ID = OUTBOX_ID;
const PRODUCT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// A key's NAME: capitals with an underscore (STRIPE_KEY), never a key-ID shape (round 2 minor 6: AKIA…).
const KEY_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]{1,62}$/;
const KEY_ID = /^(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{12,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const refuse = (reason) => ({ ok: false, reason });
const { maskSecrets } = makeMasker();

export function stateDoc({ product, state, until = null, tz = null }) {
  if (!PRODUCT.test(String(product ?? ''))) return refuse('no valid product name');
  if (!STATES_ALLOWED.includes(state)) return refuse(`the Front Door may set only ${STATES_ALLOWED.join(' or ')}`); // the value is never echoed: it may hold pasted text
  if (until !== null && !(ISO_DATE.test(String(until)) && Number.isFinite(Date.parse(until)))) return refuse('until is not a date');
  const z = tz === null ? { ok: true, tz: null } : checkTimeZone(tz);
  return { ok: true, doc: { product, state, until, tz: z.ok ? z.tz : null }, ...(z.ok ? {} : { note: `time zone not accepted (${z.reason}); number work holds until Joe names a city-based zone` }) };
}

export function requestDoc({ request, product = null, name = null, red_count: redCount }) {
  if (!REQUESTS.includes(request)) return refuse(`unknown request (allowed: ${REQUESTS.join(', ')})`);
  if (product !== null && !PRODUCT.test(String(product))) return refuse('no valid product name');
  if (request === 'rotate' && (!KEY_NAME.test(String(name ?? '')) || KEY_ID.test(String(name)))) return refuse('rotate needs the key\'s name only (capitals, digits, _)');
  if (request !== 'rotate' && name !== null) return refuse('only rotate carries a name');
  if (request === 'airhealth') {
    if (product !== null) return refuse('airhealth carries no product');
    if (!(Number.isInteger(redCount) && redCount >= 0 && redCount <= 999)) return refuse('airhealth needs red_count, a whole number 0 to 999');
    return { ok: true, doc: { request, product, name, red_count: redCount } };
  }
  if (redCount !== undefined) return refuse('only airhealth carries red_count');
  return { ok: true, doc: { request, product, name } };
}

export function ideaText(text) {
  const masked = maskSecrets(String(text ?? '')).text.replace(/\r\n?/g, '\n');
  return `${masked.split('\n').map((l) => `> ${l}`).join('\n')}\n`;
}

// The file the skill writes, as code would write it (used by tests and by any script that files on its behalf).
export function outboxFile(kind, id, input) {
  if (!FRONT_DOOR_KINDS.includes(kind)) return refuse(`not a Front Door outbox kind (allowed: ${FRONT_DOOR_KINDS.join(', ')})`);
  if (!ID.test(String(id))) return refuse('bad id');
  if (kind === 'idea') return { ok: true, name: `idea-${id}.md`, text: ideaText(input) };
  const r = kind === 'state' ? stateDoc(input) : requestDoc(input);
  if (!r.ok) return r;
  const name = kind === 'state' ? `state-${id}.json` : `request-${r.doc.request}-${id}.json`;
  return { ok: true, name, text: `${JSON.stringify(r.doc)}\n`, ...(r.note ? { note: r.note } : {}) };
}

// Intake's check of one file the Front Door left. Returns the normalized doc, or a refusal.
export function checkOutboxFile(name, text) {
  const m = /^(request|state|idea)-(?:(resume|wrapup|rotate|airhealth)-)?(\d{8}-\d{4}-[a-z]{2})\.(json|md)$/.exec(String(name));
  if (!m || maskSecrets(String(name)).text !== String(name)) return refuse('not a Front Door outbox file name');
  const [, kind, , , ext] = m;
  if (kind === 'idea') {
    if (ext !== 'md') return refuse('an idea is a .md file');
    if (!String(text).split('\n').filter((l) => l !== '').every((l) => l === '>' || l.startsWith('> '))) return refuse('idea text must be quoted on every line');
    return { ok: true, kind, doc: { quoted: maskSecrets(String(text)).text } };
  }
  if (ext !== 'json') return refuse(`a ${kind} file is .json`);
  // The skill never writes an escape; one can hide a key from the text check below (0b-8 audit round 2 M-2).
  if (/\\u/i.test(String(text))) return refuse('the file holds an escape (\\u); write plain text');
  let doc; try { doc = JSON.parse(text); } catch { return refuse('not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return refuse('not an object');
  const allowed = kind === 'state' ? ['product', 'state', 'until', 'tz'] : ['request', 'product', 'name', 'red_count'];
  const extra = Object.keys(doc).filter((k) => !allowed.includes(k));
  if (extra.length) return refuse(`${extra.length} unexpected field(s); allowed: ${allowed.join(", ")}`);
  if (maskSecrets(String(text)).text !== String(text)) return refuse('the file holds something that looks like a key');
  // And on the parsed values, which are what gets stored.
  if (Object.values(doc).some((v) => typeof v === 'string' && maskSecrets(v).text !== v)) return refuse('the file holds something that looks like a key');
  const r = kind === 'state' ? stateDoc(doc) : requestDoc(doc);
  if (!r.ok) return r;
  if (kind === 'request' && !name.startsWith(`request-${r.doc.request}-`)) return refuse('file name and request differ');
  return { ok: true, kind, doc: r.doc, ...(r.note ? { note: r.note } : {}) };
}
