// repair-plain.mjs — is a data-repair file made only of plain statements? (spec review 0b-9, M8 and r2-m4; R-0b-97.)
//
// WHY. A repair file changes live data, and Joe approves it by reading it. "What Joe reads is what runs" (D13) only
// holds if the file cannot hide a program: a procedural block, a psql command, a COPY … PROGRAM, a function whose
// body does something else. So this is an ALLOW-LIST, not a list of bad words: a statement passes only if every
// piece of it is something we recognise as plain. Anything we can't read is refused. One pure module, used by M10's
// classifier before the merge and by the repair job after it, so the two can't disagree.
//
//   checkRepairFiles(files, policy) → { ok, refused: [{ path, reason }] }
//       files = [{ path, previous_path?, status, text? }]; only files touching the policy's repair folder are judged.
//   checkRepairSql(text, { maxStatements, allowedFunctions }) → { ok: true, statements } | { ok: false, reason }
//
// REFUSED (M8, r2-m4): a repair-folder file that isn't `.sql`; a repair file that is modified, renamed or copied
// (only files the merge ADDED run); a statement that doesn't start with INSERT, UPDATE, DELETE or SELECT (or WITH …
// INSERT/UPDATE/DELETE); a line starting with `\`; dollar-quoting or any other `$`; the words DO, CALL, EXECUTE,
// PREPARE, COPY, LOAD, CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, SET, RESET, BEGIN, COMMIT, ROLLBACK outside a
// literal (SET only as an UPDATE's own SET, DO only as ON CONFLICT DO); more than `repairs.max_statements`
// statements (undeclared = refused); any call `name(` whose name isn't in `repairs.allowed_functions`; an `&` (a
// U&"…" escaped name hides a call); a `(` straight after a quoted value or number.
// Stricter than the spec, to stay closed: a backslash inside a quoted value (on some database settings it moves
// where the value ends); a schema-qualified or quoted function name; `SELECT … INTO` (it creates a table); a psql
// variable (`:name`); an alias column list without AS.
//
// WHAT THIS CANNOT SEE. A trigger, a custom operator or cast, or a column default on the target table runs code
// the file doesn't show. Those are schema, and schema ships only as a migration under the `schema` class, which
// always needs Joe's Approve. The job runs the whole file in one transaction of its own.

import { compileList } from './paths.mjs';

export const DEFAULT_ALLOWED_FUNCTIONS = Object.freeze(['now', 'coalesce', 'lower', 'upper', 'trim', 'count', 'sum',
  'min', 'max', 'round', 'nullif', 'greatest', 'least']);
export const BANNED_WORDS = Object.freeze(['do', 'call', 'execute', 'prepare', 'copy', 'load', 'create', 'alter',
  'drop', 'truncate', 'grant', 'revoke', 'set', 'reset', 'begin', 'commit', 'rollback']);
const VERBS = ['insert', 'update', 'delete', 'select'];
// Words that may stand right before `(` without being a function call.
const NOT_CALLS = new Set(['values', 'in', 'exists', 'any', 'all', 'some', 'on', 'using', 'and', 'or', 'not',
  'select', 'where', 'from', 'join', 'returning', 'by', 'then', 'else', 'when', 'case', 'is', 'like', 'ilike',
  'between', 'distinct', 'lateral', 'union', 'intersect', 'except', 'having', 'limit', 'offset', 'set', 'row',
  'filter', 'over', 'conflict', 'materialized', 'as']);

class Refused extends Error {}
const no = (why) => { throw new Refused(why); };

export function checkRepairFiles(files, policy) {
  const refused = [];
  try {
    if (!Array.isArray(files)) no('no file list');
    const folder = policy?.effect_paths?.production_data?.repair_folder;
    const inFolder = compileList(Array.isArray(folder) ? folder : folder == null ? [] : [folder]);
    const opts = repairOptions(policy);
    for (const f of files) {
      if (!f || typeof f !== 'object' || typeof f.path !== 'string') { refused.push({ path: String(f?.path), reason: 'bad file entry' }); continue; }
      const touches = inFolder(f.path) || (f.previous_path !== undefined && inFolder(f.previous_path));
      if (!touches || f.status === 'removed') continue;      // a removed repair file runs nothing (the `deletes` class judges it)
      const why = fileProblem(f, opts);
      if (why) refused.push({ path: f.path, reason: why });
    }
  } catch (e) {
    refused.push({ path: '*', reason: e instanceof Refused ? e.message : `unreadable: ${e.message}` });
  }
  return { ok: refused.length === 0, refused };
}

