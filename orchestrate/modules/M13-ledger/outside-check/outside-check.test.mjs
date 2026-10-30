import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runOne, STALE_MIN, inDocsLane } from './outside-check.mjs';
import { collect } from './collect.mjs';
import { notify, BOT } from './notify.mjs';
import { keepAlive } from './keep-alive.mjs';
import { workflowYaml, CHECKS, SLOTS } from './workflow.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60e3).toISOString();
const sha = (c) => c.repeat(40);
const REPO = 'someone/secret-product-name';
const AUDIT = 'pnpm audit:run --file scripts/a.mjs';
const AUDIT_SHA = createHash('sha256').update(AUDIT).digest('hex');

// A fake GitHub for one product repo. main: a→b→c (c newest), plus a merged branch commit f as c's second parent.
function fakeGh(over = {}) {
  const s = {
    heartbeat: [{ user: { login: 'robot' }, body: `Mini alive\nmini_alive_at: ${iso(10)}\n` }],
    commits: [
      { sha: sha('c'), parents: [{ sha: sha('b') }, { sha: sha('f') }], commit: { committer: { date: iso(60) } } },
      { sha: sha('f'), parents: [{ sha: sha('a') }], commit: { committer: { date: iso(90) } } },
      { sha: sha('b'), parents: [{ sha: sha('a') }], commit: { committer: { date: iso(120) } } },
      { sha: sha('a'), parents: [], commit: { committer: { date: iso(60 * 72) } } },
    ],
    runs: { [sha('c')]: 'success', [sha('b')]: 'success' },
    files: { 'scripts/a.mjs': AUDIT },
    deployments: [{ id: 2, environment: 'Production – app', sha: sha('c'), created_at: iso(50) }, { id: 1, environment: 'Preview', sha: sha('f'), created_at: iso(40) }],
    statuses: { 2: 'success', 1: 'success' },
    perms: 'read',
    // GitHub's own push times for main (the activity list): b pushed 120 min ago, c merged 60 min ago.
    // c was merged by the robot (docs only); b was pushed by a person.
    activity: [{ activity_type: 'pr_merge', before: sha('b'), after: sha('c'), timestamp: iso(60), actor: { login: 'Robot' } }, { activity_type: 'push', before: sha('a'), after: sha('b'), timestamp: iso(120), actor: { login: 'person' } }, { activity_type: 'branch_creation', after: sha('f'), timestamp: iso(100), actor: { login: 'person' } }],
    compare: { [`${sha('b')}...${sha('c')}`]: [{ filename: 'docs/notes.md' }, { filename: 'README.md' }] },
    ...over,
  };
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    const u = new URL(`https://x${path}`);
    if (!u.pathname.startsWith(`/repos/${REPO}/`) && u.pathname !== `/repos/${REPO}`) throw Object.assign(new Error('x'), { status: 404 });
    const rest = u.pathname.slice(`/repos/${REPO}`.length);
    if (rest === '/issues') return s.heartbeat;
    if (rest === '/activity') return s.activity;
    if (rest === '') return { default_branch: s.branch ?? 'main' };
    const cmp = /^\/compare\/(.+)$/.exec(rest);
    if (cmp) {
      // GitHub sends the whole file list (at most 300) on the compare's first page.
      const f = s.compare[cmp[1]]; if (f === undefined) return { message: 'Not Found' };
      return { files: f.slice(0, 300) };
    }
    if (rest === '/commits') return u.searchParams.get('page') === '1' ? s.commits : [];
    if (rest.startsWith('/actions/workflows/')) { const c = s.runs[u.searchParams.get('head_sha')]; return { workflow_runs: c ? [{ status: 'completed', conclusion: c }] : [] }; }
    if (rest.startsWith('/contents/')) { const f = s.files[decodeURIComponent(rest.slice(10))]; if (f === undefined) throw Object.assign(new Error('x'), { status: 404 }); return { content: Buffer.from(f).toString('base64') }; }
    if (rest === '/deployments') {
      if (!Array.isArray(s.deployments)) return s.deployments;
      const per = Number(u.searchParams.get('per_page') ?? 30), page = Number(u.searchParams.get('page') ?? 1);
      return s.deployments.slice((page - 1) * per, page * per);
    }
    const st = /^\/deployments\/(\d+)\/statuses$/.exec(rest); if (st) return [{ state: s.statuses[st[1]] }];
    if (rest === '/actions/permissions/workflow') return { default_workflow_permissions: s.perms };
    if (s.status) throw Object.assign(new Error('x'), { status: s.status });
    throw Object.assign(new Error(`unexpected ${rest}`), { status: 500 });
  };
  return { s, api, calls };
}
const TAG = 'slottag01';
const product = (o = {}) => ({ repo: REPO, stage: 'second', audit_workflow: 'audit.yml', robot: 'robot', tag: TAG, ...o });
const pinned = { 'product 1': { 'scripts/a.mjs': AUDIT_SHA } };
const docsLane = { 'product 1': ['docs/', 'README.md'] };
const owner = { tags: { 'product 1': TAG }, cleared: {} };
const run = (check, gh, p = product(), o = {}) => runOne(check, 1, { products: [p], api: gh.api, pinned, docsLane, acked: {}, owner, now: () => NOW, ...o });

