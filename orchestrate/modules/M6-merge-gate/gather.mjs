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
import { COMPARE_FILE_LIMIT } from '../M10-rules/git-view.mjs';
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

// A list GitHub answered in full health but that is longer than the gate reads (L182). It is a fact about the change,
// not a failed read, so it is never waited out: the refusal it leads to is final and tells the owner to split.
const tooLong = (message) => Object.assign(new Error(message), { tooLong: true });

// A read that FAILED, as against one that GitHub answered but that came back incomplete (L186, L190 M3/M4). A failed
// read says nothing about the change, so for the wait cap it is a pass with GitHub unreadable; an incomplete answer
// (a count that doesn't match its list) counts toward the cap. Failed: the client threw, GitHub answered other than
// 200, or the answer had no body or not the shape asked for. Read from the error the reader threw: gather's own
// readers mark it (`unreadable`); M10's git view says "GitHub answered <status> for <path>"; an HTTP code in the
// message, or a fetch that timed out or never connected, is one too. CHECKED AGAINST M10 git-view.mjs as of L190: its
// failed read is that one message, and its truncated tree ("file list ... is cut off") and odd answers are not, so a
// failed tree read is now a pass with GitHub unreadable and a truncated one counts toward the cap (this retires L186's
// tree to-do). Void if git-view's wording changes; git-view marking its failed reads (err.status) would end the coupling.
//
// The HTTP status decides first (#108 r2 Minor 1): a 4xx other than 401, 403 and 429 is GitHub's answer about this
// request (a commit that isn't there, a request it won't take), which the next pass reads the same, so it is NOT a
// failed read and its wait counts toward the cap. A 5xx, 401, 403, 429, or an odd answer (a 2xx or 3xx with no body)
// is a failed read.
export const ANSWERED_4XX = (s) => s >= 400 && s < 500 && ![401, 403, 429].includes(s);
const statusOf = (e) => {
  if (Number.isInteger(e?.status)) return e.status;
  const m = /^(?:HTTP |GitHub answered )(\d{3})\b/.exec(String(e?.message ?? ''));
  return m ? Number(m[1]) : null;
};
export const failedRead = (e) => {
  if (['AbortError', 'TimeoutError'].includes(e?.name)) return true;
  const s = statusOf(e);
  if (s !== null) return !ANSWERED_4XX(s);
  return e?.unreadable === true || /^(HTTP |GitHub answered |fetch failed)/.test(String(e?.message ?? ''));
};
const failed = (message) => Object.assign(new Error(message), { unreadable: true });

// M10's carry-over and exact-reverse checks, M2's go and Approve checks and the robot's mark turn a read that threw (or
// that GitHub didn't answer with 200) into a "no" with a reason: fail closed. That "no" says nothing about the change,
// so a check is run on watched reads, and when one of them failed the check's answer is unknown, never a fact: the
// refusal it feeds waits, and the failure is classed by failedRead (#108 r2, LEAD-CALLS L205). `seen.error` is the
// first read that went wrong.
const VIEW_READS = ['commit', 'compare', 'files', 'entry', 'isDir', 'onHistory'];
function watchReads({ view, gh } = {}) {
  const seen = { error: null };
  // The error is kept as thrown, so failedRead is the one judge of it (#108 r3 M-r3, LEAD-CALLS L225). git-view's own
  // answers ("file list ... is cut off", "compare lists 300 files", "is not an ancestor", an odd answer) are GitHub's
  // answer about the change: they count toward the wait cap, as the same error from an unwatched read does.
  const note = (e) => {
    const c = e ?? new Error('a read failed and threw nothing');
    seen.error ??= c;
    return c;
  };
  const v = view ? Object.freeze(Object.fromEntries(VIEW_READS.filter((k) => typeof view[k] === 'function')
    .map((k) => [k, async (...a) => { try { return await view[k](...a); } catch (e) { throw note(e); } }]))) : view;
  const g = gh ? { ...gh, get: async (path) => {
    let r;
    try { r = await gh.get(path); } catch (e) { throw note(e); }
    if (r?.status !== 200) note(Object.assign(new Error(`GitHub answered ${r?.status} for ${path}`), { status: r?.status }));
    return r;
  } } : gh;
  return { view: v, gh: g, seen };
}
// A check's "no" that came from a failed read is thrown, for attempt() and markFailed to class.
const throwIfUnread = (r, seen) => {
  if (seen?.error) throw seen.error;
  if (r?.unreadable === true) throw (r.cause && typeof r.cause === 'object' ? r.cause : failed(String(r.reason ?? r.reasons?.join('; ') ?? 'GitHub could not be read')));
  return r;
};

