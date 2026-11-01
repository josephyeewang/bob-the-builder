// selfcheck.mjs — does each refuse case really touch the protected file? (0b-7 round 10; for Bob's own tests.)
//
// A refuse case that no shell turns into a read or write of the file proves nothing: a guard "passes" it by refusing,
// and a precise guard that allows it is marked wrong. This runs every refuse case against a planted file, under each
// shell given, each run in its own new throwaway folder (a leftover from one case, such as sed's .bak, changes what
// a glob matches in the next: round 10 audit 2 M-1). It never runs a case outside that folder: the cases are built for it,
// and the corpus's /tmp/x and /tmp/y are swapped for files inside it.
//
// Several runs go at once (each in its own folder, so they can't meet), and the whole check has a time budget: past it
// the check fails, "guard not verified", and never passes (lead, M12 speed, 1 Nov 2026).

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
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
// write after its folder is gone (L117 m-4). The group is killed once the shell exits too, so a child the case left in
// the background can't either (L124 c1). Without perl it runs the shell alone.
const PERL = ['/usr/bin/perl', '/bin/perl'].find((f) => existsSync(f));
const GROUP = 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV; print STDERR "selfcheck-exec-failed: $!\\n"; exit 127';
const MAX_OUT = 1024 * 1024; // spawnSync's default buffer; past it the run is unsure, as spawnSync's ENOBUFS was
// → Promise<{ r, unsure }>, r in spawnSync's shape. unsure when the run can't say what it did: any spawn error (ENOENT,
// EAGAIN under load), a timeout, output past MAX_OUT, a kill signal without a normal exit, or the wrapper failing to
// start the shell (L117 m-3). It runs in the background so several cases can run at once.
export function runShell(sh, args, { cwd, env, timeout }) {
  const argv = PERL ? [PERL, ['-e', GROUP, sh, ...args]] : [sh, args];
  return new Promise((done) => {
    let error = null; let stdout = ''; let stderr = ''; let status = null; let signal = null;
    let child;
    try { child = spawn(argv[0], argv[1], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { done({ r: { error: e, stdout, stderr, status, signal }, unsure: true }); return; }
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(PERL ? -child.pid : child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const stop = (code, message) => { if (!error) error = Object.assign(new Error(message), { code }); killGroup(); };
    const timer = setTimeout(() => stop('ETIMEDOUT', `timed out after ${timeout} ms`), timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > MAX_OUT) stop('ENOBUFS', 'too much output'); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > MAX_OUT) stop('ENOBUFS', 'too much output'); });
    child.on('error', (e) => { if (!error) error = e; });
    // The shell has exited: kill the rest of its group now (L124 c1), so a background child can't write later or hold
    // the pipes open; 'close' comes once the pipes are drained.
    child.on('exit', (code, sig) => { status = code; signal = sig; killGroup(); });
    child.on('close', () => {
      clearTimeout(timer);
      const r = { error: error ?? undefined, stdout, stderr, status, signal, pid: child.pid };
      const unsure = Boolean(error) || (signal !== null && signal !== undefined) || status === null || Boolean(PERL && status === 127 && stderr.startsWith('selfcheck-exec-failed: '));
      done({ r, unsure });
    });
  });
}

// Removes a run's folder, retrying a while (a shell's last child can still be closing files in it under load: one
// removal failed with ENOTEMPTY in a full suite, 1 Nov 2026), and says so when it still can't: never leave test folders
// behind, and never hide that one was.
export function removeFolder(root) {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { throw new Error(`could not remove ${root}: ${e.code ?? e.message}`); }
  if (existsSync(root)) throw new Error(`could not remove ${root}: it is still there`);
}

export const TIMEOUTS = Object.freeze([10_000, 30_000, 60_000]);
// The whole check's time. Past it the check fails, "guard not verified": a slow machine fails it, never passes it.
export const BUDGET_MS = 20 * 60_000;
// Runs at once: half the cores, at most 6, at least 1.
export const AT_ONCE = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));

