// build-skip.test.mjs — only production on main builds; full mode needs the mark or the owner's label; every failure skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDir } from '../../shared/test-tmp.mjs';
import { decideBuild, decideBuildFull, skipCommand, main, BUILD_TOKEN } from './build-skip.mjs';
import { routeGh, markRoutes } from './fixtures/checker-fake.mjs';

const owner = 'sample-org';
const repo = 'sample-app';
const SHA = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const ROBOT = 4242;
const OWNER = 1000001;
const env = (extra = {}) => ({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: SHA,
  VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: repo, ...extra });
const full = (gh, extra = {}) => decideBuildFull({ env: env(), gh, robotBotId: ROBOT, ownerId: OWNER, ...extra });
const PIN = `https://raw.githubusercontent.com/sample-org/sample-checks/${'e'.repeat(40)}/github-checker.mjs`;

// A merged pull request with no robot mark, and its label history.
function labelled(events) {
  const base = `/repos/${owner}/${repo}`;
  return routeGh({
    [`${base}/commits/${SHA}/statuses?per_page=100`]: [],
    [`${base}/commits/${SHA}/pulls?per_page=100`]: [{ number: 9 }],
    [`${base}/pulls/9`]: { number: 9, merged: true, merge_commit_sha: SHA, merged_by: { id: OWNER }, head: { sha: HEAD }, base: { ref: 'main' } },
    [`${base}/issues/9/events?per_page=100`]: events,
  });
}
const labeledBy = (actor, extra = {}) => ({ event: 'labeled', label: { name: 'owner-deploy' }, actor, ...extra });

test('a preview build and a non-main branch in production are skipped, in both modes', () => {
  for (const mode of ['first', 'full']) {
    assert.equal(decideBuild({ mode, env: env({ VERCEL_ENV: 'preview' }) }).build, false);
    assert.equal(decideBuild({ mode, env: env({ VERCEL_GIT_COMMIT_REF: 'robot/card-1' }) }).build, false);
    assert.equal(decideBuild({ mode, env: env({ VERCEL_GIT_COMMIT_SHA: 'abc1234' }) }).build, false);
  }
});

test('first mode builds production on main with no mark check; a bad mode skips', async () => {
  assert.equal(decideBuild({ mode: 'first', env: env() }).build, true);
  for (const mode of ['', 'FULL', 'second', undefined]) assert.equal(decideBuild({ mode, env: env() }).build, false);
  const seen = [];
  assert.equal(await main(['first'], env(), { out: (s) => seen.push(s) }), 1);
  assert.deepEqual(seen, [BUILD_TOKEN]);
  assert.equal(await main(['bogus'], env(), { out: (s) => seen.push(s) }), 0);
  assert.equal(await main(undefined, undefined, { out: (s) => seen.push(s) }), 0);
  assert.equal(seen.length, 1);
});

test('full mode: decideBuild alone never builds', () => {
  const d = decideBuild({ mode: 'full', env: env() });
  assert.deepEqual([d.build, d.needsMarkCheck], [false, true]);
});

test('full mode: a main commit with no mark is skipped; with the robot\'s mark it builds', async () => {
  const none = routeGh({ [`/repos/${owner}/${repo}/commits/${SHA}/statuses?per_page=100`]: [], [`/repos/${owner}/${repo}/commits/${SHA}/pulls?per_page=100`]: [] });
  assert.equal((await full(none)).build, false);
  const marked = routeGh(markRoutes({ sha: SHA, head: HEAD, robotBotId: ROBOT }));
  const d = await full(marked);
  assert.equal(d.build, true, d.reason);
  // A mark merged by someone other than the robot is no mark.
  assert.equal((await full(routeGh(markRoutes({ sha: SHA, head: HEAD, robotBotId: ROBOT, mergedBy: OWNER })))).build, false);
});

test('the owner\'s label builds; the same label from a robot, an app, or since removed does not', async () => {
  assert.equal((await full(labelled([labeledBy({ id: OWNER, type: 'User' })]))).build, true);
  assert.equal((await full(labelled([labeledBy({ id: ROBOT, type: 'Bot' })]))).build, false);
  assert.equal((await full(labelled([labeledBy({ id: OWNER, type: 'Bot' })]))).build, false);
  assert.equal((await full(labelled([labeledBy({ id: OWNER, type: 'User' }, { performed_via_github_app: { id: 1 } })]))).build, false);
  assert.equal((await full(labelled([labeledBy({ id: OWNER, type: 'User' }), { event: 'unlabeled', label: { name: 'owner-deploy' }, actor: { id: OWNER, type: 'User' } }]))).build, false);
  assert.equal((await full(labelled([labeledBy({ id: OWNER, type: 'User' }), labeledBy({ id: ROBOT, type: 'Bot' })]))).build, false);
  assert.equal((await full(labelled([labeledBy({ id: OWNER, type: 'User' })]), { ownerId: undefined })).build, false);
});

