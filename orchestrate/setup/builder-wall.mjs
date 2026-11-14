#!/usr/bin/env node
// R-0b-179 (L1148 F1, L1149, L1150): the builder wall. The builder user (L1079) reaches only its OWN listeners on this Mac:
// never the owner's dev servers, databases, Claude or codex control ports, nor root's local services. Measured before it
// (L1148): the Application Firewall is off and pf holds only Apple's anchors, so every Mac user reaches every 127.0.0.1
// service. A plain "builder may not reach 127.0.0.1" would also cut a worker session's sandboxed shell off from Claude
// Code's own network proxy, which listens on 127.0.0.1 as the builder (read in 2.1.316's code; checked: claude-code
// 2.1.316), so the wall is by the LISTENER's owner, not by address (L1150):
//
//   out on lo0, a packet from a builder socket is tagged ORCH_BUILDER; in on lo0, a tagged packet to a listener that is
//   not the builder's is blocked (pf's `user` is the sending socket's owner on the way out, the receiving one's on the way
//   in). TCP and UDP, IPv4 and IPv6 (the rules name no family, so ::1 is covered with 127.0.0.0/8). A connect to one of
//   this Mac's other addresses goes through lo0 as well (the read-back probes one); a third rule blocks the builder to
//   `self` off lo0 all the same.
//   Another user's connection TO a builder listener fails too, and that is intended (L1154): the builder's reply is tagged
//   and meets a socket that is not the builder's. builder-wall.test.mjs pins it; the read-back on the Mac does not probe it.
//
// Known limits (#556 r1, L1158; said in Joe's run sheet too):
//   - A packet sent by a setuid-root program the builder runs (traceroute's UDP probes, ping) comes from root's socket, so it
//     is not tagged and reaches the owner's listener. Such a program sends probes; it holds no conversation the builder can use.
//   - The wall is network only. Claude Code's session sockets (/tmp/cc-socks) are files, guarded by their folder's owner and
//     mode: the builder can make the owner's session messaging go quiet by making that folder first after a reboot (Claude
//     Code refuses a folder another user owns, so it can not take the messaging over). A login job of the owner's that makes
//     the folder first is a later row (L1158).
//   - Nothing alarms if the wall is switched off later. The start-of-session gate of the wiring PR reruns the settings half
//     (pf on, token held, rules exact) before every builder session (L1154, L1158 m5).
//
// What it places, as root (`place`):
//   /private/etc/pf.anchors/orchestrate.builder   the rules, root:wheel 0644 (anchorText). /etc is a link to /private/etc
//       on every Mac, so the real path is the one named (#556 r1 M1: a path through a link is refused by the chain check).
//   <base>/builder-wall/                     root's 0700: pf-token, the pf enable reference this job holds
//   /Library/LaunchDaemons/<label>.builder-wall.plist   root's 0644. At load, at boot and every 5 minutes it loads the
//       rules into com.apple/100.orchestrate.builder (a child of the `anchor "com.apple/*"` that macOS's own /etc/pf.conf
//       has, and that com.apple.pfctl loads at every boot: so /etc/pf.conf is never edited) and, unless the token it
//       holds is still held and pf is on, enables pf with `pfctl -E` and keeps the new token.
// then waits (15 seconds at most) for the job's first run to have finished well, runs the read-back, and when either
// refuses, takes the wall out again (the way out, below) and says why: a wall that blocks the owner or the builder's own
// proxy never stays live.
//
// The read-back (`check`, and the last step of `place`) refuses in five cases (L1149, L1150):
//   (i)   the builder still connects to a throwaway listener of the owner's, or that listener received what it sent
//   (ii)  the owner can not connect to its own throwaway listener, before (i) or after it
//   (iii) the anchor file is there but pf is off, or the token this job keeps isn't held
//   (iv)  the rules didn't load: com.apple/100.orchestrate.builder isn't exactly these rules, or the main ruleset has no
//         `anchor "com.apple/*"` to reach it
//   (v)   the builder can't reach its own throwaway listener (the proxy path would be cut)
// Both directions, in each of TCP and UDP over 127.0.0.1, ::1 and one other address of this Mac, on every run. (i) proves
// nothing unless (ii) and (v) pass in the same protocol and address: they are its controls, as proofs.mjs's are. A timeout
// counts as a block only when the owner's listener received nothing from the builder.
//
// How pfctl prints loaded rules is read from OpenBSD's pfctl (print_rule), from which macOS's comes; it is not yet seen on
// this Mac (Joe's run sheet, laneA-builder-wall-runsheet.md). The check takes each printed rule as a set of words and wants
// exactly the wall's set: a word missing or a word more refuses, so an unexpected print fails closed, never open.
//
// The status (L1193): every `check` and every `place` writes <base>/builder-wall-status/status.json (STATUS_FILE; root's
// 0644 in a folder of root's 0755, written whole): when, the builder's uid, the sha256 of anchorText(uid), ok and why. ok
// is true only when every row above passed, controls included. A run that can't read the config has no base to write in
// and writes nothing; the worker runner's gate then holds every start once the last status is two beats old. setup's
// daemons keep a root job (builder-wall-check, daemons.mjs) running `check` at load and every RECHECK_EVERY_S.
//
// The way out (said after every run): sudo launchctl bootout system/<label>.builder-wall; sudo rm the job file; sudo pfctl
// -a com.apple/100.orchestrate.builder -F rules; sudo pfctl -X <the token in <base>/builder-wall/pf-token>.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { BUILDER, DAEMON_DIR, JOB_PATH, LAUNCHCTL, ROOT_CONFIG_PATH, wallStatusDir, wallStatusPath } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { guarded } from './guard.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { writeAside } from './dispatcher-setup.mjs';
import { installPaths, parseInstallConfig } from './install.mjs';
import { NODE, chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { SHA256 } from '../shared/plan-fingerprint.mjs';

export const ANCHOR = 'com.apple/100.orchestrate.builder';
export const ANCHOR_DIR = '/private/etc/pf.anchors';
export const ANCHOR_FILE = `${ANCHOR_DIR}/orchestrate.builder`;
export const TAG = 'ORCH_BUILDER';
export const PROTOS = Object.freeze(['tcp', 'udp']);
export const FAMILIES = Object.freeze([['IPv4', '127.0.0.1'], ['IPv6', '::1']]);
/** Listeners bound to every address, probed through loopback: [what, the address probed, the address bound]. */
export const ALL_ADDRESSES = Object.freeze([['IPv4', '127.0.0.1', '0.0.0.0'], ['IPv6', '::1', '::']]);
export { DAEMON_DIR };   // layout.mjs's one definition (I7)
// The status file's place (L1193): layout.mjs's one definition, under the name the worker runner's gate reads it by.
export { wallStatusPath as STATUS_FILE };
export const RECHECK_EVERY_S = 300;
export const FIRST_RUN_WAIT_MS = 15_000;
const PFCTL = '/sbin/pfctl';
const SUDO = '/usr/bin/sudo';
/** The node every Mac user can run (nodejs.org's, root's; managed-settings.mjs NODE_BIN): the probes run it as the builder and the owner. */
export const PROBE_NODE = '/usr/local/bin/node';

export const wallLabel = (cfg) => `${cfg.label}.builder-wall`;
export const wallPlistPath = (cfg) => join(DAEMON_DIR, `${wallLabel(cfg)}.plist`);
export const wallDir = (cfg) => join(cfg.base, 'builder-wall');
export const tokenPath = (cfg) => join(wallDir(cfg), 'pf-token');
/** What `pfctl -E` said when no token could be read from it: the job stops there rather than take reference after reference. */
export const unreadPath = (cfg) => join(wallDir(cfg), 'pf-enable-unread');
const lstatOr = (io, p) => { try { return io.lstat(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const said = (r) => (String(r?.stderr ?? '').trim() || String(r?.stdout ?? '').trim()).slice(0, 160) || `exit ${r?.status}`;

/** The anchor's rules for the builder's uid. One home: the job loads this file, and the check matches what pf loaded against RULES. */
export function anchorText(uid) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`the builder's uid must be a whole number above 0, not ${uid}`);
  return [
    `# The builder wall (R-0b-179; L1148, L1150): the ${BUILDER} user (uid ${uid}) reaches only its own listeners on this Mac.`,
    '# Written by the orchestrate setup (setup/builder-wall.mjs) and compared by its check: do not edit.',
    ...RULES.map((r) => r.text(uid)),
    '',
  ].join('\n');
}

/**
 * Each rule: its text, and the exact words pfctl prints for it in one protocol (OpenBSD's print_rule: one rule per protocol,
 * `all` for `from any to any`, `user = N`). The self rule alone may name a family and an address: pf turns `self` into this
 * Mac's own addresses as it loads, one rule each. Any other word (a family, a port, a group, `keep state`, no `quick`) is
 * a different rule, and refuses (#556 r1 m2).
 */
export const RULES = Object.freeze([
  { id: 'tag', text: (u) => `pass out quick on lo0 proto { tcp udp } from any to any user ${u} tag ${TAG} no state`,
    words: (u, p) => `pass out quick on lo0 proto ${p} all user = ${u} no state tag ${TAG}` },
  { id: 'block-in', text: (u) => `block return in quick on lo0 proto { tcp udp } from any to any tagged ${TAG} user != ${u}`,
    words: (u, p) => `block return in quick on lo0 proto ${p} all user != ${u} tagged ${TAG}` },
  { id: 'self', text: (u) => `block return out quick on ! lo0 proto { tcp udp } from any to self user ${u}`,
    words: (u, p) => `block return out quick on ! lo0 proto ${p} from any to ADDRESS user = ${u}`, anyAddress: true },
]);

/** One loaded line → the lines it stands for, one per protocol (a `{ tcp udp }` pfctl did not split counts for both). */
function perProto(line) {
  const m = /\bproto\s+\{\s*([a-z0-9 ,]+?)\s*\}/.exec(line);
  return m ? m[1].split(/[\s,]+/).filter(Boolean).map((p) => line.replace(m[0], `proto ${p}`)) : [line];
}
// A `!` belongs to the word after it, so `from ! any` and `! from any` are different word sets.
const sorted = (s) => s.trim().replace(/!\s+/g, '!').split(/\s+/).sort().join(' ');
/** The words of a printed rule as the wall's are written: `from any to any` as `all`, the user as `user = N` / `user != N`. */
function normal(line, uid, anyAddress) {
  let s = ` ${line} `.replace(/\s+/g, ' ').replace(/ from any to any /, ' all ')
    .replace(/ user\s*(!=|=)?\s*(\S+) /, (_, op, who) => ` user ${op ?? '='} ${who === BUILDER ? uid : who} `);
  if (anyAddress) s = s.replace(/ inet6? /, ' ').replace(/ to (?!any )\S+ /, ' to ADDRESS ');
  return sorted(s);
}
const fits = (r, uid, line, p) => normal(line, uid, r.anyAddress) === sorted(r.words(uid, p));

/**
 * Null, or why the anchor as pfctl prints it is not these rules (iv): each rule in each protocol, and no line that is none of
 * them. `text`: `pfctl -a <ANCHOR> -s rules`.
 */
export function loadedRulesProblem(text, uid) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).flatMap(perProto);
  if (!lines.length) return `${ANCHOR} holds no rules`;
  const missing = [];
  for (const r of RULES) for (const p of PROTOS) if (!lines.some((l) => fits(r, uid, l, p))) missing.push(`${r.id} (${p})`);
  const extra = lines.filter((l) => !RULES.some((r) => PROTOS.some((p) => fits(r, uid, l, p))));
  if (missing.length) return `${ANCHOR} is missing the rule${missing.length > 1 ? 's' : ''} ${missing.join(', ')} exactly as written: what is loaded is not the wall`;
  if (extra.length) return `${ANCHOR} holds ${extra.length === 1 ? 'a line' : `${extra.length} lines`} that ${extra.length === 1 ? 'is' : 'are'} not the wall's: ${extra[0].slice(0, 120)}`;
  return null;
}

