// day-one.test.mjs — the first cutover's first day, across the modules, on real code (lead calls L96, L97, L129, L151).
// Run: node --test orchestrate/test/day-one.test.mjs
//
// WHAT. One generic rules file shaped like a first-cutover entry (the fixture M10's own first-cutover test uses, from
// its one home, M10-rules/first-cutover.test-helper.mjs; no product names) goes through the real parsePolicy and the
// real engine (M10 from-text.mjs), into a real Record (M9 openRecord), M9's ready rule, M11's start gate for every
// kind, M11's undo step and undo starts, and M6's checks step (the real gatherFacts, then judge). Every kind the first
// cutover uses must start. "Undo-only" (only an exact reverse may merge or start) is a failure, not a pass.
// It is the cross-module test the stand-ins rule asks for (Principle 10): the fakes are only GitHub (M6's
// fake-gate-github.mjs), the Mac's launcher port and the Mac's usage reading (M11's usageFact), and the mirror's file
// list (M11's filesOfCommits). Earlier days' documents (a merge the gate made, Joe's answered Undo tap) are put in the
// store with M9's seed helper, as the starting state; everything this test is about is written by production code.
//
// THE KINDS THE FIRST CUTOVER USES. The first cutover is the smaller one: the research and docs lane goes on the Merge
// Gate, and code stays manual. Derived from the fixture and the modules, each checked by the test 'the kinds list':
//   Session kinds (M11 gate.mjs startGate; callers M11 merges.mjs, pass.mjs, tick.mjs and M4 review-launch.mjs):
//     review      USED. merges.mjs asks startGate(kind 'review') before it asks for a reviewer; M6 refusal 5 needs a
//                 reviewer's verdict on every change but an exact reverse (refusals.mjs).
//     merge       USED. merges.mjs asks startGate(kind 'merge') before each merge request; the docs lane merges
//                 through the gate (M6 README "First cutover: docs lane only").
//     undo        USED. pass.mjs starts an exact_reverse card as kind 'undo'; the fixture's go_free names
//                 exact_reverse (M6 required-keys.mjs needs it); M6 README: an undo of a gate merge merges at the first
//                 cutover.
//     undo_merge  USED. merges.mjs asks startGate(kind 'undo_merge') for an exact_reverse card's merge request.
//     editing, overnight  NOT USED: code stays manual. The fixture's caps.editing_per_product is 0, which the fit
//                 check demands (first-cutover.mjs).
//     script      NOT USED: roles_enabled.script is none, which the fit check demands.
//     audit       NOT USED: an auditor is asked only for a Tier-1 card (M4 review-runner.mjs needsRole), and the docs
//                 lane takes only declared Tier 2 (M10 lane-check.mjs).
//     readonly, lead  NOT USED: the Lead is not on the product at the first cutover (go_free.lead_daily_card is [],
//                 L96 m-1).
//     front_door  NOT ASKED: no production code asks startGate for it, though Joe's Undo tap itself comes from a
//                 Front Door session (M2 undo-flag.mjs), which this test seeds as already answered.
//   Card kinds (shared/record-names.mjs CARD_KINDS, M9 permissions.mjs CARD_CREATORS):
//     exact_reverse   USED: made by the Dispatcher from Joe's Undo tap (M11 undo.mjs), go-free.
//     ordinary        USED as the docs change the gate merged (made by Joe's tab or the Lead; its making is not
//                     this path, so it is seeded).
//     research_copy   go-free in the first-cutover rules (L514). M11 researchHandler makes the card and it goes ready
//                     with no go (test below). Nothing calls that path yet (R-0b-162), so the docs change the gate
//                     merges and the Undo reverses here is an ordinary seeded card (day-one audit M-2).
//     fix, lead_daily_card  NOT USED: the Lead plans a fix card and makes the daily card; the Lead is not on the
//                     product.
//   Product state: active (the fixture's product_state_rules.active.start is within_caps). paused is "no starts" by
//   design, and is what the engine reads when the product has no document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST, ENTRY, PENDING, swap } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';
import { rulesFromText } from '../modules/M10-rules/from-text.mjs';
import { firstCutoverProblems } from '../modules/M10-rules/first-cutover.mjs';
import { makeGitView } from '../modules/M10-rules/git-view.mjs';
import { readyCheck, goFreeKinds } from '../modules/M9-record/ready.mjs';
import { createHash } from 'node:crypto';
import { checkOutboxFile, outboxFile } from '../modules/M1-front-door/outbox.mjs';
import { openResearchAsks } from '../modules/M2-approvals/research-ask.mjs';
import { researchHandler, RESEARCH_CARD, RESEARCH_OFF } from '../modules/M11-dispatcher/research-intake.mjs';
import { outboxFile as m9file } from '../modules/M9-record/fixtures.test-helper.mjs';
import { blobSha } from '../modules/M10-rules/reader.mjs';
import { cleanOutside } from '../modules/M12-sensors/escape.mjs';
import { CARD_CREATORS } from '../modules/M9-record/permissions.mjs';
import { setup, seed, product as writeProduct, PRODUCT } from '../modules/M9-record/fixtures.test-helper.mjs';
import { moduleSources, scanSources, stripComments } from '../modules/M9-record/write-sites.test-helper.mjs';
import { WRITERS } from '../modules/M9-record/permissions.mjs';
import { startGate, riskOf } from '../modules/M11-dispatcher/gate.mjs';
import { bands, readFact } from '../modules/M11-dispatcher/usage.mjs';
import { undoStep, UNDO_CARD, exactReverse } from '../modules/M11-dispatcher/undo.mjs';
import { tick } from '../modules/M11-dispatcher/tick.mjs';
import { intakeFactId, sourceOf } from '../modules/M11-dispatcher/proposals-intake.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { undoStarts } from '../modules/M11-dispatcher/pass.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { usageFact, undoEntries, undoSha, filesOfCommits, UNDO_ASK, T0 } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { rolesFor } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { gatherFacts } from '../modules/M6-merge-gate/gather.mjs';
import { judge } from '../modules/M6-merge-gate/refusals.mjs';
import { fakeGateGitHub } from '../modules/M6-merge-gate/fixtures/fake-gate-github.mjs';
import { OUTBOX_KINDS, CARD_KINDS } from '../shared/record-names.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { pushWorld } from '../modules/M4-workshop/git/push-world.test-helper.mjs';
import { gitOk } from '../modules/M4-workshop/git/safe-git.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { LAST_PASS_FACT, STEP_ERROR_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { blobOf } from '../wiring/fake-github.test-helper.mjs';
import { installedLayout } from '../shared/job-config.test-helper.mjs';
import { reviewConfig } from '../wiring/review-ports.test-helper.mjs';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = PRODUCT;
const DOC = 'docs/research/note.md';
const START_KINDS = Object.freeze(['editing', 'undo', 'overnight', 'script', 'readonly', 'review', 'audit', 'merge', 'undo_merge', 'lead', 'front_door']);
const USED = Object.freeze(['review', 'merge', 'undo', 'undo_merge']);

