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
//   this Mac's other addresses goes through lo0 as well; a third rule blocks the builder to `self` off lo0 all the same.
//   Another user's connection TO a builder listener fails too, and that is intended (L1154): the builder's reply is tagged
//   and meets a socket that is not the builder's. builder-wall.test.mjs pins it; the read-back on the Mac does not probe it.
//
// What it places, as root (`place`):
//   /etc/pf.anchors/orchestrate.builder      the rules, root:wheel 0644 (anchorText)
//   <base>/builder-wall/                     root's 0700: pf-token, the pf enable reference this job holds
//   /Library/LaunchDaemons/<label>.builder-wall.plist   root's 0644. At load, at boot and every 5 minutes it loads the
//       rules into com.apple/100.orchestrate.builder (a child of the `anchor "com.apple/*"` that macOS's own /etc/pf.conf
//       has, and that com.apple.pfctl loads at every boot: so /etc/pf.conf is never edited) and, unless the token it
//       holds is still held and pf is on, enables pf with `pfctl -E` and keeps the new token.
// then runs the read-back, and when the read-back refuses, takes the wall out again (the way out, below) and says why: a
// wall that blocks the owner or the builder's own proxy never stays live.
//
// The read-back (`check`, and the last step of `place`) refuses in five cases (L1149, L1150):
//   (i)   the builder still connects to a throwaway listener of the owner's
//   (ii)  the owner can no longer connect to its own throwaway listener
//   (iii) the anchor file is there but pf is off, or the token this job keeps isn't held
//   (iv)  the rules didn't load: com.apple/100.orchestrate.builder isn't these rules, or the main ruleset has no
//         `anchor "com.apple/*"` to reach it
//   (v)   the builder can't reach its own throwaway listener (the proxy path would be cut)
// Both directions, in each of TCP and UDP over 127.0.0.1 and ::1, on every run. (i) proves nothing unless (ii) and (v)
// pass in the same family and protocol: they are its controls, as proofs.mjs's are.
//
// How pfctl prints loaded rules is read from OpenBSD's pfctl (print_rule), from which macOS's comes; it is not yet seen on
// this Mac (Joe's run sheet, laneA-localhost-ps.md part (c)). The check matches each rule by its words, in any order, so a
// different order passes, and a missing word refuses: an unexpected print fails closed, never open.
//
// The way out (said after every run): sudo launchctl bootout system/<label>.builder-wall; sudo rm the job file; sudo pfctl
// -a com.apple/100.orchestrate.builder -F rules; sudo pfctl -X <the token in <base>/builder-wall/pf-token>.

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { BUILDER, ROOT_CONFIG_PATH } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { guarded } from './guard.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { writeAside } from './dispatcher-setup.mjs';
import { parseInstallConfig } from './install.mjs';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';

export const ANCHOR = 'com.apple/100.orchestrate.builder';
export const ANCHOR_FILE = '/etc/pf.anchors/orchestrate.builder';
export const TAG = 'ORCH_BUILDER';
export const PROTOS = Object.freeze(['tcp', 'udp']);
export const FAMILIES = Object.freeze([['IPv4', '127.0.0.1'], ['IPv6', '::1']]);
export const DAEMON_DIR = '/Library/LaunchDaemons';
export const RECHECK_EVERY_S = 300;
const PFCTL = '/sbin/pfctl';
const LAUNCHCTL = '/bin/launchctl';
const SUDO = '/usr/bin/sudo';
/** The node every Mac user can run (nodejs.org's, root's; managed-settings.mjs NODE_BIN): the probes run it as the builder and the owner. */
export const PROBE_NODE = '/usr/local/bin/node';

export const wallLabel = (cfg) => `${cfg.label}.builder-wall`;
export const wallPlistPath = (cfg) => join(DAEMON_DIR, `${wallLabel(cfg)}.plist`);
export const wallDir = (cfg) => join(cfg.base, 'builder-wall');
export const tokenPath = (cfg) => join(wallDir(cfg), 'pf-token');
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
 * Each rule: its text; the words pfctl must print for it once per protocol (any order); and words it must NOT print. The two
 * lo0 rules must cover every address in both families, so a family (`inet`, `inet6`), a port, or an address other than `any`
 * on them is a narrower rule than the wall's and refuses (a wall that left out ::1, L1150). The self rule is the exception:
 * pf turns `self` into this Mac's own addresses as it loads, one rule each, so its lines name families and addresses.
 */