test('a healthy product passes every check', async () => {
  for (const c of CHECKS) assert.equal((await run(c, fakeGh())).ok, true, c);
});

test('heartbeat: older than 70 min → FAIL; another account\'s issue is ignored; none → missing', async () => {
  const stale = fakeGh({ heartbeat: [{ user: { login: 'robot' }, body: `mini_alive_at: ${iso(STALE_MIN + 1)}` }, { user: { login: 'stranger' }, body: `mini_alive_at: ${iso(1)}` }] });
  const r = await run('heartbeat', stale);
  assert.equal(r.ok, false); assert.match(r.line, /heartbeat-stale 71min/);
  assert.match((await run('heartbeat', fakeGh({ heartbeat: [] }))).line, /FAIL heartbeat-missing/);
});

test('audit-files: a changed or deleted pinned file → FAIL; an empty pinned list FAILs, never passes', async () => {
  assert.match((await run('audit-files', fakeGh({ files: { 'scripts/a.mjs': `${AUDIT} --skip` } }))).line, /FAIL audit-files-changed 1/);
  assert.match((await run('audit-files', fakeGh({ files: {} }))).line, /FAIL audit-files-changed 1/);
  const r = await runOne('audit-files', 1, { products: [product()], api: fakeGh().api, pinned: {}, now: () => NOW });
  assert.match(r.line, /FAIL no-pinned-audit-files/);
});

test('audit-run: a main first-parent commit with no finished audit run → FAIL; stage first → not applicable', async () => {
  assert.match((await run('audit-run', fakeGh({ runs: { [sha('c')]: 'success' } }))).line, /FAIL main-update-without-audit 1/);
  assert.match((await run('audit-run', fakeGh({ runs: { [sha('c')]: 'failure', [sha('b')]: 'success' } }))).line, /FAIL/);
  const first = await run('audit-run', fakeGh({ runs: {} }), product({ stage: 'first' }));
  assert.equal(first.ok, true); assert.match(first.line, /not-applicable/);
  assert.equal((await run('audit-run', fakeGh({ runs: {} }), product({ stage: 'first', post_merge_audit: true }))).ok, false);
  assert.equal((await run('audit-run', fakeGh({ runs: {} }), product({ stage: undefined }))).ok, false, 'missing stage = strict');
  // the merged branch commit f is not a main update and needs no run of its own
  const gh = fakeGh(); await run('audit-run', gh);
  assert.equal(gh.calls.some((c) => c.includes(`head_sha=${sha('f')}`)), false);
});

test('0b-7 audit M-6: the window is GitHub\'s push time, not the commit\'s own date; a future-dated commit FAILs', async () => {
  // c carries a committer date 72 h back, but GitHub says it reached main 60 min ago: it is still due.
  const backdated = fakeGh({ runs: { [sha('b')]: 'success' } });
  backdated.s.commits[0].commit.committer.date = iso(60 * 72);
  assert.match((await run('audit-run', backdated)).line, /FAIL main-update-without-audit 1/);
  const future = fakeGh();
  future.s.commits[2].commit.committer.date = iso(-60 * 24);
  assert.match((await run('audit-run', future)).line, /FAIL commit-dated-in-future 1/);
  assert.match((await run('audit-run', fakeGh({ activity: { message: 'x' } }))).line, /FAIL activity-unreadable/);
});

