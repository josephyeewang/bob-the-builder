// alert-inventory.mjs — the alert inventory behind alert-inventory.test.mjs (lead call L135).
//
// L135: a scan that judges "is this answer ignored?" cannot be the gate, so every alert-like call in production code
// goes on ONE list, alert-inventory.json, and each entry carries a status a person gave it (tested, ruled or open).
// This file finds the calls. It aims to miss none, and over-listing is cheap: an extra entry costs one ruling.
//
// An alert-like call is a call to:
//   - an alert name (ALERT_NAMES: alert, outbox, say, tellOnce, notify, raise), `tellThen`, a `safeX` / `tellX` name,
//     or any name with "alert" in it (holdAlert, queueAlert, sendAlerts ...), plain or as a member (`ctx.alert(`,
//     `opts.alert?.(`, `alerts.raise(`, `this.notify(`);
//   - an alias of one: `const tell = ctx.alert`, `{ alert: tell }` in parameters or an object, `import { say as tell }`,
//     `x = alert.bind(...)`;
//   - one handed on as a callback: `.then(alert)`, `.catch(say)`, `forEach(notify)`, `map(alert)`;
//   - a function that holds one of the above, one step out (`via`): a plain call in the same file, or a call to a
//     function imported by name from another orchestrate file. That is the L133 shape: the state is written by the
//     caller, the alert is in the callee.
// Calls inside strings and comments do not count; calls inside a template's ${ } do.
//
// Each entry is pinned by file + function + a short hash of the call's line text (`hash`) and a short hash of the
// whole enclosing function, comments left out (`body`). A change to the call's line, or anywhere in its function,
// changes a pin, so a planted mark nine lines later, a guard moved, or a swap inside one function shows up.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { mask, pairs, blocks, fnAt, namedFnBlockAt, lineOf, ALERT_NAMES, alertSites, wrappers, WRITE_CALL, TOLD_MARK } from './alert-answer-scan.mjs';

export const short = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);
const squash = (t) => t.replace(/\s+/g, ' ').trim();

// L143 Minor 4, over-approximate: a tell* / notify* / safe* name, and a name that ends in Joe or Owner (tellJoe,
// pingOwner), are alerts too.
// Such a name, called bare, that is a function defined in orchestrate code (in the file, or imported by name from the
// file that defines it) is followed instead: its callers are listed only if the function holds an alert (below). A
// member call (`ctx.tellJoe(`), a parameter, or a name from outside orchestrate stays an alert.
const oldAlertName = (n) => ALERT_NAMES.includes(n) || n === 'tellThen' || (/alert/i.test(n) && !/^[A-Z0-9_]+$/.test(n));
const wideAlertName = (n) => /^(?:tell|notify|safe)(?:[A-Z_$\d]|$)/.test(n) || /[a-z\d](?:Joe|Owner)$/.test(n);
export const isAlertName = (n) => oldAlertName(n) || wideAlertName(n);
const definesFn = (m, n) => new RegExp(String.raw`(?:\bfunction\s*\*?\s*${n.replace(/\$/g, '\\$')}\s*\(|\b(?:const|let|var)\s+${n.replace(/\$/g, '\\$')}\s*=\s*(?:async\b\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))`).test(m);
const NOT_NAMES = new Set(['true', 'false', 'null', 'undefined', 'this']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'yield', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'with']);

// The names that are alerts in one file: the alert names, plus every alias the file makes of one (to a fixed point).
export function alertNamesIn(m, isName = isAlertName) {
  const names = new Set();
  const is = (n) => isName(n) || names.has(n);
  for (let grew = true; grew;) {
    grew = false;
    const add = (n) => { if (n && !NOT_NAMES.has(n) && !KEYWORDS.has(n) && !is(n)) { names.add(n); grew = true; } };
    // import { say as tell } / export { alert as tell }
    for (const x of m.matchAll(/\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}/g)) {
      for (const part of x[1].split(',')) { const y = /^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(part); if (y && is(y[1])) add(y[2]); }
    }
    // const tell = ctx.alert / tell = opts.alert ?? noop / alert.bind(null) / await safeAlert   (a reference, not a call)
    for (const x of m.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*([A-Za-z_$][\w$]*)\b(?!\s*(?:\?\.\s*)?\()/g)) {
      if (is(x[2])) add(x[1]);
    }
    // { alert: tell }, { alert: tell = () => {} }, { notify: sink }
    for (const x of m.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}=)])/g)) if (is(x[1])) add(x[2]);
  }
  return names;
}

// The alert-like calls in one file: [{ at, name, line }]; `isName` says whether a called name is an alert here.
// An alias (`aliases`) counts only as a plain call: `rec.list(` is not the file's `{ alerts: list }`.
function callsIn(m, match, isName, { bareOnly = null, aliases = new Set() } = {}) {
  const out = [];
  for (const x of m.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) {
    const name = x[1];
    if (KEYWORDS.has(name)) continue;
    const member = /\.\s*$|\?\.\s*$/.test(m.slice(Math.max(0, x.index - 3), x.index));
    if (bareOnly ? (member || !bareOnly.has(name)) : (!isName(name, x.index) || (member && !isAlertName(name) && aliases.has(name)))) continue;
    const open = m.indexOf('(', x.index + name.length);
    const close = match.get(open);
    if (close === undefined) continue;
    const before = m.slice(Math.max(0, x.index - 12), x.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;   // function alert(
    let k = close + 1; while (k < m.length && /\s/.test(m[k])) k += 1;
    if (m[k] === '{') continue;                          // a method: alert(a) { ... }
    if (/\bnew\s+$/.test(before)) continue;
    out.push({ at: x.index, name });
  }
  // A callback handed on: .then(alert), .catch(say), forEach(notify), map(alert)
  if (!bareOnly) {
    for (const x of m.matchAll(/(?:\.\s*(?:then|catch|finally|forEach|map|filter)|\btellThen)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*[,)]/g)) {
      const last = x[1].split('.').pop().trim();
      if (isName(last, x.index) && !/tellThen/.test(x[0])) out.push({ at: x.index + x[0].indexOf(x[1]), name: last, handed: true });
    }
  }
  return out;
}

