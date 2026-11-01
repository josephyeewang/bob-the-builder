// rules-typed-reads.test.mjs — every number and flag a module reads from the rules goes through rules.num(),
// rules.dec() or rules.flag() (lead calls L96, L104). Run: node --test orchestrate/test/rules-typed-reads.test.mjs
//
// The scan (rules-typed-reads.mjs) runs over every module file outside M10, which owns the reader and the engine.
// Test files and test helpers are left out: a test may check what get() hands back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typedReadProblems } from './rules-typed-reads.mjs';
import { existsSync } from 'node:fs';
import { rulesWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
// A per-product key is read with its product, as with the real rules (L110).
const P = { product: 'app' };
import { fakeRules, OLD_VALUES_UNTIL_STEP_2 } from '../shared/rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ORCH = join(here, '..');

// The reads found when the guard landed, each swept onto num()/flag() in L96 step 2 by the lane named. The count is
// exact: one more fails (a new old-style read), one fewer fails too, so this list is cut as each sweep lands and is
// empty when step 2 is done.
// Counts are lines: a read checked and then compared on the next line counts twice (L104 widened the scan).
export const NOT_YET_SWEPT = Object.freeze({
  'modules/M2-approvals/kinds.mjs': { count: 1, lane: 1, what: 'accounts.joe.github_id (through rules?.get?.)' },
  'modules/M4-workshop/git/push.mjs': { count: 1, lane: 1, what: 'product.onboarded !== true' },
  'modules/M9-record/ready.mjs': { count: 2, lane: 1, what: 'caps.rounds (checked, then compared)' },
  'modules/M9-record/writer.mjs': { count: 5, lane: 1, what: 'caps.rounds (2), claims.stuck_min (2), proposals.heartbeat_stale_min' },
  'modules/M11-dispatcher/gate.mjs': { count: 1, lane: 2, what: 'caps.per_state.<state>' },
  'modules/M11-dispatcher/keys.mjs': { count: 2, lane: 2, what: "need()'s number and boolean types" },
});

const skip = (r) => !r.endsWith('.mjs') || r.endsWith('.test.mjs') || /test-helper/.test(r)
  || r.startsWith('modules/M10-rules/') || r === 'shared/rules.mjs' || r.startsWith('test/');
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? (n === 'node_modules' || n === 'fixtures' ? [] : walk(p)) : [p];
});

export function scanOrchestrate(root = ORCH) {
  const found = {};
  for (const f of walk(root)) {
    const r = relative(root, f).split('\\').join('/');
    if (skip(r)) continue;
    const p = typedReadProblems(readFileSync(f, 'utf8'));
    if (p.length) found[r] = p;
  }
  return found;
}

test('L96 guard: no module outside M10 checks a rules value as a number or a flag, except the reads not yet swept', () => {
  const found = scanOrchestrate();
  const lines = (r) => found[r].map((p) => `  ${r}:${p.line} ${p.why}: ${p.text}`).join('\n');
  const fresh = Object.keys(found).filter((r) => !Object.hasOwn(NOT_YET_SWEPT, r));
  assert.deepEqual(fresh, [], `read numbers with rules.num() and flags with rules.flag() (L96):\n${fresh.map(lines).join('\n')}`);
  for (const [r, { count }] of Object.entries(NOT_YET_SWEPT)) {
    const n = found[r]?.length ?? 0;
    assert.ok(n <= count, `${r} has a new old-style read (${n}, listed ${count}):\n${lines(r)}`);
    assert.ok(n >= count, `${r} has ${n} old-style reads left, listed ${count}: cut NOT_YET_SWEPT to match`);
  }
});

test('L96 guard: the scan sees the shapes the old readers use', () => {
  const caught = [
    "if (!Number.isInteger(rules.get('claims.stuck_min', { product }))) no();",
    "const get = (key) => rules.get(key, { product });\nconst stuckMin = get('claims.stuck_min');\nif (!Number.isInteger(stuckMin)) no();",
    "const n = rules.get('x');\nreturn Number.isSafeInteger(n) ? n : null;",
    "let v = rules.get(key, {});\nconst ok = typeof v === 'number';",
    "const ok = Number.isFinite(rules?.get('caps.rounds'));",
    "if (rules.get('product.onboarded', { product }) !== true) no();",
    "const on = rules.get('a.b');\nif (on === true) go();",
    "if (true === rules.get('a.b')) go();",
    "const s = need(rules, KEYS.shakedown);\nif (typeof s === 'boolean') go();",
    "const g = async (k) => rules.get(k, { product });\nconst x = await g('k');\nif (x === false) stop();",
    // L104 M-2 and Minor 2: the spellings round 1 found missed.
    "const get = (k) => rules?.get?.(k, { product });\nconst id = get('accounts.joe.github_id');\nif (!Number.isSafeInteger(id)) no();",
    "const { get } = rules;\nif (Number.isInteger(get('approvals.lapse_min'))) go();",
    "const { get: read } = ctx.rules;\nconst n = read('k');\nif (n > 0) go();",
    "if (Number.isInteger(ctx.rules.get('caps.rounds'))) go();",
    "if (Number.isInteger(this.rules?.get?.('caps.rounds'))) go();",
    "const get = k => rules.get(k, { product });\nif (get('a') === true) go();",
    "function get(k) {\n  return rules.get(k, { product });\n}\nif (Number.isInteger(get('a'))) go();",
    "const read = rules.get.bind(rules);\nif (read('a') === false) stop();",
    "const n = Number(rules.get('claims.stuck_min'));",
    "const n = parseInt(rules.get('claims.stuck_min'), 10);",
    "const n = +rules.get('claims.stuck_min');",
    "const v = rules.get('k');\nif (v > 0) go();",
    "if (rules.get('k') >= 1) go();",
    "if (rules.get('product.live') === 'true') go();",
    "const v = rules.get('k');\nif (Number.isNaN(v)) no();",
    "const v = rules.get('k');\nif (!isFinite(v)) no();",
    "/* a block comment\n   over two lines */ if (Number.isInteger(rules.get('k'))) go();",
  ];
  for (const src of caught) assert.ok(typedReadProblems(src).length > 0, `not caught:\n${src}`);
  const fine = [
    "if (!Number.isInteger(rules.num('claims.stuck_min', { product }))) no();",
    "const stuckMin = rules.num('claims.stuck_min', { product });\nif (stuckMin === undefined) no();",
    "if (rules.flag('product.onboarded', { product }) !== true) no();",
    "const stage = rules.get('product.cutover_stage') === 'second';",
    "const list = rules.get('usage.red_runs');\nif (!Array.isArray(list)) no();",
    "// if (Number.isInteger(rules.get('x'))) — a comment",
    "const e = tx.get(entity, id);\nif (e === true) x();",
    "const cap = need(rules, KEYS.editingPerMac);\nif (running >= cap) no();",
    "const n = rules.dec('usage.pace_min_share');\nif (n > 0.5) go();",
    "/* if (Number.isInteger(rules.get('x'))) */ const a = 1;",
    "const myrules = 1; const v = notrules.get('k');\nif (v > 0) go();",
  ];
  for (const src of fine) assert.deepEqual(typedReadProblems(src), [], `caught by mistake:\n${src}`);
});

