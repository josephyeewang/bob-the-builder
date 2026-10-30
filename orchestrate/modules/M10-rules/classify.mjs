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
// `.mdx` under docs/ can still run (0b-1 round 2, R2-M4). The path classes below, and the text scans of added and removed lines,
// can only ADD a class, never clear one.
//
//   classifyChange(policy, change)        → { tier: 1|2, risky: [...], reasons: { class: [why…] }, protected: [paths] }
//   classifyWithRulesText(text, change)   → the same, for rules given as raw policy.yaml text (the GitHub-side checker
//                                           reads them at the parent commit); corrupt text = every file unclassifiable
//   change = { files: [{ path, previous_path?, status, mode?, added_lines?, removed_lines? }], truncated?, declared_tier?, labels? }

import { firstRiskyLine } from './db-lines.mjs';
import { RISKY_CLASSES } from '../../shared/rules.mjs';
import { PROTECTED_FLOOR, compileList, pathProblem } from './paths.mjs';
import { parsePolicy } from './policy.mjs';
import { checkRepairFiles } from './repair-plain.mjs';

export const STATUSES = Object.freeze(['added', 'modified', 'removed', 'renamed', 'copied']);
export const EFFECT_KEYS = Object.freeze(['production_data', 'schema', 'secrets_settings', 'deletes',
  'first_customer_visible', 'messages_people']);
