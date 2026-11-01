// first-cutover.mjs — is a product's rules file fit to be its first-cutover onboarding entry? (R-0b-106a, LEAD-CALLS L17)
//
// WHY. At the first cutover the robot merges only the docs and research lane and starts no editing worker on the
// product; MAIN keeps building its code as today. The entry that turns a product on must say exactly that, and
// nothing that waits on the import scan (R-0b-100, second cutover). A rules file can be valid and still say more
// (a code lane, a cap above 0), so this checks the first-cutover shape on top of parsePolicy. The product's own
// values live in its onboarding pull request, never in Bob; Bob's tests run this on the generic sample.
//
//   firstCutoverProblems(text, entry?) → [] when fit, else every reason it isn't
//   entry = the product's products.json entry { product, owner, repo, joe_github_id }, checked as reader.mjs reads it
//   existing = the Mac's products.json list as it stands, so a reused product name is caught here, not as a Mac-wide deny
//
// The keys other modules need (L86 2, 9; L96): each module that reads the rules exports the keys it reads and a
// policyProblems that calls its own readers (M9 runs its real readyCheck; M11's entry below runs its real need() and
// editingLimits). The fit check takes the union of those lists, says which are missing, and runs each module's check on
// M10's real engine over this file. What is policy rather than a reader's need (a non-empty required_checks) is a line
// of its own here, labeled as policy. A reason that is a known gap in the readers, not in the file (M11's scope reads:
// known-gaps.mjs), says so on its end; the file is still refused for it. Daily-card lists are a rule
// of their own until M11 reads them with compile (L120).

import { fileURLToPath } from 'node:url';
import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';
import { parsePolicy, EFFECT_FIELDS } from './policy.mjs';
import { checkProducts } from './reader.mjs';
import { makeEngine } from './engine.mjs';
import { isMacKey, keyMatches, makeRules, MAC_LIST_ALL } from '../../shared/rules.mjs';
import * as M6 from '../M6-merge-gate/required-keys.mjs';
import * as M2 from '../M2-approvals/required-keys.mjs';
import * as M9 from '../M9-record/required-keys.mjs';
import { KEYS as M11_KEYS, need } from '../M11-dispatcher/keys.mjs';
import { editingLimits } from '../M11-dispatcher/gate.mjs';
import { PRODUCT_STATES } from './policy.mjs';
import { SCOPE_OWNERS, scopeLabel } from './known-gaps.mjs';

// M11 has no required-keys file of its own yet (lane 2's folder), so its entry is built here from M11's own exports:
// every key in KEYS, NEW_KEYS included, each read by M11's need() with its type at the key's own scope, plus the real
// editingLimits for every product state. NEW_KEYS once meant "the rules schema can't hold these yet", and this check
// skipped them; since #79 parsePolicy holds every one, so the skip let a file the Dispatcher can't run on pass (#77 r5
// MAT-1). A test fails if any M11 key is left out here.
const M11_TYPES = Object.freeze({ perState: 'object', shakedown: 'boolean', leadDailyCard: 'list', redRuns: 'list' });
// L120: M11's gate.mjs matches() reads daily-card patterns with a matcher of its own, and no list of forms it reads
// differently from M10 compile was ever complete (`docs/blueprint/**/daily.md`, a leading `**/`, spaces at either end).
// Until lane 2 moves matches() onto compile, any non-empty list is refused, as a rule; L96 already says [] at the first
// cutover. M9's ASCII and compile checks still run, and a list M9 refuses gets only M9's reasons (L120 m-2).
export const DAILY_CARD_RULE = `${M11_KEYS.leadDailyCard}: daily-card file lists are not allowed until the Dispatcher reads them with the rules' own path language (L120)`;
// A key's scope is the rules' own (L131): Mac-wide when shared/rules.mjs isMacKey(key) says so, per product otherwise.
// No list of M11's here: a test reads M11's sources and fails when a caller reads a key at another scope, except a key
// in known-gaps.mjs SCOPE_OWNERS, which M11 still reads Mac-wide (lane 2's L104 sweep) and the check below names.
export const m11Scope = (key) => (isMacKey(key) ? 'mac' : 'product');
const M11_READ = Object.freeze(Object.entries(M11_KEYS));
const M11 = Object.freeze({
  REQUIRED_KEYS: Object.freeze(M11_READ.map(([, k]) => k)),
  policyProblems(rules, product) {
    const out = [];
    const reads = (r, key, opts) => { try { need(r, key, opts); return true; } catch { return false; } };
    for (const [name, key] of M11_READ) {
      const type = M11_TYPES[name] ?? 'number';
      const a = type === 'object' ? 'an' : 'a';
      const withProduct = { product, type };
      // A per-product key M11 still reads Mac-wide (known-gaps.mjs SCOPE_OWNERS): the real Dispatcher gets none (L115).
      if (Object.hasOwn(SCOPE_OWNERS, key) && m11Scope(key) === 'product' && rules.get(key, {}) === undefined && rules.get(key, { product }) !== undefined) {
        out.push(`M11: ${key} is read without the product, so the real engine gives none${scopeLabel(key)}`);
      }
      if (reads(rules, key, m11Scope(key) === 'product' ? withProduct : { type })) continue;
      out.push(`M11: ${key} must be ${a} ${type}`);
    }
    if (!out.some((x) => x.startsWith(`M11: ${M11_KEYS.perState} `))) {
      const limits = (r, state) => { try { editingLimits({ rules: r, product, productDoc: { state }, amberCaps: false }); return true; } catch { return false; } };
      const bad = PRODUCT_STATES.filter((state) => !limits(rules, state));
      if (bad.length) out.push(`M11: ${M11_KEYS.perState} must give a number for ${bad.join(', ')} (editingLimits refuses it)`);
    }
    return out;
  },
});
export const READERS = Object.freeze({ M6, M2, M9, M11 });
export const MODULE_KEYS = Object.freeze([...new Set(Object.values(READERS).flatMap((m) => m.REQUIRED_KEYS))]);
const ROLES_DIR = fileURLToPath(new URL('./roles', import.meta.url));

