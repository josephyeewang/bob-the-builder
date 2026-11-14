#!/usr/bin/env node
// skill-review-check.mjs — the mechanical half of Bob's skill reviewer (reference/skill-craft/skill-reviewer.md).
//
// WHY. A skill that is too long gets cut after a compaction, and a skill whose description is vague is never
// loaded when it should be. The reviewer prompt judges quality; this script does the counting it should never
// guess at, so the same skill always gets the same numbers. Adapted from the review steps and quality standards of
// anthropics/claude-plugins-official@893173fb82a7184fcf3f08ae55930016d84fd588 (plugins/plugin-dev/agents/skill-reviewer.md),
// Apache-2.0, modified by Joe Wang, 2026-11. Licence: third_party/plugin-dev/LICENSE. Changes: the reviewer's
// countable standards turned into code; Bob's severity words (Material / Minor) used.
//
// CHECKS on one skill folder (or a SKILL.md path):
//   frontmatter   YAML between --- lines, with `name` and `description`                         → Material
//   description   shorter than DESC_MIN chars, or with no trigger cue (when / use for / a quoted
//                 phrase a user would say) → "vague"                                              → Material
//                 longer than DESC_MAX chars                                                      → Minor
//   body size     over BODY_WORDS_MAX words → "oversized"                                         → Material
//                 over BODY_WORDS_IDEAL words                                                     → Minor
//   references    a relative Markdown link to a missing file                                       → Material
//                 a `references/…`-style path in backticks not found in this skill's folder         → Minor
//   style         "you should" / "you must" in the body (imperative form wanted)                  → Minor
// The byte limit that compaction cuts at is NOT checked here; it has one home, scripts/skill-size/test-skill-size.sh.
//
// Usage: node scripts/skill-review-check.mjs <skill-folder-or-SKILL.md> [--json]
// Exit: 0 = no Material finding, 1 = at least one Material finding, 2 = cannot read the skill (fail closed).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The one place these limits live (plugin-dev's quality standards).
export const LIMITS = Object.freeze({ DESC_MIN: 50, DESC_MAX: 500, BODY_WORDS_IDEAL: 3000, BODY_WORDS_MAX: 5000 });

const TRIGGER_CUE = /\b(use (it |this )?(when|for|whenever|on|to)|when (the )?(user|joe|someone|you)|trigger(s|ed)? (on|when)|invoke(d)? when)\b|["“'][^"”']{3,}["”']/i;

export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '|' || val === '>' || val === '|-' || val === '>-' || val === '') {
      const block = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && !/^[A-Za-z_][\w-]*:/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.join(val.startsWith('>') ? ' ' : '\n').trim();
    }
    fm[kv[1]] = val.replace(/^["']|["']$/g, '');
  }
  return { frontmatter: fm, body: m[2] };
}

const words = (s) => (s.match(/\S+/g) || []).length;

export function reviewSkill(skillPath) {
  const file = fs.statSync(skillPath).isDirectory() ? path.join(skillPath, 'SKILL.md') : skillPath;
  const dir = path.dirname(file);
  const text = fs.readFileSync(file, 'utf8');
  const { frontmatter, body } = parseSkill(text);
  const findings = [];
  const add = (severity, check, what) => findings.push({ severity, check, what });

  if (!frontmatter) add('Material', 'frontmatter', 'no YAML frontmatter between --- lines');
  else for (const k of ['name', 'description']) if (!frontmatter[k]) add('Material', 'frontmatter', `missing \`${k}\``);

  const desc = frontmatter?.description || '';
  if (desc) {
    if (desc.length < LIMITS.DESC_MIN) add('Material', 'description', `vague: ${desc.length} characters (under ${LIMITS.DESC_MIN}); say when to use it, in the words a user would say`);
    else if (!TRIGGER_CUE.test(desc)) add('Material', 'description', 'vague: no trigger cue (no "use when…", "use for…" or quoted phrase a user would say)');
    if (desc.length > LIMITS.DESC_MAX) add('Minor', 'description', `${desc.length} characters (over ${LIMITS.DESC_MAX}); move detail into the body`);
  }

  const bodyWords = words(body);
  if (bodyWords > LIMITS.BODY_WORDS_MAX) add('Material', 'body size', `oversized: ${bodyWords} words (over ${LIMITS.BODY_WORDS_MAX}); move what is needed only sometimes into references/`);
  else if (bodyWords > LIMITS.BODY_WORDS_IDEAL) add('Minor', 'body size', `${bodyWords} words (over ${LIMITS.BODY_WORDS_IDEAL}, the lean target)`);

  const prose = body.replace(/```[\s\S]*?```/g, '');
  // A Markdown link is a promise the file is here: missing → Material. A path in backticks may name a file in
  // another module ("`references/x.md` in that module"), so a missing one is Minor, for the reviewer to read.
  const local = (r) => !(/^[a-z]+:/i.test(r) || r.startsWith('/') || r.startsWith('~') || r.includes('<') || r.includes('*'));
  const linked = new Set([...prose.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter(local));
  const named = new Set([...prose.matchAll(/`((?:references|examples|scripts|templates|prompts)\/[^`\s]+)`/g)].map((m) => m[1]).filter(local));
  for (const r of linked) if (!fs.existsSync(path.join(dir, r))) add('Material', 'references', `links to ${r}, which does not exist`);
  for (const r of named) if (!linked.has(r) && !fs.existsSync(path.join(dir, r))) add('Minor', 'references', `names ${r}, not found in this skill's folder (fine only if it is another module's file)`);

  const second = (prose.match(/\byou (should|must|need to)\b/gi) || []).length;
  if (second) add('Minor', 'style', `${second} × "you should/must/need to"; write instructions in the imperative ("Do X")`);

  const rel = path.relative(process.cwd(), file);
  return { skill: rel && !rel.startsWith('..') ? rel : file, name: frontmatter?.name || null, descriptionChars: desc.length, bodyWords, findings };
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node scripts/skill-review-check.mjs <skill-folder-or-SKILL.md> [--json]'); process.exit(2); }
  let r;
  try { r = reviewSkill(target); } catch (e) { console.error(`cannot read the skill at ${target}: ${e.message}`); process.exit(2); }
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.skill}: description ${r.descriptionChars} chars, body ${r.bodyWords} words`);
    for (const f of r.findings) console.log(`  ${f.severity === 'Material' ? '✗' : '·'} [${f.severity}] ${f.check}: ${f.what}`);
    if (!r.findings.length) console.log('  ✓ no findings');
  }
  process.exit(r.findings.some((f) => f.severity === 'Material') ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
