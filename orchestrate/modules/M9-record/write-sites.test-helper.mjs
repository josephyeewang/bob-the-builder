// write-sites.test-helper.mjs — finds every Record write in the real module sources and checks each against the
// permissions table (L112, L118). The class: a module test on an in-memory record that allows everything hid that the
// real Record refused the Dispatcher's fact writes, so the alert queue never stored an alert. This reads the code itself.
//
//   scanSources(files)  files: [{ file, src }] (file relative to orchestrate/, '/'-separated)
//     → { sites, problems }   sites: [{ file, line, fn, actor, entity, modes, via? }]; problems: ['file:line: why']
//   checkSites(sites, allowed = fieldsAllowed) → [{ site, mode, why }] for each write the table would refuse
//   grantUse(sites, writers = WRITERS) → { unused, staleUnused }: table grants no site uses and that UNUSED_GRANTS
//     doesn't explain, and UNUSED_GRANTS entries that are used after all (L118 m1)
//
// A site is `<x>.write({ … actor: …, entity: … })`. Its modes come from its expectRev: `0` creates, `x.rev` or `x?.rev`
// updates, anything else may do either (L118 m4). A write whose actor or entity is not a literal (or a one-line
// `const NAME = '<literal>'` in the same file) is a problem unless it is on VARIABLE_SITES below, which says what
// reaches it. A `.write(` whose argument is not an object literal is a problem unless the receiver is plainly not the
// Record in that file or the site is on NOT_OBJECT_SITES. Any other use of `write` that could reach the Record (an
// optional call, `['write']`, `.call`/`.apply`/`.bind`, destructuring, the method handed on as a value, a space before
// the bracket) is a problem unless OTHER_FORMS names it (L118 m2). Comments are skipped, so an example in a comment is
// not a site. Each site carries the name of the innermost named function around it, which PENDING pins (L118 m6).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { WRITERS, fieldsAllowed } from './permissions.mjs';

// Receivers that are never the Record, each limited to the files where that is so (L118 m2).
export const NOT_RECORD_RECEIVERS = Object.freeze([
  { receiver: 'process.stdout', files: null, reason: "standard output, Node's own stream in every file" },
  { receiver: 'process.stderr', files: null, reason: "standard error, Node's own stream in every file" },
  { receiver: 'io', files: ['setup/users-folders.mjs', 'setup/daemons.mjs', 'setup/install.mjs'], reason: "the setup's file io, which writes plain files" },
]);
const notRecord = (file, receiver) => NOT_RECORD_RECEIVERS.some((x) => x.receiver === receiver && (!x.files || x.files.includes(file)));

// `.write(<not an object>)` sites that are the Record: the front door passes the caller's write straight through.
export const NOT_OBJECT_SITES = Object.freeze([
  { file: 'shared/record.mjs', receiver: 'impl', count: 1, reason: "the Record's front door hands the caller's write to the store, which checks it" },
  { file: 'modules/M6-merge-gate/github-checker.mjs', receiver: 'impl', count: 1, reason: 'the bundled copy of shared/record.mjs' },
]);

// Other forms of `write` that are not a way round the scan, by file and count (L118 m2). Anything else is a problem.
export const OTHER_FORMS = Object.freeze([
  { file: 'modules/M9-record/writer.mjs', count: 1, reason: 'the Store Writer itself: its checked writes carry a `write` field that it commits' },
  { file: 'modules/M4-workshop/launcher/review-runner-main.mjs', count: 1, reason: "the runner's ports: write is its snapshot file writer, not the Record" },
]);

