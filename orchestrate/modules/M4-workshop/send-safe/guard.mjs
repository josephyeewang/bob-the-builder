// The one check every write into a live session's terminal goes through.
//
// Ported from Orchestrator.inc @1e478c5 (Apache-2.0), modified: see
// ../third_party/orchestrator-inc/NOTICE. Source: backend/internal/sessionguard/guard.go
// (Deliver, Nudge, NudgeUrgent, NudgeCoordination and the shared send path; the
// mutation-fence and composer-draft variants are not ported).
//
// Every typed line is followed by Enter, so typing into a session paused on a permission
// dialog would answer it for the person. The guard re-reads the session just before typing
// and refuses wherever only the person may act. When in doubt it does not type.

import { State, needsInput, WATCHDOG_PREFIX } from './activity.mjs';

// Anything but SENT means nothing reached the terminal. The unknown outcome is the default:
// a forgotten assignment must never read as a send.
export const Outcome = Object.freeze({
  SUPPRESSED_UNKNOWN: 'suppressed_unknown',
  SENT: 'sent',
  SUPPRESSED_NOT_FOUND: 'suppressed_not_found',
  SUPPRESSED_TERMINATED: 'suppressed_terminated',
  SUPPRESSED_EXITED: 'suppressed_exited', // the terminal may now be a plain shell
  SUPPRESSED_AWAITING_USER: 'suppressed_awaiting_user',
  SUPPRESSED_BUSY: 'suppressed_busy',
  SUPPRESSED_INPUT_GATED: 'suppressed_input_gated',
  SUPPRESSED_STARTUP_PENDING: 'suppressed_startup_pending',
  SUPPRESSED_NOT_PERSON: 'suppressed_not_person', // ours: deliver() on an automated guard
  REFUSED_BY_SENDER: 'refused_by_sender', // ours: the sender refused the line before typing anything
});

// Ours (audit 0b-3 R29 MAT-3): every automated write carries the prefix, so M2 Approvals can
// tell it from the person's own typing. Only a guard made by personGuard() may type an unprefixed line,
// and the Dispatcher is never given one.
const PERSON = Symbol('person');
export const withWatchdogPrefix = (text) => `${WATCHDOG_PREFIX} ${String(text).replace(/^\s*\[watchdog\]\s*/i, '')}`;

/**
 * store:     { getSession(id) -> record | null } (may be async, may throw)
 * messenger: { send(id, text) } (async)
 * lease:     optional { acquire(id) -> release() | null }; held across the write
 * startupGate: (harness) -> bool. Ours differs from upstream: the default is "gated", so a
 *   session that has sent no hook yet (it may be on a startup dialog) is never typed into.
 * steersActiveTurn / acceptsWaitingInput: (harness) -> bool; missing means "no".
 */
export class Guard {
  #forPerson;
  constructor({ store, messenger, lease = null, startupGate = () => true, log = () => {}, [PERSON]: forPerson = false }) {
    this.#forPerson = forPerson === true;
    this.store = store;
    this.messenger = messenger;
    this.lease = lease;
    this.startupGate = startupGate;
    this.log = log;
  }

  awaitingStartup(rec) {
    return (rec.mode ?? 'tui') === 'tui' && !rec.firstSignalAt && !!this.startupGate(rec.harness);
  }

