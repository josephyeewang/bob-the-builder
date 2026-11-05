// policy.test.mjs — a rules file is fully valid or it is "corrupt" (spec review 0b-1: MAT-2, MAT-12; round 2:
// R2-M3, R2-m1). Every corrupt case is a one-line change to the fixture, planted and expected to be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePolicy, KEYS, REQUIRED_KEYS, compareVersions, PRODUCT_STATES, START_RULES, TIER1_MERGE_RULES } from './policy.mjs';

const fixture = readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8');
const swap = (from, to) => { assert.ok(fixture.includes(from), `fixture lacks ${JSON.stringify(from)}`); return fixture.replace(from, to); };
const refused = (text, why) => {
  const r = parsePolicy(text);
  assert.equal(r.ok, false, `expected corrupt: ${why}`);
  assert.equal(typeof r.reason, 'string');
  return r.reason;
};

test('the fixture is valid, frozen, and has no prototype anywhere', () => {
  const r = parsePolicy(fixture);
  assert.ok(r.ok, r.reason);
  assert.equal(Object.getPrototypeOf(r.policy), null);
  assert.equal(Object.getPrototypeOf(r.policy.merge.queue), null);
  assert.ok(Object.isFrozen(r.policy.caps));
  assert.equal(r.policy.caps.editing_per_mac, 5);
  assert.equal(r.policy.usage.bands.amber.pace, 0.85);
  assert.equal(r.policy.accounts.joe.github_id, 1000001);
  assert.deepEqual({ ...r.policy.timeouts.card.running }, { minutes: 240, then: 'stuck' });
  assert.equal(r.policy.timeouts.card.waiting.recheck_max_min, 1440);
  assert.equal(r.policy.tiers.paths[0].tier, 2);
});

test('a __proto__ key, plain or as a list item or quoted, is refused before parsing (R2-M3)', () => {
  assert.match(refused(`${fixture}\n__proto__:\n  merge: loose\n`, 'proto'), /banned key/);
  assert.match(refused(swap('caps:\n', 'caps:\n  constructor: 1\n'), 'constructor'), /banned key/);
  assert.match(refused(swap('lanes:\n', "lanes:\n  'prototype': [x]\n"), 'prototype'), /banned key/);
});

test('yaml errors, unknown or retired keys and missing required keys are corrupt', () => {
  refused('tiers: [a\n', 'bad yaml');
  refused(`${fixture}\nask_first: [schema]\n`, 'ask_first');
  refused(`${fixture}\nsurprise: 1\n`, 'unknown key');
  refused('', 'empty');
  refused(42, 'not text');
  for (const k of REQUIRED_KEYS) {
    const lines = fixture.split('\n'); const i = lines.findIndex((l) => l.startsWith(`${k}:`));
    assert.ok(i >= 0, k);
    let j = i + 1; while (j < lines.length && (lines[j].startsWith(' ') || lines[j] === '')) j++;
    refused([...lines.slice(0, i), ...lines.slice(j)].join('\n'), `missing ${k}`);
  }
});

test('wrong shapes and out-of-range numbers are corrupt', () => {
  refused(swap('  editing_per_mac: 5', '  editing_per_mac: -1'), 'negative cap');
  refused(swap('  editing_per_mac: 5', '  editing_per_mac: five'), 'word cap');
  refused(swap('      week: 70', '      week: 170'), 'percent over 100');
  refused(swap('  no_tier1_prod_above: 90', '  no_tier1_prod_above: 101'), 'percent over 100');
  refused(swap('      tier: 2\n', '      tier: 3\n'), 'tier 3');
  refused(swap('  stuck: retry', '  stuck: shrug'), 'unknown failure action');
  refused(swap('  tier1_hours: 07:00-22:00', '  tier1_hours: 7am-10pm'), 'bad hours');
  refused(swap('    tz: America/New_York', '    tz: Mars/Olympus'), 'bad zone');
  refused(swap('    github_id: 1000001', '    github_id: someone'), 'id not a number');
});

test('risky_acts must be exactly the fixed list', () => {
  refused(swap('deletes, first_customer_visible', 'first_customer_visible'), 'one missing');
  refused(swap('unclassifiable]', 'unclassifiable, extra]'), 'one extra');
  refused(swap('unclassifiable]', 'unclassifiable, schema]'), 'a duplicate');
});

test('the Claude Code pin must be at least 2.1.295', () => {
  refused(swap('  pin: 2.1.300', '  pin: 2.1.294'), 'old pin');
  refused(swap('  pin: 2.1.300', '  pin: latest'), 'not a version');
  assert.ok(parsePolicy(swap('  pin: 2.1.300', '  pin: 2.1.295')).ok);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
});

