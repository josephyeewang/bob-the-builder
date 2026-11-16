// builder-proxy.test.mjs — the builder's allow-list proxy (wall v2), with real local sockets on random ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { join } from 'node:path';
import { writeFileSync, utimesSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { PROXY_PORTS, inRange } from '../shared/builder-ports.mjs';
import { ALLOWED_PORTS, BUILDER_PROXY_JOB, DENY, LISTEN_HOSTS, PORT_LIST, builderProxyPlist, createProxy, fileLists, hostOf, listsFrom, main, proxyListenRows, publicAddress, serve } from './builder-proxy.mjs';

const PUBLIC = '93.184.216.34';
const SECRET = 'hunter2-s3cr3t-value';

/** An upstream on 127.0.0.1:random that records what it got and echoes it back (after a fixed greeting for plain HTTP). */
async function upstream({ http = false } = {}) {
  const got = []; let conns = 0;
  const s = net.createServer((c) => { conns += 1; c.on('data', (d) => { got.push(d); if (http) c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); else c.write(d); }); c.on('error', () => {}); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, got: () => Buffer.concat(got).toString('latin1'), conns: () => conns, close: () => s.close() };
}

/** A proxy on 127.0.0.1:random whose every allowed connection lands on `up`, with `answers` as the DNS. */
async function proxy({ up, list = ['allowed.example.com'], answers = [{ address: PUBLIC }], ...opts } = {}) {
  const logs = [];
  const s = createProxy({ allowed: () => list, log: (o) => logs.push(o), port: 47000, lookup: async () => answers,
    connect: () => net.connect({ host: '127.0.0.1', port: up?.port ?? 1 }), ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, logs, close: () => new Promise((r) => s.close(r)), server: s };
}

/** Send `parts` (each written in turn, a short pause between), read until the far end closes or `ms` passes. */
function ask(port, parts, { ms = 400, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port }); const got = []; let i = 0;
    const next = () => { if (i < parts.length) { c.write(parts[i]); i += 1; setTimeout(next, 30); } };
    c.on('connect', next); c.on('data', (d) => got.push(d)); c.on('error', () => {});
    const end = () => { clearTimeout(t); c.destroy(); resolve(Buffer.concat(got)); };
    const t = setTimeout(end, ms); c.on('close', end);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 60));
/** `ask` through proxy `p`, then wait for that connection's log line: → { out, log }. */
async function via(p, parts, opts) {
  const n = p.logs.length; const out = await ask(p.port, parts, opts);
  for (let k = 0; k < 30 && p.logs.length <= n; k += 1) await settle();
  return { out, log: p.logs.at(-1) };
}

const socksHello = Buffer.from([5, 1, 0]);
const socksName = (name, port) => Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), Buffer.from(name, 'latin1'), Buffer.from([port >> 8, port & 255])]);

test('the ports: both of the proxy\'s in the builder\'s range, one list each, on both loopback addresses only', () => {
  for (const p of Object.values(PROXY_PORTS)) assert.ok(inRange(p), String(p));
  assert.deepEqual(PORT_LIST, { [PROXY_PORTS.session]: 'session', [PROXY_PORTS.install]: 'install' });
  assert.deepEqual([...LISTEN_HOSTS], ['127.0.0.1', '::1']);
  assert.deepEqual([...ALLOWED_PORTS], [22, 80, 443]);
});

test('CONNECT to a listed host reaches it; the log says allow, the host and the bytes', async () => {
  const up = await upstream(); const p = await proxy({ up });
  const { out, log: l } = await via(p, ['CONNECT allowed.example.com:443 HTTP/1.1\r\nHost: allowed.example.com:443\r\n\r\n', 'ping']);
  assert.match(out.toString('latin1'), /^HTTP\/1\.1 200 Connection Established\r\n\r\nping$/);
  assert.equal(up.got(), 'ping');
  assert.deepEqual(Object.keys(l).sort(), ['down', 'host', 'port', 't', 'up', 'verdict']);
  assert.equal(l.verdict, 'allow'); assert.equal(l.host, 'allowed.example.com'); assert.equal(l.up, 4); assert.equal(l.down, 4); assert.equal(l.port, 47000);
  await p.close(); up.close();
});

