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
//     Round 5: a first-pass or gap latch starts when the Mini noticed, so a clear written earlier never opens it (MAT-1);
//     only a passed step resets the failed-run count, never a step it couldn't read, skipped or cancelled (MAT-2); and
//     the gap counts between the check runs the Mini saw as well as between its own passes (MAT-3).
//     Round 6 MAT-A: the clear must also be at or after the newest run whose step wasn't green (last_red_at), so a
//     clear written before a later failure never opens the gate once that failure ages out of the 7-day window.
//   - the outside repo's lock (lead call L24): the robot-merges result counts as green only when the same run's
//     "product 1 / repo-guard" step passed too (a failed guard counts as a failed run for the latch). And the Mini
//     probes each of its own tokens (checkNoPush): none may write to the outside repo; the gate needs that fact green
//     and under 2 hours old.
// Endpoint shapes assumed from GitHub's REST docs, 29 Oct 2026 (Principle 9).

export const STOPPED_MIN = 90;
export const ROBOT_GREEN_MIN = 120;
export const LATCH_RUNS = 2;
export const UNSEEN_GAP_MS = 5 * 24 * 3600e3;
export const OWNER_FILE = 'robot-merges-owner.json';
const slug = (product) => String(product).replace(/[^A-Za-z0-9_-]/g, '-');
export const ROBOT_FACT = (product) => `outside-robot-merges-${slug(product)}`;
export const NO_PUSH_FACT = 'outside-no-push';
const GUARD_STEP = 'product 1 / repo-guard';

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
  // A run whose steps couldn't be read is not marked as seen, so it counts once they can be (round 7 M-1).
  const stepsRead = Array.isArray(jobs);
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
      const rm = steps.find((x) => x.name === `${label} / robot-merges`);
      const guard = steps.find((x) => x.name === GUARD_STEP);
      // The guard and robot-merges as one result (lead call L24): a failure of either is a failure; green needs both.
      const conc = rm?.conclusion === 'failure' || guard?.conclusion === 'failure' ? 'failure'
        : rm?.conclusion === 'success' && guard?.conclusion === 'success' ? 'success'
          : rm && rm.conclusion !== 'success' ? rm.conclusion : rm ? (guard ? guard.conclusion : 'no-guard') : undefined;
      const step = rm ? { conclusion: conc } : undefined;
      const stepGreen = step?.conclusion === 'success' && ranAt !== null;
      const pinnedTag = ownerFile?.tags?.[label];
      const bound = typeof cfg?.tag === 'string' && cfg.tag !== '' && pinnedTag === cfg.tag;
      const green = stepGreen && bound;
      const prevDoc = writer.get(ROBOT_FACT(product)) ?? null;
      const prev = prevDoc?.last_green_at ?? null;
      // The latch. A new run that failed adds to red_runs; the same run seen again doesn't.
      const newRun = stepsRead && prevDoc?.run_id !== (done.id ?? null);
      const stepFailed = step?.conclusion === 'failure';
      const prevRuns = prevDoc?.red_runs ?? 0;
      const redRuns = step?.conclusion === 'success' ? 0 : stepFailed && newRun ? prevRuns + 1 : prevRuns;
      let redSince = prevDoc?.red_since ?? null;
      let latchWhy = prevDoc?.latch_reason ?? null;
      const passGap = !prevDoc || !(now() - Date.parse(prevDoc.at) <= UNSEEN_GAP_MS);
      const runGap = !!prevDoc && newRun && ranAt !== null && !(Date.parse(ranAt) - Date.parse(prevDoc.run_at) <= UNSEEN_GAP_MS);
      if (!redSince && (passGap || runGap)) {
        redSince = nowIso;
        latchWhy = !prevDoc ? 'no earlier result on this Mini' : passGap ? 'the Mini saw nothing for more than 5 days' : 'more than 5 days between outside-check runs';
      }
      if (!redSince && redRuns >= LATCH_RUNS) { redSince = ranAt ?? nowIso; latchWhy = `failed in ${redRuns} runs in a row`; }
      // The newest run whose result wasn't green (round 6 MAT-A): a clear must come after it too.
      const lastRed = !stepGreen && newRun ? ranAt ?? nowIso : prevDoc?.last_red_at ?? null;
      const cleared = Date.parse(ownerFile?.cleared?.[label]);
      if (redSince && green && Number.isFinite(cleared) && cleared >= Date.parse(redSince) && !(lastRed && cleared < Date.parse(lastRed))
        && cleared <= now() + 5 * 60e3) { redSince = null; latchWhy = null; }
      const reason = !ownerFile ? `cannot read ${OWNER_FILE}` : !bound ? 'the slot tag does not match this product' : stepGreen ? 'step passed'
        : guard?.conclusion === 'failure' ? 'the outside repo guard failed' : !guard && rm ? 'no repo-guard step in the newest run'
          : step ? `step ${step.conclusion ?? 'unfinished'}` : 'no robot-merges step in the newest run';
      const doc = { kind: 'fact.outside-robot-merges', product, label, at: nowIso,
        run_id: stepsRead ? done.id ?? null : prevDoc?.run_id ?? null, run_at: stepsRead ? ranAt : prevDoc?.run_at ?? null, green, last_green_at: green && !(Date.parse(prev) > Date.parse(ranAt)) ? ranAt : prev,
        red_runs: redRuns, red_since: redSince, latch_reason: latchWhy, last_red_at: lastRed, reason };
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
  // Two names can share a fact id ("a.b", "a-b"); the fact must be this product's (round 5 minor 4).
  if (d.product !== product) problems.push('robot-merges: the fact belongs to another product name');
  if (d.green !== true) problems.push(`robot-merges: latest result not green (${d.reason ?? 'unknown'})`);
  if (d.red_since !== null && d.red_since !== undefined) problems.push(`robot-merges: red since ${d.red_since} (${d.latch_reason ?? 'latched'}); stays shut until the owner clears it in ${OWNER_FILE}`);
  if (d.red_since === undefined) problems.push('robot-merges: fact has no latch field (written by an older version)');
  // The Mini's own tokens can't write to the outside repo (lead call L24), checked within the same 2 hours.
  let np = null;
  try { np = read(NO_PUSH_FACT); } catch { np = null; }
  const npAge = (now() - Date.parse(np?.at)) / 60e3;
  if (np?.green !== true) problems.push(`outside repo: the Mini's tokens are not shown unable to write there (${np?.reason ?? 'no check yet'})`);
  else if (!(npAge >= -5 && npAge <= ROBOT_GREEN_MIN)) problems.push(`outside repo: the no-write check is more than ${ROBOT_GREEN_MIN} min old or in the future`);
  const age = (now() - Date.parse(d.last_green_at)) / 60e3;
  if (!Number.isFinite(age)) problems.push('robot-merges: never green');
  else if (age < -5) problems.push('robot-merges: last green time is in the future');
  else if (age > ROBOT_GREEN_MIN) problems.push(`robot-merges: last green more than ${ROBOT_GREEN_MIN} min ago`);
  return { open: problems.length === 0, problems };
}

