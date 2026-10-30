// outside-watch.mjs — the Sensors' 10-minute watch that the hourly outside check keeps running (R-0b-72; review-0b-7
// M9, M10 and minors). Each check guards the other: the outside check notices a dead Mini, this notices a dead check.
//
// It reads the outside-check repo's PUBLIC run list (no key needed) and:
//   - outside-check-stopped: the newest scheduled run started more than 90 minutes ago (or there is none) → one alert
//     in the home repo (private config: the first-cutover product's repo). 90 = the hourly schedule plus GitHub's
//     usual schedule delay; so a stopped check is noticed within ~2 h. Cleared when a fresh run appears.
//   - a failing step: for the newest finished run, every step named "product N / <check>" that failed → one robot
//     issue in product N's repo (alerts.mjs, one updated issue per step); a step that passed clears its issue.
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9).

export const STOPPED_MIN = 90;

// fetchJson(path) → JSON (public GitHub API, unauthenticated). homeAlerts: alerts.mjs for the home repo.
// productAlerts: { 'product 1': alerts, … } from private config.
export async function watchOutside({ fetchJson, repo, workflow = 'outside-check.yml', homeAlerts, productAlerts, now = () => Date.now() }) {
  const out = [];
  const readKey = 'outside-check|watch-cannot-read|github';
  let runs;
  try {
    runs = (await fetchJson(`/repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&per_page=10`)).workflow_runs ?? [];
  } catch (e) {
    out.push(['cannot-read', await homeAlerts.raise({ key: readKey, title: 'The Mini cannot read the outside check\'s runs',
      body: `Reading the outside-check repo's runs failed${Number.isInteger(e?.status) ? ` (HTTP ${e.status})` : ''}. Whether the outside check still runs is unknown until it can.`, status: 'cannot-read' })]);
    return out;
  }
  out.push(['cannot-read', await homeAlerts.clear({ key: readKey, note: 'The Mini can read the outside check\'s runs again.' })]);
  const newest = runs.map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const age = newest === undefined ? Infinity : Math.round((now() - newest) / 60e3);
  const stoppedKey = 'outside-check|stopped|schedule';
  if (age > STOPPED_MIN) {
    out.push(['stopped', await homeAlerts.raise({ key: stoppedKey, title: 'The hourly outside check has stopped running',
      body: newest === undefined ? 'The outside-check repo shows no scheduled run at all.' : `The newest scheduled outside-check run started ${age} minutes ago (more than ${STOPPED_MIN}). Open the outside-check repo's Actions tab: the schedule may be switched off.`,
      status: newest === undefined ? 'no-runs' : 'stopped' })]);
  } else {
    out.push(['stopped', await homeAlerts.clear({ key: stoppedKey, note: 'The outside check is running again.' })]);
  }

  const done = runs.filter((r) => r.status === 'completed').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!done) return out;
  const jobs = (await fetchJson(`/repos/${repo}/actions/runs/${done.id}/jobs?per_page=10`)).jobs ?? [];
  for (const step of jobs.flatMap((j) => j.steps ?? [])) {
    const m = /^(product \d+) \/ ([a-z-]+)$/.exec(step.name ?? '');
    if (!m || !productAlerts[m[1]]) continue;
    const [, label, check] = m;
    const key = `${label}|outside-check|${check}`;
    if (step.conclusion === 'failure') {
      out.push([step.name, await productAlerts[label].raise({ key, title: `Outside check failing: ${check}`,
        body: `The hourly outside check's step "${step.name}" failed. Its reason code is in that run's log in the outside-check repo.` })]);
    } else if (step.conclusion === 'success') {
      out.push([step.name, await productAlerts[label].clear({ key, note: 'The outside check passes again.' })]);
    }
  }
  return out;
}