/** The job's shell text (fixed words and root's own paths only; no value from a file is put in it). */
export function bootScript(cfg) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return [
    'set -u',
    `A=${q(ANCHOR)}; F=${q(ANCHOR_FILE)}; T=${q(tokenPath(cfg))}; U=${q(unreadPath(cfg))}`,
    // macOS's own boot job loads /etc/pf.conf, whose `anchor "com.apple/*"` reaches the wall. Until it has, try again later.
    `${PFCTL} -s rules 2>/dev/null | /usr/bin/grep -q '^anchor "com.apple/\\*"' || exit 1`,
    `${PFCTL} -q -a "$A" -f "$F" || exit 1`,
    // The reference this job holds keeps pf on; while pf is on and the token is still held there is nothing to do.
    `if ${PFCTL} -s info 2>/dev/null | /usr/bin/grep -q '^Status: Enabled' && [ -s "$T" ] && ${PFCTL} -s References 2>/dev/null | /usr/bin/awk -v t="$(/bin/cat "$T")" '{for(i=1;i<=NF;i++) if($i==t) f=1} END{exit !f}'; then exit 0; fi`,
    // A pfctl -E whose token could not be read took a reference no one can give back: say so once and take no more (r1 m7).
    '[ -e "$U" ] && exit 3',
    `O=$(${PFCTL} -E 2>&1); N=$(printf '%s\\n' "$O" | /usr/bin/sed -n 's/^Token : *\\([0-9][0-9]*\\)$/\\1/p')`,
    'if [ -z "$N" ]; then printf \'%s\\n\' "$O" > "$U"; exit 3; fi',
    'printf \'%s\\n\' "$N" > "$T.new" && /bin/mv -f "$T.new" "$T"',
  ].join('\n');
}