test('CONNECT refusals: not listed, an IP address, user information, another port, a non-public DNS answer; nothing reaches the upstream', async () => {
  const up = await upstream();
  const cases = [
    ['CONNECT other.example.com:443 HTTP/1.1', 'not-listed', {}],
    ['CONNECT ALLOWED.example.com.evil.com:443 HTTP/1.1', 'not-listed', {}],
    ['CONNECT 93.184.216.34:443 HTTP/1.1', 'ip-literal', {}],
    ['CONNECT [::1]:443 HTTP/1.1', 'ip-literal', {}],
    [`CONNECT u:${SECRET}@allowed.example.com:443 HTTP/1.1`, 'userinfo', {}],
    ['CONNECT allowed.example.com:8080 HTTP/1.1', 'bad-port', {}],
    ['CONNECT allowed.example.com:443 HTTP/1.1', 'not-public', { answers: [{ address: '127.0.0.1' }] }],
    ['CONNECT allowed.example.com:443 HTTP/1.1', 'not-public', { answers: [{ address: PUBLIC }, { address: '10.1.2.3' }] }],
    ['CONNECT allowed.example.com:443 HTTP/1.1', 'not-public', { answers: [{ address: '::1' }] }],
    ['CONNECT allowed.example.com:443 HTTP/1.1', 'not-public', { answers: [] }],
    ['CONNECT allowed.example.com:443 HTTP/1.1', 'dns-failed', { lookup: async () => { throw new Error('ENOTFOUND'); } }],
    ['CONNECT allowed.example.com:443 HTTP/1.1', 'no-list', { allowed: () => { throw new Error('gone'); } }],
  ];
  for (const [line, why, opts] of cases) {
    const p = await proxy({ up, ...opts });
    const { out, log: l } = await via(p, [`${line}\r\nProxy-Authorization: Basic ${SECRET}\r\n\r\n`]);
    assert.match(out.toString('latin1'), /^HTTP\/1\.1 (403|400) /, line);
    assert.equal(l.verdict, 'deny', line); assert.equal(l.why, why, line); assert.ok(DENY.includes(l.why));
    assert.doesNotMatch(JSON.stringify(p.logs), new RegExp(SECRET), `no credential in the log: ${line}`);
    await p.close();
  }
  assert.equal(up.conns(), 0);
  up.close();
});

test('plain HTTP (absolute form): sent on in origin form; Proxy-Authorization never passed on and never logged; nor the path', async () => {
  const up = await upstream({ http: true }); const p = await proxy({ up });
  const { out, log: l } = await via(p, [`GET http://allowed.example.com/secret-path?token=${SECRET} HTTP/1.1\r\nHost: allowed.example.com\r\nProxy-Authorization: Basic ${SECRET}\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n`]);
  assert.match(out.toString('latin1'), /^HTTP\/1\.1 200 OK/);
  const sent = up.got();
  assert.match(sent, /^GET \/secret-path\?token=\S+ HTTP\/1\.1\r\n/);
  assert.match(sent, /\r\nHost: allowed\.example\.com\r\n/); assert.match(sent, /\r\nConnection: close\r\n\r\n$/);
  assert.doesNotMatch(sent, /Proxy-Authorization|Proxy-Connection/i);
  assert.equal(l.verdict, 'allow'); assert.equal(l.host, 'allowed.example.com');
  const text = JSON.stringify(p.logs);
  assert.doesNotMatch(text, new RegExp(SECRET)); assert.doesNotMatch(text, /secret-path|Basic|Accept/);
  // User information in the URL is refused, and not logged either.
  const r2 = await via(p, [`GET http://u:${SECRET}@allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\n\r\n`]);
  assert.match(r2.out.toString('latin1'), /^HTTP\/1\.1 403 /);
  assert.equal(r2.log.why, 'userinfo');
  assert.doesNotMatch(JSON.stringify(p.logs), new RegExp(SECRET));
  // Only http:// in absolute form: an origin-form request or another scheme is refused.
  for (const req of ['GET / HTTP/1.1\r\nHost: allowed.example.com\r\n\r\n', 'GET ftp://allowed.example.com/ HTTP/1.1\r\n\r\n', 'GET http://other.example.com/ HTTP/1.1\r\n\r\n']) {
    const o = await ask(p.port, [req]); assert.match(o.toString('latin1'), /^HTTP\/1\.1 40[03] /, req);
  }
  await p.close(); up.close();
});

