// read-view.test.mjs — the Record read only (L995, L998, L999): documents, lists and the diary's creator, with the checks
// the review runner's readers had, on a real Record the Store Writer wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIST_ENTITIES, listDocFiles, readDocFile, readMeta, readProductFile, recordView } from './read-view.mjs';
import { docPathOf } from './store.mjs';
import { PRODUCT, UID, leadCard, must, product, setup } from './fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const fact = (env, actor, id, doc) => must(env.record.write({ actor, entity: 'fact', id, expectRev: env.record.read('fact', id)?.rev ?? 0, doc }), id);

function filled() {
  const env = setup({ prefix: 'm9-view-' });
  product(env);
  leadCard(env, 'C-1');
  leadCard(env, 'C-2');
  fact(env, 'sensors', 'usage-acct-1', { account: 'acct-1', at: 1 });
  fact(env, 'dispatcher', 'band-usage', { band: 'green' });
  return env;
}

test('L998: a document, a product and the lists read what the Store Writer wrote, through docPathOf', () => {
  const env = filled();
  const v = { recordRoot: env.root, recordUid: UID };
  assert.equal(docPathOf(env.root, 'card', 'C-1'), join(env.root, 'docs', 'card', 'C-1.json'));
  assert.throws(() => docPathOf(env.root, 'card', '../x'), /bad entity or id/);
  const c = readDocFile({ ...v, entity: 'card', id: 'C-1' });
  assert.equal(c.ok, true);
  assert.deepEqual(c.doc, env.record.read('card', 'C-1').doc);
  assert.equal(c.rev, env.record.read('card', 'C-1').rev);
  const p = readProductFile({ ...v, product: PRODUCT });
  assert.deepEqual(p.doc, { state: 'active' });
  assert.match(readProductFile({ ...v, product: 'nope' }).reason, /no such product/);
  assert.equal(readProductFile({ ...v, product: 'nope' }).missing, true);
  const cards = listDocFiles({ ...v, entity: 'card' });
  assert.deepEqual(cards.docs.map((x) => x.id), ['C-1', 'C-2']);
  assert.deepEqual(cards.unread, []);
  assert.deepEqual(listDocFiles({ ...v, entity: 'product' }).docs.map((x) => x.id), [PRODUCT]);
  assert.deepEqual(LIST_ENTITIES, ['card', 'product', 'merge']);
  // Merges, which an undo's exact reverse reads (M11 undo.mjs mergeOf): none made yet is an empty list, read as the store reads it.
  assert.deepEqual(recordView(v).list('merge'), env.record.list('merge'));
  assert.match(listDocFiles({ ...v, entity: 'fact' }).reason, /not an entity this view lists/);
  assert.match(readDocFile({ ...v, entity: 'go', id: 'x' }).reason, /not an entity this view reads/);
  // Not yet made: docs/session/ until a first session.
  assert.equal(readDocFile({ ...v, entity: 'session', id: 'S-1' }).ok, false);
});

