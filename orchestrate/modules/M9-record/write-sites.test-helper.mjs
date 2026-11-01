// write-sites.test-helper.mjs — finds every Record write in the real module sources and checks each against the
// permissions table (L112). The class: a module test on an in-memory record that allows everything hid that the real
// Record refused the Dispatcher's fact writes, so the alert queue never stored an alert. This reads the code itself.
//
//   scanSources(files)  files: [{ file, src }] (file relative to orchestrate/, '/'-separated)
//     → { sites, problems }   sites: [{ file, line, actor, entity, modes, via? }]; problems: ['file:line: why']
//   checkSites(sites, allowed = fieldsAllowed) → [{ site, mode, why }] for each write the table would refuse
//
// A site is `<x>.write({ … actor: …, entity: … })`. Its modes come from its expectRev: `0` creates, `… ?? 0` may
// create or update, anything else updates. A write whose actor or entity is not a literal (or a one-line
// `const NAME = '<literal>'` in the same file) is a problem unless it is on VARIABLE_SITES below, which says what reaches
// it. A `.write(` whose argument is not an object literal is a problem unless the receiver is plainly not the Record or
// the site is on NOT_OBJECT_SITES. Comments are skipped, so an example in a comment is not a site.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fieldsAllowed } from './permissions.mjs';

// Receivers that are never the Record: output streams, and the setup's own file io (setup/users-folders.mjs).
export const NOT_RECORD_RECEIVERS = Object.freeze({
  'process.stdout': 'standard output',
  'process.stderr': 'standard error',
  io: "the setup's file io, which writes plain files (setup/users-folders.mjs)",
});

// `.write(<not an object>)` sites that are the Record: the front door passes the caller's write straight through.
export const NOT_OBJECT_SITES = Object.freeze([
  { file: 'shared/record.mjs', receiver: 'impl', count: 1, reason: "the Record's front door hands the caller's write to the store, which checks it" },
  { file: 'modules/M6-merge-gate/github-checker.mjs', receiver: 'impl', count: 1, reason: 'the bundled copy of shared/record.mjs' },
]);

