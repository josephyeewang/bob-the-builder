// transcript.mjs — reads the Front Door's own conversation log (one JSON object per line, as Claude Code writes it)
// and answers the questions R-0b-82 and R-0b-84 ask of it (review-0b-8 MAT-2, MAT-11).
//
// Terms, as the binding review defines them:
//   the owner's turn  a message the owner typed or spoke, or their answer to a question box. Lines the Dispatcher types
//                    (sendSafe always prefixes them "[watchdog]"), relays and system-injected entries are not theirs.
//   question box     an AskUserQuestion tool call in this log. It is answered only by a tool result carrying the same
//                    call ID; a typed line saying "yes" is not an answer to it. Open asks in the record don't count.
//   turn finished    the last conversation entry is the assistant's, and every tool call it made has a result.
//
// Log format as Claude Code wrote it on 29 Oct 2026 (CLI 2.1.309): entries {type: 'user'|'assistant', uuid,
// timestamp, isMeta?, isSidechain?, message: {content: string | blocks}}, blocks {type: 'text'|'image'|'document'|
// 'tool_use'|'tool_result'}. A message the owner types while a turn runs may be logged only as {type: 'attachment',
// attachment: {type: 'queued_command', prompt, timestamp?, origin: {kind: 'human'|'task-notification'|'peer'…}}}
// (0b-8 audit round 2 M-1). Principle 9: a format note; re-check on a CLI upgrade, the tests' fixtures follow it.

export const QUESTION_TOOL = 'AskUserQuestion';
export const AUTOMATED_PREFIXES = Object.freeze(['[watchdog]', '[relay]', '[dispatcher]']);
// Text Claude Code itself injects as a "user" entry: command output and notices, never the owner typing.
const INJECTED = /^\s*<(local-command-stdout|local-command-stderr|task-notification|system-reminder|bash-stdout|bash-stderr|cross-session-message|artifact-content-authored-by-others)\b/;
export const INTERRUPTED = /^\s*\[Request interrupted by user/;

export function parseLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch { /* a torn last line */ }
  }
  return out;
}

const blocks = (e) => {
  const c = e?.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
};
const isTurn = (e) => (e?.type === 'user' || e?.type === 'assistant') && !e.isMeta && !e.isCompactSummary && !e.isSidechain;
// A message the owner queued while a turn ran (M-1). It counts unless it is plainly not theirs: a notice, another session's
// message, or a meta entry. An origin missing or of a kind not listed counts (0b-8 audit round 3 M-1: queued entries
// with no origin exist); counting one wrongly only delays a restart. An image or other block counts as "[image]".
const NOT_OWNER_ORIGINS = new Set(['task-notification', 'peer', 'cross-session', 'system', 'hook']);
const queued = (e) => {
  const a = e?.type === 'attachment' ? e.attachment : null;
  if (!a || a.type !== 'queued_command' || e.isSidechain || e.isMeta || a.isMeta) return null;
  if (a.origin && NOT_OWNER_ORIGINS.has(a.origin.kind)) return null;
  if (a.commandMode && a.commandMode !== 'prompt') return null;
  const text = typeof a.prompt === 'string' ? a.prompt
    : blocks({ message: { content: a.prompt } }).map((b) => (b.type === 'text' ? String(b.text ?? '') : `[${String(b.type).replace(/[^a-z_]/g, '')}]`)).join('\n');
  return { text, at: Number.isFinite(Date.parse(a.timestamp)) ? Date.parse(a.timestamp) : at(e) };
};
// Drop repeated entries (the same uuid twice), keeping the first (round 2 minor 4).
const unique = (entries) => { const seen = new Set(); return entries.filter((e) => !e?.uuid || (seen.has(e.uuid) ? false : seen.add(e.uuid))); };
const at = (e) => { const t = Date.parse(e?.timestamp); return Number.isFinite(t) ? t : null; };
export const textOf = (e) => blocks(e).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');

export function isAutomated(text) {
  const s = String(text).trimStart().toLowerCase();
  return AUTOMATED_PREFIXES.some((p) => s.startsWith(p));
}

// Every question box in the log, each with its answer (the tool result with the same ID) or null.
export function questionBoxes(entries) {
  const boxes = new Map();
  for (const e of unique(entries)) {
    if (!isTurn(e)) continue;
    for (const b of blocks(e)) {
      if (e.type === 'assistant' && b.type === 'tool_use' && b.name === QUESTION_TOOL && b.id && !boxes.has(b.id)) {
        boxes.set(b.id, { callId: b.id, askedAt: at(e), askedEntry: e.uuid ?? null, answer: null });
      }
      if (e.type === 'user' && b.type === 'tool_result' && boxes.has(b.tool_use_id) && !boxes.get(b.tool_use_id).answer) {
        boxes.get(b.tool_use_id).answer = { at: at(e), entry: e.uuid ?? null, isError: b.is_error === true, automated: answerAutomated(e, b) };
      }
    }
  }
  return [...boxes.values()];
}

