// builder-proxy.mjs — the builder sessions' allow-list proxy (builder wall v2).
//
// WHY. Under the wall v2 (builder-wall.mjs) the builder reaches only loopback ports in its own range. Claude Code's own
// sandbox proxy listens on a port the kernel picks, outside that range, so a builder session's shell could no longer
// reach it. Instead each builder session's role file names THIS proxy: httpProxyPort and socksProxyPort both set to one of
// PROXY_PORTS (render-settings.mjs renderRoleSettings, builderProxy). This proxy runs as the builder, from its own launchd
// job (daemons.mjs, BUILDER_PROXY_JOB), on 127.0.0.1 and ::1 at those fixed ports, and lets a shell reach only the hosts
// the session's settings allow.
//
// Claude Code 2.1.316 (checked: claude-code 2.1.316, re-check on upgrade; a capability note, so it expires):
//   - With httpProxyPort and socksProxyPort set it starts no proxy of its own and treats the ports as an outside proxy:
//     it does NOT filter by allowedDomains any more (it says the list "will never apply"). This proxy is the filter.
//   - Both must be set, or it starts its own proxy for the one left out. The same port serves both here: a SOCKS5 client's
//     first byte is 0x05, an HTTP request's is a letter.
//   - The shell gets HTTP_PROXY/HTTPS_PROXY=http://localhost:<port>, ALL_PROXY=socks5h://localhost:<port>, NO_PROXY for
//     localhost and the private ranges, and GIT_SSH_COMMAND through `nc -X 5 -x localhost:<port>`; the Seatbelt profile
//     lets the shell reach only localhost:<port>. No proxy credential is sent.
//   - The proxy settings are applied only when allowedDomains is defined (it always is in a role file), and are ignored
//     under allowManagedDomainsOnly (the machine-wide file never sets it; if it did, every builder shell fails closed).
//   - api.anthropic.com is NOT affected: the claude process itself talks to Anthropic directly, not through the shell's
//     sandbox and not over loopback, so the wall and this proxy never see that traffic.
//
// The allow list comes from the one place the settings take theirs: render-settings.mjs phaseHosts, over every product
// in the installed worker-runner.json. The session port allows each product's session hosts; the install port each
// product's install hosts (its session hosts plus its registry hosts). A cost: the proxy can't tell which product's
// session is asking, so one product's session may reach another product's listed hosts (all are on the rules' list).
//
// What it refuses: a host not on the list (exact match, lowercase), an IP address instead of a name, a name with user
// information (user:pass@), a tunnel (CONNECT or SOCKS) to a port other than TUNNEL_PORTS (22, 443) or plain HTTP to one
// other than HTTP_PORTS (80), a name whose DNS answer holds a loopback, private,
// link-local, multicast, NAT64 (64:ff9b::/96), IPv4-compatible (::/96) or otherwise non-public address, or one of this
// Mac's own addresses or networks (os.networkInterfaces, read at each lookup), so an allowed name can't be pointed back
// into the Mac or its LAN; and any SOCKS command but CONNECT. It connects to the address it checked, never a second
// lookup. Proxy-Authorization and Proxy-Connection headers are dropped, never passed on and never logged.
// Plain HTTP (#617 r1 M2, r2): port 80 is reached only this way, never by a tunnel. A Host header that is not the URL's
// own host[:port] is refused (the upstream obeys Host, not the URL), and so is a head with a lone CR or LF, a line
// starting with a space or tab (a folded line), or a field name that is not plain token characters followed by its
// colon. A connection carries ONE request: its body is Content-Length bytes, a chunked body is refused, and a byte past
// the body (a pipelined second request) refuses the connection before it goes up. SOCKS clients wanting plain HTTP must
// use the HTTP proxy (the same port). Routing headers (Forwarded, X-Forwarded-*, X-Host, X-Original-URL, X-Rewrite-URL)
// are dropped (#617 r3). Upgrade is passed on but harmless: Connection becomes close, and any client bytes after a 101
// reply end the connection (they are past the one request's body).
// What it can't stop: inside a CONNECT tunnel the TLS is the client's, so a client may ask a listed name's server (a
// shared CDN, say) for another site by the TLS server name or the inner Host (domain fronting). Claude Code's own
// proxy has the same limit; only a proxy that ends the TLS could see it.
//
// Limits: MAX_CONNECTIONS at once, MAX_HEAD bytes of request head, HANDSHAKE_MS to finish asking, IDLE_MS of silence,
// MAX_BYTES each way per connection. The log is one JSON line per connection on standard output, which launchd keeps as
// <logDir>/builder-proxy.out.log: time, port, host, allow or deny (with a fixed reason word), bytes up and down. Nothing
// else: no path, header, address or credential. Why it stopped or would not start goes to <logDir>/builder-proxy.err.log.
//
// Run: node builder-proxy.mjs --config <installRoot>/worker-runner.json (as the builder; it refuses root).

