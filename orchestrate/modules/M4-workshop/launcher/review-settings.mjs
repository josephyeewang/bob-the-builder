#!/usr/bin/env node
// A reviewer's or auditor's settings file, from a committed template (LEAD-CALLS L67, with its addenda 1 and 2).
//
// The runner runs as `review` and can't write into the root-owned installed copy, and root runs no repository code
// (L66), so a session's settings can't be rendered ahead of time by either. Instead, one template per review role is
// committed in `templates/` (this file's folder) and copied into the installed copy by the updater with the rest of
// `orchestrate/`. A template holds every rule of renderRoleSettings for that role; where a path belongs it holds a
// placeholder, `/__orch_<name>__`, of two kinds:
//   - session: `outbox` (outboxRoot/<role>/<the session id the runner made>, L71) and `copy` (the review copy for the
//     card and head; a review role's settings name no copy today, so it is checked but fills nothing);
//   - machine: node, the hooks folder, the rules snapshot, the Bob folder, the read-deny list (one list placeholder:
//     the config's `deny` paths plus the workers' copies folder), and each review wall (REVIEW_WALLS).
// Machine values come only from the runner's root-owned config inside installRoot, never from a request.
//
// What the runner refuses (`sessionSettings`): a template that is not root's plain file; a placeholder anywhere but its
// allowed spots (SPOTS), or one it does not know; a value that is not an absolute plain path, holds `..`, runs through a
// link, or is not under its expected root (the outbox is outboxRoot/<role>/<session id>; the copy is inside the review copies'
// folder and not inside the workers' copies' folder, which the deny list covers); a filled file that differs from the
// template anywhere but the placeholders (`onlySpotsChanged`); and a filled file checkSettings refuses. The file goes
// to <runner folder>/settings/<session id>.json, the runner's own, behind the review walls.
//
// A repository test keeps the templates in step with renderRoleSettings, filled with made-up values.
// `node review-settings.mjs --write-templates` rewrites them (a builder's step, never run by root or the runner).

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRoleSettings, checkSettings, REVIEW_WALLS } from './render-settings.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { SESSION_ID } from '../../../shared/record.mjs';

export const TEMPLATE_DIR = 'modules/M4-workshop/launcher/templates';
export const SETTINGS_DIR = 'settings';
export const templateFile = (installRoot, role) => join(installRoot, TEMPLATE_DIR, `${role}.settings.json`);

export const SESSION_SLOTS = Object.freeze(['outbox', 'copy']);
const wallSlot = (k) => `wall_${k}`;
export const MACHINE_SLOTS = Object.freeze(['node', 'hooks', 'snapshot', 'bob', 'deny', ...REVIEW_WALLS.map(wallSlot)]);
const LIST_SLOTS = new Set(['deny']);
const ALL = new Set([...SESSION_SLOTS, ...MACHINE_SLOTS]);
export const slotToken = (name) => `/__orch_${name}__`;
const TOKEN_RE = /\/__orch_([A-Za-z]+(?:_[A-Za-z]+)*)__/g;
const LOOKALIKE = /__orch_/;
const PLAIN = /^\/[A-Za-z0-9._/-]*$/;
const MAX_TEMPLATE = 256 * 1024;
const refuse = (reason) => ({ ok: false, reason });

// Where each wall's value comes from in the runner's config (its own folder is `root`).
const WALL_VALUE = {
  outboxRoot: (c) => c.outboxRoot,
  runnerRoot: (c) => c.root,
};

/** The template for a review role: renderRoleSettings with a placeholder for every path. → { ok, settings } */
export function renderTemplate(role) {
  if (!REVIEW_ROLES.includes(role)) return refuse(`${role} is not a review role`);
  const t = slotToken;
  return renderRoleSettings({
    role, profile: DESIGN_PROFILES[role], productionFiles: [],
    paths: {
      copy: t('copy'), outbox: t('outbox'), hooksDir: t('hooks'), snapshot: t('snapshot'), node: t('node'), bobFolder: t('bob'),
      deny: { secrets: [t('deny')] },
      reviewWalls: Object.fromEntries(REVIEW_WALLS.map((k) => [k, t(wallSlot(k))])),
    },
  });
}
export const templateText = (settings) => `${JSON.stringify(settings, null, 2)}\n`;

