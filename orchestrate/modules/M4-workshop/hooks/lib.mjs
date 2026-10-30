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

/** Splits a shell line into words, roughly: quotes are removed, joiners split. For matching, not running. */
export function shellWords(cmd) {
  if (typeof cmd !== 'string') return [];
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
  for (const w of shellWords(String(cmd).replace(/\n/g, ' ; '))) {
    if ([';', '&', '|', '(', ')', '`', '$', '<', '>'].includes(w)) { if (cur.length) cmds.push(cur); cur = []; continue; }
    cur.push(w);
  }
  if (cur.length) cmds.push(cur);
  // Drop leading VAR=value words and wrappers that run the next word.
  return cmds.map((c) => {
    let i = 0;
    for (;;) {
      if (i < c.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i])) { i += 1; continue; }
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
