#!/usr/bin/env node
// watch-run.mjs — the command for the watch-only week (R-0b-122). `once` and `summary` run as the scripts' own Mac user
// (`orchestrate`); `explain` runs as the owner's own Mac user.
//
//   node watch-run.mjs once    --repo <owner/name> --dir <folder> --token-file <file> --rules draft --rules-sha256 <64 hex>
//   node watch-run.mjs once    --repo <owner/name> --dir <folder> --token-file <file> --rules github
//        once also takes, all three or none: --app-id <id> --app-installation <id> --app-key-file <full path>
//   node watch-run.mjs summary --dir <folder> --end-day <YYYY-MM-DD> --explanations <file> --owner-uid <number>
//   node watch-run.mjs explain --file <file> --sha <commit> --text "<why this disagreement is fine>"
//   node watch-run.mjs checks  --repo <owner/name> --sha <commit> --app-id <id> --app-installation <id> --app-key-file <full path>
//
// `checks` is setup's proof of the one read the job makes with the App's token (L707 M1): run as `orchestrate` by
// `setup.mjs prove-token`, it mints the App's token the way `once` does (the same function) and reads the check runs at
// <commit> the job's way, then prints one JSON line: { ok, stage: 'mint' | 'read', reason? | kind?, status?, said? }. Never the
// token. Exit 0 read, 1 not.
//
// `once` is one pass (a background job runs it every hour); it writes only into --dir and never writes to GitHub. The first
// pass pins main's head: nothing before it is judged. `summary` is read only (it never makes a folder) and exits 0 only when
// the week counts; days are UTC; it counts an explanation only from a file the owner's Mac user owns, in a folder only that
// user can write. Exit: 0 fine, 1 the week does not count / a pass had a problem, 2 usage.
//
// CHECK RUNS (L624). The fine-grained token can't read check runs (GitHub has no Checks permission for it), so each
// `once` mints the robot App's installation token through token.mjs, as the scripts' own Mac user, from the --app-*
// arguments, and reads check runs with it in a client that takes only GET /repos/<owner>/<repo>/commits/<sha>/check-runs
// (L631 Minor 3); anything else is refused before it reaches GitHub. The token lives in memory for the
// pass. With no App arguments, or a mint that fails, the check runs are not known: the pass says so and exits 1, and
// that pass is not clean, so the week cannot count. Never a classic token, and never the fine-grained one for checks.

import { chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRepoName } from '../../setup/layout.mjs';
import { CHECKS_NOT_KNOWN, draftRules, githubRules, proveChecksRead, readExplanations, readOnlyClient, summary, tokenFile, watchPass } from './watch-only.mjs';
import { mintInstallationToken } from './token.mjs';

const OPTS = ['--repo', '--dir', '--token-file', '--rules', '--rules-sha256', '--app-id', '--app-installation', '--app-key-file', '--end-day', '--explanations', '--owner-uid', '--file', '--sha', '--text'];
const USAGE = 'usage: node watch-run.mjs once --repo owner/name --dir <folder> --token-file <file> (--rules draft --rules-sha256 <hex> | --rules github) [--app-id <id> --app-installation <id> --app-key-file <full path>] | summary --dir <folder> --end-day <YYYY-MM-DD> --explanations <file> --owner-uid <n> | explain --file <file> --sha <commit> --text "<why>" | checks --repo owner/name --sha <commit> --app-id <id> --app-installation <id> --app-key-file <full path>';
const NEED = { once: ['repo', 'dir', 'tokenFile', 'rules'], summary: ['dir', 'endDay', 'explanations', 'ownerUid'], explain: ['file', 'sha', 'text'], checks: ['repo', 'sha', 'appId', 'appInstallation', 'appKeyFile'] };

