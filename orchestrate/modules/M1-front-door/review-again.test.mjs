// review-again.test.mjs — R-0b-164: the owner's [Review again] tap, from the runner's offer to one new review.
// The handler writes the tap; the REAL review runner (runnerPass) reads it through the REAL readJoeTaps. Only the runner's
// outside effects (claude, git, the Record) are fakes, as in M4's own runner tests; the folders are throwaway ones this
// test's user owns, standing in for the owner (taps) and the review user (the runner's folders).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { installProblem, readConfig, readJoeTaps } from '../M4-workshop/launcher/review-runner-main.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { REVIEW_AGAIN, REVIEW_AGAIN_BUTTON, OFFER_NOTE, reviewAgainOffers, reviewAgainCard, writeTap, clearReadTaps, handlerSetup, main } from './review-again.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, script: OTHER, reviewer: ME, auditor: ME };
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

// The runner's own config, as its installer writes it, read by the runner's own reader. This test's folders can't be
// root's, so the reader's wall check gets M4's own test port (review-runner-main.test.mjs OPEN_WALLS).
const OPEN_WALLS = { lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 0, mode: 0o40755 }), acl: () => null };
const readRunner = (f) => readConfig(f, OPEN_WALLS);
// The runner's owner-and-place check (#284 r2 m1), the REAL installProblem, with root stood in for: the test's base folder
// and its installed copy (w.base/install) read as root's, everything else as the test user's, as on the Mac.
const installOf = (w) => join(w.base, 'install');
const placeIn = (w) => (c, f) => installProblem(c.installRoot, [f], {
  top: w.base, acl: () => null,
  lstat: (p) => {
    const s = lstatSync(p); const r = relative(installOf(w), p);
    const roots = p === w.base || r === '' || (!r.startsWith('..') && !r.startsWith('/'));
    return { isSymbolicLink: () => s.isSymbolicLink(), isDirectory: () => s.isDirectory(), uid: roots ? 0 : s.uid, mode: s.mode };
  },
});
const ports = (w) => ({ readRunner, place: placeIn(w) });
// `at` is where the runner config is written: by default inside the installed copy, where the installer puts it.
function runnerConfig(w, over = {}, at = installOf(w)) {
  mkdirSync(installOf(w), { recursive: true, mode: 0o755 }); chmodSync(installOf(w), 0o755);
  mkdirSync(at, { recursive: true, mode: 0o755 }); chmodSync(at, 0o755);
  const c = { installRoot: installOf(w), root: w.root, outboxRoot: w.outboxRoot, reviewHome: '/h', uids: UIDS, recordRoot: '/x', recordUid: OTHER, mirror: '/m',
    claudeBin: CLAUDE, hooksDir: '/i/hooks', ownerHome: '/w', ownerUid: ME, ownerTaps: w.taps, wiring: '/i/w.mjs',
    snapshot: join(w.root, 'rules-snapshot.json'), bobFolder: '/b', deny: ['/d'], reviewCopies: '/rc', workerCopies: '/wc', pin: '2.1.316', machineWide: '/ms.json',
    rules: { production: { env_files: [], programs: [], hosts: [] } }, ...over };
  for (const k of Object.keys(over)) if (over[k] === undefined) delete c[k];
  const file = join(at, 'runner-config.json');
  writeFileSync(file, JSON.stringify(c), { mode: 0o644 }); chmodSync(file, 0o644);
  const cfg = join(w.base, 'review-again.json');
  writeFileSync(cfg, JSON.stringify({ runnerConfig: file }));
  return cfg;
}

