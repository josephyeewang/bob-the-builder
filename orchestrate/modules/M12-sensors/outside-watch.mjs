// outside-watch.mjs — the Sensors' 10-minute watch that the hourly outside check keeps running (R-0b-72; review-0b-7
// M9, M10 and minors). Each check guards the other: the outside check notices a dead Mini, this notices a dead check.
//
// It reads the outside-check repo's PUBLIC run list (no key needed) and:
//   - outside-check-stopped: the newest scheduled run started more than 90 minutes ago (or there is none) → one alert
//     in the home repo (private config: the first-cutover product's repo). 90 = the hourly schedule plus GitHub's
//     usual schedule delay; so a stopped check is noticed within ~2 h. Cleared when a fresh run appears.
//   - a failing step: for the newest finished run, every step named "product N / <check>" that failed → one robot
//     issue in product N's repo (alerts.mjs, one updated issue per step); a step that passed clears its issue.
//   - robot-merges last-green fact (lead calls L19, L20): for each product named in productNames, the newest finished
//     run's "product N / robot-merges" step → fact outside-robot-merges-<product> { green, last_green_at }. A missing or
//     failed step writes green:false and keeps the earlier last_green_at. The Merge Gate asks robotMergesGreen(), the
//     one place that decides it: open only when the latest result is green and last_green_at is at most 2 h old.
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9).

export const STOPPED_MIN = 90;
export const ROBOT_GREEN_MIN = 120;
const slug = (product) => String(product).replace(/[^A-Za-z0-9_-]/g, '-');
export const ROBOT_FACT = (product) => `outside-robot-merges-${slug(product)}`;

// fetchJson(path) → JSON (public GitHub API, unauthenticated). homeAlerts: alerts.mjs for the home repo.
// productAlerts: { 'product 1': alerts, … } from private config. writer: makeFactWriter(rec); productNames:
// { 'product 1': '<product>' } from private config (the same slot order as the PRODUCTS secret).
export async function watchOutside({ fetchJson, repo, workflow = 'outside-check.yml', homeAlerts, productAlerts, writer, productNames = {}, now = () => Date.now() }) {
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
  let jobs;
  try { jobs = (await fetchJson(`/repos/${repo}/actions/runs/${done.id}/jobs?per_page=10`)).jobs; } catch { jobs = undefined; }
  const jobsKey = 'outside-check|watch-cannot-read-steps|github';
  if (!Array.isArray(jobs)) {
    out.push(['cannot-read-steps', await homeAlerts.raise({ key: jobsKey, title: 'The Mini cannot read the outside check\'s steps',
      body: 'Reading the newest outside-check run\'s steps failed, so which checks pass is unknown until it can.', status: 'cannot-read' })]);
    jobs = [];
  } else out.push(['cannot-read-steps', await homeAlerts.clear({ key: jobsKey, note: 'The Mini can read the outside check\'s steps again.' })]);
  const steps = jobs.flatMap((j) => j.steps ?? []);
  // A run that didn't finish green (timed out, cancelled) → one home alert; its missing or skipped steps are not passes
  // (round 3 minor 5). Product steps only raise on "failure" and clear on "success" below.
  const runKey = 'outside-check|run-not-green|schedule';
  if (done.conclusion && done.conclusion !== 'success' && done.conclusion !== 'failure') {
    out.push(['run-not-green', await homeAlerts.raise({ key: runKey, title: 'The newest outside-check run did not finish',
      body: `The newest scheduled outside-check run ended "${String(done.conclusion).replace(/[^a-z_]/g, '')}", so some checks did not run.`, status: 'not-finished' })]);
  } else if (done.conclusion) out.push(['run-not-green', await homeAlerts.clear({ key: runKey, note: 'The outside check finished a run again.' })]);
  if (writer) {
    const ranAt = Number.isFinite(Date.parse(done.created_at)) ? new Date(Date.parse(done.created_at)).toISOString() : null;
    for (const [label, product] of Object.entries(productNames)) {
      const step = steps.find((x) => x.name === `${label} / robot-merges`);
      const green = step?.conclusion === 'success' && ranAt !== null;
      const prev = writer.get(ROBOT_FACT(product))?.last_green_at ?? null;
      const doc = { kind: 'fact.outside-robot-merges', product, label, at: new Date(now()).toISOString(), run_id: done.id ?? null,
        run_at: ranAt, green, last_green_at: green && !(Date.parse(prev) > Date.parse(ranAt)) ? ranAt : prev,
        reason: green ? 'step passed' : step ? `step ${step.conclusion ?? 'unfinished'}` : 'no robot-merges step in the newest run' };
      out.push([`${label} / robot-merges fact`, writer.put(ROBOT_FACT(product), doc)]);
    }
  }
  for (const step of steps) {
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

// read(id) → the fact's doc or null, e.g. (id) => rec.read('fact', id)?.doc. Never throws.
export function robotMergesGreen({ read, product, now = () => Date.now() }) {
  let d = null;
  try { d = read(ROBOT_FACT(product)); } catch { d = null; }
  if (!d) return { open: false, problems: ['robot-merges: no fact yet'] };
  const problems = [];
  if (d.green !== true) problems.push(`robot-merges: latest result not green (${d.reason ?? 'unknown'})`);
  const age = (now() - Date.parse(d.last_green_at)) / 60e3;
  if (!Number.isFinite(age)) problems.push('robot-merges: never green');
  else if (age < -5) problems.push('robot-merges: last green time is in the future');
  else if (age > ROBOT_GREEN_MIN) problems.push(`robot-merges: last green more than ${ROBOT_GREEN_MIN} min ago`);
  return { open: problems.length === 0, problems };
}
