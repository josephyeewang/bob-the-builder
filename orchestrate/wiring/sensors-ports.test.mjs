// sensors-ports.test.mjs — the `orchestrate` side (L609, L611, L614): the owner's answer is a claim, read strictly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { writeAnswer, ANSWER_FILE } from './owner-answer.mjs';
import { readOwnerAnswer, sensorsPorts, storedUsage, ANSWER_STALE_MS } from './sensors-ports.mjs';
import { sensorsPass } from '../modules/M12-sensors/loop.mjs';
import { memoryRecord, makeRecord } from '../shared/record.mjs';
import { writeUsageFact, writeSignedInAccount } from '../modules/M12-sensors/state-facts.mjs';
import { readFact, USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { ACCOUNT_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { shapeFact } from '../modules/M12-sensors/fact-shapes.mjs';
import { makeFactWriter, knownDoc } from '../modules/M12-sensors/facts.mjs';

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
const ports = (file, o = {}) => sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + (o.later ?? 0)), acl: o.acl ?? noAcl, stored: o.stored ?? (() => null), ...(o.staleMs ? { staleMs: o.staleMs } : {}) });
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
    // A root-owned file hard-linked into the owner's folder. This needs macOS: the file is a Mac system file,
    // and Linux refuses hard links to files the user does not own (fs.protected_hardlinks). The macOS CI job runs it.
    if (process.platform === 'darwin') {
      const other = '/Library/Preferences/com.apple.AppleFileServer.plist';
      const theirs = join(w.dir, 'theirs.json');
      linkSync(other, theirs);
      assert.match(readOwnerAnswer({ file: theirs, ownerUid: UID, acl: noAcl }).reason, /theirs\.json is not the owner's/, 'a root file in the owner\'s folder');
      rmSync(theirs);
    }
    const twin = join(w.dir, 'twin.json');
    linkSync(w.file, twin);
    assert.match(read().reason, /one name/);
    rmSync(twin);
    if (process.platform === 'darwin') assert.match(readOwnerAnswer({ file: '/private/etc/hosts', ownerUid: UID, acl: noAcl }).reason, /\/private\/etc is not the owner's/);
    else assert.match(readOwnerAnswer({ file: '/etc/hosts', ownerUid: UID, acl: noAcl }).reason, /\/etc is not the owner's/);
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
    put(H(2, '2026-11-05T16:59:00.000Z'), W(61)); assert.equal(await p.readUsage('a'), null, 'a later reset while the window seen is open');
    assert.match(p.lastReason(), /session row's reset time moved later while the window seen \(to 2026-11-05T15:00:00\.000Z\) is still open/);
    put(H(5, '2026-11-05T15:01:30.000Z'), W(5, '2026-11-07T23:01:30.000Z')); assert.equal(await p.readUsage('a'), null, 'moved 90 s later');
    assert.match(p.lastReason(), /reset time moved later/);
    put(H(5, '2026-11-05T14:00:00.000Z'), W(61));
    assert.equal(await p.readUsage('a'), null);
    assert.match(p.lastReason(), /reset time moved back/);
    assert.equal(await p.readUsage('a'), null, 'a refused reading leaves no mark: the same one is refused again');
    // L746 r3 self-review: M11 reads the week alone, so another row is held to the same week (this was "its own window").
    put(H(41), W(10), 'weekly_scoped:Y'); assert.equal(await p.readUsage('a'), null, 'a change of row does not start the week afresh');
    assert.match(p.lastReason(), /weekly_scoped:Y row went down within one window \(10% after 61%\)/);
    const fresh = ports(w.file);
    put(H(1), W(1)); assert.ok(await fresh.readUsage('a'), 'with no stored fact (stored gives null), a new process has only its own marks');
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
  // A refusal hands on the stored reading again, with its own time (L746 r3 self-review), never the refused one.
  const stale = (u) => (u ? [u.h5?.used_pct, u.week?.used_pct, u.observed_at] : u);
  const storedNow = () => { const d = rec.read('fact', USAGE_FACT('a'))?.doc; return [d?.h5?.used_pct, d?.week?.used_pct, d?.observed_at]; };
  try {
    put(H(90), W(95));
    await pass(run());
    assert.equal(rec.read('fact', USAGE_FACT('a'))?.doc?.h5?.used_pct, 90, 'run 1 stores 90%');
    put(H(5), W(5), T0 + 60_000);
    const run2 = run(60_000);
    assert.deepEqual(stale(await run2.readUsage('a')), storedNow(), 'run 2 (a new process) refuses 5% after the stored 90%');
    assert.match(run2.lastReason(), /session row went down within one window \(5% after 90%\)/);
    await pass(run(60_000), 60_000);
    assert.equal(rec.read('fact', USAGE_FACT('a'))?.doc?.h5?.used_pct, 90, 'the stored fact is not overwritten by the refused reading');
    put(H(5, '2026-11-05T15:01:30.000Z'), W(96), T0 + 120_000);
    const run3 = run(120_000);
    assert.deepEqual(stale(await run3.readUsage('a')), storedNow(), 'L746 m-A across runs: a reset moved 90 s later is refused too');
    assert.match(run3.lastReason(), /session row's reset time moved later/);
    const later = 3.5 * 3600e3;   // 15:30: the 5-hour window seen has passed
    put(H(5, '2026-11-05T20:00:00.000Z'), W(96), T0 + later);
    const run4 = run(later);
    const u = await run4.readUsage('a');
    assert.deepEqual([u?.h5?.used_pct, u?.week?.used_pct], [5, 96], 'once the old window has passed, a new one starts low');
    put(H(5, '2026-11-05T20:00:00.000Z'), W(50), T0 + later);
    assert.deepEqual(stale(await run(later).readUsage('a')), storedNow(), 'the weekly row is held to the stored week, from the same row');
    assert.equal(writeAnswer({ to: w.file, answer: answer({ observed_at: new Date(T0 + later).toISOString(), usage: { h5: H(5, '2026-11-05T20:00:00.000Z'), week: W(10), week_from: 'weekly_scoped:Y' } }) }).ok, true);
    assert.deepEqual(stale(await run(later).readUsage('a')), storedNow(), "another row's week is held to the stored week too (switching rows is no way round)");
    // A failed read is never "no mark" (L781): the real Record answers a store error as `corrupt`, and that throws here.
    assert.throws(() => storedUsage(makeRecord({ read: () => { throw new Error('SQLITE_BUSY'); } }))('a'), /the stored usage for a could not be read \(record error: SQLITE_BUSY\)/);
    assert.throws(() => storedUsage({ read: () => ({ id: 'usage-a', corrupt: true, reason: 'x' }) })('a'), /could not be read/);
    assert.equal(storedUsage(makeRecord(memoryRecord()))('a'), null, 'a Record that holds no usage fact is no mark');
  } finally { w.done(); }
});

// L746 r3 self-review: sensorsPorts can't be made without the stored usage fact; a reset time further out than one window
// is refused; and a passed reading carries the window's first reset time, so the stored fact can't creep early run by run.
test('L746 r3: stored is required; a reset beyond one window is refused; the stored reset time does not creep', async () => {
  assert.throws(() => sensorsPorts({ file: '/x', ownerUid: UID, acl: noAcl }), /needs stored/);
  assert.throws(() => sensorsPorts({ file: '/x', ownerUid: UID, acl: noAcl, stored: null }), /needs stored/);
  const w = place();
  const at = (n) => new Date(T0 + n).toISOString();
  const put = (h5, week, n = 0) => assert.equal(writeAnswer({ to: w.file, answer: answer({ observed_at: at(n), usage: { h5, week, week_from: 'weekly_all' } }) }).ok, true);
  try {
    put({ used_pct: 5, resets_at: '2099-01-01T00:00:00.000Z' }, { used_pct: 5, resets_at: '2026-11-07T22:59:59.000Z' });
    let p = ports(w.file); assert.equal(await p.readUsage('a'), null); assert.match(p.lastReason(), /h5 reset time is further out than one 5-hour window/);
    put({ used_pct: 5, resets_at: '2026-11-05T15:00:00.000Z' }, { used_pct: 5, resets_at: '2026-11-13T12:02:00.000Z' });
    p = ports(w.file); assert.equal(await p.readUsage('a'), null); assert.match(p.lastReason(), /week reset time is further out than one weekly window/);
    put({ used_pct: 5, resets_at: '2026-11-05T17:00:00.000Z' }, { used_pct: 5, resets_at: '2026-11-12T12:00:00.000Z' });
    assert.ok(await ports(w.file).readUsage('a'), 'a full window from the reading is fine');
    const rec = memoryRecord();
    const pass = (n) => sensorsPass({ rec, ports: (() => { const q = sensorsPorts({ file: w.file, ownerUid: UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) }); return { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {} }; })(), now: () => new Date(T0 + n) });
    const H = (s) => ({ used_pct: 10, resets_at: s }); const W = { used_pct: 10, resets_at: '2026-11-07T22:59:59.000Z' };
    put(H('2026-11-05T15:00:00.000Z'), W, 0); await pass(0);
    put(H('2026-11-05T14:59:01.000Z'), W, 60_000); await pass(60_000);
    put(H('2026-11-05T14:58:02.000Z'), W, 120_000); await pass(120_000);
    const kept = rec.read('fact', USAGE_FACT('a'))?.doc;
    assert.deepEqual([kept?.h5?.used_pct, kept?.observed_at], [10, at(60_000)], 'the refused third reading leaves the stored reading, with its own time (so M11 counts it stale on schedule)');
    put(H('2026-11-05T15:00:00.000Z'), { used_pct: 1, resets_at: W.resets_at }, 180_000); await pass(180_000);
    assert.equal(rec.read('fact', USAGE_FACT('a'))?.doc?.week?.used_pct, 10, 'so after a refusal a low reading is still refused: the marks were not wiped');
    assert.equal(rec.read('fact', USAGE_FACT('a'))?.doc?.h5?.resets_at, '2026-11-05T15:00:00.000Z', 'each run moved 59 s earlier; the stored window keeps its first reset time');
  } finally { w.done(); }
});

// L754 (lead's answer to lane 5's Q1): a usage reading held after a refusal is told once with its cause, then daily, once
// M3 is wired. No clear command. Pinned here as a todo until M3's loop tells it.
test('L754 todo: a usage reading held after a refusal is told once with its cause, then daily', { todo: 'waits on M3 being wired (L754)' }, async () => {
  const { ALERT_QUEUE_FACT } = await import('../modules/M11-dispatcher/alerts.mjs');
  const w = place();
  const rec = memoryRecord();
  const at = (n) => new Date(T0 + n).toISOString();
  const put = (pct, n) => assert.equal(writeAnswer({ to: w.file, answer: answer({ observed_at: at(n), usage: { h5: { used_pct: pct, resets_at: '2026-11-05T15:00:00.000Z' }, week: { used_pct: 60, resets_at: '2026-11-07T22:59:59.000Z' }, week_from: 'weekly_all' } }) }).ok, true);
  const pass = (n) => sensorsPass({ rec, ports: (() => { const q = sensorsPorts({ file: w.file, ownerUid: UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) }); return { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {} }; })(), now: () => new Date(T0 + n) });
  try {
    put(90, 0); await pass(0);
    put(5, 60_000); await pass(60_000);
    const told = (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => /usage/.test(e.text) && /went down within one window/.test(e.text));
    assert.equal(told.length, 1, 'the held reading is told once, with its cause');
  } finally { w.done(); }
});

