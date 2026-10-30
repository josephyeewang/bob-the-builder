// lane-check.mjs — the first cutover's merge check: is this change wholly the docs-and-research lane's? (LEAD-CALLS L34)
//
// WHY. At the first cutover the robot merges only the docs and research lane. Fifteen audit rounds showed that
// proving an arbitrary change harmless is a hard problem; the first cutover doesn't need it solved, only refused.
// So this is one strict check by path: a change passes only when every file is a plain text doc inside the docs or
// research lane, with nothing protected, nothing removed, no link or run permission in any mode given, and no binary (L28). Anything
// else is refused, and MAIN merges it as today. The deep classifier (classify.mjs) stays for the second cutover.
//
//   docsLaneProblem(policy, change) → null when the change is the docs lane's, else the first reason it isn't
//   change = { files: [{ path, previous_path?, status, mode? }], truncated?, declared_tier?, labels? }
//
// Pure, and it never throws: a bad field is a reason, so a caller can't mistake a throw for a pass.

import { compileList, pathProblem, PROTECTED_FLOOR } from './paths.mjs';
import { needsJoe, MAX_FILES } from './classify.mjs';

// The lane's floor: whatever the rules file says, the docs lane never reaches beyond these. The one definition;
// engine.mjs imports it. Matching ignores case (for the Mac), so the folder names are also checked exactly below.
export const DOCS_FLOOR = compileList(['docs/*.md', 'docs/domains/**', 'docs/research/**']);
// Markdown files other tools read as instructions, wherever they sit (confirm audits of L34, m4 and m-2). No such
// list is complete, so settings formats (JSON, YAML) are left out of the lane altogether (TEXT below).
const NOT_DOCS = compileList(['**/AGENTS.override.md', '**/AGENT.md', '**/GEMINI.md', '**/WARP.md', '**/CRUSH.md', '**/QWEN.md',
  '**/copilot-instructions.md', '**/CONVENTIONS.md', '**/SKILL.md', '**/commands/**', '**/skills/**', '**/agents/**', '**/rules/**',
  '**/pull_request_template.md', '**/PULL_REQUEST_TEMPLATE/**', '**/ISSUE_TEMPLATE/**', '**/SECURITY.md',
  '**/IFLOW.md', '**/CODEBUDDY.md', '**/*.instructions.md', '**/*.prompt.md', '**/*.agent.md', '**/llms.txt', '**/llms-full.txt',
  // GitHub shows these as the repository's own pages (README in docs/ when the root has none): public, so ask-first (m-3).
  'docs/README.md', '**/CONTRIBUTING.md', '**/CODE_OF_CONDUCT.md', '**/SUPPORT.md', '**/GOVERNANCE.md']);
// A path this long or deep is no doc; refusing it keeps the pattern checks quick (m1: 95 s at 2,000 folders).
const MAX_PATH = 512;
const MAX_DEPTH = 16;
// GitHub caps a label at 50 characters; a longer one is refused before it is searched (round 3, MAT-2: 10 MB labels took 11 s).
const MAX_LABEL = 256;
// Plain text only. No images, PDFs or other binaries (L28), nothing that can run (`.mdx`, `.html`, `.svg`), and no
// JSON or YAML: tools read too many such names as settings to list them all (confirm audit round 2, m-2).
const TEXT = /\.(md|txt|csv)$/i;
const STATUSES = ['added', 'modified', 'renamed', 'copied'];   // a removal is never the docs lane's here
const quote = (p) => JSON.stringify(String(p).slice(0, 80));   // a reason never copies a huge path (m-6)
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function docsLaneProblem(policy, change) {
  try {
    return problem(policy, change);
  } catch (e) {
    // The thrown thing may itself be hostile (a revoked proxy, a message that throws), so reading it is guarded too.
    // The message is read once: a getter could answer text to the test and something hostile after (round 3, MAT-1).
    let why = 'unknown error';
    try { const m = e?.message; if (typeof m === 'string') why = m.slice(0, 200); } catch { /* keep the fixed text */ }
    return `could not be read (${why})`;
  }
}

