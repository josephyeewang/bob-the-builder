// fetch.test.mjs — R-0b-141: Bob's method folder at the pinned commit, read only, with no SKILL.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { fakeRules } from '../../../shared/rules.mjs';
import { fetchBobMethod, methodPatterns, pickFiles, GITHUB_ADDRESS } from './fetch.mjs';
import { checkBobFolder } from '../launcher/launch.mjs';
import { renderRoleSettings, bobFolderDeny } from '../launcher/render-settings.mjs';
import { DESIGN_PROFILES } from '../launcher/role-profiles.mjs';
import { SETTINGS as S } from '../launcher/settings-names.mjs';

const tmp = () => tempDir('m4-bobfetch-');
const ME = process.getuid();
const PRODUCT = 'p1';
const METHOD = ['build-protocol-core.md', 'build-protocol.md', 'templates/**'];
const PLANTED = 'planted-secret-value-141';
const sha = (b) => createHash('sha256').update(b).digest('hex');

// A plain git for the test's own source repository (never the code under test).
function sh(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A source repository standing in for GitHub. → { src, commit(files) → commit id } */
function source() {
  const src = join(tmp(), 'bob-src');
  mkdirSync(src);
  sh(src, 'init', '-q', '-b', 'main');
  const commit = (files) => {
    for (const [p, t] of Object.entries(files)) { mkdirSync(join(src, p, '..'), { recursive: true }); if (t === null) symlinkSync('build-protocol.md', join(src, p)); else writeFileSync(join(src, p), t); }
    sh(src, 'add', '-A'); sh(src, 'commit', '-q', '-m', 'c');
    return sh(src, 'rev-parse', 'HEAD');
  };
  return { src, commit };
}

const BASE = {
  'build-protocol-core.md': '# core v1\n', 'build-protocol.md': '# protocol\n', 'templates/a.md': 'a\n', 'templates/deep/b.md': 'b\n',
  'skills/bob/SKILL.md': '---\nname: bob\n---\n', 'README.md': 'not a method file\n',
};

function world({ pin, method = METHOD } = {}) {
  const home = join(tmp(), 'orch'); mkdirSync(home); chmodSync(home, 0o755);
  const rules = fakeRules({ values: { 'bob.pin': pin, 'bob.method_files': method } });
  return { rules, product: PRODUCT, folder: join(home, 'bob'), mirror: join(home, 'bob-mirror.git'), owner: ME, uid: ME, localAddress: true };
}
// The rules render-settings writes (the shared helper since L750), so check 13 and this test can't drift apart.
const denyFor = (folder) => ({ [S.permissions]: { [S.deny]: bobFolderDeny(folder) } });

test('R-0b-141: the pinned commit\'s method files land read only in the folder, and check 13 takes them', async () => {
  const s = source();
  const pin = s.commit(BASE);
  s.commit({ 'build-protocol-core.md': '# core v2, after the pin\n' });
  const w = world({ pin });
  const r = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fetched, true);
  assert.equal(r.commit, pin);
  assert.deepEqual(Object.keys(r.manifest).sort(), ['build-protocol-core.md', 'build-protocol.md', 'templates/a.md', 'templates/deep/b.md']);
  assert.equal(readFileSync(join(w.folder, 'build-protocol-core.md'), 'utf8'), '# core v1\n', 'the pinned bytes, not main\'s');
  assert.equal(r.manifest['build-protocol-core.md'], sha('# core v1\n'));
  assert.equal(existsSync(join(w.folder, 'README.md')), false, 'only the method files');
  assert.equal(existsSync(join(w.folder, 'skills')), false, 'no skill');
  for (const p of ['build-protocol-core.md', 'templates/deep/b.md']) assert.equal(statSync(join(w.folder, p)).mode & 0o777, 0o444, p);
  for (const p of ['', 'templates', 'templates/deep']) assert.equal(statSync(join(w.folder, p)).mode & 0o777, 0o555, p || 'top');
  assert.deepEqual(checkBobFolder({ folder: w.folder, manifest: r.manifest, settings: denyFor(w.folder) }), { ok: true });
  const again = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.fetched, false, 'a folder already at the pin is left as it is');
  // Loosened by hand: the bytes match, but it is rewritten read only, never kept (review of #316, m1).
  chmodSync(join(w.folder, 'build-protocol-core.md'), 0o666); chmodSync(w.folder, 0o777);
  const loose = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(loose.ok, true, loose.reason);
  assert.equal(loose.fetched, true, 'a loosened folder is rewritten');
  assert.equal(statSync(join(w.folder, 'build-protocol-core.md')).mode & 0o777, 0o444);
  assert.equal(statSync(w.folder).mode & 0o777, 0o555);
  // A mirror others can write is refused: a planted pack could map the pin to other bytes (m2).
  chmodSync(join(w.mirror, 'objects'), 0o777);
  assert.match((await fetchBobMethod({ ...w, address: s.src })).reason, /the Bob mirror: .*objects can be written by others/);
});

