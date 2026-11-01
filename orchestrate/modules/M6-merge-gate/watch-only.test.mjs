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
import { DRAFT_FILE, NOT_JUDGED, VERDICTS, asksApprove, draftRules, githubRules, judgeMerged, readExplanations, readLog, readOnlyClient, summary, tokenFile, watchPass } from './watch-only.mjs';
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
      if (state.gqlErrors) return { status: 200, json: { errors: [{ message: 'x' }] } };
      const nodes = threadsOf.get(body.variables.pr) ?? [];
      return { status: 200, json: { data: { repository: { pullRequest: { reviewThreads: { totalCount: state.total ?? nodes.length, nodes } } } } } };
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
    threadsOf.set(number, thread ? [{ isResolved: false, comments: { nodes: [{ author: { __typename: thread === 'bot' ? 'Bot' : 'User' } }] } }] : []);
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

test('the walk goes back to the pin every pass; a commit already judged is skipped, never judged or gathered again', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); await w.pass('2026-11-03T12:00:00Z');
  const first = w.judged()[0].sha;
  w.land({ 'docs/a.md': 'three' });
  const before = w.asked.length;
  const r = await w.pass('2026-11-03T13:00:00Z');
  assert.equal(r.judged, 1);
  assert.deepEqual(w.asked.slice(before).filter(([, p]) => p.includes(first) && /pulls|check-runs|status/.test(p)), [], 'the judged commit is not gathered again');
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

