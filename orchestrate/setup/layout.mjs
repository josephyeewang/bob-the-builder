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
//   hostLockPath  optional until the Dispatcher is set up; the full path of the owner's host.lock, in the owner's home (L739).

import { join, posix } from 'node:path';
import { AI_ROLES } from '../shared/record.mjs';
// A product name is a folder name setup makes: shared/product-paths.mjs PRODUCT, the one rule (L836, L848, #378 M1).
import { PRODUCT, productRoleClash, runnerPlaces, PRODUCT_OUTBOX_ROLES } from '../shared/product-paths.mjs';
import { RUNNER_ROLES } from '../shared/review-roles.mjs';

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
const BASE = /^\/[A-Za-z0-9._/-]+$/;
// Folders other users can write; compared without regard to case (the Mac's disk treats /users and /Users as one).
// The chain check (guard.mjs) is the real wall: it runs before root changes anything. This only gives a clear early error.
export const FORBIDDEN_UNDER = Object.freeze(['/Users', '/Applications', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/Volumes', '/opt', '/usr/local']);

/** The one owner/name check (L194 m3, L203 m-B): the config loader, watch-rules --print-config-line and watch-run.mjs all use it, so a
 *  line printed is one the loader takes and the hourly job runs. A name may start with a dot (acme/.github); "." and ".." may not be one. */
export const isRepoName = (r) => typeof r === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(r) && !r.split('/').some((x) => x === '.' || x === '..');

/** The checked config, or a thrown Error naming the first problem. */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: expected an object with base, owner and products');
  const { base, owner, products = [], proposalsParent, watch, hostLockPath } = raw;
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
  // A product's outbox folder sits beside the role folders (L836), so no product may be named as a role.
  if (products.some(productRoleClash)) {
    throw new Error('config: a product may not be named as a role (its outbox folder would be that role\'s)');
  }
  if (proposalsParent !== undefined && (typeof proposalsParent !== 'string' || !BASE.test(proposalsParent) || proposalsParent.split('/').some((x) => x === '..' || x === '.') || proposalsParent.includes('//') || proposalsParent.endsWith('/') || proposalsParent.split('/').length < 3 || proposalsParent.length > 200)) {
    throw new Error('config: proposalsParent must be a full path of letters, digits and . _ - / only, in a folder of its own, with no .. and no spaces');
  }
  // The owner's host.lock (L739): a file in the owner's own home, which may hold spaces (a synced folder's name).
  // posix.normalize refuses . and .. segments and doubled slashes: the normal form must be the path as written.
  if (hostLockPath !== undefined && (typeof hostLockPath !== 'string' || !hostLockPath.startsWith(`/Users/${owner}/`) || posix.normalize(hostLockPath) !== hostLockPath
    || hostLockPath.endsWith('/') || /[\u0000-\u001f\u007f]/.test(hostLockPath) || hostLockPath.length > 300)) {
    throw new Error(`config: hostLockPath must be the full path of a file in /Users/${owner}/, with no .. and no control characters`);
  }
  // The watch-only week: `repo` is the repository the token is proven against (prove-token reads it from here, never from the command
  // line) and the one watch-rules prints; `rulesSha256` is the hash of the rules file root put in place (watch-rules), absent until then.
  if (watch !== undefined) {
    const ok = watch && typeof watch === 'object' && !Array.isArray(watch) && Object.keys(watch).every((k) => ['repo', 'rulesSha256', 'app'].includes(k));
    const r = ok ? watch.repo : undefined;
    if (!isRepoName(r)) throw new Error('config: watch.repo must look like owner/name');
    // `app` (L627): the read-only watcher App the job mints its check-run token as. Its key is a file in the keys folder,
    // named here by its bare name, so the config can't point the job at a file anywhere else.
    if (watch.app !== undefined) {
      const a = watch.app; const keys = a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : null;
      if (!keys || keys.length !== 3 || !['id', 'installation', 'keyFile'].every((k) => keys.includes(k))) throw new Error('config: watch.app must have exactly id, installation and keyFile');
      for (const k of ['id', 'installation']) if (typeof a[k] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(a[k])) throw new Error(`config: watch.app.${k} must be the App's number, as a string of digits`);
      if (typeof a.keyFile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.keyFile)) throw new Error('config: watch.app.keyFile must be a bare file name in the keys folder');
    }
    if (watch.rulesSha256 !== undefined && (typeof watch.rulesSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(watch.rulesSha256))) throw new Error('config: watch.rulesSha256 must be 64 hex characters');
  }
  return { base: b, owner, products: [...products], ...(hostLockPath !== undefined ? { hostLockPath } : {}), ...(proposalsParent !== undefined ? { proposalsParent } : {}), ...(watch !== undefined ? { watch: { repo: watch.repo, ...(watch.rulesSha256 !== undefined ? { rulesSha256: watch.rulesSha256 } : {}), ...(watch.app !== undefined ? { app: { ...watch.app } } : {}) } } : {}) };
}

