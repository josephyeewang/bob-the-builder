// L373, L397: what M2 and M6 put on an alert is only useful if it reaches the delivered line. approvalsAlertText builds that line
// from known fields, so a field it does not know is dropped in silence: undo_by_hand carried the commit and the files
// to undo, and the owner read neither. These tests read every alert site in M2's source, so a new kind or a new field
// fails here until it is shown, or is listed in NOT_SHOWN, for that kind, with why. M6's alerts are read the same way
// against alertText, the words textAlerts sends them in; both lines read one list (alerts.mjs ALERT_FIELDS). One walk reads
// both modules, and a call it can't read fails until it is named as a pass-through (L408 MAT-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { STATES } from '../../shared/record.mjs';
import { approvalsAlertText } from './tick.mjs';
import { alertText, textAlerts, ALERT_LIST_MAX as APPROVALS_LIST_MAX } from './alerts.mjs';
import { markReverted } from '../M6-merge-gate/undo.mjs';
import { settleMerge } from '../M6-merge-gate/merge-outcome.mjs';

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
// On an alert, not on the line, on purpose: which field, on which kinds, and why. By kind, so a new kind carrying one of
// these fields is looked at, not let through by another kind's reason (L408 m2).
const NOT_SHOWN = {
  ask: { why: 'its text names it', kinds: ['ask_time_unreadable', 'withdrawn_pr_open'] },
  card: { why: 'its text names it', kinds: ['ask_time_unreadable'] },
  error: { why: "an exception's own text can hold anything, and the fixed reason beside it says what failed", kinds: ['ask_request_refused', 'undo_request_refused'] },
  files_known: { why: 'said by the line when false; see the unreadable-list test', kinds: ['undo_by_hand'] },
  product: { why: "the line starts with it, or the alert's own text names it", kinds: ['onboard_near_miss', 'onboard_refused', 'product_on'] },
  text: { why: "the alert's own words are the whole line; see the text test", kinds: ['ask_time_unreadable', 'onboard_near_miss', 'onboard_refused', 'product_on', 'withdrawn_pr_open'] },
};
// The kinds whose own text is the whole line, so everything else on them goes unseen. Pinned against the walk: a kind
// that becomes a text alert fails until someone looks at what it stops showing (L438 m-1).
const TEXT_KINDS = ['ask_time_unreadable', 'onboard_near_miss', 'onboard_refused', 'product_on', 'withdrawn_pr_open'];
// A text alert may leave these off the line only if its text says them: the template names the field's own value.
const NAMED_IN_TEXT = ['ask', 'card', 'pr', 'commit', 'files'];
const leftOff = (table, kind, field) => table[field]?.kinds.includes(kind) === true;
// Every kind-and-field a table lists is one the walk found, so the table can't outlive what it speaks for.
const pairs = (table) => Object.entries(table).flatMap(([field, { kinds }]) => kinds.map((k) => `${k} ${field}`)).sort();
const carried = (sites, table, shown) => [...new Set(sites.flatMap(({ kind, keys }) => keys.filter((k) => k in table && (!(k in shown) || keys.includes('text'))).map((k) => `${kind} ${k}`)))].sort();
// `...f` on a refused report: research-ask.mjs and undo-flag.mjs build it, and the test below holds it to these.
const SPREAD_F = ['report', 'reason', 'error'];

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

