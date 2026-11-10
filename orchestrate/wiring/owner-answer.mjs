// owner-answer.mjs — the owner's side of the Sensors job (L609, L611, L614): who is signed in, and the plan's usage.
//
// WHY. The Sensors job runs as `orchestrate`, which can't enter the owner's home folder, so it can't ask Claude Code who
// is signed in or how much of the plan is used. A small job running as the owner asks both and hands one short answer
// through a folder: `<answer folder>/owner-answer.json`. `sensors-ports.mjs` reads it on the `orchestrate` side.
//
//   ownerAnswer({ home, authStatus?, usage?, inUse?, now? }) → the answer (below); never throws
//   parseUsageReport(text) → { ok: true, h5, week, week_from } | { ok: false, reason }
//   writeAnswer({ to, answer, uid? }) → { ok: true } | { ok: false, reason }
//   node owner-answer.mjs --to <file>     one round, run by the owner's job (placed by lane 4's setup); the home is the
//                                         job's own, as it runs as the owner
//
// The answer: { v: 1, account: 'a'|'b'|null, signed_in: true|false|null, observed_at,
//               usage: { h5: {used_pct, resets_at}|null, week: {used_pct, resets_at}|null, week_from } | null, usage_reason? }
// It never holds an email address, a token or Claude's raw output: only the named fields below.
//
// Usage comes from `claude -p /usage` (L611, tested 5 Nov 2026 on Claude Code 2.1.318: no model call, 0 tokens, and
// no open session needed). The report's structured form, `usage_report`, needs a claude.ai sign-in; a setup-token
// doesn't qualify by default. Its rows are the server's: `session` is the 5-hour window. The week is the HIGHEST weekly
// row, `weekly_all` or any model's `weekly_scoped` (L728 M2): a plan whose one model is at 100% this week is out for
// that model, and reading only `weekly_all` would call it green. `week_from` names the row it came from ('weekly_all'
// or 'weekly_scoped:<model>'). A missing row is null, never 0% (L611); on 5 Nov the live report had no `session` row.
// A report this doesn't know is refused and says why, in `usage_reason`: a row kind other than the three known ones (a
// renamed row is refused, never skipped; L728 m3), a percent outside 0 to 100, or percents that look like fractions
// (every row at 1 or under while a row's severity is not `normal`; L728 m2).
//
// The folder is the owner's, not root's (L614): a root-owned folder can't be written by the owner's job. So the file is
// a claim from the owner's user, which work sessions may also run as. sensors-ports.mjs says what that allows.

import { closeSync, constants, fchmodSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { accountInUse, accountEnv, accountDir, readAuthStatus, claudeAuthStatus, CONFIG_VAR } from '../modules/M4-workshop/launcher/accounts.mjs';

export const ANSWER_FILE = 'owner-answer.json';
export const ANSWER_VERSION = 1;
export const ROW_KINDS = Object.freeze(['session', 'weekly_all', 'weekly_scoped']);
const MAX_OUT = 1024 * 1024;
const refuse = (reason) => ({ ok: false, reason });

/** `claude -p /usage` for one account, as the owner. Its stdout, or null on any failure to run. */
export function claudeUsage(claudeBin = 'claude') {
  return (name, env) => {
    const e = { ...process.env };
    delete e[CONFIG_VAR];
    if (env?.[CONFIG_VAR]) e[CONFIG_VAR] = env[CONFIG_VAR];
    const r = spawnSync(claudeBin, ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--max-turns', '1', '--setting-sources', ''], { env: e, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: MAX_OUT,
      stdio: ['ignore', 'pipe', 'ignore'] });
    return r.error || typeof r.stdout !== 'string' ? null : r.stdout;
  };
}

const window = (row, name) => {
  if (typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100) {
    return refuse(`the ${name} row's percent is not 0 to 100`);
  }
  const r = row.resets_at;
  if (r !== null && r !== undefined && !(typeof r === 'string' && Number.isFinite(Date.parse(r)))) return refuse(`the ${name} row's reset time is not a time`);
  return { ok: true, w: { used_pct: row.percent, resets_at: r ? new Date(Date.parse(r)).toISOString() : null } };
};