// ---- the world: the fixture's text, the real engine, a real Record ----

// The engine reads the product's state from the Record's product document (engine.mjs productState: "the product
// record's doc"), so a Record with no product document reads paused, as it would on the Mac.
function dayOne({ text = FIRST, withProduct = true } = {}) {
  let env = null;
  const rules = rulesFromText({ [P]: text }, { productState: (p) => env?.record.read('product', p)?.doc ?? null, clock: () => env?.clock.t ?? T0 });
  env = setup({ prefix: 'orch-day-one-', extra: { rules } });
  env.clock.t = T0;
  // The product document: M2 onboard.mjs writes it (L204-b) through the approvals port, which the Dispatcher wiring
  // answers (L270); the boot test below proves that on the Mac's own path (L292). With withProduct it is written here
  // through the real Record, as approvals would, so the other tests need no boot.
  // productState is wired here by the test: no production code builds the engine yet, and rulesFromText's own default
  // reads every product as active, so "paused with no document" is this wiring's answer, not yet the Mac's.
  if (withProduct) writeProduct(env, 'active');
  return { env, rules, rec: env.record, alerts: outbox(env.record, T0) };
}

// The Mac's usage reading, green, read by M11's own reader and turned into bands by M11's own code.
function green(rules) {
  const staleMs = rules.num('usage.stale_after_min') * 60_000;
  return bands({ rules, reading: readFact({ doc: usageFact({ week: 10, h5: 10, now: T0 }) }, { account: 'acct-a', now: T0, staleMs }), now: T0 });
}

// The day so far: a docs change the gate merged earlier, and Joe's answered Undo tap on it (M11's undo fixtures,
// taken up to the tap; the undo card itself is made below by the real undo step, never seeded).
// The day-one engine answers the push; the push world's values reach it as the rules reader gives them, as text.
function pushRules(w, world) {
  return fakeRules({ answers: { push_branch: (x) => w.rules.may('push_branch', x) }, values: world.values });
}

const UNDO_ID = 'U1';
function undoTapped(w) {
  const entries = undoEntries(UNDO_ID, {}, { product: P, files: [DOC], pr: 7 });
  const before = entries.slice(0, 3);
  assert.deepEqual(before.map(([e]) => e), ['card', 'merge', 'ask'], 'the undo fixture changed shape');
  for (const [entity, id, doc] of before) seed(w.env, entity, id, doc);
  return UNDO_CARD(UNDO_ASK(UNDO_ID));
}

const view = (rec) => ({ get: (e, id) => rec.read(e, id), list: (e) => rec.list(e), createdBy: (e, id) => rec.meta?.(e, id)?.createdBy ?? null });
const cardOf = (rec, id) => { const c = rec.read('card', id); return c ? { id: c.id, ...c.doc } : null; };
const docsChange = (status = 'modified') => [{ path: DOC, status }];

// ---- the rules file ----

test('the fixture goes through the real parsePolicy and is a fit first-cutover entry', () => {
  const r = parsePolicy(FIRST);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(firstCutoverProblems(FIRST, ENTRY).filter((x) => !PENDING.includes(x)), []);
  // No product names: the entry is the generic sample's.
  assert.equal(ENTRY.product, P);
  assert.equal(P, 'sample-app');
});

