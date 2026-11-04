// The finding-checker and finalize (R-0b-145, L76 (4)). When a review session ends, before its verdict file's sha256
// goes into its ended record (review-runner.mjs `endSession`), the runner finalizes that one session's own file:
//   - each finding is checked against the head reviewed and where the change began; one whose file is on neither,
//     whose line is past the file's end on both, or whose quote neither bears out, is noise, and is marked dropped (it
//     stays in the notes, last, with the reason, so the next round and Joe can see it);
//   - repeats of the same finding are combined into one;
//   - what the verdict says is worked out again from what is left: an auditor's Material count loses the dropped
//     Material findings but never falls below the Material findings kept; a reviewer's checklist line that only noise
//     put at its level comes down to the worst finding left on it. pass turns true only when dropped noise was the whole
//     reason it was false, so never while a Material finding is kept, whether or not it names a line (L92 M-1).
// finalize reads and writes only the one verdict file in that session's own folder, in place (a temporary dot-named
// file, renamed over it, which the gate never lists). It never writes a second verdict, and it never reads or changes
// another session's: under L68 each launched session's own verdict counts and the worst wins, so nothing here can let
// one session's pass stand in for another's fail. A finding with nothing to check (no file named) is kept.

import { closeSync, fchmodSync, fchownSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { git, gitOk } from '../M4-workshop/git/safe-git.mjs';
import { kindOf, readOutboxFile, verdictFields } from '../M9-record/outbox.mjs';
import { VERDICT_CHECKLIST, CHECKLIST_LEVELS } from '../../shared/record.mjs';
import { FINDING_LEVELS, findingProblem, verdictFileText } from './verdict-file.mjs';

/** How far from its line a quote may be found, in lines either way. */
export const QUOTE_NEAR = 3;
/** What a reader gives for a path that is at the commit but is not a plain file (a link, say): no text to check. */
export const NOT_TEXT = Symbol('not a plain file');
const RANK = Object.freeze({ clean: 0, cosmetic: 1, minor: 2, material: 3 });
const worst = (levels) => levels.reduce((w, l) => (RANK[l] > RANK[w] ? l : w), 'clean');
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Does the quote stand in one of these runs of lines? Line by line, a line may carry its diff marker, and each may stand in a different run. */
function quoteHolds(quote, runs) {
  const hays = runs.map((lines) => squash(lines.join('\n')));
  const on = (t) => hays.some((h) => h.includes(t));
  if (on(squash(quote))) return true;
  const parts = quote.split('\n').map((l) => squash(l.replace(/^[+\- ]/, ''))).filter(Boolean);
  return parts.length > 0 && parts.every(on);
}

/**
 * Why a finding is noise, or null when it is kept. `readFile(path)` gives the file's text at the head reviewed and
 * `readBase(path)` where the change began: null when that commit has no such file, NOT_TEXT when the path is there but
 * is not a plain file. A review is of a diff, so a finding may be about what the change removes (L92 M-2): it is noise
 * only when neither side bears it out. A file the change deletes is never noise, and neither is a path with no text to check.
 */
export async function noiseReason(f, readFile, readBase) {
  if (f.file === undefined) return null;
  const head = await readFile(f.file);
  const base = await readBase(f.file);
  if (head === NOT_TEXT || base === NOT_TEXT) return null;
  if (typeof head !== 'string') return typeof base === 'string' ? null : `${f.file} is not in the head reviewed or where the change began`;
  const toLines = (text) => { const l = text.split('\n'); if (text.endsWith('\n')) l.pop(); return l; };
  const headLines = toLines(head);
  const baseLines = typeof base === 'string' ? toLines(base) : null;
  const sides = baseLines ? [headLines, baseLines] : [headLines];
  if (f.line !== undefined && sides.every((l) => f.line > l.length)) return `${f.file} has ${headLines.length} lines, not ${f.line}`;
  if (f.quote !== undefined) {
    const near = (lines) => (f.line === undefined ? lines : lines.slice(Math.max(0, f.line - 1 - QUOTE_NEAR), f.line + QUOTE_NEAR));
    if (quoteHolds(f.quote, sides.map(near))) return null;
    // Gone from the head but in the base: the change took it out. Its line may be counted on either side, so the whole
    // of the base is looked at. A quote the head still has elsewhere is only on the wrong line.
    if (baseLines && !quoteHolds(f.quote, [headLines]) && quoteHolds(f.quote, [headLines, baseLines])) return null;
    return `the quote is not in ${f.file}${f.line === undefined ? '' : ` near line ${f.line}`}`;
  }
  return null;
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
  const keptMaterial = kept.filter((f) => f.level === 'material').length;
  if (role === 'auditor') {
    const out = dropped.filter((f) => f.level === 'material').length;
    if (!out) return { pass, material };
    // The kept ones count whatever was written; a count above the list keeps what no finding accounts for.
    const left = Math.max(keptMaterial, material - out);
    return { pass: pass || (material > 0 && left === 0), material: left };
  }
  const next = { ...checklist };
  let lowered = false;
  for (const line of VERDICT_CHECKLIST) {
    const gone = dropped.filter((f) => f.on === line).map((f) => f.level);
    if (!gone.length) continue;
    const left = worst(kept.filter((f) => f.on === line).map((f) => f.level));
    // Only a line the noise explains comes down: its level is no worse than the worst dropped finding, and worse than
    // anything left on it.
    if (RANK[next[line]] <= RANK[worst(gone)] && RANK[next[line]] > RANK[left] && !(next[line] === 'material' && keptMaterial)) { if (next[line] === 'material') lowered = true; next[line] = left; }
  }
  const clean = VERDICT_CHECKLIST.every((l) => CHECKLIST_LEVELS.includes(next[l]) && next[l] !== 'material');
  return { pass: pass || (lowered && clean), checklist: next };
}

/**
 * Finalize one session's verdict file. `owner` is the review user's uid, given back to the rewritten file.
 * → { ok, changed, kept, dropped } | { ok: false, none?, reason } (a file that can't be finalized is left as it is, for
 * the runner's own read to judge)
 */
export async function finalize({ outboxRoot, uids, role, sessionId, card, head, readFile, readBase, owner }) {
  const no = (reason, none = false) => ({ ok: false, none, reason });
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
  const fresh = []; const before = [];
  for (const n of notes) {
    if (n && typeof n === 'object' && typeof n.dropped === 'string') { before.push(n); continue; }   // finalized before
    const p = findingProblem(n);
    if (p) return no(`a finding can't be checked: ${p}`);
    fresh.push(n);
  }
  const { kept, dropped } = await checkFindings(fresh, readFile, readBase);
  const said = settle({ role, pass: v.pass, checklist: v.checklist, material: v.material, kept, dropped });
  const order = (a, b) => FINDING_LEVELS.indexOf(a.level) - FINDING_LEVELS.indexOf(b.level);
  const findings = [...kept.sort(order), ...dropped, ...before];
  // Nothing dropped and no repeats: the file stays exactly as the session wrote it.
  if (!dropped.length && kept.length === fresh.length) return { ok: true, changed: false, kept: kept.length, dropped: 0 };
  let text;
  try { text = verdictFileText({ role, card, head, pass: said.pass, ...(role === 'reviewer' ? { checklist: said.checklist } : { material: said.material }), findings }); } catch (e) { return no(e?.message ?? String(e)); }
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
