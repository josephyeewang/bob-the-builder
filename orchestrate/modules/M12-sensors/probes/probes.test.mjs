// R-0b-169 probes. Each is tested against stand-ins for the outside world AND against the real thing where it is safe:
// a real local TCP port, a real local web server, and the real read-only `launchctl print` on a Mac.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { networkProbe, tcpConnect } from './network.mjs';
import { reachableProbe } from './reachable.mjs';
import { launchdProbe, stateOf, runLaunchctl } from './launchd.mjs';
import { signedInProbe } from './signed-in.mjs';

const onMac = process.platform === 'darwin' && process.env.SETUP_FORCE_NOT_MAC !== '1';
const macOnly = onMac ? {} : { skip: 'needs macOS tools (launchctl); run on a Mac' };
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

test('network: any host up → true; all "no route" → false; refusal or timeout → null (could not tell)', async () => {
  const by = (m) => async (h) => m[h];
  assert.equal(await networkProbe({ hosts: ['a', 'b'], connect: by({ a: { ok: false, code: 'ENOTFOUND' }, b: { ok: true } }) })(), true);
  assert.equal(await networkProbe({ hosts: ['a', 'b'], connect: by({ a: { ok: false, code: 'ENOTFOUND' }, b: { ok: false, code: 'ENETUNREACH' } }) })(), false);
  assert.equal(await networkProbe({ hosts: ['a', 'b'], connect: by({ a: { ok: false, code: 'ENOTFOUND' }, b: { ok: false, code: 'ECONNREFUSED' } }) })(), null, 'PLANT: one refusal means up-but-unwell, not down');
  assert.equal(await networkProbe({ hosts: ['a'], connect: by({ a: { ok: false, code: 'TIMEOUT' } }) })(), null);
  assert.equal(await networkProbe({ hosts: ['a'], connect: async () => { throw new Error('x'); } })(), null);
  assert.throws(() => networkProbe({ hosts: [] }));
});

test('network, for real: a local open port answers true; a closed local port is a refusal → null, never false', async () => {
  const s = net.createServer((c) => c.destroy()); const port = await listen(s);
  assert.equal(await networkProbe({ hosts: ['127.0.0.1'], port })(), true);
  await new Promise((ok) => s.close(ok));
  assert.equal(await networkProbe({ hosts: ['127.0.0.1'], port })(), null);
  assert.deepEqual((await tcpConnect('127.0.0.1', port, 2000)).ok, false);
});

test('reachable: below 500 → true, 5xx → false, refused → false, timeout → null; sign-in in the address refused', async () => {
  const ans = (status) => async () => ({ status, body: null });
  assert.equal(await reachableProbe({ url: 'https://x.test/', fetchImpl: ans(200) })(), true);
  assert.equal(await reachableProbe({ url: 'https://x.test/', fetchImpl: ans(401) })(), true);
  assert.equal(await reachableProbe({ url: 'https://x.test/', fetchImpl: ans(502) })(), false);
  const fails = (e) => async () => { throw e; };
  assert.equal(await reachableProbe({ url: 'https://x.test/', fetchImpl: fails(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) })(), false);
  assert.equal(await reachableProbe({ url: 'https://x.test/', fetchImpl: fails(Object.assign(new Error('t'), { name: 'TimeoutError' })) })(), null);
  assert.equal(await reachableProbe({ url: 'https://x.test/', fetchImpl: fails(new Error('odd')) })(), null);
  assert.throws(() => reachableProbe({ url: 'https://u:p@x.test/' }));
  assert.throws(() => reachableProbe({ url: 'file:///etc/passwd' }));
});

test('reachable, for real: a local web server (200, 503, then closed)', async () => {
  let status = 200;
  const s = http.createServer((q, r) => { r.statusCode = status; r.end('x'); }); const port = await listen(s);
  const p = reachableProbe({ url: `http://127.0.0.1:${port}/` });
  assert.equal(await p(), true);
  status = 503; assert.equal(await p(), false);
  await new Promise((ok) => { s.close(ok); s.closeAllConnections?.(); });
  assert.equal(await p(), false);
});

test('launchd: states and failures (stand-ins)', async () => {
  const out = (code, stdout = '', stderr = '') => async () => ({ code, stdout, stderr });
  const mk = (run) => launchdProbe({ label: 'job.x', domain: 'gui/501', run });
  assert.equal(await mk(out(0, 'gui/501/job.x = {\n\tstate = running\n}'))(), true);
  assert.equal(await mk(out(0, 'gui/501/job.x = {\n\tstate = not running\n}'))(), false);
  assert.equal(await mk(out(113, '', 'Could not find service "job.x" in domain'))(), false);
  assert.equal(await mk(out(1, '', 'Operation not permitted'))(), null, 'PLANT: any other failure is unknown, not "off"');
  assert.equal(await mk(out(0, 'no state line'))(), null);
  assert.equal(await mk(async () => ({ error: 'TIMEOUT' }))(), null);
  assert.equal(await mk(async () => { throw new Error('x'); })(), null);
  assert.equal(stateOf('\tstate = running\n\t\tstate = active'), 'running', 'only the job\'s own line, one tab in');
  assert.throws(() => launchdProbe({ label: 'a b', domain: 'gui/501' }));
  assert.throws(() => launchdProbe({ label: 'a', domain: '../etc' }));
});

test('launchd, REAL read-only `launchctl print` on this Mac: a loaded job reads true, a missing one false', macOnly, async () => {
  const uid = process.getuid();
  assert.equal(await launchdProbe({ label: 'orchestrate.no.such.job.here', domain: `gui/${uid}` })(), false);
  const r = await runLaunchctl(['print', `gui/${uid}`]);
  assert.equal(r.code, 0, 'the user domain can be read');
  const m = /^\t\t(?:[0-9]+|-)\s+(?:[0-9]+|-)\s+(\S+)$/m.exec(r.stdout);
  const state = m ? await launchdProbe({ label: m[1], domain: `gui/${uid}` })() : null;
  assert.ok([true, false, null].includes(state), 'a listed job answers true, false or null, never throws');
});

test('signed-in: the account in use counts only when its own folder is signed in; every other case is null', async () => {
  const home = tempDir('m12-home-');
  mkdirSync(join(home, '.claude'));
  const signed = (extra = {}) => JSON.stringify({ loggedIn: true, authMethod: 'oauth', subscriptionType: 'max', ...extra });
  const probe = (text) => signedInProbe({ home, authStatus: async () => text });
  assert.equal(await probe(signed())(), 'a');
  assert.equal(await probe(JSON.stringify({ loggedIn: false }))(), null);
  assert.equal(await probe('not json')(), null);
  assert.equal(await probe(null)(), null);
  assert.equal(await probe(signed({ configDirectory: '/somewhere/else' }))(), null, 'PLANT: claude reports another folder');
  writeFileSync(join(home, '.claude-account'), 'b\n');
  assert.equal(await probe(signed())(), null, 'account b chosen but its folder is not set up');
  assert.throws(() => signedInProbe({ home: 'relative' }));
});
