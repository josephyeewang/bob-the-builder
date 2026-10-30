// round2.test.mjs — planted cases for the 0b-8 audit round 2 findings (M-1 to M-7 and the minors fixed with them).
// Each test fails on the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joeTurns, lastTurnFinished, checkTapTest, questionBoxes } from './transcript.mjs';
import { shouldRestartFrontDoor, makeFrontDoorHandoff } from './restart.mjs';
import { outboxFile, checkOutboxFile } from './outbox.mjs';
import { checkPhoneReadback, extractReadback } from './readback.mjs';
import { buildTripBrief, miniCheck } from './trip.mjs';
import { typed, said, asks, result, T0, iso } from './fixtures.mjs';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { POWER_FACT } from '../M12-sensors/power-source.mjs';
import { STATUS_FACT } from '../M13-ledger/heartbeat.mjs';
import { FAKE } from '../M12-sensors/fakes.mjs';

const at = (min) => () => new Date(T0 + min * 60e3);
const queuedMsg = (min, prompt, kind = 'human') => ({ type: 'attachment', uuid: `qa-${min}-${kind}`, timestamp: iso(min),
  attachment: { type: 'queued_command', prompt, timestamp: iso(min), origin: { kind } } });
const user = (min, content, extra = {}) => ({ type: 'user', uuid: `uu-${min}-${Math.random()}`, timestamp: iso(min), message: { role: 'user', content }, ...extra });

test('0b-8 audit round 2 M-1: a message Joe queued while a turn ran counts as his turn and resets quiet; a queued notice does not', () => {
  const base = [typed(0, 'hi'), said(1, 'hello')];
  const withQueued = [...base, queuedMsg(14, 'also check the second product'), said(14, 'ok')];
  assert.deepEqual(joeTurns(withQueued).map((t) => t.text), ['hi', 'also check the second product']);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: withQueued, now: at(16) }).restart, false);
  const notice = [...base, queuedMsg(14, '<task-notification>done</task-notification>', 'task-notification'), said(14, 'ok')];
  assert.equal(joeTurns(notice).length, 1);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: notice, now: at(16) }).restart, true);
});

