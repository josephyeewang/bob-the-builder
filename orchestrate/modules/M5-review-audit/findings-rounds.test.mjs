// R-0b-145 and R-0b-146, end to end on the real runner, the wiring's own steps (the real wiring refuses every start
// until its launch checks can pass, L83 M-3: stand-in-start.test-helper.mjs), review copy, package and finalize, with a
// stand-in claude that writes the verdict each test gives it.
//   R-0b-145 (L469): finalize never drops a finding; what it can't find it labels, and no count or pass moves. It works
//     only inside one session's own verdict file, so two reviewers, one fail and one pass, are still refused (L68); a Tier-1 change goes
//     round after round until 0 Material, and a send-back runs at xhigh.
//   R-0b-146, scenario (h): two Tier-1 changes on different files of one number chain; after the first merges, the
//     second is refused on its carried-over audit and is audited again on its caught-up head. The short re-audit's own
//     start and framing come with the gate's half (L80, L424 m1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { runnerPass } from '../M4-workshop/launcher/review-runner.mjs';
import { standInStart } from './stand-in-start.test-helper.mjs';
import { MAX_OUTBOX_BYTES, PASSES, headReviews, sessionVerdict, verdictContent, verdictFields } from '../M9-record/outbox.mjs';
import { verdictProblem } from '../M6-merge-gate/refusals.mjs';
import { carryOver } from '../M10-rules/carry-over.mjs';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { QUOTE_NOTE, changeReaders, finalize, labelled, quoteFound } from './findings.mjs';
import { finalizeMark } from '../M4-workshop/launcher/review-runner.mjs';
import { verdictFileText, verdictFormat } from './verdict-file.mjs';
import { VERDICT_CHECKLIST } from '../../shared/record.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';
import { RUNNER_ROLES } from '../../shared/review-roles.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
// Every role the design table and the runner know, so a role main adds (script, plan_reviewer) is never left out (L824).
const UIDS = Object.fromEntries([...new Set([...Object.keys(DESIGN_PROFILES), ...RUNNER_ROLES])].map((r) => [r, RUNNER_ROLES.includes(r) ? ME : OTHER]));
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

// What finalize may do to a finding: add the two labels, nothing else.
const unlabelled = ({ quote_found: _f, quote_note: _n, ...rest }) => rest;
const isLabelled = (n) => n.quote_found === false && n.quote_note === QUOTE_NOTE;
const failing = (notes, material = notes.filter((f) => f.level === 'material').length) => (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: false, material, findings: notes });
const A_CHANGE = `${NUM.join('\n')}// a change\n`;

test('R-0b-145: the matcher finds real quotes and misses the two planted noise findings, and a line number means nothing', async () => {
  const d = tempDir('m5-fc-');
  const r = await repo(d);
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const has = (f) => quoteFound(f, readFile, readBase);
  for (const f of [real1, real2, real3, { ...real2, line: 40 }, { ...real2, line: 3, quote: 'let  sum = 0;\n  for (const r of rows)' }]) assert.equal(await has(f), true);
  for (const f of [noise1, noise2]) assert.equal(await has(f), false, f.says);
});

