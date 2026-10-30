// Shared parts of the rules hooks (design v4 §14.1.5; lead's call L1: M4 writes and installs them).
//
// A hook is a plain Node script Claude Code runs before a tool call. It reads the call as JSON on
// standard input and answers with its exit code: 0 lets the call run, 2 blocks it (the reason goes
// to standard error, which Claude shows the session). Every hook FAILS CLOSED: a bad argument,
// unreadable input, a stale rules snapshot or any internal error blocks (v3 §2.1 item 7).
//
// This folder is copied whole into the Do-plane's hook folder; launch check 7 compares every file
// byte for byte, so a hook may import only from this folder.

import { realpathSync, lstatSync } from 'node:fs';
import { dirname, basename, join, isAbsolute, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCK = 2;
export const block = (reason) => ({ block: true, reason });
export const pass = () => ({ block: false });

/** --role R --outbox O --snapshot S [--copy C] [--kinds a,b] [--kind K] [--event E] */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith('--') || v === undefined || v.startsWith('--')) throw new Error(`bad argument ${k}`);
    out[k.slice(2)] = v;
  }
  for (const need of ['role', 'outbox', 'snapshot']) if (!out[need]) throw new Error(`missing --${need}`);
  if (!isAbsolute(out.outbox) || (out.copy && !isAbsolute(out.copy))) throw new Error('paths must be absolute');
  out.kinds = out.kinds ? out.kinds.split(',').filter(Boolean) : [];
  return out;
}

async function readStdin(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Is this module the script node was started with? Real paths on both sides (L31): the hooks are
 * reached through a linked folder, which spells the path differently, and a mismatch would exit 0
 * having checked nothing, which lets every call through.
 */
export function isMain(moduleUrl, argv1 = process.argv[1]) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
  const self = real(fileURLToPath(moduleUrl));
  return !!(self && argv1 && self === real(argv1));
}

/**
 * Runs one hook body: `decide(input, args)` returns pass() or block(reason). Exits 0 or 2.
 * `io` is for tests: { argv, stdin, exit, stderr, stdout }.
 */
export async function runHook(decide, io = {}) {
  const argv = io.argv ?? process.argv.slice(2);
  const stdin = io.stdin ?? process.stdin;
  const exit = io.exit ?? ((c) => process.exit(c));
  const stderr = io.stderr ?? ((t) => process.stderr.write(t));
  let r;
  try {
    const args = parseArgs(argv);
    const text = await readStdin(stdin);
    const input = JSON.parse(text);
    if (!input || typeof input !== 'object') throw new Error('hook input is not an object');
    r = await decide(input, args, io);
    if (!r || typeof r.block !== 'boolean') throw new Error('hook gave no decision');
  } catch (e) {
    r = block(`hook error, refusing: ${e?.message ?? e}`);
  }
  if (r.block) { stderr(`[orchestrate] blocked: ${r.reason}\n`); return exit(BLOCK); }
  return exit(0);
}

// ---- paths ----

/**
 * The real path a write would land on: links in the existing part are resolved, the missing tail
 * is kept as written. A path with `..` left after that, or a relative path, is refused (null).
 */
export function landingPath(p) {
  if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) return null;
  const norm = resolve(p);
  let head = norm;
  const tail = [];
  for (;;) {
    let exists = false;
    try { lstatSync(head); exists = true; } catch { /* missing: walk up */ }
    if (exists) {
      // A link whose target is missing would land the write at its target: refuse (audit R-0b-44 M-2).
      try { const real = realpathSync.native(head); return tail.length ? join(real, ...tail.reverse()) : real; } catch { return null; }
    }
    const parent = dirname(head);
    if (parent === head) return null;
    tail.push(basename(head));
    head = parent;
  }
}

/**
 * Why the last part of `p` must not be written through, or null: a link of any kind, or a file
 * with a second name (a hard link), would send the write somewhere else (audit R-0b-44 M-2).
 */
export function linkedFile(p) {
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return 'is a link';
  if (st.isFile() && st.nlink > 1) return 'has a second name (a hard link)';
  if (!st.isFile() && !st.isDirectory()) return 'is not a plain file';
  return null;
}

export const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Real path of a folder given on the command line (the outbox, the copy); null if missing. */
export function realFolder(p) { try { return realpathSync.native(p); } catch { return null; } }