/** Where the proposals folders live (R-0b-128, runbook A7; "a proposal for the owner's OK" until they OK it): one folder per product under this parent. */
export const DEFAULT_PROPOSALS_PARENT = '/Users/Shared/orchestrate-proposals';
export const proposalsParentOf = (cfg) => cfg.proposalsParent ?? DEFAULT_PROPOSALS_PARENT;
/** The folder the owner writes review-again taps into (runner setting `ownerTaps`, runbook A6). */
export const ownerTapsPath = (cfg) => join(cfg.base, 'owner-taps');
/**
 * The owner's answer for the Sensors (L609, L614, L727): the owner's job (wiring/owner-answer.mjs, as the owner) writes
 * its ANSWER_FILE (owner-answer.json) in it, 0644; orchestrate's Sensors read it (sensors-ports.mjs). The owner's, 0755: no
 * group or other write, and orchestrate may list and read it. No access list. The file name is the wiring's, not setup's.
 */
export const ownerAnswerPath = (cfg) => join(cfg.base, 'owner-answer');
/** The Do-plane git mirror; the owner's git is told to trust exactly this path (R-0b-05 done_when, safe.directory). */
export const mirrorPath = (cfg) => join(cfg.base, 'mirror');
/** Where cleanup seals a copy's bundle it could not prove saved (the Dispatcher config's sealRoot, L739). */
export const sealRootPath = (cfg) => join(cfg.base, 'seals');

/**
 * The five Dispatcher config keys the worker and cleanup ports read (wiring/dispatcher-wiring.mjs WORKER_CONFIG_KEYS, L739),
 * from this config: the one place their values come from. hostLockPath is the owner's own file, so it is the config's;
 * hostLockUid is the owner's Mac user id (the reader takes host.lock only when the opened file is that user's, L763), which
 * the caller reads from this Mac (dispatcher-check.mjs dispatcherKeysOn).
 */
export function dispatcherKeys(cfg, { hostLockUid } = {}) {
  if (cfg.hostLockPath === undefined) throw new Error('config: hostLockPath is not set (the full path of the owner\'s host.lock); the Dispatcher can\'t start without it');
  if (!Number.isSafeInteger(hostLockUid) || hostLockUid < 0) throw new Error(`the owner ${cfg.owner} is not a user on this Mac, so host.lock's owner (hostLockUid) can't be named`);
  return { reviewRoot: join(cfg.base, 'review'), mirror: mirrorPath(cfg), sealRoot: sealRootPath(cfg), hostLockPath: cfg.hostLockPath, hostLockUid };
}

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

/** Folders the table below makes that the review runner's config also names (review-config.mjs): one definition each. */
export const keysPath = (cfg) => join(cfg.base, 'keys');
export const privatePath = (cfg) => join(cfg.base, 'private');
export const bobPath = (cfg) => join(cfg.base, 'bob');
export const reviewCopiesPath = (cfg) => join(cfg.base, 'review-copies');
export const workerCopiesPath = (cfg) => join(cfg.base, 'worker-copies');
export const outboxRootPath = (cfg) => join(cfg.base, 'outboxes');
/** A product's Record (the folder table's `products/<prod>/store`, and the runner's recordRoot). */
export const storePath = (cfg, prod) => join(cfg.base, 'products', prod, 'store');
// The rules snapshot the review runner writes for its sessions' hooks (M4 hooks/snapshot.mjs writeSnapshot: written_at,
// hash, rules), in the runner's own folder. Its own name (L731 M2): M10's signed snapshot (snapshot.mjs SNAPSHOT_FILE) is
// another format, not placed yet, and must never share a file name with this one.
export const REVIEW_SNAPSHOT_FILE = 'review-rules-snapshot.json';
// The two items add-to-install puts into the installed copy (L573): the pinned Claude Code (CLAUDE_CODE/<pin>/claude,
// hooks-check.mjs pinnedBinary) and the hook scripts. One spelling each, for review-config and add-to-install alike.
// M4's pinnedBinary spells claude-code once more, as a launcher may not depend on setup; review-config.test.mjs pins the two
// as equal.
export const COPY_CLAUDE_CODE = 'claude-code';
export const COPY_HOOKS = 'hooks';

