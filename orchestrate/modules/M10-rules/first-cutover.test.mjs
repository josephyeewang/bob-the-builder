// first-cutover.test.mjs — a first-cutover onboarding entry (R-0b-106a), on the generic sample product and M10's real
// engine. Run: node --test orchestrate/modules/M10-rules/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules } from '../../shared/rules.mjs';
import { makeEngine } from './engine.mjs';
import { parsePolicy } from './policy.mjs';
import { docsLaneProblem } from './lane-check.mjs';
import { firstCutoverProblems, PATH_ONLY_EFFECTS, MODULE_KEYS, READERS } from './first-cutover.mjs';
import { readyCheck } from '../M9-record/ready.mjs';
import { CARD_CREATORS } from '../M9-record/permissions.mjs';
import { goFreeOn } from '../M9-record/ready.mjs';
import { heartbeatLimit } from '../M9-record/writer.mjs';
import { PRODUCT_STATES } from './policy.mjs';
import { readConfig } from '../M2-approvals/kinds.mjs';
import { botId } from '../M6-merge-gate/gather.mjs';
import { goFreeKinds } from '../M9-record/ready.mjs';
import { KEYS as M11_KEYS, NEW_KEYS as M11_NEW_KEYS, need } from '../M11-dispatcher/keys.mjs';
import { startGate } from '../M11-dispatcher/gate.mjs';
import { bands } from '../M11-dispatcher/usage.mjs';
import { handoffVet } from '../M11-dispatcher/lead-restart.mjs';
import { KNOWN, SCOPE_OWNERS, numeric, scopeLabel } from './known-gaps.mjs';
import { DAILY_CARD_RULE, m11Scope } from './first-cutover.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const swap = (t, from, to) => { assert.ok(t.includes(from), `text has ${from}`); return t.replace(from, to); };
const ENTRY = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };

// Reasons the real readers give today on any rules file, each a known gap in the readers, not in the file, and labeled
// so in the check's own output (known-gaps.mjs; L96 m-D, L115). They go as these land:
//   - numbers as text (L96): lane 2's M11 sweep (context.*, caps.per_state). (The heartbeat's went with #79: this check
//     now calls writer.mjs heartbeatLimit, which reads through num(), L123.)
//   - M11's Mac-wide reads of per-product keys (L115 M-A, L131): lane 2's L104 sweep passes the product at the four
//     context.* reads. (usage.red_runs's went with #79, which made it Mac-wide in shared/rules.mjs.)
// The test 'the pending reasons are exactly these' then fails, and this list is cut to what is left; at [] the todo
// test below passes.
const SCOPE = (k) => `M11: ${k} is read without the product, so the real engine gives none${scopeLabel(k)}`;
const TEXT = (k) => `M11: ${k} must be a number${KNOWN.text}`;
const PENDING = Object.freeze([
  SCOPE('context.lead.soft'), TEXT('context.lead.soft'),
  SCOPE('context.lead.hard'), TEXT('context.lead.hard'),
  SCOPE('context.handoff_cap.role'), TEXT('context.handoff_cap.role'),
  SCOPE('context.worker.split_after_compactions'), TEXT('context.worker.split_after_compactions'),
  `M11: caps.per_state must give a number for active, away, paused, light (editingLimits refuses it)${KNOWN.text}`,
]);
// The keys the pending reasons are about, by gap.
const keyOf = (x) => x.match(/^M(?:9|11): (\S+) /)[1];
const PENDING_SCOPE = PENDING.filter((x) => x.endsWith(KNOWN.scopeContext)).map(keyOf);
const PENDING_TEXT = PENDING.filter((x) => x.endsWith(KNOWN.text)).map(keyOf);
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
      lead_daily_card: []
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
// How M11's sources read each KEYS entry: name → the scopes ('product' | 'mac') its need()/minutes() calls use, read
// from the files' text, independent of first-cutover.mjs's own list (L115 M-A).
// Its limits (L120 c-3): it reads only calls written `need(rules, KEYS.x, { … })` or `minutes(rules, …)` with the
// object written inline. A call whose first argument is not named `rules`, a key passed through a variable or an
// options object built elsewhere is not read; `unread` counts the `(rules, ` calls it could not read, and the test
// below needs 0. `{ product: undefined }` or `{ product: null }` is read as no product.
const M11_DIR = join(here, '../M11-dispatcher');
const M11_SOURCES = readdirSync(M11_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'keys.mjs');
export function m11SourceScopes(files = Object.fromEntries(M11_SOURCES.map((f) => [f, readFileSync(join(M11_DIR, f), 'utf8')]))) {
  const scopes = new Map();
  let calls = 0;
  let matched = 0;
  for (const text of Object.values(files)) {
    calls += [...text.matchAll(/\b(?:need|minutes)\(rules, /g)].length;
    for (const m of text.matchAll(/\b(?:need|minutes)\(rules, KEYS\.(\w+)(?:, (\{[^}]*\}))?\)/g)) {
      matched += 1;
      const scope = m[2] && /\bproduct\b/.test(m[2]) && !/\bproduct\s*:\s*(?:undefined|null)\b/.test(m[2]) ? 'product' : 'mac';
      scopes.set(m[1], new Set([...(scopes.get(m[1]) ?? []), scope]));
    }
  }
  return { scopes, unread: calls - matched };
}

