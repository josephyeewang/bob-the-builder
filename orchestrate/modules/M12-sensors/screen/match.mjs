// The screen matcher: applies the Claude Code rules (claude-rules.mjs) to one screen reading (R-0b-151).
//
// Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../third_party/herdr/NOTICE.
// Source: src/detect/manifest.rs (validator limits 268-273, the rule loop 431-517, gates and regions 1142-1536), ported
// from Rust to JavaScript, the subset the Claude rules use. Pure functions, no I/O.
//
// Changes from herdr, all toward holding:
//   - no rule matched -> "unknown" (herdr falls back to idle for a known agent: DEFAULT_KNOWN_AGENT_IDLE_FALLBACK);
//   - the title (tmux #{pane_title}) feeds only osc_title, and a title rule may only say working, never idle (L1062);
//     the osc_progress region is not ported (tmux capture-pane can't see it), so a rule naming it is refused;
//   - the Codex-only regions (prompt markers, block markers) and top_non_empty_lines are not ported: refused;
//   - each Rust pattern is translated to an exact JavaScript equivalent (toJsRegex below), or refused, never approximated;
//   - a reading too large, or one whose matching runs past the time limit, reads "unknown";
//   - escape sequences left in the text are stripped before matching; rule ids must be unique.

import { CLAUDE_RULES } from './claude-rules.mjs';

/** herdr's validator limits (manifest.rs:268-273). */
export const LIMITS = Object.freeze({
  MAX_RULES: 128, MAX_GATE_DEPTH: 8, MAX_TOTAL_GATES: 512, MAX_MATCHERS_PER_GATE: 32, MAX_TOTAL_MATCHERS: 1024, MAX_MATCHER_CHARS: 512,
});
/** Ours: a reading whose matching takes longer than this reads unknown (hold). */
export const MATCH_BUDGET_MS = 100;
/** Ours: a reading bigger than a real pane can be reads unknown, before any rule runs. */
export const MAX_TEXT_CHARS = 200_000;
export const MAX_LINE_CHARS = 2_000;
export const MAX_TITLE_CHARS = 1_000;

export const STATES = Object.freeze(['idle', 'working', 'blocked', 'unknown']);
const RULE_KEYS = new Set(['id', 'state', 'priority', 'region', 'visible_idle', 'visible_blocker', 'visible_working', 'skip_state_update', 'all', 'any', 'not', 'contains', 'regex', 'line_regex']);
const GATE_KEYS = new Set(['all', 'any', 'not', 'contains', 'regex', 'line_regex']);
const FIXED_REGIONS = new Set(['whole_recent', 'prompt_box_body', 'above_prompt_box', 'last_non_empty_above_prompt_box', 'after_last_horizontal_rule', 'osc_title']);

