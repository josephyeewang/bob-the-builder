// Claude Code hook event -> activity signal.
//
// Ported from Orchestrator.inc @1e478c5 (Apache-2.0), modified: see
// ../third_party/orchestrator-inc/NOTICE. Source: backend/internal/adapters/agent/claudecode/activity.go.
//
// `event` is our hook sub-command name ("user-prompt-submit", "notification", ...), not the
// native Claude event name. Returns null when the event carries no activity meaning, in which
// case nothing is reported.

import { State } from './activity.mjs';

export function deriveActivityState(event, payload = {}) {
  switch (event) {
    case 'user-prompt-submit':
      return State.ACTIVE;
    case 'pre-tool-use':
    case 'post-tool-use':
    case 'post-tool-use-failure':
      // Active, but applied under the tool-flight rule: these never lift a paused state except
      // the post of the exact tool whose permission dialog blocked the session.
      return State.ACTIVE;
    case 'permission-request':
      // Fires when the dialog appears and names the tool, which the tracker snapshots.
      return State.BLOCKED;
    case 'stop':
    case 'stop-failure': // an API error ended the turn; the agent is back at its prompt
      return State.IDLE;
    case 'notification':
      switch (payload?.notification_type) {
        case 'idle_prompt':
        case 'agent_completed':
          return State.IDLE;
        case 'agent_needs_input':
          // No tool to correlate, so not blocked: a block could then lift only at a turn boundary.
          return State.WAITING_INPUT;
        case 'permission_prompt':
          return State.BLOCKED; // a stray Enter could answer the dialog
        default:
          return null;
      }
    case 'session-end':
      // clear and resume keep the session going in the same copy.
      return payload?.reason === 'clear' || payload?.reason === 'resume' ? null : State.EXITED;
    default:
      return null;
  }
}

// Builds the signal the tracker takes from one hook call. Malformed payloads mean "no signal".
//
// Ours: an open AskUserQuestion is the session waiting on the person (review 0b-3 M3), so its
// pre-tool-use reads waiting_input and its post (the answer) is its own event that may end
// that wait. Neither is a tool event, so neither is folded into the tool-flight rule.
export const ASK_TOOL = 'AskUserQuestion';
export function signalFromHook(event, payload = {}, at, launchId) {
  let state = deriveActivityState(event, payload);
  if (!state) return null;
  const isAsk = payload?.tool_name === ASK_TOOL;
  if (isAsk && event === 'pre-tool-use') { state = State.WAITING_INPUT; event = 'ask-user-question-open'; }
  else if (isAsk && (event === 'post-tool-use' || event === 'post-tool-use-failure')) event = 'ask-user-question-answered';
  return {
    valid: true,
    state,
    event,
    ...(event === 'ask-user-question-open' ? { reason: 'question' } : {}),
    toolName: typeof payload?.tool_name === 'string' ? payload.tool_name : '',
    toolUseId: typeof payload?.tool_use_id === 'string' ? payload.tool_use_id : '',
    prompt: typeof payload?.prompt === 'string' ? payload.prompt : undefined,
    at,
    ...(typeof launchId === 'string' && launchId ? { launchId } : {}),
  };
}
