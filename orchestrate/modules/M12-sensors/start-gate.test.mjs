import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeMasker } from './mask.mjs';
import { readStartGate, startGateOpen, envInBoth, SKIP_FACT, ENV_FACT, START_GATE_FRESH_MIN } from './start-gate.mjs';

const PINNED = 'node scripts/skip-build.mjs';
const T0 = Date.parse('2026-10-29T18:00:00Z');
const fakeVercel = ({ cmd = PINNED, envs = [{ key: 'API_URL', target: ['production'] }, { key: 'API_URL_PREVIEW', target: ['preview'] }], fail = {} } = {}) => ({
  async settings() { if (fail.settings) throw new Error('x'); return { commandForIgnoringBuildStep: cmd }; },
  async envMeta() { if (fail.env) throw new Error('x'); return envs; },
});
const setup = () => { const rec = memoryRecord(); return { rec, writer: makeFactWriter(rec, { masker: makeMasker({ env: {} }) }), read: (id) => rec.read('fact', id)?.doc }; };
const pass = async (o, extra = {}) => {
  const s = setup();
  const r = await readStartGate({ product: 'test-product', vercel: fakeVercel(o), writer: s.writer, pinnedSkip: PINNED, vercelProject: 'prj_test', now: () => new Date(T0), ...extra });
  return { ...s, r };
};

test('L3: a matching skip command and no shared env names → both facts ok, gate open while fresh', async () => {
  const { r, read } = await pass();
  assert.equal(r.written, true);
  assert.equal(read(SKIP_FACT('test-product')).result, true);
  assert.equal(read(ENV_FACT('test-product')).result, true);
  assert.deepEqual(startGateOpen({ read, product: 'test-product', now: () => T0 + 60_000 }), { open: true, problems: [] });
  assert.ok(!JSON.stringify(read(SKIP_FACT('test-product'))).includes(PINNED), 'only hashes of the command are stored');
});

test('L3 planted: a changed or missing skip command, or no pinned one → gate shut', async () => {
  for (const [o, extra, why] of [[{ cmd: 'exit 1' }, {}, /differs from pinned/], [{ cmd: null }, {}, /no skip command set/], [{}, { pinnedSkip: undefined }, /no pinned skip/]]) {
    const { read } = await pass(o, extra);
    const g = startGateOpen({ read, product: 'test-product', now: () => T0 });
    assert.equal(g.open, false); assert.match(g.problems.join(), why);
  }
});

test('L3 planted: a name set in both Preview and Production (one entry or two) → gate shut, names listed', async () => {
  assert.deepEqual(envInBoth([{ key: 'A', target: ['preview', 'production'] }, { key: 'B', target: ['production'] }, { key: 'B', target: ['Preview'] }, { key: 'C', target: ['development', 'preview'] }]), ['A', 'B']);
  const { read } = await pass({ envs: [{ key: 'DB_URL', target: ['production', 'preview'] }] });
  assert.deepEqual(read(ENV_FACT('test-product')).both, ['DB_URL']);
  assert.match(startGateOpen({ read, product: 'test-product', now: () => T0 }).problems.join(), /1 set in both/);
});

test('L3 planted: a failed read overwrites an old ok with ok:false; stale, future-dated or missing facts shut the gate', async () => {
  const s = setup();
  const base = { product: 'test-product', writer: s.writer, pinnedSkip: PINNED, vercelProject: 'prj_test' };
  await readStartGate({ ...base, vercel: fakeVercel(), now: () => new Date(T0) });
  await readStartGate({ ...base, vercel: fakeVercel({ fail: { settings: true, env: true } }), now: () => new Date(T0 + 1000) });
  const g = startGateOpen({ read: s.read, product: 'test-product', now: () => T0 + 2000 });
  assert.equal(g.open, false); assert.match(g.problems.join(), /could not read the Vercel project settings/); assert.match(g.problems.join(), /could not read the Vercel env list/);
  await readStartGate({ ...base, vercel: fakeVercel({ envs: [{ key: 'X' }] }), now: () => new Date(T0) });
  assert.match(startGateOpen({ read: s.read, product: 'test-product', now: () => T0 }).problems.join(), /unknown shape/);
  const fresh = await pass();
  assert.match(startGateOpen({ read: fresh.read, product: 'test-product', now: () => T0 + (START_GATE_FRESH_MIN + 1) * 60_000 }).problems.join(), /older than 10 min/);
  assert.match(startGateOpen({ read: fresh.read, product: 'test-product', now: () => T0 - 3600_000 }).problems.join(), /in the future/);
  assert.match(startGateOpen({ read: fresh.read, product: 'other', now: () => T0 }).problems.join(), /no fact yet/);
  assert.equal(startGateOpen({ read: () => { throw new Error('x'); }, product: 'test-product' }).open, false);
});

test('lane 2 contract: ids and fields match M4\'s reader; no Vercel project in the rules entry → result false', async () => {
  const { read } = await pass();
  const d = read('start_gate.vercel_skip.test-product');
  assert.equal(d.product, 'test-product'); assert.equal(d.vercel_project, 'prj_test');
  assert.equal(d.read_at, new Date(T0).toISOString()); assert.equal(d.result, true);
  assert.equal(read('start_gate.vercel_env.test-product').result, true);
  assert.match(startGateOpen({ read, product: 'test-product', vercelProject: 'prj_other', now: () => T0 }).problems.join(), /another Vercel project/);
  assert.match(startGateOpen({ read, product: 'test-product', now: () => T0 + 11 * 60_000 }).problems.join(), /older than 10 min/);
  const none = await pass({}, { vercelProject: undefined });
  assert.equal(none.read(SKIP_FACT('test-product')).result, false);
  assert.equal(none.read(ENV_FACT('test-product')).reason, 'no Vercel project in the rules entry');
  assert.equal(START_GATE_FRESH_MIN, 10);
});
