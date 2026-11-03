// review-told-once.test.mjs — L315 (class audit "told once ever while still waiting"): the review holds that
// were told to the owner once and never again while they lasted. Each now goes through the shared stillWaiting check:
// quiet 2 hours on, told again 25 hours on while the trouble holds, and the mark cleared once it ends, so the same
// trouble coming back is told again.
//
// The runner cases run end to end: the real review runner pass (M4) writes its real status file, the Dispatcher's real
// reviewPorts read it, and the real timeLimits asks for reviews and relays the alerts through the real outbox, which
// marks one told only once a copy is delivered. Only the outside world (processes, the admin check, the Record's take
// of a verdict) is a stand-in, and the throwaway folders belong to this test's user, standing in for the review user.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { reviewPorts, relayReviewAlerts, REVIEW_HOLD_FACT } from './review-requests.mjs';
import { outbox, isQueued } from './alerts.mjs';
import { timeLimits } from './merges.mjs';
import { intakePass } from './outbox-intake.mjs';
import { rulesWith, recWith, setClock, withAlerts, iso, T0 } from './fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME };
const HEAD = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const MAIN = 'f'.repeat(40);
const CLAUDE = '/pinned/claude';
const H = 60 * 60_000;
const R = rulesWith();
const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };

// One Mac: a review runner and a Dispatcher sharing one Record, one card in review and one clock. `hour(h)` runs the
// runner's pass and then the Dispatcher's at T0 + h hours and answers the texts delivered to Joe in that pass.
function mac(over = {}) {
  const base = tempDir('m11-told-once-');
  const root = join(base, 'review');
  mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  mkdirSync(join(base, 'outbox'), { mode: 0o755 }); chmodSync(join(base, 'outbox'), 0o755);
  const rec = recWith([['card', 'C-1', { state: 'in_review', product: 'p1', head: HEAD, tier: 2, changed_at: iso(T0 - H) }]]);
  const clock = { t: T0 };
  const live = [];
  const starts = [];
  let n = 0;
  let pid = 1000;
  const ctx = {
    root, outboxRoot: join(base, 'outbox'), uids: UIDS, reviewHome: join(base, 'review-home'), claudeBin: CLAUDE,
    processName: (p) => { const s = live.find((x) => x.pid === p); return s ? `${CLAUDE} --session-id ${s.sessionId}` : null; },
    now: () => clock.t, ownUid: () => ME, newId: () => `S-${++n}`,
    isAdmin: async () => false,
    readCard: (c) => { const d = rec.read('card', c)?.doc; return d ? { ok: true, doc: d } : { ok: false }; },
    currentHead: (c) => rec.read('card', c)?.doc?.head,
    treeOf: async () => TREE,
    setAsideByJoe: () => [],
    sessions: async () => live.slice(),
    stop: async (s) => { const i = live.findIndex((x) => x.pid === s.pid); if (i >= 0) live.splice(i, 1); },
    // As the real wiring does before it spawns claude: the review package is written and its sha256 handed back.
    start: async (x) => {
      starts.push(x);
      mkdirSync(x.packageDir, { mode: 0o755 });
      writeFileSync(join(x.packageDir, 'change.diff'), 'd\n', { mode: 0o644, flag: 'wx' });
      const p = ++pid;
      live.push({ pid: p, sessionId: x.sessionId });
      return { ok: true, pid: p, package_sha256: createHash('sha256').update('d\n').digest('hex') };
    },
    accountInUse: () => 'a',
    handedIn: () => ({ ok: true, verdict: { sha256: 'e'.repeat(64) } }),
    verdictTaken: () => ({ ok: true }),
    ...over,
  };
  let q = 0;
  const ports = reviewPorts({ requests: join(root, 'requests'), status: join(root, 'status.json'), reviewUid: ME, now: () => clock.t, newId: () => `q-${++q}`, mainHead: () => MAIN });
  const hour = async (h) => {
    clock.t = T0 + h * H;
    setClock(rec, clock.t);
    await runnerPass(ctx);
    const got = [];
    await withAlerts(rec, clock.t, (t) => { got.push(t); return true; }, (alert) => timeLimits({ rec, rules: R, now: clock.t, b: GREEN, alert, ...ports, gateAlive: () => true }));
    return got;
  };
  // Every hour from `from` to `to`, the texts told that match `re`, with the hour each was told.
  const run = async (from, to, re) => { const out = []; for (let h = from; h <= to; h += 1) for (const t of await hour(h)) if (re.test(t)) out.push(h); return out; };
  return { base, root, rec, ctx, clock, live, starts, hour, run, card: () => rec.read('card', 'C-1').doc };
}