async function attempt(i, name, mode, sh, newFolder, timeout) {
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
    const { r, unsure } = await runShell(sh, [...(sh.endsWith('zsh') ? ['-f'] : []), '-c', cmd], { cwd, env, timeout });
    if (unsure) return { unsure: true, command: c.command, why: r.error?.code ?? r.signal ?? `exit ${r.status}` };
    const seen = (r.stdout ?? '') + readOut(`${root}/y`);
    let changed = true;
    try { changed = lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== CONTENT; } catch { /* gone: changed */ }
    return { touched: seen.includes('PLANTED') || seen.includes(B64) || changed };
  } finally {
    removeFolder(root);
  }
}

// A run that can't say whether it touched the file (L95: under the load of two suites at once a 10 s limit cut
// `node -e` runs short and they were reported as dead; L117 m-3: any other failure to run, too) is never counted as
// "touched nothing": it is run again, in a new folder (L117 m-4: the killed attempt's leftovers stay in its own), with
// more time, and if it still can't tell, the check stops with that case named. No attempt runs past the budget: one
// that would is cut to the time left, and if it is then unsure, or no time is left, the check is out of time.
async function runOne(i, name, mode, sh, newFolder, timeouts, clock) {
  let last;
  for (const timeout of timeouts) {
    const left = clock.deadline - Date.now();
    if (left <= 0) throw clock.out();
    last = await attempt(i, name, mode, sh, newFolder, Math.min(timeout, left));
    if (!last.unsure) return last.touched;
    if (timeout >= left) throw clock.out();
  }
  throw new Error(`could not tell, ${sh} could not run it ${timeouts.length} times (${last.why}): ${last.command}`);
}

// mode 'relative': the target is the short name, asked from its folder; 'absolute': the full path, asked from elsewhere.
// newFolder: makes a new empty folder for one run (tests pass tempDir from shared/test-tmp.mjs); each is removed after.
// timeouts: one per attempt (default 10, 30 and 60 s); budgetMs: the whole check's time (default 20 min); atOnce: runs
// at once. A test passes small ones. → Promise of the cases, each with touchedBy. It rejects, never resolves, when the
// check runs out of time ("guard not verified") or can't tell.
export async function touchCheck(name, { mode = 'relative', shells = ['/bin/bash'], newFolder, timeouts = TIMEOUTS, budgetMs = BUDGET_MS, atOnce = AT_ONCE } = {}) {
  if (typeof newFolder !== 'function') throw new Error('touchCheck needs newFolder: a function that makes a new empty folder');
  // The cases reported are those for a stand-in folder of the same shape (same templates and forms, in the same order):
  // a new folder of its own for each call, never a fixed path, so two suites can run at once (L95). It is only named in
  // the cases, never written to, and is removed after.
  const stand = realpathSync(newFolder());
  try {
    const list = refuseCases(name, mode, stand);
    const jobs = list.flatMap((c, i) => shells.map((sh) => ({ i, sh })));
    const touched = list.map(() => new Set());
    let next = 0; let finished = 0; let failure = null;
    const clock = { deadline: Date.now() + budgetMs, out: () => new Error(`guard not verified: the self-check ran out of time (${budgetMs} ms) after ${finished} of ${jobs.length} runs`) };
    // Each worker takes the next run until none is left or one has failed; the others finish the run they are on (so its
    // folder is removed) and stop. The first failure is the one reported.
    const worker = async () => {
      while (!failure && next < jobs.length) {
        const { i, sh } = jobs[next++];
        try {
          if (await runOne(i, name, mode, sh, newFolder, timeouts, clock)) touched[i].add(sh);
          finished++;
        } catch (e) { failure ??= e; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(atOnce, jobs.length)) }, worker));
    if (failure) throw failure;
    if (finished !== jobs.length) throw new Error(`guard not verified: ${finished} of ${jobs.length} runs finished`);
    return list.map((c, i) => ({ ...c, touchedBy: shells.filter((sh) => touched[i].has(sh)) }));
  } finally {
    removeFolder(stand);
  }
}