test('0b-7 audit M-5: a missing, empty or malformed product list FAILs every slot, never "slot-empty"', async () => {
  for (const products of [[], undefined, null, {}, { repo: REPO }]) {
    const r = await runOne('heartbeat', 1, { products, api: fakeGh().api, pinned, now: () => NOW });
    assert.equal(r.ok, false, JSON.stringify(products)); assert.match(r.line, /FAIL products-missing/);
  }
  const bad = await runOne('heartbeat', 2, { products: [product(), 'oops'], api: fakeGh().api, pinned, now: () => NOW });
  assert.match(bad.line, /FAIL product-entry-malformed/);
  const empty = await runOne('heartbeat', 3, { products: [product()], api: fakeGh().api, pinned, now: () => NOW });
  assert.equal(empty.ok, true); assert.equal(empty.empty, true, 'a later empty slot is fine when the list has products');
});

test('deploys: live production on a non-main commit, or a main commit without audit evidence (stage second) → FAIL', async () => {
  const offMain = fakeGh({ deployments: [{ id: 3, environment: 'Production', sha: sha('f'), created_at: iso(5) }], statuses: { 3: 'success' } });
  assert.match((await run('deploys', offMain)).line, /FAIL unsupported-production-deploy/);
  assert.equal((await run('deploys', offMain, product({ stage: 'first' }))).ok, false, 'f is not first-parent main');
  const noEvidence = fakeGh({ runs: { [sha('b')]: 'success' } });
  assert.equal((await run('deploys', noEvidence)).ok, false);
  assert.equal((await run('deploys', noEvidence, product({ stage: 'first' }))).ok, true);
  const failedNewest = fakeGh({ deployments: [{ id: 3, environment: 'Production', sha: sha('f'), created_at: iso(5) }, { id: 2, environment: 'Production', sha: sha('c'), created_at: iso(50) }], statuses: { 3: 'failure', 2: 'success' } });
  assert.equal((await run('deploys', failedNewest)).ok, true, 'a failed deploy is not live; the newest success is judged');
});

test('permissions: default Actions token permission "write" → FAIL', async () => {
  assert.match((await run('permissions', fakeGh({ perms: 'write' }))).line, /FAIL default-permissions-not-read/);
});

test('public logs carry no product data: no repo, no commit, no path, no error text', async () => {
  const lines = [];
  for (const c of CHECKS) {
    lines.push((await run(c, fakeGh())).line);
    lines.push((await run(c, fakeGh({ heartbeat: [], files: {}, runs: {}, perms: 'write', deployments: [{ id: 9, environment: 'Production', sha: sha('f'), created_at: iso(1) }], statuses: { 9: 'success' } }))).line);
  }
  const broken = { products: [{ ...product(), repo: 'other/elsewhere' }], api: fakeGh().api, pinned, docsLane, owner, now: () => NOW };
  for (const c of CHECKS) lines.push((await runOne(c, 1, broken)).line);
  const all = lines.join('\n');
  for (const bad of ['secret-product-name', 'someone', 'elsewhere', 'scripts/', sha('c').slice(0, 7), sha('f').slice(0, 7), 'unexpected']) assert.equal(all.includes(bad), false, bad);
  for (const l of lines) assert.match(l, /^product 1 \/ [a-z-]+: (ok|FAIL)( [a-z0-9 -]+)?$/);
  assert.match(lines.at(-1), /check-error 404/);
});

test('an empty slot passes and is not reported; an unknown check fails', async () => {
  const r = await runOne('heartbeat', 2, { products: [product()], api: fakeGh().api, pinned, now: () => NOW });
  assert.equal(r.ok, true); assert.equal(r.empty, true);
  assert.equal((await runOne('nope', 1, { products: [product()], api: fakeGh().api, pinned })).ok, false);
});

test('collect: step lines → ran / failed lists', () => {
  assert.deepEqual(collect('product 1 / heartbeat: FAIL heartbeat-stale 95min\nproduct 1 / deploys: ok supported\nnoise\n'), { ran: 'product 1 / heartbeat,product 1 / deploys', failed: 'product 1 / heartbeat' });
  assert.deepEqual(collect(''), { ran: '', failed: '' });
});

