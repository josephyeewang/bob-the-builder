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
import { readConfig } from '../M2-approvals/kinds.mjs';
import { botId } from '../M6-merge-gate/gather.mjs';
import { goFreeKinds } from '../M9-record/ready.mjs';
import { KEYS as M11_KEYS, need } from '../M11-dispatcher/keys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const swap = (t, from, to) => { assert.ok(t.includes(from), `text has ${from}`); return t.replace(from, to); };
const ENTRY = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };

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
`;

// The sample made into a first-cutover entry: no lead lane, no editing, no import list, the modules' keys given.
const FIRST = [
  (t) => swap(t, '  lead:\n    - docs/blueprint/**\n', ''),
  (t) => swap(t, 'editing_per_product: 3', 'editing_per_product: 0'),
  (t) => swap(t, '    package_imports: [nodemailer, twilio]\n', ''),
  (t) => `${t}${MODULE_PART}`,
].reduce((t, f) => f(t), SAMPLE);

test('the entry is fit, with its products.json line, and needs no import list', () => {
  assert.deepEqual(firstCutoverProblems(FIRST, ENTRY), []);
  assert.ok(!FIRST.includes('package_imports'));
  assert.ok(PATH_ONLY_EFFECTS.length >= 7 && !PATH_ONLY_EFFECTS.some(([, f]) => f === 'package_imports'));
});

test('the sample as it stands is refused, for each first-cutover reason', () => {
  assert.deepEqual(firstCutoverProblems(SAMPLE), [
    'caps.editing_per_product must be 0',
    'lanes must be docs and research only',
    'product_profile.required_checks is missing (M6 reads it)',
    'product_profile.robot.bot_user_id is missing (M6 reads it)',
    'approvals.plan_go.go_free is missing (M6, M9 read it)',
    'approvals.push_windows is missing (M2 reads it)',
    'approvals.decisions_dir is missing (M2 reads it)',
    'approvals.plan_go.go_free.lead_daily_card is missing (M11 reads it)',
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
    [swap(FIRST, 'required_checks: [build, test]', 'required_checks: []'), 'M6: product_profile.required_checks must name at least one check'],
    [swap(FIRST, '  editing_per_product: 0\n', ''), 'caps.editing_per_product must be 0'],
    [swap(FIRST, '    - docs/research/**\n', '    - app/**\n'), 'lanes.research: "app/**" is outside docs/domains/, docs/research/ and docs/*.md'],
    [swap(FIRST, 'script: none', 'script: 2.1.300'), 'roles_enabled.script must be none'],
  ];
  for (const [text, want] of cases) assert.ok(firstCutoverProblems(text).includes(want), want);
  // A corrupt file is one reason, not a list of follow-on ones.
  const corrupt = firstCutoverProblems(swap(FIRST, 'protected_files:', 'protected_filez:'));
  assert.equal(corrupt.length, 1);
  assert.match(corrupt[0], /^the rules file is corrupt/);
});

test('the products.json entry is checked as the reader checks it, and its GitHub id must match the rules', () => {
  assert.match(firstCutoverProblems(FIRST, { ...ENTRY, joe_github_id: '1000001' })[0], /malformed/);
  assert.match(firstCutoverProblems(FIRST, { ...ENTRY, repo: '' })[0], /malformed/);
  assert.deepEqual(firstCutoverProblems(FIRST, { ...ENTRY, joe_github_id: 1000002 }), ['the products.json entry and accounts.joe.github_id name different GitHub ids']);
  // A name already on the Mac's list would make the reader deny every product; it is caught here instead.
  const other = { product: 'other-app', owner: 'sample-org', repo: 'other-app', joe_github_id: 1000001 };
  assert.deepEqual(firstCutoverProblems(FIRST, ENTRY, [other]), []);
  assert.match(firstCutoverProblems(FIRST, ENTRY, [{ ...other, product: 'sample-app' }])[0], /twice/);
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

// ---- L86: the keys other modules read, checked by those modules' own code (no stand-ins) ----

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
// What the modules' real readers say about a rules file: M2's readConfig; M6's botId, its required-checks read
// (gather.mjs:142) and M9's goFreeKinds, which the gate uses for undo cards; M11's need() on the daily card's files.
function readersAccept(text) {
  const rules = rulesOf(text);
  if (!rules) return false;
  const p = { product: 'sample-app' };
  const checks = rules.get('product_profile.required_checks', p);
  const m2 = readConfig(rules, 'sample-app').ok;
  const m6 = botId(rules.get('product_profile.robot', p)) !== null && Array.isArray(checks) && checks.length > 0
    && goFreeKinds(rules, 'sample-app').includes('exact_reverse');
  let m11; try { m11 = need(rules, M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }).length > 0; } catch { m11 = false; }
  return m2 && m6 && m11;
}

const VARIANTS = [
  ['as given', (t) => t],
  ['no go_free', (t) => swap(t, '    go_free:\n      exact_reverse: true\n      lead_daily_card:\n        - docs/blueprint/daily/**\n', '')],
  ['go_free in the list form', (t) => swap(t, '    go_free:\n      exact_reverse: true\n      lead_daily_card:\n        - docs/blueprint/daily/**\n', '    go_free: [exact_reverse]\n')],
  ['go_free without exact_reverse', (t) => swap(t, '      exact_reverse: true\n', '')],
  ['no lead_daily_card', (t) => swap(t, '      lead_daily_card:\n        - docs/blueprint/daily/**\n', '')],
  ['an empty lead_daily_card', (t) => swap(t, '      lead_daily_card:\n        - docs/blueprint/daily/**\n', '      lead_daily_card: []\n')],
  ['a null bot id', (t) => swap(t, 'bot_user_id: 1000099', 'bot_user_id: null')],
  ['a bot login, not an id', (t) => swap(t, 'bot_user_id: 1000099', 'bot_user_id: sample-robot')],
  ['no robot', (t) => swap(t, '  robot:\n    bot_user_id: 1000099\n', '')],
  ['no required checks', (t) => swap(t, 'required_checks: [build, test]', 'required_checks: []')],
  ['no push windows', (t) => swap(t, "  push_windows: ['08:00', '17:00']\n", '')],
  ['a push window that is not HH:MM', (t) => swap(t, "push_windows: ['08:00', '17:00']", 'push_windows: [8am]')],
  ['no decisions folder', (t) => swap(t, '  decisions_dir: docs/decisions\n', '')],
  ['a decisions folder that climbs out', (t) => swap(t, 'decisions_dir: docs/decisions', 'decisions_dir: docs/../decisions')],
  ['a time zone that does not exist', (t) => swap(t, 'tz: America/New_York', 'tz: Mars/Base')],
];

test('a rules file passes the fit check if and only if the modules\' real readers accept it (L86 2)', () => {
  let refused = 0;
  for (const [name, make] of VARIANTS) {
    const text = make(FIRST);
    const fit = firstCutoverProblems(text, ENTRY).length === 0;
    assert.equal(fit, readersAccept(text), `${name}: fit check ${fit ? 'passes' : 'refuses'}, the readers ${fit ? 'refuse' : 'accept'}`);
    if (!fit) refused++;
  }
  assert.equal(readersAccept(FIRST), true);
  assert.equal(refused, VARIANTS.length - 1, 'every variant but the first is refused');
});

test('the fit check refuses a file without go_free, naming it (the L86 plant)', () => {
  const text = VARIANTS[1][1](FIRST);
  assert.deepEqual(firstCutoverProblems(text, ENTRY), [
    'approvals.plan_go.go_free is missing (M6, M9 read it)',
    'approvals.plan_go.go_free.lead_daily_card is missing (M11 reads it)',
  ]);
});

test('go_free in the list form is refused: one map serves goFreeKinds and M11\'s need() together (L86 9)', () => {
  const list = VARIANTS[2][1](FIRST);
  assert.ok(goFreeKinds(rulesOf(list), 'sample-app').includes('exact_reverse'), 'M9 and M6 read the list form');
  assert.throws(() => need(rulesOf(list), M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }), /no value/);
  assert.ok(firstCutoverProblems(list, ENTRY).some((x) => /must be a map/.test(x)));
  // The map form: both readers get what they need from the same file.
  const rules = rulesOf(FIRST);
  assert.deepEqual(goFreeKinds(rules, 'sample-app'), ['exact_reverse', 'lead_daily_card']);
  assert.deepEqual(need(rules, M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }), ['docs/blueprint/daily/**']);
});

test('a draft with its FILL markers left in is refused for each one', () => {
  // The policy draft's three FILLs: bot_user_id null, required_checks [], lead_daily_card [].
  const draft = [VARIANTS[6][1], VARIANTS[9][1], VARIANTS[5][1]].reduce((t, f) => f(t), FIRST);
  assert.deepEqual(firstCutoverProblems(draft, ENTRY), [
    'product_profile.robot.bot_user_id is missing (M6 reads it)',
    'M6: product_profile.required_checks must name at least one check',
    'M11: approvals.plan_go.go_free.lead_daily_card must list at least one file pattern',
  ]);
});

test('the fit check\'s keys are the union of the modules\' own lists, and nothing else', () => {
  const union = new Set(Object.values(READERS).flatMap((m) => m.REQUIRED_KEYS));
  assert.deepEqual(new Set(MODULE_KEYS), union);
  for (const k of ['product_profile.robot.bot_user_id', 'approvals.plan_go.go_free', 'approvals.push_windows', 'approvals.decisions_dir', M11_KEYS.leadDailyCard]) assert.ok(union.has(k), k);
});