// What the modules' real readers say about a rules file, called here on their own, not through the fit check:
// M2's readConfig; M6's botId, its required-checks read (a list of check names, gather.mjs:142) and goFreeKinds for
// undo cards; M9's readyCheck on an undo card in each product state; M11's real startGate for every session kind, its
// bands() and handoff check, and need() on every other key it reads (but NEW_KEYS) at the type and the scope its
// sources use (L115 M-A). The pending gaps are mended first (a Mac-wide read of a pending scope key gets the product's
// value, a pending number given as text is made a number), so the rest of each reader is still tested.
function readersAccept(text) {
  const real = rulesOf(text);
  if (!real) return false;
  const product = 'sample-app';
  const p = { product };
  const rules = {
    get: (k, o) => {
      let v = real.get(k, o);
      if (v === undefined && !o?.product && PENDING_SCOPE.includes(k)) v = real.get(k, p);
      return PENDING_TEXT.includes(k) ? numeric(v) : v;
    },
    classify: (c) => real.classify(c),
  };
  const checks = rules.get('product_profile.required_checks', p);
  const m2 = readConfig(real, product).ok;
  const m6 = botId(real.get('product_profile.robot', p)) !== null && Array.isArray(checks) && checks.every((c) => typeof c === 'string' && c)
    && goFreeKinds(real, product).includes('exact_reverse');
  const creator = Object.keys(CARD_CREATORS).find((a) => CARD_CREATORS[a].includes('exact_reverse'));
  const m9 = PRODUCT_STATES.every((state) => {
    const view = { get: (e) => (e === 'product' ? { id: product, doc: { state } } : null), list: () => [], createdBy: () => creator };
    const r = readyCheck({ id: 'C-t', doc: { product, kind: 'exact_reverse', round: 1, depends_on: [] } }, view, { rules: real, product });
    return r.ok || / no work starts$/.test(r.reason);
  });
  const rec = { read: (e) => (e === 'product' ? { doc: { state: 'active' } } : null), list: () => [] };
  const card = { id: 'C-1', product, kind: 'editing', tier: 2, files: ['docs/research/note.md'] };
  const b = { band: 'green', own_building: 'open', prodBlocked: false };
  const gate = START_KINDS.every((kind) => !startGate({ rules, rec, card, kind, product, b, running: [], lead: 'S-lead' }).missing);
  const fine = (f) => { try { f(); return true; } catch { return false; } };
  const others = fine(() => bands({ rules, reading: { ok: false, reason: 'no reading' }, now: 0 }))
    && fine(() => handoffVet(rules)({ kind: 'handoff', text: 'x' }));
  const { scopes } = m11SourceScopes();
  const m11 = Object.entries(M11_KEYS).filter(([, k]) => !M11_NEW_KEYS.includes(k)).every(([name, key]) => [...(scopes.get(name) ?? [])].every((scope) => {
    try { need(rules, key, { ...(scope === 'product' ? p : {}), type: M11_TYPE[name] ?? 'number' }); return true; } catch { return false; }
  }));
  return m2 && m6 && m9 && gate && others && m11;
}
const M11_TYPE = { perState: 'object', shakedown: 'boolean', leadDailyCard: 'list', redRuns: 'list' };
const START_KINDS = ['editing', 'undo', 'overnight', 'script', 'readonly', 'review', 'audit', 'merge', 'undo_merge', 'lead', 'front_door'];

