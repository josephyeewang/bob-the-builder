// narrowed-mint.mjs — one real narrowed mint for the test product, checked before the push pass goes live (lane N, N4;
// LEAD-CALLS L1145, L1199; robot-push.mjs "BEFORE IT GOES LIVE", #536 r2 Minor 1). Run on the always-on Mac as the
// robot job's own Mac user (the Record's owner; token.mjs mints for no one else, and never as root):
//
//   node narrowed-mint.mjs <the copy's robot.json, full path> [--other-repo <name>] [--result <file>]
//
// It mints the push's token the way the push does (robot-wiring.mjs pushTokenFor, with robot-push.mjs PUSH_SCOPE of the
// product's repository, through token.mjs and its own checks), then shows, one step each:
//   1 the mint: GitHub gave the token, and token.mjs's own check of GitHub's answer passed;
//   2 one repository: GitHub's answer names the product's repository only, chosen ('selected'), and the token itself
//     lists exactly that one (GET /installation/repositories);
//   3 the permissions: GitHub's answer is exactly what the push asks for (PUSH_SCOPE) plus GitHub's own metadata read,
//     and a read the installation may make but the push may not (the repository's issues; L626: issues write) is
//     refused;
//   4 another repository: a second repository the App is installed on (--other-repo, a name under the same owner) is
//     refused to the push's token. That the App reaches it is shown by a second mint, narrowed to it and to metadata
//     read only, which is revoked too. Not named, or the App not on it: NOT RUN (L626: the App was installed on the
//     test repository only), never a pass;
//   5 nothing kept: no line printed or written holds either token (both stay in this process's memory);
//   6 revoked: each token is revoked (DELETE /installation/token, 204), and the push's token is then refused (401).
//     Revoking runs whatever happened before it.
// It makes no write on GitHub but the mints and the revokes, and writes nothing but its result file, made new, 0600,
// only when --result is given (slice-dry-run.mjs writeNew). The product must be the test product (runlocked.mjs
// TEST_REPO). RESULT: PASS only when all six PASS; exit 0 then, 1 otherwise, 2 when it could not run.
// Capability note (Principle 9): GitHub's token answer (permissions, repository_selection, repositories), the 403/404 of
// a refused read and the 401 after a revoke are GitHub's API as documented (REST 2022-11-28); this proof is what checks
// them, and its result holds for GitHub's answer on the day it ran.

import { realpathSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appProblem, pushTokenFor } from '../../wiring/robot-wiring.mjs';
import { PUSH_SCOPE } from '../../wiring/robot-push.mjs';
import { readProducts } from '../../modules/M10-rules/reader.mjs';
import { TEST_REPO } from './runlocked.mjs';
import { writeNew } from './slice-dry-run.mjs';

