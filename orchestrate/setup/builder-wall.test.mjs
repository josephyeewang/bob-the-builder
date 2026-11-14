// R-0b-179 (L1148 F1, L1149, L1150): the builder wall, on the stand-in Mac with a stand-in pf. The stand-in pf loads the
// anchor's text, prints it the way OpenBSD's pfctl does (one rule per protocol, `user = N`, `all`), and decides each probe
// connection from the rules it holds, so a wrong rule shows up twice: in what the check reads back, and in the traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { ROOT_CONFIG_PATH } from './layout.mjs';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import {
  ALL_ADDRESSES, ANCHOR, ANCHOR_DIR, ANCHOR_FILE, FAMILIES, PROTOS, TAG, anchorText, bootScript, checkWall, loadedRulesProblem, main, otherAddresses,
  planWall, tokenPath, unreadPath, waitForFirstRun, wallLabel, wallPlistPath, wallDir,
} from './builder-wall.mjs';

const BASE = '/Library/orchestrate';
const LABEL = 'com.example.orch';
const BUILDER_UID = 65002;
const OWNER_UID = 65001;   // sam, the stand-in Mac's own user
const LAN = '192.168.1.20';   // the stand-in Mac's one address that is not loopback
/** Every place the read-back probes: [family, the address probed, how its rows name it]. */
const PLACES = [...FAMILIES.map(([f, h]) => [f, h, `${f} (${h})`]), ...ALL_ADDRESSES.map(([f, h, b]) => [f, h, `${f} (${h}, listening on ${b})`]),
  ["this Mac's own address", LAN, `this Mac's own address (${LAN})`]];
const ROWS_CHECK = 5 + PROTOS.length * PLACES.length * 4;   // the settings half, then v, ii, i, ii-again per protocol and place
const FAST = { sleep: async () => {}, limitMs: 15_000, stepMs: 500 };

