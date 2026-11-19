// R-0b-179 (L1148 F1, L1149, L1150), wall v2: the builder wall, on the stand-in Mac with a stand-in pf. The stand-in pf
// loads the anchor's text, prints it the way macOS's pfctl does (one rule per protocol, `user = N`, `all` only for a rule
// with no port: seen on the Mac in wall-diag2), and decides every packet of each probe from the rules it holds: its
// direction, family, ports, TCP flags and the owner of the socket at that end (the sender's going out, the receiver's
// coming in, as measured). So a wrong rule shows up twice: in what the check reads back, and in the traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { ROOT_CONFIG_PATH, wallDir } from './layout.mjs';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import {
  ALL_ADDRESSES, ANCHOR, ANCHOR_DIR, AUTO_TABLE, RULE_READ_TRIES, tableProblem, ANCHOR_FILE, FAMILIES, PROTOS, RULES, WALL_RANGE, EPHEMERAL, anchorText, bootScript, checkWall, loadedRulesProblem, main, otherAddresses,
  planWall, tokenPath, unreadPath, waitForFirstRun, wallLabel, wallPlistPath,
  RECHECK_EVERY_S, STATUS_FILE, STATUS_VERSION, WALL_CHECK_JOB, WALL_SCRIPT, WHY_CHARS, WHY_MAX, anchorSha256, parseStatus, statusOf, statusText,
  wallCheckPlist, WAY_OUT_TEXT, LISTENER, CLIENT, ephemeralProblem, rangeListenersProblem, SETTINGS_ROWS, expectedRows, ownAddresses, trafficChecks,
} from './builder-wall.mjs';
import { spawn } from 'node:child_process';
import { createServer, connect as tcpConnect } from 'node:net';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { installPaths, parseInstallConfig } from './install.mjs';
import { OPTIONAL_JOBS, jobsFor, onlyJobs } from './daemons.mjs';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';
import { PROBE_FIRST, PROXY_PORTS } from '../shared/builder-ports.mjs';

const BASE = '/Library/orchestrate';
const LABEL = 'com.example.orch';
const BUILDER_UID = 65002;
const OWNER_UID = 65001;   // sam, the stand-in Mac's own user
const LAN = '192.168.1.20';   // the stand-in Mac's one address that is not loopback
/** Every place the read-back probes: [family, the address probed, how its rows name it]. */
const PLACES = [...FAMILIES.map(([f, h]) => [f, h, `${f} (${h})`]), ...ALL_ADDRESSES.map(([f, h, b]) => [f, h, `${f} (${h}, listening on ${b})`]),
  ["this Mac's own address", LAN, `this Mac's own address (${LAN})`]];
// The settings half (7, the WARN row among them), then per place v, ii, vi, ii-again, i (out), i (in), vii for TCP and the
// same but vi for UDP, then (viii) for UDP on 127.0.0.1 and ::1 (#617 r1 M1).
const ROWS_CHECK = 7 + PLACES.length * 7 + PLACES.length * 6 + FAMILIES.length;
const FAST = { sleep: async () => {}, limitMs: 15_000, stepMs: 500 };

/** pf, stood in: its state, pfctl's answers, and a rule evaluator for the probes' packets. */
function fakePf(mac, { mainAnchor = true } = {}) {
  // tables: the anchor's tables as `pfctl -a <ANCHOR> -t <name> -T show` prints them (name without its <>), → [address].
  const pf = { enabled: false, refs: new Map(), next: 41, anchors: new Map(), tables: new Map(), mainAnchor, calls: [] };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  // The way macOS's pfctl writes a loaded rule: one per protocol, `user = N`, `all` only for from any to any with no port.
  const printed = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).flatMap((l) => {
    const m = /\bproto \{ ([a-z ]+) \}/.exec(l);
    const each = m ? m[1].split(' ').map((p) => l.replace(m[0], `proto ${p}`)) : [l];
    return each.map((x) => x.replace(/from any to any(?! port)/, 'all').replace(/\buser (!=\s*)?(\d+)/, (_, n, u) => `user ${n ? '!= ' : '= '}${u}`).replace(/\bport (\d+)(?=\s|$)(?! <>| ><|:)/g, 'port = $1').replace(/\s+/g, ' '));
  });
  pf.run = (args) => {
    pf.calls.push(args.join(' '));
    const a = args.join(' ');
    if (a === '-s info') return ok(`Status: ${pf.enabled ? 'Enabled' : 'Disabled'} for 0 days 00:00:01           Debug: Urgent\n`);
    if (a === '-s rules') return ok(pf.mainAnchor ? 'scrub-anchor "com.apple/*" all fragment reassemble\nanchor "com.apple/*" all\n' : '');
    if (a === '-s References') return ok(`TOKENS:\nPID      Process Name                TOKEN                 TIMESTAMP\n${[...pf.refs.keys()].map((t) => `${String(4000 + t).padEnd(8)} launchd                     ${t}      0 days 00:00:01`).join('\n')}\n`);
    if (a === '-E') { const t = pf.next++; pf.refs.set(t, true); const was = pf.enabled; pf.enabled = true; return { status: 0, stdout: '', stderr: `${was ? 'pf already enabled' : 'pf enabled'}\nToken : ${t}\n` }; }
    if (args[0] === '-X') { if (!pf.refs.delete(Number(args[1]))) return { status: 1, stdout: '', stderr: 'pfctl: Invalid token\n' }; if (!pf.refs.size) pf.enabled = false; return ok('pf disabled\n'); }
    if (args[0] === '-a' && args[1] === ANCHOR) {
      if (args[2] === '-s' && args[3] === 'rules') return ok((pf.anchors.get(ANCHOR) ?? []).map((l) => `${l}\n`).join(''));
      if (args[2] === '-F' && args[3] === 'rules') { pf.anchors.delete(ANCHOR); return ok(); }
      if (args[2] === '-t' && args[4] === '-T' && args[5] === 'show' && args.length === 6) {
        const t = pf.tables.get(args[3]);
        return t ? ok(t.map((x) => `   ${x}\n`).join('')) : { status: 1, stdout: '', stderr: 'pfctl: Table does not exist.\n' };
      }
      if (args[2] === '-q' || args[2] === '-f') { const f = args.at(-1); pf.anchors.set(ANCHOR, printed(readFileSync(mac.at(f), 'utf8'))); return ok(); }
    }
    return { status: 1, stdout: '', stderr: `stand-in pfctl does not know: ${a}` };
  };
  /** The macOS job, as its script does it (the script itself is run for real in its own test). */
  pf.job = () => {
    if (!pf.mainAnchor) return 1;
    pf.run(['-a', ANCHOR, '-q', '-f', ANCHOR_FILE]);
    let tok = null; try { tok = readFileSync(mac.at(tokenPath({ base: BASE })), 'utf8').trim(); } catch { /* none */ }
    if (pf.enabled && tok && pf.refs.has(Number(tok))) return 0;
    const r = pf.run(['-E']); writeFileSync(mac.at(tokenPath({ base: BASE })), /Token : (\d+)/.exec(r.stderr)[1]);
    return 0;
  };
  /** A port expression as pfctl prints it (`= N`, `a:b`, `a <> b`, `a >< b`) → a test, or null for none. */
  const portTest = (spec) => {
    if (!spec) return null;
    let m = /^= (\d+)$/.exec(spec); if (m) return (p) => p === Number(m[1]);
    m = /^(\d+):(\d+)$/.exec(spec); if (m) return (p) => p >= Number(m[1]) && p <= Number(m[2]);
    m = /^(\d+) <> (\d+)$/.exec(spec); if (m) return (p) => p < Number(m[1]) || p > Number(m[2]);
    m = /^(\d+) >< (\d+)$/.exec(spec); if (m) return (p) => p > Number(m[1]) && p < Number(m[2]);
    throw new Error(`the stand-in pf does not read the port ${spec}`);
  };
  const PORT = '(= \\d+|\\d+:\\d+|\\d+ <> \\d+|\\d+ >< \\d+)';
  /** One rule line as the evaluator needs it. */
  const parse = (l) => {
    const from = new RegExp(`\\bfrom (\\S+)(?: port ${PORT})?`).exec(l); const to = new RegExp(`\\bto (\\S+)(?: port ${PORT})?`).exec(l);
    return {
      action: l.split(' ')[0], dir: /\bin\b/.test(l) ? 'in' : 'out', quick: /\bquick\b/.test(l),
      lo0: /\bon lo0\b/.test(l) ? true : /\bon ! lo0\b/.test(l) ? false : null,
      proto: /\bproto (\w+)/.exec(l)?.[1] ?? null, fam: /\binet6\b/.test(l) ? 'IPv6' : /\binet\b/.test(l) ? 'IPv4' : null,
      user: /\buser (=|!=) (\d+)/.exec(l), flags: /\bflags (\S+)/.exec(l)?.[1] ?? null,
      sport: portTest(from?.[2]), dport: portTest(to?.[2]),
    };
  };
  /** Whether a packet's TCP flags meet `flags A/B`: of the flags in B, exactly those in A are set. */
  const flagsMeet = (want, has) => { const [a, b] = want.split('/'); return [...b].every((f) => a.includes(f) === has.includes(f)); };
  const matches = (r, k) => r.dir === k.dir && r.lo0 !== false && (!r.proto || r.proto === k.proto) && (!r.fam || r.fam === k.fam)
    && (!r.sport || r.sport(k.sport)) && (!r.dport || r.dport(k.dport)) && (!r.flags || (k.proto === 'tcp' && flagsMeet(r.flags, k.flags)))
    && (!r.user || (r.user[1] === '=' ? k.uid === Number(r.user[2]) : k.uid !== Number(r.user[2])));
  /**
   * One packet on lo0, out from the sender's socket and in to the receiver's: 'pass', or where it was blocked ('out' or
   * 'in'). pf's last matching rule decides, a quick one at once; with none, the packet passes.
   */
  pf.packet = ({ proto, fam, sport, dport, fromUid, toUid, flags = '' }) => {
    if (!pf.enabled) return 'pass';
    const rules = (pf.anchors.get(ANCHOR) ?? []).map(parse);
    for (const [dir, uid] of [['out', fromUid], ['in', toUid]]) {
      let act = 'pass';
      for (const r of rules) if (matches(r, { dir, proto, fam, sport, dport, uid, flags })) { act = r.action; if (r.quick) break; }
      if (act === 'block') return dir;
    }
    return 'pass';
  };
  return pf;
}

const RANGE_PORT = (n) => PROBE_FIRST + n;
/**
 * The probes, stood in: a listener is a port (in the builder's range, or an ephemeral one), and a connection is its
 * packets through pf: the first (a TCP SYN, the UDP ping) from an ephemeral client port, then the answer (a SYN-ACK, the
 * pong) back. A block going out shows as a timeout, coming in as refused (TCP; UDP gets no answer either way), as on the
 * Mac. `twist` lets a test break the probes themselves.
 */
function fakeNet(pf, { twist = null, addresses = null, dies = null } = {}) {
  const uidOf = (user) => (user === 'builder' ? BUILDER_UID : user === 'sam' ? OWNER_UID : -1);
  const listeners = new Map(); let eph = 50000; let inR = 0; let fromR = 0;
  const log = []; const binds = [];
  return {
    log,
    binds,
    listeners,
    addresses: () => (addresses ? [...addresses] : [LAN]),
    selfAddresses: () => new Set(['127.0.0.1', '::1', 'fe80::1', LAN]),
    listen: async ({ user, proto, host, inRange = false }) => {
      const p = inRange ? RANGE_PORT(inR++) : eph++;
      const l = { user, proto, host, got: 0, up: true, inRange }; listeners.set(p, l); binds.push(`${user} ${proto} ${host}${inRange ? ' in' : ''}`);
      return { port: p, received: () => l.got, settle: async () => {}, alive: () => l.up, close: () => { l.up = false; listeners.delete(p); } };
    },
    connect: async ({ user, proto, host, port: p, fromRange = false }) => {
      const l = listeners.get(p); const fam = host.includes(':') ? 'IPv6' : 'IPv4';
      const fromR_ = fromRange && proto === 'udp';
      log.push(`${user}${fromR_ ? ' from R' : ''}→${l.user}${l.inRange ? ' in' : ''} ${proto} ${host}`);
      // A UDP client sent from the range takes a port from its top down, clear of the listeners' (from PROBE_FIRST up).
      const cport = fromR_ ? WALL_RANGE.last - (fromR++ % 400) : eph++;
      let said;
      const there = pf.packet({ proto, fam, sport: cport, dport: p, fromUid: uidOf(user), toUid: uidOf(l.user), flags: 'S' });
      if (there !== 'pass') said = proto === 'tcp' && there === 'in' ? 'refused' : 'timeout';
      else {
        l.got += 1;
        if (dies && dies(l)) l.up = false;
        const back = pf.packet({ proto, fam, sport: p, dport: cport, fromUid: uidOf(l.user), toUid: uidOf(user), flags: 'SA' });
        said = back === 'pass' ? 'ok' : 'timeout';
      }
      return twist ? twist({ user, to: l.user, inRange: l.inRange, proto, fam, host, said }) : said;
    },
  };
}

