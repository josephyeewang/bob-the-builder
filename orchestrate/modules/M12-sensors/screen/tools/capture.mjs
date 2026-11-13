#!/usr/bin/env node
// R-0b-150: capture real Claude Code screens, labelled by the script run that produced them, to test the screen rules.
//
// Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../third_party/herdr/NOTICE.
// Source: scripts/capture_agent_screen.py (repeated pane reads per labelled state, a folder per capture, metadata
// beside the samples), ported from Python to JavaScript and changed:
//   - herdr asks a person to name each state as it captures; here each label comes from the scenario the script
//     drove, never from a person's or an AI's reading of the screen. A scenario whose own expected text never shows
//     is reported and saves nothing;
//   - herdr reads panes through its own server; here a throwaway tmux server (-L, its own name, -f /dev/null) started
//     with roleEnv's clean environment, in a throwaway git repo, with the user's own settings, hooks and MCP servers
//     left out (--setting-sources project, --strict-mcp-config);
//   - every screen is scrubbed and must pass fixture-check.mjs before it is written; a refused screen is never saved.
//
// Until R-0b-174 is wired this starts the launch shape itself; R-0b-152b re-takes the fixtures if the real one differs.
// Run (owner-side, by hand):
//   node capture.mjs --claude <pinned claude binary> [--newer <a newer claude binary>] --out <folder> [--only <label>]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { roleEnv } from '../../../M4-workshop/launcher/env-check.mjs';
import { gitOk } from '../../../M4-workshop/git/safe-git.mjs';
import { fixtureProblems, scrubScreen } from './fixture-check.mjs';
import { ELICIT_MESSAGE } from './elicit-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const COLS = 140;
export const ROWS = 45;
export const SAMPLES = 3;
const STABLE_MS = 3000; // a screen unchanged this long is waiting for someone (a spinner or timer always moves)
const WAIT_MS = 150_000;

// Text that must not show on a screen saved as idle: a startup question still open (2.1.322's trust question also
// carries ❯, on its "No, exit" line).
const NOT_IDLE = Object.freeze(['trust this folder', 'enter to confirm', 'esc to cancel', 'do you want', 'teach auto mode']);
// A working screen must also not show a question (the turn ended and one opened, as 2.1.322's auto-mode prompt did).
const NOT_WORKING = Object.freeze([...NOT_IDLE, 'enter to select']);

// Each scenario: what to type (keys, or text then Enter), the text its own result must show before anything is
// saved (lowercase, the script's check that the scenario got where it meant to), text that must not show (absent),
// and the label it saves under.
export const SCENARIOS = Object.freeze([
  { label: 'question-folder-trust', fresh: true, expect: ['trust this folder'], then: ['Down', 'Enter'] },
  { label: 'idle', expect: ['❯'], absent: NOT_IDLE, colour: true },
  // 2.1.322 refuses a standalone sleep and ends the turn at once, so the working task is a 30-second ping; every
  // sample must show "esc to interrupt", or a footer that merely changed would pass as working.
  { label: 'working', args: ['--allowedTools', 'Bash(/sbin/ping:*)'], send: 'Run exactly this bash command and nothing else: /sbin/ping -c 30 127.0.0.1', moving: true, expect: ['esc to interrupt'], absent: NOT_WORKING },
  { label: 'question-permission', send: 'Run exactly this bash command and nothing else: touch fixture-made.txt', expect: ['fixture-made.txt'] },
  { label: 'question-multiple-choice', send: 'Use the AskUserQuestion tool now to ask me one question, "Pick a colour", with the options Red and Blue. Do nothing else.', expect: ['pick a colour', 'red', 'blue'] },
  { label: 'question-plan-approval', args: ['--permission-mode', 'plan'], send: 'Plan to create hello.txt containing the word hi. Do not read any files. Call ExitPlanMode with that one-step plan now.', expect: ['hello.txt'] },
  { label: 'question-named-session', send: 'First create three tasks with your task tool: alpha, beta, gamma. Then use the AskUserQuestion tool to ask "Which first?" with the options Alpha and Beta. Do nothing else.', expect: ['which first', 'gamma'] },
  { label: 'question-mcp-input', mcp: true, send: 'Call the ask_name tool from the fixture MCP server now. Do nothing else.', expect: [ELICIT_MESSAGE.toLowerCase()] },
  { label: 'idle-newer-version', newer: true, expect: ['❯'], absent: NOT_IDLE },
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeTmux(server, env) {
  const run = (...args) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    run,
    screen: (colour = false) => run('capture-pane', '-p', ...(colour ? ['-e'] : []), '-t', 'cap'),
    title: () => run('display-message', '-p', '-t', 'cap', '#{pane_title}').replace(/\n$/, ''),
    keys: (...k) => run('send-keys', '-t', 'cap', ...k),
    text: (t) => { run('send-keys', '-t', 'cap', '-l', t); run('send-keys', '-t', 'cap', 'Enter'); },
    kill: () => { try { run('kill-session', '-t', 'cap'); } catch { /* already gone */ } },
    killServer: () => { try { run('kill-server'); } catch { /* already gone */ } },
  };
}

// A running tool call's ⏺ blinks on and off at the start of its line while an MCP form is open, so stillness is
// judged with it blanked; the saved samples keep it.
export const still = (screen) => String(screen ?? '').replace(/^(\s*)⏺/gm, '$1 ');

// Wait until the screen has not changed for STABLE_MS; returns the screen, or null on timeout.
async function settle(tmux, { atLeast = 0 } = {}) {
  const start = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - start < WAIT_MS) {
    await sleep(500);
    let now;
    try { now = tmux.screen(); } catch { return null; }
    if (still(now) !== still(last)) { last = now; since = Date.now(); }
    else if (Date.now() - since >= STABLE_MS && Date.now() - start >= atLeast) return now;
  }
  return null;
}

