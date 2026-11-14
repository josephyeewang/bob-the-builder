// hook-store.mjs — R-0b-175a: the interactive sessions' hook lines, applied owner-side to a saved tracker.
//
// Each interactive session (the Lead, the Front Door, Mini Base) has its hook lines in an append-only file,
// `<hookStateDir>/hooks/<sessionId>.jsonl`, written by the relay (R-0b-175b). The owner-side runner applies new lines every
// tick, at the start of a send and during its waits (the live read, `applyHooks(id)`), through one ActivityTracker whose
// store is a file (`<hookStateDir>/activity.json`, 0o600) saved after every applied line together with the read offset,
// so a runner restart picks up every line written while it was down.
//
// A line is `{ launchId, event, at, toolName, toolUseId, notificationType, reason, source, watchdog, promptHash }`. It
// never carries the prompt text: `watchdog` is the emitter's isWatchdogText(prompt) and `promptHash` its sha256. A line
// with no ending newline is not applied yet (the writer is mid-write); a line that doesn't parse, or has an unknown field
// or event, is skipped and counted (`bad_lines`) and never blocks the file. A session's file is deleted once its
// session-end line is applied, or when beginLaunch starts a new launch for it.
//
// Every outside effect is passed in (`fs`, `write`), so the tests run on a temp folder or fakes; the runner gives
// nodeHookFs() and runner-files.mjs's writeStatus.

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs';
import { ActivityTracker, State } from './activity.mjs';
import { signalFromHook } from './claude-signals.mjs';
import { LAUNCH_EVENT, withChange } from './changes.mjs';

export const HOOK_LINE_FIELDS = Object.freeze(['launchId', 'event', 'at', 'toolName', 'toolUseId', 'notificationType', 'reason', 'source', 'watchdog', 'promptHash']);
export const HOOK_EVENTS = Object.freeze(['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'post-tool-use-failure',
  'permission-request', 'stop', 'stop-failure', 'notification', 'session-end']);
/** The interactive roles, and the start timeout each has until R-0b-157 measures the pin (twice its worst start). */
export const INTERACTIVE_ROLES = Object.freeze(['lead', 'frontDoor', 'minibase']);
export const START_TIMEOUT_S = 120;
/** A session id as a file name: no slash, no leading dot. */
export const HOOK_SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_LINE_BYTES = 8_192;
const STRINGS = ['launchId', 'toolName', 'toolUseId', 'notificationType', 'reason', 'source'];

/** One line's text → the line, or null when it is not a line the relay writes. */
export function parseHookLine(text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > MAX_LINE_BYTES) return null;
  let x; try { x = JSON.parse(text); } catch { return null; }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  if (Object.keys(x).some((k) => !HOOK_LINE_FIELDS.includes(k))) return null;
  if (!HOOK_EVENTS.includes(x.event) || !Number.isFinite(x.at)) return null;
  for (const k of STRINGS) if (x[k] !== undefined && typeof x[k] !== 'string') return null;
  if (x.watchdog !== undefined && typeof x.watchdog !== 'boolean') return null;
  if (x.promptHash !== undefined && !/^[0-9a-f]{64}$/.test(x.promptHash)) return null;
  return x;
}

/** A line → the tracker's signal, or null when the event carries no activity meaning. A line with neither the flag nor a
 * prompt (which a line never carries) counts as not the person: `watchdog` true. */
export function signalFromLine(line) {
  const payload = { tool_name: line.toolName, tool_use_id: line.toolUseId, notification_type: line.notificationType, reason: line.reason, source: line.source };
  const s = signalFromHook(line.event, payload, line.at, line.launchId);
  if (!s) return null;
  delete s.prompt;
  return { ...s, watchdog: line.watchdog ?? true, ...(line.promptHash ? { promptHash: line.promptHash } : {}) };
}

/** One `held` entry as the runner writes it and the status reader takes it (the one check, both sides). The unreadable
 * store's entry names no session (sessionId, role, product, launchId null). */
