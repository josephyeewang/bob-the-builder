// push-pass.test.mjs — the robot's push pass (lane N, N1). A Record stand-in in memory, real outbox folders, and a
// pushCard stand-in: push.mjs itself has its own tests (push.test.mjs), and the pass calls it unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { pushPass, RETRY_MS, PUSH_WAIT_CAUSE, PUSH_REFUSED_CAUSE, PUSH_TROUBLE_CAUSE, PR_WAIT_CAUSE, PR_TROUBLE_CAUSE } from './push-pass.mjs';
import { PUSH_FACT, bundleName } from '../modules/M4-workshop/git/push.mjs';
import { HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';

const P = 'app';
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function world({ sessions = 1 } = {}) {
  const root = tempDir('orch-pushpass-');
  const outboxRoot = join(root, 'outboxes');
  const docs = new Map();   // `${entity}/${id}` -> { id, doc, corrupt? }
  const rec = {
    read: (e, id) => docs.get(`${e}/${id}`) ?? null,
    list: (e) => [...docs.entries()].filter(([k, v]) => k.startsWith(`${e}/`) && !v.corrupt).map(([, v]) => v),
  };
  const put = (e, id, doc, extra = {}) => docs.set(`${e}/${id}`, { id, doc, ...extra });
  const made = [];
  for (let i = 1; i <= sessions; i++) {
    const id = `S-${i}`; const card = `C-${i}`;
    const outbox = join(outboxRoot, P, 'worker', id);
    mkdirSync(outbox, { recursive: true });
    put('session', id, { state: 'running', role: 'worker', product: P, card, branch: `card/${card}`, outbox, attempt: 'a1', launched_at: iso(T0 - (100 - i) * 1000) });
    made.push({ id, card, outbox });
  }
  const holds = []; const drops = [];
  const hold = ({ cause, text }) => { holds.push({ cause, text }); return true; };
  const drop = (_rec, fact) => { drops.push(fact); return true; };
  const calls = [];
  let answer = (id) => ({ ok: true, branch: `card/${rec.read('session', id).doc.card}`, pr: { number: 7 } });
  const pushCard = async (id) => { calls.push(id); return answer(id); };
  const bundle = (s, bytes = 'bundle-bytes', mtime = T0 - 60_000) => {
    const p = join(s.outbox, bundleName(s.card));
    writeFileSync(p, bytes);
    utimesSync(p, mtime / 1000, mtime / 1000);
    return createHash('sha256').update(bytes).digest('hex');
  };
  let now = T0;
  const run = (o = {}) => pushPass({ rec, product: P, outboxRoot, pushCard, alert: () => true, now: () => now, hold, drop, ...o });
  return { root, outboxRoot, rec, put, made, holds, drops, calls, bundle, run, setAnswer: (f) => { answer = f; }, setNow: (t) => { now = t; }, docs };
}

test('a settled bundle is pushed once; its holds are cleared; taken bytes are not pushed again', async () => {
  const w = world();
  const [s] = w.made;
  const sha = w.bundle(s);
  const r = await w.run();
  assert.deepEqual(w.calls, ['S-1']);
  assert.deepEqual(r.pushed, ['C-1']);
  assert.ok(w.drops.includes(HOLD_FACT(PUSH_WAIT_CAUSE('C-1', 'a1'))));
  assert.ok(w.drops.includes(HOLD_FACT(PUSH_REFUSED_CAUSE('C-1', 'a1'))));
  // The push script writes this fact; the next round reads it through the drain's own rule.
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, at: iso(T0) });
  await w.run();
  assert.deepEqual(w.calls, ['S-1'], 'not pushed again');
  // New bytes from the worker are a new push.
  w.bundle(s, 'new-bytes');
  await w.run();
  assert.deepEqual(w.calls, ['S-1', 'S-1']);
});

test('a bundle changed a moment ago waits a round, untold', async () => {
  const w = world();
  w.bundle(w.made[0], 'b', T0 - 500);
  const r = await w.run();
  assert.deepEqual(w.calls, []);
  assert.equal(r.waiting.length, 1);
  assert.equal(w.holds.length, 0);
});

test('no outbox or no bundle: nothing to push, nothing told', async () => {
  const w = world({ sessions: 2 });
  rmSync(w.made[0].outbox, { recursive: true });
  const r = await w.run();
  assert.deepEqual(w.calls, []);
  assert.equal(w.holds.length, 0);
  assert.deepEqual(r, { pushed: [], waiting: [], refused: [], prs: [], told: 0, untold: [] });
});

