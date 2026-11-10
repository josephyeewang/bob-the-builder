// Role profiles (design v4 §14.1.2) and M4's reader for them (review 0b-3 M4).
//
// The rules (M10, lane 1) publish one profile per role. Until the shared reader lands, M4 reads
// them through `profilePort`, which fails closed. DESIGN_PROFILES is the design table: it is
// both the in-module fake and the ceiling — a published profile may never hold a tool outside
// its design list or on the never-list, so a bad rules file can't widen a role.

import { createHash } from 'node:crypto';
import { OUTBOX_KINDS } from '../../../shared/record-names.mjs';

// Agent and Task are one subagent tool under two names (L629); M10's roles.mjs keeps the same list less Workflow.
export const NEVER_TOOLS = Object.freeze(['RemoteTrigger', 'SendMessage', 'ListAgents', 'Agent', 'Task', 'CronCreate',
  'ScheduleWakeup', 'Monitor', 'WebFetch', 'WebSearch', 'SendUserFile', 'Workflow']);
// Tolerated in every read-back (m2).
export const ALWAYS_TOLERATED = Object.freeze(['EndConversation']);

// Which outbox files a role may hand in (LEAD-CALLS L82 M-1): the one shared table, shared OUTBOX_KINDS, which
// M9's intake and M10's role loader read too, in its name-prefix form (`report-`, `report-compact-`). M4 keeps no list
// of its own, so the plain-files hook, M4's intake read and M9 can't disagree.
export const outboxKindsFor = (role) => Object.keys(OUTBOX_KINDS).filter((k) => OUTBOX_KINDS[k].roles.includes(role));
// The listed kinds a role may NOT hand in that start with one it may (a scout's `report-compact-`). A file's kind is the
// longest listed prefix of its name (shared outboxKindOf); the hook can't load the table, so it is handed these too.
// `own` is the kinds actually handed to the hook (a published profile may list fewer than the design), so a kind the
// profile leaves out is refused at the hook, as M4's intake read refuses it, not only later.
export const shadowKindsFor = (role, own = outboxKindsFor(role)) =>
  Object.keys(OUTBOX_KINDS).filter((k) => !own.includes(k) && own.some((o) => k.startsWith(o)));

// Kinds the table lists for a role that its design still may not hand in, because nothing yet does what their text
// promises (LEAD-CALLS L151 M-1, L167 c-4). The Front Door's `state-` (pause/away) and `request-` (resume, wrap-up,
// rotate, mode requests) are refused by the Record too; leaving them out here refuses them at the plain-files hook and
// at intake as well. A kind comes back here in the PR that lands its consumer. The Front Door is left with idea-,
// ask-request- (work, research and undo asks) and its compaction note, state-compact-.
export const NOT_YET = Object.freeze({ front_door: Object.freeze(['state-', 'request-']) });
const designKinds = (role) => outboxKindsFor(role).filter((k) => !(NOT_YET[role] ?? []).includes(k));

const p = (o) => Object.freeze({ ...o, tools: Object.freeze(o.tools), outbox: Object.freeze(o.outbox) });

// Compaction windows come from the rules' context key; these are the design values (R-0b-42).
export const DESIGN_PROFILES = Object.freeze({
  lead: p({ tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion'], mode: 'acceptEdits', restricted: true,
    outbox: designKinds('lead'), compactWindow: 400000,
    setupFileRefusals: true, bobFolder: true, compactKind: 'handoff' }),
  worker: p({ tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('worker'), compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'report' }),
  reviewer: p({ tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('reviewer'), compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'verdict' }),
  auditor: p({ tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('auditor'), compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'verdict' }),
  incident: p({ tools: ['Read', 'Glob', 'Grep'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('incident'), compactWindow: 300000, setupFileRefusals: false, bobFolder: false, compactKind: 'ask' }),
  scout: p({ tools: ['Read', 'Glob', 'Grep'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('scout'), compactWindow: 300000, setupFileRefusals: false, bobFolder: false, compactKind: 'report' }),
  writer: p({ tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('writer'), compactWindow: 300000, setupFileRefusals: false, bobFolder: false, compactKind: 'report' }),
  front_door: p({ tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification', 'Skill'], mode: 'acceptEdits',
    restricted: true, outbox: designKinds('front_door'), compactWindow: 250000, setupFileRefusals: true, bobFolder: false,
    skills: ['orchestrate'], compactKind: 'state' }),
  thinking: p({ tools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'PushNotification'], mode: 'acceptEdits',
    restricted: true, outbox: designKinds('thinking'), compactWindow: 400000, setupFileRefusals: true, bobFolder: false, compactKind: 'report' }),
  learning: p({ tools: ['Read', 'Glob', 'Grep', 'Write'], mode: 'acceptEdits', restricted: true,
    outbox: designKinds('learning'), compactWindow: 400000, setupFileRefusals: true, bobFolder: true, compactKind: 'handoff' }),
  // A script card's session (L760): started by the Dispatcher as a worker is, on the workers' user, so it gets the
  // worker's walls (secrets, proposals, the Bob folder, the worker runner's requests and status) and nothing a reviewer
  // has. Its tools are M10's published script.json less Workflow, which stays on this never-list until it is walled;
  // a published file that holds Workflow is refused here (a capability claim, checked on this code, not a version).
  // Its outbox is its own, <outboxRoot>/script/<session>, recorded as script:<session> (L767), never the worker's: as a
  // worker it could hand in handin-. Nothing here names the folder; the launcher gives it (paths.outbox).
  script: p({ tools: ['Read', 'Glob', 'Grep', 'Write'], mode: 'dontAsk', restricted: true,
    outbox: designKinds('script'), compactWindow: 300000, setupFileRefusals: false, bobFolder: true, compactKind: 'report' }),
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
