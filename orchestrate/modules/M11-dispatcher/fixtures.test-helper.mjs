// Test-only: the design's numbers (v4 §14.1.6 and the review's new keys), passed to fakeRules so no
// Dispatcher file holds them. A test that wants a different number overrides one key.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRules, makeRules } from '../../shared/rules.mjs';
import { CHANNEL_TIER } from '../../shared/approval.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { SCRIPT_ACTORS, STATES, memoryRecord } from '../../shared/record.mjs';
import { CREATE_STATES, INTERNAL_MOVES, MOVES, moveActors } from '../M9-record/moves.mjs';
import { factFamilyOf, fieldsAllowed } from '../M9-record/permissions.mjs';
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
  [K.cancelGraceMin]: 2, [K.parkWaitMin]: 15, [K.deadQuietMin]: 5, [K.claimsStuckMin]: 5, [K.checkingMaxMin]: 30, [K.mergingOpenMaxMin]: 15,
  [K.reportingMaxMin]: 10, [K.inReviewNoReviewerMin]: 15, [K.frontDoorStuckMin]: 10, [K.usageUnknownMaxMin]: 1440,
  [K.outageMinDead]: 3, [K.outageShare]: 0.5,
  [K.leadSoft]: 250_000, [K.leadHard]: 400_000, [K.handoffCapRole]: 8_000, [K.splitAfterCompactions]: 2,
});

