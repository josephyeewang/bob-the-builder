#!/usr/bin/env node
// run-claim.mjs — "a duplicate run must be harmless," in code (templates/scheduled-work-protocol.md §3).
//
// Adapted from markfulton/ai-employees @ 020feb3d74d96c13243db53403a71c9705c231b3
// (shared/work-cycle/run-state.mjs, plus its 8-line `inside()` path helper from work-cycle.mjs),
// MIT, Copyright (c) 2026 Mark Fulton — licence in third_party/ai-employees/LICENSE.
// Changed for Bob by Joe Wang, 2026-10-27: helper inlined (no other files needed), "routine/lease"
// renamed "job/claim", claim files moved to state/run-claims/, and a `claim` command added to the
// command line (the original only had `finish`). The claim/finish logic and the self-test are theirs.
//
// What it does, in plain English. A scheduled job calls `claim` first, keyed to the PERIOD it is
// for (2026-10-27, 2026-W44), not to "now":
//   - Nobody has claimed this period          -> go, with the full time budget.
//   - This period is already finished         -> stop: a double fire does nothing.
//   - Another run holds a live claim          -> stop.
//   - A run crashed holding the claim         -> its claim EXPIRES at its deadline, then the next
//                                               run may go (a crash never blocks forever).
//   - A run stopped part-way ("partial")      -> the next run RESUMES with only the time left.
//   - Two runs fire at the same instant       -> only one can create the lock file; the other stops.
// When the job ends it calls `finish` with the token it was given (completed or partial).
//
// Usage (Node 18+, nothing to install):
//   node run-claim.mjs claim  --job nightly-report --period 2026-10-27 --budget-minutes 20 [--root DIR]
//        -> prints JSON; exit 0 = go (save the "token"), exit 3 = do not run (reason in the JSON)
//   node run-claim.mjs finish --job nightly-report --token TOKEN --status completed|partial [--root DIR]
//   node run-claim.mjs --selftest
// --root is the folder that holds state/run-claims/ (default: the current folder).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// From work-cycle.mjs: resolve a relative path and refuse anything that escapes `root`.
function inside(root, rel) {
  const text = (x) => typeof x === 'string' && x.trim().length > 0;
  if (!(text(rel) && !path.isAbsolute(rel) && !rel.includes('\\') && !rel.split('/').includes('..'))) throw new Error('Use a relative path inside the root');
  const resolved = path.resolve(root, rel), base = fs.realpathSync(root);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escapes root');
  let parent = resolved;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  if (!(real === base || real.startsWith(base + path.sep))) throw new Error('Linked path escapes root');
  return resolved;
}

