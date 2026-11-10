// Tests for setup part 4: the watch-only week's rules copy (watch-rules / check-watch-rules) and its hourly job.
// Same stand-in Mac as the other setup tests (fake-mac.test-helper.mjs). PLANT tests break one clause each and name the
// check that catches it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, fstatSync, linkSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT_CONFIG_PATH, folderTable, parseConfig, watchNotesPath, watchRulesPath } from './layout.mjs';
import { parseInstallConfig } from './install.mjs';
import { jobsFor, plistTexts, checkDaemons, placeSteps, planLoad, planUnload } from './daemons.mjs';
import { readConfigFile, realIo } from './mac.mjs';
import { readUser } from './users-folders.mjs';
import { checkRulesCopy, checkRulesHash, checkWatchAppConfig, checkWatchAppKey, checkWatchRules, planWatchApp, planWatchRules, watchAppKeyPath, watchConfigLine, watchPlist, WATCH_RUN } from './watch-setup.mjs';
import { main, parseArgs } from './setup.mjs';
import { parseArgs as watchRunArgs } from '../modules/M6-merge-gate/watch-run.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const BASE = '/Library/orch-test';
const RULES = 'version: 1\nlanes:\n  docs: { risky: false }\n';
const HASH = createHash('sha256').update(RULES).digest('hex');
const REPO = 'example-org/example-repo';
const APP = { id: '1234567', installation: '7654321', keyFile: 'watch-app-key' };   // L627: the read-only watcher App
const RAW = {
  base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: 'com.example.orch-test',
  runnerConfig: '/tmp/x/review.json', extras: [], watch: { repo: REPO, rulesSha256: HASH, app: APP },
};
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };

// This world has no install, so `daemons place` refuses on load's own checks (L807 M1; install.test.mjs plants them). The
// tests of what place writes run its steps after that gate: placeOnly → the steps' texts.
const placeOnly = (w, jobs) => { const p = placeSteps(w.mac, w.cfg, jobs); assert.deepEqual(p.problems, []); for (const o of p.ops) o.run(); return p.ops.map((o) => o.text).join('\n'); };

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
  const cfg0 = parseInstallConfig(raw);
  if (cfg0.watch?.app) {   // the watcher App's key, as the owner puts it in place: orchestrate's own 0600 file (never a real key)
    const k = watchAppKeyPath(cfg0); writeFileSync(mac.at(k), 'k'.repeat(1700)); chmodSync(mac.at(k), 0o600);
    const o = readUser(mac, 'orchestrate'); mac.owners.set(k, { uid: o.uid, gid: o.gid });
  }
  mac.as = as;
  return { mac, ext, src, raw, cfg: parseInstallConfig(raw), run };
}
const failing = (res) => res.filter((r) => !r.ok);

