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
// clock after every GitHub read has returned, never before; merged is true only for a literal true, and
// merge_commit_sha is null unless merged (GitHub fills it with a test-merge commit on open PRs).
//   files(number)    → [{ filename, status, additions, deletions, previous_filename? }]
//   checks(sha)      → [{ name, status, conclusion, output_summary? }]
//   threads(number)  → [{ resolved, author, body, path? }]
//   behindBy(number) → integer commits behind base

import { makePrepare } from './escape.mjs';
import { validPath } from './history.mjs';
import { PR_FACT } from '../M11-dispatcher/merges.mjs';

// Paths go through as plain strings when valid (review-0b-7 Minor 4); an invalid one is replaced by a marker.
const keepPath = (x) => (validPath(x) ? x : '[path refused: control characters]');

export async function prFact(gh, number, { prepare = makePrepare(), now = () => new Date() } = {}) {
  const [pr, files, threads, behind] = await Promise.all([gh.pr(number), gh.files(number), gh.threads(number), gh.behindBy(number)]);
  const checks = await gh.checks(pr.head_sha);
  const observed_at = now().toISOString();
  const merged = pr.merged === true;
  const changed = files.map((f) => ({
    path: keepPath(f.filename),
    ...(f.previous_filename ? { from: keepPath(f.previous_filename) } : {}),
    status: f.status, added: f.additions, removed: f.deletions,
  }));
  return {
    kind: 'fact.pr',
    number: pr.number,
    title: prepare(pr.title, 'pr-title'),
    author: prepare(pr.author, 'commit-author'),
    head_sha: pr.head_sha,
    state: pr.state ?? null,
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
    checks_at_head: checks.map((c) => ({ name: prepare(c.name, 'check-name'), status: c.status, conclusion: c.conclusion ?? null,
      ...(c.output_summary ? { summary: prepare(c.output_summary, 'check-output') } : {}) })),
    unresolved_threads: threads.filter((t) => !t.resolved).map((t) => ({ author: prepare(t.author, 'commit-author'),
      body: prepare(t.body, 'review-thread'), ...(t.path ? { path: keepPath(t.path) } : {}) })),
    behind_main: behind,
  };
}

export async function writePrFact(writer, gh, number, opts) {
  return writer.put(PR_FACT(number), await prFact(gh, number, opts));
}
