// go-card.test.mjs — the owner's go by command (lane N, N2; L1082, L1096): on a real Record with a card a Lead wrote
// through its outbox, real M2 asks and gos, through to the Dispatcher's own pass moving the card to ready. Plus the
// L1096 plants: stdin piped with the right id, no terminal, and a wrong id, each refused.
// Run: node --test orchestrate/setup/go-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, PRODUCT, must } from '../modules/M2-approvals/fixtures.test-helper.mjs';
import { leadCard, product } from '../modules/M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from '../modules/M2-approvals/fixtures/fake-github.mjs';
import { makeGitView } from '../modules/M10-rules/git-view.mjs';
import { askStore } from '../modules/M2-approvals/ask-store.mjs';
import { createAsk } from '../modules/M2-approvals/binding.mjs';
import { doneBar } from '../modules/M2-approvals/go.mjs';
import { answerByOwnerCommand, OWNER_COMMAND } from '../modules/M2-approvals/owner-command.mjs';
import { planGoPass } from '../modules/M11-dispatcher/plan-go.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { canonicalJson } from '../shared/plan-fingerprint.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { GO_CARD_PRODUCT, goCard, main, ttyConfirm, whoProblem } from './go-card.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROWS = { 'R-1': { id: 'R-1', what: 'row R-1', module: 'M1', tier: 2, done_when: 'tests pass for R-1', status: 'planned' } };
const FILES = ['src/a.mjs', 'docs/blueprint/rows/R-1.yaml'];
const OWNER = 501;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function world({ card = {} } = {}) {
  const t = env({ values: { 'caps.rounds': 3, 'product_state_rules.active.start': 'within_caps', 'product_state_rules.paused.start': 'none' } });
  product(t);
  const g = fakeGitHub({ now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one', 'docs/blueprint/rows/R-1.yaml': 'id: R-1\n' });
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  // The Lead's card, through its outbox (the fixture's roadmap- file), as the first run's would come in.
  if (card !== null) leadCard(t, 'C-1', { what: 'add the first thing', files: FILES, done_when: doneBar(ROWS), ...card });
  const w = { t, M0, view, shown: [], rowsAsked: [] };
  w.readRows = async (x) => { w.rowsAsked.push(x); return ROWS; };
  w.yes = ({ cardId, text }) => { w.shown.push(text); return { ok: true, cardId }; };
  return w;
}
const run = (w, over = {}) => goCard({ ctx: w.t.ctx, cardId: 'C-1', sudoUid: OWNER, readRows: w.readRows, view: w.view, mainSha: w.M0, confirm: w.yes, onlyProduct: PRODUCT, ...over });
const asks = (w) => askStore(w.t.record).asks();

test('the go is recorded as an owner-command go, and the Dispatcher\'s own pass moves the card to ready', async () => {
  const w = world();
  const shownCard = w.t.record.read('card', 'C-1').doc;
  const r = await run(w);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(w.rowsAsked, [{ product: PRODUCT, card: 'C-1' }]);
  const go = askStore(w.t.record).go('go-C-1').doc;
  assert.equal(go.binding.kind, OWNER_COMMAND);
  assert.equal(go.binding.sudo_uid, OWNER);
  assert.equal(go.binding.card_json_sha256, sha(canonicalJson(shownCard)));
  assert.equal(go.plan_fingerprint, r.fingerprint);
  const [a] = asks(w);
  assert.equal(a.doc.state, 'consumed');
  assert.equal(a.doc.answer.channel, 'tap');
  assert.equal(a.doc.answer.binding.kind, OWNER_COMMAND);
  // What the owner read before retyping the id names every file, the pass test, and that this is not a tap (L1096).
  assert.equal(w.shown.length, 1);
  for (const f of FILES) assert.ok(w.shown[0].includes(f), f);
  assert.match(w.shown[0], /tests pass for R-1/);
  assert.match(w.shown[0], /owner command \(binding kind owner_command\), not as a phone tap/);
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'draft', 'the command moves no card');
  const ports = { startPlanReview: async () => ({ ok: false, reason: 'not here' }), planReviewAnswer: async () => ({ ok: false, reason: 'not here' }),
    planRows: async () => ROWS, planView: async () => w.view, mainSha: async () => w.M0, replyToLead: async () => ({ ok: true }) };
  must(await planGoPass(w.t.ctx, { ...ports, alert: outbox(w.t.record, w.t.clock.t) }));
  assert.equal(w.t.record.read('card', 'C-1').doc.state, 'ready');
});

test('refused, with nothing written: another product, no card, Tier 1, a pass test not yet its rows\', rows that can\'t be read', async () => {
  const cases = [
    [{}, { onlyProduct: undefined }, new RegExp(`${GO_CARD_PRODUCT} only`)],
    [{}, { cardId: 'C-2' }, /no card C-2; a Lead writes it first/],
    [{}, { cardId: '../x' }, /card id must be/],
    [{ card: { tier: 1 } }, {}, /Tier 1; this command gives a go on a Tier-2 card only/],
    [{ card: { done_when: 'the Lead\'s own words' } }, {}, /pass test is not yet its rows'/],
    [{}, { readRows: async () => { throw new Error('row R-1 is missing at main'); } }, /rows could not be read: row R-1 is missing/],
  ];
  for (const [opts, over, want] of cases) {
    const w = world(opts);
    const before = w.t.record.read('card', 'C-1');
    const r = await run(w, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.reason, want);
    assert.deepEqual(w.t.record.read('card', 'C-1'), before);
    assert.equal(asks(w).length, 0);
    assert.equal(w.shown.length, 0);
  }
});

test('not confirmed: no go, the card stays a draft and its ask open; a second run picks the ask up', async () => {
  const w = world();
  const r = await run(w, { confirm: () => ({ ok: false, reason: 'the id typed was not C-1; no go was given' }) });
  assert.match(r.reason, /no go was given/);
  assert.equal(askStore(w.t.record).go('go-C-1'), null);
  assert.deepEqual(asks(w).map((a) => a.doc.state), ['open']);
  const again = await run(w);
  assert.equal(again.ok, true, again.reason);
  assert.equal(asks(w).length, 1, 'the same ask, not a second one');
  assert.equal(askStore(w.t.record).go('go-C-1').doc.binding.kind, OWNER_COMMAND);
});

test('a card that is not a draft any more is refused', async () => {
  const w = world();
  assert.equal((await run(w)).ok, true);
  const ports = { startPlanReview: async () => ({ ok: false }), planReviewAnswer: async () => ({ ok: false }), planRows: async () => ROWS, planView: async () => w.view, mainSha: async () => w.M0, replyToLead: async () => ({ ok: true }) };
  must(await planGoPass(w.t.ctx, { ...ports, alert: outbox(w.t.record, w.t.clock.t) }));
  assert.match((await run(w)).reason, /C-1 is ready; a go is given on a draft card/);
});

test('M2 answerByOwnerCommand: only a live Tier-2 go of this product, with no risky class, counted by the same rule as a tap', () => {
  const w = world({ card: null });
  const fp = 'a'.repeat(64);
  const mk = (id, kind, over = {}) => must(createAsk(w.t.ctx, { id, kind, card: 'C-9', title: 'x', tier: kind === 'go_t1' ? 1 : 2, fingerprint: fp, files: ['src/a.mjs'], ...over }));
  const who = { sudoUid: OWNER, cardJsonSha256: 'b'.repeat(64) };
  mk('go-risky', 'go_t2', { risky: ['deletes'] });
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-risky', who).reason, /rules do not count this go: needs the GitHub channel/);
  mk('go-one', 'go_t1');
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-one', who).reason, /only a Tier-2 go/);
  mk('yes-no', 'tap_yes_no');
  assert.match(answerByOwnerCommand(w.t.ctx, 'yes-no', who).reason, /only a Tier-2 go/);
  mk('go-ok', 'go_t2');
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-ok', { ...who, sudoUid: 0 }).reason, /sudo_uid/);
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-ok', { ...who, cardJsonSha256: 'x' }).reason, /sha256/);
  assert.match(answerByOwnerCommand(w.t.ctx, 'nope', who).reason, /no trusted ask/);
  assert.deepEqual(asks(w).map((a) => a.doc.state), ['open', 'open', 'open', 'open'], 'the refusals wrote nothing');
  assert.equal(answerByOwnerCommand(w.t.ctx, 'go-ok', who).ok, true);
  assert.equal(askStore(w.t.record).ask('go-ok').doc.state, 'answered');
  assert.match(answerByOwnerCommand(w.t.ctx, 'go-ok', who).reason, /is answered, so it can't be answered/);
});

// ---- L1096 Q11: the retyped id comes from the terminal only ----

test('plant: no terminal (opening /dev/tty fails) is refused', () => {
  const r = ttyConfirm({ cardId: 'C-1', text: 'x', open: () => { throw Object.assign(new Error('Device not configured'), { code: 'ENXIO' }); } });
  assert.match(r.reason, /no terminal is attached/);
});

test('plant: a wrong id at the terminal is refused; the right one is taken (control)', () => {
  const dir = tempDir('orch-go-card-');
  let n = 0;
  // The prompt goes to `prompts`, so the typed line is read untouched, kept apart as a terminal keeps them.
  const prompts = [];
  const typeIn = (typed) => { const f = join(dir, `t${++n}`); writeFileSync(f, typed); return ttyConfirm({ cardId: 'C-1', text: 'x', open: () => openSync(f, 'r'), isTty: () => true, show: (_fd, s) => prompts.push(s) }); };
  assert.match(typeIn('C-2\n').reason, /the id typed was not C-1/);
  assert.match(typeIn('c-1\n').reason, /not C-1/);
  assert.match(typeIn('\n').reason, /not C-1/);
  assert.match(typeIn('').reason, /not C-1/);
  assert.match(typeIn(`${'C'.repeat(300)}\n`).reason, /far longer/);
  assert.equal(typeIn('C-1\n').ok, true);
  assert.equal(typeIn(' C-1 \r\n').ok, true);
  assert.match(prompts[0], /type the card id \(C-1\)/);
});

test('plant: a file that is not a terminal is refused even with the right id in it', () => {
  const f = join(tempDir('orch-go-card-'), 'answer');
  writeFileSync(f, 'C-1\n');
  assert.match(ttyConfirm({ cardId: 'C-1', text: 'x', open: () => openSync(f, 'r+') }).reason, /no terminal is attached/);
});

test('plant: stdin piped with the right id, in a process with no terminal (as a session\'s shell), is refused', async () => {
  const src = `import { ttyConfirm } from ${JSON.stringify(join(HERE, 'go-card.mjs'))}; process.stdout.write(JSON.stringify(ttyConfirm({ cardId: 'C-1', text: 'x' })));`;
  // detached: the child starts its own session, so it has no controlling terminal whatever ran this test.
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('C-1\nC-1\n');
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((ok) => child.on('close', ok));
  assert.equal(code, 0, err);
  const r = JSON.parse(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no terminal is attached/);
});

test('who may run it: the Dispatcher\'s user, started through sudo by the owner', () => {
  const ok = { uid: 300, sudoUid: String(OWNER), dispatcherUid: 300, ownerUid: OWNER };
  assert.equal(whoProblem(ok), null);
  assert.match(whoProblem({ ...ok, uid: OWNER }), /sudo -u orchestrate/);
  assert.match(whoProblem({ ...ok, uid: 0 }), /sudo -u orchestrate/);
  assert.match(whoProblem({ ...ok, sudoUid: undefined }), /not started through sudo/);
  assert.match(whoProblem({ ...ok, sudoUid: '502' }), /by user 502, not by the owner/);
  assert.match(whoProblem({ ...ok, sudoUid: '501x' }), /not started through sudo/);
  assert.match(whoProblem({ ...ok, dispatcherUid: undefined }), /could not be found/);
  assert.match(whoProblem({ ...ok, ownerUid: 300 }), /ownerUid/);
});

test('main: a wrong number of arguments, or a config that is not the installed copy\'s, refuses with one line', async () => {
  const lines = [];
  const confirm = () => { throw new Error('asked to confirm'); };
  assert.equal(await main([], { log: (s) => lines.push(s), confirm }), 1);
  assert.match(lines[0], /^go-card: usage: sudo -u orchestrate/);
  assert.equal(await main([join(tempDir('orch-go-card-'), 'nope.json'), 'C-1'], { log: (s) => lines.push(s), confirm }), 1);
  assert.match(lines[1], /^go-card: /);
  assert.doesNotMatch(lines[1], /asked to confirm/);
});

// L1096: anywhere a go is shown to the owner it shows binding.kind. Today no code shows one; these files read go records
// to check or record them. A new reader fails here, so whoever adds it decides whether it shows a go to the owner, and
// if so shows binding.kind (an owner-command go is never presented as a phone tap).
test('L1096: the readers of go records are the known checkers (a new one must show binding.kind if it shows a go)', () => {
  const READERS = ['modules/M11-dispatcher/plan-go.mjs', 'modules/M2-approvals/ask-store.mjs', 'modules/M2-approvals/go.mjs', 'modules/M6-merge-gate/gather.mjs', 'modules/M9-record/ready.mjs'];
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.mjs$/.test(n) || /\.test(-helper)?\.mjs$/.test(n)) continue;
      if (/(read|list)\('go'|\.go\(|\.gos\(\)/.test(readFileSync(p, 'utf8'))) found.push(relative(ROOT, p).split(sep).join('/'));
    }
  };
  walk(ROOT);
  assert.deepEqual(found.sort(), READERS);
});
