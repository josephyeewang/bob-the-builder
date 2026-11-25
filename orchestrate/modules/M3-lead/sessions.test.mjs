// sessions.test.mjs — the one-shot Lead's sessions by their outbox folder's name, through the listing the Front Door
// shares (shared/owner-sessions.mjs; Track A step 8, L1370).
// Run: node --test orchestrate/modules/M3-lead/sessions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { SESSION_ID } from '../../shared/record-names.mjs';
import { LAUNCH_FILE, launchFileText, leadSessionId, leadSessions, isLeadSession, readLaunchFile } from './sessions.mjs';
import { frontDoorSessions } from '../M1-front-door/sessions.mjs';

const HEAD = 'a'.repeat(40);

test('a Lead start\'s session id names the product and the time, and is a session id the Record takes', () => {
  const id = leadSessionId('orchestrate-test', new Date(2026, 10, 25, 9, 5, 7));
  assert.equal(id, 'ld-orchestrate-test-20261125090507');
  assert.match(id, SESSION_ID);
  assert.ok(isLeadSession(id, 'orchestrate-test'));
  assert.ok(!isLeadSession(id, 'orchestrate'), 'product a never takes product a-b\'s Lead');
  assert.ok(!isLeadSession('fd-orchestrate-test-20261125090507', 'orchestrate-test'), 'a Front Door id is not a Lead\'s');
  for (const bad of ['', 'A', 'a/b', '../x', 'a b']) assert.throws(() => leadSessionId(bad), /not a product name/, bad);
});

test('leadSessions lists this product\'s plain Lead folders only, as lead sessions of the owner; the Front Door\'s are its own', () => {
  const root = tempDir('m3-ld-sessions-');
  assert.deepEqual(leadSessions({ outboxRoot: root, product: 'p', uid: 501 }), [], 'no Lead folder yet');
  const ld = join(root, 'lead');
  mkdirSync(join(ld, 'ld-p-20261125090507'), { recursive: true });
  mkdirSync(join(ld, 'ld-p-x-20261125090507'));
  mkdirSync(join(ld, 'fd-p-20261125090507'));
  writeFileSync(join(ld, 'ld-p-20261125090508'), 'a file, not a folder');
  symlinkSync(join(ld, 'ld-p-20261125090507'), join(ld, 'ld-p-20261125090509'));
  mkdirSync(join(root, 'front_door', 'fd-p-20261125090507'), { recursive: true });
  assert.deepEqual(leadSessions({ outboxRoot: root, product: 'p', uid: 501 }),
    [{ sessionId: 'ld-p-20261125090507', role: 'lead', outbox: join(ld, 'ld-p-20261125090507'), uid: 501, card: null, product: 'p' }]);
  assert.deepEqual(frontDoorSessions({ outboxRoot: root, product: 'p', uid: 501 }).map((x) => [x.sessionId, x.role]), [['fd-p-20261125090507', 'front_door']]);
  assert.throws(() => leadSessions({ outboxRoot: root, product: 'p', uid: undefined }), /owner's Mac user id/);
  assert.throws(() => leadSessions({ outboxRoot: 'rel', product: 'p', uid: 1 }), /outbox root/);
  assert.throws(() => leadSessions({ outboxRoot: root, product: 'p', uid: 1, list: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } }), /no/, 'a folder that can\'t be listed throws, never "none"');
});

test('the launch file the start writes is the one the intake reads, and only for its own session and product', () => {
  const root = tempDir('m3-ld-launch-');
  const s = { sessionId: 'ld-p-20261125090507', outbox: join(root, 'ld-p-20261125090507'), uid: process.getuid(), product: 'p' };
  mkdirSync(s.outbox);
  assert.deepEqual(readLaunchFile(s), { ok: false, none: true, reason: 'no launch file' });
  writeFileSync(join(s.outbox, LAUNCH_FILE), launchFileText({ session: s.sessionId, product: 'p', head: HEAD }));
  assert.deepEqual(readLaunchFile(s), { ok: true, head: HEAD });
  assert.equal(LAUNCH_FILE.startsWith('.'), true, 'a dot-name: never a hand-in, and the Lead\'s own tools may not write it');
  assert.match(readLaunchFile({ ...s, product: 'q' }).reason, /another product/);
  assert.match(readLaunchFile({ ...s, sessionId: 'ld-p-20261125090508' }).reason, /another session/);
});
