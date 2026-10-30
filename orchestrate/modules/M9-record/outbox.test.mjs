// outbox.test.mjs — R-0b-20 / R-0b-22: an AI session's outbox file is read as hostile and applied with its role tag
// (0b-2 M-3, R2-M8 … R2-M10, R2-M12, R3-M3, R3-M4, R3-m7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_ROLES, OUTBOX_KINDS } from '../../shared/record.mjs';
import { MAX_OUTBOX_BYTES, readOutboxFile } from './outbox.mjs';
import { openRecord } from './writer.mjs';
import { HEAD, HEAD2, PRODUCT, UID, leadCard, must, outboxFile, product, put, readyCard, roadmap, runCard, setup } from './fixtures.test-helper.mjs';

const handin = (id, extra = {}) => `${JSON.stringify({ entity: 'card', id, from_state: 'running', to_state: 'in_review', fields: { summary: 'done' }, ...extra })}\n`;
const refusals = (env) => { try { return readFileSync(join(env.root, 'refusals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

// A running card C-1 held by worker session S-1.
function running(env) {
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
}

function refusedCleanly(env, r, pattern) {
  assert.equal(r.ok, false, JSON.stringify(r));
  if (pattern) assert.match(r.reason, pattern);
  assert.ok(env.alerts.some((a) => a.type === 'refused'), 'a refusal alerts');
}

test('unsafe files are refused with no diary line: link, hard link, outside path, other role, oversize, bad header, bad UTF-8', () => {
  const env = setup({ prefix: 'm9-out-' });
  const tag = { role: 'worker', sessionId: 'S-1' };
  const lines = () => env.record.diary().length;
  const before = lines();
  const dir = join(env.outRoot, 'worker', 'S-1');
  mkdirSync(dir, { recursive: true });
  const secret = join(env.base, 'secret.txt');
  writeFileSync(secret, 'not for the record');
  const cases = [];
  symlinkSync(secret, join(dir, 'report-link1.md'));
  cases.push(['a link to a file outside', join(dir, 'report-link1.md'), /not directly inside|link/]);
  const real = outboxFile(env, 'worker', 'S-1', 'report-real.md', 'real');
  symlinkSync(real, join(dir, 'report-link2.md'));
  cases.push(['a link to a file inside', join(dir, 'report-link2.md'), /link/]);
  const hard = outboxFile(env, 'worker', 'S-1', 'report-hard.md', 'hard');
  linkSync(hard, join(env.base, 'hard-other-name'));
  cases.push(['a hard link', hard, /hard link/]);
  cases.push(['a file outside the outbox', secret, /not directly inside/]);
  cases.push(['another role\'s folder', outboxFile(env, 'reviewer', 'S-1', 'report-r.md', 'x'), /not directly inside the worker outbox/]);
  cases.push(['oversize', outboxFile(env, 'worker', 'S-1', 'report-big.md', 'x'.repeat(MAX_OUTBOX_BYTES + 1)), /over 262144/]);
  cases.push(['a header that is not JSON', outboxFile(env, 'worker', 'S-1', 'handin-bad.md', '{not json\n'), /not a JSON header/]);
  const badUtf = join(dir, 'report-utf.md');
  writeFileSync(badUtf, Buffer.from([0x66, 0xff, 0xfe, 0x0a]));
  cases.push(['invalid UTF-8', badUtf, /UTF-8/]);
  cases.push(['an unknown kind', outboxFile(env, 'worker', 'S-1', 'notes-1.md', 'x'), /no outbox kind/]);
  cases.push(['a missing file', join(dir, 'report-none.md'), /not found/]);
  for (const [what, file, pattern] of cases) {
    const r = env.record.applyOutbox(tag, file);
    assert.equal(r.ok, false, `${what}: ${JSON.stringify(r)}`);
    assert.match(r.reason, pattern, what);
  }
  assert.equal(lines(), before, 'no diary line for any refused file');
  assert.equal(refusals(env), cases.length, 'each refusal logged once');
  assert.ok(!JSON.stringify(env.record.list('report')).includes('not for the record'));
});

test('a session folder that is a link, a file of the wrong owner, and a role with no owner are refused (0b-2 audit MIN-5, MIN-9)', () => {
  const env = setup({ prefix: 'm9-out-' });
  const other = outboxFile(env, 'worker', 'S-3', 'report-s3.md', 'from S-3');
  symlinkSync(join(env.outRoot, 'worker', 'S-3'), join(env.outRoot, 'worker', 'S-2'));
  const r = env.record.applyOutbox({ role: 'worker', sessionId: 'S-2' }, join(env.outRoot, 'worker', 'S-2', 'report-s3.md'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /outbox folder S-2 is a link/);
  assert.equal(env.record.list('report').length, 0);
  const tag = { role: 'worker', sessionId: 'S-3' };
  assert.match(readOutboxFile({ outboxRoot: env.outRoot, uids: { worker: UID + 1 }, tag, file: other }).reason, /owned by uid \d+, not the worker outbox owner/);
  assert.match(readOutboxFile({ outboxRoot: env.outRoot, uids: {}, tag, file: other }).reason, /no owner uid configured for worker/);
  assert.equal(readOutboxFile({ outboxRoot: env.outRoot, uids: { worker: UID }, tag, file: other }).ok, true, 'the same file with the right owner');
});

test('every outbox kind × every AI role: applied only for the roles listed (R2-M9)', () => {
  const env = setup({ prefix: 'm9-out-' });
  let n = 0;
  for (const [kind, spec] of Object.entries(OUTBOX_KINDS)) {
    for (const role of AI_ROLES) {
      const sid = `K-${++n}`;
      const text = spec.mode === 'create' ? 'some text' : `${JSON.stringify({ entity: spec.entity, id: 'C-x', card: 'C-x', expectRev: 0 })}\n`;
      const r = env.record.applyOutbox({ role, sessionId: sid, card: 'C-x' }, outboxFile(env, role, sid, `${kind}${n}.md`, text));
      const where = `${kind} from ${role}: ${r.reason}`;
      if (!spec.roles.includes(role)) { assert.equal(r.ok, false, where); assert.match(r.reason, /is not listed for/, where); continue; }
      if (!spec.entity) { assert.equal(r.ok, false, where); assert.match(r.reason, /no record rule yet/, where); continue; }
      if (spec.mode === 'create') {
        assert.equal(r.ok, true, where);
        const doc = env.record.list(spec.entity).find((d) => d.doc.session_id === sid);
        assert.equal(doc.doc.role, role, 'the role comes from the folder');
        assert.equal(doc.doc.kind, kind);
        assert.equal(env.record.diary().at(-1).actor, `${role}:${sid}`, 'the diary names the session');
      } else assert.doesNotMatch(r.reason ?? '', /is not listed for|no outbox kind/, where);
    }
  }
});

test('a file that meets a store error is alerted once and tried again after the repair, not lost (round 3 m-D, round 4 MAT-1)', () => {
  const env = setup({ prefix: 'm9-out-', faultAt: 'readback_wrong' });
  const tag = { role: 'worker', sessionId: 'S-1' };
  const f = outboxFile(env, 'worker', 'S-1', 'report-throws.md', 'body');
  env.alerts.length = 0;
  const first = env.record.applyOutbox(tag, f);
  assert.equal(first.ok, false);
  assert.match(first.reason, /store error.*tried again/);
  const second = env.record.applyOutbox(tag, f);
  assert.equal(second.ok, false, 'still refused while the store is broken');
  assert.notEqual(second.skipped, true, 'not marked seen');
  assert.equal(env.alerts.filter((a) => a.type === 'refused').length, 1, 'one alert, not one per pass');
  // The owner repairs the diary (drops the bad last line); the next pass applies the file.
  const diary = join(env.root, 'diary.jsonl');
  const lines = readFileSync(diary, 'utf8').split('\n').filter(Boolean);
  writeFileSync(diary, lines.slice(0, -1).map((l) => `${l}\n`).join(''));
  const fixed = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: () => {}, now: () => env.clock.t, outbox: { root: env.outRoot, uids: { worker: UID } } });
  must(fixed.record.applyOutbox(tag, f), 'applied after the repair');
  assert.equal(fixed.record.list('report').length, 1);
});

test('a file whose own content throws is refused and marked seen, not tried forever as a store error (round 5 m-1)', () => {
  const env = setup({ prefix: 'm9-out-' });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  const tag = { role: 'reviewer', sessionId: 'R-1', card: 'C-1' };
  const f = outboxFile(env, 'reviewer', 'R-1', 'verdict-odd.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: { toString: 1 }, fields: { head: HEAD, pass: true } })}\n`);
  const first = env.record.applyOutbox(tag, f);
  assert.equal(first.ok, false);
  assert.match(first.reason, /could not be applied/);
  assert.doesNotMatch(first.reason, /store error/);
  assert.equal(env.record.applyOutbox(tag, f).skipped, true, 'marked seen: not tried again');
});

test('a name too long for the disk never reaches the diary, so the store keeps taking writes (0b-2 audit round 6)', () => {
  const env = setup({ prefix: 'm9-out-' });
  product(env);
  const long = 'S'.repeat(248);
  assert.match(env.record.applyOutbox({ role: 'worker', sessionId: long }, outboxFile(env, 'worker', long, 'report-long.md', 'body')).reason, /session id/, 'a session id over 128 is refused');
  const before = env.record.diary().length;
  assert.throws(() => env.store.transaction((tx) => tx.commit([{ entity: 'report', id: 'r'.repeat(240), doc: { text: 'x' } }], { actor: 'test', kind: 'seed' })), /bad entity or id/);
  assert.throws(() => env.store.transaction((tx) => tx.commit([{ entity: '../../x', id: 'r-1', doc: { text: 'x' } }], { actor: 'test', kind: 'seed' })), /bad entity or id/);
  assert.equal(env.record.diary().length, before, 'no diary line');
  const fresh = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: () => {}, now: () => env.clock.t, outbox: { root: env.outRoot, uids: { worker: UID } } });
  must(fresh.record.applyOutbox({ role: 'worker', sessionId: 'S-1' }, outboxFile(env, 'worker', 'S-1', 'report-ok.md', 'body')), 'a fresh writer still writes');
});

test('the same file twice: one document and one diary line; a refused file twice: one alert (R2-M10, R3-m7)', () => {
  const env = setup({ prefix: 'm9-out-' });
  const tag = { role: 'worker', sessionId: 'S-1' };
  const f = outboxFile(env, 'worker', 'S-1', 'report-twice.md', 'once');
  must(env.record.applyOutbox(tag, f));
  const again = env.record.applyOutbox(tag, f);
  assert.equal(again.ok, true);
  assert.equal(again.skipped, true);
  assert.equal(env.record.list('report').length, 1);
  assert.equal(env.record.diary().length, 1);
  // Same content under a new name is a new file (its real path differs).
  must(env.record.applyOutbox(tag, outboxFile(env, 'worker', 'S-1', 'report-twice2.md', 'once')));
  assert.equal(env.record.list('report').length, 2);
  // Changed content at the same path is new too.
  writeFileSync(f, 'twice');
  must(env.record.applyOutbox(tag, f));
  assert.equal(env.record.list('report').length, 3);
  const bad = outboxFile(env, 'worker', 'S-1', 'handin-x.md', 'not json\n');
  env.alerts.length = 0;
  assert.equal(env.record.applyOutbox(tag, bad).ok, false);
  const second = env.record.applyOutbox(tag, bad);
  assert.equal(second.skipped, true);
  assert.equal(env.alerts.filter((a) => a.type === 'refused').length, 1, 'one alert for one refused file');
});

test('a worker may hand in only its own running card, only to in_review (R-0b-22)', () => {
  const env = setup({ prefix: 'm9-out-' });
  running(env);
  readyCard(env, 'C-2');
  const tag = { role: 'worker', sessionId: 'S-1', card: 'C-1' };
  const lines = env.record.diary().length;
  refusedCleanly(env, env.record.applyOutbox(tag, outboxFile(env, 'worker', 'S-1', 'handin-m.md', handin('C-1', { to_state: 'merged' }))), /running → in_review/);
  refusedCleanly(env, env.record.applyOutbox(tag, outboxFile(env, 'worker', 'S-1', 'handin-o.md', handin('C-2'))), /own card/);
  refusedCleanly(env, env.record.applyOutbox({ ...tag, card: 'C-2' }, outboxFile(env, 'worker', 'S-1', 'handin-o2.md', handin('C-2'))), /C-2 is ready, not running/);
  refusedCleanly(env, env.record.applyOutbox(tag, outboxFile(env, 'worker', 'S-1', 'handin-s.md', handin('C-1', { fields: { state: 'merged' } }))), /state is set by the move/);
  refusedCleanly(env, env.record.applyOutbox(tag, outboxFile(env, 'worker', 'S-1', 'handin-h.md', handin('C-1', { fields: { head: HEAD2 } }))), /may not change head/);
  // The refused hand-ins left only outbox_refused facts.
  const added = env.record.diary().slice(lines);
  assert.ok(added.every((l) => l.kind === 'outbox_refused'), added.map((l) => l.kind).join(' '));
  assert.equal(env.record.read('card', 'C-1').doc.state, 'running');
  // A worker can't write the record directly at all.
  assert.equal(env.record.write({ actor: 'worker', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'merged', module: 'M1' } }).ok, false);
});

test('a hand-in after 3 head pushes is accepted; one from another session is refused with an outbox_refused fact (R3-M4)', () => {
  const env = setup({ prefix: 'm9-out-' });
  running(env);
  for (const h of [HEAD, HEAD2, 'c'.repeat(40)]) must(put(env.record, 'workshop', 'card', 'C-1', { head: h }), 'push');
  const other = env.record.applyOutbox({ role: 'worker', sessionId: 'S-2', card: 'C-1' }, outboxFile(env, 'worker', 'S-2', 'handin-1.md', handin('C-1')));
  refusedCleanly(env, other, /S-2 does not hold card C-1/);
  const fact = env.record.list('fact').find((x) => x.doc.type === 'outbox_refused');
  assert.equal(fact.doc.session, 'S-2');
  assert.match(fact.doc.reason, /does not hold/);
  must(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, outboxFile(env, 'worker', 'S-1', 'handin-1.md', handin('C-1'))), 'hand-in');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'in_review');
  assert.equal(c.claim, undefined, 'the claim ends with the hand-in');
  assert.equal(c.summary, 'done');
  assert.equal(env.record.diary().at(-1).actor, 'worker:S-1');
});

