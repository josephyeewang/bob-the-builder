// builder-proxy.test.mjs — the builder's allow-list proxy (wall v2), with real local sockets on random ports.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { join } from 'node:path';
import { writeFileSync, utimesSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { PROXY_PORTS, inRange } from '../shared/builder-ports.mjs';
import { TUNNEL_PORTS, HTTP_PORTS, BUILDER_PROXY_JOB, DENY, LISTEN_HOSTS, PORT_LIST, builderProxyPlist, createProxy, fileLists, hostOf, listsFrom, main, proxyListenRows, publicAddress, serve } from './builder-proxy.mjs';

const PUBLIC = '93.184.216.34';
const SECRET = 'hunter2-s3cr3t-value';
// #617 r2 m3: every server and socket a test opens is closed at the end, so a failed assertion (which skips its test's
// own close) reports at once instead of holding the file open until the runner's own limit.
const OPEN = new Set();
const keep = (x) => { OPEN.add(x); x.once?.('close', () => OPEN.delete(x)); return x; };
after(() => { for (const x of OPEN) { if (x instanceof net.Server) x.close(); else x.destroy?.(); } });

/** An upstream on 127.0.0.1:random that records what it got and echoes it back (after a fixed greeting for plain HTTP). */
async function upstream({ http = false, hold = false } = {}) {
  const got = []; let conns = 0;
  const s = keep(net.createServer((c) => { keep(c); conns += 1; c.on('data', (d) => { got.push(d); if (hold) return; if (http) c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); else c.write(d); }); c.on('error', () => {}); }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, got: () => Buffer.concat(got).toString('latin1'), conns: () => conns, close: () => s.close() };
}

/** A proxy on 127.0.0.1:random whose every allowed connection lands on `up`, with `answers` as the DNS. */
async function proxy({ up, list = ['allowed.example.com'], answers = [{ address: PUBLIC }], ...opts } = {}) {
  const logs = [];
  const s = createProxy({ allowed: () => list, log: (o) => logs.push(o), port: 47000, lookup: async () => answers,
    connect: () => keep(net.connect({ host: '127.0.0.1', port: up?.port ?? 1 })), ...opts });
  keep(s); s.on('connection', keep);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, logs, close: () => new Promise((r) => s.close(r)), server: s };
}

/** Send `parts` (each written in turn, a short pause between), read until the far end closes or `ms` passes. */
function ask(port, parts, { ms = 400, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const c = keep(net.connect({ host, port })); const got = []; let i = 0;
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
  assert.deepEqual([...TUNNEL_PORTS], [22, 443]); assert.deepEqual([...HTTP_PORTS], [80]);
});

test('CONNECT to a listed host reaches it; the log says allow, the host and the bytes', { timeout: 20_000 }, async () => {
  const up = await upstream(); const p = await proxy({ up });
  const { out, log: l } = await via(p, ['CONNECT allowed.example.com:443 HTTP/1.1\r\nHost: allowed.example.com:443\r\n\r\n', 'ping']);
  assert.match(out.toString('latin1'), /^HTTP\/1\.1 200 Connection Established\r\n\r\nping$/);
  assert.equal(up.got(), 'ping');
  assert.deepEqual(Object.keys(l).sort(), ['down', 'host', 'port', 't', 'up', 'verdict']);
  assert.equal(l.verdict, 'allow'); assert.equal(l.host, 'allowed.example.com'); assert.equal(l.up, 4); assert.equal(l.down, 4); assert.equal(l.port, 47000);
  await p.close(); up.close();
});

