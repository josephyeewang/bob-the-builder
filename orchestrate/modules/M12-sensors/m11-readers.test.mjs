// R-0b-168: every fact the Dispatcher (M11) reads is written by a real Sensors writer, and M11's own readers decide
// on what that writer stored. No fact here is seeded by hand: each goes through the writer, the allow-list and the
// masking into the real record (shared/record.mjs), and M11's code reads it back. The only fakes are the outside
// world (GitHub, the usage screen, the network probe), which is what a port is for.
//
// The list of families M11 reads: until lane 2's READ_FACTS (M11 read-facts.mjs) is on main, it is M11's README fact
// table, rows written by M12. When read-facts.mjs exists, the list comes from it and a test checks the table agrees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from './facts.mjs';
import { writePrFact } from './pr-facts.mjs';
import { writeUsageFact, writeSignedInAccount, writeReading, writeLimitHit, WRITERS } from './state-facts.mjs';
import { UNKNOWN, WRONG } from './fact-shapes.mjs';
import { timeLimits, PR_FACT } from '../M11-dispatcher/merges.mjs';
import { readFact, USAGE_FACT, currentBands } from '../M11-dispatcher/usage.mjs';
import { signedInAccount, ACCOUNT_FACT } from '../M11-dispatcher/tick.mjs';
import { phoneLinkStep, FACTS } from '../M11-dispatcher/phone-link.mjs';
import { dispatcherPass, LIMIT_FACT } from '../M11-dispatcher/pass.mjs';
import { rulesWith, withAlerts, T0, MIN, D, iso } from '../M11-dispatcher/fixtures.test-helper.mjs';

const M11 = new URL('../M11-dispatcher/', import.meta.url);
const ACCT = 'acct-a';
const clockAt = (ms) => () => new Date(ms);

// ---- the list: M11's README fact table (rows written by M12), parsed, never copied ----

