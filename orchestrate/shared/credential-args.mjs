// R-0b-179 (b), L1148 F6: no credential goes on a command line. On a Mac /bin/ps is setuid root (system-protected), so every
// Mac user, the builder among them, reads every process's full command line; the environment is shown only to the
// process's own user (measured in L1148 F7). So a token, key or password a child needs goes in its environment
// (safe-git.mjs GIT_CONFIG_*), a file it reads (watch-run --token-file), or its stdin, never in its arguments.
//
// A source scan, run over every module by credential-args.test.mjs. A pattern list, not a parser (#556 r1, L1158). Since r3
// (L1170) it fails closed: a list, a word in one, or a command string that it can not reduce to literals, names that say
// what they are, or a value it followed is a finding or listed `unread`, never passed. It reads:
//   every string in the source   a credential flag anywhere in it (`--token`, `--password=…`, `--auth`, `--pass`, so a
//                                shell script in a string is read too), a `NAME_TOKEN=${…}` / `password=${…}` setting,
//                                `-p${…}`, `-u ${user}:${…}`, a URL with a password or a token as its user
//                                (`https://${t}@host`), `x-access-token:${…}@`, a string ending `x-access-token:` (a URL
//                                built with +), `Bearer ${…}` (r3 m2) and a string ending `Bearer ` (built with +, r4
//                                m2). The one Bearer string that passes is an HTTP header's whole value,
//                                `authorization: \`Bearer ${t}\`` or `headers.authorization = …`: fetch sends it and no
//                                command line holds it (ten such headers in the tree).
//   every start call             spawn and its family, exec/execSync, `.run`/`.spawn`/… on any object, the child_process
//                                module under any name (`cp.exec`), and an alias by promisify, import, require or plain
//                                `const sp = spawn` (r3 m4). Its argument list is read to its end (below); exec's and
//                                execSync's command string, and spawn's first word given `shell:` other than false, are
//                                read as words, and one held in a name must be a string this module writes (r3 M1).
//                                The options after the list, written out or in a name, are searched for `argv0`, which
//                                ps shows as the program's name: it is read as a word (r4 m1). `Reflect.apply(spawn, …)`
//                                is listed (r4 m6).
//   a list, to its end           written out (spreads and `.concat` tails), a name this module fills (every value it is
//                                given, the whole right-hand side, and every push/unshift/concat/splice or `NAME[i] =`,
//                                under any name that is the same list), `Object.freeze`/`slice`/`filter`/`concat` of one,
//                                a list a helper of this module returns (each return, its parameters bound to the call's
//                                arguments; r3 M3), or a parameter, read at each caller here (rest parameters too).
//   a word, to its end           split into its leaves (r4 M-A, M-B): each operand of `||`, `??`, `&&` and `+`, each
//                                `${…}` of a template, each element and value written out, both sides of `?:`, through
//                                parentheses and `await`. A word passes only when every leaf is a literal, a name that
//                                says what it is, a credential's name (a finding) or a name followed to its values:
//                                - a name that says it holds a credential (`token`, `appKey`, `cfg.secret`, `cfg?.token`,
//                                  `cfg['token']`, `tok`, `pw`, `key`) is a finding; one that says what it is (a path, a
//                                  count, a switch) passes, and so does an imported name. A chain is judged by its last
//                                  part (`env.GITHUB_PAT` does not pass because it starts `env`, r5 M3); a chain ending
//                                  env or vars is followed, not passed; `tokens[i]` is listed (r5 m-b);
//                                - `process.env.X` is a finding unless X is a plain variable (SAFE_ENV: HOME, PATH,
//                                  TMPDIR, USER…); `process.env` as a whole value is listed; globalThis is not quiet (r5 M1);
//                                  another name for process or process.env (`const p = process`, `const { env } =
//                                  process`, imported or required from node:process) is read as process (r6 1, 2); an
//                                  index into an environment (`env[k]`, `childEnv[k]`, with what is put into it by index
//                                  or Object.assign) does not pass on its name (r6 3); one element of a list of tokens
//                                  (`tokens[0].value`, `const [t] = tokens`, `for (const t of tokens)`) is read as one (r6 5);
//                                - a parameter is read at each caller (r3 M2), and its default (r8), its property `o.v`
//                                  too, with the caller's object read for its values;
//                                - any other name through every value this module gives it (`const t =
//                                  process.env.GH_TOKEN` makes t one, r3 m3; destructured and loop names too), and a
//                                  property set on it under a credential's name (`u.password = t`) is a finding;
//                                - a call: a helper of this module through its returns, its parameters bound; a method
//                                  that only reshapes (TRANSFORM: `.trim()`, `.map(pure function)`, `JSON.parse`) through
//                                  what it is called on and given; node's path, os and url functions (PURE_IMPORT), and a
//                                  function whose name says it answers with a path, a name, a count or a yes or no
//                                  (`tokenPath(cfg)`, `isRoot()`), pass; not one ending env, vars, file or source, nor one
//                                  named for reading (READ_VERBS: read, load, get, fetch, cat, decrypt, retrieve, unseal,
//                                  open, in any case, after any _ or $: `readFile`, `READ_TOKEN_PATH`, r5 M2, r7 M4), nor
//                                  a require or a dynamic import, whose value is a module's (r7 M2). `Object.entries(x)`/
//                                  `values(x)` read x's values, so a name like `env` does not pass there.
//                                Destructuring is read with its brackets balanced (`const { env = {} } = X`, r7 M1), and
//                                process under any spelling (required or imported from node:process, its default import,
//                                `(process)`, `globalThis.process`) is process (r7 M2, M3, M5), and so is its `.default`
//                                (r8 M2). A value is read with the chain's tail (#556 r8): `p.env.X` where p is given
//                                process, by a name, a pattern's path or default, a caller, or a parameter's default, and
//                                `(a ? b : c).env.X`, `(a || b).env.X`, `(await p).env.X` for each value. process itself
//                                as a value, where no tail is carried, is listed.
//                                Anything else (a program's answer, a file's text, an `await` of an object's method, a
//                                name given no value here) is listed.
//   everything else              listed as `unread`: a list or word from a helper exported or called as a method (its
//                                callers are in other modules), one not called by name here (handed on as a value, r3 c1),
//                                an unnamed function's parameter, a destructured parameter, a list built by code (`.map`,
//                                `Array.of`), apply and bind, and following deeper than HELPER_DEPTH. A list or word
//                                passed through a helper called from other modules is listed at each site it reaches.
//                                The whole-tree test holds each one against a reviewed list with the reason it is safe.
// Each finding carries `site`, a hash of its kind, what it says and the whole call's text with its spaces folded, so the
// reviewed list names each place, not each function or message (r4 M-C). A listed site inside a function that reads a
// credential (`readSecret(`, a cat or a read of a path whose last name part, or whose given value, says token, secret,
// key or password) is kind `reader`, not `unread`, so a reason written for ordinary words can not cover it. So is one
// that uses, or sits in a function that uses, a credential the module reads at its top level (r5 m-a).
// The safe forms pass: a flag or name that says where a credential is or what it is (`--token-file`, `tokenPath(cfg)`,
// `secretKind`), a count (`--max-tokens`, `maxTokens`, `tokens`), a switch (`--no-token`, `--secret-scan`), a helper's name
// (`credentialHelper`), and a port in a URL (`https://host:443/`). What follows a list in a start call is its options
// (`{ env: { GH_TOKEN: token } }`, the safe place) and is not read, unless the call takes its words one by one (a string
// where the list goes), except `argv0`, read as a word. Known limits (it is a pattern list): a credential under a name that
// does not say so, reached from another module; a caller's object property for a destructured parameter, a class
// method's callers, a computed key (`cfg[k]`) and following past HELPER_DEPTH are listed, not read; `.exec` on an object
// is RegExp's. It is a tripwire for
// the easy mistake, not a proof; the proof is that the code passes what it must through the environment, which the push
// and the watch job do today.

/**
 * A site's key: 32-bit FNV-1a of its text, as 8 hex characters. Not a security hash, only a short name for a place that
 * changes when the call's text does; the module imports nothing (the review install's closure test holds it to that).
 */
function siteHash(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const SPAWN_FAMILY = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
/** Calls that start a program, and the plist helper the job files build ProgramArguments with. */
const CALL_NAMES = [...SPAWN_FAMILY, 'exec', 'execSync', 'runChild', 'run', 'runGit', 'gitOk', 'git', 'arr'];
/** Where each start call's argument list is: spawn(bin, args), io.run(bin, args), git(args, opts), arr([...]). exec and
 * execSync take one command string, read as a string. */
const LIST_AT = { spawn: 1, spawnSync: 1, execFile: 1, execFileSync: 1, fork: 1, run: 1, runChild: 1, runGit: 0, gitOk: 0, git: 0, arr: 0 };
/** Followed through helpers of the same module at most this deep before a list is listed as unread. */
const HELPER_DEPTH = 6;
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
  [/:\/\/\$\{x\}@/, 'a URL with a token as its user'],
  [/x-access-token:$/i, 'x-access-token: (a URL built with +)'],
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
    if (c === '/') {
      const r = regexEnd(src, i, tail(out, out.length));
      if (r > 0) { let k = r; while (k > i && src[k] !== '/') k--; out += `/${blank(src.slice(i + 1, k))}${src.slice(k, r + 1)}`; i = r + 1; continue; }
    }
    if (c === "'" || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '`') { const j = templateEnd(src, i); const end = j < 0 ? src.length : j + 1; out += src.slice(i, end); i = end; continue; }
    out += c; i++;
  }
  return out;
}

