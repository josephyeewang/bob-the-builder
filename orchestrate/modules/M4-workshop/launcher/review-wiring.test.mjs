// R-0b-163: the review runner's wiring. It makes the copy and the settings, then every session goes through the
// launcher's own launch() (L83 M-3); claude is spawned only after every check passed. The ports themselves and the
// spawn arguments are tested in review-launch.test.mjs; L66's live wall proof is review-walls-proof.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as wiring from './review-wiring.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { renderRoleSettings } from './render-settings.mjs';
import { namesIn, FLAGS } from './settings-names.mjs';
import { sessionSettings, templateText, templateFile } from './review-settings.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const HEAD = 'a'.repeat(40);
const PKG_SHA = 'f'.repeat(64);
const ME = process.getuid();
const UIDS = Object.fromEntries(Object.keys(DESIGN_PROFILES).map((r) => [r, ['reviewer', 'auditor'].includes(r) ? ME : ME + 1000]));

function settingsOf(role) {
  const r = renderRoleSettings({ productionFiles: [], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
    paths: { copy: '/rc/S-1', outbox: '/o/reviewer/S-1', hooksDir: '/i/hooks', snapshot: '/r/rules.json', node: '/i/node', bobFolder: '/b',
      deny: { secrets: ['/k'] }, reviewWalls: { outboxRoot: '/o', runnerRoot: '/r' } } });
  assert.equal(r.ok, true, r.reason);
  return r.settings;
}

// A spawn that records every call: the launch path must never reach it while a check refuses.
function fakeSpawn() {
  const calls = [];
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); const c = new EventEmitter(); setImmediate(() => { c.pid = 4242; c.emit('spawn'); }); return c; };
  return { spawn, calls };
}

function x(over = {}, li = undefined) {
  const made = [];
  const settings = [];
  const sp = fakeSpawn();
  const role = over.role ?? 'reviewer';
  return {
    made, settings, calls: sp.calls,
    x: {
      role, card: 'C-1', head: HEAD, sessionId: 'S-1', outbox: '/o/reviewer/S-1', env: { CLAUDE_CONFIG_DIR: '/h/.claude' }, earlier: '',
      claudeBin: '/i/claude-code/2.1.300/claude', copy: '/rc/S-1-not-there', spawn: sp.spawn,
      makeCopy: async () => { made.push('/rc/S-1'); return { ok: true }; },
      settingsFor: (dir) => { settings.push(dir); return { ok: true, file: '/r/settings/S-1.json', settings: DESIGN_PROFILES[role] ? settingsOf(role) : {} }; },
      packageDir: '/r/packages/S-1',
      packageFor: async ({ copy, head, dir, since }) => { made.push(`package ${copy} -> ${dir}${since ? ` since ${since}` : ''}`); return { ok: true, base: 'b'.repeat(40), head, files: [{ status: 'M', path: 'a.txt' }], diffFile: `${dir}/change.diff`, diffBytes: 10, diffSha256: PKG_SHA }; },
      ...(li ? { launchInputs: li } : {}),
      ...over,
    },
  };
}

test('R-0b-163 (L78): the wiring exports start and nothing else', () => {
  assert.deepEqual(Object.keys(wiring).sort(), ['start']);
});

test('L83 M-3 planted: start runs launch(): with no launch inputs it is refused at check 0, and claude is never spawned', async () => {
  for (const role of ['reviewer', 'auditor']) {
    const w = x({ role });
    const r = await wiring.start(w.x);
    assert.equal(r.ok, false, role);
    assert.match(r.reason, /runs only as the review user/);
    assert.deepEqual(r.launch_log, []);
    assert.equal(r.package_sha256, PKG_SHA, 'once the package is written its sha256 goes back for the runner to pin, even on a refusal');
    assert.deepEqual(w.made, ['/rc/S-1', 'package /rc/S-1-not-there -> /r/packages/S-1'], 'the copy is made first, then the package goes in the runner\'s folder');
    assert.deepEqual(w.settings, ['/rc/S-1-not-there'], 'the settings name that same copy');
    assert.equal(w.calls.length, 0, 'claude is never spawned');
  }
});