// '{ a, b: {c, d}, e: true / false }' → ['a', 'b.c', 'b.d', 'e']
export function fieldPaths(shape) {
  const toks = shape.replace(/`/g, '').match(/"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|[{}:,/]/g) ?? [];
  const out = []; const stack = []; let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '{') { depth += 1; continue; }
    if (t === '}') { if (stack.length && stack.at(-1).depth === depth) stack.pop(); depth -= 1; continue; }
    if (!/^[A-Za-z_]/.test(t) || t === ',') continue;
    const path = [...stack.map((s) => s.name), t].join('.');
    if (toks[i + 1] === ':' && toks[i + 2] === '{') { stack.push({ name: t, depth: depth + 1 }); i += 1; continue; }
    out.push(path);
    if (toks[i + 1] === ':') { while (i + 1 < toks.length && toks[i + 1] !== ',' && toks[i + 1] !== '}') i += 1; }
  }
  return out;
}

export function readmeFamilies(text = readFileSync(new URL('README.md', M11), 'utf8')) {
  const rows = text.split('\n').filter((l) => /^\| `/.test(l));
  const out = new Map();
  for (const row of rows) {
    const [ids, writer, shape] = row.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, ''));
    if (!/^M12\b/.test(writer ?? '')) continue;
    for (const [, id] of ids.matchAll(/`([^`]+)`/g)) out.set(id.replace(/<[^>]+>$/, ''), fieldPaths(shape ?? ''));
  }
  return out;
}

const READ_FACTS_FILE = new URL('read-facts.mjs', M11);
const readFactsList = async () => (existsSync(fileURLToPath(READ_FACTS_FILE)) ? (await import(READ_FACTS_FILE.href)).READ_FACTS : null);
async function theList() {
  const rf = await readFactsList();
  return rf ? new Map(rf.map((e) => [e.family, [...e.fields]])) : readmeFamilies();
}

// The families M11's code reads from the Sensors, through its own exported ids (a family M11 adds without listing it
// shows here first, because it has to name the fact to read it).
const CODE_FAMILIES = [PR_FACT(''), USAGE_FACT(''), ACCOUNT_FACT, ...Object.values(FACTS), LIMIT_FACT('')].sort();

test('R-0b-168 coverage: the list, the families M11 reads and the Sensors writers are the same set', async () => {
  const list = [...(await theList()).keys()].sort();
  assert.deepEqual(list, CODE_FAMILIES, 'M11 reads a family the list lacks, or the list names one M11 does not read');
  assert.deepEqual(Object.keys(WRITERS).sort(), list, 'a family on the list has no writer, or a writer has no family');
});

test('R-0b-168: once M11 exports READ_FACTS, its README fact table names the same families and fields', async (t) => {
  const rf = await readFactsList();
  if (!rf) { t.skip('M11 read-facts.mjs is not on this branch yet (lane 2, #68)'); return; }
  const table = readmeFamilies();
  for (const e of rf) assert.deepEqual([...(table.get(e.family) ?? [])].sort(), [...e.fields].sort(), `${e.family}: README and READ_FACTS differ`);
  assert.deepEqual([...table.keys()].sort(), rf.map((e) => e.family).sort());
});

test('the README parser reads nested and value shapes', () => {
  assert.deepEqual(fieldPaths('`{ account, observed_at, source, week: {used_pct, resets_at}, h5: {used_pct, resets_at} }`'),
    ['account', 'observed_at', 'source', 'week.used_pct', 'week.resets_at', 'h5.used_pct', 'h5.resets_at']);
  assert.deepEqual(fieldPaths('`{ value: true / false / "unknown", observed_at }`'), ['value', 'observed_at']);
});

// ---- the real writers into the real record ----

const gh = (over = {}) => ({
  pr: async (n) => ({ number: n, title: 'Fix', head_sha: 'a'.repeat(40), base_ref: 'main', head_ref: 'robot/C-1', author: 'robot',
    state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), ...over }),
  files: async () => [], checks: async () => [], threads: async () => [], behindBy: async () => 0,
});
const usageReading = (now) => ({ source: 'status-line', h5: { used_pct: 20, resets_at: iso(now + 60 * MIN) }, week: { used_pct: 30, resets_at: iso(now + 3 * D) } });

async function writeAll(rec, at) {
  const w = makeFactWriter(rec, { now: clockAt(at) });
  const out = {
    'pr-': await writePrFact(w, gh(), 7, { now: clockAt(at) }),
    'usage-': await writeUsageFact(w, async () => usageReading(at), ACCT, { now: clockAt(at) }),
    'signed-in-account': await writeSignedInAccount(w, async () => ACCT, { now: clockAt(at) }),
    'network-up': await writeReading(w, 'network', async () => true, { now: clockAt(at) }),
    'frontdoor-reachable': await writeReading(w, 'reachable', async () => true, { now: clockAt(at) }),
    'minibase-running': await writeReading(w, 'minibase', async () => true, { now: clockAt(at) }),
    'limit-hit-': await writeLimitHit(w, { account: ACCT, resets_at: iso(at + 30 * MIN), source: 'worker-exit' }, { now: clockAt(at) }),
  };
  return out;
}
const idFor = { 'pr-': PR_FACT(7), 'usage-': USAGE_FACT(ACCT), 'limit-hit-': LIMIT_FACT(ACCT) };
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);

test('R-0b-168: each family\'s writer stores every field the list names, none masked', async () => {
  const rec = memoryRecord();
  const results = await writeAll(rec, T0);
  for (const [family, fields] of await theList()) {
    assert.equal(results[family]?.ok, true, `${family}: the write failed: ${results[family]?.reason}`);
    const doc = rec.read('fact', idFor[family] ?? family)?.doc;
    for (const f of fields) {
      const v = get(doc, f);
      assert.ok(v !== undefined && v !== UNKNOWN && v !== WRONG, `${family}: ${f} is ${JSON.stringify(v)}`);
    }
    assert.equal(rec.diary().filter((e) => e.id === (idFor[family] ?? family)).at(-1).actor, 'sensors');
  }
});

test('R-0b-168 merges: a merge interrupted at minute 0 is recorded merged from the real PR fact read after it', async () => {
  const rec = memoryRecord();
  const put = (entity, id, doc) => assert.equal(rec.write({ actor: 'dispatcher', entity, id, expectRev: 0, doc }).ok, true);
  put('card', 'C-1', { state: 'merging', module: 'M-test' });
  put('merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', head_sha: 'a'.repeat(40), changed_at: iso(T0) });
  const ports = { hasSession: () => false, gateAlive: () => false, hasReviewer: () => true, requestReview: () => ({ ok: true }), alert: () => {} };
  const pass = (min) => timeLimits({ rec, rules: rulesWith(), now: T0 + min * MIN, b: { band: 'green', own_building: 'open', prodBlocked: false }, ...ports });
  // A reading from before the attempt's last change is not fresh: M11 waits.
  await writePrFact(makeFactWriter(rec), gh(), 7, { now: clockAt(T0 - MIN) });
  assert.deepEqual(await pass(1), [['M-1', 'waiting for a fresh PR reading']]);
  // The same PR read after the change: merged, with the merge commit.
  await writePrFact(makeFactWriter(rec), gh(), 7, { now: clockAt(T0 + 2 * MIN) });
  await pass(3);
  const m = rec.read('merge', 'M-1').doc;
  assert.deepEqual([m.state, m.merge_commit_sha], ['merged', 'c'.repeat(40)]);
});

test('R-0b-168 merges: an open PR is stored as not merged with no merge commit, so the interrupted merge is refused', async () => {
  const rec = memoryRecord();
  await writePrFact(makeFactWriter(rec), gh({ state: 'open', merged: false, merge_commit_sha: 'd'.repeat(40) }), 7, { now: clockAt(T0) });
  const d = rec.read('fact', PR_FACT(7)).doc;
  assert.deepEqual([d.state, d.merged, d.merge_commit_sha], ['open', false, null]);
  await writePrFact(makeFactWriter(rec), gh({ merged: 'true' }), 8, { now: clockAt(T0) });
  assert.equal(rec.read('fact', PR_FACT(8)).doc.merged, false, 'only a literal true is merged');
});

test('R-0b-168: observed_at is taken after the reads return, not before', async () => {
  let t = T0;
  const slow = gh();
  const late = { ...slow, checks: async () => { t += 5 * MIN; return []; } };
  const rec = memoryRecord();
  await writePrFact(makeFactWriter(rec), late, 7, { now: () => new Date(t) });
  assert.equal(rec.read('fact', PR_FACT(7)).doc.observed_at, iso(T0 + 5 * MIN));
  t = T0;
  await writeReading(makeFactWriter(rec), 'network', async () => { t += 2 * MIN; return true; }, { now: () => new Date(t) });
  assert.equal(rec.read('fact', FACTS.network).doc.observed_at, iso(T0 + 2 * MIN));
  t = T0;
  await writeUsageFact(makeFactWriter(rec), async () => { t += MIN; return usageReading(T0); }, ACCT, { now: () => new Date(t) });
  assert.equal(rec.read('fact', USAGE_FACT(ACCT)).doc.observed_at, iso(T0 + MIN));
});

test('R-0b-168 usage and account: M11 reads the real usage and signed-in facts as a good reading and green bands', async () => {
  const rec = memoryRecord();
  await writeAll(rec, T0);
  const rules = rulesWith();
  assert.deepEqual(signedInAccount({ rec, rules, now: T0 + MIN }), { account: ACCT, reason: null });
  const r = readFact(rec.read('fact', USAGE_FACT(ACCT)), { account: ACCT, now: T0 + MIN, staleMs: 15 * MIN });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([r.h5, r.week], [20, 30]);
  assert.equal(currentBands({ rec, rules, account: ACCT, now: T0 + MIN }).band, 'green');
  // Stale once the rules' stale_after has passed since the writer's observed_at.
  assert.equal(signedInAccount({ rec, rules, now: T0 + 16 * MIN }).account, null);
});

test('R-0b-168 phone link: M11 reads the real readings: down stops, unknown stops, Mini Base off is started', async () => {
  const step = async (rec, min, calls) => withAlerts(rec, T0 + min * MIN, () => {}, (alert) => phoneLinkStep({ rec, rules: rulesWith(), now: T0 + min * MIN,
    send: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => { calls.minibase += 1; return { ok: true }; }, alert }));
  const read = async (rec, min, { net = true, fd = true, mb = true }) => {
    const w = makeFactWriter(rec, { now: clockAt(T0 + min * MIN) });
    await writeReading(w, 'network', async () => net, { now: clockAt(T0 + min * MIN) });
    await writeReading(w, 'reachable', async () => fd, { now: clockAt(T0 + min * MIN) });
    await writeReading(w, 'minibase', async () => mb, { now: clockAt(T0 + min * MIN) });
  };
  const calls = { minibase: 0 };
  const a = memoryRecord();
  await read(a, 0, { net: false });
  assert.deepEqual(await step(a, 1, calls), ['network down: nothing done']);
  const b = memoryRecord();
  await read(b, 0, { net: null });
  assert.deepEqual(await step(b, 1, calls), ['network unknown: nothing done']);
  // A reading older than 5 minutes is unknown too.
  const c = memoryRecord();
  await read(c, 0, {});
  assert.deepEqual(await step(c, 6, calls), ['network unknown: nothing done']);
  const d = memoryRecord();
  await read(d, 0, { mb: false });
  const out = await step(d, 1, calls);
  assert.equal(calls.minibase, 1);
  assert.ok(out.includes('Mini Base started'), JSON.stringify(out));
});

test('R-0b-168 limit hit: a Tier-2 card parked on a limit hit resumes only after the real fact\'s reset time', async () => {
  const rec = memoryRecord();
  const put = (entity, id, doc) => assert.equal(rec.write({ actor: 'dispatcher', entity, id, expectRev: 0, doc }).ok, true);
  put('product', 'p1', { state: 'active' });
  put('card', 'T2', { state: 'waiting', module: 'M-test', product: 'p1', tier: 2, account: ACCT, files: ['src/t2.js'],
    waiting: { who: 'dispatcher', what: 'limit_hit', since: iso(T0), next_check: iso(T0) } });
  await writeLimitHit(makeFactWriter(rec), { account: ACCT, resets_at: iso(T0 + 30 * MIN), source: 'worker-exit' }, { now: clockAt(T0) });
  const rules = rulesWith({}, { start_session: () => ({ decision: 'deny', reason: 'this test starts nothing' }) });
  const pass = async (min) => {
    const now = T0 + min * MIN;
    await writeUsageFact(makeFactWriter(rec), async () => usageReading(now), ACCT, { now: clockAt(now) });
    return withAlerts(rec, now, () => {}, (alert) => dispatcherPass({ rec, rules, now, account: ACCT, sessions: [], probe: () => null,
      launch: async () => ({ ok: false, reason: 'no starts here' }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
      filesOf: () => [], alert }));
  };
  await pass(10);
  assert.equal(rec.read('card', 'T2').doc.state, 'waiting');
  await pass(31);
  assert.equal(rec.read('card', 'T2').doc.state, 'ready');
});

test('R-0b-168: the writers refuse what M11 must not decide on', async () => {
  const rec = memoryRecord();
  const w = makeFactWriter(rec);
  assert.equal((await writeLimitHit(w, { account: ACCT })).ok, false, 'no reset time, no fact');
  assert.equal(rec.read('fact', LIMIT_FACT(ACCT)), null);
  assert.equal((await writeUsageFact(w, async () => null, ACCT)).ok, false);
  await writeSignedInAccount(w, async () => '');
  assert.equal(rec.read('fact', ACCOUNT_FACT).doc.account, null);
  await assert.rejects(() => writeReading(w, 'wifi', async () => true), /no reading called wifi/);
});