// Writes whose actor or entity comes from a variable. `count` is how many such sites the file has; each entry says
// what reaches them: fixed pairs, or the calls of a helper whose entity is a literal at every call site (`calls`).
// A helper defined in `module` is followed into every file that imports it from that path, under any local name;
// a namespace, re-export or dynamic import of that module is a problem, since the scan can't follow it (L118 m3).
export const VARIABLE_SITES = Object.freeze([
  { file: 'modules/M12-sensors/facts.mjs', count: 1, reason: 'the one fact writer; the caller names the actor (default sensors, M13 alerts passes ledger)',
    pairs: [{ actor: 'sensors', entity: 'fact', modes: ['create', 'update'] }, { actor: 'ledger', entity: 'fact', modes: ['create', 'update'] }],
    // Who may make one, with which actor (L118 m5): each call's `actor:` must be one of the pairs above.
    makers: [{ helper: 'makeFactWriter', module: 'modules/M12-sensors/facts.mjs', fallback: 'sensors' },
      { helper: 'makeAlerts', module: 'modules/M13-ledger/alerts.mjs', fallback: 'ledger' }] },
  { file: 'modules/M6-merge-gate/gate.mjs', count: 1, reason: "gate.mjs's own write(entity, cur, …) helper rewrites a document it just read",
    calls: { helper: 'write', local: 'modules/M6-merge-gate/gate.mjs', entityArg: 0, actor: 'merge_gate', modes: ['update'] } },
  { file: 'modules/M6-merge-gate/merge-outcome.mjs', count: 1, reason: "settleMerge's own write(entity, cur, …) helper rewrites a merge or card it just read (#68)",
    calls: { helper: 'write', local: 'modules/M6-merge-gate/merge-outcome.mjs', entityArg: 0, actor: 'merge_gate', modes: ['update'] } },
  { file: 'modules/M2-approvals/ask-store.mjs', count: 1, reason: 'writeDoc(record, entity, cur, doc), M2\'s one writer of asks and gos (cur = null creates)',
    calls: { helper: 'writeDoc', module: 'modules/M2-approvals/ask-store.mjs', entityArg: 1, actor: 'approvals', modes: ['create', 'update'] } },
  { file: 'modules/M11-dispatcher/moves.mjs', count: 1, reason: 'move(rec, entity, id, patch) re-reads the document and writes it as the dispatcher',
    calls: { helper: 'move', module: 'modules/M11-dispatcher/moves.mjs', entityArg: 1, actor: 'dispatcher', modes: ['update'] } },
]);

// Writes the real Record refuses today and another lane is changing, pinned by file and enclosing function (L118 m6).
// The test prints each one (never a silent skip), and fails once one of them is gone or allowed, so the entry is taken
// off with the fix.
// Empty since main 5a4fdba: lane 2 fixed the last seven (L112-3, L114-1, L114-2, L118-2).
export const PENDING = Object.freeze([
]);

