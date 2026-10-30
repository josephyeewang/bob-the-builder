// classify.mjs — work out a change's tier and its risky classes from the files it actually touches (D6, D7).
//
// WHY. A card's own label can lie or forget; the files can't. So the tier and the Approve-every-time classes are
// computed here from the change itself, and a card's declared tier or `needs-joe` label can only make it stricter.
// This module is pure (no file system, no network) so M10 on the Mini and M6's GitHub-side checker import the same
// code and give the same answer (spec review 0b-9, M2).
//
// FIRST CUTOVER, BY PATH ONLY. The scanner that follows imports and reads code (R-0b-100) is a second-cutover row.
// Until it lands, a file is ordinary only if it sits under `docs/` AND is a plain file (an allow-listed extension):
// anything else is `unclassifiable` (so it needs Joe's Approve), because we can't yet prove what it does. A `.mjs` or
// `.mdx` under docs/ can still run (0b-1 round 2, R2-M4). The path classes below, and the text scans of added lines,
// can only ADD a class, never clear one.
//
//   classifyChange(policy, change)        → { tier: 1|2, risky: [...], reasons: { class: [why…] }, protected: [paths] }
//   classifyWithRulesText(text, change)   → the same, for rules given as raw policy.yaml text (the GitHub-side checker
//                                           reads them at the parent commit); corrupt text = every file unclassifiable
//   change = { files: [{ path, previous_path?, status, mode?, added_lines? }], truncated?, declared_tier?, labels? }

import { RISKY_CLASSES } from '../../shared/rules.mjs';
import { PROTECTED_FLOOR, compileList, pathProblem } from './paths.mjs';
import { parsePolicy } from './policy.mjs';

export const STATUSES = Object.freeze(['added', 'modified', 'removed', 'renamed', 'copied']);
export const EFFECT_KEYS = Object.freeze(['production_data', 'schema', 'secrets_settings', 'deletes',
  'first_customer_visible', 'messages_people']);
