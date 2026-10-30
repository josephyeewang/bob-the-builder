// build-skip.mjs — Vercel's "Ignored Build Step": build nothing but main, and fail closed (R-0b-96; 0b-9 M5).
//
// WHY. GitHub's free plan can't stop a hand push to main, and Vercel builds whatever lands on a branch it watches. So
// the deploy itself asks the question: Vercel runs one pasted command before each build, and its exit code decides
// (exit 0 = SKIP the build, exit 1 = BUILD). That command downloads this checker at a pinned commit, checks its sha256
// and runs it. Every failure (a failed download, a wrong hash, a crash, an unreadable GitHub answer) leaves the commit
// undeployed: the command only builds when the checker prints BUILD_TOKEN, so a crash that exits 1 still skips.
// Two modes, pinned in the command string:
//   first — skip every build that is not production on main; a main commit then builds with no mark check.
//   full  — a main commit builds only if it carries the robot's mark (mark.mjs; an undo is a marked merge too, its
//           exact reverse recomputed by the checker), or the owner's override label: added to the merged pull request
//           by the owner's numeric GitHub id, as a person (type User, not via an app), and not removed since.
// A branch push (the robot's included) is never production on main, so it builds nothing.
//
//   decideBuild({ mode, env }) → { build, reason, needsMarkCheck? }      the env-only part (full mode stops here with needsMarkCheck)
//   await decideBuildFull({ env, gh, robotBotId, ownerId, overrideLabel = 'owner-deploy' }) → { build, reason }
//   skipCommand({ mode, checkerUrl, sha256 }) → the one-line shell command pasted into Vercel
//   makeFetchGh({ token, fetchImpl }) → a read-only GitHub client ({ get(path) } → { status, json }) on api.github.com
//   await main(argv, env, { gh, out }?) → 0 (skip) | 1 (build); never throws; prints BUILD_TOKEN before returning 1
// Vercel's env: VERCEL_ENV, VERCEL_GIT_COMMIT_REF, VERCEL_GIT_COMMIT_SHA, VERCEL_GIT_REPO_OWNER, VERCEL_GIT_REPO_SLUG.
// Ours (set by the owner in Vercel): ORCHESTRATE_ROBOT_BOT_ID, ORCHESTRATE_OWNER_ID, ORCHESTRATE_OVERRIDE_LABEL (optional),
// ORCHESTRATE_GITHUB_TOKEN (optional, read-only; never printed).
// Endpoint shapes from GitHub's REST docs (version 2022-11-28, read 30 Oct 2026; Principle 9: void on an API change).

import { readMark } from './mark.mjs';

export const MODES = Object.freeze(['first', 'full']);
export const BUILD_TOKEN = 'orchestrate-build-skip:BUILD';
export const DEFAULT_OVERRIDE_LABEL = 'owner-deploy';
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const LABEL = /^[A-Za-z0-9 _.:-]{1,50}$/;
// https only, a 40-hex commit as one whole path segment, and nothing a shell could read as syntax.
const PINNED_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._-]+)*\/[0-9a-f]{40}(\/[A-Za-z0-9._-]+)+$/;
const skip = (reason) => ({ build: false, reason });
const errText = (e) => String(e?.message ?? e).slice(0, 200);

export function decideBuild({ mode, env } = {}) {
  try {
    if (!MODES.includes(mode)) return skip(`unknown mode ${JSON.stringify(mode)}`);
    if (!env || typeof env !== 'object') return skip('no environment');
    if (env.VERCEL_ENV !== 'production') return skip(`not production (${String(env.VERCEL_ENV).slice(0, 40)})`);
    if (env.VERCEL_GIT_COMMIT_REF !== 'main') return skip('not the main branch');
    if (!SHA.test(env.VERCEL_GIT_COMMIT_SHA ?? '')) return skip('no full commit id');
    if (mode === 'first') return { build: true, reason: 'first cutover: production on main' };
    return { build: false, reason: 'full mode: the mark check decides', needsMarkCheck: true };
  } catch (e) { return skip(`env check failed: ${errText(e)}`); }
}

export async function decideBuildFull({ env, gh, robotBotId, ownerId, overrideLabel = DEFAULT_OVERRIDE_LABEL } = {}) {
  try {
    const pre = decideBuild({ mode: 'full', env });
    if (!pre.needsMarkCheck) return skip(pre.reason);
    const owner = env.VERCEL_GIT_REPO_OWNER;
    const repo = env.VERCEL_GIT_REPO_SLUG;
    const sha = env.VERCEL_GIT_COMMIT_SHA;
    if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) return skip('no repository named');
    if (!gh || typeof gh.get !== 'function') return skip('no GitHub client');
    const mark = await readMark({ gh, owner, repo, sha, robotBotId });
    if (mark.ok) return { build: true, reason: `the robot's mark (card ${mark.card}, pull request ${mark.pr})` };
    const o = await ownerOverride({ gh, owner, repo, sha, ownerId, overrideLabel });
    if (o.ok) return { build: true, reason: `the owner's ${overrideLabel} label on pull request ${o.pr}` };
    return skip(`no mark (${mark.reason}) and no owner override (${o.reason})`);
  } catch (e) { return skip(`full check failed: ${errText(e)}`); }
}