// The two rules keys, read fail-closed: no declared statement limit means no repair file passes.
export function repairOptions(policy) {
  const r = policy?.repairs;
  const max = r?.max_statements;
  const fns = r?.allowed_functions;
  return {
    maxStatements: Number.isSafeInteger(max) && max > 0 ? max : null,
    allowedFunctions: Array.isArray(fns) ? fns : DEFAULT_ALLOWED_FUNCTIONS,
  };
}

function fileProblem(f, opts) {
  if (!/\.sql$/.test(f.path)) return 'not a .sql file (a repair file must be plain SQL, never app code)';
  if (f.status !== 'added') return `a repair file that is ${f.status ?? 'unknown'}, not added (only added files run)`;
  if (typeof f.text !== 'string') return 'file text not given';
  const r = checkRepairSql(f.text, opts);
  return r.ok ? null : r.reason;
}

export function checkRepairSql(text, { maxStatements, allowedFunctions } = {}) {
  try {
    if (typeof text !== 'string') no('not text');
    if (!Number.isSafeInteger(maxStatements) || maxStatements < 1) no('repairs.max_statements is not declared');
    const allowed = new Set((Array.isArray(allowedFunctions) ? allowedFunctions : DEFAULT_ALLOWED_FUNCTIONS).map(String));
    text.split(/\r\n|\r|\n/).forEach((line, i) => { if (/^\s*\\/.test(line)) no(`line ${i + 1} starts with \\ (a psql command)`); });
    const statements = split(tokenize(text));
    if (!statements.length) no('no statements');
    if (statements.length > maxStatements) no(`${statements.length} statements, more than repairs.max_statements (${maxStatements})`);
    statements.forEach((s, i) => checkStatement(s, i + 1, allowed));
    return { ok: true, statements: statements.length };
  } catch (e) {
    return { ok: false, reason: e instanceof Refused ? e.message : `unparseable: ${e.message}` };
  }
}

