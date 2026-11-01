// first-cutover.test.mjs — a first-cutover onboarding entry (R-0b-106a), on the generic sample product and M10's real
// engine. Run: node --test orchestrate/modules/M10-rules/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules } from '../../shared/rules.mjs';
import { makeEngine } from './engine.mjs';
import { parsePolicy } from './policy.mjs';
import { docsLaneProblem } from './lane-check.mjs';
import { firstCutoverProblems, PATH_ONLY_EFFECTS, MODULE_KEYS, READERS } from './first-cutover.mjs';
import { readyCheck } from '../M9-record/ready.mjs';
import { CARD_CREATORS } from '../M9-record/permissions.mjs';
import { goFreeOn } from '../M9-record/required-keys.mjs';
import { PRODUCT_STATES } from './policy.mjs';
import { readConfig } from '../M2-approvals/kinds.mjs';
import { botId } from '../M6-merge-gate/gather.mjs';
import { goFreeKinds } from '../M9-record/ready.mjs';
import { KEYS as M11_KEYS, NEW_KEYS as M11_NEW_KEYS, need } from '../M11-dispatcher/keys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const swap = (t, from, to) => { assert.ok(t.includes(from), `text has ${from}`); return t.replace(from, to); };
const ENTRY = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };

// Reasons the real readers give today on any rules file, because the rules engine hands numbers over as text
// (LEAD-CALLS L96: parseYaml('n: 30') gives "30"). They go when the step-2 sweeps land: lane 1's M9 sweep
// (heartbeat_stale_min) and lane 2's M11 sweep (context.*, caps.per_state). The test 'the pending reasons are exactly
// these' then fails, and this list is cut to what is left; at [] the todo test below passes.
const PENDING = Object.freeze([
  'M9: proposals.heartbeat_stale_min must be a whole number of minutes, at least 1',
  'M11: context.lead.soft must be a number',
  'M11: context.lead.hard must be a number',
  'M11: context.handoff_cap.role must be a number',
  'M11: context.worker.split_after_compactions must be a number',
  'M11: caps.per_state must give a number for active, away, paused, light (editingLimits refuses it)',
]);
const fit = (...a) => firstCutoverProblems(...a).filter((x) => !PENDING.includes(x));

// The keys the merge gate (M6), Approvals (M2), the Record (M9) and the Dispatcher (M11) read (L86): go_free in the
// map form, the only one both of its readers can use.
const MODULE_PART = `
product_profile:
  required_checks: [build, test]
  robot:
    bot_user_id: 1000099
approvals:
  plan_go:
    go_free:
      exact_reverse: true
      lead_daily_card:
        - docs/blueprint/daily/**
  push_windows: ['08:00', '17:00']
  decisions_dir: docs/decisions
proposals:
  heartbeat_stale_min: 30
context:
  lead:
    soft: 120000
    hard: 160000
  handoff_cap:
    role: 3
  worker:
    split_after_compactions: 2
`;

// The sample made into a first-cutover entry: no lead lane, no editing, no import list, the modules' keys given.
const FIRST = [
  (t) => swap(t, '  lead:\n    - docs/blueprint/**\n', ''),
  (t) => swap(t, 'editing_per_product: 3', 'editing_per_product: 0'),
  (t) => swap(t, '    package_imports: [nodemailer, twilio]\n', ''),
  (t) => swap(t, '  shakedown_workers: 1\n', '  shakedown_workers: 1\n  per_state:\n    active: 1\n    away: 1\n    paused: 0\n    light: 1\n'),
  (t) => swap(t, '  stale_after_min: 15\n', '  stale_after_min: 15\n  red_runs: [undo]\n'),
  (t) => `${t}${MODULE_PART}`,
].reduce((t, f) => f(t), SAMPLE);

test('the entry is fit, with its products.json line, and needs no import list', () => {
  assert.deepEqual(fit(FIRST, ENTRY), []);
  assert.ok(!FIRST.includes('package_imports'));
  assert.ok(PATH_ONLY_EFFECTS.length >= 7 && !PATH_ONLY_EFFECTS.some(([, f]) => f === 'package_imports'));
});