export const RULES = Object.freeze([
  { id: 'tag', text: (u) => `pass out quick on lo0 proto { tcp udp } from any to any user ${u} tag ${TAG} no state`,
    words: (u) => [/^pass\b/, /\bout\b/, /\bquick\b/, /\bon lo0\b/, userIs('=', u), new RegExp(`\\btag ${TAG}\\b`)], not: () => EVERY_ADDRESS },
  { id: 'block-in', text: (u) => `block return in quick on lo0 proto { tcp udp } from any to any tagged ${TAG} user != ${u}`,
    words: (u) => [/^block\b/, /\breturn\b/, /\bin\b/, /\bquick\b/, /\bon lo0\b/, new RegExp(`\\btagged ${TAG}\\b`), userIs('!=', u)], not: () => EVERY_ADDRESS },
  { id: 'self', text: (u) => `block return out quick on ! lo0 proto { tcp udp } from any to self user ${u}`,
    words: (u) => [/^block\b/, /\breturn\b/, /\bout\b/, /\bquick\b/, /\bon ! lo0\b/, userIs('=', u)], not: () => [/\bport\b/, /\bfrom (?!any\b)/] },
]);
const EVERY_ADDRESS = Object.freeze([/\binet6?\b/, /\bport\b/, /\bfrom (?!any\b)/, /\bto (?!any\b)/]);
const fits = (r, uid, line) => r.words(uid).every((w) => w.test(line)) && !r.not().some((w) => w.test(line));
// pfctl prints `user = 502` (OpenBSD print_ugid); `user 502` and the name are taken too. `!=` is never read as `=`.
function userIs(op, u) {
  const who = `(?:${u}|${BUILDER})\\b`;
  return op === '!=' ? new RegExp(`\\buser\\s*!=\\s*${who}`) : new RegExp(`\\buser\\s+(?:=\\s*)?${who}`);
}
const protoOf = (line) => {
  const m = /\bproto\s+(?:\{\s*([a-z0-9 ,]+?)\s*\}|([a-z0-9]+))/.exec(line);
  return m ? (m[1] ?? m[2]).split(/[\s,]+/).filter(Boolean) : [];
};

/**
 * Null, or why the anchor as pfctl prints it is not these rules (iv): each rule in each protocol (a `{ tcp udp }` line pfctl
 * did not split counts for both), and no line that is none of them. `text`: `pfctl -a <ANCHOR> -s rules`.
 */
export function loadedRulesProblem(text, uid) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return `${ANCHOR} holds no rules`;
  const missing = [];
  for (const r of RULES) for (const p of PROTOS) if (!lines.some((l) => fits(r, uid, l) && protoOf(l).includes(p))) missing.push(`${r.id} (${p})`);
  const extra = lines.filter((l) => !RULES.some((r) => fits(r, uid, l)));
  if (missing.length) return `${ANCHOR} is missing the rule${missing.length > 1 ? 's' : ''} ${missing.join(', ')}: what is loaded is not the wall`;
  if (extra.length) return `${ANCHOR} holds ${extra.length === 1 ? 'a line' : `${extra.length} lines`} that ${extra.length === 1 ? 'is' : 'are'} not the wall's: ${extra[0].slice(0, 120)}`;
  return null;
}

