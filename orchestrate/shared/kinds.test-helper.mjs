// Test helper: reading text for an outbox kind's name (L151), and the source-file walk (L212). One copy, used by M9's
// outbox-kinds.test and the shared no-promise test.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_KINDS } from './record.mjs';

// Does the text name this kind itself, not only a longer kind that starts with it (state-compact- is not state-), nor
// one it ends (ask-request- is not request-)?
export function namesKind(text, k) {
  const kinds = Object.keys(OUTBOX_KINDS);
  for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) {
    if (i > 0 && /[a-z-]/.test(text[i - 1])) continue;
    const longer = kinds.filter((o) => o.length > k.length && o.startsWith(k) && text.startsWith(o, i));
    if (!longer.length) return true;
  }
  return false;
}

// L162 M-1: the units of a markdown text a reader can see, for the allowed-sentence check. Each quoted string is one
// unit; the text around the quotes (each quote replaced by «») is split into sentences. Blocks are list items, table
// rows, headings and paragraphs; bold marks are dropped and whitespace is folded. A unit with no letter is skipped.
export function shownUnits(text) {
  const out = [];
  for (const block of String(text).split(/\n(?=[ \t]*(?:[-|#]|\d+\. )|[ \t]*\n)/)) {
    const b = block.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(/^(?:- |\d+\. |#+ )/, '');
    const quotes = [];
    const rest = b.replace(/"([^"]*)"/g, (_, q) => { quotes.push(q.trim()); return '«»'; });
    out.push(...quotes);
    out.push(...rest.split(/(?<=[.!?])\s+(?=[A-Z«(`])/).map((s) => s.trim()));
  }
  return [...new Set(out.filter((u) => /[A-Za-z]/.test(u)))];
}

// L212 M-1: every unit of a Front Door file, the whole file, not the sections that happen to name a kind (text about
// ideas mostly says "idea", not `idea-`). The front matter is read line by line, every key: a when_to_use or any other
// key a loader may show counts, not only the description.
export function fileUnits(md) {
  return shownUnits(String(md).replace(/^---\n([\s\S]*?)\n---\n/, (_, fm) => `${fm.split('\n').join('\n\n')}\n\n`));
}

// The file walk (moved here from M9's outbox-kinds.test, L212, so both tests walk the same files).
const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOB = join(ORCH, '..');
export const SOURCE_EXT = /\.(mjs|js|cjs|md|json|txt|yaml|yml|toml)$/;
export function sourceFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') sourceFiles(p, out); } else if (SOURCE_EXT.test(e.name) && !/\.test(-helper)?\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}
// Where a kind may be named without writing it: the kind lists, their READMEs, and M6's bundle of shared/.
const LISTS = ['shared/record-names.mjs', 'shared/record.mjs', 'shared/README.md', 'modules/M10-rules/roles/lead.json', 'modules/M4-workshop/launcher/role-profiles.mjs', 'modules/M6-merge-gate/github-checker.mjs'];
// Every file outside the lists that names the kind: a prompt, a skill or code that would write it. Paths are relative
// to the Bob folder (orchestrate/…).
export function kindMentions(k, files = [...sourceFiles(ORCH), ...sourceFiles(join(BOB, 'skill')), ...sourceFiles(join(BOB, 'skills'))]) {
  return files.filter((p) => !LISTS.some((l) => p === join(ORCH, l)) && namesKind(readFileSync(p, 'utf8').replace(/`/g, ' '), k)).map((p) => p.slice(BOB.length + 1));
}
