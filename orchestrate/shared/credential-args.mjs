// R-0b-179 (b), L1148 F6: no credential goes on a command line. On a Mac /bin/ps is setuid root (system-protected), so every
// Mac user, the builder among them, reads every process's full command line; the environment is shown only to the
// process's own user (measured in L1148 F7). So a token, key or password a child needs goes in its environment
// (safe-git.mjs GIT_CONFIG_*), a file it reads (watch-run --token-file), or its stdin, never in its arguments.
//
// A source scan, run over every module by credential-args.test.mjs. A pattern list, not a parser (#556 r1, L1158): what it
// can not read is listed for review, never passed in silence. It reads:
//   every string in the source   a credential flag anywhere in it (`--token`, `--password=…`, `--auth`, `--pass`, so a
//                                shell script in a string, `sh -c`, execSync, a launchd job's script, is read too), a
//                                `NAME_TOKEN=${…}` / `password=${…}` setting, `-p${…}`, `-u ${user}:${…}`, a URL with a
//                                password in it, `x-access-token:${…}@` (so a URL built in a variable first is read, r2 B)
//   every argument list          of a call that starts a program (CALL, an alias of one by promisify, import or require,
//                                and `.run`/`.spawn`/… on any object), of an array given a name that is used as one
//                                (`args`, `argv`, `cmd`, or a name passed to spawn), of an `args: [...]` property, each
//                                push/unshift/concat/splice or `NAME[i] =` onto such a name, and each launchd
//                                ProgramArguments list: a name that says it holds a credential (`token`, `appKey`,
//                                `cfg.secret`, `secrets.gh`, `cfg?.token`, `cfg['token']`, and `tok`, `pw`, `key` alone),
//                                an Authorization header, `Bearer ${…}`, `x-access-token:`, `-u` then `user:${…}`
//   lists passed through helpers (#556 r2 A) a list that is a parameter, or spreads one: each caller in this module is read
//                                at that parameter (rest parameters too), up to HELPER_DEPTH helpers deep. A list a helper
//                                of this module returns: the lists in its body are read, with a parameter it spreads,
//                                slices or hands back read from the call's own argument. A spread of a name this module
//                                fills (`const BASE = [...]`, `Object.freeze([...])`) is read where it is filled.
//   everything else              listed as `unread`, never passed: a list from another module (an imported constant, an
//                                imported helper's result), a helper exported or called as a method (its callers are
//                                elsewhere), one never called by name here, an unnamed function's parameter, a list built
//                                by code (`.map`, `.filter`), and forwarding deeper than HELPER_DEPTH. The whole-tree test
//                                holds each one against a reviewed list with the reason it is safe.
// The safe forms pass: a flag or name that says where a credential is or what it is (`--token-file`, `tokenPath(cfg)`,
// `secretKind`), a count (`--max-tokens`, `maxTokens`, `tokens`), a switch (`--no-token`, `--secret-scan`), a helper's name
// (`credentialHelper`), and a port in a URL (`https://host:443/`). An options object after the list (`{ env: { GH_TOKEN:
// token } }`) is the safe place and is never read as a list. exec and execSync take one command string, read as a string.
// Known limits (it is a pattern list): a credential under a name that does not say so; a list named in one module and
// passed to a runner in another is read only where it is written out (the reviewed list says which); a function written
// in a shape this file does not find (a class field, a getter) is not followed, so what reaches a start call through it is
// listed unread rather than read; `.exec` on an object is RegExp's and is not read as a start call. It is a tripwire for the easy
// mistake, not a proof; the proof is that the code passes what it must through the environment, which the push and the
// watch job do today.

const SPAWN_FAMILY = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
/** Calls that start a program, and the plist helper the job files build ProgramArguments with. */
const CALL_NAMES = [...SPAWN_FAMILY, 'exec', 'execSync', 'runChild', 'run', 'runGit', 'gitOk', 'git', 'arr'];
/** Where each start call's argument list is: spawn(bin, args), io.run(bin, args), git(args, opts), arr([...]). exec and
 * execSync take one command string, read as a string. */
