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
// of its own here, labeled as policy. A reason that is a known gap in the readers, not in the file (numbers as text,
// M11's scope and pattern reads: known-gaps.mjs), says so on its end; the file is still refused for it.

import { fileURLToPath } from 'node:url';
import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';
import { parsePolicy, EFFECT_FIELDS } from './policy.mjs';
import { checkProducts } from './reader.mjs';
import { makeEngine } from './engine.mjs';
import { makeRules } from '../../shared/rules.mjs';
import * as M6 from '../M6-merge-gate/required-keys.mjs';
import * as M2 from '../M2-approvals/required-keys.mjs';
import * as M9 from '../M9-record/required-keys.mjs';
import { KEYS as M11_KEYS, NEW_KEYS as M11_NEW_KEYS, need } from '../M11-dispatcher/keys.mjs';
import { editingLimits } from '../M11-dispatcher/gate.mjs';
import { PRODUCT_STATES } from './policy.mjs';
import { KNOWN, asNumbers } from './known-gaps.mjs';

// M11 has no required-keys file of its own yet (lane 2's folder), so its entry is built here from M11's own exports:
// every key in KEYS except NEW_KEYS (keys the rules schema can't hold yet; when lane 1 adds one, lane 2 takes it off
// NEW_KEYS and it is checked here with no change), each read by M11's need() with the type and the scope its callers use
// (L115 M-A: with the product, or Mac-wide with none), plus the real editingLimits for every product state.
const M11_TYPES = Object.freeze({ perState: 'object', shakedown: 'boolean', leadDailyCard: 'list', redRuns: 'list' });
// The keys M11's callers read with the product; they read every other key Mac-wide. A test reads the M11 sources and
// fails when a caller's scope and this list differ.
export const M11_WITH_PRODUCT = Object.freeze(['perState', 'editingPerProduct', 'amberEditingPerProduct', 'shakedown',
  'shakedownWorkers', 'readonlyPerSession', 'scriptsPerProduct', 'leadDailyCard']);
export const m11Scope = (name) => (M11_WITH_PRODUCT.includes(name) ? 'product' : 'mac');
const M11_READ = Object.freeze(Object.entries(M11_KEYS).filter(([, k]) => !M11_NEW_KEYS.includes(k)));
// A daily-card pattern M11's own matcher (gate.mjs matches()) would read differently from M10 compile (L115 M-B).
const M11_PATTERN_DIFFERS = (p) => /[{}?,]/.test(p) || p.startsWith('/') || p.endsWith('/') || !p.includes('/');
const M11 = Object.freeze({
  REQUIRED_KEYS: Object.freeze(M11_READ.map(([, k]) => k)),
  policyProblems(rules, product) {
    const out = [];
    const reads = (r, key, opts) => { try { need(r, key, opts); return true; } catch { return false; } };
    for (const [name, key] of M11_READ) {
      const type = M11_TYPES[name] ?? 'number';
      const a = type === 'object' ? 'an' : 'a';
      const withProduct = { product, type };
      if (reads(rules, key, m11Scope(name) === 'product' ? withProduct : { type })) continue;
      // Read Mac-wide, a product key gives nothing on the real engine (L115): a reason of its own.
      if (m11Scope(name) === 'mac' && rules.get(key, {}) === undefined && rules.get(key, { product }) !== undefined) {
        out.push(`M11: ${key} is read without the product, so the real engine gives none${KNOWN.scope}`);
      }
      if (reads(rules, key, withProduct)) continue;
      out.push(`M11: ${key} must be ${a} ${type}${reads(asNumbers(rules), key, withProduct) ? KNOWN.text : ''}`);
    }
    if (!out.some((x) => x.startsWith(`M11: ${M11_KEYS.perState} `))) {
      const limits = (r, state) => { try { editingLimits({ rules: r, product, productDoc: { state }, amberCaps: false }); return true; } catch { return false; } };
      const bad = PRODUCT_STATES.filter((state) => !limits(rules, state));
      const text = bad.every((state) => limits(asNumbers(rules), state));
      if (bad.length) out.push(`M11: ${M11_KEYS.perState} must give a number for ${bad.join(', ')} (editingLimits refuses it)${text ? KNOWN.text : ''}`);
    }
    let daily = [];
    try { daily = need(rules, M11_KEYS.leadDailyCard, { product, type: 'list' }); } catch { /* said above */ }
    for (const p of daily) if (M11_PATTERN_DIFFERS(p)) out.push(`M11: ${M11_KEYS.leadDailyCard}: "${p}" is matched differently by M11 (no { } ? , no leading or trailing /, and it needs a /)${KNOWN.pattern}`);
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
    out.push(`${k} is missing (${by.join(', ')} read${by.length === 1 ? 's' : ''} it)`);
  }
  // Every module's own check runs; a reason about a key already named as missing is not said twice.
  const named = (x) => [...missing].some((k) => x.includes(`${k} `) || x.includes(`${k}.`));
  for (const m of Object.values(READERS)) out.push(...m.policyProblems(rules, product).filter((x) => !named(x)));
  return out;
}
