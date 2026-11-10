// sensors-ports.test.mjs — the `orchestrate` side (L609, L611, L614): the owner's answer is a claim, read strictly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { writeAnswer, ANSWER_FILE } from './owner-answer.mjs';
import { readOwnerAnswer, sensorsPorts, storedUsage, ANSWER_STALE_MS } from './sensors-ports.mjs';
import { sensorsPass } from '../modules/M12-sensors/loop.mjs';
import { memoryRecord } from '../shared/record.mjs';
import { writeUsageFact, writeSignedInAccount } from '../modules/M12-sensors/state-facts.mjs';
import { readFact, USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { ACCOUNT_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { shapeFact } from '../modules/M12-sensors/fact-shapes.mjs';

const T0 = Date.parse('2026-11-05T12:00:00Z');
const UID = process.getuid();
const answer = (extra = {}) => ({ v: 1, account: 'a', signed_in: true, observed_at: new Date(T0).toISOString(),
  usage: { h5: { used_pct: 40, resets_at: '2026-11-05T15:00:00.000Z' }, week: { used_pct: 60, resets_at: '2026-11-07T22:59:59.000Z' }, week_from: 'weekly_all' }, ...extra });
const noAcl = () => null;

function place(doc = answer(), { raw } = {}) {
  const dir = tempDir('orch-sensors-ports-');
  chmodSync(dir, 0o755);
  const file = join(dir, ANSWER_FILE);
  if (raw !== undefined) { writeFileSync(file, raw); chmodSync(file, 0o644); } else assert.equal(writeAnswer({ to: file, answer: doc }).ok, true);
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const ports = (file, o = {}) => sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + (o.later ?? 0)), acl: o.acl ?? noAcl, ...(o.staleMs ? { staleMs: o.staleMs } : {}) });
const SIGNED_IN = { account: 'a', signed_in: true, observed_at: new Date(T0).toISOString() };
// A writer that keeps what it is given, so a test can read the fact back as M11 would.
const keeper = () => { const kept = {}; return { kept, put: (id, doc) => { kept[id] = doc; return { ok: true }; } }; };

test('a fresh answer gives the account and both windows', async () => {
  const w = place();
  try {
    const p = ports(w.file);
    assert.deepEqual(await p.whoIsSignedIn(), SIGNED_IN);
    assert.deepEqual(await p.readUsage('a'), { source: 'claude /usage | week from weekly_all', h5: answer().usage.h5, week: answer().usage.week,
      week_from: 'weekly_all', observed_at: answer().observed_at });
    assert.equal(p.lastReason(), null);
  } finally { w.done(); }
});

test('L611: no 5-hour row → null figures, never 0%, and the reason says it stays unknown', async () => {
  const w = place(answer({ usage: { h5: null, week: { used_pct: 99, resets_at: null }, week_from: 'weekly_all' } }));
  try {
    const p = ports(w.file);
    const u = await p.readUsage('a');
    assert.equal(u.h5, null);
    assert.equal(u.week.used_pct, 99);
    assert.match(p.lastReason(), /no 5-hour row, no weekly reset time/);
  } finally { w.done(); }
});

test('signed out, not known, another account, or a report the owner side refused: not an account, with the reason', async () => {
  for (const [doc, who, usage] of [
    [answer({ signed_in: false, usage: null, usage_reason: 'not signed in' }), /not signed in/, /not about a signed-in/],
    [answer({ signed_in: null, usage: null, usage_reason: 'who is signed in could not be read' }), /not known \(who is signed in could not be read\)/, /not about a signed-in/],
    [answer({ usage: null, usage_reason: 'the /usage answer has no usage_report' }), null, /no usage_report/],
  ]) {
    const w = place(doc);
    try {
      const p = ports(w.file);
      const a = await p.whoIsSignedIn();
      if (who) {
        assert.deepEqual([a.account, a.signed_in, a.observed_at], [null, doc.signed_in, doc.observed_at]);
        assert.match(a.reason, who); assert.match(p.lastReason(), who);
      } else assert.deepEqual(a, SIGNED_IN);
      assert.equal(await p.readUsage('a'), null);
      assert.match(p.lastReason(), usage);
    } finally { w.done(); }
  }
  const w = place();
  try {
    const p = ports(w.file);
    assert.equal(await p.readUsage('b'), null, 'figures for a are never handed out as b\'s');
  } finally { w.done(); }
});

