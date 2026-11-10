// outbox-product.test.mjs — L850-2: the outbox readers find a worker runner session's outbox in its product's folder,
// <outboxRoot>/<product>/<role>/<sessionId> (L836), through the one definition (shared outboxFolders, on
// shared/product-paths.mjs runnerOutbox). A tag with no product keeps reading the layout from before L836; nothing moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outboxFolders, outboxPlace } from '../../shared/record.mjs';
import { readOutboxFile } from './outbox.mjs';
import { PRODUCT, UID, outboxFile, product, readyCard, runCard, setup } from './fixtures.test-helper.mjs';

const uids = { worker: UID, lead: UID, script: UID };
function drop(dir, name = 'report-1.md', text = 'what was done\n') {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}
function world() {
  const env = setup({ prefix: 'm9-outbox-product-' });
  product(env); readyCard(env, 'C-1'); runCard(env, 'C-1');
  return env;
}

test('L850-2: a worker runner hand-in is read from <outboxRoot>/<product>/<role>/<session>, and the Record takes it', () => {
  const env = world();
  const file = drop(join(env.outRoot, PRODUCT, 'worker', 'S-1'));
  const tag = { role: 'worker', sessionId: 'S-1', card: 'C-1', product: PRODUCT };
  assert.deepEqual(outboxFolders({ outboxRoot: env.outRoot, tag }).folders,
    [join(env.outRoot, PRODUCT), join(env.outRoot, PRODUCT, 'worker'), join(env.outRoot, PRODUCT, 'worker', 'S-1')]);
  const r = env.record.applyOutbox(tag, file);
  assert.equal(r.ok, true, JSON.stringify(r));
  // The same session's tag with no product is refused (L895 m1).
  const { product: _p, ...bare } = tag;
  assert.match(outboxPlace({ outboxRoot: env.outRoot, tag: bare, file }).reason, /a worker outbox is in its product's folder, and the tag names no product/);
});

test('L895 m1: a worker or script tag with no product is refused, even for a file in the flat folder; a Lead\'s is read flat and may name no product', () => {
  const env = world();
  for (const role of ['worker', 'script']) {
    const flat = drop(join(env.outRoot, role, 'S-1'), 'report-old.md', 'old place\n');
    const tag = { role, sessionId: 'S-1', card: 'C-1' };
    const w = outboxFolders({ outboxRoot: env.outRoot, tag });
    assert.equal(w.ok, false, role); assert.match(w.reason, new RegExp(`a ${role} outbox is in its product's folder, and the tag names no product`));
    const r = env.record.applyOutbox(tag, flat);
    assert.equal(r.ok, false, role); assert.match(r.reason, /tag names no product/);
  }
  const lead = outboxFile(env, 'lead', 'L-1', 'think-1.md', 'a thought\n');
  assert.equal(outboxPlace({ outboxRoot: env.outRoot, tag: { role: 'lead', sessionId: 'L-1' }, file: lead }).ok, true);
  for (const role of ['lead', 'incident', 'auditor']) {
    const w = outboxFolders({ outboxRoot: env.outRoot, tag: { role, sessionId: 'L-1', product: PRODUCT } });
    assert.equal(w.ok, false, role); assert.match(w.reason, new RegExp(`a ${role} outbox has no product folder`));
  }
});

test('L850-2: another product\'s outbox is never read by this Record, nor through this product\'s tag', () => {
  const env = world();
  const theirs = drop(join(env.outRoot, 'other-app', 'worker', 'S-1'), 'report-2.md', 'client work\n');
  const r = env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1', product: 'other-app' }, theirs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /this record is product sample-app's, and the outbox is product other-app's/);
  // Tagged as this product, the other product's file is not in this session's folder.
  const own = { role: 'worker', sessionId: 'S-1', card: 'C-1', product: PRODUCT };
  mkdirSync(join(env.outRoot, PRODUCT, 'worker', 'S-1'), { recursive: true });
  const r2 = env.record.applyOutbox(own, theirs);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not directly inside the worker outbox of session S-1/);
});

test('L850-2: a product name with .. or / never climbs out of the outbox root\'s product folders', () => {
  const env = world();
  // join(<root>, '..', 'worker', 'S-1') is a folder beside the root: made here, so only the name check refuses it.
  const beside = drop(join(env.outRoot, '..', 'worker', 'S-1'));
  const inRoot = drop(join(env.outRoot, 'worker', 'S-1'), 'report-3.md');
  for (const [p, file] of [['..', beside], ['x/..', inRoot], ['.', inRoot], ['..', inRoot]]) {
    const tag = { role: 'worker', sessionId: 'S-1', product: p };
    const w = outboxFolders({ outboxRoot: env.outRoot, tag });
    assert.equal(w.ok, false, p); assert.match(w.reason, /bad outbox tag/);
    const f = readOutboxFile({ outboxRoot: env.outRoot, uids, tag, file });
    assert.equal(f.ok, false, p); assert.match(f.reason, /bad outbox tag/);
  }
});

