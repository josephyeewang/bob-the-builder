// narrowed-mint.test.mjs — the narrowed-mint proof against a fake GitHub (no network) and a key pair made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseArgs, proof, expectedPermissions, STEPS } from './narrowed-mint.mjs';
import { ROBOT_KEY_FILE } from '../../modules/M6-merge-gate/token.mjs';

const ME = process.getuid();
const OWNER = 'someone';
const PUSH_TOKEN = `ghs_${'A'.repeat(36)}`;
const OTHER_TOKEN = `ghs_${'B'.repeat(36)}`;

function keyDir() {
  const root = mkdtempSync(join(tmpdir(), 'narrowed-mint-'));
  const dir = join(root, 'keys');
  mkdirSync(dir, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(join(dir, ROBOT_KEY_FILE), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { root, dir };
}
const KEYS = keyDir();
process.on('exit', () => rmSync(KEYS.root, { recursive: true, force: true }));

const config = (over = {}) => ({ product: 'orchestrate-test', productsFile: '/x/products.json', keyDir: KEYS.dir, ownerUid: ME,
  appId: 5635682, appInstallation: 179098583, alertRepo: `${OWNER}/orchestrate-test`, alertOwner: OWNER, ...over });
const products = (repo = 'orchestrate-test') => () => [{ product: 'orchestrate-test', owner: OWNER, repo, joe_github_id: 1 }];

/**
 * A fake GitHub: what it answers can be changed per test. Records every call; any other host throws.
 *   grant / drop        permissions added to / left out of the push token's answer
 *   probeGrant          permissions added to the second token's answer
 *   selection, extraRepos, expires   the push token's answer
 *   pushStatus          the push mint's answer status (not 201: no token in it)
 *   listed              how many repositories the push token lists
 *   issues, otherRead   the outside reads' statuses
 *   otherInstalled      whether the App is on the other repository
 *   revokeFails         how many DELETEs answer 500 before 204; revoke: a fixed DELETE answer
 *   after               the push token's answer once revoked
 *   onPost              called as a mint starts, before GitHub answers
 */
function fakeGitHub({ grant = {}, drop = [], probeGrant = {}, selection = 'selected', extraRepos = [], expires = '2026-11-14T20:00:00Z', pushStatus = 201, listed = 1,
  issues = 403, otherInstalled = true, otherRead = 404, revokeFails = 0, revoke = 204, after = 401, onPost = null } = {}) {
  const calls = [];
  const revoked = new Set();
  let fails = revokeFails;
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== 'api.github.com') throw new Error(`no network: ${u.host}`);
    const method = init.method ?? 'GET';
    const auth = init.headers?.Authorization ?? '';
    const tok = auth.slice(7);
    calls.push({ method, path: u.pathname + u.search, auth: tok.startsWith('ghs_') ? tok : 'jwt' });
    if (method === 'POST' && /^\/app\/installations\/179098583\/access_tokens$/.test(u.pathname)) {
      if (onPost) await onPost();
      const b = JSON.parse(init.body);
      const repo = b.repositories[0];
      if (repo === 'orchestrate-test') {
        if (pushStatus !== 201) return json(pushStatus, { message: 'Validation Failed' });
        const permissions = { ...b.permissions, metadata: 'read', ...grant };
        for (const k of drop) delete permissions[k];
        return json(201, { token: PUSH_TOKEN, expires_at: expires, permissions,
          repository_selection: selection, repositories: [{ name: repo, full_name: `${OWNER}/${repo}` }, ...extraRepos.map((n) => ({ name: n, full_name: `${OWNER}/${n}` }))] });
      }
      if (!otherInstalled) return json(422, { message: 'There is at least one repository that does not exist or is not accessible' });
      return json(201, { token: OTHER_TOKEN, expires_at: '2026-11-14T20:00:00Z', permissions: { metadata: 'read', ...probeGrant }, repository_selection: 'selected', repositories: [{ name: repo, full_name: `${OWNER}/${repo}` }] });
    }
    if (method === 'GET' && u.pathname === '/app') return json(200, { slug: 'jw-orchestrate-robot' });
    if (method === 'DELETE' && u.pathname === '/installation/token') {
      if (fails > 0) { fails -= 1; return json(500, { message: 'Server Error' }); }
      if (revoke === 204) revoked.add(tok);
      return json(revoke, null);
    }
    if (revoked.has(tok) && after === 401) return json(401, { message: 'Bad credentials' });
    if (method === 'GET' && u.pathname === '/installation/repositories') {
      if (revoked.has(tok)) return json(after, { total_count: 1, repositories: [] });
      const names = ['orchestrate-test', 'second-one'].slice(0, listed);
      return json(200, { total_count: names.length, repositories: names.map((n) => ({ full_name: `${OWNER}/${n}` })) });
    }
    if (method === 'GET' && u.pathname === `/repos/${OWNER}/orchestrate-test/issues`) return json(issues, issues === 200 ? [] : { message: 'Resource not accessible by integration' });
    if (method === 'GET' && u.pathname === `/repos/${OWNER}/other-private`) return json(otherRead, otherRead === 200 ? { private: false } : { message: 'Not Found' });
    return json(404, { message: 'Not Found' });
  };
  return { fetchFn, calls };
}

