// Session activity: is a live session working, idle, or paused on the person?
//
// Ported from Orchestrator.inc @1e478c5 (Apache-2.0), modified: see
// ../third_party/orchestrator-inc/NOTICE. Sources: backend/internal/domain/activity.go
// and backend/internal/lifecycle/manager.go (toolFlight, applyToolPrecedenceLocked,
// and the state write of ApplyActivitySignal, without its checkpoint and telemetry parts,
// and without the paths for agent programs other than Claude Code).
//
// The rule this file exists for: "waiting" is sticky. A session paused on a permission
// dialog (blocked) stays blocked until the exact approved tool's own post, a turn
// boundary, or the session's end says the dialog is gone. Helper (subagent) traffic,
// notifications and a lost hook never clear it. When unsure, it stays blocked.

export const State = Object.freeze({
  ACTIVE: 'active',
  IDLE: 'idle',
  WAITING_INPUT: 'waiting_input',
  BLOCKED: 'blocked',
  EXITED: 'exited',
});

// A paused state must not age out with time; only a new signal changes it.
export const isSticky = (s) => s === State.WAITING_INPUT || s === State.BLOCKED;
// The person is the one who unblocks: waiting for the next instruction, or on a decision.
export const needsInput = (s) => s === State.WAITING_INPUT || s === State.BLOCKED;

// Lost posts must not grow the in-flight map forever; at the cap it resets. Ours: after a
// reset the map may have lost the dialog's own tool, so no candidate is named until the next
// turn boundary, and only that boundary clears a block (upstream named a same-name sibling).
export const MAX_INFLIGHT_TOOLS = 128;

const isPostToolUseEvent = (e) => e === 'post-tool-use' || e === 'post-tool-use-failure';
const isToolUseEvent = (e) => e === 'pre-tool-use' || isPostToolUseEvent(e);

// Events that reliably mean a pending dialog is gone: a definitive permission reply,
// a new prompt, or the end of the turn or session.
const isTurnBoundaryEvent = (e) => ['user-prompt-submit', 'stop', 'stop-failure', 'interrupt', 'session-end',
  'process-exited', 'chat.controller.stopped', 'permission-resolved', 'liveness-probe'].includes(e);

// Ours, not upstream: text the Dispatcher types always starts with this prefix, and such a
// prompt is never evidence that the person answered anything (design §8.2 act 3).
export const WATCHDOG_PREFIX = '[watchdog]';
export const isWatchdogText = (text) => typeof text === 'string' && text.trimStart().toLowerCase().startsWith(WATCHDOG_PREFIX);

/**
 * Tracks every session's activity from hook signals. `store` holds session records:
 * { id, activity: { state, at }, firstSignalAt, terminated }. In-flight tool state is
 * in memory only: a restart loses it and the session clears at its next turn boundary. This assumes one
 * permission dialog on screen at a time (README open items: a live check next to L1).
 */
export class ActivityTracker {
  constructor(store, { notify = () => {}, now = () => Date.now() } = {}) {
    this.store = store;
    this.notify = notify;
    this.now = now;
    // id -> { inflight: Map<toolUseId, toolName>, blockedCandidate, degraded } (open questions live on the record)
    this.flights = new Map();
  }

