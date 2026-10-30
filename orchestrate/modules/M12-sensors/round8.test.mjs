// round8.test.mjs — planted cases for the 0b-7 audit round 8 finding (M-1) and minors 1 and 4. Each fails on 16227fb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify, BOT } from '../M13-ledger/outside-check/notify.mjs';
import { startGateOpen, SKIP_FACT, ENV_FACT } from './start-gate.mjs';

// GitHub as the audit saw it: comments listed oldest first, 100 per page; anyone may comment on the public repo.
function github() {
  const issues = [];
  const api = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/issues?')) return issues.map((i) => ({ ...i }));
    const cm = /^\/issues\/(\d+)\/comments/.exec(path);
    if (cm && method === 'GET') return issues[cm[1] - 1].comments.slice(0, 100);
    if (cm && method === 'POST') { issues[cm[1] - 1].comments.push({ user: { login: BOT }, body: body.body }); return {}; }
    if (method === 'POST' && path === '/issues') { issues.push({ number: issues.length + 1, title: body.title, body: body.body, state: 'open', comments: [] }); return {}; }
    const pm = /^\/issues\/(\d+)$/.exec(path);
    if (pm && method === 'PATCH') { Object.assign(issues[pm[1] - 1], body); return {}; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { issues, api };
}

test('0b-7 audit round 8 M-1: 100 comments from anyone can no longer silence the outside check\'s next failure', async () => {
  const gh = github(); const t = 'product 1 / heartbeat';
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'opened']]);
  for (let n = 0; n < 100; n++) gh.issues[0].comments.push({ user: { login: 'someone' }, body: 'spam' });
  assert.deepEqual(await notify({ ran: [t], failed: [], api: gh.api }), [[t, 'cleared']]);
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'opened']]);
  assert.equal(gh.issues.filter((i) => i.state === 'open').length, 1);
});

test('0b-7 audit round 8 M-1: a comment that copies the bot\'s words does not re-arm an issue the owner closed', async () => {
  const gh = github(); const t = 'product 1 / deploys';
  await notify({ ran: [t], failed: [t], api: gh.api });
  gh.issues[0].state = 'closed';
  gh.issues[0].comments.push({ user: { login: BOT }, body: 'Cleared: the check passes again.' });
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'suppressed']]);
  assert.deepEqual(await notify({ ran: [t], failed: [], api: gh.api }), [[t, 're-armed']]);
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'opened']]);
});

test('0b-7 audit round 8 minor 1: a start-gate fact for "acme-app" does not open the gate for "acme.app"', () => {
  const at = new Date().toISOString();
  const facts = { [SKIP_FACT('acme-app')]: { product: 'acme-app', at, ok: true }, [ENV_FACT('acme-app')]: { product: 'acme-app', at, ok: true } };
  assert.equal(startGateOpen({ read: (id) => facts[id], product: 'acme-app' }).open, true);
  const other = startGateOpen({ read: (id) => facts[id], product: 'acme.app' });
  assert.equal(other.open, false);
  assert.match(other.problems.join(), /another product name/);
});
