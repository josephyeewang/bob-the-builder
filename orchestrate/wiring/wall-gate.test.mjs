// The builder wall's start-of-session gate (L1170 m5, L1193): wall-gate.mjs. Each way the status can fail to confirm the
// wall holds the start; only a fresh, ok status for this uid and these rules, in a file root's all the way up, passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { anchorHash, wallFrom, wallHeld, wallProblem, wallStatusProblem } from './wall-gate.mjs';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { readRootFile } from './runner-main.mjs';

const UID = 403; const NOW = Date.parse('2026-11-14T12:00:00.000Z'); const BEAT = 300_000;
const anchorText = (u) => `pass out quick on lo0 proto { tcp udp } from any to any user ${u} tag ORCH_BUILDER no state\n`;
// Lane A's parseStatus is stood in for by a plain JSON read: its own shape checks (keys, version, one line) are lane A's
// to test; here every value it might let through is judged by the gate itself, so a lax reader is the harder case.
const WALL = { anchorText, beatMs: BEAT, parseStatus: (t) => JSON.parse(t) };
const iso = (ms) => new Date(ms).toISOString();
const status = (o = {}) => ({ v: 1, time: iso(NOW - 60_000), builderUid: UID, anchorSha256: anchorHash(anchorText, UID), ok: true, why: [], ...o });
const text = (o) => JSON.stringify(status(o));
const check = (t, o = {}) => wallStatusProblem(t, { uid: UID, now: NOW, wall: WALL, ...o });
const HELD = /so no session starts until the builder wall is confirmed \(L1170 m5\)$/;

test('L1193: a fresh ok status for this uid and these rules passes', () => {
  assert.equal(check(text()), null);
  assert.equal(check(text({ time: iso(NOW) })), null, 'written this very ms');
  assert.equal(check(text({ time: iso(NOW - 2 * BEAT) })), null, 'exactly two beats old');
  assert.equal(check(text(), { wall: { ...WALL, beatMs: 600_000 } }), null);
  assert.match(check(text({ time: iso(NOW - 2 * BEAT - 1) }), { wall: { ...WALL, beatMs: 120_000 } }) ?? '', /older than two of the wall job's beats \(4 minutes\)/, 'the beat is lane A\'s, never a fixed 10 minutes');
});