test('0b-8 audit round 2 M-2: a key hidden behind a \\u escape is refused and never echoed', () => {
  const k = FAKE.github;
  // Every third character escaped, so no run of plain text is long enough for the text check alone to catch.
  const escaped = [...k].map((c, i) => (i % 3 === 0 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('');
  // In the product field, whose name rule a key's characters pass.
  const text = `{"request":"resume","product":"${escaped}","name":null}`;
  assert.equal(JSON.parse(text).product, k, 'the planted file really holds the key once parsed');
  const c = checkOutboxFile('request-resume-20261103-0915-ao.json', text);
  assert.equal(c.ok, false);
  assert.equal(JSON.stringify(c).includes(k.slice(1)), false);
});

test('0b-8 audit round 2 minor 6: rotate refuses a key-ID shape and a name with no underscore', () => {
  const id = `AKIA${'Q7'.repeat(8)}`;
  assert.equal(outboxFile('request', '20261103-0915-ae', { request: 'rotate', name: id }).ok, false);
  assert.equal(outboxFile('request', '20261103-0915-af', { request: 'rotate', name: 'ABCDEFGH' }).ok, false);
  assert.equal(outboxFile('request', '20261103-0915-ai', { request: 'rotate', name: 'GITHUB_TOKEN' }).ok, true);
});

function tripWorld() {
  const NOW = Date.parse('2026-11-03T12:00:00Z');
  const now = () => new Date(NOW);
  const ago = (min) => new Date(NOW - min * 60e3).toISOString();
  const rec = memoryRecord();
  const facts = makeFactWriter(rec, { actor: 'ledger', now });
  const w = (entity, id, doc) => assert.equal(rec.write({ actor: 'dispatcher', entity, id, expectRev: rec.read(entity, id)?.rev ?? 0, doc }).ok, true);
  return { rec, facts, w, now, ago };
}
const brief = (x, extra = {}) => buildTripBrief({ products: [{ name: 'test-product', on_merge_gate: true }], until: '2026-11-07', tz: 'Europe/Prague', rec: x.rec, facts: x.facts, heartbeatProduct: 'mini', now: x.now, ...extra });

test('0b-8 audit round 2 M-3: the brief lists what waits on Joe from the one waiting list (a held card too), not what waits on others; a record error shows', () => {
  const x = tripWorld();
  x.w('card', 'card-4', { module: 'M1', state: 'waiting', wait: { who: 'joe', what: 'pick the launch date', since: x.ago(50) }, link: 'https://example.invalid/card/4' });
  x.w('go', 'go-5', { state: 'waiting', wait: { who: 'dispatcher', what: 'build finishing', since: x.ago(10) } });
  // The record refuses a waiting doc without who/since at write time, so a bad row (an older doc) is planted on read.
  const bad = { id: 'merge-6', rev: 1, doc: { state: 'waiting', wait: { what: 'unclear' } } };
  const rec = { ...x.rec, list: (e) => (e === 'merge' ? [bad] : x.rec.list(e)), read: (e, id) => (e === 'merge' ? bad : x.rec.read(e, id)) };
  const t = brief({ ...x, rec });
  assert.match(t, /Waiting on your go \(2\):/);
  assert.match(t, /- card card-4: .*pick the launch date.*\(https:\/\/example.invalid\/card\/4\)/);
  assert.match(t, /record error: merge merge-6 is waiting with no who, since/);
  assert.equal(t.includes('build finishing'), false);
});

test('0b-8 audit round 2 M-5, minors 8, 9: the brief is stamped with when it was made and good until; a future heartbeat is unknown; a bad zone holds number work', () => {
  const x = tripWorld();
  assert.match(brief(x).split('\n')[0], /^Brief made 2026-11-03T12:00:00.000Z; good until 2026-11-03T12:15:00.000Z\.$/);
  x.facts.put(STATUS_FACT('mini'), { kind: 'fact.heartbeat-status', at: new Date(x.now().getTime() + 3 * 3600e3).toISOString(), front_door_reachable: true, signed_in: true, login: 'account A' });
  x.facts.put(POWER_FACT, { kind: 'fact.power-source', at: x.ago(5), ups_present: true });
  assert.equal(miniCheck({ facts: x.facts, heartbeatProduct: 'mini', now: x.now }).items[0].state, 'unknown');
  const t = brief(x, { tz: 'EST' });
  assert.match(t, /Which time zone will you be in\?/);
  assert.equal(/merges only .* EST/.test(t), false);
});

const PROFILE = { tools: ['Read'], skills: ['orchestrate'] };
const good = { tools: ['Read'], skills: ['orchestrate'], plugins: [], connectors: [], mcp_servers: [], setting_sources: ['managed', 'flag'] };

test('0b-8 audit round 2 M-4: a read-back list with an entry that is not a name is unreadable, never silently dropped', () => {
  assert.equal(checkPhoneReadback(good, PROFILE).ok, true, checkPhoneReadback(good, PROFILE).problems.join());
  for (const [k, v] of [['connectors', [{ id: 'mail' }]], ['mcp_servers', [42]], ['plugins', [null]], ['tools', ['Read', { name: 7 }]]]) {
    const r = checkPhoneReadback({ ...good, [k]: v }, PROFILE);
    assert.equal(r.ok, false, k);
    assert.match(r.problems.join(), new RegExp(`${k}: missing or unreadable`), k);
  }
});

test('0b-8 audit round 2 minor 11: a reply with two read-back objects is refused, not guessed', () => {
  const two = `Expected:\n${JSON.stringify({ ...good, tools: ['Read'] })}\nActual:\n${JSON.stringify({ ...good, tools: ['Read', 'Bash'] })}`;
  assert.equal(extractReadback(two), null);
  assert.deepEqual(extractReadback('```json\n' + JSON.stringify(good) + '\n```'), good);
  assert.deepEqual(extractReadback(`note {"a": "}"} only`), { a: '}' });
});

test('0b-8 audit round 2 M-7: keys typed into an open box are not a tap and not Joe', () => {
  const entries = [asks(0, 'q-a'), result(1, 'q-a', 'Yes'), asks(2, 'q-b'), result(3, 'q-b', 'Yes'), asks(4, 'q-c'), result(5, 'q-c', 'User answered: [watchdog] are you alive?')];
  const r = checkTapTest(entries);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /q-c was answered by typed automated text/);
  assert.equal(joeTurns(entries).length, 2);
});

test('0b-8 audit round 2 minors 2, 3, 4, 5: side threads, repeats, Esc and a sent document', () => {
  const side = [typed(0, 'hi'), said(1, 'ok'), { ...typed(14, 'subagent prompt'), isSidechain: true }];
  assert.equal(joeTurns(side).length, 1);
  const a = asks(0, 'q-1');
  const dup = [a, { ...asks(2, 'q-1'), uuid: a.uuid }, result(3, 'q-1', 'A')];
  assert.equal(questionBoxes(dup)[0].askedAt, Date.parse(iso(0)));
  assert.equal(joeTurns([typed(0, 'x'), typed(0, 'x')].map((e) => ({ ...e, uuid: 'same' }))).length, 1);
  assert.equal(lastTurnFinished([typed(0, 'x'), said(1, 'working', 'tool_use'), typed(2, '[Request interrupted by user]')]), true);
  const doc = [user(14, [{ type: 'document', source: { type: 'base64', data: 'x' } }])];
  assert.deepEqual(joeTurns(doc).map((t) => t.text), ['[document]']);
});

test('0b-8 audit round 2 minors 1, 7: newest turn with no time → no restart; control characters cannot split a key past the mask', () => {
  const entries = [typed(10, 'earlier'), said(10, 'ok'), { ...typed(0, 'later'), timestamp: undefined }, said(11, 'ok')];
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries, now: at(60) }).restart, false);
  const k = FAKE.github;
  const split = `${k.slice(0, 6)}\u0007${k.slice(6)}`;
  const h = makeFrontDoorHandoff({ entries: [typed(0, `use ${split} please`), said(1, 'ok')], openAsks: [], rereadList: [], now: at(30) });
  assert.equal(h.includes(k.slice(6)), false);
});
