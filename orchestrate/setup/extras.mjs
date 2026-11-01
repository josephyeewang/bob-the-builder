// Setup part 3: the proposals folders (runbook A7, R-0b-128), the owner's git trusting the mirror (R-0b-05 safe.directory),
// and the watch-only token's file (R-0b-161). The ownerTaps folder (A6) is a row of the folder table (layout.mjs), made and
// checked by users-folders / check; the account job reload (A8) is daemons.mjs.
//
// The proposals parent sits OUTSIDE the base, in a folder every user can write into (a sticky one), so the base wall
// (guard.mjs) cannot be used there. What keeps root safe instead: root makes the parent itself (mkdir never follows a link
// and refuses what exists), an existing parent must already be a real folder root owns (a user's planted one is refused,
// never taken over), and the owner and mode are set through the open folder (secureFolder). The first step of the run
// checks the same things again.
//
// The token: its home is a file in the `keys` folder (0700, orchestrate's) — see README "Where the watch-only token lives".
// It is typed into the terminal with the echo off, held in memory for the one write, and is never printed, logged, put in
// a step's text, an error or a program's arguments.

import { dirname, join } from 'node:path';
import { mirrorPath, proposalRows, proposalsParentOf } from './layout.mjs';
import { aclEntries, folderChecks, planFolders, readUser } from './users-folders.mjs';

const SUDO = '/usr/bin/sudo';
const GIT = '/usr/bin/git';
const TEST = '/bin/test';
const LS = '/bin/ls';
export const TOKEN_FILE = 'watch-only-token';
const op = (text, run) => ({ text, run });
const modeOf = (st) => st.mode & 0o7777;

// ───────────────────────────────────────────── proposals folders

/** Null, or why root must not make or change the proposals folders. Reads only. */
export function proposalsProblem(io, cfg) {
  const parent = proposalsParentOf(cfg);
  let up; try { up = io.lstat(dirname(parent)); } catch (e) { return `${dirname(parent)} could not be read (${e?.code ?? e})`; }
  if (up.isSymbolicLink() || !up.isDirectory()) return `${dirname(parent)} is not a plain folder`;
  let st = null; try { st = io.lstat(parent); } catch (e) { if (e?.code !== 'ENOENT') return `${parent} could not be read (${e?.code ?? e})`; }
  if (st === null) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) return `${parent} exists but is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}`;
  if (st.uid !== io.rootUid) return `${parent} already exists and belongs to uid ${st.uid}, not root, so someone else could change what is inside it; remove it (or ask the builder) and run this again`;
  return null;
}

export function planProposals(io, cfg) {
  const problems = [];
  if (cfg.products.length === 0) problems.push('no products are listed in the config, so there is no proposals folder to make');
  const owner = readUser(io, cfg.owner); const orch = readUser(io, 'orchestrate');
  if (!owner.exists) problems.push(`the owner's Mac user ${cfg.owner} was not found`);
  if (!orch.exists) problems.push('the orchestrate user does not exist yet (run users-folders first): it needs read access');
  const wall = proposalsProblem(io, cfg);
  if (wall) problems.push(`${wall}. Nothing was changed.`);
  if (problems.length) return { ops: [], problems };
  const f = planFolders(io, cfg, { owner: { uid: owner.uid, gid: owner.gid } }, proposalRows(cfg));
  if (f.problems.length || !f.ops.length) return f;
  const guard = op(`check that ${dirname(proposalsParentOf(cfg))} is a plain folder and ${proposalsParentOf(cfg)} (if there) is root's`, () => {
    const p = proposalsProblem(io, cfg); if (p) throw new Error(`${p}; nothing was changed`);
  });
  return { ops: [guard, ...f.ops], problems: [] };
}

const asUser = (io, who, args) => io.run(SUDO, ['-n', '-u', who, ...args]);

/** Read only → [{ ok, what, why?, skip? }]. The as-another-user proofs need root; without it they are SKIPped, said so. */
export function checkProposals(io, cfg) {
  const out = []; const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const owner = readUser(io, cfg.owner);
  item(owner.exists, `owner ${cfg.owner} exists`, 'not found');
  const wall = proposalsProblem(io, cfg);
  item(wall === null, `${proposalsParentOf(cfg)} may be made and changed by root only`, wall);
  folderChecks(io, proposalRows(cfg), owner.exists ? { owner: { uid: owner.uid, gid: owner.gid } } : {}, item);
  for (const prod of cfg.products) {
    const f = join(proposalsParentOf(cfg), prod);
    if (io.euid() !== 0) { out.push({ ok: true, skip: true, what: `${f}: orchestrate can read and not write, review can not read`, why: 'needs root to run as the other users; run check-proposals with sudo' }); continue; }
    const control = asUser(io, cfg.owner, [TEST, '-w', f]);
    item(control.status === 0, `${cfg.owner} CAN write ${f} (the control: the "cannot" lines below mean something)`, `did not work (${control.stderr.trim().slice(0, 100) || `exit ${control.status}`})`);
    const rd = asUser(io, 'orchestrate', [LS, f]);
    item(rd.status === 0, `as orchestrate, reading ${f} works`, `failed (${rd.stderr.trim().slice(0, 100) || `exit ${rd.status}`})`);
    const wr = asUser(io, 'orchestrate', [TEST, '-w', f]);
    item(wr.status !== 0, `as orchestrate, writing ${f} fails`, 'orchestrate CAN write it, and must not');
    const rv = asUser(io, 'review', [LS, f]);
    item(rv.status !== 0, `as review, reading ${f} fails`, 'review CAN read it, and must not');
  }
  return out;
}