// What happens to a call's answer: 'returned' (`return alert(x)`, a concise arrow's body), 'dropped' (the call is a
// whole statement: bare, awaited, or the body of an if / else / loop), or 'used' (anything else).
export function fateOf(m, match, at) {
  let s = at;   // back over `obj.`, `obj?.`
  for (;;) {
    let p = s - 1; while (p >= 0 && /\s/.test(m[p])) p -= 1;
    if (m[p] !== '.') break;
    p -= m[p - 1] === '?' ? 2 : 1; while (p >= 0 && /\s/.test(m[p])) p -= 1;
    if (m[p] === ']' || m[p] === ')') { const o = match.get(p); if (o === undefined) break; s = o; continue; }
    let k = p; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1;
    if (k === p) break;
    s = k + 1;
  }
  let p = s - 1; while (p >= 0 && /\s/.test(m[p])) p -= 1;
  let w = ''; { let k = p; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1; w = m.slice(k + 1, p + 1); if (w === 'await' || w === 'void') { p = k; while (p >= 0 && /\s/.test(m[p])) p -= 1; let k2 = p; while (k2 >= 0 && /[\w$]/.test(m[k2])) k2 -= 1; w = m.slice(k2 + 1, p + 1); } }
  const open = m.indexOf('(', at);
  const close = match.get(open);
  let q = (close ?? open) + 1; while (q < m.length && /\s/.test(m[q])) q += 1;
  // Returned as it is (`return alert(x);`, `=> alert(x)`, `return alert(x).then(...)`); `return alert(x) !== false` is used.
  if ((w === 'return' || (m[p] === '>' && m[p - 1] === '=')) && (q >= m.length || ';})],.?'.includes(m[q]) && !(m[q] === '?' && m[q + 1] !== '.'))) return 'returned';
  const ends = q >= m.length || m[q] === ';' || m[q] === '}' || (m[q] === ')' && false);
  if (!ends) return 'used';
  if (p < 0 || ';{}'.includes(m[p]) || w === 'else' || w === 'do' || w === 'try' || w === 'finally') return 'dropped';
  if (m[p] === ')') { const o = match.get(p); let r = (o ?? 0) - 1; while (r >= 0 && /\s/.test(m[r])) r -= 1; let k = r; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1; if (['if', 'for', 'while'].includes(m.slice(k + 1, r + 1))) return 'dropped'; }
  return 'used';
}

// ---- answer flow (L143 M-1): over-approximate ----
//
// Every alert-like call is listed. On top of that, a function that HOLDS an alert puts its callers on the list too
// (`via`), at any depth and across files through the imports (renamed imports, re-exports, `ns.fn(` and `this.fn(`
// included). A function holds one in two ways:
//   - it PASSES THE ANSWER ON: its return value comes from an alert's answer in any form (`return alert(x)`,
//     `return alert(x) !== false`, a variable that holds the answer, `||`, a ternary, a concise arrow), or from the
//     answer of a function that passes it on. Its callers are listed, and so on up, at any depth;
//   - it does not HANDLE the answer of an alert (or of a function that passes one on). Handled means only: the answer
//     feeds tellThen/holdAlert, or it is in the test of an `if` with no write after that `if` in the function. Its
//     callers are listed, one step up.
// Over-flagging is fine (the entry gets a test); missing one is not.
const isW = (c) => c !== undefined && /[\w$]/.test(c);
const prevI = (m, i) => { let k = i - 1; while (k >= 0 && /\s/.test(m[k])) k -= 1; return k; };
const nextI = (m, i) => { let k = i; while (k < m.length && /\s/.test(m[k])) k += 1; return k; };
const wordEnding = (m, end) => { let k = end; while (k >= 0 && isW(m[k])) k -= 1; return [m.slice(k + 1, end + 1), k]; };
const mentions = (text, names) => [...names].some((v) => new RegExp(String.raw`(?<![\w$.])${v.replace(/\$/g, '\\$')}(?![\w$])`).test(text));
const HANDLERS = new Set(['tellThen', 'holdAlert']);