function fakeRepoIssues() {
  const issues = []; const calls = [];
  const api = async (method, path, body) => {
    calls.push([method, path]);
    if (method === 'GET' && path.startsWith('/issues?')) return issues.map((i) => ({ ...i }));
    const cm = /^\/issues\/(\d+)\/comments/.exec(path);
    if (cm && method === 'GET') return issues[cm[1] - 1].comments;
    if (cm && method === 'POST') { issues[cm[1] - 1].comments.push({ user: { login: BOT }, body: body.body }); return {}; }
    if (method === 'POST' && path === '/issues') { issues.push({ number: issues.length + 1, title: body.title, body: body.body, state: 'open', comments: [] }); return {}; }
    const pm = /^\/issues\/(\d+)$/.exec(path);
    if (pm && method === 'PATCH') { Object.assign(issues[pm[1] - 1], body); return {}; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { issues, calls, api };
}

test('notify: Wi-Fi off for 3 hours → one "heartbeat stale" issue, updated hourly, not re-opened; cleared on return', async () => {
  const gh = fakeRepoIssues();
  const t = 'product 1 / heartbeat';
  for (let h = 0; h < 3; h++) await notify({ ran: [t], failed: [t], api: gh.api, now: () => new Date(NOW + h * 3600e3) });
  assert.equal(gh.issues.length, 1);
  assert.equal(gh.calls.filter(([m, p]) => m === 'PATCH' && p === '/issues/1').length, 2);
  assert.match(gh.issues[0].body, /failing since 2026-11-03T12:00:00.000Z\nlast seen 2026-11-03T14:00:00.000Z/);
  assert.deepEqual(await notify({ ran: [t], failed: [], api: gh.api }), [[t, 'cleared']]);
  assert.equal(gh.issues[0].state, 'closed');
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'opened']]);
  assert.equal(gh.issues.length, 2);
});

test('notify: an issue the owner closed mid-failure stays closed until the check passes and fails again', async () => {
  const gh = fakeRepoIssues();
  const t = 'product 1 / deploys';
  await notify({ ran: [t], failed: [t], api: gh.api });
  gh.issues[0].state = 'closed';
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'suppressed']]);
  assert.deepEqual(await notify({ ran: [t], failed: [], api: gh.api }), [[t, 're-armed']]);
  assert.deepEqual(await notify({ ran: [t], failed: [t], api: gh.api }), [[t, 'opened']]);
});

test('keep-alive commits only after 50 quiet days', async () => {
  const mk = (days) => { const puts = []; return { puts, api: async (m, p, b) => { if (m === 'PUT') { puts.push(b); return {}; } if (p === '') return { default_branch: 'main' }; if (p.startsWith('/commits')) return [{ commit: { committer: { date: new Date(NOW - days * 86400e3).toISOString() } } }]; throw new Error('404'); } }; };
  const young = mk(49); assert.equal((await keepAlive({ api: young.api, now: () => NOW })).committed, false);
  const old = mk(51); assert.equal((await keepAlive({ api: old.api, now: () => NOW })).committed, true);
  assert.equal(old.puts.length, 1);
});

test('workflow: committed file equals the generator; schedule only; least permissions; no product data', () => {
  const y = readFileSync(new URL('./.github/workflows/outside-check.yml', import.meta.url), 'utf8');
  assert.equal(y, workflowYaml());
  const on = /^on:\n((?: {2}.*\n)+)/m.exec(y)[1];
  assert.deepEqual(on.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim()), ['schedule:']);
  for (const bad of ['workflow_dispatch', 'pull_request', 'push:', 'issues:\n', 'issue_comment', 'uses:', 'pull_request_target']) assert.equal(y.includes(bad), false, bad);
  assert.match(y, /^permissions: \{\}$/m);
  const jobs = Object.fromEntries(y.split(/^ {2}(?=[a-z-]+:\n {4}(?:needs|runs-on))/m).slice(1).map((b) => [b.split(':')[0], b]));
  assert.deepEqual(Object.keys(jobs), ['check', 'notify', 'keep-alive']);
  assert.match(jobs.check, / {4}permissions: \{\}/);
  assert.match(jobs.notify, / {4}permissions:\n {6}issues: write\n {4}env/);
  assert.match(jobs['keep-alive'], / {4}permissions:\n {6}contents: write\n {4}env/);
  for (const j of ['notify', 'keep-alive']) assert.equal(jobs[j].includes('secrets.'), false, `${j} holds no secrets`);
  const steps = [...y.matchAll(/- name: (product \d+ \/ [a-z-]+)\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/g)].map((m) => m[1]);
  assert.equal(steps.length, SLOTS * CHECKS.length);
  assert.equal(new Set(steps).size, steps.length);
  assert.equal(/[A-Za-z0-9-]+\/[A-Za-z0-9-]+(?=\.git|")/.test(y.replace(/\$GITHUB_REPOSITORY/g, '')), false, 'no repo named in the file');
});

test('supported.mjs in the template is byte-identical to Bob\'s M12 copy (one definition)', () => {
  assert.equal(readFileSync(new URL('./supported.mjs', import.meta.url), 'utf8'), readFileSync(new URL('../../M12-sensors/supported.mjs', import.meta.url), 'utf8'));
});

test('the template ships an empty pinned list (filled per product by the owner)', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('./pinned-audit-files.json', import.meta.url), 'utf8')), {});
});