export const HELD_FIELDS = Object.freeze(['sessionId', 'role', 'product', 'reason', 'since', 'launchId']);
const strOrNull = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 200);
export const heldOk = (h) => !!h && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length === HELD_FIELDS.length
  && HELD_FIELDS.every((k) => Object.hasOwn(h, k)) && strOrNull(h.sessionId) && (h.role === null || INTERACTIVE_ROLES.includes(h.role))
  && strOrNull(h.product) && strOrNull(h.launchId) && typeof h.reason === 'string' && h.reason.length > 0 && h.reason.length <= 300
  && typeof h.since === 'string' && Number.isFinite(Date.parse(h.since)) && (h.sessionId === null) === (h.role === null);

/** The real files: readFrom opens without following a link and returns the bytes from `offset` to the end. */
export function nodeHookFs() {
  return {
    readFile: (p) => readFileSync(p, 'utf8'),
    readFrom: (p, offset) => {
      let fd;
      try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error('a hook file is not a plain file');
        const size = st.size;
        if (size <= offset) return { buf: Buffer.alloc(0), size };
        const buf = Buffer.alloc(size - offset);
        for (let got = 0; got < buf.length;) { const n = readSync(fd, buf, got, buf.length - got, offset + got); if (!n) return { buf: buf.subarray(0, got), size }; got += n; }
        return { buf, size };
      } finally { closeSync(fd); }
    },
    unlink: (p) => unlinkSync(p),
  };
}

/** The tracker's store, kept in one file. Loading a file that is there but can't be read leaves `broken` set: nothing is
 * applied and every send holds until it is fixed by hand (never silently started afresh). */
export class FileStore {
  constructor(file, { read, saveFile }) {
    this.file = file; this.saveFile = saveFile; this.sessions = new Map(); this.broken = null;
    let text = null;
    try { text = read(file); } catch (e) { if (e?.code !== 'ENOENT') this.broken = `the hook store can't be read (${String(e?.code ?? e?.message ?? e).slice(0, 200)})`; }
    if (text !== null && !this.broken) {
      try {
        const doc = JSON.parse(text);
        if (!doc || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions) || doc.sessions === null) throw new Error('not the store\'s shape');
        for (const [id, rec] of Object.entries(doc.sessions)) this.sessions.set(id, rec);
      } catch (e) { this.broken = `the hook store can't be read (${String(e?.message).slice(0, 200)})`; }
    }
  }

  get(id) { return this.sessions.get(id); }
  set(id, rec) { this.sessions.set(id, rec); }
  delete(id) { this.sessions.delete(id); }
  ids() { return [...this.sessions.keys()]; }
  save() { this.saveFile(this.file, `${JSON.stringify({ sessions: Object.fromEntries(this.sessions) })}\n`, { mode: 0o600 }); }
}

/**
 * The owner-side hook store. dir is `hookStateDir` (0o700, the runner's). fs: { readFile(path) → text, readFrom(path,
 * offset) → { buf (the bytes from offset), size } | null (null: no file), unlink(path) }. saveFile(file, text, { mode }) saves the store.
 * startTimeoutS: { <role>: seconds }.
 */
