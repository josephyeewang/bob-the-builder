#!/usr/bin/env node
// front-door.mjs — start the Front Door in a Ghostty tab (Track A step 6; design v4 §10.0 and §16.4's M1 row).
//
// Run as the owner (Joe's own Mac user, never root, never sudo), in a Ghostty tab, with Mac dictation as it is:
//   node /Library/orchestrate/install/orchestrate/setup/front-door.mjs start <product> [--setup <setup.json>]
//
// What it does, in order; any refusal stops it before claude starts, and says why in plain words:
//   1. reads the setup config (/Library/orchestrate-setup.json unless --setup) and the installed copy's review.json (the
//      pinned claude, the hooks, the rules), which must be this product's;
//   2. makes this start's outbox, <outboxRoot>/front_door/fd-<product>-<time> (M1 sessions.mjs): its name is what makes
//      the product's Dispatcher take the ideas filed there (intake, as a front_door session whose files are the owner's);
//   3. renders the Front Door's settings from its locked role profile (M4 role-profiles.mjs DESIGN_PROFILES.front_door,
//      render-settings.mjs renderRoleSettings) and writes them into the outbox as .settings.json, which intake skips and
//      the AI can't change (the settings deny it any dot-file in its outbox);
//   4. runs launch check 6 on the pin (M4 readback.mjs readBack): the role started headless, its start message compared
//      with the full profile (tools, no tool server, no plugin, its skills, the settings sources, the permission mode,
//      the version). A mismatch removes the outbox and starts nothing;
//   5. starts claude in the tab with the same settings and flags, in the outbox, with the terminal handed to it as is
//      (no tmux, no screen reading).
//
// The Front Door's skill (L1334, ruled option a): with the settings sources limited to none (--setting-sources ""),
// claude 2.1.316 loads no skill but through --plugin-dir, which check 6 refuses as a plugin (checked: claude-code
// 2.1.316, 2026-11-23). So the profile has no Skill tool and no skills, and every start, check 6's and the tab's, gives
// the skill's text as part of the prompt (--append-system-prompt-file, the installed copy's own root-owned SKILL.md).
// A profile that still names a skill or the Skill tool is refused before anything is made.
//
//   6. step 7: while claude runs, keeps .filed.md in the outbox, what this tab filed read from the Record (M1 filed.mjs),
//      for the Front Door to read back when asked; prints the same read-back in the tab when the session ends.
//
//   node …/setup/front-door.mjs filed <product> [--setup <setup.json>]
// prints what the product's latest tabs filed, from the Record, at any time (step 7).
//
// Not here: the go (step 9, setup/go.mjs, through sudo).

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { renderRoleSettings } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { readBack, roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { FLAGS as F, noToolServerArgs, sourcesArgs } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { NODE, RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { FRONT_DOOR_ROLE, frontDoorFolder, frontDoorSessionId, frontDoorSessions } from '../modules/M1-front-door/sessions.mjs';
import { FILED_NAME, readFiled } from '../modules/M1-front-door/filed.mjs';
import { installPaths } from './install.mjs';
import { ROOT_CONFIG_PATH, keysPath, outboxRootPath, ownerTapsPath, privatePath, proposalsParentOf, storePath, workerRulesPath } from './layout.mjs';

/** The setup config root reads (layout.mjs's one name for it). */
export const SETUP_FILE = ROOT_CONFIG_PATH;
export const SETTINGS_NAME = '.settings.json';
/** The skill's text in the installed copy (root's, so the AI can't change what it is told). */
export const SKILL_FILE = join('modules', 'M1-front-door', 'skill', 'orchestrate', 'SKILL.md');
/** The tap handler's config file (render-settings walls it off from the Front Door). No tap handler is set up yet. */
export const REVIEW_AGAIN_FILE = 'review-again.json';
/** The model the role file names (M10 roles/front_door.json). */
export const FRONT_DOOR_MODEL = 'sonnet';
export const USAGE = 'usage: node front-door.mjs start|filed <product> [--setup <setup.json>]';
/** How many of the product's latest tabs `filed` reads back. */
export const FILED_TABS = 5;
/** How often the tab's .filed.md is read again from the Record while the session runs. */
export const FILED_EVERY_MS = 15_000;

const fullPath = (p) => typeof p === 'string' && p.startsWith('/');

/**
 * Everything the start needs, from the setup config and the installed review.json. → { ok: true, places } | { ok: false, reason }.
 * `rc` is review.json as read; its rules must be this product's (its recordRoot is the product's Record).
 */
export function frontDoorPlaces(cfg, rc, { product, ownerHome }) {
  const no = (reason) => ({ ok: false, reason });
  if (!cfg || typeof cfg.base !== 'string') return no('the setup config names no base folder');
  const products = Array.isArray(cfg.products) ? cfg.products : [];
  if (!products.includes(product)) return no(`the setup config does not list the product ${product} (it lists ${products.join(', ') || 'none'})`);
  if (!rc || typeof rc !== 'object') return no(`the installed copy's ${RUNNER_CONFIG} can't be used`);
  if (!fullPath(rc.claudeBin) || !fullPath(rc.hooksDir)) return no(`the installed copy's ${RUNNER_CONFIG} names no pinned claude or hooks folder: run review-config and add-to-install first`);
  const recordRoot = storePath(cfg, product);
  if (rc.recordRoot !== recordRoot) return no(`the installed copy's ${RUNNER_CONFIG} is for another product's Record, so its rules are not ${product}'s`);
  if (!Number.isSafeInteger(rc.recordUid) || rc.recordUid < 0) return no(`the installed copy's ${RUNNER_CONFIG} names no Record owner (recordUid), so what was filed can't be read back`);
  const rules = rc.rules ?? {};
  const prodFiles = Array.isArray(rules.production?.env_files) ? rules.production.env_files : [];
  const secretPaths = Array.isArray(rules.secrets?.paths) ? rules.secrets.paths : [];
  if (!fullPath(ownerHome)) return no('the owner has no plain home folder');
  const d = cfg.dispatcher ?? {};
  const secrets = [...new Set([...secretPaths, ...prodFiles].filter(fullPath).concat([privatePath(cfg), d.rulesStateDir, d.approvalsStateDir, ownerHome].filter(fullPath)))];
  const installRoot = installPaths(cfg).installRoot;
  const proposals = products.map((p) => join(proposalsParentOf(cfg), p));
  return { ok: true, places: {
    product, installRoot, claudeBin: rc.claudeBin, pin: rc.pin, outboxRoot: outboxRootPath(cfg), recordRoot, recordUid: rc.recordUid,
    skillFile: join(installRoot, SKILL_FILE), productionFiles: [...prodFiles], proposalOutboxes: proposals,
    paths: {
      hooksDir: rc.hooksDir, node: join(installRoot, NODE), snapshot: workerRulesPath(cfg, product), snapshotOwner: 0,
      ownerTaps: ownerTapsPath(cfg), reviewAgainConfig: join(cfg.base, REVIEW_AGAIN_FILE),
      ...(fullPath(rc.bobFolder) ? { bobFolder: rc.bobFolder } : {}),
      deny: { record: recordRoot, secrets, claudeHome: join(ownerHome, '.claude'), ssh: join(ownerHome, '.ssh'), gh: join(ownerHome, '.config', 'gh'), robotKeys: keysPath(cfg), proposals },
    },
  } };
}

/** A profile that names a skill or the Skill tool (L1334: the skill is prompt text only). → the reason, or null. */
export const skillProblem = (profile) => (profile.tools.includes('Skill') || (profile.skills ?? []).length
  ? 'the Front Door\'s profile names a skill or the Skill tool, and its skill is given as prompt text only (L1334)' : null);

/** The interactive start: the role's flags as check 6 read them back, without the headless ones, plus the session's own. */
export function interactiveArgs({ profile, settingsFile, model, sessionUuid, name, skillFile }) {
  const a = [F.tools, profile.tools.join(','), F.settings, settingsFile, ...sourcesArgs(), ...noToolServerArgs(), F.permissionMode, profile.mode];
  if (profile.restricted) a.push(F.restricted);
  if (model) a.push(F.model, model);
  a.push('--session-id', sessionUuid, '--name', name, '--append-system-prompt-file', skillFile);
  return a;
}

/** The headless args for check 6: roleArgs, with the skill's prompt file as the tab has it, the prompt kept last. */
function checkArgs({ profile, settingsFile, model, skillFile }) {
  const a = roleArgs({ profile, settingsFile, model });
  return [...a.slice(0, -1), '--append-system-prompt-file', skillFile, a.at(-1)];
}

/** The environment claude gets: the tab's own basics, nothing else. */
export function frontDoorEnv(env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'];
  return Object.fromEntries(keep.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k]]));
}