// Grants in permissions.mjs that no scanned write uses, each with why it is still there (L118 m1). AI roles never call
// write(): their files come in through the outbox (M9 writer.mjs applyOutbox, kinds in shared OUTBOX_KINDS).
export const UNUSED_GRANTS = Object.freeze([
  { grant: 'card lead create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'card lead update', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'card worker update', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'verdict reviewer create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'verdict auditor create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'handoff lead create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'handoff learning create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report worker create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report reviewer create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report scout create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report writer create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report thinking create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report script create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report front_door create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'report incident create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'lesson learning create', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call' },
  { grant: 'lesson learning update', reason: 'an AI role: its documents come in through its outbox (M9 writer.mjs applyOutbox), never a write() call; learning is Phase 1, so no learning session starts in 0b' },
  { grant: 'card workshop update', reason: 'no module writes this yet (M4 sets the head on a card after a push); kept as the design\'s row, listed to the lead as a candidate to drop until it is built' },
  { grant: 'card approvals update', reason: 'no module writes this yet (M2 sets or clears needs_joe, approval_required and cancel_reason); kept as the design\'s row, listed to the lead as a candidate to drop until it is built' },
  { grant: 'session dispatcher create', reason: 'no module writes this yet (M11 records a session it starts); kept as the design\'s row, listed to the lead as a candidate to drop until it is built' },
  { grant: 'session workshop update', reason: 'no module writes this yet (M4 updates the session it runs), but moves.mjs gives every session move to the Workshop (preparing → running, running → waiting, reporting, stuck, recycling, ended), so dropping it would forbid every session move; kept, and flagged to the lead (L129)' },
  { grant: 'product approvals create', reason: 'no module writes this yet (M2 adds a product); kept as the design\'s row, listed to the lead as a candidate to drop until it is built' },
  { grant: 'product approvals update', reason: 'no module writes this yet (M2 changes a product); kept as the design\'s row, listed to the lead as a candidate to drop until it is built' },
  { grant: 'fact live_check create', reason: 'no module writes this yet (M7 live check has only its README); kept as the design\'s row, listed to the lead as a candidate to drop until it is built' },
  { grant: 'fact live_check update', reason: 'no module writes this yet (M7 live check has only its README); #68 gave live_check OWN_FACTS but no family, so it can create nothing and so update nothing' },
]);

const LITERAL = /^'([a-z_]+)'$/;
const STORE = 'modules/M9-record/store.mjs';

// Source with comment text blanked, keeping line numbers and string contents (or, with { strings: true }, blanking
// those too, quotes kept, so a word inside a string is never read as code).
export function stripComments(src, { strings = false } = {}) {
  let out = ''; let i = 0; let q = null;
  const keep = (x) => (strings && x !== '\n' ? ' ' : x);
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1];
    if (q) {
      if (c === '\\') { out += keep(c) + keep(d ?? ''); i += 2; continue; }
      if (c === q) { q = null; out += c; i++; continue; }
      out += keep(c); i++; continue;
    }
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

// Where an arrow's expression body ends: the first `;` or `,` at its own depth, or the bracket that closes around it.
function exprEnd(s, at) {
  let depth = 0; let q = null;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) { if (depth === 0) return i; depth--; }
    else if ((c === ';' || c === ',') && depth === 0) return i;
  }
  return s.length;
}

// Every named function's [name, start, end] span: function declarations, `const f = (…) =>` arrows and methods.
function functionSpans(s) {
  const spans = [];
  const heads = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g,
    /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g,
  ];
  for (const re of heads) {
    for (const m of s.matchAll(re)) {
      if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(m[1])) continue;
      const end = m.index + m[0].length;
      if (s[end - 1] === '{') { const body = objectAt(s, end - 1); if (body) spans.push([m[1], m.index, end - 1 + body.length]); continue; }
      if (s[end] === '{') { const body = objectAt(s, end); if (body) spans.push([m[1], m.index, end + body.length]); continue; }
      spans.push([m[1], m.index, exprEnd(s, end)]);
    }
  }
  return spans;
}
const enclosing = (spans, at) => spans.filter(([, a, b]) => a <= at && at < b).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;

// A spread after the actor, entity, id or expectRev can replace them, so the scan can't trust the literal it read
// (#91 r2 audit N1). A spread is fine only before all four.
const FIXED_KEYS = ['actor', 'entity', 'id', 'expectRev'];
export function lateSpread(obj) {
  let seen = false;
  for (const p of topParts(obj)) {
    if (p.startsWith('...')) { if (seen) return true; continue; }
    const k = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(p)?.[1];
    if (FIXED_KEYS.includes(k)) seen = true;
  }
  return false;
}

// Top-level `key: value` and shorthand properties of an object literal's text.
export function topProps(obj) {
  const props = {};
  for (const p of topParts(obj)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(p);
    if (m) props[m[1]] = m[2].trim();
    else if (/^[A-Za-z_$][\w$]*$/.test(p)) props[p] = p;   // shorthand: a variable of that name
  }
  return props;
}

// The top-level parts of an object literal's text, trimmed, empty ones dropped.
function topParts(obj) {
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
  return parts.map((x) => x.trim()).filter(Boolean);
}

// `0` creates; a read document's own rev (`x.rev`, `x?.rev`) updates; anything else may do either (L118 m4).
export function modesOf(expectRev) {
  if (expectRev === undefined) return null;
  const e = expectRev.replace(/\s+/g, '');
  if (e === '0') return ['create'];
  if (/^[A-Za-z_$][\w$]*\??\.rev$/.test(e)) return ['update'];
  return ['create', 'update'];
}

