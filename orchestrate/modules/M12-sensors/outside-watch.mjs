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
//   - slot binding (0b-7 audit round 4 M-2): the step counts only when the slot's tag in the outside repo's public
//     robot-merges-owner.json equals the tag private config gives for that product, so swapped or stale slot names
//     can't open one product's gate on another's green.
//   - latch (round 4 M-3): the check reads 7 days back, so an unacknowledged bad merge would pass again by itself.
//     A robot-merges step failing in 2 runs in a row, or a gap of more than 5 days in what the Mini saw (or no earlier
//     fact), sets red_since; the gate stays shut until the owner writes a "cleared" time at or after red_since for
//     that slot in robot-merges-owner.json (and the step is green). One failed run alone (a GitHub blip) doesn't latch.
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9).

export const STOPPED_MIN = 90;
export const ROBOT_GREEN_MIN = 120;
export const LATCH_RUNS = 2;
export const UNSEEN_GAP_MS = 5 * 24 * 3600e3;
export const OWNER_FILE = 'robot-merges-owner.json';
const slug = (product) => String(product).replace(/[^A-Za-z0-9_-]/g, '-');
export const ROBOT_FACT = (product) => `outside-robot-merges-${slug(product)}`;

// fetchJson(path) → JSON (public GitHub API, unauthenticated). homeAlerts: alerts.mjs for the home repo.
// productAlerts: { 'product 1': alerts, … } from private config. writer: makeFactWriter(rec); productNames:
// { 'product 1': { product: '<product>', tag: '<slot tag>' } } from private config (the same slots and tags as the
// PRODUCTS secret).
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
  if (writer && Object.keys(productNames).length) {
    const ranAt = Number.isFinite(Date.parse(done.created_at)) ? new Date(Date.parse(done.created_at)).toISOString() : null;
    let ownerFile = null;
    try {
      const c = await fetchJson(`/repos/${repo}/contents/${OWNER_FILE}`);
      ownerFile = JSON.parse(Buffer.from(String(c?.content ?? ''), 'base64').toString('utf8'));
      if (!ownerFile || typeof ownerFile !== 'object') ownerFile = null;
    } catch { ownerFile = null; }
    const nowIso = new Date(now()).toISOString();
    for (const [label, cfg] of Object.entries(productNames)) {
      const product = typeof cfg === 'object' && cfg ? cfg.product : cfg;
      const step = steps.find((x) => x.name === `${label} / robot-merges`);
      const stepGreen = step?.conclusion === 'success' && ranAt !== null;
      const pinnedTag = ownerFile?.tags?.[label];
      const bound = typeof cfg?.tag === 'string' && cfg.tag !== '' && pinnedTag === cfg.tag;
      const green = stepGreen && bound;
      const prevDoc = writer.get(ROBOT_FACT(product)) ?? null;
      const prev = prevDoc?.last_green_at ?? null;
      // The latch. A new run that failed adds to red_runs; the same run seen again doesn't.
      const newRun = prevDoc?.run_id !== (done.id ?? null);
      const stepFailed = step?.conclusion === 'failure';
      const redRuns = stepFailed ? (newRun ? (prevDoc?.red_runs ?? 0) + 1 : (prevDoc?.red_runs ?? 0)) : 0;
      let redSince = prevDoc?.red_since ?? null;
      let latchWhy = prevDoc?.latch_reason ?? null;
      const gap = !prevDoc || !(now() - Date.parse(prevDoc.at) <= UNSEEN_GAP_MS);
      if (!redSince && gap) { redSince = prevDoc?.at && Number.isFinite(Date.parse(prevDoc.at)) ? new Date(Date.parse(prevDoc.at)).toISOString() : '1970-01-01T00:00:00.000Z'; latchWhy = prevDoc ? 'the Mini saw nothing for more than 5 days' : 'no earlier result on this Mini'; }
      if (!redSince && redRuns >= LATCH_RUNS) { redSince = ranAt ?? nowIso; latchWhy = `failed in ${redRuns} runs in a row`; }
      const cleared = Date.parse(ownerFile?.cleared?.[label]);
      if (redSince && green && Number.isFinite(cleared) && cleared >= Date.parse(redSince) && cleared <= now() + 5 * 60e3) { redSince = null; latchWhy = null; }
      const reason = !ownerFile ? `cannot read ${OWNER_FILE}` : !bound ? 'the slot tag does not match this product' : stepGreen ? 'step passed'
        : step ? `step ${step.conclusion ?? 'unfinished'}` : 'no robot-merges step in the newest run';
      const doc = { kind: 'fact.outside-robot-merges', product, label, at: nowIso, run_id: done.id ?? null,
        run_at: ranAt, green, last_green_at: green && !(Date.parse(prev) > Date.parse(ranAt)) ? ranAt : prev,
        red_runs: redRuns, red_since: redSince, latch_reason: latchWhy, reason };
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
  if (d.red_since !== null && d.red_since !== undefined) problems.push(`robot-merges: red since ${d.red_since} (${d.latch_reason ?? 'latched'}); stays shut until the owner clears it in ${OWNER_FILE}`);
  if (d.red_since === undefined) problems.push('robot-merges: fact has no latch field (written by an older version)');
  const age = (now() - Date.parse(d.last_green_at)) / 60e3;
  if (!Number.isFinite(age)) problems.push('robot-merges: never green');
  else if (age < -5) problems.push('robot-merges: last green time is in the future');
  else if (age > ROBOT_GREEN_MIN) problems.push(`robot-merges: last green more than ${ROBOT_GREEN_MIN} min ago`);
  return { open: problems.length === 0, problems };
}
