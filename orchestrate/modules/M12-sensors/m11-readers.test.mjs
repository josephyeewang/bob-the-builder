// R-0b-168: every fact the Dispatcher (M11) reads is written by a real Sensors writer, and M11's own readers decide
// on what that writer stored. No fact here is seeded by hand: each goes through the writer, the allow-list and the
// masking into the guarded record (shared/record.mjs memoryRecord, which runs M9's guardWrite and claimCheck), and once
// into the on-disk Record (M9 openRecord). Cards, merges and waits are staged the way the real Record lets them be made
// (M11's recWith / seed / change: each step by the script M9 allows; L97 M-1). The only fakes are the outside world
// (GitHub, the usage screen, the probes), which is what a port is for.
//
// The list of families M11 reads is M11's READ_FACTS (read-facts.mjs). M11's own read-facts.test fails when M11 reads
// a family that list lacks (L110 m-7); here WRITERS must equal it both ways, and each writer must store every field it
// names (L97 M-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFactWriter } from './facts.mjs';
import { writePrFact } from './pr-facts.mjs';
import { writeUsageFact, writeSignedInAccount, writeReading, writeLimitHit, WRITERS, accountOk } from './state-facts.mjs';
import { UNKNOWN, WRONG } from './fact-shapes.mjs';
import { READ_FACTS } from '../M11-dispatcher/read-facts.mjs';
import { timeLimits, PR_FACT } from '../M11-dispatcher/merges.mjs';
import { readFact, USAGE_FACT, currentBands } from '../M11-dispatcher/usage.mjs';
import { signedInAccount, ACCOUNT_FACT } from '../M11-dispatcher/tick.mjs';
import { phoneLinkStep, FACTS } from '../M11-dispatcher/phone-link.mjs';
import { dispatcherPass, LIMIT_FACT } from '../M11-dispatcher/pass.mjs';
import { rulesWith, recWith, setClock, withAlerts, T0, MIN, D, iso } from '../M11-dispatcher/fixtures.test-helper.mjs';
import { setup as m9Setup } from '../M9-record/fixtures.test-helper.mjs';
import { factFamilyOf } from '../M9-record/permissions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCT = 'a';
const clockAt = (ms) => () => new Date(ms);
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const inFamily = (id, family) => (family.endsWith('-') ? id.startsWith(family) : id === family);

const gh = (over = {}) => ({
  pr: async (n) => ({ number: n, title: 'Fix', head_sha: 'a'.repeat(40), base_ref: 'main', head_ref: 'robot/C-1', author: 'robot',
    state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), ...over }),
  files: async () => [], checks: async () => [], threads: async () => [], behindBy: async () => 0,
});
// Values above 1 (L97 m-3): a writer that stored a fraction would be caught for the right reason.
const usageReading = (now) => ({ source: 'status-line', h5: { used_pct: 20, resets_at: iso(now + 60 * MIN) }, week: { used_pct: 30, resets_at: iso(now + 3 * D) } });

// The port and options each family's writer is called with (WRITERS[family](writer, port, opts)).
const PORTS = {
  'pr-': (at) => [gh(), { number: 7, now: clockAt(at) }],
  'usage-': (at) => [async () => usageReading(at), { account: ACCT, now: clockAt(at) }],
  'signed-in-account': (at) => [async () => ACCT, { now: clockAt(at) }],
  'network-up': (at) => [async () => true, { now: clockAt(at) }],
  'frontdoor-reachable': (at) => [async () => true, { now: clockAt(at) }],
  'minibase-running': (at) => [async () => true, { now: clockAt(at) }],
  'limit-hit-': (at) => [{ account: ACCT, resets_at: iso(at + 30 * MIN), source: 'worker-exit' }, { now: clockAt(at) }],
};
// Writes one family through WRITERS into rec; returns [result, id written].
// The id is found among the record's facts (one per family in these tests), so a writer that wrote another family's id
// leaves its own family empty.
async function writeFamily(rec, family, at) {
  const r = await WRITERS[family](makeFactWriter(rec, { now: clockAt(at) }), ...PORTS[family](at));
  const ids = rec.list('fact').map((f) => f.id).filter((id) => inFamily(id, family));
  return [r, ids.length === 1 ? ids[0] : null];
}

