import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { writeStopRequest, STOP_KEYS, STOP_PREFIX } from './review-stop.mjs';
import { readRequest, FOLDERS } from './review-runner.mjs';
import { stopGroupOf } from './review-runner-main.mjs';
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
    assert.deepEqual(got, { ok: true, req: { request_id: 'req-1', stop: true }, stop: true });
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
  const leader = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const child = Number(await new Promise((res) => leader.stdout.once('data', (b) => res(String(b).trim()))));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  try {
    assert.ok(alive(leader.pid) && alive(child));
    const ended = new Promise((res) => leader.once('exit', res));
    stopGroupOf(leader.pid);
    await ended;
    for (let i = 0; i < 50 && alive(child); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(child), false, 'the child in its group is stopped too');
  } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ } }
  // A pid whose group is another's: nothing is sent.
  const sent = [];
  assert.throws(() => stopGroupOf(4242, { ps: () => ({ status: 0, stdout: ' 4000\n' }), kill: (...a) => sent.push(a) }), /does not lead its own process group \(its group is 4000\)/);
  assert.throws(() => stopGroupOf(4242, { ps: () => ({ status: 1, stdout: '' }), kill: (...a) => sent.push(a) }), /is gone/);
  for (const bad of [0, 1, -5, 1.5, '7']) assert.throws(() => stopGroupOf(bad, { kill: (...a) => sent.push(a) }), /not a process id/);
  assert.deepEqual(sent, []);
  stopGroupOf(4242, { ps: () => ({ status: 0, stdout: '4242\n' }), kill: (...a) => sent.push(a) });
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
    for (const role of WORKER_ROLES) assert.ok(rows.some((r) => r.path === join(outboxRootPath(cfg), role) && r.owner === 'owner'), role);
    // The Record is orchestrate's but readable (0755): for a worker the read-deny is the wall, so every product's
    // sessions must have it (the worker runner refuses a config without).
    assert.ok(rows.some((r) => r.path === storePath(cfg, 'acme') && r.owner === 'orchestrate'));
    assert.ok(DENY_KEYS.includes('record'));
    // The runner's memory, where the id is kept, is named state.json in its own folder (its 0600 is pinned by the pass test).
    assert.equal(FOLDERS.state, 'state.json');
    assert.equal(FOLDERS.requests, 'requests');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
