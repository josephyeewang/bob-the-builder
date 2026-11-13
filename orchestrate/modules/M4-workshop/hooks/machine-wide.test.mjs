// L1031: the production-write guard's machine-wide form, `--machine-wide --snapshot <root's copy>`, as managed-settings.json
// runs it for every session on the Mac. The copy is written once by setup.mjs managed-settings and never refreshed, so it has
// no age limit, but it must be root's alone (here a test's own uid stands in for root, `ownerUid`; the real form always
// means 0). A copy the guard can't use blocks every call, naming the way out (guard b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, linkSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, runHook, MANAGED_FILE, MACHINE_WIDE_WAY_OUT } from './lib.mjs';
import { makeSnapshot, readSnapshot, rootChainProblem } from './snapshot.mjs';
import { decide } from './production-write-guard.mjs';
import { CLAUDE_FILE } from '../launcher/env-check.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ME = process.getuid();
const RULES = { production: { env_files: ['/srv/app/prod-settings.conf'], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: [] } };
const HARMLESS = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/' };
const PROD = { tool_name: 'Bash', tool_input: { command: 'vercel deploy' }, cwd: '/' };
const YEAR = 365 * 24 * 3600 * 1000;

/** A folder of this test's own (owner ME, 0755, every folder above it root's or ME's and written by no one else) holding the copy. */
function copyAt(body = makeSnapshot(RULES), mode = 0o644) {
  const d = realpathSync(tempDir('orch-mw-')); chmodSync(d, 0o755);
  const f = join(d, 'machine-wide-rules.json'); writeFileSync(f, body); chmodSync(f, mode);
  return { d, f };
}
const wide = (snapshot, ownerUid = ME) => ({ machineWide: true, snapshot, ownerUid });
const wayOut = (r) => { assert.equal(r.block, true); assert.ok(r.reason.endsWith(MACHINE_WIDE_WAY_OUT), r.reason); };

test('L1031: the machine-wide form is exactly --machine-wide --snapshot <full path>, and only a hook that opts in takes it', () => {
  assert.deepEqual(parseArgs(['--machine-wide', '--snapshot', '/a/b.json'], { machineWide: true }), { machineWide: true, snapshot: '/a/b.json' });
  for (const bad of [['--machine-wide', '--snapshot'], ['--machine-wide', '--snapshot', 'rel.json'], ['--machine-wide', '--snapshot', '/a', '--role', 'x'],
    ['--machine-wide', 'yes', '--snapshot', '/a'], ['--machine-wide', '--role', '/a']]) {
    assert.throws(() => parseArgs(bad, { machineWide: true }), /machine-wide form|absolute/, bad.join(' '));
  }
  assert.throws(() => parseArgs(['--machine-wide', '--snapshot', '/a/b.json']), /no machine-wide form/, 'a hook that does not opt in refuses it');
  // The role form is unchanged, for a hook that opts in too.
  assert.equal(parseArgs(['--role', 'r', '--outbox', '/o', '--snapshot', '/s'], { machineWide: true }).role, 'r');
  assert.equal(MANAGED_FILE, CLAUDE_FILE, 'one name for the machine-wide file: the way out names the file check 10 reads');
});

test('L1031 guard b: a hook error in the machine-wide form blocks and names the way out; the role form\'s does not', async () => {
  const run = async (argv, opts) => { let code; let err = ''; await runHook(() => { throw new Error('boom'); }, { argv, stdin: [Buffer.from('{}')], exit: (c) => { code = c; }, stderr: (t) => { err += t; } }, opts); return { code, err }; };
  const a = await run(['--machine-wide', '--snapshot', '/a/b.json'], { machineWide: true });
  assert.equal(a.code, 2); assert.match(a.err, /boom/); assert.ok(a.err.includes(MACHINE_WIDE_WAY_OUT));
  const b = await run(['--machine-wide', '--snapshot', 'rel'], { machineWide: true });   // a bad argument, too
  assert.equal(b.code, 2); assert.ok(b.err.includes(MACHINE_WIDE_WAY_OUT));
  const c = await run(['--role', 'r', '--outbox', '/o', '--snapshot', '/s'], { machineWide: true });
  assert.equal(c.code, 2); assert.ok(!c.err.includes('sudo rm'), 'a role session\'s hook error is the loop\'s to put right, not a machine-wide lock-out');
  const d = await run(['--machine-wide', '--snapshot', '/a/b.json'], {});
  assert.equal(d.code, 2); assert.ok(!d.err.includes('sudo rm'), 'a hook with no machine-wide form refuses it as a bad argument');
});

