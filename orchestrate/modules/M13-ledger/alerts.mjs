// alerts.mjs — one updated GitHub issue per alert condition, never a new one each pass (review-0b-7 M10;
// design v4 R2/R3 "updates it, rather than opening a new one", M13 card "one updated … issue").
//
// WHY. The watcher runs every minute and the heartbeat every 10. A condition left standing (an unsupported deploy still
// live, a Dispatcher down for an hour) would otherwise open ~60 issues an hour, and that volume can hit GitHub's rate
// limits on the robot's token, the same token the Merge Gate and Approvals use. So each alert has a stable key
// (product, kind, subject); a repeat only edits the open issue's body (silent); a comment, which notifies, goes out when
// the condition changes, and again every 24 h while it stands (L315: an open issue is not telling the owner again, so
// this goes through the shared stillWaiting); the issue closes when the condition clears. If the owner closes it while
// the same condition still holds, nothing reopens or comments on it: closing it is their answer. That answer covers that
// cause only (L371): a different status, or the condition coming back after it cleared, opens a new issue, so a close
// never silences a later problem.
//
// Every alert is a robot GitHub issue assigned to the owner (login from private config, passed in). No mail, no
// other channel (design: alerts are only GitHub notices, Actions failure notices or Remote Control pushes).
//
// ONE PLACE FOR THE STATE (L401). The issue says what the alert's state is; the Record only says where to look. State in
// both places meant every Record refusal made GitHub's state read wrong, three audit rounds running. The last line of the
// issue's body is the footer, written only by the robot and read by a strict pattern, so alert text that quotes one
// means nothing:
//   <!-- orch:alert v1 key=<id> status=<hash> since=<iso> told=<iso> cleared=<iso|-> count=<n> owed=<hash|-> owed_at=<iso|-> -->
// A closed issue with `cleared` set has cleared, so the cause coming back opens a new issue. Whether that line was
// written before or after the close doesn't matter: the robot's own clear writes it first, and a clear after an owner's
// close writes it afterwards. A closed issue without it is the owner's answer only if GitHub shows a person other than
// the robot closed it; a bot, an unreadable close or anything else opens a new issue. Noise, never silence.
//
// A notice is three steps, so none of them can lose it or send it twice: an edit sets `owed`, the comment carries that
// value in a hidden mark, and a second edit moves the footer on and clears `owed`. Until that last edit the footer keeps
// the old status, so a pass that finds the comment missing sends the same notice again. A pass that finds the mark on the
// robot's latest comment only finishes the edit. A read or comment that fails answers false and leaves `owed` in place.
//
// What the Record caches: the issue's number and whether it has settled (cleared), so a clean pass makes no GitHub call
// for an old alert. Neither can change a decision: a stale number means a look on GitHub. A refused cache write loses
// nothing, so raise and clear still give their real answer; it only costs reads, and cacheTrouble reports it.
//
// Injected GitHub client for one product repo (a fake in tests):
//   open({ title, body, assignee, labels }) → number      edit(number, body)      close(number, text), text null to say nothing
//   comment(number, text) → { at } (GitHub's time for it, when it gives one)
//   read(number) → { open, body, ours, closedByOwner, created_at }, null when the issue is gone, false when GitHub refused
//     the read. created_at: GitHub's time the issue was opened, or null.
//   lastServerTime: GitHub's own time on its latest answer (its Date header), in ms, or null (L768)
//     ours: the robot wrote it. closedByOwner: GitHub shows a person other than the robot closed it.
//   findOpen(test) → the number of a robot's open issue whose last line passes test, null when there is none
//   listOpen(test) → every robot's open issue whose last line passes test, as [{ number, body }], or false when
//     GitHub refused a page or the list could not be read whole (only the daily sweep uses it)
//   latestOwnComment(number, since) → the robot's latest comment since that time, as { at, body }, or null
// edit, comment and close answer false when GitHub refused them; open answers the new issue's number, anything else is
// a lost open (L143). findOpen and latestOwnComment answer false when GitHub refused them.

import { createHash } from 'node:crypto';
import { makeFactWriter, wasSaved } from '../M12-sensors/facts.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';
import { pastTime, stillWaiting } from '../../shared/still-waiting.mjs';

const ISSUE = (n) => Number.isSafeInteger(n) && n > 0;
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const idOf = (key) => `alert-${hashOf(key)}`;

/** GitHub refuses a body over 65,536 characters, and the footer has to survive whatever the alert says. */
const TEXT_MAX = 64_000;
/** The clocks differ, so a comment is looked for from well before the time this side noted. The mark or note it is
 * matched on decides, so looking further back costs nothing. */
