// paths.test.mjs — the pattern language M10 and the GitHub-side checker share (spec review 0b-1, MAT-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, compileList, pathProblem, PROTECTED_FLOOR } from './paths.mjs';

test('** matches zero or more whole segments; * stays inside one segment', () => {
  const m = compile('docs/research/**');
  assert.ok(m('docs/research/x.md'));
  assert.ok(m('docs/research/a/b/c.md'));
  assert.ok(!m('docs/researchx/a.md'));
  assert.ok(!m('docs/blueprintx/a.md') && !compile('docs/blueprint/**')('docs/blueprintx/a.md'));
  assert.ok(compile('docs/*.md')('docs/a.md'));
  assert.ok(!compile('docs/*.md')('docs/sub/a.md'));
  assert.ok(compile('next.config.*')('next.config.mjs'));
});

test('a bare name matches that segment at any depth, as a file or a folder', () => {
  const m = compile('vercel.{json,ts}');
  assert.ok(m('vercel.json'));
  assert.ok(m('sub/dir/vercel.ts'));
  assert.ok(!m('sub/dir/vercel.tsx'));
  assert.ok(compile('.mcp.json')('a/b/.mcp.json'));
});

test('a trailing / is a folder entry: bare names at any depth, longer ones anchored', () => {
  assert.ok(compile('.claude/')('.claude/settings.json'));
  assert.ok(compile('.claude/')('packages/web/.claude/agents/x.md'));
  assert.ok(compile('db/repairs/')('db/repairs/2026-10-01.sql'));
  assert.ok(!compile('db/repairs/')('lib/db/repairs/x.sql'));
});

test('matching ignores case and Unicode form, as the Mac file system does', () => {
  const m = compileList(PROTECTED_FLOOR);
  assert.ok(m('.CLAUDE/settings.json'));
  assert.ok(m('Docs/Blueprint/Decided.yaml'));
  const nfd = 'café/x.md'; const nfc = 'café/x.md';
  assert.ok(compile(`${nfc}`)(nfd));
});

test('bad paths match nothing and are reported', () => {
  for (const p of ['', '/abs/x', 'a//b', 'a/../b', './a', 'a\\b', 'a\0b', 42]) {
    assert.ok(pathProblem(p), `expected a problem for ${JSON.stringify(p)}`);
    assert.equal(compile('**')(p), false);
  }
  assert.equal(pathProblem('docs/a.md'), null);
});

test('a path with a non-ASCII letter is refused: the Mac treats look-alikes as the same file (audit minor 1)', () => {
  for (const p of ['.mcp.j\u017fon', 'orche\u017ftrate/policy.yaml', 'AGENT\u017f.md', 'docs/stra\u00dfe.md', 'docs/\ufb01le.md', 'docs/caf\u00e9.md', 'docs/a\tb.md']) {
    assert.match(pathProblem(p), /non-ASCII/, JSON.stringify(p));
  }
});

test('an unreadable pattern throws, so the validator can call the file corrupt', () => {
  assert.throws(() => compile(''));
  assert.throws(() => compile('a/{b,c'));
  assert.throws(() => compile('a//b'));
});

test('the protected floor covers the agent-instruction and deploy files', () => {
  const m = compileList(PROTECTED_FLOOR);
  for (const p of ['orchestrate/policy.yaml', '.github/workflows/a.yml', 'pkg/AGENTS.md', 'CLAUDE.md',
    'vercel.json', 'apps/site/vercel.mjs', 'tests/exit/a.test.mjs', 'docs/blueprint/exit-tests.yaml', '.codex/x']) {
    assert.ok(m(p), p);
  }
  for (const p of ['docs/research/x.md', 'app/page.tsx']) assert.equal(m(p), null, p);
});

test('a long run of ** stays fast (no runaway backtracking)', () => {
  const m = compile('**/**/**/**/**/**/z');
  const path = Array(200).fill('a').join('/');
  const t = Date.now();
  assert.equal(m(path), false);
  assert.ok(Date.now() - t < 500);
});
