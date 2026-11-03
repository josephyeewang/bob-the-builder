// dispatcher-wiring.test.mjs — the Dispatcher starts from its real entry point with the real wiring (R-0b-162 A, L229).
// Run: node --test orchestrate/wiring/dispatcher-wiring.test.mjs
//
// The boot test runs `node main.mjs <config>` as its own process, as the login job does, with the real wiring module,
// the real Record, the real rules reader, engine and rules, and the real lock. The only stand-in is GitHub (a fake
// fetch put in with `node --import`, fake-github.test-helper.mjs), so no test reaches the network. It runs in CI with
// the rest of orchestrate's tests (.github/workflows/scripts-ci.yml), so "it starts, start to finish" can't silently
// stop being true (lead's condition on PR A).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { FIRST, ENTRY, SAMPLE } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { LAST_PASS_FACT, STEPS, STEP_ERROR_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { wire, notWiredText } from './dispatcher-wiring.mjs';
import { fakeGitHubFetch, blobOf } from './fake-github.test-helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WIRING = join(here, 'dispatcher-wiring.mjs');
const MAIN = join(here, '..', 'modules', 'M11-dispatcher', 'main.mjs');
const FAKE = join(here, 'fake-github.test-helper.mjs');
const COMMIT = 'a'.repeat(40);
const P = ENTRY.product;
const TICK = join(here, '..', 'modules', 'M11-dispatcher', 'tick.mjs');

// PINNED HERE, not imported from the wiring (audit #127 M-1): a port the wiring quietly answers, or a step the tick
// quietly skips, must fail this test. PRs B, C and D update these as each port is wired.
// The ports not wired yet: each must refuse when called.
const PORTS_NOT_WIRED = Object.freeze(['board', 'filesOf', 'frontDoorAlive', 'frontDoorHandoff', 'gateAlive', 'hasReviewer', 'healthy',
  'hostLock', 'launch', 'leads', 'outboxSessions', 'pauseLead', 'probe', 'replyToLead', 'requestReview', 'restartFrontDoor', 'resume',
  'reviewAlerts', 'saveWork', 'sendFrontDoor', 'sessions', 'startMinibase', 'startReadonly', 'stopGroup', 'stopSession', 'strayFrontDoor', 'wait']);
const CLEANUP_NOT_WIRED = Object.freeze(['copiesRoot', 'git', 'mirrorFor', 'saveWork']);
// The ports wired for real (L270): approvals, whose GitHub writes and copies still refuse (pinned below).
const PORTS_WIRED = Object.freeze(['approvals']);
const APPROVALS_GH = Object.freeze(['get', 'patch', 'post', 'put']);
const APPROVALS_COPIES = Object.freeze(['done', 'pending', 'sync', 'told']);
// What else the tick reads from its ports object: the alert port, the cleanup group, and options with defaults.
const NOT_PORTS = Object.freeze(['alert', 'alertSendMs', 'approvalsProductMs', 'cleanup', 'intakeFs', 'portDeadlineMs', 'saveDeadlineMs', 'stepDeadlineMs']);
// One full pass with the ports above refusing: each step's outcome, and for a failed step the port its error names.
const NW = (port) => notWiredText(port);
const EXPECTED_STEPS = Object.freeze({
  stops: NW('sessions'), undo: 'ok', 'undo-starts': NW('sessions'), outage: NW('board'), intake: NW('outboxSessions'), leads: NW('leads'), approvals: 'ok',
  pass: NW('sessions'), limits: `no review was asked for: ${NW('reviewAlerts')}`, merges: 'ok', waits: 'ok', phone: 'ok', cleanup: NW('cleanup.copiesRoot'),
});