  // Folds an event-tagged signal through the session's tool-flight state and returns the
  // signal to write, or one with valid=false ("suppressed": tracking landed, state must not
  // change). Signals without an event pass through untouched (upstream's compatibility rule).
  applyToolPrecedence(id, cur, s) {
    const suppressed = { ...s, valid: false };
    // Ours, inverted from upstream's last-writer-wins: an untagged signal never lifts a pause
    // (review 0b-3 M1). Our hook mapping always tags, so an untagged one is a stray.
    if (!s.event) return isSticky(cur) ? suppressed : s;
    let fl = this.flights.get(id);
    const ensure = () => {
      if (!fl) { fl = { inflight: new Map(), blockedCandidate: '', degraded: false }; this.flights.set(id, fl); }
      return fl;
    };

    if (s.event === 'pre-tool-use') {
      if (s.toolUseId) {
        const f = ensure();
        if (f.inflight.size >= MAX_INFLIGHT_TOOLS) { f.inflight = new Map(); f.degraded = true; f.blockedCandidate = ''; }
        f.inflight.set(s.toolUseId, s.toolName ?? '');
      }
    } else if (isPostToolUseEvent(s.event)) {
      if (fl) fl.inflight.delete(s.toolUseId);
    }

    // Ours (audit 0b-3 R29 MAT-1): an open AskUserQuestion waits on the person even while
    // another dialog is showing. Remember it, and while it is open only its own answer, an
    // escalation to blocked, a real prompt from the person or the session's end may move the
    // state. Idle notifications, stops and helper traffic never do.
    // Every open question is remembered (audit round 2 MAT-1): two boxes can be open at once.
    // A question with no id is kept as '*' and is ended only by an answer with no id. The list
    // is kept on the stored record, not only in memory (audit round 3 MAT-1), so a restarted
    // tracker still knows it; a record that says "question" with no list counts as one question
    // nobody can name ('?'), which only a real prompt or the session's end clears.
    const rec = this.store.get(id) ?? {};
    const asks = Array.isArray(rec.openAsks) ? [...rec.openAsks] : (rec.activity?.reason === 'question' ? ['?'] : []);
    const keep = (list) => { const r = this.store.get(id); if (r) this.store.set(id, { ...r, openAsks: list }); };
    // The stand-in is stored the moment it is used (audit round 4 m2), so a dialog that opens on
    // top of it can't erase it.
    if (!Array.isArray(rec.openAsks) && asks.length) keep(asks);
    if (s.event === 'ask-user-question-open') { asks.push(s.toolUseId || '*'); keep(asks); }
    if (asks.length && s.event !== 'ask-user-question-open') {
      const realPrompt = s.event === 'user-prompt-submit' && !isWatchdogText(s.prompt);
      const ends = s.state === State.EXITED;
      if (s.event === 'ask-user-question-answered') {
        const i = asks.indexOf(s.toolUseId || '*');
        if (i < 0) return suppressed; // not a question we know is open: stay waiting
        asks.splice(i, 1);
        keep(asks);
        if (asks.length) return suppressed; // another box is still on screen
        if (cur === State.BLOCKED) return suppressed; // the other dialog is still showing
        return s;
      }
      if (realPrompt || ends) { keep([]); this.flights.delete(id); return s; }
      if (s.state !== State.BLOCKED) {
        // The blocking tool's own post ends that dialog, but the question is still open.
        if (cur === State.BLOCKED && isPostToolUseEvent(s.event) && fl?.blockedCandidate && s.toolUseId === fl.blockedCandidate) {
          fl.blockedCandidate = '';
          return { ...s, state: State.WAITING_INPUT, reason: 'question' };
        }
        return suppressed;
      }
    }

    if (s.state === State.BLOCKED) {
      // Entering or re-asserting blocked: snapshot which tool the dialog is for. Only a
      // UNIQUE in-flight tool of that name can be named; two same-name tools in flight is
      // ambiguous, so no candidate is kept and only a turn boundary clears (fail closed).
      const f = ensure();
      // An identity-less duplicate (a bare Notification) must not erase the candidate.
      if (s.toolUseId || s.toolName) f.blockedCandidate = '';
      if (f.degraded) return s; // the map may have lost the dialog's tool: name none
      if (s.toolUseId && f.inflight.has(s.toolUseId)) f.blockedCandidate = s.toolUseId;
      if (!f.blockedCandidate && s.toolName) {
        for (const [useId, name] of f.inflight) {
          if (name !== s.toolName) continue;
          if (f.blockedCandidate) { f.blockedCandidate = ''; break; }
          f.blockedCandidate = useId;
        }
      }
      return s;
    }

    if (cur === State.BLOCKED) {
      if (isTurnBoundaryEvent(s.event)) {
        // Ours: a typed [watchdog] line is not the person answering, so it never lifts a block.
        if (s.event === 'user-prompt-submit' && isWatchdogText(s.prompt)) return suppressed;
        this.flights.delete(id);
        return s;
      }
      if (fl) {
        if (isPostToolUseEvent(s.event) && fl.blockedCandidate && s.toolUseId === fl.blockedCandidate) {
          // The one unambiguous blocking tool finished: the dialog was answered.
          fl.blockedCandidate = '';
          return s;
        }
      }
      // Helper or sibling tool traffic, notification sub-types, anything else: no proof.
      return suppressed;
    }

    if (isSticky(cur) && isToolUseEvent(s.event)) return suppressed; // background traffic can't clear waiting
    // Ours: a notification never takes a session out of waiting (only a real boundary does).
    if (isSticky(cur) && s.event === 'notification' && !needsInput(s.state)) return suppressed;
    // Ours: a [watchdog] line can't take a session out of "waiting on the person" either.
    if (isSticky(cur) && s.event === 'user-prompt-submit' && isWatchdogText(s.prompt)) return suppressed;
    if (isTurnBoundaryEvent(s.event)) this.flights.delete(id);
    return s;
  }

