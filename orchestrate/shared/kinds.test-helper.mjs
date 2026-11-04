// Test helper: reading text for an outbox kind's name (L151). One copy, used by M9's outbox-kinds.test and the
// shared no-promise test.

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

// The markdown sections (`## ` heading to the next, heading included) whose body names the kind; [0] is the preamble.
// A skill's front matter counts by its description only (name: is not read by anyone).
export function sectionsNaming(md, k) {
  const text = String(md).replace(/^---\n([\s\S]*?)\n---\n/, (_, fm) => `${(/^description: (.*)$/m.exec(fm) ?? [, ''])[1]}\n\n`);
  const [preamble, ...rest] = text.split(/^(?=## )/m);
  return { preamble, sections: rest.filter((s) => namesKind(s.split('\n').slice(1).join('\n').replace(/`/g, ' '), k)) };
}
