// mark.mjs — the robot's mark: how a merge says "the Merge Gate judged this" (R-0b-86, R-0b-94; 0b-9 M4, M5).
//
// WHY. GitHub can't stop a hand push to main on the free plan (0b-9 M5(ii)), so the checks after a merge (the audit,
// the build-skip check) ask one question of every main commit: did the Merge Gate make it? The answer is the mark:
//   - a commit status with context MARK_CONTEXT, state success, on the merged commit,
//   - created by the robot's own bot account (numeric id, product_profile.robot.bot_user_id; a login can be renamed),
//   - whose description names the card and the judged head (markDescription), and
//   - the commit is the merge commit of a pull request that the same robot merged, whose head is that judged head.
// Typed text ("Orchestrate-…" lines in a message) is never a mark. An undo is recognised by the mark plus a
// recomputed exact reverse (M10 exact-reverse.mjs), never by who opened it.
//
//   markDescription({ card, head }) → string        (≤ 140 characters, GitHub's limit for a status description)
//   parseMark(description) → { card, head } | null
//   await readMark({ gh, owner, repo, sha, robotBotId }) → { ok: true, card, head, pr } | { ok: false, reason }
// `gh` is a GitHub client ({ get(path) } → { status, json }). Any error → no mark (fail closed).

export const MARK_CONTEXT = 'orchestrate/merge-gate';
const SHA = /^[0-9a-f]{40}$/;
const CARD = /^[A-Za-z0-9._-]{1,80}$/;
const DESC = /^merged by the Merge Gate: card ([A-Za-z0-9._-]{1,80}) head ([0-9a-f]{40})$/;

export function markDescription({ card, head }) {
  if (!CARD.test(card ?? '') || !SHA.test(head ?? '')) throw new Error('a mark names a card id and a 40-hex head');
  return `merged by the Merge Gate: card ${card} head ${head}`;
}

export function parseMark(description) {
  const m = typeof description === 'string' ? DESC.exec(description) : null;
  return m ? { card: m[1], head: m[2] } : null;
}

export async function readMark({ gh, owner, repo, sha, robotBotId }) {
  const no = (reason) => ({ ok: false, reason });
  try {
    if (!SHA.test(sha ?? '')) return no('not a commit id');
    if (!Number.isInteger(robotBotId) || robotBotId <= 0) return no('no robot bot id configured');
    const base = `/repos/${owner}/${repo}`;
    const st = await gh.get(`${base}/commits/${sha}/statuses?per_page=100`);
    if (st.status !== 200 || !Array.isArray(st.json)) return no(`statuses unreadable (${st.status})`);
    if (st.json.length >= 100) return no('too many statuses to read them all');
    const marks = st.json.filter((s) => s?.context === MARK_CONTEXT && s?.creator?.id === robotBotId && s?.state === 'success');
    if (!marks.length) return no('no robot mark on this commit');
    const parsed = marks.map((s) => parseMark(s.description));
    if (parsed.some((p) => !p)) return no('a robot mark is not in the mark\'s form');
    if (new Set(parsed.map((p) => `${p.card} ${p.head}`)).size !== 1) return no('robot marks on this commit disagree');
    const { card, head } = parsed[0];
    const pulls = await gh.get(`${base}/commits/${sha}/pulls?per_page=100`);
    if (pulls.status !== 200 || !Array.isArray(pulls.json)) return no(`pull requests for the commit unreadable (${pulls.status})`);
    for (const p of pulls.json) {
      if (!Number.isInteger(p?.number)) continue;
      const full = await gh.get(`${base}/pulls/${p.number}`);
      const j = full.json;
      if (full.status !== 200 || !j) continue;
      if (j.merged === true && j.merge_commit_sha === sha && j.merged_by?.id === robotBotId && j.head?.sha === head) return { ok: true, card, head, pr: j.number };
    }
    return no('no pull request the robot merged into this commit at the marked head');
  } catch (e) { return no(`mark check failed: ${String(e?.message ?? e).slice(0, 200)}`); }
}