// ---- coverage (L97 M-4, m-4) ----

test('R-0b-168 coverage: WRITERS and M11\'s READ_FACTS name the same families, and each writer is a function', () => {
  assert.deepEqual(Object.keys(WRITERS).sort(), READ_FACTS.map((f) => f.family).sort(), 'a family M11 reads has no writer, or a writer has no family');
  for (const [family, w] of Object.entries(WRITERS)) assert.equal(typeof w, 'function', `${family}: WRITERS holds the writer itself`);
  assert.deepEqual(Object.keys(PORTS).sort(), Object.keys(WRITERS).sort(), 'every writer is called below');
});

test('R-0b-168: each WRITERS entry writes its own family, with every field READ_FACTS names, none masked, as sensors', async () => {
  const rec = recWith();
  for (const { family, fields } of READ_FACTS) {
    const [r, id] = await writeFamily(rec, family, T0);
    assert.equal(r?.ok, true, `${family}: the write failed: ${r?.reason}`);
    assert.ok(id && inFamily(id, family), `${family}: its writer wrote ${id}`);
    assert.equal(factFamilyOf(id), 'sensors', `${id} is in the Sensors' family`);
    const doc = rec.read('fact', id)?.doc;
    for (const f of fields) {
      const v = get(doc, f);
      assert.ok(v !== undefined && v !== UNKNOWN && v !== WRONG, `${family}: ${f} is ${JSON.stringify(v)}`);
    }
    assert.equal(rec.diary().filter((e) => e.id === id).at(-1).actor, 'sensors');
  }
});

// ---- one writer per fact (L97 m-5) ----

// Every fact id and kind written in M12's code, by file and function: each READ_FACTS family's ids and its kind are
// written by exactly one function (a second writer, or a reading written under another family's id, fails here).
// Every code file under M12, in sub-folders too (#78 r2 m-2: probes/ arrives with R-0b-169), keyed by its path there.
// Test files and `fixtures/` folders (sample inputs for tests, which no module imports) are left out.
const CODE = readdirSync(HERE, { recursive: true }).map(String)
  .filter((f) => f.endsWith('.mjs') && !/\.test(-helper)?\.mjs$/.test(f) && !f.split(/[\\/]/).includes('fixtures')).sort();
const stripComments = (t) => t.split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
const ID_BUILDERS = { 'pr-': ['PR_FACT('], 'usage-': ['USAGE_FACT('], 'signed-in-account': ['ACCOUNT_FACT'], 'limit-hit-': ['LIMIT_FACT('],
  'network-up': ['FACTS.network', "FACTS['network']", 'FACTS[which]'], 'frontdoor-reachable': ['FACTS.reachable', "FACTS['reachable']", 'FACTS[which]'],
  'minibase-running': ['FACTS.minibase', "FACTS['minibase']", 'FACTS[which]'] };
