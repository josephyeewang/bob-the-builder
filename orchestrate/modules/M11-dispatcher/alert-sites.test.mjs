// Audit 0b-6 r5 MAT-2, as a class: a cause is marked told only after its alert went through. Every
// write of a told field (`told`, `told_at`, `told_cause`, `told_keys`, `hard_told`, `stop_told`, ...)
// sits inside a `tellThen(` call on the same line; resetting one to false or null is the one exception.
// The old names (marked before the send) are gone. The behavioral sweep is in tick.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const code = () => readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.endsWith('.test-helper.mjs'))
  .map((f) => [f, readFileSync(join(here, f), 'utf8')]);
// A write: `told_x: value` in an object, or `x.told_x = value` (not `==`).
const WRITE = /\b\w*told\w*\s*:(?!:)|\.\w*told\w*\s*=(?!=)/;
const RESET = /\b\w*told\w*\s*(:|=)\s*(false|null)\b/g;

export function untoldWrites(files) {
  const bad = [];
  for (const [f, text] of files) {
    text.split('\n').forEach((line, i) => {
      const body = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''").replace(/\/\/.*$/, '').replace(RESET, '');
      if (WRITE.test(body) && !body.includes('tellThen(')) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

test('r5 MAT-2 sweep: no alert site writes a told field outside tellThen', () => {
  assert.deepEqual(untoldWrites(code()), []);
});

test('r5 MAT-2 sweep: the names marked before the send are gone', () => {
  for (const [f, text] of code()) assert.doesNotMatch(text, /alerted/, f);
});

test('r5 MAT-2 sweep, control: a told write outside tellThen is caught; a reset, a read and a tellThen are not', () => {
  const files = [['x.mjs', [
    "putFact(rec, F, { text, told_at: iso(now) }, 'k');",
    'st.told = true;',
    "await tellThen(alert, t, () => putFact(rec, F, { told_at: iso(now) }, 'k'));",
    'Object.assign(st, { told: false, x: 1 });',
    "if (seen?.told_cause !== cause || st.told === true) return;",
    '// told_at: in a comment',
    "log(`it could not be told: ${e}`); x('told: no');",
  ].join('\n')]];
  assert.deepEqual(untoldWrites(files).map((l) => l.split(':')[1]), ['1', '2']);
});
