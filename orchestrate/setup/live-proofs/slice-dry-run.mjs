// slice-dry-run.mjs — the thin slice's dry run (N5, L1099 Q5): watch one test card go from the rules to the robot's PR,
// and write nothing but its own result file. Run on the always-on Mac as the Dispatcher's user:
//
//   node slice-dry-run.mjs <dispatcher config> --product <name> --bot-id <the robot App's bot user id> [--result <file>]
//
// Step 1, the rules (this file): the rules the Dispatcher has adopted for the product are the slice's, read from the
// M10 reader's own state (its last good copy and the approval list), never from a copy of the file:
//   - the version in force is on the approval list (approved-rules.json, the stopgap until 0b-5), and the reader's last
//     good copy hashes to it;
//   - GitHub main's rules file, read now through the read-only client (the Dispatcher's own token file) and checked as
//     the reader checks it, is that same blob: main holding other or unapproved rules is a FAIL (L1132 M1), and so is
//     any read of main that fails, answers other than 200 or times out;
//   - it parses, M10's module checks pass, and it is a first-cutover product (cutover first, onboarding active) whose
//     owner said it is a test product (product.test_product 'true');
//   - the lanes are docs and research only, none covering the whole repo, and shakedown is on (P3, P17);
//   - the editing caps through M11's own editingLimits: one editing session while active; none while away, paused or
//     light; none at the amber usage band (L1122 m6: P8, P11);
//   - away merges only Tier 1 hours (P16); the robot's bot id is the one given, from the App, not from the file (P20);
//   - the merge gate refuses a slice/ file at first cutover (refusal 9: outside the docs and research lane), so Joe
//     merges the robot's PR by hand (L1122 m1).
// Steps 2-6 (the jobs, the go, the card, the push, the PR) say NOT WIRED and name what they wait for, until it lands.
// The result is PASS only when every step PASSes; a NOT WIRED step is never read as a pass.
// The config must be the Dispatcher's for this product. The result file is made new (never one already there, never
// through a link), 0600.

import { closeSync, constants, fsyncSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePolicy } from '../../modules/M10-rules/policy.mjs';
import { moduleProblems } from '../../modules/M10-rules/first-cutover.mjs';
import { blobSha, readProducts } from '../../modules/M10-rules/reader.mjs';
import { readOnlyClient, tokenFile } from '../../modules/M6-merge-gate/watch-only.mjs';
import { mainRules } from '../approve-rules.mjs';
import { makeEngine } from '../../modules/M10-rules/engine.mjs';
import { ROLES_DIR } from '../../modules/M10-rules/roles.mjs';
import { makeRules } from '../../shared/rules.mjs';
import { editingLimits } from '../../modules/M11-dispatcher/gate.mjs';
import { botId } from '../../modules/M6-merge-gate/gather.mjs';

const SHA = /^[0-9a-f]{40}$/;
const SLICE_FILE = 'slice/card.md';
const REFUSAL_9 = /^not this lane's change; MAIN merges it as today: slice\/card\.md is outside the docs and research lane$/;
const row = (ok, what, why) => ({ ok, what, ...(ok ? {} : { why }) });
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Step 1's rows, from what the M10 reader holds for `product` → [{ ok, what, why? }]. `approved` is approved-rules.json's
 * parsed contents (or an Error), `lastGood` the reader's <product>.last-good.json (or an Error); `main` GitHub main's
 * rules version, { commit, blob, text } from approve-rules' mainRules (or an Error); `bot` the bot id given; `ports` for tests.
 * Each later row needs the rules to have read: with none, one row says why and the rest are not tried.
 */
