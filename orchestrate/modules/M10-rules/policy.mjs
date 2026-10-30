// policy.mjs — read and check a product's rules file (orchestrate/policy.yaml). Pure: text in, verdict out.
//
// WHY. A rules file that is half-right is worse than none: it would let through what Joe meant to stop. So the
// file is either fully valid, or it is "corrupt" and the reader keeps the last good version (reader.mjs). What
// counts as corrupt is the binding list from spec review 0b-1, MAT-2; the key list is design v4 §14.1.6.
//
//   parsePolicy(text) → { ok: true, policy } | { ok: false, reason }
//
// Parsing uses Bob's strict YAML subset reader (scripts/blueprint/yaml-lite.mjs), which refuses anchors, flow maps,
// tabs and duplicate keys. It returns every value as a string, so numbers and versions are converted here.

import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';
import { RISKY_CLASSES } from '../../shared/rules.mjs';
import { STATES, FINAL_STATES, timeoutFor } from '../../shared/record.mjs';
import { compile } from './paths.mjs';
import { EFFECT_KEYS } from './classify.mjs';

export const MIN_CLAUDE_CODE = '2.1.295';
// The one list of rules-file keys (0b-1 round 2, R2-m1): dotted path → whether it must be there, and its shape.
// A top-level key not listed here makes the file corrupt. Nested keys listed here are checked when present (or
// always, if required); other nested keys are free-form, read by the module that owns them.
export const KEYS = Object.freeze({
  tiers: { required: true, type: 'map' }, 'tiers.paths': { required: true, type: 'list' },
  protected_files: { required: true, type: 'list' }, lanes: { required: true, type: 'map' },
  risky_acts: { required: true, type: 'list' }, effect_paths: { required: true, type: 'map' },
  caps: { required: true, type: 'map' }, usage: { required: true, type: 'map' },
  product_state_rules: { required: true, type: 'map' }, failure_classes: { required: true, type: 'map' },
  timeouts: { required: true, type: 'map' }, audit_sizing: { required: true, type: 'map' },
  claude_code: { required: true, type: 'map' }, 'claude_code.pin': { required: true, type: 'text' },
  'claude_code.required_minimum': { required: false, type: 'text' },
  accounts: { required: true, type: 'map' }, 'accounts.current': { required: true, type: 'text' },
  'accounts.joe.github_id': { required: true, type: 'text' }, 'accounts.joe.tz': { required: true, type: 'text' },
  models: { required: true, type: 'map' },
  merge: { required: true, type: 'map' }, 'merge.queue.tier1_hours': { required: true, type: 'text' },
  product: { required: false, type: 'map' }, 'product.cutover_stage': { required: false, type: 'text' },
  approvals: { required: false, type: 'map' }, 'approvals.decisions_dir': { required: false, type: 'text' },
  product_profile: { required: false, type: 'map' }, 'product_profile.required_checks': { required: false, type: 'list' },
  'product_profile.audit_workflow': { required: false, type: 'map' },
  repairs: { required: false, type: 'map' }, 'repairs.max_statements': { required: false, type: 'text' },
  roles_enabled: { required: false, type: 'map' }, onboarding: { required: false, type: 'map' },
  switches: { required: false, type: 'map' }, ladder: { required: false, type: 'map' },
  effort_floor: { required: false, type: 'map' }, waiting: { required: false, type: 'map' },
  bob: { required: false, type: 'map' }, proposals: { required: false, type: 'map' },
  live_check: { required: false, type: 'map' }, jobs_ref: { required: false, type: 'text' },
  shadow_run: { required: false, type: 'map' }, weekly_checks: { required: false, type: 'map' },
  quality: { required: false, type: 'map' }, learning: { required: false, type: 'map' },
  light_exit: { required: false, type: 'map' }, context: { required: false, type: 'map' },
});
export const TOP_KEYS = Object.freeze(Object.keys(KEYS).filter((k) => !k.includes('.')));
export const REQUIRED_KEYS = Object.freeze(TOP_KEYS.filter((k) => KEYS[k].required));
export const CUTOVER_STAGES = Object.freeze(['first', 'second']);
export const PRODUCT_STATES = Object.freeze(['active', 'away', 'paused', 'light']);
export const FAILURE_ACTIONS = Object.freeze(['retry', 'quarantine', 'joe']);
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INT = /^(0|[1-9]\d*)$/;
const DEC = /^(0|[1-9]\d*)(\.\d+)?$/;
const VERSION = /^\d+\.\d+\.\d+$/;

class Corrupt extends Error {}
const bad = (msg) => { throw new Corrupt(msg); };

