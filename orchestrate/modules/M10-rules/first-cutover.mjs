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

import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';
import { parsePolicy, EFFECT_FIELDS } from './policy.mjs';
import { checkProducts } from './reader.mjs';

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
  const checks = p.product_profile?.required_checks;
  if (!Array.isArray(checks) || !checks.length || !checks.every((c) => typeof c === 'string' && c)) out.push('product_profile.required_checks must name at least one check');
  if (!p.protected_files.length) out.push('protected_files must list at least one path');
  if (entry !== undefined) {
    let e;
    try { e = checkProducts([...existing, entry]).at(-1); } catch (err) { out.push(`the products.json entry is malformed: ${err.message}`); }
    if (e && e.joe_github_id !== p.accounts.joe.github_id) out.push('the products.json entry and accounts.joe.github_id name different GitHub ids');
  }
  return out;
}