test('L614: an old answer and one dated ahead are refused; a small clock drift is not', async () => {
  const w = place();
  try {
    const at = (ms) => { const p = ports(w.file, { later: ms }); return p.whoIsSignedIn().then((a) => [a.account, p.lastReason()]); };
    assert.equal(ANSWER_STALE_MS, 10 * 60_000, 'two of the owner\'s 5-minute rounds');
    assert.deepEqual(await at(ANSWER_STALE_MS), ['a', null]);
    const [old, why] = await at(ANSWER_STALE_MS + 60_000);
    assert.equal(old, null); assert.match(why, /11 min old \(the owner's job may be failing to write; see its log\)/);
    assert.deepEqual(await at(-60_000), ['a', null], 'one minute of drift');
    const [ahead, why2] = await at(-3 * 60_000);
    assert.equal(ahead, null); assert.match(why2, /future/);
  } finally { w.done(); }
});

test('L614: a file or folder not the owner\'s, writable by others, a link, too big or with an access list is refused', () => {
  const w = place();
  const read = (o = {}) => readOwnerAnswer({ file: w.file, ownerUid: UID, now: () => new Date(T0), acl: noAcl, ...o });
  try {
    assert.equal(read().ok, true);
    assert.match(read({ ownerUid: UID + 1 }).reason, /not the owner's/);
    chmodSync(w.file, 0o666); assert.match(read().reason, /can be written by others/); chmodSync(w.file, 0o644);
    chmodSync(w.dir, 0o777); assert.match(read().reason, /can be written by others/); chmodSync(w.dir, 0o755);
    assert.match(read({ acl: (paths) => `${paths[1]} has an access list (ACL)` }).reason, /access list/);
    assert.equal(read({ acl: undefined }).ok, true, 'the real access-list check passes a clean file');
    const other = '/Library/Preferences/com.apple.AppleFileServer.plist';
    const theirs = join(w.dir, 'theirs.json');
    linkSync(other, theirs);
    assert.match(readOwnerAnswer({ file: theirs, ownerUid: UID, acl: noAcl }).reason, /theirs\.json is not the owner's/, 'a root file in the owner\'s folder');
    rmSync(theirs);
    const twin = join(w.dir, 'twin.json');
    linkSync(w.file, twin);
    assert.match(read().reason, /one name/);
    rmSync(twin);
    assert.match(readOwnerAnswer({ file: '/private/etc/hosts', ownerUid: UID, acl: noAcl }).reason, /\/private\/etc is not the owner's/);
    const link = join(w.dir, 'link.json');
    symlinkSync(w.file, link);
    assert.match(readOwnerAnswer({ file: link, ownerUid: UID, acl: noAcl }).reason, /is a link/);
    writeFileSync(w.file, ' '.repeat(5000));
    assert.match(read().reason, /too big/);
    assert.match(readOwnerAnswer({ file: join(w.dir, 'gone', ANSWER_FILE), ownerUid: UID }).reason, /missing/);
    rmSync(w.file);
    assert.match(read().reason, /owner's job running/);
    assert.match(readOwnerAnswer({ file: 'relative', ownerUid: UID }).reason, /no answer file/);
    assert.match(readOwnerAnswer({ file: w.file, ownerUid: 0 }).reason, /no owner uid/);
  } finally { w.done(); }
});

test('a shape this reader does not know is refused, and says what', () => {
  const cases = [
    [{ raw: 'not json' }, /not JSON/],
    [{ raw: '[]' }, /not an object/],
    [{ doc: answer({ v: 2 }) }, /version 2/],
    [{ doc: answer({ token: 'x' }) }, /does not know: token/],
    [{ doc: answer({ account: 'c' }) }, /neither a nor b/],
    [{ doc: answer({ signed_in: 'yes' }) }, /signed_in/],
    [{ doc: answer({ observed_at: 'now' }) }, /observed_at/],
    [{ doc: answer({ usage: { h5: { used_pct: -1, resets_at: null } } }) }, /h5 percent/],
    [{ doc: answer({ usage: { week: { used_pct: 5, resets_at: 'soon' } } }) }, /week reset time/],
    [{ doc: answer({ usage: { month: null } }) }, /window this reader does not know/],
    [{ doc: answer({ usage: [] }) }, /usage is not an object/],
    [{ doc: answer({ usage_reason: 5 }) }, /usage_reason/],
    [{ doc: answer({ account: null }) }, /says signed in but names no account/],
    [{ doc: answer({ usage: { ...answer().usage, week_from: 'weekly_bogus' } }) }, /week_from is not a row/],
    [{ doc: answer({ usage: { ...answer().usage, week_from: 'weekly_scoped:has space' } }) }, /week_from is not a row/],
    [{ doc: answer({ usage: { ...answer().usage, week_from: null } }) }, /week has no week_from/],
  ];
  for (const [c, why] of cases) {
    const w = place(c.doc, { raw: c.raw });
    try {
      const r = readOwnerAnswer({ file: w.file, ownerUid: UID, now: () => new Date(T0), acl: noAcl });
      assert.equal(r.ok, false, String(why));
      assert.match(r.reason, why);
    } finally { w.done(); }
  }
});

test('L728 M1: the stored readings carry the answer\'s own time, so M11 refuses an answer 14 min old when read once 2 more minutes pass', async () => {
  const STALE = 15 * 60_000;   // the rules' usage.stale_after_min in the fixtures
  for (const [age, readStale] of [[14 * 60_000, STALE], [9 * 60_000, ANSWER_STALE_MS]]) {
    const w = place(answer({ observed_at: new Date(T0 - age).toISOString() }));
    try {
      const p = ports(w.file, { staleMs: readStale });
      const wr = keeper();
      assert.equal((await writeUsageFact(wr, p.readUsage, 'a', { now: () => new Date(T0) })).ok, true);
      assert.equal((await writeSignedInAccount(wr, p.whoIsSignedIn, { now: () => new Date(T0) })).ok, true);
      const usage = wr.kept[USAGE_FACT('a')]; const acct = wr.kept[ACCOUNT_FACT];
      assert.equal(usage.observed_at, new Date(T0 - age).toISOString(), 'the usage fact is dated by the answer, not the read');
      assert.equal(acct.observed_at, new Date(T0 - age).toISOString(), 'so is the account fact');
      assert.equal(readFact({ doc: usage }, { account: 'a', now: T0, staleMs: STALE }).ok, true, 'still inside the limit when read');
      const later = T0 + STALE - age + 60_000;
      const r = readFact({ doc: usage }, { account: 'a', now: later, staleMs: STALE });
      assert.equal(r.ok, false); assert.match(r.reason, /stale/);
    } finally { w.done(); }
  }
  // A port time later than the read's start never makes a reading younger; one that is not a time is refused.
  const wr = keeper();
  const ahead = async () => ({ h5: answer().usage.h5, week: answer().usage.week, source: 'x', observed_at: new Date(T0 + 60_000).toISOString() });
  await writeUsageFact(wr, ahead, 'a', { now: () => new Date(T0) });
  assert.equal(wr.kept[USAGE_FACT('a')].observed_at, new Date(T0).toISOString());
  assert.match((await writeUsageFact(wr, async () => ({ ...await ahead(), observed_at: 'soon' }), 'a', { now: () => new Date(T0) })).reason, /not a time/);
  assert.match((await writeSignedInAccount(wr, async () => ({ account: 'a', observed_at: 'soon' }), { now: () => new Date(T0) })).reason, /not a time/);
});

test('L730 (#289 M1): the account fact tells nobody signed in apart from could not tell, with the cause; never an empty account', async () => {
  const write = async (port) => { const wr = keeper(); await writeSignedInAccount(wr, port, { now: () => new Date(T0) }); const d = wr.kept[ACCOUNT_FACT]; return [d.account, d.signed_in, d.reason]; };
  assert.deepEqual(await write(async () => 'a'), ['a', true, null]);
  assert.deepEqual(await write(async () => null), [null, null, 'the account read gave no answer']);
  assert.deepEqual(await write(async () => 'someone@example.com'), [null, null, 'the account read named no account of M4\'s']);
  assert.deepEqual(await write(async () => ({ account: null, signed_in: false })), [null, false, 'nobody is signed in']);
  assert.deepEqual(await write(async () => ({ account: 'a', signed_in: null, reason: 'odd' })), [null, null, 'odd']);
  const cases = [[answer({ signed_in: false, usage: null }), false, /a is not signed in/], [answer({ signed_in: null, usage: null }), null, /not known/]];
  for (const [doc, signed, why] of cases) {
    const w = place(doc);
    try { const [acct, s, reason] = await write(ports(w.file).whoIsSignedIn); assert.deepEqual([acct, s], [null, signed]); assert.match(reason, why); } finally { w.done(); }
  }
  const gone = place(); gone.done();
  const [acct, s, reason] = await write(ports(gone.file).whoIsSignedIn);
  assert.deepEqual([acct, s], [null, null], 'a missing answer is could not tell, not nobody');
  assert.match(reason, /missing/);
  // The Record keeps both new fields as written (the allow-list in fact-shapes.mjs), never masked.
  const doc = { kind: 'fact.signed-in-account', account: null, signed_in: false, reason: 'account a is not signed in', observed_at: new Date(T0).toISOString() };
  assert.deepEqual(shapeFact(doc), doc);
});

test('L728 M3: every refusal leaves a reason in lastReason()', async () => {
  const refusals = [
    ['no file', null, 'a'],
    ['stale', answer({ observed_at: new Date(T0 - ANSWER_STALE_MS - 60_000).toISOString() }), 'a'],
    ['bad shape', answer({ v: 9 }), 'a'],
    ['signed out', answer({ signed_in: false, usage: null }), 'a'],
    ['not known', answer({ signed_in: null, usage: null }), 'a'],
    ['other account', answer(), 'b'],
    ['owner refused usage', answer({ usage: null, usage_reason: 'no rate_limits' }), 'a'],
  ];
  for (const [name, doc, acct] of refusals) {
    const w = place(doc ?? answer());
    if (!doc) rmSync(w.file);
    try {
      const p = ports(w.file);
      const who = await p.whoIsSignedIn();
      if (who.signed_in !== true) { assert.equal(typeof p.lastReason(), 'string', `${name}: account`); assert.ok(p.lastReason().length > 5); assert.equal(who.reason, p.lastReason()); }
      const u = await p.readUsage(acct);
      if (u === null) { assert.equal(typeof p.lastReason(), 'string', `${name}: usage`); assert.ok(p.lastReason().length > 5, name); } else assert.fail(`${name}: usage was handed on`);
    } finally { w.done(); }
  }
  // A good read clears the reason, so an old one is never shown again.
  const w = place();
  try { const p = ports(w.file); await p.readUsage('b'); assert.ok(p.lastReason()); await p.readUsage('a'); assert.equal(p.lastReason(), null); } finally { w.done(); }
});

test('L728 m1: within one window a lower percent than one already seen is refused and said; a new window starts afresh', async () => {
  const w = place();
  const put = (h5, week, from = 'weekly_all') => assert.equal(writeAnswer({ to: w.file, answer: answer({ usage: { h5, week, week_from: from } }) }).ok, true);
  const H = (pct, r = '2026-11-05T15:00:00.000Z') => ({ used_pct: pct, resets_at: r });
  const W = (pct, r = '2026-11-07T22:59:59.000Z') => ({ used_pct: pct, resets_at: r });
  try {
    const p = ports(w.file);
    assert.ok(await p.readUsage('a'));                                  // 40 / 60 seen
    put(H(40), W(50));
    assert.equal(await p.readUsage('a'), null);
    assert.match(p.lastReason(), /weekly_all row went down within one window \(50% after 60%\)/);
    put(H(30, '2026-11-05T15:00:00.500Z'), W(60));                    // the server's times carry ms: still one window
    assert.equal(await p.readUsage('a'), null);
    assert.match(p.lastReason(), /session row went down/);
    put(H(41), W(61)); assert.ok(await p.readUsage('a'), 'higher is fine');
    put(H(41), W(61)); assert.ok(await p.readUsage('a'), 'the same is fine');
    // L746 m-A (probe R2-283-B): a new window starts only once the old one has passed. This was "a new 5-hour window
    // starts low" at 12:00 with the 15:00 window still open, which let a reset moved 90 s later through.
    put(H(2, '2026-11-05T20:00:00.000Z'), W(61)); assert.equal(await p.readUsage('a'), null, 'a later reset while the window seen is open');
    assert.match(p.lastReason(), /session row's reset time moved later while the window seen \(to 2026-11-05T15:00:00\.000Z\) is still open/);
    put(H(5, '2026-11-05T15:01:30.000Z'), W(5, '2026-11-07T23:01:30.000Z')); assert.equal(await p.readUsage('a'), null, 'moved 90 s later');
    assert.match(p.lastReason(), /reset time moved later/);
    put(H(5, '2026-11-05T14:00:00.000Z'), W(61));
    assert.equal(await p.readUsage('a'), null);
    assert.match(p.lastReason(), /reset time moved back/);
    assert.equal(await p.readUsage('a'), null, 'a refused reading leaves no mark: the same one is refused again');
    put(H(41), W(10), 'weekly_scoped:Y'); assert.ok(await p.readUsage('a'), 'another row is its own window');
    const fresh = ports(w.file);
    put(H(1), W(1)); assert.ok(await fresh.readUsage('a'), 'with no stored fact (no `stored`), a new process has only its own marks');
  } finally { w.done(); }
});

test('L728 m4: a reading with no weekly row or no reset time is handed on, and the reason says so', async () => {
  const w = place(answer({ usage: { h5: { used_pct: 4, resets_at: null }, week: null, week_from: null } }));
  try {
    const p = ports(w.file);
    const u = await p.readUsage('a');
    assert.deepEqual([u.h5.used_pct, u.week, u.source], [4, null, 'claude /usage']);
    assert.match(p.lastReason(), /no 5-hour reset time, no weekly row, so it stays unknown/);
  } finally { w.done(); }
});

// L746 M-A (probe R2-283-A): each Sensors run is a new process, so the marks are the stored usage fact: run 2 refuses a
// forged low reading that run 1's stored fact rules out; once the window seen has passed, a new one starts low.
test('L746 M-A: a lower percent in the same window, read by the NEXT run, is refused through the stored usage fact', async () => {
  const w = place();
  const put = (h5, week, at = T0) => assert.equal(writeAnswer({ to: w.file, answer: answer({ observed_at: new Date(at).toISOString(), usage: { h5, week, week_from: 'weekly_all' } }) }).ok, true);
  const H = (pct, r = '2026-11-05T15:00:00.000Z') => ({ used_pct: pct, resets_at: r });
  const W = (pct, r = '2026-11-07T22:59:59.000Z') => ({ used_pct: pct, resets_at: r });
  const rec = memoryRecord();
  const run = (later = 0) => sensorsPorts({ file: w.file, ownerUid: UID, now: () => new Date(T0 + later), acl: noAcl, stored: storedUsage(rec) });
  const pass = (p, later = 0) => sensorsPass({ rec, ports: { whoIsSignedIn: p.whoIsSignedIn, readUsage: p.readUsage, probes: {} }, now: () => new Date(T0 + later) });
  try {
    put(H(90), W(95));
    await pass(run());
    assert.equal(rec.read('fact', USAGE_FACT('a'))?.doc?.h5?.used_pct, 90, 'run 1 stores 90%');
    put(H(5), W(5), T0 + 60_000);
    const run2 = run(60_000);
    assert.equal(await run2.readUsage('a'), null, 'run 2 (a new process) refuses 5% after the stored 90%');
    assert.match(run2.lastReason(), /session row went down within one window \(5% after 90%\)/);
    await pass(run(60_000));
    assert.equal(rec.read('fact', USAGE_FACT('a'))?.doc?.h5?.used_pct, 90, 'the stored fact is not overwritten by the refused reading');
    put(H(5, '2026-11-05T15:01:30.000Z'), W(96), T0 + 120_000);
    const run3 = run(120_000);
    assert.equal(await run3.readUsage('a'), null, 'L746 m-A across runs: a reset moved 90 s later is refused too');
    assert.match(run3.lastReason(), /session row's reset time moved later/);
    const later = 3.5 * 3600e3;   // 15:30: the 5-hour window seen has passed
    put(H(5, '2026-11-05T20:00:00.000Z'), W(96), T0 + later);
    const run4 = run(later);
    const u = await run4.readUsage('a');
    assert.deepEqual([u?.h5?.used_pct, u?.week?.used_pct], [5, 96], 'once the old window has passed, a new one starts low');
    put(H(5, '2026-11-05T20:00:00.000Z'), W(50), T0 + later);
    assert.equal(await run(later).readUsage('a'), null, 'the weekly row is held to the stored week, from the same row');
    assert.equal(writeAnswer({ to: w.file, answer: answer({ observed_at: new Date(T0 + later).toISOString(), usage: { h5: H(5, '2026-11-05T20:00:00.000Z'), week: W(10), week_from: 'weekly_scoped:Y' } }) }).ok, true);
    assert.equal((await run(later).readUsage('a'))?.week?.used_pct, 10, "another row's week is its own window: the stored weekly_all week does not hold it");
    assert.equal(storedUsage({ read: () => { throw new Error('x'); } })('a'), null, 'a Record that throws is no mark, never a throw');
  } finally { w.done(); }
});
