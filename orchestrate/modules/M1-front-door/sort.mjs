// sort.mjs — the Front Door's full loop (R-0b-137): sort what the owner says into a Bob mode, read it back in three
// lines with [Go] [Change] [Not now], ask one question with a recommendation when unsure, never repeat a pasted secret.
//
// The skill does the sorting in the session; this file is the reference it is tested against (the skill's cue table
// must match CUES) and the checks a reply must pass. What each mode files on [Go]:
//   new      nothing: the owner starts a Bob NEW session themselves ("open a session on the Mini and say bob NEW X")
//   evolve, audit, upgrade, think   nothing yet (audit kit-lane3 r1 Minor 9): the record takes no mode request until join
//            item 9 lands (the record refuses `request-` until items 7, 8 and 9 land (L151), and intake doesn't
//            take mode requests in yet; the skill's step 3 is off), so the skill files nothing and never says "Filed"; it tells the
//            owner how to start it themselves. The file shape stays checked here
//            (request-<mode>-<id>.json { request, product, name: null, what }, outbox.mjs) for when it is wired.

import { findCredentials, makeMasker } from '../M12-sensors/mask.mjs';

const { maskSecrets } = makeMasker({ env: {} });

export const MODES = Object.freeze(['new', 'evolve', 'audit', 'upgrade', 'think']);
export const MODE_REQUESTS = Object.freeze(['evolve', 'audit', 'upgrade', 'think']);
export const READBACK_OPTIONS = Object.freeze(['Go', 'Change', 'Not now']);

// One cue list per mode, the same words the skill's table gives. Matched on the owner's words, lower-cased, as whole
// words ("fix" is not in "prefix"; audit r1 Minor 7).
export const CUES = Object.freeze({
  new: ['start a new project', 'new project'],
  evolve: ['fix', 'add', 'change', 'improve'],
  audit: ['is this right', 'is that right', 'check whether', 'audit'],
  upgrade: ['update from bob', 'upgrade from bob', 'bob upgrade'],
  think: ["let's think about", 'lets think about', 'think through', 'brainstorm'],
});
// Weak cues: they point at a mode but never make it sure ("build a new chart on the pricing page" is a change to a
// product, not a new project). A weak cue alone is unsure, with its mode recommended and evolve offered too.
export const WEAK_CUES = Object.freeze({ new: ['build a new'] });
// With no cue at all, the recommendation is to think it through: it files nothing and starts nothing (Minor 8).
export const NO_CUE_RECOMMEND = 'think';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (t, c) => new RegExp(`(?:^|[^a-z0-9'])${escapeRe(c)}(?=$|[^a-z0-9'])`).test(t);

// The modes whose cues appear. Exactly one → sure; none or several → unsure, with the first match (by MODES order) as
// the recommendation, or think when nothing fits. A new-project cue that names one of the owner's products is unsure.
export function sortRequest(text, { products = [] } = {}) {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hits = MODES.filter((m) => CUES[m].some((c) => has(t, c)));
  const weak = MODES.filter((m) => !hits.includes(m) && (WEAK_CUES[m] ?? []).some((c) => has(t, c)));
  const namesProduct = products.some((p) => typeof p === 'string' && p && has(t, p.toLowerCase()));
  if (hits.length === 1 && !weak.length && !(hits[0] === 'new' && namesProduct)) return { sure: true, mode: hits[0] };
  if (!hits.length && weak.length) return { sure: false, mode: null, recommend: weak[0], hits: [...new Set([weak[0], 'evolve'])] };
  if (hits.length === 1 && hits[0] === 'new') return { sure: false, mode: null, recommend: 'new', hits: ['new', 'evolve'] };
  const all = [...new Set([...hits, ...weak])];
  return { sure: false, mode: null, recommend: all[0] ?? NO_CUE_RECOMMEND, hits: all };
}

const LINE = { new: 'Start a new project', evolve: 'Change an existing product', audit: 'Check (audit) a product',
  upgrade: 'Bring a product up to date with Bob', think: 'Think it through in a thinking room' };
const NOT_WIRED = 'That request isn\'t wired to the Mini yet, so I file nothing';
const ON_GO = { new: 'On Go: I file nothing; you open a session on the Mini and say `bob NEW <name>`.',
  think: `On Go: ${NOT_WIRED}; to think it through now, open a session on the Mini and say what you want to think about.` };
export const onGoLine = (mode) => ON_GO[mode] ?? `On Go: ${NOT_WIRED}; to start it now, open a session on the Mini and say \`bob ${mode.toUpperCase()} <name>\`.`;

// Number work (Tier 1, R-0b-138): words that say the change touches figures someone acts on. The Lead sets the tier;
// these only change what the read-back promises, so a miss here is caught at planning, never skipped.
export const NUMBER_CUES = Object.freeze(['number', 'price', 'pricing', 'revenue', 'score', 'scoring', 'total', 'billing',
  'payment', 'invoice', 'money', 'migration', 'migrate', 'backfill', 'forecast', 'metric', 'dedup', 'join ']);
export function numberWork(text) {
  const t = ` ${String(text ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
  return NUMBER_CUES.some((c) => t.includes(c));
}
export const TIER1_ON_GO = "On Go: That request isn't wired to the Mini yet, so I file nothing. It is number work (Tier 1): once it is wired, your go comes only after a fresh plan reviewer passes the plan, and the change is audited until 0 Material.";

// The three-line read-back. `what` is the owner's words; anything key-shaped is masked BEFORE it is shortened, so a cut
// can't leave part of a key in the reply (audit r1 Minor 6). It is shortened, never quoted whole.
export function readBack({ mode, product = null, what = '', tier1 = false }) {
  if (!MODES.includes(mode)) return { ok: false, reason: 'unknown mode' };
  const short = maskSecrets(String(what)).text.replace(/\s+/g, ' ').trim().slice(0, 80);
  const lines = [`${LINE[mode]}${product ? `: ${product}` : ''}.`, `What you said: ${short || '(nothing)'}`,
    (tier1 && mode === 'evolve') ? TIER1_ON_GO : onGoLine(mode)];
  return { ok: true, lines, options: [...READBACK_OPTIONS] };
}

// The one question when unsure: the recommendation first and marked, then the hits, then the other modes (think and
// evolve before the rarer ones); at most four, since the box adds its own "Other".
const FILL = ['think', 'evolve', 'audit', 'new', 'upgrade'];
export function unsureQuestion({ recommend = null, hits = [] } = {}) {
  const order = [...new Set([recommend, ...hits, ...FILL].filter(Boolean))].slice(0, 4);
  return { question: 'Which of these do you mean?', options: order.map((m, i) => (i === 0 && recommend ? `${LINE[m]} (Recommended)` : LINE[m])) };
}

// A reply must not carry anything key-shaped (B11): nothing key-shaped of its own, and no credential found in the
// owner's words, looked for in the reply by its own text.
export function repeatsSecret(ownerText, reply) {
  const s = String(ownerText ?? ''); const r = String(reply ?? '');
  if (findCredentials(r).length) return true;
  // A part of a key counts too (audit r1 Minor 6): any 12 characters of it in a row.
  const PART = 12;
  return findCredentials(s).some(({ at }) => {
    const tok = /^\S+/.exec(s.slice(at))?.[0] ?? '';
    if (tok.length < 8) return false;
    if (tok.length <= PART) return r.includes(tok);
    for (let i = 0; i + PART <= tok.length; i++) if (r.includes(tok.slice(i, i + PART))) return true;
    return false;
  });
}
