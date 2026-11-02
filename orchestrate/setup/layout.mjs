// The always-on Mac's one-time setup, part 1 (R-0b-05): which Mac users exist and which folders they own, as data.
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
import { AI_ROLES } from '../shared/record.mjs';
import { REVIEW_ROLES } from '../shared/review-roles.mjs';

// The three plain-script Mac users (L44, R-0b-05). `review` is also REVIEW_USER in the launcher; the setup test pins them equal.
export const USERS = Object.freeze(['orchestrate', 'pages', 'review']);
// New user numbers come from here, a range Apple does not hand out (it uses the low hundreds for its own accounts, and a
// macOS update can add one at any time). What hides these users from the login screen is IsHidden=1, not the number (L90 M5).
export const USER_ID_RANGE = Object.freeze({ low: 600, high: 699 });
export const NO_SHELL = '/usr/bin/false';
// Root takes its orders from ONE file at a fixed place, root's own (NEW-1, L100): never from a home folder, where the
// person's own user could change it between a read-back and the run. The person edits a copy in their home, then a
// single `sudo install -o root -g wheel -m 0644 /dev/stdin <here> < <copy>` puts it here (README; `install` follows links,
// so the copy goes in through stdin, never as a path). Root reads it with mac.mjs `readConfigFile`.
export const ROOT_CONFIG_PATH = '/Library/orchestrate-setup.json';
// The note root leaves in the base the moment it makes it (NEW-1): a base that exists without it was not made by this setup
// and is refused, never adopted. It sits in the base so a second base has its own.
export const BASE_MARKER = '.made-by-setup';
export const baseMarkerPath = (cfg) => join(cfg.base, BASE_MARKER);

