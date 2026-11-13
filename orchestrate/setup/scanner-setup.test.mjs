// Tests for the secret scanner's setup step (L1083): `scanner --from` and `check-scanner`. Same stand-in Mac as the other
// setup tests (fake-mac.test-helper.mjs). The real gitleaks program is not in this repository, so the tests pin a stand-in
// program's hash through the `binSha` port; the commands' own refusals of a wrong program run with the real pin.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT_CONFIG_PATH, parseConfig, scannerDir, scannerPaths } from './layout.mjs';
import { rootMadeEntries } from './install.mjs';
import { check } from './users-folders.mjs';
import { SCANNER_BIN_SHA256, SCANNER_TARBALL_SHA256, SCANNER_VERSION, checkScannerFiles, checkScannerSetup, planScanner } from './scanner-setup.mjs';
import { main, parseArgs } from './setup.mjs';
import { DO_PLANE_TOML, RULES_VERSION, checkScanner } from '../modules/M4-workshop/git/gitleaks.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const BASE = '/Library/orch-test';
const RAW = { base: BASE, owner: 'sam', products: ['alpha'] };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };
// A stand-in gitleaks: answers `version` with what its mode file says.
const program = (version = '8.30.1') => `#!${process.execPath}\nif (process.argv[2] === 'version') { console.log(${JSON.stringify(version)}); process.exit(0); }\nprocess.exit(9);\n`;

function world({ version } = {}) {
  const mac = fakeMac({ euid: 0 });
  const ext = tempDir('orch-scanner-setup-');
  const from = join(ext, 'gitleaks'); writeFileSync(from, program(version)); chmodSync(from, 0o755);
  const run = (args, { as = 0 } = {}) => {
    mac.as = as;
    const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(RAW)); chmodSync(f, 0o644);
    const cfgFile = join(ext, 'c.json'); writeFileSync(cfgFile, JSON.stringify(RAW));
    const s = sink(); const r = main(as === 0 ? args : [...args, '--config', cfgFile], { io: mac, out: s.out, err: s.err });
    return Promise.resolve(r).then((code) => ({ code, text: s.lines.join('\n') }));
  };
  const f = mac.at(ROOT_CONFIG_PATH); writeFileSync(f, JSON.stringify(RAW)); chmodSync(f, 0o644);
  const s = sink(); assert.equal(main(['users-folders'], { io: mac, out: s.out, err: s.err }), 0, s.lines.join('\n'));
  return { mac, ext, from, run, cfg: parseConfig(RAW), pin: sha(readFileSync(from)) };
}
// The plan, run as `main` would after its wall: every op in order.
const applyPlan = (w, opts = {}) => { const p = planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin, ...opts }); assert.deepEqual(p.problems, []); for (const o of p.ops) o.run(); return p; };
const failing = (rows) => rows.filter((r) => !r.ok);

test('L1083 the paths: one folder under the base, three files, named once (layout.mjs) and in the shape the push step takes', () => {
  const cfg = parseConfig(RAW);
  assert.equal(scannerDir(cfg), `${BASE}/scanner`);
  assert.deepEqual({ ...scannerPaths(cfg) }, { bin: `${BASE}/scanner/gitleaks`, config: `${BASE}/scanner/gitleaks.toml`, ignoreFile: `${BASE}/scanner/gitleaksignore` });
  assert.ok(rootMadeEntries(cfg).includes(scannerDir(cfg)), 'check does not call the scanner folder a stranger');
  assert.equal(SCANNER_VERSION, RULES_VERSION, 'the program pin and the vendored rules are one version');
  assert.match(SCANNER_BIN_SHA256, /^[0-9a-f]{64}$/); assert.match(SCANNER_TARBALL_SHA256, /^[0-9a-f]{64}$/);
});

test('L1083 the args: scanner needs --from; --from is for bob and scanner only; check-scanner is read only', () => {
  assert.throws(() => parseArgs(['scanner']), /scanner needs --from/);
  assert.equal(parseArgs(['scanner', '--from', '/x/gitleaks']).from, '/x/gitleaks');
  assert.throws(() => parseArgs(['check', '--from', '/x/gitleaks']), /--from is only for bob and scanner/);
  assert.throws(() => parseArgs(['scanner', '--from', '/x', '--commit', 'a'.repeat(40)]), /--commit is only for bob/);
  assert.throws(() => parseArgs(['check-scanner', '--dry-run']), /never changes anything/);
});

test('L1083 scanner: puts the program, the Do-plane config and the empty ignore file in place, root:wheel; again is nothing to do', async () => {
  const w = world();
  const p = applyPlan(w);
  assert.equal(p.ops.length, 4, p.ops.map((o) => o.text).join('\n'));
  const P = scannerPaths(w.cfg);
  assert.deepEqual(readFileSync(w.mac.at(P.bin)), readFileSync(w.from));
  assert.equal(readFileSync(w.mac.at(P.config), 'utf8'), DO_PLANE_TOML);
  assert.equal(readFileSync(w.mac.at(P.ignoreFile), 'utf8'), '');
  for (const [f, mode] of [[scannerDir(w.cfg), 0o755], [P.bin, 0o755], [P.config, 0o644], [P.ignoreFile, 0o644]]) {
    const st = w.mac.lstat(f); assert.equal(st.uid, w.mac.rootUid, f); assert.equal(st.gid, 0, f); assert.equal(st.mode & 0o7777, mode, f);
  }
  assert.deepEqual(planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin }), { ops: [], problems: [] });
  const rows = await checkScannerSetup(w.mac, w.cfg, { binSha: w.pin });
  assert.deepEqual(failing(rows), [], JSON.stringify(rows));
  assert.equal(rows.length, 6);
});