async function samples(tmux, n, gapMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i) await sleep(gapMs);
    out.push({ text: tmux.screen(), title: tmux.title(), at: Date.now() });
  }
  return out;
}

/** null when the screen shows the scenario got where it meant to; otherwise why not. */
export function reached(s, screen) {
  const lower = String(screen ?? '').toLowerCase();
  const missing = (s.expect ?? []).filter((e) => !lower.includes(e));
  if (missing.length) return `its expected text never showed (${missing.length} of ${s.expect.length} missing)`;
  const present = (s.absent ?? []).filter((e) => lower.includes(e));
  if (present.length) return `text that must not show did (${present.length})`;
  return null;
}

export async function runScenario(s, { tmux, claude, repo, home, host, user, values, mcpConfig }) {
  // The permission mode is pinned so the account's own default (auto mode, and its onboarding question) stays out.
  const mode = (s.args ?? []).includes('--permission-mode') ? [] : ['--permission-mode', 'default'];
  const args = ['--setting-sources', 'project', '--strict-mcp-config', '--model', 'sonnet', ...mode, ...(s.args ?? [])];
  if (s.mcp) args.push('--mcp-config', mcpConfig, '--allowedTools', 'mcp__fixture__ask_name');
  tmux.run('new-session', '-d', '-s', 'cap', '-x', String(COLS), '-y', String(ROWS), '-c', repo, claude, ...args);
  try {
    let shown = await settle(tmux, { atLeast: 2000 });
    if (shown === null) return { label: s.label, saved: false, why: 'the session never settled after start' };
    let taken;
    if (s.send) {
      tmux.text(s.send);
      if (s.moving) {
        await sleep(5000);
        taken = await samples(tmux, SAMPLES, 1000);
        if (new Set(taken.map((x) => x.text)).size < 2) return { label: s.label, saved: false, why: 'the screen did not move while working' };
        const off = taken.map((x, i) => [i + 1, reached(s, x.text)]).filter(([, w]) => w);
        if (off.length) return { label: s.label, saved: false, why: `sample ${off[0][0]}: ${off[0][1]}` };
      } else {
        shown = await settle(tmux, { atLeast: 3000 });
        if (shown === null) return { label: s.label, saved: false, why: 'the session never settled after the prompt' };
      }
    }
    if (!taken) {
      const why = reached(s, shown);
      if (why) return { label: s.label, saved: false, why };
      taken = await samples(tmux, SAMPLES, 1000);
    }
    const colour = s.colour ? tmux.screen(true) : null;
    // A refusal names the piece and the masker's rule, never the text, so it can be traced without printing it.
    const masks = [];
    const scrub = (t, piece) => { const r = scrubScreen(t, { repo, home, host }); if (r.masked.length) masks.push(`${piece}: ${[...new Set(r.masked)].join(',')}`); return r.text; };
    const check = (t, piece) => fixtureProblems(t, { home, user, values }).map((p) => `${p} (${piece})`);
    const files = taken.map((x, i) => ({ ...x, text: scrub(x.text, `sample ${i + 1}`), title: scrub(x.title, `title ${i + 1}`) }));
    const colourText = colour === null ? null : scrub(colour, 'colour');
    const problems = [...files.flatMap((f, i) => [...check(f.text, `sample ${i + 1}`), ...check(f.title, `title ${i + 1}`)]), ...(colourText === null ? [] : check(colourText, 'colour')), ...masks.map((m) => `masked by ${m}`)];
    if (problems.length) return { label: s.label, saved: false, why: `refused before saving: ${[...new Set(problems)].join('; ')}` };
    for (const k of s.then ?? []) tmux.keys(k);
    return { label: s.label, saved: true, files, colour: colourText };
  } finally {
    if (!s.then) { try { tmux.keys('Escape'); } catch { /* gone */ } }
    if (!s.then) tmux.kill();
  }
}

