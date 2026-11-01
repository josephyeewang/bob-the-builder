import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUES, MODES, READBACK_OPTIONS, readBack, repeatsSecret, sortRequest, unsureQuestion } from './sort.mjs';
import { checkOutboxFile, intakePush, outboxFile } from './outbox.mjs';

const SKILL = readFileSync(new URL('./skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
const FAKE_KEY = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join(''); // planted fake, never a real key

test('R-0b-137: the five planted requests each get the right mode', () => {
  const want = { 'start a new project called Atlas': 'new', 'fix the chart on the pricing page': 'evolve',
    'is this right? the totals look off': 'audit', 'update from Bob please': 'upgrade', "let's think about the onboarding": 'think' };
  for (const [said, mode] of Object.entries(want)) assert.deepEqual(sortRequest(said), { sure: true, mode }, said);
});

test('R-0b-137: a sure request reads back in three lines with exactly Go, Change, Not now', () => {
  for (const mode of MODES) {
    const r = readBack({ mode, product: 'test-product', what: 'fix the chart' });
    assert.equal(r.ok, true); assert.equal(r.lines.length, 3); assert.deepEqual(r.options, ['Go', 'Change', 'Not now']);
  }
  assert.match(readBack({ mode: 'new', what: 'x' }).lines[2], /bob NEW/, 'NEW points to the owner\'s own session');
  assert.match(readBack({ mode: 'think', what: 'x' }).lines[2], /thinking room on the main model/);
  assert.equal(readBack({ mode: 'deploy', what: 'x' }).ok, false);
});

test('R-0b-137: an unsure request gets one question, the recommendation first and marked', () => {
  const none = sortRequest('the thing from yesterday');
  assert.equal(none.sure, false);
  const two = sortRequest("let's think about how to fix the chart");
  assert.deepEqual([two.sure, two.recommend], [false, 'evolve']);
  const q = unsureQuestion(two);
  assert.equal(q.options.filter((o) => o.endsWith('(Recommended)')).length, 1);
  assert.match(q.options[0], /\(Recommended\)$/);
  assert.ok(q.options.length >= 2 && q.options.length <= 4);
});

test('R-0b-137: the skill\'s cue table and buttons match sort.mjs', () => {
  for (const mode of MODES) {
    const row = SKILL.split('\n').find((l) => l.startsWith(`| ${mode} |`));
    assert.ok(row, mode);
    for (const c of CUES[mode]) assert.ok(row.toLowerCase().includes(c.trim().replace("lets think", "let's think")), `${mode}: ${c}`);
  }
  for (const o of READBACK_OPTIONS) assert.ok(SKILL.includes(`\`${o}\``), o);
  assert.ok(SKILL.includes('"(Recommended)"'));
  assert.doesNotMatch(SKILL, /Thinking room, research asks/, 'the thinking room is wired now');
});

test('R-0b-137: each mode request the skill writes passes intake, and only mode requests carry what', () => {
  for (const request of ['evolve', 'audit', 'upgrade', 'think']) {
    const f = outboxFile('request', '20261103-0915-kq', { request, product: 'test-product', what: 'fix the chart' });
    assert.equal(f.ok, true, request);
    const r = checkOutboxFile(f.name, f.text, { products: ['test-product'], seenIds: [] });
    assert.equal(r.ok, true, r.reason); assert.equal(r.doc.what, 'fix the chart');
    assert.match(intakePush(f.name, r), /^Request taken: .*Nothing has started yet/);
  }
  const shape = /`(\{"request":"<mode>"[^`]+\})`/.exec(SKILL)?.[1];
  assert.ok(shape);
  const filled = shape.replace('<mode>', 'audit').replace('"X"', '"test-product"').replace(/"<[^"]+>"/, '"is the total right"');
  assert.equal(checkOutboxFile('request-audit-20261103-0915-ab.json', filled).ok, true);
  const bad = (doc, name = 'request-evolve-20261103-0915-kq.json') => checkOutboxFile(name, JSON.stringify(doc)).ok;
  assert.equal(bad({ request: 'resume', product: null, name: null, what: 'x' }, 'request-resume-20261103-0915-kq.json'), false);
  assert.equal(bad({ request: 'evolve', product: null, name: null, what: 'x' }), false, 'evolve names its product');
  assert.equal(bad({ request: 'evolve', product: 'p', name: null, what: 'a\nb' }), false);
  assert.equal(bad({ request: 'evolve', product: 'p', name: null, what: 'x'.repeat(301) }), false);
  assert.equal(bad({ request: 'evolve', product: 'p', name: null, what: 'fix​it' }), false);
  assert.equal(bad({ request: 'evolve', product: 'p', name: null }), false, 'what is required');
  assert.equal(bad({ request: 'think', product: null, name: null, what: 'onboarding' }, 'request-think-20261103-0915-kq.json'), true);
});

test('R-0b-137 / B11 planted: a secret typed in chat is not repeated, and rotate files the name only', () => {
  const said = `fix the login, the key is ${FAKE_KEY}`;
  assert.equal(repeatsSecret(said, `Change: test-product.\nWhat you said: fix the login, the key is ${FAKE_KEY}`), true);
  assert.equal(repeatsSecret(said, 'That looks like a key. I did not keep it. Rotate it, and tell me only its name.'), false);
  assert.equal(repeatsSecret('hello', `here: ${FAKE_KEY}`), true, 'a key-shaped reply is refused on its own');
  const f = outboxFile('request', '20261103-0915-kq', { request: 'evolve', product: 'p', what: said });
  assert.equal(checkOutboxFile(f.name, f.text).ok, false, 'a what holding the key refuses the whole file');
  const rot = outboxFile('request', '20261103-0915-ro', { request: 'rotate', name: 'GITHUB_TOKEN' });
  assert.equal(rot.ok, true); assert.ok(!rot.text.includes(FAKE_KEY));
  assert.match(intakePush(rot.name, checkOutboxFile(rot.name, rot.text, { products: [], seenIds: [] })), /rotate GITHUB_TOKEN/);
});