const GO_FREE_BLOCK = '    go_free:\n      exact_reverse: true\n      lead_daily_card: []\n';
// The fixture's daily-card list, [] (L96), made into a list of the patterns given.
const DAILY = (...pats) => (t) => swap(t, '      lead_daily_card: []\n', `      lead_daily_card:\n${pats.map((p) => `        - ${p}\n`).join('')}`);
const L120 = 'no daily-card list until the Dispatcher reads it with compile (L120)';
// The forms the L115 list missed (L120), and the forms it named (L115 M-B), each as YAML text.
const DAILY_FORMS = ['docs/blueprint/**/daily.md', "'**/daily.md'", "'docs/**/**'", "' docs/x.md'", "'docs/x.md '",
  'docs/daily/', "'docs/{daily,weekly}/**'", 'daily.md', "'docs/dail?.md'", '/docs/x.md'];
// [name, make, policy]: a policy variant is one the fit check refuses on purpose while today's readers accept it; the
// third field says whose rule it is.
const VARIANTS = [
  ['as given', (t) => t],
  ['no go_free', (t) => swap(t, GO_FREE_BLOCK, '')],
  ['go_free in the list form', (t) => swap(t, GO_FREE_BLOCK, '    go_free: [exact_reverse]\n')],
  ['go_free without exact_reverse', (t) => swap(t, '      exact_reverse: true\n', '')],
  ['no lead_daily_card', (t) => swap(t, '      lead_daily_card: []\n', '')],
  ['one daily-card pattern', DAILY('docs/blueprint/daily/**'), L120],
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
  // #79 put goFreeOn in goFreeKinds, so the readers refuse it too: the L115 M-C tripwire fired, and it is no longer a policy line.
  ['exact_reverse: false', (t) => swap(t, 'exact_reverse: true', 'exact_reverse: false')],
  ['ordinary: true, so the Lead\'s cards skip the go', (t) => swap(t, '      exact_reverse: true\n', '      exact_reverse: true\n      ordinary: true\n'), 'go_free values: only the known kinds'],
  ['research_copy: yes', (t) => swap(t, '      exact_reverse: true\n', '      exact_reverse: true\n      research_copy: yes\n'), 'go_free values: a flag is true or false'],
  ['an empty daily-card pattern', DAILY("''"), 'M10\'s pattern rule (L96 m-3)'],
  ['an unclosed { in a daily-card pattern', DAILY("'docs/{a'"), 'M10\'s pattern rule (L96 m-3)'],
  ['a non-ASCII daily-card pattern', DAILY('docs/dé/**'), 'M10\'s pattern rule (L96 m-3)'],
  ['a good daily-card pattern, then a bad one', DAILY('docs/blueprint/daily/**', "''"), 'M10\'s pattern rule (L96 m-3)'],
  // L120: every form, the ones L115 named and the ones it missed, is refused by the one rule.
  ...DAILY_FORMS.map((pat) => [`the daily-card pattern ${pat}`, DAILY(pat), L120]),
];

