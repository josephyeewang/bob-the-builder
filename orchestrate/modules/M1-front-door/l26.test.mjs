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

test('L26 + round 6 M-1: "Confirmed" only where taking the file in is the act; a request push says nothing happened yet', () => {
  const push = (kind, id, input) => { const f = outboxFile(kind, id, input); return intakePush(f.name, checkOutboxFile(f.name, f.text, { products, seenIds: new Set() })); };
  assert.equal(push('state', '20261103-0915-ka', { product: 'test-product', state: 'paused' }), 'Confirmed: pause test-product. Only your tap brings it back.');
  assert.equal(push('state', '20261103-0915-kb', { product: 'test-product', state: 'away', until: '2026-11-07', tz: 'Europe/Prague' }), 'Confirmed: away test-product until 2026-11-07, time zone Europe/Prague.');
  assert.equal(push('state', '20261103-0915-kh', { product: 'test-product', state: 'away', until: '2026-11-07' }), 'Confirmed: away test-product until 2026-11-07, no time zone yet; the trip brief says what that means for each product.', 'round 6 minor 4');
  const est = checkOutboxFile('state-20261103-0915-kc.json', '{"product":"test-product","state":"away","until":null,"tz":"EST"}', { products, seenIds: [] });
  assert.match(intakePush('state-20261103-0915-kc.json', est), /^Confirmed: away test-product, no time zone yet; the trip brief says what that means for each product \(that time zone was not accepted; name a city/);
  assert.equal(push('idea', '20261103-0915-kg', 'try a darker header'), 'Confirmed: idea 20261103-0915-kg.');
  const requests = [push('request', '20261103-0915-kd', { request: 'resume' }), push('request', '20261103-0915-ki', { request: 'resume', product: 'test-product' }),
    push('request', '20261103-0915-ke', { request: 'wrapup' }), push('request', '20261103-0915-kf', { request: 'rotate', name: 'STRIPE_KEY' })];
  assert.deepEqual(requests, ['Request taken: resume all products. Nothing resumes until you tap it.', 'Request taken: resume test-product. Nothing resumes until you tap it.',
    'Request taken: wrap up. Nothing has wrapped up yet; the Lead does it when it runs.', 'Request taken: rotate STRIPE_KEY. The key is NOT rotated yet; the steps follow.']);
  for (const p of requests) assert.doesNotMatch(p, /^Confirmed/);
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
  assert.ok(filing.length >= 6, String(filing.length));
  for (const r of filing) assert.match(r, /^Filed: .+\. The Mini confirms in a minute\.$/, r);
  assert.doesNotMatch(SKILL, /is paused\.|I filed the request|Filed as idea/);
  assert.match(SKILL, /Product names come only from the product list in your context file/);
  assert.match(SKILL, /ask him which with a question box before writing anything/);
  assert.doesNotMatch(SKILL, /\d{8}-\d{4}-[a-z]{2}/, 'no real-looking example id for the phone to copy');
});
