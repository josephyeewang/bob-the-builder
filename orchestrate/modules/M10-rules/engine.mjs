// engine.mjs — M10 Rules' answers: the implementation that shared/rules.mjs makeRules() wraps.
//
// WHY. Every Do-plane act asks "may X happen?" here first (design v4 §9.2 M10). The answers follow the spec review's
// binding table (0b-1 MAT-5, MAT-8, MAT-10, MAT-11, MIN-1, R2-M5, R2-M8, R2-m7, R3-M3, R3-m9, R3-c2). Each answer
// is checked in the same order: rules unreadable → deny; product state unknown → paused; then the action's own rule.
// makeRules() turns any throw or odd answer into deny, so this file may throw on a malformed subject.
//
//   const impl = makeEngine({ products, rulesState, productState, running, rolesDir, clock });
//   const rules = makeRules(impl);
//     products      ['<product>', …] from products.json (the strictest-wins scope, MAT-10)
//     rulesState(p) → the reader's state(p): { status: ok|last_good|deny_all, policy, commit, blob }
//     productState(p) → the product record's doc ({ state, away?: { tz } }) or null
//     running({ product }) / running({}) → editing sessions running for that product / on the whole Mac
//     rolesDir      the role-profile folder (roles/), loaded against each claude_code.pin
//     clock()       → ms since epoch; the only clock used (subject.now is ignored, R3-m9)

import { allow, ask, deny } from '../../shared/rules.mjs';
import { classifyChange } from './classify.mjs';
import { compileList, pathProblem } from './paths.mjs';
import { PRODUCT_STATES, HOURS, validZone, compareVersions } from './policy.mjs';
import { loadRoles, profileFor } from './roles.mjs';

// Mac-wide keys and how they combine across products (MAT-10, R2-M5(b)). `*` = every key under that map.
export const MAC_MIN = Object.freeze(['caps.editing_per_mac', 'caps.scripts_per_mac', 'caps.script_agents_max',
  'usage.bands.*.*', 'usage.no_tier1_prod_above', 'usage.stale_after_min']);
export const MAC_MAX = Object.freeze(['usage.reserve_pct.*', 'claude_code.required_minimum']);
export const MAC_MATCH = Object.freeze(['claude_code.pin', 'models.*', 'accounts.current', 'accounts.joe.tz']);

export const LANES = Object.freeze(['lead', 'docs', 'product']);
export const REVERSED_AUDIT = Object.freeze(['failure', 'success', 'none']);
const SHA = /^[0-9a-f]{40}$/;
const ROW_FILE = /^docs\/blueprint\/rows\/([^/]+)\.yaml$/;
const BLUEPRINT = compileList(['docs/blueprint/**']);
const DOCS_LANE = compileList(['docs/*.md', 'docs/domains/**', 'docs/research/**']);
const NOT_PRODUCT = compileList(['docs/blueprint/**', 'docs/*.md', 'docs/domains/**']);
const FILE_STATUSES = ['added', 'modified', 'removed', 'renamed', 'copied'];
const USAGE_FUTURE_MS = 60_000;

// What each product state allows, before the file's own product_state_rules (which can only tighten, MAT-8).
const STATE_FLOOR = Object.freeze({
  active: { start: true, editingCap1: false },
  away: { start: true, editingCap1: false },
  light: { start: true, editingCap1: true },
  paused: { start: false, editingCap1: true },
});

function at(obj, path) {
  let v = obj;
  for (const seg of path.split('.')) v = v !== null && typeof v === 'object' && Object.hasOwn(v, seg) ? v[seg] : undefined;
  return v;
}

// Every concrete key a `*` pattern stands for in one policy.
function expand(policy, pattern) {
  const out = [];
  const go = (prefix, obj, segs) => {
    if (!segs.length) { out.push(prefix); return; }
    const [s, ...rest] = segs;
    if (obj === null || typeof obj !== 'object') return;
    for (const k of s === '*' ? Object.keys(obj) : (Object.hasOwn(obj, s) ? [s] : [])) go(prefix ? `${prefix}.${k}` : k, obj[k], rest);
  };
  go('', policy, pattern.split('.'));
  return out;
}