export const MAX_FILES = 3000;
export const PLAIN_DOC_EXTENSIONS = Object.freeze(['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'pdf']);
const PLAIN = new RegExp(`\\.(${PLAIN_DOC_EXTENSIONS.join('|')})$`, 'i');
const LINK_MODES = new Set(['120000', '160000']);
const FILE_MODES = new Set(['100644', '100755', '120000', '160000']);   // a symlink or a submodule: protected, whatever its path

// Whole SQL statements only, so prose like "drop the feature" never matches (R2-M4(c)).
// Rounds 7 to 10 widened it for the exact-reverse check: up to five words may stand between the verb and the object
// (`create unlogged table`, `create constraint trigger`), the text is scanned as written and again with SQL comments
// blanked (`CREATE/**/TABLE`, nested `/* /* */ */`, `-- …` to the line end), and the usual code-library calls
// (`createTable`, `schema.dropTableIfExists`, `op.drop_table`, `queryInterface.addColumn`) count, as do the account and
// system statements (`create user`, `drop owned`, `alter system`). A backstop, never complete (README).
// No repeated part can match the same text two ways, so a long run of spaces can't make a scan slow (audit round 10).
const SCHEMA_SCANS = [
  /\b(create|alter|drop)\b(?:\s+\w+){0,5}?\s+(table|index|function|procedure|trigger|policy|view|type|schema|extension|sequence|role|domain|rule|database|user|owned|publication|subscription|aggregate|operator|cast|tablespace|language|server|system|collation|conversion|statistics|transform|group)\b/i,
  /\b(grant|revoke)\s+(?:[^\s;]+\s+){0,20}?(on|to|from)\b/i,
  /\b(create|alter|drop|rename|add|remove|change)(Table|Index|Column|Schema|Constraint)\w*/,
  /\b(create|alter|drop|rename|add|remove|change)_(table|index|column|schema|join_table|reference|foreign_key)\b/i];
// The texts to scan: as written, then with comments blanked (innermost block comments first, so nesting unwinds).
const sqlTexts = (lines) => {
  const raw = lines.join('\n');
  let t = raw;
  // At most 50 passes, so deep nesting can't make it slow; whatever is left is still read by the line check (round 11).
  for (let prev, pass = 0; prev !== t && pass < 50; pass++) { prev = t; t = t.replace(/\/\*(?:(?!\/\*)[\s\S])*?\*\//g, ' '); }
  return [raw, t, t.replace(/--[^\n]*/g, ' ')];
};
const scanHit = (scans, lines) => sqlTexts(lines).some((t) => scans.some((re) => re.test(t)));
// Array.from turns a hole in a sparse list into undefined, so a list with holes is not "lines" (audit round 9).
const isLines = (v) => Array.isArray(v) && Array.from(v).every((l) => typeof l === 'string');
const DELETE_SCANS = [/\bdelete\s+from\b/i, /\btruncate\s+(table\s+)?(only\s+)?[\w"]/i, /\bdrop\s+(table|column|index|schema|database|view)\b/i];

// The GitHub-side checker calls this directly, without the shared fail-closed wrapper, so a throw (a getter on the
// change) is turned into an unclassifiable answer here, naming every file it can (audit round 15).
export function classifyWithRulesText(text, change) {
  try {
    const parsed = parsePolicy(text);
    if (!parsed.ok) {
      const r = classifyChange(null, change);
      r.reasons.unclassifiable = [`rules at this commit are corrupt: ${parsed.reason}`];
      return r;
    }
    return classifyChange(parsed.policy, change);
  } catch (e) {
    let named = [];
    try { named = Array.from(change.files, (f) => f?.path).filter((p) => typeof p === 'string'); } catch { /* no names */ }
    return { tier: 1, risky: ['unclassifiable'], reasons: { unclassifiable: [`rules error: ${e?.message ?? 'unknown'}`] }, protected: [...new Set(named)].sort() };
  }
}

export function classifyChange(policy, change) {
  const reasons = {};
  const protectedPaths = new Set();
  const add = (cls, why) => { (reasons[cls] ??= []).push(why); };

  // With no usable rules, the built-in protected floor still applies: an answer must never come back with
  // `protected: []` because the rules couldn't be read (audit round 4; R3-M3 asks Joe on any protected file).
  const floorOnly = () => {
    for (const f of Array.isArray(change?.files) ? change.files : []) {
      for (const p of [f?.path, f?.previous_path]) if (typeof p === 'string' && !pathProblem(p) && FLOOR(p)) { protectedPaths.add(p); add('protected', p); }
    }
    return finish(reasons, protectedPaths, 1);
  };
  if (!policy || typeof policy !== 'object') {
    add('unclassifiable', 'no readable rules at this commit');
    return floorOnly();
  }
  const files = readFilesOnce(change?.files);
  if (!Array.isArray(files)) {
    add('unclassifiable', 'no file list');
    return finish(reasons, protectedPaths, 1);
  }
  // A change with more line text than this is not read line by line: it is unclassifiable (audit round 13). Each
  // line counts its length plus one, so a flood of blank lines counts too (audit round 15).
  let text = 0;
  for (const f of files) for (const side of ['added_lines', 'removed_lines']) if (isLines(f?.[side])) for (const l of f[side]) text += l.length + 1;
  const tooBig = text > MAX_CHANGE_TEXT;
  if (tooBig) add('unclassifiable', 'too much changed text to read');
  if (change.truncated !== undefined && change.truncated !== false) add('unclassifiable', change.truncated === true ? 'file list truncated' : 'truncated is not true or false');
  if (change.labels !== undefined && (!Array.isArray(change.labels) || !change.labels.every((l) => typeof l === 'string'))) add('unclassifiable', 'labels are not a list of names');
  // GitHub's pull request file list stops at exactly MAX_FILES, so a list that long may be cut off (audit round 5).
  if (files.length >= MAX_FILES) add('unclassifiable', `${MAX_FILES} files or more`);
  if (!files.length) add('unclassifiable', 'no files');

  let m;
  try { m = matchers(policy); } catch (e) { add('unclassifiable', `rules patterns unreadable: ${e.message}`); return floorOnly(); }
  for (const k of m.missingEffectKeys) add('unclassifiable', `effect_paths.${k} missing`);

  let tier = change.declared_tier === 2 ? 2 : 1;     // a missing or unknown declared tier counts as 1
  for (const f of files) {
    if (!f || typeof f !== 'object' || !STATUSES.includes(f.status)) { add('unclassifiable', `bad file entry ${JSON.stringify(f?.path ?? f)}`); continue; }
    // A rename or copy must name its old path: renaming a protected file away is itself protected (MAT-7).
    if ((f.status === 'renamed' || f.status === 'copied') && typeof f.previous_path !== 'string') { add('unclassifiable', `${f.status} with no old name: ${JSON.stringify(f.path)}`); continue; }
    const touched = [f.path, ...(f.previous_path !== undefined ? [f.previous_path] : [])];
    const bad = touched.map(pathProblem).find(Boolean);
    if (bad) { add('unclassifiable', `${bad}: ${JSON.stringify(f.path)}`); continue; }

    for (const p of touched) {
      if (m.protected(p)) { protectedPaths.add(p); add('protected', p); }
      if (m.tier1(p)) tier = 1;
      if (!m.plainDoc(p)) add('unclassifiable', `scan_not_built: ${p}`);
      if (m.secrets(p)) add('secrets_settings', p);
      if (m.migrations(p)) add('schema', p);
      if (m.repair(p)) add('production_data', p);
      if (m.senders(p)) add('messages_people', p);
      if (m.flags(p)) add('first_customer_visible', p);
    }
    // git's six-digit spelling, as text or the same digits as a number; anything else (0o120000, '0120000') is unknown.
    const mode = typeof f.mode === 'number' && Number.isSafeInteger(f.mode) ? String(f.mode) : f.mode;
    if (mode !== undefined && !(typeof mode === 'string' && FILE_MODES.has(mode))) { add('unclassifiable', `unknown mode ${JSON.stringify(f.mode)}: ${JSON.stringify(f.path)}`); continue; }
    if (mode !== undefined && LINK_MODES.has(mode)) { protectedPaths.add(f.path); add('protected', `${f.path} (link or submodule)`); }
    if (f.status === 'added' && m.newVisible(f.path)) add('first_customer_visible', f.path);
    // A repair file must be plain SQL that was added, or it can't be approved as written (0b-9 M8): the same
    // allow-list the repair job runs after the merge. For an added file, the added lines are the whole file.
    if (touched.some((p) => m.repair(p))) {
      const text = Array.isArray(f.added_lines) ? f.added_lines.join('\n') : undefined;
      for (const r of checkRepairFiles([{ ...f, text }], policy).refused) add('unclassifiable', `repair file not plain: ${r.path}: ${r.reason}`);
    }
    const gone = f.status === 'removed' ? f.path : f.status === 'renamed' ? f.previous_path : null;
    if (gone && m.removed(gone)) add('deletes', gone);

    // Text scans of added lines: only ever add a class. Plain docs are prose, so they are never scanned; files in the
    // migration, repair and sender folders always are, wherever those folders are.
    // A rename is scanned when either name would be: a rename from code back to a doc still undoes code (audit round 8).
    const scanned = (p) => !m.plainDoc(p) || m.migrations(p) || m.repair(p) || m.senders(p);
    const scan = !tooBig && (scanned(f.path) || (typeof f.previous_path === 'string' && scanned(f.previous_path)));
    for (const field of ['added_lines', 'removed_lines']) if (f[field] !== undefined && !isLines(f[field])) add('unclassifiable', `${field} is not a list of lines: ${f.path}`);
    if (scan && isLines(f.added_lines)) {
      if (scanHit(SCHEMA_SCANS, f.added_lines)) add('schema', `${f.path} (table change in added lines)`);
      if (scanHit(DELETE_SCANS, f.added_lines)) add('deletes', `${f.path} (delete statement in added lines)`);
      const texts = sqlTexts(f.added_lines);
      const pkg = m.packages.find((name) => texts.some((t) => importsPackage(t, name)));
      if (pkg) add('messages_people', `${f.path} (imports ${pkg})`);
    }
    // Removed lines too: a change that removes a table statement undoes a database change (0b-9 M4, audit round 7).
    if (scan && isLines(f.removed_lines) && scanHit(SCHEMA_SCANS, f.removed_lines)) add('schema', `${f.path} (table change in removed lines)`);
    // Deny by default (lead call L32): any line on either side that can't be proven harmless is a possible database
    // change. The patterns above stay as the clearer reasons; this is the floor under them (db-lines.mjs). Only a
    // blank line is harmless (audit round 13).
    if (scan) {
      for (const side of ['added_lines', 'removed_lines']) {
        const hit = isLines(f[side]) ? firstRiskyLine(f[side]) : null;
        if (hit) add('schema', `${f.path} (${side.replace('_', ' ')}: line ${hit.n} may change the database: ${hit.why})`);
      }
    }
  }

  // A `needs-joe` label adds `unclassifiable`; `needs-joe:<class>` adds that class. Neither removes one (MIN-3). Case
  // and anything that isn't a letter (digits, spaces, dots) before or between the words don't matter (`[needs.joe]`,
  // `needs1joe`); any other needs-joe label, and any label not in plain ASCII, is unclassifiable (rounds 10 to 15).
  for (const label of Array.isArray(change.labels) ? change.labels : []) {
    const l = needsJoe(label);
    if (l === null) continue;
    const cls = l.startsWith(':') ? l.slice(1).trim() : null;
    add(cls && RISKY_CLASSES.includes(cls) ? cls : 'unclassifiable', `${label} label`);
  }
  return finish(reasons, protectedPaths, tier);
}

const MAX_CHANGE_TEXT = 5_000_000;
const MAX_LINES = 1_000_000;   // more lines than this in one change are not read: they are not lists of lines (rounds 14, 15)

// Each file and its line lists, read once. A getter or proxy can't show one list to one check and another to the
// next: every check judges this copy (audit round 14). Once the change's lists hold more than MAX_LINES lines in all,
// each further list becomes a note, which no check takes for lines, so a flood of lists is never copied (audit round
// 15). Each list's length is read once. Throws on a hostile object; the shared interface turns a throw into a deny.
// Each field is read by name, so one inherited from a class or hidden from a spread is still seen (confirm audit of
// L34, M1); the list is read by position, never through its own iterator, which can hide entries (m2).
const FILE_FIELDS = ['path', 'previous_path', 'status', 'mode', 'added_lines', 'removed_lines'];

export function readFilesOnce(files) {
  if (!Array.isArray(files)) return files;
  let left = MAX_LINES;
  const lines = (v) => {
    if (!Array.isArray(v)) return v;
    const n = v.length;
    if (!(n <= left)) { left = -1; return `more than ${MAX_LINES} lines in the change`; }
    left -= n;
    const copy = new Array(n);
    for (let i = 0; i < n; i++) copy[i] = v[i];   // a hole reads as undefined, which no check takes for a line
    return copy;
  };
  // A list past the cap is copied only to the cap: every check refuses MAX_FILES entries or more.
  const n = Math.min(files.length, MAX_FILES);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = files[i];
    if (!f || typeof f !== 'object') { out[i] = f; continue; }
    const copy = {};
    for (const k of FILE_FIELDS) { const v = f[k]; if (v !== undefined) copy[k] = k.endsWith('_lines') ? lines(v) : v; }
    out[i] = copy;
  }
  return out;
}

// The merge subject's fields, each read once by name into a plain object; labels copied by position (L34 audit M1, m2).
const SUBJECT_FIELDS = ['product', 'card', 'truncated', 'labels', 'declared_tier', 'kind', 'reverses', 'exact_reverse_ok', 'reversed_audit', 'reverses_files'];
export function readSubjectOnce(subject) {
  const s = {};
  for (const k of SUBJECT_FIELDS) { const v = subject[k]; if (v !== undefined) s[k] = v; }
  if (Array.isArray(s.labels)) {
    const n = s.labels.length;
    if (n > 1000) s.labels = 'more than 1000 labels';
    else { const copy = new Array(n); for (let i = 0; i < n; i++) copy[i] = s.labels[i]; s.labels = copy; }
  }
  s.files = readFilesOnce(subject.files);
  return s;
}

// A label's text after "needs joe" (in any spelling), or null when it isn't a needs-joe label. A label with any
// character outside printable ASCII counts as a plain needs-joe label: no list of look-alike letters from other
// scripts is ever complete (audit rounds 13 to 15), and a false alarm costs Joe one tap (lead call L32).
export function needsJoe(label) {
  if (typeof label !== 'string') return null;
  if (/[^\x20-\x7e]/.test(label)) return '';
  const l = label.toLowerCase().replace(/[^a-z_:]/g, '');
  const m = /^[_:]*needs[_:]*joe/.exec(l);
  return m ? l.slice(m[0].length) : null;
}

function finish(reasons, protectedPaths, tier) {
  const risky = RISKY_CLASSES.filter((c) => reasons[c]);
  return { tier: risky.length || protectedPaths.size ? 1 : tier, risky, reasons, protected: [...protectedPaths].sort() };
}

function importsPackage(text, name) {
  const q = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)['"]${q}(/[^'"]*)?['"]`).test(text);
}

const FLOOR = compileList([...PROTECTED_FLOOR]);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function matchers(policy) {
  const ep = policy.effect_paths && typeof policy.effect_paths === 'object' ? policy.effect_paths : {};
  const tierPaths = Array.isArray(policy.tiers?.paths) ? policy.tiers.paths : [];
  // Ordinary docs: a plain file inside the product's docs_paths (0b-1 R3-m5; parsePolicy fills the docs/** default).
  const docs = compileList(Array.isArray(policy.docs_paths) ? policy.docs_paths : ['docs/**']);
  return {
    plainDoc: (p) => Boolean(docs(p)) && PLAIN.test(p.split('/').pop()),
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
