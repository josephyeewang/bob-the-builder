// write-sites.test.mjs — L112, L118: every Record write in the real module sources has its row in permissions.mjs,
// every row is used by a write or says why not, and the real Record (openRecord through the M9 fixtures) accepts the
// writes the modules depend on.
// Run: node --test orchestrate/modules/M9-record/write-sites.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FIELDS } from '../../shared/record.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { WRITERS, fieldsAllowed } from './permissions.mjs';
import {
  NOT_OBJECT_SITES, NOT_RECORD_RECEIVERS, OTHER_FORMS, PENDING, UNUSED_GRANTS, VARIABLE_SITES,
  checkSites, grantUse, grants, importsOf, modesOf, moduleSources, productionOnly, scanSources, splitPending, stripComments,
} from './write-sites.test-helper.mjs';
import { HEAD, PRODUCT, UID, iso, rulesFor, seed, setup } from './fixtures.test-helper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = moduleSources(ROOT);
const scan = scanSources(SOURCES);
const problemsOf = (files) => scanSources(files).problems.join('\n');

test('L112: every Record write in a module is one the permissions table allows (pending ones printed, never skipped)', (t) => {
  assert.deepEqual(scan.problems, []);
  const { open, held, stale } = splitPending(checkSites(scan.sites));
  for (const { entry, refused } of held) {
    const line = `${entry.name}: ${entry.file} ${entry.fn}() ${entry.actor} → ${entry.entity} at ${[...new Set(refused.map((r) => r.site.line))].join(', ')} (${entry.reason})`;
    t.diagnostic(line); console.log(line);
  }
  assert.deepEqual(open.map((r) => `${r.site.file}:${r.site.line}: ${r.why}`), []);
  assert.deepEqual(stale, []);
});

test('L112: the scan sees the writes the lead counted, so an empty answer is not a blind scan', () => {
  const n = (actor, entity) => scan.sites.filter((s) => s.actor === actor && s.entity === entity).length;
  assert.equal(n('dispatcher', 'fact'), 10, 'alerts, pass, tick, moves, outage, outbox-intake, phone-link ×2, lead-restart, usage');
  assert.equal(n('dispatcher', 'handoff'), 1);
  assert.equal(n('dispatcher', 'ask'), 3, 'cleanup ×2, undo ×1');
  assert.equal(n('workshop', 'fact'), 1);
  assert.ok(n('dispatcher', 'card') >= 15, 'move() through moves.mjs is followed to its callers');
  assert.ok(n('approvals', 'ask') >= 15, 'writeDoc() is followed to its callers');
  assert.ok(scan.sites.length >= 60, `${scan.sites.length} sites`);
  const files = new Set(scan.sites.map((s) => s.file));
  for (const f of ['modules/M11-dispatcher/alerts.mjs', 'modules/M4-workshop/git/push.mjs', 'modules/M12-sensors/facts.mjs', 'modules/M6-merge-gate/gate.mjs', 'modules/M2-approvals/ask-store.mjs']) assert.ok(files.has(f), f);
  // Each site names the function around it, which PENDING pins (L118 m6).
  assert.equal(scan.sites.find((s) => s.file === 'modules/M11-dispatcher/merges.mjs' && s.entity === 'merge_request')?.fn, 'requestMerges');
});

