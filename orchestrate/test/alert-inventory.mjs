// alert-inventory.mjs — the alert inventory behind alert-inventory.test.mjs (lead call L135).
//
// L135: a scan that judges "is this answer ignored?" cannot be the gate, so every alert-like call in production code
// goes on ONE list, alert-inventory.json, and each entry carries a status a person gave it (tested, ruled or open).
// This file finds the calls. It aims to miss none, and over-listing is cheap: an extra entry costs one ruling.
//
// An alert-like call is a call to:
//   - an alert name (ALERT_NAMES: alert, outbox, say, tellOnce, notify, raise), `tellThen`, a `safeX` / `tellX` name,
//     or any name with "alert" in it (holdAlert, queueAlert, sendAlerts ...), plain or as a member (`ctx.alert(`,
//     `opts.alert?.(`, `alerts.raise(`, `this.notify(`);
//   - an alias of one: `const tell = ctx.alert`, `{ alert: tell }` in parameters or an object, `import { say as tell }`,
//     `x = alert.bind(...)`;
//   - one handed on as a callback: `.then(alert)`, `.catch(say)`, `forEach(notify)`, `map(alert)`;
//   - a function that holds one of the above, one step out (`via`): a plain call in the same file, or a call to a
//     function imported by name from another orchestrate file. That is the L133 shape: the state is written by the
//     caller, the alert is in the callee.
// Calls inside strings and comments do not count; calls inside a template's ${ } do.
//
// Each entry is pinned by file + function + a short hash of the call's line text (`hash`) and a short hash of the
// whole enclosing function, comments left out (`body`). A change to the call's line, or anywhere in its function,
// changes a pin, so a planted mark nine lines later, a guard moved, or a swap inside one function shows up.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { mask, pairs, blocks, fnAt, namedFnBlockAt, lineOf, ALERT_NAMES, alertSites, wrappers } from './alert-answer-scan.mjs';

export const short = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);
const squash = (t) => t.replace(/\s+/g, ' ').trim();

export const isAlertName = (n) => ALERT_NAMES.includes(n) || n === 'tellThen' || (/alert/i.test(n) && !/^[A-Z0-9_]+$/.test(n));
const NOT_NAMES = new Set(['true', 'false', 'null', 'undefined', 'this']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'yield', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'with']);

// The names that are alerts in one file: the alert names, plus every alias the file makes of one (to a fixed point).
export function alertNamesIn(m) {
  const names = new Set();
  const is = (n) => isAlertName(n) || names.has(n);
  for (let grew = true; grew;) {
    grew = false;
    const add = (n) => { if (n && !NOT_NAMES.has(n) && !KEYWORDS.has(n) && !is(n)) { names.add(n); grew = true; } };
    // import { say as tell } / export { alert as tell }
    for (const x of m.matchAll(/\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}/g)) {
      for (const part of x[1].split(',')) { const y = /^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(part); if (y && is(y[1])) add(y[2]); }
    }
    // const tell = ctx.alert / tell = opts.alert ?? noop / alert.bind(null) / await safeAlert   (a reference, not a call)
    for (const x of m.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*([A-Za-z_$][\w$]*)\b(?!\s*(?:\?\.\s*)?\()/g)) {
      if (is(x[2])) add(x[1]);
    }
    // { alert: tell }, { alert: tell = () => {} }, { notify: sink }
    for (const x of m.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}=)])/g)) if (is(x[1])) add(x[2]);
  }
  return names;
}

