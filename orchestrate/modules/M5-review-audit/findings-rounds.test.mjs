// R-0b-145 and R-0b-146, end to end on the real runner, the wiring's own steps (the real wiring refuses every start
// until its launch checks can pass, L83 M-3: stand-in-start.test-helper.mjs), review copy, package and finalize, with a
// stand-in claude that writes the verdict each test gives it.
//   R-0b-145: the finding-checker drops planted noise and keeps every real finding; finalize works only inside one
//     session's own verdict file, so two reviewers, one fail and one pass, are still refused (L68); a Tier-1 change goes
//     round after round until 0 Material, and a send-back runs at xhigh.
//   R-0b-146, scenario (h): two Tier-1 changes on different files of one number chain; after the first merges, the
//     second is refused on its carried-over audit and is audited again on its caught-up head. The short re-audit's own
//     start and framing come with the gate's half (L80, L424 m1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { standInStart } from './stand-in-start.test-helper.mjs';
import { PASSES, headReviews, sessionVerdict, verdictFields } from '../M9-record/outbox.mjs';
import { verdictProblem } from '../M6-merge-gate/refusals.mjs';
import { carryOver } from '../M10-rules/carry-over.mjs';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { changeReaders, checkFindings, finalize, settle } from './findings.mjs';
import { finalizeMark } from '../M4-workshop/launcher/review-runner.mjs';
import { verdictFileText, verdictFormat } from './verdict-file.mjs';
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
    finalize: async ({ role, sessionId, card: c, head, mark }) => finalize({ outboxRoot, uids: UIDS, role, sessionId, card: c, head, owner: ME, mark, ...await changeReaders({ gitDir: r.gd, head }) }),
    handedIn: (x) => sessionVerdict({ outboxRoot, uids: UIDS, ...x }),
    verdictTaken: () => ({ ok: true }),
    // The wiring's own steps with the stand-in, after showing the real wiring refuses (stand-in-start.test-helper.mjs).
    start: standInStart({ mirror: r.gd, copies, root, claudeBin: CLAUDE, spawn: s.spawn, live }),
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
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const check = (list) => checkFindings(list, readFile, readBase);
  const { kept, dropped } = await check([real1, noise1, real2, noise2, real3, { ...real1 }]);
  assert.deepEqual(kept, [real1, real2, real3], 'every real one kept, the repeat combined');
  assert.deepEqual(dropped.map((f) => f.says), [noise1.says, noise2.says]);
  assert.match(dropped[0].dropped, /chain\/round\.mjs is not in the head reviewed or where the change began/);
  assert.equal(dropped[1].dropped, 'the quote is not in chain/total.mjs');
  // A line number is never a reason to drop (L424); a quote spread over lines, or with other spacing, is still found.
  assert.equal((await check([{ ...real2, line: 40 }])).kept.length, 1);
  assert.equal((await check([{ ...real2, line: 3, quote: 'let  sum = 0;\n  for (const r of rows)' }])).kept.length, 1);
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
  assert.deepEqual(w.fields('reviewer', 'S-1').notes.map((f) => [f.says, f.dropped ?? null]), [[real2.says, null], [real3.says, null], [noise1.says, 'chain/round.mjs is not in the head reviewed or where the change began']]);
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
  assert.deepEqual(w.s.launched.map((l) => [l.role, effort(l)]), [['reviewer', 'high'], ['auditor', 'high'], ['reviewer', 'xhigh'], ['auditor', 'xhigh'], ['reviewer', 'xhigh'], ['auditor', 'xhigh']]);
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

test('R-0b-146 scenario (h): after one Tier-1 change on the number chain merges, the other is never merged on a carried-over audit, and is audited again on its caught-up head', async () => {
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
  // Audited again on the caught-up head. Nothing tells this audit it may be short yet (L424 m1): that start is L80's.
  w.card.head = H1;
  await w.round(['reviewer', 'auditor']);
  const re = w.s.launched.at(-1);
  assert.equal(re.role, 'auditor');
  for (const l of w.s.launched) assert.ok(!/short re-audit/.test(l.prompt), 'no start says so');
  assert.equal(w.gate(), null, 'it merges on the audit at H1, not on the carried-over one');
});

