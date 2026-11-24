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
import { NONE_YET, NOT_TAKEN, appliedFactId, holdPrefixes, readFiled } from './filed.mjs';

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

test('#658 audit m1: a file intake held before filing it (a refused read, a failed check) shows its hold, not "not taken yet" for ever', () => {
  const env = setup({ prefix: 'm1-filed-' });
  product(env);
  const outbox = join(tempDir('m1-filed-outbox-'), SID);
  mkdirSync(outbox);
  for (const n of ['idea-a.md', 'idea-b.md', 'idea-c.md']) writeFileSync(join(outbox, n), 'x');
  const [readA] = holdPrefixes(SID, 'idea-a.md');
  const [, noteB] = holdPrefixes(SID, 'idea-b.md');
  fact(env, `${readA}0123456789ab`, { text: `an outbox file from front_door ${SID} (idea-a.md) was refused: the file is not the owner's`, told_at: '2026-11-23T17:05:00.000Z' });
  fact(env, `${noteB}launcher`, { text: `outbox file idea-b.md from front_door ${SID} not used yet: the idea names no product`, at: '2026-11-23T17:05:00.000Z' });
  const r = readFiled({ outbox, sessionId: SID, recordRoot: env.root, recordUid: UID });
  assert.deepEqual(r.rows, [
    { name: 'idea-a.md', state: `held, not filed: an outbox file from front_door ${SID} (idea-a.md) was refused: the file is not the owner's` },
    { name: 'idea-b.md', state: `held, not filed: outbox file idea-b.md from front_door ${SID} not used yet: the idea names no product` },
    { name: 'idea-c.md', state: NOT_TAKEN },
  ]);
});

test('#658 audit m1: the hold names read here are still the ones intake writes (outbox-intake.mjs readHoldsOfFile, noteDaily)', () => {
  const src = readFileSync(join(HERE, '..', 'M11-dispatcher', 'outbox-intake.mjs'), 'utf8');
  for (const line of [
    'const shortHash = (s) => sha256(s).slice(0, 12);',
    'const readHoldsOf = (sessionId) => HOLD_FACT(`outbox-read-${shortHash(sessionId)}-`);',
    'const readHoldsOfFile = (sessionId, name) => `${readHoldsOf(sessionId)}${shortHash(name)}-`;',
    'const id = HOLD_FACT(`outbox-note-${shortHash(`${s.sessionId} ${name}`)}-${causeOf(reason)}`);',
  ]) assert.ok(src.includes(line), `intake changed a hold's name: change holdPrefixes with it (${line})`);
  const pass = readFileSync(join(HERE, '..', 'M11-dispatcher', 'pass.mjs'), 'utf8');
  assert.ok(pass.includes('export const HOLD_FACT = (cause) => `hold-${cause}`;'));
});