async function json(gh, path) {
  let r;
  try { r = await gh.get(path); } catch (e) { throw failed(`${path} could not be read: ${String(e?.message ?? e).slice(0, 200)}`); }
  if (r?.status !== 200 || r.json === undefined || r.json === null) throw Object.assign(new Error(`${path} answered ${r?.status}`), { status: r?.status, unreadable: true });
  return r.json;
}

const checkRun = (c) => ({ name: c?.name, app_id: c?.app?.id, head_sha: c?.head_sha, status: c?.status, conclusion: c?.conclusion });

export async function checksAt(gh, base, sha) {
  const j = await json(gh, `${base}/commits/${sha}/check-runs?per_page=${MAX_LIST}`);
  if (Array.isArray(j.check_runs) && Number.isInteger(j.total_count) && j.total_count >= MAX_LIST) throw tooLong(`${j.total_count} check runs; the gate reads at most ${MAX_LIST - 1}`);
  if (!Array.isArray(j.check_runs) || !Number.isInteger(j.total_count)) throw failed('the check runs answer is not a list with a count');
  // Answered, but the count doesn't match the list: incomplete, not failed (L190 M3).
  if (j.total_count !== j.check_runs.length) throw new Error(`the check runs are cut off (${j.check_runs.length} listed of ${j.total_count})`);
  return j.check_runs.map(checkRun);
}

