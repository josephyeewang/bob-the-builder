// store.test.mjs — R-0b-20: the store's folders and files, its owner, tamper detection, recovery and corrupt reads
// (0b-2 M-4, M-7, R2-m3, m-5, m-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT, UID, must, put, rulesFor, seed, setup } from './fixtures.test-helper.mjs';
import { openRecord } from './writer.mjs';
import { openStore } from './store.mjs';

const card = (extra = {}) => ({ state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, ...extra });
const docFile = (env, entity, id) => join(env.root, 'docs', entity, `${id}.json`);
const mode = (p) => statSync(p).mode & 0o777;

test('folders are 755 and files 644 whatever the umask (M-7 a)', () => {
  const old = process.umask(0o077);
  try {
    const env = setup({ prefix: 'm9-store-' });
    seed(env, 'card', 'C-1', card());
    for (const d of ['', 'docs', 'tmp', 'quarantine', 'docs/card']) assert.equal(mode(join(env.root, d)), 0o755, d || 'root');
    for (const f of ['diary.jsonl', 'refusals.jsonl', 'outbox-seen.jsonl', 'docs/card/C-1.json']) assert.equal(mode(join(env.root, f)), 0o644, f);
    // Every level the store makes is 755, not only the last (0b-2 audit MIN-6).
    openStore({ root: join(env.base, 'a', 'b', 'store'), ownerUid: UID });
    for (const d of ['a', 'a/b', 'a/b/store']) assert.equal(mode(join(env.base, d)), 0o755, d);
  } finally { process.umask(old); }
});

test('a diary append that fails partway is cut back, so the next write reads back (0b-2 audit MIN-7)', () => {
  const env = setup({ prefix: 'm9-store-' });
  const size = statSync(join(env.root, 'diary.jsonl')).size;
  const broken = openStore({ root: env.root, ownerUid: UID, faultAt: 'append_fails' });
  assert.throws(() => broken.transaction((tx) => tx.commit([{ entity: 'card', id: 'C-1', doc: card() }], { actor: 'test', kind: 'seed' })), /append failed partway/);
  assert.equal(statSync(join(env.root, 'diary.jsonl')).size, size, 'the part-line is gone');
  seed(env, 'card', 'C-2', card());
  assert.equal(env.record.read('card', 'C-2').doc.state, 'draft');
  assert.equal(env.record.read('card', 'C-1'), null);
  for (const l of readFileSync(join(env.root, 'diary.jsonl'), 'utf8').trim().split('\n')) JSON.parse(l);
});

test('a torn line left by another writer is cut before a writer that already recovered appends (0b-2 audit round 2 M-1)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card());   // env.store has now recovered once; later transactions only refresh
  const diary = join(env.root, 'diary.jsonl');
  const size = statSync(diary).size;
  appendFileSync(diary, '{"seq":99,"half a line from a writer that died');
  seed(env, 'card', 'C-2', card());
  assert.equal(env.record.read('card', 'C-2').doc.state, 'draft');
  const lines = readFileSync(diary, 'utf8').trim().split('\n');
  for (const l of lines) JSON.parse(l);
  assert.ok(statSync(diary).size > size, 'the new line was written after the cut');
  // A fresh reader of the whole diary sees both cards and no damage.
  const fresh = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), alert: () => {} });
  assert.equal(fresh.record.read('card', 'C-1').doc.state, 'draft');
  assert.equal(fresh.record.read('card', 'C-2').doc.state, 'draft');
});

test('a short diary write is cut back and refused; a line that reads back wrong moves no document (0b-2 audit round 3 B2, B3)', () => {
  const env = setup({ prefix: 'm9-store-' });
  const diary = join(env.root, 'diary.jsonl');
  const size = statSync(diary).size;
  const short = openStore({ root: env.root, ownerUid: UID, faultAt: 'short_write' });
  assert.throws(() => short.transaction((tx) => tx.commit([{ entity: 'card', id: 'C-1', doc: card() }], { actor: 'test', kind: 'seed' })), /wrote \d+ of \d+ bytes/);
  assert.equal(statSync(diary).size, size, 'the short line is cut back');
  assert.equal(existsSync(docFile(env, 'card', 'C-1')), false);
  const wrong = openStore({ root: env.root, ownerUid: UID, alert: (a) => env.alerts.push(a), faultAt: 'readback_wrong' });
  assert.throws(() => wrong.transaction((tx) => tx.commit([{ entity: 'card', id: 'C-1', doc: card() }], { actor: 'test', kind: 'seed' })), /didn't read back as seq 1/);
  assert.equal(existsSync(docFile(env, 'card', 'C-1')), false, 'no document moved');
  assert.deepEqual(readdirSync(join(env.root, 'tmp')), [], 'no temp file left');
  assert.ok(wrong.damaged(), 'the store stops writing until the owner looks');
});

test('a document at its previous version (a crash before the rename) rolls forward quietly for a writer that already recovered (0b-2 audit round 3 m-A)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card());
  const v1 = readFileSync(docFile(env, 'card', 'C-1'));
  seed(env, 'card', 'C-1', card({ module: 'M2' }));
  writeFileSync(docFile(env, 'card', 'C-1'), v1);
  env.alerts.length = 0;
  must(put(env.record, 'approvals', 'card', 'C-1', { state: 'cancelled', cancel_reason: 'a real write, which checks the file first' }));
  assert.equal(env.record.read('card', 'C-1').doc.module, 'M2');
  assert.deepEqual(env.alerts.filter((a) => a.type === 'tamper'), [], 'no false tamper alert');
  assert.deepEqual(readdirSync(join(env.root, 'quarantine')), []);
});

