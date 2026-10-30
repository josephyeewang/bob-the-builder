// claims.test.mjs — R-0b-22, R-0b-23, R-0b-26: the 9 claim tests (m-4) and the dead-owner rule G1 (M-5).
// Claim test 4 (8 processes racing) is race.test.mjs. G1: a session's claim is broken only when (a) its process,
// (b) its session and (c) its recent activity all say it is gone; a tab's claim is never broken, only lapses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidStart, realProbe, sleepMs } from './lock.mjs';
import { openRecord } from './writer.mjs';
import { PRODUCT, UID, iso, must, product, put, readyCard, runCard, claimCard, rulesFor, seed, sessionClaim, setup } from './fixtures.test-helper.mjs';

const MIN = 60000;
const err = (code) => Object.assign(new Error(code), { code });
// A fake process table: `dead` pids answer ESRCH, `eperm` pids EPERM, `starts` gives a pid's start time.
function fakeProbe({ dead = [], eperm = [], starts = {} } = {}) {
  return {
    kill(pid) { if (dead.includes(pid)) throw err('ESRCH'); if (eperm.includes(pid)) throw err('EPERM'); },
    pidStart: (pid) => starts[pid] ?? 'Thu Oct  1 11:00:00 2026',
  };
}
// A session record for claim `sid`, written `ago` minutes before the clock.
function session(env, sid, { state = 'ended', pid = 4242, pid_start = 'Thu Oct  1 11:00:00 2026', ago = 0 } = {}) {
  const t = env.clock.t;
  env.clock.t = t - ago * MIN;
  seed(env, 'session', sid, { state, role: 'worker', pid, pid_start, card: null, last_activity: iso(env.clock.t) });
  env.clock.t = t;
}
const diaryKinds = (env) => env.record.diary().map((l) => l.kind);

function board(env, ids = ['C-1']) {
  product(env);
  for (const id of ids) readyCard(env, id);
}

// ---------------- the 9 claim tests (m-4) ----------------

test('claim 1: a claim on a ready card wins, is stamped with the time, and writes one claim line', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  claimCard(env, 'C-1');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'claimed');
  assert.equal(c.claim.session_id, 'S-1');
  assert.equal(c.claim.at, iso(env.clock.t), 'the writer stamps the claim time');
  assert.equal(diaryKinds(env).filter((k) => k === 'claim').length, 1);
  assert.deepEqual(env.record.ready(), [], 'a claimed card leaves the ready list');
});

test('claim 2: a second claim is refused and names the holder', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  const read = env.record.read('card', 'C-1');
  claimCard(env, 'C-1');
  const late = env.record.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: read.rev, doc: { ...read.doc, state: 'claimed', claim: sessionClaim({ session_id: 'S-2', pid: 5000 }) } });
  assert.equal(late.ok, false);
  assert.match(late.reason, /claimed by S-1 on mac-a/);
  // Re-reading and trying to swap the holder is refused too.
  const swap = put(env.record, 'dispatcher', 'card', 'C-1', { claim: sessionClaim({ session_id: 'S-2' }) });
  assert.match(swap.reason, /a claim is set only by ready → claimed/);
  assert.equal(env.record.read('card', 'C-1').doc.claim.session_id, 'S-1');
});

test('claim 3: a claim made on a stale read is refused', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  const read = env.record.read('card', 'C-1');
  must(put(env.record, 'approvals', 'card', 'C-1', { approval_required: true }), 'edit');
  const r = env.record.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: read.rev, doc: { ...read.doc, state: 'claimed', claim: sessionClaim() } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /changed since read/);
  assert.equal(env.record.read('card', 'C-1').doc.state, 'ready');
});

test('claim 5: a claim on a card that is not ready is refused', () => {
  for (const doc of [{ state: 'draft' }, { state: 'running' }]) {
    const env2 = setup({ prefix: 'm9-claim-' });
    product(env2);
    seed(env2, 'card', 'C-9', { product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, ...doc, ...(doc.state === 'running' ? { claim: sessionClaim() } : {}) });
    const r = put(env2.record, 'dispatcher', 'card', 'C-9', { state: 'claimed', claim: sessionClaim({ session_id: 'S-7' }) });
    assert.equal(r.ok, false, doc.state);
    assert.match(r.reason, /illegal move|may not move/, doc.state);
  }
  // A ready card whose go no longer matches can't be claimed either.
  const env3 = setup({ prefix: 'm9-claim-' });
  board(env3);
  seed(env3, 'go', 'go-C-1', { product: PRODUCT, card_id: 'C-1', plan_fingerprint: 'f'.repeat(64) });
  const r3 = put(env3.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: sessionClaim() });
  assert.match(r3.reason, /can't claim: no go from the owner/);
});