const LIST_AT = { spawn: 1, spawnSync: 1, execFile: 1, execFileSync: 1, fork: 1, run: 1, runChild: 1, runGit: 0, gitOk: 0, git: 0, arr: 0 };
/** Followed through helpers of the same module at most this deep before a list is listed as unread. */
const HELPER_DEPTH = 4;
const PLIST = /ProgramArguments/g;
/** A name used as an argument list wherever it is built. */
const ARGLIKE = /(?:args|argv|cmd|command)$/i;

const CRED_WORD = /(?:token|secret|passw(?:or)?d|passphrase|api[-_]?key|private[-_]?key|app[-_]?key|bearer|credential|cookie)/i;
/** Names that are a credential with no word for it: `tok`, `pw`, `key` alone. */
const CRED_EXACT = /^(?:tok|pw|pwd|passwd|pass|key|auth)$/i;
/** A name ending like this says where a credential is kept, what it is, or how many: it may go on a command line. */
const SAFE_END = /(?:file|files|path|paths|dir|fd|name|names|id|ids|kind|kinds|fact|count|counts|max|min|re|pattern|problem|why|env|var|vars|url_?env|length|len|seen|ok|label|key_file|keyfile|place|where|exists|mode|owner|uid|source|tokens|tokenizer|helper|jar|scan|limit|type)$/i;
/** … or starting like this: a count or a switch about one (`maxTokens`, `noToken`, `hasSecret`). */
const SAFE_START = /^(?:max|min|num|no|has|is|want|use|with)(?=[A-Z_])/;
/** A flag whose word is a credential, unless it names a place, a kind, a count or a switch. */
const CRED_FLAG_WORD = (w) => (CRED_WORD.test(w) || /^(?:auth|pass)$/i.test(w))
  && !/^(?:no|max|min)-/i.test(w) && !/-(?:file|path|fd|dir|env|kind|id|name|scan|count|limit|helper|stdin|type)$/i.test(w) && !/^tokenizer$/i.test(w);
/** Every flag in a string: `--token`, `--token=…`, `-password` at a word's start. */
const FLAG_IN = /(?:^|[\s'"(;|&])(--?[a-z][\w-]*)(?==|\s|$|['");])/gi;
/** `GH_TOKEN=${…}`, `password=${…}`, `API_KEY=${…}`: a bare `key=` is too common a word to count. */
const SETTING = /(?:^|[^\w])([A-Za-z_]*(?:token|secret|passw(?:or)?d|passphrase|api_?key|[a-z]_key|_pw|_pass|credential))=\$\{/gi;
/** Read in every string, wherever it is (#556 r2 B: a URL built in a variable first is still a URL with a password). */
const STRING_TEXT = [
  [/(?:^|\s)-p\$\{/, 'a password stuck to -p'],
  [/(?:^|\s)-u\s+\S*:\$\{/, 'a user:password pair after -u'],
  [/:\/\/[^\s/'"`@:]+:(?!\d+@)[^\s/'"`@]+@/, 'a URL with a password in it'],
  [/x-access-token:\$\{[^}]*\}@/i, 'x-access-token: (a token in a URL)'],
];
/** Read only in an argument list: these words are common in strings that never reach one (13 safe uses, #556 r2). */
const LIST_TEXT = [
  [/authorization\s*:/i, 'an Authorization header'],
  [/x-access-token:/i, 'x-access-token: (a token in a URL or header)'],
  [/\bbearer\s+\$\{/i, 'a Bearer token'],
];

/** The up to 10 characters before `end`, whitespace before `end` skipped: what decides whether a `/` starts a regex. */
function tail(text, end) { let k = end; while (k > 0 && /\s/.test(text[k - 1])) k--; return text.slice(Math.max(0, k - 10), k); }
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};]|=>)$|(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)$/;
/**
 * When the `/` at `i` starts a regular expression literal (what comes before it, `before`, is an operator, a bracket or a
 * keyword, not a value), the index of its last flag character; otherwise -1. A regex holding a quote (`/'/g`) would
 * otherwise read as the start of a string, and the rest of the file would be read out of step (#556 r1).
 */
function regexEnd(src, i, before) {
  if (!REGEX_AFTER.test(before)) return -1;
  let cls = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\n') return -1;
    if (c === '\\') { j++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') cls = true;
    else if (c === '/') { let k = j + 1; while (/[a-z]/.test(src[k] ?? '')) k++; return k - 1; }
  }
  return -1;
}

/** The text from `open` (an index of '(' or '[') to its partner, strings, regexes and comments skipped; null if it never closes. */
function balanced(src, open) {
  const want = { '(': ')', '[': ']', '{': '}' }; const stack = [];
  for (let i = open; i < src.length && i < open + 20000; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); if (n < 0) return null; i = n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n < 0) return null; i = n + 1; continue; }
    if (c === '/' && i > open) { const r = regexEnd(src, i, tail(src, i)); if (r > 0) { i = r; continue; } }
    if (c === "'" || c === '"') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '`') { const t = templateEnd(src, i); if (t < 0) return null; i = t; continue; }
    if (want[c]) stack.push(want[c]);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return null; if (!stack.length) return src.slice(open, i + 1); }
  }
  return null;
}