test('L469 planted: the 2 planted noise findings are kept and labelled, the file says what it said, and the review fails', async () => {
  const w = await world(tempDir('m5-fin-'), { act: (l) => writeVerdict(l, l.role === 'reviewer'
    ? { pass: false, checklist: { ...CLEAN, correct: 'material', holds_up: 'minor' }, findings: [noise1, real2, real3] }
    : { pass: false, material: 1, findings: [noise2] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': NUM.join('\n').replace('return sum;', 'return Math.round(sum);') });
  const { started } = await w.round(['reviewer', 'auditor']);
  assert.deepEqual(started, ['S-1', 'S-2']);
  const r = w.fields('reviewer', 'S-1');
  assert.deepEqual([r.pass, r.checklist], [false, { ...CLEAN, correct: 'material', holds_up: 'minor' }]);
  assert.deepEqual(r.notes.map(unlabelled), [noise1, real2, real3], 'every finding, in the order written');
  assert.deepEqual(r.notes.map(isLabelled), [true, false, false]);
  assert.equal(r.notes[0].quote_note, 'quote not found in the code: check whether this finding is real');
  assert.equal(Object.hasOwn(r.notes[1], 'quote_found'), false, 'a finding it found carries no label');
  const a = w.fields('auditor', 'S-2');
  assert.deepEqual([a.pass, a.material, a.notes.map(isLabelled)], [false, 1, [true]]);
  // Its ended record pins the labelled file; nothing else was left in either folder.
  const ended = JSON.parse(readFileSync(join(w.root, 'ended', 'S-1.json'), 'utf8'));
  assert.equal(ended.verdict_sha256, sha256(w.file('reviewer', 'S-1')));
  for (const [role, sid] of [['reviewer', 'S-1'], ['auditor', 'S-2']]) assert.deepEqual(readdirSync(join(w.outboxRoot, role, sid)), [`verdict-${sid}.md`]);
  assert.match(w.gate(), /did not pass/);
});

test('L469: non-Material findings and repeats stay too, the label is all that differs, and a file with nothing to label is not touched', async () => {
  const notes = [noise2, real1, { ...real1 }, { ...noise1, level: 'cosmetic' }];
  const w = await world(tempDir('m5-all-'), { act: (l) => (l.role === 'auditor' ? failing(notes, 3)(l) : writeVerdict(l, { pass: true, checklist: CLEAN, findings: [real2] })) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  await w.round(['reviewer', 'auditor']);
  const a = w.fields('auditor', 'S-2');
  assert.deepEqual([a.pass, a.material, a.notes.map(unlabelled)], [false, 3, notes], 'a count no finding accounts for stays too');
  assert.deepEqual(readdirSync(join(w.root, 'finalized')), ['S-2.json'], 'nothing to label, no record');
  const header = { entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), pass: false, material: 1, notes: [real1, noise2] } };
  const next = labelled(header, [true, false]);
  assert.deepEqual({ ...next, fields: { ...next.fields, notes: next.fields.notes.map(unlabelled) } }, header);
  assert.equal(verdictContent(next), verdictContent(header));
  // A label a session wrote itself is the runner's to set: it goes where the quote is found.
  const w2 = await world(tempDir('m5-own-'), { act: failing([{ ...real1, quote_found: false, quote_note: 'mine' }, { ...noise2, quote_found: true }]) });
  w2.card.head = await w2.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  await w2.round(['reviewer', 'auditor']);
  const b = w2.fields('auditor', 'S-2');
  assert.deepEqual(b.notes.map(isLabelled), [false, true]);
  assert.equal(Object.hasOwn(b.notes[0], 'quote_found'), false);
  assert.match(w2.gate(), /did not pass/);
  // Only a session's own label, and every quote found: the label goes, and the verdict counts.
  const w3 = await world(tempDir('m5-own2-'), { act: (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: true, material: 0, findings: [{ ...real2, quote_found: false }] }) });
  w3.card.head = await w3.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  await w3.round(['reviewer', 'auditor']);
  assert.equal(Object.hasOwn(w3.fields('auditor', 'S-2').notes[0], 'quote_found'), false);
  assert.equal(w3.gate(), null);
});

test('R-0b-145 planted: two reviewers, one fail and one pass, plus a finalize step, is still refused', async () => {
  const w = await world(tempDir('m5-two-'), { act: (l) => { writeVerdict(l, l.role === 'auditor' ? { pass: true, material: 0 }
    : l.path.includes('/S-1/') ? { pass: false, checklist: { ...CLEAN, correct: 'material' }, findings: [real1] } : { pass: true, checklist: CLEAN, findings: [{ ...noise1, level: 'minor' }] }); } });
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

// L92 M-1: a fail never turns into a pass.
test('L92 M-1 planted: a real Material beside labelled noise keeps the verdict a fail, at M5 and at M9', async () => {
  const { on: _on, ...noLine } = real1;
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
test('L92 M-2 planted: a finding about a removed line, a deleted file, a diff quote or a link is found', async () => {
  const r = await repo(tempDir('m5-m2-'));
  await r.g(['switch', '-q', '-c', 'card/rm', 'main']);
  writeFileSync(join(r.src, 'chain', 'total.mjs'), [...NUM.slice(0, 7), '  return Math.round(part);', ...NUM.slice(8)].join('\n'));
  await r.g(['rm', '-q', 'chain/share.mjs']);
  symlinkSync('total.mjs', join(r.src, 'chain', 'link.mjs'));
  await r.g(['add', '.']); await r.g(['commit', '-q', '-m', 'takes things away']);
  const head = await r.rev('HEAD');
  await r.g(['switch', '-q', 'main']);
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  const check = (f) => quoteFound({ level: 'material', says: 'x', ...f }, readFile, readBase);
  const kept = async (what, f) => assert.equal(await check(f), true, what);
  await kept('a removed line', { file: 'chain/total.mjs', line: 8, quote: 'return part / whole;' });
  await kept('a removed line cited far from where it was', { file: 'chain/total.mjs', line: 1, quote: 'return part / whole;' });
  await kept('a deleted file', { file: 'chain/share.mjs', line: 90 });
  await kept('a quote from a deleted file', { file: 'chain/share.mjs', line: 90, quote: 'export const pct' });
  await kept('a quote as the diff shows it, added', { file: 'chain/total.mjs', line: 8, quote: '+  return Math.round(part);' });
  await kept('a quote as the diff shows it, removed', { file: 'chain/total.mjs', line: 8, quote: '-  return part / whole;' });
  await kept('a quote across both sides of the diff', { file: 'chain/total.mjs', line: 8, quote: '-  return part / whole;\n+  return Math.round(part);' });
  await kept('a path that is a link at the head', { file: 'chain/link.mjs', line: 5, quote: 'not what the link points at' });
  const missing = async (what, f) => assert.equal(await check(f), false, what);
  await missing('a file on neither side', { file: 'chain/none.mjs' });
  await missing('a quote on neither side', { file: 'chain/total.mjs', line: 8, quote: 'sum += tax' });
  await missing('a quote not in a deleted file', { file: 'chain/share.mjs', quote: 'sum += tax' });
  // L424: a line number is never looked at, past the end of both sides or not.
  await kept('a line past the end on both', { file: 'chain/total.mjs', line: 90 });
  await kept('a quote the head still has, on the wrong line', { file: 'chain/total.mjs', line: 9, quote: 'return sum;' });
  // The mirror failing to answer is no evidence: finalize stops, and the file gets no label.
  await assert.rejects(changeReaders({ gitDir: r.gd, head: '0'.repeat(40) }));
  const blob = (await gitOk(['rev-parse', `${head}:chain/total.mjs`], { gitDir: r.gd })).trim();
  rmSync(join(r.gd, 'objects', blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(readFile('chain/total.mjs'), /could not be read at/);
  renameSync(r.gd, `${r.gd}-gone`);
  await assert.rejects(readFile('chain/total.mjs'));
});

// L424: whether a quote is found is worked out from the whole of both files, never from a line number.
test('L424 F1 planted: a removed line whose text stands elsewhere too is found, whichever side its line is counted on', async () => {
  const r = await repo(tempDir('m5-f1-'));
  const guard = '  if (w === 0) return 0;';
  const lines = Array.from({ length: 60 }, (_, i) => (i === 4 || i === 49 ? guard : `  step(${i});`));
  await r.commit('main', { 'chain/f.mjs': `${lines.join('\n')}\n` });
  const after = [...Array.from({ length: 20 }, (_, i) => `  added(${i});`), ...lines.slice(0, 49), ...lines.slice(50)];
  const head = await r.commit('card/f1', { 'chain/f.mjs': `${after.join('\n')}\n` });
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  for (const quote of [guard.trim(), `-${guard}`]) {
    assert.equal(await quoteFound({ level: 'material', says: 'the guard went', file: 'chain/f.mjs', line: 70, quote }, readFile, readBase), true, quote);
  }
});

test('L424 F3 planted: a quote longer than a few lines is found, cited at its first line or its last, and with Windows line ends', async () => {
  const r = await repo(tempDir('m5-f3-'));
  const head = await r.commit('card/f3', { 'chain/share.mjs': '// a change\n' });
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  const quote = NUM.slice(0, 8).join('\n');
  for (const f of [{ line: 1, quote }, { line: 8, quote }, { line: 1, quote: quote.replaceAll('\n', '\r\n') }]) {
    assert.equal(await quoteFound({ level: 'material', says: 'x', file: 'chain/total.mjs', ...f }, readFile, readBase), true, f.line);
  }
});

test('L424 m4 planted: a file the change shortens still has a finding on a line only the base reaches', async () => {
  const r = await repo(tempDir('m5-short-'));
  const head = await r.commit('card/short', { 'chain/total.mjs': `${NUM.slice(0, 3).join('\n')}\n` });
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head });
  for (const f of [{ line: 8 }, { line: 8, quote: 'return part / whole;' }]) {
    assert.equal(await quoteFound({ level: 'material', says: 'x', file: 'chain/total.mjs', ...f }, readFile, readBase), true);
  }
});

const rawVerdict = (l, fields) => writeFileSync(l.path, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: l.head, ...fields } })}\n`, { mode: 0o644 });

// L424 F2, L469: nothing writes a `dropped` key now, so one in a file means nothing and hides nothing.
test('L469 planted: a dropped key takes nothing away, a pass that lists such a finding is refused, and a finalized field is refused', async () => {
  const cases = [
    { pass: false, material: 1, notes: [noise2, { ...real1, dropped: 'copied' }] },
    { pass: true, material: 0, notes: [{ ...real1, dropped: 'copied' }] },
    { pass: true, material: 0, notes: [{ ...real1, dropped: '' }] },
    { pass: true, checklist: CLEAN, notes: [{ ...real1, dropped: 'x' }] },
  ];
  for (const verdict of cases) {
    const w = await world(tempDir('m5-f2-'), { act: (l) => (l.role === 'auditor' ? rawVerdict(l, verdict) : writeVerdict(l, { pass: true, checklist: CLEAN })) });
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
    await w.round(['reviewer', 'auditor']);
    assert.notEqual(w.gate(), null, JSON.stringify(verdict));
  }
  const reads = (f) => verdictFields({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), ...f } });
  assert.match(reads({ pass: true, material: 0, finalized: true }).reason, /may not set finalized/);
  assert.match(verdictFormat({ role: 'auditor', card: 'C-1', head: 'a'.repeat(40) }), /"quote_found" and "quote_note" are the runner's own labels: leave them off/);
  assert.match(verdictFormat({ role: 'auditor', card: 'C-1', head: 'a'.repeat(40) }), /It stays in the verdict and still counts/);
});

test('L424 m3 planted: a verdict listing a Material finding that says it passed is refused, and finalize leaves it as written', async () => {
  const none = { level: 'material', says: 'the chain double counts' };
  const w = await world(tempDir('m5-m3-'), { act: (l) => rawVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN, notes: [none] } : { pass: true, material: 0, notes: [real1] }) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  await w.round(['reviewer', 'auditor']);
  assert.deepEqual([w.fields('auditor', 'S-2').pass, w.fields('auditor', 'S-2').material], [true, 0], 'left as written');
  assert.notEqual(w.gate(), null);
  assert.deepEqual(readdirSync(join(w.root, 'finalized')), []);
});

test('L469: finalize run again changes nothing, and a stop after the record and before the rename ends at the same file', async () => {
  const w = await world(tempDir('m5-again-'), { act: failing([noise2]) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  await w.round(['reviewer', 'auditor']);
  const was = sha256(w.file('auditor', 'S-2'));
  const mark = finalizeMark({ dir: join(w.root, 'finalized'), uid: ME, role: 'auditor', card: 'C-1', head: w.card.head, sessionId: 'S-2' });
  const content = () => verdictContent(JSON.parse(readFileSync(w.file('auditor', 'S-2'), 'utf8').split('\n')[0]));
  assert.equal(mark.read(), content(), 'the runner\'s record names what the file says');
  const again = await w.ctx.finalize({ role: 'auditor', sessionId: 'S-2', card: 'C-1', head: w.card.head, mark });
  assert.deepEqual([again.ok, again.changed, again.labelled], [true, false, 1]);
  assert.equal(sha256(w.file('auditor', 'S-2')), was);
  assert.equal(Object.hasOwn(w.fields('reviewer', 'S-1'), 'finalized'), false);
  writeVerdict({ path: w.file('auditor', 'S-2'), head: w.card.head, role: 'auditor' }, { pass: false, material: 1, findings: [noise2] });
  const retry = await w.ctx.finalize({ role: 'auditor', sessionId: 'S-2', card: 'C-1', head: w.card.head, mark });
  assert.deepEqual([retry.ok, retry.changed], [true, true], retry.reason);
  assert.equal(sha256(w.file('auditor', 'S-2')), was);
});

test('L432 planted: a file listing a Material finding that says pass: true or material: 0 is refused', async () => {
  const reads = (fields) => verdictFields({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), ...fields } });
  for (const f of [{ pass: true, material: 0, notes: [real1] }, { pass: true, material: 1, notes: [real1] }, { pass: false, material: 0, notes: [real1] }, { pass: true, checklist: CLEAN, notes: [real1] }, { pass: true, material: 0, notes: [{ ...noise1, quote_found: false, quote_note: QUOTE_NOTE }] }]) {
    assert.match(reads(f).reason ?? '', /lists a Material finding/, JSON.stringify(f));
  }
  // A fail that says so stands; so does a pass with nothing Material in it.
  assert.equal(reads({ pass: false, material: 1, notes: [real1] }).ok, true);
  assert.equal(reads({ pass: false, notes: [real1] }).ok, true);
  assert.equal(reads({ pass: true, material: 0, notes: [real2] }).ok, true);
  // Finalize can't run, here the mirror is down: the file stays as written, and the gate refuses a fail.
  const w = await world(tempDir('m5-l432-'), { act: failing([real1]) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  w.ctx.finalize = async () => { throw new Error('the mirror is down'); };
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.deepEqual([w.fields('auditor', 'S-2').pass, w.fields('auditor', 'S-2').material], [false, 1], 'left as written');
  assert.ok(JSON.stringify(alerts).includes('could not be check'), 'Joe is told');
  assert.notEqual(w.gate(), null);
});

test('L432 planted: a hunk header in a quote is left out, so a finding pasted from a diff is found', async () => {
  const r = await repo(tempDir('m5-hunk-'));
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const check = (quote) => quoteFound({ ...real1, quote }, readFile, readBase);
  for (const quote of ['@@ -5,3 +5,4 @@\n-  return part / whole;', '@@ -5,3 +5,4 @@ export function share(part, whole) {\n  return part / whole;\n@@ -1 +1 @@\n+  let sum = 0;', '@@ -5,3 +5,4 @@']) {
    assert.equal(await check(quote), true, quote);
  }
  // The rest of the quote still has to stand somewhere.
  assert.equal(await check('@@ -5,3 +5,4 @@\n+  sum += tax'), false);
  // An indented one is set aside too, so nothing checkable is left (L464).
  assert.equal(await check('  @@ -5,3 +5,4 @@'), true);
});

test('L469 planted: M9 refuses a labelled file that says anything else than the session wrote, and a label with no record', async () => {
  const labelledRun = async (name, act) => {
    const w = await world(tempDir(name), { act });
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
    await w.round(['reviewer', 'auditor']);
    return w;
  };
  // Put a changed file in place and pin it, as a finalize that went further than the label would have.
  const tamper = (w, change) => {
    const p = w.file('auditor', 'S-2');
    const h = JSON.parse(readFileSync(p, 'utf8').split('\n')[0]);
    change(h.fields);
    writeFileSync(p, `${JSON.stringify(h)}\n`);
    const rec = join(w.root, 'ended', 'S-2.json');
    const doc = JSON.parse(readFileSync(rec, 'utf8'));
    rmSync(rec);
    writeFileSync(rec, JSON.stringify({ ...doc, verdict_sha256: sha256(p) }), { mode: 0o644 });
  };
  const changes = [
    (f) => { f.pass = true; f.material = 0; f.notes = []; },
    (f) => { f.pass = true; f.material = 0; f.notes[0].level = 'minor'; },
    (f) => { f.material = 2; },
    (f) => { f.notes.push({ ...real2 }); },
    (f) => { f.notes[0].says = 'something else'; },
  ];
  for (const change of changes) {
    const w = await labelledRun('m5-rec-', failing([noise2]));
    tamper(w, change);
    assert.match(w.gate(), /finalize changed more than its label/, String(change));
  }
  // A fail with no Material in it: pass alone turned true reads as a pass, and only the record catches it.
  const f = await labelledRun('m5-rec3-', (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: false, material: 0, findings: [{ ...noise2, level: 'minor' }] }));
  assert.match(f.gate(), /did not pass/);
  tamper(f, (x) => { x.pass = true; });
  assert.match(f.gate(), /finalize changed more than its label/);
  // The labels alone are free: a label changed, or gone, says the same.
  const w = await labelledRun('m5-rec2-', (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: true, material: 0, findings: [{ ...noise2, level: 'minor' }] }));
  assert.equal(w.fields('auditor', 'S-2').notes[0].quote_found, false);
  assert.equal(w.gate(), null, 'a label on a Minor finding blocks nothing');
  tamper(w, (f) => { f.notes[0].quote_note = 'other words'; });
  assert.equal(w.gate(), null);
  // The record: another head, none at all, or a file with labels that finalize never saw.
  const rec = join(w.root, 'finalized', 'S-2.json');
  const doc = JSON.parse(readFileSync(rec, 'utf8'));
  rmSync(rec);
  writeFileSync(rec, JSON.stringify({ ...doc, head: 'a'.repeat(40) }), { mode: 0o644 });
  assert.match(w.gate(), /is for another role, card or head/);
  rmSync(rec);
  assert.match(w.gate(), /its findings are labelled, but the runner has no record/);
  // And a runner that gives no record labels nothing.
  assert.match((await finalize({ outboxRoot: w.outboxRoot, uids: UIDS, role: 'auditor', sessionId: 'S-2', card: 'C-1', head: w.card.head })).reason, /gave no record/);
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

test('L452 planted: a file saying it passed, with a finding this can\'t read, is refused; finalize can\'t label it either, so it never passes', async () => {
  const reads = (fields) => verdictFields({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: 'a'.repeat(40), ...fields } });
  const odd = [{ ...real1, level: 'clean' }, { ...real1, level: 'Material' }, { ...real1, level: 'MATERIAL' }, { ...real1, level: 'material ' }, { says: 'x', quote: 'y' }, { severity: 'material' }, 'a string', 7, null, [real1]];
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

test('L452 planted: a line of a real quote found is enough, so nothing else in a paste loses it', async () => {
  const r = await repo(tempDir('m5-paste-'));
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const check = (quote) => quoteFound({ ...real1, quote }, readFile, readBase);
  for (const quote of [
    '--- a/chain/total.mjs\n+++ b/chain/total.mjs\n@@ -5,3 +5,4 @@\n   return part / whole;',
    'diff --git a/chain/total.mjs b/chain/total.mjs\nindex 1234567..89abcde 100644\n-  return part / whole;',
    '  @@ -5,3 +5,4 @@\n+  let sum = 0;',
    '+  let sum = 0;\n\\ No newline at end of file',
    'a line nobody wrote at all\n  return part / whole;',
  ]) assert.equal(await check(quote), true, quote);
  // A wholly invented quote is not found, nor is one of short lines not all there.
  for (const quote of ['const nothing = like.this();\n+ and nothing like this either', 'x = 1;\nlet\nyy']) {
    assert.equal(await check(quote), false, quote);
  }
  // Short lines all there hold.
  assert.equal(await check('+ let\n- sum'), true);
});

test('L452 c1 planted: the runner\'s record is written before the file is renamed, and with no record the file stays as written', async () => {
  const w = await world(tempDir('m5-order-'), { act: failing([noise2]) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  const real = w.ctx.finalize; const kept = [];
  w.ctx.finalize = (a) => real({ ...a, mark: { read: a.mark.read, keep: (sha) => { if (a.role === 'auditor') kept.push([sha, w.fields(a.role, a.sessionId).notes[0].quote_found]); a.mark.keep(sha); } } });
  await w.round(['reviewer', 'auditor']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0][1], undefined, 'the file was not yet labelled');
  assert.equal(kept[0][0], verdictContent(JSON.parse(readFileSync(w.file('auditor', 'S-2'), 'utf8').split('\n')[0])), 'the record names what the rename then put there');
  const no = await world(tempDir('m5-order2-'), { act: failing([noise2]) });
  no.card.head = await no.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  const realNo = no.ctx.finalize;
  no.ctx.finalize = (a) => realNo({ ...a, mark: { read: a.mark.read, keep: () => { throw new Error('no record'); } } });
  await no.round(['reviewer', 'auditor']);
  assert.equal(Object.hasOwn(no.fields('auditor', 'S-2').notes[0], 'quote_found'), false, 'never a labelled file the runner has no record of');
  assert.deepEqual(readdirSync(dirname(no.file('auditor', 'S-2'))).filter((n) => n.startsWith('.')), [], 'and no temporary file is left');
});

const PASTED = '--- a/chain/total.mjs\n+++ b/chain/total.mjs\n@@ -7,2 +7,3 @@\n+  return;';

test('L464 planted: a header line is no evidence, so a short real line under one is found, through finalize and gate', async () => {
  const fails = (l) => writeVerdict(l, l.role === 'reviewer' ? { pass: true, checklist: CLEAN } : { pass: false, material: 1, findings: [{ ...real1, quote: PASTED }] });
  const w = await world(tempDir('m5-short-'), { act: fails });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}  return;\n` });
  await w.round(['reviewer', 'auditor']);
  const v = w.fields('auditor', 'S-2');
  assert.equal(v.pass, false);
  assert.equal(v.material, 1);
  assert.equal(Object.hasOwn(v.notes[0], 'quote_found'), false);
  assert.notEqual(w.gate(), null, 'a real Material finding is never a pass');
});