test('L112, L118 m4, c3: an update is checked where the call passes a read rev, a create where it may be new', () => {
  const at = (file, line) => scan.sites.find((s) => s.file === file && s.line === line);
  assert.deepEqual(at('modules/M11-dispatcher/alerts.mjs', 16).modes, ['create', 'update'], 'rec.read(...)?.rev ?? 0');
  assert.deepEqual(at('modules/M11-dispatcher/phone-link.mjs', 43).modes, ['update'], 'c.rev');
  assert.deepEqual(at('modules/M6-merge-gate/gate.mjs', 86).modes, ['create'], '0');
  // c3: gate.mjs's write() helper passes cur.rev, so it is an update, and the table says so.
  const gateHelper = scan.sites.filter((s) => s.file === 'modules/M6-merge-gate/gate.mjs' && s.via === 'write()');
  assert.ok(gateHelper.length >= 5, `${gateHelper.length} write() calls in gate.mjs`);
  for (const s of gateHelper) assert.deepEqual(s.modes, ['update'], `gate.mjs:${s.line}`);
  // m4: only a read document's own rev is update-only; anything else is checked both ways.
  assert.equal(modesOf(undefined), null);
  assert.deepEqual(modesOf('0'), ['create']);
  assert.deepEqual(modesOf(' cur.rev '), ['update']);
  assert.deepEqual(modesOf('cur?.rev'), ['update']);
  for (const e of ['cur.rev ?? 0', 'rev', 'a.b.rev', 'cur.rev + 1', 'n', 'cur.revs']) assert.deepEqual(modesOf(e), ['create', 'update'], e);
  // The rows the code needs, said once more as plain facts.
  for (const a of ['sensors', 'ledger', 'dispatcher', 'workshop']) for (const create of [true, false]) assert.notEqual(fieldsAllowed('fact', a, { create }), null, `${a} fact ${create ? 'create' : 'update'}`);
  for (const create of [true, false]) assert.notEqual(fieldsAllowed('handoff', 'dispatcher', { create }), null);
  assert.equal(WRITERS.ask.dispatcher, undefined, 'no ask row for the dispatcher (L112 ruling 1)');
  assert.equal(fieldsAllowed('fact', 'live_check', { create: false }), null, 'live_check only creates');
  // L118 M2: a merge request is create-only again.
  assert.notEqual(fieldsAllowed('merge_request', 'dispatcher', { create: true }), null);
  assert.equal(fieldsAllowed('merge_request', 'dispatcher', { create: false }), null);
});

