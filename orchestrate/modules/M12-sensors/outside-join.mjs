// outside-join.mjs — the join check for R-0b-126: outside text lands fenced in the record AND in the Lead's input file.
//
// WHY. M12 fences what it reads itself (commit subjects, idea issues). The rest is read by other lanes: lesson- and
// idea- files go through the Dispatcher's outbox intake into the record (lanes 2 and 1), and research- files and the
// record's text reach the Lead through the Lead-input writer (the lead's M3). Each of those calls `cleanOutside` once,
// at its write, and runs THIS check in its own tests, so all of them are held to the same planted cases and the same
// exact form (review-0b-7 M7). R-0b-126 is done when every kind below passes through the real path end to end.
//
//   import { checkOutsideJoin } from '../M12-sensors/outside-join.mjs';
//   const misses = await checkOutsideJoin(async ({ source, text }) => ({ record: '…', leadInput: '…' }), ['lesson-file']);
//   assert.deepEqual(misses, []);
//
// `land` puts one planted string through the lane's real path and returns what it wrote: the record's text for it
// (`record`, e.g. JSON of the stored document) and the Lead's input file (`leadInput`); leave one out (undefined) when
// that lane writes only the other. A miss is any of: the exact expected form is absent; the instruction appears outside
// a fence; or the planted fake key survives. Strings are compared after JSON-unescaping, so a JSON record passes.

import { readFileSync } from 'node:fs';
import { FAKE } from './fakes.mjs';

// The five kinds R-0b-126's done-when names.
export const JOIN_SOURCES = Object.freeze(['commit-subject', 'research-file', 'idea-issue', 'lesson-file', 'idea-file']);

const fixtures = () => JSON.parse(readFileSync(new URL('./fixtures/outside-text.json', import.meta.url), 'utf8')).cases;
const fill = (s) => s.replace(/\{\{FAKE\.(\w+)\}\}/g, (_, k) => FAKE[k]);

// Every planted case for these sources, with its fake keys filled in.
export function joinCases(sources = JOIN_SOURCES) {
  return fixtures().filter((c) => sources.includes(c.source)).map((c) => ({ ...c, text: fill(c.text) }));
}

// JSON escapes undone, so `\n` and `\"` inside a stored document compare equal to the fenced form.
const unjson = (s) => s.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (_, u, ch) =>
  (u ? String.fromCharCode(parseInt(u, 16)) : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[ch] ?? ch));
const views = (s) => [s, unjson(s)];
const outsideFences = (s) => s.replace(/<outside-text source="[a-z-]+">[\s\S]*?<\/outside-text>/g, '');

export async function checkOutsideJoin(land, sources = JOIN_SOURCES) {
  const misses = [];
  for (const c of joinCases(sources)) {
    const got = await land({ source: c.source, text: c.text });
    for (const where of ['record', 'leadInput']) {
      const raw = got?.[where];
      if (raw === undefined) continue;
      const vs = views(String(raw));
      const miss = (why) => misses.push({ source: c.source, where, why });
      if (!vs.some((v) => v.includes(c.expect))) miss('the exact fenced form is missing');
      if (c.instruction && vs.every((v) => outsideFences(v).includes(c.instruction))) miss('the instruction appears outside a fence');
      if (Object.values(FAKE).some((k) => c.text.includes(k) && vs.some((v) => v.includes(k)))) miss('a planted fake key survived');
    }
  }
  return misses;
}