// ───────────────────────────────────────────── the owner's git trusts the mirror

const gitAsOwner = (io, cfg, args) => io.run(SUDO, ['-n', '-H', '-u', cfg.owner, GIT, 'config', '--global', ...args]);

/** The owner's own `git config --global` (run as the owner, never by root writing into their home) names exactly the mirror. */
export function planSafeDirectory(io, cfg) {
  const m = mirrorPath(cfg);
  if (!readUser(io, cfg.owner).exists) return { ops: [], problems: [`the owner's Mac user ${cfg.owner} was not found`] };
  const cur = gitAsOwner(io, cfg, ['--get-all', 'safe.directory']);
  if (cur.status !== 0 && cur.status !== 1) return { ops: [], problems: [`could not read ${cfg.owner}'s git settings (${cur.stderr.trim().slice(0, 120) || `exit ${cur.status}`})`] };
  const have = cur.status === 0 ? cur.stdout.split('\n').filter(Boolean) : [];
  if (have.includes('*')) return { ops: [], problems: [`${cfg.owner}'s git trusts every folder ("safe.directory = *"); remove that line yourself, then run this again. Nothing was changed.`] };
  if (have.includes(m)) return { ops: [], problems: [] };
  return { ops: [op(`as ${cfg.owner}: git config --global --add safe.directory ${m}`, () => {
    const r = gitAsOwner(io, cfg, ['--add', 'safe.directory', m]);
    if (r.status !== 0) throw new Error(`could not set it (${r.stderr.trim().slice(0, 120) || `exit ${r.status}`})`);
  })], problems: [] };
}

export function checkSafeDirectory(io, cfg) {
  const m = mirrorPath(cfg); const what = `${cfg.owner}'s git trusts ${m}, and not every folder`;
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: 'needs root to run as the owner; run with sudo' }];
  const cur = gitAsOwner(io, cfg, ['--get-all', 'safe.directory']);
  if (cur.status !== 0 && cur.status !== 1) return [{ ok: false, what, why: `could not read (${cur.stderr.trim().slice(0, 100) || `exit ${cur.status}`})` }];
  const have = cur.status === 0 ? cur.stdout.split('\n').filter(Boolean) : [];
  const ok = have.includes(m) && !have.includes('*');
  return [{ ok, what, ...(ok ? {} : { why: have.includes('*') ? 'it trusts every folder ("*")' : 'the mirror path is not in its safe.directory list' }) }];
}

// ───────────────────────────────────────────── the watch-only token file

/** Null, or why this text is not a GitHub token. Never says anything about the text itself. */
export function tokenProblem(text) {
  return typeof text === 'string' && /^(github_pat_[A-Za-z0-9_]{22,255}|gh[pousr]_[A-Za-z0-9]{30,255})$/.test(text)
    ? null : 'that does not look like a GitHub token (a fine-grained one starts with github_pat_). Nothing was saved.';
}

export const tokenPath = (cfg) => join(cfg.base, 'keys', TOKEN_FILE);

export function planToken(io, cfg) {
  const orch = readUser(io, 'orchestrate');
  if (!orch.exists) return { ops: [], problems: ['the orchestrate user does not exist yet (run users-folders first)'] };
  const keys = join(cfg.base, 'keys'); const f = tokenPath(cfg);
  let k; try { k = io.lstat(keys); } catch { return { ops: [], problems: [`${keys} is not there (run users-folders first)`] }; }
  if (k.isSymbolicLink() || !k.isDirectory() || k.uid !== orch.uid || modeOf(k) !== 0o700) return { ops: [], problems: [`${keys} is not orchestrate's own 0700 folder (run users-folders first)`] };
  try { const st = io.lstat(f); if (st.isSymbolicLink() || !st.isFile()) return { ops: [], problems: [`${f} exists but is not a plain file; nothing was changed`] }; } catch (e) { if (e?.code !== 'ENOENT') return { ops: [], problems: [`${f} could not be read (${e?.code ?? e})`] }; }
  return { ops: [op(`read the token from the terminal (typed with the echo off, never shown), then save it as ${f} (orchestrate, 0600)`, () => {
    let t = io.readSecret('Paste the watch-only GitHub token and press Return (nothing will show as you paste): ').trim();
    const bad = tokenProblem(t); if (bad) { t = ''; throw new Error(bad); }
    let st = null; try { st = io.lstat(f); } catch { /* not there */ }
    if (st && st.isDirectory() && !st.isSymbolicLink()) { t = ''; throw new Error(`${f} is now a folder; nothing was saved`); }
    io.rm(f);
    io.write(f, `${t}\n`, 0o600);
    t = '';
    io.secureFile(f, { uid: orch.uid, gid: orch.gid, mode: 0o600 });
  })], problems: [] };
}

