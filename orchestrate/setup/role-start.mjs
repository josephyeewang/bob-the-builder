// role-start.mjs — the start of an AI session the owner runs on a locked design profile, shared by the Front Door's tab
// (front-door.mjs, Track A step 6) and the one-shot Lead (lead.mjs, step 8 G4, L1370), so neither copies the other.
//
// Run as the owner (Joe's own Mac user, never root). In order; any refusal stops it before claude starts:
//   1. readSetup: the setup config (/Library/orchestrate-setup.json unless --setup) and the installed copy's review.json
//      (the pinned claude, the hooks, the rules), which must be this product's (rolePlaces);
//   2. prepareStart: renders the role's settings from its locked profile (M4 render-settings.mjs renderRoleSettings),
//      makes the session's outbox (0750) and, when the role keeps one, its notes folder (0700); writes the settings in
//      the outbox as .settings.json, and any other start files the caller names (each a dot-name: intake skips them, and
//      the settings deny the AI any write to a dot-file in its outbox);
//   3. runs launch check 6 on the pin (M4 readback.mjs readBack) with the same flags and in the same folder as the real
//      start: the role started headless, its start message compared with the full profile. A mismatch, or a check that
//      throws, removes what step 2 made and starts nothing.
// The caller then starts claude itself: the Front Door interactive in the tab, the Lead headless.

import { join } from 'node:path';
import { checkSettings, renderRoleSettings } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { FLAGS as F, noToolServerArgs, sourcesArgs } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { NODE, RUNNER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { installPaths } from './install.mjs';
import { ROOT_CONFIG_PATH, keysPath, outboxRootPath, ownerTapsPath, privatePath, proposalsParentOf, storePath, workerRulesPath } from './layout.mjs';

/** The setup config root reads (layout.mjs's one name for it). */
export const SETUP_FILE = ROOT_CONFIG_PATH;
export const SETTINGS_NAME = '.settings.json';
/** The tap handler's config file (render-settings walls it off from the Front Door). No tap handler is set up yet. */
export const REVIEW_AGAIN_FILE = 'review-again.json';
export const PROMPT_FILE_FLAG = '--append-system-prompt-file';

const fullPath = (p) => typeof p === 'string' && p.startsWith('/');

/**
 * Everything a start needs, from the setup config and the installed review.json. → { ok: true, places } | { ok: false, reason }.
 * `rc` is review.json as read; its rules must be this product's (its recordRoot is the product's Record).
 */
export function rolePlaces(cfg, rc, { product, ownerHome }) {
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
    productionFiles: [...prodFiles], proposalOutboxes: proposals,
    paths: {
      hooksDir: rc.hooksDir, node: join(installRoot, NODE), snapshot: workerRulesPath(cfg, product), snapshotOwner: 0,
      ownerTaps: ownerTapsPath(cfg), reviewAgainConfig: join(cfg.base, REVIEW_AGAIN_FILE),
      ...(fullPath(rc.bobFolder) ? { bobFolder: rc.bobFolder } : {}),
      deny: { record: recordRoot, secrets, claudeHome: join(ownerHome, '.claude'), ssh: join(ownerHome, '.ssh'), gh: join(ownerHome, '.config', 'gh'), robotKeys: keysPath(cfg), proposals },
    },
  } };
}

/**
 * The setup config and the installed copy's rules, read and checked as the owner. `who` names the session in the
 * refusals ("the Front Door"), `howToRun` says how to start it instead when it runs as root.
 * → { ok: true, places, cfg } | { ok: false, reason }
 */
export function readSetup({ product, setupFile, who, howToRun }, io) {
  const no = (reason) => ({ ok: false, reason });
  if (io.uid === 0) return no(`it runs as root: ${howToRun}`);
  let cfg; try { cfg = JSON.parse(io.readText(setupFile)); } catch (e) { return no(`the setup config ${setupFile} can't be read (${e?.code ?? e?.message})`); }
  if (cfg?.owner !== io.user) return no(`${who} is the owner's (${cfg?.owner ?? 'none named'}), and this is ${io.user}`);
  const installRoot = installPaths(cfg).installRoot;
  let rc; try { rc = JSON.parse(io.readText(join(installRoot, RUNNER_CONFIG))); } catch (e) { return no(`the installed copy's ${RUNNER_CONFIG} can't be read (${e?.code ?? e?.message})`); }
  const r = rolePlaces(cfg, rc, { product, ownerHome: io.home });
  return r.ok ? { ...r, cfg } : r;
}

