// Launch check 5 (R-0b-32), the setup-file refusals (R-0b-39), the pinned-copy and compaction
// variables (R-0b-40, R-0b-42) and the hook entries (R-0b-37): turns one role profile into that
// role's settings file, writes it, reads it back from disk and checks every lock-down field.
//
// Allow rules come only from the product's declared commands, as exact strings. A wildcard, a
// prefix rule or a shell joiner is refused outright, never rendered. There are no "ask" rules:
// anything not allowed is refused, never put to the owner.

import { writeFileSync, readFileSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, basename, posix } from 'node:path';
import { SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E, ENV, REFUSED_SETTINGS } from './settings-names.mjs';
import { hasShell, DESIGN_PROFILES, shadowKindsFor, OUTBOX_FILE } from './role-profiles.mjs';
import { REVIEW_ROLES, RUNNER_ROLES } from '../../../shared/review-roles.mjs';
import { noteInOutbox } from '../hooks/compact-note.mjs';
import { inside } from '../hooks/lib.mjs';

// The review user's own folders (L66 M3): what a verdict counts from. A reviewer runs the change's tests by design, so
// code a worker wrote runs as `review`; the shell sandbox, for Bash and everything it starts, may write none of them,
// and the Write and Edit tools none but the outbox (where the verdict is written, through Write, which the hooks judge).
// The review runner's whole folder (its requests/, rejected/, launches/, status.json and its own memory, state.json),
// not only some of its children: a reviewer runs as the same Mac user as the runner (item 20 cosmetics).
export const REVIEW_WALLS = Object.freeze(['outboxRoot', 'runnerRoot']);

export const HOOK_TIMEOUT = 10;
// What ends every hook command (L75 caveat (c)). Claude Code runs a hook command in a shell and blocks only on exit 2;
// any other failure lets the call through. So a hook whose node or script is gone (the shell's 127), or that crashes
// (1, or a signal), exits 2 and blocks. A hook that answers 0 is unchanged; one that blocks with 2 still does.
export const HOOK_FAILS_CLOSED = ' || exit 2';
export const POLICY_HOOKS = Object.freeze({
  'plain-files': 'Write|Edit|NotebookEdit',
  'secret-file-block': 'Read|Grep|Glob|Edit|Write|NotebookEdit|Bash',
  'production-write-guard': '*',
  'merge-guard': 'Bash',
  'no-verify-block': 'Bash',
});
export const COMPACT_HOOKS = Object.freeze([
  [E.preCompact, 'auto|manual'],
  [E.postCompact, 'auto|manual'],
  [E.sessionStart, 'compact'],
]);

