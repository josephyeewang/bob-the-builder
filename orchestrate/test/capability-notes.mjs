// capability-notes.mjs — every "the tool can't do that" note names the version it was checked on, and that version is
// the pin (R-1-91, L1088; Principle 9: a capability note expires with the version it names). A note in prose fails
// nothing when the pin moves; this scan makes it fail.
//
// The tag, one form for every tool (written inside the note, in a comment or a README line):
//   checked: claude-code 2.1.316                     re-checked on that version; it must be the tool's pin
//   checked: claude-code 2.1.312, open until 2027-01-20 (R-0b-84)
//                                                    not yet re-checked on the pin: allowed only through its date,
//                                                    never later than OPEN_LIMIT, and only naming the row, call or PR
//                                                    that re-checks it (R-…, L<n> or #<n>). Every open note is listed
//                                                    on every run. Only for a note that needs a phone, Joe or the Mini
//                                                    (L1090); anything that can be re-checked on the pin gets the pin.
// A tool's pin comes from one place (I7): TOOLS below says where. Claude Code's is the rules' claude_code.pin, read
// from the sample rules file (M10 fixtures/policy.yaml), which roles.test.mjs already ties to TOOLS_CHECKED.
// Another tool (GitHub's API, Vercel, gitleaks, macOS: R-1-91 part C) is added by giving it an entry in TOOLS (its
// pin and the word that names it in prose) and tagging its notes; none is added yet (L1088 (4)).
//
// What fails (problems()):
//   - a tag naming a tool not in TOOLS;
//   - a tag whose version is not a version, or is not the pin, outside the open form;
//   - an open tag past its date, with a date that can't be read or is after OPEN_LIMIT, or naming no row;
//   - an untagged note: a comment block (code), a # block (YAML) or a line (Markdown) that names a tool in TOOLS and
//     reads as a capability note (it names a version of the tool, or says "capability note/claim" or "Principle 9"),
//     with no tag of that tool in it.
// Code lines are not read, only comments: a version in code (a minimum, an example in an error message) is not a
// note. Over-listing is cheap: a block that is no note gets the tag of the version it was written against, or is
// reworded.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';
import { pastTime } from '../shared/still-waiting.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
// R-1-91's deadline (L1090): no open note may run past it, so none can extend itself.
export const OPEN_LIMIT = '2027-01-20';
const DAY = 86_400_000;
const VERSION = /^\d+\.\d+\.\d+$/;

const claudePin = () => parsePolicy(readFileSync(join(ROOT, 'modules/M10-rules/fixtures/policy.yaml'), 'utf8')).policy.claude_code.pin;
// pin: the one place its pin is read; format: a whole version as tagged; name: the prose that names the tool;
// version: what a version of it looks like in prose (an untagged note names one).
export const TOOLS = Object.freeze({
  'claude-code': Object.freeze({ pin: claudePin, format: VERSION, name: /\bclaude\b/i, version: /\b2\.\d+\.\d+\b/ }),
});

// The version starts with a digit, so prose such as "not checked: until the" is no tag.
const TAG = /checked: ([a-z][a-z0-9-]*) (\d[^\s,;)]*)(?:, open until ([^(\n]*?) \(([^)]*)\))?/g;
const ROW = /^(?:R-[0-9a-z][\w-]*|L\d+|#\d+)\b/i;
const NOTE_WORDS = /capability (?:note|claim)|principle 9/i;
// This file and its test hold sample tags and notes on purpose.
const SELF = new Set(['test/capability-notes.mjs', 'test/capability-notes.test.mjs']);
const TEXT = /\.(?:mjs|js|md|ya?ml)$/;

/** The units a file's notes live in: comment blocks (code), # blocks (YAML) or lines (Markdown). → [{ line, text }] */
export function units(file, text) {
  const lines = text.split('\n');
  if (file.endsWith('.md')) return lines.map((t, i) => ({ line: i + 1, text: t })).filter((u) => u.text.trim());
  const yaml = /\.ya?ml$/.test(file);
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    let c = null;
    if (yaml) { const m = l.match(/(?:^|\s)#(.*)$/); if (m) c = m[1]; } else {
      const t = l.trim();
      if (/^(?:\/\/|\/\*|\*)/.test(t)) c = t.replace(/^(?:\/\/+|\/\*+|\*+\/?)/, '');
      else { const m = l.match(/[\s;,)]\/\/\s(.*)$/); if (m) c = m[1]; } // a comment after code on the same line
    }
    if (c === null) { cur = null; return; }
    if (!cur) { cur = { line: i + 1, text: '' }; out.push(cur); }
    cur.text += `${c}\n`;
  });
  return out;
}