// A stand-in for the process's signals: never the real ones, so a test can't stop the test run.
const fakeSignals = () => new EventEmitter();
const run = (gh, { c = config(), repo, signals = fakeSignals(), ...o } = {}) => proof({ config: '/x/robot.json', otherRepo: 'otherRepo' in o ? o.otherRepo : 'other-private',
  read: () => c, products: products(repo), fetchFn: gh.fetchFn, uid: ME, signals, exit: o.exit ?? (() => { throw new Error('no exit expected'); }), tell: o.tell ?? (() => {}), ...(o.mint ? { mint: o.mint } : {}) });
const step = (lines, n) => lines[lines.findIndex((l) => l.startsWith(`step ${n} `)) + 1].trim();
const noToken = (lines) => { for (const l of lines) { assert.ok(!l.includes(PUSH_TOKEN) && !l.includes(OTHER_TOKEN), `a line holds a token: ${l}`); } };
const deletes = (gh) => gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.auth);

test('every step passes when GitHub narrows the token as asked, and both tokens are revoked', async () => {
  const gh = fakeGitHub();
  const signals = fakeSignals();
  const r = await run(gh, { signals });
  assert.equal(r.pass, true, r.lines.join('\n'));
  for (const [n] of STEPS) assert.match(step(r.lines, n), /^PASS/, `step ${n}`);
  assert.equal(r.lines.at(-1), 'RESULT: PASS (6/6 steps PASS)');
  noToken(r.lines);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 2);
  assert.deepEqual(deletes(gh).sort(), [PUSH_TOKEN, OTHER_TOKEN].sort());
  // Read only: no write on GitHub but the mints and the revokes.
  assert.deepEqual([...new Set(gh.calls.map((c) => c.method))].sort(), ['DELETE', 'GET', 'POST']);
  assert.ok(gh.calls.filter((c) => c.method === 'POST').every((c) => c.path.endsWith('/access_tokens')));
  assert.deepEqual(r.lines.filter((l) => l.startsWith('step ')).map((l) => Number(l.split(' ')[1])), [1, 2, 3, 4, 5, 6]);
  // The stop handlers are taken off when the proof ends.
  assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0);
});

test('the permissions expected are the push\'s scope plus GitHub\'s metadata read', () => {
  assert.deepEqual(expectedPermissions('orchestrate-test'), { contents: 'write', pull_requests: 'write', metadata: 'read' });
});

test('no --other-repo: step 4 is NOT RUN, never a pass, and the token is still revoked', async () => {
  const gh = fakeGitHub();
  const r = await run(gh, { otherRepo: undefined });
  assert.equal(r.pass, false);
  assert.match(step(r.lines, 4), /^NOT RUN .*--other-repo/);
  assert.match(step(r.lines, 6), /^PASS/);
  assert.equal(r.lines.at(-1), 'RESULT: FAIL (5/6 steps PASS)');
});

test('the App not on the other repository: step 4 is NOT RUN', async () => {
  const r = await run(fakeGitHub({ otherInstalled: false }));
  assert.match(step(r.lines, 4), /^NOT RUN .*not shown there/);
  assert.equal(r.pass, false);
});

test('the other repository read with the push\'s token: only 403 or 404 is a refusal (200, 500, 401 FAIL)', async () => {
  const r200 = await run(fakeGitHub({ otherRead: 200 }));
  assert.match(step(r200.lines, 4), /^FAIL .*public.*private/);
  for (const otherRead of [500, 401]) {
    const r = await run(fakeGitHub({ otherRead }));
    assert.match(step(r.lines, 4), /^FAIL .*was not refused/, `answer ${otherRead}`);
    assert.equal(r.pass, false);
  }
});

test('the second token minted but refused by token.mjs: the App is shown there, step 4 runs, and that token is revoked too (m2)', async () => {
  const gh = fakeGitHub({ probeGrant: { contents: 'write' } });
  const r = await run(gh);
  assert.match(step(r.lines, 4), /^PASS/);
  assert.ok(r.lines.some((l) => /token\.mjs refused its answer/.test(l)));
  assert.deepEqual(deletes(gh).sort(), [PUSH_TOKEN, OTHER_TOKEN].sort());
  assert.match(step(r.lines, 6), /^PASS  2 token\(s\) revoked/);
  noToken(r.lines);
});