test('claim 6: a claim survives a writer restart', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  claimCard(env, 'C-1');
  const again = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), host: 'mac-a', now: () => env.clock.t, probe: fakeProbe() });
  again.recover();
  const c = again.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'claimed');
  assert.equal(c.claim.session_id, 'S-1');
  assert.match(again.record.breakIfDead({ card: 'C-1' }).reason, /process alive/);
});

test('claim 7: only the holder may release a claim', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  claimCard(env, 'C-1');
  const r = env.record.release({ card: 'C-1', session_id: 'S-2' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only the claim's holder \(S-1\)/);
  assert.match(env.record.release({ card: 'C-1' }).reason, /holder/);
  must(env.record.release({ card: 'C-1', session_id: 'S-1' }), 'release');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'ready');
  assert.equal(c.claim, undefined);
  assert.equal(diaryKinds(env).at(-1), 'claim_release');
  assert.deepEqual(env.record.ready().map((x) => x.id), ['C-1']);
  // A running card is not released this way: it hands in or is broken.
  claimCard(env, 'C-1');
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running' }));
  assert.match(env.record.release({ card: 'C-1', session_id: 'S-1' }).reason, /not claimed/);
});

test('a card id that climbs out of the store touches nothing outside it (round 5 m-2)', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  const victim = join(env.root, '..', 'victim.json');
  writeFileSync(victim, 'keep me');
  const evil = '../../../victim';
  assert.equal(env.record.release({ card: evil, session_id: 'S-1' }).ok, false);
  assert.equal(env.record.breakIfDead({ card: evil }).ok, false);
  assert.equal(env.record.read('card', evil), null);
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
  assert.deepEqual(readdirSync(join(env.root, 'quarantine')), []);
});

test('a lapse checks the card file first: a hand-edited card is quarantined and alerted, not silently replaced (0b-2 audit round 3 m-C)', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env, ['C-1']);
  claimCard(env, 'C-1');
  const file = join(env.root, 'docs', 'card', 'C-1.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"claimed"', '"merged"'));
  env.alerts.length = 0;
  assert.deepEqual(env.record.lapseClaims(env.clock.t + 61 * MIN).lapsed, []);
  assert.ok(env.alerts.some((a) => a.type === 'tamper'), 'tamper alerted');
  assert.equal(readdirSync(join(env.root, 'quarantine')).length, 1, 'the edited file is kept');
  assert.equal(env.record.read('card', 'C-1').doc.state, 'claimed', 'restored from the diary');
});

test('claim 8: a session claim that never starts lapses at its time limit, with a diary line', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env, ['C-1', 'C-2']);
  claimCard(env, 'C-1');
  runCard(env, 'C-2', sessionClaim({ session_id: 'S-2', pid: 5000 }));
  const t0 = env.clock.t;
  assert.deepEqual(env.record.lapseClaims(t0 + 60 * MIN).lapsed, [], 'not at the limit');
  const r = env.record.lapseClaims(t0 + 60 * MIN + 1);
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']]);
  assert.equal(env.record.read('card', 'C-1').doc.claim, undefined);
  assert.equal(diaryKinds(env).at(-1), 'claim_lapse');
  assert.equal(env.record.read('card', 'C-2').doc.state, 'running', 'a running session claim never lapses; G1 decides');
});

test('claim 9: a dead owner\'s claim is broken (process gone, session ended, no recent activity)', () => {
  const env = setup({ prefix: 'm9-claim-', probe: fakeProbe({ dead: [4242] }) });
  board(env);
  runCard(env, 'C-1');
  session(env, 'S-1', { state: 'ended', ago: 31 });
  must(env.record.breakIfDead({ card: 'C-1' }), 'break');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'ready');
  assert.equal(c.claim, undefined);
  const line = env.record.diary().at(-1);
  assert.equal(line.kind, 'claim_break');
  assert.equal(line.data.session_id, 'S-1');
});

