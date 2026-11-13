// wired.test.mjs — ORCHESTRATE's copy of Bob's templates/wired.test.mjs (L221, L251; Phase Gate 17, Bob D-036): every built unit of work is used by production code, or is listed as
// not wired yet, with the roadmap row that will wire it.
// Run: node --test orchestrate/test/wired.test.mjs. Only CONFIG, UNWIRED and the file rule at the end (L234) differ from the template.
//
// WHY. Unit tests call a piece directly, so a piece that nothing in the running product ever calls still passes
// them. A build can be all green while finished, tested steps sit unused. This test looks from the other end: it
// starts where the product starts and follows the imports.
//
// HOW. Entry points are the files Node runs directly: a `#!… node` first line, a main-module check
// (`process.argv[1]` compared with `import.meta.url` on one line, or in an `if` through variables set from them, an
// `if (isMain(import.meta.url))` helper, `import.meta.main`, or `require.main === module`), the package.json `bin`
// files, and any files you name in CONFIG.ENTRY_FILES (a framework that loads files by convention: routes, handlers,
// workers). The first test prints the list; drop dev-only scripts with CONFIG.NOT_PRODUCTION. From the entry points
// it follows relative `import`, `export … from`, `import()` and `require()` to every reachable file, with comments,
// strings and regex literals ignored. A unit of work is a function, class or value in CONFIG.SOURCE whose name ends
// in one of CONFIG.UNIT_SUFFIXES and that is exported (ES `export`, `module.exports` / `exports.x`, or defined
// inside an exported object). It counts as used when a reachable file other than its own imports it (by name, as a
// default, through a folder that re-exports it, or off `* as NS` / a required or default-exported object) and then
// uses that name, or when its own file is reachable and uses it outside its own body. Listing a name in
// `export { … }`, an exported object or array (nested ones too), or `exports.x = require(…).y` is not a use;
// code in a method or a computed value there is. Anything else must be in UNWIRED with the row that will wire it,
// and an UNWIRED name that is now used fails too, so the list stays true.
//
// LIMITS (checked on Node 26). This is a text scan, not a JavaScript parser. "Used" means a reachable file names it
// in code, not that the line runs on a normal day; the end-to-end test of each capability is what proves that
// (Phase Gate 16). It reads JavaScript files (.mjs, .js, .cjs, plus extensionless `bin` files) and relative paths
// only. For TypeScript, point SOURCE at the compiled output and take 'dist' or 'build' out of SKIP_TOP; for another
// language, write the same check for that stack.
//   Fails loudly (the unit shows as unwired; list it in UNWIRED with a note, or adapt the scan): path aliases
// (`@/x`), the package's own name, an `import()` or `require()` with a computed path, `import('./x').then(…)` and
// `(await import('./x')).y`, `export * as ns from`, a namespace walked as data (`Object.values(ns)`), and a
// main-module check in another shape, such as one split over several lines (the file is then not an entry point).
//   Can pass quietly, so keep units of work out of these shapes: a local variable or parameter with the same name
// as the unit (it reads as a use), and an export the scan does not see at all: `exports['x'] = …`,
// `export const { x } = …`, a unit exported only inside a nested object (`{ handlers: { aHandler } }`), or
// `Object.assign` onto anything but `module.exports`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// What starts without a `node` line of its own. Hooks are run by Claude Code, named in the role settings templates
// (L234). Wiring modules are loaded from the path a config names: each row has its loader and exact call, so a row whose
// call has gone fails, and every such call in production code needs a row (L235).
const TEMPLATES = join(HERE, '..', 'modules', 'M4-workshop', 'launcher', 'templates');
export const HOOK_ENTRIES = [...new Set(readdirSync(TEMPLATES).filter((n) => n.endsWith('.json'))
  .flatMap((n) => [...readFileSync(join(TEMPLATES, n), 'utf8').matchAll(/__orch_hooks__\/([\w.-]+\.mjs)/g)].map((m) => `modules/M4-workshop/hooks/${m[1]}`)))];
export const CONFIG_ENTRIES = Object.freeze([
  { file: 'wiring/dispatcher-wiring.mjs', loader: 'modules/M11-dispatcher/main.mjs', call: 'import(pathToFileURL(config.wiring).href)' },
  { file: 'wiring/robot-wiring.mjs', loader: 'wiring/robot-main.mjs', call: 'import(pathToFileURL(config.wiring).href)' },
  // No file yet: the Sensors job's wiring comes with its plist.
  { file: null, loader: 'modules/M12-sensors/loop.mjs', call: 'import(pathToFileURL(config.wiring).href)', why: 'R-0b-169: the Sensors job wiring not written yet' },
  { file: 'modules/M4-workshop/launcher/review-wiring.mjs', loader: 'modules/M4-workshop/launcher/review-runner-main.mjs', call: 'import(pathToFileURL(c.wiring).href)' },
  // Check 12's budget module (L1001), loaded by both runners from the path their config names.
  { file: 'modules/M11-dispatcher/budget.mjs', loader: 'modules/M4-workshop/launcher/review-runner-main.mjs', call: 'import(pathToFileURL(c.budget).href)' },
  { file: 'modules/M11-dispatcher/budget.mjs', loader: 'wiring/runner-main.mjs', call: 'import(pathToFileURL(file).href)' },
]);