test('L998: a file that fails a check is never read; a list names it unread, and the view refuses rather than drop it', () => {
  const env = filled();
  const v = { recordRoot: env.root, recordUid: UID };
  const rec = recordView(v);
  const f = docPathOf(env.root, 'card', 'C-2');
  const keep = readFileSync(f);
  // A second name for the file (nlink 2).
  const other = join(env.base, 'other.json');
  linkSync(f, other);
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-2' }).reason, /not the Record's own plain file/);
  assert.match(listDocFiles({ ...v, entity: 'card' }).unread.map((u) => `${u.id}: ${u.reason}`).join(), /C-2: its file is not the Record's own plain file/);
  assert.throws(() => rec.list('card'), /can't all be read \(C-2: its file is not the Record's own plain file\)/);
  assert.throws(() => rec.read('card', 'C-2'), /card C-2 can't be read/);
  rmSync(other);
  // Others may write it.
  chmodSync(f, 0o666);
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-2' }).reason, /not the Record's own plain file/);
  chmodSync(f, 0o644);
  // Another user's file (the reader is told another owner).
  assert.match(readDocFile({ recordRoot: env.root, recordUid: UID + 1, entity: 'card', id: 'C-2' }).reason, /not the Record owner's alone/);
  // A link in its place.
  rmSync(f);
  symlinkSync(other, f);
  writeFileSync(other, keep);
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-2' }).reason, /can't be read \(ELOOP\)/);
  rmSync(f);
  writeFileSync(f, keep);
  chmodSync(f, 0o644);
  // Too big; not JSON; another document's id.
  writeFileSync(f, ' '.repeat(1024 * 1024 + 1));
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-2' }).reason, /not the Record's own plain file/);
  writeFileSync(f, '{');
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-2' }).reason, /not JSON/);
  writeFileSync(f, readFileSync(docPathOf(env.root, 'card', 'C-1')));
  assert.equal(readDocFile({ ...v, entity: 'card', id: 'C-2' }).missing, true, 'another card\'s file is no such card');
  writeFileSync(f, keep);
  // The exact name: c-1 is not C-1, even on a disk that ignores case.
  assert.equal(readDocFile({ ...v, entity: 'card', id: 'c-1' }).missing, true);
  assert.equal(rec.read('card', 'c-1'), null);
  // An odd name in the folder is told, not skipped.
  writeFileSync(join(env.root, 'docs', 'card', 'stray.txt'), 'x');
  assert.match(listDocFiles({ ...v, entity: 'card' }).unread[0].reason, /not a document file/);
  rmSync(join(env.root, 'docs', 'card', 'stray.txt'));
  // A folder others may write, or a link for a folder.
  chmodSync(join(env.root, 'docs'), 0o777);
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-1' }).reason, /docs is not the Record owner's alone/);
  assert.match(listDocFiles({ ...v, entity: 'card' }).reason, /docs is not the Record owner's alone/);
  chmodSync(join(env.root, 'docs'), 0o755);
  const cardDir = join(env.root, 'docs', 'card');
  renameSync(cardDir, join(env.base, 'cards'));
  symlinkSync(join(env.base, 'cards'), cardDir);
  assert.match(listDocFiles({ ...v, entity: 'card' }).reason, /card is not a plain folder/);
  rmSync(cardDir);
  renameSync(join(env.base, 'cards'), cardDir);
  assert.deepEqual(rec.list('card').map((x) => x.id), ['C-1', 'C-2']);
});

test('L999: meta answers as openRecord\'s does, from the diary, for a fact the Sensors made and one they did not', () => {
  const env = filled();
  const v = { recordRoot: env.root, recordUid: UID };
  const rec = recordView(v);
  for (const [entity, id] of [['fact', 'usage-acct-1'], ['fact', 'band-usage'], ['card', 'C-1'], ['product', PRODUCT], ['fact', 'none-such']]) {
    const want = env.record.meta(entity, id);
    const got = rec.meta(entity, id);
    assert.deepEqual(got && { ts: got.ts, stateSince: got.stateSince, createdBy: got.createdBy }, want, `${entity}/${id}`);
  }
  assert.equal(rec.meta('fact', 'usage-acct-1').createdBy, 'sensors');
  assert.equal(rec.meta('fact', 'band-usage').createdBy, 'dispatcher');
  // A later write by another keeps the creator, in both.
  fact(env, 'sensors', 'usage-acct-1', { account: 'acct-1', at: 2 });
  assert.equal(rec.meta('fact', 'usage-acct-1').createdBy, env.record.meta('fact', 'usage-acct-1').createdBy);
});