// ── Rust regex -> JavaScript regex, exact or refused ──
//
// Rust's regex crate is Unicode-aware by default; JavaScript's classes are not, so each class escape is spelled out:
//   \d -> \p{Nd}; \s -> \p{White_Space} (JS \s adds U+FEFF and lacks U+0085); \w -> Rust's word set; \b -> a boundary
//   on that set (JS \b is ASCII); . -> [^\n] (JS . also stops at \r, U+2028, U+2029); \x{H} -> \u{H}; \z -> end of text;
//   ^ and $ under (?m) -> start/end of a \n-separated line (JS m also splits at \r, U+2028, U+2029).
// Leading (?i) and (?m) flags are taken; flags anywhere else, \A, \B, \Z, \p, named groups, nested classes and class
// set operations are refused. The JS regex always has the u flag (and i when asked), never m or s.
const WORD = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}`;
const PASS_ESCAPES = new Set(['t', 'n', 'r', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '/', '-']);

export class PatternRefused extends Error {}

export function toJsRegex(pattern) {
  if (typeof pattern !== 'string') throw new PatternRefused('a pattern must be a string');
  let p = pattern;
  let caseless = false;
  let multiline = false;
  const lead = /^\(\?([a-z]+)\)/.exec(p);
  if (lead) {
    for (const f of lead[1]) {
      if (f === 'i') caseless = true;
      else if (f === 'm') multiline = true;
      else throw new PatternRefused(`flag ${f} is not translated`);
    }
    p = p.slice(lead[0].length);
  }
  let out = '';
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      const n = p[i + 1];
      if (n === undefined) throw new PatternRefused('a pattern ends in a lone backslash');
      if (n === 'x') {
        const m = /^\\x\{([0-9A-Fa-f]{1,6})\}/.exec(p.slice(i));
        if (!m) throw new PatternRefused('only \\x{…} hex escapes are translated');
        out += `\\u{${m[1]}}`;
        i += m[0].length - 1;
        continue;
      }
      i++;
      if (n === 'd') { out += String.raw`\p{Nd}`; continue; }
      if (n === 's') { out += String.raw`\p{White_Space}`; continue; }
      if (n === 'w') { out += inClass ? WORD : `[${WORD}]`; continue; }
      if (!inClass && n === 'S') { out += String.raw`\P{White_Space}`; continue; }
      if (!inClass && n === 'D') { out += String.raw`\P{Nd}`; continue; }
      if (!inClass && n === 'W') { out += `[^${WORD}]`; continue; }
      if (!inClass && n === 'b') { out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`; continue; }
      if (!inClass && n === 'z') { out += String.raw`(?![\s\S])`; continue; }
      if (PASS_ESCAPES.has(n) && !(n === '-' && !inClass)) { out += `\\${n}`; continue; }
      throw new PatternRefused(`escape \\${n} is not translated`);
    }
    if (inClass) {
      if (c === '[') throw new PatternRefused('a nested class is not translated');
      if ((c === '&' || c === '~' || c === '-') && p[i + 1] === c) throw new PatternRefused('class set operations are not translated');
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      if (p[i + 1] === '^') { out += '^'; i++; }
      if (p[i + 1] === ']') { out += String.raw`\]`; i++; } // Rust: a leading ] is a literal
      continue;
    }
    if (c === '(' && p[i + 1] === '?') {
      const rest = p.slice(i + 2);
      if (rest.startsWith(':')) { out += '(?:'; i += 2; continue; }
      throw new PatternRefused('only (?:…) groups are translated');
    }
    if (c === '.') { out += String.raw`[^\n]`; continue; }
    if (c === '^') { out += multiline ? String.raw`(?<![^\n])` : String.raw`(?<![\s\S])`; continue; }
    if (c === '$') { out += multiline ? String.raw`(?![^\n])` : String.raw`(?![\s\S])`; continue; }
    out += c;
  }
  if (inClass) throw new PatternRefused('an unclosed class');
  try {
    return new RegExp(out, caseless ? 'iu' : 'u');
  } catch (e) {
    throw new PatternRefused(`not a valid pattern: ${e.message}`);
  }
}

// ── Validation and compiling (manifest.rs validate_manifest, validate_gate, compile_gate) ──

export class RulesRefused extends Error {}

function regionOk(spec) {
  const t = typeof spec === 'string' ? spec.trim() : '';
  if (FIXED_REGIONS.has(t)) return true;
  return regionCount(t, 'bottom_lines') !== null || regionCount(t, 'bottom_non_empty_lines') !== null;
}

function regionCount(spec, name) {
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(')')) return null;
  const n = spec.slice(name.length + 1, -1);
  if (!/^\d+$/.test(n)) return null; // Rust's usize parse also takes a leading +; ours doesn't
  const v = Number(n);
  return Number.isSafeInteger(v) ? v : null;
}

const hasPositive = (g) => !!(g.contains?.length || g.regex?.length || g.line_regex?.length || g.all?.length || g.any?.length);
const hasAny = (g) => hasPositive(g) || !!g.not?.length;

