// R-0b-145 and R-0b-146, end to end on the real runner, wiring, review copy, package and finalize, with a stand-in
// claude that writes the verdict each test gives it.
//   R-0b-145: the finding-checker drops planted noise and keeps every real finding; finalize works only inside one
//     session's own verdict file, so two reviewers, one fail and one pass, are still refused (L68); a Tier-1 change goes
//     round after round until 0 Material, and a send-back runs at xhigh.
//   R-0b-146, scenario (h): two Tier-1 changes on different files of one number chain; after the first merges, the
//     second is refused on its carried-over audit and gets a short re-audit of the combined change on its caught-up head.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { start } from '../M4-workshop/launcher/review-wiring.mjs';
import { prepareReviewCopy } from '../M4-workshop/launcher/review-runner-main.mjs';
import { headReviews, sessionVerdict } from '../M9-record/outbox.mjs';
import { verdictProblem } from '../M6-merge-gate/refusals.mjs';
import { carryOver } from '../M10-rules/carry-over.mjs';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { checkFindings, finalize, headFileReader, settle } from './findings.mjs';
import { verdictFileText } from './verdict-file.mjs';
import { VERDICT_CHECKLIST } from '../../shared/record.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME };
const CLAUDE = '/pinned/claude';
const CLEAN = Object.fromEntries(VERDICT_CHECKLIST.map((k) => [k, 'clean']));
const NUM = ['export function total(rows) {', '  let sum = 0;', '  for (const r of rows) sum += r.amount;', '  return sum;', '}', '', 'export function share(part, whole) {', '  return part / whole;', '}', ''];
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// A mirror: main holds the number chain (chain/total.mjs, chain/share.mjs); card branches change it.
async function repo(d) {
  const src = join(d, 'src');
  const gd = join(src, '.git');
  const g = (args) => gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { gitDir: gd, workTree: src, cwd: src });
  mkdirSync(join(src, 'chain'), { recursive: true });
  await gitOk(['init', '-q', src], { gitDir: gd });
  writeFileSync(join(src, 'chain', 'total.mjs'), NUM.join('\n'));
  writeFileSync(join(src, 'chain', 'share.mjs'), 'export const pct = (x) => x * 100;\n');
  await g(['add', '.']); await g(['commit', '-q', '-m', 'main']); await g(['branch', '-M', 'main']);
  const rev = async (r) => (await gitOk(['rev-parse', r], { gitDir: gd })).trim();
  // Commit `files` on `branch` (made from main the first time) and give back the new head.
  const commit = async (branch, files, msg = branch) => {
    const has = (await gitOk(['branch', '--list', branch], { gitDir: gd })).trim();
    await g(has ? ['switch', '-q', branch] : ['switch', '-q', '-c', branch, 'main']);
    for (const [p, t] of Object.entries(files)) writeFileSync(join(src, p), t);
    await g(['add', ...Object.keys(files)]); await g(['commit', '-q', '-m', msg]);
    const h = await rev('HEAD');
    await g(['switch', '-q', 'main']);
    return h;
  };
  return { src, gd, g, rev, commit };
}

// The stand-in claude: `act` gets the launch (its args, prompt and the verdict path the prompt names) and writes.
function standIn(act) {
  const launched = [];
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.unref = () => {};
    const prompt = args[args.length - 1];
    const path = /Hand in your verdict as one file, (\S+), written once/.exec(prompt)?.[1];
    const l = { bin, args, prompt, path, role: /^You audit/.test(prompt) ? 'auditor' : 'reviewer', head: /, head ([0-9a-f]{40})\./.exec(prompt)?.[1] };
    launched.push(l);
    setImmediate(() => { child.pid = 9000 + launched.length; child.emit('spawn'); act(l); });
    return child;
  };
  return { spawn, launched };
}

