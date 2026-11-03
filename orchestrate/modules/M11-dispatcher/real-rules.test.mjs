// M11 on real rules text, with no stand-ins (L123 M-1): the rules file goes through parsePolicy and the real engine
// (M10 rulesFromText), and M11's own readers (keys.mjs need()/minutes, gate.mjs editingLimits) read it. A fake that
// hands JS numbers and true/false hid that M11 could not read the real file at all (L123).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesFromText } from '../M10-rules/from-text.mjs';
import { fakeRules } from '../../shared/rules.mjs';
import { KEYS, need, minutes, MissingKey } from './keys.mjs';
import { editingLimits } from './gate.mjs';
import { bands } from './usage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8');
const o = { product: 'app' };

const withCaps = (lines) => FIXTURE.replace(/^caps:\n/m, `caps:\n${lines}\n`);
const PER_STATE = '  per_state:\n    active: 2\n    away: 1\n    light: 1\n    paused: 0';

test('L123: caps.shakedown "false" in the text turns shakedown off; "true" and no line keep it on', () => {
  const doc = { state: 'active' };
  const off = rulesFromText(withCaps(`  shakedown: false\n${PER_STATE}`));
  assert.equal(need(off, KEYS.shakedown, { ...o, type: 'boolean' }), false);
  assert.deepEqual(editingLimits({ rules: off, product: 'app', productDoc: doc }), { product: 2, mac: 5 }, 'per_state 2 and per product 3: 2');
  const on = rulesFromText(withCaps(`  shakedown: true\n${PER_STATE}`));
  assert.equal(need(on, KEYS.shakedown, { ...o, type: 'boolean' }), true);
  assert.deepEqual(editingLimits({ rules: on, product: 'app', productDoc: doc }), { product: 1, mac: 5 }, 'shakedown_workers 1');
  const absent = rulesFromText(withCaps(PER_STATE));
  assert.equal(need(absent, KEYS.shakedown, { ...o, type: 'boolean' }), true, 'no line: the fail-closed default');
  assert.deepEqual(editingLimits({ rules: absent, product: 'app', productDoc: doc }), { product: 1, mac: 5 });
});

test('L123: caps.per_state comes as text and is read per state as a whole number', () => {
  const rules = rulesFromText(withCaps(`  shakedown: false\n${PER_STATE}`));
  assert.equal(editingLimits({ rules, product: 'app', productDoc: { state: 'away' } }).product, 1);
  assert.equal(editingLimits({ rules, product: 'app', productDoc: { state: 'paused' } }).product, 0);
  assert.throws(() => editingLimits({ rules, product: 'app', productDoc: { state: 'unknown' } }), (e) => e.key === KEYS.perState);
  // A state cap that isn't a whole number is missing, never read loosely.
  // (A quoted "2" is the same text as 2 to the reader, so it reads as 2.)
  for (const bad of ['two', '2.5', '-1', '02', '']) {
    const r = rulesFromText(withCaps(`  shakedown: false\n  per_state:\n    active: ${bad}`));
    assert.throws(() => editingLimits({ rules: r, product: 'app', productDoc: { state: 'active' } }), (e) => e.key === KEYS.perState, `active: ${bad}`);
  }
  // No per_state at all: missing.
  const none = rulesFromText(withCaps('  shakedown: false'));
  assert.throws(() => editingLimits({ rules: none, product: 'app', productDoc: { state: 'active' } }), MissingKey);
});

test('L123: context.* and the minute keys are read typed from text', () => {
  const text = `${FIXTURE.replace(/^timeouts:\n/m, 'timeouts:\n  front_door_stuck_min: 20\n  dead_quiet_min: 45\n')}
context:
  lead:
    soft: 120000
    hard: 160000
  handoff_cap:
    role: 4000
  worker:
    split_after_compactions: 3
outage:
  min_dead: 2
  share: 0.5
`;
  const rules = rulesFromText(text);
  assert.equal(need(rules, KEYS.leadSoft, o), 120000);
  assert.equal(need(rules, KEYS.leadHard, o), 160000);
  assert.equal(need(rules, KEYS.handoffCapRole, o), 4000);
  assert.equal(need(rules, KEYS.splitAfterCompactions, o), 3);
  // The Dispatcher-wide keys (L131) are Mac-wide: their callers read them with no product, as here.
  assert.equal(minutes(rules, KEYS.frontDoorStuckMin), 20 * 60_000);
  assert.equal(minutes(rules, KEYS.deadQuietMin), 45 * 60_000);
  assert.equal(need(rules, KEYS.outageMinDead), 2);
  assert.equal(need(rules, KEYS.outageShare), 0.5, 'a share is read with dec()');
  assert.deepEqual([...rules.engine.noProductReads], [], 'no per-product key was read without its product');
  assert.equal(minutes(rules, KEYS.staleAfterMin), 15 * 60_000);
  assert.equal(need(rules, KEYS.editingPerMac), 5);
  assert.equal(need(rules, KEYS.redPace), 1, 'the text "1.0" is a decimal');
  assert.equal(need(rules, KEYS.amberPace), 0.85);
});

test('L123: a value that is present but unreadable is missing, never a default or a loose number', () => {
  const text = `${FIXTURE}
context:
  lead:
    soft: lots
    hard: 1.5
  handoff_cap:
    role: 4e3
`;
  const rules = rulesFromText(text);
  for (const k of [KEYS.leadSoft, KEYS.leadHard, KEYS.handoffCapRole]) assert.throws(() => need(rules, k, o), (e) => e instanceof MissingKey && e.key === k, k);
  assert.throws(() => need(rules, KEYS.splitAfterCompactions, o), MissingKey, 'absent, and no default');
  // The checker refuses a bad shakedown or pace floor in a file, so a stand-in shows the reader's own rule: a key with a
  // default that is present but unreadable is missing, never the default.
  const bad = fakeRules({ values: { [KEYS.shakedown]: 'yes', [KEYS.paceMinShare]: '0.5x' } });
  assert.throws(() => need(bad, KEYS.shakedown, { ...o, type: 'boolean' }), MissingKey, 'shakedown: yes');
  assert.throws(() => need(bad, KEYS.paceMinShare), MissingKey, 'pace_min_share: 0.5x');
});

