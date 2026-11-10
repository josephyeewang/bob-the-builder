// Part C, runner step 1: the Dispatcher's read of the worker runner's status, and the sync ports on it (owner-ports.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_PORTS, STATUS_STALE_MS } from './owner-ports.mjs';
import { CLOCK_SKEW_MS, RUNNER_KINDS, RUNNER_ROLES, USED_UP, openRead, ownerSyncPorts, readOwnerStatus, requestWriter } from './owner-status.mjs';

const OWNER = 501; const NOW = Date.parse('2026-11-09T12:00:00Z');
const FILE = '/runner/status.json'; const ROOT = '/out';
const st = ({ uid = OWNER, mode = 0o755, dir = false, link = false, nlink = 1 } = {}) => ({ uid, mode, nlink, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => link });
const SIZE = { tokens: 1200, compactions: 0, turnEnded: true, endedAt: null, openTools: [] };
const session = (id, more = {}) => ({ id, product: 'p', kind: 'editing', card: `c-${id}`, lead: 'L', role: 'worker', pgid: 77, signin: 's', config_dir: '/cfg', bundle_files: [],
  outbox: `${ROOT}/worker/${id}`, uid: OWNER, alive: true, ended: false, last_write_at: NOW - 1000, size: SIZE, activity: { state: 'active' }, outbox_open: true, stop_requested: false, ...more });
const doc = (more = {}) => ({ written_at: new Date(NOW - 10_000).toISOString(), sessions: [session('s1')], requests: { s1: { state: 'started' } }, ...more });

function world(d = doc(), { dirSt = st({ dir: true }), fileSt = st({ mode: 0o644 }) } = {}) {
  const writes = [];
  const text = typeof d === 'string' ? d : JSON.stringify(d);
  const stat = (p) => { if (p === '/runner') return dirSt; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const open = (p) => { assert.equal(p, FILE); return { st: fileSt, text }; };
  const ports = ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, realpath: (p) => p, clock: () => NOW, stat, open, writeRequest: (n, t) => writes.push([n, t]) });
  return { ports, writes };
}

test('step 1: a fresh status of the runner\'s shape gives the five sync ports their shapes', () => {
  const { ports } = world(doc({ sessions: [session('s1'), session('s2', { alive: false, ended: true }), session('s3', { ended: true, outbox_open: false, alive: undefined }), session('s4', { alive: true, ended: true })],
    requests: { s1: { state: 'started' }, s2: { state: 'stopped' }, s3: { state: 'stopped' }, s4: { state: 'started' } } }));
  assert.deepEqual(ports.sessions().map((s) => s.id), ['s1', 's4'], 'what runs: a session whose process group is still there counts, even once ended');
  assert.deepEqual(Object.keys(ports.sessions()[0]), ['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files']);
  assert.deepEqual(ports.board().slice(0, 3), [{ id: 's1', card: 'c-s1', alive: true, ended: false, lastWriteAt: NOW - 1000 }, { id: 's2', card: 'c-s2', alive: false, ended: true, lastWriteAt: NOW - 1000 }, { id: 's3', card: 'c-s3', ended: true, lastWriteAt: NOW - 1000 }], 'an alive the runner does not know is left out, never false');
  assert.deepEqual(ports.outboxSessions().map((s) => s.sessionId), ['s1', 's2', 's4'], 'an ended session stays listed while its outbox is open');
  assert.deepEqual(ports.outboxSessions()[0], { sessionId: 's1', role: 'worker', outbox: `${ROOT}/worker/s1`, uid: OWNER, card: 'c-s1', product: 'p' });
  assert.deepEqual(ports.probe({ id: 's1' }), { size: SIZE, activity: { state: 'active' } });
  for (const k of ['sessions', 'board', 'outboxSessions', 'probe', 'stopSession']) assert.equal(OWNER_PORTS[k].sync, true, k);
  assert.ok(!RUNNER_ROLES.includes('lead') && !RUNNER_ROLES.includes('reviewer') && RUNNER_ROLES.includes('worker'));
  assert.ok(RUNNER_KINDS.includes('editing') && !RUNNER_KINDS.includes('readonly') && !RUNNER_KINDS.includes('lead'));
});