test('L112 plants: a dropped row, a fake ask write, a variable actor and an unlisted plain write are each caught', () => {
  // (1) The dispatcher's fact row dropped.
  const noDispatcherFact = (e, a, o) => (e === 'fact' && a === 'dispatcher' ? null : fieldsAllowed(e, a, o));
  const open1 = splitPending(checkSites(scan.sites, noDispatcherFact)).open;
  assert.ok(open1.some((r) => r.site.file === 'modules/M11-dispatcher/alerts.mjs'), 'the alert queue write is refused');
  // (2) A fake dispatcher ask write in a new module.
  const fake = { file: 'modules/M11-dispatcher/fake.mjs', src: "export const f = (rec, ask) => rec.write({ actor: 'dispatcher', entity: 'ask', id: ask.id, expectRev: ask.rev, doc: {} });\n" };
  const s2 = scanSources([...SOURCES, fake]);
  assert.deepEqual(s2.problems, []);
  assert.deepEqual(splitPending(checkSites(s2.sites)).open.map((r) => r.site.file), ['modules/M11-dispatcher/fake.mjs']);
  // (3) A variable actor or entity, not on the named list.
  for (const src of ["export const g = (rec, who) => rec.write({ actor: who, entity: 'fact', id: 'x', expectRev: 0, doc: {} });\n",
    "export const g = (rec, e) => rec.write({ actor: 'dispatcher', entity: e, id: 'x', expectRev: 0, doc: {} });\n",
    "export const g = (rec, actor) => rec.write({ actor, entity: 'fact', id: 'x', expectRev: 0, doc: {} });\n"]) {
    assert.match(problemsOf([{ file: 'modules/M11-dispatcher/g.mjs', src }]), /not a literal, and not on VARIABLE_SITES/, src);
  }
  // (4) A Record write with no object literal; a write with no expectRev; a helper called with a variable entity.
  assert.match(problemsOf([{ file: 'modules/M3-lead/h.mjs', src: 'export const h = (rec, w) => rec.write(w);\n' }]), /not on NOT_OBJECT_SITES/);
  assert.match(problemsOf([{ file: 'modules/M3-lead/h.mjs', src: "rec.write({ actor: 'dispatcher', entity: 'fact', id: 'x', doc: {} });\n" }]), /no expectRev/);
  const moves = SOURCES.find((f) => f.file === 'modules/M11-dispatcher/moves.mjs');
  const caller = { file: 'modules/M11-dispatcher/k.mjs', src: "import { move } from './moves.mjs';\nexport const k = (rec, e) => move(rec, e, 'x', {}, { now: 0 });\n" };
  assert.match(problemsOf([moves, caller]), /move\( call\(s\) without a literal entity/);
  // (5) A write written over two lines, with ?. on the receiver, is still a site; one in a comment is not.
  const two = scanSources([{ file: 'modules/M3-lead/t.mjs', src: "const r = ctx?.record?.write({\n  actor: 'lead',\n  entity: 'ask', id, expectRev: 0, doc });\n// rec.write({ actor: 'dispatcher', entity: 'ask', expectRev: 0 })\n" }]);
  assert.deepEqual(two.sites.map((s) => [s.actor, s.entity, s.line]), [['lead', 'ask', 1]]);
});

test('L112: the named lists are exact, so a fixed site comes off them', () => {
  // A pending entry no longer refused, a variable site gone, and a not-object site gone each say so.
  assert.match(splitPending([], [{ name: 'p', file: 'modules/x.mjs', fn: 'f', actor: 'dispatcher', entity: 'ask', count: 1 }]).stale.join(''), /expects 1 refused site\(s\), found 0/);
  const noVariable = SOURCES.map((f) => (f.file === 'modules/M12-sensors/facts.mjs' ? { ...f, src: f.src.replace('{ actor, entity', "{ actor: 'sensors', entity") } : f));
  assert.match(scanSources(noVariable).problems.join('\n'), /facts\.mjs: on VARIABLE_SITES but has no variable write/);
  const noFront = SOURCES.map((f) => (f.file === 'shared/record.mjs' ? { ...f, src: f.src.replace('impl.write(w)', 'impl.put(w)') } : f));
  assert.match(scanSources(noFront).problems.join('\n'), /NOT_OBJECT_SITES names impl\.write\( but the file has none/);
  const noForm = SOURCES.map((f) => (f.file === 'modules/M4-workshop/launcher/review-runner-main.mjs' ? { ...f, src: stripComments(f.src).replace(/\bwrite\b/g, 'put') } : f));
  assert.match(scanSources(noForm).problems.join('\n'), /review-runner-main\.mjs: on OTHER_FORMS but has no other use of write/);
  for (const x of [...VARIABLE_SITES, ...NOT_OBJECT_SITES, ...PENDING, ...OTHER_FORMS, ...NOT_RECORD_RECEIVERS, ...UNUSED_GRANTS]) {
    assert.ok(x.reason?.length > 20, `${x.file ?? x.receiver ?? x.grant} gives a reason`);
  }
  assert.ok(PENDING.length <= 7, 'the pending list only shrinks');
  for (const p of PENDING) assert.ok(p.fn, `${p.name} names its function`);
});

test('L118 m6: a pending entry holds only the refusals in its own function', () => {
  const site = (fn) => ({ site: { file: 'modules/M11-dispatcher/cleanup.mjs', line: 9, fn, actor: 'dispatcher', entity: 'ask', modes: ['create'] }, mode: 'create', why: 'x' });
  const r = splitPending([site('somethingNew')]);
  assert.equal(r.open.length, 1, 'a new refusal in another function of a pending file is open, not held');
  const r2 = splitPending([site('consume')], [PENDING[0]]);
  assert.deepEqual([r2.open.length, r2.held.length, r2.stale.length], [0, 1, 0]);
  // The real list: each entry's count matches refusals in its own function.
  const real = splitPending(checkSites(scan.sites));
  assert.equal(real.held.length, PENDING.length);
});

test('comments are blanked without eating code after a regex or a string that looks like one; strings blank on request', () => {
  const src = "const a = /['\"]/g; rec.write({ actor: 'x' }); // gone\nconst u = 'http://x'; /* gone\n */ b();\n";
  const s = stripComments(src);
  assert.match(s, /rec\.write\(\{ actor: 'x' \}\)/);
  assert.match(s, /'http:\/\/x'/);
  assert.doesNotMatch(s, /gone/);
  assert.equal(s.split('\n').length, 4);
  const b = stripComments("x('rec.write(1)'); y(\"a\\\"b\");\n", { strings: true });
  assert.doesNotMatch(b, /write/);
  assert.equal(b.length, "x('rec.write(1)'); y(\"a\\\"b\");\n".length);
});

// ── L118 m1: every grant is used, or listed with why; the field-level rows are pinned. ──

const SNAPSHOT = {
  card: {
    lead: { create: ['state', 'product', 'module', 'lane', 'kind', 'depends_on', 'what', 'files', 'done_when', 'tier', 'plan_sha256', 'main_commit', 'brief', 'desired', 'merge_requested', 'needs_joe'], update: ['brief', 'desired', 'merge_requested', 'needs_joe'], updateInDraft: ['files', 'done_when', 'tier', 'plan_sha256', 'main_commit'], kinds: ['ordinary', 'lead_daily_card'] },
    dispatcher: { create: ['state', 'product', 'module', 'lane', 'kind', 'depends_on', 'what', 'fix_of', 'source', 'research_ask', 'files', 'done_when', 'tier', 'plan_sha256', 'main_commit', 'brief', 'desired', 'merge_requested', 'needs_joe', 'round'], update: ['claim', 'wait', 'failure', 'summary', 'report_ref', 'needs_joe'], kinds: ['fix', 'exact_reverse', 'research_copy'] },
    worker: { update: ['summary', 'report_ref'] },
    workshop: { update: ['head'] },
    approvals: { update: ['needs_joe', 'approval_required', 'cancel_reason'] },
    merge_gate: { update: ['needs_joe', 'merge_commit'] },
  },
  ask: { approvals: { create: '*', update: '*' } },
  go: { approvals: { create: '*', update: '*' } },
  verdict: { reviewer: { create: '*' }, auditor: { create: '*' } },
  session: { dispatcher: { create: '*', update: '*' }, workshop: { update: '*' } },
  merge: { merge_gate: { create: '*', update: '*' } },
  fact: { sensors: { create: '*', update: '*' }, ledger: { create: '*', update: '*' }, dispatcher: { create: '*', update: '*' }, workshop: { create: '*', update: '*' }, live_check: { create: '*' } },
  product: { approvals: { create: '*', update: '*' } },
  handoff: { lead: { create: '*' }, learning: { create: '*' }, dispatcher: { create: '*', update: '*' } },
  report: Object.fromEntries(['worker', 'reviewer', 'scout', 'writer', 'thinking', 'script', 'front_door', 'incident', 'lead', 'learning'].map((r) => [r, { create: '*' }])),
  lesson: { learning: { create: '*', update: '*' } },
  launch: { dispatcher: { create: '*' } },
  merge_request: { dispatcher: { create: '*' } },
};
const plain = (writers) => Object.fromEntries(Object.entries(writers).map(([e, rows]) => [e, Object.fromEntries(Object.entries(rows).map(([a, row]) => [a, Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === '*' ? '*' : [...v]]))]))]));

