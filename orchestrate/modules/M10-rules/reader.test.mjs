// reader.test.mjs — the rules come only from main's rules file, only when Joe approved them, and every failure
// keeps the last good version or denies (spec review 0b-1: MAT-1, MAT-3, MAT-4; round 2: R2-M1, R2-m4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeReader, blobSha, readProducts, RULES_PATH, FETCH_GRACE_MS } from './reader.mjs';

const fixture = readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8');
const loose = fixture.replace('  editing_per_mac: 5', '  editing_per_mac: 50');
const PRODUCT = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };
const sha = (n) => n.toString(16).padStart(40, '0');

// A fake GitHub: main points at a commit; each commit has a rules text; compare answers from a parent list.
function fakeGitHub() {
  const gh = { calls: [], main: null, files: new Map(), parents: new Map(), down: false, missing: false, odd: null };
  gh.commit = (n, text, parent) => { gh.files.set(sha(n), text); if (parent) gh.parents.set(sha(n), sha(parent)); gh.main = sha(n); };
  const descends = (a, b) => { for (let c = b; c; c = gh.parents.get(c)) if (c === a) return true; return false; };
  gh.get = async (path) => {
    gh.calls.push(path);
    if (gh.down) throw new Error('network down');
    const base = `/repos/${PRODUCT.owner}/${PRODUCT.repo}`;
    if (path === `${base}/git/ref/heads/main`) return gh.main ? { status: 200, json: { object: { sha: gh.main } } } : { status: 404 };
    const c = new RegExp(`^${base}/contents/${RULES_PATH}\\?ref=([0-9a-f]{40})$`).exec(path);
    if (c) {
      const text = gh.files.get(c[1]);
      if (gh.missing || text === undefined) return { status: 404 };
      const buf = Buffer.from(text, 'utf8');
      const json = { type: 'file', path: RULES_PATH, sha: blobSha(buf), size: buf.length, encoding: 'base64', content: buf.toString('base64') };
      return { status: 200, json: gh.odd ? gh.odd(json) : json };
    }
    const m = new RegExp(`^${base}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`).exec(path);
    if (m) return { status: 200, json: { status: m[1] === m[2] ? 'identical' : descends(m[1], m[2]) ? 'ahead' : descends(m[2], m[1]) ? 'behind' : 'diverged' } };
    return { status: 404 };
  };
  return gh;
}

function setup({ approve = () => true, clock } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'm10-reader-'));
  const gh = fakeGitHub();
  const alerts = [];
  let t = 1_000_000;
  const now = clock ?? (() => t);
  const verifyCalls = [];
  const make = () => makeReader({ gh, stateDir, products: [PRODUCT], alert: (a) => alerts.push(a), now,
    verifyApproved: (q) => { verifyCalls.push(q); return approve(q); } });
  return { gh, stateDir, alerts, make, reader: make(), tick: (ms) => { t += ms; }, verifyCalls };
}

test('an approved rules file on main is adopted and kept on disk, private to Joe', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  const st = s.reader.state('sample-app');
  assert.equal(st.status, 'ok');
  assert.equal(st.policy.caps.editing_per_mac, 5);
  assert.equal(st.rev, `${sha(1).slice(0, 7)}:${blobSha(Buffer.from(fixture)).slice(0, 7)}`);
  const f = join(s.stateDir, 'sample-app.last-good.json');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).blob, blobSha(Buffer.from(fixture)));
  assert.deepEqual(s.alerts, []);
});

test('the reader reads only main, then the contents at the exact commit main pointed to (MAT-4, R2-m4)', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  s.gh.commit(2, loose, 1);
  await s.reader.refresh();
  for (const c of s.gh.calls) {
    assert.ok(c.startsWith('/repos/sample-org/sample-app/'), c);
    if (c.includes('/git/ref')) assert.ok(c.endsWith('/git/ref/heads/main'), c);
    if (c.includes('/contents/')) assert.match(c, new RegExp(`\\?ref=(${sha(1)}|${sha(2)})$`));
  }
});

test('the code never shells out or reads a local git copy (MAT-4, static check)', () => {
  const dir = new URL('.', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /child_process|execSync|spawn\(|\.git\/|simple-git|isomorphic-git/, f);
  }
});

test('a loosened local git copy changes nothing (MAT-4)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'm10-local-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('mkdir', ['-p', join(repo, 'orchestrate')]);
  writeFileSync(join(repo, RULES_PATH), loose);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/other/repo.git']);
  const before = process.cwd();
  process.chdir(repo);
  try {
    const s = setup();
    s.gh.commit(1, fixture);
    await s.reader.refresh();
    assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 5);
  } finally { process.chdir(before); }
});

test('a direct push Joe did not approve is not adopted: last good stays, one alert (R2-M1)', async () => {
  const s = setup({ approve: ({ blob }) => blob === blobSha(Buffer.from(fixture)) });
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  s.gh.commit(2, loose, 1);
  await s.reader.refresh();
  await s.reader.refresh();
  const st = s.reader.state('sample-app');
  assert.equal(st.status, 'last_good');
  assert.equal(st.policy.caps.editing_per_mac, 5);
  assert.deepEqual(s.alerts.map((a) => a.reason), ['unapproved_rules_change']);
});

test('a force push back to an older approved version is refused as main_rewound (R2-M1(b))', async () => {
  const s = setup();
  s.gh.commit(1, loose);
  await s.reader.refresh();
  s.gh.commit(2, fixture, 1);
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').policy.caps.editing_per_mac, 5);
  s.gh.main = sha(1);                                   // main rewound to the old, looser commit
  await s.reader.refresh();
  const st = s.reader.state('sample-app');
  assert.equal(st.policy.caps.editing_per_mac, 5);
  assert.equal(st.status, 'last_good');
  assert.deepEqual(s.alerts.map((a) => a.reason), ['main_rewound']);
});