test('L315: a review user that is an admin is told again a day later while it lasts, and again if it comes back after a fix', async () => {
    const m = mac();
    const ADMIN = /review runner: The review user is an admin Mac user/;
    // The runner has run once as it should (its folders are made); then the review user becomes an admin, before the
    // Dispatcher's ask is taken. (On a fresh install with an admin, the runner makes no request folder, every ask
    // fails, and the card goes to Joe after two: that path is told, through joe-waits.)
    await m.hour(0);
    m.ctx.isAdmin = async () => true;
    // The hold, as it is today: no review starts, the request file is written fine every time, so the card never
    // counts a failed ask and never waits on Joe. It sits in review.
    assert.deepEqual(await m.run(1, 3, ADMIN), [1], 'told once; quiet 2 hours on');
    assert.equal(m.starts.length, 0);
    assert.equal(m.card().state, 'in_review');
    assert.equal(m.card().attempts?.reviewer_starts ?? 0, 0, 'every ask "succeeded", so no failure is counted');
    assert.deepEqual(await m.run(4, 26, ADMIN), [25], 'told again a day after it was first told, while it still holds');
    // Fixed: a reviewer starts, and the mark is cleared, so the trouble coming back is told again.
    m.ctx.isAdmin = async () => false;
    await m.hour(27);
    assert.equal(m.starts.length, 1);
    m.ctx.isAdmin = async () => true;
    assert.deepEqual(await m.run(28, 29, ADMIN), [28]);
  });

test('L315: a review runner memory file that can\'t be read is told again a day later while it lasts, and again after a fix', async () => {
    const m = mac();
    const CORRUPT = /review runner: The review runner's memory file can't be read/;
    await m.hour(0);
    writeFileSync(join(m.root, 'state.json'), '{', { mode: 0o600 });
    assert.deepEqual(await m.run(1, 3, CORRUPT), [1], 'told once; quiet 2 hours on');
    assert.equal(m.card().state, 'in_review');
    assert.deepEqual(await m.run(4, 26, CORRUPT), [25], 'told again a day later, while the file still can\'t be read');
    // Joe moves the file aside; the runner starts afresh. Spoiled again later: told again.
    rmSync(join(m.root, 'state.json'));
    await m.hour(27);
    writeFileSync(join(m.root, 'state.json'), '{', { mode: 0o600 });
    assert.deepEqual(await m.run(28, 29, CORRUPT), [28]);
  });

test('L315: a verdict the Record has not taken is told again a day later while it is still not taken, and never once it is', async () => {
    let taken = { ok: false, reason: 'the Record holds no verdict of session S-1' };
    const m = mac({ verdictTaken: () => taken });
    const NOT_TAKEN = /review runner: The reviewer for card C-1 at aaaaaaa handed in a verdict the Record has not taken/;
    // The Dispatcher first asks at hour 1 (its clock is the card's last write, at T0); the runner starts the reviewer at
    // hour 2, which then ends, having handed in a verdict.
    for (let h = 0; h <= 2; h += 1) await m.hour(h);
    assert.equal(m.starts.length, 1, 'the reviewer started');
    m.live.splice(0);
    // The Record never takes it: the card stays in review, and the Dispatcher's every ask is refused as a start
    // already made, with no failure counted. Hour 3 sees the end; hour 4 is past the intake wait.
    assert.deepEqual(await m.run(3, 6, NOT_TAKEN), [4], 'told once, the first pass after the intake wait; quiet 2 hours on');
    assert.equal(m.card().state, 'in_review');
    assert.equal(m.card().attempts?.reviewer_starts ?? 0, 0);
    assert.equal(m.starts.length, 1);
    assert.deepEqual(await m.run(7, 28, NOT_TAKEN), [28], 'told again a day later, while still not taken');
    taken = { ok: true };
    assert.deepEqual(await m.run(29, 55, NOT_TAKEN), [], 'taken: never told again');
  });

