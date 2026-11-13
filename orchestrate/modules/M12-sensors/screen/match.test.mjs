// The matcher's tests (R-0b-152, engine half): herdr's own rule tests rewritten into Node, the Rust-to-JavaScript pattern
// translation, the Claude rules on hand-made screens, and the holds (no match, too big, too slow -> unknown).
//
// Partly ported from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../third_party/herdr/NOTICE.
// Source: src/detect/manifest/tests.rs. Where herdr expects its idle fallback for a screen no rule matches, ours
// expects "unknown". The remote, override and reload tests are not ported (we load only the installed file).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileRules, matchScreen, region, toJsRegex, PatternRefused, RulesRefused, LIMITS, defaultRules, plainText,
  isHorizontalRule, rustLines, MAX_TEXT_CHARS, MAX_LINE_CHARS,
} from './match.mjs';
import { CLAUDE_RULES, LEFT_OUT, RULES_VERSION } from './claude-rules.mjs';

const explain = (rules, text, title = '') => matchScreen({ text, title }, { rules: compileRules(rules) });
const stateOf = (rules, text, title) => explain(rules, text, title).state;
const refused = (rules) => assert.throws(() => compileRules(rules), RulesRefused);

// ── herdr: known_agent_no_match_defaults_to_idle_fallback, changed: ours holds ──

test('a screen no rule matches reads unknown, never idle', () => {
  const r = explain([{ id: 'test', state: 'working', contains: ['active-marker'] }], 'unmatched-marker');
  assert.equal(r.state, 'unknown');
  assert.equal(r.rule, null);
});

// ── herdr: rule_semantics_apply_gates_priority_and_line_regex ──

test('gates, priority and line_regex', () => {
  const rules = [
    { id: 'low_contains', state: 'idle', priority: 1, contains: ['match'] },
    {
      id: 'high_nested_gates', state: 'working', priority: 10, contains: ['match'],
      all: [{ any: [{ regex: ['w[io]n'] }, { contains: ['fallback'] }] }],
      not: [{ contains: ['blocked'] }],
    },
    { id: 'line_regex', state: 'blocked', priority: 20, line_regex: ['^exact line$'] },
  ];
  assert.deepEqual(explain(rules, 'match win'), { state: 'working', rule: 'high_nested_gates' });
  assert.deepEqual(explain(rules, 'match win blocked'), { state: 'idle', rule: 'low_contains' });
  assert.deepEqual(explain(rules, 'before\nexact line\nafter'), { state: 'blocked', rule: 'line_regex' });
  // contains is caseless; a line_regex must match one whole line, not the text.
  assert.deepEqual(explain(rules, 'MATCH FALLBACK'), { state: 'working', rule: 'high_nested_gates' });
  assert.equal(stateOf(rules, 'before exact line'), 'unknown');
  // Needles are lowercased too (herdr compiles them lowercased), so a rule may write them in any case.
  assert.equal(stateOf([{ id: 'r', state: 'blocked', contains: ['Esc to Cancel'] }], 'esc to cancel'), 'blocked');
});

test('on a priority tie the earlier rule wins', () => {
  const rules = [
    { id: 'first', state: 'working', priority: 5, contains: ['x'] },
    { id: 'second', state: 'blocked', priority: 5, contains: ['x'] },
  ];
  assert.equal(explain(rules, 'x').rule, 'first');
  assert.equal(explain([...rules].reverse(), 'x').rule, 'second');
});

// ── herdr: end_anchored_footer_gates_allow_only_auxiliary_tail ──

