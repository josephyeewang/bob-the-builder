#!/usr/bin/env node
// live-figures-check.mjs — validate a product's list of live figures to re-check after each deploy
// (templates/quality/live-figures.json). Every field must be filled in; an empty, unknown or malformed field fails.
//
//   node scripts/quality/live-figures-check.mjs .quality/live-figures.json
//
// Fields of each figure:
//   figure          what the number is, in the owner's words ("Total paid this month")
//   liveAddress     the https:// page or API address on the live product that shows it
//   readAt          where on that page or response the number is: a CSS selector or a JSON path ($.total)
//   secondWayQuery  a second, independent way to compute it from the product's own data (a read-only query)
//   tolerance       the largest gap that still counts as matching: an absolute number ("0", "0.01") or a percentage ("0.5%")

import { readFileSync } from 'node:fs';
import { isMain } from './quality-lib.mjs';

const TOP = ['_doc', 'product', 'figures'];
const FIELDS = ['figure', 'liveAddress', 'readAt', 'secondWayQuery', 'tolerance'];

export function checkLiveFigures(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['the file must hold one JSON object'];
  for (const k of Object.keys(doc)) if (!TOP.includes(k)) problems.push(`unknown key "${k}" (allowed: ${TOP.join(', ')})`);
  if (typeof doc.product !== 'string' || !doc.product.trim()) problems.push('product is empty');
  if (!Array.isArray(doc.figures) || doc.figures.length === 0) return [...problems, 'figures must list at least one figure'];
  const seen = new Set();
  doc.figures.forEach((f, i) => {
    const at = `figures[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) { problems.push(`${at} must be an object`); return; }
    for (const k of Object.keys(f)) if (!FIELDS.includes(k)) problems.push(`${at} has an unknown field "${k}"`);
    for (const k of FIELDS) {
      if (typeof f[k] !== 'string' || !f[k].trim()) problems.push(`${at}.${k} is empty`);
    }
    if (typeof f.figure === 'string' && f.figure.trim()) {
      if (seen.has(f.figure.trim())) problems.push(`${at}.figure "${f.figure}" is listed twice`);
      seen.add(f.figure.trim());
    }
    if (typeof f.liveAddress === 'string' && f.liveAddress.trim()) {
      let url = null;
      try { url = new URL(f.liveAddress); } catch { /* reported below */ }
      if (!url || url.protocol !== 'https:') problems.push(`${at}.liveAddress must be an https:// address on the live product`);
    }
    if (typeof f.tolerance === 'string' && f.tolerance.trim() && !/^\d+(\.\d+)?%?$/.test(f.tolerance.trim())) {
      problems.push(`${at}.tolerance must be a number ("0.01") or a percentage ("0.5%")`);
    }
  });
  return problems;
}

export function main(argv, { log = console.log } = {}) {
  if (argv.length !== 1) { log('usage: node live-figures-check.mjs <path to live-figures.json>'); return 2; }
  let doc;
  try { doc = JSON.parse(readFileSync(argv[0], 'utf8')); } catch (e) { log(`FAIL cannot read ${argv[0]}: ${e.code ?? e.message}`); return 1; }
  const problems = checkLiveFigures(doc);
  if (problems.length === 0) { log(`PASS ${argv[0]}: ${doc.figures.length} live figure${doc.figures.length > 1 ? 's' : ''}, every field filled in`); return 0; }
  log(`FAIL ${argv[0]}:\n${problems.map((p) => `      ${p}`).join('\n')}`);
  return 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