const LOOK_BACK_MS = 30 * 60_000;
const lookFrom = (at) => { const t = Date.parse(at); return new Date(Number.isFinite(t) ? t - LOOK_BACK_MS : 0).toISOString(); };
const NONE = '-';
const FOOTER = /^<!-- orch:alert v1 key=(alert-[0-9a-f]{16}) status=([0-9a-f]{16}) since=(\S+) told=(\S+) cleared=(\S+) count=(\d+) owed=([0-9a-f]{16}|-) owed_at=(\S+) -->$/;
const footerOf = (id, f) => `<!-- orch:alert v1 key=${id} status=${f.status} since=${f.since} told=${f.told} cleared=${f.cleared} count=${f.count} owed=${f.owed} owed_at=${f.owed_at} -->`;
const toldMark = (owed) => `<!-- alert-told ${owed} -->`;
const owedFor = (id, status, at) => hashOf(`${id}|${status}|${at}`);
const TAIL = '\n\n---\nfirst seen ';

// The footer before L401. It goes after the first cutover, with oldState below: nothing writes it any more, and an issue
// is rewritten the first time it is touched.
const keyMark = (id) => `<!-- alert-key ${id} -->`;

/** A body's last line, the only line a footer or a marker counts on. */
export const lastLine = (body) => String(body ?? '').trimEnd().split('\n').at(-1).trim();

/** A findOpen test for a fixed marker: the marker has to be the whole last line. */
export const lineIs = (marker) => (line) => line === marker;

/**
 * The robot's clock against GitHub's (L768). A client's `lastServerTime` is GitHub's own time on its latest answer (its
 * Date header), in ms, or null when GitHub gave none. clockAhead → how far the robot's clock `t` is ahead of it, in ms,
 * or null when not known. A "told again once a day" check counts the day by GitHub's times, so a fast clock neither
 * tells the owner on every pass nor silences the daily reminder (L801 M1: holding it back silenced every reminder for as
 * long as the clock stayed wrong). A clock more than CLOCK_AHEAD_MS ahead is said in one log line per round while it
 * stays so (each round makes its own makeAlerts).
 */
export const CLOCK_AHEAD_MS = 5 * 60_000;
export const clockAhead = (gh, t) => { const g = gh?.lastServerTime; return Number.isFinite(g) && Number.isFinite(t) ? t - g : null; };
export const clockTooFast = (gh, t) => (clockAhead(gh, t) ?? 0) > CLOCK_AHEAD_MS;
/** GitHub's time now, in ms: the robot's `t` less how far it is ahead; the robot's own when it is behind or GitHub gave no Date header. */
export const githubNow = (gh, t) => t - Math.max(0, clockAhead(gh, t) ?? 0);

// The product part has no '|' (L973 4): it ends the product, and forget and sweep find a key's product by it.
export function alertKey(product, kind, subject) {
  if (String(product).includes('|')) throw new Error('a product name has no "|": it ends the product part of a key');
  return `${product}|${kind}|${subject}`;
}

/**
 * The daily sweep of alert issues left open after their cause cleared (L402, L957). An issue opened while the Record
 * refused its number has no number in the Record, so when its cause clears, clear finds nothing and answers 'none', and
 * the issue stays open. The sweep closes only on proof: a key some clear in this round (this makeAlerts) answered 'none'
 * for, and no raise in the round raised again. It lists the robot's open issues whose last line is the orch:alert v1
 * footer once, and for a proven key whose issue is on the list it runs that key's own clear, looking on GitHub. An alert
 * nothing clears (a one-time notice, a sensor that can't look) is never closed. It fails closed: with no proof, the list
 * not read whole, the robot's own login unknown or the product's list mark refused, it closes nothing and says why.
 * GitHub's list is read when a proven key is not yet known clear (L959 M1, M2; L965 m2; L973 1): the product's one mark
 * keeps the keys a list showed with no open issue, or whose issue was closed or refused, for an hour from its first
 * write, and a raise of a key takes it off. So a key proven on any pass, by any caller, is looked at within the hour, and
 * a key cleared again every pass doesn't read the list every pass. A key's own mark is written only when the list held
 * an issue for it, naming that issue: a refused close of it is not tried again for a day, a kept one for an hour (L973
 * m4), and another issue of the same key is tried as it comes.
 * Known limits (L965 m3, m4): a raise by another caller landing between the clear's read of an issue and its close is
 * closed with it; the raise after that finds it cleared and opens a new issue, so it is a repeated notice, not a lost one.
 * The proof's time is this computer's and "last seen" the raiser's, so a raiser on another computer with a clock behind
 * can look earlier than the proof; one host at a time (host.lock) keeps the callers on one clock.
 */
