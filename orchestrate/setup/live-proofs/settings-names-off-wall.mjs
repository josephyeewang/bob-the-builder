#!/usr/bin/env node
// Live proof, off the builder account (L1335): the settings-names pairs that read Claude Code's own network filter
// (TESTS marked walled). As the builder they show nothing, as builder wall v2 keeps the builder's shell off the port that
// filter listens on (settings-names.mjs WALLED), so settings-names.mjs skips them there and counts each only on its
// CONFIRMED entry for the same version, naming that pair. This runs them with the same pinned claude as any other user,
// signed in as that user, and prints the CONFIRMED lines to add for each name whose pairs here all passed. A walled name
// with a spelling pair (SPELLING_ONLY: strictAllowlist) has it run here too, so its entry stands on both (L1114, L1128 M1).
//
//   node <installRoot>/setup/live-proofs/settings-names-off-wall.mjs --config <the worker runner's config>
//
// The strictAllowlist pairs run without the sources limit (they need the project's settings file), so this user's own
// settings load on both sides of those, as the builder's do in the proof; the receipt says so (userSettings).
import { NO_CONFIG } from './builder-proxy.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROOF, TESTS, readRunnerConfigForProof, runAll, runToEnd } from './settings-names.mjs';
import { FLAGS as F } from '../../modules/M4-workshop/launcher/settings-names.mjs';
import { BUILDER } from '../layout.mjs';

export const WALLED_TESTS = TESTS.filter((t) => t.walled);
const WALLED_NAMES = new Set(WALLED_TESTS.flatMap((t) => t.names));
/** The walled pairs and the spelling pairs of their names: everything a walled name's CONFIRMED entry must stand on. */
export const OFF_WALL_TESTS = TESTS.filter((t) => t.walled || (t.kind === 'spelling' && t.names.some((n) => WALLED_NAMES.has(n))));

/** The CONFIRMED line for each name of a passed pair. */
export const confirmedLines = (t, pin) => t.names.map((n) => `  [SETTINGS.${n}]: Object.freeze({ by: '${t.kind}:${PROOF} "${t.title.replace(/'/g, "\\'")}"', version: '${pin}' }),`);

const REAL = {
  readConfig: readRunnerConfigForProof,
  version: (bin, env) => /^(\d+\.\d+\.\d+)/.exec(execFileSync(bin, [F.version], { encoding: 'utf8', timeout: 30_000, env }).trim())?.[1] ?? null,
  runAll,
  makeBase: () => mkdtempSync(join(tmpdir(), 'settings-names-off-wall-')),
};

export async function main(argv, { print = (t) => process.stdout.write(t), uid = process.getuid?.(), user = userInfo().username, home = homedir(), deps = {} } = {}) {
  const d = { ...REAL, ...deps };
  const i = argv.indexOf('--config'); const path = i >= 0 ? argv[i + 1] : undefined;
  if (!path || !path.startsWith('/')) { print(NO_CONFIG); return 1; }
  if (uid === 0) { print('NOT DONE: run it as your own user, not root; nothing was run\n'); return 1; }
  if (user === BUILDER) { print(`NOT DONE: as ${BUILDER} these pairs show nothing (the builder wall); run it from another account; nothing was run\n`); return 1; }
  let c; try { c = d.readConfig(path); } catch (e) { print(`NOT DONE: ${path} can't be read (${e?.code ?? e?.message ?? e}); nothing was run\n`); return 1; }
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: user };
  let v = null; try { v = d.version(c.claudeBin, env); } catch { /* not readable */ }
  if (!v || v !== c.pin) { print(`NOT DONE: ${c.claudeBin} says ${v ?? 'nothing'}, not the pin ${c.pin}; nothing was run\n`); return 1; }
  const base = d.makeBase();
  const io = { claude: (args, { cwd, input }) => runToEnd(c.claudeBin, args, { cwd, env, input }), readbackAll: async () => ({ ok: null }), sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }) };
  const { outcomes } = await d.runAll({ base, io, tests: OFF_WALL_TESTS });
  const lines = []; let ok = true;
  const passed = (t) => outcomes[t.id]?.ok === true;
  for (const t of OFF_WALL_TESTS) {
    const o = outcomes[t.id] ?? { ok: false, why: 'did not run' };
    const result = o.ok === true ? 'PASS' : o.ok === null ? 'NOT TRIED' : 'FAIL';
    ok &&= o.ok === true;
    print(`${result.padEnd(9)} ${t.id}: ${t.title}${o.ok === true ? '' : ` (${o.notTried ?? o.why})`}\n`);
  }
  // An entry for a name only when every pair of it here passed; it names the walled pair, as judgeNames asks.
  for (const t of WALLED_TESTS) {
    const names = t.names.filter((n) => OFF_WALL_TESTS.filter((x) => x.names.includes(n)).every(passed));
    if (names.length) lines.push(...confirmedLines({ ...t, names }, c.pin));
  }
  try { writeFileSync(join(base, 'receipt.json'), `${JSON.stringify({ pin: c.pin, user, outcomes }, null, 2)}\n`); print(`The runs and receipt.json are in ${base}.\n`); } catch (e) { print(`The receipt could not be written (${e?.message ?? e}).\n`); }
  if (lines.length) print(`Add to CONFIRMED in modules/M4-workshop/launcher/settings-names.mjs:\n${lines.join('\n')}\n`);
  print(ok ? `PASS on Claude Code ${c.pin}: every walled pair\n` : `NOT DONE on Claude Code ${c.pin}: not every walled pair passed\n`);
  return ok ? 0 : 1;
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (self === import.meta.url) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
