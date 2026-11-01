#!/usr/bin/env node
// watch-run.mjs — the command for the watch-only week (R-0b-122). `once` and `summary` run as the scripts' own Mac user
// (`orchestrate`); `explain` runs as the owner's own Mac user.
//
//   node watch-run.mjs once    --repo <owner/name> --dir <folder> --token-file <file> --rules draft --rules-sha256 <64 hex>
//   node watch-run.mjs once    --repo <owner/name> --dir <folder> --token-file <file> --rules github
//   node watch-run.mjs summary --dir <folder> --end-day <YYYY-MM-DD> --explanations <file> --owner-uid <number>
//   node watch-run.mjs explain --file <file> --sha <commit> --text "<why this disagreement is fine>"
//
// `once` is one pass (a background job runs it every hour); it writes only into --dir and never writes to GitHub. The first
// pass pins main's head: nothing before it is judged. `summary` is read only (it never makes a folder) and exits 0 only when
// the week counts; days are UTC; it counts an explanation only from a file the owner's Mac user owns, in a folder only that
// user can write. Exit: 0 fine, 1 the week does not count / a pass had a problem, 2 usage.

import { chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { draftRules, githubRules, readExplanations, readOnlyClient, summary, tokenFile, watchPass } from './watch-only.mjs';

const OPTS = ['--repo', '--dir', '--token-file', '--rules', '--rules-sha256', '--end-day', '--explanations', '--owner-uid', '--file', '--sha', '--text'];
const USAGE = 'usage: node watch-run.mjs once --repo owner/name --dir <folder> --token-file <file> (--rules draft --rules-sha256 <hex> | --rules github) | summary --dir <folder> --end-day <YYYY-MM-DD> --explanations <file> --owner-uid <n> | explain --file <file> --sha <commit> --text "<why>"';
const NEED = { once: ['repo', 'dir', 'tokenFile', 'rules'], summary: ['dir', 'endDay', 'explanations', 'ownerUid'], explain: ['file', 'sha', 'text'] };

export function parseArgs(argv) {
  const cmd = argv[0];
  if (!Object.hasOwn(NEED, cmd ?? '')) throw new Error('first word must be once, summary or explain');
  const o = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!OPTS.includes(a)) throw new Error(`argument ${i} is not one this command takes (it is not shown, in case it is a secret)`);
    const v = argv[++i];
    if (typeof v !== 'string' || (v.startsWith('--') && a !== '--text')) throw new Error(`${a} needs a value`);
    o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  for (const k of NEED[cmd]) if (!o[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  if (cmd === 'once') {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(o.repo)) throw new Error('--repo must be owner/name');
    if (!['draft', 'github'].includes(o.rules)) throw new Error('--rules must be draft or github');
    if (o.rules === 'draft' && !/^[0-9a-f]{64}$/.test(o.rulesSha256 ?? '')) throw new Error('--rules draft needs --rules-sha256 (64 hex characters)');
    if (o.rules === 'github' && o.rulesSha256) throw new Error('--rules-sha256 is only for --rules draft');
  }
  if (cmd === 'summary') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.endDay) || new Date(`${o.endDay}T00:00:00Z`).toISOString().slice(0, 10) !== o.endDay) throw new Error('--end-day must be a real date, YYYY-MM-DD');
    if (!/^[0-9]{1,10}$/.test(o.ownerUid)) throw new Error('--owner-uid must be a number (the owner\'s Mac user id: run id -u as that user)');
  }
  if (cmd === 'explain' && !/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('--sha must be the full 40-character commit id');
  return o;
}

/** Adds (or replaces) one explanation, written by the user running this: atomic, mode 0644, in a folder only they can write. */
export function explain({ file, sha, text, uid = process.getuid?.() }) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const dst = statSync(dir);
  if (dst.uid !== uid || (dst.mode & 0o022) !== 0) throw new Error('that folder is not only yours: choose a folder you own that others cannot write to');
  let cur = {};
  if (existsSync(file)) { try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('the existing explanations file is damaged; move it aside first'); } if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('the existing explanations file is damaged; move it aside first'); }
  if (!text.trim()) throw new Error('the explanation is empty');
  cur[sha] = text.trim();
  const tmp = join(dir, `.explanations.${process.pid}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeFileSync(fd, `${JSON.stringify(cur, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), fetchFn, uid } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (o.cmd === 'explain') {
    try { explain({ file: o.file, sha: o.sha, text: o.text, ...(uid !== undefined ? { uid } : {}) }); out(`written: an explanation for ${o.sha.slice(0, 8)} in ${o.file}`); return 0; } catch (e) { err(`not written: ${e.message}`); return 1; }
  }
  if (o.cmd === 'summary') {
    if (!existsSync(join(o.dir, 'log.jsonl'))) { err('there is no log in that folder (no pass has run, or the folder is wrong)'); return 1; }
    const ex = readExplanations(o.explanations, { ownerUid: Number(o.ownerUid) });
    const s = summary({ dir: o.dir, endDay: o.endDay, explanations: ex });
    out(`days (UTC, by merge time): ${s.days.length ? `${s.days[0]} to ${s.days.at(-1)}` : 'none'}; window starts ${s.windowStart ?? 'never'}; days with no clean pass: ${s.missingDays.length ? s.missingDays.join(', ') : 'none'}`);
    out(`commits judged: ${s.judged}; would merge: ${s.wouldMerge}; disagreements with MAIN: ${s.disagreements}; unexplained: ${s.unexplained.length}; passes with a problem: ${s.failedPasses}`);
    out(`explanations from the file owned by user ${s.explanationsOwner ?? 'none'}${s.explanationsProblem ? ` (does not count: ${s.explanationsProblem})` : ''}`);
    for (const u of s.unexplained) out(`UNEXPLAINED  ${u.sha}${u.pr ? ` (pull ${u.pr})` : ' (direct push)'}: ${u.verdict}${u.refusals?.length ? ` — ${u.refusals.map((r) => `${r.n}: ${r.reason}`).join('; ')}` : ''}`);
    for (const r of s.reasons) out(`BECAUSE  ${r}`);
    out(s.ok ? 'THE WEEK COUNTS.' : 'THE WEEK DOES NOT COUNT YET.');
    return s.ok ? 0 : 1;
  }
  try { mkdirSync(o.dir, { recursive: true, mode: 0o700 }); } catch { err('the folder could not be made'); return 2; }
  const [owner, repo] = o.repo.split('/');
  const gh = readOnlyClient({ token: tokenFile(o.tokenFile), ...(fetchFn ? { fetchFn } : {}) });
  const rules = o.rules === 'draft' ? draftRules({ dir: o.dir, sha256: o.rulesSha256 }) : githubRules({ gh, owner, repo });
  try {
    const r = await watchPass({ gh, owner, repo, dir: o.dir, rules });
    if (r.locked) { out('another pass is running; this one did nothing.'); return 0; }
    out(`judged ${r.judged} new commit(s); ${r.skipped} already in the log.`);
    for (const p of r.problems) err(`PROBLEM  ${p}`);
    return r.problems.length ? 1 : 0;
  } catch (e) { err(`stopped: ${String(e?.message ?? e).slice(0, 160)}`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
