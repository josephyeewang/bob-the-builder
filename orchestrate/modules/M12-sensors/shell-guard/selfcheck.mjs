// selfcheck.mjs — does each refuse case really touch the protected file? (0b-7 round 10; for Bob's own tests.)
//
// A refuse case that no shell turns into a read or write of the file proves nothing: a guard "passes" it by refusing,
// and a precise guard that allows it is marked wrong. This runs every refuse case against a planted file, under each
// shell given, each run in its own new throwaway folder (a leftover from one case, such as sed's .bak, changes what
// a glob matches in the next: round 10 audit 2 M-1). It never runs a case outside that folder: the cases are built for it,
// and the corpus's /tmp/x and /tmp/y are swapped for files inside it.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CASELESS, cases } from './runner.mjs';

const CONTENT = 'echo PLANTED\n'; // `source` runs it, so a sourced read shows too
const B64 = Buffer.from(CONTENT).toString('base64').slice(0, 12);
// What a case left at /tmp/y (swapped for a file in the run's folder): a file, or a folder copied there (cp -r).
const readOut = (y) => (!existsSync(y) ? '' : lstatSync(y).isDirectory() ? readdirSync(y, { recursive: true }).map((n) => `${y}/${n}`).filter((f) => lstatSync(f).isFile()).map((f) => readFileSync(f, 'utf8')).join('') : readFileSync(y, 'utf8'));

// Builds the refuse cases for a folder; hex and ANSI-C forms encode the path, so each run builds its own, never swaps text.
// HOME is the folder itself, so the ~ and $HOME forms are built and checked too.
// The case-flip form follows CASELESS for the stand-in and the real folder alike (the temp folder is taken to share
// this file's disk), so both build the same cases.
const refuseCases = (name, mode, root) => cases(mode === 'relative' ? name : `${root}/proj/${name}`, mode === 'relative' ? `${root}/proj` : `${root}/other`, { home: root, caseless: CASELESS })
  .filter((x) => x.expect === 'refuse');

function runOne(i, name, mode, sh, newFolder) {
  const root = realpathSync(newFolder());
  try {
    if (/\/tmp\/[xy]/.test(root)) throw new Error(`temp folder ${root} would confuse the /tmp/x swap`);
    const dir = `${root}/proj`; const other = `${root}/other`; const file = `${dir}/${name}`;
    mkdirSync(dir); mkdirSync(other); writeFileSync(file, CONTENT); writeFileSync(`${root}/srcx`, 'NEW\n');
    const c = refuseCases(name, mode, root)[i];
    const cmd = c.command.replaceAll('/tmp/x', `${root}/srcx`).replaceAll('/tmp/y', `${root}/y`);
    const cwd = c.cwd ?? (mode === 'relative' ? dir : other);
    // Sealed from the user's shell set-up (round 10 audit 4 minor 4): no rc files, HOME inside the folder, a plain PATH.
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, LANG: 'C' }; // node's folder: node -e cases
    const r = spawnSync(sh, [...(sh.endsWith('zsh') ? ['-f'] : []), '-c', cmd], { cwd, env, encoding: 'utf8', timeout: 10000 });
    const seen = (r.stdout ?? '') + readOut(`${root}/y`);
    let changed = true;
    try { changed = lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== CONTENT; } catch { /* gone: changed */ }
    return seen.includes('PLANTED') || seen.includes(B64) || changed;
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (existsSync(root)) throw new Error(`could not remove ${root}`); // never leave test folders behind
  }
}

// mode 'relative': the target is the short name, asked from its folder; 'absolute': the full path, asked from elsewhere.
// newFolder: makes a new empty folder for one run (tests pass tempDir from shared/test-tmp.mjs); each is removed after.
export function touchCheck(name, { mode = 'relative', shells = ['/bin/bash'], newFolder } = {}) {
  if (typeof newFolder !== 'function') throw new Error('touchCheck needs newFolder: a function that makes a new empty folder');
  // The cases reported are those for a stand-in folder of the same shape (same templates and forms, in the same order).
  return refuseCases(name, mode, '/sg-self-root').map((c, i) => ({ ...c, touchedBy: shells.filter((sh) => runOne(i, name, mode, sh, newFolder)) }));
}
