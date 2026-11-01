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
import { PRODUCT, UID, claimOnly, iso, must, product, put, readyCard, runCard, claimCard, rulesFor, seed, sessionClaim, setup } from './fixtures.test-helper.mjs';

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
  assert.equal(c.claim.claimed_at, iso(env.clock.t), 'the writer stamps the claim time');
  assert.equal(c.claim.pid, undefined, 'the process comes at claimed → running (L72)');
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
  const r3 = put(env3.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: claimOnly(sessionClaim()) });
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
  assert.match(again.record.breakIfDead({ card: 'C-1' }).reason, /no process yet; it lapses at claims.unlaunched_min, never broken/);
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
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running', claim: { ...env.record.read('card', 'C-1').doc.claim, pid: 4242, pid_start: 'x' } }));
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

test('a session claim needs a session id that session can hand in with (0b-2 audit round 7 m-2)', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env);
  for (const sid of ['S'.repeat(129), 'S_1']) {
    const r = put(env.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: { ...sessionClaim(), session_id: sid } });
    assert.match(r.reason, /session_id the session can hand in with/);
  }
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

test('claim 8: a session claim that never starts lapses at claims.unlaunched_min, once its session id is stopped (L72)', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env, ['C-1', 'C-2']);
  claimCard(env, 'C-1');
  runCard(env, 'C-2', sessionClaim({ session_id: 'S-2', pid: 5000 }));
  const t0 = env.clock.t;
  const asked = [];
  const stop = (answer) => (sid) => { asked.push(sid); return answer; };
  // The default is 5 minutes (none set in these rules).
  assert.deepEqual(env.record.lapseClaims(t0 + 5 * MIN, { stopSession: stop(true) }).lapsed, [], 'not at the limit');
  assert.deepEqual(asked, [], 'nothing is stopped before the limit');
  // Past it, but no way to stop the session, or a stop that doesn't say it stopped: the claim stays, told once a day.
  assert.deepEqual(env.record.lapseClaims(t0 + 5 * MIN + 1).lapsed, []);
  assert.deepEqual(env.record.lapseClaims(t0 + 5 * MIN + 2, { stopSession: stop(false) }).lapsed, []);
  assert.deepEqual(env.record.lapseClaims(t0 + 5 * MIN + 3, { stopSession: () => { throw new Error('ps failed'); } }).lapsed, []);
  assert.equal(env.alerts.filter((a) => a.type === 'unlaunched_claim_held' && a.card === 'C-1').length, 1, 'one alert a day');
  assert.equal(env.record.read('card', 'C-1').doc.state, 'claimed');
  // Stopped: it lapses back to ready, with a diary line; only the unlaunched claim's session was asked about.
  asked.length = 0;
  const r = env.record.lapseClaims(t0 + 5 * MIN + 4, { stopSession: stop(true) });
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']]);
  assert.deepEqual(asked, ['S-1']);
  assert.equal(env.record.read('card', 'C-1').doc.claim, undefined);
  const line = env.record.diary().at(-1);
  assert.equal(line.kind, 'claim_lapse');
  assert.equal(line.data.why, 'never launched');
  assert.equal(line.data.session_id, 'S-1');
  assert.equal(env.record.read('card', 'C-2').doc.state, 'running', 'a running session claim never lapses; G1 decides');
  // The rules may set the limit; a bad one refuses.
  const env2 = setup({ prefix: 'm9-claim-', values: { 'claims.unlaunched_min': 20 } });
  board(env2);
  claimCard(env2, 'C-1');
  assert.deepEqual(env2.record.lapseClaims(env2.clock.t + 6 * MIN, { stopSession: () => true }).lapsed, []);
  assert.deepEqual(env2.record.lapseClaims(env2.clock.t + 20 * MIN + 1, { stopSession: () => true }).lapsed.map((x) => x.card), ['C-1']);
  const env3 = setup({ prefix: 'm9-claim-', values: { 'claims.unlaunched_min': 0 } });
  assert.match(env3.record.lapseClaims(env3.clock.t).reason, /claims.unlaunched_min must be a whole number/);
});

