// roles.mjs — load the role profiles (roles/<role>.json) and refuse any profile that could give a role more power
// than the design's table allows (design v4 §14.1.2; spec review 0b-1 MAT-11, R2-m8; 0b-2 R2-M9).
//
// WHY. A role's tools, model and outbox kinds decide what an AI session can do. The profiles are plain Bob files,
// installed by the launcher from the pinned Bob commit, so a bad edit must be caught here, before any start:
//   - a tool on the never-list (cross-session messages, sub-agents, schedules, web) is refused in every profile;
//   - `Workflow` is on it too (L787): M4 never starts it, so the two lists are one list;
//   - a tool outside the known built-in names is refused (a new or misspelt name could be anything);
//   - an outbox kind must fit the name pattern AND be listed for that role in shared OUTBOX_KINDS;
//   - an unknown field is refused.
// Profiles hold no caps numbers: `context` names the rules key that holds them.
//
//   const roles = loadRoles(dir, { pin });   // → { ok: true, profiles } | { ok: false, reason }
//   profileFor(roles, role)                  // auditor → reviewer; learning → null (never started)

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOX_KINDS, OUTBOX_KIND_PATTERN } from '../../shared/record.mjs';
import { OUTBOX_FILE, PLAN_ANSWER_NAME } from '../M4-workshop/launcher/role-profiles.mjs';

// The one path of the role files folder (roles/ beside this file); every module that loads the profiles uses it (L235).
export const ROLES_DIR = fileURLToPath(new URL('./roles', import.meta.url));

// plan_reviewer (L683, L687, L710, L722): the fresh reviewer of a Tier-1 card's plan before its go, started by the review
// runner as the review user. It reads, and writes one file only: its answer, in its own outbox, which the runner reads.
export const ROLE_FILES = Object.freeze(['lead', 'worker', 'reviewer', 'incident', 'scout', 'writer', 'front_door',
  'thinking', 'script', 'explore', 'plan_reviewer']);
// A one-file role may hold only these tools, writes exactly these outbox files (no path, so nothing outside its own
// outbox) and hands in no outbox kinds, so a widened file is refused at load, not only by a test (L722). The file name is
// M4's (PLAN_ANSWER_NAME), and a name must pass the hooks' one rule, OUTBOX_FILE.
export const ONE_FILE_ROLES = Object.freeze({
  plan_reviewer: Object.freeze({ tools: Object.freeze(['Read', 'Glob', 'Grep', 'Write']), files: Object.freeze([PLAN_ANSWER_NAME]) }),
});
export const ROLE_ALIASES = Object.freeze({ auditor: 'reviewer' });
export const NEVER_STARTED = Object.freeze(['learning']);

// Claude Code's built-in tool names, as checked against one version. This is a claim about a tool we depend on, so it
// names the version and expires with it (Principle 9, R2-m8): a rules pin other than this version refuses every
// profile until someone re-checks the list against the new version's tool reference and moves this line.
export const TOOLS_CHECKED = Object.freeze({ claude_code: '2.1.316', date: '2026-11-05', source: 'the tool names found in the 2.1.316 program, and a start of each role on 2.1.316 without its role settings (lead, front_door and thinking did not get AskUserQuestion)' });
// The subagent tool goes by two names: the tool reference says Agent, and 2.1.316's own start message says Task (L629).
// A never-allowed tool is refused under every name it goes by.
export const NEVER_TOOLS = Object.freeze(['RemoteTrigger', 'SendMessage', 'ListAgents', 'Agent', 'Task', 'CronCreate',
  'ScheduleWakeup', 'Monitor', 'WebFetch', 'WebSearch', 'SendUserFile', 'Workflow']);
export const KNOWN_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash',
  'AskUserQuestion', 'PushNotification', 'Skill', 'EndConversation', ...NEVER_TOOLS]);

const MODELS = ['main', 'sonnet', 'haiku', 'per_task'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'per_row', 'as_asked'];
const MODES = ['acceptEdits', 'dontAsk'];
const FIELDS = new Set(['role', 'model', 'effort', 'effort_floor', 'effort_max', 'tools', 'permission_mode',
  'restricted_mode', 'outbox_kinds', 'outbox_files', 'auto_resume', 'context', 'skills', 'enforced']);

const byTier = (v, ok) => ok(v) || (v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === '1,2' && ok(v['1']) && ok(v['2']));

