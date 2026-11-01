// review-install-closure.test.mjs — LEAD-CALLS L92 item 4 and L106 M-1: the install closure.
//
// WHY. The LaunchDaemons start the review runner, the account copy and the updater from the installed copy, which the
// updater makes from main's `orchestrate/` plus a short list of outside files (install-check.mjs OUTSIDE_FILES). An
// import that reaches a file the updater does not install (M6 gather.mjs and M10 policy.mjs import Bob's
// scripts/blueprint/yaml-lite.mjs) fails only on the Mac, at the first run, with ERR_MODULE_NOT_FOUND: no review ever
// starts. Here a repository is made from this checkout's own orchestrate/ and scripts/ files, the real updater
// installs it as on the Mac (owner = this test's uid, `top` = the test folder), and then the repository it was made
// from, the bare origin and the updater's clone are deleted. Every non-test module of the copy is then imported for
// real by node, one child process each, named through the copy's link as the plists name their scripts. A load hook in
// the child lists every file node loads; each must be inside the copy's versioned folder (so an import that names this
// checkout by an absolute path fails too).
//
// What a real import cannot see, two scans read (L106 M-1 (b), (c)): an `import()` or require that runs only later,
// whose target is not a plain string (only a module the config names, on CONFIG_IMPORTS, may be), and a path written in the
// code that leads from the module's folder out of orchestrate/ to a file the updater does not install. The scans read
// code through a small reader (`lex`) that knows strings, templates, regular expressions and comments, so text inside
// a string can't hide code from them, and code can't hide inside what looks like a comment. The reader is itself
// checked against node: for every module, the files its static imports reach, as the reader finds them, are exactly
// the files node loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, realpathSync, statSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { gitOk } from '../git/safe-git.mjs';
import { SCRIPTS } from './review-daemons.mjs';
import { NODE, UPDATER_CONFIG, RUNNER_CONFIG, STAMP, SOURCE, OUTSIDE_FILES, currentCopy, readInstallStamp } from './install-check.mjs';
import { updateOnce, MAIN } from './review-updater.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ME = process.getuid();
const ID = [['user.name', 'test'], ['user.email', 'test@example.invalid']];
const GIT = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// The only `import()` calls whose target is not a plain string: a module named by its program's config, the wiring
// (M11's and the review runner's) and the runner's budget module (check 12's inputs, L83 M-3). The runner's own check
// (`programsProblem`) refuses a wiring or a budget module outside the installed copy or not root's alone, and a module
// of the repository that one of them names is imported for real here like every other. Each is listed with its file
// and its exact call, so a second computed import in the same file is still refused, and an entry no longer in its
// file fails.
const CONFIG_IMPORTS = Object.freeze([
  ['modules/M11-dispatcher/main.mjs', 'import(pathToFileURL(config.wiring).href)'],
  ['modules/M4-workshop/launcher/review-runner-main.mjs', 'import(pathToFileURL(c.wiring).href)'],
  ['modules/M4-workshop/launcher/review-runner-main.mjs', 'import(pathToFileURL(c.budget).href)'],
]);
// Modules whose whole body is a test fixture's hook: each reads a hook's input on stdin and exits while it loads. Each
// child is given such an input; a module on this list must exit while it loads, and any other module must not.
const EXITS_ON_LOAD = Object.freeze({
  'modules/M12-sensors/shell-guard/fixtures/naive-hook.mjs': 'a planted weak hook for the shell-guard runner: reads stdin, exits',
  'modules/M12-sensors/shell-guard/fixtures/strict-hook.mjs': 'a planted strict hook for the shell-guard runner: reads stdin, exits',
});
const HOOK_INPUT = `${JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } })}\n`;

