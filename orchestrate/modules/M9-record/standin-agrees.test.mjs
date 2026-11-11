// standin-agrees.test.mjs — the shared/record.mjs memory stand-in's applyOutbox against the real M9 applyOutbox,
// for every outbox kind × every AI role, plus names that break OUTBOX_NAME (LEAD-CALLS L129 M-1).
//
// The stand-in reads only a file's name and the tag, never the file, so it must agree with the real Record on the
// reasons that need nothing more: no outbox kind for the name, a kind not listed for the role, a kind with no record
// rule yet. Where the real Record refuses on what the file says or who owns it, the stand-in may accept; that is the
// only allowed difference, and the test counts it so a stand-in that drifts the other way (refusing what the real
// one takes) fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, outboxFile, outboxTag, product, readyCard, runCard, seed, plan, put, must, iso, PRODUCT } from './fixtures.test-helper.mjs';
import { recWith, parkOnLimit, setClock } from '../M11-dispatcher/fixtures.test-helper.mjs';
import { memoryRecord, OUTBOX_KINDS, AI_ROLES } from '../../shared/record.mjs';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// L938 m1, m2: where a file is, case for case. The same files, on the same root, go to the real Record and the stand-in,
// and each must be refused with the same reason. A stand-in that let one of these through (the old flat layout under a
// product tag, a product named on a Lead's tag, another product's tag) would hand M11's tests a file M9 never reads.
test('L938 m1: the stand-in and the real applyOutbox refuse each misplaced file with the same reason', () => {
  const env = setup({ prefix: 'm9-place-' });
  const fake = memoryRecord({ outboxRoot: env.outRoot, product: PRODUCT });
  const put = (dir, name, text = 'plain text body\n') => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, text); return p; };
  const w = (sid, more = {}) => ({ role: 'worker', sessionId: sid, product: PRODUCT, card: 'C-1', ...more });
  const elsewhere = put(join(env.base, 'elsewhere'), 'report-C-1.md');
  const linkDir = join(env.outRoot, PRODUCT, 'worker', 'S-1');
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(elsewhere, join(linkDir, 'report-C-1.md'));
  outboxFile(env, 'worker', 'S-2', 'report-C-2.md', 'x\n');
  mkdirSync(join(env.outRoot, PRODUCT, 'worker', 'S-3'), { recursive: true });   // S-3's own folder is there; its file is not in it
  const cases = [
    ['a link', w('S-1'), join(linkDir, 'report-C-1.md'), /./],
    ['the wrong folder', w('S-3'), put(join(env.outRoot, PRODUCT, 'worker', 'S-2'), 'report-C-3.md'), /not directly inside the worker outbox of session S-3/],
    ['a missing session folder', w('S-4'), put(join(env.outRoot, PRODUCT, 'worker'), 'report-C-4.md'), /^no outbox folder for worker S-4 of product /],
    ['the flat layout under a product tag', w('S-5'), put(join(env.outRoot, 'worker', 'S-5'), 'report-C-5.md'), /^no outbox folder for worker S-5 of product /],
    ['a worker tag with no product', w('S-6', { product: undefined }), put(join(env.outRoot, PRODUCT, 'worker', 'S-6'), 'report-C-6.md'), /the tag names no product/],
    ['a Lead tag with a product', { role: 'lead', sessionId: 'L-7', product: PRODUCT }, put(join(env.outRoot, 'lead', 'L-7'), 'wish-7.md'), /a lead outbox has no product folder/],
    ['another product\'s tag', w('S-8', { product: 'other-app' }), put(join(env.outRoot, 'other-app', 'worker', 'S-8'), 'report-C-8.md'), /and the outbox is product other-app's$/],
  ];
  for (const [what, tag, file, want] of cases) {
    const real = env.record.applyOutbox(tag, file);
    const f = fake.applyOutbox(tag, file);
    assert.equal(real.ok, false, `${what}: the real Record refuses it`);
    assert.match(real.reason, want, `${what}: the real Record's own reason`);
    assert.equal(f.ok, false, `${what}: the stand-in refuses it too`);
    assert.equal(f.reason, real.reason, `${what}: the same reason`);
  }
  // With no root, both refuse even a file in its right folder.
  const noRoot = setup({ prefix: 'm9-place-', extra: { outbox: { root: '', uids: {}, launches: env.launchRoot } } });
  const good = outboxFile(env, 'worker', 'S-9', 'report-C-9.md', 'x\n');
  const real = noRoot.record.applyOutbox(w('S-9'), good);
  assert.equal(real.reason, 'no outbox root configured');
  assert.equal(memoryRecord({ product: PRODUCT }).applyOutbox(w('S-9'), good).reason, real.reason);
  // Control: the same file is placed rightly, so the stand-in with the root goes past the place check.
  assert.ok(!/outbox|link|folder|inside/.test(fake.applyOutbox(w('S-9'), good).reason ?? ''), 'a rightly placed file passes the place check');
});