test('R-0b-164: a silent review shows [Review again] on the phone card, with the runner\'s own words', async () => {
  const w = await silentS1();
  const offers = offersOf(w);
  assert.deepEqual(offers.map((o) => o.session_id), ['S-1']);
  const card = reviewAgainCard(offers[0]);
  assert.deepEqual(card.buttons, [REVIEW_AGAIN_BUTTON]);
  assert.deepEqual(card.tap, { action: REVIEW_AGAIN, session_id: 'S-1' });
  assert.equal(card.note, OFFER_NOTE, 'the card says the button comes from the runner\'s recent alerts (#284 r1 m1)');
  assert.match(OFFER_NOTE, /recent alerts/);
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
  // #284 r1 m1: a session the status lists as running, or one already set aside, is not offered.
  const two = { alerts: [{ id: 'a', action: REVIEW_AGAIN, session_id: 'S-1', text: 'a' }, { id: 'b', action: REVIEW_AGAIN, session_id: 'S-2', text: 'b' }] };
  assert.deepEqual(reviewAgainOffers({ ...two, running: [{ session_id: 'S-1' }] }).map((o) => o.session_id), ['S-2']);
  assert.deepEqual(reviewAgainOffers(two, { asideIds: new Set(['S-2']) }).map((o) => o.session_id), ['S-1']);
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
  const SAME = 1_800_000_000;   // both taps get this file time (whole seconds), so only their bytes can differ
  utimesSync(join(w.taps, 'S-1.json'), SAME, SAME);
  const k1 = readJoeTaps({ dir: w.taps, ownerUid: ME })[0].key;
  // A tap the runner has not read is not even moved aside (the runner could miss it on a pass while it is).
  const moved = [];
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [], beforeMove: (t) => moved.push(t) }), { removed: [] });
  assert.deepEqual(moved, []);
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: undefined }), { removed: [], error: 'the status gives no list of taps read' });
  assert.ok(existsSync(join(w.taps, 'S-1.json')));
  // Written again with the same file time: new bytes, so a new key, and the old read key does not remove it.
  const r = writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w), now: () => T0, rand: () => 'second' });
  assert.equal(r.ok, true, r.reason);
  utimesSync(r.file, SAME, SAME);
  assert.equal(statSync(r.file).mtimeMs, SAME * 1000);
  const k2 = readJoeTaps({ dir: w.taps, ownerUid: ME })[0].key;
  assert.notEqual(k2, k1);
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [k1] }), { removed: [] });
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [k2] }), { removed: ['S-1'] });
  assert.deepEqual(readdirSync(w.taps), [], 'nothing is left behind, not even the private folder');
});

test('R-0b-164 planted (#284 r1 m2): clear never removes a tap written after the runner\'s read, even one that lands while it runs', async () => {
  const w = await silentS1();
  assert.equal(writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w), rand: () => 'first' }).ok, true);
  const k1 = readJoeTaps({ dir: w.taps, ownerUid: ME })[0].key;
  // The owner taps again between clear's list and its removal.
  const beforeMove = () => {
    const r = writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w), rand: () => 'second' });
    assert.equal(r.ok, true, r.reason);
  };
  assert.deepEqual(clearReadTaps({ dir: w.taps, ownerUid: ME, tapsRead: [k1], beforeMove }), { removed: [] });
  const left = readJoeTaps({ dir: w.taps, ownerUid: ME });
  assert.equal(left.length, 1, 'the new tap is still there');
  assert.notEqual(left[0].key, k1);
  assert.match(readFileSync(join(w.taps, 'S-1.json'), 'utf8'), /"nonce":"second"/);
  assert.deepEqual(readdirSync(w.taps), ['S-1.json']);
});

