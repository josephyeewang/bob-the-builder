// write-sites.test.mjs — L112: every Record write in the real module sources has its row in permissions.mjs, and the
// real Record (openRecord through the M9 fixtures) accepts the writes the modules depend on.
// Run: node --test orchestrate/modules/M9-record/write-sites.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FIELDS } from '../../shared/record.mjs';
import { WRITERS, fieldsAllowed } from './permissions.mjs';
import { NOT_OBJECT_SITES, PENDING, VARIABLE_SITES, checkSites, moduleSources, scanSources, splitPending, stripComments } from './write-sites.test-helper.mjs';
import { iso, setup } from './fixtures.test-helper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = moduleSources(ROOT);
const scan = scanSources(SOURCES);

test('L112: every Record write in a module is one the permissions table allows (pending ones printed, never skipped)', (t) => {
  assert.deepEqual(scan.problems, []);
  const { open, held, stale } = splitPending(checkSites(scan.sites));
  for (const { entry, refused } of held) {
    const line = `${entry.name}: ${entry.file} ${entry.actor} → ${entry.entity} at ${[...new Set(refused.map((r) => r.site.line))].join(', ')} (${entry.reason})`;
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
});

test('L112: an update is checked where the call passes a read rev, a create where it may be new', () => {
  const at = (file, line) => scan.sites.find((s) => s.file === file && s.line === line);
  assert.deepEqual(at('modules/M11-dispatcher/alerts.mjs', 16).modes, ['create', 'update'], 'rec.read(...)?.rev ?? 0');
  assert.deepEqual(at('modules/M11-dispatcher/phone-link.mjs', 43).modes, ['update'], 'c.rev');
  assert.deepEqual(at('modules/M6-merge-gate/gate.mjs', 83).modes, ['create'], '0');
  // The rows the code needs, said once more as plain facts.
  for (const a of ['sensors', 'ledger', 'dispatcher', 'workshop']) for (const create of [true, false]) assert.notEqual(fieldsAllowed('fact', a, { create }), null, `${a} fact ${create ? 'create' : 'update'}`);
  for (const create of [true, false]) assert.notEqual(fieldsAllowed('handoff', 'dispatcher', { create }), null);
  assert.equal(WRITERS.ask.dispatcher, undefined, 'no ask row for the dispatcher (L112 ruling 1)');
  assert.equal(fieldsAllowed('fact', 'live_check', { create: false }), null, 'live_check only creates');
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
    const p = scanSources([{ file: 'modules/M11-dispatcher/g.mjs', src }]).problems;
    assert.match(p.join('\n'), /not a literal, and not on VARIABLE_SITES/, src);
  }
  // (4) A Record write with no object literal; a write with no expectRev; a helper called with a variable entity.
  assert.match(scanSources([{ file: 'modules/M3-lead/h.mjs', src: 'export const h = (rec, w) => rec.write(w);\n' }]).problems.join('\n'), /not on NOT_OBJECT_SITES/);
  assert.match(scanSources([{ file: 'modules/M3-lead/h.mjs', src: "rec.write({ actor: 'dispatcher', entity: 'fact', id: 'x', doc: {} });\n" }]).problems.join('\n'), /no expectRev/);
  const moves = SOURCES.find((f) => f.file === 'modules/M11-dispatcher/moves.mjs');
  const caller = { file: 'modules/M11-dispatcher/k.mjs', src: "import { move } from './moves.mjs';\nexport const k = (rec, e) => move(rec, e, 'x', {}, { now: 0 });\n" };
  assert.match(scanSources([moves, caller]).problems.join('\n'), /move\( call\(s\) without a literal entity/);
  // (5) A write written over two lines, with ?. on the receiver, is still a site; one in a comment is not.
  const two = scanSources([{ file: 'modules/M3-lead/t.mjs', src: "const r = ctx?.record?.write({\n  actor: 'lead',\n  entity: 'ask', id, expectRev: 0, doc });\n// rec.write({ actor: 'dispatcher', entity: 'ask', expectRev: 0 })\n" }]);
  assert.deepEqual(two.sites.map((s) => [s.actor, s.entity, s.line]), [['lead', 'ask', 1]]);
});

test('L112: the named lists are exact, so a fixed site comes off them', () => {
  // A pending entry no longer refused, a variable site gone, and a not-object site gone each say so.
  assert.match(splitPending([], [{ name: 'p', file: 'modules/x.mjs', actor: 'dispatcher', entity: 'ask', count: 1 }]).stale.join(''), /expects 1 refused site\(s\), found 0/);
  const noVariable = SOURCES.map((f) => (f.file === 'modules/M12-sensors/facts.mjs' ? { ...f, src: f.src.replace('{ actor, entity', "{ actor: 'sensors', entity") } : f));
  assert.match(scanSources(noVariable).problems.join('\n'), /facts\.mjs: on VARIABLE_SITES but has no variable write/);
  const noFront = SOURCES.map((f) => (f.file === 'shared/record.mjs' ? { ...f, src: f.src.replace('impl.write(w)', 'impl.put(w)') } : f));
  assert.match(scanSources(noFront).problems.join('\n'), /NOT_OBJECT_SITES names impl\.write\( but the file has none/);
  for (const x of [...VARIABLE_SITES, ...NOT_OBJECT_SITES, ...PENDING]) assert.ok(x.reason?.length > 20, `${x.file} gives a reason`);
  assert.ok(PENDING.length <= 4, 'the pending list only shrinks');
});

test('L112: comments are blanked without eating code after a regex or a string that looks like one', () => {
  const s = stripComments("const a = /['\"]/g; rec.write({ actor: 'x' }); // gone\nconst u = 'http://x'; /* gone\n */ b();\n");
  assert.match(s, /rec\.write\(\{ actor: 'x' \}\)/);
  assert.match(s, /'http:\/\/x'/);
  assert.doesNotMatch(s, /gone/);
  assert.equal(s.split('\n').length, 4);
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