test('an end-anchored footer allows only an auxiliary tail', () => {
  const rules = [{
    id: 'live_controls', state: 'blocked', region: 'whole_recent',
    regex: [String.raw`(?i)(?:^|\n)controls:\s+(?:confirm-marker|select-marker\s+navigate-marker)\s+cancel-marker[ \t]*\n---[^\n]*(?:\npanel: \d+(?:\nrow: [^\n]+)+(?:\n… \+\d+ pending)?)?(?:\n[ \t]*)*\z`],
  }];
  const footer = 'controls: select-marker navigate-marker cancel-marker';
  for (const tail of [
    '--- name',
    '--- name\npanel: 5\nrow: active\nrow: pending\nrow: pending\nrow: pending\nrow: done\n',
    '--- name\npanel: 5\nrow: active\nrow: done\n… +3 pending',
  ]) {
    const live = `old output\n${footer}\n${tail}`;
    assert.equal(stateOf(rules, live), 'blocked', tail);
    for (const later of ['new output', 'prompt:', '--- next\nprompt:', 'prompt: continue…', 'working: processing…', '…ordinary output', 'finished…', '… +2 arbitrary words']) {
      assert.equal(stateOf(rules, `${live}\n${later}`), 'unknown', later);
    }
  }
  for (const tail of ['--- name\n… +2 pending', '--- name\nrow: active', '--- name\npanel: 5', '--- name\npanel: 5\nrow: active\n  working: processing…', '--- name\npanel: 5\nrow: active\n  prompt: continue…']) {
    assert.equal(stateOf(rules, `${footer}\n${tail}`), 'unknown', tail);
  }
  for (const controls of ['controls: confirm-marker cancel-marker', 'controls: select-marker\nnavigate-marker cancel-marker', 'controls:\nselect-marker\nnavigate-marker\ncancel-marker']) {
    assert.equal(stateOf(rules, `${controls}\n--- name`), 'blocked', controls);
  }
  for (const controls of ['controls: select-marker cancel-marker', 'controls: navigate-marker cancel-marker', 'controls: confirm-marker', 'controls: select-marker unrelated navigate-marker cancel-marker', 'controls: select-marker\nprompt: navigate-marker cancel-marker']) {
    assert.equal(stateOf(rules, `confirm-marker navigate-marker\n${controls}\n--- name`), 'unknown', controls);
  }
});

// ── herdr: paired_alternatives_require_complete_gates_at_bottom_buffer ──

test('paired alternatives need a complete gate at the bottom of the screen', () => {
  const rules = [{
    id: 'paired', state: 'blocked', region: 'bottom_non_empty_lines(3)', visible_blocker: true,
    any: [
      { all: [{ contains: ['alpha heading'] }, { regex: [String.raw`alpha\s+control\s*\z`] }] },
      { all: [{ contains: ['beta heading'] }, { regex: [String.raw`beta\s+control\s*\z`] }] },
    ],
  }];
  for (const text of ['alpha heading\nalpha control', 'beta heading\nbeta\ncontrol']) assert.equal(stateOf(rules, text), 'blocked', text);
  for (const text of ['alpha heading\nbeta control', 'beta heading\nalpha control', 'beta control', 'beta heading', 'beta heading\nbeta control\nnewer content', 'beta heading\nfiller one\nfiller two\nbeta control']) {
    assert.equal(explain(rules, text).rule, null, text);
  }
});

// ── herdr: osc_regions_use_separate_inputs_and_share_rule_priority (osc_progress not ported) ──

test('the title feeds only osc_title and shares rule priority', () => {
  const rules = [
    { id: 'screen', state: 'idle', priority: 10, region: 'whole_recent', visible_idle: true, contains: ['screen-marker'] },
    { id: 'title', state: 'working', priority: 20, region: 'osc_title', visible_working: true, regex: ['^title-marker$'] },
  ];
  assert.deepEqual(explain(rules, 'screen-marker', ''), { state: 'idle', rule: 'screen' });
  assert.deepEqual(explain(rules, 'screen-marker', 'title-marker'), { state: 'working', rule: 'title' });
  assert.deepEqual(explain(rules, 'screen-marker title-marker', ''), { state: 'idle', rule: 'screen' });
  assert.equal(explain(rules, '', 'screen-marker').rule, null, 'the title never feeds a text region');
  // Ours: osc_progress isn't ported, and a title rule may only say working.
  refused([{ id: 'progress', state: 'blocked', region: 'osc_progress', regex: ['^progress-marker$'] }]);
  refused([{ id: 'title_idle', state: 'idle', region: 'osc_title', regex: ['^✳ '] }]);
  refused([{ id: 'title_blocked', state: 'blocked', region: 'osc_title', regex: ['^x'] }]);
});

