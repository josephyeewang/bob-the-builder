// store-stopped.test.mjs — L587: the stop that ended the robot's start is told once per reason, and a failure is only logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeIssues } from './alerts.mjs';
import { stopMarker, storeWords, tellStoreStopped } from './store-stopped.mjs';

const stop = { type: 'store_layout', reason: "the store's diary.jsonl is a link, not a plain file", key: "the store's diary.jsonl is a link, not a plain file" };
const run = (channel, extra = {}) => {
  const logs = [];
  return tellStoreStopped({ stop, product: 'product-1', channel, log: (s) => logs.push(s), ...extra }).then((r) => ({ r, logs }));
};

test('L587: the first start opens one issue, assigned, naming the fault; later starts open none', async () => {
  const gh = fakeIssues();
  assert.equal((await run({ gh, owner: 'owner-login' })).r, 'opened');
  for (let i = 0; i < 5; i++) assert.equal((await run({ gh, owner: 'owner-login' })).r, 'already open');
  assert.equal(gh.issues.size, 1);
  const x = gh.issues.get(1);
  assert.equal(x.assignee, 'owner-login');
  assert.match(x.title, /product-1's Record has stopped: store_layout/);
  assert.match(x.body, /diary\.jsonl is a link/);
  assert.equal(x.body.trim().split('\n').at(-1), stopMarker('product-1', stop.type, stop.key));
});

test('L587: a second reason is a second issue, and one the owner closed with the fault still there is opened again', async () => {
  const gh = fakeIssues();
  await run({ gh, owner: 'owner-login' });
  await tellStoreStopped({ stop: { ...stop, reason: 'another fault', key: 'another fault' }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.equal(gh.issues.size, 2);
  gh.ownerCloses(1);
  assert.equal((await run({ gh, owner: 'owner-login' })).r, 'opened');
  assert.equal(gh.issues.size, 3);
});

test('L587: a look that fails opens nothing, once, and says so in the log', async () => {
  for (const [how, findOpen] of [['false', async () => false], ['throws', async () => { throw new Error('no network'); }]]) {
    let looks = 0;
    let opens = 0;
    const gh = { lastAnswer: 'GitHub answered 502', findOpen: (t) => { looks += 1; return findOpen(t); }, open: async () => { opens += 1; return 1; } };
    const { r, logs } = await run({ gh, owner: 'owner-login' });
    assert.equal(r, 'not told', how);
    assert.equal(looks, 1, `${how}: no retry`);
    assert.equal(opens, 0, `${how}: an unknown answer opens nothing`);
    assert.match(logs[0], /could not be told/);
  }
});

test('L587: a send that fails, or a look that never answers, is logged and not retried', async () => {
  for (const open of [async () => false, async () => { throw new Error('refused'); }]) {
    let opens = 0;
    const gh = { findOpen: async () => null, open: (i) => { opens += 1; return open(i); } };
    const { r, logs } = await run({ gh, owner: 'owner-login' });
    assert.equal(r, 'not told');
    assert.equal(opens, 1);
    assert.equal(logs.length, 1);
  }
  const hung = { findOpen: () => new Promise(() => {}), open: async () => 1 };
  const { r, logs } = await run({ gh: hung, owner: 'owner-login' }, { sendMs: 20 });
  assert.equal(r, 'not told');
  assert.match(logs[0], /no answer within 20 ms/);
});

test('L587: with no writing token yet the stop is logged, naming what is missing', async () => {
  const { r, logs } = await run(undefined);
  assert.equal(r, 'not told');
  assert.match(logs[0], /R-0b-02/);
});

test('L587: a secret in the reason does not reach the issue', async () => {
  const gh = fakeIssues();
  const secret = `ghp_${'a'.repeat(36)}`;
  await tellStoreStopped({ stop: { ...stop, reason: `bad ${secret}` }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.doesNotMatch(gh.issues.get(1).body, /ghp_a/);
});

// L724: the marker is the fault's type and stable key, never the reason's words.
test('L724: two starts whose reasons differ only in the error text open one issue', async () => {
  const gh = fakeIssues();
  const at = (n) => ({ type: 'store_layout', reason: `the store's tmp/ is unreadable (EACCES: open /tmp/x-${n}-${n * 7919})`, key: 'EACCES:tmp' });
  for (let n = 1; n <= 4; n++) await tellStoreStopped({ stop: at(n), product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.equal(gh.issues.size, 1);
  // A different key is a different fault, and the type is part of the marker too.
  await tellStoreStopped({ stop: { ...at(9), key: 'ENOSPC:tmp' }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.equal(gh.issues.size, 2);
  assert.notEqual(stopMarker('product-1', 'store_layout', 'k'), stopMarker('product-1', 'other_type', 'k'));
});

test('L724: a local path in the reason is cut, a repo-style name kept, and the reason is fenced', async () => {
  const gh = fakeIssues();
  const reason = 'the store folder /Users/someone/orchestrate/products/p/store is a link; see docs/STORE.md';
  await tellStoreStopped({ stop: { type: 'store_layout', reason, key: reason }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  const body = gh.issues.get(1).body;
  assert.doesNotMatch(body, /\/Users\/someone/);
  assert.match(body, /the store folder &lt;path&gt; is a link; see docs\/STORE\.md/);
  assert.match(body, /<outside-text source="log-line">[^<]*<\/outside-text>/);
  const long = `x${'y'.repeat(400)}`;
  await tellStoreStopped({ stop: { type: 'store_layout', reason: long, key: 'long' }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: () => {} });
  assert.match(gh.issues.get(2).body, /\[cut 201 characters\]/);
});

test('L724: a fault the store keeps for the delivery pass is not told here too', async () => {
  const gh = fakeIssues();
  const logs = [];
  const r = await tellStoreStopped({ stop: { type: 'recovery_stopped', reason: 'recovery stopped: EACCES', key: 'EACCES:tmp' }, product: 'product-1', channel: { gh, owner: 'owner-login' }, log: (s) => logs.push(s) });
  assert.equal(r, 'kept');
  assert.equal(gh.issues.size, 0);
  assert.match(logs[0], /told by the delivery pass/);
});

// L732 m3: the issue left open after a fix hides the same fault coming back unless a start says so again. A start that
// finds it open comments once a day while the fault lasts, counting the opening itself.
test('L732: a fault still there while its issue is open is told again as a comment, at most once a day', async () => {
  let t = Date.parse('2026-11-09T08:00:00Z');
  const HOUR = 3600e3;
  const gh = fakeIssues({ now: () => new Date(t) });
  const at = (extra) => run({ gh, owner: 'owner-login' }, { now: () => t, ...extra });
  const pathStop = { ...stop, reason: "the store's diary.jsonl is a link, not a plain file (/Users/someone/orch/store)" };
  assert.equal((await at({ stop: pathStop })).r, 'opened');
  assert.match(gh.issues.get(1).body, /^Opened at 2026-11-09T08:00:00\.000Z\.$/m);
  t += HOUR;
  assert.equal((await at({ stop: pathStop })).r, 'already open', 'the opening counts as the day\'s notice');
  t += 24 * HOUR;
  assert.equal((await at({ stop: pathStop })).r, 'reminded');
  const c = gh.issues.get(1).comments;
  assert.equal(c.length, 1);
  assert.match(c[0], /^Still stopped \(store_layout\): <outside-text source="log-line">.*&lt;path&gt;.*<\/outside-text>$/);
  assert.doesNotMatch(c[0], /\/Users\//);
  for (let i = 0; i < 3; i++) { t += HOUR; assert.equal((await at({ stop: pathStop })).r, 'already open', 'once a day'); }
  t += 24 * HOUR;
  assert.equal((await at({ stop: pathStop })).r, 'reminded');
  assert.equal(gh.issues.get(1).comments.length, 2);
  assert.equal(gh.issues.size, 1, 'never a second issue');
});

test('L732: a look that fails before a comment says nothing more, and a refused comment is logged', async () => {
  let t = Date.parse('2026-11-09T08:00:00Z');
  const gh = fakeIssues({ now: () => new Date(t) });
  await run({ gh, owner: 'owner-login' }, { now: () => t });
  t += 30 * 3600e3;
  const blind = { ...gh, latestOwnComment: async () => false, lastAnswer: 'HTTP 502' };
  const a = await run({ gh: blind, owner: 'owner-login' }, { now: () => t });
  assert.equal(a.r, 'already open');
  assert.match(a.logs.join('\n'), /comments could not be read: HTTP 502/);
  const noRead = { ...gh, read: async () => false };
  assert.equal((await run({ gh: noRead, owner: 'owner-login' }, { now: () => t })).r, 'already open');
  const refused = { ...gh, comment: async () => false, lastAnswer: 'HTTP 403' };
  const b = await run({ gh: refused, owner: 'owner-login' }, { now: () => t });
  assert.equal(b.r, 'not told');
  assert.match(b.logs.join('\n'), /could not be told: HTTP 403/);
  assert.equal(gh.issues.get(1).comments.length, 0);
});

test('L732 self-review: a quoted path with a space is cut whole, and a reason\'s own line can\'t pass for the opening', async () => {
  const w = storeWords("EACCES: permission denied, open '/Users/someone/Library/Application Support/orch/tmp/1-w-a.json'");
  assert.doesNotMatch(w, /Support|orch\/tmp|someone/);
  assert.match(w, /open '&lt;path&gt;'/);
  // Every character the outside-text cleaner turns into a line break (L783: U+2028 and U+2029 too, #250 audit m1).
  for (const br of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const name = JSON.stringify(br);
    assert.doesNotMatch(storeWords(`a${br}Opened at 2099-01-01T00:00:00Z.${br}b`), /\n/, name);
    let t = Date.parse('2026-11-09T08:00:00Z');
    const gh = fakeIssues({ now: () => new Date(t) });
    const planted = { ...stop, reason: `bad folder${br}Opened at 2099-01-01T00:00:00Z.${br}end` };
    assert.equal((await run({ gh, owner: 'owner-login' }, { now: () => t, stop: planted })).r, 'opened', name);
    t += 30 * 3600e3;
    assert.equal((await run({ gh, owner: 'owner-login' }, { now: () => t, stop: planted })).r, 'reminded', `the planted date does not silence it: ${name}`);
  }
});

test('L732 self-review: an issue closed between the search and the read gets no comment', async () => {
  let t = Date.parse('2026-11-09T08:00:00Z');
  const gh = fakeIssues({ now: () => new Date(t) });
  await run({ gh, owner: 'owner-login' }, { now: () => t });
  t += 30 * 3600e3;
  const closing = { ...gh, read: async (n) => ({ ...(await gh.read(n)), open: false }) };
  assert.equal((await run({ gh: closing, owner: 'owner-login' }, { now: () => t })).r, 'already open');
  assert.equal(gh.issues.get(1).comments.length, 0);
});

test('L768, L801 M1: the stop issue counts its day by GitHub\'s clock; a robot clock ahead still reminds once a day, never each start', async () => {
  const HOUR = 3600e3;
  // The audit's probe: a start every hour for 6 days, the robot's clock fast by a fixed amount.
  for (const ahead of [7 * 60e3, 30 * 60e3, 23 * HOUR, 3 * 24 * HOUR]) {
    let g = Date.parse('2026-11-09T08:00:00Z');
    const gh = fakeIssues({ now: () => new Date(g + ahead), serverNow: () => new Date(g) });
    const at = () => run({ gh, owner: 'owner-login' }, { now: () => g + ahead });
    assert.equal((await at()).r, 'opened');
    const told = [];
    for (let h = 1; h <= 6 * 24; h++) {
      g += HOUR;
      const a = await at();
      if (a.r === 'reminded') told.push(h);
      else assert.equal(a.r, 'already open');
      assert.match(a.logs.join('\n'), new RegExp(`clock is ${Math.round(ahead / 60e3)} minutes ahead of GitHub's; the day is counted by GitHub's time`));
    }
    assert.ok(told.length >= 5 && told.length <= 6, `${ahead / 60e3} min ahead: ${told.length} reminders`);
    for (let i = 1; i < told.length; i++) assert.ok(told[i] - told[i - 1] >= 24, `${ahead / 60e3} min ahead: once a day`);
    assert.equal(gh.issues.get(1).comments.length, told.length);
  }
  // A clock a few minutes ahead, or behind, counts the day by GitHub's times: the opening, then the last comment.
  for (const skew of [3 * 60e3, -2 * HOUR]) {
    let h = Date.parse('2026-11-09T08:00:00Z');
    const gh2 = fakeIssues({ now: () => new Date(h + skew), serverNow: () => new Date(h) });
    const go = () => run({ gh: gh2, owner: 'owner-login' }, { now: () => h + skew });
    await go();
    h += 23 * HOUR;
    assert.equal((await go()).r, 'already open', `${skew}: not a day yet by GitHub`);
    h += 2 * HOUR;
    assert.equal((await go()).r, 'reminded', String(skew));
    h += 24 * HOUR - 2 * 60e3;   // 2 minutes short of a day by GitHub, which a clock 3 minutes ahead would count as past
    assert.equal((await go()).r, 'already open', `${skew}: once a day`);
    assert.equal(gh2.issues.get(1).comments.length, 1);
  }
});
