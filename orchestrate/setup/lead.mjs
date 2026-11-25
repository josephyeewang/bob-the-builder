#!/usr/bin/env node
// lead.mjs — start a one-shot Lead for one idea (Track A step 8 G4 and G5, L1370).
//
// Run as the owner (Joe's own Mac user, never root, never sudo):
//   node /Library/orchestrate/install/orchestrate/setup/lead.mjs plan <product> <idea id> [--setup <setup.json>]
// `<idea id>` is the Record's report id of a Front Door idea, idea-<session>-<n> (the leading "idea-" may be left out).
// Nothing starts it by itself yet: step 8 PR 4 has the Front Door's tab run it for each confirmed idea.
//
// What it does, in order; any refusal stops it before claude starts, and says why in plain words:
//   1. reads the setup config and the installed rules (role-start.mjs readSetup), and the profile is the Lead's locked
//      one (M4 role-profiles.mjs checkProfile: no never-list tool, nothing beyond the design);
//   2. reads the idea from the product's Record, as the owner (M9 read-view.mjs: report idea-<id>, of kind idea-);
//   3. refuses an idea that already has a plan: a fact intake-applied-<Lead session>-plan-<idea id>.json that is applied,
//      being applied or waiting (one plan per idea; a refused plan may be planned again);
//   4. reads the head the lead-main copy names (<base>/lead-main/<product>/.head, M11 lead-main.mjs copyHead): the main
//      commit the Lead reads, which the Dispatcher's lead-main step exported;
//   5. makes the Lead's outbox, <outboxRoot>/lead/ld-<product>-<stamp> (M3 sessions.mjs), and its notes folder beside it,
//      and writes in the outbox (role-start.mjs prepareStart): .settings.json from the locked profile, walled from the
//      worker runner's requests and status when the setup has a worker runner; .launch.json, { session, product, head }
//      (M3 launchFileText), which intake records as the Lead's launch once the head is one the export gave; and
//      .lead-prompt.md, the Lead's whole system prompt: LEAD_WORDING, the one-shot lines (LEAD_ONE_SHOT) and the idea as
//      outside text (M3 lead-input.mjs leadInputText, kind idea-file);
//   6. runs launch check 6 on the pin, in the outbox, with the same flags: a mismatch removes all of step 5;
//   7. runs `claude -p` headless in its outbox, the lead-main copy an added folder it may only read, by full paths (the
//      Dispatcher may swap the copy while it runs, so it never starts inside it), model main and effort high
//      (M10 roles/lead.json), its output kept in .run.log, for at most RUN_MS;
//   8. waits for the Dispatcher to take plan-<idea id>.json (its intake fact), at most OUTCOME_WAIT_MS, and prints what
//      the Record made of it: the draft cards it created, or why it was refused or held.
//
// The Lead's walls (M4 render-settings.mjs, for role lead): tools Read, Glob, Grep, Write and AskUserQuestion, no shell,
// no tool server, no plugin; its tools write only its outbox (the plain-files hook, given its kinds and no copy), never a
// dot-name there; the Record, secrets, the owner's keys and every product's proposals are read-denied. A headless run has
// no one to answer AskUserQuestion: the one-shot wording says to put the question in a card that waits on the owner.

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIGN_PROFILES, checkProfile } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { readBack } from '../modules/M4-workshop/launcher/readback.mjs';
import { FLAGS as F } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { factIds, readDocFile } from '../modules/M9-record/read-view.mjs';
import { LAUNCH_FILE, LEAD_ROLE, isLeadSession, launchFileText, leadSessionId } from '../modules/M3-lead/sessions.mjs';
import { LEAD_ONE_SHOT, LEAD_WORDING, oneShotPlanName } from '../modules/M3-lead/lead-wording.mjs';
import { leadInputText } from '../modules/M3-lead/lead-input.mjs';
import { copyHead } from '../modules/M11-dispatcher/lead-main.mjs';
import { appliedFactId, stateText } from '../modules/M1-front-door/filed.mjs';
import { PROMPT_FILE_FLAG, SETUP_FILE, prepareStart, readSetup, roleFlags } from './role-start.mjs';
import { WORKER_STATUS_FILE, leadMainPath, workerRunnerPaths } from './layout.mjs';

