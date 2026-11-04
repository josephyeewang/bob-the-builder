// The finding-checker and finalize (R-0b-145, L76 (4)). When a review session ends, before its verdict file's sha256
// goes into its ended record (review-runner.mjs `endSession`), the runner finalizes that one session's own file:
//   - each finding is checked against the head reviewed and where the change began; one whose file is on neither, or
//     whose quote stands nowhere in either whole file, is noise, and is marked dropped (it stays in the notes, last, with
//     the reason, so the next round and Joe can see it). A line number is never a reason to drop (L424): a real quote on
//     a wrong line is kept, which costs a false fail, never a false pass;
//   - repeats of the same finding are combined into one;
//   - what the verdict says is worked out again from what is left: an auditor's Material count loses the dropped
//     Material findings but never falls below the Material findings kept; a reviewer's checklist line that only noise
//     put at its level comes down to the worst finding left on it. pass turns true only when dropped noise was the whole
//     reason it was false. Any kept Material finding makes the verdict a fail, whatever pass and the count say, whether
//     or not it names a line and whether or not anything was dropped (L92 M-1, L424);
//   - a file it rewrites is marked `finalized`, and only such a file may hold a finding with a `dropped` key (M9
//     verdictFields refuses any other), so a mark copied from an earlier round's notes never hides a finding. The file
//     is the session's to write, so that mark alone proves nothing: finalize first writes the new file's sha256 into the
//     runner's own record (`mark`, finalized/ in the runner's folder, which no session can write), and M9 trusts a
//     `dropped` finding only in the file that record names (headReviews, L432).
// finalize reads and writes only the one verdict file in that session's own folder, in place (a temporary dot-named
// file, renamed over it, which the gate never lists). It never writes a second verdict, and it never reads or changes
// another session's: under L68 each launched session's own verdict counts and the worst wins, so nothing here can let
// one session's pass stand in for another's fail. A finding with nothing to check (no file named) is kept.

import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, fchownSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { git, gitOk } from '../M4-workshop/git/safe-git.mjs';
import { keptMaterial, kindOf, readOutboxFile, verdictAsWritten } from '../M9-record/outbox.mjs';
import { VERDICT_CHECKLIST, CHECKLIST_LEVELS } from '../../shared/record.mjs';
import { FINDING_LEVELS, findingProblem, verdictFileText } from './verdict-file.mjs';

/** What a reader gives for a path that is at the commit but is not a plain file (a link, say): no text to check. */
export const NOT_TEXT = Symbol('not a plain file');
const RANK = Object.freeze({ clean: 0, cosmetic: 1, minor: 2, material: 3 });
const worst = (levels) => levels.reduce((w, l) => (RANK[l] > RANK[w] ? l : w), 'clean');
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
// Lines that say nothing either way: a diff's headers, and what a paste wraps a quote in. They stand in neither file.
const HEADER = /^\s*(@@ .* @@|diff --git |index [0-9a-f]+\.\.|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null)|\\ No newline at end of file|(new|deleted) file mode |old mode |new mode |similarity index |rename (from|to) |Binary files )/;
const FENCE = /^\s*(\x60{3}|~~~)/;
const WORD = /[\p{L}\p{N}]/u;
// A line this long is one a real quote would hold, so one of them found is enough to keep the finding (L452).
const SURE_LINE = 8;
// What grep -n or cat -n puts before a line.
const LINE_NUMBER = /^\s*(?:[^\s:]+:)?\d+[:\t ]/;
const noMarker = (l) => squash(l.replace(/^[+\- ]/, ''));
const readings = (l) => {
  const bare = l.replace(LINE_NUMBER, '');
  return [noMarker(l), squash(bare), noMarker(bare)].filter(Boolean);
};

/**
 * Could the quote be in one of these texts? Noise needs the quote shown to be absent, so whatever can't be told keeps the
 * finding (L464). Headers, fences and lines with no letter or digit are set aside, and a quote with nothing else holds.
 * Of the rest, one line of at least SURE_LINE non-space characters found in base or head is enough, or every shorter line
 * found: a long line that is missing proves nothing about a short one beside it. The cost is only ever a false fail.
 */
