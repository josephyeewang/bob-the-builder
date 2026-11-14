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

/**
 * The spawn calls the scan can not read, each looked at by hand (#556 r1): every one is a runner handed its list by its
 * callers, and those lists are read where they are built. A new one fails the test below until it is looked at and added.
 */
const REVIEWED_UNREAD = {
  'modules/M12-sensors/probes/launchd.mjs spawn(…, args)': "runLaunchctl; its one caller, launchdProbe, passes ['print', <domain>/<label>], both checked against fixed patterns",
  'modules/M12-sensors/record-scan.mjs execFileSync(…, args)': "runGitleaks' runner; its one call writes the list out: detect, --no-git, --source <dir> and fixed report flags",
  'modules/M12-sensors/shell-guard/selfcheck.mjs spawnSync(…, argv[1])': "runShell; its one caller passes [-f], -c and a self-check case's command from the guard's own case table",
  'modules/M4-workshop/git/gitleaks.mjs spawn(…, args)': "gitleaks.mjs's run; each call writes its list out (version, git, dir, stdin, and common()'s report flags), read there",
  'modules/M4-workshop/git/safe-git.mjs spawn(…, argv)': "runChild, the git runner; both calls write their list out, and a token goes in GIT_CONFIG_* (the env), never argv",
  'modules/M4-workshop/launcher/hooks-check.mjs execFileSync(…, a)': "checkVersion's runner; its one call is run(claudeBin, [FLAGS.version])",
  'modules/M4-workshop/launcher/review-runner-main.mjs spawnSync(…, args)': "the runner's own probes; each call writes its list out (dseditgroup -o checkmember, ps -U/-p), read there",
  'setup/install.mjs spawnSync(…, c.args)': "spawnUpdater; updaterCommand writes the list out: the script, the config, --first and the seed, all paths",
  'setup/mac.mjs spawnSync(…, args)': "realIo.run: every setup command goes through it, and each list is read at its io.run call",
};

test('R-0b-179 (b): no module outside the tests puts a credential on a command line, and every list the scan can not read has been looked at', () => {
  const files = sources(ROOT);
  assert.ok(files.length > 100, `only ${files.length} modules were found to read`);
  const found = []; const unread = [];
  for (const f of files) {
    for (const x of credentialArgFindings(readFileSync(f, 'utf8'))) {
      if (x.kind === 'unread') unread.push(`${relative(ROOT, f)} ${x.what}`);
      else found.push(`${relative(ROOT, f)}:${x.line} ${x.kind} ${x.what}: ${x.list}`);
    }
  }
  assert.deepEqual(found, [], `pass a credential in the child's environment, a file it reads, or its stdin, never its arguments:\n${found.join('\n')}`);
  assert.deepEqual(unread.filter((u) => !REVIEWED_UNREAD[u]), [], 'a spawn call whose list the scan can not read: look at what reaches it, then add it to REVIEWED_UNREAD with why it is safe');
  assert.deepEqual(Object.keys(REVIEWED_UNREAD).filter((u) => !unread.includes(u)), [], 'a reviewed entry no longer met: take it out');
});

