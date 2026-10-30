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
import { firstCutoverProblems, PATH_ONLY_EFFECTS } from './first-cutover.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const swap = (t, from, to) => { assert.ok(t.includes(from), `text has ${from}`); return t.replace(from, to); };
const ENTRY = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };

// The sample made into a first-cutover entry: no lead lane, no editing, no import list, the required checks named.
const FIRST = [
  (t) => swap(t, '  lead:\n    - docs/blueprint/**\n', ''),
  (t) => swap(t, 'editing_per_product: 3', 'editing_per_product: 0'),
  (t) => swap(t, '    package_imports: [nodemailer, twilio]\n', ''),
  (t) => `${t}\nproduct_profile:\n  required_checks: [build, test]\n`,
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
    'product_profile.required_checks must name at least one check',
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
    [swap(FIRST, 'required_checks: [build, test]', 'required_checks: []'), 'product_profile.required_checks must name at least one check'],
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