// Tokens: { t: 'word' | 'qident' | 'lit' | 'num' | 'punct', v, depth }. Comments are dropped. Anything the
// tokenizer doesn't recognise is refused rather than skipped.
function tokenize(s) {
  const out = [];
  let i = 0; let depth = 0;
  const push = (t, v) => out.push({ t, v, depth });
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {                   // block comments nest, as in Postgres
      let n = 1; i += 2;
      while (n > 0) {
        if (i >= s.length) no('unparseable: a comment is never closed');
        if (s[i] === '/' && s[i + 1] === '*') { n++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { n--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'") {
      let j = i + 1; let v = '';
      for (;;) {
        if (j >= s.length) no('unparseable: a quoted value is never closed');
        if (s[j] === '\\') no('a backslash inside a quoted value');
        if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
        v += s[j++];
      }
      push('lit', v); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let v = '';
      for (;;) {
        if (j >= s.length) no('unparseable: a quoted name is never closed');
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += s[j++];
      }
      if (v === '') no('unparseable: an empty quoted name');
      push('qident', v); i = j + 1; continue;
    }
    if (c === '$') no('a $ outside a quoted value (dollar-quoting or a parameter)');
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      if (s[j] === '$') no('a $ outside a quoted value (dollar-quoting or a parameter)');
      push('word', s.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let j = i; while (j < s.length && /[0-9.eE]/.test(s[j])) j++;
      push('num', s.slice(i, j)); i = j; continue;
    }
    if (c === ':' && s[i + 1] === ':') { push('punct', '::'); i += 2; continue; }
    if (c === ':' && /[A-Za-z_'"{]/.test(s[i + 1] ?? '')) no('a psql variable (:name)');
    if (c === '(') { push('punct', '('); depth++; i++; continue; }
    if (c === ')') { if (--depth < 0) no('unparseable: a ) with no ('); push('punct', ')'); i++; continue; }
    if (c === '&') no('an & outside a quoted value (a U& escaped name, or a bitwise operator)');
    if (/[;,.=<>!+\-*/%|^~\[\]:]/.test(c)) { push('punct', c); i++; continue; }
    no(`unparseable: unexpected character ${JSON.stringify(c)}`);
  }
  if (depth !== 0) no('unparseable: a ( is never closed');
  return out;
}

function split(tokens) {
  const out = []; let cur = [];
  for (const tok of tokens) {
    if (tok.t === 'punct' && tok.v === ';') { if (cur.length) out.push(cur); cur = []; } else cur.push(tok);
  }
  if (cur.length) out.push(cur);
  return out;
}

const isWord = (tok, w) => tok?.t === 'word' && tok.v.toLowerCase() === w;
const isPunct = (tok, v) => tok?.t === 'punct' && tok.v === v;

function checkStatement(toks, n, allowed) {
  const where = `statement ${n}`;
  const first = toks[0];
  const lead = first.t === 'word' ? first.v.toLowerCase() : null;
  // Depth-0 position where the CTE list ends and the main statement starts.
  let mainAt = 0;
  if (lead === 'with') {
    mainAt = toks.findIndex((t, i) => i > 0 && t.depth === 0 && t.t === 'word' && VERBS.includes(t.v.toLowerCase()));
    if (mainAt < 0) no(`${where}: WITH without a main statement`);
    if (isWord(toks[mainAt], 'select')) no(`${where}: WITH must lead to INSERT, UPDATE or DELETE`);
  } else if (!VERBS.includes(lead)) {
    no(`${where} starts with ${JSON.stringify(first.v)}, not INSERT, UPDATE, DELETE or SELECT`);
  }
  const conflictAt = toks.findIndex((t, i) => isWord(t, 'conflict') && isWord(toks[i - 1], 'on'));

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prev = toks[i - 1];
    if (tok.t === 'word') {
      const w = tok.v.toLowerCase();
      if (w === 'into' && !isWord(prev, 'insert')) no(`${where}: INTO is allowed only in INSERT INTO (SELECT … INTO creates a table)`);
      if (BANNED_WORDS.includes(w) && !allowedHere(w, toks, i, conflictAt)) no(`${where}: ${w.toUpperCase()} is not allowed in a repair file`);
    }
    // A `(` straight after a quoted value or number is a call by another spelling (U&"name" UESCAPE '!' (…)).
    if (isPunct(tok, '(') && (prev?.t === 'lit' || prev?.t === 'num')) no(`${where}: a ( after a value is not allowed`);
    if (isPunct(tok, '(') && prev && (prev.t === 'word' || prev.t === 'qident')) {
      if (prev.t === 'word' && NOT_CALLS.has(prev.v.toLowerCase()) && keywordHere(prev.v.toLowerCase(), toks, i - 1)) continue;
      if (columnList(toks, i - 1, lead === 'with' ? mainAt : -1)) continue;
      const name = prev.t === 'word' ? prev.v.toLowerCase() : null;
      if (isPunct(toks[i - 2], '.')) no(`${where}: a schema-qualified call ${prev.v}(…) is not allowed`);
      if (name === null) no(`${where}: a call through a quoted name "${prev.v}"(…) is not allowed`);
      if (!allowed.has(name)) no(`${where}: ${name}(…) is not in repairs.allowed_functions`);
    }
  }
}

// Some words in NOT_CALLS are also legal function names; they count as the keyword only where the keyword can stand.
function keywordHere(w, toks, k) {
  const before = toks[k - 1];
  if (w === 'filter' || w === 'over') return isPunct(before, ')');
  if (w === 'conflict') return isWord(before, 'on');
  if (w === 'materialized') return isWord(before, 'as') || isWord(before, 'not');
  return true;
}

// SET only as an UPDATE's own SET (an UPDATE at the same depth with no SET since); DO only as ON CONFLICT … DO.
function allowedHere(w, toks, i, conflictAt) {
  const depth = toks[i].depth;
  if (w === 'set') {
    for (let j = i - 1; j >= 0; j--) {
      if (toks[j].depth !== depth) continue;
      if (isWord(toks[j], 'set')) return false;
      if (isWord(toks[j], 'update')) return true;
    }
    return false;
  }
  if (w === 'do') {
    return conflictAt >= 0 && conflictAt < i && toks[conflictAt].depth === depth
      && (isWord(toks[i + 1], 'nothing') || (isWord(toks[i + 1], 'update') && isWord(toks[i + 2], 'set')));
  }
  return false;
}

// Is the name at `k` (just before `(`) a column list rather than a call? Three places:
// INSERT INTO name ( / INSERT INTO schema.name ( ; AS name ( ; a CTE name in the WITH list ( WITH name ( / , name ( ).
function columnList(toks, k, mainAt) {
  const before = toks[k - 1];
  if (isWord(before, 'into')) return true;
  if (isPunct(before, '.') && toks[k - 2] && (toks[k - 2].t === 'word' || toks[k - 2].t === 'qident') && isWord(toks[k - 3], 'into')) return true;
  if (isWord(before, 'as')) return true;
  if (mainAt > 0 && k < mainAt && toks[k].depth === 0) {
    if (isWord(before, 'with') || isWord(before, 'recursive') || isPunct(before, ',')) return true;
  }
  return false;
}