test('GitHub grants more than was asked: token.mjs refuses it, step 1 FAILs, 2-4 do not run, and the token it gave is revoked (m2)', async () => {
  for (const grant of [{ issues: 'write' }, { contents: 'admin' }]) {
    const gh = fakeGitHub({ grant });
    const r = await run(gh);
    assert.match(step(r.lines, 1), /^FAIL .*more than was asked.*GitHub did give a token: it is not used, and step 6 revokes it/);
    for (const n of [2, 3, 4]) assert.match(step(r.lines, n), /^NOT RUN/, `step ${n}`);
    assert.match(step(r.lines, 5), /^PASS/);
    assert.match(step(r.lines, 6), /^PASS/);
    assert.deepEqual(deletes(gh), [PUSH_TOKEN]);
    assert.equal(gh.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/repos/')).length, 0);
    noToken(r.lines);
    assert.equal(r.pass, false);
  }
});

test('a mint GitHub refuses (no token in its answer): step 1 FAILs without saying a token was given, step 6 NOT RUN (m3)', async () => {
  for (const pushStatus of [422, 401]) {
    const gh = fakeGitHub({ pushStatus });
    const r = await run(gh);
    assert.match(step(r.lines, 1), /^FAIL /);
    assert.ok(!/did give a token/.test(step(r.lines, 1)));
    assert.match(step(r.lines, 6), /^NOT RUN/);
    assert.equal(deletes(gh).length, 0);
  }
});

test('a token not limited to the chosen repositories, or one with more of them, FAILs at the mint', async () => {
  for (const over of [{ selection: 'all' }, { extraRepos: ['another'] }]) {
    const r = await run(fakeGitHub(over));
    assert.match(step(r.lines, 1), /^FAIL /);
    assert.equal(r.pass, false);
  }
});

test('a narrower permission answer than the push asks for: step 3 FAILs (an exact match, not a subset)', async () => {
  const r = await run(fakeGitHub({ drop: ['pull_requests'] }));
  assert.match(step(r.lines, 1), /^PASS/);
  assert.match(step(r.lines, 3), /^FAIL .*not exactly/);
  assert.equal(r.pass, false);
});

test('the token lists two repositories: step 2 FAILs', async () => {
  const r = await run(fakeGitHub({ listed: 2 }));
  assert.match(step(r.lines, 2), /^FAIL /);
  assert.equal(r.pass, false);
});

test('GitHub\'s answer not limited to the one repository, let through by a token.mjs stand-in: step 2 still FAILs', async () => {
  // A stand-in that hands back any token GitHub gives, with no check: the proof's own reading of the answer must catch it.
  const mint = async ({ http, installationId, scope }) => { const r = await http.post(`/app/installations/${installationId}/access_tokens`, { ...scope }, {}); return { ok: true, token: r.json.token }; };
  for (const over of [{ selection: 'all' }, { extraRepos: ['another'] }]) {
    const r = await run(fakeGitHub(over), { mint });
    assert.match(step(r.lines, 1), /^PASS/);
    assert.match(step(r.lines, 2), /^FAIL /, JSON.stringify(over));
    assert.equal(r.pass, false);
  }
});

test('a line carrying a token: step 5 FAILs, and the token is hidden before any line goes out', async () => {
  const r = await run(fakeGitHub({ expires: PUSH_TOKEN }));
  assert.match(step(r.lines, 5), /^FAIL /);
  noToken(r.lines);
  assert.ok(r.lines.some((l) => l.includes('[hidden]')));
  assert.equal(r.pass, false);
});

test('a read outside the push\'s permissions answered 200: step 3 FAILs', async () => {
  const r = await run(fakeGitHub({ issues: 200 }));
  assert.match(step(r.lines, 3), /^FAIL .*not refused/);
  assert.equal(r.pass, false);
});

test('a revoke answered 500 once is retried and passes; one GitHub never takes, or a token still answered after, FAILs (m4)', async () => {
  const once = fakeGitHub({ revokeFails: 1 });
  const r1 = await run(once, { otherRepo: undefined });
  assert.match(step(r1.lines, 6), /^PASS/);
  assert.ok(r1.lines.some((l) => /answered 500, then on the retry answered 204/.test(l)));
  assert.deepEqual(deletes(once), [PUSH_TOKEN, PUSH_TOKEN]);
  for (const over of [{ revoke: 404 }, { revokeFails: 2 }, { after: 200 }]) {
    const gh = fakeGitHub(over);
    const r = await run(gh, { otherRepo: undefined });
    assert.match(step(r.lines, 6), /^FAIL .*not shown revoked/, JSON.stringify(over));
    assert.equal(r.pass, false);
  }
  const twice = fakeGitHub({ revoke: 404 });
  await run(twice, { otherRepo: undefined });
  assert.equal(deletes(twice).length, 2, 'one retry, not more');
});

test('a stop (SIGINT) while the mint is in flight: it waits for the mint, revokes the token, says so without it, and exits 1 (m1)', async () => {
  const signals = fakeSignals();
  let stopped;
  const exited = new Promise((res) => { stopped = res; });
  const told = [];
  const gh = fakeGitHub({ onPost: async () => { signals.emit('SIGINT'); await new Promise((res) => setTimeout(res, 20)); } });
  const running = run(gh, { otherRepo: undefined, signals, exit: (code) => stopped(code), tell: (s) => told.push(s) });
  assert.equal(await exited, 1);
  assert.ok(deletes(gh).includes(PUSH_TOKEN));
  assert.match(told.join('\n'), /^stopped by SIGINT: 1 of 1 token\(s\) revoked\. No result\.$/);
  noToken(told);
  // The run itself goes on to its end here (a real stop exits); its step 6 finds the token revoked already.
  const r = await running;
  assert.ok(r.lines.some((l) => /revoked already/.test(l)));
  assert.equal(deletes(gh).filter((t) => t === PUSH_TOKEN).length, 1);
});

test('a stop (SIGTERM) before any token: nothing to revoke, exit 1', async () => {
  const signals = fakeSignals();
  let stopped;
  const exited = new Promise((res) => { stopped = res; });
  const told = [];
  const gh = fakeGitHub({ pushStatus: 422, onPost: async () => { signals.emit('SIGTERM'); } });
  const running = run(gh, { signals, exit: (code) => stopped(code), tell: (s) => told.push(s) });
  assert.equal(await exited, 1);
  assert.match(told.join('\n'), /stopped by SIGTERM: 0 of 0 token\(s\) revoked/);
  await running;
  assert.equal(deletes(gh).length, 0);
});

test('it runs on the test product only, and checks its inputs before any mint', async () => {
  const gh = fakeGitHub();
  await assert.rejects(run(gh, { repo: 'real-product' }), /not the test repository/);
  await assert.rejects(run(gh, { otherRepo: 'orchestrate-test' }), /another repository/);
  await assert.rejects(run(gh, { otherRepo: 'a/b' }), /without the owner/);
  await assert.rejects(run(gh, { c: config({ appId: undefined, appInstallation: undefined, alertRepo: undefined, alertOwner: undefined }) }), /no robot App/);
  assert.equal(gh.calls.length, 0);
});

test('as another Mac user than the Record\'s owner, token.mjs refuses the mint: FAIL, no call made', async () => {
  const gh = fakeGitHub();
  const r = await run(gh, { c: config({ ownerUid: ME + 1 }) });
  assert.match(step(r.lines, 1), /^FAIL .*only the scripts' Mac user/);
  assert.equal(gh.calls.length, 0);
});

test('main: prints the lines, writes the result file only with --result (new, 0600, no token), exits 0 on PASS', async () => {
  const ports = (gh) => ({ read: () => config(), products: products(), fetchFn: gh.fetchFn, uid: ME, signals: fakeSignals() });
  const out = [];
  assert.equal(await main(['/x/robot.json', '--other-repo', 'other-private'], { out: (s) => out.push(s), err: () => {}, ...ports(fakeGitHub()) }), 0);
  assert.equal(out.at(-1), 'RESULT: PASS (6/6 steps PASS)');
  const dir = mkdtempSync(join(tmpdir(), 'narrowed-mint-result-'));
  const file = join(dir, 'mint.txt');
  assert.equal(await main(['/x/robot.json', '--other-repo', 'other-private', '--result', file], { out: () => {}, err: () => {}, ...ports(fakeGitHub()) }), 0);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /RESULT: PASS/);
  assert.ok(!text.includes(PUSH_TOKEN) && !text.includes(OTHER_TOKEN));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const errs = [];
  assert.equal(await main(['/x/robot.json', '--other-repo', 'other-private', '--result', file], { out: () => {}, err: (s) => errs.push(s), ...ports(fakeGitHub()) }), 2);
  assert.match(errs.join('\n'), /^ran, no result file: .*can't be made new/);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await main(['/x/robot.json'], { out: () => {}, err: () => {}, ...ports(fakeGitHub()) }), 1);
});

test('parseArgs: a full config path, and only --other-repo and --result, each with a value', () => {
  assert.deepEqual(parseArgs(['/a/robot.json', '--other-repo', 'x', '--result', '/r']), { config: '/a/robot.json', otherRepo: 'x', result: '/r' });
  assert.throws(() => parseArgs(['robot.json']), /usage/);
  assert.throws(() => parseArgs(['/a/robot.json', '--token', 'x']), /unknown/);
  assert.throws(() => parseArgs(['/a/robot.json', '--result']), /unknown or empty/);
  assert.throws(() => parseArgs(['/a/robot.json', '--other-repo', '--result', '/r']), /unknown or empty argument --other-repo/);
});