/** pf, stood in: its state, pfctl's answers, and a rule evaluator for the probes. */
function fakePf(mac, { mainAnchor = true } = {}) {
  const pf = { enabled: false, refs: new Map(), next: 41, anchors: new Map(), mainAnchor, calls: [] };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  // The way OpenBSD's print_rule writes a loaded rule: one per protocol, `user = N`, `all` for from any to any.
  const printed = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).flatMap((l) => {
    const m = /\bproto \{ ([a-z ]+) \}/.exec(l);
    const each = m ? m[1].split(' ').map((p) => l.replace(m[0], `proto ${p}`)) : [l];
    return each.map((x) => x.replace(/from any to any/, 'all').replace(/\buser (!=\s*)?(\d+)/, (_, n, u) => `user ${n ? '!= ' : '= '}${u}`).replace(/\s+/g, ' '));
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
  /** One rule line as the evaluator needs it. */
  const parse = (l) => ({
    action: l.split(' ')[0], dir: /\bin\b/.test(l) ? 'in' : 'out', quick: /\bquick\b/.test(l),
    lo0: /\bon lo0\b/.test(l) ? true : /\bon ! lo0\b/.test(l) ? false : null,
    proto: /\bproto (\w+)/.exec(l)?.[1] ?? null, fam: /\binet6\b/.test(l) ? 'IPv6' : /\binet\b/.test(l) ? 'IPv4' : null,
    user: /\buser (=|!=) (\d+)/.exec(l), tag: / tag (\S+)/.exec(l)?.[1] ?? null, tagged: /\btagged (\S+)/.exec(l)?.[1] ?? null,
  });
  const matches = (r, { dir, proto, fam, uid, tag }) => r.dir === dir && r.lo0 !== false && (!r.proto || r.proto === proto) && (!r.fam || r.fam === fam)
    && (!r.user || (r.user[1] === '=' ? uid === Number(r.user[2]) : uid !== Number(r.user[2]))) && (!r.tagged || r.tagged === tag);
  /** A connection on lo0 from user `from` to a listener of user `to`: 'ok' or 'refused'. */
  pf.decide = ({ fromUid, toUid, proto, fam }) => {
    if (!pf.enabled) return 'ok';
    const rules = (pf.anchors.get(ANCHOR) ?? []).map(parse);
    let tag = null;
    for (const r of rules) if (matches(r, { dir: 'out', proto, fam, uid: fromUid })) { if (r.action === 'block') return 'refused'; if (r.tag) tag = r.tag; if (r.quick) break; }
    for (const r of rules) if (matches(r, { dir: 'in', proto, fam, uid: toUid, tag })) { if (r.action === 'block') return 'refused'; if (r.quick) break; }
    return 'ok';
  };
  return pf;
}

/** The probes, stood in: listeners are numbers, a connection is pf's decision. `twist` lets a test break the probes themselves. */
function fakeNet(pf, { twist = null, addresses = null } = {}) {
  const uidOf = (user) => (user === 'builder' ? BUILDER_UID : user === 'sam' ? OWNER_UID : -1);
  const listeners = new Map(); let port = 50000;
  const log = []; const binds = [];
  return {
    log,
    binds,
    addresses: () => (addresses ? [...addresses] : [LAN]),
    listen: async ({ user, proto, host }) => {
      const p = port++; const l = { user, proto, host, got: 0 }; listeners.set(p, l); binds.push(`${user} ${proto} ${host}`);
      return { port: p, received: () => l.got, settle: async () => {}, close: () => listeners.delete(p) };
    },
    connect: async ({ user, proto, host, port: p }) => {
      const l = listeners.get(p); const fam = host.includes(':') ? 'IPv6' : 'IPv4';
      log.push(`${user}→${l.user} ${proto} ${host}`);
      // The request, then the listener's reply back (the TCP SYN-ACK, the UDP pong): both legs must pass for an 'ok'. A
      // request that got there is received, whatever the reply's fate.
      const there = pf.decide({ fromUid: uidOf(user), toUid: uidOf(l.user), proto, fam });
      if (there === 'ok') l.got += 1;
      const said = there === 'ok' ? pf.decide({ fromUid: uidOf(l.user), toUid: uidOf(user), proto, fam }) : there;
      return twist ? twist({ user, to: l.user, proto, fam, host, said }) : said;
    },
  };
}

/**
 * The stand-in Mac with a builder, the stand-in pf, and the job. `late`: the job's first run comes only at that many
 * `launchctl print`s after load (launchd starts a RunAtLoad job after bootstrap has returned, #556 r1 M2); Infinity, never.
 */
function world({ builder = true, builderUid = BUILDER_UID, mainAnchor = true, late = 0 } = {}) {
  const mac = fakeMac({ users: builder ? { builder: { UniqueID: String(builderUid), PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/builder' } } : {} });
  // /etc is a link to /private/etc on the stand-in Mac as on a real one: the anchor folder is made through the real path.
  for (const d of [ANCHOR_DIR, BASE]) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), 0o755); mac.owners.set(d, { uid: mac.rootUid, gid: 0 }); }
  const pf = fakePf(mac, { mainAnchor });
  const cfg = { base: BASE, owner: 'sam', products: ['alpha'], label: LABEL };
  const runMac = mac.run; let wait = null;
  const runJob = () => { const j = mac.loaded.get(wallLabel(cfg)); const code = pf.job(); if (j) { j.runs = (j.runs ?? 0) + 1; j.lastExit = code; } };
  mac.run = (cmd, args) => {
    if (cmd === '/sbin/pfctl') return pf.run(args);
    if (cmd === '/bin/launchctl' && args[0] === 'print' && args[1] === `system/${wallLabel(cfg)}` && wait !== null && (wait -= 1) <= 0) { wait = null; runJob(); }
    const r = runMac(cmd, args);
    // launchd runs the job at load (RunAtLoad), as root: at once, or a little later.
    if (cmd === '/bin/launchctl' && args[0] === 'bootstrap' && r.status === 0 && args[2] === mac.at(wallPlistPath(cfg))) {
      mac.loaded.get(wallLabel(cfg)).runs = 0;
      if (late === 0) runJob(); else wait = late;
    }
    return r;
  };
  return { mac, pf, cfg, net: fakeNet(pf) };
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
  assert.match(anchorText(BUILDER_UID), new RegExp(`user ${BUILDER_UID} tag ${TAG}`));
  assert.equal(w.mac.lstat(ANCHOR_FILE).mode & 0o7777, 0o644);
  assert.equal(w.mac.lstat(wallDir(w.cfg)).mode & 0o7777, 0o700);
  assert.ok(w.mac.loaded.has(wallLabel(w.cfg)));
  // The real path, not the one through /etc (#556 r1 M1): on the stand-in Mac as on a real one, /etc is a link, so a
  // folder named through it is refused by the chain check, and the wall could never be placed.
  assert.match(ANCHOR_FILE, /^\/private\/etc\/pf\.anchors\//);
  assert.match(chainProblem(w.mac.at('/etc/pf.anchors'), { owner: w.mac.rootUid, top: w.mac.prefix }), /\/etc is a link/);
  // Both directions in each protocol and place, every run (L1150), with one address that is not loopback (r1 m4).
  for (const p of PROTOS) for (const [, host] of PLACES) for (const who of ['builder→builder', 'sam→sam', 'builder→sam']) assert.ok(w.net.log.includes(`${who} ${p} ${host}`), `${who} ${p} ${host} was not tried`);
  assert.equal(rows.length, ROWS_CHECK);
  // An owner service bound to every address is a place of its own (#556 r2 m5): the owner's listener is bound to 0.0.0.0 and ::.
  for (const p of PROTOS) for (const [, , b] of ALL_ADDRESSES) assert.ok(w.net.binds.includes(`sam ${p} ${b}`), `the owner never listened on ${b} (${p})`);
  assert.equal(rows.filter((r) => /\((i|ii|v)(;|\))/.test(r.what)).length, PROTOS.length * PLACES.length * 4);
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
  assert.equal(f.filter((x) => /\(i\) — not proven/.test(x)).length, PROTOS.length * PLACES.length);
});

test('R-0b-179 plants (L1150): each wrong rule is refused, by what pf holds and by the traffic it lets through or blocks', async () => {
  const u = BUILDER_UID;
  const plants = {
    'a pass rule with no tag': [rulesWith(` tag ${TAG} no state`, ' no state'), /missing the rules? tag \(tcp\), tag \(udp\)/, /\(i\) — builder connected/],
    'a block rule missing user !=': [rulesWith(` user != ${u}`, ''), /missing the rules? block-in/, /\(v; the proxy path\) — it got refused/],
    '::1 left out (IPv4 only)': [rulesWith('pass out quick on lo0 proto', 'pass out quick on lo0 inet proto'), /missing the rules? tag/, /UDP IPv6 .*\(i\) — builder connected|TCP IPv6 .*\(i\) — builder connected/],
    'UDP left out': [rulesWith('proto { tcp udp } from any to any user', 'proto tcp from any to any user'), /tag \(udp\)/, /UDP IPv4 .*\(i\) — builder connected/],
    'the self rule left out': [anchorText(u).split('\n').filter((l) => !/to self/.test(l)).join('\n'), /missing the rules? self \(tcp\), self \(udp\)/, null],
    'a port narrowed on the block': [rulesWith(`tagged ${TAG} user`, `port 1:1024 tagged ${TAG} user`), /missing the rules? block-in/, /\(i\) — builder connected/],
  };
  for (const [name, [text, held, traffic]] of Object.entries(plants)) {
    const w = world();
    await placed(w);
    const f = fails(await withRules(w, text));
    assert.ok(f.some((x) => held.test(x)), `${name}: what pf holds was not refused:\n${f.join('\n')}`);
    // The stand-in pf ignores ports, so the narrowed block still blocks there; real pf would not. The self rule is off lo0.
    if (traffic && name !== 'a port narrowed on the block') assert.ok(f.some((x) => traffic.test(x)), `${name}: the traffic did not show it:\n${f.join('\n')}`);
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

test('R-0b-179 (L1154): another user cannot reach a builder listener either (the builder\'s tagged reply is blocked), and can with the wall down', async () => {
  const w = world();
  await placed(w);
  for (const proto of PROTOS) for (const [fam, host] of FAMILIES) {
    const l = await w.net.listen({ user: 'builder', proto, host });
    assert.equal(await w.net.connect({ user: 'sam', proto, host, port: l.port }), 'refused', `${proto} ${fam}: the owner reached a builder listener`);
    w.pf.enabled = false;
    assert.equal(await w.net.connect({ user: 'sam', proto, host, port: l.port }), 'ok', `${proto} ${fam}: the control (no wall) failed`);
    w.pf.enabled = true; l.close();
  }
  // It is the tag on the reply that does it: with the tag rule gone the owner gets through.
  await withRules(w, rulesWith(` tag ${TAG} no state`, ' no state'));
  const l = await w.net.listen({ user: 'builder', proto: 'tcp', host: '127.0.0.1' });
  assert.equal(await w.net.connect({ user: 'sam', proto: 'tcp', host: '127.0.0.1', port: l.port }), 'ok');
});

test('R-0b-179: loadedRulesProblem reads OpenBSD\'s print or a list not split, in any order, and refuses an extra or a missing word', () => {
  const u = BUILDER_UID;
  const asPrinted = [
    `pass out quick on lo0 proto tcp all user = ${u} tag ${TAG} no state`, `pass out quick on lo0 proto udp all user = ${u} tag ${TAG} no state`,
    `block return in quick on lo0 proto tcp all user != ${u} tagged ${TAG}`, `block return in quick on lo0 proto udp all user != ${u} tagged ${TAG}`,
    `block return out quick on ! lo0 inet proto tcp from any to 192.168.1.20 user = ${u}`, `block return out quick on ! lo0 inet proto udp from any to 192.168.1.20 user = ${u}`,
    `block return out quick on ! lo0 inet6 proto tcp from any to fe80::1 user = ${u}`, `block return out quick on ! lo0 inet6 proto udp from any to fe80::1 user = ${u}`,
  ];
  assert.equal(loadedRulesProblem(asPrinted.join('\n'), u), null);
  assert.equal(loadedRulesProblem(anchorText(u), u), null);
  assert.equal(loadedRulesProblem([...asPrinted].reverse().join('\n'), u), null);
  assert.match(loadedRulesProblem([...asPrinted, 'pass in quick on lo0 all'].join('\n'), u), /not the wall's/);
  assert.match(loadedRulesProblem(asPrinted.map((l) => l.replace(`user != ${u}`, `user = ${u}`)).join('\n'), u), /block-in/, '`=` is never read as `!=`');
  assert.match(loadedRulesProblem(asPrinted.map((l) => l.replace(`${u}`, '501')).join('\n'), u), /missing/, 'another uid');
  assert.match(loadedRulesProblem('', u), /holds no rules/);
  // #556 r2 m4: a `!` belongs to the word after it; moved to another word, it is another rule.
  assert.match(String(loadedRulesProblem(asPrinted.map((l) => l.replace('from any to', 'from ! any to')).join('\n'), u)), /not the wall's|missing/, '`from ! any` passed');
  assert.match(String(loadedRulesProblem(asPrinted.map((l) => l.replace('on ! lo0', '! on lo0')).join('\n'), u)), /not the wall's|missing/, '`! on lo0` passed');
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
  assert.equal(f.filter((x) => /\(i\) — the owner's listener received 1 from builder \(the probe said timeout\)/.test(x)).length, PROTOS.length * PLACES.length, f.join('\n'));
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
  assert.ok(rows.some((r) => /no address but loopback, so only 127\.0\.0\.1 and ::1 were probed/.test(r.what)));
  assert.equal(lone.log.some((l) => l.endsWith(LAN)), false);
  // The real lookup: the first IPv4 address that is not internal or link-local.
  assert.deepEqual(otherAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '169.254.3.4', family: 'IPv4', internal: false }, { address: '10.0.0.7', family: 'IPv4', internal: false }] }), ['10.0.0.7']);
  assert.deepEqual(otherAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), []);
});

test('R-0b-179 (r1 m2, m3): every printed word is checked: keep state, no quick, a group, a family on a rule that is not self, and a qualifier more all refuse', async () => {
  const u = BUILDER_UID;
  const plants = {
    'the tag rule keeping state': rulesWith(`tag ${TAG} no state`, `tag ${TAG} keep state`),
    'the block rule not quick': rulesWith('block return in quick on lo0', 'block return in on lo0'),
    'the tag rule not quick': rulesWith('pass out quick on lo0', 'pass out on lo0'),
    'the block rule narrowed by group': rulesWith(`tagged ${TAG} user != ${u}`, `tagged ${TAG} user != ${u} group = 20`),
    'the block rule IPv4 only': rulesWith('block return in quick on lo0 proto', 'block return in quick on lo0 inet proto'),
    'the self rule to one port': rulesWith('to self user', 'to self port 22 user'),
    'the block rule dropping, not returning': rulesWith('block return in quick', 'block drop in quick'),
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
