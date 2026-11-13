// Part C, runner step 5: the worker runner's real ports. The start runs on fakes for what other lanes still owe (the
// worker checks, the prompt) and on real files for what it makes; spawnLeader runs a real process group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { workerPrompt } from '../modules/M5-review-audit/worker-prompt.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { gitOk, initMirror } from '../modules/M4-workshop/git/safe-git.mjs';
import { launch } from '../modules/M4-workshop/launcher/launch.mjs';
import { INTAKE_DONE, chmodTree, removeAll, cardStartCommit, undoCommitProblem, drainedPort, groupThere, pauseLeadPort, liveWallProblem, productWallGap, projectFolderName, saveWorkPort, sizePort, spawnLeader, startPort, transcriptPath, workerPromptText } from './runner-ports.mjs';
import { walledLaunchSettings } from './runner-launch.mjs';
import { leaderStart } from './runner-loop.mjs';
import { FLAGS, namesIn } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { sessionArgs } from '../modules/M4-workshop/launcher/review-launch.mjs';
import { USED_STATES } from '../modules/M11-dispatcher/intake-facts.mjs';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HEAD = 'b'.repeat(40);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };

test('step 5: size reads the session\'s conversation file and its last write; a missing or linked file is a throw', () => {
  const d = tempDir('orch-rports-');
  try {
    const s = { id: SID, config_dir: join(d, 'cfg'), copy: '/copies/C-1' };
    assert.equal(projectFolderName('/copies/C-1'), '-copies-C-1');
    assert.equal(projectFolderName('/copies/a.b_c d'), '-copies-a-b-c-d', 'every character but a letter or digit');
    const f = transcriptPath({ configDir: s.config_dir, copy: s.copy, sessionId: SID });
    assert.equal(f, join(d, 'cfg', 'projects', '-copies-C-1', `${SID}.jsonl`));
    const size = sizePort();
    assert.throws(() => size(s), /ENOENT/);
    mkdirSync(join(d, 'cfg', 'projects', '-copies-C-1'), { recursive: true });
    const line = { type: 'assistant', timestamp: '2026-11-10T12:00:00Z', message: { stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 5 }, content: [] } };
    writeFileSync(f, `${JSON.stringify(line)}\n`);
    const z = size(s);
    assert.equal(z.size.tokens, 15); assert.equal(z.size.turnEnded, true); assert.equal(z.lastWriteAt, statSync(f).mtimeMs);
    assert.equal('activity' in z, false, 'no activity state is made up: the tracker is not fed in the runner');
    rmSync(f); writeFileSync(join(d, 'other'), `${JSON.stringify(line)}\n`); symlinkSync(join(d, 'other'), f);
    assert.throws(() => size(s), /not a plain file/);
    assert.throws(() => sizePort({ read: () => null })({ ...s, id: SID }), /not a plain file|can't be read/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L835: an outbox is drained once every file in it has the Record\'s done intake fact with its sha256, or it is empty or gone', () => {
  const d = tempDir('orch-rports-');
  try {
    const o = join(d, 'worker', SID); mkdirSync(o, { recursive: true });
    const s = { id: SID, role: 'worker', card: 'C-1', outbox: o };
    const facts = new Map();
    const readFact = (id) => (facts.has(id) ? { ok: true, doc: facts.get(id) } : { ok: false, missing: true, reason: 'no such fact' });
    const fact = (name, over = {}) => facts.set(`intake-applied-${SID}-${name}`, { session: SID, name, state: 'applied', sha256: createHash('sha256').update(readFileSync(join(o, name))).digest('hex'), ...over });
    const drained = drainedPort({ readFact });
    const held = (cause) => ({ drained: false, cause });
    assert.equal(drained(s), true, 'empty: nothing to take');
    // The one set of used states (L852): a file lead-restart counts as used, and only those, counts as taken here.
    assert.equal(INTAKE_DONE, USED_STATES, 'lane 2\'s one list (intake-facts.mjs), not a copy');
    writeFileSync(join(o, 'report-C-1.md'), '{"a":1}');
    assert.deepEqual(drained(s), held('not-taken'), 'a file the Record has no fact for');
    fact('report-C-1.md');
    assert.equal(drained(s), true, 'the file is kept (push reads it), and the Record took it');
    writeFileSync(join(o, '.half'), 'x');
    assert.deepEqual(drained(s), held('dot-name'), 'a dot file with no fact counts');
    rmSync(join(o, '.half'));
    for (const state of ['refused', 'interrupted', 'waiting']) { fact('report-C-1.md', { state }); assert.equal(drained(s), true, state); }
    // #388 r1 m2: waiting is done only for a worker or script; a Lead's queued request or plan starts later.
    fact('report-C-1.md', { state: 'waiting' });
    assert.equal(drained({ ...s, role: 'script' }), true, 'a script\'s waiting');
    for (const role of ['lead', undefined, 'reviewer']) assert.deepEqual(drained({ ...s, role }), held('in-flight'), `waiting is not done for ${role}`);
    // #388 r1 m3: the fact is read first; a file whose fact is not done is never hashed.
    const hashed = [];
    const counting = drainedPort({ readFact, hashOf: (p) => { hashed.push(p); return 'x'; } });
    for (const [state, why] of [['applying', 'in-flight'], ['starting', 'in-flight'], ['told', 'other']]) { fact('report-C-1.md', { state }); assert.deepEqual(counting(s), held(why), state); }
    const kept = new Map(facts); facts.clear(); assert.deepEqual(counting(s), held('not-taken'), 'no fact');
    for (const [k, v] of kept) facts.set(k, v);
    assert.deepEqual(hashed, [], 'nothing hashed until its fact is done');
    for (const [state, why] of [['applying', 'in-flight'], ['starting', 'in-flight'], ['told', 'other'], [undefined, 'other']]) { fact('report-C-1.md', { state }); assert.deepEqual(drained(s), held(why), `not done: ${state}`); }
    fact('report-C-1.md', { sha256: 'f'.repeat(64) }); assert.deepEqual(drained(s), held('hash-mismatch'), 'another sha256: the file changed after intake took it');
    fact('report-C-1.md', { session: 'other' }); assert.deepEqual(drained(s), held('other'), 'a fact naming another session');
    fact('report-C-1.md', { name: 'x.json' }); assert.deepEqual(drained(s), held('other'), 'a fact naming another file');
    fact('report-C-1.md');
    assert.deepEqual(drainedPort({ readFact: () => ({ ok: false, reason: 'its file is not JSON' }) })(s), held('record-unreadable'), 'an unreadable fact');
    fact('report-C-1.md');
    assert.deepEqual(drainedPort({ readFact: (id) => ({ ...readFact(id), ok: false }) })(s), held('record-unreadable'), 'a doc beside ok:false is not trusted (#388 r1 c1)');
    assert.equal(drainedPort({ readFact })(s), true, 'the same doc with ok:true drains');
    assert.deepEqual(drainedPort({ readFact: () => { throw new Error('EACCES'); } })(s), held('record-unreadable'), 'a Record that throws');
    assert.deepEqual(drainedPort()(s), held('record-unreadable'), 'no fact reader wired: an outbox holding a file stays open');
    symlinkSync(join(o, 'report-C-1.md'), join(o, 'handin-C-1.md')); fact('report-C-1.md');
    facts.set(`intake-applied-${SID}-handin-C-1.md`, { ...facts.get(`intake-applied-${SID}-report-C-1.md`), name: 'handin-C-1.md' });
    assert.deepEqual(drained(s), held('not-a-plain-file'), 'a link is not a plain file');
    rmSync(join(o, 'handin-C-1.md')); facts.delete(`intake-applied-${SID}-handin-C-1.md`);
    assert.equal(drained(s), true);
    // A named pipe opens without following a link, and reads as no bytes: not a plain file, never matched to a fact.
    spawnSync('mkfifo', [join(o, 'pipe')]);
    facts.set(`intake-applied-${SID}-pipe`, { ...facts.get(`intake-applied-${SID}-report-C-1.md`), name: 'pipe', sha256: createHash('sha256').update('').digest('hex') });
    assert.deepEqual(drained(s), held('not-a-plain-file'), 'a pipe is not a plain file');
    rmSync(o, { recursive: true });
    assert.equal(drained(s), true, 'gone: nothing left to take');
    assert.deepEqual(drainedPort({ list: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); }, readFact })(s), held('outbox-unreadable'), 'the outbox folder itself can\'t be listed (#425 r1 c1)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L898: the card\'s bundle counts as taken once the push of this session\'s attempt is pushed with its bytes\' sha256', () => {
  const d = tempDir('orch-lane4-bundle-');
  try {
    const o = join(d, 'worker', SID); mkdirSync(o, { recursive: true });
    const s = { id: SID, role: 'worker', card: 'C-1', outbox: o };
    writeFileSync(join(o, 'report-C-1.md'), '# done\n');
    writeFileSync(join(o, 'bundle-C-1.bundle'), Buffer.from([0x23, 0x20, 0xff, 0x00, 0x80, 0x0a]));
    const sha = (f) => createHash('sha256').update(readFileSync(join(o, f))).digest('hex');
    const facts = new Map([[`intake-applied-${SID}-report-C-1.md`, { session: SID, name: 'report-C-1.md', state: 'applied', sha256: sha('report-C-1.md') }],
      ['push.C-1.a1', { result: 'pushed', branch: 'card/c-1', tip: 'f'.repeat(40), bundle_sha256: sha('bundle-C-1.bundle') }]]);
    const readFact = (id) => (facts.has(id) ? { ok: true, doc: facts.get(id) } : { ok: false, missing: true, reason: 'no such fact' });
    let sdoc = { card: 'C-1', attempt: 'a1' };
    const readSession = (id) => (id === SID && sdoc ? { ok: true, doc: sdoc } : { ok: false, missing: true });
    const drained = drainedPort({ readFact, readSession });
    const held = (cause) => ({ drained: false, cause });
    assert.equal(drained(s), true, 'a real binary bundle beside an applied report drains');
    // Fails closed: each condition alone.
    assert.deepEqual(drainedPort({ readFact })(s), held('record-unreadable'), 'no session reader wired');
    assert.deepEqual(drainedPort({ readFact, readSession: () => { throw new Error('EIO'); } })(s), held('record-unreadable'), 'a session reader that throws');
    assert.deepEqual(drainedPort({ readFact, readSession: () => ({ ok: false, doc: sdoc }) })(s), held('record-unreadable'), 'a doc beside ok:false');
    for (const v of [null, {}, { card: 'C-1' }, { card: 'C-1', attempt: '' }, { card: 'C-1', attempt: 1 }, { card: 'C-2', attempt: 'a1' }]) {
      sdoc = v; assert.deepEqual(drained(s), held('bundle-no-attempt'), `session doc ${JSON.stringify(v)}`);
    }
    sdoc = { card: 'C-1', attempt: 'a2' }; assert.deepEqual(drained(s), held('bundle-not-pushed'), 'no push fact for this attempt');
    sdoc = { card: 'C-1', attempt: 'a1' };
    const push = facts.get('push.C-1.a1');
    for (const [v, why] of [[{ ...push, result: 'refused' }, 'bundle-not-pushed'], [{ ...push, head_refused: 'the card head could not be noted' }, 'bundle-not-pushed'], [{ ...push, bundle_sha256: undefined }, 'bundle-not-pushed'], [{ ...push, bundle_sha256: 'F'.repeat(64) }, 'bundle-not-pushed'], [{ ...push, bundle_sha256: 'f'.repeat(64) }, 'bundle-changed']]) {
      facts.set('push.C-1.a1', v); assert.deepEqual(drained(s), held(why), JSON.stringify(v));
    }
    facts.set('push.C-1.a1', push);
    assert.deepEqual(drainedPort({ readFact: (id) => (id === 'push.C-1.a1' ? { ok: false, doc: push } : readFact(id)), readSession })(s), held('record-unreadable'), 'a push doc beside ok:false');
    assert.deepEqual(drainedPort({ readFact: (id) => { if (id === 'push.C-1.a1') throw new Error('EIO'); return readFact(id); }, readSession })(s), held('record-unreadable'), 'a push read that throws');
    assert.equal(drained(s), true);
    writeFileSync(join(o, 'bundle-C-1.bundle'), 'other bytes'); assert.deepEqual(drained(s), held('bundle-changed'), 'the bundle changed after its push');
    rmSync(join(o, 'bundle-C-1.bundle')); symlinkSync(join(o, 'report-C-1.md'), join(o, 'bundle-C-1.bundle'));
    facts.set('push.C-1.a1', { ...push, bundle_sha256: sha('report-C-1.md') });
    assert.deepEqual(drained(s), held('not-a-plain-file'), 'a link is not the bundle');
    rmSync(join(o, 'bundle-C-1.bundle'));
    // Another card's bundle name is not this session's: it is an intake file like any other, never taken.
    writeFileSync(join(o, 'bundle-C-2.bundle'), 'x');
    assert.deepEqual(drained(s), held('not-taken'), 'another card\'s bundle');
    assert.deepEqual(drained({ ...s, card: undefined }), held('not-taken'), 'no card: no bundle is this session\'s');
    // #388 r2 m1: only a worker's or script's session carries the card's bundle; another role's is an intake file, never taken.
    rmSync(join(o, 'bundle-C-2.bundle'));
    writeFileSync(join(o, 'bundle-C-1.bundle'), Buffer.from([0x23, 0x20, 0xff, 0x00, 0x80, 0x0a])); facts.set('push.C-1.a1', push);
    assert.equal(drained(s), true, 'the worker\'s bundle, as pushed');
    assert.equal(drained({ ...s, role: 'script' }), true, 'a script\'s');
    for (const role of ['lead', 'reviewer', undefined]) assert.deepEqual(drained({ ...s, role }), held('not-taken'), `a ${role} session's bundle`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L896: an undrained outbox names its cause, one of the one list, checking the name before the Record or the bytes', () => {
  const d = tempDir('orch-lane4-drain-');
  try {
    const o = join(d, 'worker', SID); mkdirSync(o, { recursive: true });
    const s = { id: SID, role: 'worker', card: 'C-1', outbox: o };
    const held = (cause) => ({ drained: false, cause });
    const asked = [];
    const hashed = [];
    const only = (names, cause, why) => {
      asked.length = 0; hashed.length = 0;
      assert.deepEqual(drainedPort({ list: () => names, readFact: (id) => { asked.push(id); return { ok: false, missing: true }; }, hashOf: (q) => { hashed.push(q); return 'h'; } })(s), held(cause), why);
    };
    // The Record's fact id holds at most 200 of [A-Za-z0-9._-] (M4 readFactFile): the id with its prefix and session.
    const room = 200 - `intake-applied-${SID}-`.length;
    only(['a'.repeat(room + 1)], 'fact-id-too-long', 'one over');
    assert.deepEqual([asked.length, hashed.length], [0, 0], 'told by its name: the Record is not asked, the file never read');
    only(['a'.repeat(room)], 'not-taken', 'at the limit is a name the Record can hold');
    only(['bad�name'], 'name-not-utf8', 'a name not valid UTF-8 reads with the replacement mark');
    only([`bad�${'a'.repeat(room)}`], 'name-not-utf8', 'not UTF-8 is told before too long');
    for (const n of ['a b', 'a/b', 'é', 'x:y']) only([n], 'name-not-a-fact-id', JSON.stringify(n));
    only(['.dot'], 'dot-name');
    only(['ok.json', '.dot'], 'not-taken', 'the first file that holds it open is the one told');
    // A fact done with the file, so its bytes are read: a folder is not a plain file, an unreadable one is told so.
    const done = (name) => ({ ok: true, doc: { session: SID, name, state: 'applied', sha256: 'h' } });
    mkdirSync(join(o, 'sub'));
    assert.deepEqual(drainedPort({ readFact: () => done('sub') })(s), held('not-a-plain-file'), 'a folder');
    rmSync(join(o, 'sub'), { recursive: true });
    writeFileSync(join(o, 'f.json'), 'x');
    assert.deepEqual(drainedPort({ readFact: () => done('f.json'), hashOf: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })(s), held('file-unreadable'));
    assert.deepEqual(drainedPort({ readFact: () => done('f.json'), hashOf: () => { throw Object.assign(new Error('loop'), { code: 'ELOOP' }); } })(s), held('not-a-plain-file'));
    for (const v of [null, undefined, { ok: false }, { ok: false, missing: false }]) assert.deepEqual(drainedPort({ readFact: () => v })(s), held('record-unreadable'), JSON.stringify(v));
    assert.deepEqual(drainedPort({ readFact: () => ({ ok: true, doc: null }) })(s), held('other'));
    // The bundle's causes are its own (L898): the push read before its bytes, as for any file.
    rmSync(join(o, 'f.json'));
    writeFileSync(join(o, 'bundle-C-1.bundle'), 'b');
    const readSession = () => ({ ok: true, doc: { card: 'C-1', attempt: 'a1' } });
    const pushed = (doc) => () => ({ ok: true, doc });
    hashed.length = 0;
    assert.deepEqual(drainedPort({ readSession, readFact: pushed({ result: 'refused' }), hashOf: (q) => { hashed.push(q); return 'h'; } })(s), held('bundle-not-pushed'));
    assert.deepEqual(hashed, [], 'a bundle no push took is never read');
    assert.deepEqual(drainedPort({ readSession, readFact: pushed({ result: 'pushed', bundle_sha256: 'e'.repeat(64) }) })(s), held('bundle-changed'));
    assert.deepEqual(drainedPort({ readSession, readFact: () => ({ ok: false, missing: true }) })(s), held('bundle-not-pushed'));
    assert.deepEqual(drainedPort({ readSession, readFact: () => ({ ok: false }) })(s), held('record-unreadable'));
    assert.deepEqual(drainedPort({ readSession: () => ({ ok: true, doc: { card: 'C-9', attempt: 'a1' } }), readFact: pushed({ result: 'pushed' }) })(s), held('bundle-no-attempt'), 'a session doc naming another card');
    assert.deepEqual(drainedPort({ readSession: () => ({ ok: false }), readFact: pushed({ result: 'pushed' }) })(s), held('record-unreadable'), 'a session doc not read, not missing');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 5: save-work refuses without the lock-down runner, and the pause is not wired', async () => {
  const SHA = 'a'.repeat(64);
  const s = { product: 'p1', copy: '/copies/C-1', card: 'C-1', outbox: `/o/worker/${SID}`, save_settings_sha: SHA };
  assert.match((await saveWorkPort({ mirrorOf: () => '/m' })(s)).reason, /only inside the worker's lock-down/);
  assert.match((await saveWorkPort({ mirrorOf: () => null })(s)).reason, /no mirror/);
  const seen = [];
  await saveWorkPort({ mirrorOf: () => '/m', make: () => async (x) => { seen.push(x); return { ok: true }; } })(s);
  assert.deepEqual(seen, [{ clone: '/copies/C-1', mirror: '/m', card: 'C-1', branch: 'card/c-1', outbox: `/o/worker/${SID}` }]);
  // L969, L991 M1, #463 r1 m3: runLocked is bound to the session: its id, role, its save-phase settings file by the hash
  // its row keeps, in the copy's .git; and (m2) the runner's onGroup is passed through.
  const jobs = [];
  let given;
  // #463 r2 m3: the copy's .git is checked (a real folder, the runner's own) and run in by its real path.
  const me = process.getuid(); let st = { isDirectory: () => true, isSymbolicLink: () => false, uid: me };
  const port = saveWorkPort({ mirrorOf: () => '/m', settingsDir: '/st', runLocked: async (j) => { jobs.push(j); return { ok: true }; },
    lstat: (f) => { assert.equal(f, '/copies/C-1/.git'); return st; }, realpath: (f) => `/real${f}`,
    make: ({ runLocked }) => { given = runLocked; return async (x) => runLocked({ job: 'save-work', args: x }); } });
  const onGroup = () => {};
  await port({ ...s, id: SID, kind: 'editing' }, { onGroup });
  assert.equal(typeof given, 'function');
  assert.deepEqual(jobs, [{ job: 'save-work', args: seen[0], sessionId: SID, role: 'worker', settingsFile: `/st/${SID}.save.json`, settingsSha: SHA, cwd: '/real/copies/C-1/.git', onGroup }]);
  // A row with no save settings' hash, or one in another form, is refused before any job.
  for (const bad of [undefined, 'A'.repeat(64), 'a'.repeat(40)]) {
    const r = await port({ ...s, id: SID, kind: 'editing', save_settings_sha: bad });
    assert.match(r.reason, /has no save settings kept by its start/, String(bad));
  }
  assert.equal(jobs.length, 1);
  for (const [bad, why] of [[{ isDirectory: () => false, isSymbolicLink: () => true, uid: me }, /not a real folder/], [{ isDirectory: () => true, isSymbolicLink: () => false, uid: me + 1 }, /not the runner's own/]]) {
    st = bad;
    await assert.rejects(port({ ...s, id: SID, kind: 'editing' }), why);
  }
  assert.equal(jobs.length, 1, 'no job run in a .git that is a link or another user\'s');
  // A real link, read by the real lstat: refused.
  const d = tempDir('orch-');
  try {
    mkdirSync(join(d, 'elsewhere')); mkdirSync(join(d, 'c')); symlinkSync(join(d, 'elsewhere'), join(d, 'c', '.git'));
    const real = saveWorkPort({ mirrorOf: () => '/m', settingsDir: '/st', runLocked: async (j) => { jobs.push(j); return { ok: true }; }, make: ({ runLocked }) => async (x) => runLocked({ job: 'save-work', args: x }) });
    await assert.rejects(real({ ...s, copy: join(d, 'c'), id: SID, kind: 'editing' }), /not a real folder/);
    assert.equal(jobs.length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
  const p = await pauseLeadPort()({ product: 'p1' });
  assert.equal(p.ok, false); assert.match(p.reason, /^not wired: /);
});

test('step 5: spawnLeader starts its own process group with a start time; one whose start time can\'t be read is killed', async () => {
  const a = await spawnLeader({ spawn, bin: '/bin/sleep', args: ['30'], cwd: '/', env: { PATH: '/usr/bin:/bin' } });
  try {
    assert.equal(a.ok, true, a.reason);
    assert.equal(a.pgid, a.pid);
    const pg = Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(a.pid)]).stdout.toString().trim());
    assert.equal(pg, a.pid, 'claude leads its own group');
    assert.equal(typeof a.pidStart, 'string'); assert.ok(a.pidStart);
    assert.equal(a.pidStart, leaderStart(a.pid), 'read by the runner\'s one reader, the one the stop checks against');
  } finally { try { process.kill(-a.pid, 'SIGKILL'); } catch { /* gone */ } }
  let child;
  const b = await spawnLeader({ spawn: (...x) => (child = spawn(...x)), bin: '/bin/sleep', args: ['30'], cwd: '/', env: { PATH: '/usr/bin:/bin' }, pidStartOf: () => null });
  assert.equal(b.ok, false); assert.match(b.reason, /start time could not be read, so its group was killed/);
  assert.ok(await until(() => !alive(child.pid)), 'the group is gone');
  const c = await spawnLeader({ spawn, bin: '/nonexistent/claude', args: [], cwd: '/', env: {} });
  assert.equal(c.ok, false);
});

// The start's world: real folders, fakes for the Record, the copy and the launch.
function world(over = {}) {
  // Real path: the wall check refuses a session folder reached through a link, and the temp folder is under /var (the link card).
  const d = realpathSync(tempDir('orch-rports-'));
  const w = { d, copiesRoot: join(d, 'copies'), outboxRoot: join(d, 'outboxes'), settingsDir: join(d, 'runner', 'settings'), calls: [] };
  // As setup makes them (L836): a copies folder and an outbox folder per product, and the role folders in it.
  w.mine = { copies: join(w.copiesRoot, 'p1'), outboxes: join(w.outboxRoot, 'p1') };
  for (const f of [w.mine.copies, join(w.mine.outboxes, 'worker'), join(w.mine.outboxes, 'script'), w.settingsDir]) mkdirSync(f, { recursive: true });
  mkdirSync(join(w.mine.copies, 'C-9'));
  w.c = { copiesRoot: w.copiesRoot, outboxRoot: w.outboxRoot, settingsDir: w.settingsDir, home: join(d, 'home'), path: '/usr/bin:/bin', claudeBin: '/bin/sleep',
    workerRunner: { requestsDir: join(d, 'requests'), statusFile: join(d, 'runner', 'status.json') },
    products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: { hooksDir: '/h', deny: { secrets: ['/s'] } }, product: { hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: ['/prop'] } } } };
  w.card = { state: 'claimed', claim: { session_id: SID }, product: 'p1' };
  w.deps = {
    readCard: () => ({ ok: true, doc: w.card }),
    startCommit: async () => HEAD,
    mainOf: async () => 'c'.repeat(40),
    prepare: async (x) => { w.calls.push(['prepare', x]); mkdirSync(x.dest); return { ok: true, dest: x.dest, head: HEAD }; },
    promptFor: () => 'do the card',
    account: () => ({ account: 'a', dir: join(d, 'home', '.claude'), env: {} }),
    walled: (x) => { w.calls.push(['walled', x]); return { ok: true, role: 'worker', settings: { s: 1 } }; },
    launchFn: async (x) => { w.calls.push(['launch', x]); return { ok: true, started: await x.start() }; },
    spawn: (bin, args, o) => { w.calls.push(['spawn', bin, args, o]); return { pid: 4242, once: (ev, fn) => { if (ev === 'spawn') fn(); }, unref: () => {} }; },
    pidStartOf: () => 'Tue Nov 10 12:00:00 2026',
    ...over,
  };
  w.start = (x = {}) => startPort(w.c, w.deps)({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: SID, ...x });
  w.left = () => ({ copy: existsSync(join(w.mine.copies, 'C-1')), outbox: existsSync(join(w.mine.outboxes, 'worker', SID)), settings: existsSync(join(w.settingsDir, `${SID}.json`)) });
  return w;
}

test('step 5: a start makes the copy, the outbox and the walled settings, and answers what the status lists', async () => {
  const w = world();
  try {
    const a = await w.start();
    assert.deepEqual(a, { ok: true, pid: 4242, pgid: 4242, pidStart: 'Tue Nov 10 12:00:00 2026', head: HEAD, base: HEAD, outbox: join(w.mine.outboxes, 'worker', SID),
      signin: 'a', configDir: join(w.d, 'home', '.claude'), copy: join(w.mine.copies, 'C-1'), saveSettingsSha: a.saveSettingsSha });
    // L991 M1, #463 r1 m3: the save's settings, rendered in the save phase, written new beside the session's, and their hash answered.
    const sf = join(w.settingsDir, `${SID}.save.json`);
    assert.equal(a.saveSettingsSha, createHash('sha256').update(readFileSync(sf)).digest('hex'));
    assert.equal(statSync(sf).mode & 0o777, 0o600);
    const walls = w.calls.filter((c) => c[0] === 'walled').map((c) => c[1]);
    assert.deepEqual(walls.map((x) => x.phase), [undefined, 'save']);
    assert.deepEqual(walls[1].paths, walls[0].paths, 'the session\'s very walls');
    const prep = w.calls.find((c) => c[0] === 'prepare')[1];
    assert.deepEqual(prep.card, { id: 'C-1', repo: 'o/p1', commit: HEAD, branch: 'card/c-1' });
    const wl = w.calls.find((c) => c[0] === 'walled')[1];
    assert.equal(wl.kind, 'editing'); assert.deepEqual(wl.workerRunner, w.c.workerRunner);
    assert.equal(wl.paths.copy, join(w.mine.copies, 'C-1')); assert.equal(wl.paths.outbox, join(w.mine.outboxes, 'worker', SID));
    assert.deepEqual(wl.paths.deny, { secrets: ['/s'], otherCopies: [join(w.mine.copies, 'C-9'), join(w.mine.copies, `C-1..baseline-${SID}`)] }, 'every other card\'s copy of this product is denied, and the baseline\'s throwaway place');
    const f = join(w.settingsDir, `${SID}.json`);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { s: 1 });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.mine.outboxes, 'worker', SID)).mode & 0o077, 0);
    const sp = w.calls.find((c) => c[0] === 'spawn');
    assert.equal(sp[1], '/bin/sleep'); assert.equal(sp[3].cwd, join(w.mine.copies, 'C-1')); assert.equal(sp[3].detached, true);
    assert.ok(sp[2].includes(f) && sp[2].includes(SID) && sp[2].at(-1) === 'do the card');
    assert.equal(sp[3].env.HOME, w.c.home); assert.equal(sp[3].env.PATH, '/usr/bin:/bin');
    // Launch check 0 is given the very flags claude is started with (#364 self-review m5).
    const ln = w.calls.find((c) => c[0] === 'launch')[1];
    assert.deepEqual(ln.names.flags, sp[2].filter((x) => x.startsWith('--')));
    assert.deepEqual(ln.names.flags, sessionArgs({ profile: ln.profile, settingsFile: f, sessionId: SID, prompt: 'p' }).filter((x) => x.startsWith('--')));
    // A second start for the same card, claimed by that second session, is refused by the copy already there, and
    // leaves the first one's copy, outbox and settings alone (#364 self-review M3).
    const SID2 = SID.replace('0f', '1f');
    w.card.claim.session_id = SID2;
    const b = await startPort(w.c, { ...w.deps, prepare: (x) => import('../modules/M4-workshop/launcher/worker-copy.mjs').then((m) => m.prepareWorkerCopy(x)) })({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: SID2 });
    assert.equal(b.ok, false); assert.match(b.reason, /already exists/);
    assert.deepEqual(w.left(), { copy: true, outbox: true, settings: true });
    assert.equal(existsSync(join(w.mine.outboxes, 'worker', SID2)), false);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

// L970: the default promptFor is the worker prompt builder. It is asked once the copy and the outbox exist (#463 moves
// the call), with the copy's head and the outbox, so a full card's start gets the worker's prompt; a card it can't make
// one for is refused with the builder's reason, and the copy and outbox it made are taken away again.
test('L970: the default promptFor is the worker prompt builder, asked with the head and the outbox, its reason told when it gives none', async () => {
  const b = { goal: 'Add search.', done_when: 'The test passes.', files: ['src/s.js'], not_in_scope: 'The store.' };
  const w = world();
  try {
    delete w.deps.promptFor;
    let read = 0;   // only the prompt builder reads the brief, so this counts that the default asked it
    w.card = { ...w.card, kind: 'ordinary', tier: 2, get brief() { read += 1; return b; } };
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    assert.ok(read >= 1, 'the default promptFor is the worker prompt builder');
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  // A card with no brief: no prompt, the builder's reason said, nothing left.
  const v = world();
  try {
    delete v.deps.promptFor;
    v.card = { ...v.card, kind: 'ordinary', tier: 2, brief: undefined };
    const a = await v.start();
    assert.equal(a.ok, false); assert.match(a.reason, /^not wired: no worker prompt is given to the runner \(no worker prompt: /);
    assert.deepEqual(v.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(v.d, { recursive: true, force: true }); }
  // The port's own default: no head, no prompt and the reason; with the head and outbox, the worker's.
  const asked = { role: 'worker', kind: 'editing', card: 'C-1', cardDoc: { ...w.card, brief: b }, product: 'p1' };
  assert.deepEqual(workerPromptText(asked), { ok: false, reason: workerPrompt(asked).reason });
  assert.match(workerPrompt(asked).reason, /no head given/);
  const full = { ...asked, head: HEAD, outbox: '/o/p1/worker/S-1' };
  // The same prompt but for its random heading tag (L1006 m-A), which is new each time.
  const untag = (t) => t.replace(/\[[0-9a-f]{24}\]/g, '[tag]');
  assert.equal(untag(workerPromptText(full)), untag(workerPrompt(full).text));
  assert.match(workerPromptText(full), /^You are a worker\./);
});

test('step 5: a script card gets the script outbox', async () => {
  const w = world();
  try {
    const a = await w.start({ kind: 'script' });
    assert.equal(a.ok, true, a.reason); assert.equal(a.outbox, join(w.mine.outboxes, 'script', SID));
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

// L970: lane 1's prompt builder needs the copy's head and the session's outbox, so it is asked once both exist.
test('L970: the prompt is asked for with the copy\'s head and the outbox, once both are made', async () => {
  const asked = [];
  const w = world({ promptFor: async (q) => { asked.push({ ...q, copyThere: existsSync(join(w.mine.copies, 'C-1')), outboxThere: existsSync(q.outbox) }); return 'do the card'; } });
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0].head, asked[0].outbox, asked[0].copyThere, asked[0].outboxThere, asked[0].card, asked[0].role, asked[0].kind, asked[0].product],
      [HEAD, join(w.mine.outboxes, 'worker', SID), true, true, 'C-1', 'worker', 'editing', 'p1']);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('step 5: a start refused before the copy makes nothing; one refused after it removes what it made', async () => {
  const cases = [
    ['a card claimed by another session', { readCard: () => ({ ok: true, doc: { state: 'claimed', claim: { session_id: 'x' } } }) }, /not claimed for this session/],
    ['a card not in the Record', { readCard: () => ({ ok: false, reason: 'no such card' }) }, /no such card/],
    ['another product\'s card', { readCard: () => ({ ok: true, doc: { state: 'claimed', claim: { session_id: SID }, product: 'p2' } }) }, /another product's/],
    ['a card naming no product', { readCard: () => ({ ok: true, doc: { state: 'claimed', claim: { session_id: SID } } }) }, /names no product/],
    ['a Tier 1 card with no main_commit', { startCommit: cardStartCommit }, /main_commit/],
    ['a runner that is stopping', { stopped: () => true }, /is stopping$/],
    ['no sign-in', { account: () => ({ account: null, reason: 'not set up' }) }, /not set up/],
    ['no start commit', { startCommit: async () => { throw new Error('no main'); } }, /no main/],
    ['a copy that can\'t be made', { prepare: async () => ({ ok: false, reason: 'copy folder already exists' }) }, /already exists/],
  ];
  for (const [what, over, re] of cases) {
    const w = world(over);
    try {
      const a = await w.start();
      assert.equal(a.ok, false, what); assert.match(a.reason, re, what);
      assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false }, what);
      assert.equal(w.calls.some((c) => c[0] === 'spawn'), false, what);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
  for (const [what, x] of [['an unknown kind', { kind: 'review' }], ['a bad session id', { sessionId: 'S-1' }], ['a bad card', { card: '../x' }], ['an unknown product', { product: 'p9' }]]) {
    const w = world();
    try { const a = await w.start(x); assert.equal(a.ok, false, what); assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false }, what); } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
  const after = [
    ['not walled', { walled: () => ({ ok: false, reason: 'not walled: x' }) }, /^not walled: x/],
    ['a launch check refusing', { launchFn: async () => ({ ok: false, reason: 'launch check 3 (outbox emptied): busy' }) }, /launch check 3/],
    ['a launch that throws', { launchFn: async () => { throw new Error('boom'); } }, /boom/],
    ['claude not spawned', { spawn: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }, /could not be spawned/],
    ['no start time', { pidStartOf: () => null, kill: () => {}, there: () => false }, /start time could not be read/],   // #364 r2 n3: no real group is signalled
    // L970: the prompt is asked for once the copy and the outbox are made; none takes both away and says the builder's reason.
    ['no prompt', { promptFor: () => null }, /^not wired: no worker prompt is given to the runner$/],
    ['a prompt refused', { promptFor: () => ({ ok: false, reason: 'the card has no plan' }) }, /^not wired: no worker prompt is given to the runner \(the card has no plan\)$/],
    ['a prompt builder that throws', { promptFor: async () => { throw new Error('boom in builder'); } }, /^not wired: no worker prompt is given to the runner \(boom in builder\)$/],
  ];
  for (const [what, over, re] of after) {
    const w = world(over);
    try {
      const a = await w.start();
      assert.equal(a.ok, false, what); assert.match(a.reason, re, what);
      assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false }, `${what}: what the start made is removed`);
      assert.ok(existsSync(join(w.mine.copies, 'C-9')), `${what}: another card's copy is left alone`);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
});

test('step 5: with M4\'s own launch() and no worker checks given, nothing starts and nothing is left', async () => {
  const w = world({ launchFn: launch, walled: () => ({ ok: true, role: 'worker', settings: {} }) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /launch check|not confirmed|not locked down/);
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('step 5: a real start\'s group is gone once killed (the leader the answer names is the group)', async () => {
  const w = world();
  delete w.deps.pidStartOf;
  w.deps.spawn = spawn;
  // A stand-in claude that takes any arguments and waits.
  const bin = join(w.d, 'claude'); writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n'); chmodSync(bin, 0o755);
  w.c.claudeBin = bin;
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    assert.ok(alive(a.pid));
    process.kill(-a.pgid, 'SIGKILL');
    assert.ok(await until(() => !alive(a.pid)));
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 self-review M4: with M4\'s own launch(), names that pass check 0 and no worker checks, check 1 refuses and nothing starts', async () => {
  const d0 = realpathSync(tempDir('orch-rports-'));
  const confirmed = {};
  const w = world({ launchFn: launch, walled: (x) => { const r = walledLaunchSettings(x); if (r.ok) for (const n of namesIn(r.settings)) confirmed[n] = { by: 'readback:stand-in', version: '2.1.300' }; return r; },
    names: { version: '2.1.300', confirmed } });
  for (const f of Object.values(FLAGS)) if (f.startsWith('--')) confirmed[f] = { by: 'readback:stand-in', version: '2.1.300' };
  const runner = { requestsDir: join(d0, 'requests'), statusFile: join(d0, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d0, 'state'));
  w.c.workerRunner = runner;
  w.c.products.p1.render = { paths: { hooksDir: '/w/hooks', snapshot: '/w/snapshots/rules.json', node: '/w/node', notes: '/w/notes', bobFolder: '/w/bob', mirror: '/w/mirror.git',
    deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record' } },
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: ['/w/proposals'] };
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /^launch check 1 \(fresh copy\): no check is wired/);
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); rmSync(d0, { recursive: true, force: true }); }
});

test('#364 self-review M1: a stop that comes while a start runs its checks spawns nothing, and the start removes what it made', async () => {
  let stopping = false;
  const w = world({ stopped: () => stopping, launchFn: async (x) => { stopping = true; return { ok: true, started: await x.start() }; } });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /stopping, so claude was not started/);
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#369 M1: check 2 runs once more just before claude starts; setup files changed by the checks\' runs stop the start', async () => {
  const seen = [];
  const w = world({ beforeStart: async (x) => { seen.push([x.copy, x.product, x.sessionId]); return 'the copy holds .claude/settings.local.json, which main does not'; },
    launchFn: async (x) => ({ ok: true, started: await x.start() }) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /a check failed again just before claude was to start, so it was not started: the copy holds \.claude\/settings\.local\.json/);
    assert.equal(seen.length, 1); assert.equal(typeof seen[0][0], 'string');
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  const ok = world({ beforeStart: async () => null, launchFn: async (x) => ({ ok: true, started: await x.start() }) });
  try { assert.equal((await ok.start()).ok, true); assert.equal(ok.calls.some((c) => c[0] === 'spawn'), true); } finally { rmSync(ok.d, { recursive: true, force: true }); }
});

test('#369 r1 m3, r2 m3: main moving during a launch is said as such, and never hides a check\'s own reason; checks get the main the copy was restored from', async () => {
  const A = 'a'.repeat(40); const B = 'e'.repeat(40);
  for (const [when, re] of [['after prepare', /^main changed during launch; retry$/], ['before start', /^a check failed again just before claude was to start, so it was not started: the copy's \.mcp\.json is not main's \(main also moved during launch, or can't be read\)$/]]) {
    let mains = [A];
    let seen;
    const w = world({ mainOf: async () => mains.shift() ?? B, checksFor: (x) => { seen = x.mainAt; return {}; },
      beforeStart: async () => 'the copy\'s .mcp.json is not main\'s', launchFn: async (x) => ({ ok: true, started: await x.start() }) });
    if (when === 'before start') mains = [A, A];
    try {
      const a = await w.start();
      assert.equal(a.ok, false); assert.match(a.reason, re, when);
      if (when === 'before start') assert.equal(seen, A, 'the checks compare with the main read before the copy was made');
      assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
});

test('#369 r1 M1: the baseline\'s throwaway copy is the same commit, walled apart from the session\'s copy and outbox, and removed', async () => {
  let t; let x0;
  const w = world({ checksFor: (x) => { x0 = x; return {}; }, launchFn: async (x) => { t = await x0.throwaway(); return { ok: true, started: await x.start() }; } });
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    const spare = join(w.mine.copies, `C-1..baseline-${SID}`);
    assert.deepEqual({ ok: t.ok, copy: t.copy, settingsFile: t.settingsFile }, { ok: true, copy: join(spare, 'copy'), settingsFile: join(w.settingsDir, `${SID}..baseline.json`) });
    const preps = w.calls.filter((c) => c[0] === 'prepare').map((c) => c[1]);
    assert.equal(preps.length, 2); assert.deepEqual(preps[1].card, preps[0].card, 'the same card and commit'); assert.equal(preps[1].dest, join(spare, 'copy'));
    const [own, theirs] = w.calls.filter((c) => c[0] === 'walled' && c[1].phase !== 'save').map((c) => c[1]);
    assert.ok(own.paths.deny.otherCopies.includes(spare), 'the session denies the throwaway place');
    assert.equal(theirs.paths.copy, join(spare, 'copy')); assert.equal(theirs.paths.outbox, join(spare, 'outbox'));
    for (const p of [join(w.mine.copies, 'C-1'), join(w.mine.outboxes, 'worker', SID), join(w.mine.copies, 'C-9')]) assert.ok(theirs.paths.deny.otherCopies.includes(p), `the baseline denies ${p}`);
    assert.equal(theirs.paths.deny.otherCopies.includes(spare), false, 'never its own place');
    assert.equal(existsSync(t.settingsFile), true); assert.equal(statSync(spare).mode & 0o077, 0);
    await t.done();
    assert.equal(existsSync(spare), false); assert.equal(existsSync(t.settingsFile), false);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  // Another commit than the session's copy: refused, and nothing is left.
  {
    let r; let x1;
    const v = world({ prepare: async (x) => { mkdirSync(x.dest); return { ok: true, dest: x.dest, head: x.dest.endsWith(`..baseline-${SID}/copy`) ? 'f'.repeat(40) : HEAD }; },
      checksFor: (x) => { x1 = x; return {}; }, launchFn: async () => { r = await x1.throwaway(); return { ok: false, reason: 'stop here' }; } });
    try { await v.start(); assert.equal(r.ok, false); assert.match(r.reason, /holds another commit than the session's copy/); assert.equal(existsSync(join(v.mine.copies, `C-1..baseline-${SID}`)), false); } finally { rmSync(v.d, { recursive: true, force: true }); }
  }
  // #369 r2 m3: main moving while the throwaway is made refuses nothing there (its setup files come from main, trusted).
  {
    let r; let x1;
    const v = world({ mainOf: (() => { let n = 0; return async () => (++n > 2 ? 'e'.repeat(40) : 'c'.repeat(40)); })(), checksFor: (x) => { x1 = x; return {}; },
      launchFn: async () => { r = await x1.throwaway(); await r.done?.(); return { ok: false, reason: 'stop here' }; } });
    try { await v.start(); assert.equal(r.ok, true, r.reason); } finally { rmSync(v.d, { recursive: true, force: true }); }
  }
});

test('#369 r2 m1: a throwaway left by an earlier start of the card (one made read-only inside, too) is removed; one that can\'t be is told, and never stops the card starting', async () => {
  let t; let x0;
  const logs = [];
  const w = world({ log: (s) => logs.push(s), checksFor: (x) => { x0 = x; return {}; }, launchFn: async (x) => { t = await x0.throwaway(); return { ok: true, started: await x.start() }; } });
  const old = join(w.mine.copies, 'C-1..baseline-S-9'); const earlier = join(w.mine.copies, 'C-1..baseline-S-0');
  const other = join(w.mine.copies, 'C-10..baseline-S-7');
  for (const f of [join(old, 'copy'), join(earlier, 'copy', 'ro'), other]) mkdirSync(f, { recursive: true });
  writeFileSync(join(earlier, 'copy', 'ro', 'f'), 'x'); chmodSync(join(earlier, 'copy', 'ro'), 0o555); chmodSync(join(earlier, 'copy'), 0o555);
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason); assert.equal(t.ok, true, t.reason);
    assert.deepEqual([existsSync(old), existsSync(earlier), existsSync(other)], [false, false, true], 'this card\'s leftovers only');
    // A folder made read-only inside the throwaway itself is removed by done() too.
    mkdirSync(join(t.copy, 'ro')); writeFileSync(join(t.copy, 'ro', 'f'), 'x'); chmodSync(join(t.copy, 'ro'), 0o555);
    await t.done();
    assert.equal(existsSync(join(w.mine.copies, `C-1..baseline-${SID}`)), false);
    assert.deepEqual(logs, []);
  } finally { chmodSync(w.copiesRoot, 0o700); rmSync(w.d, { recursive: true, force: true }); }
  // Self-review m1: a link inside a throwaway is never followed; the read-only folder it points to outside is unchanged.
  {
    const d = tempDir('orch-rports-');
    try {
      const out = join(d, 'outside'); mkdirSync(join(out, 'sub'), { recursive: true }); chmodSync(join(out, 'sub'), 0o555); chmodSync(out, 0o555);
      const spare = join(d, 'C-1..baseline-S-0'); mkdirSync(join(spare, 'ro'), { recursive: true }); writeFileSync(join(spare, 'ro', 'f'), 'x');
      symlinkSync(out, join(spare, 'ro', 'link')); chmodSync(join(spare, 'ro'), 0o555);
      const fs = { rm: rmSync, chmodTree };
      assert.equal(removeAll(fs, spare), true);
      assert.equal(existsSync(spare), false);
      assert.deepEqual([statSync(out).mode & 0o777, statSync(join(out, 'sub')).mode & 0o777], [0o555, 0o555]);
    } finally { execFileSync('/bin/chmod', ['-R', 'u+rwx', d]); rmSync(d, { recursive: true, force: true }); }
  }
  // One that can't be removed: told once (after a second try), left, and the start still goes on under the session's own name.
  const logs2 = []; let t2; let x2;
  const fails = (p) => p.includes('..baseline');
  const v = world({ log: (s) => logs2.push(s), checksFor: (x) => { x2 = x; return {}; }, launchFn: async (x) => { t2 = await x2.throwaway(); return { ok: true, started: await x.start() }; },
    fs: { rm: (p, o) => { if (fails(p) && !p.endsWith('.json')) throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }); return rmSync(p, o); } } });
  mkdirSync(join(v.mine.copies, 'C-1..baseline-S-0'));
  try {
    const a = await v.start();
    assert.equal(a.ok, true, a.reason); assert.equal(t2.ok, true, t2.reason);
    assert.equal(t2.copy, join(v.mine.copies, `C-1..baseline-${SID}`, 'copy'));
    assert.ok(logs2.some((l) => /C-1..baseline-S-0 can't be removed \(ENOTEMPTY\); it is left until this card's next start/.test(l)), logs2.join('\n'));
    await t2.done();
    assert.ok(logs2.some((l) => new RegExp(`C-1..baseline-${SID} can't be removed`).test(l)), logs2.join('\n'));
  } finally { rmSync(v.d, { recursive: true, force: true }); }
});

test('#369 r2 m2: a product the runner holds back (its rules snapshot not kept fresh) starts nothing, saying why', async () => {
  const w = world({ productHeld: (p) => (p === 'p1' ? 'product p1\'s rules snapshot is not kept fresh (ENOSPC), so its sessions are not started' : null) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /p1's rules snapshot is not kept fresh/);
    assert.equal(w.calls.some((c) => c[0] === 'prepare'), false, 'nothing is made');
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  // Self-review m4: held back during the checks (a refresher that died in the baseline): claude is not started.
  let n = 0;
  const v = world({ productHeld: () => (n++ === 0 ? null : 'product p1\'s rules snapshot is not kept fresh (ENOSPC), so its sessions are not started'), beforeStart: async () => null });
  try {
    const a = await v.start();
    assert.equal(a.ok, false); assert.match(a.reason, /not kept fresh/);
    assert.equal(v.calls.some((c) => c[0] === 'spawn'), false, 'not started');
  } finally { rmSync(v.d, { recursive: true, force: true }); }
});

test('L825: a Tier 1 card (or one with no tier) starts on its plan\'s main_commit; any other card on the mirror\'s main', async () => {
  const C = 'c'.repeat(40); const M = 'd'.repeat(40);
  const main = async (m) => { assert.equal(m, '/m'); return M; };
  assert.equal(await cardStartCommit({ mirror: '/m', cardDoc: { tier: 1, main_commit: C } }, { main }), C);
  assert.equal(await cardStartCommit({ mirror: '/m', cardDoc: { main_commit: C } }, { main }), C);
  assert.equal(await cardStartCommit({ mirror: '/m', cardDoc: { tier: 2, main_commit: null } }, { main }), M);
  for (const doc of [{ tier: 1 }, { tier: 1, main_commit: 'abc' }, { main_commit: C.toUpperCase() }, {}, undefined]) {
    await assert.rejects(cardStartCommit({ mirror: '/m', cardDoc: doc }, { main }), /main_commit/, JSON.stringify(doc));
  }
  // #364 r1 m1: a tier the Store would refuse is refused here too, never read as Tier 2.
  for (const tier of ['1', '2', 0, 3, true, 1.5, -1]) {
    await assert.rejects(cardStartCommit({ mirror: '/m', cardDoc: { tier, main_commit: C } }, { main }), /is not 1 or 2/, JSON.stringify(tier));
  }
  // The answer's base is the commit the copy was made on.
  const w = world({ startCommit: undefined });
  delete w.deps.startCommit; w.card.tier = 1; w.card.main_commit = C;
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason); assert.equal(a.base, C);
    assert.equal(w.calls.find((c) => c[0] === 'prepare')[1].card.commit, C);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 r1 m6: a Tier 2 card starts on the real mirror\'s main through the start port, and base names it', async () => {
  const w = world();
  delete w.deps.startCommit; w.card.tier = 2;
  const src = join(w.d, 'src'); mkdirSync(src);
  const o = { gitDir: join(src, '.git'), workTree: src, cwd: src };
  try {
    await gitOk(['init', '-q', '-b', 'main', src], o); writeFileSync(join(src, 'a.txt'), 'a\n');
    await gitOk(['add', '-A'], o); await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'm'], o);
    const M = (await gitOk(['rev-parse', 'HEAD'], o)).trim();
    await initMirror(w.c.products.p1.mirror);
    await gitOk(['fetch', '-q', src, 'refs/heads/main:refs/heads/main'], { gitDir: w.c.products.p1.mirror });
    const a = await w.start();
    assert.equal(a.ok, true, a.reason); assert.equal(a.base, M);
    assert.equal(w.calls.find((c) => c[0] === 'prepare')[1].card.commit, M);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 r1 M1: with two products, a p1 session\'s settings deny p2\'s mirror and every copy there at start, never its own', async () => {
  const d0 = realpathSync(tempDir('orch-rports-'));
  let got;
  const w = world({ walled: (x) => { const r = walledLaunchSettings(x); got = r; return r; } });
  const runner = { requestsDir: join(d0, 'requests'), statusFile: join(d0, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d0, 'state'));
  w.c.workerRunner = runner;
  const render = (n) => ({ paths: { hooksDir: `/w/${n}/hooks`, snapshot: `/w/${n}/snapshots/rules.json`, node: '/w/node', notes: `/w/${n}/notes`, bobFolder: '/w/bob', mirror: `/w/${n}/mirror.git`,
    deny: { proposals: [`/w/${n}/proposals`], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record' } },
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: [`/w/${n}/proposals`] });
  w.c.products.p1.render = render('p1');
  w.c.products.p2 = { repo: 'o/p2', mirror: join(w.d, 'mirror-p2'), render: render('p2') };
  const theirs = { copies: join(w.copiesRoot, 'p2'), outboxes: join(w.outboxRoot, 'p2') };
  for (const f of [join(theirs.copies, 'C-7'), join(theirs.outboxes, 'worker'), join(theirs.outboxes, 'script')]) mkdirSync(f, { recursive: true });   // p2's card, made before this start
  // #378 m1: a product setup made but this config leaves out, and folders of the old flat layout, are denied too.
  const unlisted = [join(w.copiesRoot, 'p3'), join(w.copiesRoot, 'C-0'), join(w.outboxRoot, 'p3'), join(w.outboxRoot, 'worker')];
  for (const f of unlisted) mkdirSync(f, { recursive: true });
  // A product in the config whose folders setup has not made yet is denied by name: a copy made there later stays walled.
  w.c.products.p4 = { repo: 'o/p4', mirror: join(w.d, 'mirror-p4'), render: render('p4') };
  const later = [join(w.copiesRoot, 'p4'), join(w.outboxRoot, 'p4')];
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    const denyRead = got.settings[S.sandbox][S.filesystem][S.denyRead];
    for (const p of [w.c.products.p2.mirror, theirs.copies, theirs.outboxes, join(w.mine.copies, 'C-9'), '/w/record', '/h/.ssh', '/w/keys']) assert.ok(denyRead.includes(p), `${p} is denied`);
    assert.equal(denyRead.includes(join(theirs.copies, 'C-7')), false, 'p2\'s whole copies folder is denied, not its copies one by one');
    for (const p of unlisted) assert.ok(denyRead.includes(p), `${p}, not in the config, is denied`);
    for (const p of later) assert.ok(denyRead.includes(p), `${p}, not made yet, is denied`);
    for (const p of [w.mine.copies, w.mine.outboxes, w.copiesRoot, w.outboxRoot]) assert.equal(denyRead.includes(p), false, `${p} is not denied whole`);
    assert.equal(denyRead.includes(join(w.mine.copies, 'C-1')), false, 'its own copy is not denied');
    assert.equal(denyRead.includes(w.c.products.p1.mirror), false, 'its own product\'s mirror is not denied');
    // And the other way: a p2 session denies p1's mirror.
    const SID2 = SID.replace('0f', '2f');
    w.card.claim.session_id = SID2; w.card.product = 'p2';
    const b = await startPort(w.c, w.deps)({ card: 'C-2', kind: 'editing', product: 'p2', sessionId: SID2 });
    assert.equal(b.ok, true, b.reason);
    const dr2 = got.settings[S.sandbox][S.filesystem][S.denyRead];
    assert.equal(b.copy, join(theirs.copies, 'C-2')); assert.equal(b.outbox, join(theirs.outboxes, 'worker', SID2));
    assert.ok(dr2.includes(w.c.products.p1.mirror) && dr2.includes(w.mine.copies) && dr2.includes(w.mine.outboxes) && !dr2.includes(join(theirs.copies, 'C-2')));
    assert.ok(!dr2.includes(theirs.copies) && !dr2.includes(theirs.outboxes), 'its own product\'s folders are not denied');
  } finally { rmSync(w.d, { recursive: true, force: true }); rmSync(d0, { recursive: true, force: true }); }
});

test('#364 r1 m3: a claude whose start time can\'t be read and whose group can\'t be shown gone is answered as running, and its start keeps what it made', async () => {
  const kills = [];
  const s = await spawnLeader({ spawn: () => ({ pid: 4243, once: (ev, fn) => { if (ev === 'spawn') fn(); }, unref: () => {} }), bin: '/x', args: [], cwd: '/', env: {},
    pidStartOf: () => null, kill: (g, sig) => kills.push([g, sig]), there: () => true, killWaitMs: 60 });
  assert.deepEqual(kills, [[4243, 'SIGKILL']]);
  assert.equal(s.ok, false); assert.equal(s.running, true); assert.equal(s.pgid, 4243);
  const gone = await spawnLeader({ spawn: () => ({ pid: 4244, once: (ev, fn) => { if (ev === 'spawn') fn(); }, unref: () => {} }), bin: '/x', args: [], cwd: '/', env: {},
    pidStartOf: () => null, kill: () => {}, there: () => false, killWaitMs: 60 });
  assert.equal(gone.ok, false); assert.equal(gone.running, undefined); assert.match(gone.reason, /so its group was killed/);
  const w = world({ pidStartOf: () => null, kill: () => {} });
  w.deps.launchFn = async (x) => ({ ok: false, reason: 'start failed', started: await spawnLeader({ spawn: w.deps.spawn, bin: '/x', args: [], cwd: '/', env: {}, pidStartOf: () => null, kill: () => {}, there: () => true, killWaitMs: 60 }) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.equal(a.running, true); assert.equal(a.pgid, 4242);
    assert.deepEqual(w.left(), { copy: true, outbox: true, settings: true }, 'nothing it made is removed while claude may run');
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 r2 c-b: a group is gone only on ESRCH; EPERM (there, not ours to signal) and any other error read as still there', () => {
  const seen = [];
  assert.equal(groupThere(4243, (g, s) => { seen.push([g, s]); }), true);
  assert.deepEqual(seen, [[-4243, 0]], 'signal 0 to the group, never the leader alone');
  assert.equal(groupThere(4243, () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }), false);
  assert.equal(groupThere(4243, () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }), true);
  assert.equal(groupThere(4243, () => { throw new Error('odd'); }), true);
});

test('L836: a product named as a role is refused before anything is made; a product with no copies folder yet makes nothing', async () => {
  const w = world();
  try {
    w.c.products.worker = w.c.products.p1; w.card.product = 'worker';
    const a = await w.start({ product: 'worker' });
    assert.equal(a.ok, false); assert.match(a.reason, /named as a role/);
    assert.equal(existsSync(join(w.copiesRoot, 'worker', 'C-1')), false); assert.equal(existsSync(join(w.outboxRoot, 'worker', 'worker')), false);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  const v = world();
  try {
    v.c.products.p3 = v.c.products.p1; v.card.product = 'p3';
    const a = await v.start({ product: 'p3' });
    assert.equal(a.ok, false, 'setup has made no folders for p3'); assert.match(a.reason, /setup has made no folder/);
    assert.equal(existsSync(join(v.copiesRoot, 'p3')), false, 'the start never makes a product folder');
    assert.equal(existsSync(join(v.outboxRoot, 'p3')), false);
  } finally { rmSync(v.d, { recursive: true, force: true }); }
});

test('#378 r1 M1: product B added while a product A session runs: B\'s start is refused until A\'s settings are shown to deny B, or A has ended', async () => {
  const d0 = realpathSync(tempDir('orch-rports-'));
  let got;
  const w = world({ walled: (x) => { const r = walledLaunchSettings(x); got = r; return r; } });
  const runner = { requestsDir: join(d0, 'requests'), statusFile: join(d0, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d0, 'state'));
  w.c.workerRunner = runner;
  const render = (n) => ({ paths: { hooksDir: `/w/${n}/hooks`, snapshot: `/w/${n}/snapshots/rules.json`, node: '/w/node', notes: `/w/${n}/notes`, bobFolder: '/w/bob', mirror: `/w/${n}/mirror.git`,
    deny: { proposals: [`/w/${n}/proposals`], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record' } },
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: [`/w/${n}/proposals`] });
  w.c.products.p1.render = render('p1');
  try {
    // 1. Product A (p1) alone: its session starts, and its settings know nothing of a p2.
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    const A = { id: SID, product: 'p1' };
    // 2. Product B (p2) is added: setup makes its folders, the config gains it.
    for (const f of [join(w.copiesRoot, 'p2'), join(w.outboxRoot, 'p2', 'worker'), join(w.outboxRoot, 'p2', 'script')]) mkdirSync(f, { recursive: true });
    const c2 = { ...w.c, products: { ...w.c.products, p2: { repo: 'o/p2', mirror: join(w.d, 'mirror-p2'), render: render('p2') } } };
    const SB = SID.replace('0f', '3f');
    const startB = (live) => { w.card.claim.session_id = SB; w.card.product = 'p2'; return startPort(c2, w.deps)({ card: 'C-3', kind: 'editing', product: 'p2', sessionId: SB, live }); };
    const leftB = () => [existsSync(join(w.copiesRoot, 'p2', 'C-3')), existsSync(join(w.outboxRoot, 'p2', 'worker', SB)), existsSync(join(w.settingsDir, `${SB}.json`))];
    const r = await startB([A]);
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`session ${SID} \\(product p1\\) started before product p2's folders were on its deny list \\(its shell may read ${join(w.copiesRoot, 'p2')}\\)`));
    assert.deepEqual(leftB(), [false, false, false], 'nothing is made');
    // Read and Edit are checked as well as the shell: a settings file whose shell denies p2 but whose Read does not.
    const f = join(w.settingsDir, `${SID}.json`);
    const s = JSON.parse(readFileSync(f, 'utf8'));
    s[S.sandbox][S.filesystem][S.denyRead].push(join(w.copiesRoot, 'p2'), join(w.outboxRoot, 'p2'));
    writeFileSync(f, JSON.stringify(s));
    assert.match((await startB([A])).reason, /its Read may reach/);
    s[S.permissions][S.deny].push(`Read(/${join(w.copiesRoot, 'p2')}/**)`, `Read(/${join(w.outboxRoot, 'p2')}/**)`);
    writeFileSync(f, JSON.stringify(s));
    assert.match((await startB([A])).reason, /its Edit may reach/);
    // #378 self-review M1: B's mirror too.
    s[S.permissions][S.deny].push(`Edit(/${join(w.copiesRoot, 'p2')}/**)`, `Edit(/${join(w.outboxRoot, 'p2')}/**)`);
    writeFileSync(f, JSON.stringify(s));
    assert.match((await startB([A])).reason, new RegExp(`its shell may read ${join(w.d, 'mirror-p2')}\\)`));
    // #378 r2 n2, c1: a waiting start of an earlier run whose settings are still there, without p2: held too, saying
    // that the owner removes the settings file (a waiting row never ends).
    const wr = await startB([{ ...A, unstarted: true }]);
    assert.equal(wr.ok, false);
    assert.match(wr.reason, new RegExp(`session ${SID} \\(product p1\\), a start from an earlier run still waiting, left settings that don't deny product p2's folders .*the owner removes that settings file \\(${SID}\\.json`));
    // #378 r2 n3 (A6): the mirror's Read and Edit denies are checked as well as the shell's.
    s[S.sandbox][S.filesystem][S.denyRead].push(join(w.d, 'mirror-p2'));
    writeFileSync(f, JSON.stringify(s));
    assert.match((await startB([A])).reason, new RegExp(`its Read may reach ${join(w.d, 'mirror-p2')}\\)`));
    s[S.permissions][S.deny].push(`Read(/${join(w.d, 'mirror-p2')}/**)`);
    writeFileSync(f, JSON.stringify(s));
    assert.match((await startB([A])).reason, new RegExp(`its Edit may reach ${join(w.d, 'mirror-p2')}\\)`));
    // A session that can't be told about holds B's start too: its settings gone or not JSON, or no product named.
    rmSync(f);
    assert.match((await startB([A])).reason, /settings can't be read \(ENOENT\)/);
    assert.match((await startB([{ id: SID }])).reason, /names no product/);
    // A start still waiting from an earlier run whose settings were never written started no claude with them.
    const b0 = await startB([{ ...A, unstarted: true }]);
    assert.equal(b0.ok, true, b0.reason);
    // 3. Once A has ended (no longer live), B starts; a live session of B's own product is not asked.
    rmSync(join(w.copiesRoot, 'p2', 'C-3'), { recursive: true }); rmSync(join(w.outboxRoot, 'p2', 'worker', SB), { recursive: true }); rmSync(join(w.settingsDir, `${SB}.json`)); rmSync(join(w.settingsDir, `${SB}.save.json`));
    const b = await startB([{ id: SID.replace('0f', '4f'), product: 'p2' }]);
    assert.equal(b.ok, true, b.reason);
    // A p1 session started with p2 in the config denies p2 whole, so a later p2 start goes ahead while it runs.
    const SA2 = SID.replace('0f', '5f');
    w.card.claim.session_id = SA2; w.card.product = 'p1';
    const a2 = await startPort(c2, w.deps)({ card: 'C-5', kind: 'editing', product: 'p1', sessionId: SA2 });
    assert.equal(a2.ok, true, a2.reason);
    assert.equal(productWallGap(got.settings, { copies: join(w.copiesRoot, 'p2'), outboxes: join(w.outboxRoot, 'p2') }), null);
    rmSync(join(w.copiesRoot, 'p2', 'C-3'), { recursive: true }); rmSync(join(w.outboxRoot, 'p2', 'worker', SB), { recursive: true }); rmSync(join(w.settingsDir, `${SB}.json`)); rmSync(join(w.settingsDir, `${SB}.save.json`));
    const b2 = await startB([{ id: SA2, product: 'p1' }]);
    assert.equal(b2.ok, true, b2.reason);
  } finally { rmSync(w.d, { recursive: true, force: true }); rmSync(d0, { recursive: true, force: true }); }
});

test('#378 r1 M1: productWallGap takes a folder above as a deny, and no list as none', () => {
  const P = { copies: '/c/q', outboxes: '/o/q' };
  const all = (dirs) => ({ [S.sandbox]: { [S.filesystem]: { [S.denyRead]: dirs } }, [S.permissions]: { [S.deny]: dirs.flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`]) } });
  // #378 self-review M1: the product's mirror, when given, is checked as its folders are.
  assert.match(productWallGap(all(['/c/q', '/o/q']), { ...P, mirror: '/m/q' }), /shell may read \/m\/q$/);
  assert.equal(productWallGap(all(['/c/q', '/o/q', '/m/q']), { ...P, mirror: '/m/q' }), null);
  // #378 self-review M2 (c): a waiting row with no settings file started no claude, product named or not; a listed one
  // naming none, or a waiting one whose settings are there but name none, can't be told about.
  const enoent = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  assert.equal(liveWallProblem([{ id: 'S-1', unstarted: true }], 'q', P, enoent), null);
  assert.match(liveWallProblem([{ id: 'S-1' }], 'q', P, enoent), /names no product/);
  assert.match(liveWallProblem([{ id: 'S-1', unstarted: true }], 'q', P, () => all([])), /names no product/);
  assert.match(liveWallProblem([{ id: 'S-1', unstarted: true, product: 'p' }], 'q', P, () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }), /can't be read \(EACCES\)/);
  assert.equal(productWallGap(all(['/c/q', '/o/q']), P), null);
  assert.equal(productWallGap(all(['/c', '/o/']), P), null, 'a folder above');
  assert.match(productWallGap(all(['/c/qq', '/o/q']), P), /shell may read \/c\/q$/, 'a longer name is not above');
  assert.match(productWallGap(all(['/c/q', '/o/q']), { copies: '/c/qq', outboxes: '/o/qq' }), /shell may read \/c\/qq$/, 'nor a shorter one');
  assert.match(productWallGap(all(['/c/q']), P), /shell may read \/o\/q$/);
  assert.match(productWallGap({}, P), /shell may read/);
  assert.match(productWallGap(null, P), /shell may read/);
});

test('L889: the baseline\'s throwaway settings pass the real renderer: its folder names keep to the plain path letters', async () => {
  const d0 = realpathSync(tempDir('orch-rports-'));
  const got = [];
  let t; let x0;
  const w = world({ walled: (x) => { const r = walledLaunchSettings(x); got.push(r); return r; },
    checksFor: (x) => { x0 = x; return {}; }, launchFn: async (x) => { t = await x0.throwaway(); return { ok: true, started: await x.start() }; } });
  const runner = { requestsDir: join(d0, 'requests'), statusFile: join(d0, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d0, 'state'));
  w.c.workerRunner = runner;
  w.c.products.p1.render = { paths: { hooksDir: '/w/p1/hooks', snapshot: '/w/p1/snapshots/rules.json', node: '/w/node', notes: '/w/p1/notes', bobFolder: '/w/bob', mirror: '/w/p1/mirror.git',
    deny: { proposals: ['/w/p1/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record' } },
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: ['/w/p1/proposals'] };
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    assert.equal(t?.ok, true, t?.reason);
    assert.equal(got.length, 3, 'the session\'s settings, the save\'s and the baseline\'s');
    for (const r of got) assert.equal(r.ok, true, r.reason);
    // L991 M1: the save's pass the real renderer too, with the network shut and the outbox its only extra folder.
    assert.deepEqual(got[1].settings.sandbox.network.allowedDomains, []);
    assert.deepEqual(got[1].settings.permissions.additionalDirectories, [join(w.mine.outboxes, 'worker', SID)]);
    got.splice(1, 1);
    const spare = join(w.mine.copies, `C-1..baseline-${SID}`);
    assert.equal(got[1].settings.permissions.additionalDirectories[0], join(spare, 'outbox'));
    assert.ok(/^[A-Za-z0-9._/-]+$/.test(spare) && /^[A-Za-z0-9._/-]+$/.test(t.settingsFile), 'plain path letters only');
    await t.done();
  } finally { rmSync(w.d, { recursive: true, force: true }); rmSync(d0, { recursive: true, force: true }); }
});

test('#456 runLocked self-review M2: check 4\'s real settings steps write the install settings with the registry hosts, then put the session\'s back byte for byte', async () => {
  let x0; const seen = {};
  const walled = (x) => ({ ok: true, role: 'worker', settings: { phase: x.phase ?? 'session', hosts: x.registryHosts ?? null } });
  const w = world({ walled, checksFor: (x) => { x0 = x; return {}; },
    launchFn: async (x) => {
      const f = x0.settings.file; seen.first = readFileSync(f, 'utf8');
      const i = x0.renderPhase('install'); seen.install = i;
      seen.wroteInstall = x0.writeSettings(i.settings); seen.during = readFileSync(f, 'utf8');
      const s = x0.renderPhase('session'); seen.wroteSession = x0.writeSettings(s.settings); seen.after = readFileSync(f, 'utf8');
      seen.next = existsSync(`${f}.next`); seen.bad = x0.renderPhase('other');
      return { ok: true, started: await x.start() };
    } });
  w.c.products.p1.render.registryHosts = ['registry.npmjs.org'];
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    assert.deepEqual(JSON.parse(seen.during), { phase: 'install', hosts: ['registry.npmjs.org'] }, 'the install runs under the install phase, with the registry\'s hosts');
    assert.deepEqual([seen.wroteInstall, seen.wroteSession], [{ ok: true }, { ok: true }], 'each read back as written');
    assert.equal(seen.after, seen.first, 'the session\'s settings put back byte for byte, as check 5 reads them');
    assert.equal(seen.next, false, 'no .next file left');
    assert.equal(seen.bad.ok, false);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  // A move that fails leaves no .next file, and says why; the session's settings file is untouched.
  let y0; let r;
  const v = world({ walled, fs: { rename: () => { const e = new Error('no'); e.code = 'EXDEV'; throw e; } }, checksFor: (x) => { y0 = x; return {}; },
    launchFn: async () => { const f = y0.settings.file; const before = readFileSync(f, 'utf8'); r = y0.writeSettings({ x: 1 }); r.same = readFileSync(f, 'utf8') === before; r.next = existsSync(`${f}.next`); return { ok: false, reason: 'stop here' }; } });
  v.c.products.p1.render.registryHosts = ['registry.npmjs.org'];
  try {
    await v.start();
    assert.equal(r.ok, false); assert.match(r.reason, /not written \(EXDEV\)/);
    assert.deepEqual([r.same, r.next], [true, false]);
  } finally { rmSync(v.d, { recursive: true, force: true }); }
});

test('#463 r1 m5 (P11): a settings write that reads back other than written, or can\'t be read back, is refused', async () => {
  for (const [readSettings, re] of [[() => ({ s: 2 }), /not read back as written/], [() => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }, /not read back \(ENOENT\)/]]) {
    let x0; let r;
    const w = world({ readSettings, checksFor: (x) => { x0 = x; return {}; },
      launchFn: async () => { r = x0.writeSettings({ s: 1 }); return { ok: false, reason: 'stop here' }; } });
    try {
      await w.start();
      assert.equal(r.ok, false); assert.match(r.reason, re);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
});

// L976, L985: an undo start names the commit it reverses. It is checked (40 hex, an undo only) and then found in the
// mirror as an ancestor of the start commit before any copy is made; only then does the prompt get it.
test('L976 / L985: an undo start checks its reversed commit before the copy and hands it to the prompt; a bad one makes nothing', async () => {
  const U = 'f'.repeat(40);
  const seen = { prompts: [], checks: [] };
  const deps = { promptFor: (x) => { seen.prompts.push(x); return 'do the card'; }, undoCheck: async (x) => { seen.checks.push(x); return null; } };
  const w = world(deps);
  w.deps.checksFor = (x) => { w.calls.push(['checks', x]); return {}; };
  try {
    const a = await w.start({ kind: 'undo', undoCommit: U });
    assert.equal(a.ok, true, a.reason);
    assert.equal(seen.prompts.at(-1).undoCommit, U);
    assert.deepEqual(seen.checks, [{ mirror: w.c.products.p1.mirror, commit: U, head: HEAD }], 'checked against the start commit');
    assert.equal(w.calls.find((c) => c[0] === 'checks')[1].undoCommit, U, 'the launch checks are handed it (check 12)');
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  const e = world(deps);
  e.deps.checksFor = (x) => { e.calls.push(['checks', x]); return {}; };
  try {
    seen.checks.length = 0;
    const a = await e.start();
    assert.equal(a.ok, true, a.reason);
    assert.equal('undoCommit' in seen.prompts.at(-1), false, 'an editing prompt is given none');
    assert.equal('undoCommit' in e.calls.find((c) => c[0] === 'checks')[1], false, 'nor its checks');
    assert.deepEqual(seen.checks, [], 'and the mirror is not asked');
  } finally { rmSync(e.d, { recursive: true, force: true }); }
  const cases = [
    ['an undo with no commit', { kind: 'undo' }, {}, /the undo launch names no reversed commit/],
    ['an undo with a short commit', { kind: 'undo', undoCommit: U.slice(1) }, {}, /names no reversed commit/],
    ['an undo with an upper-case commit', { kind: 'undo', undoCommit: U.toUpperCase() }, {}, /names no reversed commit/],
    ['an editing start naming a commit', { undoCommit: U }, {}, /only an undo launch names a reversed commit/],
    ['a script start naming a commit', { kind: 'script', undoCommit: U }, {}, /only an undo launch/],
    ['a commit not in the mirror', { kind: 'undo', undoCommit: U }, { undoCheck: async () => 'the reversed commit ffffffffffff is not a commit in the mirror' }, /is not a commit in the mirror/],
    ['a check that throws', { kind: 'undo', undoCommit: U }, { undoCheck: async () => { throw new Error('git broke'); } }, /the reversed commit can't be checked \(git broke\)/],
  ];
  for (const [what, x, over, re] of cases) {
    const v = world(over);
    try {
      const a = await v.start(x);
      assert.equal(a.ok, false, what); assert.match(a.reason, re, what);
      assert.deepEqual(v.left(), { copy: false, outbox: false, settings: false }, `${what}: nothing made`);
      assert.equal(v.calls.some((c) => c[0] === 'prepare' || c[0] === 'spawn'), false, `${what}: no copy is asked for`);
    } finally { rmSync(v.d, { recursive: true, force: true }); }
  }
});

test('L985: undoCommitProblem, on a real mirror: an ancestor passes; a commit not there, off the line, or not checkable is refused plainly', async () => {
  const d = realpathSync(tempDir('orch-undo-commit-'));
  const src = join(d, 'src'); const mirror = join(d, 'mirror'); mkdirSync(src);
  const o = { gitDir: join(src, '.git'), workTree: src, cwd: src };
  const commit = async (f) => { writeFileSync(join(src, f), `${f}\n`); await gitOk(['add', '-A'], o); await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', f], o); return (await gitOk(['rev-parse', 'HEAD'], o)).trim(); };
  try {
    await gitOk(['init', '-q', '-b', 'main', src], o);
    const A = await commit('a.txt'); const B = await commit('b.txt');
    await gitOk(['checkout', '-q', '-b', 'side', A], o); const S = await commit('s.txt');
    await initMirror(mirror);
    await gitOk(['fetch', '-q', src, 'refs/heads/main:refs/heads/main', 'refs/heads/side:refs/heads/side'], { gitDir: mirror });
    assert.equal(await undoCommitProblem({ mirror, commit: A, head: B }), null, 'an ancestor of the start commit');
    assert.equal(await undoCommitProblem({ mirror, commit: B, head: B }), null, 'the start commit itself');
    assert.equal(await undoCommitProblem({ mirror, commit: 'e'.repeat(40), head: B }), 'the reversed commit eeeeeeeeeeee is not a commit in the mirror');
    assert.equal(await undoCommitProblem({ mirror, commit: S, head: B }), `the reversed commit ${S.slice(0, 12)} is not an ancestor of the start commit ${B.slice(0, 12)}`);
    assert.equal(await undoCommitProblem({ mirror, commit: B, head: A }), `the reversed commit ${B.slice(0, 12)} is not an ancestor of the start commit ${A.slice(0, 12)}`, 'a later commit is not an ancestor');
    // A tree or blob id is not a commit.
    const tree = (await gitOk(['rev-parse', `${A}^{tree}`], o)).trim();
    assert.match(await undoCommitProblem({ mirror, commit: tree, head: B }), /is not a commit in the mirror/);
    assert.match(await undoCommitProblem({ mirror, commit: A, head: 'e'.repeat(40) }), /can't be checked against the start commit \(git \d+\)/);
    // An annotated tag's id peels to a commit, and is still not the commit reversed (self-review m1).
    await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', '-m', 't', 'v1', A], o);
    await gitOk(['fetch', '-q', src, 'refs/tags/v1:refs/tags/v1'], { gitDir: mirror });
    const tag = (await gitOk(['rev-parse', 'refs/tags/v1'], { gitDir: mirror })).trim();
    assert.notEqual(tag, A);
    assert.equal(await undoCommitProblem({ mirror, commit: tag, head: B }), `the reversed commit ${tag.slice(0, 12)} is not a commit in the mirror`);
    // #468 m3: its own inputs are checked first; a leading-dash or short value never reaches git.
    const asked = [];
    const run = async (args) => { asked.push(args); return { code: 0, stdout: 'commit\n' }; };
    for (const commit of ['--output=/tmp/x', `-${A.slice(1)}`, A.slice(1), A.toUpperCase(), undefined, null, 7]) {
      assert.equal(await undoCommitProblem({ mirror, commit, head: B }, { run }), 'the reversed commit is not 40 lower-case hex', String(commit));
    }
    for (const head of ['--all', `-${B.slice(1)}`, B.slice(1), undefined]) {
      assert.equal(await undoCommitProblem({ mirror, commit: A, head }, { run }), 'the start commit is not 40 lower-case hex', String(head));
    }
    assert.deepEqual(asked, [], 'git is never asked');
    assert.equal(await undoCommitProblem({ mirror, commit: A, head: B }, { run }), null, 'control: the fake git answers for good inputs');
    assert.equal(asked.length, 2);
    // A lookup that can't be made is said as such, never as "not a commit" (self-review m2).
    assert.match(await undoCommitProblem({ mirror: join(d, 'none'), commit: A, head: B }), /can't be looked up in the mirror \(git -1\)/, 'no mirror');
    assert.equal(await undoCommitProblem({ mirror, commit: A, head: B }, { run: async () => ({ code: -1, stdout: '', stderr: 'refused' }) }), `the reversed commit ${A.slice(0, 12)} can't be looked up in the mirror (git -1)`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
