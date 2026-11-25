// owner-answer.test.mjs — the owner's side (L609, L611): the /usage report read strictly, one answer, written whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseUsageReport, ownerAnswer, writeAnswer, ANSWER_FILE } from './owner-answer.mjs';

const row = (kind, percent, extra = {}) => ({ kind, group: kind === 'session' ? 'session' : 'weekly', percent, resets_at: '2026-11-07T22:59:59.734976+00:00', severity: 'normal', is_active: false, ...extra });
const stream = (report) => [JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Current week: ...' }] }, ...(report === undefined ? {} : { usage_report: report }) }),
  JSON.stringify({ type: 'result', subtype: 'success' })].join('\n');
const limits = (rows) => ({ session: {}, rate_limits: { limits: rows } });

const T = '2026-11-07T22:59:59.734Z';
test('parseUsageReport: the session row is the 5-hour window; the week is the highest weekly row, and says which', () => {
  const r = parseUsageReport(stream(limits([row('session', 12.5), row('weekly_all', 99), row('weekly_scoped', 2, { scope: { model: { display_name: 'X' } } })])));
  assert.deepEqual(r, { ok: true, h5: { used_pct: 12.5, resets_at: T }, week: { used_pct: 99, resets_at: T }, week_from: 'weekly_all',
    week_rows: { weekly_all: { used_pct: 99, resets_at: T }, 'weekly_scoped:X': { used_pct: 2, resets_at: T } } });
});

test('L1358 r2 (MAT-1): week_rows holds every weekly row by name, the week under its own; shared cut names keep the higher; too many rows refuse', () => {
  // The live account's tie: both rows at the same figure and time; the week is weekly_all, and the scoped row is still there.
  const tie = parseUsageReport(stream(limits([row('weekly_scoped', 0, { scope: { model: { display_name: 'Fable' } } }), row('weekly_all', 0)])));
  assert.deepEqual([tie.week_from, tie.week_rows], ['weekly_all', { 'weekly_scoped:Fable': { used_pct: 0, resets_at: T }, weekly_all: { used_pct: 0, resets_at: T } }]);
  const shared = parseUsageReport(stream(limits([row('weekly_all', 10), row('weekly_scoped', 30, { scope: { model: { display_name: 'A b' } } }),
    row('weekly_scoped', 20, { scope: { model: { display_name: 'A/b' } } })])));
  assert.deepEqual(shared.week_rows, { weekly_all: { used_pct: 10, resets_at: T }, 'weekly_scoped:A-b': { used_pct: 30, resets_at: T } });
  assert.equal(shared.week_from, 'weekly_scoped:A-b');
  const many = parseUsageReport(stream(limits([row('weekly_all', 1), ...Array.from({ length: 16 }, (_, i) => row('weekly_scoped', 1, { scope: { model: { display_name: `m${i}` } } }))])));
  assert.match(many.reason, /more than 16 weekly rows/);
  // No weekly row: no rows either.
  assert.equal(parseUsageReport(stream(limits([row('session', 3)]))).week_rows, null);
});

test('L728 M2: a scoped weekly row higher than weekly_all is the week, named by its model; a tie goes to weekly_all', () => {
  const later = '2026-11-09T10:00:00Z';
  const r = parseUsageReport(stream(limits([row('session', 10), row('weekly_all', 50),
    row('weekly_scoped', 100, { scope: { model: { display_name: 'Big Model 4/x' } }, resets_at: later }), row('weekly_scoped', 70, { scope: { model: { display_name: 'Y' } } })])));
  assert.deepEqual(r, { ok: true, h5: { used_pct: 10, resets_at: T }, week: { used_pct: 100, resets_at: '2026-11-09T10:00:00.000Z' }, week_from: 'weekly_scoped:Big-Model-4-x',
    week_rows: { weekly_all: { used_pct: 50, resets_at: T }, 'weekly_scoped:Big-Model-4-x': { used_pct: 100, resets_at: '2026-11-09T10:00:00.000Z' }, 'weekly_scoped:Y': { used_pct: 70, resets_at: T } } });
  const tie = parseUsageReport(stream(limits([row('weekly_scoped', 60, { scope: { model: { display_name: 'Y' } } }), row('weekly_all', 60)])));
  assert.equal(tie.week_from, 'weekly_all');
  const only = parseUsageReport(stream(limits([row('weekly_scoped', 3)])));
  assert.deepEqual([only.ok, only.h5, only.week.used_pct, only.week_from], [true, null, 3, 'weekly_scoped:unnamed']);
  // The scope on a row never decides its kind (r1 P8): weekly_all with scope null or {} is still the week.
  for (const scope of [null, {}]) assert.equal(parseUsageReport(stream(limits([row('weekly_all', 50, { scope })]))).week.used_pct, 50);
});

