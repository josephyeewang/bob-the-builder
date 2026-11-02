// gate.mjs — one pass of the Merge Gate (R-0b-87 to R-0b-90, R-0b-93, R-0b-94, R-0b-96; 0b-9 review rounds 1–3).
//
// WHAT A PASS DOES, in order; each step that can't finish leaves the record as it was, for the next pass.
//   1. Start check. Robot merges are open only while the outside check was green in the last 2 hours and the Mini's
//      tokens are shown unable to write there (M12 robotMergesGreen). Otherwise nothing happens: "outside check not
//      green in 2 h".
//   2. Intake. The newest Dispatcher merge request for a card that has no open merge becomes a merge document
//      (requested → queued). A request the gate already took is never taken twice.
//   3. Audit results. A merged merge with a Sensors audit_run fact for its commit moves to audited_ok / audit_flagged.
//   4. One merge at a time. A merge left in checking or merging by a stopped pass is finished first (recover).
//   5. Held merges go back in the queue to be judged again; they keep their place (queue_since).
//   6. The next queued merge (queueOrder): behind main → catch up (PUT update-branch; a conflict returns it to the
//      builder); otherwise judge (refusals.mjs over gather.mjs). refuse → refused, with every reason; hold → held;
//      merge → the paired write (merge → checking, card → merging), judged again under the lock, then merging, the
//      merge on GitHub (PUT /pulls/n/merge with the judged head, squash: never a ref write), merged, the card merged,
//      the robot's mark on the merge commit, and a check that the merge commit's first parent is the judged main.
//
//   await gatePass(ctx) → { ran, reason?, problems?, did: [{ merge, step, ... }] }
// ctx = gather.mjs's ctx, plus readFact? (id → doc; default the record's fact) and maxCatchUps? (default 3).
// The gate writes only as merge_gate. It never moves a card it didn't put in merging, except merged.

import { robotMergesGreen } from '../M12-sensors/outside-watch.mjs';
import { gatherFacts, botId } from './gather.mjs';
import { judge } from './refusals.mjs';
import { MARK_CONTEXT, markDescription, markable, NEEDS_JOE_CONTEXT, needsJoeDescription } from './mark.mjs';
import { isOpen } from '../../shared/record.mjs';
import { markReverted } from './undo.mjs';

export const ACTOR = 'merge_gate';
export const NOT_GREEN_LINE = 'outside check not green in 2 h';
export const FRESHNESS_FACT = 'blueprint_freshness_alarm';
const STEPPED_ASIDE = 'stepped_aside';
export const MAX_CATCH_UPS = 3;
const SHA = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 7);

// The order the queue is served in: undo first, the lead's daily card when the blueprint's freshness alarm is on,
// then Tier 1, then Tier 2; ties go to whoever has waited longest (queue_since, kept through holds and catch-ups).
export function queueOrder(merges, { cardOf, freshnessAlarm = false } = {}) {
  const rank = (m) => {
    const c = cardOf(m.doc.card);
    if (c?.kind === 'exact_reverse') return 0;
    if (c?.kind === 'lead_daily_card' && freshnessAlarm) return 1;
    return (m.doc.tier ?? c?.tier) === 1 ? 2 : 3;
  };
  return [...merges].sort((a, b) => rank(a) - rank(b) || String(a.doc.queue_since).localeCompare(String(b.doc.queue_since)) || (a.id < b.id ? -1 : 1));
}

