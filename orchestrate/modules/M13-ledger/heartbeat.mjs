// heartbeat.mjs — the Mini's heartbeat: one pinned GitHub issue per product repo whose body is rewritten every 10
// minutes while the Mini is alive, plus an alert for each thing that is red (R-0b-73; design v4 §7.2 R2, R4, R5, §8 E7;
// review-0b-7 M9, M10 and minors).
//
// Body: `mini_alive_at: <time>` on its own line (the outside check reads it: older than 70 min = stale), then one line
// per fact. Editing the body notifies nobody; each red fact raises its own alert (alerts.mjs: one updated issue,
// cleared when green). A Mini that is off writes nothing, so "stale" is the outside check's to notice.
//
// Facts (probes injected; each returns the value or throws, and a throw counts as red). The front door, account and
// usage probes may also answer null, "not known" (L604, L730 M2): the line and the status fact say so, nothing is
// raised or cleared, and no signed-out fact moves. Null is never a pass and never a no, and the issue's first line
// never says all green while any line is not known.
//   dispatcher        last good Dispatcher pass; red when older than 15 minutes or missing. A caller with its own rule
//                     for "late" passes `dispatcherLate` (→ null when on time, else { since, text }; the robot job's
//                     dispatcherLate, which also excuses a live pass inside its run limit, audit #137 M6): then that one
//                     rule decides red (L730 m2). The alert's status carries when the stop began, so a new stop is a
//                     new notice even after Joe closed the last one (L730 m3). One Joe closed while it lasts answers
//                     'suppressed' in `told`: the caller treats that as not told and tells it its own way, once a day.
//   rules             the M10 Rules file reads and parses.
//   sensors           when the caller passes `sensorsAlive` (heartbeat-probes.mjs: null, or one of its answers): the
//                     Sensors job's newest reading; red when it is past its limit, so a stopped Sensors job is told by
//                     name, not only as readings that went "not known" (L967). Its status carries the newest reading's
//                     time (red:sensors:<iso>), so a new stop is a new notice, as the Dispatcher's (#464 r1 m4); a stop
//                     that lasts is reminded every 24 h by alerts.mjs while its issue is open. Also red: the account
//                     reading alone past the limit (the one the Dispatcher holds on, red:sensors:account:<iso|never>);
//                     a reading stamped ahead of this clock (red:sensors:clock); and no reading at all for longer than
//                     the limit (red:sensors:none; the body says whether the Record could not be read, one status so
//                     a Record that flips between the two is one notice, #464 r2 m4), counted
//                     from the first pass that found none, kept in `heartbeat-sensors-none-since-<product>` and dropped
//                     once a reading is there (r1 M1). Null is not known, as for the probes below, and like them it
//                     neither raises nor clears: an alert open when the line goes not known stays open until a known
//                     reading clears it, never closed on no word.
//   front door        the Front Door answers through the phone link (Remote Control).
//   account           the signed-in Claude account, as its label from private config ("account A"), never an
//                     email address: the probe maps it. Signed out → a `signed-out` fact and one alert; nothing here
//                     restarts anything (the Dispatcher owns that loop, from the Sensors' `signed-in-account`, and no
//                     code reads the `signed-out` fact back but this file). A change to the account
//                     named by a planned switch → one push request "switch the phone app to account <B> too"
//                     (idempotent: the same switch never pushes twice); an unplanned change → an alert of its own.
//                     Both are keyed by a switch count, so a second switch to the same account is a fresh notice
//                     (L152, L158).
//   usage             from the usage fact (R-0b-66) when there is one, else not known. Crossing 50/75/90/95 % of a
//                     window → one alert per window, its body naming the highest threshold (a higher one comments
//                     once; the next window clears it).
// Push requests are facts `push-request-<key>` for the Front Door to deliver (join item with lane 2).
// Returns { red, body, told, posted, postedWhy }: `told` maps each kind raised or cleared this pass to what alerts.mjs
// answered (false = GitHub lost it), so a caller can tell which alert went out, never just whether every one did (L730
// m4). `posted` is true only when GitHub took the pinned issue's new body (an edit or an open answered yes); false, with
// `postedWhy`, when every read, find, edit or open was refused, so a caller fails the pass rather than calling it done
// (#451 r1 m1).

