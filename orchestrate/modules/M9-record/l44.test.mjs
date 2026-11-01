// l44.test.mjs — lead calls L44 and L65: a verdict counts only from the review user's own outbox, and only from a session the
// launcher recorded as a reviewer (or auditor) on that card at that exact head. The planted cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, fstatSync, linkSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setup, product, readyCard, runCard, outboxFile, launch, runnerLaunch, runnerEndedRecord, runnerAsideRecord, CLEAN_CHECKLIST, HEAD, HEAD2, UID, put, must } from './fixtures.test-helper.mjs';
import { headReviews, reviewUserProblem, runnerLaunchFor, runnerLaunches, verdictFromFile } from './outbox.mjs';

const refused = (r, re) => { assert.equal(r.ok, false, 'expected a refusal'); assert.match(r.reason, re); };

function inReview({ treeOf } = {}) {
  const env = setup({ prefix: 'm9-l44-', treeOf });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  must(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD }));
  must(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, outboxFile(env, 'worker', 'S-1', 'handin-1.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`)));
  // A reviewer's pass carries a clean checklist unless the test says otherwise (M9 PASSES, L69).
  const withList = (f) => (f.pass === true && !('checklist' in f) ? { ...f, checklist: CLEAN_CHECKLIST } : f);
  const hdr = (fields, over = {}) => `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: env.record.read('card', 'C-1').rev, fields: withList(fields), ...over })}\n`;
  return { env, hdr };
}

test('L44 planted: a verdict file in a worker\'s outbox is refused at intake', () => {
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  const f = outboxFile(env, 'worker', 'S-1', 'verdict-forged.md', hdr({ head: HEAD, pass: true }));
  refused(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, f), /verdict- is not listed for worker/);
  // Even through the review view, the worker's folder is the worker's: the tag is the folder, never the file's say.
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'S-1', card: 'C-1' }, f), /no outbox folder for reviewer S-1/);
  assert.equal(env.record.list('verdict').length, 0);
  // The launched reviewer has handed nothing in, so the head is not verified (L68: and it is unsettled until it ends).
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /reviewer session R-1 has not ended yet/);
});

test('L44 planted: a verdict naming the wrong head is refused at intake', () => {
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');   // launched on HEAD
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD2, pass: true }))), /no launch of reviewer session R-1 on C-1 at head bbbbbbb/);
  assert.equal(env.record.list('verdict').length, 0);
});

test('L44 planted: a verdict from a session the launcher never recorded is refused at intake', () => {
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-9', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-9', 'verdict-1.md', hdr({ head: HEAD, pass: true }))), /no launch of reviewer session R-9/);
  // A launch as auditor doesn't let the same id hand in as reviewer, nor on another card.
  runnerLaunch(env, 'C-1', 'A-1', 'auditor');
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'A-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'A-1', 'verdict-2.md', hdr({ head: HEAD, pass: true }))), /no launch of reviewer session A-1/);
  assert.equal(env.record.list('verdict').length, 0);
});

test('L44: no verdict is read while the review user is the same Mac user as any other role', () => {
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  refused(env.record.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }))), /not a separate Mac user/);
  assert.equal(reviewUserProblem({ reviewer: 7, worker: 8 }, 'reviewer'), null);
  assert.match(reviewUserProblem({ reviewer: 7, worker: 7 }, 'reviewer'), /shared with worker/);
  assert.match(reviewUserProblem({ worker: 8 }, 'reviewer'), /no review user/);
  assert.match(reviewUserProblem({ reviewer: 0, worker: 8 }, 'reviewer'), /root/);
  assert.match(reviewUserProblem({ reviewer: 7 }, 'worker'), /not a review role/);
});

