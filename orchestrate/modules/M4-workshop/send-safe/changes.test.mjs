// changes.test.mjs — R-0b-155b: each session's rising change number, what each change records, and the "took" wait
// R-0b-154 will ask. Real files through R-0b-175a's hook store (its own writeStatus), hand-written hook lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStatus } from '../../../wiring/runner-files.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { KEEP_CHANGES, LAUNCH_EVENT, changeNumber, tookSince, withChange } from './changes.mjs';
import { hookStore, nodeHookFs } from './hook-store.mjs';

const T0 = Date.parse('2026-11-13T12:00:00Z');
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

function world() {
  const dir = tempDir('m4-hook-changes-');
  mkdirSync(join(dir, 'hooks'), { mode: 0o700 });
  let t = T0;
  const open = () => hookStore({ dir, fs: nodeHookFs(), saveFile: (f, text, { mode }) => writeStatus(f, text, { mode }), now: () => t });
  const line = (id, x) => { t += 1000; appendFileSync(join(dir, 'hooks', `${id}.jsonl`), `${JSON.stringify({ at: t, ...x })}\n`); };
  return { dir, open, line, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const start = (L) => ({ launchId: L, event: 'session-start', source: 'startup' });
const typed = (L, promptHash, watchdog = true) => ({ launchId: L, event: 'user-prompt-submit', watchdog, promptHash });
const tool = (L, n) => ({ launchId: L, event: 'pre-tool-use', toolName: 'Bash', toolUseId: `t${n}` });

test('R-0b-155b: the change number rises with every line taken, never with a dropped one, and never goes back across a relaunch, a re-add or a runner restart', () => {
  const w = world();
  try {
    const a = w.open();
    a.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' });
    assert.equal(changeNumber(a.store.get('lead-1')), 0);
    w.line('lead-1', start('L1'));
    w.line('lead-1', typed('L1', H1));
    w.line('lead-1', typed('L1', H2)); // the state stays active: still a change, so a "took" wait can see it
    w.line('lead-1', { launchId: 'L0', event: 'stop' }); // an old launch's line: dropped, not numbered
    a.tick();
    let rec = a.store.get('lead-1');
    assert.equal(rec.seq, 3);
    assert.deepEqual(rec.changes.map((c) => [c.seq, c.event]), [[1, 'session-start'], [2, 'user-prompt-submit'], [3, 'user-prompt-submit']]);
    // A runner restart: the number comes back from the saved store and carries on.
    const b = w.open();
    assert.equal(changeNumber(b.store.get('lead-1')), 3);
    w.line('lead-1', tool('L1', 1));
    b.tick();
    assert.equal(b.store.get('lead-1').seq, 4);
    // A relaunch is a change of its own, under the new launch; the number never restarts.
    b.beginLaunch('lead-1', 'L2');
    rec = b.store.get('lead-1');
    assert.equal(rec.seq, 5);
    assert.deepEqual(rec.changes.at(-1), { seq: 5, launchId: 'L2', event: LAUNCH_EVENT, at: rec.changes.at(-1).at });
    w.line('lead-1', start('L2'));
    b.tick();
    assert.equal(b.store.get('lead-1').seq, 6);
    // The same session added again (a fresh record) keeps its number and counts it as a launch.
    b.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L3' });
    assert.equal(b.store.get('lead-1').seq, 7);
    assert.equal(b.store.get('lead-1').changes.at(-1).event, LAUNCH_EVENT);
    assert.equal(w.open().store.get('lead-1').seq, 7, 'saved');
  } finally { w.done(); }
});

test('R-0b-155b: a change records its launch id, the event and (for a prompt) the hash; no prompt text is saved', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('fd-1', { role: 'frontDoor', product: null, launchId: 'L1' });
    w.line('fd-1', start('L1'));
    w.line('fd-1', typed('L1', H1, false));
    w.line('fd-1', { ...tool('L1', 1), promptHash: H2 }); // a hash on another event is not kept
    w.line('fd-1', { launchId: 'L1', event: 'user-prompt-submit', watchdog: false, promptHash: H2, prompt: 'PLANTED-PROMPT-TEXT' }); // refused line
    s.tick();
    const ch = s.store.get('fd-1').changes;
    assert.equal(ch.length, 3);
    assert.deepEqual(Object.keys(ch[1]).sort(), ['at', 'event', 'launchId', 'promptHash', 'seq']);
    assert.deepEqual({ ...ch[1], at: 0 }, { seq: 2, launchId: 'L1', event: 'user-prompt-submit', at: 0, promptHash: H1 });
    assert.equal('promptHash' in ch[2], false);
    for (const f of readdirSync(w.dir)) {
      if (f !== 'hooks') assert.equal(readFileSync(join(w.dir, f), 'utf8').includes('PLANTED-PROMPT-TEXT'), false, f);
    }
    assert.equal(JSON.stringify(withChange({ seq: 0 }, { event: 'user-prompt-submit', launchId: 'L1', at: 1, promptHash: H1, prompt: 'x' })).includes('"prompt"'), false);
  } finally { w.done(); }
});