import { createHash } from 'node:crypto';
import { lineIs, wasTold } from './alerts.mjs';
import { TROUBLE_SOURCES, wasSaved, READING_FUTURE_MS } from '../M12-sensors/facts.mjs';

export const DISPATCHER_LATE_MIN = 15;
export const USAGE_STEPS = Object.freeze([50, 75, 90, 95]);
const ISSUE = (n) => Number.isSafeInteger(n) && n > 0;
const NOT_SAVED = 'alert-not-saved';
/** In `red` when an alert GitHub lost was not told this pass (the robot job then also queues its late alert). */
export const NOT_TOLD = 'alert-not-told';
const LOGIN_UNKNOWN = 'robot-login-unknown';
// When the heartbeat first found no Sensors reading (#464 r1 M1). A kind with no shape keeps only its kind and `ts`
// (M12 fact-shapes.mjs), so `ts` is the time it began, and the "seen" kind says a reading was there again.
export const SENSORS_NONE_FACT = (product) => `heartbeat-sensors-none-since-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;
const NONE_SINCE = 'fact.heartbeat-sensors-none-since';
const NONE_SEEN = 'fact.heartbeat-sensors-seen';
const CHECK_SENSORS = 'Check the Sensors background job on the Mini.';
/** The pinned issue's marker: found again by it when the Record never kept its number. */
export const heartbeatMarker = (product) => `<!-- orch:heartbeat ${product} -->`;
const ISSUE_FACT = (product) => `heartbeat-issue-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;
// The status fact the Front Door's trip check reads (review-0b-8 MAT-9): green only while `at` is under an hour old.
export const STATUS_FACT = (product) => `heartbeat-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;

async function probe(fn) { try { return { ok: true, v: await fn() }; } catch { return { ok: false, v: null }; } }
const notKnown = (r) => r.ok && r.v === null;

export async function heartbeatOnce({ product, writer, gh, alerts, owner, probes, plannedSwitch = null, now = () => new Date() }) {
  const t = now();
  const key = (kind) => `${product}|heartbeat|${kind}`;
  const red = []; const lines = []; const toldOf = {};
  // A write the Record refused can't go in an alert (alerts are what it refused), so the pinned issue shows it red (L389).
  const notSaved = (why) => { if (!red.includes(NOT_SAVED)) { red.push(NOT_SAVED); lines.push(`RED   alerts: ${why}`); } };
  // An alert GitHub lost, so a notice left owed pass after pass shows here on each of them (L402).
  const shown = (answer) => {
    if (answer === false && !red.includes(NOT_TOLD)) { red.push(NOT_TOLD); lines.push(`RED   alerts: ${gh.lastAnswer ?? 'GitHub lost an alert'}; the next pass tries again`); }
    return answer;
  };
  const set = async (kind, isRed, line, body, status = `red:${kind}`) => {
    lines.push(`${isRed ? 'RED  ' : 'ok   '} ${line}`);
    if (isRed) { red.push(kind); toldOf[kind] = shown(await alerts.raise({ key: key(kind), title: `${product}: heartbeat red: ${kind}`, body, status })); }
    else toldOf[kind] = shown(await alerts.clear({ key: key(kind), note: `${kind} is green again.` }));
  };

  const d = await probe(probes.dispatcherLastGood);
  const dParsed = d.ok && d.v ? Date.parse(d.v) : NaN;
  const dAge = Number.isFinite(dParsed) ? Math.round((t - dParsed) / 60e3) : null;
  const ageText = dAge === null ? 'unknown' : dAge < -10 ? 'time is in the future' : `${dAge} min ago`;
  let dRed = dAge === null || dAge < -10 || !(dAge <= DISPATCHER_LATE_MIN);
  let dBody = `The Dispatcher's last good pass was ${dAge === null ? 'never recorded' : `${dAge} minutes ago`} (red after ${DISPATCHER_LATE_MIN}). Nothing new is being started or merged.`;
  let since = Number.isFinite(dParsed) ? dParsed : null;
  let dLine = `last good Dispatcher pass: ${ageText}`;
  if (typeof probes.dispatcherLate === 'function') {
    const late = await probe(probes.dispatcherLate);
    const v = late.ok ? late.v : undefined;
    dRed = !late.ok || v !== null;
    if (v) { dBody = `${String(v.text ?? 'the Dispatcher is late')}.`; since = Number.isFinite(v.since) ? v.since : null; }
    else if (!late.ok) dBody = 'Whether the Dispatcher is running could not be read. Nothing new may be starting or merging.';
    if (!dRed && !(dAge !== null && dAge <= DISPATCHER_LATE_MIN && dAge >= -10)) dLine += ' (a pass is running, inside its time limit)';
  }
  await set('dispatcher', dRed, dLine, dBody, `red:dispatcher:${since === null ? 'never' : new Date(since).toISOString()}`);

  const r = await probe(probes.rulesReadable);
  await set('rules', !(r.ok && r.v === true), `M10 Rules usable: ${r.ok && r.v === true ? 'yes' : 'no'}`,
    'The M10 Rules file could not be read or parsed. Everything that checks a rule refuses until it is fixed.');

  const unknown = [];
  const notKnownLine = (name, line) => { unknown.push(name); lines.push(`?     ${line}: unknown (no current reading)`); };
  if (typeof probes.sensorsAlive === 'function') {
    const s = await probe(probes.sensorsAlive);
    const v = s.ok ? s.v : undefined;
    const limit = v?.limitMin;
    const noneId = SENSORS_NONE_FACT(product);
    const line = 'Sensors job last wrote a reading';
    const over = (age, stale) => (stale && age <= limit ? `over ${limit}` : `${age}`);
    const put = (doc) => { const w = writer.put(noneId, doc); if (!wasSaved(w)) notSaved(`the Record refused to save when the Sensors readings stopped: ${String(w?.reason ?? 'no reason given').slice(0, 200)}`); };
    if (notKnown(s)) notKnownLine('sensors', line);
    else if (!s.ok || !Number.isFinite(limit)) {
      await set('sensors', true, `${line}: could not be read`, `Whether the Sensors job is still writing could not be read. The Dispatcher may be holding new starts. ${CHECK_SENSORS}`, 'red:sensors:unreadable');
    } else if (v.none === true) {
      // No reading at all: not known at first, red once that has lasted past the limit (the Dispatcher's "never" rule).
      // A Record that throws on the start's own get or put can't count the time, so it is the Record's red at once, never a
      // failed pass (#464 r2 m-B).
      let since = NaN;
      let threw = false;
      try {
        const was = writer.get(noneId);
        since = was?.kind === NONE_SINCE ? Date.parse(was.ts) : NaN;
        if (!Number.isFinite(since) || since > t.getTime() + READING_FUTURE_MS) { since = t.getTime(); put({ kind: NONE_SINCE, ts: t.toISOString() }); }
      } catch { threw = true; }
      const forMin = threw ? 0 : Math.max(0, Math.floor((t - since) / 60_000));
      const record = threw || v.why === 'record';
      if (threw) {
        // Red at once, even inside the grace after a start: a Record that throws is broken now, not "not yet" (review m2).
        await set('sensors', true, `${line}: the Record could not be read`,
          `The Sensors job's readings, or when they stopped, could not be read from the Record, so how long they have been missing can't be told. The Dispatcher holds new starts while it can't read them. ${CHECK_SENSORS}`,
          'red:sensors:none');
      } else if (t - since > limit * 60_000) {
        await set('sensors', true, `${line}: ${record ? 'the Record\'s readings could not be read' : 'never'} (for over ${limit} min)`,
          record ? `The Sensors job's readings in the Record could not be read for ${forMin} minutes (red after ${limit}). The Dispatcher holds new starts while it can't read them. ${CHECK_SENSORS}`
            : `The Sensors job has never written a reading (none for ${forMin} minutes; red after ${limit}). It may never have started, or its readings were deleted. The Dispatcher holds new starts without them. ${CHECK_SENSORS}`,
          'red:sensors:none');
      } else { unknown.push('sensors'); lines.push(`?     ${line}: none yet (for ${forMin} min; red after ${limit} min)`); }
    } else {
      try { if (writer.get(noneId)?.kind === NONE_SINCE) put({ kind: NONE_SEEN, ts: t.toISOString() }); } catch (e) {
        notSaved(`the Record could not be read or written when the Sensors readings came back: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      const acc = v.account;
      const read = v.clock === true ? Number.isFinite(v.aheadMin)
        : Number.isFinite(v.ageMin) && typeof v.stale === 'boolean' && typeof v.newestAt === 'string' && typeof acc?.stale === 'boolean';
      if (!read) await set('sensors', true, `${line}: could not be read`, `Whether the Sensors job is still writing could not be read. The Dispatcher may be holding new starts. ${CHECK_SENSORS}`, 'red:sensors:unreadable');
      else if (v.clock === true) {
        await set('sensors', true, `${line}: stamped ${v.aheadMin} min in the future`, `A Sensors reading is stamped ${v.aheadMin} minutes ahead of this clock, so how old the readings are can't be told. Check the Mini's clock.`, 'red:sensors:clock');
      } else if (v.stale) {
        await set('sensors', true, `${line}: ${over(v.ageMin, true)} min ago (red after ${limit} min)`,
          `The Sensors job has written no reading for ${over(v.ageMin, true)} minutes (red after ${limit}). It may have stopped, or its writes are being refused. The signed-in account, usage and Front Door readings are going stale, so the Dispatcher holds new starts. ${CHECK_SENSORS}`,
          `red:sensors:${v.newestAt}`);
      } else if (acc.stale) {
        // A damaged account row is the Record's problem, not "never written" (#464 r2 m-A); one status for both, so a row
        // that flips between the two is one notice (as red:sensors:none, r2 m4).
        const ago = acc.why === 'record' ? 'could not be read from the Record' : acc.ageMin === null ? 'never' : `${over(acc.ageMin, true)} min ago`;
        await set('sensors', true, `${line}: ${v.ageMin} min ago, but the account reading ${ago}${acc.why === 'record' ? '' : ` (red after ${limit} min)`}`,
          acc.why === 'record'
            ? `The Sensors job's account reading in the Record could not be read, though its other readings are current. The Dispatcher holds new starts without it. ${CHECK_SENSORS}`
            : `The account reading is not being written: the Sensors job last wrote who is signed in ${acc.ageMin === null ? 'never' : `${over(acc.ageMin, true)} minutes ago`} (red after ${limit}), though its other readings are current. The Dispatcher holds new starts on that reading. ${CHECK_SENSORS}`,
          `red:sensors:account:${acc.at ?? 'never'}`);
      } else await set('sensors', false, `${line}: ${v.ageMin} min ago (red after ${limit} min)`, '');
    }
  }

  const f = await probe(probes.frontDoorReachable);
  if (notKnown(f)) notKnownLine('front door', 'Front Door reachable from the phone');
  else await set('front-door', !(f.ok && f.v === true), `Front Door reachable from the phone: ${f.ok && f.v === true ? 'yes' : 'no'}`,
    'The Front Door session does not answer through the phone link. Use the GitHub fallbacks (ideas as issues, Approve on the PR) until it is back.');

  const a = await probe(probes.account);
  const acct = a.ok ? a.v : null;
  const signedIn = Boolean(acct?.signedIn && acct.login);
  const outId = `signed-out-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  if (notKnown(a)) {
    notKnownLine('account', 'signed-in account');
  } else if (!signedIn) {
    if (!writer.get(outId)?.signed_out) writer.put(outId, { kind: 'fact.signed-out', product, signed_out: true, since: t.toISOString() });
  } else if (writer.get(outId)?.signed_out) {
    writer.put(outId, { kind: 'fact.signed-out', product, signed_out: false, since: null });
  }
  if (!notKnown(a)) await set('signed-out', !signedIn, `signed-in account: ${signedIn ? acct.login : 'signed out'}`,
    'The Mini is signed out of Claude. Sessions cannot start; the Dispatcher will not restart in a loop. Sign the Mini back in.');

  const lastId = `heartbeat-account-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const lastRec = writer.get(lastId);
  const last = lastRec?.login ?? null;
  // Every switch, planned or not, is counted, and its alert or push request carries its number (L152 MAT-1, L158
  // MAT-A): keyed by the logins alone, a second switch to the same account found the first one's alert ('suppressed'
  // once the owner closed it, or a silent body edit) or the first one's push request (never written again), so the
  // owner was never told. It also carries the saved record's time (L158 m3): a count lost to a rewrite without it (an
  // older build, a hand edit) would reuse a closed alert's number, but that rewrite gives a new time. Retries of one
  // switch keep both, because the record is rewritten only with the new login. A record with no time, or one that is
  // not a time, takes this pass's time instead of a fixed word (#98 r2 Minor 1, P6): a retry may then be a duplicate
  // notice, never a silent one.
  const switches = Number.isSafeInteger(lastRec?.switches) && lastRec.switches >= 0 ? lastRec.switches : 0;
  const nextSwitches = switches + 1;
  const savedTs = typeof lastRec?.ts === 'string' && Number.isFinite(Date.parse(lastRec.ts)) ? lastRec.ts : t.toISOString();
  const seq = `${nextSwitches}-${savedTs}`;
  // What the owner was last told the Mini's login is (P11, L166): the status fact's `login_told` moves only once a
  // notice went out, and keeps its value while signed out. When the saved login equals today's but `login_told` doesn't,
  // a notice went out and its save was refused, then the Mini switched back before the retry: that switch back is a
  // switch too, told against what the owner last heard. While the logins differ the saved one stays the reference, so
  // an L143/L158 retry keeps its key. A lost P11 notice leaves `login_told` where it was, so the next pass tells it
  // again (keep and resend, L170).
  const toldBefore = writer.get(STATUS_FACT(product))?.login_told ?? null;
  const prev = signedIn && last === acct.login && toldBefore ? toldBefore : last;
  let switched = false;
  // The new login is saved only once its change alert or push request went out: a raise that answered false (or a
  // refused push-request write) keeps the old login, so the next pass tells it again (L143). A throw stops the pass
  // before the save, the same way.
  let told = true;
  if (signedIn && prev && prev !== acct.login) {
    switched = true;
    if (plannedSwitch?.to === acct.login) {
      const idem = createHash('sha256').update(`switch|${seq}|${prev}|${acct.login}|${plannedSwitch.at ?? ''}`).digest('hex').slice(0, 16);
      const pid = `push-request-${idem}`;
      // A refused write of the push request is a lost notice too: the old login stays.
      if (!writer.get(pid)) told = writer.put(pid, { kind: 'fact.push-request', idempotency_key: idem, state: 'requested', product,
        text: `The Mini switched to ${acct.login}: switch the phone app to ${acct.login} too.` })?.ok === true;
    } else {
      told = wasTold(shown(await alerts.raise({ key: key(`account-changed-${seq}-${acct.login}`), title: `${product}: the Mini's Claude account changed`,
        body: `The Mini is now signed in as ${acct.login} (was ${prev}) and no switch was planned.` })));
    }
  }
  if (signedIn && told) writer.put(lastId, { kind: 'fact.heartbeat-account', product, login: acct.login, switches: switched ? nextSwitches : switches });

  const u = await probe(probes.usage);
  const usage = u.ok ? u.v : null;
  if (usage && Number.isFinite(usage.pct)) {
    const step = [...USAGE_STEPS].reverse().find((s) => usage.pct >= s);
    lines.push(`${step ? 'warn ' : 'ok   '} usage: ${Math.round(usage.pct)} % of the ${usage.window} window`);
    const ukey = key(`usage-${usage.window}`);
    if (step) shown(await alerts.raise({ key: ukey, title: `${product}: Claude usage past ${USAGE_STEPS[0]} % (${usage.window})`, body: `Usage has passed ${step} % of the ${usage.window} window${usage.resets_at ? `; it resets ${usage.resets_at}` : ''}.`, status: `step:${step}` }));
    else shown(await alerts.clear({ key: ukey, note: 'A new usage window has started.' }));
  } else {
    notKnownLine('usage', 'usage');
  }

  const trouble = alerts.cacheTrouble();
  if (trouble) notSaved(`the Record refused to save where an alert is: ${trouble}`);
  shown(await alerts.reportTrouble(product, TROUBLE_SOURCES.HEARTBEAT));
  // Asked for first: a client learns the login on its first call, and an all-green pass may not have made one yet.
  await gh.ready?.();
  if (gh.loginTrouble) { red.push(LOGIN_UNKNOWN); lines.push(`RED   alerts: ${gh.loginTrouble}`); }

  writer.put(STATUS_FACT(product), { kind: 'fact.heartbeat-status', product, at: t.toISOString(),
    front_door_reachable: notKnown(f) ? null : f.ok && f.v === true, signed_in: notKnown(a) ? null : signedIn, login: signedIn ? acct.login : null,
    login_told: signedIn && told ? acct.login : (toldBefore ?? last), red });

  const render = () => `Orchestrate heartbeat. ${red.length ? `RED: ${red.join(', ')}` : unknown.length ? `Nothing red; not known: ${unknown.join(', ')}.` : 'All green.'}\nmini_alive_at: ${t.toISOString()}\n\n${lines.join('\n')}\n`;
  const pinned = () => `${render()}${heartbeatMarker(product)}\n`;
  const issueId = ISSUE_FACT(product);
  const known = writer.get(issueId)?.issue;
  let posted = false;
  if (ISSUE(known) && (await gh.read(known))?.open) posted = (await gh.edit(known, pinned())) !== false;
  else {
    // The issue is found again by its marker, so a number the Record refused to keep never means a new issue each pass
    // (L393). A list GitHub refused opens nothing this pass: the next one looks again.
    const found = await gh.findOpen(lineIs(heartbeatMarker(product)));
    if (ISSUE(found)) posted = (await gh.edit(found, pinned())) !== false;
    // An open with no issue number is not saved, so the next pass opens it again (L152 m3).
    const issue = found === false || ISSUE(found) ? found : await gh.open({ title: 'Orchestrate heartbeat (pinned)', body: pinned(), assignee: owner, labels: ['orchestrate-heartbeat'] });
    if (ISSUE(issue)) {
      // A new issue opens with the body, so it is posted; an edit after is only the Record's number refused.
      if (!ISSUE(found)) posted = true;
      const put = writer.put(issueId, { kind: 'fact.heartbeat-issue', product, issue });
      if (!wasSaved(put)) {
        notSaved(`the Record refused to save the pinned issue's number: ${String(put?.reason ?? 'no reason given').slice(0, 200)}`);
        await gh.edit(issue, pinned());
      }
    }
  }
  return { red, body: render(), told: toldOf, posted, postedWhy: posted ? null : String(gh.lastAnswer ?? 'GitHub took no edit or open of the pinned issue').slice(0, 200) };
}