/** The job's shell text (fixed words and root's own paths only; no value from a file is put in it). */
export function bootScript(cfg) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return [
    'set -u',
    `A=${q(ANCHOR)}; F=${q(ANCHOR_FILE)}; T=${q(tokenPath(cfg))}`,
    // macOS's own boot job loads /etc/pf.conf, whose `anchor "com.apple/*"` reaches the wall. Until it has, try again later.
    `${PFCTL} -s rules 2>/dev/null | /usr/bin/grep -q '^anchor "com.apple/\\*"' || exit 1`,
    `${PFCTL} -q -a "$A" -f "$F" || exit 1`,
    // The reference this job holds keeps pf on; while pf is on and the token is still held there is nothing to do.
    `if ${PFCTL} -s info 2>/dev/null | /usr/bin/grep -q '^Status: Enabled' && [ -s "$T" ] && ${PFCTL} -s References 2>/dev/null | /usr/bin/awk -v t="$(/bin/cat "$T")" '{for(i=1;i<=NF;i++) if($i==t) f=1} END{exit !f}'; then exit 0; fi`,
    `${PFCTL} -E 2>&1 | /usr/bin/sed -n 's/^Token : *\\([0-9][0-9]*\\).*/\\1/p' > "$T.new" && [ -s "$T.new" ] && /bin/mv -f "$T.new" "$T"`,
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
  for (const d of ['/etc/pf.anchors', DAEMON_DIR]) {
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

/** The way out, as steps root can run: used when the read-back refuses, and said after every run. Each step's failure is reported, never hidden. */
export function wayOut(io, cfg) {
  const out = [];
  const step = (what, cmd, args) => { const r = io.run(cmd, args); out.push(r.status === 0 ? `done: ${what}` : `NOT done: ${what} (${said(r)})`); };
  step(`unload ${wallLabel(cfg)}`, LAUNCHCTL, ['bootout', `system/${wallLabel(cfg)}`]);
  try { io.unlink(wallPlistPath(cfg)); out.push(`done: removed ${wallPlistPath(cfg)} (so it does not start at boot)`); } catch (e) { out.push(`NOT done: remove ${wallPlistPath(cfg)} (${e?.code ?? e})`); }
  step(`empty ${ANCHOR}`, PFCTL, ['-a', ANCHOR, '-F', 'rules']);
  let tok = null; try { tok = io.readText(tokenPath(cfg)).trim(); } catch { /* none kept */ }
  if (tok && /^\d+$/.test(tok)) { step(`release pf token ${tok}`, PFCTL, ['-X', tok]); try { io.unlink(tokenPath(cfg)); } catch { /* said by the next check */ } }
  else out.push('no pf token was kept, so none was released');
  return out;
}

export const WAY_OUT_TEXT = (cfg) => `To take the builder wall out: sudo launchctl bootout system/${wallLabel(cfg)}; sudo rm ${wallPlistPath(cfg)}; sudo ${PFCTL} -a ${ANCHOR} -F rules; and sudo ${PFCTL} -X with the number in ${tokenPath(cfg)}.`;

// --- the read-back ---------------------------------------------------------------------------------------------------

/** The settings half (iii, iv): [{ ok, what, why? }]. Reads only, as root. */
export function settingsChecks(io, cfg, uid) {
  const out = []; const item = (ok, what, why) => out.push(ok ? { ok, what } : { ok, what, why });
  const want = anchorText(uid);
  const f = lstatOr(io, ANCHOR_FILE);
  item(sameFile(io, ANCHOR_FILE, want), `${ANCHOR_FILE} is the wall's rules for uid ${uid}, root's 0644`, !f ? 'it is not there (run place)' : 'it is there but not the rules for this uid, or not root\'s 0644');
  const info = io.run(PFCTL, ['-s', 'info']);
  const on = info.status === 0 && /^Status: Enabled\b/m.test(info.stdout);
  item(on, 'pf is on (iii)', info.status !== 0 ? `pfctl -s info failed (${said(info)})` : `pf is off${f ? ' though the anchor file is there' : ''}: the rules are loaded but nothing applies them`);
  let tok = null; try { tok = io.readText(tokenPath(cfg)).trim(); } catch { /* below */ }
  const refs = io.run(PFCTL, ['-s', 'References']);
  const held = !!tok && /^\d+$/.test(tok) && refs.status === 0 && refs.stdout.split('\n').some((l) => l.trim().split(/\s+/).includes(tok));
  item(held, `the pf token in ${tokenPath(cfg)} is held (iii): pf stays on while the job holds it`,
    !tok ? 'no token is kept there: the job has not enabled pf (look at it with: sudo launchctl print system/' + wallLabel(cfg) + ')'
      : !/^\d+$/.test(tok) ? 'what is kept there is not a token'
        : refs.status !== 0 ? `pfctl -s References failed (${said(refs)})` : `token ${tok} is not among pf's held references, so anything may turn pf off`);
  const main = io.run(PFCTL, ['-s', 'rules']);
  item(main.status === 0 && /^anchor "com\.apple\/\*"/m.test(main.stdout), 'the main ruleset reaches com.apple/* (iv)',
    main.status !== 0 ? `pfctl -s rules failed (${said(main)})` : 'the main ruleset has no anchor "com.apple/*", so the wall\'s anchor is never read (macOS\'s own /etc/pf.conf has it; something replaced the main ruleset)');
  const a = io.run(PFCTL, ['-a', ANCHOR, '-s', 'rules']);
  const why = a.status !== 0 ? `pfctl -a ${ANCHOR} -s rules failed (${said(a)})` : loadedRulesProblem(a.stdout, uid);
  item(why === null, `${ANCHOR} holds the wall's rules (iv)`, why);
  return out;
}

/**
 * The traffic half (i, ii, v), in each protocol and family: the builder reaches its own listener, the owner its own, and the
 * builder NOT the owner's. `net`: { listen({ user, proto, host }) → Promise<{ port, close() }>, connect({ user, proto, host, port }) → 'ok' | 'refused' | 'timeout' | 'error: …' }.
 */
export async function trafficChecks(cfg, net) {
  const out = [];
  for (const proto of PROTOS) for (const [fam, host] of FAMILIES) {
    const where = `${proto.toUpperCase()} ${fam} (${host})`;
    let mine = null; let theirs = null;
    try {
      try { mine = await net.listen({ user: BUILDER, proto, host }); theirs = await net.listen({ user: cfg.owner, proto, host }); } catch (e) {
        out.push({ ok: false, what: `the probes could listen on ${where}`, why: `${e?.message ?? e}: nothing about ${where} was proven` });
        continue;
      }
      const v = net.connect({ user: BUILDER, proto, host, port: mine.port });
      out.push(v === 'ok' ? { ok: true, what: `${BUILDER} reaches its own listener on ${where} (v; the proxy path)` } : { ok: false, what: `${BUILDER} reaches its own listener on ${where} (v; the proxy path)`, why: `it got ${v}: a worker session's sandboxed shell would lose its network proxy` });
      const ii = net.connect({ user: cfg.owner, proto, host, port: theirs.port });
      out.push(ii === 'ok' ? { ok: true, what: `the owner reaches its own listener on ${where} (ii)` } : { ok: false, what: `the owner reaches its own listener on ${where} (ii)`, why: `it got ${ii}: the wall is blocking the owner` });
      const i = net.connect({ user: BUILDER, proto, host, port: theirs.port });
      const what = `${BUILDER} can NOT reach the owner's listener on ${where} (i)`;
      if (v !== 'ok' || ii !== 'ok') out.push({ ok: false, what, why: 'not proven: a control above failed in this protocol and family' });
      else if (i === 'refused' || i === 'timeout') out.push({ ok: true, what });
      else out.push({ ok: false, what, why: i === 'ok' ? `${BUILDER} connected: the wall is not up` : `the probe said ${i}, which is not a block` });
    } finally { mine?.close(); theirs?.close(); }
  }
  return out;
}

/** The whole read-back: [{ ok, what, why? }]. */
export async function checkWall(io, cfg, { net = realNet() } = {}) {
  const id = builderUid(io, cfg);
  if (id.problem) return [{ ok: false, what: 'the builder wall', why: id.problem }];
  return [...settingsChecks(io, cfg, id.uid), ...await trafficChecks(cfg, net)];
}

// --- the real probes: node run as the builder or the owner, through sudo, each on its own ----------------------------

const LISTENER = `const [proto, host] = process.argv.slice(1); const end = () => process.exit(0); setTimeout(end, 30000).unref(); process.stdin.on('end', end); process.stdin.resume();
if (proto === 'tcp') { const s = require('net').createServer((c) => c.end()); s.listen(0, host, () => process.stdout.write('PORT ' + s.address().port + '\\n')); s.on('error', (e) => { process.stdout.write('ERR ' + e.code + '\\n'); end(); }); }
else { const s = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4'); s.on('message', (m, r) => s.send('pong', r.port, r.address)); s.on('error', (e) => { process.stdout.write('ERR ' + e.code + '\\n'); end(); }); s.bind(0, host, () => process.stdout.write('PORT ' + s.address().port + '\\n')); }`;
const CLIENT = `const [proto, host, port] = process.argv.slice(1); const say = (w) => { process.stdout.write(w); process.exit(0); }; setTimeout(() => say('timeout'), 3000);
if (proto === 'tcp') { const c = require('net').connect(Number(port), host, () => say('ok')); c.on('error', (e) => say(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'refused' : 'error: ' + e.code)); }
else { const s = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4'); s.on('message', (m) => say(String(m) === 'pong' ? 'ok' : 'error: odd reply')); s.on('error', (e) => say(e.code === 'ECONNREFUSED' ? 'refused' : 'error: ' + e.code)); s.connect(Number(port), host, () => s.send('ping')); }`;

const ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' });
export function realNet({ node = PROBE_NODE } = {}) {
  const as = (user) => ['-n', '-H', '-u', user, node];
  return {
    listen: ({ user, proto, host }) => new Promise((resolve, reject) => {
      const p = spawn(SUDO, [...as(user), '-e', LISTENER, proto, host], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], env: ENV });
      let buf = ''; let err = '';
      const t = setTimeout(() => { p.kill(); reject(new Error(`a listener as ${user} did not start within 10 seconds`)); }, 10_000);
      p.stderr.on('data', (d) => { err += d; });
      p.stdout.on('data', (d) => {
        buf += d; const m = /^PORT (\d+)$/m.exec(buf); const e = /^ERR (\S+)$/m.exec(buf);
        if (m) { clearTimeout(t); resolve({ port: Number(m[1]), close: () => { p.stdin.end(); p.kill(); } }); }
        else if (e) { clearTimeout(t); p.kill(); reject(new Error(`a listener as ${user} could not bind ${host} (${e[1]})`)); }
      });
      p.on('exit', (c) => { clearTimeout(t); reject(new Error(`a listener as ${user} ended (exit ${c}${err.trim() ? `: ${err.trim().slice(0, 100)}` : ''})`)); });
    }),
    connect: ({ user, proto, host, port }) => {
      // From /, which every user may enter: root's own folder may be one the builder can't (the listener starts there too).
      const r = spawnSync(SUDO, [...as(user), '-e', CLIENT, proto, host, String(port)], { cwd: '/', encoding: 'utf8', env: ENV, timeout: 20_000 });
      const w = String(r.stdout ?? '').trim();
      return r.status === 0 && /^(ok|refused|timeout|error: .*)$/.test(w) ? w : `error: the probe as ${user} did not answer (${said(r)})`;
    },
  };
}

