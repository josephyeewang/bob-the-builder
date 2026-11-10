// Part C's interface (L741): the stub refuses every owner-side port, and the shapes are pinned to what M11 reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORT_DEADLINE_MS, SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { atSafePoint } from '../modules/M11-dispatcher/transcript.mjs';
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
  for (const k of Object.keys(OWNER_CLEANUP_PORTS)) assert.throws(() => cleanup[k], { message: notWiredText(`cleanup.${k}`) }, `${k} refuses when read`);
  assert.deepEqual(Object.keys(cleanup).sort(), ['copiesRoot', 'saveWork']);
});

test('L741: every port says what goes in, what comes out, and how it fails; sync ports have no deadline, async ones the tick\'s', () => {
  for (const [k, s] of Object.entries({ ...OWNER_PORTS, ...Object.fromEntries(Object.entries(OWNER_CLEANUP_PORTS).map(([n, v]) => [`cleanup.${n}`, v])) })) {
    assert.equal(typeof s.in, 'string', k); assert.equal(typeof s.out, 'string', k);
    assert.equal(typeof (s.sync ? s.notKnown : s.fails), 'string', k);
    if (s.sync) assert.equal(s.deadlineMs, null, k);
    if (!s.sync) assert.ok([PORT_DEADLINE_MS, SAVE_DEADLINE_MS].includes(s.deadlineMs), k);
  }
  assert.equal(OWNER_PORTS.saveWork.deadlineMs, SAVE_DEADLINE_MS);
  assert.equal(OWNER_CLEANUP_PORTS.saveWork.deadlineMs, SAVE_DEADLINE_MS);
  for (const k of ['launch', 'stopGroup', 'pauseLead']) assert.equal(OWNER_PORTS[k].deadlineMs, PORT_DEADLINE_MS, k);
  // The ports the tick calls without await must be sync (tick.mjs: p.sessions(), p.board(), stopSession inside lapseClaims).
  for (const k of ['sessions', 'probe', 'board', 'outboxSessions', 'stopSession']) assert.equal(OWNER_PORTS[k].sync, true, k);
  // lapseClaims gives the card back once stopSession answers true, so true must never mean "a launch request not seen yet"
  // (that request could still start a second session for the card: third check M2).
  assert.match(readFileSync(new URL('../modules/M9-record/writer.mjs', import.meta.url), 'utf8'), /once `stopSession\(session_id\)` answers true: whatever was started under that id is stopped/);
  assert.match(OWNER_PORTS.stopSession.out, /a request the runner has not yet seen is never true, and the runner refuses a launch request older than the claim timeout/);
  assert.equal(STATUS_STALE_MS, 3 * 60_000);
});

