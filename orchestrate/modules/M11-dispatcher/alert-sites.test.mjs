// Audit 0b-6 r5 MAT-2, as a class: a cause is marked told only after its alert went through. Every
// write of a told field (`told`, `told_at`, `told_cause`, `told_keys`, `hard_told`, `stop_told`, ...)
// sits inside a `tellThen(` call, as its mark, which the sender writes once a copy is delivered
// (alerts.mjs, L47); resetting one to false or null is the one exception. alerts.mjs writes the mark itself.
// The old names (marked before the send) are gone. The behavioral sweep is in tick.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const code = () => readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.endsWith('.test-helper.mjs'))
  .map((f) => [f, readFileSync(join(here, f), 'utf8')]);
// A told field: `told`, `told_at`, `hard_told`, `notified`, ... (audit 0b-6 r6 m-4 widened the names).
const FIELD = String.raw`\w*(?:told|notified|alerted|warned)\w*`;
// A write: `told_x: value` in an object, `x.told_x = value` (not `==`), or `x['told_x'] = value`.
const WRITE = new RegExp(String.raw`\b${FIELD}\s*:(?!:)|\.${FIELD}\s*=(?!=)`);
const BRACKET = new RegExp(String.raw`\[\s*(['"\x60])${FIELD}\1\s*\]\s*=(?!=)`);
const RESET = new RegExp(String.raw`\b${FIELD}\s*(:|=)\s*(false|null)\b`, 'g');

// The line with every `tellThen(...)` call cut out (balanced brackets), so a write after one is still seen.
function withoutTellThen(line) {
  let out = line;
  for (let i = out.indexOf('tellThen('); i >= 0; i = out.indexOf('tellThen(')) {
    let depth = 0, j = i + 'tellThen'.length;
    for (; j < out.length; j += 1) { if (out[j] === '(') depth += 1; else if (out[j] === ')' && (depth -= 1) === 0) break; }
    out = out.slice(0, i) + out.slice(j + 1);
  }
  return out;
}

