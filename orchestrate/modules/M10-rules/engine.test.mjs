// engine.test.mjs — M10's answers (R-0b-15, R-0b-17, R-0b-18; spec review 0b-1 MAT-5, MAT-8, MAT-10, MAT-11, MIN-1,
// MIN-8, R2-M5, R2-M8, R2-m3, R2-m7, R3-M3, R3-m5, R3-m9, R3-c2). Run: node --test orchestrate/modules/M10-rules/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules, HOLD_REASONS } from '../../shared/rules.mjs';
import { makeEngine } from './engine.mjs';
import { parsePolicy } from './policy.mjs';
import { MAX_FILES } from './classify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const C = 'c'.repeat(40); const B = 'b'.repeat(40); const R = 'a'.repeat(40);
const pol = (edit = (t) => t) => { const r = parsePolicy(edit(FIXTURE)); assert.ok(r.ok, r.reason); return r.policy; };
const set = (key, from, to) => (t) => { assert.ok(t.includes(from), `fixture has ${from}`); return t.replace(from, to); };

// 10:00 and 03:00 New York time on an ordinary day (EDT, UTC-4).
const AT_10 = Date.parse('2026-10-14T14:00:00Z');
const AT_03 = Date.parse('2026-10-14T07:00:00Z');

function world({ policies = { app: pol() }, states = {}, run = {}, now = AT_10 } = {}) {
  const products = Object.keys(policies);
  const reader = Object.fromEntries(products.map((p) => [p, policies[p] === null
    ? { status: 'deny_all', policy: null }
    : { status: 'ok', policy: policies[p], commit: C, blob: B }]));
  const w = { reader, states: { ...Object.fromEntries(products.map((p) => [p, { state: 'active' }])), ...states }, run: { mac: 0, ...run }, now };
  w.rules = makeRules(makeEngine({
    products,
    rulesState: (p) => w.reader[p],
    productState: (p) => w.states[p] ?? null,
    running: ({ product }) => (product ? (w.run[product] ?? 0) : w.run.mac),
    rolesDir: join(here, 'roles'),
    clock: () => w.now,
  }));
  return w;
}

const fresh = (w) => ({ read_at: new Date(w.now - 60_000).toISOString() });
const start = (w, extra = {}) => w.rules.may('start_session', { product: 'app', role: 'worker', tier: 2, editing: true, ...extra });
const file = (path, status = 'modified', extra = {}) => ({ path, status, ...extra });

test('rules unreadable → every answer is deny; get() is undefined (MAT-5, R2-m3)', () => {
  const w = world({ policies: { app: null } });
  for (const a of ['start_session', 'push_branch', 'merge']) assert.equal(w.rules.may(a, { product: 'app' }).decision, 'deny', a);
  assert.equal(w.rules.get('caps.rounds', { product: 'app' }), undefined);
  // A caller that sizes from get() with no rules must refuse, never treat undefined as "no limit".
  const cap = w.rules.get('caps.editing_per_mac');
  const callerAllows = typeof cap === 'number' && 0 < cap;
  assert.equal(callerAllows, false);
  assert.deepEqual(w.rules.classify({ product: 'app', files: [file('docs/research/x.md')], declared_tier: 2 }).risky, ['unclassifiable']);
});

test('an unknown product, or a missing or unknown product state (read as paused)', () => {
  const w = world();
  assert.equal(start(w, { product: 'other' }).decision, 'deny');
  w.states.app = null;
  assert.match(start(w).reason, /paused/);
  w.states.app = { state: 'sleeping' };
  assert.match(start(w).reason, /paused/);
});

