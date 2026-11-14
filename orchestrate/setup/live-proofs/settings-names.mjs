// Live check L2 with L6 (row R-0b-177; L1091, L1093, L1108, L1109): every Claude Code setting, flag and variable name the
// launcher writes (M4 launcher/settings-names.mjs), proven on the pinned claude. Joe pastes one command on the Mini, as
// the worker runner's own Mac user:
//
//   sudo -H -u builder <installRoot>/bin/node <installRoot>/setup/live-proofs/settings-names.mjs --config <the worker runner's config>
//
// (<installRoot> is the installed copy, <base>/install/orchestrate: setup/install.mjs installPaths.)
//
// It prints one line per name: PASS, FAIL or NOT TRIED, with how it was proven or why not. A name no test ran is NOT
// TRIED, never PASS. The receipt, settings-names-proof-<time>.jsonl in the user's home, holds the pin and one line per
// name; each PASS line carries the `by` a CONFIRMED entry takes. Every run writes one, a refused one too, and prints
// "Written to <path>": that path, not the newest file, is the run's receipt (L1124 m5). The run's last line is
// "PASS: …" only when every name passed and the receipt was written, else "NOT DONE: …" naming the rest; it exits 0
// only on PASS. The result holds for that pin only, and is void, to
// be run again, whenever the pin moves (Principle 9).
//
// How a name is proven. Each test starts the pinned claude headless twice, the same way but for one thing (a pair):
//   - a break-it pair: the setting on, and the thing it stops does not happen; the setting off (the control), and it does;
//   - or the other way about, for a setting that lets something happen;
//   - a read-back: the start message (stream-json `system`/`init`) shows what was asked for, and the control shows the
//     other value. The role read-back (TESTS 'role read-back') is launch check 6 itself: each role's real rendered file,
//     roleArgs and checkInit, on the pin.
// What happened is read from the disk wherever it can be (a marker file a hook or command writes), not from the
// stream's names, which are themselves unproven. A test passes only when both runs show what they must.
//
// A side counts only if it ran properly (audit L1124 m1): a start message, a result line that is a success (readResult,
// the dispatcher's one reading of it, and no "API Error"), and, for a test that asks for a command, a tool call holding
// it. A side the pair expects refused also needs claude's refusal of that call, of the kind the test expects (a
// permission denial, the sandbox, the network, a hook). Anything else makes the test NOT TRIED, with the reason, never
// PASS: a run that broke shows nothing about the name. One thing outranks that (L1128 m1): a marker on a side where the
// setting must stop it is the setting failing, so FAIL, however that run ended. And a name passes only when every test
// of it passed (L1128 M1): one NOT TRIED test leaves the name NOT TRIED.
//
// Every run uses the runner's own environment for a session (wiring/runner-ports.mjs sessionEnv: its PATH, the
// sessions' home, the account in use) and `--setting-sources ""` (settings-names.mjs sourcesArgs) unless the test is
// about the sources. One test writes the account's user settings file (<account folder>/settings.json, the one claude
// reads through CLAUDE_CONFIG_DIR) and puts it back byte for byte, mode too, or removes it if it was not there (L1109).
// The backup is the file's own bytes, beside it, with a small note of whether it was there and its mode. It refuses to
// start while a backup from an earlier run is left over, and puts the file back in a finally block. A run cut off
// leaves the backup; the same command with --restore added puts the file back from it (or removes it) and checks it.
//
// It refuses to run (every name NOT TRIED, exit 1) unless: it runs as the user that owns the runner's own folder, and
// not as root; the config names the pinned claude and `claude --version` is that pin; the worker runner is not running
// (its lock is taken for the run, so no session of the runner reads the user settings file while it is changed); and no
// earlier backup is left over.
//
// Names that no test can prove live yet stay NOT TRIED (L1109): a role file that writes one keeps failing launch check 0.
// A test that could not show its name (a spelling pair with no difference, an account with no claude.ai connector) makes
// it NOT TRIED with the reason, never PASS. failIfUnavailable, strictAllowlist and crossSessionInbound are proven by a
// spelling pair (L1114): the output says "name confirmed (spelling pair)", never their behaviour, which is R-0b-178.
// enabledPlugins is no longer written (L1114) and shows NOT USED, not counted.
// apiKeyHelper and disableAllHooks (REFUSED_SETTINGS) are not proven: the launcher refuses them in every role file, and
// the run says so.
// What claude does that this harness reads (its start message, its warnings, its result line) was read in the pinned
// version's own code (checked: claude-code 2.1.316).

import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync, fsyncSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn as childSpawn } from 'node:child_process';
import { readJobConfig } from '../../shared/job-config.mjs';
import { makeLock } from '../../modules/M9-record/lock.mjs';
import { checkRunnerConfig } from '../../wiring/runner-main.mjs';
import { sessionEnv } from '../../wiring/runner-ports.mjs';
import { ACCOUNT_NAMES, accountDir, accountInUse } from '../../modules/M4-workshop/launcher/accounts.mjs';
import { readResult } from '../../modules/M11-dispatcher/headless-result.mjs';
import { FLAGS as F, SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E, ENV, REFUSED_SETTINGS, CONFIRMED, SPELLING_ONLY, noToolServerArgs, proofCounts, sourcesArgs } from '../../modules/M4-workshop/launcher/settings-names.mjs';
import { roleArgs, findInit, checkInit } from '../../modules/M4-workshop/launcher/readback.mjs';
import { renderRoleSettings } from '../../modules/M4-workshop/launcher/render-settings.mjs';
import { FIRST_ROUND_EFFORT, SEND_BACK_EFFORT } from '../../modules/M4-workshop/launcher/review-launch.mjs';
import { DESIGN_PROFILES } from '../../modules/M4-workshop/launcher/role-profiles.mjs';
import { RUNNER_ROLES } from '../../shared/review-roles.mjs';

export const PROOF = 'settings-names.mjs';
export const RUN_MS = 180_000;
export const BACKUP_SUFFIX = '.settings-names-proof-backup';
// The note beside the backup: { had, mode, sha256 } (L1124 m4).
export const META_SUFFIX = `${BACKUP_SUFFIX}.meta`;
// The model each run asks for unless the test is about --model: the cheapest, as the runs only follow one instruction.
export const RUN_MODEL = 'haiku';

/** Every name the launcher writes or reads, as settings-names.mjs lists them: the flags, settings, hook fields and events,
 * and the two variable names. One entry per spelling, in a fixed order. */
export function allNames() {
  return [...new Set([...Object.values(F), ...Object.values(S), ...Object.values(H), ...Object.values(E), ...Object.values(ENV)])];
}

// ---- the runs ----

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const bashOnce = (cmd) => `Use the Bash tool to run exactly this shell command, once, and nothing else: ${cmd}\nThen reply with the word done.`;

/**
 * One headless start's words. `o.settingsFile` is the --settings file; the rest say what differs from the plain run:
 * tools, mode (null: no --permission-mode), sources (false: no --setting-sources), mcp (false: no tool-server lock),
 * model (null: no --model, the account's own model, as a review start has), maxTurns, extra (words before the prompt).
 */
export function runArgs(o) {
  const a = [F.print, F.outputFormat, F.streamJson, F.verbose, F.settings, o.settingsFile];
  if (o.sources !== false) a.push(...sourcesArgs());
  if (o.mcp !== false) a.push(...noToolServerArgs());
  a.push(F.tools, o.tools ?? 'Bash');
  if (o.mode !== null) a.push(F.permissionMode, o.mode ?? 'dontAsk');
  if (o.model !== null) a.push(F.model, o.model ?? RUN_MODEL);
  a.push(F.maxTurns, String(o.maxTurns ?? 3), ...(o.extra ?? []), o.prompt ?? 'Reply with the word ready.');
  return a;
}