test('the kinds list at the top is what the fixture and the modules say', () => {
  const { rules } = dayOne();
  // editing and overnight: no editing starts.
  assert.equal(rules.num('caps.editing_per_product', { product: P }), 0);
  // script: off.
  assert.equal(rules.get('roles_enabled.script', { product: P }), 'none');
  // Undo cards and research copies are go-free; nothing else is (the Lead's daily card has no files).
  assert.deepEqual(goFreeKinds(rules, P), ['exact_reverse', 'research_copy']);
  assert.deepEqual(rules.get('approvals.plan_go.go_free.lead_daily_card', { product: P }), []);
  assert.ok(CARD_CREATORS.dispatcher.includes('exact_reverse'));
  assert.ok(CARD_KINDS.includes('research_copy') && CARD_KINDS.includes('exact_reverse'));
  // audit: a Tier-2 card in review needs a reviewer only; only Tier 1 needs an auditor.
  assert.deepEqual(rolesFor({ state: 'in_review', tier: 2 }), ['reviewer']);
  assert.deepEqual(rolesFor({ state: 'in_review', tier: 1 }), ['reviewer', 'auditor']);
  // The product state that lets work start.
  assert.equal(rules.get('product_state_rules.active.start', { product: P }), 'within_caps');
  assert.equal(rules.get('product_state_rules.paused.start', { product: P }), 'none');
  assert.equal(rules.get('product.cutover_stage', { product: P }), 'first');
});

// ---- required_checks is policy (L96 m-1) ----

test('required_checks: the fixture names checks, and an empty list is refused by the fit check', () => {
  const { rules } = dayOne();
  const named = rules.get('product_profile.required_checks', { product: P });
  assert.ok(Array.isArray(named) && named.length > 0, 'the fixture names at least one required check');
  const empty = swap(FIRST, 'required_checks: [build, test]', 'required_checks: []');
  assert.ok(parsePolicy(empty).ok, 'the reader itself takes an empty list; the refusal is policy');
  assert.ok(firstCutoverProblems(empty, ENTRY).includes('product_profile.required_checks must name at least one check (policy)'));
});

// ---- the product's state, the ready rule and every start ----

test('the docs lane merges an ordinary docs change on day one (not undo-only)', () => {
  const { rules } = dayOne();
  const r = rules.may('merge', { product: P, card: { id: 'C-2', kind: 'ordinary', tier: 2 }, truncated: false, labels: [], declared_tier: 2, kind: 'ordinary', files: docsChange() });
  assert.equal(r.decision, 'allow', r.reason);
});

// M11's start gate, asked as its callers ask it (merges.mjs for review, merge and undo_merge; pass.mjs for undo, editing,
// overnight and script; tick.mjs for readonly), on a Record where the real undo step has made the undo card.
async function gateAnswers() {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  const undo = cardOf(w.rec, id);
  assert.ok(undo, 'the undo step made the undo card');
  const docs = { id: 'C-2', kind: 'ordinary', product: P, tier: 2, files: [DOC] };
  const b = green(w.rules);
  // pass.mjs asks undo.mjs's exactReverse before the gate; so does this (#117 audit c3).
  const exact = exactReverse({ rec: w.rec, card: undo, filesOf: filesOfCommits });
  assert.equal(exact.ok, true, `the undo card is not an exact reverse: ${exact.reason}`);
  const answers = {};
  for (const kind of START_KINDS) {
    const card = kind === 'undo' || kind === 'undo_merge' ? undo : kind === 'readonly' ? null : docs;
    answers[kind] = startGate({ rules: w.rules, rec: w.rec, card, kind, product: P, b, running: [], lead: kind === 'readonly' ? 'L-1' : undefined, exactReverse: kind === 'undo' && exact.ok });
  }
  return answers;
}

test('M11\'s start gate: no kind is held for a rules value the fixture lacks, and code stays manual', async () => {
  const answers = await gateAnswers();
  for (const kind of START_KINDS) assert.equal(answers[kind].missing, undefined, `${kind}: the rules have no value for ${answers[kind].missing}`);
  // Code stays manual: no editing or overnight start, for the designed reason.
  for (const k of ['editing', 'overnight']) { assert.equal(answers[k].ok, false, k); assert.match(answers[k].reason ?? '', /cap 0/, k); }
  // Undo-only is a failure: something other than an undo starts.
  assert.ok(['review', 'merge'].some((k) => answers[k].ok === true), 'only undos start (undo-only)');
});

// The known day-one gaps (L199, L204), each a to-do that the PR fixing it switches off.
for (const kind of USED) {
  test(`M11's start gate allows a start of kind ${kind} on day one`, async () => {
    const a = (await gateAnswers())[kind];
    assert.equal(a.ok, true, `the start gate refuses ${kind}: ${a.reason}`);
  });
}

test('M10\'s start question: a worker for an undo card may start on day one', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  // pass.mjs asks start_session with editing: true for an undo card too (its worker edits files), and the tier
  // M11's riskOf gives the card the real undo step made (day-one audit Minor 1: never a handed-in tier). The card goes
  // with it, as pass.mjs sends it: the engine knows an undo by the card's kind.
  const card = cardOf(w.rec, id);
  const tier = riskOf(w.rules, card).tier;
  const r = w.rules.may('start_session', { product: P, card, role: 'worker', tier, editing: true });
  assert.equal(r.decision, 'allow', `the engine refuses the undo worker: ${r.reason}`);
});

test('Joe\'s Undo on day one: the real undo step makes a ready card, and the Record\'s ready rule takes it', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  const out = await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  assert.deepEqual(out, [[UNDO_ASK(UNDO_ID), 'undo card written']]);
  const card = w.rec.read('card', id);
  assert.equal(card.doc.state, 'ready');
  assert.equal(card.doc.kind, 'exact_reverse');
  // The Record's own ready rule (it ran on the move to ready) and M9's readyCheck, on the real rules.
  assert.deepEqual(readyCheck(card, view(w.rec), { rules: w.rules, product: P }), { ok: true });
  assert.ok(w.rec.ready().some((c) => c.id === id), 'the Record lists the undo card as ready');
});