export function rulesRows({ product, bot, approved, lastGood, main, ports = {} }) {
  // Ports for tests: M10's module checks, M11's caps reading and the merge gate's answer, each the real one by default.
  const { moduleProblems: modChecks = moduleProblems, editingLimits: limitsOf = editingLimits, may } = ports;
  const rows = [];
  // The copy in force: the reader's own last good, which it saved only after it trusted it.
  const g = lastGood instanceof Error ? null : lastGood;
  const gWhy = lastGood instanceof Error ? `it can't be read (${lastGood.code ?? lastGood.message})` : 'it has no text, commit or blob';
  const copyOk = !!g && typeof g.text === 'string' && SHA.test(g.commit ?? '') && SHA.test(g.blob ?? '');
  rows.push(row(copyOk, `the Dispatcher's rules reader holds ${product}'s rules (its last good copy)`, `${gWhy}: the reader has not adopted them (merged on main? approved? the Dispatcher running?)`));
  if (!copyOk) return [...rows, row(false, 'the rest of the rules rows', 'not tried: no rules in force')];
  const hashed = blobSha(Buffer.from(g.text, 'utf8'));
  rows.push(row(hashed === g.blob, `that copy hashes to its blob ${g.blob.slice(0, 12)}…`, `it hashes to ${hashed.slice(0, 12)}…: the copy is damaged`));
  const list = approved instanceof Error ? null : approved?.[product];
  rows.push(row(Array.isArray(list) && list.includes(g.blob), `blob ${g.blob.slice(0, 12)}… is on the approval list (approved-rules.json)`,
    approved instanceof Error ? `the list can't be read (${approved.code ?? approved.message})` : `the list has no ${Array.isArray(list) ? 'such blob' : `entry for ${product}`} for it`));
  // What is merged on GitHub main must be this same version (L1132 M1): equal to the copy in force, which is on the list.
  const mOk = !!main && !(main instanceof Error) && SHA.test(main.commit ?? '') && SHA.test(main.blob ?? '');
  rows.push(row(mOk && main.blob === g.blob, `GitHub main's rules${mOk ? ` (commit ${main.commit.slice(0, 12)}…)` : ''} are the copy in force`,
    !mOk ? `main can't be read: ${main instanceof Error ? main.message : 'no answer'}` : `main holds blob ${main.blob.slice(0, 12)}…, the reader holds ${g.blob.slice(0, 12)}…: main has moved, or the reader is behind (approved? the Dispatcher running?)`));
  const r = parsePolicy(g.text);
  rows.push(row(r.ok, 'the rules parse', r.reason));
  if (!r.ok) return [...rows, row(false, 'the rest of the rules rows', 'not tried: the rules do not parse')];
  const p = r.policy;
  const mp = modChecks(p, product);
  rows.push(row(mp.length === 0, "M10's module checks pass", mp.join('; ')));
  rows.push(row(p.product?.cutover_stage === 'first', 'cutover_stage is first', `it is ${JSON.stringify(p.product?.cutover_stage)}`));
  rows.push(row(p.onboarding?.state === 'active', 'onboarding.state is active', `it is ${JSON.stringify(p.onboarding?.state)}`));
  rows.push(row(p.product?.test_product === 'true', "product.test_product is 'true' (the owner's yes to test cards)", `it is ${JSON.stringify(p.product?.test_product)}`));
  const lanes = Object.keys(p.lanes ?? {}).sort();
  rows.push(row(lanes.join() === 'docs,research', 'the lanes are docs and research only', `they are ${lanes.join(', ') || 'none'}`));
  const wide = lanes.flatMap((l) => [].concat(p.lanes[l] ?? []).filter((g) => /^\*\*(\/|$)/.test(String(g))).map((g) => `${l}: ${g}`));
  rows.push(row(wide.length === 0, 'no lane covers the whole repo', `${wide.join('; ')}`));
  rows.push(row(String(p.caps?.shakedown) === 'true', 'shakedown is on (one worker per product while it is new)', `caps.shakedown is ${JSON.stringify(p.caps?.shakedown)}`));

  // The rest through M10's engine and M11's own reading of the caps, as the Dispatcher reads them.
  const engine = makeEngine({ products: [product], rulesState: () => ({ status: 'ok', policy: p, commit: g.commit, blob: g.blob }), productState: () => ({ state: 'active' }), running: () => 0, rolesDir: ROLES_DIR, clock: () => Date.now() });
  const rules = makeRules(engine);
  const lim = (state, amberCaps) => { try { return limitsOf({ rules, product, productDoc: { state }, amberCaps }).product; } catch (e) { return `error: ${e.message}`; } };
  rows.push(row(lim('active', false) === 1, 'one editing session while the product is active', `the cap is ${lim('active', false)}`));
  for (const s of ['away', 'paused', 'light']) rows.push(row(lim(s, false) === 0, `no editing session while it is ${s}`, `the cap is ${lim(s, false)}`));
  rows.push(row(lim('active', true) === 0, 'no editing session at the amber usage band', `the cap is ${lim('active', true)}`));
  const away = p.product_state_rules?.away?.tier1_merge;
  rows.push(row(away === 'tier1_hours_only', 'while away, Tier 1 merges wait for Tier 1 hours', `away.tier1_merge is ${JSON.stringify(away)}`));
  const got = botId(p.product_profile?.robot);
  const want = botId({ bot_user_id: bot });
  rows.push(row(want !== null && got === want, `the robot's bot id is ${bot} (given, from the App)`, want === null ? `--bot-id ${JSON.stringify(bot)} is not a bot id` : `the rules say ${got ?? 'none'}`));
  const checks = p.product_profile?.required_checks;
  rows.push(row(Array.isArray(checks) && checks.length > 0, 'every merge needs a named check', 'required_checks is empty'));
  let m; try { m = (may ?? ((...a) => engine.may(...a)))('merge', { product, files: [{ path: SLICE_FILE, status: 'added', mode: '100644', added_lines: ['x'] }], declared_tier: 2, labels: [] }); } catch (e) { m = { decision: 'error', reason: e.message }; }
  rows.push(mergeRow(m));
  return rows;
}

