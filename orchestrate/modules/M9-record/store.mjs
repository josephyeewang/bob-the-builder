// store.mjs — the files of one product's record, written so a crash leaves the old or the new version, never half
// (0b-2 R-0b-20, R-0b-24, M-4, M-7, R2-M11, R2-m3, R2-m4).
//
// WHY. The diary is the record's truth: each accepted write appends one line holding the full new document(s), and that
// line is the commit point. The document files are copies kept for reading by eye and for tamper checks. Any file that
// doesn't match its diary line was changed by something other than the Store Writer: it is restored from the diary,
// the changed copy is kept in quarantine/, and an alert fires.
//
// Layout under `root` (a required argument; the real path is the owner's launcher setting):
//   docs/<entity>/<id>.json   diary.jsonl   lock   break.lock   tmp/   quarantine/   refusals.jsonl   outbox-seen.jsonl
// Folders are 755 and files 644, set with chmod whatever the umask.
//
// Write path (tx.commit): lock → temp file + fsync → nonce re-check → diary line + fsync (commit point) → rename →
// folder fsync → unlock. `faultAt` (a constructor option only, never read from the environment) kills or stops the
// process right after one of FAULT_POINTS, for the crash tests.
//
//   const store = openStore({ root, ownerUid, alert, now })
//   store.read(entity, id) / store.list(entity) / store.lines({ since })
//   store.transaction((tx) => { tx.current(e, id); tx.commit(writes, meta); tx.seen(key); tx.markSeen(key) })
//   store.recover()   // runs under the lock at the first lock in each process and after a dead holder's lock is broken

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, ftruncateSync, unlinkSync, writeFileSync, writeSync, appendFileSync, constants } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { makeLock, processDead, realProbe, sleepMs } from './lock.mjs';

export const FAULT_POINTS = Object.freeze(['locked', 'temp_written', 'diary_torn', 'diary_written', 'renamed', 'dir_synced', 'released']);
// Test faults that don't kill the process: a failed append, a short write, and a line that reads back wrong.
const TEST_FAULTS = Object.freeze(['append_fails', 'short_write', 'readback_wrong']);
// Not a kill: `append_fails` makes the diary append fail partway (a full disk), for the cut-back test.

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const docBytes = (entity, id, rev, doc) => `${JSON.stringify({ entity, id, rev, doc })}\n`;

