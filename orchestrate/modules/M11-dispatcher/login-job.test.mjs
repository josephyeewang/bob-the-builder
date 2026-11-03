import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginJobPlist } from './login-job.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const OK = { label: 'org.example.dispatcher', node: '/opt/node/bin/node', script: '/srv/orch/dispatcher.mjs', config: '/srv/orch/config.json', path: '/opt/node/bin:/usr/bin:/bin', logDir: '/srv/orch/logs', workDir: '/srv/orch' };

test('m4: the job runs every 60 s and at load, with an explicit PATH', () => {
  const t = loginJobPlist(OK);
  assert.match(t, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(t, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(t, /<key>PATH<\/key><string>\/opt\/node\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.match(t, /<array><string>\/opt\/node\/bin\/node<\/string><string>\/srv\/orch\/dispatcher\.mjs<\/string><string>\/srv\/orch\/config\.json<\/string><\/array>/);
  assert.match(t, /dispatcher\.err\.log/);
  assert.doesNotMatch(t, /UserName/);
  assert.match(loginJobPlist({ ...OK, userName: 'orchestrate' }), /<key>UserName<\/key><string>orchestrate<\/string>/);
});

test('m4: the file is a valid property list (checked with plutil where it exists)', (t) => {
  const p = join(tempDir('m11-plist-'), 'job.plist');
  writeFileSync(p, loginJobPlist({ ...OK, workDir: '/srv/a & b <c>' }));
  const r = spawnSync('plutil', ['-lint', p], { encoding: 'utf8' });
  if (r.error) return t.skip('plutil is not on this machine');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('m4: refuses a bad label, a relative path, a bad PATH or a bad user name', () => {
  assert.throws(() => loginJobPlist({ ...OK, label: '../x' }), /bad job label/);
  assert.throws(() => loginJobPlist({ ...OK, node: 'node' }), /node must be an absolute path/);
  assert.throws(() => loginJobPlist({ ...OK, script: 'a.mjs' }), /script must be/);
  assert.throws(() => loginJobPlist({ ...OK, config: undefined }), /config must be/, 'audit 0b-6 r2 MAT-1: no config, no job');
  assert.throws(() => loginJobPlist({ ...OK, logDir: undefined }), /logDir must be/);
  assert.throws(() => loginJobPlist({ ...OK, workDir: '/a\nb' }), /workDir must be/);
  assert.throws(() => loginJobPlist({ ...OK, path: '/usr/bin:bin' }), /PATH must be/);
  assert.throws(() => loginJobPlist({ ...OK, path: '' }), /PATH must be/);
  assert.throws(() => loginJobPlist({ ...OK, userName: 'Root User' }), /bad user name/);
});

test('L246: logName names both logs; left out, they are the Dispatcher\'s; a name that could leave logDir is refused', () => {
  const logs = (t) => [...t.matchAll(/<key>Standard(?:Out|Error)Path<\/key><string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(logs(loginJobPlist(OK)), ['/srv/orch/logs/dispatcher.out.log', '/srv/orch/logs/dispatcher.err.log']);
  assert.deepEqual(logs(loginJobPlist({ ...OK, logName: 'sensors' })), ['/srv/orch/logs/sensors.out.log', '/srv/orch/logs/sensors.err.log']);
  assert.equal(loginJobPlist({ ...OK, logName: 'sensors' }).replace(/sensors/g, 'dispatcher'), loginJobPlist(OK), 'only the two log names change');
  for (const logName of ['', '../x', 'a/b', '.hidden', '-x', 'a b', 'a.log', 'x'.repeat(65), null, 7]) {
    assert.throws(() => loginJobPlist({ ...OK, logName }), /bad log name/, `logName ${JSON.stringify(logName)}`);
  }
});

test('m4: text is escaped', () => {
  assert.match(loginJobPlist({ ...OK, workDir: '/a&b' }), /<string>\/a&amp;b<\/string>/);
});