export function parseArgs(argv) {
  const cmd = argv[0];
  if (!Object.hasOwn(NEED, cmd ?? '')) throw new Error('first word must be once, summary, explain or checks');
  const o = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!OPTS.includes(a)) throw new Error(`argument ${i} is not one this command takes (it is not shown, in case it is a secret)`);
    const v = argv[++i];
    if (typeof v !== 'string' || (v.startsWith('--') && a !== '--text')) throw new Error(`${a} needs a value`);
    o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  for (const k of NEED[cmd]) if (!o[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  if (cmd === 'once' || cmd === 'checks') {
    if (!isRepoName(o.repo)) throw new Error('--repo must be owner/name');   // the one owner/name check, shared with the setup's config and print-config-line (L203 m-B)
  }
  if (cmd === 'checks') {
    for (const k of ['dir', 'tokenFile', 'rules', 'rulesSha256', 'endDay', 'explanations', 'ownerUid', 'file', 'text']) if (o[k] !== undefined) throw new Error('checks takes only --repo, --sha and the three --app-* arguments');
    if (!/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('--sha must be the full 40-character commit id');
  }
  if (cmd === 'once') {
    if (!['draft', 'github'].includes(o.rules)) throw new Error('--rules must be draft or github');
    if (o.rules === 'draft' && !/^[0-9a-f]{64}$/.test(o.rulesSha256 ?? '')) throw new Error('--rules draft needs --rules-sha256 (64 hex characters)');
    if (o.rules === 'github' && o.rulesSha256) throw new Error('--rules-sha256 is only for --rules draft');
  }
  if (cmd === 'once' || cmd === 'checks') {
    const app = [o.appId, o.appInstallation, o.appKeyFile].filter((x) => x !== undefined).length;
    if (app !== 0 && app !== 3) throw new Error('--app-id, --app-installation and --app-key-file go together: all three or none');
    if (app && !/^[A-Za-z0-9.]{1,64}$/.test(o.appId)) throw new Error('--app-id must be the App\'s id');
    if (app && !/^[1-9][0-9]{0,19}$/.test(o.appInstallation)) throw new Error('--app-installation must be the installation\'s number');
    if (app && (!o.appKeyFile.startsWith('/') || basename(o.appKeyFile) === '' || o.appKeyFile.endsWith('/'))) throw new Error('--app-key-file must be the key file\'s full path');
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
  if (o.cmd === 'checks') {
    // Setup's proof (L707 M1): the job's own mint and the job's own read, nothing printed but one JSON line of fixed words.
    const [owner, repo] = o.repo.split('/');
    const m = await mintChecksClient(o, { owner, repo, fetchFn, ...(uid !== undefined ? { uid } : {}) });
    if (!m.client) { out(JSON.stringify({ ok: false, stage: 'mint', reason: m.reason })); return 1; }
    const r = await proveChecksRead({ checksGh: m.client, owner, repo, sha: o.sha });
    out(JSON.stringify(r.ok ? { ok: true, stage: 'read' } : { ok: false, stage: 'read', kind: r.kind, status: r.status, said: r.said }));
    return r.ok ? 0 : 1;
  }
  if (o.cmd === 'summary') {
    if (!existsSync(join(o.dir, 'log.jsonl'))) { err('there is no log in that folder (no pass has run, or the folder is wrong)'); return 1; }
    const ex = readExplanations(o.explanations, { ownerUid: Number(o.ownerUid) });
    const s = summary({ dir: o.dir, endDay: o.endDay, explanations: ex });
    out(`days (UTC, by merge time): ${s.days.length ? `${s.days[0]} to ${s.days.at(-1)}` : 'none'}; window starts ${s.windowStart ?? 'never'}; days with no clean pass: ${s.missingDays.length ? s.missingDays.join(', ') : 'none'}`);
    out(`commits judged: ${s.judged}; would merge: ${s.wouldMerge}; disagreements with MAIN: ${s.disagreements}; unexplained: ${s.unexplained.length}; passes with a problem: ${s.failedPasses}`);
    out(s.explanationsOwner === null && !s.explanationsProblem ? 'explanations: no file was read (there is none yet, so every disagreement is unexplained)' : s.explanationsProblem ? `explanations: the file could not be used (${s.explanationsProblem})` : `explanations from the file owned by user ${s.explanationsOwner}`);
    out(`the earliest end day that could count: ${s.earliestEndDay ?? 'unknown'} (the end of the seventh full UTC day since the first pass after the latest rules restart; an earlier end day cannot count); you gave ${o.endDay}`);
    for (const u of s.unexplained) out(`UNEXPLAINED  ${u.sha}${u.pr ? ` (pull ${u.pr})` : ' (direct push)'}: ${u.verdict}${u.refusals?.length ? ` — ${u.refusals.map((r) => `${r.n}: ${r.reason}`).join('; ')}` : ''}`);
    for (const r of s.reasons) out(`BECAUSE  ${r}`);
    out(s.ok ? 'THE WEEK COUNTS.' : 'THE WEEK DOES NOT COUNT YET.');
    return s.ok ? 0 : 1;
  }
  try { mkdirSync(o.dir, { recursive: true, mode: 0o700 }); } catch { err('the folder could not be made'); return 2; }
  const [owner, repo] = o.repo.split('/');
  const gh = readOnlyClient({ token: tokenFile(o.tokenFile), ...(fetchFn ? { fetchFn } : {}) });
  const checksGh = o.appId ? await appChecksClient(o, { owner, repo, fetchFn, err, ...(uid !== undefined ? { uid } : {}) }) : null;
  if (!o.appId) err(`PROBLEM  ${CHECKS_NOT_KNOWN}: give once --app-id, --app-installation and --app-key-file`);
  const rules = o.rules === 'draft' ? draftRules({ dir: o.dir, sha256: o.rulesSha256 }) : githubRules({ gh, owner, repo });
  try {
    const r = await watchPass({ gh, checksGh, owner, repo, dir: o.dir, rules });
    if (r.locked) { out('another pass is running; this one did nothing.'); return 0; }
    out(`judged ${r.judged} new commit(s); ${r.skipped} already in the log.`);
    for (const p of r.problems) err(`PROBLEM  ${p}`);
    return r.problems.length ? 1 : 0;
  } catch (e) { err(`stopped: ${String(e?.message ?? e).slice(0, 160)}`); return 1; }
}

// Only the two calls a mint makes, to GitHub's fixed host: the token request for one installation, and GET /app (the
// robot's login). Anything else throws. Answers are { status, json }.
export function appMintClient({ fetchFn = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const call = async (method, path, body, headers) => {
    const res = await fetchFn(`https://api.github.com${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  return Object.freeze({
    post: async (path, body, headers) => { if (!/^\/app\/installations\/[1-9][0-9]{0,19}\/access_tokens$/.test(path)) throw new Error('only the token request is allowed'); return call('POST', path, body, headers); },
    get: async (path, headers) => { if (path !== '/app') throw new Error('only GET /app is allowed'); return call('GET', path, null, headers); },
  });
}

// The check-runs client for one pass: the robot App's installation token, minted now, in a read-only client that asks
// for nothing but this repo's check runs at one commit (L631 Minor 3). null, with the reason said, when it can't be
// minted (the check runs are then not known).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function appChecksClient(o, { owner, repo, fetchFn, err, uid = process.getuid?.() }) {
  const m = await mintChecksClient(o, { owner, repo, fetchFn, uid });
  if (!m.client) { err(`PROBLEM  ${CHECKS_NOT_KNOWN}: the robot App's token could not be minted (${m.reason})`); return null; }
  return m.client;
}
/** The mint and the client, shared by `once` and `checks` so setup proves the job's own path (L707 M1). → { client } | { reason }. */
async function mintChecksClient(o, { owner, repo, fetchFn, uid = process.getuid?.() }) {
  const m = await mintInstallationToken({ keyDir: dirname(o.appKeyFile), keyFile: basename(o.appKeyFile), appId: o.appId, installationId: o.appInstallation,
    http: appMintClient(fetchFn ? { fetchFn } : {}), uid, scriptsUid: uid });
  if (!m.ok) return { reason: m.reason };
  const token = m.token;
  const inner = readOnlyClient({ token: () => token, ...(fetchFn ? { fetchFn } : {}) });
  const only = new RegExp(`^/repos/${esc(owner)}/${esc(repo)}/commits/[0-9a-f]{40}/check-runs\\?per_page=[0-9]{1,3}$`);
  return { client: { get: async (path, ...rest) => { if (typeof path !== 'string' || !only.test(path)) throw Object.assign(new Error('the App\'s client reads only this repo\'s check runs'), { unreadable: true }); return inner.get(path, ...rest); } } };
}

// Started as a program? Compare real paths: launchd starts it through the installed link, so argv[1] is the link while
// import.meta.url is the real file.
const started = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) : false; } catch { return false; } })();
if (started) process.exitCode = await main(process.argv.slice(2));

// For the tests only: the check-runs client one pass would use.
export const watchChecksClientForTest = appChecksClient;
