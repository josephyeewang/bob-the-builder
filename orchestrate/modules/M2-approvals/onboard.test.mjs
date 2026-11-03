// onboard.test.mjs — a product's record is made once, as active, when its rules file says `onboarding.state: active`
// and it has none (LEAD-CALLS L204-b, L209): through the real pass, on the real M9 writer, and on M10's real engine with
// rules kept from the last good file. Never over a record that exists, in any state; never on any other value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env, PRODUCT, must } from './fixtures.test-helper.mjs';
import { schedulePass } from './schedule.mjs';
import { createAsk } from './binding.mjs';
import { onboard, onboardNotices, ONBOARD_KEY, ONBOARD_SHOWN } from './onboard.mjs';
import { makeRules } from '../../shared/rules.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { FIRST } from '../M10-rules/first-cutover.test-helper.mjs';

const ON = { [ONBOARD_KEY]: 'active' };
function world(values = ON) {
  const t = env({ values });
  t.ctx.stateDir = join(t.base, 'm2-state');
  return t;
}
const onboards = (t) => t.record.diary({}).filter((l) => l.entity === 'product' && l.kind === 'onboard');
// The same rules fake with other values: a rules file edited between passes.
const rulesOf = (_t, values) => env({ values }).ctx.rules;

test('a product with no record and `onboarding.state: active` gets one, active, written by approvals as onboard', async () => {
  const t = world();
  assert.equal(t.record.read('product', PRODUCT), null, 'the set-up makes no product record');
  const r = await schedulePass(t.ctx);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.events.filter((e) => e.type === 'onboarded'), [{ type: 'onboarded', product: PRODUCT }]);
  const p = t.record.read('product', PRODUCT);
  assert.equal(p.doc.state, 'active');
  assert.equal(p.rev, 1);
  const lines = onboards(t);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor, 'approvals');
  assert.equal(lines[0].id, PRODUCT);
});

test('a second pass after the create writes nothing new: no second onboard line', async () => {
  const t = world();
  await schedulePass(t.ctx);
  const before = t.record.diary({}).length;
  const r = await schedulePass(t.ctx);
  assert.ok(r.ok, r.reason);
  assert.equal(r.events.some((e) => e.type === 'onboarded' || e.type === 'onboard_refused'), false);
  assert.equal(onboards(t).length, 1);
  assert.equal(t.record.read('product', PRODUCT).rev, 1);
  assert.equal(t.record.diary({}).filter((l) => l.entity === 'product').length, 1);
  assert.ok(t.record.diary({}).length >= before);
});

test('an existing record in any state is never touched: a paused product stays paused, with no onboard line', async () => {
  for (const state of ['paused', 'away', 'light', 'active']) {
    const t = world();
    must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state } }), 'product');
    const r = await schedulePass(t.ctx);
    assert.ok(r.ok, r.reason);
    assert.equal(r.events.some((e) => e.type === 'onboarded' || e.type === 'onboard_refused'), false, `${state}: no write was tried`);
    const p = t.record.read('product', PRODUCT);
    assert.equal(p.doc.state, state, state);
    assert.equal(p.rev, 1, state);
    assert.equal(onboards(t).length, 0, state);
  }
});

test('a missing key, another case, a trailing space, another type or unreadable rules make no record', async () => {
  const cases = [
    ['missing', {}],
    ['Active', { [ONBOARD_KEY]: 'Active' }],
    ['trailing space', { [ONBOARD_KEY]: 'active ' }],
    ['a number', { [ONBOARD_KEY]: 123 }],
    ['a list', { [ONBOARD_KEY]: ['active'] }],
    ['a map', { [ONBOARD_KEY]: { state: 'active' } }],
    ['true', { [ONBOARD_KEY]: true }],
    ['paused', { [ONBOARD_KEY]: 'paused' }],
  ];
  for (const [name, values] of cases) {
    const t = world(values);
    const r = await schedulePass(t.ctx);
    assert.ok(r.ok, `${name}: ${r.reason}`);
    assert.equal(t.record.read('product', PRODUCT), null, name);
    assert.equal(onboards(t).length, 0, name);
  }
  // Rules that can't be read: the engine's get gives nothing (makeRules turns an unreadable file into that). A get that
  // throws is a broken port, and the throw goes up so the Dispatcher's step-error alert says so (L221 c-2).
  const t = world();
  assert.equal(onboard({ ...t.ctx, rules: { ...t.ctx.rules, get: () => undefined } }), null);
  assert.throws(() => onboard({ ...t.ctx, rules: { get: () => { throw new Error('rules unreadable'); } } }), /rules unreadable/);
  assert.equal(t.record.read('product', PRODUCT), null);
});