test('every state that is not final needs a time limit or a reason (MAT-12)', () => {
  refused(swap('    claimed:\n      minutes: 30\n      then: ready\n', ''), 'missing row');
  refused(swap('    claimed:\n      minutes: 30', '    claimed:\n      minutes: 0'), 'zero minutes');
  refused(swap('      no_limit_reason: every wait carries its own next_check', '      no_limit_reason: ""'), 'empty reason');
  refused(swap('    claimed:\n      minutes: 30\n      then: ready', '    claimed:\n      minutes: 30'), 'no then');
  refused(swap('timeouts:\n', 'timeouts:\n  widget:\n    open:\n      minutes: 5\n      then: joe\n'), 'unknown entity');
  assert.ok(parsePolicy(swap('      no_limit_reason: every wait carries its own next_check',
    '      no_limit_reason: every wait carries its own next_check\n      recheck_max_min: 60')).ok);
});

test('a bad path pattern makes the file corrupt rather than matching nothing', () => {
  refused(swap('    - docs/research/**', "    - 'docs/{a,b'"), 'unclosed brace');
});

test('the cutover stage is first or second, and a missing one reads as first', () => {
  assert.equal(parsePolicy(fixture.replace('cutover_stage: first', 'cutover_stage: second')).policy.product.cutover_stage, 'second');
  refused(fixture.replace('cutover_stage: first', 'cutover_stage: third'), 'stage');
  assert.equal(parsePolicy(fixture.replace('product:\n  cutover_stage: first\n', '')).policy.product.cutover_stage, 'first');
});

test('docs_paths defaults to docs/** and can only narrow inside docs/ (R3-m5)', () => {
  assert.deepEqual([...parsePolicy(fixture).policy.docs_paths], ['docs/**']);
  assert.ok(parsePolicy(`${fixture}\ndocs_paths: [docs/notes/**]\n`).ok);
  assert.ok(parsePolicy(`${fixture}\ndocs_paths: [docs/notes/]\n`).ok, 'a folder inside docs/ is anchored');
  for (const wide of ['"**"', 'package.json', '"**/docs/**"', 'app/**', '"docs*/**"', '"{docs,app}/**"', '"docs/../app/**"', '"docs/x/../../app/**"', '"docs/{a,..}/**"', '"docs/./x/**"', '"docs//x/**"', '[]',
    "'docs/ '", '"docs/\\t"', '"docs/\\u00a0"', '"docs/\\u3000"', '"docs/"', "' docs/research/**'", '"docs/rés/**"']) {
    const text = wide === '[]' ? `${fixture}\ndocs_paths: []\n` : `${fixture}\ndocs_paths: [${wide}]\n`;
    assert.equal(parsePolicy(text).ok, false, wide);
  }
});

test('one key table: every top-level key in the fixture is listed in KEYS', () => {
  for (const line of fixture.split('\n')) {
    const m = /^([a-z_]+):/.exec(line);
    if (m) assert.ok(KEYS[m[1]], m[1]);
  }
});