test('L741: the launch answer names every field the pass reads from it (pass.mjs l.<field>)', () => {
  const pass = code('pass.mjs');
  const start = pass.indexOf('const l = await guarded(() => launch(');
  assert.ok(start > 0);
  const end = pass.indexOf('\n}\n', start); assert.ok(end > start);   // the starts loop's own function, not the rest of the file
  const body = pass.slice(start, end);
  assert.deepEqual([...body.matchAll(/\bl\b(?!\??\.\w)/g)].map((m) => m.index), [body.search(/\bl = /)], 'the launch answer is read only as l.<field>, never handed on or destructured');
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
  const ret = t.match(/export function readSize[\s\S]*?\n  return (\{[^\n]*\});\n\}/); assert.ok(ret, 'readSize\'s return');
  assert.deepEqual([...ret[1].matchAll(/[{,]\s*(\w+)/g)].map((m) => m[1]), ['tokens', 'compactions', 'turnEnded', 'endedAt', 'openTools'], 'readSize returns a field the interface does not name');
  assert.match(OWNER_PORTS.probe.out, /size: \{ tokens, compactions, turnEnded, endedAt, openTools: \[ids\] \}, activity: \{ state \}/);
  const from = t.indexOf('export function atSafePoint'); const safe = t.slice(from, t.indexOf('\n}\n', from));
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
  // Intake reads Leads' and read-only helpers' hand-ins from this same list (outbox-intake.mjs), so a list of workers only
  // would leave them unread, in silence (second self-review M1).
  const it = code('outbox-intake.mjs');
  assert.match(it, /s\.role === 'lead'/); assert.match(it, /if \(entry\.request\) return \['report-'\];/);
  assert.match(OWNER_PORTS.outboxSessions.out, /every session whose outbox may still hold a file not yet taken, Mac-wide: running, or ended until intake has taken or told every file in it \(workers, Leads, read-only helpers, reviewers, auditors/);
  assert.match(OWNER_PORTS.outboxSessions.out, /request \(a non-empty value\) is there only for a read-only request session, and narrows its hand-ins to report- files/);
  // A verdict is taken only after its session ended, so a list of running sessions only would leave it unread (third check M1).
  assert.match(it, /a verdict is taken only once its session's ended record exists/); assert.match(it, /file\.kind === 'verdict-'/);
});

test('L741: pauseLead resolves { ok: true } and fails by throwing: a throw is a failed pause, whether or not the pass reads the answer', () => {
  const pass = code('pass.mjs');
  const at = pass.search(/await guarded\(async \(\) => \{ (const a = )?await pauseLead\(/); assert.ok(at > 0, 'pauseLead is called inside guarded, so a throw is { ok: false }');
  assert.match(pass.slice(at, at + 800), /'pause_lead_failed'/);
  assert.match(OWNER_PORTS.pauseLead.out, /^resolves \{ ok: true \}/); assert.match(OWNER_PORTS.pauseLead.fails, /^throws/);
});

test('#317 audit r1 M1: stop and save take any session sessions() lists, routed by kind; a session with no work copy saves as ok', () => {
  // pass.mjs decides a cancel before it asks whether a session is parkable, so a review or audit session of a cancelled card
  // reaches stopGroup and then saveWork: the contract must say where those go, or Joe is told of unsaved work that is not.
  const pass = code('pass.mjs');
  const sr = pass.slice(pass.indexOf('function stopReason'), pass.indexOf('\n}\n', pass.indexOf('function stopReason')));
  assert.ok(sr.indexOf("return 'cancel'") > 0 && sr.indexOf("return 'cancel'") < sr.indexOf('parkable(s)'), 'a cancel is decided before parkable');
  assert.match(pass, /guarded\(\(\) => stopGroup\(s\), portDeadlineMs\)/); assert.match(pass, /guarded\(\(\) => saveWork\(s\), saveDeadlineMs\)/);
  for (const k of ['probe', 'stopGroup', 'saveWork']) assert.match(OWNER_PORTS[k].in, /^\(session\): any session sessions\(\) lists, routed by kind/, k);
  assert.match(OWNER_PORTS.saveWork.out, /or the session has no work copy to save: only the kinds named here, review, audit, readonly, lead and front_door \(by kind, never by role/);
  assert.match(OWNER_PORTS.saveWork.out, /editing, undo, script and overnight save/);
  assert.match(OWNER_PORTS.saveWork.out, /any kind not named \(merge and undo_merge included, until it is settled that they have no copy\) is \{ ok: false, reason: no runner saves that kind \}/);
  assert.match(OWNER_PORTS.stopGroup.out, /the runner has set stop_requested for it in a status written before it answers/);
  assert.match(OWNER_PORTS.stopGroup.fails, /it may still run; stop_requested stays set once the runner has acted on the stop, even though the stop failed or timed out/, 'L764 m1, #328 r1 c3');
  assert.match(OWNER_PORTS.saveWork.out, /a worker kind whose copy is missing or unreadable is \{ ok: false, reason \}/);
  assert.match(OWNER_PORTS.stopGroup.in, /it needs only \{ id, pgid, kind \}/);
  // r2 n1: the routing map names every kind gate.mjs knows, once, with its runner; a kind no runner owns is never a silent ok.
  const head = readFileSync(new URL('./owner-ports.mjs', import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n');
  assert.match(head.replace(/\n\/\/\s*/g, ' '), /the worker runner's asks, owner-asks\.mjs, stop waiting at a limit past every tick limit and answer there as the tick's limit does, \{ ok: false, timedOut: true \}/, 'L759: the asks\' own limit is a noted exception');
  assert.match(head, /the worker kinds, editing, undo and script, to this runner \(overnight, an editing kind gate\.mjs counts, too/);
  assert.match(head, /the wiring routes each by kind to the runner that started it, never all to this one/);
  assert.match(head, /review and audit to the review runner;/);
  assert.match(head, /lead, readonly, front_door, merge and undo_merge each to the runner that starts that kind\./);
  assert.match(head, /A kind no runner owns is never a silent ok: probe throws and stopGroup answers \{ ok: false, reason \}/);
  assert.match(head, /stopSession takes\n\/\/ only an id: the wiring routes it by the claim's session id to the runner that received its launch request/);
  const gate = code('gate.mjs');
  const kinds = new Set([...gate.match(/kind is ([a-z_ |]+)\./)[1].split('|').map((k) => k.trim()), ...[...gate.matchAll(/s\.kind === '(\w+)'/g)].map((m) => m[1])]);
  for (const k of kinds) assert.match(head, new RegExp(`\\b${k}\\b`), `the routing map names ${k}`);
});

test('#317 audit r1 m1, m2, m4: the rules that guard the caps, the outage count, safe points, hand-ins and the copies are pinned', () => {
  // m1: atSafePoint reads a missing state as safe, so a state that can't be told must be a throw.
  assert.equal(atSafePoint({ role: 'lead', size: { turnEnded: true, openTools: [] }, activity: {} }), true, 'why the probe must throw');
  assert.match(OWNER_PORTS.probe.notKnown, /a state the tracker can't tell is a throw, never a missing or null state/);
  // m2: readOutboxFile compares the file's numeric owner.
  assert.match(readFileSync(new URL('../modules/M4-workshop/launcher/outbox.mjs', import.meta.url), 'utf8'), /if \(st\.uid !== uid\) return refuse/);
  assert.match(OWNER_PORTS.outboxSessions.out, /uid is the numeric Mac user id \(not a name\)/);
  // m4: sessions is never a partial list (the start caps count from it); board is never false (the outage count).
  assert.match(OWNER_PORTS.sessions.notKnown, /if any one source can't be read: never the sources it could read/);
  assert.match(OWNER_PORTS.board.out, /An alive or ended the runner does not know is left out of that row \(the field, never the row\), never false/);
  assert.doesNotMatch(OWNER_PORTS.board.out, /\bis false\b/);
  // m3/m4: copiesRoot's access list is L747's, and grants no add or write.
  const cr = OWNER_CLEANUP_PORTS.copiesRoot.out;
  assert.match(cr, /list, search, read \(file contents and attributes, so a copy can be hashed\) and delete, inherited by every file and folder made under it; no add, no write; it deletes only after cleanupPass's checks/);
  assert.doesNotMatch(cr, /as on the worker outboxes/);
  assert.doesNotMatch(cr.replace('no add, no write', ''), /\b(writ|add)\w*/i, 'no other grant of add or write (writes, adds, written too)');
});