test('Joe\'s Undo on day one: M11\'s real undo start starts the undo card', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  // The Mac's launcher (a port): it answers yes, in the shape M11's own tests use.
  const launched = [];
  const r = await undoStarts({ rec: w.rec, rules: w.rules, now: T0, bands: green(w.rules), running: [], filesOf: filesOfCommits, alert: w.alerts, host: 'mac-a',
    launch: async (x) => { launched.push(x.card.id); return { ok: true, sessionId: x.sessionId, outbox: `/outbox-root/worker/${x.sessionId}`, pid: 1001, pidStart: 'start', pgid: 101, head: undoSha(UNDO_ID) }; } });
  assert.deepEqual(r.refused, [], 'the undo card is refused a start');
  assert.deepEqual(r.started, [id]);
  assert.deepEqual(launched, [id]);
  assert.equal(w.rec.read('card', id).doc.state, 'running');
});

// L595: a paused product's undo, through one real tick: the real rules text, the real Record, M11's real steps. Only the
// ports are stand-ins. The rules draft's paused state is start: none, which is what stopped this card at M9 alone.
const pause = (w) => { const r = w.rec.write({ actor: 'approvals', entity: 'product', id: P, expectRev: w.rec.read('product', P).rev, doc: { state: 'paused', return_to: 'active' } }); assert.equal(r.ok, true, r.reason); };
async function oneTick(w, { sessions = [], proposals = { products: [], ownerUid: 501 }, now = T0 } = {}) {
  const dir = tempDir('orch-day-one-tick-');
  const launched = [];
  const stops = [];
  const alert = fakeAlert();
  const ports = {
    alert, board: () => [], healthy: () => true, resume: () => false, proposals: () => proposals, outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [], sessions: () => [...sessions], probe: () => ({ size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } }),
    launch: async ({ card, kind, product, sessionId }) => { launched.push(card.id); sessions.push({ id: sessionId, product, kind, card: card.id, pgid: 101 }); return { ok: true, sessionId, outbox: `/outbox-root/worker/${sessionId}`, pid: 1001, pidStart: 'start', pgid: 101, head: undoSha(UNDO_ID) }; },
    stopGroup: async (x) => { stops.push(x); return { ok: true }; }, saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, requestReview: () => ({ ok: true, requestId: 'Q-1' }), filesOf: filesOfCommits,
    sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }), frontDoorAlive: () => null, frontDoorHandoff: () => null,
    cleanup: { copiesRoot: dir, sealRoot: dir, mirrorFor: () => null }, approvals: () => [],
  };
  w.env.clock.t = now;
  const r = await tick({ rec: w.rec, rules: w.rules, now, ports });
  return { launched, alert, sessions, stops, r };
}

test('L595: the Undo tapped on a paused product starts in the next tick', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  pause(w);
  const { launched, alert } = await oneTick(w);
  assert.deepEqual(launched, [id]);
  assert.equal(w.rec.read('card', id).doc.state, 'running');
  assert.deepEqual(alert.texts.filter((t) => /can't start|is waiting/.test(t)), []);
});

// #252 r1 m3: this PR first lets an undo run on a paused product, so the next tick must leave it running.
test('L595: a running undo on a paused product is not stopped or parked by the next tick', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  pause(w);
  const first = await oneTick(w);
  assert.deepEqual(first.launched, [id]);
  const second = await oneTick(w, { sessions: first.sessions });
  assert.deepEqual(second.launched, []);
  assert.deepEqual(second.stops, []);
  // A stop is first only wanted (a pending stop fact) until the session reaches a safe point: none may be wanted.
  const wanted = w.rec.list('fact').filter((f) => f.doc?.state === 'pending' && f.doc?.card === id);
  assert.deepEqual(wanted.map((f) => f.id), []);
  assert.equal(w.rec.read('card', id).doc.state, 'running');
});

test('L595: an undo card already in ready when the product is paused stays on the list and starts', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  pause(w);
  assert.deepEqual(w.rec.ready().map((c) => c.id), [id], 'off this list, no check ever sees the card, so no alert either');
  const { launched } = await oneTick(w);
  assert.deepEqual(launched, [id]);
  assert.equal(w.rec.read('card', id).doc.state, 'running');
});

test('L595: on a paused product an ordinary ready card does not start beside the undo', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  const d = { state: 'ready', kind: 'ordinary', product: P, module: 'M-test', tier: 2, round: 1, files: [DOC], done_when: 'x', what: 'y' };
  seed(w.env, 'card', 'C-3', d);
  pause(w);
  const { launched } = await oneTick(w);
  assert.deepEqual(launched, [id]);
  assert.equal(w.rec.read('card', 'C-3').doc.state, 'ready');
});

// The merge question below is built by hand (exact_reverse_ok, reversed_audit and the missing reverses_files are
// gather.mjs's to work out from GitHub). The same card through M6's real gatherFacts, asserting on f.lane, is
// modules/M11-dispatcher/undo-lane.test.mjs (L199-D; day-one audit Minor 2).
test('the undo card the real undo step makes can pass the first-cutover docs lane (declared Tier 2)', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  const card = cardOf(w.rec, id);
  // What M6 gather.mjs asks M10 for an undo card's pull request (declared_tier is the card's own tier).
  const r = w.rules.may('merge', { product: P, card, truncated: false, labels: [], declared_tier: card.tier, kind: 'exact_reverse',
    reverses: undoSha(UNDO_ID), exact_reverse_ok: true, reversed_audit: 'none', files: docsChange() });
  assert.equal(r.decision, 'allow', `the docs lane refuses the undo: ${r.reason}`);
});