// L92 M-1: a fail never turns into a pass while a Material finding stays in the verdict, at M5 and at M9.
test('L92 M-1 planted: a real Material kept beside dropped noise keeps the verdict a fail', async () => {
  const k = (...f) => f; const d = (f) => [{ ...f, dropped: 'x' }];
  // Written minus dropped would be 0 here; the kept one counts.
  assert.deepEqual(settle({ role: 'auditor', pass: false, material: 1, kept: k(real1), dropped: d(noise1) }), { pass: false, material: 1 });
  // A count above the list: the two no finding accounts for stay.
  assert.deepEqual(settle({ role: 'auditor', pass: false, material: 3, kept: [], dropped: d(noise1) }), { pass: false, material: 2 });
  const { on: _on, ...noLine } = real1;
  const r = settle({ role: 'reviewer', pass: false, checklist: { ...CLEAN, correct: 'material' }, kept: k(noLine), dropped: d(noise1) });
  assert.deepEqual(r, { pass: false, checklist: { ...CLEAN, correct: 'material' } });
  // Through the real runner, finalize, and M9's own reading of the rewritten file.
  const w = await world(tempDir('m5-m1-'), { act: (l) => writeVerdict(l, l.role === 'reviewer'
    ? { pass: false, checklist: { ...CLEAN, correct: 'material' }, findings: [noise1, noLine] }
    : { pass: false, material: 1, findings: [real1, noise2] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  await w.round(['reviewer', 'auditor']);
  for (const [role, sid] of [['reviewer', 'S-1'], ['auditor', 'S-2']]) {
    const v = verdictFields(JSON.parse(readFileSync(w.file(role, sid), 'utf8').split('\n')[0]));
    assert.equal(v.ok, true, v.reason);
    assert.equal(PASSES[role](v), false, `${role} stays a fail at M9`);
  }
  assert.match(w.gate(), /did not pass/);
});

// L92 M-2: a review is of a diff, so what the change takes away is real ground for a finding.
test('L92 M-2 planted: a finding about a removed line, a deleted file, a diff quote or a link is never noise', async () => {
  const r = await repo(tempDir('m5-m2-'));
  await r.g(['switch', '-q', '-c', 'card/rm', 'main']);
  writeFileSync(join(r.src, 'chain', 'total.mjs'), [...NUM.slice(0, 7), '  return Math.round(part);', ...NUM.slice(8)].join('\n'));
  await r.g(['rm', '-q', 'chain/share.mjs']);
  symlinkSync('total.mjs', join(r.src, 'chain', 'link.mjs'));
  await r.g(['add', '.']); await r.g(['commit', '-q', '-m', 'takes things away']);
  const head = await r.rev('HEAD');
  await r.g(['switch', '-q', 'main']);
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  const check = (f) => checkFindings([{ level: 'material', says: 'x', ...f }], readFile, readBase);
  const kept = async (what, f) => assert.equal((await check(f)).kept.length, 1, what);
  await kept('a removed line', { file: 'chain/total.mjs', line: 8, quote: 'return part / whole;' });
  await kept('a removed line cited far from where it was', { file: 'chain/total.mjs', line: 1, quote: 'return part / whole;' });
  await kept('a deleted file', { file: 'chain/share.mjs', line: 90 });
  await kept('a quote from a deleted file', { file: 'chain/share.mjs', line: 90, quote: 'export const pct' });
  await kept('a quote as the diff shows it, added', { file: 'chain/total.mjs', line: 8, quote: '+  return Math.round(part);' });
  await kept('a quote as the diff shows it, removed', { file: 'chain/total.mjs', line: 8, quote: '-  return part / whole;' });
  await kept('a quote across both sides of the diff', { file: 'chain/total.mjs', line: 8, quote: '-  return part / whole;\n+  return Math.round(part);' });
  await kept('a path that is a link at the head', { file: 'chain/link.mjs', line: 5, quote: 'not what the link points at' });
  const dropped = async (what, f, why) => assert.match((await check(f)).dropped[0]?.dropped ?? '', why, what);
  await dropped('a file on neither side', { file: 'chain/none.mjs' }, /not in the head reviewed or where the change began/);
  await dropped('a quote on neither side', { file: 'chain/total.mjs', line: 8, quote: 'sum += tax' }, /the quote is not in/);
  await dropped('a quote not in a deleted file', { file: 'chain/share.mjs', quote: 'sum += tax' }, /the quote is not in/);
  // L424: a line number is never a reason to drop, past the end of both sides or not.
  await kept('a line past the end on both', { file: 'chain/total.mjs', line: 90 });
  await kept('a quote the head still has, on the wrong line', { file: 'chain/total.mjs', line: 9, quote: 'return sum;' });
  // The mirror failing to answer is no evidence: finalize stops, and the file stays as written.
  await assert.rejects(changeReaders({ gitDir: r.gd, head: '0'.repeat(40) }));
  const blob = (await gitOk(['rev-parse', `${head}:chain/total.mjs`], { gitDir: r.gd })).trim();
  rmSync(join(r.gd, 'objects', blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(readFile('chain/total.mjs'), /could not be read at/);
  renameSync(r.gd, `${r.gd}-gone`);
  await assert.rejects(readFile('chain/total.mjs'));
});

// L424: what is noise is worked out from the whole of both files, never from a line number.
test('L424 F1 planted: a removed line whose text stands elsewhere too is kept, whichever side its line is counted on', async () => {
  const r = await repo(tempDir('m5-f1-'));
  const guard = '  if (w === 0) return 0;';
  const lines = Array.from({ length: 60 }, (_, i) => (i === 4 || i === 49 ? guard : `  step(${i});`));
  await r.commit('main', { 'chain/f.mjs': `${lines.join('\n')}\n` });
  const after = [...Array.from({ length: 20 }, (_, i) => `  added(${i});`), ...lines.slice(0, 49), ...lines.slice(50)];
  const head = await r.commit('card/f1', { 'chain/f.mjs': `${after.join('\n')}\n` });
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  for (const quote of [guard.trim(), `-${guard}`]) {
    const { kept, dropped } = await checkFindings([{ level: 'material', says: 'the guard went', file: 'chain/f.mjs', line: 70, quote }], readFile, readBase);
    assert.deepEqual([kept.length, dropped.length], [1, 0], quote);
  }
});

test('L424 F3 planted: a quote longer than a few lines is kept, cited at its first line or its last, and with Windows line ends', async () => {
  const r = await repo(tempDir('m5-f3-'));
  const head = await r.commit('card/f3', { 'chain/share.mjs': '// a change\n' });
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  const quote = NUM.slice(0, 8).join('\n');
  for (const f of [{ line: 1, quote }, { line: 8, quote }, { line: 1, quote: quote.replaceAll('\n', '\r\n') }]) {
    assert.equal((await checkFindings([{ level: 'material', says: 'x', file: 'chain/total.mjs', ...f }], readFile, readBase)).kept.length, 1, f.line);
  }
});

test('L424 m4 planted: a file the change shortens keeps a finding on a line only the base reaches', async () => {
  const r = await repo(tempDir('m5-short-'));
  const head = await r.commit('card/short', { 'chain/total.mjs': `${NUM.slice(0, 3).join('\n')}\n` });
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  for (const f of [{ line: 8 }, { line: 8, quote: 'return part / whole;' }]) {
    assert.equal((await checkFindings([{ level: 'material', says: 'x', file: 'chain/total.mjs', ...f }], readFile, readBase)).kept.length, 1);
  }
});

// L424 F2: `dropped` is the runner's own mark. Copied from an earlier round's notes, it never hides a finding.
const rawVerdict = (l, fields) => writeFileSync(l.path, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: l.head, ...fields } })}\n`, { mode: 0o644 });

test('L424 F2 planted: a finding carrying a dropped key in a file finalize never marked refuses the verdict, so it never counts as a pass', async () => {
  const cases = [
    { pass: false, material: 1, notes: [noise2, { ...real1, dropped: 'copied' }] },
    { pass: false, material: 1, notes: [noise2, { ...real1, dropped: '' }] },
    { pass: true, material: 0, notes: [{ ...real1, dropped: 'copied' }] },
  ];
  for (const verdict of cases) {
    const w = await world(tempDir('m5-f2-'), { act: (l) => (l.role === 'auditor' ? rawVerdict(l, verdict) : writeVerdict(l, { pass: true, checklist: CLEAN })) });
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
    const { alerts } = await w.round(['reviewer', 'auditor']);
    assert.ok(JSON.stringify(alerts).includes('could not be check'), 'Joe is told');
    const h = JSON.parse(readFileSync(w.file('auditor', 'S-2'), 'utf8').split('\n')[0]);
    assert.deepEqual(h.fields.notes, verdict.notes, 'left as written');
    assert.match(verdictFields(h).reason, /only the runner marks a finding dropped/);
    assert.notEqual(w.gate(), null);
  }
  assert.match(verdictFields({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), pass: true, material: 0, finalized: 'yes' } }).reason, /finalized is only ever true/);
  // The session is told, so a finding it raises again from an earlier round is not refused for the copied mark.
  assert.match(verdictFormat({ role: 'auditor', card: 'C-1', head: 'a'.repeat(40) }), /"dropped" is the runner's own mark: leave it off every finding/);
});

test('L424 m3 planted: any kept Material finding makes the verdict a fail, whatever it says, with nothing dropped', async () => {
  const none = { level: 'material', says: 'the chain double counts' };
  assert.deepEqual(settle({ role: 'auditor', pass: true, material: 0, kept: [real1], dropped: [] }), { pass: false, material: 1 });
  assert.deepEqual(settle({ role: 'reviewer', pass: true, checklist: CLEAN, kept: [none], dropped: [] }), { pass: false, checklist: CLEAN });
  // A verdict that gave no count gains none, so a dropped finding can't give it the 0 M9 asks for.
  assert.deepEqual(settle({ role: 'auditor', pass: true, material: null, kept: [], dropped: [{ ...noise1, dropped: 'x' }] }), { pass: true, material: null });
  // Through the real runner, finalize and M9.
  const w = await world(tempDir('m5-m3-'), { act: (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN, findings: [none] } : { pass: true, material: 0, findings: [real1] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  await w.round(['reviewer', 'auditor']);
  for (const [role, sid] of [['reviewer', 'S-1'], ['auditor', 'S-2']]) {
    const v = verdictFields(JSON.parse(readFileSync(w.file(role, sid), 'utf8').split('\n')[0]));
    assert.equal(v.ok, true, v.reason);
    assert.equal(PASSES[role](v), false, `${role} is a fail at M9`);
  }
  assert.equal(w.fields('auditor', 'S-2').material, 1);
  assert.match(w.gate(), /did not pass/);
});

test('L424: finalize run again on a file it marked changes nothing, so what it dropped stays dropped', async () => {
  const w = await world(tempDir('m5-again-'), { act: (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: false, material: 1, findings: [noise2] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  await w.round(['reviewer', 'auditor']);
  assert.deepEqual([w.fields('auditor', 'S-2').pass, w.fields('auditor', 'S-2').material, w.fields('auditor', 'S-2').finalized], [true, 0, true]);
  const was = sha256(w.file('auditor', 'S-2'));
  const mark = finalizeMark({ dir: join(w.root, 'finalized'), uid: ME, role: 'auditor', card: 'C-1', head: w.card.head, sessionId: 'S-2' });
  assert.equal(mark.read(), was, 'the runner\'s record names the file it wrote');
  const again = await w.ctx.finalize({ role: 'auditor', sessionId: 'S-2', card: 'C-1', head: w.card.head, mark });
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal(sha256(w.file('auditor', 'S-2')), was);
  assert.equal(w.fields('reviewer', 'S-1').finalized, undefined, 'a file with nothing to change stays as written');
  // A stop after the record and before the rename: the next run works out the same file, and the record still names it.
  writeVerdict({ path: w.file('auditor', 'S-2'), head: w.card.head, role: 'auditor' }, { pass: false, material: 1, findings: [noise2] });
  const retry = await w.ctx.finalize({ role: 'auditor', sessionId: 'S-2', card: 'C-1', head: w.card.head, mark });
  assert.deepEqual([retry.ok, retry.changed], [true, true], retry.reason);
  assert.equal(sha256(w.file('auditor', 'S-2')), was);
  assert.equal(w.gate(), null);
});

test('L432 planted: a file listing a kept Material finding that says pass: true or material: 0 is refused, so one finalize could not settle never passes', async () => {
  const reads = (fields) => verdictFields({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), ...fields } });
  for (const f of [{ pass: true, material: 0, notes: [real1] }, { pass: true, material: 1, notes: [real1] }, { pass: false, material: 0, notes: [real1] }, { pass: true, checklist: CLEAN, notes: [real1] }]) {
    assert.match(reads(f).reason ?? '', /lists a Material finding/, JSON.stringify(f));
  }
  // A fail that says so stands; so does a pass with nothing Material kept, or a finding dropped in a marked file.
  assert.equal(reads({ pass: false, material: 1, notes: [real1] }).ok, true);
  assert.equal(reads({ pass: false, notes: [real1] }).ok, true);
  assert.equal(reads({ pass: true, material: 0, notes: [real2] }).ok, true);
  assert.equal(reads({ pass: true, material: 0, notes: [{ ...noise1, dropped: 'x' }], finalized: true }).ok, true);
  // settle and M9 agree: what settle says of a kept Material finding, M9 takes.
  const a = settle({ role: 'auditor', pass: true, material: 0, kept: [real1], dropped: [] });
  assert.equal(reads({ ...a, notes: [real1] }).ok, true);
  const r = settle({ role: 'reviewer', pass: true, checklist: CLEAN, kept: [real1], dropped: [] });
  assert.equal(reads({ ...r, notes: [real1] }).ok, true);
  // Finalize can't run, here the mirror is down: the file stays as written, the end refuses it, and the gate with it.
  const w = await world(tempDir('m5-l432-'), { act: (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: true, material: 0, findings: [real1] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  w.ctx.finalize = async () => { throw new Error('the mirror is down'); };
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.deepEqual([w.fields('auditor', 'S-2').pass, w.fields('auditor', 'S-2').material], [true, 0], 'left as written');
  assert.ok(JSON.stringify(alerts).includes('could not be check'), 'Joe is told');
  assert.notEqual(w.gate(), null, 'it never counts as a pass');
});

test('L432 planted: a hunk header in a quote is left out, so a finding pasted from a diff is never dropped for it', async () => {
  const r = await repo(tempDir('m5-hunk-'));
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const check = (quote) => checkFindings([{ ...real1, quote }], readFile, readBase);
  for (const quote of ['@@ -5,3 +5,4 @@\n-  return part / whole;', '@@ -5,3 +5,4 @@ export function share(part, whole) {\n  return part / whole;\n@@ -1 +1 @@\n+  let sum = 0;', '@@ -5,3 +5,4 @@']) {
    assert.equal((await check(quote)).kept.length, 1, quote);
  }
  // The rest of the quote still has to stand somewhere.
  assert.equal((await check('@@ -5,3 +5,4 @@\n+  sum += tax')).dropped.length, 1);
  assert.equal((await check('  @@ not a header @@')).dropped.length, 1);
});

test('L432 planted: a session\'s own finalized mark proves nothing; M9 trusts a dropped finding only in the file the runner\'s record names', async () => {
  const forged = { pass: true, material: 0, finalized: true, notes: [{ ...real1, dropped: 'copied' }] };
  const w = await world(tempDir('m5-forge-'), { act: (l) => (l.role === 'auditor' ? rawVerdict(l, forged) : writeVerdict(l, { pass: true, checklist: CLEAN })) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.match(JSON.stringify(alerts), /the runner holds no record of that file/);
  assert.match(w.gate(), /only the runner marks a finding dropped, and the runner has no record of finalizing session S-2/);
  // A real one passes on the runner's record, and the record must name this very file.
  const ok = await world(tempDir('m5-forge2-'), { act: (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: false, material: 1, findings: [noise2] }) });
  ok.card.head = await ok.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  await ok.round(['reviewer', 'auditor']);
  assert.equal(ok.gate(), null);
  const rec = join(ok.root, 'finalized', 'S-2.json');
  const doc = JSON.parse(readFileSync(rec, 'utf8'));
  rmSync(rec);
  writeFileSync(rec, JSON.stringify({ ...doc, verdict_sha256: 'f'.repeat(64) }), { mode: 0o644 });
  assert.match(ok.gate(), /its record names another file/);
  rmSync(rec);
  writeFileSync(rec, JSON.stringify({ ...doc, head: 'a'.repeat(40) }), { mode: 0o644 });
  assert.match(ok.gate(), /is for another role, card or head/);
  rmSync(rec);
  assert.match(ok.gate(), /no record of finalizing/);
  // And a runner that gives no record finalizes nothing.
  assert.match((await finalize({ outboxRoot: ok.outboxRoot, uids: UIDS, role: 'auditor', sessionId: 'S-2', card: 'C-1', head: ok.card.head })).reason, /gave no record/);
});

test('L92 minor 2: a fail by either role sends the card back for both', async () => {
  const heads = [];
  const w = await world(tempDir('m5-both-'), { act: (l) => {
    const first = heads.indexOf(l.head) === 0;
    writeVerdict(l, l.role === 'auditor' ? { pass: !first, material: first ? 1 : 0, findings: first ? [real1] : [] } : { pass: true, checklist: { ...CLEAN } });
  } });
  for (let i = 0; i < 2; i += 1) {
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// fix ${i}\n` }, `round ${i}`);
    heads.push(w.card.head);
    await w.round(['reviewer', 'auditor']);
  }
  const next = w.s.launched.at(-2);
  assert.equal(next.role, 'reviewer');
  assert.equal(next.args[next.args.indexOf('--effort') + 1], 'xhigh');
  assert.ok(next.prompt.includes(real1.says), 'the reviewer sees the audit\'s findings');
});