test('L44: a review outbox folder others can write to is refused', () => {
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  const f = outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }));
  chmodSync(join(env.outRoot, 'reviewer'), 0o777);
  try {
    refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, f), /outbox folder reviewer is writable by others/);
  } finally { chmodSync(join(env.outRoot, 'reviewer'), 0o755); }
  const g = outboxFile(env, 'reviewer', 'R-1', 'verdict-2.md', hdr({ head: HEAD, pass: true }));
  chmodSync(join(env.outRoot, 'reviewer', 'R-1'), 0o775);
  try {
    refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, g), /outbox folder R-1 is writable by others/);
  } finally { chmodSync(join(env.outRoot, 'reviewer', 'R-1'), 0o755); }
});

test('L44: the accepted verdict records the review user, and a verdict without one verifies nothing', () => {
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: false }))), 'a fail');
  runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer');
  assert.equal(env.record.list('verdict')[0].doc.outbox_uid, UID);
  // A pass put in past the outbox (no outbox_uid) doesn't verify: the Record's rows are never read (L68).
  env.store.transaction((tx) => tx.commit([{ entity: 'verdict', id: 'verdict-planted', doc: { session_id: 'R-1', role: 'reviewer', card: 'C-1', head: HEAD, pass: true } }], { actor: 'reviewer:R-1', kind: 'verdict' }));
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /reviewer session R-1 did not pass/);
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-2.md', hdr({ head: HEAD, pass: true }))), /already given its verdict/);
  // L68: a second launch that passes on the same head never outruns the fail.
  runnerLaunch(env, 'C-1', 'R-2');
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-2', 'verdict-3.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer');
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /reviewer session R-1/);
});

// ---- Lead call L65: only the review runner's own launch record makes a verdict count ----

test('L65 planted: a verdict whose only launch is the Dispatcher\'s Record copy is refused, and verifies nothing', () => {
  const { env, hdr } = inReview();
  launch(env, 'C-1', 'R-1');   // the Dispatcher's copy in the Record, no runner record
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }))), /from the review runner \(no launch record for session R-1\)/);
  assert.equal(env.record.list('verdict').length, 0);
  // A verdict put in past the intake, with a Record copy for its launch, still verifies nothing.
  env.store.transaction((tx) => tx.commit([{ entity: 'verdict', id: 'verdict-planted', doc: { session_id: 'R-1', role: 'reviewer', card: 'C-1', head: HEAD, pass: true, outbox_uid: UID } }], { actor: 'reviewer:R-1', kind: 'verdict' }));
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass/);
});

test('L65: the verdict rule reads the runner\'s record again, so a record gone or changed after intake verifies nothing', () => {
  const { env, hdr } = inReview();
  const p = runnerLaunch(env, 'C-1', 'R-1');
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer');
  assert.match(env.record.list('verdict')[0].doc.runner_launch, /^[0-9a-f]{64}$/);
  const text = readFileSync(p, 'utf8');
  unlinkSync(p);
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass/);
  writeFileSync(p, text.replace('"reviewer"', '"auditor"'), { mode: 0o644 });
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass/);
  unlinkSync(p);
  writeFileSync(p, text, { mode: 0o644 });
  must(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
});