test('another product\'s session, and a role with no card work, are left alone', async () => {
  const w = world({ sessions: 2 });
  w.bundle(w.made[0]); w.bundle(w.made[1]);
  w.put('session', 'S-1', { ...w.rec.read('session', 'S-1').doc, product: 'other' });
  w.put('session', 'S-2', { ...w.rec.read('session', 'S-2').doc, role: 'reviewer' });
  await w.run();
  assert.deepEqual(w.calls, []);
});

test('a refusal that may pass waits RETRY_MS, told on the hold cadence, then is tried again', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.setAnswer(() => ({ ok: false, retry: true, reason: 'the start gate is shut: x' }));
  await w.run();
  assert.deepEqual(w.calls, ['S-1']);
  assert.equal(w.holds.at(-1).cause, PUSH_WAIT_CAUSE('C-1', 'a1'));
  assert.match(w.holds.at(-1).text, /start gate is shut/);
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'refused', reason: 'the start gate is shut: x', retry: true, at: iso(T0) });
  w.setNow(T0 + RETRY_MS - 1);
  await w.run();
  assert.deepEqual(w.calls, ['S-1'], 'not before RETRY_MS');
  assert.equal(w.holds.at(-1).cause, PUSH_WAIT_CAUSE('C-1', 'a1'), 'still told (holdAlert decides if today)');
  w.setNow(T0 + RETRY_MS);
  await w.run();
  assert.deepEqual(w.calls, ['S-1', 'S-1']);
});

test('a final refusal is told, and the same bytes are never tried again; new bytes are', async () => {
  const w = world();
  w.bundle(w.made[0], 'b', T0 - 60_000);
  w.setAnswer(() => ({ ok: false, reason: 'the branch touches files no card may: .github/workflows/x.yml' }));
  await w.run();
  assert.equal(w.holds.at(-1).cause, PUSH_REFUSED_CAUSE('C-1', 'a1'));
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'refused', reason: 'the branch touches files no card may', at: iso(T0) });
  w.setNow(T0 + 10 * RETRY_MS);
  await w.run();
  assert.equal(w.calls.length, 1, 'same bytes: not again, however long');
  assert.equal(w.holds.at(-1).cause, PUSH_REFUSED_CAUSE('C-1', 'a1'), 're-told on the hold cadence (I3)');
  w.bundle(w.made[0], 'fixed', T0 + 5 * RETRY_MS);
  await w.run();
  assert.equal(w.calls.length, 2, 'new bytes: tried');
});

test('a refusal dated in the future is not believed: the push is tried now (I4)', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'refused', reason: 'x', at: iso(T0 + 3600_000) });
  await w.run();
  assert.deepEqual(w.calls, ['S-1']);
});

test('a push record that can\'t be read is told, and nothing is pushed (I1)', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.put('fact', PUSH_FACT('C-1', 'a1'), null, { corrupt: true });
  await w.run();
  assert.deepEqual(w.calls, []);
  assert.equal(w.holds.at(-1).cause, PUSH_TROUBLE_CAUSE('S-1'));
});

test('a session list that can\'t be read fails the pass (I1)', async () => {
  const w = world();
  w.rec.list = () => { throw new Error('store damaged'); };
  await assert.rejects(w.run(), /store damaged/);
  w.rec.list = () => undefined;
  await assert.rejects(w.run(), /could not be read/);
});

test('a push script that throws is a wait, told', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.setAnswer(() => { throw new Error('boom'); });
  const r = await w.run();
  assert.equal(r.waiting.length, 1);
  assert.equal(w.holds.at(-1).cause, PUSH_WAIT_CAUSE('C-1', 'a1'));
  assert.match(w.holds.at(-1).text, /boom/);
});

test('pushed with no pull request is told: Joe would never hear of the work', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.setAnswer(() => ({ ok: true, branch: 'card/C-1', pr: null }));
  await w.run();
  assert.equal(w.holds.at(-1).cause, PR_WAIT_CAUSE('card/C-1'));
  assert.match(w.holds.at(-1).text, /no pull request/);
});

test('one push a round, oldest launch first; the rest wait for the next round', async () => {
  const w = world({ sessions: 2 });
  w.bundle(w.made[0]); w.bundle(w.made[1]);
  const r = await w.run();
  assert.deepEqual(w.calls, ['S-1']);
  assert.deepEqual(r.waiting, [['C-2', 'its turn is a later round']]);
});