test('config: watch must be { repo, rulesSha256 }; anything else is refused; absent is fine', () => {
  assert.equal(parseConfig({ base: BASE, owner: 'sam', products: [] }).watch, undefined);
  assert.deepEqual(parseConfig(RAW).watch, { repo: REPO, rulesSha256: HASH, app: APP });
  assert.deepEqual(parseConfig({ ...RAW, watch: { repo: REPO } }).watch, { repo: REPO });   // L150 m4: the repo alone is a valid watch (prove-token needs it before the rules are in place)
  for (const bad of [{}, { rulesSha256: HASH }, { repo: REPO, rulesSha256: HASH.toUpperCase() }, { repo: REPO, rulesSha256: HASH.slice(1) }, { repo: 'no-slash', rulesSha256: HASH }, { repo: '../x/y', rulesSha256: HASH }, { repo: REPO, rulesSha256: HASH, extra: 1 }, [], 'x', null]) {
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
  assert.equal(d.run(['watch-rules']).code, 2);   // no file named: a usage error, never a guess
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
  const place = placeSteps(w.mac, w.cfg); assert.deepEqual(place.problems, []);
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

test('R3 MAT-6 the explanations folder is the owner\'s, readable by orchestrate and the summary, and every folder above it can be walked through (caught by: the exact folder-table check)', () => {
  const cfg = parseConfig(RAW);
  const rows = folderTable(cfg);
  const row = rows.find((r) => r.path === watchNotesPath(cfg));
  assert.ok(row, 'there is a folder for the explanations');
  assert.equal(row.owner, 'owner'); assert.equal(row.mode, 0o755);
  assert.notEqual(row.path, join(cfg.base, 'watch'), 'it is NOT inside the orchestrate-only watch folder');
  let dir = row.path;
  while (dir.startsWith(cfg.base)) {
    const r = rows.find((x) => x.path === dir);
    assert.ok(r && (r.mode & 0o005) === 0o005, `${dir} lets others read and walk through`);
    dir = join(dir, '..');
  }
});

// ---- the rules file is always named (L147): the print-config-line and the --only job option ----
test('watch-rules --print-config-line: prints the repo and the fingerprint of the named file; reads only; usable without root; works before the config has a watch entry', () => {
  const w = world({ as: 501 });
  const r = w.run(['watch-rules', '--print-config-line', '--repo', REPO, '--rules-source', w.src]);
  assert.equal(r.code, 0, r.text); assert.equal(r.text, `  "watch": { "repo": "${REPO}", "rulesSha256": "${HASH}" },`);
  const noWatch = { ...RAW }; delete noWatch.watch;
  const v = world({ raw: noWatch, as: 501 });
  assert.equal(v.run(['watch-rules', '--print-config-line', '--repo', REPO, '--rules-source', v.src]).text, r.text);
});

test('PLANT watch-rules: the rules file is REQUIRED and must be a full path — missing flag, relative path, missing file, empty file → refused, nothing written (fail closed)', () => {
  const w = world();
  assert.throws(() => parseArgs(['watch-rules']), /needs --rules-source/);
  assert.throws(() => parseArgs(['watch-rules', '--dry-run']), /needs --rules-source/);
  assert.throws(() => parseArgs(['watch-rules', '--print-config-line', '--repo', REPO]), /needs --rules-source/);
  const rel = w.run(['watch-rules', '--rules-source', 'rules.yaml']); assert.equal(rel.code, 1, rel.text); assert.match(rel.text, /must be the full path/);
  const gone = w.run(['watch-rules', '--rules-source', join(w.ext, 'nope.yaml')]); assert.equal(gone.code, 1, gone.text); assert.match(gone.text, /could not be read/);
  writeFileSync(join(w.ext, 'empty.yaml'), '');
  assert.match(w.run(['watch-rules', '--rules-source', join(w.ext, 'empty.yaml')]).text, /rules file is empty/);
  assert.throws(() => statSync(w.mac.at(watchRulesPath(parseConfig(RAW)))), /ENOENT/);
  // the same refusals for the printing command: nothing is printed
  for (const src of ['rules.yaml', join(w.ext, 'nope.yaml'), join(w.ext, 'empty.yaml')]) {
    const x = w.run(['watch-rules', '--print-config-line', '--repo', REPO, '--rules-source', src]); assert.equal(x.code, 1, x.text); assert.doesNotMatch(x.text, /rulesSha256/);
  }
  assert.match(w.run(['watch-rules', '--print-config-line', '--repo', 'no-slash', '--rules-source', w.src]).text, /owner\/name/);
  for (const bad of [['--print-config-line', '--rules-source', '/x'], ['--print-config-line', '--repo', REPO, '--rules-source', '/x', '--dry-run']]) assert.throws(() => parseArgs(['watch-rules', ...bad]), /print-config-line/);
  assert.throws(() => parseArgs(['check', '--print-config-line']), /only for watch-rules/);
  assert.throws(() => parseArgs(['check', '--repo', REPO]), /--repo is only for/);
});

test('daemons place --only <job>: places exactly that job; an unknown name is refused before anything runs; without --only all four, as before', () => {
  const w = world();
  const gated = w.run(['daemons', 'place', '--only', 'watch-only']); assert.equal(gated.code, 1, gated.text); assert.match(gated.text, /the install is not there yet/);
  const one = placeOnly(w, ['watch-only']);
  assert.match(one, /watch-only\.plist/); assert.doesNotMatch(one, /review-runner\.plist|review-updater\.plist|review-account\.plist/);
  const placed = (job) => { try { statSync(w.mac.at(`/Library/LaunchDaemons/${RAW.label}.${job}.plist`)); return true; } catch { return false; } };
  assert.deepEqual(jobsFor(w.cfg).filter(placed), ['watch-only']);
  for (const name of ['nope', 'review', '../x', '']) { const x = w.run(['daemons', 'place', '--only', name]); assert.equal(x.code, 2, name); assert.match(x.text, /--only names no job of this config/); }
  const noWatch = { ...RAW }; delete noWatch.watch;
  const nw = world({ raw: noWatch }); const y = nw.run(['daemons', 'place', '--only', 'watch-only']); assert.equal(y.code, 2); assert.match(y.text, /the jobs are review-updater, review-account, review-runner/);
  placeOnly(w);
  assert.deepEqual(jobsFor(w.cfg).filter(placed), jobsFor(w.cfg));
  assert.throws(() => parseArgs(['daemons', 'reload-account', '--only', 'watch-only']), /--only is only for/);
  assert.throws(() => parseArgs(['check', '--only', 'watch-only']), /--only is only for/);
});

test('daemons load / list / check --only <job>: only that job is considered (the other jobs\' missing files and not-loaded state are not reported)', () => {
  const w = world();
  placeOnly(w, ['watch-only']);
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);
  const ps = (jobs) => planLoad(w.mac, w.cfg, jobs).problems.join('\n');
  assert.doesNotMatch(ps(['watch-only']), /review-runner|review-updater|review-account/);   // its own problem here is only that no install exists
  assert.match(ps(undefined), /review-runner\.plist is not there/);                          // all jobs, as before
  const rep = checkDaemons(w.mac, w.cfg, ['watch-only']); assert.deepEqual(rep.map((r) => /watch-only/.test(r.what)), rep.map(() => true));
  assert.equal(checkDaemons(w.mac, w.cfg).length, 11);   // two of them say the two jobs with a user have their log files
  const l = w.run(['daemons', 'list', '--only', 'watch-only']); assert.equal(l.code, 0, l.text); assert.equal(l.text.trim().split('\n').length, 1);
  assert.equal(planUnload(w.mac, w.cfg, ['watch-only']).problems.length, 0);
});

test('L160 watch-rules reads the rules file safely, as root would: a link, a folder or an oversize file is refused, and no message shows a byte of the file', () => {
  const w = world(); const SECRET_LINE = 'zz-secret-rule-text';
  const hidden = join(w.ext, 'hidden.yaml'); writeFileSync(hidden, `${SECRET_LINE}\n`);
  const link = join(w.ext, 'link.yaml'); symlinkSync(hidden, link);
  const big = join(w.ext, 'big.yaml'); writeFileSync(big, `${SECRET_LINE}${'x'.repeat(70000)}`);
  for (const [src, why] of [[link, /rules file is a link/], [w.ext, /rules file is not a plain file/], [big, /rules file is far bigger/], [join(w.ext, 'none.yaml'), /rules file was not found/]]) {
    const r = w.run(['watch-rules', '--rules-source', src]); assert.equal(r.code, 1, `${src}: ${r.text}`);
    assert.match(r.text, why); assert.doesNotMatch(r.text, /zz-secret/);
    const p = w.run(['watch-rules', '--print-config-line', '--repo', REPO, '--rules-source', src]); assert.equal(p.code, 1, r.text); assert.doesNotMatch(p.text, /zz-secret/);
  }
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);   // the owner of the file is not judged: a plain file of anyone's is fine
});

test('R6 M-1 / L173 the config may name only the repository (prove-token needs just that): the three review jobs are exactly as before, the watch job is not built, and every watch command says so plainly', () => {
  const rawNo = { ...RAW }; delete rawNo.watch;
  const w = world({ raw: { ...RAW, watch: { repo: REPO } } }); const base = world({ raw: rawNo });
  assert.deepEqual(jobsFor(w.cfg), ['review-updater', 'review-account', 'review-runner']);                                   // R6A
  const t = plistTexts(w.mac, w.cfg); assert.equal(t.plists['watch-only'], undefined); assert.deepEqual(t.problems, []);
  const place = placeOnly(w);                                                                                                // R6B
  assert.doesNotMatch(place, /watch-only|undefined/);
  const placed = (job) => { try { statSync(w.mac.at(`/Library/LaunchDaemons/${RAW.label}.${job}.plist`)); return true; } catch { return false; } };
  assert.deepEqual(['review-updater', 'review-account', 'review-runner', 'watch-only'].filter(placed), ['review-updater', 'review-account', 'review-runner']);
  assert.equal(planLoad(w.mac, w.cfg).problems.some((x) => /watch|rules/.test(x)), false);                                   // R6C: review jobs are not held up by the watch rules
  assert.equal(checkDaemons(w.mac, w.cfg).length, checkDaemons(base.mac, base.cfg).length);                                 // R6D: the check has exactly the items it had before #86
  assert.equal(checkDaemons(w.mac, w.cfg).some((r) => /watch/.test(r.what)), false);
  const wr = w.run(['watch-rules', '--rules-source', w.src]); assert.equal(wr.code, 1, wr.text); assert.match(wr.text, /no rulesSha256 yet/);   // R6E: refused, not thrown
  assert.doesNotMatch(wr.text, /undefined|TypeError|THREW/);
  const dr = w.run(['watch-rules', '--rules-source', w.src, '--dry-run']); assert.equal(dr.code, 1, dr.text); assert.match(dr.text, /no rulesSha256 yet/);
  const ck = w.run(['check-watch-rules']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, /FAIL .*no rulesSha256 yet/); assert.doesNotMatch(ck.text, /undefined/);
  // --only watch-only says the same, instead of "no such job"
  for (const sub of ['place', 'load', 'unload', 'list', 'check']) { const x = w.run(['daemons', sub, '--only', 'watch-only']); assert.equal(x.code, 2, `${sub}: ${x.text}`); assert.match(x.text, /no rulesSha256 yet/); }
  assert.equal(w.run(['watch-rules', '--print-config-line', '--repo', REPO, '--rules-source', w.src]).code, 0, 'the line that fixes it can still be printed');
  // and the job builder itself refuses (a caller that skips jobsFor)
  assert.throws(() => watchPlist(w.mac, w.cfg), /no rulesSha256 yet/);
});

test('R6 class check: every reader of watch.* in setup code is either the repo (always there) or gated on the fingerprint', () => {
  // The config shape is the only door: `watch.repo` is required wherever `watch` exists, `rulesSha256` optional. This pins the optional one.
  const cfg = parseInstallConfig({ ...RAW, watch: { repo: REPO } });
  assert.equal(cfg.watch.rulesSha256, undefined); assert.equal(cfg.watch.repo, REPO);
  assert.deepEqual(planWatchRules(world().mac, cfg, { source: '/x', readSource: () => 'x' }).problems.length, 1);
  assert.equal(failing(checkWatchRules(world().mac, cfg)).length, 1);
});

test('r7 c-C class check: the setup code reads cfg.watch in exactly these places (a new reader must be gated on the fingerprint, then added here)', () => {
  const at = {};
  const here = new URL('.', import.meta.url);
  for (const f of readdirSync(here).filter((x) => x.endsWith('.mjs') && !x.includes('.test'))) {   // every setup file, so a new one is covered too
    const n = (readFileSync(new URL(`./${f}`, here), 'utf8').match(/cfg\.watch\b/g) ?? []).length;   // each read, not each line
    if (n) at[f] = n;
  }
  assert.deepEqual(at, { 'daemons.mjs': 4, 'extras.mjs': 1, 'watch-setup.mjs': 22 });   // +6 (L627): the App's key path, the job's three App arguments and check-watch-rules' key check, each reached only past the fingerprint gate; +3 (L633): checkRulesHash, which reads only the fingerprint itself; +2 (L707 M1): proveWatchAppChecks reads only watch.repo (always there), and only once the App is named
});

test('R6 m-1 a named pipe given as the rules file is refused at once, not waited on', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir('orch-fifo-'); const fifo = join(dir, 'rules.fifo');
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  const macUrl = new URL('./mac.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readConfigFile } from ${JSON.stringify(macUrl)}; try { readConfigFile(${JSON.stringify(fifo)}, { what: 'the rules file' }); console.log('READ'); } catch (e) { console.log(e.message); }`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.error, undefined, 'the read did not hang'); assert.match(r.stdout, /rules file is not a plain file/);
});

test('R6 m-2 a file that grew after the size check is refused by the bytes actually read, not read to its end', () => {
  const dir = tempDir('orch-grow-'); const f = join(dir, 'rules.yaml'); writeFileSync(f, 'x'.repeat(200000));
  const lying = (fd) => ({ ...fstatSync(fd), isFile: () => true, size: 100 });   // what the size check saw, before the file grew
  assert.throws(() => readConfigFile(f, { what: 'the rules file', fstat: lying }), /rules file is far bigger/);
  writeFileSync(f, 'ok\n'); assert.equal(readConfigFile(f, { what: 'the rules file', fstat: lying }), 'ok\n');
});

test('R6 m-3 the rules copy is written through writeOwned: owner and mode are set on the open handle, and the name is not reopened afterwards', () => {
  const w = world(); const dest = watchRulesPath(w.cfg);
  const r = w.run(['watch-rules', '--rules-source', w.src]); assert.equal(r.code, 0, r.text);
  assert.ok(w.mac.log.includes(`write ${dest}`), 'written');
  assert.ok(!(w.mac.reopened ?? []).includes(dest), 'the name was reopened to chown it (a swapped-in hard link would be chowned)');
  assert.equal(failing(checkWatchRules(w.mac, w.cfg)).length, 0);
});

test('R6 m-5 the real Mac\'s readRules is the safe single-handle read: a link and a folder are refused, a plain file of anyone\'s is read', () => {
  const dir = tempDir('orch-realrules-'); const f = join(dir, 'r.yaml'); writeFileSync(f, 'a: 1\n'); symlinkSync(f, join(dir, 'l.yaml'));
  const io = realIo();
  assert.equal(io.readRules(f), 'a: 1\n');
  assert.throws(() => io.readRules(join(dir, 'l.yaml')), /rules file is a link/);
  assert.throws(() => io.readRules(dir), /rules file is not a plain file/);
  assert.throws(() => io.readRules(join(dir, 'none')), /rules file was not found/);
  writeFileSync(join(dir, 'big'), 'x'.repeat(70000)); assert.throws(() => io.readRules(join(dir, 'big')), /far bigger/);
});

test('R6 c-1 the fingerprint is of the UTF-8 text: the README says so', () => {
  assert.match(readFileSync(new URL('./README.md', import.meta.url), 'utf8'), /fingerprint is of the UTF-8 text/);
});

// ---- L181 (r7 follow-ups): m-A hourly job the config stopped naming; m-B a folder at the copy's name; m-C swapped name between lstat and read
import { list } from './daemons.mjs';
import { mkdirSync, readdirSync } from 'node:fs';

test('L181 m-A: the config loses its fingerprint (or its watch entry) while the hourly job is loaded: unload, list and check still see it', () => {
  const w = world({});
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);
  placeOnly(w);
  const wl = `${RAW.label}.watch-only`;
  w.mac.loaded.set(wl, { state: 'running', pid: 4100, ageS: 5, lastExit: '0' });
  for (const raw of [{ ...RAW, watch: { repo: REPO } }, (() => { const r = { ...RAW }; delete r.watch; return r; })()]) {
    const cfg = parseInstallConfig(raw);
    assert.ok(planUnload(w.mac, cfg).ops.some((o) => o.text.includes(wl)), 'unload plans a bootout of the hourly job');
    assert.ok(list(w.mac, cfg).some((j) => j.label === wl), 'list shows the still-loaded hourly job');
    assert.ok(checkDaemons(w.mac, cfg).some((r) => /watch-only/.test(r.what + (r.why ?? '')) && !r.ok), 'check FAILs on a watch-only job the config no longer names');
  }
});

