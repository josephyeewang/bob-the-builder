// The finding-checker and finalize (R-0b-145, L76 (4)). When a review session ends, before its verdict file's sha256
// goes into its ended record (review-runner.mjs `endSession`), the runner finalizes that one session's own file:
//   - each finding is checked against the head reviewed; one whose file is not there, whose line is past the file's
//     end, or whose quote is not on or near its line, is noise, and is marked dropped (it stays in the notes, last, with
//     the reason, so the next round and Joe can see it);
//   - repeats of the same finding are combined into one;
//   - what the verdict says is worked out again from what is left: an auditor's Material count loses the dropped
//     Material findings; a reviewer's checklist line that only noise put at its level comes down to the worst finding
//     left on it. pass turns true only when dropped noise was the whole reason it was false.
// finalize reads and writes only the one verdict file in that session's own folder, in place (a temporary dot-named
// file, renamed over it, which the gate never lists). It never writes a second verdict, and it never reads or changes
// another session's: under L68 each launched session's own verdict counts and the worst wins, so nothing here can let
// one session's pass stand in for another's fail. A finding with nothing to check (no file named) is kept.

import { closeSync, fchmodSync, fchownSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { git } from '../M4-workshop/git/safe-git.mjs';
import { kindOf, readOutboxFile, verdictFields } from '../M9-record/outbox.mjs';
import { VERDICT_CHECKLIST, CHECKLIST_LEVELS } from '../../shared/record.mjs';
import { FINDING_LEVELS, findingProblem, verdictFileText } from './verdict-file.mjs';

/** How far from its line a quote may be found, in lines either way. */
export const QUOTE_NEAR = 3;
const RANK = Object.freeze({ clean: 0, cosmetic: 1, minor: 2, material: 3 });
const worst = (levels) => levels.reduce((w, l) => (RANK[l] > RANK[w] ? l : w), 'clean');
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Why a finding is noise at this head, or null when it is kept. `readFile(path)` gives the file's text at the head
 * reviewed, or null when there is no such file.
 */
export async function noiseReason(f, readFile) {
  if (f.file === undefined) return null;
  const text = await readFile(f.file);
  if (typeof text !== 'string') return `${f.file} is not in the head reviewed`;
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (f.line !== undefined && f.line > lines.length) return `${f.file} has ${lines.length} lines, not ${f.line}`;
  if (f.quote !== undefined) {
    const want = squash(f.quote);
    const from = f.line === undefined ? 0 : Math.max(0, f.line - 1 - QUOTE_NEAR);
    const to = f.line === undefined ? lines.length : Math.min(lines.length, f.line + QUOTE_NEAR);
    if (!squash(lines.slice(from, to).join('\n')).includes(want)) return `the quote is not in ${f.file}${f.line === undefined ? '' : ` near line ${f.line}`}`;
  }
  return null;
}

/** → { kept, dropped: [{ ...finding, dropped: reason }] }; repeats are combined, first one kept. */
export async function checkFindings(findings, readFile) {
  const seen = new Set();
  const kept = []; const dropped = [];
  for (const f of findings) {
    const k = JSON.stringify([f.level, squash(f.says), f.file ?? null, f.line ?? null, f.quote === undefined ? null : squash(f.quote), f.on ?? null]);
    if (seen.has(k)) continue;
    seen.add(k);
    const why = await noiseReason(f, readFile);
    if (why) dropped.push({ ...f, dropped: why }); else kept.push(f);
  }
  return { kept, dropped };
}

/** What the verdict says once the noise is out (see the top). Pure. */
export function settle({ role, pass, checklist, material, kept, dropped }) {
  if (role === 'auditor') {
    const out = dropped.filter((f) => f.level === 'material').length;
    const left = Math.max(0, material - out);
    return { pass: pass || (material > 0 && out > 0 && left === 0), material: left };
  }
  const next = { ...checklist };
  let lowered = false;
  for (const line of VERDICT_CHECKLIST) {
    const gone = dropped.filter((f) => f.on === line).map((f) => f.level);
    if (!gone.length) continue;
    const left = worst(kept.filter((f) => f.on === line).map((f) => f.level));
    // Only a line the noise explains comes down: its level is no worse than the worst dropped finding, and worse than
    // anything left on it.
    if (RANK[next[line]] <= RANK[worst(gone)] && RANK[next[line]] > RANK[left]) { if (next[line] === 'material') lowered = true; next[line] = left; }
  }
  const clean = VERDICT_CHECKLIST.every((l) => CHECKLIST_LEVELS.includes(next[l]) && next[l] !== 'material');
  return { pass: pass || (lowered && clean), checklist: next };
}

/**
 * Finalize one session's verdict file. `owner` is the review user's uid, given back to the rewritten file.
 * → { ok, changed, kept, dropped } | { ok: false, none?, reason } (a file that can't be finalized is left as it is, for
 * the runner's own read to judge)
 */
export async function finalize({ outboxRoot, uids, role, sessionId, card, head, readFile, owner }) {
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
  const { kept, dropped } = await checkFindings(fresh, readFile);
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

/** readFile for finalize: a file's text at the head reviewed, read from the mirror; null when the head has no such file. */
export function headFileReader({ gitDir, head }) {
  return async (path) => {
    const r = await git(['cat-file', 'blob', `${head}:${path}`], { gitDir, purpose: 'finding-check', timeoutMs: 60_000 });
    return r.code === 0 ? new TextDecoder('utf-8').decode(r.stdout) : null;
  };
}
