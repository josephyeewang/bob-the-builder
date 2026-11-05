// The finding-checker and finalize (R-0b-145, L76 (4), L469). When a review session ends, before its verdict file's
// sha256 goes into its ended record (review-runner.mjs `endSession`), the runner finalizes that one session's own file.
// Finalize never drops a finding, and it changes no count and no pass: no matcher can prove a quote is absent, so what it
// finds is a label for the reader, nothing more. A finding whose file or quote it can't find, at the head reviewed or where
// the change began, gets `quote_found: false` and QUOTE_NOTE. Everything else in the file stays as the session wrote it.
// A file with nothing to label is not touched, and neither is one the labels would take over the outbox size limit, or
// one that names more files than the runner's pass has reads left for (MAX_CHECKED_PATHS).
// For a file it labels, finalize writes the sha256 of the file with its labels left out (M9 verdictContent) into the
// runner's own record (`mark`, finalized/ in the runner's folder, which no session can write), once the labelled file is
// ready and just before it goes in. M9 headReviews refuses a labelled file that record does not match. The record comes
// from finalize, so it can't vouch for finalize: the runner reads the file before and after, and refuses a verdict
// whose content moved (review-runner.mjs `endSession`, L482).
// finalize reads and writes only the one verdict file in that session's own folder, in place (a temporary dot-named
// file, renamed over it, which the gate never lists). It never writes a second verdict, and it never reads or changes
// another session's. A finding with nothing to check (no file named) gets no label.

