// fake-github.mjs — M10's in-memory repository (fake-repo.mjs) plus the parts of GitHub's REST API M2 uses, for tests
// only: pull requests with reviews and a timeline, a user looked up by id, review requests, and the robot's writes for
// a decision pull request (a branch, one file, the pull request, closing it).
//
//   const g = fakeGitHub({ ownerId, ownerLogin });
//   g.repo                      the fake repository (commit, main, …)
//   g.openPull({ number, head, title?, body? })
//   g.review(number, { id?, user?, state, commit_id, submitted_at, body?, app? })   user defaults to the owner
//   g.gh.get / post / put / patch(path, body) → { status, json }
// Shapes follow REST API version 2022-11-28 (docs.github.com "List reviews for a pull request", "List timeline events
// for an issue", "Request reviewers for a pull request"; checked 30 Oct 2026).

import { fakeRepo } from '../../M10-rules/fixtures/fake-repo.mjs';

export function fakeGitHub({ owner = 'sample-org', repo = 'sample-app', ownerId = 4242, ownerLogin = 'the-owner', robotId = 99, now = () => Date.parse('2026-10-01T12:00:00Z') } = {}) {
  const r = fakeRepo({ owner, repo });
  const pulls = new Map();
  const users = new Map([[ownerId, { id: ownerId, login: ownerLogin, type: 'User' }], [robotId, { id: robotId, login: 'the-robot', type: 'User' }]]);
  const branches = new Map();
  let reviewNo = 100;
  const g = { repo: r, pulls, branches, writes: [], down: false, ownerId, robotId };
  const iso = (ms) => new Date(ms).toISOString();

  g.openPull = ({ number, head, title = 'A change', body = '', base = 'main', user = robotId }) => {
    const p = { number, head, title, body, base, state: 'open', merged: false, user: users.get(user), reviews: [], timeline: [] };
    pulls.set(number, p);
    r.pull({ number, merged: false, base, head, commits: [head] });
    return p;
  };
  g.review = (number, { id = ++reviewNo, user = ownerId, state, commit_id, submitted_at, body = '', app = null, type } = {}) => {
    const u = typeof user === 'object' ? user : { ...(users.get(user) ?? { id: user, login: `user-${user}`, type: 'User' }) };
    if (type) u.type = type;
    const rv = { id, user: u, state, commit_id, submitted_at: typeof submitted_at === 'number' ? iso(submitted_at) : submitted_at, body, performed_via_github_app: app };
    pulls.get(number).reviews.push(rv);
    return rv;
  };

  const base = `/repos/${owner}/${repo}`;
  const ok = (json, status = 200) => ({ status, json });
  const pullJson = (p) => ({ number: p.number, state: p.state, merged: p.merged, title: p.title, body: p.body, user: p.user,
    head: { sha: p.head, ref: p.ref ?? `branch-${p.number}` }, base: { ref: p.base } });

  g.gh = {
    async get(path) {
      if (g.down) throw new Error('network down');
      let m;
      if ((m = /^\/user\/(\d+)$/.exec(path))) { const u = users.get(Number(m[1])); return u ? ok(u) : { status: 404, json: null }; }
      if (!path.startsWith(`${base}/`)) return { status: 404, json: null };
      const p = path.slice(base.length);
      if ((m = /^\/pulls\/(\d+)$/.exec(p))) { const pr = pulls.get(Number(m[1])); return pr ? ok(pullJson(pr)) : { status: 404, json: null }; }
      if ((m = /^\/pulls\/(\d+)\/reviews\?per_page=100&page=(\d+)$/.exec(p))) {
        const pr = pulls.get(Number(m[1])); if (!pr) return { status: 404, json: null };
        const page = Number(m[2]);
        return ok(pr.reviews.slice((page - 1) * 100, page * 100));
      }
      if ((m = /^\/issues\/(\d+)\/timeline\?per_page=100&page=(\d+)$/.exec(p))) {
        const pr = pulls.get(Number(m[1])); if (!pr) return { status: 404, json: null };
        const page = Number(m[2]);
        return ok(pr.timeline.slice((page - 1) * 100, page * 100));
      }
      return r.gh.get(path);
    },
    async post(path, body) {
      if (g.down) throw new Error('network down');
      g.writes.push(['post', path, body]);
      let m;
      const p = path.slice(base.length);
      if ((m = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(p))) {
        const pr = pulls.get(Number(m[1])); if (!pr) return { status: 404, json: null };
        for (const login of body.reviewers ?? []) {
          const u = [...users.values()].find((x) => x.login === login);
          if (!u) return { status: 422, json: null };
          pr.timeline.push({ event: 'review_requested', created_at: iso(now()), requested_reviewer: u, review_requester: users.get(robotId) });
        }
        return ok(pullJson(pr), 201);
      }
      if (p === '/git/refs') {
        const name = String(body.ref).replace(/^refs\/heads\//, '');
        if (branches.has(name)) return { status: 422, json: null };
        branches.set(name, body.sha);
        return ok({ ref: body.ref, object: { sha: body.sha } }, 201);
      }
      if (p === '/pulls') {
        const head = branches.get(body.head);
        if (!head) return { status: 422, json: null };
        const number = Math.max(0, ...pulls.keys()) + 1;
        const pr = g.openPull({ number, head, title: body.title, body: body.body ?? '', base: body.base });
        pr.ref = body.head;
        return ok(pullJson(pr), 201);
      }
      return { status: 404, json: null };
    },
    async put(path, body) {
      if (g.down) throw new Error('network down');
      g.writes.push(['put', path, body]);
      const p = path.slice(base.length);
      const m = /^\/contents\/(.+)$/.exec(p);
      if (!m || !branches.has(body.branch)) return { status: 404, json: null };
      const parent = branches.get(body.branch);
      const sha = r.commit([parent], { [decodeURIComponent(m[1])]: Buffer.from(body.content, 'base64').toString('utf8') });
      branches.set(body.branch, sha);
      return ok({ commit: { sha } }, 201);
    },
    async patch(path, body) {
      if (g.down) throw new Error('network down');
      g.writes.push(['patch', path, body]);
      const m = /^\/pulls\/(\d+)$/.exec(path.slice(base.length));
      const pr = m && pulls.get(Number(m[1]));
      if (!pr) return { status: 404, json: null };
      if (body.state) pr.state = body.state;
      return ok(pullJson(pr));
    },
  };
  return g;
}
