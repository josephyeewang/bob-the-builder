// The review package (R-0b-144): exactly what the runner hands a review session, worked out in its review copy
// (<reviewCopies>/<session>, which holds the card's branch at the head and main beside it). The change is the diff
// from where the branch left main to the head: the files it touches and the diff itself.
//
// The change under review must not shape what the reviewer is told is the whole change (audit R-0b-147 M-1, L83):
//   (a) the diff is plain text whatever the branch's own .gitattributes say: --text, no textconv, no external diff;
//   (b) a file name holding a control character (a line break could write lines into the prompt) refuses the package;
//   (c) the diff is written outside the review copy, into the runner's own folder (`dir`, <root>/packages/<session>),
//       which a session can read but never write (the runnerRoot wall), and its sha256 is handed back so the runner
//       can check, before the verdict counts, that it is still what the session was given.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
// C0 controls, DEL, the C1 controls, and the Unicode line and paragraph separators (built from their codes so no
// editor turns them into real line breaks inside the source).
export const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`);
export const DIFF_NAME = 'change.diff';
// The diff git hands over is plain text, never shaped by the tree under review (M-1 (a)).
export const DIFF_FLAGS = Object.freeze(['--no-color', '--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--ignore-submodules=none']);

/** Throws on the first name holding a control character; → the list. */
export function plainNames(list, what = 'the file name') {
  const bad = list.find((p) => CONTROL.test(p));
  if (bad !== undefined) throw new Error(`${what} ${JSON.stringify(bad)} holds a control character, so no package is made`);
  return list;
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** → { ok, base, head, files: [{ status, path }], diffFile, diffBytes, diffSha256 } | { ok: false, reason } */
export async function reviewPackage({ copy, head, dir }) {
  if (typeof head !== 'string' || !HEX40.test(head)) return { ok: false, reason: 'the head is not 40 hex' };
  if (typeof dir !== 'string' || !isAbsolute(dir)) return { ok: false, reason: 'no package folder of the runner\'s was given' };
  const opts = (purpose) => ({ gitDir: join(copy, '.git'), workTree: copy, cwd: copy, purpose, timeoutMs: 120_000 });
  try {
    if ((await gitOk(['rev-parse', 'HEAD'], opts('review-package-head'))).trim() !== head) return { ok: false, reason: 'the review copy is not at the head' };
    const base = (await gitOk(['merge-base', 'refs/heads/main', head], opts('review-package-base'))).trim();
    if (!HEX40.test(base)) return { ok: false, reason: 'the branch has no common commit with main' };
    const raw = await gitOk(['diff', '--name-status', '-z', '--no-renames', '--ignore-submodules=none', base, head], opts('review-package-files'));
    const parts = raw.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i], path: parts[i + 1] });
    plainNames(files.map((f) => f.path));
    const diff = await gitOk(['diff', ...DIFF_FLAGS, base, head], opts('review-package-diff'));
    // A folder of its own, made fresh: one already there is never written into.
    mkdirSync(dir, { mode: 0o755 });
    const diffFile = join(dir, DIFF_NAME);
    writeFileSync(diffFile, diff, { mode: 0o644, flag: 'wx' });
    return { ok: true, base, head, files, diffFile, diffBytes: Buffer.byteLength(diff), diffSha256: sha256(diff) };
  } catch (e) { return { ok: false, reason: e?.message ?? String(e) }; }
}
