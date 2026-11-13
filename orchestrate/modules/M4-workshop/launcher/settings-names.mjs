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
  sessionId: '--session-id',
  settingSources: '--setting-sources',
});

// Which settings files a start may load (L1093, R-0b-177). An allowed list of one: the empty list, so no user, project or
// local file loads. Claude Code then loads only the machine-wide (managed) file and --settings, which it always loads.
// A capability note, read in the pin's own code on 13 Nov 2026 (checked: claude-code 2.1.316): `--setting-sources ""`
// parses to [] and the loaded sources are that list plus flagSettings and policySettings; the start message no longer
// names its sources, so the read-back (readback.mjs checkInit) checks the start command instead, and the live proof
// (setup/live-proofs/settings-names.mjs) shows a project and a local file are not loaded with it and are without it.
export const NO_FILE_SOURCES = '';
/** The start-command words that limit the settings sources: the only form the read-back accepts. */
export const sourcesArgs = () => [FLAGS.settingSources, NO_FILE_SOURCES];

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

// Fields of the headless start message the read-back reads (review 0b-3 M6). Every one but settingSources is required,
// and a missing one refuses. settingSources is read only when a version sends it: 2.1.316 does not (L1093; checked:
// claude-code 2.1.316), so without it the read-back checks the start command's sourcesArgs instead.
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

// Launch check 0's two refusals begin with these words (launch.mjs). Another program that must tell "blocked at
// check 0" apart from a failure (setup/live-proofs/runlocked.mjs blockedBy, L1108 I7) uses isNamesCheckRefusal, never
// its own copy of the words.
export const NAMES_CHECK_REFUSALS = Object.freeze({
  unconfirmed: 'setting names not confirmed',
  notLocked: 'the role file given to the names check',
});
/** Whether a launch's refusal reason is one of check 0's. */
export const isNamesCheckRefusal = (reason) => Object.values(NAMES_CHECK_REFUSALS).some((p) => String(reason ?? '').startsWith(p));

// ---- which names are confirmed (audit R-0b-44 M-1) ----
//
// One entry per name the launcher writes: how it was proven (`readback:<start-message field>`, `break-it:<test>`, or
// `spelling:<test>`, a pair showing the CLI reads that name: L1114, for the names whose behaviour proof is R-0b-178)
// and the Claude Code version it was proven on. An entry counts only for that
// exact version, so a pin change makes every name unconfirmed until live proof L2 runs again.
// Three names are proven, by the sandbox setting's break-it test (review-walls-proof.test.mjs, L91 (1)): with
// `sandbox.enabled` and `allowUnsandboxedCommands: false` a call asking to leave the sandbox was refused, and with
// `true` (the control) the same call wrote. Every other name is still unproven, so every launch still refuses.
const SANDBOX_BREAK_IT = Object.freeze({ by: 'break-it:review-walls-proof.test.mjs "the sandbox setting"', version: '2.1.316' });
export const CONFIRMED = Object.freeze({
  [SETTINGS.sandbox]: SANDBOX_BREAK_IT,
  [SETTINGS.sandboxEnabled]: SANDBOX_BREAK_IT,
  [SETTINGS.allowUnsandboxedCommands]: SANDBOX_BREAK_IT,
});

/** The ways a CONFIRMED entry may say a name was proven. */
export const PROOF_KIND = /^(readback|break-it|spelling):./;

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
    return !(c && typeof c.by === 'string' && PROOF_KIND.test(c.by) && c.version === version);
  });
}