export const STEPS = Object.freeze([
  [1, 'the mint: GitHub gave the push\'s narrowed token, and token.mjs\'s check of its answer passed'],
  [2, 'one repository: the token reaches the product\'s repository and no other'],
  [3, 'the permissions: exactly what the push asks for, and a read outside them is refused'],
  [4, 'another repository the App is installed on is refused'],
  [5, 'nothing kept: no line printed or written holds a token'],
  [6, 'revoked: each token is revoked, and the push\'s token is then refused'],
]);
// GitHub adds metadata read to every installation token unasked (token.mjs GITHUB_GRANTS); nothing else is expected.
export const expectedPermissions = (repo) => ({ ...PUSH_SCOPE(repo).permissions, metadata: 'read' });
// The second mint, only to show the App reaches the other repository: the least GitHub mints.
const PROBE_PERMISSIONS = Object.freeze({ metadata: 'read' });
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const TIMEOUT_MS = 15_000;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sameKeys = (a, b) => {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/**
 * fetchFn, seeing GitHub's answer to the token request: its permissions, repository_selection and repository names,
 * never the token. → { fetchFn, seen: () => answer | null }
 */
export function watchMint(fetchFn) {
  let seen = null;
  return {
    seen: () => seen,
    fetchFn: async (url, init) => {
      const res = await fetchFn(url, init);
      if (init?.method === 'POST' && /\/access_tokens$/.test(String(url))) {
        try {
          const j = await res.clone().json();
          seen = { permissions: j?.permissions ?? null, repository_selection: j?.repository_selection ?? null,
            repositories: Array.isArray(j?.repositories) ? j.repositories.map((r) => (typeof r?.name === 'string' ? r.name : null)) : null };
        } catch { seen = null; }
      }
      return res;
    },
  };
}

/** One call with a token to GitHub's fixed host → { status, json } ; status null when it failed (no throw). */
export function tokenClient({ fetchFn }) {
  return async (token, method, path) => {
    try {
      const res = await fetchFn(`https://api.github.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      let json = null;
      try { json = await res.json(); } catch { /* 204, or not JSON */ }
      return { status: res.status, json };
    } catch (e) { return { status: null, json: null, why: String(e?.name ?? 'error') }; }
  };
}

const said = (r) => (r.status === null ? `no answer (${r.why})` : `GitHub answered ${r.status}`);

/**
 * The whole proof → { lines, pass }. Ports for tests: read (robot.json), products (products.json), fetchFn, uid, now.
 * Throws only when it can't start (config, product); from the first mint on, every step gets a line.
 */
export async function proof({ config, otherRepo, read = readJson, products = readProducts, fetchFn = globalThis.fetch, uid = process.getuid?.(), now = Date.now }) {
  const c = read(config);
  const bad = appProblem(c, { none: 'the config names no robot App (appId, appInstallation, alertRepo, alertOwner)' });
  if (bad) throw new Error(`${config}: ${bad}`);
  if (typeof c.product !== 'string' || !c.product) throw new Error(`${config} names no product`);
  const entry = products(c.productsFile).find((x) => x.product === c.product);
  if (!entry) throw new Error(`products.json has no ${c.product}`);
  if (entry.repo !== TEST_REPO) throw new Error(`${c.product}'s repository is ${entry.owner}/${entry.repo}, not the test repository (${TEST_REPO}): the mint is proved on the test product alone`);
  if (otherRepo !== undefined && (!NAME.test(otherRepo) || otherRepo === '.' || otherRepo === '..' || otherRepo === entry.repo)) throw new Error(`--other-repo must be another repository's name under ${entry.owner}, without the owner`);
  const full = `${entry.owner}/${entry.repo}`;
  const call = tokenClient({ fetchFn });
  const results = new Map();
  const put = (n, result, what, extra = []) => results.set(n, { result, what, extra });

  // 1 — the mint, the push's own way.
  const pushWatch = watchMint(fetchFn);
  const m = await pushTokenFor(c, { fetchFn: pushWatch.fetchFn, uid, now })(PUSH_SCOPE(entry.repo))();
  const token = m?.ok === true && typeof m.token === 'string' ? m.token : null;
  const tokens = token ? [token] : [];
  const answer = pushWatch.seen();
  if (token) put(1, 'PASS', `minted for ${full}${m.expires_at ? `, until ${m.expires_at}` : ''}`);
  // A token GitHub gave but token.mjs refused is never handed back, so it can't be revoked here: it lasts its hour.
  else put(1, 'FAIL', `no token: ${m?.reason ?? 'no answer'}${answer ? ' (GitHub did answer: a token it gave is not used, and ends within the hour)' : ''}`);

  let other = null;
  try {
    if (token) {
      // 2 — one repository.
      const listed = await call(token, 'GET', '/installation/repositories?per_page=100');
      const names = Array.isArray(listed.json?.repositories) ? listed.json.repositories.map((r) => r?.full_name) : null;
      const inAnswer = answer?.repository_selection === 'selected' && Array.isArray(answer.repositories) && answer.repositories.length === 1 && answer.repositories[0] === entry.repo;
      const inToken = listed.status === 200 && listed.json?.total_count === 1 && names?.length === 1 && names[0] === full;
      const found = [`GitHub's answer: repository_selection ${JSON.stringify(answer?.repository_selection ?? null)}, repositories ${JSON.stringify(answer?.repositories ?? null)}`,
        `the token lists: ${listed.status === 200 ? JSON.stringify(names) : said(listed)}`];
      put(2, inAnswer && inToken ? 'PASS' : 'FAIL', inAnswer && inToken ? `${full} only` : `not exactly ${full}`, found);

      // 3 — the permissions.
      const want = expectedPermissions(entry.repo);
      const exact = sameKeys(answer?.permissions, want);
      const issues = await call(token, 'GET', `/repos/${full}/issues?per_page=1`);
      const refused = issues.status === 403 || issues.status === 404;
      put(3, exact && refused ? 'PASS' : 'FAIL', exact ? (refused ? 'exactly the push\'s' : 'the answer is exact, but a read outside it was not refused') : `GitHub's answer is not exactly ${JSON.stringify(want)}`,
        [`GitHub's answer: ${JSON.stringify(answer?.permissions ?? null)}`, `reading ${full}'s issues (not the push's to read): ${said(issues)}${refused ? ', refused' : ''}`]);

      // 4 — another repository.
      if (otherRepo === undefined) put(4, 'NOT RUN', `no --other-repo named: name a private repository under ${entry.owner} the App is installed on (L626: it was on ${entry.repo} only)`);
      else {
        const probeWatch = watchMint(fetchFn);
        const p = await pushTokenFor(c, { fetchFn: probeWatch.fetchFn, uid, now })({ repositories: [otherRepo], permissions: { ...PROBE_PERMISSIONS } })();
        if (p?.ok === true && typeof p.token === 'string') { other = p.token; tokens.push(other); }
        if (!other) put(4, 'NOT RUN', `the App could not be shown on ${entry.owner}/${otherRepo} (${p?.reason ?? 'no answer'}): install it there, or name one it is on`);
        else {
          const r = await call(token, 'GET', `/repos/${entry.owner}/${otherRepo}`);
          const no = r.status === 403 || r.status === 404;
          put(4, no ? 'PASS' : 'FAIL', no ? `${entry.owner}/${otherRepo} is refused to the push's token` : `${entry.owner}/${otherRepo} was not refused${r.status === 200 ? ' (a public repository is open to any token: name a private one)' : ''}`,
            [`the App is on ${entry.owner}/${otherRepo} (a metadata-read token was minted for it)`, `reading it with the push's token: ${said(r)}`]);
        }
      }
    } else for (const n of [2, 3, 4]) put(n, 'NOT RUN', 'no token was minted (step 1)');
  } finally {
    // 6 — revoked, whatever happened above.
    if (!token) put(6, 'NOT RUN', 'no token was minted (step 1)');
    else {
      const gone = await call(token, 'DELETE', '/installation/token');
      const goneOther = other ? await call(other, 'DELETE', '/installation/token') : null;
      const after = await call(token, 'GET', '/installation/repositories?per_page=1');
      const ok = gone.status === 204 && after.status === 401 && (goneOther === null || goneOther.status === 204);
      put(6, ok ? 'PASS' : 'FAIL', ok ? 'revoked, and refused after' : 'not shown revoked: it lasts until its hour is up; revoke it on GitHub (the App\'s page) if this repeats',
        [`revoking the push's token: ${said(gone)}`, ...(goneOther ? [`revoking the second token: ${said(goneOther)}`] : []), `the push's token after: ${said(after)}`]);
    }
  }

  // 5 — nothing kept: built last, over every other line, which is also all the result file holds.
  const body = [];
  for (const [n, title] of STEPS) {
    if (n === 5) continue;
    const s = results.get(n);
    body.push(`step ${n} ${title}`, `  ${s.result}  ${s.what}`, ...s.extra.map((x) => `    ${x}`));
  }
  const leak = tokens.some((t) => body.some((l) => l.includes(t)));
  const clean = body.map((l) => tokens.reduce((s, t) => s.split(t).join('[hidden]'), l));
  put(5, tokens.length ? (leak ? 'FAIL' : 'PASS') : 'NOT RUN', tokens.length ? (leak ? 'a line held a token; it was hidden before printing' : `${tokens.length} token(s), held in memory only, in no line`) : 'no token was minted (step 1)');
  const s5 = results.get(5);
  const at = clean.findIndex((l) => l.startsWith('step 6 '));
  clean.splice(at, 0, `step 5 ${STEPS[4][1]}`, `  ${s5.result}  ${s5.what}`);
  const passed = STEPS.filter(([n]) => results.get(n).result === 'PASS').length;
  const pass = passed === STEPS.length;
  clean.push(`RESULT: ${pass ? 'PASS' : 'FAIL'} (${passed}/${STEPS.length} steps PASS)`);
  return { lines: clean, pass };
}

export function parseArgs(argv) {
  const [config, ...rest] = argv;
  const o = { config };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]; const v = rest[i + 1];
    if (!['--other-repo', '--result'].includes(k) || v === undefined) throw new Error(`unknown or empty argument ${k}`);
    o[{ '--other-repo': 'otherRepo', '--result': 'result' }[k]] = v;
  }
  if (!config?.startsWith('/')) throw new Error('usage: node narrowed-mint.mjs <the copy\'s robot.json, full path> [--other-repo <name>] [--result <file>]');
  return o;
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), write = writeNew, ...ports } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { err(e.message); return 2; }
  let r; try { r = await proof({ ...o, ...ports }); } catch (e) { err(`stopped: ${String(e?.message ?? e).slice(0, 300)}`); return 2; }
  for (const l of r.lines) out(l);
  if (o.result) {
    try { write(o.result, `${new Date().toISOString()}\n${r.lines.join('\n')}\n`); } catch (e) { err(`stopped: the result file ${o.result} can't be made new (${e.code ?? e.message}): the proof never writes over a file, so name a new one`); return 2; }
  }
  return r.pass ? 0 : 1;
}

// argv[1] resolved first: run through a link it is the link's path, not this file's (the #261 class).
function startedAsScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedAsScript()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