/** The tracked files of this checkout under `dirs`, as they are on disk now (so a planted change is in the copy). */
function tracked(dirs) {
  const r = spawnSync(GIT, ['ls-files', '-z', '--', ...dirs], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter(Boolean).filter((f) => existsSync(join(REPO, f)));
}

/**
 * A repository whose main holds this checkout's orchestrate/ and scripts/, installed by the real updater; then the
 * repository, the origin, the updater's clone and the seed are deleted, so only the installed copy is left.
 */
async function installed() {
  const root = realpathSync.native(tempDir('m4-closure-'));
  const origin = join(root, 'origin.git');
  await gitOk(['init', '--bare', '-q', origin], { gitDir: origin });
  const src = join(root, 'src');
  mkdirSync(src);
  const sg = { gitDir: join(src, '.git'), workTree: src, cwd: src, extraConfig: ID };
  await gitOk(['init', '-q', src], sg);
  for (const f of tracked([SOURCE, 'scripts'])) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), readFileSync(join(REPO, f)));
    chmodSync(join(src, f), statSync(join(REPO, f)).mode & 0o755);
  }
  await gitOk(['add', '-A'], sg);
  await gitOk(['commit', '-q', '-m', 'this checkout'], sg);
  await gitOk(['push', '-q', origin, `HEAD:${MAIN}`], sg);

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'bin'), { recursive: true });
  writeFileSync(join(seed, NODE), 'a node\n');
  writeFileSync(join(seed, RUNNER_CONFIG), '{}\n');
  const installRoot = join(root, 'inst', SOURCE);
  mkdirSync(dirname(installRoot));
  const c = { installRoot, clone: join(root, 'clone.git'), address: origin, keep: ['bin', RUNNER_CONFIG, UPDATER_CONFIG], gitBin: GIT };
  writeFileSync(join(seed, UPDATER_CONFIG), `${JSON.stringify(c)}\n`);
  const r = await updateOnce(c, { first: seed, owner: ME, top: root, localAddress: true });
  assert.equal(r.ok, true, r.reason);
  const cur = currentCopy(installRoot, { owner: ME });
  assert.ok(cur.link && cur.folder, cur.problem);
  for (const gone of [src, origin, c.clone, `${c.clone}.home`, seed]) rmSync(gone, { recursive: true, force: true });
  assert.deepEqual(readdirSync(root).sort(), ['inst'], 'only the installed copy is left');
  return { root, installRoot, cur };
}

// ---- The reader. -------------------------------------------------------------------------------------------------

// After one of these words a `/` starts a regular expression; after any other word, or after `)`, `]`, `}`, a value or
// a string, it divides.
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'export', 'default', 'extends']);

/**
 * `text` (a module) as { code, lits }. `code` is the text with every comment taken out and every string literal put
 * as `"#<n>"` (lits[n] its text), a template with no `${}` too; a template with `${}` keeps its backticks and its
 * `${…}` code, each piece of text as `#<n>` (a lit of kind 'tpl'; the first piece `head`). A regular expression is `/R/`.
 * Line breaks are kept, so a line of `code` is a line of the module. Throws on an unterminated string, template,
 * comment or regular expression, so a reader that loses its place fails rather than reads past code.
 */
