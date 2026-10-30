// lane-check.test.mjs — the first cutover's merge check (LEAD-CALLS L34): only a docs-and-research-lane change by path
// passes; anything else is refused, and MAIN merges it as today. Run: node --test orchestrate/modules/M10-rules/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules } from '../../shared/rules.mjs';
import { makeEngine } from './engine.mjs';
import { parsePolicy } from './policy.mjs';
import { MAX_FILES } from './classify.mjs';
import { docsLaneProblem } from './lane-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const pol = (edit = (t) => t) => { const r = parsePolicy(edit(FIXTURE)); assert.ok(r.ok, r.reason); return r.policy; };
const POL = pol();
const f = (path, status = 'modified', extra = {}) => ({ path, status, ...extra });
const change = (files, extra = {}) => ({ files, declared_tier: 2, labels: [], ...extra });
const check = (files, extra, policy = POL) => docsLaneProblem(policy, change(files, extra));

test('a plain text doc in the docs or research lane passes', () => {
  for (const files of [[f('docs/research/a.md')], [f('docs/x.md', 'added')], [f('docs/domains/sales/notes.yaml')], [f('docs/research/data.csv', 'added', { mode: '100644' })],
    [f('docs/research/a.json', 'modified', { mode: 100644 })], [f('docs/x.md', 'renamed', { previous_path: 'docs/y.md' })],
    [f('docs/research/b.md', 'copied', { previous_path: 'docs/research/a.md' })], [f('docs/research/a.md'), f('docs/research/x.txt', 'added')]]) {
    assert.equal(check(files), null, JSON.stringify(files));
  }
});

test('anything outside the lane, protected, removed, linked, runnable or binary is refused', () => {
  const REFUSED = [
    [f('lib/a.ts')], [f('docs/research/a.md'), f('lib/a.ts')], [f('docs/blueprint/rows/R-1.yaml')], [f('docs/blueprint/decided.yaml')],
    [f('docs/blueprint/BLUEPRINT.md')], [f('README.md')], [f('docs/sub/x.md')], [f('docs/research/a.png')], [f('docs/research/a.pdf')],
    [f('docs/research/a.mdx')], [f('docs/research/a.svg')], [f('docs/research/a.html')], [f('docs/research/a')], [f('docs/research/a.md.sh')], [f('docs/x.txt')],
    [f('docs/research/a.md', 'removed')], [f('docs/research/a.md', 'deleted')], [{ path: 'docs/research/a.md' }],
    [f('docs/research/a.md', 'modified', { mode: '120000' })], [f('docs/research/a.md', 'modified', { mode: '160000' })],
    [f('docs/research/a.md', 'modified', { mode: '100755' })], [f('docs/research/a.md', 'modified', { mode: '0100644' })], [f('docs/research/a.md', 'modified', { mode: null })],
    [f('docs/research/a.md', 'renamed', { previous_path: 'lib/a.md' })], [f('docs/x.md', 'renamed', { previous_path: 'docs/research/a.md' })],
    [f('docs/research/b.md', 'copied', { previous_path: 'lib/secret.md' })], [f('docs/research/a.md', 'renamed')], [f('docs/research/a.md', 'modified', { previous_path: 'docs/research/b.md' })],
    [f('docs/research/../../lib/a.md')], [f('docs/research/./a.md')], [f('docs//research/a.md')], [f('/docs/research/a.md')], [f('docs\\research\\a.md')],
    [f('docs/research/é.md')], [f('docs/research/a​.md')], [f('docs/research/a.md\0')], [f('docs/research/.github/a.md')], [f('docs/research/.claude/x.md')],
    [f('docs/research/AGENTS.md')], [f('docs/CLAUDE.md')], [{ status: 'modified' }], [null], ['docs/research/a.md'],
  ];
  for (const files of REFUSED) assert.ok(check(files), JSON.stringify(files));
});