test('round 2 M-3a: the live production deploy is found behind 150 newer previews; none found or an unreadable list → FAIL', async () => {
  const previews = Array.from({ length: 150 }, (_, i) => ({ id: 100 + i, environment: 'Preview', sha: sha('f'), created_at: iso(1) }));
  const hidden = fakeGh({ deployments: [...previews, { id: 3, environment: 'Production', sha: sha('f'), created_at: iso(5) }], statuses: { 3: 'success' } });
  assert.match((await run('deploys', hidden)).line, /FAIL unsupported-production-deploy/, 'old code read 50 and said ok');
  const none = fakeGh({ deployments: previews });
  assert.match((await run('deploys', none)).line, /FAIL no-live-production-deployment/);
  assert.match((await run('deploys', none, product({ no_production: true }))).line, /ok no-production-by-entry/);
  assert.match((await run('deploys', fakeGh({ deployments: { message: 'x' } }))).line, /FAIL deployments-unreadable/);
});

test('round 2 M-3b: a main-update entry with no usable time or commit → FAIL, never "nothing due"', async () => {
  const noTime = fakeGh({ activity: [{ activity_type: 'push', after: sha('b') }] });
  assert.match((await run('audit-run', noTime)).line, /FAIL activity-entry-malformed 1/);
  const badAfter = fakeGh({ activity: [{ activity_type: 'pr_merge', after: 'zz', timestamp: iso(60) }] });
  assert.match((await run('audit-run', badAfter)).line, /FAIL activity-entry-malformed 1/);
  const otherKind = fakeGh({ activity: [{ activity_type: 'branch_creation', timestamp: 'nope' }] });
  assert.doesNotMatch((await run('audit-run', otherKind)).line, /malformed/, 'only main updates are judged');
});

test('round 2 minor: more products than slots → FAIL on every slot', async () => {
  const many = Array.from({ length: SLOTS + 1 }, () => product());
  const r = await runOne('heartbeat', 1, { products: many, api: fakeGh().api, pinned, now: () => NOW });
  assert.match(r.line, /FAIL products-over-slots/);
});

// ---- robot-merges (lead calls L19, L20; R-0b-72) ----
const OLD = (d) => new Date(NOW - d * 24 * 3600e3).toISOString();
const robotMerge = (files, o = {}) => fakeGh({
  activity: [{ activity_type: 'pr_merge', before: sha('b'), after: sha('c'), timestamp: iso(60), actor: { login: 'robot' }, ...o }],
  compare: { [`${sha('b')}...${sha('c')}`]: files },
});

test('robot-merges: docs-only robot merges pass; a person\'s change to src is not the robot\'s', async () => {
  const r = await run('robot-merges', fakeGh());
  assert.equal(r.ok, true); assert.match(r.line, /ok 1 robot updates/);
  const person = fakeGh({ activity: [{ activity_type: 'push', before: sha('b'), after: sha('c'), timestamp: iso(5), actor: { login: 'person' } }], compare: { [`${sha('b')}...${sha('c')}`]: [{ filename: 'src/app.ts' }] } });
  assert.equal((await run('robot-merges', person)).ok, true);
});

test('robot-merges planted: a robot merge touching src → FAIL; once its commit is acknowledged → ok', async () => {
  const gh = robotMerge([{ filename: 'docs/a.md' }, { filename: 'src/app.ts' }]);
  assert.match((await run('robot-merges', gh)).line, /FAIL robot-change-outside-docs-lane 1$/);
  assert.equal((await run('robot-merges', gh, product(), { acked: { 'product 1': [createHash('sha256').update(sha('c')).digest('hex')] } })).ok, true);
  assert.equal((await run('robot-merges', gh, product(), { acked: { 'product 2': [createHash('sha256').update(sha('c')).digest('hex')] } })).ok, false, 'another slot\'s acknowledgement does not count');
  assert.equal((await run('robot-merges', gh, product(), { acked: { 'product 1': [sha('c')] } })).ok, false, 'a raw commit id is not accepted (the file is public)');
});