// Writes whose actor or entity comes from a variable. `count` is how many such sites the file has; each entry says
// what reaches them: fixed pairs, or the calls of a helper whose entity is a literal at every call site (`calls`).
// Every call of that helper outside its definition must pass a literal entity, or the scan says so.
export const VARIABLE_SITES = Object.freeze([
  { file: 'modules/M12-sensors/facts.mjs', count: 1, reason: 'the one fact writer; the caller names the actor (default sensors, M13 alerts passes ledger)',
    pairs: [{ actor: 'sensors', entity: 'fact', modes: ['create', 'update'] }, { actor: 'ledger', entity: 'fact', modes: ['create', 'update'] }] },
  { file: 'modules/M6-merge-gate/gate.mjs', count: 1, reason: "gate.mjs's own write(entity, cur, …) helper rewrites a document it just read",
    calls: { pattern: /\bwrite\(\s*'([a-z_]+)'/g, actor: 'merge_gate', modes: ['update'], files: ['modules/M6-merge-gate/gate.mjs'], helper: 'write' } },
  { file: 'modules/M2-approvals/ask-store.mjs', count: 1, reason: 'writeDoc(record, entity, cur, doc), M2\'s one writer of asks and gos (cur = null creates)',
    calls: { pattern: /\bwriteDoc\(\s*[^,()]+,\s*'([a-z_]+)'/g, actor: 'approvals', modes: ['create', 'update'], helper: 'writeDoc' } },
  { file: 'modules/M11-dispatcher/moves.mjs', count: 1, reason: 'move(rec, entity, id, patch) re-reads the document and writes it as the dispatcher',
    calls: { pattern: /\bmove\(\s*rec,\s*'([a-z_]+)'/g, actor: 'dispatcher', modes: ['update'], helper: 'move',
      // Only files that take move from M11's moves.mjs (gate.mjs has its own, unrelated move()).
      inFile: (file, src) => file === 'modules/M11-dispatcher/moves.mjs'
        || (file.startsWith('modules/M11-dispatcher/') && /import\s*\{[^}]*\bmove\b[^}]*\}\s*from\s*'\.\/moves\.mjs'/.test(src)) } },
]);

// Writes the real Record refuses today and another lane is changing. The test prints each one (never a silent skip),
// and fails once one of them is gone or allowed, so the entry is taken off with the fix.
export const PENDING = Object.freeze([
  { name: 'pending L112-3', file: 'modules/M11-dispatcher/cleanup.mjs', actor: 'dispatcher', entity: 'ask', count: 2,
    reason: 'lane 2 routes these through approvals (consumeAsk to close, approvals\' own create for the cleanup ask)' },
  { name: 'pending L112-3', file: 'modules/M11-dispatcher/undo.mjs', actor: 'dispatcher', entity: 'ask', count: 1,
    reason: 'lane 2 closes this ask through consumeAsk' },
  { name: 'pending lead ruling (L112 find)', file: 'modules/M11-dispatcher/merges.mjs', actor: 'dispatcher', entity: 'merge', count: 2,
    reason: 'move(rec, \'merge\', …) to merged or refused; M9 gives merge moves and writes to merge_gate alone (moves.mjs and permissions.mjs)' },
  { name: 'pending lead ruling (L112 find)', file: 'modules/M11-dispatcher/pass.mjs', actor: 'dispatcher', entity: 'launch', count: 1,
    reason: 'the launch write passes a read rev, but a session id launches once, and the Merge Gate trusts the launch (refusal 5); proposed: lane 2 writes expectRev: 0' },
]);

const LITERAL = /^'([a-z_]+)'$/;

// Source with comment text blanked, keeping line numbers and string contents.
export function stripComments(src) {
  let out = ''; let i = 0; let q = null;
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += d ?? ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; out += c; i++; continue; }
    // A regex literal (a `/` where a value starts): copied as is, so a quote or `//` inside it opens nothing.
    if (c === '/' && d !== '/' && d !== '*' && /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(out.slice(-40))) {
      let cls = false; out += c; i++;
      while (i < src.length && src[i] !== '\n') {
        const e = src[i]; out += e; i++;
        if (e === '\\') { out += src[i] ?? ''; i++; continue; }
        if (e === '[') cls = true; else if (e === ']') cls = false; else if (e === '/' && !cls) break;
      }
      continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// The text of the balanced {...} starting at `at` (strings skipped), or null.
function objectAt(s, at) {
  let depth = 0; let q = null;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) return s.slice(at, i + 1); }
  }
  return null;
}

// Top-level `key: value` and shorthand properties of an object literal's text.
export function topProps(obj) {
  const body = obj.slice(1, -1); const parts = []; let depth = 0; let q = null; let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  const props = {};
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(p);
    if (m) props[m[1]] = m[2].trim();
    else if (/^[A-Za-z_$][\w$]*$/.test(p)) props[p] = p;   // shorthand: a variable of that name
  }
  return props;
}

export function modesOf(expectRev) {
  if (expectRev === undefined) return null;
  const e = expectRev.replace(/\s+/g, ' ');
  if (e === '0') return ['create'];
  if (/\?\? 0$/.test(e)) return ['create', 'update'];
  return ['update'];
}

const lineOf = (s, at) => s.slice(0, at).split('\n').length;

