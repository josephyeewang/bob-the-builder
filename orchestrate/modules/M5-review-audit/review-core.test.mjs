// R-0b-144: the reviewer's prompt, its review package and the verdict file, end to end. The real review runner starts
// a session through the real wiring, which makes a real review copy from a real mirror and the real package; a stand-in
// claude does only what the prompt says (writes the example header it was given, at the path it was given). The row
// passes when Merge Gate refusal 5 (built, L68/L69) accepts that verdict and refuses the planted ones: no verdict,
// another head, an unlaunched reviewer (D12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { start } from '../M4-workshop/launcher/review-wiring.mjs';
import { prepareReviewCopy } from '../M4-workshop/launcher/review-runner-main.mjs';
import { headReviews, sessionVerdict } from '../M9-record/outbox.mjs';
import { verdictProblem } from '../M6-merge-gate/refusals.mjs';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { reviewPackage } from './review-package.mjs';
import { reviewerPrompt, REVIEW_RULES } from './reviewer-prompt.mjs';
import { verdictFileName, verdictFileText } from './verdict-file.mjs';
import { VERDICT_CHECKLIST } from '../../shared/record.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME };
const CLAUDE = '/pinned/claude';
const CLEAN = Object.fromEntries(VERDICT_CHECKLIST.map((k) => [k, 'clean']));

// A mirror with main and the card's branch one commit ahead of it.
async function mirror(d) {
  const src = join(d, 'src');
  const gd = join(src, '.git');
  const g = (args) => gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { gitDir: gd, workTree: src, cwd: src });
  mkdirSync(src);
  await gitOk(['init', '-q', src], { gitDir: gd });
  writeFileSync(join(src, 'a.txt'), 'main\n');
  await g(['add', 'a.txt']); await g(['commit', '-q', '-m', 'main']); await g(['branch', '-M', 'main']);
  await g(['switch', '-q', '-c', 'card/c-1']);
  writeFileSync(join(src, 'a.txt'), 'card\n');
  writeFileSync(join(src, 'b.txt'), 'new\n');
  await g(['add', 'a.txt', 'b.txt']); await g(['commit', '-q', '-m', 'card']);
  const head = (await gitOk(['rev-parse', 'HEAD'], { gitDir: gd })).trim();
  const tree = (await gitOk(['rev-parse', 'HEAD^{tree}'], { gitDir: gd })).trim();
  // Main moves on after the branch left it: that change is not the card's, and must not show in its package.
  await g(['switch', '-q', 'main']);
  writeFileSync(join(src, 'c.txt'), 'later on main\n');
  await g(['add', 'c.txt']); await g(['commit', '-q', '-m', 'later']);
  return { gd, head, tree };
}

// The stand-in claude: reads its prompt (the last argument), and writes what `act` decides at the path the prompt names.
function standIn(act) {
  const launched = [];
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.unref = () => {};
    const prompt = args[args.length - 1];
    const path = /Hand in your verdict as one file, (\S+), written once/.exec(prompt)?.[1];
    const example = prompt.split('\n').find((l) => l.startsWith('{"entity":"verdict"'));
    launched.push({ bin, args, prompt, path, example });
    setImmediate(() => { child.pid = 9000 + launched.length; child.emit('spawn'); act({ prompt, path, example }); });
    return child;
  };
  return { spawn, launched };
}