export const SWEEP_EVERY_MS = 24 * 3_600_000;
/** How long the product's known-clear list is trusted (L973 1): caps any key's wait behind it at about an hour. */
export const SWEEP_LIST_TRUST_MS = 3_600_000;
/** The Record id of a key's sweep mark: from the key's own hashed id, so two keys never share one (L959 m3). */
export const sweepFactId = (key) => `alert-sweep-${idOf(key).slice('alert-'.length)}`;
/** The Record id of a product's list mark: from the product's hash (L959 m3). */
export const sweepListFactId = (product) => `alert-sweep-list-${hashOf(String(product))}`;
/** The key prefix of the home repository's own checks (outside-watch): not a product, so never swept (L959 m4). */
export const HOME_PREFIX = 'outside-check';
export const SWEEP_NOTE = 'Closed by the daily check of open alerts: its cause cleared while this issue\'s number was not kept, so it was not closed then. If it comes back, a new issue opens.';

/** Whether raise's answer means the alert went out: not when GitHub lost it (false). */
export const wasTold = (answer) => answer !== false;

// An old-form issue's state, from what the Record held then. A status it doesn't know reads as unchanged: one quiet update.
function oldState(s, t) {
  const text = s?.status_text ?? s?.body;
  return { status: typeof text === 'string' ? hashOf(text) : null, since: s?.since ?? t, told: s?.told_at ?? s?.since ?? t,
    cleared: s?.status === 'cleared' ? s.cleared ?? t : NONE, count: s?.count ?? 1, owed: NONE, owed_at: NONE, old: true };
}

// The state an issue holds, or null when it belongs to another key. A robot's issue with no footer (edited away by hand)
// is `lost`: open, it gets one back with one notice; closed, the closer decides.
function stateOf(body, id, s, t) {
  const line = lastLine(body);
  const m = FOOTER.exec(line);
  if (m) return m[1] === id ? { status: m[2], since: m[3], told: m[4], cleared: m[5], count: Number(m[6]), owed: m[7], owed_at: m[8] } : null;
  if (line === keyMark(id)) return oldState(s, t);
  return /^<!-- (orch:alert|alert-key) /.test(line) ? null : { status: null, since: t, told: t, cleared: NONE, count: 1, owed: NONE, owed_at: NONE, lost: true };
}