test('L850-2: a role or session id with / is refused, with or without a product', () => {
  const env = world();
  const file = drop(join(env.outRoot, 'lead', 'S-1'));
  const pFile = drop(join(env.outRoot, PRODUCT, 'worker', 'S-1'));
  for (const [tag, f] of [
    [{ role: 'worker/../lead', sessionId: 'S-1' }, file],
    [{ role: 'lead', sessionId: 'S-2/../S-1' }, file],
    [{ role: 'lead/../worker', sessionId: 'S-1', product: PRODUCT }, pFile],
    [{ role: 'worker', sessionId: 'S-2/../S-1', product: PRODUCT }, pFile],
  ]) {
    const r = outboxPlace({ outboxRoot: env.outRoot, tag, file: f });
    assert.equal(r.ok, false, JSON.stringify(tag)); assert.match(r.reason, /bad outbox tag/);
  }
});

test('L850-2: a review role has no product folder, and a product folder that is a link is refused', () => {
  const env = world();
  const rv = outboxFolders({ outboxRoot: env.outRoot, tag: { role: 'reviewer', sessionId: 'S-1', product: PRODUCT } });
  assert.equal(rv.ok, false); assert.match(rv.reason, /a reviewer outbox has no product folder/);
  const real = join(env.base, 'elsewhere');
  drop(join(real, 'worker', 'S-1'));
  symlinkSync(real, join(env.outRoot, PRODUCT));
  const r = outboxPlace({ outboxRoot: env.outRoot, tag: { role: 'worker', sessionId: 'S-1', product: PRODUCT }, file: join(env.outRoot, PRODUCT, 'worker', 'S-1', 'report-1.md') });
  assert.equal(r.ok, false); assert.match(r.reason, new RegExp(`outbox folder ${PRODUCT} is a link`));
});

test('L850-2 (self-review): a product named as a role is refused, a role folder inside a product that is a link is refused, and a missing tag is a refusal', () => {
  const env = world();
  for (const p of ['worker', 'Lead']) {
    const w = outboxFolders({ outboxRoot: env.outRoot, tag: { role: 'worker', sessionId: 'S-1', product: p } });
    assert.equal(w.ok, false, p); assert.match(w.reason, /bad outbox tag/);
  }
  const real = join(env.base, 'elsewhere2');
  drop(join(real, 'S-1'));
  mkdirSync(join(env.outRoot, PRODUCT), { recursive: true });
  symlinkSync(real, join(env.outRoot, PRODUCT, 'worker'));
  const r = outboxPlace({ outboxRoot: env.outRoot, tag: { role: 'worker', sessionId: 'S-1', product: PRODUCT }, file: join(env.outRoot, PRODUCT, 'worker', 'S-1', 'report-1.md') });
  assert.equal(r.ok, false); assert.match(r.reason, /outbox folder worker is a link/);
  const n = env.record.applyOutbox(null, join(real, 'S-1', 'report-1.md'));
  assert.equal(n.ok, false);
});

test('L890: a Record is opened only for a product name setup makes a folder for, never one setup can\'t make or a role\'s', () => {
  for (const p of ['My.App', 'lead', 'Worker', 'a.b', 'A', '', '-x']) {
    assert.throws(() => setup({ prefix: 'm9-outbox-product-', extra: { product: p } }), /the record needs its product name/, p);
  }
  assert.doesNotThrow(() => setup({ prefix: 'm9-outbox-product-', extra: { product: 'my-app' } }));
});

test('#400 r1 m3: the file must be directly in the session\'s own folder: not S-10 under tag S-1, not a sub-folder', () => {
  const env = world();
  for (const [role, product] of [['lead', undefined], ['worker', PRODUCT]]) {
    const base = product ? join(env.outRoot, PRODUCT, role) : join(env.outRoot, role);
    mkdirSync(join(base, 'S-1'), { recursive: true });
    const tag = { role, sessionId: 'S-1', ...(product ? { product } : {}) };
    for (const file of [drop(join(base, 'S-10')), drop(join(base, 'S-1', 'sub'))]) {
      const r = outboxPlace({ outboxRoot: env.outRoot, tag, file });
      assert.equal(r.ok, false, file); assert.match(r.reason, new RegExp(`not directly inside the ${role} outbox of session S-1`));
    }
  }
});

test('#400 r1 m3: an empty product is a bad tag, never the layout with no product', () => {
  const env = world();
  const flat = drop(join(env.outRoot, 'worker', 'S-1'));
  const tag = { role: 'worker', sessionId: 'S-1', product: '' };
  const w = outboxFolders({ outboxRoot: env.outRoot, tag });
  assert.equal(w.ok, false); assert.match(w.reason, /bad outbox tag/);
  assert.equal(outboxPlace({ outboxRoot: env.outRoot, tag, file: flat }).ok, false);
  assert.equal(readOutboxFile({ outboxRoot: env.outRoot, uids, tag, file: flat }).ok, false);
});
