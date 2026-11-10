// Part C's interface (L741): the stub refuses every owner-side port, and the shapes are pinned to what M11 reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORT_DEADLINE_MS, SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { notWiredText } from './not-wired.mjs';
import { CLEANUP_PORTS, NOT_WIRED_CLEANUP, NOT_WIRED_WORKER } from './worker-ports.mjs';
import { LAUNCH_DOC_FIELDS, OWNER_CLEANUP_PORTS, SESSION_RECORD_PUSH_FIELDS, OWNER_PORTS, STATUS_STALE_MS, ownerPorts } from './owner-ports.mjs';

const code = (f) => readFileSync(new URL(`../modules/M11-dispatcher/${f}`, import.meta.url), 'utf8');

test('L741: the owner-side ports are the not-wired worker ports the runner answers, and none is wired yet', () => {
  assert.deepEqual(Object.keys(OWNER_PORTS).sort(), ['board', 'launch', 'outboxSessions', 'pauseLead', 'probe', 'saveWork', 'sessions', 'stopGroup', 'stopSession']);
  for (const k of Object.keys(OWNER_PORTS)) assert.ok(NOT_WIRED_WORKER.includes(k), k);
  // What stays orchestrate-side (L737's chunk for lane 3) is not here.
  for (const k of ['hostLock', 'reviewEnded']) assert.equal(OWNER_PORTS[k], undefined, k);
  assert.deepEqual(Object.keys(OWNER_CLEANUP_PORTS).sort(), ['copiesRoot', 'saveWork']);
  for (const k of Object.keys(OWNER_CLEANUP_PORTS)) { assert.ok(CLEANUP_PORTS.includes(k), k); assert.ok(NOT_WIRED_CLEANUP.includes(k), k); }
});

test('L741: the stub refuses each port with the same text wire() uses, and copiesRoot refuses when read', () => {
  const { ports, cleanup } = ownerPorts({ requestsDir: '/r', statusFile: '/s' });
  assert.deepEqual(Object.keys(ports).sort(), Object.keys(OWNER_PORTS).sort());
  for (const k of Object.keys(OWNER_PORTS)) assert.throws(() => ports[k]({}), { message: notWiredText(k) }, k);
  assert.throws(() => cleanup.saveWork({}), { message: notWiredText('cleanup.saveWork') });
  assert.throws(() => cleanup.copiesRoot, { message: notWiredText('cleanup.copiesRoot') });
  assert.deepEqual(Object.keys(cleanup).sort(), ['copiesRoot', 'saveWork']);
});

test('L741: every port says what goes in, what comes out, and how it fails; sync ports have no deadline, async ones the tick\'s', () => {
  for (const [k, s] of Object.entries({ ...OWNER_PORTS, ...Object.fromEntries(Object.entries(OWNER_CLEANUP_PORTS).map(([n, v]) => [`cleanup.${n}`, v])) })) {
    assert.equal(typeof s.in, 'string', k); assert.equal(typeof s.out, 'string', k);
    assert.equal(typeof (s.sync ? s.notKnown : s.fails), 'string', k);
    assert.equal(s.deadlineMs, s.sync ? null : s.deadlineMs, k);
    if (!s.sync) assert.ok([PORT_DEADLINE_MS, SAVE_DEADLINE_MS].includes(s.deadlineMs), k);
  }
  assert.equal(OWNER_PORTS.saveWork.deadlineMs, SAVE_DEADLINE_MS);
  assert.equal(OWNER_CLEANUP_PORTS.saveWork.deadlineMs, SAVE_DEADLINE_MS);
  for (const k of ['launch', 'stopGroup', 'pauseLead']) assert.equal(OWNER_PORTS[k].deadlineMs, PORT_DEADLINE_MS, k);
  // The ports the tick calls without await must be sync (tick.mjs: p.sessions(), p.board(), stopSession inside lapseClaims).
  for (const k of ['sessions', 'probe', 'board', 'outboxSessions', 'stopSession']) assert.equal(OWNER_PORTS[k].sync, true, k);
  assert.equal(STATUS_STALE_MS, 3 * 60_000);
});

