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

// Runs one shell command in a process group of its own (perl's setpgrp, then exec, so the shell keeps its pid and leads
// the group), so a timeout kills every process the case started, not only the shell: a killed attempt's child can't
// write after its folder is gone (L117 m-4). The group is killed after a normal exit too, so a child the case left in
// the background can't either (L124 c1). Without perl it runs the shell alone.
const PERL = ['/usr/bin/perl', '/bin/perl'].find((f) => existsSync(f));
const GROUP = 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV; print STDERR "selfcheck-exec-failed: $!\\n"; exit 127';
// → { r, unsure }: unsure when the run can't say what it did: any spawn error (a timeout, ENOENT, EAGAIN under load,
// ENOBUFS), a kill signal without a normal exit, or the wrapper failing to start the shell (L117 m-3).
export function runShell(sh, args, { cwd, env, timeout }) {
  const argv = PERL ? [PERL, ['-e', GROUP, sh, ...args]] : [sh, args];
  const r = spawnSync(argv[0], argv[1], { cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  if (PERL && r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* the group is gone */ } }
  const unsure = Boolean(r.error) || (r.signal !== null && r.signal !== undefined) || r.status === null || (PERL && r.status === 127 && (r.stderr ?? '').startsWith('selfcheck-exec-failed: '));
  return { r, unsure };
}

export const TIMEOUTS = Object.freeze([10_000, 60_000, 120_000]);

function attempt(i, name, mode, sh, newFolder, timeout) {
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
    const { r, unsure } = runShell(sh, [...(sh.endsWith('zsh') ? ['-f'] : []), '-c', cmd], { cwd, env, timeout });
    if (unsure) return { unsure: true, command: c.command, why: r.error?.code ?? r.signal ?? `exit ${r.status}` };
    const seen = (r.stdout ?? '') + readOut(`${root}/y`);
    let changed = true;
    try { changed = lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== CONTENT; } catch { /* gone: changed */ }
    return { touched: seen.includes('PLANTED') || seen.includes(B64) || changed };
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (existsSync(root)) throw new Error(`could not remove ${root}`); // never leave test folders behind
  }
}

// A run that can't say whether it touched the file (L95: under the load of two suites at once a 10 s limit cut
// `node -e` runs short and they were reported as dead; L117 m-3: any other failure to run, too) is never counted as
// "touched nothing": it is run again, in a new folder (L117 m-4: the killed attempt's leftovers stay in its own), with
// more time, and if it still can't tell, the check stops with that case named.
function runOne(i, name, mode, sh, newFolder, timeouts) {
  let last;
  for (const timeout of timeouts) {
    last = attempt(i, name, mode, sh, newFolder, timeout);
    if (!last.unsure) return last.touched;
  }
  throw new Error(`could not tell, ${sh} could not run it ${timeouts.length} times (${last.why}): ${last.command}`);
}

// mode 'relative': the target is the short name, asked from its folder; 'absolute': the full path, asked from elsewhere.
// newFolder: makes a new empty folder for one run (tests pass tempDir from shared/test-tmp.mjs); each is removed after.
// timeouts: one per attempt (the default 10, 60 and 120 s); a test passes short ones.
export function touchCheck(name, { mode = 'relative', shells = ['/bin/bash'], newFolder, timeouts = TIMEOUTS } = {}) {
  if (typeof newFolder !== 'function') throw new Error('touchCheck needs newFolder: a function that makes a new empty folder');
  // The cases reported are those for a stand-in folder of the same shape (same templates and forms, in the same order):
  // a new folder of its own for each call, never a fixed path, so two suites can run at once (L95). It is only named in
  // the cases, never written to, and is removed after.
  const stand = realpathSync(newFolder());
  try {
    return refuseCases(name, mode, stand).map((c, i) => ({ ...c, touchedBy: shells.filter((sh) => runOne(i, name, mode, sh, newFolder, timeouts)) }));
  } finally {
    rmSync(stand, { recursive: true, force: true });
    if (existsSync(stand)) throw new Error(`could not remove ${stand}`);
  }
}
