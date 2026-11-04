// L373, L397: what M2 and M6 put on an alert is only useful if it reaches the delivered line. approvalsAlertText builds that line
// from known fields, so a field it does not know is dropped in silence: undo_by_hand carried the commit and the files
// to undo, and the owner read neither. These tests read every alert site in M2's source, so a new kind or a new field
// fails here until it is shown, or is listed in NOT_SHOWN with why. M6's alerts are read the same way against alertText,
// the words textAlerts sends them in; both lines read one list (alerts.mjs ALERT_FIELDS).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalsAlertText } from './tick.mjs';
import { alertText, textAlerts, ALERT_LIST_MAX as APPROVALS_LIST_MAX } from './alerts.mjs';
import { markReverted } from '../M6-merge-gate/undo.mjs';

const M2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'M2-approvals');
const sources = readdirSync(M2).filter((f) => f.endsWith('.mjs') && !f.includes('.test')).map((f) => [f, readFileSync(join(M2, f), 'utf8')]);

// A field's sample value, and what the line must then say.
const SHOWN = {
  ask: ['A-7', 'ask A-7'],
  card: ['C-7', 'card C-7'],
  session: ['S-7', 'session S-7'],
  pr: [77, 'PR 77'],
  commit: ['abc1234def', 'commit abc1234def'],
  report: ['R-7', 'report R-7'],
  reason: ['the reason words', 'the reason words'],
  files: [['src/one.txt', 'src/two.txt'], 'added files: src/one.txt, src/two.txt'],
  items: [['ask/A-8', 'ask/A-9'], '2 items): ask/A-8, ask/A-9'],
};
// On an alert, not on the line, on purpose.
const NOT_SHOWN = {
  error: "an exception's own text can hold anything, and the fixed reason beside it says what failed",
  files_known: 'said by the line when false; see the unreadable-list test',
  product: 'the line starts with it, or the alert\'s own text names it',
  text: 'the alert\'s own words are the whole line; see the text test',
};
// `...f` on a refused report: research-ask.mjs and undo-flag.mjs build it, and the test below holds it to these.
const SPREAD_F = ['report', 'reason', 'error'];