/** The merge gate's answer for the slice's file → its row: only refusal 9 passes, not any other refusal. */
export function mergeRow(m) {
  return row(m?.decision === 'deny' && REFUSAL_9.test(m.reason ?? ''), `the merge gate refuses ${SLICE_FILE} (refusal 9: outside the docs and research lane), so the owner merges by hand`,
    `it answers ${m?.decision}: ${m?.reason ?? 'no reason'}`);
}

/** The steps after the rules, until their parts land: each says what it waits for. */
export const NOT_WIRED = Object.freeze([
  ['2 the jobs (Sensors, owner answer, Dispatcher, worker runner, robot) are loaded and fresh', 'the Sensors job (#502), the worker runner job (#537)'],
  ['3 the go: print the go command and wait for the card', 'the go command, setup/go-card.mjs (#523)'],
  ['4 the card: ready, claimed, running, reporting, each within its time limit', 'the card watch, after #523'],
  ['5 the push: the bundle in the outbox, scanned, pushed to card/<id>', 'the push wiring (#516, lane N) and the scanner (#525)'],
  ['6 the PR: base main, author the robot, only the card\'s file', 'the push wiring'],
]);

const realGh = (c) => readOnlyClient({ token: tokenFile(c.tokenFile) });

/** The whole run → { lines, pass }. `read`, `products` and `gh` are ports for tests. */
export async function dryRun({ config, product, bot, read = readJson, products = readProducts, gh = realGh }) {
  const c = read(config);
  if (c?.product !== product) throw new Error(`${config} is the Dispatcher's config for ${JSON.stringify(c?.product)}, not ${product}`);
  const dir = c?.rulesStateDir;
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new Error(`${config} has no full rulesStateDir`);
  const tryRead = (f) => { try { return read(f); } catch (e) { return e; } };
  let onMain;
  try {
    const entry = products(c.productsFile).find((x) => x.product === product);
    if (!entry) throw new Error(`products.json has no ${product}`);
    onMain = await mainRules(gh(c), entry);
  } catch (e) { onMain = e; }
  const rows = rulesRows({ product, bot, approved: tryRead(join(dir, 'approved-rules.json')), lastGood: tryRead(join(dir, `${product}.last-good.json`)), main: onMain });
  const lines = ['step 1 the rules'];
  for (const r of rows) lines.push(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.what}${r.ok ? '' : ` — ${r.why}`}`);
  const one = rows.every((r) => r.ok);
  for (const [what, waits] of NOT_WIRED) lines.push(`step ${what}`, `  NOT WIRED  waits for ${waits}`);
  const passed = one ? 1 : 0;
  lines.push(`RESULT: ${one ? 'NOT DONE' : 'FAIL'} (${passed}/${1 + NOT_WIRED.length} steps PASS; ${NOT_WIRED.length} NOT WIRED)`);
  return { lines, pass: false };
}

export function parseArgs(argv) {
  const [config, ...rest] = argv;
  const o = { config };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]; const v = rest[i + 1];
    if (!['--product', '--bot-id', '--result'].includes(k) || v === undefined) throw new Error(`unknown or empty argument ${k}`);
    o[{ '--product': 'product', '--bot-id': 'bot', '--result': 'result' }[k]] = v;
  }
  if (!config?.startsWith('/') || !o.product || !o.bot) throw new Error('usage: node slice-dry-run.mjs <dispatcher config, full path> --product <name> --bot-id <n> [--result <file>]');
  return o;
}

/** The result file, made new: never one already there, never through a link (O_EXCL refuses both), 0600. */
export function writeNew(file, text) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), write = writeNew, ...ports } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { err(e.message); return 2; }
  let r; try { r = await dryRun({ ...o, ...ports }); } catch (e) { err(`stopped: ${e.message}`); return 2; }
  for (const l of r.lines) out(l);
  if (o.result) {
    try { write(o.result, `${new Date().toISOString()}\n${r.lines.join('\n')}\n`); } catch (e) { err(`stopped: the result file ${o.result} can't be made new (${e.code ?? e.message}); give a name that is not there yet`); return 2; }
  }
  return r.pass ? 0 : 1;
}

// argv[1] resolved first: run through a link it is the link's path, not this file's (the #261 class).
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