test('start_session: roles (MAT-11)', () => {
  const w = world();
  assert.equal(start(w).decision, 'allow');
  assert.equal(start(w, { role: 'auditor' }).decision, 'allow');
  for (const role of ['explore', 'learning', 'nobody']) assert.equal(start(w, { role }).decision, 'deny', role);
  assert.match(start(w, { role: 'script' }).reason, /script profile is off/);
  const on = world({ policies: { app: pol(set('', 'script: none', 'script: 2.1.300')) } });
  assert.equal(start(on, { role: 'script' }).decision, 'allow');
  const pinMoved = world({ policies: { app: pol((t) => set('', 'script: none', 'script: 2.1.300')(t).replace('pin: 2.1.300', 'pin: 2.1.301')) } });
  assert.equal(start(pinMoved, { role: 'script' }).decision, 'deny', 'a pin change switches script off (and the tool list expires)');
  assert.equal(start(w, { tier: 3 }).decision, 'deny');
  assert.equal(start(w, { editing: 'yes' }).decision, 'deny');
});

test('start_session: product states (MAT-8)', () => {
  const w = world();
  w.states.app = { state: 'paused' };
  assert.equal(start(w, { role: 'incident', editing: false }).decision, 'deny', 'paused: no starts, incident included');
  w.states.app = { state: 'away' };
  assert.equal(start(w).decision, 'allow');
  assert.equal(start(w, { tier: 1, usage: fresh(w) }).decision, 'allow', 'away: Tier 1 work continues');
  w.states.app = { state: 'light' };
  w.run.app = 1;
  assert.match(start(w).reason, /editing cap reached for app \(1\)/);
  assert.equal(start(w, { editing: false }).decision, 'allow');
  assert.equal(start(w, { editing: false, tier: 1 }).decision, 'deny', 'light: A8 still holds for Tier 1');
});

test('the file\'s state rules can only tighten (MAT-8)', () => {
  const loose = world({ policies: { app: pol(set('', 'start: none', 'start: within_caps')) } });
  loose.states.app = { state: 'paused' };
  assert.equal(start(loose).decision, 'deny', 'a file saying paused may start is ignored');
  const tight = world({ policies: { app: pol(set('', 'away:\n    start: within_caps', 'away:\n    start: none')) } });
  tight.states.app = { state: 'away' };
  assert.equal(start(tight).decision, 'deny');
  const odd = world({ policies: { app: pol(set('', 'start: editing_cap_1', 'start: whenever')) } });
  odd.states.app = { state: 'light' };
  assert.match(start(odd).reason, /not a known rule/);
});

test('start_session: caps per product and per Mac, and 0 (MAT-5)', () => {
  const w = world({ run: { app: 2, mac: 4 } });
  assert.equal(start(w).decision, 'allow');
  w.run.app = 3;
  assert.match(start(w).reason, /cap reached for app/);
  w.run.app = 0; w.run.mac = 5;
  assert.match(start(w).reason, /cap reached on this Mac/);
  assert.equal(start(w, { editing: false }).decision, 'allow', 'read-only starts are not editing-capped');
  const zero = world({ policies: { app: pol(set('', 'editing_per_product: 3', 'editing_per_product: 0')) } });
  assert.match(start(zero).reason, /is 0/);
  const broken = world();
  broken.run.app = Number.NaN;
  assert.equal(start(broken).decision, 'deny', 'an unknown running count is a deny');
});

test('start_session: Tier 1 needs a fresh usage reading (A8)', () => {
  const w = world();
  assert.match(start(w, { tier: 1 }).reason, /usage reading/);
  assert.equal(start(w, { tier: 1, usage: fresh(w) }).decision, 'allow');
  assert.match(start(w, { tier: 1, usage: { read_at: new Date(w.now - 16 * 60_000).toISOString() } }).reason, /stale/);
  assert.match(start(w, { tier: 1, usage: { read_at: new Date(w.now + 5 * 60_000).toISOString() } }).reason, /stale/);
  assert.equal(start(w, { tier: 2 }).decision, 'allow', 'Tier 2 needs no reading');
  w.now = NaN;
  assert.match(start(w, { tier: 1, usage: { read_at: '2000-01-01T00:00:00Z' } }).reason, /clock/, 'a broken clock never lets Tier 1 start (audit round 2)');
});

