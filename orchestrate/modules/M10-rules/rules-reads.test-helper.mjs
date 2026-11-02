// rules-reads.test-helper.mjs — the rules keys a module's source text reads, for the key-list drift tests in M2, M6 and
// M9 (L86 2; L96 m-4; L115 m-B; L123; #77 r5 MAT-1). One reader, so the tests can't disagree about what a read is.
//
// A read is a call whose first argument names a rules key:
//   rules.get( / rules.num( / rules.dec( / rules.flag(, each also as rules?.x?.( (L123: the typed reads, L104), and
//   a module's own helper named in `helpers` (writer.mjs's get( and num(), called bare, and
//   need(rules, KEYS.x / minutes(rules, KEYS.x, the Dispatcher's readers, with KEYS.x looked up in `keyMaps` (M11's KEYS).
//   The rules may be reached through a path ending in `rules` (ctx.rules, this.rules?.): #68 reads
//   timeouts.merging_open_max_min in M6 gate.mjs as minutes(ctx.rules, KEYS.x (#77 r6 MAT-1). A need( or minutes(
//   call, also written `need (`, `need?.(` or as a method `x.need(`, whose first argument is not the rules or whose
//   key is not <a map in keyMaps>.<a name in it> is counted in nonLiteral (L156 m-1). What this text reader can't see:
//   the readers imported under another name (`import { need as n }`), or passed as a value and called later
//   (`const f = need; f(rules, KEYS.x)`). Neither is written in Orchestrate today; a review of such a change must
//   add the name here.
// The key is a literal in any quote kind, or a name bound in the same file by `const NAME = <literal>;`. A template key's
// ${…} is expanded: ${state} over the product states, ${kind} over the go-free kinds (goFreeOn's
// `${GO_FREE_KEY}.${kind}`, L123), and a const name to its value. Anything else is counted in nonLiteral, so a key the
// reader can't name fails the test instead of slipping past the list.
//
//   rulesReads(text, { helpers, keyMaps }) → { keys: Set, nonLiteral }
//   readsListed(keys, x) → is listed key x read (itself, or a key inside it: go_free.exact_reverse reads go_free)
//   listed(list, k) → is read key k listed (itself; or, for the go-free map only, a kind inside it, #77 r5 m-1)

import { PRODUCT_STATES } from './policy.mjs';
import { GO_FREE, GO_FREE_KEY } from '../M9-record/ready.mjs';

// A quoted literal whose quote is capture group n (its body is group n + 1).
const Q = (n = 1) => `(['"\`])((?:(?!\\${n})[^\\\\])*)\\${n}`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
// Comment lines are not code.
export const code = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const VARS = Object.freeze({ state: PRODUCT_STATES, kind: Object.keys(GO_FREE) });
const MAX_DEPTH = 4;
// The rules object, reached directly or through a path ending in `rules` (ctx.rules, this.rules, a?.rules), #77 r6 MAT-1.
const RULES = String.raw`(?<![\w$.])(?:${NAME}\??\.)*rules`;

export function rulesReads(text, { helpers = [], keyMaps = {} } = {}) {
  const src = code(text);
  const consts = new Map();
  for (const m of src.matchAll(new RegExp(String.raw`\bconst\s+(${NAME})\s*=\s*${Q(2)}\s*;`, 'g'))) consts.set(m[1], { quote: m[2], body: m[3] });
  // Every key a template body can stand for, or null when a ${…} in it can't be named.
  const expand = (body, depth = 0) => {
    if (!body.includes('${')) return [body];
    const m = new RegExp(String.raw`\$\{\s*(${NAME})\s*\}`).exec(body);
    if (!m || depth > MAX_DEPTH) return null;
    const vals = consts.has(m[1]) ? valueOf(m[1], depth + 1) : VARS[m[1]] ?? null;
    if (!vals) return null;
    const out = [];
    for (const v of vals) { const e = expand(body.replace(m[0], v), depth + 1); if (!e) return null; out.push(...e); }
    return out;
  };
  const valueOf = (name, depth = 0) => { const c = consts.get(name); return c.quote === '`' ? expand(c.body, depth) : [c.body]; };
  const call = new RegExp(String.raw`(?:${RULES}\??\.(?:get|num|dec|flag)(?:\?\.)?` + (helpers.length ? `|(?<![.\\w])(?:${helpers.join('|')})` : '') + String.raw`)\(\s*`, 'g');
  const keys = new Set();
  let nonLiteral = 0;
  for (const m of src.matchAll(call)) {
    const rest = src.slice(m.index + m[0].length);
    const lit = new RegExp(`^${Q()}`).exec(rest);
    const id = lit ? null : new RegExp(String.raw`^(${NAME})\s*[,)]`).exec(rest);
    const got = lit ? (lit[1] === '`' ? expand(lit[2]) : [lit[2]]) : id && consts.has(id[1]) ? valueOf(id[1]) : null;
    if (!got) { nonLiteral += 1; continue; }
    for (const k of got) keys.add(k);
  }
  // The Dispatcher's readers: need(rules, KEYS.x …) and minutes(rules, KEYS.x …), the rules as above. A call with any
  // other first argument can't be named, so it counts as unreadable rather than being skipped (#77 r6 MAT-1).
  for (const m of src.matchAll(/(?<![\w$])(?:need|minutes)\s*(?:\?\.)?\(\s*/g)) {
    const arg = new RegExp(String.raw`^${RULES}\s*,\s*`).exec(src.slice(m.index + m[0].length));
    if (!arg) { nonLiteral += 1; continue; }
    const ref = new RegExp(String.raw`^(${NAME})\.(${NAME})\s*[,)]`).exec(src.slice(m.index + m[0].length + arg[0].length));
    const key = ref && Object.hasOwn(keyMaps, ref[1]) && Object.hasOwn(keyMaps[ref[1]], ref[2]) ? keyMaps[ref[1]][ref[2]] : null;
    if (typeof key === 'string') keys.add(key); else nonLiteral += 1;
  }
  return { keys, nonLiteral };
}

export const readsListed = (keys, x) => [...keys].some((k) => k === x || k.startsWith(`${x}.`));
/** A read key is on the list when it is listed, or is a go-free kind and the go-free map is listed (#77 r5 m-1: no other
 * map stands for the keys inside it, so a read of timeouts.<new> is not covered by a listed `timeouts`). */
export const listed = (list, k) => list.some((x) => x === k || (x === GO_FREE_KEY && k.startsWith(`${x}.`)));
