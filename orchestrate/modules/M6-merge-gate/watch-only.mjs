// watch-only.mjs — the Merge Gate's dry run on the product's real merges (R-0b-122, first-cutover version).
//
// WHAT. For a week before the first cutover, every commit that reaches the product's main is judged the way the gate would
// have judged it, and the answer is written to a log next to what MAIN actually did. Nothing is installed on the product,
// nothing is written to GitHub (the token is read only, and this file can only GET, plus the one read-only GraphQL query),
// and nothing here holds merge power: the owner's own login still merges until the cutover.
//
// THE JUDGING IS THE GATE'S OWN. `judgeMerged` builds the facts object the gate builds (gather.mjs) from GitHub, puts it
// through the gate's real `judge()` (refusals.mjs) and a one-product M10 engine (classify, may('merge')); no copy of either.
// What a merged commit cannot tell afterwards is listed on every line as `not_judged`, never as passed: 2 (main red then),
// 3 (the pull request's state then), 5 (reviewer verdict), 10 (go), 11 (merge request), 12 (behind main), 13 (fix card).
// Judged: 1, 4, 6, 7, 8, 9, 14 (and 0, the gate failing to judge). Assumed, and said on every line: declared tier 2,
// product state active. Verdict: 'would merge' | 'would ask for the owner\'s Approve' | 'would hold' | 'would refuse'. Every
// verdict but 'would merge' disagrees with MAIN and needs a written explanation (see `summary`).
//
// THE RULES. Before the cutover the product has no rules file on main, so the rules are the owner's OK'd draft, pinned by
// its sha256 (the hash comes from the root-owned setup, the file sits in the watch folder; a different hash = "not judged").
// After the cutover the rules are read from GitHub at the judged merge's FIRST PARENT (main just before the merge) and
// must be approved the way M10's reader approves them. In every case a failed read says the HTTP status first.
//
// THE WEEK. The first pass pins main's head (the pin); nothing before it is judged and the window starts at that pass.
// Every pass proves the pin is still an ancestor of main's head (GitHub compare: ahead or identical), then walks main's
// first-parent chain from head back to the pin every pass (skipping commits already judged), so a commit can't slip between passes.
// Days are UTC, by `merged_at` (a direct push: by when a pass first saw it); the first counted day is the day after the pin. A different rules draft restarts the week (a new pin).
//
// FILES (in `dir`, the runner's own folder): log.jsonl (one JSON line per commit, pin or pass), rules-draft.yaml, watch.lock.
// Explanations are NOT in `dir`: they come from a file the owner's Mac user owns, in a folder only that user can write (`<base>/watch-notes`, which orchestrate can read).
// The token is read from a file the runner's own user owns, mode 0600; never put in a log line, an error or an argument.

import { closeSync, constants, fstatSync, openSync, readFileSync, appendFileSync, existsSync, statSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { MAX_BYTES, RULES_PATH, blobSha, findApprovingPull } from '../M10-rules/reader.mjs';
import { approveNeeded } from '../M2-approvals/go.mjs';
import { makeRules } from '../../shared/rules.mjs';
import { botId, linesOf, threads as threadsOf, threadsQuery } from './gather.mjs';
import { judge } from './refusals.mjs';

export const NOT_JUDGED = Object.freeze([2, 3, 5, 10, 11, 12, 13]);
export const ASSUMED = Object.freeze({ declared_tier: 2, product_state: 'active' });
export const VERDICTS = Object.freeze(['would merge', 'would ask for the owner\'s Approve', 'would refuse', 'would hold']);
export const DRAFT_FILE = 'rules-draft.yaml';
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_LIST = 100;
const MAX_WALK = 1000;
const FRESH_MS = 3_600_000;
const LOCK_STALE_MS = 20 * 60_000;
const PRODUCT = 'watch';
const here = dirname(fileURLToPath(import.meta.url));
const ROLES = join(here, '../M10-rules/roles');

/** The token, from the file the runner's own user owns (0600), as a function so it is never held in a variable others can print. */
export function tokenFile(path, { uid = process.getuid?.() } = {}) {
  return () => {
    let fd;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error('the watch-only token file could not be opened'); }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.size < 20 || st.size > 1024) throw new Error('the watch-only token file is not this user\'s own private file');
      return readFileSync(fd, 'utf8').trim();
    } finally { closeSync(fd); }
  };
}

