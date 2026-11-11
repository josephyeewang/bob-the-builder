// L204-a: the session record the Dispatcher writes at launch is all M4's push script needs. A card started by the
// real pass is pushed by the real push script, with nothing written to the Record in between but the worker's bundle.
// Real git against a local bare repo standing in for GitHub (M4's push-world.test-helper); no network, no real session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dispatcherPass } from './pass.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, recWith, usageFact, T0, MIN, iso, withAlerts } from './fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { pushWorld, PRODUCT } from '../M4-workshop/git/push-world.test-helper.mjs';

const ACCT = 'acct-a';
const allowStart = { start_session: () => ({ decision: 'allow', reason: 'ok' }) };

async function startOne(rec, outboxRoot) {
  const alerts = [];
  let asked;
  const r = await withAlerts(rec, T0, (t) => alerts.push(t), (alert) => dispatcherPass({
    rec, rules: rulesWith({}, allowStart), now: T0, account: ACCT, sessions: [], probe: () => null,
    // M4's launcher makes the session's own outbox, <root>/<product>/<role>/<sessionId> (L836), and answers where it is.
    outboxRoot,
    launch: async (x) => { asked = x; const outbox = join(outboxRoot, PRODUCT, 'worker', x.sessionId); mkdirSync(outbox, { recursive: true, mode: 0o700 }); return { ok: true, sessionId: x.sessionId, pid: 4242, pidStart: 'start-1', pgid: 4242, head: 'h'.repeat(40), outbox }; },
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: () => {}, startsOff: null, filesOf: () => [],
    alert,
  }));
  return { r, alerts, sessionId: asked?.sessionId };
}

test('L204-a: a card the real pass starts is pushed by the real push script from its session record alone', async () => {
  const root = tempDir('orch-push-');
  const rec = recWith([['product', PRODUCT, { state: 'active' }],
    ['card', 'C-1', { state: 'ready', module: 'M-test', product: PRODUCT, lane: 'product', what: 'Card one', tier: 2, files: ['app.txt'], changed_at: iso(T0 - 10 * MIN) }]]);
  assert.equal(rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: T0 }) }).ok, true);
  const w = await pushWorld({ root, record: rec, seed: false });
  const outboxRoot = join(root, 'outboxes');

  const { r, alerts, sessionId } = await startOne(rec, outboxRoot);
  assert.deepEqual(r.started, ['C-1']);
  assert.deepEqual(alerts, []);
  const s = rec.read('session', sessionId)?.doc;
  assert.deepEqual([s?.state, s?.role, s?.product, s?.card, s?.branch, s?.outbox, s?.attempt, s?.pid, s?.pid_start],
    ['preparing', 'worker', PRODUCT, 'C-1', 'card/c-1', join(outboxRoot, PRODUCT, 'worker', sessionId), 'a1', 4242, 'start-1']);

  // The worker's work: one commit on the card's branch, handed in as a bundle in its own outbox.
  await w.commit('card one', (dir) => writeFileSync(join(dir, 'app.txt'), 'app, changed\n'));
  await w.bundle(undefined, s.outbox);
  const tip = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();

  // The world's rules hand every value back as the rules file's reader does (true as "true"), so this push reads its
  // rules as it will on the Mac.
  // The pass and the push script both check the outbox against the same root (L836 self-review m3).
  const p = await w.push({ outboxRoot }, sessionId);
  assert.equal(p.ok, true, p.reason);
  assert.ok((await w.ghRefs()).split('\n').includes(`refs/heads/card/c-1 ${tip}`), 'GitHub has the card branch at the worker\'s tip');
  const f = rec.read('fact', 'push.C-1.a1')?.doc;
  assert.deepEqual([f?.result, f?.tip], ['pushed', tip]);
});