export async function gatePass(ctx) {
  const { record, product, gh, owner, repo, now } = ctx;
  const alert = ctx.alert ?? (() => {});
  const iso = () => new Date(now()).toISOString();
  const did = [];
  const base = `/repos/${owner}/${repo}`;
  const readFact = ctx.readFact ?? ((id) => record.read('fact', id)?.doc ?? null);

  const start = robotMergesGreen({ read: readFact, product, now });
  if (!start.open) return { ran: false, reason: NOT_GREEN_LINE, problems: start.problems, did };

  const write = (entity, cur, fields, extra = {}) => record.write({ actor: ACTOR, entity, id: cur.id, expectRev: cur.rev ?? 0, doc: { ...(cur.doc ?? {}), ...fields }, ...extra });
  const fresh = (entity, id) => record.read(entity, id);
  const step = (m, name, more = {}) => { did.push({ merge: m.id, step: name, ...more }); };
  const move = (m, state, fields = {}) => {
    const r = write('merge', fresh('merge', m.id), { state, ...fields });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: state, reason: r.reason });
    else step(m, state, fields.reasons ? { reasons: fields.reasons } : {});
    return r.ok;
  };

  // 2. Intake.
  const merges = () => record.list('merge').filter((m) => m.doc && !m.corrupt);
  const taken = new Set(merges().map((m) => m.doc.request));
  const byCard = new Map();
  for (const q of record.list('merge_request')) {
    if (!q.doc || q.corrupt || taken.has(q.id)) continue;
    const prev = byCard.get(q.doc.card);
    if (!prev || String(q.doc.requested_at) > String(prev.doc.requested_at)) byCard.set(q.doc.card, q);
  }
  for (const [cardId, q] of [...byCard].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (merges().some((m) => m.doc.card === cardId && isOpen('merge', m.doc.state))) continue;
    const id = `merge-${q.id}`;
    if (fresh('merge', id)) continue;
    const r = record.write({ actor: ACTOR, entity: 'merge', id, expectRev: 0, doc: { state: 'requested', card: cardId, pr: q.doc.pr, request: q.id, requested_at: q.doc.requested_at, catch_ups: [] } });
    if (!r.ok) { alert({ type: 'merge_gate_write_refused', merge: id, to: 'requested', reason: r.reason }); continue; }
    step({ id }, 'requested');
    // A change sent back keeps its place (r3-m5): the earliest of the request's queue_since and this card's earlier merges.
    const since = [q.doc.queue_since, q.doc.requested_at, ...merges().filter((m) => m.doc.card === cardId).map((m) => m.doc.queue_since)]
      .filter((x) => typeof x === 'string' && Number.isFinite(Date.parse(x))).sort()[0] ?? iso();
    move({ id }, 'queued', { queue_since: since });
  }

  // 3a. A merge whose card write or statuses a stopped pass left behind: finished now (R-0b-94), before the audit
  // result moves it on, and also after (a late mark means the audit needs running again; the alert says so).
  for (const m of merges().filter((x) => ['merged', 'audited_ok', 'audit_flagged'].includes(x.doc.state) && SHA.test(x.doc.merge_commit ?? ''))) {
    const card = fresh('card', m.doc.card);
    if (card?.doc?.state === 'merging' || !m.doc.marked_at || revertUnsettled(m, card)) await complete(m, m.doc.merge_commit);
  }

  // 3. Audit results (R-0b-93): only a Sensors audit_run fact for the merge commit moves a merged merge.
  for (const m of merges().filter((x) => x.doc.state === 'merged' && SHA.test(x.doc.merge_commit ?? ''))) {
    const f = record.list('fact').find((x) => x.doc?.type === 'audit_run' && x.doc.commit === m.doc.merge_commit && ['success', 'failure'].includes(x.doc.conclusion));
    if (!f) continue;
    const to = f.doc.conclusion === 'success' ? 'audited_ok' : 'audit_flagged';
    const r = record.write({ actor: ACTOR, entity: 'merge', id: m.id, expectRev: m.rev, doc: { ...m.doc, state: to, audited_at: iso() }, data: { fact: f.id } });
    if (r.ok) step(m, to); else alert({ type: 'merge_gate_write_refused', merge: m.id, to, reason: r.reason });
  }

  // 4. One at a time: finish a merge a stopped pass left behind.
  const busy = merges().find((m) => m.doc.state === 'checking' || m.doc.state === 'merging');
  if (busy) { await recover(busy); return { ran: true, did }; }

  // 5. Held merges are judged again, in their place.
  for (const m of merges().filter((x) => x.doc.state === 'held')) move(m, 'queued', { hold: null });

  // 6. The next queued merge.
  const cardOf = (id) => fresh('card', id)?.doc ?? null;
  const queue = queueOrder(merges().filter((m) => m.doc.state === 'queued' || m.doc.state === 'catching_up'), { cardOf, freshnessAlarm: readFact(FRESHNESS_FACT)?.on === true });
  for (const m of queue) {
    const out = await serve(m);
    if (out !== STEPPED_ASIDE) break;
  }
  return { ran: true, did };

  // Returns STEPPED_ASIDE when this merge left the front without taking the lock or starting a catch-up, so the next
  // in the queue is served in the same pass (R-0b-90: a Tier-1 change held for the hours steps aside).
  async function serve(m) {
    if (!markable(m.doc.card)) {
      const reasons = ['the card id is too long for the robot\'s mark (80 characters at most)'];
      move(m, 'refused', { reasons });
      alert({ type: 'merge_refused', merge: m.id, card: m.doc.card, reasons });
      return STEPPED_ASIDE;
    }
    if (m.doc.state === 'catching_up') {
      await finishCatchUp(m);
      // Caught up: served now, before younger changes can put it behind main again.
      const now = fresh('merge', m.id);
      return now?.doc?.state === 'queued' ? serve(now) : STEPPED_ASIDE;
    }
    const facts = await gatherFacts(ctx, m);
    // GitHub unreadable: refuse this one and stop, rather than refuse the whole queue in one pass.
    const outage = !!facts.card && (!facts.pr || !SHA.test(facts.main?.sha ?? '') || facts.checks === null || facts.statuses === null || facts.compareStatus === null);
    // Behind main: catch up first (R-0b-89), never judge a head that can't land as judged.
    if ((facts.compareStatus === 'behind' || facts.compareStatus === 'diverged') && facts.pr?.state === 'open' && SHA.test(facts.pr?.head?.sha ?? '')) {
      if ((m.doc.catch_ups ?? []).length >= (ctx.maxCatchUps ?? MAX_CATCH_UPS)) { move(m, 'returned_to_builder', { reasons: [`caught up ${MAX_CATCH_UPS} times and still behind main`] }); return STEPPED_ASIDE; }
      return catchUp(m, facts.pr.head.sha);
    }
    const v = judge(facts);
    if (v.decision === 'refuse') { refuse(m, facts, v); return outage ? undefined : STEPPED_ASIDE; }
    if (v.decision === 'hold') { move(m, 'held', { hold: v.hold }); return STEPPED_ASIDE; }
    return take(m, facts);
  }

  async function catchUp(m, head) {
    if (!move(m, 'catching_up', { catch_up_from: head })) return;
    let r;
    try { r = await gh.put(`${base}/pulls/${m.doc.pr}/update-branch`, { expected_head_sha: head }); } catch (e) { r = { status: 0 }; }
    if (r?.status === 202) return step(m, 'catch_up_asked');
    // 422: a conflict, or the head moved under us. Either way the builder takes it back.
    move(fresh('merge', m.id), 'returned_to_builder', { reasons: [`catching up with main failed (${r?.status})`] });
    return STEPPED_ASIDE;
  }

  async function finishCatchUp(m) {
    let pr;
    try { pr = (await gh.get(`${base}/pulls/${m.doc.pr}`)).json; } catch { pr = null; }
    const after = pr?.head?.sha;
    if (!SHA.test(after ?? '') || after === m.doc.catch_up_from) return;   // GitHub hasn't made the commit yet
    const catchUps = [...(m.doc.catch_ups ?? []), { pr: m.doc.pr, before_sha: m.doc.catch_up_from, after_sha: after }];
    move(m, 'queued', { catch_ups: catchUps, catch_up_from: null });
  }

  function refuse(m, facts, v) {
    const reasons = v.refusals.map((x) => `${x.n}: ${x.reason}`);
    // The owner's Approve is missing: say so on the card, so M2 asks for it (refusal 8).
    const card = fresh('card', m.doc.card);
    if (v.refusals.some((x) => x.n === 8) && facts.approve?.needed && card && card.doc.needs_joe !== true) write('card', card, { needs_joe: true });
    move(m, 'refused', { reasons });
    alert({ type: 'merge_refused', merge: m.id, card: m.doc.card, reasons });
  }

  async function take(m, facts) {
    const head = facts.pr.head.sha;
    const card = fresh('card', m.doc.card);
    const mm = fresh('merge', m.id);
    const pair = record.write({ actor: ACTOR, entity: 'merge', id: mm.id, expectRev: mm.rev, doc: { ...mm.doc, state: 'checking', judged_head: head, judged_main: facts.main.sha, tier: facts.tier, needs_joe: facts.approve?.needed !== false || card.doc.needs_joe === true },
      also: [{ entity: 'card', id: card.id, expectRev: card.rev, doc: { ...card.doc, state: 'merging' } }] });
    if (!pair.ok) { alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'checking', reason: pair.reason }); return; }
    step(m, 'checking');
    return check(fresh('merge', m.id));
  }

  // Under the lock, everything is read and judged again: the merge happens only on what was judged a moment ago.
  async function check(m) {
    const facts = await gatherFacts(ctx, m);
    const v = judge(facts);
    const head = facts.pr?.head?.sha;
    if (v.decision !== 'merge' || head !== m.doc.judged_head) {
      const reasons = v.decision === 'merge' ? ['the head moved while the merge was being checked'] : v.refusals.map((x) => `${x.n}: ${x.reason}`);
      if (v.decision === 'hold') move(m, 'held', { hold: v.hold }); else move(m, 'refused', { reasons });
      return putBack(m, 'verified');
    }
    if (!move(m, 'merging', { judged_main: facts.main.sha })) return;
    return land(fresh('merge', m.id));
  }

  async function land(m) {
    let r;
    try { r = await gh.put(`${base}/pulls/${m.doc.pr}/merge`, { sha: m.doc.judged_head, merge_method: 'squash' }); } catch (e) { r = { status: 0, json: { message: String(e?.message ?? e).slice(0, 200) } }; }
    const sha = r?.json?.sha;
    if (r?.status !== 200 || r.json?.merged !== true || !SHA.test(sha ?? '')) {
      // Not merged: GitHub refused or didn't answer. Read it once more before calling it refused (a lost answer).
      return recover(m);
    }
    return finish(m, sha);
  }

  async function finish(m, sha) {
    if (!move(m, 'merged', { merge_commit: sha, merged_at: iso() })) return;
    await complete(fresh('merge', m.id), sha);
    // The merge must sit right on the main that was judged; if main moved in between, say so (the merge stands).
    try {
      const k = await ctx.view.commit(sha);
      if (k?.parents?.[0] !== m.doc.judged_main) alert({ type: 'merge_parent_moved', merge: m.id, commit: sha, judged_main: m.doc.judged_main, parent: k?.parents?.[0] ?? null, ask_owner: 'Undo?' });
    } catch { alert({ type: 'merge_parent_moved', merge: m.id, commit: sha, judged_main: m.doc.judged_main, parent: null }); }
  }

  // An undo card that merged marks the card it undid reverted. That is tried again on later passes until it holds or the
  // owner was told why it can't (the "undo_not_marked" alert delivered); revert_settled_at on the merge records either.
  // Without it, a lost alert after the card went merged would never be asked again (L135 site G).
  function revertUnsettled(m, card) { return card?.doc?.kind === 'exact_reverse' && card.doc.state === 'merged' && !m.doc.revert_settled_at; }
  function settleRevert(m, cardId) {
    const u = markReverted({ record, alert }, cardId);
    if (u.ok) step(m, 'reverted', { card: u.card });
    if (u.ok || u.told) {
      const r = write('merge', fresh('merge', m.id), { revert_settled_at: iso() });
      if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'revert_settled', reason: r.reason });
    }
  }

  // After a merge is recorded: the card goes merged (and an undo marks what it undid), and the two statuses go on the
  // merge commit: the robot's mark (R-0b-94) and the needs-joe answer the GitHub-side checker reads. Each part is redone
  // on later passes until it holds (posting a status twice is harmless); marked_at records that both were posted.
  async function complete(m, sha) {
    const card = fresh('card', m.doc.card);
    if (card?.doc?.state === 'merging') {
      const c = write('card', card, { state: 'merged', merge_commit: sha });
      if (!c.ok) alert({ type: 'merge_gate_write_refused', card: card.id, to: 'merged', reason: c.reason });
      else if (card.doc.kind === 'exact_reverse') settleRevert(m, card.id);
    } else if (revertUnsettled(m, card)) settleRevert(m, card.id);
    if (m.doc.marked_at) return;
    let posts;
    try {
      posts = [
        { context: MARK_CONTEXT, description: markDescription({ card: m.doc.card, head: m.doc.judged_head }) },
        { context: NEEDS_JOE_CONTEXT, description: needsJoeDescription({ needsJoe: m.doc.needs_joe !== false, tier: m.doc.tier === 2 ? 2 : 1 }) },
      ];
    } catch (e) { alert({ type: 'merge_mark_failed', merge: m.id, commit: sha, reason: e.message }); return; }
    for (const p of posts) {
      let s;
      try { s = await gh.post(`${base}/statuses/${sha}`, { state: 'success', ...p }); } catch { s = { status: 0 }; }
      if (s?.status !== 201) { alert({ type: 'merge_mark_failed', merge: m.id, commit: sha, context: p.context, status: s?.status }); return; }
    }
    const r = write('merge', fresh('merge', m.id), { marked_at: iso() });
    if (r.ok) {
      step(m, 'marked');
      // An audit that already ran on this commit read it with no mark: it needs running again.
      if (m.doc.state !== 'merged' || record.list('fact').some((x) => x.doc?.type === 'audit_run' && x.doc.commit === sha)) alert({ type: 'merge_marked_after_audit', merge: m.id, commit: sha, ask_owner: 'Re-run the audit on this commit?' });
    } else alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'marked', reason: r.reason });
  }

  // A merge in checking or merging, found at the start of a pass (or a merge GitHub didn't confirm): GitHub says
  // whether it merged. Merged at the judged head → finish. Not merged → refused, and the card goes back to verified.
  async function recover(m) {
    let pr = null;
    try { const r = await gh.get(`${base}/pulls/${m.doc.pr}`); if (r?.status === 200) pr = r.json; } catch { pr = null; }
    if (!pr) { alert({ type: 'merge_gate_unsure', merge: m.id, note: 'GitHub could not say whether the pull request merged; trying again next pass' }); return; }
    if (pr.merged === true && SHA.test(pr.merge_commit_sha ?? '') && pr.head?.sha === m.doc.judged_head) {
      if (m.doc.state === 'checking' && !move(m, 'merging')) return;
      return finish(fresh('merge', m.id), pr.merge_commit_sha);
    }
    if (pr.merged === true) {
      alert({ type: 'merge_gate_unsure', merge: m.id, note: `pull request #${pr.number} merged at ${short(pr.head?.sha)}, not the judged ${short(m.doc.judged_head)}` });
      move(m, 'refused', { reasons: ['merged outside the gate, at a head the gate did not judge'] });
      putBack(m, 'verified');
      return;
    }
    move(m, 'refused', { reasons: ['GitHub did not merge the judged head'] });
    putBack(m, 'verified');
  }

  function putBack(m, to) {
    const card = fresh('card', m.doc.card);
    if (card?.doc?.state !== 'merging') return;
    const r = write('card', card, { state: to });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', card: card.id, to, reason: r.reason });
  }
}

export { botId };