/** The setup config and the installed copy's rules, read and checked as the owner. → { ok, places } | { ok: false, reason } */
function placesFor({ product, setupFile }, io) {
  const no = (reason) => ({ ok: false, reason });
  if (io.uid === 0) return no('it runs as root: start the Front Door as your own Mac user, in a Ghostty tab, with no sudo');
  let cfg; try { cfg = JSON.parse(io.readText(setupFile)); } catch (e) { return no(`the setup config ${setupFile} can't be read (${e?.code ?? e?.message})`); }
  if (cfg?.owner !== io.user) return no(`the Front Door is the owner's (${cfg?.owner ?? 'none named'}), and this is ${io.user}`);
  const installRoot = installPaths(cfg).installRoot;
  let rc; try { rc = JSON.parse(io.readText(join(installRoot, RUNNER_CONFIG))); } catch (e) { return no(`the installed copy's ${RUNNER_CONFIG} can't be read (${e?.code ?? e?.message})`); }
  return frontDoorPlaces(cfg, rc, { product, ownerHome: io.home });
}

/**
 * The start, with every outside thing a port so a test can stand in. → { ok: true, sessionId, outbox, code } once claude
 * has ended, with `filed`, the read-back of what the tab filed (step 7), or { ok: false, reason } with nothing left behind.
 * io: { readText, mkdir, writeFile, rm, uid, user, home, env, now, check (readBack), run (interactive spawn → exit code),
 *   putFiled (path, text), every (fn, ms) → timer, stop (timer); readFiled for a test }
 */