// A test: { id, title, names, kind ('break-it' | 'readback'), run(side, dir) → run options, see(side, dir, out) → what
// was seen, judge(on, off) → null when both sides show what they must, else why not }. `dir` is the run's own folder:
// dir/work is claude's working folder, dir/settings.json the --settings file, dir/out a folder outside the working one.
// `files(side, dir)` → { path: text } written before the run; `user(side, dir)` → the user settings for the run, or
// undefined to leave the file alone. `expect(side, dir)` → what a proper run of that side shows (runProblem): `tool` and
// `needle`, a call of that tool holding that text (`exact`: a command that is exactly it); `refused`, the kind of refusal
// of that call the side must show (REFUSAL); `turnsEnd`, the run ends on its turn limit; `startOrWarns`, no start is
// proper only if claude's warnings name that text. `repeatOn`: the on side runs twice, and counts only if both runs
// show the same. `see` also gets the run itself, { out, err, … }, as its fifth argument. A judge made by sameBut carries
// its `want`, so a marker on a side that wants none is a FAIL however that run ended (L1128 m1).
const mark = (dir, name = 'mark') => join(dir, 'work', name);
const there = (p) => existsSync(p);
const sameBut = (want) => Object.assign((on, off) => (on === want.on && off === want.off ? null : `the setting on gave ${JSON.stringify(on)}, off gave ${JSON.stringify(off)}; want ${JSON.stringify(want.on)} and ${JSON.stringify(want.off)}`), { want });
const ALLOW_TOUCH = (m) => [`Bash(touch ${m})`];
const touchIn = (dir, name = 'mark') => `touch ${mark(dir, name)}`;
const hook = (command, extra = {}) => ({ [H.type]: 'command', [H.command]: command, ...extra });
const markerHook = (event, file) => ({ [S.hooks]: { [event]: [{ [H.hooks]: [hook(`touch ${q(file)}`)] }] } });
const init = (out) => findInit(out);
const bashUse = (needle) => ({ tool: 'Bash', needle });
// A command that is exactly `cmd` (L1128 c1): 'true' or 'env' alone would match any call holding the word.
const bashExact = (cmd) => ({ tool: 'Bash', needle: cmd, exact: true });
const writeUse = (needle) => ({ tool: 'Write', needle });

// ---- what a proper run shows (audit L1124 m1) ----

const events = (out) => String(out ?? '').split('\n').map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? j : null; } catch { return null; } }).filter(Boolean);
const contentOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
/** The tool calls in a run's stream: [{ id, name, input }]. */
export const toolUses = (out) => events(out).filter((e) => e.type === 'assistant').flatMap(contentOf).filter((c) => c?.type === 'tool_use');
const toolResults = (out) => events(out).filter((e) => e.type === 'user').flatMap(contentOf).filter((c) => c?.type === 'tool_result');
/** What claude warned about: its stderr and its stream's system lines other than the start message (not the start
 * message itself, whose folder names the run). */
export const warningsOf = (r) => [String(r?.err ?? ''), ...events(r?.out).filter((e) => e.type === 'system' && e.subtype !== 'init').map((e) => JSON.stringify(e))].join('\n');
const usesFor = (out, want) => toolUses(out).filter((u) => (!want.tool || u.name === want.tool) &&
  (want.exact ? String(u.input?.command ?? '').trim() === want.needle : JSON.stringify(u.input ?? {}).includes(want.needle)));
/**
 * The refusals a side may be expected to show (L1128 m3), each read only for the asked-for call (its tool_use id):
 * permission, claude's permission check (the call is in the result's permission_denials, or its error result says it
 * was denied); sandbox, the OS refusing the command inside the sandbox; network, the sandbox's proxy refusing the host;
 * hook, a PreToolUse hook blocking the call. Any other error (a timeout, a missing file) is not the setting's.
 */
export const REFUSAL = Object.freeze({
  permission: { denials: true, text: /denied/i },
  sandbox: { text: /operation not permitted|permission denied/i },
  network: { text: /blocked|not allowed|forbidden|denied|\b403\b/i },
  hook: { text: /hook/i },
});
/** Whether claude refused the side's asked-for call the way `want.refused` names. */
export function refusalSeen(r, want = {}) {
  const kind = REFUSAL[want.refused];
  if (!kind) return false;
  const ids = new Set(usesFor(r?.out, want).map((u) => u.id));
  const res = events(r?.out).filter((e) => e.type === 'result').at(-1);
  const denied = (res?.permission_denials ?? []).some((d) => ids.has(d?.tool_use_id));
  if (kind.denials && denied) return true;
  if (!kind.denials && denied) return false;
  return toolResults(r?.out).some((t) => ids.has(t.tool_use_id) && t.is_error === true && kind.text.test(JSON.stringify(t.content ?? '')));
}
/** Why a side's run shows nothing about the name, or null when it ran properly. `r` is { out, err, code, signal,
 * timedOut, error }. */
export function runProblem(r, want = {}) {
  if (!r || typeof r !== 'object') return 'the run gave nothing back';
  if (r.timedOut) return 'it ran past its time limit';
  if (r.error) return `it could not start (${r.error})`;
  const said = String(r.err ?? '').trim().slice(0, 200);
  if (findInit(r.out) === null) {
    if (want.startOrWarns && warningsOf(r).includes(want.startOrWarns)) return null;
    return `no start message${said ? ` (it said: ${said})` : ''}`;
  }
  const res = events(r.out).filter((e) => e.type === 'result').at(-1);
  if (!res) return `no result line${said ? ` (it said: ${said})` : ''}`;
  if (want.turnsEnd) { if (res.subtype !== 'error_max_turns') return `it did not end on its turn limit (result ${JSON.stringify(res.subtype ?? null)})`; }
  // One reading of a result (L1128 m2): the dispatcher's readResult, success and not is_error; and no "API Error".
  else if (readResult(JSON.stringify(res)).outcome !== 'success' || /^API Error/i.test(String(res.result ?? ''))) return `its result is not a success (${JSON.stringify(res.subtype ?? null)}): ${String(res.result ?? '').slice(0, 200)}`;
  if (want.needle && !usesFor(r.out, want).length) return `no ${want.tool ?? 'tool'} call holding ${want.needle}`;
  return null;
}

const PROBE_SERVER = 'orch-names-probe';
export const CONNECTORS_FALLBACK = 'the account has no claude.ai connector, so the pair can\'t show it. Fallback (b), L1114: '
  + 'take it out of the role files; --strict-mcp-config with an empty list keeps connectors out, and launch check 6 refuses a '
  + 'start whose start message lists any tool server';
/** The name with two letters near its end swapped: a spelling the CLI can't know, holding none of the real one. */
export const misspell = (n) => `${n.slice(0, -3)}${n.at(-2)}${n.at(-3)}${n.at(-1)}`;
export const SPELLING_LABEL = 'name confirmed (spelling pair)';
const SPELLING_CONTROL = 'loaded|-';
/**
 * A spelling pair (L1114): the same wrong-typed value under the name (on) and under a misspelling (off, the control), in
 * a --settings file that also holds a SessionStart marker hook. Each side shows `loaded` or `skipped` (whether the
 * marker hook ran, so whether the file was read) and `named` or `-` (whether claude's warnings, its stderr and its
 * non-start system lines, name the key). The control must be the normal run, `loaded|-`: claude passes an unknown key
 * by. The pair proves the CLI reads the name only on positive evidence from the name's side (L1128 m4): the key named,
 * or the file skipped on both of its two runs (repeatOn), as one run's marker could be missing by chance. The same as
 * the control, two runs that disagree, or a control that was not normal, leave the name NOT TRIED (L1124 m2).
 */
function spelling(name, place) {
  return { id: `spelling-${name}`, title: `${name}: a bad value under its name changes the run; under a misspelling it does not`, kind: 'spelling', names: [name], repeatOn: true,
    run: (side, dir) => ({ settings: { ...place(side === 'on' ? name : misspell(name), 'sometimes-7c'), ...markerHook(E.sessionStart, mark(dir, 'start')) } }),
    expect: (side) => (side === 'on' ? { startOrWarns: name } : {}),
    see: (side, dir, out, x, r) => `${there(mark(dir, 'start')) ? 'loaded' : 'skipped'}|${warningsOf(r).includes(name) ? 'named' : '-'}`,
    judge: (on, off) => (off !== SPELLING_CONTROL ? { notTried: `the control (the misspelt key) did not run normally (${off}; want ${SPELLING_CONTROL}), so the pair shows nothing` }
      : on === off ? { notTried: `the spelling pair showed no difference (${on} both ways), so the name is not proven` }
        : /^(loaded|skipped)\|named$/.test(on) || on === 'skipped|-' ? null
          : { notTried: `the name's side showed ${on}, not the same on both of its runs, so the pair shows nothing` }) };
}

