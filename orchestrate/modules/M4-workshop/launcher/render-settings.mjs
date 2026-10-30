// Launch check 5 (R-0b-32), the setup-file refusals (R-0b-39), the pinned-copy and compaction
// variables (R-0b-40, R-0b-42) and the hook entries (R-0b-37): turns one role profile into that
// role's settings file, writes it, reads it back from disk and checks every lock-down field.
//
// Allow rules come only from the product's declared commands, as exact strings. A wildcard, a
// prefix rule or a shell joiner is refused outright, never rendered. There are no "ask" rules:
// anything not allowed is refused, never put to Joe.

import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E, ENV, REFUSED_SETTINGS } from './settings-names.mjs';
import { hasShell, DESIGN_PROFILES } from './role-profiles.mjs';

export const HOOK_TIMEOUT = 10;
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
const denyPair = (p) => [`Read(/${abs(p)}/**)`, `Edit(/${abs(p)}/**)`];

/**
 * paths: { copy, outbox, hooksDir, snapshot, node, deny: { secrets: [], claudeHome, ssh, gh, robotKeys, record, otherCopies: [] },
 *          bobFolder?, extraOutboxes?: [] }
 * product: { commands, hosts }         rulesHosts: the rules' allowed hosts; registryHosts: allowed during install only
 * phase: 'session' | 'install'
 */
export function renderRoleSettings({ role, profile, paths, product = {}, rulesHosts = [], registryHosts = [], phase = 'session' }) {
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
  const denyPaths = [...(d.secrets ?? []), d.claudeHome, d.ssh, d.gh, d.robotKeys, d.record, ...(d.otherCopies ?? [])].filter(Boolean);
  if (paths.mirror && denyPaths.includes(paths.mirror)) return refuse('the mirror must not be on the read-deny list');
  const deny = denyPaths.flatMap(denyPair);
  // Outbox: no dot-names, no sub-folders' dot-names.
  const ob = abs(paths.outbox);
  deny.push(`Write(/${ob}/.*)`, `Edit(/${ob}/.*)`, `Write(/${ob}/**/.*)`, `Edit(/${ob}/**/.*)`);
  if (profile.setupFileRefusals) {
    for (const pat of ['//**/.claude/**', '//**/.mcp.json', '//**/SKILL.md']) deny.push(`Read(${pat})`, `Edit(${pat})`, `Write(${pat})`);
  }
  if (paths.bobFolder) deny.push(`Edit(/${abs(paths.bobFolder)}/**)`, `Write(/${abs(paths.bobFolder)}/**)`);

  // Hook arguments are words, so no path may hold a space or a shell character.
  for (const p of [paths.node, paths.hooksDir, paths.outbox, paths.snapshot, paths.copy]) {
    if (p !== undefined && (typeof p !== 'string' || !p.startsWith('/') || /[^A-Za-z0-9._/-]/.test(p))) return refuse(`path "${p}" is not a plain absolute path`);
  }
  // Only a worker and the writer change files in a code copy; every other role writes its outbox only.
  const copyArg = ['worker', 'writer'].includes(role) ? ` --copy ${paths.copy}` : '';
  const hookCmd = (name, extra = '') =>
    `${paths.node} ${join(paths.hooksDir, `${name}.mjs`)} --role ${role} --outbox ${paths.outbox} --snapshot ${paths.snapshot} --kinds ${profile.outbox.join(',')}${copyArg}${extra}`;
  const hooks = { [E.preToolUse]: [] };
  for (const [name, matcher] of Object.entries(POLICY_HOOKS)) {
    hooks[E.preToolUse].push({ [H.matcher]: matcher, [H.hooks]: [{ [H.type]: 'command', [H.command]: hookCmd(name), [H.timeout]: HOOK_TIMEOUT, [H.onFailure]: 'block' }] });
  }
  for (const [event, matcher] of COMPACT_HOOKS) {
    (hooks[event] ??= []).push({ [H.matcher]: matcher, [H.hooks]: [{ [H.type]: 'command', [H.command]: hookCmd('compact-note', ` --kind ${profile.compactKind} --event ${event}`), [H.timeout]: HOOK_TIMEOUT, [H.onFailure]: 'block' }] });
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
      [S.filesystem]: { [S.denyRead]: denyPaths, [S.denyWrite]: [`${paths.outbox}/.*`, `${paths.outbox}/**/.*`] },
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
    // The machine-wide file may add deny rules, never allow, ask or extra hosts.
    if (p?.[S.allow]?.length || p?.[S.ask]?.length) return refuse('machine-wide settings hold allow or ask rules');
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
