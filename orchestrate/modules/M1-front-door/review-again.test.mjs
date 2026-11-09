// review-again.test.mjs — R-0b-164: the owner's [Review again] tap, from the runner's offer to one new review.
// The handler writes the tap; the REAL review runner (runnerPass) reads it through the REAL readJoeTaps. Only the runner's
// outside effects (claude, git, the Record) are fakes, as in M4's own runner tests; the folders are throwaway ones this
// test's user owns, standing in for the owner (taps) and the review user (the runner's folders).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { readJoeTaps } from '../M4-workshop/launcher/review-runner-main.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { REVIEW_AGAIN, REVIEW_AGAIN_BUTTON, reviewAgainOffers, reviewAgainCard, writeTap, clearReadTaps, main } from './review-again.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME };
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const T0 = Date.parse('2026-11-09T12:00:00Z');
const CLAUDE = '/pinned/claude';

// The owner's taps folder, as setup makes it (layout.mjs ownerTapsPath: the owner's, 0755).
function tapsFolder(base) {
  const dir = join(base, 'owner-taps');
  mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755); chmodSync(base, 0o755);
  return dir;
}

// The runner's world, cut down from M4 review-runner.test.mjs; its taps are the real folder, read by the real reader.
function world() {
  const base = tempDir('m1-review-again-');
  chmodSync(base, 0o755);
  const root = join(base, 'review');
  const outboxRoot = join(base, 'outbox');
  for (const d of [root, outboxRoot]) { mkdirSync(d, { mode: 0o755 }); chmodSync(d, 0o755); }
  const taps = tapsFolder(base);
  const clock = { t: T0 };
  const cards = new Map([['C-1', { state: 'in_review', head: HEAD, tier: 2 }]]);
  const heads = new Map([['C-1', HEAD]]);
  const live = [];
  const starts = [];
  let n = 0;
  let pid = 1000;
  const ctx = {
    root, outboxRoot, uids: UIDS, reviewHome: join(base, 'review-home'), claudeBin: CLAUDE,
    processName: (p) => { const s = live.find((x) => x.pid === p); return s ? `${CLAUDE} --session-id ${s.sessionId}` : null; },
    now: () => clock.t, ownUid: () => ME, newId: () => `S-${++n}`,
    isAdmin: async () => false,
    readCard: (c) => (cards.has(c) ? { ok: true, doc: cards.get(c) } : { ok: false }),
    currentHead: (c) => heads.get(c),
    treeOf: async (c, h) => (h === HEAD ? 'c'.repeat(40) : 'd'.repeat(40)),
    // The real wiring's port (review-runner-main.mjs realPorts): the owner's folder through readJoeTaps.
    setAsideByJoe: () => readJoeTaps({ dir: taps, ownerUid: ME }),
    sessions: async () => live.slice(),
    stop: async (s) => { const i = live.findIndex((x) => x.pid === s.pid); if (i >= 0) live.splice(i, 1); },
    start: async (x) => {
      starts.push(x); const p = ++pid; live.push({ pid: p, sessionId: x.sessionId });
      mkdirSync(x.packageDir, { mode: 0o755 });
      const diff = `diff for ${x.sessionId}\n`;
      writeFileSync(join(x.packageDir, 'change.diff'), diff, { mode: 0o644, flag: 'wx' });
      return { ok: true, pid: p, package_sha256: createHash('sha256').update(diff).digest('hex') };
    },
    accountInUse: () => 'a',
    handedIn: () => ({ ok: false, none: true }),
    verdictTaken: () => ({ ok: true }),
  };
  let q = 0;
  const ask = () => writeFileSync(join(root, 'requests', `q-${++q}.json`), JSON.stringify({ card: 'C-1', head: heads.get('C-1'), role: 'reviewer', request_id: `q-${q}` }), { mode: 0o644 });
  const status = () => JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'));
  const end = (sid) => { live.splice(live.findIndex((x) => x.sessionId === sid), 1); };
  return { base, root, outboxRoot, taps, clock, cards, heads, live, starts, ctx, ask, status, end };
}

// One reviewer that starts, then ends silent: the runner offers "review again" for S-1.
async function silentS1() {
  const w = world();
  assert.equal((await runnerPass(w.ctx)).ok, true);
  w.ask();
  await runnerPass(w.ctx);
  w.end('S-1');
  await runnerPass(w.ctx);
  return w;
}
const offersOf = (w) => reviewAgainOffers(w.status());

