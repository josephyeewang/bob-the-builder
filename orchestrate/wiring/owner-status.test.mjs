// Part C, runner step 1: the Dispatcher's read of the worker runner's status, and the sync ports on it (owner-ports.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { join } from 'node:path';
import { OWNER_PORTS, STATUS_STALE_MS } from './owner-ports.mjs';
import { State } from '../modules/M4-workshop/send-safe/activity.mjs';
import { CLOCK_SKEW_MS, RUNNER_KINDS, RUNNER_ROLE_OF, RUNNER_STATUS_EVERY_MS, STATUS_MAX_BYTES, USED_UP, openRead, ownerSyncPorts, readOwnerStatus, requestWriter, runnerCopy, runnerOutbox, runnerPlaces, productRole, productRoleClash } from './owner-status.mjs';
import { PRODUCT_OUTBOX_ROLES } from '../shared/product-paths.mjs';

const OWNER = 501; const NOW = Date.parse('2026-11-09T12:00:00Z');
const FILE = '/runner/status.json'; const ROOT = '/out';
const st = ({ uid = OWNER, mode = 0o755, dir = false, link = false, nlink = 1 } = {}) => ({ uid, mode, nlink, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => link });
const SIZE = { tokens: 1200, compactions: 0, turnEnded: true, endedAt: null, openTools: [] };
const session = (id, more = {}) => ({ id, product: 'p', kind: 'editing', card: `c-${id}`, lead: 'L', role: 'worker', pgid: 77, signin: 's', config_dir: '/cfg', bundle_files: [],
  outbox: `${ROOT}/p/worker/${id}`, uid: OWNER, alive: true, ended: false, last_write_at: NOW - 1000, size: SIZE, activity: { state: 'active' }, outbox_open: true, stop_requested: false, ...more });
const doc = (more = {}) => ({ written_at: new Date(NOW - 10_000).toISOString(), sessions: [session('s1')], requests: { s1: { state: 'started' } }, ...more });

function world(d = doc(), { dirSt = st({ dir: true }), fileSt = st({ mode: 0o644 }), holds = () => true, text: forced, realpath = (p) => p } = {}) {
  const writes = [];
  const text = typeof d === 'string' ? d : JSON.stringify(d);
  const stat = (p) => { if (p === '/runner') return dirSt; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const open = (p) => { assert.equal(p, FILE); return { st: fileSt, text: forced === undefined ? text : forced }; };
  const ports = ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, realpath, clock: () => NOW, stat, open, writeRequest: (n, t) => writes.push([n, t]), holds });
  return { ports, writes };
}

