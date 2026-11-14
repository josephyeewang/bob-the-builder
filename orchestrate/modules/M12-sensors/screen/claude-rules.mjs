// Claude Code screen rules: which screens show a question (blocked), work under way (working) or the idle prompt (R-0b-149).
//
// Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../third_party/herdr/NOTICE.
// Source: src/detect/manifests/claude.toml (rule set "2026.10.11.1", 17 rules; sha256 e8b816a70edc1b5f… in the evidence
// manifest), translated by hand from the pinned copy only, never from a fresh download.
//
// The data keeps each rule's herdr id, state, priority and region, and the patterns exactly as herdr wrote them (Rust regex
// syntax, as String.raw so no character changes). match.mjs translates each pattern once at load (toJsRegex) and refuses any
// it can't translate exactly, so a rule is never kept to fail silently.
//
// Loaded only from this file: no remote download, no hot reload, no override folder (herdr reads
// ~/.config/herdr/agent-detection/; we don't). Changing a rule is a commit, reviewed like code.
//
// LEFT OUT of the data, on purpose (R-0b-149):
//   - osc_progress_idle (region osc_progress): tmux capture-pane can't see the progress sequence, so nothing could feed it.
//   - osc_title_idle (region osc_title, "✳ " title): a title alone must never clear a session to idle (R-0b-153, L1062).
// So the data holds 15 of herdr's 17 rules. match.mjs refuses the osc_progress region, and refuses any title rule that
// would say idle.

/** herdr's rule-set version these rules were translated from. */
export const RULES_VERSION = '2026.10.11.1';
/** herdr commit the pinned copy came from. */
export const HERDR_COMMIT = 'ee5bfb5041bb3e4a49d591c72308aae3c81ecdde';
/** The two herdr rules not carried, with why (kept in data so a test can see each is named, not lost). */
export const LEFT_OUT = Object.freeze({
  osc_progress_idle: 'tmux capture-pane cannot see the OSC progress sequence (region osc_progress)',
  osc_title_idle: 'a title alone must never clear a session to idle (R-0b-153, L1062)',
});

const r = String.raw;

