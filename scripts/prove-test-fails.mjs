#!/usr/bin/env node
// prove-test-fails.mjs — Bob Phase Gate item 11: a fix is proven only when its named test
// FAILS with the fix removed and PASSES with it restored, at the exact commit under review.
//
// Method ported from pullboard (src/guard-revert.js @ 1694efbc, v0.9.3), MIT,
// Copyright (c) 2026 Corey Olson — licence in third_party/pullboard/LICENSE.
// Rewritten for Bob by Joe Wang, 2026-10 (no pullboard code is imported; zero dependencies).
//
// What it does, in plain English:
//   1. Makes a throw-away copy of the repo at exactly the commit you name (a git worktree in a
//      temp folder) — your working folder is never touched.
//   2. Deletes the lines you say are "the fix" and runs the test. The test must FAIL.
//      (If it still passes, the test is not testing the fix.)
//   3. Puts the lines back and runs the test again. It must PASS.
//   4. Prints a short receipt tied to the full commit hash, then deletes the copy.
//
// Usage:
//   node scripts/prove-test-fails.mjs --commit <sha> --test "<command>" --fix <path>:<from>-<to> [--fix ...]
//        [--setup "<command>"]        run once in the copy before testing (e.g. "npm ci")
//        [--repo <dir>]               repo to use (default: the git repo containing the cwd)
//        [--builder-session <id>]     refuse if this run's session id equals the builder's
//        [--timeout <seconds>]        per test run (default 600)
//
// Exit: 0 = PROVEN · 1 = NOT PROVEN (test green with fix removed, or red with fix restored)
//       2 = could not run (bad arguments, bad commit/range, test command not found, same session)
//
// Session rule: the receipt only counts if a session OTHER than the builder's runs it. The script
// records the session id it sees (CLAUDE_SESSION_ID / CLAUDE_CODE_SESSION_ID / BOB_SESSION_ID) and,
// when --builder-session is given, refuses to run as that same session. When neither id is known
// the receipt says "unrecorded" — the reviewer must then state who ran it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_PROVEN = 0;
const EXIT_NOT_PROVEN = 1;
const EXIT_CANNOT_RUN = 2;

class CannotRun extends Error {}

// Throw (never process.exit) so the scratch copy is always cleaned up in `finally`.
function cannotRun(message) {
  throw new CannotRun(message);
}

function parseArgs(argv) {
  const opts = { fixes: [], timeout: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) cannotRun(`${flag} needs a value`);
      i += 1;
      return argv[i];
    };
    if (flag === '--commit') opts.commit = value();
    else if (flag === '--test') opts.test = value();
    else if (flag === '--fix') opts.fixes.push(value());
    else if (flag === '--setup') opts.setup = value();
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--builder-session') opts.builderSession = value();
    else if (flag === '--timeout') opts.timeout = Number(value());
    else if (flag === '-h' || flag === '--help') {
      process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split('\n')
        .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n');
      process.exit(0);
    } else cannotRun(`unknown argument "${flag}" (try --help)`);
  }
  if (!opts.commit) cannotRun('--commit <sha> is required');
  if (!opts.test) cannotRun('--test "<command>" is required — every fix item must name the test that proves it');
  if (opts.fixes.length === 0) cannotRun('at least one --fix <path>:<from>-<to> is required');
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) cannotRun('--timeout must be a positive number of seconds');
  return opts;
}

// `<path>:<from>-<to>` — same shape as pullboard's `guard: <path>:<from>-<to>`.
const FIX = /^(.+):(\d+)-(\d+)$/u;

export function parseFix(text) {
  const found = FIX.exec(String(text).trim());
  if (!found) return { error: `"${text}" is not <path>:<from>-<to>` };
  const path = found[1].replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '');
  const from = Number(found[2]);
  const to = Number(found[3]);
  if (path.startsWith('/') || path.split('/').includes('..')) return { error: `${path} must be a path inside the repo` };
  if (from < 1 || to < from) return { error: `${text}: line range must be from>=1 and to>=from` };
  return { path, from, to, text: `${path}:${from}-${to}` };
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
}

// A hook or a parent git process may export GIT_DIR / GIT_INDEX_FILE; they would point the scratch
// runs back at the real repo. Strip them.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX)$/u.test(key)) delete env[key];
  }
  return env;
}

