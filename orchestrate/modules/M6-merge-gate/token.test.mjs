// token.test.mjs — the robot's token is minted in memory, by the scripts' user only, from a locked key (R-0b-86). Run:
// node --test orchestrate/modules/M6-merge-gate/token.test.mjs

import { tempDir } from '../../shared/test-tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { writeFileSync, chmodSync, symlinkSync, mkdirSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { makeAppJwt, mintInstallationToken } from './token.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ME = process.getuid();
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const TOKEN = 'ghs_test' + 'x'.repeat(32);

function keyFolder(mode = 0o600) {
  const dir = tempDir('m6-token-');
  const key = join(dir, 'keys');
  mkdirSync(key, { mode: 0o700 });
  writeFileSync(join(key, 'robot-app.pem'), PEM, { mode: 0o600 });
  chmodSync(join(key, 'robot-app.pem'), mode);
  return { dir, key };
}

// A fake GitHub that checks the signed request the way GitHub would, then answers with `status`.
function fakeGitHub({ status = 201 } = {}) {
  const seen = [];
  return {
    seen,
    async post(path, body, headers) {
      const jwt = /^Bearer (.+)$/.exec(headers?.Authorization ?? '')?.[1];
      const [h, p, s] = String(jwt).split('.');
      const okSig = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s ?? '', 'base64url'));
      const head = JSON.parse(Buffer.from(h, 'base64url'));
      const claims = JSON.parse(Buffer.from(p, 'base64url'));
      seen.push({ path, okSig, head, claims });
      if (!okSig) return { status: 401, json: { message: 'bad signature' } };
      return status === 201 ? { status, json: { token: TOKEN, expires_at: '2026-10-30T13:00:00Z' } } : { status, json: { message: 'no' } };
    },
  };
}

const args = (key, http, extra = {}) => ({ keyDir: key, appId: '12345', installationId: 678, http, uid: ME, scriptsUid: ME, now: () => NOW, ...extra });

// Every file under dir, read as bytes; true when one holds `needle`.
function anyFileHolds(dir, needle) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) { if (anyFileHolds(p, needle)) return true; }
    else if (st.isFile() && readFileSync(p).includes(needle)) return true;
  }
  return false;
}

test('makeAppJwt: RS256, iat 60 s back, exp 9 minutes on, iss the app id, verifiable with the public key', () => {
  const jwt = makeAppJwt({ appId: '12345', privateKeyPem: PEM, now: NOW });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(c, { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '12345' });
  assert.equal(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), true);
  assert.throws(() => makeAppJwt({ appId: '', privateKeyPem: PEM, now: NOW }));
  assert.throws(() => makeAppJwt({ appId: '1', privateKeyPem: 'nope', now: NOW }));
});

test('mints a token in memory, and no file in the temp folder holds it afterwards', async () => {
  const { dir, key } = keyFolder();
  const gh = fakeGitHub();
  const r = await mintInstallationToken(args(key, gh));
  assert.deepEqual(r, { ok: true, token: TOKEN, expires_at: '2026-10-30T13:00:00Z' });
  assert.equal(gh.seen.length, 1);
  assert.equal(gh.seen[0].path, '/app/installations/678/access_tokens');
  assert.equal(gh.seen[0].okSig, true);
  assert.deepEqual(gh.seen[0].claims, { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '12345' });
  assert.equal(anyFileHolds(dir, TOKEN), false, 'the token was written to disk');
  assert.equal(anyFileHolds(dir, 'eyJ'), false, 'the signed request was written to disk');
});

test('a run as another Mac user, or as root, is refused before the key is read', async () => {
  const { key } = keyFolder();
  const gh = fakeGitHub();
  const other = await mintInstallationToken(args(key, gh, { uid: ME + 1 }));
  assert.equal(other.ok, false);
  assert.match(other.reason, /only the scripts' Mac user/);
  const root = await mintInstallationToken(args(key, gh, { uid: 0 }));
  assert.equal(root.ok, false);
  assert.match(root.reason, /root/);
  const rootScripts = await mintInstallationToken(args(key, gh, { uid: 0, scriptsUid: 0 }));
  assert.equal(rootScripts.ok, false);
  for (const scriptsUid of [undefined, null, '501', 1.5, -1]) {
    const r = await mintInstallationToken(args(key, gh, { scriptsUid }));
    assert.equal(r.ok, false, String(scriptsUid));
  }
  assert.equal(gh.seen.length, 0, 'GitHub was asked although the user was wrong');
});

test('a key file others can read, or a key file that is a link, is refused', async () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    const { key } = keyFolder(mode);
    const r = await mintInstallationToken(args(key, fakeGitHub()));
    assert.equal(r.ok, false, mode.toString(8));
    assert.match(r.reason, /readable by others/);
  }
  const { key } = keyFolder();
  const linked = join(tempDir('m6-token-link-'), 'keys');
  mkdirSync(linked, { mode: 0o700 });
  symlinkSync(join(key, 'robot-app.pem'), join(linked, 'robot-app.pem'));
  const r = await mintInstallationToken(args(linked, fakeGitHub()));
  assert.equal(r.ok, false);
  assert.match(r.reason, /is a link/);
  const missing = await mintInstallationToken(args(key, fakeGitHub(), { keyFile: 'other.pem' }));
  assert.equal(missing.ok, false);
  const pathy = await mintInstallationToken(args(key, fakeGitHub(), { keyFile: '../keys/robot-app.pem' }));
  assert.equal(pathy.ok, false);
  assert.match(pathy.reason, /plain name/);
});

test('a key owned by another user is refused (scripts user differs from the file owner)', async () => {
  const { key } = keyFolder();
  // The process runs as ME, so pretend the scripts' user is someone else running as themselves: the file is ME's.
  const r = await mintInstallationToken(args(key, fakeGitHub(), { uid: ME + 7, scriptsUid: ME + 7 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not owned by the scripts' Mac user/);
});

test('GitHub saying 401, or answering oddly, is no token; a reason never carries the token or key text', async () => {
  const { key } = keyFolder();
  const denied = await mintInstallationToken(args(key, fakeGitHub({ status: 401 })));
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /refused the token request \(401\)/);

  const odd = { async post() { return { status: 200, json: { token: TOKEN } } } };
  const r200 = await mintInstallationToken(args(key, odd));
  assert.equal(r200.ok, false);
  assert.equal(r200.reason.includes(TOKEN), false);

  const leaky = { async post(_p, _b, h) { throw new Error(`boom ${h.Authorization} ${TOKEN} ${PEM}`); } };
  const thrown = await mintInstallationToken(args(key, leaky));
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /token mint failed/);
  for (const bad of [TOKEN, 'eyJ', 'PRIVATE KEY', 'Bearer e']) assert.equal(thrown.reason.includes(bad), false, bad);

  const noClient = await mintInstallationToken(args(key, null));
  assert.equal(noClient.ok, false);
  const nothing = await mintInstallationToken();
  assert.equal(nothing.ok, false);
});