test('L118 m1: every grant in the table is used by a write site or listed in UNUSED_GRANTS with why; the rows are pinned', () => {
  assert.deepEqual(grantUse(scan.sites), { unused: [], staleUnused: [] });
  // A change to any row, down to one field, is a change to this snapshot, made on purpose.
  assert.deepEqual(plain(WRITERS), SNAPSHOT);
  assert.equal(new Set(UNUSED_GRANTS.map((u) => u.grant)).size, UNUSED_GRANTS.length, 'each grant listed once');
});

test('L118 m1 plants: dispatcher go/verdict ANY, workshop card *, worker fact ANY and a stale UNUSED_GRANTS entry are each caught', () => {
  const ANY = { create: '*', update: '*' };
  const withRow = (entity, actor, row) => ({ ...WRITERS, [entity]: { ...WRITERS[entity], [actor]: row } });
  const unused = (w) => grantUse(scan.sites, w).unused;
  assert.deepEqual(unused(withRow('go', 'dispatcher', ANY)), ['go dispatcher create', 'go dispatcher update']);
  assert.deepEqual(unused(withRow('verdict', 'dispatcher', ANY)), ['verdict dispatcher create', 'verdict dispatcher update']);
  assert.deepEqual(unused(withRow('fact', 'worker', ANY)), ['fact worker create', 'fact worker update']);
  // workshop card '*' keeps the same grant names (card workshop update), so the snapshot is what catches it.
  const wide = withRow('card', 'workshop', { update: '*' });
  assert.deepEqual(unused(wide), []);
  assert.notDeepEqual(plain(wide), SNAPSHOT);
  // A listed grant that a site uses after all, and one the table no longer has, are each stale.
  assert.deepEqual(grantUse(scan.sites, WRITERS, [...UNUSED_GRANTS, { grant: 'fact sensors create', reason: 'x'.repeat(30) }]).staleUnused, ['fact sensors create']);
  assert.deepEqual(grantUse(scan.sites, WRITERS, [...UNUSED_GRANTS, { grant: 'fact nobody create', reason: 'x'.repeat(30) }]).staleUnused, ['fact nobody create']);
  // A grant dropped from UNUSED_GRANTS is unused again.
  assert.deepEqual(grantUse(scan.sites, WRITERS, UNUSED_GRANTS.filter((u) => u.grant !== 'card lead create')).unused, ['card lead create']);
  assert.ok(grants().includes('merge_request dispatcher create') && !grants().includes('merge_request dispatcher update'));
});