test('the sample as it stands is refused, for each first-cutover reason', () => {
  assert.deepEqual(fit(SAMPLE), [
    'caps.editing_per_product must be 0',
    'lanes must be docs and research only',
    'product_profile.required_checks is missing (M6 reads it)',
    'product_profile.robot.bot_user_id is missing (M6 reads it)',
    'approvals.plan_go.go_free is missing (M6, M9 read it)',
    'approvals.push_windows is missing (M2 reads it)',
    'approvals.decisions_dir is missing (M2 reads it)',
    'proposals.heartbeat_stale_min is missing (M9 reads it)',
    'usage.red_runs is missing (M11 reads it)',
    'caps.per_state is missing (M11 reads it)',
    'approvals.plan_go.go_free.lead_daily_card is missing (M11 reads it)',
    'context.lead.soft is missing (M11 reads it)',
    'context.lead.hard is missing (M11 reads it)',
    'context.handoff_cap.role is missing (M11 reads it)',
    'context.worker.split_after_compactions is missing (M11 reads it)',
  ]);
});

test('each missing or wrong piece is named', () => {
  const cases = [
    [swap(FIRST, 'product:\n  cutover_stage: first\n', ''), 'product.cutover_stage must say first'],
    [swap(FIRST, 'cutover_stage: first', 'cutover_stage: second'), 'product.cutover_stage must say first'],
    [swap(FIRST, 'editing_per_product: 0', 'editing_per_product: 1'), 'caps.editing_per_product must be 0'],
    [swap(FIRST, '  research:\n    - docs/research/**\n', ''), 'lanes must be docs and research only'],
    [swap(FIRST, 'lanes:\n', 'lanes:\n  product:\n    - app/**\n'), 'lanes must be docs and research only'],
    [swap(FIRST, '  research:\n    - docs/research/**\n', '  research: []\n'), 'lanes.research must list at least one path'],
    [swap(FIRST, '    flag_files: [lib/flags.ts]\n', ''), 'effect_paths.first_customer_visible.flag_files must list at least one path'],
    [swap(FIRST, 'sender_paths: [lib/mail/, lib/alerts/]', 'sender_paths: []'), 'effect_paths.messages_people.sender_paths must list at least one path'],
    [swap(FIRST, 'required_checks: [build, test]', 'required_checks: []'), 'product_profile.required_checks must name at least one check (policy)'],
    [swap(FIRST, 'required_checks: [build, test]', "required_checks: [build, '']"), 'M6: product_profile.required_checks must be a list of check names'],
    [swap(FIRST, '  editing_per_product: 0\n', ''), 'caps.editing_per_product must be 0'],
    [swap(FIRST, '    - docs/research/**\n', '    - app/**\n'), 'lanes.research: "app/**" is outside docs/domains/, docs/research/ and docs/*.md'],
    [swap(FIRST, 'script: none', 'script: 2.1.300'), 'roles_enabled.script must be none'],
  ];
  for (const [text, want] of cases) assert.ok(fit(text).includes(want), want);
  // A corrupt file is one reason, not a list of follow-on ones.
  const corrupt = fit(swap(FIRST, 'protected_files:', 'protected_filez:'));
  assert.equal(corrupt.length, 1);
  assert.match(corrupt[0], /^the rules file is corrupt/);
});

test('the products.json entry is checked as the reader checks it, and its GitHub id must match the rules', () => {
  assert.match(fit(FIRST, { ...ENTRY, joe_github_id: '1000001' })[0], /malformed/);
  assert.match(fit(FIRST, { ...ENTRY, repo: '' })[0], /malformed/);
  assert.deepEqual(fit(FIRST, { ...ENTRY, joe_github_id: 1000002 }), ['the products.json entry and accounts.joe.github_id name different GitHub ids']);
  // A name already on the Mac's list would make the reader deny every product; it is caught here instead.
  const other = { product: 'other-app', owner: 'sample-org', repo: 'other-app', joe_github_id: 1000001 };
  assert.deepEqual(fit(FIRST, ENTRY, [other]), []);
  assert.match(fit(FIRST, ENTRY, [{ ...other, product: 'sample-app' }])[0], /twice/);
});

test('on the real engine the entry starts no editing, merges a research note, and refuses code', () => {
  const r = parsePolicy(FIRST);
  assert.ok(r.ok, r.reason);
  const rules = makeRules(makeEngine({
    products: ['sample-app'],
    rulesState: () => ({ status: 'ok', policy: r.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }),
    running: () => 0,
    rolesDir: join(here, 'roles'),
    clock: () => Date.parse('2026-10-14T14:00:00Z'),
  }));
  const start = rules.may('start_session', { product: 'sample-app', role: 'worker', tier: 2, editing: true });
  assert.equal(start.decision, 'deny');
  assert.match(start.reason, /no editing starts/);
  const change = (path) => ({ files: [{ path, status: 'added' }], declared_tier: 2 });
  assert.equal(docsLaneProblem(r.policy, change('docs/research/note.md')), null);
  assert.equal(docsLaneProblem(r.policy, change('docs/domains/area.md')), null);
  for (const p of ['app/page.tsx', 'lib/mail/send.ts', 'docs/blueprint/rows/R-1.yaml', 'orchestrate/policy.yaml']) {
    assert.notEqual(docsLaneProblem(r.policy, change(p)), null, p);
  }
});