/** The source with the text inside each string and template turned to spaces, the quotes and `${…}` code kept. */
function blankStrings(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } out += c + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + (src[j] ?? ''); i = j; continue; }
    if (c === '`') {
      const end = templateEnd(src, i); if (end < 0) { out += src.slice(i); break; }
      out += '`';
      for (let j = i + 1; j < end; j++) {
        if (src[j] === '$' && src[j + 1] === '{') { const inner = balanced(src, j + 1) ?? '{}'; out += ` ${blankStrings(inner)}`; j += inner.length; continue; }
        out += src[j] === '\n' ? '\n' : ' ';
      }
      out += '`'; i = end; continue;
    }
    out += c;
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

/**
 * Every destructuring pattern given a value: a declaration (`const { a, b: c = d } = X`, `let [e] = X`) or a statement that
 * is an assignment (`({ env = {} } = process);`, #556 r8 M6). The pattern is found with its brackets balanced on `code`
 * (the source with its strings blanked, so a `}` in a string or regular expression does not end it, r7 M1) and its parts
 * are read on `src`. Each name it binds comes with its path into the value (`.b`, `[0]` for an element, `.b.c` for a
 * nested pattern, r8 c2) and its default when it has one: a default is one more value the name may take (r8 M1).
 * { at, start, end, rhs, names: [{ name, path, rest, dflt }] }; `rhs` is where the value starts.
 */
