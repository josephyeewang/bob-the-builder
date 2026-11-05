// store-stopped.test.mjs — L587: the stop that ended the robot's start is told once per reason, and a failure is only logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeIssues } from './alerts.mjs';
import { stopMarker, tellStoreStopped } from './store-stopped.mjs';

const stop = { type: 'store_layout', reason: "the store's diary.jsonl is a link, not a plain file" };
const run = (channel, extra = {}) => {
  const logs = [];
  return tellStoreStopped({ stop, product: 'product-1', channel, log: (s) => logs.push(s), ...extra }).then((r) => ({ r, logs }));
};

test('L587: the first start opens one issue, assigned, naming the fault; later starts open none', async () => {
  const gh = fakeIssues();
  assert.equal((await run({ gh, owner: 'owner-login' })).r, 'opened');
  for (let i = 0; i < 5; i++) assert.equal((await run({ gh, owner: 'owner-login' })).r, 'already open');
  assert.equal(gh.issues.size, 1);
  const x = gh.issues.get(1);
  assert.equal(x.assignee, 'owner-login');
  assert.match(x.title, /product-1's Record has stopped: store_layout/);
  assert.match(x.body, /diary\.jsonl is a link/);
  assert.equal(x.body.trim().split('\n').at(-1), stopMarker('product-1', stop.reason));
});

test('L587: a second reason is a second issue, and one the owner closed with the fault still there is opened again', async () => {
  const gh = fakeIssues();
  await run({ gh, owner: 'owner-login' });
  await tellStoreStopped({ stop: { ...stop, reason: 'another fault' }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.equal(gh.issues.size, 2);
  gh.ownerCloses(1);
  assert.equal((await run({ gh, owner: 'owner-login' })).r, 'opened');
  assert.equal(gh.issues.size, 3);
});

test('L587: a look that fails opens nothing, once, and says so in the log', async () => {
  for (const [how, findOpen] of [['false', async () => false], ['throws', async () => { throw new Error('no network'); }]]) {
    let looks = 0;
    let opens = 0;
    const gh = { lastAnswer: 'GitHub answered 502', findOpen: (t) => { looks += 1; return findOpen(t); }, open: async () => { opens += 1; return 1; } };
    const { r, logs } = await run({ gh, owner: 'owner-login' });
    assert.equal(r, 'not told', how);
    assert.equal(looks, 1, `${how}: no retry`);
    assert.equal(opens, 0, `${how}: an unknown answer opens nothing`);
    assert.match(logs[0], /could not be told/);
  }
});

test('L587: a send that fails, or a look that never answers, is logged and not retried', async () => {
  for (const open of [async () => false, async () => { throw new Error('refused'); }]) {
    let opens = 0;
    const gh = { findOpen: async () => null, open: (i) => { opens += 1; return open(i); } };
    const { r, logs } = await run({ gh, owner: 'owner-login' });
    assert.equal(r, 'not told');
    assert.equal(opens, 1);
    assert.equal(logs.length, 1);
  }
  const hung = { findOpen: () => new Promise(() => {}), open: async () => 1 };
  const { r, logs } = await run({ gh: hung, owner: 'owner-login' }, { sendMs: 20 });
  assert.equal(r, 'not told');
  assert.match(logs[0], /no answer within 20 ms/);
});

test('L587: with no writing token yet the stop is logged, naming what is missing', async () => {
  const { r, logs } = await run(undefined);
  assert.equal(r, 'not told');
  assert.match(logs[0], /R-0b-02/);
});

test('L587: a secret in the reason does not reach the issue', async () => {
  const gh = fakeIssues();
  const secret = `ghp_${'a'.repeat(36)}`;
  await tellStoreStopped({ stop: { ...stop, reason: `bad ${secret}` }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.doesNotMatch(gh.issues.get(1).body, /ghp_a/);
});