// The answer itself: the log's structured answers when present (the result text repeats the question, so a question
// mentioning "[watchdog]" would otherwise hide the owner's real answer; 0b-8 audit round 3 minor 1), else the result text.
const answerValues = (e, b) => {
  const a = e?.toolUseResult?.answers;
  return a && typeof a === 'object' && !Array.isArray(a) ? Object.values(a).map((v) => String(v)) : null;
};
const answerAutomated = (e, b) => {
  const v = answerValues(e, b);
  return v ? v.some((x) => isAutomated(x)) : AUTOMATED_PREFIXES.some((p) => resultText(b).toLowerCase().includes(p));
};
const resultText = (b) => (typeof b.content === 'string' ? b.content : blocks({ message: { content: b.content } }).map((x) => x.text ?? '').join(' '));

// The owner's turns, oldest first: { at, kind: 'typed'|'answer'|'declined', text, index }. Anything the owner might have done counts
// (0b-8 audit round 1, M-1): an image with no text, a question box they declined or interrupted (its result is an error;
// counting a tool failure too only delays a restart), and their text after an injected block in the same entry.
// A box answer holding an automated prefix ("[watchdog]…") is typed keys landing in the box, not the owner (M-7): not theirs.
// A message queued while a turn ran counts (M-1); so does any block they sent that isn't a tool's result (a PDF too).
export function ownerTurns(entries) {
  const boxIds = new Set(questionBoxes(entries).map((q) => q.callId));
  const out = [];
  const seen = new Set();
  entries.forEach((e, index) => {
    if (e?.uuid) { if (seen.has(e.uuid)) return; seen.add(e.uuid); }
    const q = queued(e);
    if (q) { if (q.text.trim() && !isAutomated(q.text) && !INJECTED.test(q.text)) out.push({ at: q.at, kind: 'typed', text: q.text, index }); return; }
    if (!isTurn(e) || e.type !== 'user') return;
    const bs = blocks(e);
    const answers = bs.filter((b) => b.type === 'tool_result' && boxIds.has(b.tool_use_id));
    if (answers.length) {
      const text = answers.map(resultText).join('\n');
      if (answers.some((b) => answerAutomated(e, b))) return;
      out.push({ at: at(e), kind: answers.every((b) => b.is_error === true) ? 'declined' : 'answer', text, index });
      return;
    }
    if (bs.some((b) => b.type === 'tool_result')) return; // a tool's own result
    const own = bs.filter((b) => (b.type === 'text' ? String(b.text ?? '').trim() && !INJECTED.test(String(b.text)) : b.type !== 'tool_use'));
    if (!own.length) return;
    const first = own.find((b) => b.type === 'text');
    if (first && isAutomated(first.text)) return;
    const text = own.map((b) => (b.type === 'text' ? String(b.text) : `[${String(b.type).replace(/[^a-z_]/g, '')}]`)).join('\n');
    out.push({ at: at(e), kind: 'typed', text, index });
  });
  return out;
}

// The assistant's reply to each of the owner's turns: the assistant text between it and the owner's next turn.
export function ownerTurnsWithReplies(entries) {
  const turns = ownerTurns(entries);
  return turns.map((t, i) => {
    const end = i + 1 < turns.length ? turns[i + 1].index : entries.length;
    const reply = entries.slice(t.index + 1, end).filter((e) => isTurn(e) && e.type === 'assistant').map(textOf).filter((s) => s.trim()).join('\n');
    return { ...t, reply };
  });
}

export function lastTurnFinished(entries) {
  const turns = entries.filter(isTurn);
  const last = turns.at(-1);
  // The owner pressing Esc ends the turn: Claude Code logs the interrupt line and runs nothing more (round 2 minor 3).
  if (last?.type === 'user' && INTERRUPTED.test(textOf(last))) return true;
  if (!last || last.type !== 'assistant') return false;
  if (last.message?.stop_reason === 'tool_use') return false;
  const results = new Set();
  for (const e of turns) for (const b of blocks(e)) if (b.type === 'tool_result') results.add(b.tool_use_id);
  return turns.every((e) => e.type !== 'assistant' || blocks(e).every((b) => b.type !== 'tool_use' || results.has(b.id)));
}

export const openQuestions = (entries) => questionBoxes(entries).filter((q) => !q.answer);

// R-0b-84's checker: at least `expect` question boxes, each answered by a tool result carrying its own call ID.
export function checkTapTest(entries, { expect = 3 } = {}) {
  const boxes = questionBoxes(entries);
  const answered = boxes.filter((q) => q.answer && !q.answer.isError && !q.answer.automated);
  const problems = [];
  if (boxes.length < expect) problems.push(`only ${boxes.length} question boxes in the log, ${expect} expected`);
  for (const q of boxes) if (!q.answer) problems.push(`question box ${q.callId} has no answer with its ID`);
  for (const q of boxes) if (q.answer?.isError) problems.push(`question box ${q.callId} ended in an error, not an answer`);
  for (const q of boxes) if (q.answer?.automated) problems.push(`question box ${q.callId} was answered by typed automated text, not a tap`);
  return { ok: problems.length === 0 && answered.length >= expect, boxes: answered.map((q) => ({ callId: q.callId, askedAt: q.askedAt, answeredAt: q.answer.at, answerEntry: q.answer.entry })), problems };
}