// --- the command ------------------------------------------------------------------------------------------------------

const USAGE = 'usage: sudo /usr/local/bin/node builder-wall.mjs <place [--dry-run] | check>';

/** → exit code. `io` and `net` are ports for the tests. */
export async function main(argv, { io = realIo(), net, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
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
  if (cmd === 'check') { const bad = report(await checkWall(io, cfg, { net: probes })); out(WAY_OUT_TEXT(cfg)); return bad ? 1 : 0; }
  const plan = planWall(io, cfg);
  if (plan.problems.length) { for (const p of plan.problems) err(`refused: ${p}`); return 1; }
  if (dry) { for (const o of plan.ops) out(`would: ${o.text}`); out('would then run the read-back, and take the wall out again if it refuses'); return 0; }
  for (const o of plan.ops) {
    out(`doing: ${o.text}`);
    try { o.run(); } catch (e) { err(`stopped: ${e.message}`); for (const l of wayOut(io, cfg)) err(l); return 1; }
  }
  const bad = report(await checkWall(io, cfg, { net: probes }));
  if (bad) { err('The read-back refused, so the wall was taken out again:'); for (const l of wayOut(io, cfg)) err(l); return 1; }
  out(WAY_OUT_TEXT(cfg));
  return 0;
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (self === import.meta.url) process.exitCode = await main(process.argv.slice(2));
