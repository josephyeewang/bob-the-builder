// raise-contract.test.mjs — what the alert wrappers' callers rely on (lead calls L139 item 4, L143, L170).
//
// These are behaviour tests, not proofs. Until L170 the contracts at the top of this file ran through
// assertWrapperContract and a run-time proof, and a wrapper passing them was "passes" in alert-inventory.json. The r4
// audit beat that machinery eight ways, so L170 removed it: each wrapper is now ruled by the lead on its code
// (alert-inventory.json says where), or open. The tests below check the behaviour each ruling describes, and fail if
// the code stops doing it; they do not make any entry pass.
//
// Where each wrapper stands (L170, 1 Nov 2026):
//   - tellThen (M11): return alert(text, { mark }): the alert's own answer, and a throw passes. Ruled.
//   - M13 `raise` (alerts.mjs): a GitHub call that answers false (or `open` with no issue number) makes raise answer
//     false; one that throws makes raise throw; nothing is saved before the call succeeds. Ruled.
//   - prod-watcher `raise`: answers result !== false; a setting change whose raise answered false keeps its old
//     baseline and is raised again next pass; a throw stops the pass. Ruled (the r4 hand-check).
//   - heartbeat `set`: answers nothing; it raises a red fact again every pass, whatever raise answered. Open (lane 3).
//   - safeAlert (M2): answers false when the alert answers false or throws, but takes a promise as sent, so one that
//     rejects later counts as given. Open (lane 1).
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

// ---- the worlds ----

const m13 = (over = {}) => { const gh = Object.assign(fakeIssues(), over); const rec = memoryRecord(); return { gh, a: makeAlerts({ rec, gh, owner: 'o' }) }; };

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
  return { s, alerts, pass, change: () => { s.envs = [{ ...s.envs[0], updatedAt: s.envs[0].updatedAt + 1 }]; } };
}
const isSettingChange = (a) => a.key.includes('|setting-changed|');

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
  const gh = fakeIssues();   // one GitHub for every pass: since #98 the pinned issue is read back (isClosed) on the next pass
  const pass = () => heartbeatOnce({ product: 'p', writer, gh, alerts, owner: 'o', probes, now });
  return { world, alerts, pass, tick: () => { t += 10 * 60e3; } };
}

// ---- what the callers rely on ----

test('M13 raise: a GitHub call that throws makes raise throw and saves nothing that stops the next try (L139)', async () => {
  const down = m13({ open: fakeAlert({ throws: new Error('github down') }) });
  await assert.rejects(down.a.raise({ key: 'k', title: 't', body: 'b' }), /github down/, 'open throws: raise throws');
  assert.equal(down.a.state('k'), null, 'and saves no alert state, so the next pass opens it');
  const later = m13();
  await later.a.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
  later.gh.comment = fakeAlert({ throws: new Error('github down') });
  await assert.rejects(later.a.raise({ key: 'k', title: 't', body: 'b', status: 's2' }), /github down/, 'comment throws: raise throws');
  assert.equal(later.a.state('k').status_text, 's1', 'and the change is not saved, so the next pass comments again');
});
test('M13 raise: a GitHub call that answers false saves nothing that stops the next try (L139)', async () => {
  const noIssue = m13({ open: fakeAlert({ answer: false }) });
  assert.equal(await noIssue.a.raise({ key: 'k', title: 't', body: 'b' }), false);
  noIssue.gh.open = fakeIssues().open;
  assert.equal(await noIssue.a.raise({ key: 'k', title: 't', body: 'b' }), 'opened', 'open gave no issue number: the next pass opens one, not suppress it');
  const lost = m13();
  await lost.a.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
  lost.gh.comment = fakeAlert({ answer: false });
  assert.equal(await lost.a.raise({ key: 'k', title: 't', body: 'b', status: 's2' }), false);
  lost.gh.comment = fakeAlert();
  await lost.a.raise({ key: 'k', title: 't', body: 'b', status: 's2' });
  assert.equal(lost.gh.comment.calls.length, 1, 'the change notice whose comment answered false is sent on the next pass');
});

