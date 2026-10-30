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
  for (const files of [[f('docs/research/a.md')], [f('docs/x.md', 'added')], [f('docs/domains/sales/notes.txt')], [f('docs/research/data.csv', 'added', { mode: '100644' })],
    [f('docs/research/a.md', 'modified', { mode: 100644 })], [f('docs/x.md', 'renamed', { previous_path: 'docs/y.md' })],
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
    [Object.assign(() => {}, { path: 'docs/research/a.md', status: 'modified' })],
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
  // Each of the rules' effect paths, one at a time (round 3, m-1).
  assert.equal(check([f('docs/research/a.md')]), null);
  assert.ok(check([f('docs/research/a.md')], {}, add('files: [next.config.*, middleware.ts, env.schema.ts]', 'files: [next.config.*, docs/research/a.md]')), 'secrets file');
  assert.ok(check([f('docs/research/a.md')], {}, add('migration_paths: [db/migrations/]', 'migration_paths: [db/migrations/, docs/research/]')), 'migrations');
  assert.ok(check([f('docs/research/a.md')], {}, add('repair_folder: [db/repairs/]', 'repair_folder: [db/repairs/, docs/research/]')), 'repairs');
  assert.ok(check([f('docs/research/a.md')], {}, add('flag_files: [lib/flags.ts]', 'flag_files: [lib/flags.ts, docs/research/a.md]')), 'flag file');
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

// Confirm audit of L34, round 2 (29 Oct 2026).
test('the check never throws, even when what is thrown is itself hostile (M-1)', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const odd = [revoked.proxy, { get message() { throw new Error('x'); } }, { message: Symbol('s') }, Object.create(null)];
  for (const thrown of odd) {
    const c = Object.defineProperty(change([f('docs/research/a.md')]), 'labels', { get() { throw thrown; } });
    let r;
    assert.doesNotThrow(() => { r = docsLaneProblem(POL, c); });
    assert.match(r, /^could not be read/);
  }
  let r;
  assert.doesNotThrow(() => { r = docsLaneProblem(POL, change([f('docs/research/a.md', 'modified', { mode: revoked.proxy })])); });
  assert.equal(typeof r, 'string');
});

test('each field of the change is read once, so a getter that changes its answer slips nothing past (m-1)', () => {
  for (const [k, answers] of [['labels', [undefined, [], ['needs-joe']]], ['labels', [['needs-joe'], []]], ['truncated', ['yes', false]], ['truncated', [false, true]],
    ['declared_tier', [1, 2]], ['files', [[f('lib/a.ts')], [f('docs/research/a.md')]]]]) {
    let reads = 0;
    const c = change([f('docs/research/a.md')]);
    delete c[k];
    Object.defineProperty(c, k, { get: () => answers[Math.min(reads++, answers.length - 1)], enumerable: true });
    const got = docsLaneProblem(POL, c);
    assert.equal(reads, 1, `${k} read ${reads} times`);
    // The answer is the one the first read gives.
    assert.equal(got === null, check(change([f('docs/research/a.md')], { [k]: answers[0] }).files, { [k]: answers[0] }) === null, `${k}: ${JSON.stringify(answers)}`);
  }
  assert.ok(check([f('docs/research/a.md')], { labels: Array.from({ length: 1001 }, () => 'docs') }), 'over 1000 labels');
});

test('JSON, YAML and markdown other tools read as instructions are not docs (m-2)', () => {
  for (const p of ['docs/research/project.json', 'docs/research/notes.yaml', 'docs/domains/a/b.yml', 'docs/research/settings.json', 'docs/research/mcp.json',
    'docs/research/AGENT.md', 'docs/research/WARP.md', 'docs/research/CRUSH.md', 'docs/research/QWEN.md', 'docs/research/copilot-instructions.md',
    'docs/research/CONVENTIONS.md', 'docs/research/SKILL.md', 'docs/research/commands/x.md', 'docs/research/skills/x/notes.md', 'docs/research/CLAUDE.local.md']) {
    assert.ok(check([f(p)]), p);
  }
});

test('the built-in floor, the exact length and depth edges and an undo\'s kind each hold on their own (m-3)', () => {
  const wide = pol((t) => t.replace('  docs:\n    - docs/*.md\n', '  docs:\n    - docs/**\n'));
  for (const p of ['docs/x.txt', 'docs/x.csv', 'docs/sub/x.md']) assert.ok(check([f(p)], {}, wide), `floor: ${p}`);
  const at = (len) => `docs/research/${'a'.repeat(len - 'docs/research/'.length - 3)}.md`;
  assert.equal(check([f(at(512))]), null, '512 characters');
  assert.ok(check([f(at(513))]), '513 characters');
  const parts = (k) => `docs/research/${'a/'.repeat(k - 3)}x.md`;
  assert.equal(check([f(parts(16))]), null, '16 parts');
  assert.ok(check([f(parts(17))]), '17 parts');
  for (const kind of ['reverse', undefined, 'EXACT_REVERSE']) {
    assert.equal(merge(rulesFor('paused'), [f('docs/research/a.md')], { ...undo('failure'), kind }).decision, 'deny', String(kind));
  }
});

test('round 3: a hostile error message, long labels, a label count that is not a number, a huge path, more instruction and repository-page names', () => {
  const ok = [f('docs/research/a.md')];
  // MAT-1: a message that is text when first read and hostile after.
  let reads = 0;
  const bad = { get message() { reads++; return reads === 1 ? 'ok' : { slice: () => ({ toString() { throw new Error('x'); } }) }; } };
  const c = change(ok); Object.defineProperty(c, 'truncated', { get() { throw bad; } });
  assert.match(docsLaneProblem(POL, c), /^could not be read/);
  assert.equal(reads, 1, 'the message is read once');
  // MAT-2: a long label is refused before it is searched, and quickly.
  const big = 'a'.repeat(10_000_000);
  const t0 = Date.now();
  assert.match(check(ok, { labels: Array(1000).fill(big) }), /over 256 characters/);
  assert.ok(Date.now() - t0 < 1000, 'quick');
  assert.equal(check(ok, { labels: ['a'.repeat(256)] }), null);
  assert.ok(check(ok, { labels: ['a'.repeat(257)] }));
  // m-5: a list whose count is not a whole number.
  for (const n of ['abc', 1.5, -1, NaN]) {
    const l = new Proxy(['needs-joe'], { get: (t, k) => (k === 'length' ? n : t[k]) });
    assert.ok(check(ok, { labels: l }), String(n));
  }
  // m-6: a huge path is cut short in the reason.
  assert.ok(check([f('docs/research/' + 'a'.repeat(1_000_000) + '.md', 'removed')]).length < 300);
  // m-2, m-3.
  for (const p of ['docs/research/IFLOW.md', 'docs/research/CODEBUDDY.md', 'docs/research/x.instructions.md', 'docs/research/x.prompt.md',
    'docs/research/x.agent.md', 'docs/research/x.chatmode.md', 'docs/research/llms.txt', 'docs/research/llms-full.txt', 'docs/CONTRIBUTING.md', 'docs/CODE_OF_CONDUCT.md',
    'docs/SUPPORT.md', 'docs/README.md', 'docs/GOVERNANCE.md']) assert.ok(check([f(p)]), p);
});

test('round 4: huge paths answer quickly on every route, reasons stay short, needs-joe counts anywhere in a label', async () => {
  const { needsJoe } = await import('./classify.mjs');
  const { pathProblem } = await import('./paths.mjs');
  const r = rulesFor();
  // MATERIAL-1: 2,999 paths of 4 MB each, one shared string, refused quickly through the engine.
  const huge = 'docs/research/' + 'a/'.repeat(2_000_000) + 'x.md';
  let t0 = Date.now();
  const d = merge(r, Array(2999).fill({ path: huge, status: 'modified' }));
  assert.equal(d.decision, 'deny');
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.ok(d.reason.length < 300, 'the reason is short');
  t0 = Date.now();
  for (let i = 0; i < 2999; i++) assert.ok(pathProblem(huge));
  assert.ok(Date.now() - t0 < 1000, 'the shared path check is cheap too');
  assert.equal(pathProblem('a/'.repeat(2046) + 'b.md'), null, '4,096 characters is still a path');
  assert.ok(pathProblem('a/'.repeat(2046) + 'bc.md'), 'one more is not');
  // MINOR-1: the engine's own file check never quotes a whole path.
  assert.ok(merge(r, [f('docs/research/' + 'a'.repeat(4000) + '\\x.md')]).reason.length < 300);
  const pushed = r.may('push_branch', { product: 'app', card: { id: 'C-1', rows: [], doc: { lane: 'docs' } }, files: [f('docs/research/' + 'a'.repeat(4000) + '\\x.md')] });
  assert.equal(pushed.decision, 'deny');
  assert.ok(pushed.reason.length < 300, 'push_branch quotes at most 80 characters of a path');
  // M26: the caught message is cut to 200 characters.
  const c = change([f('docs/research/a.md')]); Object.defineProperty(c, 'truncated', { get() { throw new Error('z'.repeat(10_000)); } });
  assert.ok(docsLaneProblem(POL, c).length < 250);
  // M3: needsJoe's own cap, for classify and the deep merge.
  t0 = Date.now();
  const big = 'a'.repeat(10_000_000);
  for (let i = 0; i < 1000; i++) assert.equal(needsJoe(big), '');
  assert.ok(Date.now() - t0 < 1000, 'needsJoe answers a long label without searching it');
  // M7: a label count that is not a whole number, through the engine.
  for (const n of ['abc', 1.5, -1]) {
    const l = new Proxy(['needs-joe'], { get: (t, k) => (k === 'length' ? n : t[k]) });
    assert.equal(merge(r, [f('docs/research/a.md')], { labels: l }).decision, 'deny', String(n));
  }
  // MINOR-2: a prefix before needs-joe still counts; other labels don't.
  for (const l of ['status: needs-joe', 'bot:needs-joe', 'please needs joe']) assert.equal(merge(r, [f('docs/research/a.md')], { labels: [l] }).decision, 'deny', l);
  assert.equal(merge(r, [f('docs/research/a.md')], { labels: ['docs', 'joe-review'] }).decision, 'allow');
});

test('round 5: a file list must give a whole-number count; huge lists answer quickly through the engine; the reader caps and edges are pinned', async () => {
  const { needsJoe } = await import('./classify.mjs');
  const r = rulesFor();
  // MATERIAL-A: a list that lies about its count is refused by the check called directly, and through the engine.
  for (const n of [-1, 'abc', {}, -0.5, 0.5, '1', true]) {
    const files = new Proxy([f('lib/evil.ts'), f('.github/workflows/x.yml')], { get: (t, k) => (k === 'length' ? n : t[k]) });
    assert.ok(docsLaneProblem(POL, change(files)), `direct ${String(n)}`);
    assert.equal(merge(r, files).decision, 'deny', `engine ${String(n)}`);
  }
  // MINOR-1: the reader copies at most 1,000 labels and 3,000 files, so a huge empty list is quick.
  let t0 = Date.now();
  assert.equal(merge(r, [f('docs/research/a.md')], { labels: new Array(50_000_000) }).decision, 'deny');
  assert.equal(merge(r, new Array(50_000_000)).decision, 'deny');
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  // MINOR-2: the docs check runs first, so its reason is the one given; needsJoe's own cap is 256.
  assert.match(merge(r, [f('docs\\research\\a.md')]).reason, /^not this lane's change/);
  assert.equal(needsJoe('a'.repeat(256)), null);
  assert.equal(needsJoe('a'.repeat(257)), '');
});
