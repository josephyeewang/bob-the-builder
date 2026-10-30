// lane-check.mjs — the first cutover's merge check: is this change wholly the docs-and-research lane's? (LEAD-CALLS L34)
//
// WHY. At the first cutover the robot merges only the docs and research lane. Fifteen audit rounds showed that
// proving an arbitrary change harmless is a hard problem; the first cutover doesn't need it solved, only refused.
// So this is one strict check by path: a change passes only when every file is a plain text doc inside the docs or
// research lane, with nothing protected, nothing removed, no link, no run permission and no binary (L28). Anything
// else is refused, and MAIN merges it as today. The deep classifier (classify.mjs) stays for the second cutover.
//
//   docsLaneProblem(policy, change) → null when the change is the docs lane's, else the first reason it isn't
//   change = { files: [{ path, previous_path?, status, mode? }], truncated?, declared_tier?, labels? }
//
// Pure, and it never throws: a bad field is a reason, so a caller can't mistake a throw for a pass.

import { compileList, pathProblem, PROTECTED_FLOOR } from './paths.mjs';
import { needsJoe, MAX_FILES } from './classify.mjs';

// The lane's floor: whatever the rules file says, the docs lane never reaches beyond these (engine.mjs uses the same).
const DOCS_FLOOR = compileList(['docs/*.md', 'docs/domains/**', 'docs/research/**']);
// Plain text only. No images, PDFs or other binaries (L28), and nothing that can run (`.mdx`, `.html`, `.svg`).
const TEXT = /\.(md|txt|csv|json|yaml|yml)$/i;
const STATUSES = ['added', 'modified', 'renamed', 'copied'];   // a removal is never the docs lane's here
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function docsLaneProblem(policy, change) {
  try {
    return problem(policy, change);
  } catch (e) {
    return `could not be read (${e?.message ?? 'unknown error'})`;
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

  if (change.truncated !== undefined && change.truncated !== false) return 'the file list may be cut off';
  if (change.declared_tier !== 2) return 'not declared Tier 2';
  if (change.labels !== undefined && !Array.isArray(change.labels)) return 'labels are not a list';
  for (const l of list(change.labels)) {
    if (typeof l !== 'string') return 'a label is not text';
    if (needsJoe(l) !== null) return `label ${JSON.stringify(l)} asks for Joe`;
  }
  const files = change.files;
  if (!Array.isArray(files) || !files.length) return 'no files';
  if (files.length >= MAX_FILES) return `${MAX_FILES} files or more`;
  for (const f of Array.from(files)) {
    if (!f || typeof f !== 'object') return 'a file entry is not an object';
    const { path, previous_path: prev, status, mode } = f;
    if (!STATUSES.includes(status)) return `${JSON.stringify(path)}: status ${JSON.stringify(status)} is not the docs lane's`;
    if ((status === 'renamed' || status === 'copied') !== (prev !== undefined)) return `${JSON.stringify(path)}: an old name goes with a rename or copy only`;
    if (mode !== undefined && mode !== '100644' && mode !== 100644) return `${JSON.stringify(path)}: mode ${JSON.stringify(mode)} is a link, submodule or runnable file`;
    for (const p of prev === undefined ? [path] : [path, prev]) {
      const bad = pathProblem(p);
      if (bad) return `${JSON.stringify(p)}: ${bad}`;
      if (!DOCS_FLOOR(p) || !inLane(p) || !docsPaths(p)) return `${p} is outside the docs and research lane`;
      if (!TEXT.test(p.split('/').pop())) return `${p} is not a plain text doc`;
      if (barred(p)) return `${p} is protected, Tier 1 or an effect path`;
    }
    if (status === 'renamed' && watchedRemovals(prev)) return `${prev} is moved out of a folder where removals are watched`;
  }
  return null;
}
