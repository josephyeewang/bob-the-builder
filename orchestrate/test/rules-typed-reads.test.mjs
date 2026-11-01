// rules-typed-reads.test.mjs — every number and flag a module reads from the rules goes through rules.num() or
// rules.flag() (lead call L96). Run: node --test orchestrate/test/rules-typed-reads.test.mjs
//
// The scan (rules-typed-reads.mjs) runs over every module file outside M10, which owns the reader and the engine.
// Test files and test helpers are left out: a test may check what get() hands back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typedReadProblems } from './rules-typed-reads.mjs';
import { fakeRules } from '../shared/rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ORCH = join(here, '..');

// The reads found when the guard landed, each swept onto num()/flag() in L96 step 2 by the lane named. The count is
// exact: one more fails (a new old-style read), one fewer fails too, so this list is cut as each sweep lands and is
// empty when step 2 is done.
export const NOT_YET_SWEPT = Object.freeze({
  'modules/M4-workshop/git/push.mjs': { count: 1, lane: 1, what: 'product.onboarded !== true' },
  'modules/M9-record/ready.mjs': { count: 1, lane: 1, what: 'caps.rounds' },
  'modules/M9-record/writer.mjs': { count: 3, lane: 1, what: 'caps.rounds, claims.stuck_min, proposals.heartbeat_stale_min' },
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
  ];
  for (const src of fine) assert.deepEqual(typedReadProblems(src), [], `caught by mistake:\n${src}`);
});

test('L96 plant: an old-style reader handed the "30" the rules file really holds refuses it; num() reads it', () => {
  // What the real reader hands back for `claims.stuck_min: 30` (M10 typed-reads.test.mjs builds it from the text).
  const rules = fakeRules({ values: { 'claims.stuck_min': '30' } });
  const oldStyle = (rules) => { const v = rules.get('claims.stuck_min'); return Number.isInteger(v) && v >= 1 ? v : null; };
  assert.equal(oldStyle(rules), null, 'the bug L96 found');
  assert.ok(typedReadProblems(oldStyle.toString()).length > 0, 'and the guard catches its source');
  assert.equal(rules.num('claims.stuck_min'), 30);
  assert.equal(fakeRules({ values: { k: '3x' } }).num('k'), undefined, "num('3x') is missing");
});