/** Where a user's home folder is (also what its Mac record names). */
export const homeOf = (cfg, user) => join(cfg.base, 'home', user);

/**
 * The roles whose outbox folders the workers' Mac user owns: every AI role except the roles the review runner starts
 * (RUNNER_ROLES: the review roles and the plan reviewer, L722). A role the runner starts writes as `review`, so its
 * outbox is review's; were it the workers' user's, a worker could write that role's answer.
 */
export const WORKER_ROLES = Object.freeze(AI_ROLES.filter((r) => !RUNNER_ROLES.includes(r)));
/** The roles the worker runner starts (L836): one list, in shared/product-paths.mjs. */
export { PRODUCT_OUTBOX_ROLES };

/**
 * The one access-list entry on a worker role's outbox folder (L90 M2): the record's intake runs as `orchestrate`, so it
 * may list, search and read what is in the folder, with inheritance so the session folders and files made there carry
 * it. Exactly this and nothing else: `check` compares the entry list exactly.
 */
// `delete_child` (L100 m8): the record's intake may clear a hand-in once it is taken in; the worker seals its own file 0440.
export const ORCHESTRATE_READ_ACL = Object.freeze({ who: 'user:orchestrate', perms: Object.freeze(['list', 'search', 'readattr', 'readextattr', 'readsecurity', 'delete_child', 'file_inherit', 'directory_inherit']) });
// The workers' copies (L747, L751): cleanup runs as orchestrate and lists, reads and deletes a card's copy once its checks
// pass, through this one entry, inherited by every file and folder made under it. No add or write. `list` on a folder is
// `read` on the files it holds (an inherited entry shows "read"), and `delete_child` on every folder deletes anything below
// it, so neither `read` (the Mac shows it as `list` on a folder, and the exact check would never pass) nor `delete` (which
// would let orchestrate remove the empty copies folder itself) is in it. A product's own copies folder sits under it
// (L836), so orchestrate can remove that one once it is empty (#378 m7); the start then refuses that product ("setup has
// made no folder") until setup is run again: it fails safe.
// Equal to ORCHESTRATE_READ_ACL's rights today on purpose; kept apart because the two may need to differ.
export const COPIES_CLEANUP_ACL = Object.freeze({ who: 'user:orchestrate', perms: Object.freeze(['list', 'search', 'readattr', 'readextattr', 'readsecurity', 'delete_child', 'file_inherit', 'directory_inherit']) });
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
    [keysPath(cfg), 'orchestrate', 0o700, 'robot keys: nothing else reads them'],
    [privatePath(cfg), 'orchestrate', 0o700, 'private data: attempt logs, raw facts before masking'],
    [p('watch'), 'orchestrate', 0o700, 'the watch-only week: the log of what the Merge Gate would have done, and the rules draft'],
    [watchNotesPath(cfg), 'owner', 0o755, 'the watch-only week\'s written explanations: the owner writes, orchestrate and the summary only read'],
    [p('hooks'), 'orchestrate', 0o755, 'hook copies and the rules snapshot: read and run by others, written by orchestrate'],
    [p('settings'), 'orchestrate', 0o755, 'role settings files'],
    [p('launcher'), 'orchestrate', 0o755, 'the launcher'],
    [p('frontdoor'), 'orchestrate', 0o755, 'the Front Door\'s start folder'],
    [p('lead-main'), 'orchestrate', 0o755, 'the Lead\'s read-only copy of main'],
    [mirrorPath(cfg), 'orchestrate', 0o755, 'the Do-plane git mirror'],
    [ownerTapsPath(cfg), 'owner', 0o755, 'the owner\'s review-again taps (runner setting ownerTaps): the owner writes, others only read, no access list'],
    [ownerAnswerPath(cfg), 'owner', 0o755, 'the owner\'s answer for the Sensors (owner-answer.json, 0644, L727): the owner\'s job writes, orchestrate only reads, no access list'],
    [bobPath(cfg), 'orchestrate', 0o755, 'Bob method copies'],
    [p('global-rules'), 'orchestrate', 0o755, 'plain-text copy of the global rules'],
    [p('claude-code'), 'orchestrate', 0o755, 'the roles\' pinned Claude Code copies'],
    [p('review'), 'review', 0o755, 'the review runner\'s folder (its subfolders are made by the runner)'],
    [reviewCopiesPath(cfg), 'review', 0o755, 'the review sessions\' copies of the code under review'],
    [workerCopiesPath(cfg), 'owner', 0o755, 'the workers\' clones (kept apart from the review copies); orchestrate lists, reads and deletes through one access-list entry (cleanup), never writes', [COPIES_CLEANUP_ACL]],
    [sealRootPath(cfg), 'orchestrate', 0o700, 'cleanup\'s sealed bundles (the Dispatcher\'s sealRoot): orchestrate\'s alone'],
    // The one outbox root (L71): root's, so no role's Mac user can rename another role's folder away. Under it one folder
    // per role, so the record's intake and the Merge Gate read every role through the same root (L90 M1).
    [outboxRootPath(cfg), 'root', 0o755, 'the outbox root (L71): a folder per role and one per product (L836) under it'],
    ...RUNNER_ROLES.map((r) => [join(outboxRootPath(cfg), r), 'review', 0o755, `the ${r}'s outboxes: only review writes them (L44, L722); others read`]),
    ...WORKER_ROLES.map((r) => [join(outboxRootPath(cfg), r), 'owner', 0o750, `the ${r}'s outboxes (the workers' user writes; orchestrate reads through one access-list entry)`, [ORCHESTRATE_READ_ACL]]),
    ...(cfg.products.length ? [[p('products'), 'root', 0o755, 'one folder set per product']] : []),
    // A copies folder and an outbox folder per product (L836): the worker runner denies each session every other
    // product's whole folder. Same owner, mode and access list as the folder above; the product's role folders as the
    // role folders above (the runner starts worker and script sessions).
    // Named by the one rule the runner uses (shared/product-paths.mjs runnerPlaces, #378 r1 m1).
    ...cfg.products.map((prod) => [prod, runnerPlaces({ copiesRoot: workerCopiesPath(cfg), outboxRoot: outboxRootPath(cfg), product: prod })]).flatMap(([prod, at]) => [
      [at.copies, 'owner', 0o755, `${prod}: the workers' clones (cleanup as above)`, [COPIES_CLEANUP_ACL]],
      [at.outboxes, 'root', 0o755, `${prod}: its worker runner outboxes, a folder per worker runner role`],
      ...PRODUCT_OUTBOX_ROLES.map((r) => [join(at.outboxes, r), 'owner', 0o750, `${prod}: the ${r}'s outboxes (as the ${r} folder above)`, [ORCHESTRATE_READ_ACL]]),
    ]),
    ...cfg.products.flatMap((prod) => [
      // Root's (L100 m2): its children belong to different users, and a folder one of them owns could rename another's away.
      [p('products', prod), 'root', 0o755, `${prod}: its folders`],
      [storePath(cfg, prod), 'orchestrate', 0o755, `${prod}: the record (the owner reads it)`],
      [p('products', prod, 'pages'), 'pages', 0o755, `${prod}: built pages (only pages writes them)`],
      [p('products', prod, 'handoffs'), 'orchestrate', 0o755, `${prod}: handoff copies`],
      [p('products', prod, 'pages-in'), 'orchestrate', 0o755, `${prod}: the page builder's input`],
    ]),
  ];
  // `group`: 'root' pins the folder's group to wheel (0) where the mode gives its group any access and the owner is the
  // person's own user, whose Mac group would otherwise be taken as it comes (L100 m1). Set on apply, compared in check.
  return rows.map(([path, owner, mode, why, acl = []]) => ({ path, owner, mode, why, acl, ...(owner === 'owner' && (mode & 0o070) ? { group: 'root' } : {}) }));
}

/** The rules draft the watch-only week judges by (R-0b-122): root's copy, in orchestrate's watch folder; the config holds its hash. */
export const watchRulesPath = (cfg) => join(cfg.base, 'watch', 'rules-draft.yaml');
export const watchNotesPath = (cfg) => join(cfg.base, 'watch-notes');