export async function startFrontDoor({ product, setupFile = SETUP_FILE, profile = DESIGN_PROFILES[FRONT_DOOR_ROLE], model = FRONT_DOOR_MODEL }, io) {
  const no = (reason) => ({ ok: false, reason });
  const sp = skillProblem(profile);
  if (sp) return no(sp);
  const pl = placesFor({ product, setupFile }, io);
  if (!pl.ok) return pl;
  const P = pl.places;
  let sessionId; try { sessionId = frontDoorSessionId(product, new Date(io.now())); } catch (e) { return no(e.message); }
  const outbox = join(frontDoorFolder(P.outboxRoot), sessionId);
  const r = renderRoleSettings({ role: FRONT_DOOR_ROLE, profile, paths: { ...P.paths, outbox }, productionFiles: P.productionFiles, proposalOutboxes: P.proposalOutboxes });
  if (!r.ok) return no(`the Front Door's settings can't be made (${r.reason})`);
  try { io.mkdir(outbox, 0o750); } catch (e) { return no(`the outbox ${outbox} can't be made (${e?.code ?? e?.message}); is the Front Door folder set up (users-folders)?`); }
  const undo = (reason) => { try { io.rm(outbox); } catch { /* left; it holds no idea */ } return no(reason); };
  const settingsFile = join(outbox, SETTINGS_NAME);
  try { io.writeFile(settingsFile, `${JSON.stringify(r.settings, null, 1)}\n`, 0o600); } catch (e) { return undo(`the settings can't be written (${e?.code ?? e?.message})`); }
  const env = frontDoorEnv(io.env);
  // A check that throws is a refusal too: the folder goes, so intake never takes a tab that never ran (#657 audit m4).
  let c6;
  try { c6 = await io.check({ claudeBin: P.claudeBin, args: checkArgs({ profile, settingsFile, model, skillFile: P.skillFile }), env, cwd: outbox, role: FRONT_DOOR_ROLE, profile, pin: P.pin }); }
  catch (e) { c6 = { ok: false, reason: `it failed (${String(e?.message ?? e).slice(0, 200)})` }; }
  if (!c6?.ok) return undo(`launch check 6 refused the Front Door: ${c6?.reason ?? 'no answer'}. Nothing was started`);
  // Step 7: while the session runs, .filed.md in its folder holds what it filed, read again from the Record every
  // FILED_EVERY_MS. The AI reads it when the owner asks; the settings deny it any write to a dot-file there.
  const filedNow = () => (io.readFiled ?? readFiled)({ outbox, sessionId, recordRoot: P.recordRoot, recordUid: P.recordUid }).text;
  const refresh = () => { try { io.putFiled(join(outbox, FILED_NAME), `${filedNow()}\n`); } catch { /* the next round tries again */ } };
  refresh();
  const timer = io.every(refresh, FILED_EVERY_MS);
  let code;
  try { code = await io.run(P.claudeBin, interactiveArgs({ profile, settingsFile, model, sessionUuid: io.uuid(), name: `Front Door ${product}`, skillFile: P.skillFile }), { cwd: outbox, env }); } finally { io.stop(timer); }
  // Step 7: what the tab filed, from the Record, in the tab once the session ends.
  // A read that throws can't take the session's end with it (#658 audit m4): the tab says so and points to `filed`.
  let filed;
  try { filed = filedNow(); } catch (e) { filed = `What this tab filed can't be read now (${String(e?.message ?? e).slice(0, 200)}). Type \`node …/setup/front-door.mjs filed ${product}\` to read it later.`; }
  return { ok: true, sessionId, outbox, code, filed };
}

