// rules-reads.test-helper.mjs — the rules keys a module's source text reads, for the key-list drift tests in M2 and M9
// (L86 2; L96 m-4; L115 m-B; L123). One reader, so the tests can't disagree about what a read is.
//
// A read is a call whose first argument names a rules key:
//   rules.get( / rules.num( / rules.dec( / rules.flag(, each also as rules?.x?.( (L123: the typed reads, L104), and
//   a module's own helper named in `helpers` (writer.mjs's get( and num(), called bare.
// The key is a literal in any quote kind, or a name bound in the same file by `const NAME = <literal>;`. A template key's
// ${…} is expanded: ${state} over the product states, ${kind} over the go-free kinds (goFreeOn's
// `${GO_FREE_KEY}.${kind}`, L123), and a const name to its value. Anything else is counted in nonLiteral, so a key the
// reader can't name fails the test instead of slipping past the list.
//
//   rulesReads(text, { helpers }) → { keys: Set, nonLiteral }
//   readsListed(keys, x) → is listed key x read (itself, or a key inside it: go_free.exact_reverse reads go_free)

import { PRODUCT_STATES } from './policy.mjs';
import { GO_FREE } from '../M9-record/ready.mjs';

// A quoted literal whose quote is capture group n (its body is group n + 1).
const Q = (n = 1) => `(['"\`])((?:(?!\\${n})[^\\\\])*)\\${n}`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
// Comment lines are not code.
export const code = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const VARS = Object.freeze({ state: PRODUCT_STATES, kind: Object.keys(GO_FREE) });
const MAX_DEPTH = 4;

export function rulesReads(text, { helpers = [] } = {}) {
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
  const call = new RegExp(String.raw`(?:\brules\??\.(?:get|num|dec|flag)(?:\?\.)?` + (helpers.length ? `|(?<![.\\w])(?:${helpers.join('|')})` : '') + String.raw`)\(\s*`, 'g');
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
  return { keys, nonLiteral };
}

export const readsListed = (keys, x) => [...keys].some((k) => k === x || k.startsWith(`${x}.`));
/** A read key is on the list when it is listed, or sits inside a listed map. */
export const listed = (list, k) => list.some((x) => x === k || k.startsWith(`${x}.`));
