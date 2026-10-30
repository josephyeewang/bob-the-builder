// tmp-guard.test.mjs — the tests in lane 1's folders leave no temp folder behind, pass or fail (lead, 29 Oct 2026:
// leftover test folders filled a Mac's disk). Run: node --test orchestrate/shared/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './test-tmp.mjs';
import { readdirSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const FOLDERS = ['../modules/M10-rules', '../modules/M9-record', '../modules/M2-approvals', '../modules/M6-merge-gate', '.'].map((d) => join(here, d));
const OURS = /^m(10|9|2|6)-/;
const mjs = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((n) => n.endsWith('.mjs')).map((n) => join(dir, n)) : []);
const HELPER = join(here, 'test-tmp.mjs');
// A nested run must not inherit this runner's NODE_TEST_CONTEXT, or it reports to us instead of running the files
// (seen 29 Oct 2026: the whole-run check passed while the files it named left 57 folders).
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };

test('no code in these folders makes a temp folder except through test-tmp.mjs', () => {
  for (const f of FOLDERS.flatMap(mjs)) {
    if (f === HELPER || f === fileURLToPath(import.meta.url)) continue;
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /mkdtemp|tmpdir\s*\(/, `${f} makes its own temp folder; use tempDir() from shared/test-tmp.mjs`);
    if (/\btempDir\(/.test(text)) assert.match(text, /^import \{[^}]*\btempDir\b[^}]*\} from '[./]+(shared\/)?test-tmp\.mjs';$/m, `${f} must import tempDir at the top`);
  }
});

test('a test that fails still removes its temp folder, even one it locked', () => {
  const code = `import { test } from 'node:test';
import { tempDir } from ${JSON.stringify(pathToFileURL(HELPER).href)};
import { writeFileSync, chmodSync } from 'node:fs';
test('planned failure', () => {
  const d = tempDir('m10-guard-');
  writeFileSync(d + '/x.md', 'x'); chmodSync(d + '/x.md', 0o400); chmodSync(d, 0o500);
  console.log('DIR=' + d);
  throw new Error('planned');
});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: cleanEnv() });
  const dir = /DIR=(\S+)/.exec(run.stdout)?.[1];
  assert.ok(dir, run.stdout + run.stderr);
  assert.notEqual(run.status, 0, 'the planned failure fails the run');
  assert.equal(existsSync(dir), false, `${dir} was left behind`);
});

test('a whole run of these folders\' tests leaves no m10-, m9-, m2- or m6- folder in the temp folder', () => {
  const tmp = tempDir('m10-guardrun-');
  const files = FOLDERS.flatMap(mjs).filter((f) => f.endsWith('.test.mjs') && f !== fileURLToPath(import.meta.url));
  assert.ok(files.length >= 10, 'found the test files');
  const run = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env: cleanEnv({ TMPDIR: tmp, TMP: tmp, TEMP: tmp }) });
  assert.equal(run.status, 0, run.stdout.slice(-2000) + run.stderr.slice(-2000));
  assert.deepEqual(readdirSync(tmp).filter((n) => OURS.test(n)), []);
});

test('tempDir only takes a lane-1 prefix, so every folder it makes is one this guard looks for', () => {
  for (const p of ['roles-', 'm10-', 'm10-x', 'x-m10-a-', '../m10-a-', 'm10-a/b-', 7]) assert.throws(() => tempDir(p), String(p));
  // A folder made with the right prefix starts with one the guard checks.
  assert.match(tempDir('m9-check-').split('/').pop(), OURS);
  writeFileSync(join(tempDir('m6-check-'), 'a'), 'a');
  chmodSync(tempDir('m2-check-'), 0o500);
});
