// workflow-route.mjs — the workflow route's fingerprint: Joe approves a workflow change as text, and only exactly
// that change may be pushed (R-0b-91, the fingerprint part; the second robot's real push is a later human step).
//
// WHY. The ordinary robot may never push .github/ (M10 push_branch refuses it), because a workflow is code GitHub runs
// with the repository's access. A workflow change goes on its own route: it is shown to Joe as a patch in a decision
// pull request, and after his Approve a second robot pushes it. What he approved is pinned by a fingerprint of the
// RESULT, not the patch text: sha256 over the sorted (path, mode, resulting blob) list plus the deleted paths, from
// the patch applied to the decision PR's base. So a patch re-formatted (other context lines, other hunk order) still
// matches, and a pushed branch that lands any other byte, mode or path does not.
//
//   workflowFingerprint({ changed: [{ path, mode, blob }], deleted: [path] }) → { ok: true, sha256 } | { ok: false, reason }
//   await fingerprintOfBranch({ view, base, head }) → { ok: true, sha256, changed, deleted } | { ok: false, reason }
//   await checkRoutePush({ view, base, head, approvedSha256, approvedPaths }) → { ok: true } | { ok: false, reason }
//   decisionBody({ patchText, sha256 }) → markdown for the decision pull request (throws on bad input: a string builder)
// `view` is M10's git view (git-view.mjs makeGitView). Any error → no (fail closed).

import { createHash } from 'node:crypto';

const BLOB = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODES = new Set(['100644', '100755', '120000']);   // a file, a runnable file, a link; never a submodule
const MAX_BODY = 60000;                                    // GitHub's pull request body limit is 65,536 characters
const goodPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 512 && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');
const why = (e) => { try { const m = e?.message; return typeof m === 'string' ? m.slice(0, 200) : 'unknown error'; } catch { return 'unknown error'; } };

export function workflowFingerprint({ changed, deleted } = {}) {
  const no = (reason) => ({ ok: false, reason });
  try {
    if (!Array.isArray(changed) || !Array.isArray(deleted)) return no('a fingerprint needs a changed list and a deleted list');
    if (!changed.length && !deleted.length) return no('an empty change has no fingerprint');
    const seen = new Set();
    const rows = [];
    for (const c of changed) {
      if (!goodPath(c?.path)) return no(`odd path ${JSON.stringify(String(c?.path)).slice(0, 80)}`);
      if (!MODES.has(c.mode)) return no(`${c.path}: mode ${JSON.stringify(c.mode)} is not 100644, 100755 or 120000`);
      if (!BLOB.test(c.blob ?? '')) return no(`${c.path}: blob is not 40-hex`);
      if (seen.has(c.path)) return no(`${c.path} listed twice`);
      seen.add(c.path);
      rows.push([c.path, c.mode, c.blob]);
    }
    const gone = [];
    for (const p of deleted) {
      if (!goodPath(p)) return no(`odd deleted path ${JSON.stringify(String(p)).slice(0, 80)}`);
      if (seen.has(p)) return no(`${p} is both changed and deleted, or listed twice`);
      seen.add(p);
      gone.push(p);
    }
    const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort((a, b) => byPath(a[0], b[0]));
    gone.sort(byPath);
    return { ok: true, sha256: createHash('sha256').update(JSON.stringify({ changed: rows, deleted: gone })).digest('hex') };
  } catch (e) { return no(`fingerprint failed: ${why(e)}`); }
}

// The result of base..head as a fingerprint: each path present at head with its blob and mode, and each path gone.
export async function fingerprintOfBranch({ view, base, head } = {}) {
  const no = (reason) => ({ ok: false, reason });
  try {
    if (!view || typeof view.files !== 'function' || typeof view.entry !== 'function') return no('no git view');
    const files = await view.files(base, head);   // refuses a base that isn't an ancestor of head
    const changed = [];
    const deleted = [];
    for (const f of files) {
      if (f.status === 'removed') { deleted.push(f.path); continue; }
      if (f.status === 'renamed') deleted.push(f.previous_path);   // a rename removes the old name; a copy keeps it
      const e = await view.entry(head, f.path);
      if (!e) return no(`${f.path} is listed as changed but is not at the head`);
      changed.push({ path: f.path, mode: e.mode, blob: e.blob });
    }
    const fp = workflowFingerprint({ changed, deleted });
    return fp.ok ? { ok: true, sha256: fp.sha256, changed, deleted } : fp;
  } catch (e) { return no(`branch unreadable: ${why(e)}`); }
}

export async function checkRoutePush({ view, base, head, approvedSha256, approvedPaths } = {}) {
  const no = (reason) => ({ ok: false, reason });
  try {
    if (!SHA256.test(approvedSha256 ?? '')) return no('no approved fingerprint');
    if (!Array.isArray(approvedPaths) || !approvedPaths.length || !approvedPaths.every(goodPath)) return no('no approved path list');
    const fp = await fingerprintOfBranch({ view, base, head });
    if (!fp.ok) return no(fp.reason);
    const allowed = new Set(approvedPaths);
    for (const p of [...fp.changed.map((c) => c.path), ...fp.deleted]) {
      if (!p.startsWith('.github/')) return no(`${p} is outside .github/; the workflow route changes only workflow files`);
      if (!allowed.has(p)) return no(`${p} was not in the approved change`);
    }
    if (fp.sha256 !== approvedSha256) return no('the pushed change differs from the approved fingerprint');
    return { ok: true };
  } catch (e) { return no(`push check failed: ${why(e)}`); }
}

// The patch is shown inside a fence longer than any run of backticks in it, so no line of it can close the fence.
export function decisionBody({ patchText, sha256 } = {}) {
  if (typeof patchText !== 'string' || !patchText.trim()) throw new Error('a decision body needs the patch text');
  if (!SHA256.test(sha256 ?? '')) throw new Error('a decision body needs the 64-hex fingerprint');
  const longest = Math.max(0, ...[...patchText.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = [
    'A workflow change for the second robot to push. Approve only if this exact change is wanted.',
    '',
    `${fence}diff`,
    patchText.replace(/\r\n?/g, '\n').replace(/\n$/, ''),
    fence,
    '',
    `Fingerprint (sha256 of the resulting files): \`${sha256}\``,
    '',
  ].join('\n');
  if (body.length > MAX_BODY) throw new Error('the patch is too long to show in one decision; split the change');
  return body;
}