async function world(d, act) {
  const m = await mirror(d);
  const root = join(d, 'review'); const outboxRoot = join(d, 'outbox'); const copies = join(d, 'copies');
  for (const p of [root, outboxRoot, copies]) { mkdirSync(p, { mode: 0o755 }); chmodSync(p, 0o755); }
  const live = [];
  const s = standIn(act);
  let n = 0;
  const ctx = {
    root, outboxRoot, uids: UIDS, reviewHome: join(d, 'home'), claudeBin: CLAUDE,
    processName: (p) => { const x = live.find((y) => y.pid === p); return x ? `${CLAUDE} --session-id ${x.sessionId}` : null; },
    now: () => Date.parse('2026-11-01T12:00:00Z'), ownUid: () => ME, newId: () => `S-${++n}`,
    isAdmin: async () => false,
    readCard: () => ({ ok: true, doc: { state: 'in_review', head: m.head, tier: 2 } }),
    currentHead: () => m.head,
    treeOf: async () => m.tree,
    setAsideByJoe: () => [],
    sessions: async () => live.slice(),
    stop: async () => {},
    accountInUse: () => 'a',
    handedIn: (x) => sessionVerdict({ outboxRoot, uids: UIDS, ...x }),
    verdictTaken: () => ({ ok: true }),
    // The real wiring, given what realPorts gives it; the settings maker is a stand-in (review-settings.test.mjs).
    start: async (x) => {
      const copy = join(copies, x.sessionId);
      const r = await start({ ...x, claudeBin: CLAUDE, copy, spawn: s.spawn,
        makeCopy: () => prepareReviewCopy({ mirror: m.gd, card: x.card, head: x.head, dest: copy }),
        settingsFor: () => ({ ok: true, file: join(root, 'settings', `${x.sessionId}.json`) }) });
      if (r.ok) live.push({ pid: r.pid, sessionId: x.sessionId });
      return r;
    },
  };
  const ask = () => writeFileSync(join(root, 'requests', 'q-1.json'), JSON.stringify({ card: 'C-1', head: m.head, role: 'reviewer', request_id: 'q-1' }), { mode: 0o644 });
  const end = () => live.splice(0);
  const gate = () => {
    const hr = headReviews({ launches: join(root, 'launches'), outboxRoot, uids: UIDS, card: 'C-1', head: m.head });
    assert.equal(hr.ok, true, hr.reason);
    return verdictProblem({ card: { id: 'C-1', doc: { head: m.head } }, reviews: hr.sessions, tier: 2, pr: { head: { sha: m.head } } });
  };
  // One pass makes the folders; the next starts the session; the stand-in writes; it ends; the next pass marks it.
  const run = async () => {
    assert.equal((await runnerPass(ctx)).ok, true);
    ask();
    const r = await runnerPass(ctx);
    assert.deepEqual(r.started.map((x) => x.session_id), ['S-1'], r.refused.map((x) => x.reason).join(' | '));
    await new Promise((res) => setImmediate(res));
    end();
    assert.equal((await runnerPass(ctx)).ok, true);
  };
  return { ...m, root, outboxRoot, copies, s, run, gate };
}

const write = (path, text) => writeFileSync(path, text, { mode: 0o644 });

test('R-0b-144: the package is the diff from where the branch left main to the head, and the prompt carries it with the 3 rules', async () => {
  const d = tempDir('m5-pkg-');
  const m = await mirror(d);
  const copy = join(d, 'copy');
  assert.equal((await prepareReviewCopy({ mirror: m.gd, card: 'C-1', head: m.head, dest: copy })).ok, true);
  const pkg = await reviewPackage({ copy, head: m.head });
  assert.equal(pkg.ok, true, pkg.reason);
  assert.deepEqual(pkg.files, [{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'b.txt' }]);
  const diff = readFileSync(pkg.diffFile, 'utf8');
  assert.match(diff, /-main\n\+card/);
  assert.match(diff, /\+new/);
  assert.ok(pkg.diffFile.startsWith(join(copy, '.git')), 'outside the reviewed tree');
  assert.equal((await gitOk(['status', '--porcelain'], { gitDir: join(copy, '.git'), workTree: copy, cwd: copy })).trim(), '', 'the tree stays as committed');
  assert.match((await reviewPackage({ copy, head: 'e'.repeat(40) })).reason, /not at the head/);
  const p = reviewerPrompt({ role: 'reviewer', card: 'C-1', head: m.head, sessionId: 'S-1', outbox: '/o/reviewer/S-1', pkg });
  for (const r of REVIEW_RULES) assert.ok(p.includes(r), `rule: ${r.slice(0, 40)}`);
  assert.equal(REVIEW_RULES.length, 3);
  assert.ok(p.includes(`M a.txt`) && p.includes(`A b.txt`) && p.includes(pkg.diffFile) && p.includes(pkg.base));
  assert.ok(p.includes('/o/reviewer/S-1/verdict-S-1.md'));
  assert.throws(() => reviewerPrompt({ role: 'reviewer', card: 'C-1', head: 'f'.repeat(40), sessionId: 'S-1', outbox: '/o', pkg }), /not for this head/);
  assert.match(reviewerPrompt({ role: 'auditor', card: 'C-1', head: m.head, sessionId: 'S-1', outbox: '/o', pkg }), /"material":0/);
});

