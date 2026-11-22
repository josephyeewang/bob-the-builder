// Every Claude Code setting, flag and variable name the launcher writes or reads, in one place
// (review 0b-3 M7). A wrong name is silently ignored by Claude Code, so the lock-down would look
// on but not be. Correcting a name is a one-line change here.
//
// Capability note: NOT VERIFIED against the pinned Claude Code. Each name comes from the design
// (v4 §14.1) and must be re-checked at every pin change (live proof L2, "names check"). Until a
// name is confirmed by the read-back or a break-it test, the launch refuses: `launch()` runs
// `unconfirmedNames` on the rendered role file before check 1 (audit R-0b-44 M-1). Read in 2.1.316's own code (13 Nov
// 2026): every name here is in it except INIT_FIELDS.settingSources (`setting_sources`), which no start message carries
// (readback.mjs's note); the read-back itself is still for the live proof (checked: claude-code 2.1.316, open until
// 2027-01-20 (R-0b-177)).

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
/** The start-command words that load no tool server but an empty list: every start the launcher makes carries them
 * (readback.mjs roleArgs, review-launch.mjs sessionArgs, the live proof's runs). */
export const noToolServerArgs = () => [FLAGS.strictMcpConfig, FLAGS.mcpConfig, '{"mcpServers":{}}'];

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
  httpProxyPort: 'httpProxyPort',
  socksProxyPort: 'socksProxyPort',
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
  skillOverrides: 'skillOverrides',
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
  noToolLock: 'the start has no empty tool-server lock',
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
// `true` (the control) the same call wrote. L1336: every other name the role files write was proven by the
// settings-names proof as the builder on the Mini (receipt settings-names-proof-2026-11-22T03-14-34-305Z.jsonl, UTC), each
// entry naming the pair or read-back that proved it.
const c = (by) => Object.freeze({ by, version: '2.1.316' });
const SANDBOX_BREAK_IT = Object.freeze({ by: 'break-it:review-walls-proof.test.mjs "the sandbox setting"', version: '2.1.316' });
export const CONFIRMED = Object.freeze({
  [SETTINGS.sandbox]: SANDBOX_BREAK_IT,
  [SETTINGS.sandboxEnabled]: SANDBOX_BREAK_IT,
  [SETTINGS.allowUnsandboxedCommands]: SANDBOX_BREAK_IT,
  // L1335: the walled pairs, run off the builder account by settings-names-off-wall.mjs on the Mini, 2026-11-21.
  [SETTINGS.network]: Object.freeze({ by: 'break-it:settings-names.mjs "an allowed host is reached from inside the sandbox, and only then"', version: '2.1.316' }),
  [SETTINGS.allowedDomains]: Object.freeze({ by: 'break-it:settings-names.mjs "an allowed host is reached from inside the sandbox, and only then"', version: '2.1.316' }),
  [SETTINGS.strictAllowlist]: Object.freeze({ by: 'break-it:settings-names.mjs "with strictAllowlist on, a host the project file allows is refused; without it, that host is reached (the --settings host, reached on both sides, is the control)"', version: '2.1.316' }),
  // L1336: the builder's run on the Mini, 2026-11-21 Pacific (2026-11-22 UTC).
  [FLAGS.print]: c("readback:settings-names.mjs \"role read-back\""),
  [FLAGS.outputFormat]: c("readback:settings-names.mjs \"role read-back\""),
  [FLAGS.streamJson]: c("readback:settings-names.mjs \"role read-back\""),
  [FLAGS.verbose]: c("readback:settings-names.mjs \"role read-back\""),
  [FLAGS.tools]: c("readback:settings-names.mjs \"role read-back\""),
  [FLAGS.settings]: c("break-it:settings-names.mjs \"a SessionStart hook in the --settings file runs at the start\""),
  [FLAGS.restricted]: c("break-it:settings-names.mjs \"--restricted loads no project settings file either\""),
  [FLAGS.strictMcpConfig]: c("readback:settings-names.mjs \"with the tool-server lock, a project's own tool server is not in the start message; without it, it is\""),
  [FLAGS.mcpConfig]: c("readback:settings-names.mjs \"a tool server given by --mcp-config is in the start message; with none given, it is not\""),
  [FLAGS.permissionMode]: c("break-it:settings-names.mjs \"an allow rule lets a command run that the mode refuses\""),
  [FLAGS.model]: c("readback:settings-names.mjs \"the start message names the model asked for\""),
  [FLAGS.effort]: c("readback:settings-names.mjs \"--effort high is taken with no warning, and a made-up level is named in claude's warning\""),
  [FLAGS.version]: c("readback:settings-names.mjs \"claude --version printed the pin before the run\""),
  [FLAGS.maxTurns]: c("break-it:settings-names.mjs \"--max-turns 1 stops before a second command; 4 lets it run\""),
  [FLAGS.sessionId]: c("readback:settings-names.mjs \"the start message carries the session id given\""),
  [FLAGS.settingSources]: c("break-it:settings-names.mjs \"with --setting-sources \"\", no user, project or local settings file loads; without it, each does\""),
  [SETTINGS.permissions]: c("break-it:settings-names.mjs \"an allow rule lets a command run that the mode refuses\""),
  [SETTINGS.allow]: c("break-it:settings-names.mjs \"an allow rule lets a command run that the mode refuses\""),
  [SETTINGS.deny]: c("break-it:settings-names.mjs \"a deny rule refuses a command an allow rule lets run\""),
  [SETTINGS.ask]: c("break-it:settings-names.mjs \"an ask rule, with no one to ask, refuses a command an allow rule lets run\""),
  [SETTINGS.defaultMode]: c("break-it:settings-names.mjs \"the settings' mode, with no --permission-mode, decides a file write\""),
  [SETTINGS.additionalDirectories]: c("break-it:settings-names.mjs \"an added folder lets a file write outside the working folder\""),
  [SETTINGS.failIfUnavailable]: c("break-it:settings-names.mjs \"with failIfUnavailable, a sandbox that can't be built as written refuses the command; without it, the bad entry is dropped and the command runs\""),
  [SETTINGS.excludedCommands]: c("break-it:settings-names.mjs \"an excluded command runs outside the sandbox (the launcher refuses the setting; proven for its name)\""),
  [SETTINGS.httpProxyPort]: c("break-it:settings-names.mjs \"the shell's fetch goes to the httpProxyPort port, and only then\""),
  [SETTINGS.socksProxyPort]: c("break-it:settings-names.mjs \"a fetch through FTP_PROXY goes to the socksProxyPort port, and only then\""),
  [SETTINGS.filesystem]: c("break-it:settings-names.mjs \"a denyWrite folder is refused inside the working folder\""),
  [SETTINGS.denyRead]: c("break-it:settings-names.mjs \"a denyRead file can't be read by a command\""),
  [SETTINGS.denyWrite]: c("break-it:settings-names.mjs \"a denyWrite folder is refused inside the working folder\""),
  [SETTINGS.hooks]: c("break-it:settings-names.mjs \"a PreToolUse hook with a Bash matcher runs before the command\""),
  [SETTINGS.env]: c("break-it:settings-names.mjs \"the settings' variables are set inside a Bash call\""),
  [SETTINGS.enabledPlugins]: c("readback:settings-names.mjs \"a built-in plugin set to false is not in the start message (L1333)\""),
  [SETTINGS.crossSessionInbound]: c("break-it:settings-names.mjs \"with crossSessionInbound refuse, claude takes a plain message but not one from another session; with accept, it takes both\""),
  [SETTINGS.disableSkillShellExecution]: c("break-it:settings-names.mjs \"a skill's inline shell does not run when it is off\""),
  [SETTINGS.disableBundledSkills]: c("readback:settings-names.mjs \"the start message lists fewer skills with the bundled ones off\""),
  [SETTINGS.skillOverrides]: c("readback:settings-names.mjs \"a skill set \"off\" in skillOverrides is not in the start message (L1333)\""),
  [HOOK_FIELDS.type]: c("break-it:settings-names.mjs \"a PreToolUse hook with a Bash matcher runs before the command\""),
  [HOOK_FIELDS.command]: c("break-it:settings-names.mjs \"a PreToolUse hook with a Bash matcher runs before the command\""),
  [HOOK_FIELDS.timeout]: c("break-it:settings-names.mjs \"a hook past its timeout is stopped before it writes\""),
  [HOOK_FIELDS.onFailure]: c("break-it:settings-names.mjs \"a failing hook with onFailure block stops the command; with continue it runs\""),
  [HOOK_FIELDS.matcher]: c("break-it:settings-names.mjs \"a PreToolUse hook with a Bash matcher runs before the command\""),
  [HOOK_EVENTS.preToolUse]: c("break-it:settings-names.mjs \"a PreToolUse hook with a Bash matcher runs before the command\""),
  [HOOK_EVENTS.preCompact]: c("break-it:settings-names.mjs \"PreCompact and PostCompact hooks run around a /compact\""),
  [HOOK_EVENTS.postCompact]: c("break-it:settings-names.mjs \"PreCompact and PostCompact hooks run around a /compact\""),
  [HOOK_EVENTS.sessionStart]: c("break-it:settings-names.mjs \"a SessionStart hook in the --settings file runs at the start\""),
  [ENV.autoCompactWindow]: c("break-it:settings-names.mjs \"the settings' variables are set inside a Bash call\""),
  [ENV.disableUpdates]: c("break-it:settings-names.mjs \"the settings' variables are set inside a Bash call\""),
});

