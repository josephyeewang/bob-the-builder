// tmp-guard.test.mjs — orchestrate's tests leave no temp folder behind, pass or fail (lead, 29 Oct 2026: leftover
// test folders filled a Mac's disk). Run: node --test orchestrate/shared/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, OURS } from './test-tmp.mjs';
import { readdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');   // orchestrate/
const SELF = fileURLToPath(import.meta.url);
const HELPER = join(here, 'test-tmp.mjs');
const rel = (f) => relative(ROOT, f).split('\\').join('/');
const ALL = readdirSync(ROOT, { recursive: true }).map((n) => join(ROOT, n)).filter((f) => f.endsWith('.mjs') && !f.includes('node_modules'));

// Files that still make their own temp folder, with the prefix they use. Each lane deletes its line when it switches
// to tempDir(); the first test fails if a listed file no longer needs the line, so the list can't go stale.
const NOT_SWITCHED_YET = {
};

// A nested run must not inherit this runner's NODE_TEST_CONTEXT, or it reports to us instead of running the files
// (seen 29 Oct 2026: the whole-run check passed while the files it named left 57 folders).
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };

// Test code: a test file, a test helper or fixture, or any file that loads node:test. Only test code is held to
// tempDir(). A production script may make its own run-time folder inside its private folder and remove it in a finally
// or exit handler (LEAD-CALLS L36); the whole-run check below still fails any of those it leaves behind.
const isTestCode = (f) => {
  const r = rel(f);
  const name = r.split('/').pop();
  if (name.endsWith('.test.mjs') || name.startsWith('test-') || name === 'fixtures.mjs') return true;
  if (r.split('/').slice(0, -1).some((d) => d === 'fixtures' || d === 'test' || d === 'tests')) return true;
  return /from\s+['"]node:test['"]/.test(readFileSync(f, 'utf8'));
};

test('isTestCode: tests, helpers and fixtures are test code; production scripts are not', () => {
  const fake = (r) => join(ROOT, r);
  for (const r of ['modules/M1-front-door/round4.test.mjs', 'shared/test-tmp.mjs', 'modules/M1-front-door/fixtures.mjs',
    'modules/M12-sensors/shell-guard/fixtures/naive-hook.mjs', 'test/kit.mjs']) assert.equal(isTestCode(fake(r)), true, r);
  const d = tempDir('orch-kind-');
  writeFileSync(join(d, 'push.mjs'), "import { mkdtempSync } from 'node:fs';\n");
  assert.equal(isTestCode(join(d, 'push.mjs')), false, 'a production script is not test code');
  writeFileSync(join(d, 'kit.mjs'), "import { test } from 'node:test';\n");
  assert.equal(isTestCode(join(d, 'kit.mjs')), true, 'a helper that loads node:test is test code');
});

test('no orchestrate test code makes a temp folder except through test-tmp.mjs (bar the files not switched yet)', () => {
  for (const f of ALL) {
    if (f === HELPER || f === SELF || !isTestCode(f)) continue;
    const text = readFileSync(f, 'utf8');
    const own = /mkdtemp|tmpdir\s*\(/.test(text);
    if (rel(f) in NOT_SWITCHED_YET) assert.ok(own, `${rel(f)} no longer makes its own temp folder: delete its line in NOT_SWITCHED_YET`);
    else assert.ok(!own, `${rel(f)} makes its own temp folder; use tempDir() from shared/test-tmp.mjs`);
    if (/\btempDir\(/.test(text)) assert.match(text, /^import \{[^}]*\btempDir\b[^}]*\} from '[./]+(shared\/)?test-tmp\.mjs';$/m, `${rel(f)} must import tempDir at the top`);
  }
  for (const f of Object.keys(NOT_SWITCHED_YET)) assert.ok(existsSync(join(ROOT, f)), `${f} is gone: delete its line in NOT_SWITCHED_YET`);
});

test('a test that fails still removes its temp folder, even one it locked', () => {
  const code = `import { test } from 'node:test';
import { tempDir } from ${JSON.stringify(pathToFileURL(HELPER).href)};
import { writeFileSync, chmodSync } from 'node:fs';
test('planned failure', () => {
  const d = tempDir('orch-guard-');
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

test('a whole run of every orchestrate suite leaves no lane\'s temp folder behind', () => {
  const tmp = tempDir('orch-guardrun-');
  const files = ALL.filter((f) => f.endsWith('.test.mjs') && f !== SELF);
  assert.ok(files.length >= 10, 'found the test files');
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: cleanEnv({ TMPDIR: tmp, TMP: tmp, TEMP: tmp }), maxBuffer: 64 * 1024 * 1024 });
  // L170 item 4: say which inner tests failed (each "not ok" line that is not a todo, with its error's first lines),
  // not the run's last 2000 characters, which are mostly the summary.
  const failed = () => {
    const lines = run.stdout.split('\n');
    const out = [];
    lines.forEach((l, i) => {
      if (!/^\s*not ok \d+/.test(l) || /# TODO\b/.test(l)) return;
      const end = lines.findIndex((x, k) => k > i && /^\s*\.\.\.\s*$/.test(x));
      const block = lines.slice(i + 1, end < 0 ? i + 30 : end);
      const loc = block.find((x) => /^\s*location:/.test(x));
      const e = block.findIndex((x) => /^\s*error:/.test(x));
      const pad = e < 0 ? 0 : block[e].search(/\S/);
      const err = e < 0 ? [] : [block[e], ...block.slice(e + 1).filter((x, k, a) => x.trim() && a.slice(0, k + 1).every((y) => !y.trim() || y.search(/\S/) > pad)).slice(0, 3)];
      out.push([l.trim(), ...[loc, ...err].filter(Boolean).map((x) => `    ${x.trim()}`)].join('\n'));
    });
    return `${out.length} inner test(s) failed:\n${out.join('\n') || '(no "not ok" line; stderr follows)'}\n${run.stderr.slice(-800)}`;
  };
  assert.equal(run.status, 0, run.status === 0 ? '' : failed());
  const tolerated = Object.values(NOT_SWITCHED_YET);
  const left = readdirSync(tmp).filter((n) => OURS.test(n) && !tolerated.some((p) => n.startsWith(p)));
  assert.deepEqual(left, []);
});

test('tempDir only takes a known lane prefix, so every folder it makes is one this guard looks for', () => {
  for (const p of ['m10-x', 'x-m10-a-', '../m10-a-', 'm10-a/b-', 'M10-', 'foo-', '-', 'm123-', 7]) assert.throws(() => tempDir(p), String(p));
  for (const p of ['m1-', 'm4-a-', 'm11-', 'm12-x-', 'm13-', 'orch-', 'air-', 'sg-', 'hist-', 'roles-', 'scan-', 'm10-reader-', 'm9-b-c-']) {
    assert.match(tempDir(p).split('/').pop(), OURS, p);
  }
  writeFileSync(join(tempDir('m6-check-'), 'a'), 'a');
  chmodSync(tempDir('m2-check-'), 0o500);
});
