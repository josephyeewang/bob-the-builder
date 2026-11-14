import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configUnreadable, lockRefused, notOwnUser, pinProblem, recordUnwritten } from './before-run.mjs';

test('L1164: each shared before-run refusal says what it said in both proofs, word for word', () => {
  const c = { ownDir: '/o', pin: '2.1.316' };
  assert.equal(notOwnUser({ c, uid: 501, ownDirUid: 502 }), "it runs as uid 501, but the worker runner's own folder /o is uid 502's. Run it as that user");
  assert.equal(notOwnUser({ c, uid: 501, ownDirUid: 501 }), null);
  assert.equal(notOwnUser({ c: undefined, uid: 501, ownDirUid: null }), "it runs as uid 501, but the worker runner's own folder undefined is uid null's. Run it as that user");
  assert.equal(pinProblem({ c: { ...c, pin: undefined }, claudeVersion: '2.1.316' }), 'the config names no claude pin (pin)');
  assert.equal(pinProblem({ c, claudeVersion: '2.1.322' }), "claude is 2.1.322, but the config's pin is 2.1.316. Run it with the pinned claude");
  assert.equal(pinProblem({ c, claudeVersion: null }), "claude is not readable, but the config's pin is 2.1.316. Run it with the pinned claude");
  assert.equal(pinProblem({ c, claudeVersion: '2.1.316' }), null);
  assert.equal(configUnreadable(new Error('no such file')), "the worker runner's config can't be read (no such file)");
  assert.equal(configUnreadable('plain'), "the worker runner's config can't be read (plain)");
  assert.equal(lockRefused(new Error('lock busy')), 'the worker runner is running. Stop it first, then run this again');
  assert.equal(lockRefused(new Error('EACCES')), "the worker runner's lock can't be taken (EACCES)");
  assert.equal(recordUnwritten(Object.assign(new Error('x'), { code: 'EEXIST' })), 'The record of this run could not be written (EEXIST)');
  assert.equal(recordUnwritten(new Error('disk full')), 'The record of this run could not be written (disk full)');
});

test('L1164: both live proofs take these texts from before-run.mjs and hold no copy of their own', () => {
  for (const f of ['settings-names.mjs', 'runlocked.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.match(src, /from '\.\/before-run\.mjs'/, f);
    for (const t of ['is running. Stop it first', "config can't be read (", "lock can't be taken (", 'names no claude pin (pin)', 'Run it with the pinned claude', 'The record of this run could not be written (', "but the worker runner's own folder "]) {
      assert.ok(!src.includes(t), `${f} still holds "${t}"`);
    }
  }
});
