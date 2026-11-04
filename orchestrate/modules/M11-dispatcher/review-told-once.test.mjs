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
import { runnerPass, REFUSED_QUIET_MS, MAX_STREAKS, MAX_MORE_STREAKS } from '../M4-workshop/launcher/review-runner.mjs';
import { readCardFile } from '../M4-workshop/launcher/review-runner-main.mjs';
import { reviewPorts, relayReviewAlerts, keepReviewHolds, REVIEW_HOLD_FACT, HOLD_ABSENT_MS, MAIN_UNREAD } from './review-requests.mjs';
import { behindSince, nextMainSeen } from '../M4-workshop/launcher/install-check.mjs';
import { outbox, isQueued, ALERT_QUEUE_FACT } from './alerts.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { timeLimits } from './merges.mjs';
import { KEYS, minutes } from './keys.mjs';
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
function mac(over = {}, rules = R) {
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
    readCard: (c) => { const d = rec.read('card', c)?.doc; return d ? { ok: true, doc: d } : { ok: false, reason: 'no such card', missing: true }; },
    requestGapMs: (product) => minutes(rules, KEYS.inReviewNoReviewerMin, { product: product ?? 'p1' }),
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
    await withAlerts(rec, clock.t, (t) => { got.push(t); return true; }, (alert) => timeLimits({ rec, rules, now: clock.t, b: GREEN, alert, ...ports, gateAlive: () => true }));
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

// #181 overlap: a told mark that lands while a hold's write is on its way, from the alert channel's own process.
const markLands = (rec, fact, kind, fields) => {
  let landed = false;
  return { ...rec, write: (w) => {
    if (w.kind === kind && !landed) {
      landed = true;
      const c = rec.read('fact', fact);
      rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: c?.rev ?? 0, doc: { ...c?.doc, ...fields }, kind: 'hold_alert' });
    }
    return rec.write(w);
  } };
};
const told = (rec, fact, doc) => rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: 0, doc, kind: 'hold_alert' });
const lines = () => { const out = []; const report = (line, fact) => out.push([line, fact]); report.out = out; return report; };

test('L288 MAT-4: a mark landing during the off-list write is kept', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('r1');
  told(rec, fact, { told_at: iso(T0), since: 'a', since_times: { a: iso(T0) } });
  const late = { a: iso(T0), b: iso(T0 + H) };
  relayReviewAlerts({ rec: markLands(rec, fact, 'hold_absent', { since_times: late }), alerts: [], alert: outbox(rec, T0 + H), now: T0 + H, report: lines() });
  const doc = rec.read('fact', fact).doc;
  assert.deepEqual(doc.since_times, late);
  assert.equal(doc.absent_since, iso(T0 + H));
});

test('L288 MAT-4: a mark landing as a hold comes back on the list is kept', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('r1');
  told(rec, fact, { told_at: iso(T0), since: 'a', since_times: { a: iso(T0) }, absent_since: iso(T0) });
  const late = { a: iso(T0), b: iso(T0 + H) };
  relayReviewAlerts({ rec: markLands(rec, fact, 'hold_back', { since_times: late }), alerts: [{ id: 'r1', hold: true, since: 'a', text: 'x' }], alert: outbox(rec, T0 + H), now: T0 + H, report: lines() });
  const doc = rec.read('fact', fact).doc;
  assert.deepEqual(doc.since_times, late);
  assert.equal(doc.absent_since, undefined);
});

test('L288 MAT-4, L354: a clear wins over a mark landing with it, and keeps the sinces told', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('r1');
  const times = { a: iso(T0) };
  told(rec, fact, { told_at: iso(T0), since_times: times, absent_since: iso(T0) });
  const at = T0 + HOLD_ABSENT_MS;
  relayReviewAlerts({ rec: markLands(rec, fact, 'hold_cleared', { told_at: iso(at) }), alerts: [], alert: outbox(rec, at), now: at, report: lines() });
  const doc = rec.read('fact', fact).doc;
  assert.equal(doc.told_at, null);
  assert.deepEqual(doc.since_times, times);
  assert.equal(doc.cleared_at, iso(at));
});

test('L354: with a copy queued and the mark already clear, a mark landing during the clear loses', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('r1');
  relayReviewAlerts({ rec, alerts: [{ id: 'r1', hold: true, text: 'x' }], alert: outbox(rec, T0), now: T0, report: lines() });
  told(rec, fact, { told_at: null, absent_since: iso(T0) });
  const at = T0 + HOLD_ABSENT_MS;
  relayReviewAlerts({ rec: markLands(rec, fact, 'hold_cleared', { told_at: iso(at) }), alerts: [], alert: outbox(rec, at), now: at, report: lines() });
  assert.equal(rec.read('fact', fact).doc.told_at, null);
});

test('L449: a clear with a copy queued and no mark yet still writes, so a mark on its way conflicts', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('r1');
  relayReviewAlerts({ rec, alerts: [{ id: 'r1', hold: true, text: 'x' }], alert: outbox(rec, T0), now: T0, report: lines() });
  assert.equal(rec.read('fact', fact), null);
  relayReviewAlerts({ rec, alerts: [], alert: outbox(rec, T0 + H), now: T0 + H, report: lines() });
  const later = T0 + H + HOLD_ABSENT_MS;
  relayReviewAlerts({ rec, alerts: [], alert: outbox(rec, later), now: later, report: lines() });
  assert.equal(rec.read('fact', fact).doc.cleared_at, iso(later));
});

