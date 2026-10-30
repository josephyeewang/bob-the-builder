// round9.test.mjs — planted cases for 0b-7 audit round 9 minor 2 and the start-gate note. Each fails on 2953773.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../M13-ledger/outside-check/notify.mjs';
import { readStartGate } from './start-gate.mjs';

test('0b-7 audit round 9 minor 2: one GitHub error no longer stops the other titles getting their issues', async () => {
  const opened = [];
  const api = async (method, path, body) => {
    if (method === 'GET') return [];
    if (body?.title === 'product 1 / heartbeat') throw new Error('notify: http 502');
    opened.push(body.title); return {};
  };
  const done = await notify({ ran: ['product 1 / heartbeat', 'product 2 / deploys'], failed: ['product 1 / heartbeat', 'product 2 / deploys'], api });
  assert.deepEqual(done, [['product 1 / heartbeat', 'error'], ['product 2 / deploys', 'opened']]);
  assert.deepEqual(opened, ['product 2 / deploys']);
});

test('0b-7 audit round 9 note: a product name a fact id cannot hold says why nothing was written', async () => {
  const vercel = { async settings() { return { commandForIgnoringBuildStep: 'x' }; }, async envMeta() { return []; } };
  const writer = { put: (id) => ({ ok: /^[A-Za-z0-9._-]+$/.test(id) }) };
  const r = await readStartGate({ product: 'my product', vercel, writer, pinnedSkip: 'x', vercelProject: 'prj_1' });
  assert.equal(r.written, false);
  assert.match(r.reason, /product name has characters/);
});