/**
 * The stand-in Mac with a builder, the stand-in pf, and the job. `late`: the job's first run comes only at that many
 * `launchctl print`s after load (launchd starts a RunAtLoad job after bootstrap has returned, #556 r1 M2); Infinity, never.
 */
function world({ builder = true, builderUid = BUILDER_UID, mainAnchor = true, late = 0, ephemeral = '49152\n65535\n49152\n65535\n', listening = { TCP: '', UDP: '' } } = {}) {
  const mac = fakeMac({ users: builder ? { builder: { UniqueID: String(builderUid), PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/builder' } } : {} });
  // /etc is a link to /private/etc on the stand-in Mac as on a real one: the anchor folder is made through the real path.
  for (const d of [ANCHOR_DIR, BASE]) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), 0o755); mac.owners.set(d, { uid: mac.rootUid, gid: 0 }); }
  const pf = fakePf(mac, { mainAnchor });
  const cfg = { base: BASE, owner: 'sam', products: ['alpha'], label: LABEL };
  const runMac = mac.run; let wait = null;
  const runJob = () => { const j = mac.loaded.get(wallLabel(cfg)); const code = pf.job(); if (j) { j.runs = (j.runs ?? 0) + 1; j.lastExit = code; } };
  mac.run = (cmd, args) => {
    if (cmd === '/sbin/pfctl') return pf.run(args);
    if (cmd === '/usr/sbin/sysctl') return w.ephemeral === null ? { status: 1, stdout: '', stderr: 'sysctl: unknown oid' } : { status: 0, stdout: w.ephemeral, stderr: '' };
    if (cmd === '/usr/sbin/lsof') { const t = w.listening[/^-i(TCP|UDP):/.exec(args[1])[1]]; return t ? { status: 0, stdout: t, stderr: '' } : { status: 1, stdout: '', stderr: '' }; }
    if (cmd === '/bin/launchctl' && args[0] === 'print' && args[1] === `system/${wallLabel(cfg)}` && wait !== null && (wait -= 1) <= 0) { wait = null; runJob(); }
    const r = runMac(cmd, args);
    // launchd runs the job at load (RunAtLoad), as root: at once, or a little later.
    if (cmd === '/bin/launchctl' && args[0] === 'bootstrap' && r.status === 0 && args[2] === mac.at(wallPlistPath(cfg))) {
      mac.loaded.get(wallLabel(cfg)).runs = 0;
      if (late === 0) runJob(); else wait = late;
    }
    return r;
  };
  const w = { mac, pf, cfg, net: fakeNet(pf), ephemeral, listening };
  return w;
}
const writeConfig = (w) => {
  mkdirSync(w.mac.at('/Library'), { recursive: true });
  writeFileSync(w.mac.at(ROOT_CONFIG_PATH), JSON.stringify({ base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/o/r.git', label: LABEL, runnerConfig: '/x/review.json' }));
};
const runMain = async (w, argv, net = w.net) => {
  const out = []; const err = [];
  const code = await main(argv, { io: w.mac, net, wait: FAST, out: (x) => out.push(x), err: (x) => err.push(x) });
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
};
const runPlan = (p) => { assert.deepEqual(p.problems, []); for (const o of p.ops) o.run(); };
const fails = (rows) => rows.filter((r) => !r.ok).map((r) => `${r.what} — ${r.why}`);
const placed = async (w) => { runPlan(planWall(w.mac, w.cfg)); return checkWall(w.mac, w.cfg, { net: w.net }); };
/** Loads a different anchor text, as if the file had been changed, and runs the check. */
async function withRules(w, text) {
  writeFileSync(w.mac.at(ANCHOR_FILE), text);
  w.pf.run(['-a', ANCHOR, '-q', '-f', ANCHOR_FILE]);
  return checkWall(w.mac, w.cfg, { net: w.net });
}
const rulesWith = (from, to) => { const t = anchorText(BUILDER_UID); assert.ok(t.includes(from), `the anchor no longer holds ${from}`); return t.replace(from, to); };

test('R-0b-179: place writes the rules for the builder\'s uid read from this Mac, loads the job, and every row of the read-back passes', async () => {
  const w = world();
  const rows = await placed(w);
  assert.deepEqual(fails(rows), []);
  assert.equal(readFileSync(w.mac.at(ANCHOR_FILE), 'utf8'), anchorText(BUILDER_UID));
  // The rules, pinned word for word (wall v2): a rule dropped, widened or narrowed fails here first.
  assert.deepEqual(anchorText(BUILDER_UID).split('\n').filter((l) => l && !l.startsWith('#')), [
    `block return out quick on lo0 proto udp from any to any port 47000 <> 47999 user ${BUILDER_UID}`,
    `block return out quick on lo0 proto tcp from any to any port 47000 <> 47999 user ${BUILDER_UID} flags S/SA`,
    `block return in quick on lo0 proto { tcp udp } from any to any port 47000:47999 user != ${BUILDER_UID}`,
    `block return out quick on ! lo0 proto { tcp udp } from any to self user ${BUILDER_UID}`,
  ]);
  assert.deepEqual([WALL_RANGE.first, WALL_RANGE.last, EPHEMERAL.first, EPHEMERAL.last], [47000, 47999, 49152, 65535]);
  // The proxy's ports are the builder's, and no probe listener takes them.
  for (const p of Object.values(PROXY_PORTS)) assert.ok(p >= WALL_RANGE.first && p < PROBE_FIRST, `proxy port ${p}`);
  assert.equal(w.mac.lstat(ANCHOR_FILE).mode & 0o7777, 0o644);
  assert.equal(w.mac.lstat(wallDir(w.cfg)).mode & 0o7777, 0o700);
  assert.ok(w.mac.loaded.has(wallLabel(w.cfg)));
  // The real path, not the one through /etc (#556 r1 M1): on the stand-in Mac as on a real one, /etc is a link, so a
  // folder named through it is refused by the chain check, and the wall could never be placed.
  assert.match(ANCHOR_FILE, /^\/private\/etc\/pf\.anchors\//);
  assert.match(chainProblem(w.mac.at('/etc/pf.anchors'), { owner: w.mac.rootUid, top: w.mac.prefix }), /\/etc is a link/);
  // Both directions in each protocol and place, every run (L1150), with one address that is not loopback (r1 m4).
  // Builder UDP probes that expect an answer, or test the range, send from the range (#617 r1 M1); (vi) is TCP only.
  for (const p of PROTOS) for (const [, host] of PLACES) {
    const b = p === 'udp' ? 'builder from R' : 'builder';
    for (const who of [`${b}→builder in`, 'sam→sam', ...(p === 'tcp' ? ['sam→builder in'] : []), 'builder→sam', 'builder→sam in', `${b}→builder`]) assert.ok(w.net.log.includes(`${who} ${p} ${host}`), `${who} ${p} ${host} was not tried`);
    assert.equal(w.net.log.includes(`builder from R→sam ${p} ${host}`), p === 'udp' && FAMILIES.some(([, h]) => h === host), `(viii) ${p} ${host}`);
  }
  assert.equal(rows.length, ROWS_CHECK);
  // An owner service bound to every address is a place of its own (#556 r2 m5): the owner's listener is bound to 0.0.0.0 and ::.
  for (const p of PROTOS) for (const [, , b] of ALL_ADDRESSES) for (const x of ['', ' in']) assert.ok(w.net.binds.includes(`sam ${p} ${b}${x}`), `the owner never listened on ${b}${x} (${p})`);
  assert.equal(rows.filter((r) => /\((i|ii|v|vi|vii)(;|\))/.test(r.what)).length, PLACES.length * 13);
  assert.equal(rows.filter((r) => /\(viii\)$/.test(r.what)).length, FAMILIES.length);
  assert.equal(rows.length, expectedRows(1)); assert.equal(expectedRows(1), 74); assert.equal(expectedRows(0), 62);
  // Twice: nothing is rewritten, the job is reloaded, and it holds the same token (no second reference).
  const again = planWall(w.mac, w.cfg).ops.map((o) => o.text);
  assert.equal(again.some((t) => /^write /.test(t)), false, again.join(' | '));
  runPlan(planWall(w.mac, w.cfg));
  assert.equal(w.pf.refs.size, 1);
  assert.deepEqual(fails(await checkWall(w.mac, w.cfg, { net: w.net })), []);
});

test('R-0b-179: place refuses with no builder user, a builder with uid 0, or the owner\'s own uid, and changes nothing', () => {
  for (const [opts, re] of [[{ builder: false }, /builder user is not on this Mac/], [{ builderUid: 0 }, /uid is 0/], [{ builderUid: OWNER_UID }, /owner's own uid/]]) {
    const w = world(opts);
    const p = planWall(w.mac, w.cfg);
    assert.deepEqual(p.ops, []);
    assert.match(p.problems.join(' '), re);
    assert.equal(existsSync(w.mac.at(ANCHOR_FILE)), false);
  }
});

test('R-0b-179 (i): the builder still connecting to the owner\'s listener refuses (pf left off by hand: the wall is not up)', async () => {
  const w = world();
  await placed(w);
  w.pf.enabled = false;
  const f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /can NOT reach the owner's listener .*\(i\) — builder connected: the wall is not up/.test(x)), f.join('\n'));
  // A probe that said something that is not a block is not a pass either.
  const odd = fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'builder' && to === 'sam' ? 'error: EHOSTUNREACH' : said) });
  w.pf.enabled = true;
  assert.ok(fails(await checkWall(w.mac, w.cfg, { net: odd })).some((x) => /\(i\) — the probe said error: EHOSTUNREACH, which is not a block/.test(x)));
});

test('R-0b-179 (ii): a wall that blocks the owner from its own listener refuses, and (i) is then not proven', async () => {
  const w = world();
  await placed(w);
  const f = fails(await withRules(w, `${anchorText(BUILDER_UID)}block return in quick on lo0 proto { tcp udp } from any to any user = ${OWNER_UID}\n`));
  assert.ok(f.some((x) => /owner reaches its own listener .*\(ii\) — it got refused: the wall is blocking the owner/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /\(i\) — not proven: a control in this protocol and address failed/.test(x)));
  assert.ok(f.some((x) => /holds 2 lines that are not the wall's/.test(x)), 'the extra rule is also seen in what pf holds');
});

test('R-0b-179 (iii): the anchor file there but pf off, or the token the job keeps not held, refuses', async () => {
  const w = world();
  await placed(w);
  w.pf.enabled = false;
  let f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /pf is on \(iii\) — pf is off though the anchor file is there/.test(x)), f.join('\n'));
  w.pf.enabled = true; w.pf.refs.clear(); w.pf.refs.set(99, true);   // pf on, but by someone else's reference
  f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.deepEqual(f.map((x) => x.split(' — ')[0]), [`the pf token in ${tokenPath(w.cfg)} is held (iii): pf stays on while the job holds it`]);
  writeFileSync(w.mac.at(tokenPath(w.cfg)), 'not-a-number');
  assert.ok(fails(await checkWall(w.mac, w.cfg, { net: w.net })).some((x) => /what is kept there is not a token/.test(x)));
});

test('R-0b-179 (iv): rules that did not load, or a main ruleset that never reaches com.apple/*, refuse', async () => {
  const w = world();
  await placed(w);
  w.pf.run(['-a', ANCHOR, '-F', 'rules']);
  let f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /holds exactly the wall's rules \(iv\) — com\.apple\/100\.orchestrate\.builder holds no rules/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /\(i\) — builder connected/.test(x)), 'with no rules loaded the traffic shows it too');
  const w2 = world(); await placed(w2); w2.pf.mainAnchor = false;
  f = fails(await checkWall(w2.mac, w2.cfg, { net: w2.net }));
  assert.ok(f.some((x) => /main ruleset reaches com\.apple\/\* \(iv\) — the main ruleset has no anchor "com\.apple\/\*"/.test(x)), f.join('\n'));
});

test('R-0b-179 (v): a wall that cuts the builder off from its own listener (its network proxy) refuses', async () => {
  const w = world();
  await placed(w);
  const twisted = fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'builder' && to === 'builder' ? 'refused' : said) });
  const f = fails(await checkWall(w.mac, w.cfg, { net: twisted }));
  assert.equal(f.filter((x) => /reaches its own listener .*\(v; the proxy path\) — it got refused/.test(x)).length, PROTOS.length * PLACES.length, f.join('\n'));
  assert.equal(f.filter((x) => /\(i\) — not proven/.test(x)).length, PROTOS.length * PLACES.length * 2);
});

test('R-0b-179 plants (L1150, wall v2): each wrong rule is refused, by what pf holds and by the traffic it lets through or blocks', async () => {
  const u = BUILDER_UID;
  const plants = {
    // The lead's plants: each must be caught by the traffic as well as by the print.
    'the in rule missing user != (blocks the builder too)': [rulesWith(`port 47000:47999 user != ${u}`, 'port 47000:47999'), /missing the rules? range-in/, /\(v; the proxy path\) — it got refused/],
    'UDP left out of the in rule': [rulesWith(`proto { tcp udp } from any to any port 47000:47999`, 'proto tcp from any to any port 47000:47999'), /range-in \(udp\)/, /can NOT reach the owner's listener in its ports on UDP .*\(i\) — builder connected/],
    'the UDP out rule left out': [anchorText(u).split('\n').filter((l) => !/^block return out quick on lo0 proto udp/.test(l)).join('\n'), /udp-out \(udp\)/, /can NOT reach the owner's listener outside its ports on UDP .*\(i\) — builder connected/],
    'IPv4 only (::1 left out)': [rulesWith('block return in quick on lo0 proto', 'block return in quick on lo0 inet proto').replace(/block return out quick on lo0 proto/g, 'block return out quick on lo0 inet proto'), /missing the rules? /, /IPv6 .*\(i\) — builder connected/],
    'flags S/SA dropped (the builder\'s TCP answers blocked)': [rulesWith(' flags S/SA', ''), /tcp-out \(tcp\)/, /TCP .*hears its answer \(vi\) — it got timeout/],
    // #617 r1 M1: the removed UDP answer rule put back is a line that is not the wall's, and (viii) sees the hole.
    'the old UDP answer rule put back': [`pass out quick on lo0 proto udp from any port 47000:47999 to any port 49152:65535 user ${u} no state\n${anchorText(u)}`, /a line that is not the wall's: pass out/, /from a port in its ports, can NOT reach the owner's listener on an ephemeral port on UDP IPv(4|6) .*\(viii\) — builder connected/],
    // #617 r1 m1: a rule with its source and destination swapped is another rule, by the print and by the traffic.
    'the in rule with from and to swapped': [rulesWith('from any to any port 47000:47999 user !=', 'from any port 47000:47999 to any user !='), /missing the rules? range-in/, /can NOT reach the owner's listener in its ports .*\(i\) — builder connected/],
    'the UDP out rule with from and to swapped': [rulesWith('proto udp from any to any port 47000 <> 47999', 'proto udp from any port 47000 <> 47999 to any'), /udp-out \(udp\)/, /\(viii\) — builder connected: the wall is not up/],
    'the range widened on the way out': [rulesWith('proto tcp from any to any port 47000 <> 47999', 'proto tcp from any to any port 1 <> 65535'), /tcp-out \(tcp\)/, /can NOT reach the owner's listener outside its ports on TCP .*\(i\) — builder connected/],
    'the self rule left out': [anchorText(u).split('\n').filter((l) => !/to self/.test(l)).join('\n'), /missing the rules? self \(tcp\), self \(udp\)/, null],
    'the in rule narrowed to one port': [rulesWith('port 47000:47999 user !=', 'port = 47000 user !='), /missing the rules? range-in/, /can NOT reach the owner's listener in its ports .*\(i\) — builder connected/],
  };
  for (const [name, [text, held, traffic]] of Object.entries(plants)) {
    const w = world();
    await placed(w);
    const f = fails(await withRules(w, text));
    assert.ok(f.some((x) => held.test(x)), `${name}: what pf holds was not refused:\n${f.join('\n')}`);
    // The self rule is off lo0, which the stand-in's probes never cross.
    if (traffic) assert.ok(f.some((x) => traffic.test(x)), `${name}: the traffic did not show it:\n${f.join('\n')}`);
  }
});

test('R-0b-179 plant: a one-direction read-back (no controls) is not this one: every (i) row stands on its (ii) and (v) in the same protocol and family', async () => {
  const w = world();
  const rows = await placed(w);
  for (const p of PROTOS) for (const [, , named] of PLACES) {
    const where = `${p.toUpperCase()} ${named}`;
    const at = (re) => rows.findIndex((r) => r.what.includes(where) && re.test(r.what));
    const v = at(/\(v;/); const ii = at(/reaches its own listener on [^)]*\) \(ii\)$/); const i = at(/\(i\)$/); const again = at(/after \(i\) \(ii\)/);
    assert.ok(v >= 0 && ii >= 0 && i > v && i > ii && again > ii, `${where}: v ${v}, ii ${ii}, i ${i}, ii again ${again}`);
  }
});

test('R-0b-179 (wall v2): the owner reaches a builder listener in its ports and hears it; the builder reaches nothing outside them, its own included', async () => {
  const w = world();
  await placed(w);
  for (const proto of PROTOS) for (const [fam, host] of FAMILIES) {
    const bIn = await w.net.listen({ user: 'builder', proto, host, inRange: true });
    const bOut = await w.net.listen({ user: 'builder', proto, host });
    const oIn = await w.net.listen({ user: 'sam', proto, host, inRange: true });
    // The owner's TCP connection to a builder listener is answered (the SYN-ACK is no first packet); a UDP one is not,
    // in the range or out of it: the builder's UDP answer is a packet to a port outside its range, like any other
    // (#617 r1 M1, the documented cost). From the range, the builder's own UDP client is answered.
    assert.equal(await w.net.connect({ user: 'sam', proto, host, port: bIn.port }), proto === 'tcp' ? 'ok' : 'timeout', `${proto} ${fam}: the owner and a builder listener in its ports`);
    assert.equal(await w.net.connect({ user: 'builder', proto, host, port: bIn.port, fromRange: true }), 'ok', `${proto} ${fam}: the builder, from its ports, and its own listener there`);
    assert.equal(await w.net.connect({ user: 'builder', proto, host, port: bIn.port }), proto === 'tcp' ? 'ok' : 'timeout', `${proto} ${fam}: the builder, from a port the kernel picks, and its own listener in its ports`);
    assert.equal(await w.net.connect({ user: 'sam', proto, host, port: bOut.port }), proto === 'tcp' ? 'ok' : 'timeout', `${proto} ${fam}: the owner and a builder listener outside its ports`);
    assert.notEqual(await w.net.connect({ user: 'builder', proto, host, port: bOut.port }), 'ok', `${proto} ${fam}: the builder reached its own listener outside its ports`);
    assert.notEqual(await w.net.connect({ user: 'sam', proto, host, port: oIn.port }), 'ok', `${proto} ${fam}: the owner reached its own listener in the builder's ports`);
    for (const l of [bIn, bOut, oIn]) l.close();
  }
  // Rule by rule, the packet the wall turns on: a builder TCP answer (SYN-ACK) to an ephemeral port passes, its SYN there does not.
  const pk = (o) => w.pf.packet({ proto: 'tcp', fam: 'IPv4', fromUid: BUILDER_UID, toUid: OWNER_UID, ...o });
  assert.equal(pk({ sport: 47100, dport: 50001, flags: 'SA' }), 'pass');
  assert.equal(pk({ sport: 50002, dport: 50001, flags: 'S' }), 'out');
  assert.equal(pk({ sport: 50002, dport: 47100, flags: 'S' }), 'in');
  // #617 r1 M1: builder UDP from the range to an ephemeral port (an owner's client, or its listener) no longer passes.
  for (const fam of ['IPv4', 'IPv6']) assert.equal(w.pf.packet({ proto: 'udp', fam, sport: 47100, dport: 50001, fromUid: BUILDER_UID, toUid: OWNER_UID }), 'out', `UDP from the range to an ephemeral port (${fam})`);
  assert.equal(w.pf.packet({ proto: 'udp', fam: 'IPv4', sport: 47100, dport: 47200, fromUid: BUILDER_UID, toUid: BUILDER_UID }), 'pass', 'builder UDP inside the range');
  assert.equal(w.pf.packet({ proto: 'udp', fam: 'IPv6', sport: 47100, dport: 5353, fromUid: BUILDER_UID, toUid: OWNER_UID }), 'out', 'UDP from the range to a fixed port below the ephemeral range');
});

test('R-0b-179: loadedRulesProblem reads macOS\'s print or a list not split, in any order, and refuses an extra or a missing word', () => {
  const u = BUILDER_UID;
  const asPrinted = [
    `block return out quick on lo0 proto udp from any to any port 47000 <> 47999 user = ${u}`,
    `block return out quick on lo0 proto tcp from any to any port 47000 <> 47999 user = ${u} flags S/SA`,
    // As wall-diag2 saw macOS print a range rule: `from any to any port a:b`, never `all`.
    `block return in quick on lo0 proto tcp from any to any port 47000:47999 user != ${u}`, `block return in quick on lo0 proto udp from any to any port 47000:47999 user != ${u}`,
    `block return out quick on ! lo0 inet proto tcp from any to 192.168.1.20 user = ${u}`, `block return out quick on ! lo0 inet proto udp from any to 192.168.1.20 user = ${u}`,
    `block return out quick on ! lo0 inet6 proto tcp from any to fe80::1 user = ${u}`, `block return out quick on ! lo0 inet6 proto udp from any to fe80::1 user = ${u}`,
  ];
  const mine = { selfAddresses: new Set(['127.0.0.1', '::1', 'fe80::1', '192.168.1.20']) };
  assert.equal(loadedRulesProblem(asPrinted.join('\n'), u, mine), null);
  assert.equal(loadedRulesProblem(anchorText(u), u, mine), null);
  assert.equal(loadedRulesProblem([...asPrinted].reverse().join('\n'), u, mine), null);
  // #617 r1 m1: the self rule may name only this Mac's own addresses (a scope is dropped first); any other is not the wall's.
  assert.equal(loadedRulesProblem(asPrinted.map((l) => l.replace('to fe80::1 ', 'to fe80::1%en0 ')).join('\n'), u, mine), null);
  assert.match(String(loadedRulesProblem(asPrinted.map((l) => l.replace('192.168.1.20', '10.9.9.9')).join('\n'), u, mine)), /not the wall's: block return out quick on ! lo0 inet proto tcp from any to 10\.9\.9\.9/);
  assert.match(String(loadedRulesProblem([...asPrinted, `block return out quick on ! lo0 inet proto tcp from any to 8.8.8.8 user = ${u}`].join('\n'), u, mine)), /not the wall's: .*8\.8\.8\.8/);
  assert.match(String(loadedRulesProblem(asPrinted.join('\n'), u, { selfAddresses: new Set(['127.0.0.1']) })), /missing the rules? self|not the wall's/, 'the real Mac\'s addresses only');
  assert.ok(ownAddresses({ en0: [{ address: '10.0.0.7' }, { address: 'fe80::aede:48ff:fe00:1122%en0' }] }).has('fe80::aede:48ff:fe00:1122'));
  assert.ok(ownAddresses({}).has('::1'));
  // #617 r1 m1: direction matters. Each rule with its from part and to part swapped is refused (the auditor's swap.mjs).
  const swaps = {
    'range-in': ['from any to any port 47000:47999 user !=', 'from any port 47000:47999 to any user !='],
    'tcp-out': ['proto tcp from any to any port 47000 <> 47999', 'proto tcp from any port 47000 <> 47999 to any'],
    'udp-out': ['proto udp from any to any port 47000 <> 47999', 'proto udp from any port 47000 <> 47999 to any'],
    self: ['from any to 192.168.1.20', 'from 192.168.1.20 to any'],
  };
  for (const [id, [a, b]] of Object.entries(swaps)) {
    const text = asPrinted.map((l) => l.replace(a, b)).join('\n');
    assert.notEqual(text, asPrinted.join('\n'), id);
    assert.match(String(loadedRulesProblem(text, u, mine)), new RegExp(`missing the rules? .*${id}|not the wall's`), `${id} swapped passed`);
  }
  assert.match(loadedRulesProblem([...asPrinted, 'pass in quick on lo0 all'].join('\n'), u), /not the wall's/);
  assert.match(loadedRulesProblem(asPrinted.map((l) => l.replace(`user != ${u}`, `user = ${u}`)).join('\n'), u), /range-in/, '`=` is never read as `!=`');
  assert.match(loadedRulesProblem(asPrinted.map((l) => l.replace(`${u}`, '501')).join('\n'), u), /missing/, 'another uid');
  assert.match(loadedRulesProblem(asPrinted.map((l) => l.replace('<>', '><')).join('\n'), u), /udp-out|tcp-out/, 'the range turned inside out');
  assert.match(loadedRulesProblem(asPrinted.map((l) => l.replace(' flags S/SA', ' flags S/S')).join('\n'), u), /tcp-out/);
  // A rule for one protocol printed for the other is not it: UDP has no flags, and the TCP rule is not the UDP one.
  assert.match(String(loadedRulesProblem(asPrinted.map((l) => l.replace('proto tcp from any to any port 47000 <> 47999', 'proto udp from any to any port 47000 <> 47999')).join('\n'), u)), /tcp-out/);
  assert.match(loadedRulesProblem('', u), /holds no rules/);
  // #556 r2 m4: a `!` belongs to the word after it; moved to another word, it is another rule.
  assert.match(String(loadedRulesProblem(asPrinted.map((l) => l.replace('from any to', 'from ! any to')).join('\n'), u)), /not the wall's|missing/, '`from ! any` passed');
  assert.match(String(loadedRulesProblem(asPrinted.map((l) => l.replace('on ! lo0', '! on lo0')).join('\n'), u)), /not the wall's|missing/, '`! on lo0` passed');
  // Every rule is checked in exactly its protocols.
  assert.deepEqual(RULES.map((r) => `${r.id}:${r.protos.join('+')}`), ['udp-out:udp', 'tcp-out:tcp', 'range-in:tcp+udp', 'self:tcp+udp']);
  // #617 r1 M1: the removed UDP answer rule is refused if it is ever loaded again.
  assert.match(String(loadedRulesProblem([`pass out quick on lo0 proto udp from any port 47000:47999 to any port 49152:65535 user = ${u} no state`, ...asPrinted].join('\n'), u, mine)), /a line that is not the wall's: pass out/);
});

test('wall self table: pf\'s automatic table for `self` counts only once read and proven to hold this Mac\'s own addresses', () => {
  const u = 603;
  // Verbatim from a Mac's failed place (2026-11-18): with many IPv6 addresses pfctl put them in a table it made.
  const seen = `block return out quick on ! lo0 inet6 proto tcp from any to <__automatic_c097741b_0> user = ${u}`;
  const T = '<__automatic_c097741b_0>';
  const base = [
    `block return out quick on lo0 proto udp from any to any port 47000 <> 47999 user = ${u}`,
    `block return out quick on lo0 proto tcp from any to any port 47000 <> 47999 user = ${u} flags S/SA`,
    `block return in quick on lo0 proto tcp from any to any port 47000:47999 user != ${u}`, `block return in quick on lo0 proto udp from any to any port 47000:47999 user != ${u}`,
    `block return out quick on ! lo0 inet proto tcp from any to 127.0.0.1 user = ${u}`, `block return out quick on ! lo0 inet proto udp from any to 127.0.0.1 user = ${u}`,
    `block return out quick on ! lo0 inet proto tcp from any to 192.168.1.20 user = ${u}`, `block return out quick on ! lo0 inet proto udp from any to 192.168.1.20 user = ${u}`,
    seen, seen.replace('proto tcp', 'proto udp'),
  ];
  const text = base.join('\n');
  const own = new Set(['127.0.0.1', '::1', 'fe80::1', '192.168.1.20', 'fe80::aede:48ff:fe00:1122', '2001:db8::7']);
  const read = (lines) => new Map([[T, { text: lines.map((x) => `   ${x}\n`).join('') }]]);
  const good = read(['::1', 'fe80::1', 'fe80::aede:48ff:fe00:1122%en0', '2001:db8::7/128']);
  // PASS: inet lines with addresses, inet6 lines with the proven table.
  assert.equal(loadedRulesProblem(text, u, { selfAddresses: own, tables: good }), null);
  assert.ok(AUTO_TABLE.test(T));
  // FAIL: a table holding an address that is not this Mac's.
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: read(['::1', '2001:db8::99']) })), /not proven .*holds 2001:db8::99, which is not one of this Mac's own addresses/);
  // FAIL: a network, a negated entry.
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: read(['::1', '2001:db8::/64']) })), /holds 2001:db8::\/64/);
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: read(['::1', '!2001:db8::7']) })), /holds !2001:db8::7/);
  // FAIL: one of this Mac's own addresses with a short prefix is a network, not that address (only /128 and /32 are one).
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: read(['::1', '2001:db8::7/64']) })), /holds 2001:db8::7\/64, which is not one/);
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: read(['::1', '192.168.1.20/24']) })), /holds 192\.168\.1\.20\/24, which is not one/);
  assert.equal(loadedRulesProblem(text, u, { selfAddresses: own, tables: read(['::1', '192.168.1.20/32']) }), null);
  // FAIL: an empty table, a table that could not be read, no proof supplied at all.
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: read([]) })), /<__automatic_c097741b_0> is empty/);
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: new Map([[T, { error: 'pfctl: Table does not exist.' }]]) })), /could not be read \(pfctl: Table does not exist\.\)/);
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own })), /<__automatic_c097741b_0> was not read/);
  assert.match(String(loadedRulesProblem(text, u, { selfAddresses: own, tables: new Map([['<__automatic_c097741b_1>', good.get(T)]]) })), /was not read/, 'proof for another table');
  // FAIL: a table that is not pfctl's automatic one, though it holds only this Mac's addresses.
  const foo = new Map([['<foo>', good.get(T)]]);
  assert.match(String(loadedRulesProblem(text.replaceAll(T, '<foo>'), u, { selfAddresses: own, tables: foo })), /<foo> is not a table pfctl makes for `self`/);
  for (const bad of ['<__automatic_C097741B_0>', '<__automatic__0>', '<__automatic_c097741b_>', '<__automatic_c097741b_0x>', '<x__automatic_c097741b_0>']) {
    assert.match(String(loadedRulesProblem(text.replaceAll(T, bad), u, { selfAddresses: own, tables: new Map([[bad, good.get(T)]]) })), /is not a table pfctl makes/, bad);
  }
  // FAIL: a proven automatic table in a rule that is not the self rule.
  const elsewhere = [...base, `block return in quick on lo0 proto tcp from any to ${T} port 47000:47999 user != ${u}`].join('\n');
  assert.match(String(loadedRulesProblem(elsewhere, u, { selfAddresses: own, tables: good })), /a line that is not the wall's: block return in quick on lo0 proto tcp from any to <__automatic/);
  assert.match(String(loadedRulesProblem(base.map((l) => l.replace('from any to any port 47000:47999', `from any to ${T} port 47000:47999`)).join('\n'), u, { selfAddresses: own, tables: good })), /is missing the rules range-in \(tcp\), range-in \(udp\) exactly as written/);
  // The table in the from part, not the to part, is another rule.
  assert.match(String(loadedRulesProblem(text.replaceAll(`from any to ${T}`, `from ${T} to any`), u, { selfAddresses: own, tables: good })), /holds 2 lines that are not the wall's: block return out quick on ! lo0 inet6 proto tcp from <__automatic_c097741b_0> to any user = 603$/);
  // tableProblem on its own.
  assert.equal(tableProblem(T, good.get(T), own), null);
  assert.match(String(tableProblem(T, { text: '\n  \n' }, own)), /is empty/);
});