test('L354: a drop that fails holds the clear for the next pass, and is said', () => {
  const rec = recWith();
  const fact = REVIEW_HOLD_FACT('r1');
  relayReviewAlerts({ rec, alerts: [{ id: 'r1', hold: true, text: 'x' }], alert: outbox(rec, T0), now: T0, report: lines() });
  relayReviewAlerts({ rec, alerts: [], alert: outbox(rec, T0 + H), now: T0 + H, report: lines() });
  const report = lines();
  const later = T0 + H + HOLD_ABSENT_MS;
  const refusing = { ...rec, write: (w) => (w.id === ALERT_QUEUE_FACT ? { ok: false, reason: 'refused' } : rec.write(w)) };
  relayReviewAlerts({ rec: refusing, alerts: [], alert: outbox(rec, later), now: later, report });
  assert.match(report.out[0][0], /could not be dropped; the clear waits/);
  assert.equal(report.out[0][1], fact);
  assert.equal(isQueued(rec, fact), true);
  assert.equal(rec.read('fact', fact).doc.cleared_at, undefined, 'not cleared');
  relayReviewAlerts({ rec, alerts: [], alert: outbox(rec, later + H), now: later + H, report });
  assert.equal(isQueued(rec, fact), false);
  assert.equal(rec.read('fact', fact).doc.cleared_at, iso(later + H), 'cleared on the next pass');
});

test('L354 item 6: each hold write the Record refuses is said', () => {
  const refuse = (rec) => ({ ...rec, write: () => ({ ok: false, reason: 'refused' }) });
  const fact = REVIEW_HOLD_FACT('r1');
  const said = (doc, run) => {
    const rec = recWith();
    told(rec, fact, doc);
    const report = lines();
    run(refuse(rec), report);
    assert.deepEqual(report.out, [[`${fact} could not be written (refused)`, fact]]);
  };
  const absent = { told_at: iso(T0), absent_since: iso(T0) };
  said({ told_at: iso(T0) }, (rec, report) => relayReviewAlerts({ rec, alerts: [], alert: fakeAlert(), now: T0 + H, report }));
  said(absent, (rec, report) => keepReviewHolds(rec, report));
  said(absent, (rec, report) => relayReviewAlerts({ rec, alerts: [], alert: fakeAlert(), now: T0 + HOLD_ABSENT_MS, report }));
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
  n.ctx.readCard = () => ({ ok: false, reason: 'its file is not JSON' });
  await runnerPass(n.ctx);
  assert.equal(held(n).length, 1, 'an unreadable card leaves it held');
});

// The push script alone moves a head in the Record, so the runner's reads stand in for it, as the test of a card that left its head does.
const HEAD2 = 'b'.repeat(40);
const NOT_TAKEN_ANY = /handed in a verdict the Record has not taken/;
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

test('L458 M1 control: a head with another tree adds nothing', async () => {
  const m = await notTakenTold();
  m.ctx.treeOf = async () => 'd'.repeat(40);
  amend(m);
  rmSync(join(m.root, 'state.json'));
  await runnerPass(m.ctx);
  assert.deepEqual(held(m), []);
});

// R-0b-171: a request the runner keeps refusing is told; so is a held verdict whose new head's tree can't be read.
const REFUSED = /review runner: The reviewer request for card C-1 at aaaaaaa has been refused for a day/;
const NO_TREE = async () => { throw new Error('git is away'); };
const treeAway = (m) => { m.ctx.treeOf = async (c, h) => { if (h === HEAD2) throw new Error('git is away'); return TREE; }; };
const stateOf = (m) => JSON.parse(readFileSync(join(m.root, 'state.json'), 'utf8'));
const editState = (m, change) => { const st = stateOf(m); change(st); writeFileSync(join(m.root, 'state.json'), JSON.stringify(st), { mode: 0o600 }); };
const statusHolds = (m) => JSON.parse(readFileSync(join(m.root, 'status.json'), 'utf8')).holds;

test('R-0b-171 A7: a card whose tree can\'t be read is told a day after the first refusal, then each day, and nothing between', async () => {
  const m = mac({ treeOf: NO_TREE });
  const told = [];
  for (let h = 0; h <= 80; h += 1) for (const t of await m.hour(h)) if (REFUSED.test(t)) told.push([h, t]);
  assert.deepEqual(told.map(([h]) => h), [25, 49, 73]);
  assert.match(told[0][1], /last: the tree of aaaaaaa could not be read \(git is away\)/);
  assert.equal(m.starts.length, 0);
});

test('R-0b-171: each refusal that says the review can\'t go ahead is told', async () => {
  for (const [over, why] of [
    [{ treeOf: async () => 'not a tree' }, /the tree of aaaaaaa could not be read\)?\./],
    [{ currentHead: () => { throw new Error('git is away'); } }, /the card's head in git could not be read/],
    [{ currentHead: () => HEAD2 }, /the card's branch is at bbbbbbb/],
    [{ accountInUse: () => null }, /(could not be started|starts of a reviewer|last start of a reviewer)/],
  ]) {
    const m = mac(over);
    const told = [];
    for (let h = 0; h <= 26; h += 1) for (const t of await m.hour(h)) if (REFUSED.test(t)) told.push(t);
    assert.equal(told.length, 1, String(why));
    assert.match(told[0], why);
  }
});

test('R-0b-171: a card the Record could not read is told', async () => {
  const m = mac();
  await m.hour(0);
  m.ctx.readCard = () => ({ ok: false, reason: 'the Record is away' });
  await m.hour(1);
  assert.match(stateOf(m).refused_streaks?.['C-1 reviewer']?.reason, /is not in the Record \(the Record is away\)/);
});

test('R-0b-171: a card read that fails ends no streak, whichever way it fails (m2)', async () => {
  for (const read of [() => ({ ok: false, reason: 'the Record is away' }), () => { throw new Error('the Record is away'); }]) {
    const m = mac();
    await m.hour(0);
    await runnerPass(m.ctx);
    editState(m, (st) => { st.refused_streaks = { 'C-1 reviewer': { card: 'C-1', role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0 - 30 * H), last_at: iso(T0 - H) } }; });
    m.ctx.readCard = read;
    await runnerPass(m.ctx);
    assert.deepEqual(statusHolds(m).map((h) => h.id), ['refused-C-1-reviewer']);
  }
});

