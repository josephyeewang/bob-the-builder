// L767: a script session has its own outbox, <outboxRoot>/script/<id>. Its hand-ins go from the runner's status, through
// outboxSessions' tag, to the Record's real applyOutbox and outboxPlace: tag.role names one thing everywhere (the folder,
// the kinds it may write, the actor), so a script hands in a report- and never a handin-.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outboxPlace } from '../shared/record.mjs';
import { setup, product, readyCard, runCard, outboxFile, UID } from '../modules/M9-record/fixtures.test-helper.mjs';
import { ownerSyncPorts } from './owner-status.mjs';

function scriptWorld() {
  const role = 'script'; const kind = 'script';
  const env = setup({ prefix: 'orch-script-outbox-' });
  product(env); readyCard(env, 'C-1'); runCard(env, 'C-1');
  const outRoot = realpathSync(env.outRoot);
  const dir = join(env.base, 'runner'); mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755);
  const statusFile = join(realpathSync(dir), 'status.json');
  const outbox = join(outRoot, role, 'S-1'); mkdirSync(outbox, { recursive: true });
  const session = { id: 'S-1', product: 'p1', kind, card: 'C-1', lead: null, role, pgid: 77, signin: 's', config_dir: '/cfg', bundle_files: [],
    outbox, uid: process.getuid(), alive: true, ended: false, outbox_open: true, stop_requested: false };
  writeFileSync(statusFile, JSON.stringify({ written_at: new Date().toISOString(), sessions: [session], requests: { 'S-1': { state: 'started' } } }), { mode: 0o644 });
  chmodSync(statusFile, 0o644);
  const ports = ownerSyncPorts({ statusFile, uid: process.getuid(), outboxRoot: outRoot, holds: () => true });
  return { env, ports, outRoot };
}

test('L767: a script hand-in of a report- reaches outboxPlace under its own folder, tagged script, and the Record takes it', () => {
  const { env, ports, outRoot } = scriptWorld();
  const [s] = ports.outboxSessions();
  assert.deepEqual([s.role, s.outbox], ['script', join(outRoot, 'script', 'S-1')]);
  const tag = { role: s.role, sessionId: s.sessionId, card: s.card };
  const file = outboxFile(env, 'script', 'S-1', 'report-1.md', 'what the script did\n');
  assert.equal(outboxPlace({ outboxRoot: outRoot, tag, file }).ok, true);
  const r = env.record.applyOutbox(tag, file);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(UID, process.getuid());
});

test('L767, L838: a script hands in its own claimed card through handin- (as a worker does), and the card goes to in_review', () => {
  const { env, ports } = scriptWorld();
  const [s] = ports.outboxSessions();
  const tag = { role: s.role, sessionId: s.sessionId, card: s.card };
  const file = outboxFile(env, 'script', 'S-1', 'handin-1.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`);
  const r = env.record.applyOutbox(tag, file);
  assert.equal(r.ok, true, r.reason);
  assert.equal(env.record.read('card', 'C-1').doc.state, 'in_review');
  // The same file under the worker's folder is not this session's: a script can't borrow the worker's tag.
  const asWorker = outboxFile(env, 'worker', 'S-1', 'handin-2.md', 'x\n');
  assert.equal(outboxPlace({ outboxRoot: env.outRoot, tag, file: asWorker }).ok, false);
});