test('L1193 plants: each status that does not confirm the wall holds the start, saying why', () => {
  const cases = [
    ['stale (the wall job stopped)', text({ time: iso(NOW - 2 * BEAT - 1) }), /older than two of the wall job's beats \(10 minutes\): the wall job may have stopped/],
    ['days old', text({ time: iso(NOW - 86_400_000) }), /older than two/],
    ['future time', text({ time: iso(NOW + 1) }), /after this runner's clock/],
    ['far future (past pastTime\'s skew)', text({ time: iso(NOW + 3_600_000) }), /no date or is after this runner's clock/],
    ['no such date', text({ time: '2026-13-40T00:00:00.000Z' }), /no date or is after/],
    ['time not a date', text({ time: 'yesterday' }), /no date or is after/],
    ['time as a number', text({ time: NOW }), /names no time/],
    ['no time', JSON.stringify((({ time, ...r }) => r)(status())), /names no time/],
    ['ok false, its reasons', text({ ok: false, why: ['pf is off', 'the token is not held'] }), /last check failed \(pf is off; the token is not held\)/],
    ['ok false: the check could not run', text({ ok: false, why: ['pfctl could not be run (ENOENT)'] }), /last check failed \(pfctl could not be run \(ENOENT\)\)/],
    ['ok false, no reasons', text({ ok: false, why: [] }), /last check failed \(no reason given\)/],
    ['ok "true"', text({ ok: 'true' }), /last check failed/],
    ['ok 1', text({ ok: 1 }), /last check failed/],
    ['no ok', JSON.stringify((({ ok, ...r }) => r)(status())), /last check failed/],
    ['wrong uid', text({ builderUid: 404 }), /for uid 404, not this runner's \(403\)/],
    ['uid as text', text({ builderUid: '403' }), /for uid "403"/],
    ['no uid', JSON.stringify((({ builderUid, ...r }) => r)(status())), /for uid undefined/],
    ['wrong hash', text({ anchorSha256: anchorHash(anchorText, 404) }), /for other rules than this copy's wall/],
    ['hash in capitals', text({ anchorSha256: anchorHash(anchorText, UID).toUpperCase() }), /for other rules/],
    ['hash of other rules', text({ anchorSha256: anchorHash(() => 'set skip on lo0\n', UID) }), /for other rules/],
    ['no hash', JSON.stringify((({ anchorSha256, ...r }) => r)(status())), /for other rules/],
    ['an array', '[]', /reads as nothing/],
    ['null', 'null', /reads as nothing/],
  ];
  for (const [name, t, why] of cases) {
    const p = check(t);
    assert.ok(p, `${name}: must refuse`); assert.match(p, why, name); assert.match(p, HELD, name);
  }
  // Lane A's parseStatus refusing the text (not JSON, a key more or less, another version) holds, with its reason.
  for (const t of ['{"v":1,', '', 'x']) assert.match(check(t), /is not one the wall job writes \(.*JSON/, JSON.stringify(t));
  assert.match(check(text(), { wall: { ...WALL, parseStatus: () => { throw new Error('version 2, not 1'); } } }), /is not one the wall job writes \(version 2, not 1\)/);
  for (const r of [undefined, null, 'ok', 1]) assert.match(check(text(), { wall: { ...WALL, parseStatus: () => r } }), /reads as nothing/, String(r));
  assert.match(check(text(), { now: NaN }), /this runner's clock can't be read/);
  assert.match(check(text(), { wall: { ...WALL, anchorText: () => { throw new Error('uid 0'); } } }), /rules for uid 403 can't be built \(uid 0\)/);
});

// The file's side, on a real folder this test owns: the test's own uid stands for root (chainProblem's and readRootFile's
// owner), as install-check's tests do.
const ME = process.getuid();
const realPorts = (top) => ({ chain: (p) => chainProblem(p, { owner: ME, top, acl: () => null }), readRoot: (p) => readRootFile(p, { uid: ME }) });

test('L1193 plants on a real folder: missing, a link, writable by others (file or folder), and a good file', () => {
  const d = mkdtempSync(join(tmpdir(), 'orch-wall-')); chmodSync(d, 0o755);
  try {
    const dir = join(d, 'builder-wall'); mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755);
    const f = join(dir, 'status.json');
    const go = (o = {}) => wallProblem({ file: f, wall: WALL, uid: UID, now: () => NOW, ...realPorts(d), ...o });
    assert.match(go(), /status file is not root's alone \(.*status\.json is missing\)/, 'missing');
    writeFileSync(f, text(), { mode: 0o644 }); chmodSync(f, 0o644);
    assert.equal(go(), null, 'root\'s own file, folders root\'s: passes');
    chmodSync(f, 0o664); assert.match(go(), /not root's alone \(.*can be written by others/, 'group-writable file'); chmodSync(f, 0o644);
    chmodSync(f, 0o646); assert.match(go(), /not root's alone/, 'world-writable file'); chmodSync(f, 0o644);
    chmodSync(dir, 0o775); assert.match(go(), /not root's alone \(.*builder-wall can be written by others/, 'group-writable folder'); chmodSync(dir, 0o755);
    chmodSync(d, 0o757); assert.match(go(), /not root's alone/, 'a folder higher up writable by others'); chmodSync(d, 0o755);
    const other = join(dir, 'real.json'); writeFileSync(other, text(), { mode: 0o644 });
    rmSync(f); symlinkSync(other, f);
    assert.match(go(), /not root's alone \(.*is a link/, 'a link');
    assert.match(go({ chain: () => null }), /can't be read/, 'a link opened anyway is refused by O_NOFOLLOW');
    rmSync(f); writeFileSync(f, text({ ok: false, why: ['the builder reached the owner\'s listener'] }), { mode: 0o644 });
    assert.match(go(), /last check failed \(the builder reached the owner's listener\)/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1193: a status file not owned by root, or an owner check that throws, holds the start', () => {
  const base = { file: '/b/builder-wall/status.json', wall: WALL, uid: UID, now: () => NOW, readRoot: () => text() };
  assert.match(wallProblem({ ...base, chain: (p) => chainProblem(p, { lstat: () => ({ isSymbolicLink: () => false, uid: 501, mode: 0o40755 }), acl: () => null }) }), /not root's alone \(\/b\/builder-wall\/status\.json is not owned by root\)/);
  assert.match(wallProblem({ ...base, chain: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), /not root's alone \(it can't be checked \(EACCES\)\)/);
  assert.match(wallProblem({ ...base, chain: () => null, readRoot: () => { throw new Error('/b/builder-wall/status.json is not root\'s own plain file'); } }), /can't be read \(.*not root's own plain file\)/);
  assert.match(wallProblem({ ...base, chain: () => null, readRoot: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), /can't be read \(it is not there\)/);
  assert.match(wallProblem({ ...base, chain: () => null, now: () => { throw new Error('clock'); } }), /clock can't be read/);
  assert.equal(wallProblem({ ...base, chain: () => null }), null);
});

test('L1193: the wall\'s code not loaded, no status file in the config, or no uid holds every start', () => {
  const base = { file: '/b/s.json', wall: WALL, uid: UID, now: () => NOW, chain: () => null, readRoot: () => text() };
  const P = WALL.parseStatus;
  for (const wall of [null, undefined, {}, { anchorText, parseStatus: P }, { anchorText, beatMs: BEAT }, { parseStatus: P, beatMs: BEAT }, { anchorText, parseStatus: P, beatMs: 0 }, { anchorText, parseStatus: P, beatMs: 1.5 }, { anchorText: 'x', parseStatus: P, beatMs: BEAT }, { anchorText, parseStatus: 'x', beatMs: BEAT }]) {
    assert.match(wallProblem({ ...base, wall, wallWhy: 'Cannot find module' }), /code can't be loaded from the installed copy/, JSON.stringify(wall));
  }
  assert.match(wallProblem({ ...base, wall: null, wallWhy: 'Cannot find module builder-wall.mjs' }), /\(Cannot find module builder-wall\.mjs\)/);
  for (const file of [undefined, null, '', 'rel/s.json', 5]) assert.match(wallProblem({ ...base, file }), /names no builder wall status file \(wallStatus\)/, String(file));
  for (const uid of [0, -1, undefined, 1.5, '403']) assert.match(wallProblem({ ...base, uid }), /uid can't be read/, String(uid));
  let read = false;
  wallProblem({ ...base, file: undefined, readRoot: () => { read = true; return text(); } });
  assert.equal(read, false, 'nothing is read when there is nothing to check against');
});

test('L1193: wallFrom takes lane A\'s anchorText, parseStatus and beat, refusing a module without them', () => {
  const parseStatus = WALL.parseStatus;
  assert.deepEqual(wallFrom({ anchorText, parseStatus, RECHECK_EVERY_S: 300 }), { anchorText, parseStatus, beatMs: 300_000 });
  for (const m of [null, {}, { anchorText, parseStatus }, { anchorText, RECHECK_EVERY_S: 300 }, { parseStatus, RECHECK_EVERY_S: 300 }, { anchorText, parseStatus, RECHECK_EVERY_S: '300' }, { anchorText, parseStatus, RECHECK_EVERY_S: 0 }]) assert.throws(() => wallFrom(m), /exports no/);
});

test('L1193: wallHeld asks the gate first, every time; the rest only when the wall is confirmed; a gate that throws holds', () => {
  let why = 'the wall is down'; const asked = [];
  const held = wallHeld(() => why, (p) => { asked.push(p); return null; });
  assert.equal(held('p1'), 'the wall is down'); assert.deepEqual(asked, []);
  why = null; assert.equal(held('p1'), null); assert.deepEqual(asked, ['p1']);
  why = 'down again'; assert.equal(held('p1'), 'down again', 'asked again at the next start, not remembered');
  assert.match(wallHeld(() => { throw new Error('boom'); }, () => null)('p1'), /can't be checked \(boom\), so no session starts/);
  assert.equal(wallHeld(() => null, () => 'snapshot stale')('p1'), 'snapshot stale');
});