const ask = (m, card, n, role = 'reviewer') => writeFileSync(join(m.root, 'requests', `${card}-${n}.json`), JSON.stringify({ card, head: HEAD, role, request_id: `${card}-${n}` }), { mode: 0o644 });

test('R-0b-171 C3b: a made-up card is never a streak, however often it is asked for', async () => {
  const m = mac();
  await m.hour(0);
  const told = [];
  for (let h = 1; h <= 30; h += 1) { ask(m, 'NOPE-1', h); told.push(...await m.hour(h)); }
  assert.deepEqual(stateOf(m).refused_streaks ?? {}, {});
  assert.deepEqual(told.filter((t) => /NOPE-1/.test(t)), []);
});

test('R-0b-171 C3e: 2000 made-up cards tell nothing and cost nothing', async () => {
  const m = mac();
  await m.hour(0);
  for (let i = 0; i < 2000; i += 1) ask(m, `NOPE-${i}`, 1);
  await runnerPass(m.ctx);
  m.clock.t += 25 * H;
  for (let i = 0; i < 2000; i += 1) ask(m, `NOPE-${i}`, 2);
  await runnerPass(m.ctx);
  assert.deepEqual(stateOf(m).refused_streaks ?? {}, {});
  assert.deepEqual(statusHolds(m), []);
  assert.ok(readFileSync(join(m.root, 'status.json')).length < 20_000);
});

test('R-0b-171 m5: a streak whose card is gone ends at once', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx);
  editState(m, (st) => { st.refused_streaks = { 'GONE-1 reviewer': { card: 'GONE-1', role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0 - 30 * H), last_at: iso(T0 - H) } }; });
  await runnerPass(m.ctx);
  assert.deepEqual(stateOf(m).refused_streaks, {});
  assert.deepEqual(statusHolds(m), []);
});

test('R-0b-171: past the cap one hold counts the rest, and a freed place is taken', async () => {
  const m = mac({ readCard: () => ({ ok: false, reason: 'the Record is away' }) });
  await m.hour(0);
  await runnerPass(m.ctx);
  editState(m, (st) => { st.refused_streaks = {}; });
  const extra = 10;
  for (let i = 0; i < MAX_STREAKS + extra; i += 1) ask(m, `X-${i}`, 1);
  await runnerPass(m.ctx);
  const first = stateOf(m);
  assert.equal(Object.keys(first.refused_streaks).length, MAX_STREAKS);
  assert.equal(Object.keys(first.refused_more).length, extra);
  m.clock.t += 25 * H;
  await runnerPass(m.ctx);
  const holds = statusHolds(m);
  assert.equal(holds.length, MAX_STREAKS + 1);
  assert.equal(holds.filter((h) => h.id === 'refused-more').length, 1);
  assert.match(holds.find((h) => h.id === 'refused-more').text, /^10 more cards' review requests are refused\.$/);
  // One in the overflow is asked for again while a place is free: it keeps its day, and the count drops.
  const was = stateOf(m);
  const [overflowed] = Object.values(was.refused_more);
  editState(m, (st) => { delete st.refused_streaks['X-0 reviewer']; });
  ask(m, overflowed.card, 2);
  await runnerPass(m.ctx);
  const now = stateOf(m);
  assert.equal(now.refused_streaks[`${overflowed.card} reviewer`].first_at, overflowed.first_at);
  assert.equal(now.refused_more[`${overflowed.card} reviewer`], undefined);
  assert.match(statusHolds(m).find((h) => h.id === 'refused-more').text, /^9 more cards'/);
});

test('L489 n1: an overflow streak ends each way a streak ends', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx);
  const seed = (card, over = {}) => ({ [`${card} reviewer`]: { card, role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0 - 30 * H), last_at: iso(T0 - H), ...over } });
  const had = m.ctx.readCard;
  m.ctx.readCard = (c) => (c === 'DONE-1' ? { ok: true, doc: { state: 'verified', head: HEAD, product: 'p1' } } : c === 'QUIET-1' || c === 'STAYS-1' ? { ok: true, doc: { state: 'in_review', head: HEAD, product: 'p1' } } : had(c));
  editState(m, (st) => { st.refused_more = { ...seed('GONE-1'), ...seed('DONE-1'), ...seed('QUIET-1', { last_at: iso(T0 - REFUSED_QUIET_MS) }), ...seed('STAYS-1') }; });
  await runnerPass(m.ctx);
  assert.deepEqual(Object.keys(stateOf(m).refused_more), ['STAYS-1 reviewer']);
});