const withPace = (v) => FIXTURE.replace(/^usage:\n/m, `usage:\n  pace_min_share: ${v}\n`);
const WEEK_MS = 7 * 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-14T14:00:00Z');
// A checked usage reading with `gone` of the week passed and 40% of it used: pace 0.4 / gone.
const reading = (gone) => ({ ok: true, week: 40, h5: 10, weekResets: NOW + (1 - gone) * WEEK_MS });

test('L123 / L104 / L131: usage.pace_min_share 0.5 in the text is 0.5 in M11\'s own band read, with no product', () => {
  const rules = rulesFromText(withPace('0.5'));
  assert.equal(need(rules, KEYS.paceMinShare), 0.5);
  // Through bands(): at 40% of the week gone, a floor of 0.5 means pace doesn't count yet; at 60% it does (0.4/0.6).
  assert.equal(bands({ rules, reading: reading(0.4), now: NOW }).pace, null);
  assert.equal(bands({ rules, reading: reading(0.6), now: NOW }).pace.toFixed(3), (0.4 / 0.6).toFixed(3));
  // With no line, the 0.143 default: at 40% gone pace counts (40% used / 40% gone = 1).
  const dflt = rulesFromText(FIXTURE);
  assert.equal(need(dflt, KEYS.paceMinShare), 0.143);
  assert.equal(bands({ rules: dflt, reading: reading(0.4), now: NOW }).pace, 1);
  assert.deepEqual([...rules.engine.noProductReads, ...dflt.engine.noProductReads], [], 'bands() reads no per-product key without its product');
});

test('L131: across products a Dispatcher-wide key is the smallest value (dead_quiet_min the largest); one product without it leaves it missing', () => {
  const two = rulesFromText({ app: withPace('0.5'), web: withPace('0.3') });
  assert.equal(need(two, KEYS.paceMinShare), 0.3);
  const quiet = (n) => FIXTURE.replace(/^timeouts:\n/m, `timeouts:\n  front_door_stuck_min: ${n}\n  dead_quiet_min: ${n}\n  usage_unknown_max_min: ${n}\n`);
  const t = rulesFromText({ app: `${quiet(30)}\noutage:\n  min_dead: 3\n  share: 0.6\n`, web: `${quiet(20)}\noutage:\n  min_dead: 2\n  share: 0.7\n` });
  for (const k of [KEYS.frontDoorStuckMin, KEYS.usageUnknownMaxMin]) assert.equal(need(t, k), 20, k);
  // dead_quiet_min is the largest (L131 follow-up): a session is called dead only once every product's limit has passed.
  assert.equal(need(t, KEYS.deadQuietMin), 30);
  assert.equal(need(t, KEYS.outageMinDead), 2);
  assert.equal(need(t, KEYS.outageShare), 0.6);
  // One product leaves pace_min_share out: the Mac-wide value is missing, so the default stands in (it is absent, not bad).
  assert.equal(need(rulesFromText({ app: withPace('0.5'), web: FIXTURE }), KEYS.paceMinShare), 0.143);
  // One product leaves front_door_stuck_min out: missing, never the other product's value.
  assert.throws(() => need(rulesFromText({ app: quiet(30), web: FIXTURE }), KEYS.frontDoorStuckMin), MissingKey);
});

// L134 M-1: #68 gate.mjs reads timeouts.merging_open_max_min through minutes(). Before the typed reads, a text value
// gave a NaN limit, so "open past the limit" was never true and an interrupted merge was never refused (4 M6 gate
// tests red after the #68 merge-forward). Here the limit comes from the real rules text and is a number.
test("L134 M-1: a merge open past timeouts.merging_open_max_min is past its limit when the rules come in as text", () => {
  // The fixture holds the key since L148; each case replaces its value.
  const withOpen = (v) => FIXTURE.replace(/^  merging_open_max_min: 10$/m, `  merging_open_max_min: ${v}`);
  assert.notEqual(withOpen("45"), FIXTURE, "the fixture holds timeouts.merging_open_max_min");
  const rules = rulesFromText(withOpen("45"));
  const limit = minutes(rules, "timeouts.merging_open_max_min", o);
  assert.equal(limit, 45 * 60_000);
  const pastLimit = (openFor) => openFor > limit;
  assert.equal(pastLimit(46 * 60_000), true, "open 46 min: refused as interrupted");
  assert.equal(pastLimit(44 * 60_000), false, "open 44 min: still waiting");
  // A value that is not a whole number never becomes a limit (NaN would make every comparison false): the rules file
  // is refused at load, and a reader handed such text anyway finds the key missing.
  for (const bad of ["soon", "45.5", "-1"]) {
    assert.throws(() => rulesFromText(withOpen(bad)), /merging_open_max_min must be a whole number/, bad);
    assert.throws(() => minutes(fakeRules({ values: { "timeouts.merging_open_max_min": bad } }), "timeouts.merging_open_max_min", o), MissingKey, bad);
  }
  // The same through a fake that hands text, as other modules' tests do.
  assert.equal(minutes(fakeRules({ values: { "timeouts.merging_open_max_min": 45 } }), "timeouts.merging_open_max_min", o), 45 * 60_000);
});
