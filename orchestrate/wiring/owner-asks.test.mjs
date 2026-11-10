// Part C, runner step 2: the Dispatcher's async owner ports (owner-asks.mjs) against a fake runner that writes answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_GIVE_UP_MS, NO_COPY_KINDS, ownerAsyncPorts } from './owner-asks.mjs';
import { OWNER_PORTS } from './owner-ports.mjs';
import { RUNNER_KINDS } from './owner-status.mjs';

const OWNER = 501; const T0 = Date.parse('2026-11-09T12:00:00Z');
const FILE = '/runner/state/status.json'; const ROOT = '/out'; const COPIES = '/copies';
const st = ({ dir = false, mode = dir ? 0o755 : 0o644 } = {}) => ({ uid: OWNER, mode, nlink: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });
const session = (id, more = {}) => ({ id, product: 'p1', kind: 'editing', card: 'C-1', lead: 'L', role: 'worker', pgid: 77, signin: 's', config_dir: '/cfg', bundle_files: [],
  outbox: `${ROOT}/worker/${id}`, uid: OWNER, alive: true, ended: false, outbox_open: true, stop_requested: false, ...more });
const LAUNCHED = { ok: true, sessionId: 'S-1', pid: 4242, pidStart: 'Mon Nov  9 12:00:01 2026', pgid: 4242, head: 'a'.repeat(40), outbox: `${ROOT}/worker/S-1`, signin: 's', configDir: '/cfg', copy: `${COPIES}/C-1` };

// A fake runner: `script(n, w)` runs before the n-th status read and may change w.doc (the runner's next status).
function world(script = () => {}, { giveUpMs = ASK_GIVE_UP_MS } = {}) {
  const w = { now: T0, reads: 0, writes: [], doc: { sessions: [], requests: {}, answers: {} } };
  const open = () => { script(w.reads++, w); return { st: st(), text: typeof w.doc === 'string' ? w.doc : JSON.stringify({ written_at: new Date(w.now - 1000).toISOString(), ...w.doc }) }; };
  w.ports = ownerAsyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, clock: () => w.now, sleep: async (ms) => { w.now += ms; }, nonce: () => 'n1',
    giveUpMs, stat: () => st({ dir: true }), open, realpath: (p) => p, writeRequest: (n, t) => w.writes.push([n, JSON.parse(t)]) });
  return w;
}
const startedAt = (n) => (i, w) => { if (i === n) { w.doc = { sessions: [session('S-1')], requests: { 'S-1': { state: 'started' } }, answers: { 'launch-S-1': { ...LAUNCHED } } }; } };
const LAUNCH = { card: 'C-1', kind: 'editing', product: 'p1', sessionId: 'S-1' };

test('L759 step 2: launch writes one request and answers the runner\'s started session, LAUNCH fields only', async () => {
  const w = world(startedAt(3));
  const r = await w.ports.launch(LAUNCH);
  assert.deepEqual(r, LAUNCHED);
  assert.deepEqual(w.writes.map(([n]) => n), ['launch-S-1.json']);
  assert.deepEqual(w.writes[0][1].launch, LAUNCH);
  assert.equal(w.reads, 4, 'it waited, reading the status, until the answer was there');
  const extra = world((i, x) => { startedAt(0)(i, x); x.doc.answers['launch-S-1'] = { ...LAUNCHED, settings: { evil: 1 } }; });
  assert.deepEqual(Object.keys(await extra.ports.launch(LAUNCH)), Object.keys(LAUNCHED));
  for (const k of ['launch', 'stopGroup', 'saveWork', 'pauseLead']) assert.equal(OWNER_PORTS[k].sync, false, k);
});