test('CONNECT refusals: not listed, an IP address, user information, another port, a non-public DNS answer; nothing reaches the upstream', { timeout: 20_000 }, async () => {
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

test('plain HTTP (absolute form): sent on in origin form; Proxy-Authorization never passed on and never logged; nor the path', { timeout: 20_000 }, async () => {
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

test('#617 r1 M2 plain HTTP: a Host that is not the URL\'s own is refused, a second Host too; :80 and case are the same host; the upstream gets the URL\'s Host', { timeout: 20_000 }, async () => {
  const up = await upstream({ http: true }); const p = await proxy({ up });
  for (const head of [
    'GET http://allowed.example.com/x HTTP/1.1\r\nHost: evil.example.net\r\n\r\n',
    'GET http://allowed.example.com/x HTTP/1.1\r\nHost: allowed.example.com:8080\r\n\r\n',
    'GET http://allowed.example.com/x HTTP/1.1\r\nHost: allowed.example.com\r\nHost: evil.example.net\r\n\r\n',
    'GET http://allowed.example.com/x HTTP/1.1\r\nhost:evil.example.net\r\n\r\n',
  ]) {
    const { out, log: l } = await via(p, [head]);
    assert.match(out.toString('latin1'), /^HTTP\/1\.1 403 /, head);
    assert.equal(l.verdict, 'deny', head); assert.equal(l.why, 'host-mismatch', head); assert.ok(DENY.includes(l.why));
  }
  assert.equal(up.conns(), 0, 'nothing reached the upstream');
  for (const host of ['allowed.example.com:80', 'ALLOWED.example.com', 'allowed.example.com.', null]) {
    const n = up.got().length;
    const { log: l } = await via(p, [`GET http://allowed.example.com/x HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}\r\n`]);
    assert.equal(l.verdict, 'allow', String(host));
    const sent = up.got().slice(n);
    assert.equal((sent.match(/\r\nHost: /g) ?? []).length, 1, String(host)); assert.match(sent, /\r\nHost: allowed\.example\.com\r\n/, String(host));
  }
  await p.close(); up.close();
});

test('#617 r1 M2 plain HTTP: one request per connection; a pipelined second one (same packet or later) refuses and never goes up; a chunked body refuses', { timeout: 20_000 }, async () => {
  // An upstream that does not answer, so the connection is still open when the client's next bytes come.
  const up = await upstream({ hold: true }); const p = await proxy({ up });
  const first = 'GET http://allowed.example.com/one HTTP/1.1\r\nHost: allowed.example.com\r\n\r\n';
  const second = 'GET /second HTTP/1.1\r\nHost: evil2.example.net\r\n\r\n';
  // In one packet: refused before anything goes up.
  const a = await via(p, [first + second]);
  assert.match(a.out.toString('latin1'), /^HTTP\/1\.1 400 /); assert.equal(a.log.why, 'second-request'); assert.equal(up.conns(), 0);
  // A body of Content-Length bytes goes up whole; a byte past it (a later packet) refuses, and the second request never goes up.
  const post = 'POST http://allowed.example.com/p HTTP/1.1\r\nHost: allowed.example.com\r\nContent-Length: 5\r\n\r\n';
  const b = await via(p, [post + 'ab', 'cde' + second], { ms: 600 });
  assert.equal(b.log.verdict, 'deny'); assert.equal(b.log.why, 'second-request');
  assert.match(up.got(), /\r\n\r\nab(cde)?$/); assert.doesNotMatch(up.got(), /second|evil2/);
  // Pipelined in a later packet with no body: refused; only the first went up.
  const n = up.got().length;
  const c = await via(p, [first, second], { ms: 600 });
  assert.equal(c.log.why, 'second-request'); assert.doesNotMatch(up.got().slice(n), /second|evil2/);
  for (const head of ['POST http://allowed.example.com/p HTTP/1.1\r\nHost: allowed.example.com\r\nTransfer-Encoding: chunked\r\n\r\n',
    'POST http://allowed.example.com/p HTTP/1.1\r\nHost: allowed.example.com\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n']) {
    const d = await via(p, [head]); assert.match(d.out.toString('latin1'), /^HTTP\/1\.1 400 /, head); assert.equal(d.log.why, 'bad-request', head);
  }
  await p.close(); up.close();
});

test('#617 r3 plain HTTP: routing headers (Forwarded, X-Forwarded-*, X-Host, X-Original-URL, X-Rewrite-URL; any case, _ for -) never reach the upstream; other headers do', { timeout: 20_000 }, async () => {
  const up = await upstream({ http: true }); const p = await proxy({ up });
  const routing = ['Forwarded: for=1.2.3.4;host=evil.example.net', 'X-Forwarded-For: 1.2.3.4', 'X-Forwarded-Host: evil.example.net',
    'x-forwarded-proto: https', 'X_Forwarded_Host: evil.example.net', 'X-Forwarded: evil.example.net', 'X-Host: evil.example.net',
    'X-Original-URL: /admin', 'x_original_url: /admin', 'X-Rewrite-URL: /admin', 'X-REWRITE-URL: /admin'];
  const { log: l } = await via(p, [`GET http://allowed.example.com/x HTTP/1.1\r\nHost: allowed.example.com\r\n${routing.join('\r\n')}\r\nAccept: */*\r\n\r\n`]);
  assert.equal(l.verdict, 'allow');
  const sent = up.got();
  assert.match(sent, /\r\nAccept: \*\/\*\r\n/, 'an ordinary header goes on');
  for (const h of routing) assert.ok(!sent.includes(h.slice(0, h.indexOf(':') + 1)), h);
  assert.doesNotMatch(sent, /forwarded|x[-_]host|original|rewrite|evil|admin/i);
  await p.close(); up.close();
});

test('#617 r3 plain HTTP: a trailing dot and a padded port are the same host on both sides (http://allowed.example.com./ with Host allowed.example.com., :080 with Host :080)', { timeout: 20_000 }, async () => {
  const up = await upstream({ http: true }); const p = await proxy({ up });
  for (const [url, host] of [['http://allowed.example.com./x', 'allowed.example.com.'], ['http://allowed.example.com./x', 'allowed.example.com'],
    ['http://allowed.example.com:080/x', 'allowed.example.com:080'], ['http://allowed.example.com:080/x', 'allowed.example.com'],
    ['http://allowed.example.com/x', 'allowed.example.com:0080'], ['http://allowed.example.com.:080/x', 'ALLOWED.example.com.:80']]) {
    const n = up.got().length;
    const { log: l } = await via(p, [`GET ${url} HTTP/1.1\r\nHost: ${host}\r\n\r\n`]);
    assert.equal(l.verdict, 'allow', `${url} ${host}`);
    assert.match(up.got().slice(n), /\r\nHost: allowed\.example\.com\r\n/, `${url} ${host}`);
  }
  // Still refused: another name, another port, a dot or port that only looks the same.
  for (const [url, host] of [['http://allowed.example.com./x', 'evil.example.net.'], ['http://allowed.example.com:080/x', 'allowed.example.com:8080'],
    ['http://allowed.example.com/x', 'allowed.example.com..'], ['http://allowed.example.com/x', 'allowed.example.com:80:80']]) {
    const { log: l } = await via(p, [`GET ${url} HTTP/1.1\r\nHost: ${host}\r\n\r\n`]);
    assert.equal(l.why, 'host-mismatch', `${url} ${host}`);
  }
  await p.close(); up.close();
});

test('#617 r2 M1: a tunnel (CONNECT or SOCKS) reaches only 22 and 443; port 80 only by the checked plain-HTTP path, so a smuggled Host or a pipelined request never goes up', { timeout: 20_000 }, async () => {
  const up = await upstream(); const p = await proxy({ up });
  const smuggled = 'GET / HTTP/1.1\r\nHost: evil.example.net\r\n\r\nGET /2 HTTP/1.1\r\nHost: other.example.org\r\n\r\n';
  const c = await via(p, ['CONNECT allowed.example.com:80 HTTP/1.1\r\nHost: allowed.example.com:80\r\n\r\n', smuggled]);
  assert.match(c.out.toString('latin1'), /^HTTP\/1\.1 403 /); assert.equal(c.log.why, 'bad-port');
  const s = await via(p, [socksHello, socksName('allowed.example.com', 80), smuggled]);
  assert.deepEqual([...s.out.subarray(0, 4)], [5, 0, 5, 2]); assert.equal(s.log.why, 'bad-port');
  // Plain HTTP to another port than 80 is refused too (the auditor's absolute form with :443).
  const h = await via(p, ['GET http://allowed.example.com:443/ HTTP/1.1\r\nHost: allowed.example.com:443\r\n\r\n']);
  assert.match(h.out.toString('latin1'), /^HTTP\/1\.1 403 /); assert.equal(h.log.why, 'bad-port');
  assert.equal(up.conns(), 0); assert.equal(up.got(), '');
  await p.close(); up.close();
});

test('#617 r2 m1 plain HTTP: a lone CR or LF, a folded line (space or tab first) and a field name that is not token characters are refused', { timeout: 20_000 }, async () => {
  const up = await upstream({ hold: true }); const p = await proxy({ up });
  for (const [name, parts] of [
    ['a bare LF hiding Transfer-Encoding', ['POST http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\nX: a\nTransfer-Encoding: chunked\r\nContent-Length: 60\r\n\r\n', '0\r\n\r\nGET /x HTTP/1.1\r\nHost: evil.example.net\r\nX: 123456\r\n\r\n']],
    ['a lone CR', ['GET http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\rX: y\r\n\r\n']],
    ['a space continuation', ['GET http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\n evil.example.net\r\n\r\n']],
    ['a tab continuation', ['GET http://allowed.example.com/ HTTP/1.1\r\n\tHost: evil.example.net\r\n\r\n']],
    ['a space before the colon', ['GET http://allowed.example.com/ HTTP/1.1\r\nHost : evil.example.net\r\n\r\n']],
    ['a doubled Content-Length, one with a space', ['POST http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\nContent-Length: 5\r\nContent-Length : 5\r\n\r\nhello']],
    ['Transfer_Encoding (read as Transfer-Encoding by some servers)', ['POST http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\nTransfer_Encoding: chunked\r\nContent-Length: 3\r\n\r\nabc']],
    ['a field name with a bracket', ['GET http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\nX[1]: y\r\n\r\n']],
  ]) {
    const { out, log: l } = await via(p, parts);
    assert.match(out.toString('latin1'), /^HTTP\/1\.1 400 /, name); assert.equal(l.why, 'bad-request', name);
  }
  assert.equal(up.conns(), 0);
  await p.close(); up.close();
});

test('SOCKS5 on the same port: a listed name reaches it (hello and request apart, or together); refusals answer as SOCKS', { timeout: 20_000 }, async () => {
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

test('limits: a head past MAX_HEAD, too many at once, a client that never asks', { timeout: 20_000 }, async () => {
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

test('end to end from the config file: a rules host the product does not name is refused at the session port', { timeout: 20_000 }, async () => {
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
  // #617 r1 m4: NAT64 (64:ff9b::/96) and IPv4-compatible (::/96) forms of a public address are not public either.
  for (const a of ['64:ff9b::808:808', '64:ff9b::5db8:d822', '::808:808', '::5db8:d822']) assert.ok(!publicAddress(a), a);
  // This Mac's own address and the networks it sits on, even public ones, are refused; an address beyond them is not.
  const ifaces = { en0: [{ address: '93.184.216.10', family: 'IPv4', cidr: '93.184.216.10/24', internal: false }, { address: '2606:4700:10::5', family: 'IPv6', cidr: '2606:4700:10::5/64', internal: false }],
    utun3: [{ address: 'fe80::1%utun3', family: 'IPv6', cidr: 'fe80::1/64' }] };
  for (const a of [PUBLIC, '93.184.216.10', '2606:4700:10::99', '2606:4700:10::5']) assert.ok(!publicAddress(a, { ifaces }), a);
  for (const a of ['93.184.217.1', '2606:4700:11::1', '8.8.8.8']) assert.ok(publicAddress(a, { ifaces }), a);
});

test('serve listens on both loopback addresses for each port; main refuses root and a missing config', { timeout: 20_000 }, async () => {
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

test('daemons: the proxy\'s job is on exactly with the worker runner, before the wall\'s check job; a loop, so alive is the check', { timeout: 20_000 }, async () => {
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