import net from 'node:net';
import dns from 'node:dns';
import { networkInterfaces } from 'node:os';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROXY_PORTS } from '../shared/builder-ports.mjs';
import { HOST, phaseHosts } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { BUILDER, JOB_PATH, WORKER_RUNNER_CONFIG, homeOf } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';

export const BUILDER_PROXY_JOB = 'builder-proxy';
export const BUILDER_PROXY_SCRIPT = 'setup/builder-proxy.mjs';
/** Where it listens: both loopback addresses, never a wider one. */
export const LISTEN_HOSTS = Object.freeze(['127.0.0.1', '::1']);
/**
 * Destination ports a shell may reach. A tunnel (CONNECT or SOCKS) carries the client's bytes unread, so it goes only to
 * ssh (git) and https; http (80) goes only through the plain-HTTP path, whose request head is checked (#617 r2 M1: a
 * CONNECT or SOCKS tunnel to port 80 passed a smuggled Host and pipelined requests on unread).
 */
export const TUNNEL_PORTS = Object.freeze([22, 443]);
export const HTTP_PORTS = Object.freeze([80]);
/** A request-head field name: HTTP's token characters, the colon right after it (no space, no folded line). */
const FIELD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/;
/** Plain-HTTP header fields never passed on: the proxy's own, the connection's, and routing ones (#617 r3) an upstream or a
 * front end may obey in place of Host. Any case; `_` counts as `-`. */
const DROPPED = /^(host|proxy[-_]authorization|proxy[-_]connection|connection|keep[-_]alive|forwarded|x[-_]forwarded(?:[-_][^:]*)?|x[-_]host|x[-_]original[-_]url|x[-_]rewrite[-_]url):/i;
export const MAX_CONNECTIONS = 64;
export const MAX_HEAD = 16 * 1024;
export const HANDSHAKE_MS = 10_000;
export const IDLE_MS = 5 * 60_000;
export const MAX_BYTES = 2 * 1024 ** 3;
/** The fixed reason words a deny is logged with. */
export const DENY = Object.freeze(['not-listed', 'ip-literal', 'userinfo', 'bad-port', 'bad-request', 'not-public', 'dns-failed',
  'socks-auth', 'socks-command', 'too-many', 'too-big', 'timeout', 'connect-failed', 'no-list', 'host-mismatch', 'second-request']);


// Addresses a listed name must never resolve to: the Mac itself, the local networks, and anything not unicast-public.
// Two lists, one per family: a BlockList also matches an IPv4 address against its IPv6 rules (as ::ffff:a.b.c.d), so the
// mapped range in one list would block every IPv4 address.
const BLOCKED4 = new net.BlockList(); const BLOCKED6 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 96], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED6.addSubnet(a, p, 'ipv6');
/**
 * This Mac's own addresses and the networks they sit on (#617 r1 m4), read at each call (an interface comes and goes):
 * a public address of the Mac's, or a public network it is on, is the Mac or its neighbours all the same.
 */
