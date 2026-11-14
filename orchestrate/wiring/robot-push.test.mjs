// robot-push.test.mjs — the robot job's push pass, wired (lane N, N1 part 2; L1115). Each part the pass needs refuses
// when missing (I1); with every part, one worker bundle becomes its card branch and one pull request, once; a push cut
// off after GitHub took it is finished by the next round, never pushed twice or forced; the pass's own limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, fstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { join } from 'node:path';
import { pushWorld, PRODUCT } from '../modules/M4-workshop/git/push-world.test-helper.mjs';
import { createPushScript } from '../modules/M4-workshop/git/push.mjs';
import { gitOk, initMirror, GIT_TIMEOUT_MS } from '../modules/M4-workshop/git/safe-git.mjs';
import { SCAN_BUDGET_MS, SCAN_TIMEOUT_MS } from '../modules/M4-workshop/git/gitleaks.mjs';
import { WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';
import { RETRY_MS } from './push-pass.mjs';
import { ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { memoryRecord } from '../shared/record.mjs';
import { BUILDER, keysPath, mirrorPath, outboxRootPath, privatePath } from '../setup/layout.mjs';
import { isRefusing, notWiredText } from './not-wired.mjs';
import { OWNER_FILE } from '../modules/M12-sensors/outside-watch.mjs';
import { GUARD_STEP } from './gate-ports.mjs';
import { OUTSIDE_KEYS, PUSH_DEADLINE_MS, PUSH_NOT_WIRED, PUSH_SCOPE, SCANNER_AT, baseOf, builderUid, outsideKeysProblem, pushWiring } from './robot-push.mjs';
import { PASS_LIMITS_MS, ROBOT_PASSES } from './robot-wiring.mjs';
import { PASS_DEADLINE_MS, RUN_DEADLINE_MS, passLimit, runPasses } from './robot-main.mjs';

const ME = process.getuid();
const BUILDER_UID = ME + 7;
const OWNER_UID = ME + 2;   // Joe's Mac user (hostLockUid); ownerUid (ME + 1) is the Record's owner, orchestrate (#536 r1 m3)   // tests can't chown: the bundle is made to look the builder's through testFstat
const OUTSIDE = Object.freeze({ outsideRepo: 'owner-x/outside', outsideWorkflow: '.github/workflows/outside-check.yml', outsideSlot: 'product 1', outsideTag: 'abcd1234' });
const GOOD_CI = 'on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
const AUDIT = { path: '.github/workflows/audit.yml', permissions: { contents: 'read' } };
const ENTRY = Object.freeze({ product: PRODUCT, owner: 'owner', repo: 'test-repo' });
const okToken = () => async () => ({ ok: true, token: 'fake-robot-token-for-tests' });
const okTokenFor = (asked = []) => (scope) => { asked.push(scope); return okToken(); };
const builder = () => ({ exists: true, uid: BUILDER_UID });
const thrown = (f) => { try { f(); } catch (e) { return e.message; } return null; };

/** A base laid out as setup's layout.mjs puts it, with only the folders the push reads. */
async function layoutBase() {
  const base = tempDir('orch-robot-push-');
  mkdirSync(keysPath({ base }), { mode: 0o700 });
  await initMirror(mirrorPath({ base }));
  mkdirSync(privatePath({ base }), { mode: 0o700 });
  mkdirSync(outboxRootPath({ base }));
  return base;
}
const cfg = (base, over = {}) => ({ product: PRODUCT, keyDir: keysPath({ base }), ownerUid: ME + 1, hostLockUid: OWNER_UID, ...OUTSIDE, ...over });
const fakeScanner = () => ({ bin: '/x/gitleaks', version: '8.30.1', config: '/x/gitleaks.toml', ignoreFile: '/x/gitleaksignore' });
const wiring = (base, { c = {}, ...over } = {}) => pushWiring(cfg(base, c), { rec: memoryRecord(), rules: { get: () => undefined }, entry: ENTRY, tokenFor: okTokenFor(), scannerAt: fakeScanner, userOf: builder, uid: ME, ...over });

test('L1115: each part the push needs refuses by name when missing, and the pass then fails as not wired (I1)', async () => {
  const base = await layoutBase();
  try {
    // Every part there: a pass, not a refusal.
    const pass = wiring(base);
    assert.equal(typeof pass, 'function');
    assert.equal(isRefusing(pass), false);
    const refusal = (over) => { const p = wiring(base, over); assert.ok(isRefusing(p), JSON.stringify(Object.keys(over))); return thrown(p); };
    assert.equal(refusal({ tokenFor: null }), notWiredText(PUSH_NOT_WIRED.app));
    assert.equal(refusal({ c: Object.fromEntries(OUTSIDE_KEYS.map((k) => [k, undefined])) }), notWiredText(PUSH_NOT_WIRED.outside));
    // The scanner port's default is null until lane 4's paths land (#525): no paths, no push.
    assert.equal(SCANNER_AT, null);
    assert.equal(refusal({ scannerAt: SCANNER_AT }), notWiredText(PUSH_NOT_WIRED.scanner));
    assert.match(refusal({ scannerAt: () => ({ ...fakeScanner(), version: '' }) }), /scanner's paths are incomplete/);
    assert.match(refusal({ scannerAt: () => { throw new Error('gone'); } }), /scanner's paths could not be read \(gone\)/);
    // The base is found from the key folder only where layout.mjs puts it.
    assert.match(refusal({ c: { keyDir: join(base, 'robot-keys') } }), /keyDir.*not where setup's layout puts it/);
    // The builder user, read on this Mac: missing, unreadable, root, the owner's, this job's own.
    assert.match(refusal({ userOf: () => ({ exists: false }) }), new RegExp(`the ${BUILDER} user is not on this Mac`));
    assert.match(refusal({ userOf: () => { throw new Error('dscl failed'); } }), /could not be read on this Mac \(dscl failed\)/);
    assert.match(refusal({ userOf: () => ({ exists: true, uid: 0 }) }), /never root's/);
    assert.match(refusal({ userOf: () => ({ exists: true, uid: OWNER_UID }) }), /is the owner's/);
    // #536 r1 m3: the owner is Joe's Mac user (hostLockUid), never the config's ownerUid (the Record's owner): with no
    // hostLockUid the pass refuses, and a builder that is Joe's user is refused though it differs from ownerUid.
    assert.equal(refusal({ c: { hostLockUid: undefined } }), notWiredText(PUSH_NOT_WIRED.owner));
    assert.match(refusal({ c: { hostLockUid: BUILDER_UID } }), /is the owner's/);
    assert.match(refusal({ userOf: () => ({ exists: true, uid: ME }) }), /this job's own/);
    // The products list must name where the product lives.
    assert.match(refusal({ entry: { product: PRODUCT } }), /names no owner and repo/);
    // The mirror: another user's, or open to others to write.
    assert.match(refusal({ uid: ME + 3 }), /mirror .* belongs to uid/);
    chmodSync(mirrorPath({ base }), 0o777);
    assert.match(refusal({}), /mirror .* can be written by others/);
    chmodSync(mirrorPath({ base }), 0o755);
    // The private folder: open to others.
    chmodSync(privatePath({ base }), 0o750);
    assert.match(refusal({}), /private folder/);
    chmodSync(privatePath({ base }), 0o700);
    assert.equal(isRefusing(wiring(base)), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('L1115: the outside check keys go together, and a bad one is named; the base round-trips through keysPath', () => {
  assert.equal(outsideKeysProblem({}), null);
  assert.equal(outsideKeysProblem({}, { none: 'none' }), 'none');
  assert.equal(outsideKeysProblem({ ...OUTSIDE }), null);
  for (const k of OUTSIDE_KEYS) {
    const { [k]: _, ...three } = OUTSIDE;
    assert.match(outsideKeysProblem(three), new RegExp(`all four or none: ${k} missing`));
  }
  assert.match(outsideKeysProblem({ ...OUTSIDE, outsideSlot: 'product 0' }), /outsideSlot/);
  assert.match(outsideKeysProblem({ ...OUTSIDE, outsideTag: 'short' }), /outsideTag/);
  assert.match(outsideKeysProblem({ ...OUTSIDE, outsideWorkflow: 'ci.yml' }), /outsideWorkflow/);
  assert.match(outsideKeysProblem({ ...OUTSIDE, outsideRepo: 'no-slash' }), /outsideRepo/);
  assert.equal(baseOf('/b/keys'), '/b');
  assert.equal(baseOf('/b/keys/'), '/b');
  assert.equal(baseOf('/b/other'), null);
  assert.equal(baseOf('keys'), null);
  assert.equal(baseOf(undefined), null);
  assert.deepEqual(builderUid({ userOf: builder, ownerUid: 1, selfUid: 2 }), { uid: BUILDER_UID });
});

test('L1115, #536 r1 m1: the push has a limit of its own, sized to one git stall, the scanner check and the whole scan\'s budget; every other pass keeps 120 s; push is last', () => {
  assert.equal(PUSH_DEADLINE_MS, GIT_TIMEOUT_MS + SCAN_TIMEOUT_MS + SCAN_BUDGET_MS + 60_000);
  assert.equal(PUSH_DEADLINE_MS, 780_000, '13 minutes, as the header says');
  assert.ok(PUSH_DEADLINE_MS > SCAN_TIMEOUT_MS + SCAN_BUDGET_MS, 'a scan that runs its full budget is not cut off');
  // #536 r1 m2: the stated lock risk is the real one: the round's limit and the watchdog's margin, about 23.6 minutes.
  assert.equal(Math.round((RUN_DEADLINE_MS + WATCHDOG_MARGIN_MS) / 6_000) / 10, 23.6);
  assert.deepEqual(PASS_LIMITS_MS, { push: PUSH_DEADLINE_MS });
  assert.equal(passLimit('push'), PUSH_DEADLINE_MS);
  for (const p of ROBOT_PASSES.filter((x) => x !== 'push')) assert.equal(passLimit(p), PASS_DEADLINE_MS, p);
  assert.equal(RUN_DEADLINE_MS, (ROBOT_PASSES.length - 1) * PASS_DEADLINE_MS + PUSH_DEADLINE_MS + 20_000);
  assert.equal(ROBOT_PASSES.at(-1), 'push');
});

test('L1115: runPasses gives each pass its own limit: a slow push is cut at its limit, not at the others\'', async () => {
  const rec = memoryRecord();
  const slow = (ms) => () => new Promise((ok) => setTimeout(() => ok({ done: ms }), ms));
  const passes = Object.fromEntries(ROBOT_PASSES.map((p) => [p, () => ({})]));
  // The push takes 150 ms: past the others' 50, inside its own 400.
  const a = await runPasses({ rec, passes: { ...passes, push: slow(150) }, now: () => Date.now(), passDeadlineMs: 50, passLimits: { push: 400 } });
  assert.equal(a.push.ok, true, a.push.error);
  // The same push with no limit of its own is cut at the 50 every other pass has (plant: a limit not taken per pass).
  const b = await runPasses({ rec, passes: { ...passes, push: slow(150) }, now: () => Date.now(), passDeadlineMs: 50, passLimits: {} });
  assert.equal(b.push.ok, false);
  assert.equal(b.push.timedOut, true);
  assert.match(b.push.error, /within 50 ms/);
  // A heartbeat that slow is still cut at 50: only the push has a limit of its own.
  const c = await runPasses({ rec, passes: { ...passes, heartbeat: slow(150) }, now: () => Date.now(), passDeadlineMs: 50, passLimits: { push: 400 } });
  assert.equal(c.heartbeat.timedOut, true);
});

// The whole push through the wiring: a world laid out as setup's layout (outboxes, private, mirror under one base), the
// outside check and GitHub's pull request API faked at fetch, and a local bare repo for GitHub's git.
async function wiredWorld({ hangPr = null } = {}) {
  const root = tempDir('orch-robot-push-w-');
  const w = await pushWorld({ root, ciText: GOOD_CI });
  // layout.mjs's names: the world's mirror moves to <base>/mirror; outboxes and private are already there.
  renameSync(w.mirror, mirrorPath({ base: root }));
  mkdirSync(keysPath({ base: root }), { mode: 0o700 });
  w.values['product_profile.audit_workflow'] = AUDIT;
  // A card session, as the Dispatcher records one: its role and launch time (push-pass.mjs reads both).
  const s = w.record.read('session', 'S-1');
  assert.equal(w.record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: s.rev, doc: { ...s.doc, role: 'worker', launched_at: new Date(Date.now() - 60_000).toISOString() } }).ok, true);
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    calls.push({ method: init.method ?? 'GET', path, auth: init.headers?.authorization ?? null });
    const json = (status, body) => ({ status, json: async () => body });
    if (path.includes(`/repos/${OUTSIDE.outsideRepo}/actions/workflows/`)) {
      return json(200, { workflow_runs: [{ id: 11, path: OUTSIDE.outsideWorkflow, event: 'schedule', head_branch: 'main', created_at: new Date(Date.now() - 5 * 60_000).toISOString(), status: 'completed' }] });
    }
    if (path.includes(`/repos/${OUTSIDE.outsideRepo}/actions/runs/11/jobs`)) return json(200, { jobs: [{ steps: [{ name: `${OUTSIDE.outsideSlot} / permissions`, conclusion: 'success' }, { name: GUARD_STEP, conclusion: 'success' }] }] });
    if (path.includes(`/repos/${OUTSIDE.outsideRepo}/contents/${OWNER_FILE}`)) return json(200, { content: Buffer.from(JSON.stringify({ tags: { [OUTSIDE.outsideSlot]: OUTSIDE.outsideTag } })).toString('base64') });
    if (path.startsWith('/repos/owner/test-repo/pulls?')) return json(200, []);
    if (path === '/repos/owner/test-repo/pulls' && init.method === 'POST') {
      if (hangPr) await hangPr.promise;
      return json(201, { number: 5, html_url: 'https://github.com/owner/test-repo/pull/5' });
    }
    return json(404, { message: `unexpected ${path}` });
  };
  // The builder's bundle: tests can't chown, so its handle is made to look the builder's (createPushScript testFstat).
  const asBuilder = (fd) => { const st = fstatSync(fd); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: BUILDER_UID }); };
  const pass = ({ later = 0 } = {}) => pushWiring({ product: PRODUCT, keyDir: keysPath({ base: root }), ownerUid: ME + 1, hostLockUid: OWNER_UID, ...OUTSIDE }, {
    rec: w.record, rules: w.ports.rules, entry: ENTRY, tokenFor: okTokenFor(), fetchFn, now: () => Date.now() + 10_000 + later, uid: ME,
    scannerAt: () => w.fake.setup, userOf: builder, testRemote: () => w.gh,
    makePush: (deps) => createPushScript({ ...deps, testFstat: asBuilder }),
  });
  return { ...w, root, calls, pass, posts: () => calls.filter((x) => x.method === 'POST') };
}

test('L1115: with every part, one bundle becomes its card branch and one pull request, once; a second round does nothing new', async () => {
  const w = await wiredWorld();
  try {
    await w.commit('the work', (dir) => writeFileSync(join(dir, 'app.txt'), 'changed\n'));
    await w.bundle();
    const p = w.pass();
    assert.equal(isRefusing(p), false);
    const r = await p();
    assert.deepEqual(r.refused, []);
    assert.deepEqual(r.waiting, []);
    assert.deepEqual(r.pushed, ['C-1']);
    const tip = (await gitOk(['rev-parse', 'refs/heads/card/c-1'], { gitDir: w.cg.gitDir })).trim();
    assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${tip}`));
    assert.doesNotMatch(await w.ghRefs(), new RegExp(`refs/heads/main ${tip}`), 'never main');
    // One pull request, asked with the round's token; the outside check read with no key.
    assert.equal(w.posts().length, 1);
    assert.equal(w.posts()[0].auth, 'Bearer fake-robot-token-for-tests');
    assert.ok(w.calls.filter((x) => x.path.includes(OUTSIDE.outsideRepo)).every((x) => x.auth === null), 'the outside check is read with no key');
    assert.equal(w.record.read('fact', 'push.C-1.a1')?.doc?.result, 'pushed');
    // Round two: the bundle is taken, nothing is pushed or asked again.
    const again = await w.pass()();
    assert.deepEqual(again.pushed, []);
    assert.equal(w.posts().length, 1);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('L1115: a shut start gate queues its own alert under the gate\'s key, and nothing is pushed', async () => {
  const w = await wiredWorld();
  try {
    w.values['product_profile.audit_workflow'] = undefined;   // the workflow rule can't pass: the gate is shut
    await w.commit('the work', (dir) => writeFileSync(join(dir, 'app.txt'), 'changed\n'));
    await w.bundle();
    const r = await w.pass()();
    assert.deepEqual(r.pushed, []);
    assert.equal(r.waiting.length, 1);
    assert.match(r.waiting[0][1], /start gate is shut/);
    assert.doesNotMatch(await w.ghRefs(), /card\/c-1/);
    const q = (w.record.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).map((e) => e.text);
    assert.ok(q.some((t) => t.startsWith(`Pushes to ${PRODUCT} are stopped: No card branch will be pushed`)), q.join(' | '));
    assert.ok(q.some((t) => /its push waits: the start gate is shut/.test(t)), q.join(' | '));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('L1115: a push cut off after GitHub took the branch is finished by the next round: the same tip, never pushed over', async () => {
  let release;
  const hangPr = { promise: new Promise((ok) => { release = ok; }) };
  const w = await wiredWorld({ hangPr });
  let first;
  try {
    await w.commit('the work', (dir) => writeFileSync(join(dir, 'app.txt'), 'changed\n'));
    await w.bundle();
    const tip = (await gitOk(['rev-parse', 'refs/heads/card/c-1'], { gitDir: w.cg.gitDir })).trim();
    // Round one stops right after GitHub took the branch (the pull request call never answers): its limit cuts it.
    const rec = w.record;
    first = w.pass();
    const passes = Object.fromEntries(ROBOT_PASSES.map((p) => [p, () => ({})]));
    let running;
    const r1 = await runPasses({ rec, passes: { ...passes, push: () => (running = first()) }, now: () => Date.now(), passDeadlineMs: 50, passLimits: { push: 4_000 } });
    // The round's push pass was cut at its own limit, failed, and told; the push call itself is still hanging.
    assert.equal(r1.push.timedOut, true);
    // Wait until GitHub has the branch while the pass hangs on the pull request (a cut-off round leaves it so).
    for (let i = 0; i < 200 && !(await w.ghRefs()).includes('card/c-1'); i += 1) await new Promise((ok) => setTimeout(ok, 50));
    assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${tip}`));
    assert.equal(rec.read('fact', 'push.C-1.a1'), null, 'no push fact: the round was cut before it');
    // Round two, a new process's wiring, RETRY_MS on (the cut round left its called-mark, #536 r2 Minor 5), with the
    // pull request API answering: it finds the branch there and finishes.
    hangPr.promise = Promise.resolve();
    // The sensors read the start gate's facts again in those RETRY_MS, as they do each round.
    const readAt = new Date(Date.now() + 10_000 + RETRY_MS).toISOString();
    for (const kind of ['vercel_skip', 'vercel_env']) assert.equal(w.writeFact(kind, { product: PRODUCT, vercel_project: 'prj_1', read_at: readAt, result: true }).ok, true);
    const r2 = await w.pass({ later: RETRY_MS })();
    assert.deepEqual(r2.pushed, ['C-1'], JSON.stringify(r2));
    assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${tip}`), 'the same tip: not pushed over');
    assert.equal(rec.read('fact', 'push.C-1.a1')?.doc?.tip, tip);
    // Let round one's hung call end, as a killed process's never would; its late answer adds no second branch tip.
    release();
    await running;
    assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${tip}`));
  } finally { release?.(); rmSync(w.root, { recursive: true, force: true }); }
});

test('L1115: a hold the queue refused fails the pass, so robot-main\'s own tell carries it (I5)', async () => {
  const w = await wiredWorld();
  try {
    await w.commit('the work', (dir) => writeFileSync(join(dir, 'app.txt'), 'changed\n'));
    await w.bundle();
    w.values['product_profile.audit_workflow'] = undefined;
    const p = pushWiring({ product: PRODUCT, keyDir: keysPath({ base: w.root }), ownerUid: ME + 1, hostLockUid: OWNER_UID, ...OUTSIDE }, {
      rec: w.record, rules: w.ports.rules, entry: ENTRY, tokenFor: okTokenFor(), now: () => Date.now() + 10_000, uid: ME, fetchFn: async () => ({ status: 500, json: async () => ({}) }),
      scannerAt: () => w.fake.setup, userOf: builder, testRemote: () => w.gh, hold: () => false,
      makePush: (deps) => createPushScript({ ...deps, testFstat: (fd) => Object.assign(Object.create(Object.getPrototypeOf(fstatSync(fd))), fstatSync(fd), { uid: BUILDER_UID }) }),
    });
    await assert.rejects(p(), (e) => /the push pass's alerts could not be queued: push-wait-C-1\.a1/.test(e.message) && /untold/.test(e.tell));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

// The ports pushWiring builds for push.mjs, caught as makePush is given them.
function caughtPorts(base, over = {}) {
  let deps = null;
  const p = wiring(base, { makePush: (d) => { deps = d; return async () => ({ ok: false, reason: 'not used' }); }, ...over });
  assert.equal(typeof p, 'function'); assert.equal(isRefusing(p), false);
  return deps;
}

test('#536 r1 m4: the push mints its own token, narrowed to the product\'s repository with contents and pull_requests only', async () => {
  const base = await layoutBase();
  try {
    const asked = [];
    caughtPorts(base, { tokenFor: okTokenFor(asked) });
    assert.deepEqual(asked, [PUSH_SCOPE(ENTRY.repo)]);
    assert.deepEqual(PUSH_SCOPE('test-repo'), { repositories: ['test-repo'], permissions: { contents: 'write', pull_requests: 'write' } });
    // A factory that gives no getter: refused as no App.
    assert.equal(thrown(wiring(base, { tokenFor: () => null })), notWiredText(PUSH_NOT_WIRED.app));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('#536 r1 P21: the push\'s token getter gives only a minted token; a refused mint throws its reason, never a stand-in', async () => {
  const base = await layoutBase();
  try {
    const good = caughtPorts(base);
    assert.equal(await good.getRobotToken(), 'fake-robot-token-for-tests');
    for (const answer of [{ ok: false, reason: 'GitHub refused the token request (401)' }, { ok: false, token: 'stale-token-text', reason: 'refused' }, { ok: true, token: '' }, null]) {
      const d = caughtPorts(base, { tokenFor: () => async () => answer });
      await assert.rejects(d.getRobotToken(), (e) => (answer?.reason ? e.message === answer.reason : /no robot token/.test(e.message)), JSON.stringify(answer));
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('#536 r1 P19: the start gate\'s alert throws only when the queue refused it (false); told or not due today is fine', async () => {
  const base = await layoutBase();
  try {
    for (const [answer, throws] of [[false, true], [null, false], [true, false]]) {
      const d = caughtPorts(base, { hold: () => answer });
      const up = d.issues.upsert({ key: 'gate-shut-x', title: 'the start gate is shut', body: 'why' });
      if (throws) await assert.rejects(up, /the start gate's alert gate-shut-x could not be queued/);
      else await up;
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('#536 r2 c2: the push script is given the owner\'s Mac user (hostLockUid) as its owner, and the builder as its worker', async () => {
  const base = await layoutBase();
  try {
    const d = caughtPorts(base);
    assert.equal(d.ownerUid, OWNER_UID);
    assert.notEqual(d.ownerUid, ME + 1, 'never the Record\'s owner (the config\'s ownerUid)');
    assert.deepEqual(d.uids, { worker: BUILDER_UID });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
