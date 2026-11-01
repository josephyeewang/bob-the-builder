// watch-only.test.mjs — R-0b-122's dry run on a stand-in GitHub that follows the REST shapes (newest-first, paged lists
// are not used any more: the pass walks main's first-parent chain), every call going through the real read-only client.
// The gate's real judge() and M10's real engine on its sample policy judge; nothing here is a copy of either.
// Each PLANT breaks one clause and the test name says which test catches it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';
import { blobSha } from '../M10-rules/reader.mjs';
import { fakeGateGitHub } from './fixtures/fake-gate-github.mjs';
import { DRAFT_FILE, NOT_JUDGED, VERDICTS, draftRules, githubRules, judgeMerged, readExplanations, readLog, readOnlyClient, summary, tokenFile, watchPass } from './watch-only.mjs';
import { explain, main, parseArgs } from './watch-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = `${readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8')}\nproduct_profile:\n  required_checks: [test]\n`;
const H = (t) => createHash('sha256').update(t).digest('hex');
const OWNER = 'sample-org'; const REPO = 'sample-app';
const BASE = `/repos/${OWNER}/${REPO}`;
const PIN_AT = '2026-11-03T00:00:00Z';
const UID = process.getuid();

/** A fake product on a stand-in GitHub. Every call a pass makes goes through readOnlyClient and a fetch that answers from it. */
function world({ policy = POLICY, mode = 'draft' } = {}) {
  const g = fakeGateGitHub();
  const root = g.commit([], { 'docs/a.md': 'one', 'src/a.mjs': 'one' });
  g.main = root;
  const dates = new Map([[root, '2026-10-01T00:00:00Z']]);
  const state = { graphql: null }; const mergedAt = new Map(); const prBase = new Map(); const threadsOf = new Map();
  const hooks = [];          // [regex, status] — a path that answers with that status
  const asked = [];          // every call made, [method, path]
  const reply = async (method, path, body) => {
    asked.push([method, path]);
    for (const [re, status] of hooks) if (re.test(path)) return { status, json: null };
    let m;
    if (method === 'GET') {
      if (path === `${BASE}/commits/main`) return { status: 200, json: { sha: g.main } };
      if ((m = new RegExp(`^${BASE}/commits/([0-9a-f]{40})$`).exec(path))) {
        const c = await g.gh.get(`${BASE}/git/commits/${m[1]}`);
        return c.status === 200 ? { status: 200, json: { sha: m[1], parents: c.json.parents, commit: { committer: { date: dates.get(m[1]) ?? '2026-11-03T10:00:00Z' } } } } : c;
      }
      if ((m = new RegExp(`^${BASE}/commits/([0-9a-f]{40})/pulls\\?per_page=100$`).exec(path))) {
        return { status: 200, json: [...g.pulls.values()].filter((x) => x.merge_commit_sha === m[1] || x.head === m[1]).map((x) => ({ number: x.number, merge_commit_sha: x.merge_commit_sha, state: x.state, base: { ref: prBase.get(x.number) ?? 'main' } })) };
      }
      if ((m = new RegExp(`^${BASE}/pulls/(\\d+)$`).exec(path))) {
        const r = await g.gh.get(path);
        return r.status === 200 ? { status: 200, json: { ...r.json, labels: labelsOf.get(Number(m[1])) ?? [], merged_at: mergedAt.get(Number(m[1])) ?? null, base: { ref: prBase.get(Number(m[1])) ?? 'main' } } } : r;
      }
      return g.gh.get(path);
    }
    if (path === '/graphql') {
      if (state.graphql) return { status: state.graphql, json: null };
      const nodes = threadsOf.get(body.variables.pr) ?? [];
      return { status: 200, json: { data: { repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, nodes } } } } } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const fetchFn = async (url, init) => {
    const r = await reply(init.method, url.replace('https://api.github.com', ''), init.body ? JSON.parse(init.body) : null);
    return { status: r.status, json: async () => r.json };
  };
  const client = readOnlyClient({ token: () => 'a-token-that-is-long-enough', fetchFn });
  let n = 100;
  const labelsOf = new Map();
  const land = (files, { checks, thread, at = '2026-11-03T10:00:00Z', base = 'main', merged = true } = {}) => {
    const number = ++n;
    const head = g.commit([g.main], files, { from: g.main });
    g.openPull({ number, head, files });
    if (checks) g.checks.set(head, checks);
    threadsOf.set(number, thread ? [{ isResolved: false, comments: { nodes: [{ author: { __typename: 'User' } }] } }] : []);
    prBase.set(number, base);
    const p = g.pulls.get(number);
    const merge = g.commit([g.main], files, { from: g.main });
    if (merged) Object.assign(p, { state: 'closed', merged: true, merge_commit_sha: merge, merged_by: { login: 'owner-login' } });
    dates.set(merge, at); mergedAt.set(number, at);
    g.main = merge;
    return { number, merge, head };
  };
  const push = (files, at = '2026-11-03T10:00:00Z') => { const sha = g.commit([g.main], files, { from: g.main }); g.main = sha; dates.set(sha, at); return sha; };
  const dir = tempDir('m6-watch-');
  if (mode === 'draft') writeFileSync(join(dir, DRAFT_FILE), policy);
  const rulesOf = () => (mode === 'draft' ? draftRules({ dir, sha256: H(policy) }) : githubRules({ gh: client, owner: OWNER, repo: REPO }));
  const pass = (at = '2026-11-03T12:00:00Z', rules = rulesOf()) => watchPass({ gh: client, owner: OWNER, repo: REPO, dir, rules, now: () => at });
  const lines = () => readLog(dir);
  const judged = () => lines().filter((l) => l.sha && !l.pin && !l.pass && !l.not_judged_reason);
  return { labelsOf, state, g, client, land, push, dir, pass, lines, judged, hooks, asked, dates, root, rulesOf, mergedAt };
}

/** A week: the pin pass at 3 Nov 00:00Z, a pass at noon each day to the 9th, and the last pass just after the 9th ends. */
async function weekOf(w, { skip = [] } = {}) {
  await w.pass(PIN_AT);
  for (const d of ['03', '04', '05', '06', '07', '08', '09']) if (!skip.includes(d)) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-10T00:30:00Z');
}
const ownFile = (contents) => {
  const folder = tempDir('m6-watch-owner-'); chmodSync(folder, 0o755);
  const file = join(folder, 'explanations.json'); writeFileSync(file, JSON.stringify(contents)); chmodSync(file, 0o644);
  return file;
};
const week = (w, extra = {}) => summary({ dir: w.dir, endDay: '2026-11-09', explanations: readExplanations(extra.file ?? null, { ownerUid: UID }) });
const NOEX = { ok: true, explanations: {}, owner: null, problem: null };

// ───────────────────────────── the judging: the gate's real judge()

test('a docs-only change with green checks and no open threads would merge; what cannot be judged is said, not passed', async () => {
  const w = world();
  await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' });
  const r = await w.pass();
  assert.equal(r.judged, 1, JSON.stringify(r));
  const l = w.judged()[0];
  assert.equal(l.verdict, VERDICTS[0], JSON.stringify(l));
  assert.deepEqual(l.refusals, []);
  assert.deepEqual(l.not_judged, [...NOT_JUDGED], 'every line lists what cannot be judged afterwards');
  assert.deepEqual(l.assumed, { declared_tier: 2, product_state: 'active' }, 'the assumptions are stated on every line');
});

test('PLANT a source change → would refuse, out of lane (caught by: the lane rule, refusal 9)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'src/a.mjs': 'two' }); await w.pass();
  const l = w.judged()[0];
  assert.equal(l.verdict, VERDICTS[2]);
  assert.ok(l.refusals.some((x) => x.n === 9), JSON.stringify(l.refusals));
});

test('PLANT a red required check on the pull request head → refusal 1', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { head } = w.land({ 'docs/a.md': 'two' });
  w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' }]);
  await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 1));
});

test('PLANT a required check that never ran → refusal 1 (P13)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { head } = w.land({ 'docs/a.md': 'two' });
  w.g.checks.set(head, [{ name: 'lint', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' }]);
  await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 1 && /test/.test(x.reason)), JSON.stringify(w.judged()[0].refusals));
});

test('PLANT a check result for another commit → refusal 6', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { head } = w.land({ 'docs/a.md': 'two' });
  w.g.checks.set(head, [{ name: 'test', app: { id: 1 }, head_sha: 'f'.repeat(40), status: 'completed', conclusion: 'success' }]);
  await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 6));
});

test('PLANT a red commit status → refusal 1 (P22)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { head } = w.land({ 'docs/a.md': 'two' });
  w.g.statuses.set(head, [{ context: 'ci/other', state: 'failure' }]);
  await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 1), JSON.stringify(w.judged()[0]));
});

test('PLANT a check list of 100 or more → refusal 1, never silently cut (P11)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { head } = w.land({ 'docs/a.md': 'two' });
  w.g.checks.set(head, Array.from({ length: 100 }, (_, i) => ({ name: i ? `c${i}` : 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' })));
  await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 1));
});

test('PLANT an unresolved human review thread → refusal 7; a bot thread does not count', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { thread: true }); await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 7));
});

test('PLANT a pull request stacked on another branch → refusal 4', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { base: 'feature' }); await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 4), JSON.stringify(w.judged()[0]));
});

test('PLANT a docs-lane change that is a link file → refusal 9 (by mode)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/link.md': { text: 'a.md', mode: '120000' } }); await w.pass();
  assert.ok(w.judged()[0].refusals.some((x) => x.n === 9));
});

test('PLANT a push to main with no pull request → would refuse by refusal 9, not judged like a pull request (P19)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.push({ 'docs/a.md': 'direct' }); await w.pass();
  const l = w.judged()[0];
  assert.equal(l.direct, true); assert.equal(l.verdict, VERDICTS[2]);
  assert.deepEqual(l.refusals.map((x) => x.n), [9]);
});

test('PLANT an unmerged pull request whose head was pushed to main → a push with no merge, refusal 9 (P12)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { head } = w.land({ 'docs/a.md': 'two' }, { merged: false });
  w.g.main = head;
  await w.pass();
  const l = w.judged()[0];
  assert.equal(l.direct, true, JSON.stringify(l));
  assert.deepEqual(l.refusals.map((x) => x.n), [9]);
});

test('the real judge() runs: the refusals it adds for what was not judged never appear, a judge failure (0) would', () => {
  const rules = draftRules({ dir: tempDir('m6-watch-'), sha256: 'a'.repeat(64) });
  assert.equal(typeof rules.at, 'function');
  const facts = { direct: false, sha: 'a'.repeat(40), headSha: 'b'.repeat(40), pr: 5, prBase: 'main', labels: [], checks: [], statuses: [], threads: { ok: true, unresolved: 0 }, files: null };
  return draftRulesFor().then((rs) => {
    const v = judgeMerged(facts, rs);
    assert.equal(v.verdict, VERDICTS[2]);
    assert.ok(v.refusals.every((x) => !NOT_JUDGED.includes(x.n)), JSON.stringify(v.refusals));
    assert.ok(v.refusals.some((x) => x.n === 9), 'files unread → no merge answer');
  });
});
async function draftRulesFor() { const dir = tempDir('m6-watch-'); writeFileSync(join(dir, DRAFT_FILE), POLICY); return draftRules({ dir, sha256: H(POLICY) }).at(); }

// ───────────────────────────── M4: a failed read is retried, never a verdict

for (const [name, re] of [
  ['the review threads (graphql)', null],
  ['the pull requests for a commit', /\/commits\/[0-9a-f]{40}\/pulls/],
  ['the pull request', /\/pulls\/\d+$/],
  ['the check runs', /\/check-runs/],
  ['the statuses', /\/status\?/],
  ['the compare', /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/],
]) {
  test(`PLANT a failed read of ${name} → "not judged" with the reason and tried again, then judged when it works (M4)`, async () => {
    const w = world(); await w.pass(PIN_AT);
    const { merge } = w.land({ 'docs/a.md': 'two' });
    // the compare for the pin check has a different pair; fail only the commit-level reads
    let hook;
    if (re === null) { w.state.graphql = 502; hook = () => { w.state.graphql = null; }; }
    else { w.hooks.push([re, 500]); hook = () => { w.hooks.length = 0; }; }
    const r = await w.pass('2026-11-03T12:00:00Z');
    if (re !== null && /compare/.test(String(re))) { /* the pin check shares this path shape: either the pin or the commit failed */ assert.ok(r.problems.length); hook(); await w.pass('2026-11-03T13:00:00Z'); assert.equal(w.judged().length, 1); return; }
    assert.equal(w.judged().length, 0, 'no verdict on a gap');
    assert.ok(r.problems.some((p) => p.includes(merge.slice(0, 8)) && /not judged/.test(p)), JSON.stringify(r.problems));
    assert.ok(w.lines().some((l) => l.sha === merge && l.not_judged_reason));
    hook();
    const r2 = await w.pass('2026-11-03T13:00:00Z');
    assert.equal(r2.judged, 1, JSON.stringify(r2));
    assert.equal(w.judged()[0].verdict, VERDICTS[0]);
  });
}

test('PLANT an empty pull-request list for a commit under an hour old → tried again, not a direct push (M4)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { merge } = w.land({ 'docs/a.md': 'two' }, { at: '2026-11-03T11:45:00Z' });
  w.hooks.length = 0;
  // GitHub has not linked the commit yet: the list is empty
  const real = w.g.pulls.get(101); const saved = { ...real };
  Object.assign(real, { merge_commit_sha: null, head: 'e'.repeat(40) });
  const r = await w.pass('2026-11-03T12:00:00Z');
  assert.equal(w.judged().length, 0);
  assert.ok(r.problems.some((p) => /under an hour old/.test(p)), JSON.stringify(r.problems));
  Object.assign(real, saved);
  const r2 = await w.pass('2026-11-03T12:10:00Z');
  assert.equal(r2.judged, 1);
  assert.equal(w.judged()[0].sha, merge);
});

test('the same not-judged reason is logged once, not every hour', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' });
  w.hooks.push([/\/check-runs/, 500]);
  await w.pass('2026-11-03T12:00:00Z'); await w.pass('2026-11-03T13:00:00Z'); await w.pass('2026-11-03T14:00:00Z');
  assert.equal(w.lines().filter((l) => l.not_judged_reason).length, 1);
});

// ───────────────────────────── M3: the pin, the first-parent walk

test('the first pass pins main\'s head and judges nothing before it; later commits are judged', async () => {
  const w = world();
  w.land({ 'src/a.mjs': 'before the pin' });
  const r = await w.pass(PIN_AT);
  assert.equal(r.judged, 0);
  const pin = w.lines().find((l) => l.pin === true);
  assert.equal(pin.sha, w.g.main); assert.equal(pin.at, PIN_AT); assert.match(pin.how, /first pass/);
  w.land({ 'docs/a.md': 'two' });
  assert.equal((await w.pass()).judged, 1);
});

test('a commit with an OLD committer date, pushed after the pin, is still judged (the walk uses history, not dates) (M3)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.push({ 'docs/a.md': 'old date' }, '2020-01-01T00:00:00Z');
  assert.equal((await w.pass()).judged, 1);
});

test('the walk stops at a commit already judged: only new commits are looked at', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); await w.pass('2026-11-03T12:00:00Z');
  const first = w.judged()[0].sha;
  w.land({ 'docs/a.md': 'three' });
  const before = w.asked.length;
  const r = await w.pass('2026-11-03T13:00:00Z');
  assert.equal(r.judged, 1);
  assert.ok(w.asked.slice(before).every(([, p]) => !p.includes(`/commits/${first}`)), 'the judged commit is not read again');
  assert.equal(w.judged().length, 2);
});

test('PLANT the pin leaves main (a rewrite) → a problem every pass, the pass is not clean, even when the walk stops early (M3 / lead condition a)', async () => {
  const w = world(); w.land({ 'docs/a.md': 'before the pin' }); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); await w.pass('2026-11-03T12:00:00Z');
  const rewritten = w.g.commit([w.root], { 'docs/a.md': 'other history' }, { from: w.root });
  w.g.main = rewritten;
  const r = await w.pass('2026-11-03T13:00:00Z');
  assert.ok(r.problems.some((p) => /no longer an ancestor/.test(p)), JSON.stringify(r.problems));
  const last = w.lines().at(-1);
  assert.equal(last.pin_ok, false);
  assert.equal(summary({ dir: w.dir, endDay: '2026-11-09', explanations: NOEX }).ok, false);
});

test('PLANT main\'s history never reaches the pin within the walk limit → a problem, not a silent stop', async () => {
  const w = world(); await w.pass(PIN_AT);
  for (let i = 0; i < 4; i++) w.land({ 'docs/a.md': `v${i}` });
  const r = await watchPass({ gh: w.client, owner: OWNER, repo: REPO, dir: w.dir, rules: w.rulesOf(), now: () => '2026-11-03T12:00:00Z', maxWalk: 2 });
  assert.ok(r.problems.some((p) => /did not lead back to the pin/.test(p)), JSON.stringify(r.problems));
});

test('PLANT two passes at once → the second does nothing (lock); a dead pass\'s old lock is replaced (m4)', async () => {
  const w = world(); await w.pass(PIN_AT);
  writeFileSync(join(w.dir, 'watch.lock'), '1');
  const fresh = new Date('2026-11-03T11:55:00Z'); utimesSync(join(w.dir, 'watch.lock'), fresh, fresh);
  const r = await w.pass('2026-11-03T12:00:00Z');
  assert.equal(r.locked, true);
  assert.equal(w.lines().filter((l) => l.pass).length, 1, 'a locked pass writes no line');
  const old = new Date('2026-11-03T11:00:00Z'); utimesSync(join(w.dir, 'watch.lock'), old, old);
  const r2 = await w.pass('2026-11-03T12:00:00Z');
  assert.notEqual(r2.locked, true);
  assert.equal(existsSync(join(w.dir, 'watch.lock')), false, 'the lock is released');
});

// ───────────────────────────── M1: the rules

test('PLANT the rules draft is not the pinned one → "not judged" with both hashes, never judged on other rules (M1)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' });
  writeFileSync(join(w.dir, DRAFT_FILE), `${POLICY}\n# edited`);
  const r = await w.pass();
  assert.equal(w.judged().length, 0);
  assert.ok(r.problems.some((p) => p.includes(H(POLICY).slice(0, 12))), JSON.stringify(r.problems));
});

