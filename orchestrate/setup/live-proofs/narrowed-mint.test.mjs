// narrowed-mint.test.mjs — the narrowed-mint proof against a fake GitHub (no network) and a key pair made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

/** A fake GitHub: what it answers can be changed per test. Records every call; any other host throws. */
function fakeGitHub({ grant = {}, selection = 'selected', extraRepos = [], issues = 403, otherInstalled = true, otherRead = 404, revoke = 204, after = 401 } = {}) {
  const calls = [];
  const revoked = new Set();
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== 'api.github.com') throw new Error(`no network: ${u.host}`);
    const method = init.method ?? 'GET';
    const auth = init.headers?.Authorization ?? '';
    calls.push({ method, path: u.pathname + u.search, auth: auth.startsWith('Bearer ghs_') ? auth.slice(7) : 'jwt' });
    if (method === 'POST' && /^\/app\/installations\/179098583\/access_tokens$/.test(u.pathname)) {
      const b = JSON.parse(init.body);
      const repo = b.repositories[0];
      if (repo === 'orchestrate-test') {
        return json(201, { token: PUSH_TOKEN, expires_at: '2026-11-14T20:00:00Z', permissions: { ...b.permissions, metadata: 'read', ...grant },
          repository_selection: selection, repositories: [{ name: repo, full_name: `${OWNER}/${repo}` }, ...extraRepos.map((n) => ({ name: n, full_name: `${OWNER}/${n}` }))] });
      }
      if (!otherInstalled) return json(422, { message: 'There is at least one repository that does not exist or is not accessible' });
      return json(201, { token: OTHER_TOKEN, expires_at: '2026-11-14T20:00:00Z', permissions: { metadata: 'read' }, repository_selection: 'selected', repositories: [{ name: repo, full_name: `${OWNER}/${repo}` }] });
    }
    if (method === 'GET' && u.pathname === '/app') return json(200, { slug: 'jw-orchestrate-robot' });
    const tok = auth.slice(7);
    if (method === 'DELETE' && u.pathname === '/installation/token') { if (revoke === 204) revoked.add(tok); return json(revoke, null); }
    if (revoked.has(tok) && after === 401) return json(401, { message: 'Bad credentials' });
    if (method === 'GET' && u.pathname === '/installation/repositories') {
      if (calls.some((c) => c.method === 'DELETE' && c.auth === tok)) return json(after, after === 401 ? { message: 'Bad credentials' } : { total_count: 1, repositories: [] });
      return json(200, { total_count: 1, repositories: [{ full_name: `${OWNER}/orchestrate-test` }] });
    }
    if (method === 'GET' && u.pathname === `/repos/${OWNER}/orchestrate-test/issues`) return json(issues, issues === 200 ? [] : { message: 'Resource not accessible by integration' });
    if (method === 'GET' && u.pathname === `/repos/${OWNER}/other-private`) return json(otherRead, otherRead === 200 ? { private: false } : { message: 'Not Found' });
    return json(404, { message: 'Not Found' });
  };
  return { fetchFn, calls };
}

const run = (gh, { c = config(), repo, ...o } = {}) => proof({ config: '/x/robot.json', otherRepo: 'otherRepo' in o ? o.otherRepo : 'other-private', read: () => c, products: products(repo), fetchFn: gh.fetchFn, uid: ME });
const step = (lines, n) => lines[lines.findIndex((l) => l.startsWith(`step ${n} `)) + 1].trim();
const noToken = (lines) => { for (const l of lines) { assert.ok(!l.includes(PUSH_TOKEN) && !l.includes(OTHER_TOKEN), `a line holds a token: ${l}`); } };

test('every step passes when GitHub narrows the token as asked, and both tokens are revoked', async () => {
  const gh = fakeGitHub();
  const r = await run(gh);
  assert.equal(r.pass, true, r.lines.join('\n'));
  for (const [n] of STEPS) assert.match(step(r.lines, n), /^PASS/, `step ${n}`);
  assert.equal(r.lines.at(-1), 'RESULT: PASS (6/6 steps PASS)');
  noToken(r.lines);
  // The push's own scope was asked for: contents and pull_requests write on the one repository.
  const asked = gh.calls.filter((c) => c.method === 'POST');
  assert.equal(asked.length, 2);
  const deletes = gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.auth).sort();
  assert.deepEqual(deletes, [PUSH_TOKEN, OTHER_TOKEN].sort());
  // Read only: no write on GitHub but the mints and the revokes.
  assert.deepEqual([...new Set(gh.calls.map((c) => c.method))].sort(), ['DELETE', 'GET', 'POST']);
  assert.ok(gh.calls.filter((c) => c.method === 'POST').every((c) => c.path.endsWith('/access_tokens')));
  // The step lines run 1..6 in order.
  assert.deepEqual(r.lines.filter((l) => l.startsWith('step ')).map((l) => Number(l.split(' ')[1])), [1, 2, 3, 4, 5, 6]);
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
  assert.match(step(r.lines, 4), /^NOT RUN .*could not be shown/);
  assert.equal(r.pass, false);
});