const settingChanges = (raise) => raise.calls.filter(([a]) => isSettingChange(a)).length;
test('prod-watcher raise: a raise that throws stops the pass before the new baseline is saved, and one answering false keeps it (L139)', async () => {
  const raise = fakeAlert({ throws: (a) => isSettingChange(a) && 'github down' });
  const w = watcher(raise);
  await w.pass();
  w.change();
  await assert.rejects(w.pass(), /github down/, 'a raise that throws stops the pass');
  raise.reset();
  await w.pass().catch(() => {});
  assert.equal(settingChanges(raise), 1, 'the new baseline was not saved, so the next pass raises the change again');
  const lost = fakeAlert({ answer: false });
  const v = watcher(lost);
  await v.pass();
  v.change();
  await v.pass();
  lost.reset();
  await v.pass();
  assert.equal(settingChanges(lost), 1, 'a setting change whose raise answered false is raised again on the next pass');
});

const raisedFor = (raise, kind) => raise.calls.filter(([a]) => a.key.endsWith(`|heartbeat|${kind}`)).length;
test('heartbeat set: a red fact is raised again next pass after false or a throw (L139)', async () => {
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
// Since #98 (L152) the key carries the switch number: `account-changed-<n>-<saved time>-<login>`.
const switchRaises = (raise, login) => raise.calls.filter(([x]) => new RegExp(`\\|heartbeat\\|account-changed-\\d+-.+-${login}$`).test(x.key)).length;
test('heartbeat account-changed: the new login is saved only when the raise was not lost (L139)', async () => {
  const down = fakeAlert({ throws: (a) => a.key.includes('account-changed') && 'github down' });
  const d = heart(down);
  await d.pass().catch(() => {});
  d.world.login = 'account B';
  await assert.rejects(d.pass(), /github down/);
  await d.pass().catch(() => {});
  assert.equal(switchRaises(down, 'account B'), 2, 'threw: the new login was not saved, so it is raised again');
  const lost = fakeAlert({ answer: false });
  const h = heart(lost);
  await h.pass();
  h.world.login = 'account B';
  await h.pass();
  await h.pass();
  assert.equal(switchRaises(lost, 'account B'), 2, 'answered false: the change is raised again on the next pass');
});

test('tellThen hands the mark to the alert, which writes it only on delivery (L143)', () => {
  const mark = { fact: 'hold-c', fields: { text: 't' }, kind: 'hold_alert' };
  const lost = fakeAlert({ answer: false });
  assert.equal(tellThen(lost, 't', mark), false);
  assert.deepEqual(lost.calls[0], ['t', { mark }]);
  const boom = new Error('down');
  assert.throws(() => tellThen(fakeAlert({ throws: boom }), 't', mark), (e) => e === boom, 'a throw passes out as that same throw');
  assert.equal(tellThen(fakeAlert({ answer: 7 }), 't', mark), 7, 'any other answer is handed back as it is');
});

test('safeAlert answers false when the alert is lost, whether it answers false or throws, and counts both (L143)', () => {
  const failed = { n: 0 };
  assert.equal(safeAlert({ alert: fakeAlert({ answer: false }) }, failed)({ type: 't' }), false, 'answered false: safeAlert answers false');
  assert.equal(failed.n, 1);
  assert.equal(safeAlert({ alert: fakeAlert({ throws: new Error('down') }) }, failed)({ type: 't' }), false, 'threw: safeAlert answers false, and does not throw');
  assert.equal(failed.n, 2, 'both counted in alerts_failed');
  assert.equal(safeAlert({ alert: fakeAlert() }, failed)({ type: 't' }), true, 'sent: true');
  assert.equal(failed.n, 2);
});