function problem(policy, change) {
  if (!policy || typeof policy !== 'object') return 'no readable rules';
  if (!change || typeof change !== 'object') return 'no change';
  const lanes = policy.lanes && typeof policy.lanes === 'object' ? policy.lanes : {};
  const lanePatterns = [...list(lanes.docs), ...list(lanes.research)];
  if (!lanePatterns.length || !lanePatterns.every((p) => typeof p === 'string')) return 'the rules name no docs or research lane';
  const inLane = compileList(lanePatterns);
  const docsPaths = compileList(Array.isArray(policy.docs_paths) ? policy.docs_paths : ['docs/**']);
  const ep = policy.effect_paths && typeof policy.effect_paths === 'object' ? policy.effect_paths : {};
  const strings = (v) => list(v).filter((p) => typeof p === 'string');
  const barred = compileList([
    ...PROTECTED_FLOOR, ...strings(policy.protected_files),
    ...list(policy.tiers?.paths).filter((t) => String(t?.tier) !== '2').map((t) => t?.pattern).filter((p) => typeof p === 'string'),
    ...strings(ep.secrets_settings?.files), ...strings(ep.schema?.migration_paths), ...strings(ep.production_data?.repair_folder),
    ...strings(ep.messages_people?.sender_paths), ...strings(ep.first_customer_visible?.flag_files),
    ...strings(ep.first_customer_visible?.new_files_under),
  ]);
  const watchedRemovals = compileList(strings(ep.deletes?.removed_file_paths));

  // Each field is read once, so a getter can't answer one way to a check and another way to the next (round 2, m-1).
  const { truncated, declared_tier: tier, labels: given, files } = change;
  if (truncated !== undefined && truncated !== false) return 'the file list may be cut off';
  if (tier !== 2) return 'not declared Tier 2';
  if (given !== undefined && !Array.isArray(given)) return 'labels are not a list';
  // Lists are read by position: a list's own iterator can hide entries (m2).
  const labels = given === undefined ? [] : given;
  const n = labels.length;
  if (!Number.isSafeInteger(n) || n < 0) return 'the label count is not a whole number';
  if (n > 1000) return 'more than 1000 labels';
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (typeof l !== 'string') return 'a label is not text';
    if (l.length > MAX_LABEL) return `a label is over ${MAX_LABEL} characters`;
    if (needsJoe(l) !== null) return `label ${JSON.stringify(l)} asks for Joe`;
  }
  if (!Array.isArray(files)) return 'no files';
  const count = files.length;
  if (!Number.isSafeInteger(count) || count < 0) return 'the file count is not a whole number';   // round 5, MATERIAL-A
  if (!count) return 'no files';
  if (count >= MAX_FILES) return `${MAX_FILES} files or more`;
  for (let i = 0; i < count; i++) {
    const f = files[i];
    if (!f || typeof f !== 'object') return 'a file entry is not an object';
    const { path, previous_path: prev, status, mode } = f;
    if (!STATUSES.includes(status)) return `${quote(path)}: status ${quote(status)} is not the docs lane's`;
    if ((status === 'renamed' || status === 'copied') !== (prev !== undefined)) return `${quote(path)}: an old name goes with a rename or copy only`;
    if (mode !== undefined && mode !== '100644' && mode !== 100644) return `${quote(path)}: mode ${quote(mode)} is a link, submodule or runnable file`;
    for (const p of prev === undefined ? [path] : [path, prev]) {
      if (typeof p !== 'string' || p.length > MAX_PATH || p.split('/').length > MAX_DEPTH) return `${quote(p)}: too long or too deep for a doc`;
      const bad = pathProblem(p);
      if (bad) return `${JSON.stringify(p)}: ${bad}`;
      const seg = p.split('/');
      // Exact case: on GitHub "Docs/" is another folder (m3). No hidden file or folder is a doc.
      if (seg[0] !== 'docs' || (seg.length > 2 && seg[1] !== 'research' && seg[1] !== 'domains')) return `${p} is outside the docs and research lane`;
      if (seg.some((x) => x.startsWith('.'))) return `${p} is a hidden file or folder`;
      if (NOT_DOCS(p)) return `${p} is read by tools as instructions or settings`;
      if (!DOCS_FLOOR(p) || !inLane(p) || !docsPaths(p)) return `${p} is outside the docs and research lane`;
      if (!TEXT.test(p.split('/').pop())) return `${p} is not a plain text doc`;
      if (barred(p)) return `${p} is protected, Tier 1 or an effect path`;
    }
    if (status === 'renamed' && watchedRemovals(prev)) return `${prev} is moved out of a folder where removals are watched`;
  }
  return null;
}
