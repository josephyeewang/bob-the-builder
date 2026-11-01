// The review package (R-0b-144): exactly what the runner hands a review session, worked out in its review copy
// (<reviewCopies>/<session>, which holds the card's branch at the head and main beside it). The change is the diff
// from where the branch left main to the head: the files it touches and the diff itself, written inside the copy's
// .git folder so the reviewed tree stays as committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitOk } from '../M4-workshop/git/safe-git.mjs';

const HEX40 = /^[0-9a-f]{40}$/;

/** → { ok, base, head, files: [{ status, path }], diffFile, diffBytes } | { ok: false, reason } */
export async function reviewPackage({ copy, head, since }) {
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
    // The short re-audit (R-0b-146): `since` is a head of this card an auditor passed. When this head was caught up
    // with main after it, what main brought in between the two is listed, so the audit checks the combined change.
    let reAudit = null;
    if (typeof since === 'string' && HEX40.test(since) && since !== head
        && (await git(['merge-base', '--is-ancestor', since, head], opts('review-package-since'))).code === 0) {
      const was = (await gitOk(['merge-base', 'refs/heads/main', since], opts('review-package-since-base'))).trim();
      const brought = (await gitOk(['diff', '--name-only', '-z', '--no-renames', was, base], opts('review-package-brought'))).split('\0').filter(Boolean);
      if (brought.length) reAudit = { since, brought };
    }
    return { ok: true, base, head, files, diffFile, diffBytes: Buffer.byteLength(diff), reAudit };
  } catch (e) { return { ok: false, reason: e?.message ?? String(e) }; }
}