test('the pending reasons are exactly these, on the fixture as given, and each says it is known (L96 m-D, L115)', () => {
  assert.deepEqual(firstCutoverProblems(FIRST, ENTRY), [...PENDING]);
  for (const x of PENDING) assert.ok(Object.values(KNOWN).some((k) => x.endsWith(k)), x);
  // Each label is real text a reader sees, naming its ruling (an empty label would match every reason).
  for (const [name, k] of Object.entries(KNOWN)) assert.match(k, /^ \(known: .+, L\d+; waits on .+\)$/, name);
  // L120 c-2: each label's ruling, and the owner it waits on.
  assert.deepEqual(Object.fromEntries(Object.entries(KNOWN).map(([n, k]) => [n, k.match(/, (L\d+); waits on (.+)\)$/).slice(1)])), {
    text: ['L96', 'step 2'], scopeContext: ['L115', 'lane 2\'s L104 sweep'],
  });
  // usage.red_runs's gap went with #79 (L131): it is Mac-wide in the rules, and M11 reads it so.
  assert.equal(scopeLabel('usage.red_runs'), '');
  assert.equal(scopeLabel('context.lead.soft'), KNOWN.scopeContext);
  // L125 c-1: owners are named key by key; any other key gets no label, so it can't pass as known.
  for (const k of ['caps.readonly_per_session', 'timeouts.cancel_grace_min', 'anything.at.all', 'context.other', 'constructor']) assert.equal(scopeLabel(k), '', k);
  assert.deepEqual(Object.keys(SCOPE_OWNERS), PENDING_SCOPE, 'the map names exactly the pending scope gaps');
  for (const x of PENDING) assert.match(x, / \(known: /, x);
  assert.deepEqual(PENDING_SCOPE, ['context.lead.soft', 'context.lead.hard', 'context.handoff_cap.role', 'context.worker.split_after_compactions']);
});

// L131: the fit check reads each key at the rules' own scope (shared/rules.mjs isMacKey), and M11's sources must read it
// there too (L105 (2)), but for the known gaps in SCOPE_OWNERS, which must still be gaps. NEW_KEYS are skipped.
test('the fit check reads each M11 key at the rules\' own scope, and M11\'s sources read it there but for the known gaps (L131, L115 M-A)', () => {
  const { scopes, unread } = m11SourceScopes();
  assert.equal(unread, 0, 'every need()/minutes() call in M11 names a KEYS entry the scan can read');
  for (const k of ['usage.red_runs', 'usage.bands.red.pace', 'caps.editing_per_mac']) assert.equal(m11Scope(k), 'mac', k);
  for (const k of ['caps.per_state', 'caps.readonly_per_session', 'context.lead.soft', 'approvals.plan_go.go_free.lead_daily_card']) assert.equal(m11Scope(k), 'product', k);
  const gaps = [];
  let checked = 0;
  for (const [name, key] of Object.entries(M11_KEYS)) {
    if (M11_NEW_KEYS.includes(key)) continue;
    const src = [...(scopes.get(name) ?? [])];
    if (!src.length) continue;
    checked += 1;
    if (Object.hasOwn(SCOPE_OWNERS, key)) {
      assert.equal(m11Scope(key), 'product', `${key}: a known gap is a per-product key`);
      assert.deepEqual(src, ['mac'], `${key}: M11 now reads it ${src.join(' and ')}, so it comes off SCOPE_OWNERS`);
      gaps.push(key);
      continue;
    }
    assert.deepEqual(src, [m11Scope(key)], `${name}: M11 reads it ${src.join(' and ')}, the rules make it ${m11Scope(key)}`);
  }
  assert.ok(checked >= 15, `checked ${checked}`);
  assert.deepEqual(gaps, Object.keys(SCOPE_OWNERS), 'every known gap is one M11 still has');
  // The O1 and O2 plants, on copies: a caller that drops its product, or one that adds it, fails the match.
  const gate = readFileSync(join(M11_DIR, 'gate.mjs'), 'utf8');
  const drop = (from, to) => { assert.ok(gate.includes(from)); return m11SourceScopes({ 'gate.mjs': gate.replace(from, to) }).scopes; };
  assert.deepEqual([...drop('need(rules, KEYS.readonlyPerSession, { product })', 'need(rules, KEYS.readonlyPerSession)').get('readonlyPerSession')], ['mac']);
  assert.deepEqual([...drop("need(rules, KEYS.leadDailyCard, { product, type: 'list' })", "need(rules, KEYS.leadDailyCard, { type: 'list' })").get('leadDailyCard')], ['mac']);
  assert.deepEqual([...drop("need(rules, KEYS.redRuns, { type: 'list' })", "need(rules, KEYS.redRuns, { product, type: 'list' })").get('redRuns')], ['product']);
  assert.equal(m11SourceScopes({ 'x.mjs': 'need(rules, key)' }).unread, 1);
  // L120 c-3: a product written as undefined or null is no product.
  for (const v of ['undefined', 'null']) assert.deepEqual([...m11SourceScopes({ 'x.mjs': `need(rules, KEYS.redRuns, { product: ${v}, type: 'list' })` }).scopes.get('redRuns')], ['mac'], v);
  assert.deepEqual([...m11SourceScopes({ 'x.mjs': "need(rules, KEYS.redRuns, { product: p, type: 'list' })" }).scopes.get('redRuns')], ['product']);
});