/**
 * Step 7: what the product's latest Front Door tabs filed, from the Record, newest first. → { ok, text } | { ok: false, reason }
 * io: as startFrontDoor's, plus readFiled and listTabs (frontDoorSessions' list port) for a test.
 */
export function filedTabs({ product, setupFile = SETUP_FILE }, io) {
  const pl = placesFor({ product, setupFile }, io);
  if (!pl.ok) return pl;
  const P = pl.places;
  let tabs;
  try { tabs = frontDoorSessions({ outboxRoot: P.outboxRoot, product, uid: io.uid, ...(io.listTabs ? { list: io.listTabs } : {}) }); } catch (e) { return { ok: false, reason: `the Front Door folder can't be listed (${e?.code ?? e?.message})` }; }
  if (!tabs.length) return { ok: true, text: `No Front Door tab has been started for ${product}.` };
  const latest = tabs.sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1)).slice(0, FILED_TABS);
  const read = io.readFiled ?? readFiled;
  return { ok: true, text: latest.map((t) => read({ outbox: t.outbox, sessionId: t.sessionId, recordRoot: P.recordRoot, recordUid: P.recordUid }).text).join('\n') };
}

/** The real ports. */
export function realIo() {
  const u = userInfo();
  return {
    readText: (f) => readFileSync(f, 'utf8'),
    mkdir: (d, mode) => { mkdirSync(d, { mode }); chmodSync(d, mode); },
    writeFile: (f, text, mode) => { writeFileSync(f, text, { mode, flag: 'wx' }); },
    rm: (d) => rmSync(d, { recursive: true, force: true }),
    uid: process.getuid(), user: u.username, home: u.homedir, env: process.env, now: () => Date.now(), uuid: () => randomUUID(),
    check: (x) => readBack(x),
    // .filed.md: written whole under a temp name, then renamed, so a read never sees half of it.
    putFiled: (f, text) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, text, { mode: 0o600 }); renameSync(t, f); },
    every: (fn, ms) => setInterval(fn, ms), stop: (t) => clearInterval(t),
    run: (bin, args, { cwd, env }) => new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, env, stdio: 'inherit' });
      child.on('error', () => resolve(127));
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    }),
  };
}

export async function main(argv, io = realIo(), print = (s) => process.stderr.write(`${s}\n`)) {
  const [cmd, product, ...rest] = argv;
  const i = rest.indexOf('--setup');
  if (!['start', 'filed'].includes(cmd) || !product || (i >= 0 && !rest[i + 1])) { print(USAGE); return 2; }
  if (cmd === 'filed') {
    const f = filedTabs({ product, ...(i >= 0 ? { setupFile: rest[i + 1] } : {}) }, io);
    print(f.ok ? f.text : `What the Front Door filed can't be read: ${f.reason}`);
    return f.ok ? 0 : 1;
  }
  const r = await startFrontDoor({ product, ...(i >= 0 ? { setupFile: rest[i + 1] } : {}) }, io);
  if (!r.ok) { print(`The Front Door did not start: ${r.reason}`); return 1; }
  print(`The Front Door session ${r.sessionId} ended. What it filed stays in ${r.outbox} until the Dispatcher has taken it.`);
  print(r.filed);
  return r.code === 0 ? 0 : 1;
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