test('a public other repository, read with the push\'s token: step 4 FAILs and says to name a private one', async () => {
  const r = await run(fakeGitHub({ otherRead: 200 }));
  assert.match(step(r.lines, 4), /^FAIL .*public.*private/);
  assert.equal(r.pass, false);
});

test('GitHub grants more than was asked: token.mjs refuses it, step 1 FAILs and nothing after it runs', async () => {
  for (const grant of [{ issues: 'write' }, { contents: 'admin' }]) {
    const gh = fakeGitHub({ grant });
    const r = await run(gh);
    assert.match(step(r.lines, 1), /^FAIL .*more than was asked/);
    for (const n of [2, 3, 4, 5, 6]) assert.match(step(r.lines, n), /^NOT RUN/, `step ${n}`);
    assert.equal(gh.calls.filter((c) => c.method === 'GET' && c.path !== '/app').length, 0);
    noToken(r.lines);
  }
});

test('a token not limited to the chosen repositories, or one with more of them, FAILs at the mint', async () => {
  for (const over of [{ selection: 'all' }, { extraRepos: ['another'] }]) {
    const r = await run(fakeGitHub(over));
    assert.match(step(r.lines, 1), /^FAIL /);
    assert.equal(r.pass, false);
  }
});

test('a read outside the push\'s permissions answered 200: step 3 FAILs', async () => {
  const r = await run(fakeGitHub({ issues: 200 }));
  assert.match(step(r.lines, 3), /^FAIL .*not refused/);
  assert.equal(r.pass, false);
});

test('a revoke GitHub does not take, or a token still answered after: step 6 FAILs', async () => {
  for (const over of [{ revoke: 404 }, { after: 200 }]) {
    const r = await run(fakeGitHub(over));
    assert.match(step(r.lines, 6), /^FAIL .*not shown revoked/);
    assert.equal(r.pass, false);
  }
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
  const gh = fakeGitHub();
  const out = [];
  const ports = { read: () => config(), products: products(), fetchFn: gh.fetchFn, uid: ME };
  assert.equal(await main(['/x/robot.json', '--other-repo', 'other-private'], { out: (s) => out.push(s), err: () => {}, ...ports }), 0);
  assert.equal(out.at(-1), 'RESULT: PASS (6/6 steps PASS)');
  const dir = mkdtempSync(join(tmpdir(), 'narrowed-mint-result-'));
  const file = join(dir, 'mint.txt');
  assert.equal(await main(['/x/robot.json', '--other-repo', 'other-private', '--result', file], { out: () => {}, err: () => {}, ...ports, fetchFn: fakeGitHub().fetchFn }), 0);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /RESULT: PASS/);
  assert.ok(!text.includes(PUSH_TOKEN) && !text.includes(OTHER_TOKEN));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const errs = [];
  assert.equal(await main(['/x/robot.json', '--other-repo', 'other-private', '--result', file], { out: () => {}, err: (s) => errs.push(s), ...ports, fetchFn: fakeGitHub().fetchFn }), 2);
  assert.match(errs.join('\n'), /can't be made new/);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await main(['/x/robot.json'], { out: () => {}, err: () => {}, ...ports, fetchFn: fakeGitHub().fetchFn }), 1);
});

test('parseArgs: a full config path, and only --other-repo and --result', () => {
  assert.deepEqual(parseArgs(['/a/robot.json', '--other-repo', 'x', '--result', '/r']), { config: '/a/robot.json', otherRepo: 'x', result: '/r' });
  assert.throws(() => parseArgs(['robot.json']), /usage/);
  assert.throws(() => parseArgs(['/a/robot.json', '--token', 'x']), /unknown/);
  assert.throws(() => parseArgs(['/a/robot.json', '--result']), /unknown or empty/);
});
