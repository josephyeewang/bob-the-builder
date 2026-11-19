#!/usr/bin/env node
// R-0b-179 (L1148 F1, L1149, L1150), v2 (2026-11-16): the builder wall. The builder user (L1079) reaches only its OWN
// listeners on this Mac: never the owner's dev servers, databases, Claude or codex control ports, nor root's local
// services. Measured before it (L1148): the Application Firewall is off and pf holds only Apple's anchors, so every Mac
// user reaches every 127.0.0.1 service.
//
// Why v2 (Principle 9: the v1 note below was a capability claim, and it was wrong). v1 tagged the builder's packets on the
// way out of lo0 and blocked tagged packets on the way in to a listener that was not the builder's. The tag shape was
// DISPROVED on macOS 27.0.1 on 2026-11-16 (Joe's wall-diag and wall-diag2 runs): a tag set by a `pass out ... tag` rule is
// not seen by a `tagged` rule on the way in over lo0, so v1 blocked nothing. Measured in the same runs: pf's `user` is the
// SENDING socket's owner on the way out and the RECEIVING socket's owner on the way in; a `block return out` on lo0 shows
// to TCP as a timeout, a `block return in` as refused, and to UDP both show as no answer. So v2 tells the builder's
// traffic by PORT. One range, WALL_RANGE (shared/builder-ports.mjs, its one home), is the builder's on loopback:
//
//   1. block return out quick on lo0 proto udp from any to any port <outside R> user <b>
//   2. block return out quick on lo0 proto tcp from any to any port <outside R> user <b> flags S/SA
//        the builder opens nothing on loopback outside R. `flags S/SA` matches only a connection's first packet, so the
//        builder's replies on a connection someone opened TO it (a SYN-ACK, every later packet) still go out. UDP has no
//        connection: every builder UDP packet on loopback must go to a port in R, an answer included
//   3. block return in quick on lo0 proto { tcp udp } from any to any port <R> user != <b>
//        a socket in R that is not the builder's gets nothing: so the builder reaches only its own listeners in R
//   4. block return out quick on ! lo0 proto { tcp udp } from any to self user <b>   (kept from v1)
//   5. block return out quick on lo0 proto udp from any to any port <outside R> user unknown
//   6. block return out quick on lo0 proto tcp from any to any port <outside R> user unknown flags S/SA
//   7. block return out quick on ! lo0 proto { tcp udp } from any to self user unknown
//        rules 1, 2 and 4 again for a packet whose owner pf could not find (L1308). pf learns a packet's user by looking
//        up its socket; on a miss it leaves the uid at UID_MAX, and `user = <b>` does not match UID_MAX, so the packet
//        passes: the `user` match fails OPEN (read in apple-oss-distributions/xnu bsd/net/pf.c pf_socket_lookup and
//        pf_match_uid, 2026-11-19; seen on macOS 27.0.1: a builder TCP connect and a builder UDP ping, about one blocked
//        probe in a hundred while probes ran side by side, 18 and 19 Nov). `user unknown` matches exactly that miss, so
//        5-7 close it for every user's packet the lookup misses. Measured cost (19 Nov, ten read-backs plus the Mac's own
//        traffic, about 6.5 minutes): one packet. Rule 3 needs no twin: `user != <b>` already matches a miss, so it fails
//        closed. Why the lookup misses is not known; this is a capability note about macOS 27.0.1's pf: re-measure on an
//        upgrade (wall-check-loop in the lead's tools runs the read-back in a loop).
// No rule names a family, so IPv4 and IPv6 (127.0.0.1 and ::1, 0.0.0.0 and ::) are covered alike. A connect to one of this
// Mac's other addresses goes through lo0 too (the read-back probes one); rule 4 covers it off lo0 all the same. pf turns
// `self` into the Mac's addresses when the rules load: after an address changes, `check` fails (safe) on rule 4 until
// the wall's job loads the rules again.
// #617 r1 M1: the first v2 had a fifth rule, a `pass` for builder UDP from R to any ephemeral port, so a builder UDP
// server could answer. It let a builder socket in R hold a two-way UDP conversation with any user's socket on an
// ephemeral port (netstat lists them to anyone, so nothing had to be guessed). It is gone (the lead's ruling).
//
// The costs, said in setup/README.md too:
//   - Every server the builder runs that something on loopback must reach (Claude Code's proxy, a dev server a worker
//     starts) must listen in R. The builder can't reach even its OWN listener outside R. Claude Code runs its own network
//     proxy on a port it picks, so builder sessions are pointed at the allow-list proxy (setup/builder-proxy.mjs) in R
//     instead (render-settings httpProxyPort / socksProxyPort; checked: claude-code 2.1.316).
//   - The owner (and every other user) can't use a listener of its own in R, nor reach it. place refuses while one is
//     there; check says so as a WARN row (it does not fail the check) when one has started since.
//   - Builder UDP on loopback is confined to R both ways: a builder UDP server can't answer a client outside R (the
//     owner's, or the builder's own from a port the kernel picked). Accepted (#617 r1 M1): the proxy is TCP, and DNS goes
//     over mDNSResponder's Unix socket, not loopback UDP.
//
// Known limits (#556 r1, L1158; said in Joe's run sheet too):
//   - A packet sent by a setuid-root program the builder runs (traceroute's UDP probes, ping) comes from root's socket, so
//     no `user` rule sees it as the builder's. Such a program sends probes; it holds no conversation the builder can use.
//   - Unix sockets are outside pf (#617 r1 m5, an open item for the lead): a builder process outside Claude Code's
//     sandbox can connect to any Unix socket whose file it may write, a Homebrew Postgres's /tmp/.s.PGSQL.5432 for one.
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
// It refuses, changing nothing, when the Mac's ephemeral port range (sysctl net.inet.ip.portrange.*) is not inside
// EPHEMERAL or overlaps R, or when a socket that is not the builder's already listens in R (lsof): the wall would cut it off.
// Then it waits (15 seconds at most) for the job's first run to have finished well, runs the read-back, and when either
// refuses, takes the wall out again (the way out, below) and says why: a wall that blocks the owner or the builder's own
// proxy never stays live.
//
// The read-back (`check`, and the last step of `place`) refuses when (L1149, L1150):
//   (i)   the builder connects to a throwaway listener of the owner's, in R or outside it, or that listener received what
//         it sent
//   (ii)  the owner can not connect to its own throwaway listener outside R, before (i) or after it
//   (iii) the anchor file is there but pf is off, or the token this job keeps isn't held
//   (iv)  the rules didn't load: com.apple/100.orchestrate.builder isn't exactly these rules, or the main ruleset has no
//         `anchor "com.apple/*"` to reach it; or the ephemeral range has moved into R
//   (v)   the builder can't reach its own throwaway listener in R (the proxy path would be cut)
//   (vi)  TCP only: the owner can't reach the builder's listener in R and hear its answer (`flags S/SA` at work)
//   (vii) the builder reaches its own listener outside R (rules 1 and 2 not at work: the documented cost not paid)
//   (viii) UDP over 127.0.0.1 and ::1: the builder, from a port in R, reaches an owner's listener on an ephemeral port
//         (#617 r1 M1: the hole the removed pass rule left)
// In each of TCP and UDP over 127.0.0.1, ::1, 0.0.0.0, :: and one other address of this Mac, on every run; the builder's
// UDP probes for (v), (vii) and (viii) send from a port in R, (i)'s from one the kernel picks. A blocked row proves
// nothing unless (ii) and (v) passed in the same protocol and address, and its listener is still running: they are its
// controls, as proofs.mjs's are. A timeout counts as a block only when the listener received nothing. The read-back
// counts its rows and refuses when the count is not the one expected (#617 r1 m7: a row skipped is no pass). One row
// is a WARN, never a failure: another user's socket listening in R (#617 r1 m2).
//
// How macOS's pfctl prints these rules was seen on this Mac for `port = N`, `port a:b` and `user = N` / `user != N`
// (wall-diag2, 2026-11-16); `port a <> b` and `flags S/SA` are read from OpenBSD's pfctl (print_rule), from which macOS's
// comes, and are not yet seen. The check splits each printed rule in four: the words before `from` and the words after
// the destination, each taken as a set, and the from part and the to part, each in order (#617 r1 m1: so a rule with its
// source and destination swapped is another rule). It wants exactly the wall's: a word missing, a word more or a part
// moved refuses, so an unexpected print fails closed, never open (and place then takes it out). The self rule's
// address must be one of this Mac's own (os.networkInterfaces, plus loopback), or `self` itself, or (seen on macOS
// 2026-11-18: a Mac with many IPv6 addresses) a table pfctl made of them as it loaded, printed `<__automatic_<hex>_<n>>`
// (AUTO_TABLE). Such a table counts only in the self rule, and only once it is proven: settingsChecks reads it with
// `pfctl -a <ANCHOR> -t <name> -T show` (pfctl(8): a table made inside an anchor is that anchor's own), and it must hold
// at least one entry and every entry one of this Mac's own addresses (tableProblem). Any other table name, a table that
// can't be read, an empty one or one holding any other address refuses.
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
import { BUILDER, DAEMON_DIR, JOB_PATH, LAUNCHCTL, ROOT_CONFIG_PATH, wallDir, wallStatusDir, wallStatusPath } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { guarded } from './guard.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { writeAside } from './dispatcher-setup.mjs';
import { installPaths, parseInstallConfig } from './install.mjs';
import { NODE, chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { SHA256 } from '../shared/plan-fingerprint.mjs';
import { EPHEMERAL, PROBE_FIRST, WALL_RANGE, inRange } from '../shared/builder-ports.mjs';

export const ANCHOR = 'com.apple/100.orchestrate.builder';
export const ANCHOR_DIR = '/private/etc/pf.anchors';
export const ANCHOR_FILE = `${ANCHOR_DIR}/orchestrate.builder`;
export { WALL_RANGE, EPHEMERAL };   // shared/builder-ports.mjs's one definition
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
const SYSCTL = '/usr/sbin/sysctl';
const LSOF = '/usr/sbin/lsof';
const SUDO = '/usr/bin/sudo';
/** The node every Mac user can run (nodejs.org's, root's; managed-settings.mjs NODE_BIN): the probes run it as the builder and the owner. */
export const PROBE_NODE = '/usr/local/bin/node';

export const wallLabel = (cfg) => `${cfg.label}.builder-wall`;
export const wallPlistPath = (cfg) => join(DAEMON_DIR, `${wallLabel(cfg)}.plist`);
export const tokenPath = (cfg) => join(wallDir(cfg), 'pf-token');
/** What `pfctl -E` said when no token could be read from it: the job stops there rather than take reference after reference. */
export const unreadPath = (cfg) => join(wallDir(cfg), 'pf-enable-unread');
const lstatOr = (io, p) => { try { return io.lstat(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const said = (r) => (String(r?.stderr ?? '').trim() || String(r?.stdout ?? '').trim()).slice(0, 160) || `exit ${r?.status}`;

/** The anchor's rules for the builder's uid. One home: the job loads this file, and the check matches what pf loaded against RULES. */
export function anchorText(uid) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`the builder's uid must be a whole number above 0, not ${uid}`);
  return [
    `# The builder wall v2 (R-0b-179; L1148, L1150): the ${BUILDER} user (uid ${uid}) reaches only its own listeners on this Mac,`,
    `# in ports ${R} on loopback (shared/builder-ports.mjs), and only it may be reached there.`,
    '# Written by the orchestrate setup (setup/builder-wall.mjs) and compared by its check: do not edit.',
    ...RULES.map((r) => r.text(uid)),
    '',
  ].join('\n');
}

const R = `${WALL_RANGE.first}:${WALL_RANGE.last}`;
const NOT_R = `${WALL_RANGE.first} <> ${WALL_RANGE.last}`;
/**
 * Each rule: its text, and the exact words pfctl prints for it in one protocol (one rule per protocol, `user = N`; `all`
 * only for a rule with no address and no port). The self rule alone may name a family and an address: pf turns `self`
 * into this Mac's own addresses as it loads, one rule each. Any other word (a family, another port, a group, `keep
 * state`, no `quick`) is a different rule, and refuses (#556 r1 m2). The header says which prints were seen on this Mac.
 */
export const RULES = Object.freeze([
  { id: 'udp-out', protos: ['udp'], text: (u) => `block return out quick on lo0 proto udp from any to any port ${NOT_R} user ${u}`,
    words: (u, p) => `block return out quick on lo0 proto ${p} from any to any port ${NOT_R} user = ${u}` },
  { id: 'tcp-out', protos: ['tcp'], text: (u) => `block return out quick on lo0 proto tcp from any to any port ${NOT_R} user ${u} flags S/SA`,
    words: (u, p) => `block return out quick on lo0 proto ${p} from any to any port ${NOT_R} user = ${u} flags S/SA` },
  { id: 'range-in', protos: PROTOS, text: (u) => `block return in quick on lo0 proto { tcp udp } from any to any port ${R} user != ${u}`,
    words: (u, p) => `block return in quick on lo0 proto ${p} from any to any port ${R} user != ${u}` },
  { id: 'self', protos: PROTOS, text: (u) => `block return out quick on ! lo0 proto { tcp udp } from any to self user ${u}`,
    words: (u, p) => `block return out quick on ! lo0 proto ${p} from any to ADDRESS user = ${u}`, anyAddress: true },   // ADDRESS: one of ownAddresses()
  // L1308: the same three for a packet whose socket pf could not find (`user unknown`; the header's rules 5-7).
  { id: 'udp-out-unknown', protos: ['udp'], text: () => `block return out quick on lo0 proto udp from any to any port ${NOT_R} user unknown`,
    words: (u, p) => `block return out quick on lo0 proto ${p} from any to any port ${NOT_R} user = unknown` },
  { id: 'tcp-out-unknown', protos: ['tcp'], text: () => `block return out quick on lo0 proto tcp from any to any port ${NOT_R} user unknown flags S/SA`,
    words: (u, p) => `block return out quick on lo0 proto ${p} from any to any port ${NOT_R} user = unknown flags S/SA` },
  { id: 'self-unknown', protos: PROTOS, text: () => 'block return out quick on ! lo0 proto { tcp udp } from any to self user unknown',
    words: (u, p) => `block return out quick on ! lo0 proto ${p} from any to ADDRESS user = unknown`, anyAddress: true },
]);

/** One loaded line → the lines it stands for, one per protocol (a `{ tcp udp }` pfctl did not split counts for both). */
function perProto(line) {
  const m = /\bproto\s+\{\s*([a-z0-9 ,]+?)\s*\}/.exec(line);
  return m ? m[1].split(/[\s,]+/).filter(Boolean).map((p) => line.replace(m[0], `proto ${p}`)) : [line];
}
// The words that end a rule's destination (pf.conf's filter options): the to part is the words from `to` up to one.
const AFTER_TO = new Set(['user', 'group', 'flags', 'keep', 'no', 'modulate', 'synproxy', 'tag', 'tagged', 'label', 'queue', 'rtable',
  'probability', 'allow-opts', 'icmp-type', 'icmp6-type', 'os', 'max-mss', 'fragment', 'route-to', 'reply-to', 'dup-to', 'divert-to',
  'divert-reply', 'prio', 'set', 'state']);
/**
 * A printed rule as the wall's are written (`from any to any` as `all`, the user as `user = N` / `user != N`; a `!`
 * belongs to the word after it), in four parts: { head, from, to, tail }. head and tail are sorted word sets; from and to
 * keep their order, so a swapped source and destination differ (#617 r1 m1). A rule with no from/to has them null.
 */
function parts(line, uid) {
  const ws = ` ${line} `.replace(/\s+/g, ' ').replace(/ from any to any (?!port )/, ' all ')
    .replace(/ user\s*(!=|=)?\s*(\S+) /, (_, op, who) => ` user ${op ?? '='} ${who === BUILDER ? uid : who} `)
    .trim().replace(/!\s+/g, '!').split(' ');
  const fromAt = ws.indexOf('from'); const toAt = fromAt < 0 ? -1 : ws.indexOf('to', fromAt + 1);
  if (fromAt < 0 || toAt < 0) return { head: [...ws].sort().join(' '), from: null, to: null, tail: '' };
  let toEnd = toAt + 1; while (toEnd < ws.length && !AFTER_TO.has(ws[toEnd])) toEnd += 1;
  return { head: ws.slice(0, fromAt).sort().join(' '), from: ws.slice(fromAt + 1, toAt).join(' '), to: ws.slice(toAt + 1, toEnd).join(' '), tail: ws.slice(toEnd).sort().join(' ') };
}
const key = (x) => `${x.head} | from ${x.from} | to ${x.to} | ${x.tail}`;
/**
 * This Mac's own addresses, as pf's `self` turns into them (scope dropped): every interface's, plus loopback's. The self
 * rule as loaded may name only these (#617 r1 m1).
 */
export function ownAddresses(ifaces = networkInterfaces()) {
  const out = new Set(['127.0.0.1', '::1', 'fe80::1']);
  for (const list of Object.values(ifaces ?? {})) for (const nic of list ?? []) if (nic?.address) out.add(String(nic.address).replace(/%.*$/, '').toLowerCase());
  return out;
}
/**
 * The name pfctl gives a table it makes, as it loads a rule, from the rule's address list (`self` turned into this Mac's
 * many addresses, for one), as `pfctl -s rules` prints it. Seen on macOS 2026-11-18: `<__automatic_c097741b_0>`.
 */
export const AUTO_TABLE = /^<__automatic_[0-9a-f]+_[0-9]+>$/;
/** Every table a printed rule text names (`<name>`; the port range's `<>` is no name). */
export const tablesNamed = (text) => [...new Set(String(text).match(/<[^<>\s]+>/g) ?? [])];
/** One line of `pfctl -t <name> -T show` → the one address it is, or null when it is not one plain address (`!x`, a network). */
function tableEntry(e) {
  const m = /^([0-9a-fA-F:.]+)(?:%\S*?)?(?:\/(\d+))?$/.exec(String(e).trim());
  if (!m) return null;
  if (m[2] !== undefined && Number(m[2]) !== (m[1].includes(':') ? 128 : 32)) return null;
  return m[1].toLowerCase();
}
/**
 * Null, or why the table `name` (as printed, with its `<>`) is not proven to hold only this Mac's own addresses. `read`:
 * { text } (what `pfctl -a <ANCHOR> -t <name> -T show` printed) or { error }, or undefined when it was not read.
 */
export function tableProblem(name, read, selfAddresses) {
  if (!AUTO_TABLE.test(name)) return `${name} is not a table pfctl makes for \`self\` (only <__automatic_<hex>_<n>> is taken)`;
  if (!read) return `${name} was not read, so what it holds is not known`;
  if (read.error !== undefined) return `${name} could not be read (${String(read.error).slice(0, 120)})`;
  const entries = String(read.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!entries.length) return `${name} is empty`;
  for (const e of entries) {
    const a = tableEntry(e);
    if (a === null || !selfAddresses.has(a)) return `${name} holds ${e.slice(0, 60)}, which is not one of this Mac's own addresses`;
  }
  return null;
}
function fits(r, uid, line, p, selfAddresses, proven) {
  if (!r.protos.includes(p)) return false;
  const got = parts(line, uid); const want = parts(r.words(uid, p), uid);
  if (r.anyAddress) {
    const named = String(got.to ?? '').replace(/%\S*$/, '').toLowerCase();
    if (named !== 'self' && !selfAddresses.has(named) && !proven.has(named)) return false;
    got.to = 'ADDRESS'; got.head = got.head.split(' ').filter((x) => x !== 'inet' && x !== 'inet6').join(' ');
  }
  return key(got) === key(want);
}

/**
 * Null, or why the anchor as pfctl prints it is not these rules (iv): each rule in each protocol, and no line that is none of
 * them. `text`: `pfctl -a <ANCHOR> -s rules`. `selfAddresses`: the addresses the self rule may name (ownAddresses()).
 * `tables`: Map of each table the text names (`<name>`) → what reading it gave, { text } or { error } (settingsChecks
 * reads them). A line naming a table not proven by tableProblem refuses; a proven one counts in the self rule alone.
 */
export function loadedRulesProblem(text, uid, { selfAddresses = ownAddresses(), tables = new Map() } = {}) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).flatMap(perProto);
  if (!lines.length) return `${ANCHOR} holds no rules`;
  const proven = new Set();
  for (const l of lines) for (const name of tablesNamed(l)) {
    const why = tableProblem(name, tables.get(name), selfAddresses);
    if (why) return `${ANCHOR} holds a line naming a table not proven to hold only this Mac's own addresses: ${why}: ${l.slice(0, 120)}`;
    proven.add(name);
  }
  const missing = [];
  for (const r of RULES) for (const p of r.protos) if (!lines.some((l) => fits(r, uid, l, p, selfAddresses, proven))) missing.push(`${r.id} (${p})`);
  const extra = lines.filter((l) => !RULES.some((r) => PROTOS.some((p) => fits(r, uid, l, p, selfAddresses, proven))));
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

// The job file's plist, written the way review-daemons.mjs writes its own (its helpers are not exported). Exported for
// setup's other root job (worker-rules.mjs, L1226), so the two root jobs write their files one way.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const str = (s) => `<string>${esc(s)}</string>`;
export const arr = (xs) => `<array>${xs.map(str).join('')}</array>`;
export const plist = (entries) => ['<?xml version="1.0" encoding="UTF-8"?>',
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
  // The form, round-tripped: a date that is none makes toISOString throw, which is caught to say so plainly.
  const iso = () => { try { return new Date(s.time).toISOString(); } catch { return null; } };
  const real = typeof s.time === 'string' && ISO.test(s.time) && iso() === s.time;
  if (!real) throw new Error('the status\'s time is not a real UTC time as toISOString writes it');
  if (s.builderUid !== null && (!Number.isSafeInteger(s.builderUid) || s.builderUid <= 0)) throw new Error('the status\'s builderUid is not a uid above 0, nor null');
  if (s.anchorSha256 !== null && (typeof s.anchorSha256 !== 'string' || !SHA256.test(s.anchorSha256))) throw new Error('the status\'s anchorSha256 is not 64 lowercase hex, nor null');
  if (typeof s.ok !== 'boolean') throw new Error('the status\'s ok is not true or false');
  if (!Array.isArray(s.why) || s.why.length > WHY_MAX || !s.why.every((w) => typeof w === 'string' && w.length > 0 && w.length <= WHY_CHARS)) throw new Error(`the status's why is not a list of at most ${WHY_MAX} short reasons`);
  if (s.ok && (s.builderUid === null || s.anchorSha256 === null || s.why.length)) throw new Error('the status says ok without a uid, its rules\' hash, or with a reason against it');
  if (!s.ok && !s.why.length) throw new Error('the status says not ok but gives no reason');
  // Exactly the writer's bytes: a key given twice, space around the JSON or another key order is refused (L1205).
  if (`${body}\n` !== lineOf(s)) throw new Error('the status is not written exactly as statusText writes it');
  return Object.freeze({ ...s, why: Object.freeze([...s.why]) });
}

/** The status's text: one line, as parseStatus reads it (it is checked by parseStatus before it is returned). */
export function statusText(status) {
  const line = lineOf(status);
  parseStatus(line);
  return line;
}
const lineOf = (status) => `${JSON.stringify(Object.fromEntries(STATUS_KEYS.map((k) => [k, status?.[k]])))}\n`;

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
  writeRootFile(io, cfg, wallStatusDir(cfg), wallStatusPath(cfg), statusText(status));
}