// ---- the allowed spots ----
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const one = (n) => esc(slotToken(n));
const any = (ns) => `(?:${ns.map(one).join('|')})`;
const WALLS_ALL = REVIEW_WALLS.map(wallSlot);
const WALLS_TOOLS = REVIEW_WALLS.filter((k) => k !== 'outboxRoot').map(wallSlot);
/** [where (a key path, `[]` for any array item), the whole string]. A string holding a placeholder must match one. */
export const SPOTS = Object.freeze([
  ['permissions.deny[]', `^(?:Read|Edit)\\(/${one('deny')}/\\*\\*\\)$`],
  ['permissions.deny[]', `^(?:Write|Edit)\\(/${one('outbox')}/(?:\\*\\*/)?\\.\\*\\)$`],
  ['permissions.deny[]', `^(?:Edit|Write)\\(/${any([...WALLS_TOOLS, 'bob'])}/\\*\\*\\)$`],
  ['permissions.additionalDirectories[]', `^${any(['outbox', 'bob'])}$`],
  ['sandbox.filesystem.denyRead[]', `^${one('deny')}$`],
  ['sandbox.filesystem.denyWrite[]', `^${one('outbox')}/(?:\\*\\*/)?\\.\\*$`],
  ['sandbox.filesystem.denyWrite[]', `^${any([...WALLS_ALL, 'bob'])}(?:/\\*\\*)?$`],
  [/^hooks\.[A-Za-z]+\[\]\.hooks\[\]\.command$/, `^${one('node')} ${one('hooks')}/[a-z-]+\\.mjs --role (?:reviewer|auditor) --outbox ${one('outbox')} --snapshot ${one('snapshot')} --kinds [a-z,]+(?: --kind [a-z]+ --event [A-Za-z]+)?$`],
].map(([at, re]) => Object.freeze({ at, re: new RegExp(re) })));

function walk(x, path, visit) {
  if (Array.isArray(x)) { x.forEach((v) => walk(v, `${path}[]`, visit)); return; }
  if (x && typeof x === 'object') { for (const [k, v] of Object.entries(x)) { visit.key?.(k, path); walk(v, path ? `${path}.${k}` : k, visit); } return; }
  visit.value(x, path);
}

/** Null, or why a template holds a placeholder it may not: an unknown one, one in a key, or one outside SPOTS. */
export function spotsProblem(template) {
  let bad = null;
  walk(template, '', {
    key: (k, path) => { if (!bad && LOOKALIKE.test(k)) bad = `a placeholder in the key ${path ? `${path}.` : ''}${k}`; },
    value: (v, path) => {
      if (bad || typeof v !== 'string' || !LOOKALIKE.test(v)) return;
      const names = [...v.matchAll(TOKEN_RE)].map((m) => m[1]);
      if (v.replace(TOKEN_RE, '').match(LOOKALIKE)) { bad = `${path} holds a placeholder that is not one: ${JSON.stringify(v)}`; return; }
      const unknown = names.find((n) => !ALL.has(n));
      if (unknown) { bad = `${path} holds an unknown placeholder ${unknown}`; return; }
      const fits = SPOTS.some((s) => (typeof s.at === 'string' ? s.at === path : s.at.test(path)) && s.re.test(v));
      if (!fits) bad = `${path} holds a placeholder where none may be: ${JSON.stringify(v)}`;
    },
  });
  return bad;
}

const fillString = (s, values) => s.replace(TOKEN_RE, (_, n) => values[n]);

const listOf = (v) => (typeof v === 'string' ? [...v.matchAll(TOKEN_RE)].map((m) => m[1]).find((n) => LIST_SLOTS.has(n)) : null) ?? null;

/**
 * A list's items as the fill makes them: { t: the template item, want: its filled string, or null when it is filled as
 * itself }. A run of neighbouring items holding the same list placeholder takes one value at a time through the whole
 * run, which is renderRoleSettings's order (the Read and Edit deny of one path, then the next path's).
 */
function expand(arr, values) {
  const out = [];
  for (let i = 0; i < arr.length;) {
    const list = listOf(arr[i]);
    if (!list) { out.push({ t: arr[i], want: null }); i += 1; continue; }
    let j = i;
    while (j < arr.length && listOf(arr[j]) === list) j += 1;
    for (const one of values[list]) for (const t of arr.slice(i, j)) out.push({ t, want: fillString(t.replaceAll(slotToken(list), one), values) });
    i = j;
  }
  return out;
}

/** The template with each placeholder replaced; a list placeholder's items become one set per value (expand). */
export function fillTemplate(x, values) {
  if (Array.isArray(x)) return expand(x, values).map(({ t, want }) => (want === null ? fillTemplate(t, values) : want));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillTemplate(v, values)]));
  return typeof x === 'string' ? fillString(x, values) : x;
}

/**
 * Null, or the first place `result` differs from `template` other than at a placeholder: the same keys, the same types,
 * every string without a placeholder unchanged, every one with a placeholder holding exactly its values.
 */
