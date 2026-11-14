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
// And the builder's groups are an allowed list: its own group and the groups macOS gives every local user, nothing else
// (so no later membership, staff above all, quietly opens the owner's home, which macOS makes 0750 to staff). A group
// list that can't be read is a FAIL, never an empty list.

import { basename, join } from 'node:path';
import { RUNNER_ROLES } from '../shared/review-roles.mjs';
import { runnerPlaces } from '../shared/product-paths.mjs';
import { BUILDER, BUILDER_SHELL, FLAT_OUTBOX_ROLES, PRODUCT_OUTBOX_ROLES, USERS, baseMarkerPath, proposalRows, homeOf, outboxRootPath, workerCopiesPath } from './layout.mjs';
import { RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';

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
  const file = join(installPaths(cfg).installRoot, RUNNER_CONFIG);
  let rules = null; let why = null;
  try { rules = JSON.parse(io.readText(file))?.rules ?? null; } catch (e) { why = `the installed ${file} could not be read (${e?.code ?? 'not JSON'})`; }
  if (!why && !rules) why = `the installed ${file} names no rules`;
  const all = why ? [] : [rules.production?.env_files, rules.secrets?.paths].flatMap((v) => (Array.isArray(v) ? v : []));
  const files = [...new Set(all.filter((x) => typeof x === 'string'))];
  // An entry that is not text is said, one NOT TRIED line each, never dropped (#528 r2): it names no file to try.
  const odd = all.filter((x) => typeof x !== 'string');
  if (!why && !files.length && !odd.length) why = `the product's rules list no production files or secrets (${file}: rules.production.env_files and rules.secrets.paths are empty)`;
  return { ownerHome, rules: { files, odd, why } };
}

/** The proofs: [{ what, args, expect: 'ok' | 'fail', control?, notTried? }]. `args` are what follows `sudo -n -H -u builder`.
 *  A "cannot write" proof shows the state now; that the builder cannot gain write (own it and chmod it) is check's job:
 *  it wants each folder owned by root, orchestrate or review (never the builder), with the exact mode and access list. */