// L757 (audit #283 r3 M-1, the auditor's probe283r3 P2/P4 as tests): a run that hands on no reading, an answer about
// another account, no row or no reset time no longer wipes the stored marks, so a forged low reading on the next run is
// still refused. Real sensorsPorts, real sensorsPass, memoryRecord; each run is a new sensorsPorts (a new process).
{
  const H = (p, r = '2026-11-05T15:00:00.000Z') => ({ used_pct: p, resets_at: r });
  const W = (p, r = '2026-11-07T22:59:59.000Z') => ({ used_pct: p, resets_at: r });
  const setup = () => {
    const dir = tempDir('orch-l757-'); chmodSync(dir, 0o755);
    const file = join(dir, ANSWER_FILE); const rec = memoryRecord();
    const put = (usage, n, extra = {}) => assert.equal(writeAnswer({ to: file, answer: { v: 1, account: 'a', signed_in: true, observed_at: new Date(T0 + n).toISOString(), usage, ...extra } }).ok, true);
    const pass = async (n, over = {}) => {
      const q = sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) });
      return sensorsPass({ rec, ports: { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {}, ...over }, now: () => new Date(T0 + n) });
    };
    const fact = () => rec.read('fact', USAGE_FACT('a'))?.doc;
    return { put, pass, fact, done: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const real = { h5: H(90), week: W(95), week_from: 'weekly_all' };
  const gaps = [
    ['no reading (usage null, with a reason)', (s, n) => s.put(null, n, { usage_reason: 'x' }), { h5: H(5), week: W(5), week_from: 'weekly_all' }],
    ['an answer about another account between the two reads', (s, n) => s.put(real, n, { account: 'b' }), { h5: H(5), week: W(5), week_from: 'weekly_all' }, { whoIsSignedIn: async () => 'a' }],
    ['no week row', (s, n) => s.put({ h5: H(90), week: null, week_from: null }, n), { h5: H(90), week: W(5), week_from: 'weekly_all' }],
    ['no week reset time', (s, n) => s.put({ h5: H(90), week: W(95, null), week_from: 'weekly_all' }, n), { h5: H(90), week: W(5), week_from: 'weekly_all' }],
    ['no 5-hour reset time', (s, n) => s.put({ h5: H(90, null), week: W(95), week_from: 'weekly_all' }, n), { h5: H(5), week: W(95), week_from: 'weekly_all' }],
    ['the usage read failing (the loop\'s own unknown)', (s, n) => s.put(real, n), { h5: H(5), week: W(5), week_from: 'weekly_all' }, { readUsage: async () => { throw new Error('boom'); } }],
  ];
  for (const [name, gap, forged, over] of gaps) {
    test(`L757 M-1: a run with ${name} hands the stored windows on, and a forged low reading after it is still refused`, async () => {
      const s = setup(); try {
        s.put(real, 0); await s.pass(0);
        const first = s.fact(); assert.deepEqual([first.h5.used_pct, first.week.used_pct], [90, 95]);
        gap(s, 60e3); await s.pass(60e3, over ?? {});
        const between = s.fact();
        assert.deepEqual([between.h5, between.week], [first.h5, first.week], `the marks are kept: ${JSON.stringify(between)}`);
        assert.equal(between.observed_at, first.observed_at, 'a handed-on window keeps its own (earlier) time, so it ages');
        s.put(forged, 120e3); await s.pass(120e3);
        const f = s.fact();
        assert.deepEqual([f.h5.used_pct, f.week.used_pct], [90, 95], `the forged 5% is not stored: ${JSON.stringify(f)}`);
      } finally { s.done(); }
    });
  }
  test('L757 M-1: once the stored window has passed, an unknown is written as unknown (nothing is held past its window)', async () => {
    const rec = memoryRecord();
    const t = (n) => () => new Date(T0 + n);
    const w = (n) => makeFactWriter(rec, { now: t(n) });
    assert.equal((await writeUsageFact(w(0), async () => ({ source: 's', ...real }), 'a', { now: t(0) })).ok, true);
    const none = { source: null, h5: { used_pct: null, resets_at: null }, week: { used_pct: null, resets_at: null } };
    assert.equal((await writeUsageFact(w(2 * 3600e3), async () => none, 'a', { now: t(2 * 3600e3) })).ok, true);   // 14:00: h5 open (15:00), week open
    let d = rec.read('fact', USAGE_FACT('a')).doc; assert.deepEqual([d.h5.used_pct, d.week.used_pct, d.source], [90, 95, 's']);
    assert.equal((await writeUsageFact(w(3 * 3600e3), async () => none, 'a', { now: t(3 * 3600e3) })).ok, true);   // 15:00: the 5-hour window has passed
    d = rec.read('fact', USAGE_FACT('a')).doc; assert.deepEqual([d.h5.used_pct, d.h5.resets_at, d.week.used_pct], [null, null, 95]);
    assert.equal(d.observed_at, new Date(T0).toISOString(), 'the week still handed on keeps the first time');
  });
  test('L757 M-1: a stored usage fact that cannot be read is never taken as none (nothing is written over it)', async () => {
    const rec = memoryRecord();
    const w = makeFactWriter(rec, { now: () => new Date(T0) });
    assert.equal((await writeUsageFact(w, async () => ({ source: 's', ...real }), 'a', { now: () => new Date(T0) })).ok, true);
    const before = rec.read('fact', USAGE_FACT('a'));
    // Through the real Record wrapper (L781): its read answers a store error as `corrupt`, never by throwing.
    const failing = makeRecord(new Proxy({}, { get: (_, k) => (k === 'read' ? () => { throw new Error('record read failed'); } : typeof rec[k] === 'function' ? rec[k].bind(rec) : rec[k]) }));
    const broken = makeFactWriter(failing, { now: () => new Date(T0 + 60e3) });
    const r = await writeUsageFact(broken, async () => ({ source: null, h5: null, week: null }), 'a', { now: () => new Date(T0 + 60e3) });
    assert.equal(r.ok, false); assert.match(r.reason, /could not be read, so nothing was written over it/);
    assert.deepEqual(rec.read('fact', USAGE_FACT('a')), before, 'the stored fact is untouched');
  });
  test('L757 M-1: stored marks that cannot be read let no reading through (the read fails; it is not checked against nothing)', async () => {
    const dir = tempDir('orch-l757m-'); chmodSync(dir, 0o755); const file = join(dir, ANSWER_FILE);
    try {
      assert.equal(writeAnswer({ to: file, answer: { v: 1, account: 'a', signed_in: true, observed_at: new Date(T0).toISOString(), usage: { h5: H(5), week: W(5), week_from: 'weekly_all' } } }).ok, true);
      const q = sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0), acl: noAcl, stored: () => { throw new Error('record read failed'); } });
      await assert.rejects(q.readUsage('a'), /the stored usage marks could not be read \(record read failed\)/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// L781 (audit #283 r4 M-1, probe283r4 R1x and R5): over the REAL Record wrapper (makeRecord), whose read answers a store error
// as { corrupt: true } and never throws, brief read failures of the usage fact never let a forged low reading through and
// never write unknown over the marks. The store fails the next N reads of the usage fact, then answers again.
function flakyWorld() {
  const dir = tempDir('orch-l781-'); chmodSync(dir, 0o755);
  const file = join(dir, ANSWER_FILE); const real = memoryRecord();
  let failNext = 0;
  const rec = makeRecord(new Proxy({}, { get(_, k) {
    if (k === 'read') return (e, id) => { if (e === 'fact' && id === USAGE_FACT('a') && failNext > 0) { failNext -= 1; throw new Error('SQLITE_BUSY'); } return real.read(e, id); };
    const v = real[k]; return typeof v === 'function' ? v.bind(real) : v;
  } }));
  const put = (usage, n, extra = {}) => assert.equal(writeAnswer({ to: file, answer: { v: 1, account: 'a', signed_in: true, observed_at: new Date(T0 + n).toISOString(), usage, ...extra } }).ok, true);
  const pass = (n) => { const q = sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + n), acl: noAcl, stored: storedUsage(rec) });
    return sensorsPass({ rec, ports: { whoIsSignedIn: q.whoIsSignedIn, readUsage: q.readUsage, probes: {} }, now: () => new Date(T0 + n), deadlineMs: 200 }); };
  const marks = () => { const d = real.read('fact', USAGE_FACT('a'))?.doc; return [d?.h5?.used_pct, d?.week?.used_pct]; };
  return { put, pass, marks, fail: (k) => { failNext = k; }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const R781_H = (p) => ({ used_pct: p, resets_at: '2026-11-05T15:00:00.000Z' });
const R781_W = (p) => ({ used_pct: p, resets_at: '2026-11-07T22:59:59.000Z' });
const R781_REAL = { h5: R781_H(90), week: R781_W(95), week_from: 'weekly_all' };
const R781_FORGED = { h5: R781_H(5), week: R781_W(5), week_from: 'weekly_all' };

for (const k of [1, 2, 3, 4, 5, 6]) {
  test(`L781 R1x: the first ${k} usage-fact read(s) of a run fail, and a forged 5/5 is not written over 90/95`, async () => {
    const w = flakyWorld();
    try {
      w.put(R781_REAL, 0); await w.pass(0); assert.deepEqual(w.marks(), [90, 95]);
      w.put(R781_FORGED, 60e3); w.fail(k); const out = await w.pass(60e3);
      assert.deepEqual(w.marks(), [90, 95], JSON.stringify(out.problems));
    } finally { w.done(); }
  });
}
for (const k of [1, 2]) {
  test(`L781 R5: a gap run with ${k} failing read(s) at the write keeps the marks, and the next run's forged 5/5 is refused`, async () => {
    const w = flakyWorld();
    try {
      w.put(R781_REAL, 0); await w.pass(0);
      w.put(null, 60e3, { usage_reason: 'x' }); w.fail(k); const gap = await w.pass(60e3);
      assert.deepEqual(w.marks(), [90, 95], `the gap run wrote nothing over the marks: ${JSON.stringify(gap.problems)}`);
      w.put(R781_FORGED, 120e3); await w.pass(120e3);
      assert.deepEqual(w.marks(), [90, 95]);
    } finally { w.done(); }
  });
}

test('L781: knownDoc and the fact writer\'s getKnown: none is null, a failed read throws; get is unchanged', () => {
  assert.equal(knownDoc(null), null);
  assert.deepEqual(knownDoc({ doc: { a: 1 } }), { a: 1 });
  assert.throws(() => knownDoc({ corrupt: true, reason: 'record error: x' }, 'it'), /^Error: it could not be read \(record error: x\)$/);
  assert.throws(() => knownDoc({ id: 'x' }), /could not be read \(no document\)/);
  const rec = makeRecord({ read: () => { throw new Error('SQLITE_BUSY'); }, write: () => ({ ok: true }) });
  const fw = makeFactWriter(rec);
  assert.throws(() => fw.getKnown('usage-a'), /the fact usage-a could not be read/);
  assert.equal(fw.get('usage-a'), null, 'get still reads a failed read as none (its other callers are reported, not changed)');
});
