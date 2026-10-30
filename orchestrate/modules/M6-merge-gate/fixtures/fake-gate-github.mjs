// fake-gate-github.mjs — M10's in-memory repository (fake-repo.mjs) plus the GitHub REST parts the Merge Gate uses, for
// tests only: pull requests that merge (squash) and catch up, check runs, commit statuses (the robot's mark), the
// pull requests for a commit, compare with patches and the commit list, and review threads over GraphQL.
//
//   const g = fakeGateGitHub({ robotId });
//   const sha = g.commit(parents, files, { from })     same as fake-repo's, but remembers parents (for compare's commits)
//   g.main = sha
//   g.openPull({ number, head, files })   files = the change's own files (what a catch-up or the test merge lays on main)
//   g.checks.set(sha, [run, …])           default: one required check `test`, passed, on that commit
//   g.threads = [{ isResolved, comments: { nodes: [{ author: { __typename } }] } }]
//   g.answer.merge / g.answer.update = (pr, body) → { status, json } | null    to make GitHub refuse
//   g.gh.get / post / put(path, body) → { status, json };  g.writes = [[method, path, body], …]
// Shapes follow REST API version 2022-11-28 ("Merge a pull request", "Update a pull request branch", "List check runs
// for a Git reference", "Get the combined status for a specific reference", "Create a commit status"; checked
// 30 Oct 2026). A squash merge's commit has one parent, the main it landed on.

import { fakeRepo } from '../../M10-rules/fixtures/fake-repo.mjs';

export const CHECK_APP = 15368;

