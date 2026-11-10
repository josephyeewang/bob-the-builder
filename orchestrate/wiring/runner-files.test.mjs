// Part C, runner step 2 (L763): the runner's status write (new file, renamed over) and its request read (one name, orchestrate's).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, linkSync, mkdtempSync, openSync, renameSync, unlinkSync, writeSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUEST_MAX_BYTES, readRequest, writeStatus } from './runner-files.mjs';

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'orch-rf-')));
const ME = process.getuid();

test('L763: the status is written as a new file renamed over the old one, so a hard link to the old one never gets the next status', () => {
  const d = dir();
  try {
    const f = join(d, 'status.json'); const link = join(d, 'planted');
    writeStatus(f, '{"n":1}\n');
    linkSync(f, link);   // made outside the sandbox, as in the probe
    assert.equal(statSync(f).nlink, 2);
    writeStatus(f, '{"n":2}\n');
    assert.equal(readFileSync(f, 'utf8'), '{"n":2}\n');
    assert.equal(readFileSync(link, 'utf8'), '{"n":1}\n', 'the planted name kept the old file');
    assert.equal(statSync(f).nlink, 1, 'the new status has one name');
    assert.notEqual(statSync(f).ino, statSync(link).ino);
    // Writing through the planted name now changes nothing the runner or the Dispatcher reads.
    writeFileSync(link, '{"forged":true}\n');
    assert.equal(readFileSync(f, 'utf8'), '{"n":2}\n');
    assert.deepEqual(readdirSync(d).sort(), ['planted', 'status.json'], 'no temp file is left');
    // A planted link at the temp name is not followed, and the old status stays.
    const evil = join(d, 'evil'); writeFileSync(evil, 'x');
    symlinkSync(evil, join(d, '.status.json.t1.tmp'));
    assert.throws(() => writeStatus(f, '{"n":3}\n', { tag: () => 't1' }), /EEXIST|ELOOP/);
    assert.equal(readFileSync(evil, 'utf8'), 'x'); assert.equal(readFileSync(f, 'utf8'), '{"n":2}\n');
    assert.throws(() => writeStatus('status.json', '{}'), /not a full path/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L763: a failed write leaves the old status and no temp file', () => {
  const d = dir();
  try {
    const f = join(d, 'status.json'); writeStatus(f, 'old\n');
    const fs = { openSync, writeSync, closeSync, renameSync, unlinkSync, fsyncSync: () => { throw new Error('disk full'); } };
    assert.throws(() => writeStatus(f, 'new\n', { fs, tag: () => 't2' }), /disk full/);
    assert.equal(readFileSync(f, 'utf8'), 'old\n');
    assert.deepEqual(readdirSync(d), ['status.json']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L763: a request is read only when it is a plain file with one name, the orchestrate user\'s, and small', () => {
  const d = dir();
  try {
    const f = join(d, 'launch-S-1.json'); writeFileSync(f, '{"launch":{"sessionId":"S-1"}}\n');
    assert.deepEqual(readRequest(f, { orchestrateUid: ME }), { launch: { sessionId: 'S-1' } });
    assert.match(readRequest(f, { orchestrateUid: ME + 1 }).refused, /not the orchestrate user's/);
    linkSync(f, join(d, 'second'));
    assert.match(readRequest(f, { orchestrateUid: ME }).refused, /has 2 names/);
    const s = join(d, 'sym.json'); symlinkSync(join(d, 'second'), s);
    assert.match(readRequest(s, { orchestrateUid: ME }).refused, /is a link/);
    const big = join(d, 'big.json'); writeFileSync(big, `"${'x'.repeat(REQUEST_MAX_BYTES)}"`);
    assert.match(readRequest(big, { orchestrateUid: ME }).refused, /larger than any/);
    // A file too big by its size is never read at all.
    const stBig = { isFile: () => true, nlink: 1, uid: ME, size: REQUEST_MAX_BYTES + 1 };
    assert.match(readRequest(f, { orchestrateUid: ME, fstat: () => stBig, read: () => { throw new Error('must not read'); } }).refused, /larger than any/);
    const open = join(d, 'open.json'); writeFileSync(open, '{}'); chmodSync(open, 0o666);
    assert.match(readRequest(open, { orchestrateUid: ME }).refused, /written by others/);
    chmodSync(open, 0o664); assert.match(readRequest(open, { orchestrateUid: ME }).refused, /written by others/);
    for (const body of ['null', '7', '[]', '"x"', '{"refused":"no"}']) { writeFileSync(join(d, 'v.json'), body); assert.match(readRequest(join(d, 'v.json'), { orchestrateUid: ME }).refused, /not what the Dispatcher writes/, body); }
    const bad = join(d, 'bad.json'); writeFileSync(bad, '{');
    assert.match(readRequest(bad, { orchestrateUid: ME }).refused, /can't be read/);
    assert.match(readRequest(join(d, 'gone.json'), { orchestrateUid: ME }).refused, /can't be opened \(ENOENT\)/);
    assert.match(readRequest(d, { orchestrateUid: ME }).refused, /not a plain file/);
    assert.throws(() => readRequest(f, {}), /uid is not known/);
    // A pipe in a request's place is refused without waiting (run in a child, so a hang fails the test instead of it).
    const fifo = join(d, 'fifo.json');
    assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readRequest } from ${JSON.stringify(new URL('./runner-files.mjs', import.meta.url).href)}; console.log(JSON.stringify(readRequest(${JSON.stringify(fifo)}, { orchestrateUid: ${ME} })));`], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr); assert.match(JSON.parse(r.stdout).refused, /not a plain file/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 2 review m1: a failed rename closes the new file once, never twice, and removes it', () => {
  const d = dir();
  try {
    const f = join(d, 'status.json'); writeStatus(f, 'old\n');
    const closes = [];
    const fs = { openSync, writeSync, fsyncSync: () => {}, unlinkSync, closeSync: (fd) => { closes.push(fd); closeSync(fd); }, renameSync: () => { throw new Error('EXDEV'); } };
    assert.throws(() => writeStatus(f, 'new\n', { fs, tag: () => 't3' }), /EXDEV/);
    assert.equal(closes.length, 1, `closed ${JSON.stringify(closes)}`);
    assert.deepEqual(readdirSync(d), ['status.json']); assert.equal(readFileSync(f, 'utf8'), 'old\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