/** A GitHub client that can only read: GET on /repos, and the one read-only GraphQL query. Host fixed. */
export function readOnlyClient({ token, fetchFn = globalThis.fetch, timeoutMs = 15_000 }) {
  const call = async (method, path, body) => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token()}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  };
  return Object.freeze({
    get: async (path) => { if (!path.startsWith('/repos/') || /\/\.\.(\/|$|\?)/.test(path)) throw new Error('only repository reads are allowed'); return call('GET', path); },
    post: async (path, body) => { if (path !== '/graphql' || body?.query !== threadsQuery) throw new Error('the only write-shaped call allowed is the read-only threads query'); return call('POST', path, body); },
  });
}

// ---- the rules ---------------------------------------------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (h) => String(h).slice(0, 12);
const failText = (e) => String(e?.message ?? e).slice(0, 200);

/** Reads a small regular file without following a link; throws a plain reason. */
function readPlain(path, max) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { throw new Error(e?.code === 'ENOENT' ? 'the file is not there' : 'the file could not be opened (a link, or no permission)'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not a plain file');
    if (st.size > max) throw new Error('the file is too big');
    return { buf: readFileSync(fd), st };
  } finally { closeSync(fd); }
}

const engineFor = (policy, commit, blob) => makeRules(makeEngine({ products: [PRODUCT], rulesState: () => ({ status: 'ok', policy, commit, blob }),
  productState: () => ({ state: ASSUMED.product_state }), running: () => 0, rolesDir: ROLES, clock: () => Date.now() }));

/** The owner's OK'd draft, pinned by hash. rules(commit) → { policy, engine, id } or { reason }. Same answer for every commit. */
export function draftRules({ dir, sha256: pinned }) {
  return {
    kind: 'draft', id: HEX64.test(pinned ?? '') ? pinned : null,
    async at() {
      if (!HEX64.test(pinned ?? '')) return { reason: 'the setup names no pinned hash for the rules draft' };
      let buf;
      try { buf = readPlain(join(dir, DRAFT_FILE), MAX_BYTES).buf; } catch (e) { return { reason: `the rules draft could not be read (${e.message})` }; }
      const h = sha256(buf);
      if (h !== pinned) return { reason: `the rules draft is not the pinned one (draft ${short(h)}, pinned ${short(pinned)})` };
      const parsed = parsePolicy(buf.toString('utf8'));
      if (!parsed.ok) return { reason: `the rules draft is not usable (${parsed.reason})` };
      return { policy: parsed.policy, engine: engineFor(parsed.policy, '0'.repeat(40), '0'.repeat(40)), id: h };
    },
  };
}

/**
 * The rules from GitHub at `parent` (main just before the judged merge), approved as M10's reader approves (the pull
 * request that put them on main, merged, whose head holds the same file). Reasons start with the HTTP status.
 */
export function githubRules({ gh, owner, repo }) {
  let last = null; // the last version approved in this pass: { commit, blob }; the next different version must have landed after it (M10's replay guard)
  return {
    kind: 'github', id: null,
    async at(parent) {
      if (!SHA.test(parent ?? '')) return { reason: 'no commit before this one to read the rules at' };
      let r;
      try { r = await gh.get(`/repos/${owner}/${repo}/contents/${RULES_PATH}?ref=${parent}`); } catch (e) { return { reason: `read error: the rules file at ${parent.slice(0, 7)} could not be asked for (${failText(e)})` }; }
      if (r?.status === 404) return { reason: `HTTP 404: there is no rules file at ${parent.slice(0, 7)}` };
      if (r?.status !== 200 || !r.json) return { reason: `HTTP ${r?.status}: the rules file at ${parent.slice(0, 7)} could not be read` };
      const j = r.json; const buf = typeof j.content === 'string' && j.encoding === 'base64' ? Buffer.from(j.content, 'base64') : null;
      if (!SHA.test(j.sha ?? '') || !buf || buf.length > MAX_BYTES || buf.length !== j.size || blobSha(buf) !== j.sha) return { reason: `HTTP 200: the rules file at ${parent.slice(0, 7)} does not match the version GitHub named` };
      const parsed = parsePolicy(buf.toString('utf8'));
      if (!parsed.ok) return { reason: `HTTP 200: the rules file at ${parent.slice(0, 7)} is not usable (${parsed.reason})` };
      if (!(last && last.blob === j.sha)) {
        const ok = await findApprovingPull({ gh, owner, repo, commit: parent, blob: j.sha, after: last?.commit ?? null });
        if (!ok.ok) { const st = /GitHub answered (\d{3})/.exec(ok.reason ?? ''); return { reason: `${st ? `HTTP ${st[1]}: ` : ''}not approved: ${ok.reason}` }; }
        last = { commit: parent, blob: j.sha };
      }
      return { policy: parsed.policy, engine: engineFor(parsed.policy, parent, j.sha), id: j.sha };
    },
  };
}