/** The role file's model and effort (M10 roles/lead.json): main is no --model, the account's own, as the review runner starts its roles. */
export const LEAD_MODEL = null;
export const LEAD_EFFORT = 'high';
export const PROMPT_NAME = '.lead-prompt.md';
export const RUN_LOG = '.run.log';
/** How long the Lead may run before it is stopped. */
export const RUN_MS = 30 * 60 * 1000;
/** How long, after the Lead ends, to wait for the Dispatcher to take its plan, and how often to look. */
export const OUTCOME_WAIT_MS = 15 * 60 * 1000;
export const OUTCOME_EVERY_MS = 15_000;
export const USAGE = 'usage: node lead.mjs plan <product> <idea id> [--setup <setup.json>]';
const WHO = 'the Lead';
const IDEA_ID = /^idea-[A-Za-z0-9-]{1,180}$/;
// A plan that stands in the way of another for the same idea; a refused one does not.
const PLANNED = Object.freeze(['applied', 'applying', 'waiting']);
const DONE = Object.freeze(['applied', 'refused']);

/** The Lead's notes folder (render-settings: apart from its outbox), beside the outbox under the Lead folder; intake lists only ld- names. */
export const notesFolder = (outboxRoot, sessionId) => join(outboxRoot, LEAD_ROLE, `.notes-${sessionId}`);

/** The idea's report id: as given, or with "idea-" put in front. → the id, or null when it is not one. */
export function ideaIdOf(arg) {
  const id = typeof arg === 'string' && !arg.startsWith('idea-') ? `idea-${arg}` : arg;
  return IDEA_ID.test(id ?? '') ? id : null;
}

/**
 * Intake's facts for a plan of this idea from any one-shot Lead of this product: [{ sessionId, doc }].
 * `ids` every fact id, `fact(id)` read-view's answer.
 */
export function earlierPlans({ product, ideaId, ids, fact }) {
  const name = oneShotPlanName(ideaId);
  const pre = appliedFactId('', '').slice(0, -1);
  const out = [];
  for (const id of ids) {
    if (!id.startsWith(pre) || !id.endsWith(`-${name}`)) continue;
    const sessionId = id.slice(pre.length, -(name.length + 1));
    if (!isLeadSession(sessionId, product) || id !== appliedFactId(sessionId, name)) continue;
    const r = fact(id);
    if (r?.ok) out.push({ sessionId, doc: r.doc });
  }
  return out;
}

/** The headless start: -p and its stream, the role's flags, the effort, the prompt file, the prompt last. */
export function leadArgs({ profile, settingsFile, promptFile, prompt }) {
  return [F.print, F.outputFormat, F.streamJson, F.verbose, ...roleFlags({ profile, settingsFile, model: LEAD_MODEL }), F.effort, LEAD_EFFORT, PROMPT_FILE_FLAG, promptFile, prompt];
}

/** What the Lead is told when it starts (its system prompt is the prompt file). */
export const leadPrompt = ({ ideaId, outbox, code, now }) => `Plan the idea ${ideaId} in your input. Your outbox folder is ${outbox}: `
  + `write ${oneShotPlanName(ideaId)} there, then stop. The code folder is ${code}. The time now is ${new Date(now).toISOString()}.`;

/**
 * What the Record made of the plan, in plain words, from its intake fact: the note intake keeps for the Lead (the cards it
 * created, or why the plan was not applied) while no Lead has heard it, which a one-shot Lead never does in step 8 (the
 * Dispatcher's replyToLead is not wired); else the state alone.
 */
function outcomeText(name, doc) {
  return typeof doc.lead_note === 'string' ? doc.lead_note : `${name}: ${stateText(doc)}`;
}

