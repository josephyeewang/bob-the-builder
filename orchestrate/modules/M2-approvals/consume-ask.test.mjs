// consume-ask.test.mjs — L85 m-3: the narrow consumeAsk other modules use (answered → consumed only), and the check
// that no module outside M2 imports M2's raw writer, writeDoc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { env, must } from './fixtures.test-helper.mjs';
import { NOTE_KEYS, askStore, consumeAsk, writeDoc } from './ask-store.mjs';
import { createAsk } from './binding.mjs';

const ORCH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function world(state = 'answered') {
  const t = env();
  must(createAsk(t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which export format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  const at = new Date(t.clock.t).toISOString();
  const answer = { channel: 'github_review', choice: 'CSV', approves: true, at };
  // The record allows only the real moves, so walk the ask there: open → pushed → answered → consumed.
  const steps = { open: [], pushed: ['pushed'], answered: ['pushed', 'answered'], consumed: ['pushed', 'answered', 'consumed'] }[state];
  for (const s of steps) {
    const a = askStore(t.record).ask('D-1');
    const add = { pushed: { raised_at: at, raised_reask: 0 }, answered: { answer }, consumed: { consumed_at: at } }[s];
    must(writeDoc(t.record, 'ask', a, { ...a.doc, ...add, state: s }), s);
  }
  return t;
}
const doc = (t) => t.record.read('ask', 'D-1').doc;

test('consumeAsk moves an answered ask to consumed, sets consumed_at, and adds the note', () => {
  const t = world();
  const before = doc(t);
  const r = consumeAsk(t.ctx, 'D-1', { kept_at_card_change: 3 });
  assert.equal(r.ok, true, r.reason);
  const after = doc(t);
  assert.equal(after.state, 'consumed');
  assert.equal(after.consumed_at, new Date(t.clock.t).toISOString());
  assert.equal(after.kept_at_card_change, 3);
  assert.deepEqual(after.answer, before.answer);
  // Written as approvals, so M2's own reader still trusts it.
  assert.equal(askStore(t.record).ask('D-1').doc.state, 'consumed');
});

test('consumeAsk refuses every state but answered, and an ask that does not exist', () => {
  for (const state of ['open', 'pushed', 'consumed']) {
    const t = world(state);
    const r = consumeAsk(t.ctx, 'D-1');
    assert.equal(r.ok, false, state);
    assert.match(r.reason, new RegExp(`is ${state}, not answered`));
    assert.equal(doc(t).state, state, `${state} is left as it was`);
  }
  const t = world();
  assert.match(consumeAsk(t.ctx, 'D-9').reason, /no trusted ask D-9/);
  // Consumed once; a second call is refused.
  must(consumeAsk(t.ctx, 'D-1'));
  assert.equal(consumeAsk(t.ctx, 'D-1').ok, false);
});

test('the note may only add new fields: never the state, the answer, consumed_at or a field already there', () => {
  for (const note of [{ state: 'answered' }, { answer: { choice: 'JSON' } }, { consumed_at: 'x' }, { kind: 'go_t2' }, { title: 'new' },
    { 'Bad-Key': 1 }, { __proto__x: 1 }]) {
    const t = world();
    const r = consumeAsk(t.ctx, 'D-1', note);
    assert.equal(r.ok, false, JSON.stringify(note));
    assert.equal(doc(t).state, 'answered');
  }
  for (const note of [null, [], 'x', new Map()]) assert.equal(consumeAsk(world().ctx, 'D-1', note).ok, false, String(note));
});

// L95 (audit stack r3 Minor 7, probes P8a and P8b): only the cleanup's two keys, with plain values. A `wait` would put
// the consumed ask back on the owner's waiting list; a `request` naming a report would stop it ever opening.
test('L95 Minor 7: the note is allow-listed to kept_at_card_change and not_deleted, with plain values', () => {
  for (const note of [{ wait: { who: 'joe', what: 'x', since: 'y' } }, { request: 'report-1' }, { pr: 7 }, { card_override: 'C-2' },
    { next_check: 'x' }, { kept_at_card_change: { a: 1 } }, { not_deleted: ['x'] }, { not_deleted: 'x'.repeat(501) },
    { kept_at_card_change: Number.NaN }, { [Symbol('s')]: 1 }]) {
    const t = world();
    const r = consumeAsk(t.ctx, 'D-1', note);
    assert.equal(r.ok, false, String(Object.keys(note)));
    assert.equal(doc(t).state, 'answered');
    assert.equal(Object.hasOwn(doc(t), 'wait'), false);
  }
  assert.deepEqual([...NOTE_KEYS], ['kept_at_card_change', 'not_deleted']);
  const t = world();
  must(consumeAsk(t.ctx, 'D-1', { kept_at_card_change: 4, not_deleted: 'the copy is not the Dispatcher\'s own' }));
  assert.equal(doc(t).not_deleted, 'the copy is not the Dispatcher\'s own');
  must(consumeAsk(world().ctx, 'D-1', { not_deleted: null }));
});

// L95 (stack r3 Minor 10, plant m-3-4): an ask whose latest diary line another actor wrote is not M2's, so it is refused.
test('L95 Minor 10: consumeAsk refuses an ask whose last diary line another actor wrote', () => {
  const t = world();
  const cur = t.record.read('ask', 'D-1');
  t.store.transaction((tx) => tx.commit([{ entity: 'ask', id: 'D-1', doc: { ...cur.doc } }], { actor: 'dispatcher', kind: 'seed' }));
  assert.equal(t.record.read('ask', 'D-1').doc.state, 'answered', 'the raw record still says answered');
  const r = consumeAsk(t.ctx, 'D-1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no trusted ask D-1/);
  assert.equal(t.record.read('ask', 'D-1').doc.state, 'answered');
});

// ---- no module outside M2 imports writeDoc ----

// L117 m-5: comments are cut first (a comment between the keyword and the path hid a route), every specifier is
// resolved as a URL from the file (relative, absolute, percent-encoded, file://, a query or hash), and every
// non-literal import(), require() or createRequire anywhere under orchestrate/ fails unless it is on ALLOWED below.
const uncomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/\\'"`])\/\/.*$/gm, '$1');
// Static `import … from` / `export … from`, with any quote (a backtick is matched too, so a check never depends on it).
const STATIC = /\b(?:import|export)\s*([^;]*?)\s*from\s*(['"`])([^'"`]+)\2/g;
// A dynamic import or require whose argument is one plain string (no `${`), and every dynamic import or require.
const CALL_LIT = /(?<![\w$.])(?:import|require)\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const CALL_ANY = /(?<![\w$.])(?:import|require)\s*\(/g;
const STAR_FROM = /\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"`])([^'"`]+)\1/g;
// The files that load a module by a computed name today, each with its count (a wiring or budget file named in a
// config, a copy made by a test, or text inside a test's string). A new one, or one more in these, fails.
export const ALLOWED = Object.freeze({
  'modules/M11-dispatcher/main.mjs': 1,
  'modules/M11-dispatcher/tick.test.mjs': 1,
  'modules/M4-workshop/git/refusal-reasons.test.mjs': 1,
  'modules/M4-workshop/hooks/attacks.test.mjs': 1,
  'modules/M4-workshop/launcher/review-runner-main.mjs': 2,
  'modules/M4-workshop/launcher/review-updater.test.mjs': 1,
  'modules/M6-merge-gate/build-checker.test.mjs': 1,
});

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (/\.[cm]?js$/.test(e.name)) out.push(p);
  }
  return out;
}

// Where a specifier points, resolved the way Node resolves a path or file URL. A bare package name points at no file of ours.
function target(file, spec) {
  if (!/^(?:\.{1,2}\/|\/|file:)/.test(spec)) return null;
  try { return fileURLToPath(new URL(spec, pathToFileURL(file))); } catch { return null; }
}

// Every file under `orchestrate/` (L95, audit stack r3 Minor 8: not only modules/) that reaches writeDoc:
//   outside M2: a named import or re-export of it, a namespace import or `export *` of ask-store, or a dynamic import or
//     require of ask-store;
//   anywhere but this file: a non-literal import(), require() or any createRequire beyond ALLOWED (it could be ask-store);
//   inside M2 (its own tests aside): a file that does `export *` from ask-store, or names writeDoc other than to call it
//     (an export, an object, a return, an alias), since an outside module could then reach it through that file.
export function writeDocImporters(orchRoot, allowed = ALLOWED) {
  const m2 = resolve(orchRoot, 'modules', 'M2-approvals');
  const store = join(m2, 'ask-store.mjs');
  const self = fileURLToPath(import.meta.url);
  const found = [];
  for (const f of filesUnder(orchRoot)) {
    if (f === store || f === self) continue;
    const text = uncomment(readFileSync(f, 'utf8'));
    const rel = relative(orchRoot, f);
    const computed = [...text.matchAll(CALL_ANY)].length - [...text.matchAll(CALL_LIT)].length + (text.match(/\bcreateRequire\b/g) ?? []).length;
    if (computed > (allowed[rel] ?? 0)) found.push(rel);
    if (f.startsWith(`${m2}/`)) {
      if (/\.test\.mjs$/.test(f) || /\.test-helper\.mjs$/.test(f)) continue;
      const star = [...text.matchAll(STAR_FROM)].some((m) => target(f, m[2]) === store)
        || [...text.matchAll(STATIC)].some((m) => m[0].startsWith('export') && target(f, m[3]) === store && /\bwriteDoc\b/.test(m[1]));
      const body = text.replace(STATIC, ' ');
      if (star || /\bwriteDoc\b(?!\s*\()/.test(body)) found.push(rel);
      continue;
    }
    const hit = [...text.matchAll(STATIC)].some((m) => target(f, m[3]) === store && /\bwriteDoc\b|\*/.test(m[1]))
      || [...text.matchAll(CALL_LIT)].some((m) => target(f, m[2]) === store);
    if (hit) found.push(rel);
  }
  return [...new Set(found)];
}

test('no module in orchestrate/ outside M2 reaches writeDoc, and no M2 file re-exports it (M6 may still read through askStore)', () => {
  assert.deepEqual(writeDocImporters(ORCH), []);
});

test('planted: every route to writeDoc is caught, from any folder of orchestrate/', () => {
  const t = env();
  const root = join(t.base, 'orchestrate');
  const m2 = join(root, 'modules', 'M2-approvals');
  const store = join(m2, 'ask-store.mjs');
  mkdirSync(m2, { recursive: true });
  mkdirSync(join(root, 'modules', 'M11-dispatcher', 'sub'), { recursive: true });
  mkdirSync(join(root, 'shared'), { recursive: true });
  writeFileSync(store, 'export const writeDoc = 1;\nexport const askStore = 2;\n');
  writeFileSync(join(m2, 'go.mjs'), "import { writeDoc } from './ask-store.mjs';\nexport const go = (r) => writeDoc(r, 'go', null, {});\n"); // only calls it
  writeFileSync(join(m2, 'go.test.mjs'), "export { writeDoc } from './ask-store.mjs';\n"); // M2's own tests may
  const m2cases = {
    'relay.mjs': "export { writeDoc } from './ask-store.mjs';\n",
    'relay2.mjs': "import { writeDoc } from './ask-store.mjs';\nexport { writeDoc as w };\n",
    'starry.mjs': "export * from './ask-store.mjs';\n",
    'dflt.mjs': "import { writeDoc } from './ask-store.mjs';\nexport default writeDoc;\n",
    'alias.mjs': "import { writeDoc } from './ask-store.mjs';\nexport const w = writeDoc;\n",
    'inobj.mjs': "import { writeDoc } from './ask-store.mjs';\nexport const tools = { writeDoc };\n",
    'infn.mjs': "import { writeDoc } from './ask-store.mjs';\nexport function writer() { return writeDoc; }\n",
  };
  for (const [name, text] of Object.entries(m2cases)) writeFileSync(join(m2, name), text);
  const cases = {
    'named.mjs': "import { askStore, writeDoc } from '../M2-approvals/ask-store.mjs';\n",
    'renamed.mjs': "import {\n  writeDoc as w,\n} from '../M2-approvals/ask-store.mjs';\n",
    'star.mjs': "import * as store from '../M2-approvals/ask-store.mjs';\n",
    'reexport.mjs': "export { writeDoc } from '../M2-approvals/ask-store.mjs';\n",
    'dynamic.mjs': "const s = await import('../M2-approvals/ask-store.mjs');\n",
    'template.mjs': "const s = await import(`../M2-approvals/ask-store.mjs`);\n",
    'computed.mjs': "const d = '../M2-approvals/'; const s = await import(d + 'ask-store.mjs');\n",
    'interp.mjs': "const n = 'ask-store'; const s = await import(`../M2-approvals/${n}.mjs`);\n",
    'absolute.mjs': `import { writeDoc } from '${store}';\n`,
    'fileurl.mjs': `import { writeDoc } from '${pathToFileURL(store).href}?v=1';\n`,
    'required.mjs': "const { writeDoc } = require('../M2-approvals/ask-store.mjs');\n",
    'dquote.mjs': 'import { writeDoc } from "../M2-approvals/ask-store.mjs";\n',
    'dqcall.mjs': 'const s = await import("../M2-approvals/ask-store.mjs");\n',
    'sub/deep.mjs': "import { writeDoc } from '../../M2-approvals/ask-store.mjs';\n",
    'fine.mjs': "import { askStore, consumeAsk } from '../M2-approvals/ask-store.mjs';\nconst x = await import('./other.mjs');\n",
    'other.mjs': "const p = 'x'; const y = await import(p);\n", // L117 m-5: any computed import is caught now
    'concat.mjs': "const s = await import('../M2-approvals/ask' + '-store.mjs');\n",
    'pct.mjs': "import { writeDoc } from '../M2-approvals/ask%2Dstore.mjs';\n",
    'comment.mjs': "import { writeDoc } from /* c */ '../M2-approvals/ask-store.mjs';\n",
    'creq.mjs': "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nconst s = r('../M2-approvals/ask-store.mjs');\n",
    'cjs.cjs': "const { writeDoc } = require('../M2-approvals/ask-store.mjs');\n",
    'commented.mjs': "// import { writeDoc } from '../M2-approvals/ask-store.mjs';\nimport { askStore } from '../M2-approvals/ask-store.mjs';\n",
  };
  for (const [name, text] of Object.entries(cases)) writeFileSync(join(root, 'modules', 'M11-dispatcher', name), text);
  writeFileSync(join(root, 'shared', 'outside.mjs'), "import { writeDoc } from '../modules/M2-approvals/ask-store.mjs';\n");
  const got = writeDocImporters(root).sort();
  const want = [
    ...['named', 'renamed', 'star', 'reexport', 'dynamic', 'template', 'computed', 'interp', 'absolute', 'fileurl', 'required', 'dquote', 'dqcall', 'sub/deep',
      'other', 'concat', 'pct', 'comment', 'creq'].map((n) => `modules/M11-dispatcher/${n}.mjs`),
    'modules/M11-dispatcher/cjs.cjs',
    ...Object.keys(m2cases).map((n) => `modules/M2-approvals/${n}`),
    'shared/outside.mjs',
  ].sort();
  assert.deepEqual(got, want);
  // An allowed file with one more computed import than its count is caught; the count itself passes.
  writeFileSync(join(root, 'modules', 'M11-dispatcher', 'other.mjs'), 'const y = await import(p);\n');
  assert.ok(!writeDocImporters(root, { 'modules/M11-dispatcher/other.mjs': 1 }).includes('modules/M11-dispatcher/other.mjs'));
  writeFileSync(join(root, 'modules', 'M11-dispatcher', 'other.mjs'), 'const y = await import(p); const z = await import(q);\n');
  assert.ok(writeDocImporters(root, { 'modules/M11-dispatcher/other.mjs': 1 }).includes('modules/M11-dispatcher/other.mjs'));
});