function destructuresIn(code, src) {
  const out = [];
  const opens = [
    ...[...code.matchAll(/(?<![\w$.])(?:const|let|var)\s*(?=[{[])/g)].map((m) => [m.index, m.index + m[0].length]),
    ...[...code.matchAll(/(?:^|[;{}])\s*\(\s*(?=[{[])/g)].map((m) => [m.index, m.index + m[0].length]),
  ];
  for (const [at, open] of opens) {
    const pat = balanced(code, open);
    if (!pat) continue;
    const eq = /^\s*=(?![=>])\s*/.exec(code.slice(open + pat.length));
    if (!eq) continue;
    const names = [];
    bindPattern(src.slice(open, open + pat.length), '', names);
    out.push({ at, start: open, end: open + pat.length, rhs: open + pat.length + eq[0].length, names });
  }
  return out;
}
/** A target and its default (`e = {}` gives ['e', '{}']): the first `=` outside brackets that is not `==`, `=>`, `<=`, `>=`, `!=`. */
function splitDefault(t) {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++; } continue; }
    if (c === '`') { const e = templateEnd(t, i); if (e < 0) break; i = e; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (!depth && c === '=' && t[i + 1] !== '=' && t[i + 1] !== '>' && !'=!<>'.includes(t[i - 1])) return [t.slice(0, i).trim(), t.slice(i + 1).trim()];
  }
  return [t.trim(), null];
}
/** The names a pattern binds, each with its path into the value, under `path`. */
function bindPattern(pat, path, out) {
  const arr = pat[0] === '[';
  for (const part of callArgs(pat)) {
    const rest = part.startsWith('...'); const body = rest ? part.slice(3).trim() : part;
    let target = body; let key = '[0]';
    if (!arr) {
      // A key written as a name, a string, or a string in brackets (`['env']`, r8) is that key; any other computed key is
      // read as an index (a stated limit: which key it is is not known here).
      const k = /^(?:([A-Za-z_$][\w$]*)|(['"])([^'"]*)\2|\[\s*(['"])([^'"]*)\4\s*\]|\[[^\]]*\])\s*(:)?/.exec(body);
      if (!k) continue;
      const name = k[1] ?? k[3] ?? k[5];
      key = name !== undefined ? `.${name}` : '[0]';
      if (k[6]) target = body.slice(k[0].length).trim();
    }
    const [t, dflt] = splitDefault(target);
    const sub = rest ? path : `${path}${key}`;
    if (/^[{[]/.test(t)) bindPattern(t, sub, out);
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) out.push({ name: t, path: sub, rest, dflt });
  }
}

/**
 * A copied value with its process spellings made plain (#556 r7 M2, M5, c3): process or node:process
 * required, imported dynamically or awaited, and `globalThis.process`, are `process`, and brackets around a plain
 * name or chain are dropped (`(process)`, a bracketed require of process with `.env` after it). Spaces are removed first.
 */
export function plainProcess(expr) {
  let x = String(expr).replace(/\s+/g, '')
    .replace(/(?:await)?(?:require|import)\((['"`])(?:node:)?process\1(?:,[^()]*)?\)/g, 'process')
    .replace(/(?<![\w$.])globalThis\.process(?![\w$])/g, 'process');
  for (let i = 0; i < 8; i++) {
    const y = x.replace(/\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)/g, (all, inner, at) => (at > 0 && /[\w$\])]/.test(x[at - 1]) ? all : inner));
    if (y === x) break;
    x = y;
  }
  return x;
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
/** A plain name chain, `a` or `a.b.c`. */
const CHAIN_RE = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/;
/** A tail of properties and indexes only (`.env.X`, `[0].value`), with no call in it. */
const TAIL_RE = /^(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])+\s*$/;
/** Environment variables that hold a place, a name or a setting, never a credential: process.env.X passes only for these. */
const SAFE_ENV = /^(?:HOME|PATH|TMPDIR|USER|LOGNAME|SUDO_USER|SUDO_UID|SUDO_GID|SHELL|PWD|LANG|LC_ALL|LC_CTYPE|TERM|TZ|NODE_ENV|CI|XDG_[A-Z_]+_HOME)$/;

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

/** A parameter list's names, in order: { name, rest, dflt }; a destructured one has no name. `dflt` is its default. */
function paramsOf(text) {
  return callArgs(`(${text})`).map((p) => { const m = /^(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(?:=([\s\S]*)|$)/.exec(p); return m ? { name: m[2], rest: Boolean(m[1]), dflt: m[3]?.trim() || '' } : { name: null, rest: false, dflt: '' }; });
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
  // `const sp = spawn;`, `const ex = cp.execSync;` (#556 r3 m4).
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?=[;\n])/g)) {
    if (SPAWN_FAMILY.includes(m[2]) || m[2] === 'exec' || m[2] === 'execSync') out.push([m[1], m[2]]);
  }
  return out.filter(([, real]) => CALL_NAMES.includes(real));
}

/** The names the child_process module itself is bound to: `import * as cp`, `import cp from`, `const cp = require(…)`. */
function namespacesIn(src) {
  const from = `\\s*['"](?:node:)?child_process['"]`;
  const re = new RegExp(`import\\s*\\*\\s*as\\s+([\\w$]+)\\s+from${from}|import\\s+([\\w$]+)\\s+from${from}|(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*(?:require|await\\s+import)\\(${from}\\s*\\)`, 'g');
  return [...src.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
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

/** A path or name that says it leads to a credential: a token's, a key's, a secret's (`tokenPath(cfg)`, `keyPath`, `pemPath`). */
const CRED_PATH = /token|secret|passw|private|\bkey|[a-z]Key|pem\b|pemPath|credential/i;
/** Methods whose answer is made only from what they are called on and given (#556 r4 M-A): read through those. */
const TRANSFORM = /^(?:map|flatMap|exec|match|matchAll|trim|trimStart|trimEnd|toString|valueOf|join|slice|replace|replaceAll|toLowerCase|toUpperCase|padStart|padEnd|split|concat|at|charAt|substring|substr|normalize|repeat|flat|filter|sort|reverse|find|findLast|some|every|includes|indexOf|lastIndexOf|startsWith|endsWith|test|stringify|parse|resolve|basename|dirname|relative|extname|format|toFixed|keys|values|entries|fromEntries|freeze|from|of|assign|floor|ceil|round|max|min|abs|trunc|isArray|isInteger|isAbsolute|has|subarray|native|alloc)$/;
/** … of those, the ones whose function argument decides only what is kept, not what is made. */
const CALLBACK_OK = /^(?:filter|sort|find|findLast|some|every)$/;
/**
 * A function whose answer is made only from its own parameters and literals (`([k, v]) => \`${k}=${v}\``,
 * `(x) => x?.id`): map with it is read through what it maps. One that names anything else is not read.
 */
function pureFunction(f) {
  const m = /^(?:async\s*)?(?:\(([^()]*(?:\([^()]*\)[^()]*)*)\)|([A-Za-z_$][\w$]*))\s*=>\s*/.exec(f.trim());
  if (!m) return false;
  const params = new Set([...(m[1] ?? m[2]).matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]));
  const body = blankStrings(f.trim().slice(m[0].length)).replace(/\.\s*#?[A-Za-z_$][\w$]*/g, ' ');
  return [...body.matchAll(/[A-Za-z_$][\w$]*/g)].every((x) => params.has(x[0]) || /^(?:return|const|let|of|String|Number|Boolean|undefined|null|true|false)$/.test(x[0]));
}
/**
 * A function whose name says what it returns: a path, a name, a count, a yes or no (`tokenPath(cfg)`, `isRoot()`). Not
 * one ending in env or vars: that answers with an environment, whose values are what must stay off a command line
 * (`safeGitEnv()` spread into `env -i K=V …`, #556 r4); nor `with…`/`use…`, which may hand back what they are given; nor
 * one ending in file or source, or named for reading (`readFile(tokenFile)`, `readKeyFile(p)`), which answer with what
 * they read (#556 r5 M2).
 */
const safeCall = (f) => (SAFE_END.test(f) && !/(?:env|vars?|files?|source)$/i.test(f) && !READ_START.test(f)) || /^(?:max|min|num|no|has|is)(?=[A-Z_])/.test(f);
/**
 * A function named for reading or fetching (`readFile`, `loadKey`, `getSecret`, `fetchToken`, `catFile`, `ReadTokenPath`,
 * `READ_TOKEN_PATH`, `_readTokenPath`, `decryptKey`, `unsealVault`, `openTokenPath`) answers with what it read (#556 r5 M2,
 * r6 4, r7 M4). The verb is matched in any case, after any leading _ or $, and must be followed by a character that is not
 * a lowercase letter, or by the end: so `reader` and `category` are not verbs, and `READTokenPath` is.
 */
export const READ_VERBS = Object.freeze(['read', 'load', 'get', 'fetch', 'cat', 'decrypt', 'retrieve', 'unseal', 'open']);
const READ_ANYCASE = READ_VERBS.map((v) => [...v].map((ch) => `[${ch.toUpperCase()}${ch}]`).join('')).join('|');
const READ_CAP = READ_VERBS.map((v) => `${v[0].toUpperCase()}${v.slice(1)}`).join('|');
// At the start in any case, or later in the name as its own word (`tryReadTokenPath`, `doLoadPath`, `x_read_path`), and
// with -s or -es (`readsPath`, `fetchesKey`, #556 r8 m4). A name all in lower case (`readtokenpath`) can't be split into
// words, so it is a stated limit; the runtime guard still refuses its value on a command line.
const READ_START = new RegExp(`(?:^[_$]*(?:${READ_ANYCASE})|(?<=[a-z\\d])(?:${READ_CAP})|_(?:${READ_ANYCASE}))(?:e?s)?(?![a-z])`);
/** Methods that take nothing and answer with a place, a time, an id or a number. */
const NOARG_SAFE = /^(?:tmpdir|homedir|cwd|now|hostname|platform|arch|getuid|getgid|geteuid|getegid|randomUUID|uptime|toISOString|getTime|toJSON)$/;
/** Global functions that reshape their argument. */
const SAFE_CALL = /^(?:parseInt|parseFloat|encodeURIComponent|encodeURI|decodeURIComponent|isNaN|isFinite)$/;
/**
 * Imported functions that reshape their arguments (node:path, node:os, node:url), or answer with a new place, a file
 * number, a count of bytes read or random bytes (node:fs, node:crypto).
 */
const PURE_IMPORT = /^(?:join|resolve|basename|dirname|relative|normalize|extname|format|isAbsolute|tmpdir|homedir|hostname|platform|fileURLToPath|pathToFileURL|realpathSync|mkdtempSync|openSync|readSync|randomBytes)$/;
/** Methods whose answer is a one-way digest of what they were fed, never what they were fed (`hash.digest('hex')`). */
const DIGEST = /^digest$/;

/**
 * The top-level operators of an expression: { logic, plus } as [start, length] cuts for || ?? && and a binary +, and
 * whether it compares or does arithmetic. null when its brackets do not close.
 */
function operators(e) {
  const out = { logic: [], plus: [], compare: false, arith: false }; let depth = 0; let prev = 'o';
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < e.length && e[i] !== q) { if (e[i] === '\\') i++; i++; } prev = 'v'; continue; }
    if (c === '`') { const t = templateEnd(e, i); if (t < 0) return null; i = t; prev = 'v'; continue; }
    if (c === '/' && prev === 'o') { const r = regexEnd(e, i, tail(e, i)); if (r > 0) { i = r; prev = 'v'; continue; } }
    if ('([{'.includes(c)) { depth++; prev = 'o'; continue; }
    if (')]}'.includes(c)) { depth--; if (depth < 0) return null; prev = 'v'; continue; }
    if (depth || /\s/.test(c)) continue;
    if (/[\w$]/.test(c)) {
      let j = i; while (j < e.length && /[\w$]/.test(e[j])) j++;
      const w = e.slice(i, j);
      if (w === 'instanceof' || w === 'in') out.compare = true;
      prev = /^(?:await|typeof|void|new|delete|instanceof|in|of)$/.test(w) ? 'o' : 'v'; i = j - 1; continue;
    }
    const two = e.slice(i, i + 2);
    if (two === '=>') { i++; prev = 'o'; continue; }
    if (two === '?.') { i++; prev = 'o'; continue; }
    if (two === '||' || two === '??' || two === '&&') { out.logic.push([i, 2]); i++; prev = 'o'; continue; }
    if (/^(?:===|!==)/.test(e.slice(i, i + 3))) { out.compare = true; i += 2; prev = 'o'; continue; }
    if (/^(?:==|!=|<=|>=)$/.test(two)) { out.compare = true; i++; prev = 'o'; continue; }
    if ((c === '<' || c === '>') && prev === 'v') { out.compare = true; prev = 'o'; continue; }
    if (c === '+' && prev === 'v' && e[i + 1] !== '+' && e[i + 1] !== '=') { out.plus.push([i, 1]); prev = 'o'; continue; }
    if ('-*/%|&^'.includes(c) && prev === 'v' && e[i + 1] !== c && e[i + 1] !== '=') { out.arith = true; prev = 'o'; continue; }
    if (c === '.' && /\d/.test(e[i + 1] ?? '')) { prev = 'v'; continue; }
    prev = 'o';
  }
  return depth ? null : out;
}
/** The text between the cuts. */
function cut(e, cuts) {
  const out = []; let s = 0;
  for (const [i, n] of cuts) { out.push(e.slice(s, i)); s = i + n; }
  out.push(e.slice(s));
  return out;
}
/**
 * One value and what follows it: { root, ops }, root a name, a string, a template (its ${…} as parts), a list, an object,
 * a number, a regex or a bracketed expression; ops each a property, an index or a call (its arguments), with where it
 * starts and ends. null when anything is left over.
 */
function postfix(e) {
  let i; let root;
  const c = e[0];
  if (c === "'" || c === '"') { i = 1; while (i < e.length && e[i] !== c) { if (e[i] === '\\') i++; i++; } root = { type: 'str' }; i++; }
  else if (c === '`') {
    const end = templateEnd(e, 0); if (end < 0) return null;
    const parts = [];
    for (let j = 1; j < end; j++) {
      if (e[j] === '\\') { j++; continue; }
      if (e[j] === '$' && e[j + 1] === '{') { const inner = balanced(e, j + 1); if (!inner) return null; parts.push(inner.slice(1, -1)); j += inner.length; }
    }
    root = { type: 'tpl', parts }; i = end + 1;
  } else if ('[{('.includes(c)) {
    const b = balanced(e, 0); if (!b) return null;
    root = { type: c === '[' ? 'arr' : c === '{' ? 'obj' : 'paren', text: b }; i = b.length;
  } else if (c === '/') { const r = regexEnd(e, 0, ''); if (r < 0) return null; root = { type: 'regex' }; i = r + 1; }
  else {
    const num = /^(?:0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?n?|\.\d+)/.exec(e);
    const name = /^[A-Za-z_$][\w$]*/.exec(e);
    if (num) { root = { type: 'num' }; i = num[0].length; } else if (name) { root = { type: 'name', name: name[0] }; i = name[0].length; } else return null;
  }
  const ops = [];
  for (;;) {
    let j = i; while (/\s/.test(e[j] ?? '')) j++;
    if (j >= e.length) { i = j; break; }
    const start = j; let opt = false;
    if (e.startsWith('?.', j)) { j += 2; opt = true; }
    if (e[j] === '.' && !opt) j++;
    else if (e[j] === '(' || e[j] === '[') {
      const b = balanced(e, j); if (!b) return null;
      if (e[j] === '(') ops.push({ type: 'call', start, end: j + b.length, args: callArgs(b) });
      else {
        const lit = /^\[\s*(['"])([\w$-]+)\1\s*\]$/.exec(b);
        ops.push(lit ? { type: 'prop', name: lit[2], start, end: j + b.length } : { type: 'index', start, end: j + b.length });
      }
      i = j + b.length; continue;
    } else if (!opt) break;
    while (/\s/.test(e[j] ?? '')) j++;
    const m = /^#?[A-Za-z_$][\w$]*/.exec(e.slice(j)); if (!m) return null;
    ops.push({ type: 'prop', name: m[0], start, end: j + m[0].length }); i = j + m[0].length;
  }
  return i >= e.length ? { root, ops } : null;
}
/** The values written in an object literal: `k: v` gives v, `k` gives k, `...o` gives o; a method gives none. */
function objectValues(text) {
  const out = [];
  for (const p of callArgs(`(${text.slice(1, -1)})`)) {
    if (p.startsWith('...')) { out.push(p.slice(3)); continue; }
    const kv = /^(?:(['"])[^'"]*\1|\[[^\]]*\]|[A-Za-z_$][\w$]*|\d+)\s*:\s*/.exec(p);
    if (kv) out.push(p.slice(kv[0].length));
    else if (NAME_RE.test(p)) out.push(p);
    else if (/^(?:async\s+)?(?:get\s+|set\s+)?\*?\s*[A-Za-z_$][\w$]*\s*\(/.test(p)) continue;
    else out.push(p);
  }
  return out;
}

/**
 * The credential-on-a-command-line findings in one module's source: [{ line, kind, what, list }], `kind` one of flag,
 * value, text, unread; `list` the first 120 characters of what was read. An empty list when there are none.
 */
export function credentialArgFindings(text) {
  const src = blankComments(text);
  const found = []; const seen = new Set();
  const lineOf = (at) => src.slice(0, at).split('\n').length;
  // The source with each string's and template's text blanked (same length): where a name is given a value.
  const code = blankStrings(src);
  const push = (at, kind, what, list) => {
    const line = lineOf(at); const key = `${line} ${kind} ${what}`;   // a job file's arr([...]) is met both as a call and after ProgramArguments
    const text = String(list).replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) { seen.add(key); found.push({ line, kind, what, list: text.slice(0, 120), site: siteHash(`${kind} ${what} ${text}`), at }); }
  };
  const add = (at, list) => { if (list) for (const [kind, what] of judgeList(list)) push(at, kind, what, list); };
  const short = (s) => s.replace(/\s+/g, ' ').slice(0, 60);

  // Every string, wherever it is. A `Bearer ${…}` string is a finding anywhere but as the whole value of an HTTP
  // header's authorization key (`authorization: \`Bearer ${t}\``, `headers.authorization = …`), which fetch sends, not a
  // command line (#556 r3 m2: ten such headers in the tree).
  for (const l of literals(src)) {
    for (const [kind, what] of judgeString(l.text)) push(l.at, kind, what, l.text);
    const header = /(?:authorization['"]?\s*:|\.authorization\s*=)\s*$/i.test(src.slice(Math.max(0, l.at - 40), l.at));
    if (/\bbearer\s+\$\{/i.test(l.text) && !(/^bearer \$\{x\}$/i.test(l.text) && header)) push(l.at, 'text', 'a Bearer token', l.text);
    // `'Bearer ' + t` (#556 r4 m2): the same, built with +.
    if (/\bbearer\s+$/i.test(l.text) && !(/^bearer $/i.test(l.text) && header)) push(l.at, 'text', 'a Bearer token (built with +)', l.text);
  }

  const alias = aliasesIn(src);
  const aliasNames = new Set(alias.map(([a]) => a));
  const realOf = (fn) => alias.find(([a]) => a === fn)?.[1] ?? fn;
  const names = [...CALL_NAMES, ...aliasNames].map(escape).join('|');
  // The child_process module under a name (`import * as cp`, `const cp = require(…)`): its .exec is a start call. On any
  // other object .exec is RegExp's.
  const ns = namespacesIn(src).map(escape).join('|');
  const CALL = new RegExp(`(?<![\\w.$])(${names})\\s*(?:\\.\\s*(call|apply|bind)\\s*)?\\(|\\.\\s*(run|spawn|spawnSync|execFile|execFileSync|execSync|fork)\\s*\\(${ns ? `|(?<![\\w.$])(?:${ns})\\s*\\.\\s*(exec)\\s*\\(` : ''}`, 'g');

  const defs = functionsIn(src);
  const local = new Map();
  for (const d of defs) if (d.name && !d.method && !local.has(d.name)) local.set(d.name, d);
  const exported = (n) => new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*${escape(n)}\\b|(?:const|let|var)\\s+${escape(n)}\\b)|export\\s*\\{[^}]*\\b${escape(n)}\\b`).test(src);
  /** The function a name at `pos` is a parameter of: the innermost around `pos` that declares it, or null. */
  const declaring = (pos, n) => defs.filter((d) => d.start <= pos && pos < d.end && d.params.some((p) => p.name === n))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
  /** Every value a name is given in this module (`const X = …`, `X = …`), with where: { at, expr }. */
  const assignCache = new Map();
  const patterns = destructuresIn(code, src);
  const assigns = (n) => {
    if (!assignCache.has(n)) {
      // A default inside a pattern (`const { env = {} } = X`) is not a value given to the name here (#556 r7 M1), but an
      // assignment inside a default's parentheses (`{ a = (t = X) }`) is (#556 r9 m2).
      const inParens = (from, to) => { let d = 0; for (const ch of code.slice(from, to)) d += ch === '(' ? 1 : ch === ')' ? -1 : 0; return d > 0; };
      assignCache.set(n, [...code.matchAll(new RegExp(`(?<![\\w$.])${escape(n)}\\s*=(?![=>])\\s*`, 'g'))]
        .filter((m) => !patterns.some((p) => p.start <= m.index && m.index < p.end && !inParens(p.start, m.index)))
        .map((m) => { const s = m.index + m[0].length; return { at: m.index, expr: src.slice(s, exprEnd(src, s)).trim() }; }).filter((x) => x.expr));
      // `const { a, b: n = d } = X` gives n X.b; `const [n] = X` and `for (const n of X)` give n what X holds (read as X).
      for (const p of patterns) {
        for (const b of p.names) {
          if (b.name !== n) continue;
          const rhs = src.slice(p.rhs, exprEnd(src, p.rhs)).trim();
          // The value at the name's path (`const { env } = process` gives env process.env, r6 1; `const [n] = X` is X[0],
          // r6 5), and its default, one more value it may take (r8 M1).
          if (rhs) assignCache.get(n).push({ at: p.at, expr: !b.path || (b.path === '[0]' && !CHAIN_RE.test(rhs)) ? rhs : CHAIN_RE.test(rhs) ? `${rhs}${b.path}` : `(${rhs})${b.path}` });
          if (b.dflt) assignCache.get(n).push({ at: p.at, expr: b.dflt });
        }
      }
      for (const m of src.matchAll(new RegExp(`for\\s*(?:await\\s*)?\\(\\s*(?:const|let|var)\\s*(?:${escape(n)}|\\[[^\\]]*\\b${escape(n)}\\b[^\\]]*\\]|\\{[^}]*\\b${escape(n)}\\b[^}]*\\})\\s+of\\s+`, 'g'))) {
        const s = m.index + m[0].length; const rhs = src.slice(s, exprEnd(src, s)).trim();
        if (rhs) assignCache.get(n).push({ at: m.index, expr: CHAIN_RE.test(rhs) ? `${rhs}[0]` : rhs });   // one element of X (r6 5)
      }
    }
    return assignCache.get(n);
  };
  /** What is added to a list, or to a name that is the same list (`const l2 = list`): push/unshift/concat/splice, `X[i] =`. */
  const mutations = (n) => {
    const same = [n, ...[...src.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*${escape(n)}\\s*(?=[;\\n)])`, 'g'))].map((m) => m[1])];
    const out = [];
    for (const x of same) {
      for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${escape(x)}\\s*\\.\\s*(?:push|unshift|concat|splice)\\s*\\(`, 'g'))) {
        const inner = balanced(src, m.index + m[0].length - 1);
        if (inner) out.push(...callArgs(inner).map((a) => ({ at: m.index, expr: a.replace(/^\.\.\./, '') })));
      }
      for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${escape(x)}\\s*\\[[^\\]\\n]*\\]\\s*=(?![=>])\\s*`, 'g'))) {
        const s = m.index + m[0].length; out.push({ at: m.index, expr: src.slice(s, exprEnd(src, s)) });
      }
    }
    return out;
  };
  /** What a function returns: its expression body, or each `return …` in its block. */
  const returnsOf = (d) => {
    if (src[d.start] !== '{') return [{ at: d.start, expr: src.slice(d.start, d.end).trim() }];
    return [...src.slice(d.start, d.end).matchAll(/(?<![\w$.])return\b[ \t]*/g)]
      .map((m) => { const s = d.start + m.index + m[0].length; return { at: s, expr: src.slice(s, exprEnd(src, s)).trim() }; }).filter((x) => x.expr);
  };
  /** A written-out value that can not be undefined: a string, number, template, list, object, function or `new`. */
  const definite = (g) => /^(?:-?\d[\d_.e]*|true|false|null)$/.test(g) || /^'(?:[^'\\\n]|\\.)*'$|^"(?:[^"\\\n]|\\.)*"$/.test(g)
    || ((g[0] === '`' || g[0] === '[' || g[0] === '{') && balanced(g, 0)?.length === g.length)
    || /^(?:new\s|async\b|function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/.test(g);
  /**
   * A helper's parameters bound to one call's arguments. A parameter with a default takes it unless the call gives it a
   * written-out value that can not be undefined (#556 r9 M, r10 M: `f(cfg.label)`, `f(...[])`, `f(void(0))` may all be
   * undefined). The default is read where the helper is written, seeing the parameters before it, as JavaScript does.
   */
  const bindParams = (d, given, at, env) => {
    const bind = new Map(); let spread = false;
    d.params.forEach((q, j) => {
      const g = given[j]?.trim();
      if (g?.startsWith('...')) spread = true;   // from a spread on, which argument lands where is not known
      if (!q.name) return;
      if (q.rest) return void bind.set(q.name, { expr: `[${given.slice(j).join(', ')}]`, at, env });
      const alt = q.dflt && (g === undefined || spread || !definite(g)) ? { expr: q.dflt, at: d.at, env: bind.size ? new Map(bind) : null, dflt: true } : null;
      if (alt && (g === undefined || g === 'undefined')) return void bind.set(q.name, alt);
      bind.set(q.name, { expr: g ?? 'undefined', at, env, alt });
    });
    return bind;
  };
  /** The names a local helper is also called by: `const go = helper`. */
  const aliasesOf = (n) => [...src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escape(n)}\\s*(?=[;\\n])`, 'g'))].map((m) => m[1]);

  // The calls that start a program: their argument list, and the names they are handed as one. A function of this
  // module that has a start call's name (`const run = (bin, args) => spawnSync(bin, args)`) is not one: its callers are
  // read below if it passes a list on.
  const handed = new Set(); const calls = [];
  for (const m of src.matchAll(CALL)) {
    const fn = m[1] ?? m[3] ?? m[4]; const how = m[2];
    if (m[1] && local.has(fn) && !aliasNames.has(fn)) continue;
    const call = balanced(src, m.index + m[0].length - 1); if (!call) continue;
    // apply and bind hand the words over in a way not read here: listed (#556 r3).
    if (how === 'apply' || how === 'bind') { push(m.index, 'unread', `${fn}.${how}(…)`, call); continue; }
    add(m.index, firstArray(call));
    const args = how === 'call' ? callArgs(call).slice(1) : callArgs(call);
    for (const a of args) if (NAME_RE.test(a)) handed.add(a);
    calls.push({ at: m.index, fn, real: realOf(fn), args });
  }
  // Reflect.apply(spawn, …) hands the words over as apply does (#556 r4 m6): listed.
  for (const m of src.matchAll(new RegExp(`Reflect\\s*\\.\\s*(?:apply|construct)\\s*\\(\\s*(?:[\\w$]+\\s*\\.\\s*)?(${names})\\b`, 'g'))) {
    push(m.index, 'unread', `Reflect.apply(${m[1]}, …)`, balanced(src, src.indexOf('(', m.index)) ?? m[0]);
  }
  // The arrays built under a name used as an argument list: assigned (the whole right-hand side, #556 r3 M3), added to,
  // or set by index. Read here for what they hold; the lists that reach a start call are followed again below.
  const listName = (n) => ARGLIKE.test(n) || handed.has(n);
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g)) {
    if (!listName(m[1])) continue;
    const s = m.index + m[0].length; add(m.index, `[${src.slice(s, exprEnd(src, s))}]`);
  }
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|concat|splice)\s*\(/g)) {
    if (!listName(m[1])) continue;
    const inner = balanced(src, m.index + m[0].length - 1);
    if (inner) add(m.index, `[${inner.slice(1, -1)}]`);
  }
  // An object's list under an args-like key (`{ what, args: [LS, d] }`), read wherever it is written.
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*:\s*(?=\[)/g)) if (ARGLIKE.test(m[1])) add(m.index, balanced(src, m.index + m[0].length));
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\[[^\]\n]*\]\s*=(?![=>])\s*/g)) {
    if (!listName(m[1])) continue;
    const at = m.index + m[0].length; add(m.index, `[${src.slice(at, exprEnd(src, at))}]`);
  }

  // What reaches each start call, read to the end (#556 r3, the class rule: it fails closed). A list is read when it is
  // written out, a name this module fills (every value it is given and everything added to it, under any name that is
  // the same list), a list a helper of this module returns (each return, with the call's own arguments for its
  // parameters), or a parameter, whose callers here are read in its place. Each word in it is read the same way: a name
  // that says it is a credential is a finding; a parameter is followed to its callers; a name this module gives a value
  // is read through that value (`const t = process.env.GH_TOKEN` makes t one); a name that says what it is (a path, a
  // count, a switch) passes. A list or a command string that can not be read to its end is listed `unread`, never passed.
  const forwards = new Map(); const queue = []; const seenLists = new Set(); const tailJobs = new Set();
  const forward = (d, k, mode, at, label, level, n, tail = '') => {
    // A parameter's default is one more value it may take (`function f(p = process)`, #556 r8): read like a caller's.
    const dflt = mode === 'word' ? d.params[k].dflt : '';
    if (dflt && level < HELPER_DEPTH) {
      if (tail) { quiet++; try { leaf(`(${dflt})${tail}`, d.at, level + 1, label, null, new Set()); } finally { quiet--; } }
      if (!quiet) word(dflt, d.at, level + 1, label, null, new Set());
    }
    // A parameter used with a tail (`p.env.X`) has each caller's argument read with that tail too, for credentials only
    // (#556 r8, the tailed read across a helper): `f(process)` for `p.env.X` is process.env.X.
    if (tail && mode === 'word' && d.name && !d.method && !d.params[k].rest && level < HELPER_DEPTH) {
      const key = `${d.start} ${k} ${tail}`;
      if (!tailJobs.has(key)) { tailJobs.add(key); queue.push({ d, k, mode, rest: false, label, level: level + 1, tail }); }
    }
    if (quiet) return undefined;   // a tailed read (looking for credentials only) lists nothing and starts no other reading
    if (level >= HELPER_DEPTH) return push(at, 'unread', `${label}: passed on through more than ${HELPER_DEPTH} helpers`, n);
    // Called from other modules (exported, or a method): covered only when the name is itself a start call, read at every
    // call in the tree. Listed at each place its parameter reaches, as the list or a word in it (#556 r4 M-C).
    if (d.name && (d.method || exported(d.name)) && !CALL_NAMES.includes(d.name)) {
      push(at, 'unread', `${d.name}'s ${d.params[k].name} reaches ${label}, and ${d.name} is called from other modules`, `${d.name} ${d.params[k].name} ${label}`);
    }
    if (!d.name) return push(at, 'unread', `${label}: a parameter of an unnamed function`, `${n} ${src.slice(d.at, d.at + 80)}`);
    const key = `${d.start} ${k} ${mode}`;
    if (!forwards.has(key)) { forwards.set(key, { d, k, mode, rest: d.params[k].rest, label, level: level + 1 }); queue.push(forwards.get(key)); }
    return undefined;
  };
  // Names this module takes from another: `import { a }`, `import a from`, `import * as a`, `const a = require(…)`.
  const importedNames = new Set([
    ...[...src.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)),
    ...[...src.matchAll(/import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)].map((m) => m[1]),
    ...[...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:require|await\s+import)\s*\(/g)].map((m) => m[1]),
  ]);
  const imported = (n) => importedNames.has(n);
  // A name given a module's value by a require or a dynamic import, such as a JSON file's data, is followed to that
  // value when it is used as one, so its data is not passed as code another module wrote (#556 r8 m1).
  const loadedNames = new Set([...code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g)].map((m) => m[1]));
  // Names for process and process.env (r6 1, 2): imported from node:process, required, or given process or a part of it.
  const PROC_FROM = `['"](?:node:)?process['"]`;
  const procNames = new Map();
  // `import { default as p }` is process.default, which is process (r7 M3, processChain); a quoted name is its name
  // (`{ 'env' as E }`, r8 M5); `import proc, { env } from` gives both names (r7 c3).
  for (const m of src.matchAll(new RegExp(`import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*${PROC_FROM}`, 'g'))) {
    for (const x of m[1].split(',')) { const [q, b] = x.trim().split(/\s+as\s+/); const a = q?.replace(/^(['"])(.*)\1$/, '$2'); if (a) procNames.set(b ?? a, `process.${a}`); }
  }
  for (const m of src.matchAll(new RegExp(`import\\s+(?:\\*\\s*as\\s+)?([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s*${PROC_FROM}`, 'g'))) procNames.set(m[1], 'process');
  // A name given process by a require (and `.env` after it) is read through its value by plainProcess (r7 M2).
  const processChain = (c, at, depth = 0) => {
    if (c[0] === 'globalThis' && c[1] === 'process') return processChain(c.slice(1), at, depth + 1);
    if (c[0] === 'process' && c[1] === 'default') return processChain([c[0], ...c.slice(2)], at, depth + 1);   // r8 M2
    if (c[0] === 'process' || depth > 4) return c;
    if (procNames.has(c[0])) return processChain([...procNames.get(c[0]).split('.'), ...c.slice(1)], at, depth + 1);
    if (declaring(at, c[0])) return c;
    const as = assigns(c[0]);
    // A require or dynamic import of process, `(process)` and the like are read as process (r7 M2, M5).
    const named = as.map((a) => plainProcess(a.expr)).filter((x) => CHAIN_RE.test(x));
    // Only a name for process or process.env itself: `const t = process.env.X` is read through its value as before.
    for (const x of named) {
      const r = processChain(x.split('.'), at, depth + 1);
      if (r[0] === 'process' && (r.length === 1 || (r.length === 2 && r[1] === 'env'))) return processChain([...r, ...c.slice(1)], at, depth + 1);
    }
    return c;
  };
  const QUIET = /^(?:undefined|null|true|false|this|NaN|Infinity|String|Number|Boolean|JSON|Math|Object|Array|process|Buffer|Promise|Date|RegExp|Error|Symbol|Set|Map|URL|console|Intl)$/;
  const isFunction = (x) => /^(?:async\b|function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/.test(x);
  /** A word leaf followed to its end (#556 r4 M-A): this module's helper is read through its returns (its parameters bound
   * to the call's arguments); a call that only reshapes its inputs (TRANSFORM) is read through them; anything else is
   * listed. `what` names the leaf in the listing. */
  // While `quiet` is above 0 a read only looks for credentials: nothing is listed (the tailed read of a value, below).
  let quiet = 0;
  const unreadLeaf = (at, label, what, text) => (quiet ? undefined : push(at, 'unread', `${label}: ${what}`, text));
  const leaf = (expr, at, level, label, env, seen) => {
    let e = expr.trim().replace(/^\.\.\.\s*/, '');
    if (!e || isFunction(e)) return undefined;
    // A bracketed start keeps its tail (#556 r8 M3): `(X).a.b` is read as X.a.b for each value X may take, each branch of
    // a ternary and each operand of || ?? &&, and X after an await. One that is not a single value is read as before.
    const lead = e.startsWith('(') ? balanced(e, 0) : null;
    if (lead && lead.length < e.length && TAIL_RE.test(e.slice(lead.length))) {
      const tail = e.slice(lead.length).trim(); const inner0 = lead.slice(1, -1).trim();
      const t = ternary(inner0);
      if (t) return t.forEach((x) => leaf(`(${x})${tail}`, at, level, label, env, seen));
      const top0 = operators(inner0);
      if (top0?.logic.length) return cut(inner0, top0.logic).forEach((x) => leaf(`(${x.trim()})${tail}`, at, level, label, env, seen));
      const inner = inner0.replace(/^await\b\s*/, '');
      const top1 = operators(inner);
      if (top1 && !top1.logic.length && !top1.compare && !top1.plus.length && !top1.arith && postfix(inner)) return leaf(`${inner}${tail}`, at, level, label, env, seen);
    }
    // A require or dynamic import of process or node:process, in any quotes, is process (r7 M2, r8 M4); its `.default` is
    // process too, read where every chain is (processChain, r8 M2).
    const load = /^(?:require|import)\s*\(/.exec(e);
    if (load) {
      const b = balanced(e, load[0].length - 1);
      if (b && /^(['"`])(?:node:)?process\1$/.test(callArgs(b)[0] ?? '')) e = `process${e.slice(load[0].length - 1 + b.length)}`;
    }
    if (e.startsWith('(') && balanced(e, 0)?.length === e.length) return leaf(e.slice(1, -1), at, level, label, env, seen);
    const t = ternary(e);
    if (t) { leaf(t[0], at, level, label, env, seen); return leaf(t[1], at, level, label, env, seen); }
    const top = operators(e);
    if (!top) return unreadLeaf(at, label, `${short(e)} is not read to its end`, e);
    // Each operand of || ?? && is a value it may take; a comparison is true or false; each operand of + is in the
    // value (#556 r4 M-B: `'Bearer ' + v`); arithmetic is a number.
    if (top.logic.length) return cut(e, top.logic).forEach((x) => leaf(x, at, level, label, env, seen));
    if (top.compare) return undefined;
    if (top.plus.length) return cut(e, top.plus).forEach((x) => leaf(x, at, level, label, env, seen));
    if (top.arith) return undefined;
    const pre = /^(?:(await)\b|(typeof|void|delete)\b|(!)|(new)\b|([-+])(?![-+]))\s*/.exec(e);
    if (pre?.[1]) return leaf(e.slice(pre[0].length), at, level, label, env, seen);
    if (pre?.[2] || pre?.[3] || pre?.[5]) return undefined;
    const isNew = Boolean(pre?.[4]); if (isNew) e = e.slice(pre[0].length);
    const p = postfix(e);
    if (!p) return unreadLeaf(at, label, `${short(e)} is not read to its end`, e);
    const callAt = p.ops.map((o) => o.type).lastIndexOf('call');
    if (callAt < 0 && !isNew) {
      if (p.root.type === 'name') {
        const c = [p.root.name, ...p.ops.filter((o) => o.type === 'prop').map((o) => o.name)];
        const indexed = p.ops.some((o) => o.type === 'index');
        // One element of a list named tokens (`tokens[0]`) is a token (r5 m-b); `tokens[0].value` is a finding in nameChain (r6 5).
        if (indexed && /tokens$/i.test(c.at(-1))) return unreadLeaf(at, label, `${short(e)} is one of a list of tokens`, e);
        return nameChain(c, at, level, label, env, seen, false, indexed);
      }
      // An element of a written-out list keeps its tail (`[process][0].env.X`, r8 M3).
      if (p.root.type === 'arr' && p.ops[0]?.type === 'index' && p.ops.length > 1) {
        const tail = e.slice(p.ops[0].end);
        return callArgs(`(${p.root.text.slice(1, -1)})`).forEach((x) => leaf(x.startsWith('...') ? x.slice(3) : `(${x})${tail}`, at, level, label, env, seen));
      }
      return rootLeaves(p.root, at, level, label, env, seen);
    }
    // The value is what the last call returns; a property of it is read with it (a credential's name is a finding).
    const k = callAt < 0 ? p.ops.length : callAt;
    const before = p.ops.slice(0, k); const args = callAt < 0 ? [] : p.ops[callAt].args;
    const callText = e.slice(0, callAt < 0 ? e.length : p.ops[callAt].end);
    const argLeaves = (fnOk) => args.forEach((a) => (isFunction(a.trim()) && !fnOk && !pureFunction(a) ? unreadLeaf(at, label, `${short(callText)} is given a function whose answer is not read`, callText) : leaf(a, at, level, label, env, seen)));
    if (!before.length && p.root.type === 'name') {
      const f = p.root.name;
      if (local.has(f) && !aliasNames.has(f) && !isNew) {
        if (level >= HELPER_DEPTH) return unreadLeaf(at, label, `passed on through more than ${HELPER_DEPTH} helpers`, callText);
        const d = local.get(f); const bind = bindParams(d, args, at, env);
        const rets = returnsOf(d);
        if (!rets.length) return undefined;   // it returns nothing: undefined
        return rets.forEach((r) => word(r.expr, r.at, level + 1, label, bind, new Set()));
      }
      if (SAFE_CALL.test(f) || (QUIET.test(f) && f !== 'process') || imported(f) && PURE_IMPORT.test(f)) return argLeaves(false);
      // A module's value (a require of cfg.json, then `.value`; a dynamic import) is never a safe call, though require ends in re (r7 M2).
      if (f !== 'require' && f !== 'import' && safeCall(f)) return undefined;   // its name says what it returns (`tokenPath(cfg)`)
      return unreadLeaf(at, label, `${short(callText)} is a call whose answer is not read`, callText);
    }
    const last = before.at(-1);
    if (last?.type === 'prop') {
      const recv = e.slice(0, last.start);
      // Object.entries(env) / Object.values(env): the object's values become words, so a name that says what it is
      // (`env`, `gitVars`) does not pass here; its values are read (#556 r4: `env -i K=V …`).
      if (/^(?:entries|values)$/.test(last.name) && recv.trim() === 'Object' && args.length === 1 && NAME_RE.test(args[0].trim())) {
        return nameChain([args[0].trim()], at, level, label, env, seen, true);
      }
      // One of a list of tokens picked by a method (`tokens.at(0)`, `tokens.find(…)`, r7 c1).
      if (/^(?:at|find|findLast|filter)$/.test(last.name) && /tokens$/i.test(recv.trim())) return unreadLeaf(at, label, `${short(callText)} is one of a list of tokens`, callText);
      // What an element picker or a list method answers keeps the tail after the call (`[process].find(f).env.X`, r8 m3).
      const after = callAt >= 0 ? e.slice(p.ops[callAt].end) : '';
      if (after.trim() && TAIL_RE.test(after) && /^(?:find|findLast|at|pop|shift|filter|slice|sort|reverse|flat|concat)$/.test(last.name) && !isNew) {
        leaf(`(${recv})${/^(?:find|findLast|at|pop|shift)$/.test(last.name) ? '[0]' : ''}${after.trim()}`, at, level, label, env, seen);
        return argLeaves(CALLBACK_OK.test(last.name));
      }
      if (TRANSFORM.test(last.name) && !isNew) { leaf(recv, at, level, label, env, seen); return argLeaves(CALLBACK_OK.test(last.name)); }
      if (NOARG_SAFE.test(last.name) && !args.length) return undefined;
      if (DIGEST.test(last.name) || safeCall(last.name)) return undefined;
    }
    return unreadLeaf(at, label, `${short(callText)} is a call whose answer is not read`, callText);
  };
  /** A written-out value: a string, a template (each ${…} read), a list (each element), an object (each value), a number. */
  const rootLeaves = (root, at, level, label, env, seen) => {
    if (root.type === 'tpl') for (const x of root.parts) leaf(x, at, level, label, env, seen);
    if (root.type === 'arr') for (const x of callArgs(`(${root.text.slice(1, -1)})`)) leaf(x, at, level, label, env, seen);
    if (root.type === 'obj') for (const x of objectValues(root.text)) leaf(x, at, level, label, env, seen);
    if (root.type === 'paren') leaf(root.text.slice(1, -1), at, level, label, env, seen);
  };
  /** A name or `a.b.c`: see the comment above the start calls. */
  const nameChain = (c0, at, level, label, env, seen, values = false, indexed = false) => {
    // Another name for process or process.env (`const p = process`, `const { env } = process`, `import { env } from
    // 'node:process'`, r6 1, 2) is read as what it names.
    const c = processChain(c0, at);
    const n = c[0];
    // process itself as a value (handed to a helper, returned, put in an object or a list) is listed: its environment
    // is in reach by any tail the scan may not carry (#556 r8, failing closed past the tailed read).
    if (n === 'process' && c.length === 1) return unreadLeaf(at, label, 'process as a value: its environment can be reached from it', n);
    // process.env (#556 r5 M1): a variable is a finding unless its name is one of the plain ones; the whole environment
    // as a value (spread, Object.entries, JSON.stringify, an index `env[k]`) is listed.
    if (n === 'process' && c[1] === 'env') {
      if (c.length === 2) return unreadLeaf(at, label, 'process.env as a value: every variable becomes a word', c.join('.'));
      if (credName(c)) return indexed ? push(at, 'value', c.join('.'), c.join('.')) : undefined;
      return SAFE_ENV.test(c[2]) ? undefined : push(at, 'value', c.slice(0, 3).join('.'), c.join('.'));
    }
    // An indexed chain's credential name is not in the list's text as one chain (`tokens[0].value`), so it is a finding here (r6 5).
    if (credName(c) && indexed) return push(at, 'value', c.join('.'), c.join('.'));
    // A property of `this` is set in some other method, which is not followed: a credential's name is a finding, a
    // plain name passes as any name does, and the rest is listed (#556 r9 m1). `this` stays quiet for the name scan.
    if (n === 'this') {
      if (credName(c)) return push(at, 'value', c.join('.'), c.join('.'));
      // An environment variable's spelling (`this.e.GH_PAT`, `this['GH_PAT']`) is read as process.env's are (r10).
      if (c.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(c.at(-1)) && !SAFE_ENV.test(c.at(-1))) return push(at, 'value', c.join('.'), c.join('.'));
      if (c.length > 1 && !/(?:env|vars?)$/i.test(c.at(-1)) && (SAFE_END.test(c.at(-1)) || SAFE_START.test(c.at(-1)))) return undefined;
      return unreadLeaf(at, label, `${c.join('.')} is set where it is not read`, c.join('.'));
    }
    if (QUIET.test(n) || credName(c) || local.has(n)) return undefined;
    if (imported(n) && !loadedNames.has(n)) return values || indexed ? unreadLeaf(at, label, `${n}'s values become words, and ${n} comes from another module`, n) : undefined;
    // A plain name that says what it is passes; `env.X` or `cfg.value` is read by its last part, not its first (r5 M3).
    // An index into an environment (`env[k]`, `gitEnv[0]`, `childEnv[k]`) is one of its values, so that name does not
    // pass on what it says (r6 3); one element of a list of files is still a file.
    if (!values && c.length === 1 && !(indexed && /(?:env|vars?)$/i.test(n)) && (SAFE_END.test(n) || SAFE_START.test(n))) return undefined;
    // A chain ending env or vars is an environment, whose values are the words (r5 M1): it is followed, not passed.
    if (c.length > 1 && !/(?:env|vars?)$/i.test(c.at(-1)) && (SAFE_END.test(c.at(-1)) || SAFE_START.test(c.at(-1)))) return undefined;
    if (seen.has(n)) return undefined;
    seen.add(n);
    // A value is read with the chain's tail (`p.env.X` with p given process is process.env.X, #556 r8): never the name alone.
    // The value is also read as it was, for what it lists, so a value met at several properties is listed once.
    const tailed = (x, xat, xenv) => { if (c.length < 2) return; quiet++; try { leaf(`(${x})${c.slice(1).map((k) => `.${k}`).join('')}`, xat, level, label, xenv, new Set(seen)); } finally { quiet--; } };
    // A default's text is in no caller's call, so it is judged here, as a word's is (#556 r9 M). A parameter that may
    // be given undefined is read as both what it is given and its default (r10 M).
    if (env?.has(n)) {
      const b0 = env.get(n); const before = new Set(seen);
      for (const b of [b0, b0.alt].filter(Boolean)) {
        if (b.dflt) add(b.at, `[${b.expr}]`);
        tailed(b.expr, b.at, b.env); leaf(b.expr, b.at, level, label, b.env, b === b0 ? seen : before);
      }
      return undefined;
    }
    const d = declaring(at, n); const k = d ? d.params.findIndex((p) => p.name === n) : -1;
    if (k >= 0) return forward(d, k, 'word', at, label, level, n, c.slice(1).map((x) => `.${x}`).join(''));
    const as = assigns(n).filter((a) => !isFunction(a.expr));
    const sets = c.length > 1 ? [...code.matchAll(new RegExp(`(?<![\\w$.])${escape(n)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*`, 'g'))] : [];
    // What is put into it by index or Object.assign (`childEnv[k] = process.env[k]`, r6 3) is read when it is indexed or
    // its values are the words.
    const fills = indexed || values ? [
      ...[...code.matchAll(new RegExp(`(?<![\\w$.])${escape(n)}\\s*\\[[^\\]\\n]*\\]\\s*=(?![=>])\\s*`, 'g'))].map((m) => ({ at: m.index, expr: src.slice(m.index + m[0].length, exprEnd(src, m.index + m[0].length)) })),
      ...[...code.matchAll(new RegExp(`Object\\s*\\.\\s*assign\\s*\\(\\s*${escape(n)}\\s*,`, 'g'))].flatMap((m) => {
        const b = balanced(src, src.indexOf('(', m.index)); return b ? callArgs(b).slice(1).map((x) => ({ at: m.index, expr: x.replace(/^\.\.\./, '') })) : [];
      }),
    ] : [];
    if (!as.length && !sets.length && !fills.length) return unreadLeaf(at, label, `${n} is given no value here that is read`, n);
    for (const a of as) tailed(a.expr, a.at, null);
    for (const a of [...as, ...fills]) word(a.expr, a.at, level, label, null, seen);
    for (const m of sets) {
      // A credential set on it under its own name (`u.password = t`) is one, whatever t says it is.
      if (credName([m[1]])) push(m.index, 'value', `${n}.${m[1]}`, src.slice(m.index, m.index + 80));
      const s = m.index + m[0].length; word(src.slice(s, exprEnd(src, s)), m.index, level, label, null, seen);
    }
    return undefined;
  };
  /** Each word of `expr`, read to its leaves: what it says (flags, names) and what each leaf holds. */
  // A value of this module (no parameters bound) is read once, at the shallowest depth it is met: a list is listed once,
  // where it is, under the first start call it reaches.
  const wordDone = new Map(); const quietDone = new Map();
  const word = (expr, at, level, label, env = null, seen = new Set()) => {
    // A tailed read (quiet) leaves the once-only record alone, so the value's own read still lists what it lists.
    if (!env) { const k = `${at} ${expr}`; const done = quiet ? quietDone : wordDone; if (done.get(k) <= level) return; done.set(k, level); }
    add(at, `[${expr}]`); leaf(expr, at, level, label, env, seen);
  };
  const resolve = (expr, at, label, level, env = null) => {
    const e = expr.trim();
    add(at, `[${e}]`);
    if (e.startsWith('[')) {
      const lit = balanced(e, 0); if (!lit) return push(at, 'unread', label, e);
      for (const el of callArgs(lit)) if (el.startsWith('...')) resolve(el.slice(3), at, label, level, env); else word(el, at, level, label, env);
      let rest = e.slice(lit.length).trim();
      while (rest) {
        const c = /^\.\s*concat\s*\(/.exec(rest); if (!c) return push(at, 'unread', label, e);
        const inner = balanced(rest, c[0].length - 1); if (!inner) return push(at, 'unread', label, e);
        for (const a of callArgs(inner)) if (!credName([a])) resolve(a.startsWith('...') ? a.slice(3) : a, at, label, level, env);
        rest = rest.slice(c[0].length - 1 + inner.length).trim();
      }
      return undefined;
    }
    if (/^['"`]/.test(e) || /^-?\d/.test(e) || /^(?:true|false|null|undefined)$/.test(e)) return undefined;
    if (e.startsWith('(') && balanced(e, 0)?.length === e.length) return resolve(e.slice(1, -1), at, label, level, env);
    const t = ternary(e);
    if (t) { resolve(t[0], at, label, level, env); resolve(t[1], at, label, level, env); return undefined; }
    // Object.freeze([…]), and a list's own words kept by slice, filter or concat (concat's arguments read too).
    const wrap = /^(?:Object\s*\.\s*freeze|([A-Za-z_$][\w$]*)\s*\.\s*(slice|filter|concat))\s*\(/.exec(e);
    if (wrap) {
      const inner = balanced(e, wrap[0].length - 1);
      if (inner && wrap[0].length - 1 + inner.length === e.length) {
        if (!wrap[1]) return resolve(inner.slice(1, -1), at, label, level, env);
        resolve(wrap[1], at, label, level, env);
        if (wrap[2] === 'concat') for (const a of callArgs(inner)) if (!credName([a])) resolve(a.replace(/^\.\.\./, ''), at, label, level, env);
        return undefined;
      }
    }
    if (NAME_RE.test(e)) {
      if (env?.has(e)) { const b = env.get(e); if (b.alt) resolve(b.alt.expr, b.alt.at, label, level, b.alt.env); return resolve(b.expr, b.at, label, level, b.env); }
      const d = declaring(at, e); const k = d ? d.params.findIndex((p) => p.name === e) : -1;
      if (k >= 0) return forward(d, k, 'list', at, label, level, e);
      const as = assigns(e).filter((a) => !isFunction(a.expr));
      if (!as.length) return push(at, 'unread', label, e);
      if (seenLists.has(e)) return undefined;
      seenLists.add(e);
      for (const a of as) resolve(a.expr, a.at, label, level);
      for (const m of mutations(e)) word(m.expr, m.at, level, label);
      return undefined;
    }
    const fc = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
    if (fc && local.has(fc[1]) && balanced(e, fc[0].length - 1)?.length === e.length - fc[0].length + 1) {
      // A list a helper of this module returns: each return read, its parameters bound to this call's arguments.
      if (level >= HELPER_DEPTH) return push(at, 'unread', `${label}: passed on through more than ${HELPER_DEPTH} helpers`, e);
      const d = local.get(fc[1]); const bind = bindParams(d, callArgs(e.slice(fc[0].length - 1)), at, env);
      const rets = returnsOf(d);
      if (!rets.length) return push(at, 'unread', `${label}: ${fc[1]} returns nothing that is read`, e);
      for (const r of rets) resolve(r.expr, r.at, label, level + 1, bind);
      return undefined;
    }
    return word(e, at, level, label, env);   // any other list value: its words, read to the leaf (#556 r4 M-A)
  };
  const OTHER = /^(?:\{|\(?\s*(?:async\b|function\b)|\([^()]*\)\s*=>|[\w$]+\s*=>)/;
  for (const c of calls) {
    const lab = (x) => `${c.fn}(…, ${short(x)})`;
    const lit = c.args.findIndex((x) => x.startsWith('['));
    const spawnish = SPAWN_FAMILY.includes(c.real);
    const at = spawnish ? 1 : (lit >= 0 ? lit : LIST_AT[c.real]);
    if (at === undefined) {   // exec, execSync: one command string
      if (c.args[0] !== undefined) word(c.args[0], c.at, 0, lab(c.args[0]));
      continue;
    }
    // spawn's first word: the program, or with a shell the whole command (#556 r3 M1); read to its leaves either way.
    if (spawnish && c.args[0] !== undefined) word(c.args[0], c.at, 0, lab(c.args[0]));
    // The options, written out or held in a name (#556 r4 m1, m6): argv0 is the name ps shows for the program, so it is a
    // word; `shell:` other than false makes the list's words one command line, which they are read as already.
    for (const x of c.args.slice(Math.max(1, at + 1))) {
      const text = NAME_RE.test(x) ? assigns(x).map((a) => a.expr).join('\n') : x;
      for (const m of text.matchAll(/(?<![\w$])argv0\b\s*(:\s*)?/g)) {
        const s = m.index + m[0].length;
        word(m[1] ? text.slice(s, exprEnd(text, s)) : 'argv0', c.at, 0, `${c.fn}(…, argv0)`);
      }
    }
    // After a list come options (env, cwd, gitDir), which no command line holds; a call that takes its words one by one
    // (a string where the list goes: tmux.run('send-keys', '-t', …)) has words there too.
    const oneByOne = /^['"`]/.test(c.args[at] ?? '');
    c.args.forEach((x, k) => {
      if (k === at && !OTHER.test(x)) resolve(x.startsWith('...') ? x.slice(3) : x, c.at, lab(x), 0);
      else if (k > 0 && x.startsWith('...')) resolve(x.slice(3), c.at, lab(x), 0);
      else if (k > at && oneByOne && !OTHER.test(x)) word(x, c.at, 0, lab(x));
    });
  }
  // The helpers that pass a list, or a word, on: each is read at its callers here, up to HELPER_DEPTH deep.
  while (queue.length) {
    const { d, k, mode, rest, label, level, tail } = queue.shift();
    if (d.method) continue;
    const by = [d.name, ...aliasesOf(d.name)].map(escape).join('|');
    const callers = [...src.matchAll(new RegExp(`(?<![\\w$.])(?:${by})\\s*\\(`, 'g'))]
      .filter((m) => !/function\s*\*?\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index)) && !(m.index >= d.at && m.index < d.start));
    if (!callers.length && !exported(d.name)) { if (!tail) push(d.at, 'unread', `${d.name} passes its ${mode === 'list' ? 'list' : 'words'} on, and is not called here (it may be handed on as a value)`, src.slice(d.at, d.at + 80)); continue; }
    for (const m of callers) {
      const call = balanced(src, m.index + m[0].length - 1); if (!call) continue;
      const args = callArgs(call);
      const items = rest ? args.slice(k) : args.slice(k, k + 1);
      for (const x of items) {
        const lab = `${d.name}(…, ${short(x)})`;
        if (tail) { quiet++; try { leaf(`(${x})${tail}`, m.index, level, lab, null, new Set()); } finally { quiet--; } continue; }
        // An object handed where a word is taken from it (`f({ v: token })` for `o.v`) is read for its values.
        if (OTHER.test(x) && !(mode === 'word' && x.startsWith('{'))) continue;
        if (mode === 'word' || (rest && !x.startsWith('...'))) word(x.replace(/^\.\.\./, ''), m.index, level, lab);
        else resolve(x.startsWith('...') ? x.slice(3) : x, m.index, lab, level);
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
  // What can not be read to its end, inside a function that reads a credential (readSecret, `cat` or a file read of a
  // token's or key's path), is a finding, not a listing: the credential is in reach (#556 r4 M-C).
  // What a read is of: each name chain's last part (`k.hostLockPath` is host.lock's path, whatever k is), and a plain
  // name through the values it is given (`const f = tokenPath(cfg)`).
  const pathy = (t) => [...blankStrings(t).matchAll(/[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/g)].some((m) => {
    const c = m[0].split('.').map((x) => x.replace(/[?\s]/g, ''));
    return CRED_PATH.test(c.at(-1)) || (c.length === 1 && assigns(c[0]).some((a) => CRED_PATH.test(a.expr)));
  }) || [...t.matchAll(/(['"])([^'"]*)\1/g)].some((m) => CRED_PATH.test(m[2]));
  const readsCredential = (body) => /\breadSecret\s*\(/.test(body)
    || [...body.matchAll(/['"](?:\/bin\/)?cat['"]\s*,([^\]]*)\]/g)].some((m) => pathy(m[1]))
    || [...body.matchAll(/\b(?:readFileSync|readFile|readText)\s*\(([^)]*)\)/g)].some((m) => pathy(m[1]));
  const readers = defs.filter((d) => readsCredential(src.slice(d.start, d.end)));
  // A credential read at the module's top level (`const t = readFileSync(tokenPath)`, #556 r5 m-a): a site that names
  // what it read, or sits in a function that does, is a reader site too.
  let top = src; for (const d of defs) top = top.slice(0, d.start) + ' '.repeat(d.end - d.start) + top.slice(d.end);
  // `const t = …`, `t = …` after `let t;`, and `const { v } = …` (r6 m-a).
  const topPatterns = patterns.filter((p) => !defs.some((d) => d.start <= p.at && p.at < d.end));
  const topReads = [
    ...[...top.matchAll(/(?<![\w$.])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g)]
      .filter((m) => !patterns.some((p) => p.start <= m.index && m.index < p.end))
      .map((m) => ({ names: [m[1]], start: m.index, end: exprEnd(src, m.index + m[0].length) })),
    ...topPatterns.map((p) => ({ names: p.names.map((x) => x.name), start: p.at, end: exprEnd(src, p.rhs) })),
  ].filter((r) => readsCredential(src.slice(r.start, r.end)));
  const readNames = topReads.flatMap((r) => r.names);
  const usesRead = (t) => readNames.some((n) => new RegExp(`(?<![\\w$.])${escape(n)}(?![\\w$])`).test(t));
  for (const x of found) {
    const r = x.kind === 'unread' && readers.find((d) => d.start <= x.at && x.at < d.end);
    if (r) { x.kind = 'reader'; x.what = `${x.what} (in ${r.name ?? 'a function'}, which reads a credential)`; }
    else if (x.kind === 'unread' && readNames.length) {
      const d = defs.filter((f) => f.start <= x.at && x.at < f.end).sort((a, b) => (b.start - a.start))[0];
      // the site itself is the top-level read (a word followed to it), or names what it read, or sits in a function that does
      if (topReads.some((r) => r.start <= x.at && x.at < r.end) || usesRead(x.list) || (d && usesRead(src.slice(d.start, d.end)))) { x.kind = 'reader'; x.what = `${x.what} (it uses a credential this module reads at its top)`; }
    }
    delete x.at;
  }
  return found.sort((x, y) => x.line - y.line);
}