test('L181 m-B: a folder at the rules copy\'s name stops the step; nothing inside it is deleted', () => {
  const w = world({});
  const cfg = parseInstallConfig(RAW); const dest = w.mac.at(watchRulesPath(cfg));
  rmSync(dest, { force: true }); mkdirSync(dest); writeFileSync(join(dest, 'keep.txt'), 'x');
  const r = w.run(['watch-rules', '--rules-source', w.src]);
  assert.notEqual(r.code, 0, r.text);
  assert.equal(readFileSync(join(dest, 'keep.txt'), 'utf8'), 'x');
});

test('L181 m-C: check-watch-rules reads one handle: a name swapped to a link or a FIFO between lstat and read is not a PASS (and does not hang)', () => {
  for (const kind of ['link', 'fifo']) {
    const w = world({});
    assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);
    const cfg = parseInstallConfig(RAW); const dest = watchRulesPath(cfg);
    const other = join(tempDir('orch-l181-other-'), 'other.txt'); writeFileSync(other, RULES);
    const lstat = w.mac.lstat.bind(w.mac); let swapped = false;
    w.mac.lstat = (p) => { const st = lstat(p); if (p === dest && !swapped) { swapped = true; rmSync(w.mac.at(dest)); spawnSync(kind === 'link' ? '/bin/ln' : '/usr/bin/mkfifo', kind === 'link' ? ['-s', other, w.mac.at(dest)] : [w.mac.at(dest)]); } return st; };
    const res = checkWatchRules(w.mac, cfg);
    assert.equal(res[0].ok, false, `${kind}: ${JSON.stringify(res)}`);
  }
});