test('L728 m3: a row of a kind this does not know (a renamed row) refuses the report, never is skipped', () => {
  for (const kind of ['five_hour', 'Session', undefined, 'weekly']) {
    const r = parseUsageReport(stream(limits([row('weekly_all', 5), row(kind, 1)])));
    assert.equal(r.ok, false, String(kind));
    assert.match(r.reason, /kind this does not know/);
  }
  assert.match(parseUsageReport(stream(limits([row('weekly_all', 5), null]))).reason, /kind this does not know/);
});

test('L728 m2: percents that look like fractions (all 1 or under while a row is not normal) are refused', () => {
  const r = parseUsageReport(stream(limits([row('session', 0.3), row('weekly_all', 0.99, { severity: 'warning' })])));
  assert.equal(r.ok, false);
  assert.match(r.reason, /look like fractions/);
  // Low real usage, every row normal, is read as given.
  assert.equal(parseUsageReport(stream(limits([row('session', 0.3), row('weekly_all', 1)]))).week.used_pct, 1);
});

test('L611: a report with no session row gives a null 5-hour window, never 0%', () => {
  const r = parseUsageReport(stream(limits([row('weekly_all', 99), row('weekly_scoped', 2)])));
  assert.equal(r.ok, true);
  assert.equal(r.h5, null);
  assert.equal(r.week.used_pct, 99);
  // L1331: and says the report listed no 5-hour row, so M11 judges by the week alone. Written only then.
  assert.equal(r.h5_none, true);
  assert.equal(Object.hasOwn(parseUsageReport(stream(limits([row('session', 1), row('weekly_all', 2)]))), 'h5_none'), false);
  // A session row that can't be read refuses the whole report; it is never taken as no row.
  assert.equal(parseUsageReport(stream(limits([row('session', 'x'), row('weekly_all', 2)]))).ok, false);
  assert.equal(parseUsageReport(stream(limits([row('session', null), row('weekly_all', 2)]))).ok, false);
});

