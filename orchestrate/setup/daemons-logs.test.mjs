// The log files launchd opens for a job with a UserName (the watch job's first run stopped with exit 78 because the log folder
// is root's and launchd opens them as the job's user). Every job goes through the same path: nothing here names one by hand
// except the two that run as a user today.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT_CONFIG_PATH } from './layout.mjs';
import { parseInstallConfig } from './install.mjs';
import { checkDaemons, jobLogs, jobsFor, planLoad, planPlace, plistTexts } from './daemons.mjs';
import { main } from './setup.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const BASE = '/Library/orch-test';
const RAW = {
  base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: 'com.example.orch-test',
  runnerConfig: '/tmp/x/review.json', extras: [], watch: { repo: 'example-org/example-repo', rulesSha256: 'a'.repeat(64) },
};
const LOGS = `${BASE}/logs`;
const WATCH = [`${LOGS}/watch-only.out.log`, `${LOGS}/watch-only.err.log`];
const RUNNER = [`${LOGS}/review-runner.out.log`, `${LOGS}/review-runner.err.log`];
const ROOT_JOBS = ['review-updater', 'review-account'];
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };

function world() {
  const mac = fakeMac({ euid: 0 });
  const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(RAW)); chmodSync(f, 0o644);
  const s = sink(); assert.equal(main(['users-folders'], { io: mac, out: s.out, err: s.err }), 0, s.lines.join('\n'));
  return { mac, cfg: parseInstallConfig(RAW) };
}
const runAll = (plan) => { assert.deepEqual(plan.problems, []); for (const o of plan.ops) o.run(); return plan.ops.length; };
const logRows = (w, jobs) => checkDaemons(w.mac, w.cfg, jobs).filter((r) => /log files/.test(r.what));
const logOps = (plan) => plan.ops.filter((o) => /\.log/.test(o.text));
const uidOf = (w, user) => Number(w.mac.users.get(user).UniqueID);

test('a job with a UserName has its log files read from the job file; a job with none runs as root and has no user', () => {
  const w = world(); const { plists } = plistTexts(w.mac, w.cfg);
  assert.deepEqual(jobLogs(plists['watch-only']), { user: 'orchestrate', files: WATCH });
  assert.deepEqual(jobLogs(plists['review-runner']), { user: 'review', files: RUNNER });
  for (const job of ROOT_JOBS) assert.equal(jobLogs(plists[job]).user, null, job);
  // The Dispatcher's job file is built elsewhere: the same read must find its user when it runs as a system job.
  const text = loginJobPlist({ label: 'com.example.x', node: '/n', script: '/s', config: '/c', path: '/usr/bin', logDir: '/l', workDir: '/w', userName: 'orchestrate' });
  assert.deepEqual(jobLogs(text), { user: 'orchestrate', files: ['/l/dispatcher.out.log', '/l/dispatcher.err.log'] });
});

