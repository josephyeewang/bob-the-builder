// Part C, runner step 2: the launch wall (runner-launch.mjs), with the real renderer and #320's real check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { walledLaunchSettings } from './runner-launch.mjs';

const PATHS = {
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes',
  deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: ['/w/copy2'] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git',
};
const input = (kind, runner, more = {}) => ({ kind, workerRunner: runner, profile: DESIGN_PROFILES.worker, paths: PATHS, productionFiles: [], proposalOutboxes: ['/w/proposals'],
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], ...more });

function runnerDirs() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orch-rl-')));
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

test('L757 / #320 M3: a script launch is refused until the script role has a design profile; any kind not the runner\'s is refused', () => {
  const { d, runner } = runnerDirs();
  try {
    assert.equal(Object.hasOwn(DESIGN_PROFILES, 'script'), false, 'when lane 2 adds a script profile, this test changes to expect the wall');
    assert.match(walledLaunchSettings(input('script', runner)).reason, /^not walled: no such role "script"/);
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