  // The person typed it: refused only on a live decision (an idle prompt is where it belongs).
  deliver(id, text, opts) {
    if (!this.#forPerson) { this.log({ id, outcome: Outcome.SUPPRESSED_NOT_PERSON }); return Promise.resolve({ outcome: Outcome.SUPPRESSED_NOT_PERSON }); }
    return this.#send(id, text, opts, (rec) => {
      if (this.awaitingStartup(rec)) return Outcome.SUPPRESSED_STARTUP_PENDING;
      if (rec.activity?.state === State.BLOCKED) return Outcome.SUPPRESSED_AWAITING_USER;
      return null;
    });
  }

  // Unasked-for: refused whenever the session waits on the person.
  nudge(id, text, opts) {
    return this.#send(id, withWatchdogPrefix(text), opts, (rec) => {
      if (this.awaitingStartup(rec)) return Outcome.SUPPRESSED_STARTUP_PENDING;
      if (needsInput(rec.activity?.state)) return Outcome.SUPPRESSED_AWAITING_USER;
      return null;
    });
  }

  // Must reach a session parked at its prompt, but never one on a live decision.
  nudgeUrgent(id, text, { acceptsWaitingInput, ...opts } = {}) {
    return this.#send(id, withWatchdogPrefix(text), opts, (rec) => {
      if (this.awaitingStartup(rec)) return Outcome.SUPPRESSED_STARTUP_PENDING;
      const s = rec.activity?.state;
      if (s === State.BLOCKED) return Outcome.SUPPRESSED_AWAITING_USER;
      // Ours: an open question is a decision, whatever the harness says about its prompt.
      if (s === State.WAITING_INPUT && rec.activity?.reason === 'question') return Outcome.SUPPRESSED_AWAITING_USER;
      if (s === State.WAITING_INPUT && !acceptsWaitingInput?.(rec.harness)) return Outcome.SUPPRESSED_AWAITING_USER;
      return null;
    });
  }

  // Unasked-for and decided at the moment of typing: also refused mid-turn unless the
  // harness can be steered during a turn.
  nudgeCoordination(id, text, { steersActiveTurn, ...opts } = {}) {
    return this.#send(id, withWatchdogPrefix(text), opts, (rec) => {
      if (this.awaitingStartup(rec)) return Outcome.SUPPRESSED_STARTUP_PENDING;
      const s = rec.activity?.state;
      if (needsInput(s)) return Outcome.SUPPRESSED_AWAITING_USER;
      if (s === State.ACTIVE && !steersActiveTurn?.(rec.harness)) return Outcome.SUPPRESSED_BUSY;
      return null;
    });
  }

  async #send(id, text, { signal } = {}, refuse) {
    // Ours (MAT-4): the lease may be async; anything but a release function is a closed gate.
    let release;
    try { release = this.lease ? await this.lease.acquire(id) : () => {}; } catch { release = null; }
    if (typeof release !== 'function') { this.log({ id, outcome: Outcome.SUPPRESSED_INPUT_GATED }); return { outcome: Outcome.SUPPRESSED_INPUT_GATED }; }
    try {
      let rec;
      try {
        rec = await this.store.getSession(id);
      } catch (err) {
        return { outcome: Outcome.SUPPRESSED_UNKNOWN, error: err }; // unknown state: fail closed
      }
      if (!rec) return this.#suppress(id, Outcome.SUPPRESSED_NOT_FOUND);
      if (rec.terminated) return this.#suppress(id, Outcome.SUPPRESSED_TERMINATED);
      if (rec.activity?.state === State.EXITED) return this.#suppress(id, Outcome.SUPPRESSED_EXITED);
      // Ours: a state this file doesn't know is treated as unknown, never as safe.
      if (!Object.values(State).includes(rec.activity?.state)) return this.#suppress(id, Outcome.SUPPRESSED_UNKNOWN);
      const refused = refuse(rec);
      if (refused) return this.#suppress(id, refused, rec.activity.state);
      // The caller is gone: never let that become a write.
      if (signal?.aborted) return { outcome: Outcome.SUPPRESSED_UNKNOWN, error: new Error('cancelled') };
      try {
        await this.messenger.send(id, text);
      } catch (err) {
        // Ours (audit round 2): a line the sender refused was never typed, so it is not "sent".
        if (err instanceof SenderRefusal) return { outcome: Outcome.REFUSED_BY_SENDER, error: err };
        return { outcome: Outcome.SENT, error: err }; // the write was attempted
      }
      return { outcome: Outcome.SENT };
    } finally {
      try { await release(); } catch (err) { this.log({ id, releaseError: err }); } // never hides a SENT
    }
  }

  #suppress(id, outcome, state) {
    this.log({ id, outcome, state });
    return { outcome };
  }
}

// The only way the Dispatcher types into a session (design v4 §8.2 act 3): coordination
// rules, and every line starts with "[watchdog] ". Refused on blocked, waiting_input, active,
// exited, not found, terminated, startup not finished, and any unknown or unreadable state.
// (Whether a [watchdog] line can count as an approval is M2 Approvals' check, not this one.)
export function sendSafe(guard, id, text, { signal } = {}) {
  return guard.nudgeCoordination(id, text, { signal }); // no capability may be passed in (m5)
}

/** The only guard that may type an unprefixed line: the person's own typing, relayed. */
export function personGuard(opts) {
  return new Guard({ ...opts, [PERSON]: true });
}

/** Thrown by a sender that refuses a line before typing any of it. */
export class SenderRefusal extends Error {}

// Types into a tmux pane: literal text, then Enter. Arguments are an array (no shell); text
// with control characters is refused, since a newline inside it would submit early.
export function tmuxMessenger({ run, targetFor }) {
  return {
    async send(id, text) {
      if (/[\u0000-\u001f\u007f]/.test(text)) throw new SenderRefusal('text holds control characters');
      // tmux reads an argument ending in ";" as a command separator and drops it (m2).
      if (/;\s*$/.test(text)) throw new SenderRefusal('text ends in ";"');
      const target = targetFor(id);
      if (!target || /[^A-Za-z0-9_.:%$@-]/.test(target)) throw new SenderRefusal(`bad tmux target for ${id}`);
      // One tmux call, so no hook can land between the text and its Enter (m1).
      await run('tmux', ['send-keys', '-t', target, '-l', '--', text, ';', 'send-keys', '-t', target, 'Enter']);
    },
  };
}
