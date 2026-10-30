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
// `land` is called once per source first with CANARY, a sentence no lane writes itself: any run of it outside its
// exact form, in any output of the check, is a miss (a lane that keeps something from its first call, or a store that
// already holds raw text). Then with BASELINE, a neutral text of the same kind: what it writes then is the
// lane's own wording (a safety note, headings), the reference. Then, per case, once with BASELINE again and once with
// the planted text. A miss is any of:
// - the exact expected form is absent, or no more often than in the call just before (this call did not write it);
// - in ANY output of the check (the baseline calls too), once every exact form is taken out, a run of RUN letters or
//   digits of any case landed so far shows up more often than in the reference. Deny by default: case, spaces,
//   punctuation, backslashes, invisible characters and fence tags are ignored, so a raw, partial, re-cased,
//   re-wrapped, shell-quoted or earlier item's copy is caught, in a fence the lane wrote itself or not (audit rounds 1-4);
// - a planted fake key shows up more often than in the reference.
// Strings are compared as written and with JSON escapes undone (up to three levels), so a JSON record passes; CRLF line
// ends count as LF. Hand back the text as written: a form indented or quoted line by line (YAML block, `> ` quote) does
// not match and fails closed. A leak miss names the run and the case it came from (`run`, `from`), so a lane can tell
// its own wording that happens to share 12 letters with a planted case (that fails closed: reword it). Each call is a new item (a lane that files by a fixed id must take a fresh one per call),
// and `land` should hand back what this call wrote for it: from fresh state, or only this item. Per-item wording that
// shares a run with a planted case fails closed, so a file rebuilt from a growing store must keep it neutral. A second fenced copy of part of the text
// (a title from the first line) is a miss, as is a file name or slug built from it: store the exact form or a neutral
// id. A raw copy deliberately cut into pieces under RUN letters (or encoded) is out of scope, like base64.

import { readFileSync } from 'node:fs';
import { FAKE } from './fakes.mjs';
import { cleanOutside } from './escape.mjs';

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
export const CANARY = 'Canary sentence: zebra quartz marmalade violin.';
const runs = (text) => { const w = words(text); const out = new Set(); for (let i = 0; i + RUN <= w.length; i++) out.add(w.slice(i, i + RUN)); return out; };

// How many times `r` appears, overlaps counted.
const occ = (s, r) => { let n = 0; for (let i = s.indexOf(r); i >= 0; i = s.indexOf(r, i + 1)) n++; return n; };

export async function checkOutsideJoin(land, { sources = JOIN_SOURCES, where = JOIN_OUTPUTS } = {}) {
  checkList(where, JOIN_OUTPUTS, 'where');
  const cases = joinCases(sources).map((c) => ({ ...c, runs: [...runs(c.text)] }));
  const srcs = [...new Set(cases.map((c) => c.source))];
  const canary = { text: CANARY, runs: [...runs(CANARY)] };
  // Every exact form, sources asked for or not (and the canary's), so a store already holding correct forms is clean.
  const forms = [...new Set([...joinCases().map((c) => c.expect), ...srcs.map((s) => cleanOutside(CANARY, s))])]
    .sort((x, y) => y.length - x.length);
  const prep = (raw) => views(raw).map((v) => v.replace(/\r\n/g, '\n'));
  const formCount = (v) => forms.reduce((n, e) => n + v.split(e).length - 1, 0);
  // The text left once every exact form is out: each piece on its own (text either side of a removed form can't join
  // into a run), from the views that hold the most forms (so one backslash can't hide a copy in a lesser view).
  const left = (raw) => {
    const vs = prep(raw); const n = vs.map(formCount); const top = Math.max(...n);
    // Per view, how often each RUN-letter window appears, counted once so each run is a lookup (round 5 m3).
    return vs.filter((_, i) => n[i] === top).map((v) => {
      const m = new Map();
      for (const p of forms.reduce((ps, e) => ps.flatMap((x) => x.split(e)), [v]).map(words)) {
        for (let i = 0; i + RUN <= p.length; i++) { const k = p.slice(i, i + RUN); m.set(k, (m.get(k) ?? 0) + 1); }
      }
      return m;
    });
  };
  const runCount = (l, r) => Math.max(...l.map((m) => m.get(r) ?? 0));
  const keyCount = (raw, k) => Math.max(...prep(raw).map((v) => occ(v, k)));
  const misses = [];
  const ref = {};
  for (const s of srcs) {
    for (const w of where) ref[`${s}|${w}`] = { raw: '', left: left('') };
    const first = await land({ source: s, text: CANARY });
    const got = await land({ source: s, text: BASELINE });
    for (const w of where) {
      for (const o of [first?.[w], got?.[w]]) if (typeof o === 'string') leaksOf(o, s, w, [canary]);
      const raw = typeof got?.[w] === 'string' ? got[w] : '';
      ref[`${s}|${w}`] = { raw, left: left(raw) };
    }
  }
  const seen = [canary];
  // Every output is checked for every case landed so far, against the reference's counts (the canary against none).
  function leaksOf(raw, source, w, among, note = '') {
    const l = left(raw); const r0 = ref[`${source}|${w}`];
    const miss = (why, extra = {}) => misses.push({ source, where: w, why: `${why}${note}`, ...extra });
    for (const t of among) {
      const r = t.runs.find((x) => runCount(l, x) > (t === canary ? 0 : runCount(r0.left, x)));
      if (r) { miss('outside text appears outside its exact fence', { run: r, from: t.source ?? 'canary' }); break; }
    }
    if (Object.values(FAKE).some((k) => among.some((t) => t.text.includes(k)) && keyCount(raw, k) > keyCount(r0.raw, k))) miss('a planted fake key survived');
  }
  for (const c of cases) {
    const base = await land({ source: c.source, text: BASELINE });
    seen.push(c);
    const got = await land({ source: c.source, text: c.text });
    for (const w of where) {
      const raw = got?.[w];
      if (typeof raw !== 'string') { misses.push({ source: c.source, where: w, why: 'nothing written (not a string)' }); continue; }
      const before = typeof base?.[w] === 'string' ? Math.max(...prep(base[w]).map((v) => v.split(c.expect).length - 1)) : 0;
      if (Math.max(...prep(raw).map((v) => v.split(c.expect).length - 1)) <= before) misses.push({ source: c.source, where: w, why: 'the exact fenced form is missing' });
      leaksOf(raw, c.source, w, seen);
      // The call just before is an output too: an earlier item written there raw (a lane that fences only its newest).
      if (typeof base?.[w] === 'string') leaksOf(base[w], c.source, w, seen, ' (in the output for a neutral text)');
    }
  }
  return misses;
}