/**
 * The one-shot start, with every outside thing a port so a test can stand in. → { ok: true, sessionId, outbox, head,
 * code, timedOut, plan, state, text } once claude has ended (state: the plan's intake state, 'none' when it handed in
 * none, 'not taken' when the Dispatcher had not taken it in time), or { ok: false, reason } with nothing left behind.
 * io: role-start's (readText, mkdir, writeFile, rm, uid, user, home, env, check) and now, list (folder → names),
 *   runHeadless (bin, args, { cwd, env, log, timeoutMs }) → { code, timedOut }, sleep (ms), progress (a line to the terminal).
 */
export async function planLead({ product, idea, setupFile = SETUP_FILE, profile = DESIGN_PROFILES[LEAD_ROLE] }, io) {
  const no = (reason) => ({ ok: false, reason });
  const progress = io.progress ?? (() => {});
  const pc = checkProfile(LEAD_ROLE, profile);
  if (!pc.ok) return no(`the Lead's profile can't be used: ${pc.reason}`);
  const ideaId = ideaIdOf(idea);
  if (!ideaId) return no(`${String(idea).slice(0, 80)} is not an idea id (idea-<letters, digits and dashes>)`);
  const s = readSetup({ product, setupFile, who: WHO, howToRun: 'run it as your own Mac user, with no sudo' }, io);
  if (!s.ok) return s;
  const { places: P, cfg } = s;
  const at = { recordRoot: P.recordRoot, recordUid: P.recordUid };
  const r = readDocFile({ ...at, entity: 'report', id: ideaId, missing: `no idea ${ideaId} in ${product}'s Record` });
  if (!r.ok) return no(r.missing ? r.reason : `the idea ${ideaId} in the Record is unreadable (${r.reason})`);
  if (r.doc.kind !== 'idea-' || typeof r.doc.text !== 'string') return no(`${ideaId} in the Record is not an idea the Front Door filed`);
  const name = oneShotPlanName(ideaId);
  let ids;
  try { ids = factIds(at); } catch (e) { return no(`the Record's facts can't be listed, so whether ${ideaId} has a plan can't be told (${String(e?.message ?? e).slice(0, 200)})`); }
  const fact = (id) => readDocFile({ ...at, entity: 'fact', id });
  const had = earlierPlans({ product, ideaId, ids, fact }).find((x) => PLANNED.includes(x.doc.state));
  if (had) return no(`the idea ${ideaId} already has a plan: ${name} from the Lead ${had.sessionId} is ${stateText(had.doc)}`);
  const code = join(leadMainPath(cfg), product);
  const head = copyHead(code);
  if (!head) return no(`the Lead's copy of main, ${code}, names no commit (.head): the Dispatcher's lead-main step makes it (is leadMainRoot in its config?)`);
  let sessionId; try { sessionId = leadSessionId(product, new Date(io.now())); } catch (e) { return no(e.message); }
  const outbox = join(P.outboxRoot, LEAD_ROLE, sessionId);
  const input = leadInputText({ items: [{ source: 'idea-file', text: r.doc.text }] });
  if (!input.ok) return no(`the idea can't be given to the Lead (${input.reason})`);
  const promptText = `${[...LEAD_WORDING, ...LEAD_ONE_SHOT].join('\n\n')}\n\n${input.text}`;
  const promptFile = join(outbox, PROMPT_NAME);
  const workerRunner = cfg.workerRunner ? { requestsDir: workerRunnerPaths(cfg).requests, statusFile: join(workerRunnerPaths(cfg).state, WORKER_STATUS_FILE) } : undefined;
  // It starts in its outbox; the code is an added read-only folder it reads by full paths (render-settings readCode), so a
  // swap of the copy mid-run never leaves it in a deleted folder (#681 audit).
  const st = await prepareStart({ role: LEAD_ROLE, who: WHO, profile, model: LEAD_MODEL, effort: LEAD_EFFORT, places: P, outbox,
    notes: notesFolder(P.outboxRoot, sessionId), paths: { readCode: code, ...(workerRunner ? { workerRunner } : {}) }, promptFile,
    files: [[LAUNCH_FILE, launchFileText({ session: sessionId, product, head })], [PROMPT_NAME, promptText]] }, io);
  if (!st.ok) return st;
  progress(`The Lead ${sessionId} is planning ${ideaId} on main at ${head.slice(0, 12)} (at most ${RUN_MS / 60000} minutes).`);
  const ran = await io.runHeadless(P.claudeBin, leadArgs({ profile, settingsFile: st.settingsFile, promptFile, prompt: leadPrompt({ ideaId, outbox, code, now: io.now() }) }),
    { cwd: outbox, env: st.env, log: join(outbox, RUN_LOG), timeoutMs: RUN_MS });
  const base = { ok: true, sessionId, outbox, head, code: ran?.code ?? null, timedOut: ran?.timedOut === true, plan: name };
  let names = [];
  try { names = io.list(outbox); } catch { /* read as none */ }
  if (!names.includes(name)) {
    return { ...base, state: 'none', text: `The Lead ${sessionId} ended${base.timedOut ? ' (stopped: out of time)' : ''} without handing in ${name}. What it did is in ${join(outbox, RUN_LOG)}.` };
  }
  progress(`The Lead handed in ${name}; waiting for the Dispatcher to take it (at most ${OUTCOME_WAIT_MS / 60000} minutes).`);
  const until = io.now() + OUTCOME_WAIT_MS;
  for (;;) {
    const f = fact(appliedFactId(sessionId, name));
    if (f.ok && DONE.includes(f.doc.state)) return { ...base, state: f.doc.state, text: outcomeText(name, f.doc) };
    if (io.now() >= until) {
      const now = f.ok ? stateText(f.doc) : 'not taken yet';
      return { ...base, state: f.ok ? f.doc.state : 'not taken', text: `${name} from the Lead ${sessionId}: ${now}. Type \`node …/setup/front-door.mjs filed ${product}\` later, or look in ${outbox}.` };
    }
    await io.sleep(OUTCOME_EVERY_MS);
  }
}