test('L1083 PLANT scanner refuses a program whose hash is not the pin, and changes nothing (the real pin, through main)', async () => {
  const w = world();
  const r = await w.run(['scanner', '--from', w.from]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, new RegExp(`hashes to ${w.pin.slice(0, 12)}…, but the pinned gitleaks 8\\.30\\.1 \\(darwin arm64\\) program is ${SCANNER_BIN_SHA256.slice(0, 12)}…; nothing was changed`));
  assert.ok(!w.mac.log.some((l) => /scanner/.test(l)), w.mac.log.join('\n'));
});

test('L1083 PLANT scanner refuses a link, a missing file and a relative path', () => {
  const w = world();
  const link = join(w.ext, 'link'); symlinkSync(w.from, link);
  assert.match(planScanner(w.mac, w.cfg, { from: link, binSha: w.pin }).problems[0], /is not a plain file/);
  assert.match(planScanner(w.mac, w.cfg, { from: join(w.ext, 'none'), binSha: w.pin }).problems[0], /can't be looked at/);
  assert.match(planScanner(w.mac, w.cfg, { from: 'gitleaks', binSha: w.pin }).problems[0], /full path/);
});

test('L1083 PLANT the bytes copied are the bytes hashed: a file swapped after the read is not what lands', () => {
  const w = world();
  const p = planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin });
  writeFileSync(w.from, 'swapped');
  for (const o of p.ops) o.run();
  assert.equal(sha(readFileSync(w.mac.at(scannerPaths(w.cfg).bin))), w.pin);
});

test('L1083 PLANT scanner refuses a scanner folder that is not root\'s 0755 (never takes it over)', () => {
  const w = world();
  applyPlan(w);
  chmodSync(w.mac.at(scannerDir(w.cfg)), 0o777);
  assert.match(planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin }).problems[0], /has mode 777, want 755; move it away/);
  chmodSync(w.mac.at(scannerDir(w.cfg)), 0o755); w.mac.owners.set(scannerDir(w.cfg), { uid: 501, gid: 20 });
  assert.match(planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin }).problems[0], /is not root:wheel's/);
});

test('L1083 PLANT scanner writes again a file that drifted: changed bytes, mode, owner, a second name', () => {
  const w = world();
  applyPlan(w);
  const P = scannerPaths(w.cfg);
  const again = () => planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin }).ops.map((o) => o.text);
  chmodSync(w.mac.at(P.config), 0o666); assert.deepEqual(again().length, 1); assert.match(again()[0], /gitleaks\.toml/);
  applyPlan(w);
  chmodSync(w.mac.at(P.ignoreFile), 0o644); writeFileSync(w.mac.at(P.ignoreFile), 'fingerprint\n'); assert.match(again().join(), /gitleaksignore/);
  applyPlan(w);
  w.mac.owners.set(P.bin, { uid: 501, gid: 20 }); assert.match(again().join(), /scanner\/gitleaks /);
  applyPlan(w);
  linkSync(w.mac.at(P.bin), join(w.ext, 'second-name')); assert.match(again().join(), /scanner\/gitleaks /);
  applyPlan(w);
  assert.deepEqual(again(), []);
});