test('L65: a runner launch record is read only from a safe file in a safe folder', () => {
  const env = setup({ prefix: 'm9-l65-' });
  const uids = env.reviewUids;
  const q = (over = {}) => runnerLaunchFor({ root: env.launchRoot, uids, role: 'reviewer', card: 'C-1', head: HEAD, sessionId: 'R-1', ...over });
  assert.match(q().reason, /no launch record for session R-1/);
  const p = runnerLaunch(env, 'C-1', 'R-1');
  assert.equal(q().ok, true);
  assert.equal(q().launch.request_id, 'q-R-1');
  // It must match role, card and head.
  assert.match(q({ role: 'auditor' }).reason, /as reviewer, not auditor/);
  assert.match(q({ card: 'C-2' }).reason, /another card/);
  assert.match(q({ head: HEAD2 }).reason, /not bbbbbbb/);
  assert.match(q({ role: 'worker' }).reason, /not a review role/);
  // The file: others may not write it, it is not a link, and it names itself. A second name is no fault (L70 point 1):
  // anyone can make one, and it can't change review's bytes.
  chmodSync(p, 0o666);
  try { assert.match(q().reason, /written by others/); } finally { chmodSync(p, 0o644); }
  linkSync(p, join(env.base, 'second-name'));
  try { assert.equal(q().ok, true, q().reason); } finally { unlinkSync(join(env.base, 'second-name')); }
  symlinkSync(p, join(env.launchRoot, 'R-2.json'));
  assert.match(q({ sessionId: 'R-2' }).reason, /is a link/);
  writeFileSync(join(env.launchRoot, 'R-3.json'), JSON.stringify({ session_id: 'R-1', role: 'reviewer', card: 'C-1', head: HEAD }), { mode: 0o644 });
  assert.match(q({ sessionId: 'R-3' }).reason, /names another session/);
  // The owner: a record not owned by the review user is refused (here the review user is said to be another uid).
  const other = { ...uids, reviewer: UID + 2, auditor: UID + 2 };
  assert.match(q({ uids: other }).reason, /folder is not owned by the review user/);
  assert.match(q({ uids: undefined, uid: UID + 2 }).reason, /folder is not owned by the review user/);
  // The folder: configured, review's own, written by no one else.
  assert.match(q({ root: undefined }).reason, /no review launches folder is configured/);
  assert.match(q({ root: join(env.base, 'nowhere') }).reason, /folder is missing/);
  chmodSync(env.launchRoot, 0o775);
  try { assert.match(q().reason, /folder can be written by others/); } finally { chmodSync(env.launchRoot, 0o755); }
  // The review user is one separate Mac user for both review roles.
  assert.match(q({ uids: { ...uids, auditor: UID + 3 } }).reason, /same review user/);
  assert.match(q({ uids: { ...uids, worker: UID } }).reason, /shared with worker/);
  // The list form keeps the good records and names the bad; a dot file (the runner's half-written temp) is skipped.
  writeFileSync(join(env.launchRoot, '.R-9.json.tmp'), '{', { mode: 0o644 });
  const all = runnerLaunches({ root: env.launchRoot, uids });
  assert.equal(all.ok, true);
  assert.deepEqual(all.launches.map((l) => l.doc.session_id), ['R-1']);
  assert.deepEqual(all.refused.map((r) => r.name).sort(), ['R-2.json', 'R-3.json']);
  assert.match(runnerLaunches({ root: undefined, uids }).reason, /no review launches folder/);
});

// ---- Lead call L66 M1: what a verdict says is read from its file, never from the Record row ----

