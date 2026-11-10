// The runner's `start` for M5's end-to-end tests (review-core, findings-rounds), with a stand-in claude.
//
// Since L83 M-3 the real wiring starts a session only through launch()'s checks 0 to 13, and until lane 2's review-role
// entries land (check 2 not-applicable, the budget source, the Bob folder form) and the setting names are confirmed
// live, it starts none. So each start first shows the real wiring refusing in this same world, with claude never
// spawned. Then it runs the wiring's own steps as the wiring runs them: the real review copy from the real mirror, the
// real package in the runner's folder (with `since` for a re-audit), the real prompt, and the session's arguments from
// the one sessionArgs (so a send-back's effort comes from where the wiring takes it). The stand-in gets those arguments.
// Once review starts are unblocked, the tests go back to calling the wiring alone.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { start as wiringStart } from '../M4-workshop/launcher/review-wiring.mjs';
import { prepareReviewCopy } from '../M4-workshop/launcher/review-runner-main.mjs';
import { sessionArgs } from '../M4-workshop/launcher/review-launch.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';
import { reviewPackage } from './review-package.mjs';
import { reviewerPrompt } from './reviewer-prompt.mjs';

/** → the runner's ctx.start. live: the test's list of running sessions (each started one is pushed). */
export function standInStart({ mirror, copies, root, claudeBin, spawn, live }) {
  return async (x) => {
    const copy = join(copies, x.sessionId);
    const spawned = [];
    const real = await wiringStart({ ...x, claudeBin, copy: `${copy}-wiring`, spawn: (...a) => spawned.push(a),
      makeCopy: () => prepareReviewCopy({ mirror, card: x.card, head: x.head, dest: `${copy}-wiring` }),
      settingsFor: () => ({ ok: true, file: join(root, 'settings', `${x.sessionId}.json`), settings: {} }),
      packageDir: `${x.packageDir}-wiring` });
    assert.equal(real.ok, false, 'the real wiring starts no review session until its launch checks can pass');
    assert.equal(spawned.length, 0, 'and claude is never spawned');
    const made = await prepareReviewCopy({ mirror, card: x.card, head: x.head, dest: copy });
    if (!made.ok) return { ok: false, reason: made.reason };
    const pkg = await reviewPackage({ copy, head: x.head, dir: x.packageDir, since: x.audited });
    if (!pkg.ok) return { ok: false, reason: pkg.reason };
    const args = sessionArgs({ profile: DESIGN_PROFILES[x.role], settingsFile: join(root, 'settings', `${x.sessionId}.json`), sessionId: x.sessionId,
      prompt: reviewerPrompt({ ...x, pkg }), earlier: x.earlier });
    const child = spawn(claudeBin, args);
    const pid = await new Promise((res) => child.once('spawn', () => res(child.pid)));
    live.push({ pid, sessionId: x.sessionId });
    return { ok: true, pid, package_sha256: pkg.diffSha256 };
  };
}
