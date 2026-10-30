import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutsideJoin, joinCases, JOIN_SOURCES } from './outside-join.mjs';
import { cleanOutside, escapeOutside, SOURCES } from './escape.mjs';
import { makeHistory } from './history.mjs';
import { intakeIdeas } from '../M13-ledger/caught-up.mjs';
import { makeFactWriter } from './facts.mjs';
import { memoryRecord } from '../../shared/record.mjs';

// A git stand-in that answers `log` in whatever format history.mjs asks for (its markers are random per call).
const fakeGit = (subject) => (args) => {
  if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
  const f = args.find((a) => a.startsWith('--format=')).slice(9);
  return f.replace('%H', 'b'.repeat(40)).replace('%an', 'Someone').replace('%aI', '2026-10-30T09:00:00Z')
    .replace('%s', subject).replace('%b', '').concat('README.md\n');
};

test('R-0b-126: every kind the row names has an instruction-shaped planted case, all sources known', () => {
  for (const s of JOIN_SOURCES) {
    assert.ok(SOURCES.includes(s), s);
    assert.ok(joinCases([s]).some((c) => c.instruction && c.text.includes(c.instruction)), s);
  }
  for (const c of joinCases()) assert.equal(cleanOutside(c.text, c.source), c.expect, c.source);
});

test('R-0b-126: M12 and M13\'s own paths (commit subject, idea issue) land in the record in the exact fenced form', async () => {
  const commits = await checkOutsideJoin(({ text }) => ({ record: JSON.stringify(makeHistory({ git: fakeGit(text) }).historyFile()) }),
    ['commit-subject']);
  assert.deepEqual(commits, []);
  // Planted failure: the same path with fencing switched off is caught.
  assert.notDeepEqual(await checkOutsideJoin(({ text }) =>
    ({ record: JSON.stringify(makeHistory({ git: fakeGit(text), prepare: (s) => s }).historyFile()) }), ['commit-subject']), []);
  const rec = memoryRecord();
  let n = 0;
  const ideas = await checkOutsideJoin(async ({ text }) => {
    n += 1;
    const writer = makeFactWriter(rec, { actor: 'ledger' });
    await intakeIdeas({ gh: { listIdeaIssues: async () => [{ number: n, title: 'idea', body: text, user: { id: 7 } }] }, writer, ownerId: '7' });
    return { record: JSON.stringify(rec.read('fact', `idea-issue-${n}`)) };
  }, ['idea-issue']);
  assert.deepEqual(ideas, []);
});

test('R-0b-126: the join check passes a path that fences once, in a JSON record and a plain Lead-input file', async () => {
  const misses = await checkOutsideJoin(({ source, text }) => {
    const fenced = cleanOutside(text, source);
    return { record: JSON.stringify({ kind: 'lesson', body: fenced }), leadInput: `## New since last pass\n${fenced}\n` };
  });
  assert.deepEqual(misses, []);
});

test('R-0b-126: the join check fails each wrong path: raw, unmasked, cleaned twice, or a raw copy beside the fence', async () => {
  const whys = async (land) => new Set((await checkOutsideJoin(land)).map((m) => `${m.where}: ${m.why}`));
  assert.ok((await whys(({ text }) => ({ leadInput: text }))).has('leadInput: the instruction appears outside a fence'));
  assert.ok((await whys(({ text }) => ({ leadInput: text }))).has('leadInput: the exact fenced form is missing'));
  assert.ok((await whys(({ source, text }) => ({ record: escapeOutside(text, source) }))).has('record: a planted fake key survived'));
  assert.ok((await whys(({ source, text }) => ({ record: cleanOutside(cleanOutside(text, source), source) })))
    .has('record: the exact fenced form is missing'));
  const beside = await whys(({ source, text }) => ({ leadInput: `${cleanOutside(text, source)}\n(raw: ${text})` }));
  assert.ok(beside.has('leadInput: the instruction appears outside a fence'));
  assert.ok(beside.has('leadInput: a planted fake key survived'));
  // A lane that writes only one of the two is checked on that one alone.
  assert.deepEqual(await checkOutsideJoin(({ source, text }) => ({ record: cleanOutside(text, source) })), []);
});
