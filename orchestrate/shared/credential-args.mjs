// R-0b-179 (b), L1148 F6: no credential goes on a command line. On a Mac /bin/ps is setuid root (system-protected), so every
// Mac user, the builder among them, reads every process's full command line; the environment is shown only to the
// process's own user (measured in L1148 F7). So a token, key or password a child needs goes in its environment
// (safe-git.mjs GIT_CONFIG_*), a file it reads (watch-run --token-file), or its stdin, never in its arguments.
//
// A source scan, run over every module by credential-args.test.mjs. A pattern list, not a parser (#556 r1, L1158): what it
// can not read is listed for review, never passed in silence. It reads:
//   every string in the source   a credential flag anywhere in it (`--token`, `--password=…`, `--auth`, `--pass`, so a
//                                shell script in a string, `sh -c`, execSync, a launchd job's script, is read too), a
//                                `NAME_TOKEN=${…}` / `password=${…}` setting, `-p${…}`, `-u ${user}:${…}`
//   every argument list          of a call that starts a program (CALL, and a promisify'd alias of one), of an array
//                                given a name that is used as one (`args`, `argv`, `cmd`, or a name passed to spawn), each
//                                push/unshift/concat/splice onto such a name, and each launchd ProgramArguments list:
//                                a name that says it holds a credential (`token`, `appKey`, `cfg.secret`, `secrets.gh`,
//                                `cfg?.token`, `cfg['token']`, and `tok`, `pw`, `key` alone), an Authorization header,
//                                `Bearer ${…}`, `x-access-token:`, a URL with a password in it, `-u` then `user:${…}`
//   every spawn-family call      (spawn, spawnSync, execFile, execFileSync, fork and their aliases) whose argument list is
//                                neither written out there nor an array this file builds: listed as `unread`, and the
//                                whole-tree test holds each one against a reviewed list
// The safe forms pass: a flag or name that says where a credential is or what it is (`--token-file`, `tokenPath(cfg)`,
// `secretKind`), a count (`--max-tokens`, `maxTokens`, `tokens`), a switch (`--no-token`, `--secret-scan`), a helper's name
// (`credentialHelper`), and a port in a URL (`https://host:443/`). An options object after the list (`{ env: { GH_TOKEN:
// token } }`) is the safe place and is never read as a list.
// What it can not see: a credential under a name that does not say so, or a list built in a way none of the above reads
// (a function of another module's that returns one, under a name that is not args-like). It is a tripwire for the easy
// mistake, not a proof; the proof is that the code passes what it must through the environment, which the push and the
// watch job do today.

const SPAWN_FAMILY = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
/** Calls that start a program, and the plist helper the job files build ProgramArguments with. */
const CALL_NAMES = [...SPAWN_FAMILY, 'exec', 'execSync', 'runChild', 'run', 'runGit', 'gitOk', 'git', 'arr'];
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
const STRING_TEXT = [
  [/(?:^|\s)-p\$\{/, 'a password stuck to -p'],
  [/(?:^|\s)-u\s+\S*:\$\{/, 'a user:password pair after -u'],
];
const LIST_TEXT = [
  [/authorization\s*:/i, 'an Authorization header'],
  [/x-access-token:/i, 'x-access-token: (a token in a URL or header)'],
  [/:\/\/[^\s/'"`@:]+:(?!\d+@)[^\s/'"`@]+@/, 'a URL with a password in it'],
  [/\bbearer\s+\$\{/i, 'a Bearer token'],
];

/** The up to 10 characters before `end`, whitespace before `end` skipped: what decides whether a `/` starts a regex. */
function tail(text, end) { let k = end; while (k > 0 && /\s/.test(text[k - 1])) k--; return text.slice(Math.max(0, k - 10), k); }
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};])$|(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)$/;
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

  // Every string, wherever it is.
  for (const l of literals(src)) for (const [kind, what] of judgeString(l.text)) push(l.at, kind, what, l.text);

  // Aliases of the spawn family (`const pexec = promisify(execFile)`).
  const alias = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\.)?promisify\(\s*(?:\w+\.)?(\w+)\s*\)/g)].filter((m) => CALL_NAMES.includes(m[2]));
  const spawnish = new Set([...SPAWN_FAMILY, ...alias.filter((m) => SPAWN_FAMILY.includes(m[2])).map((m) => m[1])]);
  const names = [...CALL_NAMES, ...alias.map((m) => m[1])].map(escape).join('|');
  const CALL = new RegExp(`(?<![\\w.$])(?:${names})\\s*\\(|\\.(?:run|spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\\s*\\(`, 'g');

  // The calls: their argument list, and the names they are handed as one.
  const handed = new Set(); const calls = [];
  for (const m of src.matchAll(CALL)) {
    const call = balanced(src, m.index + m[0].length - 1); if (!call) continue;
    add(m.index, firstArray(call));
    const fn = /(\w+)\s*\($/.exec(m[0])[1];
    const args = callArgs(call);
    for (const a of args) if (/^[A-Za-z_$][\w$]*$/.test(a)) handed.add(a);
    calls.push({ at: m.index, fn, args, call });
  }
  // The arrays built under a name used as an argument list: assigned whole, or added to.
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
  // A spawn-family call whose list is neither written there nor built here can not be read: listed, never passed.
  for (const c of calls) {
    if (!spawnish.has(c.fn)) continue;
    const list = c.args[1];
    if (list === undefined || /^\[/.test(list) || (/^[A-Za-z_$][\w$]*$/.test(list) && built.has(list))) continue;
    if (/^\{/.test(list)) continue;   // spawn(bin, { … }): no list at all
    push(c.at, 'unread', `${c.fn}(…, ${list.replace(/\s+/g, ' ').slice(0, 60)})`, c.call);
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