// ── herdr: skip_rule_suppresses_state_update_without_visible_state_evidence ──

test('an overlay (skip) rule reads unknown and wins on priority', () => {
  const rules = [
    { id: 'activity', state: 'working', priority: 10, visible_working: true, contains: ['activity-marker'] },
    { id: 'overlay', state: 'unknown', priority: 20, skip_state_update: true, contains: ['overlay-marker'] },
  ];
  const r = explain(rules, 'activity-marker overlay-marker');
  assert.equal(r.state, 'unknown');
  assert.equal(r.rule, 'overlay');
});

// ── herdr: screen_regions_extract_structure_without_classifying_agent_state (the regions we port) ──

test('regions cut the screen as herdr does', () => {
  for (const [screen, spec, expected] of [
    ['old\n\nnew\n', 'bottom_lines(2)', '\nnew\n'],
    ['above\n\n───\nbody\n───\nfooter\n', 'above_prompt_box', 'above\n\n'],
    ['above\n\n───\nbody\n───\nfooter\n', 'last_non_empty_above_prompt_box', 'above'],
    ['above\n───\nbody\n───\nfooter\n', 'prompt_box_body', 'body\n'],
    ['above\n───\nbody\n───\nfooter\n', 'after_last_horizontal_rule', 'footer\n'],
    // herdr: bottom_non_empty_lines_uses_bottom_occurrence_for_repeated_text
    ['marker\nold\n\nmiddle\nmarker\nnew\n', 'bottom_non_empty_lines(2)', 'marker\nnew\n'],
    // ours: edge cases
    ['no rules here\n', 'prompt_box_body', ''],
    ['no rules here\n', 'above_prompt_box', 'no rules here\n'],
    ['no rules here\n', 'after_last_horizontal_rule', 'no rules here\n'],
    ['a\n───\n', 'after_last_horizontal_rule', ''],
    ['', 'bottom_non_empty_lines(3)', ''],
    ['x', 'bottom_lines(0)', ''],
  ]) {
    assert.equal(region({ text: screen }, spec), expected, `${spec} of ${JSON.stringify(screen)}`);
  }
  assert.equal(region({ text: 'x', title: 'the title' }, 'osc_title'), 'the title');
});

test('a horizontal rule is a run of ─, or three or more with a label', () => {
  for (const l of ['───', '  ─  ', '───── name ─', '───label']) assert.ok(isHorizontalRule(l), l);
  for (const l of ['', '   ', 'x───', '── name', '-----']) assert.ok(!isHorizontalRule(l), l);
  assert.deepEqual(rustLines('a\r\nb\n\nc\n'), ['a', 'b', '', 'c']);
  assert.deepEqual(rustLines(''), []);
});

// ── herdr: manifest_validation_* ──

test('the validator refuses what herdr refuses', () => {
  refused([{ id: 'typo', state: 'working', contain: ['Working'] }]); // unknown field
  refused([{ id: 'empty', state: 'working' }]); // no positive matcher
  refused([]); // empty rules
  refused([{ id: 'bad_region', state: 'working', region: 'after_last_promt_marker', contains: ['Working'] }]);
  refused([{ id: 'bad_regex', state: 'working', regex: ['['] }]);
  refused([{ id: 'bad_nested_regex', state: 'working', any: [{ line_regex: ['['] }] }]);
  refused([{ id: 'bad_skip_state', state: 'idle', skip_state_update: true, contains: ['menu'] }]);
  refused([{ id: 'bad_skip_visible', state: 'unknown', skip_state_update: true, visible_blocker: true, contains: ['menu'] }]);
  refused([{ id: 'only_not', state: 'idle', not: [{ contains: ['x'] }] }]); // not is not positive
  refused([{ id: 'empty_not', state: 'idle', contains: ['x'], not: [{}] }]);
  refused([{ id: 'gate_typo', state: 'idle', contains: ['x'], any: [{ contain: ['y'] }] }]);
  refused([{ id: 'bad_state', state: 'busy', contains: ['x'] }]);
  // Ours: ids unique; unported regions refused.
  refused([{ id: 'twice', state: 'idle', contains: ['x'] }, { id: 'twice', state: 'idle', contains: ['y'] }]);
  for (const reg of ['top_non_empty_lines(3)', 'after_last_prompt_marker', 'current_prompt_block_marker', 'bottom_lines(+3)', 'bottom_lines(-1)', 'osc_progress']) {
    refused([{ id: 'r', state: 'working', region: reg, contains: ['x'] }]);
  }
});