// The Mac's own first boot (L292): `node main.mjs <config>` as the login job runs it, through the real Dispatcher wiring,
// a real Record on disk, the real rules reader, engine and lock. The only stand-in is GitHub (wiring/fake-github.test-helper.mjs,
// put in with `node --import`), answering the rules file at the version Joe approved. Nothing writes the product
// document but that boot: the approvals step reads the rules' onboarding.state and M2 onboard.mjs writes it as approvals.
const ROOT_ORCH = ORCH;
function macBoot() {
  // An installed copy of this checkout (L253): main.mjs takes only a config and wiring inside the copy it runs from.
  const L = installedLayout('orch-day-one-boot-', { source: true });
  const dir = L.base;
  const f = (n) => join(dir, n);
  writeFileSync(f('products.json'), JSON.stringify([ENTRY]));
  const rulesStateDir = f('rules-state');
  mkdirSync(rulesStateDir, { mode: 0o700 });
  writeFileSync(join(rulesStateDir, 'approved-rules.json'), JSON.stringify({ [ENTRY.product]: [blobOf(FIRST)] }));
  const token = f('token');
  writeFileSync(token, 'x'.repeat(40), { mode: 0o600 });
  chmodSync(token, 0o600);
  const config = { installRoot: L.installRoot, wiring: L.path('wiring/dispatcher-wiring.mjs'), lockFile: f('dispatcher.lock'), product: ENTRY.product,
    recordRoot: f('record'), ownerUid: process.getuid(), productsFile: f('products.json'), rulesStateDir, tokenFile: token,
    approvalsStateDir: f('approvals-state'), ...reviewConfig(dir, { reviewUid: process.getuid() + 1 }) };
  const configFile = L.write('dispatcher.json', config);
  writeFileSync(f('fake-github.json'), JSON.stringify({ owner: ENTRY.owner, repo: ENTRY.repo, commit: 'a'.repeat(40), text: FIRST, logFile: f('github.log') }));
  const r = spawnSync(process.execPath, ['--import', join(ROOT_ORCH, 'wiring/fake-github.test-helper.mjs'), L.path('modules/M11-dispatcher/main.mjs'), configFile], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ORCH_FAKE_GITHUB: f('fake-github.json') }, encoding: 'utf8', timeout: 60_000 });
  const rec = openRecord({ root: config.recordRoot, product: ENTRY.product, ownerUid: process.getuid(), rules: fakeRules() }).record;
  return { code: r.status, err: r.stderr, rec };
}

test('with only production writers, the product reads active and the docs lane is not undo-only (L292: the Mac\'s own boot)', () => {
  const { code, err, rec } = macBoot();
  assert.equal(code, 0, err);
  const p = ENTRY.product;
  // The review user is another user (the Dispatcher's own may not be it, L674), so this boot's status is not theirs and
  // the limits step says exactly that (L674 re-rules L652 for this boot).
  assert.equal(rec.read('fact', LAST_PASS_FACT)?.doc?.steps?.limits, 'failed');
  assert.equal(rec.read('fact', STEP_ERROR_FACT('limits'))?.doc?.error, "no review was asked for: the review runner's folder is not owned by the review user");
  // The product document exists, and only the boot wrote it: approvals, kind onboard, once.
  assert.equal(rec.read('product', p)?.doc?.state, 'active', 'the boot turned the product on');
  assert.deepEqual(rec.diary({ since: 0 }).filter((l) => l.entity === 'product' && l.id === p).map((l) => [l.actor, l.kind]), [['approvals', 'onboard']]);
  assert.equal((rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => e.text.includes(`${p} is now on`)).length, 1, 'Joe is told the product is on, once');
  // The engine reads that document as the product's state: the docs lane merges an ordinary docs change, not undo-only.
  const rules = rulesFromText({ [p]: FIRST }, { productState: (q) => rec.read('product', q)?.doc ?? null, clock: () => T0 });
  const merge = rules.may('merge', { product: p, card: { id: 'C-2', kind: 'ordinary', tier: 2 }, truncated: false, labels: [], declared_tier: 2, kind: 'ordinary', files: docsChange() });
  assert.equal(merge.decision, 'allow', merge.reason);
  // And the start gate finds the product record the boot made (it refused "no product record" without it).
  const start = startGate({ rules, rec, card: { id: 'C-9', kind: 'exact_reverse', product: p, tier: 2, files: [DOC] }, kind: 'undo', product: p, b: green(rules), running: [], exactReverse: true });
  assert.equal(start.ok, true, start.reason);
});

test('with no product document today, the gaps are exactly the known ones (paused, undo-only, no product record)', () => {
  const w = dayOne({ withProduct: false });
  const merge = w.rules.may('merge', { product: P, card: { id: 'C-2', kind: 'ordinary', tier: 2 }, truncated: false, labels: [], declared_tier: 2, kind: 'ordinary', files: docsChange() });
  assert.equal(merge.decision, 'deny');
  assert.match(merge.reason, /product is paused: only an exact reverse may merge/);
  const start = startGate({ rules: w.rules, rec: w.rec, card: { id: 'C-9', kind: 'exact_reverse', product: P, tier: 2, files: [DOC] }, kind: 'undo', product: P, b: green(w.rules), running: [], exactReverse: true });
  assert.equal(start.ok, false);
  assert.match(start.reason, /no product record/);
});