// ── Set these for your project ──────────────────────────────────────────────
export const CONFIG = Object.freeze({
  ROOT: resolve(HERE, '..'), // orchestrate/ (this file sits in orchestrate/test/)
  SOURCE: ['modules', 'shared'], // the units of work live here; wiring/ and setup/ hold entry points and glue
  ENTRY_FILES: [...HOOK_ENTRIES, ...CONFIG_ENTRIES.filter((e) => e.file).map((e) => e.file)],
  NOT_PRODUCTION: [],
  UNIT_SUFFIXES: ['Pass', 'Once', 'Step', 'Sweep', 'Handler'], // Handler: an intake's per-kind handler (#154 audit, L303)
  SKIP_DIRS: ['node_modules', 'fixtures', 'test', 'tests', '__tests__'],
  SKIP_TOP: ['dist', 'build', 'coverage'],
  ROW: /\b(?:L\d+|R-0b-\d+)\b/, // a lead call (L221) or a roadmap row (R-0b-162)
});

// name → why it is not wired yet. Each names the capability row or issue that will give it a running home.
export const UNWIRED = Object.freeze({
  gatePass: 'L221: R-0b-162 wiring, lane 4',
  watchOnce: 'L221: R-0b-162 wiring, lane 4',
  researchCopyPass: 'L286: R-0b-162 wiring beside researchPass, with the push script\'s pushResearch, lane 4',
  proposalRoutePass: 'L549: R-0b-162 wiring beside proposalsPass, with the push script\'s pushProposal and createToReview as its toReview; a toReview wired without this pass leaves cards claimed, lane 4',
});
// ────────────────────────────────────────────────────────────────────────────

const ROOT = CONFIG.ROOT;
const rel = (f) => relative(ROOT, f);
const under = (f, d) => {
  const r = relative(resolve(ROOT, d), f);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const isTest = (f) => /\.(test|spec)\.[cm]?js$|test-helper/.test(f);
const isCode = (f) => /\.[cm]?js$/.test(f);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (CONFIG.SKIP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
    if (dir === ROOT && CONFIG.SKIP_TOP.includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (isCode(e.name) && !isTest(e.name)) out.push(p);
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Where a name is used as code: not a property (`obj.name`, also after a line break), not an object key
// (`{ name: 1 }`) and not an object method (`{ name() { … } }`); a spread (`...name`) is a use.
const uses = (text, name) => [...text.matchAll(new RegExp(`(?<![\\w$])(?<!(?<!\\.\\.)\\.\\s*)${esc(name)}(?![\\w$])`, 'g'))]
  .filter((m) => {
    if (!/[{,]\s*$/.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
    const after = text.slice(m.index + name.length, m.index + name.length + 200);
    return !/^\s*:(?!:)/.test(after) && !/^\s*\([^()]*\)\s*\{/.test(after);
  })
  .map((m) => m.index);

// Two copies of each file, the same length as the source so positions line up:
// `code` has comments blanked (strings kept, so import paths can be read); `bare` also blanks the inside of strings,
// template text and regex literals, so a name inside a message or a comment is never taken for code.
function scrub(src) {
  const code = [];
  const bare = [];
  const n = src.length;
  const sp = (c) => (c === '\n' ? '\n' : ' ');
  const put = (c, b = c) => { code.push(c); bare.push(b); };
  const tpl = []; // brace depth at which each open `${` began
  let depth = 0;
  let i = 0;
  const parens = []; // for each open `(`: does it follow if / while / for / with?
  let ctrlClose = false; // the last `)` closed one of those, so a `/` after it starts a regex: if (s) /x/.test(s)
  const lastCode = () => code.slice(Math.max(0, code.length - 12)).join('');
  const regexCanStart = () => {
    const before = lastCode().replace(/\s+$/, '');
    if (before.endsWith(')')) return ctrlClose;
    if (/(?:\+\+|--)$/.test(before)) return false; // n++ / 2 is a division
    return before === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new)$/.test(before);
  };
  const template = () => { // after an opening backtick, or after the `}` that ends a `${ }`
    while (i < n) {
      const c = src[i];
      if (c === '\\') { put(c, ' '); i++; if (i < n) { put(src[i], sp(src[i])); i++; } continue; }
      if (c === '`') { put(c); i++; return; }
      if (c === '$' && src[i + 1] === '{') { put('$'); put('{'); i += 2; tpl.push(depth); depth++; return; }
      put(c, sp(c)); i++;
    }
  };
  if (src.startsWith('#!')) while (i < n && src[i] !== '\n') { put(' '); i++; }
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { put(' '); i++; } continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      while (i < stop) { put(sp(src[i]), sp(src[i])); i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      put(c); i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { put(src[i], ' '); i++; if (i >= n) break; }
        put(src[i], sp(src[i])); i++;
      }
      if (i < n && src[i] === c) { put(c); i++; }
      continue;
    }
    if (c === '`') { put(c); i++; template(); continue; }
    if (c === '/' && regexCanStart()) {
      put(c, ' '); i++;
      let cls = false;
      while (i < n && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\') { put(r, ' '); i++; if (i < n) { put(src[i], ' '); i++; } continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        put(r, ' '); i++;
      }
      if (i < n && src[i] === '/') { put('/', ' '); i++; }
      continue;
    }
    if (c === '(') parens.push(/(?:^|[^\w$.])(?:if|while|for|with)\s*$/.test(lastCode()));
    if (c === ')') ctrlClose = parens.pop() ?? false;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); put(c); i++; template(); continue; }
    }
    put(c); i++;
  }
  return { code: code.join(''), bare: bare.join('') };
}