  // Ours, as upstream's launch check (audit 0b-3 R29 m3): a restart under the same name gets a
  // new launch id. Until its first hook it has sent no signal, so the startup gate stays shut.
  beginLaunch(id, launchId) {
    const rec = this.store.get(id);
    if (!rec || typeof launchId !== 'string' || !launchId) return false;
    this.flights.delete(id);
    this.store.set(id, { ...rec, launchId, firstSignalAt: null, openAsks: [], activity: { state: State.ACTIVE, at: this.now() } });
    return true;
  }

  // Applies one hook signal { valid, state, event, toolName, toolUseId, prompt, at, launchId }.
  applySignal(id, signal) {
    const rec = this.store.get(id);
    if (!rec || rec.terminated) return;
    let s = signal;
    // A late hook from a stopped launch (or one that names none) never moves the new one.
    if (rec.launchId && s?.launchId !== rec.launchId) return;
    // Ours, as upstream (audit 0b-3 R29 MAT-2): an exited session's terminal may now be a plain
    // shell. Late hooks from the old process never bring it back; only a real prompt does.
    if (rec.activity.state === State.EXITED && s.state !== State.EXITED
      && !(s.event === 'user-prompt-submit' && !isWatchdogText(s.prompt))) return;
    if (s.valid) s = this.applyToolPrecedence(id, rec.activity.state, s);
    if (!s.valid) return;
    const now = this.store.get(id) ?? rec; // precedence may have stored the open questions
    const at = s.at ?? this.now();
    const prev = rec.activity.state;
    // A same-state repeat after the first signal is not a write.
    if (prev === s.state && (rec.activity.reason ?? null) === (s.reason ?? null) && rec.firstSignalAt) return;
    // `reason: 'question'` marks a wait on an open AskUserQuestion (nudgeUrgent never types into it).
    const next = { ...now, activity: { state: s.state, at, ...(s.reason ? { reason: s.reason } : {}) } };
    if (!next.firstSignalAt) next.firstSignalAt = at;
    if (s.state === State.EXITED) this.flights.delete(id); // no correlation survives an exit
    this.store.set(id, next);
    // Entering the needs-input family pings the person once; escalation inside it doesn't.
    if (!needsInput(prev) && needsInput(next.activity.state)) this.notify({ type: 'needs_input', id });
  }

  // A crash or kill fires no session-end hook, so the reaper is the last chance to
  // release the session's in-flight state.
  applyRuntimeObservation(id, { alive }) {
    const rec = this.store.get(id);
    if (!rec || rec.terminated) return;
    if (!alive) {
      this.store.set(id, { ...rec, terminated: true });
      this.flights.delete(id);
    }
  }
}

// A plain Map-backed store, enough for tests and for one Dispatcher process.
export class MemoryStore {
  constructor() { this.sessions = new Map(); }
  get(id) { return this.sessions.get(id); }
  set(id, rec) { this.sessions.set(id, rec); }
}
