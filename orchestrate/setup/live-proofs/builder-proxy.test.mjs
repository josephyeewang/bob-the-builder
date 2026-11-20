// The builder proxy's live proof, with a stand-in curl: what it runs, as whom, and how it judges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROXY_PORTS } from '../../shared/builder-ports.mjs';
import { judge, main } from './builder-proxy.mjs';

const CFG = JSON.stringify({ products: { a: { render: { product: { hosts: ['github.com'] }, rulesHosts: ['github.com'], registryHosts: ['registry.npmjs.org'] } } } });
const go = (argv, { euid = 0, answers = {} } = {}) => {
  let out = ''; const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); const url = args.at(-1); const proxy = args[args.indexOf('--proxy') + 1]; return answers[`${proxy} ${url}`] ?? { status: 0, stdout: '200 301', stderr: '' }; };
  const code = main(argv, { print: (t) => { out += t; }, deps: { euid: () => euid, read: () => CFG, run } });
  return { code, out, calls };
};

test('it runs curl as the builder through the session port, never anything else; (c) is NOT DONE until the builder can sign in', () => {
  const p = PROXY_PORTS.session;
  const denied = { status: 56, stdout: '403 000', stderr: 'CONNECT tunnel failed, response 403' };
  const socksDenied = { status: 97, stdout: '000 000', stderr: 'SOCKS5 failed' };
  const r = go(['--config', '/i/worker-runner.json'], { answers: { [`http://127.0.0.1:${p} https://example.com/`]: denied, [`socks5h://127.0.0.1:${p} https://example.com/`]: socksDenied } });
  assert.equal(r.calls.length, 4);
  for (const c of r.calls) {
    assert.deepEqual(c.slice(0, 5), ['/usr/bin/sudo', '-n', '-H', '-u', 'builder']);
    assert.equal(c[5], '/usr/bin/curl');
    assert.match(c[c.indexOf('--proxy') + 1], new RegExp(`^(http|socks5h)://(127\\.0\\.0\\.1|\\[::1\\]):${p}$`));
  }
  assert.match(r.out, /^PASS\s+\(a\) github\.com through the proxy \(HTTP CONNECT\)/m);
  assert.match(r.out, /^PASS\s+\(b\) example\.com refused by the proxy \(SOCKS5\)/m);
  assert.match(r.out, /^NOT DONE\s+\(c\) .*PR #616/m);
  assert.equal(r.code, 1); assert.match(r.out.trimEnd().split('\n').at(-1), /^NOT DONE: \(c\) NOT DONE$/);
});

test('a denied host that is reached is a FAIL; refusals that are not the proxy\'s are NOT TRIED', () => {
  assert.equal(judge('denied-http', { status: 0, stdout: '200 200' }).result, 'FAIL');
  assert.equal(judge('denied-socks', { status: 0, stdout: '000 200' }).result, 'FAIL');
  assert.equal(judge('denied-http', { status: 6, stdout: '000 000' }).result, 'NOT TRIED');
  assert.equal(judge('allowed-http', { status: 56, stdout: '403 000' }).result, 'FAIL');
  assert.equal(judge('allowed-socks', { status: 0, stdout: '000 404' }).result, 'PASS', 'any HTTP answer: the host was reached');
});

test('nothing runs without root, a config, an allowed host on the list, or a denied host on no list', () => {
  for (const [argv, opts, why] of [
    [[], {}, /--config/], [['--config', '/i/w.json'], { euid: 501 }, /sudo/],
    [['--config', '/i/w.json', '--allowed', 'example.org'], {}, /not on the session list/],
    [['--config', '/i/w.json', '--denied', 'registry.npmjs.org'], {}, /on no list/],
    [['--config', '/i/w.json', '--denied', '1.2.3.4'], {}, /on no list/],
  ]) { const r = go(argv, opts); assert.equal(r.code, 1); assert.equal(r.calls.length, 0); assert.match(r.out, why); }
});

test('L1318: no product allows an outside site: (a) is NOT APPLICABLE, (b) still runs, nothing is refused for it', () => {
  const none = JSON.stringify({ products: { t: { render: { rulesHosts: [] } } } });
  let out = ''; const calls = [];
  const run = (cmd, args) => { calls.push(args); return { status: 56, stdout: args.includes('-w') && args[args.indexOf('--proxy') + 1].startsWith('http:') ? '403 000' : '000 000', stderr: '' }; };
  const code = main(['--config', '/i/w.json'], { print: (t) => { out += t; }, deps: { euid: () => 0, read: () => none, run } });
  assert.equal(calls.length, 2, 'only the two denied cases');
  assert.match(out, /NOT APPLICABLE \(a\)/); assert.match(out, /PASS {6}\(b\).*HTTP CONNECT/); assert.match(out, /NOT DONE: \(c\) NOT DONE\n$/);
  assert.equal(code, 1);
});