test('L464 planted: only a quote shown to be absent is labelled; a shape it can\'t tell gets no label', async () => {
  const r = await repo(tempDir('m5-absent-'));
  const { readFile, readBase } = await changeReaders({ gitDir: r.gd, head: await r.rev('main') });
  const check = (quote) => quoteFound({ ...real1, quote }, readFile, readBase);
  const kept = [
    // Nothing checkable left: a new file, a deleted one, mode lines, a bare header.
    '--- /dev/null\n+++ b/new.mjs',
    'diff --git a/new.mjs b/new.mjs\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/new.mjs',
    'diff --git a/gone.mjs b/gone.mjs\ndeleted file mode 100644\n--- a/gone.mjs\n+++ /dev/null',
    'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755',
    'rename from chain/a.mjs\nrename to chain/b.mjs\nsimilarity index 90%',
    'Binary files a/logo.png and b/logo.png differ',
    '\\ No newline at end of file',
    '--- a/chain/total.mjs\n+++ b/chain/total.mjs\n@@ -1,2 +1,3 @@',
    // A short real line under long junk, however the junk is pasted.
    'diff --git a/chain/total.mjs b/chain/total.mjs\nindex 1234567..89abcde 100644\n+  let',
    '+  let\n\\ No newline at end of file',
    'a line nobody wrote at all\n+  let',
    '\x60\x60\x60js\n+  let\n\x60\x60\x60',
    '...\nlet\n…',
    '~~~\n}\n~~~',
    '+  let\r-  sum',
    // Line numbers, from grep -n and cat -n, on long lines and short.
    '3:   return part / whole;',
    '2   let sum = 0;\n3   return part / whole;',
    '     2\t  let\n     3\t  sum',
    'chain/total.mjs:8:  return part / whole;',
    '8:+  return part / whole;',
    // The boundary: eight non-space characters are enough alone.
    'let sum = 0\nzz',
  ];
  for (const quote of kept) assert.equal(await check(quote), true, quote);
  // Seven are not, however many spaces pad them.
  assert.equal(await check('a b c d e f g\nlet'), false);
  assert.equal(await check('nothing at all\nzz'), false);
  assert.equal(await check('8:  nothing at all here'), false);
  assert.equal(await check('diff --git a/x b/x\n+  nothing at all here'), false);
});

