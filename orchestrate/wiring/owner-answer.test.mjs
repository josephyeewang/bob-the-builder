// owner-answer.test.mjs — the owner's side (L609, L611): the /usage report read strictly, one answer, written whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, statSync } from 'node:fs';
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

test('parseUsageReport: the session row is the 5-hour window, weekly_all the week; a scoped weekly row is not the week', () => {
  const r = parseUsageReport(stream(limits([row('session', 12.5), row('weekly_all', 99), row('weekly_scoped', 2, { scope: { model: { display_name: 'X' } } })])));
  assert.deepEqual(r, { ok: true, h5: { used_pct: 12.5, resets_at: '2026-11-07T22:59:59.734Z' }, week: { used_pct: 99, resets_at: '2026-11-07T22:59:59.734Z' } });
});

test('L611: a report with no session row gives a null 5-hour window, never 0%', () => {
  const r = parseUsageReport(stream(limits([row('weekly_all', 99), row('weekly_scoped', 2)])));
  assert.equal(r.ok, true);
  assert.equal(r.h5, null);
  assert.equal(r.week.used_pct, 99);
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
    [stream(limits([row('weekly_scoped', 1)])), /neither/],
    ['not json\nat all', /no usage_report/],
    [stream(limits([row('weekly_all', 1, { scope: { model: { display_name: 'X' } } })])), /neither/],
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
    usage: { h5: { used_pct: 40, resets_at: '2026-11-07T22:59:59.734Z' }, week: { used_pct: 60, resets_at: '2026-11-07T22:59:59.734Z' } } });
  assert.doesNotMatch(JSON.stringify(a), /example\.com|claude\.ai|max|Current week/);
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

test('the entry takes one argument, --to, a full path; anything else is a usage error', () => {
  const f = fileURLToPath(new URL('./owner-answer.mjs', import.meta.url));
  for (const args of [[], ['--to'], ['--to', 'relative.json']]) {
    const r = spawnSync(process.execPath, [f, ...args], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node owner-answer\.mjs --to/);
  }
});
