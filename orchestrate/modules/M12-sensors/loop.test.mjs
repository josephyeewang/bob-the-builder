// R-0b-169: the Sensors' loop, run over the REAL M9 record (a record in a temp folder), and M11's own readers over what
// it wrote. No stand-in for the record or for M11; the only fakes are the outside world (the ports). GitHub answers come
// from real recorded responses (fixtures/github-pr-recorded.json); probes.test.mjs has the live read-only GitHub test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../M9-record/fixtures.test-helper.mjs';
import { installedLayout } from '../../shared/job-config.test-helper.mjs';
import { sensorsPass, timed, EVERY_S, PROBE_DEADLINE_MS, RUN_DEADLINE_MS, main, LOOP, EVENT } from './loop.mjs';
import { sensorsJobPlist } from './sensors-job.mjs';
import { prsToRead, prReader, MAX_PRS } from './probes/github-pr.mjs';
import { loginJobPlist } from '../M11-dispatcher/login-job.mjs';
import { READ_FACTS } from '../M11-dispatcher/read-facts.mjs';
import { signedInAccount } from '../M11-dispatcher/tick.mjs';
import { readFact, USAGE_FACT } from '../M11-dispatcher/usage.mjs';
import { FACTS, READING_MAX_AGE_MS } from '../M11-dispatcher/phone-link.mjs';
import { rulesWith } from '../M11-dispatcher/fixtures.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'github-pr-recorded.json'), 'utf8'));
const MIN = 60_000;
const T0 = Date.parse('2026-11-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ACCT = 'a';
const STALE = 15 * MIN;   // the sample policy's usage.stale_after_min

// M6's client shape over the recorded answers. `over(path, json)` changes one answer; `fail` makes every read fail.
function recordedGh({ over = {}, fail = false, open } = {}) {
  const base = '/repos/sample-org/sample-app';
  const answers = { ...REC.answers, ...over };
  if (open) answers['/pulls?state=open&per_page=100'] = open;
  return {
    calls: [],
    async get(path) {
      this.calls.push(['GET', path]);
      if (fail) throw new Error('network down');
      if (!path.startsWith(base)) return { status: 404, json: null };
      const k = path.slice(base.length);
      return answers[k] !== undefined ? { status: 200, json: structuredClone(answers[k]) } : { status: 404, json: { message: 'Not Found' } };
    },
    async post(path, body) {
      this.calls.push(['POST', path, body?.query?.trim().slice(0, 5)]);
      if (fail) throw new Error('network down');
      return { status: 200, json: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, nodes: [
        { isResolved: false, path: 'src/a.js', comments: { nodes: [{ author: { login: 'a-user' }, body: 'please rename' }] } }] } } } } } };
    },
  };
}
const usage = (now) => ({ source: 'test', h5: { used_pct: 20, resets_at: iso(now + 60 * MIN) }, week: { used_pct: 30, resets_at: iso(now + 3 * 24 * 60 * MIN) } });
const ports = (now, { gh = recordedGh({ open: [] }) } = {}) => ({
  whoIsSignedIn: async () => ACCT, readUsage: async () => usage(now),
  probes: { network: async () => true, reachable: async () => true, minibase: async () => true },
  github: { gh, owner: 'sample-org', repo: 'sample-app' },
});
const world = () => { const w = setup({ prefix: 'm12-loop-' }); return { rec: w.record, w }; };
const fact = (rec, id) => rec.read('fact', id)?.doc;

// ---- what the loop feeds, from M11's own list (planted: a family with no entry) ----

test('LOOP has an entry for exactly the families M11 reads (READ_FACTS), and only limit-hit- is not polled', async () => {
  assert.deepEqual(Object.keys(LOOP).sort(), READ_FACTS.map((f) => f.family).sort());
  assert.deepEqual(Object.entries(LOOP).filter(([, v]) => v === EVENT).map(([k]) => k), ['limit-hit-']);
  // PLANT: a loop that lacks one of M11's families says so in every pass.
  const { rec } = world();
  const { 'minibase-running': _gone, ...short } = LOOP;
  const r = await sensorsPass({ rec, ports: ports(T0), now: () => new Date(T0), loop: short });
  assert.ok(r.problems.includes('minibase-running: M11 reads it and the Sensors loop has no entry for it'), JSON.stringify(r.problems));
  assert.equal(fact(rec, FACTS.minibase), undefined);
});