export const MAX_FILES = 3000;
export const PLAIN_DOC_EXTENSIONS = Object.freeze(['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'pdf']);
const DOCS = compileList(['docs/**']);
const PLAIN = new RegExp(`\\.(${PLAIN_DOC_EXTENSIONS.join('|')})$`, 'i');
const plainDoc = (p) => Boolean(DOCS(p)) && PLAIN.test(p.split('/').pop());
const LINK_MODES = new Set(['120000', '160000']);   // a symlink or a submodule: protected, whatever its path

// Whole SQL statements only, so prose like "drop the feature" never matches (R2-M4(c)).
const SCHEMA_SCANS = [/\b(create|alter|drop)\s+(table|index)\b/i, /\balter\s+table\s+\S+\s+(add|drop|alter)\s+column\b/i];
const DELETE_SCANS = [/\bdelete\s+from\b/i, /\btruncate\s+(table\s+)?\w/i, /\bdrop\s+(table|column|index|schema|database|view)\b/i];

export function classifyWithRulesText(text, change) {
  const parsed = parsePolicy(text);
  if (!parsed.ok) {
    const r = classifyChange(null, change);
    r.reasons.unclassifiable = [`rules at this commit are corrupt: ${parsed.reason}`];
    return r;
  }
  return classifyChange(parsed.policy, change);
}

export function classifyChange(policy, change) {
  const reasons = {};
  const protectedPaths = new Set();
  const add = (cls, why) => { (reasons[cls] ??= []).push(why); };

  if (!policy || typeof policy !== 'object') {
    add('unclassifiable', 'no readable rules at this commit');
    return finish(reasons, protectedPaths, 1);
  }
  const files = change?.files;
  if (!Array.isArray(files)) {
    add('unclassifiable', 'no file list');
    return finish(reasons, protectedPaths, 1);
  }
  if (change.truncated === true) add('unclassifiable', 'file list truncated');
  if (files.length > MAX_FILES) add('unclassifiable', `more than ${MAX_FILES} files`);

  let m;
  try { m = matchers(policy); } catch (e) { add('unclassifiable', `rules patterns unreadable: ${e.message}`); return finish(reasons, protectedPaths, 1); }
  for (const k of m.missingEffectKeys) add('unclassifiable', `effect_paths.${k} missing`);

  let tier = change.declared_tier === 2 ? 2 : 1;     // a missing or unknown declared tier counts as 1
  for (const f of files) {
    if (!f || typeof f !== 'object' || !STATUSES.includes(f.status)) { add('unclassifiable', `bad file entry ${JSON.stringify(f?.path ?? f)}`); continue; }
    const touched = [f.path, ...(f.previous_path !== undefined ? [f.previous_path] : [])];
    const bad = touched.map(pathProblem).find(Boolean);
    if (bad) { add('unclassifiable', `${bad}: ${JSON.stringify(f.path)}`); continue; }

    for (const p of touched) {
      if (m.protected(p)) { protectedPaths.add(p); add('protected', p); }
      if (m.tier1(p)) tier = 1;
      if (!plainDoc(p)) add('unclassifiable', `scan_not_built: ${p}`);
      if (m.secrets(p)) add('secrets_settings', p);
      if (m.migrations(p)) add('schema', p);
      if (m.repair(p)) add('production_data', p);
      if (m.senders(p)) add('messages_people', p);
      if (m.flags(p)) add('first_customer_visible', p);
    }
    if (f.mode !== undefined && LINK_MODES.has(String(f.mode))) { protectedPaths.add(f.path); add('protected', `${f.path} (link or submodule)`); }
    if (f.status === 'added' && m.newVisible(f.path)) add('first_customer_visible', f.path);
    const gone = f.status === 'removed' ? f.path : f.status === 'renamed' ? f.previous_path : null;
    if (gone && m.removed(gone)) add('deletes', gone);

    // Text scans of added lines: only ever add a class. Plain docs are prose, so they are never scanned; files in the
    // migration, repair and sender folders always are, wherever those folders are.
    const scan = !plainDoc(f.path) || m.migrations(f.path) || m.repair(f.path) || m.senders(f.path);
    if (scan && Array.isArray(f.added_lines)) {
      const text = f.added_lines.join('\n');
      if (SCHEMA_SCANS.some((re) => re.test(text))) add('schema', `${f.path} (table change in added lines)`);
      if (DELETE_SCANS.some((re) => re.test(text))) add('deletes', `${f.path} (delete statement in added lines)`);
      const pkg = m.packages.find((name) => importsPackage(text, name));
      if (pkg) add('messages_people', `${f.path} (imports ${pkg})`);
    }
  }

  // A `needs-joe` label adds `unclassifiable`; `needs-joe:<class>` adds that class. Neither removes one (MIN-3).
  for (const label of Array.isArray(change.labels) ? change.labels : []) {
    if (label === 'needs-joe') add('unclassifiable', 'needs-joe label');
    else if (typeof label === 'string' && label.startsWith('needs-joe:')) {
      const cls = label.slice('needs-joe:'.length);
      add(RISKY_CLASSES.includes(cls) ? cls : 'unclassifiable', `${label} label`);
    }
  }
  return finish(reasons, protectedPaths, tier);
}

function finish(reasons, protectedPaths, tier) {
  const risky = RISKY_CLASSES.filter((c) => reasons[c]);
  return { tier: risky.length || protectedPaths.size ? 1 : tier, risky, reasons, protected: [...protectedPaths].sort() };
}

function importsPackage(text, name) {
  const q = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)['"]${q}(/[^'"]*)?['"]`).test(text);
}

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function matchers(policy) {
  const ep = policy.effect_paths && typeof policy.effect_paths === 'object' ? policy.effect_paths : {};
  const tierPaths = Array.isArray(policy.tiers?.paths) ? policy.tiers.paths : [];
  return {
    missingEffectKeys: EFFECT_KEYS.filter((k) => !ep[k] || typeof ep[k] !== 'object'),
    protected: compileList([...PROTECTED_FLOOR, ...list(policy.protected_files)]),
    tier1: compileList(tierPaths.filter((t) => String(t?.tier) === '1').map((t) => t.pattern)),
    secrets: compileList(list(ep.secrets_settings?.files)),
    migrations: compileList(list(ep.schema?.migration_paths)),
    repair: compileList(list(ep.production_data?.repair_folder)),
    senders: compileList(list(ep.messages_people?.sender_paths)),
    flags: compileList(list(ep.first_customer_visible?.flag_files)),
    newVisible: compileList(list(ep.first_customer_visible?.new_files_under)),
    removed: compileList(list(ep.deletes?.removed_file_paths)),
    packages: list(ep.messages_people?.package_imports).map(String),
  };
}