async function world(d, { card: id = 'C-1', act }) {
  const r = await repo(d);
  const root = join(d, 'review'); const outboxRoot = join(d, 'outbox'); const copies = join(d, 'copies');
  for (const p of [root, outboxRoot, copies]) { mkdirSync(p, { mode: 0o755 }); chmodSync(p, 0o755); }
  const card = { state: 'in_review', head: null, tier: 1 };
  const live = [];
  const s = standIn((l) => act(l));
  let n = 0; let q = 0;
  const ctx = {
    root, outboxRoot, uids: UIDS, reviewHome: join(d, 'home'), claudeBin: CLAUDE,
    processName: (p) => { const x = live.find((y) => y.pid === p); return x ? `${CLAUDE} --session-id ${x.sessionId}` : null; },
    now: () => Date.parse('2026-11-01T12:00:00Z'), ownUid: () => ME, newId: () => `S-${++n}`,
    isAdmin: async () => false,
    readCard: () => ({ ok: true, doc: { ...card } }),
    currentHead: () => card.head,
    treeOf: async (_c, h) => r.rev(`${h}^{tree}`),
    setAsideByJoe: () => [],
    sessions: async () => live.slice(),
    stop: async () => {},
    accountInUse: () => 'a',
    // The real finalize and the real head reader, as realPorts joins them.
    finalize: ({ role, sessionId, card: c, head }) => finalize({ outboxRoot, uids: UIDS, role, sessionId, card: c, head, owner: ME, readFile: headFileReader({ gitDir: r.gd, head }) }),
    handedIn: (x) => sessionVerdict({ outboxRoot, uids: UIDS, ...x }),
    verdictTaken: () => ({ ok: true }),
    start: async (x) => {
      const copy = join(copies, x.sessionId);
      const res = await start({ ...x, claudeBin: CLAUDE, copy, spawn: s.spawn,
        makeCopy: () => prepareReviewCopy({ mirror: r.gd, card: x.card, head: x.head, dest: copy }),
        settingsFor: () => ({ ok: true, file: join(root, 'settings', `${x.sessionId}.json`) }) });
      if (res.ok) live.push({ pid: res.pid, sessionId: x.sessionId });
      return res;
    },
  };
  // One round: ask for each role at the card's head, start them, let the stand-in write, end them, mark them ended.
  const round = async (roles) => {
    assert.equal((await runnerPass(ctx)).ok, true);
    for (const role of roles) { q += 1; writeFileSync(join(root, 'requests', `q-${q}.json`), JSON.stringify({ card: id, head: card.head, role, request_id: `q-${q}` }), { mode: 0o644 }); }
    const p = await runnerPass(ctx);
    assert.equal(p.started.length, roles.length, p.refused.map((x) => x.reason).join(' | '));
    await new Promise((res) => setImmediate(res));
    live.splice(0);
    const e = await runnerPass(ctx);
    assert.equal(e.ok, true);
    return { started: p.started.map((x) => x.session_id), alerts: e.alerts ?? [] };
  };
  const reviews = (head = card.head) => {
    const hr = headReviews({ launches: join(root, 'launches'), outboxRoot, uids: UIDS, card: id, head });
    assert.equal(hr.ok, true, hr.reason);
    return hr.sessions;
  };
  const gate = (extra = {}) => verdictProblem({ card: { id, doc: { head: card.head } }, reviews: reviews(), tier: card.tier, pr: { head: { sha: card.head } }, ...extra });
  const file = (role, sid) => join(outboxRoot, role, sid, `verdict-${sid}.md`);
  const fields = (role, sid) => JSON.parse(readFileSync(file(role, sid), 'utf8').split('\n')[0]).fields;
  return { ...r, id, card, ctx, s, root, outboxRoot, round, reviews, gate, file, fields };
}

const writeVerdict = (l, v) => writeFileSync(l.path, verdictFileText({ card: 'C-1', head: l.head, role: l.role, ...v }), { mode: 0o644 });
const real1 = { level: 'material', says: 'share divides by zero when whole is 0', file: 'chain/total.mjs', line: 8, quote: 'return part / whole;', on: 'correct' };
const real2 = { level: 'minor', says: 'total skips rows with no amount', file: 'chain/total.mjs', line: 4, quote: 'sum += r.amount', on: 'holds_up' };   // quote one line off
const real3 = { level: 'cosmetic', says: 'the module has no header comment', on: 'well_built' };                                    // nothing to check
const noise1 = { level: 'material', says: 'the rounding helper is wrong', file: 'chain/round.mjs', line: 3, quote: 'Math.round(x)', on: 'correct' };   // no such file
const noise2 = { level: 'material', says: 'total adds tax twice', file: 'chain/total.mjs', line: 2, quote: 'sum += tax', on: 'works_for_user' };   // not in the file