// --effort (L1114, L1124 m7, L1128): a value pair for each level a review launch passes, on the model a review start
// uses (no --model). 2.1.316 does not refuse a level it doesn't know: it starts, warning "Unknown --effort value '<v>'
// — ignoring it and using the default effort" (its own words, read in its code). So both sides must start, and only the
// made-up level's side may carry that warning, naming it. That proves the flag and the level are read (an unknown flag
// would be refused both ways; a level ignored would warn on its side too), not the review depth.
export const BAD_EFFORT = 'not-a-level-7c';
export const effortWarning = (v) => `Unknown --effort value '${v}'`;
const effortTest = (level) => ({ id: `effort-${level}`, title: `--effort ${level} is taken with no warning, and a made-up level is named in claude's warning`, kind: 'readback', names: [F.effort],
  run: (side) => ({ model: null, extra: [F.effort, side === 'on' ? level : BAD_EFFORT] }),
  see: (side, dir, out, x, r) => `${init(out) !== null ? 'start' : '-'}|${warningsOf(r).includes(effortWarning(side === 'on' ? level : BAD_EFFORT)) ? 'warned' : '-'}`,
  judge: sameBut({ on: 'start|-', off: 'start|warned' }) });

export const TESTS = Object.freeze([
  // permissions: the mode leaves a command alone unless a rule lets it run.
  { id: 'allow', title: 'an allow rule lets a command run that the mode refuses', kind: 'break-it', names: [S.permissions, S.allow, F.permissionMode],
    run: (side, dir) => ({ settings: side === 'on' ? { [S.permissions]: { [S.allow]: ALLOW_TOUCH(mark(dir)) } } : {}, prompt: bashOnce(touchIn(dir)) }),
    expect: (side, dir) => ({ ...bashUse(mark(dir)), refused: side === 'off' && 'permission' }),
    see: (side, dir) => there(mark(dir)), judge: sameBut({ on: true, off: false }) },
  { id: 'deny', title: 'a deny rule refuses a command an allow rule lets run', kind: 'break-it', names: [S.permissions, S.deny],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ALLOW_TOUCH(mark(dir)), ...(side === 'on' ? { [S.deny]: ALLOW_TOUCH(mark(dir)) } : {}) } }, prompt: bashOnce(touchIn(dir)) }),
    expect: (side, dir) => ({ ...bashUse(mark(dir)), refused: side === 'on' && 'permission' }),
    see: (side, dir) => there(mark(dir)), judge: sameBut({ on: false, off: true }) },
  { id: 'ask', title: 'an ask rule, with no one to ask, refuses a command an allow rule lets run', kind: 'break-it', names: [S.ask],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ALLOW_TOUCH(mark(dir)), ...(side === 'on' ? { [S.ask]: ALLOW_TOUCH(mark(dir)) } : {}) } }, prompt: bashOnce(touchIn(dir)) }),
    expect: (side, dir) => ({ ...bashUse(mark(dir)), refused: side === 'on' && 'permission' }),
    see: (side, dir) => there(mark(dir)), judge: sameBut({ on: false, off: true }) },
  { id: 'defaultMode', title: 'the settings\' mode, with no --permission-mode, decides a file write', kind: 'break-it', names: [S.defaultMode],
    run: (side, dir) => ({ mode: null, tools: 'Write', settings: { [S.permissions]: { [S.defaultMode]: side === 'on' ? 'dontAsk' : 'acceptEdits' } },
      prompt: `Use the Write tool, once, to write the word x to the file ${mark(dir)}. Then reply with the word done.` }),
    expect: (side, dir) => ({ ...writeUse(mark(dir)), refused: side === 'on' && 'permission' }),
    see: (side, dir) => there(mark(dir)), judge: sameBut({ on: false, off: true }) },
  { id: 'additionalDirectories', title: 'an added folder lets a file write outside the working folder', kind: 'break-it', names: [S.additionalDirectories],
    run: (side, dir) => ({ mode: 'acceptEdits', tools: 'Write', settings: { [S.permissions]: side === 'on' ? { [S.additionalDirectories]: [join(dir, 'out')] } : {} },
      prompt: `Use the Write tool, once, to write the word x to the file ${join(dir, 'out', 'mark')}. Then reply with the word done.` }),
    expect: (side, dir) => ({ ...writeUse(join(dir, 'out', 'mark')), refused: side === 'off' && 'permission' }),
    see: (side, dir) => there(join(dir, 'out', 'mark')), judge: sameBut({ on: true, off: false }) },
  // sandbox: a command inside it, with a rule letting the command run.
  { id: 'sandbox', title: 'the sandbox refuses a write outside the working folder', kind: 'break-it', names: [S.sandbox, S.sandboxEnabled],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ALLOW_TOUCH(join(dir, 'out', 'mark')) }, [S.sandbox]: { [S.sandboxEnabled]: side === 'on', [S.allowUnsandboxedCommands]: false } },
      prompt: bashOnce(`touch ${join(dir, 'out', 'mark')}`) }),
    expect: (side, dir) => ({ ...bashUse(join(dir, 'out', 'mark')), refused: side === 'on' && 'sandbox' }),
    see: (side, dir) => there(join(dir, 'out', 'mark')), judge: sameBut({ on: false, off: true }) },
  { id: 'denyWrite', title: 'a denyWrite folder is refused inside the working folder', kind: 'break-it', names: [S.filesystem, S.denyWrite],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ALLOW_TOUCH(mark(dir, 'sub/mark')) },
      [S.sandbox]: { [S.sandboxEnabled]: true, [S.allowUnsandboxedCommands]: false, ...(side === 'on' ? { [S.filesystem]: { [S.denyWrite]: [join(dir, 'work', 'sub')] } } : {}) } },
    prompt: bashOnce(touchIn(dir, 'sub/mark')) }),
    files: (side, dir) => ({ [join(dir, 'work', 'sub', '.keep')]: '' }),
    expect: (side, dir) => ({ ...bashUse(mark(dir, 'sub/mark')), refused: side === 'on' && 'sandbox' }),
    see: (side, dir) => there(mark(dir, 'sub/mark')), judge: sameBut({ on: false, off: true }) },
  { id: 'denyRead', title: 'a denyRead file can\'t be read by a command', kind: 'break-it', names: [S.filesystem, S.denyRead],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: [`Bash(cat ${join(dir, 'out', 'secret')})`] },
      [S.sandbox]: { [S.sandboxEnabled]: true, [S.allowUnsandboxedCommands]: false, ...(side === 'on' ? { [S.filesystem]: { [S.denyRead]: [join(dir, 'out', 'secret')] } } : {}) } },
    prompt: `Use the Bash tool to run exactly this shell command, once, and nothing else: cat ${join(dir, 'out', 'secret')}\nThen reply with exactly what it printed, or the word nothing.` }),
    files: (side, dir) => ({ [join(dir, 'out', 'secret')]: `seen-${side}-7c1f\n` }),
    expect: (side, dir) => ({ ...bashUse(join(dir, 'out', 'secret')), refused: side === 'on' && 'sandbox' }),
    see: (side, dir, out) => String(out).includes(`seen-${side}-7c1f`), judge: sameBut({ on: false, off: true }) },
  { id: 'allowedDomains', title: 'an allowed host is reached from inside the sandbox, and only then', kind: 'break-it', names: [S.network, S.allowedDomains],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: [`Bash(curl -sS -o ${join(dir, 'work', 'got')} https://example.com)`] },
      [S.sandbox]: { [S.sandboxEnabled]: true, [S.allowUnsandboxedCommands]: false, [S.network]: { [S.allowedDomains]: side === 'on' ? ['example.com'] : [] } } },
    prompt: bashOnce(`curl -sS -o ${join(dir, 'work', 'got')} https://example.com`) }),
    expect: (side) => ({ ...bashUse('https://example.com'), refused: side === 'off' && 'network' }),
    see: (side, dir) => there(join(dir, 'work', 'got')), judge: sameBut({ on: true, off: false }) },
  { id: 'excludedCommands', title: 'an excluded command runs outside the sandbox (the launcher refuses the setting; proven for its name)', kind: 'break-it', names: [S.excludedCommands],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ALLOW_TOUCH(join(dir, 'out', 'mark')) },
      [S.sandbox]: { [S.sandboxEnabled]: true, ...(side === 'on' ? { [S.excludedCommands]: ['touch'] } : {}) } }, prompt: bashOnce(`touch ${join(dir, 'out', 'mark')}`) }),
    expect: (side, dir) => ({ ...bashUse(join(dir, 'out', 'mark')), refused: side === 'off' && 'sandbox' }),
    see: (side, dir) => there(join(dir, 'out', 'mark')), judge: sameBut({ on: true, off: false }) },
  // hooks
  { id: 'preToolUse', title: 'a PreToolUse hook with a Bash matcher runs before the command', kind: 'break-it', names: [S.hooks, E.preToolUse, H.matcher, H.hooks, H.type, H.command],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ['Bash(true)'] },
      ...(side === 'on' ? { [S.hooks]: { [E.preToolUse]: [{ [H.matcher]: 'Bash', [H.hooks]: [hook(`touch ${q(mark(dir, 'hook'))}`)] }] } } : {}) }, prompt: bashOnce('true') }),
    expect: () => bashExact('true'),
    see: (side, dir) => there(mark(dir, 'hook')), judge: sameBut({ on: true, off: false }) },
  { id: 'timeout', title: 'a hook past its timeout is stopped before it writes', kind: 'break-it', names: [H.timeout],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ['Bash(true)'] },
      [S.hooks]: { [E.preToolUse]: [{ [H.matcher]: 'Bash', [H.hooks]: [hook(`sleep 4; touch ${q(join(dir, 'out', 'late'))}`, { [H.timeout]: side === 'on' ? 1 : 30 })] }] } }, prompt: bashOnce('true') }),
    // The stopped hook would have written 4 s in; the run is read once claude has ended, and a short wait covers a hook
    // left running.
    settle: 6_000,
    expect: () => bashExact('true'),
    see: (side, dir) => there(join(dir, 'out', 'late')), judge: sameBut({ on: false, off: true }) },
  { id: 'onFailure', title: 'a failing hook with onFailure block stops the command; with continue it runs', kind: 'break-it', names: [H.onFailure],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ALLOW_TOUCH(mark(dir)) },
      [S.hooks]: { [E.preToolUse]: [{ [H.matcher]: 'Bash', [H.hooks]: [hook('exit 1', { [H.onFailure]: side === 'on' ? 'block' : 'continue' })] }] } }, prompt: bashOnce(touchIn(dir)) }),
    expect: (side, dir) => ({ ...bashUse(mark(dir)), refused: side === 'on' && 'hook' }),
    see: (side, dir) => there(mark(dir)), judge: sameBut({ on: false, off: true }) },
  { id: 'sessionStart', title: 'a SessionStart hook in the --settings file runs at the start', kind: 'break-it', names: [E.sessionStart, F.settings],
    run: (side, dir) => ({ settings: side === 'on' ? markerHook(E.sessionStart, mark(dir, 'start')) : {} }),
    see: (side, dir) => there(mark(dir, 'start')), judge: sameBut({ on: true, off: false }) },
  { id: 'compact', title: 'PreCompact and PostCompact hooks run around a /compact', kind: 'break-it', names: [E.preCompact, E.postCompact],
    run: (side, dir) => ({ maxTurns: 2, prompt: '/compact',
      settings: side === 'on' ? { [S.hooks]: { [E.preCompact]: [{ [H.hooks]: [hook(`touch ${q(mark(dir, 'pre'))}`)] }], [E.postCompact]: [{ [H.hooks]: [hook(`touch ${q(mark(dir, 'post'))}`)] }] } } : {} }),
    see: (side, dir) => `${there(mark(dir, 'pre')) ? 'pre' : '-'}/${there(mark(dir, 'post')) ? 'post' : '-'}`, judge: sameBut({ on: 'pre/post', off: '-/-' }) },
  // the variables, seen inside a Bash call
  { id: 'env', title: 'the settings\' variables are set inside a Bash call', kind: 'break-it', names: [S.env, ENV.autoCompactWindow, ENV.disableUpdates],
    run: (side, dir) => ({ settings: { [S.permissions]: { [S.allow]: ['Bash(env)'] }, ...(side === 'on' ? { [S.env]: { ORCH_PROOF_VAR: 'on-5a1', [ENV.autoCompactWindow]: '190001', [ENV.disableUpdates]: '1' } } : {}) },
      prompt: 'Use the Bash tool to run exactly this shell command, once, and nothing else: env\nThen reply with each line it printed that begins with ORCH_PROOF_VAR=, CLAUDE_CODE_AUTO_COMPACT_WINDOW= or DISABLE_UPDATES=, exactly, or the word none.' }),
    expect: () => bashExact('env'),
    see: (side, dir, out) => ['ORCH_PROOF_VAR=on-5a1', `${ENV.autoCompactWindow}=190001`, `${ENV.disableUpdates}=1`].map((x) => (String(out).includes(x) ? 1 : 0)).join(''),
    judge: sameBut({ on: '111', off: '000' }) },
  // the rest of the settings
  { id: 'disableSkillShellExecution', title: 'a skill\'s inline shell does not run when it is off', kind: 'break-it', names: [S.disableSkillShellExecution],
    run: (side, dir) => ({ settings: side === 'on' ? { [S.disableSkillShellExecution]: true } : {}, prompt: '/proof-probe', tools: 'Skill', maxTurns: 1 }),
    files: (side, dir) => ({ [join(dir, 'work', '.claude', 'skills', 'proof-probe', 'SKILL.md')]: `---\nname: proof-probe\ndescription: a probe\n---\n!\`touch ${mark(dir, 'skill')}\`\nReply with the word done.\n` }),
    see: (side, dir) => there(mark(dir, 'skill')), judge: sameBut({ on: false, off: true }) },
  { id: 'disableBundledSkills', title: 'the start message lists fewer skills with the bundled ones off', kind: 'readback', names: [S.disableBundledSkills],
    run: (side) => ({ settings: { [S.disableBundledSkills]: side === 'on' } }),
    see: (side, dir, out) => { const i = init(out); return Array.isArray(i?.skills) ? i.skills.length : null; },
    judge: (on, off) => (Number.isInteger(on) && Number.isInteger(off) && on < off ? null : `skills listed: ${on} with it on, ${off} with it off; want fewer with it on`) },
  { id: 'disableClaudeAiConnectors', title: 'no claude.ai connector is in the start message with them off (no tool-server lock)', kind: 'readback', names: [S.disableClaudeAiConnectors],
    run: (side) => ({ mcp: false, settings: side === 'on' ? { [S.disableClaudeAiConnectors]: true } : {} }),
    see: (side, dir, out) => { const i = init(out); return Array.isArray(i?.mcp_servers) ? i.mcp_servers.filter((s) => /^claude\.ai\b/i.test(String(s?.name ?? ''))).length : null; },
    // An account with no connector can't show it (L1114): NOT TRIED, with the fallback, (b), in the receipt.
    judge: (on, off) => (off === 0 ? { notTried: CONNECTORS_FALLBACK, fallback: 'b' }
      : on === 0 && Number.isInteger(off) && off > 0 ? null : `claude.ai connectors listed: ${on} with them off, ${off} without; want none and some`) },
  { id: 'mcpConfig', title: 'a tool server given by --mcp-config is in the start message; with none given, it is not', kind: 'readback', names: [F.mcpConfig],
    run: (side) => ({ mcp: false, extra: [F.strictMcpConfig, F.mcpConfig, JSON.stringify({ mcpServers: side === 'on' ? { [PROBE_SERVER]: { command: '/usr/bin/true' } } : {} })] }),
    see: (side, dir, out) => { const i = init(out); return Array.isArray(i?.mcp_servers) ? i.mcp_servers.some((s) => s?.name === PROBE_SERVER) : null; },
    judge: sameBut({ on: true, off: false }) },
  { id: 'strictMcp', title: 'with the tool-server lock, a project\'s own tool server is not in the start message; without it, it is', kind: 'readback', names: [F.strictMcpConfig],
    // Both sides without the sources limit (L1124 m6), so the project's server can load: the lock is the one difference.
    run: (side) => ({ mcp: false, sources: false, settings: { enableAllProjectMcpServers: true }, extra: [...(side === 'on' ? [F.strictMcpConfig] : []), F.mcpConfig, '{"mcpServers":{}}'] }),
    files: (side, dir) => ({ [join(dir, 'work', '.mcp.json')]: JSON.stringify({ mcpServers: { [PROBE_SERVER]: { command: '/usr/bin/true' } } }) }),
    see: (side, dir, out) => { const i = init(out); return Array.isArray(i?.mcp_servers) ? i.mcp_servers.some((s) => s?.name === PROBE_SERVER) : null; },
    // If the project's server reaches neither run, the lock had nothing to hold out: NOT TRIED, never PASS.
    judge: (on, off) => (on === false && off === false ? { notTried: 'the project\'s tool server reached neither run, so the lock had nothing to hold out' }
      : sameBut({ on: false, off: true })(on, off)) },
  // flags
  { id: 'settingSources', title: 'with --setting-sources "", no user, project or local settings file loads; without it, each does', kind: 'break-it', names: [F.settingSources],
    run: (side) => ({ sources: side === 'on' }),
    files: (side, dir) => ({ [join(dir, 'work', '.claude', 'settings.json')]: JSON.stringify(markerHook(E.sessionStart, mark(dir, 'project'))),
      [join(dir, 'work', '.claude', 'settings.local.json')]: JSON.stringify(markerHook(E.sessionStart, mark(dir, 'local'))) }),
    user: (side, dir) => markerHook(E.sessionStart, mark(dir, 'user')),
    see: (side, dir) => ['user', 'project', 'local'].map((n) => (there(mark(dir, n)) ? n : '-')).join(','),
    judge: sameBut({ on: '-,-,-', off: 'user,project,local' }) },
  { id: 'restricted', title: '--restricted loads no project settings file either', kind: 'break-it', names: [F.restricted],
    run: (side) => ({ sources: false, extra: side === 'on' ? [F.restricted] : [] }),
    files: (side, dir) => ({ [join(dir, 'work', '.claude', 'settings.json')]: JSON.stringify(markerHook(E.sessionStart, mark(dir, 'project'))) }),
    see: (side, dir) => there(mark(dir, 'project')), judge: sameBut({ on: false, off: true }) },
  { id: 'model', title: 'the start message names the model asked for', kind: 'readback', names: [F.model],
    run: (side) => ({ model: side === 'on' ? 'haiku' : 'sonnet' }),
    see: (side, dir, out) => String(init(out)?.model ?? ''),
    judge: (on, off) => (/haiku/i.test(on) && /sonnet/i.test(off) ? null : `the model was ${JSON.stringify(on)} for haiku and ${JSON.stringify(off)} for sonnet`) },
  { id: 'sessionId', title: 'the start message carries the session id given', kind: 'readback', names: [F.sessionId],
    run: (side, dir, x) => ({ extra: side === 'on' ? [F.sessionId, x.sessionId] : [] }),
    see: (side, dir, out, x) => String(init(out)?.session_id ?? '') === x.sessionId,
    judge: sameBut({ on: true, off: false }) },
  // --version: the guard runs `claude --version` before anything else and refuses unless it prints the pin, so a run
  // that gets this far has proven it (no pair: the guard's own read is the proof).
  { id: 'version', title: 'claude --version printed the pin before the run', kind: 'readback', names: [F.version], byGuard: true },
  ...[...new Set([FIRST_ROUND_EFFORT, SEND_BACK_EFFORT])].map(effortTest),
  // Spelling pairs (L1114): the name confirmed, never its behaviour (R-0b-178).
  spelling(S.failIfUnavailable, (k, v) => ({ [S.sandbox]: { [k]: v } })),
  spelling(S.strictAllowlist, (k, v) => ({ [S.sandbox]: { [S.network]: { [k]: v } } })),
  spelling(S.crossSessionInbound, (k, v) => ({ [k]: v })),
  { id: 'maxTurns', title: '--max-turns 1 stops before a second command; 4 lets it run', kind: 'break-it', names: [F.maxTurns],
    run: (side, dir) => ({ maxTurns: side === 'on' ? 1 : 4, settings: { [S.permissions]: { [S.allow]: [...ALLOW_TOUCH(mark(dir, 'a')), ...ALLOW_TOUCH(mark(dir, 'b'))] } },
      prompt: `Use the Bash tool to run ${touchIn(dir, 'a')}. After it has finished, use the Bash tool again, in a separate call, to run ${touchIn(dir, 'b')}. Then reply with the word done.` }),
    expect: (side, dir) => ({ ...bashUse(mark(dir, 'a')), turnsEnd: side === 'on' }),
    see: (side, dir) => there(mark(dir, 'b')), judge: sameBut({ on: false, off: true }) },
]);

