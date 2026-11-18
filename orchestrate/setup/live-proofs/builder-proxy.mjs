#!/usr/bin/env node
// Live proof (builder wall v2): the builder's allow-list proxy, as the builder user, on the Mini. Joe runs it as root
// after the proxy's job is loaded (setup/README.md, "The builder wall"); a session here may not use sudo. Each case
// runs curl as the builder through the proxy's session port, so the traffic leaves from the builder's own socket, as a
// builder session's shell does. One PASS / FAIL / NOT TRIED / NOT DONE line per case:
//   (a) a host on the session list is reached through the proxy, by HTTP CONNECT and by SOCKS5 (socks5h: the proxy
//       resolves the name);
//   (b) a host on no list is refused by the proxy: CONNECT answered 403, SOCKS5 refused;
//   (c) going direct from a builder session's sandboxed Bash fails. NOT DONE in this version: it needs a claude
//       session signed in as the builder (the builder sign-in token, PR #616). Outside claude's sandbox the builder
//       can reach the internet directly (the wall covers loopback only), so curl without the proxy here would prove
//       nothing; it is not faked.
//
// sudo node builder-proxy.mjs --config <installRoot>/worker-runner.json [--allowed <host>] [--denied <host>]
// --allowed defaults to the first host on the session list; --denied to example.com, and must be on no list.
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PROXY_PORTS } from '../../shared/builder-ports.mjs';
import { listsFrom } from '../builder-proxy.mjs';
import { BUILDER } from '../layout.mjs';
import { HOST } from '../../modules/M4-workshop/launcher/render-settings.mjs';

const SUDO = '/usr/bin/sudo';
const CURL = '/usr/bin/curl';

/** curl as the builder through the session port. → { status, out, err } */
const asBuilder = (run, proxy, url) => run(SUDO, ['-n', '-H', '-u', BUILDER, CURL, '-sS', '-o', '/dev/null', '-w', '%{http_connect} %{http_code}', '--max-time', '20', '--proxy', proxy, url]);

/** Each case's verdict from curl's answer. */
export function judge(kind, r) {
  const [connect, code] = String(r?.stdout ?? '').trim().split(/\s+/);
  const said = `curl exit ${r?.status}, CONNECT ${connect ?? '-'}, HTTP ${code ?? '-'}`;
  if (kind === 'allowed-http') return r.status === 0 && connect === '200' && /^[1-5]\d\d$/.test(code ?? '') ? { result: 'PASS', why: said } : { result: 'FAIL', why: said };
  if (kind === 'allowed-socks') return r.status === 0 && /^[1-5]\d\d$/.test(code ?? '') ? { result: 'PASS', why: said } : { result: 'FAIL', why: said };
  if (kind === 'denied-http') return r.status !== 0 && connect === '403' ? { result: 'PASS', why: said } : r.status === 0 ? { result: 'FAIL', why: `reached: ${said}` } : { result: 'NOT TRIED', why: `refused, but not by the proxy's 403: ${said}` };
  if (kind === 'denied-socks') return r.status !== 0 && /^0*$/.test(code ?? '0') ? { result: 'PASS', why: said } : { result: 'FAIL', why: `reached: ${said}` };
  throw new Error(`no such case ${kind}`);
}

const REAL = { euid: () => process.geteuid?.(), read: (p) => readFileSync(p, 'utf8'), run: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; } };

export function main(argv, { print = (t) => process.stdout.write(t), deps = REAL } = {}) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const config = arg('--config');
  if (!config || !config.startsWith('/')) { print('NOT DONE: give --config <full path of the installed worker-runner.json>; nothing was run\n'); return 1; }
  if (deps.euid() !== 0) { print(`NOT DONE: run with sudo (curl runs as the ${BUILDER} user); nothing was run\n`); return 1; }
  let lists; try { lists = listsFrom(JSON.parse(deps.read(config))); } catch (e) { print(`NOT DONE: ${config} can't be read (${e.code ?? e.message}); nothing was run\n`); return 1; }
  const allowed = arg('--allowed') ?? lists.session[0];
  const denied = arg('--denied') ?? 'example.com';
  if (!allowed || !lists.session.includes(allowed)) { print(`NOT DONE: ${allowed ? `${allowed} is not on the session list` : 'the session list is empty'} (${lists.session.join(', ') || 'none'}); nothing was run\n`); return 1; }
  if (!HOST.test(denied) || lists.session.includes(denied) || lists.install.includes(denied)) { print(`NOT DONE: --denied ${denied} must be a host name on no list; nothing was run\n`); return 1; }
  const p = PROXY_PORTS.session;
  const cases = [
    ['a', 'allowed-http', `${allowed} through the proxy (HTTP CONNECT)`, `http://127.0.0.1:${p}`, `https://${allowed}/`],
    ['a', 'allowed-socks', `${allowed} through the proxy (SOCKS5)`, `socks5h://[::1]:${p}`, `https://${allowed}/`],
    ['b', 'denied-http', `${denied} refused by the proxy (HTTP CONNECT)`, `http://127.0.0.1:${p}`, `https://${denied}/`],
    ['b', 'denied-socks', `${denied} refused by the proxy (SOCKS5)`, `socks5h://127.0.0.1:${p}`, `https://${denied}/`],
  ];
  const lines = cases.map(([id, kind, what, proxy, url]) => ({ id, what, ...judge(kind, asBuilder(deps.run, proxy, url)) }));
  lines.push({ id: 'c', what: 'going direct from a builder session\'s sandboxed Bash fails', result: 'NOT DONE', why: 'needs a claude session signed in as the builder (PR #616\'s builder sign-in); not faked' });
  for (const l of lines) print(`${l.result.padEnd(9)} (${l.id}) ${l.what}: ${l.why}\n`);
  const pass = lines.every((l) => l.result === 'PASS');
  print(pass ? 'PASS\n' : `NOT DONE: ${lines.filter((l) => l.result !== 'PASS').map((l) => `(${l.id}) ${l.result}`).join(', ')}\n`);
  return pass ? 0 : 1;
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (self === import.meta.url) process.exitCode = main(process.argv.slice(2));