export function onlySpotsChanged(template, result, values, path = '') {
  if (Array.isArray(template)) {
    if (!Array.isArray(result)) return `${path} is no longer a list`;
    const items = expand(template, values);
    for (let at = 0; at < items.length; at += 1) {
      const { t, want } = items[at];
      if (want !== null) { if (result[at] !== want) return `${path}[${at}] is not the template's ${JSON.stringify(t)} filled in`; continue; }
      const bad = onlySpotsChanged(t, result[at], values, `${path}[${at}]`);
      if (bad) return bad;
    }
    return items.length === result.length ? null : `${path} holds more than the template`;
  }
  if (template && typeof template === 'object') {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return `${path} is no longer an object`;
    const tk = Object.keys(template);
    const rk = Object.keys(result);
    if (tk.length !== rk.length || tk.some((k, i) => k !== rk[i])) return `${path || 'the file'} has other keys than the template`;
    for (const k of tk) { const bad = onlySpotsChanged(template[k], result[k], values, path ? `${path}.${k}` : k); if (bad) return bad; }
    return null;
  }
  if (typeof template === 'string' && LOOKALIKE.test(template)) return result === fillString(template, values) ? null : `${path} is not the template's value filled in`;
  return Object.is(template, result) ? null : `${path} differs from the template`;
}

/**
 * Null, or why a value may not fill a placeholder: not a plain absolute path, `/` itself, `..`, a link on the way to it,
 * or a case other than the disk's. The real path is realpathSync.native's, which gives the case the disk holds (the
 * plain one keeps the case it was given, so `/USERS/...` passed; L73 point 7(a)).
 */
export function realPathProblem(v, { realpath = realpathSync.native, lstat = lstatSync } = {}) {
  if (typeof v !== 'string' || !isAbsolute(v) || !PLAIN.test(v)) return `${JSON.stringify(v)} is not a plain absolute path`;
  if (v === '/') return '/ is the whole disk, not a folder a setting may name';
  if (v.split('/').includes('..') || v.split('/').includes('.') || /\/\/|.\/$/.test(v)) return `${v} is not in its plain form`;
  // The deepest part that is there must be its own real path: no link anywhere on the way (a deny of a link misses
  // what it points at), and the disk's own case. Parts after it may be missing (a deny of a file not made yet).
  let at = v;
  for (;;) {
    let there = true;
    try { lstat(at); } catch { there = false; }
    if (there) { let r; try { r = realpath(at); } catch { r = null; } return r === at ? null : `${v} runs through a link or is not in the disk's own case`; }
    if (at === dirname(at)) return `${v} has no part that is there`;
    at = dirname(at);
  }
}

const inside = (root, p) => { const r = relative(root, p); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };
const isDir = (p, lstat) => { try { return lstat(p).isDirectory(); } catch { return false; } };

/**
 * Every placeholder's value for one session, checked. `c` is the runner's config (root's): outboxRoot, root,
 * installRoot, hooksDir, snapshot, bobFolder, deny (a list), reviewCopies, workerCopies. → { ok, values }
 */
export function slotValues(c, { role, sessionId, copy, node }, ports = {}) {
  const lstat = ports.lstat ?? lstatSync;
  if (!REVIEW_ROLES.includes(role)) return refuse(`${role} is not a review role`);
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return refuse('not a session id');
  if (!Array.isArray(c.deny) || c.deny.length === 0) return refuse('the config has no deny list');
  for (const k of ['reviewCopies', 'workerCopies']) {
    const bad = realPathProblem(c[k], ports);
    if (bad) return refuse(`${k}: ${bad}`);
  }
  const values = {
    outbox: join(c.outboxRoot, role, sessionId), copy, node, hooks: c.hooksDir, snapshot: c.snapshot, bob: c.bobFolder,
    deny: [...c.deny, c.workerCopies],
  };
  for (const k of REVIEW_WALLS) {
    if (!WALL_VALUE[k]) return refuse(`no value for the review wall ${k}`);
    values[wallSlot(k)] = WALL_VALUE[k](c);
  }
  for (const [k, v] of Object.entries(values)) {
    for (const one of Array.isArray(v) ? v : [v]) {
      const bad = realPathProblem(one, ports);
      if (bad) return refuse(`${k}: ${bad}`);
    }
  }
  // Each under its expected root. "Apart" is compared on the real paths (both passed realPathProblem above, so the parts
  // that are there are their own real paths) and without case, since the disk ignores it: refusing more is safe.
  const w = c.workerCopies.toLowerCase();
  const rv = c.reviewCopies.toLowerCase();
  if (inside(w, rv) || inside(rv, w) || w === rv) return refuse('the review copies\' folder and the workers\' copies\' folder must be apart');
  if (!inside(c.reviewCopies, copy) || !isDir(copy, lstat)) return refuse(`copy: ${copy} is not a folder inside the review copies' folder`);
  // A second guard (L73 C1): "apart" and "inside the review copies' folder" above already rule this out.
  if (inside(w, copy.toLowerCase())) return refuse(`copy: ${copy} is inside the workers' copies' folder, which the reviewer may not read`);
  if (dirname(values.outbox) !== join(c.outboxRoot, role) || !isDir(values.outbox, lstat)) return refuse(`outbox: ${values.outbox} is not the session's folder in its role's outbox`);
  for (const k of ['node', 'hooks']) if (!inside(c.installRoot, values[k])) return refuse(`${k}: ${values[k]} is not inside the installed copy`);
  if (!inside(c.root, values.snapshot)) return refuse(`snapshot: ${values.snapshot} is not inside the runner's folder`);
  return { ok: true, values };
}

