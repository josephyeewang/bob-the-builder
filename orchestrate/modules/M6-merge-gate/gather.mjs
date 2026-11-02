// gather.mjs — reads everything the fourteen refusals judge, for one merge, into refusals.mjs's facts object (R-0b-87 to
// R-0b-90; 0b-9 review rounds 1–3; L44).
//
// WHY APART FROM THE JUDGE. Reading is where things go wrong: GitHub is down, a list is cut off, a document was written
// by the wrong actor. Each read here turns any of that into a null or { ok: false } for the one fact it feeds, so the
// judge refuses for that reason and the rest of the facts still say what else is wrong. Nothing is cached between passes.
//
//   await gatherFacts(ctx, merge) → facts            (see refusals.mjs for every field)
//   recordView(record) → { createdBy(entity, id), seqOf(entity, id), linesAfter(seq) }
//   threadsQuery → the GraphQL text for refusal 7
//   threads(gh, owner, repo, pr) → { ok, unresolved } (a failed read throws, message starts with the HTTP status; a 200 carrying errors says "GitHub answered 200 but with an error: the review threads could not be read"); linesOf(patch) → added/removed lines
// ctx = { record, rules, product, gh, owner, repo, view, now, alert, approvals?, readRow?, reviewLaunches }
//   reviewLaunches { root, uids, outbox }: the review runner's launch records folder (its ended records sit beside it,
//     L68), the role → Mac user id map (L65), and review's outbox root, where each session's verdict file is read
//   gh       GitHub client { get(path), post(path, body) } → { status, json }; graphql is POST /graphql
//   view     makeGitView({ gh, owner, repo }) (M10)
//   approvals M2's ctx { record, rules, product, now, alert, gh, owner, repo } (defaults from ctx)
//   readRow(id, head) → row | null   a build row parsed at the change's head (default: contents + yaml-lite)
// merge = { id, doc } — the merge document (doc.card, doc.pr, doc.request, doc.catch_ups).
//
// Rules keys read (all through rules.get, product-scoped): product.cutover_stage, product_profile.required_checks,
// product_profile.checks_ignored, product_profile.robot, effect_paths, rules.adopted; and through M9 and M2,
// approvals.plan_go.go_free and live_check.*. A key the rules don't have refuses whatever reads it.

import { carryOver } from '../M10-rules/carry-over.mjs';
import { checkExactReverse } from '../M10-rules/exact-reverse.mjs';
import { RULES_PATH } from '../M10-rules/reader.mjs';
import { approveNeeded, goCheck, ROW_FILE } from '../M2-approvals/go.mjs';
import { approvalStands } from '../M2-approvals/schedule.mjs';
import { askStore } from '../M2-approvals/ask-store.mjs';
import { activeKind } from '../M2-approvals/kinds.mjs';
import { goFreeKinds, rootOf } from '../M9-record/ready.mjs';
import { headReviews } from '../M9-record/outbox.mjs';
import { readMark } from './mark.mjs';
import { undoneBy } from './undo.mjs';
import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAX_LIST = 100;
// The robot's numeric GitHub id (a login can be renamed); the rules file may hold it as text.
export const botId = (robot) => { const v = robot?.bot_user_id; const n = typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : v; return Number.isSafeInteger(n) && n > 0 ? n : null; };