/** Read only; never reads the token itself, only its size, owner and mode. */
export function checkToken(io, cfg) {
  const f = tokenPath(cfg); const what = `${f} is orchestrate's own 0600 file of a token's size, with no access list`;
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: 'the folder is orchestrate-only; needs root to look; run with sudo' }];
  const orch = readUser(io, 'orchestrate');
  if (!orch.exists) return [{ ok: false, what, why: 'the orchestrate user does not exist' }];
  let st; try { st = io.lstat(f); } catch { return [{ ok: false, what, why: 'missing' }]; }
  const why = [];
  if (st.isSymbolicLink() || !st.isFile()) why.push('is not a plain file');
  else {
    if (st.uid !== orch.uid) why.push(`owner is uid ${st.uid}, not orchestrate`);
    if (modeOf(st) !== 0o600) why.push(`mode is ${modeOf(st).toString(8)}, want 600`);
    if (!(st.size >= 30 && st.size <= 600)) why.push('its size is not a token\'s');
    const acl = aclEntries(io, f); if (acl.error) why.push(acl.error); else if (acl.entries.length) why.push('has an access list');
  }
  return [{ ok: why.length === 0, what, ...(why.length ? { why: why.join('; ') } : {}) }];
}

// ───────────────────────────────────────────── prove the token is watch-only (R-0b-161, L99 (3))

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const repoProblem = (r) => (typeof r === 'string' && REPO.test(r) && !r.split('/').some((s) => s === '.' || s === '..') ? null : '--repo must look like owner/name');
const API = 'https://api.github.com';

/**
 * Two calls with the token, plain fetch: (1) a read lists the repository's open pull requests and must work; (2) a write that
 * changes nothing (an open pull request's title set to itself) must come back 403. Anything else FAILs, and a write that went
 * through says to revoke the token. Only status numbers are ever printed: never the token, never what GitHub sent back.
 * Runs as root (it reads the token file) or as orchestrate. → [{ ok, what, why? }]
 */
export async function proveToken(io, cfg, { repo }) {
  const out = []; const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const bad = repoProblem(repo); if (bad) { item(false, 'the repository is named', bad); return out; }
  let token;
  try { token = io.readText(tokenPath(cfg)).trim(); } catch { item(false, 'the token file can be read', `${tokenPath(cfg)} could not be read (run with sudo, after the token step)`); return out; }
  if (tokenProblem(token)) { item(false, 'the token file holds a token', 'it does not look like one; store it again'); return out; }
  const call = async (path, init = {}) => {
    try {
      const r = await io.fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'orchestrate-setup', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
      return { status: r.status, text: r.text };
    } catch (e) { return { status: 0, text: '', error: String(e?.code ?? e?.name ?? 'network error') }; }
  };
  const list = await call(`/repos/${repo}/pulls?state=open&per_page=1`);
  item(list.status === 200, `reading ${repo}'s open pull requests works`, list.status === 0 ? `no answer (${list.error})` : `GitHub answered ${list.status}`);
  if (list.status !== 200) return out;
  let pr = null; try { pr = JSON.parse(list.text)[0] ?? null; } catch { /* below */ }
  if (!pr || !Number.isInteger(pr.number) || typeof pr.title !== 'string') { item(false, 'there is an open pull request to try the write on', 'none was found; open a pull request, or use a repository that has one, and run this again'); return out; }
  const w = await call(`/repos/${repo}/pulls/${pr.number}`, { method: 'PATCH', body: JSON.stringify({ title: pr.title }) });
  item(w.status === 403, `a write that changes nothing (pull request #${pr.number}'s title set to itself) is refused with 403`,
    w.status >= 200 && w.status < 300 ? 'THE WRITE WENT THROUGH: this token can change things. Revoke it at GitHub now (Settings → Developer settings → Personal access tokens), then make a read-only one'
      : w.status === 0 ? `no answer (${w.error}); not proven. If in doubt, revoke it`
        : `GitHub answered ${w.status}, not 403, so read-only is not proven; check the token's permissions at GitHub, or revoke it`);
  return out;
}