import { closeSync, fchmodSync, fchownSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { git, gitOk } from '../M4-workshop/git/safe-git.mjs';
import { FINDING_LABELS, MAX_OUTBOX_BYTES, holdsLabel, kindOf, readOutboxFile, verdictContent, verdictFields } from '../M9-record/outbox.mjs';
import { findingProblem } from './verdict-file.mjs';

/** What a reader gives for a path that is at the commit but is not a plain file (a link, say): no text to check. */
export const NOT_TEXT = Symbol('not a plain file');
export const QUOTE_NOTE = 'quote not found in the code: check whether this finding is real';
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
 * Could the quote be in one of these texts? Only a label hangs on the answer. Headers, fences and lines with no letter or
 * digit are set aside, and a quote with nothing else holds. Of the rest, one line of at least SURE_LINE non-space
 * characters found in base or head is enough, or every shorter line found.
 */
function quoteHolds(quote, texts, squashed) {
  const hays = texts.map((t) => {
    if (!squashed.has(t)) squashed.set(t, squash(t));
    return squashed.get(t);
  });
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
 * Can this finding's file and quote be found? `readFile(path)` gives the file's text at the head reviewed and
 * `readBase(path)` where the change began: null when that commit has no such file, NOT_TEXT when the path is there but
 * is not a plain file. A review is of a diff, so a finding may be about what the change removes (L92 M-2): either side
 * will do, anywhere in the file. A line number is never looked at (L424). A path with no text to check counts as found.
 * `squashed` keeps each text's squashed form, for a caller checking many findings.
 */
export async function quoteFound(f, readFile, readBase, squashed = new Map()) {
  if (f.file === undefined) return true;
  const sides = [await readFile(f.file), await readBase(f.file)];
  if (sides.includes(NOT_TEXT)) return true;
  const texts = sides.filter((t) => typeof t === 'string');
  if (!texts.length) return false;
  return f.quote === undefined || quoteHolds(f.quote, texts, squashed);
}

/** A reader that goes to the mirror once for each path, however many findings name it. */
const oncePerPath = (read) => {
  const seen = new Map();
  return (path) => {
    if (!seen.has(path)) seen.set(path, read(path));
    return seen.get(path);
  };
};

/** The header with each finding's label set by `found`, one yes or no per finding, and nothing else different. Pure. */
export function labelled(header, found) {
  const notes = header.fields.notes.map((n, i) => {
    const rest = Object.fromEntries(Object.entries(n).filter(([k]) => !FINDING_LABELS.includes(k)));
    return found[i] ? rest : { ...rest, quote_found: false, quote_note: QUOTE_NOTE };
  });
  return { ...header, fields: { ...header.fields, notes } };
}

// How many files one runner pass reads for finalize, across every session it ends (L487). Each file costs up to four git
// calls. Measured on this repo's fixtures on 4 Nov 2026, 85 to 98 ms a file on a busy Mac: 5478 files took 466 s, past
// the 3 minutes after which the runner reads as stopped (review-runner.mjs STATUS_STALE_MS). Measured through the real
// readers with every quote unfound and both sides read (audit of #67 r2): 1000 files of 2 KB took 136 s, 1000 of 39 KB 94 s,
// 200 of 977 KB 22 s.
export const MAX_CHECKED_PATHS = 1000;

/**
 * Label one session's verdict file. `owner` is the review user's uid, given back to the rewritten file. `mark` is the
 * runner's own record of what finalize labelled: read() → the sha256, or null when there is none; keep(sha256), once.
 * `checks` is what is left of the pass's file reads: { left }, one object for the whole pass.
 * → { ok, changed, labelled? } | { ok: false, none?, reason } (a file that can't be labelled is left as it is, for the
 * runner's own read to judge)
 */
export async function finalize({ outboxRoot, uids, role, sessionId, card, head, readFile, readBase, owner, mark, checks = { left: MAX_CHECKED_PATHS } }) {
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
  const v = verdictFields(f.header);
  if (!v.ok) return no(v.reason);
  if (v.card !== card || v.head !== head) return no('the verdict is for another card or head');
  if (f.body.trim()) return no('the verdict file has more than its one line');
  const notes = v.notes ?? [];
  if (!Array.isArray(notes)) return no('its notes are not a list');
  if (!notes.length) return { ok: true, changed: false, labelled: 0 };
  for (const n of notes) {
    const p = findingProblem(n);
    if (p) return no(`a finding can't be checked: ${p}`);
  }
  const paths = new Set(notes.map((n) => n.file).filter((p) => p !== undefined)).size;
  if (paths > checks.left) return no('labels skipped: the review names more files than this pass can check');
  checks.left -= paths;
  const found = [];
  const [head1, base1, squashed] = [oncePerPath(readFile), oncePerPath(readBase), new Map()];
  for (const n of notes) found.push(await quoteFound(n, head1, base1, squashed));
  const next = labelled(f.header, found);
  const count = found.filter((x) => !x).length;
  // Nothing to label: the file stays exactly as the session wrote it.
  if (!count && !holdsLabel(notes)) return { ok: true, changed: false, labelled: 0 };
  const text = JSON.stringify(next);
  // A label must not turn a file that fits into one that is refused for its size.
  if (Buffer.byteLength(`${text}\n`) > MAX_OUTBOX_BYTES) return no('labels skipped: the file would be too large');
  const sha = verdictContent(f.header);
  const keepRecord = () => {
    try { if (mark.read() !== sha) mark.keep(sha); return null; } catch (e) { return `the runner's record of it could not be written (${e?.code ?? e?.message})`; }
  };
  if (text === JSON.stringify(f.header)) {
    const bad = keepRecord();
    return bad ? no(bad) : { ok: true, changed: false, labelled: count };
  }
  // The temporary file comes first, the record next, the rename last. A session's own file in the temporary file's place
  // stops finalize before there is a record, so a label it wrote can't get one. A stop before the rename leaves a record
  // of a file not there yet, and a run after it works out the same record. A rename first could leave a labelled file
  // the runner has no record of.
  const tmp = join(dir, `.finalize-${sessionId}`);
  let fd; let bad = null;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    writeSync(fd, `${text}\n`);
    fchmodSync(fd, 0o644);
    if (Number.isInteger(owner)) fchownSync(fd, owner, -1);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    bad = keepRecord();
    if (!bad) renameSync(tmp, file);
  } catch (e) {
    bad = `the labelled verdict could not be written (${e?.code ?? e?.message})`;
  }
  if (!bad) return { ok: true, changed: true, labelled: count };
  if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  try { unlinkSync(tmp); } catch { /* not made */ }
  return no(bad);
}

/**
 * finalize's two readers, from the mirror: { readFile, readBase }. A git failure throws, here or in a reader, so finalize
 * stops and the file stays as written: a finding gets no label because the mirror could not answer.
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