test('L999: a diary cut short or refused answers only what came before it, never "no creator"', () => {
  const env = filled();
  const v = { recordRoot: env.root, recordUid: UID };
  const diary = join(env.root, 'diary.jsonl');
  const whole = readFileSync(diary);
  // A last line being written: what came before is answered; a document not seen yet is refused.
  appendFileSync(diary, '{"seq":99,');
  assert.equal(readMeta({ ...v, entity: 'fact', id: 'usage-acct-1' }).meta.createdBy, 'sensors');
  assert.match(readMeta({ ...v, entity: 'fact', id: 'later' }).reason, /ends in a line cut short after seq \d+, so who created fact\/later can't be told/);
  assert.throws(() => recordView(v).meta('fact', 'later'), /cut short/);
  // A line that is not JSON, or one the Store Writer's own parser refuses (a gap in seq), stops the replay there.
  writeFileSync(diary, Buffer.concat([whole, Buffer.from('not json\n')]));
  assert.match(readMeta({ ...v, entity: 'fact', id: 'later' }).reason, /is not JSON/);
  writeFileSync(diary, Buffer.concat([whole, Buffer.from(`${JSON.stringify({ seq: 999, writes: [{ entity: 'fact', id: 'later' }] })}\n`)]));
  assert.match(readMeta({ ...v, entity: 'fact', id: 'later' }).reason, /refuses \(diary seq 999 after \d+ \(a gap\)\)/);
  assert.equal(readMeta({ ...v, entity: 'card', id: 'C-1' }).ok, true, 'made before the bad line');
  // The first line changed: nothing after it is replayed, so nothing is answered.
  const lines = whole.toString().split('\n');
  const first = JSON.parse(lines[0]); first.writes[0].doc = { forged: true };
  writeFileSync(diary, [JSON.stringify(first), ...lines.slice(1)].join('\n'));
  assert.match(readMeta({ ...v, entity: 'fact', id: 'usage-acct-1' }).reason, /doc_hash doesn't match/);
  // The diary file itself: a link, others may write it, another owner's.
  writeFileSync(diary, whole);
  chmodSync(diary, 0o666);
  assert.match(readMeta({ ...v, entity: 'card', id: 'C-1' }).reason, /diary is not the Record's own plain file/);
  chmodSync(diary, 0o644);
  assert.match(readMeta({ recordRoot: env.root, recordUid: UID + 1, entity: 'card', id: 'C-1' }).reason, /not the Record owner's alone/);
  const elsewhere = join(env.base, 'diary-copy');
  writeFileSync(elsewhere, whole);
  rmSync(diary);
  symlinkSync(elsewhere, diary);
  assert.match(readMeta({ ...v, entity: 'card', id: 'C-1' }).reason, /diary can't be read \(ELOOP\)/);
  rmSync(diary);
  writeFileSync(diary, whole);
  assert.equal(readMeta({ ...v, entity: 'card', id: 'C-1' }).meta.createdBy, env.record.meta('card', 'C-1').createdBy);
});

test('L999: the diary is read in chunks, not whole: lines across chunk edges replay the same', () => {
  const env = setup({ prefix: 'm9-view-big-' });
  product(env);
  // Enough lines to pass many 64 KiB chunks, one fact each with a large body.
  for (let i = 0; i < 40; i++) fact(env, i % 2 ? 'sensors' : 'dispatcher', i % 2 ? `usage-a${i}` : `step-error-x${i}`, { pad: 'p'.repeat(5000 + i * 37) });
  const v = { recordRoot: env.root, recordUid: UID };
  for (let i = 0; i < 40; i++) {
    const id = i % 2 ? `usage-a${i}` : `step-error-x${i}`;
    assert.deepEqual(readMeta({ ...v, entity: 'fact', id }).meta.createdBy, env.record.meta('fact', id).createdBy, id);
  }
});

test('L998: the view writes nothing, and a Record not made yet is an answer, not made here', () => {
  const base = tempDir('m9-view-none-');
  const root = join(base, 'store');
  const v = { recordRoot: root, recordUid: UID };
  assert.match(readDocFile({ ...v, entity: 'card', id: 'C-1' }).reason, /store is missing/);
  assert.match(readMeta({ ...v, entity: 'card', id: 'C-1' }).reason, /store is missing/);
  mkdirSync(join(root, 'docs'), { recursive: true, mode: 0o755 });
  chmodSync(root, 0o755); chmodSync(join(root, 'docs'), 0o755);
  assert.deepEqual(listDocFiles({ ...v, entity: 'card' }), { ok: true, docs: [], unread: [] });
  assert.match(readMeta({ ...v, entity: 'card', id: 'C-1' }).reason, /diary can't be read \(ENOENT\)/);
  assert.throws(() => listDocFiles({ ...v, entity: 'card' }) && readFileSync(join(root, 'docs', 'card')), /ENOENT/);
});