const realRecord = (m) => {
  const dir = join(m.base, 'record');
  mkdirSync(join(dir, 'docs', 'card'), { recursive: true });
  for (const p of [dir, join(dir, 'docs'), join(dir, 'docs', 'card')]) chmodSync(p, 0o755);
  writeFileSync(join(dir, 'docs', 'card', 'C-1.json'), JSON.stringify({ entity: 'card', id: 'C-1', rev: 1, doc: { state: 'in_review', product: 'p1', head: HEAD, tier: 2 } }), { mode: 0o644 });
  m.ctx.readCard = (card) => readCardFile({ recordRoot: dir, recordUid: ME, card });
};
// The file's own name can't start with a dot: the runner never lists one that does.
const askDot = (m, card, n) => writeFileSync(join(m.root, 'requests', `dot-${n}.json`), JSON.stringify({ card, head: HEAD, role: 'reviewer', request_id: `dot-${n}` }), { mode: 0o644 });

test('L489 N1 C3g: 60 made-up ids starting with a dot, once: no streak, one hold for the bad requests, and the tells end', async () => {
  const m = mac({ treeOf: async () => TREE });
  realRecord(m);
  await m.hour(0);
  for (let k = 0; k < 60; k += 1) askDot(m, `.Z-${k}`, k);
  await m.hour(1);
  assert.deepEqual(stateOf(m).refused_streaks ?? {}, {});
  assert.deepEqual(Object.keys(stateOf(m).unread_requests ?? {}), ['the card id is not a plain id']);
  const texts = [];
  for (let h = 2; h <= 96; h += 1) texts.push(...(await m.hour(h)).filter((t) => /plain id|refused/.test(t)));
  assert.ok(texts.length >= 1 && texts.length <= 2, `told ${texts.length}`);
  assert.equal(new Set(texts.map((t) => t.slice(0, 60))).size, 1);
  assert.deepEqual(stateOf(m).unread_requests ?? {}, {});
});

test('L489 N1 C3h: one request naming a real card in other capitals makes no streak', async () => {
  const m = mac({ treeOf: async () => TREE });
  realRecord(m);
  await m.hour(0);
  ask(m, 'c-1', 1);
  await m.hour(1);
  assert.deepEqual(stateOf(m).refused_streaks ?? {}, {});
  assert.deepEqual(await m.run(2, 60, /c-1/), []);
});

test('L489 N1 (b): the runner refuses a dot-led id before it reads any card', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx);
  const read = [];
  const had = m.ctx.readCard;
  m.ctx.readCard = (c) => { read.push(c); return had(c); };
  askDot(m, '.Z-1', 1);
  await runnerPass(m.ctx);
  assert.equal(read.includes('.Z-1'), false);
  assert.match(JSON.stringify(stateOf(m).refused), /the card id is not a plain id/);
});

test('L489 N1 (c): a card that can\'t be read is told daily while it is asked for, and ends once nothing asks', async () => {
  const m = mac({ readCard: () => ({ ok: false, reason: 'the Record is away' }) });
  const REFUSED_AWAY = /review runner: The reviewer request for card C-1 at aaaaaaa has been refused for a day/;
  assert.deepEqual(await m.run(0, 80, REFUSED_AWAY), [25, 49, 73]);
  await runnerPass(m.ctx);
  assert.equal(Object.keys(stateOf(m).refused_streaks).length, 1);
  // Nothing asks any more: the longest gap across products stands in for the card's own.
  const seen = [];
  m.ctx.requestGapMs = (p) => { seen.push(p); return 100 * H; };
  m.clock.t += 199 * H;
  await runnerPass(m.ctx);
  assert.equal(Object.keys(stateOf(m).refused_streaks).length, 1);
  assert.deepEqual(seen, [undefined]);
  m.clock.t += H;
  rmSync(join(m.root, 'requests'), { recursive: true, force: true });
  await runnerPass(m.ctx);
  assert.deepEqual(stateOf(m).refused_streaks, {});
});

test('L489 n2: a Record card head that isn\'t a head never stops a pass; it is told as a bad entry, and the hold stays', async () => {
  for (const bad of [5, null, undefined, ['a'.repeat(40)], 'short']) {
    const m = await notTakenTold();
    const had = m.ctx.readCard;
    m.ctx.readCard = (c) => { const r = had(c); return r.ok ? { ...r, doc: { ...r.doc, head: bad } } : r; };
    await runnerPass(m.ctx);
    assert.equal(held(m).length, 1, 'the kept hold stays');
    assert.ok(statusHolds(m).some((h) => h.id === 'hold-entry-unread'), `kept loop, ${JSON.stringify(bad)}`);
    rmSync(join(m.root, 'state.json'));
    await runnerPass(m.ctx);
    assert.deepEqual(held(m), [], 'the rebuild skips it');
    assert.ok(statusHolds(m).some((h) => h.id === 'hold-entry-unread'), `rebuild, ${JSON.stringify(bad)}`);
  }
  const told = await notTakenTold();
  const had = told.ctx.readCard;
  told.ctx.readCard = (c) => { const r = had(c); return r.ok ? { ...r, doc: { ...r.doc, head: 5 } } : r; };
  assert.deepEqual(await told.run(5, 60, /A hold entry could not be read/), [5, 29, 53]);
});

test('R-0b-171: the overflow itself is capped, and says so', async () => {
  const m = mac({ readCard: () => ({ ok: false, reason: 'the Record is away' }) });
  await m.hour(0);
  for (let i = 0; i < MAX_STREAKS + MAX_MORE_STREAKS + 40; i += 1) ask(m, `X-${i}`, 1);
  await runnerPass(m.ctx);
  assert.equal(Object.keys(stateOf(m).refused_more).length, MAX_MORE_STREAKS);
  m.clock.t += 25 * H;
  await runnerPass(m.ctx);
  assert.match(statusHolds(m).find((h) => h.id === 'refused-more').text, new RegExp(`^At least ${MAX_MORE_STREAKS} more cards'`));
});