test('step 1: a fresh status of the runner\'s shape gives the five sync ports their shapes', () => {
  const { ports } = world(doc({ sessions: [session('s1'), session('s2', { alive: false, ended: true }), session('s3', { ended: true, outbox_open: false, alive: undefined }), session('s4', { alive: true, ended: true })],
    requests: { s1: { state: 'started' }, s2: { state: 'stopped' }, s3: { state: 'stopped' }, s4: { state: 'started' } } }));
  assert.deepEqual(ports.sessions().map((s) => s.id), ['s1', 's4'], 'what runs: a session whose process group is still there counts, even once ended');
  assert.deepEqual(Object.keys(ports.sessions()[0]), ['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files']);
  assert.deepEqual(ports.board().slice(0, 3), [{ id: 's1', card: 'c-s1', alive: true, ended: false, lastWriteAt: NOW - 1000 }, { id: 's2', card: 'c-s2', alive: false, ended: true, lastWriteAt: NOW - 1000 }, { id: 's3', card: 'c-s3', ended: true, lastWriteAt: NOW - 1000 }], 'an alive the runner does not know is left out, never false');
  assert.deepEqual(ports.outboxSessions().map((s) => s.sessionId), ['s1', 's2', 's4'], 'an ended session stays listed while its outbox is open');
  assert.deepEqual(ports.outboxSessions()[0], { sessionId: 's1', role: 'worker', outbox: `${ROOT}/p/worker/s1`, uid: OWNER, card: 'c-s1', product: 'p' });
  assert.deepEqual(ports.probe({ id: 's1' }), { size: SIZE, activity: { state: 'active' } });
  for (const k of ['sessions', 'board', 'outboxSessions', 'probe', 'stopSession']) assert.equal(OWNER_PORTS[k].sync, true, k);
  assert.deepEqual({ ...RUNNER_ROLE_OF }, { editing: 'worker', undo: 'worker', script: 'script' }, 'pass.mjs kindOf and startRole: the only kinds the runner starts');
  assert.deepEqual([...RUNNER_KINDS], ['editing', 'undo', 'script']);
  // L895 m2: RUNNER_ROLE_OF maps onto PRODUCT_OUTBOX_ROLES, and its guard refuses a role off that list.
  for (const r of PRODUCT_OUTBOX_ROLES) assert.equal(productRole(r), r);
  for (const r of ['lead', 'reviewer', 'front_door', 'Worker', '']) assert.throws(() => productRole(r), /is not one of PRODUCT_OUTBOX_ROLES/, r);
  // L767, L836: a script session has its own outbox, <root>/<product>/script/<id>, and intake tags its hand-ins 'script'.
  const scriptDoc = (more) => doc({ sessions: [session('s1', { kind: 'script', role: 'script', lead: null, outbox: `${ROOT}/p/script/s1`, ...more })] });
  assert.deepEqual(world(scriptDoc()).ports.sessions().map((x) => x.kind), ['script']);
  assert.deepEqual(world(scriptDoc()).ports.outboxSessions().map((x) => [x.role, x.outbox]), [['script', `${ROOT}/p/script/s1`]]);
  assert.throws(() => world(scriptDoc({ outbox: `${ROOT}/p/worker/s1` })).ports.sessions(), /not a script outbox/, 'a script under the worker folder');
  assert.throws(() => world(doc({ sessions: [session('s1', { outbox: `${ROOT}/p/script/s1` })] })).ports.sessions(), /not a worker outbox/, 'a worker under the script folder');
  // A closed script outbox gets only the shape check, so the root is checked on its own: a script folder elsewhere is refused.
  assert.throws(() => world(scriptDoc({ outbox: '/elsewhere/script/s1', outbox_open: false })).ports.sessions(), /not inside the outbox root/, 'a closed script outbox outside the root');
  assert.deepEqual(world(doc({ sessions: [session('s1', { size: { ...SIZE, tokens: null } })] })).ports.probe({ id: 's1' }).size.tokens, null, 'readSize\'s "none yet" is a full size');
});

