// slice-dry-run.mjs — the thin slice's dry run (N5, L1099 Q5): watch one test card go from the rules to the robot's PR,
// and write nothing but its own result file. Run on the always-on Mac as the Dispatcher's user:
//
//   node slice-dry-run.mjs <dispatcher config> --product <name> --bot-id <the robot App's bot user id> [--result <file>]
//
// Step 1, the rules (this file): the rules the Dispatcher has adopted for the product are the slice's, read from the
// M10 reader's own state (its last good copy and the approval list), never from a copy of the file:
//   - the version in force is on the approval list (approved-rules.json, the stopgap until 0b-5), and the reader's last
//     good copy hashes to it;
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

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePolicy } from '../../modules/M10-rules/policy.mjs';
import { moduleProblems } from '../../modules/M10-rules/first-cutover.mjs';
import { blobSha } from '../../modules/M10-rules/reader.mjs';
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
 * parsed contents (or an Error), `lastGood` the reader's <product>.last-good.json (or an Error); `bot` the bot id given.
 * Each later row needs the rules to have read: with none, one row says why and the rest are not tried.
 */
export function rulesRows({ product, bot, approved, lastGood }) {
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
  const r = parsePolicy(g.text);
  rows.push(row(r.ok, 'the rules parse', r.reason));
  if (!r.ok) return [...rows, row(false, 'the rest of the rules rows', 'not tried: the rules do not parse')];
  const p = r.policy;
  const mp = moduleProblems(p, product);
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
  const lim = (state, amberCaps) => { try { return editingLimits({ rules, product, productDoc: { state }, amberCaps }).product; } catch (e) { return `error: ${e.message}`; } };
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
  let m; try { m = engine.may('merge', { product, files: [{ path: SLICE_FILE, status: 'added', mode: '100644', added_lines: ['x'] }], declared_tier: 2, labels: [] }); } catch (e) { m = { decision: 'error', reason: e.message }; }
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

/** The whole run → { lines, pass }. `read` is a port for tests. */
export function dryRun({ config, product, bot, read = readJson }) {
  const c = read(config);
  const dir = c?.rulesStateDir;
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new Error(`${config} has no full rulesStateDir`);
  const tryRead = (f) => { try { return read(f); } catch (e) { return e; } };
  const rows = rulesRows({ product, bot, approved: tryRead(join(dir, 'approved-rules.json')), lastGood: tryRead(join(dir, `${product}.last-good.json`)) });
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

export function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), write = writeFileSync, read } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { err(e.message); return 2; }
  let r; try { r = dryRun({ ...o, ...(read ? { read } : {}) }); } catch (e) { err(`stopped: ${e.message}`); return 2; }
  for (const l of r.lines) out(l);
  if (o.result) write(o.result, `${new Date().toISOString()}\n${r.lines.join('\n')}\n`, { mode: 0o600 });
  return r.pass ? 0 : 1;
}

// argv[1] resolved first: run through a link it is the link's path, not this file's (the #261 class).
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) process.exitCode = main(process.argv.slice(2));