// L221 m-1: a near-miss value is told to Joe once per distinct value, never every pass; a missing key stays silent.
const told = (t, type) => t.alerts.filter((a) => a.type === type);
test('a near-miss value with no record sends one alert per distinct value; a missing key sends none (L221 m-1)', async () => {
  for (const v of ['Active', ['active'], 'active ', 'paused', true]) {
    const t = world({ [ONBOARD_KEY]: v });
    for (let i = 0; i < 3; i++) assert.ok((await schedulePass(t.ctx)).ok);
    const a = told(t, 'onboard_near_miss');
    assert.equal(a.length, 1, `${JSON.stringify(v)}: one alert over three passes`);
    // The value as the rules give it (this fake turns a bare true into the text "true").
    const got = t.ctx.rules.get(ONBOARD_KEY, { product: PRODUCT });
    assert.equal(a[0].text, ONBOARD_SHOWN.nearMiss(PRODUCT, got));
    assert.match(a[0].text, new RegExp(`^${PRODUCT} was not turned on: onboarding.state is `));
    assert.ok(a[0].text.includes(JSON.stringify(got)), 'the value is shown as written');
    // Another value is told again, once.
    t.ctx.rules = rulesOf(t, { [ONBOARD_KEY]: 'Activ' });
    await schedulePass(t.ctx);
    await schedulePass(t.ctx);
    assert.equal(told(t, 'onboard_near_miss').length, 2, `${JSON.stringify(v)} then 'Activ': two alerts`);
  }
  const quiet = world({});
  for (let i = 0; i < 3; i++) await schedulePass(quiet.ctx);
  assert.deepEqual(quiet.alerts.filter((a) => /onboard|product_on/.test(a.type)), [], 'missing key: silent');
  // A record already there: a near-miss value says nothing (the product is not being turned on).
  const has = world({ [ONBOARD_KEY]: 'Active' });
  must(has.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'paused' } }), 'product');
  await schedulePass(has.ctx);
  assert.deepEqual(told(has, 'onboard_near_miss'), []);
});

test('an alert the sink did not take is sent again next pass, then kept quiet (L221 m-1)', async () => {
  const t = world({ [ONBOARD_KEY]: 'Active' });
  const sink = t.ctx.alert;
  t.ctx.alert = fakeAlert({ answer: (a) => (a.type === 'onboard_near_miss' ? false : sink(a)) });
  await schedulePass(t.ctx);
  t.ctx.alert = sink;
  await schedulePass(t.ctx);
  await schedulePass(t.ctx);
  assert.equal(told(t, 'onboard_near_miss').length, 1);
});

// L221 m-2: a refused create is told once per distinct reason, its numbers out.
test('a refused create sends one alert per distinct reason, naming the product (L221 m-2)', () => {
  const t = world();
  let reason = 'changed since read (rev 1, expected 0)';
  const ctx = { ...t.ctx, record: { read: () => null, write: () => ({ ok: false, reason }) } };
  for (let i = 0; i < 3; i++) onboardNotices(ctx, onboard(ctx));
  reason = 'changed since read (rev 2, expected 0)';
  onboardNotices(ctx, onboard(ctx));
  const a = told(t, 'onboard_refused');
  assert.equal(a.length, 1, 'a moving rev is one reason');
  assert.equal(a[0].text, `${PRODUCT} was not turned on: changed since read (rev 1, expected 0)`);
  assert.equal(a[0].text, ONBOARD_SHOWN.refused(PRODUCT, 'changed since read (rev 1, expected 0)'));
  reason = 'a damaged diary';
  onboardNotices(ctx, onboard(ctx));
  onboardNotices(ctx, onboard(ctx));
  assert.equal(told(t, 'onboard_refused').length, 2, 'another reason: told once more');
});