test('Mac-wide values take the strictest product (MAT-10, R-0b-18)', () => {
  const a = pol();
  const b = pol((t) => t.replace('editing_per_mac: 5', 'editing_per_mac: 3').replace('until_phase_2: 55', 'until_phase_2: 15')
    .replace('stale_after_min: 15', 'stale_after_min: 20').replace('required_minimum: 2.1.295', 'required_minimum: 2.1.299'));
  const w = world({ policies: { app: a, other: b } });
  assert.equal(w.rules.get('caps.editing_per_mac'), 3);
  assert.equal(w.rules.get('usage.reserve_pct.until_phase_2'), 55);
  assert.equal(w.rules.get('usage.stale_after_min'), 15);
  assert.equal(w.rules.get('claude_code.required_minimum'), '2.1.299');
  assert.equal(w.rules.get('caps.editing_per_product', { product: 'other' }), 3, 'per-product keys stay per product');
  w.run.mac = 3;
  assert.match(start(w).reason, /cap reached on this Mac \(3\)/);
});

test('must-match values: a pin, model, account or home-zone mismatch stops every start (MAT-10, R2-M5(b))', () => {
  for (const [from, to, why] of [['pin: 2.1.300', 'pin: 2.1.301', /pin mismatch/], ['main: claude-opus-5-5', 'main: other-model', /models.main mismatch/],
    ['current: sample-org', 'current: other-org', /accounts.current mismatch/], ['tz: America/New_York', 'tz: Europe/London', /accounts.joe.tz mismatch/]]) {
    const w = world({ policies: { app: pol(), other: pol(set('', from, to)) } });
    assert.match(start(w).reason, why);
    assert.match(w.rules.may('start_session', { product: 'other', role: 'scout', tier: 2, editing: false }).reason, why);
    assert.equal(w.rules.get('caps.editing_per_mac'), undefined);
  }
});

test('one product with no usable rules stops every start on the Mac (MAT-10)', () => {
  const w = world({ policies: { app: pol(), other: null } });
  assert.match(start(w).reason, /rules unusable for other/);
  assert.equal(w.rules.get('caps.editing_per_mac'), undefined);
  assert.equal(w.rules.get('caps.rounds', { product: 'app' }), 3, 'a per-product value of a healthy product still reads');
});

test('push_branch: lanes (MIN-1, R2-m7, R3-m5)', () => {
  const w = world();
  const push = (lane, files, card = {}) => w.rules.may('push_branch', { product: 'app', card: { id: 'C-1', rows: ['R-1'], doc: { lane }, ...card }, files });
  assert.equal(push('product', [file('app/page.tsx'), file('docs/research/x.md')]).decision, 'allow');
  assert.match(push('product', [file('docs/blueprint/rows/R-1.yaml')]).reason, /out of lane/);
  assert.match(push('product', [file('docs/notes.md')]).reason, /out of lane/);
  assert.equal(push('docs', [file('docs/notes.md'), file('docs/domains/a/b.md'), file('docs/research/x.md')]).decision, 'allow');
  assert.equal(push('docs', [file('app/x.ts')]).decision, 'deny');
  assert.equal(push('lead', [file('docs/blueprint/rows/R-1.yaml'), file('docs/blueprint/rows/R-1.yaml', 'added')]).decision, 'allow');
  assert.match(push('lead', [file('docs/blueprint/rows/R-2.yaml')]).reason, /out of lane/, 'another card\'s row file');
  assert.equal(push('lead', [file('docs/blueprint/rows/R-1.yaml', 'removed')]).decision, 'deny', 'removing its own row is out of lane');
  assert.equal(push('lead', [file('docs/blueprint/rows/R-1.yaml', 'renamed', { previous_path: 'docs/blueprint/rows/R-1x.yaml' })]).decision, 'deny');
  assert.equal(push('lead', [file('docs/blueprint/BLUEPRINT.md')]).decision, 'deny');
  assert.equal(push('lead', [file('docs/blueprint/BLUEPRINT.md')], { kind: 'lead_daily_card' }).decision, 'allow');
  assert.equal(push('lead', [file('app/x.ts')], { kind: 'lead_daily_card' }).decision, 'deny');
  for (const p of ['docs/blueprint/ROWS/R-9.yaml', 'docs/blueprint/Rows/R-9.yaml']) {   // a case variant is still a row file (audit round 7)
    assert.equal(push('lead', [file(p, 'removed')], { kind: 'lead_daily_card' }).decision, 'deny', `${p} removed`);
    assert.equal(push('lead', [file(p)], { kind: 'lead_daily_card' }).decision, 'deny', `${p} of another card`);
  }
  for (const card of [undefined, { doc: { lane: 'docs' } }, { id: '', doc: { lane: 'docs' } }, { id: 7, doc: { lane: 'docs' } }]) {   // MAT-5: a missing card id is a deny (audit round 7)
    assert.equal(w.rules.may('push_branch', { product: 'app', card, files: [file('docs/research/x.md')] }).decision, 'deny', JSON.stringify(card));
  }
  assert.match(push(undefined, [file('app/x.ts')]).reason, /no lane/, 'a missing lane is a deny');
  assert.match(push(undefined, [file('docs/blueprint/rows/R-1.yaml')]).reason, /no lane/, 'a missing lane never falls back to lead');
  assert.equal(push('research', [file('docs/research/x.md')]).decision, 'deny', 'only the three lanes exist');
  assert.equal(push('product', [file('app/x.ts', 'renamed', { previous_path: 'docs/notes.md' })]).decision, 'deny', 'the old path counts');
  assert.equal(push('product', [file('../x.ts')]).decision, 'deny');
  assert.match(push('product', [file('doc\u017f/blueprint/x.md')]).reason, /non-ASCII/, 'a look-alike of docs/ is not outside the docs lane');
  assert.equal(push('product', []).decision, 'deny');
  const narrow = world({ policies: { app: pol(set('', '\nproduct:', '\ndocs_paths: [docs/research/**]\nproduct:')) } });
  const r = narrow.rules.may('push_branch', { product: 'app', card: { id: 'C', rows: [], doc: { lane: 'docs' } }, files: [file('docs/notes.md')] });
  assert.equal(r.decision, 'deny', 'the docs lane must lie inside docs_paths');
});