/** The stream-json output of `claude -p /usage` → the two windows. Anything it doesn't know is refused with why. */
export function parseUsageReport(text) {
  if (typeof text !== 'string' || !text) return refuse('Claude Code gave no answer to /usage');
  let report;
  for (const line of text.split('\n')) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m?.type === 'assistant' && m && Object.hasOwn(m, 'usage_report')) { report = m.usage_report; break; }
  }
  if (report === undefined) return refuse('the /usage answer has no usage_report (the sign-in may not be a claude.ai one, or Claude Code is older)');
  const rl = report?.rate_limits;
  if (!rl || typeof rl !== 'object') return refuse('the /usage report has no rate_limits (Claude Code could not get the plan\'s usage)');
  if (!Array.isArray(rl.limits)) return refuse('the /usage report\'s limits is not a list');
  const rows = rl.limits;
  for (const x of rows) {
    if (!x || typeof x !== 'object' || !ROW_KINDS.includes(x.kind)) {
      return refuse(`the /usage report has a row of a kind this does not know (${String(x?.kind).slice(0, 40)})`);
    }
  }
  for (const kind of ['session', 'weekly_all']) {
    const n = rows.filter((x) => x.kind === kind).length;
    if (n > 1) return refuse(`the /usage report has ${n} ${kind} rows`);
  }
  const checked = [];
  for (const x of rows) {
    const w = window(x, x.kind);
    if (!w.ok) return w;
    checked.push({ kind: x.kind, row: x, w: w.w });
  }
  if (checked.length && checked.every((c) => c.w.used_pct <= 1) && checked.some((c) => typeof c.row.severity === 'string' && c.row.severity !== 'normal')) {
    return refuse('the /usage report\'s percents look like fractions (all at 1 or under while a row is not normal)');
  }
  const h5 = checked.find((c) => c.kind === 'session')?.w ?? null;
  let top = null;
  for (const c of checked) {
    if (c.kind === 'session') continue;
    if (!top || c.w.used_pct > top.w.used_pct || (c.w.used_pct === top.w.used_pct && c.kind === 'weekly_all')) top = c;
  }
  if (!h5 && !top) return refuse('the /usage report has neither a session nor a weekly row');
  return { ok: true, h5, week: top?.w ?? null, week_from: top ? rowName(top.row) : null };
}

// 'weekly_all', or 'weekly_scoped:<model>' with the model's name cut to safe letters (the Record keeps it as an id).
const rowName = (row) => {
  if (row.kind !== 'weekly_scoped') return row.kind;
  const m = row.scope?.model?.display_name ?? row.scope?.model?.id ?? '';
  const name = String(m).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `weekly_scoped:${name || 'unnamed'}`;
};

/** One answer for this moment. Every failure is a null with a reason, never a throw and never a guess. */
export async function ownerAnswer({ home, authStatus = claudeAuthStatus(), usage = claudeUsage(), inUse = accountInUse, now = () => new Date() }) {
  const answer = { v: ANSWER_VERSION, account: null, signed_in: null, observed_at: now().toISOString(), usage: null };
  let use;
  try { use = inUse({ home }); } catch { use = null; }
  if (!use?.account) { answer.usage_reason = use?.reason ?? 'no account is named for new sessions'; return answer; }
  answer.account = use.account;
  const env = accountEnv(home, use.account);
  try {
    const out = await authStatus(use.account, env);
    const s = typeof out === 'string' ? readAuthStatus(out, accountDir(home, use.account)) : { readable: false };
    if (s.readable) answer.signed_in = s.signedIn === true && s.folderMatches !== false;
  } catch { /* signed_in stays null: not known */ }
  if (answer.signed_in !== true) { answer.usage_reason = answer.signed_in === false ? 'not signed in' : 'who is signed in could not be read'; return answer; }
  let r;
  try { r = parseUsageReport(await usage(use.account, env)); } catch (e) { r = refuse(`the /usage read failed (${e?.message ?? e})`); }
  if (r.ok) answer.usage = { h5: r.h5, week: r.week, week_from: r.week_from };
  else answer.usage_reason = r.reason;
  return answer;
}

/** Writes the answer whole (a temporary name, then a rename), owner-only writable, into a folder only `uid` can write. */
export function writeAnswer({ to, answer, uid = process.getuid?.() }) {
  if (typeof to !== 'string' || !to.startsWith('/')) return refuse('the answer file needs a full path');
  const dir = dirname(to);
  let ds;
  try { ds = lstatSync(dir); } catch { return refuse(`${dir} is missing`); }
  if (ds.isSymbolicLink() || !ds.isDirectory()) return refuse(`${dir} is not a plain folder`);
  if (ds.uid !== uid) return refuse(`${dir} is not owned by uid ${uid}`);
  if (ds.mode & 0o022) return refuse(`${dir} can be written by others`);
  // One fixed temporary name, cleared first, so a round that crashed mid-write leaves one stray file, not one per run
  // (L728 c2). Only the owner can write the folder, and unlink removes a link itself, never what it points at.
  const tmp = `${to}.tmp`;
  try { unlinkSync(tmp); } catch { /* none left over */ }
  let fd;
  try { fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); } catch (e) {
    return refuse(`${tmp} could not be made fresh (${e?.code ?? e})`);
  }
  try {
    try { writeSync(fd, `${JSON.stringify(answer)}\n`); fchmodSync(fd, 0o644); } finally { closeSync(fd); }
    renameSync(tmp, to);
  } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } return refuse(`${to} could not be written (${e?.code ?? e})`); }
  return { ok: true };
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (self && self === invoked) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const home = homedir(); const to = arg('--to');
  if (typeof to !== 'string' || !to.startsWith('/')) {
    console.error('usage: node owner-answer.mjs --to <answer folder>/owner-answer.json');
    process.exit(2);
  }
  const a = await ownerAnswer({ home });
  const w = writeAnswer({ to, answer: a });
  console.log(JSON.stringify({ at: a.observed_at, account: a.account, signed_in: a.signed_in, usage: a.usage ? 'read' : 'unknown',
    usage_reason: a.usage_reason ?? null, written: w.ok, reason: w.ok ? null : w.reason }));
  process.exit(w.ok ? 0 : 1);
}