test('R-0b-164: a silent review shows [Review again] on the phone card, with the runner\'s own words', async () => {
  const w = await silentS1();
  const offers = offersOf(w);
  assert.deepEqual(offers.map((o) => o.session_id), ['S-1']);
  const card = reviewAgainCard(offers[0]);
  assert.deepEqual(card.buttons, [REVIEW_AGAIN_BUTTON]);
  assert.deepEqual(card.tap, { action: REVIEW_AGAIN, session_id: 'S-1' });
  assert.match(card.text, /reviewer session S-1 for card C-1 at aaaaaaa ended without handing in a verdict/);
});

test('R-0b-164: offers are only the runner\'s review-again alerts, one per session, with bad ids and control characters dropped', () => {
  const offers = reviewAgainOffers({ alerts: [
    { id: 'x', text: 'no offer' },
    { id: 'a', action: REVIEW_AGAIN, session_id: 'S-1', text: 'first\u0007' },
    { id: 'b', action: REVIEW_AGAIN, session_id: '../x', text: 'path' },
    { id: 'c', action: 'something-else', session_id: 'S-2', text: 'other' },
    { id: 'd', action: REVIEW_AGAIN, session_id: 'S-1', text: 'again' },
  ] });
  assert.deepEqual(offers.map((o) => [o.session_id, o.text]), [['S-1', 'again']]);
  assert.deepEqual(reviewAgainOffers(null), []);
  assert.deepEqual(reviewAgainOffers({ alerts: 'no' }), []);
});

test('R-0b-164 planted: one real tap starts exactly one new review; the tap is read once, then cleared', async () => {
  const w = await silentS1();
  const r0 = writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w) });
  assert.equal(r0.ok, true, r0.reason);
  const st = statSync(r0.file);
  assert.equal(st.mode & 0o777, 0o644);
  const doc = JSON.parse(readFileSync(r0.file, 'utf8'));
  assert.equal(doc.session_id, 'S-1');
  assert.deepEqual(Object.keys(doc), ['session_id', 'tapped_at', 'nonce']);
  assert.deepEqual(readdirSync(w.taps), ['S-1.json'], 'no temp file is left');
  w.ask();
  let r = await runnerPass(w.ctx);
  assert.deepEqual(r.setAside, [{ session_id: 'S-1', card: 'C-1', role: 'reviewer' }]);
  assert.deepEqual(r.started.map((x) => x.session_id), ['S-2']);
  // The same tap, still in the folder, is read once: no third session.
  w.end('S-2');
  w.ask();
  r = await runnerPass(w.ctx);
  assert.deepEqual(r.setAside, []);
  assert.deepEqual(r.started, []);
  assert.equal(w.starts.length, 2, 'exactly one new review');
  // The runner's status lists the tap as read; the handler then removes it.
  const c = clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: w.status().taps_read });
  assert.deepEqual(c, { removed: ['S-1'] });
  assert.deepEqual(readdirSync(w.taps), []);
});

test('R-0b-164: a tap written again is a new tap, and a tap the runner has not read is never cleared', async () => {
  const w = await silentS1();
  assert.equal(writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w) }).ok, true);
  const k1 = readJoeTaps({ dir: w.taps, ownerUid: ME })[0].key;
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [] }), { removed: [] });
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: undefined }), { removed: [], error: 'the status gives no list of taps read' });
  assert.ok(existsSync(join(w.taps, 'S-1.json')));
  // Written again in the same millisecond: new bytes, so a new key, and the old read key does not remove it.
  const r = writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w), now: () => T0, rand: () => 'second' });
  assert.equal(r.ok, true, r.reason);
  const k2 = readJoeTaps({ dir: w.taps, ownerUid: ME })[0].key;
  assert.notEqual(k2, k1);
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [k1] }), { removed: [] });
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [k2] }), { removed: ['S-1'] });
});

test('R-0b-164 planted: a tap for a session the runner does not offer writes nothing', async () => {
  const w = await silentS1();
  const cases = [
    ['a session not offered', 'S-404', /the review runner does not offer it for that session now/],
    ['a running session', 'S-9', /does not offer it/],
    ['not a session id', '../x', /that is not a session id/],
    ['empty', '', /that is not a session id/],
  ];
  for (const [what, sid, re] of cases) {
    const r = writeTap({ dir: w.taps, ownerUid: ME, sessionId: sid, offers: offersOf(w) });
    assert.equal(r.ok, false, what);
    assert.match(r.reason, re, what);
    assert.match(r.reason, /Nothing was asked\.$/, what);
  }
  assert.deepEqual(readdirSync(w.taps), []);
});