export function untoldWrites(files) {
  const bad = [];
  for (const [f, text] of files) {
    text.split('\n').forEach((line, i) => {
      const code = withoutTellThen(line.replace(/\/\/.*$/, ''));
      const body = code.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''").replace(RESET, '');
      if (WRITE.test(body) || BRACKET.test(code.replace(RESET, ''))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

// L47: the alert port is called by the one sender only. Outside alerts.mjs the port (`p.alert`,
// `ports.alert`) appears only as the argument of `sendAlerts(`, and every `alert:` handed to a step is the
// outbox (`alert` from `outbox(rec, now)`, or `outbox(...)` itself).
export function directSends(files) {
  const bad = [];
  for (const [f, text] of files) {
    if (f === 'alerts.mjs') continue;
    text.split('\n').forEach((line, i) => {
      const body = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");
      const port = /\b(?:p|ports)\.alert\b/.test(body) && !/sendAlerts\([^)]*\b(?:p|ports)\.alert\b/.test(body);
      // `textAlerts(alert)` (alerts.mjs) only words an object alert for the step's own outbox.
      // `heldAlerts(into)` only keeps an M6 call's alerts for the step to send itself (L127); it never sends.
      const handed = [...body.matchAll(/\balert\s*:\s*([^,})\s]+)/g)].some((m) => m[1] !== 'alert' && !m[1].startsWith('outbox(') && m[1] !== 'textAlerts(alert' && !m[1].startsWith('heldAlerts('));
      const outboxMade = /\bconst\s+alert\s*=/.test(body) && !/\bconst\s+alert\s*=\s*outbox\(/.test(body);
      if (port || handed || outboxMade) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

test('r5 MAT-2 sweep: no alert site writes a told field outside tellThen', () => {
  assert.deepEqual(untoldWrites(code()), []);
});

test('r5 MAT-2 sweep: the names marked before the send are gone', () => {
  for (const [f, text] of code()) assert.doesNotMatch(text, /alerted/, f);
});

test('r5 MAT-2 sweep, control: a told write outside tellThen is caught; a reset, a read and a tellThen are not', () => {
  const files = [['x.mjs', [
    "putFact(rec, F, { text, told_at: iso(now) }, 'k');",
    'st.told = true;',
    "await tellThen(alert, t, () => putFact(rec, F, { told_at: iso(now) }, 'k'));",
    'Object.assign(st, { told: false, x: 1 });',
    "if (seen?.told_cause !== cause || st.told === true) return;",
    '// told_at: in a comment',
    "log(`it could not be told: ${e}`); x('told: no');",
  ].join('\n')]];
  assert.deepEqual(untoldWrites(files).map((l) => l.split(':')[1]), ['1', '2']);
  // r6 m-4: other names, bracket writes, and a write after a tellThen on the same line.
  const more = [['y.mjs', [
    "st.notified = true;",
    "doc['told_at'] = iso(now);",
    "tellThen(alert, t, { fact: F, fields: { told_at: x } }); st.told = true;",
    "tellThen(alert, `a ${b(c)} d`, { fact: F, fields: { told_at: iso(now) } });",
    "doc['told_at'] === x;",
  ].join('\n')]];
  assert.deepEqual(untoldWrites(more).map((l) => l.split(':')[1]), ['1', '2', '3']);
});

test('L47 sweep: no alert site sends directly; every step is handed the outbox', () => {
  assert.deepEqual(directSends(code()), []);
});

test('L47 sweep, control: a direct send, a port handed to a step, or an alert made another way is caught', () => {
  const files = [['tick.mjs', [
    'await p.alert(text);',
    'stopPass({ rec, alert: p.alert });',
    'undoStep({ rec, alert: (t) => send(t) });',
    'const alert = (t) => ports.alert(t);',
    'const alert = (t) => send(t);',
    'const alerts = await sendAlerts(rec, p.alert, now, {});',
    'undoStep({ rec, alert });',
    'holdAlert({ rec, alert: outbox(rec, now), now });',
    'const alert = outbox(rec, now);',
    'settleMerge({ record: rec, alert: textAlerts(send), now });',
    'settleMerge({ record: rec, alert: textAlerts(alert), now });',
    'reconcileMerge({ record: rec, alert: heldAlerts(said), now });',
    'reconcileMerge({ record: rec, alert: held, now });',
  ].join('\n')], ['alerts.mjs', 'await port(text); p.alert(x);']];
  assert.deepEqual(directSends(files).map((l) => l.split(':')[1]), ['1', '2', '3', '4', '5', '10', '13']);
});

// Audit 0b-6 r7 M2, as a class: every fact a told mark goes on has a step that drops the cause's queued
// entry where the cause clears (`dropCause(rec, <the same fact>`), or a line here saying why a copy
// delivered after the cause cleared is harmless.
export const LATE_MARK_OK = Object.freeze({
  HOLD_FACT: 'once per cause per day by design: a late copy is still a tell within that day',
  UNKNOWN_FACT: 'the mark carries the stretch it was for (`since`), and a new stretch is told again',
  factId: 'told keys count only while still in the last recorded set, so a key that left is told again',
  RESTART_FACT: 'once per Lead session, and a session id is never reused',
  REVIEW_ALERT_FACT: 'one fact per review runner alert (its id and time), so a late mark is on an alert that has been told',
  // L127: told notes, written as the mark of the alert they record.
  UNREAD_FACT: 'one per merge id, and a merge is one request, never reused: a late note is on a merge whose owner was told',
  RECONCILED_FACT: 'a refused merge whose PR shows merged stays so (a merged PR does not unmerge): a late note still holds',
  ASK_REFUSED_FACT: 'one per card and refusal count; a later refusal is a new count, told again',
  UNDO_NOTE_FACT: 'one per undo card, whose fix card is never written twice: a late note is on a fix card the Lead was told of',
  // L130: marks that carry what they told, so a later one of the same kind is told again.
  OUTAGE_FACT: 'the mark carries the outage it told (told_id); a new outage has a new id and is told again',
  WAIT_TELL_FACT: 'the mark carries the wait it told (told_since); a new wait has a new since and is told again',
  appliedId: 'the mark carries the state it told (told_state); a new hand-in under the name rewrites the fact without it',
  UNSAVED_FACT: 'one per stopped session, and a session id is never reused',
});

// The fact names each told mark goes on: `fact: NAME` inside a tellThen call (a call `NAME(...)` or a bare name).
export function markFacts(files) {
  const out = new Set();
  for (const [, text] of files) for (const m of text.matchAll(/tellThen\([^\n]*?\bfact:\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return [...out].sort();
}
export function undroppedCauses(files) {
  const all = files.map(([, t]) => t.replace(/\/\/.*$/gm, '')).join('\n');
  return markFacts(files).filter((n) => !(n in LATE_MARK_OK) && !new RegExp(String.raw`dropCause\(\s*rec\s*,\s*${n}\b`).test(all));
}

test('r7 M2 sweep: every told mark has a place its cause clears, or a reason a late mark is harmless', () => {
  const facts = markFacts(code());
  assert.ok(facts.length >= 9, facts.join(', '));
  assert.deepEqual(undroppedCauses(code()), []);
  for (const n of Object.keys(LATE_MARK_OK)) assert.ok(facts.includes(n), `${n} is listed but no told mark goes on it`);
});

test('r7 M2 sweep, control: a mark with no drop and no reason is caught; a dropped one, a commented drop and a listed one are not', () => {
  const files = [['x.mjs', [
    "tellThen(alert, 't', { fact: NEW_FACT(id), fields: { told_at: 1 } });",
    "tellThen(alert, 't', { fact: GONE_FACT(id), fields: { told_at: 1 } });",
    "tellThen(alert, 't', { fact: QUIET_FACT, fields: { told: true } });",
    "tellThen(alert, 't', { fact: HOLD_FACT(c), fields: { told_at: 1 } });",
    'dropCause(rec, GONE_FACT(id));',
    '// dropCause(rec, QUIET_FACT);',
  ].join('\n')]];
  assert.deepEqual(undroppedCauses(files), ['NEW_FACT', 'QUIET_FACT']);
});

// L127 (audit #68 r5 MAT-1), widened by L130 as a class: a told mark, a wait on Joe or a told note is written only
// after the alert answered something other than false. The allowed forms are tellThen, and
// `if (alert(...) !== false) { follow-up }`. Any other `alert(` call followed, in the same block, by a note, a told
// write or a wait (`note(`, `putFact(`, `waitOn(`, a told field) is refused: that write would stand whatever the
// queue answered.
const NOTE_WRITE = new RegExp(String.raw`\bnote\(|\bputFact\(|\bwaitOn\(|${WRITE.source}|${BRACKET.source}`);
export function notesAfterBareAlerts(files) {
  const bad = [];
  for (const [f, text] of files) {
    if (f === 'alerts.mjs') continue;
    // Block-comment lines (` * ...`, `/** ...`) are prose, not calls.
    const lines = text.split('\n').map((l) => (/^\s*(\*|\/\*)/.test(l) ? '' : withoutTellThen(l.replace(/\/\/.*$/, '')).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''")));
    const all = lines.join('\n');
    for (const m of all.matchAll(/(?<![\w$.])alert\(/g)) {
      // `alert(...) !== false` gates what follows on the answer: the allowed form. `=== false` is a notice that
      // records its own loss; what follows does not depend on it.
      let p = 0, k = m.index + 'alert'.length;
      for (; k < all.length; k += 1) { if (all[k] === '(') p += 1; else if (all[k] === ')' && (p -= 1) === 0) break; }
      if (/^\s*[!=]==?\s*false\b/.test(all.slice(k + 1))) continue;
      // The rest of the block the call is in: up to the brace that closes it.
      let depth = 0, j = m.index;
      for (; j < all.length; j += 1) { if (all[j] === '{') depth += 1; else if (all[j] === '}' && (depth -= 1) < 0) break; }
      const n = all.slice(0, m.index).split('\n').length;
      if (NOTE_WRITE.test(all.slice(m.index, j))) bad.push(`${f}:${n}: ${text.split('\n')[n - 1].trim()}`);
    }
  }
  return bad;
}

test('L127 sweep: no told note or told field is written after an alert outside tellThen', () => {
  assert.deepEqual(notesAfterBareAlerts(code()), []);
});

test('L127 sweep, control: a note, a putFact or a told write after a bare alert is caught; a tellThen, a note in another block, and an alert with no write after it are not', () => {
  const files = [['x.mjs', [
    'if (bad) {',
    "  alert(`a ${b}`);",
    "  note(rec, F(id), 'told', { now });",
    '}',
    "await alert('b'); putFact(rec, F, { x: 1 }, 'k');",
    'function h() {',
    "  if (x) alert('c');",
    '  st.told = true;',
    '}',
    "tellThen(alert, `d ${e(f)}`, { fact: F(id), fields: { text: 't', at: 1 }, kind: 'note' });",
    "note(rec, G, 'after a tellThen', { now });",
    "if (y) { alert('e'); }",
    "function g() { alert('f'); return 1; }",
    "p.alert('a port'); x.note(1);",
    '// alert(1); note(2);',
    "if (alert(`g ${h}`) !== false) { note(rec, F, 'told', { now }); }",
    "{ alert('i'); waitOn(rec, id, { who: 'joe' }); }",
    "{ if (alert('j') === false) out.push(1); note(rec, F, 'not about j', { now }); }",
    ' * alert(text) then note(x)',
  ].join('\n')]];
  assert.deepEqual(notesAfterBareAlerts(files).map((l) => l.split(':')[1]), ['2', '5', '7', '17']);
});
