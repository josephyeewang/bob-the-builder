// Test-only: the design's numbers (v4 §14.1.6 and the review's new keys), passed to fakeRules so no
// Dispatcher file holds them. A test that wants a different number overrides one key.

import { fakeRules } from '../../shared/rules.mjs';
import { memoryRecord } from '../../shared/record.mjs';
import { KEYS as K } from './keys.mjs';

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
  [K.outageMinDead]: 2, [K.outageShare]: 0.5,
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

export function recWith(entries = []) {
  const rec = memoryRecord();
  for (const [entity, id, doc] of entries) {
    // The record requires a card's module; a fixture card that names none gets a test module.
    const d = entity === 'card' && doc && !('module' in doc) ? { module: 'M-test', ...doc } : doc;
    const r = rec.write({ actor: 'dispatcher', entity, id, expectRev: 0, doc: d });
    if (!r.ok) throw new Error(r.reason);
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