// ---- L86, L96: the keys other modules read, checked by those modules' own code (no stand-ins) ----

const rulesOf = (text) => {
  const r = parsePolicy(text);
  if (!r.ok) return null;
  return makeRules(makeEngine({
    products: ['sample-app'],
    rulesState: () => ({ status: 'ok', policy: r.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, 'roles'),
    clock: () => Date.parse('2026-10-14T14:00:00Z'),
  }));
};
// A key named by a pending reason is left out here, as fit() leaves out the reason.
const pendingKey = (k) => PENDING.some((x) => x.startsWith(`M9: ${k} `) || x.startsWith(`M11: ${k} `));
const M11_TYPE = { perState: 'object', shakedown: 'boolean', leadDailyCard: 'list', redRuns: 'list' };

// What the modules' real readers say about a rules file, called here on their own, not through the fit check:
// M2's readConfig; M6's botId, its required-checks read (a list of check names, gather.mjs:142) and goFreeKinds for
// undo cards; M9's readyCheck on an undo card in each product state; M11's need() on every key it reads (but NEW_KEYS),
// with its callers' types. M9's heartbeat limit is read inline in writer.mjs, so the missing-key tests cover it.
function readersAccept(text) {
  const rules = rulesOf(text);
  if (!rules) return false;
  const product = 'sample-app';
  const p = { product };
  const checks = rules.get('product_profile.required_checks', p);
  const m2 = readConfig(rules, product).ok;
  const m6 = botId(rules.get('product_profile.robot', p)) !== null && Array.isArray(checks) && checks.every((c) => typeof c === 'string' && c)
    && goFreeKinds(rules, product).includes('exact_reverse');
  const creator = Object.keys(CARD_CREATORS).find((a) => CARD_CREATORS[a].includes('exact_reverse'));
  const m9 = PRODUCT_STATES.every((state) => {
    const view = { get: (e) => (e === 'product' ? { id: product, doc: { state } } : null), list: () => [], createdBy: () => creator };
    const r = readyCheck({ id: 'C-t', doc: { product, kind: 'exact_reverse', round: 1, depends_on: [] } }, view, { rules, product });
    return r.ok || / no work starts$/.test(r.reason);
  });
  const m11 = Object.entries(M11_KEYS).filter(([, k]) => !M11_NEW_KEYS.includes(k) && !pendingKey(k)).every(([name, key]) => {
    try { need(rules, key, { product, type: M11_TYPE[name] ?? 'number' }); return true; } catch { return false; }
  });
  return m2 && m6 && m9 && m11;
}

const GO_FREE_BLOCK = '    go_free:\n      exact_reverse: true\n      lead_daily_card:\n        - docs/blueprint/daily/**\n';
// [name, make, policy]: a policy variant is one the fit check refuses on purpose while today's readers accept it; the
// third field says whose rule it is.
const VARIANTS = [
  ['as given', (t) => t],
  ['no go_free', (t) => swap(t, GO_FREE_BLOCK, '')],
  ['go_free in the list form', (t) => swap(t, GO_FREE_BLOCK, '    go_free: [exact_reverse]\n')],
  ['go_free without exact_reverse', (t) => swap(t, '      exact_reverse: true\n', '')],
  ['no lead_daily_card', (t) => swap(t, '      lead_daily_card:\n        - docs/blueprint/daily/**\n', '')],
  ['an empty lead_daily_card (the Lead is not on the product)', (t) => swap(t, '      lead_daily_card:\n        - docs/blueprint/daily/**\n', '      lead_daily_card: []\n')],
  ['a null bot id', (t) => swap(t, 'bot_user_id: 1000099', 'bot_user_id: null')],
  ['a bot login, not an id', (t) => swap(t, 'bot_user_id: 1000099', 'bot_user_id: sample-robot')],
  ['no robot', (t) => swap(t, '  robot:\n    bot_user_id: 1000099\n', '')],
  ['no push windows', (t) => swap(t, "  push_windows: ['08:00', '17:00']\n", '')],
  ['a push window that is not HH:MM', (t) => swap(t, "push_windows: ['08:00', '17:00']", 'push_windows: [8am]')],
  ['no decisions folder', (t) => swap(t, '  decisions_dir: docs/decisions\n', '')],
  ['a decisions folder that climbs out', (t) => swap(t, 'decisions_dir: docs/decisions', 'decisions_dir: docs/../decisions')],
  ['a time zone that does not exist', (t) => swap(t, 'tz: America/New_York', 'tz: Mars/Base')],
  // L96 M-1: the Record's ready keys.
  ['no round cap', (t) => swap(t, '  rounds: 3\n', '')],
  ['a round cap of 0', (t) => swap(t, '  rounds: 3\n', '  rounds: 0\n')],
  ['no start line for active products', (t) => swap(t, 'product_state_rules:\n  active:\n    start: within_caps\n', 'product_state_rules:\n  active:\n')],
  // L96 M-2: the Dispatcher's whole key list.
  ['no red_runs', (t) => swap(t, '  red_runs: [undo]\n', '')],
  ['no stale_after_min', (t) => swap(t, '  stale_after_min: 15\n', '')],
  // L96 m-1, m-2, m-3: policy the fit check holds on purpose.
  ['no required checks', (t) => swap(t, 'required_checks: [build, test]', 'required_checks: []'), 'policy: the gate would check nothing (L96 m-1)'],
  ['exact_reverse: false', (t) => swap(t, 'exact_reverse: true', 'exact_reverse: false'), 'go_free values: goFreeKinds reads keys only until lane 1 adopts goFreeOn'],
  ['ordinary: true, so the Lead\'s cards skip the go', (t) => swap(t, '      exact_reverse: true\n', '      exact_reverse: true\n      ordinary: true\n'), 'go_free values: only the known kinds'],
  ['research_copy: yes', (t) => swap(t, '      exact_reverse: true\n', '      exact_reverse: true\n      research_copy: yes\n'), 'go_free values: a flag is true or false'],
  ['an empty daily-card pattern', (t) => swap(t, '        - docs/blueprint/daily/**\n', "        - ''\n"), 'M10\'s pattern rule (L96 m-3)'],
  ['an unclosed { in a daily-card pattern', (t) => swap(t, '        - docs/blueprint/daily/**\n', "        - 'docs/{a'\n"), 'M10\'s pattern rule (L96 m-3)'],
];

test('the pending reasons are exactly these, on the fixture as given', () => {
  assert.deepEqual(firstCutoverProblems(FIRST, ENTRY), [...PENDING]);
});

test.todo('the fixture is fit with no pending reasons (after the L96 step-2 sweeps)', () => {
  assert.deepEqual(firstCutoverProblems(FIRST, ENTRY), []);
});

test('a rules file passes the fit check if and only if the modules\' real readers accept it (L86 2, L96)', () => {
  const fits = [];
  for (const [name, make, policy] of VARIANTS) {
    const text = make(FIRST);
    const ok = fit(text, ENTRY).length === 0;
    if (policy) {
      assert.equal(ok, false, `${name}: the fit check must refuse it (${policy})`);
      assert.equal(readersAccept(text), true, `${name}: today's readers accept it, so this is the fit check's own line (${policy})`);
    } else {
      assert.equal(ok, readersAccept(text), `${name}: fit check ${ok ? 'passes' : 'refuses'}, the readers ${ok ? 'refuse' : 'accept'}`);
    }
    if (ok) fits.push(name);
  }
  assert.deepEqual(fits, ['as given', 'an empty lead_daily_card (the Lead is not on the product)']);
});

test('the Record\'s ready keys are named: caps.rounds and each state\'s start line (L96 M-1)', () => {
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m(FIRST)]));
  assert.deepEqual(fit(by['no round cap'], ENTRY), ['caps.rounds is missing (M9 reads it)']);
  assert.deepEqual(fit(by['a round cap of 0'], ENTRY), ['M9: no card is ever ready in a active or away or paused or light product: no round cap in the rules (caps.rounds)']);
  assert.deepEqual(fit(by['no start line for active products'], ENTRY), ['product_state_rules.active.start is missing (M9 reads it)']);
});