function claimPath(root, id) {
  if (!/^[a-z][a-z0-9-]+$/.test(id)) throw new Error('Invalid job id (use lower-case letters, digits and dashes)');
  return inside(root, `state/run-claims/${id}.json`);
}
export function readClaim(root, id) {
  const p = claimPath(root, id);
  if (!fs.existsSync(p)) return null;
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (c.schema !== 1 || c.job !== id || typeof c.period !== 'string' || typeof c.token !== 'string' || !['in-progress', 'completed', 'partial'].includes(c.status) || ![c.started, c.deadline, c.spent_ms, c.budget_ms].every(Number.isFinite) || c.spent_ms < 0 || c.budget_ms <= 0 || c.deadline < c.started) throw new Error('Invalid run claim; preserve it and investigate');
  return c;
}
export function inspectClaim(root, id, period, budgetMinutes, now = Date.now()) {
  const c = readClaim(root, id), budget = budgetMinutes * 60000;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid time budget');
  if (!c) return { allowed: true, resume: false, remaining_ms: budget };
  if (c.status === 'in-progress' && now < c.deadline) return { allowed: false, reason: 'another claim is active', claim: c };
  if (c.period !== period) return { allowed: true, resume: false, remaining_ms: budget, previous_incomplete: c.status !== 'completed' };
  if (c.status === 'completed') return { allowed: false, reason: 'period completed', claim: c };
  const spent = c.status === 'in-progress' ? budget : c.spent_ms;   // a crashed run is charged its whole budget
  const remaining = Math.max(0, budget - spent);
  return remaining > 0 ? { allowed: true, resume: true, remaining_ms: remaining } : { allowed: false, reason: 'period budget exhausted; pick up unfinished work next period', claim: c };
}
export function claimRun(root, id, period, budgetMinutes, now = Date.now()) {
  const p = claimPath(root, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lock = p + '.claim';
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') return { allowed: false, reason: 'claim transaction busy; inspect an orphaned .claim file before removing it' }; throw e; }
  try {
    const check = inspectClaim(root, id, period, budgetMinutes, now);
    if (!check.allowed) return check;
    const c = { schema: 1, job: id, period, token: crypto.randomUUID(), status: 'in-progress', started: now, deadline: now + check.remaining_ms, spent_ms: budgetMinutes * 60000 - check.remaining_ms, budget_ms: budgetMinutes * 60000 };
    const tmp = p + '.' + c.token;
    fs.writeFileSync(tmp, JSON.stringify(c) + '\n', { flag: 'wx' }); fs.renameSync(tmp, p);
    return { ...check, token: c.token, deadline: c.deadline };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function finishRun(root, id, token, status, now = Date.now()) {
  if (!['completed', 'partial'].includes(status)) throw new Error('Finish status must be completed or partial');
  const p = claimPath(root, id), lock = p + '.claim';
  const fd = fs.openSync(lock, 'wx');
  try {
    const c = readClaim(root, id);
    if (!c || c.token !== token || c.status !== 'in-progress') throw new Error('Only the current claim owner may finish');
    c.spent_ms = Math.min(c.budget_ms, c.spent_ms + Math.max(0, now - c.started));
    c.status = status; c.finished = now;
    const tmp = p + '.' + token;
    fs.writeFileSync(tmp, JSON.stringify(c) + '\n', { flag: 'wx' }); fs.renameSync(tmp, p);
    return c;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-claim-'));
  try {
    const first = claimRun(root, 'test-run', 'p1', 10, 1000);
    assert.equal(first.allowed, true);
    assert.equal(claimRun(root, 'test-run', 'p1', 10, 1001).allowed, false);                 // live claim blocks a second run
    assert.throws(() => finishRun(root, 'test-run', 'wrong', 'completed', 2000));             // only the owner may finish
    finishRun(root, 'test-run', first.token, 'partial', 61000);
    const resumed = claimRun(root, 'test-run', 'p1', 10, 62000);
    assert.equal(resumed.resume, true); assert.equal(resumed.remaining_ms, 540000);           // resume with time left
    finishRun(root, 'test-run', resumed.token, 'completed', 63000);
    assert.equal(claimRun(root, 'test-run', 'p1', 10, 64000).allowed, false);                 // finished period: no-op
    const next = claimRun(root, 'test-run', 'p2', 10, 65000);
    assert.equal(next.allowed, true);
    assert.equal(claimRun(root, 'test-run', 'p2', 10, next.deadline + 1).allowed, false);     // crashed run's period is spent
    assert.equal(claimRun(root, 'test-run', 'p3', 10, next.deadline + 2).allowed, true);      // ...but it never blocks the next period
    fs.writeFileSync(path.join(root, 'state/run-claims/race.json.claim'), '');                 // simultaneous fire: lock already held
    assert.equal(claimRun(root, 'race', 'p1', 10, 1000).allowed, false);
    assert.throws(() => readClaim(root, '../outside'));
    console.log('run-claim: selftest PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), value = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
    const root = path.resolve(value('--root') || '.');
    if (args.includes('--selftest')) selftest();
    else if (args[0] === 'claim') {
      if (!value('--period')) throw new Error('claim needs --period (e.g. 2026-10-27 or 2026-W44)');
      const r = claimRun(root, value('--job'), value('--period'), Number(value('--budget-minutes')));
      if (r.claim) delete r.claim.token;   // a refused run must not learn the owner's token
      console.log(JSON.stringify(r));
      if (!r.allowed) process.exitCode = 3;
    } else if (args[0] === 'finish') {
      console.log(JSON.stringify(finishRun(root, value('--job'), value('--token'), value('--status'))));
    } else throw new Error('Usage: run-claim.mjs claim --job ID --period P --budget-minutes N [--root DIR] | finish --job ID --token T --status completed|partial [--root DIR] | --selftest');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