/** Every problem in one file's text. now: ms. → [{ file, line, why }] and the open notes [{ file, line, tool, until, row }] */
export function scanText(file, text, { now = Date.now(), tools = TOOLS } = {}) {
  const problems = [];
  const open = [];
  const pins = {};
  const pinOf = (t) => (pins[t] ??= tools[t].pin());
  for (const u of units(file, text)) {
    const tagged = new Set();
    // A tag may wrap across comment lines, as long comments do: read the block as one line.
    const flat = u.text.replace(/\s*\n\s*/g, ' ');
    for (const m of flat.matchAll(TAG)) {
      const [, tool, version, until, row] = m;
      const at = { file, line: u.line };
      tagged.add(tool);
      if (!tools[tool]) { problems.push({ ...at, why: `"${m[0]}" names a tool with no pin here (add it to TOOLS)` }); continue; }
      if (!tools[tool].format.test(version)) { problems.push({ ...at, why: `"${m[0]}" names no version` }); continue; }
      const pin = pinOf(tool);
      if (until === undefined) {
        if (version !== pin) problems.push({ ...at, why: `checked on ${tool} ${version}, but the pin is ${pin}: re-check it on ${pin} and move the tag, or mark it open` });
        continue;
      }
      // Read through pastTime (I4), with the limit as its "now": null is a date that can't be read or lies after
      // OPEN_LIMIT. Only a YYYY-MM-DD date is read, so "20 Jan 2027" fails too.
      const start = /^\d{4}-\d{2}-\d{2}$/.test(until) ? pastTime(`${until}T00:00:00Z`, Date.parse(`${OPEN_LIMIT}T00:00:00Z`)) : null;
      if (start === null) problems.push({ ...at, why: `"${m[0]}": the open date can't be read, or is after ${OPEN_LIMIT}` });
      else if (start + DAY <= now) problems.push({ ...at, why: `open until ${until}, now past: re-check it on ${pin}` });
      else if (!ROW.test(row.trim())) problems.push({ ...at, why: `"${m[0]}": an open note names the row, call or PR that re-checks it` });
      else open.push({ ...at, tool, version, until, row: row.trim() });
    }
    for (const [tool, t] of Object.entries(tools)) {
      if (tagged.has(tool) || !t.name.test(u.text)) continue;
      if (t.version.test(u.text) || NOTE_WORDS.test(u.text)) problems.push({ file, line: u.line, why: `a ${tool} note with no "checked: ${tool} <version>" tag` });
    }
  }
  return { problems, open };
}

/** Every text file under orchestrate/, as paths relative to it ('/' separated). */
export function files(root = ROOT) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (TEXT.test(e.name)) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** The whole scan. → { problems, open } */
export function scan({ root = ROOT, now = Date.now(), tools = TOOLS } = {}) {
  const problems = [];
  const open = [];
  for (const f of files(root)) {
    if (SELF.has(f)) continue;
    const r = scanText(f, readFileSync(join(root, f), 'utf8'), { now, tools });
    problems.push(...r.problems);
    open.push(...r.open);
  }
  return { problems, open };
}

// Resolved first, so a start through a link still runs (#261).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { problems, open } = scan();
  for (const o of open) console.log(`open  ${o.file}:${o.line}  ${o.tool} ${o.version}, until ${o.until} (${o.row})`);
  for (const p of problems) console.log(`FAIL  ${p.file}:${p.line}  ${p.why}`);
  console.log(`${problems.length} problem(s), ${open.length} open note(s)`);
  process.exitCode = problems.length ? 1 : 0;
}