test('R-0b-164 planted: a taps folder the runner would refuse gets no tap', async () => {
  const w = await silentS1();
  const offers = offersOf(w);
  chmodSync(w.taps, 0o777);
  let r = writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers });
  assert.match(r.reason, /the taps folder can be written by others than the owner/);
  chmodSync(w.taps, 0o755);
  assert.match(writeTap({ dir: w.taps, ownerUid: OTHER, sessionId: 'S-1', offers }).reason, /the taps folder is not owned by the owner/);
  const link = join(w.base, 'taps-link');
  symlinkSync(w.taps, link);
  assert.match(writeTap({ dir: link, ownerUid: ME, sessionId: 'S-1', offers }).reason, /the taps folder is not a plain folder/);
  assert.match(writeTap({ dir: 'relative/taps', ownerUid: ME, sessionId: 'S-1', offers }).reason, /the taps folder is not set/);
  assert.deepEqual(readdirSync(w.taps), []);
});

test('R-0b-164 planted: a tap for a silent session of an older head starts nothing', async () => {
  const w = await silentS1();
  const offers = offersOf(w);
  // The card moves on: a new head with its own request.
  w.heads.set('C-1', HEAD2); w.cards.set('C-1', { state: 'in_review', head: HEAD2, tier: 2 });
  w.ask();
  let r = await runnerPass(w.ctx);
  assert.deepEqual(r.started.map((x) => x.session_id), ['S-2'], 'the new head gets its own review');
  // A tap on the old head's silent session sets it aside at most; it never starts a review of the old head.
  assert.equal(writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers }).ok, true);
  r = await runnerPass(w.ctx);
  assert.deepEqual(r.started, []);
  assert.equal(w.starts.filter((x) => x.head === HEAD).length, 1, 'the old head was reviewed once');
});

test('R-0b-164 planted: a tap where the session\'s outbox shows a fail starts nothing', async () => {
  const w = await silentS1();
  writeFileSync(join(w.outboxRoot, 'reviewer', 'S-1', 'late.md'), `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: false, notes: 'x' } })}\n`, { mode: 0o644 });
  assert.equal(writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w) }).ok, true);
  w.ask();
  const r = await runnerPass(w.ctx);
  assert.ok(r.refused.some((x) => /its outbox holds a failing verdict, and a fail is never set aside/.test(x.reason)), r.refused.map((x) => x.reason).join(' | '));
  assert.deepEqual(r.setAside, []);
  assert.deepEqual(r.started, []);
});

test('R-0b-164: the handler as a command, with the runner\'s real status file', async () => {
  const w = await silentS1();
  const cfg = join(w.base, 'review-again.json');
  writeFileSync(cfg, JSON.stringify({ ownerTaps: w.taps, ownerUid: ME, reviewStatus: join(w.root, 'status.json'), reviewUid: ME }));
  const said = [];
  const say = (s) => said.push(s);
  assert.equal(await main(['tap', cfg, 'S-404'], { say, now: () => T0 }), 1);
  assert.equal(await main(['tap', cfg, 'S-1'], { say, now: () => T0 }), 0);
  assert.match(said.at(-1), /Review again asked for S-1/);
  assert.deepEqual(readdirSync(w.taps), ['S-1.json']);
  // An old status refuses the tap: the runner may be stopped.
  assert.equal(await main(['tap', cfg, 'S-1'], { say, now: () => T0 + 3 * 3600_000 }), 1);
  assert.match(said.at(-1), /status can't be used: .*minutes old/);
  // Clear, today: M4's readReviewStatus does not pass `taps_read` on (lane 2, asked 9 Nov), so it removes nothing and says
  // why. Lane 2's change turns this into one removal; that PR updates these two lines.
  assert.equal(await main(['clear', cfg], { say, now: () => T0 }), 1);
  assert.match(said.at(-1), /taps not cleared: the status gives no list of taps read/);
  assert.equal(await main(['what', cfg], { say, now: () => T0 }), 1);
  assert.equal(await main(['tap', join(w.base, 'missing.json'), 'S-1'], { say, now: () => T0 }), 1);
});

// The wall itself is lane 2's (L77 m8): render-settings denies the Front Door Edit and Write on the taps folder, with its
// planted test in lane 2's suite. Asked for in lane3-to-lead.md, 9 Nov.
test.todo('R-0b-164 (lane 2): the Front Door session trying to write ownerTaps is refused by its rendered settings');