test('a later version deleted by hand is tamper, not a crash: alerted and quarantined, then restored (0b-2 audit round 4 m-1)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card());
  seed(env, 'card', 'C-1', card({ module: 'M2' }));
  unlinkSync(docFile(env, 'card', 'C-1'));
  env.alerts.length = 0;
  const r = env.record.write({ actor: 'approvals', entity: 'card', id: 'C-1', expectRev: 2, doc: card({ module: 'M2', state: 'cancelled', cancel_reason: 'x' }) });
  assert.equal(r.ok, false);
  assert.ok(env.alerts.some((a) => a.type === 'tamper'), `tamper alerted: ${JSON.stringify(env.alerts)} ${r.reason}`);
  assert.equal(env.record.read('card', 'C-1').doc.module, 'M2', 'restored from the diary');
  // A restart's recover() says the same.
  unlinkSync(docFile(env, 'card', 'C-1'));
  assert.deepEqual(env.store.recover().restored, ['card/C-1']);
});

test('a writer that lost the lock before the commit point writes nothing (0b-2 audit MIN-9)', () => {
  const env = setup({ prefix: 'm9-store-' });
  const lines = env.record.diary().length;
  assert.throws(() => env.store.transaction((tx) => {
    const lockFile = join(env.root, 'lock');
    writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(readFileSync(lockFile, 'utf8')), nonce: 'someone-else' }));
    return tx.commit([{ entity: 'card', id: 'C-1', doc: card() }], { actor: 'test', kind: 'seed' });
  }), /lost the store lock/);
  assert.equal(env.record.diary().length, lines, 'no diary line');
  assert.equal(existsSync(docFile(env, 'card', 'C-1')), false, 'no document');
  assert.deepEqual(readdirSync(join(env.root, 'tmp')), [], 'no temp file left');
});