export function writersOf(family, sources = Object.fromEntries(CODE.map((f) => [f, stripComments(readFileSync(join(HERE, f), 'utf8'))]))) {
  const out = new Set();
  for (const [file, text] of Object.entries(sources)) {
    for (const call of text.matchAll(/\.put\(\s*([^,]+),/g)) {
      const arg = call[1].trim();
      const lit = /^['"`]([^'"`$]*)/.exec(arg)?.[1];
      if ((lit !== undefined && lit !== '' && inFamily(lit, family)) || (lit === undefined && ID_BUILDERS[family].some((b) => arg.startsWith(b)))) out.add(`${file}:put(${arg})`);
    }
  }
  return [...out];
}
export function kindWriters(family, sources = Object.fromEntries(CODE.map((f) => [f, stripComments(readFileSync(join(HERE, f), 'utf8'))]))) {
  // The kind as a quoted string anywhere in the code (the readings spell theirs in VALUE_KINDS); fact-shapes.mjs only
  // declares the shapes, it writes nothing.
  // Any quote style (lane 3 review Minor 1): '…', "…" or `…`.
  const kind = `fact.${family.replace(/-$/, '')}`;
  return Object.entries(sources).filter(([file]) => file !== 'fact-shapes.mjs').flatMap(([file, text]) => [...text.matchAll(new RegExp(`(['"\`])${kind.replace(/\./g, '\\.')}\\1`, 'g'))].map(() => file));
}
// writersOf sees only `.put(` (lane 3 review Minor 2). A put reached another way (writer['put'](…), a destructured
// `{ put } = writer`, or `const p = writer.put`) would get past it, so M12's code may not use those forms at all.
const PUT_ALIAS = /\[\s*['"`]put['"`]\s*\]|\{[^{}]*\bput\b[^{}]*\}\s*=[^=>]|=\s*[\w.]+\.put\b(?!\s*\()/;
export const putAliases = (sources = Object.fromEntries(CODE.map((f) => [f, stripComments(readFileSync(join(HERE, f), 'utf8'))]))) =>
  Object.entries(sources).filter(([, text]) => PUT_ALIAS.test(text)).map(([file]) => file);
// A fact written straight into the record, past the fact writer (#78 r2 m-2, plant Q10): facts.mjs is the one file that
// calls the record's write() for facts. Elsewhere in M12, a `.write(` (or `['write']`) call whose arguments mention a
// fact in any form (entity 'fact', ACCOUNT_FACT, LIMIT_FACT(…), …) is refused; plain log writes stay allowed.
const FACT_WRITE = /\.write\(([^;]*)|\[\s*['"`]write['"`]\s*\]/g;
export const directFactWrites = (sources = Object.fromEntries(CODE.map((f) => [f, stripComments(readFileSync(join(HERE, f), 'utf8'))]))) =>
  Object.entries(sources).filter(([file]) => file !== 'facts.mjs')
    .filter(([, text]) => [...text.matchAll(FACT_WRITE)].some((m) => m[1] === undefined || /fact/i.test(m[1]))).map(([file]) => file);

test('L97 m-5: each fact M11 reads has exactly one writer in M12, under one kind', () => {
  for (const { family } of READ_FACTS) {
    assert.equal(writersOf(family).length, 1, `${family}: written by ${JSON.stringify(writersOf(family))}`);
    // The three readings share one put (FACTS[which]) and spell each kind out once in VALUE_KINDS.
    assert.equal(kindWriters(family).length, 1, `${family}: kind written in ${JSON.stringify(kindWriters(family))}`);
  }
  // The scan finds a second writer (plant P4) and a reading written under another's id (P4b).
  const src = Object.fromEntries(CODE.map((f) => [f, stripComments(readFileSync(join(HERE, f), 'utf8'))]));
  const p4 = { ...src, 'plant.mjs': "export const w = (writer) => writer.put(ACCOUNT_FACT, { kind: 'fact.signed-in-account', account: 'a' });" };
  assert.equal(writersOf('signed-in-account', p4).length, 2);
  assert.equal(kindWriters('signed-in-account', p4).length, 2);
  const p4b = { ...src, 'plant.mjs': "export const w = (writer) => writer.put('network-up', { kind: 'fact.power-source', at: 'x' });" };
  assert.equal(writersOf('network-up', p4b).length, 2);
  // The kind in double quotes or a template literal (lane 3 Minor 1).
  for (const q of ['"', '`']) {
    const p = { ...src, 'plant.mjs': `export const k = ${q}fact.signed-in-account${q};` };
    assert.equal(kindWriters('signed-in-account', p).length, 2, `kind in ${q} quotes`);
  }
  // No put reached past the scan (lane 3 Minor 2): none in M12 today, and each form is caught.
  assert.deepEqual(putAliases(), [], 'M12 reaches put a way writersOf cannot see');
  for (const plant of ["writer['put'](ACCOUNT_FACT, {});", 'const { put } = writer;', 'const { get, put: p } = writer;', 'const p = writer.put;']) {
    assert.deepEqual(putAliases({ ...src, 'plant.mjs': plant }), ['plant.mjs'], plant);
  }
  // #78 r2 m-2: the scan reads sub-folders (Q9), and a fact written past the fact writer is refused (Q10).
  assert.ok(CODE.includes('facts.mjs') && CODE.includes(join('shell-guard', 'runner.mjs')), JSON.stringify(CODE));
  const q9 = { ...src, [join('probes', 'signed.mjs')]: "export const w = (writer) => writer.put(ACCOUNT_FACT, { kind: 'fact.signed-in-account', account: 'a' });" };
  assert.equal(writersOf('signed-in-account', q9).length, 2, 'a second writer in a sub-folder');
  assert.deepEqual(directFactWrites(), [], 'M12 writes a fact past facts.mjs');
  for (const plant of ["export const w = (rec) => rec.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { kind: K } });",
    "rec.write({ actor: 'sensors', entity: E, id: LIMIT_FACT('a'), doc })", "rec['write']({ entity: 'fact' })"]) {
    assert.deepEqual(directFactWrites({ ...src, 'zz-second.mjs': plant }), ['zz-second.mjs'], plant);
  }
  assert.deepEqual(directFactWrites({ ...src, 'log.mjs': 'process.stderr.write(`sensors: ${p}\\n`);' }), [], 'a log line is not a fact');
});

// ---- the real writers into the real record ----

test('L97 M-1: through the on-disk Record, every family is written twice and the second write lands', async () => {
  const env = m9Setup({ prefix: 'm12-twice-' });
  for (const { family, fields } of READ_FACTS) {
    const [r1, id] = await writeFamily(env.record, family, T0);
    assert.equal(r1?.ok, true, `${family} first: ${r1?.reason}`);
    const [r2, id2] = await writeFamily(env.record, family, T0 + 5 * MIN);
    assert.equal(r2?.ok, true, `${family} second: ${r2?.reason}`);
    assert.equal(id2, id);
    const doc = env.record.read('fact', id).doc;
    assert.equal(doc.observed_at, iso(T0 + 5 * MIN), `${family}: the second reading is the one stored`);
    for (const f of fields) assert.notEqual(get(doc, f), undefined, `${family}: ${f}`);
  }
});

test('R-0b-168 merges: a merge interrupted at minute 0 is recorded merged from the real PR fact read after it', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'merging', product: 'p1', head: 'a'.repeat(40) }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', judged_head: 'a'.repeat(40), changed_at: iso(T0) }]]);
  const ports = { gateAlive: () => false, hasReviewer: () => true, requestReview: () => ({ ok: true }) };
  const pass = (min) => { const now = T0 + min * MIN; setClock(rec, now); return withAlerts(rec, now, () => true, (alert) => timeLimits({ rec, rules: rulesWith(), now, b: { band: 'green', own_building: 'open', prodBlocked: false }, ...ports, alert })); };
  // A reading from before the attempt's last change is not fresh: M11 waits.
  await writePrFact(makeFactWriter(rec), gh(), 7, { now: clockAt(T0 - MIN) });
  assert.deepEqual(await pass(1), [['M-1', 'waiting for a fresh PR reading']]);
  // The same PR read after the change: merged, with the merge commit.
  await writePrFact(makeFactWriter(rec), gh(), 7, { now: clockAt(T0 + 2 * MIN) });
  await pass(3);
  const m = rec.read('merge', 'M-1').doc;
  assert.deepEqual([m.state, m.merge_commit], ['merged', 'c'.repeat(40)]);
});

test('L97 M-2: a PR reading whose reads straddle a merge attempt is dated before it, so M11 waits, never refuses', async () => {
  // GitHub says "open" at T0; the attempt is written at T0+1; checks() returns at T0+3. Stamped after the reads, this
  // reading would look fresh and "open" (interrupted). Stamped before, it is older than the attempt: M11 waits.
  let t = T0;
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'merging', product: 'p1', head: 'a'.repeat(40) }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', judged_head: 'a'.repeat(40), changed_at: iso(T0 + MIN) }]]);
  const straddle = { ...gh({ state: 'open', merged: false }), checks: async () => { t = T0 + 3 * MIN; return []; } };
  await writePrFact(makeFactWriter(rec), straddle, 7, { now: () => new Date(t) });
  assert.equal(rec.read('fact', PR_FACT(7)).doc.observed_at, iso(T0), 'stamped when the reads began');
  setClock(rec, T0 + 4 * MIN);
  const moves = await withAlerts(rec, T0 + 4 * MIN, () => true, (alert) => timeLimits({ rec, rules: rulesWith(), now: T0 + 4 * MIN,
    b: { band: 'green', own_building: 'open', prodBlocked: false }, gateAlive: () => false, hasReviewer: () => true, requestReview: () => ({ ok: true }), alert }));
  assert.deepEqual(moves, [['M-1', 'waiting for a fresh PR reading']]);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'merging');
  // #78 r2 m-1 (plant Q2): the slow read is pr() itself, the one that carries the state. A stamp taken after pr()
  // answers, before checks(), is caught here.
  t = T0;
  const slowPr = { ...gh({ state: 'open', merged: false }), pr: async (n) => { const p = await gh({ state: 'open', merged: false }).pr(n); t = T0 + 3 * MIN; return p; } };
  await writePrFact(makeFactWriter(rec), slowPr, 7, { now: () => new Date(t) });
  assert.equal(rec.read('fact', PR_FACT(7)).doc.observed_at, iso(T0), 'stamped before pr() was called');
  // Every other writer stamps before its port too.
  const rec2 = recWith();
  for (const family of Object.keys(WRITERS).filter((f) => f !== 'pr-' && f !== 'limit-hit-')) {
    t = T0;
    const [port, opts] = PORTS[family](T0);
    const slow = async (...a) => { t = T0 + 2 * MIN; return port(...a); };
    await WRITERS[family](makeFactWriter(rec2), slow, { ...opts, now: () => new Date(t) });
  }
  for (const id of [USAGE_FACT(ACCT), ACCOUNT_FACT, FACTS.network, FACTS.reachable, FACTS.minibase]) assert.equal(rec2.read('fact', id).doc.observed_at, iso(T0), id);
});

test('R-0b-168 merges: an open PR is stored as not merged with no merge commit; state is open or closed, else null', async () => {
  const rec = recWith();
  await writePrFact(makeFactWriter(rec), gh({ state: 'open', merged: false, merge_commit_sha: 'd'.repeat(40) }), 7, { now: clockAt(T0) });
  const d = rec.read('fact', PR_FACT(7)).doc;
  assert.deepEqual([d.state, d.merged, d.merge_commit_sha], ['open', false, null]);
  await writePrFact(makeFactWriter(rec), gh({ merged: 'true' }), 8, { now: clockAt(T0) });
  assert.equal(rec.read('fact', PR_FACT(8)).doc.merged, false, 'only a literal true is merged');
  // L97 m-1 (plant P6): GitHub's other API says CLOSED / OPEN / MERGED.
  for (const [given, stored] of [['CLOSED', 'closed'], ['Open', 'open'], ['MERGED', null], ['', null], [7, null], [undefined, null]]) {
    await writePrFact(makeFactWriter(rec), gh({ state: given }), 9, { now: clockAt(T0) });
    assert.equal(rec.read('fact', PR_FACT(9)).doc.state, stored, String(given));
  }
});

test('R-0b-168 usage and account: M11 reads the real usage and signed-in facts as a good reading and green bands', async () => {
  const rec = recWith();
  for (const f of ['usage-', 'signed-in-account']) await writeFamily(rec, f, T0);
  const rules = rulesWith();
  assert.deepEqual(signedInAccount({ rec, rules, now: T0 + MIN }), { account: ACCT, reason: null });
  const r = readFact(rec.read('fact', USAGE_FACT(ACCT)), { account: ACCT, now: T0 + MIN, staleMs: 15 * MIN });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([r.h5, r.week], [20, 30]);
  assert.equal(currentBands({ rec, rules, account: ACCT, now: T0 + MIN }).band, 'green');
  // Stale once the rules' stale_after has passed since the writer's observed_at.
  assert.equal(signedInAccount({ rec, rules, now: T0 + 16 * MIN }).account, null);
});

test('L97 m-2: an account is one of M4\'s account names; anything else is stored as nobody, and usage is not written', async () => {
  const rec = recWith();
  for (const bad of ['account A', 'someone@example.com', 'band', '', null]) {
    await writeSignedInAccount(makeFactWriter(rec), async () => bad, { now: clockAt(T0) });
    assert.equal(rec.read('fact', ACCOUNT_FACT).doc.account, null, String(bad));
    assert.equal((await writeUsageFact(makeFactWriter(rec), async () => usageReading(T0), bad, { now: clockAt(T0) })).ok, false, String(bad));
    assert.equal((await writeLimitHit(makeFactWriter(rec), { account: bad, resets_at: iso(T0) }, { now: clockAt(T0) })).ok, false, String(bad));
  }
  assert.ok(accountOk('a') && accountOk('b'));
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
  const a = recWith();
  await read(a, 0, { net: false });
  assert.deepEqual(await step(a, 1, calls), ['network down: nothing done']);
  const b = recWith();
  await read(b, 0, { net: null });
  assert.deepEqual(await step(b, 1, calls), ['network unknown: nothing done']);
  // A reading older than 5 minutes is unknown too.
  const c = recWith();
  await read(c, 0, {});
  assert.deepEqual(await step(c, 6, calls), ['network unknown: nothing done']);
  const d = recWith();
  await read(d, 0, { mb: false });
  const out = await step(d, 1, calls);
  assert.equal(calls.minibase, 1);
  assert.ok(out.includes('Mini Base started'), JSON.stringify(out));
});

// A Tier-2 card parked on a's limit since `sinceMin` (the wait M9 lets a script set), and a pass that writes fresh usage.
function limitWorld(sinceMin) {
  const rec = recWith([['product', 'p1', { state: 'active' }],
    ['card', 'T2', { state: 'waiting', product: 'p1', tier: 2, files: ['src/t2.js'], changed_at: iso(T0 + sinceMin * MIN),
      wait: { who: 'usage', what: 'limit_hit', since: iso(T0 + sinceMin * MIN), next_check: iso(T0 + sinceMin * MIN), account: ACCT } }]]);
  const rules = rulesWith({}, { start_session: () => ({ decision: 'deny', reason: 'this test starts nothing' }) });
  const pass = async (min) => {
    const now = T0 + min * MIN;
    setClock(rec, now);
    await writeUsageFact(makeFactWriter(rec), async () => usageReading(now), ACCT, { now: clockAt(now) });
    return withAlerts(rec, now, () => true, (alert) => dispatcherPass({ rec, rules, now, account: ACCT, sessions: [], probe: () => null,
      launch: async () => ({ ok: false, reason: 'no starts here' }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
      filesOf: () => [], alert }));
  };
  return { rec, pass };
}

test('R-0b-168 limit hit: a Tier-2 card parked on a limit hit resumes only after the real fact\'s reset time', async () => {
  const w = limitWorld(0);
  await writeLimitHit(makeFactWriter(w.rec), { account: ACCT, resets_at: iso(T0 + 30 * MIN), source: 'worker-exit' }, { now: clockAt(T0 + MIN) });
  await w.pass(10);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'waiting');
  await w.pass(31);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'ready');
});

test('L97 M-3: a new hit with no reset time replaces yesterday\'s, and the card keeps waiting', async () => {
  const w = limitWorld(24 * 60);
  // Yesterday's hit for a, reset yesterday.
  await writeLimitHit(makeFactWriter(w.rec), { account: ACCT, resets_at: iso(T0 + 5 * 60 * MIN), source: 'worker-exit' }, { now: clockAt(T0) });
  // Today the worker hits the limit again, and its exit has no readable reset time: the hit is still written.
  const r = await writeLimitHit(makeFactWriter(w.rec), { account: ACCT, resets_at: 'soon', source: 'worker-exit' }, { now: clockAt(T0 + 24 * 60 * MIN + MIN) });
  assert.equal(r.ok, true, r.reason);
  const f = w.rec.read('fact', LIMIT_FACT(ACCT)).doc;
  assert.deepEqual([f.resets_at, f.observed_at], [null, iso(T0 + 24 * 60 * MIN + MIN)]);
  await w.pass(24 * 60 + 10);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'waiting', 'no reset time: never resumed on yesterday\'s');
});

test('L97 M-3 (lane 3 review): a hit with no reset time keeps today\'s reset time from the same window, and the card resumes after it', async () => {
  const w = limitWorld(0);
  // 10:01 a worker on a learns the reset (12:00); 10:05 a second worker on a hits it with no readable time.
  await writeLimitHit(makeFactWriter(w.rec), { account: ACCT, resets_at: iso(T0 + 120 * MIN), source: 'worker-exit' }, { now: clockAt(T0 + MIN) });
  const r = await writeLimitHit(makeFactWriter(w.rec), { account: ACCT, resets_at: null, source: 'worker-exit-2' }, { now: clockAt(T0 + 5 * MIN) });
  assert.equal(r.ok, true, r.reason);
  const f = w.rec.read('fact', LIMIT_FACT(ACCT)).doc;
  assert.deepEqual([f.resets_at, f.observed_at, f.source], [iso(T0 + 120 * MIN), iso(T0 + 5 * MIN), 'worker-exit-2']);
  await w.pass(60);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'waiting');
  await w.pass(121);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'ready', 'resumed after the kept reset time');
});

