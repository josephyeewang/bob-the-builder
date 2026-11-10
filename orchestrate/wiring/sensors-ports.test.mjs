// sensors-ports.test.mjs — the `orchestrate` side (L609, L611, L614): the owner's answer is a claim, read strictly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { writeAnswer, ANSWER_FILE } from './owner-answer.mjs';
import { readOwnerAnswer, sensorsPorts, ANSWER_STALE_MS } from './sensors-ports.mjs';

const T0 = Date.parse('2026-11-05T12:00:00Z');
const UID = process.getuid();
const answer = (extra = {}) => ({ v: 1, account: 'a', signed_in: true, observed_at: new Date(T0).toISOString(),
  usage: { h5: { used_pct: 40, resets_at: '2026-11-05T15:00:00.000Z' }, week: { used_pct: 60, resets_at: '2026-11-07T22:59:59.000Z' } }, ...extra });
const noAcl = () => null;

function place(doc = answer(), { raw } = {}) {
  const dir = tempDir('orch-sensors-ports-');
  chmodSync(dir, 0o755);
  const file = join(dir, ANSWER_FILE);
  if (raw !== undefined) { writeFileSync(file, raw); chmodSync(file, 0o644); } else assert.equal(writeAnswer({ to: file, answer: doc }).ok, true);
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const ports = (file, o = {}) => sensorsPorts({ file, ownerUid: UID, now: () => new Date(T0 + (o.later ?? 0)), acl: o.acl ?? noAcl });

test('a fresh answer gives the account and both windows', async () => {
  const w = place();
  try {
    const p = ports(w.file);
    assert.equal(await p.whoIsSignedIn(), 'a');
    assert.deepEqual(await p.readUsage('a'), { source: 'claude /usage', h5: answer().usage.h5, week: answer().usage.week });
    assert.equal(p.lastReason(), null);
  } finally { w.done(); }
});

test('L611: no 5-hour row → null figures, never 0%, and the reason says it stays unknown', async () => {
  const w = place(answer({ usage: { h5: null, week: { used_pct: 99, resets_at: null } } }));
  try {
    const p = ports(w.file);
    const u = await p.readUsage('a');
    assert.equal(u.h5, null);
    assert.equal(u.week.used_pct, 99);
    assert.match(p.lastReason(), /no 5-hour row/);
  } finally { w.done(); }
});

test('signed out, not known, another account, or a report the owner side refused: null, with the reason', async () => {
  for (const [doc, who, usage] of [
    [answer({ signed_in: false, usage: null, usage_reason: 'not signed in' }), /not signed in/, /not about a signed-in/],
    [answer({ signed_in: null, usage: null }), /not known/, /not about a signed-in/],
    [answer({ usage: null, usage_reason: 'the /usage answer has no usage_report' }), null, /no usage_report/],
  ]) {
    const w = place(doc);
    try {
      const p = ports(w.file);
      const a = await p.whoIsSignedIn();
      if (who) { assert.equal(a, null); assert.match(p.lastReason(), who); } else assert.equal(a, 'a');
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
    const at = (ms) => { const p = ports(w.file, { later: ms }); return p.whoIsSignedIn().then((a) => [a, p.lastReason()]); };
    assert.deepEqual(await at(ANSWER_STALE_MS), ['a', null]);
    const [old, why] = await at(ANSWER_STALE_MS + 60_000);
    assert.equal(old, null); assert.match(why, /16 min old/);
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
