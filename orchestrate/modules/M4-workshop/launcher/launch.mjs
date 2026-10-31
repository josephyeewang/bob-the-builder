// The launcher (design v4 §14.1.3): launch checks 1 to 13, in order. The first check that fails
// stops the launch: no later check runs and the role is never started. Each check is a port, so
// the order and the stop are tested with fakes; the real checks live in the files next to this
// one (worker-copy, outbox, render-settings, readback, hooks-check, env-check). Check 12 (budget,
// caps, disjoint files) is a port into M11, the Dispatcher.

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256 } from './role-profiles.mjs';
import { SETTINGS as S, unconfirmedNames } from './settings-names.mjs';
import { hasShell } from './role-profiles.mjs';
import { checkSettings } from './render-settings.mjs';
import { REVIEW_ROLES, reviewUser } from './review-user.mjs';

const refuse = (reason) => ({ ok: false, reason });

// Which roles each check applies to. A check that does not apply is recorded as skipped.
const WITH_COPY = ['worker', 'writer', 'reviewer', 'auditor'];
export const CHECKS = Object.freeze([
  { n: 1, name: 'fresh copy', applies: (r) => WITH_COPY.includes(r) },
  { n: 2, name: 'setup files put back', applies: (r) => WITH_COPY.includes(r) },
  { n: 3, name: 'outbox emptied', applies: () => true },
  { n: 4, name: 'dependencies installed', applies: (r) => r === 'worker' },
  { n: 5, name: 'role file written and read back', applies: () => true },
  { n: 6, name: 'headless read-back', applies: () => true },
  { n: 7, name: 'hooks and version', applies: () => true },
  { n: 8, name: 'rules snapshot fresh', applies: () => true },
  { n: 9, name: 'no stray keys', applies: () => true },
  { n: 10, name: 'machine-wide production block', applies: () => true },
  // The smoke (break-it) test runs for every role with a shell, so the reviewer's and auditor's
  // sandbox is shown to be on too (audit R-0b-44 M-1); the baseline tests run for the worker only.
  { n: 11, name: 'baseline and smoke inside the lock-down', applies: (r, profile) => r === 'worker' || (profile ? hasShell(profile) : false) },
  { n: 12, name: 'budget, caps and disjoint files', applies: () => true },
  { n: 13, name: 'Bob method folder', applies: (r, profile) => profile?.bobFolder === true },
]);

/**
 * `checks[n]` is an async function (ctx) -> { ok, reason }. A missing port for a check that
 * applies is a refusal, never a pass. `start(ctx)` runs only when every check passed.
 * `names` = { settings, flags, version, confirmed? }: the rendered role file, the start flags and
 * the pinned Claude Code version. Before check 1, any name not confirmed on that version refuses.
 * A reviewer or auditor runs as the review user (L44): `ctx.uids` maps each role to its Mac user id, and a review
 * role with no separate user is refused before any check. `start` gets `runAs` (null for the other roles), and
 * builds its command with review-user.mjs `startCommand`; its outbox comes from `prepareReviewOutbox` (check 3).
 */
export async function launch({ role, profile, checks, start, names, ctx = {} }) {
  const log = [];
  let runAs = null;
  if (REVIEW_ROLES.includes(role)) {
    const who = reviewUser({ role, uids: ctx.uids, ...(ctx.self !== undefined ? { self: ctx.self } : {}) });
    if (!who.ok) return { ok: false, failedAt: 0, reason: `a ${role} runs only as the review user: ${who.reason}`, log };
    runAs = who.runAs;
  }
  const left = names && typeof names === 'object' && names.settings ? unconfirmedNames(names) : ['(no role file given to the names check)'];
  if (left.length) return { ok: false, failedAt: 0, reason: `setting names not confirmed on the pinned Claude Code: ${left.join(', ')}`, log };
  // The object handed in must itself be a locked-down role file, so an empty or partial one cannot pass
  // check 0 (audit R-0b-44 round 2 MIN-1, round 3 MIN-4).
  const locked = checkSettings(names.settings, { profile });
  if (!locked.ok) return { ok: false, failedAt: 0, reason: `the role file given to the names check is not locked down: ${locked.reason}`, log };
  for (const c of CHECKS) {
    if (!c.applies(role, profile)) { log.push({ n: c.n, skipped: true }); continue; }
    const port = checks?.[c.n];
    let r;
    if (typeof port !== 'function') r = refuse('no check is wired');
    else { try { r = await port({ role, profile, ...ctx }); } catch (e) { r = refuse(`the check failed: ${e.message}`); } }
    if (r?.ok !== true) {
      log.push({ n: c.n, ok: false, reason: r?.reason ?? 'no answer' });
      return { ok: false, failedAt: c.n, reason: `launch check ${c.n} (${c.name}): ${r?.reason ?? 'no answer'}`, log };
    }
    log.push({ n: c.n, ok: true });
  }
  const started = await start({ role, profile, ...ctx, runAs });
  return { ok: true, log, started };
}

// ---- Check 4: the install step (R-0b-33) ----

/**
 * Writes the install-phase role file (registry host allowed), runs the install, then writes the
 * session role file without the registry and confirms it is gone. `render(phase)` returns
 * { ok, settings }; `write(settings)` writes and reads back; `install()` runs the install
 * command inside the lock-down.
 */