// Every path a tool call names. Grep's and Glob's search folder counts; a missing one is the cwd.
export function toolPaths(input) {
  const t = input.tool_input ?? {};
  const out = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof t[k] === 'string') out.push(t[k]);
  if (input.tool_name === 'Glob' && typeof t.pattern === 'string') out.push(t.pattern);
  return out;
}

// ---- shell lines ----

/** A backslash before a line break joins the two lines, as the shell does (audit R-0b-44 round 2 MAT-1). */
export const joinLines = (cmd) => String(cmd ?? '').replace(/\\\r?\n/g, '');

/**
 * The line with each here-document's body taken out, and the bodies (LEAD-CALLS L46; round 3 MAT-12). A body is text
 * fed to a program, not commands, so the shape checks and the command list skip it; the word checks still read it.
 * Where the guard and the shell could disagree on where a body ends, the line is refused (`why`): an end word that
 * is not a plain name (`1 << 2` is a shift, not a here-document), `<<` next to `((`, a body line ending in a
 * backslash, or a comment holding a quote. Read from the raw line: a backslash and line break inside a quoted body
 * stay as written.
 */
export function heredocs(cmd) {
  const s = String(cmd ?? '');
  let out = '';
  const bodies = [];
  const pending = [];
  let quotedComment = false;
  let q = null;
  let wordStart = true;
  const refuse = (why) => ({ text: s, bodies, why });
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (q) {
      out += ch;
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < s.length) { out += s[i + 1]; i += 1; }
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) { out += ch + s[i + 1]; i += 2; wordStart = false; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; i += 1; wordStart = false; continue; }
    if (ch === '#' && wordStart) {
      const end = s.indexOf('\n', i);
      const stop = end < 0 ? s.length : end;
      if (/['"]/.test(s.slice(i, stop))) quotedComment = true;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      let k = i + 2;
      const dash = s[k] === '-';
      if (dash) k += 1;
      while (s[k] === ' ' || s[k] === '\t') k += 1;
      let delim = '';
      let quoted = false;
      let dq = null;
      for (; k < s.length; k += 1) {
        const d = s[k];
        if (dq) { if (d === dq) dq = null; else delim += d; continue; }
        if (d === "'" || d === '"') { dq = d; quoted = true; continue; }
        if (d === '\\' && k + 1 < s.length) { quoted = true; delim += s[k + 1]; k += 1; continue; }
        if (/[\s;&|()<>]/.test(d)) break;
        delim += d;
      }
      if (dq || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(delim)) return refuse('a << whose end word is not a plain name');
      pending.push({ delim, dash, quoted });
      out += s.slice(i, k);
      i = k;
      wordStart = false;
      continue;
    }
    if (ch === '\n' && pending.length) {
      out += '\n';
      i += 1;
      for (const h of pending) {
        const lines = [];
        while (i < s.length) {
          const end = s.indexOf('\n', i);
          const line = s.slice(i, end < 0 ? s.length : end);
          i = end < 0 ? s.length : end + 1;
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        if (lines.some((l) => l.endsWith('\\'))) return refuse('a here-document line ending in a backslash');
        bodies.push({ text: lines.join('\n'), quoted: h.quoted });
      }
      pending.length = 0;
      wordStart = true;
      continue;
    }
    out += ch;
    i += 1;
    wordStart = /[\s;&|()<>]/.test(ch);
  }
  if (bodies.length || pending.length) {
    if (quotedComment) return refuse('a comment holding a quote next to a here-document');
    if (/\(\(/.test(bareText(out))) return refuse('a << next to (( ))');
  }
  return { text: out, bodies, why: null };
}

/** Splits a shell line into words, roughly: quotes are removed, joiners split. For matching, not running. */
const BLANK = /[ \t\n]/;
// A `|` inside an unquoted zsh group is kept as this mark, so a quoted `|` (`jq '.a | b'`) is never taken for one
// (confirm audit of L41, round 2, MAT-1).
export const GROUP_CHOICE = '\u0001';

export function shellWords(cmd, { groups = false } = {}) {
  if (typeof cmd !== 'string') return [];
  cmd = joinLines(cmd);
  const words = [];
  let cur = '';
  let q = null;
  // With `groups`, a `(` inside a word is read as a zsh pattern group (`a(b)c` is `abc`; audit of L41, MAT-9): its
  // brackets are dropped so the word reads whole, and a `|` inside it stays in the word as GROUP_CHOICE (`unreadable` refuses that).
  // Without it the line splits at every bracket, as before; the guards check both readings (`bothWords`).
  let group = 0;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
    if (groups && ch === '(' && (cur || group)) { group += 1; continue; }
    if (ch === ')' && group) { group -= 1; continue; }
    if (ch === '|' && group) { cur += GROUP_CHOICE; continue; }
    // Only the blanks bash splits on: an odd space (U+00A0) stays inside the word, as in bash.
    if (BLANK.test(ch) || ';&|()<>`$'.includes(ch)) { if (cur) words.push(cur); cur = ''; if (!BLANK.test(ch)) words.push(ch); continue; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/** Every word in both readings of the line: split at each bracket, and with zsh groups read whole. */
export const bothWords = (cmd) => [...new Set([...shellWords(cmd), ...shellWords(cmd, { groups: true })])];

// Wrappers `shellCommands` reads past to the program they run; `unreadable` refuses every wrapper but the plain forms
// it lets through (WRAPPERS below).
const STRIPPED_WRAPPERS = ['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'xargs', 'nice', 'builtin'];

/** The command line split into its commands (at ; && || | and newlines), each a word list. */
export function shellCommands(cmd, { raw = false } = {}) {
  const cmds = [];
  let cur = [];
  // The word after `<` or `>` is a file, not a command: it stays out of the command list (the
  // guards still see it among the words).
  let redirect = false;
  // A here-document's body is text fed to a program, not commands (L46).
  for (const w of shellWords(joinLines(heredocs(cmd).text).replace(/\n/g, ' ; '))) {
    if (w === '<' || w === '>') { redirect = true; continue; }
    if (redirect && w === '&') continue;
    if ([';', '&', '|', '(', ')', '`', '$'].includes(w)) { redirect = false; if (cur.length) cmds.push(cur); cur = []; continue; }
    if (redirect) { redirect = false; continue; }
    cur.push(w);
  }
  if (cur.length) cmds.push(cur);
  if (raw) return cmds;
  // Drop leading VAR=value words, the shell's own keywords (`then fakehost`) and wrappers that run
  // the next word.
  return cmds.map((c) => {
    let i = 0;
    for (;;) {
      if (i < c.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i])) { i += 1; continue; }
      if (i < c.length && ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'].includes(c[i])) { i += 1; continue; }
      if (i < c.length && STRIPPED_WRAPPERS.includes(programOf([c[i]]))) { i += 1; while (i < c.length && c[i].startsWith('-')) i += 1; continue; }
      break;
    }
    return c.slice(i);
  }).filter((c) => c.length);
}

// Homebrew installs the GNU tools under a `g` name (`grm`, `gcp`); each is read as the tool it is (audit of L41, round 2,
// MAT-14).
const GNU_NAMES = new Set(['rm', 'cp', 'mv', 'ln', 'rmdir', 'install', 'chmod', 'chown', 'chgrp', 'find', 'xargs', 'tar', 'timeout', 'stdbuf', 'nice', 'env', 'nohup', 'cat', 'sed', 'awk', 'touch', 'mkdir', 'dd', 'tee', 'split', 'csplit', 'shred', 'truncate', 'mktemp', 'readlink', 'realpath', 'link', 'unlink', 'chroot', 'patch']);
export const programOf = (words) => { const b = basename(words[0] ?? ''); return b.length > 1 && b[0] === 'g' && GNU_NAMES.has(b.slice(1)) ? b.slice(1) : b; };

// ---- shell shapes no hook can check (audit R-0b-44 M-4, M-5) ----
//
// The hooks read a command line as text. A wrapper that runs a string, a substitution or a
// variable can spell anything, so rather than try to understand them the guards refuse them where
// it matters. The refusal names the shape, so the session can write the command out plainly.

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'];
const INLINE = { node: /^(-e|-p|--eval|--print)$/, deno: /^eval$/, bun: /^(-e|--eval)$/, perl: /^-\w*e/, ruby: /^-\w*e/, php: /^-r$/, osascript: /^-e$/ };

/** A wrapper that runs a string as a command: sh -c, eval, source, `.`; with `inline`, node -e and kin too. */
export function wrapperOf(cmd, { inline = false } = {}) {
  for (const c of shellCommands(cmd)) {
    const prog = programOf(c);
    if (SHELLS.includes(prog) && c.slice(1).some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w))) return `${prog} -c`;
    if (['eval', 'source', '.'].includes(prog)) return prog;
    if (inline) {
      if (/^python[0-9.]*$/.test(prog) && c.slice(1).some((w) => /^-\w*c$/.test(w))) return `${prog} -c`;
      if (INLINE[prog] && c.slice(1).some((w) => INLINE[prog].test(w))) return `${prog} with inline code`;
    }
  }
  return null;
}

/** A command name that is a variable or a substitution: `$f deploy`, `$(echo x) deploy`. */
export const builtCommandName = (cmd) => /(^|[;&|(\n{]|\b(then|do|else)\b)\s*([A-Za-z_][A-Za-z0-9_]*=\S*\s+)*["']?[$`]/.test(String(cmd));

/** Any substitution or variable anywhere in the line (even inside quotes). */
export const hasExpansion = (cmd) => /[$`]/.test(String(cmd));

// ---- the class rule: refuse what the guards can't read (audit R-0b-44 round 2 MAT-1, R-0b-70) ----
//
// Round 1 added one blocker per trick found, and the next audit found more tricks. So every shell
// guard now first refuses, whatever it spells, any command the shell would rewrite before it runs
// (a variable, a substitution, an escape-built word, a pattern in a command name) or that runs
// commands its text does not show (a shell reading a file or its input, eval, xargs, find -exec,
// env -S, inline code, an interpreter fed on its input, a program run by its path). What is left
// is plain words, which the guards match. Even so these guards are a speed bump, not the wall: a
// script in any language the worker writes and then runs (`node x.mjs`, `npm run x`) can do what
// it likes. The walls are the sandbox (its no-write folders and network list), the push script
// and GitHub's branch rules (README, open items).

// Variables the launcher sets and the session cannot (each Bash call starts a fresh shell); `$?`
// is a number. Any other `$name` could be empty or anything (`g${x}it`).
const SAFE_VARS = new Set(['HOME', 'PWD', 'TMPDIR', 'USER', '?']);
// Folders a program may be run from by its full path; anything else may be a file the session wrote.
const SYSTEM_BIN = ['/bin', '/usr/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'];

/** The first shape in `cmd` a guard can't read, as a short phrase, or null. */
export function expansionIn(cmd) {
  const c = joinLines(cmd);
  let q = null;
  for (let i = 0; i < c.length; i += 1) {
    const ch = c[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (q === '"' && ch === '"') { q = null; continue; }
    if (!q && (ch === "'" || ch === '"')) { q = ch; continue; }
    if (ch === '`') return 'a backtick substitution';
    if (ch !== '$') continue;
    const next = c[i + 1] ?? '';
    if (next === '(') return 'a $( ) substitution';
    if (next === "'" || next === '"') return 'an escape-built word ($\'…\')';
    let name;
    if (next === '{') { const end = c.indexOf('}', i); name = end < 0 ? '' : c.slice(i + 2, end); i = end < 0 ? c.length : end; }
    else { name = /^([A-Za-z_][A-Za-z0-9_]*|.)/.exec(c.slice(i + 1))?.[0] ?? ''; i += name.length; }
    if (!SAFE_VARS.has(name)) return `a variable ($${name || ' '}) the guard can't read`;
  }
  return null;
}

/** Comma lists in braces, expanded as the shell would (`a{b,c}` gives ab and ac); capped. */
export function expandBraces(word, cap = 64) {
  const out = [];
  const walk = (w) => {
    if (out.length >= cap) return;
    const m = /\{([^{}]*,[^{}]*)\}/.exec(w);
    if (!m) { out.push(w); return; }
    for (const alt of m[1].split(',')) walk(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length));
  };
  walk(String(word));
  return out;
}

/**
 * A shell wildcard word as a pattern for one name: `*`, `?`, and `[…]` sets, where a leading `!` or `^` means
 * "not" and a `]` first in the set is a plain `]`, as in the shell. The one definition for both guards (L41 G1:
 * escaping `^` everywhere made `[^x]` a set of `^` and `x`, so `.e[^Q]v` never matched `.env`).
 */
export function globRe(g, flags = '') {
  let s = '';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') { s += '.*'; continue; }
    if (ch === '?') { s += '.'; continue; }
    if (ch === '[') {
      const not = g[i + 1] === '!' || g[i + 1] === '^';
      const from = i + 1 + (not ? 1 : 0);
      const end = g.indexOf(']', from + 1);
      if (end > from) {
        // A letter class (`[[:alpha:]]`, `[[=e=]]`, `[[.a.]]`) is not modelled: callers refuse on the throw.
        if (/\[[:=.]/.test(g.slice(from, end + 1))) throw new Error('a letter class in a pattern');
        s +=`[${not ? '^' : ''}${g.slice(from, end).replace(/[\\\]^[]/g, '\\$&')}]`;
        i = end;
        continue;
      }
    }
    s += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`, flags);
}

// ---- deny by default for whole classes (LEAD-CALLS L45; audit of L41, round 2) ----
//
// Each round of that audit found new spellings of the same tricks, so these shapes are refused as classes rather
// than read: a zsh group or glob qualifier, a brace range, a wrapper that runs the real program, and git settings
// given on the command line. The hooks only stop slips and casual workarounds; folder ownership and the separate
// Mac users are the wall (L34, L42, L45).

// Programs that run another program. Only the plain forms are read through: `env NAME=value cmd`, and `nohup`,
// `time`, `command`, `exec`, `builtin` with no options. Any other use, and every other wrapper, is refused (MAT-14).
const WRAPPERS = ['env', 'command', 'exec', 'nohup', 'time', 'builtin', 'sudo', 'doas', 'su', 'runuser', 'nice', 'renice', 'ionice',
  'caffeinate', 'timeout', 'stdbuf', 'chroot', 'arch', 'script', 'unbuffer', 'rlwrap', 'setsid', 'flock', 'taskset', 'chrt',
  'watch', 'eatmydata', 'sandbox-exec', 'xcrun', 'nsenter', 'unshare', 'firejail', 'proxychains', 'proxychains4', 'torsocks', 'faketime', 'with-env', 'dotenv',
  // zsh's own ones (round 3 Minor).
  'noglob', 'nocorrect', '-', 'repeat', 'coproc'];
const PLAIN_WRAPPERS = ['nohup', 'time', 'command', 'exec', 'builtin'];
const KEYWORDS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'];

/** The line with each quoted or escaped character replaced by `q`, so only the shell's own characters remain. */
function bareText(c) {
  let out = '';
  let q = null;
  for (let i = 0; i < c.length; i += 1) {
    const ch = c[i];
    if (q) { if (ch === q) q = null; else { if (ch === '\\' && q === '"') i += 1; out += 'q'; } continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '\\') { i += 1; out += 'q'; continue; }
    out += ch;
  }
  return out;
}

/**
 * A bracket the guards can't read: a `(` that does not start a subshell or a process substitution (`<(…)`), so a
 * zsh pattern group (`w(o)rk`, `(.e)nv`, `ls (a|b)`), a glob qualifier (`*(e:…:)`, `*(+cmd)`), an array (`a=(…)`)
 * or zsh's `=(…)`; and a `)` with a word stuck to its end (MAT-2 to MAT-5).
 */
function oddBracket(bare) {
  for (let i = 0; i < bare.length; i += 1) {
    const ch = bare[i];
    if (ch === ')') {
      const next = bare[i + 1];
      if (next !== undefined && !/[\s;&|)<>]/.test(next)) return 'a bracket with a word stuck to it (a zsh pattern group)';
      continue;
    }
    if (ch !== '(') continue;
    const before = bare.slice(0, i);
    // Only blanks are trimmed: a bracket first on a new line starts a subshell (round 3 MAT-12).
    const prev = before.replace(/[ \t]+$/, '');
    const attached = before.length > 0 && !/\s$/.test(before);
    if (prev === '' || /[;&|(\n]$/.test(prev)) continue;
    if (attached && /[<>]$/.test(prev)) continue;
    const word = /(\S+)$/.exec(prev)?.[1];
    if (!attached && KEYWORDS.includes(word) && (prev.length === word.length || /[\s;&|(]/.test(prev[prev.length - word.length - 1]))) continue;
    return 'a bracket that is not a subshell (a zsh pattern group, glob qualifier or array)';
  }
  return null;
}

// Changing a shell option anywhere in the line can change how the rest is read (`setopt extendedglob`, `braceccl`),
// and loading a module or builtin adds commands the guards don't know: refused as a class (L46; round 3 MAT-8).
const SHELL_OPTIONS = ['setopt', 'unsetopt', 'shopt', 'emulate', 'zmodload', 'enable', 'disable'];
const SET_OK = ['pipefail', 'errexit', 'nounset', 'xtrace', 'verbose'];
function plainSet(words) {
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === '--' || w === '-') return true;
    if (!/^[-+]/.test(w)) continue;
    if (!/^[-+][euxv]*o?$/.test(w)) return false;
    if (w.endsWith('o')) { i += 1; if (!SET_OK.includes(words[i])) return false; }
  }
  return true;
}
// The guards read `~`, `$HOME`, `$PWD` and `$TMPDIR` as the launcher set them; a line that sets one first could point
// them anywhere (L46; round 3 MAT-3). Any assignment, and any builtin that sets a variable by name, is refused.
const SAFE_NAMES = 'HOME|PWD|TMPDIR|USER';
const SETS_SAFE_VAR = [
  new RegExp(`(^|[\\s;&|(])(${SAFE_NAMES})(\\[[^\\]]*\\])?\\+?=`),
  new RegExp(`(^|[\\s;&|(])(export|typeset|declare|local|readonly|integer|float|private|unset|read|vared|getopts|for|select|foreach|print|printf|zparseopts|let|strftime|zformat)(\\s[^;&|\\n]*?)?[\\s=,:(+-](${SAFE_NAMES})\\b`),
];

/** Why a guard can't read this command (refuse it), or null when it is plain words. */
export function unreadable(cmd) {
  const h = heredocs(cmd);
  if (h.why) return h.why;
  const c = joinLines(h.text);
  const exp = expansionIn(c);
  if (exp) return exp;
  // A body whose end word is unquoted still expands `$…` and backticks; its quotes are plain letters.
  for (const b of h.bodies) {
    const e = b.quoted ? null : expansionIn(b.text.replace(/['"]/g, ' '));
    if (e) return `${e}, in a here-document`;
  }
  const bare = bareText(c);
  const bracket = oddBracket(bare);
  if (bracket) return bracket;
  if (/\{[^{}\s]*\.\.[^{}\s]*\}/.test(bare)) return 'a brace range ({a..b})';
  // Whole classes (LEAD-CALLS L46; round 3 MAT-3, MAT-6 to MAT-9, and *** once ** is let through).
  if (/\(\s*\)/.test(bare)) return 'a function definition';
  if (/(^|[\s;&|(])=[^\s=]/.test(bare)) return 'a word starting with = (zsh runs the program it names)';
  if (/<\d*-\d*>/.test(bare)) return 'a zsh number range (<1-9>)';
  if (/\*\*\*/.test(bare)) return 'a *** pattern (it follows links into any folder)';
  if (SETS_SAFE_VAR.some((re) => re.test(bare))) return 'a line that sets HOME, PWD, TMPDIR or USER, which the guards read as fixed';
  for (const raw of shellCommands(c, { raw: true })) {
    let i = 0;
    while (i < raw.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i]) || KEYWORDS.includes(raw[i]))) i += 1;
    while (i < raw.length) {
      const prog = programOf([raw[i]]);
      if (!WRAPPERS.includes(prog)) break;
      const next = raw[i + 1];
      if (prog === 'env') { i += 1; while (i < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i])) i += 1; if (raw[i]?.startsWith('-')) return /^(-[A-Za-z]*S|--split-string)/.test(raw[i]) ? 'env -S runs a string the guard can\'t check' : '"env" with options runs a command the guard can\'t read; run it directly'; continue; }
      if (PLAIN_WRAPPERS.includes(prog) && next !== undefined && !next.startsWith('-')) { i += 1; continue; }
      return `"${prog}" runs another program the guard can't read; run it directly`;
    }
  }
  const wrap = wrapperOf(c, { inline: true });
  if (wrap) return `"${wrap}" runs code the guard can't check`;
  if (/\|\s*(\S*\/)?(python[0-9.]*|node|perl|ruby|php|deno|bun|osascript|lua|tclsh)(\s+-\S+)*\s*($|[;&|)])/.test(c)
    || /(^|[;&|(]\s*)(\S*\/)?(python[0-9.]*|node|perl|ruby|php|deno|bun|osascript|lua|tclsh)(\s+-\S+)*\s*<(?!\()/.test(c)) return 'an interpreter fed code on its input';
  for (const words of shellCommands(c)) {
    const prog = programOf(words);
    const word0 = words[0];
    if (SHELLS.includes(prog)) return `"${prog}" runs commands the guard can't see`;
    if (word0 === 'function') return 'a function definition';
    if (SHELL_OPTIONS.includes(prog)) return `"${prog}" changes how the shell reads the line`;
    if (prog === 'set' && !plainSet(words)) return '"set" changing a shell option other than -e, -u, -x, -v or -o pipefail';
    if (!['[', '[['].includes(word0) && /[*?[\]{}]/.test(word0)) return 'a command name with a pattern in it';
    if (word0.includes('/') && !SYSTEM_BIN.includes(word0.slice(0, word0.lastIndexOf('/')))) return `"${word0}" runs a file by its path`;
    if (prog === 'find' && words.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w))) return 'find -exec runs commands the guard can\'t see';
    if (/^g?awk$/.test(prog) && words.slice(1).some((w) => /system\s*\(|\|\s*getline|\|\s*"/.test(w))) return 'awk running a command';
    // git settings on the command line can rename any command (`-c alias.x='clean -fdx'`), and an alias set now
    // runs later under a name the guards don't know (MAT-12).
    if (prog === 'git') {
      const sub = words.findIndex((w, k) => k > 0 && !w.startsWith('-') && !['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(words[k - 1]));
      const front = sub < 0 ? words.slice(1) : words.slice(1, sub);
      if (front.some((w) => w === '-c' || w.startsWith('--config-env') || /^-c./.test(w))) return 'git settings given on the command line';
      if (words[sub] === 'config' && words.slice(sub + 1).some((w) => /^alias\./i.test(w))) return 'a git alias being set';
    }
  }
  // `env -S "…"` splits one word into a command (shellCommands drops `env` and its flags).
  const all = shellWords(c);
  // xargs is dropped as a wrapper by shellCommands, so it is looked for among the words.
  if (shellWords(c, { groups: true }).some((w) => w.includes(GROUP_CHOICE))) return 'a zsh pattern group with a choice in it';
  const feeder = all.find((w) => ['xargs', 'parallel'].includes(basename(w)));
  if (feeder) return `"${basename(feeder)}" builds commands the guard can't see`;
  for (let i = 0; i < all.length; i += 1) {
    if (basename(all[i]) !== 'env') continue;
    for (let k = i + 1; k < all.length && all[k].startsWith('-'); k += 1) if (/^(-[A-Za-z]*S|--split-string)/.test(all[k])) return 'env -S runs a string the guard can\'t check';
  }
  return null;
}

/**
 * Names folded as a Mac disk compares them (audit R-0b-44 round 2 MAT-2, round 3 MAT-1): compatibility forms
 * (the ligature ﬁ is f+i), case through upper then lower (long s ſ is s, ß is ss), invisible characters dropped.
 * The one definition: git/push-refusals.mjs re-exports it.
 */
// Upper then lower twice: capital sharp s lowers to sharp s, which only the second round turns into ss (L37).
export const fold = (s) => String(s).normalize('NFKC').toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');

/**
 * Plain names only (LEAD-CALLS L37): a list of tricky letters is never finished, so the secret and
 * protected-file guards refuse any path with a character outside ASCII letters, digits and `. _ - /`,
 * plus `@ [ ] ( ) +` (scoped packages and route folders hold them; all plain ASCII, none folds).
 * A path the fold changes beyond lower-casing always holds such a character, so this one test covers both.
 * Returns the refusal reason, or null.
 */
export const PLAIN_PATH = /^[A-Za-z0-9._\-/@[\]()+]*$/;
export const oddPath = (p) => (PLAIN_PATH.test(String(p)) ? null : `"${p}" is not a plain name (only ASCII letters, digits and . _ - / @ [ ] ( ) + are allowed)`);
/**
 * A shell word cannot be held to the path rule (messages, flags), so it is refused when the fold changes
 * it beyond lower-casing or it holds a letter outside ASCII (L37; a look-alike on no list is caught too).
 */
export const oddWord = (w) => (fold(w) !== String(w).toLowerCase() || /[^\p{ASCII}]/u.test(String(w).replace(/[^\p{L}\p{M}\p{N}]/gu, ''))
  ? `the word "${w}" holds a letter that is not plain ASCII` : null);

/** The command names git's own settings or hooks files (`.git/config`, `.git/hooks/…`, `.git/info/…`). */
// Each word's path is tidied first, so `.git/./config` and `.git//hooks` count (audit R-0b-44 round 3 MIN-1).
export const namesGitInternals = (cmd) => [joinLines(cmd), ...shellWords(String(cmd ?? '')).flatMap((w) => [w, posix.normalize(w)])]
  .some((t) => /(^|[\/\s"'=:])\.git\/(config|hooks|info)(\b|\/|$)/i.test(t));