function runShell(command, cwd, timeoutSeconds) {
  const started = Date.now();
  const run = spawnSync('/bin/sh', ['-c', command], {
    cwd, encoding: 'utf8', env: cleanEnv(), timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return {
    status: run.status,
    timedOut: run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM',
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    tail: output.trim().split('\n').slice(-8).join('\n'),
  };
}

// Remove every named range. Ranges in the same file are removed bottom-up so earlier removals do
// not shift later line numbers; overlapping ranges are refused (ambiguous).
export function removeFixLines(directory, fixes) {
  const byFile = new Map();
  for (const fix of fixes) {
    if (!byFile.has(fix.path)) byFile.set(fix.path, []);
    byFile.get(fix.path).push(fix);
  }
  const originals = new Map();
  for (const [path, ranges] of byFile) {
    const file = join(directory, path);
    if (!existsSync(file)) return { error: `${path} is not in the commit` };
    const original = readFileSync(file, 'utf8');
    const lines = original.split('\n');
    const lineCount = original.endsWith('\n') ? lines.length - 1 : lines.length;
    const sorted = [...ranges].sort((a, b) => b.from - a.from);
    for (let i = 0; i < sorted.length; i += 1) {
      const r = sorted[i];
      if (r.to > lineCount) return { error: `${path} has ${lineCount} lines, so no lines ${r.from}-${r.to}` };
      if (i > 0 && r.to >= sorted[i - 1].from) return { error: `${path}: ranges ${r.text} and ${sorted[i - 1].text} overlap` };
      lines.splice(r.from - 1, r.to - r.from + 1);
    }
    originals.set(file, original);
    writeFileSync(file, lines.join('\n'));
  }
  return { originals };
}

function sessionId() {
  return process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.BOB_SESSION_ID || '';
}

function main() {
  try {
    process.exitCode = prove();
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    process.stderr.write(`prove-test-fails: CANNOT RUN — ${error.message}\n`);
    process.exitCode = EXIT_CANNOT_RUN;
  }
}

function prove() {
  const opts = parseArgs(process.argv.slice(2));
  const fixes = opts.fixes.map(parseFix);
  const bad = fixes.find((f) => f.error);
  if (bad) cannotRun(bad.error);

  const me = sessionId();
  if (opts.builderSession && me && opts.builderSession === me) {
    cannotRun(`this session (${me}) is the builder's session — the receipt must come from a different session`);
  }

  const top = git(['rev-parse', '--show-toplevel'], opts.repo ?? process.cwd());
  if (top.status !== 0) cannotRun(`${opts.repo ?? process.cwd()} is not inside a git repository`);
  const root = top.stdout.trim();
  const resolved = git(['rev-parse', '--verify', '--quiet', `${opts.commit}^{commit}`], root);
  if (resolved.status !== 0) cannotRun(`commit "${opts.commit}" not found in ${root}`);
  const sha = resolved.stdout.trim();

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bob-prove-')));
  const copy = join(scratch, 'repo');
  let result = EXIT_CANNOT_RUN;
  try {
    const added = git(['worktree', 'add', '--detach', '--quiet', copy, sha], root);
    if (added.status !== 0) cannotRun(`could not make a scratch copy at ${sha}: ${added.stderr.trim()}`);

    if (opts.setup) {
      const setup = runShell(opts.setup, copy, opts.timeout);
      if (setup.status !== 0) cannotRun(`setup command failed (exit ${setup.status}):\n${setup.tail}`);
    }

    const removed = removeFixLines(copy, fixes);
    if (removed.error) cannotRun(removed.error);
    const red = runShell(opts.test, copy, opts.timeout);
    if (red.status === 126 || red.status === 127) {
      cannotRun(`the test command could not start (exit ${red.status} — command not found or not executable):\n${red.tail}`);
    }

    for (const [file, original] of removed.originals) writeFileSync(file, original);
    const green = runShell(opts.test, copy, opts.timeout);

    const redOk = red.status !== 0 && !red.timedOut;
    const greenOk = green.status === 0;
    const describe = (run) => (run.timedOut ? `TIMED OUT after ${opts.timeout}s` : run.status === 0 ? 'PASSED (exit 0)' : `FAILED (exit ${run.status})`);
    const lines = [
      'PROVE-TEST-FAILS RECEIPT',
      `commit:            ${sha}`,
      `test:              ${opts.test}`,
      `fix removed:       ${fixes.map((f) => f.text).join(', ')}`,
      `with fix removed:  test ${describe(red)} in ${red.seconds}s — ${redOk ? 'as required' : 'NOT AS REQUIRED: must fail'}`,
      `with fix restored: test ${describe(green)} in ${green.seconds}s — ${greenOk ? 'as required' : 'NOT AS REQUIRED: must pass'}`,
    ];
    if (redOk && greenOk) {
      lines.push('verdict:           PROVEN — this test fails without the fix and passes with it.');
      result = EXIT_PROVEN;
    } else if (!redOk) {
      lines.push('verdict:           NOT PROVEN — the test stays green with the fix removed, so it does not test the fix.');
      result = EXIT_NOT_PROVEN;
    } else {
      lines.push('verdict:           NOT PROVEN — the test fails even with the fix in place.');
      result = EXIT_NOT_PROVEN;
    }
    lines.push(`run by:            ${userInfo().username}@${hostname()} · session ${me || 'unrecorded'} · ${new Date().toISOString()}`);
    if (opts.builderSession) lines.push(`builder session:   ${opts.builderSession}${me ? ' (different — OK)' : ' (this session unrecorded — reviewer must confirm)'}`);
    if (result !== EXIT_PROVEN) {
      lines.push('--- last lines of the run that did not go as required ---');
      lines.push((redOk ? green : red).tail || '(no output)');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    git(['worktree', 'remove', '--force', copy], root);
    rmSync(scratch, { recursive: true, force: true });
    git(['worktree', 'prune'], root);
  }
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