test('wall self table, end to end: check reads the anchor\'s automatic table through pfctl and passes; a foreign or missing table fails (iv)', async () => {
  const w = world();
  assert.deepEqual(fails(await placed(w)), []);
  const T = '__automatic_c097741b_0';
  const asTable = () => w.pf.anchors.set(ANCHOR, w.pf.anchors.get(ANCHOR).flatMap((l) => (/ to self /.test(l) ? [l.replace(' proto ', ' inet proto ').replace(' to self ', ` to ${LAN} `), l.replace(' proto ', ' inet6 proto ').replace(' to self ', ` to <${T}> `)] : [l])));
  asTable();
  w.pf.tables.set(T, ['::1', 'fe80::1']);
  assert.deepEqual(fails(await checkWall(w.mac, w.cfg, { net: w.net })), []);
  assert.ok(w.pf.calls.includes(`-a ${ANCHOR} -t ${T} -T show`), w.pf.calls.join('\n'));
  w.pf.tables.set(T, ['::1', '2001:db8::99']);
  let f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /\(iv\) — .*2001:db8::99, which is not one of this Mac's own addresses/.test(x)), f.join('\n'));
  w.pf.tables.delete(T);
  f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /\(iv\) — .*could not be read \(pfctl: Table does not exist\.\)/.test(x)), f.join('\n'));
  w.pf.tables.set(T, []);
  f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /\(iv\) — .*is empty/.test(x)), f.join('\n'));
});

