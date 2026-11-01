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

// The sources themselves (L110 m-7): a read the list doesn't know about fails here, before the Sensors' coverage test
// ever sees it. Comments are left out; string text is kept.
const code = (f) => src(f).split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
const isPrefix = (f) => f.endsWith('-') || f.endsWith('.');
const sensorsFamilyOf = (id) => FACT_FAMILIES.sensors.find((f) => (isPrefix(f) ? id.startsWith(f) : id === f)) ?? null;
// Every string in the text: quoted strings, and each fixed part of a backtick string (the code inside `${…}` is read as
// code, so its strings count too). A walk, not one pattern: a pattern loses its place after a `${…}` and then reads the
// code between strings as strings (L110 r4, the S1 plant). Regular expressions are stepped over, so a quote inside one
// does not open a string.
function literals(text) {
  const out = [];
  let i = 0;
  const quoted = (q) => {
    let v = '';
    while (i < text.length && text[i] !== q && text[i] !== '\n') {
      if (text[i] === '\\') { v += text[i + 1] ?? ''; i += 2; } else { v += text[i]; i += 1; }
    }
    i += 1;
    out.push(v);
  };
  const template = () => {
    let v = '';
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') { v += text[i + 1] ?? ''; i += 2; } else if (text[i] === '$' && text[i + 1] === '{') {
        out.push(v); v = ''; i += 2; walk(true);
      } else { v += text[i]; i += 1; }
    }
    i += 1;
    out.push(v);
  };
  const regex = () => {
    let inClass = false;
    i += 1;
    while (i < text.length && text[i] !== '\n') {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i += 1; return; }
      i += 1;
    }
  };
  function walk(inside) {
    let depth = 0;
    let prev = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
      if (c === "'" || c === '"') { i += 1; quoted(c); prev = c; continue; }
      if (c === '`') { i += 1; template(); prev = c; continue; }
      if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev))) { regex(); prev = '/'; continue; }
      if (inside && c === '{') depth += 1;
      if (inside && c === '}') { if (depth === 0) { i += 1; return; } depth -= 1; }
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
  }
  walk(false);
  return out.filter(Boolean);
}

// The calls that hand back a Sensors reading, and this file's own wrappers around them (one level: `const fresh = (…)
// => prReadingAfter(…)`, `function prFact(…) { … return sensorsFact(…) }`).
const READ_CALLS = ['sensorsFact', 'fromSensors', 'prReadingAfter'];
function blockFrom(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth < 0) return text.slice(at, i); }
  }
  return text.slice(at);
}
function readingBindings(file) {
  const text = code(file);
  const calls = new Set(READ_CALLS);
  for (const m of text.matchAll(/const (\w+) = \([^)]*\) => ([^\n]*)/g)) if (READ_CALLS.some((c) => m[2].includes(`${c}(`))) calls.add(m[1]);
  // A function counts only when it hands the reading back (`return sensorsFact(…)`), not one that only looks at some.
  for (const m of text.matchAll(/function (\w+)\([^)]*\) \{/g)) if (READ_CALLS.some((c) => blockFrom(text, m.index + m[0].length).includes(`return ${c}(`))) calls.add(m[1]);
  // A function handed a reading as its first argument (`readFact(… sensorsFact(…) …)`): its first parameter is one.
  const params = new Set();
  for (const m of text.matchAll(/function (\w+)\((\w+)/g)) {
    if ([...text.matchAll(new RegExp(`\\b${m[1]}\\(([^;]*)`, 'g'))].some((c) => [...calls].some((k) => c[1].includes(`${k}(`)))) params.add(m[2]);
  }
  const out = [];
  for (const m of text.matchAll(/(?:const|let) (\w+) = (?:await )?([^;\n]*)/g)) {
    const expr = m[2].trim();
    const byCall = [...calls].some((k) => expr.startsWith(`${k}(`));
    const byParam = [...params].some((q) => expr.startsWith(`${q}?.doc`) || expr.startsWith(`${q}.doc`));
    if (!byCall && !byParam) continue;
    // A binding that holds the whole entry reads its fields under `doc`.
    const isDoc = byParam || /\??\.doc(\s*\?\?\s*null)?$/.test(expr) || !READ_CALLS.some((c) => expr.startsWith(`${c}(`));
    out.push({ name: m[1], isDoc, scope: blockFrom(text, m.index + m[0].length) });
  }
  return out;
}
function fieldPaths({ name, isDoc, scope }) {
  const paths = [];
  for (const m of scope.matchAll(new RegExp(`(?<![\\w.$])${name}((?:\\??\\.[A-Za-z_]\\w*)+)`, 'g'))) {
    let segs = m[1].split(/\??\./).filter(Boolean);
    if (!isDoc) { if (segs[0] !== 'doc') continue; segs = segs.slice(1); }
    if (segs.length) paths.push(segs);
  }
  return paths;
}
// A path is read from the list when it is a listed field (anything after it is the value's own method, `.slice`), or
// the group a listed field sits in (`week`).
const listed = (segs, fields) => segs.some((_, i) => fields.includes(segs.slice(0, i + 1).join('.')))
  || fields.some((f) => f.startsWith(`${segs.join('.')}.`));