// Names with no live test yet, and why (L1109: left failing check 0, never assumed).
export const NOT_TRIED = Object.freeze({
  [S.allowUnsandboxedCommands]: 'no pair here: a command asking to leave the sandbox is a model\'s choice (its break-it test is the review walls proof)',
});

// Names the launcher no longer writes (L1114), shown and not counted. Each comes back only after its proof (R-0b-178).
export const NOT_USED = Object.freeze({
  [S.enabledPlugins]: 'not in the role files (L1114): nothing to turn on; check 6 refuses a start listing a plugin; its proof is R-0b-178',
});

// The role read-back's names: what launch check 6 itself reads (L6): the start message comes at all, and shows each role's
// tools, no tool server, no plugin, its skills and its mode.
export const READBACK_NAMES = Object.freeze([F.print, F.outputFormat, F.streamJson, F.verbose, F.tools, F.permissionMode]);

// ---- judging ----

const pass = (name, by, version) => ({ name, result: 'PASS', by, version });
const failN = (name, why) => ({ name, result: 'FAIL', why });
const notTried = (name, why) => ({ name, result: 'NOT TRIED', why });

/**
 * One line per name, from the tests' outcomes: { [test id]: { ok, why } } (a test not in it did not run) and the role
 * read-back's { ok, why } (or undefined). A name is PASS when at least one test proving it passed and none failed; FAIL
 * when one failed; NOT TRIED when none ran. `version` is the pin the runs used; `confirmed` the table already on main.
 */