test('wall self table: a reload that renames the table between the reads is read again; one that renames it on every read refuses after RULE_READ_TRIES', async () => {
  const w = world();
  assert.deepEqual(fails(await placed(w)), []);
  let n = 0; const name = () => `__automatic_c097741b_${n}`;
  const asTable = () => w.pf.anchors.set(ANCHOR, w.pf.anchors.get(ANCHOR).flatMap((l) => (/ to self /.test(l) ? [l.replace(' proto ', ' inet proto ').replace(' to self ', ` to ${LAN} `), l.replace(' proto ', ' inet6 proto ').replace(' to self ', ` to <${name()}> `)] : [l])));
  const plain = w.pf.anchors.get(ANCHOR);
  const reload = () => { w.pf.tables.delete(name()); n += 1; w.pf.anchors.set(ANCHOR, plain); asTable(); w.pf.tables.set(name(), ['::1', 'fe80::1']); };
  asTable(); w.pf.tables.set(name(), ['::1', 'fe80::1']);
  // The job reloads the anchor right after the check's first read of the rules, once: the table it read is gone.
  const run = w.pf.run; let reads = 0; let reloadOn = new Set([1]);
  w.pf.run = (args) => { const r = run(args); if (args.join(' ') === `-a ${ANCHOR} -s rules` && reloadOn.has(reads += 1)) reload(); return r; };
  assert.deepEqual(fails(await checkWall(w.mac, w.cfg, { net: w.net })), []);
  assert.equal(reads, 4, 'read, (renamed) read again, then a whole second pass');
  // A reload after every read of the rules: refused after RULE_READ_TRIES passes, with the last pass's reason.
  reads = 0; reloadOn = { has: () => true };
  const f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.equal(reads, 2 * RULE_READ_TRIES);
  assert.ok(f.some((x) => /\(iv\) — .*could not be read \(pfctl: Table does not exist\.\).*but they changed while being read, 3 times running/.test(x)), f.join('\n'));
});

