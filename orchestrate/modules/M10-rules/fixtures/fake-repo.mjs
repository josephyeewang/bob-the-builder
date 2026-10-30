// fake-repo.mjs — an in-memory git repository that answers the GitHub REST reads M10 makes, for tests only.
// Commits hold whole file trees, so diffs, merge bases, renames and mode changes are computed, not scripted.
//
//   const r = fakeRepo({ owner, repo });
//   const a = r.commit([], { 'docs/a.md': 'one' });                   // root commit
//   const b = r.commit([a], { 'docs/a.md': 'two', 'x.sh': { text: 'x', mode: '100755' } }, { from: a });
//   r.main = b;  r.pull({ number, merged, base, head, merge_commit_sha, commits: [shas] });
//   r.gh.get(path) → { status, json }   (the reader's client shape)

import { createHash } from 'node:crypto';
import { blobSha } from '../reader.mjs';

export function fakeRepo({ owner = 'sample-org', repo = 'sample-app' } = {}) {
  const commits = new Map();       // sha → { parents, files: Map path → { blob, mode, text }, n }
  const pulls = new Map();         // number → pull
  const commitPulls = new Map();   // sha → [number]
  let n = 0;
  const r = { main: null, calls: [], down: false, override: null };

  // files: path → text | { text, mode } | null (delete). With `from`, start from that commit's tree.
  r.commit = (parents, files, { from } = {}) => {
    const tree = new Map(from ? commits.get(from).files : parents[0] ? commits.get(parents[0]).files : []);
    for (const [path, v] of Object.entries(files)) {
      if (v === null) { tree.delete(path); continue; }
      const text = typeof v === 'string' ? v : v.text;
      tree.set(path, { text, mode: typeof v === 'string' ? '100644' : v.mode ?? '100644', blob: blobSha(Buffer.from(text)) });
    }
    const sha = createHash('sha1').update(`commit ${++n}`).digest('hex');
    commits.set(sha, { parents: [...parents], files: tree, n });
    return sha;
  };
  r.pull = (p) => {
    pulls.set(p.number, p);
    for (const c of p.commits ?? []) commitPulls.set(c, [...(commitPulls.get(c) ?? []), p.number]);
  };
  r.linkPull = (sha, number) => commitPulls.set(sha, [...(commitPulls.get(sha) ?? []), number]);
  r.files = (sha) => commits.get(sha).files;

  const ancestors = (sha) => {
    const seen = new Set(); const todo = [sha];
    while (todo.length) { const c = todo.pop(); if (!seen.has(c)) { seen.add(c); todo.push(...commits.get(c).parents); } }
    return seen;
  };
  const mergeBase = (a, b) => {
    const A = ancestors(a);
    return [...ancestors(b)].filter((c) => A.has(c)).sort((x, y) => commits.get(y).n - commits.get(x).n)[0] ?? null;
  };
  const diff = (from, to) => {
    const A = commits.get(from).files; const B = commits.get(to).files;
    const removed = [...A.keys()].filter((p) => !B.has(p));
    const added = [...B.keys()].filter((p) => !A.has(p));
    const out = [];
    for (const [p, e] of B) {
      if (!A.has(p)) continue;
      const o = A.get(p);
      if (o.blob !== e.blob) out.push({ filename: p, status: 'modified', sha: e.blob });
      else if (o.mode !== e.mode) out.push({ filename: p, status: 'changed', sha: e.blob });
    }
    for (const p of added) {
      const i = removed.findIndex((q) => A.get(q).blob === B.get(p).blob);   // exact renames only
      if (i >= 0) { out.push({ filename: p, previous_filename: removed[i], status: 'renamed', sha: B.get(p).blob }); removed.splice(i, 1); }
      else out.push({ filename: p, status: 'added', sha: B.get(p).blob });
    }
    for (const p of removed) out.push({ filename: p, status: 'removed', sha: A.get(p).blob });
    return out.sort((x, y) => (x.filename < y.filename ? -1 : 1));
  };
  // The newest commit reachable from `tip` whose version of `path` differs from every parent (git's default
  // history simplification: a merge that kept one parent's version is skipped).
  const lastTouching = (tip, path) => [...ancestors(tip)].sort((x, y) => commits.get(y).n - commits.get(x).n).find((c) => {
    const e = commits.get(c).files.get(path);
    const ps = commits.get(c).parents;
    if (!ps.length) return Boolean(e);
    return ps.every((p) => { const o = commits.get(p).files.get(path); return (o?.blob ?? null) !== (e?.blob ?? null) || (o?.mode ?? null) !== (e?.mode ?? null); });
  }) ?? null;
  const treeSha = (sha) => createHash('sha1').update(`tree ${sha}`).digest('hex');

  const base = `/repos/${owner}/${repo}`;
  const ok = (json) => ({ status: 200, json });
  r.gh = {
    async get(path) {
      r.calls.push(path);
      if (r.down) throw new Error('network down');
      if (r.override) { const o = r.override(path); if (o) return o; }
      if (!path.startsWith(`${base}/`)) return { status: 404 };
      const p = path.slice(base.length);
      let m;
      if (p === '/git/ref/heads/main') return r.main ? ok({ object: { sha: r.main } }) : { status: 404 };
      if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(p))) {
        const c = commits.get(m[1]);
        return c ? ok({ sha: m[1], tree: { sha: treeSha(m[1]) }, parents: c.parents.map((s) => ({ sha: s })) }) : { status: 404 };
      }
      if ((m = /^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(p))) {
        const sha = [...commits.keys()].find((s) => treeSha(s) === m[1]);
        if (!sha) return { status: 404 };
        const tree = [...commits.get(sha).files].map(([fp, e]) => ({ path: fp, mode: e.mode, type: e.mode === '160000' ? 'commit' : 'blob', sha: e.blob }));
        return ok({ sha: m[1], tree, truncated: false });
      }
      if ((m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(p))) {
        const [b, h] = [m[1], m[2]];
        if (!commits.has(b) || !commits.has(h)) return { status: 404 };
        const mb = mergeBase(b, h);
        const status = b === h ? 'identical' : mb === b ? 'ahead' : mb === h ? 'behind' : 'diverged';
        return ok({ status, merge_base_commit: { sha: mb }, files: diff(mb, h) });
      }
      if ((m = /^\/commits\?sha=([0-9a-f]{40})&path=([^&]+)&per_page=1$/.exec(p))) {
        if (!commits.has(m[1])) return { status: 404 };
        const c = lastTouching(m[1], decodeURIComponent(m[2]));
        return ok(c ? [{ sha: c }] : []);
      }
      if ((m = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(p))) {
        return ok((commitPulls.get(m[1]) ?? []).map((num) => ({ number: num })));
      }
      if ((m = /^\/pulls\/(\d+)$/.exec(p))) {
        const pr = pulls.get(Number(m[1]));
        if (!pr) return { status: 404 };
        return ok({ number: pr.number, merged: pr.merged, merged_at: pr.merged ? '2026-10-14T14:00:00Z' : null,
          base: { ref: pr.base ?? 'main' }, head: { sha: pr.head }, merge_commit_sha: pr.merge_commit_sha ?? null });
      }
      if ((m = /^\/contents\/([^?]+)\?ref=([0-9a-f]{40})$/.exec(p))) {
        const c = commits.get(m[2]);
        const e = c?.files.get(decodeURIComponent(m[1]));
        if (!e) return { status: 404 };
        const buf = Buffer.from(e.text);
        return ok({ type: 'file', path: decodeURIComponent(m[1]), sha: e.blob, size: buf.length, encoding: 'base64', content: buf.toString('base64') });
      }
      return { status: 404 };
    },
  };
  return r;
}
