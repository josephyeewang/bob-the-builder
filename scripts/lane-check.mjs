#!/usr/bin/env node
// lane-check.mjs — folder-ownership ("lane") check for projects where several sessions or branches
// work in parallel. Each lane owns some folders/files; a branch belongs to a lane by its name prefix;
// this reports any changed file that belongs to a different lane.
//
// laneOf / outOfLane ported from pullboard (src/lanes.js @ 1694efbc, v0.9.3), MIT,
// Copyright (c) 2026 Corey Olson — licence in third_party/pullboard/LICENSE. Adapted for Bob by
// Joe Wang, 2026-10: the lane list is read from the project's own register file (not pullboard.json),
// owners can be folders, single files or simple globs, and branches map to lanes by prefix.
//
// THE REGISTER (default location: docs/lanes.md; or pass --register <path>). A markdown table or a
// .tsv file with three columns — lane · branch prefixes · owns — lists comma-separated:
//
//   | lane   | branch prefixes | owns                                   |
//   |--------|-----------------|----------------------------------------|
//   | web    | web/, ui/       | apps/web/, packages/ui/                |
//   | api    | api/            | services/api/, contracts/api.yaml      |
//   | shared | -               | docs/, README.md, *.lock               |
//
//   - A folder ends with "/". A path without "/" at the end is a single-owner file.
//   - "*" matches within one folder level, "**" matches across levels.
//   - The most specific owner wins (exact file > longest folder/glob), as in pullboard.
//   - The lane named "shared" is open to every lane.
//   - A branch that matches no prefix (e.g. main) is the coordinator's: it may change anything.
//   - A file no lane owns belongs to the coordinator, so a lane branch touching it is out of lane.
//
// Usage:
//   node scripts/lane-check.mjs [--register <path>] [--branch <name>] [--files a b c | --range A..B] [--enforce]
//   Default files: the staged files (git diff --cached --name-only) — i.e. what a pre-commit hook sees.
//   Default mode is WARN: prints the out-of-lane files and exits 0. --enforce exits 1 on any.
//   Exit 2 = cannot run (and in WARN mode a missing register is a note, exit 0).
//
// WIRING INTO A GLOBAL HOOK CHAIN (core.hooksPath). If `git config core.hooksPath` is set globally,
// per-repo .git/hooks are ignored, so add the call to the global pre-commit script, gated on the
// project carrying a register, e.g.:
//
//   if [ -f docs/lanes.md ] && command -v node >/dev/null; then
//     node ~/.claude/skills/bob/../scripts/lane-check.mjs || exit 1      # add --enforce when ready
//   fi
//
// Start in WARN mode for a week; switch to --enforce once the register matches how work is split.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COORDINATOR = 'coordinator';
export const SHARED = 'shared';
const DEFAULT_REGISTER = 'docs/lanes.md';

const splitList = (cell) => cell.split(',').map((s) => s.trim().replace(/^`|`$/gu, ''))
  .filter((s) => s && s !== '-' && s !== '—');

export function parseRegister(text, isTsv) {
  const lanes = [];
  for (const raw of text.split(/\r?\n/u)) {
    let cells;
    if (isTsv) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      cells = raw.split('\t');
    } else {
      if (!raw.trim().startsWith('|')) continue;
      cells = raw.trim().replace(/^\||\|$/gu, '').split('|');
    }
    cells = cells.map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^:?-{2,}:?$/u.test(cells[0])) continue; // markdown separator row
    if (cells[0].toLowerCase() === 'lane') continue; // header row
    const name = cells[0].replace(/^`|`$/gu, '').toLowerCase();
    lanes.push({ name, prefixes: splitList(cells[1]), owns: splitList(cells[2]) });
  }
  return lanes;
}

function globToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') { out += '.*'; i += 1; if (pattern[i + 1] === '/') i += 1; }
    else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

// How specifically one owner entry matches a path: -1 = no match. Exact file beats any folder/glob.
function specificity(entry, path) {
  if (/[*?]/u.test(entry)) {
    const pattern = entry.endsWith('/') ? `${entry}**` : entry;
    return globToRegex(pattern).test(path) ? entry.replace(/[*?]/gu, '').length : -1;
  }
  if (entry.endsWith('/')) return path.startsWith(entry) ? entry.length : -1;
  return path === entry ? Number.MAX_SAFE_INTEGER : -1;
}

