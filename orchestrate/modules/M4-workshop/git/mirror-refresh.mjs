// mirror-refresh.mjs — brings the mirror up to a caught-up pull request before its short re-audit (L513 MAT-1, L521).
//
// WHY THIS IS NOT THE RUNNER'S. The Merge Gate catches a branch up through GitHub's update-branch, so the new head and
// the new main exist only on GitHub. The review runner needs both in the mirror, for the carry-over reading, the
// current head and the review copy. But the runner runs as `review`, which only reads the mirror and must never hold a
// robot key. So the gate does it, as orchestrate, which owns the mirror and the robot key folder.
//
// The fetch goes through safe-git, the way push.mjs fetches: the same flags, the same one address besides local paths.
//
//   createMirrorRefresh({ rules, getRobotToken, testRemote? }) → refreshMirror({ product, card, head })
//     → { ok: true } | { ok: false, reason }
//
// It never throws for a refusal, and no reason carries git's own output. Run on every pass of a re-audit wait: main keeps
// moving, and a fetch that failed is simply tried again. Ports:
//   rules          rules.get('product.repo' | 'product.mirror' | 'product.default_branch', { product })
//   getRobotToken(product)  M6's short-lived robot key (R-0b-86)
//   testRemote(repo)        tests only: a local folder standing in for GitHub

import { isAbsolute } from 'node:path';
import { git, checkMirror } from './safe-git.mjs';
import { BRANCH, githubUrl, tokenConfig } from './push.mjs';

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;

export function createMirrorRefresh({ rules, getRobotToken, testRemote }) {
  return async function refreshMirror({ product, card, head }) {
    const no = (reason) => ({ ok: false, reason });
    const branch = `card/${String(card).toLowerCase()}`;
    if (!BRANCH.test(branch)) return no('not a card\'s branch');
    if (!SHA.test(String(head))) return no('the head is not 40 hex');
    const repo = rules.get('product.repo', { product });
    const mirror = rules.get('product.mirror', { product });
    const base = rules.get('product.default_branch', { product }) ?? 'main';
    if (typeof repo !== 'string' || !REPO.test(repo) || repo.includes('..')) return no('the product has no valid GitHub repo in the rules');
    if (typeof mirror !== 'string' || !isAbsolute(mirror)) return no('the product has no mirror in the rules');
    const m = checkMirror(mirror);
    if (!m.ok) return no(`mirror: ${m.reason}`);
    const url = testRemote ? testRemote(repo) : githubUrl(repo);
    let token;
    try { token = await getRobotToken(product); } catch { token = null; }
    if (typeof token !== 'string' || !token) return no('no robot key for this product');
    const f = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', url,
      `+refs/heads/${base}:refs/heads/${base}`, `+refs/heads/${branch}:refs/heads/${branch}`],
    { gitDir: mirror, purpose: 'mirror-refresh', extraConfig: tokenConfig(token), address: url });
    if (f.code !== 0) return no('could not fetch from GitHub');
    const tip = await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { gitDir: mirror, purpose: 'mirror-refresh-tip' });
    const at = tip.code === 0 ? tip.stdout.toString('utf8').trim() : null;
    // The pull request moved after the gate judged it. The next pass judges the new head; nothing is reviewed at this one.
    if (at !== head) return no(`the branch is at ${String(at ?? 'nothing').slice(0, 7)}, not ${head.slice(0, 7)}`);
    return { ok: true };
  };
}