test('L83 M-3 planted: past check 0 the launcher\'s own checks run on the session (check 1 here), with the session\'s flags; still no spawn', async () => {
  const s = settingsOf('reviewer');
  const flags = Object.values(FLAGS).filter((f) => f.startsWith('--'));
  const confirmed = Object.fromEntries([...namesIn(s), ...flags].map((n) => [n, { by: 'readback:stand-in', version: '2.1.300' }]));
  const w = x({}, { uids: UIDS, ownUid: () => ME, pin: '2.1.300', names: { confirmed } });
  const r = await wiring.start(w.x);
  assert.equal(r.ok, false);
  assert.match(r.reason, /launch check 1 \(fresh copy\): the review copy is missing/);
  assert.deepEqual(r.launch_log, [{ n: 1, ok: false, reason: 'the review copy is missing' }]);
  assert.equal(w.calls.length, 0);
  // The names check reads the flags the session will really start with, and the pin as the version.
  const off = x({}, { uids: UIDS, ownUid: () => ME, pin: '2.1.299', names: { confirmed } });
  assert.match((await wiring.start(off.x)).reason, /setting names not confirmed/);
});

// L83 minor 2: the real sessionSettings, on a throwaway machine laid out as the updater lays it (as review-settings.test.mjs).
function machine() {
  const base = realpathSync(tempDir('m4-wiring-'));
  const d = (...p) => { const q = join(base, ...p); mkdirSync(q, { recursive: true }); return q; };
  const V = `install.v-${'c'.repeat(40)}`;
  d(V);
  const installRoot = join(base, 'install');
  symlinkSync(V, installRoot); // root's link to the versioned copy (L75 M-1)
  mkdirSync(dirname(templateFile(installRoot, 'reviewer')), { recursive: true });
  for (const r of REVIEW_ROLES) { copyFileSync(join(HERE, 'templates', `${r}.settings.json`), templateFile(installRoot, r)); chmodSync(templateFile(installRoot, r), 0o644); }
  const node = join(d('install', 'bin'), 'node'); writeFileSync(node, '');
  const root = d('runner'); chmodSync(root, 0o700);
  const snapshot = join(root, 'rules.json'); writeFileSync(snapshot, '{}');
  const outboxRoot = d('outbox'); d('outbox', 'reviewer', 'S-1');
  const c = { installRoot, root, outboxRoot, hooksDir: d('install', 'hooks'), snapshot, bobFolder: d('bob'), deny: [d('secrets')], reviewCopies: d('review-copies'), workerCopies: d('worker-copies') };
  return { c, node, copy: join(c.reviewCopies, 'S-1') };
}

test('L83 minor 2 planted: the file the session is handed is byte for byte what the real sessionSettings wrote', async () => {
  const m = machine();
  let made = null;
  const w = x({
    copy: m.copy, outbox: join(m.c.outboxRoot, 'reviewer', 'S-1'),
    makeCopy: async () => { mkdirSync(m.copy, { mode: 0o700 }); return { ok: true }; },
    settingsFor: (dir) => {
      made = sessionSettings(m.c, { role: 'reviewer', sessionId: 'S-1', copy: dir, node: m.node }, { owner: ME, uid: ME });
      return made;
    },
  });
  const r = await wiring.start(w.x);
  assert.equal(made?.ok, true, made?.reason);
  assert.equal(r.ok, false, 'no launch inputs: refused at check 0');
  assert.equal(readFileSync(made.file, 'utf8'), templateText(made.settings), 'the wiring left the file as sessionSettings wrote it');
  assert.equal(made.file, join(m.c.root, 'settings', 'S-1.json'));
});

test('R-0b-146: a re-audit\'s package is made since the head the earlier audit passed', async () => {
  const w = x({ role: 'auditor', audited: 'c'.repeat(40) });
  await wiring.start(w.x);
  assert.deepEqual(w.made, ['/rc/S-1', `package /rc/S-1-not-there -> /r/packages/S-1 since ${'c'.repeat(40)}`]);
});

test('R-0b-163: no profile, no copy or no settings means no launch', async () => {
  assert.match((await wiring.start(x({ role: 'builder' }).x)).reason, /has no role profile/);
  const noCopy = x({ makeCopy: async () => ({ ok: false, reason: 'gone' }) });
  assert.match((await wiring.start(noCopy.x)).reason, /the review copy: gone/);
  const throws = x({ makeCopy: async () => { throw new Error('disk'); } });
  assert.match((await wiring.start(throws.x)).reason, /the review copy: disk/);
  const noSettings = x({ settingsFor: () => ({ ok: false, reason: 'template' }) });
  const ns = await wiring.start(noSettings.x);
  assert.match(ns.reason, /the settings: template/);
  assert.equal(ns.package_sha256, PKG_SHA);
  const noPkg = x({ packageFor: async () => ({ ok: false, reason: 'no diff' }) });
  assert.deepEqual(await wiring.start(noPkg.x), { ok: false, reason: 'the review package: no diff' });
  for (const w of [noCopy, throws, noSettings, noPkg]) assert.equal(w.calls.length, 0);
});