// ---- a good pass, over the real record and M11's readers ----

test('a pass writes every polled family into the real record, each stamped, and M11 reads them as good', async () => {
  const { rec } = world();
  const r = await sensorsPass({ rec, ports: ports(T0, { gh: recordedGh({ open: [{ number: REC.merged }] }) }), now: () => new Date(T0) });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(Object.keys(r.wrote).sort(), ['frontdoor-reachable', 'minibase-running', 'network-up', `pr-${REC.merged}`, 'signed-in-account', `usage-${ACCT}`].sort());
  for (const k of Object.values(FACTS)) assert.deepEqual([fact(rec, k).value, fact(rec, k).observed_at], [true, iso(T0)], k);
  assert.deepEqual(signedInAccount({ rec, rules: rulesWith(), now: T0 + MIN }), { account: ACCT, reason: null });
  const u = readFact(rec.read('fact', USAGE_FACT(ACCT)), { account: ACCT, now: T0 + MIN, staleMs: STALE });
  assert.equal(u.ok, true, u.reason);
  const pr = fact(rec, `pr-${REC.merged}`);
  const real = REC.answers[`/pulls/${REC.merged}`];
  assert.deepEqual([pr.state, pr.merged, pr.merge_commit_sha, pr.head_sha, pr.observed_at], ['closed', true, real.merge_commit_sha, real.head.sha, iso(T0)]);
  assert.equal(rec.meta('fact', `pr-${REC.merged}`).createdBy, 'sensors');
  for (const id of Object.keys(r.wrote)) assert.equal(rec.meta('fact', id).createdBy, 'sensors', id);
});

test('the recorded open pull request reads as open, merged false and no merge commit (GitHub fills a test merge on open PRs)', async () => {
  if (!REC.open) return;
  const { rec } = world();
  await sensorsPass({ rec, ports: ports(T0, { gh: recordedGh({ open: [{ number: REC.open }] }) }), now: () => new Date(T0) });
  const pr = fact(rec, `pr-${REC.open}`);
  assert.deepEqual([pr.state, pr.merged, pr.merge_commit_sha], ['open', false, null]);
});

test('PLANT an uppercase CLOSED from GitHub is stored as closed', async () => {
  const { rec } = world();
  const real = REC.answers[`/pulls/${REC.merged}`];
  const gh = recordedGh({ open: [{ number: REC.merged }], over: { [`/pulls/${REC.merged}`]: { ...real, state: 'CLOSED' } } });
  await sensorsPass({ rec, ports: ports(T0, { gh }), now: () => new Date(T0) });
  assert.equal(fact(rec, `pr-${REC.merged}`).state, 'closed');
});

test('the GitHub calls are reads: GETs under the repo, and one POST that is the review-threads query', async () => {
  const { rec } = world();
  const gh = recordedGh({ open: [{ number: REC.merged }] });
  await sensorsPass({ rec, ports: ports(T0, { gh }), now: () => new Date(T0) });
  for (const c of gh.calls) {
    if (c[0] === 'GET') assert.ok(c[1].startsWith('/repos/sample-org/sample-app/'), c[1]);
    else assert.deepEqual(c, ['POST', '/graphql', 'query'], JSON.stringify(c));
  }
});

// ---- the time on a reading (planted: a reading stamped after its read) ----

test('PLANT observed_at is the time taken just BEFORE each read, not after (a slow read looks older, never newer)', async () => {
  const { rec } = world();
  let t = T0;
  const p = ports(T0, { gh: recordedGh({ open: [{ number: REC.merged }] }) });
  const began = {};
  const slow = (name, v) => async () => { began[name] = t; t += 4_000; return v; };
  p.probes.network = slow('network', true); p.probes.minibase = slow('minibase', true); p.whoIsSignedIn = slow('account', ACCT);
  const gh = p.github.gh; const get = gh.get.bind(gh);
  gh.get = async (path) => { if (/\/pulls\/\d+$/.test(path)) { began.pr ??= t; t += 4_000; } return get(path); };
  await sensorsPass({ rec, ports: p, now: () => new Date(t) });
  assert.equal(fact(rec, 'signed-in-account').observed_at, iso(began.account), 'the account read');
  // Each reading carries the clock as it was when its read began (parallel reads may share or differ; never later).
  assert.ok(Date.parse(fact(rec, FACTS.network).observed_at) <= began.network, 'the network read');
  assert.ok(Date.parse(fact(rec, FACTS.minibase).observed_at) <= began.minibase, 'the Mini Base read');
  assert.ok(Date.parse(fact(rec, `pr-${REC.merged}`).observed_at) <= began.pr, 'the PR read');
});