test('step 1 M1: the board holds the sessions meant to run; one stopped on request, or replaced by a newer session of its card, has left it', () => {
  const ended = { alive: false, ended: true, last_write_at: NOW - 3_600_000 };
  const { ports } = world(doc({ sessions: [session('a1', { ...ended, stop_requested: true }), session('b1', { ...ended, card: 'B' }), session('b2', { card: 'B' }), session('c1', ended), session('w1')],
    requests: { a1: { state: 'stopped' }, b1: { state: 'stopped' }, b2: { state: 'started' }, c1: { state: 'stopped' }, w1: { state: 'waiting' } } }));
  assert.deepEqual(ports.board().map((r) => r.id), ['b2', 'c1'], 'a1 stopped on request; b1 replaced by b2; c1 crashed and stays for the outage step; w1 not started');
  assert.deepEqual(ports.outboxSessions().map((s) => s.sessionId), ['a1', 'b1', 'b2', 'c1', 'w1'], 'the outboxes are read whatever the board says');
});

test('step 1: a status that can\'t be trusted is "not known", a throw, never an empty or partial answer', () => {
  const s1 = (more) => doc({ sessions: [session('s1', more)] });
  const bad = [
    [world(doc({ written_at: new Date(NOW - STATUS_STALE_MS - 1).toISOString() })), /minutes old; the runner may be stopped/],
    [world(doc({ written_at: new Date(NOW + CLOCK_SKEW_MS + 1).toISOString() })), /dated in the future/],
    [world('{not json'), /can't be read/],
    [world(doc({ sessions: [session('s1'), { id: 's2' }] })), /has no product/],
    [world(doc({ sessions: [session('s1'), 7] })), /not what the runner writes/],
    [world(doc({ sessions: [session('s1'), session('s1')] })), /listed twice/],
    [world(s1({ product: undefined })), /has no product/],
    [world(s1({ kind: 'worker' })), /kind "worker", which the runner does not start/],
    [world(s1({ role: 'lead' })), /role "lead"/],
    [world(s1({ role: 'reviewer' })), /role "reviewer"/],
    [world(s1({ pgid: '77' })), /no process group/],
    [world(s1({ card: 5 })), /card that is not a card id/],
    [world(s1({ bundle_files: 'a' })), /bundle_files that are not a list/],
    [world(s1({ uid: 0 })), /Mac user other than the owner's/],
    [world(s1({ outbox: '/elsewhere/worker/x' })), /outbox that is not this session's own folder/],
    [world(s1({ outbox: '/elsewhere/worker/s1' })), /outbox that is not inside the outbox root/],
    [world(s1({ outbox: undefined })), /outbox that was not named/],
    [world(s1({ request: 'think-1' })), /read-only request/],
    [world(s1({ outbox_open: undefined })), /has no outbox_open/],
    [world(s1({ stop_requested: 'no' })), /has no stop_requested/],
    [world(s1({ alive: 'yes' })), /alive that is not true or false/],
    [world(s1({ ended: 1 })), /ended that is not true or false/],
    [world(s1({ last_write_at: new Date(NOW).toISOString() })), /last_write_at that is not a time/],
    [world(doc({ requests: { s1: { state: 'maybe' } } })), /a request .* is not what the runner writes/],
    [world(doc(), { fileSt: st({ uid: 0, mode: 0o644 }) }), /status is not owned by the owner's user/],
    [world(doc(), { fileSt: st({ mode: 0o666 }) }), /status can be written by others/],
    [world(doc(), { fileSt: st({ mode: 0o644, nlink: 2 }) }), /not a plain file of its own/],
    [world(doc(), { dirSt: st({ dir: true, mode: 0o777 }) }), /folder can be written by others/],
    [world(doc(), { fileSt: st({ link: true }) }), /status is a link/],
  ];
  for (const [{ ports }, why] of bad) for (const k of ['sessions', 'board', 'outboxSessions']) assert.throws(() => ports[k](), why, `${k} ${why}`);
  assert.doesNotThrow(() => world(doc({ written_at: new Date(NOW + CLOCK_SKEW_MS - 1).toISOString() })).ports.sessions(), 'a small clock difference is fine');
  const partial = [{ tokens: 1 }, { ...SIZE, compactions: undefined }, { ...SIZE, turnEnded: 'no' }, { ...SIZE, tokens: '1' }, { ...SIZE, compactions: 0.5 }, { ...SIZE, endedAt: 'x' }, { ...SIZE, openTools: 0 }];
  for (const size of partial) assert.throws(() => world(doc({ sessions: [session('s1', { size })] })).ports.probe({ id: 's1' }), /no full size/, JSON.stringify(size));
  assert.throws(() => world(doc({ sessions: [session('s1', { activity: {} })] })).ports.probe({ id: 's1' }), /no activity/);
  assert.throws(() => world().ports.probe({ id: 'nope' }), /not in the worker runner's status/);
  assert.throws(() => readOwnerStatus({ file: FILE, now: NOW, uid: undefined }), /uid is not known/);
});

test('step 1 m6: the status is opened once, never through a link, and that open file is what is checked and read', () => {
  const d = mkdtempSync(join(tmpdir(), 'owner-status-'));
  try {
    writeFileSync(join(d, 'real.json'), 'hello'); symlinkSync(join(d, 'real.json'), join(d, 'link.json'));
    const { st: s, text } = openRead(join(d, 'real.json'));
    assert.equal(text, 'hello'); assert.ok(s.isFile()); assert.equal(s.nlink, 1);
    assert.throws(() => openRead(join(d, 'link.json')), /status is a link/);
    assert.throws(() => openRead(join(d, 'none.json')), /status is missing/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 1: stopSession is true only for a used-up launch request with nothing running under the id; otherwise it asks, without waiting', () => {
  assert.deepEqual([...USED_UP], ['refused', 'stopped', 'cancelled']);
  for (const state of USED_UP) {
    const w = world(doc({ sessions: [], requests: { s9: { state } } }));
    assert.equal(w.ports.stopSession('s9'), true, state); assert.deepEqual(w.writes, []);
  }
  const cases = [
    ['a request the runner has not seen', doc({ sessions: [], requests: {} })],
    ['a request seen, not acted on', doc({ sessions: [], requests: { s9: { state: 'waiting' } } })],
    ['started and running', doc({ sessions: [session('s9')], requests: { s9: { state: 'started' } } })],
    ['used up, but something still runs under the id', doc({ sessions: [session('s9')], requests: { s9: { state: 'stopped' } } })],
    ['used up, ended, but its process group is still there', doc({ sessions: [session('s9', { alive: true, ended: true })], requests: { s9: { state: 'stopped' } } })],
  ];
  for (const [what, d] of cases) {
    const w = world(d);
    assert.equal(w.ports.stopSession('s9'), false, what);
    assert.deepEqual(w.writes, [['stop-s9.json', '{"stop":"s9"}\n']], `${what}: one stop request`);
  }
  assert.equal(world().ports.stopSession('../x'), false, 'an id that is not a request id stops nothing');
  assert.throws(() => world('{').ports.stopSession('s9'), /can't be read/, 'a status that can\'t be read is a throw: the claim stays');
  assert.match(OWNER_PORTS.stopSession.out, /a request the runner has not yet seen is never true/);
});

test('step 1: a request file is written exclusively; the same ask twice is one file', () => {
  const made = new Map();
  const write = (p, t, o) => { assert.equal(o.flag, 'wx'); if (made.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); made.set(p, t); };
  const w = requestWriter('/req', write);
  w('stop-s1.json', 'a'); w('stop-s1.json', 'b');
  assert.deepEqual([...made], [['/req/stop-s1.json', 'a']]);
  assert.throws(() => requestWriter('/req', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); })('x.json', ''), /EACCES/, 'any other failure is told');
});
