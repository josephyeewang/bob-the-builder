// The review runner's config file (review.json), built rather than typed (L709, SAFETY-ROADMAP "the full review.json").
//
//   node setup.mjs review-config --pin <x.y.z> --input <owner's file> --out <file> [--dry-run]     (not as root)
//
// Every field the runner reads (review-runner-main.mjs CONFIG_FIELDS) has exactly ONE source, named in SOURCES below:
//   setup  from the setup config (layout.mjs, install.mjs) and the Mac's own user records: the folders, the copy's paths, the uids
//   pin    from --pin: the pin itself, and the program's place in the copy (where add-to-install puts it)
//   owner  from the owner's input file, and only these: which product's Record the runner reads, the machine-wide settings
//          file, and the rules the review sessions' hooks read. None has a default: a field left out is refused by name
//   later  not written yet, because nothing in the repository makes it (the budget module, the Bob file list); until it is,
//          launch checks 12 and 13 have no port and the launcher refuses every review, as today
// The input file may hold only the owner's fields: a setup field in it is refused, so a typed value can never stand in for
// one setup knows.
//
// The file written is then read back with the runner's own readConfig, the same check the runner makes at daemon start
// (m-5 included: the pin must be the one the role tool lists were checked on). If it refuses, the file is removed and
// nothing is left to install. It is written as the person's own file (never as root): root takes no orders from a file
// in a home folder. Putting it in place is a separate root step (README): `sudo install -o root -g wheel -m 0644
// /dev/stdin /Library/orchestrate-review.json < <the file>`, then install or add-to-install reads it as root's own.

import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { SCRIPTS } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { pinnedBinary } from '../modules/M4-workshop/launcher/hooks-check.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { CONFIG_FIELDS, readConfig } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { REVIEW_ROLES } from '../shared/review-roles.mjs';
import { SNAPSHOT_FILE } from '../modules/M10-rules/snapshot.mjs';
import { bobPath, homeOf, keysPath, mirrorPath, outboxRootPath, ownerTapsPath, privatePath, reviewCopiesPath, workerCopiesPath } from './layout.mjs';
import { installPaths } from './install.mjs';

// The one source of each field. The test holds the keys equal to CONFIG_FIELDS.
export const SOURCES = Object.freeze({
  installRoot: 'setup', root: 'setup', outboxRoot: 'setup', reviewHome: 'setup', uids: 'setup', recordUid: 'setup',
  mirror: 'setup', hooksDir: 'setup', accountCopy: 'setup', ownerHome: 'setup', ownerUid: 'setup', ownerTaps: 'setup',
  wiring: 'setup', snapshot: 'setup', bobFolder: 'setup', deny: 'setup', reviewCopies: 'setup', workerCopies: 'setup',
  pin: 'pin', claudeBin: 'pin',
  recordRoot: 'owner', machineWide: 'owner', rules: 'owner',
  budget: 'later', bobManifest: 'later',
});
// What the owner's input file holds: exactly these keys, each required. `product` picks the Record (recordRoot).
export const OWNER_INPUT = Object.freeze(['product', 'machineWide', 'rules']);
// The hooks folder inside the copy: the place add-to-install copies the hook scripts to (L573).
export const COPY_HOOKS = 'hooks';
// The wiring, beside the runner in the copy (review-runner-main.mjs: the copy's own .mjs file, never a copy item).
const WIRING = posix.join(posix.dirname(SCRIPTS.runner), 'review-wiring.mjs');
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
  const uids = Object.fromEntries(Object.keys(DESIGN_PROFILES).map((r) => [r, REVIEW_ROLES.includes(r) ? review.uid : owner.uid]));
  const fields = {
    installRoot: P.installRoot, root: P.reviewRoot, outboxRoot: outboxRootPath(cfg), reviewHome: homeOf(cfg, 'review'),
    uids, recordUid: orch.uid, mirror: mirrorPath(cfg), hooksDir: join(P.installRoot, COPY_HOOKS), accountCopy: P.accountCopy,
    ownerHome: owner.home, ownerUid: owner.uid, ownerTaps: ownerTapsPath(cfg), wiring: join(P.installRoot, WIRING),
    snapshot: join(P.reviewRoot, SNAPSHOT_FILE), bobFolder: bobPath(cfg),
    // What a review session may not read: the robot keys, the private data and the owner's home folder (a Mac home is
    // readable by the staff group, which review is in). The workers' copies are denied whole by review-settings itself.
    deny: [keysPath(cfg), privatePath(cfg), owner.home],
    reviewCopies: reviewCopiesPath(cfg), workerCopies: workerCopiesPath(cfg),
  };
  return { fields, problems };
}

/** The fields --pin gives. */
export const pinFields = (cfg, pin) => ({ pin, claudeBin: pinnedBinary(installPaths(cfg).installRoot, pin) });