// ── L118 m2: any other form of write is flagged; NOT_RECORD_RECEIVERS holds only in its own files. ──

test('L118 m2: every other form of write is a problem unless OTHER_FORMS names it', () => {
  const forms = {
    "['write']": "export const a = (rec) => rec['write']({ actor: 'dispatcher', entity: 'ask', id: 'x', expectRev: 0, doc: {} });\n",
    destructured: "export const a = (rec) => { const { write } = rec; return write({ actor: 'dispatcher', entity: 'ask', expectRev: 0 }); };\n",
    'write.call': "export const a = (rec) => rec.write.call(rec, { actor: 'dispatcher', entity: 'ask', expectRev: 0 });\n",
    'write.apply': "export const a = (rec) => rec.write.apply(rec, [{ actor: 'dispatcher', entity: 'ask', expectRev: 0 }]);\n",
    'write.bind': "export const a = (rec) => rec.write.bind(rec);\n",
    'write?.(': "export const a = (rec) => rec.write?.({ actor: 'dispatcher', entity: 'ask', id: 'x', expectRev: 0, doc: {} });\n",
    'a space': "export const a = (rec) => rec.write ({ actor: 'dispatcher', entity: 'ask', id: 'x', expectRev: 0, doc: {} });\n",
    'as a value': "export const a = (rec) => [1].forEach(rec.write);\n",
  };
  for (const [name, src] of Object.entries(forms)) assert.match(problemsOf([{ file: 'modules/M3-lead/f.mjs', src }]), /not on OTHER_FORMS/, name);
  // A count that grows on a listed file is caught too.
  const runner = SOURCES.find((f) => f.file === 'modules/M4-workshop/launcher/review-runner-main.mjs');
  assert.match(problemsOf([{ ...runner, src: `${runner.src}\nexport const extra = (rec) => rec['write']({});\n` }]), /2 other uses of write.*OTHER_FORMS says 1/);
  // A field called write in data, and write inside a string, are not uses.
  assert.equal(problemsOf([{ file: 'modules/M3-lead/d.mjs', src: "const x = { write: 1 }; x.write.length; log('rec.write (x)');\n" }]), '');
});

