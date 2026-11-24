// filed.test.mjs — the read-back of what a Front Door tab filed, from the Record (Track A step 7).
// Run: node --test orchestrate/modules/M1-front-door/filed.test.mjs
//
// A real Record (M9's test setup, its files on disk) read through read-view as the owner would read it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UID, must, product, setup } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { NONE_YET, NOT_TAKEN, appliedFactId, readFiled } from './filed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SID = 'fd-p-20261123090507';
const fact = (env, id, doc) => must(env.record.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: env.record.read('fact', id)?.rev ?? 0, doc }), id);

test('step 7: each handed-in file reads back its state from the Record: filed, refused with why, or not taken yet', () => {
  const env = setup({ prefix: 'm1-filed-' });
  product(env);
  const outbox = join(tempDir('m1-filed-outbox-'), SID);
  mkdirSync(outbox);
  for (const n of ['idea-a.md', 'idea-b.md', 'ask-request-c.json', '.settings.json', 'notes.txt']) writeFileSync(join(outbox, n), 'x');
  fact(env, appliedFactId(SID, 'idea-a.md'), { session: SID, name: 'idea-a.md', state: 'applied', applied_at: '2026-11-23T17:05:00.000Z' });
  fact(env, appliedFactId(SID, 'ask-request-c.json'), { session: SID, name: 'ask-request-c.json', state: 'refused', alert_text: 'the ask names no product' });
  const r = readFiled({ outbox, sessionId: SID, recordRoot: env.root, recordUid: UID });
  assert.deepEqual(r.rows, [
    { name: 'ask-request-c.json', state: 'refused, not filed: the ask names no product' },
    { name: 'idea-a.md', state: 'filed in the Record' },
    { name: 'idea-b.md', state: NOT_TAKEN },
  ], 'the settings file and a name intake never takes are not hand-ins');
  assert.equal(r.text.split('\n')[0], `What Front Door tab ${SID} filed (from the Record):`);
  // The Record's own check holds: a reader that names the wrong owner reads nothing as filed.
  const wrong = readFiled({ outbox, sessionId: SID, recordRoot: env.root, recordUid: UID + 1 });
  assert.ok(wrong.rows.every((x) => /can't be read from the Record/.test(x.state)), JSON.stringify(wrong.rows));
});

test('step 7: an empty tab says so, and a folder that can\'t be listed says it can\'t be read, never "nothing filed"', () => {
  const env = setup({ prefix: 'm1-filed-' });
  const outbox = join(tempDir('m1-filed-outbox-'), SID);
  mkdirSync(outbox);
  assert.match(readFiled({ outbox, sessionId: SID, recordRoot: env.root, recordUid: UID }).text, new RegExp(NONE_YET));
  const r = readFiled({ outbox, sessionId: SID, recordRoot: env.root, recordUid: UID, list: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } });
  assert.equal(r.rows, null);
  assert.match(r.text, /can't be read: its folder can't be listed \(EACCES\)/);
});

test('step 7: the fact name read here is still the one intake writes (M11 outbox-intake.mjs appliedId)', () => {
  const src = readFileSync(join(HERE, '..', 'M11-dispatcher', 'outbox-intake.mjs'), 'utf8');
  assert.ok(src.includes('const appliedId = (sessionId, name) => `intake-applied-${sessionId}-${name}`;'), 'intake renamed its fact: change appliedFactId with it');
  assert.equal(appliedFactId('S', 'idea-1.md'), 'intake-applied-S-idea-1.md');
});
