import test from 'node:test';
import assert from 'node:assert/strict';
import { planPass, planCheckProblem } from './plan-review.mjs';
import { cleanPath } from './plan-fingerprint.mjs';

const F = 'a'.repeat(64); const P = 'b'.repeat(64);
const ids = { card: 'C-1', fingerprint: F, plan_sha256: P, reviewer_session: 'rev-1', author_session: 'lead-1' };
const go = { card: 'C-1', fingerprint: F, planSha256: P };

test('a PASS with trusted ids builds a pass the checker counts', () => {
  const r = planPass({ ok: true, pass: true }, ids);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.pass, { pass: true, material: 0, ...ids });
  assert.equal(planCheckProblem(r.pass, go), null);
});

test('refused: a question, an unread answer, the author reviewing itself, missing or bad ids', () => {
  assert.match(planPass({ ok: true, pass: false, question: '1. Why?' }, ids).reason, /asked a question/);
  assert.match(planPass({ ok: false }, ids).reason, /could not be read/);
  assert.match(planPass(undefined, ids).reason, /could not be read/);
  assert.match(planPass({ ok: true, pass: true }, { ...ids, reviewer_session: 'lead-1' }).reason, /session that wrote it/);
  for (const k of ['reviewer_session', 'author_session']) assert.match(planPass({ ok: true, pass: true }, { ...ids, [k]: '' }).reason, /names its reviewer/);
  assert.match(planPass({ ok: true, pass: true }, { ...ids, card: '' }).reason, /another card/);
  assert.match(planPass({ ok: true, pass: true }, { ...ids, fingerprint: 'x' }).reason, /changed after review/);
  assert.match(planPass({ ok: true, pass: true }, { ...ids, plan_sha256: undefined }).reason, /changed after review/);
  // A truthy pass that is not the boolean true doesn't count.
  assert.equal(planPass({ ok: true, pass: 'PASS' }, ids).ok, false);
});

test('the checker refuses a pass for another go, and any pass not built here', () => {
  const { pass } = planPass({ ok: true, pass: true }, ids);
  assert.match(planCheckProblem(pass, { ...go, card: 'C-2' }), /another card/);
  assert.match(planCheckProblem(pass, { ...go, fingerprint: 'c'.repeat(64) }), /changed after review/);
  assert.match(planCheckProblem(pass, { ...go, planSha256: 'c'.repeat(64) }), /changed after review/);
  assert.match(planCheckProblem({ ...pass, material: 1 }, go), /0 Material/);
  assert.match(planCheckProblem({ ...pass, pass: 'true' }, go), /0 Material/);
  assert.match(planCheckProblem(null, go), /needs a fresh plan reviewer/);
});

test('cleanPath is exported, so a wave check compares the cleaned form', () => {
  assert.equal(cleanPath('./src/a.js'), 'src/a.js');
  assert.equal(cleanPath('src//a.js'), null);
  assert.equal(cleanPath('src/a .js'), null);
});
