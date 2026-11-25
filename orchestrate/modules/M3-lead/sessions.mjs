// sessions.mjs — the one-shot Lead's sessions, by the name of their outbox folder, and each start's launch file (Track A
// step 8, L1370).
//
// Joe starts a Lead in a tab of his own. Each start makes one outbox folder, <outboxRoot>/lead/ld-<product>-<stamp>, as
// Joe's own Mac user (the same listing as the Front Door's: shared/owner-sessions.mjs), and writes the launch file
// `.launch.json` in it: { session, product, head }, `head` the main commit the Lead was started on. The Lead's own tools
// may not write a dot-name in its outbox (M4 render-settings.mjs denies Edit/Write of <outbox>/.* for every role), and
// intake never takes a dot-name as a hand-in, so the file is the start's word, not the Lead's.
//
// Intake reads the file once, when the session has no launch record yet, and records the launch (M11 lead-restart.mjs
// recordLeadLaunch) only when the head is one the lead-main export gave (the `exportedHead` check, outbox-intake.mjs).
// With no record a Lead's plans are refused and the owner is told (M9 applyPlan), so a bad or missing file holds plans,
// never lets one through.
//
// The start command that makes the folder and writes this file is setup/lead.mjs (step 8 PR 3); the export check is M11
// lead-main.mjs's (PR 2). STILL OWED: starting it by itself for each confirmed idea (PR 4).

import { join } from 'node:path';
import { ownerSessionId, isOwnerSession, ownerSessions } from '../../shared/owner-sessions.mjs';
import { readOwnedFile } from '../M4-workshop/launcher/outbox.mjs';

export const LEAD_ROLE = 'lead';
export const LEAD_PREFIX = 'ld';
export const LAUNCH_FILE = '.launch.json';
const LAUNCH_MAX_BYTES = 4096;

/** The session id (and its outbox folder's name) of a Lead start at `date`, in the Mac's own time zone. */
export const leadSessionId = (product, date = new Date()) => ownerSessionId(LEAD_PREFIX, product, date);

/** Whether `name` is a Lead session of `product`: ld-<product>-<14 digits>. */
export const isLeadSession = (name, product) => isOwnerSession(LEAD_PREFIX, name, product);

/** This product's one-shot Lead sessions (shared/owner-sessions.mjs ownerSessions, role lead). */
export const leadSessions = (o) => ownerSessions({ ...o, role: LEAD_ROLE, prefix: LEAD_PREFIX, label: 'Lead' });

/** The launch file's text for a start: what the start command writes. */
export function launchFileText({ session, product, head }) {
  return `${JSON.stringify({ session, product, head })}\n`;
}

/**
 * The launch file of session `s` ({ sessionId, outbox, uid, product }): { ok: true, head } | { ok: false, none?, reason }.
 * `none` is "no file" (nothing to tell: a Lead the runner started has none). Opened through M4's one safe open
 * (readOwnedFile): not following a link, a plain file with one name, `s.uid`'s, small. It must name this session and
 * product with a full commit sha, nothing else. When to stop looking is intake's, from its own checks (L1370 audit r2).
 */
export function readLaunchFile(s, { open } = {}) {
  const f = readOwnedFile(join(s.outbox, LAUNCH_FILE), { uid: s.uid, label: 'the launch file', notOwned: 'the launch file is not the owner\'s', maxBytes: LAUNCH_MAX_BYTES, ...(open ? { open } : {}) });
  if (!f.ok) {
    if (f.missing) return { ok: false, none: true, reason: 'no launch file' };
    return { ok: false, reason: f.code ? `${f.reason} (${f.code})` : f.reason };
  }
  const no = (reason) => ({ ok: false, reason });
  let doc;
  try { doc = JSON.parse(f.text); } catch { return no('the launch file does not read as JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('the launch file is not a JSON object');
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'head,product,session') return no('the launch file must hold session, product and head only');
  if (doc.session !== s.sessionId) return no('the launch file names another session');
  if (doc.product !== s.product) return no('the launch file names another product');
  if (typeof doc.head !== 'string' || !/^[0-9a-f]{40}$/.test(doc.head)) return no('the launch file\'s head is not a full commit sha');
  return { ok: true, head: doc.head };
}
