// read-facts.test.mjs — LEAD-CALLS L89: READ_FACTS says what this folder reads from the Sensors, and stays true: to
// M9's Sensors families, to the code that reads each field, to the files that read a Sensors fact, to the ids the code
// builds, and to the README's fact table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACT_FAMILIES } from '../M9-record/permissions.mjs';
import { READ_FACTS } from './read-facts.mjs';
import { PR_FACT } from './merges.mjs';
import { USAGE_FACT } from './usage.mjs';
import { ACCOUNT_FACT } from './tick.mjs';
import { FACTS } from './phone-link.mjs';
import { LIMIT_FACT } from './pass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, f), 'utf8');
const CODE = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.includes('.test.') && !f.includes('test-helper'));

test('L89: each family is a Sensors family in M9, listed once, and each field is named by one of its reader files', () => {
  const fams = READ_FACTS.map((f) => f.family);
  assert.equal(new Set(fams).size, fams.length, 'one entry per family');
  for (const f of READ_FACTS) {
    assert.ok(FACT_FAMILIES.sensors.includes(f.family), `${f.family} is a Sensors family in M9`);
    assert.ok(f.fields.length > 0 && f.readers.length > 0, f.family);
    for (const r of f.readers) assert.ok(CODE.includes(r), `${r} is a file in this folder`);
    // A reader may use only some fields (cleanup reads a PR's state, not its head); each field has at least one.
    for (const field of f.fields) {
      const leaf = new RegExp(`\\b${field.split('.').at(-1)}\\b`);
      assert.ok(f.readers.some((r) => leaf.test(src(r))), `no reader of ${f.family} names ${field}`);
    }
  }
});

test('L89: every file here that acts on a Sensors reading is listed as a reader', () => {
  const readers = new Set(READ_FACTS.flatMap((f) => f.readers));
  const callers = CODE.filter((f) => f !== 'sensor-facts.mjs' && /\b(sensorsFact|fromSensors)\(/.test(src(f)));
  assert.ok(callers.length >= 5, `found the readers: ${callers}`);
  for (const f of callers) assert.ok(readers.has(f), `${f} reads a Sensors fact but is not in READ_FACTS`);
});

test('L89: the families are exactly the ids the code reads', () => {
  const ids = [PR_FACT(''), USAGE_FACT(''), ACCOUNT_FACT, ...Object.values(FACTS), LIMIT_FACT('')].sort();
  assert.deepEqual(READ_FACTS.map((f) => f.family).sort(), ids);
});

// '{ a, b: {c, d}, e: true / false }' → ['a', 'b.c', 'b.d', 'e']: a name followed by ':' and a value is one field; one
// followed by ': {' opens a group.
function shapeFields(shape) {
  const out = []; const group = [];
  for (const m of shape.replace(/`/g, '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{|([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}:])|\}/g)) {
    if (m[1]) group.push(m[1]);
    else if (m[2]) out.push([...group, m[2]].join('.'));
    else if (m[0] === '}' && group.length) group.pop();
  }
  return out;
}

test('L89: the README fact table lists, for each M12 fact, the same fields as READ_FACTS', () => {
  const rows = src('README.md').split('\n').filter((l) => /^\| `/.test(l));
  const table = new Map();
  for (const row of rows) {
    const [ids, writer, shape] = row.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, ''));
    if (!/^M12\b/.test(writer ?? '')) continue;
    for (const [, id] of ids.matchAll(/`([^`]+)`/g)) table.set(id.replace(/<[^>]+>$/, ''), shapeFields(shape).sort());
  }
  assert.deepEqual([...table.keys()].sort(), READ_FACTS.map((f) => f.family).sort());
  for (const f of READ_FACTS) assert.deepEqual(table.get(f.family), [...f.fields].sort(), `${f.family}: README and READ_FACTS differ`);
});

test('the shape reader reads nested and value shapes', () => {
  assert.deepEqual(shapeFields('`{ account, observed_at, week: {used_pct, resets_at}, h5: {used_pct, resets_at} }`'),
    ['account', 'observed_at', 'week.used_pct', 'week.resets_at', 'h5.used_pct', 'h5.resets_at']);
  assert.deepEqual(shapeFields('`{ value: true / false / "unknown", observed_at }`'), ['value', 'observed_at']);
});