function quoteHolds(quote, texts) {
  const hays = texts.map(squash);
  const on = (t) => hays.some((h) => h.includes(t));
  if (on(squash(quote))) return true;
  const left = quote.split(/\r\n|\r|\n/).filter((l) => !HEADER.test(l) && !FENCE.test(l) && WORD.test(l));
  if (!left.length) return true;
  const found = (l) => readings(l).some(on);
  const isSure = (l) => noMarker(l).replaceAll(' ', '').length >= SURE_LINE;
  const short = left.filter((l) => !isSure(l));
  return left.filter(isSure).some(found) || (short.length > 0 && short.every(found));
}

/**
 * Why a finding is noise, or null when it is kept. `readFile(path)` gives the file's text at the head reviewed and
 * `readBase(path)` where the change began: null when that commit has no such file, NOT_TEXT when the path is there but
 * is not a plain file. A review is of a diff, so a finding may be about what the change removes (L92 M-2): it is noise
 * only when neither side bears it out, in the whole of either file (L424). A path with no text to check is never noise.
 */
export async function noiseReason(f, readFile, readBase) {
  if (f.file === undefined) return null;
  const sides = [await readFile(f.file), await readBase(f.file)];
  if (sides.includes(NOT_TEXT)) return null;
  const texts = sides.filter((t) => typeof t === 'string');
  if (!texts.length) return `${f.file} is not in the head reviewed or where the change began`;
  if (f.quote === undefined || quoteHolds(f.quote, texts)) return null;
  return `the quote is not in ${f.file}`;
}

/** → { kept, dropped: [{ ...finding, dropped: reason }] }; repeats are combined, first one kept. */
export async function checkFindings(findings, readFile, readBase) {
  const seen = new Set();
  const kept = []; const dropped = [];
  for (const f of findings) {
    const k = JSON.stringify([f.level, squash(f.says), f.file ?? null, f.line ?? null, f.quote === undefined ? null : squash(f.quote), f.on ?? null]);
    if (seen.has(k)) continue;
    seen.add(k);
    const why = await noiseReason(f, readFile, readBase);
    if (why) dropped.push({ ...f, dropped: why }); else kept.push(f);
  }
  return { kept, dropped };
}

/** What the verdict says once the noise is out (see the top). Pure. */
export function settle({ role, pass, checklist, material, kept, dropped }) {
  const stays = keptMaterial(kept);
  if (role === 'auditor') {
    const out = dropped.filter((f) => f.level === 'material').length;
    // The kept ones count whatever was written; a count above the list keeps what no finding accounts for. A verdict
    // that gave no count gains none: it stays one M9 does not pass.
    const left = Math.max(stays, (material ?? 0) - out);
    return { pass: !stays && (pass || (material > 0 && left === 0)), material: material === null && !left ? null : left };
  }
  const next = { ...checklist };
  let lowered = false;
  for (const line of VERDICT_CHECKLIST) {
    const gone = dropped.filter((f) => f.on === line).map((f) => f.level);
    if (!gone.length) continue;
    const left = worst(kept.filter((f) => f.on === line).map((f) => f.level));
    // Only a line the noise explains comes down: its level is no worse than the worst dropped finding, and worse than
    // anything left on it.
    if (RANK[next[line]] <= RANK[worst(gone)] && RANK[next[line]] > RANK[left] && !(next[line] === 'material' && stays)) { if (next[line] === 'material') lowered = true; next[line] = left; }
  }
  const clean = VERDICT_CHECKLIST.every((l) => CHECKLIST_LEVELS.includes(next[l]) && next[l] !== 'material');
  return { pass: !stays && (pass || (lowered && clean)), checklist: next };
}

/**
 * Finalize one session's verdict file. `owner` is the review user's uid, given back to the rewritten file. `mark` is
 * the runner's own record of what it finalized: read() → the sha256, or null when there is none; keep(sha256), once.
 * → { ok, changed, kept?, dropped? } | { ok: false, none?, reason } (a file that can't be finalized is left as it is,
 * for the runner's own read to judge)
 */