// The job file's plist, written the way review-daemons.mjs writes its own (its helpers are not exported).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s) => `<string>${esc(s)}</string>`;
const arr = (xs) => `<array>${xs.map(str).join('')}</array>`;
const plist = (entries) => ['<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">', '<dict>', ...entries.map((e) => `  ${e}`), '</dict>', '</plist>', ''].join('\n');

export function wallPlist(cfg) {
  return plist([
    `<key>Label</key>${str(wallLabel(cfg))}`,
    `<key>ProgramArguments</key>${arr(['/bin/sh', '-c', bootScript(cfg)])}`,
    '<key>RunAtLoad</key><true/>',
    `<key>StartInterval</key><integer>${RECHECK_EVERY_S}</integer>`,
  ]);
}

// --- the check job and the status it leaves (L1193) ------------------------------------------------------------------
// The worker runner runs as the builder and pf answers root alone, so root leaves it a proof: after every check, the
// status file (STATUS_FILE, layout.mjs wallStatusPath). The pf job above can't write it: it is a short sh script that
// place gives 15 seconds to finish, and the full check (the probes, a UDP block waiting 3 seconds each) takes longer. So
// a second root job runs `check` at load and every RECHECK_EVERY_S. It is one of setup's daemons (daemons.mjs, on with
// the worker runner, whose starts it gates): placed, loaded, checked and taken out the way the others are.