export function fakeGateGitHub({ owner = 'sample-org', repo = 'sample-app', robotId = 99 } = {}) {
  const r = fakeRepo({ owner, repo });
  const parents = new Map();
  const pulls = new Map();
  const statuses = new Map();
  const g = { repo: r, pulls, statuses, checks: new Map(), threads: [], writes: [], answer: {}, robotId, down: false };
  Object.defineProperty(g, 'main', { get: () => r.main, set: (v) => { r.main = v; } });

  g.commit = (ps, files, opts) => { const sha = r.commit(ps, files, opts); parents.set(sha, [...ps]); return sha; };
  const ancestors = (sha) => { const seen = new Set(); const todo = [sha]; while (todo.length) { const c = todo.pop(); if (c && !seen.has(c)) { seen.add(c); todo.push(...(parents.get(c) ?? [])); } } return seen; };

  g.openPull = ({ number, head, files = {}, draft = false, labels = [] }) => {
    const p = { number, head, files, draft, labels, state: 'open', merged: false, merge_commit_sha: null, merged_by: null, mergeable_state: 'clean' };
    pulls.set(number, p);
    r.pull({ number, merged: false, base: 'main', head, commits: [head] });
    return p;
  };
  // An open pull request's test merge: main plus the change, as GitHub computes merge_commit_sha for a mergeable PR.
  const testMerges = new Map();
  const testMerge = (p) => {
    const k = `${p.head} ${r.main}`;
    if (!testMerges.has(k)) testMerges.set(k, g.commit([r.main, p.head], p.files, { from: r.main }));
    return testMerges.get(k);
  };
  const pullJson = (p) => ({ number: p.number, state: p.state, draft: p.draft, merged: p.merged, mergeable: p.mergeable_state === 'clean', mergeable_state: p.mergeable_state,
    head: { sha: p.head }, base: { ref: 'main' }, labels: p.labels.map((name) => ({ name })), merged_by: p.merged_by,
    merge_commit_sha: p.merged ? p.merge_commit_sha : p.state === 'open' ? testMerge(p) : null });

  const ok = (json, status = 200) => ({ status, json });
  const base = `/repos/${owner}/${repo}`;
  const run = (sha) => g.checks.get(sha) ?? [{ name: 'test', app: { id: CHECK_APP }, head_sha: sha, status: 'completed', conclusion: 'success' }];
  const patchOf = (b, h, path) => {
    const old = r.files(b).get(path)?.text; const neu = r.files(h).get(path)?.text;
    return [...(old === undefined ? [] : old.split('\n').map((l) => `-${l}`)), ...(neu === undefined ? [] : neu.split('\n').map((l) => `+${l}`))].join('\n');
  };

  r.override = (path) => {
    if (!path.startsWith(`${base}/`)) return null;
    const p = path.slice(base.length);
    let m;
    if ((m = /^\/pulls\/(\d+)$/.exec(p))) { const pr = pulls.get(Number(m[1])); return pr ? ok(pullJson(pr)) : { status: 404, json: null }; }
    if ((m = /^\/commits\/([0-9a-f]{40})\/check-runs\?per_page=100$/.exec(p))) { const rs = run(m[1]); return ok({ total_count: rs.length, check_runs: rs }); }
    if ((m = /^\/commits\/([0-9a-f]{40})\/status\?per_page=100$/.exec(p))) { const ss = (statuses.get(m[1]) ?? []).filter((s) => s.context !== 'orchestrate/merge-gate'); return ok({ state: 'success', total_count: ss.length, statuses: ss }); }
    if ((m = /^\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/.exec(p))) return ok(statuses.get(m[1]) ?? []);
    if ((m = /^\/commits\/([0-9a-f]{40})\/pulls\?per_page=100$/.exec(p))) return ok([...pulls.values()].filter((x) => x.merge_commit_sha === m[1] || x.head === m[1]).map((x) => ({ number: x.number })));
    return null;
  };

  // compare: fake-repo's answer plus patches and the commit list (the override has no compare branch, so this reads
  // fake-repo's own answer; reads run concurrently, so nothing is switched off around it).
  async function compare(b, h) {
    const res = await r.gh.get(`${base}/compare/${b}...${h}`);
    if (res.status !== 200) return res;
    const mb = res.json.merge_base_commit.sha;
    const A = ancestors(b);
    const commits = [...ancestors(h)].filter((c) => !A.has(c)).map((sha) => ({ sha }));
    return ok({ ...res.json, commits, total_commits: commits.length, files: res.json.files.map((f) => ({ ...f, patch: patchOf(mb, h, f.filename) })) });
  }
  const COMPARE = new RegExp(`^${base}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`);

  g.gh = {
    async get(path) {
      if (g.down) throw new Error('network down');
      const c = COMPARE.exec(path);
      return c ? compare(c[1], c[2]) : r.gh.get(path);
    },
    async post(path, body) {
      if (g.down) throw new Error('network down');
      g.writes.push(['post', path, body]);
      if (path === '/graphql') return ok({ data: { repository: { pullRequest: { reviewThreads: { totalCount: g.threads.length, nodes: g.threads } } } } });
      const m = /^\/statuses\/([0-9a-f]{40})$/.exec(path.slice(base.length));
      if (m) { statuses.set(m[1], [...(statuses.get(m[1]) ?? []), { ...body, creator: { id: robotId } }]); return ok({ id: 1 }, 201); }
      return { status: 404, json: null };
    },
    async put(path, body) {
      if (g.down) throw new Error('network down');
      g.writes.push(['put', path, body]);
      const p = path.slice(base.length);
      let m;
      if ((m = /^\/pulls\/(\d+)\/merge$/.exec(p))) {
        const pr = pulls.get(Number(m[1]));
        const a = g.answer.merge?.(pr, body); if (a) return a;
        if (!pr || pr.state !== 'open') return { status: 405, json: { message: 'Pull Request is not mergeable' } };
        if (body.sha !== pr.head) return { status: 409, json: { message: 'Head branch was modified. Review and try the merge again.' } };
        const sha = g.commit([r.main], pr.files, { from: r.main });
        Object.assign(pr, { state: 'closed', merged: true, merge_commit_sha: sha, merged_by: { id: robotId } });
        r.main = sha;
        return ok({ sha, merged: true, message: 'Pull Request successfully merged' });
      }
      if ((m = /^\/pulls\/(\d+)\/update-branch$/.exec(p))) {
        const pr = pulls.get(Number(m[1]));
        const a = g.answer.update?.(pr, body); if (a) return a;
        if (!pr || body.expected_head_sha !== pr.head) return { status: 422, json: { message: 'expected head sha didn\'t match current head ref' } };
        pr.head = g.commit([pr.head, r.main], pr.files, { from: r.main });
        return ok({ message: 'Updating pull request branch.' }, 202);
      }
      return { status: 404, json: null };
    },
  };
  return g;
}