// ---- the judging -------------------------------------------------------------------------------------------------------

/**
 * The verdict from the facts `gatherMerged` returns, through the gate's real judge(). `rules` is { policy, engine }.
 * What cannot be judged afterwards (NOT_JUDGED) is dropped from the refusals and listed instead.
 */
/** Only a refusal 8 that says the owner's Approve is NEEDED is a plain \"would ask\"; refusal 14 and an Approve check that could not run are refusals. */
export const asksApprove = (r) => r?.n === 8 && /needs the owner's Approve|the rules ask for the owner's Approve/.test(r.reason ?? '');

export function judgeMerged(facts, rules) {
  const NJ = [...NOT_JUDGED];
  if (facts.direct) return { verdict: VERDICTS[2], refusals: [{ n: 9, reason: 'a push to main with no pull request: the gate only merges pull requests' }], tier: null, risky: [], not_judged: NJ, assumed: ASSUMED };
  const { policy, engine } = rules;
  const get = (key) => { try { return engine.get(key, { product: PRODUCT }); } catch { return undefined; } };
  const files = facts.files;
  const labels = facts.labels ?? [];
  const c = files ? engine.classify({ product: PRODUCT, files, truncated: false, labels, declared_tier: ASSUMED.declared_tier }) : null;
  const tier = c && (c.tier === 1 || c.tier === 2) ? c.tier : null;
  const risky = c?.risky ?? ['unclassifiable'];
  const sha7 = String(facts.sha).slice(0, 7);
  const card = { id: `watch-${sha7}`, doc: { kind: 'ordinary', head: facts.headSha, tier: ASSUMED.declared_tier } };
  let lane = null;
  if (files) { try { lane = engine.may('merge', { product: PRODUCT, card: { id: card.id, ...card.doc }, truncated: false, labels, declared_tier: ASSUMED.declared_tier, kind: 'ordinary', files }); } catch { lane = null; } }
  const need = approveNeeded({ risky, needsJoe: false, tier, module: undefined }, engine, PRODUCT);
  const required = get('product_profile.required_checks');
  const ignoredRaw = get('product_profile.checks_ignored');
  const fcv = get('effect_paths')?.first_customer_visible?.new_files_under;
  const f = {
    cutoverStage: get('product.cutover_stage') === 'second' ? 'second' : 'first', card,
    // Placeholders for what NOT_JUDGED lists: the refusals they could cause are dropped below, never read.
    pr: { number: facts.pr, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', base: { ref: facts.prBase }, head: { sha: facts.headSha }, merge_commit_sha: facts.sha, labels },
    main: { green: true }, request: null, go: { ok: true, skipped: true }, compareStatus: 'ahead', rulesAdopted: true, exactReverse: false, reviews: [], movesSinceRequest: [],
    checks: facts.checks, statuses: facts.statuses, requiredChecks: Array.isArray(required) ? required : null,
    checksIgnored: Array.isArray(ignoredRaw) ? ignoredRaw.map((x) => ({ app_id: botId({ bot_user_id: x?.app_id }), name: x?.name })) : [],
    threads: facts.threads, files, firstCustomerNewFiles: Array.isArray(fcv) ? fcv : null, tier, lane,
    approve: { needed: need.needed, why: need.why, stands: false, reason: null },
  };
  const j = judge(f);
  const refusals = j.refusals.filter((r) => !NJ.includes(r.n));
  const hard = refusals.filter((r) => !asksApprove(r));
  const verdict = hard.length ? VERDICTS[2] : refusals.length ? VERDICTS[1] : j.decision === 'hold' ? VERDICTS[3] : VERDICTS[0];
  return { verdict, refusals, tier, risky, not_judged: NJ, assumed: ASSUMED, ...(j.hold ? { hold: j.hold } : {}) };
}

/**
 * Gathers the facts for one commit on main. → { unreadable: "<reason>" } when a read FAILED (the commit is tried again
 * next pass, never judged on a gap), else the facts. A list too long to read whole is a fact (refusal 1), not a failure.
 */
export async function gatherMerged({ gh, owner, repo, policy, sha, now = () => Date.now() }) {
  const base = `/repos/${owner}/${repo}`;
  const view = makeGitView({ gh, owner, repo });
  const fail = (what, e) => { const err = new Error(`${failText(e)}: ${what}`); err.unreadable = true; throw err; };
  const get = async (path, what) => {
    let r; try { r = await gh.get(path); } catch (e) { fail(what, e); }
    if (r?.status !== 200 || r.json == null) fail(what, `HTTP ${r?.status}`);
    return r.json;
  };
  try {
    const c = await (async () => { try { return await view.commit(sha); } catch (e) { return fail('the commit', e); } })();
    const pulls = await get(`${base}/commits/${sha}/pulls?per_page=${MAX_LIST}`, 'the pull requests for the commit');
    if (!Array.isArray(pulls)) fail('the pull requests for the commit', 'odd answer');
    const listed = pulls.filter((p) => Number.isInteger(p?.number));
    const commitTime = Date.parse((await get(`${base}/commits/${sha}`, 'the commit')).commit?.committer?.date ?? '');
    if (!Number.isFinite(commitTime)) fail('the commit', 'it has no readable date');
    if (listed.length === 0 && now() - commitTime < FRESH_MS) fail('the pull requests for the commit', 'an empty list for a commit under an hour old; GitHub may not have linked it yet');
    if (listed.length === 0) return { direct: true, sha, mergedAt: new Date(commitTime).toISOString(), mergedBy: null, pr: null };
    const num = (listed.find((p) => p.merge_commit_sha === sha) ?? listed[0]).number;
    const pr = await get(`${base}/pulls/${num}`, `pull request ${num}`);
    if (pr.merged !== true) return { direct: true, sha, mergedAt: new Date(commitTime).toISOString(), mergedBy: null, pr: null };
    const headSha = SHA.test(pr?.head?.sha ?? '') ? pr.head.sha : fail(`pull request ${num}`, 'no head');
    const parent = c?.parents?.[0] ?? fail('the commit', 'no parent');
    const cmp = await get(`${base}/compare/${parent}...${sha}`, 'the change');
    const raw = Array.isArray(cmp.files) && cmp.files.length < 300 ? cmp.files : null;
    let files = null;
    if (raw) {
      try {
        files = await Promise.all(raw.map(async (x) => {
          const e = await view.entry(x.status === 'removed' ? parent : sha, x.filename);
          if (!e) throw new Error(`${x.filename}: no tree entry`);
          return { path: x.filename, ...(x.previous_filename ? { previous_path: x.previous_filename } : {}), status: x.status === 'changed' ? 'modified' : x.status, mode: e.mode, ...linesOf(x.patch) };
        }));
      } catch (e) { fail('the files', e); }
    }
    let checks = null;
    { const j = await get(`${base}/commits/${headSha}/check-runs?per_page=${MAX_LIST}`, 'the check runs');
      if (Array.isArray(j.check_runs) && Number.isInteger(j.total_count) && j.total_count < MAX_LIST && j.total_count === j.check_runs.length) checks = j.check_runs.map((x) => ({ name: x?.name, app_id: x?.app?.id, head_sha: x?.head_sha, status: x?.status, conclusion: x?.conclusion })); }
    let statuses = null;
    { const j = await get(`${base}/commits/${headSha}/status?per_page=${MAX_LIST}`, 'the statuses');
      if (Array.isArray(j.statuses) && !(Number.isInteger(j.total_count) && j.total_count >= MAX_LIST)) statuses = j.statuses.map((s) => ({ context: s?.context, state: s?.state })); }
    let threads;
    try { threads = await threadsOf(gh, owner, repo, num); } catch (e) { fail('the review threads', e); }
    return {
      direct: false, sha, pr: num, mergedAt: pr.merged_at ?? null, mergedBy: pr.merged_by?.login ?? null, prBase: pr.base?.ref ?? null, headSha, checks, statuses, threads, files,
      labels: (pr.labels ?? []).map((l) => l?.name).filter((n) => typeof n === 'string'),
    };
  } catch (e) { if (e?.unreadable) return { unreadable: e.message }; throw e; }
}

// ---- the log and the pass ----------------------------------------------------------------------------------------------

const isCommit = (l) => typeof l.sha === 'string' && l.pin !== true && l.pass !== true;
const day = (iso) => String(iso).slice(0, 10);
export function readLog(dir) {
  const f = join(dir, 'log.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' ? o : { corrupt: true }; } catch { return { corrupt: true }; } });
}

