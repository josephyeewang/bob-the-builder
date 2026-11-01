// consume-ask.test.mjs — L85 m-3: the narrow consumeAsk other modules use (answered → consumed only), and the check
// that no module outside M2 imports M2's raw writer, writeDoc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, must } from './fixtures.test-helper.mjs';
import { askStore, consumeAsk, writeDoc } from './ask-store.mjs';
import { createAsk } from './binding.mjs';

const MODULES = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- no module outside M2 imports writeDoc ----

const IMPORT = /\b(?:import|export)\s*([^;]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

// Every file outside M2-approvals that reaches writeDoc: a named import or re-export of it, a namespace import or
// `export *` of ask-store, or a dynamic import of ask-store (which can reach it).
export function writeDocImporters(modulesRoot) {
  const store = resolve(modulesRoot, 'M2-approvals', 'ask-store.mjs');
  const m2 = resolve(modulesRoot, 'M2-approvals');
  const found = [];
  for (const f of filesUnder(modulesRoot)) {
    if (f.startsWith(`${m2}/`)) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[2] ?? m[3];
      if (!spec.startsWith('.') || resolve(dirname(f), spec) !== store) continue;
      if (m[3] || /\bwriteDoc\b|\*/.test(m[1])) found.push(relative(modulesRoot, f));
    }
  }
  return [...new Set(found)];
}

test('no module outside M2 imports writeDoc (M6 may still read through askStore)', () => {
  assert.deepEqual(writeDocImporters(MODULES), []);
});

test('planted: a module outside M2 that imports writeDoc is caught, in every way it could', () => {
  const t = env();
  const root = join(t.base, 'modules');
  mkdirSync(join(root, 'M2-approvals'), { recursive: true });
  mkdirSync(join(root, 'M11-dispatcher', 'sub'), { recursive: true });
  writeFileSync(join(root, 'M2-approvals', 'ask-store.mjs'), 'export const writeDoc = 1;\n');
  writeFileSync(join(root, 'M2-approvals', 'go.mjs'), "import { writeDoc } from './ask-store.mjs';\n");
  const cases = {
    'named.mjs': "import { askStore, writeDoc } from '../M2-approvals/ask-store.mjs';\n",
    'renamed.mjs': "import {\n  writeDoc as w,\n} from '../M2-approvals/ask-store.mjs';\n",
    'star.mjs': "import * as store from '../M2-approvals/ask-store.mjs';\n",
    'reexport.mjs': "export { writeDoc } from '../M2-approvals/ask-store.mjs';\n",
    'dynamic.mjs': "const s = await import('../M2-approvals/ask-store.mjs');\n",
    'sub/deep.mjs': "import { writeDoc } from '../../M2-approvals/ask-store.mjs';\n",
    'fine.mjs': "import { askStore, consumeAsk } from '../M2-approvals/ask-store.mjs';\n",
  };
  for (const [name, text] of Object.entries(cases)) writeFileSync(join(root, 'M11-dispatcher', name), text);
  const got = writeDocImporters(root).sort();
  assert.deepEqual(got, ['named', 'renamed', 'star', 'reexport', 'dynamic', 'sub/deep'].map((n) => `M11-dispatcher/${n}.mjs`).sort());
});