test('the validator keeps herdr\'s size limits', () => {
  const rule = (i) => ({ id: `rule_${i}`, state: 'idle', contains: ['ready'] });
  assert.equal(compileRules(Array.from({ length: LIMITS.MAX_RULES }, (_, i) => rule(i))).length, 128);
  refused(Array.from({ length: LIMITS.MAX_RULES + 1 }, (_, i) => rule(i)));
  // Gate depth: nine nested levels under the rule is one too many; eight is fine.
  const nest = (n) => (n === 0 ? { contains: ['9'] } : { contains: [String(n)], all: [nest(n - 1)] });
  refused([{ id: 'deep', state: 'idle', contains: ['ready'], all: [nest(8)] }]);
  compileRules([{ id: 'deep', state: 'idle', contains: ['ready'], all: [nest(7)] }]);
  // Matchers per gate.
  refused([{ id: 'many', state: 'idle', contains: Array.from({ length: 33 }, (_, i) => `m${i}`) }]);
  compileRules([{ id: 'many', state: 'idle', contains: Array.from({ length: 32 }, (_, i) => `m${i}`) }]);
  // Matcher length, counted in characters.
  refused([{ id: 'long', state: 'idle', contains: ['x'.repeat(513)] }]);
  compileRules([{ id: 'long', state: 'idle', contains: ['─'.repeat(512)] }]);
  // Total gates (512) and total matchers (1024) across all rules.
  const wide = (i) => ({ id: `w${i}`, state: 'idle', contains: ['x'], any: Array.from({ length: 63 }, () => ({ contains: ['y'] })) });
  compileRules(Array.from({ length: 8 }, (_, i) => wide(i))); // 8 x 64 = 512 gates
  refused([...Array.from({ length: 8 }, (_, i) => wide(i)), rule(99)]);
  const full = (i) => ({ id: `f${i}`, state: 'idle', contains: Array.from({ length: 32 }, () => 'z') });
  compileRules(Array.from({ length: 32 }, (_, i) => full(i))); // 1024 matchers
  refused([...Array.from({ length: 32 }, (_, i) => full(i)), rule(99)]);
});

// ── Ours: the Rust-to-JavaScript pattern translation ──

