// Role profiles (design v4 §14.1.2) and M4's reader for them (review 0b-3 M4).
//
// The rules (M10, lane 1) publish one profile per role. Until the shared reader lands, M4 reads
// them through `profilePort`, which fails closed. DESIGN_PROFILES is the design table: it is
// both the in-module fake and the ceiling — a published profile may never hold a tool outside
// its design list or on the never-list, so a bad rules file can't widen a role.

import { createHash } from 'node:crypto';

export const NEVER_TOOLS = Object.freeze(['RemoteTrigger', 'SendMessage', 'ListAgents', 'Agent', 'CronCreate',
  'ScheduleWakeup', 'Monitor', 'WebFetch', 'WebSearch', 'SendUserFile', 'Workflow']);
// Tolerated in every read-back (m2).
export const ALWAYS_TOLERATED = Object.freeze(['EndConversation']);

const p = (o) => Object.freeze({ ...o, tools: Object.freeze(o.tools), outbox: Object.freeze(o.outbox) });

// Compaction windows come from the rules' context key; these are the design values (R-0b-42).
export const DESIGN_PROFILES = Object.freeze({
  lead: p({ tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion'], mode: 'acceptEdits', restricted: true,
    outbox: ['wish', 'ask', 'think', 'scout', 'write', 'handoff', 'roadmap', 'history'], compactWindow: 400000,
    setupFileRefusals: true, bobFolder: true, compactKind: 'handoff' }),
  worker: p({ tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], mode: 'dontAsk', restricted: true,
    outbox: ['report'], compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'report' }),
  reviewer: p({ tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: ['verdict'], compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'verdict' }),
  auditor: p({ tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: ['verdict'], compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'verdict' }),
  incident: p({ tools: ['Read', 'Glob', 'Grep'], mode: 'dontAsk', restricted: true,
    outbox: ['ask'], compactWindow: 300000, setupFileRefusals: false, bobFolder: false, compactKind: 'ask' }),
  scout: p({ tools: ['Read', 'Glob', 'Grep'], mode: 'dontAsk', restricted: true,
    outbox: ['report'], compactWindow: 300000, setupFileRefusals: false, bobFolder: false, compactKind: 'report' }),
  writer: p({ tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: ['report'], compactWindow: 300000, setupFileRefusals: false, bobFolder: false, compactKind: 'report' }),
  front_door: p({ tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification', 'Skill'], mode: 'acceptEdits',
    restricted: true, outbox: ['request', 'state', 'idea'], compactWindow: 250000, setupFileRefusals: true, bobFolder: false,
    skills: ['orchestrate'], compactKind: 'state' }),
  thinking: p({ tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification'], mode: 'acceptEdits',
    restricted: true, outbox: ['report', 'idea'], compactWindow: 400000, setupFileRefusals: true, bobFolder: false, compactKind: 'report' }),
  learning: p({ tools: ['Read', 'Glob', 'Grep', 'Write'], mode: 'acceptEdits', restricted: true,
    outbox: ['lesson', 'check', 'prune', 'handoff'], compactWindow: 400000, setupFileRefusals: true, bobFolder: true, compactKind: 'handoff' }),
});

export const hasShell = (profile) => profile.tools.includes('Bash');

const refuse = (reason) => ({ ok: false, reason });

/** Checks a published profile against the design ceiling. Returns { ok, profile } or a refusal. */
export function checkProfile(role, profile) {
  const design = DESIGN_PROFILES[role];
  if (!design) return refuse(`no such role "${role}"`);
  if (!profile || !Array.isArray(profile.tools) || !Array.isArray(profile.outbox)) return refuse(`profile for ${role} is malformed`);
  const never = profile.tools.filter((t) => NEVER_TOOLS.includes(t));
  if (never.length) return refuse(`profile for ${role} holds never-list tools: ${never.join(', ')}`);
  const extra = profile.tools.filter((t) => !design.tools.includes(t));
  if (extra.length) return refuse(`profile for ${role} holds tools outside the design list: ${extra.join(', ')}`);
  const extraKinds = profile.outbox.filter((k) => !design.outbox.includes(k));
  if (extraKinds.length) return refuse(`profile for ${role} holds outbox kinds outside the design: ${extraKinds.join(', ')}`);
  if (profile.mode !== design.mode) return refuse(`profile for ${role} has mode ${profile.mode}, design says ${design.mode}`);
  if (profile.restricted !== true) return refuse(`profile for ${role} is not restricted`);
  if (!Number.isInteger(profile.compactWindow) || profile.compactWindow <= 0) return refuse(`profile for ${role} has no compaction window`);
  return { ok: true, profile };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The reader port. `readFile(name)` returns the bytes of `roles/<role>.json` (or throws);
 * `expectHash(role)` gives the hash the rules published for it. Missing, bad hash, bad JSON or
 * outside the ceiling → refuse.
 */
export function profilePort({ readFile, expectHash }) {
  return {
    loadRoleProfile(role) {
      if (!Object.hasOwn(DESIGN_PROFILES, role)) return refuse(`no such role "${role}"`);
      let bytes;
      try { bytes = readFile(`roles/${role}.json`); } catch { return refuse(`profile for ${role} is missing`); }
      let want; try { want = expectHash(role); } catch { want = null; }
      if (!want || sha256(bytes) !== want) return refuse(`profile for ${role} does not match its published hash`);
      let profile; try { profile = JSON.parse(bytes.toString('utf8')); } catch { return refuse(`profile for ${role} is not JSON`); }
      return checkProfile(role, profile);
    },
  };
}

/** The in-module fake: the design table itself, as the rules would publish it. */
export function fakeProfilePort(overrides = {}) {
  return {
    loadRoleProfile(role) {
      const prof = Object.hasOwn(overrides, role) ? overrides[role] : DESIGN_PROFILES[role];
      return checkProfile(role, prof);
    },
  };
}
