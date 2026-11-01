// raise-contract.test.mjs — lead call L139 item 4: the contract tests for the M12/M13 `raise` wrappers.
//
// A call through a wrapper passes as a class (status `wrapped: <file> <fn>` in alert-inventory.json) only when the
// wrapper's `contract_test` (this file) shows it never takes a lost alert as sent: the alert answering false, and the
// alert throwing. alert-inventory.test.mjs checks that the named test exists, imports the wrapper's file, runs
// fakeAlert({ answer: false }) and fakeAlert({ throws }), and is not a todo.
//
// What these show (1 Nov 2026, reported to the lead under L139: a todo here is a found defect, not a missing test):
//   - heartbeat `set`: a red fact is raised again every pass while it is red, so a lost raise is retried. Passes.
//   - M13 `raise` (alerts.mjs): a GitHub call that throws makes raise throw and saves nothing. Passes. A GitHub call
//     that ANSWERS false (or no issue number) is taken as sent: `comment` false loses the change notice for good, and
//     `open` with no number stores an open alert with no issue, which every later pass reads as closed by the owner.
//     Todo, failing.
//   - prod-watcher `raise`: a throw stops the pass before the new baseline is saved. Passes. An answer of false is put
//     in `out` and the baseline is saved anyway, so a lost setting-change alert is never raised again. It is safe only
//     while M13 raise never answers false. Todo, failing.
//   - heartbeat account-changed: the same: the new login is saved after a raise whose answer is not looked at. Todo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../shared/record.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { makeAlerts, fakeIssues } from '../modules/M13-ledger/alerts.mjs';
import { makeVercelReader } from '../modules/M12-sensors/vercel-reader.mjs';
import { watchOnce } from '../modules/M12-sensors/prod-watcher.mjs';
import { heartbeatOnce } from '../modules/M13-ledger/heartbeat.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';

const DEFECT = 'L139: a found defect, reported to the lead; this goes green when the code is fixed';

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
test('M13 raise never takes a lost GitHub call as sent: answering false, or throwing (L139 contract)', { todo: DEFECT }, async () => {
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
test('prod-watcher raise never takes a lost raise as sent: answering false, or throwing (L139 contract)', { todo: DEFECT }, async () => {
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
test('heartbeat account-changed never takes a lost raise as sent: answering false, or throwing (L139)', { todo: DEFECT }, async () => {
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
