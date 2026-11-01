// alert-answer-scan.mjs — the source scan (lead call L130). Since L135 it is a helper, not the gate: it suggests where
// an inventory entry needs a close look (`node orchestrate/test/alert-inventory.mjs` prints its hints), and its
// wrappers / standIns / silentDefaults feed alert-inventory.test.mjs's lists. alert-answer.test.mjs holds its controls.
//
// The class: code calls an alert, ignores whether it was delivered, then writes something that says it was (a "told"
// mark, a card moved to wait on Joe, a note that the owner was told, a state that stops the ask coming again) or answers
// told / sent / alerted. A lost alert (it answers false, or throws) then tells nobody, ever.
//
// A site is flagged when a call to an alert-like name (ALERT_NAMES, any name handed in as `alert:`, a `safeX` wrapper)
//   (a) has its answer unused: the call is a whole statement (bare, or the body of an `if`, `else`, `for`, `try`), or
//   (b) has its answer replaced by a constant: such a statement with `return true`, `told: true` or `sent = true` after it,
// AND something is written near it (WRITE_CALL, TOLD_MARK): earlier in its own block, in the test of the `if` that guards
// it (and the `x = ...` of a guarding `x.ok`), or in the code that runs next (the rest of its block and on out of the
// blocks around it, up to the end of the function, the first jump, or AFTER_LINES lines).
// Allowed, by construction: `tellThen(alert, text, mark)` (the alert is handed in, not called here) and
// `if (alert(...) !== false) { follow-up }` (the answer is used: it is the guard's test).
//
// It is a scan, not a parser. Strings, template literals, regex literals and comments are blanked first, so a word in a
// text never counts, and a call is found by its name. What it cannot see is listed at the top of alert-answer.test.mjs.
// With `wholeFn` (L135 item 3), a write anywhere in the enclosing named function counts, before or after the call.

// The alert-like names (L130). A member call counts whatever its object (`ctx.alert`, `store.alert`, `homeAlerts.raise`).
export const ALERT_NAMES = Object.freeze(['alert', 'outbox', 'say', 'tellOnce', 'notify', 'raise']);
const BEFORE_LINES = 6;
const AFTER_LINES = 8;
const GUARD_LINES = 10;

// Blank strings, template literals' text, regex literals and comments to spaces, keeping every newline and index. The
// code inside a template's ${ } stays code, so `${alert(x)}` is still a call.
// With `keepTemplates`, a template literal's text stays as code too: a test that writes a script out from a template
// (`ports: { alert: () => {} }` inside backticks) still shows its stand-in.
// With `commentsOnly`, only comments are blanked (the body hash in alert-inventory.mjs ignores a comment change).
export function mask(src, { keepTemplates = false, commentsOnly = false } = {}) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let prevSig = '';
  let prevWord = '';
  const blankAll = (a, b) => { for (let k = a; k < b; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const blank = (a, b) => { if (!commentsOnly) blankAll(a, b); };
  // Pure skippers: the index of a quote's closing quote; just past a template; the `}` that closes a `${`.
  const skipQuote = (j) => { const q = src[j]; for (j += 1; j < n; j += 1) { if (src[j] === '\\') { j += 1; continue; } if (src[j] === q || src[j] === '\n') return j; } return n; };
  const skipTemplate = (j) => {
    for (j += 1; j < n; j += 1) {
      if (src[j] === '\\') { j += 1; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') j = interpEnd(j + 2);
    }
    return n;
  };
  const interpEnd = (j) => {
    let depth = 0;
    for (; j < n; j += 1) {
      const c = src[j];
      if (c === '\'' || c === '"') { j = skipQuote(j); continue; }
      if (c === '`') { j = skipTemplate(j) - 1; continue; }
      if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e < 0 ? n : e; continue; }
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 1; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') { if (depth === 0) return j; depth -= 1; }
    }
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blankAll(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blankAll(i, end); i = end; continue; }
    if (c === '`' && keepTemplates) { prevSig = c; prevWord = ''; i += 1; continue; }
    if (c === '`') {
      let j = i + 1;
      let lit = j;
      for (; j < n; j += 1) {
        if (src[j] === '\\') { j += 1; continue; }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(lit, j);
          const end = interpEnd(j + 2);
          const inner = mask(src.slice(j + 2, end), { commentsOnly });
          for (let k = 0; k < inner.length; k += 1) out[j + 2 + k] = inner[k];
          j = end; lit = end + 1;
        }
      }
      blank(lit, j);
      i = j + 1; prevSig = c; prevWord = '';
      continue;
    }
    if (c === '\'' || c === '"') {
      const j = skipQuote(i);
      blank(i + 1, j);
      i = j + 1; prevSig = c; prevWord = '';
      continue;
    }
    if (c === '/' && (prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || /^(return|typeof|case|do|else|in|of|void|yield|await)$/.test(prevWord))) {
      let j = i + 1;
      let cls = false;
      for (; j < n && src[j] !== '\n'; j += 1) {
        if (src[j] === '\\') { j += 1; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
      }
      blank(i + 1, j);
      i = j + 1; prevSig = '/'; prevWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j])) j += 1;
      prevWord = src.slice(i, j); prevSig = 'a'; i = j; continue;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ''; }
    i += 1;
  }
  return out.join('');
}