// r5's repros: real Material findings the old drop path turned into a pass. Each stays a fail and the gate refuses,
// whatever the matcher makes of the quote.
const renamed = async (w) => {
  await w.g(['switch', '-q', '-c', 'card/c-1', 'main']);
  await w.g(['mv', 'chain/total.mjs', 'chain/sum.mjs']);
  writeFileSync(join(w.src, 'chain', 'sum.mjs'), NUM.filter((l) => l !== '  let sum = 0;').join('\n'));
  await w.g(['add', '-A']); await w.g(['commit', '-q', '-m', 'rename']);
  const h = await w.rev('HEAD');
  await w.g(['switch', '-q', 'main']);
  return h;
};
for (const [name, quote, { file = 'chain/total.mjs', setup } = {}] of [
  ['an elision inside a long line', 'export function share(part, whole) { ... }'],
  ['an elision inside a short line', 'return; ...'],
  ['a short real line beside a short note', '+  return;\n// here'],
  ['short real lines around a snip', 'lock();\n(snip)\nreturn;'],
  ['a removed line in a renamed file, at the new path', '-  let sum = 0;', { file: 'chain/sum.mjs', setup: renamed }],
  ['a path copied from a diff header', 'return part / whole;', { file: 'a/chain/total.mjs' }],
  ['a path with a line number', 'return part / whole;', { file: 'chain/total.mjs:8' }],
  ['a quote in backticks', '\x60return part / whole;\x60'],
  ['a grep -C context line', 'chain/total.mjs-8-  return part / whole;'],
]) {
  test(`L469 planted, r5: ${name} stays a fail, and the gate refuses`, async () => {
    const f = { ...real1, file, quote };
    const w = await world(tempDir('m5-r5-'), { act: failing([f]) });
    w.card.head = setup ? await setup(w) : await w.commit('card/c-1', { 'chain/total.mjs': `${NUM.join('\n')}  return;\n` });
    await w.round(['reviewer', 'auditor']);
    const v = w.fields('auditor', 'S-2');
    assert.deepEqual([v.pass, v.material, v.notes.map(unlabelled)], [false, 1, [f]]);
    assert.match(w.gate(), /the auditor session S-2 did not pass/);
  });
}