test('each Rust pattern feature translates exactly', () => {
  const t = (p, s) => toJsRegex(p).test(s);
  // \x{…}
  assert.ok(t(String.raw`^\x{276F}$`, '❯'));
  assert.ok(t(String.raw`^[\x{2800}-\x{28FF}] `, '⠂ Working'));
  // \z: end of text only, no trailing newline allowed.
  assert.ok(t(String.raw`x\z`, 'ax'));
  assert.ok(!t(String.raw`x\z`, 'x\n'));
  // Rust $ without (?m) is also end of text only (JS's $ is the same; ours spells it out).
  assert.ok(!t('x$', 'x\ny'));
  assert.ok(!t('x$', 'x\n'));
  // (?m): ^ and $ at each \n-separated line, and only \n.
  assert.ok(t('(?m)^b$', 'a\nb\nc'));
  assert.ok(!t('(?m)^b$', 'a b'));
  // (?i): caseless, also for non-ASCII letters.
  assert.ok(t('(?i)^yes$', 'YES'));
  assert.ok(t('(?i)^é$', 'É'));
  // Unicode classes, as Rust: \d, \s, \w and \b are Unicode; JavaScript's own are ASCII.
  assert.ok(t(String.raw`^\d$`, '٣') && !/^\d$/.test('٣'));
  assert.ok(t(String.raw`^\s$`, '\u0085') && !/^\s$/.test('\u0085'));
  assert.ok(!t(String.raw`^\s$`, '﻿') && /^\s$/.test('﻿'));
  assert.ok(t(String.raw`^\w+$`, 'café'));
  assert.ok(!t(String.raw`yes\b`, 'yesé') && /yes\b/.test('yesé'));
  assert.ok(t(String.raw`yes\b`, 'yes!'));
  assert.ok(t(String.raw`\byes`, 'é yes'));
  assert.ok(t(String.raw`^\S+$`, 'abc') && !t(String.raw`^\S+$`, 'a b'));
  // . is any character but \n (JavaScript's also stops at \r, U+2028, U+2029).
  assert.ok(t('^a.b$', 'a b') && !/^a.b$/u.test('a b'));
  assert.ok(!t('^a.b$', 'a\nb'));
  // Classes: a leading ] is a literal; escapes inside a class.
  assert.ok(t('^[]a]$', ']'));
  assert.ok(t(String.raw`^[\s·]$`, '·'));
  // (?:…) groups and {n,m} pass through.
  assert.ok(t('^(?:ab){2,3}$', 'ababab'));
});

test('a Rust pattern with no exact translation is refused, never approximated', () => {
  for (const p of ['foo(?i)bar', '(?s)a.b', String.raw`\Aabc`, String.raw`\p{L}`, '(?P<n>x)', '(?<n>x)', '(?=x)', '(?!x)', '[[a]]', '[a&&b]', '[a--b]', String.raw`\B`, String.raw`\Z`, String.raw`\x41`, String.raw`\u0041`, '[abc', '\\', String.raw`[\S]`]) {
    assert.throws(() => toJsRegex(p), PatternRefused, p);
  }
  // …and a rule holding one is refused whole.
  refused([{ id: 'r', state: 'working', regex: [String.raw`\p{L}`] }]);
});

// ── Ours: holds ──

test('escape sequences are stripped before matching', () => {
  assert.equal(plainText('\x1b[1;32m❯\x1b[0m hi\x1b]0;title\x07 \x1b[?25l'), '❯ hi ');
  assert.equal(plainText('a\r\nb\x00c\x1bPdcs\x1b\\d'), 'a\nbcd');
  const screen = `out\n\x1b[2m────────\x1b[0m\n\x1b[1m❯\x1b[0m \n\x1b[2m────────\x1b[0m\n  ? for shortcuts\n`;
  assert.deepEqual(matchScreen({ text: screen, title: '' }), { state: 'idle', rule: 'live_prompt_box' });
});

test('a reading too large, a line too long, or no reading reads unknown', () => {
  assert.equal(matchScreen({ text: 'x\n'.repeat(MAX_TEXT_CHARS) }).state, 'unknown');
  assert.equal(matchScreen({ text: `${'x'.repeat(MAX_LINE_CHARS + 1)}\n───\n❯\n───\n` }).state, 'unknown');
  assert.equal(matchScreen({ text: 'x', title: 'y'.repeat(1001) }).state, 'unknown');
  for (const r of [null, undefined, {}, { text: 5 }, 'text']) assert.equal(matchScreen(r).state, 'unknown');
});

test('matching that runs past its time limit reads unknown', () => {
  let t = 0;
  const clock = () => (t += 60); // each tick 60 ms: the limit (100 ms) is passed on the second rule
  assert.equal(matchScreen({ text: IDLE }, { clock }).why, 'matching ran past its time limit');
  assert.equal(matchScreen({ text: IDLE }, { clock: () => 0 }).state, 'idle');
});