test('the change as a whole must be plain Tier 2 with no needs-joe label and a full file list', () => {
  const ok = [f('docs/research/a.md')];
  for (const extra of [{ truncated: true }, { truncated: 'no' }, { declared_tier: 1 }, { declared_tier: undefined }, { declared_tier: '2' },
    { labels: ['needs-joe'] }, { labels: ['bug', 'Needs Joe: schema'] }, { labels: ['needs-jøe'] }, { labels: ['🐛'] }, { labels: 'needs-joe' }, { labels: [1] }]) {
    assert.ok(check(ok, extra), JSON.stringify(extra));
  }
  assert.equal(check(ok, { labels: ['bug', 'docs'], truncated: false }), null);
  assert.ok(check([]), 'no files');
  assert.ok(check(Array.from({ length: MAX_FILES }, (_, i) => f(`docs/research/${i}.md`))), 'a list of the cut-off size');
  assert.equal(check(Array.from({ length: MAX_FILES - 1 }, (_, i) => f(`docs/research/${i}.md`))), null);
});

test('the rules file can only narrow the lane: its protected, Tier 1 and effect paths inside docs are refused', () => {
  const add = (from, to) => pol((t) => { assert.ok(t.includes(from)); return t.replace(from, to); });
  assert.ok(check([f('docs/research/a.md')], {}, add('protected_files:\n', 'protected_files:\n  - docs/research/a.md\n')));
  assert.ok(check([f('docs/research/a.md')], {}, add('tiers:\n  paths:\n', 'tiers:\n  paths:\n    - pattern: docs/research/**\n      tier: 1\n')));
  assert.ok(check([f('docs/research/x.md', 'added')], {}, add('new_files_under: [app/]', 'new_files_under: [app/, docs/research/]')));
  assert.ok(check([f('docs/research/a.md')], {}, add('sender_paths: [lib/mail/, lib/alerts/]', 'sender_paths: [lib/mail/, docs/research/]')));
  assert.ok(check([f('docs/x.md')], {}, add('  docs:\n    - docs/*.md\n', '  docs:\n    - docs/domains/**\n')), 'a lane the rules leave out');
  // A rules lane wider than the floor is still held to the floor.
  assert.ok(check([f('docs/sub/x.md')], {}, add('  docs:\n    - docs/*.md\n', '  docs:\n    - docs/**\n')));
  assert.ok(check([f('docs/research/a.md')], {}, { ...POL, lanes: {} }), 'no docs or research lane');
  assert.ok(check([f('docs/research/a.md')], {}, null));
});

test('the check never throws: a hostile change is a reason, not a pass', () => {
  const boom = () => { throw new Error('boom'); };
  for (const c of [null, 'x', { get files() { return boom(); }, declared_tier: 2 }, { files: [{ get path() { return boom(); }, status: 'modified' }], declared_tier: 2 },
    { files: [f('docs/research/a.md')], declared_tier: 2, get labels() { return boom(); } },
    { files: new Proxy([f('docs/research/a.md')], { get: boom }), declared_tier: 2 }]) {
    let r;
    assert.doesNotThrow(() => { r = docsLaneProblem(POL, c); });
    assert.equal(typeof r, 'string');
  }
});

// The engine's merge answer at the first cutover (deepMerge off, the default).
const AT_10 = Date.parse('2026-10-14T14:00:00Z');
const SHA = 'a'.repeat(40);
function rulesFor(state = 'active', policy = POL) {
  return makeRules(makeEngine({
    products: ['app'],
    rulesState: () => ({ status: 'ok', policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state }),
    running: () => 0,
    rolesDir: join(here, 'roles'),
    clock: () => AT_10,
  }));
}
const merge = (rules, files, extra = {}) => rules.may('merge', { product: 'app', card: { id: 'C-1' }, files, declared_tier: 2, labels: [], ...extra });
const undo = (audit) => ({ kind: 'exact_reverse', reverses: SHA, exact_reverse_ok: true, reversed_audit: audit });