test('the claim has two steps: claimed names the session, running adds only its process (L72)', () => {
  const env = setup({ prefix: 'm9-claim-' });
  board(env, ['C-1', 'C-2']);
  // A claim carrying a pid is refused: the process comes at claimed → running.
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: sessionClaim() }).reason, /gets its pid at claimed → running/);
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: { ...claimOnly(sessionClaim()), note: 'x' } }).reason, /a session claim has no note/);
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: { ...claimOnly(sessionClaim()), rules_rev: '' } }).reason, /rules_rev names the rules/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'claimed', claim: { ...claimOnly(sessionClaim()), rules_rev: 'r-7' } }), 'claim with rules_rev');
  const claim = env.record.read('card', 'C-1').doc.claim;
  assert.equal(claim.rules_rev, 'r-7');
  // Running needs the pid and pid_start, and changes nothing else in the claim.
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running' }).reason, /needs the session's pid/);
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running', claim: { ...claim, pid: 9 } }).reason, /needs pid_start/);
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running', claim: { ...claim, pid: 9, pid_start: 'x', session_id: 'S-2' } }).reason, /only adds pid and pid_start/);
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running', claim: { ...claim, pid: 9, pid_start: 'x', rules_rev: 'r-8' } }).reason, /only adds pid and pid_start/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'running', claim: { ...claim, pid: 9, pid_start: 'x' } }), 'start');
  assert.equal(env.record.read('card', 'C-1').doc.claim.pid, 9);
  // Once running, the claim never changes by a write.
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { claim: { ...env.record.read('card', 'C-1').doc.claim, pid: 10 } }).reason, /a claim is set only by ready → claimed/);
  // A tab claim is the same at running.
  claimCard(env, 'C-2', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
  const tab = env.record.read('card', 'C-2').doc.claim;
  assert.match(put(env.record, 'dispatcher', 'card', 'C-2', { state: 'running', claim: { ...tab, pid: 3, pid_start: 'x' } }).reason, /a tab claim does not change/);
  must(put(env.record, 'dispatcher', 'card', 'C-2', { state: 'running' }), 'tab start');
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

test('breakIfDead breaks only the claim it is given, each once its own owner is provably dead; the outage rule is M11\'s (L72)', () => {
  const ids = ['C-1', 'C-2', 'C-3', 'C-4'];
  const make = (deadPids, list = ids) => {
    const env = setup({ prefix: 'm9-g1-', probe: fakeProbe({ dead: deadPids }) });
    board(env, list);
    list.forEach((id, i) => { runCard(env, id, sessionClaim({ session_id: `S-${i}`, pid: 100 + i })); session(env, `S-${i}`, { state: 'ended', pid: 100 + i, ago: 600 }); });
    return env;
  };
  // Three of four dead: M9 no longer counts the board, so each dead one asked about is broken, each alerted once.
  const three = make([100, 101, 102]);
  for (const id of ['C-1', 'C-2', 'C-3']) must(three.record.breakIfDead({ card: id }), `${id} is dead`);
  assert.match(three.record.breakIfDead({ card: 'C-4' }).reason, /process alive/, 'a live pid is never broken');
  assert.deepEqual(three.alerts.filter((a) => a.type === 'claim_broken').map((a) => a.card), ['C-1', 'C-2', 'C-3']);
  assert.equal(three.alerts.filter((a) => a.type === 'claims_outage').length, 0, 'no outage alert from M9');
  assert.equal(three.record.read('card', 'C-4').doc.state, 'running');
  // Asked again about a broken card: it is ready now, so nothing more happens.
  assert.match(three.record.breakIfDead({ card: 'C-1' }).reason, /only a claimed or running card's claim is broken/);
});

test('a tab claim is never broken; with no heartbeat writer named, it lapses at the running limit (L74 addendum)', () => {
  const env = setup({ prefix: 'm9-tab-', probe: fakeProbe({ dead: [4242] }) });
  board(env, ['C-1', 'C-2', 'C-3']);
  const t0 = env.clock.t;
  claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
  runCard(env, 'C-2', { kind: 'tab', claim_id: 'T-2', host: 'mac-a' });
  runCard(env, 'C-3', { kind: 'tab', claim_id: 'T-3', host: 'mac-a' });
  assert.match(env.record.breakIfDead({ card: 'C-2' }).reason, /a tab claim is never broken/);
  // A heartbeat has no family, so no role can write one by that name; one a role writes in its own family, or one put
  // straight into the store, is a look-alike and keeps no claim alive (it fails closed: the running limit decides).
  assert.match(env.record.write({ actor: 'sensors', entity: 'fact', id: 'hb-T-1', expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: 'T-1' } }).reason, /in no family/);
  for (let m = 8; m <= 56; m += 8) {
    env.clock.t = t0 + m * MIN;
    must(env.record.write({ actor: 'sensors', entity: 'fact', id: `usage-hb-${m}`, expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: 'T-3' } }), 'look-alike');
    env.store.transaction((tx) => tx.commit([{ entity: 'fact', id: `hb-${m}`, doc: { type: 'tab_heartbeat', claim_id: 'T-3' } }], { actor: 'sensors', kind: 'seed' }));
  }
  assert.deepEqual(env.record.lapseClaims(t0 + 60 * MIN).lapsed, [], 'not at the running limit');
  const r = env.record.lapseClaims(t0 + 60 * MIN + 1);
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]).sort(), [['C-1', 'ready'], ['C-2', 'waiting'], ['C-3', 'waiting']]);
  const w = env.record.read('card', 'C-2').doc;
  assert.equal(w.claim, undefined);
  assert.equal(w.wait.return_to, 'ready');
  assert.equal(w.wait.resume, 'retry');
  assert.ok(diaryKinds(env).filter((k) => k === 'claim_lapse').length === 3);
});
