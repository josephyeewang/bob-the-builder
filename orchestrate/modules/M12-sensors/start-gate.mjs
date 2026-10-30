// start-gate.mjs — the two Vercel facts lane 2's launcher (M4) needs before it starts work on a product (lead call L3).
//
//   (3) start-gate-skip-<p>  Vercel's build-skip ("ignored build step") command equals the pinned one exactly.
//   (4) start-gate-env-<p>   no environment variable is set for both Preview and Production (one entry targeting both,
//                            or two entries with the same name). Only names are read, never values (vercel-reader.mjs).
//
// Each pass writes both facts. A failed read writes result:false with a reason, so an old result:true never stands in
// for a read that didn't happen. The shape is lane 2's contract (M4-workshop/git/start-gate.mjs factId): id
// `start_gate.vercel_skip.<product>` / `start_gate.vercel_env.<product>`, doc { product, vercel_project, read_at, result }
// plus our extra fields, which M4 ignores. vercel_project must equal the product's rules value. M4's startGate is the
// one place the gate is decided, and it treats a fact older than 10 minutes as shut, so the Sensors re-read these at
// least every 5 minutes (START_GATE_READ_EVERY_MIN). startGateOpen below is a test helper that mirrors M4's reading;
// nothing gates on it. The pinned command comes from the product's rules entry (lane 1); only hashes are stored.

import { createHash } from 'node:crypto';

export const START_GATE_FRESH_MIN = 10;
export const START_GATE_READ_EVERY_MIN = 5;
export const SKIP_FACT = (product) => `start_gate.vercel_skip.${product}`;
export const ENV_FACT = (product) => `start_gate.vercel_env.${product}`;
const sha = (s) => (typeof s === 'string' ? createHash('sha256').update(s).digest('hex') : null);

export function envInBoth(envs) {
  const targets = new Map();
  for (const e of envs) {
    const t = targets.get(e.key) ?? new Set();
    for (const x of e.target ?? []) t.add(String(x).toLowerCase());
    targets.set(e.key, t);
  }
  return [...targets].filter(([, t]) => t.has('preview') && t.has('production')).map(([k]) => k).sort();
}

// vercel: makeVercelReader(...); writer: makeFactWriter(rec); pinnedSkip and vercelProject: the rules entry's values.
export async function readStartGate({ product, vercel, writer, pinnedSkip, vercelProject, now = () => new Date() }) {
  const at = now().toISOString();
  let skip;
  try {
    const s = await vercel.settings();
    const cmd = s?.commandForIgnoringBuildStep;
    if (typeof pinnedSkip !== 'string' || !pinnedSkip) skip = { ok: false, reason: 'no pinned skip command in the rules entry' };
    else if (typeof cmd !== 'string' || !cmd) skip = { ok: false, reason: 'Vercel has no skip command set' };
    else skip = { ok: cmd === pinnedSkip, reason: cmd === pinnedSkip ? 'matches pinned' : 'differs from pinned' };
    skip.command_sha256 = sha(cmd);
  } catch { skip = { ok: false, reason: 'could not read the Vercel project settings', command_sha256: null }; }
  skip.pinned_sha256 = sha(pinnedSkip);
  let env;
  try {
    const list = await vercel.envMeta();
    if (!Array.isArray(list) || list.some((e) => !e || typeof e.key !== 'string' || !Array.isArray(e.target))) env = { ok: false, reason: 'Vercel env list in an unknown shape', both: null };
    else { const both = envInBoth(list); env = { ok: both.length === 0, reason: both.length ? `${both.length} set in both` : 'none in both', both }; }
  } catch { env = { ok: false, reason: 'could not read the Vercel env list', both: null }; }
  // M4 reads `result`; `reason` and the rest are ours. No project in the rules entry -> both results false.
  const noProject = typeof vercelProject !== 'string' || !vercelProject;
  const doc = (head, { ok, ...rest }) => ({ ...head, product, vercel_project: noProject ? null : vercelProject, read_at: at,
    result: ok === true && !noProject, ...rest, ...(noProject ? { reason: 'no Vercel project in the rules entry' } : {}) });
  const skipDoc = doc({ kind: 'fact.start-gate-skip' }, skip);
  const envDoc = doc({ kind: 'fact.start-gate-env' }, env);
  const w1 = writer.put(SKIP_FACT(product), skipDoc);
  const w2 = writer.put(ENV_FACT(product), envDoc);
  return { skip: skipDoc, env: envDoc, written: !!(w1?.ok && w2?.ok) };
}

// Test helper only (lane 2: M4's startGate is the one gate). read(id) → the fact's doc or null. Never throws.
export function startGateOpen({ read, product, vercelProject, now = () => Date.now() }) {
  const problems = [];
  const t = typeof now() === 'number' ? now() : Date.parse(now());
  for (const [name, id] of [['skip command', SKIP_FACT(product)], ['preview/production env', ENV_FACT(product)]]) {
    let d = null;
    try { d = read(id); } catch { d = null; }
    if (!d) { problems.push(`${name}: no fact yet`); continue; }
    // Two names can share a fact id ("a.b", "a-b"); the fact must be this product's (0b-7 audit round 8 minor 1).
    if (d.product !== product) problems.push(`${name}: the fact belongs to another product name`);
    if (vercelProject !== undefined && d.vercel_project !== vercelProject) problems.push(`${name}: the fact is for another Vercel project`);
    const age = (t - Date.parse(d.read_at)) / 60000;
    if (!Number.isFinite(age)) problems.push(`${name}: no readable time`);
    else if (age < -5) problems.push(`${name}: time is in the future`);
    else if (age > START_GATE_FRESH_MIN) problems.push(`${name}: older than ${START_GATE_FRESH_MIN} min`);
    if (d.result !== true) problems.push(`${name}: ${d.reason ?? 'not ok'}`);
  }
  return { open: problems.length === 0, problems };
}