test('push_branch while paused: only an exact reverse of the reversed commit\'s own files (R2-M8)', () => {
  const w = world({ states: { app: { state: 'paused' } } });
  const card = { id: 'C-9', rows: [], kind: 'exact_reverse', doc: { lane: 'product' } };
  assert.equal(w.rules.may('push_branch', { product: 'app', card, reverses_files: ['app/a.ts', 'db/migrations/1.sql'], files: [file('app/a.ts')] }).decision, 'allow');
  assert.equal(w.rules.may('push_branch', { product: 'app', card, reverses_files: ['app/a.ts'], files: [file('app/a.ts'), file('app/b.ts')] }).decision, 'deny');
  assert.equal(w.rules.may('push_branch', { product: 'app', card: { ...card, kind: 'undo' }, reverses_files: ['app/a.ts'], files: [file('app/a.ts')] }).decision, 'deny');
  assert.equal(w.rules.may('push_branch', { product: 'app', card: { ...card, kind: undefined }, files: [file('app/a.ts')] }).decision, 'deny');
  // The old name of a rename counts too (audit round 2): renaming a workflow into a listed path is not a reverse.
  assert.match(w.rules.may('push_branch', { product: 'app', card, reverses_files: ['app/a.ts'], files: [file('app/a.ts', 'renamed', { previous_path: '.github/workflows/deploy.yml' })] }).reason, /paused/);
  assert.equal(w.rules.may('push_branch', { product: 'app', card, reverses_files: ['app/a.ts', 'app/old.ts'], files: [file('app/a.ts', 'renamed', { previous_path: 'app/old.ts' })] }).decision, 'allow');
});

test('a rename or copy with no old name is refused by push and merge (audit round 2, MAT-7)', () => {
  const w = world();
  const bare = [file('docs/research/a.md', 'renamed')];
  assert.equal(w.rules.may('push_branch', { product: 'app', card: { id: 'C-1', rows: [], doc: { lane: 'docs' } }, files: bare }).decision, 'deny');
  assert.match(mergeOf(w, bare).reason, /no old name/);
  assert.equal(mergeOf(w, bare).decision, 'deny');
  assert.equal(mergeOf(w, [file('docs/research/a.md', 'copied')]).decision, 'deny');
});

