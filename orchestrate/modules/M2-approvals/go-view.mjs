// go-view.mjs — what the owner reads when asked for a go (R-0b-138, R-0b-139): the plan in three lines, how to answer,
// and a fold listing the files the go allows. The list in the fold is the ask's own `files`, the list the fingerprint
// binds and M2 checks at merge, so what the owner reads is what the go allows (diff 0, tested on 10 sample gos).
//
//   goView(askDoc) → { ok, lines: [3], answer, fold: { summary, files } } | { ok: false, reason }
//   goText(view) → the push text (lines, answer, the fold's files)
//   goMarkdown(view) → the decision pull request's body for a Tier-1 go (the fold is a <details> block)
//   foldFiles(markdown) → the files listed in a body's fold, as GitHub shows it (for the test that reads it back)
//   undoPushText({ card, title, pr, addedFiles, unknownFiles }) → the day-1 [Undo] push (sent by R-0b-140)
//
// A Tier-1 go is never shown before a fresh plan reviewer has passed the plan with 0 Material: goView refuses one
// whose `plan_check` is missing, failing, for another card, for another version of the plan (its whole fingerprint:
// files, done_when, plan document, main commit), or written by the plan's own author (raiseGo checks the same before
// the ask exists; this is the second lock, at the point the owner would see it). goView also recomputes the go's
// fingerprint from the inputs it shows, so a pass can't be matched to a fingerprint that isn't the plan's (audit
// kit-lane3 r1 M-2). A file path with a control character is refused (Minor 2: a newline would break the fold): goView
// rebuilds the fingerprint with the shared planFingerprint, whose path rule refuses them (L84 5, #71), and
// the lines in the decision pull request body are escaped (Minor 3: the title is the Lead's text).

import { createHash } from 'node:crypto';
import { TIER1_BAR, canonicalJson, planFingerprint } from '../../shared/plan-fingerprint.mjs';
import { planCheckProblem } from '../../shared/plan-review.mjs';

const fail = (reason) => ({ ok: false, reason });
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SHA256 = /^[0-9a-f]{64}$/;

// The fresh plan check a Tier-1 go needs is the one shared rule (shared/plan-review.mjs, L87); raiseGo (go.mjs)
// applies it before the ask exists, goView again before the owner sees it.

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function goView(doc) {
  if (!doc || (doc.kind !== 'go_t1' && doc.kind !== 'go_t2')) return fail('not a go');
  const inp = doc.fingerprint_inputs;
  if (!inp || !Array.isArray(inp.files) || !Array.isArray(inp.done_bar)) return fail('the go holds no plan');
  const files = doc.files;
  if (!Array.isArray(files) || !files.length) return fail('a go lists its files');
  if (canonicalJson(files) !== canonicalJson(inp.files)) return fail('the files shown are not the files the go binds');
  // The plan the go shows must be one the shared fingerprint accepts and gives this go's fingerprint (L84 5): its path
  // rule is the one place a control character in a file path is refused, so the fold always shows one path a line.
  const re = planFingerprint({ product: inp.product, card_id: inp.card_id, tier: inp.tier, files: inp.files,
    done_when: inp.done_bar[0], plan_sha256: inp.plan_sha256, main_commit: inp.main_commit });
  if (!re.ok) return fail(`the go's plan is not one plain plan: ${re.reason}`);
  if (re.sha256 !== doc.fingerprint) return fail('the go\'s fingerprint is not the plan it shows');
  const tier = doc.tier;
  if (tier !== 1 && tier !== 2) return fail('the go names no tier');
  if (doc.kind !== (tier === 1 ? 'go_t1' : 'go_t2')) return fail('the go\'s kind is not its tier\'s');
  if (inp.tier !== tier) return fail('the tier shown is not the plan\'s tier');
  if (typeof doc.fingerprint !== 'string' || !SHA256.test(doc.fingerprint)) return fail('a go names its plan fingerprint');
  if (tier === 1) {
    const bad = planCheckProblem(doc.plan_check, { fingerprint: doc.fingerprint, card: doc.card, planSha256: inp.plan_sha256 });
    if (bad) return fail(bad);
    if (!inp.done_bar.includes(TIER1_BAR)) return fail(`a Tier-1 plan's pass test includes "${TIER1_BAR}"`);
  }
  if (inp.card_id !== doc.card) return fail('the go\'s plan is another card\'s');
  let canon; try { canon = canonicalJson(inp); } catch { canon = null; }
  if (canon === null || sha256(canon) !== doc.fingerprint) return fail('the go\'s fingerprint is not the plan it shows');
  const test = firstLine(inp.done_bar[0]);
  if (!test) return fail('the plan has no pass test');
  const rows = String(inp.done_bar[0]).split('\n---\n').length;
  const lines = [
    `Go? ${firstLine(doc.title)} (${doc.card}), Tier ${tier}${tier === 1 ? ', number work' : ''}.`,
    `Plan ${doc.fingerprint.slice(0, 12)}: ${plural(files.length, 'file')}${tier === 1 ? `, checked plan ${inp.plan_sha256.slice(0, 12)} on main ${String(inp.main_commit).slice(0, 7)}` : ''}.`,
    `Pass test: ${test}${rows > 1 ? ` (and ${plural(rows - 1, 'more row')})` : ''}${tier === 1 ? `; ${TIER1_BAR}` : ''}.`,
  ];
  const answer = tier === 1
    ? 'Checked: a fresh plan reviewer passed it with 0 Material. To go, Approve this pull request on GitHub with no text; Request changes means not now.'
    : 'Tap Go to start, or Not now.';
  return { ok: true, lines, answer, fold: { summary: `Files this go allows (${files.length})`, files: [...files] } };
}

