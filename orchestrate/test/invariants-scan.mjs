// invariants-scan.mjs — the CI checks for build-rule invariants I3, I4 and I7 (BUILD-RULES.md §4, lead call L1078).
// invariants.test.mjs runs them against invariants-allowed.json; `node orchestrate/test/invariants-scan.mjs` prints
// what the scan finds now, as list entries, for a reviewer to compare with the list.
//
// Each check is an allowed list, not a list of bad inputs (BUILD-RULES §3): every site the scan finds must be on the
// list with a reason, and every listed site must still be found. The sites found on the day the checks started are
// listed with a BASELINE reason; invariants.test.mjs caps how many BASELINE entries each check may have, so that part
// of the list can only shrink. A new site needs its own reason, which the reviewer reads in the diff.
//
//   I3 Every hold re-tells Joe through stillWaiting. Flagged: a once-mark, a stored flag that says "told" set to true
//      (`told: true`, `start_failed_told: true`, `x.alerted = true`). A once-mark can't say "still"
//      (shared/still-waiting.mjs WHY): the thing is told once and then never again while it lasts.
//   I4 Stored times are read only through pastTime. Flagged: `Date.parse`, and `new Date(x).getTime()` / `.valueOf()`
//      with an argument (the same read by another name). pastTime itself is the one listed home.
//   I7 One definition per concept. Flagged: the same top-level constant (`const NAME = value`, the same name and the
//      same value) in two files, and the same text (a string or template piece of at least TEXT_MIN characters and
//      TEXT_WORDS spaces) in two files.
//
// What it cannot see (a scan, not a parser): a once-mark kept under another word (`done: true`), a local variable
// (`let told = true`, which is not stored, so not flagged), a time read through a helper other than these, a copy
// under another name or with a different spelling of the same value, and a text built in pieces. Production code only:
// tests, test helpers and fixtures are left out (alert-inventory.mjs isTestPath), as is a generated bundle
// (GENERATED, below), whose sources are scanned instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mask } from './alert-answer-scan.mjs';
import { orchestrateFiles } from './alert-inventory.mjs';

// The one generated file: build-checker.mjs bundles M6's checker from its sources, which are scanned themselves.
export const GENERATED = Object.freeze(['modules/M6-merge-gate/github-checker.mjs']);
export const TEXT_MIN = 30;
export const TEXT_WORDS = 4;
export const BASELINE = 'baseline (L1078)';
export const LIST = 'test/invariants-allowed.json';

const squash = (t) => t.replace(/\s+/g, ' ').trim();
const lineAt = (src, at) => { const s = src.lastIndexOf('\n', at - 1) + 1; const e = src.indexOf('\n', at); return squash(src.slice(s, e < 0 ? src.length : e)); };

/** The production files under `root` (orchestrate/): [{ rel, src }]. */
export function productionFiles(root) {
  return orchestrateFiles(root).filter((f) => !f.testCode && !GENERATED.includes(f.rel)).map(({ rel, src }) => ({ rel, src }));
}

// A stored flag named told (or alerted / notified / warned, alone or after a prefix_) set to true: an object
// property, or a member assignment. Strings and comments are blanked first.
const ONCE_MARK = /(?<![\w$])(?:[A-Za-z$][\w$]*_)?(?:told|alerted|notified|warned)\s*:\s*true\b|\.\s*(?:[A-Za-z$][\w$]*_)?(?:told|alerted|notified|warned)\s*=(?!=)\s*true\b/g;
const TIME_READ = /(?<![\w$.])Date\s*\.\s*parse\b|\bnew\s+Date\s*\(\s*[^()\s][^()]*\)\s*\.\s*(?:getTime|valueOf)\b/g;

const sitesOf = (files, re) => files.flatMap(({ rel, src }) => [...mask(src).matchAll(re)].map((x) => ({ file: rel, line: lineAt(src, x.index) })));
/** I3: [{ file, line }], one per once-mark. */
export const scanI3 = (files) => sitesOf(files, ONCE_MARK);
/** I4: [{ file, line }], one per time read outside pastTime. */
export const scanI4 = (files) => sitesOf(files, TIME_READ);

/** The text pieces of a source's string and template literals (comments left out; a template split at each ${ }). */
export function textsIn(src) {
  const code = mask(src);
  const kept = mask(src, { commentsOnly: true });
  const out = [];
  for (const r of code.matchAll(/\s+/g)) {
    if (!['\'', '"', '`', '}'].includes(code[r.index - 1])) continue;
    const t = kept.slice(r.index, r.index + r[0].length);
    if (/\S/.test(t)) out.push(t);
  }
  return out;
}
const isProse = (t) => t.length >= TEXT_MIN && (t.match(/ /g) ?? []).length >= TEXT_WORDS && /[a-z]/i.test(t) && !/\.mjs$/.test(t.trim());

/** I7: [{ kind: 'definition' | 'text', copy, files }], one per thing found in two or more files; files sorted. */
export function scanI7(files) {
  const seen = new Map();
  const add = (kind, copy, rel) => { const k = `${kind}\n${copy}`; if (!seen.has(k)) seen.set(k, { kind, copy, files: new Set() }); seen.get(k).files.add(rel); };
  for (const { rel, src } of files) {
    const code = mask(src, { commentsOnly: true });
    // A value read from import.meta names the file it is in, so the same text there is not one value.
    for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm)) if (!/\bimport\.meta\b/.test(m[2])) add('definition', `${m[1]} = ${squash(m[2])}`, rel);
    for (const t of textsIn(src)) if (isProse(t)) add('text', t, rel);
  }
  return [...seen.values()].filter((x) => x.files.size > 1).map((x) => ({ kind: x.kind, copy: x.copy, files: [...x.files].sort() }))
    .sort((a, b) => (a.kind + a.copy < b.kind + b.copy ? -1 : 1));
}

export const keyI = (e) => `${e.file} | ${e.line}`;
export const keyI7 = (e) => `${e.kind} | ${e.copy} | ${e.files.join(', ')}`;
/** Found against listed, as multisets by `key`: { fresh: found and not listed, gone: listed and not found }. */
export function compare(found, listed, key) {
  const left = new Map();
  for (const e of listed) left.set(key(e), (left.get(key(e)) ?? 0) + 1);
  const fresh = [];
  for (const e of found) { const n = left.get(key(e)) ?? 0; if (n > 0) left.set(key(e), n - 1); else fresh.push(e); }
  const gone = [];
  for (const e of listed) { const n = left.get(key(e)) ?? 0; if (n > 0) { gone.push(e); left.set(key(e), n - 1); } }
  return { fresh, gone };
}

export const readList = (root) => JSON.parse(readFileSync(join(root, LIST), 'utf8'));
/** Everything the scan finds under `root`, as list entries; a reason kept from `old` where the entry is the same. */
export function scanAll(root, old = { I3: [], I4: [], I7: [] }) {
  const files = productionFiles(root);
  const why = (key, list) => { const m = new Map(list.map((e) => [key(e), e.why])); return (e) => ({ ...e, why: m.get(key(e)) ?? 'NEW: give the reason this one is allowed' }); };
  return { I3: scanI3(files).map(why(keyI, old.I3)), I4: scanI4(files).map(why(keyI, old.I4)), I7: scanI7(files).map(why(keyI7, old.I7)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let old;
  try { old = readList(root); } catch { old = undefined; }
  process.stdout.write(`${JSON.stringify(scanAll(root, old), null, 1)}\n`);
}
