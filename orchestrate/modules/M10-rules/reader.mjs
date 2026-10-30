// reader.mjs — fetch each product's rules from its GitHub main branch, and decide whether to trust them.
//
// WHY. The rules decide what the robot may do, so the rules themselves must come from one fixed place and only
// change when Joe approved the change. GitHub's free plan won't protect a private main branch, so anyone (or any
// robot) with write access could push a looser rules file. This reader is what stops that from taking effect:
//
//   - FIXED ADDRESS (MAT-4). Host api.github.com, branch `main`, path `orchestrate/policy.yaml` are fixed here; the
//     product list (products.json) gives only owner and repo. No local git, no shelling out: a local copy can't steer it.
//   - APPROVED ONLY (MAT-1, round-2 R2-M1). A new version is adopted only if (a) `main` moved forward from the last
//     good commit (a force push back to an older, looser file is refused: `main_rewound`), and (b) `verifyApproved`
//     says Joe approved it. Joe's GitHub id comes from the LAST GOOD rules (or products.json on a first load), never
//     from the file being checked. Until 0b-5 lands, the approval check is the stopgap allow-list `approved-rules.json`
//     (blob shas Joe pinned after seeing the diff); a missing allow-list means "not approved".
//   - THREE WAYS TO FAIL (MAT-3). The file or branch is gone (404) → deny everything at once. GitHub can't be reached
//     → keep the last good version for at most 300 s, then deny. Corrupt or unapproved → keep the last good version
//     and alert. With no last good version, every failure means deny everything.
//
// Until the second cutover on a product whose post-merge audit isn't installed, this check is the only thing that
// stops a direct push to the rules (round-2 R2-M1(e)).
//
//   const reader = makeReader({ gh, stateDir, products, verifyApproved?, alert, now? });
//   await reader.refresh();                   // one pass over every product
//   reader.state(product) → { status: 'ok'|'last_good'|'deny_all', policy|null, rev|null, commit, blob, reason }

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsePolicy } from './policy.mjs';
import { makeGitView } from './git-view.mjs';

export const RULES_PATH = 'orchestrate/policy.yaml';
export const BRANCH = 'main';
export const FETCH_GRACE_MS = 300_000;
export const MAX_BYTES = 1_000_000;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;

// Git's own id for a file's contents, so we can prove the text we decoded is the blob GitHub named.
export function blobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// products.json: [{ product, owner, repo, joe_github_id }]. Anything malformed → throw (the caller denies all).
export function readProducts(file) {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error('products.json must be a list');
  const seen = new Set();
  for (const p of list) {
    if (!p || !NAME.test(p.product ?? '') || !NAME.test(p.owner ?? '') || !NAME.test(p.repo ?? '')) throw new Error('products.json entry needs product, owner, repo');
    if (!Number.isSafeInteger(p.joe_github_id) || p.joe_github_id <= 0) throw new Error(`products.json ${p.product}: joe_github_id must be a number`);
    if (seen.has(p.product)) throw new Error(`products.json lists ${p.product} twice`);
    seen.add(p.product);
  }
  return list.map((p) => Object.freeze({ product: p.product, owner: p.owner, repo: p.repo, joe_github_id: p.joe_github_id }));
}

// The stopgap approval check until 0b-5: approved-rules.json = { "<product>": ["<blob sha>", ...] }, oldest first, written
// by Joe's runbook step (a new version is appended). Missing or unreadable → nothing is approved.
export function allowListVerifier(file) {
  return ({ product, blob, lastGoodBlob = null }) => {
    let list;
    try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
    if (!Array.isArray(list?.[product])) return false;
    const at = list[product].lastIndexOf(blob);
    if (at < 0) return false;
    if (lastGoodBlob === null) return true;
    // Forward only: a version is approved only if it was pinned after the current one, so an older pinned version
    // can't be brought back by a direct push. A current version missing from the list approves nothing.
    const cur = list[product].lastIndexOf(lastGoodBlob);
    return cur >= 0 && at > cur;
  };
}