test('a GitHub client that throws, or a bad answer, skips', async () => {
  const down = routeGh(markRoutes({ sha: SHA, head: HEAD, robotBotId: ROBOT })); down.down = true;
  assert.equal((await full(down)).build, false);
  assert.equal((await full({ get() { throw new Error('boom'); } })).build, false);
  assert.equal((await full(null)).build, false);
  assert.equal(await main(['full'], env({ ORCHESTRATE_ROBOT_BOT_ID: String(ROBOT) }), { gh: down, out: () => {} }), 0);
  assert.equal(await main(['full'], env({ ORCHESTRATE_ROBOT_BOT_ID: String(ROBOT) }), { gh: routeGh(markRoutes({ sha: SHA, head: HEAD, robotBotId: ROBOT })), out: () => {} }), 1);
});

test('skipCommand refuses a branch, tag, short id, non-https URL or a bad hash', () => {
  const h = 'f'.repeat(64);
  for (const checkerUrl of [
    'https://raw.githubusercontent.com/sample-org/sample-checks/main/github-checker.mjs',
    'https://raw.githubusercontent.com/sample-org/sample-checks/v1.2.0/github-checker.mjs',
    'https://raw.githubusercontent.com/sample-org/sample-checks/eeeeeee/github-checker.mjs',
    `http://raw.githubusercontent.com/sample-org/sample-checks/${'e'.repeat(40)}/github-checker.mjs`,
    `https://raw.githubusercontent.com/x/${'e'.repeat(40)}/a.mjs';rm -rf ~;'`,
    `https://raw.githubusercontent.com/x/${'E'.repeat(40)}/a.mjs`]) {
    assert.throws(() => skipCommand({ mode: 'full', checkerUrl, sha256: h }), /pinned/, checkerUrl);
  }
  assert.throws(() => skipCommand({ mode: 'full', checkerUrl: PIN, sha256: 'f'.repeat(63) }), /sha256/);
  assert.throws(() => skipCommand({ mode: 'later', checkerUrl: PIN, sha256: h }), /mode/);
  assert.throws(() => skipCommand({}), /mode/);
  const cmd = skipCommand({ mode: 'full', checkerUrl: PIN, sha256: h });
  assert.match(cmd, /; exit 0$/);
  assert.match(cmd, /&& exit 1; exit 0$/);
  assert.ok(cmd.includes(PIN) && cmd.includes(h) && cmd.includes(BUILD_TOKEN));
});