/**
 * The source with every comment turned to spaces (its newlines kept, so line numbers hold), strings and templates left as
 * they are: a call written in a comment is not a call, and `https://` in a string is not a comment. A regular expression
 * literal is blanked too (its slashes kept): it starts no program, and a quote in it would put the rest out of step. One
 * told wrongly from a division can at worst hide a finding on its line, never make one up.
 */
export function blankComments(src) {
  let out = ''; let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); const end = n < 0 ? src.length : n; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); const end = n < 0 ? src.length : n + 2; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '/') { const r = regexEnd(src, i, tail(out, out.length)); if (r > 0) { out += `/${blank(src.slice(i + 1, r))}`; i = r + 1; continue; } }
    if (c === "'" || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '`') { const j = templateEnd(src, i); const end = j < 0 ? src.length : j + 1; out += src.slice(i, end); i = end; continue; }
    out += c; i++;
  }
  return out;
}

/** The index of the backtick that closes the template opening at `i`, or -1. */
function templateEnd(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '$' && src[j + 1] === '{') { const inner = balanced(src, j + 1); if (inner === null) return -1; j += inner.length; continue; }
    if (src[j] === '`') return j;
  }
  return -1;
}

/** Each string and template in the source (comments already blank): { at, text }, a template's ${…} kept as `${x}`. */
function literals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') {
      let s = ''; let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; continue; } s += src[j]; j++; }
      out.push({ at: i, text: s }); i = j; continue;
    }
    if (c === '`') {
      const end = templateEnd(src, i); if (end < 0) break;
      let s = '';
      for (let j = i + 1; j < end; j++) {
        if (src[j] === '\\') { s += src[j + 1] ?? ''; j++; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { const inner = balanced(src, j + 1) ?? '{}'; out.push(...literals(inner.slice(1, -1)).map((l) => ({ at: j, text: l.text }))); s += '${x}'; j += inner.length; continue; }
        s += src[j];
      }
      out.push({ at: i, text: s }); i = end; continue;
    }
  }
  return out;
}

/** What one string says, wherever it is: a credential flag, a NAME_TOKEN=${…} setting, -p${…}, -u user:${…}. */
function judgeString(s) {
  const out = [];
  for (const m of s.matchAll(FLAG_IN)) if (CRED_FLAG_WORD(m[1].replace(/^--?/, ''))) out.push(['flag', m[1]]);
  for (const m of s.matchAll(SETTING)) if (!SAFE_END.test(m[1]) && !/helper$/i.test(m[1])) out.push(['text', `${m[1]}=\${…} (a credential set in a command)`]);
  for (const [re, what] of STRING_TEXT) if (re.test(s)) out.push(['text', what]);
  return out;
}

/** The first top-level [...] inside a call's parentheses (its argument list), or null. An index (`cmds[0]`) is not a list. */
function firstArray(call) {
  let depth = 0; let prev = '';
  for (let i = 1; i < call.length - 1; i++) {
    const c = call[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < call.length && call[i] !== q) { if (call[i] === '\\') i++; i++; } prev = q; continue; }
    if (c === '`') { const t = templateEnd(call, i); if (t < 0) return null; i = t; prev = '`'; continue; }
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === '[' && depth === 0) {
      const b = balanced(call, i); if (!b) return null;
      if (!/[\w$\])]/.test(prev)) return b;
      i += b.length - 1; prev = ']'; continue;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return null;
}