// ───────────────────────────── L194 ─────────────────────────────

test('L194 m3 PLANT one owner/name check: print-config-line prints a line for exactly the names the config loader takes', () => {
  const names = ['example-org/example-repo', 'a/b', 'acme/.github', '.x/y', 'x/.y', 'o/' + 'n'.repeat(100), 'o/' + 'n'.repeat(101), 'o'.repeat(101) + '/n', 'x/..', './y', 'no-slash', 'a/b/c', 'a /b', '', 'a/'];
  for (const repo of names) {
    let loads = true; try { parseConfig({ ...RAW, watch: { repo } }); } catch { loads = false; }
    const r = watchConfigLine({}, { repo, source: '/x', readSource: () => RULES });
    assert.equal(Boolean(r.line), loads, `${JSON.stringify(repo)}: print-config-line ${r.line ? 'prints a line' : 'refuses'}, the config loader ${loads ? 'takes' : 'refuses'} it`);
    if (r.line) assert.deepEqual(parseConfig({ ...RAW, ...JSON.parse(`{${r.line.trim().replace(/,$/, '')}}`) }).watch, { repo, rulesSha256: HASH });
    let runs = true; try { watchRunArgs(['once', '--repo', repo, '--dir', '/d', '--token-file', '/t', '--rules', 'draft', '--rules-sha256', HASH]); } catch (e) { runs = false; if (!/--repo must be owner\/name|--repo is required/.test(e.message)) throw e; }
    assert.equal(runs, loads, `${JSON.stringify(repo)}: the hourly job (watch-run) ${runs ? 'takes' : 'refuses'} it, the config loader ${loads ? 'takes' : 'refuses'} it (L203 m-B)`);
  }
});

