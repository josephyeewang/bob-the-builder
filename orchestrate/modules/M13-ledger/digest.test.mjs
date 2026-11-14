// digest.test.mjs — R-1-29: the digest built from one planted day's diary lists every merge, wait (who / what / since)
// and flag, and every number in it, recomputed from the diary a second way, matches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { change, recWith, setClock } from '../M11-dispatcher/fixtures.test-helper.mjs';
import { digestOf, digestText } from './digest.mjs';

const DAY = Date.parse('2026-11-12T00:00:00Z');
const END = DAY + 24 * 3600_000;
const NOW = END + 6.5 * 3600_000; // the morning after
const at = (h) => new Date(DAY + h * 3600_000).toISOString();

// The planted day: three merges inside it (one later flagged by the audit, inside it too), one the day before and one
// the day after; two cards waiting that began inside the day, one waiting since before it, one ask.
function plantedDay() {
  const rec = recWith([
    ['merge', 'MG-0', { state: 'merged', card: 'C-0', pr: 10, changed_at: at(-3) }],
    ['merge', 'MG-1', { state: 'merged', card: 'C-1', pr: 11, changed_at: at(9) }],
    ['merge', 'MG-2', { state: 'merged', card: 'C-2', pr: 12, changed_at: at(13.5) }],
    ['merge', 'MG-3', { state: 'merged', card: 'C-3', pr: 13, changed_at: at(23.99) }],
    ['merge', 'MG-4', { state: 'merged', card: 'C-4', pr: 14, changed_at: at(24) }],
    ['card', 'C-5', { state: 'waiting', wait: { who: 'joe', what: 'go on the plan', since: at(8) }, changed_at: at(8) }],
    ['card', 'C-6', { state: 'waiting', wait: { who: 'usage', what: 'the weekly allowance', since: at(20) }, changed_at: at(20) }],
    ['card', 'C-7', { state: 'waiting', wait: { who: 'joe', what: 'Approve PR 9', since: at(-30) }, changed_at: at(-30) }],
    ['ask', 'A-8', { state: 'pushed', wait: { who: 'joe', what: 'Undo PR 12?', since: at(15) }, changed_at: at(15) }],
  ], { now: DAY });
  setClock(rec, Date.parse(at(16)));
  change(rec, 'merge', 'MG-2', { state: 'audit_flagged' });
  setClock(rec, DAY);
  return rec;
}

/** The second way: a plain replay of the diary, by its own reading of times and its own window test. */
function recount(rec, from, to) {
  const reached = (entity, state) => new Set(rec.diary({ since: 0 })
    .filter((l) => l.entity === entity && l.to_state === state && new Date(l.ts) >= new Date(from) && new Date(l.ts) < new Date(to))
    .map((l) => l.id));
  const waits = [];
  for (const e of ['card', 'ask', 'go', 'merge']) for (const { id, doc } of rec.list(e)) if (doc.state === 'waiting' || doc.wait) waits.push({ id, since: doc.wait?.since });
  return {
    merges: reached('merge', 'merged').size,
    flags: reached('merge', 'audit_flagged').size + reached('card', 'reverted').size,
    waiting: waits.length,
    waiting_began: waits.filter((w) => w.since >= new Date(from).toISOString() && w.since < new Date(to).toISOString()).length,
  };
}

test('R-1-29: the planted day\'s digest lists every merge, flag and wait (who / what / since), and nothing outside the day', () => {
  const rec = plantedDay();
  const d = digestOf(rec, { from: DAY, to: END, now: NOW });
  assert.deepEqual(d.merges.map((m) => [m.id, m.card, m.pr]), [['MG-1', 'C-1', 11], ['MG-2', 'C-2', 12], ['MG-3', 'C-3', 13]]);
  assert.deepEqual(d.flags.map((f) => [f.entity, f.id, f.at]), [['merge', 'MG-2', at(16)]]);
  assert.deepEqual(d.waiting.map((w) => [w.id, w.who, w.what, w.since, w.began_in_window]), [
    ['C-7', 'joe', 'Approve PR 9', at(-30), false],
    ['C-5', 'joe', 'go on the plan', at(8), true],
    ['A-8', 'joe', 'Undo PR 12?', at(15), true],
    ['C-6', 'usage', 'the weekly allowance', at(20), true],
  ]);
  assert.deepEqual(d.errors, []);
  const text = digestText(d);
  for (const s of ['Merged (3)', 'MG-1: card C-1, PR 11', 'Flags (1)', 'merge MG-2: the post-merge audit flagged it',
    'Waiting now, 3 of them since this window (4)', 'card C-6: waits on usage for the weekly allowance, since ' + at(20),
    'ask A-8: waits on joe for Undo PR 12?', 'Record errors (0)']) assert.ok(text.includes(s), s);
  for (const s of ['MG-0', 'MG-4']) assert.ok(!text.includes(s), `${s} is outside the day`);
});