/** The environment claude gets: the owner's own basics, nothing else. */
export function roleEnv(env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'];
  return Object.fromEntries(keep.filter((k) => typeof env[k] === 'string').map((k) => [k, env[k]]));
}

/** The role's own walls as flags, for every start: its tools, settings, no settings source or tool server, its mode. */
export function roleFlags({ profile, settingsFile, model }) {
  const a = [F.tools, profile.tools.join(','), F.settings, settingsFile, ...sourcesArgs(), ...noToolServerArgs(), F.permissionMode, profile.mode];
  if (profile.restricted) a.push(F.restricted);
  if (model) a.push(F.model, model);
  return a;
}

/** The headless args for check 6: roleArgs, with the real start's effort and prompt file, the prompt kept last. */
export function checkArgs({ profile, settingsFile, model, effort, promptFile }) {
  const a = roleArgs({ profile, settingsFile, model });
  return [...a.slice(0, -1), ...(effort ? [F.effort, effort] : []), PROMPT_FILE_FLAG, promptFile, a.at(-1)];
}

/**
 * Steps 2 and 3 above. `places` is readSetup's; `outbox` the session's folder; `cwd` the folder claude starts in (the
 * outbox unless given); `notes` the role's notes folder, when it keeps one apart from the outbox; `paths` more of the
 * renderer's paths; `files` [[dot-name, text]] written in the outbox after the settings; `promptFile` the file check 6
 * and the start both append to the system prompt. → { ok: true, settingsFile, env } | { ok: false, reason }, with
 * nothing left behind on a refusal.
 * io: { mkdir, writeFile, rm, env, check (readBack) }
 */
export async function prepareStart({ role, who, profile, model, effort, places: P, outbox, cwd = outbox, notes, paths = {}, files = [], promptFile }, io) {
  const no = (reason) => ({ ok: false, reason });
  const r = renderRoleSettings({ role, profile, paths: { ...P.paths, ...paths, outbox, ...(notes ? { notes } : {}) }, productionFiles: P.productionFiles, proposalOutboxes: P.proposalOutboxes });
  if (!r.ok) return no(`${who}'s settings can't be made (${r.reason})`);
  // The written-settings check every role file meets, told the role (#682 r1 m6: only the Lead may add a code folder).
  const ck = checkSettings(r.settings, { profile, role });
  if (!ck.ok) return no(`${who}'s settings were refused (${ck.reason})`);
  try { io.mkdir(outbox, 0o750); } catch (e) { return no(`the outbox ${outbox} can't be made (${e?.code ?? e?.message}); is ${who} folder set up (users-folders)?`); }
  const made = [outbox];
  const undo = (reason) => { for (const d of made) { try { io.rm(d); } catch { /* left; it holds nothing filed */ } } return no(reason); };
  if (notes) {
    try { io.mkdir(notes, 0o700); made.push(notes); } catch (e) { return undo(`the notes folder ${notes} can't be made (${e?.code ?? e?.message})`); }
  }
  const settingsFile = join(outbox, SETTINGS_NAME);
  try { io.writeFile(settingsFile, `${JSON.stringify(r.settings, null, 1)}\n`, 0o600); } catch (e) { return undo(`the settings can't be written (${e?.code ?? e?.message})`); }
  for (const [name, text] of files) {
    if (!/^\.[A-Za-z0-9._-]+$/.test(name)) return undo(`a start file must have a dot-name, not ${name}`);
    try { io.writeFile(join(outbox, name), text, 0o600); } catch (e) { return undo(`${name} can't be written (${e?.code ?? e?.message})`); }
  }
  const env = roleEnv(io.env);
  // A check that throws is a refusal too: the folder goes, so intake never takes a session that never ran (#657 audit m4).
  let c6;
  try { c6 = await io.check({ claudeBin: P.claudeBin, args: checkArgs({ profile, settingsFile, model, effort, promptFile }), env, cwd, role, profile, pin: P.pin }); }
  catch (e) { c6 = { ok: false, reason: `it failed (${String(e?.message ?? e).slice(0, 200)})` }; }
  if (!c6?.ok) return undo(`launch check 6 refused ${who}: ${c6?.reason ?? 'no answer'}. Nothing was started`);
  return { ok: true, settingsFile, env };
}