test('merge at the first cutover: the docs lane is allowed; anything else is refused for MAIN to merge as today', () => {
  const r = rulesFor();
  assert.deepEqual([merge(r, [f('docs/research/a.md')]).decision, merge(r, [f('docs/research/a.md')]).reason], ['allow', 'docs lane']);
  for (const files of [[f('lib/a.ts', 'modified', { added_lines: [''], removed_lines: [''] })], [f('docs/research/a.png')], [f('docs/blueprint/rows/R-1.yaml')]]) {
    const d = merge(r, files);
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /^not this lane's change; MAIN merges it as today/);
  }
  assert.equal(merge(r, [f('docs/research/a.md')], { labels: ['needs-joe'] }).decision, 'deny');
  assert.equal(merge(r, [f('docs/research/a.md')], { declared_tier: 1 }).decision, 'deny');
  // An undo is held to the same lane: a code undo after a failed audit is refused, not allowed.
  assert.equal(merge(r, [f('lib/a.ts', 'modified', { added_lines: [''], removed_lines: [''] })], undo('failure')).decision, 'deny');
  assert.equal(merge(r, [f('docs/research/a.md')], undo('success')).reason, 'exact reverse of a docs-lane change');
});

test('merge at the first cutover: while paused only an exact reverse of a docs-lane change merges; bad rules or product deny', () => {
  const p = rulesFor('paused');
  assert.match(merge(p, [f('docs/research/a.md')]).reason, /paused/);
  assert.equal(merge(p, [f('docs/research/a.md')], undo('failure')).decision, 'allow');
  assert.equal(merge(p, [f('docs/research/a.md')], { ...undo('failure'), exact_reverse_ok: false }).decision, 'deny');
  assert.equal(merge(p, [f('docs/research/a.md')], { ...undo('failure'), reverses: 'abc' }).decision, 'deny');
  assert.equal(merge(rulesFor('unknown-state'), [f('docs/research/a.md')]).decision, 'deny', 'an unknown state reads as paused');
  assert.equal(rulesFor().may('merge', { product: 'other', files: [f('docs/research/a.md')], declared_tier: 2 }).decision, 'deny');
  assert.equal(merge(rulesFor('active', { ...POL, product_state_rules: { ...POL.product_state_rules, active: { ...POL.product_state_rules.active, tier1_merge: 'whatever' } } }),
    [f('docs/research/a.md')]).decision, 'deny');
  assert.equal(merge(rulesFor(), []).decision, 'deny');
  assert.equal(merge(rulesFor(), [f('docs/research/a.md', 'removed')]).decision, 'deny');
});