function version(bin, env) {
  return execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim().split(/\s+/)[0];
}

function saveFixture(out, result, meta) {
  const dir = join(out, result.label);
  mkdirSync(dir, { recursive: true });
  result.files.forEach((f, i) => writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')}.txt`), f.text));
  if (result.colour !== null && result.colour !== undefined) writeFileSync(join(dir, 'coloured.ansi'), result.colour);
  const first = result.files[0].at;
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({
    ...meta, label: result.label, cols: COLS, rows: ROWS,
    samples: result.files.map((f, i) => ({ file: `${String(i + 1).padStart(2, '0')}.txt`, title: f.title, after_ms: f.at - first })),
  }, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const claude = opt('--claude');
  const newer = opt('--newer');
  const out = opt('--out');
  const only = opt('--only');
  if (!claude || !out) { console.error('usage: capture.mjs --claude <bin> [--newer <bin>] --out <folder> [--only <label>]'); return 2; }
  const home = homedir();
  const user = userInfo().username;
  const host = hostname();
  // Private words no screen may carry: the network name and its parts, and each part of the owner's full name.
  let fullName = '';
  try { fullName = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim(); } catch { /* not on this Mac */ }
  const values = [...new Set([host, ...host.split(/[.\-\s]/), ...fullName.split(/\s+/)])].filter((v) => v.length >= 3 && !['local', 'mac', 'mini', 'macbook', 'air', 'pro'].includes(v.toLowerCase()));
  const env = roleEnv(process.env, { path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' });
  const server = `bob-capture-${process.pid}`;
  const tmux = makeTmux(server, env);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'bob-capture-')));
  await gitOk(['init', '-q', repo], { gitDir: join(repo, '.git'), cwd: repo, purpose: 'screen capture: a throwaway repo' });
  writeFileSync(join(repo, 'README.md'), 'A throwaway repo for screen captures.\n');
  const mcpConfig = join(repo, '..', `${server}-mcp.json`);
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [join(HERE, 'elicit-server.mjs')] } } }));
  const results = [];
  try {
    for (const s of SCENARIOS) {
      if (only && s.label !== only && !s.fresh) continue;
      if (s.newer && !newer) { results.push({ label: s.label, saved: false, why: 'no --newer binary given' }); continue; }
      const bin = s.newer ? newer : claude;
      const r = await runScenario(s, { tmux, claude: bin, repo, home, host, user, values, mcpConfig });
      if (s.then) await sleep(4000), tmux.kill();
      if (r.saved && (!only || s.label === only)) saveFixture(out, r, { scenario: s.label, claude_code_version: version(bin, env), tool: 'screen/tools/capture.mjs', captured_on: new Date().toISOString().slice(0, 10) });
      results.push(r);
      console.log(`${r.saved ? 'saved  ' : 'NOT    '} ${r.label}${r.saved ? '' : `: ${r.why}`}`);
    }
  } finally {
    tmux.killServer();
    rmSync(repo, { recursive: true, force: true });
    rmSync(mcpConfig, { force: true });
  }
  return results.every((r) => r.saved) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().then((c) => { process.exitCode = c; });
