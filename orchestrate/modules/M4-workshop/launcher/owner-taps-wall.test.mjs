// owner-taps-wall.test.mjs — the owner's "review again" taps folder, walled off from the Front Door's own tools and shell
// (L724 (4), R-0b-164). The Front Door runs as the owner, who can write that folder; only the owner's plain tap handler
// (M1 review-again.mjs) may, so the rendered settings deny Edit and Write there and the sandbox denies writes.
// A real Front Door session refused at that folder is part of the wall proof owed on the Mini.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRoleSettings, checkSettings } from './render-settings.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { SETTINGS as S } from './settings-names.mjs';

const TAPS = '/o/owner-taps';
const PATHS = (ownerTaps) => ({
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes', ownerTaps,
  deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: [], proposals: [] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git', reviewWalls: { outboxRoot: '/r/outbox', runnerRoot: '/r/review' },
});
const render = (role, ownerTaps) => renderRoleSettings({ productionFiles: [], proposalOutboxes: [], role, profile: DESIGN_PROFILES[role], paths: PATHS(ownerTaps),
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [] });
const walls = (r) => ({ deny: r.settings[S.permissions][S.deny], denyWrite: r.settings[S.sandbox][S.filesystem][S.denyWrite] });

test('L724 (4): the Front Door\'s tools may not edit or write the owner\'s taps folder, and its shell may not write there', () => {
  assert.ok(DESIGN_PROFILES.front_door.tools.includes('Write'), 'the Front Door has the Write tool, so the rule is needed');
  for (const given of [TAPS, `${TAPS}/`]) {
    const r = render('front_door', given);
    assert.equal(r.ok, true, r.reason);
    const { deny, denyWrite } = walls(r);
    assert.ok(deny.includes(`Edit(/${TAPS}/**)`), `edit: ${given}`);
    assert.ok(deny.includes(`Write(/${TAPS}/**)`), `write: ${given}`);
    assert.ok(denyWrite.includes(TAPS) && denyWrite.includes(`${TAPS}/**`), `shell: ${given}`);
    assert.equal(checkSettings(r.settings, { profile: DESIGN_PROFILES.front_door }).ok, true);
  }
});

test('L724 (4) planted: a Front Door with no usable taps folder does not launch', () => {
  for (const [label, t] of [['not given', undefined], ['relative', 'o/owner-taps'], ['climbing', '/o/../owner-taps'], ['a space', '/o/owner taps'],
    ['a glob', '/o/owner-taps/*'], ['the root', '/'], ['not text', 7]]) {
    assert.match(render('front_door', t).reason ?? '', /the Front Door's settings need the owner's taps folder \(ownerTaps\)/, label);
  }
});

test('L724 (4): the wall is the Front Door\'s; a role that runs as orchestrate, which the owner\'s 0755 folder already shuts out, is unchanged', () => {
  for (const role of Object.keys(DESIGN_PROFILES).filter((x) => x !== 'front_door')) {
    const a = render(role, undefined), b = render(role, TAPS);
    assert.equal(a.ok, true, `${role}: ${a.reason}`);
    assert.deepEqual(b.settings, a.settings, role);
  }
});