// The Dispatcher's own alerts from the status (M11 statusAlerts): a status file written as the runner would.
function statusMac() {
  const dir = tempDir('m11-told-once-st-');
  const file = join(dir, 'status.json');
  const rec = recWith();
  const clock = { t: T0 };
  let say = { ok: true, error: null, installed_commit: MAIN };
  let main = { commit: MAIN, since: T0 };
  let unreadable = false;
  const ports = reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => clock.t, mainHead: () => main });
  const hour = async (h) => {
    clock.t = T0 + h * H;
    setClock(rec, clock.t);
    writeFileSync(file, unreadable ? '{' : JSON.stringify({ written_at: iso(clock.t), running: [], alerts: [], ...say }), { mode: 0o644 });
    chmodSync(file, 0o644);
    const got = [];
    await withAlerts(rec, clock.t, (t) => { got.push(t); return true; }, (alert) => timeLimits({ rec, rules: R, now: clock.t, b: GREEN, alert, ...ports, gateAlive: () => true }));
    return got;
  };
  const run = async (from, to, re) => { const out = []; for (let h = from; h <= to; h += 1) for (const t of await hour(h)) if (re.test(t)) out.push(h); return out; };
  return { set: (s) => { say = { ...say, ...s }; }, setMain: (x) => { main = x; }, unreadable: (u) => { unreadable = u; }, hour, run };
}

const FAILED = /review runner: Its last pass failed: the requests could not be listed \(EACCES\)/;
const EACCES = { ok: false, error: 'the requests could not be listed (EACCES)' };

test('L315: a runner pass that keeps failing is told again a day later', async () => {
    const s = statusMac();
    s.set(EACCES);
    assert.deepEqual(await s.run(0, 2, FAILED), [0], 'told once; quiet 2 hours on');
    assert.deepEqual(await s.run(3, 25, FAILED), [24], 'told again a day later, while every pass still fails');
  });

test('L315: a runner error that stopped and later comes back is told again at once', async () => {
    const s = statusMac();
    s.set(EACCES);
    assert.deepEqual(await s.run(0, 1, FAILED), [0]);
    // Fixed: passes succeed for 3 hours. Then the same error comes back: told again, at once.
    s.set({ ok: true, error: null });
    assert.deepEqual(await s.run(2, 4, FAILED), []);
    s.set(EACCES);
    assert.deepEqual(await s.run(5, 6, FAILED), [5], 'the same error back after it stopped');
  });

test('L315 (minor): an installed review copy that stays behind main is told again a day later', async () => {
    const s = statusMac();
    const BEHIND = /review runner: Its installed copy is at aaaaaaa, but main is at fffffff/;
    s.set({ installed_commit: HEAD });
    s.setMain({ commit: MAIN, since: T0 - H });
    assert.deepEqual(await s.run(0, 2, BEHIND), [0], 'told once; quiet 2 hours on');
    assert.deepEqual(await s.run(3, 25, BEHIND), [24], 'told again a day later, while the copy is still behind');
  });

test('L315 (minor): a Lead\'s read-only request whose start keeps being refused reaches Joe once it has waited a day', async () => {
    const root = tempDir('m11-told-once-ob-');
    const ob = join(root, 'lead');
    mkdirSync(ob, { recursive: true });
    writeFileSync(join(ob, 'think-q9.md'), 'Is B safe?');
    const rec = recWith();
    const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: ME, product: 'p1' }];
    let allow = false;
    const told = { joe: [], lead: [] };
    const hour = async (h) => {
      const now = T0 + h * H;
      setClock(rec, now);
      await withAlerts(rec, now, (t) => { told.joe.push([h, t]); return true; }, (alert) => intakePass({
        rec, sessions, now, wait: async () => {}, alert, note: () => {},
        startReadonly: () => (allow ? { ok: true } : { ok: false, reason: 'cap 4' }),
        replyToLead: (x) => told.lead.push([h, x.text]),
      }));
    };
    for (let h = 0; h <= 2; h += 1) await hour(h);
    assert.deepEqual(told.lead.map(([h]) => h), [0], 'the Lead is told once that it is queued');
    assert.deepEqual(told.joe, [], 'quiet 2 hours on');
    for (let h = 3; h <= 25; h += 1) await hour(h);
    assert.deepEqual(told.joe.filter(([, t]) => /think-q9\.md/.test(t)).map(([h]) => h), [24], 'Joe is told once it has waited a day');
    allow = true;
    for (let h = 26; h <= 50; h += 1) await hour(h);
    assert.equal(rec.read('fact', 'intake-applied-L-1-think-q9.md').doc.state, 'applied');
    assert.equal(told.joe.filter(([, t]) => /think-q9\.md/.test(t)).length, 1, 'started: not told again');
  });