// One profile; throws with a plain reason on the first problem.
export function checkProfile(role, p) {
  const no = (why) => { throw new Error(`${role}: ${why}`); };
  if (!p || typeof p !== 'object' || Array.isArray(p)) no('not a profile');
  for (const k of Object.keys(p)) if (!FIELDS.has(k)) no(`unknown field "${k}"`);
  if (p.role !== role) no(`file says role "${p.role}"`);
  if (!MODELS.includes(p.model)) no(`model must be one of ${MODELS.join(', ')}`);
  if (!byTier(p.effort, (e) => EFFORTS.includes(e))) no('bad effort');
  if (!EFFORTS.includes(p.effort_floor)) no('bad effort_floor');
  if (p.effort_max !== undefined && !EFFORTS.includes(p.effort_max)) no('bad effort_max');
  if (!Array.isArray(p.tools)) no('tools must be a list');
  for (const t of p.tools) {
    if (NEVER_TOOLS.includes(t)) no(`tool ${t} is never allowed`);
    if (!KNOWN_TOOLS.includes(t)) no(`unknown tool ${JSON.stringify(t)}`);
  }
  if (new Set(p.tools).size !== p.tools.length) no('a tool is listed twice');
  const one = Object.hasOwn(ONE_FILE_ROLES, role) ? ONE_FILE_ROLES[role] : null;
  if (one) {
    const extra = p.tools.filter((t) => !one.tools.includes(t));
    if (extra.length) no(`a one-file role may not hold ${extra.join(', ')}`);
    if (!Array.isArray(p.outbox_files)) no('a one-file role must list its outbox_files');
    for (const f of p.outbox_files) {
      if (typeof f !== 'string' || !OUTBOX_FILE.test(f)) no(`outbox file ${JSON.stringify(f)} is not a plain name in its own outbox`);
    }
    if (p.outbox_files.length !== one.files.length || p.outbox_files.some((f) => !one.files.includes(f))) {
      no(`a one-file role writes exactly ${one.files.join(', ')}, not ${JSON.stringify(p.outbox_files)}`);
    }
  } else if (p.outbox_files !== undefined) no('only a one-file role names outbox_files');
  if (!MODES.includes(p.permission_mode)) no('bad permission_mode');
  if (typeof p.restricted_mode !== 'boolean') no('restricted_mode must be true or false');
  if (!Array.isArray(p.outbox_kinds)) no('outbox_kinds must be a list');
  // Before the kind table: a one-file role hands in no kind even if the shared table someday lists one for it.
  if (one && p.outbox_kinds.length) no('a one-file role hands in no outbox kinds, only its one file');
  for (const k of p.outbox_kinds) {
    if (typeof k !== 'string' || !OUTBOX_KIND_PATTERN.test(k)) no(`bad outbox kind ${JSON.stringify(k)}`);
    if (!Object.hasOwn(OUTBOX_KINDS, k) || !OUTBOX_KINDS[k].roles.includes(role)) no(`outbox kind ${k} is not listed for ${role}`);
  }
  if (!byTier(p.auto_resume, (b) => typeof b === 'boolean')) no('bad auto_resume');
  if (p.context !== `context.${role}`) no('context must name this role\'s rules key');
  if (p.skills !== undefined && !(Array.isArray(p.skills) && p.skills.every((s) => s === 'orchestrate') && role === 'front_door')) no('only the front_door may name a skill, and only orchestrate');
  if (p.enforced !== undefined && !(p.enforced === false && role === 'explore')) no('enforced: false is only for explore');
  if (role === 'explore' && p.enforced !== false) no('explore must say enforced: false');
  return p;
}

export function loadRoles(dir, { pin } = {}) {
  try {
    if (pin !== TOOLS_CHECKED.claude_code) throw new Error(`tool list checked against Claude Code ${TOOLS_CHECKED.claude_code}, rules pin ${pin}: re-check the list`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const want = [...ROLE_FILES].map((r) => `${r}.json`).sort();
    if (files.join() !== want.join()) throw new Error(`role files must be exactly ${want.join(', ')}`);
    const profiles = Object.create(null);
    for (const role of ROLE_FILES) {
      const text = readFileSync(join(dir, `${role}.json`), 'utf8');
      if (/"(__proto__|constructor|prototype)"\s*:/.test(text)) throw new Error(`${role}: banned key`);
      profiles[role] = Object.freeze(checkProfile(role, JSON.parse(text)));
    }
    return { ok: true, profiles: Object.freeze(profiles) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export function profileFor(roles, role) {
  if (!roles?.ok || NEVER_STARTED.includes(role)) return null;
  const name = ROLE_ALIASES[role] ?? role;
  return Object.hasOwn(roles.profiles, name) ? roles.profiles[name] : null;
}
