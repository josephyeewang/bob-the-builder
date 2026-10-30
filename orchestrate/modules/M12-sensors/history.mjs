// history.mjs — the repo's history as a file the Lead can read, and the Lead's history questions answered safely
// (R-0b-75; design v4 §4.4, §14.1.4 "History requests", rail B2).
//
// WHY. The Lead has no shell and no GitHub token (B2). It reads the recent history from a file the Sensors write from
// the Do-plane's own copy of `main`, and asks for one path's history by dropping a request file in its outbox.
// The path it names is DATA: it must be a path that exists on `main`, it is never part of a command line (git runs
// with an argument list, never a shell), and git reads it with --literal-pathspecs, so `:(glob)**` is just a name.
// A path that isn't on `main` gets "no such path" and no git command runs with it at all: the check is a lookup in
// the list of `main`'s paths, read once per pass.
// Commit subjects and author names are masked and fenced like any outside text. File paths are NOT entity-escaped
// (the Lead searches its copy by exact path; review-0b-7 Minor 4): they are validated and written as plain JSON
// strings. A path with a control, bidi or zero-width character is left out and counted, never passed on.
// The history file is the last 200 FIRST-PARENT commits of main, so it equals `git log --first-parent` on a fresh copy.

import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { randomBytes } from 'node:crypto';
import { makePrepare } from './escape.mjs';

export const HISTORY_COMMITS = 200;
export const REQUEST_COMMITS = 50;
export const MAX_PATH = 4096;
const BAD_PATH_CHAR = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

// A path the record may carry: a non-empty string, at most 4096 characters, no control / bidi / zero-width character.
export function validPath(p) { return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && !BAD_PATH_CHAR.test(p); }
// A Lead request path: also never starts with '-' (it could read as an option even in an argument list).
export function validRequestPath(p) { return validPath(p) && !p.startsWith('-'); }

// Card id from the subject ("[C-12] …", "card C-12", "(C-12)") or a "Card: C-12" trailer.
export function cardOf(subject, body = '') {
  const t = /^Card:\s*([A-Z]+-\d+)\s*$/m.exec(body);
  if (t) return t[1];
  const s = /\b(?:card[ -])?([A-Z]{1,4}-\d{1,6})\b/.exec(subject);
  return s ? s[1] : null;
}

// git, always with an argument list, through safe-git.mjs (lead call L36): an empty environment, no system or global
// config, no hooks or programs the copy's own files could name, and the repository named by GIT_DIR. `gitDir` is the
// copy's `.git` folder (or a bare mirror). The runner is injectable so tests can see every call; it may be async.
// safe-git still reads the repository's own config, so the settings that make `git log` start a program (a signature
// check names one) are pinned off here too (L36: a planted gpg.program ran on a plain log).
export const HISTORY_CONFIG = Object.freeze([['log.showSignature', 'false'], ['log.mailmap', 'false'],
  ...['gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program'].map((k) => [k, '/usr/bin/false'])]);
export function makeGit(gitDir, runner = (args) => gitOk(args, { gitDir, purpose: 'history', extraConfig: HISTORY_CONFIG })) {
  return (args) => { if (!Array.isArray(args)) throw new Error('git takes an argument list only'); return runner(['--literal-pathspecs', ...args]); };
}

// Field and record markers are fresh random strings on every call: a commit message can hold any byte git allows,
// including U+001E and U+001F, so a fixed marker would let a message forge a whole commit entry (0b-7 audit M-2).
// A chunk whose sha is not 40 hex or whose date is not an ISO time is refused, never passed on.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/;
function markers() { const n = randomBytes(12).toString('hex'); return { SEP: `<${n}|s>`, END: `<${n}|e>`, BODY: `<${n}|b>`, FILES: `<${n}|f>` }; }

function parseLog(out, m) {
  const commits = [];
  for (const chunk of out.split(m.END)) {
    const c = chunk.replace(/^\n+/, '');
    if (!c.trim()) continue;
    const [head, rest = ''] = c.split(m.BODY);
    const [sha, author, date, subject] = head.split(m.SEP);
    const [body, files = ''] = rest.split(m.FILES);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !ISO.test(date ?? '')) throw new Error('git log output did not parse; refusing the history');
    commits.push({ sha, author, date, subject, body, files: files.split('\n').filter(Boolean) });
  }
  return commits;
}

// Raw commits on `ref` (default main), newest first, optionally for one literal path.
export async function readLog(git, { ref = 'main', n = HISTORY_COMMITS, path = null, firstParent = false } = {}) {
  const m = markers();
  const format = `--format=${m.END}%H${m.SEP}%an${m.SEP}%aI${m.SEP}%s${m.BODY}%b${m.FILES}`;
  const args = ['log', `-n${n}`, ...(firstParent ? ['--first-parent'] : []), '--name-only', format, ref];
  if (path !== null) args.push('--', path);
  return parseLog(await git(args), m);
}

export function makeHistory({ git, prepare = makePrepare(), ref = 'main' }) {
  const shape = (c) => ({
    sha: c.sha,
    author: prepare(c.author, 'commit-author'),
    date: c.date,
    subject: prepare(c.subject, 'commit-subject'),
    card: cardOf(c.subject, c.body),
    files: c.files.filter(validPath),
    ...(c.files.some((f) => !validPath(f)) ? { files_refused: c.files.filter((f) => !validPath(f)).length } : {}),
  });

  // The history file's content: the last 200 commits of main, each with its files, author and card.
  async function historyFile() {
    const head = (await git(['rev-parse', ref])).trim();
    return { ref, head, commits: (await readLog(git, { ref, firstParent: true })).map(shape) };
  }

  let pathSet = null;
  async function paths() {
    if (!pathSet) {
      const files = (await git(['ls-tree', '-r', '--name-only', '-z', ref])).split('\0').filter(Boolean);
      pathSet = new Set(files);
      for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) pathSet.add(parts.slice(0, i).join('/')); }
    }
    return pathSet;
  }

  // Answer one Lead history request ({ path }). Never throws.
  async function answer(request) {
    const p = request && typeof request.path === 'string' ? request.path : null;
    if (!validRequestPath(p)) return { ok: false, answer: 'no such path' };
    try {
      if (!(await paths()).has(p)) return { ok: false, answer: 'no such path' };
      return { ok: true, path: p, commits: (await readLog(git, { ref, n: REQUEST_COMMITS, path: p })).map(shape) };
    } catch {
      return { ok: false, answer: 'history unavailable' };
    }
  }

  return Object.freeze({ historyFile, answer, refreshPaths: () => { pathSet = null; } });
}