// The start of a call's callee expression: back over `obj.`, `obj?.`, `x[..].`, `f(..).`.
function calleeStart(m, match, at) {
  let s = at;
  for (;;) {
    let p = prevI(m, s);
    if (m[p] !== '.') break;
    p = prevI(m, m[p - 1] === '?' ? p - 1 : p);
    if (m[p] === ']' || m[p] === ')') { const o = match.get(p); if (o === undefined) break; s = o; continue; }
    const [w, k] = wordEnding(m, p);
    if (!w) break;
    s = k + 1;
  }
  return s;
}
// Is the `{` at `o` a block (not an object literal)?
function isBlockBrace(m, o) {
  const p = prevI(m, o);
  if (p < 0) return true;
  if (m[p] === '>' && m[p - 1] === '=') return true;          // => {
  if (m[p] === ')' || m[p] === ';' || m[p] === '{' || m[p] === '}') return true;
  const [w] = wordEnding(m, p);
  if (/^(else|try|finally|do)$/.test(w)) return true;
  return false;
}
// The end of an expression that starts at `from`: the index before a `;` or `,` at depth 0, or an unmatched closer.
function exprEnd(m, match, from, hi = m.length, { comma = true } = {}) {
  let k = from;
  while (k < hi) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') { const e = match.get(k); if (e === undefined) return hi - 1; k = e + 1; continue; }
    if (c === ')' || c === ']' || c === '}' || c === ';' || (comma && c === ',')) return k - 1;
    k += 1;
  }
  return hi - 1;
}
// The identifiers an assignment writes: a name, a member chain (`state.sent`), or a destructuring pattern.
function targetsBefore(m, match, eq) {
  let q = eq; while (q > 0 && '+-*/%&|^?'.includes(m[q - 1])) q -= 1;
  let t = prevI(m, q);
  const out = [];
  if (m[t] === '}' || m[t] === ']') {
    const o = match.get(t);
    if (o !== undefined) for (const v of m.slice(o, t).matchAll(/[A-Za-z_$][\w$]*/g)) out.push(v[0]);
    return { names: out, start: o ?? t };
  }
  for (;;) {
    const [w, k] = wordEnding(m, t);
    if (!w) break;
    out.push(w);
    const d = prevI(m, k + 1);
    if (m[d] !== '.') return { names: out, start: k + 1 };
    t = prevI(m, m[d - 1] === '?' ? d - 1 : d);
    if (m[t] === ']' || m[t] === ')') { const o = match.get(t); if (o === undefined) break; t = prevI(m, o); }
  }
  return { names: out, start: t + 1 };
}
const isAssign = (m, p) => m[p] === '=' && m[p + 1] !== '=' && m[p + 1] !== '>' && !'=!<>'.includes(m[p - 1] ?? '');
// The name a concise arrow's `=>` (at the '>') is given: `const name = (a) => ...`, `name: (a) => ...`, or null.
function arrowName(m, match, gt) {
  let q = prevI(m, gt - 1);
  q = m[q] === ')' ? prevI(m, match.get(q) ?? q) : prevI(m, wordEnding(m, q)[1] + 1);
  const [w, k] = wordEnding(m, q);
  if (w === 'async') q = prevI(m, k + 1);
  if ((m[q] === '=' && !'=!<>'.includes(m[q - 1])) || m[q] === ':') return wordEnding(m, prevI(m, q))[0] || null;
  return null;
}
// Where a call sits in its statement, walking out from its start `s` to the start of the statement (not past `lo`):
// { returned, arrow, arrowName, cond, args, vars }. `args` are the names of the calls it is an argument of.
function contextOf(m, match, s, lo) {
  const ctx = { returned: false, arrow: false, arrowName: null, cond: null, args: [], vars: [] };
  let p = prevI(m, s);
  while (p > lo) {
    const c = m[p];
    if (c === ')' || c === ']') { const o = match.get(p); if (o === undefined || o <= lo) break; p = prevI(m, o); continue; }
    if (c === '}') { const o = match.get(p); if (o === undefined || o <= lo || isBlockBrace(m, o)) break; p = prevI(m, o); continue; }
    if (c === '(') {
      const q = prevI(m, p);
      const [w] = wordEnding(m, q);
      if (/^(if|while|for|switch)$/.test(w)) { ctx.cond = { head: w, open: p, close: match.get(p) }; return ctx; }
      if (w && isW(m[q])) ctx.args.push(w);
      p = q; continue;
    }
    if (c === '{') { if (isBlockBrace(m, p)) break; p = prevI(m, p); continue; }
    if (c === ';') break;
    if (c === '>' && m[p - 1] === '=') { ctx.returned = true; ctx.arrow = true; ctx.arrowName = arrowName(m, match, p); return ctx; }
    if (isAssign(m, p)) { const t = targetsBefore(m, match, p); ctx.vars.push(...t.names); p = prevI(m, t.start); continue; }
    if (isW(c)) {
      const [w, k] = wordEnding(m, p);
      if (w === 'return' || w === 'yield' || w === 'throw') { ctx.returned = true; return ctx; }
      if (/^(else|do|try|finally|case|default)$/.test(w)) break;
      p = prevI(m, k + 1); continue;
    }
    p -= 1;
  }
  return ctx;
}
// The last index of the statement that starts at or after `from`.
function stmtEnd(m, match, from) {
  const q = nextI(m, from);
  if (m[q] === '{') return match.get(q) ?? q;
  const w = /^[A-Za-z_$][\w$]*/.exec(m.slice(q, q + 20))?.[0] ?? '';
  if (w === 'if' || w === 'while' || w === 'for' || w === 'switch') {
    const o = m.indexOf('(', q); const c = match.get(o);
    if (c === undefined) return exprEnd(m, match, q, m.length, { comma: false }) + 1;
    return w === 'if' ? ifEnd(m, match, c) : stmtEnd(m, match, c + 1);
  }
  const e = exprEnd(m, match, q, m.length, { comma: false });
  return m[e + 1] === ';' ? e + 1 : e;
}
// The last index of a whole if statement (with its else chain), given its test's closing `)`.
function ifEnd(m, match, condClose) {
  let e = stmtEnd(m, match, condClose + 1);
  const q = nextI(m, e + 1);
  if (m.startsWith('else', q) && !isW(m[q + 4])) e = stmtEnd(m, match, q + 4);
  return e;
}
const hasWrite = (text) => { for (const re of [WRITE_CALL, TOLD_MARK]) { re.lastIndex = 0; if (re.test(text)) return true; } return false; };
const RETURN_VALUE = /\breturn\b(?!\s*[;}])/;
/**
 * What one function does with one call's answer: 'passes' (its return value comes from the answer), 'handled' (the
 * answer feeds tellThen/holdAlert, or an `if` with no write after it), or 'unhandled'. `b` is the function's block, or
 * null at the top level. With `ctx.arrow`, a concise arrow returns it: the arrow, when named, passes it on itself.
 */