// The lookup half of "Joe approved this rules version" (0b-1 R3-M2). A version is a candidate only through the pull
// request that put it on main: start from the newest commit on main that changed the file, ask GitHub which pull
// requests carry that commit, re-read each, and accept only when all three hold:
//   - exactly one of them was merged into main;
//   - its merge commit is on main's history (so it really landed, and wasn't rewritten away);
//   - the file at the pull request's final head is byte-for-byte the version on main (what was reviewed is what runs).
// Squash, merge-commit and rebase merges all pass; a direct push of a copied change, or a merge whose result differs
// from the reviewed head, does not. Judging Joe's Approve on that pull request is 0b-5's part (`judge`).
export async function findApprovingPull({ gh, owner, repo, commit, blob, after = null, path = RULES_PATH }) {
  try {
    if (!SHA.test(commit ?? '') || !SHA.test(blob ?? '')) return { ok: false, reason: 'no commit or version to look up' };
    const base = `/repos/${owner}/${repo}`;
    const read = async (q) => { const r = await gh.get(`${base}${q}`); if (r?.status !== 200) throw new Error(`GitHub answered ${r?.status} for ${q}`); return r.json; };
    const list = await read(`/commits?sha=${commit}&path=${encodeURIComponent(path)}&per_page=1`);
    if (!Array.isArray(list) || !list.length || !SHA.test(list[0]?.sha ?? '')) return { ok: false, reason: 'no commit on main changed the rules file' };
    const changed = list[0].sha;
    const pulls = await read(`/commits/${changed}/pulls`);
    if (!Array.isArray(pulls)) throw new Error('odd pull request list');
    const merged = [];
    for (const n of new Set(pulls.map((x) => x?.number))) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('odd pull request number');
      const pr = await read(`/pulls/${n}`);                  // re-read: the list's own fields are not trusted
      if (pr?.number === n && pr.merged === true && pr.base?.ref === BRANCH) merged.push(pr);
    }
    if (merged.length !== 1) return { ok: false, reason: `${merged.length} merged pull requests into main carry commit ${changed.slice(0, 7)}` };
    const pr = merged[0];
    if (!SHA.test(pr.merge_commit_sha ?? '') || !SHA.test(pr.head?.sha ?? '')) return { ok: false, reason: `pull request #${pr.number} has no merge commit or head` };
    const view = makeGitView({ gh, owner, repo });
    if (!(await view.onHistory(pr.merge_commit_sha, commit))) return { ok: false, reason: `pull request #${pr.number}'s merge commit is not on main` };
    // It must have landed after the last good version, so an older approved pull request can't be replayed by a direct
    // push that brings its version back (git's history then leads to the old pull request).
    if (after !== null) {
      if (!SHA.test(after)) return { ok: false, reason: 'odd last good commit' };
      const c = await view.compare(after, pr.merge_commit_sha);
      if (c.status !== 'ahead' || c.mergeBase !== after) return { ok: false, reason: `pull request #${pr.number} landed before the last good rules` };
    }
    const atHead = await gh.get(`${base}/contents/${path}?ref=${pr.head.sha}`);
    if (atHead?.status !== 200 || atHead.json?.sha !== blob) return { ok: false, reason: `the rules file at pull request #${pr.number}'s head is not the version on main` };
    return { ok: true, pr: pr.number, head: pr.head.sha, merge_commit: pr.merge_commit_sha };
  } catch (e) {
    return { ok: false, reason: `could not look up the pull request: ${e.message}` };
  }
}

// The approval check once 0b-5 lands: the lookup above, then 0b-5's judgement of Joe's Approve on that pull request.
export function pullRequestVerifier({ judge }) {
  return async (q) => {
    const found = await findApprovingPull({ gh: q.gh, owner: q.owner, repo: q.repo, commit: q.commit, blob: q.blob, after: q.lastGood ?? null });
    if (!found.ok) return found;
    return (await judge({ ...q, pr: found.pr, head: found.head })) === true ? true : { ok: false, reason: `pull request #${found.pr} has no Approve from Joe` };
  };
}