test('robot-merges planted: a rename out of the docs lane, a lookalike prefix, an empty diff → FAIL', async () => {
  assert.equal((await run('robot-merges', robotMerge([{ filename: 'docs/x.md', previous_filename: 'src/x.ts' }]))).ok, false);
  assert.equal((await run('robot-merges', robotMerge([{ filename: 'docs-evil/x.md' }]))).ok, false);
  assert.equal((await run('robot-merges', robotMerge([{ filename: 'README.md.bak' }]))).ok, false);
  assert.equal((await run('robot-merges', robotMerge([]))).ok, false);
  assert.equal(inDocsLane('docs/a/b.md', ['docs/']), true);
  assert.equal(inDocsLane('', ['docs/']), false);
});

test('robot-merges planted: a robot force-push or an unknown update type → FAIL without reading a diff', async () => {
  for (const t of ['force_push', 'branch_deletion']) {
    const gh = robotMerge([{ filename: 'docs/a.md' }], { activity_type: t });
    assert.match((await run('robot-merges', gh)).line, /FAIL robot-change-outside-docs-lane 1/, t);
    assert.equal(gh.calls.some((c) => c.includes('/compare/')), false);
  }
});

test('robot-merges planted: no pinned docs lane, no robot, unreadable lists, a bad entry → FAIL', async () => {
  assert.match((await run('robot-merges', fakeGh(), product(), { docsLane: {} })).line, /FAIL no-pinned-docs-lane/);
  assert.match((await run('robot-merges', fakeGh(), product(), { docsLane: { 'product 1': [] } })).line, /FAIL no-pinned-docs-lane/);
  assert.match((await run('robot-merges', fakeGh(), product(), { docsLane: { 'product 1': ['docs/', 7] } })).line, /FAIL no-pinned-docs-lane/);
  assert.match((await run('robot-merges', fakeGh(), product({ robot: undefined }))).line, /FAIL no-robot-named/);
  assert.match((await run('robot-merges', fakeGh({ activity: { message: 'x' } }))).line, /FAIL activity-unreadable/);
  assert.match((await run('robot-merges', robotMerge([{ filename: 'docs/a.md' }], { timestamp: 'soon' }))).line, /FAIL activity-entry-malformed/);
  assert.match((await run('robot-merges', robotMerge([{ filename: 'docs/a.md' }], { before: undefined }))).line, /FAIL activity-entry-malformed/);
  assert.match((await run('robot-merges', robotMerge([{ filename: 'docs/a.md' }], { before: '0'.repeat(40) }))).line, /FAIL activity-entry-malformed/);
  assert.match((await run('robot-merges', fakeGh({ compare: {} }))).line, /FAIL compare-unreadable/);
});

test('robot-merges planted: a full activity page that doesn\'t reach back 7 days → FAIL; older robot merges are out of the window', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ activity_type: 'push', before: sha('a'), after: sha('b'), timestamp: iso(i + 1), actor: { login: 'person' } }));
  assert.match((await run('robot-merges', fakeGh({ activity: many }))).line, /FAIL activity-window-not-covered/);
  const old = robotMerge([{ filename: 'src/app.ts' }], { timestamp: OLD(8) });
  assert.match((await run('robot-merges', old)).line, /ok 0 robot updates/);
});

test('robot-merges planted: 300 or more changed files can\'t be fully listed → FAIL; 150 docs files → ok, read in one call', async () => {
  const docs = (n) => Array.from({ length: n }, (_, i) => ({ filename: `docs/${i}.md` }));
  assert.equal((await run('robot-merges', robotMerge(docs(150)))).ok, true);
  assert.equal((await run('robot-merges', robotMerge(docs(300)))).ok, false);
  assert.equal((await run('robot-merges', robotMerge([...docs(250), { filename: 'src/z.ts' }]))).ok, false, 'the 251st file is seen');
  const gh = robotMerge(docs(150)); await run('robot-merges', gh);
  assert.equal(gh.calls.filter((c) => c.includes('/compare/')).length, 1, 'no second page asked for (round 4 minor)');
});

// ---- 0b-7 audit round 4 ----
const ackOf = (c) => ({ 'product 1': [createHash('sha256').update(sha(c)).digest('hex')] });