// One Mac's worth of files in a temp folder: the config, products.json, the approval list, the token file.
function world({ extra = {}, omit = [], products = [ENTRY] } = {}) {
  const dir = tempDir('orch-wiring-');
  const f = (n) => join(dir, n);
  writeFileSync(f('products.json'), JSON.stringify(products));
  const rulesStateDir = f('rules-state');
  mkdirSync(rulesStateDir, { mode: 0o700 });
  const token = f('token');
  writeFileSync(token, 'x'.repeat(40), { mode: 0o600 });
  chmodSync(token, 0o600);
  const config = { wiring: WIRING, lockFile: f('dispatcher.lock'), product: P, recordRoot: f('record'), ownerUid: process.getuid(),
    productsFile: f('products.json'), rulesStateDir, tokenFile: token, approvalsStateDir: f('approvals-state'), ...extra };
  for (const k of omit) delete config[k];
  writeFileSync(f('config.json'), JSON.stringify(config));
  const fake = { owner: ENTRY.owner, repo: ENTRY.repo, commit: COMMIT, text: FIRST, logFile: f('github.log') };
  writeFileSync(f('fake-github.json'), JSON.stringify(fake));
  const approve = (list) => { writeFileSync(join(rulesStateDir, 'approved-rules.json'), JSON.stringify({ [P]: list })); };
  return { dir, f, config, fake, approve };
}

function boot(w) {
  const r = spawnSync(process.execPath, ['--import', FAKE, MAIN, w.f('config.json')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ORCH_FAKE_GITHUB: w.f('fake-github.json') }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, err: r.stderr };
}

// The record as main.mjs left it, opened again for reading.
const readRecord = (w) => openRecord({ root: w.config.recordRoot, product: P, ownerUid: process.getuid(), rules: fakeRules() }).record;
const queued = (rec) => (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).map((e) => e.text);

test('R-0b-162 A: `node main.mjs <config>` with the real wiring runs one full pass, and runs again', () => {
  const w = world();
  w.approve([blobOf(FIRST)]);   // Joe's runbook step: the version he approved
  const first = boot(w);
  assert.equal(first.code, 0, first.err);
  assert.doesNotMatch(first.err, /not started/);
  // The real rules reader read GitHub, and adopted the approved version.
  const calls = readFileSync(w.fake.logFile, 'utf8');
  assert.match(calls, new RegExp(`GET /repos/${ENTRY.owner}/${ENTRY.repo}/git/ref/heads/main`));
  assert.ok(existsSync(join(w.config.rulesStateDir, `${P}.last-good.json`)), 'the approved rules were adopted');
  let rec = readRecord(w);
  const pass = rec.read('fact', LAST_PASS_FACT)?.doc;
  assert.ok(pass, 'the pass wrote last-full-pass');
  // Every step ran, in the tick's order, with the pinned outcome. A failed step names the port that refused, and Joe is told.
  assert.deepEqual(Object.keys(EXPECTED_STEPS), [...STEPS], 'the pinned map covers every step of the tick, in order');
  assert.deepEqual(pass.steps, Object.fromEntries(STEPS.map((s) => [s, EXPECTED_STEPS[s] === 'ok' ? 'ok' : 'failed'])));
  for (const s of STEPS) {
    if (EXPECTED_STEPS[s] === 'ok') continue;
    assert.equal(rec.read('fact', STEP_ERROR_FACT(s))?.doc?.error, EXPECTED_STEPS[s], s);
    assert.ok(queued(rec).includes(`the Dispatcher's ${s} step failed: ${EXPECTED_STEPS[s]}; the other steps still ran`), `${s} told: ${queued(rec).join('\n')}`);
  }
  // The Record was opened with the real rules: each write carries the approved version's revision (audit #127 m-2).
  const line = rec.diary({ since: 0 }).filter((l) => l.id === LAST_PASS_FACT).at(-1);
  assert.equal(line.rules_rev, `${P}=${COMMIT.slice(0, 7)}:${blobOf(FIRST).slice(0, 7)}`);
  // No channel to Joe yet: the alert is logged and stays queued, never marked sent.
  assert.match(first.err, /alert not sent \(no channel to Joe is wired yet\)/);
  const n = queued(rec).length;

  // Safe to run twice: the second pass runs, and the same causes are not queued twice.
  const second = boot(w);
  assert.equal(second.code, 0, second.err);
  rec = readRecord(w);
  assert.equal(queued(rec).length, n, queued(rec).join('\n'));
});