test('L452 planted: a file saying it passed, with a finding this can\'t read, is refused; finalize refused it too, so it never passes', async () => {
  const reads = (fields) => verdictFields({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), ...fields } });
  const odd = [{ ...real1, level: 'Material' }, { ...real1, level: 'MATERIAL' }, { ...real1, level: 'material ' }, { says: 'x', quote: 'y' }, { severity: 'material' }, 'a string', 7, null, [real1]];
  for (const note of odd) {
    for (const says of [{ pass: true }, { pass: true, material: 0 }, { pass: false, material: 0 }]) {
      assert.match(reads({ ...says, notes: [note] }).reason ?? '', /a finding this can't read/, JSON.stringify([note, says]));
    }
    assert.equal(reads({ pass: false, material: 1, notes: [note] }).ok, true, 'a fail stays readable as a fail');
  }
  for (const notes of ['all fine', { level: 'material' }, 3]) assert.match(reads({ pass: true, notes }).reason ?? '', /can't read/);
  assert.equal(reads({ pass: true, material: 0, notes: [real2] }).ok, true);
  assert.equal(reads({ pass: true, material: 0, notes: [] }).ok, true);
  assert.equal(reads({ pass: true, material: 0 }).ok, true);
  // On the real runner, finalize and gate.
  for (const level of ['Material', 'material ', undefined]) {
    const w = await world(tempDir('m5-odd-'), { act: (l) => (l.role === 'auditor' ? rawVerdict(l, { pass: true, material: 0, notes: [{ ...real1, level }] }) : writeVerdict(l, { pass: true, checklist: CLEAN })) });
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
    const { alerts } = await w.round(['reviewer', 'auditor']);
    assert.ok(alerts.length > 0, 'Joe is told');
    assert.notEqual(w.gate(), null, String(level));
  }
});

