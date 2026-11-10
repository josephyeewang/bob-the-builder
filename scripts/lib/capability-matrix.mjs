// capability-matrix.mjs — find a project's Capability Traceability Matrix (Bob Step 5a-ii, D-036).
//
// One home for "does this project keep a matrix, and does it have the Works column yet", read by
// phase-report-check.mjs (the matrix makes the Capability Scoreboard and Wiring and Simplicity sections required) and
// bob-upgrade.mjs (an older matrix without Works is a hand step). Bob gives the matrix no fixed path, so this looks
// for a Markdown heading that names it: "# Capability Traceability Matrix" as its own file, or a section of a larger
// document such as the build manifest.

import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'fixtures']);
const HEADING = /^#{1,4}\s+(?:\d+(?:\.\d+)*[.)]?\s+)?Capability Traceability Matrix\b/im;
// A table header row with a Works column: "| Capability | Phase 1 | … | Works | Evidence |".
const WORKS = /^\s*\|(?:[^|\n]*\|)*\s*\**Works\**\s*\|/im;

// The project's own files with one of these endings, sorted so every answer is stable. Folders whose name starts with
// "." are skipped (.git, .claude worktrees, .bob backups), and so are installed and generated ones.
export function projectFiles(root, exts, { maxDepth = 4 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1); }
      else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) found.push(p);
    }
  };
  walk(root, 0);
  return found.sort();
}

// → { file, hasWorks } for the first matrix found (a path relative to root), or null. Bob's own folder is not a
// project: its templates/ holds the blank matrix.
export function findMatrix(root, { bobRoot = null, maxDepth = 4 } = {}) {
  if (bobRoot && path.resolve(root) === path.resolve(bobRoot)) return null;
  for (const p of projectFiles(root, ['.md'], { maxDepth })) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (HEADING.test(text)) return { file: path.relative(root, p), hasWorks: WORKS.test(text) };
  }
  return null;
}
