// Part C, runner step 2: the launch wall (runner-launch.mjs), with the real renderer and #320's real check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tempDir } from '../shared/test-tmp.mjs';
import { join } from 'node:path';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { walledLaunchSettings } from './runner-launch.mjs';
import { writeStatus } from './runner-files.mjs';

const PATHS = {
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes',
  deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: ['/w/copy2'] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git',
};
const input = (kind, runner, more = {}) => ({ kind, workerRunner: runner, profile: DESIGN_PROFILES.worker, paths: PATHS, productionFiles: [], proposalOutboxes: ['/w/proposals'],
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], ...more });

function runnerDirs() {
  const d = realpathSync(tempDir('orch-rl-'));
  const runner = { requestsDir: join(d, 'requests'), statusFile: join(d, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d, 'state'));
  return { d, runner };
}

test('L759 step 2: an editing or undo launch gets worker settings that carry the runner wall, checked as real paths', () => {
  const { d, runner } = runnerDirs();
  try {
    for (const kind of ['editing', 'undo']) {
      const r = walledLaunchSettings(input(kind, runner));
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.role, 'worker');
      assert.ok(r.settings[S.sandbox][S.filesystem][S.denyRead].includes(runner.requestsDir), kind);
    }
    // The runner's own paths win over any the caller put in paths.
    const forged = walledLaunchSettings(input('editing', runner, { paths: { ...PATHS, workerRunner: { requestsDir: '/elsewhere/req', statusFile: '/elsewhere/s/status.json' } } }));
    assert.equal(forged.ok, true, forged.reason);
    assert.ok(forged.settings[S.sandbox][S.filesystem][S.denyRead].includes(runner.requestsDir));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L757 / #320 M3: a script launch gets the script role\'s settings with the wall, once the script role has a design profile; any kind not the runner\'s is refused', () => {
  const { d, runner } = runnerDirs();
  try {
    // Lane 2 has added the script profile, so a script launch is walled like a worker's (it was refused before).
    assert.equal(Object.hasOwn(DESIGN_PROFILES, 'script'), true);
    const sr = walledLaunchSettings(input('script', runner, { profile: DESIGN_PROFILES.script }));
    assert.equal(sr.ok, true, sr.reason); assert.equal(sr.role, 'script');
    assert.ok(sr.settings[S.sandbox][S.filesystem][S.denyRead].includes(runner.requestsDir));
    assert.match(walledLaunchSettings(input('script', runner)).reason, /^not walled: profile for script /, 'a worker profile for a script launch');
    // The profile must be the kind's role's (review m4): never another role's tools or mode.
    assert.match(walledLaunchSettings(input('editing', runner, { profile: DESIGN_PROFILES.lead })).reason, /^not walled: profile for worker /);
    assert.match(walledLaunchSettings(input('editing', runner, { profile: undefined })).reason, /^not walled: profile for worker is malformed/);
    assert.match(walledLaunchSettings(input(['editing'], runner)).reason, /does not start/, 'a kind that is not text');
    for (const kind of ['review', 'lead', 'overnight', undefined, 'constructor', '__proto__']) assert.match(walledLaunchSettings(input(kind, runner)).reason, /^not walled: the worker runner does not start/, String(kind));
    assert.match(walledLaunchSettings(input('editing', runner, { paths: undefined })).reason, /no session paths/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L759 step 2: settings without the wall, a linked runner folder or a missing one are refused, never started', () => {
  const { d, runner } = runnerDirs();
  try {
    // A renderer that leaves the wall out (as an older one would) is caught by the check, not trusted.
    const noWall = walledLaunchSettings(input('editing', runner, { render: (x) => { const { workerRunner, ...p } = x.paths; void workerRunner; return { ok: true, settings: { [S.permissions]: { [S.deny]: [] }, [S.sandbox]: { [S.filesystem]: {} } }, p }; } }));
    assert.match(noWall.reason, /^not walled: .*does not deny the tools/);
    assert.match(walledLaunchSettings(input('editing', runner, { realpath: (p) => `/private${p}` })).reason, /^not walled: .*not its real path/);
    assert.match(walledLaunchSettings(input('editing', { ...runner, requestsDir: join(d, 'gone') })).reason, /^not walled: .*is missing/);
    assert.match(walledLaunchSettings(input('editing', null)).reason, /^not walled: /);
    assert.match(walledLaunchSettings(input('editing', runner, { render: () => ({ ok: false, reason: 'bad phase' }) })).reason, /^not walled: the worker settings can't be made \(bad phase\)/);
    assert.match(walledLaunchSettings(input('editing', runner, { check: () => undefined })).reason, /^not walled: the wall check gave no answer/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// #328 r1 M1 (L769): a forged status needs a hard link to status.json made outside the sandbox. Under macOS's own sandbox
// (Seatbelt, which Claude Code's shell sandbox runs on), given the rendered denyWrite list as #320's L751 test does, a
// worker's shell can't make that link, into its outbox or anywhere, nor one beside the status.
test('L769: under macOS\'s sandbox, a worker\'s shell can\'t make a hard link to the runner\'s status; it can in its own outbox', {
  skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') ? 'needs macOS sandbox-exec' : false,
}, () => {
  const { d, runner } = runnerDirs();
  try {
    const outbox = join(d, 'outbox'); mkdirSync(outbox);
    writeStatus(runner.statusFile, '{}\n');
    const r = walledLaunchSettings(input('editing', runner, { paths: { ...PATHS, outbox } }));
    assert.equal(r.ok, true, r.reason);
    const rules = r.settings[S.sandbox][S.filesystem][S.denyWrite].filter((p) => !/[*]/.test(p) && p.startsWith(d)).map((p) => `(deny file-write* (subpath "${p}"))`);
    assert.equal(rules.length, 2, 'the runner folders are on the denyWrite list as plain folders here');
    const profile = `(version 1)(allow default)${rules.join('')}`;
    const ln = (from, to) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/ln', from, to], { encoding: 'utf8' });
    for (const to of [join(outbox, 'status-link.json'), join(d, 'state', 'second-name.json'), join(d, 'elsewhere.json')]) {
      const w = ln(runner.statusFile, to);
      assert.notEqual(w.status, 0, `a link at ${to} was made`);
      assert.equal(existsSync(to), false, `${to} exists`);
    }
    assert.equal(statSync(runner.statusFile).nlink, 1);
    writeFileSync(join(outbox, 'report-1.md'), 'x');
    const ok = ln(join(outbox, 'report-1.md'), join(outbox, 'report-2.md'));
    assert.equal(ok.status, 0, `control: a link inside the outbox failed: ${ok.stderr}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