test('L194 PLANT the rules copy must be root:wheel: a copy in another group FAILS the check, and watch-rules puts it right (not "nothing to do")', () => {
  const w = world(); assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);
  const p = watchRulesPath(w.cfg); w.mac.owners.set(p, { uid: w.mac.rootUid, gid: 20 });
  assert.match(failing(checkWatchRules(w.mac, w.cfg))[0].why, /group is gid 20, not wheel/);
  const r = w.run(['watch-rules', '--rules-source', w.src]); assert.equal(r.code, 0, r.text); assert.doesNotMatch(r.text, /nothing to do/);
  assert.deepEqual(w.mac.owners.get(p), { uid: w.mac.rootUid, gid: 0 });
  assert.deepEqual(failing(checkWatchRules(w.mac, w.cfg)), []);
});

// ---- L627: the watch job reads check runs as the read-only watcher App (L624's three arguments, all or none)

test('L627 config: watch.app is exactly { id, installation, keyFile }, digits for the ids and a bare file name for the key', () => {
  assert.deepEqual(parseConfig(RAW).watch.app, APP);
  assert.equal(parseConfig({ ...RAW, watch: { repo: REPO, rulesSha256: HASH } }).watch.app, undefined);
  const bad = [
    { id: APP.id, installation: APP.installation },                                   // a key missing
    { ...APP, extra: 'x' },                                                          // a key too many
    { ...APP, id: 1234567 }, { ...APP, id: '' }, { ...APP, id: '0123' }, { ...APP, installation: '12a' },
    { ...APP, keyFile: '/abs/key' }, { ...APP, keyFile: '../key' }, { ...APP, keyFile: 'a/b' }, { ...APP, keyFile: '..' }, { ...APP, keyFile: '' }, { ...APP, keyFile: '.hidden' },
    null, [], 'x',
  ];
  for (const app of bad) assert.throws(() => parseConfig({ ...RAW, watch: { repo: REPO, rulesSha256: HASH, app } }), /watch\.app/, JSON.stringify(app));
});

test('L627 job: with an App, the hourly job passes all three arguments, the key in the keys folder, and watch-run accepts them', () => {
  const w = world();
  const text = watchPlist(w.mac, w.cfg);
  const key = `${BASE}/keys/${APP.keyFile}`;
  assert.equal(watchAppKeyPath(w.cfg), key);
  assert.ok(text.includes(`<string>--app-id</string><string>${APP.id}</string><string>--app-installation</string><string>${APP.installation}</string><string>--app-key-file</string><string>${key}</string>`), text);
  const args = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const once = args.slice(args.indexOf('once'));
  const end = once.indexOf(key) + 1; assert.ok(end > 0);
  const o = watchRunArgs(once.slice(0, end));
  assert.equal(o.appId, APP.id); assert.equal(o.appInstallation, APP.installation); assert.equal(o.appKeyFile, key);
  assert.ok(!text.includes('k'.repeat(40)), 'the key text never goes in the job file');
});

test('L627 job: with no App in the config, none of the three arguments (watch-run refuses one or two of them)', () => {
  const raw = { ...RAW, watch: { repo: REPO, rulesSha256: HASH } };
  const w = world({ raw });
  const text = watchPlist(w.mac, w.cfg);
  for (const a of ['--app-id', '--app-installation', '--app-key-file']) assert.ok(!text.includes(a), a);
});