test("Joe's id comes from the last good rules, never the file being checked (R2-M1(a))", async () => {
  const s = setup({ approve: ({ joeId }) => joeId === 1000001 });
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  s.gh.commit(2, fixture.replace('github_id: 1000001', 'github_id: 2000002'), 1);
  await s.reader.refresh();
  assert.equal(s.verifyCalls.at(-1).joeId, 1000001);
  // On a first load, the id comes from products.json.
  const t = setup();
  t.gh.commit(1, fixture.replace('github_id: 1000001', 'github_id: 2000002'));
  await t.reader.refresh();
  assert.equal(t.verifyCalls[0].joeId, 1000001);
});

test('with no allow-list, nothing is approved: a first load denies everything (R2-M1(d))', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'm10-reader-'));
  const gh = fakeGitHub(); gh.commit(1, fixture);
  const alerts = [];
  const reader = makeReader({ gh, stateDir, products: [PRODUCT], alert: (a) => alerts.push(a) });
  await reader.refresh();
  assert.equal(reader.state('sample-app').status, 'deny_all');
  assert.deepEqual(alerts.map((a) => a.reason), ['unapproved_rules_change']);
  writeFileSync(join(stateDir, 'approved-rules.json'), JSON.stringify({ 'sample-app': [blobSha(Buffer.from(fixture))] }));
  await reader.refresh();
  assert.equal(reader.state('sample-app').status, 'ok');
});

test('a corrupt new version keeps the last good one and alerts once per version (MAT-3)', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  s.gh.commit(2, `${fixture}\nsurprise: 1\n`, 1);
  await s.reader.refresh(); await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'last_good');
  assert.deepEqual(s.alerts.map((a) => a.reason), ['corrupt_rules']);
  assert.equal(s.verifyCalls.length, 1, 'a corrupt file is never even put to the approval check');
});

test('odd answers from GitHub count as corrupt', async () => {
  for (const odd of [(j) => ({ ...j, type: 'dir' }), (j) => ({ ...j, path: 'other.yaml' }), (j) => ({ ...j, size: 2_000_000 }),
    (j) => ({ ...j, sha: sha(9) }), (j) => ({ ...j, content: Buffer.from([0xff, 0xfe]).toString('base64'), size: 2 })]) {
    const s = setup();
    s.gh.odd = odd; s.gh.commit(1, fixture);
    await s.reader.refresh();
    assert.equal(s.reader.state('sample-app').status, 'deny_all');
    assert.equal(s.alerts[0].reason, 'corrupt_rules');
  }
});

test('a deleted rules file or branch denies everything at once (MAT-3)', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  s.gh.missing = true;
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'deny_all');
  assert.equal(s.alerts[0].reason, 'rules_missing');
  s.gh.missing = false; s.gh.main = null;
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'deny_all');
});

test('GitHub unreachable: last good for up to 300 s, then deny everything (MAT-3)', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  s.gh.down = true;
  s.tick(FETCH_GRACE_MS - 1000);
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'last_good');
  s.tick(2000);
  assert.equal(s.reader.state('sample-app').status, 'deny_all');
  await s.reader.refresh();
  assert.deepEqual(s.alerts.map((a) => a.reason), ['rules_unreachable']);
});

test('a clock that goes backwards does not extend the 300 s grace (audit minor 6)', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  assert.equal(s.reader.state('sample-app').status, 'ok');
  s.tick(-1);
  assert.equal(s.reader.state('sample-app').status, 'deny_all');
});

test('after a restart, the last good version is re-checked and used only after GitHub agrees (MAT-3)', async () => {
  const s = setup();
  s.gh.commit(1, fixture);
  await s.reader.refresh();
  const again = s.make();
  assert.equal(again.state('sample-app').status, 'deny_all', 'not trusted before a fresh read');
  await again.refresh();
  assert.equal(again.state('sample-app').status, 'ok');
  // A tampered last-good file is ignored.
  const f = join(s.stateDir, 'sample-app.last-good.json');
  const g = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...g, text: loose }));
  s.gh.down = true;
  const third = s.make();
  await third.refresh();
  assert.equal(third.state('sample-app').status, 'deny_all');
});

test('an unknown product, and a malformed products list, deny', () => {
  const s = setup();
  assert.equal(s.reader.state('other-app').status, 'deny_all');
  const dir = mkdtempSync(join(tmpdir(), 'm10-products-'));
  const f = join(dir, 'products.json');
  for (const bad of ['{}', '[{"product":"a"}]', '[{"product":"a","owner":"o","repo":"r"}]',
    '[{"product":"a/../b","owner":"o","repo":"r","joe_github_id":1}]',
    '[{"product":"a","owner":"o","repo":"r","joe_github_id":1},{"product":"a","owner":"o","repo":"r","joe_github_id":1}]']) {
    writeFileSync(f, bad);
    assert.throws(() => readProducts(f), bad);
  }
  writeFileSync(f, JSON.stringify([PRODUCT]));
  assert.equal(readProducts(f)[0].repo, 'sample-app');
});

test('an alert sink that throws does not change the answer', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'm10-reader-'));
  const gh = fakeGitHub(); gh.commit(1, fixture);
  const reader = makeReader({ gh, stateDir, products: [PRODUCT], verifyApproved: () => false, alert: () => { throw new Error('x'); } });
  await reader.refresh();
  assert.equal(reader.state('sample-app').status, 'deny_all');
});
