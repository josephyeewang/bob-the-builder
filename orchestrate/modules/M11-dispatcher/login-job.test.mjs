import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginJobPlist } from './login-job.mjs';

const OK = { label: 'org.example.dispatcher', node: '/opt/node/bin/node', script: '/srv/orch/dispatcher.mjs', path: '/opt/node/bin:/usr/bin:/bin', logDir: '/srv/orch/logs', workDir: '/srv/orch' };

test('m4: the job runs every 60 s and at load, with an explicit PATH', () => {
  const t = loginJobPlist(OK);
  assert.match(t, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(t, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(t, /<key>PATH<\/key><string>\/opt\/node\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.match(t, /<array><string>\/opt\/node\/bin\/node<\/string><string>\/srv\/orch\/dispatcher\.mjs<\/string><\/array>/);
  assert.match(t, /dispatcher\.err\.log/);
  assert.doesNotMatch(t, /UserName/);
  assert.match(loginJobPlist({ ...OK, userName: 'orchestrate' }), /<key>UserName<\/key><string>orchestrate<\/string>/);
});

test('m4: the file is a valid property list (checked with plutil where it exists)', (t) => {
  const p = join(mkdtempSync(join(tmpdir(), 'm11-plist-')), 'job.plist');
  writeFileSync(p, loginJobPlist({ ...OK, workDir: '/srv/a & b <c>' }));
  const r = spawnSync('plutil', ['-lint', p], { encoding: 'utf8' });
  if (r.error) return t.skip('plutil is not on this machine');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('m4: refuses a bad label, a relative path, a bad PATH or a bad user name', () => {
  assert.throws(() => loginJobPlist({ ...OK, label: '../x' }), /bad job label/);
  assert.throws(() => loginJobPlist({ ...OK, node: 'node' }), /node must be an absolute path/);
  assert.throws(() => loginJobPlist({ ...OK, script: 'a.mjs' }), /script must be/);
  assert.throws(() => loginJobPlist({ ...OK, logDir: undefined }), /logDir must be/);
  assert.throws(() => loginJobPlist({ ...OK, workDir: '/a\nb' }), /workDir must be/);
  assert.throws(() => loginJobPlist({ ...OK, path: '/usr/bin:bin' }), /PATH must be/);
  assert.throws(() => loginJobPlist({ ...OK, path: '' }), /PATH must be/);
  assert.throws(() => loginJobPlist({ ...OK, userName: 'Root User' }), /bad user name/);
});

test('m4: text is escaped', () => {
  assert.match(loginJobPlist({ ...OK, workDir: '/a&b' }), /<string>\/a&amp;b<\/string>/);
});