// The Mini's half of lead call L24: none of the Mini's tokens may write to the outside-check repo. tokens:
// [{ name, probe }] where probe = makeProbe(token) from the outside-check code (the name is a label, never the token).
// Writes fact outside-no-push { green, reason, at } and raises / clears one home alert. Lane 2 calls it each pass
// with every token the Mini holds (join item); with no tokens listed it is red, never green by default.
export async function checkNoPush({ tokens, repo, writer, homeAlerts, writeProbe, now = () => Date.now() }) {
  const bad = [];
  if (!Array.isArray(tokens) || !tokens.length) bad.push('no tokens listed');
  else for (const t of tokens) {
    const r = await writeProbe(t?.probe, repo);
    if (r !== 'no-write') bad.push(`${String(t?.name ?? 'unnamed').replace(/[^A-Za-z0-9 _-]/g, '')} answered ${r}`);
  }
  const green = bad.length === 0;
  const reason = green ? 'no Mini token can write there' : bad.join('; ');
  writer.put(NO_PUSH_FACT, { kind: 'fact.outside-no-push', green, reason, at: new Date(now()).toISOString() });
  const key = 'outside-check|mini-token-can-write|github';
  return green ? homeAlerts.clear({ key, note: 'No Mini token can write to the outside-check repo.' })
    : homeAlerts.raise({ key, title: 'A Mini token may be able to change the outside check',
      body: `The Mini probed its tokens against the outside-check repo: ${reason}. Until each reads "no-write", the Merge Gate stays shut.`, status: 'can-write' });
}
