import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { writeStopRequest, STOP_KEYS, STOP_PREFIX, STOP_TARGET_KEYS, STOP_TARGET_REASON_KEYS } from './review-stop.mjs';
import { readRequest, FOLDERS } from './review-runner.mjs';
import { stopGroupOf } from './review-runner-main.mjs';
import { PLAN_REVIEW_ROLE } from '../../../shared/review-roles.mjs';
import { REVIEW_USER } from './review-user.mjs';
import { DISPATCHER_USER, dispatcherPlist } from '../../../setup/dispatcher-setup.mjs';
import { folderTable, parseConfig, USERS, outboxRootPath, storePath, WORKER_ROLES } from '../../../setup/layout.mjs';
import { workerRunnerPlist } from '../../../wiring/runner-job.mjs';
import { DENY_KEYS } from '../../../wiring/runner-main.mjs';

test('L935: a stop request is stop-<new id>.json holding exactly { request_id, stop: true }, readable by the runner, never over another file', () => {
  const d = tempDir('m4-stop-');
  const was = process.umask(0o077);   // the Dispatcher's job runs with umask 077
  try {
    let n = 0;
    const w = writeStopRequest({ dir: d, requestId: 'req-1', newName: () => `n${++n}`, tmpId: () => 't' });
    assert.deepEqual(w, { ok: true, name: `${STOP_PREFIX}n1.json` });
    assert.equal(lstatSync(join(d, w.name)).mode & 0o777, 0o644, 'readable by the runner whatever the umask');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, w.name), 'utf8'))).sort(), [...STOP_KEYS]);
    assert.deepEqual(readdirSync(d), [w.name], 'no hidden file left behind');
    // The runner reads it as a stop.
    const got = readRequest(d, w.name);
    assert.deepEqual(got, { ok: true, req: { request_id: 'req-1', stop: true }, stop: true, owner: process.getuid() }, 'with its file\'s owner, which a stop must be the Dispatcher\'s');
    // Never over another file: the same name again is refused, and the file there is left as it was.
    writeFileSync(join(d, `${STOP_PREFIX}same.json`), 'theirs');
    const again = writeStopRequest({ dir: d, requestId: 'req-2', newName: () => 'same' });
    assert.equal(again.ok, false); assert.match(again.reason, /EEXIST/);
    assert.equal(readFileSync(join(d, `${STOP_PREFIX}same.json`), 'utf8'), 'theirs');
    // A request id that is not one is refused, and nothing is written.
    for (const bad of ['', 'a/b', 'x'.repeat(65), 7, null]) assert.equal(writeStopRequest({ dir: d, requestId: bad }).ok, false, String(bad));
    // Neither name holds the request id: a file name is shown where a body is not.
    const named = writeStopRequest({ dir: d, requestId: 'secret-id' });
    assert.equal(named.ok, true);
    assert.ok(!readdirSync(d).some((x) => x.includes('secret-id')));
  } finally { process.umask(was); rmSync(d, { recursive: true, force: true }); }
});

// #455 r2 c3: the writer's module gives both target shapes, with and without a reason, as the files it writes hold.
test('#455 r2 c3: a stop by card, role and head holds exactly the target keys, or the reason keys with a reason', () => {
  const d = tempDir('m4-stop-keys-');
  const head = 'a'.repeat(40);
  const plain = writeStopRequest({ dir: d, target: { card: 'C-1', role: 'reviewer', head }, newName: () => 'k1' });
  const why = writeStopRequest({ dir: d, target: { card: 'C-1', role: 'reviewer', head, reason: 'cancel' }, newName: () => 'k2' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, plain.name), 'utf8'))).sort(), [...STOP_TARGET_KEYS]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, why.name), 'utf8'))).sort(), [...STOP_TARGET_REASON_KEYS]);
});

