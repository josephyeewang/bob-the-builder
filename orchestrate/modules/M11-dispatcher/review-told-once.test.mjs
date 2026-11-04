// review-told-once.test.mjs — L315 (class audit "told once ever while still waiting"): the review holds that
// were told to the owner once and never again while they lasted. Each now goes through the shared stillWaiting check:
// quiet 2 hours on, told again 25 hours on while the trouble holds, and the mark cleared an hour after it ends, so the
// same trouble coming back a day after its last tell is told again. A trouble that comes and goes is one trouble (L437).
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
import { reviewPorts, relayReviewAlerts, REVIEW_HOLD_FACT, HOLD_ABSENT_MS, MAIN_UNREAD } from './review-requests.mjs';
import { behindSince, nextMainSeen } from '../M4-workshop/launcher/install-check.mjs';
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
    // Fixed: a reviewer starts, and the mark is cleared after an hour off the list. Back again: told a day after the last tell.
    m.ctx.isAdmin = async () => false;
    await m.run(27, 29, ADMIN);
    assert.equal(m.starts.length, 1);
    m.ctx.isAdmin = async () => true;
    assert.deepEqual(await m.run(30, 49, ADMIN), [49]);
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
    await m.run(27, 29, CORRUPT);
    writeFileSync(join(m.root, 'state.json'), '{', { mode: 0o600 });
    assert.deepEqual(await m.run(30, 49, CORRUPT), [49]);
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
  const ports = reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => clock.t, mainHead: () => (typeof main === 'function' ? main() : main) });
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
  return { rec, set: (s) => { say = { ...say, ...s }; }, setMain: (x) => { main = x; }, unreadable: (u) => { unreadable = u; }, hour, run };
}

const FAILED = /review runner: Its last pass failed: the requests could not be listed \(EACCES\)/;
const EACCES = { ok: false, error: 'the requests could not be listed (EACCES)' };

test('L315: a runner pass that keeps failing is told again a day later', async () => {
    const s = statusMac();
    s.set(EACCES);
    assert.deepEqual(await s.run(0, 2, FAILED), [0], 'told once; quiet 2 hours on');
    assert.deepEqual(await s.run(3, 25, FAILED), [24], 'told again a day later, while every pass still fails');
  });

