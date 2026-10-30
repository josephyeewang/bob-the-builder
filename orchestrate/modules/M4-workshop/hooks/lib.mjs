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
import { dirname, basename, join, isAbsolute, resolve, sep } from 'node:path';
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
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
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
      try { const real = realpathSync(head); return tail.length ? join(real, ...tail.reverse()) : real; } catch { return null; }
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
export function realFolder(p) { try { return realpathSync(p); } catch { return null; } }

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

/** Splits a shell line into words, roughly: quotes are removed, joiners split. For matching, not running. */
export function shellWords(cmd) {
  if (typeof cmd !== 'string') return [];
  cmd = joinLines(cmd);
  const words = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
    if (/\s/.test(ch) || ';&|()<>`$'.includes(ch)) { if (cur) words.push(cur); cur = ''; if (!/\s/.test(ch)) words.push(ch); continue; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/** The command line split into its commands (at ; && || | and newlines), each a word list. */
export function shellCommands(cmd) {
  const cmds = [];
  let cur = [];
  // The word after `<` or `>` is a file, not a command: it stays out of the command list (the
  // guards still see it among the words).
  let redirect = false;
  for (const w of shellWords(joinLines(cmd).replace(/\n/g, ' ; '))) {
    if (w === '<' || w === '>') { redirect = true; continue; }
    if (redirect && w === '&') continue;
    if ([';', '&', '|', '(', ')', '`', '$'].includes(w)) { redirect = false; if (cur.length) cmds.push(cur); cur = []; continue; }
    if (redirect) { redirect = false; continue; }
    cur.push(w);
  }
  if (cur.length) cmds.push(cur);
  // Drop leading VAR=value words, the shell's own keywords (`then fakehost`) and wrappers that run
  // the next word.
  return cmds.map((c) => {
    let i = 0;
    for (;;) {
      if (i < c.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i])) { i += 1; continue; }
      if (i < c.length && ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'].includes(c[i])) { i += 1; continue; }
      if (i < c.length && ['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'xargs', 'nice', 'builtin'].includes(basename(c[i]))) { i += 1; while (i < c.length && c[i].startsWith('-')) i += 1; continue; }
      break;
    }
    return c.slice(i);
  }).filter((c) => c.length);
}

export const programOf = (words) => basename(words[0] ?? '');

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

/** Why a guard can't read this command (refuse it), or null when it is plain words. */
export function unreadable(cmd) {
  const c = joinLines(cmd);
  const exp = expansionIn(c);
  if (exp) return exp;
  const wrap = wrapperOf(c, { inline: true });
  if (wrap) return `"${wrap}" runs code the guard can't check`;
  if (/\|\s*(\S*\/)?(python[0-9.]*|node|perl|ruby|php|deno|bun|osascript|lua|tclsh)(\s+-\S+)*\s*($|[;&|)])/.test(c)
    || /(^|[;&|(]\s*)(\S*\/)?(python[0-9.]*|node|perl|ruby|php|deno|bun|osascript|lua|tclsh)(\s+-\S+)*\s*<(?!\()/.test(c)) return 'an interpreter fed code on its input';
  for (const words of shellCommands(c)) {
    const prog = programOf(words);
    const word0 = words[0];
    if (SHELLS.includes(prog)) return `"${prog}" runs commands the guard can't see`;
    if (!['[', '[['].includes(word0) && /[*?[\]{}]/.test(word0)) return 'a command name with a pattern in it';
    if (word0.includes('/') && !SYSTEM_BIN.includes(word0.slice(0, word0.lastIndexOf('/')))) return `"${word0}" runs a file by its path`;
    if (prog === 'find' && words.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w))) return 'find -exec runs commands the guard can\'t see';
    if (/^g?awk$/.test(prog) && words.slice(1).some((w) => /system\s*\(|\|\s*getline|\|\s*"/.test(w))) return 'awk running a command';
  }
  // `env -S "…"` splits one word into a command (shellCommands drops `env` and its flags).
  const all = shellWords(c);
  // xargs is dropped as a wrapper by shellCommands, so it is looked for among the words.
  const feeder = all.find((w) => ['xargs', 'parallel'].includes(basename(w)));
  if (feeder) return `"${basename(feeder)}" builds commands the guard can't see`;
  for (let i = 0; i < all.length; i += 1) {
    if (basename(all[i]) !== 'env') continue;
    for (let k = i + 1; k < all.length && all[k].startsWith('-'); k += 1) if (/^(-[A-Za-z]*S|--split-string)/.test(all[k])) return 'env -S runs a string the guard can\'t check';
  }
  return null;
}

/** Case and invisible characters folded out, as a Mac disk compares names (audit R-0b-44 round 2 MAT-2). */
export const fold = (s) => String(s).normalize('NFC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').toLowerCase();

/** The command names git's own settings or hooks files (`.git/config`, `.git/hooks/…`, `.git/info/…`). */
export const namesGitInternals = (cmd) => [joinLines(cmd), ...shellWords(String(cmd ?? ''))]
  .some((t) => /(^|[\/\s"'=:])\.git\/(config|hooks|info)(\b|\/|$)/i.test(t));