test('days are UTC, by merged_at; a date past the end day is not in the week', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-02T23:59:00Z' });   // merged before the window's first day, judged on it
  await weekOf(w);
  assert.equal(week(w).judged, 1, 'found on the walk after the pin: counted, an early date clamped to the first day (M4)');
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
  assert.equal(ex.ok, false); assert.match(ex.problem, /does not count/);
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

test('judgeMerged sorts hard and soft refusals: where the lane rule says "ask" refusal 8 stands alone → "would ask"; with any hard refusal added → "would refuse"', async () => {
  const rs = await draftRulesFor();
  const askEngine = { classify: (c) => rs.engine.classify(c), get: (k, o) => rs.engine.get(k, o), may: () => ({ decision: 'ask', reason: 'a Tier 1 change needs the owner', tier: 1 }) };
  const head = 'b'.repeat(40);
  const facts = { direct: false, sha: 'a'.repeat(40), headSha: head, pr: 5, prBase: 'main', labels: [], statuses: [], threads: { ok: true, unresolved: 0 },
    checks: [{ name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' }], files: [{ path: 'docs/a.md', status: 'modified' }] };
  const v = judgeMerged(facts, { ...rs, engine: askEngine });
  assert.deepEqual(v.refusals.map((x) => x.n), [8], JSON.stringify(v));
  assert.equal(v.verdict, VERDICTS[1]);
  // a hard refusal beside it (an unresolved review thread) makes it a plain refusal
  const w = judgeMerged({ ...facts, threads: { ok: true, unresolved: 1 } }, { ...rs, engine: askEngine });
  assert.deepEqual(w.refusals.map((x) => x.n).sort(), [7, 8]);
  assert.equal(w.verdict, VERDICTS[2]);
});

test('the summary prints that a disagreement needed the owner\'s Approve when the verdict was "would refuse" (refusal 8 beside 9)', async () => {
  const sha = 'd'.repeat(40);
  const dir = handLog({ extra: [{ sha, at: '2026-11-04T09:00:00Z', merged_at: '2026-11-04T08:00:00Z', pr: 7, verdict: VERDICTS[2], refusals: [{ n: 9, reason: 'first cutover: docs lane only (x)' }, { n: 8, reason: 'needs the owner\'s Approve: risky: unclassifiable' }], not_judged: [...NOT_JUDGED] }] });
  const s = summary({ dir, endDay: '2026-11-09', explanations: NOEX });
  assert.equal(s.ok, false); assert.equal(s.unexplained.length, 1);
  const out = []; const { main } = await import('./watch-run.mjs');
  await main(['summary', '--dir', dir, '--end-day', '2026-11-09', '--explanations', join(dir, 'none.json'), '--owner-uid', String(UID)], { out: (x) => out.push(x), err: () => {} });
  const line = out.find((x) => x.startsWith('UNEXPLAINED'));
  assert.ok(line && /would refuse/.test(line) && /8: needs the owner's Approve/.test(line), JSON.stringify(out));
});

// ───────────────────────────── round 3: the auditor's probes, kept as tests
const flaky = (w, re, times = 1) => { let n = times; const orig = w.client.get; return (path) => { if (n > 0 && re.test(path)) { n--; return true; } return false; }; };

test('R3 audit probe A: a failed read on a commit that is not the newest is retried next pass', async () => {
  const w = world(); await w.pass(PIN_AT);
  const b = w.land({ 'docs/b.md': 'b' });
  w.land({ 'docs/c.md': 'c' });
  w.hooks.push([new RegExp(`/pulls/${b.number}$`), 500]);
  await w.pass('2026-11-03T12:00:00Z');
  w.hooks.length = 0;
  await w.pass('2026-11-03T13:00:00Z');
  const shas = w.judged().map((l) => l.sha);
  assert.ok(shas.includes(b.merge), `B was never retried: judged=${JSON.stringify(shas)}; lines=${JSON.stringify(w.lines().map(l=>l.not_judged_reason||l.verdict||(l.pass?'pass':'pin')))}`);
});

test('R3 audit probe B: a commit whose own read fails on the judging loop is never silently dropped', async () => {
  const w = world(); await w.pass(PIN_AT);
  const b = w.land({ 'docs/b.md': 'b' });
  w.land({ 'docs/c.md': 'c' });
  let seen = 0; const re = new RegExp(`/git/commits/${b.merge}$`);
  // fail the SECOND read of B's commit (the walk reads it first, the judging loop reads it again)
  w.hooks.push([{ test: (p) => re.test(p) && ++seen === 2 }, 502]);
  await w.pass('2026-11-03T12:00:00Z');
  w.hooks.length = 0;
  for (const d of ['04','05','06','07','08','09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-10T00:30:00Z');
  const s = week(w);
  const judged = w.judged().map((l) => l.sha);
  const stuck = s.stuck;
  assert.ok(judged.includes(b.merge) || stuck.includes(b.merge) || !s.ok, `B silently missing, week ok=${s.ok}, reasons=${JSON.stringify(s.reasons)}, seen=${seen}`);
});

test('R3 audit probe C: a direct push of an older commit (old committer date) is counted as a disagreement', async () => {
  const w = world(); await w.pass(PIN_AT);
  const sha = w.push({ 'docs/z.md': 'z' }, '2026-10-20T10:00:00Z');   // committed 2 weeks ago, pushed now
  await weekOf(w);
  const l = w.judged().find((x) => x.sha === sha);
  assert.ok(l, 'judged');
  assert.equal(l.verdict, VERDICTS[2]);
  const s = week(w);
  assert.equal(s.ok, false, `the week COUNTS with an unexplained direct push: ${JSON.stringify({ judged: s.judged, dis: s.disagreements, reasons: s.reasons, merged_at: l.merged_at })}`);
});

test('R3 audit probe D: a pin at 23:59 on day 1 does not make a 7-day week out of 6 days and a minute', async () => {
  const w = world();
  await w.pass('2026-11-03T23:59:00Z');
  for (const d of ['04','05','06','07','08','09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-10T00:30:00Z');
  const s = week(w);
  assert.equal(s.ok, false, `counts with window start ${s.windowStart}, days ${s.days.join(',')}`);
});

test('R3 audit probe E: the draft file swapped mid-week with no merges that day leaves that day without a clean pass', async () => {
  const w = world(); await w.pass(PIN_AT);
  writeFileSync(join(w.dir, DRAFT_FILE), POLICY + '\n# other\n');
  const r = await w.pass('2026-11-04T12:00:00Z');
  assert.ok(r.problems.length > 0, 'a pass with the wrong draft in place is clean');
});

test('R3 audit probe F: a commit with no committer date does not crash the pass', async () => {
  const w = world(); await w.pass(PIN_AT);
  const sha = w.push({ 'docs/z.md': 'z' }, 'not a date');
  let err = null; try { await w.pass(); } catch (e) { err = e; }
  assert.equal(err, null, String(err));
});

test('R3 audit probe G: an explanations file the summary user cannot reach is not reported as read from the owner', () => {
  const folder = tempDir('m6-watch-owner-'); const sub = join(folder, 'home'); mkdirSync(sub); const file = join(sub, 'explanations.json');
  writeFileSync(file, JSON.stringify({ ['a'.repeat(40)]: 'fine' })); chmodSync(sub, 0o000);
  const r = readExplanations(file, { ownerUid: UID }); chmodSync(sub, 0o755);
  assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.problem, /could not be reached/); assert.equal(r.owner, null);
});

test('R3 audit probe H: real pass + real summary output names refusal 8 next to 9 (no hand-written line)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const { number } = w.land({ 'docs/a.md': 'two' }); w.labelsOf.set(number, [{ name: 'needs-joe' }]);
  await weekOf(w);
  const out = [];
  await main(['summary', '--dir', w.dir, '--end-day', '2026-11-09', '--explanations', join(w.dir, 'none.json'), '--owner-uid', String(UID)], { out: (x) => out.push(x), err: () => {} });
  const line = out.find((x) => x.startsWith('UNEXPLAINED'));
  assert.ok(line && /would refuse/.test(line) && /8: needs the owner's Approve/.test(line), JSON.stringify(out));
});

test('R3 audit probe I: a merge commit (two parents) that brings main in: first-parent walk judges the merge, not the branch commits', async () => {
  const w = world(); await w.pass(PIN_AT);
  const before = w.g.main;
  const side = w.g.commit([before], { 'docs/side.md': 's' }, { from: before });
  const merge = w.g.commit([before, side], { 'docs/side.md': 's' }, { from: before });
  w.g.main = merge; w.dates.set(merge, '2026-11-03T10:00:00Z');
  const r = await w.pass();
  const shas = w.lines().filter((l) => l.sha && !l.pin).map((l) => l.sha);
  assert.ok(shas.includes(merge) && !shas.includes(side), JSON.stringify({ r, shas }));
});

test('R3 audit probe J: rules-source switched from draft to github mid-week restarts the week or makes the pass unclean', async () => {
  const w = world(); await w.pass(PIN_AT);
  const gr = githubRules({ gh: w.client, owner: OWNER, repo: REPO });
  const r = await w.pass('2026-11-04T12:00:00Z', gr);
  const pins = w.lines().filter((l) => l.pin);
  assert.ok(pins.length > 1 || r.problems.length > 0, `switching rules kind leaves a clean pass under the draft pin: ${JSON.stringify(w.lines().at(-1))}`);
});

test('R3 audit probe K: rate limit (403) on the pulls read → not judged, retried, reason starts with HTTP 403', async () => {
  const w = world(); await w.pass(PIN_AT);
  const b = w.land({ 'docs/b.md': 'b' });
  w.hooks.push([/\/commits\/[0-9a-f]{40}\/pulls/, 403]);
  const r = await w.pass();
  const nj = w.lines().find((l) => l.not_judged_reason);
  assert.ok(nj && /HTTP 403/.test(nj.not_judged_reason), JSON.stringify(nj));
  w.hooks.length = 0; await w.pass('2026-11-03T13:00:00Z');
  assert.ok(w.judged().some((l) => l.sha === b.merge));
});

// ───────────────────────────── round 3: the week's edges, one test per clause

test('R3 MAT-5 a pin at noon makes the first counted day the next day: 6 days is not a week, 7 is (X15)', async () => {
  const w = world(); await w.pass('2026-11-03T12:00:00Z');
  for (const d of ['04', '05', '06', '07', '08', '09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-10T00:30:00Z');
  const six = summary({ dir: w.dir, endDay: '2026-11-09', explanations: NOEX });
  assert.deepEqual(six.days, ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
  assert.equal(six.ok, false); assert.ok(six.reasons.some((r) => /needs 7/.test(r)), JSON.stringify(six.reasons));
  await w.pass('2026-11-10T12:00:00Z'); await w.pass('2026-11-11T00:30:00Z');
  const seven = summary({ dir: w.dir, endDay: '2026-11-10', explanations: NOEX });
  assert.equal(seven.days.length, 7); assert.equal(seven.ok, true, JSON.stringify(seven.reasons));
});

test('R3 MAT-5 a pin at exactly midnight counts its own day', async () => {
  const w = world(); await w.pass(PIN_AT);
  assert.equal(summary({ dir: w.dir, endDay: '2026-11-09', explanations: NOEX }).days[0], '2026-11-03');
});

test('R3 MAT-4 a direct push is counted on the day a pass first saw it, whatever old date its commit carries; seen_at is on the line', async () => {
  const w = world(); await w.pass(PIN_AT);
  const old = w.push({ 'docs/z.md': 'z' }, '2026-10-20T10:00:00Z');
  await weekOf(w);
  const l = w.judged().find((x) => x.sha === old);
  assert.ok(l.seen_at, 'it carries the time a pass saw it');
  const s = week(w);
  assert.equal(s.judged, 1, 'counted by when it was seen: an old date is not a way out of the week');
  assert.equal(s.disagreements, 1); assert.equal(s.ok, false);
});

test('R3 MAT-4 a direct push dated in the future is never silently dropped: it stays "not judged", so the week fails', async () => {
  const w = world(); await w.pass(PIN_AT);
  const future = w.push({ 'docs/y.md': 'y' }, '2027-01-01T00:00:00Z');
  await weekOf(w);
  const s = week(w);
  assert.deepEqual(s.stuck, [future]); assert.equal(s.ok, false);
});

test('R3 MAT-4 a pull request merged after the end day is not in the week; one found early is counted on the first day', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-12T10:00:00Z' });
  await weekOf(w);
  assert.equal(week(w).judged, 0);
});

test('R3 m-c a pass line judged on other rules is not a clean pass, and neither is a judged line on other rules', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-04T09:00:00Z' });
  await weekOf(w);
  assert.equal(week(w).ok, true);
  const text = readFileSync(join(w.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => { const o = JSON.parse(x); if (o.pass && o.at.startsWith('2026-11-05')) o.rules = 'f'.repeat(64); return JSON.stringify(o); }).join('\n');
  writeFileSync(join(w.dir, 'log.jsonl'), `${text}\n`);
  const s = week(w);
  assert.ok(s.missingDays.includes('2026-11-05'), JSON.stringify(s));
});

test('R3 X14 a bot\'s unresolved thread is not a person waiting; a person\'s is', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { thread: 'bot' });
  w.land({ 'docs/b.md': 'two' }, { thread: 'user' });
  await w.pass();
  const [bot, person] = w.judged();
  assert.equal(bot.verdict, VERDICTS[0], JSON.stringify(bot));
  assert.equal(person.verdict, VERDICTS[2]); assert.ok(person.refusals.some((r) => r.n === 7));
});

test('R3 m-b the draft swapped for other text makes the pass carry a problem even with nothing to judge', async () => {
  const w = world(); await w.pass(PIN_AT);
  writeFileSync(join(w.dir, DRAFT_FILE), `${POLICY}\n# other\n`);
  const r = await w.pass('2026-11-04T12:00:00Z');
  assert.ok(r.problems.some((p) => /not the pinned one/.test(p)), JSON.stringify(r.problems));
});

test('R3 m-a a commit with no readable date is "not judged" with a reason, never a crash or a guessed day', async () => {
  const w = world(); await w.pass(PIN_AT);
  const sha = w.push({ 'docs/z.md': 'z' }, 'not a date');
  const r = await w.pass();
  assert.ok(r.problems.some((p) => /no readable date/.test(p)), JSON.stringify(r.problems));
  assert.ok(w.lines().some((l) => l.sha === sha && l.not_judged_reason));
});

test('R3 MAT-3 a failed second read of a commit writes a "not judged" line with the reason (not only a pass problem)', async () => {
  const w = world(); await w.pass(PIN_AT);
  const b = w.land({ 'docs/b.md': 'b' });
  let seen = 0; const re = new RegExp(`/git/commits/${b.merge}$`);
  w.hooks.push([{ test: (p) => re.test(p) && ++seen === 2 }, 502]);
  await w.pass('2026-11-03T12:00:00Z');
  const nj = w.lines().find((l) => l.sha === b.merge && l.not_judged_reason);
  assert.ok(nj && /502/.test(nj.not_judged_reason), JSON.stringify(w.lines()));
  w.hooks.length = 0; await w.pass('2026-11-03T13:00:00Z');
  assert.ok(w.judged().some((l) => l.sha === b.merge), 'retried and judged');
});

test('R3 MAT-4 a backdated direct push first seen after the end day is not in the week', async () => {
  const w = world(); await w.pass(PIN_AT);
  await weekOf(w);
  w.push({ 'docs/z.md': 'z' }, '2026-11-05T10:00:00Z');
  await w.pass('2026-11-11T12:00:00Z');
  assert.equal(week(w).judged, 0);
});

test('R3 m-c a judged line carrying other rules than the pin is not counted', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }, { at: '2026-11-04T09:00:00Z' });
  await weekOf(w);
  const text = readFileSync(join(w.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => { const o = JSON.parse(x); if (o.sha && !o.pin && !o.pass) o.rules = 'e'.repeat(64); return JSON.stringify(o); }).join('\n');
  writeFileSync(join(w.dir, 'log.jsonl'), `${text}\n`);
  assert.equal(week(w).judged, 0);
});

test('R3 cosmetic: a failed read\'s reason starts with the HTTP status', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/b.md': 'b' });
  w.hooks.push([/\/check-runs/, 500]);
  await w.pass();
  assert.match(w.lines().find((l) => l.not_judged_reason).not_judged_reason, /^HTTP 500/);
});

// ───────────────────────────── round 3: m-e / m-d / m-f

test('R3 m-f only a stated Approve need is "would ask"; refusal 14 and "the Approve check could not run" are refusals', () => {
  assert.equal(asksApprove({ n: 8, reason: 'needs the owner\'s Approve: risky: x' }), true);
  assert.equal(asksApprove({ n: 8, reason: 'the rules ask for the owner\'s Approve: y' }), true);
  assert.equal(asksApprove({ n: 8, reason: 'the Approve check could not run' }), false);
  assert.equal(asksApprove({ n: 14, reason: 'app/x.ts is customer-visible; needs the owner\'s Approve until refusal 14 is built' }), false);
});

test('R3 X7 a new customer-visible file is "would refuse" with refusal 14 on the line', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'app/new.ts': 'x' }); await w.pass();
  const l = w.judged()[0];
  assert.ok(l.refusals.some((r) => r.n === 14), JSON.stringify(l.refusals));
  assert.equal(l.verdict, VERDICTS[2]);
});