export function makeReader({ gh, stateDir, products, verifyApproved, alert, now = () => Date.now() }) {
  if (!gh || typeof gh.get !== 'function') throw new Error('reader needs a GitHub client with get()');
  const verify = verifyApproved ?? allowListVerifier(join(stateDir, 'approved-rules.json'));
  const states = new Map();
  const sent = new Set();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const say = (product, reason, blob, detail) => {
    const key = `${product}\0${reason}\0${blob ?? ''}`;
    if (sent.has(key)) return;
    sent.add(key);
    try { alert({ product, reason, blob: blob ?? null, detail: detail ?? null, at: new Date(now()).toISOString() }); } catch { /* an alert sink failing must not change the answer */ }
  };

  const goodFile = (product) => join(stateDir, `${product}.last-good.json`);

  // The last good version survives a restart, but only if it still checks out (MAT-3).
  function loadGood(p) {
    const f = goodFile(p.product);
    if (!existsSync(f)) return null;
    try {
      const g = JSON.parse(readFileSync(f, 'utf8'));
      if (typeof g.text !== 'string' || !SHA.test(g.commit) || !SHA.test(g.blob)) return null;
      if (blobSha(Buffer.from(g.text, 'utf8')) !== g.blob) return null;
      const parsed = parsePolicy(g.text);
      if (!parsed.ok) return null;
      return { ...g, policy: parsed.policy };
    } catch { return null; }
  }

  function saveGood(product, g) {
    const f = goodFile(product);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ text: g.text, commit: g.commit, blob: g.blob, verified_at: g.verified_at }), { mode: 0o600 });
    renameSync(tmp, f);
  }

  for (const p of products) {
    const good = loadGood(p);
    // A restored version is not trusted until one fresh read of GitHub agrees it is still current: fail closed.
    states.set(p.product, { good, lastFetchOk: null, deleted: false, reason: good ? 'restored last good' : 'not loaded yet' });
  }

  async function refreshOne(p) {
    const st = states.get(p.product);
    const base = `/repos/${p.owner}/${p.repo}`;
    let ref; let file;
    try {
      ref = await gh.get(`${base}/git/ref/heads/${BRANCH}`);
      if (ref.status === 404) return gone(p, st, 'main branch not found');
      if (ref.status !== 200) throw new Error(`branch read answered ${ref.status}`);
      const commit = ref.json?.object?.sha;
      if (!SHA.test(commit ?? '')) throw new Error('branch read gave no commit');
      file = await gh.get(`${base}/contents/${RULES_PATH}?ref=${commit}`);
      if (file.status === 404) return gone(p, st, 'rules file not found');
      if (file.status !== 200) throw new Error(`rules read answered ${file.status}`);
      file.commit = commit;
    } catch (e) {
      st.reason = `GitHub unreachable: ${e.message}`;
      if (st.lastFetchOk === null || now() - st.lastFetchOk > FETCH_GRACE_MS) say(p.product, 'rules_unreachable', st.good?.blob, e.message);
      return;
    }
    st.lastFetchOk = now();
    st.deleted = false;

    const j = file.json ?? {};
    const { commit } = file;
    const blob = j.sha;
    let text;
    try {
      if (j.type !== 'file' || j.path !== RULES_PATH) throw new Error('not the rules file');
      if (!SHA.test(blob ?? '') || j.encoding !== 'base64' || typeof j.content !== 'string') throw new Error('odd contents answer');
      if (!Number.isSafeInteger(j.size) || j.size > MAX_BYTES) throw new Error('rules file over 1 MB');
      const buf = Buffer.from(j.content.replace(/\n/g, ''), 'base64');
      if (buf.length !== j.size || blobSha(buf) !== blob) throw new Error('contents do not match the named version');
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      return keep(p, st, 'corrupt_rules', blob, e.message);
    }

    if (st.good && st.good.blob === blob) { st.reason = 'unchanged'; return; }

    const parsed = parsePolicy(text);
    if (!parsed.ok) return keep(p, st, 'corrupt_rules', blob, parsed.reason);

    if (st.good) {
      let cmp;
      try { cmp = await gh.get(`${base}/compare/${st.good.commit}...${commit}`); } catch (e) { cmp = { status: 0, error: e.message }; }
      const how = cmp.status === 200 ? cmp.json?.status : null;
      if (how !== 'ahead' && how !== 'identical') return keep(p, st, 'main_rewound', blob, `main is ${how ?? 'unknown'} against the last good commit`);
    }

    // Whose approval counts is fixed BEFORE reading the new file: the last good rules, or products.json.
    const joeId = st.good ? st.good.policy.accounts.joe.github_id : p.joe_github_id;
    let approved = false;
    let why = `version ${blob.slice(0, 7)} has no approval from Joe`;
    try {
      const v = await verify({ product: p.product, owner: p.owner, repo: p.repo, commit, blob, joeId, gh,
        lastGood: st.good?.commit ?? null, lastGoodBlob: st.good?.blob ?? null });
      approved = v === true;
      if (!approved && typeof v?.reason === 'string') why += ` (${v.reason})`;
    } catch (e) { why += ` (${e.message})`; }
    if (!approved) return keep(p, st, 'unapproved_rules_change', blob, why);

    const good = { text, commit, blob, verified_at: new Date(now()).toISOString(), policy: parsed.policy };
    saveGood(p.product, good);
    st.good = good;
    st.reason = 'adopted';
  }

  function gone(p, st, why) {
    st.deleted = true;
    st.reason = why;
    say(p.product, 'rules_missing', null, why);
  }

  function keep(p, st, reason, blob, detail) {
    st.reason = `${reason}: ${detail}`;
    say(p.product, reason, blob, detail);
  }

  return Object.freeze({
    async refresh() {
      for (const p of products) {
        try { await refreshOne(p); } catch (e) { keep(p, states.get(p.product), 'reader_error', null, e.message); }
      }
    },
    state(product) {
      const st = states.get(product);
      if (!st) return { status: 'deny_all', policy: null, rev: null, reason: 'unknown product' };
      const t = now();
      // A clock that went backwards doesn't extend the grace: a last read "in the future" counts as stale.
      const stale = st.lastFetchOk === null || t - st.lastFetchOk > FETCH_GRACE_MS || t < st.lastFetchOk;
      if (st.deleted || !st.good || stale) return { status: 'deny_all', policy: null, rev: null, reason: st.reason };
      const g = st.good;
      const status = st.reason === 'adopted' || st.reason === 'unchanged' ? 'ok' : 'last_good';
      return { status, policy: g.policy, rev: `${g.commit.slice(0, 7)}:${g.blob.slice(0, 7)}`, commit: g.commit, blob: g.blob, reason: st.reason };
    },
  });
}

// The real client: GET on api.github.com only, with a token from the caller. Tests pass a fake with the same get().
export function githubClient({ token, fetchFn = globalThis.fetch, timeoutMs = 10_000 }) {
  return Object.freeze({
    async get(path) {
      if (!path.startsWith('/repos/')) throw new Error('only repository reads are allowed');
      const res = await fetchFn(`https://api.github.com${path}`, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token()}`, 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, json: res.status === 200 ? await res.json() : null };
    },
  });
}
