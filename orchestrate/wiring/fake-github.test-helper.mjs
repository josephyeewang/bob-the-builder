// fake-github.test-helper.mjs — a stand-in for api.github.com, for the Dispatcher and robot job boot tests (R-0b-162).
//
// It answers only the two reads M10's rules reader makes on a first load (main's head, the rules file at that commit)
// and the robot job's one read of the open `idea` issues (`issues`, default none), for the one repository it is given, and refuses the rest as GitHub would: another repository path is a 404, a call
// with no token is a 401, a write is a 404 (the read-only client never sends one). Any other host throws, so a test
// can never reach the network. Every call is written to `logFile`, one line each, so a test can see the real reader ran.
//
// Two ways in: `fakeGitHubFetch(spec)` for a test that calls wire() itself, and `node --import <this file>`, which puts
// it in place of fetch for a whole process, from the JSON file named by ORCH_FAKE_GITHUB (the boot test, which runs
// main.mjs as the login job would).
//
// With `app` ({ installation, alertRepo }) it also stands in for the robot App (#465 r2 m5): the installation token
// request, GET /app, and an in-memory issues store for the alert repository (list, open, edit, comment), so a boot test
// can run robot-main as its own process with the App named, down the heartbeat and its sweep.

import { appendFileSync, readFileSync } from 'node:fs';
import { blobSha, RULES_PATH } from '../modules/M10-rules/reader.mjs';

const answer = (status, json = null) => ({ status, json: async () => json });

export function fakeGitHubFetch({ owner, repo, commit, text, issues = [], logFile = null, app = null }) {
  const buf = Buffer.from(text, 'utf8');
  const file = { type: 'file', path: RULES_PATH, sha: blobSha(buf), encoding: 'base64', content: buf.toString('base64'), size: buf.length };
  const base = `/repos/${owner}/${repo}`;
  const alerts = new Map();
  const appToken = 'ghs_'.padEnd(40, 'f');
  const alertAnswer = (method, u, init) => {
    if ((init.headers?.authorization ?? init.headers?.Authorization) !== `Bearer ${appToken}`) return answer(401, { message: 'Bad credentials' });
    const rest = u.pathname.slice(`/repos/${app.alertRepo}`.length);
    const body = init.body ? JSON.parse(init.body) : {};
    if (rest === '/issues' && method === 'GET') return answer(200, [...alerts.values()].filter((i) => i.state === 'open'));
    if (rest === '/issues' && method === 'POST') {
      const number = alerts.size + 1;
      alerts.set(number, { number, state: 'open', title: body.title, body: body.body, assignees: body.assignees, user: { login: 'robot[bot]', type: 'Bot' } });
      return answer(201, { number });
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    const i = m && alerts.get(Number(m[1]));
    if (!i) return answer(404, { message: 'Not Found' });
    if (m[2]) return method === 'POST' ? answer(201, { created_at: new Date().toISOString() }) : answer(200, []);
    if (method === 'PATCH') Object.assign(i, body);
    return answer(200, i);
  };
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== 'api.github.com' || u.protocol !== 'https:') throw new Error(`the fake GitHub refuses ${u.host}: no test reaches the network`);
    const method = init.method ?? 'GET';
    const path = `${u.pathname}${u.search}`;
    if (logFile) appendFileSync(logFile, `${method} ${path}\n`);
    const auth = init.headers?.authorization ?? init.headers?.Authorization ?? '';
    if (!/^Bearer \S{20,}$/.test(auth)) return answer(401, { message: 'Requires authentication' });
    if (app && method === 'POST' && u.pathname === `/app/installations/${app.installation}/access_tokens`) return answer(201, { token: appToken, expires_at: '2099-01-01T00:00:00Z' });
    if (app && method === 'GET' && u.pathname === '/app') return answer(200, { slug: 'robot' });
    if (app && u.pathname.startsWith(`/repos/${app.alertRepo}/`)) return alertAnswer(method, u, init);
    if (method !== 'GET') return answer(404, { message: 'Not Found' });
    if (path === `${base}/git/ref/heads/main`) return answer(200, { ref: 'refs/heads/main', object: { sha: commit, type: 'commit' } });
    if (path === `${base}/contents/${RULES_PATH}?ref=${commit}`) return answer(200, file);
    if (path === `${base}/issues?labels=idea&state=open&per_page=100`) return answer(200, issues);
    return answer(404, { message: 'Not Found' });
  };
}

export const blobOf = (text) => blobSha(Buffer.from(text, 'utf8'));

// `node --import`: the whole process gets the fake in place of fetch.
if (process.env.ORCH_FAKE_GITHUB) globalThis.fetch = fakeGitHubFetch(JSON.parse(readFileSync(process.env.ORCH_FAKE_GITHUB, 'utf8')));