test('L627 check: the watcher App key is orchestrate\'s own plain 0600 file of a key\'s size; never read', () => {
  const w = world(); w.run(['watch-rules', '--rules-source', w.src]);
  assert.deepEqual(failing(checkWatchRules(w.mac, w.cfg)), []);
  assert.equal(w.run(['check-watch-rules']).code, 0);
  assert.deepEqual(failing(checkWatchAppKey(w.mac, w.cfg)), []);
});

test('PLANT L627 check: no App named, mode 644, a wrong owner, a link, a second name, a wrong size, an access list, and a missing key each FAIL', () => {
  const w = world(); w.run(['watch-rules', '--rules-source', w.src]);
  const k = watchAppKeyPath(w.cfg); const f = w.mac.at(k);
  const why = () => failing(checkWatchRules(w.mac, w.cfg)).map((r) => r.why).join(' | ');
  const noApp = parseInstallConfig({ ...RAW, watch: { repo: REPO, rulesSha256: HASH } });
  assert.match(failing(checkWatchRules(w.mac, noApp)).map((r) => r.why).join(' | '), /no "app"/);
  chmodSync(f, 0o644); assert.match(why(), /mode is 644/); chmodSync(f, 0o600);
  const own = w.mac.owners.get(k);
  w.mac.owners.set(k, { ...own, uid: own.uid + 1 }); assert.match(why(), /not orchestrate/); w.mac.owners.set(k, own);
  const body = readFileSync(f);
  writeFileSync(f, 'k'.repeat(50)); assert.match(why(), /size is not a key/); writeFileSync(f, body);
  const second = `${f}-second`; linkSync(f, second); assert.match(why(), /second name/); rmSync(second);
  assert.equal(w.mac.run('/bin/chmod', ['+a', 'everyone allow read', f]).status, 0); assert.match(why(), /access list/);
  rmSync(f); writeFileSync(f, body); chmodSync(f, 0o600);
  rmSync(f); symlinkSync(w.src, f); assert.match(why(), /not a plain file/);
  rmSync(f); assert.match(why(), /missing/);
  writeFileSync(f, body); chmodSync(f, 0o600); assert.deepEqual(failing(checkWatchRules(w.mac, w.cfg)), []);
});

test('L627 check without root: the key check is skipped as NEEDS ROOT, never a pass', () => {
  const w = world({ as: 501 });
  const r = checkWatchAppKey(w.mac, w.cfg); assert.equal(r.length, 1); assert.equal(r[0].skip, true);
});

// ---- L630: watch-app names the watcher App in root's config, so no one edits that file by hand