test('#78 r2 m-5 (Q16): a newer READABLE reset time beats the kept one', async () => {
  const rec = recWith();
  await writeLimitHit(makeFactWriter(rec), { account: ACCT, resets_at: iso(T0 + 120 * MIN) }, { now: clockAt(T0 + MIN) });
  await writeLimitHit(makeFactWriter(rec), { account: ACCT, resets_at: iso(T0 + 90 * MIN) }, { now: clockAt(T0 + 5 * MIN) });
  assert.equal(rec.read('fact', LIMIT_FACT(ACCT)).doc.resets_at, iso(T0 + 90 * MIN));
});

test('#78 r2 m-5 (Q14): account b is written under b by every account writer, never as a', async () => {
  const rec = recWith();
  await WRITERS['usage-'](makeFactWriter(rec), async (a) => ({ ...usageReading(T0), source: `screen-${a}` }), { account: 'b', now: clockAt(T0) });
  assert.deepEqual([rec.read('fact', USAGE_FACT('b'))?.doc?.account, rec.read('fact', USAGE_FACT('b'))?.doc?.source], ['b', 'screen-b']);
  assert.equal(rec.read('fact', USAGE_FACT('a')), null);
  await WRITERS['limit-hit-'](makeFactWriter(rec), { account: 'b', resets_at: iso(T0 + 30 * MIN) }, { now: clockAt(T0) });
  assert.equal(rec.read('fact', LIMIT_FACT('b'))?.doc?.account, 'b');
  assert.equal(rec.read('fact', LIMIT_FACT('a')), null);
});