test('R-0b-179: a failed read-back takes the wall out again (job unloaded, its file gone, rules emptied, token released)', async () => {
  const w = world();
  const net = fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'sam' && to === 'sam' ? 'refused' : said) });
  writeConfig(w);
  const r = await runMain(w, ['place'], net);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /^The read-back refused, so the wall was taken out again:$/m);
  assert.equal(w.mac.loaded.has(wallLabel(w.cfg)), false);
  assert.equal(existsSync(w.mac.at(wallPlistPath(w.cfg))), false);
  assert.equal(w.pf.anchors.has(ANCHOR), false);
  assert.equal(w.pf.refs.size, 0); assert.equal(w.pf.enabled, false);
  // The same config, the probes honest: it places and passes.
  const w2 = { ...w, net: fakeNet(w.pf) };
  const placedOk = await runMain(w2, ['place']);
  assert.equal(placedOk.code, 0, placedOk.all);
  assert.match(placedOk.out, new RegExp(`all ${ROWS_CHECK + 1} PASS`));   // the job's first run, then the read-back
  const checked = await runMain(w2, ['check']);
  assert.equal(checked.code, 0, checked.all); assert.match(checked.out, new RegExp(`all ${ROWS_CHECK} PASS`));
  assert.equal((await runMain(w2, ['nonsense'])).code, 2);
});

test('R-0b-179: the job\'s own script, run by a real shell against a stand-in pfctl: waits for com.apple/*, loads, enables once, keeps the token', () => {
  const dir = tempDir('orch-setup-pfjob-');
  const state = join(dir, 'state'); mkdirSync(state);
  const pfctl = join(dir, 'pfctl');
  // A stand-in pfctl in shell: state as files (enabled, refs, main), each call logged.
  writeFileSync(pfctl, `#!/bin/sh
S='${state}'
echo "$*" >> "$S/log"
case "$*" in
  "-s rules") [ -f "$S/main" ] && echo 'anchor "com.apple/*" all'; exit 0 ;;
  "-s info") if [ -f "$S/on" ]; then echo 'Status: Enabled for 0 days'; else echo 'Status: Disabled for 0 days'; fi; exit 0 ;;
  "-s References") echo 'TOKENS:'; [ -f "$S/refs" ] && while read t; do echo "4001  launchd  $t  0 days"; done < "$S/refs"; exit 0 ;;
  "-E") if [ -f "$S/garble" ]; then echo 'pf enabled, somehow' >&2; touch "$S/on"; exit 0; fi; touch "$S/on"; n=$(( $(cat "$S/n" 2>/dev/null || echo 40) + 1 )); echo $n > "$S/n"; echo $n >> "$S/refs"; echo 'pf enabled' >&2; echo "Token : $n" >&2; exit 0 ;;
  "-q -a ${ANCHOR} -f "*) [ -f "$S/failload" ] && exit 1; cp "\${5}" "$S/loaded"; exit 0 ;;
esac
exit 1
`);
  chmodSync(pfctl, 0o755);
  const anchor = join(dir, 'orchestrate.builder'); writeFileSync(anchor, anchorText(BUILDER_UID));
  const cfg = { base: join(dir, 'base'), label: LABEL }; mkdirSync(join(cfg.base, 'builder-wall'), { recursive: true });
  const script = bootScript(cfg).replaceAll('/sbin/pfctl', pfctl).replace(`F='${ANCHOR_FILE}'`, `F='${anchor}'`);
  const sh = () => spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  // Before macOS's own job has loaded /etc/pf.conf: exit 1, nothing loaded, pf left alone.
  assert.equal(sh().status, 1);
  assert.equal(existsSync(join(state, 'loaded')), false); assert.equal(existsSync(join(state, 'on')), false);
  writeFileSync(join(state, 'main'), '');
  assert.equal(sh().status, 0);
  assert.equal(readFileSync(join(state, 'loaded'), 'utf8'), anchorText(BUILDER_UID));
  assert.equal(readFileSync(tokenPath(cfg), 'utf8').trim(), '41');
  // Again: pf on and the token held, so no second -E.
  assert.equal(sh().status, 0);
  assert.equal(readFileSync(join(state, 'log'), 'utf8').split('\n').filter((l) => l === '-E').length, 1);
  // pf turned off by hand: the next run enables it again and keeps the new token.
  writeFileSync(join(state, 'refs'), ''); spawnSync('/bin/rm', [join(state, 'on')]);
  assert.equal(sh().status, 0);
  assert.equal(readFileSync(tokenPath(cfg), 'utf8').trim(), '42');
  const enables = () => readFileSync(join(state, 'log'), 'utf8').split('\n').filter((l) => l === '-E').length;
  // r1 m3(b): the rules fail to load: exit 1, and pf is not enabled over a wall that is not there.
  writeFileSync(join(state, 'refs'), ''); spawnSync('/bin/rm', [join(state, 'on')]); writeFileSync(join(state, 'failload'), '');
  const before = enables();
  assert.equal(sh().status, 1);
  assert.equal(enables(), before); assert.equal(existsSync(join(state, 'on')), false);
  spawnSync('/bin/rm', [join(state, 'failload')]);
  // r1 m7: pfctl -E answers with no token in it: what it said is kept, the job exits 3, and later runs take no more references.
  writeFileSync(join(state, 'garble'), '');
  assert.equal(sh().status, 3);
  assert.match(readFileSync(unreadPath(cfg), 'utf8'), /pf enabled, somehow/);
  const after = enables();
  spawnSync('/bin/rm', [join(state, 'on')]);
  assert.equal(sh().status, 3); assert.equal(sh().status, 3);
  assert.equal(enables(), after, 'a run after an unread token took another reference');
});

test('R-0b-179 (r1 M2): place waits for the job\'s first run when launchd starts it late, and refuses when it never runs or exits badly', async () => {
  // Late: the first run comes on the third look; the read-back follows it and passes.
  const w = world({ late: 3 }); writeConfig(w);
  const sleeps = [];
  const r = await main(['place'], { io: w.mac, net: w.net, wait: { ...FAST, sleep: async (ms) => { sleeps.push(ms); } }, out: () => {}, err: () => {} });
  assert.equal(r, 0);
  assert.equal(sleeps.length, 2, 'it looked three times, sleeping between');
  // Never: refused within the limit, and taken out again.
  const n = world({ late: Infinity });
  runPlan(planWall(n.mac, n.cfg));
  let t = 0;
  const row = await waitForFirstRun(n.mac, n.cfg, { limitMs: 15_000, stepMs: 500, sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(row.ok, false); assert.match(row.why, /after 15 seconds it has run 0 times/);
  assert.ok(t <= 15_000 + 500, `it waited ${t} ms`);
  const n2 = world({ late: Infinity }); writeConfig(n2);
  const said = await main(['place'], { io: n2.mac, net: n2.net, wait: { sleep: async (ms) => { t += ms; }, now: () => t, limitMs: 15_000 }, out: () => {}, err: () => {} });
  assert.equal(said, 1); assert.equal(n2.mac.loaded.has(wallLabel(n2.cfg)), false, 'the job was not taken out again');
  // Ran and failed (macOS's own rules not loaded yet, the job exits 1): refused at once, without waiting out the limit.
  const bad = world({ mainAnchor: false });
  runPlan(planWall(bad.mac, bad.cfg));
  let slept = 0;
  const b = await waitForFirstRun(bad.mac, bad.cfg, { sleep: async () => { slept += 1; } });
  assert.equal(b.ok, false); assert.match(b.why, /it ran and exited 1/); assert.equal(slept, 0);
});

test('R-0b-179 (r1 m1): a timeout counts as a block only when the owner\'s listener received nothing from the builder', async () => {
  const w = world();
  await placed(w);
  w.pf.enabled = false;   // the builder's packets get through, but the probe says timeout (a reply lost on the way back)
  const lost = fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'builder' && to === 'sam' ? 'timeout' : said) });
  const f = fails(await checkWall(w.mac, w.cfg, { net: lost }));
  assert.equal(f.filter((x) => /\(i\) — the listener received 1 from builder \(the probe said timeout\)/.test(x)).length, PROTOS.length * PLACES.length * 2, f.join('\n'));
  // With the wall up the same timeout is a block: nothing was received.
  w.pf.enabled = true;
  assert.deepEqual(fails(await checkWall(w.mac, w.cfg, { net: fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'builder' && to === 'sam' ? 'timeout' : said) }) })), []);
  // (ii) again after (i): an owner's listener gone by then makes (i) not proven.
  let n = 0;
  const g = fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'sam' && to === 'sam' && (n += 1) % 2 === 0 ? 'refused' : said) });
  const fg = fails(await checkWall(w.mac, w.cfg, { net: g }));
  assert.ok(fg.some((x) => /after \(i\) \(ii\) — it got refused/.test(x)), fg.join('\n'));
  assert.ok(fg.some((x) => /\(i\) — not proven/.test(x)));
});

test('R-0b-179 (r1 m4): one address of this Mac that is not loopback is probed; with none, the read-back says only loopback was', async () => {
  const w = world();
  await placed(w);
  const lone = fakeNet(w.pf, { addresses: [] });
  const rows = await checkWall(w.mac, w.cfg, { net: lone });
  assert.deepEqual(fails(rows), []);
  assert.ok(rows.some((r) => /no address but loopback \(and link-local\), so only 127\.0\.0\.1 and ::1 were probed/.test(r.what)));
  assert.equal(lone.log.some((l) => l.endsWith(LAN)), false);
  // The real lookup: the first IPv4 address that is not internal or link-local.
  assert.deepEqual(otherAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '169.254.3.4', family: 'IPv4', internal: false }, { address: '10.0.0.7', family: 'IPv4', internal: false }] }), ['10.0.0.7']);
  assert.deepEqual(otherAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), []);
  // #617 r2: with no IPv4 address beyond loopback, an IPv6 one (not link-local) is probed.
  assert.deepEqual(otherAddresses({ lo0: [{ address: '::1', family: 'IPv6', internal: true }], en0: [{ address: 'fe80::1%en0', family: 'IPv6', internal: false }, { address: '2001:db8::5', family: 'IPv6', internal: false }] }), ['2001:db8::5']);
  assert.deepEqual(otherAddresses({ en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '169.254.1.1', family: 'IPv4', internal: false }] }), []);
  assert.deepEqual(otherAddresses({ en0: [{ address: '2001:db8::5', family: 'IPv6', internal: false }], en1: [{ address: '192.168.1.9', family: 'IPv4', internal: false }] }), ['192.168.1.9']);
});

