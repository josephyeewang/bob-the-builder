// fixtures.test-helper.mjs — shared set-up for M9's tests: a full set of time limits, a rules fake, a record in a temp
// folder, and short-hands for making a card reach a state the honest way (every step through the writer).

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFingerprint } from '../../shared/plan-fingerprint.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { openRecord } from './writer.mjs';
import { HEAD, PRODUCT, UID, rulesFor } from './rules.test-helper.mjs';

export { PRODUCT, HEAD, HEAD2, UID, fullTimeouts, rulesFor } from './rules.test-helper.mjs';

// A record in a fresh temp folder. `clock` is a mutable fake clock (ms).
export function setup({ values, prefix = 'm9-rec-', probe, faultAt, host = 'mac-a', extra = {} } = {}) {
  const base = tempDir(prefix);
  const root = join(base, 'store');
  const outRoot = join(base, 'outbox');
  mkdirSync(outRoot, { recursive: true });
  // The review runner's launch records (L65): a folder only the review user writes. Tests run as one user, so it is
  // this test's user, and the review view below names that user the review user.
  const launchRoot = join(base, 'launches');
  mkdirSync(launchRoot, { mode: 0o755 });
  chmodSync(launchRoot, 0o755);
  const clock = { t: Date.parse('2026-10-01T12:00:00Z') };
  const alerts = [];
  const rules = rulesFor(values);
  const uids = Object.fromEntries(['lead', 'worker', 'reviewer', 'auditor', 'incident', 'scout', 'writer', 'front_door', 'thinking', 'learning', 'script'].map((r) => [r, UID]));
  const opened = openRecord({ root, product: PRODUCT, ownerUid: UID, rules, alert: (a) => alerts.push(a), now: () => clock.t, host,
    probe, faultAt, outbox: { root: outRoot, uids, launches: launchRoot }, ...extra });
  // The review user (L44): reviewers and auditors write as a Mac user of their own. Tests run as one user, so this second
  // view of the same store calls this test's user the review user and every other role someone else; verdicts go in here.
  const reviewUids = Object.fromEntries(Object.keys(uids).map((r) => [r, r === 'reviewer' || r === 'auditor' ? UID : UID + 1]));
  const review = openRecord({ root, product: PRODUCT, ownerUid: UID, rules, alert: (a) => alerts.push(a), now: () => clock.t, host,
    probe, outbox: { root: outRoot, uids: reviewUids, launches: launchRoot }, ...extra }).record;
  return { ...opened, review, base, root, outRoot, launchRoot, reviewUids, clock, alerts, rules };
}

export const iso = (ms) => new Date(ms).toISOString();

export function plan(over = {}) {
  return { module: 'M1', files: ['src/a.mjs'], done_when: 'tests pass', tier: 2, ...over };
}

export function fingerprintFor(cardId, doc) {
  return planFingerprint({ product: PRODUCT, card_id: cardId, tier: doc.tier, files: doc.files, done_when: doc.done_when, plan_sha256: doc.plan_sha256, main_commit: doc.main_commit }).sha256;
}

export function rev(record, entity, id) { return record.read(entity, id)?.rev ?? 0; }

// Write as `actor`, taking the current rev, merging `fields` into the current document.
export function put(record, actor, entity, id, fields, extra = {}) {
  const cur = record.read(entity, id);
  return record.write({ actor, entity, id, expectRev: cur?.rev ?? 0, doc: { ...(cur?.doc ?? {}), ...fields }, ...extra });
}

export function must(r, what = 'write') {
  if (!r.ok) throw new Error(`${what} refused: ${r.reason}`);
  return r;
}

// A product in `state` (default active).
export function product(env, state = 'active') {
  must(env.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state } }), 'product');
}

// A go for card `id` with its plan.
export function go(env, id, doc) {
  must(env.record.write({ actor: 'approvals', entity: 'go', id: `go-${id}`, expectRev: 0, doc: { product: PRODUCT, card_id: id, plan_fingerprint: fingerprintFor(id, doc) } }), 'go');
}

