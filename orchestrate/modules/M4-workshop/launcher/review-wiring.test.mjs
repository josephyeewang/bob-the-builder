// R-0b-163: the review runner's wiring launches claude with the settings the runner made, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as wiring from './review-wiring.mjs';
import { FLAGS as F } from './settings-names.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';

const HEAD = 'a'.repeat(40);

// A fake claude: a child that reports its pid once spawned, or fails to spawn.
function fakeSpawn({ pid = 4242, fail = false } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    calls.push({ bin, args, opts, child });
    setImmediate(() => { if (fail) child.emit('error', Object.assign(new Error('no'), { code: 'ENOENT' })); else { child.pid = pid; child.emit('spawn'); } });
    return child;
  };
  return { spawn, calls };
}

function x(over = {}) {
  const made = [];
  const settings = [];
  const sp = fakeSpawn();
  return {
    made, settings, calls: sp.calls,
    x: {
      role: 'reviewer', card: 'C-1', head: HEAD, sessionId: 'S-1', outbox: '/o/reviewer/S-1', env: { CLAUDE_CONFIG_DIR: '/h/.claude' }, earlier: '',
      claudeBin: '/i/bin/claude', copy: '/rc/S-1', spawn: sp.spawn,
      makeCopy: async () => { made.push('/rc/S-1'); return { ok: true }; },
      settingsFor: (dir) => { settings.push(dir); return { ok: true, file: `/r/settings/S-1.json` }; },
      packageFor: async ({ copy, head }) => ({ ok: true, base: 'b'.repeat(40), head, files: [{ status: 'M', path: 'a.txt' }], diffFile: `${copy}/.git/orchestrate-review/change.diff`, diffBytes: 10 }),
      ...over,
    },
  };
}

test('R-0b-163 (L78): the wiring exports start and nothing else', () => {
  assert.deepEqual(Object.keys(wiring).sort(), ['start']);
});

test('R-0b-163 planted: claude is launched with --settings naming the file the runner\'s settingsFor wrote, once, and no other settings source', async () => {
  const w = x();
  const r = await wiring.start(w.x);
  assert.deepEqual(r, { ok: true, pid: 4242 });
  assert.deepEqual(w.made, ['/rc/S-1'], 'the review copy is made first');
  assert.deepEqual(w.settings, ['/rc/S-1'], 'the settings name that same copy');
  assert.equal(w.calls.length, 1);
  const { bin, args, opts, child } = w.calls[0];
  assert.equal(bin, '/i/bin/claude', 'the pinned claude');
  const at = args.flatMap((a, i) => (a === F.settings ? [i] : []));
  assert.equal(at.length, 1, '--settings appears exactly once');
  assert.equal(args[at[0] + 1], '/r/settings/S-1.json', 'and names the runner\'s file');
  for (const other of ['--setting-sources', '--add-dir', '--dangerously-skip-permissions', '--allowedTools', '--allowed-tools']) assert.equal(args.includes(other), false, `no ${other}`);
  assert.equal(args[args.indexOf(F.sessionId) + 1], 'S-1', 'claude takes the runner\'s session id, so the pid check finds it');
  assert.equal(args[args.indexOf(F.tools) + 1], DESIGN_PROFILES.reviewer.tools.join(','));
  assert.equal(args[args.indexOf(F.permissionMode) + 1], DESIGN_PROFILES.reviewer.mode);
  assert.equal(args.includes(F.restricted), true);
  assert.equal(args[args.indexOf(F.mcpConfig) + 1], '{"mcpServers":{}}');
  assert.equal(opts.cwd, '/rc/S-1', 'it runs in its review copy');
  assert.equal(opts.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, '/h/.claude');
  assert.equal(child.unrefed, true);
});

test('R-0b-163: a start that never spawns claude says so (ok false), and no copy, no settings, no claude means no launch', async () => {
  for (const role of ['auditor', 'reviewer']) assert.equal((await wiring.start(x({ role }).x)).ok, true, `${role} launches`);
  assert.match((await wiring.start(x({ role: 'builder' }).x)).reason, /has no role profile/);
  const noCopy = x({ makeCopy: async () => ({ ok: false, reason: 'gone' }) });
  assert.match((await wiring.start(noCopy.x)).reason, /the review copy: gone/);
  assert.equal(noCopy.calls.length, 0);
  const throws = x({ makeCopy: async () => { throw new Error('disk'); } });
  assert.match((await wiring.start(throws.x)).reason, /the review copy: disk/);
  const noSettings = x({ settingsFor: () => ({ ok: false, reason: 'template' }) });
  assert.match((await wiring.start(noSettings.x)).reason, /the settings: template/);
  assert.equal(noSettings.calls.length, 0);
  const failed = fakeSpawn({ fail: true });
  assert.deepEqual(await wiring.start(x({ spawn: failed.spawn }).x), { ok: false, reason: 'claude could not be spawned' });
  assert.match((await wiring.start(x({ spawn: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }).x)).reason, /could not be spawned \(EACCES\)/);
});

// L66's live wall proof: a real review session, as the review user, cannot read or write past its walls. It needs the
// Mini set up (the review user, the installed copy, the LaunchDaemons: Joe's setup batch), so it is named here and
// skipped until then; the lead runs it on the Mini.
test('L66 live wall proof: a real review session cannot reach past its walls (runs on the Mini after Joe\'s setup batch)', { skip: 'needs the Mini set up: the review user, the installed copy and the daemons' }, () => {});