/**
 * One file root writes in a folder of its own under the base, whole or not at all; shared with worker-rules.mjs (L1226).
 * The base and the folder must be safe for root (chainProblem); the folder is made root's 0755 if missing, and anything
 * else at its name is refused. The old file must be one plain file of root's with one name (L1205). Anything else is
 * only a name in root's own folder: it is removed, so nothing old stands behind the refusal, and the run says so.
 */
export function writeRootFile(io, cfg, dir, f, text) {
  const base = chainProblem(io.at(cfg.base), { owner: io.rootUid, top: io.prefix || '/' });
  if (base) throw new Error(`${cfg.base} is not safe for root to write in (${base})`);
  const st = lstatOr(io, dir);
  if (!st) { io.mkdir(dir, 0o755); io.secure(dir, { uid: io.rootUid, gid: 0, mode: 0o755 }); }
  else if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== io.rootUid) throw new Error(`${dir} is there but is not a folder of root's; look at it and remove it by hand`);
  else if ((st.mode & 0o7777) !== 0o755 || st.gid !== 0) io.secure(dir, { uid: io.rootUid, gid: 0, mode: 0o755, ino: st.ino, dev: st.dev });
  const above = chainProblem(io.at(dir), { owner: io.rootUid, top: io.prefix || '/' });
  if (above) throw new Error(`${dir} is not safe for root to write in (${above})`);
  const old = lstatOr(io, f);
  if (old && (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1 || old.uid !== io.rootUid)) {
    io.unlink(f);
    throw new Error(`${f} was not one plain file of root's (${old.isSymbolicLink() ? 'a link' : !old.isFile() ? 'not a plain file' : old.nlink !== 1 ? `${old.nlink} names` : 'not root\'s'}); it was removed, and nothing new was written`);
  }
  writeAside(io, f, text);
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