// The Lead's real rendered settings, with one proposals folder (an empty list is refused, L746).
function leadSettings(folder) {
  const paths = { copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes', bobFolder: folder,
    deny: { secrets: [], otherCopies: [], proposals: ['/w/proposals'] } };
  return renderRoleSettings({ role: 'lead', profile: DESIGN_PROFILES.lead, paths, productionFiles: [], proposalOutboxes: ['/w/proposals'] });
}

test('R-0b-141: SKILL.md stays unreadable: the folder never holds one, a planted one is taken out, and the Lead\'s settings deny reading any', async () => {
  const s = source();
  const pin = s.commit(BASE);
  const w = world({ pin });
  assert.equal((await fetchBobMethod({ ...w, address: s.src })).ok, true);
  chmodSync(w.folder, 0o755);
  writeFileSync(join(w.folder, 'SKILL.md'), '---\nname: planted\n---\n');
  const r0 = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(r0.ok, true, r0.reason);
  assert.equal(r0.fetched, true);
  assert.equal(existsSync(join(w.folder, 'SKILL.md')), false);
  assert.deepEqual(checkBobFolder({ folder: w.folder, manifest: r0.manifest, settings: denyFor(w.folder) }), { ok: true });
  // The Lead is given the folder, can't write it, and is denied reading any SKILL.md anywhere.
  const abs = w.folder.replace(/^\/+/, '');
  const lead = leadSettings(w.folder);
  assert.equal(lead.ok, true, lead.reason);
  const deny = lead.settings[S.permissions][S.deny];
  assert.ok(deny.includes('Read(//**/SKILL.md)'), 'no SKILL.md is readable');
  assert.ok(deny.some((d) => d.startsWith('Write(') && d.includes(abs)) && deny.some((d) => d.startsWith('Edit(') && d.includes(abs)), 'the folder is not writable');
  assert.ok(!deny.some((d) => d.startsWith('Read(') && d.includes(abs)), 'the folder itself is readable');
  assert.ok(lead.settings[S.permissions][S.additionalDirectories].includes(w.folder), 'the Lead is given the folder');
  // A pin whose method files hold a skill is refused: nothing skipped, nothing written.
  const w2 = world({ pin: s.commit({ 'templates/skills/x.md': 'x\n' }) });
  assert.match((await fetchBobMethod({ ...w2, address: s.src })).reason, /templates\/skills\/x\.md is in a skills folder/);
  assert.equal(existsSync(w2.folder), false);
  const w3 = world({ pin: s.commit({ 'templates/SKILL.md': 's\n' }) });
  assert.match((await fetchBobMethod({ ...w3, address: s.src })).reason, /templates\/SKILL\.md is a skill/);
});