const matches = (list, key) => list.some((pat) => {
  const a = pat.split('.'); const b = key.split('.');
  return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]);
});

export function makeEngine({ products, rulesState, productState, running, rolesDir, clock }) {
  if (!Array.isArray(products) || !products.length) throw new Error('engine needs the product list');
  if (typeof clock !== 'function') throw new Error('engine needs a clock');
  const rolesByPin = new Map();

  const usable = (p) => {
    const s = rulesState(p);
    return s && (s.status === 'ok' || s.status === 'last_good') && s.policy && SHA.test(s.commit ?? '') && SHA.test(s.blob ?? '') ? s : null;
  };
  const known = (p) => typeof p === 'string' && products.includes(p);
  const policyOf = (p) => {
    if (!known(p)) throw new Error(`unknown product "${p}"`);
    const s = usable(p);
    if (!s) throw new Error(`rules unreadable for ${p}`);
    return s.policy;
  };
  const stateOf = (p) => {
    const doc = productState(p);
    return doc && PRODUCT_STATES.includes(doc.state) ? doc.state : 'paused';
  };

  // Mac-wide view: every product's usable rules, or the reason there are none (MAT-10).
  function mac() {
    const all = [];
    for (const p of products) {
      const s = usable(p);
      if (!s) return { ok: false, reason: `rules unusable for ${p}: every start on this Mac is refused` };
      all.push(s.policy);
    }
    for (const pat of MAC_MATCH) {
      const keys = new Set(all.flatMap((pol) => expand(pol, pat)));
      for (const k of keys) {
        const vals = new Set(all.map((pol) => at(pol, k)));
        if (vals.size !== 1 || vals.has(undefined)) return { ok: false, reason: k === 'claude_code.pin' ? 'pin mismatch' : `${k} mismatch across products` };
      }
    }
    return { ok: true, all };
  }

  function macValue(key) {
    const m = mac();
    if (!m.ok) return undefined;
    const vals = m.all.map((pol) => at(pol, key));
    if (vals.some((v) => v === undefined || v === null)) return undefined;
    if (matches(MAC_MATCH, key)) return vals[0];
    if (key === 'claude_code.required_minimum') return vals.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    if (vals.some((v) => typeof v !== 'number')) return undefined;
    return matches(MAC_MIN, key) ? Math.min(...vals) : Math.max(...vals);
  }
  const isMacKey = (key) => matches(MAC_MIN, key) || matches(MAC_MAX, key) || matches(MAC_MATCH, key);

  function roles(pin) {
    if (!rolesByPin.has(pin)) rolesByPin.set(pin, loadRoles(rolesDir, { pin }));
    return rolesByPin.get(pin);
  }

  const count = (scope) => {
    const n = running(scope);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('running count unknown');
    return n;
  };

  function startSession(s) {
    const { product, role, tier, editing } = s;
    if (typeof role !== 'string' || (tier !== 1 && tier !== 2) || typeof editing !== 'boolean') return deny('start_session needs product, role, tier (1 or 2) and editing');
    const pol = policyOf(product);
    const m = mac();
    if (!m.ok) return deny(m.reason);
    const pin = pol.claude_code.pin;

    // Roles (MAT-11).
    if (role === 'explore') return deny('the explore profile is never started by the robot');
    const prof = profileFor(roles(pin), role);
    if (!prof) return deny(`no enabled profile for role "${role}"${roles(pin).ok ? '' : ` (${roles(pin).reason})`}`);
    if (prof.role === 'script' && at(pol, 'roles_enabled.script') !== pin) return deny('the script profile is off until its check passes on this Claude Code version');

    // Product state (MAT-8): the code's floor, then the file's rule, which can only tighten.
    const state = stateOf(product);
    const floor = STATE_FLOOR[state];
    const fileRule = at(pol, `product_state_rules.${state}.start`);
    if (!['within_caps', 'editing_cap_1', 'none'].includes(fileRule)) return deny(`product_state_rules.${state}.start is not a known rule`);
    if (!floor.start || fileRule === 'none') return deny(`product is ${state}: no starts`);

    // Caps (MAT-5, MAT-10). Editing starts only.
    if (editing) {
      let cap = pol.caps.editing_per_product;
      if (!Number.isSafeInteger(cap)) return deny('caps.editing_per_product missing');
      if (floor.editingCap1 || fileRule === 'editing_cap_1') cap = Math.min(cap, 1);
      if (cap === 0) return deny('caps.editing_per_product is 0: no editing starts');
      if (count({ product }) >= cap) return deny(`editing cap reached for ${product} (${cap})`);
      const macCap = macValue('caps.editing_per_mac');
      if (!Number.isSafeInteger(macCap)) return deny('caps.editing_per_mac unusable');
      if (count({}) >= macCap) return deny(`editing cap reached on this Mac (${macCap})`);
    }

    // Tier 1 needs a fresh usage reading (A8).
    if (tier === 1) {
      const staleMin = macValue('usage.stale_after_min');
      const readAt = Date.parse(s.usage?.read_at ?? '');
      const now = clock();
      if (!Number.isFinite(staleMin) || !Number.isFinite(readAt)) return deny('Tier 1 start needs a usage reading');
      if (now - readAt > staleMin * 60_000 || readAt - now > USAGE_FUTURE_MS) return deny('usage reading is stale');
    }
    return allow(`start ${role} on ${product}`);
  }

  // The lane rules (MIN-1, R2-m7, R3-m5). Each touched path (new and old) must lie in the card's lane.
  function outOfLane(pol, card, files) {
    const lane = card?.doc?.lane;
    if (!LANES.includes(lane)) return ['card has no lane'];
    const rows = Array.isArray(card.rows) ? card.rows : [];
    const docsPaths = compileList(pol.docs_paths ?? ['docs/**']);
    const out = [];
    for (const f of files) {
      for (const p of [f.path, ...(f.previous_path !== undefined ? [f.previous_path] : [])]) {
        let ok;
        if (lane === 'product') ok = !NOT_PRODUCT(p);
        else if (lane === 'docs') ok = Boolean(DOCS_LANE(p)) && Boolean(docsPaths(p));
        else {
          const row = ROW_FILE.exec(p);
          if (row) ok = (f.status === 'added' || f.status === 'modified') && rows.includes(row[1]);
          else ok = Boolean(BLUEPRINT(p)) && card.kind === 'lead_daily_card';
        }
        if (!ok) out.push(p);
      }
    }
    return out;
  }

  const checkFiles = (files) => {
    if (!Array.isArray(files) || !files.length) throw new Error('files missing');
    for (const f of files) {
      if (!f || typeof f !== 'object' || !FILE_STATUSES.includes(f.status)) throw new Error('bad file entry');
      const bad = pathProblem(f.path) ?? (f.previous_path !== undefined ? pathProblem(f.previous_path) : null);
      if (bad) throw new Error(`${bad}: ${JSON.stringify(f.path)}`);
    }
  };

  function pushBranch(s) {
    const pol = policyOf(s.product);
    checkFiles(s.files);
    // The exact-reverse exception (R2-M8, R3-M3): every file is in the reversed commit's own list, in every state.
    if (s.card?.kind === 'exact_reverse' && Array.isArray(s.reverses_files)
      && s.files.every((f) => s.reverses_files.includes(f.path) && (f.previous_path === undefined || s.reverses_files.includes(f.previous_path)))) {
      return allow('exact reverse: every file is in the reversed commit');
    }
    const state = stateOf(s.product);
    if (state === 'paused') return deny('product is paused');
    const out = outOfLane(pol, s.card, s.files);
    if (out.length) return deny(`out of lane: ${out.slice(0, 5).join(', ')}`);
    return allow('in lane');
  }

  // Tier-1 hours (R2-M5, R3-c2): home zone, or every away product's trip zone while this product is away.
  function inHours(pol, product) {
    const m = HOURS.exec(pol.merge.queue.tier1_hours);
    if (!m) return false;
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    let zones;
    if (stateOf(product) === 'away') {
      zones = products.filter((p) => stateOf(p) === 'away').map((p) => productState(p)?.away?.tz);
    } else {
      zones = [macValue('accounts.joe.tz')];
    }
    if (!zones.length || zones.some((z) => !validZone(z))) return false;
    const now = new Date(clock());
    return zones.every((tz) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(now).map((x) => [x.type, x.value]));
      const t = Number(parts.hour) * 60 + Number(parts.minute);
      return from <= to ? t >= from && t < to : t >= from || t < to;
    });
  }

  function merge(s) {
    const pol = policyOf(s.product);
    checkFiles(s.files);
    const c = classifyChange(pol, { files: s.files, truncated: s.truncated, declared_tier: s.declared_tier, labels: s.labels });
    const reverse = s.kind === 'exact_reverse' && SHA.test(s.reverses ?? '') && s.exact_reverse_ok === true && REVERSED_AUDIT.includes(s.reversed_audit);
    if (reverse) {
      // R3-M3, in this order. Pause and the hours window never hold an exact reverse.
      if (c.protected.length) return ask(1, 'exact reverse touches a protected file');
      if (s.reversed_audit === 'failure') return allow('exact reverse of a merge whose audit failed');
      if (!c.risky.length && c.tier === 2) return allow('exact reverse of an ordinary change');
      return ask(1, 'exact reverse of a merge whose audit passed');
    }
    const state = stateOf(s.product);
    const fileRule = at(pol, `product_state_rules.${state}.tier1_merge`);
    if (!['rules', 'tier1_hours_only', 'undo_only'].includes(fileRule)) return deny(`product_state_rules.${state}.tier1_merge is not a known rule`);
    if (state === 'paused' || fileRule === 'undo_only') return deny(`product is ${state}: only an exact reverse may merge`);
    if (c.tier === 1 && !inHours(pol, s.product)) return deny('held_tier1_hours');
    if (c.risky.length || c.tier === 1) return ask(1, c.risky.length ? `risky: ${c.risky.join(', ')}` : 'Tier 1');
    return allow('Tier 2, no risky class');
  }

  const ANSWERS = {
    start_session: startSession,
    push_branch: pushBranch,
    merge,
    count_approval: () => deny('not built until 0b-5 (M2)'),
    delete_copy: () => deny('nothing is deleted in 0b (keep, don\'t delete)'),
    write_production: () => deny('production writes are not allowed in this phase'),
    flip_switch: () => deny('the Switch Runner is Phase 2'),
  };

  return Object.freeze({
    get rev() {
      return products.map((p) => { const s = usable(p); return `${p}=${s ? `${s.commit.slice(0, 7)}:${s.blob.slice(0, 7)}` : 'none'}`; }).join(',');
    },
    may(action, subject) {
      if (!subject || typeof subject !== 'object') return deny('no subject');
      return ANSWERS[action](subject);
    },
    get(key, { product } = {}) {
      if (typeof key !== 'string') return undefined;
      if (key === 'rules.adopted') {
        const s = known(product) ? usable(product) : null;
        return s ? Object.freeze({ commit: s.commit, blob: s.blob }) : undefined;
      }
      if (isMacKey(key)) return macValue(key);
      if (!known(product) || !usable(product)) return undefined;
      const v = at(usable(product).policy, key);
      if (v === undefined && key.startsWith('failure_classes.') && key.split('.').length === 2) return 'joe';   // MIN-8
      return v;
    },
    classify(change) {
      return classifyChange(policyOf(change?.product), change);
    },
  });
}