test('R-0b-144: the verdict file is the one M9 reads; one the gate could not count is never written', () => {
  const h = 'a'.repeat(40);
  const t = verdictFileText({ role: 'reviewer', card: 'C-1', head: h, pass: true, checklist: CLEAN, findings: [{ level: 'minor', says: 'x', on: 'correct' }] });
  assert.deepEqual(JSON.parse(t.split('\n')[0]).fields, { head: h, pass: true, checklist: CLEAN, notes: [{ level: 'minor', says: 'x', on: 'correct' }] });
  assert.throws(() => verdictFileText({ role: 'reviewer', card: 'C-1', head: h, pass: true, checklist: CLEAN, findings: [{ level: 'big', says: 'x' }] }), /level is one of/);
  assert.throws(() => verdictFileText({ role: 'reviewer', card: 'C-1', head: h, pass: true, checklist: CLEAN, findings: [{ level: 'minor', says: 'x', file: '../etc' }] }), /a path inside the change/);
  assert.equal(verdictFileName('S-1'), 'verdict-S-1.md');
  assert.throws(() => verdictFileText({ role: 'reviewer', card: 'C-1', head: 'HEAD', pass: true, checklist: CLEAN }), /names the 40-hex head/);
  assert.throws(() => verdictFileText({ role: 'reviewer', card: 'C-1', head: h, pass: 'yes', checklist: CLEAN }), /pass: true or false/);
  assert.throws(() => verdictFileText({ role: 'auditor', card: 'C-1', head: h, pass: true, material: -1 }), /whole-number/);
  assert.throws(() => verdictFileText({ role: 'builder', card: 'C-1', head: h, pass: true }), /not a review role/);
  assert.throws(() => verdictFileName('../x'), /not a session id/);
});

test('R-0b-144: a real verdict from a launched reviewer, written as its prompt says, passes refusal 5', async () => {
  const w = await world(tempDir('m5-real-'), ({ path, example }) => write(path, `${example}\n`));
  await w.run();
  const [l] = w.s.launched;
  assert.equal(l.path, join(w.outboxRoot, 'reviewer', 'S-1', 'verdict-S-1.md'), 'the prompt names the session\'s own outbox');
  assert.equal(JSON.parse(l.example).fields.head, w.head);
  assert.ok(l.prompt.includes(join(w.copies, 'S-1', '.git', 'orchestrate-review', 'change.diff')));
  assert.equal(w.gate(), null, 'refusal 5 accepts it');
});

test('R-0b-144 planted: no verdict is refused by refusal 5', async () => {
  const w = await world(tempDir('m5-none-'), () => {});
  await w.run();
  assert.match(w.gate(), /the reviewer session S-1 ended without handing in a verdict, which counts as a failure/);
});

test('R-0b-144 planted: a verdict for another head is refused by refusal 5', async () => {
  const w = await world(tempDir('m5-other-'), ({ path, example }) => write(path, `${example.replace(/"head":"[0-9a-f]{40}"/, `"head":"${'e'.repeat(40)}"`)}\n`));
  await w.run();
  assert.match(w.gate(), /the reviewer session S-1's verdict can't be counted, so it counts as a failure: .*the verdict names head eeeeeee/);
});

test('R-0b-144 planted: a verdict from a reviewer the runner never launched is refused by refusal 5', async () => {
  // The launched session hands in nothing; a second, unlaunched "session" leaves a passing verdict in an outbox folder of its own.
  const w = await world(tempDir('m5-unl-'), () => {});
  await w.run();
  const rogue = join(w.outboxRoot, 'reviewer', 'S-77');
  mkdirSync(rogue, { mode: 0o755 }); chmodSync(rogue, 0o755);
  write(join(rogue, 'verdict-S-77.md'), verdictFileText({ role: 'reviewer', card: 'C-1', head: w.head, pass: true, checklist: CLEAN }));
  assert.match(w.gate(), /the reviewer session S-1 ended without handing in a verdict/);
  assert.ok(!/S-77/.test(w.gate()), 'the unlaunched one is never read');
  // And with no launched session at all, nothing counts.
  const v = await world(tempDir('m5-unl2-'), () => {});
  mkdirSync(join(v.root, 'requests'), { recursive: true });
  const r2 = join(v.outboxRoot, 'reviewer', 'S-77');
  mkdirSync(r2, { recursive: true, mode: 0o755 });
  write(join(r2, 'verdict-S-77.md'), verdictFileText({ role: 'reviewer', card: 'C-1', head: v.head, pass: true, checklist: CLEAN }));
  mkdirSync(join(v.root, 'launches'), { recursive: true, mode: 0o755 });
  assert.match(v.gate(), /no reviewer session handed in a pass/);
  assert.equal(existsSync(join(v.copies, 'S-77')), false);
});