test('R-0b-155b: a "took" wait sees its own prompt after its start; another prompt, or one before the start, is not it', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('mb-1', { role: 'minibase', product: null, launchId: 'L1' });
    w.line('mb-1', start('L1'));
    w.line('mb-1', typed('L1', H1)); // before the wait: not it
    s.tick();
    const from = changeNumber(s.store.get('mb-1'));
    const wait = { fromSeq: from, launchId: 'L1', promptHash: H1 };
    assert.equal(tookSince(s.getSession('mb-1'), wait), 'pending');
    w.line('mb-1', typed('L1', H2));
    w.line('mb-1', tool('L1', 1));
    assert.equal(tookSince(s.getSession('mb-1'), wait), 'pending');
    w.line('mb-1', typed('L1', H1));
    assert.equal(tookSince(s.getSession('mb-1'), wait), 'took');
    // A restart in the middle: the wait still answers from the saved changes.
    assert.equal(tookSince(w.open().getSession('mb-1'), wait), 'took');
  } finally { w.done(); }
});

test('R-0b-155b: a "took" wait across a relaunch, a session end or a stop is aborted, even if the same prompt then comes', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' });
    w.line('lead-1', start('L1'));
    s.tick();
    const wait = { fromSeq: changeNumber(s.store.get('lead-1')), launchId: 'L1', promptHash: H1 };
    s.beginLaunch('lead-1', 'L2');
    w.line('lead-1', start('L2'));
    w.line('lead-1', typed('L2', H1));
    assert.equal(tookSince(s.getSession('lead-1'), wait), 'aborted', 'relaunched');
    assert.equal(tookSince(s.getSession('lead-1'), { ...wait, launchId: 'L2' }), 'aborted', 'the relaunch itself is after the start');
    // Relaunched to the same launch id: still a launch after the start.
    const rec = s.store.get('lead-1');
    assert.equal(tookSince(withChange(rec, { event: LAUNCH_EVENT, launchId: 'L2', at: 1 }), { fromSeq: rec.seq, launchId: 'L2', promptHash: H1 }), 'aborted');
    // A session end before the prompt.
    const from = changeNumber(s.getSession('lead-1'));
    w.line('lead-1', { launchId: 'L2', event: 'session-end', reason: 'other' });
    assert.equal(tookSince(s.getSession('lead-1'), { fromSeq: from, launchId: 'L2', promptHash: H2 }), 'aborted');
    // A record now under another launch, with no change since the wait's start.
    const now = s.getSession('lead-1');
    assert.equal(tookSince(now, { fromSeq: now.seq, launchId: 'L1', promptHash: H1 }), 'aborted');
    // Gone or terminated.
    assert.equal(tookSince(null, wait), 'aborted');
    assert.equal(tookSince({ ...rec, terminated: true }, { ...wait, launchId: 'L2' }), 'aborted');
  } finally { w.done(); }
});

test('R-0b-155b: when the kept changes can\'t say, the wait reads unknown, never took', () => {
  let rec = { id: 's', launchId: 'L1' };
  for (let i = 0; i < KEEP_CHANGES + 5; i += 1) rec = withChange(rec, { event: 'pre-tool-use', launchId: 'L1', at: i });
  assert.equal(rec.changes.length, KEEP_CHANGES);
  assert.equal(rec.seq, KEEP_CHANGES + 5);
  rec = withChange(rec, { event: 'user-prompt-submit', launchId: 'L1', at: 99, promptHash: H1 });
  assert.equal(tookSince(rec, { fromSeq: 1, launchId: 'L1', promptHash: H1 }), 'unknown', 'its start fell off the list');
  assert.equal(tookSince(rec, { fromSeq: rec.seq - 1, launchId: 'L1', promptHash: H1 }), 'took');
  assert.equal(tookSince({ ...rec, seq: 3 }, { fromSeq: 10, launchId: 'L1', promptHash: H1 }), 'unknown', 'the number went back');
  assert.equal(tookSince({ ...rec, seq: 'x' }, { fromSeq: 10, launchId: 'L1', promptHash: H1 }), 'unknown');
  assert.equal(tookSince({ ...rec, changes: rec.changes.filter((c) => c.seq !== rec.seq - 3) }, { fromSeq: rec.seq - 5, launchId: 'L1', promptHash: H1 }), 'unknown', 'a change missing in the middle');
  assert.throws(() => withChange({ seq: -1 }, { event: 'stop', launchId: 'L1', at: 1 }), /not a whole number/);
  for (const bad of [{ fromSeq: -1 }, { fromSeq: 1.5 }, { launchId: '' }, { promptHash: 'abc' }]) {
    assert.throws(() => tookSince(rec, { fromSeq: 0, launchId: 'L1', promptHash: H1, ...bad }), TypeError, JSON.stringify(bad));
  }
});

test('R-0b-155b: the herdr-derived file carries the R-0b-149 header, and the NOTICE lists it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'changes.mjs'), 'utf8');
  assert.ok(src.includes('Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../../M12-sensors/third_party/herdr/NOTICE.'));
  const notice = join(here, '..', '..', 'M12-sensors', 'third_party', 'herdr', 'NOTICE');
  assert.ok(existsSync(notice));
  assert.match(readFileSync(notice, 'utf8'), /^ {2}M4-workshop\/send-safe\/changes\.mjs\s+from src\/api\/wait\.rs/m);
});