test('L315: a verdict not taken stays a hold on passes with no request, and through a pass that stops at the admin check', async () => {
  const m = mac({ verdictTaken: () => ({ ok: false, reason: 'the Record holds no verdict' }) });
  for (const h of [0, 1, 2]) await m.hour(h);
  m.live.splice(0);
  for (const h of [3, 4]) await m.hour(h);
  const notTaken = () => JSON.parse(readFileSync(join(m.root, 'status.json'), 'utf8')).holds.filter((x) => x.id.startsWith('not-taken-'));
  assert.equal(notTaken().length, 1);
  // A runner pass alone: nothing asks, so no request is waiting, and the hold is still listed.
  await runnerPass(m.ctx);
  assert.equal(readdirSync(join(m.root, 'requests')).length, 0);
  assert.equal(notTaken().length, 1);
  m.ctx.isAdmin = async () => true;
  await runnerPass(m.ctx);
  assert.equal(notTaken().length, 1, 'the pass stopped early and kept it');
});

test('L315: a verdict not taken on a head the card has left is no longer a hold', async () => {
  const m = mac({ verdictTaken: () => ({ ok: false, reason: 'the Record holds no verdict' }) });
  for (const h of [0, 1, 2]) await m.hour(h);
  m.live.splice(0);
  for (const h of [3, 4]) await m.hour(h);
  const had = m.ctx.readCard;
  m.ctx.readCard = (c) => { const r = had(c); return { ...r, doc: { ...r.doc, head: 'b'.repeat(40) } }; };
  await runnerPass(m.ctx);
  assert.deepEqual(JSON.parse(readFileSync(join(m.root, 'status.json'), 'utf8')).holds, []);
});

test('L315: a status that can\'t be read clears no hold; the hold is not told afresh when it reads again', async () => {
  const s = statusMac();
  s.set(EACCES);
  assert.deepEqual(await s.run(0, 1, FAILED), [0]);
  s.unreadable(true);
  await assert.rejects(s.hour(2), /status can't be read/);
  s.unreadable(false);
  assert.deepEqual(await s.run(4, 5, FAILED), [], 'still the same trouble, still marked');
});

test('L315: another error is told at once, not held by the last one\'s mark', async () => {
  const s = statusMac();
  s.set(EACCES);
  assert.deepEqual(await s.run(0, 1, FAILED), [0]);
  s.set({ ok: false, error: 'the disk is full' });
  assert.deepEqual(await s.run(2, 3, /Its last pass failed: the disk is full/), [2]);
});

test('L315: a hold that ends while its alert is queued leaves the queue unsent', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('review-admin');
  const hold = { id: 'review-admin', hold: true, text: 'The review user is an admin Mac user.' };
  assert.equal(relayReviewAlerts({ rec, alerts: [hold], alert: outbox(rec, T0), now: T0 }), 1);
  assert.equal(isQueued(rec, fact), true);
  assert.equal(relayReviewAlerts({ rec, alerts: [], alert: outbox(rec, T0 + H), now: T0 + H }), 0);
  assert.equal(isQueued(rec, fact), false);
});

test('L315: a Lead\'s request that starts leaves its queued tell unsent', async () => {
  const root = tempDir('m11-told-once-ob2-');
  const ob = join(root, 'lead');
  mkdirSync(ob, { recursive: true });
  writeFileSync(join(ob, 'think-q9.md'), 'Is B safe?');
  const rec = recWith();
  const sessions = [{ sessionId: 'L-1', role: 'lead', outbox: ob, uid: ME, product: 'p1' }];
  const pass = (h, startReadonly) => {
    setClock(rec, T0 + h * H);
    return intakePass({ rec, sessions, now: T0 + h * H, wait: async () => {}, alert: outbox(rec, T0 + h * H), note: () => {}, startReadonly, replyToLead: () => {} });
  };
  const applied = 'intake-applied-L-1-think-q9.md';
  await pass(0, () => ({ ok: false, reason: 'cap 4' }));
  await pass(25, () => ({ ok: false, reason: 'cap 4' }));
  assert.equal(isQueued(rec, applied), true);
  await pass(26, () => ({ ok: true }));
  assert.equal(isQueued(rec, applied), false);
});