test('R-0b-179 (r1 m2, m3): every printed word is checked: keep state, no quick, a group, a family on a rule that is not self, and a qualifier more all refuse', async () => {
  const u = BUILDER_UID;
  const plants = {
    'the TCP out rule keeping state': rulesWith('user 65002 flags S/SA', 'user 65002 flags S/SA keep state'),
    'the in rule not quick': rulesWith('block return in quick on lo0', 'block return in on lo0'),
    'the UDP out rule not quick': rulesWith('block return out quick on lo0 proto udp', 'block return out on lo0 proto udp'),
    'the in rule narrowed by group': rulesWith(`port 47000:47999 user != ${u}`, `port 47000:47999 user != ${u} group = 20`),
    'the in rule IPv4 only': rulesWith('block return in quick on lo0 proto', 'block return in quick on lo0 inet proto'),
    'the self rule to one port': rulesWith('to self user', 'to self port 22 user'),
    'the in rule dropping, not returning': rulesWith('block return in quick', 'block drop in quick'),
  };
  for (const [name, text] of Object.entries(plants)) {
    const w = world();
    await placed(w);
    const f = fails(await withRules(w, text));
    assert.ok(f.some((x) => /exactly the wall's rules \(iv\) — .*missing the rules? /.test(x)), `${name}: not refused:\n${f.join('\n')}`);
  }
});

test('R-0b-179 (r1 m3a, m8, c1): a step that fails takes out what was placed; a base that is not root\'s alone refuses; "taken out" is said only when it was', async () => {
  const w = world(); writeConfig(w);
  w.mac.failBootstrap = new Set([wallLabel(w.cfg)]);
  const r = await runMain(w, ['place']);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /stopped: could not load/); assert.match(r.err, /^A step failed, so the wall was taken out again:$/m);
  assert.equal(existsSync(w.mac.at(wallPlistPath(w.cfg))), false, 'the job file was left behind');
  // Taking it out fails at one step: it says NOT, never "taken out".
  const w2 = world(); writeConfig(w2);
  const run2 = w2.mac.run;
  w2.mac.run = (cmd, args) => (cmd === '/sbin/pfctl' && args.includes('-F') ? { status: 1, stdout: '', stderr: 'pfctl: busy' } : run2(cmd, args));
  const r2 = await runMain(w2, ['place'], fakeNet(w2.pf, { twist: ({ user, to, said }) => (user === 'sam' && to === 'sam' ? 'refused' : said) }));
  assert.equal(r2.code, 1);
  assert.doesNotMatch(r2.err, /so the wall was taken out again/);
  assert.match(r2.err, /Taking the wall out again did NOT fully work/); assert.match(r2.err, /NOT done: empty com\.apple/);
  // The base itself writable by another user: the token folder would be made in it, so nothing is placed.
  const w3 = world(); chmodSync(w3.mac.at(BASE), 0o777);
  const p = planWall(w3.mac, w3.cfg);
  assert.deepEqual(p.ops, []);
  assert.match(p.problems.join(' '), new RegExp(`${BASE} is not safe for root to write in`));
});

test('R-0b-179 (r1 m7): the read-back refuses while a pfctl -E answer could not be read, and the way out says to find that reference', async () => {
  const w = world();
  await placed(w);
  writeFileSync(w.mac.at(unreadPath(w.cfg)), 'pf enabled, somehow\n');
  const f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.ok(f.some((x) => /is held \(iii\).* — pfctl -E answered in a way no token could be read from/.test(x)), f.join('\n'));
});

test('R-0b-179 (#556 r2 m1): the wait for the job\'s first run refuses while pf is off or the job\'s token is not held, though the job exited 0', async () => {
  for (const [why, spoil] of [[/it ran and exited 0, but pf is off/, (w) => { w.pf.enabled = false; }], [/it ran and exited 0, but its token is not held/, (w) => { w.pf.refs.clear(); w.pf.refs.set(99, true); }]]) {
    const w = world();
    runPlan(planWall(w.mac, w.cfg));
    assert.equal((await waitForFirstRun(w.mac, w.cfg, FAST)).ok, true, 'the control: the job ran, pf on, token held');
    spoil(w);
    let t = 0;
    const row = await waitForFirstRun(w.mac, w.cfg, { limitMs: 2_000, stepMs: 500, sleep: async (ms) => { t += ms; }, now: () => t });
    assert.equal(row.ok, false); assert.match(row.why, why);
  }
});

test('wall v2 install refusals: an ephemeral range inside the builder\'s ports, or another user listening there, refuses place and changes nothing', () => {
  const cases = [
    ['the ephemeral range overlapping the range', { ephemeral: '32768\n65535\n49152\n65535\n' }, /ephemeral port range is 32768-65535, not inside 49152-65535: it overlaps the builder's ports 47000:47999/],
    ['the high range moved', { ephemeral: '49152\n65535\n40000\n48000\n' }, /40000-48000.*overlaps/],
    ['sysctl not answering', { ephemeral: null }, /sysctl could not read the ephemeral port range/],
    ['the owner listening in the range (TCP)', { listening: { TCP: `p123\nu${OWNER_UID}\nn127.0.0.1:47123\n`, UDP: '' } }, /not the builder user's already listens in the builder's ports 47000:47999.*TCP 127\.0\.0\.1:47123 \(uid 65001, pid 123\)/],
    ['root listening in the range (UDP)', { listening: { TCP: '', UDP: `p9\nu0\nn*:47500\n` } }, /UDP \*:47500 \(uid 0, pid 9\)/],
  ];
  for (const [what, opts, re] of cases) {
    const w = world(opts);
    const p = planWall(w.mac, w.cfg);
    assert.deepEqual(p.ops, [], what);
    assert.match(p.problems.join(' '), re, what);
    assert.equal(existsSync(w.mac.at(ANCHOR_FILE)), false, what);
  }
  // The builder's own listener in the range is fine (its proxy, a session's dev server).
  const mine = world({ listening: { TCP: `p77\nu${BUILDER_UID}\nn127.0.0.1:47000\nn[::1]:47000\n`, UDP: '' } });
  assert.deepEqual(planWall(mine.mac, mine.cfg).problems, []);
  // lsof failing for another reason is no "nobody listens".
  const bad = world(); const run = bad.mac.run;
  bad.mac.run = (cmd, args) => (cmd === '/usr/sbin/lsof' ? { status: 2, stdout: '', stderr: 'lsof: status error' } : run(cmd, args));
  assert.match(String(rangeListenersProblem(bad.mac, BUILDER_UID)), /lsof could not list the TCP sockets/);
  assert.equal(ephemeralProblem(world().mac), null);
});

test('wall v2: the check refuses once the ephemeral range has moved into the builder\'s ports (iv), though place was fine', async () => {
  const w = world();
  assert.deepEqual(fails(await placed(w)), []);
  w.ephemeral = '47500\n65535\n49152\n65535\n';
  const f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.deepEqual(f.map((x) => x.split(' — ')[0]), ['the Mac\'s ephemeral port range is inside 49152-65535, clear of the builder\'s ports (iv)'], f.join('\n'));
});

test('wall v2: a blocked row is no pass when its listener had stopped (a crash looks like a block)', async () => {
  const w = world();
  await placed(w);
  w.pf.enabled = false;   // no wall: every probe gets through, and the listener dies on it, as wall-diag's did (ECONNRESET)
  const net = fakeNet(w.pf, { dies: (l) => l.user === 'sam' && l.inRange, twist: ({ user, to, inRange, said }) => (user === 'builder' && to === 'sam' && inRange ? 'refused' : said) });
  const f = fails(await checkWall(w.mac, w.cfg, { net }));
  assert.equal(f.filter((x) => /in its ports .*\(i\) — not proven: the listener had stopped/.test(x)).length, PROTOS.length * PLACES.length, f.join('\n'));
});

test('wall v2: the real listener keeps running through a reset connection, and takes a free port in the range it is given', async () => {
  const start = (args) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', LISTENER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; const m = /^PORT (\d+)$/m.exec(buf); if (m) resolve({ p, port: Number(m[1]), out: () => buf }); const e = /^ERR (\S+)$/m.exec(buf); if (e) reject(new Error(e[1])); });
    p.on('exit', (c) => reject(new Error(`exit ${c}: ${buf}`)));
  });
  const client = (proto, port) => new Promise((resolve) => { const c = spawn(process.execPath, ['-e', CLIENT, proto, '127.0.0.1', String(port)]); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o)); });
  // A TCP connection reset by its client (what a wall's RST does to the server's side): the listener lives on.
  const t = await start(['tcp', '127.0.0.1', '0', '0']);
  await new Promise((ok) => { const c = tcpConnect(t.port, '127.0.0.1', () => { c.resetAndDestroy(); setTimeout(ok, 150); }); c.on('error', () => {}); });
  assert.equal(t.p.exitCode, null, `the listener stopped: ${t.out()}`);
  assert.equal(await client('tcp', t.port), 'ok');
  assert.equal(t.out().match(/^GOT$/mg).length, 2);
  t.p.stdin.end();
  // UDP: the pong goes back, and the listener answers twice.
  const u = await start(['udp', '127.0.0.1', '0', '0']);
  assert.equal(await client('udp', u.port), 'ok'); assert.equal(await client('udp', u.port), 'ok');
  u.p.stdin.end();
  // In a range of two ports with one taken, it takes the other.
  const taken = createServer(); await new Promise((ok) => { taken.listen(0, '127.0.0.1', ok); });
  const busy = taken.address().port;
  const lo = busy - 1;   // the range busy-1..busy: one taken, one most likely free
  try {
    const r = await start(['tcp', '127.0.0.1', String(lo), String(busy)]);
    assert.equal(r.port, lo); r.p.stdin.end();
  } catch (e) { if (!/EADDRINUSE/.test(e.message)) throw e; }   // busy-1 taken by someone else too: nothing to learn here
  finally { taken.close(); }
});

test('R-0b-179 (#556 r2 m2): an anchor folder that is not root\'s alone (writable by others, or a link) refuses, and nothing is placed', () => {
  // (Another owner is chainProblem's own check of the real owner, pinned in install-check's tests; a test cannot chown.)
  const spoils = [
    ['writable by others', (w) => chmodSync(w.mac.at(ANCHOR_DIR), 0o777)],
    ['a link', (w) => { const real = w.mac.at('/private/etc/elsewhere'); mkdirSync(real, { recursive: true }); w.mac.owners.set('/private/etc/elsewhere', { uid: w.mac.rootUid, gid: 0 }); rmSync(w.mac.at(ANCHOR_DIR), { recursive: true }); symlinkSync(real, w.mac.at(ANCHOR_DIR)); }],
  ];
  for (const [what, spoil] of spoils) {
    const w = world(); spoil(w);
    const p = planWall(w.mac, w.cfg);
    assert.deepEqual(p.ops, [], what);
    assert.match(p.problems.join(' '), new RegExp(`${ANCHOR_DIR} is not safe for root to write in`), what);
    assert.equal(existsSync(w.mac.at(ANCHOR_FILE)), false, `${what}: the anchor file was written`);
  }
});

test('R-0b-179 (#556 r2 m3): an anchor file that is not the wall\'s rules refuses the read-back (the job reloads it), and place writes it back', async () => {
  const w = world();
  await placed(w);
  // The loaded rules are still right; only the file the job reloads every few minutes differs.
  writeFileSync(w.mac.at(ANCHOR_FILE), anchorText(BUILDER_UID).replace('block return in', 'pass in'));
  const f = fails(await checkWall(w.mac, w.cfg, { net: w.net }));
  assert.deepEqual(f.map((x) => x.split(' — ')[0]), [`${ANCHOR_FILE} is the wall's rules for uid ${BUILDER_UID}, root's 0644`], f.join('\n'));
  assert.match(f[0], /not the rules for this uid/);
  const p = planWall(w.mac, w.cfg);
  assert.ok(p.ops.some((o) => o.text.startsWith(`write ${ANCHOR_FILE}`)), 'place did not write the rules back');
  runPlan(p);
  assert.equal(readFileSync(w.mac.at(ANCHOR_FILE), 'utf8'), anchorText(BUILDER_UID));
  // The right text with the wrong mode refuses too.
  chmodSync(w.mac.at(ANCHOR_FILE), 0o666);
  assert.ok(fails(await checkWall(w.mac, w.cfg, { net: w.net })).some((x) => x.startsWith(`${ANCHOR_FILE} is the wall's rules`)));
});

// --- L1193: the status the worker runner reads -----------------------------------------------------------------------

const statusAt = (w) => readFileSync(w.mac.at(STATUS_FILE(w.cfg)), 'utf8');
const hexOf = (uid) => createHash('sha256').update(anchorText(uid), 'utf8').digest('hex');
const STATUS_DIR = `${BASE}/builder-wall-status`;