// The alert-like calls in one file: [{ at, name, line }]; `isName` says whether a called name is an alert here.
// An alias (`aliases`) counts only as a plain call: `rec.list(` is not the file's `{ alerts: list }`.
function callsIn(m, match, isName, { bareOnly = null, aliases = new Set() } = {}) {
  const out = [];
  for (const x of m.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) {
    const name = x[1];
    if (KEYWORDS.has(name)) continue;
    const member = /\.\s*$|\?\.\s*$/.test(m.slice(Math.max(0, x.index - 3), x.index));
    if (bareOnly ? (member || !bareOnly.has(name)) : (!isName(name) || (member && !isAlertName(name) && aliases.has(name)))) continue;
    const open = m.indexOf('(', x.index + name.length);
    const close = match.get(open);
    if (close === undefined) continue;
    const before = m.slice(Math.max(0, x.index - 12), x.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;   // function alert(
    let k = close + 1; while (k < m.length && /\s/.test(m[k])) k += 1;
    if (m[k] === '{') continue;                          // a method: alert(a) { ... }
    if (/\bnew\s+$/.test(before)) continue;
    out.push({ at: x.index, name });
  }
  // A callback handed on: .then(alert), .catch(say), forEach(notify), map(alert)
  if (!bareOnly) {
    for (const x of m.matchAll(/(?:\.\s*(?:then|catch|finally|forEach|map|filter)|\btellThen)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*[,)]/g)) {
      const last = x[1].split('.').pop().trim();
      if (isName(last) && !/tellThen/.test(x[0])) out.push({ at: x.index + x[0].indexOf(x[1]), name: last, handed: true });
    }
  }
  return out;
}

// What happens to a call's answer: 'returned' (`return alert(x)`, a concise arrow's body), 'dropped' (the call is a
// whole statement: bare, awaited, or the body of an if / else / loop), or 'used' (anything else).
export function fateOf(m, match, at) {
  let s = at;   // back over `obj.`, `obj?.`
  for (;;) {
    let p = s - 1; while (p >= 0 && /\s/.test(m[p])) p -= 1;
    if (m[p] !== '.') break;
    p -= m[p - 1] === '?' ? 2 : 1; while (p >= 0 && /\s/.test(m[p])) p -= 1;
    if (m[p] === ']' || m[p] === ')') { const o = match.get(p); if (o === undefined) break; s = o; continue; }
    let k = p; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1;
    if (k === p) break;
    s = k + 1;
  }
  let p = s - 1; while (p >= 0 && /\s/.test(m[p])) p -= 1;
  let w = ''; { let k = p; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1; w = m.slice(k + 1, p + 1); if (w === 'await' || w === 'void') { p = k; while (p >= 0 && /\s/.test(m[p])) p -= 1; let k2 = p; while (k2 >= 0 && /[\w$]/.test(m[k2])) k2 -= 1; w = m.slice(k2 + 1, p + 1); } }
  const open = m.indexOf('(', at);
  const close = match.get(open);
  let q = (close ?? open) + 1; while (q < m.length && /\s/.test(m[q])) q += 1;
  // Returned as it is (`return alert(x);`, `=> alert(x)`, `return alert(x).then(...)`); `return alert(x) !== false` is used.
  if ((w === 'return' || (m[p] === '>' && m[p - 1] === '=')) && (q >= m.length || ';})],.?'.includes(m[q]) && !(m[q] === '?' && m[q + 1] !== '.'))) return 'returned';
  const ends = q >= m.length || m[q] === ';' || m[q] === '}' || (m[q] === ')' && false);
  if (!ends) return 'used';
  if (p < 0 || ';{}'.includes(m[p]) || w === 'else' || w === 'do' || w === 'try' || w === 'finally') return 'dropped';
  if (m[p] === ')') { const o = match.get(p); let r = (o ?? 0) - 1; while (r >= 0 && /\s/.test(m[r])) r -= 1; let k = r; while (k >= 0 && /[\w$]/.test(m[k])) k -= 1; if (['if', 'for', 'while'].includes(m.slice(k + 1, r + 1))) return 'dropped'; }
  return 'used';
}