test('the command, run by sh: a failed download, a wrong hash and a crash each skip; only the token builds', () => {
  const dir = tempDir('m6-build-skip-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const script = (name, body) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
  const checker = join(dir, 'checker.mjs');
  const write = (body) => writeFileSync(checker, body);
  const hash = () => createHash('sha256').update(readFileSync(checker)).digest('hex');
  // A fake sha256sum (in node, so the test doesn't depend on which hash tools the machine has).
  const hasher = join(dir, 'hasher.mjs');
  writeFileSync(hasher, "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs';\nconst f = process.argv[2]; console.log(createHash('sha256').update(readFileSync(f)).digest('hex') + '  ' + f);\n");
  script('sha256sum', `exec "${process.execPath}" "${hasher}" "$@"`);
  script('node', `exec "${process.execPath}" "$@"`);
  const PATH = `${bin}:/usr/bin:/bin`;
  const runCmd = (cmd) => { try { execFileSync('/bin/sh', ['-c', cmd], { env: { PATH }, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  // curl that fetches nothing.
  script('curl', 'exit 1');
  write(`console.log(${JSON.stringify(BUILD_TOKEN)}); process.exit(1);`);
  assert.equal(runCmd(skipCommand({ mode: 'full', checkerUrl: PIN, sha256: hash() })), 0, 'failed download');
  // curl that "downloads" the local checker: the -o argument is the file after -o.
  script('curl', `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done; cp "${checker}" "$out"`);
  assert.equal(runCmd(skipCommand({ mode: 'full', checkerUrl: PIN, sha256: hash() })), 1, 'the right file, saying BUILD');
  assert.equal(runCmd(skipCommand({ mode: 'full', checkerUrl: PIN, sha256: '0'.repeat(64) })), 0, 'wrong hash');
  write('throw new Error("crash");');
  assert.equal(runCmd(skipCommand({ mode: 'full', checkerUrl: PIN, sha256: hash() })), 0, 'a crash exits 1 but prints no token');
  write('console.log("no"); process.exit(1);');
  assert.equal(runCmd(skipCommand({ mode: 'full', checkerUrl: PIN, sha256: hash() })), 0, 'exit 1 with no token');
  // The real bundle (an ES module with imports) through the exact download command: only its first mode can say BUILD
  // with no GitHub, so the mode is swapped here. (A bare mktemp name made node refuse the file, so every deploy was skipped.)
  writeFileSync(checker, readFileSync(new URL('./github-checker.mjs', import.meta.url)));
  const runEnv = (cmd, extra) => { try { execFileSync('/bin/sh', ['-c', cmd], { env: { PATH, ...extra }, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  const downloadFirst = skipCommand({ mode: 'full', checkerUrl: PIN, sha256: hash() }).replace('node "$f" full', 'node "$f" first');
  assert.equal(runEnv(downloadFirst, env()), 1, 'the real checker builds production main');
  assert.equal(runEnv(downloadFirst, env({ VERCEL_ENV: 'preview' })), 0, 'the real checker skips a preview');
});

test('L571: full mode is the download command, byte for byte', () => {
  const h = 'f'.repeat(64);
  assert.equal(skipCommand({ mode: 'full', checkerUrl: PIN, sha256: h }),
    `d=$(mktemp -d) && f="$d/checker.mjs" && curl -fsSL --max-time 60 -o "$f" '${PIN}' && [ "$(sha256sum "$f" | cut -c1-64)" = ${h} ] && [ "$(node "$f" full)" = ${BUILD_TOKEN} ] && exit 1; exit 0`);
  assert.throws(() => skipCommand({ mode: 'full' }), /pinned/, 'full mode still needs its pin');
});

test('L571: the first-cutover command is one self-contained line that needs no URL or hash', () => {
  const cmd = skipCommand({ mode: 'first' });
  assert.equal(skipCommand({ mode: 'first', checkerUrl: PIN, sha256: 'f'.repeat(64) }), cmd, 'a pin changes nothing');
  assert.ok(!/[\n\r]/.test(cmd), 'one line');
  for (const word of ['curl', 'wget', 'http', 'node', 'mktemp', 'sha256', 'checker', '$(', '`']) assert.ok(!cmd.includes(word), word);
});

// A shell on this list that is missing fails the test, never drops out (L592). zsh is the Mac's: Linux CI has none.
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', ...(process.platform === 'darwin' ? ['/bin/zsh'] : [])];

test('L592: the first-cutover command fits the field, and has no backslash for the paste to lose or double', () => {
  const cmd = skipCommand({ mode: 'first' });
  assert.ok(cmd.length <= 256, `${cmd.length} characters`);
  assert.ok(!cmd.includes('\\'));
  for (const [i, shell] of SHELLS.entries()) {
    const r = spawnSync(shell, ['-c', cmd], { env: { PATH: '/usr/bin:/bin', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) } });
    assert.equal(r.status, 0, `case ${i}: preview skips`);
  }
});

test('L571: through real shells, the first-cutover command agrees with decideBuild on every case', () => {
  const dir = tempDir('m6-first-skip-');
  const FULL = 'a'.repeat(40);
  const values = {
    VERCEL_ENV: [undefined, '', 'production', 'preview', 'development', 'Production', 'production ', 'production\n', '*', 'production|main', 'production|main|', 'xproduction', 'x'], // xproduction and x: a loosened leading pattern builds (#241 r2 Minor 3)
    VERCEL_GIT_COMMIT_REF: [undefined, '', 'main', 'mainx', 'Main', 'x|main', '$(touch PLANTED)', '`touch PLANTED`', 'main\n', 'ma*', 'main;exit 1', '"; exit 1; "', `main|${FULL}`, FULL, 'production|main'],
    VERCEL_GIT_COMMIT_SHA: [undefined, '', FULL, '0123456789abcdef0123456789abcdef01234567', FULL.slice(1), `${FULL}a`, FULL.toUpperCase(), `${FULL}\n`, `\n${FULL}`,
      `${'a'.repeat(20)}|${'b'.repeat(19)}`, `g${'a'.repeat(39)}`, '?'.repeat(40), '*', 'é'.repeat(40), `${'a'.repeat(39)}B`, `|${FULL}`, '$(touch PLANTED)'],
  };
  const cmd = skipCommand({ mode: 'first' });
  for (const s of SHELLS) assert.ok(existsSync(s), `${s} is missing, so this run would prove less than it says (L592)`);
  let builds = 0;
  for (const [i, shell] of SHELLS.entries()) {
    const lang = i % 2 ? 'en_US.UTF-8' : 'C'; // both locales cross the shells below without doubling the run
    for (const a of values.VERCEL_ENV) for (const b of values.VERCEL_GIT_COMMIT_REF) for (const c of values.VERCEL_GIT_COMMIT_SHA) {
      const vars = {};
      if (a !== undefined) vars.VERCEL_ENV = a;
      if (b !== undefined) vars.VERCEL_GIT_COMMIT_REF = b;
      if (c !== undefined) vars.VERCEL_GIT_COMMIT_SHA = c;
      const want = decideBuild({ mode: 'first', env: vars }).build ? 1 : 0;
      const r = spawnSync(shell, ['-c', cmd], { cwd: dir, encoding: 'latin1', env: { PATH: '/usr/bin:/bin', LC_ALL: lang, ...vars } });
      assert.equal(r.status, want, `${shell} ${lang} ${JSON.stringify(vars)}`);
      assert.equal(r.stdout, '', 'nothing on standard output');
      assert.equal(r.stderr, want ? '' : 'build-skip: skip: not prod/main/full id\n', `${shell}: a skip says so, naming no value`);
      builds += want;
    }
  }
  assert.ok(builds > 0, 'some case builds');
  assert.deepEqual(readdirSync(dir), [], 'a shell-looking value ran nothing');
});