// L482: a finalize that goes wrong, as the runner meets it. Each writes no label the record would catch, or a record of
// its own change, so only the runner's read of the file before finalize can see it. r6's G1, G1b, G2 and a level change.
const swapFile = (p, change) => {
  const h = JSON.parse(readFileSync(p, 'utf8').split('\n')[0]);
  change(h);
  writeFileSync(`${p}.x`, `${JSON.stringify(h)}\n`, { mode: 0o644 });
  renameSync(`${p}.x`, p);
  return h;
};
for (const [name, bad, after] of [
  ['drops a Material, says it passed, no label, no record', (h) => { h.fields.notes = []; h.fields.pass = true; h.fields.material = 0; }, [true, 0, 0]],
  ['drops a finding only', (h) => { h.fields.notes = []; }, [false, 2, 0]],
  ['turns a Material into a minor and says it passed', (h) => { h.fields.notes = h.fields.notes.map((n) => ({ ...n, level: 'minor' })); h.fields.pass = true; h.fields.material = 0; }, [true, 0, 2]],
  ['changes only a level', (h) => { h.fields.notes = h.fields.notes.map((n) => ({ ...n, level: 'minor' })); }, [false, 2, 2]],
  ['labels, says it passed, and records what it changed', (h) => { h.fields.notes = h.fields.notes.map((n) => ({ ...n, level: 'minor', quote_found: false, quote_note: QUOTE_NOTE })); h.fields.pass = true; h.fields.material = 0; }, [true, 0, 2], true],
].map(([n, b, a, rec]) => [n, (w, x) => { const h = swapFile(w.file('auditor', x.sessionId), b); if (rec) x.mark.keep(verdictContent(h)); }, a])) {
  test(`L482 planted: a finalize that ${name} is refused, and the owner is told`, async () => {
    const w = await world(tempDir('m5-guard-'), { act: failing([real1, noise2], 2) });
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
    w.ctx.finalize = async (x) => { if (x.role === 'auditor') bad(w, x); return { ok: true }; };
    const { alerts } = await w.round(['reviewer', 'auditor']);
    const v = w.fields('auditor', 'S-2');
    assert.deepEqual([v.pass, v.material, v.notes.length], after, 'the change this test plants is in the file');
    assert.match(JSON.stringify(alerts), /finalize changed the review beyond its labels, so it is refused/);
    assert.equal(JSON.parse(readFileSync(join(w.root, 'ended', 'S-2.json'), 'utf8')).verdict_sha256, 'refused');
    assert.notEqual(w.gate(), null);
  });
}