test('L315, L437: a runner error that stopped and comes back is told again once a day has passed since its last tell', async () => {
    const s = statusMac();
    s.set(EACCES);
    assert.deepEqual(await s.run(0, 1, FAILED), [0]);
    // Fixed: passes succeed for 3 hours, so the mark clears. The same error back within the day is not told again.
    s.set({ ok: true, error: null });
    assert.deepEqual(await s.run(2, 4, FAILED), []);
    s.set(EACCES);
    assert.deepEqual(await s.run(5, 6, FAILED), [], 'told 5 hours ago');
    s.set({ ok: true, error: null });
    await s.run(7, 29, FAILED);
    s.set(EACCES);
    assert.deepEqual(await s.run(30, 31, FAILED), [30], 'the same error back a day on: told at once');
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
  const m = mac({ verdictTaken: () => ({ ok: false, reason: 'the Record holds no verdict' }), treeOf: async (c, h) => (h === HEAD ? TREE : 'd'.repeat(40)) });
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
  assert.equal(isQueued(rec, fact), true, 'off the list for less than the hour');
  const later = T0 + H + HOLD_ABSENT_MS;
  assert.equal(relayReviewAlerts({ rec, alerts: [], alert: outbox(rec, later), now: later }), 0);
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

// L437: a hold that comes and goes is one trouble. Each repro from the #181 audit, told at most once a day.
const FAILED_ANY = /review runner: Its last pass failed/;
const tellsOver = async (s, hours, re, each) => {
  const out = [];
  for (const h of hours) { each(h); for (const t of await s.hour(h)) if (re.test(t)) out.push(h); }
  return out;
};
const range = (to, step = 1) => Array.from({ length: Math.round(to / step) + 1 }, (_, i) => i * step);

test('L437 flood: a runner failure on every other pass is told once a day', async () => {
  const s = statusMac();
  const told = await tellsOver(s, range(48), FAILED_ANY, (h) => s.set(h % 2 === 0 ? EACCES : { ok: true, error: null }));
  assert.deepEqual(told, [0, 24, 48]);
});

test('L437 flood: a runner failure on 1 pass in 3, at 5 minutes a pass, is told once in 6 hours', async () => {
  const s = statusMac();
  let i = 0;
  const told = await tellsOver(s, range(6, 1 / 12), FAILED_ANY, () => { s.set(i % 3 === 0 ? EACCES : { ok: true, error: null }); i += 1; });
  assert.equal(told.length, 1);
});

test('L437 flood: an error alternating between A and "A; B" is told once a day', async () => {
  const s = statusMac();
  const told = await tellsOver(s, range(48), FAILED_ANY, (h) => s.set({ ok: false, error: h % 2 === 0 ? EACCES.error : `${EACCES.error}; session ${h} could not be marked` }));
  assert.deepEqual(told, [0, 24, 48]);
});

test('L437 flood: main moving every 3 hours past a stuck copy is told once a day', async () => {
  const s = statusMac();
  const head = (h) => String(Math.floor(h / 3)).padStart(40, 'b');
  s.set({ installed_commit: HEAD });
  let seen = nextMainSeen(null, { commit: head(0), installed: HEAD, now: T0 - 2 * H });
  const out = [];
  for (const h of range(72)) {
    // The Dispatcher sees the new head before the updater does: the case the grace plans for.
    s.setMain({ commit: head(h), since: behindSince(seen, head(h), HEAD) });
    for (const t of await s.hour(h)) if (/Its installed copy is at aaaaaaa/.test(t)) out.push(h);
    seen = nextMainSeen(seen, { commit: head(h), installed: HEAD, now: T0 + h * H });
  }
  assert.deepEqual(out, [0, 24, 48, 72]);
});

test('L437 flood: main unreadable on and off keeps the stamp hold, told once a day', async () => {
  const s = statusMac();
  s.set({ installed_commit: HEAD });
  const told = await tellsOver(s, range(48), /Its installed copy is at aaaaaaa/, (h) => s.setMain(h % 2 === 0 ? { commit: MAIN, since: T0 - H } : null));
  assert.deepEqual(told, [0, 24, 48]);
});

test('L437: time off the list counts readable passes only', async () => {
  const s = statusMac();
  const mark = () => s.rec.read('fact', REVIEW_HOLD_FACT('runner-failed'))?.doc;
  s.set(EACCES);
  await s.hour(0);
  s.set({ ok: true, error: null });
  await s.hour(1);
  assert.ok(mark().told_at, 'off the list, not yet cleared');
  s.unreadable(true);
  await assert.rejects(s.hour(1.9), /status can't be read/);
  s.unreadable(false);
  await s.hour(2.1);
  assert.ok(mark().told_at, 'an unreadable pass started the hour again');
  await s.hour(3);
  assert.ok(mark().told_at, 'still under the hour of readable passes');
  await s.hour(3.2);
  assert.equal(mark().told_at, null, 'an hour of readable passes: cleared');
  await s.hour(4);
  assert.equal(mark().told_at, null);
});

test('L465: main unreadable from the first pass is told at once and each day, and clears nothing', async () => {
  const s = statusMac();
  s.set({ installed_commit: HEAD });
  s.setMain(null);
  assert.deepEqual(await s.run(0, 24, /review runner: /), [0, 24], 'told at h0 and h24, nothing between');
  assert.deepEqual(await s.run(25, 48, /Main can't be read/), [48]);
});

test('L470 m1: a kept hold told, cleared and back the same day stays quiet until the day is up', async () => {
  const s = statusMac();
  s.setMain(null);
  assert.deepEqual(await s.run(0, 0, /Main can't be read/), [0]);
  s.setMain({ commit: MAIN, since: T0 });
  await s.run(1, 3, /x/); // level for two hours: the mark clears
  s.setMain(null);
  assert.deepEqual(await s.run(10, 39, /Main can't be read/), [24]);
});

test('L470 m1: one failed read every 2 hours is told once a day', async () => {
  const s = statusMac();
  const told = await tellsOver(s, range(48, 1 / 12), /Main can't be read/, (h) => s.setMain(Math.round(h * 12) % 24 === 0 ? null : { commit: MAIN, since: T0 }));
  assert.deepEqual(told, [0, 24, 48]);
});

test('L470 m2: another error from the read of main is no new tell', async () => {
  const s = statusMac();
  let n = 0;
  const ports = () => { n += 1; throw new Error(`refused ${'abcdefgh'[n % 8]}`); };
  s.setMain(ports);
  assert.deepEqual(await s.run(0, 24, /Main can't be read/), [0, 24]);
});

test('L465: when main reads again, a copy behind is told at once, as news; a copy level ends it', async () => {
  const behind = statusMac();
  behind.set({ installed_commit: HEAD });
  behind.setMain(null);
  await behind.hour(0);
  behind.setMain({ commit: MAIN, since: T0 - H });
  assert.deepEqual(await behind.run(1, 2, /Its installed copy is at aaaaaaa/), [1]);
  const level = statusMac();
  level.setMain(null);
  await level.hour(0);
  level.setMain({ commit: MAIN, since: T0 - H });
  assert.deepEqual(await level.run(1, 40, /review runner: /), []);
  assert.equal(level.rec.read('fact', REVIEW_HOLD_FACT('stamp')).doc.told_at, null, 'cleared');
});

test('L437 m1: a kept hold leaves a queued copy alone and stays on the list', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('stamp');
  const hold = { id: 'stamp', hold: true, text: 'The copy is behind.', since: 'aaa' };
  const keep = { id: 'stamp', hold: true, keep: true, since: 'main-unreadable', text: MAIN_UNREAD };
  assert.equal(relayReviewAlerts({ rec, alerts: [hold], alert: outbox(rec, T0), now: T0 }), 1);
  relayReviewAlerts({ rec, alerts: [keep], alert: outbox(rec, T0 + 3 * H), now: T0 + 3 * H });
  assert.equal(isQueued(rec, fact), true, 'the queued copy stays');
  assert.equal(rec.read('fact', fact)?.doc?.absent_since, undefined, 'kept is listed, not off the list');
});

test('L458 m2: a stamp hold told is told each day that main can\'t be read, under the same trouble', async () => {
  const s = statusMac();
  s.set({ installed_commit: HEAD });
  s.setMain({ commit: MAIN, since: T0 - H });
  assert.deepEqual(await s.run(0, 0, /Its installed copy is at aaaaaaa/), [0]);
  s.setMain(null);
  assert.deepEqual(await s.run(1, 72, /Main can't be read/), [24, 48, 72]);
  s.setMain({ commit: MAIN, since: T0 - H });
  assert.deepEqual(await s.run(73, 96, /review runner: /), [96], 'main back: the same copy is the same trouble, a day after the last tell');
});

test('L458 m2: a tell that main can\'t be read counts for the day, even when the hold clears and comes back', async () => {
  const s = statusMac();
  s.set({ installed_commit: HEAD });
  s.setMain({ commit: MAIN, since: T0 - H });
  await s.hour(0);
  s.setMain(null);
  assert.deepEqual(await s.run(1, 24, /Main can't be read/), [24]);
  s.setMain({ commit: MAIN, since: T0 - H });
  s.set({ installed_commit: MAIN });
  await s.run(25, 27, /x/); // level for two hours: the mark clears
  s.set({ installed_commit: HEAD });
  assert.deepEqual(await s.run(28, 47, /review runner: /), [], 'the same copy behind again, told 4 hours ago');
  assert.deepEqual(await s.run(48, 48, /Its installed copy is at aaaaaaa/), [48]);
});

test('L465: main unreadable after a trouble cleared is a new tell, in its own words', async () => {
  const s = statusMac();
  s.set({ installed_commit: HEAD });
  s.setMain({ commit: MAIN, since: T0 - H });
  await s.hour(0);
  s.set({ installed_commit: MAIN });
  await s.run(1, 3, /x/);
  s.setMain(null);
  assert.deepEqual(await s.run(4, 28, /Main can't be read/), [4, 28]);
});

test('L458 m1: a runner error naming a session id each pass is one trouble', async () => {
  const s = statusMac();
  const id = (h) => `${'abcdefghijklm'[h].repeat(8)}-aaaa-bbbb-cccc-dddddddddddd`.replace(/[g-m]/g, 'f');
  const told = await tellsOver(s, range(12), FAILED_ANY, (h) => s.set({ ok: false, error: `session ${'abcdefghijklm'[h]}${id(h)} could not be marked ended (EIO)` }));
  assert.deepEqual(told, [0], 'one tell, not 13');
});

test('L458 m3: two causes taking turns are each told once a day', async () => {
  const s = statusMac();
  const told = await tellsOver(s, range(48), FAILED_ANY, (h) => s.set({ ok: false, error: h % 2 === 0 ? EACCES.error : 'the disk is full' }));
  assert.deepEqual(told, [0, 1, 24, 25, 48]);
});

test('L458 m5: the told causes are pruned: only the last day\'s stay on the mark', async () => {
  const s = statusMac();
  for (const [i, c] of ['one', 'two', 'three', 'four', 'five'].entries()) { s.set({ ok: false, error: `trouble ${c}` }); await s.hour(i * 25); }
  assert.equal(Object.keys(s.rec.read('fact', REVIEW_HOLD_FACT('runner-failed')).doc.since_times).length, 1);
});

test('L437: a told time that can\'t be read is not held back: the hold is told', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('review-admin');
  const hold = { id: 'review-admin', hold: true, text: 'The review user is an admin Mac user.' };
  for (const since_times of [{ none: 'garbage' }, { none: iso(T0 + 365 * 24 * H) }, { none: 7 }, 'text', null]) {
    rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: rec.read('fact', fact)?.rev ?? 0, doc: { told_at: null, since_times }, kind: 'hold_alert' });
    assert.equal(relayReviewAlerts({ rec, alerts: [hold], alert: outbox(rec, T0), now: T0 }), 1, JSON.stringify(since_times));
  }
});

// The verdict flow to the first tell of a verdict the Record has not taken: hour 4.
async function notTakenTold(over = {}) {
  const m = mac({ verdictTaken: () => ({ ok: false, reason: 'the Record holds no verdict of session S-1' }), ...over });
  for (let h = 0; h <= 2; h += 1) await m.hour(h);
  m.live.splice(0);
  assert.deepEqual(await m.run(3, 4, NOT_TAKEN), [4]);
  return m;
}
const NOT_TAKEN = /review runner: The reviewer for card C-1 at aaaaaaa handed in a verdict the Record has not taken/;
const held = (m) => JSON.parse(readFileSync(join(m.root, 'status.json'), 'utf8')).holds.filter((x) => x.id.startsWith('not-taken-'));

test('L437 MAT-1: a verdict still not taken is told daily after the runner\'s memory is removed', async () => {
  const m = await notTakenTold();
  rmSync(join(m.root, 'state.json'));
  assert.deepEqual(await m.run(5, 53, NOT_TAKEN), [28, 52]);
  assert.equal(m.starts.length, 1, 'nothing started again');
  assert.equal(held(m).length, 1);
});

test('L437 MAT-1: the rebuild tells only a real verdict the card still wants, and a card it can\'t read adds nothing', async () => {
  const m = await notTakenTold();
  rmSync(join(m.root, 'state.json'));
  const read = m.ctx.readCard;
  m.ctx.readCard = () => { throw new Error('the Record is away'); };
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 0, 'unreadable: one read failing must not turn past sessions into holds');
  m.ctx.readCard = read;
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 1);
  rmSync(join(m.root, 'state.json'));
  m.ctx.verdictTaken = () => ({ ok: true });
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 0, 'taken');
  // A session that ended with no verdict was told when it ended, with its tap: not a verdict not taken.
  const silent = mac({ handedIn: () => ({ ok: false, none: true }), verdictTaken: () => ({ ok: false, reason: 'no' }) });
  for (let h = 0; h <= 2; h += 1) await silent.hour(h);
  silent.live.splice(0);
  await silent.run(3, 4, NOT_TAKEN);
  assert.equal(held(silent).length, 0);
});

test('L437 m2: a verdictTaken that throws counts as not taken, and an unreadable card keeps the hold', async () => {
  const m = await notTakenTold();
  m.ctx.verdictTaken = () => { throw new Error('the Record is away'); };
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 1);
  assert.match(held(m)[0].text, /could not be read/);
  m.ctx.verdictTaken = () => ({ ok: true });
  m.ctx.readCard = () => { throw new Error('the Record is away'); };
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 0, 'an answer that says taken ends it even with the card away');
  const n = await notTakenTold();
  n.ctx.readCard = () => ({ ok: false });
  await runnerPass(n.ctx);
  assert.equal(held(n).length, 1, 'an unreadable card leaves it held');
});

// The push script alone moves a head in the Record, so the runner's reads stand in for it, as the test of a card that left its head does.
const HEAD2 = 'b'.repeat(40);
const amend = (m) => {
  const had = m.ctx.readCard;
  m.ctx.readCard = (c) => { const r = had(c); return { ...r, doc: { ...r.doc, head: HEAD2 } }; };
  m.ctx.currentHead = () => HEAD2;
};

test('L458 M1: a card amended to the same tree, then a memory reset: the verdict is still told, at the card\'s head', async () => {
  const m = await notTakenTold();
  const seen = [];
  m.ctx.verdictTaken = (x) => { seen.push(x.head); return { ok: false, reason: 'the Record holds no verdict of session S-1' }; };
  amend(m);
  rmSync(join(m.root, 'state.json'));
  const told = await m.run(5, 52, /handed in a verdict the Record has not taken/);
  assert.deepEqual(told, [28, 52], 'told within a day');
  assert.equal(m.starts.length, 1, 'nothing started again');
  assert.match(held(m)[0].text, /at bbbbbbb/, 'held at the card\'s head, so the kept check does not drop it');
  assert.ok(seen.every((h) => h === HEAD2));
});

test('L458 M1 control: a head with another tree, or a tree that can\'t be read, adds nothing', async () => {
  for (const treeOf of [async () => 'd'.repeat(40), async () => { throw new Error('no'); }]) {
    const m = await notTakenTold();
    m.ctx.treeOf = treeOf;
    amend(m);
    rmSync(join(m.root, 'state.json'));
    await runnerPass(m.ctx);
    assert.deepEqual(held(m), []);
  }
});

// One test per place verdictTaken can throw, each set up so the other two can't add the hold back (L458 m4).
const THROWS = () => { throw new Error('the Record is away'); };
const noState = (m) => {
  const file = join(m.root, 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  delete st.not_taken;
  writeFileSync(file, JSON.stringify(st), { mode: 0o600 });
};

test('L458 m4: a throw on the kept check leaves the hold', async () => {
  const m = await notTakenTold();
  m.ctx.verdictTaken = THROWS;
  m.ctx.readCard = THROWS; // so the rebuild adds nothing back; no request is waiting in a pass alone
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 1);
  assert.match(held(m)[0].text, /could not be read/);
});

test('L458 m4: a throw in the rebuild counts as not taken', async () => {
  const m = await notTakenTold();
  m.ctx.verdictTaken = THROWS;
  rmSync(join(m.root, 'state.json')); // nothing kept, and no request is waiting in a pass alone
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 1);
  assert.match(held(m)[0].text, /could not be read/);
});

test('L458 m4: a throw on a request counts as not taken', async () => {
  const m = await notTakenTold();
  m.ctx.verdictTaken = THROWS;
  noState(m); // nothing kept
  rmSync(join(m.root, 'launches', 'S-1.json'), { force: true }); // and nothing for the rebuild to read
  await m.hour(5);
  assert.equal(held(m).length, 1);
  assert.match(held(m)[0].text, /could not be read/);
});

test('L458 m5: the rebuild skips a session set aside', async () => {
  const m = await notTakenTold();
  writeFileSync(join(m.root, 'set-aside', 'S-1.json'), JSON.stringify({ session_id: 'S-1' }), { mode: 0o644 });
  rmSync(join(m.root, 'state.json'));
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 0);
});