test('L96 plant: an old-style reader handed the "30" the rules file really holds refuses it; num() reads it', () => {
  // What the real reader hands back for `claims.stuck_min: 30` (M10 typed-reads.test.mjs builds it from the text).
  const rules = fakeRules({ values: { 'claims.stuck_min': '30' } });
  const oldStyle = (rules) => { const v = rules.get('claims.stuck_min', P); return Number.isInteger(v) && v >= 1 ? v : null; };
  assert.equal(oldStyle(rules), null, 'the bug L96 found');
  assert.ok(typedReadProblems(oldStyle.toString()).length > 0, 'and the guard catches its source');
  assert.equal(rules.num('claims.stuck_min', P), 30);
  assert.equal(fakeRules({ values: { k: '3x' } }).num('k', P), undefined, "num('3x') is missing");
});

test('L104: fakeRules hands every value back as the reader\'s text, so a test that passes 30 sees "30"', () => {
  const rules = fakeRules({ values: { n: 30, f: false, d: 0.5, list: [1, 'a', true], map: { a: 2, b: { c: false } }, t: 'x' } });
  assert.equal(rules.get('n', P), '30');
  assert.equal(rules.get('f', P), 'false');
  assert.deepEqual(rules.get('list', P), ['1', 'a', 'true']);
  assert.deepEqual(rules.get('map', P), { a: '2', b: { c: 'false' } });
  assert.equal(rules.get('t', P), 'x');
  assert.equal(rules.get('missing', P), undefined);
  assert.equal(rules.num('n', P), 30);
  assert.equal(rules.flag('f', P), false);
  assert.equal(rules.dec('d', P), 0.5);
  // The fail-open the round found (P13): a truthiness check of a flag reads "false" as on. It now fails in the test too.
  assert.equal(Boolean(rules.get('f', P)), true);
  assert.equal(rules.flag('f', P), false);
});

test('L104: the files still handed old values are named, exist, and belong to a lane; the list only shrinks', () => {
  const names = Object.keys(OLD_VALUES_UNTIL_STEP_2);
  for (const f of names) {
    assert.ok(existsSync(join(ORCH, f)), `${f} is on the old-values list but is gone: take it off`);
    assert.ok(/\.test(?:-helper)?\.mjs$/.test(f), `${f} is a test file or a test helper`);
    assert.ok([1, 2].includes(OLD_VALUES_UNTIL_STEP_2[f]), `${f} names its lane`);
  }
  // Pinned at the ruling's count (26 files: 16 lane 1, 10 lane 2). Step 2 takes files off; nothing is added.
  assert.ok(names.length <= 26, `the old-values list grew to ${names.length}`);
  // This file is not on it, so its fakes hand text back (the test above).
  assert.equal(fakeRules({ values: { n: 30 } }).get('n', P), '30');
});

test('L104: a listed helper hands old values only in a child process; called from a test not on the list, it hands text', () => {
  assert.ok(Object.hasOwn(OLD_VALUES_UNTIL_STEP_2, 'modules/M11-dispatcher/fixtures.test-helper.mjs'));
  assert.equal(rulesWith({ 'claims.stuck_min': 30 }).get('claims.stuck_min', P), '30');
});

test('L110: as the engine, fakeRules answers a per-product key only with a product; a Mac-wide key needs none', () => {
  const rules = fakeRules({ values: { 'caps.rounds': 3, 'caps.editing_per_mac': 5, 'usage.red_runs': ['undos'] } });
  assert.equal(rules.num('caps.rounds'), undefined, 'no product: missing');
  assert.equal(rules.num('caps.rounds', { product: null }), undefined);
  assert.equal(rules.num('caps.rounds', P), 3);
  assert.equal(rules.num('caps.editing_per_mac'), 5, 'a Mac-wide number');
  assert.deepEqual(rules.get('usage.red_runs'), ['undos'], 'a Mac-wide list');
});