function checkKeys(obj, allowed, ctx) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new RulesRefused(`${ctx} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new RulesRefused(`${ctx} has an unknown field ${k}`);
  for (const k of ['all', 'any', 'not', 'contains', 'regex', 'line_regex']) {
    if (obj[k] !== undefined && !Array.isArray(obj[k])) throw new RulesRefused(`${ctx}: ${k} must be a list`);
  }
  for (const k of ['contains', 'regex', 'line_regex']) {
    for (const v of obj[k] ?? []) if (typeof v !== 'string') throw new RulesRefused(`${ctx}: ${k} holds a non-string`);
  }
}

function compileGate(g, ctx, depth, tally, negated) {
  if (depth > LIMITS.MAX_GATE_DEPTH) throw new RulesRefused(`${ctx} exceeds max gate depth ${LIMITS.MAX_GATE_DEPTH}`);
  if (++tally.gates > LIMITS.MAX_TOTAL_GATES) throw new RulesRefused(`rules exceed max gate count ${LIMITS.MAX_TOTAL_GATES}`);
  const count = (g.contains?.length ?? 0) + (g.regex?.length ?? 0) + (g.line_regex?.length ?? 0);
  if (count > LIMITS.MAX_MATCHERS_PER_GATE) throw new RulesRefused(`${ctx} has ${count} direct matchers, max is ${LIMITS.MAX_MATCHERS_PER_GATE}`);
  tally.matchers += count;
  if (tally.matchers > LIMITS.MAX_TOTAL_MATCHERS) throw new RulesRefused(`rules exceed max matcher count ${LIMITS.MAX_TOTAL_MATCHERS}`);
  for (const v of [...(g.contains ?? []), ...(g.regex ?? []), ...(g.line_regex ?? [])]) {
    if ([...v].length > LIMITS.MAX_MATCHER_CHARS) throw new RulesRefused(`${ctx} matcher exceeds max length ${LIMITS.MAX_MATCHER_CHARS}`);
  }
  if (negated ? !hasAny(g) : !hasPositive(g)) throw new RulesRefused(negated ? 'not gate must contain a matcher' : `${ctx} must contain a positive matcher`);
  const re = (list, field) => (list ?? []).map((pat) => {
    try { return toJsRegex(pat); } catch (e) { throw new RulesRefused(`${ctx} contains an invalid ${field} pattern ${JSON.stringify(pat)}: ${e.message}`); }
  });
  const sub = (list, label, neg) => (list ?? []).map((n) => {
    checkKeys(n, GATE_KEYS, label);
    return compileGate(n, label, depth + 1, tally, neg);
  });
  for (const n of g.not ?? []) if (n && typeof n === 'object' && !hasAny(n)) throw new RulesRefused(`${ctx} contains an empty not gate`);
  return {
    contains: (g.contains ?? []).map((s) => s.toLowerCase()),
    regex: re(g.regex, 'regex'),
    line_regex: re(g.line_regex, 'line_regex'),
    all: sub(g.all, negated ? 'not all gate' : 'all gate', false),
    any: sub(g.any, negated ? 'not any gate' : 'any gate', false),
    not: sub(g.not, 'not gate', true),
  };
}

/** Checks and compiles a rule list. Throws RulesRefused on anything herdr's validator (or ours) refuses. */
export function compileRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new RulesRefused('the rules must contain at least one rule');
  if (rules.length > LIMITS.MAX_RULES) throw new RulesRefused(`the rules contain ${rules.length} rules, max is ${LIMITS.MAX_RULES}`);
  const tally = { gates: 0, matchers: 0 };
  const seen = new Set();
  return Object.freeze(rules.map((rule) => {
    checkKeys(rule, RULE_KEYS, 'rule');
    const id = typeof rule.id === 'string' ? rule.id.trim() : '';
    if (!id) throw new RulesRefused('rule id must not be empty');
    if (seen.has(id)) throw new RulesRefused(`rule id ${id} is used twice`);
    seen.add(id);
    const state = rule.state ?? 'unknown';
    if (!STATES.includes(state)) throw new RulesRefused(`rule ${id} has an unknown state ${state}`);
    const priority = rule.priority ?? 0;
    if (!Number.isInteger(priority)) throw new RulesRefused(`rule ${id} has a priority that is not a whole number`);
    for (const k of ['visible_idle', 'visible_blocker', 'visible_working', 'skip_state_update']) {
      if (rule[k] !== undefined && typeof rule[k] !== 'boolean') throw new RulesRefused(`rule ${id}: ${k} must be true or false`);
    }
    if (rule.skip_state_update) {
      if (state !== 'unknown') throw new RulesRefused(`rule ${id} uses skip_state_update without state = "unknown"`);
      if (rule.visible_idle || rule.visible_blocker || rule.visible_working) throw new RulesRefused(`rule ${id} uses skip_state_update with visible state evidence`);
    }
    const region = (rule.region ?? 'whole_recent').trim();
    if (!regionOk(region)) throw new RulesRefused(`rule ${id} uses an invalid or unported region: ${region}`);
    if (region === 'osc_title' && state !== 'working') throw new RulesRefused(`rule ${id}: a title rule may only say working`);
    let gate;
    try {
      gate = compileGate(rule, 'rule', 0, tally, false);
    } catch (e) {
      throw e instanceof RulesRefused ? new RulesRefused(`rule ${id} has invalid matcher gates: ${e.message}`) : e;
    }
    return Object.freeze({ id, state, priority, region, skip: rule.skip_state_update === true, gate });
  }));
}

// ── Regions (manifest.rs:1276-1536), on Rust's str::lines() ──

/** Rust's str::lines(): split at \n, drop one trailing \r per line, no last empty line after a final \n. */
export function rustLines(s) {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const lineStart = (content, lines, index) => Math.min(lines.slice(0, Math.min(index, lines.length)).reduce((a, l) => a + l.length + 1, 0), content.length);
const sliceFrom = (content, lines, index) => content.slice(lineStart(content, lines, index));

/** Rust's char::is_whitespace / str::trim set (Unicode White_Space). */
const rustTrim = (s) => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

export function isHorizontalRule(line) {
  const t = rustTrim(line);
  if (t === '') return false;
  let n = 0;
  for (const ch of t) { if (ch === '─') n++; else break; }
  if (n === 0) return false;
  const suffix = t.slice(n).replace(/^\p{White_Space}+/u, ''); // '─' is one UTF-16 unit
  return suffix === '' || n >= 3;
}

function promptBoxTop(lines) {
  let borders = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isHorizontalRule(lines[i]) && ++borders === 2) return i;
  }
  return null;
}

function bottomLines(content, count) {
  const lines = rustLines(content);
  return sliceFrom(content, lines, Math.max(0, lines.length - count));
}

function bottomNonEmptyLines(content, count) {
  const lines = rustLines(content);
  let start = null;
  let taken = 0;
  for (let i = lines.length - 1; i >= 0 && taken < count; i--) {
    if (rustTrim(lines[i]) !== '') { start = i; taken++; }
  }
  return start === null ? '' : sliceFrom(content, lines, start);
}

function promptBoxBody(content) {
  const lines = rustLines(content);
  const top = promptBoxTop(lines);
  if (top === null) return '';
  const start = lineStart(content, lines, top + 1);
  let endIndex = lines.length;
  for (let i = top + 1; i < lines.length; i++) if (isHorizontalRule(lines[i])) { endIndex = i; break; }
  return content.slice(Math.min(start, content.length), Math.min(lineStart(content, lines, endIndex), content.length));
}

function abovePromptBox(content) {
  const lines = rustLines(content);
  const top = promptBoxTop(lines);
  return top === null ? content : content.slice(0, lineStart(content, lines, top));
}

function afterLastHorizontalRule(content) {
  let end = 0;
  let offset = 0;
  for (const line of rustLines(content)) {
    const next = offset + line.length + 1;
    if (isHorizontalRule(line)) end = Math.min(next, content.length);
    offset = next;
  }
  return content.slice(end);
}

function lastNonEmptyLine(content) {
  const lines = rustLines(content);
  for (let i = lines.length - 1; i >= 0; i--) if (rustTrim(lines[i]) !== '') return lines[i];
  return '';
}

/** The text a region names, from one reading's screen text and title. An unported region gives ''. */
export function region({ text = '', title = '' } = {}, spec) {
  const t = String(spec).trim();
  if (t === 'osc_title') return title;
  switch (t) {
    case 'whole_recent': return text;
    case 'prompt_box_body': return promptBoxBody(text);
    case 'above_prompt_box': return abovePromptBox(text);
    case 'last_non_empty_above_prompt_box': return lastNonEmptyLine(abovePromptBox(text));
    case 'after_last_horizontal_rule': return afterLastHorizontalRule(text);
    default: {
      const b = regionCount(t, 'bottom_lines');
      if (b !== null) return bottomLines(text, b);
      const n = regionCount(t, 'bottom_non_empty_lines');
      if (n !== null) return bottomNonEmptyLines(text, n);
      return '';
    }
  }
}

// ── Matching (manifest.rs compiled_gate_matches, evaluate_loaded_manifest) ──

function gateMatches(g, text, lower, lines) {
  if (!g.contains.every((needle) => lower.includes(needle))) return false;
  if (!g.regex.every((re) => re.test(text))) return false;
  if (!g.line_regex.every((re) => lines.some((l) => re.test(l)))) return false;
  if (!g.all.every((n) => gateMatches(n, text, lower, lines))) return false;
  if (g.any.length && !g.any.some((n) => gateMatches(n, text, lower, lines))) return false;
  if (g.not.some((n) => gateMatches(n, text, lower, lines))) return false;
  return true;
}

/** Does one compiled rule match this region text? */
export function ruleMatches(rule, regionText) {
  return gateMatches(rule.gate, regionText, regionText.toLowerCase(), rustLines(regionText));
}

/**
 * Plain text for matching: escape sequences (CSI, OSC, DCS/APC/PM/SOS strings, two-byte ESC forms) removed, CR LF made LF,
 * and any other control character but tab and newline dropped. A capture made without -e has none; this is the backstop.
 */
export function plainText(s) {
  return String(s)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '');
}

const unknown = (why, rule = null) => ({ state: 'unknown', rule, why });

/**
 * Reads one screen. reading = { text, title, at }. → { state: blocked | working | idle | unknown, rule, why? }.
 * No rule matched, a reading too big, or matching past the time limit -> unknown (hold), never idle.
 * Rules are tried in order; the highest priority match wins, the earlier rule on a tie (as herdr).
 */
export function matchScreen(reading, { rules = defaultRules(), clock = () => performance.now(), budgetMs = MATCH_BUDGET_MS } = {}) {
  if (!reading || typeof reading !== 'object' || typeof reading.text !== 'string') return unknown('no reading');
  const title = typeof reading.title === 'string' ? reading.title : '';
  if (reading.text.length > MAX_TEXT_CHARS || title.length > MAX_TITLE_CHARS) return unknown('reading too large');
  const text = plainText(reading.text);
  if (rustLines(text).some((l) => l.length > MAX_LINE_CHARS)) return unknown('a line too long');
  const input = { text, title: plainText(title) };
  const started = clock();
  let best = null;
  for (const rule of rules) {
    if (ruleMatches(rule, region(input, rule.region)) && (best === null || rule.priority > best.priority)) best = rule;
    if (clock() - started > budgetMs) return unknown('matching ran past its time limit');
  }
  if (best === null) return unknown('no rule matched');
  if (best.skip) return { state: 'unknown', rule: best.id, why: 'an overlay rule (skip_state_update)' };
  return { state: best.state, rule: best.id };
}

let compiledDefault = null;
/** The Claude rules (claude-rules.mjs), compiled once. */
export function defaultRules() {
  if (!compiledDefault) compiledDefault = compileRules(CLAUDE_RULES);
  return compiledDefault;
}