test('#78 r2 m-3: a reset time already past at the hit is unreadable (null, or the kept one); a few seconds early is clock skew', async () => {
  const rec = recWith();
  const hit = (resets, at) => writeLimitHit(makeFactWriter(rec), { account: ACCT, resets_at: resets }, { now: clockAt(at) });
  // 11pm reads "resets 1am" as today's 1am (22 hours ago): stored as no time.
  await hit(iso(T0 - 22 * 60 * MIN), T0);
  assert.equal(rec.read('fact', LIMIT_FACT(ACCT)).doc.resets_at, null);
  // 5 s in the past: the worker's clock and ours differ a little; kept as given.
  await hit(iso(T0 - 5_000), T0);
  assert.equal(rec.read('fact', LIMIT_FACT(ACCT)).doc.resets_at, iso(T0 - 5_000));
  // A past time when a later reset is stored: the stored one is kept (it is still ahead).
  await hit(iso(T0 + 60 * MIN), T0);
  await hit(iso(T0 - 60 * MIN), T0 + MIN);
  assert.equal(rec.read('fact', LIMIT_FACT(ACCT)).doc.resets_at, iso(T0 + 60 * MIN));
});

test('#78 r2 m-4: writeLimitHit refuses a writer with no get(), so the keep rule is never skipped', async () => {
  const rec = recWith();
  const { put } = makeFactWriter(rec);
  await assert.rejects(() => writeLimitHit({ put }, { account: ACCT, resets_at: null }, { now: clockAt(T0) }), /needs a fact writer with get\(\)/);
  assert.equal(rec.read('fact', LIMIT_FACT(ACCT)), null);
});

test('R-0b-168: the writers refuse what M11 must not decide on', async () => {
  const rec = recWith();
  const w = makeFactWriter(rec);
  assert.equal((await writeLimitHit(w, { resets_at: iso(T0) })).ok, false, 'no account, no fact id');
  assert.equal((await writeUsageFact(w, async () => null, ACCT)).ok, false);
  await writeSignedInAccount(w, async () => '');
  assert.equal(rec.read('fact', ACCOUNT_FACT).doc.account, null);
  await assert.rejects(() => writeReading(w, 'wifi', async () => true), /no reading called wifi/);
});
