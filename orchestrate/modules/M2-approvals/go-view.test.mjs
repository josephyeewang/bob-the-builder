// go-view.test.mjs — R-0b-138 / R-0b-139: a go shows the plan in three lines; a Tier-1 go only after a fresh plan
// reviewer's pass, with "audited until 0 Material"; every go's fold lists the files the go binds, and on 10 sample gos
// the fold, the push, the question box, the decision file and the pull request body GitHub shows all list the same files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/plan-fingerprint.mjs';
import { env, OWNER_ID, must } from './fixtures.test-helper.mjs';
import { leadCard } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { openDecision } from './decision.mjs';
import { doneBar, goFingerprint, raiseGo } from './go.mjs';
import { foldFiles, goMarkdown, goText, goView, undoPushText } from './go-view.mjs';
import { schedulePass } from './schedule.mjs';
import { readBack, numberWork, sortRequest } from '../M1-front-door/sort.mjs';
import { readFileSync } from 'node:fs';

const SKILL = readFileSync(new URL('../M1-front-door/skill/orchestrate/SKILL.md', import.meta.url), 'utf8');
const W8 = Date.parse('2026-10-01T15:00:00Z');   // 08:00 in Los Angeles
const ALL = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'lib/deep/d.mjs', 'lib/e.mjs', 'docs/f.md', 'test/g.test.mjs', 'app/h.tsx', 'app/i.tsx', 'db/j.sql', 'db/k.sql', 'src/l_m.mjs'];
// A pass names what the reviewer read: the card and its whole plan fingerprint (audit r1 M-2), from goFingerprint.
const PASS = (ctx, card, sha) => ({ pass: true, material: 0, card, fingerprint: goFingerprint(ctx, card).fingerprint, plan_sha256: sha, reviewer_session: 'S-review', author_session: 'S-lead' });

function world() {
  const t = env();
  const pushes = [];
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t });
  const M0 = g.repo.commit([], Object.fromEntries(ALL.map((f) => [f, 'one'])));
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app', stateDir: join(t.base, 'm2-state'), push: (e) => { pushes.push(e); return true; } });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  t.clock.t = W8 - 3600_000;
  return { t, g, view, M0, pushes };
}