test('R-0b-171 C3a: launch records that can\'t be read are told a day after the first refusal, then daily', async () => {
  const m = mac();
  m.ctx.sessions = async () => { try { chmodSync(join(m.root, 'launches'), 0o777); } catch { /* not made yet */ } return m.live.slice(); };
  m.ctx.setAsideByJoe = () => { try { chmodSync(join(m.root, 'launches'), 0o755); } catch { /* not made yet */ } return []; };
  assert.deepEqual(await m.run(0, 50, REFUSED), [25, 49]);
});

for (const min of [60, 1440, 2880, 4320]) {
  test(`R-0b-171 C2: asked every ${min} minutes, a card that can't start is told within a day, then daily`, async () => {
    const m = mac({ treeOf: NO_TREE }, rulesWith({ 'timeouts.in_review_no_reviewer_min': min }));
    const told = await m.run(0, 288, REFUSED);
    const first = (Date.parse(stateOf(m).refused_streaks['C-1 reviewer'].first_at) - T0) / H;
    assert.ok(told[0] - first <= 24, `first told at ${told[0]}, first refused at ${first}`);
    assert.deepEqual(told.slice(1).map((h, i) => h - told[i]), told.slice(1).map(() => 24), `told ${told}`);
    assert.equal(told.at(-1) > 288 - 25, true, `told ${told}`);
  });
}

test('R-0b-171: the quiet window follows the rules, for the card\'s product', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx);
  const seen = [];
  m.ctx.requestGapMs = (p) => { seen.push(p); return 100 * H; };
  const lasting = async (hoursAgo) => {
    editState(m, (st) => { st.refused_streaks = { 'C-1 reviewer': { card: 'C-1', role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0 - 300 * H), last_at: iso(T0 - hoursAgo * H) } }; });
    await runnerPass(m.ctx);
    return Object.keys(stateOf(m).refused_streaks).length;
  };
  assert.equal(await lasting(199), 1);
  assert.equal(await lasting(200), 0);
  assert.equal(seen[0], 'p1');
  // A short gap never goes under the floor, and one that can't be read ends nothing.
  m.ctx.requestGapMs = () => 60_000;
  assert.equal(await lasting(47), 1);
  assert.equal(await lasting(48), 0);
  for (const bad of [() => { throw new Error('no rules'); }, () => NaN, undefined]) {
    m.ctx.requestGapMs = bad;
    assert.equal(await lasting(5000), 1);
  }
});

