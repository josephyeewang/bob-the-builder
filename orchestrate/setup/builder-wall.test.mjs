// R-0b-179 (L1148 F1, L1149, L1150): the builder wall, on the stand-in Mac with a stand-in pf. The stand-in pf loads the
// anchor's text, prints it the way OpenBSD's pfctl does (one rule per protocol, `user = N`, `all`), and decides each probe
// connection from the rules it holds, so a wrong rule shows up twice: in what the check reads back, and in the traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { ROOT_CONFIG_PATH } from './layout.mjs';
import {
  ANCHOR, ANCHOR_FILE, FAMILIES, PROTOS, TAG, anchorText, bootScript, checkWall, loadedRulesProblem, main, planWall,
  tokenPath, wallLabel, wallPlistPath, wallDir,
} from './builder-wall.mjs';

const BASE = '/Library/orchestrate';
const LABEL = 'com.example.orch';
const BUILDER_UID = 65002;
const OWNER_UID = 65001;   // sam, the stand-in Mac's own user

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
    if (!pf.mainAnchor) return;
    pf.run(['-a', ANCHOR, '-q', '-f', ANCHOR_FILE]);
    let tok = null; try { tok = readFileSync(mac.at(tokenPath({ base: BASE })), 'utf8').trim(); } catch { /* none */ }
    if (pf.enabled && tok && pf.refs.has(Number(tok))) return;
    const r = pf.run(['-E']); writeFileSync(mac.at(tokenPath({ base: BASE })), /Token : (\d+)/.exec(r.stderr)[1]);
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
function fakeNet(pf, { twist = null } = {}) {
  const uidOf = (user) => (user === 'builder' ? BUILDER_UID : user === 'sam' ? OWNER_UID : -1);
  const listeners = new Map(); let port = 50000;
  const log = [];
  return {
    log,
    listen: async ({ user, proto, host }) => { const p = port++; listeners.set(p, { user, proto, host }); return { port: p, close: () => listeners.delete(p) }; },
    connect: ({ user, proto, host, port: p }) => {
      const l = listeners.get(p); const fam = FAMILIES.find(([, h]) => h === host)[0];
      log.push(`${user}→${l.user} ${proto} ${fam}`);
      const said = pf.decide({ fromUid: uidOf(user), toUid: uidOf(l.user), proto, fam });
      return twist ? twist({ user, to: l.user, proto, fam, said }) : said;
    },
  };
}

function world({ builder = true, builderUid = BUILDER_UID, mainAnchor = true } = {}) {
  const mac = fakeMac({ users: builder ? { builder: { UniqueID: String(builderUid), PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/builder' } } : {} });
  for (const d of ['/etc', '/etc/pf.anchors', BASE]) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), 0o755); mac.owners.set(d, { uid: mac.rootUid, gid: 0 }); }
  const pf = fakePf(mac, { mainAnchor });
  const cfg = { base: BASE, owner: 'sam', products: ['alpha'], label: LABEL };
  const runMac = mac.run;
  mac.run = (cmd, args) => {
    if (cmd === '/sbin/pfctl') return pf.run(args);
    const r = runMac(cmd, args);
    // launchd runs the job at load (RunAtLoad), as root.
    if (cmd === '/bin/launchctl' && args[0] === 'bootstrap' && r.status === 0 && args[2] === mac.at(wallPlistPath(cfg))) pf.job();
    return r;
  };
  return { mac, pf, cfg, net: fakeNet(pf) };
}
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
  // Both directions in each protocol and family, every run (L1150): 4 × (v, ii, i), and nothing else proven by traffic.
  for (const p of PROTOS) for (const [fam] of FAMILIES) for (const who of ['builder→builder', 'sam→sam', 'builder→sam']) assert.ok(w.net.log.includes(`${who} ${p} ${fam}`), `${who} ${p} ${fam} was not tried`);
  assert.equal(rows.filter((r) => /\((i|ii|v)(;|\))/.test(r.what)).length, PROTOS.length * FAMILIES.length * 3);
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
  assert.ok(f.some((x) => /\(i\) — not proven: a control above failed/.test(x)));
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
  assert.ok(f.some((x) => /holds the wall's rules \(iv\) — com\.apple\/100\.orchestrate\.builder holds no rules/.test(x)), f.join('\n'));
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
  assert.equal(f.filter((x) => /reaches its own listener .*\(v; the proxy path\) — it got refused/.test(x)).length, 4, f.join('\n'));
  assert.equal(f.filter((x) => /\(i\) — not proven/.test(x)).length, 4);
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
  for (const p of PROTOS) for (const [fam, host] of FAMILIES) {
    const where = `${p.toUpperCase()} ${fam} (${host})`;
    const at = (re) => rows.findIndex((r) => r.what.includes(where) && re.test(r.what));
    const v = at(/\(v;/); const ii = at(/\(ii\)/); const i = at(/\(i\)/);
    assert.ok(v >= 0 && ii >= 0 && i > v && i > ii, `${where}: v ${v}, ii ${ii}, i ${i}`);
  }
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
});

test('R-0b-179: a failed read-back takes the wall out again (job unloaded, its file gone, rules emptied, token released)', async () => {
  const w = world();
  const net = fakeNet(w.pf, { twist: ({ user, to, said }) => (user === 'sam' && to === 'sam' ? 'refused' : said) });
  mkdirSync(w.mac.at('/Library'), { recursive: true });
  writeFileSync(w.mac.at(ROOT_CONFIG_PATH), JSON.stringify({ base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/o/r.git', label: LABEL, runnerConfig: '/x/review.json' }));
  const out = []; const err = [];
  const code = await main(['place'], { io: w.mac, net, out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.equal(code, 1, [...out, ...err].join('\n'));
  assert.ok(err.includes('The read-back refused, so the wall was taken out again:'), err.join('\n'));
  assert.equal(w.mac.loaded.has(wallLabel(w.cfg)), false);
  assert.equal(existsSync(w.mac.at(wallPlistPath(w.cfg))), false);
  assert.equal(w.pf.anchors.has(ANCHOR), false);
  assert.equal(w.pf.refs.size, 0); assert.equal(w.pf.enabled, false);
  // The same config, the probes honest: it places and passes.
  const w2 = { ...w, net: fakeNet(w.pf) };
  out.length = 0; err.length = 0;
  assert.equal(await main(['place'], { io: w2.mac, net: w2.net, out: (s) => out.push(s), err: (s) => err.push(s) }), 0, [...out, ...err].join('\n'));
  assert.match(out.join('\n'), /all 17 PASS/);
  assert.equal(await main(['check'], { io: w2.mac, net: w2.net, out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
  assert.equal(await main(['nonsense'], { io: w2.mac, net: w2.net, out: () => {}, err: () => {} }), 2);
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
  "-E") touch "$S/on"; n=$(( $(cat "$S/n" 2>/dev/null || echo 40) + 1 )); echo $n > "$S/n"; echo $n >> "$S/refs"; echo 'pf enabled' >&2; echo "Token : $n" >&2; exit 0 ;;
  "-q -a ${ANCHOR} -f "*) cp "\${5}" "$S/loaded"; exit 0 ;;
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
});