test('L1193 round trip: check writes the status, root\'s 0644 in its own root 0755 folder, and parseStatus reads it back: ok, this uid, anchorText(uid)\'s hash', async () => {
  const w = world(); writeConfig(w);
  assert.equal(STATUS_FILE(w.cfg), `${STATUS_DIR}/status.json`, 'the place lane 2\'s reader takes (layout.mjs wallStatusPath)');
  const before = Date.now();
  const p = await runMain(w, ['place']);
  assert.equal(p.code, 0, p.all);
  assert.equal(parseStatus(statusAt(w)).ok, true, 'place leaves a status too');
  const r = await runMain(w, ['check']);
  assert.equal(r.code, 0, r.all);
  const text = statusAt(w);
  assert.equal(text.split('\n').length, 2, 'one line, then its newline');
  const s = parseStatus(text);
  assert.deepEqual(Object.keys(s).sort(), ['anchorSha256', 'builderUid', 'ok', 'time', 'v', 'why']);
  assert.equal(s.v, STATUS_VERSION); assert.equal(s.ok, true); assert.deepEqual(s.why, []);
  assert.equal(s.builderUid, BUILDER_UID);
  // The contract with the reader (#579): sha256 over exactly anchorText(uid) as utf8, lowercase hex.
  assert.equal(s.anchorSha256, hexOf(BUILDER_UID)); assert.equal(anchorSha256(BUILDER_UID), hexOf(BUILDER_UID)); assert.match(s.anchorSha256, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(s.time) >= before - 1000 && Date.parse(s.time) <= Date.now() + 1000, s.time);
  const f = w.mac.lstat(STATUS_FILE(w.cfg));
  assert.ok(f.isFile()); assert.equal(f.uid, w.mac.rootUid); assert.equal(f.mode & 0o7777, 0o644);
  const d = w.mac.lstat(STATUS_DIR);
  assert.ok(d.isDirectory()); assert.equal(d.uid, w.mac.rootUid); assert.equal(d.mode & 0o7777, 0o755);
  assert.equal(w.mac.lstat(wallDir(w.cfg)).mode & 0o7777, 0o700, 'the wall\'s own folder stays closed (L1193 change 3)');
  assert.deepEqual(readdirSync(w.mac.at(STATUS_DIR)), ['status.json'], 'no side file left');
  // The writer's text is the reader's format: statusText of what parseStatus gave is the same bytes.
  assert.equal(statusText(s), text);
});

test('L1193: a failing check replaces an ok status with ok false and its reasons; a place whose read-back refuses leaves ok false too', async () => {
  const w = world(); writeConfig(w);
  assert.equal((await runMain(w, ['place'])).code, 0);
  assert.equal(parseStatus(statusAt(w)).ok, true);
  w.pf.enabled = false;   // switched off by hand
  const r = await runMain(w, ['check']);
  assert.equal(r.code, 1);
  const s = parseStatus(statusAt(w));
  assert.equal(s.ok, false); assert.equal(s.builderUid, BUILDER_UID); assert.equal(s.anchorSha256, hexOf(BUILDER_UID));
  assert.ok(s.why.some((x) => x.startsWith('pf is on (iii): pf is off')), s.why.join(' | '));
  // A place whose read-back refuses: the wall is taken out and the status says so.
  const w2 = world(); writeConfig(w2);
  const net = fakeNet(w2.pf, { twist: ({ user, to, said }) => (user === 'sam' && to === 'sam' ? 'refused' : said) });
  assert.equal((await runMain(w2, ['place'], net)).code, 1);
  const s2 = parseStatus(statusAt(w2));
  assert.equal(s2.ok, false);
  assert.equal(s2.why[0], 'place: the read-back refused, so the wall was taken out again', 'first, so the cap on reasons never drops it');
  assert.equal(s2.why.length, WHY_MAX, 'this many failing rows fill the cap');
  assert.ok(s2.why.some((x) => /the owner reaches its own listener/.test(x)), s2.why.join(' | '));
});

test('L1193: with no builder user, check still writes: ok false, no uid, no hash, and why', async () => {
  const w = world({ builder: false }); writeConfig(w);
  const r = await runMain(w, ['check']);
  assert.equal(r.code, 1);
  const s = parseStatus(statusAt(w));
  assert.equal(s.ok, false); assert.equal(s.builderUid, null); assert.equal(s.anchorSha256, null);
  assert.ok(s.why.some((x) => /builder user is not on this Mac/.test(x)), s.why.join(' | '));
});