// Since #79 usage.red_runs is read Mac-wide and gives [undo], so no start is refused for it. The starts that read
// caps.per_state (editing, overnight, undo) are refused for its numbers as text (the KNOWN.text gap, lane 2's M11 sweep);
// when that sweep lands this test fails, and the todo below can pass.
test('the real startGate refuses editing, overnight and undo on the fixture today, for caps.per_state, and no start for usage.red_runs (L115 M-A, L131)', () => {
  const rules = rulesOf(FIRST);
  const rec = { read: (e) => (e === 'product' ? { doc: { state: 'active' } } : null), list: () => [] };
  const card = { id: 'C-1', product: 'sample-app', kind: 'editing', tier: 2, files: ['docs/research/note.md'] };
  const b = { band: 'green', own_building: 'open', prodBlocked: false };
  const got = Object.fromEntries(START_KINDS.map((kind) => [kind, startGate({ rules, rec, card, kind, product: 'sample-app', b, running: [], lead: 'S-lead' }).missing ?? null]));
  const PER_STATE = ['editing', 'overnight', 'undo'];
  assert.deepEqual(got, Object.fromEntries(START_KINDS.map((kind) => [kind, PER_STATE.includes(kind) ? 'caps.per_state' : null])));
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
  assert.deepEqual(fits, ['as given']);
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
  // A Mac-wide list key the products give as a plain value: the real engine combines lists only, so it gives none (#79).
  assert.deepEqual(fit(swap(FIRST, '  red_runs: [undo]\n', '  red_runs: undo\n'), ENTRY), ['usage.red_runs is missing (M11 reads it)']);
});

test('go_free values are read: only the known kinds, a flag exactly true or false (L96 m-2)', () => {
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m(FIRST)]));
  assert.deepEqual(fit(by['exact_reverse: false'], ENTRY), ['M6: approvals.plan_go.go_free.exact_reverse must be true at the first cutover']);
  assert.deepEqual(fit(by['ordinary: true, so the Lead\'s cards skip the go'], ENTRY), ['M9: approvals.plan_go.go_free.ordinary is not a go-free kind (only exact_reverse, research_copy, lead_daily_card)']);
  assert.deepEqual(fit(by['research_copy: yes'], ENTRY), ['M9: approvals.plan_go.go_free.research_copy must be true or false']);
  // The text a rules file gives ("true") is read as true; research_copy: true is a known kind.
  assert.deepEqual(fit(swap(FIRST, '      exact_reverse: true\n', '      exact_reverse: true\n      research_copy: true\n'), ENTRY), []);
  const rules = rulesOf(FIRST);
  assert.equal(goFreeOn(rules, 'sample-app', 'exact_reverse'), true);
  assert.equal(goFreeOn(rulesOf(by['one daily-card pattern']), 'sample-app', 'lead_daily_card'), true, 'a pattern kind is go-free when its value is a list');
  assert.equal(goFreeOn(rules, 'sample-app', 'research_copy'), false, 'a kind the map does not name');
  assert.equal(goFreeOn(rulesOf(swap(FIRST, '      lead_daily_card: []\n', '      lead_daily_card: docs/x\n')), 'sample-app', 'lead_daily_card'), false, 'a pattern kind whose value is not a list');
  assert.equal(goFreeOn(rulesOf(by['exact_reverse: false']), 'sample-app', 'exact_reverse'), false);
  assert.equal(goFreeOn(rules, 'sample-app', 'lead_daily_card'), false, '[] means no daily card, so not go-free (L115 m-F)');
  assert.equal(goFreeOn(rulesOf(by['ordinary: true, so the Lead\'s cards skip the go']), 'sample-app', 'ordinary'), false);
});

