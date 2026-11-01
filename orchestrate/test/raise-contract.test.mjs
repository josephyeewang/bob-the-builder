// raise-contract.test.mjs — lead call L139 item 4: the contract tests for the alert wrappers (M12/M13 `raise`, and
// since L143 M11's tellThen).
//
// A call through a wrapper passes as a class (status `wrapped: <file> <fn>` in alert-inventory.json) only when the
// wrapper's `contract_test` (this file) shows it never takes a lost alert as sent: the alert answering false, and the
// alert throwing. alert-inventory.test.mjs checks that the named test exists, imports the wrapper's file, runs
// fakeAlert({ answer: false }) and fakeAlert({ throws }), and is not a todo; since L143 it also runs the test three
// times: as it is (the wrapper must reach a fake that answered false and one that threw), then with fakeAlert's false
// turned into true, then with its throw turned into true (each must make the test fail).
//
// What these show (1 Nov 2026; the three that were todos under L139, found defects, are plain tests since lane 3's fix
// landed in #96):
//   - heartbeat `set`: a red fact is raised again every pass while it is red, so a lost raise is retried. Passes.
//   - M13 `raise` (alerts.mjs): a GitHub call that throws makes raise throw and saves nothing. A GitHub call that
//     answers false (or `open` with no issue number) makes raise answer false and saves nothing that stops the next
//     try. Passes since #96.
//   - prod-watcher `raise`: a throw stops the pass before the new baseline is saved; an answer of false keeps the old
//     baseline (and a deploy unseen), so the change is raised again next pass. Passes since #96.
//   - heartbeat account-changed: the new login is saved only when raise did not answer false. Passes since #96. Its
//     inventory entry stays open all the same: #96's audit found that a repeat switch counts 'suppressed' as told
//     (lane 3 follow-up).
//   - tellThen (M11): hands back the alert's answer as it is: false when lost, a throw as a throw. Passes (L143).
//   - safeAlert (M2, landed with #87): answers false when the alert answers false or throws, and counts both in
//     alerts_failed; it never throws, so a caller records an alert as given only on true. Passes (L143 rerun).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../shared/record.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { makeAlerts, fakeIssues } from '../modules/M13-ledger/alerts.mjs';
import { makeVercelReader } from '../modules/M12-sensors/vercel-reader.mjs';
import { watchOnce } from '../modules/M12-sensors/prod-watcher.mjs';
import { heartbeatOnce } from '../modules/M13-ledger/heartbeat.mjs';
import { tellThen } from '../modules/M11-dispatcher/alerts.mjs';
import { safeAlert } from '../modules/M2-approvals/research-ask.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';

// ---- M13 raise ----

const m13 = (over = {}) => { const gh = Object.assign(fakeIssues(), over); const rec = memoryRecord(); return { gh, a: makeAlerts({ rec, gh, owner: 'o' }) }; };
async function m13Throws(failing) {
  const down = m13({ open: failing() });
  await assert.rejects(down.a.raise({ key: 'k', title: 't', body: 'b' }), /github down/, 'open throws: raise throws');
  assert.equal(down.a.state('k'), null, 'and saves no alert state, so the next pass opens it');
  const later = m13();
  await later.a.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
  later.gh.comment = failing();
  await assert.rejects(later.a.raise({ key: 'k', title: 't', body: 'b', status: 's2' }), /github down/, 'comment throws: raise throws');
  assert.equal(later.a.state('k').status_text, 's1', 'and the change is not saved, so the next pass comments again');
}
test('M13 raise: a GitHub call that throws makes raise throw and saves nothing that stops the next try (L139)', () => m13Throws(() => fakeAlert({ throws: new Error('github down') })));
test('M13 raise never takes a lost GitHub call as sent: answering false, or throwing (L139 contract)', async () => {
  await m13Throws(() => fakeAlert({ throws: new Error('github down') }));
  const noIssue = m13({ open: fakeAlert({ answer: false }) });
  await noIssue.a.raise({ key: 'k', title: 't', body: 'b' }).catch(() => {});
  noIssue.gh.open = fakeIssues().open;
  const next = await noIssue.a.raise({ key: 'k', title: 't', body: 'b' }).catch((e) => e.message);
  assert.equal(next, 'opened', 'open gave no issue number: the next pass must open one, not suppress it');
  const lost = m13();
  await lost.a.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
  lost.gh.comment = fakeAlert({ answer: false });
  await lost.a.raise({ key: 'k', title: 't', body: 'b', status: 's2' }).catch(() => {});
  lost.gh.comment = fakeAlert();
  await lost.a.raise({ key: 'k', title: 't', body: 'b', status: 's2' });
  assert.equal(lost.gh.comment.calls.length, 1, 'the change notice whose comment answered false is sent on the next pass');
});

// ---- prod-watcher raise ----