test('R-0b-171 C4: requests the runner can\'t read are told as that, one hold, daily', async () => {
  const m = mac();
  const old = process.umask(0o777);
  let told;
  try { told = await m.run(0, 80, /Review requests can't be read \(EACCES\) for a day; the last: [A-Za-z0-9-]+\.json/); } finally { process.umask(old); }
  assert.deepEqual(told, [25, 49, 73]);
  assert.equal(m.starts.length, 0);
  assert.equal(statusHolds(m).length, 1);
});

test('R-0b-171 L483: a clean request a day does not touch a hold on requests that can\'t be read; only its own silence ends it', async () => {
  const m = mac({ readCard: () => ({ ok: false, reason: 'no such card', missing: true }) });
  await m.hour(0);
  await runnerPass(m.ctx);
  const junk = (i) => writeFileSync(join(m.root, 'requests', `junk-${i}.json`), 'not json', { mode: 0o644 });
  const JUNK = 'Review requests can\'t be read (it is not JSON)';
  const heldNow = () => statusHolds(m).filter((h) => h.text.startsWith(JUNK)).length;
  junk(0);
  await runnerPass(m.ctx);
  const first = Object.values(stateOf(m).unread_requests)[0].first_at;
  for (let d = 1; d <= 3; d += 1) {
    m.clock.t += 12 * H;
    ask(m, 'NOPE-1', d);
    await runnerPass(m.ctx);
    m.clock.t += 12 * H;
    junk(d);
    ask(m, 'NOPE-1', d + 10);
    await runnerPass(m.ctx);
    assert.equal(heldNow(), 1, `day ${d}`);
    assert.equal(Object.values(stateOf(m).unread_requests)[0].first_at, first, 'the day is not reset');
  }
  // Clean requests alone never end it; a quiet window with none of its cause does.
  m.clock.t += REFUSED_QUIET_MS - H;
  ask(m, 'NOPE-1', 99);
  await runnerPass(m.ctx);
  assert.equal(heldNow(), 1, 'an hour short');
  m.clock.t += H;
  await runnerPass(m.ctx);
  assert.equal(heldNow(), 0);
});

test('R-0b-171: one hold per cause however many files, and none arriving ends it', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx);
  const junk = (i, text) => writeFileSync(join(m.root, 'requests', `junk-${i}.json`), text, { mode: 0o644 });
  for (let i = 0; i < 40; i += 1) junk(i, 'not json');
  junk(40, '[]');
  await runnerPass(m.ctx);
  assert.deepEqual(statusHolds(m), [], 'less than a day');
  m.clock.t += 24 * H;
  junk(41, 'not json');
  await runnerPass(m.ctx);
  const holds = statusHolds(m);
  assert.equal(holds.length, 2);
  assert.equal(new Set(holds.map((h) => h.id)).size, 2);
  assert.match(holds.map((h) => h.text).join(' '), /Review requests can't be read \(it is not JSON\) for a day; the last: junk-41\.json/);
  m.clock.t += REFUSED_QUIET_MS;
  await runnerPass(m.ctx);
  assert.deepEqual(statusHolds(m), []);
});

const NO_VERDICT = /review runner: The reviewer for card C-1 at aaaaaaa started but gave no counted verdict\. One start per head and tree, so it won't start again: the owner needs to act\./;
// A review that ended with nothing handed in, with the card still in review.
async function silent(over = {}) {
  const m = mac({ handedIn: () => ({ ok: false, none: true }), verdictTaken: () => ({ ok: false, reason: 'the Record holds no verdict' }), ...over });
  await m.hour(0); await m.hour(1);
  assert.equal(m.starts.length, 1);
  m.live.splice(0);
  return m;
}
const noVerdictHeld = (m) => statusHolds(m).filter((h) => h.id === 'no-verdict-C-1-reviewer');

test('R-0b-171 C7: a review started and no counted verdict is told each day, under its own cause', async () => {
  const m = await silent();
  assert.deepEqual(await m.run(2, 80, NO_VERDICT), [27, 51, 75]);
  assert.equal(m.starts.length, 1);
});

test('R-0b-171 C7: it ends when the card leaves review, the head moves, the card goes or a verdict counts', async () => {
  const ends = {
    'leaves review': (m) => { const had = m.ctx.readCard; m.ctx.readCard = (c) => { const r = had(c); return r.ok ? { ...r, doc: { ...r.doc, state: 'verified' } } : r; }; },
    'head moves': (m) => amend(m),
    'card goes': (m) => { m.ctx.readCard = () => ({ ok: false, reason: 'no such card', missing: true }); },
    'verdict counts': (m) => { m.ctx.verdictTaken = () => ({ ok: true }); },
  };
  for (const [name, end] of Object.entries(ends)) {
    const m = await silent();
    await m.run(2, 28, NO_VERDICT);
    assert.equal(noVerdictHeld(m).length, 1, name);
    end(m);
    await runnerPass(m.ctx);
    assert.deepEqual(noVerdictHeld(m), [], name);
  }
});

test('R-0b-171 C7: a card read that fails leaves it held, and a memory reset comes back on the next request', async () => {
  const m = await silent();
  await m.run(2, 28, NO_VERDICT);
  m.ctx.readCard = () => { throw new Error('the Record is away'); };
  await runnerPass(m.ctx);
  assert.equal(noVerdictHeld(m).length, 1);
  const r = await silent();
  await r.hour(2);
  rmSync(join(r.root, 'state.json'));
  await r.run(3, 30, NO_VERDICT);
  assert.equal(noVerdictHeld(r).length, 1);
  assert.equal(r.starts.length, 1);
});

test('R-0b-171 C7: a verdict the Record has not taken says it already, so there is one tell', async () => {
  const m = await notTakenTold();
  const told = await m.run(5, 60, NO_VERDICT);
  assert.deepEqual(told, []);
  assert.equal(held(m).length, 1);
  assert.deepEqual(stateOf(m).no_verdict ?? {}, {});
});

test('R-0b-171 C7: a held verdict added between requests ends the hold too, and a new session ends it', async () => {
  const seed = { 'C-1 reviewer': { card: 'C-1', head: HEAD, role: 'reviewer', session: 'S-1', first_at: iso(T0 - 30 * H) } };
  const m = await notTakenTold();
  await runnerPass(m.ctx); // the request is taken, so none is waiting below
  editState(m, (st) => { st.no_verdict = seed; });
  await runnerPass(m.ctx);
  assert.deepEqual(noVerdictHeld(m), []);
  const r = await silent();
  await r.hour(2);
  r.live.push({ pid: 5000, sessionId: 'S-2' });
  editState(r, (st) => { st.no_verdict = seed; st.running = [{ card: 'C-1', head: HEAD, tree: TREE, role: 'reviewer', session_id: 'S-2', pid: 5000, started_at: iso(r.clock.t) }]; });
  r.ctx.processName = () => `${CLAUDE} --session-id S-2`;
  await runnerPass(r.ctx);
  assert.deepEqual(noVerdictHeld(r), []);
});

test('R-0b-171 C7: no hold while the session has not ended, or its verdict is inside the wait, or the verdict counted', async () => {
  // Lost track of, a moment old: not ended yet, and the sweep waits 5 minutes.
  const lost = mac({ handedIn: () => ({ ok: false, none: true }), verdictTaken: () => ({ ok: false, reason: 'none' }) });
  await lost.hour(0); await lost.hour(1);
  lost.live.splice(0);
  editState(lost, (st) => { st.running = []; });
  ask(lost, 'C-1', 1);
  await runnerPass(lost.ctx);
  assert.match(JSON.stringify(stateOf(lost).refused), /already started/);
  assert.deepEqual(stateOf(lost).no_verdict ?? {}, {});
  // A verdict handed in, its session just ended: the Record has its wait.
  const wait = mac({ verdictTaken: () => ({ ok: false, reason: 'not yet' }) });
  await wait.hour(0); await wait.hour(1);
  wait.live.splice(0);
  wait.clock.t += 60_000;
  await runnerPass(wait.ctx);
  ask(wait, 'C-1', 2);
  wait.clock.t += 60_000;
  await runnerPass(wait.ctx);
  assert.match(JSON.stringify(stateOf(wait).refused), /already started/);
  assert.deepEqual(stateOf(wait).no_verdict ?? {}, {});
  // A verdict that counted.
  const took = mac();
  await took.hour(0); await took.hour(1);
  took.live.splice(0);
  await took.hour(2); await took.hour(3);
  ask(took, 'C-1', 3);
  await runnerPass(took.ctx);
  assert.match(JSON.stringify(stateOf(took).refused), /already started/);
  assert.deepEqual(stateOf(took).no_verdict ?? {}, {});
});

test('R-0b-171 C6: a launch record with no tree is skipped once the head moved, as before, whether or not the new tree reads', async () => {
  for (const treeOf of [async (c, h) => (h === HEAD2 ? 'd'.repeat(40) : TREE), async (c, h) => { if (h === HEAD2) throw new Error('git is away'); return TREE; }]) {
    const m = await notTakenTold();
    const lf = join(m.root, 'launches', 'S-1.json');
    const d = JSON.parse(readFileSync(lf, 'utf8'));
    delete d.tree;
    chmodSync(lf, 0o644); rmSync(lf); writeFileSync(lf, JSON.stringify(d), { mode: 0o644 });
    amend(m);
    m.ctx.treeOf = treeOf;
    rmSync(join(m.root, 'state.json'));
    assert.deepEqual(await m.run(5, 40, NOT_TAKEN_ANY), []);
    assert.deepEqual(held(m), []);
  }
});

test('R-0b-171 C8: a bad entry in the runner\'s memory is dropped and told, and never stops a pass', async () => {
  const good = { card: 'C-1', role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0), last_at: iso(T0) };
  const bads = [
    { refused_streaks: { x: null } }, { refused_streaks: { x: { ...good, head: 5 } } }, { refused_streaks: { x: { ...good, first_at: 'not a time' } } },
    { refused_streaks: { x: { ...good, last_at: 3 } } }, { refused_streaks: 'x' }, { refused_streaks: [] }, { refused_more: { x: 7 } },
    { unread_requests: { x: {} } },
  ];
  for (const bad of bads) {
    const m = mac();
    await m.hour(0);
    await runnerPass(m.ctx);
    editState(m, (st) => { Object.assign(st, bad); });
    await runnerPass(m.ctx);
    await runnerPass(m.ctx);
    assert.deepEqual(statusHolds(m).map((h) => h.id), ['refused-entry-unread'], JSON.stringify(bad));
    assert.match(statusHolds(m)[0].text, /A streak entry could not be read/);
    const left = stateOf(m);
    for (const k of Object.keys(bad)) assert.ok(left[k] === undefined || Object.keys(left[k]).length === 0, k);
    m.clock.t += REFUSED_QUIET_MS;
    await runnerPass(m.ctx);
    assert.deepEqual(statusHolds(m), [], 'told, then over');
  }
});

