// The review runner's config file (review.json), built rather than typed (L709, SAFETY-ROADMAP "the full review.json").
//
//   node setup.mjs review-config --pin <x.y.z> --input <owner's file> --out <file> [--for-install] [--dry-run]   (not as root)
//
// Every field the runner reads (review-runner-main.mjs CONFIG_FIELDS) has exactly ONE source, named in SOURCES below:
//   setup  from the setup config (layout.mjs, install.mjs) and the Mac's own user records: the folders, the copy's paths, the uids
//   pin    from --pin: the pin itself, and the program's place in the copy (where add-to-install puts it)
//   owner  from the owner's input file, and only these: which product's Record the runner reads, the machine-wide settings
//          file, and the rules the review sessions' hooks read (the product also names its Record and the Dispatcher's rules
//          snapshot for it, check 12). None has a default: a field left out is refused by name
//   bob    the Bob file list (bobManifest): the `bob` step's (bob-manifest.mjs), which installs the Bob folder and its list
//          together. Named only once that step has put the list in the installed copy: a config naming a list that is not
//          there would stop the whole runner (programsProblem), not only check 13. Until it is, check 13 has no port and
//          the launcher refuses every review; run `bob`, then this again (L995)
// The input file may hold only the owner's fields: a setup field in it is refused, so a typed value can never stand in for
// one setup knows.
//
// The pin is checked first (m-5: it must be the one the role tool lists were checked on, M10 TOOLS_CHECKED), so a dry run
// refuses what the real run refuses (L731 m1). The whole file is then read back with the runner's own readConfig, the same
// check the runner makes at daemon start, on a new file beside --out; only once it passes is it renamed onto --out. A
// refused run leaves whatever --out held before (L731 m2). It is written as the person's own file (never as root): root
// takes no orders from a file in a home folder. Putting it in place is a separate root step (README): `sudo install -o
// root -g wheel -m 0644 /dev/stdin <runnerConfig> < <the file>`.
//
// Two forms, for the two root steps that read it (L731 M1):
//   --for-install  for a first `install`. It leaves out claudeBin and hooksDir (INSTALL_LATER): on a first install the
//                  copy carries only the setup config's extras, and install refuses a path outside them. The full file is
//                  still built and read back first, so every field written is one the runner takes; the runner refuses
//                  the shorter file by name (claudeBin) until add-to-install has run.
//   (plain)        for add-to-install (L573), which puts the pinned Claude Code and the hooks into the copy at exactly the
//                  places this file names (COPY_CLAUDE_CODE/<pin>/claude, COPY_HOOKS) and installs this file last.
// So the order is: review-config --for-install, install; then review-config, add-to-install (README).

import { closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { SCRIPTS } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { pinnedBinary } from '../modules/M4-workshop/launcher/hooks-check.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { CONFIG_FIELDS, readConfig } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { RUNNER_ROLES } from '../shared/review-roles.mjs';
import { TOOLS_CHECKED } from '../modules/M10-rules/roles.mjs';
import { CLAUDE_FILE, MANAGED_SOURCES_CHECKED_ON } from '../modules/M4-workshop/launcher/env-check.mjs';
import { COPY_HOOKS, REVIEW_SNAPSHOT_FILE, WORKER_STATUS_FILE, bobPath, dispatcherRulesPath, homeOf, keysPath, mirrorPath, outboxRootPath, ownerTapsPath, privatePath, reviewCopiesPath, storePath, workerCopiesPath, workerRunnerPaths } from './layout.mjs';
import { installPaths } from './install.mjs';
import { bobManifestPath } from './bob-manifest.mjs';

// The one source of each field. The test holds the keys equal to CONFIG_FIELDS.
export const SOURCES = Object.freeze({
  installRoot: 'setup', root: 'setup', outboxRoot: 'setup', reviewHome: 'setup', uids: 'setup', recordUid: 'setup',
  mirror: 'setup', hooksDir: 'setup', accountCopy: 'setup', ownerHome: 'setup', ownerUid: 'setup', ownerTaps: 'setup',
  wiring: 'setup', snapshot: 'setup', bobFolder: 'setup', deny: 'setup', reviewCopies: 'setup', workerCopies: 'setup',
  pin: 'pin', claudeBin: 'pin',
  budget: 'setup', workerStatusFile: 'setup', workerUid: 'setup',
  recordRoot: 'owner', machineWide: 'owner', rules: 'owner', dispatcherRules: 'owner',
  bobManifest: 'bob',
});
// What the owner's input file holds: exactly these keys, each required. `product` picks the Record (recordRoot).
export const OWNER_INPUT = Object.freeze(['product', 'machineWide', 'rules']);
// What --for-install leaves out (L731 M1): the two places add-to-install fills, which a first install can't carry.
export const INSTALL_LATER = Object.freeze(['claudeBin', 'hooksDir']);
// The wiring, beside the runner in the copy (review-runner-main.mjs: the copy's own .mjs file, never a copy item).
const WIRING = posix.join(posix.dirname(SCRIPTS.runner), 'review-wiring.mjs');
// M11's budget module (launch check 12), the copy's own code file the runner imports (RUNNER_MODULES).
export const BUDGET_MODULE = 'modules/M11-dispatcher/budget.mjs';
const RULE_LISTS = Object.freeze({ production: ['env_files', 'programs', 'hosts'], secrets: ['paths'] });
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const absPath = (p) => typeof p === 'string' && isAbsolute(p) && posix.normalize(p) === p && p !== '/' && !p.includes('\0') && !p.includes('\n');

/** The fields setup knows: from the setup config and the Mac's user records (`userOf(name)` → readUser's answer). → { fields, problems } */
export function setupFields(cfg, { pin, userOf }) {
  const P = installPaths(cfg); const problems = [];
  const uid = (name, what) => {
    const u = userOf(name);
    if (!u?.exists || !Number.isInteger(u.uid) || u.uid <= 0) { problems.push(`the Mac user ${name} (${what}) was not found; run users-folders first`); return null; }
    return u;
  };
  const review = uid('review', 'the review runner\'s user'); const orch = uid('orchestrate', 'the Record\'s owner'); const owner = uid(cfg.owner, 'the owner');
  if (owner && !absPath(owner.home)) problems.push(`the owner's Mac user ${cfg.owner} has no home folder set`);
  if (problems.length) return { fields: null, problems };
  // Every role of the design table has a Mac user (m-1): the review roles run as review, every other role as the owner's
  // own user, whose outbox folders it owns (layout.mjs folderTable).
  // The runner's roles (L722: the review roles and the plan reviewer) write as review; every other role is the owner's.
  const uids = Object.fromEntries(Object.keys(DESIGN_PROFILES).map((r) => [r, RUNNER_ROLES.includes(r) ? review.uid : owner.uid]));
  const fields = {
    installRoot: P.installRoot, root: P.reviewRoot, outboxRoot: outboxRootPath(cfg), reviewHome: homeOf(cfg, 'review'),
    uids, recordUid: orch.uid, mirror: mirrorPath(cfg), hooksDir: join(P.installRoot, COPY_HOOKS), accountCopy: P.accountCopy,
    ownerHome: owner.home, ownerUid: owner.uid, ownerTaps: ownerTapsPath(cfg), wiring: join(P.installRoot, WIRING),
    snapshot: join(P.reviewRoot, REVIEW_SNAPSHOT_FILE), bobFolder: bobPath(cfg),
    // What a review session may not read: the robot keys, the private data and the owner's home folder (a Mac home is
    // readable by the staff group, which review is in). The workers' copies are denied whole by review-settings itself.
    deny: [keysPath(cfg), privatePath(cfg), owner.home],
    reviewCopies: reviewCopiesPath(cfg), workerCopies: workerCopiesPath(cfg),
    // Launch check 12 (L1001): M11's budget module, in the copy, and the worker runner's status file and user (the owner's
    // own, as the Dispatcher's workerUid), which its running count reads.
    budget: join(P.installRoot, BUDGET_MODULE), workerStatusFile: join(workerRunnerPaths(cfg).state, WORKER_STATUS_FILE), workerUid: owner.uid,
  };
  return { fields, problems };
}

/** The fields --pin gives. */
export const pinFields = (cfg, pin) => ({ pin, claudeBin: pinnedBinary(installPaths(cfg).installRoot, pin) });
/** Null, or why --pin is refused: the runner's own m-5 rule (readConfig), checked here too so a dry run refuses it alike. */
export const pinProblem = (pin) => (pin === TOOLS_CHECKED.claude_code ? null
  : `--pin is ${String(pin).slice(0, 20)}, but the role tool lists were checked on Claude Code ${TOOLS_CHECKED.claude_code} (M10 TOOLS_CHECKED); re-check them before the pin moves`);

/** The owner's fields, from their input file's parsed value: every key required, no other key allowed. → { fields, problems } */
export function ownerFields(cfg, input) {
  const problems = [];
  if (!plainObject(input)) return { fields: null, problems: ['the input file must be one JSON object holding product, machineWide and rules'] };
  for (const k of Object.keys(input)) {
    if (OWNER_INPUT.includes(k)) continue;
    problems.push(Object.hasOwn(SOURCES, k) ? `the input file may not set ${k}: it comes from ${SOURCES[k] === 'pin' ? '--pin' : SOURCES[k] === 'bob' ? 'the bob step (setup.mjs bob)' : SOURCES[k] === 'owner' ? 'the product named (set product instead)' : 'setup'}, not from a typed value` : `the input file holds ${JSON.stringify(k.slice(0, 40))}, which is no field of the runner's config`);
  }
  // No defaults (L709): a missing field is refused by name, never filled in.
  for (const k of OWNER_INPUT) if (!Object.hasOwn(input, k)) problems.push(`the input file must set ${k} (there is no default)`);
  if (Object.hasOwn(input, 'product') && !(typeof input.product === 'string' && cfg.products.includes(input.product))) {
    problems.push(`the input file's product must be one of the setup config's products (${cfg.products.join(', ') || 'none listed'})`);
  }
  if (Object.hasOwn(input, 'machineWide') && !absPath(input.machineWide)) problems.push('the input file\'s machineWide must be the full path of the machine-wide Claude Code settings file');
  // L909: claude reads only its fixed managed file, so a guard in any other would never apply (launch check 10 refuses it too).
  else if (Object.hasOwn(input, 'machineWide') && input.machineWide !== CLAUDE_FILE) problems.push(`the input file's machineWide must be ${CLAUDE_FILE}: claude ${MANAGED_SOURCES_CHECKED_ON} reads only that file`);
  if (Object.hasOwn(input, 'rules')) {
    const r = input.rules;
    if (!plainObject(r)) problems.push('the input file\'s rules must be an object with production and secrets');
    else {
      for (const k of Object.keys(r)) if (!Object.hasOwn(RULE_LISTS, k)) problems.push(`the input file's rules hold ${JSON.stringify(k.slice(0, 40))}, which the hooks do not read`);
      for (const [part, lists] of Object.entries(RULE_LISTS)) {
        if (!Object.hasOwn(r, part)) { problems.push(`the input file must set rules.${part} (there is no default)`); continue; }
        if (!plainObject(r[part])) { problems.push(`the input file's rules.${part} must be an object`); continue; }
        for (const k of Object.keys(r[part])) if (!lists.includes(k)) problems.push(`the input file's rules.${part} holds ${JSON.stringify(k.slice(0, 40))}, which the hooks do not read`);
        for (const k of lists) {
          if (!Object.hasOwn(r[part], k)) problems.push(`the input file must set rules.${part}.${k} (there is no default; an empty list says none)`);
          else if (!Array.isArray(r[part][k]) || !r[part][k].every((v) => typeof v === 'string' && v.length > 0)) problems.push(`the input file's rules.${part}.${k} must be a list of names`);
        }
      }
    }
  }
  if (problems.length) return { fields: null, problems };
  const rules = { production: Object.fromEntries(RULE_LISTS.production.map((k) => [k, [...input.rules.production[k]]])), secrets: { paths: [...input.rules.secrets.paths] } };
  return { fields: { recordRoot: storePath(cfg, input.product), dispatcherRules: dispatcherRulesPath(cfg, input.product), machineWide: input.machineWide, rules }, problems };
}

/**
 * The whole config: { config, problems }. Each field from its one source (SOURCES), in CONFIG_FIELDS' order. `bobInstalled`:
 * whether the bob step's list is in the installed copy (bobManifestPath); only then is bobManifest named.
 */
export function buildReviewConfig(cfg, { pin, input, userOf, bobInstalled = false }) {
  const s = setupFields(cfg, { pin, userOf }); const o = ownerFields(cfg, input); const pinWhy = pinProblem(pin);
  const problems = [...(pinWhy ? [pinWhy] : []), ...s.problems, ...o.problems];
  if (problems.length) return { config: null, problems };
  const from = { setup: s.fields, pin: pinFields(cfg, pin), owner: o.fields };
  const config = {};
  for (const k of CONFIG_FIELDS) {
    const src = SOURCES[k];
    if (src === 'bob') { if (bobInstalled) config[k] = bobManifestPath(cfg); continue; }
    if (!from[src] || !Object.hasOwn(from[src], k)) throw new Error(`review-config: ${k} has no value from its source (${src})`);   // a builder's slip, never the owner's
    config[k] = from[src][k];
  }
  return { config, problems: [] };
}

/** Whether the bob step's list is in the installed copy: a plain file there (not a link). */
export function bobListThere(p, { lstat = lstatSync } = {}) {
  try { const st = lstat(p); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
}

/** Reads the owner's input file: a plain file of their own, not a link. Never quotes it. → value, or throws. */
export function readInput(file, { lstat = lstatSync, read = readFileSync } = {}) {
  let st; try { st = lstat(file); } catch (e) { throw new Error(`the input file ${file} can't be read (${e?.code ?? 'error'})`); }
  if (st.isSymbolicLink()) throw new Error(`the input file ${file} is a link; name the file itself`);
  if (!st.isFile()) throw new Error(`the input file ${file} is not a plain file`);
  try { return JSON.parse(read(file, 'utf8')); } catch { throw new Error(`the input file ${file} is not valid JSON`); }   // never the parser's message: it quotes the file
}

/** The new file beside `out` that writeOut fills and checks before the rename. */
export const writingName = (out) => join(dirname(out), `.${basename(out)}.writing-${process.pid}`);
/**
 * Writes `checkText` to a new file beside `out`, runs `check` on it, then (when `text` differs) puts `text` in it, and
 * renames it onto `out` (L731 m2). A cut-off or refused run leaves `out` as it was and no new file. `check` throws to refuse;
 * its error is marked `refused`, so the caller tells a refusal from a write that failed.
 */
function writeOut(out, { text, checkText = text }, check) {
  const tmp = writingName(out);
  const put = (t, flags) => { const fd = openSync(tmp, constants.O_WRONLY | flags | constants.O_NOFOLLOW, 0o644); try { writeSync(fd, t); fsyncSync(fd); } finally { closeSync(fd); } };
  rmSync(tmp, { force: true });
  try {
    put(checkText, constants.O_CREAT | constants.O_EXCL);
    try { check(tmp); } catch (e) { throw Object.assign(new Error(e?.message ?? String(e)), { refused: true }); }
    if (text !== checkText) put(text, constants.O_TRUNC);
    renameSync(tmp, out);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/**
 * The command. `userOf`, `check` (the runner's readConfig, with its ports) and `write` are ports for a test. → exit code:
 * 0 written and read back, 1 a problem (`out` as it was), 2 usage.
 */
export function reviewConfigCommand(cfg, { pin, input: inputFile, out: outFile, dry, forInstall = false }, { euid, userOf, out, err, check = (f) => readConfig(f), write = writeOut, readIn = readInput, bobThere = bobListThere }) {
  if (euid === 0) { err('refused: review-config reads your own input file and writes your own copy, so it runs without sudo. Root reads the result only once you have put it in place (README).'); return 2; }
  if (!absPath(outFile) || (basename(outFile) === RUNNER_CONFIG && dirname(outFile).startsWith(installPaths(cfg).install))) { err('refused: --out must be a full path of your own (not the installed copy\'s review.json)'); return 2; }
  let input; try { input = readIn(inputFile); } catch (e) { err(`PROBLEM  ${e.message}`); err('nothing was written.'); return 1; }
  const bobInstalled = bobThere(bobManifestPath(cfg));
  const built = buildReviewConfig(cfg, { pin, input, userOf, bobInstalled });
  for (const p of built.problems) err(`PROBLEM  ${p}`);
  if (built.problems.length) { err('nothing was written.'); return 1; }
  const json = (c) => `${JSON.stringify(c, null, 1)}\n`;
  const full = json(built.config);
  const text = forInstall ? json(Object.fromEntries(Object.entries(built.config).filter(([k]) => !INSTALL_LATER.includes(k)))) : full;
  // Every field has a source now (L1035 m4); only the Bob file list waits, for its own step.
  const left = bobInstalled ? [] : ['bobManifest (run the bob step first, then this again)'];
  const leftNow = [...left, ...(forInstall ? [`for the first install, ${INSTALL_LATER.join(' and ')} (add-to-install's)`] : [])].join('; ');
  if (dry) {
    // The dry run reads the whole file back too (L731 self-review m3), through a scratch copy that is then removed, so it
    // refuses what the real run refuses.
    const scratch = mkdtempSync(join(tmpdir(), 'review-config-dry-'));
    try { write(join(scratch, RUNNER_CONFIG), { text: full }, check); } catch (e) {
      err(e?.refused ? `PROBLEM  the review runner would refuse it: ${e.message}` : `PROBLEM  the dry run's scratch copy could not be written (${e?.code ?? e?.message ?? 'error'})`); err('dry run: nothing written.'); return 1;
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    out(text.trimEnd()); out(`dry run: nothing written.${leftNow ? ` Left out (its step not run yet): ${leftNow}.` : ''}`); return 0;
  }
  try { write(outFile, { text, checkText: full }, check); } catch (e) {
    if (e?.refused) { err(`PROBLEM  the review runner would refuse it: ${e.message}`); err(`nothing was written; ${outFile} is as it was.`); return 1; }
    err(`PROBLEM  ${outFile} could not be written (${e?.code ?? e?.message ?? 'error'}); it is as it was.`); return 1;
  }
  out(`written: ${outFile}, and the review runner's own check takes it${forInstall ? ` (checked whole, then written without ${INSTALL_LATER.join(' and ')})` : ''}.`);
  if (left.length) out(`Left out (its step not run yet): ${left.join(', ')}. Until it is named, launch check 13 refuses every review.`);
  out(`Next: sudo install -o root -g wheel -m 0644 /dev/stdin <the runnerConfig path in your setup config> < ${outFile}`);
  out(forInstall ? 'Then: install. After it, run review-config again without --for-install, put that file in place the same way, and run add-to-install.' : 'Then: add-to-install (it puts the pinned Claude Code and the hooks where this file names them).');
  return 0;
}
