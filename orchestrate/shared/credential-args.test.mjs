// R-0b-179 (b), L1148 F6: no module puts a credential on a command line (credential-args.mjs says why and what it reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialArgFindings } from './credential-args.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (statSync(f).isDirectory()) sources(f, out);
    else if (n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !n.endsWith('.test-helper.mjs')) out.push(f);
  }
  return out;
}
const said = (src) => credentialArgFindings(src).map((x) => `${x.kind}:${x.what}`);

test('R-0b-179 (b): no module outside the tests puts a credential on a command line', () => {
  const files = sources(ROOT);
  assert.ok(files.length > 100, `only ${files.length} modules were found to read`);
  const found = [];
  for (const f of files) for (const x of credentialArgFindings(readFileSync(f, 'utf8'))) found.push(`${relative(ROOT, f)}:${x.line} ${x.kind} ${x.what}: ${x.list}`);
  assert.deepEqual(found, [], `pass a credential in the child's environment, a file it reads, or its stdin, never its arguments:\n${found.join('\n')}`);
});

test('R-0b-179 (b): a planted credential flag, value, header or URL is caught, however the argument list is written', () => {
  const caught = {
    "spawnSync('/usr/bin/gh', ['api', '--token', t]);": 'flag:--token',
    'spawn(bin, [`--password=${pw}`]);': 'flag:--password',
    "const args = ['--api-key', key];\nspawn(bin, args);": 'flag:--api-key',
    "execFileSync(node, ['run.mjs', token]);": 'value:token',
    "io.run('/bin/x', ['--repo', cfg.watch.repo, cfg.watch.token]);": 'value:token',
    "spawnSync(bin, [\n  'a',\n  appKey,\n], { env });": 'value:appKey',
    "const p = await run(['push', secret, url], { gitDir });": 'value:secret',
    "await git(['-c', `http.extraHeader=Authorization: Basic ${b}`, 'push'], { gitDir });": 'text:an Authorization header',
    "await gitOk(['push', `https://u:${pw}@example.com/o/r.git`]);": 'text:a URL with a password in it',
    "await gitOk(['push', `https://x-access-token:${tok}@github.com/o/r.git`]);": 'text:x-access-token: (a token in a URL or header)',
    "`<key>ProgramArguments</key>${arr([node, run, '--secret', s])}`": 'flag:--secret',
    '<key>ProgramArguments</key>\n<array>\n<string>/x</string>\n<string>--token</string>\n<string>abc</string>\n</array>': 'flag:--token',
  };
  for (const [src, want] of Object.entries(caught)) assert.ok(said(src).includes(want), `${JSON.stringify(src)} → ${JSON.stringify(said(src))}`);
  // One finding per line and kind, though a job file's arr([...]) is met twice (as a call and after ProgramArguments).
  assert.deepEqual(said("`<key>ProgramArguments</key>${arr([node, run, '--secret', s])}`"), ['flag:--secret']);
});

test('R-0b-179 (b): the safe ways pass: the environment, a file, a kind or a name, and an options object after the list', () => {
  for (const src of [
    "spawnSync(bin, ['push'], { env: { GH_TOKEN: token } });",
    "const r = await git(['push', url], { gitDir, extraConfig: tokenConfig(token) });",
    "arr([node, run, '--token-file', tokenPath(cfg), '--app-key-file', keyFile])",
    "spawn(bin, ['--kind', secretKind, tokenFile]);",
    "spawnSync('/bin/ls', ['-la', dir]);",
    "spawnSync(bin, ['--note', 'the token is in the environment']);",
    '// spawn(bin, [token]) in a comment',
  ]) assert.deepEqual(said(src), [], src);
});

test('R-0b-179 (b): the real job builders are read: a token planted in the watch job, the push, or a claude call is caught', () => {
  const plant = (rel, from, to) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(src.includes(from), `${rel} no longer holds ${from}; move this plant to where its arguments are built now`);
    assert.deepEqual(said(src), [], rel);
    return said(src.replace(from, to));
  };
  assert.deepEqual(plant('setup/watch-setup.mjs', "'--token-file'", "'--token'"), ['flag:--token']);
  assert.deepEqual(plant('modules/M4-workshop/git/push.mjs', "run(['push', '--porcelain'", "run(['push', token, '--porcelain'"), ['value:token']);
  assert.deepEqual(plant('modules/M4-workshop/launcher/accounts.mjs', "['auth', 'status', '--json']", "['auth', 'status', '--json', apiKey]"), ['value:apiKey']);
});