test('L935: what the runner refuses as a stop: stop not true, a key more or less, a link', () => {
  const d = tempDir('m4-stop-');
  try {
    const put = (name, body) => { writeFileSync(join(d, name), JSON.stringify(body)); return name; };
    assert.match(readRequest(d, put('stop-a.json', { request_id: 'r', stop: false })).reason, /must say "stop": true/);
    assert.match(readRequest(d, put('stop-b.json', { request_id: 'r', stop: 'yes' })).reason, /must say "stop": true/);
    assert.match(readRequest(d, put('stop-c.json', { request_id: 'r', stop: true, card: 'C-1' })).reason, /must hold exactly/);
    assert.match(readRequest(d, put('stop-d.json', { stop: true })).reason, /must hold exactly/);
    assert.match(readRequest(d, put('stop-e.json', { request_id: 'a/b', stop: true })).reason, /request id/);
    put('real.json', { request_id: 'r', stop: true });
    spawnSync('/bin/ln', ['-s', join(d, 'real.json'), join(d, 'stop-f.json')]);
    assert.equal(readRequest(d, 'stop-f.json').reason, 'it is a link');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L935: the real stop ends the session\'s whole process group, and refuses a process that does not lead its own', async () => {
  // A detached sh (its group's leader, as the review start makes claude) with a child of its own.
  // Its command line carries a session id, as claude's does: the stop checks both right before the kill (re-review 3 m3).
  const leader = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait', 'sh', '--session-id', 'S-9'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const child = Number(await new Promise((res) => leader.stdout.once('data', (b) => res(String(b).trim()))));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  try {
    assert.ok(alive(leader.pid) && alive(child));
    const ended = new Promise((res) => leader.once('exit', res));
    assert.throws(() => stopGroupOf(leader.pid, { claudeBin: '/bin/sh', sessionId: 'S-8' }), /no longer claude under session S-8/);
    assert.throws(() => stopGroupOf(leader.pid, { claudeBin: '/c/claude', sessionId: 'S-9' }), /no longer claude under session S-9/);
    assert.ok(alive(leader.pid), 'not stopped by either');
    stopGroupOf(leader.pid, { claudeBin: '/bin/sh', sessionId: 'S-9' });
    await ended;
    for (let i = 0; i < 50 && alive(child); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(child), false, 'the child in its group is stopped too');
  } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ } }
  // A pid whose group is another's: nothing is sent.
  const sent = [];
  const who = { claudeBin: '/c/claude', sessionId: 'S-9' };
  assert.throws(() => stopGroupOf(4242, { ps: () => ({ status: 0, stdout: ' 4000 /c/claude --session-id S-9\n' }), ...who, kill: (...a) => sent.push(a) }), /does not lead its own process group \(its group is 4000\)/);
  assert.throws(() => stopGroupOf(4242, { ps: () => ({ status: 1, stdout: '' }), ...who, kill: (...a) => sent.push(a) }), /is gone/);
  for (const bad of [0, 1, -5, 1.5, '7']) assert.throws(() => stopGroupOf(bad, { kill: (...a) => sent.push(a) }), /not a process id/);
  // Trying again can't help a pid that leads no group, or is no pid (final, so the runner tells Joe once); a gone one may.
  const err = (f) => { try { f(); } catch (e) { return e; } return null; };
  assert.equal(err(() => stopGroupOf(4242, { ps: () => ({ status: 0, stdout: ' 4000 /c/claude --session-id S-9\n' }), ...who, kill: () => {} })).final, true);
  assert.equal(err(() => stopGroupOf(0, { kill: () => {} })).final, true);
  assert.equal(err(() => stopGroupOf(4242, { ps: () => ({ status: 1, stdout: '' }), ...who, kill: () => {} })).final, undefined);
  assert.deepEqual(sent, []);
  // Its line read wrong, or another program or session at that pid now: not final (it may be gone next pass), nothing sent.
  for (const out of ['4242\n', ' 4242 /bin/zsh --session-id S-9\n', ' 4242 /c/claude --session-id S-7\n', ' 4242 /c/claude\n']) {
    const e = err(() => stopGroupOf(4242, { ps: () => ({ status: 0, stdout: out }), kill: (...a) => sent.push(a), ...who }));
    assert.ok(e && e.final === undefined, out);
  }
  assert.deepEqual(sent, []);
  let asked = null;
  stopGroupOf(4242, { ps: (bin, args) => { asked = args; return { status: 0, stdout: ' 4242 /c/claude --session-id S-9 --print\n' }; }, kill: (...a) => sent.push(a), ...who });
  assert.deepEqual(asked, ['-o', 'pgid=,command=', '-p', '4242'], 'the group and the command line in one read');
  assert.deepEqual(sent, [[-4242, 'SIGTERM']]);
});

