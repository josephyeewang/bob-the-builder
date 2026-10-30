// A session's size, compactions and turn state, read from its conversation file (R-0b-62, R-0b-64,
// R-0b-63; design v4 §5.5; review 0b-6 M7, M17, M18, M19).
//
// Capability note (Principle 9): the line shapes below (type, isSidechain, message.usage,
// stop_reason, tool_use / tool_result, system compact_boundary, isCompactSummary, the synthetic
// model name) are CHECKED AGAINST NOTHING YET. They are the shapes the review names, to be proven
// on the pinned Claude Code (live proof: 5 sessions within 2% of /context). Void at the next pin.
// The folder these files live in is config, never a fixed machine path.

import { readFileSync } from 'node:fs';

export const CHECKED_AGAINST = null; // the pinned Claude Code version, once the live proof runs

/** One entry per readable line; a broken line (a half-written last line) is skipped. */
export function parseTranscript(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch { /* half-written */ }
  }
  return out;
}

const isBoundary = (e) => e.type === 'system' && e.subtype === 'compact_boundary';
const mainChain = (e) => e.isSidechain !== true;
const synthetic = (e) => e.message?.model === '<synthetic>' || e.isCompactSummary === true || e.isApiErrorMessage === true;
const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

/**
 * { tokens, compactions, turnEnded, openTools }:
 * - tokens: the last main-chain, non-synthetic assistant entry after the last compaction boundary,
 *   input + cache creation + cache read (output excluded; never a sum over messages). Null if none.
 * - compactions: the number of compaction boundaries.
 * - openTools: tool_use ids on the main chain with no tool_result yet.
 * - turnEnded: the last main-chain entry is an assistant message that ended its turn with no open tool.
 */
export function readSize(entries) {
  let last = -1;
  let compactions = 0;
  entries.forEach((e, i) => { if (isBoundary(e)) { compactions += 1; last = i; } });
  let tokens = null;
  for (let i = entries.length - 1; i > last; i--) {
    const e = entries[i];
    if (e.type !== 'assistant' || !mainChain(e) || synthetic(e)) continue;
    const u = e.message?.usage;
    if (!u) continue;
    tokens = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    break;
  }
  const open = new Set();
  for (const e of entries) {
    if (!mainChain(e) || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (e.type === 'assistant' && c?.type === 'tool_use' && c.id) open.add(c.id);
      if (e.type === 'user' && c?.type === 'tool_result' && c.tool_use_id) open.delete(c.tool_use_id);
    }
  }
  const tail = [...entries].reverse().find((e) => mainChain(e) && (e.type === 'assistant' || e.type === 'user'));
  const turnEnded = !!tail && tail.type === 'assistant' && tail.message?.stop_reason === 'end_turn' && open.size === 0;
  return { tokens, compactions, turnEnded, openTools: [...open] };
}

/** Reads a transcript file; a missing or unreadable file gives null (the caller treats it as unknown). */
export function readTranscriptFile(path, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  try { return readSize(parseTranscript(read(path))); } catch { return null; }
}

/**
 * The safe point (M7). A worker is at one when no tool call is in progress: the transcript has no
 * open tool_use and the activity tracker (send-safe/activity.mjs) does not show a tool running.
 * The Lead and the Front Door are at one when their turn has ended and they are not waiting on an
 * answer (the tracker's needs-input states, which sendSafe also refuses on).
 */
export function atSafePoint({ role, size, activity }) {
  if (!size) return false;
  const state = activity?.state;
  if (state === 'exited') return true;
  if (role === 'worker' || role === 'writer' || role === 'reviewer' || role === 'auditor' || role === 'scout') {
    return size.openTools.length === 0 && state !== 'blocked';
  }
  return size.turnEnded && state !== 'waiting_input' && state !== 'blocked' && state !== 'active';
}
