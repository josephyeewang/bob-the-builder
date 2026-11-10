// probes/github-pr.mjs — each pull request's GitHub reading for the Sensors loop (R-0b-169), in the shape pr-facts.mjs
// takes (its `gh` port): pr, files, checks, threads, behindBy. Plus the list of pull requests to read.
//
// The client is the one M6 uses: `gh = { get(path), post(path, body) } → { status, json }`, holding the robot's token
// (built by the wiring; no token, owner or repo is named here). Every call is a read: GET on /repos/<owner>/<repo>/…,
// and one POST to /graphql that only runs the review-threads QUERY (GitHub's API has no GET for it; M6's gather does
// the same). Any answer other than 200 throws, so pr-facts writes the reading as unknown with its time.
//
// CHECK RUNS NEED A GITHUB APP (L617, L627). GitHub offers no Checks permission on fine-grained tokens, only to GitHub
// Apps, so `checks` reads with `checksGh`: a client holding an App's installation token. On a product that is the
// read-only watcher App (Checks and Metadata, read), the same one the watch job uses (L627): the robot stays off a
// product until B7, so it never holds write there during the watch week. `gh` keeps everything else. Until the App
// exists `checksGh` is absent and `checks` throws, so the reading is unknown, never "no checks"; a 403 from a token that
// can't see check runs throws the same way, and the Sensors pass tells each one. Never pass the fine-grained client as
// `checksGh`, and no classic token. The same-client check below only catches the very same object: a second wrapper
// round the fine-grained client gets past it (#287 r1 m1). The wiring, which builds checksGh from the App's token, is
// the real guard, and its test must show that.
//
// Which pull requests: every open one (GitHub's list), plus every PR a merge in the record still waits on (a merging or
// refused merge needs a reading after it changed, even once GitHub shows the PR closed; M11 merges.mjs). At most
// MAX_PRS per pass, newest merge first, then the open list; the rest are named in the pass's problems.

export const MAX_PRS = 30;
const PER_PAGE = 100;
// Merges whose PR the Dispatcher no longer reads: done, or handed back to the builder.
const DONE_MERGES = Object.freeze(['merged', 'audited_ok', 'audit_flagged', 'returned_to_builder']);
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

export const threadsQuery = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100) {
    totalCount nodes { isResolved path comments(first: 1) { nodes { author { login } body } } } } } } }`;

const okJson = (r, what) => {
  if (r?.status !== 200 || r.json === null || r.json === undefined) throw new Error(`${what} answered ${r?.status}`);
  return r.json;
};

/** The pr-facts port for one pass, over M6's client (and an App's for check runs, L627). pr(n) is read once per pass (behindBy needs its base and head). */
export function prReader({ gh, checksGh, owner, repo }) {
  if (!gh || typeof gh.get !== 'function') throw new Error('the PR reader needs a GitHub client with get()');
  if (checksGh !== undefined && checksGh !== null && typeof checksGh.get !== 'function') throw new Error('the check-runs client has no get()');
  if (checksGh && checksGh === gh) throw new Error('check runs are read with an App\'s client, not the one for the rest (L617, L627)');
  if (!NAME.test(String(owner)) || !NAME.test(String(repo))) throw new Error('the PR reader needs the owner and repo names');
  const base = `/repos/${owner}/${repo}`;
  const prs = new Map();
  const pr = (n) => {
    if (!Number.isInteger(n) || n <= 0) return Promise.reject(new Error('a pull request number is a whole number'));
    if (!prs.has(n)) {
      prs.set(n, gh.get(`${base}/pulls/${n}`).then((r) => {
        const j = okJson(r, `pull ${n}`);
        return { number: j.number, title: j.title, head_sha: j.head?.sha ?? null, base_ref: j.base?.ref ?? null, head_ref: j.head?.ref ?? null,
          author: j.user?.login ?? null, state: j.state, merged: j.merged, merge_commit_sha: j.merge_commit_sha ?? null };
      }));
    }
    return prs.get(n);
  };
  return Object.freeze({
    pr,
    async files(n) {
      const j = okJson(await gh.get(`${base}/pulls/${n}/files?per_page=${PER_PAGE}`), `pull ${n} files`);
      if (!Array.isArray(j)) throw new Error('the file list is not a list');
      return j.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
        ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}) }));
    },
    async checks(sha) {
      if (!checksGh) throw new Error('check runs are not known: they need an App\'s client (the watcher App, L627), which is not set up (L617)');
      if (!SHA.test(String(sha))) throw new Error('no head commit to read the checks of');
      const j = okJson(await checksGh.get(`${base}/commits/${sha}/check-runs?per_page=${PER_PAGE}`), 'check runs');
      if (!Array.isArray(j.check_runs)) throw new Error('the check list is not a list');
      return j.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null,
        ...(c.output?.summary ? { output_summary: c.output.summary } : {}) }));
    },
    async threads(n) {
      if (typeof gh.post !== 'function') throw new Error('the GitHub client cannot run the review-threads query');
      const r = await gh.post('/graphql', { query: threadsQuery, variables: { owner, repo, pr: n } });
      const t = r?.json?.data?.repository?.pullRequest?.reviewThreads;
      if (r?.status !== 200 || r.json?.errors || !t || !Array.isArray(t.nodes)) throw new Error('the review threads could not be read');
      if (t.totalCount !== t.nodes.length) throw new Error('more review threads than one read returns');
      return t.nodes.map((x) => ({ resolved: x?.isResolved === true, author: x?.comments?.nodes?.[0]?.author?.login ?? null,
        body: x?.comments?.nodes?.[0]?.body ?? '', ...(x?.path ? { path: x.path } : {}) }));
    },
    async behindBy(n) {
      const p = await pr(n);
      if (!SHA.test(String(p.head_sha)) || typeof p.base_ref !== 'string') throw new Error('no base or head to compare');
      const j = okJson(await gh.get(`${base}/compare/${encodeURIComponent(p.base_ref)}...${p.head_sha}`), 'compare');
      if (!Number.isInteger(j.behind_by)) throw new Error('no behind count');
      return j.behind_by;
    },
  });
}

/** The pull requests to read this pass. → { numbers, dropped }. A failed open-list read leaves just the record's. */
export async function prsToRead({ gh, owner, repo, rec, max = MAX_PRS }) {
  const fromRecord = rec.list('merge')
    .filter((m) => Number.isInteger(m.doc?.pr) && !DONE_MERGES.includes(m.doc?.state))
    .map((m) => ({ pr: m.doc.pr, ts: Date.parse(rec.meta?.('merge', m.id)?.ts ?? '') || 0 }))
    .sort((a, b) => b.ts - a.ts).map((m) => m.pr);
  let open = []; let problem = null;
  try {
    const j = okJson(await gh.get(`/repos/${owner}/${repo}/pulls?state=open&per_page=${PER_PAGE}`), 'the open pull request list');
    if (!Array.isArray(j)) throw new Error('the open list is not a list');
    open = j.map((p) => p?.number).filter((n) => Number.isInteger(n) && n > 0);
  } catch (e) { problem = `pr: the open pull request list could not be read (${String(e?.message ?? e).slice(0, 80)})`; }
  const all = [...new Set([...fromRecord, ...open])];
  return { numbers: all.slice(0, max), dropped: all.slice(max), problem };
}