test('R-0b-145: the finding-checker drops 2/2 planted noise findings and keeps every real one', async () => {
  const d = tempDir('m5-fc-');
  const r = await repo(d);
  const read = headFileReader({ gitDir: r.gd, head: await r.rev('main') });
  const { kept, dropped } = await checkFindings([real1, noise1, real2, noise2, real3, { ...real1 }], read);
  assert.deepEqual(kept, [real1, real2, real3], 'every real one kept, the repeat combined');
  assert.deepEqual(dropped.map((f) => f.says), [noise1.says, noise2.says]);
  assert.match(dropped[0].dropped, /chain\/round\.mjs is not in the head reviewed/);
  assert.match(dropped[1].dropped, /the quote is not in chain\/total\.mjs near line 2/);
  // A line past the file's end is noise too; a quote spread over lines, or with other spacing, is still found.
  assert.match((await checkFindings([{ ...real2, line: 40 }], read)).dropped[0].dropped, /has 9 lines, not 40/);
  assert.equal((await checkFindings([{ ...real2, line: 3, quote: 'let  sum = 0;\n  for (const r of rows)' }], read)).kept.length, 1);
});

test('R-0b-145: what the verdict says is worked out again only where noise was the reason', () => {
  const kept = [real2]; const dropped = [{ ...noise1, dropped: 'x' }];
  // A reviewer's line that only noise put at material comes down, and pass turns true; one with a real Material stays.
  const r = settle({ role: 'reviewer', pass: false, checklist: { ...CLEAN, correct: 'material', holds_up: 'minor' }, kept, dropped });
  assert.deepEqual(r, { pass: true, checklist: { ...CLEAN, holds_up: 'minor' } });
  const r2 = settle({ role: 'reviewer', pass: false, checklist: { ...CLEAN, correct: 'material' }, kept: [real1], dropped });
  assert.deepEqual(r2, { pass: false, checklist: { ...CLEAN, correct: 'material' } });
  // An auditor's count loses the dropped Material findings only.
  assert.deepEqual(settle({ role: 'auditor', pass: false, material: 2, kept: [real1], dropped }), { pass: false, material: 1 });
  assert.deepEqual(settle({ role: 'auditor', pass: false, material: 1, kept: [], dropped }), { pass: true, material: 0 });
  // A fail with no noise behind it stays a fail.
  assert.deepEqual(settle({ role: 'auditor', pass: false, material: 0, kept: [], dropped: [] }), { pass: false, material: 0 });
});