test('R-0b-162 A: rules Joe did not approve are not used, and that goes in the alert queue', () => {
  const w = world();
  w.approve([]);
  const r = boot(w);
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(w.config.rulesStateDir, `${P}.last-good.json`)), 'nothing adopted');
  assert.ok(queued(readRecord(w)).some((t) => /the rules for sample-app could not be used \(unapproved_rules_change\)/.test(t)), queued(readRecord(w)).join('\n'));
});

test('R-0b-162 A: a config the wiring does not know stops the start, told on stderr', () => {
  const cases = [
    [{ recordRot: '/tmp/typo' }, /config: unknown key recordRot/],
    [{ recordRoot: 'relative/record' }, /config: recordRoot must be an absolute path/],
    [{ rulesStateDir: 'rules-state' }, /config: rulesStateDir must be an absolute path/],
    [{ product: 'another-app' }, /config: .*products\.json does not list the product another-app/],
    // L309 Minor 1: the product names a folder, so . and .. (and any name not starting with a letter or digit) are refused.
    [{ product: '..' }, /config: product must be a product name/],
    [{ product: '.' }, /config: product must be a product name/],
    [{ product: '.sample-app' }, /config: product must be a product name/],
  ];
  for (const [extra, why] of cases) {
    const r = boot(world({ extra }));
    assert.equal(r.code, 1, JSON.stringify(extra));
    assert.match(r.err, new RegExp(`dispatcher: not started: ${why.source}`));
  }
});