function watcher(raise) {
  const s = { envs: [{ id: 'env_1', key: 'API_URL', target: ['production'], type: 'plain', updatedAt: 1 }] };
  const project = { commandForIgnoringBuildStep: 'x', buildCommand: null, framework: 'nextjs', nodeVersion: '22.x', link: { type: 'github', org: 'o', repo: 'r', productionBranch: 'main' } };
  const fetchJson = async (path) => {
    if (path.startsWith('/v6/deployments')) return { deployments: [] };
    if (/\/env\?/.test(path)) return { envs: s.envs };
    if (/\/domains\?/.test(path)) return { domains: [{ name: 'example.test' }] };
    return { ...project, targets: { production: { id: null } } };
  };
  const writer = makeFactWriter(memoryRecord());
  const alerts = { raise, clear: async () => 'none' };
  const pass = () => watchOnce({ vercel: makeVercelReader(fetchJson, { projectId: 'prj_test' }), rulesEntry: { stage: 'first' }, mainFirstParent: new Set(), evidence: new Set(), writer, alerts, product: 'p' });
  return { s, pass, change: () => { s.envs = [{ ...s.envs[0], updatedAt: s.envs[0].updatedAt + 1 }]; } };
}
const settingChanges = (raise) => raise.calls.filter(([a]) => a.key.includes('|setting-changed|')).length;
async function watcherThrows(raise) {
  const w = watcher(raise);
  await w.pass();
  w.change();
  await assert.rejects(w.pass(), /github down/, 'a raise that throws stops the pass');
  raise.reset();
  await w.pass().catch(() => {});
  assert.equal(settingChanges(raise), 1, 'the new baseline was not saved, so the next pass raises the change again');
}
const settingDown = () => fakeAlert({ throws: (a) => a.key.includes('|setting-changed|') && 'github down' });
test('prod-watcher raise: a raise that throws stops the pass before the new baseline is saved (L139)', () => watcherThrows(settingDown()));
test('prod-watcher raise never takes a lost raise as sent: answering false, or throwing (L139 contract)', async () => {
  await watcherThrows(fakeAlert({ throws: (a) => a.key.includes('|setting-changed|') && 'github down' }));
  const raise = fakeAlert({ answer: false });
  const w = watcher(raise);
  await w.pass();
  w.change();
  await w.pass();
  raise.reset();
  await w.pass();
  assert.equal(settingChanges(raise), 1, 'a setting change whose raise answered false is raised again on the next pass');
});

// ---- heartbeat set, and account-changed ----

function heart(raise) {
  let t = Date.parse('2026-11-03T12:00:00Z');
  const now = () => new Date(t);
  const rec = memoryRecord();
  const writer = makeFactWriter(rec, { actor: 'ledger', now });
  const world = { fd: false, login: 'account A' };
  const probes = {
    dispatcherLastGood: async () => new Date(t - 60e3).toISOString(),
    rulesReadable: async () => true,
    frontDoorReachable: async () => world.fd,
    account: async () => ({ signedIn: true, login: world.login }),
    usage: async () => null,
  };
  const alerts = { raise, clear: async () => 'none' };
  const pass = () => heartbeatOnce({ product: 'p', writer, gh: fakeIssues(), alerts, owner: 'o', probes, now });
  return { world, pass, tick: () => { t += 10 * 60e3; } };
}
const raisedFor = (raise, kind) => raise.calls.filter(([a]) => a.key.endsWith(`|heartbeat|${kind}`)).length;
test('heartbeat set never takes a lost raise as sent: a red fact is raised again next pass after false or a throw (L139 contract)', async () => {
  const lost = fakeAlert({ answer: false });
  const h = heart(lost);
  await h.pass();
  h.tick();
  await h.pass();
  assert.equal(raisedFor(lost, 'front-door'), 2, 'answered false: raised again on the next pass');
  const down = fakeAlert({ throws: (a) => a.key.endsWith('|heartbeat|front-door') && 'github down' });
  const d = heart(down);
  await assert.rejects(d.pass(), /github down/);
  d.tick();
  await d.pass().catch(() => {});
  assert.equal(raisedFor(down, 'front-door'), 2, 'threw: raised again on the next pass');
});
test('heartbeat account-changed never takes a lost raise as sent: answering false, or throwing (L139)', async () => {
  const down = fakeAlert({ throws: (a) => a.key.includes('account-changed') && 'github down' });
  const d = heart(down);
  await d.pass().catch(() => {});
  d.world.login = 'account B';
  await assert.rejects(d.pass(), /github down/);
  await d.pass().catch(() => {});
  assert.equal(raisedFor(down, 'account-changed-account B'), 2, 'threw: the new login was not saved, so it is raised again');
  const lost = fakeAlert({ answer: false });
  const h = heart(lost);
  await h.pass();
  h.world.login = 'account B';
  await h.pass();
  await h.pass();
  assert.equal(raisedFor(lost, 'account-changed-account B'), 2, 'answered false: the change is raised again on the next pass');
});

// ---- tellThen (M11) ----

test("tellThen hands back the alert's answer: false when it is lost, and a throw as a throw (L143 contract)", () => {
  const mark = { fact: 'hold-c', fields: { text: 't' }, kind: 'hold_alert' };
  const lost = fakeAlert({ answer: false });
  assert.equal(tellThen(lost, 't', mark), false, 'answered false: tellThen answers false');
  assert.deepEqual(lost.calls[0], ['t', { mark }], 'and hands the mark to the alert, which writes it only on delivery');
  assert.throws(() => tellThen(fakeAlert({ throws: new Error('down') }), 't', mark), /down/, 'threw: tellThen throws');
  assert.equal(tellThen(fakeAlert(), 't', mark), true, 'sent: true');
});

test('safeAlert answers false when the alert is lost, whether it answers false or throws, and counts both (L143 contract)', () => {
  const failed = { n: 0 };
  assert.equal(safeAlert({ alert: fakeAlert({ answer: false }) }, failed)({ type: 't' }), false, 'answered false: safeAlert answers false');
  assert.equal(failed.n, 1);
  assert.equal(safeAlert({ alert: fakeAlert({ throws: new Error('down') }) }, failed)({ type: 't' }), false, 'threw: safeAlert answers false, and does not throw');
  assert.equal(failed.n, 2, 'both counted in alerts_failed');
  assert.equal(safeAlert({ alert: fakeAlert() }, failed)({ type: 't' }), true, 'sent: true');
  assert.equal(failed.n, 2);
});