export function lex(text) {
  const lits = [];
  let out = '';
  let i = 0;
  let depth = 0;
  const subs = [];                       // brace depth at which each open template `${` began
  let prev = '';                         // the last character of code, or 'x' after a value
  let word = '';                         // the last word of code
  const breaks = (s) => '\n'.repeat((s.match(/\n/g) ?? []).length);
  const lit = (v, kind, head = false) => { lits.push({ v, kind, head }); return lits.length - 1; };
  const tplPiece = () => {
    let s = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { s += text.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i += 1; return { s, end: true }; }
      if (c === '$' && text[i + 1] === '{') { i += 2; return { s, end: false }; }
      s += c; i += 1;
    }
    throw new Error('an unterminated template');
  };
  const afterPiece = (p, first) => {
    if (first && p.end) { out += `"#${lit(p.s, 'str')}"${breaks(p.s)}`; prev = 'x'; word = ''; return; }
    out += `${first ? '`' : ''}#${lit(p.s, 'tpl', first)}${breaks(p.s)}`;
    if (p.end) { out += '`'; prev = 'x'; word = ''; return; }
    out += '${'; subs.push(depth); depth += 1; prev = '{'; word = '';
  };
  if (text.startsWith('#!')) { const e = text.indexOf('\n'); i = e < 0 ? text.length : e; }
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      if (e < 0) throw new Error('an unterminated comment');
      out += ` ${breaks(text.slice(i, e))}`; i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      let s = ''; i += 1;
      for (;;) {
        if (i >= text.length || text[i] === '\n') throw new Error('an unterminated string');
        if (text[i] === '\\') { s += text.slice(i, i + 2); i += 2; continue; }
        if (text[i] === c) { i += 1; break; }
        s += text[i]; i += 1;
      }
      out += `"#${lit(s, 'str')}"${breaks(s)}`; prev = 'x'; word = ''; continue;
    }
    if (c === '`') { i += 1; afterPiece(tplPiece(), true); continue; }
    if (c === '/' && (prev === '' || (/[\w$]/.test(prev) ? BEFORE_EXPR.has(word) : !/[)\]}x]/.test(prev)))) {
      i += 1;
      for (let cls = false; ; i += 1) {
        if (i >= text.length || text[i] === '\n') throw new Error('an unterminated regular expression');
        if (text[i] === '\\') { i += 1; continue; }
        if (text[i] === '[') cls = true;
        else if (text[i] === ']') cls = false;
        else if (text[i] === '/' && !cls) { i += 1; break; }
      }
      while (i < text.length && /[a-z]/.test(text[i])) i += 1;
      out += '/R/'; prev = 'x'; word = ''; continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (subs.length && subs[subs.length - 1] === depth - 1) { subs.pop(); depth -= 1; out += '}'; i += 1; afterPiece(tplPiece(), false); continue; }
      depth -= 1;
    }
    out += c; i += 1;
    if (/[\w$]/.test(c)) { word = /[\w$]/.test(prev) ? word + c : c; prev = c; } else if (!/\s/.test(c)) { prev = c; word = ''; }
  }
  if (subs.length) throw new Error('an unterminated template');
  return { code: out, lits };
}

const lineOf = (code, at) => code.slice(0, at).split('\n').length;
const callAt = (code, at) => {               // the call that starts at `at`, up to its closing parenthesis
  let k = code.indexOf('(', at);
  for (let n = 0; k < code.length; k += 1) { if (code[k] === '(') n += 1; if (code[k] === ')' && --n === 0) break; }
  return code.slice(at, k + 1).replace(/\s+/g, '');
};