test('L1031: root\'s copy is read with no age limit: a year-old copy still guards, where a role snapshot that old is stale', () => {
  const { f } = copyAt(makeSnapshot(RULES, new Date(Date.now() - YEAR)));
  assert.deepEqual(decide(HARMLESS, wide(f)), { block: false });
  assert.match(decide(PROD, wide(f)).reason, /"vercel" reaches production/);
  assert.match(decide(HARMLESS, { snapshot: f }).reason, /stale/, 'the role form keeps its 5-minute limit');
});

test('L1031 guard b: a missing, unreadable or broken copy blocks every call, harmless ones too, naming the way out', () => {
  const { d, f } = copyAt();
  wayOut(decide(HARMLESS, wide(join(d, 'missing.json'))));
  const bad = copyAt('{"rules":{"production":{}},"hash":"x","written_at":"2026-01-01T00:00:00Z"}');
  wayOut(decide(HARMLESS, wide(bad.f)));
  const noBlock = copyAt(makeSnapshot({ secrets: { paths: [] } }));
  wayOut(decide(HARMLESS, wide(noBlock.f)));
  chmodSync(f, 0o000);
  if (ME !== 0) wayOut(decide(HARMLESS, wide(f)));   // root reads a 0000 file, so only a non-root run sees it unreadable
  // The role form's own refusal is unchanged: no way-out text.
  assert.ok(!decide(HARMLESS, { snapshot: join(d, 'missing.json') }).reason.includes('sudo rm'));
});

test('L1031: the copy must be root\'s alone: another owner, a group- or other-writable copy or folder above, a link or a second name is refused', () => {
  const { d, f } = copyAt();
  assert.deepEqual(decide(HARMLESS, wide(f)), { block: false }, 'the good copy passes');
  wayOut(decide(HARMLESS, wide(f, ME + 1)));   // owned by someone other than root
  assert.match(decide(HARMLESS, wide(f, ME + 1)).reason, /not root's alone/);
  for (const m of [0o664, 0o646]) { chmodSync(f, m); assert.match(decide(HARMLESS, wide(f)).reason, /rules copy is not root's alone/, m.toString(8)); }
  chmodSync(f, 0o644);
  chmodSync(d, 0o775); assert.match(decide(HARMLESS, wide(f)).reason, /the folder .* above the machine-wide rules copy is not root's alone/); chmodSync(d, 0o755);
  const link = join(d, 'link.json'); symlinkSync(f, link);
  wayOut(decide(HARMLESS, wide(link)));
  const second = join(d, 'second.json'); linkSync(f, second);
  assert.match(decide(HARMLESS, wide(f)).reason, /2 names/);
  assert.equal(rootChainProblem('/no/such/folder/x.json'), 'rules snapshot is missing or unreadable');
  // readSnapshot without ownerUid (every role hook, launch check 8) never judges the owner.
  assert.equal(readSnapshot(second, { maxAgeMs: Infinity }).ok, false, 'the second name is still refused');
});

test('L1031: the real guard script, run as managed-settings.json runs it, blocks with the way out when root does not own the copy', () => {
  const { f } = copyAt();
  const r = spawnSync(process.execPath, [join(HERE, 'production-write-guard.mjs'), '--machine-wide', '--snapshot', f], { input: JSON.stringify(HARMLESS), encoding: 'utf8' });
  if (ME === 0) { assert.equal(r.status, 0, r.stderr); return; }
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not root's alone/);
  assert.ok(r.stderr.includes(`sudo rm "${CLAUDE_FILE}"`), r.stderr);
  // Every other hook refuses the form.
  const s = spawnSync(process.execPath, [join(HERE, 'secret-file-block.mjs'), '--machine-wide', '--snapshot', f], { input: JSON.stringify(HARMLESS), encoding: 'utf8' });
  assert.equal(s.status, 2); assert.match(s.stderr, /no machine-wide form/);
});

test('L1031: a folder written by others above the copy is refused, whoever owns it', () => {
  const { d } = copyAt();
  const sub = join(d, 'sub'); mkdirSync(sub); chmodSync(sub, 0o757);
  const f = join(sub, 'c.json'); writeFileSync(f, makeSnapshot(RULES)); chmodSync(f, 0o644);
  assert.match(rootChainProblem(f, ME), /folder .*sub above/);
});
