// R-0b-179 (b), L1148 F6: no credential goes on a command line. On a Mac /bin/ps is setuid root (system-protected), so every
// Mac user, the builder among them, reads every process's full command line; the environment is shown only to the
// process's own user (measured in L1148 F7). So a token, key or password a child needs goes in its environment
// (safe-git.mjs GIT_CONFIG_*), a file it reads (watch-run --token-file), or its stdin, never in its arguments.
//
// A source scan, run over every module by credential-args.test.mjs. It reads the argument list of each call that starts a
// program (CALL), each array assigned to a name that says it is arguments (`args`, `argv`), and each launchd
// ProgramArguments list, and reports:
//   flag   a literal credential flag, `--token`, `--password`, `--api-key`, `--token=…` (one that names a file, a path or a
//          descriptor, `--token-file`, is the safe way and passes)
//   value  a name that says it holds a credential (`token`, `appKey`, `cfg.secret`) inside the list; a name that says it
//          is where one is kept or what kind it is (`tokenFile`, `tokenPath(cfg)`, `secretKind`) passes
//   text   an Authorization header, `x-access-token:`, or a URL with a password in it (`https://u:p@host`)
// Only the argument list is read: an options object after it (`{ env: { GH_TOKEN: token } }`) is the safe place, so it
// is never looked at. What it can't see: a list built in pieces under a name it doesn't know, or a credential under a
// name that doesn't say so. It is a tripwire for the easy mistake, not a proof; the proof is that the code passes what it
// must through the environment, which the push and the watch job do today.

/** Calls that start a program, and the plist helper the job files build ProgramArguments with. */
const CALL = /(?<![\w.])(?:spawn|spawnSync|execFile|execFileSync|fork|runChild|run|runGit|gitOk|git|arr)\s*\(|\.(?:run|spawn|spawnSync|execFile|execFileSync)\s*\(/g;
const ARGS_ARRAY = /(?:const|let|var)\s+\w*(?:args|argv|Args|Argv)\w*\s*=\s*(?=\[)/g;
const PLIST = /ProgramArguments/g;

const CRED_WORD = /(?:token|secret|passw(?:or)?d|passphrase|api[-_]?key|private[-_]?key|app[-_]?key|bearer|credential|cookie)/i;
/** A name ending like this says where a credential is kept or what it is, not the credential: it may go on a command line. */
const SAFE_END = /(?:file|files|path|paths|dir|fd|name|names|id|ids|kind|kinds|fact|count|max|min|re|pattern|problem|why|env|var|vars|url_?env|length|len|seen|ok|label|key_file|keyfile|place|where|exists|mode|owner|uid|source)$/i;
const FLAG = /^--?([a-z][\w-]*?)(?:=.*)?$/i;
const SAFE_FLAG_END = /-(?:file|path|fd|dir|env|kind|id|name)$/i;
const TEXT = [
  [/authorization\s*:/i, 'an Authorization header'],
  [/x-access-token:/i, 'x-access-token: (a token in a URL or header)'],
  [/:\/\/[^\s/'"`@:]+:[^\s/'"`@]+@/, 'a URL with a password in it'],
  [/\bbearer\s+\$\{/i, 'a Bearer token'],
];

/** The text from `open` (an index of '(' or '[') to its partner, strings and comments skipped; null if it never closes. */
function balanced(src, open) {
  const want = { '(': ')', '[': ']', '{': '}' }; const stack = [];
  for (let i = open; i < src.length && i < open + 20000; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); if (n < 0) return null; i = n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n < 0) return null; i = n + 1; continue; }
    if (c === "'" || c === '"') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '`') { // a template: skip its text, but a ${…} inside it is balanced on its own
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { const inner = balanced(src, i + 1); if (inner === null) return null; i = i + 1 + inner.length; continue; }
        i++;
      }
      continue;
    }
    if (want[c]) stack.push(want[c]);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return null; if (!stack.length) return src.slice(open, i + 1); }
  }
  return null;
}

/**
 * The source with every comment turned to spaces (its newlines kept, so line numbers hold), strings and templates left as
 * they are: a call written in a comment is not a call, and `https://` in a string is not a comment. A regular expression
 * literal is not told apart from a division; one holding a quote could make the rest of its line read as a string, which
 * at worst hides a finding on that line, never makes one up.
 */