test('L1193 PLANT: a status folder that is a link or not root\'s is refused, nothing is written, and the run fails saying so; a loose mode is put right; an unsafe base gets nothing', async () => {
  for (const plant of ['link', 'owner', 'file']) {
    const w = world(); writeConfig(w);
    if (plant === 'link') { mkdirSync(w.mac.at('/elsewhere')); w.mac.owners.set('/elsewhere', { uid: w.mac.rootUid, gid: 0 }); symlinkSync(w.mac.at('/elsewhere'), w.mac.at(STATUS_DIR)); }
    else if (plant === 'owner') { mkdirSync(w.mac.at(STATUS_DIR)); chmodSync(w.mac.at(STATUS_DIR), 0o755); w.mac.owners.set(STATUS_DIR, { uid: OWNER_UID, gid: 20 }); }
    else { writeFileSync(w.mac.at(STATUS_DIR), ''); w.mac.owners.set(STATUS_DIR, { uid: w.mac.rootUid, gid: 0 }); }
    const r = await runMain(w, ['check']);
    assert.equal(r.code, 1, plant);
    assert.match(r.err, /the wall's status could not be written to \S*builder-wall-status\/status\.json \(.*is there but is not a folder of root's/, `${plant}: ${r.err}`);
    assert.equal(existsSync(w.mac.at('/elsewhere/status.json')), false, plant);
    if (plant === 'owner') assert.deepEqual(readdirSync(w.mac.at(STATUS_DIR)), [], plant);
  }
  const w = world(); writeConfig(w);
  mkdirSync(w.mac.at(STATUS_DIR)); chmodSync(w.mac.at(STATUS_DIR), 0o777); w.mac.owners.set(STATUS_DIR, { uid: w.mac.rootUid, gid: 0 });
  await runMain(w, ['check']);
  assert.equal(w.mac.lstat(STATUS_DIR).mode & 0o7777, 0o755, 'a folder anyone could write is put back to 0755');
  assert.equal(parseStatus(statusAt(w)).builderUid, BUILDER_UID);
  const w3 = world(); writeConfig(w3); chmodSync(w3.mac.at(BASE), 0o777);
  const r3 = await runMain(w3, ['check']);
  assert.equal(r3.code, 1); assert.match(r3.err, /the wall's status could not be written .*is not safe for root to write in/);
  assert.equal(existsSync(w3.mac.at(STATUS_DIR)), false, 'nothing is made under a base others can write');
});

test('L1193: parseStatus takes exactly the one format and refuses every other shape; statusText refuses what it would not read', () => {
  const good = statusOf([{ ok: true, what: 'x' }], BUILDER_UID, new Date('2026-11-14T12:00:00.000Z'));
  const line = statusText(good);
  assert.equal(line, `{"v":1,"time":"2026-11-14T12:00:00.000Z","builderUid":${BUILDER_UID},"anchorSha256":"${hexOf(BUILDER_UID)}","ok":true,"why":[]}\n`);
  assert.deepEqual({ ...parseStatus(line), why: [] }, good);
  assert.equal(parseStatus(line.trimEnd()).ok, true, 'no newline at the end reads too');
  assert.ok(Object.isFrozen(parseStatus(line))); assert.ok(Object.isFrozen(parseStatus(line).why));
  const o = JSON.parse(line); const j = (x) => JSON.stringify(x);
  const bad = {
    'two lines': `${line}${line}`, 'a CR': line.replace('\n', '\r\n'), 'not JSON': '{', 'an array': '[]', 'null': 'null', 'a number': '1',
    'a key more': j({ ...o, extra: 1 }), 'a key less': j({ v: o.v, time: o.time, builderUid: o.builderUid, anchorSha256: o.anchorSha256, ok: o.ok }),
    'version 2': j({ ...o, v: 2 }), 'version as text': j({ ...o, v: '1' }), 'a local time': j({ ...o, time: '2026-11-14T12:00:00.000+01:00' }), 'no millis': j({ ...o, time: '2026-11-14T12:00:00Z' }),
    'a date that is none': j({ ...o, time: '2026-02-30T12:00:00.000Z' }), 'uid 0': j({ ...o, builderUid: 0 }), 'uid as text': j({ ...o, builderUid: String(BUILDER_UID) }), 'uid not whole': j({ ...o, builderUid: 1.5 }),
    'upper hex': j({ ...o, anchorSha256: o.anchorSha256.toUpperCase() }), 'short hex': j({ ...o, anchorSha256: o.anchorSha256.slice(1) }),
    'ok as text': j({ ...o, ok: 'true' }), 'ok with a reason': j({ ...o, why: ['x'] }), 'ok without uid': j({ ...o, builderUid: null }),
    'ok without hash': j({ ...o, anchorSha256: null }), 'not ok, no reason': j({ ...o, ok: false }), 'why not a list': j({ ...o, ok: false, why: 'x' }),
    'an empty reason': j({ ...o, ok: false, why: [''] }), 'a long reason': j({ ...o, ok: false, why: ['x'.repeat(WHY_CHARS + 1)] }),
    'too many reasons': j({ ...o, ok: false, why: Array(WHY_MAX + 1).fill('x') }), 'a reason not text': j({ ...o, ok: false, why: [1] }),
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseStatus(text), Error, name);
  assert.throws(() => parseStatus(undefined)); assert.throws(() => statusText({ ...good, ok: 'yes' })); assert.throws(() => statusText({ ...good, v: undefined }));
  // statusOf: ok only with rows, all passing, and a uid; reasons are clipped and capped so the line stays short.
  assert.equal(statusOf([], BUILDER_UID).ok, false);
  assert.equal(statusOf([{ ok: true, what: 'x' }], null).ok, false);
  assert.equal(statusOf([{ ok: true, what: 'x' }, { ok: false, what: 'y', why: 'z' }], BUILDER_UID).ok, false);
  const many = statusOf(Array.from({ length: 40 }, (_, k) => ({ ok: false, what: `row ${k}`, why: 'y'.repeat(500) })), BUILDER_UID);
  assert.equal(many.why.length, WHY_MAX); assert.equal(many.why.at(-1), 'and 21 more');
  assert.ok(many.why.every((x) => x.length <= WHY_CHARS)); assert.doesNotThrow(() => parseStatus(statusText(many)));
});

test('L1193: the check job is one of setup\'s daemons, on with the worker runner: root\'s, the copy\'s node and this script\'s check, at load and every beat', () => {
  const raw = { base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/o/r.git', label: LABEL, runnerConfig: '/x/review.json' };
  const on = parseInstallConfig({ ...raw, workerRunner: { product: 'alpha' } }); const off = parseInstallConfig(raw);
  assert.deepEqual(jobsFor(on).slice(-2), [WALL_CHECK_JOB, 'worker-runner'], 'it loads just before the runner whose starts it gates');
  assert.equal(jobsFor(off).includes(WALL_CHECK_JOB), false);
  assert.ok(OPTIONAL_JOBS.includes(WALL_CHECK_JOB));
  assert.throws(() => onlyJobs(off, WALL_CHECK_JOB), /workerRunner/);
  assert.deepEqual(onlyJobs(off, WALL_CHECK_JOB, { anyKnown: true }), [WALL_CHECK_JOB], 'one the config has since turned off can still be taken out');
  const t = wallCheckPlist(on); const P = installPaths(on);
  assert.ok(t.includes(`<key>Label</key><string>${LABEL}.${WALL_CHECK_JOB}</string>`), t);
  assert.ok(t.includes(`<key>ProgramArguments</key><array><string>${P.installRoot}/${NODE}</string><string>${P.installRoot}/${WALL_SCRIPT}</string><string>check</string></array>`), t);
  assert.ok(t.includes(`<key>StartInterval</key><integer>${RECHECK_EVERY_S}</integer>`)); assert.ok(t.includes('<key>RunAtLoad</key><true/>'));
  assert.equal(/UserName/.test(t), false, 'root\'s: pf and the probes need root');
  assert.ok(existsSync(join(import.meta.dirname, '..', WALL_SCRIPT)), 'the script the job starts is this file');
});

test('L1193: the way out says worker sessions stay held until the wall is back, and how to stop the runner and the check job too', () => {
  const t = WAY_OUT_TEXT({ base: BASE, label: LABEL });
  assert.match(t, /Until the wall is back, every worker session stays held/);
  assert.ok(t.includes(`daemons unload --only worker-runner`) && t.includes(`daemons unload --only ${WALL_CHECK_JOB}`), t);
  assert.deepEqual(OPTIONAL_JOBS.filter((j) => t.includes(`--only ${j}`)).sort(), [WALL_CHECK_JOB, 'worker-runner'].sort(), 'the names it gives are real jobs');
});

// --- L1205 (the joint #585/#579 audit) -------------------------------------------------------------------------------

test('L1205 m1 PLANT: a throw in the read-back (a probe\'s connect, a command) writes ok false over an old ok; place takes the wall out', async () => {
  const boom = (w) => ({ ...w.net, connect: async () => { throw new Error('connect blew up'); } });
  const w = world(); writeConfig(w);
  assert.equal((await runMain(w, ['place'])).code, 0);
  assert.equal(parseStatus(statusAt(w)).ok, true);
  w.pf.enabled = false;
  const r = await runMain(w, ['check'], boom(w));
  assert.equal(r.code, 1, r.all);
  const s = parseStatus(statusAt(w));
  assert.equal(s.ok, false, 'the old ok does not stand');
  assert.ok(s.why.some((x) => /^the check: it stopped: connect blew up/.test(x)), s.why.join(' | '));
  // A command that throws (pfctl refused by the system, say).
  const w2 = world(); writeConfig(w2);
  assert.equal((await runMain(w2, ['place'])).code, 0);
  const run = w2.mac.run; w2.mac.run = (cmd, args) => { if (cmd === '/sbin/pfctl') { const e = new Error('spawnSync /sbin/pfctl EACCES'); e.code = 'EACCES'; throw e; } return run(cmd, args); };
  assert.equal((await runMain(w2, ['check'])).code, 1);
  const s2 = parseStatus(statusAt(w2));
  assert.equal(s2.ok, false); assert.ok(s2.why.some((x) => /EACCES/.test(x)), s2.why.join(' | '));
  // place: a throw in the read-back is a refusal; the wall is taken out and the status says so.
  const w3 = world(); writeConfig(w3);
  const r3 = await runMain(w3, ['place'], boom(w3));
  assert.equal(r3.code, 1);
  assert.match(r3.err, /The read-back refused, so the wall was taken out again/);
  const s3 = parseStatus(statusAt(w3));
  assert.equal(s3.ok, false); assert.equal(s3.why[0], 'place: the read-back refused, so the wall was taken out again');
  assert.ok(s3.why.some((x) => /connect blew up/.test(x)), s3.why.join(' | '));
});

test('L1205 m2: the status carries the time the check started, not when its probes ended', async () => {
  const w = world(); writeConfig(w);
  assert.equal((await runMain(w, ['place'])).code, 0);
  let slowed = false;
  const slow = { ...w.net, connect: async (a) => { if (!slowed) { slowed = true; await new Promise((ok) => { setTimeout(ok, 1200); }); } return w.net.connect(a); } };
  const before = Date.now();
  assert.equal((await runMain(w, ['check'], slow)).code, 0);
  const after = Date.now();
  const t = Date.parse(parseStatus(statusAt(w)).time);
  assert.ok(after - before >= 1200, 'the probes took the delay');
  assert.ok(t >= before && t < before + 1000, `stamped ${t - before} ms after the start of a ${after - before} ms check`);
});

test('L1205: an old status that is not one plain file of root\'s (a link, a second name) is removed and the run fails saying so', async () => {
  for (const plant of ['hard link', 'link', 'folder']) {
    const w = world(); writeConfig(w);
    assert.equal((await runMain(w, ['place'])).code, 0);
    const f = STATUS_FILE(w.cfg);
    if (plant === 'hard link') linkSync(w.mac.at(f), w.mac.at(`${BASE}/second-name`));
    else if (plant === 'link') { rmSync(w.mac.at(f)); writeFileSync(w.mac.at('/victim'), 'x'); symlinkSync(w.mac.at('/victim'), w.mac.at(f)); w.mac.owners.set(f, { uid: w.mac.rootUid, gid: 0 }); }
    else { rmSync(w.mac.at(f)); mkdirSync(w.mac.at(f)); w.mac.owners.set(f, { uid: w.mac.rootUid, gid: 0 }); }
    if (plant === 'folder') { assert.equal((await runMain(w, ['check'])).code, 1); continue; }   // unlink refuses a folder: the run fails, it never writes
    const r = await runMain(w, ['check']);
    assert.equal(r.code, 1, plant);
    assert.match(r.err, /was not one plain file of root's \((2 names|a link)\); it was removed, and nothing new was written/, `${plant}: ${r.err}`);
    assert.equal(existsSync(w.mac.at(f)), false, `${plant}: no old ok stands`);
    if (plant === 'link') assert.equal(readFileSync(w.mac.at('/victim'), 'utf8'), 'x', 'what the link pointed at is untouched');
    assert.equal((await runMain(w, ['check'])).code, 0, `${plant}: the next run writes it fresh`);
    assert.equal(w.mac.lstat(f).nlink, 1);
  }
});

test('L1205 cosmetic: parseStatus takes only the writer\'s exact bytes, and says plainly when a date is none', () => {
  const line = statusText(statusOf([{ ok: true, what: 'x' }], BUILDER_UID, new Date('2026-11-14T12:00:00.000Z')));
  const body = line.trimEnd(); const o = JSON.parse(body);
  const bad = {
    'a key given twice': body.replace('"ok":true', '"ok":false,"ok":true'),
    'space before': ` ${body}`, 'space after': `${body} `, 'space inside': body.replace('"v":1', '"v": 1'),
    'another key order': JSON.stringify({ time: o.time, v: o.v, builderUid: o.builderUid, anchorSha256: o.anchorSha256, ok: o.ok, why: o.why }),
    'a slash written \\/': body.replace('"why":[]', '"why":[]').replace('"ok":true,"why":[]', '"ok":false,"why":["a\\/b"]'),
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseStatus(text), /not written exactly as statusText writes it|keys are/, name);
  assert.throws(() => parseStatus(JSON.stringify({ ...o, time: '2026-13-45T99:99:99.999Z' })), /the status's time is not a real UTC time/);
  assert.equal(parseStatus(line).ok, true);
});

test('#617 r1 m2: check says, as a WARN row that fails nothing, another user\'s listener started in the range after place', async () => {
  const w = world(); writeConfig(w);
  assert.equal((await runMain(w, ['place'])).code, 0);
  const clean = await runMain(w, ['check']);
  assert.match(clean.out, /^PASS {2}no other user's socket listens in the builder user's ports 47000:47999$/m);
  assert.match(clean.out, new RegExp(`^all ${ROWS_CHECK} PASS$`, 'm'));
  w.listening.TCP = `p123\nu${OWNER_UID}\nn127.0.0.1:47123\n`;
  const r = await runMain(w, ['check']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^WARN {2}no other user's socket listens in the builder user's ports 47000:47999 — TCP 127\.0\.0\.1:47123 \(uid 65001, pid 123\): the wall cuts it off, even from its own user/m);
  assert.match(r.out, new RegExp(`^all ${ROWS_CHECK} PASS \\(1 with a WARN\\)$`, 'm'));
  assert.equal(JSON.parse(readFileSync(w.mac.at(STATUS_FILE(w.cfg)), "utf8")).ok, true, "a WARN leaves the status ok");
  // lsof failing is said the same way: not known, never "nobody listens".
  const run = w.mac.run;
  w.mac.run = (cmd, args) => (cmd === '/usr/sbin/lsof' ? { status: 2, stdout: '', stderr: 'lsof: status error' } : run(cmd, args));
  assert.match((await runMain(w, ['check'])).out, /^WARN .* — lsof could not list the TCP sockets in 47000:47999 .*: not known$/m);
});

test('#617 r1 m6: only a socket whose own (local) port is in the range counts; one talking TO a port in the range does not', () => {
  const far = world({ listening: { TCP: '', UDP: `p55\nu${OWNER_UID}\nn127.0.0.1:50123->127.0.0.1:47005\nn[::1]:51000->[::1]:47006\n` } });
  assert.equal(rangeListenersProblem(far.mac, BUILDER_UID), null);
  assert.deepEqual(planWall(far.mac, far.cfg).problems, []);
  const near = world({ listening: { TCP: '', UDP: `p56\nu${OWNER_UID}\nn127.0.0.1:47005->127.0.0.1:50123\nn[::1]:47999\n` } });
  assert.match(String(rangeListenersProblem(near.mac, BUILDER_UID)), /2 sockets .*UDP 127\.0\.0\.1:47005 \(uid 65001, pid 56\), UDP \[::1\]:47999/);
  // Below and above the range by one: not in it.
  const edge = world({ listening: { TCP: `p57\nu${OWNER_UID}\nn127.0.0.1:46999\nn*:48000\n`, UDP: '' } });
  assert.equal(rangeListenersProblem(edge.mac, BUILDER_UID), null);
});

test('#617 r1 m7: a read-back with a row skipped (or one more) refuses at run time, though every row it gave passed', async () => {
  const w = world();
  await placed(w);
  assert.equal(SETTINGS_ROWS, 7);
  const skip = async (cfg, net, other) => (await trafficChecks(cfg, net, other)).filter((r, i) => i !== 3);
  const rows = await checkWall(w.mac, w.cfg, { net: w.net, traffic: skip });
  assert.deepEqual(fails(rows), [`the read-back ran all ${ROWS_CHECK} of its rows — it gave ${ROWS_CHECK - 1}: a row skipped or added is no proof, so the check refuses`]);
  const more = async (cfg, net, other) => [...await trafficChecks(cfg, net, other), { ok: true, what: 'an extra' }];
  assert.equal(fails(await checkWall(w.mac, w.cfg, { net: w.net, traffic: more })).length, 1);
  // With no other address: the note row counts, and the count is the loopback one.
  const lone = await checkWall(w.mac, w.cfg, { net: fakeNet(w.pf, { addresses: [] }) });
  assert.deepEqual(fails(lone), []); assert.equal(lone.length, expectedRows(0));
});

test('#617 r1 M1: the real UDP client sends from a port in the range it is given (the builder\'s probes for v, vii and viii)', async (t) => {
  // L1299: on a Mac where the wall is placed, rule 3 refuses the listener's answer into the wall's range for any user but
  // builder, so this real send can't come back here (the wall working); V2's live rows (v) run the same client as builder.
  if (existsSync(ANCHOR_FILE)) { t.skip(`the builder wall is placed on this machine (${ANCHOR_FILE}); its live check runs this client`); return; }
  // With no range the kernel picks the port: it is clear of the wall's range only where the ephemeral range is, as on a
  // Mac the wall accepts (iv). A Linux runner's range (32768-60999) holds 47000-47999, so a pick there proves nothing.
  const clear = ephemeralProblem({ run: (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }) }) === null;
  const { createSocket } = await import('node:dgram');
  const s = createSocket('udp4'); const seen = [];
  s.on('message', (m, r) => { seen.push(r.port); s.send('pong', r.port, r.address); });
  await new Promise((ok) => { s.bind(0, '127.0.0.1', ok); });
  const run = (extra) => new Promise((resolve) => { const c = spawn(process.execPath, ['-e', CLIENT, 'udp', '127.0.0.1', String(s.address().port), ...extra]); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o)); });
  try {
    assert.equal(await run([String(PROBE_FIRST), String(WALL_RANGE.last)]), 'ok');
    assert.ok(seen[0] >= PROBE_FIRST && seen[0] <= WALL_RANGE.last, `sent from ${seen[0]}`);
    assert.equal(await run([]), 'ok');
    if (clear) assert.ok(seen[1] < WALL_RANGE.first || seen[1] > WALL_RANGE.last, `with no range, sent from ${seen[1]}`);
  } finally { s.close(); }
});
