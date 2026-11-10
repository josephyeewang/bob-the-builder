// Part C, runner step 1: the Dispatcher's read of the worker runner's status, and the sync ports on it (owner-ports.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_PORTS, STATUS_STALE_MS } from './owner-ports.mjs';
import { USED_UP, ownerSyncPorts, readOwnerStatus, requestWriter } from './owner-status.mjs';

const OWNER = 501; const NOW = Date.parse('2026-11-09T12:00:00Z');
const FILE = '/runner/status.json';
const st = ({ uid = OWNER, mode = 0o755, dir = false, link = false } = {}) => ({ uid, mode, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => link });
const SIZE = { tokens: 1200, compactions: 0, turnEnded: true, endedAt: null, openTools: [] };
const session = (id, more = {}) => ({ id, product: 'p', kind: 'worker', card: `c-${id}`, lead: 'L', role: 'worker', pgid: 77, signin: 's', config_dir: '/cfg', bundle_files: [],
  outbox: `/out/worker/${id}`, uid: OWNER, alive: true, ended: false, last_write_at: NOW - 1000, size: SIZE, activity: { state: 'active' }, outbox_open: true, ...more });
const doc = (more = {}) => ({ written_at: new Date(NOW - 10_000).toISOString(), sessions: [session('s1')], requests: { s1: { state: 'started' } }, ...more });

function world(d = doc(), { dirSt = st({ dir: true }), fileSt = st({ mode: 0o644 }) } = {}) {
  const writes = [];
  const files = { [FILE]: typeof d === 'string' ? d : JSON.stringify(d) };
  const stat = (p) => { if (p === '/runner') return dirSt; if (p in files) return fileSt; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const read = (p) => files[p];
  const ports = ownerSyncPorts({ statusFile: FILE, uid: OWNER, clock: () => NOW, stat, read, writeRequest: (n, t) => writes.push([n, t]) });
  return { ports, writes, stat, read, files };
}

test('step 1: a fresh status of the runner\'s shape gives the five sync ports their shapes', () => {
  const { ports } = world(doc({ sessions: [session('s1'), session('s2', { alive: false, ended: true, outbox_open: true, request: 'think-1' }), session('s3', { ended: true, outbox_open: false, alive: undefined })] }));
  assert.deepEqual(ports.sessions().map((s) => s.id), ['s1'], 'only what runs');
  assert.deepEqual(Object.keys(ports.sessions()[0]), ['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files']);
  assert.deepEqual(ports.board(), [{ id: 's1', card: 'c-s1', alive: true, ended: false, lastWriteAt: NOW - 1000 }, { id: 's2', card: 'c-s2', alive: false, ended: true, lastWriteAt: NOW - 1000 }, { id: 's3', card: 'c-s3', ended: true, lastWriteAt: NOW - 1000 }], 'an alive the runner does not know is left out, never false');
  assert.deepEqual(ports.outboxSessions().map((s) => s.sessionId), ['s1', 's2'], 'an ended session stays listed while its outbox is open');
  assert.equal(ports.outboxSessions()[1].request, 'think-1'); assert.equal('request' in ports.outboxSessions()[0], false);
  assert.deepEqual(ports.probe({ id: 's1' }), { size: SIZE, activity: { state: 'active' } });
  for (const k of ['sessions', 'board', 'outboxSessions', 'probe', 'stopSession']) assert.equal(OWNER_PORTS[k].sync, true, k);
});

test('step 1: a status that can\'t be trusted is "not known", a throw, never an empty or partial answer', () => {
  const bad = [
    [world(doc({ written_at: new Date(NOW - STATUS_STALE_MS - 1).toISOString() })), /minutes old; the runner may be stopped/],
    [world(doc({ written_at: new Date(NOW + STATUS_STALE_MS + 1).toISOString() })), /dated in the future/],
    [world('{not json'), /can't be read/],
    [world(doc({ sessions: [session('s1'), { id: 's2' }] })), /not what the runner writes/],
    [world(doc({ sessions: [session('s1', { product: undefined })].map((x) => { delete x.product; return x; }) })), /has no product/],
    [world(doc({ requests: { s1: { state: 'maybe' } } })), /a request .* is not what the runner writes/],
    [world(doc(), { fileSt: st({ uid: 0, mode: 0o644 }) }), /status is not owned by the owner's user/],
    [world(doc(), { fileSt: st({ mode: 0o666 }) }), /status can be written by others/],
    [world(doc(), { dirSt: st({ dir: true, mode: 0o777 }) }), /folder can be written by others/],
    [world(doc(), { fileSt: st({ link: true }) }), /status is a link/],
  ];
  for (const [{ ports }, why] of bad) for (const k of ['sessions', 'board', 'outboxSessions']) assert.throws(() => ports[k](), why, `${k} ${why}`);
  const { ports } = world(doc({ sessions: [session('s1', { size: { tokens: 1 } })] }));
  assert.throws(() => ports.probe({ id: 's1' }), /no full size/, 'never a partial size');
  const { compactions: _c, ...noCompactions } = SIZE; void _c;
  assert.throws(() => world(doc({ sessions: [session('s1', { size: noCompactions })] })).ports.probe({ id: 's1' }), /no full size/, 'one field missing is partial too');
  assert.throws(() => ports.probe({ id: 'nope' }), /not in the worker runner's status/);
  assert.throws(() => readOwnerStatus({ file: FILE, now: NOW, uid: undefined }), /uid is not known/);
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