const lineOf = (s, at) => s.slice(0, at).split('\n').length;

// What a file imports from `module` (a path under orchestrate/): local names of `name`, and imports the scan can't follow.
export function importsOf(file, src, module, name) {
  const s = stripComments(src); const locals = []; const blind = [];
  const target = (spec) => spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(file), spec)) === module;
  for (const m of s.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (!target(m[3])) continue;
    for (const part of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      const p = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (p && p[1] === name) locals.push(p[2] ?? p[1]);
    }
  }
  for (const m of s.matchAll(/\bimport\s*\*\s*as\s+[A-Za-z_$][\w$]*\s*from\s*(['"])([^'"]+)\1/g)) if (target(m[2])) blind.push(`${file}:${lineOf(s, m.index)}: imports all of ${module} under one name; import ${name} by name`);
  for (const m of s.matchAll(/\bexport\s*(?:\*|\{[^}]*\})\s*from\s*(['"])([^'"]+)\1/g)) if (target(m[2])) blind.push(`${file}:${lineOf(s, m.index)}: passes on ${module}; import it where it is used`);
  for (const m of s.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const spec = /^(['"`])([^'"`]+)\1$/.exec(m[1].trim())?.[2];
    if (spec === undefined ? m[1].includes(posix.basename(module)) : target(spec) || spec.endsWith(posix.basename(module))) blind.push(`${file}:${lineOf(s, m.index)}: a dynamic import of ${module}, which the scan can't follow`);
  }
  return { locals, blind };
}

// The uses of `write` that are not a plain `<x>.write(` call, as [line, form] (L118 m2).
function otherForms(s, b) {
  const out = [];
  for (const m of s.matchAll(/\[\s*(['"`])write\1\s*\]/g)) out.push([lineOf(s, m.index), "['write']"]);
  for (const m of b.matchAll(/\b(?:const|let|var)\s*\{[^}]*\bwrite\b[^}]*\}\s*=/g)) out.push([lineOf(b, m.index), 'write taken out by destructuring']);
  for (const m of b.matchAll(/(\??\.)\s*write\b/g)) {
    const post = b.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (m[0] === `${m[1]}write` && post.startsWith('(')) continue;            // the plain call the scan reads
    if (/^\s*\.\s*(call|apply|bind)\b/.test(post)) { out.push([lineOf(b, m.index), `write.${/^\s*\.\s*(\w+)/.exec(post)[1]}`]); continue; }
    if (/^\s*\.\s*[A-Za-z_$]/.test(post)) continue;                          // a property of a `write` field: data
    if (/^\s*\?\.\s*\(/.test(post)) { out.push([lineOf(b, m.index), 'write?.(']); continue; }
    if (/^\s+\(/.test(post) || m[0] !== `${m[1]}write`) { out.push([lineOf(b, m.index), 'write with a space before the call']); continue; }
    out.push([lineOf(b, m.index), 'write handed on as a value']);
  }
  return out;
}

export function scanSources(files) {
  const sites = []; const problems = []; const variable = new Map(); const notObject = new Map(); const forms = new Map();
  const spansOf = new Map();
  for (const { file, src } of files) {
    const s = stripComments(src); const b = stripComments(src, { strings: true });
    const spans = functionSpans(b); spansOf.set(file, spans);
    const consts = new Map([...s.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*'([a-z_]+)'\s*;/g)].map((m) => [m[1], m[2]]));
    const resolve = (v) => (v === undefined ? null : LITERAL.exec(v)?.[1] ?? consts.get(v) ?? null);
    for (const m of s.matchAll(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.write\(\s*/g)) {
      if (b.slice(m.index, m.index + m[0].length) !== m[0]) continue;   // inside a string
      const receiver = m[1].replace(/\?\./g, '.'); const at = m.index + m[0].length; const line = lineOf(s, m.index);
      if (notRecord(file, receiver)) continue;
      if (s[at] !== '{') { const k = `${file}|${receiver}`; notObject.set(k, [...(notObject.get(k) ?? []), line]); continue; }
      const obj = objectAt(s, at);
      if (!obj) { problems.push(`${file}:${line}: a write whose object never closes`); continue; }
      const props = topProps(obj);
      if (!('actor' in props) && !('entity' in props)) { const k = `${file}|${receiver}`; notObject.set(k, [...(notObject.get(k) ?? []), line]); continue; }
      if (lateSpread(obj)) { problems.push(`${file}:${line}: a spread after the actor, entity, id or expectRev can replace them; put it first`); continue; }
      const actor = resolve(props.actor); const entity = resolve(props.entity); const modes = modesOf(props.expectRev);
      if (!modes) { problems.push(`${file}:${line}: a Record write with no expectRev`); continue; }
      if (actor && entity) { sites.push({ file, line, fn: enclosing(spans, m.index), actor, entity, modes }); continue; }
      variable.set(file, [...(variable.get(file) ?? []), line]);
    }
    const other = otherForms(s, b);
    if (other.length) forms.set(file, other);
    // M9's store commits a transaction without the writer's checks, so only M9 may load it (#91 r2 audit N9).
    // Any import or re-export form, static or dynamic, whose path is that file.
    if (!file.startsWith('modules/M9-record/')) {
      const hit = [...s.matchAll(/\b(?:import|export)\b[^;'"`]*?from\s*(['"])([^'"]+)\1|\bimport\s*\(\s*(['"`])([^'"`]+)\3|\bimport\s*(['"])([^'"]+)\5/g)]
        .find((m) => { const spec = m[2] ?? m[4] ?? m[6]; return spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(file), spec)) === STORE; });
      if (hit) problems.push(`${file}:${lineOf(s, hit.index)}: imports M9's store.mjs, which skips the Store Writer's checks; only M9 may`);
    }
  }
  for (const [k, lines] of notObject) {
    const [file, receiver] = k.split('|');
    const named = NOT_OBJECT_SITES.find((x) => x.file === file && x.receiver === receiver);
    if (!named) problems.push(`${file}:${lines.join(',')}: ${receiver}.write( with no object literal is not on NOT_OBJECT_SITES`);
    else if (named.count !== lines.length) problems.push(`${file}: ${lines.length} ${receiver}.write( sites, NOT_OBJECT_SITES says ${named.count}`);
  }
  for (const named of NOT_OBJECT_SITES) if (!notObject.has(`${named.file}|${named.receiver}`) && files.some((f) => f.file === named.file)) problems.push(`${named.file}: NOT_OBJECT_SITES names ${named.receiver}.write( but the file has none; take it off`);
  for (const [file, list] of forms) {
    const named = OTHER_FORMS.find((x) => x.file === file);
    if (!named) problems.push(`${file}:${list.map(([l, f]) => `${l} (${f})`).join(', ')}: a use of write the scan can't read, not on OTHER_FORMS`);
    else if (named.count !== list.length) problems.push(`${file}: ${list.length} other uses of write (${list.map(([l, f]) => `${l} ${f}`).join(', ')}), OTHER_FORMS says ${named.count}`);
  }
  for (const named of OTHER_FORMS) if (!forms.has(named.file) && files.some((f) => f.file === named.file)) problems.push(`${named.file}: on OTHER_FORMS but has no other use of write; take it off`);
  for (const [file, lines] of variable) {
    const named = VARIABLE_SITES.find((x) => x.file === file);
    if (!named) { problems.push(`${file}:${lines.join(',')}: a Record write whose actor or entity is not a literal, and not on VARIABLE_SITES`); continue; }
    if (named.count !== lines.length) problems.push(`${file}: ${lines.length} variable write sites, VARIABLE_SITES says ${named.count}`);
  }
  for (const named of VARIABLE_SITES) {
    if (!files.some((f) => f.file === named.file)) continue;
    if (!variable.has(named.file)) { problems.push(`${named.file}: on VARIABLE_SITES but has no variable write; take it off`); continue; }
    for (const p of named.pairs ?? []) sites.push({ file: named.file, line: variable.get(named.file)[0], fn: null, ...p, via: named.reason });
    for (const mk of named.makers ?? []) problems.push(...makerProblems(files, mk, (named.pairs ?? []).map((p) => p.actor)));
    if (!named.calls) continue;
    const c = named.calls;
    for (const { file, src } of files) {
      let names;
      if (c.local) names = file === c.local ? [c.helper] : [];
      else {
        const imp = importsOf(file, src, c.module, c.helper);
        problems.push(...imp.blind);
        names = file === c.module ? [c.helper, ...imp.locals] : imp.locals;
      }
      if (!names.length) continue;
      const s = stripComments(src, { strings: true }); const raw = stripComments(src); const spans = spansOf.get(file) ?? functionSpans(s);
      for (const local of new Set(names)) {
        const all = [...s.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))].filter((m) => !/function\s*$/.test(s.slice(0, m.index)));
        let lit = 0;
        for (const m of all) {
          const e = (c.entityArg === 0 ? /^\s*\(\s*'([a-z_]+)'/ : /^\s*\(\s*[^,()]+,\s*'([a-z_]+)'/).exec(raw.slice(m.index + local.length));
          if (!e) continue;
          lit++;
          sites.push({ file, line: lineOf(s, m.index), fn: enclosing(spans, m.index), actor: c.actor, entity: e[1], modes: c.modes, via: `${c.helper}()` });
        }
        if (all.length !== lit) problems.push(`${file}: ${all.length - lit} ${local}( call(s) without a literal entity; the scan cannot say what they write`);
        // The helper itself handed on as a value can't be followed either.
        for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\b(?!\\s*\\()`, 'g'))) {
          // From the statement's start, not a fixed 40 characters: a long import list (M2 undo-flag.mjs:43) is still an import (L151).
          const before = s.slice(Math.max(0, s.lastIndexOf(";", m.index) + 1, s.lastIndexOf("\n\n", m.index)), m.index);
          if (/\bimport\s*\{[^}]*$/.test(before) || /\bas\s+$/.test(before) || /function\s*$/.test(before) || /\b(?:const|let)\s+$/.test(before)) continue;
          problems.push(`${file}:${lineOf(s, m.index)}: ${local} is handed on as a value, so the scan can't see what it writes`);
        }
      }
    }
  }
  return { sites, problems };
}

// Each call of a fact-writer maker must name an actor the pairs list, or rely on its default (L118 m5).
function makerProblems(files, { helper, module, fallback }, actors) {
  const problems = [];
  if (!actors.includes(fallback)) problems.push(`${module}: ${helper}'s default actor ${fallback} is not one of ${actors.join(', ')}`);
  for (const { file, src } of files) {
    const imp = importsOf(file, src, module, helper);
    problems.push(...imp.blind);
    const names = file === module ? [helper, ...imp.locals] : imp.locals;
    const s = stripComments(src); const b = stripComments(src, { strings: true });
    for (const local of new Set(names)) {
      for (const m of b.matchAll(new RegExp(`(?<![\\w$.])${local}\\s*\\(`, 'g'))) {
        if (/function\s*$/.test(b.slice(0, m.index))) {
          // The definition: its own default actor.
          const d = new RegExp(`\\bactor\\s*=\\s*'([a-z_]+)'`).exec(s.slice(m.index, m.index + 300));
          if (d && !actors.includes(d[1])) problems.push(`${file}:${lineOf(s, m.index)}: ${helper} defaults to actor ${d[1]}, not one of ${actors.join(', ')}`);
          continue;
        }
        const args = objectAt(s, m.index + m[0].length - 1);
        const opts = args && /\{[\s\S]*\}/.exec(args.slice(1, -1));
        const o = opts ? objectAt(opts[0], 0) : null;
        const actor = o ? topProps(o).actor : undefined;
        const where = `${file}:${lineOf(s, m.index)}`;
        if (actor === undefined) continue;
        const lit = LITERAL.exec(actor)?.[1];
        if (lit) { if (!actors.includes(lit)) problems.push(`${where}: ${helper} with actor ${lit}, not one of ${actors.join(', ')}`); continue; }
        // Only alerts.mjs forwards its own actor, which its callers name and this same check reads.
        if (!(file === 'modules/M13-ledger/alerts.mjs' && helper === 'makeFactWriter' && actor === 'actor')) problems.push(`${where}: ${helper} with actor ${actor}, which the scan can't name`);
      }
    }
  }
  return problems;
}

export function checkSites(sites, allowed = fieldsAllowed) {
  const refused = [];
  for (const site of sites) for (const mode of site.modes) {
    if (allowed(site.entity, site.actor, { create: mode === 'create' }) === null) refused.push({ site, mode, why: `${site.actor} may not ${mode} ${site.entity}` });
  }
  return refused;
}

// Every grant in the table, as `entity actor mode`.
export function grants(writers = WRITERS) {
  const out = [];
  for (const [entity, rows] of Object.entries(writers)) for (const [actor, row] of Object.entries(rows)) {
    if (row.create !== undefined) out.push(`${entity} ${actor} create`);
    if (row.update !== undefined || row.updateInDraft !== undefined) out.push(`${entity} ${actor} update`);
  }
  return out;
}

export function grantUse(sites, writers = WRITERS, unusedList = UNUSED_GRANTS) {
  const used = new Set(sites.flatMap((s) => s.modes.map((m) => `${s.entity} ${s.actor} ${m}`)));
  const listed = new Set(unusedList.map((u) => u.grant));
  const unused = grants(writers).filter((g) => !used.has(g) && !listed.has(g));
  const staleUnused = unusedList.filter((u) => used.has(u.grant) || !grants(writers).includes(u.grant)).map((u) => u.grant);
  return { unused, staleUnused };
}

// Every module under orchestrate/ the scan reads: .mjs, .js and .cjs files that are not tests, and any test helper a
// non-test file imports (that one runs in production too, L118 m2).
export function moduleSources(root) {
  const all = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|cjs)$/.test(name) || /\.test\.(mjs|js|cjs)$/.test(name)) continue;
      all.push({ file: relative(root, p).split(sep).join('/'), src: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return productionOnly(all);
}

// Drops test helpers that no production file imports (directly or through another production helper).
export function productionOnly(all) {
  const isHelper = (f) => /\.test-helper\.(mjs|js|cjs)$/.test(f);
  const keep = new Set(all.filter((f) => !isHelper(f.file)).map((f) => f.file));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of all) {
      if (!keep.has(f.file)) continue;
      for (const m of stripComments(f.src).matchAll(/\b(?:from|import)\s*\(?\s*(['"])(\.[^'"]+)\1/g)) {
        const target = posix.normalize(posix.join(posix.dirname(f.file), m[2]));
        if (!keep.has(target) && all.some((x) => x.file === target)) { keep.add(target); grew = true; }
      }
    }
  }
  return all.filter((f) => keep.has(f.file));
}

// Splits refusals into the ones a PENDING entry names (with that entry) and the rest; and the PENDING entries no
// longer matched exactly (gone, allowed, or a different count).
export function splitPending(refused, pending = PENDING) {
  const open = []; const held = new Map();
  for (const r of refused) {
    const p = pending.find((x) => x.file === r.site.file && x.fn === r.site.fn && x.actor === r.site.actor && x.entity === r.site.entity);
    if (!p) { open.push(r); continue; }
    const k = pending.indexOf(p); held.set(k, [...(held.get(k) ?? []), r]);
  }
  const stale = [];
  pending.forEach((p, k) => {
    const n = new Set((held.get(k) ?? []).map((r) => r.site.line)).size;
    if (n !== p.count) stale.push(`${p.name}: ${p.file} ${p.fn}() ${p.actor} → ${p.entity} expects ${p.count} refused site(s), found ${n}; update the list`);
  });
  return { open, held: [...held].map(([k, rs]) => ({ entry: pending[k], refused: rs })), stale };
}