// L303 (#154 audit Minors 4 and 5): two silences the research path could leave, closed by its wiring (R-0b-162, A4).
// Through real ticks: the real rules text with a real proposals folder, the real Record, the real proposals intake
// handing the report to the real research handler, and the tick's research step. Only the ports are stand-ins.
const DAY = 24 * 60 * 60_000;
function researchWorld() {
  const dir = tempDir('orch-day-one-proposals-');
  const w = dayOne({ text: swap(FIRST, 'outbox: /srv/sample-app/proposals', `outbox: ${dir}`) });
  return { w, dir, proposals: { products: [P], ownerUid: process.getuid() } };
}
const notReady = (alert) => alert.texts.filter((t) => /the report for research ask R-1 was taken in, but its card research-R-1 could not go to ready/.test(t));

test('a research report whose card can\'t go ready or land is told to Joe, every time', async () => {
  const { w, dir, proposals } = researchWorld();
  askOpened(w);
  writeFileSync(join(dir, 'research-R-1.md'), REPORT);
  pause(w);
  const one = await oneTick(w, { proposals });
  assert.equal(one.r.steps.proposals.ok, true, one.r.steps.proposals.error);
  assert.equal(one.r.steps.research.ok, true, one.r.steps.research.error);
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.state, 'draft', 'a paused product keeps the card in draft');
  assert.ok(w.rec.read('ask', 'R-1').doc.landed, 'the ask was marked answered');
  assert.equal(notReady(one.alert).length, 1, `told in the tick that took the report in: ${one.alert.texts.join(' | ')}`);
  // Told once a day while it lasts, by the research step, never in silence.
  const two = await oneTick(w, { proposals, now: T0 + 60_000 });
  assert.equal(notReady(two.alert).length, 0, 'not again the same day');
  assert.deepEqual(two.r.steps.research.result.map(([, x]) => x.replace(/:.*/, '')), ['not ready'], 'the research step tried again');
  const three = await oneTick(w, { proposals, now: T0 + DAY + 60_000 });
  assert.equal(notReady(three.alert).length, 1, 'told again the next day');
  // Once the product is active, the card goes ready and nothing more is told.
  const active = w.rec.read('product', P);
  assert.equal(w.rec.write({ actor: 'approvals', entity: 'product', id: P, expectRev: active.rev, doc: { state: 'active' } }).ok, true);
  const four = await oneTick(w, { proposals, now: T0 + DAY + 120_000 });
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.state, 'ready');
  assert.equal(notReady(four.alert).length, 0);
});

test('a research report sent again after an interrupted intake is told, never stuck in silence', async () => {
  const { w, dir, proposals } = researchWorld();
  // A pass took the report in and stopped after the handler made the card: its claim is left behind.
  assert.equal(reportArrives(w).ok, true);
  const name = 'research-R-1.md';
  const first = createHash('sha256').update(REPORT).digest('hex');
  // Written as the intake writes its claim: the Dispatcher's own fact, so the next pass may record the interruption.
  const claim = w.rec.write({ actor: 'dispatcher', entity: 'fact', id: intakeFactId(P, name), expectRev: 0, kind: 'proposal_claim', doc: { session: sourceOf(P), product: P, name, sha256: first, state: 'applying', at: new Date(T0).toISOString() } });
  assert.equal(claim.ok, true, claim.reason);
  // The owner sends the report again, changed.
  writeFileSync(join(dir, name), `${REPORT}\nOne more line.\n`);
  const all = [];
  for (const [i, now] of [T0, T0 + 60_000, T0 + 120_000].entries()) {
    const t = await oneTick(w, { proposals, now });
    assert.equal(t.r.steps.proposals.ok, true, `tick ${i}: ${t.r.steps.proposals.error}`);
    all.push(...t.alert.texts);
  }
  assert.equal(all.filter((t) => /research-R-1\.md(<\/outside-text>)? from .*proposals folder was interrupted/.test(t)).length, 1, all.join(' | '));
  const resent = all.filter((t) => /research-R-1\.md(<\/outside-text>)? in .*proposals folder was refused: research ask R-1 already has its research_copy card/.test(t));
  assert.equal(resent.length, 1, `told once: ${all.join(' | ')}`);
  assert.match(resent[0], /made from the report first taken in \(version [0-9a-f]{12}\), so this one was not used\. To have the first one copied, put it back unchanged; to have this one copied, ask again with a new research ask/);
  assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')).doc.source.sha256, first, 'the card keeps the first bytes');
});

// The real path to a research copy: an ask from the front door, then the report for it.
const REPORT = '# One thing\n\nIt was found out.\n';
function askOpened(w) {
  const now = w.env.clock.t;
  const f = outboxFile('ask-request', '20261103-0915-rb', { ask: 'research', product: P, brief: 'find out one thing' });
  assert.equal(checkOutboxFile(f.name, f.text, { products: [P], seenIds: [] }).ok, true);
  const asked = w.rec.applyOutbox({ role: 'front_door', sessionId: 'F-1' }, m9file(w.env, 'front_door', 'F-1', f.name, f.text));
  assert.equal(asked.ok, true, asked.reason);
  assert.equal(openResearchAsks({ record: w.rec, rules: w.rules, product: P, now: () => now, alert: fakeAlert() }).opened.length, 1);
}
function reportArrives(w) {
  const now = w.env.clock.t;
  askOpened(w);
  return researchHandler({ rules: w.rules, alert: fakeAlert() })({ rec: w.rec, product: P, kind: 'research', id: 'R-1', name: 'research-R-1.md', source: 'research-file', fenced: cleanOutside(REPORT, 'research-file'),
    sha256: createHash('sha256').update(REPORT).digest('hex'), blob: blobSha(Buffer.from(REPORT)), size: Buffer.byteLength(REPORT), now });
}