test('R-0b-145: finalize rewrites the one session\'s own file before its ended record pins it; the gate counts that file', async () => {
  const w = await world(tempDir('m5-fin-'), { act: (l) => writeVerdict(l, l.role === 'reviewer'
    ? { pass: false, checklist: { ...CLEAN, correct: 'material', holds_up: 'minor' }, findings: [noise1, real2, real3] }
    : { pass: false, material: 1, findings: [noise2] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': NUM.join('\n').replace('return sum;', 'return Math.round(sum);') });
  const { started } = await w.round(['reviewer', 'auditor']);
  assert.deepEqual(started, ['S-1', 'S-2']);
  assert.deepEqual(w.fields('reviewer', 'S-1').checklist, { ...CLEAN, holds_up: 'minor' });
  assert.equal(w.fields('reviewer', 'S-1').pass, true);
  assert.deepEqual(w.fields('reviewer', 'S-1').notes.map((f) => [f.says, f.dropped ?? null]), [[real2.says, null], [real3.says, null], [noise1.says, 'chain/round.mjs is not in the head reviewed']]);
  assert.deepEqual([w.fields('auditor', 'S-2').material, w.fields('auditor', 'S-2').pass], [0, true]);
  // Its ended record pins the finalized file; nothing else was left in either folder.
  const ended = JSON.parse(readFileSync(join(w.root, 'ended', 'S-1.json'), 'utf8'));
  assert.equal(ended.verdict_sha256, sha256(w.file('reviewer', 'S-1')));
  for (const [role, sid] of [['reviewer', 'S-1'], ['auditor', 'S-2']]) assert.deepEqual(readdirSync(join(w.outboxRoot, role, sid)), [`verdict-${sid}.md`]);
  assert.equal(w.gate(), null);
});

test('R-0b-145 planted: two reviewers, one fail and one pass, plus a finalize step, is still refused', async () => {
  const w = await world(tempDir('m5-two-'), { act: (l) => { writeVerdict(l, l.role === 'auditor' ? { pass: true, material: 0 }
    : l.path.includes('/S-1/') ? { pass: false, checklist: { ...CLEAN, correct: 'material' }, findings: [real1] } : { pass: true, checklist: CLEAN, findings: [noise1] }); } });
  w.card.head = await w.commit('card/c-1', { 'chain/share.mjs': 'export const pct = (x) => Math.round(x * 100);\n' });
  await w.round(['reviewer', 'auditor']);
  const failed = sha256(w.file('reviewer', 'S-1'));
  // A second launched reviewer on the same tree. The runner gives one start per tree, so the test hides the first's
  // launch record and clears the runner's memory of it for one round, then puts the record back.
  const st = join(w.root, 'state.json');
  const state = JSON.parse(readFileSync(st, 'utf8'));
  for (const key of Object.keys(state.attempts)) if (key.endsWith(':reviewer')) delete state.attempts[key];
  writeFileSync(st, JSON.stringify(state), { mode: 0o600 });
  const rec = join(w.root, 'launches', 'S-1.json');
  renameSync(rec, join(w.root, 'S-1.hidden'));
  await w.round(['reviewer']);
  renameSync(join(w.root, 'S-1.hidden'), rec);
  assert.equal(w.fields('reviewer', 'S-3').pass, true);
  assert.equal(sha256(w.file('reviewer', 'S-1')), failed, 'the failing session\'s own file is untouched by the other\'s finalize');
  assert.deepEqual(readdirSync(join(w.outboxRoot, 'reviewer')).sort(), ['S-1', 'S-3'], 'no combined verdict anywhere');
  for (const sid of ['S-1', 'S-3']) assert.deepEqual(readdirSync(join(w.outboxRoot, 'reviewer', sid)), [`verdict-${sid}.md`]);
  assert.equal(w.reviews().filter((x) => x.role === 'reviewer').length, 2);
  assert.match(w.gate(), /the reviewer session S-1 did not pass/);
});

test('R-0b-145: a Tier-1 change repeats audit rounds until 0 Material, and each send-back runs at xhigh', async () => {
  const left = [2, 1, 0];
  const heads = [];
  const w = await world(tempDir('m5-rounds-'), { act: (l) => {
    const m = left[heads.indexOf(l.head)];
    writeVerdict(l, l.role === 'auditor' ? { pass: m === 0, material: m, findings: Array.from({ length: m }, () => real1).map((f, i) => ({ ...f, says: `${f.says} (${i})` })) }
      : { pass: m === 0, checklist: { ...CLEAN, correct: m ? 'material' : 'clean' }, findings: m ? [real1] : [] });
  } });
  for (let i = 0; i < 3; i += 1) {
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// fix ${i}\n` }, `round ${i}`);
    heads.push(w.card.head);
    await w.round(['reviewer', 'auditor']);
    const said = w.gate();
    if (i < 2) assert.match(said, /did not pass/, `round ${i + 1} is refused`);
    else assert.equal(said, null, 'the third round, at 0 Material, passes');
  }
  const effort = (l) => { const at = l.args.indexOf('--effort'); return at < 0 ? null : l.args[at + 1]; };
  assert.deepEqual(w.s.launched.map((l) => [l.role, effort(l)]), [['reviewer', null], ['auditor', null], ['reviewer', 'xhigh'], ['auditor', 'xhigh'], ['reviewer', 'xhigh'], ['auditor', 'xhigh']]);
  // The send-back's prompt holds the earlier round's findings, quoted.
  assert.ok(w.s.launched[3].prompt.includes('> ') && w.s.launched[3].prompt.includes(real1.says));
  // And an earlier head's failing audit never counts for the new one, nor the new pass for the old head.
  assert.match(verdictProblem({ card: { id: w.id, doc: { head: heads[0] } }, reviews: w.reviews(heads[0]), tier: 1, pr: { head: { sha: heads[0] } } }), /did not pass/);
});

// A git view over the local mirror, in the shape carry-over reads (M10 git-view.mjs).
function localView(gd) {
  const run = (args) => gitOk(args, { gitDir: gd });
  return {
    commit: async (s) => { const t = await run(['cat-file', '-p', s]); return { sha: s, tree: /^tree (\S+)/m.exec(t)[1], parents: [...t.matchAll(/^parent (\S+)/gm)].map((m) => m[1]) }; },
    files: async (b, h) => { const p = (await run(['diff', '--name-status', '-z', '--no-renames', b, h])).split('\0').filter(Boolean); const out = []; for (let i = 0; i + 1 < p.length; i += 2) out.push({ status: p[i], path: p[i + 1] }); return out; },
    entry: async (s, path) => { const t = (await run(['ls-tree', s, '--', path])).trim(); if (!t) return null; const [mode, , blob] = t.split(/\s+/); return { mode, blob }; },
  };
}

test('R-0b-146 scenario (h): after one Tier-1 change on the number chain merges, the other is never merged on a carried-over audit, and gets a short re-audit on its caught-up head', async () => {
  const w = await world(tempDir('m5-h-'), { act: (l) => writeVerdict(l, l.role === 'auditor' ? { pass: true, material: 0 } : { pass: true, checklist: CLEAN }) });
  // B (this card) changes chain/share.mjs, and is reviewed and audited at H0.
  const H0 = await w.commit('card/c-1', { 'chain/share.mjs': 'export const pct = (x) => Math.round(x * 1000) / 10;\n' });
  w.card.head = H0;
  await w.round(['reviewer', 'auditor']);
  assert.equal(w.gate(), null, 'B passes at H0');
  // A, the other Tier-1 change, on another file of the chain, merges first.
  const A = await w.commit('card/other', { 'chain/total.mjs': NUM.join('\n').replace('sum += r.amount', 'sum += r.amount ?? 0') });
  await w.g(['merge', '-q', '--no-ff', '-m', 'merge A', A]);
  const main = await w.rev('main');
  // The robot catches B up with main: a recorded catch-up merge onto H0.
  await w.g(['switch', '-q', 'card/c-1']); await w.g(['merge', '-q', '--no-ff', '-m', 'catch up', 'main']); await w.g(['switch', '-q', 'main']);
  const H1 = await w.rev('card/c-1');
  const view = localView(w.gd);
  const base = async (h) => (await gitOk(['merge-base', main, h], { gitDir: w.gd })).trim();
  const carried = await carryOver({ reviewed: { base: await base(H0), head: H0 }, current: { base: await base(H1), head: H1 }, between: [H1], catchUps: [{ pr: 2, before_sha: H0, after_sha: H1 }], tier1MergesSince: 1, gh: view });
  assert.deepEqual([carried.review, carried.audit], [true, false], carried.reasons.join('; '));
  // The pull request is at H1 now: the review carries over, the Tier-1 audit does not, so it is never merged so.
  const prReviews = w.reviews(H1);
  assert.match(w.gate({ pr: { head: { sha: H1 } }, prReviews, carried }), /the Tier-1 audit does not carry over to/);
  // The short re-audit on the caught-up head: the auditor's package lists what main brought in, A's file.
  w.card.head = H1;
  await w.round(['reviewer', 'auditor']);
  const re = w.s.launched.at(-1);
  assert.equal(re.role, 'auditor');
  assert.match(re.prompt, new RegExp(`This is a short re-audit of a combined change. An earlier audit passed this card at ${H0}`));
  assert.match(re.prompt, /brought in 1 changed file\(s\):\n {2}chain\/total\.mjs\n/);
  assert.ok(!/short re-audit/.test(w.s.launched.at(-2).prompt), 'the reviewer gets no re-audit section');
  assert.ok(!/short re-audit/.test(w.s.launched[1].prompt), 'nor did the first audit');
  assert.equal(w.gate(), null, 'it merges on the re-audit at H1, not on the carried-over one');
});