test('L110 m-7: no source here names a Sensors fact id outside READ_FACTS, or reads one straight from the Record', () => {
  const fams = new Set(READ_FACTS.map((f) => f.family));
  const builders = ['PR_FACT', 'USAGE_FACT', 'ACCOUNT_FACT', 'LIMIT_FACT', 'FACTS.'];
  const named = [];
  for (const f of CODE) {
    const text = code(f);
    for (const lit of literals(text)) {
      const fam = sensorsFamilyOf(lit);
      if (fam) named.push(fam);
      assert.ok(!fam || fams.has(fam), `${f} names the Sensors fact "${lit}" (family ${fam}), which READ_FACTS does not list`);
    }
    if (f === 'sensor-facts.mjs') continue;
    for (const m of text.matchAll(/\.read\(\s*'fact'\s*,\s*([^)]*)\)/g)) {
      const arg = m[1].trim();
      const lit = arg.match(/^['"`]([^'"`$]*)/)?.[1];
      const sensors = (lit && sensorsFamilyOf(lit)) || builders.some((b) => arg.startsWith(b));
      assert.ok(!sensors, `${f} reads the Sensors fact ${arg} straight from the Record; a Sensors reading goes through sensorsFact, which checks Sensors made it`);
    }
  }
  assert.ok(named.includes('pr-'), 'the scan sees the literals the code has');
});

test('L110 m-7: every field read from a Sensors reading in the sources is in READ_FACTS for that file', () => {
  let seen = 0;
  for (const file of new Set(READ_FACTS.flatMap((f) => f.readers))) {
    const fields = [...new Set(READ_FACTS.filter((f) => f.readers.includes(file)).flatMap((f) => f.fields))];
    const bindings = readingBindings(file);
    assert.ok(bindings.length > 0, `${file}: the scan found none of its Sensors readings`);
    for (const b of bindings) {
      for (const segs of fieldPaths(b)) {
        seen += 1;
        assert.ok(listed(segs, fields), `${file} reads ${segs.join('.')} from a Sensors reading (${b.name}); READ_FACTS lists only ${fields.join(', ')}`);
      }
    }
  }
  assert.ok(seen >= 12, `the scan saw the field reads (${seen})`);
});

test('the source scan finds a reading, its wrapper and a parameter handed one', () => {
  const t = (f) => readingBindings(f).map((b) => b.name);
  assert.ok(t('merges.mjs').includes('pr'), 'merges: const pr = fresh(…), fresh wraps prReadingAfter');
  assert.ok(t('cleanup.mjs').includes('pr'), 'cleanup: const pr = prFact(…), a function wrapping sensorsFact');
  assert.ok(t('usage.mjs').includes('d'), 'usage: readFact(fact) is handed sensorsFact(…); const d = fact?.doc');
  assert.deepEqual(listed(['week', 'used_pct'], ['week.used_pct']), true);
  assert.deepEqual(listed(['head_sha', 'slice'], ['head_sha']), true);
  assert.deepEqual(listed(['mergeable_state'], ['state']), false);
  // A backtick string with code in it, a regular expression holding a quote, and the string after them (the S1 plant's shape).
  const lits = literals("const m = `card ${id}: ${n} min`; const r = /^'x'$/; if (f(rec, 'power-source')) say(\"it's\");");
  assert.deepEqual(lits, ['card ', ': ', ' min', 'power-source', "it's"]);
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