test('a research_copy card is ready on day one with no go', () => {
  const w = dayOne();
  const made = reportArrives(w);
  assert.equal(made.ok, true, made.reason);
  const card = w.rec.read('card', RESEARCH_CARD('R-1'));
  assert.equal(card.doc.state, 'ready');
  assert.ok(w.rec.ready().some((c) => c.id === card.id), 'the Record lists it as ready, and no go was ever asked for');
});

for (const [name, off] of [['left out of', ''], ['false in', '      research_copy: false\n']]) {
  test(`research copies ${name} the first-cutover rules fail closed: no card, and the kind is not go-free`, () => {
    const w = dayOne({ text: swap(FIRST, '      research_copy: true\n', off) });
    assert.deepEqual(goFreeKinds(w.rules, P), ['exact_reverse']);
    assert.deepEqual(reportArrives(w), { ok: false, reason: RESEARCH_OFF });
    assert.equal(w.rec.read('card', RESEARCH_CARD('R-1')), null);
  });
}

// ---- M6's checks step: the real gatherFacts over fake GitHub, then judge ----

async function checksStep(text, runs) {
  const w = dayOne({ text });
  const g = fakeGateGitHub();
  const root = g.commit([], { [DOC]: 'one' });
  g.main = root;
  const head = g.commit([root], { [DOC]: 'two' }, { from: root });
  g.openPull({ number: 7, head, files: { [DOC]: 'two' } });
  g.checks.set(head, runs(head));
  seed(w.env, 'card', 'C-2', { state: 'verified', kind: 'ordinary', product: P, module: 'M-test', tier: 2, files: [DOC], head });
  const ctx = { record: w.env.review, rules: w.rules, product: P, gh: g.gh, owner: 'sample-org', repo: 'sample-app', view: makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' }),
    now: () => w.env.clock.t, alert: fakeAlert(), reviewLaunches: { root: w.env.launchRoot, uids: w.env.reviewUids, outbox: w.env.outRoot } };
  const f = await gatherFacts(ctx, { id: 'M-2', doc: { card: 'C-2', pr: 7, state: 'checking' } });
  return { f, j: judge(f) };
}
const run = (head, name, conclusion = 'success') => ({ name, app: { id: 1 }, head_sha: head, status: 'completed', conclusion });
const refusal1 = ({ j }) => j.refusals.filter((x) => x.n === 1);

test('M6\'s checks step reads the required checks from the real rules: green passes, a red required check refuses', async () => {
  const ok = await checksStep(FIRST, (h) => [run(h, 'build'), run(h, 'test')]);
  assert.deepEqual(ok.f.requiredChecks, ['build', 'test']);
  assert.deepEqual(refusal1(ok), []);
  const red = await checksStep(FIRST, (h) => [run(h, 'build', 'failure'), run(h, 'test')]);
  assert.deepEqual(refusal1(red).map((x) => [x.reason, x.temporary]), [['required check build is not green', undefined]]);
  const missing = await checksStep(FIRST, (h) => [run(h, 'test')]);
  assert.deepEqual(refusal1(missing).map((x) => x.reason), ['required check build has not run']);
});

test('M6\'s checks step refuses a change when the rules name no required checks', async () => {
  const empty = await checksStep(swap(FIRST, 'required_checks: [build, test]', 'required_checks: []'), (h) => [run(h, 'build'), run(h, 'test')]);
  assert.equal(empty.f.requiredChecks, null, 'an empty list is no list');
  assert.equal(empty.f.main.green, null, 'main is not green on a list that names no check');
  assert.notDeepEqual(refusal1(empty), []);
});

// ---- L97 / L129: every Record document production reads, production writes ----

// Every entity a production file reads by name (read, list, get, meta, createdBy with a literal entity). All
// production sources, a superset of the first-cutover path, so a new read with no writer anywhere fails here.
const ENTITIES = Object.keys(WRITERS);
const READ = new RegExp(`\\.(?:read|list|get|meta|createdBy)\\??\\.?\\(\\s*'(${ENTITIES.join('|')})'`, 'g');
function readsAndWriters() {
  const files = moduleSources(ORCH);
  const reads = new Map();
  for (const { file, src } of files) {
    for (const m of stripComments(src).matchAll(READ)) {
      if (!reads.has(m[1])) reads.set(m[1], new Set());
      reads.get(m[1]).add(file);
    }
  }
  const { sites, problems } = scanSources(files);
  assert.deepEqual(problems, [], 'the write-site scan could not read every write');
  // A writer makes the document: a write that can create it, or an AI role's outbox file of a kind the Record stores
  // as that entity (M9 writer.mjs applyOutbox). An update alone writes nothing that is not there.
  const makers = new Map();
  for (const s of sites) if (s.modes?.includes('create')) makers.set(s.entity, [...(makers.get(s.entity) ?? []), `${s.file}:${s.line} (${s.actor})`]);
  for (const [k, spec] of Object.entries(OUTBOX_KINDS)) if (spec.entity && spec.pending === undefined) makers.set(spec.entity, [...(makers.get(spec.entity) ?? []), `outbox ${k}`]);
  return { reads, makers };
}
// The documents production reads that nothing in production makes, today. Each is a known gap; the test below fails
// when one is made (take it off) or a new one appears.
const KNOWN_UNWRITTEN = Object.freeze({});

