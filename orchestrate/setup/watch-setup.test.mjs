// Tests for setup part 4: the watch-only week's rules copy (watch-rules / check-watch-rules) and its hourly job.
// Same stand-in Mac as the other setup tests (fake-mac.test-helper.mjs). PLANT tests break one clause each and name the
// check that catches it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT_CONFIG_PATH, parseConfig, watchRulesPath } from './layout.mjs';
import { parseInstallConfig } from './install.mjs';
import { jobsFor, plistTexts, checkDaemons, planPlace } from './daemons.mjs';
import { checkWatchRules, planWatchRules, watchPlist, WATCH_RUN } from './watch-setup.mjs';
import { main, parseArgs } from './setup.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const BASE = '/Library/orch-test';
const RULES = 'version: 1\nlanes:\n  docs: { risky: false }\n';
const HASH = createHash('sha256').update(RULES).digest('hex');
const REPO = 'example-org/example-repo';
const RAW = {
  base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: 'com.example.orch-test',
  runnerConfig: '/tmp/x/review.json', extras: [], watch: { repo: REPO, rulesSha256: HASH },
};
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };

function world({ raw = RAW, as = 0 } = {}) {
  const mac = fakeMac({ euid: 0 });
  const ext = tempDir('orch-watch-setup-');
  const src = join(ext, 'rules.yaml'); writeFileSync(src, RULES);
  const cfgFile = join(ext, 'c.json'); writeFileSync(cfgFile, JSON.stringify(raw));
  const argv = (args) => {
    if (mac.as === 0) { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return args; }
    return [...args, '--config', cfgFile];
  };
  const run = (args) => { const s = sink(); const code = main(argv(args), { io: mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') }; };
  const first = run(['users-folders']); assert.equal(first.code, 0, first.text);
  mac.as = as;
  return { mac, ext, src, raw, cfg: parseInstallConfig(raw), run };
}
const failing = (res) => res.filter((r) => !r.ok);

test('config: watch must be { repo, rulesSha256 }; anything else is refused; absent is fine', () => {
  assert.equal(parseConfig({ base: BASE, owner: 'sam', products: [] }).watch, undefined);
  assert.deepEqual(parseConfig(RAW).watch, { repo: REPO, rulesSha256: HASH });
  for (const bad of [{}, { repo: REPO }, { rulesSha256: HASH }, { repo: REPO, rulesSha256: HASH.toUpperCase() }, { repo: REPO, rulesSha256: HASH.slice(1) }, { repo: 'no-slash', rulesSha256: HASH }, { repo: '../x/y', rulesSha256: HASH }, { repo: REPO, rulesSha256: HASH, extra: 1 }, [], 'x', null]) {
    assert.throws(() => parseConfig({ ...RAW, watch: bad }), /watch/, JSON.stringify(bad));
  }
});

test('PIN: the hash watch-rules checks is the one shasum -a 256 prints (what the person is told to run)', { skip: process.platform !== 'darwin' }, () => {
  const w = world();
  const r = spawnSync('/usr/bin/shasum', ['-a', '256', w.src], { encoding: 'utf8' });
  assert.equal(r.stdout.split(' ')[0], HASH);
});

test('watch-rules: puts the rules in place as root\'s 0644 copy; dry run changes nothing; a second run does nothing; check passes', () => {
  const w = world();
  const dry = w.run(['watch-rules', '--rules-source', w.src, '--dry-run']);
  assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /would run: write .*rules-draft\.yaml/);
  assert.throws(() => statSync(w.mac.at(watchRulesPath(w.cfg))));
  const r = w.run(['watch-rules', '--rules-source', w.src]); assert.equal(r.code, 0, r.text); assert.match(r.text, /done: all 1 items PASS/);
  const f = w.mac.at(watchRulesPath(w.cfg));
  assert.equal(readFileSync(f, 'utf8'), RULES);
  assert.equal(statSync(f).mode & 0o7777, 0o644);
  assert.equal(w.mac.owners.get(watchRulesPath(w.cfg)).uid, w.mac.rootUid);
  const again = w.run(['watch-rules', '--rules-source', w.src]); assert.equal(again.code, 0); assert.match(again.text, /nothing to do/);
  assert.deepEqual(failing(checkWatchRules(w.mac, w.cfg)), []);
  assert.equal(w.run(['check-watch-rules']).code, 0);
});

test('PLANT watch-rules: a rules file that does not hash to the config\'s value is refused, nothing written (caught by the hash clause)', () => {
  const w = world();
  writeFileSync(w.src, `${RULES}  - extra: true\n`);
  const r = w.run(['watch-rules', '--rules-source', w.src]);
  assert.equal(r.code, 1); assert.match(r.text, /hashes to [0-9a-f]{12}….*config.*says [0-9a-f]{12}…/); assert.match(r.text, /nothing was changed/);
  assert.throws(() => statSync(w.mac.at(watchRulesPath(w.cfg))));
});

test('watch-rules: refusals — no watch entry, not root, missing source, source not a full path, folder not orchestrate\'s', () => {
  const { watch, ...noWatch } = RAW;
  const a = world({ raw: noWatch }); const r1 = a.run(['watch-rules', '--rules-source', a.src]);
  assert.equal(r1.code, 1); assert.match(r1.text, /no "watch" entry/);
  const b = world({ as: 501 }); const r2 = b.run(['watch-rules', '--rules-source', b.src]);
  assert.equal(r2.code, 2); assert.match(r2.text, /must run as root/);
  const c = world(); assert.equal(c.run(['watch-rules', '--rules-source', join(c.ext, 'nope.yaml')]).code, 1);
  const d = world(); assert.equal(d.run(['watch-rules', '--rules-source', 'rules.yaml']).code, 1);
  assert.equal(d.run(['watch-rules']).code, 2);
  const e = world(); chmodSync(e.mac.at(`${BASE}/watch`), 0o755);
  const r5 = e.run(['watch-rules', '--rules-source', e.src]); assert.equal(r5.code, 1); assert.match(r5.text, /not orchestrate's own 0700 folder/);
  assert.throws(() => parseArgs(['check-watch-rules', '--dry-run']), /never changes anything/);
  assert.throws(() => parseArgs(['check', '--rules-source', '/x']), /only for watch-rules/);
});

test('PLANT check-watch-rules: a copy edited after the fact (hash differs) → FAILS naming both hashes', () => {
  const w = world(); w.run(['watch-rules', '--rules-source', w.src]);
  writeFileSync(w.mac.at(watchRulesPath(w.cfg)), `${RULES}# changed\n`);
  const bad = failing(checkWatchRules(w.mac, w.cfg)); assert.equal(bad.length, 1); assert.match(bad[0].why, /hashes to [0-9a-f]{12}….*config says/);
  assert.equal(w.run(['check-watch-rules']).code, 1);
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);   // putting it right again
  assert.deepEqual(failing(checkWatchRules(w.mac, w.cfg)), []);
});

test('PLANT check-watch-rules: mode 666, a wrong owner, a link, and a missing copy each FAIL', () => {
  const w = world(); w.run(['watch-rules', '--rules-source', w.src]);
  const f = w.mac.at(watchRulesPath(w.cfg));
  chmodSync(f, 0o666); assert.match(failing(checkWatchRules(w.mac, w.cfg))[0].why, /mode is 666/); chmodSync(f, 0o644);
  const own = w.mac.owners.get(watchRulesPath(w.cfg));
  w.mac.owners.set(watchRulesPath(w.cfg), { ...own, uid: w.mac.rootUid + 1 }); assert.match(failing(checkWatchRules(w.mac, w.cfg))[0].why, /not root/);
  w.mac.owners.set(watchRulesPath(w.cfg), own);
  rmSync(f); symlinkSync(w.src, f); assert.match(failing(checkWatchRules(w.mac, w.cfg))[0].why, /not a plain file/);
  rmSync(f); assert.match(failing(checkWatchRules(w.mac, w.cfg))[0].why, /missing/);
  // and a link where the copy goes is replaced by the real file, the link's target never written
  symlinkSync(w.src, f); const before = readFileSync(w.src, 'utf8');
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);
  assert.equal(readFileSync(w.src, 'utf8'), before); assert.equal(statSync(f).isFile(), true);
});

test('check-watch-rules without root says it could not look (NEEDS ROOT, exit 3), not PASS', () => {
  const w = world({ as: 501 });
  const r = w.run(['check-watch-rules']); assert.equal(r.code, 3); assert.match(r.text, /NEEDS ROOT/);
});

test('the hourly job: built from config, runs as orchestrate from the installed copy, once an hour, with the pinned hash and the draft rules', () => {
  const w = world();
  const text = watchPlist(w.mac, w.cfg);
  const P = `${BASE}/install/orchestrate`;
  for (const piece of [
    `<key>Label</key><string>${RAW.label}.watch-only</string>`, '<key>UserName</key><string>orchestrate</string>',
    `<string>${P}/bin/node</string><string>${P}/${WATCH_RUN}</string><string>once</string>`,
    `<string>--repo</string><string>${REPO}</string>`, `<string>--dir</string><string>${BASE}/watch</string>`,
    `<string>--token-file</string><string>${BASE}/keys/watch-only-token</string>`,
    `<string>--rules</string><string>draft</string><string>--rules-sha256</string><string>${HASH}</string>`,
    '<key>StartInterval</key><integer>3600</integer>',
  ]) assert.ok(text.includes(piece), piece);
  assert.ok(!text.includes('github_pat'));
  // The script it names is in this repository, at that path (a rename would leave the job running nothing).
  assert.equal(statSync(join(import.meta.dirname, '..', WATCH_RUN)).isFile(), true);
});

test('daemons: the watch-only job is a fourth job only with a watch entry; place writes its file exactly; check sees a changed one; load needs the rules first', () => {
  const w = world();
  assert.deepEqual(jobsFor(w.cfg), ['review-updater', 'review-account', 'review-runner', 'watch-only']);
  const { watch, ...noWatch } = RAW;
  assert.deepEqual(jobsFor(parseInstallConfig(noWatch)), ['review-updater', 'review-account', 'review-runner']);
  const texts = plistTexts(w.mac, w.cfg).plists; assert.ok(texts['watch-only']);
  const place = planPlace(w.mac, w.cfg); assert.deepEqual(place.problems, []);
  assert.equal(place.ops.filter((o) => /watch-only\.plist/.test(o.text)).length, 1);
  // PLANT: the watch job's file changed by hand → the "exactly the built job file" item for it FAILS.
  for (const o of place.ops) o.run();
  assert.deepEqual(failing(checkDaemons(w.mac, w.cfg)).filter((r) => /plist/.test(r.what)), []);
  const f = w.mac.at(`/Library/LaunchDaemons/${RAW.label}.watch-only.plist`);
  writeFileSync(f, readFileSync(f, 'utf8').replace('3600', '1')); chmodSync(f, 0o644);
  const bad = failing(checkDaemons(w.mac, w.cfg)).filter((r) => /watch-only\.plist/.test(r.what));
  assert.equal(bad.length, 1); assert.match(bad[0].why, /differs from what review-daemons\.mjs builds/);
});

test('PLANT daemons load: with a watch entry but no rules copy in place, load names the missing rules (caught by the rules clause in planLoad)', async () => {
  const { planLoad } = await import('./daemons.mjs');
  const w = world();
  assert.ok(planLoad(w.mac, w.cfg).problems.some((p) => /run watch-rules first/.test(p)));
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);
  assert.ok(!planLoad(w.mac, w.cfg).problems.some((p) => /run watch-rules first/.test(p)));
});

test('PLANT watch-rules: the watch folder owned by someone other than orchestrate is refused, nothing written (caught by the folder-owner clause)', () => {
  const w = world();
  const own = w.mac.owners.get(`${BASE}/watch`);
  w.mac.owners.set(`${BASE}/watch`, { ...own, uid: own.uid + 1 });
  const r = w.run(['watch-rules', '--rules-source', w.src]);
  assert.equal(r.code, 1); assert.match(r.text, /not orchestrate's own 0700 folder/);
  assert.throws(() => statSync(w.mac.at(watchRulesPath(w.cfg))));
});
