#!/usr/bin/env node
// schema-check.mjs — the Blueprint's fact files have the fields their template says, and nothing is half-read
// (Blueprint & Roadmap, the data shape: decided.yaml, exit-tests.yaml, blueprint.yaml, rows/<row-id>.yaml).
//
// WHY. Every other Blueprint check and the page builder read these files. If a row is missing its "done when", or
// a competitor its last-checked date, those checks quietly see nothing and pass. This check makes the shape itself
// fail loudly, so "nothing found" can only mean "nothing there".
//
// The shape lives once, in SCHEMA below; templates/blueprint-roadmap/ is a filled-in copy of it with placeholders.
//
// Usage:  node scripts/blueprint/schema-check.mjs [product-root]
// Exit:   0 = every file has its shape · 1 = findings · 2 = setup error (a file missing or unreadable)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, YamlLiteError } from './yaml-lite.mjs';

// field: 'r' required (may not be empty) · 'o' optional (key may be absent or empty) · 'k' key required, may be empty
// a nested object describes each item of a list.
export const SCHEMA = {
  'decided.yaml': {
    goal: 'r', for_whom: 'r',
    objectives: { id: 'r', name: 'r', promise: 'r', target: 'r', measured_by: 'r' },
    not_doing: { what: 'r', why: 'r', revisit_if: 'r' },
    rules: { id: 'r', name: 'r', text: 'r' },
    capabilities_adopted: 'k',
  },
  'exit-tests.yaml': {
    exit_tests: { milestone: 'r', test: 'r', passes_when: 'r' },
  },
  'blueprint.yaml': {
    as_of: 'r',
    chapters: { name: 'r', path: 'r' },
    milestones: { id: 'r', name: 'r', estimate: 'r', condition: 'o', slips: 'k' },
    modules: { id: 'r', name: 'r', plane: 'r', role: 'r' },
    capabilities: { id: 'r', name: 'r', module: 'r', maturity: 'r', row: 'o' },
    competitors: { id: 'r', name: 'r', group: 'r', one_liner: 'r', last_checked: 'r', recheck_by: 'r' },
    research: 'k',
    handwritten: 'o',
  },
  row: { id: 'r', what: 'r', module: 'r', capability: 'o', owner: 'r', date: 'o', trigger: 'o', done_when: 'r', status: 'r', receipts: 'k' },
};
const STATUS = new Set(['planned', 'building', 'done', 'not done', 'dropped']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DATE_FIELDS = new Set(['as_of', 'estimate', 'last_checked', 'recheck_by', 'date']);

const empty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

export function checkShape(value, shape, where, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${where}: expected a map of fields`);
    return;
  }
  for (const [key, rule] of Object.entries(shape)) {
    const has = Object.prototype.hasOwnProperty.call(value, key);
    const v = value[key];
    if (typeof rule === 'object') {
      if (!has) { out.push(`${where}: missing "${key}" (a list)`); continue; }
      if (v === null) continue; // an empty list is allowed; required items are a product decision, not a shape one
      if (!Array.isArray(v)) { out.push(`${where}: "${key}" must be a list`); continue; }
      v.forEach((item, i) => checkShape(item, rule, `${where} ${key}[${i}]${item && item.id ? ` (${item.id})` : ''}`, out));
      continue;
    }
    if (rule === 'r' && (!has || empty(v))) out.push(`${where}: missing "${key}"`);
    if (rule === 'k' && !has) out.push(`${where}: missing "${key}" (may be empty, but the field must be there)`);
    if (has && DATE_FIELDS.has(key) && typeof v === 'string' && !/^\s*<.*>\s*$/.test(v) && v.trim() && !ISO.test(v.trim())) {
      out.push(`${where}: "${key}" must be a date written YYYY-MM-DD, not "${v}"`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!(key in shape)) out.push(`${where}: unknown field "${key}" (add it to scripts/blueprint/schema-check.mjs first, so every reader knows it)`);
  }
}

function main() {
  const root = path.resolve(process.argv[2] || '.');
  const bp = path.join(root, 'docs', 'blueprint');
  const out = [];
  const read = (abs) => {
    const rel = path.relative(root, abs);
    if (!fs.existsSync(abs)) { console.error(`schema-check: missing ${rel}`); process.exit(2); }
    try { return parseYaml(fs.readFileSync(abs, 'utf8'), rel); } catch (e) {
      if (e instanceof YamlLiteError) { console.error(`schema-check: ${e.message}`); process.exit(2); }
      throw e;
    }
  };
  for (const name of ['decided.yaml', 'exit-tests.yaml', 'blueprint.yaml']) {
    checkShape(read(path.join(bp, name)), SCHEMA[name], `docs/blueprint/${name}`, out);
  }
  const rowsDir = path.join(bp, 'rows');
  const rowFiles = fs.existsSync(rowsDir) ? fs.readdirSync(rowsDir).filter((n) => n.endsWith('.yaml')).sort() : [];
  for (const n of rowFiles) {
    const where = `docs/blueprint/rows/${n}`;
    const row = read(path.join(rowsDir, n));
    checkShape(row, SCHEMA.row, where, out);
    if (row && typeof row.id === 'string' && `${row.id}.yaml` !== n) out.push(`${where}: its id "${row.id}" must match its file name`);
    if (row && typeof row.status === 'string' && !STATUS.has(row.status)) out.push(`${where}: status "${row.status}" is not one of ${[...STATUS].join(', ')}`);
    if (row && empty(row.date) && empty(row.trigger)) out.push(`${where}: needs a date or a named trigger`);
  }
  if (out.length) {
    console.log(`schema-check: ${out.length} problem(s):`);
    for (const f of out) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log(`schema-check: every fact file has its shape (3 files, ${rowFiles.length} row file(s))`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