// L221 c-4: one "now on" notice when the record is made; a lost send is sent again.
test('a successful onboard sends one "is now on" notice, and a lost one is sent next pass (L221 c-4)', async () => {
  const t = world();
  for (let i = 0; i < 3; i++) await schedulePass(t.ctx);
  assert.deepEqual(told(t, 'product_on').map((a) => a.text), [ONBOARD_SHOWN.on(PRODUCT)]);
  assert.equal(ONBOARD_SHOWN.on(PRODUCT), `${PRODUCT} is now on: its rules file says onboarding.state: active.`);
  const lost = world();
  const sink = lost.ctx.alert;
  lost.ctx.alert = fakeAlert({ answer: (a) => (a.type === 'product_on' ? false : sink(a)) });
  await schedulePass(lost.ctx);
  assert.equal(told(lost, 'product_on').length, 0);
  lost.ctx.alert = sink;
  await schedulePass(lost.ctx);
  await schedulePass(lost.ctx);
  assert.equal(told(lost, 'product_on').length, 1, 'sent once the sink takes it, then not again');
  assert.equal(onboards(lost).length, 1);
});

// L221 c-1: the create comes before anything else the pass does, so the rest of it reads the record just made.
test('onboarded is the pass\'s first event (L221 c-1)', async () => {
  const t = world();
  const r = await schedulePass(t.ctx);
  assert.deepEqual(r.events[0], { type: 'onboarded', product: PRODUCT });
});

// L221 c-3 (the auditor's PROBE-A and PROBE-B, on the real store): a doc file with no diary line behind it, or one
// hand-edited away from its diary line, reads corrupt, and a corrupt record is never written over.
test('a paused record whose doc file was hand-edited to active reads corrupt and is left alone (PROBE-A)', async () => {
  const t = world();
  must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'paused' } }), 'product');
  writeFileSync(join(t.root, 'docs', 'product', `${PRODUCT}.json`), JSON.stringify({ state: 'active' }));
  assert.equal(t.record.read('product', PRODUCT).corrupt, true, 'the hand edit reads corrupt');
  assert.ok((await schedulePass(t.ctx)).ok);
  assert.equal(t.record.read('product', PRODUCT).corrupt, true);
  assert.equal(t.record.diary({}).filter((l) => l.entity === 'product').length, 1, 'still the one product line');
  assert.equal(onboards(t).length, 0);
});

