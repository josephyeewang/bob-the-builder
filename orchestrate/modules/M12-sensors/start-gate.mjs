// start-gate.mjs — the two Vercel facts lane 2's launcher (M4) needs before it starts work on a product (lead call L3).
//
//   (3) start-gate-skip-<p>  Vercel's build-skip ("ignored build step") command equals the pinned one exactly.
//   (4) start-gate-env-<p>   no environment variable is set for both Preview and Production (one entry targeting both,
//                            or two entries with the same name). Only names are read, never values (vercel-reader.mjs).
//
// Each pass writes both facts with a time stamp. A failed read writes ok:false with a reason, so an old ok:true never
// stands in for a read that didn't happen. M4 only reads: startGateOpen() is the one place the gate is decided, open
// only when both facts say ok:true and are at most START_GATE_FRESH_MIN old. The pinned command comes from the
// product's rules entry (lane 1); the command itself is not stored, only hashes of it and of the pinned one.

import { createHash } from 'node:crypto';

export const START_GATE_FRESH_MIN = 120;
const slug = (product) => String(product).replace(/[^A-Za-z0-9_-]/g, '-');
export const SKIP_FACT = (product) => `start-gate-skip-${slug(product)}`;
export const ENV_FACT = (product) => `start-gate-env-${slug(product)}`;
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

// vercel: makeVercelReader(...); writer: makeFactWriter(rec); pinnedSkip: the rules entry's command (string).
export async function readStartGate({ product, vercel, writer, pinnedSkip, now = () => new Date() }) {
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
  const skipDoc = { kind: 'fact.start-gate-skip', product, at, ...skip };
  const envDoc = { kind: 'fact.start-gate-env', product, at, ...env };
  const w1 = writer.put(SKIP_FACT(product), skipDoc);
  const w2 = writer.put(ENV_FACT(product), envDoc);
  return { skip: skipDoc, env: envDoc, written: !!(w1?.ok && w2?.ok) };
}

// read(id) → the fact's doc or null, e.g. (id) => rec.read('fact', id)?.doc. Never throws.
export function startGateOpen({ read, product, now = () => Date.now() }) {
  const problems = [];
  const t = typeof now() === 'number' ? now() : Date.parse(now());
  for (const [name, id] of [['skip command', SKIP_FACT(product)], ['preview/production env', ENV_FACT(product)]]) {
    let d = null;
    try { d = read(id); } catch { d = null; }
    if (!d) { problems.push(`${name}: no fact yet`); continue; }
    const age = (t - Date.parse(d.at)) / 60000;
    if (!Number.isFinite(age)) problems.push(`${name}: no readable time`);
    else if (age < -5) problems.push(`${name}: time is in the future`);
    else if (age > START_GATE_FRESH_MIN) problems.push(`${name}: older than ${START_GATE_FRESH_MIN} min`);
    if (d.ok !== true) problems.push(`${name}: ${d.reason ?? 'not ok'}`);
  }
  return { open: problems.length === 0, problems };
}