test('R-1-29: every number in the digest, recomputed from the diary a second way, matches', () => {
  const rec = plantedDay();
  for (const [from, to] of [[DAY, END], [DAY - 24 * 3600_000, DAY], [END, END + 24 * 3600_000], [DAY + 12 * 3600_000, DAY + 14 * 3600_000]]) {
    const d = digestOf(rec, { from, to, now: NOW + 24 * 3600_000 });
    const again = recount(rec, from, to);
    assert.deepEqual({ merges: d.counts.merges, flags: d.counts.flags, waiting: d.counts.waiting, waiting_began: d.counts.waiting_began }, again, new Date(from).toISOString());
    // The text copies each number: the sections' counts are the counts.
    const text = digestText(d);
    assert.ok(text.includes(`Merged (${again.merges})`) && text.includes(`Flags (${again.flags})`) && text.includes(`(${again.waiting})`));
  }
  assert.deepEqual(recount(rec, DAY, END), { merges: 3, flags: 1, waiting: 4, waiting_began: 3 }, 'the planted day, by hand');
});

// A record stand-in holding lines the Record refuses to write (a hand edit, a bad restore), for the fail-closed reads.
const fakeRec = ({ lines, docs = {}, waiting = [] }) => ({
  diary: () => lines,
  read: (e, id) => docs[`${e}/${id}`] ?? null,
  list: (e) => (e === 'card' ? waiting : []),
});

test('R-1-29 planted: a line whose time can\'t be read, a merge whose entry can\'t be read, and a wait with no who are record errors, never left out', () => {
  const lines = [
    { seq: 1, ts: 'not a time', entity: 'merge', id: 'MG-9', to_state: 'merged' },
    { seq: 2, ts: new Date(NOW + 3600_000).toISOString(), entity: 'card', id: 'C-9', to_state: 'reverted' }, // ahead of the clock
    { seq: 3, ts: at(10), entity: 'merge', id: 'MG-8', to_state: 'merged' },
    { seq: 4, ts: at(11), entity: 'card', id: 'C-10', to_state: 'reverted' },
    { seq: 5, ts: at(12), entity: 'merge', id: 'MG-8', to_state: 'merged' }, // a second line for the same merge
  ];
  const d = digestOf(fakeRec({ lines, docs: { 'merge/MG-8': { id: 'MG-8', corrupt: true, reason: 'bad json' } },
    waiting: [{ id: 'C-11', doc: { state: 'waiting', wait: { what: 'the Mini', since: at(3) } } }] }), { from: DAY, to: END, now: NOW });
  assert.equal(d.counts.record_errors, 4, d.errors.join('\n'));
  assert.match(d.errors[0], /line 1 .*merge MG-9.*can't be read: "not a time"/);
  assert.match(d.errors[1], /line 2 .*card C-9 → reverted/);
  assert.match(d.errors[2], /merge MG-8 reached merged .*can't be read \(bad json\)/);
  assert.match(d.errors[3], /card C-11 is waiting with no who/);
  assert.deepEqual(d.merges.map((m) => m.id), ['MG-8'], 'a merge whose entry can\'t be read still counts');
  assert.deepEqual(d.flags.map((f) => [f.id, f.what]), [['C-10', 'undone']]);
  assert.equal(d.waiting[0].began_in_window, false, 'a wait with a record error is never counted as begun');
  assert.ok(digestText(d).includes('Record errors (4)'));
});

test('R-1-29 planted: a diary that can\'t be read throws, never an empty day; a bad window is refused', () => {
  const broken = { diary: () => { throw new Error('store unreadable'); }, read: () => null, list: () => [] };
  assert.throws(() => digestOf(broken, { from: DAY, to: END, now: NOW }), /store unreadable/);
  for (const bad of [{ from: NaN }, { to: undefined }, { now: '1' }, { from: END, to: DAY }]) {
    assert.throws(() => digestOf(fakeRec({ lines: [] }), { from: DAY, to: END, now: NOW, ...bad }), TypeError, JSON.stringify(bad));
  }
});