test('R-0b-164 planted: a tap for a session the runner does not offer writes nothing', async () => {
  const w = await silentS1();
  const cases = [
    ['a session not offered', 'S-404', /the review runner's recent alerts do not offer it for that session/],
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

test('R-0b-164 planted (#284 r1 m5): a tap for a session that is really running writes nothing', async () => {
  const w = world();
  await runnerPass(w.ctx);
  w.ask();
  await runnerPass(w.ctx);
  assert.deepEqual(w.status().running.map((r) => r.session_id), ['S-1'], 'S-1 is running');
  const r = writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: offersOf(w) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /do not offer it for that session/);
  // Even an offer from an older alert for it is dropped while the status lists it running.
  const st = { ...w.status(), alerts: [{ id: 'old', action: REVIEW_AGAIN, session_id: 'S-1', text: 'old' }] };
  assert.equal(writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers: reviewAgainOffers(st) }).ok, false);
  assert.deepEqual(readdirSync(w.taps), []);
});

test('R-0b-164 planted (#284 r1 m1): once the runner has set a session aside, it is no longer offered', async () => {
  const w = await silentS1();
  const cfg = runnerConfig(w);
  const said = [];
  assert.equal(await main(['tap', cfg, 'S-1'], { say: (s) => said.push(s), now: () => w.clock.t, ...ports(w) }), 0, said.at(-1));
  w.ask();
  const r = await runnerPass(w.ctx);
  assert.deepEqual(r.setAside.map((x) => x.session_id), ['S-1']);
  // The alert is still in the runner's recent alerts, but its set-aside record now stands.
  assert.ok(w.status().alerts.some((a) => a.action === REVIEW_AGAIN && a.session_id === 'S-1'));
  assert.equal(await main(['tap', cfg, 'S-1'], { say: (s) => said.push(s), now: () => w.clock.t, ...ports(w) }), 1);
  assert.match(said.at(-1), /do not offer it for that session .*Nothing was asked\.$/);
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
  // A tap on the old head's silent session sets it aside (harmless: that head is superseded) and never starts a review of
  // the old head, even when a request for the old head follows (#284 r1 m3: this part fails if the tap is not read).
  assert.equal(writeTap({ dir: w.taps, ownerUid: ME, sessionId: 'S-1', offers }).ok, true);
  writeFileSync(join(w.root, 'requests', 'q-old.json'), JSON.stringify({ card: 'C-1', head: HEAD, role: 'reviewer', request_id: 'q-old' }), { mode: 0o644 });
  r = await runnerPass(w.ctx);
  assert.deepEqual(r.setAside, [{ session_id: 'S-1', card: 'C-1', role: 'reviewer' }], 'the tap was read');
  assert.deepEqual(r.started, []);
  assert.ok(r.refused.some((x) => /request names head aaaaaaa, but the card's head is bbbbbbb/.test(x.reason)), r.refused.map((x) => x.reason).join(' | '));
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

test('R-0b-164: the handler as a command, with the runner\'s real config and status file', async () => {
  const w = await silentS1();
  const cfg = runnerConfig(w);
  const said = [];
  const say = (s) => said.push(s);
  const run = (argv, t = T0) => main(argv, { say, now: () => t, ...ports(w) });
  assert.equal(await run(['tap', cfg, 'S-404']), 1);
  assert.equal(await run(['tap', cfg, 'S-1']), 0);
  assert.match(said.at(-1), /Review again asked for S-1/);
  assert.deepEqual(readdirSync(w.taps), ['S-1.json']);
  // An old status refuses the tap: the runner may be stopped.
  assert.equal(await run(['tap', cfg, 'S-1'], T0 + 3 * 3600_000), 1);
  assert.match(said.at(-1), /status can't be used: .*minutes old/);
  // Clear: M4's readReviewStatus passes `taps_read` on (lane 2, #306), so once the runner has read the tap, clear removes it.
  assert.equal(await run(['clear', cfg]), 0);
  assert.match(said.at(-1), /0 tap\(s\) the runner has read removed/, 'not read yet: kept');
  await runnerPass(w.ctx);
  assert.equal(await run(['clear', cfg]), 0);
  assert.match(said.at(-1), /1 tap\(s\) the runner has read removed/);
  assert.deepEqual(readdirSync(w.taps), []);
  assert.equal(await run(['what', cfg]), 1);
  assert.equal(await run(['tap', join(w.base, 'missing.json'), 'S-1']), 1);
});

test('R-0b-164 planted (#284 r1 M2): the taps folder is the runner\'s own; with none set, or a second copy named, nothing is asked', async () => {
  const w = await silentS1();
  const said = [];
  const run = (cfg) => main(['tap', cfg, 'S-1'], { say: (s) => said.push(s), now: () => T0, ...ports(w) });
  // The runner has no taps folder: it would never read a tap, so the handler refuses and says so.
  assert.equal(await run(runnerConfig(w, { ownerTaps: undefined })), 1);
  assert.match(said.at(-1), /the review runner has no taps folder set \(ownerTaps in its config\).*Nothing was asked\.$/);
  // A handler config naming its own taps folder (a second home that could differ) is refused.
  const cfg = runnerConfig(w);
  const own = JSON.parse(readFileSync(cfg, 'utf8'));
  writeFileSync(cfg, JSON.stringify({ ...own, ownerTaps: w.taps }));
  assert.equal(await run(cfg), 1);
  assert.match(said.at(-1), /only "runnerConfig" belongs here; the taps folder .* come from the review runner's own config \(ownerTaps\)/);
  // A runner config its own reader refuses is refused here too.
  const bad = runnerConfig(w, { mirror: 'relative' });
  assert.equal(await run(bad), 1);
  assert.match(said.at(-1), /the review runner's config can't be used: config: mirror must be an absolute path/);
  assert.deepEqual(readdirSync(w.taps), [], 'no tap was written');
  // With the runner's folder, the tap lands where the runner reads it, and the runner sets the session aside.
  const good = runnerConfig(w);
  assert.equal(handlerSetup(good, ports(w)).taps, w.taps);
  assert.equal(await run(good), 0);
  w.ask();
  assert.deepEqual((await runnerPass(w.ctx)).setAside.map((x) => x.session_id), ['S-1']);
});

test('R-0b-164 planted (#284 r2 m1): an owner-written copy of the runner config naming another taps folder is refused and told', async () => {
  const w = await silentS1();
  const twin = join(w.base, 'twin-taps'); mkdirSync(twin, { mode: 0o755 }); chmodSync(twin, 0o755);
  const said = [];
  const run = (cfg) => main(['tap', cfg, 'S-1'], { say: (s) => said.push(s), now: () => T0, ...ports(w) });
  // A valid-shaped copy in the owner's own folder, naming the real installed copy: not inside it, so not the runner's.
  const copy = runnerConfig(w, { ownerTaps: twin }, join(w.base, 'owner-copy'));
  assert.equal(await run(copy), 1);
  assert.match(said.at(-1), /the review runner's config is not the runner's own \(it must be root's alone, inside the installed copy\): .*owner-copy\/runner-config\.json is not inside the installed copy .*Nothing was asked\.$/);
  // The same copy naming its own folder as the installed copy: that folder is the owner's, not root's.
  const self = runnerConfig(w, { ownerTaps: twin, installRoot: join(w.base, 'owner-copy') }, join(w.base, 'owner-copy'));
  assert.equal(await run(self), 1);
  assert.match(said.at(-1), /is not the runner's own .*not owned by root.*Nothing was asked\.$/);
  assert.deepEqual(readdirSync(twin), [], 'no tap in the twin folder');
  assert.deepEqual(readdirSync(w.taps), [], 'and none in the runner\'s');
  w.ask();
  assert.deepEqual((await runnerPass(w.ctx)).setAside, [], 'nothing was asked, so nothing is set aside');
  // Without the test's port the check is the runner's own, against real root: this test's installed copy is not root's.
  assert.throws(() => handlerSetup(runnerConfig(w), { readRunner }), /is not the runner's own \(it must be root's alone, inside the installed copy\)/);
});

// The wall itself is lane 2's (L77 m8): render-settings denies the Front Door Edit and Write on the taps folder, with its
// planted test in lane 2's suite. Asked for in lane3-to-lead.md, 9 Nov.
test.todo('R-0b-164 (lane 2): the Front Door session trying to write ownerTaps is refused by its rendered settings');