test('every key the Dispatcher reads is checked, not one (L96 M-2)', () => {
  const m11 = READERS.M11.REQUIRED_KEYS;
  assert.deepEqual([...m11], Object.values(M11_KEYS).filter((k) => !M11_NEW_KEYS.includes(k)));
  assert.ok(m11.length >= 20, `${m11.length} keys`);
  assert.deepEqual(fit(swap(FIRST, '  red_runs: [undo]\n', '  red_runs: undo\n'), ENTRY), ['M11: usage.red_runs must be a list']);
});

test('go_free values are read: only the known kinds, a flag exactly true or false (L96 m-2)', () => {
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m(FIRST)]));
  assert.deepEqual(fit(by['exact_reverse: false'], ENTRY), ['M6: approvals.plan_go.go_free.exact_reverse must be true, or every undo is refused']);
  assert.deepEqual(fit(by['ordinary: true, so the Lead\'s cards skip the go'], ENTRY), ['M9: approvals.plan_go.go_free.ordinary is not a go-free kind (only exact_reverse, research_copy, lead_daily_card)']);
  assert.deepEqual(fit(by['research_copy: yes'], ENTRY), ['M9: approvals.plan_go.go_free.research_copy must be true or false']);
  // The text a rules file gives ("true") is read as true; research_copy: true is a known kind.
  assert.deepEqual(fit(swap(FIRST, '      exact_reverse: true\n', '      exact_reverse: true\n      research_copy: true\n'), ENTRY), []);
  const rules = rulesOf(FIRST);
  assert.equal(goFreeOn(rules, 'sample-app', 'exact_reverse'), true);
  assert.equal(goFreeOn(rules, 'sample-app', 'lead_daily_card'), true, 'a pattern kind is go-free when its value is a list');
  assert.equal(goFreeOn(rules, 'sample-app', 'research_copy'), false, 'a kind the map does not name');
  assert.equal(goFreeOn(rulesOf(swap(FIRST, '      lead_daily_card:\n        - docs/blueprint/daily/**\n', '      lead_daily_card: docs/x\n')), 'sample-app', 'lead_daily_card'), false, 'a pattern kind whose value is not a list');
  assert.equal(goFreeOn(rulesOf(by['exact_reverse: false']), 'sample-app', 'exact_reverse'), false);
  assert.equal(goFreeOn(rulesOf(by['ordinary: true, so the Lead\'s cards skip the go']), 'sample-app', 'ordinary'), false);
});