export const CLAUDE_RULES = Object.freeze([
  {
    id: 'osc_title_working', state: 'working', priority: 1100, region: 'osc_title', visible_working: true,
    // Braille covers <= 2.1.227; half-circles are the 2.1.228 busy spinner.
    regex: [r`^[\x{2800}-\x{28FF}\x{25D0}-\x{25D3}] `],
  },
  {
    id: 'live_turn_working', state: 'working', priority: 970, region: 'bottom_non_empty_lines(12)', visible_working: true,
    any: [
      { line_regex: [r`^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)`] },
      { line_regex: [r`^\s*[\x{002A}\x{00B7}\x{2722}\x{2733}\x{2736}\x{273B}\x{273D}]\s+\S.*…(?:\s+\(\d+[smh](?:\s|·)|\s*$)`] },
    ],
  },
  {
    id: 'background_agents_working', state: 'working', priority: 965, region: 'last_non_empty_above_prompt_box', visible_working: true,
    line_regex: [r`^\s*[\x{002A}\x{00B7}\x{2722}\x{2736}\x{273B}\x{273D}]\s+Waiting for [1-9]\d* background agents? to finish\s*$`],
  },
  {
    id: 'background_mcp_task_working', state: 'working', priority: 965, region: 'bottom_non_empty_lines(12)', visible_working: true,
    // Claude renders activity summaries at column zero; wrapped continuations are indented.
    // Keeping that shape prevents user prompt text from impersonating this signal.
    regex: [r`(?m)^[\x{002A}\x{00B7}\x{2722}\x{2736}\x{273B}\x{273D}][ \t]+\S[^\n]*?(?:\n[ \t]+[^\n]*?){0,3}·(?:[ \t]+|\n[ \t]*)[1-9]\d*(?:[ \t]+|\n[ \t]*)MCP(?:[ \t]+|\n[ \t]*)tasks?(?:[ \t]+|\n[ \t]*)still(?:[ \t]+|\n[ \t]*)running[ \t]*$`],
    not: [
      { contains: ['do you want to proceed?'] },
      { contains: ['esc to cancel'] },
      { contains: ['waiting for permission'] },
      { contains: ['do you want to allow this connection?'] },
      { contains: ['tab to amend'] },
      { contains: ['ctrl+e to explain'] },
    ],
  },
  {
    id: 'btw_overlay_working', state: 'working', priority: 975, region: 'bottom_non_empty_lines(5)', visible_working: true,
    line_regex: [r`^\s*/btw(?:\s|$)`, r`(?i)esc to close\s*$`],
  },
  {
    id: 'transcript_viewer', state: 'unknown', priority: 1000, region: 'bottom_non_empty_lines(3)', skip_state_update: true,
    contains: ['showing detailed transcript'],
    any: [
      { contains: ['ctrl+o', 'to toggle'] },
      { contains: ['ctrl+e', 'show all'] },
      { contains: ['ctrl+e', 'collapse'] },
      { contains: ['↑↓ scroll'] },
      { contains: ['? for shortcuts'] },
    ],
  },
  {
    id: 'live_blocked_form', state: 'blocked', priority: 980, region: 'after_last_horizontal_rule', visible_blocker: true,
    contains: ['esc to cancel'],
    any: [
      { contains: ['enter to confirm'] },
      {
        contains: ['enter to select'],
        any: [
          { contains: ['tab/arrow keys to navigate'] },
          { contains: ['arrow keys to navigate'] },
          { contains: ['arrows to navigate'] },
          { contains: ['↑/↓ to navigate'] },
          { contains: ['↑↓ to navigate'] },
        ],
      },
    ],
  },
  {
    id: 'live_blocked_form_named_session', state: 'blocked', priority: 980, region: 'whole_recent', visible_blocker: true,
    // Bind every control to the same footer, allowing wrapping between words.
    // After the name divider, accept only a counted task panel with marked rows
    // and optional pending overflow. Free-form activity can be newer output (#4573).
    regex: [r`(?i)(?:^|\n)[ \t]*enter\s+to\s+(?:confirm|select\s+·\s+(?:(?:tab/arrow|arrow)\s+keys|arrows|↑/↓|↑↓)\s+to\s+navigate)\s+·\s+esc\s+to\s+cancel[ \t]*\n(?:[ \t]*\n)*[ \t]*─{3,}[^\n]*(?:\n(?:[ \t]*\n)*[ \t]+\d+ tasks? \(\d+ done, (?:\d+ in progress, )?\d+ open\)(?:\n[ \t]+[◻◼✔][ \t]+[^\n]+)+(?:\n[ \t]+…[ \t]+\+\d+[ \t]+pending)?)?(?:\n[ \t]*)*\z`],
  },
  {
    id: 'dynamic_workflow_prompt', state: 'blocked', priority: 980, region: 'whole_recent', visible_blocker: true,
    contains: ['run a dynamic workflow?', 'esc to cancel'],
  },
  {
    id: 'mcp_elicitation_prompt', state: 'blocked', priority: 980, region: 'whole_recent', visible_blocker: true,
    // MCP elicitation dialogs (elicitation/create) show Accept/Decline controls
    // with an "Esc to cancel" footer but no Enter hint, so live_blocked_form
    // cannot see them (issue #3283). Gate on the invariant header line, the
    // Accept/Decline control line, and the cancel footer.
    contains: ['esc to cancel'],
    line_regex: [r`(?i)^\s*MCP server ["\x{201C}].+["\x{201D}] requests your input\s*$`],
    all: [
      {
        any: [
          { line_regex: [r`^\s*\x{276F}?\s*Accept\b`] },
          { line_regex: [r`^\s*\x{276F}?\s*Decline\b`] },
        ],
      },
    ],
  },
  {
    id: 'live_prompt_box', state: 'idle', priority: 950, region: 'prompt_box_body', visible_idle: true,
    line_regex: [r`^\s*❯`],
    not: [
      { contains: ['enter to select'] },
      { contains: ['esc to cancel'] },
      { contains: ['tab/arrow keys'] },
      { contains: ['arrow keys to navigate'] },
      { contains: ['↑/↓ to navigate'] },
    ],
  },
  {
    id: 'model_picker_menu', state: 'unknown', priority: 900, region: 'whole_recent', skip_state_update: true,
    contains: ['select model', 'enter to set as default', 'esc to cancel'],
    not: [
      { contains: ['do you want to proceed?'] },
      { contains: ['enter to select'] },
    ],
  },
  {
    id: 'bash_permission_prompt', state: 'blocked', priority: 850, region: 'whole_recent', visible_blocker: true,
    contains: ['do you want to proceed?'],
    any: [
      { contains: ['bash command'] },
      { contains: ['bash('] },
      { contains: ['contains expansion'] },
      { contains: ['tab to amend'] },
      { contains: ['ctrl+e to explain'] },
    ],
    // Claude marks the selected option with "❯", so every option branch has to allow
    // that prefix. Numbered branches that omit it only match options the cursor has
    // moved away from, which left the resting layout below unmatched here (#2650):
    //   ❯ 1. Yes / 2. Yes, and don't ask again for: <cmd> / 3. No
    // Cover both the two-option and "don't ask again" three-option shapes so this
    // rule, not the narrower generic_permission_prompt, claims Bash approvals.
    all: [
      {
        any: [
          { line_regex: [r`(?i)^\s*❯?\s*yes\b`] },
          { line_regex: [r`(?i)^\s*❯?\s*1\.\s*yes\b`] },
          { line_regex: [r`(?i)^\s*❯?\s*2\.\s*yes\b`] },
          { line_regex: [r`(?i)^\s*❯?\s*2\.\s*no\b`] },
          { line_regex: [r`(?i)^\s*❯?\s*3\.\s*no\b`] },
        ],
      },
    ],
  },
  {
    id: 'generic_permission_prompt', state: 'blocked', priority: 840, region: 'after_last_horizontal_rule', visible_blocker: true,
    contains: ['do you want to proceed?', 'esc to cancel'],
    all: [
      {
        any: [
          { line_regex: [r`(?i)^\s*❯?\s*1\.\s*yes\b`] },
          { line_regex: [r`(?i)^\s*2\.\s*yes\b`] },
          { line_regex: [r`(?i)^\s*2\.\s*no\b`] },
          { line_regex: [r`(?i)^\s*3\.\s*no\b`] },
        ],
      },
    ],
  },
  {
    id: 'legacy_no_prompt_blocker', state: 'blocked', priority: 300, region: 'whole_recent',
    any: [
      { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
      { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
      { contains: ['waiting for permission'] },
      { contains: ['do you want to allow this connection?'] },
      { contains: ['tab to amend'] },
      { contains: ['ctrl+e to explain'] },
      { contains: ['do you want to proceed?', 'esc to cancel'] },
      { contains: ['review your answers'] },
      { contains: ['skip interview and plan immediately'] },
    ],
    not: [
      { regex: [r`(?m)^\s*❯\s*$`] },
    ],
  },
]);
