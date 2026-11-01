// The review package (R-0b-144): exactly what the runner hands a review session, worked out in its review copy
// (<reviewCopies>/<session>, which holds the card's branch at the head and main beside it). The change is the diff
// from where the branch left main to the head: the files it touches and the diff itself, written inside the copy's
// .git folder so the reviewed tree stays as committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';

const HEX40 = /^[0-9a-f]{40}$/;

/** → { ok, base, head, files: [{ status, path }], diffFile, diffBytes } | { ok: false, reason } */
export async function reviewPackage({ copy, head }) {
  if (typeof head !== 'string' || !HEX40.test(head)) return { ok: false, reason: 'the head is not 40 hex' };
  const opts = (purpose) => ({ gitDir: join(copy, '.git'), workTree: copy, cwd: copy, purpose, timeoutMs: 120_000 });
  try {
    if ((await gitOk(['rev-parse', 'HEAD'], opts('review-package-head'))).trim() !== head) return { ok: false, reason: 'the review copy is not at the head' };
    const base = (await gitOk(['merge-base', 'refs/heads/main', head], opts('review-package-base'))).trim();
    if (!HEX40.test(base)) return { ok: false, reason: 'the branch has no common commit with main' };
    const raw = await gitOk(['diff', '--name-status', '-z', '--no-renames', base, head], opts('review-package-files'));
    const parts = raw.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i], path: parts[i + 1] });
    const diff = await gitOk(['diff', '--no-color', '--no-ext-diff', '--no-renames', base, head], opts('review-package-diff'));
    const dir = join(copy, '.git', 'orchestrate-review');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const diffFile = join(dir, 'change.diff');
    writeFileSync(diffFile, diff, { mode: 0o600 });
    return { ok: true, base, head, files, diffFile, diffBytes: Buffer.byteLength(diff) };
  } catch (e) { return { ok: false, reason: e?.message ?? String(e) }; }
}
