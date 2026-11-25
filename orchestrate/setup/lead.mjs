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
//   3. refuses an idea that already has a plan: a fact intake-applied-<Lead session>-plan-<idea id>.json in any state
//      but refused, or one that can't be read (an interrupted one names `lead.mjs release`, below). Then it takes the
//      idea's claim (#682 r2 M-A, r3): the next numbered file <outboxRoot>/lead/.claim-<product>.<idea id>.<gen>,
//      { session, started_at_ms }, made whole by link, so of starts at once only one gets each gen; the highest gen holds
//      the idea, and a new one is made only when that holder is free (its .released mark, or sessionHold: its plan
//      refused, its run ended or over with no plan handed in, or intake marked it stale). Claims are never moved or
//      removed. Lead folders from before claims are still scanned (heldBy, #682 r1 M1). Every refusal or throw from
//      here, and a run that never started, marks the claim released. One plan per idea; a refused plan may be planned again;
//   4. reads the head the lead-main copy names (<base>/lead-main/<product>/.head, M11 lead-main.mjs copyHead): the main
//      commit the Lead reads, which the Dispatcher's lead-main step exported; the copy must be a folder, not a link
//      (#682 r1 m3);
//   5. makes the Lead's outbox, <outboxRoot>/lead/ld-<product>-<stamp> (M3 sessions.mjs), and its notes folder beside it,
//      and writes in the outbox (role-start.mjs prepareStart): .settings.json from the locked profile, walled from the
//      worker runner's requests and status when the setup has a worker runner, and read-denied the other products'
//      lead-main copies, the other Leads' folders and the worker and review copies (leadOtherCopies, #682 r1 m4); and
//      .lead-prompt.md, the Lead's whole system prompt: LEAD_WORDING, the one-shot lines (LEAD_ONE_SHOT) and the idea as
//      outside text (M3 lead-input.mjs leadInputText, kind idea-file);
//   6. runs launch check 6 on the pin, in the outbox, with the same flags: a mismatch removes all of step 5;
//   7. runs `claude -p` headless in its outbox, the lead-main copy an added folder it may only read, by full paths (the
//      Dispatcher may swap the copy while it runs, so it never starts inside it), model main and effort high
//      (M10 roles/lead.json), its output kept in .run.log, for at most RUN_MS. Once claude has started (it has a pid) it
//      writes .launch.json, { session, product, head, idea } (M3 launchFileText), which intake records as the Lead's
//      launch once the head is one the export gave; a run that never started leaves none (#682 r1 m5). When the run
//      ends it writes .run-ended, reads the copy's head again and says so if it moved while the Lead ran;
//   8. waits for the Dispatcher to take plan-<idea id>.json (its intake fact), at most OUTCOME_WAIT_MS, and prints what
//      the Record made of it: the draft cards it created, or why it was refused or held.
//
//   node …/setup/lead.mjs release <product> <idea id> frees an idea whose plan was interrupted while being filed, once
//   no card was filed from it (releasePlan): the owner can't write the Record, so it leaves a request the Dispatcher's
//   intake checks again and records (#682 r2 M-B). A Lead whose start was never recorded has its waiting plans refused
//   by intake when it marks it stale, which frees their ideas.
//
// The Lead's walls (M4 render-settings.mjs, for role lead): tools Read, Glob, Grep, Write and AskUserQuestion, no shell,
// no tool server, no plugin; its tools write only its outbox (the plain-files hook, given its kinds and no copy), never a
// dot-name there; the Record, secrets, the owner's keys and every product's proposals are read-denied. A headless run has
// no one to answer AskUserQuestion: the one-shot wording says to put the question in a card that waits on the owner.

import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIGN_PROFILES, checkProfile } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { readBack } from '../modules/M4-workshop/launcher/readback.mjs';
import { FLAGS as F } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { factIds, listDocFiles, readDocFile } from '../modules/M9-record/read-view.mjs';
import { LAUNCH_FILE, LEAD_ROLE, isLeadSession, launchFileText, leadSessionId } from '../modules/M3-lead/sessions.mjs';
import { LEAD_ONE_SHOT, LEAD_WORDING, oneShotPlanName } from '../modules/M3-lead/lead-wording.mjs';
import { leadInputText } from '../modules/M3-lead/lead-input.mjs';
import { copyHead } from '../modules/M11-dispatcher/lead-main.mjs';
import { LEAD_STALE_FACT, RELEASE_PREFIX, releaseText } from '../modules/M11-dispatcher/outbox-intake.mjs';
import { appliedFactId, stateText } from '../modules/M1-front-door/filed.mjs';
import { PROMPT_FILE_FLAG, SETUP_FILE, prepareStart, readSetup, roleFlags } from './role-start.mjs';
import { WORKER_STATUS_FILE, leadMainPath, reviewCopiesPath, workerCopiesPath, workerRunnerPaths } from './layout.mjs';