const NOAPP = { ...RAW, watch: { repo: REPO, rulesSha256: HASH } };
/** A world whose root config has no App yet, and the App's key already in the keys folder. `raw()` reads root's config back. */
function appWorld() {
  const w = world({ raw: NOAPP });
  assert.equal(w.run(['watch-rules', '--rules-source', w.src]).code, 0);   // the rules copy in place, as the week has it
  const k = watchAppKeyPath(parseInstallConfig(RAW)); writeFileSync(w.mac.at(k), 'k'.repeat(1700)); chmodSync(w.mac.at(k), 0o600);
  const o = readUser(w.mac, 'orchestrate'); w.mac.owners.set(k, { uid: o.uid, gid: o.gid });
  const f = w.mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(NOAPP)); chmodSync(f, 0o644);
  const go = (args) => { const s = sink(); const code = main(args, { io: w.mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') }; };   // root's config as it is now, not rewritten
  return { ...w, key: k, f, go, raw: () => JSON.parse(readFileSync(f, 'utf8')) };
}
const APPARGS = ['--app-id', APP.id, '--app-installation', APP.installation, '--app-key-name', APP.keyFile];

test('L630 watch-app: a dry run changes nothing; the run adds watch.app and keeps every other entry; a second run does nothing; the job then carries the App', () => {
  const w = appWorld(); const before = readFileSync(w.f, 'utf8');
  const dry = w.go(['watch-app', ...APPARGS, '--dry-run']); assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /would run: write .*orchestrate-setup\.json\.new \(root:wheel 0644\): the config with watch\.app = App 1234567, installation 7654321, key .*keys\/watch-app-key/);
  assert.match(dry.text, /would run: rename /); assert.equal(readFileSync(w.f, 'utf8'), before);
  const r = w.go(['watch-app', ...APPARGS]); assert.equal(r.code, 0, r.text); assert.match(r.text, /done: all 3 items PASS/);
  assert.deepEqual(w.raw(), { ...NOAPP, watch: { ...NOAPP.watch, app: APP } });
  const st = statSync(w.f); assert.equal(st.mode & 0o7777, 0o644);
  assert.throws(() => statSync(`${w.f}.new`), 'no file left beside the config');
  const again = w.go(['watch-app', ...APPARGS]); assert.equal(again.code, 0); assert.match(again.text, /nothing to do/);
  assert.match(watchPlist(w.mac, parseInstallConfig(w.raw())), /<string>--app-id<\/string><string>1234567<\/string>/);
  assert.deepEqual(failing(checkWatchRules(w.mac, parseInstallConfig(w.raw()))).filter((x) => /watch-app-key/.test(x.what)), []);
});

test('PLANT L630 watch-app refuses, changing nothing: the key not in place, a bad id, a key name with a slash, no watch entry', () => {
  const w = appWorld(); const before = readFileSync(w.f, 'utf8');
  rmSync(w.mac.at(w.key));
  let r = w.go(['watch-app', ...APPARGS]); assert.equal(r.code, 1); assert.match(r.text, /the key is not in place.*missing/);
  writeFileSync(w.mac.at(w.key), 'k'.repeat(1700)); chmodSync(w.mac.at(w.key), 0o644);
  r = w.go(['watch-app', ...APPARGS]); assert.equal(r.code, 1); assert.match(r.text, /the key is not in place.*mode is 644/); chmodSync(w.mac.at(w.key), 0o600);
  r = w.go(['watch-app', '--app-id', 'x1', '--app-installation', APP.installation, '--app-key-name', APP.keyFile]); assert.equal(r.code, 1); assert.match(r.text, /watch\.app\.id/);
  r = w.go(['watch-app', '--app-id', APP.id, '--app-installation', APP.installation, '--app-key-name', '../k']); assert.equal(r.code, 1); assert.match(r.text, /keyFile must be a bare file name/);
  assert.equal(readFileSync(w.f, 'utf8'), before);
  const plain = { ...RAW }; delete plain.watch; writeFileSync(w.f, JSON.stringify(plain));
  r = w.go(['watch-app', ...APPARGS]); assert.equal(r.code, 1); assert.match(r.text, /no "watch" entry/);
});

test('L630 watch-app: all three flags or none; the flags belong to watch-app only; without root the real run is refused', () => {
  assert.throws(() => parseArgs(['watch-app', '--app-id', '1', '--app-installation', '2']), /needs all three/);
  assert.throws(() => parseArgs(['watch-app']), /needs all three/);
  assert.throws(() => parseArgs(['check-watch-rules', ...APPARGS]), /only for watch-app/);
  const w = appWorld(); const before = readFileSync(w.f, 'utf8');
  w.mac.as = 501;
  const s = sink(); const code = main(['watch-app', ...APPARGS, '--config', w.f], { io: w.mac, out: s.out, err: s.err });
  assert.equal(code, 2, s.lines.join('\n')); assert.match(s.lines.join('\n'), /refused/); assert.equal(readFileSync(w.f, 'utf8'), before);
});

test('PLANT L630 watch-app: the config changed after the plan → the run stops before it writes, and the change is kept', () => {
  const w = appWorld();
  const cfg = parseInstallConfig(NOAPP); const text = readFileSync(w.f, 'utf8');
  const plan = planWatchApp(w.mac, cfg, { raw: NOAPP, text, app: APP });
  assert.deepEqual(plan.problems, []); assert.equal(plan.ops.length, 3);
  const edited = JSON.stringify({ ...NOAPP, extras: ['edited'] }); writeFileSync(w.f, edited);
  assert.throws(() => { for (const o of plan.ops) o.run(); }, /changed after this plan was made/);
  assert.equal(readFileSync(w.f, 'utf8'), edited);
});

test('L630 watch-app: a different App already named is replaced, and the step says which it named', () => {
  const w = appWorld();
  writeFileSync(w.f, JSON.stringify({ ...NOAPP, watch: { ...NOAPP.watch, app: { ...APP, id: '999' } } }));
  const dry = w.go(['watch-app', ...APPARGS, '--dry-run']); assert.match(dry.text, /\(it named App 999\)/);
  assert.equal(w.go(['watch-app', ...APPARGS]).code, 0); assert.equal(w.raw().watch.app.id, APP.id);
});

test('PLANT L630 watch-app read-back: a config that does not name this App FAILs, so a run that did not land never says PASS', () => {
  const w = appWorld();
  const bad = failing(checkWatchAppConfig(w.mac, parseInstallConfig(NOAPP), APP)); assert.match(bad[0].what, /names the watcher App/); assert.match(bad[0].why, /does not name it/);
  writeFileSync(w.f, JSON.stringify({ ...NOAPP, watch: { ...NOAPP.watch, app: { ...APP, installation: '1' } } }));
  assert.match(failing(checkWatchAppConfig(w.mac, parseInstallConfig(NOAPP), APP))[0].why, /does not name it/);
});

test('L630 watch-app: a file a cut-off run left beside the config is replaced, and a link there is removed, never followed', () => {
  const w = appWorld();
  writeFileSync(`${w.f}.new`, 'half');
  assert.equal(w.go(['watch-app', ...APPARGS]).code, 0); assert.equal(w.raw().watch.app.id, APP.id);
  const w2 = appWorld(); const victim = join(w2.ext, 'victim'); writeFileSync(victim, 'keep');
  symlinkSync(victim, `${w2.f}.new`);
  assert.equal(w2.go(['watch-app', ...APPARGS]).code, 0); assert.equal(readFileSync(victim, 'utf8'), 'keep');
});

// ---- L633: watch-app --rules-sha256 brings a re-pin made only in the job file back into root's config

const RULES2 = 'version: 1\nlanes:\n  docs: { risky: true }\n';
const HASH2 = createHash('sha256').update(RULES2).digest('hex');
/** The rules copy swapped as a job-file-only re-pin leaves it: root:wheel 0644, the new text. */
const repinCopy = (w) => { const p = watchRulesPath(w.cfg); const f = w.mac.at(p); rmSync(f); writeFileSync(f, RULES2); chmodSync(f, 0o644); w.mac.owners.set(p, { uid: w.mac.rootUid, gid: 0 }); };

test('L633 watch-app --rules-sha256: the config takes the pin of the rules copy in place; the job built from it judges by that copy', () => {
  const w = appWorld(); repinCopy(w);
  const dry = w.go(['watch-app', ...APPARGS, '--rules-sha256', HASH2, '--dry-run']); assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, new RegExp(`rules pin ${HASH2.slice(0, 12)}… \\(it was ${HASH.slice(0, 12)}…\\)`));
  const r = w.go(['watch-app', ...APPARGS, '--rules-sha256', HASH2]); assert.equal(r.code, 0, r.text); assert.match(r.text, /done: all 3 items PASS/);
  assert.deepEqual(w.raw(), { ...NOAPP, watch: { ...NOAPP.watch, rulesSha256: HASH2, app: APP } });
  assert.match(watchPlist(w.mac, parseInstallConfig(w.raw())), new RegExp(`<string>--rules-sha256</string><string>${HASH2}</string>`));
  assert.match(w.go(['watch-app', ...APPARGS, '--rules-sha256', HASH2]).text, /nothing to do/);
});