test('R3 X4 a merge commit with two parents is judged once, as the merge; the branch commit is never walked', async () => {
  const w = world(); await w.pass(PIN_AT);
  const before = w.g.main;
  const side = w.g.commit([before], { 'src/side.mjs': 's' }, { from: before });
  const merge = w.g.commit([before, side], { 'docs/m.md': 'm' }, { from: before });
  w.g.main = merge; w.dates.set(merge, '2026-11-03T10:00:00Z'); w.dates.set(side, '2026-11-03T09:00:00Z');
  await w.pass();
  const shas = w.lines().filter((l) => l.sha && !l.pin).map((l) => l.sha);
  assert.deepEqual(shas, [merge]);
  assert.ok(!w.asked.some(([, p]) => p.includes(`/commits/${side}`)), 'the second parent is never read');
});

test('R3 X5 the rules are read at the FIRST parent of a merge, not the second', async () => {
  const w = world({ mode: 'github' }); await w.pass(PIN_AT);
  const before = w.g.main;                                           // no rules file here
  const side = w.g.commit([before], { 'orchestrate/policy.yaml': POLICY }, { from: before });   // rules only on the side
  const merge = w.g.commit([before, side], { 'docs/m.md': 'm' }, { from: before });
  w.g.main = merge; w.dates.set(merge, '2026-11-03T10:00:00Z');
  await w.pass();
  const nj = w.lines().find((l) => l.sha === merge);
  assert.ok(nj && /^HTTP 404/.test(nj.not_judged_reason ?? ''), JSON.stringify(nj));
});