function appendLine(dir, o) {
  const fd = openSync(join(dir, 'log.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { appendFileSync(fd, `${JSON.stringify(o)}\n`); } finally { closeSync(fd); }
}

/** One pass at a time: a lock file made exclusively; one older than 20 minutes is a dead pass's and is replaced. */
function takeLock(dir, nowMs) {
  const path = join(dir, 'watch.lock');
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); return () => { try { unlinkSync(path); } catch { /* gone */ } }; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0; try { age = nowMs - statSync(path).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) return null;
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  return null;
}

/**
 * One pass. `rules` is draftRules(...) or githubRules(...). → { judged, skipped, problems, locked? }. Never writes to GitHub.
 * Every pass line records the main head it saw, the pin, and whether the pin is still an ancestor.
 */
export async function watchPass({ gh, owner, repo, dir, rules, now = () => new Date().toISOString(), maxWalk = MAX_WALK }) {
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '') || owner === '.' || owner === '..' || repo === '.' || repo === '..') throw new Error('watch needs an owner and repo');
  const at = now();
  const release = takeLock(dir, Date.parse(at));
  if (!release) return { judged: 0, skipped: 0, problems: [], locked: true };
  try { return await pass({ gh, owner, repo, dir, rules, at, now, maxWalk }); } finally { release(); }
}