export const WALL_CHECK_JOB = 'builder-wall-check';
/** This file, as the check job starts it from the installed copy. */
export const WALL_SCRIPT = 'setup/builder-wall.mjs';
export function wallCheckPlist(cfg) {
  const P = installPaths(cfg);
  return plist([
    `<key>Label</key>${str(`${cfg.label}.${WALL_CHECK_JOB}`)}`,
    `<key>ProgramArguments</key>${arr([join(P.installRoot, NODE), join(P.installRoot, WALL_SCRIPT), 'check'])}`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key>${str(JOB_PATH)}</dict>`,
    '<key>WorkingDirectory</key><string>/</string>',
    '<key>Umask</key><integer>18</integer>',
    `<key>StartInterval</key><integer>${RECHECK_EVERY_S}</integer>`,
    '<key>RunAtLoad</key><true/>',
    `<key>StandardErrorPath</key>${str(join(P.logDir, `${WALL_CHECK_JOB}.err.log`))}`,
  ]);
}

export const STATUS_VERSION = 1;
const STATUS_KEYS = Object.freeze(['v', 'time', 'builderUid', 'anchorSha256', 'ok', 'why']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** At most this many reasons, each at most WHY_CHARS long, so a status stays one short line. */
export const WHY_MAX = 20;
export const WHY_CHARS = 300;
/** sha256 over exactly anchorText(uid) as utf8, lowercase hex: the rules the status speaks for (the gate builds the same). */
export const anchorSha256 = (uid) => createHash('sha256').update(anchorText(uid), 'utf8').digest('hex');

/**
 * The one format, read by the writer's tests and the worker runner's gate alike: one JSON line (a newline at its end or
 * none), exactly { v, time, builderUid, anchorSha256, ok, why }. → the status, frozen; throws saying what is wrong.
 * ok is true only with a uid, its rules' hash and no reason; ok false always says why. The hash is checked for its form
 * here; whether it is this copy's anchorText(uid)'s is the reader's to judge, with its own uid.
 */
export function parseStatus(text) {
  if (typeof text !== 'string') throw new Error('the status is not text');
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (/[\r\n]/.test(body)) throw new Error('the status is not one line');
  let s; try { s = JSON.parse(body); } catch { throw new Error('the status is not JSON'); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('the status is not a JSON object');
  const keys = Object.keys(s).sort();
  if (keys.join() !== [...STATUS_KEYS].sort().join()) throw new Error(`the status's keys are ${keys.join(', ').slice(0, 120)}, not ${STATUS_KEYS.join(', ')}`);
  if (s.v !== STATUS_VERSION) throw new Error(`the status is version ${JSON.stringify(s.v).slice(0, 20)}, not ${STATUS_VERSION}`);
  if (typeof s.time !== 'string' || !ISO.test(s.time) || new Date(s.time).toISOString() !== s.time) throw new Error('the status\'s time is not a UTC time as toISOString writes it');
  if (s.builderUid !== null && (!Number.isSafeInteger(s.builderUid) || s.builderUid <= 0)) throw new Error('the status\'s builderUid is not a uid above 0, nor null');
  if (s.anchorSha256 !== null && (typeof s.anchorSha256 !== 'string' || !SHA256.test(s.anchorSha256))) throw new Error('the status\'s anchorSha256 is not 64 lowercase hex, nor null');
  if (typeof s.ok !== 'boolean') throw new Error('the status\'s ok is not true or false');
  if (!Array.isArray(s.why) || s.why.length > WHY_MAX || !s.why.every((w) => typeof w === 'string' && w.length > 0 && w.length <= WHY_CHARS)) throw new Error(`the status's why is not a list of at most ${WHY_MAX} short reasons`);
  if (s.ok && (s.builderUid === null || s.anchorSha256 === null || s.why.length)) throw new Error('the status says ok without a uid, its rules\' hash, or with a reason against it');
  if (!s.ok && !s.why.length) throw new Error('the status says not ok but gives no reason');
  return Object.freeze({ ...s, why: Object.freeze([...s.why]) });
}

/** The status's text: one line, as parseStatus reads it (it is checked by parseStatus before it is returned). */
export function statusText(status) {
  const line = `${JSON.stringify(Object.fromEntries(STATUS_KEYS.map((k) => [k, status?.[k]])))}\n`;
  parseStatus(line);
  return line;
}

/**
 * The status a check's rows give: ok only when there are rows, every one passed (the settings half and every probe pair
 * with its controls) and the builder's uid is known. `uid`: the builder's, or null when it could not be read.
 */
export function statusOf(rows, uid, now = new Date()) {
  const known = Number.isSafeInteger(uid) && uid > 0;
  const bad = rows.filter((r) => !r.ok);
  const ok = known && rows.length > 0 && bad.length === 0;
  const clip = (s) => (s.length > WHY_CHARS ? `${s.slice(0, WHY_CHARS - 1)}…` : s);
  let why = ok ? [] : bad.length ? bad.map((r) => clip(`${r.what}: ${r.why ?? 'failed'}`)) : [known ? 'the check gave no rows' : 'the builder\'s uid is not known'];
  if (why.length > WHY_MAX) why = [...why.slice(0, WHY_MAX - 1), `and ${why.length - WHY_MAX + 1} more`];
  return { v: STATUS_VERSION, time: now.toISOString(), builderUid: known ? uid : null, anchorSha256: known ? anchorSha256(uid) : null, ok, why };
}

/**
 * Writes the status, whole or not at all (writeAside: a side file root's 0644, renamed over the old one), in its own
 * folder, root's 0755, made here when missing. The base and the folder must be root's alone all the way up; anything
 * else throws, and nothing is written.
 */
export function writeStatus(io, cfg, status) {
  const text = statusText(status);
  const base = chainProblem(io.at(cfg.base), { owner: io.rootUid, top: io.prefix || '/' });
  if (base) throw new Error(`${cfg.base} is not safe for root to write in (${base})`);
  const dir = wallStatusDir(cfg); const st = lstatOr(io, dir);
  if (!st) { io.mkdir(dir, 0o755); io.secure(dir, { uid: io.rootUid, gid: 0, mode: 0o755 }); }
  else if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== io.rootUid) throw new Error(`${dir} is there but is not a folder of root's; look at it and remove it by hand`);
  else if ((st.mode & 0o7777) !== 0o755 || st.gid !== 0) io.secure(dir, { uid: io.rootUid, gid: 0, mode: 0o755, ino: st.ino, dev: st.dev });
  const above = chainProblem(io.at(dir), { owner: io.rootUid, top: io.prefix || '/' });
  if (above) throw new Error(`${dir} is not safe for root to write in (${above})`);
  writeAside(io, wallStatusPath(cfg), text);
}

/** The builder's uid from this Mac (users-folders.mjs, #528), never written down: { uid } or { problem }. */
export function builderUid(io, cfg) {
  const b = readUser(io, BUILDER);
  if (!b.exists) return { problem: `the ${BUILDER} user is not on this Mac${b.error ? ` (${b.error})` : ''}; run setup users-folders first (L1079)` };
  if (!Number.isSafeInteger(b.uid) || b.uid <= 0) return { problem: `the ${BUILDER} user's uid is ${b.uid}, which no wall can name` };
  const o = readUser(io, cfg.owner);
  if (o.exists && o.uid === b.uid) return { problem: `the ${BUILDER} user has the owner's own uid (${b.uid}); a wall on it would wall the owner` };
  return { uid: b.uid };
}

const op = (text, run) => ({ text, run });
const sameFile = (io, f, text, mode = 0o644) => { const s = lstatOr(io, f); try { return !!s && s.isFile() && !s.isSymbolicLink() && s.uid === io.rootUid && (s.mode & 0o7777) === mode && io.readText(f) === text; } catch { return false; } };

/** `place`: → { ops, problems }. Safe to run twice: what is already right adds no op, but the job is always (re)loaded so it runs now. */
export function planWall(io, cfg) {
  const id = builderUid(io, cfg);
  if (id.problem) return { ops: [], problems: [`${id.problem}. Nothing was changed.`] };
  const problems = [];
  // The folders written in, and the base itself (r1 m8: the token folder is made in it, so the base must be root's alone too).
  for (const d of [ANCHOR_DIR, DAEMON_DIR, cfg.base]) {
    const above = chainProblem(io.at(d), { owner: io.rootUid, top: io.prefix || '/' });
    if (above) problems.push(`${d} is not safe for root to write in (${above}); nothing was changed`);
  }
  const dir = lstatOr(io, wallDir(cfg));
  if (dir && (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== io.rootUid)) problems.push(`${wallDir(cfg)} is there but is not a folder of root's; look at it, remove it by hand, and run this again. Nothing was changed`);
  if (problems.length) return { ops: [], problems };
  const ops = []; const text = anchorText(id.uid); const job = wallPlist(cfg);
  if (!sameFile(io, ANCHOR_FILE, text)) ops.push(op(`write ${ANCHOR_FILE}   (root:wheel 0644; the rules for uid ${id.uid})`, () => writeAside(io, ANCHOR_FILE, text)));
  if (!dir) ops.push(op(`mkdir ${wallDir(cfg)}   (root 0700)`, () => { io.mkdir(wallDir(cfg), 0o700); io.secure(wallDir(cfg), { uid: io.rootUid, gid: 0, mode: 0o700 }); }));
  else if ((dir.mode & 0o7777) !== 0o700) ops.push(op(`set owner and mode of ${wallDir(cfg)}: chown 0:0, chmod 700`, () => io.secure(wallDir(cfg), { uid: io.rootUid, gid: 0, mode: 0o700, ino: dir.ino, dev: dir.dev })));
  if (!sameFile(io, wallPlistPath(cfg), job)) ops.push(op(`write ${wallPlistPath(cfg)}   (root:wheel 0644)`, () => writeAside(io, wallPlistPath(cfg), job)));
  const label = wallLabel(cfg);
  ops.push(op(`launchctl bootout system/${label} (if loaded), then launchctl bootstrap system ${wallPlistPath(cfg)}: it loads the rules and holds pf on`, () => {
    io.run(LAUNCHCTL, ['bootout', `system/${label}`]);   // not loaded is fine
    const r = io.run(LAUNCHCTL, ['bootstrap', 'system', io.at(wallPlistPath(cfg))]);
    if (r.status !== 0) throw new Error(`could not load ${label} (${said(r)})`);
  }));
  return guarded(io, cfg, { ops, problems: [] });
}

/**
 * The way out, as steps root can run: used when the read-back refuses, and said after every run. → { done, lines }: `done`
 * only when every step was done; each step's failure is reported, never hidden.
 */
export function wayOut(io, cfg) {
  const lines = []; let done = true;
  const step = (what, cmd, args, fine = () => false) => {
    const r = io.run(cmd, args);
    if (r.status === 0 || fine(r)) lines.push(`done: ${what}`); else { done = false; lines.push(`NOT done: ${what} (${said(r)})`); }
  };
  // Not loaded is the same as unloaded (launchctl says 3, "No such process").
  step(`unload ${wallLabel(cfg)}`, LAUNCHCTL, ['bootout', `system/${wallLabel(cfg)}`], (r) => r.status === 3);
  try { io.unlink(wallPlistPath(cfg)); lines.push(`done: removed ${wallPlistPath(cfg)} (so it does not start at boot)`); } catch (e) { done = false; lines.push(`NOT done: remove ${wallPlistPath(cfg)} (${e?.code ?? e})`); }
  step(`empty ${ANCHOR}`, PFCTL, ['-a', ANCHOR, '-F', 'rules']);
  // pf's reference number for the wall's enable (pfctl -s References lists them to root); not a secret.
  let ref = null; try { ref = io.readText(tokenPath(cfg)).trim(); } catch { /* none kept */ }
  if (ref && /^\d+$/.test(ref)) { step(`release pf token ${ref}`, PFCTL, ['-X', ref]); try { io.unlink(tokenPath(cfg)); } catch { /* said by the next check */ } }
  else lines.push('no pf token was kept, so none was released');
  if (lstatOr(io, unreadPath(cfg))) { done = false; lines.push(`NOT done: pfctl -E once answered in a way no token could be read from (kept in ${unreadPath(cfg)}); find that reference with sudo pfctl -s References and release it with sudo pfctl -X <token>`); }
  return { done, lines };
}

export const WAY_OUT_TEXT = (cfg) => `To take the builder wall out: sudo launchctl bootout system/${wallLabel(cfg)}; sudo rm ${wallPlistPath(cfg)}; sudo ${PFCTL} -a ${ANCHOR} -F rules; and sudo ${PFCTL} -X with the number in ${tokenPath(cfg)}.`;

// --- the read-back ---------------------------------------------------------------------------------------------------

const pfOn = (io) => { const r = io.run(PFCTL, ['-s', 'info']); return { r, on: r.status === 0 && /^Status: Enabled\b/m.test(r.stdout) }; };
function tokenHeld(io, cfg) {
  let tok = null; try { tok = io.readText(tokenPath(cfg)).trim(); } catch { /* below */ }
  const refs = io.run(PFCTL, ['-s', 'References']);
  const held = !!tok && /^\d+$/.test(tok) && refs.status === 0 && refs.stdout.split('\n').some((l) => l.trim().split(/\s+/).includes(tok));
  return { tok, refs, held };
}

/** The settings half (iii, iv): [{ ok, what, why? }]. Reads only, as root. The wiring PR's gate runs it before every builder session. */
export function settingsChecks(io, cfg, uid) {
  const out = []; const item = (ok, what, why) => out.push(ok ? { ok, what } : { ok, what, why });
  const want = anchorText(uid);
  const f = lstatOr(io, ANCHOR_FILE);
  item(sameFile(io, ANCHOR_FILE, want), `${ANCHOR_FILE} is the wall's rules for uid ${uid}, root's 0644`, !f ? 'it is not there (run place)' : 'it is there but not the rules for this uid, or not root\'s 0644');
  const { r: info, on } = pfOn(io);
  item(on, 'pf is on (iii)', info.status !== 0 ? `pfctl -s info failed (${said(info)})` : `pf is off${f ? ' though the anchor file is there' : ''}: the rules are loaded but nothing applies them`);
  const { tok, refs, held } = tokenHeld(io, cfg);
  const unread = lstatOr(io, unreadPath(cfg));
  item(held && !unread, `the pf token in ${tokenPath(cfg)} is held (iii): pf stays on while the job holds it`,
    unread ? `pfctl -E answered in a way no token could be read from (kept in ${unreadPath(cfg)}), so the job stopped: read it, then remove it and run place again`
      : !tok ? 'no token is kept there: the job has not enabled pf (look at it with: sudo launchctl print system/' + wallLabel(cfg) + ')'
        : !/^\d+$/.test(tok) ? 'what is kept there is not a token'
          : refs.status !== 0 ? `pfctl -s References failed (${said(refs)})` : `token ${tok} is not among pf's held references, so anything may turn pf off`);
  const main = io.run(PFCTL, ['-s', 'rules']);
  item(main.status === 0 && /^anchor "com\.apple\/\*"/m.test(main.stdout), 'the main ruleset reaches com.apple/* (iv)',
    main.status !== 0 ? `pfctl -s rules failed (${said(main)})` : 'the main ruleset has no anchor "com.apple/*", so the wall\'s anchor is never read (macOS\'s own /etc/pf.conf has it; something replaced the main ruleset)');
  const a = io.run(PFCTL, ['-a', ANCHOR, '-s', 'rules']);
  const why = a.status !== 0 ? `pfctl -a ${ANCHOR} -s rules failed (${said(a)})` : loadedRulesProblem(a.stdout, uid);
  item(why === null, `${ANCHOR} holds exactly the wall's rules (iv)`, why);
  return out;
}

/**
 * After bootstrap, the job's first run (RunAtLoad) may not have happened yet (#556 r1 M2): wait, at most `limitMs`, until
 * launchctl says it ran at least once and its last exit was 0, the token is held and pf is on. → one row.
 */
export async function waitForFirstRun(io, cfg, { limitMs = FIRST_RUN_WAIT_MS, stepMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const what = `the job ${wallLabel(cfg)} ran once and finished well (within ${limitMs / 1000} seconds of loading)`;
  const start = now(); let seen = 'launchctl has not shown it yet';
  for (;;) {
    const p = io.run(LAUNCHCTL, ['print', `system/${wallLabel(cfg)}`]);
    const runs = Number(/^\s*runs = (\d+)/m.exec(p.stdout ?? '')?.[1] ?? 0);
    const exit = /^\s*last exit code = (\S+)/m.exec(p.stdout ?? '')?.[1];
    if (p.status !== 0) seen = `launchctl print said ${said(p)}`;
    else if (runs >= 1 && exit !== undefined && exit !== '0' && !/never/.test(exit)) return { ok: false, what, why: `it ran and exited ${exit} (look at it with: sudo launchctl print system/${wallLabel(cfg)})` };
    else if (runs >= 1 && exit === '0') {
      const on = pfOn(io).on; const { held } = tokenHeld(io, cfg);
      if (on && held) return { ok: true, what };
      seen = `it ran and exited 0, but ${!on ? 'pf is off' : 'its token is not held'}`;
    } else seen = `it has run ${runs} time${runs === 1 ? '' : 's'}${exit ? `, last exit ${exit}` : ''}`;
    if (now() - start >= limitMs) return { ok: false, what, why: `after ${limitMs / 1000} seconds ${seen}` };
    await sleep(stepMs);
  }
}

/**
 * The traffic half (i, ii, v), in each protocol and address: the builder reaches its own listener, the owner its own, the
 * builder NOT the owner's (and the owner's listener received nothing from it), and the owner still reaches its own after.
 * `net`: { addresses() → [one other address of this Mac, or none], listen({ user, proto, host }) → Promise<{ port,
 * received() → how many connections or messages it has had, settle() → Promise, close() }>, connect({ user, proto, host,
 * port }) → Promise<'ok' | 'refused' | 'timeout' | 'error: …'> }.
 */
export async function trafficChecks(cfg, net) {
  const out = [];
  const other = net.addresses().slice(0, 1);
  if (!other.length) out.push({ ok: true, what: 'this Mac has no address but loopback, so only 127.0.0.1 and ::1 were probed' });
  // [what, the address probed, the address the listeners bind]: an owner service bound to every address (`*` or `::`)
  // is reached through loopback too, so it is probed as its own place.
  const places = [...FAMILIES.map(([f, h]) => [f, h, h]), ...ALL_ADDRESSES, ...other.map((a) => [`this Mac's own address`, a, a])];
  for (const proto of PROTOS) for (const [fam, host, bind] of places) {
    const where = `${proto.toUpperCase()} ${fam} (${host}${bind === host ? '' : `, listening on ${bind}`})`;
    let mine = null; let theirs = null;
    try {
      try { mine = await net.listen({ user: BUILDER, proto, host: bind }); theirs = await net.listen({ user: cfg.owner, proto, host: bind }); } catch (e) {
        out.push({ ok: false, what: `the probes could listen on ${where}`, why: `${e?.message ?? e}: nothing about ${where} was proven` });
        continue;
      }
      const v = await net.connect({ user: BUILDER, proto, host, port: mine.port });
      out.push(v === 'ok' ? { ok: true, what: `${BUILDER} reaches its own listener on ${where} (v; the proxy path)` } : { ok: false, what: `${BUILDER} reaches its own listener on ${where} (v; the proxy path)`, why: `it got ${v}: a worker session's sandboxed shell would lose its network proxy` });
      const ii = await net.connect({ user: cfg.owner, proto, host, port: theirs.port });
      out.push(ii === 'ok' ? { ok: true, what: `the owner reaches its own listener on ${where} (ii)` } : { ok: false, what: `the owner reaches its own listener on ${where} (ii)`, why: `it got ${ii}: the wall is blocking the owner` });
      await theirs.settle(); const before = theirs.received();
      const i = await net.connect({ user: BUILDER, proto, host, port: theirs.port });
      // (ii) again: the owner's listener is still up and answering, so a block in (i) is the wall's, not a listener gone.
      const again = await net.connect({ user: cfg.owner, proto, host, port: theirs.port });
      await theirs.settle(); const got = theirs.received() - before - (again === 'ok' ? 1 : 0);
      out.push(again === 'ok' ? { ok: true, what: `the owner still reaches its own listener on ${where} after (i) (ii)` } : { ok: false, what: `the owner still reaches its own listener on ${where} after (i) (ii)`, why: `it got ${again}` });
      const what = `${BUILDER} can NOT reach the owner's listener on ${where} (i)`;
      if (v !== 'ok' || ii !== 'ok' || again !== 'ok') out.push({ ok: false, what, why: 'not proven: a control in this protocol and address failed' });
      else if (i === 'ok') out.push({ ok: false, what, why: `${BUILDER} connected: the wall is not up` });
      else if (got > 0) out.push({ ok: false, what, why: `the owner's listener received ${got} from ${BUILDER} (the probe said ${i}): what the builder sent got through` });
      else if (i === 'refused' || i === 'timeout') out.push({ ok: true, what });
      else out.push({ ok: false, what, why: `the probe said ${i}, which is not a block` });
    } finally { mine?.close(); theirs?.close(); }
  }
  return out;
}

/** The whole read-back: [{ ok, what, why? }]. `id`: builderUid's answer, when the caller has read it already. */
export async function checkWall(io, cfg, { net = realNet(), id = builderUid(io, cfg) } = {}) {
  if (id.problem) return [{ ok: false, what: 'the builder wall', why: id.problem }];
  return [...settingsChecks(io, cfg, id.uid), ...await trafficChecks(cfg, net)];
}

// --- the real probes: node run as the builder or the owner, through sudo, each on its own ----------------------------

// The listener says GOT for each connection or message it receives, so (i) can tell a block from a reply that was lost.
const LISTENER = `const [proto, host] = process.argv.slice(1); const end = () => process.exit(0); setTimeout(end, 60000).unref(); process.stdin.on('end', end); process.stdin.resume();
const got = () => process.stdout.write('GOT\\n');
if (proto === 'tcp') { const s = require('net').createServer((c) => { got(); c.end(); }); s.listen(0, host, () => process.stdout.write('PORT ' + s.address().port + '\\n')); s.on('error', (e) => { process.stdout.write('ERR ' + e.code + '\\n'); end(); }); }
else { const s = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4'); s.on('message', (m, r) => { got(); s.send('pong', r.port, r.address); }); s.on('error', (e) => { process.stdout.write('ERR ' + e.code + '\\n'); end(); }); s.bind(0, host, () => process.stdout.write('PORT ' + s.address().port + '\\n')); }`;
const CLIENT = `const [proto, host, port] = process.argv.slice(1); const say = (w) => { process.stdout.write(w); process.exit(0); }; setTimeout(() => say('timeout'), 3000);
if (proto === 'tcp') { const c = require('net').connect(Number(port), host, () => say('ok')); c.on('error', (e) => say(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'refused' : 'error: ' + e.code)); }
else { const s = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4'); s.on('message', (m) => say(String(m) === 'pong' ? 'ok' : 'error: odd reply')); s.on('error', (e) => say(e.code === 'ECONNREFUSED' ? 'refused' : 'error: ' + e.code)); s.connect(Number(port), host, () => s.send('ping')); }`;

const ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' });
/** One address of this Mac that is not loopback (IPv4, not link-local), for the probe through it (#556 r1 m4). */
export function otherAddresses(ifaces = networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list ?? []) if (!a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.')) return [a.address];
  return [];
}
export function realNet({ node = PROBE_NODE } = {}) {
  const as = (user) => ['-n', '-H', '-u', user, node];
  return {
    addresses: () => otherAddresses(),
    listen: ({ user, proto, host }) => new Promise((resolve, reject) => {
      // From /, which every user may enter: root's own folder may be one the builder can't.
      const p = spawn(SUDO, [...as(user), '-e', LISTENER, proto, host], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], env: ENV });
      let buf = ''; let err = ''; let ready = false;
      const t = setTimeout(() => { p.kill(); reject(new Error(`a listener as ${user} did not start within 10 seconds`)); }, 10_000);
      p.stderr.on('data', (d) => { err += d; });
      p.stdout.on('data', (d) => {
        buf += d; if (ready) return;
        const m = /^PORT (\d+)$/m.exec(buf); const e = /^ERR (\S+)$/m.exec(buf);
        if (m) {
          ready = true; clearTimeout(t);
          resolve({
            port: Number(m[1]),
            received: () => (buf.match(/^GOT$/mg) ?? []).length,
            // A GOT the listener printed reaches this process a moment later: let it.
            settle: () => new Promise((r) => setTimeout(r, 300)),
            close: () => { p.stdin.end(); p.kill(); },
          });
        } else if (e) { clearTimeout(t); p.kill(); reject(new Error(`a listener as ${user} could not bind ${host} (${e[1]})`)); }
      });
      p.on('exit', (c) => { clearTimeout(t); if (!ready) reject(new Error(`a listener as ${user} ended (exit ${c}${err.trim() ? `: ${err.trim().slice(0, 100)}` : ''})`)); });
    }),
    connect: ({ user, proto, host, port }) => new Promise((resolve) => {
      const p = spawn(SUDO, [...as(user), '-e', CLIENT, proto, host, String(port)], { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
      let o = ''; let e = '';
      const t = setTimeout(() => p.kill(), 20_000);
      p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
      p.on('close', (c) => { clearTimeout(t); const w = o.trim(); resolve(c === 0 && /^(ok|refused|timeout|error: .*)$/.test(w) ? w : `error: the probe as ${user} did not answer (${said({ status: c, stdout: o, stderr: e })})`); });
    }),
  };
}

// --- the command ------------------------------------------------------------------------------------------------------

const USAGE = 'usage: sudo /usr/local/bin/node builder-wall.mjs <place [--dry-run] | check>';

/** → exit code. `io`, `net` and `wait` (waitForFirstRun's options) are ports for the tests. */
export async function main(argv, { io = realIo(), net, wait = {}, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const [cmd, ...rest] = argv; const dry = rest.includes('--dry-run');
  if (!['place', 'check'].includes(cmd) || rest.some((a) => a !== '--dry-run') || (dry && cmd !== 'place')) { err(USAGE); return 2; }
  if (!dry) { const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; } }
  let cfg;
  try {
    let raw; try { raw = JSON.parse(io.readConfig(ROOT_CONFIG_PATH, { strict: true })); } catch (e) { throw new Error(e instanceof SyntaxError ? 'the config is not valid JSON' : e.message); }
    cfg = parseInstallConfig(raw);
  } catch (e) { err(`refused: ${e.message}`); return 2; }
  const probes = net ?? realNet();
  const report = (res) => { for (const r of res) out(r.ok ? `PASS  ${r.what}` : `FAIL  ${r.what} — ${r.why}`); const bad = res.filter((r) => !r.ok).length; out(bad ? `${bad} of ${res.length} FAILED` : `all ${res.length} PASS`); return bad; };
  // L1193: every check and every place leaves the status, so a stale "ok" never stands; a write that fails is said and fails the run.
  const record = (rows, uid) => { try { writeStatus(io, cfg, statusOf(rows, uid)); return true; } catch (e) { err(`the wall's status could not be written to ${wallStatusPath(cfg)} (${e?.message ?? e}); the worker runner holds every start once it is two beats old`); return false; } };
  const takeOut = (why) => {
    const w = wayOut(io, cfg);
    err(w.done ? `${why}, so the wall was taken out again:` : `${why}. Taking the wall out again did NOT fully work; do the NOT done steps by hand:`);
    for (const l of w.lines) err(l);
  };
  if (cmd === 'check') {
    const id = builderUid(io, cfg);
    const rows = await checkWall(io, cfg, { net: probes, id });
    const bad = report(rows); const wrote = record(rows, id.uid ?? null);
    out(WAY_OUT_TEXT(cfg));
    return bad || !wrote ? 1 : 0;
  }
  const plan = planWall(io, cfg);
  if (plan.problems.length) { for (const p of plan.problems) err(`refused: ${p}`); return 1; }
  if (dry) { for (const o of plan.ops) out(`would: ${o.text}`); out('would then wait for the job\'s first run, run the read-back, and take the wall out again if either refuses'); return 0; }
  const id = builderUid(io, cfg);
  for (const o of plan.ops) {
    out(`doing: ${o.text}`);
    try { o.run(); } catch (e) { err(`stopped: ${e.message}`); takeOut('A step failed'); record([{ ok: false, what: 'place', why: `a step failed (${e.message}) and the wall was taken out again` }], id.uid ?? null); return 1; }
  }
  const first = await waitForFirstRun(io, cfg, wait);
  const rows = [first, ...await checkWall(io, cfg, { net: probes, id })];
  const bad = report(rows);
  if (bad) { takeOut('The read-back refused'); record([{ ok: false, what: 'place', why: 'the read-back refused, so the wall was taken out again' }, ...rows], id.uid ?? null); return 1; }
  const wrote = record(rows, id.uid ?? null);
  out(WAY_OUT_TEXT(cfg));
  return wrote ? 0 : 1;
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (self === import.meta.url) process.exitCode = await main(process.argv.slice(2));
