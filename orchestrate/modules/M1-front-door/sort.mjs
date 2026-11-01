// sort.mjs — the Front Door's full loop (R-0b-137): sort what the owner says into a Bob mode, read it back in three
// lines with [Go] [Change] [Not now], ask one question with a recommendation when unsure, never repeat a pasted secret.
//
// The skill does the sorting in the session; this file is the reference it is tested against (the skill's cue table
// must match CUES) and the checks a reply must pass. What each mode files on [Go]:
//   new      nothing: the owner starts a Bob NEW session themselves ("open a session on the Mini and say bob NEW X")
//   evolve   request-evolve-<id>.json   { request, product, name: null, what }
//   audit    request-audit-<id>.json    the same shape
//   upgrade  request-upgrade-<id>.json  the same shape (bob UPGRADE on that product)
//   think    request-think-<id>.json    the same shape; the Dispatcher opens a thinking room on the rules' models.main
// A request does nothing until the Lead or the Dispatcher acts on it (join item, M1 README).

import { findCredentials } from '../M12-sensors/mask.mjs';

export const MODES = Object.freeze(['new', 'evolve', 'audit', 'upgrade', 'think']);
export const MODE_REQUESTS = Object.freeze(['evolve', 'audit', 'upgrade', 'think']);
export const READBACK_OPTIONS = Object.freeze(['Go', 'Change', 'Not now']);

// One cue list per mode, the same words the skill's table gives. Matched on the owner's words, lower-cased.
export const CUES = Object.freeze({
  new: ['start a new project', 'new project', 'build a new'],
  evolve: ['fix ', 'add ', 'change ', 'improve '],
  audit: ['is this right', 'is that right', 'check whether', 'audit '],
  upgrade: ['update from bob', 'upgrade from bob', 'bob upgrade'],
  think: ["let's think about", 'lets think about', 'think through', 'brainstorm'],
});

// The modes whose cues appear. Exactly one → sure; none or several → unsure, with the first match (by MODES order)
// as the recommendation, or none.
export function sortRequest(text) {
  const t = ` ${String(text ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
  const hits = MODES.filter((m) => CUES[m].some((c) => t.includes(c)));
  return hits.length === 1 ? { sure: true, mode: hits[0] } : { sure: false, mode: null, recommend: hits[0] ?? null, hits };
}

const LINE = { new: 'Start a new project', evolve: 'Change an existing product', audit: 'Check (audit) a product',
  upgrade: 'Bring a product up to date with Bob', think: 'Think it through in a thinking room' };
const ON_GO = { new: 'On Go: I file nothing; you open a session on the Mini and say `bob NEW <name>`.',
  think: 'On Go: I file a request; the Mini opens a thinking room on the main model.' };

// The three-line read-back. `what` is the owner's words, already masked by the caller; it is shortened, never quoted whole.
export function readBack({ mode, product = null, what = '' }) {
  if (!MODES.includes(mode)) return { ok: false, reason: 'unknown mode' };
  const short = String(what).replace(/\s+/g, ' ').trim().slice(0, 80);
  const lines = [`${LINE[mode]}${product ? `: ${product}` : ''}.`, `What you said: ${short || '(nothing)'}`,
    ON_GO[mode] ?? `On Go: I file a ${mode} request; nothing happens until the Lead picks it up.`];
  return { ok: true, lines, options: [...READBACK_OPTIONS] };
}

// The one question when unsure: every hit (or every mode) as an option, the recommendation first and marked.
export function unsureQuestion({ recommend = null, hits = [] } = {}) {
  const order = [...new Set([recommend, ...hits, ...MODES].filter(Boolean))].slice(0, 4);
  return { question: 'Which of these do you mean?', options: order.map((m, i) => (i === 0 && recommend ? `${LINE[m]} (Recommended)` : LINE[m])) };
}

// A reply must not carry anything key-shaped (B11): nothing key-shaped of its own, and no credential found in the
// owner's words, looked for in the reply by its own text.
export function repeatsSecret(ownerText, reply) {
  const s = String(ownerText ?? ''); const r = String(reply ?? '');
  if (findCredentials(r).length) return true;
  return findCredentials(s).some(({ at }) => {
    const tok = /^\S+/.exec(s.slice(at))?.[0] ?? '';
    return tok.length >= 8 && r.includes(tok);
  });
}