test('step 1 M1: the board holds the sessions meant to run; one stopped on request, or whose card the Record has moved on, has left it', () => {
  const ended = { alive: false, ended: true, last_write_at: NOW - 3_600_000 };
  const d = doc({ sessions: [session('a1', { ...ended, stop_requested: true }), session('b1', { ...ended, card: 'B' }), session('b2', { card: 'B' }), session('c1', ended)],
    requests: { a1: { state: 'stopped' }, b1: { state: 'stopped' }, b2: { state: 'started' }, c1: { state: 'stopped' } } });
  const asked = [];
  let held = new Set(['a1', 'b2', 'c1']);   // the Record: a1's card is still claimed while it stops; B is now b2's; c-c1 still c1's (it died, not yet handled)
  const { ports } = world(d, { holds: (q) => { asked.push(q); return held.has(q.sessionId); } });
  assert.deepEqual(ports.board().map((r) => r.id), ['b2', 'c1'], 'a1 stopped on request (its claim not yet given back, so a mass stop is no outage); b1 replaced by b2; c1 died and is seen once');
  assert.ok(asked.some((q) => q.card === 'c-c1' && q.sessionId === 'c1'), 'the Record is asked by card and session');
  assert.ok(!asked.some((q) => q.sessionId === 'b2'), 'a running session is on the board without asking');
  held = new Set(['a1', 'b2']);   // the outage step handled c1: its card waits on Joe
  assert.deepEqual(ports.board().map((r) => r.id), ['b2'], 'a handled death is not counted again on the next pass');
  for (const h of ['yes', undefined, { corrupt: true }]) assert.throws(() => world(d, { holds: () => h }).ports.board(), /the Record can't tell whether card/, `holds answering ${JSON.stringify(h)} is "not known", never a dropped row`);
  assert.deepEqual(ports.outboxSessions().map((x) => x.sessionId), ['a1', 'b1', 'b2', 'c1'], 'the outboxes are read whatever the board says');
  assert.throws(() => ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, writeRequest: () => {} }), /holds/);
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
    [world(s1({ kind: 'audit' })), /kind "audit", which the runner does not start/],
    [world(s1({ kind: 'constructor' })), /kind "constructor", which the runner does not start/],
    [world(s1({ role: 'lead' })), /role "lead", which is not the role a editing session runs/],
    [world(s1({ role: 'front_door' })), /role "front_door"/],
    [world(s1({ role: 'script' })), /role "script"/],
    [world(s1({ kind: 'script' })), /role "worker", which is not the role a script session runs/],
    [world(s1({ product: '' })), /product that is not a name/],
    [world(s1({ signin: 5 })), /signin that is not a name/],
    [world(s1({ config_dir: '' })), /config_dir that is not a name/],
    [world(s1({ lead: 3 })), /lead that is not a name/],
    [world(s1({ pgid: '77' })), /no process group/],
    [world(s1({ card: 5 })), /has no card/],
    [world(s1({ card: null })), /has no card/],
    [world(s1({ card: '' })), /has no card/],
    [world(doc({ sessions: [session('s1'), session('s2', { outbox_open: false, outbox: '/other/worker/s2' })] })), /s2 .*outbox that is not inside the outbox root/],
    [world(doc(), { fileSt: { ...st({ mode: 0o644 }), size: STATUS_MAX_BYTES + 1 }, text: null }), /bytes, more than the runner writes/],
    [world(s1({ bundle_files: 'a' })), /bundle_files that are not a list/],
    [world(s1({ uid: 0 })), /Mac user other than the owner's/],
    [world(s1({ outbox: '/elsewhere/worker/x' })), /outbox that is not this session's own folder/],
    [world(s1({ outbox: '/elsewhere/worker/s1' })), /outbox that is not inside the outbox root/],
    [world(s1({ outbox: undefined })), /outbox that was not named/],
    [world(doc(), { realpath: (p) => (p === `${ROOT}/p/worker/s1` ? '/elsewhere/worker/s1' : p) }), /outbox that is not inside the outbox root/],
    [world(s1({ request: 'think-1' })), /read-only request/],
    [world(s1({ outbox_open: undefined })), /has no outbox_open/],
    [world(s1({ stop_requested: 'no' })), /has no stop_requested/],
    [world(s1({ alive: 'yes' })), /alive that is not true or false/],
    [world(s1({ ended: 1 })), /ended that is not true or false/],
    [world(s1({ last_write_at: new Date(NOW).toISOString() })), /last_write_at that is not a time/],
    [world(doc({ requests: { s1: { state: 'maybe' } } })), /a request .* is not what the runner writes/],
    [world(doc(), { fileSt: st({ uid: 0, mode: 0o644 }) }), /status is not owned by the owner's user/],
    [world(doc(), { fileSt: st({ mode: 0o666 }) }), /status can be written by others/],
    [world(doc(), { fileSt: st({ mode: 0o664 }) }), /status can be written by others/],
    [world(doc(), { dirSt: st({ dir: true, mode: 0o775 }) }), /folder can be written by others/],
    [world(doc(), { fileSt: st({ mode: 0o644, nlink: 2 }) }), /not a plain file of its own/],
    [world(doc(), { dirSt: st({ dir: true, mode: 0o777 }) }), /folder can be written by others/],
    [world(doc(), { fileSt: st({ link: true }) }), /status is a link/],
    [world(doc(), { fileSt: { ...st({ mode: 0o644 }), isFile: () => false } }), /not a plain file of its own/],
  ];
  for (const [{ ports }, why] of bad) for (const k of ['sessions', 'board', 'outboxSessions']) assert.throws(() => ports[k](), why, `${k} ${why}`);
  assert.doesNotThrow(() => world(doc({ written_at: new Date(NOW + CLOCK_SKEW_MS - 1).toISOString() })).ports.sessions(), 'a small clock difference is fine');
  const partial = [{ tokens: 1 }, { ...SIZE, compactions: undefined }, { ...SIZE, turnEnded: 'no' }, { ...SIZE, tokens: '1' }, { ...SIZE, compactions: 0.5 }, { ...SIZE, endedAt: 'x' }, { ...SIZE, openTools: 0 }];
  for (const size of partial) assert.throws(() => world(doc({ sessions: [session('s1', { size })] })).ports.probe({ id: 's1' }), /no full size/, JSON.stringify(size));
  for (const activity of [{}, { state: 'nonsense' }, { state: null }, { state: 'Active' }]) assert.throws(() => world(doc({ sessions: [session('s1', { activity })] })).ports.probe({ id: 's1' }), /no activity state the tracker gives/, JSON.stringify(activity));
  for (const state of Object.values(State)) assert.equal(world(doc({ sessions: [session('s1', { activity: { state } })] })).ports.probe({ id: 's1' }).activity.state, state);
  assert.throws(() => world().ports.probe({ id: 'nope' }), /not in the worker runner's status/);
  assert.throws(() => readOwnerStatus({ file: FILE, now: NOW, uid: undefined, outboxRoot: ROOT }), /uid is not known/);
  for (const outboxRoot of [undefined, '', 'out']) assert.throws(() => readOwnerStatus({ file: FILE, now: NOW, uid: OWNER, outboxRoot }), /outbox root is not known/, String(outboxRoot));
  // m2: a closed outbox's folder is not looked up, so one cleared folder can't take every port down; its shape still is checked
  const gone = (p) => { if (p !== ROOT && p !== `${ROOT}/p`) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return p; };
  const closed = doc({ sessions: [session('s1'), session('s2', { alive: false, ended: true, outbox_open: false })], requests: { s1: { state: 'started' }, s2: { state: 'stopped' } } });
  assert.deepEqual(ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, clock: () => NOW, stat: () => st({ dir: true }), open: () => ({ st: st({ mode: 0o644 }), text: JSON.stringify(closed) }), realpath: (p) => (p === `${ROOT}/p/worker/s1` ? p : gone(p)), writeRequest: () => {}, holds: () => true }).sessions().map((x) => x.id), ['s1']);
  assert.throws(() => world(doc({ sessions: [session('s1'), session('s2', { outbox_open: false, outbox: '/x/y' })] })).ports.sessions(), /outbox that is not this session's own folder/);
});

test('step 1 m6: the status is opened once, never through a link, and that open file is what is checked and read', () => {
  const d = tempDir('orch-owner-status-');
  try {
    writeFileSync(join(d, 'real.json'), 'hello'); symlinkSync(join(d, 'real.json'), join(d, 'link.json'));
    const { st: s, text } = openRead(join(d, 'real.json'));
    assert.equal(text, 'hello'); assert.ok(s.isFile()); assert.equal(s.nlink, 1);
    assert.throws(() => openRead(join(d, 'link.json')), /status is a link/);
    assert.throws(() => openRead(join(d, 'none.json')), /status is missing/);
    linkSync(join(d, 'real.json'), join(d, 'hard.json'));
    assert.equal(openRead(join(d, 'hard.json')).text, null, 'a file with a second name is not read');
    execFileSync('mkfifo', [join(d, 'pipe.json')]);
    // m4: a pipe returns at once, unread, instead of hanging the pass. Run apart, with a limit, so a hang fails, never stalls.
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { openRead } = await import(${JSON.stringify(new URL('./owner-status.mjs', import.meta.url).href)}); const p = openRead(${JSON.stringify(join(d, 'pipe.json'))}); console.log(JSON.stringify([p.text, p.st.isFile()]));`], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.error?.code, undefined, 'opening a pipe hung');
    assert.deepEqual(JSON.parse(r.stdout), [null, false], r.stderr);
    writeFileSync(join(d, 'big.json'), 'x'.repeat(STATUS_MAX_BYTES + 1));
    assert.equal(openRead(join(d, 'big.json')).text, null, 'a file bigger than the runner writes is not read');
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
    ['used up, ended, process group not known', doc({ sessions: [session('s9', { alive: undefined, ended: true })], requests: { s9: { state: 'stopped' } } })],
  ];
  for (const [what, d] of cases) {
    const w = world(d);
    assert.equal(w.ports.stopSession('s9'), false, what);
    assert.deepEqual(w.writes, [['stop-s9.json', '{"stop":"s9"}\n']], `${what}: one stop request`);
  }
  assert.equal(world().ports.stopSession('../x'), false, 'an id that is not a request id stops nothing');
  assert.equal(world(doc({ sessions: [session('s9', { alive: false, ended: true })], requests: { s9: { state: 'stopped' } } })).ports.stopSession('s9'), true, 'listed but known gone');
  for (const more of [{}, { alive: true, ended: true }]) assert.throws(() => world(doc({ sessions: [session('s9', more)], requests: { s9: { state: 'stopped' } } })).ports.stopSession('s9'), /running under a launch request marked stopped/, 'used up while something still runs under the id: not known, a throw (the claim stays)');
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

test('#324 r1 m1, m4, c1, c2: a status that contradicts itself is not known; a live session stays on the board whatever stop_requested says', () => {
  const ended = { alive: false, ended: true };
  const self = [
    [doc({ requests: {} }), /s1 .*running with no launch request entry/],
    ...['refused', 'cancelled', 'waiting', 'stopped'].map((state) => [doc({ requests: { s1: { state } } }), new RegExp(`s1 .*running under a launch request marked ${state}`)]),
    [doc({ sessions: [session('s1', { alive: undefined, ended: undefined })], requests: { s1: { state: 'waiting' } } }), /running under a launch request marked waiting/],
    [doc({ sessions: [session('s1', { outbox_open: false })] }), /s1 .*running with its outbox marked closed/],
    [doc({ sessions: [session('s1'), session('s2', ended)] }), /s2 .*listed with no launch request entry/],
    ...['refused', 'cancelled', 'waiting'].map((state) => [doc({ sessions: [session('s1'), session('s2', ended)], requests: { s1: { state: 'started' }, s2: { state } } }), new RegExp(`s2 .*listed under a launch request marked ${state}`)]),
  ];
  for (const [d, why] of self) for (const k of ['sessions', 'board', 'outboxSessions']) assert.throws(() => world(d).ports[k](), why, `${k} ${why}`);
  // m4: a stop that failed leaves the session running, so it stays on the board even with stop_requested set.
  const d = doc({ sessions: [session('s1', { stop_requested: true }), session('s2', { ...ended, stop_requested: true }), session('s3', { ended: true, alive: undefined, stop_requested: true })],
    requests: { s1: { state: 'started' }, s2: { state: 'stopped' }, s3: { state: 'stopped' } } });
  assert.deepEqual(world(d, { holds: () => true }).ports.board().map((r) => r.id), ['s1'], 'only a session stopped on request and no longer live leaves');
  // c1, c2
  assert.throws(() => readOwnerStatus({ file: FILE, now: NaN, uid: OWNER, outboxRoot: ROOT }), /clock gave no time/);
  assert.throws(() => ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, clock: () => NaN, stat: () => st({ dir: true }), open: () => ({ st: st({ mode: 0o644 }), text: JSON.stringify(doc()) }), realpath: (p) => p, writeRequest: () => {}, holds: () => true }).sessions(), /clock gave no time/);
  for (const file of ['status.json', 'runner/status.json', '', undefined]) assert.throws(() => readOwnerStatus({ file, now: NOW, uid: OWNER, outboxRoot: ROOT }), /status file is not a full path/, String(file));
});

test('#324 r2 M1: a stop the Dispatcher asked for is never a death: the flag is set when the runner acts, so a stop that timed out and then died leaves no row', () => {
  // The stop timed out (stopGroup answered ok: false, may still run): the session is live, flag set, and stays on the board.
  const asked = doc({ sessions: [session('s1', { stop_requested: true })], requests: { s1: { state: 'started' } } });
  assert.deepEqual(world(asked, { holds: () => true }).ports.board().map((r) => r.id), ['s1'], 'still running: on the board');
  // Then it dies, the claim still held: no dead row, so no per-card dead alert and no false outage in a mass stop.
  for (const state of ['started', 'stopped']) {
    const died = doc({ sessions: [session('s1', { alive: false, ended: true, stop_requested: true, last_write_at: NOW - 3_600_000 })], requests: { s1: { state } } });
    assert.deepEqual(world(died, { holds: () => true }).ports.board(), [], state);
  }
  // The header names that order: set when acted on, before acting, at the latest in the first write that shows it not live.
  const head = readFileSync(new URL('./owner-status.mjs', import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join(' ').replace(/\s*\/\/\s*/g, ' ');
  assert.match(head, /stop_requested: true once the runner acts on a stop it was asked for \(a stop request or stopGroup\), written before it acts, and at the latest in the same write that first shows the session not live; it stays true even if the stop fails or times out/);
  assert.doesNotMatch(head, /confirmed a stop|A stop that failed leaves it false/);
  assert.match(head, /marks a session that ends on its own 'stopped' once it is no longer live/);
});

test('#328 r2 n1 (L769): the runner rewrites its status every 15 s, well inside the age at which the Dispatcher calls it stale', () => {
  assert.equal(RUNNER_STATUS_EVERY_MS, 15_000);
  assert.ok(RUNNER_STATUS_EVERY_MS * 10 <= STATUS_STALE_MS, `${RUNNER_STATUS_EVERY_MS} ms is not well under ${STATUS_STALE_MS} ms`);
});

test('L836: an outbox is its product\'s, in its product\'s folder; a product named as a role has no outbox folder', () => {
  assert.deepEqual(runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product: 'p' }), { copies: '/c/p', outboxes: '/o/p' });
  assert.equal(runnerOutbox({ outboxRoot: '/o', product: 'p', role: 'worker', sessionId: 's1' }), '/o/p/worker/s1');
  assert.equal(runnerCopy({ copiesRoot: '/c', product: 'p', card: 'C-1' }), '/c/p/C-1');
  for (const product of ['worker', 'script', 'lead', 'reviewer']) assert.throws(() => runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product }), /named as a role/, product);
  // Setup's name rule (#378 M1): a name in upper case, or with a dot or an underscore, has no folder setup makes; on the
  // Mac's disk an upper-case name would reach the lower-case folder while its deny entries, spelled otherwise, match nothing.
  for (const product of ['Script', 'LEAD', 'Alpha', 'p.1', 'p_1', '-p', 'a'.repeat(65)]) assert.throws(() => runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product }), /not a product name setup makes a folder for/, product);
  assert.equal(productRoleClash('Worker'), true, 'the clash itself is still read in any letter case');
  for (const product of ['', '../x', '.p', 'a/b', undefined, 'x'.repeat(65)]) assert.throws(() => runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product }), /not a product name/, String(product));
  // The status: an outbox under another product's folder, or straight under the root, is not this session's.
  for (const outbox of [`${ROOT}/q/worker/s1`, `${ROOT}/worker/s1`]) {
    assert.throws(() => world(doc({ sessions: [session('s1', { outbox })] })).ports.sessions(), /not inside the outbox root/, outbox);
  }
  // A closed outbox's folder is not looked up, so the place itself must say it is the product's (pp-status-flat).
  for (const outbox of [`${ROOT}/q/worker/s1`, `${ROOT}/worker/s1`]) {
    const closed = doc({ sessions: [session('s1', { outbox, alive: false, ended: true, outbox_open: false })], requests: { s1: { state: 'stopped' } } });
    assert.throws(() => world(closed).ports.sessions(), /not inside the outbox root, in its product folder/, `closed ${outbox}`);
  }
  assert.throws(() => world(doc({ sessions: [session('s1', { product: 'worker', outbox: `${ROOT}/worker/worker/s1` })] })).ports.sessions(), /product the runner's folders can't hold/);
});