test('daily-card patterns are read with M10\'s pattern rule (L96 m-3)', () => {
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m(FIRST)]));
  assert.deepEqual(fit(by['an empty daily-card pattern'], ENTRY), ['M9: approvals.plan_go.go_free.lead_daily_card: "" can\'t be read: empty pattern']);
  assert.deepEqual(fit(by['an unclosed { in a daily-card pattern'], ENTRY), ['M9: approvals.plan_go.go_free.lead_daily_card: "docs/{a" can\'t be read: unclosed { in pattern "docs/{a"']);
});

test('the fit check refuses a file without go_free, naming it (the L86 plant)', () => {
  assert.deepEqual(fit(VARIANTS[1][1](FIRST), ENTRY), [
    'approvals.plan_go.go_free is missing (M6, M9 read it)',
    'approvals.plan_go.go_free.lead_daily_card is missing (M11 reads it)',
  ]);
});

test('go_free in the list form is refused: one map serves goFreeKinds and M11\'s need() together (L86 9)', () => {
  const list = VARIANTS[2][1](FIRST);
  assert.ok(goFreeKinds(rulesOf(list), 'sample-app').includes('exact_reverse'), 'M9 and M6 read the list form');
  assert.throws(() => need(rulesOf(list), M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }), /no value/);
  assert.ok(fit(list, ENTRY).some((x) => /must be a map/.test(x)));
  // The map form: both readers get what they need from the same file.
  const rules = rulesOf(FIRST);
  assert.deepEqual(goFreeKinds(rules, 'sample-app'), ['exact_reverse', 'lead_daily_card']);
  assert.deepEqual(need(rules, M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }), ['docs/blueprint/daily/**']);
});

test('a draft with its FILL markers left in is refused for each one it must be', () => {
  // A draft's FILLs: bot_user_id null, required_checks [], lead_daily_card []. The last is allowed (L96 m-1).
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m]));
  const draft = [by['a null bot id'], by['no required checks'], by['an empty lead_daily_card (the Lead is not on the product)']].reduce((t, f) => f(t), FIRST);
  assert.deepEqual(fit(draft, ENTRY), [
    'product_profile.required_checks must name at least one check (policy)',
    'product_profile.robot.bot_user_id is missing (M6 reads it)',
  ]);
});

test('the fit check\'s keys are the union of the modules\' own lists, and nothing else', () => {
  const union = new Set(Object.values(READERS).flatMap((m) => m.REQUIRED_KEYS));
  assert.deepEqual(new Set(MODULE_KEYS), union);
  for (const k of ['product_profile.robot.bot_user_id', 'approvals.plan_go.go_free', 'approvals.push_windows', 'approvals.decisions_dir', M11_KEYS.leadDailyCard, 'caps.rounds', 'product_state_rules.light.start', M11_KEYS.redRuns]) assert.ok(union.has(k), k);
});
