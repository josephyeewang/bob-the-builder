// Every Claude Code setting, flag and variable name the launcher writes or reads, in one place
// (review 0b-3 M7). A wrong name is silently ignored by Claude Code, so the lock-down would look
// on but not be. Correcting a name is a one-line change here.
//
// Capability note: NOT VERIFIED against the pinned Claude Code. Each name comes from the design
// (v4 §14.1) and must be re-checked at every pin change (live proof L2, "names check"). Until a
// name is confirmed by the read-back or a break-it test, the launch refuses: `launch()` runs
// `unconfirmedNames` on the rendered role file before check 1 (audit R-0b-44 M-1).

export const FLAGS = Object.freeze({
  print: '-p',
  outputFormat: '--output-format',
  streamJson: 'stream-json',
  verbose: '--verbose',
  tools: '--tools',
  settings: '--settings',
  restricted: '--restricted',
  strictMcpConfig: '--strict-mcp-config',
  mcpConfig: '--mcp-config',
  permissionMode: '--permission-mode',
  model: '--model',
  effort: '--effort',
  version: '--version',
  maxTurns: '--max-turns',
});

export const SETTINGS = Object.freeze({
  permissions: 'permissions',
  allow: 'allow',
  deny: 'deny',
  ask: 'ask',
  defaultMode: 'defaultMode',
  additionalDirectories: 'additionalDirectories',
  sandbox: 'sandbox',
  sandboxEnabled: 'enabled',
  failIfUnavailable: 'failIfUnavailable',
  allowUnsandboxedCommands: 'allowUnsandboxedCommands',
  excludedCommands: 'excludedCommands',
  network: 'network',
  allowedDomains: 'allowedDomains',
  strictAllowlist: 'strictAllowlist',
  filesystem: 'filesystem',
  denyRead: 'denyRead',
  denyWrite: 'denyWrite',
  hooks: 'hooks',
  env: 'env',
  disableClaudeAiConnectors: 'disableClaudeAiConnectors',
  enabledPlugins: 'enabledPlugins',
  crossSessionInbound: 'crossSessionInbound',
  disableSkillShellExecution: 'disableSkillShellExecution',
  disableBundledSkills: 'disableBundledSkills',
  apiKeyHelper: 'apiKeyHelper',
  disableAllHooks: 'disableAllHooks',
});

export const HOOK_FIELDS = Object.freeze({
  type: 'type',
  command: 'command',
  timeout: 'timeout',
  onFailure: 'onFailure',
  matcher: 'matcher',
  hooks: 'hooks',
});

export const HOOK_EVENTS = Object.freeze({
  preToolUse: 'PreToolUse',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
  sessionStart: 'SessionStart',
});

export const ENV = Object.freeze({
  autoCompactWindow: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  disableUpdates: 'DISABLE_UPDATES',
});

// Launch check 9: variables and settings that would send usage to another account or service.
export const REFUSED_ENV = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
]);
// A settings key that does the same from inside a settings file.
export const REFUSED_SETTINGS = Object.freeze([SETTINGS.apiKeyHelper, SETTINGS.disableAllHooks]);

// Fields of the headless start message the read-back needs (review 0b-3 M6). Which ones the
// pinned version really carries is NOT VERIFIED; a missing one refuses.
export const INIT_FIELDS = Object.freeze({
  type: 'type',
  subtype: 'subtype',
  initType: 'system',
  initSubtype: 'init',
  tools: 'tools',
  mcpServers: 'mcp_servers',
  plugins: 'plugins',
  skills: 'skills',
  settingSources: 'setting_sources',
  permissionMode: 'permissionMode',
  version: 'claude_code_version',
});

// The two settings sources a role may load: the machine-wide (managed) file and --settings.
export const ALLOWED_SETTING_SOURCES = Object.freeze(['managed', 'flag']);

export const MIN_CLAUDE_CODE = '2.1.295';

// ---- which names are confirmed (audit R-0b-44 M-1) ----
//
// One entry per name the launcher writes: how it was proven (`readback:<start-message field>` or
// `break-it:<test>`) and the Claude Code version it was proven on. An entry counts only for that
// exact version, so a pin change makes every name unconfirmed until live proof L2 runs again.
// Empty today: no name has been proven live yet, so every launch refuses (fail closed).
export const CONFIRMED = Object.freeze({});

// Keys whose children are data (plugin ids, variable names and values), not setting names.
const DATA_KEYS = new Set([SETTINGS.enabledPlugins]);
const VARS_KEY = SETTINGS.env;

/** Every setting, hook field and hook event name in a rendered role file, plus its variable names. */
export function namesIn(settings) {
  const out = new Set();
  const walk = (v, parent) => {
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') walk(x, parent); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      if (!DATA_KEYS.has(k) && k !== VARS_KEY) walk(x, k);
      if (k === VARS_KEY && x && typeof x === 'object') for (const name of Object.keys(x)) out.add(name);
    }
  };
  walk(settings, '');
  return [...out].sort();
}

/**
 * The names in `settings` (plus `flags`) not confirmed on `version`. Empty = the launch may go on.
 * `confirmed` defaults to CONFIRMED; tests pass their own.
 */
export function unconfirmedNames({ settings, flags = [], version, confirmed = CONFIRMED }) {
  if (typeof version !== 'string' || !version) return ['(no Claude Code version given)'];
  return [...new Set([...namesIn(settings), ...flags])].filter((n) => {
    const c = Object.hasOwn(confirmed, n) ? confirmed[n] : null;
    return !(c && typeof c.by === 'string' && /^(readback|break-it):./.test(c.by) && c.version === version);
  });
}