test('daily-card patterns: M9\'s pattern rule, then no list at all until M11 reads it with compile (L96 m-3, L120)', () => {
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m(FIRST)]));
  // L120 m-2: a list M9 refuses gets only M9's reasons.
  assert.deepEqual(fit(by['an empty daily-card pattern'], ENTRY), ['M9: approvals.plan_go.go_free.lead_daily_card: "" can\'t be read: empty pattern']);
  assert.deepEqual(fit(by['an unclosed { in a daily-card pattern'], ENTRY), ['M9: approvals.plan_go.go_free.lead_daily_card: "docs/{a" can\'t be read: unclosed { in pattern "docs/{a"']);
  // L115 m-C: the ASCII line, and every pattern in the list, not only the first.
  assert.deepEqual(fit(by['a non-ASCII daily-card pattern'], ENTRY), ['M9: approvals.plan_go.go_free.lead_daily_card: "docs/dé/**" is not a plain-ASCII pattern']);
  assert.deepEqual(fit(by['a good daily-card pattern, then a bad one'], ENTRY), ['M9: approvals.plan_go.go_free.lead_daily_card: "" can\'t be read: empty pattern']);
  // L120: one list-level reason, worded as a rule, for every list M9 accepts; [] passes.
  assert.equal(DAILY_CARD_RULE, 'approvals.plan_go.go_free.lead_daily_card: daily-card file lists are not allowed until the Dispatcher reads them with the rules\' own path language (L120)');
  assert.doesNotMatch(DAILY_CARD_RULE, /known:/);
  assert.deepEqual(fit(by['one daily-card pattern'], ENTRY), [DAILY_CARD_RULE]);
  for (const pat of DAILY_FORMS) assert.deepEqual(fit(by[`the daily-card pattern ${pat}`], ENTRY), [DAILY_CARD_RULE], pat);
  assert.deepEqual(fit(DAILY('docs/a/**', 'docs/b/**')(FIRST), ENTRY), [DAILY_CARD_RULE], 'one reason for the list, not one per pattern');
  // L125 m-1: a map entry is named, not printed (yaml-lite's map can't become text), and the check does not crash.
  const listOf = (body) => swap(FIRST, '      lead_daily_card: []\n', `      lead_daily_card:${body}`);
  assert.deepEqual(fit(listOf('\n        - a: b\n'), ENTRY), PRINT_MAP);
  // L125 c-3: a plain value instead of a list gets the "list" reasons only: no rule, no label.
  assert.deepEqual(fit(listOf(' docs/x.md\n'), ENTRY), PRINT_SCALAR);
  assert.deepEqual(fit(FIRST, ENTRY), []);
});

// L125 m-1: a map entry in the daily list (lane 2's M11 says "must be a list" too: c-2, its own wording).
const PRINT_MAP = [
  'M9: approvals.plan_go.go_free.lead_daily_card: a non-text entry is not a plain-ASCII pattern',
  'M11: approvals.plan_go.go_free.lead_daily_card must be a list',
];
// L125 c-3: a plain value instead of a list: both "list" reasons, and neither the L120 rule nor a known label.
const PRINT_SCALAR = [
  'M9: approvals.plan_go.go_free.lead_daily_card must be a list of file patterns',
  'M11: approvals.plan_go.go_free.lead_daily_card must be a list',
];