test('a hand-in may not clear needs_joe (R2-M12)', () => {
  const env = setup({ prefix: 'm9-out-' });
  product(env);
  readyCard(env, 'C-1', { needs_joe: true });
  runCard(env, 'C-1');
  const r = env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, outboxFile(env, 'worker', 'S-1', 'handin-nj.md', handin('C-1', { fields: { needs_joe: false } })));
  refusedCleanly(env, r, /needs_joe/);
  assert.equal(env.record.read('card', 'C-1').doc.needs_joe, true);
});

test('the Lead: only ordinary and lead_daily_card cards; plan inputs change only in draft (R2-M12, R3-M3)', () => {
  const env = setup({ prefix: 'm9-out-' });
  product(env);
  for (const kind of ['exact_reverse', 'research_copy', 'fix']) {
    const r = roadmap(env, { id: `K-${kind}`, expectRev: 0, fields: { product: PRODUCT, kind, module: 'M1' } });
    refusedCleanly(env, r, new RegExp(`lead may not (create a ${kind} card|set)`));
  }
  must(roadmap(env, { id: 'D-1', expectRev: 0, fields: { product: PRODUCT, kind: 'lead_daily_card', module: 'M1' } }), 'daily card');
  // In draft the Lead may change the plan; after ready it may not.
  leadCard(env, 'C-1');
  must(roadmap(env, { id: 'C-1', expectRev: env.record.read('card', 'C-1').rev, fields: { files: ['src/b.mjs'] } }), 'draft edit');
  readyCard(env, 'C-2');
  const r = roadmap(env, { id: 'C-2', expectRev: env.record.read('card', 'C-2').rev, fields: { files: ['src/other.mjs'] } });
  refusedCleanly(env, r, /may not change files/);
  // A Lead can't move its card past draft by naming a state.
  const r2 = roadmap(env, { id: 'C-1', expectRev: env.record.read('card', 'C-1').rev, to_state: 'ready' });
  refusedCleanly(env, r2, /lead may not move card draft → ready/);
});

test('an ask request is stored as an inert report; it never becomes an ask (R3-M2)', () => {
  const env = setup({ prefix: 'm9-out-' });
  must(env.record.applyOutbox({ role: 'front_door', sessionId: 'F-1' }, outboxFile(env, 'front_door', 'F-1', 'ask-request-1.md', 'please ask the owner')));
  assert.equal(env.record.list('ask').length, 0);
  assert.equal(env.record.list('report')[0].doc.kind, 'ask-request-');
});

test('the role tag decides the actor; a bad tag is refused before any file is read', () => {
  const env = setup({ prefix: 'm9-out-' });
  const f = outboxFile(env, 'worker', 'S-1', 'report-tag.md', 'x');
  assert.match(env.record.applyOutbox({ role: 'dispatcher', sessionId: 'S-1' }, f).reason, /unknown role/);
  assert.match(env.record.applyOutbox({ role: 'worker', sessionId: '../S-1' }, f).reason, /session id/);
  assert.equal(env.record.diary().length, 0);
});
