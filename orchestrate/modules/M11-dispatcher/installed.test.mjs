// L31 (1): the Dispatcher tested as installed. The login job file is built with loginJobPlist, the
// Dispatcher is reached through a linked folder, and the test runs exactly the command line,
// environment and working folder the job file names: nothing is passed by hand.
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginJobPlist } from './login-job.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const strings = (xml) => [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unesc(m[1]));
const after = (xml, key) => xml.split(`<key>${key}</key>`)[1];

test('L31: one pass runs from the login job file as installed, through a linked folder, and writes its diary line', () => {
  const root = tempDir('m11-installed-');
  const install = join(root, 'install');
  mkdirSync(install);
  symlinkSync(HERE, join(install, 'dispatcher'));
  const logDir = join(root, 'logs'); mkdirSync(logDir);
  const diary = join(root, 'diary.json');
  const wiring = join(root, 'wiring.mjs');
  writeFileSync(wiring, `import { writeFileSync } from 'node:fs';
import { recWith, rulesWith } from ${JSON.stringify(join(install, 'dispatcher', 'fixtures.test-helper.mjs'))};
const rec = recWith();
process.on('exit', () => writeFileSync(${JSON.stringify(diary)}, JSON.stringify(rec.diary())));
export async function wire() {
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: () => {}, board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, startReviewer: async () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(root)}, sealRoot: ${JSON.stringify(root)}, mirrorFor: () => null } } };
}
`);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile: join(root, 'pass.lock') }));
  const xml = loginJobPlist({ label: 'org.example.dispatcher', node: process.execPath, script: join(install, 'dispatcher', 'main.mjs'), config,
    path: `${dirname(process.execPath)}:/usr/bin:/bin`, logDir, workDir: root });
  // Read the job back the way launchd does: its arguments, its one variable, its folder.
  const argv = strings(after(xml, 'ProgramArguments').split('</array>')[0]);
  const env = Object.fromEntries([...after(xml, 'EnvironmentVariables').split('</dict>')[0].matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)].map((m) => [m[1], unesc(m[2])]));
  const cwd = strings(after(xml, 'WorkingDirectory'))[0];
  assert.equal(argv.length, 3, 'node, the script and the config');
  assert.deepEqual(Object.keys(env), ['PATH']);
  const r = spawnSync(argv[0], argv.slice(1), { env, cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'nothing in the error log');
  assert.ok(existsSync(diary), 'the wiring ran');
  const lines = JSON.parse(readFileSync(diary, 'utf8'));
  assert.ok(lines.some((l) => l.kind === 'full_pass'), 'the pass wrote its diary line');
  // Control: the job's command without its config stops at once, which is why the job file carries it.
  const bare = spawnSync(argv[0], [argv[1]], { env, cwd, encoding: 'utf8' });
  assert.equal(bare.status, 1);
});
