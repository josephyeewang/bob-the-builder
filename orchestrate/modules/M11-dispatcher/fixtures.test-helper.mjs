// Test-only: the design's numbers (v4 §14.1.6 and the review's new keys), passed to fakeRules so no
// Dispatcher file holds them. A test that wants a different number overrides one key.

import { fakeRules } from '../../shared/rules.mjs';
import { SCRIPT_ACTORS, STATES, memoryRecord } from '../../shared/record.mjs';
import { CREATE_STATES, INTERNAL_MOVES, MOVES, moveActors } from '../M9-record/moves.mjs';
import { fieldsAllowed } from '../M9-record/permissions.mjs';
import { KEYS as K } from './keys.mjs';
import { outbox, sendAlerts } from './alerts.mjs';

export const VALUES = Object.freeze({
  [K.redPace]: 1.0, [K.redWeek]: 85, [K.redH5]: 80,
  [K.amberPace]: 0.85, [K.amberWeek]: 70, [K.amberH5]: 70, [K.ownBuildingShare]: 70,
  [K.amberEditingPerProduct]: 2, [K.amberEditingPerMac]: 3,
  [K.reservePct]: 55, [K.noTier1ProdAbove]: 90, [K.staleAfterMin]: 15, [K.redRuns]: ['reviews', 'audits', 'merges'],
  [K.editingPerProduct]: 3, [K.editingPerMac]: 5, [K.perState]: { light: 1, active: 3, away: 3, paused: 0 },
  [K.shakedown]: false, [K.shakedownWorkers]: 1, [K.scriptsPerProduct]: 1, [K.scriptsPerMac]: 2, [K.readonlyPerSession]: 4,
  [K.leadDailyCard]: ['docs/blueprint/blueprint.yaml', 'docs/blueprint/cards/**', 'docs/blueprint/BLUEPRINT.md'],
  [K.cancelGraceMin]: 2, [K.parkWaitMin]: 15, [K.deadQuietMin]: 5, [K.claimedNoSessionMin]: 10, [K.checkingMaxMin]: 30,
  [K.reportingMaxMin]: 10, [K.inReviewNoReviewerMin]: 15, [K.frontDoorStuckMin]: 10, [K.usageUnknownMaxMin]: 1440,
  [K.outageMinDead]: 3, [K.outageShare]: 0.5,
  [K.leadSoft]: 250_000, [K.leadHard]: 400_000, [K.handoffCapRole]: 8_000, [K.splitAfterCompactions]: 2,
});