/** The real ports. */
export function realIo() {
  const u = userInfo();
  return {
    readText: (f) => readFileSync(f, 'utf8'),
    mkdir: (d, mode) => { mkdirSync(d, { mode }); chmodSync(d, mode); },
    writeFile: (f, text, mode) => { writeFileSync(f, text, { mode, flag: 'wx' }); },
    rm: (d) => rmSync(d, { recursive: true, force: true }),
    uid: process.getuid(), user: u.username, home: u.homedir, env: process.env, now: () => Date.now(),
    check: (x) => readBack(x),
    list: (d) => readdirSync(d),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    progress: (s) => process.stderr.write(`${s}\n`),
    // claude's output goes to the log, a new file of the owner's alone; past the time limit it is stopped, then killed.
    runHeadless: (bin, args, { cwd, env, log, timeoutMs }) => new Promise((resolve) => {
      let fd;
      try { fd = openSync(log, 'wx', 0o600); } catch { resolve({ code: 127, timedOut: false }); return; }
      let timedOut = false;
      let child;
      try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', fd, fd] }); } catch { closeSync(fd); resolve({ code: 127, timedOut: false }); return; }
      closeSync(fd);
      const t = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); }, timeoutMs);
      child.on('error', () => { clearTimeout(t); resolve({ code: 127, timedOut }); });
      child.on('exit', (c, signal) => { clearTimeout(t); resolve({ code: c ?? (signal ? 128 : 1), timedOut }); });
    }),
  };
}

export async function main(argv, io = realIo(), print = (s) => process.stderr.write(`${s}\n`)) {
  const [cmd, product, idea, ...rest] = argv;
  const i = rest.indexOf('--setup');
  if (cmd !== 'plan' || !product || !idea || (i >= 0 && !rest[i + 1])) { print(USAGE); return 2; }
  const r = await planLead({ product, idea, ...(i >= 0 ? { setupFile: rest[i + 1] } : {}) }, io);
  if (!r.ok) { print(`The Lead did not start: ${r.reason}`); return 1; }
  print(r.text);
  return r.state === 'applied' ? 0 : 1;
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