function fsyncPath(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Every level this makes is 755, not only the last: under a umask of 077 the levels between would be 700 (0b-2 audit MIN-6).
function mkdir755(path) {
  const first = mkdirSync(path, { recursive: true });
  if (first) for (let p = path; ; p = dirname(p)) { chmodSync(p, 0o755); if (p === first || p === dirname(p)) break; }
  chmodSync(path, 0o755);
}
function readOrNull(path) { try { return readFileSync(path); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } }

export function openStore({ root, ownerUid, alert = () => {}, now = () => Date.now(), host = hostname(), lockTimeoutMs = 10000,
  probe = realProbe, faultAt, testNoLock = false } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('store root must be an absolute path');
  if (!Number.isInteger(ownerUid)) throw new Error('store needs the owner uid (ownerUid)');
  if (typeof process.getuid === 'function' && process.getuid() !== ownerUid) throw new Error(`the Store Writer runs only as the store's owner (uid ${ownerUid}), not uid ${process.getuid()}`);
  if (faultAt !== undefined) {
    const step = typeof faultAt === 'string' ? faultAt : faultAt?.step;
    if (!FAULT_POINTS.includes(step) && !TEST_FAULTS.includes(step)) throw new Error(`unknown fault point ${step}`);
  }

  const P = { docs: join(root, 'docs'), tmp: join(root, 'tmp'), quarantine: join(root, 'quarantine'), diary: join(root, 'diary.jsonl'),
    refusals: join(root, 'refusals.jsonl'), seen: join(root, 'outbox-seen.jsonl') };
  for (const d of [root, P.docs, P.tmp, P.quarantine]) mkdir755(d);
  for (const f of [P.diary, P.refusals, P.seen]) { if (!existsSync(f)) writeFileSync(f, '', { mode: 0o644, flag: 'a' }); chmodSync(f, 0o644); }

  const lock = makeLock({ dir: root, host, timeoutMs: lockTimeoutMs, probe, disabled: testNoLock });
  const say = (event) => { try { alert({ at: new Date(now()).toISOString(), ...event }); } catch { /* the sink never stops a write */ } };
  const docPath = (entity, id) => join(P.docs, entity, `${id}.json`);
  const keyOf = (entity, id) => `${entity}/${id}`;

  // ---- the diary index, read forward from the last complete line ----
  let index = new Map();
  let lines = [];
  let offset = 0;
  let lastSeq = 0;
  let damaged = null;   // a reason, once the diary is found broken in a way recover() can't mend; writes then refuse

  function reset() { index = new Map(); lines = []; offset = 0; lastSeq = 0; damaged = null; }

  function absorb(line) {
    if (!line || !Number.isInteger(line.seq) || !Array.isArray(line.writes) || !line.writes.length) throw new Error('diary line has no seq or writes');
    if (line.seq !== lastSeq + 1) throw new Error(`diary seq ${line.seq} after ${lastSeq} (a gap)`);
    for (const w of line.writes) {
      const k = keyOf(w.entity, w.id);
      const cur = index.get(k);
      if ((cur?.hash ?? null) !== (w.prev_hash ?? null)) throw new Error(`diary line ${line.seq}: ${k} prev_hash doesn't match the version before it`);
      if (w.rev !== (cur?.rev ?? 0) + 1) throw new Error(`diary line ${line.seq}: ${k} rev ${w.rev} after ${cur?.rev ?? 0}`);
      if (sha256(docBytes(w.entity, w.id, w.rev, w.doc)) !== w.doc_hash) throw new Error(`diary line ${line.seq}: ${k} doc_hash doesn't match its doc`);
      const stateChanged = (cur?.doc?.state ?? null) !== (w.doc?.state ?? null);
      index.set(k, { entity: w.entity, id: w.id, rev: w.rev, doc: w.doc, hash: w.doc_hash, prevHash: cur?.hash ?? null, seq: line.seq,
        ts: line.ts, createdBy: cur?.createdBy ?? line.actor, createdKind: cur?.createdKind ?? line.kind, stateSince: !cur || stateChanged ? line.ts : cur.stateSince });
    }
    lastSeq = line.seq;
    lines.push(line);
  }

  function fstatOf(path) { const fd = openSync(path, constants.O_RDONLY); try { return fstatSync(fd).size; } finally { closeSync(fd); } }
  function refresh() {
    let fd;
    try { fd = openSync(P.diary, constants.O_RDONLY); } catch (e) { throw new Error(`diary unreadable: ${e?.code ?? e}`); }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) { reset(); }   // shorter than we read: cut by recover() in another process, or replaced; read again
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      let got = 0;
      while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, offset + got); if (!n) break; got += n; }
      const text = buf.subarray(0, got).toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return;   // only a partial line so far
      for (const raw of text.slice(0, end).split('\n')) {
        if (damaged) break;
        try { absorb(JSON.parse(raw)); } catch (e) { damaged = String(e?.message ?? e).slice(0, 200); say({ type: 'diary_damaged', reason: damaged }); }
      }
      offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
    } finally { closeSync(fd); }
  }

  // ---- files ----
  function writeDocFile(entity, id, bytes, tag) {
    mkdir755(join(P.docs, entity));
    const tmp = join(P.tmp, `${process.pid}-${tag}-${randomBytes(4).toString('hex')}.json`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o644);
    return tmp;
  }
  function quarantine(entity, id, bytes, why) {
    const q = join(P.quarantine, `${entity}-${id}-${now()}-${randomBytes(3).toString('hex')}.json`);
    writeFileSync(q, bytes ?? '', { mode: 0o644 });
    chmodSync(q, 0o644);
    say({ type: 'tamper', entity, id, reason: why, quarantined: q });
    return q;
  }
  function restore(entry) {
    const tmp = writeDocFile(entry.entity, entry.id, docBytes(entry.entity, entry.id, entry.rev, entry.doc), 'restore');
    renameSync(tmp, docPath(entry.entity, entry.id));
    fsyncPath(join(P.docs, entry.entity));
  }

  function fault(step) {
    if (faultAt === undefined) return;
    const s = typeof faultAt === 'string' ? faultAt : faultAt.step;
    if (s !== step) return;
    const signal = typeof faultAt === 'string' ? 'SIGKILL' : (faultAt.signal ?? 'SIGKILL');
    process.kill(process.pid, signal);
    if (signal === 'SIGKILL') for (;;) sleepMs(1000);
  }

  // A file that doesn't match its diary line (under the lock, nothing is mid-write): quarantine, restore, alert.
  function checkFile(entity, id) {
    const entry = index.get(keyOf(entity, id));
    const bytes = readOrNull(docPath(entity, id));
    if (!entry) {
      if (bytes === null) return { ok: true };
      quarantine(entity, id, bytes, 'document file has no diary line');
      unlinkSync(docPath(entity, id));
      return { ok: false, reason: `${entity} ${id}: a document file with no diary line was found and quarantined` };
    }
    if (bytes !== null && sha256(bytes) === entry.hash) return { ok: true };
    // Missing or the version before: a write that crashed between its diary line and its rename. Rolled forward quietly,
    // as recover() does, not reported as tamper (0b-2 audit round 3 m-A).
    // Only a create (rev 1) can be left missing by a crash; a later version that is missing was removed by hand (round 4 m-1).
    if ((bytes === null && entry.rev === 1) || (bytes !== null && sha256(bytes) === entry.prevHash)) { restore(entry); return { ok: true }; }
    quarantine(entity, id, bytes, bytes === null ? 'document file missing' : 'document changed outside the Store Writer');
    restore(entry);
    return { ok: false, reason: `${entity} ${id} was changed outside the Store Writer; restored from the diary and quarantined` };
  }

  function recover() {
    const report = { cut: 0, rolledForward: [], restored: [], quarantined: [], tempsRemoved: 0 };
    // 1. A torn last line (no newline, or not JSON) is cut.
    const all = readFileSync(P.diary);
    let keep = all.length;
    const lastNl = all.lastIndexOf(0x0a);
    if (lastNl !== all.length - 1) keep = lastNl + 1;
    let text = all.subarray(0, keep).toString('utf8');
    if (keep > 0) {
      const body = text.slice(0, -1);
      const lastStart = body.lastIndexOf('\n') + 1;
      try { JSON.parse(body.slice(lastStart)); } catch { keep = Buffer.byteLength(text.slice(0, lastStart), 'utf8'); text = text.slice(0, lastStart); }
    }
    if (keep !== all.length) {
      const fd = openSync(P.diary, constants.O_RDWR);
      try { ftruncateSync(fd, keep); fsyncSync(fd); } finally { closeSync(fd); }
      report.cut = all.length - keep;
      say({ type: 'diary_torn_line_cut', bytes: report.cut });
    }
    // 2. Read it all again; seq gaps and broken chains mark the store damaged.
    reset();
    refresh();
    // 3. Documents: roll forward a missing file or the previous version; any other difference is tamper.
    for (const e of index.values()) {
      const bytes = readOrNull(docPath(e.entity, e.id));
      const h = bytes === null ? null : sha256(bytes);
      if (h === e.hash) continue;
      if ((bytes === null && e.rev === 1) || (bytes !== null && h === e.prevHash)) { restore(e); report.rolledForward.push(keyOf(e.entity, e.id)); continue; }
      quarantine(e.entity, e.id, bytes, 'document changed outside the Store Writer');
      restore(e);
      report.restored.push(keyOf(e.entity, e.id));
    }
    // 4. Document files with no diary line.
    let entities = [];
    try { entities = readdirSync(P.docs); } catch { /* none */ }
    for (const ent of entities) {
      let names = [];
      try { names = readdirSync(join(P.docs, ent)); } catch { continue; }
      for (const n of names) {
        const id = n.endsWith('.json') ? n.slice(0, -5) : n;
        if (n.endsWith('.json') && index.has(keyOf(ent, id))) continue;
        const p = join(P.docs, ent, n);
        quarantine(ent, id, readOrNull(p), 'document file has no diary line');
        unlinkSync(p);
        report.quarantined.push(keyOf(ent, id));
      }
    }
    // 5. Temp files whose writer is gone (the pid starts the name). A live pid's file is left alone.
    for (const n of readdirSync(P.tmp)) {
      const pid = Number(/^(\d+)-/.exec(n)?.[1]);
      if (!Number.isInteger(pid) || processDead({ pid }, probe)) { try { unlinkSync(join(P.tmp, n)); report.tempsRemoved++; } catch { /* gone */ } }
    }
    return report;
  }

  let recovered = false;
  let lastRecovery = null;
  function transaction(fn) {
    const { nonce, broke } = lock.acquire();
    let released = false;
    const release = () => { if (!released) { released = true; lock.release(nonce); } };
    try {
      fault('locked');
      if (!recovered || broke) { lastRecovery = recover(); recovered = true; } else {
        refresh();
        // Bytes after the last whole line, seen under the lock, are a torn line another writer left when it died; cut it
        // before appending, or our line joins it and the diary becomes unreadable (0b-2 audit round 2 M-1).
        if (!testNoLock && fstatOf(P.diary) > offset) lastRecovery = recover();
      }
      const tx = {
        current(entity, id) {
          const chk = checkFile(entity, id);
          if (!chk.ok) return { tampered: true, reason: chk.reason };
          const e = index.get(keyOf(entity, id));
          return e ? structuredClone(e) : null;
        },
        lookup(entity, id) { const e = index.get(keyOf(entity, id)); return e ? structuredClone(e) : null; },
        list(entity) { return [...index.values()].filter((e) => e.entity === entity).map((e) => structuredClone(e)); },
        damaged: () => damaged,
        nextSeq: () => lastSeq + 1,
        commit(writes, meta) {
          if (damaged) throw new Error(`the diary is damaged (${damaged}); writes stop until the owner repairs it`);
          const ts = new Date(now()).toISOString();
          const out = writes.map((w) => {
            if (!SAFE_ID.test(w.id) || /^\.+$/.test(w.id)) throw new Error('bad id');
            const cur = index.get(keyOf(w.entity, w.id));
            const rev = (cur?.rev ?? 0) + 1;
            const bytes = docBytes(w.entity, w.id, rev, w.doc);
            return { entity: w.entity, id: w.id, rev, from_state: cur?.doc?.state ?? null, to_state: w.doc?.state ?? null, doc: w.doc,
              doc_hash: sha256(bytes), prev_hash: cur?.hash ?? null, bytes };
          });
          const temps = out.map((o) => writeDocFile(o.entity, o.id, o.bytes, 'w'));
          fault('temp_written');
          if (!lock.holds(nonce)) { for (const t of temps) { try { unlinkSync(t); } catch { /* gone */ } } throw new Error('lost the store lock before the commit point'); }
          const first = out[0];
          const line = { seq: lastSeq + 1, ts, actor: meta.actor, kind: meta.kind ?? 'write', entity: first.entity, id: first.id,
            from_state: first.from_state, to_state: first.to_state, rules_rev: meta.rules_rev ?? null, profile_version: meta.profile_version ?? null,
            data: meta.data ?? null, writes: out.map(({ bytes, ...w }) => w) };   // eslint-disable-line no-unused-vars
          const text = `${JSON.stringify(line)}\n`;
          try {
            const fd = openSync(P.diary, constants.O_WRONLY | constants.O_APPEND);
            const size = fstatSync(fd).size;
            try {
              if (faultAt !== undefined && (faultAt === 'diary_torn' || faultAt?.step === 'diary_torn')) { writeSync(fd, text.slice(0, Math.floor(text.length / 2))); fsyncSync(fd); fault('diary_torn'); }
              if (faultAt === 'append_fails') { writeSync(fd, text.slice(0, Math.floor(text.length / 2))); throw new Error('test: the append failed partway'); }
              const body = faultAt === 'readback_wrong' ? text.replace(`"seq":${line.seq},`, `"seq":${line.seq + 1},`) : text;
              const wrote = writeSync(fd, faultAt === 'short_write' ? body.slice(0, Math.floor(body.length / 2)) : body);
              if (wrote !== Buffer.byteLength(body, 'utf8')) throw new Error(`diary append wrote ${wrote} of ${Buffer.byteLength(body, 'utf8')} bytes`);
              fsyncSync(fd);
            } catch (e) {
              // A part-written line (a full disk) is cut back off, so the next line doesn't join it and become unreadable
              // (0b-2 audit MIN-7). If it can't be cut, writes stop until the owner looks.
              try { ftruncateSync(fd, size); fsyncSync(fd); } catch { damaged = 'a failed diary append could not be cut back'; say({ type: 'diary_damaged', reason: damaged }); }
              throw e;
            } finally { closeSync(fd); }
          } catch (e) { for (const t of temps) { try { unlinkSync(t); } catch { /* gone */ } } throw e; }
          fault('diary_written');
          refresh();
          // The line must read back as the next one, or the documents are not moved and the next write starts with recover().
          // Both checks lean on the lock, so the lock-off mutation race (testNoLock) skips them.
          if (!testNoLock && (damaged || lastSeq !== line.seq)) {
            recovered = false;
            for (const t of temps) { try { unlinkSync(t); } catch { /* gone */ } }
            throw new Error(`the diary line didn't read back as seq ${line.seq}${damaged ? ` (${damaged})` : ''}`);
          }
          out.forEach((o, i) => renameSync(temps[i], docPath(o.entity, o.id)));
          fault('renamed');
          for (const ent of new Set(out.map((o) => o.entity))) fsyncPath(join(P.docs, ent));
          fault('dir_synced');
          return { rev: first.rev, seq: line.seq, revs: out.map((o) => o.rev) };
        },
        seen(key) { return readFileSync(P.seen, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).key === key; } catch { return false; } }); },
        markSeen(key, outcome) { appendFileSync(P.seen, `${JSON.stringify({ key, outcome, at: new Date(now()).toISOString() })}\n`); },
      };
      const result = fn(tx);
      release();
      fault('released');
      return result;
    } finally { release(); }
  }

  // Reads come from the diary; the file is only checked. A file that is neither this version nor the one before (a write
  // between its commit point and its rename) is corrupt until the next write or recover() puts it right.
  function read(entity, id) {
    refresh();
    const e = index.get(keyOf(entity, id));
    const bytes = readOrNull(docPath(entity, id));
    // A corrupt document is reported, never returned as absent (m-5); the next write or recover() quarantines it.
    const corrupt = (reason) => { say({ type: 'corrupt_read', entity, id, reason }); return { id, entity, corrupt: true, reason }; };
    if (!e) return bytes === null ? null : corrupt('document file has no diary line');
    const h = bytes === null ? null : sha256(bytes);
    if (h !== e.hash && h !== e.prevHash) return corrupt(bytes === null ? 'document file missing' : 'document changed outside the Store Writer');
    return { id, doc: structuredClone(e.doc), rev: e.rev };
  }
  function list(entity) {
    refresh();
    return [...index.values()].filter((e) => e.entity === entity).map((e) => read(entity, e.id)).filter((r) => r && !r.corrupt);
  }
  function meta(entity, id) { refresh(); const e = index.get(keyOf(entity, id)); return e ? { createdBy: e.createdBy, createdKind: e.createdKind, stateSince: e.stateSince, ts: e.ts, seq: e.seq } : null; }

  return Object.freeze({
    root, paths: P, transaction, read, list, meta,
    recover() { recovered = false; return transaction(() => lastRecovery); },
    lines({ since = 0 } = {}) { refresh(); return lines.filter((l) => l.seq > since).map((l) => structuredClone(l)); },
    damaged() { refresh(); return damaged; },
    refuse(event) {
      const line = { at: new Date(now()).toISOString(), ...event };
      try { appendFileSync(P.refusals, `${JSON.stringify(line)}\n`); chmodSync(P.refusals, 0o644); } catch { /* the alert still fires */ }
      say({ type: 'refused', ...event });
    },
    alert: say,
  });
}