const mergeOf = (w, files, extra = {}) => w.rules.may('merge', { product: 'app', card: { id: 'C-1' }, files, declared_tier: 2, labels: [], ...extra });

test('merge: Tier 2 plain doc allowed; risky or Tier 1 asks Joe (MAT-5)', () => {
  const w = world();
  assert.equal(mergeOf(w, [file('docs/research/x.md')]).decision, 'allow');
  assert.deepEqual([mergeOf(w, [file('docs/research/x.md')], { declared_tier: 1 }).decision, mergeOf(w, [file('docs/research/x.md')], { declared_tier: 1 }).tier], ['ask', 1]);
  assert.equal(mergeOf(w, [file('app/x.ts')]).decision, 'ask', 'unscanned code is unclassifiable');
  assert.equal(mergeOf(w, [file('orchestrate/policy.yaml')]).decision, 'ask');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], { labels: ['needs-joe'] }).decision, 'ask');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], { truncated: true }).decision, 'ask');
});

test('merge: the Tier-1 hours, in every state, with M10\'s own clock (R2-M5, R3-m9)', () => {
  const t1 = [file('docs/research/x.md')];
  const w = world({ now: AT_03 });
  const held = mergeOf(w, t1, { declared_tier: 1, now: AT_10 });
  assert.deepEqual([held.decision, held.reason], ['deny', 'held_tier1_hours'], 'active at 03:00 is held; subject.now is ignored');
  assert.ok(HOLD_REASONS.includes(held.reason));
  assert.equal(mergeOf(w, t1).decision, 'allow', 'Tier 2 is never held by the hours');
  w.now = AT_10;
  assert.equal(mergeOf(w, t1, { declared_tier: 1 }).decision, 'ask', 'active at 10:00 asks');
  w.now = Date.parse('2026-10-15T02:30:00Z');   // 22:30 New York: the window ends at 22:00
  assert.equal(mergeOf(w, t1, { declared_tier: 1 }).reason, 'held_tier1_hours');
  // Daylight saving: 07:30 UTC is 03:30 EDT in October but 02:30 EST in November; 12:30 UTC is 08:30 / 07:30 — both inside.
  w.now = Date.parse('2026-11-02T12:30:00Z');
  assert.equal(mergeOf(w, t1, { declared_tier: 1 }).decision, 'ask');
  w.now = Date.parse('2026-11-02T11:30:00Z');   // 06:30 EST (would be 07:30 EDT)
  assert.equal(mergeOf(w, t1, { declared_tier: 1 }).reason, 'held_tier1_hours', 'the zone\'s own offset on that date is used');
});

test('merge while away: the trip zone; none or invalid is held; two trips must both be inside (R2-M5, R3-c2)', () => {
  const t1 = { declared_tier: 1 };
  const docs = [file('docs/research/x.md')];
  const w = world({ policies: { app: pol(), other: pol() }, now: AT_10 });
  w.states.app = { state: 'away' };
  assert.equal(mergeOf(w, docs, t1).reason, 'held_tier1_hours', 'away with no zone is held');
  w.states.app = { state: 'away', away: { tz: 'Not/AZone' } };
  assert.equal(mergeOf(w, docs, t1).reason, 'held_tier1_hours');
  w.states.app = { state: 'away', away: { tz: 'Asia/Tokyo' } };    // 23:00 in Tokyo
  assert.equal(mergeOf(w, docs, t1).reason, 'held_tier1_hours');
  w.states.app = { state: 'away', away: { tz: 'Europe/London' } }; // 15:00 in London
  assert.equal(mergeOf(w, docs, t1).decision, 'ask');
  w.states.other = { state: 'away', away: { tz: 'Asia/Tokyo' } };
  assert.equal(mergeOf(w, docs, t1).reason, 'held_tier1_hours', 'both away zones must be inside the hours');
});

