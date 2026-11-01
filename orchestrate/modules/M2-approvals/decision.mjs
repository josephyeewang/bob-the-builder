// decision.mjs — decisions that aren't merges, sent as small decision pull requests (R-0b-50; 0b-5 spec review round 2
// M2-3, round 3 m3-2, LEAD-CALLS L17/N20).
//
// WHY. A decision (pick one of a few options) and a Tier-1 go need the owner's own GitHub Approve, like a risky merge.
// The robot opens a pull request holding one small file that states the question; the owner answers with a review:
//   decision  Approve with no text → the recommended choice; Approve whose whole text is one choice letter (A, B, C…,
//             any case; one trailing "." or "!" allowed) → that choice; any other text counts nothing and the owner is
//             told LETTER_LINE. "Request changes" records the decision as declined.
//   go_t1     committed as <decisions_dir>/go-<card>.json, titled "Go: <card> — <what>". Only an Approve with no text
//             is a go; any text counts nothing (GO_EMPTY_LINE). "Request changes" records "not now".
// The Approve must be on the pull request's head (a decision file is never caught up, so nothing carries over). Only
// the owner's reviews count (github-review.mjs ownerVerdict), and M10 must allow the channel. A declined decision's
// pull request is closed unmerged and the answer is final.
//
//   await openDecision(ctx, askId)  → { ok, pr } | { ok: false, reason }   ask open → pushed, with raised_at from GitHub
//   await readDecision(ctx, askId)  → { ok, counted: bool, choice?, line? } | { ok: false, reason }
//   ctx = { record, rules, product, gh, owner, repo, now, alert }

import { activeKind } from '../../shared/asks.mjs';
import { answerCounts } from '../../shared/approval.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { ownerVerdict, requestReview } from './github-review.mjs';
import { GO_EMPTY_LINE, LETTER_LINE, lapseAt, readConfig } from './kinds.mjs';

const SHA = /^[0-9a-f]{40}$/;
const LETTERS = 'ABCDEFGHIJ';
const iso = (ms) => new Date(ms).toISOString();
const fail = (reason) => ({ ok: false, reason });

// The owner's review text, as the rule reads it: trimmed, then one trailing "." or "!" dropped, then trimmed again.
export function readBody(body) {
  return String(body ?? '').trim().replace(/[.!]$/, '').trim();
}

// The choice a decision Approve picks, or null (LETTER_LINE).
export function choiceOf(body, choices, recommended) {
  const b = readBody(body);
  if (b === '') return recommended;
  if (b.length !== 1) return null;
  const i = LETTERS.indexOf(b.toUpperCase());
  return i >= 0 && i < choices.length ? choices[i] : null;
}

const filePath = (cfg, id, doc) => (doc.kind === 'go_t1' ? `${cfg.decisionsDir}/go-${doc.card}.json` : `${cfg.decisionsDir}/${id}.md`);

function fileText(id, doc) {
  if (doc.kind === 'go_t1') {
    // The plan exactly as the fingerprint binds it (round 2 M2-3): its canonical inputs and their sha256.
    return `${JSON.stringify({ ask: id, card: doc.card, title: doc.title, plan: doc.fingerprint_inputs ?? null, fingerprint: doc.fingerprint, rows: doc.rows ?? null }, null, 2)}\n`;
  }
  const lines = doc.choices.map((c, i) => `- **${LETTERS[i]}** ${c}${c === doc.recommended ? ' (recommended)' : ''}`);
  return `# ${doc.title}\n\nAsk ${id}, card ${doc.card}.\n\n${lines.join('\n')}\n\nApprove with no text for the recommended choice, or with just one letter for another.\n`;
}

const title = (doc) => (doc.kind === 'go_t1' ? `Go: ${doc.card} — ${doc.title}` : `Decision: ${doc.title}`);

function load(ctx, id) {
  const a = askStore(ctx.record).ask(id);
  if (!a) return fail(`no trusted ask ${id}`);
  const k = activeKind(a.doc.kind);
  if (!k?.decision_pr) return fail(`a ${a.doc.kind} ask is not a decision pull request`);
  if (a.doc.kind === 'decision' && (!Array.isArray(a.doc.choices) || a.doc.choices.length < 2 || a.doc.choices.length > LETTERS.length || !a.doc.choices.includes(a.doc.recommended))) return fail('a decision lists 2 to 10 choices and its recommended one');
  return { ok: true, a, k };
}