async function pass({ gh, owner, repo, dir, rules, at, now, maxWalk }) {
  const base = `/repos/${owner}/${repo}`;
  const problems = [];
  let ruleId = null;
  const log = (o) => appendLine(dir, o);
  const done = (head, pin, judged, skipped) => { log({ pass: true, at, head, pin_sha: pin, pin_ok: pinOk, rules: ruleId ?? rules.kind, judged, skipped, problems }); return { judged, skipped, problems }; };
  let pinOk = false;
  const lines = readLog(dir);
  let head;
  try {
    const r = await gh.get(`${base}/commits/main`);
    if (r?.status !== 200 || !SHA.test(r.json?.sha ?? '')) throw new Error(`HTTP ${r?.status}`);
    head = r.json.sha;
  } catch (e) { problems.push(`main's head could not be read (${failText(e)})`); return done(null, null, 0, 0); }
  // The pin: main's head at the first pass of this rules draft; a different draft restarts the week (a new pin).
  const pins = lines.filter((l) => l.pin === true && SHA.test(l.sha ?? ''));
  let pin = pins.at(-1) ?? null;
  // A draft with no pinned hash is a setup fault, not a different draft: it never restarts the week.
  ruleId = rules.kind === 'draft' ? (rules.id ?? pin?.rules ?? 'draft') : rules.kind;
  if (!pin || pin.rules !== ruleId) {
    pin = { pin: true, at, sha: head, how: 'main\'s head at the first pass', rules: ruleId, ...(pin ? { restart_of: pin.sha, why: pin.rules === 'github' || ruleId === 'github' ? 'the rules source changed' : 'the rules draft changed' } : {}) };
    log(pin); pinOk = true;
    return done(head, pin.sha, 0, 0);
  }
  // The pin must still be an ancestor of main's head, proven fresh every pass, whatever the walk below stops at.
  try {
    const r = await gh.get(`${base}/compare/${pin.sha}...${head}`);
    if (r?.status !== 200) throw new Error(`HTTP ${r?.status}`);
    if (r.json?.status === 'ahead' || r.json?.status === 'identical') pinOk = true; else problems.push(`the pin ${pin.sha.slice(0, 7)} is no longer an ancestor of main (compare says ${r.json?.status})`);
  } catch (e) { problems.push(`the pin could not be checked against main (${failText(e)})`); }
  // The rules draft must be the pinned one at every pass, even when no commit needs judging (a swapped draft shows up here).
  if (rules.kind === 'draft') { const r0 = await rules.at(head); if (!r0.policy) problems.push(`the rules draft check failed: ${r0.reason}`); }
  const judgedShas = new Set(lines.filter((l) => isCommit(l) && !l.not_judged_reason && l.at >= pin.at).map((l) => l.sha));
  // Walk main's first-parent chain from head back to the pin, every pass. Commits already judged are skipped, not a place to
  // stop: a newer judged commit must not hide an older one whose read failed.
  const chain = [];
  let reachedStop = false;
  if (pinOk) {
    const view = makeGitView({ gh, owner, repo });
    try {
      for (let s = head, n = 0; ; n++) {
        if (s === pin.sha) { reachedStop = true; break; }
        if (n >= maxWalk) break;
        if (!judgedShas.has(s)) chain.push(s);
        const c = await view.commit(s);
        if (!c.parents?.length) break;
        s = c.parents[0];
      }
    } catch (e) { problems.push(`main's history could not be walked (${failText(e)})`); reachedStop = true; }
    if (!reachedStop) problems.push(`main's history did not lead back to the pin within ${maxWalk} commits`);
  }
  let judged = 0; const skipped = 0;
  const notJudgedBefore = new Map(lines.filter((l) => isCommit(l) && l.not_judged_reason).map((l) => [l.sha, l.not_judged_reason]));
  for (const sha of chain.reverse()) {
    if (problems.length && !pinOk) break;
    const notJudged = (reason) => {
      problems.push(`${sha.slice(0, 8)}: not judged, ${reason}`);
      if (notJudgedBefore.get(sha) !== reason) { log({ sha, at, rules: ruleId, not_judged_reason: reason }); notJudgedBefore.set(sha, reason); }
    };
    let parent = null;
    try { parent = (await makeGitView({ gh, owner, repo }).commit(sha)).parents?.[0] ?? null; } catch (e) { notJudged(`${failText(e)}: the commit could not be read`); continue; }
    const r = await rules.at(parent);
    if (!r.policy) { notJudged(r.reason); continue; }
    const facts = await gatherMerged({ gh, owner, repo, policy: r.policy, sha, now: () => Date.parse(at) });
    if (facts.unreadable) { notJudged(facts.unreadable); continue; }
    const v = judgeMerged(facts, r);
    log({ sha, at, seen_at: at, merged_at: facts.mergedAt, pr: facts.pr, merged_by: facts.mergedBy, direct: facts.direct, rules: r.id ?? ruleId, ...v });
    judged++;
  }
  return done(head, pin.sha, judged, skipped);
}