test('merge at the first cutover: an undo_only state rule holds all but an exact reverse; only deepMerge: true turns the deep classifier on', () => {
  const undoOnly = { ...POL, product_state_rules: { ...POL.product_state_rules, active: { ...POL.product_state_rules.active, tier1_merge: 'undo_only' } } };
  assert.match(merge(rulesFor('active', undoOnly), [f('docs/research/a.md')]).reason, /only an exact reverse/);
  assert.equal(merge(rulesFor('active', undoOnly), [f('docs/research/a.md')], undo('none')).decision, 'allow');
  for (const deepMerge of [1, 'true', {}, null]) {
    const r = makeRules(makeEngine({ products: ['app'], rulesState: () => ({ status: 'ok', policy: POL, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
      productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, 'roles'), clock: () => AT_10, deepMerge }));
    assert.equal(merge(r, [f('docs/research/a.md')]).reason, 'docs lane', `deepMerge: ${JSON.stringify(deepMerge)}`);
  }
});

// Confirm audit of L34 (29 Oct 2026).
test('fields inherited from a class or hidden from a copy are still read: a cut-off list, a needs-joe label or a link is refused (M1)', () => {
  const r = rulesFor();
  class Req { constructor(files) { this.product = 'app'; this.declared_tier = 2; this.files = files; this.card = { id: 'C-1' }; } }
  class CutOff extends Req { get truncated() { return true; } }
  class Asks extends Req { get labels() { return ['needs-joe']; } }
  class LinkFile { constructor() { this.path = 'docs/research/a.md'; this.status = 'modified'; } get mode() { return '120000'; } }
  assert.equal(r.may('merge', new Req([f('docs/research/a.md')])).decision, 'allow', 'a plain class instance in the lane');
  for (const s of [new CutOff([f('docs/research/a.md')]), new Asks([f('docs/research/a.md')]), new Req([new LinkFile()])]) assert.equal(r.may('merge', s).decision, 'deny', s.constructor.name);
  const hidden = (k, v, o) => Object.defineProperty(o, k, { value: v, enumerable: false });
  assert.equal(r.may('merge', hidden('truncated', true, { product: 'app', declared_tier: 2, files: [f('docs/research/a.md')] })).decision, 'deny');
  assert.equal(r.may('merge', hidden('labels', ['needs-joe'], { product: 'app', declared_tier: 2, files: [f('docs/research/a.md')] })).decision, 'deny');
  assert.equal(r.may('merge', { product: 'app', declared_tier: 2, files: [hidden('mode', '120000', f('docs/research/a.md'))] }).decision, 'deny');
});

test('a list is read by position, so an iterator that hides an entry hides nothing (m2)', () => {
  const r = rulesFor();
  const quiet = (arr, shown) => Object.assign(arr, { [Symbol.iterator]: function* () { yield* shown; } });
  assert.equal(merge(r, [f('docs/research/a.md')], { labels: quiet(['needs-joe'], []) }).decision, 'deny');
  assert.equal(merge(r, quiet([f('docs/research/a.md'), f('lib/evil.ts')], [f('docs/research/a.md')])).decision, 'deny');
  assert.ok(check(quiet([f('docs/research/a.md'), f('lib/evil.ts')], [f('docs/research/a.md')])));
  assert.ok(check([f('docs/research/a.md')], { labels: quiet(['needs-joe'], []) }));
});

test('long or deep paths, other-case folders, hidden files and files tools read as settings are refused, quickly (m1, m3, m4)', () => {
  const deep = `docs/research/${'a/'.repeat(2000)}x.md`;
  const t = Date.now();
  assert.ok(check(Array.from({ length: MAX_FILES - 1 }, (_, i) => f(`${deep}${i}`))));
  assert.ok(Date.now() - t < 2000, 'answers in under 2 s');
  for (const p of [`docs/research/${'a'.repeat(600)}.md`, `docs/research/${'a/'.repeat(15)}x.md`, 'DOCS/research/a.md', 'Docs/Research/A.MD', 'docs/Research/a.md',
    'docs/research/AGENTS.override.md', 'docs/research/GEMINI.md', 'docs/research/.cursor/rules/x.md', 'docs/research/.x.md', 'docs/pull_request_template.md',
    'docs/research/package.json', 'docs/research/tsconfig.json', 'docs/research/tsconfig.build.json', 'docs/research/ISSUE_TEMPLATE/bug.md']) {
    assert.ok(check([f(p)]), p);
  }
  assert.equal(check([f(`docs/research/${'a/'.repeat(10)}x.md`)]), null, 'a fairly deep doc still passes');
  assert.equal(check([f('docs/domains/Sales/Notes.md')]), null, 'case below the lane folder is the doc\'s own');
});

test('the rules\' docs_paths narrow the lane; a pause holds whatever the state rule says; a paused undo needs a known audit result (m5)', () => {
  assert.ok(check([f('docs/research/a.md')], {}, { ...POL, docs_paths: ['docs/domains/**'] }));
  assert.equal(check([f('docs/domains/a.md')], {}, { ...POL, docs_paths: ['docs/domains/**'] }), null);
  const pausedRules = { ...POL, product_state_rules: { ...POL.product_state_rules, paused: { ...POL.product_state_rules.paused, tier1_merge: 'rules' } } };
  assert.match(merge(rulesFor('paused', pausedRules), [f('docs/research/a.md')]).reason, /paused/);
  for (const audit of ['bogus', undefined, 'SUCCESS']) {
    assert.equal(merge(rulesFor('paused'), [f('docs/research/a.md')], { ...undo('failure'), reversed_audit: audit }).decision, 'deny', String(audit));
  }
});