test('L935 condition: the request id is proof only while no worker shares a uid with what keeps it; setup\'s users say so', () => {
  const base = tempDir('m4-stop-');
  try {
    const cfg = parseConfig({ base, owner: 'joe', products: ['acme'] });
    // Three Mac users: the runner is review's, the Dispatcher orchestrate's, the workers the owner's.
    assert.equal(REVIEW_USER, 'review');
    assert.equal(DISPATCHER_USER, 'orchestrate');
    assert.ok(USERS.includes(REVIEW_USER) && USERS.includes(DISPATCHER_USER) && !USERS.includes(cfg.owner));
    assert.match(dispatcherPlist({ ...cfg, label: 'com.example.t' }), /<key>UserName<\/key>\s*<string>orchestrate<\/string>/);
    const worker = workerRunnerPlist({ label: 'com.example.t.runner', node: '/n/node', script: '/n/runner-main.mjs', config: '/n/c.json', path: '/usr/bin:/bin', logDir: '/n/log', workDir: '/n/w', home: '/n/h' });
    assert.doesNotMatch(worker, /UserName/, "the worker runner is the owner's own job, so its sessions are the owner's uid");
    // The review runner's folder is review's, and the workers' outboxes the owner's.
    const rows = folderTable(cfg);
    assert.ok(rows.some((r) => r.path === join(base, 'review') && r.owner === 'review' && r.mode === 0o755));
    // Flat, or per product for the worker runner's roles (L914).
    for (const role of WORKER_ROLES) assert.ok(rows.some((r) => (r.path === join(outboxRootPath(cfg), role) || r.path === join(outboxRootPath(cfg), 'acme', role)) && r.owner === 'owner'), role);
    // The Record is orchestrate's but readable (0755): for a worker the read-deny is the wall, so every product's
    // sessions must have it (the worker runner refuses a config without).
    assert.ok(rows.some((r) => r.path === storePath(cfg, 'acme') && r.owner === 'orchestrate'));
    assert.ok(DENY_KEYS.includes('record'));
    // The runner's memory, where the id is kept, is named state.json in its own folder (its 0600 is pinned by the pass test).
    assert.equal(FOLDERS.state, 'state.json');
    assert.equal(FOLDERS.requests, 'requests');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('L946: a stop by card, role and head is { card, head, role, stop: true }; the runner reads it as one, and refuses one wrong', () => {
  const d = tempDir('m4-stop-');
  try {
    const head = 'a'.repeat(40);
    const w = writeStopRequest({ dir: d, target: { card: 'C-1', role: 'reviewer', head }, newName: () => 't1' });
    assert.equal(w.ok, true, w.reason);
    assert.deepEqual(JSON.parse(readFileSync(join(d, 'stop-t1.json'), 'utf8')), { card: 'C-1', head, role: 'reviewer', stop: true });
    const got = readRequest(d, 'stop-t1.json');
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.target, true);
    assert.equal(got.owner, process.getuid());
    for (const [t, why] of [[{ card: '.x', role: 'reviewer', head }, /card id/], [{ card: 'C-1', role: 'builder', head }, /role/], [{ card: 'C-1', role: PLAN_REVIEW_ROLE, head }, /role/], [{ card: 'C-1', role: 'reviewer', head: 'abc' }, /40 hex/], [null, /card id/]]) {
      assert.match(writeStopRequest({ dir: d, target: t }).reason, why);
    }
    assert.match(writeStopRequest({ dir: d, requestId: 'r-1', target: { card: 'C-1', role: 'reviewer', head } }).reason, /not both/);
    const put = (name, body) => { writeFileSync(join(d, name), JSON.stringify(body)); return name; };
    assert.match(readRequest(d, put('stop-x1.json', { card: 'C-1', head, role: 'reviewer', stop: false })).reason, /must say "stop": true/);
    assert.match(readRequest(d, put('stop-x2.json', { card: 'C/1', head, role: 'reviewer', stop: true })).reason, /card id/);
    assert.match(readRequest(d, put('stop-x3.json', { card: 'C-1', head, role: PLAN_REVIEW_ROLE, stop: true })).reason, /role/);
    assert.match(readRequest(d, put('stop-x4.json', { card: 'C-1', head: 'A'.repeat(40), role: 'reviewer', stop: true })).reason, /40 hex/);
    assert.match(readRequest(d, put('stop-x5.json', { card: 'C-1', head, role: 'reviewer', stop: true, request_id: 'r' })).reason, /must hold exactly/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
