// build-skip.test.mjs — only production on main builds; full mode needs the mark or the owner's label; every failure skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  // The real bundle (an ES module with imports) through the exact command: a production main commit builds at the
  // first cutover, a preview skips. (A bare mktemp name made node refuse the file, so every deploy was skipped.)
  writeFileSync(checker, readFileSync(new URL('./github-checker.mjs', import.meta.url)));
  const runEnv = (cmd, extra) => { try { execFileSync('/bin/sh', ['-c', cmd], { env: { PATH, ...extra }, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  assert.equal(runEnv(skipCommand({ mode: 'first', checkerUrl: PIN, sha256: hash() }), env()), 1, 'the real checker builds production main');
  assert.equal(runEnv(skipCommand({ mode: 'first', checkerUrl: PIN, sha256: hash() }), env({ VERCEL_ENV: 'preview' })), 0, 'the real checker skips a preview');
});