test('L452 planted: a line of a real quote found is enough, so nothing else in a paste can make it noise', async () => {
  const r = await repo(tempDir('m5-paste-'));
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const check = (quote) => checkFindings([{ ...real1, quote }], readFile, readBase);
  for (const quote of [
    '--- a/chain/total.mjs\n+++ b/chain/total.mjs\n@@ -5,3 +5,4 @@\n   return part / whole;',
    'diff --git a/chain/total.mjs b/chain/total.mjs\nindex 1234567..89abcde 100644\n-  return part / whole;',
    '  @@ -5,3 +5,4 @@\n+  let sum = 0;',
    '+  let sum = 0;\n\\ No newline at end of file',
    'a line nobody wrote at all\n  return part / whole;',
  ]) assert.equal((await check(quote)).kept.length, 1, quote);
  // A wholly invented quote is still noise, and so is one of short lines not all there.
  for (const quote of ['const nothing = like.this();\n+ and nothing like this either', '--- a/chain/total.mjs\n+++ b/chain/total.mjs', 'x = 1;\nlet\nyy']) {
    assert.equal((await check(quote)).dropped.length, 1, quote);
  }
  // Short lines all there hold.
  assert.equal((await check('+ let\n- sum')).kept.length, 1);
});

test('L452 c1 planted: the runner\'s record is written before the file is renamed, and with no record the file stays as written', async () => {
  const fails = (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: false, material: 1, findings: [noise2] });
  const w = await world(tempDir('m5-order-'), { act: fails });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  const real = w.ctx.finalize; const kept = [];
  w.ctx.finalize = (a) => real({ ...a, mark: { read: a.mark.read, keep: (sha) => { kept.push([sha, w.fields(a.role, a.sessionId).finalized]); a.mark.keep(sha); } } });
  await w.round(['reviewer', 'auditor']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0][1], undefined, 'the file was not yet rewritten');
  assert.equal(kept[0][0], sha256(w.file('auditor', 'S-2')), 'the record names what the rename then put there');
  const no = await world(tempDir('m5-order2-'), { act: fails });
  no.card.head = await no.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}// a change\n` });
  const realNo = no.ctx.finalize;
  no.ctx.finalize = (a) => realNo({ ...a, mark: { read: a.mark.read, keep: () => { throw new Error('no record'); } } });
  await no.round(['reviewer', 'auditor']);
  assert.equal(no.fields('auditor', 'S-2').finalized, undefined, 'never a marked file the runner has no record of');
  assert.equal(no.fields('auditor', 'S-2').notes[0].dropped, undefined);
});