// ---- the week ----------------------------------------------------------------------------------------------------------

/**
 * Explanations count only from a file the owner's Mac user owns, in a folder only that user can write, that nobody else
 * can write to. → { ok, explanations, owner, problem }. A file that is missing is an empty list; a bad one "does not count".
 */
export function readExplanations(path, { ownerUid }) {
  if (!path) return { ok: true, explanations: {}, owner: null, problem: null };
  const bad = (problem) => ({ ok: false, explanations: {}, owner: null, problem });
  try {
    let there = true;
    try { lstatSync(path); } catch (e) { if (e?.code === 'ENOENT') there = false; else throw e; }
    if (!there) return { ok: true, explanations: {}, owner: ownerUid, problem: null };
    const { buf, st } = readPlain(path, 1_000_000);
    const dst = statSync(dirname(path));
    if (st.uid !== ownerUid) return bad(`the explanations file is owned by user ${st.uid}, not the owner's user ${ownerUid}`);
    if ((st.mode & 0o022) !== 0) return bad('the explanations file can be written by others');
    if (dst.uid !== ownerUid || (dst.mode & 0o022) !== 0) return bad('the explanations folder is not only the owner\'s');
    const o = JSON.parse(buf.toString('utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('the explanations file is not a list of commit: reason');
    return { ok: true, explanations: o, owner: st.uid, problem: null };
  } catch (e) { return bad(`the explanations file could not be reached, so it does not count (${e?.code === 'EACCES' ? 'no permission to look' : failText(e)})`); }
}

/**
 * The week's result. Days are UTC, by merged_at. The week counts only when: the window (from the latest pin) covers at least
 * 7 UTC days up to `endDay`; every day has a clean pass; a clean pass at or after the start of the day after `endDay` saw
 * the pin still in place; no commit is stuck "not judged" or judged twice; the log has no damaged line; and every
 * disagreement with MAIN has an explanation from the owner's own file.
 */
export function summary({ dir, endDay, explanations: ex = { ok: true, explanations: {}, owner: null, problem: null } }) {
  const lines = readLog(dir);
  const pin = lines.filter((l) => l.pin === true).at(-1) ?? null;
  const out = { days: [], missingDays: [], judged: 0, wouldMerge: 0, disagreements: 0, unexplained: [], failedPasses: 0, corrupt: lines.filter((l) => l.corrupt).length, duplicates: [], stuck: [], windowStart: pin?.at ?? null, explanationsOwner: ex.owner, explanationsProblem: ex.problem, reasons: [], ok: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDay ?? '') || new Date(`${endDay}T00:00:00Z`).toISOString().slice(0, 10) !== endDay) { out.reasons.push('the end day is not a real date'); return out; }
  if (!pin) { out.reasons.push('no pass has run yet (no pin)'); return out; }
  const end = Date.parse(`${endDay}T00:00:00Z`);
  // The first counted day is the day AFTER the pin, unless the pin is exactly midnight: the pin day is only part of a day.
  const pinDay = Date.parse(`${day(pin.at)}T00:00:00Z`);
  for (let t = Date.parse(pin.at) === pinDay ? pinDay : pinDay + 86_400_000; t <= end; t += 86_400_000) out.days.push(new Date(t).toISOString().slice(0, 10));
  const after = lines.filter((l) => !l.corrupt && l.at >= pin.at);
  const cleanPass = (l) => l.pass === true && !(l.problems?.length) && l.pin_sha === pin.sha && l.pin_ok === true && l.rules === pin.rules && SHA.test(l.head ?? '');
  const clean = after.filter(cleanPass);
  const cleanDays = new Set(clean.map((l) => day(l.at)));
  out.missingDays = out.days.filter((d) => !cleanDays.has(d));
  out.failedPasses = after.filter((l) => l.pass === true && !cleanPass(l)).length;
  const rulesOk = (l) => pin.rules === 'github' || l.rules === pin.rules;
  const judgedLines = after.filter((l) => isCommit(l) && !l.not_judged_reason && rulesOk(l));
  const seen = new Map();
  for (const l of judgedLines) seen.set(l.sha, (seen.get(l.sha) ?? 0) + 1);
  out.duplicates = [...seen].filter(([, n]) => n > 1).map(([sha]) => sha);
  out.stuck = [...new Set(after.filter((l) => isCommit(l) && l.not_judged_reason).map((l) => l.sha))].filter((sha) => !seen.has(sha));
  // A direct push counts on the day a pass first saw it (its own date is the committer's to set); every judged line found
  // after the pin counts, an early date clamped to the first day of the window. Only a date past the end day is out.
  const countedDay = (l) => day((l.direct ? l.seen_at : l.merged_at) ?? l.seen_at ?? l.at);
  const inWindow = judgedLines.filter((l) => countedDay(l) <= endDay);
  const dis = inWindow.filter((l) => l.verdict !== VERDICTS[0]);
  out.judged = inWindow.length; out.wouldMerge = inWindow.length - dis.length; out.disagreements = dis.length;
  out.unexplained = (ex.ok ? dis.filter((l) => typeof ex.explanations[l.sha] !== 'string' || !ex.explanations[l.sha].trim()) : dis).map((l) => ({ sha: l.sha, pr: l.pr, verdict: l.verdict, refusals: l.refusals }));
  const finalAt = end + 86_400_000;
  const finalPass = clean.some((l) => Date.parse(l.at) >= finalAt);
  if (out.days.length < 7) out.reasons.push(`the window covers ${out.days.length} UTC day(s); a week needs 7`);
  if (out.missingDays.length) out.reasons.push(`days with no clean pass: ${out.missingDays.join(', ')}`);
  if (!finalPass) out.reasons.push(`no clean pass at or after ${new Date(finalAt).toISOString()}, so commits merged late on ${endDay} may be unseen`);
  if (out.stuck.length) out.reasons.push(`${out.stuck.length} commit(s) were "not judged" and never judged later`);
  if (out.duplicates.length) out.reasons.push(`${out.duplicates.length} commit(s) have two verdicts`);
  if (out.corrupt) out.reasons.push(`${out.corrupt} damaged log line(s)`);
  if (!ex.ok) out.reasons.push(`explanations do not count: ${ex.problem}`);
  if (out.unexplained.length) out.reasons.push(`${out.unexplained.length} disagreement(s) with MAIN have no explanation`);
  out.ok = out.reasons.length === 0;
  return out;
}
