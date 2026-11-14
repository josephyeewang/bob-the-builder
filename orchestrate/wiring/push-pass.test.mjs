// push-pass.test.mjs — the robot's push pass (lane N, N1). A Record stand-in in memory, real outbox folders, and a
// pushCard stand-in: push.mjs itself has its own tests (push.test.mjs), and the pass calls it unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { pushPass, RETRY_MS, PUSH_WAIT_CAUSE, PUSH_REFUSED_CAUSE, PUSH_TROUBLE_CAUSE, PUSH_HEAD_CAUSE, PR_WAIT_CAUSE, PR_TROUBLE_CAUSE, lastTry } from './push-pass.mjs';
import { PUSH_FACT, bundleName } from '../modules/M4-workshop/git/push.mjs';
import { HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { fakeAlert } from '../test/fake-alert.test-helper.mjs';

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
  const run = (o = {}) => pushPass({ rec, product: P, outboxRoot, pushCard, alert: fakeAlert(), now: () => now, hold, drop, ...o });
  return { root, outboxRoot, rec, put, made, holds, drops, calls, bundle, run, setAnswer: (f) => { answer = f; }, setNow: (t) => { now = t; }, clock: () => now, docs };
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

// #536 r1 M1: a push made whose card head could not be noted (head_refused) is not taken, so it is pushed again. It must
// not take the round's one slot every minute, and must not starve the sessions behind it.
test('#536 r1 M1: a session whose head could not be noted is spaced RETRY_MS and told on its own cause; the next session is pushed', async () => {
  const w = world({ sessions: 2 });
  const sha1 = w.bundle(w.made[0]); w.bundle(w.made[1]);
  // S-1 launched first, pushed a moment ago, but its head could not be noted.
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha1, head_refused: 'card C-1 could not be read', at: iso(T0 - 1000) });
  const r = await w.run();
  assert.deepEqual(w.calls, ['S-2'], 'S-1 waits its RETRY_MS; S-2 takes the slot');
  assert.deepEqual(r.pushed, ['C-2']);
  const head = w.holds.find((h) => h.cause === PUSH_HEAD_CAUSE('C-1', 'a1'));
  assert.ok(head, 'told on its own cause');
  assert.match(head.text, /was pushed, but the card's head could not be noted \(card C-1 could not be read\).*made again every 15 minutes/);
  assert.ok(!w.holds.some((h) => h.cause === PUSH_REFUSED_CAUSE('C-1', 'a1')), 'never told as refused for good');
  // Past RETRY_MS it is pushed again: once, not every round.
  w.put('fact', PUSH_FACT('C-2', 'a1'), { result: 'pushed', branch: 'card/C-2', tip: 'y', bundle_sha256: 'f'.repeat(64), at: iso(T0) });
  w.setNow(T0 + RETRY_MS);
  await w.run();
  assert.deepEqual(w.calls, ['S-2', 'S-1']);
});

test('#536 r1 M1: the line is the session tried longest ago first, never tried before all: a stuck head never starves a newer session', async () => {
  const w = world({ sessions: 3 });
  const sha1 = w.bundle(w.made[0]); const shas = { 'C-2': w.bundle(w.made[1]), 'C-3': w.bundle(w.made[2]) };
  // S-1, the oldest launch, was tried long ago (past its spacing) and is still not taken.
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha1, head_refused: 'no', at: iso(T0 - 2 * RETRY_MS) });
  // Each push leaves S-1's head refused, as a Record that can't take the head would.
  w.setAnswer((id) => {
    const card = w.rec.read('session', id).doc.card;
    if (card === 'C-1') w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha1, head_refused: 'no', at: iso(w.clock()) });
    else w.put('fact', PUSH_FACT(card, 'a1'), { result: 'pushed', branch: `card/${card}`, tip: 'y', bundle_sha256: shas[card], at: iso(w.clock()) });
    return { ok: true, branch: `card/${card}`, pr: { number: 1 } };
  });
  const r1 = await w.run();
  assert.deepEqual(w.calls, ['S-2'], 'never tried goes before tried long ago');
  assert.ok(r1.waiting.some(([c, why]) => c === 'C-1' && /later round/.test(why)));
  w.setNow(T0 + 60_000); await w.run();
  assert.deepEqual(w.calls, ['S-2', 'S-3']);
  w.setNow(T0 + 120_000); const r3 = await w.run();
  assert.deepEqual(w.calls, ['S-2', 'S-3', 'S-1'], 'then the stuck one, which is told on its head cause, not as pushed');
  assert.deepEqual(r3.pushed, []);
  assert.ok(w.holds.some((h) => h.cause === PUSH_HEAD_CAUSE('C-1', 'a1')));
  // Next round: spaced again, not pushed.
  w.setNow(T0 + 180_000); await w.run();
  assert.equal(w.calls.length, 3);
});

