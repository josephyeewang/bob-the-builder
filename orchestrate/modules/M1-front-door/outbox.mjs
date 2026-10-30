// outbox.mjs — the three kinds of file the Front Door may leave in its outbox, and the check intake runs on each
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
//                      The Air's health result is never a Front Door file: the Air's own check writes it, dated, to its
//                      own folder (M12-sensors/air-health.mjs; lead call L23), so a request-airhealth name is refused here.
//   idea-<id>.md       the idea exactly as Joe said it, quoted ("> " on every line), masked; never acted on as an
//                      instruction. Intake hands the quoted text on through cleanOutside (source "idea-file").

import { makeMasker } from '../M12-sensors/mask.mjs';
import { checkTimeZone } from './timezone.mjs';

export const FRONT_DOOR_KINDS = Object.freeze(['request', 'state', 'idea']);
export const STATES_ALLOWED = Object.freeze(['paused', 'away']);
export const REQUESTS = Object.freeze(['resume', 'wrapup', 'rotate']);
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
// A calendar day that exists: 2026-02-30 is refused, not rolled over to 2 March (0b-8 audit round 5 minor 3).
function realDay(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const isName = (v) => typeof v === 'string' && PRODUCT.test(v); // a string, never a number (round 5 minor 5)

export function stateDoc({ product, state, until = null, tz = null }) {
  if (!isName(product)) return refuse('no valid product name');
  if (!STATES_ALLOWED.includes(state)) return refuse(`the Front Door may set only ${STATES_ALLOWED.join(' or ')}`); // the value is never echoed: it may hold pasted text
  if (until !== null && !(typeof until === 'string' && ISO_DATE.test(until) && Number.isFinite(Date.parse(until)) && realDay(until))) return refuse('until is not a date');
  const z = tz === null ? { ok: true, tz: null } : checkTimeZone(tz);
  return { ok: true, doc: { product, state, until, tz: z.ok ? z.tz : null }, ...(z.ok ? {} : { note: `time zone not accepted (${z.reason}); number work holds until Joe names a city-based zone` }) };
}

export function requestDoc({ request, product = null, name = null }) {
  if (!REQUESTS.includes(request)) return refuse(`unknown request (allowed: ${REQUESTS.join(', ')})`);
  if (product !== null && !isName(product)) return refuse('no valid product name');
  if (request === 'rotate' && (!KEY_NAME.test(String(name ?? '')) || KEY_ID.test(String(name)))) return refuse('rotate needs the key\'s name only (capitals and digits with at least one _, such as STRIPE_KEY)');
  if (request !== 'rotate' && name !== null) return refuse('only rotate carries a name');
  return { ok: true, doc: { request, product, name } };
}

// Invisible characters go before masking, so a key split by them is still caught (0b-8 audit round 4 minor 1).
const INVISIBLE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g;
export function ideaText(text) {
  const masked = maskSecrets(String(text ?? '').replace(INVISIBLE, '')).text.replace(/\r\n?/g, '\n');
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
// Lead call L26: `products` is the product list from the Front Door's context file; a product not on it is refused
// (the skill asks Joe when unsure, never guesses). `seenIds` is every outbox id intake has taken in before, kept in the
// record across restarts; a reused id is refused. Intake passes both (join item with lanes 1 and 2); left out, those
// two checks are skipped, so the result says which were run.
export function checkOutboxFile(name, text, { products = null, seenIds = null } = {}) {
  const r = checkOne(name, text);
  if (!r.ok) return r;
  const id = /(\d{8}-\d{4}-[a-z]{2})\.(?:json|md)$/.exec(String(name))[1];
  // Only a list or a Set counts (round 6 minor 3: a string would match by substring, an object would pass silently).
  const asSet = (v) => (v instanceof Set ? v : Array.isArray(v) ? new Set(v) : null);
  if ((products !== null && !asSet(products)) || (seenIds !== null && !asSet(seenIds))) return refuse('intake passed the product list or the seen ids in the wrong form');
  if (seenIds !== null && asSet(seenIds).has(id)) return refuse('this file id was used before');
  if (products !== null && r.doc.product != null && !asSet(products).has(r.doc.product)) return refuse('that product is not on the product list');
  return { ...r, id, checked: { products: products !== null, seenIds: seenIds !== null } };
}

// The push intake sends Joe for every Front Door file, taken in or refused (L26): the Front Door only ever says
// "Filed"; this is the confirmation. Lane 2 sends it over the Front Door's push path, and only after the record write
// succeeded (a failed write pushes "Not filed"). "Confirmed" only where taking the file in is the act itself (pause,
// away, idea). A request does nothing yet, so its push says so (0b-8 audit round 6 M-1). A result whose product or
// id check was skipped is never confirmed (round 6 minor 1).
export function intakePush(name, result) {
  const no = (why) => `Not filed: ${maskSecrets(String(why)).text}. Say it again.`;
  if (!result?.ok) return no(result?.reason ?? 'unknown reason');
  if (result.checked?.products !== true || result.checked?.seenIds !== true) return no('the Mini could not check the product list and the file ids');
  const d = result.doc ?? {};
  if (result.kind === 'idea') return `Confirmed: idea ${result.id ?? ''}.`.replace(' .', '.');
  if (result.kind === 'state') {
    if (d.state !== 'away') return `Confirmed: pause ${d.product}. Only your tap brings it back.`;
    const tz = d.tz ? `time zone ${d.tz}` : `no time zone yet; the trip brief says what that means for each product${result.note ? ' (that time zone was not accepted; name a city, such as Europe/Prague)' : ''}`;
    return `Confirmed: away ${d.product}${d.until ? ` until ${String(d.until).slice(0, 10)}` : ''}, ${tz}.`;
  }
  if (d.request === 'rotate') return `Request taken: rotate ${d.name}. The key is NOT rotated yet; the steps follow.`;
  if (d.request === 'wrapup') return 'Request taken: wrap up. Nothing has wrapped up yet; the Lead does it when it runs.';
  return `Request taken: resume ${d.product ?? 'all products'}. Nothing resumes until you tap it.`;
}

function checkOne(name, text) {
  if (/^request-airhealth-/.test(String(name))) return refuse('the Air\'s health file comes from the Air\'s own check, never the Front Door');
  // A request word belongs only in a request name (0b-8 audit round 4 cosmetic: no state-resume-<id>).
  const m = /^(?:(request)-(resume|wrapup|rotate)|(state|idea))-(\d{8}-\d{4}-[a-z]{2})\.(json|md)$/.exec(String(name));
  if (!m || maskSecrets(String(name)).text !== String(name)) return refuse('not a Front Door outbox file name');
  const kind = m[1] ?? m[3]; const ext = m[5];
  if (kind === 'idea') {
    if (ext !== 'md') return refuse('an idea is a .md file');
    const lines = String(text).split('\n').filter((l) => l !== '');
    if (!lines.every((l) => l === '>' || l.startsWith('> '))) return refuse('idea text must be quoted on every line');
    if (!lines.some((l) => l.slice(2).trim() !== '')) return refuse('the idea is empty'); // round 5 minor 4
    return { ok: true, kind, doc: { quoted: maskSecrets(String(text).replace(INVISIBLE, '')).text } };
  }
  if (ext !== 'json') return refuse(`a ${kind} file is .json`);
  // The skill never writes an escape; one can hide a key from the text check below (0b-8 audit round 2 M-2).
  if (/\\u/i.test(String(text))) return refuse('the file holds an escape (\\u); write plain text');
  let doc; try { doc = JSON.parse(text); } catch { return refuse('not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return refuse('not an object');
  const allowed = kind === 'state' ? ['product', 'state', 'until', 'tz'] : ['request', 'product', 'name'];
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