// Matching brackets of a masked text: the index of an opener -> its closer, and back.
export function pairs(m) {
  const match = new Map();
  const stack = [];
  for (let i = 0; i < m.length; i += 1) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') stack.push(i);
    else if (c === ')' || c === ']' || c === '}') { const o = stack.pop(); if (o !== undefined) { match.set(o, i); match.set(i, o); } }
  }
  return match;
}

export const lineOf = (text, i) => { let n = 1; for (let k = 0; k < i; k += 1) if (text.charCodeAt(k) === 10) n += 1; return n; };
const prevIdx = (m, i) => { let k = i - 1; while (k >= 0 && /\s/.test(m[k])) k -= 1; return k; };
const nextIdx = (m, i) => { let k = i; while (k < m.length && /\s/.test(m[k])) k += 1; return k; };
// The word ending at index `end` and the index just before it.
const wordBefore = (m, end) => { let k = end; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1; return [m.slice(k + 1, end + 1), k]; };
const lineStart = (m, i) => m.lastIndexOf('\n', i - 1) + 1;
const linesBack = (m, i, n) => { let k = lineStart(m, i); for (let t = 0; t < n && k > 0; t += 1) k = lineStart(m, k - 1); return k; };
const linesOn = (m, i, n) => { let k = i; for (let t = 0; t < n; t += 1) { const e = m.indexOf('\n', k); if (e < 0) return m.length; k = e + 1; } return k; };
const HEADS = /^(if|for|while|switch|catch|with)$/;

// What opens the block at `open`: { kind: 'fn' | 'if' | 'else' | 'loop' | 'try' | 'catch' | 'finally' | 'other', name, head }.
// `head` is the `(` ... `)` before it, for an if, loop or catch; `name` a function's name (null when unnamed).
function blockKind(m, match, open) {
  const p = prevIdx(m, open);
  if (p < 0) return { kind: 'other' };
  if (m[p] === '>' && m[p - 1] === '=') {
    let q = prevIdx(m, p - 1);
    q = m[q] === ')' ? prevIdx(m, match.get(q)) : wordBefore(m, q)[1];
    let [w, k] = wordBefore(m, q);
    if (w === 'async') { q = k; [w, k] = wordBefore(m, prevIdx(m, q + 1)); q = prevIdx(m, q + 1); }
    const name = ((m[q] === '=' && !'=!<>'.includes(m[q - 1])) || m[q] === ':') ? wordBefore(m, prevIdx(m, q))[0] || null : null;
    return { kind: 'fn', name };
  }
  const [w0] = wordBefore(m, p);
  if (w0 === 'else' || w0 === 'try' || w0 === 'finally' || w0 === 'catch' || w0 === 'do') return { kind: w0 === 'do' ? 'loop' : w0 };
  if (m[p] !== ')') return { kind: 'other' };
  const o = match.get(p);
  if (o === undefined) return { kind: 'other' };
  const [w, k] = wordBefore(m, prevIdx(m, o));
  const head = { open: o, close: p };
  if (w === 'if') return { kind: 'if', head };
  if (w === 'for' || w === 'while') return { kind: 'loop', head };
  if (w === 'catch') return { kind: 'catch', head };
  if (w === 'switch' || w === 'with') return { kind: 'other', head };
  if (w === 'function') { const e = prevIdx(m, k + 1); return { kind: 'fn', name: (m[e] === '=' || m[e] === ':') ? wordBefore(m, prevIdx(m, e))[0] || null : null }; }
  if (!w) return { kind: 'other' };
  return { kind: 'fn', name: w };   // `function name(`, `async function name(`, a method `name(args) {`
}

export function blocks(m, match) {
  const out = [];
  for (let i = 0; i < m.length; i += 1) if (m[i] === '{' && match.has(i)) out.push({ open: i, close: match.get(i), ...blockKind(m, match, i) });
  return out;
}
const innermost = (bl, i) => { let best = null; for (const b of bl) if (b.open < i && i <= b.close && (!best || b.open > best.open)) best = b; return best; };
export function fnAt(bl, i) {
  let best = null;
  for (const b of bl) if (b.kind === 'fn' && b.name && b.open < i && i < b.close && (!best || b.open > best.open)) best = b;
  return best?.name ?? '(top)';
}
export const namedFnBlockAt = (bl, i) => { let best = null; for (const b of bl) if (b.kind === 'fn' && b.name && b.open < i && i < b.close && (!best || b.open > best.open)) best = b; return best; };
export const fnBlockAt = (bl, i) => { let best = null; for (const b of bl) if (b.kind === 'fn' && b.open < i && i < b.close && (!best || b.open > best.open)) best = b; return best; };

