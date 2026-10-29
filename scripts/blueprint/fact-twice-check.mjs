#!/usr/bin/env node
// fact-twice-check.mjs — "Owned fact written once": fail when hand-written text re-types a fact the Blueprint's
// fact files own (Blueprint & Roadmap, §3.5 test "Owned fact written once"; widens "each date written once").
//
// WHY. A fact typed in two places drifts: the data file gets re-dated, the copy in a chapter doesn't, and the
// reader can't tell which one is true. In the project this was learned on, the plan ended up written in six
// places. The cure is one home per fact (the fact files under docs/blueprint/) and a check that fails a change
// which types one of those facts again by hand. It is a plain text search, so it works before any page builder
// exists. That is why it is built first.
//
// WHAT IT OWNS (read from docs/blueprint/):
//   • dates: every full date (YYYY-MM-DD) anywhere in blueprint.yaml, decided.yaml, exit-tests.yaml, rows/*.yaml
//   • sentences: each objective's promise and each rule's text (decided.yaml), each competitor's one-liner
//     (blueprint.yaml)
//   • capability names (blueprint.yaml capabilities[].name), as a table cell: a re-typed capability-list row
// WHAT IT SCANS: the chapters named in blueprint.yaml (a file, or every .md under a folder), docs/blueprint/cards/
//   *.md, and any extra paths listed under `handwritten:`. Never the generated phone view or docs/blueprint/history/.
// WHAT FAILS: in that live text, (a) any date on or after the OLDEST date the data holds (a stale copy of a
//   moved date is the usual drift, so it need not equal a current date); dates may be ISO, "8 Nov 2026",
//   "Nov 8, 2026", or year-less "8 Nov" / "Sun 8 Nov" / "Nov 8" (the year taken as the one nearest the as-of
//   date); (b) an owned sentence, ignoring case, spacing and *_`~ marks; (c) a table row with a cell that is
//   exactly a capability name.
// WHAT IT SKIPS, so honest text passes: the chapter banner line ("Chapter of the Blueprint…"); quotations (lines
//   starting with ">", and text inside "…" or “…”); frozen history (between <!-- frozen --> and <!-- /frozen -->);
//   dates older than the oldest date the data holds; dates that are part of a file name or path
//   (2026-10-28-report.md); placeholders like <YYYY-MM-DD>.
// NOT SKIPPED: a "generated" block (<!-- generated --> … <!-- /generated -->) inside a hand-written file. Only the
//   page builder's own output is generated, and it writes no chapter or card; a generated block in a hand-written
//   file is therefore hand-typed, so it is reported and its facts are checked like any other text. Link to the
//   Blueprint page instead.
// LIMIT, said plainly: a paraphrase is not caught, only a copy. The review checks for paraphrased facts.
//
// Usage:  node scripts/blueprint/fact-twice-check.mjs [product-root]     (default: current folder)
// Exit:   0 = no owned fact typed twice · 1 = findings (each printed as path:line) · 2 = setup error

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, YamlLiteError } from './yaml-lite.mjs';

const root = path.resolve(process.argv[2] || '.');
const bp = path.join(root, 'docs', 'blueprint');

function setupError(msg) {
  console.error(`fact-twice-check: ${msg}`);
  process.exit(2);
}

function load(rel, required) {
  const file = path.join(bp, rel);
  if (!fs.existsSync(file)) {
    if (required) setupError(`missing ${path.relative(root, file)} (copy it from Bob's templates/blueprint-roadmap/)`);
    return null;
  }
  try {
    return parseYaml(fs.readFileSync(file, 'utf8'), path.relative(root, file));
  } catch (e) {
    if (e instanceof YamlLiteError) setupError(e.message);
    throw e;
  }
}

const blueprint = load('blueprint.yaml', true) || {};
const decided = load('decided.yaml', true) || {};
const exitTests = load('exit-tests.yaml', false) || {};
const rowsDir = path.join(bp, 'rows');
const rows = fs.existsSync(rowsDir)
  ? fs.readdirSync(rowsDir).filter((n) => n.endsWith('.yaml')).sort().map((n) => load(path.join('rows', n), true))
  : [];

// ── the owned facts ──────────────────────────────────────────────────────────────────────────────────────────
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const dates = [];
(function walk(v) {
  if (typeof v === 'string') {
    const m = v.trim().match(ISO);
    if (m) dates.push(v.trim());
  } else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
})([blueprint, decided, exitTests, rows]);
dates.sort();
const oldest = dates[0] || null;
const asOf = (typeof blueprint.as_of === 'string' && ISO.test(blueprint.as_of) && blueprint.as_of) || dates[dates.length - 1] || null;

const isPlaceholder = (s) => typeof s !== 'string' || /^\s*<.*>\s*$/.test(s) || s.trim() === '';
const norm = (s) => s.toLowerCase().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
const normOwned = (s) => norm(s).replace(/[.;:!?]+$/, '');
const list = (v) => (Array.isArray(v) ? v : []);

const sentences = [];
for (const o of list(decided.objectives)) if (!isPlaceholder(o?.promise)) sentences.push({ kind: `objective ${o.id}'s promise`, text: o.promise });
for (const r of list(decided.rules)) if (!isPlaceholder(r?.text)) sentences.push({ kind: `rule ${r.id}`, text: r.text });
for (const k of list(blueprint.competitors)) if (!isPlaceholder(k?.one_liner)) sentences.push({ kind: `competitor ${k.id}'s one-liner`, text: k.one_liner });
const owned = sentences.map((s) => ({ ...s, n: normOwned(s.text) })).filter((s) => s.n.length >= 20);

