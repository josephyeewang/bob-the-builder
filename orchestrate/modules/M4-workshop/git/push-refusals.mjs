// The push refusals (design v4 §8.3 D3; review 0b-4 M1, M2, m3, m4). The one definition of the
// file names a card branch may never touch. M10's protected list imports these names rather than
// copying them; the push refusals themselves stay this fixed list and never read the rules.
//
// A path is refused when, after folding (Unicode NFKC so look-alike letters such as the long s
// become plain ones, upper then lower case, invisible "default ignorable" characters removed;
// a Mac's disk reads `.Claude` as `.claude`, review 0b-4 R-47 MAT-3):
//   - any segment is `.claude` (a file, a folder or a link);
//   - a `.github` segment is followed by `workflows` or `actions`, at any depth;
//   - the last segment is `.mcp.json`, `claude.local.md`, `.gitmodules` or a Vercel config name;
// and an entry is refused when its new mode is a link (120000) or a submodule (160000).
// Every status counts (add, change, delete, type change): deleting a workflow file touches it.

export const CLAUDE_DIR = '.claude';
export const FILE_NAMES = Object.freeze(['.mcp.json', 'claude.local.md']);
export const VERCEL_NAMES = Object.freeze(['vercel.json', 'vercel.ts', 'vercel.js', 'vercel.mjs', 'vercel.cjs', 'vercel.mts']);
export const GITHUB_DIRS = Object.freeze(['workflows', 'actions']);
// Not in D3: a worker never needs a submodule (review 0b-4 m3, a deliberate addition).
export const SUBMODULE_FILE = '.gitmodules';
export const LINK_MODE = '120000';
export const SUBMODULE_MODE = '160000';

// The names Claude reads settings, skills or tool servers from (launch check 2 uses these too).
export const CLAUDE_NAMES = Object.freeze([CLAUDE_DIR, ...FILE_NAMES]);

// One fold for names, shared with the hooks (audit R-0b-44 round 3 MAT-1).
export { fold } from '../hooks/lib.mjs';
import { fold } from '../hooks/lib.mjs';

/** Why a path is refused, or null. `path` is a git path ('/'-separated). */
export function refusedPath(path) {
  const parts = String(path).split('/').map(fold);
  if (parts.some((p) => p === CLAUDE_DIR)) return `touches a ${CLAUDE_DIR} folder or file`;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === '.github' && GITHUB_DIRS.includes(parts[i + 1])) return `touches .github/${parts[i + 1]}`;
  }
  const last = parts.at(-1);
  if (FILE_NAMES.includes(last)) return `touches ${last}`;
  if (VERCEL_NAMES.includes(last)) return `touches a Vercel config (${last})`;
  if (last === SUBMODULE_FILE) return 'touches .gitmodules';
  return null;
}

/**
 * Parses `git diff-tree -r -z --raw --no-renames` output (with --no-commit-id): entries of
 * `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`.
 */
export function parseRawZ(buf) {
  const fields = buf.toString('utf8').split('\0');
  const out = [];
  for (let i = 0; i < fields.length - 1; i += 2) {
    const head = fields[i];
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(head);
    if (!m) throw new Error(`unreadable change line "${head.slice(0, 80)}"`);
    out.push({ oldMode: m[1], newMode: m[2], newId: m[4], status: m[5], path: fields[i + 1] });
  }
  return out;
}

/** Every refusal among parsed entries, as plain reasons. */
export function refusedEntries(entries) {
  const why = [];
  for (const e of entries) {
    const p = refusedPath(e.path);
    if (p) why.push(`${e.path}: ${p}`);
    if (e.newMode === LINK_MODE) why.push(`${e.path}: adds or changes a link`);
    if (e.newMode === SUBMODULE_MODE || e.oldMode === SUBMODULE_MODE) why.push(`${e.path}: a submodule`);
  }
  return why;
}