const NAME_REASONS = /^(no outbox kind for file name|outbox kind \S+ is not listed for|outbox kind \S+ has no record rule yet|not_a_record$)/;
const EXTRA = ['notakind-X1.md', 'report-.md', 'REPORT-X1.md', 'report-X.1.md', 'report-X1.MD', 'report-X1.md.txt',
  'report_X1.md', 'report-X1', 'report-é.md', 'verdict-compact-S1.md'];

test('L129 M-1: the stand-in and the real applyOutbox agree on every name and role reason, case for case', () => {
  const env = setup({ prefix: 'm9-standin-' });
  const fake = memoryRecord({ outboxRoot: env.outRoot });   // the same folder, so where a file is checks alike (L151 m7)
  let n = 0;
  let cases = 0;
  let nameRefusals = 0;
  const wrong = [];
  for (const role of AI_ROLES) {
    const sid = `S${role.length}x${role.replace(/_/g, '')}`;
    const names = [...Object.keys(OUTBOX_KINDS).flatMap((k) => [`${k}X${++n}.md`, `${k}X${++n}.json`, `${k}compact-X${++n}.md`]), ...EXTRA];
    for (const name of names) {
      const p = outboxFile(env, role, sid, name, 'plain text body\n');
      const tag = outboxTag(role, sid, { card: 'C-1' });
      const real = env.record.applyOutbox(tag, p);
      const f = fake.applyOutbox(tag, p);
      cases += 1;
      const realByName = !real.ok && NAME_REASONS.test(real.reason);
      if (realByName) {
        nameRefusals += 1;
        if (f.ok || f.reason !== real.reason) wrong.push(`${role} ${name}: real refused "${real.reason}", stand-in ${f.ok ? 'accepted' : `refused "${f.reason}"`}`);
      } else if (!f.ok) {
        wrong.push(`${role} ${name}: stand-in refused "${f.reason}", real ${real.ok ? 'accepted' : `refused on content "${real.reason}"`}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} disagreements`);
  // The loop must really have covered the cases the audit found (589 name/role refusals the old stand-in accepted).
  assert.ok(cases >= AI_ROLES.length * (Object.keys(OUTBOX_KINDS).length * 3 + EXTRA.length), `${cases} cases`);
  assert.ok(nameRefusals >= 589, `only ${nameRefusals} name/role refusals were exercised`);
});

// L228: M11's tests write fix cards to the stand-in, so it must refuse what the Store Writer refuses (Principle 10).
test('L228: the stand-in and the Store Writer agree on a new fix card\'s plan, the tier rule included', () => {
  const base = plan();
  const noTier = { ...base };
  delete noTier.tier;
  const cases = [['no tier', noTier], ['the root\'s tier', base], ['tier 1', { ...base, tier: 1 }], ['tier null', { ...base, tier: null }],
    ['other files', { ...base, files: ['src/other.mjs'] }], ['other done_when', { ...base, done_when: 'easier' }], ['no tier, other files', { ...noTier, files: ['src/other.mjs'] }]];
  const seen = new Set();
  for (const [what, p] of cases) {
    const env = setup({ prefix: 'm9-sa-' });
    product(env);
    readyCard(env, 'C-1');
    seed(env, 'card', 'C-1', { ...env.record.read('card', 'C-1').doc, state: 'failed' });
    const mem = recWith([['card', 'C-1', { state: 'failed', product: PRODUCT, kind: 'ordinary', ...base, failure: { reason: 'x', at: '2026-10-01T12:00:00.000Z' } }]]);
    const doc = { state: 'draft', product: PRODUCT, kind: 'fix', fix_of: 'C-1', ...p };
    const real = env.record.write({ actor: 'dispatcher', entity: 'card', id: 'F-1', expectRev: 0, doc: structuredClone(doc) });
    const fake = mem.write({ actor: 'dispatcher', entity: 'card', id: 'F-1', expectRev: 0, doc: structuredClone(doc) });
    assert.deepEqual([fake.ok, fake.reason], [real.ok, real.reason], what);
    seen.add(real.ok);
  }
  assert.deepEqual([...seen].sort(), [false, true], 'both written and refused cases');
});

// L296: M11's pass tests run on the stand-in, so a re-checked wait's since must come back as the Store Writer stores it
// (kept on a re-check of the same who and what; a new wait's own). The same steps, at the same times, on both.
test('L296: the stand-in and the Store Writer store the same wait.since, step for step, re-checks and a new wait alike', () => {
  const MIN = 60000;
  const env = setup({ prefix: 'm9-sa-since-' });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  const t0 = env.clock.t;
  const fake = recWith([], { now: t0 });
  parkOnLimit(fake, 'C-1', { ranAt: t0, parkedAt: t0, account: 'a' });
  const park = { who: 'usage', what: 'limit_hit', since: iso(t0), next_check: iso(t0 + 30 * MIN), resume: 'retry', return_to: 'ready', account: 'a' };
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: park }), 'park');
  const real = () => env.record.read('card', 'C-1').doc.wait;
  const stand = () => fake.read('card', 'C-1').doc.wait;
  const at = (ms) => { env.clock.t = ms; setClock(fake, ms); };
  const recheck = (fields) => {
    const nowMs = env.clock.t;
    const patch = (w) => ({ wait: { ...w, next_check: iso(nowMs + 30 * MIN), ...fields(nowMs, w) } });
    const r = put(env.record, 'dispatcher', 'card', 'C-1', patch(real()));
    const f = put(fake, 'dispatcher', 'card', 'C-1', patch(stand()));
    return { real: r.ok, stand: f.ok };
  };
  const steps = [];
  const step = (what, ms, fields) => { at(ms); const ok = recheck(fields); steps.push([what, ok, real().since, stand().since, real().who, stand().who]); };
  assert.equal(stand().since, real().since, 'the park');
  step('re-check two days on, sending now', t0 + 2 * 24 * 60 * MIN, (n) => ({ since: iso(n) }));
  step('re-check an hour on, sending the kept since', t0 + 2 * 24 * 60 * MIN + 60 * MIN, () => ({}));
  step('the same wait turned to Joe (a new what)', t0 + 3 * 24 * 60 * MIN, (n) => ({ who: 'joe', what: 'limit_hit: the hit has no readable reset time', since: iso(n) }));
  step('the Joe wait re-checked an hour on, sending now', t0 + 3 * 24 * 60 * MIN + 60 * MIN, (n) => ({ since: iso(n) }));
  // Audit #153 m2: who alone, what alone, and a what that differs only by case or a trailing space are each a new wait.
  const D3 = t0 + 3 * 24 * 60 * MIN;
  const JOE_WHAT = 'limit_hit: the hit has no readable reset time';
  step('who alone changes (joe back to usage, the same what)', D3 + 2 * 60 * MIN, (n) => ({ who: 'usage', since: iso(n) }));
  step('what alone changes (usage, another what)', D3 + 3 * 60 * MIN, (n) => ({ what: 'limit_hit: another reading', since: iso(n) }));
  step('what differs only by case', D3 + 4 * 60 * MIN, (n) => ({ what: 'LIMIT_HIT: another reading', since: iso(n) }));
  step('what differs only by a trailing space', D3 + 5 * 60 * MIN, (n) => ({ what: 'LIMIT_HIT: another reading ', since: iso(n) }));
  step('and that wait re-checked, sending now', D3 + 6 * 60 * MIN, (n) => ({ since: iso(n) }));
  for (const [what, ok, r, f, rw, fw] of steps) {
    assert.deepEqual(ok, { real: true, stand: true }, what);
    assert.equal(f, r, `${what}: since`);
    assert.equal(fw, rw, `${what}: who`);
  }
  assert.equal(real().what, 'LIMIT_HIT: another reading ');
  assert.notEqual(JOE_WHAT, real().what);
  // The kept sinces really were kept, and each new wait's really is new.
  const h = (k) => iso(D3 + k * 60 * MIN);
  assert.deepEqual(steps.map(([, , r]) => r), [iso(t0), iso(t0), iso(D3), iso(D3), h(2), h(3), h(4), h(5), h(5)]);
  // The one allowed difference: a re-check naming another past since. The Store Writer refuses it; the stand-in does
  // not check since against its clock (shared/record.mjs), but still keeps the stored since, never the one sent.
  at(D3 + 7 * 60 * MIN);
  const ok = recheck((n) => ({ since: iso(n - 30 * MIN) }));
  assert.deepEqual(ok, { real: false, stand: true });
  assert.equal(stand().since, real().since);
});