export function goText(v) {
  return [...v.lines, v.answer, `${v.fold.summary}:`, ...v.fold.files.map((f) => `- ${f}`)].join('\n');
}

// File names in the fold are code spans; a backtick inside a name gets a longer fence so GitHub shows it whole.
const span = (f) => { const n = Math.max(0, ...[...String(f).matchAll(/`+/g)].map((m) => m[0].length)) + 1; const t = '`'.repeat(n); return `${t} ${f} ${t}`; };

// Markdown and HTML in a line are shown as text, not drawn (Minor 3): every character GitHub could read as markup is
// escaped, and < > & become entities, so a title can't draw a fake fold or hide text.
// An `@` gets a zero-width space after it, so `@name` in a title never notifies that GitHub user (L84 4).
export const mdText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}[\]()#+\-.!|~]/g, (c) => `\\${c}`).replace(/@/g, '@\u200b');

export function goMarkdown(v) {
  return [`**${mdText(v.lines[0])}**`, mdText(v.lines[1]), mdText(v.lines[2]), '', v.answer, '', `<details><summary>${v.fold.summary}</summary>`, '',
    ...v.fold.files.map((f) => `- ${span(f)}`), '', '</details>', ''].join('\n');
}

export function foldFiles(md) {
  const m = /<details><summary>Files this go allows \((\d+)\)<\/summary>\n([\s\S]*?)\n<\/details>/.exec(String(md ?? ''));
  if (!m) return null;
  return m[2].split('\n').map((l) => /^- (`+) (.*) \1$/.exec(l)?.[2]).filter((f) => f !== undefined);
}

// The day-1 [Undo] push (R-0b-140 sends it within 5 minutes of the owner's flag). A merge that added a file can't be
// undone by a plain reverse through the docs lane: MAIN reverts it by hand, and the push says so. That case has no
// Undo button (no tap ask is opened), so its text offers none. A merge whose file list couldn't be read is treated
// the same way.
export function undoPushText({ card, title, pr, addedFiles = [], unknownFiles = false } = {}) {
  const q = `Undo ${firstLine(title) || card} (${card}, pull request #${pr})?`;
  const hand = 'MAIN reverts it by hand, first, before anything else merges. There is nothing to tap; you are told when it is done.';
  if (unknownFiles) return `${q} Its file list couldn't be read, so it isn't undone automatically: ${hand}`;
  if (!addedFiles.length) return `${q} Tap Undo and the exact reverse of that merge goes in first, before anything else merges.`;
  return `${q} It added ${plural(addedFiles.length, 'file')} (${addedFiles.join(', ')}), so a plain reverse can't undo it: ${hand}`;
}