// One file's direct alert calls, and the names of its functions that hold one.
function direct(src) {
  const m = mask(src);
  const match = pairs(m);
  const bl = blocks(m, match);
  const aliases = alertNamesIn(m);
  const isName = (n) => isAlertName(n) || aliases.has(n);
  const calls = callsIn(m, match, isName, { aliases });
  // A holder hands its alert's fate to its caller: the answer is dropped (the call is a whole statement) or returned.
  // One that tests the answer itself (`if (alert(x) === false) ...`) decides there, so its callers are not listed.
  const holders = new Set();
  for (const c of calls) { const b = namedFnBlockAt(bl, c.at); if (b && (c.handed || fateOf(m, match, c.at) !== 'used')) holders.add(b.name); }
  // A function named like an alert is an alert itself; it is not also a carrier.
  for (const n of [...holders]) if (isName(n)) holders.delete(n);
  return { m, match, bl, calls, holders };
}

// Relative imports by name: local name -> { from: resolved path relative to the walk root, name }.
function importsOf(m, src, rel) {
  const out = new Map();
  for (const x of src.matchAll(/\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (m.slice(x.index, x.index + 6) !== 'import') continue;   // in a comment or a string
    const from = normalize(join(dirname(rel), x[2])).split('\\').join('/');
    for (const part of x[1].split(',')) {
      const y = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (y) out.set(y[2] ?? y[1], { from, name: y[1] });
    }
  }
  return out;
}

/**
 * The inventory of a set of production files: [{ file, fn, call, hash, body, line, text, via? }], sorted.
 * `files` is [{ rel, src }] with `rel` relative to orchestrate/ and '/'-separated.
 */
export function inventory(files) {
  const info = new Map(files.map((f) => [f.rel, { ...f, ...direct(f.src) }]));
  const out = [];
  for (const f of info.values()) {
    const lines = f.src.split('\n');
    const bodyHash = new Map();
    const bodyOf = (at) => {
      const b = namedFnBlockAt(f.bl, at);
      const key = b ? b.open : -1;
      if (!bodyHash.has(key)) {
        const text = b ? f.src.slice(b.open, b.close + 1) : null;
        bodyHash.set(key, text === null ? null : short(squash(mask(text, { commentsOnly: true }))));
      }
      return bodyHash.get(key);
    };
    const push = (c, via) => {
      const line = lineOf(f.m, c.at);
      const text = squash(lines[line - 1]);
      const hash = short(text);
      const body = bodyOf(c.at) ?? hash;   // a top-level call: its line is its pin
      out.push({ file: f.rel, fn: fnAt(f.bl, c.at), call: c.name, hash, body, line, text, ...(via && { via }) });
    };
    for (const c of f.calls) push(c, null);
    // One step out: a plain call to this file's own holder, or to an imported holder.
    const own = new Set(f.holders);
    const imported = new Map();
    for (const [local, imp] of importsOf(f.m, f.src, f.rel)) {
      const from = info.get(imp.from);
      if (from && from.holders.has(imp.name)) imported.set(local, `${imp.from} ${imp.name}`);
    }
    const bare = new Set([...own, ...imported.keys()]);
    if (!bare.size) continue;
    for (const c of callsIn(f.m, f.match, null, { bareOnly: bare })) {
      const inFn = fnAt(f.bl, c.at);
      if (own.has(c.name) && inFn === c.name) continue;   // a function calling itself
      push(c, imported.get(c.name) ?? `${f.rel} ${c.name}`);
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** The scanner's hints for one file, by line: 'likely' (the old windowed check) or 'possible' (a write anywhere in the function). */
export function hintsFor(src) {
  const hints = new Map();
  for (const s of alertSites(src, { wholeFn: true })) hints.set(s.line, { level: 'possible', why: s.why });
  for (const s of alertSites(src)) hints.set(s.line, { level: 'likely', why: s.why });
  for (const w of wrappers(src)) if (!w.passes) hints.set(`wrapper ${w.fn}`, { level: 'likely', why: `wrapper ${w.fn} loses the answer: ${w.why}` });
  return hints;
}

// The owner of a production file, by LANES.md folder (the lead call overrides go on the entry itself).
export function folderOwner(rel) {
  const top = rel.split('/');
  const mod = top[0] === 'modules' ? top[1].split('-')[0] : top[0];
  if (['M10', 'M9', 'M2', 'M6', 'shared'].includes(mod)) return 'lane 1';
  if (['M4', 'M11'].includes(mod)) return 'lane 2';
  if (['M12', 'M13', 'M1'].includes(mod)) return 'lane 3';
  if (mod === 'setup') return 'lane 4';
  return 'lead';
}

// ---- the statuses ----

export const OWNERS = ['lane 1', 'lane 2', 'lane 3', 'lane 4', 'lead'];
/**
 * Parses one status: { kind: 'tested', file, test } | { kind: 'ruled', call, why } | { kind: 'wrapped', file, fn }
 * | { kind: 'open', owner, pr } | { kind: 'bad', why }. `wrapped: <file> <fn>` (L139 item 4): the call goes through a
 * listed wrapper whose contract test is proven (contractProblems), and the wrapper's `covers` names this call.
 */
export function parseStatus(s) {
  if (typeof s !== 'string') return { kind: 'bad', why: 'status must be a string' };
  let x = /^tested: (\S+\.test\.mjs) > (.+)$/.exec(s);
  if (x) return { kind: 'tested', file: x[1], test: x[2] };
  x = /^ruled: (L\d{1,4}), (.{8,})$/.exec(s);
  if (x) return { kind: 'ruled', call: x[1], why: x[2] };
  x = /^wrapped: (\S+\.mjs) ([A-Za-z_$][\w$]*)$/.exec(s);
  if (x) return { kind: 'wrapped', file: x[1], fn: x[2] };
  x = /^open: (lane [1-4]|lead), (#\d+|none yet)$/.exec(s);
  if (x) return OWNERS.includes(x[1]) ? { kind: 'open', owner: x[1], pr: x[2] } : { kind: 'bad', why: 'unknown owner' };
  return { kind: 'bad', why: 'status must be "tested: <file>.test.mjs > <test name>", "ruled: L<n>, <why>", "wrapped: <file> <fn>" or "open: <lane n|lead>, <#N|none yet>"' };
}

// Does the test named `name` in `src` (a .test.mjs) exist, and run fakeAlert({ answer: false }) and fakeAlert({ throws })?
// Returns null when it does, or why not.
export function testedProblem(src, name) {
  const m = mask(src);
  const match = pairs(m);
  const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``];
  for (const x of m.matchAll(/(?<![\w$.])(?:test|it)\s*\(/g)) {
    const open = m.indexOf('(', x.index);
    const close = match.get(open);
    if (close === undefined) continue;
    const head = src.slice(open + 1, open + 1 + name.length + 4).trimStart();
    if (!quoted.some((q) => head.startsWith(q))) continue;
    const body = m.slice(open, close + 1);
    const raw = src.slice(open, close + 1);
    const calls = [...body.matchAll(/\bfakeAlert\s*\(/g)].map((y) => { const o = open + y.index + y[0].length - 1; return src.slice(o, (match.get(o) ?? o) + 1); });
    const lost = calls.some((c) => /\banswer\s*:\s*false\b/.test(c));
    const threw = calls.some((c) => /\bthrows\s*:/.test(c));
    if (!/from\s+['"][^'"]*fake-alert\.test-helper\.mjs['"]/.test(src)) return 'the file does not import fakeAlert';
    if (!lost || !threw) return `the test must run fakeAlert({ answer: false }) and fakeAlert({ throws: ... }); it runs ${lost ? 'only answer: false' : threw ? 'only throws' : 'neither'}${raw.includes('fakeAlert') ? '' : ' (no fakeAlert in its body)'}`;
    // A todo or skipped test proves nothing: its failure does not fail the run.
    const opts = m.slice(open + 1 + name.length + 2, open + 1 + name.length + 2 + 200).match(/^\s*,\s*\{([^{}]*)\}/);
    if (opts && /\b(?:todo|skip)\s*:\s*(?!false\b)/.test(src.slice(open + 1 + name.length + 2, open + 1 + name.length + 2 + opts[0].length))) return 'the test is a todo or skipped, so it proves nothing yet';
    if (/(?:test|it)\s*\.\s*(?:todo|skip)\s*$/.test(m.slice(Math.max(0, x.index - 2), open))) return 'the test is a todo or skipped, so it proves nothing yet';
    return null;
  }
  return 'no test(...) or it(...) by that name';
}

// ---- wrapper contracts (L139 item 4) ----

/** The body pin of the first function named `fn` in `src` (comments left out), or null when there is none. */
export function fnBody(src, fn) {
  const m = mask(src);
  const b = blocks(m, pairs(m)).find((x) => x.kind === 'fn' && x.name === fn);
  return b ? short(squash(mask(src.slice(b.open, b.close + 1), { commentsOnly: true }))) : null;
}
/** Does `testSrc` (at `testRel`) import `fileRel`? Both relative to orchestrate/. */
export function importsFile(testSrc, testRel, fileRel) {
  for (const x of mask(testSrc, { commentsOnly: true }).matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (normalize(join(dirname(testRel), x[1])).split('\\').join('/') === fileRel) return true;
  }
  return false;
}
/**
 * Why a wrapper's contract is not proven, or [] when it is. Proven: the wrapper names a `contract_test`
 * ("<file>.test.mjs > <name>") that exists, imports the wrapper's file, runs fakeAlert answering false and throwing,
 * and is not a todo; its body pin matches; and every wrapper it calls on (`inner`) is proven too.
 * `read(rel)` returns a file's source under orchestrate/, or null.
 */
export function contractProblems(w, wrappersList, read, seen = new Set()) {
  const id = `${w.file} ${w.fn}`;
  if (seen.has(id)) return [`${id}: its inner wrappers loop`];
  seen.add(id);
  if (!w.contract_test) return [`${id} has no contract_test`];
  const x = /^(\S+\.test\.mjs) > (.+)$/.exec(w.contract_test);
  if (!x) return [`${id}: contract_test must be "<file>.test.mjs > <test name>"`];
  const out = [];
  const src = read(x[1]);
  if (src === null) out.push(`${id}: ${x[1]} does not exist`);
  else {
    if (!importsFile(src, x[1], w.file)) out.push(`${id}: ${x[1]} does not import ${w.file}`);
    const why = testedProblem(src, x[2]);
    if (why) out.push(`${id}: ${x[1]} > ${x[2]}: ${why}`);
  }
  const code = read(w.file);
  if (code === null || fnBody(code, w.fn) === null) out.push(`${id}: no function ${w.fn} in ${w.file}`);
  else if (w.body && fnBody(code, w.fn) !== w.body) out.push(`${id}: the wrapper changed since its contract was pinned (body ${fnBody(code, w.fn)}, list ${w.body})`);
  for (const inner of w.inner ?? []) {
    const v = wrappersList.find((y) => `${y.file} ${y.fn}` === inner);
    if (!v) out.push(`${id}: inner wrapper ${inner} is not on the list`);
    else out.push(...contractProblems(v, wrappersList, read, new Set(seen)));
  }
  return out;
}

// The key that pins an entry: file, function, call line hash, body hash.
export const keyOf = (e) => `${e.file} | ${e.fn} | ${e.hash} | ${e.body}`;

// ---- the files ----

// Test code: a *.test.mjs or *.test-helper.mjs, anything in a fixtures folder or a fixtures file, the test/ folder,
// or a file that imports node:test (shared/test-tmp.mjs). Everything else under orchestrate/ is production code.
export function isTestCode(rel, src) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  return /\.test(?:-helper)?\.mjs$/.test(base) || base.startsWith('fixtures') || parts.includes('fixtures') || parts[0] === 'test'
    || /from\s+['"]node:test['"]/.test(src);
}
/** Every .mjs under `root` (orchestrate/): [{ rel, src, testCode }], `rel` '/'-separated. */
export function orchestrateFiles(root) {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.mjs') ? [p] : []);
  });
  return walk(root).sort().map((p) => {
    const rel = relative(root, p).split(sep).join('/');
    const src = readFileSync(p, 'utf8');
    return { rel, src, testCode: isTestCode(rel, src) };
  });
}

// ---- the list ----

export const LIST = 'test/alert-inventory.json';
export const readList = (root) => JSON.parse(readFileSync(join(root, LIST), 'utf8'));

/**
 * The inventory set against the list: { found, listed, fresh, gone, moved }. `fresh` is found with no listed entry of
 * the same pin; `gone` is listed with no found one. Pins match exactly (===) and as a multiset: two calls on two lines
 * of the same text in one function are two entries. `moved` pairs a fresh entry with a gone one of the same file,
 * function and call: the code changed there, so it needs a fresh look, and its status is a suggestion only.
 */
export function compare(found, listed) {
  const left = new Map();
  for (const e of listed) { const k = keyOf(e); left.set(k, [...(left.get(k) ?? []), e]); }
  const fresh = [];
  for (const e of found) {
    const k = keyOf(e);
    const xs = left.get(k);
    if (xs?.length) xs.shift(); else fresh.push(e);
  }
  const gone = [...left.values()].flat();
  const moved = [];
  const pool = gone.slice();
  for (const e of fresh) {
    const i = pool.findIndex((g) => g.file === e.file && g.fn === e.fn && g.call === e.call && (g.via ?? null) === (e.via ?? null));
    if (i >= 0) moved.push([e, pool.splice(i, 1)[0]]);
  }
  return { found, listed, fresh, gone, moved };
}

// ---- change control (L135 item 4): the list is the lead's ----

export const LEAD_BRANCH = /^(?:claude\/)?lead-/;
// The checker's own files (L139 item 6): only a lead PR changes them. safe-merge.sh refuses them too; this is the second layer.
// raise-contract.test.mjs (the wrapper contracts) and fake-alert.test-helper.mjs (what every contract runs) are added
// here too: a lane that weakens either would weaken every proof that rests on them.
export const LEAD_FILES = Object.freeze(['test/alert-inventory.json', 'test/alert-inventory.mjs', 'test/alert-inventory.test.mjs', 'test/alert-answer-scan.mjs',
  'test/alert-answer.test.mjs', 'test/raise-contract.test.mjs', 'test/fake-alert.test-helper.mjs']);
/** The lead-only files among `changed` (paths relative to the repo root). */
export const leadFilesIn = (changed) => changed.filter((p) => LEAD_FILES.some((f) => p === `orchestrate/${f}`));
const kindOf = (status) => (typeof status === 'string' ? status.split(':')[0] : 'bad');
/** Entries by status kind, and open ones by owner: { alerts: { open, ruled, tested }, open_by_owner: {...}, ... }. */
export function countList(list) {
  const out = {};
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) {
    const c = {};
    for (const e of list[k] ?? []) c[kindOf(e.status)] = (c[kindOf(e.status)] ?? 0) + 1;
    out[k] = c;
  }
  const by = {};
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) for (const e of list[k] ?? []) {
    const s = parseStatus(e.status);
    if (s.kind === 'open') { const o = `${s.owner} ${s.pr}`; by[o] = (by[o] ?? 0) + 1; }
  }
  out.open_by_owner = by;
  return out;
}
/**
 * What a change to the list does, base -> head, and what a PR that is not the lead's may not do: rule an entry (a new
 * `ruled:` status, or a ruled entry's pins or words changed), add a wrapper or rule one, or grow a list's open count
 * (a new alert call that is not tested, a new silent default, a new stand-in). Returns { problems, summary }.
 */
export function changeControl(base, head, { lead }) {
  const problems = [];
  const summary = [];
  const cb = countList(base);
  const ch = countList(head);
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) {
    const a = JSON.stringify(cb[k]); const b = JSON.stringify(ch[k]);
    summary.push(`${k}: ${a === b ? a : `${a} -> ${b}`}`);
  }
  const was = new Map((base.alerts ?? []).map((e) => [keyOf(e), e]));
  const ruledWas = new Set((base.alerts ?? []).filter((e) => kindOf(e.status) === 'ruled').map((e) => `${keyOf(e)} ${e.status}`));
  for (const e of head.alerts ?? []) {
    if (kindOf(e.status) !== 'ruled' || ruledWas.has(`${keyOf(e)} ${e.status}`)) continue;
    const w = was.get(keyOf(e));
    problems.push(`${e.file} ${e.fn} ${e.call}: ${w ? `status "${w.status}" became` : 'a new or re-pinned entry is'} "${e.status}"; only a lead PR rules an entry (L135)`);
  }
  const wrapWas = new Map((base.wrappers ?? []).map((e) => [`${e.file} ${e.fn}`, e]));
  for (const e of head.wrappers ?? []) {
    const w = wrapWas.get(`${e.file} ${e.fn}`);
    if (!w) problems.push(`wrapper ${e.file} ${e.fn} was added; only a lead PR adds a wrapper (L135)`);
    else if (kindOf(e.status) === 'ruled' && w.status !== e.status) problems.push(`wrapper ${e.file} ${e.fn} was ruled; only a lead PR rules one (L135)`);
  }
  for (const k of ['alerts', 'wrappers', 'silent', 'standins']) {
    const a = cb[k].open ?? 0; const b = ch[k].open ?? 0;
    if (b > a) problems.push(`${k}: ${b} open, up from ${a}; a new alert call needs a test that runs fakeAlert({ answer: false }) and fakeAlert({ throws }) ("tested: ..."), or a lead call`);
  }
  return { problems: lead ? [] : problems, would: problems, summary };
}

// `node orchestrate/test/alert-inventory.mjs` prints what the list is missing and what it holds that the code no
// longer has, with the scanner's hints and a suggested status. It changes nothing: the lead writes the list.
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = orchestrateFiles(root);
  const prod = files.filter((f) => !f.testCode);
  const { fresh, gone, moved } = compare(inventory(prod), readList(root).alerts);
  const hints = new Map(prod.map((f) => [f.rel, hintsFor(f.src)]));
  const was = new Map(moved.map(([e, g]) => [e, g]));
  const show = (e) => `${e.file}:${e.line} ${e.fn} ${e.call}${e.via ? ` (via ${e.via})` : ''}\n    ${e.text.slice(0, 140)}`;
  console.log(`${fresh.length} not on the list, ${gone.length} on the list and gone (${moved.length} of them changed in place)\n`);
  for (const e of fresh) {
    const h = hints.get(e.file)?.get(e.line);
    const g = was.get(e);
    console.log(`${g ? 'CHANGED' : 'NEW'}  ${show(e)}`);
    if (h) console.log(`    scanner (${h.level}): ${h.why}`);
    console.log(`    pin: { "file": ${JSON.stringify(e.file)}, "fn": ${JSON.stringify(e.fn)}, "call": ${JSON.stringify(e.call)}, "hash": "${e.hash}", "body": "${e.body}" }`);
    console.log(`    status: ${g ? `was "${g.status}"; look again before keeping it` : `open: ${folderOwner(e.file)}, none yet`}\n`);
  }
  const back = new Set(moved.map(([, g]) => g));
  for (const g of gone) if (!back.has(g)) console.log(`GONE  ${g.file} ${g.fn} ${g.call} (${g.status})\n    ${g.text}\n`);
}