const refuse = (reason) => ({ ok: false, reason });
// One declared command: no wildcards, no shell joiners or substitutions, no newlines.
const BAD_COMMAND = /[*?\n\r;&|`<>]|\$\(|:\s*\*\s*$|^\s|\s$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Exact allow rules from product_profile.commands ({ key: 'exact command' }), keyed for the diary. */
export function renderAllowRules(commands = {}) {
  const rules = [];
  for (const [key, cmd] of Object.entries(commands)) {
    if (typeof cmd !== 'string' || !cmd || BAD_COMMAND.test(cmd)) return refuse(`declared command "${key}" is not one exact command`);
    rules.push(`Bash(${cmd})`);
  }
  return { ok: true, rules };
}

const abs = (p) => `/${p.replace(/^\/+/, '')}`; // Claude's "//path" form needs one more slash
// A wall path as the rules must name it (L736 #306 m1): absolute, plain characters, and spelled as its own resolved form
// (no `.` or empty segment, no `..`), so a rule never names a spelling the tool's path match may not see. One trailing
// slash run is dropped first; / itself is no folder to wall. → the path, or null.
const wallPath = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/') || /[^A-Za-z0-9._/-]/.test(p)) return null;
  const t = p.replace(/(?<=.)\/+$/, '');
  return t !== '/' && posix.resolve(t) === t ? t : null;
};
const denyPair = (p) => [`Read(/${abs(p)}/**)`, `Edit(/${abs(p)}/**)`];
/** The rules that keep the Bob folder read-only. The one source for both the renderer and launch check 13 (L750), so
 *  the form check 13 looks for is the form written. */
export const bobFolderDeny = (folder) => [`Edit(/${abs(folder)}/**)`, `Write(/${abs(folder)}/**)`];
/** The shell sandbox's write wall on the Bob folder (L763): the folder and everything in it. */
export const bobFolderShell = (folder) => [folder, `${folder}/**`];

/** The worker runner's folders (L751): its requests folder and its status file's folder, or a refusal. */
export function runnerWallDirs(workerRunner) {
  const wr = workerRunner ?? {};
  for (const k of ['requestsDir', 'statusFile']) {
    const v = wr[k];
    if (typeof v !== 'string' || !v.startsWith('/') || /[^A-Za-z0-9._/-]/.test(v) || v.split('/').includes('..')) return refuse(`the worker runner's ${k} is not a plain absolute path`);
  }
  const dirs = [];
  for (const dir of [wr.requestsDir, dirname(wr.statusFile)].map((x) => x.replace(/\/+$/, ''))) {
    if (!dir || dir.split('/').length < 3) return refuse('the worker runner\'s folders must sit below a folder of their own, not at the top');
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return { ok: true, dirs };
}
/** The one source for the runner wall's rules (L751), for the renderer and for checkRunnerWall alike. */
export const runnerWallDeny = (dir) => [`Read(/${abs(dir)}/**)`, `Edit(/${abs(dir)}/**)`, `Write(/${abs(dir)}/**)`];
export const runnerWallShell = (dir) => [dir, `${dir}/**`];

/**
 * The launch-time check of the runner wall (L751, review of #320 M1, M2): the role file denies each runner folder to the
 * tools and the shell, and each folder is spelled as its real path. A deny through a link is one macOS's sandbox ignores.
 * The launcher calls it for every role the runner starts (all but the Lead and the review roles), before the start.
 */
export function checkRunnerWall({ settings, workerRunner, realpath = (p) => realpathSync.native(p) }) {
  const w = runnerWallDirs(workerRunner);
  if (!w.ok) return w;
  const deny = settings?.[S.permissions]?.[S.deny] ?? [];
  const fs = settings?.[S.sandbox]?.[S.filesystem] ?? {};
  for (const dir of w.dirs) {
    let real; try { real = realpath(dir); } catch { return refuse(`the worker runner's folder ${dir} is missing`); }
    if (real !== dir) return refuse(`the worker runner's folder ${dir} is not its real path (${real}); a deny through a link is not kept`);
    if (!runnerWallDeny(dir).every((r) => deny.includes(r))) return refuse(`the role file does not deny the tools the worker runner's folder ${dir}`);
    if (!(fs[S.denyRead] ?? []).includes(dir) || !runnerWallShell(dir).every((r) => (fs[S.denyWrite] ?? []).includes(r))) return refuse(`the role file does not deny the shell the worker runner's folder ${dir}`);
  }
  return { ok: true };
}

/**
 * paths: { copy, outbox, hooksDir, snapshot, node, deny: { secrets: [], claudeHome, ssh, gh, robotKeys, record, otherCopies: [], proposals: [] },
 *          bobFolder?, extraOutboxes?: [], reviewWalls?, notes?, workerRunner?, ownerTaps? }
 * workerRunner { requestsDir, statusFile }: the worker runner's two paths (lane 4's owner-ports.mjs names, L751). The
 * workers run as the runner's own Mac user, so the owner check can't tell the runner's status from one a worker wrote:
 * when given, for every role but a reviewer or auditor, its requests folder and its status file's folder are denied to
 * read, edit and write, for the tools and the shell alike. Malformed is refused. Optional here (the launcher fixtures are
 * another lane's); checkRunnerWall is the launch-time check that it is there, as real paths.
 * ownerTaps: the owner's "review again" taps folder (the runner's `ownerTaps`). Needed by the Front Door, refused without
 * (L724 (4), R-0b-164): it runs as Joe's Mac user, who can write that folder, and only the owner's own tap handler may; so
 * its tools get Edit and Write denied there, and its shell a write-deny. It must be the folder the runner reads, in the
 * spelling the disk holds: `tapsFolderProblem` (review-runner-main.mjs) is that check, for the Front Door's install to run
 * and refuse on (L736 m4). Nothing calls it yet: the Front Door's install is not built (R-0b-162, lane 4's setup).
 * reviewAgainConfig: the owner's tap handler's config file (M1 review-again.mjs), which names the runner config it reads
 * the taps folder from. Needed by the Front Door, refused without, and walled the same way (L735, #284 m1-r2).
 * notes: the session's own compaction-notes folder, apart from the outbox (L101). Needed by every role whose kinds hold no
 * `<compactKind>-compact-` kind (all but the worker and the Front Door), refused without: their note never goes in the outbox.
 * reviewWalls { outboxRoot, runnerRoot }: needed for a reviewer or auditor (L66 M3), refused without. runnerRoot is the
 * review runner's folder (its config's `root`).
 * product: { commands, hosts }         rulesHosts: the rules' allowed hosts; registryHosts: allowed during install only
 * phase: 'session' | 'install'
 * productionFiles: the rules' `production.env_files`. Each must be on the read-deny list, or the launch is refused
 * (audit R-0b-44 round 3 MIN-2): the hooks match only plain words, and this list is the wall for `grep -r` or `tar`.
 * proposalOutboxes: every product's `proposals.outbox` from the rules, not only this session's product's (R-0b-128; L77 (1),
 * L78 n5). Each must be on the read-deny list (`deny.proposals`), or the launch is refused: every AI session but the
 * review roles runs as Joe's Mac user (L238), which can read Joe's proposals folders, so the settings are the wall. Required, and not empty (L746), for every role but a
 * reviewer or auditor, which runs as the `review` user the folders already shut out (the setup read-back proves it).
 */
export function renderRoleSettings({ role, profile, paths, product = {}, rulesHosts = [], registryHosts = [], phase = 'session', productionFiles, proposalOutboxes }) {
  if (!DESIGN_PROFILES[role]) return refuse(`no such role "${role}"`);
  if (phase !== 'session' && phase !== 'install') return refuse('bad phase');
  if (phase === 'install' && role !== 'worker') return refuse('only a worker has an install step');
  const shell = hasShell(profile);

  // Network: only hosts the rules allow. An off-list host is refused, never asked.
  const hosts = [...new Set(product.hosts ?? [])];
  for (const h of hosts) {
    if (!HOST.test(h)) return refuse(`host "${h}" is not a plain host name`);
    if (!rulesHosts.includes(h)) return refuse(`host "${h}" is not on the rules' allowed list`);
  }
  const allowedDomains = phase === 'install' ? [...hosts, ...registryHosts] : hosts;

  let allow = [];
  if (shell && role === 'worker') {
    const a = renderAllowRules(product.commands);
    if (!a.ok) return a;
    allow = a.rules;
  }

  const d = paths.deny ?? {};
  // The worker runner's folders (L751), walled off from every role the runner starts: all but the Lead (whose launch
  // requests the Dispatcher writes there; whether its own tools get a write wall is the lead's call) and the review roles.
  let runnerDirs = [];
  if (paths.workerRunner !== undefined && role !== 'lead' && !REVIEW_ROLES.includes(role)) {
    const w = runnerWallDirs(paths.workerRunner);
    if (!w.ok) return w;
    const own = [paths.outbox, paths.copy, paths.notes, paths.hooksDir, paths.snapshot, paths.node, paths.bobFolder].filter((x) => typeof x === 'string');
    if (w.dirs.some((dir) => own.some((x) => inside(x, dir) || inside(dir, x)))) return refuse('the worker runner\'s folders must be apart from the session\'s own folders (outbox, copy, notes, hooks, rules, node, Bob)');
    runnerDirs = w.dirs;
  }
  const denyPaths = [...(d.secrets ?? []), d.claudeHome, d.ssh, d.gh, d.robotKeys, d.record, ...(d.otherCopies ?? []), ...(d.proposals ?? [])].filter(Boolean);
  if (paths.mirror && denyPaths.includes(paths.mirror)) return refuse('the mirror must not be on the read-deny list');
  if (!Array.isArray(productionFiles)) return refuse('the rules\' production file list was not given');
  // One rule for every path that must be denied (lane 2's #124 review, m2): the path itself, or a folder above it, is on the list.
  const denied = (f) => typeof f === 'string' && denyPaths.some((d) => f === d || f.startsWith(`${d.replace(/\/+$/, '')}/`));
  const unguarded = productionFiles.filter((f) => !denied(f));
  if (unguarded.length) return refuse(`the rules list production files the role file does not deny: ${unguarded.join(', ')}`);
  if (proposalOutboxes === undefined && !REVIEW_ROLES.includes(role)) return refuse('the rules\' proposals folders were not given');
  if (proposalOutboxes !== undefined && !Array.isArray(proposalOutboxes)) return refuse('the rules\' proposals folders are not a list');
  // An empty list would leave the role with no proposals wall at all (audit R-0b-148 slice 1, m1; L746).
  if (Array.isArray(proposalOutboxes) && !proposalOutboxes.length && !REVIEW_ROLES.includes(role)) return refuse('the rules\' proposals folders are an empty list, so nothing would deny them');
  const open = (proposalOutboxes ?? []).filter((f) => !denied(f));
  if (open.length) return refuse(`the rules' proposals folders are not all on the read-deny list: ${open.join(', ')}`);
  const deny = denyPaths.flatMap(denyPair);
  // Outbox: no dot-names, no sub-folders' dot-names.
  const ob = abs(paths.outbox);
  deny.push(`Write(/${ob}/.*)`, `Edit(/${ob}/.*)`, `Write(/${ob}/**/.*)`, `Edit(/${ob}/**/.*)`);
  if (profile.setupFileRefusals) {
    for (const pat of ['//**/.claude/**', '//**/.mcp.json', '//**/SKILL.md']) deny.push(`Read(${pat})`, `Edit(${pat})`, `Write(${pat})`);
  }
  if (paths.bobFolder) deny.push(...bobFolderDeny(paths.bobFolder));
  for (const dir of runnerDirs) deny.push(...runnerWallDeny(dir));
  const walls = [];
  if (role === 'front_door') {
    const tt = wallPath(paths.ownerTaps);
    if (!tt) return refuse('the Front Door\'s settings need the owner\'s taps folder (ownerTaps) as a plain absolute path, spelled as it resolves');
    deny.push(`Edit(/${abs(tt)}/**)`, `Write(/${abs(tt)}/**)`);
    walls.push(tt, `${tt}/**`);
    const hc = wallPath(paths.reviewAgainConfig);
    if (!hc || paths.reviewAgainConfig.endsWith('/')) return refuse('the Front Door\'s settings need the owner\'s tap handler\'s config file (reviewAgainConfig) as a plain absolute path, spelled as it resolves');
    if (hc === tt || inside(hc, tt)) return refuse('the tap handler\'s config must sit outside the taps folder');
    deny.push(`Edit(/${abs(hc)})`, `Write(/${abs(hc)})`);
    walls.push(hc);
  }
  // Every role the review runner starts sits behind the review walls, the plan reviewer too (L710).
  if (RUNNER_ROLES.includes(role)) {
    const w = paths.reviewWalls ?? {};
    for (const k of REVIEW_WALLS) {
      // The same spelling rule as every wall path (L736 m1, the class).
      const p = wallPath(w[k]);
      if (!p) return refuse(`a ${role}'s settings need the review folder ${k} as a plain absolute path, spelled as it resolves`);
      walls.push(p, `${p}/**`);
      if (k !== 'outboxRoot') deny.push(`Edit(/${abs(p)}/**)`, `Write(/${abs(p)}/**)`);
    }
  }

  // Hook arguments are words, so no path may hold a space or a shell character.
  for (const p of [paths.node, paths.hooksDir, paths.outbox, paths.snapshot, paths.copy, paths.notes]) {
    if (p !== undefined && (typeof p !== 'string' || !p.startsWith('/') || /[^A-Za-z0-9._/-]/.test(p))) return refuse(`path "${p}" is not a plain absolute path`);
  }
  // Where the compaction note goes (L101): the outbox only for a role with a -compact- kind; any other role names its
  // notes folder, apart from the outbox, neither inside the other.
  let notesArg = '';
  if (!noteInOutbox(profile.compactKind, profile.outbox)) {
    if (paths.notes === undefined) return refuse(`a ${role}'s compaction note is kept outside the outbox, and no notes folder was given`);
    if (inside(paths.notes, paths.outbox) || inside(paths.outbox, paths.notes)) return refuse('the notes folder must be apart from the outbox');
    notesArg = ` --notes ${paths.notes}`;
  }
  // Only a worker and the writer change files in a code copy; every other role writes its outbox only.
  const copyArg = ['worker', 'writer'].includes(role) ? ` --copy ${paths.copy}` : '';
  // The longer listed kinds this role may not hand in, so the hook reads a name's kind as M9 does (L82 M-1).
  // Kept on purpose as the general guard (L121 cosmetic): today every such kind is a `-compact-` kind (report-compact-
  // for the reviewer, scout, writer, thinking role and scripts), which the compaction rule alone already keeps from
  // matching; this list also covers a longer kind added later that is not a compaction kind.
  const shadow = shadowKindsFor(role, profile.outbox);
  const notKinds = shadow.length ? ` --not-kinds ${shadow.join(',')}` : '';
  // A role with no kinds (the plan reviewer) gets no --kinds word, and its exact outbox files (L710) go as --files.
  const files = profile.files ?? [];
  if (files.some((f) => !OUTBOX_FILE.test(f))) return refuse(`a ${role}'s outbox file names are not plain names`);
  const kindsArg = profile.outbox.length ? ` --kinds ${profile.outbox.join(',')}` : '';
  const filesArg = files.length ? ` --files ${files.join(',')}` : '';
  const hookCmd = (name, extra = '') =>
    `${paths.node} ${join(paths.hooksDir, `${name}.mjs`)} --role ${role} --outbox ${paths.outbox} --snapshot ${paths.snapshot}${kindsArg}${filesArg}${notKinds}${copyArg}${extra}${HOOK_FAILS_CLOSED}`;
  const hooks = { [E.preToolUse]: [] };
  for (const [name, matcher] of Object.entries(POLICY_HOOKS)) {
    hooks[E.preToolUse].push({ [H.matcher]: matcher, [H.hooks]: [{ [H.type]: 'command', [H.command]: hookCmd(name), [H.timeout]: HOOK_TIMEOUT, [H.onFailure]: 'block' }] });
  }
  for (const [event, matcher] of COMPACT_HOOKS) {
    (hooks[event] ??= []).push({ [H.matcher]: matcher, [H.hooks]: [{ [H.type]: 'command', [H.command]: hookCmd('compact-note', ` --kind ${profile.compactKind} --event ${event}${notesArg}`), [H.timeout]: HOOK_TIMEOUT, [H.onFailure]: 'block' }] });
  }

  const settings = {
    [S.permissions]: {
      [S.defaultMode]: profile.mode,
      [S.allow]: allow,
      [S.deny]: deny,
      [S.ask]: [],
      [S.additionalDirectories]: [paths.outbox, ...(paths.bobFolder ? [paths.bobFolder] : [])],
    },
    [S.sandbox]: {
      [S.sandboxEnabled]: true,
      [S.failIfUnavailable]: true,
      [S.allowUnsandboxedCommands]: false,
      [S.network]: { [S.allowedDomains]: allowedDomains, [S.strictAllowlist]: true },
      [S.filesystem]: { [S.denyRead]: [...denyPaths, ...runnerDirs], [S.denyWrite]: [`${paths.outbox}/.*`, `${paths.outbox}/**/.*`, ...(paths.bobFolder ? bobFolderShell(paths.bobFolder) : []), ...runnerDirs.flatMap(runnerWallShell), ...walls] },
    },
    [S.hooks]: hooks,
    [S.env]: { [ENV.autoCompactWindow]: String(profile.compactWindow), [ENV.disableUpdates]: '1' },
    [S.disableClaudeAiConnectors]: true,
    [S.enabledPlugins]: {},
    [S.crossSessionInbound]: 'refuse',
    [S.disableSkillShellExecution]: true,
    [S.disableBundledSkills]: true,
  };
  if (!shell) settings[S.sandbox][S.network][S.allowedDomains] = [];
  return { ok: true, settings };
}

/**
 * Every lock-down field a loaded settings file must (or must not) hold. Run on the rendered file
 * after reading it back from disk, and (as `machineWide: true`) on the machine-wide file, where an
 * excludedCommands entry or an unsandboxed escape refuses every role.
 */
export function checkSettings(obj, { machineWide = false, profile = null } = {}) {
  const sb = obj?.[S.sandbox];
  const p = obj?.[S.permissions];
  if (sb && Object.hasOwn(sb, S.excludedCommands)) return refuse(`${machineWide ? 'machine-wide' : 'role'} settings hold excludedCommands`);
  if (sb && sb[S.allowUnsandboxedCommands] === true) return refuse(`${machineWide ? 'machine-wide' : 'role'} settings allow unsandboxed commands`);
  for (const k of REFUSED_SETTINGS) if (obj && Object.hasOwn(obj, k)) return refuse(`${machineWide ? 'machine-wide' : 'role'} settings hold ${k}`);
  if (machineWide) {
    // The machine-wide file may add deny rules and hooks, never allow, ask, extra hosts or folders,
    // a permission mode, variables, or a sandbox switched off (round 2 MIN-5).
    if (p?.[S.allow]?.length || p?.[S.ask]?.length) return refuse('machine-wide settings hold allow or ask rules');
    if (p && Object.hasOwn(p, S.defaultMode)) return refuse('machine-wide settings set a permission mode');
    if (p && Object.hasOwn(p, S.additionalDirectories)) return refuse('machine-wide settings add folders');
    if (obj && Object.hasOwn(obj, S.env)) return refuse('machine-wide settings set variables');
    if (sb && sb[S.sandboxEnabled] === false) return refuse('machine-wide settings switch the sandbox off');
    if (sb?.[S.network]?.[S.allowedDomains]?.length) return refuse('machine-wide settings add allowed hosts');
    return { ok: true };
  }
  if (!sb || sb[S.sandboxEnabled] !== true) return refuse('sandbox is not on');
  if (sb[S.failIfUnavailable] !== true) return refuse('failIfUnavailable is not true');
  if (sb[S.allowUnsandboxedCommands] !== false) return refuse('allowUnsandboxedCommands is not false');
  if (sb[S.network]?.[S.strictAllowlist] !== true) return refuse('strictAllowlist is not true');
  if (!p || p[S.ask]?.length) return refuse('role settings hold ask rules');
  if ((p[S.allow] ?? []).some((r) => !/^Bash\(.+\)$/.test(r) || BAD_COMMAND.test(r.slice(5, -1)))) return refuse('an allow rule is not one exact command');
  if (profile && p[S.defaultMode] !== profile.mode) return refuse('permission mode differs from the profile');
  for (const list of Object.values(obj[S.hooks] ?? {})) {
    for (const m of Array.isArray(list) ? list : []) for (const h of m?.[H.hooks] ?? []) {
      if (typeof h?.[H.command] !== 'string' || !h[H.command].endsWith(HOOK_FAILS_CLOSED)) return refuse('a hook command does not exit 2 when it fails to run');
    }
  }
  if (obj[S.disableClaudeAiConnectors] !== true) return refuse('connectors are not off');
  if (obj[S.crossSessionInbound] !== 'refuse') return refuse('incoming messages are not refused');
  if (obj[S.disableSkillShellExecution] !== true) return refuse('skill shell lines are not off');
  if (obj[S.disableBundledSkills] !== true) return refuse('bundled skills are not off');
  if (Object.values(obj[S.enabledPlugins] ?? {}).some(Boolean)) return refuse('a plugin is on');
  if (obj[S.env]?.[ENV.disableUpdates] !== '1') return refuse('updates are not off for the role');
  if (profile && obj[S.env]?.[ENV.autoCompactWindow] !== String(profile.compactWindow)) return refuse('compaction window differs from the profile');
  if (profile?.setupFileRefusals) {
    for (const pat of ['//**/.claude/**', '//**/.mcp.json', '//**/SKILL.md']) {
      for (const t of ['Read', 'Edit', 'Write']) if (!p[S.deny]?.includes(`${t}(${pat})`)) return refuse(`setup-file refusal ${t}(${pat}) is missing`);
    }
  }
  return { ok: true };
}

/** Writes the role file (atomically), reads it back from disk and checks it. */
export function writeRoleSettings(file, settings, { profile } = {}) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const tmp = join(dirname(file), `.${basename(file)}.tmp`);
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
  let back; try { back = JSON.parse(readFileSync(file, 'utf8')); } catch { return refuse('role settings did not read back'); }
  if (JSON.stringify(back) !== JSON.stringify(settings)) return refuse('role settings read back differently');
  const c = checkSettings(back, { profile });
  return c.ok ? { ok: true, file, settings: back } : c;
}