test('R-0b-171 L483: a bad hold entry is dropped and told, and never stops a pass', async () => {
  const good = { id: 'not-taken-S-9', session: 'S-9', card: 'C-1', head: HEAD, role: 'reviewer', text: 'x' };
  const bads = [
    { not_taken: { x: null } }, { not_taken: { x: 7 } }, { not_taken: { x: { ...good, head: 5 } } }, { not_taken: { x: { ...good, card: 5 } } },
    { not_taken: { x: { ...good, role: 5 } } }, { not_taken: { x: { ...good, id: 5 } } }, { not_taken: { x: { ...good, text: null } } }, { not_taken: 'x' }, { not_taken: [] },
    { no_verdict: { x: { card: 5 } } }, { no_verdict: 'x' },
  ];
  for (const bad of bads) {
    const m = mac();
    await m.hour(0);
    await runnerPass(m.ctx);
    editState(m, (st) => { Object.assign(st, bad); });
    await runnerPass(m.ctx);
    await runnerPass(m.ctx);
    assert.deepEqual(statusHolds(m).map((h) => h.id), ['hold-entry-unread'], JSON.stringify(bad));
    assert.match(statusHolds(m)[0].text, /A hold entry could not be read/);
    m.clock.t += REFUSED_QUIET_MS;
    await runnerPass(m.ctx);
    assert.deepEqual(statusHolds(m), [], 'told, then over');
  }
  const kept = mac({ verdictTaken: () => ({ ok: false, reason: 'not yet' }) });
  await kept.hour(0);
  await runnerPass(kept.ctx);
  editState(kept, (st) => { st.not_taken = { 'S-9': good }; });
  await runnerPass(kept.ctx);
  assert.deepEqual(statusHolds(kept).map((h) => h.id), ['not-taken-S-9'], 'a good entry is no bad one');
});

test('R-0b-171 L483: a dropped verdict comes back from its records', async () => {
  const m = await notTakenTold();
  editState(m, (st) => { st.not_taken['S-1'].head = 5; });
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 1);
  assert.deepEqual(statusHolds(m).map((h) => h.id).sort(), ['hold-entry-unread', 'not-taken-S-1']);
});

test('R-0b-171 C8: a bad entry is told when the Dispatcher relays it, then each day', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx);
  editState(m, (st) => { st.refused_streaks = { x: null }; });
  assert.deepEqual(await m.run(1, 60, /A streak entry could not be read/), [1, 25]);
});

test('R-0b-171: another reason each pass is the one hold, told once a day', async () => {
  let n = 0;
  const m = mac({ treeOf: async () => { n += 1; throw new Error(`away ${n}`); } });
  assert.deepEqual(await m.run(0, 50, REFUSED), [25, 49]);
});

