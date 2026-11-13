// job-config.test.mjs — the one checked job-config reader (L253). Run: node --test orchestrate/shared/job-config.test.mjs
// Every refusal is a real file fault where a test user can make one (a link, a mode, a place), and a port standing in
// for another owner where only root could make it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, fstatSync, symlinkSync, writeFileSync, linkSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './test-tmp.mjs';
import { readJobConfig } from './job-config.mjs';
import { installedLayout, copyRetrying, COPY_TRIES } from './job-config.test-helper.mjs';

const WIRING = 'modules/x/wiring.mjs';
function layout() {
  const L = installedLayout('orch-jobcfg-', { files: { [WIRING]: 'export async function wire() { return {}; }\n' } });
  const config = (more = {}) => L.write('job.json', { installRoot: L.installRoot, wiring: L.path(WIRING), ...more });
  return { ...L, config };
}
const refuses = (file, re, opts) => assert.throws(() => readJobConfig(file, opts), (e) => { assert.match(e.message, /^job config /); assert.match(e.message, re); return true; });

test('L253: the real installed layout passes, through the copy\'s link and through its real folder', () => {
  const L = layout();
  const c = readJobConfig(L.config());
  assert.equal(c.wiring, L.path(WIRING));
  const real = L.write('job2.json', { installRoot: L.installRoot, wiring: join(L.copy, WIRING) });
  assert.equal(readJobConfig(real).wiring, join(L.copy, WIRING));
  assert.equal(readJobConfig(join(L.copy, 'job.json')).installRoot, L.installRoot);
});

