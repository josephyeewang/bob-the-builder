// l25.test.mjs — lead call L25: facts are masked by an allow-list (fact-shapes.mjs), not by a list of bad names.
// Planted values are plain words with no key shape, so only the allow-list can catch them; each fails on the old code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';
import { SHAPES, UNKNOWN, WRONG } from './fact-shapes.mjs';

const plain = 'hunter2hunter2';
const T = '2026-11-03T12:00:00.000Z';
function put(doc) {
  const rec = memoryRecord();
  const r = makeFactWriter(rec, { masker: makeMasker({ env: {} }), now: () => new Date(T) }).put('f', doc);
  assert.equal(r.ok, true);
  return rec.read('fact', 'f').doc;
}
const status = { kind: 'fact.heartbeat-status', product: 'test-product', at: T, front_door_reachable: true, signed_in: true, login: 'account A', red: ['front-door'] };

test('L25: a declared fact is stored exactly as written', () => {
  assert.deepEqual(put(status), { ...status, ts: T });
});

test('L25 planted: round 5 and round 6 leaks and a never-seen name are all masked when the kind is known', () => {
  const d = put({ ...status, token_count: plain, tokens_used: [plain], deploy_key: plain, passphrase: plain, credentials: { a: [plain] },
    password: { deeper: [{ x: plain }] }, vault_word: plain, pin: 4821, notes: { y: [plain, 7] } });
  assert.equal(JSON.stringify(d).includes(plain), false);
  assert.equal(JSON.stringify(d).includes('4821'), false);
  assert.equal(d.vault_word, UNKNOWN, 'a name no list has ever seen');
  assert.deepEqual(d.notes, { y: [UNKNOWN, UNKNOWN] }, 'masked, not dropped: the name and shape stay');
  assert.equal(d.login, 'account A');
});

test('L25 planted: a declared field holding the wrong shape is masked', () => {
  const d = put({ ...status, at: plain, product: `x=${plain}`, red: [`a;${plain}`, 'ok'], signed_in: plain });
  assert.equal(d.at, WRONG); assert.equal(d.product, WRONG); assert.deepEqual(d.red, [WRONG, 'ok']); assert.equal(d.signed_in, WRONG);
  const pr = put({ kind: 'fact.pr', number: 3, changed_files: [{ path: 'a.md', added: plain, extra: plain }], diff_summary: plain });
  assert.deepEqual(pr.changed_files, [{ path: 'a.md', added: WRONG, extra: UNKNOWN }]);
  assert.equal(pr.diff_summary, WRONG);
});

test('L25 planted: a kind with no shape keeps only its kind and time; yes/no and empty values stay', () => {
  const d = put({ kind: 'fact.not-declared', note: plain, n: 12, ok: true, none: null, nested: { k: plain } });
  assert.deepEqual(d, { kind: 'fact.not-declared', note: UNKNOWN, n: UNKNOWN, ok: true, none: null, nested: { k: UNKNOWN }, ts: T });
  assert.equal(put({ note: plain }).note, UNKNOWN, 'no kind at all');
  assert.equal(put({ kind: plain + ' = x', note: 'a' }).kind, WRONG);
});

test('L25 census: every fact kind the Sensors and the Ledger write has a shape', () => {
  const here = fileURLToPath(new URL('..', import.meta.url));
  const kinds = new Set();
  for (const dir of ['M12-sensors', 'M13-ledger', 'M1-front-door']) {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) for (const m of readFileSync(p, 'utf8').matchAll(/kind: '(fact\.[a-z-]+)'/g)) kinds.add(m[1]);
    });
    walk(join(here, dir));
  }
  assert.ok(kinds.size >= 15, `found ${kinds.size}`);
  for (const k of kinds) assert.ok(Object.hasOwn(SHAPES, k), `${k} has no shape`);
});
