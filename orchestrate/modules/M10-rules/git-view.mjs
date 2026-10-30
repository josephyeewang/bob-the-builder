// git-view.mjs — the few read-only questions about a GitHub repository that the exact-reverse check, the carry-over
// rule and the approving-pull lookup ask: a commit's parents, which files changed between two commits, and a file's
// version (blob and mode) at a commit. Built on the reader's GitHub client (`get(path)` → { status, json }), so it
// reads api.github.com only, through the same fixed client.
//
// WHY ONE VIEW. Those three checks decide whether a change skips Joe's review. Each answer here is checked as it is
// read, and anything odd (a missing commit, a cut-off list, an unknown file status) throws: the callers turn any
// throw into "no" (fail closed).
//
//   const view = makeGitView({ gh, owner, repo });
//   await view.commit(sha)         → { sha, tree, parents: [sha…] }
//   await view.compare(base, head) → { status: 'identical'|'ahead'|'behind'|'diverged', mergeBase, files }
//   await view.files(base, head)   → [{ path, previous_path?, status }]  (base must be an ancestor of head)
//   await view.entry(sha, path)    → { blob, mode } | null              (null = no file there)
//   await view.onHistory(sha, tip) → true when sha is tip or one of its ancestors
//
// LIMITS WE DEPEND ON (claims about GitHub, so they expire: checked 2026-10-29 against REST API version 2022-11-28,
// docs.github.com "Compare two commits" and "Get a tree"). A compare answer lists at most 300 files, so a list of
// 300 or more is treated as cut off and refused. A recursive tree answer can be `truncated`, which is refused.

export const COMPARE_FILE_LIMIT = 300;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const MODES = new Set(['100644', '100755', '120000', '160000']);
// GitHub's file statuses → ours. `changed` is GitHub's word for a mode-only change; `unchanged` is dropped.
const STATUS = { added: 'added', removed: 'removed', modified: 'modified', renamed: 'renamed', copied: 'copied', changed: 'modified' };

export function makeGitView({ gh, owner, repo }) {
  if (!gh || typeof gh.get !== 'function') throw new Error('git view needs a GitHub client with get()');
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) throw new Error('git view needs an owner and repo');
  const base = `/repos/${owner}/${repo}`;
  const commits = new Map();
  const trees = new Map();
  const sha = (s, what) => { if (typeof s !== 'string' || !SHA.test(s)) throw new Error(`${what} is not a full commit id`); return s; };
  const read = async (path) => {
    const r = await gh.get(`${base}${path}`);
    if (r?.status !== 200 || !r.json || typeof r.json !== 'object') throw new Error(`GitHub answered ${r?.status} for ${path}`);
    return r.json;
  };

  async function commit(s) {
    sha(s, 'commit');
    if (!commits.has(s)) {
      const j = await read(`/git/commits/${s}`);
      if (j.sha !== s || !SHA.test(j.tree?.sha ?? '') || !Array.isArray(j.parents)) throw new Error(`odd commit answer for ${s.slice(0, 7)}`);
      const parents = j.parents.map((p) => sha(p?.sha, 'parent'));
      commits.set(s, Object.freeze({ sha: s, tree: j.tree.sha, parents: Object.freeze(parents) }));
    }
    return commits.get(s);
  }

  async function tree(s) {
    if (!trees.has(s)) {
      const c = await commit(s);
      const j = await read(`/git/trees/${c.tree}?recursive=1`);
      if (j.truncated !== false) throw new Error(`file list of ${s.slice(0, 7)} is cut off or unknown`);
      if (!Array.isArray(j.tree)) throw new Error('odd tree answer');
      const m = new Map();
      for (const e of j.tree) {
        if (e?.type === 'tree') continue;
        if ((e?.type !== 'blob' && e?.type !== 'commit') || typeof e.path !== 'string' || !SHA.test(e.sha ?? '') || !MODES.has(e.mode)) throw new Error('odd tree entry');
        m.set(e.path, Object.freeze({ blob: e.sha, mode: e.mode }));
      }
      trees.set(s, m);
    }
    return trees.get(s);
  }

  async function compare(b, h) {
    sha(b, 'base'); sha(h, 'head');
    const j = await read(`/compare/${b}...${h}`);
    if (!['identical', 'ahead', 'behind', 'diverged'].includes(j.status)) throw new Error('odd compare status');
    const mergeBase = sha(j.merge_base_commit?.sha, 'merge base');
    const raw = Array.isArray(j.files) ? j.files : (j.status === 'identical' ? [] : null);
    if (!raw) throw new Error('compare gave no file list');
    if (raw.length >= COMPARE_FILE_LIMIT) throw new Error(`compare lists ${raw.length} files; GitHub cuts the list at ${COMPARE_FILE_LIMIT}`);
    const files = [];
    for (const f of raw) {
      if (f?.status === 'unchanged') continue;
      const status = Object.hasOwn(STATUS, f?.status ?? '') ? STATUS[f.status] : null;
      if (!status || typeof f.filename !== 'string' || !f.filename) throw new Error(`odd file in compare: ${JSON.stringify(f?.filename)}`);
      const entry = { path: f.filename, status };
      if (status === 'renamed' || status === 'copied') {
        if (typeof f.previous_filename !== 'string' || !f.previous_filename) throw new Error(`${f.filename}: ${status} with no old name`);
        entry.previous_path = f.previous_filename;
      }
      files.push(Object.freeze(entry));
    }
    return { status: j.status, mergeBase, files };
  }

  return Object.freeze({
    commit,
    compare,
    async files(b, h) {
      const c = await compare(b, h);
      if (c.mergeBase !== b || (c.status !== 'ahead' && c.status !== 'identical')) throw new Error(`${b.slice(0, 7)} is not an ancestor of ${h.slice(0, 7)}`);
      return c.files;
    },
    async entry(s, path) { return (await tree(s)).get(path) ?? null; },
    async onHistory(s, tip) {
      const c = await compare(s, tip);
      return c.status === 'identical' || (c.status === 'ahead' && c.mergeBase === s);
    },
  });
}

// Every name a file list touches: both the old and the new name of a rename or copy.
export function touchedPaths(files) {
  const out = new Set();
  for (const f of files) { out.add(f.path); if (f.previous_path !== undefined) out.add(f.previous_path); }
  return out;
}

export const sameEntry = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.blob === b.blob && a.mode === b.mode);