export function judgeNames({ outcomes, readback, version, confirmed = CONFIRMED, tests = TESTS }) {
  const out = [];
  for (const name of allNames()) {
    if (REFUSED_SETTINGS.includes(name)) { out.push({ name, result: 'REFUSED', why: 'not proven: the launcher refuses it in every role file (REFUSED_SETTINGS)' }); continue; }
    if (Object.hasOwn(NOT_USED, name)) { out.push({ name, result: 'NOT USED', why: NOT_USED[name] }); continue; }
    const by = []; const bad = []; const open = []; const missing = []; let ran = false; let spelt = false; let fallback;
    for (const t of tests.filter((x) => x.names.includes(name))) {
      const o = outcomes?.[t.id];
      // Every test of a name must pass (L1128 M1): one that did not run, or could not show it, leaves the name open.
      if (!o) { missing.push(`"${t.title}" did not run`); continue; }
      // A pair that could not show the name (L1114) is as if not run, with its reason.
      if (o.ok === null && typeof o.notTried === 'string') { open.push(o.notTried); fallback ??= o.fallback; continue; }
      // A spelling pair confirms only the names the lead ruled it may (SPELLING_ONLY, L1124 m3).
      if (o.ok === true && t.kind === 'spelling' && !SPELLING_ONLY.includes(name)) { open.push(`"${t.title}" is a spelling pair, which can't confirm ${name} (SPELLING_ONLY)`); continue; }
      ran = true;
      if (o.ok === true) { by.push(`${t.kind}:${PROOF} "${t.title}"`); spelt ||= t.kind === 'spelling'; } else bad.push(`"${t.title}": ${o.why ?? 'no answer'}`);
    }
    if (READBACK_NAMES.includes(name) && readback) {
      ran = true;
      if (readback.ok === true) by.push(`readback:${PROOF} "role read-back"`); else bad.push(`the role read-back: ${readback.why ?? 'no answer'}`);
    }
    const c = Object.hasOwn(confirmed, name) ? confirmed[name] : null;
    if (bad.length) out.push(failN(name, bad.join('; ')));
    else if (by.length && !open.length && !missing.length) out.push({ ...pass(name, by[0], version), ...(spelt && by.every((b) => b.startsWith('spelling:')) ? { proof: SPELLING_LABEL } : {}) });
    else if (!ran && !open.length && c && c.version === version && proofCounts(name, c.by)) out.push({ ...pass(name, c.by, version), already: true });
    // (A name no test of this run touched may stand on its confirmed proof above; one only partly run may not.)
    else out.push({ ...notTried(name, open.length || (ran && missing.length) ? [...open, ...missing].join('; ') : ran ? 'no test that ran proves it' : NOT_TRIED[name] ?? 'no test ran it'), ...(fallback ? { fallback } : {}) });
  }
  return out;
}