const capNames = list(blueprint.capabilities)
  .filter((c) => !isPlaceholder(c?.name) && norm(c.name).length >= 4)
  .map((c) => ({ id: c.id, n: normOwned(c.name) }));

// ── the files to scan ────────────────────────────────────────────────────────────────────────────────────────
const targets = new Set();
const skipDirs = [path.join(bp, 'history')];
const generated = path.join(bp, 'BLUEPRINT.md');
function addPath(rel) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) setupError(`path outside the product: ${rel}`);
  if (!fs.existsSync(abs)) return; // a missing chapter is another check's job ("every chapter reachable")
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs).sort()) addPath(path.join(rel, n));
  } else if (abs.endsWith('.md') && abs !== generated && !skipDirs.some((d) => abs.startsWith(d + path.sep))) {
    targets.add(abs);
  }
}
for (const c of list(blueprint.chapters)) if (c && typeof c.path === 'string') addPath(c.path);
addPath(path.join('docs', 'blueprint', 'cards'));
for (const h of list(blueprint.handwritten)) if (typeof h === 'string') addPath(h);

// ── dates written in prose ───────────────────────────────────────────────────────────────────────────────────
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONRE = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function nearestYear(m, d) {
  if (!asOf) return null;
  const ay = Number(asOf.slice(0, 4));
  const ref = Date.parse(asOf);
  let best = null;
  for (const y of [ay - 1, ay, ay + 1]) {
    const t = Date.parse(ymd(y, m, d));
    if (best === null || Math.abs(t - ref) < Math.abs(best.t - ref)) best = { y, t };
  }
  return best.y;
}
const DATE_PATTERNS = [
  // ISO, not part of a file name or path: 2026-11-08 but not 2026-11-08-notes.md or /2026-11-08/
  { re: /(?<![\w/.-])(\d{4})-(\d{2})-(\d{2})(?![\w/-]|\.\w)/g, get: (m) => [m[1], m[2], m[3]] },
  { re: new RegExp(`\\b(\\d{1,2})\\s+${MONRE}\\s+(\\d{4})\\b`, 'gi'), get: (m) => [m[3], MON[m[2].slice(0, 3).toLowerCase()], m[1]] },
  { re: new RegExp(`\\b${MONRE}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'), get: (m) => [m[3], MON[m[1].slice(0, 3).toLowerCase()], m[2]] },
  { re: new RegExp(`\\b(\\d{1,2})\\s+${MONRE}(?!\\s+\\d{4})\\b`, 'gi'), get: (m) => [null, MON[m[2].slice(0, 3).toLowerCase()], m[1]] },
  { re: new RegExp(`\\b${MONRE}\\s+(\\d{1,2})(?!\\d|,?\\s+\\d{4})\\b`, 'gi'), get: (m) => [null, MON[m[1].slice(0, 3).toLowerCase()], m[2]] },
];
function datesIn(text) {
  const found = [];
  const taken = [];
  for (const { re, get } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const s = m.index, e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      let [y, mo, d] = get(m);
      mo = Number(mo); d = Number(d);
      if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
      y = y === null ? nearestYear(mo, d) : Number(y);
      if (y === null) continue;
      taken.push([s, e]);
      found.push({ shown: m[0], iso: ymd(y, mo, d) });
    }
  }
  return found;
}

// ── the scan ─────────────────────────────────────────────────────────────────────────────────────────────────
const findings = [];
for (const file of [...targets].sort()) {
  const rel = path.relative(root, file);
  let frozen = false;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (/<!--\s*frozen\s*-->/i.test(line)) { frozen = true; return; }
    if (/<!--\s*\/frozen\s*-->/i.test(line)) { frozen = false; return; }
    if (/<!--\s*generated\s*-->/i.test(line)) {
      findings.push(`${rel}:${i + 1}: a "generated" block in a hand-written file — nothing fills it, so it is hand-typed; link to the Blueprint page instead`);
      return;
    }
    if (/<!--\s*\/generated\s*-->/i.test(line)) return;
    if (frozen) return;
    if (line.startsWith('>')) return;                       // quotation
    if (/chapter of the blueprint/i.test(line)) return;     // the chapter banner
    const live = raw
      .replace(/https?:\/\/\S+/g, ' ')                     // web links
      .replace(/\]\([^)]*\)/g, '] ')                       // markdown link targets
      .replace(/<[^>\n]*>/g, (t) => (/^<[A-Za-z!/]/.test(t) ? ' ' : t)) // html tags and <placeholders>
      .replace(/“[^”]*”|"[^"\n]*"/g, ' ');                 // inline quotations
    const at = `${rel}:${i + 1}`;
    if (oldest) {
      for (const d of datesIn(live)) {
        if (d.iso >= oldest) findings.push(`${at}: date "${d.shown}" (${d.iso}) — dates live in docs/blueprint/ (the fact files); link to the milestone or row instead of re-typing its date`);
      }
    }
    const n = norm(live);
    for (const s of owned) {
      if (n.includes(s.n)) findings.push(`${at}: ${s.kind} re-typed — "${s.text}" lives in docs/blueprint/; link to it instead`);
    }
    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => normOwned(c)).filter(Boolean);
      for (const c of capNames) {
        if (cells.includes(c.n)) findings.push(`${at}: capability ${c.id} re-typed as a table row — the capability index is generated from docs/blueprint/blueprint.yaml`);
      }
    }
  });
}

if (findings.length) {
  console.log(`fact-twice-check: ${findings.length} owned fact(s) typed twice in ${targets.size} hand-written file(s):`);
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`fact-twice-check: no owned fact typed twice (${targets.size} hand-written file(s); ${dates.length} owned date(s) from ${oldest ?? '—'}; ${owned.length} owned sentence(s); ${capNames.length} capability name(s))`);