/** The owner's fields, from their input file's parsed value: every key required, no other key allowed. → { fields, problems } */
export function ownerFields(cfg, input) {
  const problems = [];
  if (!plainObject(input)) return { fields: null, problems: ['the input file must be one JSON object holding product, machineWide and rules'] };
  for (const k of Object.keys(input)) {
    if (OWNER_INPUT.includes(k)) continue;
    problems.push(Object.hasOwn(SOURCES, k) ? `the input file may not set ${k}: it comes from ${SOURCES[k] === 'pin' ? '--pin' : SOURCES[k] === 'later' ? 'no source yet (it is left out)' : SOURCES[k] === 'owner' ? 'the product named (set product instead)' : 'setup'}, not from a typed value` : `the input file holds ${JSON.stringify(k.slice(0, 40))}, which is no field of the runner's config`);
  }
  // No defaults (L709): a missing field is refused by name, never filled in.
  for (const k of OWNER_INPUT) if (!Object.hasOwn(input, k)) problems.push(`the input file must set ${k} (there is no default)`);
  if (Object.hasOwn(input, 'product') && !(typeof input.product === 'string' && cfg.products.includes(input.product))) {
    problems.push(`the input file's product must be one of the setup config's products (${cfg.products.join(', ') || 'none listed'})`);
  }
  if (Object.hasOwn(input, 'machineWide') && !absPath(input.machineWide)) problems.push('the input file\'s machineWide must be the full path of the machine-wide Claude Code settings file');
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
  return { fields: { recordRoot: join(cfg.base, 'products', input.product, 'store'), machineWide: input.machineWide, rules }, problems };
}

/** The whole config: { config, problems }. Each field from its one source (SOURCES), in CONFIG_FIELDS' order. */
export function buildReviewConfig(cfg, { pin, input, userOf }) {
  const s = setupFields(cfg, { pin, userOf }); const o = ownerFields(cfg, input);
  const problems = [...s.problems, ...o.problems];
  if (problems.length) return { config: null, problems };
  const from = { setup: s.fields, pin: pinFields(cfg, pin), owner: o.fields };
  const config = {};
  for (const k of CONFIG_FIELDS) {
    const src = SOURCES[k];
    if (src === 'later') continue;
    if (!from[src] || !Object.hasOwn(from[src], k)) throw new Error(`review-config: ${k} has no value from its source (${src})`);   // a builder's slip, never the owner's
    config[k] = from[src][k];
  }
  return { config, problems: [] };
}

/** Reads the owner's input file: a plain file of their own, not a link. Never quotes it. → value, or throws. */
export function readInput(file, { lstat = lstatSync, read = readFileSync } = {}) {
  let st; try { st = lstat(file); } catch (e) { throw new Error(`the input file ${file} can't be read (${e?.code ?? 'error'})`); }
  if (st.isSymbolicLink()) throw new Error(`the input file ${file} is a link; name the file itself`);
  if (!st.isFile()) throw new Error(`the input file ${file} is not a plain file`);
  try { return JSON.parse(read(file, 'utf8')); } catch { throw new Error(`the input file ${file} is not valid JSON`); }   // never the parser's message: it quotes the file
}

/** Writes `text` to `out` through a new file beside it and one rename, so a cut-off run leaves the old file or the new. */
function writeOut(out, text) {
  const tmp = join(dirname(out), `.${basename(out)}.writing-${process.pid}`);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, out);
}

/**
 * The command. `userOf`, `check` (the runner's readConfig, with its ports) and `write` are ports for a test. → exit code:
 * 0 written and read back, 1 a problem (nothing left at `out`), 2 usage.
 */
export function reviewConfigCommand(cfg, { pin, input: inputFile, out: outFile, dry }, { euid, userOf, out, err, check = (f) => readConfig(f), write = writeOut, readIn = readInput }) {
  if (euid === 0) { err('refused: review-config reads your own input file and writes your own copy, so it runs without sudo. Root reads the result only once you have put it in place (README).'); return 2; }
  if (!absPath(outFile) || (basename(outFile) === RUNNER_CONFIG && dirname(outFile).startsWith(installPaths(cfg).install))) { err('refused: --out must be a full path of your own (not the installed copy\'s review.json)'); return 2; }
  let input; try { input = readIn(inputFile); } catch (e) { err(`PROBLEM  ${e.message}`); err('nothing was written.'); return 1; }
  const built = buildReviewConfig(cfg, { pin, input, userOf });
  for (const p of built.problems) err(`PROBLEM  ${p}`);
  if (built.problems.length) { err('nothing was written.'); return 1; }
  const text = `${JSON.stringify(built.config, null, 1)}\n`;
  const left = Object.entries(SOURCES).filter(([, s]) => s === 'later').map(([k]) => k);
  if (dry) { out(text.trimEnd()); out(`dry run: nothing written. Left out (no source yet): ${left.join(', ')}.`); return 0; }
  try { write(outFile, text); } catch (e) { err(`PROBLEM  ${outFile} could not be written (${e?.code ?? e?.message ?? 'error'})`); return 1; }
  try { check(outFile); } catch (e) {
    try { rmSync(outFile, { force: true }); } catch { /* reported below */ }
    err(`PROBLEM  the review runner would refuse it: ${e.message}`); err(`${outFile} was removed; nothing is left to install.`); return 1;
  }
  out(`written: ${outFile}, and the review runner's own check takes it.`);
  out(`Left out (no source yet): ${left.join(', ')}. Until they are, launch checks 12 and 13 refuse every review.`);
  out(`Next: sudo install -o root -g wheel -m 0644 /dev/stdin <the runnerConfig path in your setup config> < ${outFile}`);
  return 0;
}
