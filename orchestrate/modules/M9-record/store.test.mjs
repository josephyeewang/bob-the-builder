// store.test.mjs — R-0b-20: the store's folders and files, its owner, tamper detection, recovery and corrupt reads
// (0b-2 M-4, M-7, R2-m3, m-5, m-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, symlinkSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
    for (const f of ['diary.jsonl', 'refusals.jsonl', 'outbox-seen.jsonl', 'unsent-alerts.jsonl', 'docs/card/C-1.json']) assert.equal(mode(join(env.root, f)), 0o644, f);
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

test('a file placed by hand with a long name is quarantined and alerted; the store keeps taking writes (0b-2 audit round 7 M-1)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  mkdirSync(join(env.root, 'docs', 'report'), { recursive: true });
  writeFileSync(join(env.root, 'docs', 'report', `${'q'.repeat(240)}.json`), '{}');
  mkdirSync(join(env.root, 'docs', 'e'.repeat(200)));
  writeFileSync(join(env.root, 'docs', 'e'.repeat(200), `${'q'.repeat(240)}.json`), '{}');
  const alerts = [];
  const fresh = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: (a) => alerts.push(a), now: () => env.clock.t });
  must(put(fresh.record, 'approvals', 'card', 'C-0', { state: 'cancelled', cancel_reason: 'test' }), 'a write after the odd files');
  assert.equal(alerts.filter((a) => a.type === 'tamper' && a.id === 'q'.repeat(240)).length, 2, 'both alerted with the full name');
  assert.equal(readdirSync(join(env.root, 'quarantine')).length, 2);
  assert.ok(!existsSync(join(env.root, 'docs', 'report', `${'q'.repeat(240)}.json`)));
});

test('odd things in docs/ (folders, links, unreadable files) are moved aside, never followed, and never block a write (0b-2 audit round 8 M1, M2, m2)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  seed(env, 'card', 'C-7', card());
  const docs = join(env.root, 'docs');
  const outside = join(env.root, '..', `outside-${process.pid}-${Date.now()}`);
  mkdirSync(outside);
  writeFileSync(join(outside, 'victim.json'), 'keep me');
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-TEXT');
  mkdirSync(join(docs, 'card', 'sub'));                                  // a folder inside an entity folder
  mkdirSync(join(docs, 'card', 'x.json'));                               // a folder named like a document
  symlinkSync(outside, join(docs, 'evil'));                              // an entity folder that is a link out
  symlinkSync(join(outside, 'secret.txt'), join(docs, 'card', 'L.json'));  // a document that is a link out
  chmodSync(join(docs, 'card', 'C-7.json'), 0o000);                      // an indexed document the owner can't read
  writeFileSync(join(docs, 'card', '.DS_Store'), 'finder');               // Finder's clutter
  const alerts = [];
  const fresh = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: (a) => alerts.push(a), now: () => env.clock.t });
  for (let i = 0; i < 2; i++) must(put(fresh.record, 'approvals', 'card', i ? 'C-7' : 'C-0', { state: 'cancelled', cancel_reason: 'test' }), `write ${i}`);
  assert.equal(readFileSync(join(outside, 'victim.json'), 'utf8'), 'keep me', 'nothing outside the store is deleted');
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE-TEXT');
  const q = readdirSync(join(env.root, 'quarantine'));
  assert.ok(!q.some((n) => { const p = join(env.root, 'quarantine', n); if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isFile()) return false; try { return readFileSync(p, 'utf8') === 'OUTSIDE-TEXT'; } catch { return false; } }), 'no outside text copied in');
  for (const name of ['sub', 'x.json', 'L.json']) assert.ok(!existsSync(join(docs, 'card', name)) && !lstatSafe(join(docs, 'card', name)), `${name} moved aside`);
  assert.ok(!lstatSafe(join(docs, 'evil')), 'the link folder moved aside');
  assert.equal(fresh.record.read('card', 'C-7').doc.state, 'cancelled', 'the unreadable document restored and written');
  assert.ok(existsSync(join(docs, 'card', '.DS_Store')), 'Finder clutter left alone');
  assert.ok(!alerts.some((a) => a.id === '.DS_Store'), 'and not alerted');
  for (const id of ['sub', 'x', 'L', 'C-7']) assert.ok(alerts.some((a) => a.type === 'tamper' && a.id === id), `${id} alerted`);
});
const lstatSafe = (p) => { try { return lstatSync(p); } catch { return null; } };