/** The sysctl names of the Mac's ephemeral port ranges: every port the kernel picks for a client comes from one of them. */
export const PORT_RANGE_SYSCTLS = Object.freeze(['net.inet.ip.portrange.first', 'net.inet.ip.portrange.last', 'net.inet.ip.portrange.hifirst', 'net.inet.ip.portrange.hilast']);

/**
 * Null, or why the Mac's ephemeral range does not fit the wall (iv): it must lie inside EPHEMERAL, and so clear of R. A
 * port the kernel picks for one of the owner's clients inside R would be cut off by rule 3 (its answers, refused coming
 * in); and (viii) probes an owner's listener on a port the kernel picks, which must be an ephemeral one.
 */
export function ephemeralProblem(io) {
  const r = io.run(SYSCTL, ['-n', ...PORT_RANGE_SYSCTLS]);
  const n = String(r.stdout ?? '').trim().split(/\s+/).map(Number);
  if (r.status !== 0 || n.length !== 4 || !n.every(Number.isInteger)) return `sysctl could not read the ephemeral port range (${said(r)})`;
  const [first, last, hifirst, hilast] = n;
  for (const [a, z] of [[first, last], [hifirst, hilast]]) {
    if (a < EPHEMERAL.first || z > EPHEMERAL.last || a > z) return `the Mac's ephemeral port range is ${a}-${z}, not inside ${EPHEMERAL.first}-${EPHEMERAL.last}: ${a <= WALL_RANGE.last && z >= WALL_RANGE.first ? `it overlaps the builder's ports ${R}, so the wall would cut off other users' connections` : 'the builder\'s UDP servers could not answer a client there'} (set it back with sudo sysctl -w net.inet.ip.portrange.first=${EPHEMERAL.first} net.inet.ip.portrange.last=${EPHEMERAL.last})`;
  }
  return null;
}