const LABEL = { PASS: 'PASS     ', FAIL: 'FAIL     ', 'NOT TRIED': 'NOT TRIED', REFUSED: 'REFUSED  ', 'NOT USED': 'NOT USED ' };
const UNCOUNTED = ['REFUSED', 'NOT USED'];
/** The printed report: one line per name, then the verdict line, which is last. → { ok, text, lines } */
export function report(lines, version) {
  const counted = lines.filter((l) => !UNCOUNTED.includes(l.result));
  const failed = counted.filter((l) => l.result === 'FAIL').map((l) => l.name);
  const tried = counted.filter((l) => l.result === 'NOT TRIED').map((l) => l.name);
  const ok = counted.length > 0 && failed.length === 0 && tried.length === 0;
  const body = lines.map((l) => `${LABEL[l.result]} ${l.name}${l.result === 'PASS' ? `  ${l.already ? 'already confirmed: ' : ''}${l.proof ? `${l.proof}: ` : ''}${l.by}` : `  ${l.why}`}`);
  const verdict = ok ? `PASS: all ${counted.length} names confirmed on Claude Code ${version}`
    : `NOT DONE on Claude Code ${version ?? '(no version)'}: ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}, ${tried.length} not tried${tried.length ? ` (${tried.join(', ')})` : ''}`;
  return { ok, verdict, text: `${body.join('\n')}\n` };
}

// ---- the user settings file (L1109) ----

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** Whether a backup from an earlier run is beside `file`. */
export const backupLeft = (file, fs = realFs) => fs.exists(`${file}${BACKUP_SUFFIX}`) || fs.exists(`${file}${META_SUFFIX}`);
export const LEFTOVER = 'is left from an earlier run that was cut off. Run the same command again with --restore added: it puts the file back from the backup (or removes it, if there was none) and checks it';

/**
 * Puts `settings` in the account's user settings file for the length of `fn`, then puts the file back byte for byte (its
 * mode too), or removes it when it was not there. First the file's own bytes go beside it (BACKUP_SUFFIX), then a note
 * of { had, mode, sha256 } (META_SUFFIX); only then does the file change. A run cut off leaves both, for --restore
 * (restoreUserFile); while either is there, nothing runs. `fs` is for tests.
 */
export async function withUserSettings(file, settings, fn, fs = realFs) {
  if (backupLeft(file, fs)) throw new Error(`${file}${BACKUP_SUFFIX} ${LEFTOVER}`);
  const had = fs.exists(file);
  const before = had ? fs.read(file) : null;
  const mode = had ? fs.mode(file) : null;
  if (had) fs.put(`${file}${BACKUP_SUFFIX}`, before, 0o600);
  fs.put(`${file}${META_SUFFIX}`, JSON.stringify({ had, mode, sha256: had ? sha256(before) : null }), 0o600);
  try {
    fs.put(file, `${JSON.stringify(settings)}\n`, mode ?? 0o600);
    return await fn();
  } finally {
    restoreUserFile(file, fs);
  }
}

/**
 * Puts the user settings file back from its backup: the bytes and the mode it had, or no file if it had none; checks
 * both; then removes the backup and its note. With no note, the file was never changed, and a backup alone is removed.
 * Throws, keeping the backup, when it can't. → what it did.
 */
export function restoreUserFile(file, fs = realFs) {
  const backup = `${file}${BACKUP_SUFFIX}`; const meta = `${file}${META_SUFFIX}`;
  if (!fs.exists(meta)) {
    if (!fs.exists(backup)) return 'nothing to put back';
    fs.rm(backup); return `${file} was not changed (the run stopped before it changed it); the backup is removed`;
  }
  let m; try { m = JSON.parse(String(fs.read(meta))); } catch { throw new Error(`${meta} can't be read; ${backup} holds the file's bytes, to put back by hand`); }
  let b = null;
  if (m?.had === true) {
    if (!fs.exists(backup)) throw new Error(`${meta} says ${file} was there, but ${backup} is gone; put the file back by hand`);
    b = fs.read(backup);
    if (sha256(b) !== m.sha256) throw new Error(`${backup} is not the file it backed up (its checksum differs); put the file back by hand`);
    fs.put(file, b, m.mode);
  } else fs.rm(file);
  const now = fs.exists(file) ? fs.read(file) : null;
  const same = m?.had === true ? now !== null && Buffer.compare(now, b) === 0 && fs.mode(file) === m.mode : now === null;
  if (!same) throw new Error(`${file} could not be put back as it was (its bytes or its mode); ${backup} holds it`);
  fs.rm(backup); fs.rm(meta);
  return m?.had === true ? `${file} is back as it was, mode ${(m.mode ?? 0).toString(8)}` : `${file} is removed, as it was not there before`;
}

const realFs = {
  exists: (p) => { try { lstatSync(p); return true; } catch { return false; } },
  read: (p) => readFileSync(p),
  mode: (p) => statSync(p).mode & 0o777,
  put: (p, data, mode) => {
    const fd = openSync(p, 'w', mode ?? 0o600);
    try { writeSync(fd, typeof data === 'string' ? data : Buffer.from(data)); fsyncSync(fd); } finally { closeSync(fd); }
    if (mode !== undefined && mode !== null) chmodSync(p, mode);
  },
  rm: (p) => rmSync(p, { force: true }),
};

// ---- running ----

/**
 * Runs every test, each side in a folder of its own under `base`, then the role read-back. `io.claude(args, { cwd })`
 * runs the pinned claude to its end → { out, err, code, signal, timedOut, error } (its stdout stream, its stderr, how it
 * ended); `io.readbackAll()` → { ok, why };
 * `io.userFile` is the user settings file; `io.fs` writes files. → { outcomes, readback }
 */