/** The role file's model and effort (M10 roles/lead.json): main is no --model, the account's own, as the review runner starts its roles. */
export const LEAD_MODEL = null;
export const LEAD_EFFORT = 'high';
export const PROMPT_NAME = '.lead-prompt.md';
export const RUN_LOG = '.run.log';
/** How long the Lead may run before it is stopped. */
export const RUN_MS = 30 * 60 * 1000;
/** Written in the outbox once the run has ended, started or not (#682 r1 M1): a Lead with it and no plan holds no idea. */
export const RUN_ENDED = '.run-ended';
/** A Lead started longer ago than this has ended even with no RUN_ENDED (its start was cut off): RUN_MS and the kill's wait. */
export const RUN_OVER_MS = RUN_MS + 5 * 60 * 1000;
/** How long, after the Lead ends, to wait for the Dispatcher to take its plan, and how often to look. */
export const OUTCOME_WAIT_MS = 15 * 60 * 1000;
export const OUTCOME_EVERY_MS = 15_000;
export const USAGE = 'usage: node lead.mjs plan|release <product> <idea id> [--setup <setup.json>]';
const WHO = 'the Lead';
const IDEA_ID = /^idea-[A-Za-z0-9-]{1,180}$/;
// Only a refused plan lets the idea be planned again: applied, applying, waiting, interrupted, starting or any other
// state stands in the way (#682 r1 M1).
const REFUSED = 'refused';
const DONE = Object.freeze(['applied', REFUSED]);
const PLAIN_NAME = /^[A-Za-z0-9._-]{1,255}$/;
/** The ideas' claims, in the Lead folder (#682 r2 M-A); intake lists only ld- names there. */
export const CLAIM_PREFIX = '.claim-';
/** A release request the owner leaves in a Lead's outbox for intake (#682 r2 M-B): `.release-<plan file name>`. */
export { RELEASE_PREFIX } from '../modules/M11-dispatcher/outbox-intake.mjs';

/** The Lead's notes folder (render-settings: apart from its outbox), beside the outbox under the Lead folder; intake lists only ld- names. */
export const notesFolder = (outboxRoot, sessionId) => join(outboxRoot, LEAD_ROLE, `.notes-${sessionId}`);

/** The idea's report id: as given, or with "idea-" put in front. → the id, or null when it is not one. */
export function ideaIdOf(arg) {
  const id = typeof arg === 'string' && !arg.startsWith('idea-') ? `idea-${arg}` : arg;
  return IDEA_ID.test(id ?? '') ? id : null;
}

/**
 * Intake's facts for a plan of this idea from any one-shot Lead of this product: [{ sessionId, doc }], doc null with
 * `unread` (its reason) for a fact that is there but can't be read: it is held, as everywhere else (#682 r2 m-3).
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
    else if (!r?.missing) out.push({ sessionId, doc: null, unread: String(r?.reason ?? 'no answer').slice(0, 200) });
  }
  return out;
}

/** What an earlier plan's fact says, for a refusal: its state, or that it can't be read. */
const planStateText = (x) => (x.doc ? stateText(x.doc) : `unreadable (${x.unread}), so it is held`);

/**
 * When a Lead folder from before claims was started, from its id's stamp (local time, M3 leadSessionId), or null. Only
 * heldBy's fallback reads it; a claim keeps its own started_at_ms (#682 r2 M-A).
 */