export function scanSources(files) {
  const sites = []; const problems = []; const variable = new Map(); const notObject = new Map();
  for (const { file, src } of files) {
    const s = stripComments(src);
    const consts = new Map([...s.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*'([a-z_]+)'\s*;/g)].map((m) => [m[1], m[2]]));
    const resolve = (v) => (v === undefined ? null : LITERAL.exec(v)?.[1] ?? consts.get(v) ?? null);
    for (const m of s.matchAll(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.write\(\s*/g)) {
      const receiver = m[1].replace(/\?\./g, '.'); const at = m.index + m[0].length; const line = lineOf(s, m.index);
      if (Object.hasOwn(NOT_RECORD_RECEIVERS, receiver)) continue;
      if (s[at] !== '{') { const k = `${file}|${receiver}`; notObject.set(k, [...(notObject.get(k) ?? []), line]); continue; }
      const obj = objectAt(s, at);
      if (!obj) { problems.push(`${file}:${line}: a write whose object never closes`); continue; }
      const props = topProps(obj);
      if (!('actor' in props) && !('entity' in props)) { const k = `${file}|${receiver}`; notObject.set(k, [...(notObject.get(k) ?? []), line]); continue; }
      const actor = resolve(props.actor); const entity = resolve(props.entity); const modes = modesOf(props.expectRev);
      if (!modes) { problems.push(`${file}:${line}: a Record write with no expectRev`); continue; }
      if (actor && entity) { sites.push({ file, line, actor, entity, modes }); continue; }
      variable.set(file, [...(variable.get(file) ?? []), line]);
    }
  }
  for (const [k, lines] of notObject) {
    const [file, receiver] = k.split('|');
    const named = NOT_OBJECT_SITES.find((x) => x.file === file && x.receiver === receiver);
    if (!named) problems.push(`${file}:${lines.join(',')}: ${receiver}.write( with no object literal is not on NOT_OBJECT_SITES`);
    else if (named.count !== lines.length) problems.push(`${file}: ${lines.length} ${receiver}.write( sites, NOT_OBJECT_SITES says ${named.count}`);
  }
  for (const named of NOT_OBJECT_SITES) if (!notObject.has(`${named.file}|${named.receiver}`) && files.some((f) => f.file === named.file)) problems.push(`${named.file}: NOT_OBJECT_SITES names ${named.receiver}.write( but the file has none; take it off`);
  for (const [file, lines] of variable) {
    const named = VARIABLE_SITES.find((x) => x.file === file);
    if (!named) { problems.push(`${file}:${lines.join(',')}: a Record write whose actor or entity is not a literal, and not on VARIABLE_SITES`); continue; }
    if (named.count !== lines.length) problems.push(`${file}: ${lines.length} variable write sites, VARIABLE_SITES says ${named.count}`);
  }
  for (const named of VARIABLE_SITES) {
    if (!files.some((f) => f.file === named.file)) continue;
    if (!variable.has(named.file)) { problems.push(`${named.file}: on VARIABLE_SITES but has no variable write; take it off`); continue; }
    for (const p of named.pairs ?? []) sites.push({ file: named.file, line: variable.get(named.file)[0], ...p, via: named.reason });
    if (!named.calls) continue;
    const c = named.calls;
    for (const { file, src } of files) {
      if (c.files && !c.files.includes(file)) continue;
      if (c.inFile && !c.inFile(file, src)) continue;
      const s = stripComments(src);
      const all = [...s.matchAll(new RegExp(`(?<![\\w$.])${c.helper}\\(`, 'g'))].filter((m) => !/function\s*$/.test(s.slice(0, m.index)));
      const lit = [...s.matchAll(c.pattern)];
      for (const m of lit) sites.push({ file, line: lineOf(s, m.index), actor: c.actor, entity: m[1], modes: c.modes, via: `${c.helper}()` });
      if (all.length !== lit.length) problems.push(`${file}: ${all.length - lit.length} ${c.helper}( call(s) without a literal entity; the scan cannot say what they write`);
    }
  }
  return { sites, problems };
}

export function checkSites(sites, allowed = fieldsAllowed) {
  const refused = [];
  for (const site of sites) for (const mode of site.modes) {
    if (allowed(site.entity, site.actor, { create: mode === 'create' }) === null) refused.push({ site, mode, why: `${site.actor} may not ${mode} ${site.entity}` });
  }
  return refused;
}

// Every non-test module under orchestrate/, as { file, src }.
export function moduleSources(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.mjs') || name.endsWith('.test.mjs') || name.endsWith('.test-helper.mjs')) continue;
      out.push({ file: relative(root, p).split(sep).join('/'), src: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return out;
}

// Splits refusals into the ones a PENDING entry names (with that entry) and the rest; and the PENDING entries no
// longer matched exactly (gone, allowed, or a different count).
export function splitPending(refused, pending = PENDING) {
  const open = []; const held = new Map();
  for (const r of refused) {
    const p = pending.find((x) => x.file === r.site.file && x.actor === r.site.actor && x.entity === r.site.entity);
    if (!p) { open.push(r); continue; }
    const k = pending.indexOf(p); held.set(k, [...(held.get(k) ?? []), r]);
  }
  const stale = [];
  pending.forEach((p, k) => {
    const n = new Set((held.get(k) ?? []).map((r) => r.site.line)).size;
    if (n !== p.count) stale.push(`${p.name}: ${p.file} ${p.actor} → ${p.entity} expects ${p.count} refused site(s), found ${n}; update the list`);
  });
  return { open, held: [...held].map(([k, rs]) => ({ entry: pending[k], refused: rs })), stale };
}