test('read() of a document whose entity folder is a link reports it corrupt, reading nothing through the link (0b-2 audit round 8 M2)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  const outside = join(env.root, '..', `outside-r-${process.pid}-${Date.now()}`);
  mkdirSync(outside);
  const docs = join(env.root, 'docs');
  writeFileSync(join(outside, 'C-0.json'), readFileSync(join(docs, 'card', 'C-0.json')));   // even a perfect copy out there is not trusted
  renameSync(join(docs, 'card'), join(env.root, 'card-away'));
  symlinkSync(outside, join(docs, 'card'));
  assert.equal(env.record.read('card', 'C-0').corrupt, true);
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

// ---- 0b-2 audit round 9: one check for the whole store folder ----
const outsideDir = (env, tag) => { const d = join(env.root, '..', `outside-${tag}-${process.pid}-${Date.now()}`); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); writeFileSync(join(d, 'victim.json'), 'keep me', { mode: 0o600 }); return d; };
const snapshot = (d) => JSON.stringify(readdirSync(d).sort().map((n) => [n, lstatSync(join(d, n)).mode, lstatSync(join(d, n)).isFile() ? readFileSync(join(d, n), 'utf8') : null]).concat([[d, lstatSync(d).mode]]));
// Written straight, not read first: a read of a stopped store reports the card corrupt, and the test is about the write.
const cancel = (record, id = 'C-0') => record.write({ actor: 'approvals', entity: 'card', id, expectRev: 1, doc: card({ state: 'cancelled', cancel_reason: 'test' }) });
const reopen = (env, alerts = []) => openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: (a) => alerts.push(a), now: () => env.clock.t });

test('a link, FIFO or wrong kind of thing in place of any store name stops the store with an alert naming it, touching nothing outside (round 9 M1-M4, m1-m3)', { timeout: 60000 }, () => {
  const cases = [
    ['docs', 'link-dir'], ['tmp', 'link-dir'], ['quarantine', 'link-dir'],
    ['diary.jsonl', 'link-file'], ['refusals.jsonl', 'link-file'], ['outbox-seen.jsonl', 'link-file'], ['unsent-alerts.jsonl', 'link-file'],
    ['diary.jsonl', 'fifo'], ['outbox-seen.jsonl', 'fifo'], ['refusals.jsonl', 'fifo'], ['unsent-alerts.jsonl', 'fifo'], ['lock', 'fifo'],
    ['diary.jsonl', 'folder'], ['lock', 'folder'], ['tmp', 'file'],
  ];
  for (const [name, how] of cases) {
    const env = setup({ prefix: 'm9-store-' });
    seed(env, 'card', 'C-0', card());
    const out = outsideDir(env, name.replace('.', '_'));
    const target = join(env.root, name);
    if (existsSync(target) || lstatSafe(target)) renameSync(target, join(env.root, '..', `${name}-away-${process.pid}-${Date.now()}`));
    if (how === 'link-dir') symlinkSync(out, target);
    else if (how === 'link-file') symlinkSync(join(out, 'victim.json'), target);
    else if (how === 'fifo') execFileSync('mkfifo', [target]);
    else if (how === 'folder') mkdirSync(target);
    else writeFileSync(target, 'x');
    const before = snapshot(out);
    const r = cancel(env.record);
    assert.equal(r.ok, false, `${name} ${how}: the write is refused`);
    assert.match(r.reason, new RegExp(name.replace('.', '\\.')), `${name} ${how}: the reason names it`);
    assert.ok(env.alerts.some((a) => a.type === 'store_layout' && a.reason.includes(name)), `${name} ${how}: alerted`);
    assert.throws(() => reopen(env), new RegExp(name.replace('.', '\\.')), `${name} ${how}: a fresh writer won't open`);
    assert.equal(snapshot(out), before, `${name} ${how}: nothing outside touched`);
  }
});