// M10's real engine on its sample policy (L81). count_approval goes through it unless a test answers it itself.
const here = dirname(fileURLToPath(import.meta.url));
export const PRODUCTS = Object.freeze(['p', 'p1', 'p2', 'p3', 'p9']);
let engine;
export function realEngine() {
  if (engine) return engine;
  const policy = parsePolicy(readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8'));
  if (!policy.ok) throw new Error(`M10 sample policy: ${policy.reason}`);
  engine = makeRules(makeEngine({ products: [...PRODUCTS], rulesState: () => ({ status: 'ok', policy: policy.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, '../M10-rules/roles'), clock: () => T0 }));
  return engine;
}

// What M10 reads for each action M11 asks (engine.mjs ANSWERS; shared/README.md). A test's own answer is reached only
// through these, so a fake can't hide a question the real engine would refuse to read (L81 sweep: start_session was
// asked with the card alone, and count_approval as { ask: {...} }, and the fakes said yes to both).
const isTier = (t) => t === 1 || t === 2;
export const M10_READS = Object.freeze({
  start_session: (s) => (typeof s.product !== 'string' || typeof s.role !== 'string' || !isTier(s.tier) || typeof s.editing !== 'boolean'
    ? 'start_session needs product, role, tier (1 or 2) and editing'
    : s.tier === 1 && !Number.isFinite(Date.parse(s.usage?.read_at ?? '')) ? 'Tier 1 start needs a usage reading' : null),
  count_approval: (s) => (typeof s.product !== 'string' || typeof s.ask_kind !== 'string' || !Object.hasOwn(CHANNEL_TIER, s.channel ?? '') || !Array.isArray(s.risky)
    ? 'count_approval needs product, ask_kind, channel and risky' : null),
  delete_copy: () => null,
});
const readsChecked = (answers) => Object.fromEntries(Object.entries(answers).map(([action, a]) => [action, (s) => {
  const bad = M10_READS[action]?.(s ?? {});
  if (bad) return { decision: 'deny', reason: `fake rules: M10 would refuse this subject (${bad})` };
  return typeof a === 'function' ? a(s) : a;
}]));

// `classify` answers rules.classify (a card's tier and risky classes come from its files, never from a card field).
export const rulesWith = (over = {}, answers = {}, { classify } = {}) => {
  const values = { ...VALUES, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete values[k];
  const all = { count_approval: (s) => realEngine().may('count_approval', s), ...answers };
  return fakeRules({ values, answers: readsChecked(all), classify });
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
// A seed's `changed_at` is not a field (no script may write one): it is when the Record saw the entry's writes, so its
// state age (meta stateSince) is what the test means. The Record's clock is T0 otherwise; `setClock(rec, ms)` moves it.
// A verdict comes only from a review session's own file (M9 applyOutbox), so none can be seeded here.
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
  // On an entity with no states (a fact), `state` is an ordinary field.
  // A field given as undefined is not set (a test leaves it out that way).
  const fields = Object.keys(doc).filter((f) => doc[f] !== undefined && !(stateful && f === 'state') && !(entity === 'card' && atMove.has(f)));
  const mayCreate = (a) => { const s = fieldsAllowed(entity, a, { create: true }); return s && (!stateful || CREATE_STATES[entity][path[0]]?.includes(a)) ? s : null; };
  // A fact is made by the role whose family holds its id (L74), the one script that may.
  const makers = SCRIPTS.filter((a) => mayCreate(a) && (entity !== 'fact' || factFamilyOf(id) === a));
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
    // The claim's two steps (L72): a seed that names none gets a session claim, its process added at claimed → running.
    if (entity === 'card' && to === 'claimed') {
      const { pid: _p, pid_start: _s, claimed_at: _c, ...named } = doc.claim ?? { kind: 'session', session_id: `seed-${String(id).replace(/[^A-Za-z0-9-]/g, '-')}`, host: 'test-host' };
      extra.claim = named;
    }
    if (entity === 'card' && to === 'running' && cur.doc.claim?.kind === 'session') {
      extra.claim = { ...cur.doc.claim, pid: doc.claim?.pid ?? 99_999, pid_start: doc.claim?.pid_start ?? 'seeded' };
    }
    must(rec.write({ actor: by, entity, id, expectRev: cur.rev, doc: { ...cur.doc, ...extra, state: to } }), `${cur.doc.state} → ${to} by ${by}`);
  }
}
/**
 * Test-only: a change to an entry made by the script M9 lets make it (a move by the one that owns that move, a field
 * by one that may set it), as the outside world would make it. Throws when no script may, so a test can't stage a
 * change the real Record would refuse.
 */
export function change(rec, entity, id, patch) {
  const cur = rec.read(entity, id);
  if (!cur) throw new Error(`change ${entity} ${id}: not in the record`);
  const doc = { ...cur.doc, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete doc[k];
  // On an entity with no states (a fact), `state` is an ordinary field.
  const stateful = Object.hasOwn(STATES, entity);
  const moving = stateful && 'state' in patch && patch.state !== cur.doc.state;
  const fields = Object.keys(patch).filter((f) => !(stateful && f === 'state'));
  const may = (a) => { const s = fieldsAllowed(entity, a, { state: cur.doc.state }); return fields.every((f) => s === '*' || s?.has(f)); };
  const by = moving ? scripts(moveActors(entity, cur.doc.state, patch.state)).filter(may) : SCRIPTS.filter(may);
  for (const actor of by) {
    const r = rec.write({ actor, entity, id, expectRev: cur.rev, doc });
    if (r.ok) return r;
  }
  throw new Error(`change ${entity} ${id}: no script may make this change (${JSON.stringify(patch)})`);
}

const clocks = new WeakMap();
/** Moves the Record's clock of a recWith record (ms): its later writes are stamped then. */
export const setClock = (rec, ms) => { clocks.get(rec).t = ms; };
export function recWith(entries = [], { now = T0, dead = null } = {}) {
  const clock = { t: now };
  const rec = memoryRecord({ now: () => clock.t, dead });
  clocks.set(rec, clock);
  for (const [entity, id, doc] of entries) seed(rec, entity, id, doc);
  return rec;
}

/**
 * Test-only: adds one entry to a recWith record, mid-test, the way recWith seeds it (M9's own path, each step by the
 * script that may make it). A changed_at sets the clock for that seed only (kept as a field on a fact).
 */
export function seed(rec, entity, id, doc) {
  const clock = clocks.get(rec);
  const was = clock.t;
  // The record requires a card's module; a fixture card that names none gets a test module.
  const { changed_at: at, ...d0 } = doc ?? {};
  const d = entity === 'card' && !('module' in d0) ? { module: 'M-test', ...d0 } : d0;
  // A changed_at is kept on a fact (its own field, any fact may hold one); elsewhere it only sets the clock.
  const keep = entity === 'fact' && at !== undefined;
  if (!keep && at !== undefined) clock.t = Date.parse(at);
  try { seedOne(rec, entity, id, keep ? { ...d, changed_at: at } : d); } finally { clock.t = was; }
}

// An undo card as the undo step writes it (LEAD-CALLS L40, L74): M9's exact_reverse, whose source is Joe's answered Undo
// ask on a merged card (T-<id>, with the merge commit the gate recorded and the gate's merge MG-<id>), with the reversed
// commit's file list. The undo card is the last entry. `filesOfCommits` answers for every commit these fixtures made.
const commitFiles = new Map();
export const undoSha = (id) => Buffer.from(String(id)).toString('hex').padEnd(40, '0').slice(0, 40);
export const UNDO_TARGET = (id) => `T-${id}`;
export const UNDO_ASK = (id) => `A-${id}`;
export function undoEntries(id, over = {}, { product = 'p1', files = [`src/${id}.js`], pr = 7 } = {}) {
  const sha = undoSha(id);
  commitFiles.set(sha, files);
  const target = UNDO_TARGET(id);
  return [
    ['card', target, { state: 'merged', module: 'M-test', product, tier: 2, files, merge_commit: sha }],
    ['merge', `MG-${id}`, { state: 'merged', card: target, pr, merge_commit: sha, product }],
    ['ask', UNDO_ASK(id), { state: 'answered', kind: 'undo', product, card: target, tier: 2, risky: [], choices: ['Undo', 'Keep'], answer: { channel: 'tap', choice: 'Undo', approves: true, at: iso(T0 - 700_000) } }],
    ['card', id, { state: 'ready', kind: 'exact_reverse', source: { ask: UNDO_ASK(id) }, module: 'M-test', product, tier: 2, files, what: `undo PR ${pr}`, changed_at: iso(T0 - 600_000), ...over }],
  ];
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