test('the writer refuses to start as anyone but the store owner (M-7 a), and needs an absolute root (m-6)', () => {
  const env = setup({ prefix: 'm9-store-' });
  assert.throws(() => openStore({ root: env.root, ownerUid: UID + 1 }), /runs only as the store's owner/);
  assert.throws(() => openStore({ root: 'relative/store', ownerUid: UID }), /absolute/);
  assert.throws(() => openStore({ root: env.root }), /owner uid/);
  assert.throws(() => openRecord({ root: env.root, product: PRODUCT, ownerUid: UID + 1, rules: rulesFor() }), /owner/);
});

test('a document edited outside the writer: the next write to it is refused, alerted, quarantined and restored (M-7 b)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card({ head: 'a'.repeat(40) }));
  const f = docFile(env, 'card', 'C-1');
  const good = readFileSync(f, 'utf8');
  writeFileSync(f, good.replace('"draft"', '"merged"'));
  const r = env.record.write({ actor: 'workshop', entity: 'card', id: 'C-1', expectRev: 1, doc: card({ head: 'b'.repeat(40) }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /changed outside the Store Writer/);
  assert.ok(env.alerts.some((a) => a.type === 'tamper' && a.id === 'C-1'));
  assert.equal(readFileSync(f, 'utf8'), good, 'restored from the diary');
  assert.equal(readdirSync(join(env.root, 'quarantine')).length, 1);
  assert.equal(env.record.diary().length, 1, 'no diary line for the refused write');
});

test('a document file with no diary line is corrupt to read, and quarantined on the next write', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  writeFileSync(join(env.root, 'docs', 'card', 'C-9.json'), JSON.stringify({ entity: 'card', id: 'C-9', rev: 1, doc: card({ state: 'merged' }) }));
  const got = env.record.read('card', 'C-9');
  assert.equal(got.corrupt, true);
  assert.ok(env.alerts.some((a) => a.type === 'corrupt_read' && a.id === 'C-9'));
  assert.ok(!env.record.list('card').some((c) => c.id === 'C-9'), 'list leaves it out');
  const r = env.record.write({ actor: 'dispatcher', entity: 'card', id: 'C-9', expectRev: 0, doc: card({ kind: 'fix' }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no diary line/);
  assert.ok(!existsSync(join(env.root, 'docs', 'card', 'C-9.json')));
});

test('recover(): a missing file or the previous version rolls forward quietly; any other change is restored and alerted (R2-m3)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card({ head: 'a'.repeat(40) }));
  const v1 = readFileSync(docFile(env, 'card', 'C-1'));
  seed(env, 'card', 'C-1', card({ head: 'b'.repeat(40) }));
  const v2 = readFileSync(docFile(env, 'card', 'C-1'));
  seed(env, 'ask', 'A-1', { state: 'open', kind: 'question', reask_count: 0 });
  seed(env, 'ask', 'A-2', { state: 'open', kind: 'question', reask_count: 0 });
  writeFileSync(docFile(env, 'card', 'C-1'), v1);                   // the version before: a crash between commit and rename
  unlinkSync(docFile(env, 'ask', 'A-1'));                           // missing: a crash before the rename of a create
  writeFileSync(docFile(env, 'ask', 'A-2'), '{"hand":"edited"}\n');  // anything else: tamper
  writeFileSync(join(env.root, 'docs', 'ask', 'A-3.json'), '{}');    // a file with no diary line
  writeFileSync(join(env.root, 'tmp', '999999-w-dead.json'), 'x');   // a temp file from a dead writer
  writeFileSync(join(env.root, 'tmp', `${process.pid}-w-live.json`), 'x');   // a live writer's temp file stays
  env.alerts.length = 0;
  const rep = env.store.recover();
  assert.deepEqual(rep.rolledForward.sort(), ['ask/A-1', 'card/C-1']);
  assert.deepEqual(rep.restored, ['ask/A-2']);
  assert.deepEqual(rep.quarantined, ['ask/A-3']);
  assert.equal(rep.tempsRemoved, 1);
  assert.deepEqual(readdirSync(join(env.root, 'tmp')), [`${process.pid}-w-live.json`]);
  assert.deepEqual(readFileSync(docFile(env, 'card', 'C-1')), v2);
  assert.deepEqual(env.alerts.filter((a) => a.type === 'tamper').map((a) => a.id).sort(), ['A-2', 'A-3'], 'only the hand edits alert');
});

test('a reader sees the previous version as current until the rename (no false corrupt)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card({ head: 'a'.repeat(40) }));
  const v1 = readFileSync(docFile(env, 'card', 'C-1'));
  seed(env, 'card', 'C-1', card({ head: 'b'.repeat(40) }));
  writeFileSync(docFile(env, 'card', 'C-1'), v1);
  const got = env.record.read('card', 'C-1');
  assert.ok(!got.corrupt);
  assert.equal(got.doc.head, 'b'.repeat(40), 'the diary is the truth');
});

test('a broken diary (a gap or a changed line) marks the store damaged: writes stop and an alert fires', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-1', card());
  seed(env, 'card', 'C-2', card());
  const diary = join(env.root, 'diary.jsonl');
  const lines = readFileSync(diary, 'utf8').trim().split('\n');
  const second = JSON.parse(lines[1]); second.writes[0].doc.state = 'merged';
  writeFileSync(diary, `${lines[0]}\n${JSON.stringify(second)}\n`);
  const fresh = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), alert: (a) => env.alerts.push(a) });
  assert.match(String(fresh.store.damaged()), /doc_hash/);
  const r = fresh.record.write({ actor: 'dispatcher', entity: 'card', id: 'C-3', expectRev: 0, doc: card({ kind: 'fix' }) });
  assert.equal(r.ok, false);
  assert.ok(env.alerts.some((a) => a.type === 'diary_damaged'));
  appendFileSync(diary, '');
});

test('every refused write is logged to refusals.jsonl with an alert, and leaves no diary line', () => {
  const env = setup({ prefix: 'm9-store-' });
  const r = env.record.write({ actor: 'sensors', entity: 'card', id: 'C-1', expectRev: 0, doc: card() });
  assert.equal(r.ok, false);
  const refusals = readFileSync(join(env.root, 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].actor, 'sensors');
  assert.ok(env.alerts.some((a) => a.type === 'refused'));
  assert.equal(env.record.diary().length, 0);
});

test('a lock left by a dead process is broken; one held by a live process is not', () => {
  const env = setup({ prefix: 'm9-store-' });
  writeFileSync(join(env.root, 'lock'), JSON.stringify({ pid: 999999, pid_start: 'x', host: 'mac-a', nonce: 'n1', at: 'x' }));
  seed(env, 'card', 'C-1', card());
  assert.ok(!existsSync(join(env.root, 'lock')));
  writeFileSync(join(env.root, 'lock'), JSON.stringify({ pid: process.ppid, pid_start: null, host: 'mac-a', nonce: 'n2', at: 'x' }));
  const busy = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), host: 'mac-a', lockTimeoutMs: 200 });
  const r = busy.record.write({ actor: 'workshop', entity: 'card', id: 'C-1', expectRev: 1, doc: card({ head: 'c'.repeat(40) }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /store busy/);
  // Another host's lock is never broken, even with a dead-looking pid.
  writeFileSync(join(env.root, 'lock'), JSON.stringify({ pid: 999999, pid_start: 'x', host: 'mac-b', nonce: 'n3', at: 'x' }));
  const r2 = busy.record.write({ actor: 'workshop', entity: 'card', id: 'C-1', expectRev: 1, doc: card({ head: 'c'.repeat(40) }) });
  assert.match(r2.reason, /store busy/);
  unlinkSync(join(env.root, 'lock'));
});
