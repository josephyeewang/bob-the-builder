// from-text.mjs — real rules from rules-file text, for tests in any module (lead call L104).
//
// WHY. The rules file is text and its reader converts only some keys, so a test that hands a module JS numbers and
// true/false tests a reader that never runs. This builds the rules exactly as a running Mac does: parsePolicy over
// the text, the real engine, makeRules. A text the checker refuses throws, with the checker's reason.
//
//   const rules = rulesFromText(yaml)                         // one product, named 'app'
//   const rules = rulesFromText({ app: yaml, web: yaml2 })    // several products (Mac-wide keys combine)
//   rules.engine.noProductReads                               // per-product keys read with no product (L104 O-1)
//     options: { running = () => 0, productState = () => ({ state: 'active' }), clock, rolesDir }

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules } from '../../shared/rules.mjs';
import { makeEngine } from './engine.mjs';
import { parsePolicy } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const COMMIT = 'c'.repeat(40);
const BLOB = 'b'.repeat(40);

export function rulesFromText(texts, { running = () => 0, productState = () => ({ state: 'active' }),
  clock = () => Date.parse('2026-10-14T14:00:00Z'), rolesDir = join(here, 'roles') } = {}) {
  const byProduct = typeof texts === 'string' ? { app: texts } : texts;
  if (!byProduct || typeof byProduct !== 'object' || !Object.keys(byProduct).length) throw new Error('rulesFromText needs rules text');
  const policies = {};
  for (const [p, text] of Object.entries(byProduct)) {
    const r = parsePolicy(text);
    if (!r.ok) throw new Error(`rules text for ${p} refused: ${r.reason}`);
    policies[p] = r.policy;
  }
  const engine = makeEngine({
    products: Object.keys(policies),
    rulesState: (p) => ({ status: 'ok', policy: policies[p], commit: COMMIT, blob: BLOB }),
    productState, running, rolesDir, clock,
  });
  const rules = makeRules(engine);
  return Object.freeze({ ...Object.fromEntries(['may', 'get', 'num', 'dec', 'flag', 'classify'].map((k) => [k, rules[k]])),
    get rev() { return rules.rev; }, engine });
}