export async function statusesAt(gh, base, sha) {
  const j = await json(gh, `${base}/commits/${sha}/status?per_page=${MAX_LIST}`);
  if (Array.isArray(j.statuses) && Number.isInteger(j.total_count) && j.total_count >= MAX_LIST) throw tooLong(`${j.total_count} statuses; the gate reads at most ${MAX_LIST - 1}`);
  if (!Array.isArray(j.statuses)) throw failed('the statuses answer is not a list');
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

// A read that FAILED throws (err.unreadable = true, the message starts with the HTTP status); gather turns that into
// { ok: false, unreadable: true }. A list of 100+ threads is a fact, refused for good (L182): { ok: false, tooLong }.
// A count that doesn't match the list was answered but is incomplete (L190 M3): { ok: false, incomplete }, a wait that
// counts toward the cap.
export async function threads(gh, owner, repo, pr) {
  let r;
  try { r = await gh.post('/graphql', { query: threadsQuery, variables: { owner, repo, pr } }); } catch (e) { throw failed(`the review threads could not be read: ${String(e?.message ?? e).slice(0, 200)}`); }
  const t = r?.json?.data?.repository?.pullRequest?.reviewThreads;
  if (r?.status !== 200 || r.json?.errors || !t || !Array.isArray(t.nodes)) { const e = new Error(r?.status !== 200 ? `${Number.isInteger(r?.status) ? `HTTP ${r.status}` : 'no answer'}: the review threads could not be read` : 'GitHub answered 200 but with an error: the review threads could not be read'); e.unreadable = true; throw e; }
  if (Number.isInteger(t.totalCount) && t.totalCount >= MAX_LIST) return { ok: false, tooLong: `${t.totalCount} review threads; the gate reads at most ${MAX_LIST - 1}` };
  if (t.totalCount !== t.nodes.length) return { ok: false, incomplete: `GitHub counts ${t.totalCount} review threads but lists ${t.nodes.length}` };
  // A human thread: its first comment's author is a User. A bot's thread (a linter) is not a person waiting on an answer.
  const unresolved = t.nodes.filter((n) => n?.isResolved !== true && n?.comments?.nodes?.[0]?.author?.__typename !== 'Bot').length;
  return { ok: true, unresolved };
}

// A row file at the change's head. 404: the row isn't there (null, a reason for the go check). Any other status but
// 200 is a read that went wrong, thrown for the go check's attempt to class (L205), never read as "no row".
async function defaultReadRow(gh, base, id, head) {
  let j;
  try { j = await json(gh, `${base}/contents/${encodeURIComponent(`docs/blueprint/rows/${id}.yaml`).replace(/%2F/g, '/')}?ref=${head}`); } catch (e) { if (e?.status === 404) return null; throw e; }
  if (j?.encoding !== 'base64') return null;
  try { return parseYaml(Buffer.from(j.content, 'base64').toString('utf8'), `${id}.yaml`); } catch { return null; }
}

// One read per fact; each failure becomes that fact's "unknown". `onError` sees the error (a too-long list, L182).
const attempt = async (fn, fallback = null, onError = () => {}) => { try { return await fn(); } catch (e) { onError(e); return fallback; } };

/**
 * Carry-over from H0 (what was reviewed) to `head`, the one reading the Merge Gate and the review runner both make (L80):
 * the branch's own commits since H0, both merge-bases with main, and the Tier-1 merges the audit did not see.
 * `view` is a git view (M10 git-view.mjs, or M5 local-view.mjs over the mirror); `merges` the Record's merge documents.
 * → carryOver's { review, audit, reasons }, plus `head`: the head it was worked out for. Throws when git can't answer.
 */
export async function carriedFrom({ view: raw, merges, mergeId, H0, head, mainSha, catchUps }) {
  // Every read here is watched: carryOver turns a failed read into "does not carry over" (L205), and a read of the
  // history below that fails is a failed read, not an answer.
  const w = watchReads({ view: raw });
  const { view } = w;
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
  for (const m of merges) {
    if (m.id === mergeId || m.doc?.tier !== 1 || !['merged', 'audited_ok', 'audit_flagged'].includes(m.doc?.state)) continue;
    if (!SHA.test(m.doc.merge_commit ?? '') || !(await view.onHistory(m.doc.merge_commit, B0))) tier1MergesSince += 1;
  }
  return { ...throwIfUnread(await carryOver({ reviewed: { base: B0, head: H0 }, current: { base: B1, head }, between, catchUps: Array.isArray(catchUps) ? catchUps : [], tier1MergesSince, gh: view }), w.seen), head };
}

export async function gatherFacts(ctx, merge) {
  const { record, rules, product, gh, owner, repo, view } = ctx;
  const base = `/repos/${owner}/${repo}`;
  const get = (key) => { try { return rules.get(key, { product }); } catch { return undefined; } };
  const rv = recordView(record);
  const cardEntry = record.read('card', merge.doc.card);
  const card = cardEntry && !cardEntry.corrupt ? { id: cardEntry.id, rev: cardEntry.rev, doc: cardEntry.doc } : null;
  const f = { cutoverStage: get('product.cutover_stage') === 'second' ? 'second' : 'first', card };
  if (!card) return f;
  // The reads that FAILED this pass (failedRead), by name: the gate's `passUnreadable` reads them (L190 M2-M4).
  f.unreadReads = [];
  const markFailed = (which, also = () => {}) => (e) => { if (failedRead(e)) f.unreadReads.push(which); also(e); };
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
  f.main = { sha: mainSha, green: mainSha && f.requiredChecks ? await attempt(() => mainGreen(gh, base, mainSha, f.requiredChecks, f.checksIgnored), null, markFailed('main checks')) : null };
  // A check or status list longer than the gate reads (L182): checksTooLong says so, and refusal 1 is final.
  // tooLongLists names which list it was, so the gate doesn't read that empty list as GitHub down (L187 c1).
  // A list GitHub answered but cut off (L190 M3/M4) is checksCutOff: a wait with GitHub readable, so it counts toward the cap.
  const longList = (which) => markFailed(which, (e) => {
    if (e?.tooLong) { f.checksTooLong = String(e.message); f.tooLongLists = [...(f.tooLongLists ?? []), which]; } else if (!failedRead(e)) f.checksCutOff = String(e?.message ?? e).slice(0, 200);
  });
  f.checks = head ? await attempt(() => checksAt(gh, base, head), null, longList('checks')) : null;
  f.statuses = head ? await attempt(() => statusesAt(gh, base, head), null, longList('statuses')) : null;

  // The change: main...head.
  const cmp = head && mainSha ? await attempt(() => json(gh, `${base}/compare/${mainSha}...${head}`), null, markFailed('compare', (e) => { if (!failedRead(e)) f.compareAnswered = true; })) : null;
  f.compareStatus = typeof cmp?.status === 'string' ? cmp.status : null;
  const cmpFiles = Array.isArray(cmp?.files) ? cmp.files : null;
  const rawFiles = cmpFiles && cmpFiles.length < COMPARE_FILE_LIMIT ? cmpFiles : null;
  // Each file's mode from the tree (compare gives none): a link, submodule or runnable file is refused by mode alone,
  // so a list whose modes can't all be read is no list (R-0b-98's planted link). A removed file has its old mode.
  const mb = SHA.test(cmp?.merge_base_commit?.sha ?? '') ? cmp.merge_base_commit.sha : null;
  let noEntry = null;
  f.files = rawFiles && mb ? await attempt(() => Promise.all(rawFiles.map(async (x) => {
    const e = await view.entry(x.status === 'removed' ? mb : head, x.filename);
    if (!e) { noEntry ??= x.filename; throw new Error(`${x.filename}: no tree entry`); }
    return { path: x.filename, ...(x.previous_filename ? { previous_path: x.previous_filename } : {}), status: x.status === 'changed' ? 'modified' : x.status, mode: e.mode, ...(typeof x.sha === 'string' ? { blob: x.sha } : {}), ...linesOf(x.patch) };
  })), null, markFailed('files')) : null;
  // Why there is no file list (L182). 'too_many': compare was read, but GitHub lists at most COMPARE_FILE_LIMIT files,
  // so the list is cut off; 'no_entry': a listed file is not in its commit's file list (both commits are fixed, so a
  // later pass reads the same). Either is a fact about the change, and refusals 8, 9, 10 and 14 are final. 'unread':
  // a read failed (GitHub down, an odd answer), which a later pass may read: those refusals wait.
  f.filesProblem = f.files ? null : cmpFiles && cmpFiles.length >= COMPARE_FILE_LIMIT ? 'too_many' : noEntry ? 'no_entry' : 'unread';
  if (f.filesProblem === 'no_entry') f.filesMissing = noEntry;
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
    // Each on watched reads: a read that failed leaves the answer unknown (exactReverseUnread, reversesGateMergeUnread),
    // so the judge waits instead of refusing the undo for good (L205).
    const unread = (key, which) => markFailed(which, () => { f[key] = true; });
    f.exactReverse = (await attempt(async () => { const w = watchReads({ view }); return throwIfUnread(await checkExactReverse({ view: w.view, reverses, merged: f.pr.merge_commit_sha }), w.seen); }, { ok: false }, unread('exactReverseUnread', 'exact reverse'))).ok === true;
    const robotBotId = botId(get('product_profile.robot'));
    f.reversesGateMerge = (await attempt(async () => { const w = watchReads({ gh }); return throwIfUnread(await readMark({ gh: w.gh, owner, repo, sha: reverses, robotBotId }), w.seen); }, { ok: false }, unread('reversesGateMergeUnread', 'robot mark'))).ok === true;
    const m = record.list('merge').find((x) => x.doc?.merge_commit === reverses);
    reversedAudit = m?.doc?.state === 'audit_flagged' ? 'failure' : m?.doc?.state === 'audited_ok' ? 'success' : 'none';
  }
  const reversesFiles = reverses ? await attempt(async () => { const k = await view.commit(reverses); return (await view.files(k.parents[0], reverses)).flatMap((x) => [x.path, ...(x.previous_path ? [x.previous_path] : [])]); }, []) : undefined;
  f.lane = f.files ? (() => { try { return rules.may('merge', { product, card: { id: card.id, ...card.doc }, truncated: false, labels: f.pr?.labels ?? [], declared_tier: card.doc.tier, kind, reverses: reverses ?? undefined, exact_reverse_ok: f.exactReverse, reversed_audit: reversedAudit, reverses_files: reversesFiles, files: f.files }); } catch { return null; } })() : null;

  // Carry-over, when the pull request's head is no longer the head that was reviewed.
  const catchUps = Array.isArray(merge.doc.catch_ups) ? merge.doc.catch_ups : [];
  f.carried = null;
  if (head && SHA.test(H0 ?? '') && head !== H0 && mainSha) {
    f.carried = await attempt(() => carriedFrom({ view, merges: record.list('merge'), mergeId: merge.id, H0, head, mainSha, catchUps }),
      { review: false, audit: false, unread: true, reasons: ['carry-over could not be read'] }, markFailed('carry-over'));
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
    try { tree = (await view.commit(sha)).tree; } catch (e) { return { ok: false, unreadable: failedRead(e), reason: `the tree of ${String(sha).slice(0, 7)} could not be read (${e?.message ?? e})` }; }
    if (!SHA.test(tree ?? '')) return { ok: false, reason: `the tree of ${String(sha).slice(0, 7)} could not be read` };
    try {
      return headReviews({ launches: ctx.reviewLaunches.root, outboxRoot: ctx.reviewLaunches.outbox, uids: ctx.reviewLaunches.uids, card: card.id, head: sha, tree });
    } catch (e) { return { ok: false, reason: `the review records could not be read (${e?.message ?? e})` }; }
  };
  const hr = SHA.test(H0 ?? '') ? await reviewsAt(H0) : { ok: false, reason: 'the card has no head' };
  f.reviews = hr.ok ? hr.sessions : null;
  f.reviewsProblem = hr.ok ? null : hr.reason;
  if (hr.unreadable === true) f.unreadReads.push('reviewed head');
  f.prReviews = null; f.prReviewsProblem = null;
  let prSkipped = [];
  if (SHA.test(head ?? '') && head !== H0) {
    const pr = await reviewsAt(head);
    f.prReviews = pr.ok ? pr.sessions : null;
    f.prReviewsProblem = pr.ok ? null : pr.reason;
    if (pr.unreadable === true) f.unreadReads.push('pull request head');
    prSkipped = pr.ok ? pr.skipped ?? [] : [];
  }
  // A launch record no card can be tied to is skipped by the check; it is logged here (the review runner tells Joe once).
  const skipped = [...new Map([...(hr.skipped ?? []), ...prSkipped].map((x) => [x.name, x])).values()];
  if (skipped.length) f.reviewsSkipped = skipped.map((x) => `${x.name}: ${x.reason}`);

  // The owner's Approve (refusals 8, 13, 14): needed per M2, and standing on GitHub now.
  const apx = ctx.approvals ?? { record, rules, product, now: ctx.now, alert: ctx.alert ?? (() => {}), gh, owner, repo };
  const need = approveNeeded({ risky, needsJoe: card.doc.needs_joe === true || card.doc.approval_required === true, tier: f.tier, module: card.doc.module }, rules, product);
  const ask = askStore(record).asks().filter((a) => a.doc.card === card.id && activeKind(a.doc.kind)?.merge_approve && a.doc.state === 'answered').sort((a, b) => String(b.doc.raised_at).localeCompare(String(a.doc.raised_at)))[0];
  // A check that could not read GitHub (M2's `unreadable`, or a watched read that failed inside M10's carry-over) or
  // that threw leaves the Approve unknown (`unread`): refusals 8, 13 and 14 wait on it (L205).
  let apUnread = null;
  const stand = ask && head ? await attempt(async () => {
    const w = watchReads({ view });
    return throwIfUnread(await approvalStands(apx, ask.id, { head, view: w.view, catchUps }), w.seen);
  }, null, markFailed('approve', (e) => { apUnread = `the Approve could not be read from GitHub: ${String(e?.message ?? e).slice(0, 200)}`; })) : { ok: false, reason: 'no answered Approve for this card' };
  f.approve = stand ? { needed: need.needed, why: need.why, stands: stand.ok === true, reason: stand.ok ? null : stand.reason }
    : { needed: need.needed, why: need.why, stands: false, unread: true, reason: apUnread };

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
    // M2 marks a check that could not read GitHub `unreadable` (L205): thrown here, so the go is unknown (f.go null,
    // refusal 10 waits) and markFailed classes the read.
    const w = watchReads({ view });
    return throwIfUnread(await goCheck({ go: go.doc, card: { id: card.id, root: rootId, doc: card.doc }, changed: f.files, headRows, tier: f.tier, view: w.view, mainSha }), w.seen);
  }, null, markFailed('go')) : null;

  // A threads read that failed is unreadable; one GitHub answered with a 4xx (Minor 1) waits and counts toward the cap.
  let threadsErr = null;
  f.threads = Number.isInteger(merge.doc.pr) ? await attempt(() => threads(gh, owner, repo, merge.doc.pr), null, markFailed('threads', (e) => { threadsErr = e; })) : { ok: false };
  if (f.threads === null) f.threads = { ok: false, unreadable: failedRead(threadsErr) };

  // The rules this gate runs on are the ones adopted at main (hold, never refuse).
  f.rulesAdopted = mainSha ? await attempt(async () => {
    const adopted = get('rules.adopted');
    const at = await json(gh, `${base}/contents/${RULES_PATH}?ref=${mainSha}`);
    return typeof adopted?.blob === 'string' && adopted.blob === at.sha;
  }, null, markFailed('rules at main')) : null;
  return f;
}