/**
 * Other users' sockets bound in R: → { theirs: ['TCP 127.0.0.1:47123 (uid 501, pid 9)', …] } or { error }. From `lsof -nP
 * -i<proto>:<R> -Fpun` (TCP: listening only); lsof says 1 with nothing printed when there is none. lsof lists a socket
 * when EITHER end's port is in R, so only the local end's port counts (#617 r1 m6: a client of the owner's talking to a
 * port in R is no listener there).
 */
export function rangeListeners(io, uid) {
  const theirs = [];
  for (const [proto, listening] of [['TCP', ['-sTCP:LISTEN']], ['UDP', []]]) {
    const r = io.run(LSOF, ['-nP', `-i${proto}:${WALL_RANGE.first}-${WALL_RANGE.last}`, ...listening, '-Fpun']);
    const out = String(r.stdout ?? '');
    if (r.status !== 0 && !(r.status === 1 && !out.trim())) return { error: `lsof could not list the ${proto} sockets in ${R} (${said(r)})` };
    let who = null; let pid = null;
    for (const l of out.split('\n')) {
      if (l.startsWith('p')) pid = l.slice(1); else if (l.startsWith('u')) who = Number(l.slice(1));
      else if (l.startsWith('n') && who !== uid) {
        const bound = l.slice(1).split('->')[0]; const boundPort = Number(/:(\d+)$/.exec(bound)?.[1]);
        if (inRange(boundPort)) theirs.push(`${proto} ${bound} (uid ${who}, pid ${pid})`);
      }
    }
  }
  return { theirs };
}
/** Null, or why another user's socket already listening in R refuses place: the wall would cut it off (rule 3). */
export function rangeListenersProblem(io, uid) {
  const { error, theirs } = rangeListeners(io, uid);
  if (error) return error;
  return theirs.length ? `${theirs.length === 1 ? 'a socket that is' : `${theirs.length} sockets that are`} not the ${BUILDER} user's already listen${theirs.length === 1 ? 's' : ''} in the builder's ports ${R}, which the wall would cut off: ${theirs.slice(0, 3).join(', ')}. Stop ${theirs.length === 1 ? 'it' : 'them'} or move ${theirs.length === 1 ? 'it' : 'them'} to another port; nothing was changed` : null;
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
  const eph = ephemeralProblem(io);
  if (eph) problems.push(`${eph}; nothing was changed`);
  const busy = rangeListenersProblem(io, id.uid);
  if (busy) problems.push(busy);
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

export const WAY_OUT_TEXT = (cfg) => `To take the builder wall out: sudo launchctl bootout system/${wallLabel(cfg)}; sudo rm ${wallPlistPath(cfg)}; sudo ${PFCTL} -a ${ANCHOR} -F rules; and sudo ${PFCTL} -X with the number in ${tokenPath(cfg)}. Until the wall is back, every worker session stays held: the check job keeps writing ok false. To stop that too, sudo node setup.mjs daemons unload --only worker-runner and sudo node setup.mjs daemons unload --only ${WALL_CHECK_JOB}.`;

// --- the read-back ---------------------------------------------------------------------------------------------------

const pfOn = (io) => { const r = io.run(PFCTL, ['-s', 'info']); return { r, on: r.status === 0 && /^Status: Enabled\b/m.test(r.stdout) }; };
function tokenHeld(io, cfg) {
  let tok = null; try { tok = io.readText(tokenPath(cfg)).trim(); } catch { /* below */ }
  const refs = io.run(PFCTL, ['-s', 'References']);
  const held = !!tok && /^\d+$/.test(tok) && refs.status === 0 && refs.stdout.split('\n').some((l) => l.trim().split(/\s+/).includes(tok));
  return { tok, refs, held };
}

/** How many times anchorRulesProblem reads the rules and their tables while the rules keep changing under it. */
export const RULE_READ_TRIES = 3;
/**
 * Null, or why the anchor pf holds is not the wall's rules (iv), read as root. Each table pfctl made inside the anchor (the
 * self rule's, AUTO_TABLE) is read, so loadedRulesProblem can prove it; a name of any other shape is not read
 * (loadedRulesProblem refuses it as it stands). The wall's job reloads the anchor every RECHECK_EVERY_S, and a reload may
 * give a table a new name: so when tables were read, the rules are read again after them, and when they changed the
 * whole pass is done again, RULE_READ_TRIES times in all; then the last pass's reason stands.
 */
function anchorRulesProblem(io, uid, selfAddresses) {
  let why = null;
  for (let tries = 1; ; tries += 1) {
    const a = io.run(PFCTL, ['-a', ANCHOR, '-s', 'rules']);
    if (a.status !== 0) return `pfctl -a ${ANCHOR} -s rules failed (${said(a)})`;
    const tables = new Map();
    for (const name of tablesNamed(a.stdout).filter((n) => AUTO_TABLE.test(n))) {
      const t = io.run(PFCTL, ['-a', ANCHOR, '-t', name.slice(1, -1), '-T', 'show']);
      tables.set(name, t.status === 0 ? { text: t.stdout } : { error: said(t) });
    }
    why = loadedRulesProblem(a.stdout, uid, { selfAddresses, tables });
    if (!tables.size) return why;
    const again = io.run(PFCTL, ['-a', ANCHOR, '-s', 'rules']);
    if (again.status === 0 && again.stdout === a.stdout) return why;
    if (tries >= RULE_READ_TRIES) return `${why ?? 'the rules read as the wall\'s'}, but they changed while being read, ${RULE_READ_TRIES} times running`;
  }
}

/**
 * The settings half (iii, iv): [{ ok, what, why?, warn? }], always SETTINGS_ROWS of them. Reads only, as root. The wiring
 * PR's gate runs it before every builder session. `selfAddresses`: loadedRulesProblem's. A row with `warn` is ok (it
 * fails nothing) but says something the owner should know.
 */
export const SETTINGS_ROWS = 7;
export function settingsChecks(io, cfg, uid, { selfAddresses } = {}) {
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
  const why = anchorRulesProblem(io, uid, selfAddresses ?? ownAddresses());
  item(why === null, `${ANCHOR} holds exactly the wall's rules (iv)`, why);
  const eph = ephemeralProblem(io);
  item(eph === null, `the Mac's ephemeral port range is inside ${EPHEMERAL.first}-${EPHEMERAL.last}, clear of the builder's ports (iv)`, eph);
  // #617 r1 m2: place refuses another user's listener in R; one started since is cut off by the wall, even from its own
  // user. Said, not failed: it harms no one but that listener's user.
  const busy = rangeListeners(io, uid);
  const what = `no other user's socket listens in the ${BUILDER} user's ports ${R}`;
  if (busy.error) out.push({ ok: true, warn: true, what, why: `${busy.error}: not known` });
  else if (busy.theirs.length) out.push({ ok: true, warn: true, what, why: `${busy.theirs.slice(0, 3).join(', ')}${busy.theirs.length > 3 ? ` and ${busy.theirs.length - 3} more` : ''}: the wall cuts ${busy.theirs.length === 1 ? 'it' : 'them'} off, even from ${busy.theirs.length === 1 ? 'its' : 'their'} own user; move ${busy.theirs.length === 1 ? 'it' : 'them'} to another port` });
  else out.push({ ok: true, what });
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
 * The traffic half (i, ii, v, vi, vii, viii), in each protocol and place. Four throwaway listeners: the builder's in R
 * and outside it, the owner's in R and outside it.
 *   controls: the builder reaches its own in R (v); the owner its own outside R (ii), before and after the blocked probes
 *   (vi):     TCP: the owner reaches the builder's in R and hears its answer (a builder UDP answer to a port outside R is
 *             blocked, #617 r1 M1)
 *   (viii):   UDP on 127.0.0.1 and ::1: the builder, from a port in R, does NOT reach the owner's on an ephemeral port
 *   blocked:  the builder does NOT reach the owner's outside R or in R (i), nor its own outside R (vii, the cost)
 * A blocked row passes only with its controls passed, its listener still running and nothing received there. The three
 * blocked probes run at once (a UDP block waits out the probe's 3 seconds).
 * `net`: { addresses() → [one other address of this Mac, or none], listen({ user, proto, host, inRange }) → Promise<{ port,
 * received() → how many connections or messages it has had, settle() → Promise, alive() → still running, close() }>,
 * connect({ user, proto, host, port, fromRange }) → Promise<'ok' | 'refused' | 'timeout' | 'error: …'> }. A listener
 * `inRange` takes a port in WALL_RANGE (from PROBE_FIRST, clear of the proxy's); otherwise one the kernel picks
 * (ephemeral, outside it). A UDP client `fromRange` sends from a port there too. `other`: net.addresses()'s first, when
 * the caller has read it.
 */
export async function trafficChecks(cfg, net, other = net.addresses().slice(0, 1)) {
  const out = [];
  if (!other.length) out.push({ ok: true, what: 'this Mac has no address but loopback (and link-local), so only 127.0.0.1 and ::1 were probed' });
  // [what, the address probed, the address the listeners bind]: a service bound to every address (`*` or `::`) is
  // reached through loopback too, so it is probed as its own place.
  const places = [...FAMILIES.map(([f, h]) => [f, h, h]), ...ALL_ADDRESSES, ...other.map((a) => [`this Mac's own address`, a, a])];
  const row = (ok, what, why) => out.push(ok ? { ok: true, what } : { ok: false, what, why });
  for (const proto of PROTOS) for (const [fam, host, bind] of places) {
    const where = `${proto.toUpperCase()} ${fam} (${host}${bind === host ? '' : `, listening on ${bind}`})`;
    const L = {};
    try {
      try {
        for (const [k, user, inRange] of [['bIn', BUILDER, true], ['bOut', BUILDER, false], ['oIn', cfg.owner, true], ['oOut', cfg.owner, false]]) L[k] = await net.listen({ user, proto, host: bind, inRange });
      } catch (e) {
        row(false, `the probes could listen on ${where}`, `${e?.message ?? e}: nothing about ${where} was proven`);
        continue;
      }
      // Builder UDP is confined to R both ways, so its probes that expect an answer, or test the range, send from R.
      const fromRange = proto === 'udp';
      const v = await net.connect({ user: BUILDER, proto, host, port: L.bIn.port, fromRange });
      row(v === 'ok', `${BUILDER} reaches its own listener in its ports on ${where} (v; the proxy path)`, `it got ${v}: a builder session would lose its network proxy`);
      const ii = await net.connect({ user: cfg.owner, proto, host, port: L.oOut.port });
      row(ii === 'ok', `the owner reaches its own listener on ${where} (ii)`, `it got ${ii}: the wall is blocking the owner`);
      if (proto === 'tcp') {
        const vi = await net.connect({ user: cfg.owner, proto, host, port: L.bIn.port });
        row(vi === 'ok', `the owner reaches the ${BUILDER} user's listener in its ports on ${where} and hears its answer (vi)`, `it got ${vi}: the builder's answers are blocked`);
      }
      // (viii) on loopback itself, the owner's listener being on an ephemeral port: the hole the removed pass rule left.
      const viii = proto === 'udp' && bind === host && FAMILIES.some(([, h]) => h === host);
      for (const l of [L.oOut, L.oIn, L.bOut]) await l.settle();
      const before = { oOut: L.oOut.received(), oIn: L.oIn.received(), bOut: L.bOut.received() };
      const [toOut, toIn, ownOut] = await Promise.all([[L.oOut, false], [L.oIn, false], [L.bOut, fromRange]]
        .map(([l, from]) => net.connect({ user: BUILDER, proto, host, port: l.port, fromRange: from })));
      // (ii) again: the owner's listener is still up and answering, so a block in (i) is the wall's, not a listener gone.
      const again = await net.connect({ user: cfg.owner, proto, host, port: L.oOut.port });
      for (const l of [L.oOut, L.oIn, L.bOut]) await l.settle();
      row(again === 'ok', `the owner still reaches its own listener on ${where} after (i) (ii)`, `it got ${again}`);
      const blocked = (what, said, l, k, extra = 0) => {
        const got = l.received() - before[k] - extra;
        if (v !== 'ok' || ii !== 'ok' || again !== 'ok') row(false, what, 'not proven: a control in this protocol and address failed');
        else if (!l.alive()) row(false, what, `not proven: the listener had stopped (the probe said ${said})`);
        else if (said === 'ok') row(false, what, `${BUILDER} connected: the wall is not up`);
        else if (got > 0) row(false, what, `the listener received ${got} from ${BUILDER} (the probe said ${said}): what the builder sent got through`);
        else if (said === 'refused' || said === 'timeout') row(true, what);
        else row(false, what, `the probe said ${said}, which is not a block`);
      };
      blocked(`${BUILDER} can NOT reach the owner's listener outside its ports on ${where} (i)`, toOut, L.oOut, 'oOut', again === 'ok' ? 1 : 0);
      blocked(`${BUILDER} can NOT reach the owner's listener in its ports on ${where} (i)`, toIn, L.oIn, 'oIn');
      blocked(`${BUILDER} can NOT reach its own listener outside its ports on ${where} (vii; the documented cost)`, ownOut, L.bOut, 'bOut');
      if (viii) {
        // On its own, after the others: what the owner's listener receives now is this probe's alone.
        const what = `${BUILDER}, from a port in its ports, can NOT reach the owner's listener on an ephemeral port on ${where} (viii)`;
        before.viii = L.oOut.received();
        const fromR = await net.connect({ user: BUILDER, proto, host, port: L.oOut.port, fromRange: true });
        await L.oOut.settle();
        if (!(L.oOut.port >= EPHEMERAL.first && L.oOut.port <= EPHEMERAL.last)) row(false, what, `not proven: the owner's listener took port ${L.oOut.port}, not one in ${EPHEMERAL.first}-${EPHEMERAL.last}`);
        else blocked(what, fromR, L.oOut, 'viii');
      }
    } finally { for (const l of Object.values(L)) l?.close(); }
  }
  return out;
}

/**
 * How many rows the read-back gives when every probe ran (#617 r1 m7): the settings half; then per place 7 for TCP (v, ii,
 * vi, ii again, i out, i in, vii) and 6 for UDP (no vi); (viii) on 127.0.0.1 and ::1; and a note when there is no other
 * address. `others`: 0 or 1.
 */
export const expectedRows = (others) => {
  const places = FAMILIES.length + ALL_ADDRESSES.length + others;
  return SETTINGS_ROWS + (others ? 0 : 1) + places * 7 + places * 6 + FAMILIES.length;
};

/**
 * The whole read-back: [{ ok, what, why?, warn? }]. `id`: builderUid's answer, when the caller has read it already.
 * `traffic`: trafficChecks, a port for the tests. A row count that is not expectedRows' adds a failing row: a probe
 * skipped proves nothing, so it never passes as if it ran (#617 r1 m7).
 */
export async function checkWall(io, cfg, { net = realNet(), id = builderUid(io, cfg), traffic = trafficChecks } = {}) {
  if (id.problem) return [{ ok: false, what: 'the builder wall', why: id.problem }];
  const other = net.addresses().slice(0, 1);
  const rows = [...settingsChecks(io, cfg, id.uid, { selfAddresses: net.selfAddresses?.() }), ...await traffic(cfg, net, other)];
  const want = expectedRows(other.length);
  if (rows.length !== want) rows.push({ ok: false, what: `the read-back ran all ${want} of its rows`, why: `it gave ${rows.length}: a row skipped or added is no proof, so the check refuses` });
  return rows;
}

// --- the real probes: node run as the builder or the owner, through sudo, each on its own ----------------------------

// The listener says GOT for each connection or message it receives, so (i) can tell a block from a reply that was lost.
// It never stops on a socket's error (a connection reset by a wall, #wall-diag V0): only on its parent's word or a minute.
// `lo hi`: a port picked at random in lo..hi, again on EADDRINUSE; `0 0`: one the kernel picks.
export const LISTENER = `const [proto, host, lo, hi] = process.argv.slice(1).map((x, i) => (i > 1 ? Number(x) : x)); const end = () => process.exit(0); setTimeout(end, 60000).unref(); process.stdin.on('end', end); process.stdin.resume();
process.on('uncaughtException', (e) => { process.stdout.write('NOTE ' + (e && e.code) + '\\n'); });
const got = () => process.stdout.write('GOT\\n'); let tries = 0;
const pick = () => (lo ? lo + Math.floor(Math.random() * (hi - lo + 1)) : 0);
const failed = (e, again) => { if (e.code === 'EADDRINUSE' && lo && (tries += 1) < 50) return again(); process.stdout.write('ERR ' + e.code + '\\n'); end(); };
if (proto === 'tcp') { const s = require('net').createServer((c) => { got(); c.on('error', () => {}); c.end(); }); const go = () => s.listen(pick(), host); s.on('listening', () => process.stdout.write('PORT ' + s.address().port + '\\n')); s.on('error', (e) => failed(e, go)); go(); }
else { const open = () => { const s = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4'); let up = false; s.on('message', (m, r) => { got(); s.send('pong', r.port, r.address, () => {}); }); s.on('error', (e) => { if (!up) { s.close(); failed(e, open); } }); s.bind(pick(), host, () => { up = true; process.stdout.write('PORT ' + s.address().port + '\\n'); }); }; open(); }`;
// `lo hi` (UDP only): send from a port picked at random in lo..hi, again on EADDRINUSE; left out, one the kernel picks.
export const CLIENT = `const [proto, host, port, lo, hi] = process.argv.slice(1).map((x, i) => (i > 1 ? Number(x) : x)); const say = (w) => { process.stdout.write(w); process.exit(0); }; setTimeout(() => say('timeout'), 3000);
process.on('uncaughtException', (e) => say('error: ' + (e && e.code)));
if (proto === 'tcp') { const c = require('net').connect(port, host, () => say('ok')); c.on('error', (e) => say(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'refused' : 'error: ' + e.code)); }
else { let tries = 0; const open = () => { const s = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4'); let bound = false; s.on('message', (m) => say(String(m) === 'pong' ? 'ok' : 'error: odd reply')); s.on('error', (e) => { if (!bound && e.code === 'EADDRINUSE' && lo && (tries += 1) < 50) { s.close(); return open(); } say(e.code === 'ECONNREFUSED' ? 'refused' : 'error: ' + e.code); }); s.bind(lo ? lo + Math.floor(Math.random() * (hi - lo + 1)) : 0, () => { bound = true; s.connect(port, host, () => s.send('ping')); }); }; open(); }`;

const ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' });
/**
 * One address of this Mac that is not loopback nor link-local, for the probe through it (#556 r1 m4): an IPv4 one if
 * there is one, else an IPv6 one (#617 r2: a Mac with only IPv6 beyond loopback is probed through it too).
 */
export function otherAddresses(ifaces = networkInterfaces()) {
  const all = Object.values(ifaces ?? {}).flatMap((list) => list ?? []).filter((a) => a && !a.internal);
  const four = all.find((a) => (a.family === 'IPv4' || a.family === 4) && !a.address.startsWith('169.254.'));
  if (four) return [four.address];
  const six = all.find((a) => (a.family === 'IPv6' || a.family === 6) && !/^fe[89ab]/i.test(a.address) && !a.address.includes('%'));
  return six ? [six.address] : [];
}
export function realNet({ node = PROBE_NODE } = {}) {
  const as = (user) => ['-n', '-H', '-u', user, node];
  return {
    addresses: () => otherAddresses(),
    selfAddresses: () => ownAddresses(),
    listen: ({ user, proto, host, inRange = false }) => new Promise((resolve, reject) => {
      // From /, which every user may enter: root's own folder may be one the builder can't.
      const span = inRange ? [PROBE_FIRST, WALL_RANGE.last] : [0, 0];
      const p = spawn(SUDO, [...as(user), '-e', LISTENER, proto, host, ...span.map(String)], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], env: ENV });
      let buf = ''; let err = ''; let ready = false; let running = true;
      p.on('exit', () => { running = false; });
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
            alive: () => running,
            close: () => { p.stdin.end(); p.kill(); },
          });
        } else if (e) { clearTimeout(t); p.kill(); reject(new Error(`a listener as ${user} could not bind ${host} (${e[1]})`)); }
      });
      p.on('exit', (c) => { clearTimeout(t); if (!ready) reject(new Error(`a listener as ${user} ended (exit ${c}${err.trim() ? `: ${err.trim().slice(0, 100)}` : ''})`)); });
    }),
    connect: ({ user, proto, host, port, fromRange = false }) => new Promise((resolve) => {
      const p = spawn(SUDO, [...as(user), '-e', CLIENT, proto, host, String(port), ...(fromRange && proto === 'udp' ? [String(PROBE_FIRST), String(WALL_RANGE.last)] : [])], { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
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
  // A WARN row passes (it is counted among the PASSes) but says why it is there.
  const report = (res) => { for (const r of res) out(!r.ok ? `FAIL  ${r.what} — ${r.why}` : r.warn ? `WARN  ${r.what} — ${r.why}` : `PASS  ${r.what}`); const bad = res.filter((r) => !r.ok).length; const warned = res.filter((r) => r.ok && r.warn).length; out(bad ? `${bad} of ${res.length} FAILED` : `all ${res.length} PASS${warned ? ` (${warned} with a WARN)` : ''}`); return bad; };
  // L1193: every check and every place leaves the status, so a stale "ok" never stands; a write that fails is said and fails the run.
  const record = (rows, uid, at = new Date()) => { try { writeStatus(io, cfg, statusOf(rows, uid, at)); return true; } catch (e) { err(`the wall's status could not be written to ${wallStatusPath(cfg)} (${e?.message ?? e}); the worker runner holds every start once it is two beats old`); return false; } };
  const takeOut = (why) => {
    const w = wayOut(io, cfg);
    err(w.done ? `${why}, so the wall was taken out again:` : `${why}. Taking the wall out again did NOT fully work; do the NOT done steps by hand:`);
    for (const l of w.lines) err(l);
  };
  // L1205 m1: a throw anywhere in the read-back (a probe, a settle, a command) is a failing row, never a run that ends
  // with the old status standing. m2: the status is stamped with the time the check started, not when it ended.
  const idOf = () => { try { return builderUid(io, cfg); } catch (e) { return { problem: `reading the ${BUILDER} user failed: ${e?.message ?? e}` }; } };
  const readBack = async (steps) => {
    try { return await steps(); } catch (e) { return [{ ok: false, what: 'the check', why: `it stopped: ${e?.message ?? e}` }]; }
  };
  if (cmd === 'check') {
    const id = idOf(); const at = new Date();
    const rows = await readBack(() => checkWall(io, cfg, { net: probes, id }));
    const bad = report(rows); const wrote = record(rows, id.uid ?? null, at);
    out(WAY_OUT_TEXT(cfg));
    return bad || !wrote ? 1 : 0;
  }
  const plan = planWall(io, cfg);
  if (plan.problems.length) { for (const p of plan.problems) err(`refused: ${p}`); return 1; }
  if (dry) { for (const o of plan.ops) out(`would: ${o.text}`); out('would then wait for the job\'s first run, run the read-back, and take the wall out again if either refuses'); return 0; }
  const id = idOf();
  for (const o of plan.ops) {
    out(`doing: ${o.text}`);
    try { o.run(); } catch (e) { err(`stopped: ${e.message}`); takeOut('A step failed'); record([{ ok: false, what: 'place', why: `a step failed (${e.message}) and the wall was taken out again` }], id.uid ?? null); return 1; }
  }
  const at = new Date();
  const rows = await readBack(async () => [await waitForFirstRun(io, cfg, wait), ...await checkWall(io, cfg, { net: probes, id })]);
  const bad = report(rows);
  if (bad) { takeOut('The read-back refused'); record([{ ok: false, what: 'place', why: 'the read-back refused, so the wall was taken out again' }, ...rows], id.uid ?? null, at); return 1; }
  const wrote = record(rows, id.uid ?? null, at);
  out(WAY_OUT_TEXT(cfg));
  return wrote ? 0 : 1;
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
// No top-level await at the entry (M4 review-install-closure.test.mjs): a dynamic import that main() makes, whose
// own imports reach back here, would wait on this file while this file waits on main(), and node would exit 13 with
// nothing said. A throw from main exits 1 at once, as an uncaught one did.
if (self === import.meta.url) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