test('merge while paused: only an exact reverse (MAT-8)', () => {
  const w = world({ states: { app: { state: 'paused' } } });
  assert.match(mergeOf(w, [file('docs/research/x.md')]).reason, /paused/);
});

const reverse = (audit, extra = {}) => ({ kind: 'exact_reverse', reverses: R, exact_reverse_ok: true, reversed_audit: audit, ...extra });

test('merge: an exact reverse with a cut-off file list asks Joe, even while paused (audit round 3, MAT-6)', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  const r = mergeOf(w, [file('app/x.ts')], reverse('failure', { truncated: true }));
  assert.deepEqual([r.decision, r.tier], ['ask', 1]);
  assert.match(r.reason, /cut-off/);
  const full = Array.from({ length: MAX_FILES }, (_, i) => file(`docs/research/${i}.md`));
  assert.match(mergeOf(w, full, reverse('failure')).reason, /cut-off/, 'a list of exactly the limit may be cut off (audit round 5)');
});

test('merge: the undo of a database change asks Joe even after a failed audit, while paused at 03:00 (0b-9 M4, audit round 6)', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  for (const path of ['db/migrations/0005_add_col.sql', 'db/repairs/0007_fix.sql']) {
    const r = mergeOf(w, [{ path, status: 'removed' }], reverse('failure'));
    assert.deepEqual([r.decision, r.tier, r.reason], ['ask', 1, 'exact reverse of a database change'], path);
  }
});

test('merge: the undo of a database change found only in the text asks Joe (0b-9 M4, audit round 7)', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  const undo = (lines, extra = {}) => mergeOf(w, [file('lib/db/setup.sql', 'removed', { removed_lines: lines, added_lines: [] })], reverse('failure', extra));
  for (const line of ['CREATE TABLE users (id int);', 'create or replace function f() returns int as 1', 'CREATE TRIGGER t AFTER INSERT ON x',
    'CREATE POLICY p ON users', 'GRANT SELECT ON users TO anon', 'CREATE MATERIALIZED VIEW v AS SELECT 1', 'alter type mood add value \'x\'',
    'CREATE UNLOGGED TABLE t (a int)', 'create temp table t (a int)', 'create constraint trigger t after insert on x', 'create event trigger e on ddl_command_start',
    'create domain d as int', 'create rule r as on insert to t do nothing', 'CREATE/**/TABLE t (a int)', 'await knex.schema.createTable(\'t\', f)']) {
    assert.equal(undo([line]).reason, 'exact reverse of a database change', line);
  }
  assert.equal(undo(['export const x = 1;']).decision, 'allow', 'plain code with its removed lines still reverses');
  assert.equal(mergeOf(w, [file('lib/db/setup.sql', 'removed')], reverse('failure')).reason, 'exact reverse of code without its lines');
  assert.equal(mergeOf(w, [file('lib/a.ts', 'renamed', { previous_path: 'lib/b.ts' })], reverse('failure')).reason, 'exact reverse of code without its lines', 'a rename too');
  assert.equal(mergeOf(w, [file('docs/research/x.md', 'renamed', { previous_path: 'lib/x.ts' })], reverse('failure')).reason, 'exact reverse of code without its lines', 'a rename from code to a doc');
  assert.equal(mergeOf(w, [file('lib/a.ts', 'modified', { removed_lines: 'CREATE TABLE x' })], reverse('failure')).decision, 'ask', 'removed lines of the wrong type');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('failure')).decision, 'allow', 'a plain doc needs no lines');
});

