// plan-reviewer-profile.test.mjs — L710: the plan reviewer's one write.
//
// The plan reviewer is read-only toward the repo and the plan. It holds Write for one file only, answer.txt in its own
// outbox, which the review runner reads when the session ends (review-runner.mjs endPlan). It has no outbox kinds, so
// it can hand in no verdict, report or any other file M9 takes in. The plain-files hook, with the arguments exactly as
// renderRoleSettings gives them, is what refuses every other write.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DESIGN_PROFILES, PLAN_ANSWER_NAME, OUTBOX_FILE, checkProfile, hasShell } from './role-profiles.mjs';
import { PLAN_ANSWER_NAME as RUNNER_ANSWER } from './review-runner.mjs';
import { renderRoleSettings, POLICY_HOOKS, HOOK_FAILS_CLOSED } from './render-settings.mjs';
import { SETTINGS as S, HOOK_FIELDS as H, HOOK_EVENTS as E } from './settings-names.mjs';
import { decide, OUTBOX_ONLY_ROLES } from '../hooks/plain-files.mjs';
import { parseArgs } from '../hooks/lib.mjs';
import { PLAN_REVIEW_ROLE } from '../../../shared/review-roles.mjs';
import { removeAll, tempDir } from '../../../shared/test-tmp.mjs';

after(removeAll);

const ROLE = PLAN_REVIEW_ROLE;

function place() {
  const root = realpathSync(tempDir('m4-plan-rev-'));
  const outboxRoot = join(root, 'outbox');
  const outbox = join(outboxRoot, ROLE, 'S-1');
  const runnerRoot = join(root, 'review');
  for (const d of [outbox, join(runnerRoot, 'packages', 'S-1'), join(root, 'repo'), join(outboxRoot, ROLE, 'S-2'), join(outbox, 'sub')]) mkdirSync(d, { recursive: true });
  return { root, outboxRoot, outbox, runnerRoot };
}

function render(pl, profile = DESIGN_PROFILES[ROLE]) {
  return renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role: ROLE, profile, product: {},
    paths: { copy: '/w/copy', outbox: pl.outbox, hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: join(pl.root, 'notes'),
      bobFolder: '/w/bob', deny: { secrets: ['/w/secrets'], proposals: ['/w/proposals'] }, reviewWalls: { outboxRoot: pl.outboxRoot, runnerRoot: pl.runnerRoot } } });
}

// The plain-files hook's arguments exactly as rendered.
function hookArgs(pl) {
  const r = render(pl);
  assert.equal(r.ok, true, r.reason);
  const entry = r.settings[S.hooks][E.preToolUse].find((e) => e[H.matcher] === POLICY_HOOKS['plain-files']);
  const cmd = entry[H.hooks][0][H.command];
  assert.ok(cmd.endsWith(HOOK_FAILS_CLOSED));
  return parseArgs(cmd.slice(0, -HOOK_FAILS_CLOSED.length).split(' ').slice(2));
}
const write = (file) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'PASS\n' } });

test('L710: the plan reviewer holds Read, Glob, Grep and Write only, no outbox kinds, and one outbox file, the runner\'s answer.txt', () => {
  const p = DESIGN_PROFILES[ROLE];
  assert.deepEqual([...p.tools], ['Read', 'Glob', 'Grep', 'Write']);
  assert.equal(hasShell(p), false, 'no shell');
  assert.ok(!p.tools.includes('Edit') && !p.tools.includes('NotebookEdit'), 'no Edit');
  assert.deepEqual([...p.outbox], [], 'no outbox kinds, so nothing it writes is taken in by M9');
  assert.deepEqual([...p.files], [PLAN_ANSWER_NAME]);
  assert.equal(PLAN_ANSWER_NAME, 'answer.txt');
  assert.equal(RUNNER_ANSWER, PLAN_ANSWER_NAME, 'the runner reads the very file the profile allows');
  assert.match(PLAN_ANSWER_NAME, OUTBOX_FILE);
  for (const [role, prof] of Object.entries(DESIGN_PROFILES)) if (role !== ROLE) assert.deepEqual([...prof.files], [], `${role} has no exact outbox file`);
});