test('L66 M1 planted: a verdict row flipped to pass while its file says fail verifies nothing; a changed or second file neither', () => {
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const rowsOf = (env) => {
    const ids = {};
    const row = (sid) => { ids[sid] ??= env.record.list('verdict').find((v) => v.doc.session_id === sid).id; return env.record.read('verdict', ids[sid]); };
    const edit = (sid, over) => { const r = row(sid); env.store.transaction((tx) => tx.commit([{ entity: 'verdict', id: r.id, doc: { ...r.doc, ...over } }], { actor: `reviewer:${sid}`, kind: 'verdict' })); };
    return { row, edit, opts: { outboxRoot: env.outRoot, uids: env.reviewUids } };
  };
  // The reviewer said fail; the row (the workers' Mac user can write the Record) is edited to say pass.
  {
    const { env, hdr } = inReview();
    const { row, edit, opts } = rowsOf(env);
    runnerLaunch(env, 'C-1', 'R-1');
    must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: false }))), 'a fail');
    runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer');
    edit('R-1', { pass: true, checklist: { correct: 'clean', well_built: 'clean', works_for_user: 'clean', holds_up: 'clean' } });
    assert.equal(row('R-1').doc.pass, true, 'the row says pass');
    assert.equal(verdictFromFile({ ...opts, row: row('R-1') }).verdict.pass, false, 'the file says fail');
    refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /reviewer session R-1 did not pass/);
  }
  // A real pass. verdictFromFile (still the check of a row, for the runner's "taken" alert) refuses a row whose file
  // changed, another file of the session, or a file in another session's folder. The verify rule reads no row (L68).
  const { env, hdr } = inReview();
  const { row, edit, opts } = rowsOf(env);
  runnerLaunch(env, 'C-1', 'R-2');
  const f2 = outboxFile(env, 'reviewer', 'R-2', 'verdict-2.md', hdr({ head: HEAD, pass: true }));
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, f2), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer');
  const good = readFileSync(f2, 'utf8');
  writeFileSync(f2, `${good} `);
  refused(verdictFromFile({ ...opts, row: row('R-2') }), /not the one handed in/);
  writeFileSync(f2, good);
  const f3 = outboxFile(env, 'reviewer', 'R-2', 'verdict-3.md', hdr({ head: HEAD, pass: true }));
  refused(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, f3), /already given its verdict/);
  edit('R-2', { source_key: `${realpathSync(f3)}\0${sha(f3)}` });
  refused(verdictFromFile({ ...opts, row: row('R-2') }), /more than one verdict file/);
  // Two verdict files in one session: it can't be counted, and that counts as a failure (L68).
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /R-2's verdict can't be counted, so it counts as a failure: more than one verdict file/);
  outboxFile(env, 'reviewer', 'R-1', 'note-1.md', 'another session\'s folder\n');
  edit('R-2', { source_key: `${realpathSync(f2)}\0${sha(f2)}`, session_id: 'R-1' });
  refused(verdictFromFile({ ...opts, row: row('R-2') }), /not directly inside the reviewer outbox of session R-1/);
  edit('R-2', { session_id: 'R-2' });
  unlinkSync(f3);
  const moved = `${f2}.gone`;
  writeFileSync(moved, good); unlinkSync(f2);
  refused(verdictFromFile({ ...opts, row: row('R-2') }), /file not found/);
  writeFileSync(f2, good); unlinkSync(moved);
  assert.equal(verdictFromFile({ ...opts, row: row('R-2') }).ok, true);
  // The control: the one true file back alone verifies, whatever the row says.
  edit('R-2', { pass: false, source_key: 'nothing' });
  must(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
});