const rowsFor = (id, tier, n = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${id}-R${i + 1}`,
  { id: `${id}-R${i + 1}`, what: `row ${i + 1}`, module: 'M1', tier, done_when: `the ${id} check ${i + 1} passes\nwith its second line`, status: 'planned' }]));

async function raise(w, id, { tier, files, rows = 1, planCheck, noPass = false } = {}) {
  const sha = String(id).charCodeAt(1).toString(16).padStart(2, '0').repeat(32).slice(0, 64);
  const rs = rowsFor(id, tier, rows);
  leadCard(w.t, id, { what: `Card ${id}`, done_when: doneBar(rs), files, tier, ...(tier === 1 ? { plan_sha256: sha, main_commit: w.M0 } : {}) });
  return raiseGo(w.t.ctx, { cardId: id, rows: rs, view: w.view, mainSha: w.M0, title: 'a title nobody reviewed', ...(tier === 1 && !noPass ? { planCheck: planCheck ?? PASS(w.t.ctx, id, sha) } : {}) });
}

const SAMPLES = [
  { id: 'A1', tier: 2, files: ['src/a.mjs'] },
  { id: 'A2', tier: 2, files: ['src/b.mjs', 'src/a.mjs'] },
  { id: 'A3', tier: 2, files: ['lib/deep/d.mjs', 'lib/e.mjs', 'docs/f.md'], rows: 2 },
  { id: 'A4', tier: 2, files: ['test/g.test.mjs', 'app/h.tsx', 'app/i.tsx', 'src/c.mjs'] },
  { id: 'A5', tier: 2, files: ['src/l_m.mjs', 'db/j.sql'] },
  { id: 'B1', tier: 1, files: ['db/j.sql'] },
  { id: 'B2', tier: 1, files: ['db/j.sql', 'db/k.sql', 'src/a.mjs'] },
  { id: 'B3', tier: 1, files: ['app/h.tsx', 'lib/deep/d.mjs'], rows: 3 },
  { id: 'B4', tier: 1, files: ALL.slice(0, 9) },
  { id: 'B5', tier: 1, files: ['src/l_m.mjs'] },
];

const diff = (a, b) => [...a.filter((f) => !b.includes(f)), ...b.filter((f) => !a.includes(f))].length + (a.length === b.length ? 0 : 1);
const viewFiles = (text) => text.split('\n').slice(text.split('\n').findIndex((l) => /^Files this go allows \(\d+\):$/.test(l)) + 1).map((l) => l.replace(/^- /, ''));

test('R-0b-139: on 10 sample gos the fold\'s files are the bound files everywhere the owner reads them (diff 0)', async () => {
  const w = world();
  const ids = {};
  for (const s of SAMPLES) { const r = await raise(w, s.id, s); assert.equal(r.ok, true, `${s.id}: ${r.reason}`); ids[s.id] = r.id; }
  w.t.clock.t = W8;
  await schedulePass(w.t.ctx);
  for (const s of SAMPLES) {
    const doc = askStore(w.t.record).ask(ids[s.id]).doc;
    const v = goView(doc);
    assert.equal(v.ok, true, `${s.id}: ${v.reason}`);
    const bound = doc.files;
    assert.equal(diff(v.fold.files, bound), 0, `${s.id}: fold vs the go's bound list`);
    assert.equal(diff(bound, doc.fingerprint_inputs.files), 0, `${s.id}: bound list vs the fingerprint's`);
    assert.equal(v.fold.summary, `Files this go allows (${bound.length})`);
    if (s.tier === 2) {
      const push = w.pushes.find((p) => p.ask === ids[s.id]);
      assert.ok(push, `${s.id} was pushed`);
      assert.equal(push.view, goText(v));
      assert.equal(diff(viewFiles(push.view), bound), 0, `${s.id}: the push's fold`);
      assert.equal(diff(doc.payload.questions[0].options[0].description.replace(/^Files: /, '').split(', '), bound), 0, `${s.id}: the question box`);
    } else {
      // Tier 1: the decision pull request. Read it back from GitHub as the owner's Approve view shows it.
      const pr = doc.pr ?? (await openDecision(w.t.ctx, ids[s.id])).pr;
      assert.ok(Number.isSafeInteger(pr), `${s.id} has its decision pull request`);
      const got = await w.t.ctx.gh.get(`/repos/sample-org/sample-app/pulls/${pr}`);
      const body = got.json.body;
      assert.equal(body, `${goMarkdown(v)}\nAsk ${ids[s.id]}.\n`);
      assert.equal(diff(foldFiles(body), bound), 0, `${s.id}: the pull request's fold`);
      const file = JSON.parse(w.g.repo.files(w.g.pulls.get(pr).head).get(`decisions/go-${s.id}.json`).text);
      assert.equal(diff(file.plan.files, foldFiles(body)), 0, `${s.id}: the decision file vs the body`);
      assert.match(body, /audited until 0 Material/);
      assert.match(body, /<details><summary>Files this go allows/);
    }
  }
});