export async function runAll({ base, io, tests = TESTS }) {
  const outcomes = {};
  for (const [i, t] of tests.entries()) {
    if (t.byGuard) { if (io.guardPassed === true) outcomes[t.id] = { ok: true }; continue; }
    const seen = {}; const sick = []; const quiet = [];
    try {
      const runSide = async (side, k) => {
        // A neutral folder name (L1124 m2): the start message shows the folder, and it must not hold a name.
        const d = mkdtempSync(join(base, `run${i}-${side}-${k}-`));
        const x = { sessionId: randomUUID() };
        mkdirSync(join(d, 'work'), { recursive: true }); mkdirSync(join(d, 'out'), { recursive: true });
        for (const [p, text] of Object.entries(t.files?.(side, d) ?? {})) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
        const o = t.run(side, d, x);
        const settingsFile = join(d, 'settings.json');
        writeFileSync(settingsFile, `${JSON.stringify(o.settings ?? {})}\n`);
        const args = runArgs({ ...o, settingsFile });
        const go = () => io.claude(args, { cwd: join(d, 'work') });
        const user = t.user?.(side, d);
        const r = user === undefined ? await go() : await withUserSettings(io.userFile, user, go, io.fs);
        if (t.settle) await io.sleep(t.settle);
        const want = t.expect?.(side, d) ?? {};
        const problem = runProblem(r, want);
        if (problem) sick.push(`the ${side} side: ${problem}`);
        else if (want.refused && !refusalSeen(r, want)) quiet.push(side);
        return t.see(side, d, r?.out ?? '', x, r);
      };
      for (const side of ['on', 'off']) {
        const vals = [];
        for (let k = 1; k <= (side === 'on' && t.repeatOn ? 2 : 1); k += 1) vals.push(await runSide(side, k));
        seen[side] = vals.every((v) => v === vals[0]) ? vals[0] : vals.join(' then ');
      }
      const why = t.judge(seen.on, seen.off);
      // A marker on a side that must have none is the setting failing, however that run ended (L1128 m1).
      const breach = ['on', 'off'].filter((sd) => t.judge.want?.[sd] === false && seen[sd] === true);
      // A side that did not run properly shows nothing about the name (L1124 m1): NOT TRIED, whatever the judge says.
      outcomes[t.id] = breach.length ? { ok: false, why: `the ${breach.join(' and ')} side shows what the setting must stop, so it does not hold: ${why}${sick.length ? ` (and ${sick.join('; ')})` : ''}`, seen }
        : sick.length ? { ok: null, notTried: `a run did not go properly, so the pair shows nothing: ${sick.join('; ')}`, seen }
        : why && typeof why === 'object' ? { ok: null, notTried: why.notTried, ...(why.fallback ? { fallback: why.fallback } : {}), seen }
          : why ? { ok: false, why, seen }
            : quiet.length ? { ok: null, notTried: `the ${quiet.join(' and ')} side ran the call with no refusal from claude (no error or denial for it), so its missing result is not the setting's`, seen }
              : { ok: true, seen };
    } catch (e) {
      outcomes[t.id] = { ok: false, why: `the test could not run: ${e?.message ?? e}` };
    }
  }
  let readback;
  try { readback = await io.readbackAll(); } catch (e) { readback = { ok: false, why: `the read-back could not run: ${e?.message ?? e}` }; }
  return { outcomes, readback };
}

/** The roles' read-back (L6): each role's file rendered as the launcher renders it, started by roleArgs, its start
 * message read by checkInit on the pin. `start(args, cwd)` → the stream text. → { ok, why } */
export async function roleReadback({ base, pin, start, roles = Object.keys(DESIGN_PROFILES) }) {
  const bad = [];
  for (const role of roles) {
    const profile = DESIGN_PROFILES[role];
    const d = mkdtempSync(join(base, `role-${role}-`));
    const paths = rolePaths(d, role);
    const r = renderRoleSettings({ productionFiles: [], proposalOutboxes: [paths.deny.proposals[0]], role, profile, paths, product: { commands: { test: 'true' } } });
    if (!r.ok) { bad.push(`${role}: its file could not be rendered (${r.reason})`); continue; }
    const file = join(d, 'settings.json');
    writeFileSync(file, `${JSON.stringify(r.settings)}\n`);
    const args = roleArgs({ profile, settingsFile: file, model: RUN_MODEL });
    const out = await start(args, paths.copy);
    const c = checkInit(findInit(out), { role, profile, pin, args });
    if (!c.ok) bad.push(`${role}: ${c.reason}`);
  }
  return bad.length ? { ok: false, why: bad.join('; ') } : { ok: true };
}

/** A role's fixed paths, all inside the run's own folder (the shape launch.test.mjs N_PATHS has). */
export function rolePaths(d, role) {
  const p = (...x) => join(d, ...x);
  for (const x of ['copy', 'outbox', 'hooks', 'snapshots', 'owner-taps', 'notes', 'bob', 'proposals', 'secrets', 'keys', 'record', 'copy2', 'claude-home', 'r/outbox', 'r/review']) mkdirSync(p(x), { recursive: true });
  return {
    // A role the review runner starts keeps its snapshot inside the runner's folder (L921's wall).
    copy: p('copy'), outbox: p('outbox'), hooksDir: p('hooks'), snapshot: RUNNER_ROLES.includes(role) ? p('r', 'review', 'rules-snapshot.json') : p('snapshots', 'rules.json'), node: process.execPath, ownerTaps: p('owner-taps'),
    reviewAgainConfig: p('review-again.json'), notes: p('notes'), bobFolder: p('bob'), mirror: p('mirror.git'),
    deny: { proposals: [p('proposals')], secrets: [p('secrets')], claudeHome: p('claude-home'), robotKeys: p('keys'), record: p('record'), otherCopies: [p('copy2')] },
    reviewWalls: { outboxRoot: p('r', 'outbox'), runnerRoot: p('r', 'review') },
  };
}

/** Why the run must not start, or null. Every input is read by the caller. */
export function guardProblem({ c, uid, ownDirUid, claudeVersion, account }) {
  if (!Number.isInteger(uid) || uid === 0) return 'it runs as root. Run it as the worker runner\'s own user (sudo -H -u builder …)';
  if (ownDirUid !== uid) return `it runs as uid ${uid}, but the worker runner's own folder ${c?.ownDir} is uid ${ownDirUid}'s. Run it as that user`;
  if (typeof c?.claudeBin !== 'string' || !c.claudeBin.startsWith('/')) return 'the config names no pinned claude (claudeBin)';
  if (typeof c.pin !== 'string') return 'the config names no claude pin (pin)';
  if (claudeVersion !== c.pin) return `claude is ${claudeVersion ?? 'not readable'}, but the config's pin is ${c.pin}. Run it with the pinned claude`;
  if (!account?.account) return `no account is in use for the sessions (${account?.reason ?? 'no answer'})`;
  return null;
}

function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }
const arg = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// How long after claude exits its pipes may still drain (L1128 c3): a child it left holding them can't keep the run open.
export const DRAIN_MS = 2_000;
/** Runs claude to its end, or its time limit. → { out, err, code, signal, timedOut, error } */
export function runToEnd(bin, args, { cwd, env, timeoutMs = RUN_MS, drainMs = DRAIN_MS }) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let child; let timedOut = false; let done = false; let drain;
    try { child = childSpawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ out: '', err: '', error: e?.message ?? String(e) }); return; }
    const end = (x) => {
      if (done) return; done = true; clearTimeout(t); clearTimeout(drain);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* gone */ }
      resolve({ out, err, timedOut, ...x });
    };
    const t = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { if (err.length < 65_536) err += d; });
    child.on('error', (e) => end({ error: e?.message ?? String(e) }));
    child.on('exit', (code, signal) => { drain = setTimeout(() => end({ code, signal }), drainMs); });
    child.on('close', (code, signal) => end({ code, signal }));
  });
}

/** Runs claude until its start message is in (or it ends), then stops it. */
function runToInit(bin, args, { cwd, env, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    let out = ''; let child; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); try { child?.kill('SIGKILL'); } catch { /* gone */ } resolve(out); };
    const t = setTimeout(finish, timeoutMs);
    try { child = childSpawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { finish(); return; }
    child.stdout.on('data', (d) => { out += d; if (findInit(out)) finish(); });
    child.on('error', finish); child.on('close', finish);
  });
}

/**
 * Writes the run's receipt into `home` (L1124 m5: every run writes one, a refused one too) → its path. Throws when it
 * can't. Readable by the owner's own session (L1108): it holds names and results, no secret.
 */
export function writeReceipt({ home, at, header, lines, outcomes = {}, readback }) {
  const receipt = join(home, `settings-names-proof-${new Date(at).toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const rows = [{ ...header, at: new Date(at).toISOString() }, ...lines,
    ...Object.entries(outcomes).map(([test, o]) => ({ test, ok: o.ok, why: o.why ?? o.notTried ?? null, ...(o.fallback ? { fallback: o.fallback } : {}), seen: o.seen ?? null })),
    ...(readback ? [{ test: 'role read-back', ...readback }] : [])];
  writeFileSync(receipt, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`, { mode: 0o644, flag: 'wx' });
  return receipt;
}

