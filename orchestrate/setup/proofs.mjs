// The R-0b-05 "done when" proofs, run as the builder user (L1079), the workers' user: the worker runner and every session
// it starts run as it (wiring/runner-job.mjs). Before L1079 the workers were the owner's own user, so these ran as the
// owner (L90 m8). Read only: each proof runs `sudo -u builder <program>` from root and changes nothing.
//
// A proof that "it fails" proves nothing if the way of asking is broken, so controls come first and must pass: the
// builder can be run as at all, it CAN write its own copies folder and home, and it CAN list a folder and read a file
// that everyone may (so a "cannot list" or "cannot read" below means the Mac said no, not that the program is broken).
// Each product has its own copies folder and outbox folder (L836): the builder CAN write the copies folder and its worker
// runner roles' outbox folders (where the runner writes: controls too), and can NOT write the product's outbox folder
// itself, which is root's, so no worker can rename one role's folder away and put its own in its place.
//
// Containment (L1078, L1079; BUILD-RULES rule 3, allowed lists): the builder can NOT read the owner's home, another
// user's home, the robot keys, or any production file or secret the product's rules name (the installed review.json's
// rules.production.env_files and rules.secrets.paths). A rules entry that names no file on this Mac (none at all, a
// relative name, a pattern, or a path that is not there) is NOT TRIED, never PASS: nothing was proven about it.
// What counts as "cannot" is an allowed list too (#528 r1 M1): a read or a listing passes only on the Mac's own
// "Permission denied" answer; any other failure (`head` on a folder exits 1 with "Error reading") is FAIL, never PASS. A
// folder is proven both ways: it can't be listed, and it can't be passed through (`test -x`, so 0711 and 0751 are caught).
// A `test -w`/`-x` proof passes only on test's plain "no" (exit 1); its error exit (2) is FAIL.
// Every place is judged by what it reaches, never by its name (#528 r3 M1, L1130): root finds its real place (every link
// along the way followed). When that differs from the name, both are proven, each with the proofs the real target's kind
// takes, and PASS needs both refused: a link under a folder the builder can't enter is refused on the way in, while the
// place it leads to may be open. Just before each proof root looks again; a place whose kind or real place has changed
// since the list was made is NOT TRIED (r3 m1). A place that is not there is NOT TRIED as well: nothing is proven about it.
// What a place reaches includes (#528 r4, L1143): what is inside a folder of secrets (a link in it that leads out is its
// own place, proven the same way; root walks it, and a walk that can't finish is NOT TRIED); a file's other names (a file
// with more than one is NOT TRIED: another name may sit where the builder can go); and the folders above it, on the
// name's way and the real one's, which the builder must neither write nor own, so it can't swap a place mid-run.
// The way is every place met, one link at a time (#528 r5 M-2): a middle link's folder counts. In a shared (sticky) folder
// root itself looks at who owns the name there, its link not followed (#528 r5 M-1): `test -O` would follow it.
// Who owns a place is always root's look, never `test -O` (#528 r6 M-A, M-B, L1168): every place on the way, every folder
// above, and the real place itself; the builder owning one is a FAIL (it could chmod a secret it owns, mode 000 or not, and
// `test -O` answers a silent no for a place the builder owns but can't reach). Root checks it is still the very thing the
// list saw (its inode, m-1), with one name only, and reads its access list: an entry for the builder or a group it is in
// that lets it write, delete, rename or change who may is a FAIL too (m-2).
// And the builder's groups are an allowed list: its own group and the groups macOS gives every local user, nothing else
// (so no later membership, staff above all, quietly opens the owner's home, which macOS makes 0750 to staff). A group
// list that can't be read is a FAIL, never an empty list.