test('R3 X11 when a commit has two listed pull requests, the one whose merge commit it is wins', async () => {
  const w = world(); await w.pass(PIN_AT);
  const a = w.land({ 'docs/a.md': 'two' });
  w.g.openPull({ number: 900, head: a.merge, files: { 'docs/a.md': 'two' } });          // an open pull request whose head is that commit
  const entries = [...w.g.pulls]; w.g.pulls.clear();
  for (const [k, v] of entries.sort((x, y) => (y[0] === 900 ? 1 : 0) - (x[0] === 900 ? 1 : 0))) w.g.pulls.set(k, v);
  assert.equal([...w.g.pulls.keys()][0], 900, 'the wrong one is listed first');
  await w.pass();
  const l = w.judged().find((x) => x.sha === a.merge);
  assert.equal(l.pr, a.number); assert.equal(l.direct, false);
});

test('R3 X24 rules: "no rules file" (404) and "could not be read" (500) say different things', async () => {
  const w = world({ mode: 'github' });
  const rules = w.rulesOf();
  const none = await rules.at(w.root);
  assert.match(none.reason, /there is no rules file/);
  w.hooks.push([/\/contents\//, 500]);
  const boom = await rules.at(w.root);
  assert.match(boom.reason, /could not be read/); assert.doesNotMatch(boom.reason, /there is no rules file/);
});

test('R3 m-d a second, different rules version must have landed AFTER the first (the replay guard `after` is passed)', async () => {
  const w = world({ mode: 'github' }); await w.pass(PIN_AT);
  const r1 = w.land({ 'orchestrate/policy.yaml': POLICY });
  const d1 = w.land({ 'docs/a.md': 'two' });
  const r2 = w.land({ 'orchestrate/policy.yaml': `${POLICY}\n# v2\n` });
  const d2 = w.land({ 'docs/b.md': 'three' });
  await w.pass();
  assert.ok(w.asked.some(([, p]) => p.includes(`/compare/${r1.merge}...${r2.merge}`)), 'the guard compared the last good commit with the new rules\' merge');
  const l = w.lines().find((x) => x.sha === d2.merge);
  assert.ok(l && l.verdict, JSON.stringify(w.lines().filter((x) => x.sha === d2.merge)));
  assert.ok(w.lines().some((x) => x.sha === d1.merge && x.verdict));
});

// ───────────────────────────── round 4 (audit r3 of #86)

const dayPasses = async (w) => { await w.pass(PIN_AT); for (const d of ['03', '04', '05', '06', '07', '08', '09']) await w.pass(`2026-11-${d}T12:00:00Z`); };

test('R4 MAT-A (probe R3P1) a direct push at 23:20 on the end day, held back at 23:50 and judged at 00:50, is still in the end day and the week does NOT silently count', async () => {
  const w = world(); await dayPasses(w);
  const sha = w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:20:00Z');
  await w.pass('2026-11-09T23:50:00Z');
  assert.ok(w.lines().some((l) => l.sha === sha && l.not_judged_reason), 'held back at 23:50');
  await w.pass('2026-11-10T00:50:00Z');
  const l = w.judged().find((x) => x.sha === sha);
  assert.equal(l.seen_at, '2026-11-09T23:50:00Z', 'seen_at is the FIRST pass that saw it, not the judging pass');
  const s = week(w);
  assert.equal(s.judged, 1); assert.equal(s.disagreements, 1); assert.equal(s.ok, false);
});

test('R4 MAT-A edge: after a clean pass at 00:30 that did not see it, a direct push first seen up to 2 hours past midnight counts in the end day; later does not', async () => {
  for (const [at, counts] of [['2026-11-10T01:59:00Z', 1], ['2026-11-10T02:00:00Z', 1], ['2026-11-10T02:01:00Z', 0]]) {
    const w = world(); await dayPasses(w);
    await w.pass('2026-11-10T00:30:00Z');
    w.push({ 'docs/z.md': 'z' }, '2026-11-10T00:35:00Z');
    await w.pass(at);
    assert.equal(summary({ dir: w.dir, endDay: '2026-11-09', explanations: NOEX }).judged, counts, at);
  }
});

test('R4 m-1 (N26) no explanations file → owner is null and the summary says no file was read', async () => {
  const w = world(); await w.pass(PIN_AT);
  const r = readExplanations(join(w.dir, 'none.json'), { ownerUid: UID });
  assert.equal(r.owner, null); assert.equal(r.ok, true);
  const out = [];
  await main(['summary', '--dir', w.dir, '--end-day', '2026-11-09', '--explanations', join(w.dir, 'none.json'), '--owner-uid', String(UID)], { out: (x) => out.push(x), err: () => {} });
  assert.match(out.join('\n'), /no file was read/);
  const f = ownFile({ ['a'.repeat(40)]: 'fine' });
  assert.equal(readExplanations(f, { ownerUid: UID }).owner, UID);
});

test('R4 m-2 (N20) a pull request with 100 or more review threads is a fact (refusal 7), not a read failure: it is judged, not stuck', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); w.state.total = 150;
  await w.pass('2026-11-03T12:00:00Z');
  const l = w.judged()[0];
  assert.ok(l, JSON.stringify(w.lines()));
  assert.equal(l.verdict, VERDICTS[2]); assert.ok(l.refusals.some((r) => r.n === 7));
  assert.ok(!w.lines().some((x) => x.not_judged_reason));
});