export function compareVersions(a, b) {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function parsePolicy(text) {
  try {
    if (typeof text !== 'string') bad('not text');
    // yaml-lite stores keys on plain objects, so `__proto__:` would silently become a prototype: refuse it first.
    const banned = /^\s*(?:-\s+)?(?:"|')?(__proto__|constructor|prototype)(?:"|')?\s*:/m.exec(text);
    if (banned) bad(`banned key "${banned[1]}"`);
    let raw;
    try { raw = parseYaml(text, 'policy.yaml'); } catch (e) { bad(e.message); }
    if (!isMap(raw)) bad('not a map of keys');
    walk(raw, 'policy');
    return { ok: true, policy: check(raw) };
  } catch (e) {
    return { ok: false, reason: e instanceof Corrupt ? e.message : `checker error: ${e.message}` };
  }
}

function isMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }

function walk(v, where) {
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
  if (v !== null && typeof v === 'object') {
    if (!isMap(v)) bad(`${where} has an odd shape`);
    for (const k of Object.keys(v)) { if (BANNED_KEYS.has(k)) bad(`banned key "${k}"`); walk(v[k], `${where}.${k}`); }
  }
}

const need = (obj, key, where) => (isMap(obj) && Object.hasOwn(obj, key) && obj[key] !== null ? obj[key] : bad(`${where}.${key} missing`));
const int = (v, where) => (typeof v === 'string' && INT.test(v) ? Number(v) : bad(`${where} must be a whole number ≥ 0`));
const dec = (v, where) => (typeof v === 'string' && DEC.test(v) ? Number(v) : bad(`${where} must be a number ≥ 0`));
const pct = (v, where) => { const n = dec(v, where); return n <= 100 ? n : bad(`${where} must be 0–100`); };
const strList = (v, where) => (Array.isArray(v) && v.every((s) => typeof s === 'string' && s) ? v : bad(`${where} must be a list of text`));
const patterns = (v, where) => { strList(v, where); for (const p of v) { try { compile(p); } catch (e) { bad(`${where}: ${e.message}`); } } return v; };
const mapOf = (v, where) => (isMap(v) ? v : bad(`${where} must be a map`));

function check(raw) {
  for (const k of Object.keys(raw)) {
    if (k === 'ask_first') bad('ask_first is retired (risky_acts replaces it)');
    if (!TOP_KEYS.includes(k)) bad(`unknown key "${k}"`);
  }
  for (const [path, { required, type }] of Object.entries(KEYS)) {
    const segs = path.split('.');
    let v = raw;
    for (const seg of segs) v = isMap(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
    if (v === undefined || v === null) { if (required) bad(`${path} missing`); continue; }
    const ok = type === 'map' ? isMap(v) : type === 'list' ? Array.isArray(v) : typeof v === 'string';
    if (!ok) bad(`${path} must be a ${type === 'text' ? 'single value' : type}`);
  }
  const stage = raw.product?.cutover_stage;
  if (stage !== undefined && !CUTOVER_STAGES.includes(stage)) bad('product.cutover_stage must be first or second');
  const p = structuredClone(raw);

  const tierPaths = need(raw.tiers, 'paths', 'tiers');
  if (!Array.isArray(tierPaths)) bad('tiers.paths must be a list');
  p.tiers.paths = tierPaths.map((t, i) => {
    const pattern = need(t, 'pattern', `tiers.paths[${i}]`);
    patterns([pattern], `tiers.paths[${i}].pattern`);
    const tier = need(t, 'tier', `tiers.paths[${i}]`);
    if (tier !== '1' && tier !== '2') bad(`tiers.paths[${i}].tier must be 1 or 2`);
    return { pattern, tier: Number(tier) };
  });

  patterns(raw.protected_files, 'protected_files');
  for (const [lane, pats] of Object.entries(mapOf(raw.lanes, 'lanes'))) patterns(pats, `lanes.${lane}`);

  const risky = strList(raw.risky_acts, 'risky_acts');
  if (risky.length !== new Set(risky).size || risky.length !== RISKY_CLASSES.length || !RISKY_CLASSES.every((c) => risky.includes(c))) {
    bad('risky_acts must be exactly the fixed list (changing it is a code and decision-log change)');
  }

  const ep = mapOf(raw.effect_paths, 'effect_paths');
  for (const k of EFFECT_KEYS) {
    const entry = mapOf(need(ep, k, 'effect_paths'), `effect_paths.${k}`);
    for (const [field, v] of Object.entries(entry)) {
      if (field === 'package_imports') strList(v, `effect_paths.${k}.${field}`);
      else if (Array.isArray(v)) patterns(v, `effect_paths.${k}.${field}`);
    }
  }

  for (const [k, v] of Object.entries(mapOf(raw.caps, 'caps'))) {
    if (k === 'per_state' || k === 'budget_per_card') continue;
    p.caps[k] = int(v, `caps.${k}`);
  }

  const u = mapOf(raw.usage, 'usage');
  for (const band of ['amber', 'red']) {
    for (const [k, v] of Object.entries(mapOf(need(need(u, 'bands', 'usage'), band, 'usage.bands'), `usage.bands.${band}`))) {
      p.usage.bands[band][k] = k === 'pace' ? dec(v, `usage.bands.${band}.pace`) : pct(v, `usage.bands.${band}.${k}`);
    }
  }
  for (const [k, v] of Object.entries(mapOf(need(u, 'reserve_pct', 'usage'), 'usage.reserve_pct'))) p.usage.reserve_pct[k] = pct(v, `usage.reserve_pct.${k}`);
  p.usage.no_tier1_prod_above = pct(need(u, 'no_tier1_prod_above', 'usage'), 'usage.no_tier1_prod_above');
  p.usage.stale_after_min = int(need(u, 'stale_after_min', 'usage'), 'usage.stale_after_min');

  const psr = mapOf(raw.product_state_rules, 'product_state_rules');
  for (const s of PRODUCT_STATES) mapOf(need(psr, s, 'product_state_rules'), `product_state_rules.${s}`);

  for (const [cls, action] of Object.entries(mapOf(raw.failure_classes, 'failure_classes'))) {
    if (!FAILURE_ACTIONS.includes(action)) bad(`failure_classes.${cls} must be one of ${FAILURE_ACTIONS.join(', ')}`);
  }

  // Every state that isn't final has a time limit or a named reason for having none (A4, MAT-12), read through the
  // one shared reader so M9 and M10 can't disagree on the shape (0b-2 round 2, R2-M1).
  const to = mapOf(raw.timeouts, 'timeouts');
  p.timeouts = {};
  for (const [entity, states] of Object.entries(STATES)) {
    p.timeouts[entity] = {};
    for (const s of states.filter((x) => !FINAL_STATES[entity].includes(x))) {
      const row = timeoutFor(raw, entity, s);
      if (!row) bad(`timeouts.${entity}.${s} missing or malformed`);
      p.timeouts[entity][s] = row;
    }
  }
  for (const entity of Object.keys(to)) if (!Object.hasOwn(STATES, entity)) bad(`timeouts.${entity} is not a record entity`);

  const as = mapOf(raw.audit_sizing, 'audit_sizing');
  for (const k of ['tier1', 'prose', 'rendered', 'exit_tests']) need(as, k, 'audit_sizing');

  const cc = mapOf(raw.claude_code, 'claude_code');
  const pin = need(cc, 'pin', 'claude_code');
  if (typeof pin !== 'string' || !VERSION.test(pin)) bad('claude_code.pin must be a version like 2.1.300');
  if (compareVersions(pin, MIN_CLAUDE_CODE) < 0) bad(`claude_code.pin must be at least ${MIN_CLAUDE_CODE}`);
  if (Object.hasOwn(cc, 'required_minimum') && !(typeof cc.required_minimum === 'string' && VERSION.test(cc.required_minimum))) bad('claude_code.required_minimum must be a version');

  const joe = mapOf(need(raw.accounts, 'joe', 'accounts'), 'accounts.joe');
  p.accounts.joe.github_id = int(need(joe, 'github_id', 'accounts.joe'), 'accounts.joe.github_id');
  const tz = need(joe, 'tz', 'accounts.joe');
  if (!validZone(tz)) bad('accounts.joe.tz must be a time-zone name like America/New_York');
  if (typeof need(raw.accounts, 'current', 'accounts') !== 'string') bad('accounts.current must be text');

  const models = mapOf(raw.models, 'models');
  for (const k of ['main', 'sonnet', 'haiku']) if (typeof need(models, k, 'models') !== 'string') bad(`models.${k} must be text`);

  const hours = need(need(need(raw, 'merge', 'policy'), 'queue', 'merge'), 'tier1_hours', 'merge.queue');
  if (!(typeof hours === 'string' && HOURS.test(hours))) bad('merge.queue.tier1_hours must look like 07:00-22:00');

  return deepFreeze(nullProto(p));
}

export const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;

export function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Copy into objects with no prototype, so no key can ever resolve to something inherited (R2-M3(b)).
function nullProto(v) {
  if (Array.isArray(v)) return v.map(nullProto);
  if (v && typeof v === 'object') {
    const o = Object.create(null);
    for (const k of Object.keys(v)) o[k] = nullProto(v[k]);
    return o;
  }
  return v;
}

function deepFreeze(v) {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) deepFreeze(v[k]); Object.freeze(v); }
  return v;
}