import { basename, dirname, join } from 'node:path';
import { RUNNER_ROLES } from '../shared/review-roles.mjs';
import { runnerPlaces } from '../shared/product-paths.mjs';
import { BUILDER, BUILDER_SHELL, FLAT_OUTBOX_ROLES, PRODUCT_OUTBOX_ROLES, USERS, WORKER_RUNNER_CONFIG, baseMarkerPath, proposalRows, homeOf, outboxRootPath, workerCopiesPath } from './layout.mjs';
import { RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { installPaths } from './install.mjs';
import { aclEntries, readUser } from './users-folders.mjs';

const SUDO = '/usr/bin/sudo';
const TEST = '/bin/test';
const LS = '/bin/ls';
const HEAD = '/usr/bin/head';
const TRUE = '/usr/bin/true';
const ID = '/usr/bin/id';

// The folders the builder must not write: the record, and the code and rules the robots run from.
const NO_WRITE = ['hooks', 'settings', 'launcher', 'lead-main', 'claude-code', 'bob', 'global-rules', 'frontdoor', 'mirror', 'private', 'keys', 'review', 'review-copies', 'worker-runner', 'outboxes', 'install', ...RUNNER_ROLES.map((r) => `outboxes/${r}`)];
/** The groups macOS gives every local user, which open nothing of the owner's (L1079): the builder may be in these and its own group only. */
export const BUILDER_GROUPS_ALLOWED = Object.freeze(['everyone', 'localaccounts', '_lpoperator']);

/**
 * What the proofs need from this Mac besides the config: { ownerHome, rules: { files: [...], why? } }. `files`: the
 * production files and secrets the installed review.json's rules name; `why`: why there are none to try.
 */
export function proofInputs(io, cfg) {
  const o = readUser(io, cfg.owner);
  const ownerHome = o.exists && typeof o.home === 'string' && o.home.startsWith('/') ? o.home : null;
  const lists = (r) => [r?.production?.env_files, r?.secrets?.paths].flatMap((v) => (Array.isArray(v) ? v : []));
  const file = join(installPaths(cfg).installRoot, RUNNER_CONFIG);
  let rules = null; let why = null;
  try { rules = JSON.parse(io.readText(file))?.rules ?? null; } catch (e) { why = `the installed ${file} could not be read (${e?.code ?? 'not JSON'})`; }
  if (!why && !rules) why = `the installed ${file} names no rules`;
  // The builder's sessions run under the worker runner, whose rules are per product (wiring/runner-main.mjs, #528 r3):
  // its installed config's lists are proven too, the union of both. No such file: no worker runner is set up, nothing to
  // add. One that is there but can't be read is said, NOT TRIED, never skipped. A product with no rules adds nothing, by
  // design: the worker runner gives such a product's sessions no production lists to deny (checkRunnerConfig allows rules
  // to be left out, and refuses lists that are there but not lists of text).
  const wfile = join(installPaths(cfg).installRoot, WORKER_RUNNER_CONFIG);
  let worker = []; let workerWhy = null;
  try {
    const prods = JSON.parse(io.readText(wfile))?.products;
    if (!prods || typeof prods !== 'object' || Array.isArray(prods)) workerWhy = `the installed ${wfile} names no products`;
    else worker = Object.values(prods).flatMap((x) => lists(x?.rules));
  } catch (e) { if (e?.code !== 'ENOENT') workerWhy = `the installed ${wfile} could not be read (${e?.code ?? 'not JSON'})`; }
  const all = [...(why ? [] : lists(rules)), ...worker];
  const files = [...new Set(all.filter((x) => typeof x === 'string'))];
  // An entry that is not text is said, one NOT TRIED line each, never dropped (#528 r2): it names no file to try.
  const odd = all.filter((x) => typeof x !== 'string');
  if (!why && !files.length && !odd.length) why = `the product's rules list no production files or secrets (${file}: rules.production.env_files and rules.secrets.paths are empty)`;
  return { ownerHome, rules: { files, odd, why, workerWhy } };
}

/** The proofs: [{ what, args, expect: 'ok' | 'fail', control?, notTried? }]. `args` are what follows `sudo -n -H -u builder`.
 *  A "cannot write" proof shows the state now; that the builder cannot gain write (own it and chmod it) is check's job:
 *  it wants each folder owned by root, orchestrate or review (never the builder), with the exact mode and access list. */
export function proofList(cfg, { ownerHome = null, rules = { files: [], why: 'not read' }, kindOf = () => null, walkOf = () => ({ error: 'not walked' }), stickyOf = () => false, identOf = () => null } = {}) {
  const p = (...s) => join(cfg.base, ...s);
  const B = BUILDER;
  const places = cfg.products.map((prod) => [prod, runnerPlaces({ copiesRoot: workerCopiesPath(cfg), outboxRoot: outboxRootPath(cfg), product: prod })]);
  const notTried = (what, why) => ({ what, args: null, expect: 'fail', notTried: why });
  // What a place reaches (#528 r3 M1, L1130). kindOf(f) → null (not there) or { kind: 'dir' | 'file' | 'error:<why>',
  // real }. `make(at, kind)` gives the proofs for one path; it is called for the name and, when root's real place differs,
  // for that real place too ("where <name> leads"). The kind is the real target's. Each proof keeps what root saw
  // (`look`), so that proveList looks again just before it runs.
  // The folders above a place (#528 r4 m4): the builder can't write one (so it can't swap the place, or a link on the
  // way, while the proofs run) and owns none (an owner can give itself write). In a shared folder everyone may write
  // (the sticky bit: /private/tmp, /Users/Shared) a name can be renamed only by its owner or the folder's, so there the
  // proof is that the builder owns neither. Each folder is proven once (the list drops repeats).
  // The name in a shared folder is judged by root, as it is (#528 r5 M-1): `test -O` follows a link, so a link the
  // builder owns there, leading to a folder it doesn't, would read "does not own"; the link's owner can re-point it.
  // Every place on the way is taken (#528 r5 M-2, c-1): each folder met, a middle link's among them, as root found
  // them one link at a time (`steps`), never the name as written: a `..` that comes after a link goes up from where the
  // link leads, not from the folder the link sits in, as the Mac goes.
  // Who owns each of them, and the place itself, is root's own look (#528 r6 M-A, M-B): `ident` is what root saw when the
  // list was made (m-1), checked again just before.
  const owner = (x) => {
    const d = dirname(x); const shared = x !== '/' && stickyOf(d);
    return { what: `${B} does not own ${x} (root looks, a link not followed, at its owner and its access list${shared ? `; in the shared folder ${d}, the owner of a name can move it, or re-point it if it is a link` : ''})`, ownerOf: x, ident: identOf(x), expect: 'fail', above: true };
  };
  const above = (q) => {
    const out = [];
    for (let c = q; ; c = dirname(c)) {
      out.push(owner(c));
      if (c === '/') break;
      // In a shared (sticky) folder everyone may write; there the owner look on the name is the proof.
      const d = dirname(c);
      if (!stickyOf(d)) out.push({ what: `${B} cannot write ${d} (a folder above a place it must not reach)`, args: [TEST, '-w', d], expect: 'fail', above: true });
    }
    return out;
  };
  // A place's proofs by what is there (a folder: list and pass through; else: read); a link inside a folder is proven
  // so, by its target's kind (#528 r5 m-3). A file can't be written either (#528 r7 mn-1): at 0602, or root:builder 0620,
  // its read is refused while the builder can overwrite it.
  const readMake = (q, k) => (k === 'dir' ? folderProofs(`${B} cannot list ${q}`, q) : [{ what: `${B} cannot read ${q}`, args: [HEAD, '-c', '1', q], expect: 'denied' }, { what: `${B} cannot write ${q}`, args: [TEST, '-w', q], expect: 'fail' }]);
  const walks = new Map();   // each real folder's walk, kept (#528 r5 m-1): a walk that failed stays NOT TRIED for every name that reaches it
  const reach = (what, f, make, { missing = 'not on this Mac: nothing was tried', folderOnly = null, walk = false } = {}) => {
    const l = kindOf(f);
    if (!l) return [notTried(what, missing)];
    if (typeof l.kind !== 'string' || l.kind.startsWith('error:')) return [notTried(what, `root could not look at it (${String(l.kind ?? 'no answer').replace(/^error:/, '')}): nothing was tried`)];   // #528 r1 m8
    if (typeof l.real !== 'string' || !l.real.startsWith('/')) return [notTried(what, 'root could not find where it really is: nothing was tried')];
    if (folderOnly && l.kind !== 'dir') return [notTried(what, folderOnly)];
    if (l.kind === 'file' && l.names > 1) return [notTried(what, `another name for this file exists (it has ${l.names}): through a folder the builder can enter it would read the same file, so nothing was proven`)];   // #528 r4 m3
    // A folder is judged by what is inside it too (#528 r4 m2): a link in it that leads out is its own place, proven the
    // same way; a file in it with another name can't be proven. A walk that can't finish is NOT TRIED. Each real folder is
    // walked once, so links that lead back and forth end.
    let inner = []; let w;
    if (walk && l.kind === 'dir') {
      const first = !walks.has(l.real);
      if (first) walks.set(l.real, walkOf(l.real));
      w = walks.get(l.real);
      if (!w || w.error) return [notTried(what, `root could not look through what is inside it (${w?.error ?? 'no answer'}): nothing was tried`)];
      const inside = (q, k) => readMake(q, k).map((pr) => ({ ...pr, what: `${pr.what} (a link inside ${f})` }));
      if (first) {
        inner = [...w.links.flatMap((x) => reach(`${B} cannot read ${x.at} (a link inside ${f})`, x.at, inside, { walk: true })),
          ...w.named.map((x) => notTried(`${B} cannot read ${x} (inside ${f})`, 'another name for this file exists outside this folder: through a folder the builder can enter it would read the same file, so nothing was proven'))];
      }
    }
    const look = { at: f, kind: l.kind, real: l.real, ...(l.steps ? { steps: l.steps } : {}), ...(w ? { walk: walkSig(w) } : {}) };
    const at = (q, via) => make(q, l.kind).map((pr) => ({ ...pr, what: via ? `${pr.what} (where ${f} leads)` : pr.what, look }));
    // The folders above: every place on the way (steps, from root's look), or, from a look that gives none, the name and the real place.
    const way = [...(l.steps ?? [f]), l.real];
    return [...(l.real === f ? at(f) : [...at(f), ...at(l.real, true)]), ...way.flatMap(above), ...inner];
  };
  const readProof = (f) => {
    const what = `${B} cannot read ${f}`;
    if (!f.startsWith('/')) return notTried(what, 'a relative name, not a place on this Mac: nothing was tried');
    if (/[*?[\]{}]/.test(f)) return notTried(what, 'a pattern, not one file: nothing was tried');
    return reach(what, f, readMake, { walk: true });
  };
  // A folder: it can't be listed (the Mac's own refusal) and it can't be passed through (#528 r1 M1, m3).
  const folderProofs = (what, d) => [{ what, args: [LS, d], expect: 'denied' }, { what: `${B} cannot pass through ${d}`, args: [TEST, '-x', d], expect: 'fail' }];
  const GONE = 'not there: a missing folder can\'t be written or listed by anyone, so nothing was proven';
  const noWrite = (label, d) => reach(label(d), d, (q) => [{ what: label(q), args: [TEST, '-w', q], expect: 'fail' }], { missing: GONE });
  const noList = (label, d, walk = false) => reach(label(d), d, (q) => folderProofs(label(q), q), { missing: GONE, folderOnly: 'not a folder on this Mac: nothing was proven', walk });
  const list = [
    { what: `can run a program as ${B}`, args: [TRUE], expect: 'ok', control: true },
    { what: `${B} CAN write ${workerCopiesPath(cfg)} (the control: "cannot write" below means something)`, args: [TEST, '-w', workerCopiesPath(cfg)], expect: 'ok', control: true },
    { what: `${B} CAN write its own home ${homeOf(cfg, B)}`, args: [TEST, '-w', homeOf(cfg, B)], expect: 'ok', control: true },
    { what: `${B} CAN list ${cfg.base} (the control: "cannot list" below means something)`, args: [LS, cfg.base], expect: 'ok', control: true },
    { what: `${B} CAN read ${baseMarkerPath(cfg)} (the control: "cannot read" below means something)`, args: [HEAD, '-c', '1', baseMarkerPath(cfg)], expect: 'ok', control: true },
    ...places.flatMap(([prod, at]) => [at.copies, ...PRODUCT_OUTBOX_ROLES.map((r) => join(at.outboxes, r))].map((d) => ({ what: `${B} CAN write ${d} (${prod}'s, where the worker runner writes)`, args: [TEST, '-w', d], expect: 'ok', control: true }))),
    ...cfg.products.flatMap((prod) => noWrite((d) => `${B} cannot write the record ${d}`, p('products', prod, 'store'))),
    ...NO_WRITE.flatMap((d) => noWrite((q) => `${B} cannot write ${q}`, p(d))),
    ...places.flatMap(([prod, at]) => noWrite((d) => `${B} cannot write ${prod}'s outbox folder ${d} (root's: its role folders can't be renamed away)`, at.outboxes)),
    ...noList((d) => `${B} cannot read the robot keys (${d})`, p('keys'), true),   // what is inside is walked too (r4 m2)
    ...USERS.filter((u) => u !== B).flatMap((u) => noList((d) => `${B} cannot list ${u}'s home ${d}`, homeOf(cfg, u))),
    ...(!ownerHome ? [{ what: `${B} cannot list the owner's home`, args: null, expect: 'fail', bad: `the owner ${cfg.owner}'s home could not be read from this Mac` }]
      : noList((d) => `${B} cannot list the owner's home ${d}`, ownerHome)),
    // The owner's own sessions' outboxes (#528 r1 m9): the owner's, 0750, with one read entry for orchestrate only.
    ...FLAT_OUTBOX_ROLES.map((r) => join(outboxRootPath(cfg), r)).flatMap((d) => noWrite((q) => `${B} cannot write the owner's outbox folder ${q}`, d)),
    // The proposals folders (#528 r2 m2), from setup's own table (proposalRows, I7): the parent is root's 0711 and each
    // product's is the owner's 0700. The builder can write none, and can list none. One not made yet (`proposals` makes
    // them) is NOT TRIED, as a Dispatcher folder not made yet is (#528 r1 judgement 2): a missing folder proves nothing.
    ...proposalRows(cfg).flatMap((row) => reach(`${B} cannot write or list the proposals folder ${row.path}`, row.path,
      (q) => [{ what: `${B} cannot write the proposals folder ${q}`, args: [TEST, '-w', q], expect: 'fail' },
        { what: `${B} cannot list the proposals folder ${q}`, args: [LS, q], expect: 'denied' }],
      { missing: 'not made yet (sudo node setup.mjs proposals makes it): nothing was tried', folderOnly: 'it is not a folder: nothing was tried' })),
    // The Dispatcher's rules state and approvals (L1112 (3)): orchestrate's alone. Without a dispatcher entry neither exists.
    ...(cfg.dispatcher ? [cfg.dispatcher.rulesStateDir, cfg.dispatcher.approvalsStateDir].flatMap(readProof) : []),
    // review.json's own problem is always said (#528 r4 m1): the worker runner's entries proving fine must not hide that
    // none of review.json's were tried.
    ...(rules.why || !(rules.files.length || rules.odd?.length) ? [notTried(`${B} cannot read the product's production files and secrets`, rules.why ?? 'none named')] : []),
    ...rules.files.flatMap(readProof),
    ...(rules.odd ?? []).map((x) => notTried(`${B} cannot read the rules entry ${String(JSON.stringify(x) ?? typeof x).slice(0, 60)}`, 'it is not text, so it names no file: nothing was tried')),
    ...(rules.workerWhy ? [notTried(`${B} cannot read the worker runner's production files and secrets`, rules.workerWhy)] : []),
  ];
  // A folder above many places is proven once (r4 m4).
  const once = new Set();
  return list.filter((pr) => { if (!pr.above) return true; const k = pr.ownerOf ? `owner\0${pr.ownerOf}` : pr.args.join('\0'); if (once.has(k)) return false; once.add(k); return true; });
}

/** Null, or why the builder's groups are not its own and the allowed ones (L1079). `out`: `id -Gn builder`'s answer. */
export function groupsProblem(r) {
  if (!r || r.status !== 0) return `its groups could not be read (${String(r?.stderr ?? '').trim().slice(0, 100) || `exit ${r?.status}`}), so it is not known that none opens the owner's home`;
  const names = String(r.stdout).trim().split(/\s+/).filter(Boolean);
  if (!names.length) return 'its group list came back empty, which no Mac user has; not known that none opens the owner\'s home';
  if (!names.includes(BUILDER)) return `its own group ${BUILDER} is not among its groups (${names.join(' ').slice(0, 200)})`;
  const extra = names.filter((n) => n !== BUILDER && !BUILDER_GROUPS_ALLOWED.includes(n));
  return extra.length ? `it is in ${extra.join(', ')}, which is not its own group or one macOS gives every local user; take it out (dseditgroup -o edit -d ${BUILDER} -t user <group>)` : null;
}

/** → [{ ok, what, why?, notTried? }]. Reads only. A failed control makes every later proof FAIL as well, since it would prove nothing. */
export function runProofs(io, cfg) {
  const inputs = proofInputs(io, cfg);
  const kindOf = kindOn(io); const walkOf = walkOn(io);
  const out = proveList(io, proofList(cfg, { ...inputs, kindOf, walkOf, stickyOf: stickyOn(io), identOf: identOn(io) }), kindOf, walkOf);
  // Its shell is zsh (#487 r5 m1): the production guard's message shapes are safe as zsh reads them, not as bash 3.2 does.
  const u = readUser(io, BUILDER);
  out.push({ ok: u.exists && u.shell === BUILDER_SHELL, what: `${BUILDER}'s shell is ${BUILDER_SHELL} (its sessions' Bash tool runs it)`, ...(u.exists && u.shell === BUILDER_SHELL ? {} : { why: u.exists ? `its shell is ${u.shell || 'unset'}` : `${BUILDER} is not a user on this Mac` }) });
  const g = groupsProblem(io.run(ID, ['-Gn', BUILDER]));
  out.push({ ok: g === null, what: `${BUILDER}'s groups are its own and the ones macOS gives every local user (${BUILDER_GROUPS_ALLOWED.join(', ')})`, ...(g ? { why: g } : {}) });
  return out;
}

/** What an access-list entry may grant that lets its holder change a place, or swap it: write into it, remove it or
 *  what is in it, change its attributes, or change who may (macOS's own words, as `ls -le` shows them). */
export const ACL_CHANGE = Object.freeze(['write', 'append', 'add_file', 'add_subdirectory', 'delete', 'delete_child', 'writeattr', 'writeextattr', 'writesecurity', 'chown']);
/**
 * Null, why an access list on `p` lets the builder change it (#528 r6 m-2), or { notTried } when root could not read the
 * list. Root reads it with `ls -led`, which looks at a link itself, never through it. An allow entry for the builder, its
 * own group, or a group macOS gives every local user (its only others: groupsProblem) that grants any of ACL_CHANGE.
 */
const UNREADABLE = 'unreadable entry: ';   // aclEntries' own words for a line it can't parse
export function builderAclWhy(io, p) {
  let a; try { a = aclEntries(io, p); } catch (e) { return { notTried: `root could not read its access list (${String(e?.message ?? e).slice(0, 80)})` }; }
  if (a.error) return { notTried: `root ${a.error}` };
  const who = new Set([`user:${BUILDER}`, `group:${BUILDER}`, ...BUILDER_GROUPS_ALLOWED.map((g) => `group:${g}`)]);
  for (const e of a.entries) {
    if (e.startsWith(UNREADABLE)) return { notTried: `root could not read an access-list entry (${e.slice(UNREADABLE.length).slice(0, 62)})` };
    const m = /^(\S+)(?: inherited)? (allow|deny) (\S+)$/.exec(e);
    if (!m || m[2] !== 'allow' || !who.has(m[1])) continue;
    const bad = m[3].split(',').filter((x) => ACL_CHANGE.includes(x));
    if (bad.length) return `an access-list entry lets ${BUILDER} change it (${m[1]} allow ${bad.join(',')}), and must not`;
  }
  return null;
}

/** Null, or why a place is no longer what the list was made from (#528 r3 m1): its kind or its real place changed. */
export function changedWhy(look, now) {
  const was = `${look.kind} at ${look.real}`;
  if (!now) return `it was ${was} when the list was made and is gone now: nothing was proven`;
  if (now.kind !== look.kind || now.real !== look.real) return `it was ${was} when the list was made and is ${now.kind} at ${now.real ?? 'no known place'} now: nothing was proven`;
  if (now.kind === 'file' && now.names > 1) return `another name for this file exists now (it has ${now.names}): nothing was proven`;   // r4 m3
  if (look.steps && JSON.stringify(now.steps) !== JSON.stringify(look.steps)) return `the way to it changed since the list was made (a link on the way now goes elsewhere): nothing was proven`;   // r5 M-2
  return null;
}

/** Runs a proof list as the builder → [{ ok, what, why?, notTried? }]. A failed control makes every later proof FAIL as
 *  well, since it would prove nothing. Each proof made from a look at a place looks again first (#528 r3 m1). */
export function proveList(io, list, kindOf = kindOn(io), walkOf = walkOn(io), { builderUid } = {}) {
  const out = []; let controlsHold = true;
  let uid = builderUid;
  const uidNow = () => { if (uid === undefined) { try { const u = readUser(io, BUILDER); uid = u.exists && Number.isInteger(u.uid) ? u.uid : null; } catch { uid = null; } } return uid; };
  for (const pr of list) {
    if (pr.notTried) { out.push({ ok: false, notTried: true, what: pr.what, why: pr.notTried }); continue; }
    if (pr.bad) { out.push({ ok: false, what: pr.what, why: pr.bad }); continue; }
    if (!controlsHold) { out.push({ ok: false, what: pr.what, why: 'not proven: a control above failed' }); continue; }   // one way of asking is already broken
    // A place's owner and access list, as root sees them, its link not followed (#528 r5 M-1, r6 M-A, M-B, m-1, m-2).
    if (pr.ownerOf) {
      const no = (why) => out.push({ ok: false, notTried: true, what: pr.what, why: `${why}: nothing was proven` });
      const b = uidNow();
      if (b === null) { no(`${BUILDER}'s id could not be read`); continue; }
      if (!pr.ident || pr.ident.ino === undefined) { no('root could not look at it when the list was made'); continue; }
      // Two looks follow (lstat here, `ls -led` below), not one: safe, since the builder can't swap the name between them
      // without write on its folder, which the `test -w` proofs show it lacks (a shared folder: the owner look on the name).
      let st; try { st = io.lstat(pr.ownerOf); } catch (e) { no(`root could not look at it now (${e?.code ?? 'unknown'})`); continue; }
      if (st.ino !== pr.ident.ino || st.dev !== pr.ident.dev) { no('it is not the very thing root saw when the list was made (it was replaced)'); continue; }
      if (!st.isDirectory() && Number(st.nlink ?? 1) > 1) { no(`it has another name (${st.nlink} in all), which may sit where ${BUILDER} can go`); continue; }
      if (Number(st.uid) === b) { out.push({ ok: false, what: pr.what, why: `${BUILDER} owns it${st.isSymbolicLink?.() ? ' (a link it can re-point)' : ''}, and must not: it can give itself any access` }); continue; }
      const acl = builderAclWhy(io, pr.ownerOf);
      if (acl?.notTried) { no(acl.notTried); continue; }
      out.push({ ok: !acl, what: pr.what, ...(acl ? { why: acl } : {}) });
      continue;
    }
    if (pr.look) {
      const ch = changedWhy(pr.look, kindOf(pr.look.at))
        ?? (pr.look.walk !== undefined && walkSig(walkOf(pr.look.real)) !== pr.look.walk ? 'what is inside it changed since the list was made (a link or a file\'s other name came or went): nothing was proven' : null);   // r4 m2
      if (ch) { out.push({ ok: false, notTried: true, what: pr.what, why: ch }); continue; }
    }
    const r = io.run(SUDO, ['-n', '-H', '-u', BUILDER, ...pr.args]);
    const gotOk = r.status === 0;
    if (pr.control) {
      if (!gotOk) controlsHold = false;
      out.push({ ok: gotOk, what: pr.what, ...(gotOk ? {} : { why: `did not work (${String(r.stderr ?? '').trim().slice(0, 100) || `exit ${r.status}`})` }) });
    } else {
      // Only the one "no" passes (#528 r1 M1): the Mac's permission refusal for a read or listing, test's exit 1 for a test.
      const why = gotOk ? `${BUILDER} CAN do this, and must not` : refusedWhy(pr, r);
      out.push({ ok: why === null, what: pr.what, ...(why ? { why } : {}) });
    }
  }
  return out;
}

/**
 * Null when a "must fail" proof's failure is the one "no" it takes, or why it proves nothing (#528 r1 M1, r2 m6). Only
 * the program's own answer counts, word for word: a read or listing must exit 1 saying exactly `<program>: <path>:
 * Permission denied` (sudo's own "Permission denied", or one about another path, is not it); a test must exit 1 and
 * say nothing (a sudo error on the way in exits 1 too, but speaks).
 */
export function refusedWhy(pr, r) {
  const err = String(r?.stderr ?? '').trim(); const said = err.slice(0, 100);
  if (pr.expect === 'denied') {
    const want = pr.args ? `${basename(pr.args[0])}: ${pr.args[pr.args.length - 1]}: Permission denied` : null;
    return r?.status === 1 && want !== null && err === want ? null : `it failed, but not with the Mac's own "Permission denied" for it (${said || `exit ${r?.status}`}), so it is not proven`;
  }
  return r?.status === 1 && err === '' ? null : `test did not answer a plain no (${said || `exit ${r?.status}`}), so it is not proven`;
}

/**
 * What `f` reaches on this Mac, as root sees it: null when it is not there, else { kind, real }. `real` is its real place,
 * every link along the way followed (#528 r3 M1: a link anywhere in the path, not only the last name); `kind` is what is
 * there: 'dir', 'file' (anything else), or 'error:<why>' when root could not look (#528 r1 m8: told as such, never as "not
 * there"). A link is judged by what it leads to (#528 r2 M1). A link that leads nowhere is an error, not "not there".
 */
export const kindOn = (io) => (f) => {
  const gone = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
  const error = (e, ifGone) => ({ kind: gone(e) ? ifGone : `error:${e?.code ?? 'unknown'}`, real: null });
  let st; try { st = io.lstat(f); } catch (e) { return gone(e) ? null : error(e); }
  let real; try { real = io.realpath(f); } catch (e) { return error(e, 'error:a link that leads nowhere'); }
  // Every place on the way, one link at a time (#528 r5 M-2): a middle link's folder is on the way too.
  let h; try { h = hopsOn(io)(f); } catch (e) { return error(e, 'error:a link that leads nowhere'); }
  if (h.real !== real) return { kind: 'error:the way there could not be followed one link at a time', real: null };
  // `names`: how many names a file has (its link count, #528 r4 m3). Each name reaches the same file through its own folders.
  const of = (s) => (s.isDirectory() ? { kind: 'dir', real, steps: h.steps } : { kind: 'file', real, names: Number(s.nlink ?? 1), steps: h.steps });
  if (real === f && !st.isSymbolicLink()) return of(st);
  try { return of(io.stat(real)); } catch (e) { return error(e, 'error:a link that leads nowhere'); }
};

/**
 * The way to `f`, one name at a time, as the Mac goes (#528 r5 M-2): → { real, steps }. `steps`: every place met, real
 * (each in a folder already followed), a link's own place among them, in order. A link is read (readlink) and what it
 * says is followed in turn, so a link in the middle of a chain is met, and so is the folder that holds it. A `..` after a
 * link goes up from where the link leads, not from the link's own folder (#528 r6 cosmetic). Throws as
 * the Mac would: ENOENT, ENOTDIR, ELOOP (more than MAX_HOPS links).
 */
export const MAX_HOPS = 32;
export const hopsOn = (io) => (f) => {
  const strip = (t) => (io.prefix && t.startsWith(`${io.prefix}/`) ? t.slice(io.prefix.length) : t);   // a stand-in Mac's links name real places
  const steps = []; let hops = 0; let cur = '/'; let rest = String(f).split('/').filter(Boolean);
  while (rest.length) {
    const n = rest.shift();
    if (n === '.') continue;
    if (n === '..') { cur = dirname(cur); continue; }
    const p = join(cur, n); const st = io.lstat(p); steps.push(p);
    if (st.isSymbolicLink()) {
      if (++hops > MAX_HOPS) throw Object.assign(new Error('too many links'), { code: 'ELOOP' });
      const t = strip(String(io.readlink(p)));
      if (t.startsWith('/')) cur = '/';
      rest = [...t.split('/').filter(Boolean), ...rest];
    } else {
      if (rest.length && !st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
      cur = p;
    }
  }
  return { real: cur, steps };
};

/**
 * What is inside the folder `d` (a real place), as root sees it (#528 r4 m2): → { links: [{ at, real }], named: [paths] }
 * or { error }. `links`: each link anywhere below whose real place is outside `d` (or that leads nowhere:
 * real null); `named`: each file below with more than one name. Links are not followed into, so the walk ends; a folder
 * with more than WALK_MAX things below it is not walked to the end, and that is an error, never "nothing found".
 */
export const WALK_MAX = 5000;
export const walkOn = (io) => (d) => {
  const links = []; const named = []; const many = new Map(); let seen = 0;
  const inside = (r) => r === d || r.startsWith(d === '/' ? '/' : `${d}/`);
  const aboveD = (s) => s === '/' || d.startsWith(`${s}/`);
  const hops = hopsOn(io);
  const down = (dir) => {
    for (const n of io.list(dir)) {
      if (++seen > WALK_MAX) throw Object.assign(new Error(`more than ${WALK_MAX} things inside`), { code: 'too many' });
      const p = join(dir, n); const st = io.lstat(p);
      if (st.isSymbolicLink()) {
        // It stays in only when every place on its way is inside (#528 r5 M-2): one that leaves through a folder
        // outside and comes back is a way out, and is proven as its own place. The folders above `d` itself are on
        // `d`'s own way (an absolute link goes down through them) and are proven with it.
        let h = null; try { h = hops(p); } catch { /* leads nowhere: kept, with no real place */ }
        if (h === null || !inside(h.real) || !h.steps.every((s) => inside(s) || aboveD(s))) links.push({ at: p, real: h?.real ?? null });
      } else if (st.isDirectory()) down(p);
      else if (Number(st.nlink ?? 1) > 1) {
        // A file with other names (#528 r5 m-4): fine when all its names are inside this folder; else NOT TRIED.
        const k = st.ino === undefined ? `?${p}` : `${st.dev}:${st.ino}`;
        if (!many.has(k)) many.set(k, { want: Number(st.nlink), at: [] });
        many.get(k).at.push(p);
      }
    }
  };
  try { down(d); } catch (e) { return { error: e?.code ?? e?.message ?? 'unknown' }; }
  for (const { want, at } of many.values()) if (at.length < want) named.push(...at);
  return { links, named };
};
/** The same walk as one line of text, to see whether it changed between the list and the proof. */
const walkSig = (w) => JSON.stringify(w);
/** Is `d` a shared folder (the sticky bit), as root sees it, its link followed? Not known → false: the plain "cannot write" proof. */
export const stickyOn = (io) => (d) => { try { return (io.stat(d).mode & 0o1000) !== 0; } catch { return false; } };

/** What root sees at `p` itself, a link not followed (#528 r6 m-1): { dev, ino }, or null when it can't look. */
export const identOn = (io) => (p) => { try { const s = io.lstat(p); return s.ino === undefined ? null : { dev: s.dev, ino: s.ino }; } catch { return null; } };
/** What `--dry-run` prints: the commands, not run, and what will not be tried. */
export const proofCommands = (io, cfg) => {
  const inputs = proofInputs(io, cfg);
  return [...proofList(cfg, { ...inputs, kindOf: kindOn(io), walkOf: walkOn(io), stickyOf: stickyOn(io), identOf: identOn(io) }).map((pr) => (pr.ownerOf ? `root looks at who owns ${pr.ownerOf} and at its access list, a link not followed   (must not be ${BUILDER}, nor let it change it)` : pr.args ? `sudo -n -H -u ${BUILDER} ${pr.args.join(' ')}   (${pr.expect === 'ok' ? 'must work' : pr.expect === 'denied' ? 'must be refused: Permission denied' : 'must fail'})` : `not tried: ${pr.what} (${pr.notTried ?? pr.bad})`)), `${ID} -Gn ${BUILDER}   (its own group and the allowed ones only)`];
};
