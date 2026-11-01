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

// Static `import … from` / `export … from`, with any quote (a backtick is matched too, so a check never depends on it).
const STATIC = /\b(?:import|export)\s*([^;]*?)\s*from\s*(['"`])([^'"`]+)\2/g;
// A dynamic import or require whose argument is one plain string (no `${`), and every dynamic import or require.
const CALL_LIT = /\b(?:import|require)\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const CALL_ANY = /\b(?:import|require)\s*\(/g;
// In an M2 file: an export that hands writeDoc itself on (`export { writeDoc }`, `export { writeDoc as w }`,
// `export default writeDoc`, `export const w = writeDoc`). A function that only calls it exports nothing of it.
const EXPORTS_WRITEDOC = /\bexport\s*\{[^}]*\bwriteDoc\b[^}]*\}|\bexport\s+default\s+writeDoc\s*(?:[;\n]|$)|\bexport\s+(?:const|let|var)\s+[\w$]+\s*=\s*writeDoc\s*(?:[;\n]|$)/;
const STAR_FROM = /\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"`])([^'"`]+)\1/g;

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

// Where a specifier points: a relative path, an absolute path, or a file:// URL (a query or hash is dropped). A bare
// package name points at no file of ours.
function target(file, spec) {
  const s = spec.replace(/[?#].*$/, '');
  if (s.startsWith('file:')) { try { return fileURLToPath(s); } catch { return null; } }
  if (s.startsWith('/')) return resolve(s);
  if (s.startsWith('.')) return resolve(dirname(file), s);
  return null;
}

// Every file under `orchestrate/` (L95, audit stack r3 Minor 8: not only modules/) that reaches writeDoc:
//   outside M2: a named import or re-export of it, a namespace import or `export *` of ask-store, a dynamic import or
//     require of ask-store, or, in a file that names ask-store, any dynamic import or require that isn't one plain
//     string (a computed or template specifier could be ask-store);
//   inside M2 (its own tests aside): a file that re-exports writeDoc or does `export *` from ask-store, since an
//     outside module could then reach it through that file.
export function writeDocImporters(orchRoot) {
  const m2 = resolve(orchRoot, 'modules', 'M2-approvals');
  const store = join(m2, 'ask-store.mjs');
  const found = [];
  for (const f of filesUnder(orchRoot)) {
    if (f === store) continue;
    const text = readFileSync(f, 'utf8');
    const rel = relative(orchRoot, f);
    if (f.startsWith(`${m2}/`)) {
      if (/\.test\.mjs$/.test(f)) continue;
      const star = [...text.matchAll(STAR_FROM)].some((m) => target(f, m[2]) === store);
      if (star || EXPORTS_WRITEDOC.test(text)) found.push(rel);
      continue;
    }
    const hit = [...text.matchAll(STATIC)].some((m) => target(f, m[3]) === store && /\bwriteDoc\b|\*/.test(m[1]))
      || [...text.matchAll(CALL_LIT)].some((m) => target(f, m[2]) === store)
      || (text.includes('ask-store') && [...text.matchAll(CALL_ANY)].length > [...text.matchAll(CALL_LIT)].length);
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
  writeFileSync(join(m2, 'go.mjs'), "import { writeDoc } from './ask-store.mjs';\nexport const go = () => writeDoc;\n");
  writeFileSync(join(m2, 'go.test.mjs'), "export { writeDoc } from './ask-store.mjs';\n"); // M2's own tests may
  const m2cases = {
    'relay.mjs': "export { writeDoc } from './ask-store.mjs';\n",
    'relay2.mjs': "import { writeDoc } from './ask-store.mjs';\nexport { writeDoc as w };\n",
    'starry.mjs': "export * from './ask-store.mjs';\n",
    'dflt.mjs': "import { writeDoc } from './ask-store.mjs';\nexport default writeDoc;\n",
    'alias.mjs': "import { writeDoc } from './ask-store.mjs';\nexport const w = writeDoc;\n",
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
    'other.mjs': "const p = 'x'; const y = await import(p);\n", // names no ask-store: not ours to judge
  };
  for (const [name, text] of Object.entries(cases)) writeFileSync(join(root, 'modules', 'M11-dispatcher', name), text);
  writeFileSync(join(root, 'shared', 'outside.mjs'), "import { writeDoc } from '../modules/M2-approvals/ask-store.mjs';\n");
  const got = writeDocImporters(root).sort();
  const want = [
    ...['named', 'renamed', 'star', 'reexport', 'dynamic', 'template', 'computed', 'interp', 'absolute', 'fileurl', 'required', 'dquote', 'dqcall', 'sub/deep']
      .map((n) => `modules/M11-dispatcher/${n}.mjs`),
    ...Object.keys(m2cases).map((n) => `modules/M2-approvals/${n}`),
    'shared/outside.mjs',
  ].sort();
  assert.deepEqual(got, want);
});