test('PLANT L633 watch-app --rules-sha256: a pin the rules copy does not hash to is refused, changing nothing; the same App with a new pin is not "nothing to do"', () => {
  const w = appWorld(); const before = readFileSync(w.f, 'utf8');
  const r = w.go(['watch-app', ...APPARGS, '--rules-sha256', HASH2]); assert.equal(r.code, 1); assert.match(r.text, /rules copy in place does not match.*hashes to .*the pin is/);
  assert.equal(readFileSync(w.f, 'utf8'), before);
  assert.equal(w.go(['watch-app', ...APPARGS]).code, 0);
  repinCopy(w);
  const again = w.go(['watch-app', ...APPARGS, '--rules-sha256', HASH2]); assert.equal(again.code, 0, again.text); assert.doesNotMatch(again.text, /nothing to do/);
  assert.equal(w.raw().watch.rulesSha256, HASH2);
});

test('L633 --rules-sha256: 64 hex only, and only for watch-app; the read-back FAILs on a config whose pin is not the one given', () => {
  for (const bad of ['', 'abc', HASH.toUpperCase(), `${HASH}0`]) assert.throws(() => parseArgs(['watch-app', ...APPARGS, '--rules-sha256', bad]), /64-hex/);
  assert.throws(() => parseArgs(['check-watch-rules', '--rules-sha256', HASH]), /only for watch-app/);
  const w = appWorld(); assert.equal(w.go(['watch-app', ...APPARGS]).code, 0);
  assert.match(failing(checkWatchAppConfig(w.mac, parseInstallConfig(NOAPP), APP, HASH2))[0].why, /does not name it/);
});

test('L633 watch-app --rules-sha256 on a hand re-pinned Mini: the copy is orchestrate\'s 600 at the new pin; watch-app takes the pin (the hash alone is judged), then watch-rules makes the copy root\'s 0644 and check-watch-rules passes', () => {
  const w = appWorld(); repinCopy(w);
  const p = watchRulesPath(w.cfg); const o = readUser(w.mac, 'orchestrate'); chmodSync(w.mac.at(p), 0o600); w.mac.owners.set(p, { uid: o.uid, gid: o.gid });
  assert.match(failing(checkRulesCopy(w.mac, { ...w.cfg, watch: { ...w.cfg.watch, rulesSha256: HASH2 } }))[0].why, /owner is uid .*mode is 600/);
  const r = w.go(['watch-app', ...APPARGS, '--rules-sha256', HASH2]); assert.equal(r.code, 0, r.text); assert.match(r.text, /done: all 3 items PASS/);
  const src = join(w.ext, 'rules2.yaml'); writeFileSync(src, RULES2);
  const wr = w.go(['watch-rules', '--rules-source', src]); assert.equal(wr.code, 0, wr.text); assert.match(wr.text, /write .*rules-draft\.yaml\s+\(root:wheel 0644/);
  const c = w.go(['check-watch-rules']); assert.equal(c.code, 0, c.text);
});

test('PLANT L633 the hash check: a link, a folder, a missing copy and a non-root look are each told; the owner and mode are not judged', () => {
  const w = appWorld(); const cfg2 = { ...w.cfg, watch: { ...w.cfg.watch, rulesSha256: HASH } };
  assert.equal(checkRulesHash(w.mac, cfg2)[0].ok, true);
  const p = watchRulesPath(w.cfg); const f = w.mac.at(p);
  chmodSync(f, 0o600); assert.equal(checkRulesHash(w.mac, cfg2)[0].ok, true); chmodSync(f, 0o644);
  assert.match(checkRulesHash(w.mac, { ...cfg2, watch: { ...cfg2.watch, rulesSha256: HASH2 } })[0].why, /the pin is/);
  const keep = `${f}.keep`; renameSync(f, keep); symlinkSync(keep, f); assert.match(checkRulesHash(w.mac, cfg2)[0].why, /not a plain file/);
  rmSync(f); assert.match(checkRulesHash(w.mac, cfg2)[0].why, /missing/);
  mkdirSync(f); assert.equal(checkRulesHash(w.mac, cfg2)[0].why, 'is not a plain file', 'told by the check itself, before any read'); rmSync(f, { recursive: true }); renameSync(keep, f);
  w.mac.as = 501; const look = checkRulesHash(w.mac, cfg2)[0]; assert.equal(look.skip, true); assert.match(look.why, /needs root/);
});