test('fixture patterns that start with * or hold {…} are quoted (yaml-lite would refuse them bare)', () => {
  for (const line of fixture.split('\n')) {
    const m = /^\s*-\s+(.*)$/.exec(line) ?? /^\s*pattern:\s+(.*)$/.exec(line);
    if (m && (m[1].startsWith('*') || m[1].includes('{'))) assert.match(m[1], /^['"]/, line);
  }
});

test('every effect_paths field is a list of readable patterns; a single value or a map is corrupt (audit round 4)', () => {
  const text = readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8');
  for (const [from, to] of [['repair_folder: [db/repairs/]', 'repair_folder: "{bad"'], ['flag_files: [lib/flags.ts]', 'flag_files: ""'],
    ['migration_paths: [db/migrations/]', 'migration_paths:\n      a: b']]) {
    assert.ok(text.includes(from), from);
    assert.equal(parsePolicy(text.replace(from, to)).ok, false, to);
  }
});

test('every pattern list refuses a space at either end or a non-ASCII letter (audit round 5)', () => {
  for (const [from, to] of [['flag_files: [lib/flags.ts]', "flag_files: ['lib/flags.ts ']"], ['repair_folder: [db/repairs/]', "repair_folder: [' db/repairs/']"],
    ['sender_paths: [lib/mail/, lib/alerts/]', 'sender_paths: [lib/mail/, "lib/alérts/"]']]) {
    assert.ok(fixture.includes(from), from);
    assert.match(parsePolicy(fixture.replace(from, to)).reason, /plain ASCII/, to);
  }
});

test('a misspelt effect_paths field is refused, not ignored (audit round 5)', () => {
  for (const [from, to] of [['    files: [next.config.*', '    file: [next.config.*'], ['    migration_paths:', '    migration_path:']]) {
    assert.ok(fixture.includes(from), from);
    assert.match(parsePolicy(fixture.replace(from, to)).reason, /not a known field/, to);
  }
});

test('a pattern with a . or .. part is refused in every list, since it can never match (audit round 5)', () => {
  for (const [from, to] of [['flag_files: [lib/flags.ts]', 'flag_files: [./lib/flags.ts]'], ['repair_folder: [db/repairs/]', 'repair_folder: [db/../repairs/]'],
    ['    - docs/research/**', "    - 'docs/{a,.}/**'"]]) {
    assert.ok(fixture.includes(from), from);
    assert.match(parsePolicy(fixture.replace(from, to)).reason, /\. or \.\. part/, to);
  }
  assert.ok(parsePolicy(fixture.replace('flag_files: [lib/flags.ts]', 'flag_files: [.prettierrc, lib/.flags.ts]')).ok, 'a name that starts with a dot is fine');
});

test('the database folders can\'t be left out or empty, and the hours end at 24:00 at the latest (audit round 7)', () => {
  for (const [from, to] of [['repair_folder: [db/repairs/]', 'repair_folder: []'], ['migration_paths: [db/migrations/]', 'migration_paths: []']]) {
    assert.ok(fixture.includes(from), from);
    assert.match(parsePolicy(fixture.replace(from, to)).reason, /at least one folder/, to);
  }
  // Leaving the field out entirely can't be written: the rules format has no empty map, and a missing key is refused.
  refused(swap('  tier1_hours: 07:00-22:00', '  tier1_hours: 07:00-24:30'), 'past midnight');
  assert.ok(parsePolicy(swap('  tier1_hours: 07:00-22:00', '  tier1_hours: 07:00-24:00')).ok);
});

// S4 (L220, L226): every state's two rules are read against the one list of each. The lists are policy.mjs's own, so a
// value added to one is in this test at once.
const RULE_KEYS = [['start', START_RULES], ['tier1_merge', TIER1_MERGE_RULES]];
const withRule = (state, key, value) => {
  const line = new RegExp(`(\\n  ${state}:\\n(?:    .*\\n)*?    ${key}:) .*`);
  assert.match(fixture, line, `${state}.${key} is in the fixture`);
  return fixture.replace(line, `$1 ${value}`);
};

test('S4: every known start and tier1_merge value reads, in every state', () => {
  for (const state of PRODUCT_STATES) for (const [key, known] of RULE_KEYS) for (const value of known) {
    const r = parsePolicy(withRule(state, key, value));
    assert.equal(r.ok, true, `${state}.${key}: ${value}: ${r.reason}`);
    assert.equal(r.policy.product_state_rules[state][key], value);
  }
});

test('S4: an unknown start or tier1_merge value fails the whole read and names the key', () => {
  for (const state of PRODUCT_STATES) for (const [key, known] of RULE_KEYS) {
    for (const value of ['sometimes', known[0].toUpperCase(), `${known[0]}x`, `[${known[0]}]`, '"undo-only"', `"${known[0]} "`, `" ${known[0]}"`]) {
      const r = parsePolicy(withRule(state, key, value));
      assert.equal(r.ok, false, `${state}.${key}: ${value}`);
      assert.match(r.reason, new RegExp(`product_state_rules\\.${state}\\.${key} must be one of ${known.join(', ')}`), value);
    }
  }
});

test('S4: a value of the other key is not taken: the two lists are read apart', () => {
  assert.match(parsePolicy(withRule('active', 'start', 'undo_only')).reason, /product_state_rules\.active\.start must be one of/);
  assert.match(parsePolicy(withRule('active', 'tier1_merge', 'none')).reason, /product_state_rules\.active\.tier1_merge must be one of/);
});

test('S4: the two lists hold exactly these values: a widened list fails here (L562 m1)', () => {
  assert.deepEqual([...START_RULES], ['within_caps', 'editing_cap_1', 'none']);
  assert.deepEqual([...TIER1_MERGE_RULES], ['rules', 'tier1_hours_only', 'undo_only']);
});

// Each way of leaving a state's rule without a value. A misspelt key is the rule being absent.
const withoutRule = (state, key) => {
  const line = new RegExp(`(\\n  ${state}:\\n(?:    .*\\n)*?)    ${key}: .*\\n`);
  const named = new RegExp(`(\\n  ${state}:\\n(?:    .*\\n)*?    )${key}:`);
  return [fixture.replace(line, '$1'), withRule(state, key, '~'), withRule(state, key, 'null'), withRule(state, key, ''), fixture.replace(named, `$1${key.replace('_', '')}:`)];
};

test('L562 M1: a tier1_merge with no value fails the whole read and names the key, in every state', () => {
  for (const state of PRODUCT_STATES) for (const text of withoutRule(state, 'tier1_merge')) {
    assert.notEqual(text, fixture);
    const r = parsePolicy(text);
    assert.equal(r.ok, false, state);
    assert.match(r.reason, new RegExp(`product_state_rules\\.${state}\\.tier1_merge must be one of ${TIER1_MERGE_RULES.join(', ')}`));
  }
});

test('L562: a start with no value still passes this read: the fit check names it (M9\'s keys)', () => {
  for (const state of PRODUCT_STATES) for (const text of withoutRule(state, 'start')) assert.equal(parsePolicy(text).ok, true, state);
});