/** The top-level arguments of a call's parentheses, as text. */
function callArgs(call) {
  const args = []; let depth = 0; let start = 1;
  for (let i = 1; i < call.length - 1; i++) {
    const c = call[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < call.length && call[i] !== q) { if (call[i] === '\\') i++; i++; } continue; }
    if (c === '`') { const t = templateEnd(call, i); if (t < 0) break; i = t; continue; }
    if (c === '/') { const r = regexEnd(call, i, tail(call, i)); if (r > 0) { i = r; continue; } }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { args.push(call.slice(start, i).trim()); start = i + 1; }
  }
  const last = call.slice(start, -1).trim(); if (last) args.push(last);
  return args;
}

/** String literals (their text, in order) and the name chains outside them, in an argument list. */
function pieces(list) {
  const strings = []; let rest = '';
  // `cfg['token']` is `cfg.token`, and `cfg?.token` is `cfg.token`.
  const norm = list.replace(/\?\./g, '.').replace(/([\w$\])])\s*\[\s*(['"])([\w$-]+)\2\s*\]/g, '$1.$3');
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "'" || c === '"') { const q = c; let s = ''; i++; while (i < norm.length && norm[i] !== q) { if (norm[i] === '\\') { s += norm[i + 1]; i += 2; continue; } s += norm[i]; i++; } strings.push(s); rest += ' '; continue; }
    if (c === '`') {
      let s = ''; i++;
      while (i < norm.length && norm[i] !== '`') {
        if (norm[i] === '\\') { s += norm[i + 1]; i += 2; continue; }
        if (norm[i] === '$' && norm[i + 1] === '{') { const inner = balanced(norm, i + 1) ?? '{}'; rest += ` ${inner.slice(1, -1)} `; s += '${x}'; i += 1 + inner.length; continue; }
        s += norm[i]; i++;
      }
      strings.push(s); rest += ' '; continue;
    }
    rest += c;
  }
  const chains = [...rest.matchAll(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g)].map((m) => m[0].split('.').map((x) => x.trim()));
  return { strings, chains };
}

/** A name chain that says it holds a credential: a credential word in any part, and a last part that is not a safe one. */
function credName(chain) {
  const last = chain.at(-1);
  if (CRED_EXACT.test(last)) return true;
  if (SAFE_END.test(last) || SAFE_START.test(last)) return false;
  return chain.some((p) => CRED_WORD.test(p)) || CRED_EXACT.test(last);
}

function judgeList(list) {
  const out = []; const { strings, chains } = pieces(list);
  strings.forEach((s, k) => {
    for (const [re, what] of LIST_TEXT) if (re.test(s)) out.push(['text', what]);
    if (/^(?:-u|--user)$/.test(strings[k - 1] ?? '') && /:\$\{/.test(s)) out.push(['text', 'a user:password pair after -u']);
  });
  for (const c of chains) if (credName(c)) out.push(['value', c.join('.')]);
  return out;
}

const escape = (s) => s.replace(/[$]/g, '\\$');
const NAME_RE = /^[A-Za-z_$][\w$]*$/;

/** The index of the '(' that the ')' at `close` closes, counting brackets back (parameter lists hold no strings that matter). */
function openOf(src, close) {
  let depth = 0;
  for (let i = close; i >= 0 && i > close - 2000; i--) {
    if (src[i] === ')') depth++;
    else if (src[i] === '(') { depth--; if (!depth) return i; }
  }
  return -1;
}

/** Where an arrow's expression body that starts at `b` ends: a `;`, `,` or line end at its own depth, or a bracket it did not open. */
function exprEnd(src, b) {
  let depth = 0;
  for (let i = b; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < src.length && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '`') { const t = templateEnd(src, i); if (t < 0) return src.length; i = t; continue; }
    if (c === '/' && i > b) { const r = regexEnd(src, i, tail(src, i)); if (r > 0) { i = r; continue; } }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (!depth) return i; depth--; }
    else if (!depth && (c === ';' || c === ',' || c === '\n')) return i;
  }
  return src.length;
}