test('L741: the launch answer names every field the pass reads from it (pass.mjs l.<field>)', () => {
  const pass = code('pass.mjs');
  const start = pass.indexOf('const l = await guarded(() => launch(');
  assert.ok(start > 0);
  const end = pass.indexOf('\n}\n', start); assert.ok(end > start);   // the starts loop's own function, not the rest of the file
  const body = pass.slice(start, end);
  assert.doesNotMatch(body, /=\s*l\s*[;,)]|\.\.\.l\b|\(l\)/, 'the launch answer is read only as l.<field>, never handed on or destructured');
  const read = new Set([...body.matchAll(/\bl\??\.(\w+)/g)].map((m) => m[1]));
  const said = new Set(OWNER_PORTS.launch.out.match(/\{([^}]*)\}/)[1].split(',').map((x) => x.trim().split(':')[0].trim()).concat(['reason', 'timedOut']));
  const unsaid = [...read].filter((f) => !said.has(f));
  assert.deepEqual(unsaid, [], `pass.mjs reads launch fields the interface does not name: ${unsaid}`);
  // A late launch is known only by guarded's own answer, so the port must never answer its own time-out (M2 of the self-review).
  assert.match(body, /l\?\.reason === `it did not answer within \$\{portDeadlineMs\} ms`|l\?\.timedOut === true/);
  assert.match(OWNER_PORTS.launch.fails, /the tick's limit answers and the card stays claimed/);
  // The call itself: the inputs the interface names.
  assert.match(pass, /launch\(\{ card, kind, product, sessionId \}\)/);
  assert.match(OWNER_PORTS.launch.in, /\{ card, kind, product, sessionId \}/);
});

test('L741: cleanup\'s saveWork call matches the interface, and cleanup puts no time limit on it (so the port keeps its own)', () => {
  const c = code('cleanup.mjs');
  assert.match(c, /await saveWork\(\{ clone: copy, mirror, card, branch, outbox: staging \}\)/);
  assert.match(OWNER_CLEANUP_PORTS.saveWork.in, /\{ clone, mirror, card, branch, outbox \}/);
  assert.doesNotMatch(c, /guarded\(\s*\(\)\s*=>\s*saveWork/);
});

test('L741/L744: the launch doc is what writeLaunch writes; branch, outbox and attempt are the session record\'s, its one source', () => {
  const pass = code('pass.mjs');
  const doc = pass.match(/export const writeLaunch = [\s\S]*?doc: \{([^}]*)\}/)[1];
  const today = doc.split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
  assert.deepEqual([...LAUNCH_DOC_FIELDS], today, 'writeLaunch changed: update LAUNCH_DOC_FIELDS');
  const session = pass.match(/entity: 'session'[\s\S]*?doc: \{([^}]*)\}/)[1];
  for (const f of SESSION_RECORD_PUSH_FIELDS) { assert.ok(!today.includes(f), f); assert.match(session, new RegExp(`\\b${f}\\b(?=:|,)`), f); }
});

test('L741: the sync ports\' shapes are the callers\' own (probe: transcript.mjs; sessions: pass.mjs; board: outage.mjs; outboxSessions: outbox-intake.mjs)', () => {
  const t = code('transcript.mjs');
  const ret = t.match(/return \{ tokens, compactions, turnEnded, endedAt: [^,]+, openTools: [^}]+\};/); assert.ok(ret, 'readSize returns { tokens, compactions, turnEnded, endedAt, openTools }');
  assert.match(OWNER_PORTS.probe.out, /size: \{ tokens, compactions, turnEnded, endedAt, openTools: \[ids\] \}, activity: \{ state \}/);
  const safe = t.slice(t.indexOf('export function atSafePoint'));
  const reads = new Set([...safe.matchAll(/\b(size|activity)\??\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`));
  assert.deepEqual([...reads].sort(), ['activity.state', 'size.openTools', 'size.turnEnded']);
  const pass = code('pass.mjs');
  const doc = pass.match(/sessions: the running sessions Mac-wide \[(\{[^\]]*\})\]/); assert.ok(doc, 'pass.mjs says sessions is Mac-wide, and its shape');
  const fields = (x) => x.replace(/[{}]/g, '').split(',').map((f) => f.trim()).filter(Boolean);
  for (const f of fields(doc[1])) assert.match(OWNER_PORTS.sessions.out, new RegExp(`\\b${f}\\b`), f);
  assert.match(OWNER_PORTS.sessions.out, /Mac-wide/);
  const board = code('outage.mjs').match(/`board` = \[(\{[^\]]*\})\]/)[1];
  for (const f of fields(board)) assert.match(OWNER_PORTS.board.out, new RegExp(`\\b${f}\\b`), f);
  const intake = code('outbox-intake.mjs').match(/`sessions`: the Dispatcher's session map, \[(\{[^\]]*\})\]/)[1];
  for (const f of fields(intake)) assert.match(OWNER_PORTS.outboxSessions.out, new RegExp(`\\b${f.replace('?', '\\?')}`), f);
});

test('L741: pauseLead fails by throwing, because the pass ignores what it resolves to', () => {
  assert.match(code('pass.mjs'), /await pauseLead\(\{ product \}\); return \{ ok: true \};/);
  assert.match(OWNER_PORTS.pauseLead.fails, /^throws/);
});