const noComments = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
// Where an alert object starts. M2 builds some as `notice = {...}` or `make: (f) => ({...})`, each sent by a call named below.
const OPENS = /\balert\(\{|\balertTaken\(alert, \{|\bonce\.alert\([^,]+,\s*\{|\bsent\(ctx,\s*\{|\bnotice = \{|\bmake: \(f\) => \(\{/g;

// Every object handed to an alert in these sources: [kind, its field names, where]. Each must name itself in words the
// walk can read, and a spread other than `...f` fails, so nothing is skipped in silence.
function sitesIn(list) {
  const out = [];
  for (const [file, src] of list) {
    const code = noComments(src);
    for (const m of code.matchAll(OPENS)) {
      const parts = topLevel(code, m.index + m[0].length - 1).map((x) => x.trim()).filter(Boolean);
      const name = parts.map((x) => /^(?:type|kind): (?:'([a-z_]+)'|(notSaved))$/.exec(x)).find(Boolean);
      assert.ok(name, `${file}: an alert with no name: ${parts.join(', ')}`);
      const values = {};
      const keys = parts.flatMap((x) => {
        if (x === '...f') return SPREAD_F;
        const maybe = /^\.\.\.\(\w+ \? \{ (\w+): (\w+) \} : \{\}\)$/.exec(x); // a field there only when it has a value
        if (maybe) { values[maybe[1]] = maybe[2]; return [maybe[1]]; }
        assert.ok(!x.startsWith('...'), `${file} ${name[1] ?? name[2]}: a spread this walk can't read: ${x}`);
        const [key, ...value] = x.split(':');
        values[key.trim()] = value.length ? value.join(':').trim() : key.trim();
        return [key.trim()];
      });
      out.push({ file, kind: name[1] ?? name[2], keys: keys.filter((k) => k !== 'type' && k !== 'kind'), values });
    }
  }
  return out;
}

// Every alert call in these sources that does not hold its object: `file call`.
function passThroughs(list) {
  return list.flatMap(([file, src]) => [...noComments(src).replace(OPENS, '').matchAll(/(?:\b\w+\.)?\b(?:alert|alertTaken|sent)\([^)\n]*/g)].map(([t]) => `${file} ${t}`)).sort();
}
const alertSites = () => sitesIn(sources);
const m6Sites = () => sitesIn(m6Sources);

// Nothing else may hand an alert on: an object built in a variable and sent by a call not named here fails the test below.
const PASS_THROUGHS = [
  'onboard.mjs ctx.alert(alert', // sent(): every notice below
  'onboard.mjs sent(ctx, notice', // the two `notice = {...}` objects
  'research-ask.mjs alert(make(f', 'research-ask.mjs alert(make(f', // onceAlerts: the `make` objects
  'research-ask.mjs ctx.alert(a', // safeAlert: what onceAlerts is handed
  'schedule.mjs alert(ask, e', // once.alert's own definition
  'schedule.mjs ctx.alert(e', // once.alert: its callers' objects
];
const M6_PASS_THROUGHS = [
  'merge-outcome.mjs alert(e', // alertTaken: its callers' objects
  'merge-outcome.mjs alertTaken(alert, e', // alertTaken's own definition
];

test('L408: every alert call in M2 and M6 is walked or named as a pass-through, so an object built elsewhere is not skipped', () => {
  assert.deepEqual(passThroughs(sources), PASS_THROUGHS);
  assert.deepEqual(passThroughs(m6Sources), M6_PASS_THROUGHS);
});

// What a pass-through hands on is what was walked, so nothing may change on an alert after its object was written (L421
// m-B, L438 m-2): no assignment of any kind, no Object.assign, no delete. A copy under another name is left to review.
const CHANGES_ALERT = [
  /\b(?:a|e|alert|notice)(?:\.\w+|\[[^\]]+\])\s*(?:[-+*/%|&^]|\?\?|&&|\|\|)?=(?![=>])/g,
  /\bObject\.assign\(\s*(?:a|e|alert|notice)\b/g,
  /\bdelete\s+(?:a|e|alert|notice)\b/g,
];
const changes = (src) => CHANGES_ALERT.flatMap((re) => [...noComments(src).matchAll(re)].map(([t]) => t));

test('L421, L438: no file with a pass-through changes an alert object after it is written', () => {
  const files = new Set([...PASS_THROUGHS, ...M6_PASS_THROUGHS].map((x) => x.split(' ')[0]));
  const changed = (list) => list.filter(([f]) => files.has(f)).flatMap(([f, src]) => changes(src).map((t) => `${f} ${t}`));
  assert.deepEqual([...changed(sources), ...changed(m6Sources)], []);
});

test('L438 controls: each way of changing an alert is read, and reading or comparing one is not', () => {
  for (const line of ['e.x = 1', 'e.reason += y', "e['gh_detail'] = y", 'e.gh_detail ??= y', 'a.n ||= 1', 'Object.assign(e, { x: 1 })', 'delete e.reason', "delete alert['x']"]) {
    assert.equal(changes(line).length, 1, line);
  }
  for (const line of ['if (e.x === 1) go()', 'if (a.n == 2) go()', 'const f = (e.x) => 1', 'if (e.n >= 2) go()', 'if (e.n != 2) go()', 'Object.assign(other, e)', 'delete other.e']) {
    assert.deepEqual(changes(line), [], line);
  }
});

test('L408 controls: the walk reads a template string, nested braces and a spread, and a hidden object is left for the check above', () => {
  const one = (src) => sitesIn([['x.mjs', src]]);
  const site = one("alert({ type: 'a_kind', card: id, text: `one ${c ? `{${d}}` : '}'}, two`, reason: f({ b: 1, c }) });")[0];
  assert.deepEqual([site.file, site.kind, site.keys, site.values.card], ['x.mjs', 'a_kind', ['card', 'text', 'reason'], 'id']);
  assert.throws(() => one("alert({ text: 'no name' });"), /an alert with no name/);
  assert.throws(() => one("alert({ type: 'a_kind', ...more });"), /a spread this walk can't read/);
  assert.deepEqual(one("alert({ type: 'a_kind', ...(x ? { card: x } : {}) });")[0].keys, ['card']);
  assert.deepEqual(one('alert(hidden);'), []);
  assert.deepEqual(passThroughs([['x.mjs', "ctx.alert(hidden);\nalert({ type: 'a_kind' });"]]), ['x.mjs ctx.alert(hidden']);
});

test('L373: the source read holds every M2 alert kind, so the checks below are not checking nothing', () => {
  assert.deepEqual([...new Set(alertSites().map((x) => x.kind))].sort(), [
    'approval_not_counted', 'approvals_config', 'approvals_no_pull_request', 'approvals_no_push', 'approvals_untrusted', 'approvals_write_refused',
    'ask_request_refused', 'ask_time_unreadable', 'decision_pr_not_closed', 'decision_pr_not_opened', 'go_card_unreadable', 'go_not_shown', 'notSaved', 'onboard_near_miss', 'onboard_refused',
    'product_on', 'push_not_sent', 'review_not_requested', 'transcript_tampered', 'undo_by_hand', 'undo_by_hand_mark_failed', 'undo_request_refused', 'untrusted_ask', 'withdrawn_pr_open',
  ]);
  const undo = alertSites().find((x) => x.kind === 'undo_by_hand');
  assert.deepEqual(undo.keys, ['ask', 'card', 'pr', 'commit', 'files', 'files_known']);
  for (const f of ['research-ask.mjs', 'undo-flag.mjs']) {
    assert.ok(sources.find(([n]) => n === f)[1].includes('refused.push({ report: rep.id, reason, ...(error === undefined ? {} : { error }) })'), `${f}: what \`...f\` holds has changed`);
  }
});

test('L373: every field of every M2 alert reaches the delivered line, or is listed as left off with why', () => {
  for (const { file, kind, keys } of alertSites()) {
    const unknown = keys.filter((k) => !(k in SHOWN) && !leftOff(NOT_SHOWN, kind, k));
    assert.deepEqual(unknown, [], `${file} ${kind}: shown nowhere and not listed for this kind in NOT_SHOWN`);
    // Its text is the whole line, so nothing else shows: each other field must be listed, for this kind, with why (L421).
    if (keys.includes('text')) {
      assert.deepEqual(keys.filter((k) => k !== 'text' && !leftOff(NOT_SHOWN, kind, k)), [], `${file} ${kind}: its text is the whole line, so this field never shows`);
      continue;
    }
    const shown = keys.filter((k) => k in SHOWN);
    const line = approvalsAlertText('p-7', { type: kind, ...Object.fromEntries(shown.map((k) => [k, SHOWN[k][0]])) });
    for (const k of shown) assert.ok(line.includes(SHOWN[k][1]), `${file} ${kind}: ${k} is not in: ${line}`);
  }
});

test('L438: leaving a field off the line takes a reason, and a text alert may do it only where its text says the field', () => {
  for (const [field, { why }] of [...Object.entries(NOT_SHOWN), ...Object.entries(M6_NOT_SHOWN)]) {
    assert.ok(typeof why === 'string' && why.trim() !== '', `${field}: no reason it is left off`);
  }
  const textSites = [...alertSites(), ...m6Sites()].filter(({ keys }) => keys.includes('text'));
  assert.deepEqual([...new Set(textSites.map(({ kind }) => kind))].sort(), TEXT_KINDS, 'a kind that carries its own text must be pinned here, after looking at what it stops showing');
  for (const { file, kind, keys, values } of textSites) {
    for (const k of keys.filter((x) => NAMED_IN_TEXT.includes(x))) {
      assert.ok(values.text.includes(`\${${values[k]}}`), `${file} ${kind}: ${k} is left off the line, but its text does not name \${${values[k]}}`);
    }
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

const M6 = join(dirname(fileURLToPath(import.meta.url)), '..', 'M6-merge-gate');
const m6Sources = readdirSync(M6).filter((f) => f.endsWith('.mjs') && !f.includes('.test')).map((f) => [f, readFileSync(join(M6, f), 'utf8')]);

const M6_SHOWN = {
  ...SHOWN,
  merge: ['M-7', 'merge M-7'],
  to: ['merged', 'moving to merged'],
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
  again: { why: "the note's own words say it", kinds: ['merge_limit_missing'] },
  outage: { why: "the note's own words say it", kinds: ['merge_waiting_long'] },
  waiting_on: { why: "the note's own words list it", kinds: ['merge_waiting_long'] },
};

test('L408 m2: every left-off field is listed by the kind that carries it, and no listing is left over', () => {
  assert.deepEqual(pairs(NOT_SHOWN), carried(alertSites(), NOT_SHOWN, SHOWN));
  assert.deepEqual(pairs(M6_NOT_SHOWN), carried(m6Sites(), M6_NOT_SHOWN, M6_SHOWN));
});

test('L397: the source read holds every M6 alert kind, so the checks below are not checking nothing', () => {
  assert.deepEqual([...new Set(m6Sites().map((x) => x.kind))].sort(), [
    'merge_gate_unsure', 'merge_gate_write_refused', 'merge_interrupted', 'merge_limit_missing', 'merge_mark_failed', 'merge_marked_after_audit', 'merge_parent_moved',
    'merge_refused', 'merge_waiting_long', 'undo_not_marked',
  ]);
  assert.deepEqual(m6Sites().find((x) => x.kind === 'merge_marked_after_audit').keys, ['merge', 'commit', 'ask_owner']);
});

test('L397: every field of every M6 alert reaches the delivered line, or is listed as left off with why', () => {
  for (const { file, kind, keys } of m6Sites()) {
    const unknown = keys.filter((k) => !(k in M6_SHOWN) && !leftOff(M6_NOT_SHOWN, kind, k));
    assert.deepEqual(unknown, [], `${file} ${kind}: shown nowhere and not listed for this kind in M6_NOT_SHOWN`);
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
  assert.equal(alertText({ type: 'merge_gate_write_refused', merge: 'M-1', to: 'told', reason: 'r' }), 'merge gate: r (merge M-1, writing told)');
});

// MAT-1: which record a refused write was on is the point of the line. Every site names one, and settleMerge names the card.
test('L408: every refused-write alert names what it could not write', () => {
  const sites = m6Sites().filter((x) => x.kind === 'merge_gate_write_refused');
  assert.ok(sites.length > 10, 'the walk found them');
  for (const { file, keys } of sites) assert.ok(keys.includes('merge') || keys.includes('card'), `${file}: names neither: ${keys}`);
});

const REFUSED_CARD = () => {
  const docs = { 'merge:M-1': { id: 'M-1', rev: 1, doc: { state: 'merging', pr: 7, card: 'C-9', judged_head: 'h1' } }, 'card:C-9': { id: 'C-9', rev: 1, doc: { state: 'merging' } } };
  const record = {
    read: (e, id) => docs[`${e}:${id}`] ?? null,
    write: ({ entity, id, doc }) => { if (entity === 'card') return { ok: false, reason: 'stale rev' }; docs[`${entity}:${id}`] = { id, rev: 2, doc }; return { ok: true }; },
  };
  const said = fakeAlert();
  return { record, said, alert: textAlerts(said) };
};

test('L408 MAT-1: a refused card write names the card, not only the merge that did move', () => {
  const merged = REFUSED_CARD();
  settleMerge({ record: merged.record, alert: merged.alert, now: 0 }, 'M-1', { pr: { merged: true, merge_commit_sha: 'a'.repeat(40), head_sha: 'h1', state: 'closed' }, reason: 'x' });
  assert.deepEqual(merged.said.calls.map(([t]) => t), ['merge gate: stale rev (merge M-1, card C-9, moving to merged)']);
  const back = REFUSED_CARD();
  settleMerge({ record: back.record, alert: back.alert, now: 0 }, 'M-1', { reason: 'timeout' });
  assert.deepEqual(back.said.calls.map(([t]) => t), ['merge gate: stale rev (merge M-1, card C-9, moving to in_review)']);
});

test('L408 MAT-1: a refused write of the merge itself names no card', () => {
  const { record, said, alert } = REFUSED_CARD();
  const real = record.write;
  record.write = (w) => (w.entity === 'merge' ? { ok: false, reason: 'stale rev' } : real(w));
  settleMerge({ record, alert, now: 0 }, 'M-1', { pr: { merged: true, merge_commit_sha: 'a'.repeat(40), head_sha: 'h1', state: 'closed' }, reason: 'x' });
  assert.deepEqual(said.calls.map(([t]) => t), ['merge gate: stale rev (merge M-1, moving to merged)']);
  const raw = REFUSED_CARD();
  raw.record.write = (w) => ({ ok: false, reason: `${w.entity} refused` });
  const got = fakeAlert();
  settleMerge({ record: raw.record, alert: got, now: 0 }, 'M-1', { pr: { merged: true, merge_commit_sha: 'a'.repeat(40), head_sha: 'h1', state: 'closed' }, reason: 'x' });
  assert.deepEqual(got.calls.map(([e]) => e), [{ type: 'merge_gate_write_refused', merge: 'M-1', to: 'merged', reason: 'merge refused' }]);
  assert.ok(!Object.hasOwn(got.calls[0][0], 'card'), 'no card field at all');
});

// m3: every value a site gives `to` reads true: a state is moved to, anything else is only being written.
test('L408 m3: `to` says moving only for a state of a merge or a card', () => {
  const tos = [...m6Sources.flatMap(([, src]) => [...noComments(src).matchAll(/type: 'merge_gate_write_refused'[^}]*\bto: '([^']+)'/g)].map((m) => m[1]))];
  assert.ok(tos.length > 10, 'the walk found them');
  for (const to of new Set(tos)) assert.match(alertText({ merge: 'M-1', to }), STATES.merge.includes(to) ? /moving to / : /writing /, to);
  assert.equal(alertText({ type: 't', merge: 'M-1', to: 'late mark told', reason: 'r' }), 'merge gate: r (merge M-1, writing late mark told)');
  // By the record the alert names: a card has an in_review state, a merge does not.
  assert.equal(alertText({ type: 't', merge: 'M-1', to: 'in_review', reason: 'r' }), 'merge gate: r (merge M-1, writing in_review)');
  assert.equal(alertText({ type: 't', merge: 'M-1', card: 'C-1', to: 'in_review', reason: 'r' }), 'merge gate: r (merge M-1, card C-1, moving to in_review)');
  assert.equal(alertText({ type: 't', card: 'C-1', to: 'merging', reason: 'r' }), 'merge gate: r (card C-1, moving to merging)');
  assert.equal(alertText({ type: 't', merge: 'M-1', to: 'merging', reason: 'r' }), 'merge gate: r (merge M-1, moving to merging)');
});

test('L408 m1: a question that is not text stays off the line, and an item that is not text is counted, never dropped', () => {
  assert.equal(alertText({ type: 't', ask_owner: false }), 'merge gate: t');
  assert.equal(alertText({ type: 't', ask_owner: { a: 1 } }), 'merge gate: t');
  assert.equal(alertText({ type: 't', reasons: [{}] }), 'merge gate: t: reasons: 1 more');
  assert.equal(alertText({ type: 't', reasons: ['why', {}, 3] }), 'merge gate: t: reasons: why and 2 more');
  assert.equal(approvalsAlertText('p2', { type: 'undo_by_hand', files: [{}], files_known: true }), 'Approvals, p2: undo by hand: added files: 1 more');
  assert.equal(approvalsAlertText('p2', { type: 'x', items: ['ask/A-1', {}] }), 'Approvals, p2: x (2 items): ask/A-1 and 1 more');
  assert.equal(alertText({ type: 't', reasons: [] }), 'merge gate: t');
});

test('L408 c3: a note or reason with a line break stays one line', () => {
  assert.equal(alertText({ note: 'one\ntwo\r\n\tthree', merge: 'M-1' }), 'merge gate: one two three (merge M-1)');
  assert.equal(alertText({ reason: 'a\nb' }), 'merge gate: a b');
  const long = 'n'.repeat(500);
  assert.equal(alertText({ note: long }), `merge gate: ${long}`, 'cleaned, not cut');
});

test('L397: a line with only a merge reads as it always did; text stays text; a list is capped', () => {
  assert.equal(alertText({ type: 'merge_gate_unsure', merge: 'M-1', note: 'n' }), 'merge gate: n (merge M-1)');
  assert.equal(alertText('already words'), 'already words');
  assert.equal(alertText({}), 'merge gate: no detail');
  const reasons = Array.from({ length: APPROVALS_LIST_MAX + 2 }, (_, i) => `r${i}`);
  assert.ok(alertText({ type: 'merge_refused', note: 'n', reasons }).endsWith(' and 2 more'));
  assert.ok(!alertText({ note: 'n', status: 422, token: 'secret-value', response: { body: 'x' } }).includes('secret-value'));
});