export function makeAlerts({ rec, gh, owner, actor = 'ledger', now = () => new Date(), masker = makeMasker(), writer = makeFactWriter(rec, { actor, now, masker }), log = (s) => process.stderr.write(`${s}\n`) }) {
  let trouble = null; // why the Record refused a cache write since the last report
  let again = false;  // and an earlier write had been refused too
  let wrote = false;  // a cache write landed
  let refused = null; // the latest cache write refused: which alert, its issue, and the status it was to have
  const clearedNone = new Map(); // key → { id, at }, for each key a clear this round found nothing to close for (the sweep's proof)

  // The robot's own tail of a body, so a line in the alert's text can't pass for its "last seen".
  const lastSeenPart = (body) => { const b = String(body ?? ''); const at = b.lastIndexOf(TAIL); return at < 0 ? '' : b.slice(at); };
  const bodyOf = (id, f, text, t) => `${text.slice(0, TEXT_MAX)}${TAIL}${f.since} · last seen ${t} · seen ${f.count} times\n${footerOf(id, f)}`;
  // GitHub's time, kept only when it is a readable past time: an outside clock never moves told ahead.
  // With no readable time it is GitHub's time now (L801 self-review m1): a fast robot stamp would read as ahead, so due every pass.
  const toldAt = (at, t) => { const p = pastTime(at, Date.parse(t)); return new Date(p ?? githubNow(gh, Date.parse(t))).toISOString(); };

  // Keeps where the issue is. `behind`: GitHub already showed the Record out of date, so an earlier write was refused too.
  const cache = (id, s, key, issue, status, behind) => {
    if (s?.issue === issue && s?.status === status) return;
    const r = writer.put(id, { kind: 'fact.alert', key, issue, status });
    if (wasSaved(r)) { wrote = true; return; }
    refused = { key, issue, status };
    trouble = masker.maskSecrets(String(r?.reason ?? 'no reason given')).text.slice(0, 200);
    again ||= behind;
  };

  const held = async (n, id, s, t) => {
    const i = await gh.read(n);
    if (i === false) return false;
    const f = i?.ours ? stateOf(i.body, id, s, t) : null;
    return f ? { n, i, f } : null;
  };
  // The robot's open issue for this key that the Record doesn't point at.
  const looked = async (id, s, t) => {
    const found = await gh.findOpen((line) => FOOTER.exec(line)?.[1] === id || line === keyMark(id));
    if (found === false) return false;
    if (!ISSUE(found)) return null;
    const at = await held(found, id, s, t);
    return at && !at.i.open ? null : at;
  };

  // The three steps. `next` is the state to end in, and false means nothing is lost: the next pass finds `owed`.
  async function notice(n, id, f, next, text, note, t) {
    let owed = f.owed;
    if (owed === NONE || owed !== owedFor(id, next.status, f.owed_at)) {
      owed = owedFor(id, next.status, t);
      if (await gh.edit(n, bodyOf(id, { ...f, status: f.status ?? next.status, owed, owed_at: t }, text, t)) === false) return false;
    }
    const c = await gh.comment(n, `${note}\n\n${toldMark(owed)}`);
    if (c === false) return false;
    return await gh.edit(n, bodyOf(id, { ...next, told: toldAt(c?.at, t) }, text, t)) !== false;
  }

  // One log line per round (this makeAlerts) while the robot's clock is over CLOCK_AHEAD_MS ahead of GitHub's, however
  // many alerts the round raises (L787, L801, r2 m1): each round makes a new makeAlerts, so a wrong clock is said once
  // a round, and within a round again only after it has been right. A log that throws holds nothing up.
  let clockSaid = false;
  const sayClock = (t) => {
    const ahead = clockAhead(gh, t);
    if (ahead === null) return;
    if (!clockTooFast(gh, t)) { clockSaid = false; return; }
    if (clockSaid) return;
    clockSaid = true;
    try { log(`alerts: this computer's clock is ${Math.round(ahead / 60_000)} minutes ahead of GitHub's; daily reminders are counted by GitHub's time. Set the clock right.`); } catch { /* nothing held up */ }
  };

  // The condition holds now. Returns what happened: opened | updated | changed | reminded (the 24 h comment) | suppressed
  // (the owner closed it), or false when GitHub lost it (L143), and then the next pass tries again.
  // `status` is the condition's stable state; only a change of it comments (and so notifies). A body that carries a
  // changing figure ("down 40 minutes") is edited silently (0b-7 audit M-3). Without a status, the body is the status.
  // `note` is the comment's text when the status changes (default "Changed: <first line>"); masked like the body.
  // Title and body are masked before they are compared, stored or posted.
  // A GitHub call that throws makes raise throw. A caller that keeps something after a raise (a baseline, a login) keeps
  // it only when wasTold says so.
  async function raise({ key, title: rawTitle, body: rawBody, status: rawStatus, note: rawNote }) {
    const id = idOf(key);
    const title = masker.maskSecrets(rawTitle).text;
    const body = masker.maskSecrets(rawBody).text;
    const status = hashOf(rawStatus === undefined ? body : masker.maskSecrets(rawStatus).text);
    const first = body.split('\n')[0];
    const t = now().toISOString();
    const s = writer.get(id);
    let at = ISSUE(s?.issue) ? await held(s.issue, id, s, t) : null;
    if (at === false) return false;
    if (at && !at.i.open) {
      const same = at.f.status === null || at.f.status === status;
      if (at.f.cleared === NONE && same && at.i.closedByOwner) return 'suppressed';
      at = null;
    }
    if (!at) {
      at = await looked(id, s, t);
      if (at === false) return false;
    }
    sayClock(Date.parse(t));   // after a GitHub answer, so its time is this pass's; on every path, not only the quiet one
    if (!at) {
      // The told stamp is GitHub's time, as every later one is (toldAt keeps a comment's own time): one clock counts the day.
      const issue = await gh.open({ title, body: bodyOf(id, { status, since: t, told: new Date(githubNow(gh, Date.parse(t))).toISOString(), cleared: NONE, count: 1, owed: NONE, owed_at: NONE }, body, t), assignee: owner });
      if (!ISSUE(issue)) return false;
      cache(id, s, key, issue, 'open', false);
      return 'opened';
    }
    // An old-form issue's Record fields are all that says what it held, so they stay until its new footer has landed.
    if (!at.f.old) cache(id, s, key, at.n, 'open', true);
    const answer = await (async () => {
      let f = { ...at.f, count: at.f.count + 1 };
      let owedNow = false;
      if (f.owed !== NONE) {
        const last = await gh.latestOwnComment(at.n, lookFrom(f.owed_at));
        if (last === false) return false;
        if (last?.body?.includes(toldMark(f.owed))) {
          const same = f.owed === owedFor(id, status, f.owed_at);
          f = { ...f, owed: NONE, owed_at: NONE, told: toldAt(last.at, t), ...(same ? { status, cleared: NONE } : {}) };
        } else owedNow = true;
      }
      const back = f.cleared !== NONE;
      const changed = f.lost || back || (f.status !== null && f.status !== status);
      const next = { status, since: f.since, told: f.told, cleared: NONE, count: f.count, owed: NONE, owed_at: NONE };
      const still = `Still open since ${f.since}: ${first}`;
      const tell = (note, answer) => notice(at.n, id, f, next, body, note, t).then((ok) => (ok ? answer : false));
      if (changed) return tell(rawNote === undefined ? `${back ? 'Back' : 'Changed'}: ${first}` : masker.maskSecrets(rawNote).text, 'changed');
      if (owedNow) return tell(still, 'reminded');
      // Told again every 24 h while it stands (L315). stillWaiting can't see inside an async tell, so `did` is always
      // 'told' here; only told.answer says what happened. An unreadable told reads as due, never as told.
      // The day is counted by GitHub's time (L768, L801 M1). The told stamps are GitHub's too: the opening's is stamped by
      // GitHub's time, and toldAt keeps each comment's own time from GitHub. So a robot clock ahead of GitHub's, by minutes
      // or by days, neither tells on every pass nor holds a reminder back. With no Date header (GitHub always sends one)
      // the robot's clock counts, as before L768. A clock over CLOCK_AHEAD_MS ahead is logged once while it stays so (sayClock, above).
      const told = stillWaiting({ now: githubNow(gh, Date.parse(t)), waiting: true, clear: () => {}, read: () => ({ told_at: f.told }), tell: () => tell(still, 'reminded') });
      if (told.did !== 'quiet') return told.answer;
      return await gh.edit(at.n, bodyOf(id, next, body, t)) === false ? false : 'updated';
    })();
    if (at.f.old && answer !== false) cache(id, s, key, at.n, 'open', true);
    return answer;
  }

  // The condition no longer holds. The footer says so first, then an open issue closes with a note. Answers 'none' with
  // nothing to clear, and false, with the next pass trying again, when GitHub refused a step (L143). `look` also searches
  // GitHub when the Record doesn't point at an issue.
  // `proof` is the sweep's own (kept inside: the exported clear takes one argument).
  async function clearKey({ key, note = 'Cleared: the condition no longer holds.', look = false }, proof = null) {
    const id = idOf(key);
    const t = now().toISOString();
    const s = writer.get(id);
    const pointed = ISSUE(s?.issue) && s.status !== 'cleared';
    if (!pointed && !look) { clearedNone.set(key, { id, at: t }); return 'none'; }
    let at = pointed ? await held(s.issue, id, s, t) : null;
    if (at === false) return false;
    if (!at && look) {
      at = await looked(id, s, t);
      if (at === false) return false;
    }
    // The sweep's own checks, on the issue as GitHub showed it just now (L959 m2, m5): with the robot's login unknown,
    // any bot's issue reads as the robot's, so nothing is closed (false); an old-form issue is kept; and an issue told
    // or seen at or after the proof was raised again by another caller, so its cause stands and it is kept ('kept').
    if (proof && at) {
      if (!('loginTrouble' in gh) || gh.loginTrouble) return false;
      const seen = Math.max(Date.parse(at.f.told) || 0, Date.parse(/ · last seen (\S+) · /.exec(lastSeenPart(at.i.body))?.[1]) || 0);
      proof.seen = at.n; // the issue it looked at, so a kept one is named by its own number (L965 c1)
      if (at.f.old) return 'kept'; // only an orch:alert v1 footer as the last line is swept (L957 rule 2)
      if (!(seen < Date.parse(proof.at))) return 'kept';
      if (at.i.open) proof.issue = at.n; // only an issue this clear closes is named (L959 review m4)
    }
    if (!at) {
      if (!pointed) return 'none';
      cache(id, s, key, s.issue, 'cleared', false);
      return 'cleared';
    }
    const settled = at.f.cleared !== NONE;
    if (!settled) {
      const old = String(at.i.body ?? '');
      const cut = old.lastIndexOf(TAIL);
      const text = cut < 0 ? old : old.slice(0, cut);
      if (await gh.edit(at.n, bodyOf(id, { ...at.f, status: at.f.status ?? hashOf(text), cleared: t, owed: NONE, owed_at: NONE }, text, t)) === false) return false;
    }
    // A close refused last pass may have said its note already: then only the close is left.
    const said = settled && at.i.open ? await gh.latestOwnComment(at.n, lookFrom(at.f.cleared)) : null;
    if (said === false) return false;
    if (at.i.open && await gh.close(at.n, said?.body?.trim() === note.trim() ? null : note) === false) return false;
    cache(id, s, key, at.n, 'cleared', settled && !at.i.open);
    return 'cleared';
  }

  // The sweep (L402, L957, L959, L965; see SWEEP_EVERY_MS), called after the round's raises and clears on this object.
  // Answers { swept, closed, failed, kept, why }: swept false with a why when it stopped (`closed` then holds what it
  // closed before it stopped), and with why null when every proven key of this product is known clear. `closed` holds
  // the issues the clears closed; `kept`, issues kept as raised again since the proof or old-form; `failed`, a close
  // GitHub refused, tried again by a later proof a day on.
  // The proof does not expire: the caller makes a new makeAlerts each round, so a 'none' is this round's (L957 review m2).
  // The product's mark is written before the list, so a refused list is not read again on every pass.
  async function sweep({ product } = {}) {
    if (typeof product !== 'string' || !product) throw new Error('sweep needs the product');
    if (product.includes('|')) throw new Error('a product name has no "|": it ends the product part of a key');
    if (product === HOME_PREFIX) throw new Error(`sweep is for a product; ${HOME_PREFIX} keys are the home checks`);
    const t = now().toISOString();
    const ms = Date.parse(t);
    const no = (why) => ({ swept: false, closed: [], failed: [], kept: [], why });
    const within = (at, span) => { const last = pastTime(at, ms); return last !== null && ms - last < span; };
    // A key's mark holds its issue back a day after a refused close, and an hour after it was kept (L973 m4).
    const holds = (km) => within(km?.swept_at, km?.kept === true ? SWEEP_LIST_TRUST_MS : SWEEP_EVERY_MS);
    // This product's proven keys, and of them those a list in the last hour has not shown clear (L965 m2, L973 1).
    const proven = [...clearedNone].filter(([key]) => key.startsWith(`${product}|`));
    if (!proven.length) return no(null);
    const pid = sweepListFactId(product);
    const mark = writer.get(pid);
    const markFresh = within(mark?.listed_at, SWEEP_LIST_TRUST_MS);
    const known = new Set(markFresh && Array.isArray(mark.clear_ids) ? mark.clear_ids : []);
    const need = proven.filter(([key, p]) => !known.has(p.id) && !(writer.get(sweepFactId(key))?.kept === true && holds(writer.get(sweepFactId(key)))));
    if (!need.length) return no(null);
    if (typeof gh.listOpen !== 'function') return no('this GitHub client cannot list open issues, so no issue was closed');
    // The list's time is its first write's, kept by later ones, so no id stays known past an hour from it (L973 P7).
    const listedAt = markFresh ? mark.listed_at : t;
    const put = writer.put(pid, { kind: 'fact.alert-sweep-list', listed_at: listedAt, clear_ids: [...known, ...need.map(([, p]) => p.id)] });
    if (!wasSaved(put)) return no(`the Record refused the sweep's mark (${masker.maskSecrets(String(put?.reason ?? 'no reason given')).text.slice(0, 200)}), so GitHub was not asked and no issue was closed`);
    const byId = new Map(need.map(([key, p]) => [p.id, [key, p]]));
    // Known clear from here on (L965 review m1): an id whose issue was closed or refused (its key mark holds it), or that
    // a whole list did not hold. One kept, or not reached (a login stop, a throw), stays needed. The list is read again
    // when written, so a raise's forget meanwhile stands (L973 m2); a refused write is said (L973 m5).
    const listedIds = new Set();
    const handled = new Set();
    let scanned = false;
    let settled = false;
    const finish = (res) => {
      settled = true;
      if (scanned) for (const [, p] of need) if (!listedIds.has(p.id)) handled.add(p.id);
      const cur = writer.get(pid);
      const was = cur?.listed_at === listedAt && Array.isArray(cur.clear_ids) ? cur.clear_ids : [];
      const ids = was.filter((x) => !byId.has(x) || handled.has(x));
      if (ids.length === was.length) return res;
      const w2 = writer.put(pid, { kind: 'fact.alert-sweep-list', listed_at: listedAt, clear_ids: ids });
      if (wasSaved(w2) || !res) return res;
      const say = 'the Record refused the sweep\'s list mark, so a key it tried may wait up to an hour';
      return { ...res, why: res.why ? `${res.why}; ${say}` : say };
    };
    try {
      const list = await gh.listOpen((line) => FOOTER.test(line));
      const whole = Array.isArray(list) && list.every((i) => ISSUE(i?.number) && typeof i.body === 'string');
      // A list not read whole: its ids stay known for the hour, so a GitHub that won't list is not asked every pass.
      if (!whole) { settled = true; return no(`GitHub's list of open issues could not be read whole${gh.lastAnswer ? ` (${gh.lastAnswer})` : ''}, so no issue was closed`); }
      const out = { swept: true, closed: [], failed: [], kept: [], why: null };
      const unmarked = [];
      // Each call learns the login again, and with none any bot counts as the robot: stop then, checked before the list's
      // first close and after each; the clear checks it again on the issue it found (L957 review m3, L959 m2). A client
      // that can't say is read as not known.
      const noLogin = () => !('loginTrouble' in gh) || gh.loginTrouble;
      const loginStop = { swept: false, why: 'the robot\'s own login is not known, so its issues can\'t be told from another app\'s; nothing more was closed' };
      // Before the loop, nothing is known clear (L973 P10).
      if (noLogin()) return finish({ ...out, ...loginStop });
      for (const i of list) { const id = FOOTER.exec(lastLine(i.body))?.[1]; if (byId.has(id)) listedIds.add(id); }
      scanned = true;
      for (const i of list) {
        const hit = byId.get(FOOTER.exec(lastLine(i.body))?.[1]);
        if (hit === undefined) continue;
        const [key, p] = hit;
        // This issue tried by this key lately (its close refused: a day; kept: an hour): not again until then.
        const km = writer.get(sweepFactId(key));
        if (km?.issue === i.number && holds(km)) { if (km.kept !== true) handled.add(p.id); continue; }
        // The key's own clear, looking on GitHub: it finds the robot's open issue for this key by its own checks (the
        // robot's, open, the footer as the last line), says cleared in the footer, then closes it with the note.
        const proof = { at: p.at, issue: null, seen: null };
        const r = await clearKey({ key, note: SWEEP_NOTE, look: true }, proof);
        if (r === 'cleared' && proof.issue !== null) out.closed.push(proof.issue);
        else if (r === false) out.failed.push(proof.issue ?? proof.seen ?? i.number);
        else if (r === 'kept') out.kept.push(proof.seen ?? i.number);
        // The list held an issue for this key: its own mark (L965 m2). A kept one is not known clear, and its mark holds
        // it back an hour, so a key one caller keeps raising and another clearing doesn't read the list every pass (L973 m4).
        if (r !== 'kept') handled.add(p.id);
        const doc = { kind: 'fact.alert-sweep', alert: p.id, issue: i.number, swept_at: t, ...(r === 'kept' ? { kept: true } : {}) };
        if (!wasSaved(writer.put(sweepFactId(key), doc))) unmarked.push(key);
        // Not reached: their ids stay needed.
        if (noLogin()) return finish({ ...out, ...loginStop, ...(unmarked.length ? { why: `${loginStop.why}; ${markSay(unmarked)}` } : {}) });
      }
      if (unmarked.length) out.why = markSay(unmarked);
      return finish(out);
    } finally {
      // A throw (GitHub's list or a clear): the ids not reached stay needed (L973 m3).
      if (!settled) finish(null);
    }
  }
  // The keys whose own mark the Record refused (L965 c4): their issue may be tried again before a day is out.
  const markSay = (keys) => `the Record refused the mark of ${keys.map((k) => masker.maskSecrets(String(k)).text.slice(0, 120)).join(', ')}, so it may be tried again before the day is out`;

  /** Why the Record refused to keep where an alert is, since the last report, or null. */
  const cacheTrouble = () => trouble;
  /** Why the robot's login is unknown, so any bot counts as the robot (L399), or null. */
  const loginTrouble = async () => { await gh.ready?.(); return gh.loginTrouble ?? null; };

  // Called once at the end of a pass. A Record that refuses twice in a row gets one alert of its own, which needs nothing
  // from the Record, and it clears once a write lands (L402). The second refusal is read from GitHub showing the Record
  // behind, not counted: a count would have to be saved in the Record that is refusing. `source` names the caller, and
  // each has its own alert, because the Record can refuse one caller's alert and take another's: one key let a clean pass
  // of the heartbeat close what the watcher had just opened, every 10 minutes (#184 r4 MAT-1). A pass where no write
  // landed says nothing about the Record, and a quiet product can have those for weeks. So the alert's own entry keeps the
  // write that was refused, and such a pass tries that write again, once (#184 r5 m3). Only that write shows the Record
  // takes what it refused: trying any other closed the alert while the Record still refused, and reopened it every pass.
  // The status goes with it: writing 'open' for a clear that was refused would point the cache at a closed issue (L422).
  // An entry already holding both needs no write.
  const retryRefused = ({ retry_key: key, retry_issue: issue, retry_status: status }) => {
    const id = idOf(key);
    const s = writer.get(id);
    return (s?.issue === issue && s?.status === status) || wasSaved(writer.put(id, { kind: 'fact.alert', key, issue, status }));
  };

  async function reportTrouble(product, source) {
    if (!source) throw new Error('reportTrouble needs the caller\'s name');
    const key = alertKey(product, 'alerts', `record-refusing:${source}`);
    const own = idOf(key);
    const why = again ? trouble : null;
    const entry = writer.get(own);
    if (trouble === null && !wrote && entry?.retry_key) wrote = retryRefused(entry);
    const recovered = () => (wrote ? clear({ key, note: 'The Record is taking alert writes again.', look: true }) : 'none');
    const answer = why === null
      ? await recovered()
      : await raise({ key, title: `${product}: the Record is refusing alert writes (${source})`, status: 'refusing',
        body: `The Record refused to save where this product's alerts are (${why}). Alerts still go out, but each pass has to look them up on GitHub until it takes them.` });
    if (why !== null && answer !== false && refused) {
      const cur = writer.get(own);
      if (cur?.status === 'open') writer.put(own, { ...cur, retry_key: refused.key, retry_issue: refused.issue, retry_status: refused.status });
    }
    // After the alert, so a refusal of its own number isn't carried into the next pass as that pass's trouble.
    trouble = null; again = false; wrote = false;
    return answer;
  }

  // A key raised again after its clear loses the sweep's proof (L957). Kept outside raise, which is ruled as it is (L135).
  // And off the product's known-clear list (L965 m2), so the next proof of it reads GitHub's list again. A refused write
  // leaves it on for at most the hour the list is trusted (L973 1), and is told under the Record refusing.
  const forget = (key) => {
    if (typeof key !== 'string') return;
    const pid = sweepListFactId(key.slice(0, key.indexOf('|')));
    const m = writer.get(pid);
    const id = idOf(key);
    if (!Array.isArray(m?.clear_ids) || !m.clear_ids.includes(id)) return;
    const r = writer.put(pid, { kind: 'fact.alert-sweep-list', listed_at: m.listed_at, clear_ids: m.clear_ids.filter((x) => x !== id) });
    // Refused (L973 m1a): told as the Record refusing, in this caller's reportTrouble.
    if (!wasSaved(r)) { trouble = masker.maskSecrets(String(r?.reason ?? 'no reason given')).text.slice(0, 200); again = true; }
  };
  const raised = (args) => { clearedNone.delete(args?.key); forget(args?.key); return raise(args); };
  const clear = (args) => clearKey(args);
  return Object.freeze({ raise: raised, clear, cacheTrouble, loginTrouble, reportTrouble, sweep });
}