export function ownNetworks(ifaces = networkInterfaces()) {
  const four = new net.BlockList(); const six = new net.BlockList();
  for (const list of Object.values(ifaces ?? {})) for (const a of list ?? []) {
    const fam = a?.family === 'IPv4' || a?.family === 4 ? 'ipv4' : a?.family === 'IPv6' || a?.family === 6 ? 'ipv6' : null;
    const addr = String(a?.address ?? '').replace(/%.*$/, '');
    if (!fam || net.isIP(addr) !== (fam === 'ipv4' ? 4 : 6)) continue;
    const bits = Number(String(a?.cidr ?? '').split('/')[1]);
    const into = fam === 'ipv4' ? four : six;
    try { into.addAddress(addr, fam); if (Number.isInteger(bits)) into.addSubnet(addr, bits, fam); } catch { /* an odd entry adds nothing */ }
  }
  return { four, six };
}
/**
 * True when `address` is a public unicast address that is not this Mac's own nor on one of its networks (an IPv4-mapped
 * or NAT64 IPv6 address never is: ask for the IPv4 one). `ifaces`: os.networkInterfaces()'s shape, for the tests.
 */
export const publicAddress = (address, { ifaces } = {}) => {
  const a = String(address ?? ''); const f = net.isIP(a);
  if (f !== 4 && f !== 6) return false;
  if (f === 4 ? BLOCKED4.check(a, 'ipv4') : BLOCKED6.check(a, 'ipv6')) return false;
  const own = ownNetworks(ifaces);
  return f === 4 ? !own.four.check(a, 'ipv4') : !own.six.check(a, 'ipv6');
};

/** A host as asked → its lowercase name (one trailing dot dropped), or { deny } with the reason word. */
export function hostOf(raw) {
  const h = String(raw ?? '').toLowerCase().replace(/\.$/, '');
  if (h.includes('@')) return { deny: 'userinfo' };
  if (net.isIP(h.replace(/^\[|\]$/g, '')) !== 0) return { deny: 'ip-literal' };
  if (!HOST.test(h)) return { deny: 'bad-request' };
  return { host: h };
}
/** The log's host field: the name only when it is a plain host name, so nothing else a client sent reaches the log. */
const logHost = (raw) => { const h = String(raw ?? '').toLowerCase().replace(/\.$/, ''); return HOST.test(h) ? h : null; };

/**
 * worker-runner.json's products → { session: [...], install: [...] }: the union over products of phaseHosts for each phase.
 * A product phaseHosts refuses gives nothing (and is named in `refused`): fail closed for it, never a wider list.
 */
export function listsFrom(config) {
  const products = config?.products && typeof config.products === 'object' ? config.products : {};
  const session = new Set(); const install = new Set(); const refused = [];
  for (const [name, p] of Object.entries(products)) {
    const r = p?.render ?? {};
    const args = { product: r.product, rulesHosts: Array.isArray(r.rulesHosts) ? r.rulesHosts : [], registryHosts: Array.isArray(r.registryHosts) ? r.registryHosts : [] };
    const s = phaseHosts({ ...args, phase: 'session' }); const i = phaseHosts({ ...args, phase: 'install' });
    if (!s.ok || !i.ok) { refused.push(name); continue; }
    for (const h of s.hosts) session.add(h);
    for (const h of i.hosts) install.add(h);
  }
  return { session: [...session].sort(), install: [...install].sort(), refused };
}

/** A list read from the config file, read again when the file changes; an unreadable file is an empty list (fail closed). */
export function fileLists(path, { read = (p) => readFileSync(p, 'utf8'), mtime = (p) => statSync(p).mtimeMs } = {}) {
  let seen; let lists = { session: [], install: [], refused: [] };
  return () => {
    let m; try { m = mtime(path); } catch { return { session: [], install: [], refused: [] }; }
    if (m !== seen) { try { lists = listsFrom(JSON.parse(read(path))); seen = m; } catch { lists = { session: [], install: [], refused: [] }; seen = undefined; } }
    return lists;
  };
}