test('R-0b-138: the go view is three lines; Tier 1 says checked, number work and "audited until 0 Material"', async () => {
  const w = world();
  const r2 = await raise(w, 'C1', { tier: 2, files: ['src/a.mjs', 'src/b.mjs'], rows: 2 });
  const v2 = goView(askStore(w.t.record).ask(r2.id).doc);
  assert.equal(v2.lines.length, 3);
  assert.match(v2.lines[0], /^Go\? Card C1 \(C1\), Tier 2\.$/);
  assert.match(v2.lines[1], /^Plan [0-9a-f]{12}: 2 files\.$/);
  assert.equal(v2.lines[2], 'Pass test: the C1 check 1 passes (and 1 more row).');
  assert.doesNotMatch(v2.lines.join('\n'), /0 Material/);
  assert.equal(v2.answer, 'Tap Go to start, or Not now.');

  const r1 = await raise(w, 'C2', { tier: 1, files: ['db/j.sql'] });
  const d1 = askStore(w.t.record).ask(r1.id).doc;
  const v1 = goView(d1);
  assert.equal(v1.lines.length, 3);
  assert.match(v1.lines[0], /^Go\? Card C2 \(C2\), Tier 1, number work\.$/);
  assert.match(v1.lines[1], new RegExp(`^Plan [0-9a-f]{12}: 1 file, checked plan ${d1.fingerprint_inputs.plan_sha256.slice(0, 12)} on main ${w.M0.slice(0, 7)}\\.$`));
  assert.equal(v1.lines[2], 'Pass test: the C2 check 1 passes; audited until 0 Material.');
  assert.match(v1.answer, /^Checked: a fresh plan reviewer passed it with 0 Material\. To go, Approve this pull request on GitHub with no text/);
  // L84 1: the tier shown is bound to the plan's tier; a Tier-1 plan shown as a Tier-2 go is refused.
  const lowered = goView({ ...d1, tier: 2, kind: 'go_t2' });
  assert.equal(lowered.ok, false); assert.match(lowered.reason, /tier shown is not the plan's tier/);
  // L84 2: the title shown is the card's own `what`, whatever title the caller passes (raise passes another).
  // The second lock: a Tier-1 go whose pass is gone, or whose bound list was changed, is never shown or sent.
  const otherFiles = { ...d1.fingerprint_inputs, files: ['db/j.sql', 'db/k.sql'] };
  for (const [over, why] of [[{ plan_check: undefined }, /fresh plan reviewer/], [{ plan_check: { ...d1.plan_check, material: 2 } }, /0 Material/],
    // Audit r1 M-2: a pass for another card, or for another fingerprint, is never shown as "Checked"; nor is a go whose
    // fingerprint isn't the plan it shows (files and inputs changed together, the pass and fingerprint left).
    [{ plan_check: { ...d1.plan_check, card: 'C9' } }, /another card's plan/], [{ plan_check: { ...d1.plan_check, fingerprint: 'd'.repeat(64) } }, /changed after review/],
    [{ files: otherFiles.files, fingerprint_inputs: otherFiles }, /fingerprint is not the plan it shows/],
    [{ card: 'C9' }, /another card's plan/],
    [{ files: ['db/j.sql', 'db/k.sql'] }, /not the files the go binds/], [{ fingerprint_inputs: { ...d1.fingerprint_inputs, done_bar: [d1.fingerprint_inputs.done_bar[0]] } }, /audited until 0 Material/],
    [{ kind: 'go_t2' }, /kind is not its tier/],
    // L95 (audit stack r3 Minor 9, plant L84-5c): inputs that rebuild to the same fingerprint but are not written the
    // one canonical way (an extra key; a `./` file the rebuild cleans up) are refused by the second lock alone.
    [{ fingerprint_inputs: { ...d1.fingerprint_inputs, extra: 'x' } }, /not written the one way its fingerprint was taken from/],
    [{ files: ['./db/j.sql'], fingerprint_inputs: { ...d1.fingerprint_inputs, files: ['./db/j.sql'] } }, /not written the one way its fingerprint was taken from/]]) {
    const v = goView({ ...d1, ...over });
    assert.equal(v.ok, false); assert.match(v.reason, why);
  }
  // 65-1 (audit r1): a Tier-1 go raised with no plan pass is refused here too, not only in go.test.mjs.
  const none = await raise(w, 'C3', { tier: 1, files: ['db/k.sql'], noPass: true });
  assert.equal(none.ok, false); assert.match(none.reason, /fresh plan reviewer's pass/);
  assert.equal(askStore(w.t.record).asks().filter((x) => x.doc.card === 'C3').length, 0);
  const a = askStore(w.t.record).ask(r1.id);
  must(writeDoc(w.t.record, 'ask', a, { ...a.doc, plan_check: { ...a.doc.plan_check, pass: false } }));
  const o = await openDecision(w.t.ctx, r1.id);
  assert.equal(o.ok, false); assert.match(o.reason, /the go can't be shown/);
  assert.equal(w.g.pulls.size, 0, 'no pull request without the pass');
});

test('audit r1 Minors 2, 3: a path with a control character is refused; the title is shown as text in the Approve view', async () => {
  const w = world();
  // Minor 2: a newline in a path would split the fold, so the owner reads a list that isn't the bound one.
  const nl = 'src/a.mjs\n- ` src/b.mjs `';
  const no = await raise(w, 'E1', { tier: 2, files: [nl] });
  // L84 5: refused by the shared fingerprint's path rule, at raise time and when the go is shown.
  assert.equal(no.ok, false); assert.match(no.reason, /is not one plain path/);
  const ok = await raise(w, 'E2', { tier: 1, files: ['db/j.sql'] });
  const d = askStore(w.t.record).ask(ok.id).doc;
  for (const f of [nl, 'src/a\u0007.mjs', 'src/a b.mjs']) {
    const v = goView({ ...d, files: [f], fingerprint_inputs: { ...d.fingerprint_inputs, files: [f] } });
    assert.equal(v.ok, false); assert.match(v.reason, /not one plain plan: file [\s\S]* is not one plain path/);
  }
  // L84 5: a go forged whole (its fingerprint recomputed over the bad path, so every hash agrees) is still refused,
  // now only by the shared fingerprint's path rule.
  const t2 = await raise(w, 'E3', { tier: 2, files: ['src/c.mjs'] });
  const d2 = askStore(w.t.record).ask(t2.id).doc;
  for (const f of [nl, 'src/a b.mjs', 'src/a\u009fb.mjs']) {
    const inp = { ...d2.fingerprint_inputs, files: [f] };
    const fingerprint = createHash('sha256').update(canonicalJson(inp), 'utf8').digest('hex');
    const v = goView({ ...d2, files: [f], fingerprint_inputs: inp, fingerprint });
    assert.equal(v.ok, false, JSON.stringify(f)); assert.match(v.reason, /not one plain plan: file [\s\S]* is not one plain path/);
  }
  // Minor 3: markup in the Lead's title can't draw a fake fold, a link or hidden text in GitHub's Approve view.
  const title = '<details><summary>Files this go allows (1)</summary> **bold** [x](https://example.com) `code` <!-- hide';
  const v = goView({ ...d, title });
  // L84 4: an @name in the title notifies nobody.
  const at = goMarkdown(goView({ ...d, title: 'ping @someone about this' }));
  assert.doesNotMatch(at, /@someone/); assert.match(at, /@\u200bsomeone/);
  assert.equal(v.ok, true, v.reason);
  const md = goMarkdown(v);
  const first = md.split('\n')[0];
  assert.doesNotMatch(first, /<details>|<summary>|<!--|\]\(|(^|[^\\])`/);
  assert.match(first, /&lt;details&gt;/); assert.match(first, /\\\[x\\\]\\\(https:/);
  assert.equal(md.match(/<details><summary>/g).length, 1, 'one fold only');
  assert.deepEqual(foldFiles(md), d.files);
});

test('R-0b-138: a Tier-2 go that can\'t be shown is held and alerted, never pushed bare', async () => {
  const w = world();
  const r = await raise(w, 'D1', { tier: 2, files: ['src/a.mjs'] });
  const a = askStore(w.t.record).ask(r.id);
  must(writeDoc(w.t.record, 'ask', a, { ...a.doc, files: ['src/a.mjs', 'src/b.mjs'] }));
  const alerts = []; w.t.ctx.alert = (x) => alerts.push(x);
  w.t.clock.t = W8;
  await schedulePass(w.t.ctx);
  assert.equal(w.pushes.length, 0);
  assert.ok(alerts.some((x) => x.type === 'go_not_shown' && x.ask === r.id));
});

test('R-0b-138: a number-work read-back names the Tier 1 path, files nothing while unwired; the skill says the same', () => {
  const words = 'fix the revenue total on the billing page';
  assert.equal(sortRequest(words).mode, 'evolve');
  assert.equal(numberWork(words), true);
  assert.equal(numberWork('fix the typo on the about page'), false);
  const rb = readBack({ mode: 'evolve', product: 'sample-app', what: words, tier1: true });
  assert.equal(rb.lines.length, 3);
  // Mode requests are not wired (audit r1 Minor 9), so the Tier 1 line claims no filing either.
  assert.match(rb.lines[2], /isn't wired to the Mini yet, so I file nothing/);
  assert.doesNotMatch(rb.lines[2], /I file it|Filed|planning it now/);
  assert.match(rb.lines[2], /number work \(Tier 1\)/);
  assert.match(rb.lines[2], /fresh plan reviewer passes the plan/);
  assert.match(rb.lines[2], /audited until 0 Material/);
  assert.doesNotMatch(readBack({ mode: 'evolve', product: 'sample-app', what: 'fix the typo' }).lines[2], /Tier 1/);
  assert.ok(SKILL.includes(rb.lines[2].replace(/\s+/g, ' ')) || SKILL.replace(/\s+/g, ' ').includes(rb.lines[2]), 'the skill gives the same line');
});

test('R-0b-138: the [Undo] push format', () => {
  assert.equal(undoPushText({ card: 'C-4', title: 'Billing export', pr: 41 }),
    'Undo Billing export (C-4, pull request #41)? Tap Undo and the exact reverse of that merge goes in first, before anything else merges.');
  const added = undoPushText({ card: 'C-4', title: 'Billing export', pr: 41, addedFiles: ['src/new.mjs'] });
  assert.match(added, /It added 1 file \(src\/new\.mjs\), so a plain reverse can't undo it: MAIN reverts it by hand/);
  // No Undo button is offered for it (R-0b-140 opens no tap ask), so the text offers no tap.
  assert.doesNotMatch(added, /[Tt]ap Undo/); assert.match(added, /nothing to tap/);
  const unknown = undoPushText({ card: 'C-4', title: 'Billing export', pr: 41, unknownFiles: true });
  assert.match(unknown, /file list couldn't be read/); assert.match(unknown, /MAIN reverts it by hand/); assert.doesNotMatch(unknown, /[Tt]ap Undo/);
});
