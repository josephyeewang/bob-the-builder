// race.test.mjs — R-0b-22 / claim test 4: 8 separate processes claim one card at the same rev. Exactly one wins and
// 7 are refused naming the holder, in each of 5 runs. The same race with the lock and the rev check turned off must
// see more than one winner, so the test is shown able to fail (0b-2 M-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, iso, seed, setup } from './fixtures.test-helper.mjs';

const CHILD = fileURLToPath(new URL('./child.test-helper.mjs', import.meta.url));
const RACERS = 8;

async function race({ testNoLock = false, testNoRevCheck = false } = {}) {
  const env = setup({ prefix: 'm9-race-' });
  seed(env, 'product', PRODUCT, { state: 'active' });
  env.store.transaction((tx) => tx.commit([{ entity: 'card', id: 'C-1', doc: { state: 'ready', product: PRODUCT, module: 'M1', kind: 'lead_daily_card', round: 1 } }], { actor: 'lead:L-1', kind: 'seed' }));
  const cur = env.record.read('card', 'C-1');
  const go = join(env.base, 'go');
  const kids = Array.from({ length: RACERS }, (_, i) => {
    const w = { actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: cur.rev,
      doc: { ...cur.doc, state: 'claimed', claim: { kind: 'session', host: 'mac-a', pid: 1000 + i, pid_start: 'x', session_id: `S-${i}` } } };
    const c = spawn(process.execPath, [CHILD, JSON.stringify({ op: 'race', root: env.root, go, w, testNoLock, testNoRevCheck, now: env.clock.t })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    return new Promise((res) => c.on('exit', () => res(JSON.parse(out.split('\n')[0] || '{}'))));
  });
  await new Promise((res) => setTimeout(res, 600));   // let all 8 load and wait on the go file
  writeFileSync(go, iso(Date.now()));
  const results = await Promise.all(kids);
  return { env, results };
}

for (let run = 1; run <= 5; run++) {
  test(`8 processes race to claim one card (run ${run}): one winner, 7 refused naming the holder`, async () => {
    const { env, results } = await race();
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const holder = env.record.read('card', 'C-1').doc.claim.session_id;
    for (const r of results.filter((x) => !x.ok)) assert.match(r.reason, new RegExp(`claimed by ${holder}`), r.reason);
    assert.equal(env.record.diary().filter((l) => l.kind === 'claim').length, 1, 'one claim line in the diary');
  });
}

test('mutation: with the lock and rev check off, the same race lets more than one process win', async () => {
  let most = 0;
  for (let i = 0; i < 5 && most < 2; i++) {
    const { results } = await race({ testNoLock: true, testNoRevCheck: true });
    most = Math.max(most, results.filter((r) => r.ok).length);
  }
  assert.ok(most > 1, `only ${most} winner with the protections off: the race test could not fail`);
});
