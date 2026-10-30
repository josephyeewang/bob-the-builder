// Planted-failure tests for the git layer's refusal lines (audit R-0b-44 M-6). Each test makes one
// refusal fire and checks its own reason. The secret scanner here is a fake script, never a real
// scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DO_PLANE_TOML, checkScanner } from './gitleaks.mjs';
import { parseRawZ } from './push-refusals.mjs';
import { gitOk } from './safe-git.mjs';
import { resetCloneGit, createSaveWork } from './save-work.mjs';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'orch-git-refuse-')));

function scanner(versionLine = '8.30.1') {
  const d = tmp();
  const bin = join(d, 'scanner');
  writeFileSync(bin, `#!/bin/sh\necho "${versionLine}"\n`); chmodSync(bin, 0o755);
  const config = join(d, 'do-plane.toml'); writeFileSync(config, DO_PLANE_TOML);
  const ignoreFile = join(d, 'empty-ignore'); writeFileSync(ignoreFile, '');
  return { d, setup: { bin, version: '8.30.1', config, ignoreFile } };
}

test('scanner check: each refusal gives its own reason; the good setup passes', async () => {
  const { d, setup } = scanner();
  assert.deepEqual(await checkScanner(setup), { ok: true });
  assert.equal((await checkScanner({ ...setup, bin: 'scanner' })).reason, 'the secret scanner is not pinned by absolute path');
  assert.equal((await checkScanner({ ...setup, bin: d })).reason, 'the secret scanner is missing');
  const full = join(d, 'full-ignore'); writeFileSync(full, 'fingerprint\n');
  assert.equal((await checkScanner({ ...setup, ignoreFile: full })).reason, 'the Do-plane ignore file is not empty');
  assert.equal((await checkScanner(scanner('no version here').setup)).reason, 'the secret scanner did not report its version');
});

test('change list: an unreadable line refuses with its own reason', () => {
  assert.throws(() => parseRawZ(Buffer.from('garbage\0path\0')), /unreadable change line "garbage"/);
});

test('safe-git: a failing git call refuses, naming the command', async () => {
  await assert.rejects(() => gitOk(['rev-parse', 'HEAD'], { gitDir: tmp(), purpose: 'test' }), /git rev-parse failed/);
});

test('save-work: no .git, an alternates folder, http-alternates, a bad card id and a missing outbox each refuse with their own reason', async () => {
  const mirror = join(tmp(), 'mirror.git');
  assert.throws(() => resetCloneGit({ clone: tmp(), mirror }), /the copy has no \.git folder/);
  const alt = tmp(); mkdirSync(join(alt, '.git', 'objects', 'info', 'alternates'), { recursive: true });
  assert.throws(() => resetCloneGit({ clone: alt, mirror }), /alternates file is not a plain file/);
  const http = tmp(); mkdirSync(join(http, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(join(http, '.git', 'objects', 'info', 'http-alternates'), 'https://example.com/objects\n');
  assert.throws(() => resetCloneGit({ clone: http, mirror }), /the copy has objects\/info\/http-alternates/);
  const saveWork = createSaveWork({ runLocked: (fn) => fn() });
  assert.equal((await saveWork({ clone: tmp(), mirror, card: 'bad id!', branch: 'card/bad id!', outbox: tmp() })).reason, 'bad card id');
  const clone = tmp(); mkdirSync(join(clone, '.git'));
  assert.equal((await saveWork({ clone, mirror, card: 'C-1', branch: 'card/c-1', outbox: join(clone, 'no-outbox') })).reason, 'the outbox is not a real folder');
});