test('SOCKS5 on the same port: a listed name reaches it (hello and request apart, or together); refusals answer as SOCKS', async () => {
  const up = await upstream(); const p = await proxy({ up });
  for (const parts of [[socksHello, socksName('allowed.example.com', 22), 'SSH-2.0-x'], [Buffer.concat([socksHello, socksName('allowed.example.com', 22)]), 'SSH-2.0-x']]) {
    const { out, log } = await via(p, parts);
    assert.deepEqual([...out.subarray(0, 12)], [5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    assert.equal(out.subarray(12).toString('latin1'), 'SSH-2.0-x');
    assert.equal(log.verdict, 'allow');
  }
  const refused = [
    [[socksHello, socksName('other.example.com', 22)], 'not-listed', [5, 0, 5, 2]],
    [[socksHello, Buffer.from([5, 1, 0, 1, 93, 184, 216, 34, 0, 22])], 'ip-literal', [5, 0, 5, 2]],
    [[socksHello, Buffer.from([5, 1, 0, 4, ...Array(16).fill(0), 0, 22])], 'ip-literal', [5, 0, 5, 2]],
    [[socksHello, Buffer.from([5, 2, 0, 3, 19, ...Buffer.from('allowed.example.com'), 0, 22])], 'socks-command', [5, 0, 5, 7]],
    [[Buffer.from([5, 1, 2])], 'socks-auth', [5, 0xff]],
    [[socksHello, socksName('allowed.example.com', 25)], 'bad-port', [5, 0, 5, 2]],
  ];
  const before = up.conns();
  for (const [parts, why, head] of refused) {
    const { out, log } = await via(p, parts);
    assert.deepEqual([...out.subarray(0, head.length)], head, why);
    assert.equal(log.why, why);
  }
  assert.equal(up.conns(), before);
  await p.close(); up.close();
});

test('limits: a head past MAX_HEAD, too many at once, a client that never asks', async () => {
  const up = await upstream();
  const p = await proxy({ up, maxHead: 64, maxConnections: 1, handshakeMs: 150 });
  const big = await via(p, [`CONNECT allowed.example.com:443 HTTP/1.1\r\nX: ${'a'.repeat(200)}\r\n\r\n`]);
  assert.match(big.out.toString('latin1'), /^HTTP\/1\.1 431 /); assert.equal(big.log.why, 'too-big');
  // One held open (it never asks); the second is refused while it is.
  const held = net.connect({ host: '127.0.0.1', port: p.port }); held.on('error', () => {});
  await settle();
  await ask(p.port, ['CONNECT allowed.example.com:443 HTTP/1.1\r\n\r\n'], { ms: 100 });
  await settle();
  assert.ok(p.logs.some((l) => l.why === 'too-many'), JSON.stringify(p.logs));
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(p.logs.some((l) => l.why === 'timeout'), `the silent client is cut at handshakeMs: ${JSON.stringify(p.logs)}`);
  held.destroy();
  // A connection past maxBytes is cut.
  const p2 = await proxy({ up, maxBytes: 8 });
  assert.equal((await via(p2, ['CONNECT allowed.example.com:443 HTTP/1.1\r\n\r\n', '0123456789abcdef'])).log.why, 'too-big');
  await p.close(); await p2.close(); up.close();
});

test('the lists: phaseHosts over every product; the session list is the product hosts, never the whole rules list (widen plant)', () => {
  const cfg = { products: {
    a: { render: { product: { hosts: ['github.com'] }, rulesHosts: ['github.com', 'example.com'], registryHosts: ['registry.npmjs.org'] } },
    b: { render: { product: { hosts: ['api.stripe.com'] }, rulesHosts: ['api.stripe.com'] } },
    bad: { render: { product: { hosts: ['not-on-rules.com'] }, rulesHosts: ['github.com'] } },
  } };
  const l = listsFrom(cfg);
  assert.deepEqual(l.session, ['api.stripe.com', 'github.com']);
  assert.deepEqual(l.install, ['api.stripe.com', 'github.com', 'registry.npmjs.org']);
  assert.deepEqual(l.refused, ['bad']);
  assert.ok(!l.session.includes('example.com') && !l.install.includes('example.com'), 'a rules host the product does not name is never allowed');
  assert.deepEqual(listsFrom({}), { session: [], install: [], refused: [] });
  assert.deepEqual(listsFrom(null), { session: [], install: [], refused: [] });
});

test('fileLists: read again when the file changes; unreadable or broken is an empty list', () => {
  const dir = tempDir('orch-proxy-'); const f = join(dir, 'worker-runner.json');
  const write = (hosts, at) => { writeFileSync(f, JSON.stringify({ products: { a: { render: { product: { hosts }, rulesHosts: hosts } } } })); utimesSync(f, at, at); };
  write(['github.com'], 1000);
  const lists = fileLists(f);
  assert.deepEqual(lists().session, ['github.com']);
  write(['gitlab.com'], 2000); assert.deepEqual(lists().session, ['gitlab.com']);
  writeFileSync(f, '{broken'); utimesSync(f, 3000, 3000); assert.deepEqual(lists().session, []);
  assert.deepEqual(fileLists(join(dir, 'missing.json'))().session, []);
});

test('end to end from the config file: a rules host the product does not name is refused at the session port', async () => {
  const dir = tempDir('orch-proxy-'); const f = join(dir, 'worker-runner.json');
  writeFileSync(f, JSON.stringify({ products: { a: { render: { product: { hosts: ['github.com'] }, rulesHosts: ['github.com', 'example.com'], registryHosts: ['registry.npmjs.org'] } } } }));
  const up = await upstream(); const lists = fileLists(f);
  const session = await proxy({ up, allowed: () => lists().session });
  const install = await proxy({ up, allowed: () => lists().install });
  const to = async (p, host) => (await ask(p.port, [`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`])).toString('latin1');
  assert.match(await to(session, 'github.com'), /^HTTP\/1\.1 200 /);
  assert.match(await to(session, 'example.com'), /^HTTP\/1\.1 403 /);
  assert.match(await to(session, 'registry.npmjs.org'), /^HTTP\/1\.1 403 /);
  assert.match(await to(install, 'registry.npmjs.org'), /^HTTP\/1\.1 200 /);
  assert.match(await to(install, 'example.com'), /^HTTP\/1\.1 403 /);
  await session.close(); await install.close(); up.close();
});

test('hostOf and publicAddress', () => {
  assert.deepEqual(hostOf('GitHub.COM.'), { host: 'github.com' });
  for (const [h, why] of [['1.2.3.4', 'ip-literal'], ['[::1]', 'ip-literal'], ['::ffff:127.0.0.1', 'ip-literal'], ['a@b.com', 'userinfo'], ['localhost', 'bad-request'], ['a_b.com', 'bad-request'], ['', 'bad-request']]) assert.equal(hostOf(h).deny, why, h);
  for (const a of ['8.8.8.8', PUBLIC, '2606:4700::1111']) assert.ok(publicAddress(a), a);
  for (const a of ['127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:8.8.8.8', 'ff02::1', 'x']) assert.ok(!publicAddress(a), a);
});

test('serve listens on both loopback addresses for each port; main refuses root and a missing config', async () => {
  const servers = await serve({ configPath: '/nonexistent.json', ports: { 0: 'session' }, log: () => {} });
  assert.deepEqual(servers.map((s) => s.address().address).sort(), ['127.0.0.1', '::1']);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  let err = '';
  assert.equal(await main(['--config', '/x/worker-runner.json'], { getuid: () => 0, start: async () => { throw new Error('must not start'); }, err: (t) => { err += t; } }), 2);
  assert.match(err, /never as root/);
  assert.equal(await main([], { getuid: () => 501, err: () => {} }), 2);
  assert.equal(await main(['--config', 'relative.json'], { getuid: () => 501, err: () => {} }), 2);
  assert.equal(await main(['--config', '/x.json'], { getuid: () => 501, start: async () => { throw Object.assign(new Error('x'), { code: 'EADDRINUSE' }); }, err: () => {} }), 1);
  assert.equal(await main(['--config', '/x.json'], { getuid: () => 501, start: async () => {} }), null);
});

test('the proxy\'s job: as the builder, umask 077, no signal debugger, the copy\'s worker-runner.json', () => {
  const t = builderProxyPlist({ label: 'com.example.orch', base: '/opt/orch', owner: 'joe' });
  assert.match(t, new RegExp(`<key>Label</key><string>com\\.example\\.orch\\.${BUILDER_PROXY_JOB}</string>`));
  assert.match(t, /<key>UserName<\/key><string>builder<\/string>/);
  assert.match(t, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(t, /<string>--disable-sigusr1<\/string><string>\/opt\/orch\/install\/orchestrate\/setup\/builder-proxy\.mjs<\/string><string>--config<\/string><string>\/opt\/orch\/install\/orchestrate\/worker-runner\.json<\/string>/);
  assert.match(t, /<key>RunAtLoad<\/key><true\/>/);
});

test('daemons: the proxy\'s job is on exactly with the worker runner, before the wall\'s check job; a loop, so alive is the check', async () => {
  const { jobsFor, onlyJobs, OPTIONAL_JOBS, runRows } = await import('./daemons.mjs');
  const on = { label: 'com.example.orch', base: '/opt/orch', owner: 'joe', workerRunner: { product: 'alpha' } };
  const off = { ...on, workerRunner: undefined };
  assert.deepEqual(jobsFor(on).slice(-4), ['worker-rules', BUILDER_PROXY_JOB, 'builder-wall-check', 'worker-runner']);
  assert.ok(!jobsFor(off).includes(BUILDER_PROXY_JOB));
  assert.ok(OPTIONAL_JOBS.includes(BUILDER_PROXY_JOB));
  assert.throws(() => onlyJobs(off, BUILDER_PROXY_JOB), /workerRunner|worker runner/);
  assert.deepEqual(onlyJobs(off, BUILDER_PROXY_JOB, { anyKnown: true }), [BUILDER_PROXY_JOB]);
  assert.deepEqual(onlyJobs(on, BUILDER_PROXY_JOB), [BUILDER_PROXY_JOB]);
  const io = { run: () => ({ status: 0, stdout: '99-00:00:00\n', stderr: '' }) };
  const alive = runRows(io, on, BUILDER_PROXY_JOB, { loaded: true, pid: 42, lastExit: '(never exited)' });
  assert.equal(alive.length, 1); assert.equal(alive[0].ok, true, 'running for days is fine for a loop');
  assert.equal(runRows(io, on, BUILDER_PROXY_JOB, { loaded: true, pid: null, lastExit: '1' })[0].ok, false);
});

test('daemons check: the proxy listens on both loopback addresses at both ports, as the builder, nowhere else; NEEDS ROOT without root', () => {
  const cfg = { label: 'com.example.orch', base: '/opt/orch', owner: 'joe' };
  const B = 603;
  const lsofOut = (port, lines) => lines.map(([uid, name]) => `p1\nu${uid}\nn${name}`).join('\n') + '\n';
  const fakeIo = (byPort, { euid = 0 } = {}) => ({ euid: () => euid, run: (cmd, args) => {
    if (cmd.endsWith('dscl')) return { status: 0, stdout: `UniqueID: ${B}\nPrimaryGroupID: 20\nNFSHomeDirectory: /opt/orch/home/builder\nUserShell: /usr/bin/false\nIsHidden: 1\n`, stderr: '' };
    const port = Number(/-iTCP:(\d+)/.exec(args.join(' '))[1]);
    const lines = byPort[port] ?? [];
    return lines.length ? { status: 0, stdout: lsofOut(port, lines), stderr: '' } : { status: 1, stdout: '', stderr: '' };
  } });
  const good = (p) => [[B, `127.0.0.1:${p}`], [B, `[::1]:${p}`]];
  const all = { [PROXY_PORTS.session]: good(PROXY_PORTS.session), [PROXY_PORTS.install]: good(PROXY_PORTS.install) };
  let rows = proxyListenRows(fakeIo(all), cfg);
  assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.ok && !r.skip), JSON.stringify(rows));
  rows = proxyListenRows(fakeIo(all, { euid: 501 }), cfg);
  assert.ok(rows.every((r) => r.skip && /needs root/.test(r.why)));
  const s = PROXY_PORTS.session;
  for (const [lines, why] of [
    [[[B, `127.0.0.1:${s}`]], /nothing listens on \[::1\]/],
    [[], /nothing listens on 127\.0\.0\.1/],
    [[[501, `127.0.0.1:${s}`], [B, `[::1]:${s}`]], /uid 501\) is not the builder user's/],
    [[...good(s), [B, `*:${s}`]], /also listens on \*:/],
  ]) {
    const r = proxyListenRows(fakeIo({ ...all, [s]: lines }), cfg)[0];
    assert.equal(r.ok, false); assert.match(r.why, why);
  }
});
