// The Mini's one-time setup, part 1 (R-0b-05): which Mac users exist and which folders they own, as data.
// One definition: the setup commands (setup.mjs) and their `check` both read this table, and nothing else lists these
// folders. Nothing here names a product or a person: the base folder, the owner's Mac user and the product names come
// from the config file (README).
//
// Config: { "base": "/Library/<name>", "owner": "<the person's Mac user>", "products": ["<product>", ...] }
//   base      where everything lives. Root's, in a folder only root writes. Never under /Users, /Applications or /tmp: the
//             review runner refuses a wall whose folders sit under a folder anyone else can write (review-runner-main.mjs).
//   owner     the person's own Mac user (their outboxes and worker copies are theirs).
//   products  optional; one folder set per product.

import { join, posix } from 'node:path';

// The three plain-script Mac users (L44, R-0b-05). `review` is also REVIEW_USER in the launcher; the setup test pins them equal.
export const USERS = Object.freeze(['orchestrate', 'pages', 'review']);
export const USER_ID_RANGE = Object.freeze({ low: 301, high: 499 });   // below 500: hidden from the login screen by macOS convention
export const NO_SHELL = '/usr/bin/false';

const NAME = /^[a-z_][a-z0-9_.-]{0,31}$/;
const PRODUCT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE = /^\/[A-Za-z0-9._/-]+$/;
const FORBIDDEN_UNDER = ['/Users', '/Applications', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/Volumes'];

/** The checked config, or a thrown Error naming the first problem. */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: expected an object with base, owner and products');
  const { base, owner, products = [] } = raw;
  if (typeof base !== 'string' || !BASE.test(base) || base.split('/').some((s) => s === '..' || s === '.') || base.includes('//') || base.length > 200) {
    throw new Error('config: base must be a full path of letters, digits and . _ - / only, with no .. and no spaces');
  }
  const b = posix.normalize(base).replace(/\/$/, '');
  if (b.split('/').length < 3) throw new Error('config: base must be a folder of its own, one level below a top-level folder (for example /Library/orchestrate)');
  for (const f of FORBIDDEN_UNDER) if (b === f || b.startsWith(`${f}/`)) throw new Error(`config: base must not be under ${f} (a folder others can write)`);
  if (typeof owner !== 'string' || !NAME.test(owner)) throw new Error('config: owner must be the owner\'s Mac user name');
  if (USERS.includes(owner) || owner === 'root') throw new Error(`config: owner must be the person's own Mac user, not ${owner}`);
  if (!Array.isArray(products) || products.length > 50 || products.some((p) => typeof p !== 'string' || !PRODUCT.test(p)) || new Set(products).size !== products.length) {
    throw new Error('config: products must be a list of distinct names (lowercase letters, digits, dashes)');
  }
  return { base: b, owner, products: [...products] };
}

/** Where a user's home folder is (also what its Mac record names). */
export const homeOf = (cfg, user) => join(cfg.base, 'home', user);

/**
 * Every folder the setup makes, parents first: { path, owner, mode, why }. `owner` is root, one of USERS, or 'owner'
 * (the person's own user). Modes are the exact modes, no more and no less (v4 §14.1.4): the check compares them exactly.
 */
export function folderTable(cfg) {
  const p = (...s) => join(cfg.base, ...s);
  const rows = [
    [cfg.base, 'root', 0o755, 'the base: root\'s, so the folders under it cannot be renamed away'],
    [p('home'), 'root', 0o755, 'the three users\' home folders'],
    ...USERS.map((u) => [homeOf(cfg, u), u, 0o700, `${u}'s home`]),
    [p('keys'), 'orchestrate', 0o700, 'robot keys: nothing else reads them'],
    [p('private'), 'orchestrate', 0o700, 'private data: attempt logs, raw facts before masking'],
    [p('hooks'), 'orchestrate', 0o755, 'hook copies and the rules snapshot: read and run by others, written by orchestrate'],
    [p('settings'), 'orchestrate', 0o755, 'role settings files'],
    [p('launcher'), 'orchestrate', 0o755, 'the launcher'],
    [p('frontdoor'), 'orchestrate', 0o755, 'the Front Door\'s start folder'],
    [p('lead-main'), 'orchestrate', 0o755, 'the Lead\'s read-only copy of main'],
    [p('mirror'), 'orchestrate', 0o755, 'the Do-plane git mirror'],
    [p('bob'), 'orchestrate', 0o755, 'Bob method copies'],
    [p('global-rules'), 'orchestrate', 0o755, 'plain-text copy of the global rules'],
    [p('claude-code'), 'orchestrate', 0o755, 'the roles\' pinned Claude Code copies'],
    [p('review'), 'review', 0o755, 'the review runner\'s folder (its subfolders are made by the runner)'],
    [p('review-outbox'), 'review', 0o755, 'review sessions\' outboxes: only review writes them (L44)'],
    [p('review-copies'), 'review', 0o755, 'the review sessions\' copies of the code under review'],
    [p('worker-copies'), 'owner', 0o755, 'the workers\' clones (kept apart from the review copies)'],
    [p('outboxes'), 'owner', 0o700, 'the roles\' outboxes (one per role, made at launch)'],
    ...(cfg.products.length ? [[p('products'), 'root', 0o755, 'one folder set per product']] : []),
    ...cfg.products.flatMap((prod) => [
      [p('products', prod), 'orchestrate', 0o755, `${prod}: its folders`],
      [p('products', prod, 'store'), 'orchestrate', 0o755, `${prod}: the record (the owner reads it)`],
      [p('products', prod, 'pages'), 'pages', 0o755, `${prod}: built pages (only pages writes them)`],
      [p('products', prod, 'handoffs'), 'orchestrate', 0o755, `${prod}: handoff copies`],
      [p('products', prod, 'pages-in'), 'orchestrate', 0o755, `${prod}: the page builder's input`],
    ]),
  ];
  return rows.map(([path, owner, mode, why]) => ({ path, owner, mode, why }));
}