export const FIRST_LANES = Object.freeze(['docs', 'research']);
// Every effect field read by path alone; package_imports is the import scan's, so the first cutover needs none.
export const PATH_ONLY_EFFECTS = Object.freeze(Object.entries(EFFECT_FIELDS)
  .flatMap(([k, fields]) => fields.filter((f) => f !== 'package_imports').map((f) => [k, f])));

// A lane path must sit inside the docs lane's fixed folders (lane-check.mjs DOCS_FLOOR), or no doc could ever merge.
const IN_FLOOR = /^docs\/(domains\/|research\/|[^/]*\.md$)/;

export function firstCutoverProblems(text, entry, existing = []) {
  const r = parsePolicy(text);
  if (!r.ok) return [`the rules file is corrupt: ${r.reason}`];
  const p = r.policy;
  const out = [];
  // A missing stage reads as first, but the onboarding entry says it, so the second cutover is one visible edit.
  if (parseYaml(text, 'policy.yaml').product?.cutover_stage !== 'first') out.push('product.cutover_stage must say first');
  if (p.caps.editing_per_product !== 0) out.push('caps.editing_per_product must be 0');
  const lanes = Object.keys(p.lanes);
  if (lanes.length !== FIRST_LANES.length || !FIRST_LANES.every((l) => lanes.includes(l))) out.push('lanes must be docs and research only');
  for (const l of FIRST_LANES) {
    if (!Array.isArray(p.lanes[l]) || !p.lanes[l].length) out.push(`lanes.${l} must list at least one path`);
    else for (const pat of p.lanes[l]) if (!IN_FLOOR.test(pat)) out.push(`lanes.${l}: "${pat}" is outside docs/domains/, docs/research/ and docs/*.md`);
  }
  // The script role can write files and is not held by the editing cap, so it stays off at the first cutover.
  const script = p.roles_enabled?.script;
  if (script !== undefined && script !== 'none') out.push('roles_enabled.script must be none');
  for (const [k, f] of PATH_ONLY_EFFECTS) {
    if (!Array.isArray(p.effect_paths[k][f]) || !p.effect_paths[k][f].length) out.push(`effect_paths.${k}.${f} must list at least one path`);
  }
  if (!p.protected_files.length) out.push('protected_files must list at least one path');
  // Policy (L96 m-1): with no required check the gate would check nothing, so the first cutover names at least one.
  const checks = p.product_profile?.required_checks;
  if (Array.isArray(checks) && !checks.length) out.push('product_profile.required_checks must name at least one check (policy)');
  out.push(...moduleProblems(p, typeof entry?.product === 'string' && entry.product ? entry.product : 'product'));
  if (entry !== undefined) {
    let e;
    try { e = checkProducts([...existing, entry]).at(-1); } catch (err) { out.push(`the products.json entry is malformed: ${err.message}`); }
    if (e && e.joe_github_id !== p.accounts.joe.github_id) out.push('the products.json entry and accounts.joe.github_id name different GitHub ids');
  }
  return out;
}

// Every key a module needs, read through M10's real engine as that module reads it.
export function moduleProblems(policy, product) {
  const rules = makeRules(makeEngine({
    products: [product],
    rulesState: () => ({ status: 'ok', policy, commit: '0'.repeat(40), blob: '0'.repeat(40) }),
    productState: () => ({ state: 'active' }),
    running: () => 0,
    rolesDir: ROLES_DIR,
    clock: () => Date.now(),
  }));
  const out = [];
  const missing = new Set(MODULE_KEYS.filter((k) => { const v = rules.get(k, { product }); return v === undefined || v === null; }));
  for (const k of missing) {
    const by = Object.entries(READERS).filter(([, m]) => m.REQUIRED_KEYS.includes(k)).map(([n]) => n);
    // A Mac-wide list the file gives as a plain value: the engine combines lists only, so it gives none (#79); the
    // file's fault is the shape, so the reason says so (L144 m-2).
    const own = k.split('.').reduce((v, s) => (v && typeof v === 'object' && Object.hasOwn(v, s) ? v[s] : undefined), policy);
    const shape = keyMatches(MAC_LIST_ALL, k) && own !== undefined && own !== null && !Array.isArray(own);
    out.push(`${k} ${shape ? 'must be a list' : 'is missing'} (${by.join(', ')} read${by.length === 1 ? 's' : ''} it)`);
  }
  // Every module's own check runs; a reason about a key already named as missing is not said twice.
  const named = (x) => [...missing].some((k) => x.includes(`${k} `) || x.includes(`${k}.`));
  for (const m of Object.values(READERS)) out.push(...m.policyProblems(rules, product).filter((x) => !named(x)));
  let daily;
  try { daily = rules.get(M11_KEYS.leadDailyCard, { product }); } catch { /* said by the readers */ }
  if (Array.isArray(daily) && daily.length && !out.some((x) => x.startsWith(`M9: ${M11_KEYS.leadDailyCard}:`))) out.push(DAILY_CARD_RULE);
  return out;
}