test('REAL plutil reads the same user and log paths from each job file as jobLogs does', { skip: process.platform !== 'darwin' }, () => {
  const w = world(); const { plists } = plistTexts(w.mac, w.cfg); const dir = tempDir('orch-logs-plutil-');
  const read = (file, key) => { const r = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  for (const [job, text] of Object.entries(plists)) {
    const file = join(dir, `${job}.plist`); writeFileSync(file, text);
    const logs = jobLogs(text);
    assert.equal(logs.user, read(file, 'UserName'), job);
    assert.deepEqual(logs.files, ['StandardOutPath', 'StandardErrorPath'].map((k) => read(file, k)).filter(Boolean), job);
  }
});

test('place makes each log file of each job with a UserName, that user\'s and 0644; root\'s jobs get none; the check passes; a second place does nothing', () => {
  const w = world();
  runAll(planPlace(w.mac, w.cfg));
  for (const [files, user] of [[WATCH, 'orchestrate'], [RUNNER, 'review']]) for (const f of files) {
    const st = w.mac.lstat(f);
    assert.equal(st.uid, uidOf(w, user), f); assert.equal(st.gid, Number(w.mac.users.get(user).PrimaryGroupID), f); assert.equal(st.mode & 0o7777, 0o644, f);
    assert.equal(readFileSync(w.mac.at(f), 'utf8'), '', f);
  }
  for (const job of ROOT_JOBS) assert.equal(existsSync(w.mac.at(`${LOGS}/${job}.err.log`)), false, job);
  assert.deepEqual(logRows(w, jobsFor(w.cfg)).map((r) => [r.what.replace(/^.*\.(review-runner|watch-only)'s /, '$1 '), r.ok]), [
    ["review-runner log files are review's, 0644, so launchd can open them", true],
    ["watch-only log files are orchestrate's, 0644, so launchd can open them", true],
  ]);
  assert.equal(planPlace(w.mac, w.cfg).ops.length, 0, 'safe to run twice');
});

test('the host as the owner fixed it by hand passes: the watch job\'s two files already its user\'s, with what they hold, and place leaves them alone', () => {
  const w = world();
  mkdirSync(w.mac.at(LOGS), { recursive: true });
  const before = 'a line from the first run\n';
  for (const f of WATCH) { writeFileSync(w.mac.at(f), before); chmodSync(w.mac.at(f), 0o644); w.mac.owners.set(f, { uid: uidOf(w, 'orchestrate'), gid: uidOf(w, 'orchestrate') }); }
  const p = planPlace(w.mac, w.cfg, ['watch-only']);
  assert.deepEqual(logOps(p), [], 'no log step');
  runAll(p);
  for (const f of WATCH) assert.equal(readFileSync(w.mac.at(f), 'utf8'), before, 'what it holds stays');
  assert.deepEqual(logRows(w, ['watch-only']).map((r) => r.ok), [true]);
  // Only the job asked about: the review job's missing files are not this job's check.
  assert.equal(logRows(w, ['watch-only']).length, 1);
});

test('PLANT each way a log file can be wrong: the check FAILs naming it, load refuses, and place repairs what it may', () => {
  const placed = () => { const w = world(); runAll(planPlace(w.mac, w.cfg)); return w; };
  const f = WATCH[1];
  // The wrong owner, as the first run found it: root's. A file that holds something keeps it.
  let w = placed();
  writeFileSync(w.mac.at(f), 'kept\n'); w.mac.owners.set(f, { uid: w.mac.rootUid, gid: 0 });
  let bad = logRows(w, ['watch-only']).filter((r) => !r.ok);
  assert.equal(bad.length, 1); assert.match(bad[0].why, /watch-only\.err\.log belongs to uid \d+, not orchestrate \(\d+\)/);
  assert.match(planLoad(w.mac, w.cfg, ['watch-only']).problems.join(' '), /could not start: .*watch-only\.err\.log belongs to uid/);
  runAll(planPlace(w.mac, w.cfg));
  assert.equal(w.mac.lstat(f).uid, uidOf(w, 'orchestrate')); assert.equal(readFileSync(w.mac.at(f), 'utf8'), 'kept\n');
  assert.deepEqual(logRows(w, ['watch-only']).map((r) => r.ok), [true]);
  // The wrong mode.
  w = placed(); chmodSync(w.mac.at(f), 0o666);
  assert.match(logRows(w, ['watch-only'])[0].why, /has mode 666, want 644/);
  runAll(planPlace(w.mac, w.cfg)); assert.equal(w.mac.lstat(f).mode & 0o7777, 0o644);
  // Missing.
  w = placed(); rmSync(w.mac.at(f));
  assert.match(logRows(w, ['watch-only'])[0].why, /watch-only\.err\.log is missing/);
  assert.match(planLoad(w.mac, w.cfg, ['watch-only']).problems.join(' '), /is missing \(run daemons place first\)/);
  runAll(planPlace(w.mac, w.cfg)); assert.equal(w.mac.lstat(f).uid, uidOf(w, 'orchestrate'));
  // A link is never followed or given away: the place stops and what it points to is unchanged.
  w = placed(); const target = join(w.mac.prefix, 'elsewhere'); writeFileSync(target, 'theirs\n'); rmSync(w.mac.at(f)); symlinkSync(target, w.mac.at(f));
  const before = statSync(target).mode;
  assert.match(logRows(w, ['watch-only'])[0].why, /is not a plain file/);
  const p = planPlace(w.mac, w.cfg);
  assert.match(p.problems.join(' '), /watch-only\.err\.log exists but is not a plain file; nothing was changed/);
  assert.equal(lstatSync(w.mac.at(f)).isSymbolicLink(), true); assert.equal(statSync(target).mode, before);
  // A job's user who is gone: said, not guessed at.
  w = placed(); w.mac.users.delete('review');
  assert.match(logRows(w, ['review-runner'])[0].why, /the user review does not exist/);
  assert.match(planPlace(w.mac, w.cfg).problems.join(' '), /the user review does not exist, so its job's log files can't be made/);
});

test('a dry run makes no log file, and says which it would make', () => {
  const w = world();
  const p = planPlace(w.mac, w.cfg);
  assert.deepEqual(logOps(p).map((o) => o.text), [
    ...RUNNER.map((f) => `make ${f}   (review's, 0644)`), ...WATCH.map((f) => `make ${f}   (orchestrate's, 0644)`),
  ]);
  for (const f of [...RUNNER, ...WATCH]) assert.equal(existsSync(w.mac.at(f)), false, f);
});
