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
// A miss is any of: the exact expected form is absent; once every exact form is taken out, any run of RUN letters or
// digits of the planted text is still there (deny by default: case, spaces, punctuation, backslashes, invisible
// characters and fence tags are ignored, so a raw, partial, re-cased, re-wrapped or shell-quoted copy is caught, in a
// fence the lane wrote itself or not; audit rounds 1-2); or a planted fake key survives. Strings are compared as written
// and with JSON escapes undone (up to three levels), so a JSON record passes; CRLF line ends count as LF. Hand back the
// text as written: a form indented or quoted line by line (YAML block, `> ` quote) does not match and fails closed.
// `land` is also called once per case with BASELINE, a neutral text of the same kind; runs the lane writes for that
// too are its own wording and are not counted. A file name or slug built from the outside text is raw outside text and
// is a miss: store the fenced form or a neutral id. A raw copy deliberately cut into pieces under RUN letters (or
// encoded) is out of scope, like base64.

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
// Letters and digits only, fence tags out: what a reader would still read as the words.
const FENCE_TAG = /<\/?outside-text\b[^>]*>/g;
const words = (s) => s.replace(FENCE_TAG, ' ').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const RUN = 12;
export const BASELINE = 'Neutral placeholder.';
const runs = (text) => { const w = words(text); const out = new Set(); for (let i = 0; i + RUN <= w.length; i++) out.add(w.slice(i, i + RUN)); return out; };

export async function checkOutsideJoin(land, { sources = JOIN_SOURCES, where = JOIN_OUTPUTS } = {}) {
  checkList(where, JOIN_OUTPUTS, 'where');
  const misses = [];
  for (const c of joinCases(sources)) {
    // The lane's own wording (a safety note, headings) may share words with a planted case: what it writes for a
    // neutral text of the same kind is its own, so those runs are not counted (audit round 3).
    const base = await land({ source: c.source, text: BASELINE });
    const got = await land({ source: c.source, text: c.text });
    for (const w of where) {
      const own = typeof base?.[w] === 'string' ? views(base[w]).map(words) : [];
      const check = [...runs(c.text)].filter((r) => !own.some((o) => o.includes(r)));
      const miss = (why) => misses.push({ source: c.source, where: w, why });
      const raw = got?.[w];
      if (typeof raw !== 'string') { miss('nothing written (not a string)'); continue; }
      const vs = views(raw).map((v) => v.replace(/\r\n/g, '\n'));
      const hold = vs.filter((v) => v.includes(c.expect));
      if (!hold.length) miss('the exact fenced form is missing');
      // Each piece between the exact forms on its own, so text either side of a removed form can't join into a run.
      const pieces = (hold.length ? hold : vs).flatMap((v) => v.split(c.expect)).map(words);
      if (check.some((r) => pieces.some((p) => p.includes(r)))) miss('outside text appears outside its exact fence');
      if (Object.values(FAKE).some((k) => c.text.includes(k) && vs.some((v) => v.includes(k)))) miss('a planted fake key survived');
    }
  }
  return misses;
}