// A fake GitHub issue client that records every call but its reads (tests, and the owner's dry runs). With no `now` its
// comments carry no time, so latestOwnComment finds none; a test of the 24 h limit passes its clock. close is the robot's
// and ownerCloses the owner's. `serverNow` is GitHub's clock (lastServerTime, an issue's created_at); with none given,
// GitHub's time is not known, as when an answer has no Date header.
export function fakeIssues({ now = null, serverNow = null } = {}) {
  const issues = new Map();
  const calls = [];
  const spoken = [];
  const gNow = serverNow ?? now;
  const said = (i, body) => { if (gNow) spoken.push({ i, at: gNow().toISOString(), body }); };
  let n = 0;
  return {
    calls, issues, loginTrouble: null,
    get lastServerTime() { return serverNow ? +serverNow() : null; },
    async open({ title, body, assignee, labels }) { n += 1; issues.set(n, { title, body, assignee, labels, closed: false, comments: [], created_at: serverNow ? serverNow().toISOString() : null }); calls.push(['open', n]); return n; },
    async edit(i, body) { issues.get(i).body = body; calls.push(['edit', i]); },
    async comment(i, text) { issues.get(i).comments.push(text); said(i, text); calls.push(['comment', i]); return { at: gNow?.().toISOString() }; },
    async close(i, text) { const x = issues.get(i); x.closed = true; x.byOwner = false; if (text != null) { x.comments.push(text); said(i, text); } calls.push(['close', i]); },
    // Strict, as GitHub would be (#98 r1 m2, Principle 10): asking about something that is not an issue number is a
    // caller's bug, so it throws rather than answering "gone".
    async read(i) {
      if (!Number.isSafeInteger(i) || i <= 0) throw new Error(`fakeIssues.read: not an issue number: ${JSON.stringify(i)}`);
      const x = issues.get(i);
      return x ? { open: !x.closed, body: x.body, ours: x.ours !== false, closedByOwner: x.closed && x.byOwner === true, created_at: x.created_at } : null;
    },
    async findOpen(test) { for (const [k, x] of issues) if (!x.closed && x.ours !== false && test(lastLine(x.body))) return k; return null; },
    async listOpen(test) { calls.push(['listOpen']); return [...issues].filter(([, x]) => !x.closed && x.ours !== false && test(lastLine(x.body))).map(([number, x]) => ({ number, body: x.body })); },
    async latestOwnComment(i, since) { return spoken.filter((c) => c.i === i && c.at >= since).at(-1) ?? null; },
    ownerCloses(i) { const x = issues.get(i); x.closed = true; x.byOwner = true; },
  };
}