export const threadsQuery = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100) {
    totalCount nodes { isResolved comments(first: 1) { nodes { author { __typename login } } } } } } } }`;

// Who first wrote each document and at which diary line, from the diary (the record's truth). M2 does the same for asks.
export function recordView(record) {
  const first = new Map();
  const lines = record.diary({ since: 0 });
  for (const line of lines) for (const w of line.writes ?? []) { const k = `${w.entity}/${w.id}`; if (!first.has(k)) first.set(k, { actor: line.actor, seq: line.seq }); }
  return {
    createdBy: (entity, id) => first.get(`${entity}/${id}`)?.actor ?? null,
    seqOf: (entity, id) => first.get(`${entity}/${id}`)?.seq ?? null,
    linesAfter: (seq) => lines.filter((l) => l.seq > seq),
  };
}

async function json(gh, path) {
  const r = await gh.get(path);
  if (r?.status !== 200 || r.json === undefined || r.json === null) throw new Error(`${path} answered ${r?.status}`);
  return r.json;
}

const checkRun = (c) => ({ name: c?.name, app_id: c?.app?.id, head_sha: c?.head_sha, status: c?.status, conclusion: c?.conclusion });

async function checksAt(gh, base, sha) {
  const j = await json(gh, `${base}/commits/${sha}/check-runs?per_page=${MAX_LIST}`);
  if (!Array.isArray(j.check_runs) || !Number.isInteger(j.total_count) || j.total_count >= MAX_LIST || j.total_count !== j.check_runs.length) throw new Error('the check runs are cut off or unreadable');
  return j.check_runs.map(checkRun);
}

async function statusesAt(gh, base, sha) {
  const j = await json(gh, `${base}/commits/${sha}/status?per_page=${MAX_LIST}`);
  if (!Array.isArray(j.statuses) || (Number.isInteger(j.total_count) && j.total_count >= MAX_LIST)) throw new Error('the statuses are cut off or unreadable');
  return j.statuses.map((s) => ({ context: s?.context, state: s?.state }));
}

// main is green when every required check ran there and passed, and no other check or status is red.
async function mainGreen(gh, base, sha, required, ignoredList) {
  const ign = (c) => (ignoredList ?? []).some((x) => x?.app_id === c.app_id && x?.name === c.name);
  const runs = (await checksAt(gh, base, sha)).filter((c) => !ign(c));
  const sts = await statusesAt(gh, base, sha);
  const good = (c) => c.status === 'completed' && ['success', 'neutral', 'skipped'].includes(c.conclusion);
  for (const name of required) if (!runs.some((c) => c.name === name && good(c)) && !sts.some((s) => s.context === name && s.state === 'success')) return false;
  return runs.every(good) && sts.every((s) => s.state === 'success');
}

export const linesOf = (patch) => {
  if (typeof patch !== 'string') return {};
  const added = []; const removed = [];
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added.push(l.slice(1));
    else if (l.startsWith('-') && !l.startsWith('---')) removed.push(l.slice(1));
  }
  return { added_lines: added, removed_lines: removed };
};

// A read that FAILED throws (err.unreadable = true, the message starts with the HTTP status); the gate's own callers map any
// throw to { ok: false } through `attempt`, exactly as before. A list too long to read whole is a fact: { ok: false }.
export async function threads(gh, owner, repo, pr) {
  const r = await gh.post('/graphql', { query: threadsQuery, variables: { owner, repo, pr } });
  const t = r?.json?.data?.repository?.pullRequest?.reviewThreads;
  if (r?.status !== 200 || r.json?.errors || !t || !Array.isArray(t.nodes)) { const e = new Error(r?.status !== 200 ? `HTTP ${r?.status}: the review threads could not be read` : 'GitHub answered 200 but with an error: the review threads could not be read'); e.unreadable = true; throw e; }
  if (t.totalCount !== t.nodes.length || t.totalCount >= MAX_LIST) return { ok: false };
  // A human thread: its first comment's author is a User. A bot's thread (a linter) is not a person waiting on an answer.
  const unresolved = t.nodes.filter((n) => n?.isResolved !== true && n?.comments?.nodes?.[0]?.author?.__typename !== 'Bot').length;
  return { ok: true, unresolved };
}

async function defaultReadRow(gh, base, id, head) {
  const r = await gh.get(`${base}/contents/${encodeURIComponent(`docs/blueprint/rows/${id}.yaml`).replace(/%2F/g, '/')}?ref=${head}`);
  if (r?.status !== 200 || r.json?.encoding !== 'base64') return null;
  try { return parseYaml(Buffer.from(r.json.content, 'base64').toString('utf8'), `${id}.yaml`); } catch { return null; }
}

// One read per fact; each failure becomes that fact's "unknown".
const attempt = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

export async function gatherFacts(ctx, merge) {
  const { record, rules, product, gh, owner, repo, view } = ctx;
  const base = `/repos/${owner}/${repo}`;
  const get = (key) => { try { return rules.get(key, { product }); } catch { return undefined; } };
  const rv = recordView(record);
  const cardEntry = record.read('card', merge.doc.card);
  const card = cardEntry && !cardEntry.corrupt ? { id: cardEntry.id, rev: cardEntry.rev, doc: cardEntry.doc } : null;
  const f = { cutoverStage: get('product.cutover_stage') === 'second' ? 'second' : 'first', card };
  if (!card) return f;
  const H0 = card.doc.head;
  const kind = card.doc.kind ?? 'ordinary';

  // The request (refusal 11) and the record's moves on this card since it.
  const reqEntry = typeof merge.doc.request === 'string' ? record.read('merge_request', merge.doc.request) : null;
  f.request = reqEntry && !reqEntry.corrupt ? { id: reqEntry.id, doc: reqEntry.doc, createdBy: rv.createdBy('merge_request', reqEntry.id) } : null;
  const reqSeq = f.request ? rv.seqOf('merge_request', f.request.id) : null;
  f.movesSinceRequest = reqSeq === null ? null : rv.linesAfter(reqSeq).flatMap((l) => (l.writes ?? [])
    .filter((w) => w.entity === 'card' && w.id === card.id).map((w) => ({ actor: l.actor, entity: w.entity, id: w.id })));

  // The pull request and main.
  f.pr = await attempt(async () => {
    const p = await json(gh, `${base}/pulls/${merge.doc.pr}`);
    return { number: p.number, state: p.state, draft: p.draft, base: { ref: p.base?.ref }, head: { sha: p.head?.sha }, mergeable: p.mergeable, mergeable_state: p.mergeable_state, merge_commit_sha: p.merge_commit_sha ?? null, labels: (p.labels ?? []).map((l) => l?.name) };
  });
  const head = SHA.test(f.pr?.head?.sha ?? '') ? f.pr.head.sha : null;
  const mainSha = await attempt(async () => { const s = (await json(gh, `${base}/git/ref/heads/main`)).object?.sha; if (!SHA.test(s ?? '')) throw new Error('no main'); return s; });
  f.requiredChecks = Array.isArray(get('product_profile.required_checks')) ? get('product_profile.required_checks') : null;
  // The rules file gives every value as text: an app id is turned into a number here, once, as botId does.
  const ignoredRaw = get('product_profile.checks_ignored');
  f.checksIgnored = Array.isArray(ignoredRaw) ? ignoredRaw.map((x) => ({ app_id: botId({ bot_user_id: x?.app_id }), name: x?.name })) : [];
  f.main = { sha: mainSha, green: mainSha && f.requiredChecks ? await attempt(() => mainGreen(gh, base, mainSha, f.requiredChecks, f.checksIgnored)) : null };
  f.checks = head ? await attempt(() => checksAt(gh, base, head)) : null;
  f.statuses = head ? await attempt(() => statusesAt(gh, base, head)) : null;

  // The change: main...head.
  const cmp = head && mainSha ? await attempt(() => json(gh, `${base}/compare/${mainSha}...${head}`)) : null;
  f.compareStatus = typeof cmp?.status === 'string' ? cmp.status : null;
  const rawFiles = Array.isArray(cmp?.files) && cmp.files.length < 300 ? cmp.files : null;
  // Each file's mode from the tree (compare gives none): a link, submodule or runnable file is refused by mode alone,
  // so a list whose modes can't all be read is no list (R-0b-98's planted link). A removed file has its old mode.
  const mb = SHA.test(cmp?.merge_base_commit?.sha ?? '') ? cmp.merge_base_commit.sha : null;
  f.files = rawFiles && mb ? await attempt(() => Promise.all(rawFiles.map(async (x) => {
    const e = await view.entry(x.status === 'removed' ? mb : head, x.filename);
    if (!e) throw new Error(`${x.filename}: no tree entry`);
    return { path: x.filename, ...(x.previous_filename ? { previous_path: x.previous_filename } : {}), status: x.status === 'changed' ? 'modified' : x.status, mode: e.mode, ...linesOf(x.patch) };
  }))) : null;
  const fcv = get('effect_paths')?.first_customer_visible?.new_files_under;
  f.firstCustomerNewFiles = Array.isArray(fcv) ? fcv : null;

  // The classification and the lane (M10).
  const c = f.files ? rules.classify({ product, files: f.files, truncated: false, labels: f.pr?.labels ?? [], declared_tier: card.doc.tier }) : null;
  f.tier = c && (c.tier === 1 || c.tier === 2) ? c.tier : null;
  const risky = c?.risky ?? ['unclassifiable'];

  // An undo: recomputed from the files, never taken from the card (M10 exact-reverse.mjs); and whose merge it reverses.
  const reverses = undoneBy(record, card)?.commit ?? null;
  f.exactReverse = false;
  f.reversesGateMerge = false;
  let reversedAudit = 'none';
  if (kind === 'exact_reverse' && reverses && SHA.test(f.pr?.merge_commit_sha ?? '')) {
    f.exactReverse = (await attempt(() => checkExactReverse({ view, reverses, merged: f.pr.merge_commit_sha }), { ok: false })).ok === true;
    const robotBotId = botId(get('product_profile.robot'));
    f.reversesGateMerge = (await readMark({ gh, owner, repo, sha: reverses, robotBotId })).ok === true;
    const m = record.list('merge').find((x) => x.doc?.merge_commit === reverses);
    reversedAudit = m?.doc?.state === 'audit_flagged' ? 'failure' : m?.doc?.state === 'audited_ok' ? 'success' : 'none';
  }
  const reversesFiles = reverses ? await attempt(async () => { const k = await view.commit(reverses); return (await view.files(k.parents[0], reverses)).flatMap((x) => [x.path, ...(x.previous_path ? [x.previous_path] : [])]); }, []) : undefined;
  f.lane = f.files ? (() => { try { return rules.may('merge', { product, card: { id: card.id, ...card.doc }, truncated: false, labels: f.pr?.labels ?? [], declared_tier: card.doc.tier, kind, reverses: reverses ?? undefined, exact_reverse_ok: f.exactReverse, reversed_audit: reversedAudit, reverses_files: reversesFiles, files: f.files }); } catch { return null; } })() : null;

  // Carry-over, when the pull request's head is no longer the head that was reviewed.
  const catchUps = Array.isArray(merge.doc.catch_ups) ? merge.doc.catch_ups : [];
  f.carried = null;
  if (head && SHA.test(H0 ?? '') && head !== H0 && mainSha) {
    f.carried = await attempt(async () => {
      // The branch's own commits after H0: the first-parent chain from the head back to H0. (compare's commit list
      // would also hold main's commits that a catch-up merged in.) Not reaching H0 → an empty list, no carry-over.
      const between = [];
      for (let s = head; s !== H0; s = (await view.commit(s)).parents[0]) {
        if (!SHA.test(s ?? '') || between.length >= MAX_LIST) { between.length = 0; between.push(head); break; }
        between.unshift(s);
      }
      const B0 = (await view.compare(mainSha, H0)).mergeBase;
      const B1 = (await view.compare(mainSha, head)).mergeBase;
      // Tier-1 merges the review and audit did not see: on main now but not on the main H0 was built on (B0). Anchored
      // on what the audit read, not on when the merge was requested; a merge commit that can't be placed counts.
      let tier1MergesSince = 0;
      for (const m of record.list('merge')) {
        if (m.id === merge.id || m.doc?.tier !== 1 || !['merged', 'audited_ok', 'audit_flagged'].includes(m.doc?.state)) continue;
        if (!SHA.test(m.doc.merge_commit ?? '') || !(await view.onHistory(m.doc.merge_commit, B0))) tier1MergesSince += 1;
      }
      return carryOver({ reviewed: { base: B0, head: H0 }, current: { base: B1, head }, between, catchUps, tier1MergesSince, gh: view });
    }, { review: false, audit: false, reasons: ['carry-over could not be read'] });
  }

  // The review (refusal 5; L44, L65, L66 M1, L68, L69). Read from review's own stores only, through M9's one check:
  // every session the review runner launched for this card at H0, or at any head with H0's tree (its launch records),
  // each one's verdict file in review's outbox, the runner's ended records and Joe's set-aside records. Nothing is read
  // from the Record: its `launch` entries and verdict rows are written by the Dispatcher, as the workers' Mac user, and
  // stay as history and for display. No folder setting, a folder that fails the check, or a tree git can't give leaves no
  // sessions and refusal 5 names why. When the pull request's head is not H0, the same is read at that head (L69).
  const reviewsAt = async (sha) => {
    if (!ctx.reviewLaunches) return { ok: false, reason: 'the gate has no review launches folder set' };
    let tree;
    try { tree = (await view.commit(sha)).tree; } catch (e) { return { ok: false, reason: `the tree of ${String(sha).slice(0, 7)} could not be read (${e?.message ?? e})` }; }
    if (!SHA.test(tree ?? '')) return { ok: false, reason: `the tree of ${String(sha).slice(0, 7)} could not be read` };
    try {
      return headReviews({ launches: ctx.reviewLaunches.root, outboxRoot: ctx.reviewLaunches.outbox, uids: ctx.reviewLaunches.uids, card: card.id, head: sha, tree });
    } catch (e) { return { ok: false, reason: `the review records could not be read (${e?.message ?? e})` }; }
  };
  const hr = SHA.test(H0 ?? '') ? await reviewsAt(H0) : { ok: false, reason: 'the card has no head' };
  f.reviews = hr.ok ? hr.sessions : null;
  f.reviewsProblem = hr.ok ? null : hr.reason;
  f.prReviews = null; f.prReviewsProblem = null;
  let prSkipped = [];
  if (SHA.test(head ?? '') && head !== H0) {
    const pr = await reviewsAt(head);
    f.prReviews = pr.ok ? pr.sessions : null;
    f.prReviewsProblem = pr.ok ? null : pr.reason;
    prSkipped = pr.ok ? pr.skipped ?? [] : [];
  }
  // A launch record no card can be tied to is skipped by the check; it is logged here (the review runner tells Joe once).
  const skipped = [...new Map([...(hr.skipped ?? []), ...prSkipped].map((x) => [x.name, x])).values()];
  if (skipped.length) f.reviewsSkipped = skipped.map((x) => `${x.name}: ${x.reason}`);

  // The owner's Approve (refusals 8, 13, 14): needed per M2, and standing on GitHub now.
  const apx = ctx.approvals ?? { record, rules, product, now: ctx.now, alert: ctx.alert ?? (() => {}), gh, owner, repo };
  const need = approveNeeded({ risky, needsJoe: card.doc.needs_joe === true || card.doc.approval_required === true, tier: f.tier, module: card.doc.module }, rules, product);
  const ask = askStore(record).asks().filter((a) => a.doc.card === card.id && activeKind(a.doc.kind)?.merge_approve && a.doc.state === 'answered').sort((a, b) => String(b.doc.raised_at).localeCompare(String(a.doc.raised_at)))[0];
  const stand = ask && head ? await attempt(() => approvalStands(apx, ask.id, { head, view, catchUps }), { ok: false, reason: 'the Approve check failed' }) : { ok: false, reason: 'no answered Approve for this card' };
  f.approve = { needed: need.needed, why: need.why, stands: stand.ok === true, reason: stand.ok ? null : stand.reason };

  // The go (refusal 10).
  if (goFreeKinds(rules, product).includes(kind)) f.go = { ok: true, reasons: [], skipped: true };
  else f.go = f.files ? await attempt(async () => {
    const r = rootOf({ id: card.id, doc: card.doc }, { get: (entity, id) => record.read(entity, id) });
    if (!r.ok) return { ok: false, reasons: [r.reason] };
    const rootId = r.root.id;
    const go = askStore(record).go(`go-${rootId}`);
    if (!go) return { ok: false, reasons: [`no go for ${rootId}`] };
    const ids = new Set(Object.keys(go.doc.rows ?? {}));
    for (const x of f.files) for (const p of [x.path, x.previous_path]) { const m = typeof p === 'string' ? ROW_FILE.exec(p) : null; if (m) ids.add(m[1]); }
    const readRow = ctx.readRow ?? ((id, h) => defaultReadRow(gh, base, id, h));
    const headRows = {};
    for (const id of [...ids].sort()) headRows[id] = await readRow(id, head);
    return goCheck({ go: go.doc, card: { id: card.id, root: rootId, doc: card.doc }, changed: f.files, headRows, tier: f.tier, view, mainSha });
  }) : null;

  f.threads = Number.isInteger(merge.doc.pr) ? await attempt(() => threads(gh, owner, repo, merge.doc.pr), { ok: false }) : { ok: false };

  // The rules this gate runs on are the ones adopted at main (hold, never refuse).
  f.rulesAdopted = mainSha ? await attempt(async () => {
    const adopted = get('rules.adopted');
    const at = await json(gh, `${base}/contents/${RULES_PATH}?ref=${mainSha}`);
    return typeof adopted?.blob === 'string' && adopted.blob === at.sha;
  }) : null;
  return f;
}