test('R-0b-171: an accepted request ends it: the hold leaves, and a later streak has its own day', async () => {
  const m = mac({ treeOf: NO_TREE });
  assert.deepEqual(await m.run(0, 26, REFUSED), [25]);
  m.ctx.treeOf = async () => TREE;
  await m.hour(27);
  assert.equal(m.starts.length, 1, 'accepted');
  assert.deepEqual(stateOf(m).refused_streaks, {});
  assert.deepEqual(statusHolds(m).filter((h) => h.id.startsWith('refused-')), []);
  assert.deepEqual(await m.run(28, 60, REFUSED), []);
  assert.equal(m.rec.read('fact', REVIEW_HOLD_FACT('refused-C-1-reviewer')).doc.told_at, null, 'cleared after the hour');
});

test('R-0b-171: a review already started or running ends it, and is no refusal to tell', async () => {
  const m = mac();
  await m.hour(0); await m.hour(1);
  assert.equal(m.starts.length, 1);
  m.live.splice(0);
  editState(m, (st) => { st.refused_streaks = { 'C-1 reviewer': { card: 'C-1', role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0 - 20 * H), last_at: iso(T0), count: 3 } }; });
  assert.deepEqual(await m.run(2, 60, REFUSED), [], 'one start per tree: asked again, it is no trouble');
  assert.deepEqual(stateOf(m).refused_streaks, {});
  assert.equal(m.starts.length, 1);
});

test('R-0b-171: a streak ends when the card stops needing the role, whatever was refused', async () => {
  const m = mac({ treeOf: NO_TREE });
  await m.run(0, 26, REFUSED);
  m.ctx.readCard = () => ({ ok: true, doc: { state: 'done', head: HEAD, tier: 2 } });
  await runnerPass(m.ctx);
  assert.deepEqual(stateOf(m).refused_streaks, {});
});

test('R-0b-171: one refusal a day old is told, and one nothing has renewed for two days is over', async () => {
  const m = mac();
  await m.hour(0);
  await runnerPass(m.ctx); // the request is taken, so none is waiting below
  const streak = (over) => ({ 'C-1 reviewer': { card: 'C-1', role: 'reviewer', head: HEAD, reason: 'x', first_at: iso(T0 - 30 * H), last_at: iso(T0 - H), ...over } });
  const pass = async (over) => { editState(m, (st) => { st.refused_streaks = streak(over); }); await runnerPass(m.ctx); return statusHolds(m).map((h) => h.id); };
  assert.deepEqual(await pass({}), ['refused-C-1-reviewer']);
  assert.deepEqual(await pass({ first_at: iso(T0 - 23 * H) }), [], 'less than a day');
  assert.deepEqual(await pass({ first_at: iso(T0 - 24 * H), last_at: iso(T0 - 24 * H) }), ['refused-C-1-reviewer'], 'the only refusal, a day old');
  assert.deepEqual(await pass({ last_at: iso(T0 - REFUSED_QUIET_MS) }), [], 'over');
  assert.deepEqual(stateOf(m).refused_streaks, {});
});

test('R-0b-171 A5: a same-tree amend, a memory reset and the new tree unreadable: the verdict is told each day, not dropped', async () => {
  const m = await notTakenTold();
  amend(m); treeAway(m);
  rmSync(join(m.root, 'state.json'));
  assert.deepEqual(await m.run(5, 80, NOT_TAKEN_ANY), [28, 52, 76]);
  assert.match(held(m)[0].text, /at bbbbbbb .*the tree of bbbbbbb can't be read, so whether the verdict still counts can't be checked/);
  assert.equal(m.starts.length, 1, 'nothing started again');
});

test('R-0b-171 A6: the same with no reset: the kept hold stays, at the card\'s head', async () => {
  const m = await notTakenTold();
  const asked = [];
  m.ctx.verdictTaken = (x) => { asked.push(x.head); return { ok: false, reason: 'no verdict' }; };
  amend(m); treeAway(m);
  assert.deepEqual(await m.run(5, 80, NOT_TAKEN_ANY), [28, 52, 76]);
  assert.match(held(m)[0].text, /at bbbbbbb/);
  assert.ok(asked.every((h) => h === HEAD2), 'asked at the card\'s head');
});

test('R-0b-171: a pass that stops before the rebuild still keeps a hold whose tree can\'t be read', async () => {
  const m = await notTakenTold();
  amend(m); treeAway(m);
  m.ctx.sessions = async () => { throw new Error('no list'); };
  await runnerPass(m.ctx);
  assert.equal(held(m).length, 1);
});

test('R-0b-171: when the tree reads again the verdict is judged by it', async () => {
  for (const [tree, left] of [[TREE, 1], ['d'.repeat(40), 0]]) {
    const m = await notTakenTold();
    amend(m); treeAway(m);
    await runnerPass(m.ctx);
    assert.equal(held(m).length, 1);
    assert.equal(stateOf(m).not_taken['S-1'].tree_unread, true);
    m.ctx.treeOf = async () => tree;
    await runnerPass(m.ctx);
    assert.equal(held(m).length, left);
    if (left) assert.doesNotMatch(held(m)[0].text, /can't be read/);
  }
});

test('R-0b-171: a verdict taken at the new head, or a card done, ends a hold whose tree can\'t be read', async () => {
  const m = await notTakenTold();
  amend(m); treeAway(m);
  await runnerPass(m.ctx);
  m.ctx.verdictTaken = () => ({ ok: true });
  await runnerPass(m.ctx);
  assert.deepEqual(held(m), []);
  const d = await notTakenTold();
  amend(d); treeAway(d);
  await runnerPass(d.ctx);
  d.ctx.readCard = () => ({ ok: true, doc: { state: 'done', head: HEAD2, tier: 2 } });
  await runnerPass(d.ctx);
  assert.deepEqual(held(d), []);
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
