// watch-only.test.mjs — R-0b-122's dry run on a fake GitHub that follows the REST shapes, with M10's real rules engine on
// its sample policy (no stand-ins for the judge). Each PLANT breaks one clause and names the test that catches it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';
import { blobSha } from '../M10-rules/reader.mjs';
import { fakeGateGitHub } from './fixtures/fake-gate-github.mjs';
import { VERDICTS, judgeMerged, readOnlyClient, summary, tokenFile, watchPass } from './watch-only.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = `${readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8')}\nproduct_profile:\n  required_checks: [test]\n`;
const SINCE = '2026-11-03T00:00:00Z';

/** A fake product: main with a docs file and a source file, and a way to land a change as a squash merge (or a plain push). */
function world() {
  const g = fakeGateGitHub();
  const root = g.commit([], { 'docs/a.md': 'one', 'src/a.mjs': 'one' });
  g.main = root;
  const mains = [];
  const rules = new Map();   // commit → the rules text at it (null = not there); a commit not listed has POLICY
  const refs = [];           // every commit the rules were asked for
  const gh = {
    ...g.gh,
    get: async (path) => {
      const rf = /^\/repos\/[^/]+\/[^/]+\/contents\/orchestrate\/policy\.yaml\?ref=([0-9a-f]{40})$/.exec(path);
      if (rf) {
        refs.push(rf[1]);
        const text = rules.has(rf[1]) ? rules.get(rf[1]) : POLICY;
        if (text === null) return { status: 404, json: null };
        const buf = Buffer.from(text, 'utf8');
        return { status: 200, json: { sha: blobSha(buf), size: buf.length, encoding: 'base64', content: buf.toString('base64') } };
      }
      if (/^\/repos\/[^/]+\/[^/]+\/commits\?sha=main&since=/.test(path)) return { status: 200, json: mains.map((sha) => ({ sha, commit: { committer: { date: '2026-11-03T10:00:00Z' } }, author: { login: 'joe-login' } })) };
      return g.gh.get(path);
    },
  };
  let n = 100;
  const land = (files, { checks, thread } = {}) => {
    const number = ++n;
    const head = g.commit([g.main], files, { from: g.main });
    g.openPull({ number, head, files });
    if (checks) g.checks.set(head, checks);
    g.threads = thread ? [{ isResolved: false, comments: { nodes: [{ author: { __typename: 'User' } }] } }] : [];
    const p = g.pulls.get(number);
    const merge = g.commit([g.main], files, { from: g.main });
    Object.assign(p, { state: 'closed', merged: true, merge_commit_sha: merge, merged_by: { login: 'joe-login' } });
    g.main = merge; mains.push(merge);
    return { number, merge, head };
  };
  const push = (files) => { const sha = g.commit([g.main], files, { from: g.main }); g.main = sha; mains.push(sha); return sha; };
  const dir = tempDir('m6-watch-');
  const pass = (at = '2026-11-03T12:00:00Z') => watchPass({ gh, owner: 'sample-org', repo: 'sample-app', dir, since: SINCE, now: () => at });
  const lines = () => readFileSync(join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { g, gh, land, push, dir, pass, lines, rules, refs };
}

test('a docs-only change with green checks and no open threads would merge', async () => {
  const w = world();
  w.land({ 'docs/a.md': 'two' });
  const r = await w.pass();
  assert.equal(r.judged, 1);
  const l = w.lines().find((x) => x.sha);
  assert.equal(l.verdict, VERDICTS[0], JSON.stringify(l));
  assert.deepEqual(l.refusals, []);
  assert.deepEqual(l.not_judged, [5, 10, 11, 2, 12], 'what cannot be judged before the cutover is said on every line, never passed');
});

test('PLANT a source change → would refuse, out of lane (caught by: the lane rule, refusal 9)', async () => {
  const w = world();
  w.land({ 'src/a.mjs': 'two' });
  await w.pass();
  const l = w.lines().find((x) => x.sha);
  assert.equal(l.verdict, VERDICTS[2]);
  assert.ok(l.refusals.some((x) => x.n === 9), JSON.stringify(l.refusals));
});

test('PLANT a red required check on the pull request head → would refuse (refusal 1)', async () => {
  const w = world();
  const { head } = (() => { const x = w.land({ 'docs/a.md': 'two' }); return x; })();
  // the check list is read at the PR head: make that head red after the fact
  w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' }]);
  await w.pass();
  const l = w.lines().find((x) => x.sha);
  assert.ok(l.refusals.some((x) => x.n === 1), JSON.stringify(l));
  assert.equal(l.verdict, VERDICTS[2]);
});

test('PLANT a check result for another commit → refusal 6', async () => {
  const w = world();
  const { head } = w.land({ 'docs/a.md': 'two' });
  w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: 'f'.repeat(40), status: 'completed', conclusion: 'success' }]);
  await w.pass();
  assert.ok(w.lines().find((x) => x.sha).refusals.some((x) => x.n === 6));
});

test('PLANT an unresolved human review thread → refusal 7', async () => {
  const w = world();
  w.land({ 'docs/a.md': 'two' }, { thread: true });
  await w.pass();
  assert.ok(w.lines().find((x) => x.sha).refusals.some((x) => x.n === 7));
});

test('PLANT a push to main with no pull request → would refuse (the gate only merges pull requests)', async () => {
  const w = world();
  w.push({ 'docs/a.md': 'direct' });
  await w.pass();
  const l = w.lines().find((x) => x.sha);
  assert.equal(l.direct, true); assert.equal(l.verdict, VERDICTS[2]);
});

test('PLANT a docs-lane change that is a link file → out of lane by mode (refusal 9)', async () => {
  const w = world();
  w.land({ 'docs/link.md': { text: 'a.md', mode: '120000' } });
  await w.pass();
  assert.ok(w.lines().find((x) => x.sha).refusals.some((x) => x.n === 9));
});

test('a second pass judges nothing twice; a new merge is picked up', async () => {
  const w = world();
  w.land({ 'docs/a.md': 'two' });
  await w.pass('2026-11-03T12:00:00Z');
  const again = await w.pass('2026-11-03T13:00:00Z');
  assert.equal(again.judged, 0); assert.equal(again.skipped, 1);
  w.land({ 'docs/a.md': 'three' });
  assert.equal((await w.pass('2026-11-03T14:00:00Z')).judged, 1);
});

test('nothing is written to GitHub: the only POST is the read-only threads query', async () => {
  const w = world();
  w.land({ 'docs/a.md': 'two' }); w.land({ 'src/a.mjs': 'two' }); w.push({ 'docs/a.md': 'x' });
  await w.pass();
  assert.ok(w.g.writes.length > 0);
  assert.ok(w.g.writes.every(([m, p]) => m === 'post' && p === '/graphql'), JSON.stringify(w.g.writes.map((x) => x.slice(0, 2))));
});

test('PLANT the rules file is unusable at that commit → "not judged" with the reason, the day is NOT covered, and the next pass tries again', async () => {
  const w = world();
  const m = w.land({ 'docs/a.md': 'two' });
  w.rules.set(m.merge, 'not: [valid');
  const r = await w.pass();
  assert.equal(r.judged, 0); assert.ok(r.problems.length);
  const l = w.lines().find((x) => x.sha);
  assert.match(l.not_judged_reason, /not usable/); assert.equal(l.verdict, undefined, 'no verdict is written without rules');
  const s = summary({ dir: w.dir, endDay: '2026-11-03', days: 1 });
  assert.deepEqual(s.missingDays, ['2026-11-03']); assert.equal(s.ok, false); assert.equal(s.judged, 0);
  w.rules.delete(m.merge);   // the rules become readable: the same commit is judged now (it was not marked as done)
  const again = await w.pass('2026-11-03T13:00:00Z');
  assert.equal(again.judged, 1); assert.equal(again.skipped, 0);
});

test('PLANT the rules file is missing (404) at one commit → that commit is not judged, the next one is, and no commit is judged against other rules', async () => {
  const w = world();
  const a = w.land({ 'docs/a.md': 'two' }); const b = w.land({ 'docs/a.md': 'three' });
  w.rules.set(a.merge, null);
  const r = await w.pass();
  assert.equal(r.judged, 1, 'the commit with readable rules is judged');
  const lines = w.lines().filter((x) => x.sha);
  assert.match(lines.find((x) => x.sha === a.merge).not_judged_reason, /could not be read/);
  assert.equal(lines.find((x) => x.sha === a.merge).verdict, undefined);
  assert.equal(lines.find((x) => x.sha === b.merge).verdict, VERDICTS[0]);
  assert.equal(r.problems.length, 1);
});

test('PLANT the text GitHub sends does not match the version it named → not judged', async () => {
  const w = world(); w.land({ 'docs/a.md': 'two' });
  const altered = { ...w.gh, get: async (p) => { const x = await w.gh.get(p); return /contents\/orchestrate\/policy/.test(p) ? { status: 200, json: { ...x.json, content: Buffer.from('product: {}\n').toString('base64') } } : x; } };
  const r = await watchPass({ gh: altered, owner: 'sample-org', repo: 'sample-app', dir: w.dir, since: SINCE, now: () => '2026-11-03T12:00:00Z' });
  assert.equal(r.judged, 0); assert.match(r.problems[0], /does not match the version GitHub named/);
});

test('the rules are read AT the commit being judged: one read per judged commit, each named by that commit\'s own id', async () => {
  const w = world();
  const a = w.land({ 'docs/a.md': 'two' }); const b = w.land({ 'docs/a.md': 'three' });
  await w.pass();
  assert.deepEqual([...w.refs].sort(), [a.merge, b.merge].sort());
});

test('PLANT main cannot be listed (GitHub down) → a pass line with the problem, no silent hole', async () => {
  const w = world();
  const down = { ...w.gh, get: async () => { throw new Error('network down'); } };
  const r = await watchPass({ gh: down, owner: 'sample-org', repo: 'sample-app', dir: w.dir, since: SINCE, now: () => '2026-11-03T12:00:00Z' });
  assert.match(r.problems[0], /could not be listed/);
  assert.equal(summary({ dir: w.dir, endDay: '2026-11-03', days: 1 }).ok, false);
});

test('summary: 7 covered days with every disagreement explained is ok; one unexplained or one missing day is not', async () => {
  const w = world();
  const bad = w.land({ 'src/a.mjs': 'two' });
  for (let d = 3; d <= 9; d++) await w.pass(`2026-11-0${d}T12:00:00Z`);
  let s = summary({ dir: w.dir, endDay: '2026-11-09' });
  assert.deepEqual(s.missingDays, []); assert.equal(s.judged, 1); assert.equal(s.disagreements, 1);
  assert.equal(s.unexplained.length, 1); assert.equal(s.ok, false, 'an unexplained refusal fails the week');
  writeFileSync(join(w.dir, 'explanations.json'), JSON.stringify({ [bad.merge]: 'source change merged by hand; the gate is not live yet' }));
  s = summary({ dir: w.dir, endDay: '2026-11-09' });
  assert.equal(s.unexplained.length, 0); assert.equal(s.ok, true);
  // a hole: a different end day has a day without a pass
  s = summary({ dir: w.dir, endDay: '2026-11-10' });
  assert.deepEqual(s.missingDays, ['2026-11-10']); assert.equal(s.ok, false);
});

test('judgeMerged: a Tier 1 or risky change that is in lane would ask for the owner\'s Approve, not merge', () => {
  const base = { direct: false, prBase: 'main', headSha: 'a'.repeat(40), checks: [], statuses: [], requiredChecks: [], ignored: [], threads: { ok: true, unresolved: 0 }, lane: null };
  assert.equal(judgeMerged({ ...base, classification: { tier: 1, risky: [] } }).verdict, VERDICTS[1]);
  assert.equal(judgeMerged({ ...base, classification: { tier: 2, risky: ['protected'] } }).verdict, VERDICTS[1]);
  assert.equal(judgeMerged({ ...base, classification: { tier: 2, risky: [] } }).verdict, VERDICTS[0]);
  assert.equal(judgeMerged({ ...base, classification: null, lane: 'the change\'s files could not be read' }).verdict, VERDICTS[2]);
  assert.equal(judgeMerged({ ...base, prBase: 'feature', classification: { tier: 2, risky: [] } }).refusals[0].n, 4);
  assert.equal(judgeMerged({ ...base, checks: null, statuses: null, requiredChecks: null, classification: { tier: 2, risky: [] } }).refusals[0].n, 1);
});

test('the client can only read: no write verb, no other host path, no other query; the token is never in an error', async () => {
  const SECRET = 'github_pat_11AAAAAAA0abcdefghijklmnop_QRSTUVWXYZ0123456789abcdef';
  const seen = [];
  const c = readOnlyClient({ token: () => SECRET, fetchFn: async (url, init) => { seen.push([init.method, url]); return { status: 200, json: async () => ({}) }; } });
  await c.get('/repos/a/b/pulls/1');
  await assert.rejects(() => c.get('/user'), (e) => !e.message.includes(SECRET));
  await assert.rejects(() => c.post('/repos/a/b/pulls/1/merge', {}), (e) => !e.message.includes(SECRET));
  await assert.rejects(() => c.post('/graphql', { query: 'mutation { x }' }), (e) => !e.message.includes(SECRET));
  assert.deepEqual(seen, [['GET', 'https://api.github.com/repos/a/b/pulls/1']]);
});

test('the token file must be the runner\'s own private file; its text never appears in an error', () => {
  const d = tempDir('m6-watch-tok-');
  const f = join(d, 'watch-only-token');
  const SECRET = 'github_pat_11BBBBBBB0abcdefghijklmnop_QRSTUVWXYZ0123456789abcdef';
  writeFileSync(f, `${SECRET}\n`); chmodSync(f, 0o600);
  assert.equal(tokenFile(f)(), SECRET);
  chmodSync(f, 0o644);
  assert.throws(() => tokenFile(f)(), (e) => !e.message.includes(SECRET) && /private file/.test(e.message));   // PLANT: readable by others
  chmodSync(f, 0o600);
  assert.throws(() => tokenFile(f, { uid: process.getuid() + 1 })(), /private file/);                           // PLANT: another user's file
  assert.throws(() => tokenFile(join(d, 'missing'))(), (e) => /could not be opened/.test(e.message));
});

// ── the command (watch-run.mjs)
test('watch-run: arguments are checked and never echoed; once runs a pass with a read-only client; summary exits 1 until the week counts', async () => {
  const { main: run, parseArgs } = await import('./watch-run.mjs');
  assert.throws(() => parseArgs(['once', 'ODD-LOOKING-ARG']), (e) => !e.message.includes('ODD-LOOKING-ARG'));
  assert.throws(() => parseArgs(['once', '--repo', 'a/b']), /required/);
  assert.throws(() => parseArgs(['summary', '--dir', 'x', '--end-day', 'tomorrow']), /YYYY-MM-DD/);
  const d = tempDir('m6-watch-cli-');
  const tok = join(d, 't'); const SECRET = 'github_pat_11CCCCCCC0abcdefghijklmnop_QRSTUVWXYZ0123456789abcdef';
  writeFileSync(tok, SECRET); chmodSync(tok, 0o600);
  const out = []; const errs = []; const calls = [];
  const fetchFn = async (url, init) => { calls.push([init.method, url]); return { status: 200, json: async () => [] }; };
  const code = await run(['once', '--repo', 'sample-org/sample-app', '--dir', join(d, 'w'), '--token-file', tok, '--since', SINCE], { out: (s) => out.push(s), err: (s) => errs.push(s), fetchFn });
  assert.equal(code, 0, errs.join('\n'));
  assert.ok(calls.length > 0 && calls.every(([m]) => m === 'GET'));
  assert.ok(![...out, ...errs].join('\n').includes(SECRET));
  const s = []; assert.equal(await run(['summary', '--dir', join(d, 'w'), '--end-day', '2026-11-09'], { out: (x) => s.push(x) }), 1);
  assert.match(s.join('\n'), /DOES NOT COUNT/);
});