test('L68 planted: verified takes the worst verdict: a failing auditor, a launch record that fails its checks, or an ended record for another head holds it back', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const passed = () => {
    const w = inReview();
    runnerLaunch(w.env, 'C-1', 'R-1');
    must(w.env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(w.env, 'reviewer', 'R-1', 'verdict-1.md', w.hdr({ head: HEAD, pass: true }))), 'the reviewer passes');
    runnerEndedRecord(w.env, 'C-1', 'R-1', 'reviewer');
    return w;
  };
  // An auditor that found Material holds it back, even with the reviewer's pass and a later clean auditor.
  {
    const { env, hdr } = passed();
    runnerLaunch(env, 'C-1', 'A-1', 'auditor');
    must(env.review.applyOutbox({ role: 'auditor', sessionId: 'A-1', card: 'C-1' }, outboxFile(env, 'auditor', 'A-1', 'verdict-a1.md', hdr({ head: HEAD, pass: true, material: 2 }))), 'an audit with Material');
    runnerEndedRecord(env, 'C-1', 'A-1', 'auditor');
    runnerLaunch(env, 'C-1', 'A-2', 'auditor');
    must(env.review.applyOutbox({ role: 'auditor', sessionId: 'A-2', card: 'C-1' }, outboxFile(env, 'auditor', 'A-2', 'verdict-a2.md', hdr({ head: HEAD, pass: true, material: 0 }))), 'a later clean audit');
    runnerEndedRecord(env, 'C-1', 'A-2', 'auditor');
    refused(verify(env), /the auditor session A-1 did not pass for head aaaaaaa/);
  }
  // L69 point 3: a launch record that fails its checks refuses only the card it belongs to. One for this card holds it
  // back; one for another card, or one that names no card and no session of this card, does not. The control: gone.
  {
    const { env } = passed();
    const junk = join(env.launchRoot, 'R-7.json');
    writeFileSync(junk, JSON.stringify({ session_id: 'R-7', card: 'C-1', head: HEAD }), { mode: 0o644 });
    refused(verify(env), /the launch record R-7\.json of card C-1 fails its checks, so no review of this card can be counted \(the launch record names no review role\)/);
    unlinkSync(junk);
    writeFileSync(junk, JSON.stringify({ session_id: 'R-7', card: 'C-2', head: HEAD }), { mode: 0o644 });
    must(verify(env), 'a bad record of another card: verified');
  }
  {
    const { env } = passed();
    writeFileSync(join(env.launchRoot, 'R-8.json'), '{', { mode: 0o644 });
    must(verify(env), 'a bad record tied to no card: skipped, verified');
  }
  // Not JSON, but the name is a session of this card (its ended record says so): it refuses this card.
  {
    const { env } = passed();
    runnerEndedRecord(env, 'C-1', 'R-8', 'reviewer', HEAD, { sha: 'none' });
    writeFileSync(join(env.launchRoot, 'R-8.json'), '{', { mode: 0o644 });
    refused(verify(env), /the launch record R-8\.json of card C-1 fails its checks, so no review of this card can be counted \(the launch record is not JSON\)/);
  }
  // A launched reviewer with no verdict file whose ended record names another head is not ended: it can't be counted.
  {
    const { env } = passed();
    runnerLaunch(env, 'C-1', 'R-2');
    refused(verify(env), /reviewer session R-2 has not ended yet/);
    runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer', HEAD2);
    refused(verify(env), /R-2's verdict can't be counted, so it counts as a failure: the ended record of session R-2 is for another role, card or head/);
  }
});

// ---- Lead call L69: silence is a failure, the ended record pins the file, the tree, one PASSES ----

test('L69 planted: a session that ended with no verdict holds the head; only Joe\'s set-aside takes its say away', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-1');
  runnerLaunch(env, 'C-1', 'R-2');
  runnerEndedRecord(env, 'C-1', 'R-2');
  refused(verify(env), /the reviewer session R-2 ended without handing in a verdict, which counts as a failure/);
  runnerAsideRecord(env, 'C-1', 'R-2');
  must(verify(env), 'set aside by Joe: no say');
});

test('L69 planted: only the verdict file the session ended with counts; one written over after, or one left after a silent end, does not', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  {
    const { env, hdr } = inReview();
    runnerLaunch(env, 'C-1', 'R-1');
    const f = outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: false }));
    must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, f), 'a fail');
    runnerEndedRecord(env, 'C-1', 'R-1');
    // The reviewer's user writes over its own file after the end, now saying pass.
    writeFileSync(f, hdr({ head: HEAD, pass: true }));
    refused(verify(env), /R-1's verdict can't be counted, so it counts as a failure: its verdict file changed after the session ended/);
    unlinkSync(f);
    refused(verify(env), /R-1's verdict can't be counted, so it counts as a failure: its verdict file is gone since the session ended/);
  }
  {
    const { env, hdr } = inReview();
    runnerLaunch(env, 'C-1', 'R-1');
    runnerEndedRecord(env, 'C-1', 'R-1');   // ended with no file
    outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }));
    refused(verify(env), /R-1's verdict can't be counted, so it counts as a failure: a verdict file was left after the session ended with none/);
  }
  // A passing file of a session not yet ended does not count, and blocks.
  {
    const { env, hdr } = inReview();
    runnerLaunch(env, 'C-1', 'R-1');
    must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true }))), 'the pass');
    refused(verify(env), /reviewer session R-1 has not ended yet/);
    runnerEndedRecord(env, 'C-1', 'R-1');
    must(verify(env), 'verified');
  }
});