test('L1083 PLANT check-scanner FAILs each file that is not exactly in place, and does not run the program then', async () => {
  const P = scannerPaths(parseConfig(RAW));
  const cases = [
    ['missing program', (w) => rmSync(w.mac.at(P.bin)), /gitleaks: .* — it is missing/],
    ['program changed', (w) => { chmodSync(w.mac.at(P.bin), 0o755); writeFileSync(w.mac.at(P.bin), program('8.30.1') + '\n'); }, /hashes to/],
    ['config changed', (w) => writeFileSync(w.mac.at(P.config), `${DO_PLANE_TOML}\n[allowlist]\n`), /gitleaks\.toml: .* — it hashes to/],
    ['ignore file not empty', (w) => writeFileSync(w.mac.at(P.ignoreFile), 'x'), /gitleaksignore: .* — it hashes to/],
    ['program writable by others', (w) => chmodSync(w.mac.at(P.bin), 0o777), /has mode 777, want 755/],
    ['config a link', (w) => { rmSync(w.mac.at(P.config)); symlinkSync('/etc/hosts', w.mac.at(P.config)); }, /gitleaks\.toml: .* — it is a link/],
    ['folder not root\'s', (w) => w.mac.owners.set(scannerDir(w.cfg), { uid: 501, gid: 20 }), /scanner is root:wheel 0755 — it is not root:wheel's/],
  ];
  for (const [name, breakIt, want] of cases) {
    const w = world(); applyPlan(w); breakIt(w);
    let ran = false;
    const rows = await checkScannerSetup(w.mac, w.cfg, { binSha: w.pin, gate: async () => { ran = true; return { ok: true }; } });
    const bad = failing(rows).map((r) => `${r.what} — ${r.why}`).join('\n');
    assert.match(bad, want, name);
    assert.equal(ran, false, `${name}: the program is not run while a file is wrong`);
    assert.equal(rows.at(-1).ok, false, name);
  }
});

test('L1083 PLANT check-scanner FAILs a program that reports another version (the push step\'s own check)', async () => {
  const w = world({ version: '8.30.0' });
  applyPlan(w);
  const rows = await checkScannerSetup(w.mac, w.cfg, { binSha: w.pin });
  assert.equal(rows.at(-1).ok, false);
  assert.match(rows.at(-1).why, /the secret scanner is 8\.30\.0, the pin is 8\.30\.1/);
  const silent = world({ version: 'no version here' }); applyPlan(silent);
  assert.match((await checkScannerSetup(silent.mac, silent.cfg, { binSha: silent.pin })).at(-1).why, /did not report its version/);
});

test('L1083 the check is the push step\'s own: checkScanner is called with the three paths and the pinned version', async () => {
  const w = world(); applyPlan(w);
  let got;
  await checkScannerSetup(w.mac, w.cfg, { binSha: w.pin, gate: async (s) => { got = s; return checkScanner(s); } });
  const P = scannerPaths(w.cfg);
  assert.deepEqual(got, { bin: w.mac.at(P.bin), version: '8.30.1', config: w.mac.at(P.config), ignoreFile: w.mac.at(P.ignoreFile) });
});

test('L1083 PLANT check-scanner refuses root (it runs the downloaded program), and FAILs closed through main with the real pin', async () => {
  const w = world();
  const asRoot = await w.run(['check-scanner']);
  assert.equal(asRoot.code, 2); assert.match(asRoot.text, /never runs as root; run it without sudo/);
  const none = await w.run(['check-scanner'], { as: 501 });
  assert.equal(none.code, 1, none.text);
  assert.match(none.text, /FAIL {2}\/Library\/orch-test\/scanner is root:wheel 0755 — it is missing/);
  assert.match(none.text, /FAIL {2}the push step's own check passes: .* — not run: put the files right first/);
  w.mac.as = 0; applyPlan(w);   // the stand-in program: not the real pin, so the real check FAILs on its hash and never runs it
  const wrong = await w.run(['check-scanner'], { as: 501 });
  assert.equal(wrong.code, 1, wrong.text);
  assert.match(wrong.text, /scanner\/gitleaks: the gitleaks 8\.30\.1 program, root:wheel 755, hash ba52fb1bfabb… — it hashes to/);
});

test('L1083 the base check: the scanner folder is not a stranger once it is there', () => {
  const w = world();
  applyPlan(w);
  const strangers = check(w.mac, w.cfg, { alsoKnown: rootMadeEntries(w.cfg) }).filter((r) => !r.ok && /did not make/.test(r.why ?? ''));
  assert.deepEqual(strangers, []);
});

test('L1083 PIN: the pinned program hash is what shasum prints for the gitleaks inside the checked tarball (when one is at hand)', { skip: !process.env.GITLEAKS_TARBALL && 'set GITLEAKS_TARBALL to a downloaded gitleaks_8.30.1_darwin_arm64.tar.gz to run this' }, () => {
  const tar = process.env.GITLEAKS_TARBALL;
  assert.equal(sha(readFileSync(tar)), SCANNER_TARBALL_SHA256);
  const out = tempDir('orch-scanner-pin-');
  assert.equal(spawnSync('/usr/bin/tar', ['-xzf', tar, '-C', out, 'gitleaks']).status, 0);
  assert.equal(sha(readFileSync(join(out, 'gitleaks'))), SCANNER_BIN_SHA256);
});

test('L1083 PLANT an access list on a file: check-scanner FAILs it, and scanner writes the file again (a new file has none)', async () => {
  const w = world(); applyPlan(w);
  const P = scannerPaths(w.cfg);
  const r = spawnSync('/bin/chmod', ['+a', 'everyone allow write', w.mac.at(P.config)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = await checkScannerSetup(w.mac, w.cfg, { binSha: w.pin, gate: async () => ({ ok: true }) });
  assert.match(failing(rows).map((x) => `${x.what} — ${x.why}`).join('\n'), /have no access list \(ACL\) — .*access list/);
  const again = planScanner(w.mac, w.cfg, { from: w.from, binSha: w.pin }).ops.map((o) => o.text);
  assert.equal(again.length, 1); assert.match(again[0], /gitleaks\.toml/);
  applyPlan(w);
  assert.deepEqual(failing(await checkScannerSetup(w.mac, w.cfg, { binSha: w.pin, gate: async () => ({ ok: true }) })), []);
});
