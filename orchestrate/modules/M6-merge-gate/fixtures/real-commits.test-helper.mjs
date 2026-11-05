// real-commits.test-helper.mjs — a real bare repository behind the fake GitHub, for tests that need GitHub and the
// mirror to be two separate repositories (L513 MAT-1). Each commit the fake makes is made here too, with the same files
// and parents, and the fake takes the real sha, so the gate's reading and git's agree.
//
//   const real = realCommits(dir);      // before the fake's first commit
//   g.repo.shaFor = real.shaFor;
//   real.publish({ main: sha, 'card/c-2': sha });   // what GitHub's branches point at now
//
// Synchronous, since the fake's commit is. Tests only: production git goes through safe-git.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WHO = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T12:00:00Z' };

export function realCommits(dir) {
  const gd = join(dir, 'github.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', gd]);
  const index = join(dir, 'github.index');
  const git = (args, input) => execFileSync('git', ['--git-dir', gd, ...args], { input, encoding: 'utf8', env: { ...process.env, ...WHO, GIT_INDEX_FILE: index } }).trim();
  let n = 0;
  const shaFor = (parents, files) => {
    git(['read-tree', '--empty']);
    const lines = [...files].map(([path, e]) => `${e.mode} ${git(['hash-object', '-w', '--stdin'], e.text)}\t${path}\n`);
    git(['update-index', '--add', '--index-info'], lines.join(''));
    n += 1;
    return git(['commit-tree', git(['write-tree']), ...parents.flatMap((p) => ['-p', p]), '-m', `commit ${n}`]);
  };
  const publish = (refs) => { for (const [name, sha] of Object.entries(refs)) git(['update-ref', `refs/heads/${name}`, sha]); };
  return { gd, shaFor, publish };
}