export function blankComments(src) {
  let out = ''; let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); const end = n < 0 ? src.length : n; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); const end = n < 0 ? src.length : n + 2; out += blank(src.slice(i, end)); i = end; continue; }
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

/** The first top-level [...] inside a call's parentheses (its argument list), or null. */
function firstArray(call) {
  let depth = 0;
  for (let i = 1; i < call.length - 1; i++) {
    const c = call[i];
    if (c === "'" || c === '"') { const q = c; i++; while (i < call.length && call[i] !== q) { if (call[i] === '\\') i++; i++; } continue; }
    if (c === '`') { const t = templateEnd(call, i); if (t < 0) return null; i = t; continue; }
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === '[' && depth === 0) return balanced(call, i);
  }
  return null;
}

/** String literals (their text) and the names outside them, in an argument list. */
function pieces(list) {
  const strings = []; const names = []; let rest = '';
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'" || c === '"') { const q = c; let s = ''; i++; while (i < list.length && list[i] !== q) { if (list[i] === '\\') { s += list[i + 1]; i += 2; continue; } s += list[i]; i++; } strings.push(s); rest += ' '; continue; }
    if (c === '`') {
      let s = ''; i++;
      while (i < list.length && list[i] !== '`') {
        if (list[i] === '\\') { s += list[i + 1]; i += 2; continue; }
        if (list[i] === '$' && list[i + 1] === '{') { const inner = balanced(list, i + 1) ?? ''; rest += ` ${inner.slice(1, -1)} `; s += '${'; i += 1 + inner.length; continue; }
        s += list[i]; i++;
      }
      strings.push(s); rest += ' '; continue;
    }
    rest += c;
  }
  // A name: the last word of a dotted chain (cfg.watch.token → token), or a call's own name (tokenPath(cfg) → tokenPath).
  for (const m of rest.matchAll(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g)) names.push(m[0].split('.').at(-1).trim());
  return { strings, names };
}

function judge(list) {
  const out = []; const { strings, names } = pieces(list);
  for (const s of strings) {
    const f = FLAG.exec(s);
    if (f && CRED_WORD.test(f[1]) && !SAFE_FLAG_END.test(f[1])) out.push(['flag', s.split('=')[0]]);
    for (const [re, what] of TEXT) if (re.test(s)) out.push(['text', what]);
  }
  for (const n of names) if (CRED_WORD.test(n) && !SAFE_END.test(n)) out.push(['value', n]);
  return out;
}

/**
 * The credential-on-a-command-line findings in one module's source: [{ line, kind, what, list }], `list` the first 120
 * characters of the argument list. An empty list when there are none.
 */
export function credentialArgFindings(text) {
  const src = blankComments(text);
  const found = []; const seen = new Set();
  const add = (at, list) => {
    if (!list || seen.has(at)) return; seen.add(at);
    const line = src.slice(0, at).split('\n').length;
    for (const [kind, what] of judge(list)) {
      const key = `${line} ${kind} ${what}`;   // a job file's arr([...]) is met both as a call and after ProgramArguments
      if (!seen.has(key)) { seen.add(key); found.push({ line, kind, what, list: list.replace(/\s+/g, ' ').slice(0, 120) }); }
    }
  };
  for (const m of src.matchAll(CALL)) { const call = balanced(src, m.index + m[0].length - 1); if (call) add(m.index, firstArray(call)); }
  for (const m of src.matchAll(ARGS_ARRAY)) add(m.index, balanced(src, m.index + m[0].length));
  for (const m of src.matchAll(PLIST)) {
    // The list that follows the key in a job file: an arr([...]) call, or an <array> written out.
    const after = src.slice(m.index, m.index + 4000);
    const b = after.indexOf('['); const a = after.indexOf('<array>');
    if (a >= 0 && (b < 0 || a < b)) {
      // Written out as XML: each <string> is one argument, read as a quoted string.
      const end = after.indexOf('</array>', a);
      if (end > 0) add(m.index, `[${[...after.slice(a, end).matchAll(/<string>([^<]*)<\/string>/g)].map((x) => JSON.stringify(x[1])).join(', ')}]`);
    }
    else if (b >= 0) add(m.index, balanced(after, b));
  }
  return found.sort((x, y) => x.line - y.line);
}