test('#536 r1 M1: a refusal added to a push already made (last_refusal) is spaced by its own time; a final one is not tried again', async () => {
  const w = world();
  const sha = w.bundle(w.made[0]);
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, head_refused: 'no', at: iso(T0 - 3 * RETRY_MS), last_refusal: { reason: 'GitHub is down', retry: true, at: iso(T0 - 1000) } });
  await w.run();
  assert.deepEqual(w.calls, [], 'the last refusal is a minute old: spaced');
  assert.match(w.holds.find((h) => h.cause === PUSH_WAIT_CAUSE('C-1', 'a1')).text, /GitHub is down/);
  w.setNow(T0 + RETRY_MS); await w.run();
  assert.deepEqual(w.calls, ['S-1']);
  // A final refusal of the same bytes: not tried again, however long.
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, head_refused: 'no', at: iso(T0 - 3 * RETRY_MS), last_refusal: { reason: 'a secret was found', at: iso(T0 + RETRY_MS) } });
  w.setNow(T0 + 20 * RETRY_MS); await w.run();
  assert.deepEqual(w.calls, ['S-1']);
  assert.equal(w.holds.at(-1).cause, PUSH_REFUSED_CAUSE('C-1', 'a1'));
  assert.deepEqual(lastTry({ result: 'pushed', at: 'x', last_refusal: { at: iso(T0), reason: 'r' } }, T0), { at: T0, refusal: { reason: 'r', retry: false } });
  assert.deepEqual(lastTry({ result: 'pushed', at: iso(T0), last_refusal: { at: iso(T0 - 5), reason: 'r' } }, T0), { at: T0, refusal: null }, 'a refusal before the push is not the last answer');
});

test('#536 r1 M1: a push that answers ok but leaves its head unnoted is told on the head cause, not counted as pushed', async () => {
  const w = world();
  const sha = w.bundle(w.made[0]);
  w.setAnswer(() => { w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, head_refused: 'the card was busy', at: iso(T0) }); return { ok: true, branch: 'card/C-1', pr: { number: 2 } }; });
  const r = await w.run();
  assert.deepEqual(r.pushed, []);
  assert.match(w.holds.find((h) => h.cause === PUSH_HEAD_CAUSE('C-1', 'a1')).text, /the card was busy/);
  // Once the head is noted, the bundle is taken: its holds, the head's too, are cleared.
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, at: iso(T0) });
  w.setNow(T0 + 60_000); await w.run();
  assert.ok(w.drops.includes(HOLD_FACT(PUSH_HEAD_CAUSE('C-1', 'a1'))));
});

// #536 r1 m6: a bundle stamped ahead of the clock would wait for ever, untold.
test('#536 r1 m6: a bundle stamped in the future is told and not pushed; once the clock passes it, it is', async () => {
  const w = world();
  w.bundle(w.made[0], 'b', T0 + 3600_000);
  const r = await w.run();
  assert.deepEqual(w.calls, []);
  assert.deepEqual(r.waiting, [['C-1', 'the bundle is stamped in the future']]);
  assert.match(w.holds.find((h) => h.cause === PUSH_TROUBLE_CAUSE('S-1')).text, /stamped 3600 s in the future/);
  w.setNow(T0 + 3600_000 + 60_000); await w.run();
  assert.deepEqual(w.calls, ['S-1']);
});

// #536 r1 c2 (plant P20): a final refusal clears the wait hold an earlier retry left.
test('#536 r1 c2: a final refusal clears the wait hold, so the session is told once, as refused', async () => {
  const w = world();
  w.bundle(w.made[0]);
  w.setAnswer(() => ({ ok: false, reason: 'touches files no card may' }));
  await w.run();
  assert.ok(w.drops.includes(HOLD_FACT(PUSH_WAIT_CAUSE('C-1', 'a1'))));
  assert.equal(w.holds.at(-1).cause, PUSH_REFUSED_CAUSE('C-1', 'a1'));
});

// #536 r1 (plant P22): whether the bundle was taken can't be told, so it is not pushed.
test('#536 r1 P22: a bundle that can\'t be read to check it against its push is told and not pushed', async () => {
  const w = world();
  const sha = w.bundle(w.made[0]);
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, at: iso(T0 - 2 * RETRY_MS) });
  await w.run({ hashOf: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } });
  assert.deepEqual(w.calls, []);
  assert.match(w.holds.at(-1).text, /can't be told \(file-unreadable\)/);
});

// #536 r1 (plant P8): bytes already taken are never pushed again, however long after; the new spacing must not hide it.
test('#536 r1 P8: a bundle its push already took is not pushed again, long after the push', async () => {
  const w = world();
  const sha = w.bundle(w.made[0]);
  w.put('fact', PUSH_FACT('C-1', 'a1'), { result: 'pushed', branch: 'card/C-1', tip: 'x', bundle_sha256: sha, at: iso(T0 - 50 * RETRY_MS) });
  await w.run();
  assert.deepEqual(w.calls, []);
  assert.ok(w.drops.includes(HOLD_FACT(PUSH_HEAD_CAUSE('C-1', 'a1'))));
});
