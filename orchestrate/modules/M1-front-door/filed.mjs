// filed.mjs — the read-back of what a Front Door tab filed, from the Record (Track A step 7, design v4 §10.0).
//
// For each file a tab's session handed in (its outbox), the state intake recorded for it in the Record: the fact
// intake-applied-<session>-<name> that M11 outbox-intake.mjs writes before and after it hands the file to the Record
// (its appliedId; the test checks this name is still intake's). Read as the owner through M9 read-view.mjs, the
// Record's own checks for a reader that is not its owner; never written. No fact yet is "not taken yet": the
// Dispatcher takes the files on its next pass. A file intake holds before it writes that fact (a read it refuses, or a
// check it fails: outbox-intake.mjs readHold and noteDaily) has no applied fact at all; its hold is shown instead when
// the Record has one (#658 audit m1). Before the hold is written (a read hold is written once its alert is out) the
// file still reads as not taken yet; the owner's alert is what says more.
//
// setup/front-door.mjs keeps it in the tab's folder as .filed.md while the session runs, for the Front Door to read
// back when the owner asks (the rendered settings deny the AI any write to a dot-file in its outbox, M4
// render-settings.mjs, and intake skips dot-files); prints it in the tab when the session ends; and `front-door.mjs
// filed <product>` prints it for the product's latest tabs at any time. The words are code's, from the Record.

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { OUTBOX_NAME } from '../M4-workshop/launcher/outbox.mjs';
import { factIds, readDocFile } from '../M9-record/read-view.mjs';

/** Intake's fact for one handed-in file (M11 outbox-intake.mjs appliedId, not exported there). */
export const appliedFactId = (sessionId, name) => `intake-applied-${sessionId}-${name}`;
// Intake's holds for one file (M11 outbox-intake.mjs readHoldsOfFile and noteDaily; the test checks they are still
// intake's): the cause after the prefix changes with the reason, so they are found by prefix.
const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
export const holdPrefixes = (sessionId, name) => [`hold-outbox-read-${short(sessionId)}-${short(name)}-`, `hold-outbox-note-${short(`${sessionId} ${name}`)}-`];
/** The file in the tab's folder that holds the read-back while the tab runs (setup/front-door.mjs). */
export const FILED_NAME = '.filed.md';
export const NONE_YET = 'nothing filed in this tab';
export const NOT_TAKEN = 'not taken yet: the Dispatcher takes it on its next pass, within a few minutes';
const cut = (s, n) => String(s).slice(0, n);

/** One file's state, in plain words, from its intake fact. */
export function stateText(fact) {
  switch (fact?.state) {
    case 'applied': return 'filed in the Record';
    case 'refused': return `refused, not filed: ${cut(fact.alert_text ?? fact.reason ?? 'no reason given', 300)}`;
    case 'waiting': return `waiting: ${cut(fact.reason ?? fact.alert_text ?? 'no reason given', 300)}`;
    case 'applying': return 'being filed now';
    case 'interrupted': return 'stopped while being filed; the next pass tries it again';
    default: return `in a state this read-back does not know (${cut(fact?.state, 40)})`;
  }
}

/** A file intake holds without an applied fact: its hold's words, or null when none can be read. */
function heldText({ sessionId, name, fact, factIds }) {
  if (!factIds) return null;
  let ids;
  try { ids = factIds(); } catch { return null; }
  for (const pre of holdPrefixes(sessionId, name)) {
    for (const id of ids.filter((x) => x.startsWith(pre)).sort()) {
      const r = fact(id);
      if (r?.ok && typeof r.doc?.text === 'string') return `held, not filed: ${cut(r.doc.text, 300)}`;
    }
  }
  return null;
}

/**
 * One session's read-back. `files`: its outbox's names (only hand-in names count); `fact(id)` answers as read-view's
 * readDocFile: { ok, doc } | { ok: false, missing: true } | { ok: false, reason }; `factIds()` lists the Record's fact
 * ids (for intake's holds). → { text, rows: [{ name, state }] }
 */
export function filedReadback({ sessionId, files, fact, factIds }) {
  const rows = [...files].filter((n) => OUTBOX_NAME.test(n)).sort().map((name) => {
    const r = fact(appliedFactId(sessionId, name));
    const state = r?.ok ? stateText(r.doc) : r?.missing ? (heldText({ sessionId, name, fact, factIds }) ?? NOT_TAKEN) : `can't be read from the Record (${cut(r?.reason ?? 'no answer', 200)})`;
    return { name, state };
  });
  const body = rows.length ? rows.map((x) => `  - ${x.name}: ${x.state}`).join('\n') : `  ${NONE_YET}`;
  return { text: `What Front Door tab ${sessionId} filed (from the Record):\n${body}`, rows };
}

/** The read-back of a real outbox, from the real Record. A folder that can't be listed says so, never "nothing". */
export function readFiled({ outbox, sessionId, recordRoot, recordUid, list = (d) => readdirSync(d) }) {
  let files;
  try { files = list(outbox); } catch (e) { return { text: `What Front Door tab ${sessionId} filed can't be read: its folder can't be listed (${e?.code ?? e?.message})`, rows: null }; }
  const fact = (id) => readDocFile({ recordRoot, recordUid, entity: 'fact', id });
  // Listed once per read-back, only when a file has no applied fact (read-view.mjs factIds, its checks of each folder on
  // the way). Each hold is then read through readDocFile's checks. A folder that fails a check throws, and the file reads
  // as not taken yet.
  let ids = null;
  const listIds = () => (ids ??= factIds({ recordRoot, recordUid }));
  return filedReadback({ sessionId, files, fact, factIds: listIds });
}