// Names handed in as `alert:` (`{ alert: tell }` in parameters or an argument), so `tell(...)` is an alert too.
export function handedNames(m) {
  const out = new Set();
  for (const x of m.matchAll(/\balert\s*:\s*([A-Za-z_$][\w$]*)\s*[,}=]/g)) if (!ALERT_NAMES.includes(x[1]) && !['true', 'false', 'null', 'undefined'].includes(x[1])) out.add(x[1]);
  return [...out];
}

// What counts as a write near an alert (L130): a record write, put or commit, a note, waitOn or a move, a saved state
// file (writeFileSync, save), markSeen, and a told mark (`told`, `sent`, `alerted`, `notified`, `warned`: set to
// something other than false or null, or added or pushed to). `return true` counts in the alert's own block only (b).
// L135 item 3 widens it: renameSync, rmSync, unlinkSync, ftruncateSync, appendFileSync, and `.set(` / `.update(` /
// `.add(` (a seen-set or a store that stops the alert coming again).
export const WRITE_CALL = /(?<![\w$])(?:write\w*|put\w*|commit\w*|save\w*|markSeen|waitOn|move\w*|note|addNote|applyOutbox|rename\w*|rm\w*|unlink\w*|f?truncate\w*|append\w*)\s*(?:\?\.)?\s*\(|\.\s*(?:set|update|add)\s*(?:\?\.)?\s*\(/g;
const TOLD = String.raw`(?:told|sent|alerted|notified|warned)\w*`;
export const TOLD_MARK = new RegExp(String.raw`(?<![\w$])${TOLD}\s*(?:\.(?:add|push|set)\s*\(|=(?![=>])\s*(?!false\b|null\b)|:\s*true\b)|\[\s*${TOLD}\s*\]\s*=(?!=)`, 'g');
const RETURN_TRUE = /\breturn\s+true\b/g;

// Every write in m[a, b): [{ at, what }]. `skipVars` are variables guarded as `!x.ok`: their own `x = write(...)` is the
// write that failed, which the alert reports, not a mark it vouches for.
function writesIn(m, a, b, { skipVars = [], returnTrue = false } = {}) {
  if (b <= a) return [];
  const found = [];
  for (const re of returnTrue ? [WRITE_CALL, TOLD_MARK, RETURN_TRUE] : [WRITE_CALL, TOLD_MARK]) {
    re.lastIndex = 0;
    for (const x of m.slice(a, b).matchAll(re)) {
      const at = a + x.index;
      const head = m.slice(lineStart(m, at), at);
      if (re === TOLD_MARK && /\b(?:const|let|var)\s+[\w$,{}\s]*$/.test(head)) continue;   // a declaration, not a mark
      if (re === TOLD_MARK && /^[\w$]+\s*=\s*[\w$.]+\.filter\s*\(/.test(m.slice(at, at + 200))) continue;   // a reset: told = told.filter(...)
      if (skipVars.some((v) => new RegExp(String.raw`\b${v}\s*=(?!=)[^;]*$`).test(head))) continue;
      found.push({ at, what: x[0].replace(/\s+/g, ' ').replace(/\s*(\?\.)?\s*\($/, '(').trim() });
    }
  }
  return found;
}

// Where the code from `from` stops: the end of its first jump statement at depth 0, or `end`. A jump that is the body
// of a braceless `if (...)` or `else` only may happen, so the scan goes on past it.
function untilJump(m, from, end) {
  let depth = 0;
  for (let i = from; i < end; i += 1) {
    const c = m[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0 && /[rcbt]/.test(c) && !/[\w$.]/.test(m[i - 1] ?? '') && /^(return|continue|break|throw)\b/.test(m.slice(i, i + 9))) {
      const p = prevIdx(m, i);
      const conditional = m[p] === ')' || wordBefore(m, p)[0] === 'else';
      let d = 0;
      let j = i;
      for (; j < end; j += 1) {
        if ('([{'.includes(m[j])) d += 1; else if (')]}'.includes(m[j])) d -= 1;
        else if (m[j] === ';' && d === 0) break;
      }
      if (!conditional) return { stop: Math.min(j + 1, end), jumped: true };
      i = j;
    }
  }
  return { stop: end, jumped: false };
}

// Past any `else` / `catch` / `finally` branch that starts at `from`: the code after the whole if or try statement.
function pastBranches(m, match, from) {
  for (;;) {
    const nx = nextIdx(m, from);
    const w = /^(else|catch|finally)\b/.exec(m.slice(nx, nx + 8))?.[1];
    if (!w) return from;
    let q = nextIdx(m, nx + w.length);
    if (w === 'else' && /^if\b/.test(m.slice(q, q + 3))) q = nextIdx(m, q + 2);
    if (m[q] === '(') q = nextIdx(m, match.get(q) + 1);
    if (m[q] === '{') from = match.get(q) + 1;
    else { let d = 0; let j = q; for (; j < m.length; j += 1) { if ('([{'.includes(m[j])) d += 1; else if (')]}'.includes(m[j])) d -= 1; else if (m[j] === ';' && d === 0) break; } from = j + 1; }
  }
}

// The `if (...)` header an `else` belongs to (`elseAt` is the index of the `e`), or null.
function ifBeforeElse(m, match, elseAt) {
  const p = prevIdx(m, elseAt);
  let q = p;
  if (m[p] === '}') q = match.get(p);
  else { // a braceless body: the statement `[else] if (...) body;` that ends at p starts after a `;`, `{` or `}`
    let d = 0; let j = p - 1;
    for (; j > 0; j -= 1) { const c = m[j]; if (d === 0 && ';{}'.includes(c)) break; if (')]'.includes(c)) d += 1; else if ('(['.includes(c)) d -= 1; }
    let t = nextIdx(m, j + 1);
    if (/^else\b/.test(m.slice(t, t + 5))) t = nextIdx(m, t + 4);
    if (!/^if\s*\(/.test(m.slice(t, t + 40))) return null;
    const o = m.indexOf('(', t);
    return { open: o, close: match.get(o), negated: true };
  }
  const h = prevIdx(m, q);
  if (m[h] !== ')') return null;
  const o = match.get(h);
  return o !== undefined && wordBefore(m, prevIdx(m, o))[0] === 'if' ? { open: o, close: h, negated: true } : null;
}

// Variables a guard tests as a write's result: `x.ok` / `x?.ok` (went through), `!x.ok` / `x.ok === false` (refused).
function guardVars(head, negated) {
  const pos = [];
  const neg = [];
  for (const x of head.matchAll(/(!\s*)?\b([A-Za-z_$][\w$]*)\s*\??\.\s*ok\b(\s*===?\s*false)?/g)) ((Boolean(x[1]) !== Boolean(x[3])) !== negated ? neg : pos).push(x[2]);
  return { pos, neg };
}

// The call at `nameAt` is a whole statement: returns { braceless guard | null, braceless: bool } or null when its
// answer is used (an argument, an assignment, a test, a return, a concise arrow's body, `alert(x).then`).
function asStatement(m, match, calleeStart, close) {
  let p = prevIdx(m, calleeStart);
  let [w, k] = wordBefore(m, p);
  while (w === 'await' || w === 'void') { p = prevIdx(m, k + 1); [w, k] = wordBefore(m, p); }
  const after = nextIdx(m, close + 1);
  if (after < m.length && m[after] !== ';' && m[after] !== '}') return null;
  if (p < 0 || m[p] === ';' || m[p] === '{' || m[p] === '}') return { guard: null, braceless: false };
  if (w === 'else') return { guard: ifBeforeElse(m, match, k + 1), braceless: true };
  if (w === 'try' || w === 'finally' || w === 'do') return { guard: null, braceless: false };
  if (m[p] === ')') {
    const o = match.get(p);
    const [hw] = wordBefore(m, prevIdx(m, o));
    if (hw === 'if') return { guard: { open: o, close: p, negated: false }, braceless: true };
    if (hw === 'for' || hw === 'while') return { guard: null, braceless: true };
  }
  return null;
}

// The `for` / `while` keyword whose braceless body starts at `calleeStart`.
function statementHead(m, match, calleeStart) {
  const p = prevIdx(m, calleeStart);
  return m[p] === ')' ? wordBefore(m, prevIdx(m, match.get(p)))[1] + 1 : calleeStart;
}

// Every flagged alert-site in one file's source: [{ line, fn, call, text, why }]. Since L135 this is a helper: it
// suggests which alert-inventory.json entries are likely open, and decides nothing.
// `wholeFn`: look for a write anywhere in the enclosing function (before or after, any block, any guard) instead of
// the windows below; that is the wider, noisier "possible" hint (L135 item 3).
export function alertSites(src, { wholeFn = false } = {}) {
  const m = mask(src);
  const match = pairs(m);
  const bl = blocks(m, match);
  // A `safeX` wrapper defined in the file is called like an alert too (`safeAlert(...)`), so its calls are sites.
  const safe = [...m.matchAll(/(?:\bfunction\s+|\b(?:const|let|var)\s+)(safe[A-Z][\w$]*)/g)].map((y) => y[1]);
  const names = [...new Set([...ALERT_NAMES, ...handedNames(m), ...safe])];
  const carriers = new Set();
  const out = sitesFor(src, m, match, bl, names, carriers, { wholeFn });
  // One step out (L133): a function of this file that drops an alert's answer, and answers nothing itself, is an alert
  // whose answer is lost, so a plain call to it (not `x.name(`) next to a write is a site too. That catches the write-first shape: `if (write(...)) closeX()`,
  // where closeX ignores its alert, ends the retry before anyone is told.
  const defined = new Set([...m.matchAll(/(?:\bfunction\s*\*?\s*|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g)].map((y) => y[1]));
  // Only a function that answers nothing (no `return <value>`): one that answers something hands its caller a signal.
  const silent = (n) => bl.filter((b) => b.kind === 'fn' && b.name === n).every((b) => !/\breturn\s+[^\s;}]/.test(m.slice(b.open + 1, b.close)));
  const isWrite = (n) => { WRITE_CALL.lastIndex = 0; return WRITE_CALL.test(`${n}(`); };
  const extra = [...carriers].filter((n) => defined.has(n) && !names.includes(n) && n !== 'tellThen' && !isWrite(n) && silent(n));
  if (extra.length) out.push(...sitesFor(src, m, match, bl, extra, null, { bare: true, wholeFn }).map((x) => ({ ...x, carrier: true })));
  return out.sort((a, b) => a.line - b.line);
}

// The sites for calls to `names`; `carriers` (when given) collects each function that holds a call whose answer is dropped.
// `bare`: only plain calls count, not member calls (`events.push(` is not the file's own `push(`).
function sitesFor(src, m, match, bl, names, carriers, { bare = false, wholeFn = false } = {}) {
  const nameRe = new RegExp(String.raw`(?<![\w$])(${names.join('|')})\s*(?:\?\.\s*)?\(`, 'g');
  const lines = src.split('\n');
  const out = [];
  for (const x of m.matchAll(nameRe)) {
    const nameAt = x.index;
    const open = m.indexOf('(', nameAt + x[1].length);
    const close = match.get(open);
    if (close === undefined) continue;
    if (wordBefore(m, prevIdx(m, nameAt))[0] === 'function') continue;   // `function raise(`: a definition
    if (m[nextIdx(m, close + 1)] === '{') continue;                       // a method `raise(args) {`
    if (bare && m[prevIdx(m, nameAt)] === '.') continue;
    let calleeStart = nameAt;   // back over `obj.`, `obj?.`, `a[b].`, `this.`
    for (;;) {
      let p = prevIdx(m, calleeStart);
      if (m[p] !== '.') break;
      p = prevIdx(m, m[p - 1] === '?' ? p - 1 : p);
      if (m[p] === ']') { const o = match.get(p); if (o === undefined) break; const [w2, k2] = wordBefore(m, prevIdx(m, o)); calleeStart = w2 ? k2 + 1 : o; continue; }
      const [w, k] = wordBefore(m, p);
      if (!w) break;
      calleeStart = k + 1;
    }
    const st = asStatement(m, match, calleeStart, close);
    if (!st) {
      // The answer is used. Whole-function mode still hints a write BEFORE it (L133, audit #93 r1 M-2): a state that
      // stops a re-ask, written first, stands whatever the alert answers.
      if (!wholeFn) continue;
      const fnN = namedFnBlockAt(bl, nameAt);
      const before = writesIn(m, fnN ? fnN.open + 1 : 0, calleeStart);
      if (!before.length) continue;
      const line = lineOf(m, nameAt);
      out.push({ line, fn: fnAt(bl, nameAt), call: src.slice(calleeStart, open).replace(/\s+/g, ''), text: lines[line - 1].trim(),
        why: `written before it: ${[...new Set(before.map((w) => w.what))].join(', ')}`, before: true });
      continue;
    }
    if (carriers) carriers.add(fnAt(bl, nameAt));
    const callEnd = m[nextIdx(m, close + 1)] === ';' ? nextIdx(m, close + 1) + 1 : close + 1;
    const fnB = fnBlockAt(bl, nameAt);
    const fnOpen = fnB ? fnB.open : -1;
    const fnClose = fnB ? fnB.close : m.length;
    const own = innermost(bl, calleeStart);
    // The guards: a braceless `if (g) alert()` / `else alert()`, the `if (g) {` / `else {` of its own block, and each
    // `if` / `else` block around that (within GUARD_LINES lines above the call): the alert runs because they held.
    const guards = [];
    if (st.guard) guards.push(st.guard);
    for (let b = own; b && b.kind !== 'fn'; b = innermost(bl, b.open)) {
      const g = b.kind === 'if' ? { ...b.head, negated: false } : b.kind === 'else' ? ifBeforeElse(m, match, wordBefore(m, prevIdx(m, b.open))[1] + 1) : null;
      if (g && g.open >= linesBack(m, calleeStart, GUARD_LINES)) guards.push(g);
    }
    const pos = [];
    const neg = [];
    for (const g of guards) { const v = guardVars(m.slice(g.open + 1, g.close), g.negated); pos.push(...v.pos.map((n) => [n, g])); neg.push(...v.neg); }
    const writes = [];
    if (wholeFn) {
      const fnN = namedFnBlockAt(bl, nameAt) ?? fnB;
      const a = fnN ? fnN.open + 1 : 0;
      const z = fnN ? fnN.close : m.length;
      writes.push(...writesIn(m, a, z, { returnTrue: true }).filter((w) => w.at < calleeStart || w.at >= close));
    }
    // 1. Earlier in its own block: before the call, or before the `if` / `else` / `for` whose braceless body it is. A
    // try or catch body is see-through, so the lines before the try count too.
    const stmtAt = st.braceless ? (st.guard ? wordBefore(m, prevIdx(m, st.guard.open))[1] + 1 : statementHead(m, match, calleeStart)) : calleeStart;
    if (own && !wholeFn) {
      writes.push(...writesIn(m, Math.max(own.open + 1, linesBack(m, stmtAt, BEFORE_LINES)), stmtAt, { skipVars: neg }).filter((w) => innermost(bl, w.at) === own));
      if (['try', 'catch', 'finally'].includes(own.kind)) {
        let tryAt = own.open;
        if (own.kind !== 'try') { // back to the `try` keyword over `} catch (e) {`
          for (let j = own.open; j > 0; j -= 1) if (/^try\b/.test(m.slice(j, j + 4)) && !/[\w$]/.test(m[j - 1])) { tryAt = j; break; }
        } else tryAt = wordBefore(m, prevIdx(m, own.open))[1] + 1;
        const around = innermost(bl, tryAt);
        if (around && around.open >= fnOpen) writes.push(...writesIn(m, Math.max(around.open + 1, linesBack(m, tryAt, BEFORE_LINES)), tryAt, { skipVars: neg }).filter((w) => innermost(bl, w.at) === around));
      }
    }
    // 2. A guard's test, when the branch runs on a write that went through, and the `x = ...` of a guarding `x.ok`.
    if (!wholeFn) for (const g of guards) if (!g.negated) writes.push(...writesIn(m, g.open, g.close));
    for (const [v, g] of wholeFn ? [] : pos) {
      const ifAt = wordBefore(m, prevIdx(m, g.open))[1] + 1;
      const from = Math.max(fnOpen + 1, linesBack(m, ifAt, BEFORE_LINES));
      let last = null;
      for (const y of m.slice(from, ifAt).matchAll(new RegExp(String.raw`(?<![\w$.])${v}\s*=(?![=>])`, 'g'))) last = from + y.index;
      if (last !== null) { const e = m.indexOf(';', last); writes.push(...writesIn(m, last, e < 0 || e > ifAt ? ifAt : e)); }
    }
    // 3. The code that runs next: the rest of its block, then on out of each block around it (past an else or a
    // catch), until a jump, the function's end, or AFTER_LINES lines. `return true` counts only in its own block.
    const limit = Math.min(fnClose, linesOn(m, callEnd, AFTER_LINES));
    let from = st.braceless ? pastBranches(m, match, callEnd) : callEnd;
    let blk = innermost(bl, from > callEnd ? from - 1 : calleeStart);
    if (st.braceless && blk && from > blk.close) blk = innermost(bl, blk.open);
    let first = true;
    while (!wholeFn && from < limit) {
      const end = Math.min(blk ? blk.close : m.length, limit);
      const { stop, jumped } = untilJump(m, from, end);
      writes.push(...writesIn(m, from, stop, { returnTrue: first }));
      first = false;
      if (jumped || !blk || blk.kind === 'fn' || blk.close >= limit) break;
      from = ['if', 'else', 'try', 'catch'].includes(blk.kind) ? pastBranches(m, match, blk.close + 1) : blk.close + 1;
      blk = innermost(bl, blk.open);
    }
    const seen = new Set();
    const uniq = writes.filter((w) => !seen.has(w.at) && seen.add(w.at));
    if (!uniq.length) continue;
    const line = lineOf(m, nameAt);
    out.push({ line, fn: fnAt(bl, nameAt), call: src.slice(calleeStart, open).replace(/\s+/g, ''), text: lines[line - 1].trim(),
      why: [...new Set(uniq.sort((p, q) => p.at - q.at).map((w) => w.what))].join(', ') });
  }
  return out;
}

// A wrapper: a function named like an alert (ALERT_NAMES, or safeX / textX / tellX) that calls an alert.
// It must hand back the inner call's answer: each alert call in it is `return <call>` (or a concise arrow's body), or
// is tested `=== false` / `!== false` (#87's safeAlert: false on false, true otherwise, the same as `!== false`; L135).
// `return true` is allowed only in a wrapper that tests the answer, and no `catch` in it may return true.
// Returns every wrapper in one file's source: [{ fn, line, passes, why }].
export const isWrapperName = (n) => ALERT_NAMES.includes(n) || /^(?:safe|text|tell)[A-Z]/.test(n);
export function wrappers(src) {
  const m = mask(src);
  const match = pairs(m);
  const bl = blocks(m, match);
  const names = [...ALERT_NAMES, ...handedNames(m)];
  const nameRe = new RegExp(String.raw`(?<![\w$])(${names.join('|')})\s*(?:\?\.\s*)?\(`, 'g');
  const bodies = bl.filter((b) => b.kind === 'fn' && b.name && isWrapperName(b.name)).map((b) => ({ fn: b.name, a: b.open + 1, z: b.close, at: b.open }));
  for (const x of m.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>(?!\s*\{)/g)) {
    if (!isWrapperName(x[1])) continue;
    const a = x.index + x[0].length;
    let z = a; let depth = 0;
    for (; z < m.length; z += 1) { const c = m[z]; if ('([{'.includes(c)) depth += 1; else if (')]}'.includes(c)) { if (depth === 0) break; depth -= 1; } else if ((c === ';' || c === ',') && depth === 0) break; }
    bodies.push({ fn: x[1], a, z, at: x.index, concise: true });
  }
  const out = [];
  for (const b of bodies) {
    const calls = [...m.slice(b.a, b.z).matchAll(nameRe)].map((y) => b.a + y.index)
      .filter((i) => wordBefore(m, prevIdx(m, i))[0] !== 'function' && m[nextIdx(m, (match.get(m.indexOf('(', i)) ?? i) + 1)] !== '{');
    if (!calls.length) continue;
    const bad = [];
    let tests = 0;
    for (const i of calls) {
      let s = i;
      for (;;) { const p = prevIdx(m, s); if (m[p] !== '.') break; const [w, k] = wordBefore(m, prevIdx(m, m[p - 1] === '?' ? p - 1 : p)); if (!w) break; s = k + 1; }
      const before = prevIdx(m, s);
      const returned = wordBefore(m, before)[0] === 'return' || (m[before] === '>' && m[before - 1] === '=') || (b.concise && s === nextIdx(m, b.a));
      const close = match.get(m.indexOf('(', i));
      const tested = close !== undefined && /^\s*[!=]==\s*false\b/.test(m.slice(close + 1, close + 20));
      if (tested) tests += 1;
      if (!returned && !tested) bad.push(`line ${lineOf(m, i)} does not return the alert's answer`);
    }
    const body = m.slice(b.a, b.z);
    if (/\breturn\s+true\b/.test(body) && !tests) bad.push('it returns true');
    for (const c of body.matchAll(/\bcatch\b\s*(?:\([^()]*\))?\s*\{/g)) {
      const o = b.a + c.index + c[0].length - 1;
      if (/\breturn\s+true\b/.test(m.slice(o, match.get(o) ?? o))) bad.push('its catch returns true');
    }
    out.push({ fn: b.fn, line: lineOf(m, b.at), passes: bad.length === 0, why: bad.join('; ') });
  }
  return out;
}

// Alert stand-ins in test code: an alert port made from anything but fakeAlert() (L130; widened by L135 item 6).
// The port names: alert, notify, say, raise, an `alerts: { raise }` object. Not flagged (they already run the lost
// path; the test says to move them to fakeAlert): a stand-in whose body is `false` or that throws.
const PORT = String.raw`(?:alert|notify|say|raise)`;
const STANDIN = [
  new RegExp(String.raw`\b${PORT}\s*:\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>`, 'g'),                    // alert: (a) => alerts.push(a)
  new RegExp(String.raw`\b${PORT}\s*:\s*(?:async\s+)?function\b`, 'g'),                                                // alert: function (a) {}
  new RegExp(String.raw`(?:\b(?:const|let|var)\s+|\.)${PORT}\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>`, 'g'), // const alert = (t) =>, ctx.alert = (a) =>
  new RegExp(String.raw`(?:\b(?:const|let|var)\s+|\.)${PORT}\s*=\s*(?:async\s+)?function\b`, 'g'),                    // ctx.alert = function () {}
  new RegExp(String.raw`\b${PORT}\s*\?\?\s*\(?\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>`, 'g'),                       // alert ?? ((t) => ...)
  new RegExp(String.raw`\b${PORT}\s*=\s*(?:async\s+)?\(\s*[^()]*\)\s*=>`, 'g'),                                         // a parameter default: { alert = () => {} }
  new RegExp(String.raw`\b${PORT}\s*:\s*[\w$.]+\.push\.bind\b`, 'g'),                                                  // alert: alerts.push.bind(alerts)
  new RegExp(String.raw`^\s*(?:async\s+)?${PORT}\s*\([^()]*\)\s*\{`, 'gm'),                                            // alert(a) { ... } in an object
  new RegExp(String.raw`\bfunction\s+${PORT}\s*\(`, 'g'),                                                                // function alert(t) { ... }
  new RegExp(String.raw`\b${PORT}\s*[:=]\s*(?:[\w$]+\.)?mock\.fn\s*\(`, 'g'),                                          // alert: mock.fn()
  new RegExp(String.raw`\b${PORT}\s*:\s*(?:noop|sink|ignore)\b`, 'g'),                                                    // alert: noop
  /\bfakeIssues\s*\(/g,                                                                                                 // M13's GitHub stand-in: every raise succeeds
];
// A stand-in that already answers false or throws (its body after `=>`, or a function's first statement).
const LOSES = /^\s*(?:false\b|\(\s*false\s*\)|\{\s*(?:throw\b|return\s+false\b))/;
export function standIns(src) {
  const m = mask(src, { keepTemplates: true });
  const lines = new Map();
  const text = src.split('\n');
  // Named sinks: `alert: sink` where the file makes `sink` from a function literal.
  const fns = new Set([...m.matchAll(/(?:\bfunction\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g)].map((y) => y[1] ?? y[2]));
  const res = [...STANDIN, new RegExp(String.raw`\b${PORT}\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])`, 'g')];
  for (const re of res) {
    re.lastIndex = 0;
    for (const x of m.matchAll(re)) {
      if (re === res[res.length - 1] && !fns.has(x[1])) continue;
      if (re === res[res.length - 1] && /^fakeAlert$/.test(x[1])) continue;
      const after = m.slice(x.index + x[0].length, x.index + x[0].length + 60);
      const line = lineOf(m, x.index);
      if (/=>$/.test(x[0]) && LOSES.test(after)) { if (!lines.has(line)) lines.set(line, 'loses'); continue; }
      lines.set(line, 'standin');
    }
  }
  return [...lines].filter(([, k]) => k === 'standin').map(([line]) => line).sort((a, b) => a - b).map((line) => ({ line, text: text[line - 1].trim() }));
}
/** Stand-ins that already answer false or throw: not flagged, but the test names them so they move to fakeAlert. */
export function losingStandIns(src) {
  const m = mask(src, { keepTemplates: true });
  const out = [];
  for (const re of STANDIN.slice(0, 6)) {
    re.lastIndex = 0;
    for (const x of m.matchAll(re)) if (/=>$/.test(x[0]) && LOSES.test(m.slice(x.index + x[0].length, x.index + x[0].length + 60))) out.push(lineOf(m, x.index));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// A production alert that answers nothing: under `if (alert(...) !== false)` its undefined counts as sent, so a lost
// alert passes the allowed form (widened by L135 item 6). The forms:
//   alert = () => {}, alert = (t) => {}, alert = () => undefined, alert = noop      a parameter default
//   { alert: tell = () => {} }                                                     the same, renamed
//   ctx.alert ?? (() => {}), alert: ctx.alert ?? noop                               a fallback
//   alert: (t) => log(t), alert: (t) => console.error(t)                            a port that only logs
//   ctx.alert?.(x), alert?.(x)                                                      an absent alert answers undefined
const NAME = String.raw`(?:[\w$]*[Aa]lerts?|notify|say|tellOnce|raise)`;
const NOTHING = String.raw`(?:(?:async\s*)?\([^()]*\)\s*=>\s*(?:\{\s*\}|undefined\b|void\s+0\b|null\b)|noop\b)`;
const SILENT_FORMS = [
  new RegExp(String.raw`\b${NAME}\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=(?![=>])\s*\(?\s*${NOTHING}`, 'g'),
  new RegExp(String.raw`\b${NAME}\s*\?\?\s*\(?\s*${NOTHING}`, 'g'),
  new RegExp(String.raw`\b${NAME}\s*:\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*\}|log\s*\(|console\.\w+\s*\(|process\.std\w+\.write\s*\()`, 'g'),
  new RegExp(String.raw`\b${NAME}\s*:\s*${NOTHING}`, 'g'),
  new RegExp(String.raw`(?<![\w$])(?:alert|notify|say)\s*\?\.\s*\(`, 'g'),
];
export function silentDefaults(src) {
  const m = mask(src);
  const text = src.split('\n');
  const at = new Set();
  for (const re of SILENT_FORMS) { re.lastIndex = 0; for (const x of m.matchAll(re)) at.add(lineOf(m, x.index)); }
  return [...at].sort((a, b) => a - b).map((line) => ({ line, text: text[line - 1].trim() }));
}