test('a stray product doc file with no diary line reads corrupt and nothing is made (PROBE-B)', async () => {
  const t = world();
  const f = join(t.root, 'docs', 'product', `${PRODUCT}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ state: 'active' }));
  assert.equal(t.record.read('product', PRODUCT).corrupt, true, 'a file with no diary line reads corrupt');
  assert.ok((await schedulePass(t.ctx)).ok);
  assert.equal(t.record.read('product', PRODUCT).corrupt, true);
  assert.equal(t.record.diary({}).filter((l) => l.entity === 'product').length, 0);
});

test('the key is read for this product: a Mac-wide read would never see it', () => {
  const t = world();
  const asked = [];
  const ctx = { ...t.ctx, rules: { get: (k, o) => { asked.push([k, o]); return o?.product === PRODUCT ? 'active' : undefined; } } };
  assert.deepEqual(onboard(ctx), { type: 'onboarded', product: PRODUCT });
  assert.deepEqual(asked, [[ONBOARD_KEY, { product: PRODUCT }]]);
});

test('a corrupt product record counts as a record: nothing is written over it', () => {
  const t = world();
  const ctx = { ...t.ctx, record: { ...t.record, read: () => ({ id: PRODUCT, entity: 'product', corrupt: true, reason: 'x' }), write: () => assert.fail('no write') } };
  assert.equal(onboard(ctx), null);
});

test('a refused write is reported as an event, not an onboard', () => {
  const t = world();
  const ctx = { ...t.ctx, record: { read: () => null, write: () => ({ ok: false, reason: 'rev moved' }) } };
  assert.deepEqual(onboard(ctx), { type: 'onboard_refused', product: PRODUCT, reason: 'rev moved' });
});

test('a bad approvals config stops the pass before any record is made', async () => {
  const t = world({ ...ON, 'approvals.push_windows': 'noon' });
  const r = await schedulePass(t.ctx);
  assert.equal(r.ok, false);
  assert.equal(t.record.read('product', PRODUCT), null);
});

test('on M10\'s real engine, rules kept from the last good file with the key make the record', async () => {
  const pol = parsePolicy(FIRST);
  assert.ok(pol.ok, pol.reason);
  for (const status of ['last_good', 'ok']) {
    const t = world();
    const rules = makeRules(makeEngine({
      products: [PRODUCT],
      rulesState: () => ({ status, policy: pol.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
      productState: () => null, running: () => 0,
      rolesDir: new URL('../M10-rules/roles', import.meta.url).pathname,
      clock: () => t.clock.t,
    }));
    assert.equal(rules.get(ONBOARD_KEY, { product: PRODUCT }), 'active', status);
    assert.deepEqual(onboard({ ...t.ctx, rules }), { type: 'onboarded', product: PRODUCT }, status);
    assert.equal(t.record.read('product', PRODUCT).doc.state, 'active', status);
  }
  // Rules the engine can't use (deny_all, none) give nothing, so nothing is made.
  for (const state of [null, { status: 'deny_all' }]) {
    const t = world();
    const rules = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => state, productState: () => null, running: () => 0,
      rolesDir: new URL('../M10-rules/roles', import.meta.url).pathname, clock: () => t.clock.t }));
    assert.equal(onboard({ ...t.ctx, rules }), null);
    assert.equal(t.record.read('product', PRODUCT), null);
  }
});

// L295 MAT-1(b): the "tell Joe" mark is saved before the product is written. A folder it can't be saved in stops the
// create, so no product is ever on with no mark to tell it; the pass throws and the Dispatcher's step alert says so.
test('L295 MAT-1: a due mark that cannot be saved stops the create: the pass throws and no record is made', async () => {
  const t = world();
  mkdirSync(dirname(t.ctx.stateDir), { recursive: true });
  writeFileSync(t.ctx.stateDir, 'a file where the folder should be');
  await assert.rejects(() => schedulePass(t.ctx));
  assert.equal(t.record.read('product', PRODUCT), null, 'not turned on');
  assert.equal(onboards(t).length, 0);
  assert.equal(told(t, 'product_on').length, 0);
});

test('L295 MAT-1: the due mark is on disk before the record is written, and the notice goes out after', async () => {
  const t = world();
  const rec = t.record;
  let markAtWrite = null;
  t.ctx.record = { ...rec, write: (w) => {
    if (w.entity === 'product') markAtWrite = JSON.parse(readFileSync(join(t.ctx.stateDir, 'onboard-notices.json'), 'utf8')).due;
    return rec.write(w);
  } };
  await schedulePass(t.ctx);
  assert.ok(markAtWrite && Number.isSafeInteger(markAtWrite.after), JSON.stringify(markAtWrite));
  assert.equal(told(t, 'product_on').length, 1);
  assert.equal(JSON.parse(readFileSync(join(t.ctx.stateDir, 'onboard-notices.json'), 'utf8')).due, false, 'cleared once told');
});

// L295 Minor 3: a mark left in an old folder never re-tells a product that has long been on.
test('L295 Minor 3: an old due mark for a product long on is cleared without telling Joe again', async () => {
  // A mark of today's shape whose diary line is not there, or has another time, is another Record's (L309: it is
  // matched by the Record's own line, never by a clock). 'just-before' is a mark naming the line right before this
  // product's onboard line, but with another time: the case only the Record's own time tells apart. (A mark of any
  // other shape is not sure, so it tells: the L331 Minor 1 test below.)
  for (let stale of ['just-before', { after: 10_000, ts: '2026-01-01T00:00:00.000Z' }]) {
    const t = world();
    must(createAsk(t.ctx, { id: 'Q-1', kind: 'tap_yes_no', card: 'C-1', title: 'A line before the create' }));
    await schedulePass(t.ctx);
    if (stale === 'just-before') { const s = onboards(t)[0].seq; assert.ok(s >= 2); stale = { after: s - 1, ts: '2020-01-01T00:00:00.000Z' }; }
    assert.equal(told(t, 'product_on').length, 1);
    writeFileSync(join(t.ctx.stateDir, 'onboard-notices.json'), JSON.stringify({ seen: [], due: stale }));
    await schedulePass(t.ctx);
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 1, `not told again: ${JSON.stringify(stale)}`);
    assert.equal(JSON.parse(readFileSync(join(t.ctx.stateDir, 'onboard-notices.json'), 'utf8')).due, false, 'cleared');
  }
});

// L331 Minor 1: a notices file that parses but whose mark has the wrong shape, or no file at all, can't say whether
// "is now on" went out, so it is read as unsure, like an unreadable file: a product approvals turned on is told once
// more rather than never, and the file is then rewritten with nothing due. Before, these read as "nothing due".
test('L331 Minor 1: a due mark of the wrong shape, or a deleted notices file, tells "is now on" once', async () => {
  const file = (t) => join(t.ctx.stateDir, 'onboard-notices.json');
  for (const bad of [{ after: '3' }, null, [], true, { after: 0, at: Date.parse('2020-01-01T00:00:00Z') }, 'deleted']) {
    const t = world();
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 1);
    if (bad === 'deleted') rmSync(file(t));
    else writeFileSync(file(t), JSON.stringify({ seen: [], due: bad }));
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 2, `told once more: ${JSON.stringify(bad)}`);
    assert.equal(JSON.parse(readFileSync(file(t), 'utf8')).due, false, 'rewritten with nothing due');
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 2, 'and not again');
  }
  // Nothing due, written as false, stays quiet; and a product approvals did not turn on is never told.
  const q = world();
  await schedulePass(q.ctx);
  writeFileSync(file(q), JSON.stringify({ seen: [], due: false }));
  await schedulePass(q.ctx);
  assert.equal(told(q, 'product_on').length, 1, 'false is nothing due');
});

// L309 MAT-1: the mark is the Record's own (a diary line's number and time), so a pass whose clock is far from the
// Record's (a slow rules fetch, the Mac asleep mid-pass) still tells "is now on", once. Before, a gap over 10 minutes
// between the tick's start and the Record's time turned the product on and dropped the mark unsent.
test('L309 MAT-1: a tick clock 11 minutes or 2 hours away from the Record\'s still tells "is now on", once', async () => {
  for (const gap of [11 * 60_000, 2 * 60 * 60_000, -2 * 60 * 60_000]) {
    const t = world();
    t.ctx.now = () => t.clock.t - gap;
    await schedulePass(t.ctx);
    assert.equal(t.record.read('product', PRODUCT).doc.state, 'active');
    assert.equal(told(t, 'product_on').length, 1, `told once with a gap of ${gap / 60_000} min`);
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 1, 'not again');
  }
});

// L309 MAT-1, the crash between the record and the notice: the sink refused, the clocks are hours apart, and the next
// pass still tells once.
test('L309 MAT-1: a notice the sink refused goes out on a later pass, however far apart the clocks', async () => {
  const t = world();
  t.ctx.now = () => t.clock.t - 3 * 60 * 60_000;
  t.sink.answer = false;
  await schedulePass(t.ctx);
  assert.equal(told(t, 'product_on').length, 0);
  t.sink.answer = true;
  await schedulePass(t.ctx);
  await schedulePass(t.ctx);
  assert.equal(told(t, 'product_on').length, 1);
});

// L309 Minor 3: a notices file that can't be read or parsed counts as "tell" for a product approvals turned on; it is
// replaced whole by a readable one, so it is told once, not every pass.
test('L309 Minor 3: an unreadable or corrupt notices file tells "is now on" rather than never', async () => {
  for (const how of ['corrupt', 'unreadable']) {
    const t = world();
    t.sink.answer = false;
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 0, 'made, not yet told');
    const f = join(t.ctx.stateDir, 'onboard-notices.json');
    if (how === 'corrupt') writeFileSync(f, '{ not json');
    else chmodSync(f, 0o200);
    t.sink.answer = true;
    await schedulePass(t.ctx);
    await schedulePass(t.ctx);
    assert.equal(told(t, 'product_on').length, 1, how);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).due, false, `${how}: replaced by a readable file`);
  }
  // A product approvals never made is not told on an unreadable file.
  const t = world();
  must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'paused' } }), 'product');
  mkdirSync(t.ctx.stateDir, { recursive: true });
  writeFileSync(join(t.ctx.stateDir, 'onboard-notices.json'), '{ not json');
  await schedulePass(t.ctx);
  assert.equal(told(t, 'product_on').length, 0);
});

// L315: a near-miss value never turns the product on, so it is told again each day while it stands; the mark goes once
// the product is on or the value changes. L317: a told time more than a minute ahead counts as not told.
test('L315: a near-miss value is told again each day while it stands, and its mark goes once the product is on', async () => {
  const H = 3600000;
  const t = world({ [ONBOARD_KEY]: 'Active' });
  const nm = () => told(t, 'onboard_near_miss').length;
  await schedulePass(t.ctx);
  assert.equal(nm(), 1);
  t.clock.t += 2 * H;
  await schedulePass(t.ctx);
  assert.equal(nm(), 1, '+2 h: quiet');
  t.clock.t += 23 * H;
  await schedulePass(t.ctx);
  assert.equal(nm(), 2, '+25 h: told again');
  await schedulePass(t.ctx);
  assert.equal(nm(), 2);
  // L317: a told time 30 days ahead (a clock set back) is not "told": Joe is told now, and the mark is set to now.
  const f = join(t.ctx.stateDir, 'onboard-notices.json');
  const n = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...n, near: { ...n.near, at: t.clock.t + 30 * 24 * H } }));
  await schedulePass(t.ctx);
  assert.equal(nm(), 3, 'a told time 30 days ahead: told now');
  await schedulePass(t.ctx);
  assert.equal(nm(), 3);
  // Fixed to active: the product turns on and the near-miss mark goes.
  t.ctx.rules = rulesOf(t, ON);
  await schedulePass(t.ctx);
  assert.equal(t.record.read('product', PRODUCT).doc.state, 'active');
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).near, null);
});

// L340 Minor 1 (L323): once "is now on" is told, its mark is cleared by writing false. A write that fails then is never
// silent: the pass rejects, so the step's failure alert tells Joe. The mark stays due, so the next pass that can write
// tells once more and clears it (told twice rather than a failure nobody hears of).
test('L340 Minor 1: a state folder made read-only after the turn-on fails the pass that clears the mark', async () => {
  const t = world();
  t.sink.answer = false;
  await schedulePass(t.ctx);
  assert.equal(t.record.read('product', PRODUCT).doc.state, 'active');
  assert.equal(told(t, 'product_on').length, 0, 'made, not yet told');
  t.sink.answer = true;
  chmodSync(t.ctx.stateDir, 0o500);
  try {
    await assert.rejects(schedulePass(t.ctx), /EACCES|EPERM/);
    assert.equal(told(t, 'product_on').length, 1, 'told, then the clear failed');
  } finally { chmodSync(t.ctx.stateDir, 0o700); }
  await schedulePass(t.ctx);
  await schedulePass(t.ctx);
  assert.equal(told(t, 'product_on').length, 2, 'the mark stayed due: told once more, then cleared');
  assert.equal(JSON.parse(readFileSync(join(t.ctx.stateDir, 'onboard-notices.json'), 'utf8')).due, false);
});