export async function openDecision(ctx, id) {
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) return fail(cfg.reason);
  const l = load(ctx, id); if (!l.ok) return l;
  const { a } = l;
  if (a.doc.state !== 'open' || a.doc.pr) return fail(`ask ${id} is ${a.doc.state}${a.doc.pr ? ` with pull request ${a.doc.pr}` : ''}`);
  const base = `/repos/${ctx.owner}/${ctx.repo}`;
  try {
    const main = await ctx.gh.get(`${base}/git/ref/heads/main`);
    const tip = main?.json?.object?.sha;
    if (main?.status !== 200 || !SHA.test(tip ?? '')) return fail('could not read main');
    const branch = `decision/${id}`;
    const ref = await ctx.gh.post(`${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
    if (ref?.status !== 201) return fail(`could not make the branch (${ref?.status})`);
    const path = filePath(cfg, id, a.doc);
    const put = await ctx.gh.put(`${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { message: title(a.doc), content: Buffer.from(fileText(id, a.doc)).toString('base64'), branch });
    if (put?.status !== 201 && put?.status !== 200) return fail(`could not write the decision file (${put?.status})`);
    const pr = await ctx.gh.post(`${base}/pulls`, { title: title(a.doc), head: branch, base: 'main', body: `Ask ${id}. Answer with a review.` });
    const number = pr?.json?.number;
    if (pr?.status !== 201 || !Number.isSafeInteger(number)) return fail(`could not open the pull request (${pr?.status})`);
    const req = await requestReview({ gh: ctx.gh, owner: ctx.owner, repo: ctx.repo, pr: number, githubId: cfg.githubId });
    // The pull request exists either way; its number is kept so it is never opened twice.
    const doc = { ...a.doc, pr: number, file: path };
    if (req.ok) Object.assign(doc, { state: 'pushed', raised_at: req.raised_at, raised_reask: doc.reask_count, first_pushed_at: doc.first_pushed_at ?? iso(ctx.now()) });
    const w = writeDoc(ctx.record, 'ask', a, doc);
    if (!w.ok) return fail(`the record refused the ask: ${w.reason}`);
    return req.ok ? { ok: true, pr: number } : fail(req.reason);
  } catch (e) {
    return fail(`could not open the decision: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

export async function readDecision(ctx, id) {
  const cfg = readConfig(ctx.rules, ctx.product);
  if (!cfg.ok) return fail(cfg.reason);
  const l = load(ctx, id); if (!l.ok) return l;
  const { a } = l;
  const doc = a.doc;
  if (doc.state !== 'pushed' || !Number.isSafeInteger(doc.pr)) return { ok: true, counted: false };
  const v = await ownerVerdict({ gh: ctx.gh, owner: ctx.owner, repo: ctx.repo, pr: doc.pr, githubId: cfg.githubId, raisedAt: doc.raised_at });
  if (!v.ok) return v;
  if (v.verdict === 'none') return { ok: true, counted: false, ...(v.line ? { line: v.line } : {}), ...(v.blocked ? { reason: v.blocked } : {}) };
  // An answer given after the ask lapsed counts nothing, even if no pass ran in between (the Mini was down; R-0b-51).
  if (Date.parse(v.review.submitted_at) >= lapseAt(doc)) return { ok: true, counted: false, lapsed: true };
  const go = doc.kind === 'go_t1';
  let choice; let approves;
  if (v.verdict === 'changes_requested') { choice = go ? 'Not now' : null; approves = false; } else {
    if (v.review.commit_id !== v.head) return { ok: true, counted: false, line: 'the Approve was on an older version of this pull request; Approve again' };
    if (go) { if (readBody(v.review.body) !== '') return { ok: true, counted: false, line: GO_EMPTY_LINE }; choice = 'go'; approves = true; } else {
      choice = choiceOf(v.review.body, doc.choices, doc.recommended);
      if (choice === null) return { ok: true, counted: false, line: LETTER_LINE };
      approves = true;
    }
  }
  const binding = { kind: 'github_review', pr: doc.pr, review_id: v.review.id, commit_id: v.review.commit_id, submitted_at: v.review.submitted_at };
  const answer = { channel: 'github_review', choice, approves, declined: v.verdict === 'changes_requested', binding, at: iso(ctx.now()) };
  // The one approval check, on the answer as it will be recorded (L81).
  const counted = answerCounts(ctx.rules, { ...doc, answer }, { product: ctx.product });
  if (!counted.ok) { ctx.alert({ type: 'approval_not_counted', ask: id, reason: counted.reason }); return { ok: true, counted: false }; }
  const next = { ...doc, state: 'answered', answer };
  const w = writeDoc(ctx.record, 'ask', a, next);
  if (!w.ok) return fail(`the record refused the answer: ${w.reason}`);
  // After any recorded choice the robot closes the decision pull request unmerged (round 1 M9; audit round 1 m-1).
  {
    const c = await ctx.gh.patch(`/repos/${ctx.owner}/${ctx.repo}/pulls/${doc.pr}`, { state: 'closed' }).catch((e) => ({ status: String(e?.message ?? e) }));
    if (c?.status !== 200) ctx.alert({ type: 'decision_pr_not_closed', ask: id, pr: doc.pr, reason: String(c?.status) });
  }
  return { ok: true, counted: true, choice };
}
