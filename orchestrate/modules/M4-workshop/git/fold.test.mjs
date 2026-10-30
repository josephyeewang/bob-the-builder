// R-0b-47 MAT-3: look-alike letters fold to the plain name, for the push refusals and for the
// worker copy's protected names (one `fold`, in push-refusals.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, refusedPath } from './push-refusals.mjs';
import { isProtectedName } from '../launcher/worker-copy.mjs';

const LOOKALIKES = [
  ['.mcp.jſon', '.mcp.json'], // long s
  ['.ＣＬＡＵＤＥ', '.claude'], // full-width capitals
  ['.cl​aude', '.claude'], // zero-width space
  ['CLAUDE.LOCAL.MD', 'claude.local.md'],
  ['claude.locaⅼ.md', 'claude.local.md'], // the Roman numeral fifty, a look-alike l
];

test('MAT-3: fold maps look-alike letters to the plain name', () => {
  for (const [raw, want] of LOOKALIKES) assert.equal(fold(raw), want, JSON.stringify(raw));
  // A Cyrillic a is a different letter, not a compatibility form: no fold claims it.
  assert.notEqual(fold('.clаude'), '.claude');
});

test('MAT-3: the push refusals refuse look-alike names', () => {
  const cases = [
    ['.mcp.jſon', /\.mcp\.json/],
    ['src/.Ｃlaude/settings.json', /\.claude/],
    ['.github/workflowſ/ci.yml', /workflows/],
    ['.github/ａctions/x/action.yml', /actions/],
    ['vercel.jſon', /Vercel/],
    ['.gitmoduleſ', /gitmodules/],
    ['claude.locaⅼ.md', /claude\.local\.md/],
  ];
  for (const [p, why] of cases) assert.match(refusedPath(p) ?? 'not refused', why, p);
  assert.equal(refusedPath('src/app.js'), null);
});

test('MAT-3: the worker copy protects look-alike names', () => {
  for (const n of ['.mcp.jſon', '.ＣLAUDE', '.cl​aude', 'claude.locaⅼ.md']) assert.equal(isProtectedName(n), true, JSON.stringify(n));
  assert.equal(isProtectedName('readme.md'), false);
});