test('every Claude rule on long pathological lines finishes inside the time limit', () => {
  const nasty = [
    `* ${'a · '.repeat(450)}`,
    `${'* x\n  y · \n'.repeat(400)}`,
    `${'enter to confirm · esc to cancel\n'.repeat(500)}─── x\n${'   3 tasks (1 done, 2 open)\n'.repeat(200)}`,
    `${'✻ '.repeat(990)}`,
    `${'─'.repeat(1999)}\n`.repeat(90),
    `${' '.repeat(1990)}❯`,
    `MCP server "${'"'.repeat(1900)} requests your input`,
    `${'do you want to '.repeat(130)}\n`.repeat(90),
  ];
  for (const text of nasty) {
    assert.ok(text.length <= MAX_TEXT_CHARS);
    const started = performance.now();
    const r = matchScreen({ text, title: '⠂'.repeat(900) });
    const took = performance.now() - started;
    assert.ok(took < 1000, `took ${Math.round(took)} ms`);
    assert.ok(['working', 'blocked', 'idle', 'unknown'].includes(r.state));
  }
});

// ── The Claude rules on hand-made screens (captured fixtures are R-0b-152b) ──

const BAR = '─'.repeat(60);
const IDLE = `⏺ Done. The tests pass.\n\n${BAR}\n❯ \n${BAR}\n  ? for shortcuts\n`;

test('the Claude rules compile: 15 of herdr\'s 17, two named as left out', () => {
  assert.equal(RULES_VERSION, '2026.10.11.1');
  assert.equal(defaultRules().length, 15);
  assert.deepEqual(Object.keys(LEFT_OUT).sort(), ['osc_progress_idle', 'osc_title_idle']);
  const ids = CLAUDE_RULES.map((r) => r.id);
  for (const gone of Object.keys(LEFT_OUT)) assert.ok(!ids.includes(gone));
  assert.ok(CLAUDE_RULES.filter((r) => r.region === 'osc_title').every((r) => r.state === 'working'));
});

test('Claude screens: idle, working, a question, an overlay', () => {
  const read = (text, title = '') => matchScreen({ text, title });
  assert.deepEqual(read(IDLE), { state: 'idle', rule: 'live_prompt_box' });
  assert.deepEqual(read(`⏺ Reading files\n\n✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)\n\n${BAR}\n❯ \n${BAR}\n`), { state: 'working', rule: 'live_turn_working' });
  assert.deepEqual(read(IDLE, '⠂ Claude Code'), { state: 'working', rule: 'osc_title_working' });
  // The resting Bash approval layout (herdr #2650).
  const bash = `${BAR}\n Bash command\n\n   ls -la\n   List files\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for: ls\n   3. No\n\n Esc to cancel · Tab to amend · ctrl+e to explain\n`;
  assert.deepEqual(read(bash), { state: 'blocked', rule: 'bash_permission_prompt' });
  const edit = `${BAR}\n Edit file\n src/x.ts\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow all edits this session\n   3. No\n\n Esc to cancel\n`;
  assert.deepEqual(read(edit), { state: 'blocked', rule: 'generic_permission_prompt' });
  const ask = `${BAR}\n☐ Colour\n\nWhich colour?\n\n❯ 1. Red\n  2. Blue\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
  assert.deepEqual(read(ask), { state: 'blocked', rule: 'live_blocked_form' });
  const mcp = `MCP server "notes" requests your input\n\n ❯ Accept\n   Decline\n\nEsc to cancel\n`;
  assert.deepEqual(read(mcp), { state: 'blocked', rule: 'mcp_elicitation_prompt' });
  assert.deepEqual(read(`${IDLE}Showing detailed transcript · ctrl+o to toggle\n`), { state: 'unknown', rule: 'transcript_viewer', why: 'an overlay rule (skip_state_update)' });
});

test('a question wording no rule knows reads unknown, never idle, even under a ✳ title', () => {
  const unseen = '⏺ I need a decision.\n\nPick one of the three plans to continue:\n  plan A\n  plan B\n  plan C\n';
  assert.equal(matchScreen({ text: unseen, title: '✳ Claude Code' }).state, 'unknown');
  assert.equal(matchScreen({ text: '', title: '✳ Claude Code' }).state, 'unknown');
});