/**
 * The end of a run: judges the names, prints a line for each, writes the receipt and prints its path, then the verdict,
 * last. PASS only when every counted name passed and the receipt was written (L1124 m5). → the exit code.
 */
export function finish({ res, pin, base, home, at, print }) {
  const lines = judgeNames({ outcomes: res.outcomes, readback: res.readback, version: pin });
  const r = report(lines, pin);
  print(r.text);
  if (base) print(`The runs' folders are kept in ${base}.\n`);
  let receipt;
  try { receipt = writeReceipt({ home, at, header: { pin, runs: base ?? null, ok: r.ok }, lines, outcomes: res.outcomes, readback: res.readback }); print(`Written to ${receipt}\n`); } catch (e) {
    print(`The record of this run could not be written (${e?.code ?? e?.message}), so the run can't be used.\n`);
    print(`NOT DONE on Claude Code ${pin}: the receipt could not be written${r.ok ? '' : `; ${r.verdict.replace(/^NOT DONE on Claude Code \S+: /, '')}`}\n`);
    return 1;
  }
  print(`${r.verdict}\n`);
  return r.ok ? 0 : 1;
}

/** The settings files of both account folders under `home`, each as the file a link leads to, once each (account b's
 * links to a's). → [{ name, file }] or throws for a link that leads nowhere. */
export function accountSettingsFiles(home) {
  const out = [];
  for (const name of ACCOUNT_NAMES) {
    // Each as its real path (a link followed; the folders' own links too), so one file is never listed twice.
    let f = join(accountDir(home, name), 'settings.json');
    if (lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink()) f = realpathSync.native(f);
    else { try { f = join(realpathSync.native(dirname(f)), 'settings.json'); } catch { /* no folder: as named */ } }
    if (!out.some((x) => x.file === f)) out.push({ name, file: f });
  }
  return out;
}
/** The command that puts a cut-off run's user settings file back: this run's own, with --restore (L1128 c3: the user is
 * the config's home folder's, the runner's user). */
export const restoreCommand = (c, argv) => ['sudo', '-H', '-u', basename(c.home), process.execPath, selfPath() ?? PROOF, ...argv.filter((a) => a !== '--restore'), '--restore'].join(' ');

const REAL = {
  readConfig: (path) => checkRunnerConfig(readJobConfig(path, { code: [], optionalCode: ['budget'], self: selfPath() })),
  accountInUse, sessionEnv, makeLock, runAll,
  claudeVersion: (bin, env) => /^(\d+\.\d+\.\d+)/.exec(execFileSync(bin, [F.version], { encoding: 'utf8', timeout: 30_000, env: env ?? {} }).trim())?.[1] ?? null,
  makeBase: () => mkdtempSync(join(tmpdir(), 'settings-names-proof-')),
  // The uid owning the runner's own folder, or null when it is not a plain folder or can't be read.
  ownDirUidOf: (dir) => { try { const st = lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink() ? st.uid : null; } catch { return null; } },
};

export async function main(argv, { print = (t) => process.stdout.write(t), uid = process.getuid?.(), now = () => Date.now(), home = homedir(), deps = {} } = {}) {
  const d = { ...REAL, ...deps };
  const names = allNames();
  const restoring = argv.includes('--restore');
  const stop = (why, version) => {
    if (restoring) { print(`Not put back: ${why}\n`); return 1; }
    const lines = names.map((n) => (REFUSED_SETTINGS.includes(n) ? { name: n, result: 'REFUSED', why: 'not proven: the launcher refuses it' } : Object.hasOwn(NOT_USED, n) ? { name: n, result: 'NOT USED', why: NOT_USED[n] } : notTried(n, why)));
    const r = report(lines, version);
    print(r.text);
    try { print(`Written to ${writeReceipt({ home, at: now(), header: { pin: version ?? null, runs: null, ok: false, refused: why }, lines })}\n`); } catch (e) { print(`The record of this run could not be written (${e?.code ?? e?.message})\n`); }
    print(`${r.verdict}\n`); return 1;
  };
  let c; try { c = d.readConfig(arg(argv, '--config')); } catch (e) { return stop(`the worker runner's config can't be read (${e?.message ?? e})`); }
  const ownDirUid = d.ownDirUidOf(c.ownDir);
  if (restoring) {
    // --restore (L1124 m4, L1128 m6): puts back the user settings file of each account folder a cut-off run left a
    // backup beside, whichever account is in use now. It runs as the same user.
    if (!Number.isInteger(uid) || uid === 0 || ownDirUid !== uid) return stop(`run it as the worker runner's own user (sudo -H -u ${basename(String(c.home ?? 'builder'))} …), not root`);
    let files; try { files = accountSettingsFiles(c.home); } catch (e) { return stop(`an account folder's settings file is a link that leads nowhere (${e?.message ?? e})`); }
    const left = files.filter((x) => backupLeft(x.file));
    if (!left.length) { print(`Nothing to put back: no backup beside ${files.map((x) => x.file).join(' or ')}\n`); return 0; }
    for (const x of left) { try { print(`${restoreUserFile(x.file, realFs)}\n`); } catch (e) { return stop(e?.message ?? String(e)); } }
    return 0;
  }
  // Every refusal from here on ends in a receipt and NOT DONE (L1128 m5), a throw too.
  let account; try { account = d.accountInUse({ home: c.home }); } catch (e) { return stop(`the account in use can't be read (${e?.message ?? e})`, c.pin); }
  let env = null; try { env = account?.account ? d.sessionEnv(c, account) : null; } catch (e) { return stop(`the sessions' variables can't be made (${e?.message ?? e})`, c.pin); }
  let claudeVersion = null; try { claudeVersion = d.claudeVersion(c.claudeBin, env); } catch { /* not readable */ }
  const bad = guardProblem({ c, uid, ownDirUid, claudeVersion, account });
  if (bad) return stop(bad, c.pin);
  // Account b's settings.json is a link to account a's (accounts.mjs SHARED): the file claude reads is the one it leads to.
  let userFile = join(account.dir, 'settings.json');
  if (lstatSync(userFile, { throwIfNoEntry: false })?.isSymbolicLink()) { try { userFile = realpathSync.native(userFile); } catch { return stop(`${userFile} is a link that leads nowhere`, c.pin); } }
  if (backupLeft(userFile)) return stop(`${userFile}${BACKUP_SUFFIX} ${LEFTOVER}: ${restoreCommand(c, argv)}`, c.pin);
  let lock; let held;
  try { lock = d.makeLock({ dir: c.ownDir, timeoutMs: 2_000 }); held = lock.acquire(); } catch (e) { return stop(/busy/.test(e?.message ?? '') ? 'the worker runner is running. Stop it first, then run this again' : `the worker runner's lock can't be taken (${e?.message ?? e})`, c.pin); }
  let res; let base;
  try {
    // Made inside the try (L1128 m5): a throw here still lets the lock go.
    base = d.makeBase();
    const io = {
      claude: (args, { cwd }) => runToEnd(c.claudeBin, args, { cwd, env }),
      readbackAll: () => roleReadback({ base, pin: c.pin, start: (args, cwd) => runToInit(c.claudeBin, args, { cwd, env }) }),
      guardPassed: true, userFile, fs: realFs, sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    };
    res = await d.runAll({ base, io });
  } catch (e) {
    return stop(`the run stopped: ${e?.message ?? e}`, c.pin);
  } finally { try { lock.release(held.nonce); } catch { /* gone */ } }
  // A put-back that failed mid-run leaves the backup (L1128 m6): say how to put the file back, in this same run.
  if (backupLeft(userFile)) print(`${userFile} could not be put back during the run; its backup is beside it. To put it back: ${restoreCommand(c, argv)}\n`);
  // The version counts only because claude --version said it before the run (the guard): a name is proven on that pin.
  return finish({ res, pin: c.pin, base, home, at: now(), print });
}

const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (invoked && invoked === selfPath()) process.exitCode = await main(process.argv.slice(2));