test('L118 m2: a receiver that is not the Record only counts as such in its own file', () => {
  const src = "export const a = (io, x) => io.write(x);\n";
  assert.equal(problemsOf([{ file: 'setup/users-folders.mjs', src }]), '');
  assert.match(problemsOf([{ file: 'modules/M11-dispatcher/io.mjs', src }]), /io\.write\( with no object literal is not on NOT_OBJECT_SITES/);
  assert.equal(problemsOf([{ file: 'modules/M11-dispatcher/out.mjs', src: "process.stdout.write('x');\n" }]), '');
});

test('L118 m2: the scan reads .js and .cjs files, and a test helper a production file imports', () => {
  const root = tempDir('m9-sites-');
  mkdirSync(join(root, 'modules', 'Mx'), { recursive: true });
  const w = (f, s) => writeFileSync(join(root, f), s);
  w('modules/Mx/a.js', "rec.write({ actor: 'dispatcher', entity: 'ask', id: 'a', expectRev: 0, doc: {} });\n");
  w('modules/Mx/b.cjs', "rec.write({ actor: 'dispatcher', entity: 'ask', id: 'b', expectRev: 0, doc: {} });\n");
  w('modules/Mx/c.test.mjs', "rec.write({ actor: 'dispatcher', entity: 'ask', id: 'c', expectRev: 0, doc: {} });\n");
  w('modules/Mx/used.test-helper.mjs', "rec.write({ actor: 'dispatcher', entity: 'ask', id: 'd', expectRev: 0, doc: {} });\n");
  w('modules/Mx/unused.test-helper.mjs', "rec.write({ actor: 'dispatcher', entity: 'ask', id: 'e', expectRev: 0, doc: {} });\n");
  w('modules/Mx/main.mjs', "import { x } from './used.test-helper.mjs';\n");
  const files = moduleSources(root).map((f) => f.file).sort();
  assert.deepEqual(files, ['modules/Mx/a.js', 'modules/Mx/b.cjs', 'modules/Mx/main.mjs', 'modules/Mx/used.test-helper.mjs']);
  // A helper imported only through another helper that production uses is kept; one only a test imports is not.
  const kept = productionOnly([
    { file: 'p.mjs', src: "import './h1.test-helper.mjs';\n" },
    { file: 'h1.test-helper.mjs', src: "import { y } from './h2.test-helper.mjs';\n" },
    { file: 'h2.test-helper.mjs', src: '' },
    { file: 'h3.test-helper.mjs', src: '' },
  ]).map((f) => f.file);
  assert.deepEqual(kept, ['p.mjs', 'h1.test-helper.mjs', 'h2.test-helper.mjs']);
});

// ── L118 m3: helper imports are followed by path and name; ones the scan can't follow are problems. ──

test('L118 m3: move() is followed under another name and from another folder; namespace, dynamic, re-export and value uses are problems', () => {
  const moves = SOURCES.find((f) => f.file === 'modules/M11-dispatcher/moves.mjs');
  const scanWith = (file, src) => scanSources([moves, { file, src }]);
  const aliased = scanWith('modules/M6-merge-gate/x.mjs', "import { move as shift } from '../M11-dispatcher/moves.mjs';\nexport const x = (rec) => shift(rec, 'merge', 'm', {});\n");
  assert.deepEqual(aliased.problems, []);
  assert.deepEqual(aliased.sites.filter((s) => s.file === 'modules/M6-merge-gate/x.mjs').map((s) => [s.actor, s.entity, s.via]), [['dispatcher', 'merge', 'move()']]);
  assert.ok(splitPending(checkSites(aliased.sites)).open.some((r) => r.site.file === 'modules/M6-merge-gate/x.mjs'), 'dispatcher → merge is refused');
  // A same-named import from another module is not move().
  assert.deepEqual(scanWith('modules/M6-merge-gate/y.mjs', "import { move } from './moves.mjs';\nmove(rec, 'merge', 'm');\n").sites.filter((s) => s.file === 'modules/M6-merge-gate/y.mjs'), []);
  const blind = {
    namespace: "import * as mv from '../M11-dispatcher/moves.mjs';\nmv.move(rec, 'card', 'c', {});\n",
    dynamic: "const { move } = await import('../M11-dispatcher/moves.mjs');\n",
    'dynamic, built name': "const m = await import(`../M11-dispatcher/${'moves.mjs'}`);\n",
    're-export': "export { move } from '../M11-dispatcher/moves.mjs';\n",
    'value use': "import { move } from '../M11-dispatcher/moves.mjs';\nexport const all = (rec, ids) => ids.map(move);\n",
  };
  for (const [name, src] of Object.entries(blind)) assert.notDeepEqual(scanWith('modules/M6-merge-gate/z.mjs', src).problems, [], name);
  assert.deepEqual(importsOf('modules/M6-merge-gate/z.mjs', "import { move as a, other } from '../M11-dispatcher/moves.mjs';\n", 'modules/M11-dispatcher/moves.mjs', 'move'), { locals: ['a'], blind: [] });
});

// ── L118 m5: fact-writer makers name an actor on the list. ──

test('L118 m5: makeFactWriter and makeAlerts called with an unlisted or unnamed actor are problems', () => {
  const keep = SOURCES.filter((f) => ['modules/M12-sensors/facts.mjs', 'modules/M13-ledger/alerts.mjs'].includes(f.file));
  assert.equal(keep.length, 2);
  assert.deepEqual(scanSources(keep).problems, []);
  const bad = {
    "makeFactWriter actor 'dispatcher'": "import { makeFactWriter } from '../M12-sensors/facts.mjs';\nconst w = makeFactWriter(rec, { actor: 'dispatcher' });\n",
    'makeFactWriter actor from a variable': "import { makeFactWriter as mk } from '../M12-sensors/facts.mjs';\nconst w = mk(rec, { actor: who });\n",
    "makeAlerts actor 'workshop'": "import { makeAlerts } from '../M13-ledger/alerts.mjs';\nconst a = makeAlerts({ rec, gh, actor: 'workshop' });\n",
  };
  for (const [name, src] of Object.entries(bad)) assert.match(problemsOf([...keep, { file: 'modules/M11-dispatcher/m.mjs', src }]), /makeFactWriter|makeAlerts/, name);
  const ok = "import { makeFactWriter } from '../M12-sensors/facts.mjs';\nconst w = makeFactWriter(rec, { actor: 'ledger' });\nconst v = makeFactWriter(rec);\n";
  assert.deepEqual(scanSources([...keep, { file: 'modules/M11-dispatcher/m.mjs', src: ok }]).problems, []);
  // The maker's own default changed to an actor off the list.
  const facts = keep[0];
  assert.match(problemsOf([{ ...facts, src: facts.src.replace("actor = 'sensors'", "actor = 'workshop'") }, keep[1]]), /defaults to actor workshop/);
});

// The real Record, no stand-in: the writes the modules make are accepted (L112 ruling 4).
function minimal(entity, t) {
  return Object.fromEntries((REQUIRED_FIELDS[entity] ?? []).map((f) => [f, f.endsWith('_at') ? iso(t) : 'x']));
}

test('L112 on the real Record: each fact writer creates and then rewrites the same fact; the dispatcher writes a handoff twice, and no ask', () => {
  const env = setup({ prefix: 'm9-sites-' });
  const t = env.clock.t;
  for (const actor of ['sensors', 'ledger', 'dispatcher', 'workshop']) {
    const id = `fact-${actor}`;
    const a = env.record.write({ actor, entity: 'fact', id, expectRev: 0, doc: { ...minimal('fact', t), n: 1 } });
    assert.equal(a.ok, true, `${actor} creates: ${a.reason}`);
    const cur = env.record.read('fact', id);
    const b = env.record.write({ actor, entity: 'fact', id, expectRev: cur.rev, doc: { ...cur.doc, n: 2 } });
    assert.equal(b.ok, true, `${actor} rewrites: ${b.reason}`);
    assert.equal(env.record.read('fact', id).doc.n, 2);
  }
  // live_check only creates.
  assert.equal(env.record.write({ actor: 'live_check', entity: 'fact', id: 'fact-lc', expectRev: 0, doc: minimal('fact', t) }).ok, true);
  const lc = env.record.read('fact', 'fact-lc');
  const lcw = env.record.write({ actor: 'live_check', entity: 'fact', id: 'fact-lc', expectRev: lc.rev, doc: { ...lc.doc, n: 2 } });
  assert.equal(lcw.ok, false); assert.match(lcw.reason, /may not change fact/);
  // The restart handoff (M11 lead-restart.mjs:118 shape), written, then written again on the next stop.
  const hdoc = (sha) => ({ ...minimal('handoff', t), session: 'L-1', product: null, name: 'handoff-L-1.md', sha256: sha, at: iso(t) });
  const h1 = env.record.write({ actor: 'dispatcher', entity: 'handoff', id: 'handoff-L-1', expectRev: 0, doc: hdoc('a'.repeat(64)), kind: 'handoff' });
  assert.equal(h1.ok, true, h1.reason);
  const h = env.record.read('handoff', 'handoff-L-1');
  const h2 = env.record.write({ actor: 'dispatcher', entity: 'handoff', id: 'handoff-L-1', expectRev: h.rev, doc: hdoc('b'.repeat(64)), kind: 'handoff' });
  assert.equal(h2.ok, true, h2.reason);
  const ask = env.record.write({ actor: 'dispatcher', entity: 'ask', id: 'ask-1', expectRev: 0, doc: { ...minimal('ask', t), state: 'open' } });
  assert.equal(ask.ok, false); assert.match(ask.reason, /dispatcher may not create ask/);
});

test('L118 M2 on the real Record: the dispatcher creates a merge request and may not rewrite it', () => {
  const env = setup({ prefix: 'm9-sites-' });
  seed(env, 'card', 'C-a', { product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, state: 'approved' });
  const doc = { card: 'C-a', pr: 1, session_id: 'S-1', head: HEAD, rev: 1, requested_at: iso(env.clock.t) };
  const a =env.record.write({ actor: 'dispatcher', entity: 'merge_request', id: 'mr-1', expectRev: 0, doc });
  assert.equal(a.ok, true, a.reason);
  const cur = env.record.read('merge_request', 'mr-1');
  const b = env.record.write({ actor: 'dispatcher', entity: 'merge_request', id: 'mr-1', expectRev: cur.rev, doc: { ...cur.doc, n: 2 } });
  assert.equal(b.ok, false);
  assert.match(b.reason, /may not change merge_request/);
});

// #91 r2 audit N1 and N9 (L129): two write forms the scan used to miss.
test('L129 N1: a spread after the literal actor, entity, id or expectRev is a problem; a spread first is not', () => {
  const at = (obj) => problemsOf([{ file: 'modules/M3-lead/t.mjs', src: `const r = ctx.record.write(${obj});\n` }]);
  for (const obj of ["{ actor: 'lead', entity: 'card', id, expectRev: 0, doc, ...over }", "{ actor: 'lead', ...over, entity: 'card', id, expectRev: 0, doc }",
    "{ entity: 'card', id, expectRev: 0, doc, ...over, actor: 'lead' }"]) assert.match(at(obj), /a spread after the actor, entity, id or expectRev/, obj);
  assert.doesNotMatch(at("{ ...over, actor: 'lead', entity: 'card', id, expectRev: 0, doc }"), /spread/);
  assert.doesNotMatch(at("{ actor: 'lead', entity: 'card', id, expectRev: 0, doc: { ...doc, x: 1 } }"), /spread/, 'a spread inside doc is not top level');
});

test('L129 N9: only M9 may import its store.mjs, in any import form', () => {
  const forms = ["import { openStore } from '../M9-record/store.mjs';", "import * as s from '../M9-record/store.mjs';",
    "export { openStore } from '../M9-record/store.mjs';", "const s = await import('../M9-record/store.mjs');", "import '../M9-record/store.mjs';"];
  for (const src of forms) assert.match(problemsOf([{ file: 'modules/M11-dispatcher/x.mjs', src }]), /imports M9's store\.mjs/, src);
  assert.doesNotMatch(problemsOf([{ file: 'modules/M9-record/writer.mjs', src: forms[0] }]), /store\.mjs/);
  assert.doesNotMatch(problemsOf([{ file: 'modules/M2-approvals/x.mjs', src: "import { a } from './ask-store.mjs';" }]), /store\.mjs/);
});

// #91 r3 MIN-1 (L137, L140): openRecord no longer hands out the raw store or impl, and only M9 may name the export that does.
test('L140 MIN-1: openRecord gives only the Record and recover; openRecordWithStore is refused outside M9', async () => {
  const { openRecord, openRecordWithStore } = await import('./writer.mjs');
  const env = setup({ prefix: 'm9-min1-' });
  const opened = openRecord({ root: env.root, product: PRODUCT, ownerUid: UID, rules: rulesFor(), alert: () => {} });
  assert.deepEqual(Object.keys(opened).sort(), ['record', 'recover']);
  assert.equal(typeof openRecordWithStore, 'function');
  const forms = ["import { openRecordWithStore } from '../M9-record/writer.mjs';", "const w = await import('../M9-record/writer.mjs'); w['openRecordWithStore']();",
    "const { openRecordWithStore: o } = mod;"];
  for (const src of forms) assert.match(problemsOf([{ file: 'modules/M11-dispatcher/x.mjs', src }]), /names openRecordWithStore/, src);
  assert.doesNotMatch(problemsOf([{ file: 'modules/M9-record/x.mjs', src: forms[0] }]), /openRecordWithStore/);
  assert.doesNotMatch(problemsOf([{ file: 'modules/M11-dispatcher/x.mjs', src: "import { openRecord } from '../M9-record/writer.mjs';" }]), /openRecordWithStore/);
});