test('R-0b-141: nothing from the caller\'s environment reaches git, and only github.com\'s https address is fetched from', async () => {
  const s = source();
  const pin = s.commit(BASE);
  const w = world({ pin });
  const log = join(tmp(), 'env.log');
  const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const wrap = join(tmp(), 'git-wrap');
  writeFileSync(wrap, `#!/bin/sh\n/usr/bin/env >> '${log}'\necho "ARGS $*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  process.env.GH_TOKEN = PLANTED; process.env.GITHUB_TOKEN = PLANTED;
  try {
    const r = await fetchBobMethod({ ...w, address: s.src, gitBin: wrap });
    assert.equal(r.ok, true, r.reason);
  } finally { delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN; }
  const seen = readFileSync(log, 'utf8');
  assert.match(seen, /ARGS .*fetch/, 'the fetch went through the wrapped git');
  assert.ok(!seen.includes(PLANTED) && !/TOKEN=/.test(seen), 'no token in git\'s environment');
  assert.doesNotMatch(seen, /extraheader/i, 'no header');
  const helper = seen.match(/^GIT_CONFIG_KEY_(\d+)=credential\.helper$/m);
  assert.ok(helper, 'the credential helper is set');
  assert.match(seen, new RegExp(`^GIT_CONFIG_VALUE_${helper[1]}=$`, 'm'), 'and set empty');
  for (const a of [s.src, `https://u:${PLANTED}@github.com/o/r.git`, 'https://user@github.com/o/r.git', 'http://github.com/o/r.git', 'https://example.com/o/r.git', 'git@github.com:o/r.git']) {
    assert.match((await fetchBobMethod({ ...w, localAddress: false, address: a })).reason, /public repository's https address/, a);
  }
  assert.ok(GITHUB_ADDRESS.test('https://github.com/owner/repo.git'));
  for (const a of ['https://github.com/../r.git', 'https://github.com/./r.git', 'https://github.com/o/...git']) assert.equal(GITHUB_ADDRESS.test(a), false, a);
});

test('R-0b-141 (review of #316, m5): the real path, with localAddress off, hands git the github.com address and no other', async () => {
  const s = source();
  const pin = s.commit(BASE);
  const w = world({ pin });
  const address = 'https://github.com/o/r.git';
  const log = join(tmp(), 'args.log');
  const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const wrap = join(tmp(), 'git-swap');
  // Offline: the wrapper swaps the github.com address for the local source, after logging what it was handed.
  writeFileSync(wrap, `#!/bin/sh\necho "ARGS $*" >> '${log}'\nfor a; do shift; [ "$a" = '${address}' ] && a='${s.src}'; set -- "$@" "$a"; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const r = await fetchBobMethod({ ...w, localAddress: false, address, gitBin: wrap });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fetched, true);
  const fetches = readFileSync(log, 'utf8').split('\n').filter((l) => / fetch /.test(` ${l} `));
  assert.ok(fetches.length >= 1 && fetches.every((l) => l.includes(address) && !l.includes(s.src)), fetches.join(' | '));
});

test('R-0b-141: each refusal gives its own reason and writes nothing', async () => {
  const s = source();
  const pin = s.commit(BASE);
  const w = world({ pin });
  const go = (o) => fetchBobMethod({ ...w, address: s.src, ...o });
  const rules = (v) => ({ rules: fakeRules({ values: v }) });
  assert.match((await go({ uid: 0, owner: 0 })).reason, /never runs as root/);
  assert.match((await go({ uid: ME + 1 })).reason, /only as the orchestrate user/);
  assert.match((await go(rules({ 'bob.method_files': METHOD }))).reason, /pin no Bob commit/);
  assert.match((await go(rules({ 'bob.pin': pin.slice(0, 12), 'bob.method_files': METHOD }))).reason, /pin no Bob commit/);
  assert.match((await go(rules({ 'bob.pin': '0'.repeat(40), 'bob.method_files': METHOD }))).reason, /placeholder/);
  assert.match((await go(rules({ 'bob.pin': pin }))).reason, /no Bob method files/);
  assert.match((await go(rules({ 'bob.pin': pin, 'bob.method_files': ['templates/*.md'] }))).reason, /not a plain path/);
  assert.match((await go(rules({ 'bob.pin': pin, 'bob.method_files': ['../x.md'] }))).reason, /not a plain path/);
  assert.match((await go(rules({ 'bob.pin': pin, 'bob.method_files': [...METHOD, 'gone.md'] }))).reason, /has no gone\.md/);
  assert.match((await go(rules({ 'bob.pin': 'a'.repeat(40), 'bob.method_files': METHOD }))).reason, /fetch failed|did not bring/);
  chmodSync(join(w.folder, '..'), 0o777);
  assert.match((await go({})).reason, /can be written by others/);
  chmodSync(join(w.folder, '..'), 0o755);
  assert.equal(existsSync(w.folder), false, 'nothing written by any refusal');
  const linkPin = s.commit({ 'templates/l.md': null });
  assert.match((await go(rules({ 'bob.pin': linkPin, 'bob.method_files': METHOD }))).reason, /templates\/l\.md is a link/);
  assert.equal(existsSync(w.folder), false);
});

test('R-0b-141: the pattern reader takes exact paths and dir/** only', () => {
  assert.deepEqual(methodPatterns(['a.md', 'd/**']).patterns, [{ exact: 'a.md' }, { under: 'd' }]);
  for (const bad of [[], null, [7], ['d/*'], ['**'], ['a/../b'], ['d/**/x']]) assert.equal(methodPatterns(bad).ok, false, JSON.stringify(bad));
  assert.match(pickFiles(Buffer.from(`100644 blob ${'a'.repeat(40)}\tx.md\0`), [{ exact: 'y.md' }]).reason, /has no y\.md/);
});

// Review of #316, m6: check 13 against the Lead's real rendered settings (real since the L750 deny-form fix, #319).
test('R-0b-141: check 13 takes the folder under the Lead\'s real rendered settings', async () => {
  const s = source();
  const w = world({ pin: s.commit(BASE) });
  const r = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(r.ok, true, r.reason);
  const lead = leadSettings(w.folder);
  assert.deepEqual(checkBobFolder({ folder: w.folder, manifest: r.manifest, settings: lead.settings }), { ok: true });
});

// r1 audit of #316, m-2 (plant F1): a folder loosened alone, with every file still 0444, is rewritten, never kept.
test('R-0b-141: a folder loosened alone (0777, files 0444) is rewritten read only', async () => {
  const s = source();
  const w = world({ pin: s.commit(BASE) });
  assert.equal((await fetchBobMethod({ ...w, address: s.src })).ok, true);
  chmodSync(join(w.folder, 'templates', 'deep'), 0o777);
  const r = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fetched, true, 'the loosened folder is not kept');
  assert.equal(statSync(join(w.folder, 'templates', 'deep')).mode & 0o777, 0o555);
});

// r1 audit of #316, m-3 (plant F4): a swap whose second rename fails puts the old folder back, and refuses.
test('R-0b-141: a failed second rename puts the old folder back and refuses', async () => {
  const s = source();
  const w = world({ pin: s.commit(BASE) });
  assert.equal((await fetchBobMethod({ ...w, address: s.src })).ok, true);
  chmodSync(w.folder, 0o755); writeFileSync(join(w.folder, 'extra.md'), 'x\n'); chmodSync(w.folder, 0o555);
  let n = 0;
  const rename = (a, b) => { n += 1; if (n === 2) throw Object.assign(new Error('planted: the second rename fails'), { code: 'EIO' }); renameSync(a, b); };
  const r = await fetchBobMethod({ ...w, address: s.src, rename });
  assert.match(r.reason ?? '', /could not be written: planted: the second rename fails/);
  assert.equal(n, 3, 'the old folder is renamed back');
  assert.equal(readFileSync(join(w.folder, 'extra.md'), 'utf8'), 'x\n', 'the old folder is back in place');
  assert.deepEqual(readdirSync(join(w.folder, '..')).filter((x) => /^\.bob\.(old|new)-/.test(x)), [], 'nothing left beside it');
});

// r1 audit of #316, m-4: the new folder is in place, so a failed cleanup of the old one is a warning, and the fetch is ok.
test('R-0b-141: a failed cleanup of the old folder after a good swap answers ok with a warning', async () => {
  const s = source();
  const p1 = s.commit(BASE);
  const w = world({ pin: p1 });
  assert.equal((await fetchBobMethod({ ...w, address: s.src })).ok, true);
  const p2 = s.commit({ 'build-protocol-core.md': '# core v2\n' });
  const remove = (p) => { if (/\.bob\.old-/.test(p)) throw Object.assign(new Error('planted: cannot remove'), { code: 'EPERM' }); };
  const r = await fetchBobMethod({ ...w, rules: fakeRules({ values: { 'bob.pin': p2, 'bob.method_files': METHOD } }), address: s.src, remove });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fetched, true);
  assert.match(r.warning ?? '', /the old Bob folder .*\.bob\.old-.* could not be removed: planted: cannot remove/);
  assert.equal(readFileSync(join(w.folder, 'build-protocol-core.md'), 'utf8'), '# core v2\n');
  const clean = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(clean.warning, undefined, 'a clean fetch carries no warning');
});

// r1 audit of #316, m-1: an access list (ACL) can open a folder to others while its bits look shut. macOS only.
test('R-0b-141: an access list on the folder above, on the mirror or on the Bob folder is refused or rewritten', {
  skip: process.platform !== 'darwin' ? 'macOS access lists' : false,
}, async () => {
  const s = source();
  const w = world({ pin: s.commit(BASE) });
  const plus = (p) => { const r = spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,add_subdirectory,delete_child', p], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const clear = (p) => spawnSync('/bin/chmod', ['-N', p]);
  const parent = join(w.folder, '..');
  plus(parent);
  assert.match((await fetchBobMethod({ ...w, address: s.src })).reason ?? '', /has an access list/);
  clear(parent);
  assert.equal((await fetchBobMethod({ ...w, address: s.src })).ok, true);
  plus(join(w.mirror, 'objects'));
  assert.match((await fetchBobMethod({ ...w, address: s.src })).reason ?? '', /the Bob mirror: .*has an access list/);
  clear(join(w.mirror, 'objects'));
  chmodSync(w.folder, 0o755); plus(w.folder); chmodSync(w.folder, 0o555);
  const r = await fetchBobMethod({ ...w, address: s.src });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fetched, true, 'a Bob folder with an access list is rewritten, never kept');
  assert.equal(spawnSync('/bin/ls', ['-lde', w.folder], { encoding: 'utf8' }).stdout.includes('allow'), false);
});