test('R-0b-179 (b): a planted credential flag, value, header or URL is caught, however the argument list is written', () => {
  const caught = {
    "spawnSync('/usr/bin/gh', ['api', '--token', t]);": 'flag:--token',
    'spawn(bin, [`--password=${pw}`]);': 'flag:--password',
    "const args = ['--api-key', key];\nspawn(bin, args);": 'flag:--api-key',
    "execFileSync(node, ['run.mjs', token]);": 'value:token',
    "io.run('/bin/x', ['--repo', cfg.watch.repo, cfg.watch.token]);": 'value:cfg.watch.token',
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

test('R-0b-179 (b, #556 r1 M3, M4, m10/11): the auditor\'s plants: lists built by push or under any name, scripts in strings, more names and flags', () => {
  const caught = {
    'via a variable named cmd': "const cmd = ['gh', '--token', t];\nspawn(cmd[0], cmd.slice(1));",
    'a spread with a token': 'spawn(bin, [...base, token]);',
    'a spread of a token-named list': 'spawn(bin, [...tokenArgs]);',
    'XML ProgramArguments': '<key>ProgramArguments</key><array><string>/x</string><string>--password</string><string>p</string></array>',
    'args.push(token) after a literal (M3)': "const args = ['x'];\nargs.push(token);\nspawn(bin, args);",
    "args.push('--token', t) (M3)": "const args = ['x'];\nargs.push('--token', t);\nspawn(bin, args);",
    'args.unshift / concat / splice (M3)': "const args = ['x'];\nargs.unshift(apiKey);\nspawn(bin, args.concat([secret]));\nargs.splice(1, 0, password);",
    'an index bracket before the list': "io.run(cmds[0], ['--token', t]);",
    'a flag inside an sh -c script (M4)': "spawn('/bin/sh', ['-c', `gh api --token ${t} /user`]);",
    'env NAME=${…} (M4)': "spawn('/usr/bin/env', [`GH_TOKEN=${t}`, 'gh', 'api']);",
    'the name tok': "spawn(bin, ['--repo', r, tok]);",
    'the name pw': "spawn(bin, ['-u', user, pw]);",
    'the name key': "spawn(bin, ['--key', key]);",
    'the flag --auth': "spawn(bin, ['--auth', a]);",
    'the flag --pass': "spawn(bin, ['--pass', p]);",
    '-p${pw}': 'spawn(bin, [`-p${pw}`]);',
    'curl -u user:${pw}': "spawn('/usr/bin/curl', ['-u', `${u}:${pw}`, url]);",
    'Bearer ${t}': "spawn('/usr/bin/curl', ['-H', `Bearer ${t}`, url]);",
    'a credential helper that echoes a password': "git(['-c', `credential.helper=!f() { echo password=${p}; }; f`, 'push']);",
    'execSync with a shell string': 'execSync(`gh api --token ${token}`);',
    'a promisify alias': "const pexec = promisify(execFile);\nawait pexec(bin, ['--token', t]);",
    'cp.spawn': "cp.spawn(bin, ['--token', t]);",
    'args reassigned (no const)': "let a; args = ['--token', t];\nspawn(bin, args);",
    'a sessionArgs-style push (M3)': "export function sessionArgs({ prompt, apiKey }) {\n  const args = ['-p'];\n  args.push(apiKey);\n  return args;\n}",
    'an object property': "spawn(bin, ['--x', secrets.github]);",
    'an optional chain': "spawn(bin, ['--x', cfg?.watch?.token]);",
    "cfg['token']": "spawn(bin, ['--x', cfg['token']]);",
    "'--token=' + t": "spawn(bin, ['--token=' + t]);",
    'a launchd job script in a string (M4)': "const script = ['set -u', `/usr/bin/curl --token ${cfg.secret} https://x`].join('\\n');",
  };
  for (const [name, src] of Object.entries(caught)) assert.ok(said(src).length > 0, `${name}: missed: ${JSON.stringify(src)}`);
  // Each way of reading, pinned by a plant only it catches.
  const only = {
    'an index is not the list': ["io.run(cmds[0], ['x', token]);", 'value:token'],
    'a promisify alias is a call': ["const pexec = promisify(execFile);\nawait pexec(bin, ['x', token]);", 'value:token'],
    'a name handed to spawn is a list': ["const opts = ['x'];\nopts.push(token);\nspawn(bin, opts);", 'value:token'],
    '-u then user:${…}': ["spawn('/usr/bin/curl', ['-u', `${user}:${p}`, url]);", 'text:a user:password pair after -u'],
    'a regex with a quote does not put the rest out of step': ["const q = s.replace(/'/g, 'x');\nconst r = io.run(bin, ['x', token]);", 'value:token'],
    'a regex holding /* is not a comment that hides the rest': ["const star = /a\\/*/;\nconst r = io.run(bin, ['x', token]);", 'value:token'],
    'a regex ending in // is not a line comment': ["const u = s.replace(/^https:\\/\\//, ''); io.run(bin, ['x', token]);", 'value:token'],
  };
  for (const [name, [src, want]] of Object.entries(only)) assert.ok(said(src).includes(want), `${name}: ${JSON.stringify(said(src))}`);
  // A list the scan can not read is listed, never passed in silence.
  assert.deepEqual(said('spawn(bin, makeList(cfg));'), ['unread:spawn(…, makeList(cfg))']);
  assert.deepEqual(said("const args = ['a'];\nspawn(bin, args);"), []);
});

test('R-0b-179 (b): the safe ways pass: the environment, a file, a kind or a name, a count, a switch, and an options object after the list', () => {
  for (const src of [
    "spawnSync(bin, ['push'], { env: { GH_TOKEN: token } });",
    "const r = await git(['push', url], { gitDir, extraConfig: tokenConfig(token) });",
    "arr([node, run, '--token-file', tokenPath(cfg), '--app-key-file', keyFile])",
    "spawn(bin, ['--kind', secretKind, tokenFile]);",
    "spawnSync('/bin/ls', ['-la', dir]);",
    "spawnSync(bin, ['--note', 'the token is in the environment']);",
    '// spawn(bin, [token]) in a comment',
    // #556 r1 m10: what the r1 scan refused wrongly.
    "spawn(claude, ['--max-tokens', '1000']);",
    "spawn(claude, ['--limit', String(maxTokens)]);",
    "spawn(bin, ['--n', tokens]);",
    "spawn(bin, ['--deny', secretsDir]);",
    "spawn(bin, ['--no-token']);",
    "spawn('/usr/bin/curl', ['-c', cookieJar, url]);",
    'git([\'-c\', `credential.helper=${credentialHelper}`]);',
    "spawn(gitleaks, ['--redact', '--secret-scan']);",
    "spawn('/bin/cat', ['/etc/passwd']);",
    "spawn(bin, ['--tokenizer', 'cl100k']);",
    "spawn('/usr/bin/security', ['find-generic-password', '-s', service, '-w']);",
    "git(['push', 'https://github.com:443/o/r.git']);",
    "git(['push', 'ssh://git@github.com/o/r.git']);",
    "spawn(bin, ['http://localhost:8080@x']);",
    'const marker = `<!-- orch:alert v1 key=${key} status=${s} -->`;',
    "spawn(bin, ['--deny', cfg?.secrets?.dir, cfg['secrets'].dir]);",
    "spawn(bin, ['--dry', String(hasSecret), String(noToken)]);",
  ]) assert.deepEqual(said(src), [], src);
});

test('R-0b-179 (b): the real job builders are read: a token planted in the watch job, the push, a claude call, its session argv, or the wall\'s job script is caught', () => {
  const plant = (rel, from, to) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(src.includes(from), `${rel} no longer holds ${from}; move this plant to where its arguments are built now`);
    assert.deepEqual(said(src).filter((x) => !x.startsWith('unread:')), [], rel);
    return said(src.replace(from, to)).filter((x) => !x.startsWith('unread:'));
  };
  assert.deepEqual(plant('setup/watch-setup.mjs', "'--token-file'", "'--token'"), ['flag:--token']);
  assert.deepEqual(plant('modules/M4-workshop/git/push.mjs', "run(['push', '--porcelain'", "run(['push', token, '--porcelain'"), ['value:token']);
  assert.deepEqual(plant('modules/M4-workshop/launcher/accounts.mjs', "['auth', 'status', '--json']", "['auth', 'status', '--json', apiKey]"), ['value:apiKey']);
  // #556 r1 M3: every claude launch's argv is built by push in sessionArgs.
  const session = 'modules/M4-workshop/launcher/review-launch.mjs';
  assert.deepEqual(plant(session, '  args.push(prompt);\n  return args;', '  args.push(prompt);\n  args.push(apiKey);\n  return args;'), ['value:apiKey']);
  assert.deepEqual(plant(session, '  args.push(prompt);\n  return args;', "  args.push('--api-key', key);\n  args.push(prompt);\n  return args;"), ['flag:--api-key', 'value:key']);
  // #556 r1 M4: the wall's own job script is a string.
  assert.deepEqual(plant('setup/builder-wall.mjs', "    'set -u',", "    'set -u',\n    `/usr/bin/curl --token ${cfg.secret} https://x`,"), ['flag:--token']);
  assert.deepEqual(plant('setup/builder-wall.mjs', "    'set -u',", "    'set -u',\n    `GH_TOKEN=${cfg.watchToken} /usr/bin/true`,"), ['text:GH_TOKEN=${…} (a credential set in a command)']);
});