test('R-0b-162 A: the tick reads exactly the pinned ports, and the wiring answers each one that is not wired by refusing', async () => {
  const src = readFileSync(TICK, 'utf8');
  const reads = [...new Set([...src.matchAll(/(?<!\w)p\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(reads, [...PORTS_NOT_WIRED, ...PORTS_WIRED, ...NOT_PORTS].sort(), 'a new port in tick.mjs must be pinned here');
  const w = world();
  const { ports } = await wire(w.config, { log: () => {}, fetchFn: fakeGitHubFetch(w.fake) });
  assert.deepEqual(Object.keys(ports).sort(), [...PORTS_NOT_WIRED, ...PORTS_WIRED, 'alert', 'cleanup'].sort(), 'no port is answered by anything but a refusal or a pinned wiring');
  assert.deepEqual(Object.keys(Object.getOwnPropertyDescriptors(ports.cleanup)).sort(), [...CLEANUP_NOT_WIRED].sort());
});

test('R-0b-162 A: the Record\'s own alerts are logged and answered "not delivered", so the store keeps them', async () => {
  const w = world();
  const logs = [];
  const { rec } = await wire(w.config, { log: (s) => logs.push(s), fetchFn: fakeGitHubFetch(w.fake) });
  // A document file changed behind the Store Writer's back: the next write quarantines it and raises a store alert.
  const put = () => rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0, doc: { at: new Date().toISOString(), steps: {} }, kind: 'full_pass' });
  assert.ok(put().ok);
  writeFileSync(join(w.config.recordRoot, 'docs', 'fact', `${LAST_PASS_FACT}.json`), '{"changed":true}');
  put();
  assert.ok(logs.some((l) => l.startsWith('dispatcher: record alert not sent: ')), logs.join('\n'));
  assert.notEqual(readFileSync(join(w.config.recordRoot, 'unsent-alerts.jsonl'), 'utf8').trim(), '', 'kept to be told again');
});

test('R-0b-162 A: every port not wired yet refuses when called, and the alert port answers "not delivered"', async () => {
  const w = world();
  const logs = [];
  const { ports, rec } = await wire(w.config, { log: (s) => logs.push(s), fetchFn: fakeGitHubFetch(w.fake) });
  assert.ok(rec && typeof rec.read === 'function');
  for (const k of PORTS_NOT_WIRED) assert.throws(() => ports[k](), { message: notWiredText(k) }, k);
  for (const k of CLEANUP_NOT_WIRED.filter((x) => x !== 'copiesRoot')) assert.throws(() => ports.cleanup[k](), { message: notWiredText(`cleanup.${k}`) }, k);
  // The tick spreads the cleanup ports into its step: the spread itself refuses.
  assert.throws(() => ({ ...ports.cleanup }), { message: notWiredText('cleanup.copiesRoot') });
  assert.equal(await ports.alert('hello'), false);
  assert.deepEqual(logs, ['dispatcher: alert not sent (no channel to Joe is wired yet): hello']);
});

test('R-0b-162 A: the wired rules know the role files, and refuse a start that needs the running count', async () => {
  const w = world();
  w.approve([blobOf(SAMPLE)]);
  const { rec, rules } = await wire(w.config, { log: () => {}, fetchFn: fakeGitHubFetch({ ...w.fake, text: SAMPLE }) });
  // An active product, as approvals would write it (the engine reads a product with no document as paused).
  rec.write({ actor: 'approvals', entity: 'product', id: P, expectRev: 0, doc: { state: 'active' }, kind: 'product' });
  assert.equal(rules.may('start_session', { product: P, role: 'reviewer', tier: 2, editing: false }).decision, 'allow');
  // An editing start counts the sessions running; the count is not wired, so the rules refuse it with that reason, never allow it on 0.
  const ed = rules.may('start_session', { product: P, role: 'worker', tier: 2, editing: true });
  assert.equal(ed.decision, 'deny');
  assert.match(ed.reason, new RegExp(notWiredText('running').replace(/[()]/g, '\\$&')));
});

test('L270: the approvals port answers this product with its state folder; its GitHub writes and copies refuse', async () => {
  const w = world();
  const { ports } = await wire(w.config, { log: () => {}, fetchFn: fakeGitHubFetch(w.fake) });
  const list = await ports.approvals();
  assert.equal(list.length, 1);
  const [x] = list;
  assert.deepEqual(Object.keys(x).sort(), ['copies', 'gh', 'owner', 'product', 'repo', 'stateDir']);
  // The product's own subfolder (L295 MAT-2), made at boot, private to this user.
  assert.deepEqual([x.product, x.owner, x.repo, x.stateDir], [P, ENTRY.owner, ENTRY.repo, join(w.config.approvalsStateDir, P)]);
  for (const d of [w.config.approvalsStateDir, x.stateDir]) assert.equal(lstatSync(d).mode & 0o777, 0o700, d);
  assert.deepEqual(Object.keys(x.gh).sort(), [...APPROVALS_GH]);
  for (const k of APPROVALS_GH) assert.throws(() => x.gh[k]('/x'), { message: notWiredText('approvals.gh') }, k);
  assert.deepEqual(Object.keys(x.copies).sort(), [...APPROVALS_COPIES]);
  for (const k of APPROVALS_COPIES) assert.throws(() => x.copies[k]('s'), { message: notWiredText('approvals.copies') }, k);
  assert.equal('push' in x, false, 'no phone channel: M2 says approvals_no_push in the open');
});

test('L270: a boot whose rules say onboarding.state active turns the product on, as approvals, once', () => {
  const w = world();
  w.approve([blobOf(FIRST)]);
  assert.equal(boot(w).code, 0);
  let rec = readRecord(w);
  const p = rec.read('product', P);
  assert.equal(p?.doc?.state, 'active', 'the product record was made');
  const made = rec.diary({ since: 0 }).filter((l) => l.entity === 'product' && l.id === P);
  assert.deepEqual(made.map((l) => [l.actor, l.kind]), [['approvals', 'onboard']]);
  assert.ok(queued(rec).some((s) => s.includes(`${P} is now on`)), queued(rec).join('\n'));
  // A second boot leaves the record alone and says nothing new about it.
  const n = queued(rec).length;
  assert.equal(boot(w).code, 0);
  rec = readRecord(w);
  assert.equal(rec.diary({ since: 0 }).filter((l) => l.entity === 'product' && l.id === P).length, 1);
  assert.equal(queued(rec).filter((s) => s.includes(`${P} is now on`)).length, 1);
  assert.equal(queued(rec).length, n);
});

// L295 MAT-1: a state folder M2 can't use stops the start, before the Record opens, so no product is turned on untold.
test('L295 MAT-1: a missing, relative, unmakeable, linked, shared or read-only approvals folder stops the start', () => {
  const cases = [
    [(w) => ({ omit: ['approvalsStateDir'] }), /config: approvalsStateDir must be an absolute path/],
    [() => ({ extra: { approvalsStateDir: 'approvals-state' } }), /config: approvalsStateDir must be an absolute path/],
    [() => ({ extra: { approvalsStateDir: '/nonexistent-orch-parent/approvals-state' } }), /the approvals state folder \(approvalsStateDir\) .* is missing and could not be made/],
    ['link', /the approvals state folder \(approvalsStateDir\) .* is not a plain folder/],
    ['shared', /the approvals state folder \(approvalsStateDir\) .* can be read by others \(mode 755\)/],
    ['read-only', /the approvals state folder \(approvalsStateDir\) .* can't be written/],
  ];
  for (const [how, why] of cases) {
    const w = typeof how === 'function' ? world(how()) : world();
    if (how === 'link') { mkdirSync(w.f('real-state'), { mode: 0o700 }); symlinkSync(w.f('real-state'), w.config.approvalsStateDir); }
    if (how === 'shared') { mkdirSync(w.config.approvalsStateDir); chmodSync(w.config.approvalsStateDir, 0o755); }
    if (how === 'read-only') { mkdirSync(w.config.approvalsStateDir); chmodSync(w.config.approvalsStateDir, 0o500); }
    w.approve([blobOf(FIRST)]);
    const r = boot(w);
    assert.equal(r.code, 1, String(how));
    assert.match(r.err, new RegExp(`dispatcher: not started: ${why.source}`), String(how));
    assert.equal(existsSync(w.config.recordRoot), false, `${how}: the Record was not opened, so nothing was turned on`);
    if (how === 'read-only') chmodSync(w.config.approvalsStateDir, 0o700);
  }
});

// L295 MAT-2 + Minor 2: products.json with another product first: this product's own owner/repo, and its own subfolder,
// so two Dispatchers sharing approvalsStateDir never share a told-once mark.
test('L295 MAT-2: with two products listed, each Dispatcher answers its own owner/repo and its own state subfolder', async () => {
  const OTHER = { ...ENTRY, product: 'other-app', owner: 'other-org', repo: 'other-repo' };
  const w = world({ products: [OTHER, ENTRY] });
  const [x] = await (await wire(w.config, { log: () => {}, fetchFn: fakeGitHubFetch(w.fake) })).ports.approvals();
  assert.deepEqual([x.product, x.owner, x.repo], [P, ENTRY.owner, ENTRY.repo]);
  const other = { ...w.config, product: OTHER.product, recordRoot: w.f('record-other') };
  const [y] = await (await wire(other, { log: () => {}, fetchFn: fakeGitHubFetch({ ...w.fake, owner: OTHER.owner, repo: OTHER.repo }) })).ports.approvals();
  assert.deepEqual([y.product, y.owner, y.repo], [OTHER.product, OTHER.owner, OTHER.repo]);
  assert.notEqual(x.stateDir, y.stateDir);
  assert.deepEqual([x.stateDir, y.stateDir], [join(w.config.approvalsStateDir, P), join(w.config.approvalsStateDir, OTHER.product)]);
});

// L295 Minor 2: the queue replaces identical text in place, so "once" is checked on the entry itself: a second boot
// that queued "is now on" again would move its queued_at.
test('L295 Minor 2: a second boot does not queue "is now on" again (the entry and its queued_at are unchanged)', () => {
  const w = world();
  w.approve([blobOf(FIRST)]);
  assert.equal(boot(w).code, 0);
  const on = (rec) => (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => e.text.includes(`${P} is now on`));
  const first = on(readRecord(w));
  assert.equal(first.length, 1);
  assert.equal(boot(w).code, 0);
  assert.deepEqual(on(readRecord(w)), first);
});