test('a document copy that can\'t be put in place after the commit point: the write stands and is alerted, not reported refused (round 9 M7)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  // A test fault, not chflags or chmod: chflags is Mac-only (CI is Linux) and the store resets folder modes itself.
  const alerts = [];
  const broken = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: (a) => alerts.push(a), now: () => env.clock.t, faultAt: 'rename_fails' }).record;
  const before = broken.diary().length;
  must(cancel(broken), 'the write stands');
  assert.equal(broken.diary().length, before + 1);
  assert.ok(alerts.some((a) => a.type === 'doc_copy_failed'));
  assert.equal(readFileSync(join(env.root, 'refusals.jsonl'), 'utf8'), '', 'not logged as a refusal');
  assert.equal(reopen(env).record.read('card', 'C-0').doc.state, 'cancelled', 'the next writer rolls the copy forward from the diary');
});

test('an indexed document replaced by a link to an identical outside copy is never read through (round 9 m4)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  const out = outsideDir(env, 'doclink');
  const doc = join(env.root, 'docs', 'card', 'C-0.json');
  writeFileSync(join(out, 'C-0.json'), readFileSync(doc));
  unlinkSync(doc);
  symlinkSync(join(out, 'C-0.json'), doc);
  assert.equal(env.record.read('card', 'C-0').corrupt, true, 'a perfect copy behind a link is not trusted');
  const before = snapshot(out);
  // The write finds the link, moves it aside as it is and restores the card from the diary: tamper, so this write is refused.
  assert.match(cancel(env.record).reason, /changed outside the Store Writer; restored/);
  assert.equal(snapshot(out), before, 'nothing outside touched');
  assert.equal(env.record.read('card', 'C-0').rev, 1, 'the card reads cleanly again');
  assert.ok(lstatSync(doc).isFile() && !lstatSync(doc).isSymbolicLink(), 'restored as a plain file');
});

test('a read never goes through a linked diary, even one identical to the real one (round 9: the layout check on reads)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  const out = outsideDir(env, 'diarylink');
  const diary = join(env.root, 'diary.jsonl');
  writeFileSync(join(out, 'diary.jsonl'), readFileSync(diary));
  unlinkSync(diary);
  symlinkSync(join(out, 'diary.jsonl'), diary);
  const r = env.record.read('card', 'C-0');
  assert.equal(r?.corrupt, true, 'a perfect copy behind a link is not read');
  assert.ok(env.alerts.some((a) => a.type === 'store_layout' && a.reason.includes('diary.jsonl')), 'alerted, naming the diary');
});

// ---- 0b-2 audit round 10 ----
test('a store file with a second name (a hard link) stops the store; the other file is not changed (round 10 M1)', () => {
  for (const name of ['diary.jsonl', 'refusals.jsonl', 'outbox-seen.jsonl', 'unsent-alerts.jsonl']) {
    const env = setup({ prefix: 'm9-store-' });
    seed(env, 'card', 'C-0', card());
    const out = outsideDir(env, `hl-${name.replace('.', '_')}`);
    const victim = join(out, 'victim.json');
    const target = join(env.root, name);
    unlinkSync(target);
    linkSync(victim, target);
    const before = snapshot(out);
    const r = cancel(env.record);
    assert.equal(r.ok, false, `${name}: the write is refused`);
    assert.ok(env.alerts.some((a) => a.type === 'store_layout' && a.reason.includes(name) && /hard link/.test(a.reason)), `${name}: alerted`);
    assert.throws(() => reopen(env), /hard link/, `${name}: a fresh writer won't open (and makes nothing readable)`);
    assert.equal(snapshot(out), before, `${name}: the other file unchanged, mode and all`);
  }
});