test('L759 step 2: launch trusts no answer the rest of the status does not bear out; it waits, and its own limit answers timedOut', async () => {
  const wrong = [
    { requests: {} }, { requests: { 'S-1': { state: 'waiting' } } }, { requests: { 'S-1': { state: 'refused' } } },
    { answer: { sessionId: 'S-2' } }, { answer: { outbox: `${ROOT}/worker/S-2` } }, { answer: { copy: `${COPIES}/C-2` } }, { answer: { copy: '/elsewhere/C-1' } },
    { answer: { pid: 1 } }, { answer: { pgid: 0 } }, { answer: { pid: '4242' } }, { answer: { pidStart: '' } }, { answer: { pidStart: 7 } },
    { answer: { head: 'main' } }, { answer: { head: 'A'.repeat(40) } }, { answer: { signin: '' } }, { answer: { configDir: null } },
  ];
  for (const bad of wrong) {
    const w = world((i, x) => { startedAt(0)(i, x); if (bad.requests) x.doc.requests = bad.requests; Object.assign(x.doc.answers['launch-S-1'], bad.answer ?? {}); }, { giveUpMs: 10_000 });
    const r = await w.ports.launch(LAUNCH);
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.timedOut, true, JSON.stringify(bad));
    assert.match(r.reason, /did not answer launch-S-1 within 10000 ms \(an answer the rest of its status does not bear out\)/);
  }
  // A status that can't be read is waited through; then the answer counts.
  const flaky = world((i, x) => { if (i < 2) x.doc = '{'; else startedAt(2)(i, x); });
  const fr = await flaky.ports.launch(LAUNCH); assert.equal(fr.ok, true, fr.reason);
  const never = world(() => {}, { giveUpMs: 6_000 });
  const r = await never.ports.launch(LAUNCH);
  assert.deepEqual(r, { ok: false, timedOut: true, reason: 'the worker runner did not answer launch-S-1 within 6000 ms (no answer yet)' });
  assert.equal(never.reads, 4, 'reads at 0, 2, 4 and 6 s, then stops');
});

test('L759 step 2: a refused launch is told only when the request is marked refused; a bad launch throws before any request', async () => {
  const w = world((i, x) => { if (i === 1) x.doc = { sessions: [], requests: { 'S-1': { state: 'refused' } }, answers: { 'launch-S-1': { ok: false, reason: 'not walled: no such role' } } }; });
  assert.deepEqual(await w.ports.launch(LAUNCH), { ok: false, reason: 'not walled: no such role' });
  for (const [bad, why] of [[{ sessionId: '../x' }, /no session id/], [{ kind: 'review' }, /does not start "review"/], [{ kind: 'overnight' }, /does not start/], [{ card: '' }, /no card or product/], [{ product: '../p' }, /no card or product/], [{ product: 'p'.repeat(65) }, /no card or product/]]) {
    const x = world();
    await assert.rejects(x.ports.launch({ ...LAUNCH, ...bad }), why, JSON.stringify(bad));
    assert.deepEqual(x.writes, [], 'nothing was written');
  }
});

test('L759 step 2: stopGroup is ok only when the same status shows stop_requested and the group gone; a refusal is told', async () => {
  const stopped = (more) => (i, x) => { if (i === 0) x.doc = { sessions: [session('S-1', { alive: false, ended: true, stop_requested: true, ...more })], requests: { 'S-1': { state: 'stopped' } }, answers: { 'stopGroup-S-1-n1': { ok: true, how: 'SIGTERM' } } }; };
  const w = world(stopped());
  assert.deepEqual(await w.ports.stopGroup({ id: 'S-1', pgid: 77, kind: 'editing', signin: 's' }), { ok: true, how: 'SIGTERM' });
  assert.deepEqual(w.writes, [['stopGroup-S-1-n1.json', { stopGroup: { id: 'S-1', pgid: 77, kind: 'editing' }, asked_at: new Date(T0).toISOString() }]]);
  for (const more of [{ stop_requested: false }, { alive: true }]) {
    const x = world((i, y) => { stopped(more)(i, y); if (more.alive) y.doc.requests['S-1'].state = 'started'; }, { giveUpMs: 4_000 });
    const r = await x.ports.stopGroup({ id: 'S-1', pgid: 77, kind: 'editing' });
    assert.equal(r.timedOut, true, JSON.stringify(more));
  }
  const gone = world((i, y) => { stopped()(i, y); y.doc.sessions = []; y.doc.requests = {}; }, { giveUpMs: 4_000 });
  assert.equal((await gone.ports.stopGroup({ id: 'S-1', pgid: 77, kind: 'editing' })).timedOut, true, 'a session not listed is not shown stopped');
  const no = world((i, y) => { if (i === 0) y.doc.answers = { 'stopGroup-S-1-n1': { ok: false, reason: 'EPERM' } }; });
  assert.deepEqual(await no.ports.stopGroup({ id: 'S-1', pgid: 77, kind: 'editing' }), { ok: false, reason: 'EPERM' });
  for (const kind of ['review', 'lead', undefined]) {
    const x = world();
    assert.match((await x.ports.stopGroup({ id: 'S-1', pgid: 77, kind })).reason, /did not start/);
    assert.deepEqual(x.writes, []);
  }
});