test('L482 planted: a finalize that removes the file is refused, not read as a session that said nothing', async () => {
  const w = await world(tempDir('m5-guard3-'), { act: failing([real1, noise2], 2) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  w.ctx.finalize = async (x) => { if (x.role === 'auditor') rmSync(w.file('auditor', x.sessionId)); return { ok: true }; };
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.match(JSON.stringify(alerts), /finalize changed the review beyond its labels, so it is refused/);
  assert.equal(JSON.parse(readFileSync(join(w.root, 'ended', 'S-2.json'), 'utf8')).verdict_sha256, 'refused');
  assert.notEqual(w.gate(), null);
});

test('L482 planted: the guard is measured before finalize, and a label alone never trips it', async () => {
  const w = await world(tempDir('m5-guard2-'), { act: failing([real1, noise2], 2) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.equal(w.fields('auditor', 'S-2').notes[1].quote_found, false);
  assert.doesNotMatch(JSON.stringify(alerts), /beyond its labels/);
  assert.match(JSON.parse(readFileSync(join(w.root, 'ended', 'S-2.json'), 'utf8')).verdict_sha256, /^[0-9a-f]{64}$/);
});

test('L482 m2 planted: a session\'s own temporary file stops finalize before there is a record, so its forged label gets none', async () => {
  const forged = { ...real2, quote_found: true, quote_note: 'verified by the runner' };
  const act = (l) => {
    if (l.role === 'reviewer') return writeVerdict(l, { pass: true, checklist: CLEAN });
    writeFileSync(join(dirname(l.path), `.finalize-${basename(dirname(l.path))}`), 'mine');
    writeFileSync(l.path, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: l.head, pass: true, material: 0, notes: [forged] } })}\n`, { mode: 0o644 });
  };
  const w = await world(tempDir('m5-temp-'), { act });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.equal(w.fields('auditor', 'S-2').notes[0].quote_note, 'verified by the runner', 'the file is left as written');
  assert.deepEqual(readdirSync(join(w.root, 'finalized')), []);
  assert.match(JSON.stringify(alerts), /could not be checked/);
  assert.match(w.gate(), /its findings are labelled, but the runner has no record/);
});

const minorNoise = (n) => Array.from({ length: n }, () => ({ ...noise2, level: 'minor' }));
const passingFile = (l, notes) => writeFileSync(l.path, `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: l.head, pass: true, material: 0, notes } })}\n`, { mode: 0o644 });

test('L482 m1 planted: labels that would take a passing file over the limit are skipped, with one alert, and each file is read once', { timeout: 120_000 }, async () => {
  const act = (l) => (l.role === 'reviewer' ? writeVerdict(l, { pass: true, checklist: CLEAN }) : passingFile(l, minorNoise(2200).map((n) => ({ ...n, says: 'x' }))));
  const w = await world(tempDir('m5-big-'), { act });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  const reads = { head: 0, base: 0 };
  let took = 0;
  w.ctx.finalize = async ({ role, sessionId, card, head, mark }) => {
    const r = await changeReaders({ gitDir: w.gd, head });
    const count = (k, read) => (p) => { reads[k] += 1; return read(p); };
    const t = Date.now();
    const z = await finalize({ outboxRoot: w.outboxRoot, uids: UIDS, role, sessionId, card, head, owner: ME, mark, readFile: count('head', r.readFile), readBase: count('base', r.readBase) });
    if (role === 'auditor') took = Date.now() - t;
    return z;
  };
  const { alerts } = await w.round(['reviewer', 'auditor']);
  assert.equal(readFileSync(w.file('auditor', 'S-2')).length <= MAX_OUTBOX_BYTES, true, 'the file fits as written');
  assert.equal((JSON.stringify(alerts).match(/labels skipped: the file would be too large/g) ?? []).length, 1);
  assert.deepEqual(reads, { head: 1, base: 1 });
  assert.equal(took < 30_000, true, `${took} ms`);
  assert.equal(Object.hasOwn(w.fields('auditor', 'S-2').notes[0], 'quote_found'), false);
  assert.deepEqual(readdirSync(join(w.root, 'finalized')), []);
  assert.equal(w.gate(), null, 'a pass stays a pass');
});

for (const [over, labels] of [[0, true], [1, false]]) {
  test(`L482 m1 planted: ${over} byte${over === 1 ? '' : 's'} past the limit once labelled, the labels are ${labels ? 'written' : 'skipped'}, and the alert says so`, async () => {
    const act = (l) => {
      if (l.role === 'reviewer') return writeVerdict(l, { pass: true, checklist: CLEAN });
      const notes = minorNoise(1000);
      notes[0].says = `é${notes[0].says}`;
      const h = { entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head: l.head, pass: true, material: 0, notes } };
      const size = Buffer.byteLength(`${JSON.stringify(labelled(h, notes.map(() => false)))}\n`);
      notes[0].says += 'x'.repeat(MAX_OUTBOX_BYTES - size + over);
      passingFile(l, notes);
    };
    const w = await world(tempDir('m5-edge-'), { act });
    w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
    const { alerts } = await w.round(['reviewer', 'auditor']);
    const said = JSON.stringify(alerts);
    assert.equal(Object.hasOwn(w.fields('auditor', 'S-2').notes[0], 'quote_found'), labels);
    assert.equal((said.match(/labels skipped: the file would be too large/g) ?? []).length, labels ? 0 : 1);
    assert.equal(w.gate(), null);
  });
}

test('L738 re-merge planted: finalize leaves a file as written when it holds a finding it can\'t check, is for another card or head, or has a second verdict beside it', async () => {
  const w = await world(tempDir('m5-refuse-'), { act: failing([noise2]) });
  w.card.head = await w.commit('card/c-1', { 'chain/total.mjs': A_CHANGE });
  await w.round(['reviewer', 'auditor']);
  const f = w.file('auditor', 'S-2');
  const mark = finalizeMark({ dir: join(w.root, 'finalized'), uid: ME, role: 'auditor', card: 'C-1', head: w.card.head, sessionId: 'S-2' });
  // M5's finalize itself, with readers that would fail the test: each refusal comes before any file is read.
  const unread = async () => { throw new Error('nothing is read before these checks'); };
  const go = (o = {}) => finalize({ outboxRoot: w.outboxRoot, uids: UIDS, role: 'auditor', sessionId: 'S-2', card: 'C-1', head: w.card.head, readFile: unread, readBase: unread, owner: ME, mark, ...o });
  rawVerdict({ path: f, head: w.card.head }, { pass: false, material: 1, notes: [noise2, 'a string'] });
  let was = sha256(f);
  const odd = await go();
  assert.equal(odd.ok, false);
  assert.match(odd.reason, /a finding can't be checked/);
  assert.equal(sha256(f), was, 'left as written');
  writeVerdict({ path: f, head: w.card.head, role: 'auditor' }, { pass: false, material: 1, findings: [noise2] });
  was = sha256(f);
  for (const other of [{ card: 'C-2' }, { head: 'b'.repeat(40) }]) {
    const r = await go(other);
    assert.match(r.reason ?? '', /another card or head/, JSON.stringify(other));
    assert.equal(sha256(f), was);
  }
  const second = join(dirname(f), basename(f).replace(/^verdict-/, 'verdict-2'));
  assert.notEqual(second, f);
  writeFileSync(second, readFileSync(f), { mode: 0o644 });
  const two = await go();
  assert.match(two.reason ?? '', /more than one verdict file/);
  assert.equal(sha256(f), was);
  // L783 (#64 audit m1): a verdict followed by a second line is left as written, not cut to its header.
  rmSync(second);
  appendFileSync(f, 'a second line\n');
  was = sha256(f);
  const long = await go();
  assert.match(long.reason ?? '', /more than its one line/);
  assert.equal(sha256(f), was, 'left as written');
});
