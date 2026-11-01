#!/usr/bin/env node
// watch-run.mjs — the command for the watch-only week (R-0b-122). Run as the scripts' own Mac user (`orchestrate`).
//
//   node watch-run.mjs once    --repo <owner/name> --dir <folder> --token-file <file> --policy-file <file> --since <ISO time>
//   node watch-run.mjs summary --dir <folder> --end-day <YYYY-MM-DD> [--days 7]
//
// `once` is one pass (a background job runs it every hour); it writes only into --dir. It never prints the token, never
// writes to GitHub (see watch-only.mjs). `summary` is read only and exits 0 only when the week counts. Exit: 0 fine,
// 1 the week does not count / a pass had a problem, 2 usage.

import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readOnlyClient, summary, tokenFile, watchPass } from './watch-only.mjs';

const OPTS = ['--repo', '--dir', '--token-file', '--policy-file', '--since', '--end-day', '--days'];
const USAGE = 'usage: node watch-run.mjs once --repo owner/name --dir <folder> --token-file <file> --policy-file <file> --since <ISO time> | summary --dir <folder> --end-day <YYYY-MM-DD> [--days N]';

export function parseArgs(argv) {
  const cmd = argv[0];
  if (cmd !== 'once' && cmd !== 'summary') throw new Error('first word must be once or summary');
  const o = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!OPTS.includes(a)) throw new Error(`argument ${i} is not one this command takes (it is not shown, in case it is a secret)`);
    const v = argv[++i];
    if (typeof v !== 'string' || v.startsWith('--')) throw new Error(`${a} needs a value`);
    o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  const need = cmd === 'once' ? ['repo', 'dir', 'tokenFile', 'policyFile', 'since'] : ['dir', 'endDay'];
  for (const k of need) if (!o[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  if (cmd === 'once' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repo)) throw new Error('--repo must be owner/name');
  if (cmd === 'once' && Number.isNaN(Date.parse(o.since))) throw new Error('--since must be a time like 2026-11-03T00:00:00Z');
  if (cmd === 'summary' && !/^\d{4}-\d{2}-\d{2}$/.test(o.endDay)) throw new Error('--end-day must be YYYY-MM-DD');
  if (o.days !== undefined && !/^[1-9][0-9]?$/.test(o.days)) throw new Error('--days must be a small whole number');
  return o;
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), fetchFn } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  try { mkdirSync(o.dir, { recursive: true, mode: 0o700 }); } catch { err('the folder could not be made'); return 2; }
  if (o.cmd === 'summary') {
    const s = summary({ dir: o.dir, endDay: o.endDay, days: o.days ? Number(o.days) : 7 });
    out(`days: ${s.days[0]} to ${s.days.at(-1)}; days with no pass: ${s.missingDays.length ? s.missingDays.join(', ') : 'none'}`);
    out(`commits judged: ${s.judged}; would merge: ${s.wouldMerge}; disagreements with MAIN: ${s.disagreements}; unexplained: ${s.unexplained.length}; passes with a problem: ${s.failedPasses}`);
    for (const u of s.unexplained) out(`UNEXPLAINED  ${u.sha}${u.pr ? ` (pull ${u.pr})` : ' (direct push)'}: ${u.verdict}${u.refusals.length ? ` — ${u.refusals.map((r) => `${r.n}: ${r.reason}`).join('; ')}` : ''}`);
    out(s.ok ? 'THE WEEK COUNTS.' : 'THE WEEK DOES NOT COUNT YET.');
    return s.ok ? 0 : 1;
  }
  let policyText;
  try { policyText = readFileSync(o.policyFile, 'utf8'); } catch { err('the rules file could not be read'); return 2; }
  const [owner, repo] = o.repo.split('/');
  const gh = readOnlyClient({ token: tokenFile(o.tokenFile), ...(fetchFn ? { fetchFn } : {}) });
  try {
    const r = await watchPass({ gh, owner, repo, policyText, dir: o.dir, since: o.since });
    out(`judged ${r.judged} new commit(s); ${r.skipped} already in the log.`);
    for (const p of r.problems) err(`PROBLEM  ${p}`);
    return r.problems.length ? 1 : 0;
  } catch (e) { err(`stopped: ${String(e?.message ?? e).slice(0, 160)}`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
