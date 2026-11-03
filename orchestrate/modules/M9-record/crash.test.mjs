// crash.test.mjs — R-0b-21 / R-0b-24: kill the Store Writer at every step of a write, for every kind of write, and
// restart: each document is its old or new version, the diary has no gaps, revs match, and the lock is free
// (0b-2 M-4). Plus R2-M11: a writer stopped mid-write keeps the lock, and a second process's recover() waits and
// changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAULT_POINTS, docBytes, sha256 } from './store.mjs';
import { HEAD, HEAD2, PRODUCT, UID, iso, rulesFor, seed, setup } from './fixtures.test-helper.mjs';
import { openRecordWithStore } from './writer.mjs';
import { sleepMs } from './lock.mjs';

const CHILD = fileURLToPath(new URL('./child.test-helper.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, [CHILD, JSON.stringify(args)], { encoding: 'utf8', timeout: 60000 });

// Reopen the store as a new process would, recover, and check it whole.
function checkWhole(root, cases) {
  const { store, record } = openRecordWithStore({ root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), host: 'mac-a', lockTimeoutMs: 5000 });
  const report = store.recover();
  const lines = store.lines();
  lines.forEach((l, i) => assert.equal(l.seq, i + 1, 'diary seq has a gap'));
  assert.equal(store.damaged(), null, 'diary damaged');
  for (const { entity, id, before, after } of cases) {
    const got = record.read(entity, id);
    assert.ok(!got?.corrupt, `${entity}/${id} corrupt after recovery`);
    const last = [...lines].reverse().flatMap((l) => l.writes).find((w) => w.entity === entity && w.id === id);
    assert.equal(got.rev, last.rev, 'rev matches the diary');
    const file = readFileSync(join(root, 'docs', entity, `${id}.json`));
    assert.equal(sha256(file), last.doc_hash, 'file is the diary version');
    const same = (x) => JSON.stringify(x) === JSON.stringify(got.doc);
    assert.ok(same(before) || same(after), `${entity}/${id} is neither old nor new: ${JSON.stringify(got.doc)}`);
  }
  assert.ok(!existsSync(join(root, 'lock')), 'lock is free');
  assert.deepEqual(readdirSync(join(root, 'tmp')), [], 'no temp files left');
  return { report, lines };
}

const KINDS = [
  { name: 'card head (record.write)', prep: (env) => seed(env, 'card', 'C-1', { state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, head: HEAD }),
    args: (env) => ({ op: 'write', w: { actor: 'workshop', entity: 'card', id: 'C-1', expectRev: 1, doc: { ...env.record.read('card', 'C-1').doc, head: HEAD2 } } }),
    cases: (env, before) => [{ entity: 'card', id: 'C-1', before: before.card, after: { ...before.card, head: HEAD2 } }] },
  { name: 'merge pair (two documents)', prep: (env) => { seed(env, 'card', 'C-2', { state: 'approved', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 }); seed(env, 'merge', 'M-2', { state: 'queued', card: 'C-2' }); },
    args: () => ({ op: 'commit', writes: [{ entity: 'merge', id: 'M-2', doc: { state: 'checking', card: 'C-2' } }, { entity: 'card', id: 'C-2', doc: { state: 'merging', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 } }] }),
    cases: (env, before) => [{ entity: 'merge', id: 'M-2', before: before.merge, after: { state: 'checking', card: 'C-2' } }, { entity: 'card', id: 'C-2', before: before.card2, after: { state: 'merging', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 } }] },
  { name: 'new ask (create)', prep: () => {},
    args: () => ({ op: 'commit', writes: [{ entity: 'ask', id: 'A-1', doc: { state: 'open', kind: 'question', reask_count: 0 } }] }),
    cases: () => [{ entity: 'ask', id: 'A-1', before: undefined, after: { state: 'open', kind: 'question', reask_count: 0 } }] },
];

for (const kind of KINDS) {
  for (const step of FAULT_POINTS) {
    test(`SIGKILL at ${step}: ${kind.name} — old or new, never half`, () => {
      const env = setup({ prefix: 'm9-crash-' });
      kind.prep(env);
      const before = { card: env.record.read('card', 'C-1')?.doc, card2: env.record.read('card', 'C-2')?.doc, merge: env.record.read('merge', 'M-2')?.doc };
      const r = run({ ...kind.args(env), root: env.root, faultAt: step });
      assert.equal(r.signal, 'SIGKILL', `child should have been killed at ${step}: ${r.stdout} ${r.stderr}`);
      // Killed before the diary line is written whole: the old version. From the diary line on: the new one.
      const committed = !['locked', 'temp_written', 'diary_torn'].includes(step);
      const cases = kind.cases(env, before).map((c) => ({ ...c, before: committed ? c.after : c.before, after: c.after }));
      if (!committed && cases[0].before === undefined) {
        const { store, record } = openRecordWithStore({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), host: 'mac-a', lockTimeoutMs: 5000 });
        store.recover();
        assert.equal(record.read(cases[0].entity, cases[0].id), null, 'a create killed before its diary line leaves nothing');
        assert.ok(!existsSync(join(env.root, 'lock')), 'lock is free');
        assert.deepEqual(readdirSync(join(env.root, 'tmp')), [], 'no temp files left');
        return;
      }
      // Each document must now be exactly the expected side: old if not committed, new if committed.
      checkWhole(env.root, cases.map((c) => (committed ? { ...c, before: c.after } : { ...c, after: c.before })));
    });
  }
}