test('L253: a config owned by another user (a worker) is refused, and so is a copy that is not root\'s or the job\'s', () => {
  const L = layout();
  const f = L.config();
  refuses(f, /is owned by uid 4242, not by the installed copy's owner/, { fstat: (fd) => ({ ...fstatSync(fd), isFile: () => true, uid: 4242, mode: 0o100644 }) });
  const lst = (p) => (p === L.installRoot ? Object.assign(lstatSync(p), { uid: 4242 }) : lstatSync(p));
  refuses(f, /installed copy .* is owned by uid 4242, not root or this job's own user/, { lstat: lst });
  refuses(f, /not root or this job's own user/, { ownUid: 4243 });
});

test('L253: a config written by group or others, a linked config, and a config that is not a file are refused', () => {
  const L = layout();
  const f = L.config();
  chmodSync(join(L.copy, 'job.json'), 0o664);
  refuses(f, /can be written by group or others/);
  chmodSync(join(L.copy, 'job.json'), 0o644);
  symlinkSync(join(L.copy, 'job.json'), join(L.copy, 'link.json'));
  refuses(L.path('link.json'), /link\.json: is a link \(name the file itself\)$/);   // the descriptor open (O_NOFOLLOW)
  refuses(L.path('modules'), /is not a plain file|can't be opened/);
});

test('L253: a linked wiring, a wiring outside the copy, a test file as wiring, and a missing wiring are refused', () => {
  const L = layout();
  symlinkSync(join(L.copy, WIRING), join(L.copy, 'modules/x/link.mjs'));
  refuses(L.config({ wiring: L.path('modules/x/link.mjs') }), /job\.json: \/.*modules\/x\/link\.mjs is a link$/);   // the copy walk (installProblem)
  rmSync(join(L.copy, 'modules/x/link.mjs'));
  const outside = join(L.base, 'wiring.mjs'); writeFileSync(outside, 'export const wire = 1;\n', { mode: 0o644 });
  refuses(L.config({ wiring: outside }), /is not inside the installed copy/);
  L.write('modules/x/w.test.mjs', 'export const wire = 1;\n');
  refuses(L.config({ wiring: L.path('modules/x/w.test.mjs') }), /test files/);
  refuses(L.config({ wiring: L.path('modules/x/none.mjs') }), /missing/);
  refuses(L.config({ wiring: 'modules/x/wiring.mjs' }), /wiring must be a full path/);
  refuses(L.config({ wiring: undefined }), /wiring must be a full path/);
});

test('audit #144 m4: the job\'s own script (self) must be one of the copy\'s code files: outside the copy, a test file, or not named by a full path is refused', () => {
  const L = layout();
  const f = L.config();
  const self = L.write('modules/M11-dispatcher/main.mjs', 'export {};\n');
  assert.ok(readJobConfig(f, { self }));
  assert.ok(readJobConfig(f, { self: join(L.copy, 'modules/M11-dispatcher/main.mjs') }), 'by its real path, as a job names itself');
  refuses(f, /checkout-main\.mjs is not inside the installed copy/, { self: (() => { const p = join(L.base, 'checkout-main.mjs'); writeFileSync(p, 'export {};\n', { mode: 0o644 }); return p; })() });
  refuses(f, /the job's own script, .*main\.test\.mjs, is one of the copy's test files/, { self: L.write('modules/M11-dispatcher/main.test.mjs', 'export {};\n') });
  refuses(f, /the job's own script must be named by its full path/, { self: null });
  refuses(f, /the job's own script must be named by its full path/, { self: 'main.mjs' });
});

test('L253: a config outside the copy, a group-writable file in the copy, and a group-writable folder at or above the copy are refused', () => {
  const L = layout();
  const out = join(L.base, 'job.json');
  writeFileSync(out, JSON.stringify({ installRoot: L.installRoot, wiring: L.path(WIRING) }), { mode: 0o644 });
  refuses(out, /is not inside the installed copy/);
  const f = L.config();
  L.write('modules/x/other.mjs', 'export {};\n', 0o666);
  refuses(f, /can be written by others/);
  chmodSync(join(L.copy, 'modules/x/other.mjs'), 0o644);
  chmodSync(L.base, 0o775);
  refuses(f, /can be written by others/);
  chmodSync(L.base, 0o700);
  const up = dirname(L.base);
  refuses(f, new RegExp(`${up.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, above the installed copy, can be written by group or others`),
    { lstat: (p) => (p === up ? Object.assign(lstatSync(p), { mode: 0o40777 }) : lstatSync(p)) });
  refuses(f, /above the installed copy, is owned by uid 4242/, { lstat: (p) => (p === up ? Object.assign(lstatSync(p), { uid: 4242 }) : lstatSync(p)) });
});

test('L257 (A): a layout under a sticky world-writable folder (Linux /tmp, 1777) is refused; do not loosen this for CI', () => {
  const L = layout();
  const f = L.config();
  chmodSync(L.base, 0o1777);
  refuses(f, /can be written by others/);
  chmodSync(L.base, 0o700);
  const up = dirname(L.base);
  refuses(f, /above the installed copy, can be written by group or others/,
    { lstat: (p) => (p === up ? Object.assign(lstatSync(p), { uid: 0, mode: 0o41777 }) : lstatSync(p)) });
});

test('L253: an access list above or inside the copy is refused, and an unreadable one too', () => {
  const L = layout();
  const f = L.config();
  refuses(f, /has an access list/, { acl: (paths) => `${paths[0]} has an access list (ACL), which can let others write it (clear it with chmod -N)` });
  // Audit #144 m2: an access list only on a folder above the copy's own parent (the walk up to /) is refused too.
  const up = dirname(L.base);
  const aboveOnly = (paths) => (paths.includes(up) ? `${up} has an access list (ACL), which can let others write it (clear it with chmod -N)` : null);
  refuses(f, new RegExp(`${up.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has an access list`), { acl: aboveOnly });
  assert.ok(readJobConfig(f, { acl: (paths) => (paths.includes('/nowhere') ? 'x' : null) }), 'a stand-in that refuses nothing here passes');
});

test('L253: the file read is the file checked (a swap between the descriptor and the name is refused)', () => {
  const L = layout();
  const f = L.config();
  refuses(f, /changed while it was read/, { lstat: (p) => (p === f ? Object.assign(lstatSync(p), { ino: lstatSync(p).ino + 1 }) : lstatSync(p)) });
});

test('L253: a config that is not a JSON object, or names no installRoot, is refused; optional code keys are checked when present', () => {
  const L = layout();
  refuses(L.write('a.json', '[1]'), /must be a JSON object/);
  refuses(L.write('b.json', '{nope'), /is not JSON/);
  refuses(L.write('c.json', { wiring: L.path(WIRING) }), /installRoot must be a full path/);
  refuses(L.write('d.json', { installRoot: join(L.base, 'none'), wiring: L.path(WIRING) }), /installRoot .* is missing/);
  const f = L.config({ budget: join(L.base, 'budget.mjs') });
  assert.ok(readJobConfig(f));
  refuses(f, /budget, .* is not inside the installed copy|budget.mjs is not inside/, { optionalCode: ['budget'] });
  refuses('job.json', /must be a full path/);
  const hard = join(L.copy, 'hard.json'); linkSync(join(L.copy, 'job.json'), hard);
  assert.ok(readJobConfig(L.path('hard.json')), 'a second name of a checked file is the same file');
});

// ---- L253 guard: no job loads a config-named module through a config it did not read with this reader ----
// Pinned the way consume-ask's ALLOWED pins counts (audit #144 m1): every production file with a computed import is on
// LOADERS, holds each pinned line exactly as many times as it says (comments aside), and makes exactly `imports`
// computed imports. Reader text anywhere is not enough: a job that parses its own config while still importing the
// reader (plant P11), or that builds the URL ahead of the import (P16), changes a pinned line and fails here. And no
// such file may parse its argument itself (JSON.parse of argv, or a read of argv's file).
const ORCH = fileURLToPath(new URL('..', import.meta.url));
// Built, so consume-ask's computed-import scan does not count the pinned text below as a loader of this file's own.
const IMPORT = ['im', 'port'].join('');
export const LOADERS = {
  'modules/M11-dispatcher/main.mjs': { imports: 2, noReads: true, pins: [
    ['  const w = new Worker(code, { eval: true, workerData: { ms, pid: process.pid } });', 1],
    ["  const c = readJobConfig(file, { code: ['wiring'], ...opts });", 1],
    ['readConfigFn = readConfig, self = SELF } = {}) {', 1],
    ['    config = readConfigFn(argv[0], { self });', 1],
    [`    const mod = await ${IMPORT}(pathToFileURL(config.wiring).href);`, 1]] },
  'wiring/robot-main.mjs': { imports: 1, noReads: true, pins: [
    ["import { readConfig, startWatchdog, WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';", 1],
    ['    config = readConfig(argv[0], { self });', 1],
    [`    const mod = await ${IMPORT}(pathToFileURL(config.wiring).href);`, 1]] },
  'modules/M12-sensors/loop.mjs': { imports: 1, noReads: true, pins: [
    ["  return readJobConfig(file, { code: ['wiring'], ...opts });", 1],
    ['runDeadlineMs = RUN_DEADLINE_MS, self = SELF } = {}) {', 1],
    ['    const config = readConfig(argv[0], { self });', 1],
    [`    const mod = await ${IMPORT}(pathToFileURL(config.wiring).href);`, 1]] },
  'modules/M4-workshop/launcher/review-runner-main.mjs': { imports: 2, pins: [
    ['  const c = openJobJson(file, (why) => { throw new Error(`config: ${file} ${why}`); }).value;', 1],
    ['  const { readConfigFn = readConfig, programs = programsProblem, pass = runnerPass, write, lstat } = ports;', 1],
    ['  try { c = readConfigFn(argv[0]); } catch (e) {', 1],
    ['  const bad = programs(c, { self, config: realpathSync.native(argv[0]) });', 1],
    ['  const swapped = readConfigFn === readConfig || readByDescriptor(c) ? readChangedProblem(argv[0], c, lstat ? { lstat } : {}) : null;', 1],
    [`  try { wiring = await ${IMPORT}(pathToFileURL(c.wiring).href); } catch (e) {`, 1],
    [`    try { budget = await (await ${IMPORT}(pathToFileURL(c.budget).href)).budget({ ...c, reviewStatusFile: typeof c.root === 'string' ? join(c.root, FOLDERS.status) : undefined, reviewUid: c.uids?.reviewer }); } catch (e) {`, 1]] },
  // Check 12 (L1042): the worker runner loads the budget module named by its config, read through the checked reader.
  'wiring/runner-main.mjs': { imports: 1, pins: [
    ["export async function main(argv, { readConfig = (f) => { const self = selfPath(); if (!self) throw new Error('its own script\\'s path can\\'t be read, so it can\\'t be checked'); return readJobConfig(f, { code: [], optionalCode: ['budget'], self }); }, lock = (dir) => makeLock({ dir, timeoutMs: 2_000 }),", 1],
    ['  try { c = checkRunnerConfig(readConfig(argv[0])); } catch (e) {', 1],
    [`export async function importBudget(file, config) { return (await ${IMPORT}(pathToFileURL(file).href)).budget(config); }`, 1]] },
};
const CALL_ANY = /(?<![\w$.])import\s*\(/g;
const CALL_LIT = /(?<![\w$.])import\s*\(\s*(['"`])[^'"`$]+\1\s*\)/g;
// A Worker or a create-require runs code it is handed, so it is a loader too (audit #144 r2 n1): counted with the computed
// imports, and pinned like them (the Dispatcher's watchdog is one, with its code written out in main.mjs).
// Built like IMPORT, so consume-ask's scan does not count the word here as a loader of this file's own.
const CREATE_REQUIRE = ['create', 'Require'].join('');
const CALL_RUN = new RegExp(`(?<![\\w$.])(?:new\\s+Worker|${CREATE_REQUIRE})\\s*\\(`, 'g');
// A job marked noReads reads no file and parses no JSON itself (audit #144 r2 n1): its config comes only through the
// reader, so a parse ahead of it (`const own = JSON.parse(readFileSync(file)); if (!own.installRoot) return own;`) is refused.
const OWN_READ = /(?<![\w$])(?:JSON\.parse|readFileSync)\b/;
const SELF_PARSE = /JSON\.parse\([^;]*\bargv\b|readFileSync\(\s*(?:process\.)?argv\b/;
const uncomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/(^|[^:'"`])\/\/(?![^\n]*['"`]\)).*$/gm, '$1');
const count = (text, needle) => text.split(needle).length - 1;
function productionFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules' || n === 'fixtures' || n.startsWith('.')) continue;
    if (statSync(p).isDirectory()) out.push(...productionFiles(p));
    else if (n.endsWith('.mjs') && !/\.test(-helper)?\.mjs$/.test(n)) out.push(p);
  }
  return out;
}
/** What is wrong with every production file under `root` that makes a computed import, against `loaders`. */
export function unreadConfigLoaders(root, loaders = LOADERS) {
  const out = [];
  for (const f of productionFiles(root)) {
    const rel = relative(root, f).split('\\').join('/');
    const text = uncomment(readFileSync(f, 'utf8'));
    const computed = (text.match(CALL_ANY) ?? []).length - (text.match(CALL_LIT) ?? []).length + (text.match(CALL_RUN) ?? []).length;
    if (computed === 0) { if (loaders[rel]) out.push(`${rel}: on LOADERS but makes no computed import`); continue; }
    const pin = loaders[rel];
    if (!pin) { out.push(`${rel}: makes ${computed} computed imports and is not on LOADERS`); continue; }
    if (computed !== pin.imports) out.push(`${rel}: makes ${computed} computed imports, not ${pin.imports}`);
    for (const [line, n] of pin.pins) { const c = count(text, line); if (c !== n) out.push(`${rel}: holds "${line.trim()}" ${c} time(s), not ${n}`); }
    if (SELF_PARSE.test(text)) out.push(`${rel}: parses its argument itself`);
    if (pin.noReads && OWN_READ.test(text)) out.push(`${rel}: reads or parses a file itself (JSON.parse or readFileSync); its config comes only through the reader`);
  }
  return out;
}

test('L253 guard: every production file that imports a config-named module reads its config through the checked reader, as pinned', () => {
  assert.deepEqual(unreadConfigLoaders(ORCH), []);
});

test('L253 guard, planted (audit #144 m1): own JSON.parse beside the reader, a pre-built URL, an unlisted loader, a commented reader', () => {
  // Built, so consume-ask's computed-import scan does not count this test's own planted text as a loader.
  const IMP = ['im', 'port'].join('');
  const root = tempDir('orch-jobguard-');
  const w = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  const load = `    const mod = await ${IMP}(pathToFileURL(config.wiring).href);`;
  const pins = { 'wiring/ok.mjs': { imports: 1, pins: [['    config = readConfig(argv[0], { self });', 1], [load, 1]] } };
  const good = `    config = readConfig(argv[0], { self });\n${load}\n`;
  w('wiring/ok.mjs', good);
  w('modules/Mx/job.test.mjs', `await ${IMP}(pathToFileURL(c.wiring).href);\n`);   // a test file is not production code
  w('modules/Mz/static.mjs', `const m = await ${IMP}('./x.mjs');\n`);                // a plain string is not computed
  assert.deepEqual(unreadConfigLoaders(root, pins), []);
  // P11: the reader still imported and called, but the module comes from the job's own parse.
  w('wiring/ok.mjs', `    config = readConfig(argv[0], { self });\nconst own = JSON.parse(readFileSync(argv[0], 'utf8'));\n    const mod = await ${IMP}(pathToFileURL(own.wiring).href);\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), [`wiring/ok.mjs: holds "${load.trim()}" 0 time(s), not 1`, 'wiring/ok.mjs: parses its argument itself']);
  // P16: the URL built ahead of the import.
  w('wiring/ok.mjs', `    config = readConfig(argv[0], { self });\nconst u = pathToFileURL(config.wiring).href;\nconst mod = await ${IMP}(u);\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), [`wiring/ok.mjs: holds "${load.trim()}" 0 time(s), not 1`]);
  // A second load, the reader only in a comment, and a loader no one listed.
  w('wiring/ok.mjs', `${good}${load}\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), ['wiring/ok.mjs: makes 2 computed imports, not 1', `wiring/ok.mjs: holds "${load.trim()}" 2 time(s), not 1`]);
  w('wiring/ok.mjs', `//    config = readConfig(argv[0], { self });\n${load}\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), ['wiring/ok.mjs: holds "config = readConfig(argv[0], { self });" 0 time(s), not 1']);
  w('wiring/ok.mjs', good);
  w('modules/My/half.mjs', `const c = openJobJson(f, fail).value;\nawait ${IMP}(new URL(c.wiring, 'file:').href);\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), ['modules/My/half.mjs: makes 1 computed imports and is not on LOADERS']);
});

test('L253 guard, planted (audit #144 r2 n1): a job that reads its own config ahead of the reader; a Worker or a create-require loads', () => {
  const IMP = ['im', 'port'].join('');
  const root = tempDir('orch-jobguard-');
  const w = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  const load = `    const mod = await ${IMP}(pathToFileURL(config.wiring).href);`;
  const reader = "  return readJobConfig(file, { code: ['wiring'], ...opts });";
  const pins = { 'wiring/ok.mjs': { imports: 1, noReads: true, pins: [[reader, 1], [load, 1]] } };
  const good = `${reader}\n${load}\n`;
  w('wiring/ok.mjs', good);
  assert.deepEqual(unreadConfigLoaders(root, pins), []);
  // The audit's plant: the job parses its own file and returns it when it names no installRoot, before the reader.
  w('wiring/ok.mjs', `  const own = JSON.parse(readFileSync(file, 'utf8')); if (!own.installRoot) return own;\n${good}`);
  assert.deepEqual(unreadConfigLoaders(root, pins), ['wiring/ok.mjs: reads or parses a file itself (JSON.parse or readFileSync); its config comes only through the reader']);
  // Either one alone is refused.
  w('wiring/ok.mjs', `  const own = JSON.parse(text);\n${good}`);
  assert.equal(unreadConfigLoaders(root, pins).length, 1);
  w('wiring/ok.mjs', `  const text = fs.readFileSync(file, 'utf8');\n${good}`);
  assert.equal(unreadConfigLoaders(root, pins).length, 1);
  // A file not marked noReads may read (the review runner reads its own records).
  w('wiring/ok.mjs', `  const own = JSON.parse(text);\n${good}`);
  assert.deepEqual(unreadConfigLoaders(root, { 'wiring/ok.mjs': { ...pins['wiring/ok.mjs'], noReads: false } }), []);
  // A Worker or a create-require is a load: one more than pinned, or an unlisted loader.
  w('wiring/ok.mjs', `${good}  const t = new Worker(config.wiring);\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), ['wiring/ok.mjs: makes 2 computed imports, not 1']);
  w('wiring/ok.mjs', good);
  w('modules/My/req.mjs', `const req = ${CREATE_REQUIRE}(import.meta.url);\nreq(c.wiring);\n`);
  assert.deepEqual(unreadConfigLoaders(root, pins), ['modules/My/req.mjs: makes 1 computed imports and is not on LOADERS']);
});

test('audit #144 r2 c1: the source copy is redone when a file was gone, up to 5 tries, then throws; any other error throws at once', () => {
  const gone = () => Object.assign(new Error('gone'), { code: 'ENOENT' });
  assert.equal(COPY_TRIES, 5);
  // Gone twice, then copied: three tries, two resets.
  let calls = 0; let resets = 0;
  assert.equal(copyRetrying(() => { calls += 1; if (calls < 3) throw gone(); }, () => { resets += 1; }), 3);
  assert.deepEqual([calls, resets], [3, 2]);
  // Gone every time: five tries, four resets, then the last error.
  calls = 0; resets = 0;
  assert.throws(() => copyRetrying(() => { calls += 1; throw gone(); }, () => { resets += 1; }), { code: 'ENOENT' });
  assert.deepEqual([calls, resets], [5, 4]);
  // Any other error: thrown on the first try, nothing reset.
  for (const code of ['EACCES', 'EEXIST', undefined]) {
    calls = 0; resets = 0;
    assert.throws(() => copyRetrying(() => { calls += 1; throw Object.assign(new Error('other'), { code }); }, () => { resets += 1; }), { message: 'other' });
    assert.deepEqual([calls, resets], [1, 0], `code ${code}`);
  }
});
