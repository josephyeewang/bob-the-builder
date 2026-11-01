import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUES, MODES, READBACK_OPTIONS, WEAK_CUES, readBack, repeatsSecret, sortRequest, unsureQuestion } from './sort.mjs';
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
  // Not wired yet (audit kit-lane3 r1 Minor 9): the read-back never promises a filing the record would refuse.
  for (const mode of ['evolve', 'audit', 'upgrade', 'think']) {
    const l = readBack({ mode, product: 'test-product', what: 'x' }).lines[2];
    assert.match(l, /isn't wired to the Mini yet, so I file nothing/, mode);
    assert.doesNotMatch(l, /I file a|Filed/, mode);
  }
  assert.match(readBack({ mode: 'audit', what: 'x' }).lines[2], /`bob AUDIT <name>`/);
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

test('audit r1 Minors 7 and 8: whole-word cues, weak cues ask, and a no-cue question still recommends', () => {
  // "fix" inside "prefix" is no cue; with nothing else it is the no-cue question.
  const pre = sortRequest('the prefix on invoices is wrong');
  assert.equal(pre.sure, false, 'prefix is not fix');
  // "build a new chart on the pricing page" is a change to a product, not surely a new project.
  const chart = sortRequest('build a new chart on the pricing page');
  assert.deepEqual([chart.sure, chart.recommend, chart.hits], [false, 'new', ['new', 'evolve']]);
  assert.deepEqual(WEAK_CUES.new, ['build a new']);
  // A new-project cue that names one of the owner's products asks.
  assert.equal(sortRequest('new project inside sample-app', { products: ['sample-app'] }).sure, false);
  assert.equal(sortRequest('new project called Atlas', { products: ['sample-app'] }).sure, true);
  // No cue: think is recommended, marked, and offered.
  const none = sortRequest('the thing from yesterday');
  assert.equal(none.recommend, 'think');
  const q = unsureQuestion(none);
  assert.match(q.options[0], /^Think it through.*\(Recommended\)$/);
  assert.equal(q.options.length, 4);
});

test('R-0b-137: the skill\'s cue table and buttons match sort.mjs', () => {
  for (const mode of MODES) {
    const row = SKILL.split('\n').find((l) => l.startsWith(`| ${mode} |`));
    assert.ok(row, mode);
    for (const c of CUES[mode]) assert.ok(row.toLowerCase().includes(c.trim().replace("lets think", "let's think")), `${mode}: ${c}`);
  }
  for (const o of READBACK_OPTIONS) assert.ok(SKILL.includes(`\`${o}\``), o);
  assert.ok(SKILL.includes('"(Recommended)"'));
  assert.ok(SKILL.includes('Cue words count only as whole words'));
  assert.ok(SKILL.includes('"build a new …" on its own') && SKILL.includes('When no cue fits, recommend think'));
  // Minor 9: the mode requests are under "not wired yet", and the skill never says "Filed" for them.
  const go = SKILL.split('3. **On Go**')[1].split('\n4.')[0];
  assert.match(go, /not wired to the Mini yet/); assert.match(go, /never say "Filed"/);
  assert.doesNotMatch(go, /Reply: "Filed/);
  assert.match(SKILL.split('## Not wired yet')[1], /evolve, audit, upgrade and think requests/);
});

test('R-0b-137: each mode request the skill writes passes intake, and only mode requests carry what', () => {
  for (const request of ['evolve', 'audit', 'upgrade', 'think']) {
    const f = outboxFile('request', '20261103-0915-kq', { request, product: 'test-product', what: 'fix the chart' });
    assert.equal(f.ok, true, request);
    const r = checkOutboxFile(f.name, f.text, { products: ['test-product'], seenIds: [] });
    assert.equal(r.ok, true, r.reason); assert.equal(r.doc.what, 'fix the chart');
    assert.match(intakePush(f.name, r), /^Request taken: .*Nothing has started yet/);
  }
  const filled = '{"request":"audit","product":"test-product","name":null,"what":"is the total right"}';
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
  // L84 6: the read-back repeats none of an all-upper-case access-key id (a planted fake).
  const keyId = ['AK', 'IA', 'Q7XP3ZL9M2K4T8WB'].join('');
  const rb = readBack({ mode: 'evolve', product: 'test-product', what: `fix the upload, the id is ${keyId}` });
  assert.doesNotMatch(rb.lines.join('\n'), /Q7XP3ZL9|AKIAQ7/);
  assert.equal(repeatsSecret(`the id is ${keyId}`, `What you said: ${keyId.slice(2, 16)}`), true);
  // L95 (stack r3 Minor 5): nor the A3T family, nor an id glued to a word character.
  for (const id of [['A3', 'TX', 'Q7XP3ZL9M2K4T8WB'].join(''), `ID_${keyId}`, `${keyId}x`]) {
    const b = readBack({ mode: 'evolve', product: 'test-product', what: `fix the upload, the id is ${id}` });
    assert.doesNotMatch(b.lines.join('\n'), /Q7XP3ZL9/, id);
  }
  // Minor 6: a generic key straddling the 80-character cut is masked first, and a part of a key is caught.
  const GENERIC = ['Zq8', 'Lm2Xv9Rt4Kp7Wn3Hs6Yd1Bf5Gc0Jx8'].join(''); // planted fake, no vendor prefix
  const long = `${'please fix the chart on the pricing page, it shows '.padEnd(65, 'x')} token ${GENERIC} thanks`;
  const back = readBack({ mode: 'evolve', product: 'p', what: long }).lines.join('\n');
  assert.equal(back.includes(GENERIC.slice(0, 8)), false, 'no part of the key in the read-back');
  assert.equal(repeatsSecret(long, `What you said: ${GENERIC.slice(0, 15)}`), true, 'a 15-character part is caught');
  const f = outboxFile('request', '20261103-0915-kq', { request: 'evolve', product: 'p', what: said });
  assert.equal(checkOutboxFile(f.name, f.text).ok, false, 'a what holding the key refuses the whole file');
  const rot = outboxFile('request', '20261103-0915-ro', { request: 'rotate', name: 'GITHUB_TOKEN' });
  assert.equal(rot.ok, true); assert.ok(!rot.text.includes(FAKE_KEY));
  assert.match(intakePush(rot.name, checkOutboxFile(rot.name, rot.text, { products: [], seenIds: [] })), /rotate GITHUB_TOKEN/);
});