// ---- a failed read writes unknown with its time (planted: a probe that throws leaves the old fact) ----

test('a second pass replaces the first reading (M11 reads the new time)', async () => {
  const { rec } = world();
  await sensorsPass({ rec, ports: ports(T0), now: () => new Date(T0) });
  const r = await sensorsPass({ rec, ports: ports(T0 + MIN), now: () => new Date(T0 + MIN) });
  assert.deepEqual(r.problems, []);
  for (const k of [...Object.values(FACTS), 'signed-in-account', USAGE_FACT(ACCT)]) assert.equal(fact(rec, k).observed_at, iso(T0 + MIN), k);
});

test('PLANT a probe that throws replaces an old GOOD value with unknown and its time; M11 sees unknown', async () => {
  const { rec } = world();
  const prN = REC.merged;
  await sensorsPass({ rec, ports: ports(T0, { gh: recordedGh({ open: [{ number: prN }] }) }), now: () => new Date(T0) });
  const p = ports(T0 + MIN, { gh: recordedGh({ open: [{ number: prN }], over: { [`/pulls/${prN}`]: undefined } }) });
  p.probes.network = async () => { throw new Error('boom'); };
  p.probes.reachable = () => new Promise(() => {});
  p.whoIsSignedIn = async () => { throw new Error('no claude'); };
  const r = await sensorsPass({ rec, ports: p, now: () => new Date(T0 + MIN), deadlineMs: 50 });
  assert.deepEqual([fact(rec, FACTS.network).value, fact(rec, FACTS.network).observed_at], [null, iso(T0 + MIN)]);
  assert.deepEqual([fact(rec, FACTS.reachable).value, fact(rec, FACTS.reachable).observed_at], [null, iso(T0 + MIN)]);
  assert.deepEqual([fact(rec, FACTS.minibase).value], [true], 'the others still written');
  assert.deepEqual([fact(rec, 'signed-in-account').account, fact(rec, 'signed-in-account').observed_at], [null, iso(T0 + MIN)]);
  assert.equal(signedInAccount({ rec, rules: rulesWith(), now: T0 + MIN }).account, null);
  const pr = fact(rec, `pr-${prN}`);
  assert.deepEqual([pr.state, pr.merged, pr.merge_commit_sha, pr.head_sha, pr.observed_at], [null, null, null, null, iso(T0 + MIN)], 'the PR reading is unknown now');
  for (const want of [/network read: .*failed \(boom\)/, /reachable read: .*did not answer within 50 ms/, /signed-in account read: .*failed/, new RegExp(`pr-${prN}: GitHub could not be read`)]) {
    assert.ok(r.problems.some((x) => want.test(x)), `${want} in ${JSON.stringify(r.problems)}`);
  }
});

test('GitHub down: the open list fails, the record\'s PRs are still read, and each is written as unknown', async () => {
  const { rec, w } = world();
  await sensorsPass({ rec, ports: ports(T0, { gh: recordedGh({ open: [{ number: REC.merged }] }) }), now: () => new Date(T0) });
  const r = await sensorsPass({ rec, ports: ports(T0 + MIN, { gh: recordedGh({ fail: true }) }), now: () => new Date(T0 + MIN) });
  assert.ok(r.problems.some((p) => /open pull request list could not be read/.test(p)), JSON.stringify(r.problems));
  void w;
});

