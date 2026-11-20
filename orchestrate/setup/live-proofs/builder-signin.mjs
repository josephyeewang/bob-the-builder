#!/usr/bin/env node
// Live proof (L1261): a builder session can sign in with the long-lived token file, on the pinned claude. Joe pastes one
// command on the Mini, as the worker runner's own Mac user, after `sudo /usr/local/bin/node setup.mjs builder-signin`:
//
//   sudo -H -u builder <installRoot>/bin/node <installRoot>/setup/live-proofs/builder-signin.mjs --config <installRoot>/worker-runner.json
//
// (<installRoot> is the installed copy, <base>/install/orchestrate: setup/install.mjs installPaths.)
//
// It reads the sign-in exactly as the runner does before a start (runner-ports.mjs workerAccount, then sessionEnv: the one
// form of a session's environment, held to launch check 9), then starts the config's pinned claude once, headless, with no
// tools, one turn, no settings sources and nothing kept: `-p "Reply with the word OK."`. PASS when claude ends with
// success and its answer holds OK; else FAIL with claude's own words, any byte of the token masked; NOT DONE when it
// could not be tried (root, another user, not the pin, no sign-in). The token is never printed, never put on the command
// line (the secret guard throws if it were), and only this one claude is given it, in its environment. It writes only
// claude's own settings in builder's home (and its own temp folder, removed after), and needs no lock: it starts no
// session of the runner's.
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRunnerConfig, readRunnerConfig } from '../../wiring/runner-main.mjs';
import { sessionEnv, workerAccount } from '../../wiring/runner-ports.mjs';
import { holdsSecret } from '../../shared/secret-guard.mjs';
import { configUnreadable, notOwnUser, pinProblem } from './before-run.mjs';

export const PROMPT = 'Reply with the word OK.';
/** The one claude start, by flag: no tools, one turn, no settings sources, nothing kept, one JSON answer. */
export const proofArgs = () => ['-p', PROMPT, '--tools', '', '--max-turns', '1', '--setting-sources', '', '--no-session-persistence', '--output-format', 'json'];

/** What claude's run shows: { result: 'PASS' | 'FAIL', why }. Nothing of the token reaches `why`. */
export function judge(r) {
  // Masked before it is cut short (a cut token would no longer match): the registered value, and anything shaped like a key.
  const mask = (t) => (holdsSecret(t) ? '(withheld: it held the sign-in)' : t.replace(/sk-ant-[A-Za-z0-9_-]+/g, '(withheld)'));
  const said = (t) => mask(String(t ?? '').trim()).split('\n').slice(-2).join(' ').slice(0, 200) || 'nothing';
  if (r?.error) return { result: 'FAIL', why: `claude could not be run (${r.error.code ?? r.error.message})` };
  let j = null; try { j = JSON.parse(String(r?.stdout ?? '')); } catch { /* not its JSON answer */ }
  if (r?.status !== 0 || !j || j.is_error === true || j.subtype !== 'success') return { result: 'FAIL', why: `claude ended with ${r?.status ?? r?.signal}: ${said(j?.result ?? r?.stderr ?? r?.stdout)}` };
  return /\bOK\b/i.test(String(j.result ?? '')) ? { result: 'PASS', why: 'claude signed in with the builder sign-in file and answered' } : { result: 'FAIL', why: `claude answered without OK: ${said(j.result)}` };
}

const REAL = {
  // Checked, as runlocked reads it (L1318): the check is what adds ownDir, the runner's own folder.
  readConfig: (f) => checkRunnerConfig(readRunnerConfig(f, realpathSync(fileURLToPath(new URL('../../wiring/runner-main.mjs', import.meta.url))))),
  uid: () => process.getuid(),
  ownerOf: (p) => lstatSync(p).uid,
  version: (bin) => /^(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim())?.[1] ?? null,
  account: (c) => workerAccount(c),
  run: (bin, args, opts) => spawnSync(bin, args, { ...opts, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }),
  tmp: () => tmpdir(),
};

export function main(argv, { print = (t) => process.stdout.write(t), deps = REAL } = {}) {
  const d = { ...REAL, ...deps };
  const i = argv.indexOf('--config'); const file = i >= 0 ? argv[i + 1] : undefined;
  if (!file) { print('Usage: builder-signin.mjs --config <the worker runner\'s config>\n'); return 2; }
  const no = (why) => { print(`NOT DONE: ${why}; nothing was run\n`); return 1; };
  const uid = d.uid();
  if (uid === 0) return no('it runs as root. Run it as the builder user (sudo -H -u builder …)');
  let c; try { c = d.readConfig(file); } catch (e) { return no(configUnreadable(e)); }
  let ownDirUid; try { ownDirUid = d.ownerOf(c.ownDir); } catch (e) { return no(`the worker runner's own folder ${c.ownDir} can't be looked at (${e?.code ?? e?.message})`); }
  const who = notOwnUser({ c, uid, ownDirUid }); if (who) return no(who);
  if (c.signinFile === undefined) return no('the config names no builder sign-in file (signinFile): run setup worker-config again');
  let v; try { v = d.version(c.claudeBin); } catch { v = null; }
  const pin = pinProblem({ c, claudeVersion: v }); if (pin) return no(pin);
  const a = d.account(c);
  if (!a?.account || a.signinToken !== true) return no(`no builder sign-in (${a?.reason ?? 'no answer'})`);
  const built = sessionEnv(c, a);
  if (!built?.ok) return no(`the session's environment: ${built?.reason ?? 'no answer'}`);
  const dir = mkdtempSync(join(d.tmp(), 'builder-signin-'));
  let j;
  try { j = judge(d.run(c.claudeBin, proofArgs(), { cwd: dir, env: built.env })); } catch (e) { j = { result: 'FAIL', why: `claude could not be started (${e?.code ?? 'error'})` }; } finally { rmSync(dir, { recursive: true, force: true }); }
  print(`${j.result}: ${j.why}, on claude ${c.pin}\n`);
  return j.result === 'PASS' ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
