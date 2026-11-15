// L1226 (snapshot wall (ii)): a worker session's settings give each hook `--snapshot-owner <uid>` (render-settings.mjs,
// paths.snapshotOwner; the worker runner gives 0, root's worker-rules job's), so the hooks read the snapshot only when it is
// root's alone (hooks/worker-snapshot.test.mjs). hooksSnapshotOwner reads it back, one owner for every hook. A role given
// no owner, every review role among them, renders exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { renderRoleSettings, checkSettings, hooksSnapshot, hooksSnapshotOwner } from './render-settings.mjs';
import { SETTINGS as S, HOOK_FIELDS as H } from './settings-names.mjs';
import { RUNNER_ROLES } from '../../../shared/review-roles.mjs';

const PATHS = {
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/base/worker-rules/alpha.json', node: '/w/node', ownerTaps: '/w/owner-taps', reviewAgainConfig: '/w/review-again.json', notes: '/w/notes',
  deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: ['/w/copy2'] },
  bobFolder: '/w/bob', mirror: '/w/mirror.git',
  reviewWalls: { outboxRoot: '/r/outbox', runnerRoot: '/r/review' },
};
const REVIEW_PATHS = { ...PATHS, snapshot: '/r/review/rules-snapshot.json' };
const PRODUCT = { commands: { test: 'npm test', build: 'npm run build' }, hosts: ['registry.example.com'] };
const render = (role, paths) => renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role, profile: DESIGN_PROFILES[role], paths, product: PRODUCT, rulesHosts: ['registry.example.com'] });
const commands = (s) => Object.values(s[S.hooks]).flatMap((list) => list.flatMap((m) => m[H.hooks].map((h) => h[H.command])));
const WORKER_ROLES = Object.keys(DESIGN_PROFILES).filter((r) => !RUNNER_ROLES.includes(r));

test('L1226: with snapshotOwner 0 every hook reads the snapshot as root\'s, once, right after --snapshot; that is the only change', () => {
  let n = 0;
  for (const role of WORKER_ROLES) {
    const a = render(role, { ...PATHS, snapshotOwner: 0 }); const b = render(role, PATHS);
    if (!a.ok) { assert.equal(b.ok, false, `${role}: refused the same either way`); assert.equal(a.reason, b.reason, role); continue; }
    n += 1;
    const cs = commands(a.settings);
    assert.ok(cs.length > 0, role);
    for (const c of cs) assert.ok(c.includes(` --snapshot ${PATHS.snapshot} --snapshot-owner 0 `) && c.split('--snapshot-owner').length === 2, `${role}: ${c}`);
    assert.equal(hooksSnapshot(a.settings), PATHS.snapshot, `${role}: the owner word is not read as a second --snapshot`);
    assert.equal(hooksSnapshotOwner(a.settings), 0, role);
    assert.equal(checkSettings(a.settings, { profile: DESIGN_PROFILES[role] }).ok, true, role);
    // Take the owner word out and the settings are exactly those rendered without it.
    assert.equal(JSON.stringify(a.settings).replaceAll(' --snapshot-owner 0', ''), JSON.stringify(b.settings), role);
    assert.equal(hooksSnapshotOwner(b.settings), undefined, `${role}: none given, none read`);
  }
  assert.ok(n >= 1 && render('worker', { ...PATHS, snapshotOwner: 0 }).ok, 'the worker role at least renders');
});

test('L1226: the review roles are given no owner and render as before: no hook names one', () => {
  for (const role of RUNNER_ROLES) {
    const r = render(role, REVIEW_PATHS);
    assert.equal(r.ok, true, `${role}: ${r.reason}`);
    assert.ok(commands(r.settings).every((c) => !c.includes('--snapshot-owner')), role);
    assert.equal(hooksSnapshotOwner(r.settings), undefined, role);
  }
});

test('L1226: an owner that is not a uid is refused', () => {
  for (const bad of [-1, 1.5, '0', null, Number.NaN, 1e11]) assert.equal(render('worker', { ...PATHS, snapshotOwner: bad }).reason, 'the snapshot\'s owner is not a uid', String(bad));
});

test('L1226 plant 10: a hook that drops the owner, names it twice, or names another, reads back as no one owner', () => {
  const r = render('worker', { ...PATHS, snapshotOwner: 0 }); assert.equal(r.ok, true);
  const edit = (f) => { const s = structuredClone(r.settings); const list = Object.values(s[S.hooks])[0]; list[0][H.hooks][0][H.command] = f(list[0][H.hooks][0][H.command]); return s; };
  assert.equal(hooksSnapshotOwner(edit((c) => c.replace(' --snapshot-owner 0', ''))), null, 'one hook without it');
  assert.equal(hooksSnapshotOwner(edit((c) => c.replace(' --snapshot-owner 0', ' --snapshot-owner 0 --snapshot-owner 0'))), null, 'twice');
  assert.equal(hooksSnapshotOwner(edit((c) => c.replace(' --snapshot-owner 0', ' --snapshot-owner 501'))), null, 'another owner in one hook');
  assert.equal(hooksSnapshotOwner(edit((c) => c.replace(' --snapshot-owner 0', ' --snapshot-owner x'))), null, 'not a uid');
  assert.equal(hooksSnapshot(edit((c) => c.replace(' --snapshot-owner 0', ' --snapshot-owner 0 --snapshot /else.json'))), null, 'a second --snapshot is still refused');
});
