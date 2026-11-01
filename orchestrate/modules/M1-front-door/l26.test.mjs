// l26.test.mjs — lead call L26 (after 0b-8 audit round 5 M-4, M-5): the Front Door only says "Filed"; intake's push
// confirms or refuses; product names come only from the product list; a reused id is refused. Each fails on f50e478.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkOutboxFile, intakePush, outboxFile } from './outbox.mjs';
import { FAKE } from '../M12-sensors/fakes.mjs';

const SKILL = readFileSync(new URL('./skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
const products = ['test-product', 'second-product'];
const pause = (p) => `{"product":"${p}","state":"paused","until":null,"tz":null}`;

test('L26 planted: a product not on the list is refused, and the push says so', () => {
  const r = checkOutboxFile('state-20261103-0915-kq.json', pause('Test-Product'), { products });
  assert.equal(r.ok, false);
  assert.equal(intakePush('state-20261103-0915-kq.json', r), 'Not filed: that product is not on the product list. Say it again.');
  assert.equal(checkOutboxFile('state-20261103-0915-kq.json', pause('test-product'), { products: [] }).ok, false, 'an empty list admits nothing');
  assert.equal(checkOutboxFile('state-20261103-0915-kq.json', pause('test-product'), { products }).ok, true);
});

test('L26 planted: a reused id is refused, whether the seen ids come as a Set or a list', () => {
  for (const seenIds of [new Set(['20261103-0915-kq']), ['20261103-0915-kq']]) {
    const r = checkOutboxFile('idea-20261103-0915-kq.md', '> a darker header\n', { seenIds });
    assert.equal(r.ok, false); assert.match(r.reason, /used before/);
  }
  const ok = checkOutboxFile('idea-20261103-0915-kr.md', '> a darker header\n', { seenIds: new Set(['20261103-0915-kq']), products });
  assert.equal(ok.ok, true); assert.equal(ok.id, '20261103-0915-kr'); assert.deepEqual(ok.checked, { products: true, seenIds: true });
  assert.deepEqual(checkOutboxFile('idea-20261103-0915-kr.md', '> x\n').checked, { products: false, seenIds: false }, 'says when a check was skipped');
});

test('L26 + round 6 M-1 + L151: "Confirmed" only for an idea; a state- or request- push says it isn\'t available and nothing changed', () => {
  const push = (kind, id, input) => { const f = outboxFile(kind, id, input); return intakePush(f.name, checkOutboxFile(f.name, f.text, { products, seenIds: new Set() })); };
  const states = [push('state', '20261103-0915-ka', { product: 'test-product', state: 'paused' }),
    push('state', '20261103-0915-kb', { product: 'test-product', state: 'away', until: '2026-11-07', tz: 'Europe/Prague' }),
    push('state', '20261103-0915-kh', { product: 'test-product', state: 'away', until: '2026-11-07' }),
    intakePush('state-20261103-0915-kc.json', checkOutboxFile('state-20261103-0915-kc.json', '{"product":"test-product","state":"away","until":null,"tz":"EST"}', { products, seenIds: [] }))];
  assert.deepEqual(states, ["Not filed: pausing test-product isn't available from the Front Door yet. Nothing changed.",
    ...Array(3).fill("Not filed: trip mode for test-product isn't available from the Front Door yet. Nothing changed.")]);
  assert.equal(push('idea', '20261103-0915-kg', 'try a darker header'), 'Confirmed: idea 20261103-0915-kg, saved for the Lead.');
  const requests = [push('request', '20261103-0915-kd', { request: 'resume' }), push('request', '20261103-0915-ki', { request: 'resume', product: 'test-product' }),
    push('request', '20261103-0915-ke', { request: 'wrapup' }), push('request', '20261103-0915-kf', { request: 'rotate', name: 'STRIPE_KEY' })];
  assert.deepEqual(requests, ["Not filed: resuming all products isn't available from the Front Door yet. Nothing changed.",
    "Not filed: resuming test-product isn't available from the Front Door yet. Nothing changed.",
    "Not filed: wrapping up isn't available from the Front Door yet. Nothing changed.",
    "Not filed: rotating STRIPE_KEY isn't available from the Front Door yet. The key is NOT rotated."]);
  for (const p of [...states, ...requests]) assert.doesNotMatch(p, /Confirmed|Request taken|Say it again|tap|follow|brief|Lead does/);
});

test('0b-8 audit round 6 minors 1 and 3: a skipped or mis-passed check is never confirmed', () => {
  const f = outboxFile('state', '20261103-0915-ka', { product: 'Test-Product', state: 'paused' });
  assert.equal(intakePush(f.name, checkOutboxFile(f.name, f.text)), 'Not filed: the Mini could not check the product list and the file ids. Say it again.');
  assert.equal(intakePush(f.name, checkOutboxFile(f.name, f.text, { products: ['Test-Product'] })).startsWith('Not filed'), true, 'seen ids missing');
  const g = outboxFile('state', '20261103-0915-kb', { product: 'test', state: 'paused' });
  assert.match(checkOutboxFile(g.name, g.text, { products: 'test-product,second-product', seenIds: [] }).reason, /wrong form/, 'a string is not a list');
  assert.match(checkOutboxFile(g.name, g.text, { products, seenIds: {} }).reason, /wrong form/, 'an object is not a list');
  assert.equal(checkOutboxFile(g.name, g.text, { products: new Set(['test']), seenIds: new Set() }).ok, true, 'a Set works');
});

test('L26 planted: a refusal push never carries a key', () => {
  const r = checkOutboxFile('request-rotate-20261103-0915-kq.json', `{"request":"rotate","product":null,"name":"${FAKE.github}"}`);
  const p = intakePush('x', r);
  assert.match(p, /^Not filed: .+\. Say it again\.$/);
  assert.equal(p.includes(FAKE.github), false);
  assert.equal(intakePush('x', { ok: false, reason: `bad ${FAKE.github}` }).includes(FAKE.github), false);
});

test('L26: the skill never says a thing is done; every filing reply is "Filed: …. The Mini confirms in a minute."', () => {
  const replies = [...SKILL.matchAll(/Reply:?\s*\**"([^"]+)"/g)].map((m) => m[1]);
  const filing = replies.filter((r) => !/wired yet|bob NEW/.test(r));
  assert.ok(filing.length >= 3, String(filing.length)); // idea, research ask, undo (L151: the five below file nothing)
  for (const r of filing) assert.match(r, /^Filed: .+\. The Mini confirms in a minute\.$/, r);
  assert.doesNotMatch(SKILL, /is paused\.|I filed the request|Filed as idea/);
});

test('L151: pause, away, back, wrap up and rotate file nothing; each reply says plainly it is not available, and promises nothing', () => {
  const sec = SKILL.split('## Not available yet: pause, away, back, wrap up, rotate')[1]?.split('\n## ')[0] ?? '';
  const rows = [...sec.matchAll(/^\| "([^|]+?)" \| \*\*"([^"]+)"\*\*/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows.map(([said]) => said.split('"')[0]), ['pause X', "I'm away until Friday", "I'm back", 'wrap up', 'rotate X']);
  for (const [, reply] of rows) {
    assert.match(reply, /isn't available yet, so nothing was filed/, reply);
    assert.doesNotMatch(reply, /Filed|confirms|later|soon|tap|brief|will /, reply);
  }
  assert.match(rows[4][1], /the key is NOT rotated/);
  assert.match(sec, /write nothing and never say\s+"Filed"/);
  assert.match(sec, /never write a `state-`\s+or `request-` file/);
  // No file shape or file name for these kinds is left in the live skill for the Front Door to write.
  assert.doesNotMatch(SKILL, /\{"request":|"state":"(paused|away)"|`state-<id>|`request-(resume|wrapup|rotate)-/);
  assert.doesNotMatch(SKILL, /Only the owner's tap brings it back|The steps come after that|Resume still needs your tap/);
  // idea- promises nothing beyond being saved for the Lead.
  assert.ok(SKILL.includes('Reply: **"Filed: idea <id>, saved for the Lead. The Mini confirms in a minute."** Promise nothing more'));
  assert.match(SKILL, /Product names come only from the product list in your context file/);
  assert.match(SKILL, /ask them which with a question box before writing anything/);
  assert.doesNotMatch(SKILL, /\d{8}-\d{4}-[a-z]{2}/, 'no real-looking example id for the phone to copy');
});
