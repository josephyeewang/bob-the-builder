// fixtures.mjs — builds Front Door conversation logs in the shape Claude Code writes them (see transcript.mjs),
// so the tests never need a real log. Times are minutes after a fixed start.

export const T0 = Date.parse('2026-11-03T09:00:00Z');
export const iso = (min) => new Date(T0 + min * 60e3).toISOString();
let n = 0;
const uuid = () => `u-${++n}`;

export const typed = (min, text) => ({ type: 'user', uuid: uuid(), timestamp: iso(min), message: { role: 'user', content: text } });
export const said = (min, text, stop = 'end_turn') => ({ type: 'assistant', uuid: uuid(), timestamp: iso(min),
  message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
export const asks = (min, id, question = 'Which one?') => ({ type: 'assistant', uuid: uuid(), timestamp: iso(min),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question }] } }] } });
export const tool = (min, id, name = 'Read') => ({ type: 'assistant', uuid: uuid(), timestamp: iso(min),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: {} }] } });
export const result = (min, id, content, isError = false) => ({ type: 'user', uuid: uuid(), timestamp: iso(min),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
export const meta = (min, text) => ({ ...typed(min, text), isMeta: true });
export const toLog = (entries) => entries.map((e) => JSON.stringify(e)).join('\n');