// Drop a file in a session's outbox and return its path.
let fileNo = 0;
export function outboxFile(env, role, sid, name, text) {
  const dir = join(env.outRoot, role, sid);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name ?? `report-${++fileNo}.md`);
  writeFileSync(p, text);
  return p;
}

// The Lead's roadmap file: a header line, then notes.
export function roadmap(env, header, sid = 'L-1') {
  return env.record.applyOutbox({ role: 'lead', sessionId: sid }, outboxFile(env, 'lead', sid, `roadmap-${++fileNo}.md`, `${JSON.stringify({ entity: 'card', ...header })}\nnotes\n`));
}

// A draft card from the Lead (ordinary).
export function leadCard(env, id, over = {}) {
  const fields = { product: PRODUCT, kind: 'ordinary', ...plan(), ...over };
  must(roadmap(env, { id, expectRev: 0, fields }), `create ${id}`);
  return env.record.read('card', id).doc;
}

// A draft card from the Lead, with the owner's go, moved to ready.
export function readyCard(env, id, over = {}) {
  const doc = leadCard(env, id, over);
  go(env, id, doc);
  must(put(env.record, 'dispatcher', 'card', id, { state: 'ready' }), `${id} ready`);
}

export function sessionClaim(over = {}) {
  return { kind: 'session', host: 'mac-a', pid: 4242, pid_start: 'Thu Oct  1 11:00:00 2026', session_id: 'S-1', ...over };
}

export function claimCard(env, id, claim = sessionClaim()) {
  must(put(env.record, 'dispatcher', 'card', id, { state: 'claimed', claim }), `claim ${id}`);
}

export function runCard(env, id, claim) {
  claimCard(env, id, claim);
  must(put(env.record, 'dispatcher', 'card', id, { state: 'running' }), `run ${id}`);
}

// The review runner's launch record for a session (L65): the only launch a verdict counts from.
export function runnerLaunch(env, card, sid, role = 'reviewer', head = HEAD) {
  const p = join(env.launchRoot, `${sid}.json`);
  writeFileSync(p, JSON.stringify({ session_id: sid, role, card, head, launched_at: iso(env.clock.t), request_id: `q-${sid}` }), { mode: 0o644, flag: 'wx' });
  chmodSync(p, 0o644);
  return p;
}

// A passing verdict as the intake leaves it (L66 M1): the runner's launch record, the verdict file in the review outbox,
// and the row naming that file. Put straight into the store, so a test can start with a card's review done. A move to
// verified then goes through `env.review`, the view that knows the review user.
export function passingVerdict(env, card, sid, head = HEAD) {
  runnerLaunch(env, card, sid, 'reviewer', head);
  const p = outboxFile(env, 'reviewer', sid, `verdict-${sid}.md`, `${JSON.stringify({ entity: 'verdict', card, expectRev: 0, fields: { head, pass: true } })}\n`);
  const key = `${realpathSync(p)}\0${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
  env.store.transaction((tx) => tx.commit([{ entity: 'verdict', id: `verdict-${sid}`, doc: { session_id: sid, role: 'reviewer', card, head, pass: true, outbox_uid: UID, source_key: key } }], { actor: `reviewer:${sid}`, kind: 'verdict' }));
  return p;
}

// A launch the Dispatcher writes into the Record. For a review it is only a copy for display: no verdict counts from it.
export function launch(env, card, sid, role = 'reviewer') {
  must(env.record.write({ actor: 'dispatcher', entity: 'launch', id: `launch-${sid}`, expectRev: 0,
    doc: { session_id: sid, role, card, head: HEAD, rev: 1, launched_at: iso(env.clock.t) } }), 'launch');
}

// Put a document straight into the store, past the writer's checks (test set-up only: a state a test needs to start in).
export function seed(env, entity, id, doc) {
  return env.store.transaction((tx) => tx.commit([{ entity, id, doc }], { actor: 'test', kind: 'seed' }));
}
