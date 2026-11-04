// L373: what M2 puts on an alert is only useful if it reaches the delivered line. approvalsAlertText builds that line
// from known fields, so a field it does not know is dropped in silence: undo_by_hand carried the commit and the files
// to undo, and the owner read neither. These tests read every alert site in M2's source, so a new kind or a new field
// fails here until it is shown, or is listed in NOT_SHOWN with why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalsAlertText, APPROVALS_LIST_MAX } from './tick.mjs';

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