test('a usage read that fails is written as a reading with no figures (M11: unknown), never skipped', async () => {
  const { rec } = world();
  const p = ports(T0); p.readUsage = async () => { throw new Error('screen unreadable'); };
  await sensorsPass({ rec, ports: p, now: () => new Date(T0) });
  const d = fact(rec, USAGE_FACT(ACCT));
  assert.deepEqual([d.h5.used_pct, d.week.used_pct, d.observed_at], [null, null, iso(T0)]);
  assert.equal(readFact(rec.read('fact', USAGE_FACT(ACCT)), { account: ACCT, now: T0, staleMs: STALE }).ok, false);
});

test('no usage source yet (R-0b-66): written as unknown and said so; nobody signed in: no usage fact; a label is no account', async () => {
  const { rec } = world();
  const p = ports(T0); delete p.readUsage;
  const r = await sensorsPass({ rec, ports: p, now: () => new Date(T0) });
  assert.equal(fact(rec, USAGE_FACT(ACCT)).h5.used_pct, null);
  assert.ok(r.problems.some((x) => /no usage source yet/.test(x)));
  for (const who of [null, 'account A']) {
    const { rec: rec2 } = world();
    const p2 = ports(T0); p2.whoIsSignedIn = async () => who;
    const r2 = await sensorsPass({ rec: rec2, ports: p2, now: () => new Date(T0) });
    assert.equal(fact(rec2, 'signed-in-account').account, null);
    assert.equal(rec2.list('fact').some((f) => f.id.startsWith('usage-')), false);
    assert.ok(r2.problems.some((x) => /no signed-in account/.test(x)));
  }
});

// ---- which pull requests ----

test('prsToRead: every open PR plus every PR a merge still waits on (newest merge first), at most MAX_PRS, the rest named', async () => {
  const merges = [
    { id: 'M-1', doc: { pr: 11, state: 'merging' }, ts: T0 + 2 * MIN }, { id: 'M-2', doc: { pr: 12, state: 'refused' }, ts: T0 + 3 * MIN },
    { id: 'M-3', doc: { pr: 13, state: 'merged' }, ts: T0 + 4 * MIN }, { id: 'M-4', doc: { pr: 14, state: 'returned_to_builder' }, ts: T0 },
  ];
  const rec = { list: () => merges.map(({ id, doc }) => ({ id, doc })), meta: (e, id) => ({ ts: iso(merges.find((m) => m.id === id).ts) }) };
  const gh = recordedGh({ open: [{ number: 20 }, { number: 11 }] });
  const r = await prsToRead({ gh, owner: 'sample-org', repo: 'sample-app', rec });
  assert.deepEqual(r, { numbers: [12, 11, 20], dropped: [], problem: null });
  const many = recordedGh({ open: Array.from({ length: MAX_PRS + 2 }, (_, i) => ({ number: 100 + i })) });
  const r2 = await prsToRead({ gh: many, owner: 'sample-org', repo: 'sample-app', rec });
  // The two merges come first; the open list fills the rest; the last four open ones are named as not read.
  assert.deepEqual(r2.numbers, [12, 11, ...Array.from({ length: MAX_PRS - 2 }, (_, i) => 100 + i)]);
  assert.deepEqual(r2.dropped, [100 + MAX_PRS - 2, 100 + MAX_PRS - 1, 100 + MAX_PRS, 100 + MAX_PRS + 1]);
});

test('the PR reader: any answer but 200 throws (so the reading is unknown), and a check list for a non-commit is refused', async () => {
  const reader = prReader({ gh: recordedGh(), owner: 'sample-org', repo: 'sample-app' });
  await assert.rejects(reader.pr(99999), /pull 99999 answered 404/);
  await assert.rejects(reader.files(99999), /answered 404/);
  await assert.rejects(reader.checks('not-a-sha'), /no head commit/);
  const noPost = prReader({ gh: { get: recordedGh().get.bind(recordedGh()) }, owner: 'sample-org', repo: 'sample-app' });
  await assert.rejects(noPost.threads(REC.merged), /cannot run the review-threads query/);
  assert.throws(() => prReader({ gh: recordedGh(), owner: 'sample-org/../x', repo: 'sample-app' }));
});

// ---- the beat and the job ----

