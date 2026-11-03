// job-config.test.mjs — the one checked job-config reader (L253). Run: node --test orchestrate/shared/job-config.test.mjs
// Every refusal is a real file fault where a test user can make one (a link, a mode, a place), and a port standing in
// for another owner where only root could make it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, fstatSync, symlinkSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJobConfig } from './job-config.mjs';
import { installedLayout } from './job-config.test-helper.mjs';

const WIRING = 'modules/x/wiring.mjs';
function layout() {
  const L = installedLayout('orch-jobcfg-', { files: { [WIRING]: 'export async function wire() { return {}; }\n' } });
  const config = (more = {}) => L.write('job.json', { installRoot: L.installRoot, wiring: L.path(WIRING), ...more });
  return { ...L, config };
}
const refuses = (file, re, opts) => assert.throws(() => readJobConfig(file, opts), (e) => { assert.match(e.message, /^job config /); assert.match(e.message, re); return true; });

test('L253: the real installed layout passes, through the copy\'s link and through its real folder', () => {
  const L = layout();
  const c = readJobConfig(L.config());
  assert.equal(c.wiring, L.path(WIRING));
  const real = L.write('job2.json', { installRoot: L.installRoot, wiring: join(L.copy, WIRING) });
  assert.equal(readJobConfig(real).wiring, join(L.copy, WIRING));
  assert.equal(readJobConfig(join(L.copy, 'job.json')).installRoot, L.installRoot);
});

test('L253: a config owned by another user (a worker) is refused, and so is a copy that is not root\'s or the job\'s', () => {
  const L = layout();
  const f = L.config();
  refuses(f, /is owned by uid 4242, not by the installed copy's owner/, { fstat: (fd) => ({ ...fstatSync(fd), isFile: () => true, uid: 4242, mode: 0o100644 }) });
  const lst = (p) => (p === L.installRoot ? Object.assign(lstatSync(p), { uid: 4242 }) : lstatSync(p));
  refuses(f, /installed copy .* is owned by uid 4242, not root or this job's own user/, { lstat: lst });
  refuses(f, /not root or this job's own user/, { ownUid: 4243 });
});

test('L253: a config written by group or others, a linked config, and a config that is not a file are refused', () => {
  const L = layout();
  const f = L.config();
  chmodSync(join(L.copy, 'job.json'), 0o664);
  refuses(f, /can be written by group or others/);
  chmodSync(join(L.copy, 'job.json'), 0o644);
  symlinkSync(join(L.copy, 'job.json'), join(L.copy, 'link.json'));
  refuses(L.path('link.json'), /is a link/);
  refuses(L.path('modules'), /is not a plain file|can't be opened/);
});

test('L253: a linked wiring, a wiring outside the copy, a test file as wiring, and a missing wiring are refused', () => {
  const L = layout();
  symlinkSync(join(L.copy, WIRING), join(L.copy, 'modules/x/link.mjs'));
  refuses(L.config({ wiring: L.path('modules/x/link.mjs') }), /link/);
  rmSync(join(L.copy, 'modules/x/link.mjs'));
  const outside = join(L.base, 'wiring.mjs'); writeFileSync(outside, 'export const wire = 1;\n', { mode: 0o644 });
  refuses(L.config({ wiring: outside }), /is not inside the installed copy/);
  L.write('modules/x/w.test.mjs', 'export const wire = 1;\n');
  refuses(L.config({ wiring: L.path('modules/x/w.test.mjs') }), /test files/);
  refuses(L.config({ wiring: L.path('modules/x/none.mjs') }), /missing/);
  refuses(L.config({ wiring: 'modules/x/wiring.mjs' }), /wiring must be a full path/);
  refuses(L.config({ wiring: undefined }), /wiring must be a full path/);
});

test('L253: a config outside the copy, a group-writable file in the copy, and a group-writable folder at or above the copy are refused', () => {
  const L = layout();
  const out = join(L.base, 'job.json');
  writeFileSync(out, JSON.stringify({ installRoot: L.installRoot, wiring: L.path(WIRING) }), { mode: 0o644 });
  refuses(out, /is not inside the installed copy/);
  const f = L.config();
  L.write('modules/x/other.mjs', 'export {};\n', 0o666);
  refuses(f, /can be written by others/);
  chmodSync(join(L.copy, 'modules/x/other.mjs'), 0o644);
  chmodSync(L.base, 0o775);
  refuses(f, /can be written by others/);
  chmodSync(L.base, 0o700);
  const up = dirname(L.base);
  refuses(f, new RegExp(`${up.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, above the installed copy, can be written by group or others`),
    { lstat: (p) => (p === up ? Object.assign(lstatSync(p), { mode: 0o40777 }) : lstatSync(p)) });
  refuses(f, /above the installed copy, is owned by uid 4242/, { lstat: (p) => (p === up ? Object.assign(lstatSync(p), { uid: 4242 }) : lstatSync(p)) });
});

test('L257 (A): a layout under a sticky world-writable folder (Linux /tmp, 1777) is refused; do not loosen this for CI', () => {
  const L = layout();
  const f = L.config();
  chmodSync(L.base, 0o1777);
  refuses(f, /can be written by others/);
  chmodSync(L.base, 0o700);
  const up = dirname(L.base);
  refuses(f, /above the installed copy, can be written by group or others/,
    { lstat: (p) => (p === up ? Object.assign(lstatSync(p), { uid: 0, mode: 0o41777 }) : lstatSync(p)) });
});

test('L253: an access list above or inside the copy is refused, and an unreadable one too', () => {
  const L = layout();
  const f = L.config();
  refuses(f, /has an access list/, { acl: (paths) => `${paths[0]} has an access list (ACL), which can let others write it (clear it with chmod -N)` });
});

test('L253: the file read is the file checked (a swap between the descriptor and the name is refused)', () => {
  const L = layout();
  const f = L.config();
  refuses(f, /changed while it was read/, { lstat: (p) => (p === f ? Object.assign(lstatSync(p), { ino: lstatSync(p).ino + 1 }) : lstatSync(p)) });
});

test('L253: a config that is not a JSON object, or names no installRoot, is refused; optional code keys are checked when present', () => {
  const L = layout();
  refuses(L.write('a.json', '[1]'), /must be a JSON object/);
  refuses(L.write('b.json', '{nope'), /is not JSON/);
  refuses(L.write('c.json', { wiring: L.path(WIRING) }), /installRoot must be a full path/);
  refuses(L.write('d.json', { installRoot: join(L.base, 'none'), wiring: L.path(WIRING) }), /installRoot .* is missing/);
  const f = L.config({ budget: join(L.base, 'budget.mjs') });
  assert.ok(readJobConfig(f));
  refuses(f, /budget, .* is not inside the installed copy|budget.mjs is not inside/, { optionalCode: ['budget'] });
  refuses('job.json', /must be a full path/);
  const hard = join(L.copy, 'hard.json'); linkSync(join(L.copy, 'job.json'), hard);
  assert.ok(readJobConfig(L.path('hard.json')), 'a second name of a checked file is the same file');
});