test('a worker the real pass starts has the session record M4\'s push script reads', async () => {
  const w = dayOne();
  const id = undoTapped(w);
  await undoStep({ rec: w.rec, rules: w.rules, now: T0, filesOf: filesOfCommits, alert: w.alerts });
  const root = tempDir('orch-day-one-push-');
  const world = await pushWorld({ root, record: w.rec, seed: false, card: id, product: P });
  let sid = null;
  await undoStarts({ rec: w.rec, rules: w.rules, now: T0, bands: green(w.rules), running: [], filesOf: filesOfCommits, alert: w.alerts, host: 'mac-a',
    launch: async (x) => {
      sid = x.sessionId;
      // The launcher makes the session's own outbox and says where it is (pass.mjs's launch port).
      const box = join(root, 'outboxes', 'worker', x.sessionId);
      mkdirSync(box, { recursive: true, mode: 0o700 });
      return { ok: true, sessionId: x.sessionId, pid: 1001, pidStart: 'start', pgid: 101, head: undoSha(UNDO_ID), outbox: box };
    } });
  assert.ok(sid, `the undo card ${id} was not started`);
  const s = w.rec.read('session', sid)?.doc;
  assert.ok(s, 'no session record');
  for (const k of ['product', 'card', 'branch', 'outbox', 'attempt']) assert.ok(s[k], `the session record has no ${k}`);

  // The worker's work, handed in as a bundle in that outbox, and the real push script with nothing else in the Record.
  await world.commit('the undo', (dir) => { mkdirSync(dirname(join(dir, DOC)), { recursive: true }); writeFileSync(join(dir, DOC), 'the undo\n'); });
  await world.bundle(undefined, s.outbox);
  const tip = (await gitOk(['rev-parse', 'HEAD'], world.cg)).trim();
  const p = await world.push({ rules: pushRules(w, world) }, sid);
  assert.equal(p.ok, true, p.reason);
  assert.ok((await world.ghRefs()).split('\n').includes(`refs/heads/${s.branch} ${tip}`), 'GitHub has the card branch at the worker\'s tip');
});

// Not run here, logged (day-one audit Minor 4): M2's undo-flag, schedule and binding. The answered Undo ask is seeded;
// M2's own suite guards them.

test('L97, L129: every Record document production reads, today, has a production writer but for the known gaps', () => {
  const { reads, makers } = readsAndWriters();
  assert.ok(reads.has('card') && reads.has('product') && makers.has('card'), 'the scan reads the sources');
  const unwritten = [...reads.keys()].filter((e) => !makers.has(e)).sort();
  assert.deepEqual(unwritten, Object.keys(KNOWN_UNWRITTEN).sort(),
    `documents read with no writer: ${unwritten.map((e) => `${e} (read in ${[...reads.get(e)].join(', ')})`).join('; ')}`);
});

test('L97: every Record document production reads has a production writer', () => {
  const { reads, makers } = readsAndWriters();
  assert.deepEqual([...reads.keys()].filter((e) => !makers.has(e)), []);
});

// ---- L151 (P24): no text shown to Joe promises an action for a pending kind ----

// The shared scan lives in orchestrate/shared/no-promise.test.mjs (lane 1, #95). Where it exists it is imported at the top
// level, so its own tests run here too as tests of their own (inside a test they would be cancelled when it ends), and
// asked about every pending kind; it is never copied. A literal path: M2's consume-ask scan refuses a computed import()
// outside its list (day-one audit M-1).
const NO_PROMISE = join(ORCH, 'shared/no-promise.test.mjs');
const promiseScan = existsSync(NO_PROMISE) ? await import('../shared/no-promise.test.mjs') : null;
test('L151 (P24): no text shown to Joe promises an action for an outbox kind whose reader is pending', () => {
  const pending = Object.entries(OUTBOX_KINDS).filter(([, s]) => s.pending !== undefined).map(([k]) => k);
  if (!promiseScan) {
    assert.deepEqual(pending, [], `kinds ${pending.join(', ')} are pending, but the shared promise scan (shared/no-promise.test.mjs) is not here to read their shown texts`);
    return;
  }
  assert.equal(typeof promiseScan.unapproved, 'function', 'the shared scan exports unapproved(kind)');
  for (const k of pending) assert.deepEqual(promiseScan.unapproved(k), [], `${k}: a shown text is not an approved sentence`);
});

// ---- L137: every L137 to-do is gone before the first cutover ----

function testFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test(-helper)?\.(mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
// A `todo:` option or a test.todo( call whose line names the lead call. Built from parts so this file's own text never
// matches it.
const CALL = ['L', '137'].join('');
const TODO_NAMING = new RegExp(`\\btodo\\b\\s*[:(][^\\n]*\\b${CALL}\\b`);
test('L137: no test file in orchestrate/ still carries a to-do naming it', () => {
  const left = [];
  for (const p of testFiles(ORCH)) {
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (TODO_NAMING.test(line)) left.push(`${relative(ORCH, p).split(sep).join('/')}:${i + 1}`); });
  }
  assert.deepEqual(left, [], `${CALL} to-dos left`);
  // The scan reads what it should: a planted line is caught.
  assert.ok(TODO_NAMING.test(`test('x', { todo: '${CALL}: later' }, () => {});`));
  assert.ok(TODO_NAMING.test(`test.todo('${CALL} first');`));
});