test('merge: an undo scans both sides of a code file, renames from code included (audit round 8)', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  const m = (f) => mergeOf(w, [f], reverse('failure'));
  const back = file('docs/research/x.md', 'renamed', { previous_path: 'lib/db/setup.ts', removed_lines: ['await sql`create table users (id int)`'], added_lines: [] });
  assert.equal(m(back).reason, 'exact reverse of a database change', 'a rename from code back to a doc is still scanned');
  assert.equal(m({ ...back, removed_lines: ['drop table users;'] }).reason, 'exact reverse of a database change');
  assert.equal(m(file('lib/db/setup.ts', 'modified', { removed_lines: [] })).reason, 'exact reverse of code without its lines', 'only removed lines given');
  assert.equal(m(file('lib/db/setup.ts', 'modified', { removed_lines: [], added_lines: ['drop table users;'] })).reason, 'exact reverse of a database change', 'what the undo puts back');
  assert.equal(m(file('lib/db/setup.ts', 'removed', { removed_lines: [], added_lines: [] })).reason, 'exact reverse of code without its lines', 'a removed file with no lines');
  assert.equal(m(file('lib/db/setup.ts', 'added', { removed_lines: [], added_lines: [] })).reason, 'exact reverse of code without its lines', 'an added file with no lines');
  assert.equal(m(file('lib/a.ts', 'modified', { removed_lines: [{}], added_lines: [] })).reason, 'exact reverse that could not be fully classified', 'a line that is not text');
  assert.equal(m(file('lib/a.ts', 'modified', { removed_lines: [], added_lines: [7] })).reason, 'exact reverse that could not be fully classified');
});

test('merge: a doc-only undo that could not be fully classified asks Joe, whatever the audit (round-4 guard, audit round 8)', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  for (const extra of [{ labels: ['needs-joe'] }]) {
    assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('failure', extra)).reason, 'exact reverse that could not be fully classified', JSON.stringify(extra));
  }
  assert.equal(mergeOf(w, [file('docs/research/x.md', 'modified', { mode: '040000' })], reverse('failure')).reason, 'exact reverse that could not be fully classified', 'an unknown mode');
});

test('merge: a needs-joe:protected label on an exact reverse asks Joe (audit round 7)', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  const r = mergeOf(w, [file('docs/research/x.md')], reverse('failure', { labels: ['needs-joe:protected'] }));
  assert.deepEqual([r.decision, r.reason], ['ask', 'exact reverse touches a protected file']);
});

test('merge: the Tier-1 hours window ends at 22:00 exactly (audit round 6)', () => {
  const w = world({ now: Date.parse('2026-10-15T02:00:00Z') });   // 22:00 New York
  assert.equal(mergeOf(w, [file('app/x.ts')], { declared_tier: 1 }).reason, 'held_tier1_hours');
  w.now = Date.parse('2026-10-15T01:59:00Z');
  assert.notEqual(mergeOf(w, [file('app/x.ts')], { declared_tier: 1 }).reason, 'held_tier1_hours');
});

test('merge: an exact reverse with rules that cannot be fully read asks Joe (audit round 4, R3-M3)', () => {
  const broken = { ...pol(), effect_paths: { ...pol().effect_paths, production_data: { ...pol().effect_paths.production_data, repair_folder: '{bad' } } };
  const w = world({ policies: { app: broken }, states: { app: { state: 'paused' } }, now: AT_03 });
  const r = mergeOf(w, [file('orchestrate/policy.yaml'), file('.github/workflows/a.yml')], reverse('failure'));
  assert.deepEqual([r.decision, r.tier], ['ask', 1]);
  const label = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  const code = file('app/x.ts', 'modified', { removed_lines: ['export const x = 1;'], added_lines: [] });
  assert.equal(mergeOf(label, [file('app/x.ts')], reverse('failure', { labels: ['needs-joe'] })).decision, 'ask', 'a needs-joe label is never skipped');
  assert.equal(mergeOf(label, [code], reverse('failure')).decision, 'allow', 'unscanned code alone still reverses');
  assert.notEqual(mergeOf(label, [file('app/x.ts')], reverse('failure', { reverses: [R] })).reason, 'exact reverse of a merge whose audit failed', 'reverses must be one id');
});

test('merge: truncated or labels of the wrong type are refused, never read as "no" (audit round 3)', () => {
  const w = world();
  for (const bad of [{ truncated: 'true' }, { truncated: 1 }, { labels: 'needs-joe' }, { labels: [1] }]) {
    assert.equal(mergeOf(w, [file('docs/research/x.md')], bad).decision, 'deny', JSON.stringify(bad));
  }
  assert.equal(mergeOf(w, [file('docs/research/x.md')], { truncated: false }).decision, 'allow');
});