test('a torn diary line is cut, alerted, and the write is lost whole', () => {
  const env = setup({ prefix: 'm9-crash-' });
  seed(env, 'card', 'C-1', { state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, head: HEAD });
  const r = run({ op: 'write', root: env.root, faultAt: 'diary_torn', w: { actor: 'workshop', entity: 'card', id: 'C-1', expectRev: 1, doc: { ...env.record.read('card', 'C-1').doc, head: HEAD2 } } });
  assert.equal(r.signal, 'SIGKILL');
  const alerts = [];
  const { store, record } = openRecordWithStore({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), host: 'mac-a', alert: (a) => alerts.push(a) });
  const report = store.recover();
  assert.ok(report.cut > 0, 'the torn bytes were cut');
  assert.ok(alerts.some((a) => a.type === 'diary_torn_line_cut'));
  assert.equal(record.read('card', 'C-1').doc.head, HEAD);
  assert.equal(store.lines().length, 1);
});

// R2-M11: stopped (not killed) inside the commit, the writer still holds the lock. A second process's recover()
// waits for it and changes nothing; once resumed, the first write completes intact.
test('SIGSTOP mid-write: recover() in another process waits and changes nothing; the write then completes', async () => {
  const env = setup({ prefix: 'm9-crash-' });
  seed(env, 'card', 'C-1', { state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, head: HEAD });
  const doc = { ...env.record.read('card', 'C-1').doc, head: HEAD2 };
  const spawnChild = (args) => {
    const c = spawn(process.execPath, [CHILD, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    const done = new Promise((res) => c.on('exit', (code, signal) => res({ code, signal, out })));
    return { c, done };
  };
  const a = spawnChild({ op: 'write', root: env.root, faultAt: { step: 'temp_written', signal: 'SIGSTOP' }, w: { actor: 'workshop', entity: 'card', id: 'C-1', expectRev: 1, doc } });
  // Wait until A is stopped (ps shows T).
  const stopped = () => /T/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(a.c.pid)], { encoding: 'utf8' }).stdout);
  for (let i = 0; i < 500 && !stopped(); i++) sleepMs(20);
  assert.ok(stopped(), 'child A should be stopped mid-write');
  const tempsWhileStopped = readdirSync(join(env.root, 'tmp'));
  assert.equal(tempsWhileStopped.length, 1, 'A has its temp file written');
  const b = spawnChild({ op: 'recover', root: env.root, lockTimeoutMs: 30000 });
  await new Promise((res) => setTimeout(res, 800));
  assert.equal(b.c.exitCode, null, 'B is still waiting for the lock');
  assert.deepEqual(readdirSync(join(env.root, 'tmp')), tempsWhileStopped, 'B removed nothing while A held the lock');
  process.kill(a.c.pid, 'SIGCONT');
  const ra = await a.done;
  const rb = await b.done;
  assert.equal(ra.code, 0, ra.out);
  assert.equal(JSON.parse(ra.out).ok, true, ra.out);
  const rep = JSON.parse(rb.out);
  assert.equal(rep.cut, 0, rb.out);
  assert.equal(rep.rolledForward.length, 0, rb.out);
  assert.equal(rep.restored.length, 0, rb.out);
  assert.equal(rep.quarantined.length, 0, rb.out);
  assert.equal(rep.tempsRemoved, 0, rb.out);
  checkWhole(env.root, [{ entity: 'card', id: 'C-1', before: doc, after: doc }]);
});

test('the fault option is a constructor argument only; an unknown step is refused', () => {
  assert.throws(() => setup({ prefix: 'm9-crash-', faultAt: 'nowhere' }), /unknown fault point/);
  assert.match(readFileSync(new URL('./store.mjs', import.meta.url), 'utf8'), /faultAt/);
  assert.doesNotMatch(readFileSync(new URL('./store.mjs', import.meta.url), 'utf8'), /process\.env/);
  void iso; void docBytes;
});