test('a changed pinned draft restarts the week: a new pin, the old one named (M1)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const policy2 = `${POLICY}\n# second draft`;
  writeFileSync(join(w.dir, DRAFT_FILE), policy2);
  w.land({ 'docs/a.md': 'two' });
  await w.pass('2026-11-04T12:00:00Z', draftRules({ dir: w.dir, sha256: H(policy2) }));
  const pins = w.lines().filter((l) => l.pin === true);
  assert.equal(pins.length, 2); assert.equal(pins[1].restart_of, pins[0].sha); assert.equal(pins[1].rules, H(policy2));
  assert.equal(w.judged().length, 0, 'the commit before the new pin is not judged');
});

test('every judged line records the rules hash it was judged on (M1)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); await w.pass();
  assert.equal(w.judged()[0].rules, H(POLICY));
});

test('PLANT a missing pinned hash or draft file → not judged with the reason, nothing invented', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' });
  const r = await w.pass('2026-11-03T12:00:00Z', draftRules({ dir: w.dir, sha256: undefined }));
  assert.ok(r.problems.some((p) => /no pinned hash/.test(p)));
  const dir2 = tempDir('m6-watch-');
  const rr = await draftRules({ dir: dir2, sha256: H(POLICY) }).at();
  assert.match(rr.reason, /could not be read/);
});

