// checker-fake.mjs — small fake GitHub clients for the audit-run, build-skip and checker tests. Tests only.
//
//   const gh = routeGh({ '/repos/o/r/x': json | { status, json } | (() => …) });   // anything else → 404
//   gh.down = true → every get throws (a network error)
//   withRoutes(fakeRepo(...)) → a routes map consulted before M10's fake repo answers
//   markRoutes({ owner, repo, sha, head, pr, card, robotBotId, mergedBy }) → the routes mark.mjs reads for a marked merge

import { MARK_CONTEXT, markDescription } from '../mark.mjs';

const wrap = (v) => (v && typeof v === 'object' && 'status' in v && Object.keys(v).every((k) => k === 'status' || k === 'json') ? v : { status: 200, json: v });

export function routeGh(routes = {}) {
  const gh = {
    routes, calls: [], down: false,
    async get(path) {
      gh.calls.push(path);
      if (gh.down) throw new Error('network down');
      if (!Object.hasOwn(gh.routes, path)) return { status: 404 };
      const v = gh.routes[path];
      return wrap(typeof v === 'function' ? v() : v);
    },
  };
  return gh;
}

export function withRoutes(repo) {
  const routes = {};
  repo.override = (path) => (Object.hasOwn(routes, path) ? wrap(typeof routes[path] === 'function' ? routes[path]() : routes[path]) : null);
  return routes;
}

export function markRoutes({ owner = 'sample-org', repo = 'sample-app', sha, head, pr = 7, card = 'card-1', robotBotId = 4242,
  mergedBy = robotBotId, statuses = [], body = '', labels = [] }) {
  const base = `/repos/${owner}/${repo}`;
  return {
    [`${base}/commits/${sha}/statuses?per_page=100`]: [
      { context: MARK_CONTEXT, state: 'success', creator: { id: robotBotId, type: 'Bot' }, description: markDescription({ card, head }) },
      ...statuses],
    [`${base}/commits/${sha}/pulls?per_page=100`]: [{ number: pr }],
    [`${base}/pulls/${pr}`]: { number: pr, merged: true, merge_commit_sha: sha, merged_by: { id: mergedBy }, head: { sha: head },
      base: { ref: 'main' }, body, labels: labels.map((name) => ({ name })) },
  };
}
