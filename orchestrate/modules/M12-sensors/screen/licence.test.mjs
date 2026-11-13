// R-0b-149's two checks: the herdr licence folder is complete, and no screen file reaches the network, a process or a
// file write. Both run as plain *.test.mjs files, so the existing CI job runs them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const herdr = join(here, '..', 'third_party', 'herdr');
const HEADER = 'Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../third_party/herdr/NOTICE.';
const LICENSE_SHA256 = 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4';

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const screenFiles = () => walk(here).filter((p) => p.endsWith('.mjs')).map((p) => relative(here, p));

/** The files a NOTICE lists ("  screen/<file>   from ..."). */
export const noticeFiles = (notice) => [...notice.matchAll(/^ {2}screen\/(\S+)\s+(?:partly )?from \S/gm)].map((m) => m[1]);

/** Every problem with the licence folder; [] when complete. */
export function licenceProblems({ license, notice, files, read }) {
  const out = [];
  if (!license || !/Apache License\s+Version 2\.0, January 2004/.test(license)) out.push('LICENSE missing or not Apache-2.0');
  if (!notice) return [...out, 'NOTICE missing'];
  if (!notice.includes('ee5bfb5041bb3e4a49d591c72308aae3c81ecdde')) out.push('NOTICE does not name the full commit');
  if (!notice.includes('herdr ships no NOTICE file at this commit')) out.push('NOTICE does not record that herdr ships no NOTICE');
  const listed = noticeFiles(notice);
  for (const f of listed) {
    const text = read(f);
    if (text === null) out.push(`NOTICE lists ${f}, which does not exist`);
    else if (!f.endsWith('.test.mjs') && !text.includes(HEADER)) out.push(`${f} lacks its header line`);
  }
  // Every source file under screen/ carries herdr-derived code or is a test of it, so each needs a NOTICE line;
  // only our own checks (this file) and tests that port nothing are exempt.
  const exempt = new Set(['licence.test.mjs', 'waiting.test.mjs']);
  for (const f of files) if (!exempt.has(f) && !listed.includes(f)) out.push(`${f} has no NOTICE line`);
  return out;
}

const readScreen = (f) => (existsSync(join(here, f)) ? readFileSync(join(here, f), 'utf8') : null);
const actual = () => ({
  license: existsSync(join(herdr, 'LICENSE')) ? readFileSync(join(herdr, 'LICENSE'), 'utf8') : null,
  notice: existsSync(join(herdr, 'NOTICE')) ? readFileSync(join(herdr, 'NOTICE'), 'utf8') : null,
  files: screenFiles(),
  read: readScreen,
});

test('the herdr licence folder is complete', async () => {
  assert.deepEqual(licenceProblems(actual()), []);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(readFileSync(join(herdr, 'LICENSE'))).digest('hex'), LICENSE_SHA256, 'LICENSE is the pinned copy');
});

test('the licence check catches each planted gap', () => {
  const a = actual();
  const firstListed = noticeFiles(a.notice)[0];
  const lineOf = a.notice.split('\n').find((l) => l.startsWith(`  screen/${firstListed}`));
  assert.ok(lineOf);
  // A deleted NOTICE line.
  assert.ok(licenceProblems({ ...a, notice: a.notice.replace(`${lineOf}\n`, '') }).some((p) => p.includes('has no NOTICE line')));
  // A deleted LICENSE.
  assert.ok(licenceProblems({ ...a, license: null }).includes('LICENSE missing or not Apache-2.0'));
  // A deleted NOTICE.
  assert.ok(licenceProblems({ ...a, notice: null }).includes('NOTICE missing'));
  // A listed file's header line dropped.
  const read = (f) => (f === 'match.mjs' ? a.read(f).replace(HEADER, '') : a.read(f));
  assert.ok(licenceProblems({ ...a, read }).includes('match.mjs lacks its header line'));
  // A new screen file with no NOTICE line.
  assert.ok(licenceProblems({ ...a, files: [...a.files, 'new-port.mjs'] }).includes('new-port.mjs has no NOTICE line'));
});

// ── Static check: no network, no process, no file writes under screen/ (except tools/, which nothing imports) ──

const FORBIDDEN = [
  [/\bfetch\s*\(/, 'fetch'],
  [/['"](?:node:)?https?['"]/, 'http/https'],
  [/['"](?:node:)?(?:net|tls|dgram|http2)['"]/, 'net'],
  [/['"](?:node:)?child_process['"]/, 'child_process'],
  [/\b(?:writeFile|appendFile|createWriteStream|mkdir|rename|unlink|rm|copyFile|symlink|truncate|open)(?:Sync)?\s*\(/, 'a file write'],
  [/['"](?:node:)?fs(?:\/promises)?['"]/, 'the file system'],
  [/['"][^'"]*(?:\.config\/herdr|agent-detection)[^'"]*['"]/, 'a rules path outside the module'],
  [/\bimport\s*\(/, 'a dynamic import'],
];
const TOOLS_IMPORT = /(?:from\s*|import\s*\(\s*)['"][^'"]*tools\//;

const code = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
/** What a screen file breaks; tests may read files (fs) to check things, but nothing else on the list. */
export function staticProblems(file, text) {
  const body = code(text);
  const out = [];
  const isTest = file.endsWith('.test.mjs');
  if (file.startsWith('tools/') || file === 'licence.test.mjs') return out; // the capture tool; this check's own planted samples
  for (const [re, what] of FORBIDDEN) {
    if (isTest && (what === 'the file system' || what === 'a dynamic import')) continue;
    if (re.test(body)) out.push(`${file} uses ${what}`);
  }
  if (TOOLS_IMPORT.test(body)) out.push(`${file} imports screen/tools/`);
  return out;
}

test('no screen file reaches the network, a process or a file write', () => {
  const files = screenFiles();
  assert.ok(files.includes('match.mjs') && files.includes('waiting.mjs') && files.includes('claude-rules.mjs'), 'the check sees the screen files');
  for (const f of files) assert.deepEqual(staticProblems(f, readScreen(f)), []);
});

test('the static check catches each planted reach', () => {
  const match = readScreen('match.mjs');
  assert.ok(staticProblems('match.mjs', `import https from 'node:https';\n${match}`).includes('match.mjs uses http/https'));
  assert.ok(staticProblems('match.mjs', `import { capture } from './tools/capture.mjs';\n${match}`).includes('match.mjs imports screen/tools/'));
  assert.ok(staticProblems('match.mjs', `${match}\nconst r = await fetch('https://example.invalid');`).includes('match.mjs uses fetch'));
  assert.ok(staticProblems('waiting.mjs', `import { spawn } from 'node:child_process';`).includes('waiting.mjs uses child_process'));
  assert.ok(staticProblems('waiting.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync('x', 'y');`).length >= 2);
  assert.ok(staticProblems('claude-rules.mjs', `const p = '~/.config/herdr/agent-detection/claude.toml';`).includes('claude-rules.mjs uses a rules path outside the module'));
  // The capture tool itself may do all of this.
  assert.deepEqual(staticProblems('tools/capture.mjs', `import { execFile } from 'node:child_process';`), []);
});