test('PLANT the draft is a link → refused, not followed (O_NOFOLLOW)', async () => {
  const dir = tempDir('m6-watch-'); const real = join(tempDir('m6-watch-'), 'real.yaml'); writeFileSync(real, POLICY);
  symlinkSync(real, join(dir, DRAFT_FILE));
  const r = await draftRules({ dir, sha256: H(POLICY) }).at();
  assert.ok(r.reason && /could not be read/.test(r.reason), JSON.stringify(r));
});

test('rules from GitHub: a 404 and a 500 are told apart and the status comes first (M1)', async () => {
  const w = world({ mode: 'github' });
  const rules = w.rulesOf(); const parent = w.root;
  const none = await rules.at(parent);
  assert.match(none.reason, /^HTTP 404/);
  w.hooks.push([/\/contents\//, 500]);
  const boom = await rules.at(parent);
  assert.match(boom.reason, /^HTTP 500/);
  assert.notEqual(none.reason, boom.reason);
});

test('rules from GitHub: read at the FIRST PARENT of the judged merge, and unapproved rules are not used (M1 / m5)', async () => {
  const w = world({ mode: 'github' });
  await w.pass(PIN_AT);
  const unapproved = w.push({ 'orchestrate/policy.yaml': POLICY }, '2026-11-03T09:00:00Z');   // a direct push of looser rules
  w.land({ 'docs/a.md': 'two' });
  const r = await w.pass();
  assert.ok(!w.lines().some((l) => l.sha === unapproved && l.verdict), 'the direct push had no rules before it');
  assert.ok(r.problems.some((p) => /not approved|HTTP 404/.test(p)), JSON.stringify(r.problems));
  assert.ok(!w.lines().some((l) => l.verdict === VERDICTS[0]), 'nothing judged on the unapproved rules');
});

test('rules from GitHub: approved rules (landed by a merged pull request) judge the next merge at its first parent', async () => {
  const w = world({ mode: 'github' });
  await w.pass(PIN_AT);
  const rulesPr = w.land({ 'orchestrate/policy.yaml': POLICY });
  const docs = w.land({ 'docs/a.md': 'two' });
  const r = await w.pass();
  const l = w.lines().find((x) => x.sha === docs.merge);
  assert.ok(l && l.verdict === VERDICTS[0], JSON.stringify({ r, l, rulesLine: w.lines().find((x) => x.sha === rulesPr.merge) }));
  assert.equal(l.rules, blobSha(Buffer.from(POLICY)), 'the line records the rules blob');
  assert.ok(w.lines().some((x) => x.sha === rulesPr.merge && x.not_judged_reason && /^HTTP 404/.test(x.not_judged_reason)), 'the rules\' own merge had no rules before it');
});

test('PLANT rules of the same size but different text → refused by the blob check (m6 / P4)', async () => {
  const w = world({ mode: 'github' });
  const text = POLICY; const buf = Buffer.from(text);
  const swapped = Buffer.from(text.replace('required_checks: [test]', 'required_checks: [tesx]'));
  assert.equal(swapped.length, buf.length);
  w.hooks.length = 0;
  const gh = { get: async (p) => (p.includes('/contents/') ? { status: 200, json: { sha: blobSha(buf), size: buf.length, encoding: 'base64', content: swapped.toString('base64') } } : w.client.get(p)), post: w.client.post };
  const r = await githubRules({ gh, owner: OWNER, repo: REPO }).at(w.root);
  assert.match(r.reason, /does not match the version GitHub named/);
});

// ───────────────────────────── M2, M5: the week

test('a full week of clean passes with one agreeing merge counts', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-04T09:00:00Z' });
  await weekOf(w);
  const s = week(w);
  assert.deepEqual(s.reasons, []); assert.equal(s.ok, true); assert.equal(s.judged, 1);
  assert.equal(s.days.length, 7); assert.equal(s.days[0], '2026-11-03');
});

test('PLANT a merge at 23:30 on the end day that no pass saw → the week does not count; a pass after midnight sees it (M2 / probe A)', async () => {
  const w = world(); await w.pass(PIN_AT);
  for (const d of ['03', '04', '05', '06', '07', '08', '09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  w.land({ 'docs/a.md': 'late' }, { at: '2026-11-09T23:30:00Z' });
  const s = week(w);
  assert.equal(s.ok, false); assert.ok(s.reasons.some((r) => /no clean pass at or after/.test(r)), JSON.stringify(s.reasons));
  await w.pass('2026-11-10T00:30:00Z');
  const s2 = week(w);
  assert.equal(s2.ok, true, JSON.stringify(s2.reasons)); assert.equal(s2.judged, 1);
});

test('PLANT a mid-day summary → the day is not finished, the week does not count (M2 / probe B)', async () => {
  const w = world(); await w.pass(PIN_AT);
  for (const d of ['03', '04', '05', '06', '07', '08', '09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  assert.equal(week(w).ok, false);
});

test('PLANT fewer than 7 UTC days → does not count (M5)', async () => {
  const w = world(); await w.pass(PIN_AT);
  for (const d of ['03', '04', '05']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-06T00:30:00Z');
  const s = summary({ dir: w.dir, endDay: '2026-11-05', explanations: NOEX });
  assert.equal(s.ok, false); assert.ok(s.reasons.some((r) => /needs 7/.test(r)));
});

test('PLANT a day with no clean pass → named, does not count', async () => {
  const w = world(); await w.pass(PIN_AT);
  await weekOf(w, { skip: ['06'] });
  const s = week(w);
  assert.equal(s.ok, false); assert.deepEqual(s.missingDays, ['2026-11-06']);
});

test('PLANT a pass with a problem is not a clean pass for its day', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-03T08:00:00Z' });
  w.hooks.push([/\/check-runs/, 500]);
  await w.pass('2026-11-03T12:00:00Z');
  for (const d of ['04', '05', '06', '07', '08', '09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-10T00:30:00Z');
  const s = week(w);
  assert.equal(s.ok, false);
  assert.ok(s.reasons.some((r) => /not judged/.test(r)) || s.missingDays.length, JSON.stringify(s));
});

test('PLANT a commit "not judged" and never judged later → the week does not count (M3)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { merge } = w.land({ 'docs/a.md': 'two' }, { at: '2026-11-04T09:00:00Z' });
  w.hooks.push([/\/check-runs/, 500]);
  await weekOf(w);
  const s = week(w);
  assert.deepEqual(s.stuck, [merge]); assert.equal(s.ok, false);
});

test('PLANT a commit with two verdicts → flagged (m4)', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-04T09:00:00Z' });
  await weekOf(w);
  const l = w.judged()[0];
  writeFileSync(join(w.dir, 'log.jsonl'), `${readFileSync(join(w.dir, 'log.jsonl'), 'utf8')}${JSON.stringify(l)}\n`);
  const s = week(w);
  assert.equal(s.duplicates.length, 1); assert.equal(s.ok, false);
});

test('PLANT a damaged log line → the week does not count (P8)', async () => {
  const w = world(); await w.pass(PIN_AT);
  await weekOf(w);
  writeFileSync(join(w.dir, 'log.jsonl'), `${readFileSync(join(w.dir, 'log.jsonl'), 'utf8')}{not json\n`);
  const s = week(w);
  assert.equal(s.corrupt, 1); assert.equal(s.ok, false);
});

test('days are UTC, by merged_at, not by when the commit was judged', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-02T23:59:00Z' });   // merged before the window's first day, judged on it
  await weekOf(w);
  assert.equal(week(w).judged, 0, 'a merge from before the window is not in it');
});

// disagreements and explanations
async function weekWithSourceChange() {
  const w = world(); await w.pass(PIN_AT);
  const { merge } = w.land({ 'src/a.mjs': 'two' }, { at: '2026-11-04T09:00:00Z' });
  await weekOf(w);
  return { w, merge };
}

test('a disagreement with MAIN needs an explanation from the owner\'s own file', async () => {
  const { w, merge } = await weekWithSourceChange();
  assert.equal(week(w).unexplained.length, 1);
  const file = ownFile({ [merge]: 'a source change the draft rules should have let through; the draft is being fixed' });
  const s = week(w, { file });
  assert.equal(s.unexplained.length, 0, JSON.stringify(s.reasons)); assert.equal(s.ok, true); assert.equal(s.explanationsOwner, UID);
});

test('PLANT a whitespace-only explanation does not count (P17)', async () => {
  const { w, merge } = await weekWithSourceChange();
  assert.equal(week(w, { file: ownFile({ [merge]: '   ' }) }).unexplained.length, 1);
});

test('PLANT an explanations file owned by another user does not count, with a plain reason (m8)', async () => {
  const { w, merge } = await weekWithSourceChange();
  const file = ownFile({ [merge]: 'fine' });
  const ex = readExplanations(file, { ownerUid: UID + 1 });
  assert.equal(ex.ok, false); assert.match(ex.problem, /owned by user/);
  const s = summary({ dir: w.dir, endDay: '2026-11-09', explanations: ex });
  assert.equal(s.ok, false); assert.ok(s.reasons.some((r) => /explanations do not count/.test(r)));
});

test('PLANT an explanations file others can write, or in a folder others can write, does not count (m8)', async () => {
  const f1 = ownFile({ a: 'b' }); chmodSync(f1, 0o666);
  assert.match(readExplanations(f1, { ownerUid: UID }).problem, /written by others/);
  const f2 = ownFile({ a: 'b' }); chmodSync(dirname(f2), 0o777);
  assert.match(readExplanations(f2, { ownerUid: UID }).problem, /folder/);
});

test('PLANT a damaged explanations file → "does not count" with a reason, not a crash (m9)', async () => {
  const folder = tempDir('m6-watch-owner-'); chmodSync(folder, 0o755);
  const file = join(folder, 'explanations.json'); writeFileSync(file, '{oops'); chmodSync(file, 0o644);
  const ex = readExplanations(file, { ownerUid: UID });
  assert.equal(ex.ok, false); assert.match(ex.problem, /could not be read/);
});

test('PLANT an explanations file that is a link is not followed (O_NOFOLLOW)', async () => {
  const folder = tempDir('m6-watch-owner-'); chmodSync(folder, 0o755);
  const real = ownFile({ a: 'b' }); const link = join(folder, 'explanations.json'); symlinkSync(real, link);
  assert.equal(readExplanations(link, { ownerUid: UID }).ok, false);
});

test('explain writes an explanation the summary then accepts; refuses a folder others can write', () => {
  const folder = tempDir('m6-watch-owner-'); chmodSync(folder, 0o755);
  const file = join(folder, 'explanations.json');
  explain({ file, sha: 'a'.repeat(40), text: ' reason one ', uid: UID });
  explain({ file, sha: 'b'.repeat(40), text: 'reason two', uid: UID });
  const ex = readExplanations(file, { ownerUid: UID });
  assert.deepEqual(ex.explanations, { ['a'.repeat(40)]: 'reason one', ['b'.repeat(40)]: 'reason two' });
  chmodSync(folder, 0o777);
  assert.throws(() => explain({ file, sha: 'c'.repeat(40), text: 'x', uid: UID }), /not only yours/);
  chmodSync(folder, 0o755);
  assert.throws(() => explain({ file, sha: 'c'.repeat(40), text: '  ', uid: UID }), /empty/);
});

// ───────────────────────────── the client and the files

test('the client cannot write: only /repos reads and the one threads query', async () => {
  const c = readOnlyClient({ token: () => 'a-token-that-is-long-enough', fetchFn: async () => { throw new Error('should not be called'); } });
  await assert.rejects(() => c.get('/user'), /only repository reads/);
  await assert.rejects(() => c.get('/repos/a/b/../../user'), /only repository reads/);
  await assert.rejects(() => c.post('/repos/a/b/merges', {}), /only write-shaped call/);
  await assert.rejects(() => c.post('/graphql', { query: 'mutation { x }' }), /only write-shaped call/);
});

test('every call a full pass makes is a GET or the one threads query', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); await w.pass();
  assert.ok(w.asked.every(([m, p]) => m === 'GET' || (m === 'POST' && p === '/graphql')));
  assert.ok(w.asked.some(([m]) => m === 'POST'));
});

test('PLANT the token file is a link, wrong mode or another user\'s → refused, never read (O_NOFOLLOW, m7)', () => {
  const dir = tempDir('m6-watch-'); const real = join(dir, 'real'); writeFileSync(real, 'x'.repeat(40), { mode: 0o600 });
  const link = join(dir, 'link'); symlinkSync(real, link);
  assert.throws(() => tokenFile(link)(), /could not be opened/);
  assert.equal(tokenFile(real)(), 'x'.repeat(40));
  chmodSync(real, 0o644); assert.throws(() => tokenFile(real)(), /not this user's own private file/);
  chmodSync(real, 0o600); assert.throws(() => tokenFile(real, { uid: UID + 1 })(), /not this user's own private file/);
});

test('PLANT the log is a link → appending refused, not followed (c4)', async () => {
  const w = world();
  const target = join(tempDir('m6-watch-'), 'elsewhere'); writeFileSync(target, '');
  symlinkSync(target, join(w.dir, 'log.jsonl'));
  await assert.rejects(() => w.pass(PIN_AT));
  assert.equal(readFileSync(target, 'utf8'), '');
});

test('a token never appears in a log line, an error or the output', async () => {
  const w = world();
  const secret = 'zz-made-up-test-value-0000000000';
  const out = []; const errs = [];
  const tf = join(tempDir('m6-watch-'), 'token'); writeFileSync(tf, secret, { mode: 0o600 });
  const fetchFn = async (url, init) => { assert.equal(init.headers.authorization, `Bearer ${secret}`); const r = await (async () => ({ status: 500, json: async () => null }))(); return r; };
  const code = await main(['once', '--repo', `${OWNER}/${REPO}`, '--dir', w.dir, '--token-file', tf, '--rules', 'github'], { out: (s) => out.push(s), err: (s) => errs.push(s), fetchFn });
  assert.equal(code, 1);
  assert.ok(![...out, ...errs, readFileSync(join(w.dir, 'log.jsonl'), 'utf8')].join('\n').includes(secret));
});

// ───────────────────────────── the command

test('arguments: strict, and a secret-looking stray argument is not echoed', () => {
  assert.throws(() => parseArgs(['once']), /--repo is required/);
  assert.throws(() => parseArgs(['once', 'zz-made-up-arg']), (e) => !String(e.message).includes('zz-made-up-arg'));
  assert.throws(() => parseArgs(['once', '--repo', 'a/b', '--dir', 'd', '--token-file', 't', '--rules', 'draft']), /--rules-sha256/);
  assert.throws(() => parseArgs(['once', '--repo', 'a/b', '--dir', 'd', '--token-file', 't', '--rules', 'github', '--rules-sha256', 'a'.repeat(64)]), /only for --rules draft/);
  assert.throws(() => parseArgs(['summary', '--dir', 'd', '--end-day', '2026-02-30', '--explanations', 'e', '--owner-uid', '1']), /real date/);
  assert.throws(() => parseArgs(['summary', '--dir', 'd', '--end-day', '2026-11-09', '--explanations', 'e', '--owner-uid', '1', '--days', '1']), /not one this command takes/);
  assert.throws(() => parseArgs(['once', '--repo', 'a/..', '--dir', 'd', '--token-file', 't', '--rules', 'github']), /owner\/name/);
  assert.equal(parseArgs(['summary', '--dir', 'd', '--end-day', '2026-11-09', '--explanations', 'e', '--owner-uid', '501']).ownerUid, '501');
});

test('summary is read only: a wrong folder is "no log", and no folder is made (c3)', async () => {
  const w = world(); const missing = join(w.dir, 'nope');
  const errs = [];
  const code = await main(['summary', '--dir', missing, '--end-day', '2026-11-09', '--explanations', join(w.dir, 'e.json'), '--owner-uid', String(UID)], { out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 1); assert.match(errs[0], /no log/); assert.equal(existsSync(missing), false);
});

test('summary prints that days are UTC, the explanations\' owner, and why the week does not count', async () => {
  const w = world(); await w.pass(PIN_AT);
  const out = [];
  const code = await main(['summary', '--dir', w.dir, '--end-day', '2026-11-09', '--explanations', join(w.dir, 'none.json'), '--owner-uid', String(UID)], { out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 1);
  const text = out.join('\n');
  assert.match(text, /UTC/); assert.match(text, /BECAUSE/); assert.match(text, /THE WEEK DOES NOT COUNT YET/);
});

// ───────────────────────────── the summary alone, on a hand-written log (each clause on its own)

function handLog({ extra = [], passFlags = {} } = {}) {
  const dir = tempDir('m6-watch-'); const pin = 'a'.repeat(40);
  const rows = [{ pin: true, at: PIN_AT, sha: pin }];
  for (const d of ['03', '04', '05', '06', '07', '08', '09']) rows.push({ pass: true, at: `2026-11-${d}T12:00:00Z`, head: pin, pin_sha: pin, pin_ok: true, problems: [], ...passFlags });
  rows.push({ pass: true, at: '2026-11-10T00:30:00Z', head: pin, pin_sha: pin, pin_ok: true, problems: [], ...passFlags }, ...extra);
  writeFileSync(join(dir, 'log.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return dir;
}

test('a clean hand-written week counts (the base the next two clauses break)', () => {
  assert.equal(summary({ dir: handLog(), endDay: '2026-11-09', explanations: NOEX }).ok, true);
});

test('PLANT a "not judged" line with no later judged line, on otherwise clean passes → does not count (M3)', () => {
  const dir = handLog({ extra: [{ sha: 'c'.repeat(40), at: '2026-11-04T09:00:00Z', not_judged_reason: 'HTTP 500: x' }] });
  const s = summary({ dir, endDay: '2026-11-09', explanations: NOEX });
  assert.equal(s.ok, false); assert.deepEqual(s.stuck, ['c'.repeat(40)]);
});

test('PLANT a pass that says the pin left main but lists no problem → not a clean pass', () => {
  const s = summary({ dir: handLog({ passFlags: { pin_ok: false } }), endDay: '2026-11-09', explanations: NOEX });
  assert.equal(s.ok, false);
});

test('PLANT refusal 8: a docs change the owner labelled needs-joe → refusal 8 (needs the owner\'s Approve) is listed, beside the lane refusal 9, which makes the verdict "would refuse" (caught by: approveNeeded in judgeMerged)', async () => {
  const w = await (async () => { const x = world(); await x.pass(PIN_AT); return x; })();
  const { number } = w.land({ 'docs/a.md': 'two' });
  w.labelsOf.set(number, [{ name: 'needs-joe' }]);
  await w.pass();
  const l = w.judged()[0];
  // The real lane rule also turns away anything that needs the owner (refusal 9, a hard one), so at the first cutover 8 never
  // stands alone and "would ask for the owner's Approve" cannot be reached with the real rules; the 8 line must still be there.
  assert.deepEqual(l.refusals.map((x) => x.n).sort(), [8, 9], JSON.stringify(l));
  assert.match(l.refusals.find((x) => x.n === 8).reason, /needs the owner's Approve: risky: unclassifiable/);
  assert.equal(l.verdict, VERDICTS[2]);
  assert.deepEqual(l.risky, ['unclassifiable']);
  // the same change without the label is a plain "would merge": the label is what moved it
  const v = world(); await v.pass(PIN_AT); v.land({ 'docs/a.md': 'two' }); await v.pass();
  assert.equal(v.judged()[0].verdict, VERDICTS[0]);
});
