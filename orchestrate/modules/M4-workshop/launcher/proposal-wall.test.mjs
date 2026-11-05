// proposal-wall.test.mjs — the rules' proposals folders, and the wall they make in every session's rendered settings (R-0b-128, L549).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainFolder, proposalFolder, proposalWall } from './proposal-wall.mjs';
import { renderRoleSettings } from './render-settings.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { SETTINGS as S } from './settings-names.mjs';

const rulesWith = (folders) => ({ get: (key, { product }) => { assert.equal(key, 'proposals.outbox'); return folders[product]; } });
const FOLDERS = { a: '/p/a/proposals', b: '/p/b/proposals' };
const PATHS = (proposals) => ({
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes',
  deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: [], proposals },
  bobFolder: '/w/bob', mirror: '/w/mirror.git', reviewWalls: { outboxRoot: '/r/outbox', runnerRoot: '/r/review' },
});
const render = (role, deny, proposalOutboxes, phase) => renderRoleSettings({ productionFiles: [], proposalOutboxes, role, profile: DESIGN_PROFILES[role], paths: PATHS(deny),
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], phase });
// The review roles run as a Mac user that can't read these folders at all (L65), so the Mac is their wall.
const SESSION_ROLES = Object.keys(DESIGN_PROFILES).filter((r) => !['reviewer', 'auditor'].includes(r));

test('L549: every product\'s folder is in the wall, the same folder once', () => {
  assert.deepEqual(proposalWall(rulesWith(FOLDERS), ['a', 'b']), { ok: true, folders: ['/p/a/proposals', '/p/b/proposals'] });
  assert.deepEqual(proposalWall(rulesWith({ a: '/p/x', b: '/p/x' }), ['a', 'b']).folders, ['/p/x']);
});

test('L549: a product with no usable folder refuses, naming it: it is never left out of the wall', () => {
  for (const [label, value] of [['none', undefined], ['relative', 'p/a'], ['climbing', '/p/../a'], ['not text', 7], ['a list', ['/p/a']], ['a home path', '~/p'], ['a dot segment', '/p/./a'], ['ends in a dot', '/p/a/.'], ['a bracket', '/p/a[1]'], ['a space', '/p/a b'], ['the root', '/'], ['only slashes', '//']]) {
    assert.equal(proposalFolder(rulesWith({ a: value }), 'a'), null, label);
    assert.deepEqual(proposalWall(rulesWith({ a: FOLDERS.a, b: value }), ['a', 'b']), { ok: false, reason: 'the rules give no usable proposals folder for b' }, label);
  }
  const broken = { get: () => { throw new Error('rules down'); } };
  assert.match(proposalWall(broken, ['a']).reason, /for a$/);
  for (const list of [undefined, [], 'a']) assert.equal(proposalWall(rulesWith(FOLDERS), list).ok, false);
});

test('L549: every session role that can read the folders is walled off from both, for its tools and for its shell', () => {
  const { folders } = proposalWall(rulesWith(FOLDERS), ['a', 'b']);
  assert.ok(SESSION_ROLES.includes('worker') && SESSION_ROLES.includes('lead') && SESSION_ROLES.length >= 4, SESSION_ROLES.join(', '));
  for (const role of SESSION_ROLES) {
    const r = render(role, folders, folders);
    assert.equal(r.ok, true, `${role}: ${r.reason}`);
    const shellDeny = r.settings[S.sandbox][S.filesystem][S.denyRead];
    for (const f of folders) {
      assert.ok(r.settings[S.permissions][S.deny].includes(`Read(/${f}/**)`), `${role}: read ${f}`);
      assert.ok(r.settings[S.permissions][S.deny].includes(`Edit(/${f}/**)`), `${role}: edit ${f}`);
      assert.ok(shellDeny.includes(f), `${role}: shell ${f}`);
    }
  }
});

test('L549: a session role with the rules\' folders not given, or one left off the deny, does not launch', () => {
  for (const role of SESSION_ROLES) {
    assert.match(render(role, [FOLDERS.a, FOLDERS.b], undefined).reason, /proposals folders were not given/, role);
    assert.match(render(role, [FOLDERS.a], [FOLDERS.a, FOLDERS.b]).reason, /not all on the read-deny list/, role);
  }
});

test('L580: a worker\'s install step, which runs package scripts, is held to the same two refusals', () => {
  assert.match(render('worker', [FOLDERS.a, FOLDERS.b], undefined, 'install').reason, /proposals folders were not given/);
  assert.match(render('worker', [FOLDERS.a], [FOLDERS.a, FOLDERS.b], 'install').reason, /not all on the read-deny list/);
  assert.equal(render('worker', [FOLDERS.a, FOLDERS.b], [FOLDERS.a, FOLDERS.b], 'install').ok, true);
});

test('L580: the forms a real session shows the deny rule works on stay usable', () => {
  for (const f of ['/p/a', '/p/a/', '/p//a', '/p/my.folder/a-b_c']) assert.equal(plainFolder(f), true, f);
});