export async function finalize({ outboxRoot, uids, role, sessionId, card, head, readFile, readBase, owner, mark }) {
  const no = (reason, none = false) => ({ ok: false, none, reason });
  if (typeof mark?.read !== 'function' || typeof mark?.keep !== 'function') return no('the runner gave no record to mark what it finalizes');
  const dir = join(outboxRoot, role, sessionId);
  let names;
  try { names = readdirSync(dir).filter((n) => !n.startsWith('.') && kindOf(n) === 'verdict-'); } catch (e) { return no(`its outbox folder could not be listed (${e?.code ?? e})`); }
  if (!names.length) return no('no verdict was handed in', true);
  if (names.length > 1) return no('more than one verdict file was left, so none is finalized');
  const file = join(dir, names[0]);
  const f = readOutboxFile({ outboxRoot, uids, tag: { role, sessionId }, file });
  if (!f.ok) return no(f.reason);
  // As written: a file that says two things at once is what finalize settles.
  const v = verdictAsWritten(f.header);
  if (!v.ok) return no(v.reason);
  if (v.card !== card || v.head !== head) return no('the verdict is for another card or head');
  if (f.body.trim()) return no('the verdict file has more than its one line');
  // A file that says it was finalized: only the runner's record can say so. Run again on a file it did mark, nothing
  // changes, so what it dropped stays dropped.
  if (f.header.fields.finalized === true) {
    let own; try { own = mark.read(); } catch (e) { return no(e?.message ?? String(e)); }
    return own === f.sha256 ? { ok: true, changed: false } : no('the file says it was finalized, but the runner holds no record of that file');
  }
  const notes = v.notes ?? [];
  if (!Array.isArray(notes)) return no('its notes are not a list');
  const fresh = [];
  for (const n of notes) {
    const p = findingProblem(n);
    if (p) return no(`a finding can't be checked: ${p}`);
    fresh.push(n);
  }
  const { kept, dropped } = await checkFindings(fresh, readFile, readBase);
  const said = settle({ role, pass: v.pass, checklist: v.checklist, material: v.material, kept, dropped });
  const order = (a, b) => FINDING_LEVELS.indexOf(a.level) - FINDING_LEVELS.indexOf(b.level);
  const findings = [...kept.sort(order), ...dropped];
  // Nothing dropped, no repeats and nothing to correct: the file stays exactly as the session wrote it.
  const same = said.pass === v.pass && (role === 'reviewer' || said.material === v.material);
  if (!dropped.length && kept.length === fresh.length && same) return { ok: true, changed: false, kept: kept.length, dropped: 0 };
  let text;
  try { text = verdictFileText({ role, card, head, pass: said.pass, ...(role === 'reviewer' ? { checklist: said.checklist } : { material: said.material }), findings, finalized: true }); } catch (e) { return no(e?.message ?? String(e)); }
  // The record comes first: a stop before the rename leaves a record of a file not there yet, and a run after it works
  // out the same bytes. The other way round, a stop would leave a marked file the runner could not tell from a forged one.
  const sha = createHash('sha256').update(text).digest('hex');
  try { if (mark.read() !== sha) mark.keep(sha); } catch (e) { return no(`the runner's record of it could not be written (${e?.code ?? e?.message})`); }
  const tmp = join(dir, `.finalize-${sessionId}`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    writeSync(fd, text);
    fchmodSync(fd, 0o644);
    if (Number.isInteger(owner)) fchownSync(fd, owner, -1);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(tmp); } catch { /* not made */ }
    return no(`the finalized verdict could not be written (${e?.code ?? e?.message})`);
  }
  return { ok: true, changed: true, kept: kept.length, dropped: dropped.length };
}

/**
 * finalize's two readers, from the mirror: { readFile, readBase }. A git failure throws, here or in a reader, so finalize
 * stops and the file stays as written: a finding is never noise because the mirror could not answer.
 */
export async function changeReaders({ gitDir, head }) {
  const opts = { gitDir, purpose: 'finding-check', timeoutMs: 60_000 };
  const at = (commit) => async (path) => {
    const entry = await gitOk(['ls-tree', '-z', commit, '--', path], opts);
    if (!entry) return null;
    if (!entry.startsWith('100')) return NOT_TEXT;
    const r = await git(['cat-file', 'blob', `${commit}:${path}`], opts);
    if (r.code !== 0) throw new Error(`${path} could not be read at ${commit}`);
    return new TextDecoder('utf-8').decode(r.stdout);
  };
  const base = (await gitOk(['merge-base', 'refs/heads/main', head], opts)).trim();
  return { readFile: at(head), readBase: at(base) };
}