/** A parameter list's names, in order: { name, rest }; a destructured one has no name. */
function paramsOf(text) {
  return callArgs(`(${text})`).map((p) => { const m = /^(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(p); return m ? { name: m[2], rest: Boolean(m[1]) } : { name: null, rest: false }; });
}

/**
 * Every function in the (comment-blanked) source: { name, params, start, end, method }, `name` null for one with none.
 * `function f(…) {…}`, `const f = (…) => …`, `f: (…) => …`, a bare `x => …`, and a method `f(…) {…}`.
 */
function functionsIn(src) {
  const out = [];
  for (const m of src.matchAll(/(?<![\w$])function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
    const p = balanced(src, m.index + m[0].length - 1); if (!p) continue;
    const ob = src.indexOf('{', m.index + m[0].length - 1 + p.length); if (ob < 0) continue;
    const body = balanced(src, ob); if (!body) continue;
    out.push({ name: m[1] ?? null, params: paramsOf(p.slice(1, -1)), start: ob, end: ob + body.length, at: m.index });
  }
  for (const m of src.matchAll(/=>/g)) {
    let k = m.index; while (k > 0 && /\s/.test(src[k - 1])) k--;
    let params; let from;
    if (src[k - 1] === ')') { const o = openOf(src, k - 1); if (o < 0) continue; params = src.slice(o + 1, k - 1); from = o; } else {
      const w = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, k - 60), k)); if (!w) continue;
      params = w[1]; from = k - w[1].length;
    }
    const named = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*:|[{(,]\s*([A-Za-z_$][\w$]*)\s*=)\s*(?:async\s*)?$/.exec(src.slice(Math.max(0, from - 80), from));
    let b = m.index + 2; while (/[ \t]/.test(src[b] ?? '')) b++;
    let end;
    if (src[b] === '{') { const body = balanced(src, b); if (!body) continue; end = b + body.length; } else end = exprEnd(src, b);
    out.push({ name: named ? (named[1] ?? named[2] ?? named[3]) : null, params: paramsOf(params), start: b, end, at: from, method: Boolean(named?.[2]) });
  }
  for (const m of src.matchAll(/(?:^|[{,;\n])[ \t]*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (/^(?:if|for|while|switch|catch|function|return|await|typeof|new|with|do|else)$/.test(m[1])) continue;
    const p = balanced(src, m.index + m[0].length - 1); if (!p) continue;
    let ob = m.index + m[0].length - 1 + p.length; while (/\s/.test(src[ob] ?? '')) ob++;
    if (src[ob] !== '{') continue;
    const body = balanced(src, ob); if (!body) continue;
    out.push({ name: m[1], params: paramsOf(p.slice(1, -1)), start: ob, end: ob + body.length, at: m.index, method: true });
  }
  return out;
}

/** The calls of a spawn-family function under another name: promisify, `import { spawn as sp }`, `const { spawn: sp } = require(…)`. */
function aliasesIn(src) {
  const out = [];
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\.)?promisify\(\s*(?:\w+\.)?(\w+)\s*\)/g)) out.push([m[1], m[2]]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const x of m[1].matchAll(/([\w$]+)\s+as\s+([\w$]+)/g)) out.push([x[2], x[1]]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require|await\s+import)\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
    for (const x of m[1].matchAll(/([\w$]+)\s*:\s*([\w$]+)/g)) out.push([x[2], x[1]]);
  }
  return out.filter(([, real]) => CALL_NAMES.includes(real));
}

/** `a ? b : c` at the top level of an expression → [b, c]; otherwise null. */
function ternary(e) {
  let depth = 0; let q = -1;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === "'" || c === '"') { const z = c; i++; while (i < e.length && e[i] !== z) { if (e[i] === '\\') i++; i++; } continue; }
    if (c === '`') { const t = templateEnd(e, i); if (t < 0) return null; i = t; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (!depth && c === '?' && e[i + 1] !== '.' && e[i + 1] !== '?' && q < 0) q = i;
    else if (!depth && c === ':' && q >= 0) return [e.slice(q + 1, i).trim(), e.slice(i + 1).trim()];
  }
  return null;
}