test('ids that differ only in upper/lower case are refused, never share a file (round 10 M2)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  const r = env.record.write({ actor: 'approvals', entity: 'card', id: 'c-0', expectRev: 0, doc: card() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only in upper\/lower case/);
  assert.doesNotMatch(r.reason, /store error/, 'the caller\'s mistake, not the store\'s');
  assert.equal(env.alerts.filter((a) => a.type === 'tamper').length, 0, 'no false tamper alert');
  assert.equal(env.record.read('card', 'C-0').rev, 1, 'the stored card reads cleanly');
  assert.equal(env.record.read('card', 'c-0'), null, 'nothing is stored under the other spelling');
  assert.deepEqual(env.record.list('card').map((c) => c.id), ['C-0']);
});

test('one entity folder recovery can\'t read is skipped with one alert; other writes go on (round 10 m1)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  const sub = join(env.root, 'docs', 'card', 'sub');
  mkdirSync(sub);
  chmodSync(sub, 0o000);
  try {
    const alerts = [];
    const fresh = reopen(env, alerts);
    must(cancel(fresh.record), 'a write elsewhere in the store goes through');
    must(fresh.record.write({ actor: 'approvals', entity: 'card', id: 'C-0', expectRev: 2, doc: card({ state: 'cancelled', cancel_reason: 'again' }) }), 'and the next');
    const skips = alerts.filter((a) => a.type === 'recovery_skipped');
    assert.equal(skips.length, 1, 'one alert, not one per write');
    assert.match(skips[0].reason, /sub/, 'the alert names what is in the way');
    assert.equal(fresh.record.read('card', 'C-0').doc.cancel_reason, 'again', 'the writes went through');
  } finally { chmodSync(sub, 0o755); }
});

test('text comes back exactly as written, escaped once and only once: literal \\n and \\", real newlines and fences (lead item from the outside-text check)', () => {
  const env = setup({ prefix: 'm9-store-' });
  const s = openStore({ root: env.root, ownerUid: UID });
  const body = 'line\\n with a literal backslash-n, a \\" quote, a real\nnewline, and ```a fence```';
  s.transaction((tx) => tx.commit([{ entity: 'fact', id: 'F-1', doc: { body } }], { actor: 'sensors' }));
  assert.equal(s.read('fact', 'F-1').doc.body, body);
  assert.equal(openStore({ root: env.root, ownerUid: UID }).read('fact', 'F-1').doc.body, body, 'and after a fresh open');
  assert.equal(JSON.parse(readFileSync(join(env.root, 'docs', 'fact', 'F-1.json'), 'utf8')).doc.body, body, 'and in the document file');
});

test('a lock with a second name (made by link, its maker killed before the unlink) is normal: a dead one is broken and its temp name cleared (round 11 M1, M2)', () => {
  const env = setup({ prefix: 'm9-store-' });
  seed(env, 'card', 'C-0', card());
  const temp = join(env.root, '.lock-999999-0a1b2c3d4e5f');
  writeFileSync(temp, JSON.stringify({ pid: 999999, pid_start: 'x', host: 'mac-a', nonce: 'n1', at: 'x' }));
  linkSync(temp, join(env.root, 'lock'));
  const alerts = [];
  const fresh = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, host: 'mac-a', alert: (a) => alerts.push(a), now: () => env.clock.t });
  assert.equal(fresh.record.read('card', 'C-0').rev, 1, 'reads are not stopped');
  must(cancel(fresh.record), 'the write goes through');
  assert.equal(alerts.filter((a) => a.type === 'store_layout').length, 0, 'no false layout alert');
  assert.ok(!existsSync(temp), 'the dead maker\'s temp name is cleared');
  assert.ok(!existsSync(join(env.root, 'lock')), 'the lock is free');
});