// Every object handed to an alert in M2's source: [kind, its field names, where].
const objectsAt = /(?:\balert\(|\bonce\.alert\([^,]+,\s*|\bsent\(ctx,\s*|\bnotice = |\bmake: \(f\) => \()\{([^{}]*)\}/g;
function alertSites() {
  const out = [];
  for (const [file, src] of sources) {
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    for (const [, body] of code.matchAll(objectsAt)) {
      const keys = body.replace(/\([^()]*\)/g, '()').split(',').map((x) => x.trim()).filter(Boolean).flatMap((x) => (x === '...f' ? SPREAD_F : [x.split(':')[0].trim()]));
      const name = /(?:type|kind): (?:'([a-z_]+)'|(notSaved))/.exec(body);
      assert.ok(name, `${file}: an alert with no name: ${body}`);
      out.push({ file, kind: name[1] ?? name[2], keys: keys.filter((k) => k !== 'type' && k !== 'kind') });
    }
  }
  return out;
}

test('L373: the source read holds every M2 alert kind, so the checks below are not checking nothing', () => {
  assert.deepEqual([...new Set(alertSites().map((x) => x.kind))].sort(), [
    'approval_not_counted', 'approvals_config', 'approvals_no_pull_request', 'approvals_no_push', 'approvals_untrusted', 'approvals_write_refused',
    'ask_request_refused', 'decision_pr_not_closed', 'decision_pr_not_opened', 'go_not_shown', 'notSaved', 'onboard_near_miss', 'onboard_refused',
    'product_on', 'push_not_sent', 'review_not_requested', 'transcript_tampered', 'undo_by_hand', 'undo_by_hand_mark_failed', 'undo_request_refused', 'untrusted_ask',
  ]);
  const undo = alertSites().find((x) => x.kind === 'undo_by_hand');
  assert.deepEqual(undo.keys, ['ask', 'card', 'pr', 'commit', 'files', 'files_known']);
  for (const f of ['research-ask.mjs', 'undo-flag.mjs']) {
    assert.ok(sources.find(([n]) => n === f)[1].includes('refused.push({ report: rep.id, reason, ...(error === undefined ? {} : { error }) })'), `${f}: what \`...f\` holds has changed`);
  }
});

test('L373: every field of every M2 alert reaches the delivered line, or is listed as left off with why', () => {
  for (const { file, kind, keys } of alertSites()) {
    const unknown = keys.filter((k) => !(k in SHOWN) && !(k in NOT_SHOWN));
    assert.deepEqual(unknown, [], `${file} ${kind}: shown nowhere and not listed in NOT_SHOWN`);
    if (keys.includes('text')) continue;
    const shown = keys.filter((k) => k in SHOWN);
    const line = approvalsAlertText('p-7', { type: kind, ...Object.fromEntries(shown.map((k) => [k, SHOWN[k][0]])) });
    for (const k of shown) assert.ok(line.includes(SHOWN[k][1]), `${file} ${kind}: ${k} is not in: ${line}`);
  }
});

test('L373: an undo by hand tells the owner the commit and each file to take out', () => {
  assert.equal(approvalsAlertText('p2', { type: 'undo_by_hand', ask: 'A-1', card: 'C-1', pr: 12, commit: 'abc1234', files: ['src/new.txt', 'db/add.sql'], files_known: true }),
    'Approvals, p2: undo by hand (ask A-1, card C-1, PR 12, commit abc1234): added files: src/new.txt, db/add.sql');
});

test('L373: an undo by hand whose file list could not be read says so, never just lists nothing', () => {
  assert.equal(approvalsAlertText('p2', { type: 'undo_by_hand', ask: 'A-1', pr: 12, commit: 'abc1234', files: [], files_known: false }),
    'Approvals, p2: undo by hand (ask A-1, PR 12, commit abc1234): its file list could not be read');
});

test('L373: a long list is capped with what is left, and one with no names is only counted', () => {
  const files = Array.from({ length: APPROVALS_LIST_MAX + 3 }, (_, i) => `f${i + 1}.txt`);
  const line = approvalsAlertText('p2', { type: 'undo_by_hand', ask: 'A-1', files, files_known: true });
  assert.ok(line.endsWith(`f${APPROVALS_LIST_MAX}.txt and 3 more`), line);
  assert.doesNotMatch(line, new RegExp(`f${APPROVALS_LIST_MAX + 1}\\.txt`));
  assert.equal(approvalsAlertText('p2', { type: 'x', items: [1, 2] }), 'Approvals, p2: x (2 items)');
});

test('L373: an alert named by its kind alone is told by that name, once, with its fields', () => {
  assert.equal(approvalsAlertText('p2', { kind: 'ask_request_refused', report: 'R-1', reason: 'no card' }), 'Approvals, p2: ask request refused (report R-1): no card');
  assert.equal(approvalsAlertText('p2', { kind: 'untrusted_ask', items: ['ask/A-1'] }), 'Approvals, p2: untrusted ask (1 item): ask/A-1');
  // An alert with a type keeps its kind as a field.
  assert.equal(approvalsAlertText('p2', { type: 'pushed', kind: 'go' }), 'Approvals, p2: pushed (kind go)');
});

test('L373: an alert with its own words is told as they are', () => {
  assert.equal(approvalsAlertText('p2', { type: 'product_on', product: 'p2', text: 'p2 is now on.' }), 'p2 is now on.');
});

test('L373: what is not a known field still never reaches the line', () => {
  const line = approvalsAlertText('p2', { type: 'x', error: 'token abc', token: 'secret-value', files: [{ path: 'not a name' }], items: [{ body: 'gh says' }] });
  assert.doesNotMatch(line, /abc|secret|gh says|not a name/);
});

// M6. Its alert objects hold template text with braces and commas, so they are walked, not matched.
const M6 = join(dirname(fileURLToPath(import.meta.url)), '..', 'M6-merge-gate');
const m6Sources = readdirSync(M6).filter((f) => f.endsWith('.mjs') && !f.includes('.test')).map((f) => [f, readFileSync(join(M6, f), 'utf8')]);

// The object at src[at], as its top-level `key: value` texts. Strings and templates are skipped, ${...} included.
function topLevel(src, at) {
  const parts = [];
  const opens = [];
  let start = at + 1;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    const top = opens.at(-1);
    if (top === "'" || top === '"') { if (c === '\\') i++; else if (c === top) opens.pop(); continue; }
    if (top === '`') {
      if (c === '\\') i++; else if (c === '`') opens.pop(); else if (c === '$' && src[i + 1] === '{') { opens.push('{'); i++; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') opens.push(c);
    else if ('([{'.includes(c)) opens.push(c);
    else if (')]}'.includes(c)) { opens.pop(); if (!opens.length) { parts.push(src.slice(start, i)); return parts; } }
    else if (c === ',' && opens.length === 1) { parts.push(src.slice(start, i)); start = i + 1; }
  }
  throw new Error('an alert object never closed');
}

function m6Sites() {
  const out = [];
  for (const [file, src] of m6Sources) {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const m of code.matchAll(/\balert\(\{|\balertTaken\(alert, \{/g)) {
      const parts = topLevel(code, m.index + m[0].length - 1).map((x) => x.trim()).filter(Boolean);
      const keys = parts.map((x) => x.split(':')[0].trim());
      const name = /^type: '([a-z_]+)'/.exec(parts[0]);
      assert.ok(name, `${file}: an alert with no type first: ${parts[0]}`);
      out.push({ file, kind: name[1], keys: keys.filter((k) => k !== 'type') });
    }
  }
  return out;
}

const M6_SHOWN = {
  ...SHOWN,
  merge: ['M-7', 'merge M-7'],
  to: ['refused', 'moving to refused'],
  context: ['ci/audit', 'check ci/audit'],
  status: [422, 'status 422'],
  judged_main: ['aaa111', 'judged main aaa111'],
  parent: ['bbb222', 'parent bbb222'],
  waiting_since: ['2026-11-03T00:00:00.000Z', 'waiting since 2026-11-03T00:00:00.000Z'],
  reasons: [['first why', 'second why'], 'reasons: first why, second why'],
  ask_owner: ['Re-run the audit on this commit?', 'Re-run the audit on this commit?'],
  note: ['the note words', 'the note words'],
};
const M6_NOT_SHOWN = {
  again: "the note's own words say it",
  outage: "the note's own words say it",
  waiting_on: "the note's own words list it",
};

test('L397: the source read holds every M6 alert kind, so the checks below are not checking nothing', () => {
  assert.deepEqual([...new Set(m6Sites().map((x) => x.kind))].sort(), [
    'merge_gate_unsure', 'merge_gate_write_refused', 'merge_interrupted', 'merge_limit_missing', 'merge_mark_failed', 'merge_marked_after_audit', 'merge_parent_moved',
    'merge_refused', 'merge_waiting_long', 'undo_not_marked',
  ]);
  assert.deepEqual(m6Sites().find((x) => x.kind === 'merge_marked_after_audit').keys, ['merge', 'commit', 'ask_owner']);
});

test('L397: every field of every M6 alert reaches the delivered line, or is listed as left off with why', () => {
  for (const { file, kind, keys } of m6Sites()) {
    const unknown = keys.filter((k) => !(k in M6_SHOWN) && !(k in M6_NOT_SHOWN));
    assert.deepEqual(unknown, [], `${file} ${kind}: shown nowhere and not listed in M6_NOT_SHOWN`);
    const shown = keys.filter((k) => k in M6_SHOWN);
    const sample = Object.fromEntries(shown.map((k) => [k, M6_SHOWN[k][0]]));
    const line = alertText({ type: kind, ...sample });
    // A note is read first; a reason beside one would be lost, so no site may carry both.
    assert.ok(!(keys.includes('note') && keys.includes('reason')), `${file} ${kind}: a note and a reason, and the line says one`);
    for (const k of shown) assert.ok(line.includes(M6_SHOWN[k][1]), `${file} ${kind}: ${k} is not on "${line}"`);
  }
});

test('L397: an undo that could not be marked names its card, and a refused card write its card and where it was going', () => {
  const sent = [];
  const record = { read: () => null, list: () => [] };
  markReverted({ record, alert: textAlerts((t) => { sent.push(t); return true; }) }, 'C-44');
  assert.deepEqual(sent, ['merge gate: not a merged undo card (card C-44)']);
  assert.equal(alertText({ type: 'merge_gate_write_refused', card: 'C-5', to: 'merged', reason: 'r' }), 'merge gate: r (card C-5, moving to merged)');
  assert.equal(alertText({ type: 'merge_gate_write_refused', merge: 'M-1', to: 'told', reason: 'r' }), 'merge gate: r (merge M-1, moving to told)');
});

test('L397: a line with only a merge reads as it always did; text stays text; a list is capped', () => {
  assert.equal(alertText({ type: 'merge_gate_unsure', merge: 'M-1', note: 'n' }), 'merge gate: n (merge M-1)');
  assert.equal(alertText('already words'), 'already words');
  assert.equal(alertText({}), 'merge gate: no detail');
  const reasons = Array.from({ length: APPROVALS_LIST_MAX + 2 }, (_, i) => `r${i}`);
  assert.ok(alertText({ type: 'merge_refused', note: 'n', reasons }).endsWith(' and 2 more'));
  assert.ok(!alertText({ note: 'n', status: 422, token: 'secret-value', response: { body: 'x' } }).includes('secret-value'));
});