const ID = /^[A-Za-z_$][\w$]*$/;
const SUFFIX = new RegExp(`(?:${CONFIG.UNIT_SUFFIXES.map(esc).join('|')})$`);
const blankOut = (s, from, to) => s.slice(0, from) + s.slice(from, to).replace(/[^\n]/g, ' ') + s.slice(to);

// An import path as written → the file it means: as is, then with an extension, then as a folder's index.
function resolveImport(from, spec) {
  const p = resolve(dirname(from), spec);
  for (const c of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, join(p, 'index.js'), join(p, 'index.mjs'), join(p, 'index.cjs')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// `a as b` (ES import/export lists) or `a: b = 1` (destructuring and object literals) → [{ imported, local }]
function parseList(list, sep) {
  const out = [];
  for (let s of list.split(',')) {
    s = s.trim().replace(/^type\s+/, '').replace(/\s*=[\s\S]*$/, '');
    if (!s) continue;
    const [imported, local = imported] = s.split(sep === 'as' ? /\s+as\s+/ : /\s*:\s*/).map((x) => x.trim());
    if (ID.test(imported) && ID.test(local)) out.push({ imported, local });
  }
  return out;
}

function parseClause(clause) { // what an `import … from` binds
  const out = [];
  const ns = clause.match(/\*\s*as\s+([\w$]+)/);
  if (ns) out.push({ imported: '*', local: ns[1] });
  const list = clause.match(/\{([^}]*)\}/);
  if (list) out.push(...parseList(list[1], 'as'));
  const def = clause.trim().match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
  if (def && def[1] !== 'type') out.push({ imported: 'default', local: def[1] });
  return out;
}

const STATIC_IMPORT = /\bimport\s+([^'"`;()]*?)\s*from\s*(['"])(\.{1,2}\/[^'"]+)\2/g;
const SIDE_IMPORT = /\bimport\s*(['"])(\.{1,2}\/[^'"]+)\1/g;
const RE_EXPORT = /\bexport\s+(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])(\.{1,2}\/[^'"]+)\2/g;
const DYNAMIC = /(?:\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?)?\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\2\s*\)/g;
const REQUIRE = /(?:\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?\brequire\(\s*(['"])(\.{1,2}\/[^'"]+)\2\s*\)(?:\s*\.\s*([\w$]+)|\s*(\())?/g;
const CJS_REEXPORT = /\bmodule\.exports\s*=\s*require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)\s*(?:;|\n|$)/g;
const EXPORT_DECL = /\bexport\s+(default\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|(const|let|var)\s+)([A-Za-z_$][\w$]*)/g;
const EXPORT_DEFAULT_NAME = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}(?!\s*from)/g;
// export default { … } / [ … ] · module.exports = { … } · module.exports = Object.freeze({ … }) · Object.assign(module.exports, { … })
const OBJECT_EXPORT = /\b(?:export\s+default|module\.exports\s*=)\s*(?:Object\.freeze\(\s*)?[{[]|\bObject\.assign\(\s*module\.exports\s*,\s*\{/g;
const CJS_PROP_REQ = /(?<![\w$.])(?:module\.)?exports\.([\w$]+)\s*=\s*require\(\s*(['"])(\.{1,2}\/[^'"]+)\2\s*\)\s*\.\s*([\w$]+)(?![\w$]|\s*\()/g;
const CJS_DEFAULT = /\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/g;
const CJS_DEFAULT_DECL = /\bmodule\.exports\s*=\s*(?:async\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)/g;
const CJS_PROP = /(?<![\w$.])(?:module\.)?exports\.([\w$]+)\s*=(?!=)\s*([A-Za-z_$][\w$]*\s*(?:;|\n|$))?/g;

// The index just past the bracket that closes the one at `open` (in bare code, where strings are already blank).
function closeOf(bare, open) {
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if ('([{'.includes(bare[i])) depth++;
    else if (')]}'.includes(bare[i]) && --depth === 0) return i + 1;
  }
  return bare.length;
}
// The entries of an object literal's body, split at its own commas: `a`, `b: c`, `d() { … }` … as { text, at, end },
// where at/end are positions in the file (`base` is where the body starts).
function topLevel(body, base = 0) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c && '([{'.includes(c)) depth++;
    else if (c && ')]}'.includes(c)) depth--;
    else if ((c === ',' && depth === 0) || i === body.length) {
      const raw = body.slice(start, i);
      const text = raw.trim();
      const at = base + start + raw.length - raw.trimStart().length;
      if (text) out.push({ text, at, end: at + text.length });
      start = i + 1;
    }
  }
  return out;
}

// Everything the scan needs about one file.
function analyse(f) {
  const src = readFileSync(f, 'utf8');
  const { code, bare } = scrub(src);
  const real = (m) => bare[m.index] === code[m.index]; // the match starts in code, not inside a string
  const edges = [];
  const bindings = []; // { local, file, imported } — imported is a name, 'default' or '*'
  const reexports = []; // { file, star } or { file, names: Map(exported → imported) }
  const exports = new Map(); // exported name → local name (null when declared inline, e.g. exports.x = function …)
  let usage = bare; // bare code minus import and export-list statements: what is left is where names are used
  const take = (m) => { usage = blankOut(usage, m.index, m.index + m[0].length); };
  const bind = (target, list, cjs) => { for (const b of list) bindings.push({ ...b, file: target, cjs }); };
  // Exported objects and arrays, and `exports.x = require(…).y`: a name listed there is passed on, not used; code in a
  // method or a computed value still is. listed: spans blanked from usage; kept: the code inside them.
  const listed = [];
  const kept = [];
  const scan = (open, close, prefix) => { // prefix: how a top-level entry is exported ('' or 'default.'); null if not
    for (const e of topLevel(bare.slice(open + 1, close - 1), open + 1)) {
      const text = code.slice(e.at, e.end);
      let value = text;
      let key = null;
      if (bare[open] === '{') {
        if (text.startsWith('...')) continue; // a spread passes a whole object on
        const k = text.match(/^(?:(?:async|get|set|static)\s+)?\*?\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*/);
        if (!k) { kept.push([e.at, e.end]); continue; }
        key = k[2];
        const rest = text.slice(k[0].length);
        if (rest === '') { if (prefix !== null) exports.set(prefix + key, key); continue; } // { a }
        if (!rest.startsWith(':')) { // { aJob() { … } }: a unit defined in the object; its body is code
          kept.push([e.at + k[0].length, e.end]);
          if (prefix !== null) exports.set(prefix + key, null);
          continue;
        }
        value = rest.slice(1).trimStart();
      }
      const at = e.end - value.length;
      if (ID.test(value)) { if (prefix !== null && key) exports.set(prefix + key, value); continue; } // { a: b } or [b]
      const p = value.match(/^require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)\s*\.\s*([\w$]+)$/);
      if (p) { // { a: require('./x').b } passes x's b on
        const t = prefix !== null && key && resolveImport(f, p[2]);
        if (t) reexports.push({ file: t, names: new Map([[prefix + key, p[3]]]) });
        continue;
      }
      if (/^[{[]/.test(value)) { scan(at, closeOf(bare, at), null); continue; } // nested: the same rules, not exports
      kept.push([at, e.end]); // a function, a call or another value: code
      if (prefix !== null && key) exports.set(prefix + key, null); // a unit defined in the object
    }
  };
  for (const m of code.matchAll(OBJECT_EXPORT)) {
    if (!real(m)) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(bare, open);
    listed.push([m.index, close]);
    // export default { a } is reached as `def.a`; module.exports = { a } as `require(…).a` or `{ a } = require(…)`
    scan(open, close, bare[open] === '[' ? null : m[0].startsWith('export') ? 'default.' : '');
  }
  for (const m of code.matchAll(CJS_PROP_REQ)) { // exports.x = require('./a').y passes a's y on as x
    if (!real(m)) continue;
    listed.push([m.index, m.index + m[0].length]);
    const t = resolveImport(f, m[3]);
    if (t) reexports.push({ file: t, names: new Map([[m[1], m[4]]]) });
  }
  const within = (spans, i) => spans.some(([s, e]) => i >= s && i < e);
  const inListed = (i) => within(listed, i) && !within(kept, i);
  for (const [s, e] of listed) usage = blankOut(usage, s, e);
  for (const [s, e] of kept) usage = usage.slice(0, s) + bare.slice(s, e) + usage.slice(e);

  for (const m of code.matchAll(STATIC_IMPORT)) {
    if (!real(m)) continue;
    const t = resolveImport(f, m[3]); take(m);
    if (t) { edges.push(t); bind(t, parseClause(m[1])); }
  }
  for (const m of code.matchAll(SIDE_IMPORT)) {
    if (!real(m)) continue;
    const t = resolveImport(f, m[2]);
    if (t) edges.push(t);
  }
  for (const m of code.matchAll(RE_EXPORT)) {
    if (!real(m)) continue;
    const t = resolveImport(f, m[3]); take(m);
    if (!t) continue;
    edges.push(t);
    if (m[1].startsWith('*')) { if (!/as/.test(m[1])) reexports.push({ file: t, star: true }); }
    else reexports.push({ file: t, names: new Map(parseList(m[1].slice(1, -1), 'as').map((b) => [b.local, b.imported])) });
  }
  for (const [re, cjs] of [[DYNAMIC, false], [REQUIRE, true]]) {
    for (const m of code.matchAll(re)) {
      if (!real(m)) continue;
      const t = resolveImport(f, m[3]);
      if (!t) continue;
      edges.push(t);
      if (!m[1]) { // require('./a').syncJob() or require('./routes')(app): used on the spot
        if (cjs && (m[4] || m[5]) && !inListed(m.index)) bindings.push({ local: null, imported: m[4] ?? 'default', file: t, cjs, direct: true });
        continue;
      }
      take(m);
      if (m[1].startsWith('{')) bind(t, parseList(m[1].slice(1, -1), ':'), cjs);
      else bind(t, [{ local: m[1], imported: m[4] ?? '*' }], cjs);
    }
  }
  for (const m of code.matchAll(CJS_REEXPORT)) {
    const t = real(m) && resolveImport(f, m[2]);
    if (t) reexports.push({ file: t, star: true }); // module.exports = require('./a'): a folder passing a file on
  }
  for (const m of code.matchAll(EXPORT_DECL)) {
    if (!real(m)) continue;
    exports.set(m[1] ? 'default' : m[3], m[3]);
    if (!m[2]) continue; // export const a = 1, bJob = … declares more than one name
    const end = statementEnd(bare, m.index + m[0].length);
    for (const part of topLevel(bare.slice(m.index + m[0].length, end).replace(/;\s*$/, '')).slice(1)) {
      const d = part.text.match(/^([A-Za-z_$][\w$]*)\s*(?:=|$)/);
      if (d) exports.set(d[1], d[1]);
    }
  }
  for (const m of code.matchAll(EXPORT_DEFAULT_NAME)) {
    if (real(m) && !['async', 'function', 'class'].includes(m[1])) { exports.set('default', m[1]); take(m); }
  }
  for (const m of code.matchAll(EXPORT_LIST)) {
    if (!real(m)) continue;
    for (const b of parseList(m[1], 'as')) exports.set(b.local, b.imported);
    take(m);
  }
  for (const m of code.matchAll(CJS_DEFAULT_DECL)) if (real(m)) exports.set('default', m[1]);
  for (const m of code.matchAll(CJS_DEFAULT)) if (real(m) && m[1] !== 'require') { exports.set('default', m[1]); take(m); }
  for (const m of code.matchAll(CJS_PROP)) {
    if (!real(m) || inListed(m.index)) continue;
    const local = m[2] ? m[2].match(/[\w$]+/)[0] : null;
    exports.set(m[1], local);
    if (local) take(m);
  }
  const cjs = /\bmodule\.exports\b|(?<![\w$.])exports\.[\w$]+\s*=/.test(bare) && !/(?:^|[^\w$.])export\s/.test(bare);
  return { src, code, bare, usage, edges, bindings, reexports, exports, cjs };
}

const isFile = (f) => existsSync(f) && statSync(f).isFile();
const named = new Set(CONFIG.ENTRY_FILES.map((f) => resolve(ROOT, f)));
const MISSING_ENTRIES = [...named].filter((f) => !isFile(f)).map(rel);

function packageBins() {
  const p = join(ROOT, 'package.json');
  if (!existsSync(p)) return [];
  try {
    const { bin } = JSON.parse(readFileSync(p, 'utf8'));
    return (typeof bin === 'string' ? [bin] : Object.values(bin ?? {})).map((b) => resolve(ROOT, b));
  } catch { return []; }
}
const BINS = new Set(packageBins());
const FILES = [...new Set([...walk(ROOT), ...[...named, ...BINS].filter(isFile)])];
const INFO = new Map(FILES.map((f) => [f, analyse(f)]));
const devOnly = (f) => CONFIG.NOT_PRODUCTION.some((d) => under(f, d));
const CMP = String.raw`[^;,\n]{0,160}?(?:[!=]==?|\.endsWith\()[^;,\n]{0,160}?`; // compared, in one expression on one line
const MAIN_CHECK = new RegExp(String.raw`process\.argv\[1\]${CMP}import\.meta\.(?:url|filename)|import\.meta\.(?:url|filename)${CMP}process\.argv\[1\]|` +
  String.raw`\bimport\.meta\.main\b|\brequire\.main\s*===?\s*module\b|\bmodule\s*===?\s*require\.main\b`);
const MAIN_HELPER = /\bif\s*\(\s*!?\s*(?:[\w$]+\.)*(?:isMain|isMainModule|main)\s*\(\s*import\.meta\.(?:url|filename)\b/;
const ARGV = String.raw`process\.argv\[1\]`;
const SELF = String.raw`import\.meta\.(?:url|filename)\b`;
// A main-module check: process.argv[1] compared with the file's own path on one line, or in an `if` through
// variables set from them (`const invoked = realpathSync(process.argv[1]); … if (self === invoked)`), or an
// `if (isMain(import.meta.url))` helper.
function mainCheck(bare) {
  if (MAIN_CHECK.test(bare) || MAIN_HELPER.test(bare)) return true;
  const setFrom = (re) => [...bare.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*${re}`, 'g'))].map((m) => m[1]);
  const argvVars = setFrom(ARGV);
  const selfVars = setFrom(SELF);
  const names = (c, re, vars) => new RegExp(re).test(c) || vars.some((v) => uses(c, v).length);
  for (const m of bare.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const c = bare.slice(open + 1, closeOf(bare, open) - 1); // the condition only, not the body
    if (/[!=]==?|\.endsWith\(/.test(c) && names(c, ARGV, argvVars) && names(c, SELF, selfVars)) return true;
  }
  return false;
}
const runsDirectly = (i) => /^#![^\n]*\bnode\b/.test(i.src) || mainCheck(i.bare);
const ENTRIES = FILES.filter((f) => named.has(f) || ((BINS.has(f) || runsDirectly(INFO.get(f))) && !devOnly(f)));

function reachable() {
  const seen = new Set();
  const stack = [...ENTRIES];
  while (stack.length) {
    const f = stack.pop();
    if (!INFO.has(f) && isCode(f) && isFile(f)) INFO.set(f, analyse(f)); // a file in a skipped folder an entry imports
    if (seen.has(f) || !INFO.has(f)) continue;
    seen.add(f);
    stack.push(...INFO.get(f).edges);
  }
  return seen;
}

// Where an exported name really comes from, through folders that re-export it: [{ file, name }].
const ORIGINS = new Map();
function origins(file, name, seen) {
  if (!seen) {
    const key = `${file}\0${name}`;
    if (!ORIGINS.has(key)) ORIGINS.set(key, origins(file, name, new Set()));
    return ORIGINS.get(key);
  }
  const key = `${file}\0${name}`;
  const info = INFO.get(file);
  if (seen.has(key) || !info) return [];
  seen.add(key);
  if (info.exports.has(name)) {
    const local = info.exports.get(name);
    const b = local && info.bindings.find((x) => x.local === local && x.imported !== '*');
    return b ? origins(b.file, b.imported, seen) : [{ file, name }];
  }
  const out = [];
  for (const r of info.reexports) {
    if (r.star && !/^default\b/.test(name)) out.push(...origins(r.file, name, seen));
    else if (r.names?.has(name)) out.push(...origins(r.file, r.names.get(name), seen));
  }
  return out;
}

function units() {
  const byKey = new Map();
  for (const [f, info] of INFO) {
    if (!CONFIG.SOURCE.some((d) => under(f, d)) || devOnly(f)) continue;
    for (const [exported, local] of info.exports) {
      if (local && info.bindings.some((b) => b.local === local)) continue; // passed on from another file, not built here
      const name = local ?? exported.replace(/^default\./, '');
      if (!SUFFIX.test(name)) continue;
      const key = `${f}\0${name}`;
      if (!byKey.has(key)) byKey.set(key, { name, local, file: f, exported: new Set() });
      byKey.get(key).exported.add(exported);
    }
  }
  return [...byKey.values()];
}


// Where a declaration ends: the `}` closing a function or class body, or the end of a const/let/var statement.
function statementEnd(bare, from, isBody = false) {
  let depth = 0;
  let opened = false;
  for (let i = from; i < bare.length; i++) {
    const c = bare[i];
    if ('([{'.includes(c)) { if (c === '{' && depth === 0) opened = true; depth++; continue; }
    if (')]}'.includes(c)) { depth--; if (isBody && c === '}' && depth === 0 && opened) return i + 1; continue; }
    if (isBody || depth !== 0) continue;
    if (c === ';') return i + 1;
    if (c === '\n' && !/[=,(+\-*/&|?:>[{]$/.test(bare.slice(from, i).trimEnd())) return i;
  }
  return bare.length;
}

// Every declaration of a unit's name in its own file, so a use inside one (recursion) is not counted: [[start, end], …].
function ownBodies(bare, name) {
  const re = new RegExp(`\\b(?:async\\s+)?(?:function\\s*\\*?|class)\\s*${esc(name)}\\b|\\b(?:const|let|var)\\s+${esc(name)}\\b|,\\s*${esc(name)}\\s*=(?!=)`, 'g');
  const spans = [...bare.matchAll(re)].map((m) => [m.index, statementEnd(bare, m.index + m[0].length, /^(?:async|function|class)/.test(m[0]))]);
  return spans.length ? spans : null; // declaration not found: count no use in its own file, so the test fails loudly
}

function usedBy(unit, reach) {
  const isUnit = (t, name) => origins(t, name).some((o) => o.file === unit.file && unit.exported.has(o.name));
  for (const f of reach) {
    if (f === unit.file) continue;
    const info = INFO.get(f);
    for (const b of info.bindings) {
      if (b.direct) {
        if (isUnit(b.file, b.imported)) return rel(f);
      } else if (b.imported === '*') {
        for (const m of info.usage.matchAll(new RegExp(`(?<![\\w$.])${esc(b.local)}\\s*\\.\\s*([\\w$]+)`, 'g'))) {
          if (isUnit(b.file, m[1])) return rel(f);
        }
        const plain = info.usage.match(new RegExp(`(?<![\\w$.])${esc(b.local)}(?![\\w$]|\\s*\\.)`));
        if (b.cjs && plain && isUnit(b.file, 'default')) return rel(f); // const run = require('./job.js'); run()
      } else if (isUnit(b.file, b.imported) && uses(info.usage, b.local).length) {
        return rel(f);
      } else if (b.imported === 'default') { // import jobs from './jobs.mjs' (export default { … }), or from CommonJS; jobs.syncJob()
        for (const m of info.usage.matchAll(new RegExp(`(?<![\\w$.])${esc(b.local)}\\s*\\.\\s*([\\w$]+)`, 'g'))) {
          if (isUnit(b.file, `default.${m[1]}`) || (INFO.get(b.file)?.cjs && isUnit(b.file, m[1]))) return rel(f);
        }
      }
    }
  }
  // Used in its own file, outside its own body, and that file is reached (a helper the reached code calls).
  if (reach.has(unit.file) && unit.local) {
    const info = INFO.get(unit.file);
    const spans = ownBodies(info.bare, unit.local);
    if (spans && uses(info.usage, unit.local).some((i) => spans.every(([s, e]) => i < s || i >= e))) return rel(unit.file);
  }
  return null;
}

test('wired: the scan has something to judge (cannot judge otherwise)', (t) => {
  assert.deepEqual(MISSING_ENTRIES, [], 'CONFIG.ENTRY_FILES names something that is not a file');
  assert.ok(ENTRIES.length > 0, 'cannot judge: no entry point found; name the files that start the product in CONFIG.ENTRY_FILES');
  t.diagnostic(`entry points (production starts here): ${ENTRIES.map(rel).join(', ')}`);
  assert.ok(units().length > 0, `cannot judge: no unit of work found in ${CONFIG.SOURCE.join(', ')} (exported names ending in ${CONFIG.UNIT_SUFFIXES.join(', ')}); check CONFIG.SOURCE and CONFIG.UNIT_SUFFIXES`);
});

test('wired: every unit of work is used by production code, or listed in UNWIRED with the row that will wire it', () => {
  const reach = reachable();
  const missing = [];
  const stale = [];
  for (const u of units()) {
    const by = usedBy(u, reach);
    if (!by && !UNWIRED[u.name]) missing.push(`${u.name} (${rel(u.file)})`);
    if (by && UNWIRED[u.name]) stale.push(`${u.name} is now used by ${by}: take it off UNWIRED`);
  }
  assert.deepEqual(missing, [], 'built but not connected: nothing in production uses these; wire them, or list them in UNWIRED with their row');
  assert.deepEqual(stale, []);
});

test('wired: every UNWIRED name is a unit that exists and names its row', () => {
  const names = new Set(units().map((u) => u.name));
  for (const [n, why] of Object.entries(UNWIRED)) {
    assert.ok(names.has(n), `${n} is not a unit of work any more; take it off UNWIRED`);
    assert.match(why, CONFIG.ROW, `${n}: say which roadmap row or issue will wire it`);
  }
});

// ── File rule (L234; ORCHESTRATE's, not in the template) ────────────────────
// The same reach must cover every production file under modules/ and shared/, or its folder is here with the row that
// will run it and the EXACT number of its files not reached yet. One more fails (wire it, or name it); one fewer fails
// too (lower the count), so the list stays true while staying short. Fixtures and fakes are left out by name.
export const UNWIRED_FILES = Object.freeze({
  'modules/M1-front-door/': { files: 3, why: 'R-0b-162 D: the Front Door ports (frontDoorAlive, restartFrontDoor, sendFrontDoor); no job runs M1 yet' },
  'modules/M2-approvals/': { files: 3, why: 'R-0b-140 undo-flag, L135 transcript-copy, L86 required-keys: lead to place' },
  'modules/M3-lead/': { files: 2, why: 'R-0b-162 C: the Lead ports (leads, startLead) start the Lead that uses these (R-0b-143); L443: plan-go reaches the plan-review wording and its files' },
  'modules/M4-workshop/': { files: 4, why: 'R-0b-162 C/D: agent-seam (launch), send-safe guard (sendFrontDoor; the runner reaches activity and claude-signals through the R-0b-175a hook store); save-work is reached by the worker runner since #378 (L874); R-0b-147 review-walls-proof; L601 required-keys, lead to place' },
  'modules/M6-merge-gate/': { files: 4, why: 'L236: gatePass in the robot job, once the robot App exists (R-0b-02); token.mjs is now reached by watch-run (L624)' },
  'modules/M9-record/': { files: 1, why: 'L86: required-keys, lead to place' },
  'modules/M10-rules/': { files: 4, why: 'R-0b-106 first-cutover fit check and known-gaps, L104 from-text, the hook rules snapshot: lead to place' },
  'modules/M11-dispatcher/': { files: 3, why: 'R-0b-162 C: account-ports, headless-result (worker exit); R-0b-175a interactive-holds (the relay, unwired until the status reader is a Dispatcher port, as drainHolds); login-job is reached by the robot job since #352 (L834)' },
  'modules/M12-sensors/screen/': { files: 3, why: 'R-0b-153a: sendSafe asks waiting(), which reaches match and the Claude rules (lane 7, L1064)' },
  'modules/M12-sensors/': { files: 15, why: 'R-0b-169: the Sensors job wiring and its probes' },
  'modules/M13-ledger/': { files: 1, why: 'R-0b-77 waiting (alert-channel.mjs reached through the robot job since #288, L730; alerts.mjs since #184, L428)' },
});
const isFixture = (f) => /(?:^|[/-])(?:fixtures?|fakes?|png-fixture|test-tmp)\.mjs$/.test(f);
const unreachedFiles = () => {
  const reach = reachable();
  return FILES.filter((f) => CONFIG.SOURCE.some((d) => under(f, d)) && !reach.has(f) && !isFixture(rel(f))).map(rel);
};

test('L234: every production file is reached from an entry point, or its folder is on UNWIRED_FILES with its exact count', () => {
  const problems = [];
  const counted = Object.fromEntries(Object.keys(UNWIRED_FILES).map((k) => [k, []]));
  for (const r of unreachedFiles()) {
    const row = Object.keys(UNWIRED_FILES).find((k) => r.startsWith(k));
    if (row) counted[row].push(r); else problems.push(`${r}: no entry point reaches it; wire it, or name its folder on UNWIRED_FILES with its row`);
  }
  for (const [k, { files }] of Object.entries(UNWIRED_FILES)) {
    if (counted[k].length !== files) problems.push(`${k}: ${counted[k].length} file(s) not reached, UNWIRED_FILES says ${files}: ${counted[k].join(', ')}`);
  }
  assert.deepEqual(problems, []);
});

test('L234: every UNWIRED_FILES row is a folder that exists and names its row', () => {
  for (const [k, { files, why }] of Object.entries(UNWIRED_FILES)) {
    assert.ok(k.endsWith('/') && existsSync(join(ROOT, k)), `${k} is a folder of orchestrate/`);
    assert.ok(Number.isInteger(files) && files > 0, `${k}: a positive count`);
    assert.match(why, CONFIG.ROW, `${k}: say which row or lead call runs it`);
  }
});

test('L234: the hook and config entry points are real', () => {
  assert.ok(HOOK_ENTRIES.length >= 5, 'the role templates name the hooks');
  for (const e of CONFIG_ENTRIES) {
    const src = readFileSync(join(ROOT, e.loader), 'utf8');
    assert.ok(src.replace(/\s+/g, '').includes(e.call.replace(/\s+/g, '')), `${e.loader} still makes the call ${e.call}`);
    if (!e.file) assert.match(e.why ?? '', CONFIG.ROW, `${e.call}: no file yet, so name the row that writes it`);
  }
});

test('L235: every config-named import in production code has a CONFIG_ENTRIES row', () => {
  const rows = new Set(CONFIG_ENTRIES.map((e) => `${e.loader}|${e.call.replace(/\s+/g, '')}`));
  const missing = [];
  for (const f of FILES) {
    for (const m of INFO.get(f).bare.matchAll(/import\(\s*pathToFileURL\([^)]*\)\.href\s*\)/g)) {
      if (!rows.has(`${rel(f)}|${m[0].replace(/\s+/g, '')}`)) missing.push(`${rel(f)}: ${m[0]}`);
    }
  }
  assert.deepEqual(missing, [], 'a program loads a config-named file wired.test does not know; add it to CONFIG_ENTRIES');
});
