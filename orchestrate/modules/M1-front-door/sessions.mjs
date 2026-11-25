// sessions.mjs — the Front Door's sessions, by the name of their outbox folder (Track A step 6, design v4 §10.0).
//
// Joe starts the Front Door in a Ghostty tab (setup/front-door.mjs). Each start makes one outbox folder,
// <outboxRoot>/front_door/fd-<product>-<YYYYMMDDHHMMSS>, as Joe's own Mac user, and the AI writes its ideas, asks and
// compaction notes there. The folder's name is the registration: each pass, the product's Dispatcher lists the Front
// Door folder and hands every folder named for its product to intake (M11 outbox-intake.mjs) as a front_door session
// whose files must be the owner's (hostLockUid). So only an idea filed in that product's Front Door reaches its Record.
//
// What this trusts (said plainly): any program running as Joe's own Mac user can make such a folder and put a file in
// it, as it can type into his tab. The kinds a Front Door may hand in are ideas, asks and its notes (shared/record-names.mjs
// OUTBOX_KINDS): never a go, a card change or a merge. The go stays Joe's alone (setup/go-card.mjs, setup/go.mjs).
//
// A session folder stays after its tab is closed, so a file written just before the close is still taken. Ended
// folders are left; clearing them is a later step's (STILL OWED: the folders build up, one per start).

// The listing itself is shared with the Lead's (shared/owner-sessions.mjs; L1370): these are its Front Door names.

import { join } from 'node:path';
import { ownerSessionId, isOwnerSession, ownerSessions } from '../../shared/owner-sessions.mjs';

export const FRONT_DOOR_ROLE = 'front_door';
export const FRONT_DOOR_PREFIX = 'fd';

/** The session id (and its outbox folder's name) of a start at `date`, in the Mac's own time zone. */
export const frontDoorSessionId = (product, date = new Date()) => ownerSessionId(FRONT_DOOR_PREFIX, product, date);

/** Whether `name` is a Front Door session of `product`: fd-<product>-<14 digits>, so product a's never matches a-b's. */
export const isFrontDoorSession = (name, product) => isOwnerSession(FRONT_DOOR_PREFIX, name, product);

/** The Front Door folder: every session's outbox is directly inside it. */
export const frontDoorFolder = (outboxRoot) => join(outboxRoot, FRONT_DOOR_ROLE);

/** This product's Front Door sessions (shared/owner-sessions.mjs ownerSessions, role front_door). */
export const frontDoorSessions = (o) => ownerSessions({ ...o, role: FRONT_DOOR_ROLE, prefix: FRONT_DOOR_PREFIX });