test('an outbox outside the outbox root is told and never read (I6)', async () => {
  const w = world();
  const elsewhere = join(w.root, 'elsewhere', P, 'worker', 'S-1');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, bundleName('C-1')), 'b');
  w.put('session', 'S-1', { ...w.rec.read('session', 'S-1').doc, outbox: elsewhere });
  await w.run();
  assert.deepEqual(w.calls, []);
  assert.equal(w.holds.at(-1).cause, PUSH_TROUBLE_CAUSE('S-1'));
});

test('an outbox linked elsewhere is told, not followed (I6)', async () => {
  const w = world();
  const real = join(w.root, 'real');
  mkdirSync(real);
  rmSync(w.made[0].outbox, { recursive: true });
  symlinkSync(real, w.made[0].outbox);
  await w.run();
  assert.deepEqual(w.calls, []);
  assert.equal(w.holds.at(-1).cause, PUSH_TROUBLE_CAUSE('S-1'));
});

test('a session record with no card or attempt is told', async () => {
  const w = world();
  w.put('session', 'S-1', { ...w.rec.read('session', 'S-1').doc, attempt: null });
  await w.run();
  assert.equal(w.holds.at(-1).cause, PUSH_TROUBLE_CAUSE('S-1'));
});

test('a hold the queue refused is said in untold, so the failed-pass tell carries it (I5)', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.setAnswer(() => ({ ok: false, reason: 'refused' }));
  const r = await w.run({ hold: () => false });
  assert.deepEqual(r.untold, [PUSH_REFUSED_CAUSE('C-1', 'a1')]);
});

// ── Step 6: pull requests a push left unopened (L1082 Q6) ──
function prsStub(answers) {
  const calls = [];
  return { calls, retryPending: async (a) => { calls.push(a); const x = answers.shift(); if (x instanceof Error) throw x; return x ?? { opened: [], waiting: [], unreadable: [] }; } };
}

test('step 6: a pending pull request still waiting is told on its branch; once open, its hold is cleared', async () => {
  const w = world();
  const prs = prsStub([{ opened: [], waiting: [['card/c-1', 'GitHub answered 502', '2026-11-13T11:00:00.000Z']], unreadable: [] }, { opened: ['card/c-1'], waiting: [], unreadable: [] }]);
  const getToken = async () => 'tok';
  await w.run({ prs, getToken, repos: ['o/r'] });
  assert.equal(prs.calls[0].every, RETRY_MS);
  assert.deepEqual(prs.calls[0].repos, ['o/r']);
  assert.equal(prs.calls[0].getToken, getToken);
  assert.equal(w.holds.at(-1).cause, PR_WAIT_CAUSE('card/c-1'));
  assert.match(w.holds.at(-1).text, /not open yet: GitHub answered 502/);
  const r = await w.run({ prs, getToken, repos: ['o/r'] });
  assert.deepEqual(r.prs, ['card/c-1']);
  assert.ok(w.drops.includes(HOLD_FACT(PR_WAIT_CAUSE('card/c-1'))));
});

test('step 6: a retry that can\'t run is told, and a pending record that can\'t be read is told (I1)', async () => {
  const w = world();
  const prs = prsStub([new Error('facts unreadable'), { opened: [], waiting: [], unreadable: ['push.pr-open.card-c-1.pending'] }]);
  await w.run({ prs, repos: ['o/r'] });
  assert.equal(w.holds.at(-1).cause, PR_TROUBLE_CAUSE);
  assert.match(w.holds.at(-1).text, /facts unreadable/);
  await w.run({ prs, repos: ['o/r'] });
  assert.equal(w.holds.at(-1).cause, PR_TROUBLE_CAUSE);
  assert.match(w.holds.at(-1).text, /can't be read/);
});

test('step 6: a push that opened its pull request clears the branch\'s hold', async () => {
  const w = world();
  w.bundle(w.made[0]);
  await w.run();
  assert.ok(w.drops.includes(HOLD_FACT(PR_WAIT_CAUSE('card/C-1'))));
});

test('a kill between the push and its fact: no fact, so the next round pushes again (push.mjs finds the branch there)', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.setAnswer(() => { throw new Error('killed'); });
  await w.run();
  w.setAnswer(() => ({ ok: true, branch: 'card/c-1', pr: { number: 3 } }));
  const r = await w.run();
  assert.deepEqual(w.calls, ['S-1', 'S-1'], 'no fact was written, so the next round tries at once, not after RETRY_MS');
  assert.deepEqual(r.pushed, ['C-1']);
});