// ---------------- G1, the dead-owner rule (M-5) ----------------

function liveChild() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !pidStart(c.pid); i++) sleepMs(20);
  return c;
}

test('G1: a stopped (SIGSTOP) owner keeps its claim however long it has been', async () => {
  const kid = liveChild();
  try {
    process.kill(kid.pid, 'SIGSTOP');
    const env = setup({ prefix: 'm9-g1-', probe: realProbe });
    board(env);
    const claim = sessionClaim({ pid: kid.pid, pid_start: pidStart(kid.pid) });
    runCard(env, 'C-1', claim);
    session(env, 'S-1', { state: 'running', pid: kid.pid, pid_start: claim.pid_start, ago: 600 });
    env.clock.t += 24 * 60 * MIN;
    assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /process alive/);
    assert.deepEqual(env.record.lapseClaims().lapsed, []);
    assert.equal(env.record.read('card', 'C-1').doc.claim.pid, kid.pid);
  } finally { kid.kill('SIGKILL'); }
});

test('G1: a killed (SIGKILL) owner with its session ended and a stale clock loses the claim', async () => {
  const kid = liveChild();
  const start = pidStart(kid.pid);
  const gone = new Promise((res) => kid.on('exit', res));
  kid.kill('SIGKILL');
  await gone;
  const env = setup({ prefix: 'm9-g1-', probe: realProbe });
  board(env);
  runCard(env, 'C-1', sessionClaim({ pid: kid.pid, pid_start: start }));
  session(env, 'S-1', { state: 'ended', pid: kid.pid, pid_start: start, ago: 31 });
  must(env.record.breakIfDead({ card: 'C-1' }), 'break');
  assert.equal(env.record.read('card', 'C-1').doc.state, 'ready');
});

test('G1 (c): recent activity keeps a dead owner\'s claim until it ages out', () => {
  const env = setup({ prefix: 'm9-g1-', probe: fakeProbe({ dead: [4242] }) });
  board(env);
  runCard(env, 'C-1');
  session(env, 'S-1', { state: 'ended', ago: 10 });
  assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /recent activity/);
  env.clock.t += 20 * MIN;   // exactly 30 minutes: still recent
  assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /recent activity/);
  env.clock.t += 1;
  must(env.record.breakIfDead({ card: 'C-1' }), 'break once aged out');
});

test('G1 (a): EPERM counts as alive, with a fake and with a real process of another user', () => {
  const env = setup({ prefix: 'm9-g1-', probe: fakeProbe({ eperm: [4242] }) });
  board(env);
  runCard(env, 'C-1');
  session(env, 'S-1', { state: 'ended', ago: 600 });
  assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /process alive/);
  // pid 1 belongs to root: kill(1, 0) is EPERM for this user.
  assert.throws(() => process.kill(1, 0), (e) => e.code === 'EPERM');
  assert.match(env.record.breakIfDead({ card: 'C-1' }, { ...realProbe, kill: () => process.kill(1, 0) }).reason, /process alive/);
});

test('G1 (a): a reused pid (other start time) is a dead process, but the claim stays while (b) or (c) say alive', () => {
  const probe = fakeProbe({ starts: { 4242: 'Fri Oct  2 09:00:00 2026', 7000: 'Thu Oct  1 11:00:00 2026' } });
  const env = setup({ prefix: 'm9-g1-', probe });
  board(env);
  runCard(env, 'C-1');
  session(env, 'S-1', { state: 'running', pid: 7000, ago: 600 });
  assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /session alive/, '(b) fails');
  session(env, 'S-1', { state: 'ended', ago: 5 });
  assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /recent activity/, '(c) fails');
  env.clock.t += 26 * MIN;
  must(env.record.breakIfDead({ card: 'C-1' }), 'all three agree');
});

