// transcript-copy.mjs — M2's own append-only copy of a session's conversation log, with a tamper check (0b-5 spec review
// round 1 M2(a), round 2 m2-10).
//
// WHY. The owner's tap is read from the session's JSONL log, which any session of the owner's can write. Each pass copies
// the log's new, complete lines into a copy only orchestrate writes, keeping the byte offset and a hash of the prefix
// already copied. An answer counts only from the copy, and only while that prefix is unchanged: a rewritten or shortened
// log refuses every pending answer from that session for good and alerts once. This catches edits; it does not stop a
// forged line appended at the end (the accepted Tier-2 residual, round 1 M2(b); Tier-1 gos go through GitHub instead).
//
//   const copies = makeTranscriptCopies({ root });        root: a folder only orchestrate writes (made 0700)
//   copies.sync(sessionId, sourcePath) → { ok: true, tampered: false, added } | { ok: true, tampered: true, first }
//                                      | { ok: false, reason }    (a missing source is { ok: true, added: 0 })
//   copies.pending(sessionId) → [{ entry, end }]  lines copied but not yet processed, in order (malformed lines skipped)
//   copies.done(sessionId, end)                   mark processed up to byte `end` (process lines in order, M5-3)
//   copies.tampered(sessionId) → bool
//
// Only newline-terminated lines are copied, so a line still being written is never read half-way.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SID = /^[A-Za-z0-9-]{1,128}$/;
const MAX_NEW_BYTES = 64 * 1024 * 1024;

export function makeTranscriptCopies({ root } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('transcript copies need a folder');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const statePath = (sid) => join(root, `${sid}.state.json`);
  const copyPath = (sid) => join(root, `${sid}.jsonl`);
  const check = (sid) => { if (typeof sid !== 'string' || !SID.test(sid)) throw new Error('bad session id'); };

  function readState(sid) {
    if (!existsSync(statePath(sid))) return { offset: 0, prefix_sha256: hash(Buffer.alloc(0)), processed: 0, tampered: false };
    const s = JSON.parse(readFileSync(statePath(sid), 'utf8'));
    if (!Number.isSafeInteger(s.offset) || !Number.isSafeInteger(s.processed) || s.processed > s.offset || typeof s.prefix_sha256 !== 'string') throw new Error(`copy state for ${sid} is malformed`);
    return s;
  }
  function writeState(sid, s) {
    const tmp = `${statePath(sid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, statePath(sid));
  }

  return Object.freeze({
    sync(sid, sourcePath) {
      try {
        check(sid);
        const s = readState(sid);
        if (s.tampered) return { ok: true, tampered: true, first: false };
        if (!existsSync(sourcePath)) return { ok: true, tampered: false, added: 0 };
        const fd = openSync(sourcePath, 'r');
        let buf;
        try {
          const size = fstatSync(fd).size;
          if (size < s.offset) buf = null;
          else {
            const len = Math.min(size, s.offset + MAX_NEW_BYTES);
            buf = Buffer.alloc(len);
            let got = 0;
            while (got < len) { const n = readSync(fd, buf, got, len - got, got); if (!n) break; got += n; }
            buf = buf.subarray(0, got);
          }
        } finally { closeSync(fd); }
        if (!buf || buf.length < s.offset || hash(buf.subarray(0, s.offset)) !== s.prefix_sha256) {
          writeState(sid, { ...s, tampered: true, tampered_at: new Date().toISOString() });
          return { ok: true, tampered: true, first: true };
        }
        const lastNl = buf.lastIndexOf(0x0a);
        const end = lastNl + 1;
        if (end <= s.offset) return { ok: true, tampered: false, added: 0 };
        appendFileSync(copyPath(sid), buf.subarray(s.offset, end), { mode: 0o600 });
        writeState(sid, { ...s, offset: end, prefix_sha256: hash(buf.subarray(0, end)) });
        return { ok: true, tampered: false, added: end - s.offset };
      } catch (e) {
        return { ok: false, reason: `could not copy the log: ${String(e?.message ?? e).slice(0, 200)}` };
      }
    },
    pending(sid) {
      check(sid);
      const s = readState(sid);
      if (s.tampered || s.processed >= s.offset) return [];
      const text = readFileSync(copyPath(sid)).subarray(s.processed, s.offset);
      const out = [];
      let at = s.processed; let start = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== 0x0a) continue;
        const line = text.subarray(start, i).toString('utf8');
        const end = at + i + 1;
        start = i + 1;
        if (!line.trim()) continue;
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push({ entry, end });
      }
      // Lines after the last parsed one still advance `processed` when the caller marks the last end; a trailing run of
      // blank or malformed lines is skipped by the next call's start.
      if (!out.length) { writeState(sid, { ...s, processed: s.offset }); }
      return out;
    },
    done(sid, end) {
      check(sid);
      const s = readState(sid);
      if (!Number.isSafeInteger(end) || end < s.processed || end > s.offset) throw new Error('done() past the copied lines');
      writeState(sid, { ...s, processed: end });
    },
    tampered(sid) { check(sid); return readState(sid).tampered === true; },
  });
}

function hash(b) { return createHash('sha256').update(b).digest('hex'); }