export function answerFlow(m, match, at, b) {
  const lo = b ? b.open : -1;
  const hi = b ? b.close : m.length;
  const s = calleeStart(m, match, at);
  const ctx = contextOf(m, match, s, lo);
  if (ctx.returned) return { flow: 'passes', arrow: ctx.arrow, arrowName: ctx.arrowName };
  const body = m.slice(lo + 1, hi);
  const off = lo + 1;
  // The variables that hold the answer, and every variable made from them (to a fixed point).
  const vars = new Set(ctx.vars.filter((v) => !KEYWORDS.has(v)));
  const assigns = [];
  for (let k = 0; k < body.length; k += 1) {
    if (!isAssign(body, k)) continue;
    const t = targetsBefore(m, match, off + k);
    assigns.push({ names: t.names, rhs: m.slice(off + k + 1, exprEnd(m, match, off + k + 1, hi) + 1) });
  }
  for (let grew = vars.size > 0; grew;) {
    grew = false;
    for (const a of assigns) if (mentions(a.rhs, vars)) for (const n of a.names) if (!vars.has(n) && !KEYWORDS.has(n)) { vars.add(n); grew = true; }
  }
  if (vars.size) {
    for (const r of body.matchAll(/\breturn\b|=>(?!\s*\{)/g)) {
      const from = off + r.index + r[0].length;
      if (mentions(m.slice(from, exprEnd(m, match, from, hi, { comma: false }) + 1), vars)) return { flow: 'passes' };
    }
  }
  // The `if`s it decides: the one whose test holds the call, and every one whose test names a variable above.
  const ifs = [];
  if (ctx.cond?.head === 'if' && ctx.cond.close !== undefined) ifs.push(ctx.cond.close);
  if (vars.size) {
    for (const x of body.matchAll(/(?<![\w$.])if\s*\(/g)) {
      const o = off + x.index + x[0].length - 1; const c = match.get(o);
      if (c !== undefined && mentions(m.slice(o + 1, c), vars)) ifs.push(c);
    }
  }
  let guarded = false;
  for (const c of ifs) {
    const e = ifEnd(m, match, c);
    if (RETURN_VALUE.test(m.slice(c + 1, e + 1))) return { flow: 'passes' };
    // It guards every write after it: there is none, or the `if` leaves the function (`if (!sent) return;`).
    const then = m.slice(c + 1, stmtEnd(m, match, c + 1) + 1).trim();
    const leaves = /^(?:\{[\s\S]*[;{}]\s*)?(?:return|throw)\b[^;{}]*;?\s*\}?$/.test(then) && !hasWrite(then);
    if (leaves || !hasWrite(m.slice(e + 1, hi))) guarded = true;
  }
  if (ctx.args.some((n) => HANDLERS.has(n))) return { flow: 'handled' };
  if (vars.size) {
    for (const x of body.matchAll(/(?<![\w$])(?:tellThen|holdAlert)\s*\(/g)) {
      const o = off + x.index + x[0].length - 1; const c = match.get(o);
      if (c !== undefined && mentions(m.slice(o + 1, c), vars)) return { flow: 'handled' };
    }
  }
  return { flow: guarded ? 'handled' : 'unhandled' };
}

// The parameters of the function whose block is `b`: an array of names (null for a pattern).
function paramsOf(m, match, b) {
  let p = prevI(m, b.open);
  if (m[p] === '>' && m[p - 1] === '=') p = prevI(m, p - 1);
  let text;
  if (m[p] === ')') { const o = match.get(p); if (o === undefined) return []; text = m.slice(o + 1, p); } else text = wordEnding(m, p)[0];
  const out = []; let depth = 0; let cur = '';
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1; else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => { const y = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?:=[\s\S]*)?$/.exec(x); return y ? y[1] : null; });
}
// The top-level arguments of the call whose `(` is at `open`.
function argsOf(m, match, open) {
  const close = match.get(open); if (close === undefined) return [];
  const out = []; let from = open + 1;
  for (let k = open + 1; k <= close; k += 1) {
    const c = m[k];
    if ((c === '(' || c === '[' || c === '{') && match.has(k)) { k = match.get(k); continue; }
    if (c === ',' || k === close) { out.push(m.slice(from, k).trim()); from = k + 1; }
  }
  return out;
}

// Relative imports by name: local name -> { from, name }; `* as ns` -> namespaces; `export { a as b } from` -> reexports.
function importsOf(m, src, rel) {
  const out = new Map(); const namespaces = new Map(); const reexports = new Map(); const stars = [];
  const at = (from) => normalize(join(dirname(rel), from)).split('\\').join('/');
  for (const x of src.matchAll(/\b(import|export)\s*(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s*(?:as\s+([\w$]+))?)\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (m.slice(x.index, x.index + x[1].length) !== x[1]) continue;   // in a comment or a string
    const from = at(x[5]);
    if (x[1] === 'import' && x[4]) namespaces.set(x[4], from);
    if (x[1] === 'export' && !x[3] && !x[4]) stars.push(from);
    for (const part of (x[3] ?? '').split(',')) {
      const y = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (!y) continue;
      if (x[1] === 'import') out.set(y[2] ?? y[1], { from, name: y[1] });
      else reexports.set(y[2] ?? y[1], { from, name: y[1] });
    }
  }
  return { imports: out, namespaces, reexports, stars };
}

/**
 * The inventory of a set of production files: [{ file, fn, call, hash, body, line, text, via? }], sorted.
 * `files` is [{ rel, src }] with `rel` relative to orchestrate/ and '/'-separated.
 */
export function inventory(files) {
  const info = new Map();
  for (const f of files) {
    const m = mask(f.src);
    const match = pairs(m);
    info.set(f.rel, { ...f, m, match, bl: blocks(m, match), scoped: [], P: new Set(), D: new Set(), ...importsOf(m, f.src, f.rel) });
  }
  // A wide name (Minor 4) that is a function we can see is followed, not taken as an alert.
  const seen = (f, n, depth = 0) => {
    if (!f || depth > 20) return false;
    if (definesFn(f.m, n)) return true;
    const imp = f.imports.get(n) ?? f.reexports.get(n);
    if (imp) return seen(info.get(imp.from), imp.name, depth + 1);
    return f.stars.some((st) => seen(info.get(st), n, depth + 1));
  };
  for (const f of info.values()) {
    f.alertish = (n) => oldAlertName(n) || (wideAlertName(n) && !seen(f, n));
    f.aliases = alertNamesIn(f.m, f.alertish);
  }
  const isNameIn = (f, n, at) => isAlertName(n) || f.aliases.has(n) || f.scoped.some((s) => s.name === n && s.open < at && at < s.close);
  // The same, with a wide name we can see followed instead (for direct calls and holders).
  const isAlertIn = (f, n, at) => f.alertish(n) || f.aliases.has(n) || f.scoped.some((s) => s.name === n && s.open < at && at < s.close);
  const named = (f, n) => f.bl.filter((b) => b.kind === 'fn' && b.name === n);
  // 1. Alert ports handed on by position (`step(rec, alert)`): the callee's parameter is an alert inside the callee.
  for (let grew = true; grew;) {
    grew = false;
    for (const f of info.values()) {
      for (const x of f.m.matchAll(/(?<![\w$])(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (KEYWORDS.has(x[1])) continue;
        const open = x.index + x[0].length - 1;
        const args = argsOf(f.m, f.match, open);
        const idx = args.map((a, i) => {
          const last = /(?:^|\.)\s*([A-Za-z_$][\w$]*)$/.exec(a)?.[1];
          return last && /^[\w$.\s?]+$/.test(a) && isNameIn(f, last, x.index) ? i : -1;
        }).filter((i) => i >= 0);
        if (!idx.length) continue;
        const imp = f.imports.get(x[1]);
        const target = imp ? info.get(imp.from) : f;
        const fnName = imp ? imp.name : x[1];
        if (!target) continue;
        for (const b of named(target, fnName)) {
          const ps = paramsOf(target.m, target.match, b);
          for (const i of idx) {
            const pn = ps[i];
            if (!pn || isNameIn(target, pn, b.open + 1)) continue;
            target.scoped.push({ name: pn, open: b.open, close: b.close });
            grew = true;
          }
        }
      }
    }
  }
  // 2. The direct alert calls; a member call of a wide name (`ctx.tellJoe(`) is an alert even when a function of
  // that name is defined somewhere.
  for (const f of info.values()) {
    const all = new Set([...f.aliases, ...f.scoped.map((s) => s.name)]);
    f.calls = callsIn(f.m, f.match, (n, at) => isNameIn(f, n, at), { aliases: all }).filter((c) => {
      return isAlertIn(f, c.name, c.at) || f.m[prevI(f.m, c.at)] === '.';
    });
  }
  // 3. The holders, to a fixed point. kindOf(rel, name) is 'P', 'D' or null, through re-exports.
  const holderKind = (rel, name, depth = 0) => {
    const f = info.get(rel);
    if (!f || depth > 20) return null;
    if (f.P.has(name)) return 'P';
    if (f.D.has(name)) return 'D';
    const re = f.reexports.get(name);
    if (re) return holderKind(re.from, re.name, depth + 1);
    for (const s of f.stars) { const k = holderKind(s, name, depth + 1); if (k) return k; }
    return null;
  };
  const holderCalls = (f) => {
    const out = [];
    for (const x of f.m.matchAll(/(?<![\w$.])(?:(this|[A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*)?([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) {
      const [, recv, name] = x;
      if (KEYWORDS.has(name)) continue;
      const at = x.index + x[0].search(new RegExp(String.raw`${name.replace(/\$/g, '\\$')}\s*(?:\?\.\s*)?\($`));
      const before = f.m.slice(Math.max(0, x.index - 12), x.index);
      if (/\bfunction\s*\*?\s*$/.test(before) || /\bnew\s+$/.test(before)) continue;
      const open = x.index + x[0].length - 1; const close = f.match.get(open);
      if (close === undefined) continue;
      if (f.m[nextI(f.m, close + 1)] === '{') continue;   // a method definition
      let target = null;
      if (!recv || recv === 'this') {
        if (!recv && f.imports.has(name)) { const imp = f.imports.get(name); if (holderKind(imp.from, imp.name)) target = { rel: imp.from, name: imp.name, kind: holderKind(imp.from, imp.name) }; }
        else if (holderKind(f.rel, name) && !f.imports.has(name)) target = { rel: f.rel, name, kind: holderKind(f.rel, name) };
      } else if (f.namespaces.has(recv)) {
        const from = f.namespaces.get(recv);
        if (holderKind(from, name)) target = { rel: from, name, kind: holderKind(from, name) };
      }
      if (!target) continue;
      if (target.rel === f.rel && fnAt(f.bl, at) === name) continue;   // a function calling itself
      out.push({ at, name, target });
    }
    return out;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const f of info.values()) {
      const answers = [...f.calls.map((c) => ({ ...c, kind: 'alert' })), ...holderCalls(f).map((c) => ({ ...c, kind: c.target.kind }))];
      for (const c of answers) {
        const b = namedFnBlockAt(f.bl, c.at);
        const r = c.handed ? { flow: 'unhandled' } : answerFlow(f.m, f.match, c.at, b);
        // A concise arrow with a name passes the answer on itself; one without a name, its enclosing function.
        const holder = r.arrow && r.arrowName ? r.arrowName : b?.name;
        if (!holder || isAlertIn(f, holder, c.at)) continue;   // a function named like an alert is an alert itself
        if (r.flow === 'passes' && !f.P.has(holder)) { f.P.add(holder); grew = true; }
        else if (r.flow === 'unhandled' && c.kind !== 'D' && !f.P.has(holder) && !f.D.has(holder)) { f.D.add(holder); grew = true; }
      }
    }
  }
  // 4. The entries: every alert-like call, and every call to a holder (via).
  const out = [];
  for (const f of info.values()) {
    const lines = f.src.split('\n');
    const bodyHash = new Map();
    const bodyOf = (at) => {
      const b = namedFnBlockAt(f.bl, at);
      const key = b ? b.open : -1;
      if (!bodyHash.has(key)) {
        const text = b ? f.src.slice(b.open, b.close + 1) : null;
        bodyHash.set(key, text === null ? null : short(squash(mask(text, { commentsOnly: true }))));
      }
      return bodyHash.get(key);
    };
    const push = (c, via) => {
      const line = lineOf(f.m, c.at);
      const text = squash(lines[line - 1]);
      const hash = short(text);
      const body = bodyOf(c.at) ?? hash;   // a top-level call: its line is its pin
      out.push({ file: f.rel, fn: fnAt(f.bl, c.at), call: c.name, hash, body, line, text, ...(via && { via }) });
    };
    for (const c of f.calls) push(c, null);
    for (const c of holderCalls(f)) {
      const imp = f.imports.get(c.name);
      push(c, imp && c.target.rel !== f.rel ? `${imp.from} ${imp.name}` : `${c.target.rel} ${c.target.name}`);
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.call.localeCompare(b.call)));
}

/** The scanner's hints for one file, by line: 'likely' (the old windowed check) or 'possible' (a write anywhere in the function). */
export function hintsFor(src) {
  const hints = new Map();
  for (const s of alertSites(src, { wholeFn: true })) hints.set(s.line, { level: 'possible', why: s.why });
  for (const s of alertSites(src)) hints.set(s.line, { level: 'likely', why: s.why });
  for (const w of wrappers(src)) if (!w.passes) hints.set(`wrapper ${w.fn}`, { level: 'likely', why: `wrapper ${w.fn} loses the answer: ${w.why}` });
  return hints;
}

// The owner of a production file, by LANES.md folder (the lead call overrides go on the entry itself).
export function folderOwner(rel) {
  const top = rel.split('/');
  const mod = top[0] === 'modules' ? top[1].split('-')[0] : top[0];
  if (['M10', 'M9', 'M2', 'M6', 'shared'].includes(mod)) return 'lane 1';
  if (['M4', 'M11'].includes(mod)) return 'lane 2';
  if (['M12', 'M13', 'M1'].includes(mod)) return 'lane 3';
  if (mod === 'setup') return 'lane 4';
  return 'lead';
}

// ---- the statuses ----

export const OWNERS = ['lane 1', 'lane 2', 'lane 3', 'lane 4', 'lead'];
/**
 * Parses one status: { kind: 'tested', file, test } | { kind: 'ruled', call, why } | { kind: 'wrapped', file, fn }
 * | { kind: 'open', owner, pr } | { kind: 'bad', why }. `wrapped: <file> <fn>` (L139 item 4): the call goes through a
 * listed wrapper whose contract test is proven (contractProblems), and the wrapper's `covers` names this call.
 */
// A test path is relative to orchestrate/ and stays inside it (L143 Minor 9: no `../`, no absolute path).
export const badTestPath = (rel) => (/^\/|(?:^|\/)\.\.?(?:\/|$)|\\/.test(rel) ? `the test path must stay inside orchestrate/ (no ../ or absolute path): ${rel}` : null);
export function parseStatus(s) {
  if (typeof s !== 'string') return { kind: 'bad', why: 'status must be a string' };
  let x = /^tested: (\S+\.test\.mjs) > (.+)$/.exec(s);
  if (x) return badTestPath(x[1]) ? { kind: 'bad', why: badTestPath(x[1]) } : { kind: 'tested', file: x[1], test: x[2] };
  x = /^ruled: (L\d{1,4}), (.{8,})$/.exec(s);
  if (x) return { kind: 'ruled', call: x[1], why: x[2] };
  x = /^wrapped: (\S+\.mjs) ([A-Za-z_$][\w$]*)$/.exec(s);
  if (x) return { kind: 'wrapped', file: x[1], fn: x[2] };
  x = /^open: (lane [1-4]|lead), (#\d+|none yet)$/.exec(s);
  if (x) return OWNERS.includes(x[1]) ? { kind: 'open', owner: x[1], pr: x[2] } : { kind: 'bad', why: 'unknown owner' };
  return { kind: 'bad', why: 'status must be "tested: <file>.test.mjs > <test name>", "ruled: L<n>, <why>", "wrapped: <file> <fn>" or "open: <lane n|lead>, <#N|none yet>"' };
}

// Does the test named `name` in `src` (a .test.mjs) exist, and run fakeAlert({ answer: false }) and fakeAlert({ throws })?
// Returns null when it does, or why not. L143 M-2: `throws:` must be something that throws (not null, false, undefined,
// 0 or ''), the body may not call t.skip() / t.todo(), and with `target` ({ testRel, file }) the test file imports
// the entry's module. This is the static half; runtimeProblems is the proof (it sees the entry's function reached).
export function testedProblem(src, name, target = null) {
  const m = mask(src);
  const match = pairs(m);
  const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``];
  for (const x of m.matchAll(/(?<![\w$.])(?:test|it)\s*\(/g)) {
    const open = m.indexOf('(', x.index);
    const close = match.get(open);
    if (close === undefined) continue;
    const head = src.slice(open + 1, open + 1 + name.length + 4).trimStart();
    if (!quoted.some((q) => head.startsWith(q))) continue;
    const body = m.slice(open, close + 1);
    const raw = src.slice(open, close + 1);
    const calls = [...body.matchAll(/\bfakeAlert\s*\(/g)].map((y) => { const o = open + y.index + y[0].length - 1; return src.slice(o, (match.get(o) ?? o) + 1); });
    const lost = calls.some((c) => /\banswer\s*:\s*false\b/.test(c));
    const threw = calls.some((c) => /\bthrows\s*:\s*(?!(?:null|false|undefined|0|''|""|``|void\s+0)\s*[,})])\S/.test(c));
    if (!/from\s+['"][^'"]*fake-alert\.test-helper\.mjs['"]/.test(src)) return 'the file does not import fakeAlert';
    if (target && !importsFile(src, target.testRel, target.file)) return `the test file does not import ${target.file}`;
    if (/\.\s*(?:skip|todo)\s*\(/.test(body)) return 'the test calls skip() or todo() in its body, so it proves nothing';
    if (!lost || !threw) return `the test must run fakeAlert({ answer: false }) and fakeAlert({ throws: <an Error> }); it runs ${lost ? 'only answer: false' : threw ? 'only throws' : 'neither'}${raw.includes('fakeAlert') ? '' : ' (no fakeAlert in its body)'}`;
    // A todo or skipped test proves nothing: its failure does not fail the run.
    const opts = m.slice(open + 1 + name.length + 2, open + 1 + name.length + 2 + 200).match(/^\s*,\s*\{([^{}]*)\}/);
    if (opts && /\b(?:todo|skip)\s*:\s*(?!false\b)/.test(src.slice(open + 1 + name.length + 2, open + 1 + name.length + 2 + opts[0].length))) return 'the test is a todo or skipped, so it proves nothing yet';
    if (/(?:test|it)\s*\.\s*(?:todo|skip)\s*$/.test(m.slice(Math.max(0, x.index - 2), open))) return 'the test is a todo or skipped, so it proves nothing yet';
    return null;
  }
  return 'no test(...) or it(...) by that name';
}

// ---- wrapper contracts (L139 item 4) ----

/** The body pin of the first function named `fn` in `src` (comments left out), or null when there is none. */
export function fnBody(src, fn) {
  const m = mask(src);
  const b = blocks(m, pairs(m)).find((x) => x.kind === 'fn' && x.name === fn);
  return b ? short(squash(mask(src.slice(b.open, b.close + 1), { commentsOnly: true }))) : null;
}
/** The first and last line of the first function named `fn` in `src`, or null when there is none. */
export function fnLines(src, fn) {
  const m = mask(src);
  const b = blocks(m, pairs(m)).find((x) => x.kind === 'fn' && x.name === fn);
  return b ? [lineOf(m, b.open), lineOf(m, b.close)] : null;
}
/** Does `testSrc` (at `testRel`) import `fileRel`? Both relative to orchestrate/. */
export function importsFile(testSrc, testRel, fileRel) {
  for (const x of mask(testSrc, { commentsOnly: true }).matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (normalize(join(dirname(testRel), x[1])).split('\\').join('/') === fileRel) return true;
  }
  return false;
}
/**
 * Why a wrapper's contract is not proven, or [] when it is. Proven: the wrapper names a `contract_test`
 * ("<file>.test.mjs > <name>") that exists, imports the wrapper's file, runs fakeAlert answering false and throwing,
 * and is not a todo; its body pin matches; and every wrapper it calls on (`inner`) is proven too.
 * `read(rel)` returns a file's source under orchestrate/, or null.
 */
export function contractProblems(w, wrappersList, read, seen = new Set(), runtime = null) {
  const id = `${w.file} ${w.fn}`;
  if (seen.has(id)) return [`${id}: its inner wrappers loop`];
  seen.add(id);
  if (!w.contract_test) return [`${id} has no contract_test`];
  const x = /^(\S+\.test\.mjs) > (.+)$/.exec(w.contract_test);
  if (!x) return [`${id}: contract_test must be "<file>.test.mjs > <test name>"`];
  if (badTestPath(x[1])) return [`${id}: ${badTestPath(x[1])}`];
  const out = [];
  const src = read(x[1]);
  if (src === null) out.push(`${id}: ${x[1]} does not exist`);
  else {
    const why = testedProblem(src, x[2], { testRel: x[1], file: w.file, fn: w.fn });
    if (why) out.push(`${id}: ${x[1]} > ${x[2]}: ${why}`);
    else if (runtime) for (const r of runtime(x[1], x[2], [{ file: w.file, fn: w.fn }], { answerUnused: w.answer_unused })) out.push(`${id}: ${x[1]} > ${x[2]}: ${r}`);
  }
  const code = read(w.file);
  if (code === null || fnBody(code, w.fn) === null) out.push(`${id}: no function ${w.fn} in ${w.file}`);
  else if (w.body && fnBody(code, w.fn) !== w.body) out.push(`${id}: the wrapper changed since its contract was pinned (body ${fnBody(code, w.fn)}, list ${w.body})`);
  for (const inner of w.inner ?? []) {
    const v = wrappersList.find((y) => `${y.file} ${y.fn}` === inner);
    if (!v) out.push(`${id}: inner wrapper ${inner} is not on the list`);
    else out.push(...contractProblems(v, wrappersList, read, new Set(seen), runtime));
  }
  return out;
}

// ---- the run-time proof (L143 M-2) ----

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** One run of one test (by exact name): { ran, passed, skipped, log: [{ outcome, frames }] }. */
export function runOneTest(root, testRel, name, flip = null) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-alert-'));
  const logFile = join(dir, 'log.jsonl');
  const env = { ...process.env, FAKE_ALERT_LOG: logFile };
  delete env.FAKE_ALERT_FLIP;
  if (flip) env.FAKE_ALERT_FLIP = flip;
  delete env.NODE_TEST_CONTEXT;   // a child run of its own, not a subtest of this one
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${escapeRe(name)}$`, testRel],
    { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let log = [];
  try { log = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { log = []; }
  rmSync(dir, { recursive: true, force: true });
  const lines = [...out.matchAll(/^\s*(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/gm)].filter((x) => x[2].trim() === name);
  const ran = lines.length > 0;
  const skipped = lines.some((x) => x[3]);
  const passed = ran && !skipped && lines.every((x) => x[1] === 'ok') && r.status === 0;
  return { ran, passed, skipped, log };
}
/**
 * Why the test `testRel > name` does not prove `targets` ([{ file, fn }] under orchestrate/), or [] when it does.
 * Proven: run as it is, it passes (not skipped, not a todo), and each target's own function reached a fakeAlert that
 * answered false and one that threw (seen on the stack); run with fakeAlert's false turned into true, it fails; run
 * with fakeAlert's throw turned into true, it fails. `answerUnused` (a lead call) excuses only the false flip: the code
 * acts the same whatever the alert answers (a red fact raised again every pass).
 */
export function runtimeProblems(root, testRel, name, targets, { answerUnused = null } = {}) {
  const out = [];
  const plain = runOneTest(root, testRel, name);
  if (!plain.ran) return [`the test did not run (no test by that exact name in ${testRel})`];
  if (plain.skipped) return ['the test is skipped or a todo when it runs, so it proves nothing'];
  if (!plain.passed) return ['the test fails'];
  for (const t of targets) {
    let abs = join(root, t.file);
    try { abs = realpathSync(abs); } catch { /* a stack frame names the real path; keep this one */ }
    // Reached: a frame in the target's file, named as the function or on a line inside it (an anonymous closure it
    // hands back, such as safeAlert's, has no name of its own on the stack).
    let span = null;
    try { span = fnLines(readFileSync(join(root, t.file), 'utf8'), t.fn); } catch { span = null; }
    const inFn = (f) => t.fn === '(top)' || f.fn === t.fn || (span && f.line >= span[0] && f.line <= span[1]);
    const reached = (outcome) => plain.log.some((l) => l.outcome === outcome && l.frames.some((f) => f.file === abs && inFn(f)));
    if (!reached('false')) out.push(`${t.file} ${t.fn} never reached a fakeAlert that answered false`);
    if (!reached('threw')) out.push(`${t.file} ${t.fn} never reached a fakeAlert that threw`);
  }
  if (!answerUnused && runOneTest(root, testRel, name, 'false').passed) out.push('it still passes when the lost alert answers true instead of false, so it never checks the answer');
  if (runOneTest(root, testRel, name, 'throws').passed) out.push('it still passes when the failing alert answers true instead of throwing, so it never checks the throw');
  return out;
}
/** runtimeProblems, run once per test and target set. */
export function runtimeCache(root) {
  const seen = new Map();
  return (testRel, name, targets, opts = {}) => {
    const k = JSON.stringify([testRel, name, targets, opts.answerUnused ?? null]);
    if (!seen.has(k)) seen.set(k, runtimeProblems(root, testRel, name, targets, opts));
    return seen.get(k);
  };
}

// The key that pins an entry: file, function, the call and what it goes through (via), call line hash, body hash.
// The call and via are in the key (L143 rerun, the auditor's F1b): two calls on one line, say `if (write(..)) await
// closeDecisionPr(..)`, share a line hash, and without them one could stand in for the other when the list is matched.
export const keyOf = (e) => `${e.file} | ${e.fn} | ${e.call} | ${e.via ?? ''} | ${e.hash} | ${e.body}`;

// ---- the files ----

// Test code: a *.test.mjs or *.test-helper.mjs, anything in a fixtures folder or a fixtures file, the test/ folder,
// or a file that imports node:test (shared/test-tmp.mjs). Everything else under orchestrate/ is production code.
export function isTestCode(rel, src) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  return /\.test(?:-helper)?\.mjs$/.test(base) || base.startsWith('fixtures') || parts.includes('fixtures') || parts[0] === 'test'
    || importsNodeTest(src);
}
// L143 Minor 6: a real import of node:test (`import ... from 'node:test'`, `import 'node:test'`, `import('node:test')`),
// found where the code says `import`, not in a comment or a string.
export function importsNodeTest(src) {
  const m = mask(src);
  for (const x of m.matchAll(/(?<![\w$.])import\b/g)) {
    if (/^import\s*(?:\(\s*|(?:[\w$*{}\s,]+?\s*from\s*)?)['"]node:test['"]/.test(src.slice(x.index, x.index + 300))) return true;
  }
  return false;
}
/** Every .mjs under `root` (orchestrate/): [{ rel, src, testCode }], `rel` '/'-separated. */
export function orchestrateFiles(root) {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.mjs') ? [p] : []);
  });
  return walk(root).sort().map((p) => {
    const rel = relative(root, p).split(sep).join('/');
    const src = readFileSync(p, 'utf8');
    return { rel, src, testCode: isTestCode(rel, src) };
  });
}

// ---- the list ----

export const LIST = 'test/alert-inventory.json';
export const readList = (root) => JSON.parse(readFileSync(join(root, LIST), 'utf8'));

/**
 * The inventory set against the list: { found, listed, fresh, gone, moved }. `fresh` is found with no listed entry of
 * the same pin; `gone` is listed with no found one. Pins match exactly (===) and as a multiset: two calls on two lines
 * of the same text in one function are two entries. `moved` pairs a fresh entry with a gone one of the same file,
 * function and call: the code changed there, so it needs a fresh look, and its status is a suggestion only.
 */
export function compare(found, listed) {
  const left = new Map();
  for (const e of listed) { const k = keyOf(e); left.set(k, [...(left.get(k) ?? []), e]); }
  const fresh = [];
  for (const e of found) {
    const k = keyOf(e);
    const xs = left.get(k);
    if (xs?.length) xs.shift(); else fresh.push(e);
  }
  const gone = [...left.values()].flat();
  const moved = [];
  const pool = gone.slice();
  for (const e of fresh) {
    const i = pool.findIndex((g) => g.file === e.file && g.fn === e.fn && g.call === e.call && (g.via ?? null) === (e.via ?? null));
    if (i >= 0) moved.push([e, pool.splice(i, 1)[0]]);
  }
  return { found, listed, fresh, gone, moved };
}

// ---- change control (L135 item 4): the list is the lead's ----

export const LEAD_BRANCH = /^(?:claude\/)?lead-/;
// The checker's own files (L139 item 6): only a lead PR changes them. safe-merge.sh refuses them too; this is the second layer.
// raise-contract.test.mjs (the wrapper contracts) and fake-alert.test-helper.mjs (what every contract runs) are added
// here too: a lane that weakens either would weaken every proof that rests on them.
export const LEAD_FILES = Object.freeze(['test/alert-inventory.json', 'test/alert-inventory.mjs', 'test/alert-inventory.test.mjs', 'test/alert-answer-scan.mjs',
  'test/alert-answer.test.mjs', 'test/raise-contract.test.mjs', 'test/fake-alert.test-helper.mjs']);
/** The lead-only files among `changed` (paths relative to the repo root). */
export const leadFilesIn = (changed) => changed.filter((p) => LEAD_FILES.some((f) => p === `orchestrate/${f}`));
const kindOf = (status) => (typeof status === 'string' ? status.split(':')[0] : 'bad');
/** Entries by status kind, and open ones by owner: { alerts: { open, ruled, tested }, open_by_owner: {...}, ... }. */
export function countList(list) {
  const out = {};
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) {
    const c = {};
    for (const e of list[k] ?? []) c[kindOf(e.status)] = (c[kindOf(e.status)] ?? 0) + 1;
    out[k] = c;
  }
  const by = {};
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) for (const e of list[k] ?? []) {
    const s = parseStatus(e.status);
    if (s.kind === 'open') { const o = `${s.owner} ${s.pr}`; by[o] = (by[o] ?? 0) + 1; }
  }
  out.open_by_owner = by;
  return out;
}
/**
 * What a change to the list does, base -> head, entry by entry (L143 Minor 1), and what a PR that is not the lead's may
 * not do. Each list is compared as a multiset of whole entries. A lane PR may only re-pin an open entry: the same
 * entry with only its pins (hash, body, text) changed, status and every other field kept (a ruled, tested or wrapped
 * entry was judged on the code as it was, so only the lead re-pins it). Everything else needs the lead: an entry added
 * or removed, a status changed (open to tested included: the lead checks the test), a field changed (lands_with,
 * note, via, covers ...), or any wrapper added, removed or changed. Returns { problems, would, summary }.
 */
const PIN_FIELDS = new Set(['hash', 'body', 'text']);
const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
const identity = (e) => stable(Object.fromEntries(Object.entries(e).filter(([k]) => !PIN_FIELDS.has(k))));
const label = (k, e) => `${k}: ${e.file}${e.fn ? ` ${e.fn}` : ''}${e.call ? ` ${e.call}` : ''}${e.via ? ` (via ${e.via})` : ''}`;
export function changeControl(base, head, { lead }) {
  const problems = [];
  const summary = [];
  const cb = countList(base);
  const ch = countList(head);
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) {
    const a = JSON.stringify(cb[k]); const b = JSON.stringify(ch[k]);
    summary.push(`${k}: ${a === b ? a : `${a} -> ${b}`}`);
  }
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) {
    const left = new Map();
    for (const e of base[k] ?? []) { const x = stable(e); left.set(x, [...(left.get(x) ?? []), e]); }
    const added = [];
    for (const e of head[k] ?? []) { const x = stable(e); const xs = left.get(x); if (xs?.length) xs.shift(); else added.push(e); }
    const removed = [...left.values()].flat();
    // Pure re-pins: a removed entry and an added one that differ only in their pins.
    const pool = removed.slice();
    const rest = [];
    for (const e of added) {
      const i = pool.findIndex((g) => identity(g) === identity(e));
      if (i >= 0) {
        pool.splice(i, 1);
        if (k === 'wrappers') problems.push(`${label(k, e)}: a wrapper was re-pinned; only a lead PR changes a wrapper (L143)`);
        else if (kindOf(e.status) !== 'open') problems.push(`${label(k, e)}: a "${kindOf(e.status)}" entry was re-pinned; the code it was judged on changed, so only a lead PR re-pins it (L135)`);
        continue;
      }
      rest.push(e);
    }
    // A removed entry with the same file/fn/call as an added one is a change to it, not a removal and an addition.
    const same = (g, e) => g.file === e.file && (g.fn ?? null) === (e.fn ?? null) && (g.call ?? null) === (e.call ?? null) && (g.via ?? null) === (e.via ?? null);
    for (const e of rest) {
      const i = pool.findIndex((g) => same(g, e));
      if (i >= 0) {
        const g = pool.splice(i, 1)[0];
        const what = Object.keys({ ...g, ...e }).filter((f) => !PIN_FIELDS.has(f) && stable({ v: g[f] ?? null }) !== stable({ v: e[f] ?? null }));
        problems.push(`${label(k, e)}: ${what.includes('status') ? `status "${g.status}" became "${e.status}"` : `${what.join(', ')} changed`}; only a lead PR changes an entry (L143 Minor 1)`);
        continue;
      }
      if (k === 'wrappers') problems.push(`${label(k, e)}: a wrapper was added; only a lead PR adds a wrapper (L135)`);
      else problems.push(`${label(k, e)}: a new "${kindOf(e.status)}" entry; only a lead PR adds one (a new alert call needs a test that runs fakeAlert({ answer: false }) and fakeAlert({ throws }), or a lead call)`);
    }
    for (const g of pool) problems.push(`${label(k, g)} (${g.status}) was removed; only a lead PR takes an entry off the list (L143 Minor 1)`);
  }
  return { problems: lead ? [] : problems, would: problems, summary };
}

// `node orchestrate/test/alert-inventory.mjs` prints what the list is missing and what it holds that the code no
// longer has, with the scanner's hints and a suggested status. It changes nothing: the lead writes the list.
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = orchestrateFiles(root);
  const prod = files.filter((f) => !f.testCode);
  const { fresh, gone, moved } = compare(inventory(prod), readList(root).alerts);
  const hints = new Map(prod.map((f) => [f.rel, hintsFor(f.src)]));
  const was = new Map(moved.map(([e, g]) => [e, g]));
  const show = (e) => `${e.file}:${e.line} ${e.fn} ${e.call}${e.via ? ` (via ${e.via})` : ''}\n    ${e.text.slice(0, 140)}`;
  console.log(`${fresh.length} not on the list, ${gone.length} on the list and gone (${moved.length} of them changed in place)\n`);
  for (const e of fresh) {
    const h = hints.get(e.file)?.get(e.line);
    const g = was.get(e);
    console.log(`${g ? 'CHANGED' : 'NEW'}  ${show(e)}`);
    if (h) console.log(`    scanner (${h.level}): ${h.why}`);
    console.log(`    pin: { "file": ${JSON.stringify(e.file)}, "fn": ${JSON.stringify(e.fn)}, "call": ${JSON.stringify(e.call)}, "hash": "${e.hash}", "body": "${e.body}" }`);
    console.log(`    status: ${g ? `was "${g.status}"; look again before keeping it` : `open: ${folderOwner(e.file)}, none yet`}\n`);
  }
  const back = new Set(moved.map(([, g]) => g));
  for (const g of gone) if (!back.has(g)) console.log(`GONE  ${g.file} ${g.fn} ${g.call} (${g.status})\n    ${g.text}\n`);
}