// The owner's override: the label's last add-or-remove on the merged pull request is an add by the owner, as a person.
async function ownerOverride({ gh, owner, repo, sha, ownerId, overrideLabel }) {
  const no = (reason) => ({ ok: false, reason });
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return no('no owner id configured');
  if (typeof overrideLabel !== 'string' || !LABEL.test(overrideLabel)) return no('no override label configured');
  const base = `/repos/${owner}/${repo}`;
  const pulls = await gh.get(`${base}/commits/${sha}/pulls?per_page=100`);
  if (pulls?.status !== 200 || !Array.isArray(pulls.json)) return no(`pull requests unreadable (${pulls?.status})`);
  for (const p of pulls.json) {
    if (!Number.isSafeInteger(p?.number)) continue;
    const full = await gh.get(`${base}/pulls/${p.number}`);
    const j = full?.json;
    if (full?.status !== 200 || !j || j.merged !== true || j.merge_commit_sha !== sha || j.base?.ref !== 'main') continue;
    const ev = await gh.get(`${base}/issues/${p.number}/events?per_page=100`);
    if (ev?.status !== 200 || !Array.isArray(ev.json)) return no(`label history unreadable (${ev?.status})`);
    if (ev.json.length >= 100) return no('label history too long to read whole');
    const last = ev.json.filter((e) => (e?.event === 'labeled' || e?.event === 'unlabeled') && e?.label?.name === overrideLabel).at(-1);
    if (!last) continue;
    if (last.event === 'labeled' && last.actor?.id === ownerId && last.actor?.type === 'User' && !last.performed_via_github_app) return { ok: true, pr: p.number };
    return no(`the ${overrideLabel} label was last set by someone other than the owner, or removed`);
  }
  return no('no merged pull request carries the owner\'s label');
}

export function skipCommand({ mode, checkerUrl, sha256 } = {}) {
  if (!MODES.includes(mode)) throw new Error('mode must be first or full');
  if (typeof checkerUrl !== 'string' || !PINNED_URL.test(checkerUrl)) throw new Error('the checker URL must be https and pinned to a 40-hex commit (no branch, tag or short id)');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 lowercase hex characters');
  // Each step must succeed for the next to run; any failure falls through to `exit 0` (skip). Only the exact token
  // on the checker's output reaches `exit 1` (build).
  return `f=$(mktemp) && curl -fsSL --max-time 60 -o "$f" '${checkerUrl}' && [ "$(sha256sum "$f" | cut -c1-64)" = ${sha256} ] && [ "$(node "$f" ${mode})" = ${BUILD_TOKEN} ] && exit 1; exit 0`;
}

export function makeFetchGh({ token, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch');
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'orchestrate-checker' };
  if (typeof token === 'string' && token) headers.authorization = `Bearer ${token}`;
  return Object.freeze({
    async get(path) {
      if (typeof path !== 'string' || !path.startsWith('/repos/')) throw new Error('only repository reads');
      const r = await fetchImpl(`https://api.github.com${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      let json = null;
      try { json = await r.json(); } catch { /* not JSON: json stays null */ }
      return { status: r.status, json };
    },
  });
}

const intEnv = (v) => (typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : null);

export async function main(argv, env, { gh, out = (s) => console.log(s) } = {}) {
  try {
    const mode = Array.isArray(argv) ? argv[0] : undefined;
    const e = env && typeof env === 'object' ? env : {};
    let d;
    if (mode === 'first') d = decideBuild({ mode, env: e });
    else if (mode === 'full') {
      d = await decideBuildFull({ env: e, gh: gh ?? makeFetchGh({ token: e.ORCHESTRATE_GITHUB_TOKEN }), robotBotId: intEnv(e.ORCHESTRATE_ROBOT_BOT_ID),
        ownerId: intEnv(e.ORCHESTRATE_OWNER_ID), overrideLabel: e.ORCHESTRATE_OVERRIDE_LABEL || DEFAULT_OVERRIDE_LABEL });
    } else d = skip(`unknown mode ${JSON.stringify(String(mode).slice(0, 20))}`);
    try { console.error(`build-skip: ${d.build ? 'build' : 'skip'}: ${d.reason}`); } catch { /* no log is fine */ }
    if (d.build !== true) return 0;
    out(BUILD_TOKEN);
    return 1;
  } catch { return 0; }
}