test('L611: a report this does not know is refused, and says why', () => {
  const cases = [
    ['', /no answer/],
    [stream(undefined), /no usage_report/],
    [stream(null), /no rate_limits/],
    [stream({ rate_limits: null }), /no rate_limits/],
    [stream({ rate_limits: { limits: null } }), /not a list/],
    [stream(limits([row('session', 140), row('weekly_all', 3)])), /session row's percent/],
    [stream(limits([row('session', '12'), row('weekly_all', 3)])), /session row's percent/],
    [stream(limits([row('session', 1), row('session', 2)])), /2 session rows/],
    [stream(limits([row('weekly_all', 1, { resets_at: 'soon' })])), /reset time/],
    [stream(limits([])), /neither/],
    ['not json\nat all', /no usage_report/],
    [stream(limits([row('weekly_all', 1), row('weekly_all', 2)])), /2 weekly_all rows/],
    [stream(limits([row('weekly_all', 1), row('weekly_scoped', 101)])), /weekly_scoped row's percent/],
  ];
  for (const [text, why] of cases) {
    const r = parseUsageReport(text);
    assert.equal(r.ok, false, String(text).slice(0, 80));
    assert.match(r.reason, why);
  }
});

const signedIn = (extra = {}) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com', ...extra });
const fakes = ({ use = { account: 'a' }, auth = signedIn(), usage = stream(limits([row('session', 40), row('weekly_all', 60)])) } = {}) => ({
  home: '/Users/owner', now: () => new Date('2026-11-05T12:00:00Z'),
  inUse: () => use, authStatus: async () => (auth instanceof Error ? Promise.reject(auth) : auth), usage: async () => usage,
});

test('ownerAnswer: signed in → the account and both windows, with no email, token or raw output in it', async () => {
  const a = await ownerAnswer(fakes());
  assert.deepEqual(a, { v: 1, account: 'a', signed_in: true, observed_at: '2026-11-05T12:00:00.000Z',
    usage: { h5: { used_pct: 40, resets_at: '2026-11-07T22:59:59.734Z' }, week: { used_pct: 60, resets_at: '2026-11-07T22:59:59.734Z' }, week_from: 'weekly_all',
      week_rows: { weekly_all: { used_pct: 60, resets_at: '2026-11-07T22:59:59.734Z' } } } });
  assert.doesNotMatch(JSON.stringify(a), /example\.com|claude\.ai|max|Current week/);
  // L1331: the live report's shape on 20 Nov (weekly rows only) → no 5-hour window, said in so many words.
  const weekly = await ownerAnswer(fakes({ usage: stream(limits([row('weekly_all', 48), row('weekly_scoped', 25, { scope: { model: { display_name: 'M' } } })])) }));
  assert.deepEqual(weekly.usage, { h5: null, week: { used_pct: 48, resets_at: '2026-11-07T22:59:59.734Z' }, week_from: 'weekly_all',
    week_rows: { weekly_all: { used_pct: 48, resets_at: '2026-11-07T22:59:59.734Z' }, 'weekly_scoped:M': { used_pct: 25, resets_at: '2026-11-07T22:59:59.734Z' } }, h5_none: true });
  // Audit m1: rate_limits with a key this reader doesn't know may hold a moved 5-hour figure, so no marker (unknown).
  const moved = await ownerAnswer(fakes({ usage: stream({ session: {}, rate_limits: { limits: [row('weekly_all', 48)], five_hour: { utilization: 99 } } }) }));
  assert.equal(moved.usage.h5_none, undefined);
  assert.equal(moved.usage.week.used_pct, 48);
  const known = await ownerAnswer(fakes({ usage: stream({ session: {}, rate_limits: { limits: [row('weekly_all', 48)], extra_usage: { is_enabled: false } } }) }));
  assert.equal(known.usage.h5_none, true);
  // r4 m1: a key beside rate_limits may hold a moved 5-hour figure too.
  const beside = await ownerAnswer(fakes({ usage: stream({ session: {}, rate_limits: { limits: [row('weekly_all', 48)] }, five_hour: { utilization: 99 } }) }));
  assert.equal(beside.usage.h5_none, undefined);
});

test('ownerAnswer: signed out, not known, no account or a refused report each say so, and never guess', async () => {
  const out = await ownerAnswer(fakes({ auth: JSON.stringify({ loggedIn: false }) }));
  assert.deepEqual([out.account, out.signed_in, out.usage, out.usage_reason], ['a', false, null, 'not signed in']);
  const thrown = await ownerAnswer(fakes({ auth: new Error('spawn failed') }));
  assert.deepEqual([thrown.signed_in, thrown.usage], [null, null]);
  const garbled = await ownerAnswer(fakes({ auth: 'not json' }));
  assert.equal(garbled.signed_in, null);
  const other = await ownerAnswer(fakes({ auth: signedIn({ configDirectory: '/elsewhere' }) }));
  assert.equal(other.signed_in, false, 'signed in, but for another folder');
  const none = await ownerAnswer(fakes({ use: { account: null, reason: '.claude-account names neither a nor b' } }));
  assert.deepEqual([none.account, none.usage_reason], [null, '.claude-account names neither a nor b']);
  const refused = await ownerAnswer(fakes({ usage: stream(undefined) }));
  assert.equal(refused.usage, null);
  assert.match(refused.usage_reason, /no usage_report/);
  const broken = await ownerAnswer({ ...fakes(), inUse: () => { throw new Error('boom'); } });
  assert.equal(broken.account, null);
});

test('writeAnswer: written whole at 0644 into the owner\'s folder; refuses a folder others can write or someone else owns', () => {
  const dir = tempDir('orch-owner-answer-');
  try {
    chmodSync(dir, 0o755);
    const to = join(dir, ANSWER_FILE);
    assert.deepEqual(writeAnswer({ to, answer: { v: 1 } }), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(to, 'utf8')), { v: 1 });
    assert.equal(statSync(to).mode & 0o777, 0o644);
    assert.deepEqual(writeAnswer({ to, answer: { v: 2 } }), { ok: true }, 'a second round replaces it');
    assert.match(writeAnswer({ to, answer: {}, uid: process.getuid() + 1 }).reason, /not owned by uid/);
    assert.match(writeAnswer({ to: 'relative.json', answer: {} }).reason, /full path/);
    chmodSync(dir, 0o777);
    assert.match(writeAnswer({ to, answer: {} }).reason, /written by others/);
    assert.match(writeAnswer({ to: join(dir, 'nope', ANSWER_FILE), answer: {} }).reason, /missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L728 c2: a temporary file a crashed round left behind is cleared, so they never pile up', () => {
  const dir = tempDir('orch-owner-answer-');
  try {
    chmodSync(dir, 0o755);
    const to = join(dir, ANSWER_FILE);
    writeFileSync(`${to}.tmp`, 'half a round');
    assert.deepEqual(writeAnswer({ to, answer: { v: 1 } }), { ok: true });
    assert.deepEqual(writeAnswer({ to, answer: { v: 1 } }), { ok: true });
    assert.deepEqual(readdirSync(dir), [ANSWER_FILE]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the entry takes one argument, --to, a full path; anything else is a usage error', () => {
  const f = fileURLToPath(new URL('./owner-answer.mjs', import.meta.url));
  for (const args of [[], ['--to'], ['--to', 'relative.json']]) {
    const r = spawnSync(process.execPath, [f, ...args], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node owner-answer\.mjs --to/);
  }
});