test('R4 m-2 (N21) a failed threads read says the HTTP status first and the words "the review threads" once', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); w.state.graphql = 502;
  await w.pass('2026-11-03T12:00:00Z');
  const nj = w.lines().find((l) => l.not_judged_reason);
  assert.match(nj.not_judged_reason, /^HTTP 502/);
  assert.equal((nj.not_judged_reason.match(/the review threads/g) ?? []).length, 1, nj.not_judged_reason);
});

test('R4 m-2 (N22) a "not judged" line carries the rules it was tried under', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' }); w.state.graphql = 502;
  await w.pass('2026-11-03T12:00:00Z');
  const nj = w.lines().find((l) => l.not_judged_reason);
  assert.equal(nj.rules, H(POLICY));
});

test('R4 m-2 (N24) a commit that was "not judged" and judged on a retry is not stuck, and the week still counts (clock runs forward)', async () => {
  const w = world(); await w.pass(PIN_AT);
  await w.pass('2026-11-03T12:00:00Z');
  const b = w.land({ 'docs/b.md': 'b' }, { at: '2026-11-04T09:00:00Z' });
  w.state.graphql = 502;
  await w.pass('2026-11-04T12:00:00Z');
  w.state.graphql = null;
  await w.pass('2026-11-04T13:00:00Z');
  for (const d of ['05', '06', '07', '08', '09']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-10T00:30:00Z');
  const s = week(w);
  assert.deepEqual(s.stuck, []); assert.ok(w.judged().some((l) => l.sha === b.merge));
  assert.equal(s.ok, true, JSON.stringify(s.reasons));
});

test('R4 m-5 the summary names the earliest end day that could count: day 7 after a midnight pin, day 8 after a mid-day pin', async () => {
  const w = world(); await w.pass(PIN_AT);
  assert.equal(summary({ dir: w.dir, endDay: '2026-11-09', explanations: NOEX }).earliestEndDay, '2026-11-09');
  const v = world(); await v.pass('2026-11-03T15:00:00Z');
  assert.equal(summary({ dir: v.dir, endDay: '2026-11-09', explanations: NOEX }).earliestEndDay, '2026-11-10');
  const out = [];
  await main(['summary', '--dir', v.dir, '--end-day', '2026-11-09', '--explanations', join(v.dir, 'none.json'), '--owner-uid', String(UID)], { out: (x) => out.push(x), err: () => {} });
  assert.match(out.join('\n'), /earliest end day that could count: 2026-11-10/);
  assert.match(out.join('\n'), /since the first pass after the latest rules restart/);
});

// ───────────────────────────── round 5 (audit r4 of #86: the end-day boundary)

const show = (s) => JSON.stringify({ ok: s.ok, judged: s.judged, dis: s.disagreements, stuck: s.stuck, reasons: s.reasons });

test('R5 MAT-B (R4P4) two failed passes after midnight: a 23:45 end-day push still counts', async () => {
  const w = world(); await dayPasses(w); await w.pass('2026-11-09T23:30:00Z');
  w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:45:00Z');
  w.hooks.push([new RegExp(`${BASE}/commits/main$`), 502]);
  await w.pass('2026-11-10T00:45:00Z'); await w.pass('2026-11-10T01:45:00Z');
  w.hooks.length = 0;
  await w.pass('2026-11-10T02:45:00Z');
  const s = week(w);
  assert.equal(s.disagreements, 1, show(s)); assert.equal(s.ok, false);
});

test('R5 MAT-B (R4P5) the Mac asleep 23:31 to 02:30: a 23:40 end-day push still counts', async () => {
  const w = world(); await dayPasses(w); await w.pass('2026-11-09T23:30:00Z');
  w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:40:00Z');
  await w.pass('2026-11-10T02:30:00Z');
  const s = week(w);
  assert.equal(s.disagreements, 1, show(s)); assert.equal(s.ok, false);
});

test('R5 MAT-B (R4P6) one missed pass plus a minute of drift: a 23:59:30 push, next pass at 02:00:30, still counts', async () => {
  const w = world(); await dayPasses(w); await w.pass('2026-11-09T23:59:00Z');
  w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:59:30Z');
  w.hooks.push([new RegExp(`${BASE}/commits/main$`), 502]);
  await w.pass('2026-11-10T00:59:30Z');
  w.hooks.length = 0;
  await w.pass('2026-11-10T02:00:30Z');
  const s = week(w);
  assert.equal(s.disagreements, 1, show(s)); assert.equal(s.ok, false);
});

test('R5 MAT-B (R4P7) a day with only an early pass: a push at 01:00 on the end day first seen the next day at 04:00 counts', async () => {
  const w = world(); await w.pass(PIN_AT);
  for (const d of ['03', '04', '05', '06', '07', '08']) await w.pass(`2026-11-${d}T12:00:00Z`);
  await w.pass('2026-11-09T00:30:00Z');
  w.push({ 'docs/z.md': 'z' }, '2026-11-09T01:00:00Z');
  await w.pass('2026-11-10T04:00:00Z');
  const s = week(w);
  assert.equal(s.disagreements, 1, show(s)); assert.equal(s.ok, false);
});

test('R5 m-B the first reason a commit was "not judged" is kept: a second, different reason after the allowance does not move first-seen', async () => {
  const w = world(); await dayPasses(w);
  const sha = w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:20:00Z');
  await w.pass('2026-11-09T23:50:00Z');                       // held back: under an hour old
  w.hooks.push([new RegExp(`${BASE}/commits/${sha}$`), 502]);
  await w.pass('2026-11-10T00:50:00Z');                       // a different reason; 00:50 is inside the 2h floor, so first-seen still matters for which pass is the edge
  w.hooks.length = 0;
  await w.pass('2026-11-10T01:50:00Z');
  const l = w.judged().find((x) => x.sha === sha);
  assert.equal(l.seen_at, '2026-11-09T23:50:00Z', JSON.stringify(w.lines().filter((x) => x.sha === sha)));
  assert.equal(week(w).disagreements, 1);
});

test('R5 Q12 a GraphQL error carried in a 200 reads with its pinned wording, not as an HTTP failure', async () => {
  const w = world(); await w.pass(PIN_AT);
  w.land({ 'docs/a.md': 'two' });
  w.state.gqlErrors = true;
  await w.pass('2026-11-03T12:00:00Z');
  const nj = w.lines().find((l) => l.not_judged_reason);
  assert.equal(nj.not_judged_reason, 'GitHub answered 200 but with an error: the review threads could not be read');
});

test('R5 cosmetics: a bad explanations file prints one "could not be used" line, with no "user none" and no doubled "does not count"', async () => {
  const w = world(); await w.pass(PIN_AT);
  const f = join(w.dir, 'e.json'); writeFileSync(f, '{ not json'); chmodSync(f, 0o644);
  const out = [];
  await main(['summary', '--dir', w.dir, '--end-day', '2026-11-09', '--explanations', f, '--owner-uid', String(UID)], { out: (x) => out.push(x), err: () => {} });
  const text = out.join('\n');
  assert.doesNotMatch(text, /user none/); assert.doesNotMatch(text, /does not count[^\n]*does not count/);
  assert.match(text, /explanations: the file could not be used/);
});

// ───────────────────────────── round 6 (audit r5 of #86: what is a clean pass)

const lastPassLine = (w) => w.lines().filter((l) => l.pass).at(-1);

test('R6 m-C (R5I) the edge is the first clean pass after midnight in LOG order: a clock stepped back cannot pull it earlier', async () => {
  const w = world(); await dayPasses(w); await w.pass('2026-11-09T23:30:00Z');
  const p = w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:45:00Z');
  w.hooks.push([new RegExp(`${BASE}/commits/main$`), 502]); await w.pass('2026-11-10T00:45:00Z'); await w.pass('2026-11-10T01:45:00Z'); w.hooks.length = 0;
  await w.pass('2026-11-10T03:00:00Z');                 // judges P, seen_at 03:00
  await w.pass('2026-11-10T00:50:00Z');                 // the clock stepped back; a clean pass, written later
  const s = week(w);
  assert.equal(w.judged().find((x) => x.sha === p).seen_at, '2026-11-10T03:00:00Z');
  assert.equal(s.disagreements, 1, show(s)); assert.equal(s.ok, false);
});

test('R6 m-D (R5S) a pass with ANY problem is not clean, so it cannot become the edge (head and pin fine, a walk read failed above the push)', async () => {
  const w = world(); await dayPasses(w); await w.pass('2026-11-09T23:30:00Z');
  const p = w.push({ 'docs/z.md': 'z' }, '2026-11-09T23:45:00Z');
  const q = w.push({ 'docs/q.md': 'q' }, '2026-11-09T23:50:00Z');
  w.hooks.push([new RegExp(`/git/commits/${q}$`), 502]);
  await w.pass('2026-11-10T00:45:00Z');
  const bad = lastPassLine(w);
  w.hooks.length = 0; w.hooks.push([new RegExp(`${BASE}/commits/main$`), 502]); await w.pass('2026-11-10T01:45:00Z');
  w.hooks.length = 0; await w.pass('2026-11-10T02:45:00Z');
  const s = week(w); const l = w.judged().find((x) => x.sha === p);
  assert.ok(bad.problems.length && bad.head && bad.pin_ok, 'the planted pass has a head, the pin and a problem');
  assert.equal(l.seen_at, '2026-11-10T02:45:00Z');
  assert.equal(s.disagreements, 2, show(s)); assert.equal(s.ok, false);
});

test('R6 cosmetic: a damaged explanations file says it is not valid JSON; an unreachable one is not told "so it does not count" twice', async () => {
  const folder = tempDir('m6-watch-owner-'); chmodSync(folder, 0o755);
  const f = join(folder, 'explanations.json'); writeFileSync(f, '{ not json'); chmodSync(f, 0o644);
  const r = readExplanations(f, { ownerUid: UID });
  assert.equal(r.ok, false); assert.match(r.problem, /not valid JSON/);
});