/** The template for `role`, read as root's plain file. → { ok, template } */
export function readTemplate(installRoot, role, { owner = 0 } = {}) {
  if (!REVIEW_ROLES.includes(role)) return refuse(`${role} is not a review role`);
  let fd;
  try { fd = openSync(templateFile(installRoot, role), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return refuse(`the ${role} template can't be opened (${e.code ?? e.message})`); }
  try {
    const st = fstatSync(fd);
    // A second name is no fault (as for the install stamp, L71 point 4): it can't change root's bytes.
    if (!st.isFile()) return refuse(`the ${role} template is not a plain file`);
    if (st.uid !== owner) return refuse(`the ${role} template is not root's`);
    if (st.mode & 0o022) return refuse(`the ${role} template can be written by others than root`);
    if (st.size > MAX_TEMPLATE) return refuse(`the ${role} template is too big`);
    let template; try { template = JSON.parse(readFileSync(fd, 'utf8')); } catch { return refuse(`the ${role} template is not JSON`); }
    return { ok: true, template };
  } finally { closeSync(fd); }
}

/**
 * One session's settings file: the role's template, filled with this session's values, checked, written to
 * <c.root>/settings/<sessionId>.json (the runner's own folder, 0700). `owner` is root's uid (the template's), `uid` the
 * runner's own. `fill` is a port only so a test can plant a fill that changes more. → { ok, file, settings }
 */
export function sessionSettings(c, { role, sessionId, copy, node }, { owner = 0, uid = process.getuid(), fill = fillTemplate, ...ports } = {}) {
  const t = readTemplate(c.installRoot, role, { owner });
  if (!t.ok) return t;
  const spot = spotsProblem(t.template);
  if (spot) return refuse(`the ${role} template: ${spot}`);
  const v = slotValues(c, { role, sessionId, copy, node }, ports);
  if (!v.ok) return v;
  const settings = fill(t.template, v.values);
  const changed = onlySpotsChanged(t.template, settings, v.values);
  if (changed) return refuse(`the filled settings differ from the template beyond its placeholders: ${changed}`);
  if (LOOKALIKE.test(JSON.stringify(settings))) return refuse('the filled settings still hold a placeholder');
  const ck = checkSettings(settings, { profile: DESIGN_PROFILES[role] });
  if (!ck.ok) return refuse(`the filled settings were refused: ${ck.reason}`);

  const dir = join(c.root, SETTINGS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || st.mode & 0o077) return refuse(`${dir} is not the runner's own folder (0700)`);
  const file = join(dir, `${sessionId}.json`);
  const text = templateText(settings);
  let fd;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (e) { return refuse(`${file} can't be made (${e.code ?? e.message})`); }
  try { writeSync(fd, text); } finally { closeSync(fd); }
  let back; try { back = readFileSync(file, 'utf8'); } catch { back = null; }
  if (back !== text) return refuse('the settings file read back differently');
  return { ok: true, file, settings };
}

/** The builder's step: rewrite the committed templates from renderRoleSettings. */
export function writeTemplates(dir = join(dirname(fileURLToPath(import.meta.url)), 'templates')) {
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o755 });
  for (const role of REVIEW_ROLES) {
    const r = renderTemplate(role);
    if (!r.ok) throw new Error(`${role}: ${r.reason}`);
    writeFileSync(join(dir, `${role}.settings.json`), templateText(r.settings), { mode: 0o644 });
  }
  return dir;
}

const me = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (me && me === invoked) {
  if (process.argv[2] === '--write-templates') process.stdout.write(`wrote the templates in ${writeTemplates()}\n`);
  else { process.stderr.write('usage: review-settings.mjs --write-templates\n'); process.exitCode = 1; }
}
