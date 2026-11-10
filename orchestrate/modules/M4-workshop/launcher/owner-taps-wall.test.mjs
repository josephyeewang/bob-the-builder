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
const HANDLER = '/o/review-again.json';
const PATHS = (ownerTaps, reviewAgainConfig = HANDLER, reviewWalls = { outboxRoot: '/r/outbox', runnerRoot: '/r/review' }) => ({
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes', ownerTaps, reviewAgainConfig,
  deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: [], proposals: [] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git', reviewWalls,
});
const render = (role, ownerTaps, handler, reviewWalls) => renderRoleSettings({ productionFiles: [], proposalOutboxes: [], role, profile: DESIGN_PROFILES[role], paths: PATHS(ownerTaps, handler, reviewWalls),
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
    // The tap handler's config is walled the same way (L735, #284 m1-r2): no tool and no shell of the Front Door may
    // change which runner config, and so which taps folder, the handler uses.
    assert.ok(deny.includes(`Edit(/${HANDLER})`) && deny.includes(`Write(/${HANDLER})`), `handler config: ${given}`);
    assert.ok(denyWrite.includes(HANDLER), `handler config, shell: ${given}`);
    assert.equal(checkSettings(r.settings, { profile: DESIGN_PROFILES.front_door }).ok, true);
  }
});

test('L724 (4) planted: a Front Door with no usable taps folder does not launch', () => {
  for (const [label, t] of [['not given', undefined], ['relative', 'o/owner-taps'], ['climbing', '/o/../owner-taps'], ['a space', '/o/owner taps'],
    ['a glob', '/o/owner-taps/*'], ['the root', '/'], ['not text', 7]]) {
    assert.match(render('front_door', t).reason ?? '', /the Front Door's settings need the owner's taps folder \(ownerTaps\)/, label);
  }
});

test('L735 planted: a Front Door with no usable tap handler config does not launch', () => {
  for (const [label, h] of [['not given', null], ['relative', 'o/review-again.json'], ['a folder', '/o/handler/'], ['a dot segment', '/o/./review-again.json'],
    ['the root', '/'], ['inside the taps folder', `${TAPS}/review-again.json`], ['the taps folder', TAPS]]) {
    assert.match(render('front_door', TAPS, h).reason ?? '', /the Front Door's settings need the owner's tap handler's config file \(reviewAgainConfig\)|the tap handler's config must sit outside the taps folder/, label);
  }
});

// L736 m1: a wall path in any other spelling than its resolved one renders a rule the tool's match may never see; it is
// refused, for the taps folder, the handler config and the review walls alike.
test('L736 m1 planted: wall paths spelled other than as they resolve are refused', () => {
  for (const t of ['/o/./owner-taps', '/o//owner-taps', '//o/owner-taps', '/o/owner-taps/.', '/.', '/o/x/../owner-taps']) {
    assert.match(render('front_door', t).reason ?? '', /taps folder \(ownerTaps\) as a plain absolute path, spelled as it resolves/, t);
    assert.match(render('front_door', TAPS, t.replace('owner-taps', 'h.json')).reason ?? '', /reviewAgainConfig/, t.replace('owner-taps', 'h.json'));
    for (const k of ['outboxRoot', 'runnerRoot']) {
      const walls = { outboxRoot: '/r/outbox', runnerRoot: '/r/review', [k]: t };
      assert.match(render('reviewer', TAPS, HANDLER, walls).reason ?? '', new RegExp(`review folder ${k} as a plain absolute path, spelled as it resolves`), `${k} ${t}`);
    }
  }
  // A name that starts with dots is a name, not a climb.
  assert.equal(render('front_door', '/o/..x').ok, true);
  // A trailing slash is dropped, never kept in a rule.
  const r = render('reviewer', TAPS, HANDLER, { outboxRoot: '/r/outbox/', runnerRoot: '/r/review//' });
  assert.equal(r.ok, true, r.reason);
  assert.ok(walls(r).deny.includes('Edit(//r/review/**)') && !walls(r).deny.some((x) => x.includes('review//')), JSON.stringify(walls(r).deny));
});

test('L724 (4): the wall is the Front Door\'s; every other role, which runs as Joe\'s Mac user too (L238) and is kept off the taps folder by its hooks and sandbox, is unchanged', () => {
  for (const role of Object.keys(DESIGN_PROFILES).filter((x) => x !== 'front_door')) {
    const a = render(role, undefined, undefined), b = render(role, TAPS);
    assert.equal(a.ok, true, `${role}: ${a.reason}`);
    assert.deepEqual(b.settings, a.settings, role);
  }
});