test('merge: the exact-reverse answer, in R3-M3\'s order', () => {
  const w = world({ states: { app: { state: 'paused' } }, now: AT_03 });
  const flaggedTier1 = mergeOf(w, [file('app/x.ts', 'modified', { removed_lines: ['export const x = 1;'], added_lines: [] })], { declared_tier: 1, ...reverse('failure') });
  assert.equal(flaggedTier1.decision, 'allow', 'reverse of a flagged Tier-1 merge, paused, 03:00');
  assert.deepEqual([mergeOf(w, [file('db/migrations/1.sql')], reverse('success')).decision, mergeOf(w, [file('db/migrations/1.sql')], reverse('success')).tier], ['ask', 1], 'risky reverse whose audit passed');
  assert.equal(mergeOf(w, [file('orchestrate/policy.yaml')], reverse('failure')).decision, 'ask', 'a protected reverse always asks');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('none')).decision, 'allow', 'ordinary reverse');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('failure', { exact_reverse_ok: undefined })).decision, 'deny', 'not proven exact: ordinary change, paused → deny');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('failure', { kind: 'undo' })).decision, 'deny', 'the old name is an ordinary change');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('failed')).decision, 'deny', 'an unknown audit value is an ordinary change');
  assert.equal(mergeOf(w, [file('docs/research/x.md')], reverse('failure', { reverses: 'abc' })).decision, 'deny');
});

test('actions not open in 0b are denied', () => {
  const w = world();
  for (const a of ['count_approval', 'delete_copy', 'write_production', 'flip_switch']) assert.equal(w.rules.may(a, { product: 'app' }).decision, 'deny', a);
  assert.match(w.rules.may('count_approval', {}).reason, /0b-5/);
});

test('the engine on its own denies an action it does not own, even an inherited name (audit minor 5)', () => {
  const impl = makeEngine({ products: ['app'], rulesState: () => null, productState: () => null, running: () => 0,
    rolesDir: join(here, 'roles'), clock: () => AT_10 });
  for (const a of ['constructor', 'toString', '__proto__', 'nope']) assert.equal(impl.may(a, { product: 'app' }).decision, 'deny', a);
});

test('get(): per-product values, audit sizing, failure classes, the adopted version', () => {
  const w = world();
  assert.equal(w.rules.get('audit_sizing.tier1', { product: 'app' }), 'until_zero_material');
  assert.equal(w.rules.get('audit_sizing.exit_tests', { product: 'app' }), 'tier1');
  assert.equal(w.rules.get('failure_classes.stuck', { product: 'app' }), 'retry');
  assert.equal(w.rules.get('failure_classes.never_seen', { product: 'app' }), 'joe', 'MIN-8');
  assert.deepEqual({ ...w.rules.get('rules.adopted', { product: 'app' }) }, { commit: C, blob: B });
  assert.equal(w.rules.get('rules.adopted', { product: 'nope' }), undefined);
  assert.equal(w.rules.get('__proto__', { product: 'app' }), undefined);
  w.reader.app = { status: 'last_good', policy: w.reader.app.policy, commit: C, blob: B };
  assert.equal(w.rules.get('rules.adopted', { product: 'app' }).blob, B, 'last good is still the adopted version');
  assert.match(w.rules.rev, /^app=ccccccc:bbbbbbb$/);
});

test('classify through the engine uses the product\'s adopted rules; a roles file change is protected Tier 1 (R-0b-14)', () => {
  const w = world();
  const c = w.rules.classify({ product: 'app', files: [file('orchestrate/modules/M10-rules/roles/worker.json')], declared_tier: 2 });
  assert.equal(c.tier, 1);
  assert.ok(c.risky.includes('protected'));
  assert.deepEqual(w.rules.classify({ product: 'app', files: [file('docs/research/x.md')], declared_tier: 2 }).risky, []);
  assert.deepEqual(w.rules.classify({ files: [file('docs/research/x.md')], declared_tier: 2 }).risky, ['unclassifiable'], 'no product: unclassifiable');
});