/**
 * The credential-on-a-command-line findings in one module's source: [{ line, kind, what, list }], `kind` one of flag,
 * value, text, unread; `list` the first 120 characters of what was read. An empty list when there are none.
 */
export function credentialArgFindings(text) {
  const src = blankComments(text);
  const found = []; const seen = new Set();
  const lineOf = (at) => src.slice(0, at).split('\n').length;
  const push = (at, kind, what, list) => {
    const line = lineOf(at); const key = `${line} ${kind} ${what}`;   // a job file's arr([...]) is met both as a call and after ProgramArguments
    if (!seen.has(key)) { seen.add(key); found.push({ line, kind, what, list: String(list).replace(/\s+/g, ' ').slice(0, 120) }); }
  };
  const add = (at, list) => { if (list) for (const [kind, what] of judgeList(list)) push(at, kind, what, list); };
  const short = (s) => s.replace(/\s+/g, ' ').slice(0, 60);

  // Every string, wherever it is.
  for (const l of literals(src)) for (const [kind, what] of judgeString(l.text)) push(l.at, kind, what, l.text);

  const alias = aliasesIn(src);
  const aliasNames = new Set(alias.map(([a]) => a));
  const spawnish = new Set([...SPAWN_FAMILY, ...alias.filter(([, real]) => SPAWN_FAMILY.includes(real)).map(([a]) => a)]);
  const names = [...CALL_NAMES, ...aliasNames].map(escape).join('|');
  const CALL = new RegExp(`(?<![\\w.$])(?:${names})\\s*\\(|\\.(?:run|spawn|spawnSync|execFile|execFileSync|execSync|fork)\\s*\\(`, 'g');

  const defs = functionsIn(src);
  const local = new Map();
  for (const d of defs) if (d.name && !d.method && !local.has(d.name)) local.set(d.name, d);
  const exported = (n) => new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*${escape(n)}\\b|(?:const|let|var)\\s+${escape(n)}\\b)|export\\s*\\{[^}]*\\b${escape(n)}\\b`).test(src);
  /** The function a name at `pos` is a parameter of: the innermost around `pos` that declares it, or null. */
  const declaring = (pos, n) => defs.filter((d) => d.start <= pos && pos < d.end && d.params.some((p) => p.name === n))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
  /** The arrays a name is given here: `const X = [...]` or `X = [...]`, anywhere in the module. */
  const arraysOf = (n) => [...src.matchAll(new RegExp(`(?<![\\w$.])${escape(n)}\\s*=\\s*(?:Object\\.freeze\\(\\s*)?(?=\\[)`, 'g'))].map((m) => balanced(src, m.index + m[0].length)).filter(Boolean);

  // The calls that start a program: their argument list, and the names they are handed as one. A function of this
  // module that has a start call's name (`const run = (bin, args) => spawnSync(bin, args)`) is not one: its callers are
  // read below if it passes a list on.
  const handed = new Set(); const calls = [];
  for (const m of src.matchAll(CALL)) {
    const member = m[0].startsWith('.');
    const fn = /(\w+)\s*\($/.exec(m[0])[1];
    if (!member && local.has(fn) && !aliasNames.has(fn)) continue;
    const call = balanced(src, m.index + m[0].length - 1); if (!call) continue;
    add(m.index, firstArray(call));
    const args = callArgs(call);
    for (const a of args) if (NAME_RE.test(a)) handed.add(a);
    calls.push({ at: m.index, fn, args, call });
  }
  // The arrays built under a name used as an argument list: assigned whole, added to, or set by index.
  const listName = (n) => ARGLIKE.test(n) || handed.has(n);
  const built = new Set();
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?=\[)/g)) {
    if (!listName(m[1])) continue;
    built.add(m[1]); add(m.index, balanced(src, m.index + m[0].length));
  }
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|concat|splice)\s*\(/g)) {
    if (!listName(m[1])) continue;
    built.add(m[1]); const inner = balanced(src, m.index + m[0].length - 1);
    if (inner) add(m.index, `[${inner.slice(1, -1)}]`);
  }
  // An object's list under an args-like key (`{ what, args: [LS, d] }`), read wherever it is written.
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*:\s*(?=\[)/g)) if (ARGLIKE.test(m[1])) add(m.index, balanced(src, m.index + m[0].length));
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\[[^\]\n]*\]\s*=(?![=>])\s*/g)) {
    if (!listName(m[1])) continue;
    const at = m.index + m[0].length; add(m.index, `[${src.slice(at, exprEnd(src, at))}]`);
  }

  // What reaches each start call's list. Read: written out there, a list this module builds, or the array a function of
  // this module returns. Passed on: a parameter of the function the call is in, whose callers here are then read (one
  // level). Anything else is listed as `unread`, never passed in silence.
  const forwards = new Map(); const queue = []; const seenArrays = new Set();
  const resolve = (expr, at, label, level) => {
    const e = expr.trim();
    add(at, e);
    if (e.startsWith('[')) {
      const lit = balanced(e, 0); if (!lit) return push(at, 'unread', label, e);
      for (const el of callArgs(lit)) if (el.startsWith('...')) resolve(el.slice(3), at, label, level);
      let rest = e.slice(lit.length).trim();
      while (rest) {
        const c = /^\.\s*concat\s*\(/.exec(rest); if (!c) return push(at, 'unread', label, e);
        const inner = balanced(rest, c[0].length - 1); if (!inner) return push(at, 'unread', label, e);
        for (const a of callArgs(inner)) resolve(a.startsWith('...') ? a.slice(3) : a, at, label, level);
        rest = rest.slice(c[0].length - 1 + inner.length).trim();
      }
      return undefined;
    }
    if (/^['"`]/.test(e) || /^-?\d/.test(e) || /^(?:true|false|null|undefined)$/.test(e)) return undefined;
    if (e.startsWith('(') && balanced(e, 0)?.length === e.length) return resolve(e.slice(1, -1), at, label, level);
    const t = ternary(e);
    if (t) { resolve(t[0], at, label, level); resolve(t[1], at, label, level); return undefined; }
    if (NAME_RE.test(e)) {
      if (built.has(e)) return undefined;
      const d = declaring(at, e); const k = d ? d.params.findIndex((p) => p.name === e) : -1;
      if (k < 0) {
        // A list this module names (`const DIFF_FLAGS = [...]`): read, with what it spreads.
        const arrays = arraysOf(e);
        if (!arrays.length) return push(at, 'unread', label, e);
        if (seenArrays.has(e)) return undefined;
        seenArrays.add(e);
        for (const a of arrays) resolve(a, at, label, level);
        return undefined;
      }
      {
        if (level >= HELPER_DEPTH) return push(at, 'unread', `${label}: passed on through more than ${HELPER_DEPTH} helpers`, e);
        const key = `${d.start} ${k}`;
        if (!forwards.has(key)) { forwards.set(key, { d, k, rest: d.params[k].rest, label, level: level + 1 }); queue.push(forwards.get(key)); }
        return undefined;
      }
    }
    const fc = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
    if (fc && local.has(fc[1]) && balanced(e, fc[0].length - 1)?.length === e.length - fc[0].length + 1) {
      // A list a function of this module returns: each array in its body is read, and it must hold one.
      const d = local.get(fc[1]); const body = src.slice(d.start, d.end);
      // A `[` after a name or a closing bracket indexes; after a keyword such as return it starts a list.
      const indexes = (pre) => /[\w$\])]\s*$/.test(pre) && !/(?:^|[^\w$.])(?:return|yield|await|case|in|of|typeof|void|new|throw|else|do)\s*$/.test(pre);
      const arrays = [...body.matchAll(/\[/g)].filter((x) => !indexes(body.slice(0, x.index))).map((x) => balanced(body, x.index)).filter(Boolean);
      const given = callArgs(e.slice(fc[0].length - 1));
      // A parameter handed back as it is (`return args`, `=> args`): what the call gives it is the list.
      const handsBack = d.params.map((q, k) => [q, k]).filter(([q]) => !q.rest && new RegExp(`(?:\\breturn\\s+|^\\s*)${escape(q.name)}\\s*(?:;|}|$)`, 'm').test(body));
      for (const [, k] of handsBack) if (given[k] !== undefined) resolve(given[k], at, label, level);
      if (!arrays.length && !handsBack.length) return push(at, 'unread', label, e);
      for (const a of arrays) {
        add(at, a);
        for (const el of callArgs(a)) {
          if (!el.startsWith('...')) continue;
          // The wrapper spreads its own parameter, or a slice of it: what the call here gives it is read in its place.
          const k = d.params.findIndex((q) => q.name === el.slice(3).trim().replace(/\.slice\([^()]*\)$/, ''));
          if (k >= 0 && given[k] !== undefined) resolve(given[k], at, label, level);
          else push(at, 'unread', `${label}: ${fc[1]} spreads ${short(el.slice(3))}`, a);
        }
      }
      return undefined;
    }
    return push(at, 'unread', label, e);
  };
  const OTHER = /^(?:\{|\(?\s*(?:async\b|function\b)|\([^()]*\)\s*=>|[\w$]+\s*=>)/;
  for (const c of calls) {
    const lit = c.args.findIndex((x) => x.startsWith('['));
    const at = spawnish.has(c.fn) ? 1 : (lit >= 0 ? lit : LIST_AT[c.fn]);
    if (at === undefined) continue;   // exec, execSync: a command string, read as a string
    c.args.forEach((x, k) => {
      const lab = `${c.fn}(…, ${short(x)})`;
      if (k === at && !OTHER.test(x)) resolve(x.startsWith('...') ? x.slice(3) : x, c.at, lab, 0);
      else if (k > 0 && x.startsWith('...')) resolve(x.slice(3), c.at, lab, 0);   // a call that takes its words one by one
      else if (k > at && !OTHER.test(x)) add(c.at, `[${x}]`);
    });
  }
  // One level of helpers: a function that passes its parameter into a start call is read at each of its callers here.
  while (queue.length) {
    const { d, k, rest, label, level } = queue.shift();
    if (!d.name) { push(d.at, 'unread', `${label}: a parameter of an unnamed function`, src.slice(d.at, d.at + 80)); continue; }
    if (d.method || exported(d.name)) {
      // Called from other modules: covered only when the name is itself a start call, read at every call in the tree.
      if (!CALL_NAMES.includes(d.name)) push(d.at, 'unread', `${d.name} passes its list on, and is called from other modules`, src.slice(d.at, d.at + 80));
      if (d.method) continue;
    }
    const callers = [...src.matchAll(new RegExp(`(?<![\\w$.])${escape(d.name)}\\s*\\(`, 'g'))]
      .filter((m) => !/function\s*\*?\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index)) && !(m.index >= d.at && m.index < d.start));
    if (!callers.length && !exported(d.name)) { push(d.at, 'unread', `${d.name} passes its list on, and is never called by name here`, src.slice(d.at, d.at + 80)); continue; }
    for (const m of callers) {
      const call = balanced(src, m.index + m[0].length - 1); if (!call) continue;
      const args = callArgs(call);
      const items = rest ? args.slice(k) : args.slice(k, k + 1);
      for (const x of items) {
        const lab = `${d.name}(…, ${short(x)})`;
        if (rest && !x.startsWith('...')) { add(m.index, `[${x}]`); continue; }
        if (!OTHER.test(x)) resolve(x.startsWith('...') ? x.slice(3) : x, m.index, lab, level);
      }
    }
  }
  for (const m of src.matchAll(PLIST)) {
    // The list that follows the key in a job file: an arr([...]) call, or an <array> written out.
    const after = src.slice(m.index, m.index + 4000);
    const b = after.indexOf('['); const a = after.indexOf('<array>');
    if (a >= 0 && (b < 0 || a < b)) {
      // Written out as XML: each <string> is one argument, read as a quoted string.
      const end = after.indexOf('</array>', a);
      if (end > 0) {
        const items = [...after.slice(a, end).matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]);
        add(m.index, `[${items.map((x) => JSON.stringify(x)).join(', ')}]`);
        for (const x of items) for (const [kind, what] of judgeString(x)) push(m.index, kind, what, x);
      }
    } else if (b >= 0) add(m.index, balanced(after, b));
  }
  return found.sort((x, y) => x.line - y.line);
}