/** The module names `code` imports when it loads: `import … from`, `export … from` and a bare `import '…'`. */
function staticImports({ code, lits }) {
  const out = [];
  for (const m of code.matchAll(/(?<![\w$.])(?:import|export)(?![\w$])[^;"`]*?(?<![\w$])from\s*"#(\d+)"/g)) out.push(lits[+m[1]].v);
  for (const m of code.matchAll(/(?<![\w$.])import\s*"#(\d+)"/g)) out.push(lits[+m[1]].v);
  return out;
}

/**
 * What the two scans find in the module `file` (`rel` its path in orchestrate/), whose copy is `real` inside `folder`:
 * every load that runs later and names a file node can't know until then, and every path written from the module's
 * folder that leaves orchestrate/ for a file the updater does not install. → [why…]
 */
export function hiddenLoads(text, { file, rel, real, folder, outside = OUTSIDE_FILES, wiring = CONFIG_IMPORTS }) {
  const bad = [];
  let lx;
  try { lx = lex(text); } catch (e) { return [`${rel}: the reader could not read it (${e.message})`]; }
  const { code, lits } = lx;
  const allowed = wiring.filter(([f]) => f === rel).map(([, call]) => call);
  for (const m of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
    if (/^import\s*\(\s*"#\d+"\s*[,)]/.test(code.slice(m.index))) continue;
    const call = callAt(code, m.index);
    if (allowed.includes(call)) continue;
    bad.push(`${rel}:${lineOf(code, m.index)} imports a name made at run time (${call.slice(0, 120)}), which neither node nor this test can follow`);
  }
  for (const [f, call] of wiring) if (f === rel && !code.replace(/\s+/g, '').includes(call)) bad.push(`${rel}: the config-named import ${call} listed for it is not there`);
  for (const m of code.matchAll(/(?<![\w$.])(?:createRequire|require)\s*\(/g)) bad.push(`${rel}:${lineOf(code, m.index)} loads with require, which this test does not follow`);
  const leaves = (p) => {
    const to = resolve(dirname(file), p);
    const inCopy = relative(real, to);
    if (inCopy === '' || (!inCopy.startsWith('..') && !isAbsolute(inCopy))) return null;
    const inFolder = relative(folder, to);
    return outside.includes(inFolder.split(sep).join('/')) ? null : inFolder;
  };
  // Strings next to each other in a call are taken as one path (`join(here, '..', '..', 'README.md')`).
  for (const m of code.matchAll(/"#(\d+)"(?:\s*,\s*"#\d+")*/g)) {
    const parts = [...m[0].matchAll(/#(\d+)/g)].map((x) => lits[+x[1]].v);
    if (parts[0] !== '..' && !parts[0].startsWith('../')) continue;
    const to = leaves(parts.join('/'));
    if (to !== null) bad.push(`${rel}:${lineOf(code, m.index)} names ${JSON.stringify(parts.join('/'))}, outside ${SOURCE}/ (${to}), which the updater does not install`);
  }
  // A template's first piece, up to its last `/`: the folder a computed name starts from.
  for (const m of code.matchAll(/`#(\d+)/g)) {
    const head = lits[+m[1]].v;
    if (!head.startsWith('../')) continue;
    const to = leaves(head.slice(0, head.lastIndexOf('/') + 1));
    if (to !== null) bad.push(`${rel}:${lineOf(code, m.index)} builds a path from ${JSON.stringify(head)}, outside ${SOURCE}/ (${to}), which the updater does not install`);
  }
  return bad;
}

/** The files `entry`'s static imports reach, as the reader finds them (real paths). Bad names are left to node. */
function readerClosure(entry) {
  const seen = new Set();
  const todo = [realpathSync.native(entry)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of staticImports(lex(readFileSync(f, 'utf8')))) {
      if (BUILTIN.has(spec) || !(spec.startsWith('./') || spec.startsWith('../'))) continue;
      const to = resolve(dirname(f), spec);
      if (existsSync(to)) todo.push(realpathSync.native(to));
    }
  }
  return seen;
}

/** Every .mjs file under `dir` that is not a test file or a test helper. */
function modulesOf(dir) {
  const out = [];
  const walk = (p) => {
    for (const n of readdirSync(p).sort()) {
      const q = join(p, n);
      const st = lstatSync(q);
      if (st.isDirectory()) walk(q);
      else if (st.isFile() && n.endsWith('.mjs') && !/\.test(-helper)?\.mjs$/.test(n)) out.push(q);
    }
  };
  walk(dir);
  return out;
}

// ---- The real import. ----------------------------------------------------------------------------------------------

// The child: a load hook lists every file node loads, then the module is imported. Whether it finished, exited while
// it loaded, or failed, the list and the outcome are written on exit. Nothing is passed on argv, so no module takes
// itself for the program started.
const PROBE = `import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const seen = [];
const r = { loaded: false, error: null };
registerHooks({ load(url, ctx, next) { if (url.startsWith('file:')) seen.push(url); return next(url, ctx); } });
process.on('exit', (code) => writeFileSync(process.env.CLOSURE_OUT, JSON.stringify({ ...r, code, seen })));
try { await import(process.env.CLOSURE_TARGET); r.loaded = true; process.exit(0); }
catch (e) { r.error = String(e?.code ?? '') + ' ' + String(e?.message ?? e).slice(0, 600); process.exit(1); }
`;

function importOne(probe, target, out, cwd) {
  return new Promise((done) => {
    const ch = spawn(process.execPath, [probe], { cwd, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, CLOSURE_TARGET: target, CLOSURE_OUT: out } });
    let err = '';
    const t = setTimeout(() => ch.kill('SIGKILL'), 60_000);
    ch.stderr.on('data', (b) => { err += b; });
    ch.stdin.on('error', () => {});
    ch.stdin.end(HOOK_INPUT);
    ch.on('close', (status, signal) => {
      clearTimeout(t);
      let r = null; try { r = JSON.parse(readFileSync(out, 'utf8')); } catch { /* the child wrote nothing */ }
      done({ status, signal, r, err: err.slice(0, 600) });
    });
  });
}

async function importAll(items, probe, root, width = 8) {
  const res = new Array(items.length);
  let next = 0;
  const lane = async () => { for (let k = next++; k < items.length; k = next++) res[k] = await importOne(probe, items[k].target, join(root, `loaded-${k}.json`), root); };
  await Promise.all(Array.from({ length: width }, lane));
  return res;
}

test('L92 item 4, L106 M-1: every module of the installed copy loads from the copy alone, the source deleted', { timeout: 280_000 }, async () => {
  const w = await installed();
  const { folder, real } = w.cur;
  // The layout: the link names <v>/orchestrate; the outside files sit at their repository paths in <v>; the stamp too.
  assert.equal(real, join(folder, SOURCE));
  for (const f of OUTSIDE_FILES) assert.ok(existsSync(join(folder, f)), `${f} is installed beside ${SOURCE}`);
  assert.ok(existsSync(join(folder, STAMP)) && !existsSync(join(real, STAMP)), 'the stamp is at the top of the versioned folder');
  assert.match(readInstallStamp(w.installRoot, { owner: ME }), /^[0-9a-f]{40}$/);

  const mods = modulesOf(real).map((f) => ({ file: f, rel: relative(real, f).split(sep).join('/') }));
  for (const s of Object.values(SCRIPTS)) assert.ok(mods.some((m) => m.rel === s), `the plist script ${s} is in the copy`);
  for (const f of Object.keys(EXITS_ON_LOAD)) assert.ok(mods.some((m) => m.rel === f), `${f}, on EXITS_ON_LOAD, is in the copy`);
  for (const [f] of CONFIG_IMPORTS) assert.ok(mods.some((m) => m.rel === f), `${f}, on CONFIG_IMPORTS, is in the copy`);

  // The scans, over every module.
  const hidden = mods.flatMap((m) => hiddenLoads(readFileSync(m.file, 'utf8'), { ...m, real, folder }));
  assert.deepEqual(hidden, [], 'no load the real import cannot see');

  // The real import, each module named through the copy's link, as a plist names its script.
  const probe = join(w.root, 'probe.mjs');
  writeFileSync(probe, PROBE);
  const items = mods.map((m) => ({ ...m, target: pathToFileURL(join(w.installRoot, m.rel)).href }));
  const res = await importAll(items, probe, w.root);
  const fails = [];
  const used = new Set();
  const reached = new Set();
  const scripts = new Set(Object.values(SCRIPTS));
  items.forEach((m, k) => {
    const { r, status, signal, err } = res[k];
    if (!r) { fails.push(`${m.rel}: the child wrote nothing (status ${status}, ${signal ?? 'no signal'}): ${err}`); return; }
    const exits = Object.hasOwn(EXITS_ON_LOAD, m.rel);
    if (r.error) { fails.push(`${m.rel} does not load from the copy: ${r.error}`); return; }
    if (exits && r.loaded) fails.push(`${m.rel} is on EXITS_ON_LOAD but loaded without exiting`);
    if (!exits && !r.loaded) fails.push(`${m.rel} exited (${r.code}) while it loaded`);
    const files = r.seen.map((u) => fileURLToPath(u));
    for (const f of files) {
      const inFolder = relative(folder, f);
      if (inFolder.startsWith('..') || isAbsolute(inFolder)) fails.push(`${m.rel} loaded ${f}, outside the installed copy`);
      else used.add(inFolder.split(sep).join('/'));
    }
    // The reader, checked against node: the files the reader's static imports reach are the files node loaded.
    const byReader = [...readerClosure(m.file)].sort();
    const byNode = [...new Set(files)].sort();
    if (byReader.join('\n') !== byNode.join('\n')) {
      fails.push(`${m.rel}: the reader and node differ (reader only: ${byReader.filter((f) => !byNode.includes(f)).map((f) => relative(folder, f)).join(', ') || '-'}; node only: ${byNode.filter((f) => !byReader.includes(f)).map((f) => relative(folder, f)).join(', ') || '-'})`);
    }
    if (scripts.has(m.rel)) for (const f of files) reached.add(f);
  });
  assert.deepEqual(fails, [], 'every module loads from the copy, and only from it');
  // Every listed outside file is loaded by a module of the copy, so the list holds no stale entry.
  for (const f of OUTSIDE_FILES) assert.ok(used.has(f), `${f} is loaded by a module of the copy`);
  assert.ok(reached.size > 10, 'the plist scripts reach the modules they import');
  assert.ok(mods.length > 100, `the copy's modules were all imported (${mods.length})`);
});

// ---- The reader and the scans on small modules. -----------------------------------------------------------------

test('L106 M-1 (d): the reader keeps strings, templates and regular expressions apart from code and comments', () => {
  // The auditor's plant G: a string with "/*" in it and a later one with "*/" no longer hide the import between them.
  const g = lex(`const a = "docs/*"; import { x } from '../../../scripts/hidden.mjs'; const b = "*/x";\n`);
  assert.deepEqual(staticImports(g), ['../../../scripts/hidden.mjs']);
  // Comments are not code; an import in one is not an import.
  assert.deepEqual(staticImports(lex(`// import './a.mjs';\n/* import './b.mjs'; */\nimport './c.mjs';\nexport { y } from "./d.mjs";\n`)).sort(), ['./c.mjs', './d.mjs']);
  // A regular expression with quotes, a "//" and a "/*" in it, and a division, read as such.
  const r = lex(`const re = /['"]\\/\\*[/]/g; const half = n / 2 / 1; import './e.mjs';\n`);
  assert.deepEqual(staticImports(r), ['./e.mjs']);
  assert.match(r.code, /\/R\/g?;/);
  // A template's text and its code: an import inside ${} is code; text that looks like code is not.
  const t = lex('const s = `import \'./not.mjs\' ${await import(`../${n}`)} done`;\n');
  assert.deepEqual(staticImports(t), []);
  assert.match(t.code, /import\(`#\d+\$\{n\}#\d+`\)/);
  // Line breaks are kept, so a line of the code is a line of the module.
  const l = lex('const a = `x\ny`;\n/* one\ntwo */\nimport("z" + q);\n');
  assert.equal(lineOf(l.code, l.code.indexOf('import')), 5);
  for (const bad of ['const a = "open;\n', 'const a = `open;\n', '/* open\n', 'const r = /open\n', 'const s = `${a`;\n']) assert.throws(() => lex(bad), /unterminated/, bad);
});

test('L106 M-1 (b), (c): the scans find a load the real import cannot see', () => {
  const folder = '/v';
  const real = join(folder, SOURCE);
  const at = (rel) => ({ file: join(real, rel), rel, real, folder });
  const scan = (rel, text, more = {}) => hiddenLoads(text, { ...at(rel), ...more });
  // The auditor's plants A and A2: a template and a variable import() of a file outside the copy.
  assert.match(scan('modules/M10-rules/policy.mjs', 'export const f = () => import(`../../../scripts/blueprint/${n}.mjs`);\n').join('|'), /policy\.mjs:1 imports a name made at run time/);
  assert.match(scan('modules/M10-rules/policy.mjs', 'const p = "../../../scripts/blueprint/schema-check.mjs";\nexport const f = () => import(p);\n').join('|'), /policy\.mjs:2 imports a name made at run time \(import\(p\)\)/);
  // A plain-string import() is node's to follow, and the real import loads what it names once it runs.
  assert.deepEqual(scan('modules/M10-rules/policy.mjs', "export const f = () => import('./engine.mjs');\n"), []);
  // The wiring call is allowed in its own file only, and only that exact call.
  const wiring = 'const mod = await import(pathToFileURL(config.wiring).href);\n';
  assert.deepEqual(scan('modules/M11-dispatcher/main.mjs', wiring), []);
  assert.equal(scan('modules/M11-dispatcher/other.mjs', wiring).length, 1);
  assert.equal(scan('modules/M11-dispatcher/main.mjs', `${wiring}const b = await import(pathToFileURL(config.more).href);\n`).length, 1);
  assert.match(scan('modules/M11-dispatcher/main.mjs', 'export const none = 1;\n').join('|'), /the config-named import .* is not there/);
  // The runner's budget import is allowed in the runner only, not in M11's main.
  const budget = 'budget = await (await import(pathToFileURL(c.budget).href)).budget(c);\n';
  assert.equal(scan('modules/M11-dispatcher/main.mjs', `${wiring}${budget}`).length, 1);
  const runner = 'modules/M4-workshop/launcher/review-runner-main.mjs';
  const runnerWiring = 'wiring = await import(pathToFileURL(c.wiring).href);\n';
  assert.deepEqual(scan(runner, `${runnerWiring}${budget}`), []);
  assert.match(scan(runner, runnerWiring).join('|'), /the config-named import import\(pathToFileURL\(c\.budget\)\.href\) listed for it is not there/);
  assert.equal(scan('a/b.mjs', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('./x.cjs');\n").length, 2);
  // The auditor's plant B: a read, done later, of a file outside orchestrate/, in each way a path is written.
  for (const text of [
    "export const f = () => readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');\n",
    "export const f = () => readFileSync(join(here, '..', '..', '..', 'README.md'), 'utf8');\n",
    "export const f = () => readFileSync(join(here, '../../..', 'README.md'), 'utf8');\n",
    'export const f = (n) => readFileSync(new URL(`../../../docs/${n}`, import.meta.url));\n',
  ]) assert.match(scan('modules/M4-workshop/x.mjs', text).join('|'), /x\.mjs:1 (names|builds a path from) .*outside orchestrate\//, text);
  // Paths that stay in orchestrate/, an outside file the updater installs, and a check on a name are all allowed.
  assert.deepEqual(scan('modules/M10-rules/policy.mjs', [
    "import { parse } from '../../../scripts/blueprint/yaml-lite.mjs';",
    "const p = new URL('../../M10-rules/fixtures/policy.yaml', import.meta.url);",
    "const h = join(here, '..', 'hooks');",
    "const ok = (r) => !r.startsWith('../') && r !== '..';",
    'const t = `../${x}`;',
  ].join('\n')), []);
  // A file the updater does not install, next to one it does, is refused.
  assert.equal(scan('modules/M10-rules/policy.mjs', "import { s } from '../../../scripts/blueprint/schema-check.mjs';\n").length, 1);
  // Text the reader can't read is a finding, not a pass.
  assert.match(scan('a/b.mjs', 'const s = "open;\n').join('|'), /could not read it \(an unterminated string\)/);
});