test('G1: no session record, another host, or no stuck_min in the rules: nothing is broken', () => {
  const env = setup({ prefix: 'm9-g1-', probe: fakeProbe({ dead: [4242] }) });
  board(env, ['C-1', 'C-2']);
  runCard(env, 'C-1');
  assert.match(env.record.breakIfDead({ card: 'C-1' }).reason, /no session record/);
  runCard(env, 'C-2', sessionClaim({ host: 'mac-b', session_id: 'S-2' }));
  session(env, 'S-2', { state: 'ended', ago: 600 });
  assert.match(env.record.breakIfDead({ card: 'C-2' }).reason, /host mac-b; never broken from here/);
  const env2 = setup({ prefix: 'm9-g1-', probe: fakeProbe({ dead: [4242] }), values: { 'claims.stuck_min': undefined } });
  board(env2);
  runCard(env2, 'C-1');
  session(env2, 'S-1', { state: 'ended', ago: 600 });
  assert.match(env2.record.breakIfDead({ card: 'C-1' }).reason, /no claims.stuck_min/);
  assert.match(env.record.breakIfDead({ card: 'C-9' }).reason, /no card C-9/);
});

test('G1 outage: when half or more of this Mac\'s claims look dead at once, none is broken', () => {
  const ids = ['C-1', 'C-2', 'C-3', 'C-4'];
  const make = (deadPids) => {
    const env = setup({ prefix: 'm9-g1-', probe: fakeProbe({ dead: deadPids }) });
    board(env, ids);
    ids.forEach((id, i) => { runCard(env, id, sessionClaim({ session_id: `S-${i}`, pid: 100 + i })); session(env, `S-${i}`, { state: 'ended', pid: 100 + i, ago: 600 }); });
    return env;
  };
  const three = make([100, 101, 102]);
  const r = three.record.breakIfDead({ card: 'C-1' });
  assert.match(r.reason, /3 of 4 claims look dead at once; none is broken/);
  assert.ok(three.alerts.some((a) => a.type === 'claims_outage' && a.dead === 3));
  assert.ok(ids.every((id) => three.record.read('card', id).doc.state === 'running'));
  // One alert per Mac per day, however many passes and cards (L38; 0b-2 audit MIN-1); a new day alerts again.
  for (let pass = 0; pass < 2; pass++) for (const id of ids.slice(0, 3)) three.record.breakIfDead({ card: id });
  assert.equal(three.alerts.filter((a) => a.type === 'claims_outage').length, 1);
  three.clock.t += 24 * 60 * 60000;
  three.record.breakIfDead({ card: 'C-1' });
  assert.equal(three.alerts.filter((a) => a.type === 'claims_outage').length, 2);
  const two = make([100, 101]);
  assert.match(two.record.breakIfDead({ card: 'C-1' }).reason, /2 of 4/);
  const one = make([100]);
  must(one.record.breakIfDead({ card: 'C-1' }), 'one of four is broken');
});

test('a tab claim is never broken; it lapses when its heartbeat goes stale or at the running limit', () => {
  const env = setup({ prefix: 'm9-tab-', probe: fakeProbe({ dead: [4242] }) });
  board(env, ['C-1', 'C-2', 'C-3']);
  const t0 = env.clock.t;
  claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
  runCard(env, 'C-2', { kind: 'tab', claim_id: 'T-2', host: 'mac-a' });
  runCard(env, 'C-3', { kind: 'tab', claim_id: 'T-3', host: 'mac-a' });
  assert.match(env.record.breakIfDead({ card: 'C-2' }).reason, /a tab claim is never broken/);
  const beat = (id, at) => { env.clock.t = at; must(env.record.write({ actor: 'sensors', entity: 'fact', id: `hb-${id}-${at}`, expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: id } }), 'beat'); };
  beat('T-1', t0 + 8 * MIN);
  beat('T-2', t0 + 8 * MIN);
  for (let m = 8; m <= 56; m += 8) beat('T-3', t0 + m * MIN);
  assert.deepEqual(env.record.lapseClaims(t0 + 18 * MIN).lapsed, [], 'a beat 10 minutes ago is not stale');
  const r = env.record.lapseClaims(t0 + 18 * MIN + 1);
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]).sort(), [['C-1', 'ready'], ['C-2', 'waiting']]);
  const w = env.record.read('card', 'C-2').doc;
  assert.equal(w.claim, undefined);
  assert.equal(w.wait.return_to, 'ready');
  assert.equal(w.wait.resume, 'retry');
  // C-3 keeps beating but hits the 60-minute running limit.
  assert.deepEqual(env.record.lapseClaims(t0 + 60 * MIN).lapsed, []);
  assert.deepEqual(env.record.lapseClaims(t0 + 60 * MIN + 1).lapsed.map((x) => x.card), ['C-3']);
  assert.ok(diaryKinds(env).filter((k) => k === 'claim_lapse').length === 3);
});