export function sessionStart(sessionId) {
  const m = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(sessionId ?? '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/**
 * Why the Lead `sid` still holds the idea whose plan file is `name`, or null when it is free (#682 r2 M-A, one rule for
 * the claim and the fallback): free when (a) its plan's fact is refused, (b) its run ended (RUN_ENDED) with no plan file,
 * (c) it started more than RUN_OVER_MS ago with no plan file, or (d) intake marked it stale (its start was never
 * recorded; intake refuses its waiting plans then, M-B). A fact or folder that can't be read holds it.
 * Not covered, by design: a claude killed by -9 past RUN_OVER_MS whose plan file lands later, and a plan written after
 * .run-ended; each is a plan file in the outbox, so it holds by (a)'s rule again until refused (#682 r2 m-1).
 * `names` the Lead folder's names (null: none), `startedAt` epoch ms or null, `fact(id)` read-view's answer.
 */
export function sessionHold({ sid, name, names, startedAt, fact, now }) {
  const f = fact(appliedFactId(sid, name));
  if (f?.ok && f.doc?.state === REFUSED) return null;
  if (!f?.ok && !f?.missing) return `its ${name}'s record can't be read (${String(f?.reason ?? 'no answer').slice(0, 120)})`;
  const stale = fact(LEAD_STALE_FACT(sid));
  if (stale?.ok) return null;
  // No folder yet is not an end: a claim is taken before its folder is made, so only its time ends it then.
  const hasPlan = (names ?? []).includes(name);
  const ended = (names ?? []).includes(RUN_ENDED) || (startedAt !== null && now - startedAt > RUN_OVER_MS);
  if (!hasPlan && ended) return null;
  return f?.ok ? `its ${name} is ${stateText(f.doc)}` : hasPlan ? `it handed in ${name}, which the Dispatcher has not taken yet` : 'it is still planning it';
}

// A Lead folder's names: null when it is gone; throws when it can't be read.
function folderNames(dir, io) {
  try { return io.list(dir); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

/**
 * The idea's claims (#682 r3): numbered, `.claim-<product>.<idea id>.<gen>`, and only ever added, never moved, renamed
 * or removed. The one with the highest gen holds the idea. `.` parts the name, as no product or idea id holds one. A
 * claim from r2, with no number, is gen 0. Old claims pile up, one small file per start; that is by design.
 */
const claimBase = (product, ideaId) => `${CLAIM_PREFIX}${product}.${ideaId}`;
export const claimPath = (leadRoot, product, ideaId, gen = 0) => join(leadRoot, gen ? `${claimBase(product, ideaId)}.${gen}` : claimBase(product, ideaId));
/** A claim let go: its own file beside it, `<claim>.released`, written once by the start that owns that gen. */
export const RELEASED_MARK = '.released';
const GEN = /^[1-9][0-9]{0,14}$/;

/** The idea's claims in the Lead folder: { gens (highest first), released (gens with their mark) }. Throws as list does. */
export function listClaims(leadRoot, product, ideaId, io) {
  const base = claimBase(product, ideaId);
  const gens = new Set();
  const released = new Set();
  for (const n of io.list(leadRoot)) {
    if (n === base) { gens.add(0); continue; }
    if (!n.startsWith(`${base}.`)) continue;
    let rest = n.slice(base.length + 1);
    const mark = rest.endsWith(RELEASED_MARK) || rest === RELEASED_MARK.slice(1);
    if (rest === RELEASED_MARK.slice(1)) { released.add(0); continue; }
    if (mark) rest = rest.slice(0, -RELEASED_MARK.length);
    if (GEN.test(rest)) (mark ? released : gens).add(Number(rest));
  }
  return { gens: [...gens].sort((a, b) => b - a), released };
}

/** A claim's text, and its reading: { ok, session, startedAt } | { ok: false, gone?, reason }. */
export const claimText = ({ session, startedAt }) => `${JSON.stringify({ session, started_at_ms: startedAt })}\n`;
export function readClaim(file, product, io) {
  let t;
  try { t = io.readText(file); } catch (e) { return { ok: false, gone: e?.code === 'ENOENT', reason: `it can't be read (${e?.code ?? e?.message})` }; }
  let d;
  try { d = JSON.parse(t); } catch { return { ok: false, reason: 'it does not read as JSON' }; }
  if (!d || typeof d !== 'object' || Object.keys(d).sort().join(',') !== 'session,started_at_ms') return { ok: false, reason: 'it must hold session and started_at_ms only' };
  if (!isLeadSession(d.session, product)) return { ok: false, reason: 'its session is not a Lead of this product' };
  if (!Number.isSafeInteger(d.started_at_ms) || d.started_at_ms <= 0) return { ok: false, reason: 'its started_at_ms is not a time' };
  return { ok: true, session: d.session, startedAt: d.started_at_ms };
}

// Makes claim `file` whole or not at all: written to this start's own file first, then linked to its name, which fails
// (EEXIST) when another start made that gen first. → { ok } | { ok: false, taken } | { ok: false, reason }.
function makeClaim(tmp, file, text, io) {
  try { io.rm(tmp); } catch { /* none left by this start */ }
  try { io.writeFile(tmp, text, 0o600); } catch (e) { return { ok: false, reason: `the idea's claim can't be written (${e?.code ?? e?.message})` }; }
  try { io.link(tmp, file); return { ok: true }; } catch (e) {
    return e?.code === 'EEXIST' ? { ok: false, taken: true } : { ok: false, reason: `the idea's claim ${file} can't be made (${e?.code ?? e?.message})` };
  } finally { try { io.rm(tmp); } catch { /* left; the next start of this session removes it */ } }
}

/**
 * Takes the idea for `sessionId`, before anything is made (#682 r3): the next gen after the highest, made only when
 * there is none or the holder is free (its release mark, or sessionHold's (a)-(d)). Two starts that judge the same
 * holder free race for one gen, and link lets one have it; the other looks again. Nothing is moved or removed, so no
 * start can take away another's claim, and a start that stops anywhere leaves only whole files. A holder that can't be
 * read holds the idea, and the refusal names its file. → { ok: true, file, gen, replaced } | { ok: false, sessionId?,
 * reason }. io: list, readText, writeFile (wx), link, rm (its own temporary file only), now; `fact(id)` read-view's answer.
 */
export function takeClaim({ leadRoot, product, ideaId, sessionId, fact }, io) {
  const name = oneShotPlanName(ideaId);
  const text = claimText({ session: sessionId, startedAt: io.now() });
  const tmp = join(leadRoot, `${CLAIM_PREFIX}~${sessionId}`);
  for (let i = 0; i < 5; i += 1) {
    let c;
    try { c = listClaims(leadRoot, product, ideaId, io); } catch (e) { return { ok: false, reason: `the Lead folder ${leadRoot} can't be listed (${e?.code ?? e?.message})` }; }
    const top = c.gens.length ? c.gens[0] : null;
    let replaced = null;
    if (top !== null && !c.released.has(top)) {
      const file = claimPath(leadRoot, product, ideaId, top);
      const h = readClaim(file, product, io);
      if (!h.ok) return { ok: false, reason: `the idea's claim ${file} can't be used (${h.reason}), so the idea is held. If no Lead is planning ${ideaId}, remove that file and start again` };
      let why;
      try { why = sessionHold({ sid: h.session, name, names: folderNames(join(leadRoot, h.session), io), startedAt: h.startedAt, fact, now: io.now() }); }
      catch (e) { why = `its folder can't be read (${e?.code ?? e?.message})`; }
      if (why) return { ok: false, sessionId: h.session, reason: why };
      replaced = h.session;
    }
    const gen = top === null ? 1 : top + 1;
    const file = claimPath(leadRoot, product, ideaId, gen);
    const made = makeClaim(tmp, file, text, io);
    if (made.ok) return { ok: true, file, gen, replaced };
    if (!made.taken) return { ok: false, reason: made.reason };
  }
  return { ok: false, reason: `the idea's claims in ${leadRoot} kept changing; try again` };
}

/** Lets go of this start's own claim (a start refused, thrown or never started after it took it): its mark, never a removal. */
export function releaseClaim(file, io) {
  try { io.writeFile(`${file}${RELEASED_MARK}`, `${new Date(io.now()).toISOString()}\n`, 0o600); } catch { /* there already, or it frees itself by its time */ }
}

/**
 * The fallback for Lead folders from before claims (#682 r1 M1): one of this product whose launch file names the idea,
 * or that holds its plan file, and that sessionHold does not free, its start read from its stamp. Sessions in `skip`
 * (this start's, and one whose claim was found free) are not looked at. → { sessionId, why } | null. A folder that can't
 * be read holds it. io: list, readText, now; `fact(id)` read-view's answer.
 */
export function heldBy({ leadRoot, product, ideaId, fact, skip = [] }, io) {
  const name = oneShotPlanName(ideaId);
  let sessions;
  try { sessions = io.list(leadRoot).filter((n) => isLeadSession(n, product) && !skip.includes(n)).sort(); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return { sessionId: null, why: `the Lead folders in ${leadRoot} can't be listed (${e?.code ?? e?.message})` };
  }
  for (const sid of sessions) {
    const dir = join(leadRoot, sid);
    let names;
    try { names = folderNames(dir, io); } catch (e) { return { sessionId: sid, why: `its folder ${dir} can't be read (${e?.code ?? e?.message})` }; }
    if (names === null) continue;   // gone since the list: it holds nothing
    let idea = null;
    if (names.includes(LAUNCH_FILE)) { try { idea = JSON.parse(io.readText(join(dir, LAUNCH_FILE)))?.idea ?? null; } catch { /* names no idea */ } }
    if (!names.includes(name) && idea !== ideaId) continue;
    const why = sessionHold({ sid, name, names, startedAt: sessionStart(sid), fact, now: io.now() });
    if (why) return { sessionId: sid, why };
  }
  return null;
}

/**
 * The folders the Lead may not read beside its own (#682 r1 m4, as the workers' otherCopies): every other product's
 * lead-main copy and anything else in lead-main but its own copy, every other Lead's folder and notes under the Lead
 * folder, and the worker and review copies. A Lead started later is not in the list. → { ok, paths } | { ok: false, reason }.
 * io: list.
 */
export function leadOtherCopies({ cfg, product, outboxRoot }, io) {
  const lm = leadMainPath(cfg);
  const out = new Set([workerCopiesPath(cfg), reviewCopiesPath(cfg)]);
  for (const q of Array.isArray(cfg.products) ? cfg.products : []) if (q !== product) out.add(join(lm, q));
  for (const dir of [lm, join(outboxRoot, LEAD_ROLE)]) {
    let names;
    try { names = io.list(dir); } catch (e) { if (e?.code === 'ENOENT') continue; return { ok: false, reason: `${dir} can't be listed (${e?.code ?? e?.message})` }; }
    for (const n of names) {
      if (dir === lm && n === product) continue;
      if (dir !== lm && n.startsWith(CLAIM_PREFIX)) continue;   // the ideas' claims and their marks: a session and a time, or a time
      if (!PLAIN_NAME.test(n) || n === '.' || n === '..') return { ok: false, reason: `${dir} holds ${JSON.stringify(n.slice(0, 80))}, a name the Lead's walls can't spell` };
      out.add(join(dir, n));
    }
  }
  return { ok: true, paths: [...out].sort() };
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
 * io: role-start's (readText, mkdir, writeFile, rm, uid, user, home, env, check) and now, list (folder → names), lstat,
 *   link (the idea's claim, takeClaim), runHeadless (bin, args, { cwd, env, log, timeoutMs, started }) → { code, timedOut, started }, sleep (ms), progress (a
 *   line to the terminal). A run that never started answers { ok: false } with its outbox and log left to read.
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
  const had = earlierPlans({ product, ideaId, ids, fact }).find((x) => x.doc?.state !== REFUSED);
  if (had) {
    const release = had.doc?.state === 'interrupted' ? `. If no cards were filed from it, \`node …/setup/lead.mjs release ${product} ${ideaId}\` frees the idea` : '';
    return no(`the idea ${ideaId} already has a plan: ${name} from the Lead ${had.sessionId} is ${planStateText(had)}${release}`);
  }
  let sessionId; try { sessionId = leadSessionId(product, new Date(io.now())); } catch (e) { return no(e.message); }
  // The idea's claim, taken before anything is made (#682 r2 M-A, r3); every refusal or throw from here lets it go.
  const leadRoot = join(P.outboxRoot, LEAD_ROLE);
  // A fact not in the list read above is not there (a Record with no fact yet has no fact folder, which read-view
  // answers as a problem, not as missing); one written since is read as missing, which holds by the files alone.
  const holdFact = (id) => (ids.includes(id) ? fact(id) : { ok: false, missing: true });
  const claim = takeClaim({ leadRoot, product, ideaId, sessionId, fact: holdFact }, io);
  if (!claim.ok) return no(`the idea ${ideaId} is held by ${claim.sessionId ? `the Lead ${claim.sessionId}` : 'a Lead'}: ${claim.reason}. Start another only once that plan is refused or that run has ended with none`);
  // A start that did not run lets its claim go, by its release mark, whatever stopped it (#682 r3 m4).
  const kept = { run: false };
  try {
    return await claimed({ product, ideaId, sessionId, claim, leadRoot, holdFact, fact, P, cfg, idea: r.doc, name, profile, progress, kept }, io);
  } finally { if (!kept.run) releaseClaim(claim.file, io); }
}

// planLead once it holds the idea's claim; `kept.run` is set once claude has started, which keeps the claim.
async function claimed({ product, ideaId, sessionId, claim, leadRoot, holdFact, fact, P, cfg, idea, name, profile, progress, kept }, io) {
  const fail = (reason) => ({ ok: false, reason });
  // Lead folders from before claims (r1 M1's scan), apart from the one whose claim was just found free.
  const held = heldBy({ leadRoot, product, ideaId, fact: holdFact, skip: [sessionId, ...(claim.replaced ? [claim.replaced] : [])] }, io);
  if (held) return fail(`the idea ${ideaId} is held by ${held.sessionId ? `the Lead ${held.sessionId}` : 'a Lead'}: ${held.why}. Start another only once that plan is refused or that run has ended with none`);
  const code = join(leadMainPath(cfg), product);
  // Its own folder, never a link to somewhere else (#682 r1 m3).
  let cs;
  try { cs = (io.lstat ?? lstatSync)(code); } catch (e) { return fail(`the Lead's copy of main, ${code}, can't be found (${e?.code ?? e?.message}): the Dispatcher's lead-main step makes it (is leadMainRoot in its config?)`); }
  if (cs.isSymbolicLink() || !cs.isDirectory()) return fail(`the Lead's copy of main, ${code}, is ${cs.isSymbolicLink() ? 'a link' : 'not a folder'}, so it is not the copy the Dispatcher made`);
  const head = copyHead(code);
  if (!head) return fail(`the Lead's copy of main, ${code}, names no commit (.head): the Dispatcher's lead-main step makes it (is leadMainRoot in its config?)`);
  const outbox = join(leadRoot, sessionId);
  const input = leadInputText({ items: [{ source: 'idea-file', text: idea.text }] });
  if (!input.ok) return fail(`the idea can't be given to the Lead (${input.reason})`);
  const promptText = `${[...LEAD_WORDING, ...LEAD_ONE_SHOT].join('\n\n')}\n\n${input.text}`;
  const promptFile = join(outbox, PROMPT_NAME);
  const workerRunner = cfg.workerRunner ? { requestsDir: workerRunnerPaths(cfg).requests, statusFile: join(workerRunnerPaths(cfg).state, WORKER_STATUS_FILE) } : undefined;
  const others = leadOtherCopies({ cfg, product, outboxRoot: P.outboxRoot }, io);
  if (!others.ok) return fail(`the Lead's walls can't be made: ${others.reason}`);
  const deny = { ...(P.paths?.deny ?? {}), otherCopies: [...(P.paths?.deny?.otherCopies ?? []), ...others.paths] };
  // It starts in its outbox; the code is an added read-only folder it reads by full paths (render-settings readCode), so a
  // swap of the copy mid-run never leaves it in a deleted folder (#681 audit).
  const st = await prepareStart({ role: LEAD_ROLE, who: WHO, profile, model: LEAD_MODEL, effort: LEAD_EFFORT, places: P, outbox,
    notes: notesFolder(P.outboxRoot, sessionId), paths: { readCode: code, deny, ...(workerRunner ? { workerRunner } : {}) }, promptFile,
    files: [[PROMPT_NAME, promptText]] }, io);
  if (!st.ok) return fail(st.reason);
  progress(`The Lead ${sessionId} is planning ${ideaId} on main at ${head.slice(0, 12)} (at most ${RUN_MS / 60000} minutes).`);
  const launchFile = join(outbox, LAUNCH_FILE);
  let launchProblem = null;
  // The launch file only once claude has started (it has a pid): a run that never starts leaves no launch (#682 r1 m5).
  const started = () => {
    // From here claude runs, so the claim is kept: its run's end, its plan's fate or its time free the idea.
    try { io.writeFile(launchFile, launchFileText({ session: sessionId, product, head, idea: ideaId }), 0o600); kept.run = true; return true; } catch (e) {
      launchProblem = `was stopped: its launch file can't be written (${e?.code ?? e?.message})`;
      return false;
    }
  };
  const ran = await io.runHeadless(P.claudeBin, leadArgs({ profile, settingsFile: st.settingsFile, promptFile, prompt: leadPrompt({ ideaId, outbox, code, now: io.now() }) }),
    { cwd: outbox, env: st.env, log: join(outbox, RUN_LOG), timeoutMs: RUN_MS, started });
  try { io.writeFile(join(outbox, RUN_ENDED), `${new Date(io.now()).toISOString()}\n`, 0o600); } catch { /* its start's stamp still ends it */ }
  if (ran?.started !== true || launchProblem) {
    try { io.rm(launchFile); } catch { /* none was written */ }
    return fail(`the Lead ${sessionId} ${launchProblem ?? `did not start (claude ended with ${ran?.code ?? 'no answer'})`}; nothing was handed in. Its output is in ${join(outbox, RUN_LOG)}`);
  }
  // The copy may have been swapped while it ran: the launch keeps the head it started on, and the owner is told.
  const headAfter = copyHead(code);
  const moved = headAfter !== head ? ` Note: the Lead's copy of main moved from ${head.slice(0, 12)} to ${headAfter ? headAfter.slice(0, 12) : 'none'} while it ran, so it may have read files of both; its plan is recorded on ${head.slice(0, 12)}.` : '';
  const base = { ok: true, sessionId, outbox, head, headAfter, code: ran?.code ?? null, timedOut: ran?.timedOut === true, plan: name };
  let names = [];
  try { names = io.list(outbox); } catch { /* read as none */ }
  if (!names.includes(name)) {
    return { ...base, state: 'none', text: `The Lead ${sessionId} ended${base.timedOut ? ' (stopped: out of time)' : ''} without handing in ${name}. What it did is in ${join(outbox, RUN_LOG)}.${moved}` };
  }
  progress(`The Lead handed in ${name}; waiting for the Dispatcher to take it (at most ${OUTCOME_WAIT_MS / 60000} minutes).`);
  const until = io.now() + OUTCOME_WAIT_MS;
  for (;;) {
    const f = fact(appliedFactId(sessionId, name));
    if (f.ok && DONE.includes(f.doc.state)) return { ...base, state: f.doc.state, text: `${outcomeText(name, f.doc)}${moved}` };
    if (io.now() >= until) {
      const now = f.ok ? stateText(f.doc) : 'not taken yet';
      return { ...base, state: f.ok ? f.doc.state : 'not taken', text: `${name} from the Lead ${sessionId}: ${now}. Type \`node …/setup/front-door.mjs filed ${product}\` later, or look in ${outbox}.${moved}` };
    }
    await io.sleep(OUTCOME_EVERY_MS);
  }
}

/**
 * Frees an idea whose plan was interrupted while being filed (#682 r2 M-B), when no card was filed from it: the Record's
 * cards are read as the owner, and one whose plan_sha256 is the plan's refuses it, naming them. The owner can't write
 * the Record, so the release is a request, `.release-<plan file name>` { name, sha256 } in that Lead's outbox (the Lead
 * can't write a dot-name there), which the Dispatcher's intake checks again and records as the plan's fact refused,
 * "released by Joe; no cards were filed", on its next pass. → { ok, text } | { ok: false, reason, cards? }.
 */
export function releasePlan({ product, idea, setupFile = SETUP_FILE }, io) {
  const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  const ideaId = ideaIdOf(idea);
  if (!ideaId) return no(`${String(idea).slice(0, 80)} is not an idea id (idea-<letters, digits and dashes>)`);
  const s = readSetup({ product, setupFile, who: WHO, howToRun: 'run it as your own Mac user, with no sudo' }, io);
  if (!s.ok) return s;
  const at = { recordRoot: s.places.recordRoot, recordUid: s.places.recordUid };
  let ids;
  try { ids = factIds(at); } catch (e) { return no(`the Record's facts can't be listed (${String(e?.message ?? e).slice(0, 200)})`); }
  const fact = (id) => readDocFile({ ...at, entity: 'fact', id });
  const plans = earlierPlans({ product, ideaId, ids, fact }).filter((x) => x.doc?.state === 'interrupted');
  if (!plans.length) return no(`the idea ${ideaId} has no plan that was interrupted while being filed, so there is nothing to release`);
  const cardsOf = listDocFiles({ ...at, entity: 'card' });
  if (!cardsOf.ok) return no(`the Record's cards can't be read, so whether any were filed can't be told (${cardsOf.reason})`);
  if (cardsOf.unread?.length) return no(`some of the Record's cards can't be read (${cardsOf.unread.length}), so whether any were filed from the plan can't be told`);
  const out = [];
  for (const p of plans) {
    const cards = cardsOf.docs.filter((c) => c.doc?.plan_sha256 === p.doc.sha256).map((c) => c.id).sort();
    if (cards.length) return no(`cards were filed from ${p.doc.name ?? oneShotPlanName(ideaId)} of the Lead ${p.sessionId}: ${cards.slice(0, 20).join(', ')}${cards.length > 20 ? ' and more' : ''}. Look at them on the board; the idea stays held`, { cards });
    const file = join(s.places.outboxRoot, LEAD_ROLE, p.sessionId, `${RELEASE_PREFIX}${oneShotPlanName(ideaId)}`);
    const text = releaseText({ name: oneShotPlanName(ideaId), sha256: p.doc.sha256 });
    try { io.writeFile(file, text, 0o600); } catch (e) {
      let same = false;
      if (e?.code === 'EEXIST') { try { same = io.readText(file) === text; } catch { /* read as not the same */ } }
      if (!same) return no(`the release request ${file} can't be written (${e?.code ?? e?.message})`);
    }
    out.push(`${p.doc.name ?? oneShotPlanName(ideaId)} from the Lead ${p.sessionId}`);
  }
  return { ok: true, text: `Released ${out.join(' and ')}: the Dispatcher records it on its next pass, within a few minutes; then \`node …/setup/lead.mjs plan ${product} ${ideaId}\` may start a new Lead for it.` };
}

/** The real ports. */
export function realIo() {
  const u = userInfo();
  return {
    readText: (f) => readFileSync(f, 'utf8'),
    mkdir: (d, mode) => { mkdirSync(d, { mode }); chmodSync(d, mode); },
    writeFile: (f, text, mode) => { writeFileSync(f, text, { mode, flag: 'wx' }); },
    rm: (d) => rmSync(d, { recursive: true, force: true }),
    link: (a, b) => linkSync(a, b),
    uid: process.getuid(), user: u.username, home: u.homedir, env: process.env, now: () => Date.now(),
    check: (x) => readBack(x),
    list: (d) => readdirSync(d),
    lstat: (p) => lstatSync(p),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    progress: (s) => process.stderr.write(`${s}\n`),
    // claude's output goes to the log, a new file of the owner's alone; past the time limit it is stopped, then killed.
    // `started(pid)` is called once it has a pid; false from it stops the run. → { code, timedOut, started }.
    runHeadless: (bin, args, { cwd, env, log, timeoutMs, started = () => true }) => new Promise((resolve) => {
      let fd;
      try { fd = openSync(log, 'wx', 0o600); } catch { resolve({ code: 127, timedOut: false, started: false }); return; }
      let timedOut = false;
      let child;
      try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', fd, fd] }); } catch { closeSync(fd); resolve({ code: 127, timedOut: false, started: false }); return; }
      closeSync(fd);
      const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); };
      const t = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      // No pid: the start failed (ENOENT and the like), and 'error' follows.
      let began = false;
      if (typeof child.pid === 'number') { began = started(child.pid) !== false; if (!began) stop(); }
      child.on('error', () => { clearTimeout(t); resolve({ code: 127, timedOut, started: began }); });
      child.on('exit', (c, signal) => { clearTimeout(t); resolve({ code: c ?? (signal ? 128 : 1), timedOut, started: began }); });
    }),
  };
}

export async function main(argv, io = realIo(), print = (s) => process.stderr.write(`${s}\n`)) {
  const [cmd, product, idea, ...rest] = argv;
  const i = rest.indexOf('--setup');
  if (!['plan', 'release'].includes(cmd) || !product || !idea || (i >= 0 && !rest[i + 1])) { print(USAGE); return 2; }
  if (cmd === 'release') {
    const x = releasePlan({ product, idea, ...(i >= 0 ? { setupFile: rest[i + 1] } : {}) }, io);
    print(x.ok ? x.text : `Nothing was released: ${x.reason}`);
    return x.ok ? 0 : 1;
  }
  const r = await planLead({ product, idea, ...(i >= 0 ? { setupFile: rest[i + 1] } : {}) }, io);
  if (!r.ok) { print(`The Lead did not start: ${r.reason}`); return 1; }
  print(r.text);
  return r.state === 'applied' ? 0 : 1;
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
