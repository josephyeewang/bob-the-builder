// The compaction hooks (R-0b-42, design v4 §5.5; file kinds: lead's call L2).
//
// PreCompact and PostCompact write one note into the role's own outbox, named
// `<kind>-compact-<session>.md` (Lead: handoff, worker: report, Front Door: state; other roles
// their profile's kind). SessionStart with source "compact" prints that note, so it lands in the
// new context first. Nothing is ever written outside the outbox, and a link is never followed.
// There is no "compact instructions" heading: that is not a real feature (§5.5, corrected 29 Oct).

import { openSync, writeSync, closeSync, readSync, fstatSync, lstatSync, constants as C } from 'node:fs';
import { join } from 'node:path';
import { isMain, runHook, block, pass, realFolder } from './lib.mjs';

export const NOTE_CAP = 8000;
const EVENTS = ['PreCompact', 'PostCompact', 'SessionStart'];

export const noteName = (kind, sessionId) => `${kind}-compact-${String(sessionId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)}.md`;

function openNoFollow(file, flags, mode) { return openSync(file, flags | C.O_NOFOLLOW, mode); }

export function decide(input, args, io = {}) {
  const stdout = io.stdout ?? ((t) => process.stdout.write(t));
  const now = io.now ?? (() => new Date());
  if (!EVENTS.includes(args.event)) return block(`unknown compaction event ${args.event}`);
  // The note's kind is a first word (handoff, report, state…); a role's kinds are name prefixes (L82 M-1), so the word
  // must start one of them. Which notes M9 then takes in is M9's table's call: see the M4 README's open item.
  if (!/^[a-z]+$/.test(args.kind ?? '') || !args.kinds.some((k) => k.startsWith(`${args.kind}-`))) return block('the note kind is not one of the role\'s outbox kinds');
  const outbox = realFolder(args.outbox);
  if (!outbox || lstatSync(args.outbox).isSymbolicLink()) return block('the outbox is missing or a link');
  const sid = input.session_id;
  if (typeof sid !== 'string' || !/[A-Za-z0-9]/.test(sid)) return block('no session id');
  const file = join(outbox, noteName(args.kind, sid));

  if (args.event === 'SessionStart') {
    if (input.source !== 'compact') return pass();
    let fd;
    try { fd = openNoFollow(file, C.O_RDONLY); } catch { stdout(`Compaction happened. No ${args.kind} note was found; re-read your last ${args.kind} file before going on.\n`); return pass(); }
    try {
      if (!fstatSync(fd).isFile()) return block('the note is not a plain file');
      const buf = Buffer.alloc(NOTE_CAP);
      const n = readSync(fd, buf, 0, NOTE_CAP, 0);
      stdout(`Compaction happened. Re-read this note first, then your last ${args.kind} file:\n\n${buf.subarray(0, n).toString('utf8')}\n`);
    } finally { closeSync(fd); }
    return pass();
  }

  const line = `- ${args.event} (${input.trigger ?? 'unknown'}) at ${now().toISOString()}\n`;
  const flags = C.O_WRONLY | C.O_CREAT | C.O_APPEND;
  const fd = openNoFollow(file, flags, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return block('the note is not a plain, single-linked file');
    if (st.size === 0) writeSync(fd, `# ${args.kind} note: compaction of ${args.role} session\n\n`);
    if (st.size < NOTE_CAP) writeSync(fd, line);
  } finally { closeSync(fd); }
  return pass();
}

if (isMain(import.meta.url)) runHook(decide);
