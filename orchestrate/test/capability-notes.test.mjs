// capability-notes.test.mjs — R-1-91 class fix (L1088 (5)): every Claude Code capability note in orchestrate/ names the
// version it was checked on, as `checked: claude-code <version>`, and that version is the pin; a note not yet re-checked
// on the pin is open, with a date and the row that re-checks it. capability-notes.mjs says what fails and why.
// `node orchestrate/test/capability-notes.mjs` prints every problem and every open note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan, scanText, TOOLS, ROOT, OPEN_LIMIT } from './capability-notes.mjs';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';
import { TOOLS_CHECKED } from '../modules/M10-rules/roles.mjs';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const PIN = '2.1.316';
const tools = { 'claude-code': { ...TOOLS['claude-code'], pin: () => PIN } };
const why = (file, text) => scanText(file, text, { now: NOW, tools }).problems.map((p) => p.why);

test('R-1-91: every Claude Code note in orchestrate/ is on the pin, or open with a date and a row', () => {
  const { problems, open } = scan();
  // The open list is shown on every run (L1090 (3)), so what is still waiting is never hidden by a green test.
  for (const o of open) console.log(`# open: ${o.file}:${o.line} claude-code ${o.version}, until ${o.until} (${o.row})`);
  assert.deepEqual(problems.map((p) => `${p.file}:${p.line} ${p.why}`), []);
  for (const o of open) assert.match(o.row, /^(?:R-|L\d|#\d)/, `${o.file}:${o.line}`);
});

test('the pin is the one pin (I7): the rules file\'s claude_code.pin, which the tool list is checked against', () => {
  const pin = parsePolicy(readFileSync(join(ROOT, 'modules/M10-rules/fixtures/policy.yaml'), 'utf8')).policy.claude_code.pin;
  assert.equal(TOOLS['claude-code'].pin(), pin);
  assert.equal(TOOLS_CHECKED.claude_code, pin);
});

test('a tag on the pin passes, in code, YAML and Markdown', () => {
  assert.deepEqual(why('a.mjs', '// Capability note: X holds (checked: claude-code 2.1.316, 5 Nov 2026).\nconst x = 1;\n'), []);
  assert.deepEqual(why('a.yaml', '# Claude Code\'s list (checked: claude-code 2.1.316)\nk: v\n'), []);
  assert.deepEqual(why('a.md', '| Two accounts | A capability note (checked: claude-code 2.1.316) |\n'), []);
  // A tag wrapped across comment lines is still one tag.
  assert.deepEqual(why('a.mjs', '// Capability note: X holds (checked: claude-code\n// 2.1.316).\n'), []);
  const wrapped = scanText('a.mjs', '// Claude Code note (checked: claude-code 2.1.312, open\n//   until 2027-01-20 (R-0b-84)).\n', { now: NOW, tools });
  assert.deepEqual([wrapped.problems, wrapped.open.map((o) => o.row)], [[], ['R-0b-84']]);
});

test('plants: each way a note goes stale fails', () => {
  // A note checked on another version.
  assert.match(why('a.mjs', '// Capability note (checked: claude-code 2.1.312): X holds.\n')[0], /checked on claude-code 2\.1\.312, but the pin is 2\.1\.316/);
  // A note with no tag: a version in prose, or the words with none.
  assert.match(why('a.mjs', '// Read in claude 2.1.322\'s code: X holds.\n')[0], /no "checked: claude-code <version>" tag/);
  assert.match(why('a.md', 'Capability note, not yet checked (Principle 9): Claude Code\'s result shape.\n')[0], /no "checked: claude-code/);
  assert.match(why('a.yaml', '# Claude Code 2.1.312 protected paths\nk: v\n')[0], /no "checked: claude-code/);
  // A note in a comment after code.
  assert.match(why('a.mjs', 'const x = 1; // claude 2.1.317 reads it this way\n')[0], /no "checked: claude-code/);
  // A tag for a tool with no pin here.
  assert.match(why('a.mjs', '// checked: github-api 2022-11-28\n')[0], /names a tool with no pin here/);
  // A tag that is no version.
  assert.match(why('a.mjs', '// checked: claude-code 2.1, Claude Code\n')[0], /names no version/);
});

test('an open note passes only before its date, within the limit, naming what re-checks it; each is listed', () => {
  const open = (until, row) => scanText('a.mjs', `// Claude Code note (checked: claude-code 2.1.312, open until ${until} (${row})).\n`, { now: NOW, tools });
  const ok = open('2027-01-20', 'R-0b-84');
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.open.map((o) => [o.version, o.until, o.row]), [['2.1.312', '2027-01-20', 'R-0b-84']]);
  assert.deepEqual(open('2027-01-20', 'L1088').problems, []);
  assert.match(open('2026-11-12', 'R-0b-84').problems[0].why, /now past/);
  assert.equal(OPEN_LIMIT, '2027-01-20');
  assert.deepEqual(open('2027-01-20', 'R-0b-84').problems, [], 'the limit day itself is allowed');
  assert.match(open('2027-01-21', 'R-0b-84').problems[0].why, /after 2027-01-20/);
  assert.match(open('2099-01-01', 'R-0b-84').problems[0].why, /after 2027-01-20/);
  assert.match(open('2026-02-30x', 'R-0b-84').problems[0].why, /can't be read/);
  // The last day counts; the day after does not.
  const last = scanText('a.mjs', '// Claude Code note (checked: claude-code 2.1.312, open until 2026-11-13 (R-0b-84)).\n', { now: Date.parse('2026-11-13T23:59:00Z'), tools });
  assert.deepEqual(last.problems, []);
  const after = scanText('a.mjs', '// Claude Code note (checked: claude-code 2.1.312, open until 2026-11-13 (R-0b-84)).\n', { now: Date.parse('2026-11-14T00:00:00Z'), tools });
  assert.match(after.problems[0].why, /now past/);
  assert.match(open('2027-01-20', 'someone').problems[0].why, /names the row, call or PR/);
  assert.match(open('20 Jan 2027', 'R-0b-84').problems[0].why, /can't be read/);
});

test('not notes: code, prose with no tool or no version, and English after "checked:"', () => {
  assert.deepEqual(why('a.mjs', "export const MIN_CLAUDE_CODE = '2.1.295';\nbad('claude_code.pin must be a version like 2.1.300');\n"), []);
  assert.deepEqual(why('a.mjs', '// gitleaks 8.30.1, Node 26.7: not Claude Code notes until a tool for them is added.\n'), []);
  assert.deepEqual(why('a.mjs', '// The answer is not checked: until the poll ends.\n'), []);
  assert.deepEqual(why('a.md', 'Claude starts the session and reads the card.\n'), []);
});

test('a second tool is one entry: its notes are then held to its own pin (C, later)', () => {
  const two = { ...tools, 'github-api': { pin: () => '2022-11-28', format: /^\d{4}-\d\d-\d\d$/, name: /\bgithub\b/i, version: /\b20\d\d-\d\d-\d\d\b/ } };
  const got = (text) => scanText('a.mjs', text, { now: NOW, tools: two }).problems.map((p) => p.why);
  assert.deepEqual(got('// GitHub REST shape (checked: github-api 2022-11-28)\n'), []);
  assert.match(got('// GitHub REST shape (checked: github-api 2026-03-10)\n')[0], /but the pin is 2022-11-28/);
  assert.match(got('// GitHub REST shape, version 2026-03-10\n')[0], /a github-api note with no "checked: github-api/);
  // Before the entry exists, the same prose is no note: part C is not held yet (L1088 (4)).
  assert.deepEqual(why('a.mjs', '// GitHub REST shape, version 2026-03-10\n'), []);
});