test('the beat: a pass every EVERY_S seconds keeps every polled reading fresh for M11 (two passes inside each age limit)', () => {
  assert.equal(EVERY_S, 60);
  for (const limit of [READING_MAX_AGE_MS, STALE]) assert.ok(2 * EVERY_S * 1000 + RUN_DEADLINE_MS < limit, `a missed pass must not make a reading unknown (${limit} ms)`);
  assert.ok(RUN_DEADLINE_MS < EVERY_S * 1000 * 2);
  assert.ok(PROBE_DEADLINE_MS < RUN_DEADLINE_MS);
});

test('the Sensors job file is the Dispatcher\'s layout: only the label and the log names differ', () => {
  const o = { label: 'org.sample.sensors', node: '/opt/node/bin/node', script: '/srv/orchestrate/modules/M12-sensors/loop.mjs', config: '/srv/sensors.json',
    path: '/usr/bin:/bin', logDir: '/srv/logs', workDir: '/srv' };
  const s = sensorsJobPlist(o).split('\n'); const d = loginJobPlist(o).split('\n');
  assert.equal(s.length, d.length);
  const diff = s.map((l, i) => [l, d[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(diff.map(([a]) => a.trim()), ['<key>StandardOutPath</key><string>/srv/logs/sensors.out.log</string>', '<key>StandardErrorPath</key><string>/srv/logs/sensors.err.log</string>']);
  assert.ok(s.includes('  <key>StartInterval</key><integer>60</integer>'));
  assert.throws(() => sensorsJobPlist({ ...o, config: 'relative.json' }));
});

test('timed: a late answer is dropped and a thrown error becomes a reason', async () => {
  assert.deepEqual(await timed(() => 5, 50, 'x'), { value: 5, failed: false, reason: null });
  assert.equal((await timed(() => new Promise(() => {}), 20, 'x')).failed, true);
  assert.match((await timed(() => { throw new Error('bad'); }, 50, 'x')).reason, /x failed \(bad\)/);
});

test('main refuses a missing config or a wiring without wire(), exit 1', async () => {
  const lines = [];
  assert.equal(await main([], { log: (s) => lines.push(s) }), 1);
  assert.equal(await main(['/no/such/file.json'], { log: (s) => lines.push(s) }), 1);
  assert.ok(lines.every((l) => /sensors: not started/.test(l)));
});

test('L253: main reads its config through the checked reader: the copy\'s own script and wiring pass; a checkout script or a config outside the copy is refused', async () => {
  const L = installedLayout('m12-loop-', { files: { 'wiring/sensors.mjs': 'export async function wire() { return {}; }\n' } });
  const config = L.write('sensors.json', { installRoot: L.installRoot, wiring: L.path('wiring/sensors.mjs') });
  const self = L.write('modules/M12-sensors/loop.mjs', 'export {};\n');
  const lines = [];
  // Past the reader: the stand-in wiring answers nothing, so the wiring's shape is what stops it.
  assert.equal(await main([config], { self, log: (s) => lines.push(s) }), 1);
  assert.match(lines.pop(), /wire\(\) must return/);
  // The default self is this checkout's loop.mjs, not a file of the copy.
  assert.equal(await main([config], { log: (s) => lines.push(s) }), 1);
  assert.match(lines.pop(), /M12-sensors\/loop\.mjs is not inside the installed copy/);
  const outside = join(L.base, 'outside.json');
  writeFileSync(outside, JSON.stringify({ installRoot: L.installRoot, wiring: L.path('wiring/sensors.mjs') }), { mode: 0o644 });
  assert.equal(await main([outside], { self, log: (s) => lines.push(s) }), 1);
  assert.match(lines.pop(), /outside\.json is not inside the installed copy/);
});

test('audit #144 r2 n1: a config that names no installRoot is refused by main, which says installRoot', async () => {
  const L = installedLayout('m12-noroot-', { files: { 'wiring/w.mjs': 'export async function wire() { return {}; }\n' } });
  const self = L.write('modules/M12-sensors/loop.mjs', 'export {};\n');
  // Everything else as a working config has it: only the reader can refuse this one (a job that read its own file
  // first and returned it when it named no installRoot would go on to the wiring instead).
  const config = L.write('job.json', { wiring: L.path('wiring/w.mjs') });
  const lines = [];
  assert.equal(await main([config], { self, log: (s) => lines.push(s) }), 1);
  assert.match(lines.join('\n'), /installRoot must be a full path/);
});