test('L69 planted: a fail covers every head with the same tree; a session on another tree does not', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const T = 'c'.repeat(40);
  const { env, hdr } = inReview();
  // R-1 failed at an earlier head with tree T; the card is now at HEAD, an amend with the same tree.
  runnerLaunch(env, 'C-1', 'R-1', 'reviewer', HEAD2, { tree: T });
  outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD2, pass: false } })}\n`);
  runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer', HEAD2, { tree: T });
  runnerLaunch(env, 'C-1', 'R-2', 'reviewer', HEAD, { tree: T });
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-2', 'verdict-2.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer', HEAD, { tree: T });
  refused(verify(env), /the reviewer session R-1 did not pass/);
  // The control: the earlier session on another tree has no say here.
  const { env: e2, hdr: h2 } = inReview();
  runnerLaunch(e2, 'C-1', 'R-1', 'reviewer', HEAD2, { tree: 'd'.repeat(40) });
  outboxFile(e2, 'reviewer', 'R-1', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD2, pass: false } })}\n`);
  runnerEndedRecord(e2, 'C-1', 'R-1', 'reviewer', HEAD2);
  runnerLaunch(e2, 'C-1', 'R-2', 'reviewer', HEAD, { tree: T });
  must(e2.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(e2, 'reviewer', 'R-2', 'verdict-2.md', h2({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(e2, 'C-1', 'R-2', 'reviewer', HEAD, { tree: T });
  must(verify(e2), 'verified');
});

test('L69 planted: verified uses the one PASSES: a reviewer pass with a material checklist line verifies nothing', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1');
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', hdr({ head: HEAD, pass: true, checklist: { ...CLEAN_CHECKLIST, holds_up: 'material' } }))), 'a pass with a material line');
  runnerEndedRecord(env, 'C-1', 'R-1');
  refused(verify(env), /the reviewer session R-1 did not pass/);
});

// L69 point 4: the head's tree comes from git (`outbox.treeOf`), not only from the launch records at this head, so a
// fail at an earlier head with the same tree counts even when this head's launch record names no tree.
test('L69 planted: the record\'s tree port: a fail at another head with this head\'s tree holds verified back', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const T = 'c'.repeat(40);
  const { env, hdr } = inReview({ treeOf: (card, head) => { assert.equal(card, 'C-1'); return head === HEAD ? T : 'd'.repeat(40); } });
  runnerLaunch(env, 'C-1', 'R-1', 'reviewer', HEAD2, { tree: T });
  outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD2, pass: false } })}\n`);
  runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer', HEAD2, { tree: T });
  // R-2's launch record at HEAD names no tree; only the port can say HEAD's tree is T.
  runnerLaunch(env, 'C-1', 'R-2', 'reviewer', HEAD);
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-2', 'verdict-2.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer', HEAD);
  refused(verify(env), /the reviewer session R-1 did not pass/);
  // A tree the port can't give verifies nothing.
  const { env: e2, hdr: h2 } = inReview({ treeOf: () => { throw new Error('no such commit'); } });
  runnerLaunch(e2, 'C-1', 'R-2', 'reviewer', HEAD);
  must(e2.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(e2, 'reviewer', 'R-2', 'verdict-2.md', h2({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(e2, 'C-1', 'R-2', 'reviewer', HEAD);
  refused(verify(e2), /the tree of head aaaaaaa could not be read \(no such commit\)/);
});

// L70 point 1: a second name made by another user can't change review's bytes, so it is no fault in review's stores.
// The round-2 attack: a worker hard-links a failing verdict (or a failing auditor's launch record) so it can't be
// counted, then a tap would drop its say. Now the fail simply counts.
test('L70 planted: a hard-linked failing verdict, or a failing auditor\'s hard-linked launch record, still counts as a fail', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-1', 'reviewer', HEAD);
  const f = outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: false, notes: 'the loop never ends' } })}\n`);
  runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer', HEAD);
  linkSync(f, join(env.base, 'worker-made-name'));
  runnerLaunch(env, 'C-1', 'R-2', 'reviewer', HEAD);
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-2', 'verdict-2.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer', HEAD);
  const hr = headReviews({ launches: env.launchRoot, outboxRoot: env.outRoot, uids: env.reviewUids, card: 'C-1', head: HEAD });
  assert.deepEqual(hr.sessions.map((x) => [x.session_id, x.problem, x.verdict?.pass]), [['R-1', null, false], ['R-2', null, true]]);
  refused(verify(env), /the reviewer session R-1 did not pass/);
  // A failing auditor whose launch record has a second name: its fail counts, it is no bad record.
  const { env: e2, hdr: h2 } = inReview();
  runnerLaunch(e2, 'C-1', 'R-2', 'reviewer', HEAD);
  must(e2.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(e2, 'reviewer', 'R-2', 'verdict-2.md', h2({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(e2, 'C-1', 'R-2', 'reviewer', HEAD);
  const lp = runnerLaunch(e2, 'C-1', 'A-1', 'auditor', HEAD);
  outboxFile(e2, 'auditor', 'A-1', 'verdict-a.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: false, material: 2 } })}\n`);
  runnerEndedRecord(e2, 'C-1', 'A-1', 'auditor', HEAD);
  linkSync(lp, join(e2.base, 'worker-made-launch-name'));
  const rl = runnerLaunches({ root: e2.launchRoot, uids: e2.reviewUids });
  assert.deepEqual(rl.refused, []);
  refused(verify(e2), /the auditor session A-1 did not pass/);
  // A worker's own outbox still refuses a second name: there the worker owns the file.
  const { env: e3 } = inReview();
  const wf = outboxFile(e3, 'worker', 'S-9', 'handin-9.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'in_review', to_state: 'running' })}\n`);
  linkSync(wf, join(e3.base, 'second'));
  const r = e3.record.applyOutbox({ role: 'worker', sessionId: 'S-9', card: 'C-1' }, wf);
  assert.equal(r.ok, false);
  assert.match(String(r.reason ?? r.error ?? JSON.stringify(r)), /more than one name/);
  // And review's own verdict file may not be writable by others.
  const { env: e4 } = inReview();
  runnerLaunch(e4, 'C-1', 'R-1', 'reviewer', HEAD);
  const f4 = outboxFile(e4, 'reviewer', 'R-1', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: HEAD, pass: true, checklist: CLEAN_CHECKLIST } })}\n`);
  runnerEndedRecord(e4, 'C-1', 'R-1', 'reviewer', HEAD);
  chmodSync(f4, 0o666);
  const h4 = headReviews({ launches: e4.launchRoot, outboxRoot: e4.outRoot, uids: e4.reviewUids, card: 'C-1', head: HEAD });
  assert.match(h4.sessions[0].problem, /file can be written by others than the review user/);
});

// L70 P4: a record's tie to a card is read only when its standing is good. Bytes in a file review does not own say
// nothing, so they can't freeze a card; the same bytes with good standing (a bad head) refuse that card.
test('L70 P4 planted: a launch record review does not own ties to no card; one review owns with a bad head refuses its card', () => {
  const { env } = inReview();
  const p = join(env.launchRoot, 'X-1.json');
  writeFileSync(p, JSON.stringify({ session_id: 'X-1', role: 'reviewer', card: 'C-1', head: HEAD, launched_at: '2026-10-01T12:00:00.000Z' }), { mode: 0o644 });
  const ino = lstatSync(p).ino;
  const fstat = (fd) => { const st = fstatSync(fd); return st.ino === ino ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 5 }) : st; };
  const hr = headReviews({ launches: env.launchRoot, outboxRoot: env.outRoot, uids: env.reviewUids, card: 'C-1', head: HEAD, fstat });
  assert.equal(hr.ok, true, hr.reason);
  assert.deepEqual(hr.skipped.map((x) => x.name), ['X-1.json']);
  assert.match(hr.skipped[0].reason, /not owned by the review user/);
  // The control: review's own record with a bad head is tied to C-1 and refuses it.
  writeFileSync(p, JSON.stringify({ session_id: 'X-1', role: 'reviewer', card: 'C-1', head: 'short' }), { mode: 0o644 });
  const h2 = headReviews({ launches: env.launchRoot, outboxRoot: env.outRoot, uids: env.reviewUids, card: 'C-1', head: HEAD });
  assert.equal(h2.ok, false);
  assert.match(h2.reason, /the launch record X-1\.json of card C-1 fails its checks/);
});

// L70 P7, P8, P12: the set-aside record must say Joe set it aside, and match the session's card, role and head; the
// ended record must name a verdict file in the one format. Each that fails is a problem, which refuses.
test('L70 P7 P8 P12 planted: a set-aside record not by Joe, or for another card, role or head, and an ended record with a bad sha, refuse', () => {
  const write = (dir, sid, doc) => writeFileSync(join(dir, `${sid}.json`), JSON.stringify(doc), { mode: 0o644, flag: 'wx' });
  const aside = (env) => join(env.base, 'set-aside');
  const one = (over, endedOver) => {
    const { env } = inReview();
    runnerLaunch(env, 'C-1', 'R-1', 'reviewer', HEAD);
    if (endedOver) {
      runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer', HEAD, { sha: endedOver });
    } else {
      runnerEndedRecord(env, 'C-1', 'R-1', 'reviewer', HEAD);
      runnerAsideRecord(env, 'C-9', 'R-0');   // makes the folder; another session's
      write(aside(env), 'R-1', { session_id: 'R-1', role: 'reviewer', card: 'C-1', head: HEAD, set_aside_at: '2026-10-01T12:00:00.000Z', by: 'joe', ...over });
    }
    return headReviews({ launches: env.launchRoot, outboxRoot: env.outRoot, uids: env.reviewUids, card: 'C-1', head: HEAD }).sessions[0];
  };
  assert.equal(one({}).aside, true, 'the control: Joe\'s own record sets it aside');
  assert.match(one({ by: 'dispatcher' }).problem, /does not say Joe set it aside/);
  assert.match(one({ set_aside_at: 'soon' }).problem, /does not say Joe set it aside, and when/);
  assert.match(one({ card: 'C-2' }).problem, /for another role, card or head/);
  assert.match(one({ role: 'auditor' }).problem, /for another role, card or head/);
  assert.match(one({ head: HEAD2 }).problem, /for another role, card or head/);
  for (const bad of ['xyz', 'E'.repeat(64), 'e'.repeat(63), 'NONE']) assert.match(one(null, bad).problem, /does not say what verdict file it ended with/, bad);
  assert.equal(one(null, 'none').silent, true, 'the control: none is a silent end');
});

// L70 P11: the record's move to verified takes a silent auditor as a failure, as the Merge Gate does.
test('L70 P11 planted: verified with an auditor that ended silent is refused, as at the gate', () => {
  const verify = (env) => put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' });
  const { env, hdr } = inReview();
  runnerLaunch(env, 'C-1', 'R-2', 'reviewer', HEAD);
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-2', card: 'C-1' }, outboxFile(env, 'reviewer', 'R-2', 'verdict-2.md', hdr({ head: HEAD, pass: true }))), 'the pass');
  runnerEndedRecord(env, 'C-1', 'R-2', 'reviewer', HEAD);
  runnerLaunch(env, 'C-1', 'A-1', 'auditor', HEAD);
  runnerEndedRecord(env, 'C-1', 'A-1', 'auditor', HEAD, { sha: 'none' });
  refused(verify(env), /the auditor session A-1 ended without handing in a verdict, which counts as a failure/);
});