export const rulesWith = (over = {}, answers = {}) => {
  const values = { ...VALUES, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete values[k];
  return fakeRules({ values, answers });
};

export const T0 = Date.parse('2026-10-29T12:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();
export const MIN = 60_000;
export const H = 60 * MIN;
export const D = 24 * H;

/** A usage fact. `gone` = share of the week gone at T0. */
export function usageFact({ week, h5, gone = 0.5, account = 'acct-a', observedAgoMin = 1, h5ResetsInMin = 60, now = T0 }) {
  return {
    account, observed_at: iso(now - observedAgoMin * MIN), source: 'status-line',
    week: { used_pct: week, resets_at: iso(now + (1 - gone) * 7 * D) },
    h5: { used_pct: h5, resets_at: iso(now + h5ResetsInMin * MIN) },
  };
}

// A record holding `entries` ([entity, id, doc]), each reached the way the real Record allows (L72): made in a state
// its maker may make it in, by a script M9 lets make it, then moved one legal step at a time, each step by a script
// M9 lets make it. A field only some other script may set is set by that script; one no script may set is refused, so
// a test can't start from a document the real Record would never hold. The claim goes in on the move into claimed,
// the wait on the move into waiting, the failure on the move into failed.
const MOVE_FIELDS = Object.freeze({ claimed: 'claim', waiting: 'wait', failed: 'failure' });
// `joe` writes nothing (the owner acts through approvals), so he never seeds a step.
const SCRIPTS = SCRIPT_ACTORS.filter((a) => a !== 'joe');
const scripts = (actors) => (actors ?? []).filter((a) => SCRIPTS.includes(a));
function pathTo(entity, target) {
  const starts = Object.entries(CREATE_STATES[entity] ?? {}).filter(([, a]) => scripts(a).length).map(([s]) => s);
  const seen = new Map(starts.map((s) => [s, [s]]));
  const queue = [...starts];
  while (queue.length) {
    const s = queue.shift();
    if (s === target) return seen.get(s);
    for (const to of Object.keys(MOVES[entity]?.[s] ?? {})) {
      if (seen.has(to) || INTERNAL_MOVES[entity]?.[s]?.includes(to) || !scripts(moveActors(entity, s, to)).length) continue;
      seen.set(to, [...seen.get(s), to]);
      queue.push(to);
    }
  }
  return null;
}
function seedOne(rec, entity, id, doc) {
  const must = (r, what) => { if (!r.ok) throw new Error(`recWith ${entity} ${id}: ${what}: ${r.reason}`); return r; };
  const stateful = Object.hasOwn(STATES, entity);
  const path = stateful ? pathTo(entity, doc.state) : [undefined];
  if (!path) throw new Error(`recWith ${entity} ${id}: no script reaches ${doc.state}`);
  const atMove = new Set(Object.values(MOVE_FIELDS));
  const fields = Object.keys(doc).filter((f) => f !== 'state' && !(entity === 'card' && atMove.has(f)));
  const mayCreate = (a) => { const s = fieldsAllowed(entity, a, { create: true }); return s && (!stateful || CREATE_STATES[entity][path[0]]?.includes(a)) ? s : null; };
  const makers = SCRIPTS.filter((a) => mayCreate(a));
  if (!makers.length) throw new Error(`recWith ${entity} ${id}: no script may make a ${entity}`);
  const maker = makers.find((a) => { const s = mayCreate(a); return s === '*' || fields.every((f) => s.has(f)); }) ?? makers[0];
  const allowed = mayCreate(maker);
  const first = Object.fromEntries(fields.filter((f) => allowed === '*' || allowed.has(f)).map((f) => [f, doc[f]]));
  must(rec.write({ actor: maker, entity, id, expectRev: 0, doc: stateful ? { ...first, state: path[0] } : first }), `made by ${maker}`);
  // The rest, each by a script that may set it.
  for (const f of fields.filter((x) => !(x in first))) {
    const cur = rec.read(entity, id);
    const by = SCRIPTS.find((a) => { const s = fieldsAllowed(entity, a, { state: cur.doc.state }); return s === '*' || s?.has(f); });
    if (!by) throw new Error(`recWith ${entity} ${id}: no script may set ${f} on a ${entity}`);
    must(rec.write({ actor: by, entity, id, expectRev: cur.rev, doc: { ...cur.doc, [f]: doc[f] } }), `${f} set by ${by}`);
  }
  for (const to of path.slice(1)) {
    const cur = rec.read(entity, id);
    const by = scripts(moveActors(entity, cur.doc.state, to))[0];
    const extra = entity === 'card' && MOVE_FIELDS[to] && doc[MOVE_FIELDS[to]] !== undefined ? { [MOVE_FIELDS[to]]: doc[MOVE_FIELDS[to]] } : {};
    must(rec.write({ actor: by, entity, id, expectRev: cur.rev, doc: { ...cur.doc, ...extra, state: to } }), `${cur.doc.state} → ${to} by ${by}`);
  }
}
export function recWith(entries = []) {
  const rec = memoryRecord();
  for (const [entity, id, doc] of entries) {
    // The record requires a card's module; a fixture card that names none gets a test module.
    const d = entity === 'card' && doc && !('module' in doc) ? { module: 'M-test', ...doc } : doc;
    seedOne(rec, entity, id, d);
  }
  return rec;
}

// An undo card as the undo step writes it (LEAD-CALLS L40): it reverses a merge in the record, with the
// reversed commit's file list. `filesOfCommits` answers for every commit these fixtures made.
const commitFiles = new Map();
export const undoSha = (id) => Buffer.from(String(id)).toString('hex').padEnd(40, '0').slice(0, 40);
export function undoEntries(id, over = {}, { product = 'p1', files = [`src/${id}.js`], pr = 7 } = {}) {
  const sha = undoSha(id);
  commitFiles.set(sha, files);
  return [['merge', `MG-${id}`, { state: 'merged', pr, merge_commit_sha: sha, product }],
    ['card', id, { state: 'ready', kind: 'undo', queue: 'front', go_free: true, module: 'M-test', product, tier: 2, files, pr, merge_commit_sha: sha, reverses: `MG-${id}`, changed_at: iso(T0 - 600_000), ...over }]];
}
export const filesOfCommits = (sha) => { if (!commitFiles.has(sha)) throw new Error(`no such commit ${sha}`); return commitFiles.get(sha); };

/**
 * Test-only: run one step as the tick runs it (alerts.mjs, L47): its alerts are queued, then the one sender
 * hands them to `port` once the step is done. A told mark is written only when `port` took the alert.
 */
export async function withAlerts(rec, now, port, f) {
  const r = await f(outbox(rec, now));
  await sendAlerts(rec, port, now, { sendMs: 200, budgetMs: 10_000 });
  return r;
}