export function proofList(cfg, { ownerHome = null, rules = { files: [], why: 'not read' }, kindOf = () => null } = {}) {
  const p = (...s) => join(cfg.base, ...s);
  const B = BUILDER;
  const places = cfg.products.map((prod) => [prod, runnerPlaces({ copiesRoot: workerCopiesPath(cfg), outboxRoot: outboxRootPath(cfg), product: prod })]);
  const notTried = (what, why) => ({ what, args: null, expect: 'fail', notTried: why });
  const readProof = (f) => {
    const what = `${B} cannot read ${f}`;
    if (!f.startsWith('/')) return notTried(what, 'a relative name, not a place on this Mac: nothing was tried');
    if (/[*?[\]{}]/.test(f)) return notTried(what, 'a pattern, not one file: nothing was tried');
    const k = kindOf(f);
    if (!k) return notTried(what, 'not on this Mac: nothing was tried');
    if (k.startsWith('error:')) return notTried(what, `root could not look at it (${k.slice(6)}): nothing was tried`);   // #528 r1 m8
    return k === 'dir' ? folderProofs(what.replace('cannot read', 'cannot list'), f) : [{ what, args: [HEAD, '-c', '1', f], expect: 'denied' }];
  };
  // A folder: it can't be listed (the Mac's own refusal) and it can't be passed through (#528 r1 M1, m3).
  const folderProofs = (what, d) => [{ what, args: [LS, d], expect: 'denied' }, { what: `${B} cannot pass through ${d}`, args: [TEST, '-x', d], expect: 'fail' }];
  return [
    { what: `can run a program as ${B}`, args: [TRUE], expect: 'ok', control: true },
    { what: `${B} CAN write ${workerCopiesPath(cfg)} (the control: "cannot write" below means something)`, args: [TEST, '-w', workerCopiesPath(cfg)], expect: 'ok', control: true },
    { what: `${B} CAN write its own home ${homeOf(cfg, B)}`, args: [TEST, '-w', homeOf(cfg, B)], expect: 'ok', control: true },
    { what: `${B} CAN list ${cfg.base} (the control: "cannot list" below means something)`, args: [LS, cfg.base], expect: 'ok', control: true },
    { what: `${B} CAN read ${baseMarkerPath(cfg)} (the control: "cannot read" below means something)`, args: [HEAD, '-c', '1', baseMarkerPath(cfg)], expect: 'ok', control: true },
    ...places.flatMap(([prod, at]) => [at.copies, ...PRODUCT_OUTBOX_ROLES.map((r) => join(at.outboxes, r))].map((d) => ({ what: `${B} CAN write ${d} (${prod}'s, where the worker runner writes)`, args: [TEST, '-w', d], expect: 'ok', control: true }))),
    ...cfg.products.map((prod) => ({ what: `${B} cannot write the record ${p('products', prod, 'store')}`, args: [TEST, '-w', p('products', prod, 'store')], expect: 'fail' })),
    ...NO_WRITE.map((d) => ({ what: `${B} cannot write ${p(d)}`, args: [TEST, '-w', p(d)], expect: 'fail' })),
    ...places.map(([prod, at]) => ({ what: `${B} cannot write ${prod}'s outbox folder ${at.outboxes} (root's: its role folders can't be renamed away)`, args: [TEST, '-w', at.outboxes], expect: 'fail' })),
    ...folderProofs(`${B} cannot read the robot keys (${p('keys')})`, p('keys')),
    ...USERS.filter((u) => u !== B).flatMap((u) => folderProofs(`${B} cannot list ${u}'s home ${homeOf(cfg, u)}`, homeOf(cfg, u))),
    ...(!ownerHome ? [{ what: `${B} cannot list the owner's home`, args: null, expect: 'fail', bad: `the owner ${cfg.owner}'s home could not be read from this Mac` }]
      : kindOf(ownerHome) !== 'dir' ? [notTried(`${B} cannot list the owner's home ${ownerHome}`, kindOf(ownerHome)?.startsWith('error:') ? `root could not look at it (${kindOf(ownerHome).slice(6)}), so nothing was proven` : 'not a folder on this Mac: a missing folder can\'t be listed by anyone, so nothing was proven')]
        : folderProofs(`${B} cannot list the owner's home ${ownerHome}`, ownerHome)),
    // The owner's own sessions' outboxes (#528 r1 m9): the owner's, 0750, with one read entry for orchestrate only.
    ...FLAT_OUTBOX_ROLES.map((r) => join(outboxRootPath(cfg), r)).map((d) => ({ what: `${B} cannot write the owner's outbox folder ${d}`, args: [TEST, '-w', d], expect: 'fail' })),
    // The proposals folders (#528 r2 m2), from setup's own table (proposalRows, I7): the parent is root's 0711 and each
    // product's is the owner's 0700. The builder can write none, and can list none. One not made yet (`proposals` makes
    // them) is NOT TRIED, as a Dispatcher folder not made yet is (#528 r1 judgement 2): a missing folder proves nothing.
    ...proposalRows(cfg).flatMap((row) => {
      const what = `${B} cannot write or list the proposals folder ${row.path}`; const k = kindOf(row.path);
      if (!k) return [notTried(what, 'not made yet (sudo node setup.mjs proposals makes it): nothing was tried')];
      if (k !== 'dir') return [notTried(what, k.startsWith('error:') ? `root could not look at it (${k.slice(6)}): nothing was tried` : 'it is not a folder: nothing was tried')];
      return [{ what: `${B} cannot write the proposals folder ${row.path}`, args: [TEST, '-w', row.path], expect: 'fail' },
        { what: `${B} cannot list the proposals folder ${row.path}`, args: [LS, row.path], expect: 'denied' }];
    }),
    // The Dispatcher's rules state and approvals (L1112 (3)): orchestrate's alone. Without a dispatcher entry neither exists.
    ...(cfg.dispatcher ? [cfg.dispatcher.rulesStateDir, cfg.dispatcher.approvalsStateDir].flatMap(readProof) : []),
    ...(rules.files.length || rules.odd?.length ? rules.files.flatMap(readProof) : [notTried(`${B} cannot read the product's production files and secrets`, rules.why ?? 'none named')]),
    ...(rules.odd ?? []).map((x) => notTried(`${B} cannot read the rules entry ${String(JSON.stringify(x) ?? typeof x).slice(0, 60)}`, 'it is not text, so it names no file: nothing was tried')),
  ];
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
  const out = []; let controlsHold = true;
  for (const pr of proofList(cfg, { ...inputs, kindOf: kindOn(io) })) {
    if (pr.notTried) { out.push({ ok: false, notTried: true, what: pr.what, why: pr.notTried }); continue; }
    if (pr.bad) { out.push({ ok: false, what: pr.what, why: pr.bad }); continue; }
    if (!controlsHold) { out.push({ ok: false, what: pr.what, why: 'not proven: a control above failed' }); continue; }   // one way of asking is already broken
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
  // Its shell is zsh (#487 r5 m1): the production guard's message shapes are safe as zsh reads them, not as bash 3.2 does.
  const u = readUser(io, BUILDER);
  out.push({ ok: u.exists && u.shell === BUILDER_SHELL, what: `${BUILDER}'s shell is ${BUILDER_SHELL} (its sessions' Bash tool runs it)`, ...(u.exists && u.shell === BUILDER_SHELL ? {} : { why: u.exists ? `its shell is ${u.shell || 'unset'}` : `${BUILDER} is not a user on this Mac` }) });
  const g = groupsProblem(io.run(ID, ['-Gn', BUILDER]));
  out.push({ ok: g === null, what: `${BUILDER}'s groups are its own and the ones macOS gives every local user (${BUILDER_GROUPS_ALLOWED.join(', ')})`, ...(g ? { why: g } : {}) });
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
 * What is at `f` on this Mac: 'dir', 'file' (anything else that is there), null when it is not there, or 'error:<why>'
 * when root could not look (#528 r1 m8: told as such, never as "not there"). A link is judged by what it leads to
 * (#528 r2 M1): a link to a folder the builder may pass through but not list gets the folder proofs, since `head` on it
 * is refused while a file inside can still be read. A link that leads nowhere is an error, not "not there".
 */
export const kindOn = (io) => (f) => {
  const gone = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
  let st; try { st = io.lstat(f); } catch (e) { return gone(e) ? null : `error:${e?.code ?? 'unknown'}`; }
  if (!st.isSymbolicLink()) return st.isDirectory() ? 'dir' : 'file';
  try { return io.stat(f).isDirectory() ? 'dir' : 'file'; } catch (e) { return gone(e) ? 'error:a link that leads nowhere' : `error:${e?.code ?? 'unknown'}`; }
};

/** What `--dry-run` prints: the commands, not run, and what will not be tried. */
export const proofCommands = (io, cfg) => {
  const inputs = proofInputs(io, cfg);
  return [...proofList(cfg, { ...inputs, kindOf: kindOn(io) }).map((pr) => (pr.args ? `sudo -n -H -u ${BUILDER} ${pr.args.join(' ')}   (${pr.expect === 'ok' ? 'must work' : pr.expect === 'denied' ? 'must be refused: Permission denied' : 'must fail'})` : `not tried: ${pr.what} (${pr.notTried ?? pr.bad})`)), `${ID} -Gn ${BUILDER}   (its own group and the allowed ones only)`];
};