test('0b-7 audit round 4 M-1: an acknowledged commit does not excuse a robot force-push (or unknown kind) landing on it', async () => {
  for (const t of ['force_push', 'branch_deletion', 'merge_queue_merge']) {
    const gh = robotMerge([{ filename: 'docs/a.md' }], { activity_type: t });
    assert.equal((await run('robot-merges', gh, product(), { acked: ackOf('c') })).ok, t === 'merge_queue_merge' ? true : false, t);
  }
  assert.equal((await run('robot-merges', robotMerge([{ filename: 'src/a.ts' }]), product(), { acked: ackOf('c') })).ok, true, 'an ordinary merge can still be acknowledged');
});

test('0b-7 audit round 4 M-2: a pinned slot left empty FAILs; a PRODUCTS entry whose tag differs from the pinned one FAILs', async () => {
  const empty = await runOne('robot-merges', 2, { products: [product()], api: fakeGh().api, pinned, docsLane: { ...docsLane, 'product 2': ['docs/'] }, acked: {}, owner, now: () => NOW });
  assert.match(empty.line, /^product 2 \/ robot-merges: FAIL pinned-slot-empty$/);
  const emptyTag = await runOne('robot-merges', 2, { products: [product()], api: fakeGh().api, pinned, docsLane, acked: {}, owner: { tags: { ...owner.tags, 'product 2': 'othertag9' } }, now: () => NOW });
  assert.equal(emptyTag.ok, false);
  const unpinned = await runOne('robot-merges', 2, { products: [product()], api: fakeGh().api, pinned, docsLane, acked: {}, owner, now: () => NOW });
  assert.match(unpinned.line, /ok slot-empty/, 'an unpinned empty slot still passes');
  assert.match((await run('robot-merges', fakeGh(), product({ tag: 'swapped01' }))).line, /FAIL slot-tag-mismatch$/);
  assert.match((await run('robot-merges', fakeGh(), product({ tag: undefined }))).line, /FAIL slot-tag-mismatch$/);
  assert.match((await run('robot-merges', fakeGh(), product(), { owner: { tags: {} } })).line, /FAIL no-pinned-slot-tag$/);
  assert.match((await run('robot-merges', fakeGh(), product(), { owner: { tags: { 'product 1': 'BAD TAG' } } })).line, /FAIL no-pinned-slot-tag$/);
});

test('0b-7 audit round 4 minors: an entry with no actor, a person\'s merge-queue merge, a default branch not main → FAIL', async () => {
  assert.match((await run('robot-merges', robotMerge([{ filename: 'docs/a.md' }], { actor: null }))).line, /FAIL activity-actor-missing$/);
  assert.match((await run('robot-merges', robotMerge([{ filename: 'src/a.ts' }], { activity_type: 'merge_queue_merge', actor: { login: 'github-merge-queue[bot]' } }))).line, /FAIL merge-queue-merge-unverified 1$/);
  assert.match((await run('robot-merges', fakeGh({ branch: 'trunk' }))).line, /FAIL default-branch-not-main$/);
});

test('the template ships an empty owner file for slot tags and clears', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('./robot-merges-owner.json', import.meta.url), 'utf8')), { tags: {}, cleared: {} });
});

test('the template ships empty docs-lane and acknowledged lists', () => {
  for (const f of ['./pinned-docs-lane.json', './acknowledged-merges.json']) assert.deepEqual(JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8')), {});
});

test('round 3 minor 2: a heartbeat time more than 10 min in the future → FAIL (a wrong clock, not fresh)', async () => {
  assert.match((await run('heartbeat', fakeGh({ heartbeat: [{ user: { login: 'robot' }, body: `mini_alive_at: ${iso(-240)}` }] }))).line, /FAIL heartbeat-in-future/);
  assert.match((await run('heartbeat', fakeGh({ heartbeat: [{ user: { login: 'robot' }, body: `mini_alive_at: ${iso(-2)}` }] }))).line, /ok 0min/);
});

test('0b-7 audit round 5 minor 1: audit-run FAILs when a full activity page does not reach back 48 h', async () => {
  const many = Array.from({ length: 100 }, () => ({ activity_type: 'branch_creation', after: sha('f'), timestamp: iso(5), actor: { login: 'person' } }));
  assert.match((await run('audit-run', fakeGh({ activity: many }))).line, /FAIL activity-window-not-covered$/);
});