/** The lane that owns a path: the most specific match wins; unowned paths are the coordinator's. */
export function laneOf(lanes, path) {
  let owner = COORDINATOR;
  let best = -1;
  for (const lane of lanes) {
    for (const entry of lane.owns) {
      const score = specificity(entry, path);
      if (score > best) { owner = lane.name; best = score; }
    }
  }
  return owner;
}

/** The paths a lane may not change, each as `path (owner's)`. Shared paths are open to every lane. */
export function outOfLane(lanes, lane, paths) {
  if (lane === COORDINATOR) return [];
  return paths
    .filter((path) => { const owner = laneOf(lanes, path); return owner !== SHARED && owner !== lane; })
    .map((path) => `${path} (${laneOf(lanes, path)}'s)`);
}

/** The lane a branch belongs to: the longest matching branch-name prefix; none = coordinator. */
export function laneOfBranch(lanes, branch) {
  let owner = COORDINATOR;
  let longest = 0;
  for (const lane of lanes) {
    for (const prefix of lane.prefixes) {
      if (branch.startsWith(prefix) && prefix.length > longest) { owner = lane.name; longest = prefix.length; }
    }
  }
  return owner;
}

function git(args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || '').trim()}`);
  return run.stdout;
}

function main() {
  const args = process.argv.slice(2);
  const opts = { enforce: false, files: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--enforce') opts.enforce = true;
    else if (a === '--register') { opts.register = args[i + 1]; i += 1; }
    else if (a === '--branch') { opts.branch = args[i + 1]; i += 1; }
    else if (a === '--range') { opts.range = args[i + 1]; i += 1; }
    else if (a === '--files') { opts.files = args.slice(i + 1); break; }
    else if (a === '-h' || a === '--help') {
      process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split('\n')
        .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n');
      return 0;
    } else { process.stderr.write(`lane-check: unknown argument "${a}" (try --help)\n`); return 2; }
  }
  const mode = opts.enforce ? 'ENFORCE' : 'WARN';

  let root = process.cwd();
  try { root = git(['rev-parse', '--show-toplevel']).trim(); } catch { /* not a repo: only --files mode works */ }
  const registerPath = opts.register ?? join(root, DEFAULT_REGISTER);
  if (!existsSync(registerPath)) {
    process.stderr.write(`lane-check: no lane register at ${registerPath} — nothing checked.\n`);
    return opts.enforce ? 2 : 0;
  }
  const lanes = parseRegister(readFileSync(registerPath, 'utf8'), registerPath.endsWith('.tsv'));
  if (lanes.length === 0) {
    process.stderr.write(`lane-check: ${registerPath} has no lane rows (expected: lane | branch prefixes | owns).\n`);
    return opts.enforce ? 2 : 0;
  }

  let branch = opts.branch;
  let files = opts.files;
  try {
    // symbolic-ref works on a brand-new repo with no commits; rev-parse covers a detached HEAD.
    if (!branch) {
      try { branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); }
      catch { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); }
    }
    if (!files) {
      const out = opts.range ? git(['diff', '--name-only', opts.range]) : git(['diff', '--cached', '--name-only']);
      files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    }
  } catch (error) {
    process.stderr.write(`lane-check: ${error.message}\n`);
    return opts.enforce ? 2 : 0;
  }

  const lane = laneOfBranch(lanes, branch);
  if (lane === COORDINATOR) {
    process.stdout.write(`lane-check: branch "${branch}" matches no lane prefix — coordinator, may change anything (${files.length} file(s)).\n`);
    return 0;
  }
  const outside = outOfLane(lanes, lane, files);
  if (outside.length === 0) {
    process.stdout.write(`lane-check: OK — ${files.length} file(s) on "${branch}" are all inside lane "${lane}" or shared.\n`);
    return 0;
  }
  process.stdout.write(`lane-check [${mode}]: branch "${branch}" is lane "${lane}", but ${outside.length} file(s) belong to another lane:\n`);
  for (const line of outside) process.stdout.write(`  - ${line}\n`);
  process.stdout.write(opts.enforce
    ? '  Blocked. Move these changes to a branch of the owning lane, or change the register on purpose.\n'
    : '  (warning only — re-run with --enforce to block)\n');
  return opts.enforce ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
