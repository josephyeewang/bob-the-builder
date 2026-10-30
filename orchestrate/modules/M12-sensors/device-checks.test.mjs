import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostStatusLine, prePushMessage, checkAirSetup, readOnlyScope } from './device-checks.mjs';

const GOOD = { githubTokenScopes: ['contents:read', 'metadata:read'], pushCapableCredentials: [], chromeBlocksGithub: true, sessionNames: ['Air research', 'Air notes'], denyFileDecision: 'mini-only' };

test('/host status says orchestrated products stay on the Mini', () => {
  assert.match(hostStatusLine(['product 1']), /orchestrated products stay on the Mini/);
});

test('the Air pre-push hook refuses an orchestrated repo with a clear message, and admits it is only a message', () => {
  const r = prePushMessage({ machine: 'air', remoteRepo: 'o/p1', orchestratedRepos: ['o/p1'] });
  assert.equal(r.refuse, true);
  assert.match(r.message, /stays on the Mini/);
  assert.match(r.message, /GitHub itself refuses/);
  assert.equal(prePushMessage({ machine: 'air', remoteRepo: 'o/other', orchestratedRepos: ['o/p1'] }).refuse, false);
  assert.equal(prePushMessage({ machine: 'mini', remoteRepo: 'o/p1', orchestratedRepos: ['o/p1'] }).refuse, false);
});

test('a correctly set-up Air is all green', () => {
  assert.deepEqual(checkAirSetup(GOOD), { ok: true, red: [] });
});

test('each planted miss turns /configaudit red', () => {
  const misses = {
    githubTokenScopes: ['repo'],
    pushCapableCredentials: ['ssh key "laptop"'],
    chromeBlocksGithub: false,
    sessionNames: ['Air research', 'research'],
    denyFileDecision: null,
  };
  for (const [k, v] of Object.entries(misses)) {
    const r = checkAirSetup({ ...GOOD, [k]: v });
    assert.equal(r.ok, false, k);
    assert.equal(r.red.length, 1, k);
  }
  assert.equal(checkAirSetup({ ...GOOD, githubTokenScopes: ['contents:write'] }).ok, false);
});

test('a fact that could not be gathered is red, never green', () => {
  const r = checkAirSetup({});
  assert.equal(r.ok, false);
  assert.equal(r.red.length, 5);
  assert.ok(r.red.every((x) => /unknown|not recorded/.test(x)));
});

test('0b-7 audit round 3 M-D: only read-only scopes pass; public_repo, workflow and write in any spelling are red', () => {
  for (const bad of [['public_repo', 'read:org'], ['workflow', 'public_repo'], ['contents: write'], ['Contents: Read and write'], ['contents:write'], ['admin:org'], ['repo'], ['gist'], ['delete_repo'], ['write:packages'], ['contents:read', 'actions:write'], ['']]) {
    assert.equal(checkAirSetup({ ...GOOD, githubTokenScopes: bad }).ok, false, bad.join());
  }
  for (const ok of [['contents:read', 'metadata:read'], ['read:org', 'read:user', 'user:email'], []]) assert.equal(checkAirSetup({ ...GOOD, githubTokenScopes: ok }).ok, true, ok.join());
  assert.equal(readOnlyScope('Contents:read'), false, 'one exact lowercase format');
  assert.equal(checkAirSetup({ ...GOOD, githubTokenScopes: 'contents:read' }).ok, false, 'not a list');
});
