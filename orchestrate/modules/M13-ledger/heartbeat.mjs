// heartbeat.mjs — the Mini's heartbeat: one pinned GitHub issue per product repo whose body is rewritten every 10
// minutes while the Mini is alive, plus an alert for each thing that is red (R-0b-73; design v4 §7.2 R2, R4, R5, §8 E7;
// review-0b-7 M9, M10 and minors).
//
// Body: `mini_alive_at: <time>` on its own line (the outside check reads it: older than 70 min = stale), then one line
// per fact. Editing the body notifies nobody; each red fact raises its own alert (alerts.mjs: one updated issue,
// cleared when green). A Mini that is off writes nothing, so "stale" is the outside check's to notice.
//
// Facts (probes injected; each returns the value or throws, and a throw counts as red):
//   dispatcher        last good Dispatcher pass; red when older than 15 minutes or missing.
//   rules             the M10 Rules file reads and parses.
//   front door        the Front Door answers through the phone link (Remote Control).
//   account           the signed-in Claude account, as its label from private config ("account A"), never an
//                     email address: the probe maps it. Signed out → a `signed-out` fact and one alert; nothing here
//                     restarts anything (the Dispatcher owns that loop and reads the fact). A change to the account
//                     named by a planned switch → one push request "switch the phone app to account <B> too"
//                     (idempotent: the same switch never pushes twice); an unplanned change → an alert.
//   usage             from the usage fact (R-0b-66) when there is one, else "unknown". Crossing 50/75/90/95 % of a
//                     window → one alert per window, its body naming the highest threshold (a higher one comments
//                     once; the next window clears it).
// Push requests are facts `push-request-<key>` for the Front Door to deliver (join item with lane 2).

import { createHash } from 'node:crypto';

export const DISPATCHER_LATE_MIN = 15;
export const USAGE_STEPS = Object.freeze([50, 75, 90, 95]);
const ISSUE_FACT = (product) => `heartbeat-issue-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;

async function probe(fn) { try { return { ok: true, v: await fn() }; } catch { return { ok: false, v: null }; } }

export async function heartbeatOnce({ product, writer, gh, alerts, owner, probes, plannedSwitch = null, now = () => new Date() }) {
  const t = now();
  const key = (kind) => `${product}|heartbeat|${kind}`;
  const red = []; const lines = [];
  const set = async (kind, isRed, line, body) => {
    lines.push(`${isRed ? 'RED  ' : 'ok   '} ${line}`);
    if (isRed) { red.push(kind); await alerts.raise({ key: key(kind), title: `${product}: heartbeat red: ${kind}`, body, status: `red:${kind}` }); }
    else await alerts.clear({ key: key(kind), note: `${kind} is green again.` });
  };

  const d = await probe(probes.dispatcherLastGood);
  const dParsed = d.ok && d.v ? Date.parse(d.v) : NaN;
  const dAge = Number.isFinite(dParsed) ? Math.round((t - dParsed) / 60e3) : null;
  await set('dispatcher', dAge === null || !(dAge <= DISPATCHER_LATE_MIN),
    `last good Dispatcher pass: ${dAge === null ? 'unknown' : `${dAge} min ago`}`,
    `The Dispatcher's last good pass was ${dAge === null ? 'never recorded' : `${dAge} minutes ago`} (red after ${DISPATCHER_LATE_MIN}). Nothing new is being started or merged.`);

  const r = await probe(probes.rulesReadable);
  await set('rules', !(r.ok && r.v === true), `M10 Rules readable: ${r.ok && r.v === true ? 'yes' : 'no'}`,
    'The M10 Rules file could not be read or parsed. Everything that checks a rule refuses until it is fixed.');

  const f = await probe(probes.frontDoorReachable);
  await set('front-door', !(f.ok && f.v === true), `Front Door reachable from the phone: ${f.ok && f.v === true ? 'yes' : 'no'}`,
    'The Front Door session does not answer through the phone link. Use the GitHub fallbacks (ideas as issues, Approve on the PR) until it is back.');

  const a = await probe(probes.account);
  const acct = a.ok ? a.v : null;
  const signedIn = Boolean(acct?.signedIn && acct.login);
  const outId = `signed-out-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  if (!signedIn) {
    if (!writer.get(outId)?.signed_out) writer.put(outId, { kind: 'fact.signed-out', product, signed_out: true, since: t.toISOString() });
  } else if (writer.get(outId)?.signed_out) {
    writer.put(outId, { kind: 'fact.signed-out', product, signed_out: false, since: null });
  }
  await set('signed-out', !signedIn, `signed-in account: ${signedIn ? acct.login : 'signed out'}`,
    'The Mini is signed out of Claude. Sessions cannot start; the Dispatcher will not restart in a loop. Sign the Mini back in.');

  const lastId = `heartbeat-account-${product.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const last = writer.get(lastId)?.login ?? null;
  if (signedIn && last && last !== acct.login) {
    if (plannedSwitch?.to === acct.login) {
      const idem = createHash('sha256').update(`switch|${last}|${acct.login}|${plannedSwitch.at ?? ''}`).digest('hex').slice(0, 16);
      const pid = `push-request-${idem}`;
      if (!writer.get(pid)) writer.put(pid, { kind: 'fact.push-request', idempotency_key: idem, state: 'requested', product,
        text: `The Mini switched to ${acct.login}: switch the phone app to ${acct.login} too.` });
    } else {
      await alerts.raise({ key: key(`account-changed-${acct.login}`), title: `${product}: the Mini's Claude account changed`,
        body: `The Mini is now signed in as ${acct.login} (was ${last}) and no switch was planned.` });
    }
  }
  if (signedIn) writer.put(lastId, { kind: 'fact.heartbeat-account', product, login: acct.login });

  const u = await probe(probes.usage);
  const usage = u.ok ? u.v : null;
  if (usage && Number.isFinite(usage.pct)) {
    const step = [...USAGE_STEPS].reverse().find((s) => usage.pct >= s);
    lines.push(`${step ? 'warn ' : 'ok   '} usage: ${Math.round(usage.pct)} % of the ${usage.window} window`);
    const ukey = key(`usage-${usage.window}`);
    if (step) await alerts.raise({ key: ukey, title: `${product}: Claude usage past ${USAGE_STEPS[0]} % (${usage.window})`, body: `Usage has passed ${step} % of the ${usage.window} window${usage.resets_at ? `; it resets ${usage.resets_at}` : ''}.`, status: `step:${step}` });
    else await alerts.clear({ key: ukey, note: 'A new usage window has started.' });
  } else {
    lines.push('ok    usage: unknown');
  }

  const body = `Orchestrate heartbeat. ${red.length ? `RED: ${red.join(', ')}` : 'All green.'}\nmini_alive_at: ${t.toISOString()}\n\n${lines.join('\n')}\n`;
  const issueId = ISSUE_FACT(product);
  const known = writer.get(issueId)?.issue;
  if (known && !(await gh.isClosed(known))) await gh.edit(known, body);
  else writer.put(issueId, { kind: 'fact.heartbeat-issue', product, issue: await gh.open({ title: 'Orchestrate heartbeat (pinned)', body, assignee: owner, labels: ['orchestrate-heartbeat'] }) });
  return { red, body };
}
