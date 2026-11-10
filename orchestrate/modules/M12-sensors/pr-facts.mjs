// pr-facts.mjs — each pull request's GitHub facts, written into the record for the Lead (R-0b-74; v4 §8 B2, §14.2 m1).
//
// WHY. The Lead has no shell and no GitHub token, so the Sensors write what it used to look up: the changed files and
// a diff summary (per file: status, lines added and removed; no patch text), beside the checks at the head commit,
// the unresolved review threads and how far the branch is behind main. Every outside string is masked and fenced.
//
// The GitHub client is injected (robot identity on the Mini; a fake in tests). Shape it must return:
//   pr(number)       → { number, title, head_sha, base_ref, head_ref, author, state, merged, merge_commit_sha }
//
// The Dispatcher's merges step (M11 merges.mjs) reads state, merged, merge_commit_sha, head_sha and observed_at, and
// trusts only a reading taken after a merge attempt last changed (R-0b-168). So observed_at is taken from the injected
// clock just BEFORE the first GitHub read starts (LEAD-CALLS L97 M-2): a reading whose reads straddle a merge attempt
// is dated before it, so M11 waits for the next one instead of taking a pre-merge "open" as fresh. merged is true only
// for a literal true; merge_commit_sha is null unless merged (GitHub fills it with a test-merge commit on open PRs);
// state is `open` or `closed`, any case, else null (L97 m-1: another GitHub API says CLOSED, which M6 and M11 would
// read as never closed).
//   files(number)    → [{ filename, status, additions, deletions, previous_filename? }]
//   checks(sha)      → [{ name, status, conclusion, output_summary? }]; a throw here alone gives checks_at_head: null
//                      (not known) with its cause in checks_reason, and keeps the rest (L619: check runs need an App's
//                      client, L617, L627). The loop tells each such reading (L728, #287 r1 M1).
//   threads(number)  → [{ resolved, author, body, path? }]
//   behindBy(number) → integer commits behind base

import { makePrepare } from './escape.mjs';
import { makeMasker } from './mask.mjs';
import { validPath } from './history.mjs';
import { PR_FACT } from '../M11-dispatcher/merges.mjs';

// Paths go through as plain strings when valid (review-0b-7 Minor 4); an invalid one is replaced by a marker.
const keepPath = (x) => (validPath(x) ? x : '[path refused: control characters]');

// A read that fails (GitHub down, a time-out, an answer of the wrong shape) is written as an UNKNOWN reading with its
// time: state, merged and merge_commit_sha null, and nothing else claimed (R-0b-169: a failed reading never leaves the
// old value in place). Written here, by the one writer of pr- facts, so the loop never writes a pr- fact itself.
const KIND = 'fact.pr';
export const unknownPr = (number, observed_at) => ({ kind: KIND, number: Number.isInteger(number) ? number : null,
  head_sha: null, state: null, merged: null, merge_commit_sha: null, observed_at });

export async function prFact(gh, number, { prepare = makePrepare(), now = () => new Date() } = {}) {
  const observed_at = now().toISOString();
  try {
    return await readPr(gh, number, observed_at, prepare);
  } catch {
    return unknownPr(number, observed_at);
  }
}

async function readPr(gh, number, observed_at, prepare) {
  const [pr, files, threads, behind] = await Promise.all([gh.pr(number), gh.files(number), gh.threads(number), gh.behindBy(number)]);
  if (!pr || typeof pr !== 'object' || !Array.isArray(files) || !Array.isArray(threads)) throw new Error('a GitHub answer of the wrong shape');
  // checks_at_head: null means NOT KNOWN (the check runs could not be read), never "no checks"; [] means GitHub listed
  // none. Only this read is kept apart (L619): without an App's client every check read fails, and blanking the whole fact
  // for it would hide every merge from M11. Any other failed read still makes the whole reading unknown.
  // The cause is kept (masked, cut to 200 characters), so a checks read that keeps failing is told, never silent.
  let checks = null; let checksReason = null;
  try {
    const c = await gh.checks(pr.head_sha);
    if (Array.isArray(c)) checks = c;
    else checksReason = 'the check runs answer is not a list';
  } catch (e) { checksReason = makeMasker().maskSecrets(String(e?.message ?? e ?? 'the check runs read failed')).text.slice(0, 200); }
  const st = typeof pr.state === 'string' ? pr.state.toLowerCase() : null;
  const merged = pr.merged === true;
  const changed = files.map((f) => ({
    path: keepPath(f.filename),
    ...(f.previous_filename ? { from: keepPath(f.previous_filename) } : {}),
    status: f.status, added: f.additions, removed: f.deletions,
  }));
  return {
    kind: KIND,
    number: pr.number,
    title: prepare(pr.title, 'pr-title'),
    author: prepare(pr.author, 'commit-author'),
    head_sha: pr.head_sha,
    state: st === 'open' || st === 'closed' ? st : null,
    merged,
    merge_commit_sha: merged ? pr.merge_commit_sha ?? null : null,
    observed_at,
    base: keepPath(pr.base_ref),
    branch: keepPath(pr.head_ref),
    changed_files: changed,
    diff_summary: {
      files: changed.length,
      added: changed.reduce((n, f) => n + (f.added ?? 0), 0),
      removed: changed.reduce((n, f) => n + (f.removed ?? 0), 0),
    },
    checks_at_head: checks === null ? null : checks.map((c) => ({ name: prepare(c.name, 'check-name'), status: c.status, conclusion: c.conclusion ?? null,
      ...(c.output_summary ? { summary: prepare(c.output_summary, 'check-output') } : {}) })),
    ...(checks === null ? { checks_reason: checksReason } : {}),
    unresolved_threads: threads.filter((t) => !t.resolved).map((t) => ({ author: prepare(t.author, 'commit-author'),
      body: prepare(t.body, 'review-thread'), ...(t.path ? { path: keepPath(t.path) } : {}) })),
    behind_main: behind,
  };
}

export async function writePrFact(writer, gh, number, opts) {
  return writer.put(PR_FACT(number), await prFact(gh, number, opts));
}