export async function installStep({ render, write, install, registryHosts }) {
  const during = render('install');
  if (!during.ok) return during;
  const w1 = write(during.settings);
  if (!w1?.ok) return refuse(`install role file: ${w1?.reason ?? 'not written'}`);
  let r; try { r = await install(); } catch (e) { r = refuse(e.message); }
  const after = render('session');
  if (!after.ok) return after;
  const w2 = write(after.settings);
  if (!w2?.ok) return refuse(`session role file: ${w2?.reason ?? 'not written'}`);
  const left = (after.settings[S.sandbox]?.[S.network]?.[S.allowedDomains] ?? []).filter((h) => registryHosts.includes(h));
  if (left.length) return refuse(`the registry is still allowed after the install: ${left.join(', ')}`);
  if (!r?.ok) return refuse(`the install failed: ${r?.reason ?? 'no answer'}`);
  return { ok: true };
}

/** A card that changes the dependency files needs an install at the next round. */
export function needsInstall({ lastInstalledHash, files }) {
  const h = sha256(files.map(([name, text]) => `${name}\0${text}`).sort().join('\0\0'));
  return { needed: h !== lastInstalledHash, hash: h };
}

// ---- Check 13: the Bob method folder (R-0b-31 review 11, C19) ----

function listFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { out.push({ rel: relative(root, p), link: true }); continue; }
      if (st.isDirectory()) walk(p); else out.push({ rel: relative(root, p) });
    }
  };
  walk(root);
  return out;
}

/**
 * The folder is present, holds exactly the files of the pinned Bob commit (`manifest`: path ->
 * sha256), no SKILL.md and nothing under skill/ or skills/, no links, and the role file denies
 * writing it.
 */
export function checkBobFolder({ folder, manifest, settings }) {
  let files;
  try { if (!lstatSync(folder).isDirectory()) return refuse('the Bob folder is not a plain folder'); files = listFiles(folder); } catch { return refuse('the Bob folder is missing'); }
  if (!manifest || typeof manifest !== 'object' || !Object.keys(manifest).length) return refuse('no pinned Bob file list');
  for (const f of files) {
    const parts = f.rel.split(sep);
    if (f.link) return refuse(`the Bob folder holds a link (${f.rel})`);
    if (parts.at(-1).toLowerCase() === 'skill.md') return refuse(`the Bob folder holds a skill (${f.rel})`);
    if (parts.slice(0, -1).some((p) => ['skill', 'skills'].includes(p.toLowerCase()))) return refuse(`the Bob folder holds a skills folder (${f.rel})`);
    if (!Object.hasOwn(manifest, f.rel)) return refuse(`the Bob folder holds a file the pin does not (${f.rel})`);
    if (sha256(readFileSync(join(folder, f.rel))) !== manifest[f.rel]) return refuse(`${f.rel} differs from the pinned Bob commit`);
  }
  const have = new Set(files.map((f) => f.rel));
  const missing = Object.keys(manifest).filter((k) => !have.has(k));
  if (missing.length) return refuse(`the Bob folder is missing ${missing.join(', ')}`);
  const deny = settings?.[S.permissions]?.[S.deny] ?? [];
  const abs = folder.replace(/^\/+/, '');
  if (!deny.includes(`Edit(/${abs}/**)`) || !deny.includes(`Write(/${abs}/**)`)) return refuse('the Bob folder is not attached read-only');
  return { ok: true };
}

// ---- Check 11: baseline and smoke inside the lock-down (R-0b-41) ----

/**
 * The baseline and smoke runs go through the worker's own start: the worker's settings file,
 * the owner's user (no user switch), only the Bash tool. `roleArgs` builds the start command.
 */
export function lockedRunCommand({ claudeBin, settingsFile, command, roleArgs, profile }) {
  if (typeof command !== 'string' || !command.trim()) return refuse('no command declared');
  const args = roleArgs({ profile: { ...profile, tools: ['Bash'] }, settingsFile, prompt: `Run exactly this shell command once and report its exit code: ${command}` });
  return { ok: true, bin: claudeBin, args, spawnOptions: {} }; // no uid or gid: runs as the launcher's own user
}

/**
 * The smoke test runs one declared command, prefixed with a variable, that tries to write
 * outside the copy and to reach github.com. `run()` returns { exitCode, networkReached }; the
 * marker is the file it tries to write. Both attempts must fail.
 */
export async function smokeTest({ run, markerExists }) {
  let r; try { r = await run(); } catch (e) { return refuse(`the smoke run did not finish: ${e.message}`); }
  if (markerExists()) return refuse('the smoke command wrote outside the copy');
  if (r?.networkReached !== false) return refuse('the smoke command reached the network (or could not say)');
  return { ok: true };
}

/** The baseline test must pass inside the lock-down before the role starts. */
export async function baselineTest({ run }) {
  let r; try { r = await run(); } catch (e) { return refuse(`the baseline run did not finish: ${e.message}`); }
  if (r?.exitCode !== 0) return refuse(`the baseline tests failed inside the lock-down (exit ${r?.exitCode})`);
  return { ok: true };
}