export function hookStore({ dir, fs, saveFile, now = () => Date.now(), startTimeoutS = {}, notify }) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new Error('the hook store has no folder');
  const storeFile = `${dir}/activity.json`;
  const hookFile = (id) => `${dir}/hooks/${id}.jsonl`;
  const store = new FileStore(storeFile, { read: fs.readFile, saveFile });
  // notify: the tracker's needs-input ping; left out, the tracker's own (activity.mjs).
  const tracker = new ActivityTracker(store, { ...(typeof notify === 'function' ? { notify } : {}), now });
  const brokenSince = store.broken ? now() : null;

  const save = () => store.save();
  const unlink = (id) => { try { fs.unlink(hookFile(id)); } catch (e) { if (e?.code !== 'ENOENT') throw e; } };

  /** The live read: apply a session's hook file from its saved offset. → how many lines were applied, or null when the
   * store can't be used or the session has no record. */
  function applyHooks(id) {
    if (store.broken || !HOOK_SESSION_ID.test(id ?? '')) return null;
    const rec = store.get(id);
    if (!rec) return null;
    let offset = Number.isInteger(rec.hook_offset) && rec.hook_offset >= 0 ? rec.hook_offset : 0;
    const got = fs.readFrom(hookFile(id), offset);
    if (!got) return 0;
    // A file shorter than the offset is a new file (deleted and written again): read it from the start.
    if (got.size < offset) { offset = 0; return applyFrom(id, fs.readFrom(hookFile(id), 0), 0); }
    return applyFrom(id, got, offset);
  }

  function applyFrom(id, got, offset) {
    if (!got) return 0;
    const buf = Buffer.isBuffer(got.buf) ? got.buf : Buffer.alloc(0);
    let n = 0; let at = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0) break; // no ending newline: the writer is mid-write
      const text = buf.subarray(at, nl).toString('utf8');
      at = nl + 1;
      const line = parseHookLine(text);
      const cur = store.get(id);
      if (!cur) return n; // the record went (ended) while reading
      if (!line) { store.set(id, { ...cur, hook_offset: offset + at, bad_lines: (cur.bad_lines ?? 0) + 1 }); save(); continue; }
      const s = signalFromLine(line);
      const did = s ? tracker.applySignal(id, s) : 'dropped';
      const after = store.get(id);
      store.set(id, { ...after, hook_offset: offset + at });
      n += 1;
      // Only a session-end this launch applied ends the file: one with an old label is ignored like any other.
      const ended = line.event === 'session-end' && s?.state === State.EXITED && did !== 'dropped';
      if (ended) { store.set(id, { ...store.get(id), hook_offset: 0 }); save(); unlink(id); return n; }
      save();
    }
    return n;
  }

  /** The runner's tick: every session with a record. */
  function tick() {
    if (store.broken) return 0;
    let n = 0;
    for (const id of store.ids()) n += applyHooks(id) ?? 0;
    return n;
  }

  /** A record for a new interactive session (R-0b-174 makes them), startup pending. */
  function addSession(id, { role, product = null, launchId = null }) {
    if (store.broken) return false;
    if (!HOOK_SESSION_ID.test(id ?? '') || !INTERACTIVE_ROLES.includes(role) || !strOrNull(product)) return false;
    const t = now();
    // R-0b-155b: a session added again keeps its change number, and the re-add is numbered as a launch.
    const old = store.get(id);
    const fresh = { id, role, product, activity: { state: State.ACTIVE, at: t }, firstSignalAt: null, hook_offset: 0, launched_at: t,
      ...(typeof launchId === 'string' && launchId ? { launchId } : {}) };
    store.set(id, old ? withChange({ ...fresh, seq: old.seq, changes: old.changes }, { event: LAUNCH_EVENT, launchId: fresh.launchId, at: t }) : fresh);
    save();
    return true;
  }

  /** A new launch for a session: the tracker's beginLaunch, its old hook file deleted, read from the start. */
  function beginLaunch(id, launchId) {
    if (store.broken) return false;
    if (!tracker.beginLaunch(id, launchId)) return false;
    unlink(id);
    store.set(id, { ...store.get(id), hook_offset: 0, launched_at: now() });
    save();
    return true;
  }

  /** The status's `held` list: a session past its start timeout, and an unreadable store. */
  function held() {
    const t = now();
    if (store.broken) return [{ sessionId: null, role: null, product: null, reason: store.broken, since: new Date(brokenSince).toISOString(), launchId: null }];
    const out = [];
    for (const id of store.ids()) {
      const r = store.get(id);
      if (r.firstSignalAt || r.terminated || !Number.isFinite(r.launched_at)) continue;
      const limit = (Number.isFinite(startTimeoutS[r.role]) && startTimeoutS[r.role] > 0 ? startTimeoutS[r.role] : START_TIMEOUT_S) * 1000;
      if (t - r.launched_at > limit) {
        out.push({ sessionId: id, role: r.role, product: r.product ?? null, reason: `no first signal within ${limit / 1000} s of its start`, since: new Date(r.launched_at + limit).toISOString(), launchId: r.launchId ?? null });
      }
    }
    return out;
  }

  /** The guard's store (guard.mjs `getSession`): the live read first, so the hook half is current when the send decides.
   * A store that can't be used throws, which the guard reads as unknown: every send holds. A held session is still
   * startup pending, which the guard refuses on its own. */
  function getSession(id) {
    if (store.broken) throw new Error(store.broken);
    applyHooks(id);
    return store.get(id) ?? null;
  }

  return { applyHooks, tick, addSession, beginLaunch, held, getSession, tracker, store, get broken() { return store.broken; } };
}