test('L759 step 2: saveWork asks for the runner\'s kinds, answers the no-copy kinds itself, and tells every other kind', async () => {
  const w = world((i, x) => { if (i === 0) x.doc.answers = { 'saveWork-S-1-n1': { ok: true } }; });
  assert.deepEqual(await w.ports.saveWork({ id: 'S-1', kind: 'undo', card: 'C-1' }), { ok: true });
  assert.deepEqual(w.writes.map(([n, b]) => [n, b.saveWork]), [['saveWork-S-1-n1.json', { id: 'S-1', kind: 'undo', card: 'C-1' }]]);
  const no = world((i, x) => { if (i === 0) x.doc.answers = { 'saveWork-S-1-n1': { ok: false, reason: 'the copy is missing' } }; });
  assert.deepEqual(await no.ports.saveWork({ id: 'S-1', kind: 'editing' }), { ok: false, reason: 'the copy is missing' });
  assert.deepEqual([...NO_COPY_KINDS], ['review', 'audit', 'readonly', 'lead', 'front_door'], 'owner-ports.mjs saveWork names these, and only these');
  for (const kind of NO_COPY_KINDS) { const x = world(); assert.deepEqual(await x.ports.saveWork({ id: 'S-1', kind }), { ok: true }); assert.deepEqual(x.writes, []); }
  for (const [kind, why] of [['overnight', /no runner starts overnight sessions yet/], ['merge', /no runner saves "merge"/], ['undo_merge', /no runner saves/], [undefined, /no runner saves/]]) {
    const x = world(); assert.match((await x.ports.saveWork({ id: 'S-1', kind })).reason, why); assert.deepEqual(x.writes, []);
  }
  assert.equal(new Set([...NO_COPY_KINDS, ...RUNNER_KINDS]).size, NO_COPY_KINDS.length + RUNNER_KINDS.length, 'no kind is both');
  const slow = world(() => {}, { giveUpMs: 2_000 });
  assert.equal((await slow.ports.saveWork({ id: 'S-1', kind: 'script' })).timedOut, true);
});

test('L759 step 2: pauseLead resolves ok, throws on a refusal or at its limit, and each ask is a new request', async () => {
  let n = 0;
  const w = world((i, x) => { x.doc.answers = { 'pauseLead-p1-n1': { ok: true } }; });
  assert.deepEqual(await w.ports.pauseLead({ product: 'p1' }), { ok: true });
  assert.deepEqual(w.writes.map(([k, b]) => [k, b.pauseLead]), [['pauseLead-p1-n1.json', { product: 'p1' }]]);
  const no = world((i, x) => { x.doc.answers = { 'pauseLead-p1-n1': { ok: false, reason: 'the Lead is not running' } }; });
  await assert.rejects(no.ports.pauseLead({ product: 'p1' }), /the Lead is not running/);
  await assert.rejects(world(() => {}, { giveUpMs: 2_000 }).ports.pauseLead({ product: 'p1' }), /did not answer pauseLead-p1-n1 within 2000 ms/);
  for (const product of ['', '../x', 'a/b', undefined]) await assert.rejects(world().ports.pauseLead({ product }), /names no product/, String(product));
  // A fresh nonce per ask: an old answer is never read for a new pause.
  const twice = ownerAsyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, clock: () => T0, sleep: async () => {}, nonce: () => `n${++n}`, giveUpMs: 0,
    stat: () => st({ dir: true }), open: () => ({ st: st(), text: JSON.stringify({ written_at: new Date(T0).toISOString(), sessions: [], requests: {}, answers: { 'pauseLead-p1-n1': { ok: true } } }) }), realpath: (p) => p, writeRequest: () => {} });
  assert.deepEqual(await twice.pauseLead({ product: 'p1' }), { ok: true });
  await assert.rejects(twice.pauseLead({ product: 'p1' }), /pauseLead-p1-n2/, 'the second ask waits on its own answer, not the first one\'s');
});

test('L759 step 2: the status answers are checked whole; the ports need their writer and the copies folder', async () => {
  for (const answers of [[], null, { 'launch-S-1': { ok: 'yes' } }, { 'launch-S-1': { ok: false } }, { 'launch-S-1': { ok: false, reason: '' } }, { 'nope-S-1': { ok: true } }, { 'launch-../x': { ok: true } }, { 'launch-S-1': null }]) {
    const w = world((i, x) => { x.doc = { sessions: [], requests: {}, answers }; }, { giveUpMs: 2_000 });
    const r = await w.ports.launch(LAUNCH);
    assert.match(r.reason, /answers? .*(are|is) not what the runner writes/, JSON.stringify(answers));
  }
  const base = { statusFile: FILE, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, writeRequest: () => {} };
  assert.throws(() => ownerAsyncPorts({ ...base, writeRequest: undefined }), /writer/);
  for (const copiesRoot of [undefined, '', 'copies']) assert.throws(() => ownerAsyncPorts({ ...base, copiesRoot }), /copies folder is not known/);
});