/**
 * The plugins built into Claude Code that it turns on by itself (L1333; checked: claude-code 2.1.316, 2026-11-20).
 * `--setting-sources ""` does not stop them (L1114 assumed it did). Every role file switches each one off by its id
 * in enabledPlugins (false); on 2.1.316 that turns off all but cc-plugin-sec-default.
 */
export const BUILTIN_PLUGIN_IDS = Object.freeze(['cc-plugin-sec-default@builtin', 'cc-plugin-agents-md@builtin', 'cc-plugin-telemetry@builtin', 'cc-plugin-plugin-authoring@builtin']);
/**
 * Per pinned version, the built-in plugins no setting turns off (L1333; checked: claude-code 2.1.316): the only plugins launch check 6 lets through,
 * each by its exact name with path "builtin" and source "<name>@builtin", on that version alone. A new pin has none
 * until its proof shows what it loads.
 */
export const FORCED_BUILTIN_PLUGINS = Object.freeze({ '2.1.316': Object.freeze(['cc-plugin-sec-default']) });
/**
 * Per pinned version, the tools a headless (-p) start never loads, whatever --tools says (L1333; checked: claude-code
 * 2.1.316): launch check 6 does not count one missing when the role lists it. Loaded, it still has to be on the role.
 */
export const HEADLESS_UNLOADED = Object.freeze({ '2.1.316': Object.freeze(['AskUserQuestion']) });
/**
 * The built-in skills disableBundledSkills leaves on (L1333; checked: claude-code 2.1.316, 2026-11-20): every role file
 * turns each one "off" in skillOverrides, which hides it from the model and from /name alike.
 */
export const BUILTIN_SKILLS_OFF = Object.freeze(['design', 'doctor']);

/** The ways a CONFIRMED entry may say a name was proven. */
export const PROOF_KIND = /^(readback|break-it|spelling):./;
/** The only names a spelling pair may confirm (L1114, audit L1124 m3): it shows the CLI reads the name, not what the
 * setting does, so it counts only where the lead ruled it does. Their behaviour proofs are R-0b-178. */
export const SPELLING_ONLY = Object.freeze([SETTINGS.failIfUnavailable, SETTINGS.strictAllowlist, SETTINGS.crossSessionInbound]);
/** Whether a CONFIRMED entry's `by` text proves `name`: a known proof kind, and a spelling pair only for SPELLING_ONLY. */
export const proofCounts = (name, by) => typeof by === 'string' && PROOF_KIND.test(by) && (!by.startsWith('spelling:') || SPELLING_ONLY.includes(name));

// Keys whose children are data (plugin ids, variable names and values), not setting names.
const DATA_KEYS = new Set([SETTINGS.enabledPlugins, SETTINGS.skillOverrides]);
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
    return !(c && proofCounts(n, c.by) && c.version === version);
  });
}