const NAME = /^[a-z_][a-z0-9_.-]{0,31}$/;
const PRODUCT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE = /^\/[A-Za-z0-9._/-]+$/;
// Folders other users can write; compared without regard to case (the Mac's disk treats /users and /Users as one).
// The chain check (guard.mjs) is the real wall: it runs before root changes anything. This only gives a clear early error.
export const FORBIDDEN_UNDER = Object.freeze(['/Users', '/Applications', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/Volumes', '/opt', '/usr/local']);

/** The checked config, or a thrown Error naming the first problem. */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: expected an object with base, owner and products');
  const { base, owner, products = [], proposalsParent, watch } = raw;
  if (typeof base !== 'string' || !BASE.test(base) || base.split('/').some((s) => s === '..' || s === '.') || base.includes('//') || base.length > 200) {
    throw new Error('config: base must be a full path of letters, digits and . _ - / only, with no .. and no spaces');
  }
  const b = posix.normalize(base).replace(/\/$/, '');
  if (b.split('/').length < 3) throw new Error('config: base must be a folder of its own, one level below a top-level folder (for example /Library/orchestrate)');
  const lower = b.toLowerCase();
  for (const f of FORBIDDEN_UNDER) if (lower === f.toLowerCase() || lower.startsWith(`${f.toLowerCase()}/`)) throw new Error(`config: base must not be under ${f} (a folder others can write)`);
  if (typeof owner !== 'string' || !NAME.test(owner)) throw new Error('config: owner must be the owner\'s Mac user name');
  if (USERS.includes(owner) || owner === 'root') throw new Error(`config: owner must be the person's own Mac user, not ${owner}`);
  if (!Array.isArray(products) || products.length > 50 || products.some((p) => typeof p !== 'string' || !PRODUCT.test(p)) || new Set(products).size !== products.length) {
    throw new Error('config: products must be a list of distinct names (lowercase letters, digits, dashes)');
  }
  if (proposalsParent !== undefined && (typeof proposalsParent !== 'string' || !BASE.test(proposalsParent) || proposalsParent.split('/').some((x) => x === '..' || x === '.') || proposalsParent.includes('//') || proposalsParent.endsWith('/') || proposalsParent.split('/').length < 3 || proposalsParent.length > 200)) {
    throw new Error('config: proposalsParent must be a full path of letters, digits and . _ - / only, in a folder of its own, with no .. and no spaces');
  }
  // The repository the watch-only token is proven against (prove-token reads it from here, never from the command line): owner/name.
  if (watch !== undefined) {
    const r = watch && typeof watch === 'object' && !Array.isArray(watch) ? watch.repo : undefined;
    if (typeof r !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(r) || r.split('/').some((x) => x === '.' || x === '..')) throw new Error('config: watch.repo must look like owner/name');
  }
  return { base: b, owner, products: [...products], ...(proposalsParent !== undefined ? { proposalsParent } : {}), ...(watch !== undefined ? { watch: { repo: watch.repo } } : {}) };
}

/** Where the proposals folders live (R-0b-128, runbook A7; "a proposal for the owner's OK" until they OK it): one folder per product under this parent. */
export const DEFAULT_PROPOSALS_PARENT = '/Users/Shared/orchestrate-proposals';
export const proposalsParentOf = (cfg) => cfg.proposalsParent ?? DEFAULT_PROPOSALS_PARENT;
/** The folder the owner writes review-again taps into (runner setting `ownerTaps`, runbook A6). */
export const ownerTapsPath = (cfg) => join(cfg.base, 'owner-taps');
/** The Do-plane git mirror; the owner's git is told to trust exactly this path (R-0b-05 done_when, safe.directory). */
export const mirrorPath = (cfg) => join(cfg.base, 'mirror');

/**
 * The proposals folders (R-0b-128, L76 (3)). The parent is root's, 0711 (traverse only): nobody else can rename, remove or
 * list it, and root makes it, so no user can have planted it. Each product's folder is the owner's, 0700: only the owner
 * reads and writes; `orchestrate` reads through the ONE access-list entry (list/search/read, inherited) and cannot write;
 * `review` and everyone else get nothing. A group would not do: the owner's own group (staff) holds every ordinary user of
 * the Mac, so the access list is what gives exactly one extra reader.
 */
export function proposalRows(cfg) {
  const parent = proposalsParentOf(cfg);
  return [
    { path: parent, owner: 'root', mode: 0o711, why: 'the proposals parent: root\'s, traverse only', acl: [] },
    ...cfg.products.map((prod) => ({ path: join(parent, prod), owner: 'owner', mode: 0o700, why: `${prod}: proposals (only the owner writes; orchestrate reads)`, acl: [PROPOSALS_READ_ACL] })),
  ];
}

/** Where a user's home folder is (also what its Mac record names). */
export const homeOf = (cfg, user) => join(cfg.base, 'home', user);

/** The roles whose outbox folders the workers' Mac user owns: every AI role except the review roles (read from the shared lists). */
export const WORKER_ROLES = Object.freeze(AI_ROLES.filter((r) => !REVIEW_ROLES.includes(r)));

/**
 * The one access-list entry on a worker role's outbox folder (L90 M2): the record's intake runs as `orchestrate`, so it
 * may list, search and read what is in the folder, with inheritance so the session folders and files made there carry
 * it. Exactly this and nothing else: `check` compares the entry list exactly.
 */
// `delete_child` (L100 m8): the record's intake may clear a hand-in once it is taken in; the worker seals its own file 0440.
export const ORCHESTRATE_READ_ACL = Object.freeze({ who: 'user:orchestrate', perms: Object.freeze(['list', 'search', 'readattr', 'readextattr', 'readsecurity', 'delete_child', 'file_inherit', 'directory_inherit']) });
// The proposals folders are read only for orchestrate: no delete_child (that is for the outbox folders, which it clears).
export const PROPOSALS_READ_ACL = Object.freeze({ who: 'user:orchestrate', perms: Object.freeze(['list', 'search', 'readattr', 'readextattr', 'readsecurity', 'file_inherit', 'directory_inherit']) });


/** An access-list entry as `ls -le` prints it, with its permissions sorted: "user:orchestrate allow directory_inherit,file_inherit,list,...". */
export const aclText = (e) => `${e.who} allow ${[...e.perms].sort().join(',')}`;

/**
 * Every folder the setup makes, parents first: { path, owner, mode, why, acl }. `owner` is root, one of USERS, or 'owner'
 * (the person's own user). Modes are the exact modes, no more and no less (v4 §14.1.4): the check compares them exactly.
 * `acl` is the exact access list the folder has (no entry at all unless named here): the check compares it exactly, a
 * missing or an extra entry FAILs, and the apply puts it right.
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
    [mirrorPath(cfg), 'orchestrate', 0o755, 'the Do-plane git mirror'],
    [ownerTapsPath(cfg), 'owner', 0o755, 'the owner\'s review-again taps (runner setting ownerTaps): the owner writes, others only read, no access list'],
    [p('bob'), 'orchestrate', 0o755, 'Bob method copies'],
    [p('global-rules'), 'orchestrate', 0o755, 'plain-text copy of the global rules'],
    [p('claude-code'), 'orchestrate', 0o755, 'the roles\' pinned Claude Code copies'],
    [p('review'), 'review', 0o755, 'the review runner\'s folder (its subfolders are made by the runner)'],
    [p('review-copies'), 'review', 0o755, 'the review sessions\' copies of the code under review'],
    [p('worker-copies'), 'owner', 0o755, 'the workers\' clones (kept apart from the review copies)'],
    // The one outbox root (L71): root's, so no role's Mac user can rename another role's folder away. Under it one folder
    // per role, so the record's intake and the Merge Gate read every role through the same root (L90 M1).
    [p('outboxes'), 'root', 0o755, 'the outbox root (L71): one folder per role under it'],
    ...REVIEW_ROLES.map((r) => [p('outboxes', r), 'review', 0o755, `the ${r}'s outboxes: only review writes them (L44); others read`]),
    ...WORKER_ROLES.map((r) => [p('outboxes', r), 'owner', 0o750, `the ${r}'s outboxes (the workers' user writes; orchestrate reads through one access-list entry)`, [ORCHESTRATE_READ_ACL]]),
    ...(cfg.products.length ? [[p('products'), 'root', 0o755, 'one folder set per product']] : []),
    ...cfg.products.flatMap((prod) => [
      // Root's (L100 m2): its children belong to different users, and a folder one of them owns could rename another's away.
      [p('products', prod), 'root', 0o755, `${prod}: its folders`],
      [p('products', prod, 'store'), 'orchestrate', 0o755, `${prod}: the record (the owner reads it)`],
      [p('products', prod, 'pages'), 'pages', 0o755, `${prod}: built pages (only pages writes them)`],
      [p('products', prod, 'handoffs'), 'orchestrate', 0o755, `${prod}: handoff copies`],
      [p('products', prod, 'pages-in'), 'orchestrate', 0o755, `${prod}: the page builder's input`],
    ]),
  ];
  // `group`: 'root' pins the folder's group to wheel (0) where the mode gives its group any access and the owner is the
  // person's own user, whose Mac group would otherwise be taken as it comes (L100 m1). Set on apply, compared in check.
  return rows.map(([path, owner, mode, why, acl = []]) => ({ path, owner, mode, why, acl, ...(owner === 'owner' && (mode & 0o070) ? { group: 'root' } : {}) }));
}
