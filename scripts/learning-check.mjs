#!/usr/bin/env node
// Optional learning block in the existing audit ledger. No evidence contents or
// recorded commands are read/executed. This validates attestations, not their truth.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const count = v => Number.isSafeInteger(v) && v >= 0;
const stable = v => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
const evidenceFields = ['scope_evidence', 'regression_evidence', 'clean_control_evidence', 'new_instance_evidence'];
const unsafe = p => p.split(/[\\/]/).some(s => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.bitcoin|\.ethereum|\.metamask|\.coinbase|\.plaid|\.stripe|cookies(?:\..*)?|login data|credentials|.*-password(?:\.txt)?)$/i.test(s));

export function inspectLearning(ledger, { baseDir = '.', stage = 'plan', className } = {}) {
  const errors = [], messages = [];
  const fail = m => errors.push(m);
  const keys = (v, allowed, at) => {
    if (!object(v)) { fail(`${at}: must be an object`); return false; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${at}: unknown field ${k}`);
    return true;
  };
  if (!['plan', 'close'].includes(stage)) return { code: 1, errors: ['stage must be plan or close'], messages };
  if (className !== undefined && !stable(className)) return { code: 1, errors: ['class must be a stable kebab-case name'], messages };
  if (!object(ledger)) return { code: 1, errors: ['ledger must be an object'], messages };
  if (!Object.hasOwn(ledger, 'learning')) return { code: 2, errors, messages: ['Cannot judge: no learning block.'] };
  const learning = ledger.learning;
  if (!keys(learning, ['version', 'incidents', 'changes'], 'learning')) return { code: 1, errors, messages };
  if (learning.version !== 1) fail('learning.version must be 1');
  if (!Array.isArray(learning.incidents)) fail('learning.incidents must be an array');
  if (!Array.isArray(learning.changes)) fail('learning.changes must be an array');
  if (errors.length) return { code: 1, errors, messages };
  let root;
  try { root = realpathSync(baseDir); } catch { return { code: 1, errors: ['ledger directory unavailable'], messages }; }
  const evidence = (p, at) => {
    // Do not traverse secrets, parent components, absolute paths or symlinks.
    if (!text(p) || isAbsolute(p) || p.includes('\\') || p.split('/').some(s => !s || s === '..' || s === '.') || unsafe(p)) {
      fail(`${at}: requires a safe relative evidence file beneath the ledger directory`); return;
    }
    try {
      let current = root;
      for (const part of p.split('/')) {
        current = resolve(current, part);
        if (lstatSync(current).isSymbolicLink()) throw new Error('symlink');
      }
      const rel = relative(root, realpathSync(current));
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || !lstatSync(current).isFile()) throw new Error('not a local file');
    } catch { fail(`${at}: evidence file missing, not a regular file, or linked outside the evidence boundary`); }
  };
  const changes = new Map();
  for (const [i, c] of learning.changes.entries()) {
    const at = `changes[${i}]`;
    if (!keys(c, ['id', 'material_remaining', 'rounds', 'cause_analysis'], at)) continue;
    if (!stable(c.id)) fail(`${at}.id: expected stable kebab-case name`);
    if (changes.has(c.id)) fail(`${at}: duplicate change id ${c.id}`);
    changes.set(c.id, c);
    if (!count(c.material_remaining)) fail(`${at}.material_remaining: expected nonnegative integer`);
    if (c.cause_analysis !== undefined) evidence(c.cause_analysis, `${at}.cause_analysis`);
    if (c.rounds !== undefined) {
      if (!Array.isArray(c.rounds)) { fail(`${at}.rounds must be an array`); continue; }
      const ids = new Set();
      for (const [j, r] of c.rounds.entries()) {
        const where = `${at}.rounds[${j}]`;
        if (!keys(r, ['id', 'kind', 'material_found'], where)) continue;
        if (!stable(r.id) || ids.has(r.id)) fail(`${where}.id: missing, invalid or duplicate round id`);
        ids.add(r.id);
        if (!['initial', 'follow-up'].includes(r.kind)) fail(`${where}.kind: expected initial or follow-up`);
        if (!count(r.material_found)) fail(`${where}.material_found: expected nonnegative integer`);
      }
    }
  }
  const ids = new Set(), classes = new Map();
  for (const [i, incident] of learning.incidents.entries()) {
    const at = `incidents[${i}]`;
    if (!keys(incident, ['id', 'class', 'kind', 'change_id', 'source', 'check', 'status', 'prevention'], at)) continue;
    if (!stable(incident.id) || ids.has(incident.id)) fail(`${at}.id: missing, invalid or duplicate incident id (review rounds are not new incidents)`);
    ids.add(incident.id);
    if (!stable(incident.class)) fail(`${at}.class: expected stable kebab-case name`);
    if (!['newly-discovered', 'repeat', 'fix-induced', 'unknown'].includes(incident.kind)) fail(`${at}.kind: expected newly-discovered, repeat, fix-induced or unknown`);
    evidence(incident.source, `${at}.source`);
    if (!changes.has(incident.change_id)) fail(`${at}.change_id: must reference a declared change`);
    if (!text(incident.check)) fail(`${at}.check: required actionable detection question`);
    if (!['open', 'closed'].includes(incident.status)) fail(`${at}.status: expected open or closed`);
    if (!classes.has(incident.class)) classes.set(incident.class, []);
    classes.get(incident.class).push(incident);
    if (incident.prevention !== undefined) {
      const p = incident.prevention;
      if (!keys(p, ['invariant', 'mechanism', 'command', ...evidenceFields, 'builder', 'reviewer', 'adoption'], `${at}.prevention`)) continue;
      for (const f of ['invariant', 'mechanism', 'command', 'builder', 'reviewer']) if (!text(p[f])) fail(`${at}.prevention.${f}: required`);
      if (text(p.builder) && text(p.reviewer) && p.builder.trim() === p.reviewer.trim()) fail(`${at}: builder and reviewer must differ`);
      for (const f of evidenceFields) evidence(p[f], `${at}.prevention.${f}`);
      if (keys(p.adoption, ['status', 'evidence'], `${at}.prevention.adoption`)) {
        if (!['unknown', 'verified'].includes(p.adoption.status)) fail(`${at}.prevention.adoption.status: expected unknown or verified`);
        if (p.adoption.status === 'verified' || p.adoption.evidence !== undefined) evidence(p.adoption.evidence, `${at}.prevention.adoption.evidence`);
      }
    }
  }
  // Validate the entire block before filtering; a typo must never hide a finding.
  if (errors.length) return { code: 1, errors, messages };
  const selected = [...classes].filter(([name]) => !className || name === className);
  if (!selected.length && (className || !changes.size)) return { code: 2, errors, messages: ['Cannot judge: no matching learning records.'] };
  const selectedChanges = new Set(className ? selected.flatMap(([, rows]) => rows.map(r => r.change_id)) : changes.keys());
  for (const [name, rows] of selected) {
    const recurring = rows.length > 1 || rows.some(r => r.kind === 'repeat');
    messages.push(`${name}: ${rows.length} distinct incident(s); ${recurring ? 'recurring' : 'first recorded occurrence'}.`);
    for (const r of rows) {
      messages.push(`  ${r.id} [${r.kind}, ${r.status}]: ${r.check}`);
      const p = r.prevention;
      if (p) messages.push(`  Prevention: ${p.mechanism}; check command (not executed): ${p.command}; adoption: ${p.adoption.status}.`);
      if (recurring && (r.status !== 'closed' || !p || p.adoption.status !== 'verified')) {
        const message = `${r.id}: recurring prevention remains unresolved; require closed status, complete independent prevention evidence and verified adoption`;
        if (stage === 'close') fail(message); else messages.push(`  OPEN: ${message}.`);
      }
      // An explicit closure claim must not masquerade as complete when its own proof is missing.
      if (recurring && r.status === 'closed' && (!p || p.adoption.status !== 'verified') && stage === 'plan') fail(`${r.id}: falsely closed recurring class; prevention/adoption proof incomplete`);
    }
  }
  for (const id of selectedChanges) {
    const c = changes.get(id);
    const rounds = c.rounds ?? [];
    const positive = rounds.filter(r => r.material_found > 0);
    if (positive.length >= 3) messages.push(`DIAGNOSTIC ${id}: Material findings in ${positive.length} review rounds (${positive.filter(r => r.kind === 'initial').length} initial, ${positive.filter(r => r.kind === 'follow-up').length} follow-up). Analyze the upstream cause and prevention; this is not an audit cap or permission to leave Material open. Cause analysis: ${c.cause_analysis ?? 'not recorded'}.`);
    if (c.material_remaining > 0) {
      const m = `${id}: ${c.material_remaining} Material finding(s) remain open`;
      if (stage === 'close') fail(m); else messages.push(`OPEN: ${m}.`);
    }
  }
  messages.push('Evidence paths exist; contents, command behavior, semantic correctness and identity attestations were NOT verified by this checker. Run the existing audit-ledger check as well.');
  return { code: errors.length ? 1 : 0, errors, messages };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: node learning-check.mjs [docs/audit-ledger.json] [--stage plan|close] [--class exact-kebab-case]\nReads optional learning v1 in the existing ledger. Evidence paths are relative to its directory; files are checked, never read. Recorded commands are printed, never executed. See templates/learning-record.example.json.\nExit 0: record checks pass; 1: invalid/unresolved close; 2: no data. This does not certify safety or replace audit-ledger-check.mjs.');
    return 0;
  }
  let file, stage = 'plan', className;
  const used = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--stage', '--class'].includes(a)) {
      if (used.has(a) || !argv[i + 1] || argv[i + 1].startsWith('--')) { console.error(`Invalid argument: ${a}`); return 1; }
      used.add(a);
      if (a === '--stage') stage = argv[++i]; else className = argv[++i];
    } else if (a.startsWith('-') || file) { console.error(`Invalid argument: ${a}`); return 1; }
    else file = a;
  }
  file ??= 'docs/audit-ledger.json';
  if (unsafe(file)) { console.error('Refusing a sensitive ledger path.'); return 1; }
  let ledger;
  try {
    if (lstatSync(file).isSymbolicLink()) { console.error('Ledger must not be a symbolic link.'); return 1; }
    if (unsafe(realpathSync(file))) { console.error('Refusing a sensitive ledger path.'); return 1; }
    ledger = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const absent = e.code === 'ENOENT';
    console.error(absent ? 'Cannot judge: ledger missing.' : 'Invalid or unreadable ledger JSON.');
    return absent ? 2 : 1;
  }
  const result = inspectLearning(ledger, { baseDir: dirname(resolve(file)), stage, className });
  for (const m of result.messages) console.log(m);
  for (const e of result.errors) console.error(`REFUSED: ${e}`);
  return result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