const lookupAll = (host) => new Promise((res, rej) => dns.lookup(host, { all: true, verbatim: true }, (e, a) => (e ? rej(e) : res(a))));
const connectTo = ({ address, port }) => net.connect({ host: address, port });

/**
 * One proxy server. `allowed()` → the list of host names (read at each connection); `log(line)` takes one JSON object.
 * Ports for tests: lookup(host) → [{ address }], connect({ address, port, host }) → a socket, tunnelPorts (TUNNEL_PORTS),
 * httpPorts (HTTP_PORTS).
 */
export function createProxy({ allowed, log, port = 0, lookup = lookupAll, connect = connectTo, tunnelPorts = TUNNEL_PORTS, httpPorts = HTTP_PORTS, maxConnections = MAX_CONNECTIONS,
  maxHead = MAX_HEAD, handshakeMs = HANDSHAKE_MS, idleMs = IDLE_MS, maxBytes = MAX_BYTES }) {
  let open = 0;
  const server = net.createServer((client) => {
    const rec = { host: null, ok: false, why: null, up: 0, down: 0 };
    let logged = false; let upstream = null; let buf = Buffer.alloc(0); let mode = 'start';
    open += 1;
    // The one end of every connection: the client's socket closed. One log line, the upstream taken down with it.
    client.on('close', () => {
      if (logged) return; logged = true; open -= 1; upstream?.destroy();
      try { log({ t: new Date().toISOString(), port, host: rec.host, verdict: rec.ok ? 'allow' : 'deny', ...(rec.ok ? {} : { why: rec.why ?? 'bad-request' }), up: rec.up, down: rec.down }); } catch { /* the log never stops the proxy */ }
    });
    client.on('error', () => client.destroy());
    const kill = (why) => { if (why) { rec.ok = false; rec.why ??= why; } client.destroy(); };
    const stop = () => { mode = 'done'; client.off('data', onData); client.pause(); };
    // A denied client's further bytes are read and dropped (resume): a paused socket never sees the far end close, so it
    // would never end, nor be logged.
    const deny = (why, reply) => { stop(); client.resume(); rec.why = why; if (reply) client.end(reply); else client.end(); };
    if (open > maxConnections) { rec.why = 'too-many'; client.destroy(); return; }
    client.setTimeout(handshakeMs, () => kill('timeout'));
    const R403 = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
    const R400 = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
    const R431 = 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

    // A name and port asked for → checked, then the upstream socket; `after(up)` sends what is owed before both pipe.
    // `ports`: the ports this way may reach. `upward(d, up)`: how a client's bytes go up once connected; by default all of
    // them (a tunnel).
    const reach = async (rawHost, rawPort, ports, refuse, after, upward = (d, up) => up.write(d)) => {
      rec.host = logHost(rawHost);
      const h = hostOf(rawHost); if (h.deny) return deny(h.deny, refuse);
      const p = Number(rawPort); if (!ports.includes(p)) return deny('bad-port', refuse);
      let list; try { list = allowed(); } catch { list = null; }
      if (!Array.isArray(list)) return deny('no-list', refuse);
      if (!list.includes(h.host)) return deny('not-listed', refuse);
      let addrs; try { addrs = await lookup(h.host); } catch { return deny('dns-failed', refuse); }
      if (!Array.isArray(addrs) || !addrs.length || !addrs.every((x) => publicAddress(x?.address))) return deny('not-public', refuse);
      if (client.destroyed) return undefined;
      upstream = connect({ address: addrs[0].address, port: p, host: h.host });
      upstream.on('error', () => kill(rec.ok ? null : 'connect-failed'));
      upstream.on('close', () => client.end());
      upstream.once('connect', () => {
        rec.ok = true; rec.why = null;
        client.setTimeout(idleMs, () => kill(null)); upstream.setTimeout(idleMs, () => kill(null));
        after(upstream);
        client.on('data', (d) => { rec.up += d.length; if (rec.up > maxBytes) kill('too-big'); else upward(d, upstream); });
        upstream.on('data', (d) => { rec.down += d.length; if (rec.down > maxBytes) kill('too-big'); else client.write(d); });
        client.on('end', () => upstream.end());
        client.resume();
      });
      return undefined;
    };

    const http = () => {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0 || end > maxHead) return buf.length > maxHead ? deny('too-big', R431) : undefined;
      stop();
      const head = buf.subarray(0, end).toString('latin1'); const rest = buf.subarray(end + 4);
      // #617 r2 m1: CR and LF only as a pair; no folded line; each field name plain token characters, its colon right after.
      if (/\r(?!\n)|(?<!\r)\n/.test(head)) return deny('bad-request', R400);
      const [line, ...fields] = head.split('\r\n');
      const m = /^([A-Z]{1,16}) (\S+) HTTP\/1\.[01]$/.exec(line);
      if (!m) return deny('bad-request', R400);
      const [, method, target] = m;
      if (method === 'CONNECT') {
        if (target.includes('@')) return deny('userinfo', R403);
        const a = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(target);
        if (!a) return deny('bad-request', R400);
        return reach(a[1].replace(/^\[|\]$/g, ''), a[2], tunnelPorts, R403, (up) => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (rest.length) { rec.up += rest.length; up.write(rest); } });
      }
      // Plain HTTP, absolute form only (http://host[:port]/path): sent on in origin form, as ONE request, the proxy's headers
      // dropped. The upstream reads its Host header, not the URL, so a Host that is not the URL's own is refused (#617 r1
      // M2: a listed name in the URL with another site in Host). One request per connection: its body is Content-Length
      // bytes (no chunked body), and a byte past it (a second, pipelined request) refuses the connection, never sent on.
      if (!/^http:\/\//i.test(target)) return deny('bad-request', R400);
      if (!fields.every((f) => FIELD.test(f))) return deny('bad-request', R400);
      if (/^http:\/\/[^/?#]*@/i.test(target)) return deny('userinfo', R403);
      let u; try { u = new URL(target); } catch { return deny('bad-request', R400); }
      // #617 r3: both sides compared as name (lowercase, one trailing dot dropped) plus port as a number (80 left out), so
      // `allowed.com.` and `:080` match their own URL. URL already gives the port that way; the Host side is made to.
      const urlHost = `${u.hostname.replace(/\.$/, '')}${u.port ? `:${u.port}` : ''}`;
      const sameHost = (raw) => {
        const hp = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(raw.toLowerCase()); if (!hp) return null;
        const hostPort = hp[2] === undefined ? 80 : Number(hp[2]);
        return `${hp[1].replace(/\.$/, '')}${hostPort === 80 ? '' : `:${hostPort}`}`;
      };
      // A name with _ for - counts as that name too (some servers read Transfer_Encoding as Transfer-Encoding).
      const named = (k) => fields.filter((f) => new RegExp(`^${k.replace(/-/g, '[-_]')}:`, 'i').test(f)).map((f) => f.slice(f.indexOf(':') + 1).trim());
      const hosts = named('host');
      if (hosts.length > 1 || (hosts.length === 1 && sameHost(hosts[0]) !== urlHost)) { rec.host = logHost(u.hostname); return deny('host-mismatch', R403); }
      if (named('transfer-encoding').length) return deny('bad-request', R400);
      const lengths = named('content-length');
      if (lengths.length > 1 || (lengths.length === 1 && !/^\d{1,12}$/.test(lengths[0]))) return deny('bad-request', R400);
      let left = lengths.length ? Number(lengths[0]) : 0;
      if (rest.length > left) { rec.host = logHost(u.hostname); return deny('second-request', R400); }
      left -= rest.length;
      // #617 r3: routing headers an upstream (or a front end before it) may obey in place of Host are dropped as well.
      const kept = fields.filter((f) => !DROPPED.test(f));
      const out = Buffer.concat([Buffer.from(`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${[`Host: ${urlHost}`, ...kept, 'Connection: close'].join('\r\n')}\r\n\r\n`, 'latin1'), rest]);
      const oneBody = (d, up) => {
        if (d.length > left) { if (left) up.write(d.subarray(0, left)); left = 0; kill('second-request'); return; }
        left -= d.length; up.write(d);
      };
      return reach(u.hostname.replace(/^\[|\]$/g, ''), u.port || '80', httpPorts, R403, (up) => { rec.up += out.length; up.write(out); }, oneBody);
    };

    // SOCKS5 (RFC 1928): no authentication, CONNECT, a domain name (socks5h) only.
    const fail = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    const hello = () => {
      if (buf.length < 2 || buf.length < 2 + buf[1]) return;
      const methods = buf.subarray(2, 2 + buf[1]); buf = buf.subarray(2 + buf[1]);
      if (!methods.includes(0x00)) { deny('socks-auth', Buffer.from([5, 0xff])); return; }
      client.write(Buffer.from([5, 0])); mode = 'request';
    };
    const request = () => {
      if (buf.length < 5) return undefined;
      if (buf[0] !== 5 || buf[2] !== 0) return deny('bad-request', fail(1));
      if (buf[1] !== 1) return deny('socks-command', fail(7));
      if (buf[3] === 1 || buf[3] === 4) return deny('ip-literal', fail(2));
      if (buf[3] !== 3) return deny('bad-request', fail(8));
      const n = buf[4]; if (buf.length < 7 + n) return undefined;
      const name = buf.subarray(5, 5 + n).toString('latin1'); const p = buf.readUInt16BE(5 + n); const rest = buf.subarray(7 + n);
      stop();
      return reach(name, String(p), tunnelPorts, fail(2), (up) => { client.write(fail(0)); if (rest.length) { rec.up += rest.length; up.write(rest); } });
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (mode === 'start') mode = buf[0] === 0x05 ? 'hello' : 'http';
      if (buf.length > maxHead + 520) return deny('too-big', mode === 'http' ? R431 : undefined);
      if (mode === 'http') return http();
      if (mode === 'hello') hello();
      if (mode === 'request') return request();
      return undefined;
    };
    client.on('data', onData);
  });
  return server;
}

/** Node's own options for the proxy: no debugger started by a signal (as the worker runner's, runner-job.mjs). */
export const PROXY_NODE_FLAGS = Object.freeze(['--disable-sigusr1']);
export const PROXY_UMASK = 0o077;
/**
 * The proxy's launchd job: the builder user (never root), its home, umask 077, started at load and again within a minute
 * of any exit (StartInterval; the process itself does not end), its config the copy's worker-runner.json.
 */
export function builderProxyPlist(cfg) {
  const P = installPaths(cfg); const home = homeOf(cfg, BUILDER);
  const text = loginJobPlist({ label: `${cfg.label}.${BUILDER_PROXY_JOB}`, node: join(P.installRoot, NODE), script: join(P.installRoot, BUILDER_PROXY_SCRIPT),
    configFlag: '--config', config: join(P.installRoot, WORKER_RUNNER_CONFIG), path: JOB_PATH, logDir: P.logDir, workDir: home, home,
    logName: BUILDER_PROXY_JOB, umask: PROXY_UMASK, userName: BUILDER, nodeFlags: PROXY_NODE_FLAGS });
  if (!text.includes(`<key>UserName</key><string>${BUILDER}</string>`)) throw new Error(`loginJobPlist did not write UserName ${BUILDER}: the proxy would run as root`);
  return text;
}

const LSOF = '/usr/sbin/lsof';
/**
 * daemons check's rows for the proxy (wall v2): for each of PROXY_PORTS, a TCP listener on 127.0.0.1 and on [::1], every
 * listener on that port the builder's, and none on any other address. Root only (lsof shows another user's sockets only
 * to root): without it each row is NEEDS ROOT ({ skip }), never a pass nor a FAIL. → [{ ok, what, why?, skip? }].
 */
export function proxyListenRows(io, cfg) {
  const rows = [];
  for (const [phase, port] of Object.entries(PROXY_PORTS)) {
    const what = `the builder proxy listens on 127.0.0.1:${port} and [::1]:${port} (${phase}), as the ${BUILDER} user, and on no other address`;
    if (io.euid?.() !== 0) { rows.push({ ok: true, skip: true, what, why: 'needs root to see the builder user\'s sockets; run daemons check with sudo' }); continue; }
    const b = readUser(io, BUILDER);
    if (!b.exists || !Number.isInteger(b.uid) || b.uid <= 0) { rows.push({ ok: false, what, why: `the ${BUILDER} Mac user was not found` }); continue; }
    const r = io.run(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpun']);
    const out = String(r.stdout ?? '');
    if (r.status !== 0 && !(r.status === 1 && !out.trim())) { rows.push({ ok: false, what, why: `lsof could not list the sockets on port ${port} (exit ${r.status})` }); continue; }
    let who = null; const seen = [];
    for (const l of out.split('\n')) { if (l.startsWith('u')) who = Number(l.slice(1)); else if (l.startsWith('n')) seen.push({ uid: who, name: l.slice(1) }); }
    const want = [`127.0.0.1:${port}`, `[::1]:${port}`];
    const why = [];
    for (const w of want) if (!seen.some((x) => x.name === w)) why.push(`nothing listens on ${w}`);
    const other = seen.filter((x) => x.uid !== b.uid); if (other.length) why.push(`${other.map((x) => `${x.name} (uid ${x.uid})`).join(', ')} is not the ${BUILDER} user's`);
    const wide = seen.filter((x) => !want.includes(x.name)); if (wide.length) why.push(`it also listens on ${wide.map((x) => x.name).join(', ')}`);
    rows.push(why.length ? { ok: false, what, why: `${why.join('; ')}; look in the proxy's error log (${join(installPaths(cfg).logDir, `${BUILDER_PROXY_JOB}.err.log`)}); its connections are in ${BUILDER_PROXY_JOB}.out.log beside it` } : { ok: true, what });
  }
  return rows;
}

/** The proxy's two ports and its lists: the session port takes the session list, the install port the install list. */
export const PORT_LIST = Object.freeze({ [PROXY_PORTS.session]: 'session', [PROXY_PORTS.install]: 'install' });

/** Start every listener; resolves when all listen, rejects on the first that can't. */
export async function serve({ configPath, log = (o) => process.stdout.write(`${JSON.stringify(o)}\n`), hosts = LISTEN_HOSTS, ports = PORT_LIST, lists = fileLists(configPath), ...rest }) {
  const servers = [];
  for (const [port, phase] of Object.entries(ports)) {
    for (const host of hosts) {
      const s = createProxy({ allowed: () => lists()[phase], log, port: Number(port), ...rest });
      await new Promise((res, rej) => { s.once('error', rej); s.listen({ host, port: Number(port), exclusive: true, ipv6Only: host.includes(':') }, res); });
      servers.push(s);
    }
  }
  return servers;
}

export async function main(argv, { getuid = () => process.getuid?.(), start = serve, err = (t) => process.stderr.write(t) } = {}) {
  const i = argv.indexOf('--config'); const configPath = i >= 0 ? argv[i + 1] : null;
  if (!configPath || !configPath.startsWith('/')) { err('usage: node builder-proxy.mjs --config <full path of worker-runner.json>\n'); return 2; }
  if (getuid() === 0) { err('builder-proxy runs as the builder user, never as root (its launchd job sets UserName)\n'); return 2; }
  try { await start({ configPath }); } catch (e) { err(`builder-proxy could not listen: ${e.code ?? e.message}\n`); return 1; }
  return null;   // keeps running
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
// No top-level await at the entry (M4 review-install-closure.test.mjs): a dynamic import that main() makes, whose
// own imports reach back here, would wait on this file while this file waits on main(), and node would exit 13 with
// nothing said. A throw from main exits 1 at once, as an uncaught one did.
if (self === import.meta.url) main(process.argv.slice(2)).then((code) => { if (code !== null) process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });

