// outside-join.mjs — the join check for R-0b-126: outside text lands fenced in the record AND in the Lead's input file.
//
// WHY. M12 fences what it reads itself (commit subjects, idea issues). The rest is read by other lanes: lesson- and
// idea- files go through the Dispatcher's outbox intake into the record (lanes 2 and 1), and research- files and the
// record's text reach the Lead through the Lead-input writer (the lead's M3). Each of those calls `cleanOutside` once,
// at its write, and runs THIS check in its own tests, so all of them are held to the same planted cases and the same
// exact form (review-0b-7 M7). R-0b-126 is done when every kind below passes through the real path end to end.
//
//   import { checkOutsideJoin } from '../M12-sensors/outside-join.mjs';
//   const misses = await checkOutsideJoin(async ({ source, text }) => ({ record: '…', leadInput: '…' }),
//     { sources: ['lesson-file', 'idea-file'], where: ['record'] });
//   assert.deepEqual(misses, []);
//
// `land` puts one planted string through the lane's real path and returns what it wrote: the record's text for it
// (`record`, e.g. JSON of the stored document) and the Lead's input file (`leadInput`). `where` names the outputs this
// lane must hand back (both by default); one missing is a miss, so a typo can't pass by checking nothing. `sources` must
// be a non-empty list of JOIN_SOURCES; anything else throws. The Lead-input writer runs all five.
//
// A miss is any of: the exact expected form is absent; once every exact form is taken out, any instruction-shaped part
// or planted tag is still there (compared ignoring case and spaces, so a raw copy can't hide in a fence the lane wrote
// itself or in a re-wrapped line); or a planted fake key survives. Strings are compared as written and with JSON
// escapes undone (up to three levels), so a JSON record passes. Hand back the text as written: a form indented line by
// line (YAML block, nested list) does not match and fails closed.

import { readFileSync } from 'node:fs';
import { FAKE } from './fakes.mjs';

// The five kinds R-0b-126's done-when names.
export const JOIN_SOURCES = Object.freeze(['commit-subject', 'research-file', 'idea-issue', 'lesson-file', 'idea-file']);
export const JOIN_OUTPUTS = Object.freeze(['record', 'leadInput']);

const fixtures = () => JSON.parse(readFileSync(new URL('./fixtures/outside-text.json', import.meta.url), 'utf8')).cases;
const fill = (s) => s.replace(/\{\{FAKE\.(\w+)\}\}/g, (_, k) => FAKE[k]);

function checkList(list, allowed, what) {
  if (!Array.isArray(list) || !list.length || list.some((x) => !allowed.includes(x))) {
    throw new Error(`checkOutsideJoin: ${what} must be a non-empty list of ${allowed.join(', ')}`);
  }
}

// Every planted case for these sources, with its fake keys filled in.
export function joinCases(sources = JOIN_SOURCES) {
  checkList(sources, JOIN_SOURCES, 'sources');
  return fixtures().filter((c) => sources.includes(c.source)).map((c) => ({ ...c, text: fill(c.text) }));
}

// JSON escapes undone, so `\n` and `\"` inside a stored document compare equal to the fenced form.
const unjson = (s) => s.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (_, u, ch) =>
  (u ? String.fromCharCode(parseInt(u, 16)) : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[ch] ?? ch));
const views = (s) => { const out = [s]; for (let i = 0; i < 3; i++) out.push(unjson(out.at(-1))); return out; };
const squash = (s) => s.toLowerCase().replace(/[\s ]+/g, '');
// What must never be left once the exact forms are out: the instruction parts and the planted tags (not the fence's own).
const tells = (c) => [...[c.instruction ?? []].flat(), ...(c.text.match(/<[^<>]*>/g) ?? [])
  .filter((t) => !/^<\/?outside-text\b/.test(t))].map(squash);

export async function checkOutsideJoin(land, { sources = JOIN_SOURCES, where = JOIN_OUTPUTS } = {}) {
  checkList(where, JOIN_OUTPUTS, 'where');
  const misses = [];
  for (const c of joinCases(sources)) {
    const got = await land({ source: c.source, text: c.text });
    for (const w of where) {
      const miss = (why) => misses.push({ source: c.source, where: w, why });
      const raw = got?.[w];
      if (typeof raw !== 'string') { miss('nothing written (not a string)'); continue; }
      const vs = views(raw);
      if (!vs.some((v) => v.includes(c.expect))) miss('the exact fenced form is missing');
      const left = vs.map((v) => squash(v.split(c.expect).join('')));
      if (tells(c).some((t) => left.every((v) => v.includes(t)))) miss('outside text appears outside its exact fence');
      if (Object.values(FAKE).some((k) => c.text.includes(k) && vs.some((v) => v.includes(k)))) miss('a planted fake key survived');
    }
  }
  return misses;
}