test('the fit check refuses a file without go_free, naming it (the L86 plant)', () => {
  assert.deepEqual(fit(VARIANTS[1][1](FIRST), ENTRY), [
    'approvals.plan_go.go_free is missing (M6, M9 read it)',
    'approvals.plan_go.go_free.lead_daily_card is missing (M11 reads it)',
  ]);
});

test('go_free in the list form is refused: one map serves goFreeKinds and M11\'s need() together (L86 9)', () => {
  const list = VARIANTS[2][1](FIRST);
  // Since #79, goFreeKinds reads each kind through goFreeOn, so the list form gives M9 and M6 no go-free kind either.
  assert.deepEqual(goFreeKinds(rulesOf(list), 'sample-app'), [], 'M9 and M6 read no kind from the list form');
  assert.throws(() => need(rulesOf(list), M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }), /no value/);
  assert.ok(fit(list, ENTRY).some((x) => /must be a map/.test(x)));
  // The map form: both readers get what they need from the same file.
  const rules = rulesOf(FIRST);
  // lead_daily_card: [] names no daily card, so it is not go-free (goFreeOn, L115 m-F; #79).
  assert.deepEqual(goFreeKinds(rules, 'sample-app'), ['exact_reverse']);
  assert.deepEqual(need(rules, M11_KEYS.leadDailyCard, { product: 'sample-app', type: 'list' }), []);
});

test('a draft with its FILL markers left in is refused for each one it must be', () => {
  // A draft's FILLs: bot_user_id null, required_checks [], lead_daily_card []. The last is allowed, and is the fixture's
  // own value (L96 m-1, L120).
  const by = Object.fromEntries(VARIANTS.map(([n, m]) => [n, m]));
  const draft = [by['a null bot id'], by['no required checks']].reduce((t, f) => f(t), FIRST);
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

// L123 O3: the fit check's heartbeat line is writer.mjs's own heartbeatLimit, so it refuses exactly what the writer can't
// use: 0, a negative, a fraction or a word, and a missing key; a whole number of minutes passes.
test('the heartbeat limit is refused exactly when writer.mjs heartbeatLimit gives none (L123 O3)', () => {
  const HB = 'M9: proposals.heartbeat_stale_min must be a whole number of minutes, at least 1';
  const at = (v) => swap(FIRST, 'heartbeat_stale_min: 30', `heartbeat_stale_min: ${v}`);
  for (const v of ['0', '-1', '1.5', 'abc', "''"]) {
    assert.equal(heartbeatLimit(rulesOf(at(v)), 'sample-app'), undefined, v);
    assert.ok(fit(at(v), ENTRY).includes(HB), `${v}: ${fit(at(v), ENTRY).join(' | ')}`);
  }
  for (const v of ['1', '30', '240']) {
    assert.equal(heartbeatLimit(rulesOf(at(v)), 'sample-app'), Number(v), v);
    assert.deepEqual(fit(at(v), ENTRY), [], v);
  }
});

test('L120 m-1: a value that is wrong, not a number given as text, gets no known label', () => {
  const noLabel = (text, key) => {
    const got = firstCutoverProblems(text, ENTRY).filter((x) => x.includes(key) && !PENDING.includes(x));
    assert.ok(got.length, `${key} is refused`);
    for (const x of got) assert.doesNotMatch(x, /\(known: /, x);
  };
  noLabel(swap(FIRST, 'heartbeat_stale_min: 30', 'heartbeat_stale_min: 0'), 'proposals.heartbeat_stale_min');
  noLabel(swap(FIRST, 'heartbeat_stale_min: 30', 'heartbeat_stale_min: abc'), 'proposals.heartbeat_stale_min');
  noLabel(swap(FIRST, '    light: 1\n', '    light: abc\n'), 'caps.per_state');
  assert.equal(numeric(' 3'), ' 3', 'a number with a space stays text');
  assert.equal(numeric('3 '), '3 ');
  assert.deepEqual(numeric({ light: ' 3', away: '1' }), { light: ' 3', away: 1 });
});