test('L710: the hook lets the plan reviewer write answer.txt in its own outbox and nothing else', () => {
  const pl = place();
  const args = hookArgs(pl);
  assert.deepEqual(args.kinds, [], 'no --kinds word: no kind at all');
  assert.deepEqual(args.files, [PLAN_ANSWER_NAME]);
  assert.equal(args.copy, undefined, 'no code copy to write in');
  assert.ok(OUTBOX_ONLY_ROLES.includes(ROLE), 'the hook holds it to its outbox by role, not only by the missing copy');
  assert.equal(decide(write(join(pl.outbox, PLAN_ANSWER_NAME)), args).block, false, 'its answer');
  // A second kind, or any other name, in its own outbox.
  for (const name of ['verdict-S-1.md', 'report-S-1.md', 'answer-S-1.txt', 'answer.md', 'Answer.txt', 'answers.txt', 'plan.txt', 'ask-request-x.md', 'handoff-x.md']) {
    const r = decide(write(join(pl.outbox, name)), args);
    assert.equal(r.block, true, name);
  }
  // Anywhere outside its own outbox: a sub-folder of it, another plan reviewer's outbox, the plan in its package, the
  // runner's folder, a repository path, the outbox root itself.
  for (const file of [join(pl.outbox, 'sub', PLAN_ANSWER_NAME), join(pl.outboxRoot, ROLE, 'S-2', PLAN_ANSWER_NAME), join(pl.runnerRoot, 'packages', 'S-1', 'plan.txt'),
    join(pl.runnerRoot, 'status.json'), join(pl.root, 'repo', 'README.md'), join(pl.outboxRoot, PLAN_ANSWER_NAME), join(pl.root, PLAN_ANSWER_NAME)]) {
    const r = decide(write(file), args);
    assert.equal(r.block, true, file);
  }
});

test('L710: the review walls cover the plan reviewer, so its Write tool may not touch the runner\'s folder or the Bob folder', () => {
  const pl = place();
  const r = render(pl);
  assert.equal(r.ok, true, r.reason);
  const deny = r.settings[S.permissions][S.deny];
  assert.ok(deny.includes(`Write(/${pl.runnerRoot}/**)`), 'the runner\'s folder (the plan\'s package lives there)');
  assert.ok(deny.includes('Write(//w/bob/**)'), 'the Bob folder');
  assert.ok(deny.includes(`Write(/${pl.outbox}/.*)`), 'no dot-names in its outbox');
});

test('L710: a published plan reviewer profile can\'t widen its write: a second file, a kind or a shell is refused', () => {
  const d = DESIGN_PROFILES[ROLE];
  const base = { tools: [...d.tools], outbox: [], files: [PLAN_ANSWER_NAME], mode: d.mode, restricted: true, compactWindow: d.compactWindow };
  assert.equal(checkProfile(ROLE, base).ok, true);
  assert.equal(checkProfile(ROLE, { ...base, files: [] }).ok, true, 'fewer is fine');
  assert.match(checkProfile(ROLE, { ...base, files: [PLAN_ANSWER_NAME, 'other.txt'] }).reason, /outbox files outside the design: other\.txt/);
  assert.match(checkProfile(ROLE, { ...base, files: 'answer.txt' }).reason, /malformed/);
  assert.match(checkProfile(ROLE, { ...base, outbox: ['verdict-'] }).reason, /outbox kinds outside the design/);
  for (const t of ['Bash', 'Edit']) assert.match(checkProfile(ROLE, { ...base, tools: [...base.tools, t] }).reason, /tools outside the design list/, t);
  // Another role can't take the plan reviewer's file.
  const r = DESIGN_PROFILES.reviewer;
  assert.match(checkProfile('reviewer', { tools: [...r.tools], outbox: [...r.outbox], files: [PLAN_ANSWER_NAME], mode: r.mode, restricted: true, compactWindow: r.compactWindow }).reason, /outbox files outside the design/);
});

test('L710: the hook refuses a --files name that is a path or could be read as a kind, and render refuses one too', () => {
  const argv = (f) => ['--role', ROLE, '--outbox', '/o', '--snapshot', '/s', '--files', f];
  for (const f of ['../answer.txt', 'a/answer.txt', 'answer-x.txt', 'answer', '.answer.txt', 'ANSWER.txt']) assert.throws(() => parseArgs(argv(f)), /bad outbox file name/, f);
  assert.deepEqual(parseArgs(argv('answer.txt')).files, ['answer.txt']);
  const pl = place();
  const bad = { ...DESIGN_PROFILES[ROLE], files: ['answer-x.txt'] };
  assert.match(render(pl, bad).reason, /outbox file names are not plain names/);
});
