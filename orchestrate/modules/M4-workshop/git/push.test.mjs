// R-0b-45: the push script, against real git. A local bare repo stands in for GitHub (reached only
// through the test harness's constructor argument). The secret scan uses a fake gitleaks for the
// logic, and the real one, where installed, for the bypass cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync, existsSync, renameSync, chmodSync, copyFileSync, linkSync, fstatSync, appendFileSync, utimesSync } from 'node:fs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { join, dirname, delimiter } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { gzipSync, deflateSync } from 'node:zlib';
import { gitOk, git, initMirror, callLog } from './safe-git.mjs';
import { createPushScript, readBundleHeader, githubUrl, SETTLE_MS } from './push.mjs';
import { researchCardDoc, RESEARCH_CARD } from '../../M11-dispatcher/research-intake.mjs';
import { intakeFactId } from '../../M11-dispatcher/intake-facts.mjs';
import { createDocsCheck } from '../../M11-dispatcher/proposal-route.mjs';
import { folderProblem } from '../../M11-dispatcher/proposals-intake.mjs';
import { SETTLE_MS as INTAKE_SETTLE_MS } from '../../M11-dispatcher/proposals-intake.mjs';
import { researchCopyProblem } from '../../M6-merge-gate/refusals.mjs';
import { refusedPath } from './push-refusals.mjs';
import { DO_PLANE_TOML, RULES_VERSION, scanSecrets } from './gitleaks.mjs';
import { crc32 } from './binary-files.mjs';
import { chunk, makePng, ihdr } from './png-fixture.mjs';
import { startGate, factId } from './start-gate.mjs';
import { memoryRecord } from '../../../shared/record.mjs';
import { timeLimits } from '../../M11-dispatcher/merges.mjs';
import { rulesWith } from '../../M11-dispatcher/fixtures.test-helper.mjs';
import { fakeRules, makeRules, allow, deny } from '../../../shared/rules.mjs';
import { makeEngine } from '../../M10-rules/engine.mjs';
import { parsePolicy } from '../../M10-rules/policy.mjs';
import { fileURLToPath } from 'node:url';
import { pushWorld, makeFakeScanner, makeFakeGit, realEngine, WF, PRODUCT, REPO } from './push-world.test-helper.mjs';

const tmp = (p = 'orch-push-') => tempDir(p);
// Tests can't chown, so every file here is the test user's. The worker door expects that user by default (the worker
// bundles below are this user's), and the owner is another id; the proposal tests swap the two (R-0b-127).
const ME = process.getuid();
const pushAsked = [];

// A GitHub-token-shaped string made at run time, so no secret-shaped text is ever committed.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const fakeSecret = () => `ghp_${[...randomBytes(36)].map((b) => ALNUM[b % ALNUM.length]).join('')}`;

// The real scanner, only when it is the pinned version (the vendored rules are that version's).
const realGitleaks = await (async () => {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(d, 'gitleaks');
    if (!d || !existsSync(p)) continue;
    try { return (await import('node:child_process')).execFileSync(p, ['version'], { encoding: 'utf8' }).includes(RULES_VERSION) ? p : null; } catch { return null; }
  }
  return null;
})();

// Positive control for the bypass cases: real gitleaks run the careless way (the branch's own
// config, ignore file, inline comments or environment), to show each bypass does hide the secret
// there, so the push script's refusal is not luck. Returns the exit code (0 = nothing found).
async function scanAsCareless(clone, args, env = {}) {
  const { spawnSync } = await import('node:child_process');
  return spawnSync(realGitleaks, ['git', clone, '--no-banner', '--exit-code', '1', ...args], { env: { PATH: '/usr/bin:/bin', HOME: tmp(), ...env }, encoding: 'utf8' }).status;
}

async function realScanner(dir) {
  const out = (await import('node:child_process')).execFileSync(realGitleaks, ['version'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'do-plane.toml'), DO_PLANE_TOML);
  writeFileSync(join(dir, 'empty-ignore'), '');
  return { bin: realGitleaks, version: /(\d+\.\d+\.\d+)/.exec(out)[1], config: join(dir, 'do-plane.toml'), ignoreFile: join(dir, 'empty-ignore') };
}

// ---- the world: "GitHub", the mirror, a worker clone, the record, rules and the gate's ports (push-world.test-helper) ----
const world = ({ scanner, gate } = {}) => pushWorld({ root: tmp(), scanner, gate, onPushAsked: (x) => pushAsked.push(x) });

// L81 sweep: the push asks M10's push_branch what it reads, and the real engine answers it.
// #219 audit M-1: the session record's outbox is checked as the Dispatcher checked the launcher's answer, so an older
// attempt's bundle can never go out under this one.
test('#219 M-1: a worker push reads only the session\'s own outbox', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  const outboxes = join(w.root, 'outboxes');
  const older = join(outboxes, 'worker', 'S-old');
  mkdirSync(older, { mode: 0o700 });
  await w.bundle(undefined, older);
  const setOutbox = (outbox) => { const cur = w.record.read('session', 'S-1'); assert.equal(w.record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: cur.rev, doc: { ...cur.doc, outbox } }).ok, true); };
  const before = await w.ghRefs();
  for (const [outbox, re] of [[older, /own folder/], [`${w.outbox}/../S-1`, /plain path/], ['/', /plain path/], [join(outboxes, 'reviewer', 'S-1'), /worker outbox/], ['outbox/worker/S-1', /full path/], [undefined, /not named/]]) {
    setOutbox(outbox);
    const r = await w.push();
    assert.equal(r.ok, false, String(outbox));
    assert.match(r.reason, re);
    assert.equal(await w.ghRefs(), before, 'nothing reached GitHub');
  }
  // With the root known, a link in the session's own place is refused too; the real folder is pushed.
  const link = `${w.outbox}-moved`;
  renameSync(w.outbox, link);
  symlinkSync(older, w.outbox);
  setOutbox(w.outbox);
  const linked = await w.push({ outboxRoot: outboxes });
  assert.equal(linked.ok, false);
  assert.match(linked.reason, /not inside the outbox root/);
  assert.equal(await w.ghRefs(), before);
  rmSync(w.outbox);
  renameSync(link, w.outbox);
  const good = await w.push({ outboxRoot: outboxes });
  assert.equal(good.ok, true, good.reason);
});

test('L81: push_branch is asked the card as { id, rows, doc: { lane, files } } and each file as { path, status }; the old subject is refused', async () => {
  const w = await world();
  await w.commit('work', (c) => { writeFileSync(join(c, 'app.txt'), 'changed\n'); writeFileSync(join(c, 'new.txt'), 'new\n'); });
  await w.bundle();
  pushAsked.length = 0;
  const r = await w.push();
  assert.equal(r.ok, true, r.reason);
  assert.equal(pushAsked.length, 1);
  const s = pushAsked[0];
  assert.deepEqual(s.card, { id: 'C-1', kind: undefined, rows: [], doc: { lane: 'product', files: [] } });
  assert.deepEqual(s.files.map((f) => [f.path, f.status]).sort(), [['app.txt', 'modified'], ['new.txt', 'added']]);
  // The subject the push used to send (the card's id, bare names): the real engine refuses it.
  assert.equal(realEngine().may('push_branch', { product: PRODUCT, card: 'C-1', files: ['app.txt'] }).decision, 'deny');
  // A card with no lane is refused by the real engine, not let through (the Record keeps a card's lane as created,
  // so the push reads it through a record that drops it).
  const w2 = await world();
  const t = w2.record;
  const noLane = Object.fromEntries(Object.keys(t).map((k) => [k, typeof t[k] === 'function' ? t[k].bind(t) : t[k]]));
  noLane.read = (e, id) => { const r = t.read(e, id); return e === 'card' && r ? { ...r, doc: { ...r.doc, lane: undefined } } : r; };
  await w2.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w2.bundle();
  await refusedAndUntouched(w2, /card has no lane/, { record: noLane });
});

// Audit #266 M1-r2 (L696, L704): a card's rows are the row files it lists, so the push hands M10 the card's files. A
// lead-lane card whose only row is its row file pushes an edit to that row through the real push script and real M10;
// a go-free daily card listing the same file may not, and another card's row stays out of lane.
test('#266 M1-r2: a lead-lane card editing its own row file is allowed by the real push and real M10; a daily card is not', async () => {
  const ROW = 'docs/blueprint/rows/R-1.yaml';
  // The Record keeps a card's lane as created, so the push reads the card through a record that shows it as planned.
  const asCard = (w, doc) => { const t = w.record; const rec = Object.fromEntries(Object.keys(t).map((k) => [k, typeof t[k] === 'function' ? t[k].bind(t) : t[k]])); rec.read = (e, id) => { const r = t.read(e, id); return e === 'card' && r ? { ...r, doc: { ...r.doc, ...doc } } : r; }; return { record: rec }; };
  const edit = async (w, path) => { await w.commit('row', (c) => { mkdirSync(join(c, 'docs/blueprint/rows'), { recursive: true }); writeFileSync(join(c, path), 'status: built\n'); }); await w.bundle(); };
  const w = await world();
  const lead = asCard(w, { lane: 'lead', files: ['src/a.mjs', ROW] });
  await edit(w, ROW);
  pushAsked.length = 0;
  const r = await w.push(lead);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(pushAsked[0].card, { id: 'C-1', kind: undefined, rows: [], doc: { lane: 'lead', files: ['src/a.mjs', ROW] } });
  const other = await world();
  await edit(other, 'docs/blueprint/rows/R-2.yaml');
  await refusedAndUntouched(other, /out of lane: docs\/blueprint\/rows\/R-2\.yaml/, asCard(other, { lane: 'lead', files: ['src/a.mjs', ROW] }));
  const daily = await world();
  await edit(daily, ROW);
  await refusedAndUntouched(daily, /out of lane: docs\/blueprint\/rows\/R-1\.yaml/, asCard(daily, { lane: 'lead', kind: 'lead_daily_card', files: [ROW] }));
});

async function refusedAndUntouched(w, re, over) {
  const before = await w.ghRefs();
  const r = await w.push(over);
  assert.equal(r.ok, false, 'should be refused');
  assert.match(r.reason, re);
  assert.equal(await w.ghRefs(), before, 'GitHub changed on a refusal');
  assert.equal(w.record.read('fact', 'push.C-1.a1').doc.result, 'refused');
  assert.deepEqual(readdirSync((over?.privateDir) ?? w.ports.privateDir), [], 'a work folder was left in the private folder (round 4 MIN-3)');
  return r;
}

test('all good: pushes exactly refs/heads/<branch>, opens the PR, moves the mirror branch; the key never reaches a command line', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  callLog.length = 0;
  const r = await w.push();
  assert.equal(r.ok, true, r.reason);
  const refs = await w.ghRefs();
  assert.deepEqual(refs.split('\n').map((l) => l.split(' ')[0]).sort(), ['refs/heads/card/c-1', 'refs/heads/main']);
  const tip = (await gitOk(['rev-parse', 'refs/heads/card/c-1'], w.cg)).trim();
  assert.match(refs, new RegExp(`refs/heads/card/c-1 ${tip}`));
  assert.equal((await gitOk(['rev-parse', 'refs/heads/card/c-1'], { gitDir: w.mirror })).trim(), tip);
  assert.equal(w.prs.length, 1);
  assert.equal(w.prs[0].branch, 'card/c-1');
  assert.equal(w.record.read('fact', 'push.C-1.a1').doc.result, 'pushed');
  assert.deepEqual(readdirSync(w.ports.privateDir), [], 'a work folder was left in the private folder (round 4 MIN-3)');
  assert.ok(!JSON.stringify(callLog).includes('robot-key-for-test'), 'the key appeared in a logged command');
  assert.ok(!callLog.some((c) => c.args.some((a) => /^\+/.test(a) && a.includes('card/'))), 'a forced push spec was used');
  assert.match(w.fake.calls(), /git\ndir\nstdin/);
  const holding = await git(['rev-parse', '--verify', 'refs/orchestrate/incoming/C-1/a1'], { gitDir: w.mirror });
  assert.notEqual(holding.code, 0, 'the holding ref was left behind');
});

const REFUSED_PATHS = ['.github/workflows/x.yml', 'pkg/.github/workflows/x.yml', '.github/actions/a/action.yml', 'pkg/.github/actions/a/action.yml',
  '.claude/settings.json', 'src/.claude/skills/x/SKILL.md', '.mcp.json', 'a/b/.mcp.json', 'CLAUDE.local.md', 'docs/CLAUDE.local.md',
  ...['vercel.json', 'vercel.ts', 'vercel.js', 'vercel.mjs', 'vercel.cjs', 'vercel.mts'].flatMap((n) => [n, `apps/web/${n}`]),
  '.github/CODEOWNERS', '.github/dependabot.yml', 'pkg/.github/x.yml', '.Claude/settings.json', '.GitHub/Workflows/x.yml', 'VERCEL.JSON', '.git​hub/workflows/x.yml', '.cla­ude/x', '.gitmodules'];

test('the refusal list: every name, at the root and at depth, in any case and with invisible characters', () => {
  for (const p of REFUSED_PATHS) assert.ok(refusedPath(p), `${p} not refused`);
  for (const p of ['README.md', '.github', 'src/claude/x.js', 'vercel.json.md', 'my-vercel.json', 'workflows/x.yml', 'docs/.github.md']) assert.equal(refusedPath(p), null, `${p} wrongly refused`);
});

test('every refused name, pushed for real at the root and at depth: refused, GitHub untouched', async () => {
  for (const p of REFUSED_PATHS.filter((x) => !/[​­]/.test(x))) {
    const w = await world();
    await w.commit(`add ${p}`, (c) => { mkdirSync(dirname(join(c, p)), { recursive: true }); writeFileSync(join(c, p), 'x\n'); });
    await w.bundle();
    await refusedAndUntouched(w, /touches files no card may/);
  }
});

test('a rename to a workflow file, a deleted workflow file, and add-then-remove across two commits are all refused', async () => {
  let w = await world();
  await w.commit('rename', () => renameSync(join(w.clone, 'app.txt'), join(w.clone, '.github/workflows/x.yml')));
  await w.bundle();
  await refusedAndUntouched(w, /\.github\/workflows/);

  // L39: a rename into .github/ of a file GitHub would read outside workflows is refused too.
  w = await world();
  await w.commit('rename', () => renameSync(join(w.clone, 'app.txt'), join(w.clone, '.github/CODEOWNERS')));
  await w.bundle();
  await refusedAndUntouched(w, /touches a \.github folder.*CODEOWNERS|CODEOWNERS.*touches a \.github folder/);

  w = await world();
  await w.commit('delete', () => rmSync(join(w.clone, '.github/workflows/ci.yml')));
  await w.bundle();
  await refusedAndUntouched(w, /\.github\/workflows/);

  w = await world();
  await w.commit('add', (c) => writeFileSync(join(c, '.github/workflows/evil.yml'), 'x\n'));
  await w.commit('remove', (c) => rmSync(join(c, '.github/workflows/evil.yml')));
  await w.bundle();
  await refusedAndUntouched(w, /evil\.yml/);
});

test('links and submodules: a new link, a link to /etc, a file changed into a link, a submodule entry', async () => {
  let w = await world();
  await w.commit('link', (c) => symlinkSync('app.txt', join(c, 'l')));
  await w.bundle();
  await refusedAndUntouched(w, /link/);

  w = await world();
  await w.commit('etc', (c) => symlinkSync('/etc', join(c, 'etc')));
  await w.bundle();
  await refusedAndUntouched(w, /link/);

  w = await world();
  await w.commit('type change', (c) => { rmSync(join(c, 'README.md')); symlinkSync('app.txt', join(c, 'README.md')); });
  await w.bundle();
  await refusedAndUntouched(w, /README\.md: adds or changes a link/);

  w = await world();
  const head = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['update-index', '--add', '--cacheinfo', `160000,${head},sub`], w.cg);
  await gitOk(['commit', '-q', '-m', 'submodule'], w.cg);
  await w.bundle();
  await refusedAndUntouched(w, /submodule/);
});

test('a merge commit and a first (root) commit are refused', async () => {
  let w = await world();
  await w.commit('a', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await gitOk(['checkout', '-q', '-b', 'side', 'main'], w.cg);
  await w.commit('b', (c) => writeFileSync(join(c, 'b.txt'), 'b\n'));
  await gitOk(['checkout', '-q', 'card/c-1'], w.cg);
  await gitOk(['merge', '-q', '--no-ff', '-m', 'merge', 'side'], w.cg);
  await w.bundle();
  await refusedAndUntouched(w, /merge/);

  w = await world();
  await gitOk(['checkout', '-q', '--orphan', 'tmp'], w.cg);
  await w.commit('root', (c) => writeFileSync(join(c, 'r.txt'), 'r\n'));
  await gitOk(['branch', '-f', 'card/c-1', 'tmp'], w.cg);
  await w.bundle(['refs/heads/card/c-1']);
  await refusedAndUntouched(w, /first commit/);
});

test('bad bundles: HEAD, two refs, main, a tag, missing earlier commits, a filter, a link, none at all', async () => {
  const cases = [
    [['HEAD', 'refs/heads/card/c-1', '^refs/heads/main'], /exactly one branch|holds HEAD/],
    [['refs/heads/card/c-1', 'refs/heads/main'], /exactly one branch/],
    [['refs/heads/main'], /holds refs\/heads\/main/],
  ];
  for (const [args, re] of cases) {
    const w = await world();
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    await w.bundle(args);
    await refusedAndUntouched(w, re);
  }
  let w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await gitOk(['tag', 'v1'], w.cg);
  await w.bundle(['refs/heads/card/c-1', 'refs/tags/v1', '^refs/heads/main']);
  await refusedAndUntouched(w, /exactly one branch/);

  w = await world();
  await w.commit('hidden', (c) => writeFileSync(join(c, 'h.txt'), 'h\n'));
  const hidden = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle(['refs/heads/card/c-1', `^${hidden}`]);
  await refusedAndUntouched(w, /does not verify/);

  w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  const real = join(w.root, 'elsewhere.bundle');
  renameSync(join(w.outbox, 'bundle-C-1.bundle'), real);
  symlinkSync(real, join(w.outbox, 'bundle-C-1.bundle'));
  await refusedAndUntouched(w, /link/);

  w = await world();
  await refusedAndUntouched(w, /no bundle/);

  const f = join(tmp(), 'f.bundle');
  writeFileSync(f, `# v3 git bundle\n@filter=blob:none\n${'a'.repeat(40)} refs/heads/card/c-1\n\nPACK`);
  assert.throws(() => readBundleHeader(f, 'card/c-1'), /capability/);
  writeFileSync(f, `# v3 git bundle\n@object-format=sha1\n${'a'.repeat(40)} refs/heads/card/c-1\n\nPACK`);
  assert.equal(readBundleHeader(f, 'card/c-1'), 'a'.repeat(40));
});

test('a bundle swapped after the private copy is taken: the copy is what gets pushed', async () => {
  const w = await world();
  await w.commit('good', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  const good = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.bundle();
  // A second, bad bundle is ready; the swap happens while the start gate is being read.
  await w.commit('evil', (c) => writeFileSync(join(c, '.mcp.json'), '{}'));
  const evil = join(w.root, 'evil.bundle');
  await gitOk(['bundle', 'create', '-q', evil, 'refs/heads/card/c-1', '^refs/heads/main'], w.cg);
  const r = await w.push({ readRun: async () => { copyFileSync(evil, join(w.outbox, 'bundle-C-1.bundle')); return w.run; } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.tip, good);
  assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${good}`));
});

test('a bundle swapped right after the private copy is taken, before any check: the copy is what gets checked and pushed', async () => {
  const w = await world();
  await w.commit('good', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  const good = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.bundle();
  await w.commit('evil', (c) => writeFileSync(join(c, '.mcp.json'), '{}'));
  const evil = join(w.root, 'evil.bundle');
  await gitOk(['bundle', 'create', '-q', evil, 'refs/heads/card/c-1', '^refs/heads/main'], w.cg);
  let swapped = false;
  const r = await w.push({ afterStage: () => { copyFileSync(evil, join(w.outbox, 'bundle-C-1.bundle')); swapped = true; } });
  assert.equal(swapped, true, 'the seam ran');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.tip, good);
  assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${good}`));
});

test('scanner problems refuse: a finding, a crash (exit 2), the wrong version, a missing binary, a changed config', async () => {
  for (const [mode, re] of [['leak', /found 1 likely secret/], ['crash', /did not finish cleanly/], ['wrongversion', /pin is 8\.30\.1/], ['noreport', /did not finish cleanly/], ['badreport', /did not finish cleanly/]]) {
    const w = await world();
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    await w.bundle();
    w.fake.setMode(mode);
    await refusedAndUntouched(w, re);
  }
  let w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /scanner is missing/, { scanner: { ...w.ports.scanner, bin: join(w.root, 'nope') } });
  writeFileSync(w.ports.scanner.config, DO_PLANE_TOML + '[allowlist]\npaths = [".*"]\n');
  await refusedAndUntouched(w, /config has changed/);
});

test('an added "gitleaks:allow" line is refused by the push script itself, in any case', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'key = "x" # GitLeaks:Allow\n'));
  await w.bundle();
  await refusedAndUntouched(w, /gitleaks:allow/);
});

test('real gitleaks: a planted secret is stopped despite the branch\'s .gitleaks.toml, .gitleaksignore and GITLEAKS_CONFIG', { skip: realGitleaks ? false : 'skipped: gitleaks not installed' }, async () => {
  const scanDir = tmp();
  const scanner = await realScanner(scanDir);
  // (a) the branch's own allow-list.
  let w = await world({ scanner });
  const s1 = fakeSecret();
  await w.commit('allowlist', (c) => { writeFileSync(join(c, '.gitleaks.toml'), '[extend]\nuseDefault = true\n[allowlist]\npaths = [\'\'\'.*\'\'\']\nregexes = [\'\'\'.*\'\'\']\n'); writeFileSync(join(c, 'cfg.txt'), `token = "${s1}"\n`); });
  await w.bundle();
  assert.equal(await scanAsCareless(w.clone, ['--config', scanner.config]), 1, 'control: gitleaks should see the secret');
  // gitleaks picks up the branch's own .gitleaks.toml when no config is named.
  assert.equal(await scanAsCareless(w.clone, []), 0, 'control: the branch allow-list should hide it');
  await refusedAndUntouched(w, /likely secret/);
  // (b) a fingerprint in the branch's .gitleaksignore (worked out from a first scan).
  w = await world({ scanner });
  const s2 = fakeSecret();
  await w.commit('secret', (c) => writeFileSync(join(c, 'cfg.txt'), `token = "${s2}"\n`));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.commit('ignore', (c) => writeFileSync(join(c, '.gitleaksignore'), `${sha}:cfg.txt:github-pat:1\n`));
  await w.bundle();
  assert.equal(await scanAsCareless(w.clone, ['--gitleaks-ignore-path', w.clone]), 0, 'control: the branch ignore file should hide it');
  await refusedAndUntouched(w, /likely secret/);
  // (d) GITLEAKS_CONFIG in the caller's own environment, pointing at an allow-everything config.
  w = await world({ scanner });
  const s3 = fakeSecret();
  await w.commit('secret', (c) => writeFileSync(join(c, 'cfg.txt'), `token = "${s3}"\n`));
  await w.bundle();
  const loose = join(scanDir, 'loose.toml');
  writeFileSync(loose, '[allowlist]\nregexes = [\'\'\'.*\'\'\']\n');
  assert.equal(await scanAsCareless(w.clone, [], { GITLEAKS_CONFIG: loose }), 0, 'control: GITLEAKS_CONFIG should hide it');
  process.env.GITLEAKS_CONFIG = loose; process.env.GITLEAKS_CONFIG_TOML = readFileSync(loose, 'utf8');
  try { await refusedAndUntouched(w, /likely secret/); } finally { delete process.env.GITLEAKS_CONFIG; delete process.env.GITLEAKS_CONFIG_TOML; }
  // A secret in a commit message is stopped too (review m5).
  w = await world({ scanner });
  await w.commit(`notes ${fakeSecret()}`, (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /message/);
  // Planted fault: the same scan on a clean branch passes, so the refusals above are the scanner's.
  w = await world({ scanner });
  await w.commit('clean', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  const ok = await w.push();
  assert.equal(ok.ok, true, ok.reason);
});

test('real gitleaks: an inline gitleaks:allow comment does not hide a secret from the scan itself', { skip: realGitleaks ? false : 'skipped: gitleaks not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const w = await world({ scanner });
  await w.commit('inline', (c) => writeFileSync(join(c, 'cfg.txt'), `token = "${fakeSecret()}" # gitleaks:allow\n`));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  assert.equal(await scanAsCareless(w.clone, []), 0, 'control: without the flag the inline comment hides it');
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  const r = await scanSecrets({ setup: scanner, mirror: w.mirror, shas: [sha], messages: [], privateDir: tmp() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /likely secret/);
});

test('R-0b-47 MAT-1, real gitleaks: a secret in a folder or file the default rules skip is still stopped', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const old = join(tmp(), 'old.toml');
  writeFileSync(old, '[extend]\nuseDefault = true\n');
  for (const path of ['node_modules/a.js', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'docs/x.svg']) {
    const w = await world({ scanner });
    await w.commit('skipped place', (c) => { mkdirSync(dirname(join(c, path)), { recursive: true }); writeFileSync(join(c, path), `token = "${fakeSecret()}"\n`); });
    // Positive control: the default rules, with their allow-list, let it through.
    assert.equal(await scanAsCareless(w.clone, ['--config', old]), 0, `control: the default allow-list skips ${path}`);
    await w.bundle();
    const r = await refusedAndUntouched(w, /likely secret/);
    assert.ok(r.reason.includes(path.split('/').at(-1)), path);
  }
});

test('R-0b-47 MAT-2, real gitleaks: a secret in a file git calls binary is still stopped', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const w = await world({ scanner });
  await w.commit('binary', (c) => writeFileSync(join(c, 'b.js'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\nconst t = "${fakeSecret()}";\n`)])));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  // Positive control: the git scan alone, without the files, misses it.
  assert.deepEqual(await scanSecrets({ setup: scanner, mirror: w.mirror, shas: [sha], messages: [], privateDir: tmp() }), { ok: true, binaries: [] });
  await w.bundle();
  const r = await refusedAndUntouched(w, /b\.js cannot be scanned for secrets/);
  assert.match(r.reason, /not plain UTF-8 text/);
});

test('R-0b-47 MAT-1: the vendored rules have no allow-list and are all there', () => {
  assert.doesNotMatch(DO_PLANE_TOML.replace(/^#.*$/gm, ''), /allowlist/i);
  assert.ok((DO_PLANE_TOML.match(/^\[\[rules\]\]$/gm) ?? []).length > 200, 'the default rules are all there');
  assert.doesNotMatch(DO_PLANE_TOML, /useDefault/);
});

test('start gate on a full push: a shut gate pushes nothing and raises one issue', async () => {
  const w = await world({ gate: { workflowRule: async () => ({ ok: false, reason: 'writes with a broad key' }) } });
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /start gate is shut.*ci\.yml/);
  assert.equal(w.issues.length, 1);
  assert.equal(w.issues[0].key, `start-gate-${PRODUCT}`);
});

test('start gate: each fact bad, missing, stale by 1 s, or for the wrong repo shuts it, with one issue each time', async () => {
  const w = await world();
  const now = Date.now();
  const base = { product: PRODUCT, mirror: w.mirror, record: w.record, workflowPath: WF, workflowRule: async () => ({ ok: true }), vercelProject: 'prj_1', now };
  const goodRun = { ...w.run, run_at: new Date(now - 1000).toISOString() };
  const gate = async (over) => { const issues = []; const r = await startGate({ ...base, readRun: async () => goodRun, cache: {}, issues: { upsert: async (i) => { issues.push(i); } }, ...over }); return { r, issues }; };
  const ok = await gate({});
  assert.equal(ok.r.ok, true, ok.r.reason);
  const iso = (ms) => new Date(ms).toISOString();
  const runCases = [
    [{ ...goodRun, steps: [{ product: PRODUCT, conclusion: 'failure' }] }, /read-only/],
    [{ ...goodRun, steps: [{ product: 'other', conclusion: 'success' }] }, /read-only/],
    [{ ...goodRun, run_at: iso(now - 2 * 3600 * 1000 - 1000) }, /2 hours/], // the review's 2 hours, written out (MIN-3)
    [{ ...goodRun, run_at: iso(now + 2 * 60 * 1000) }, /2 hours/], // dated in the future (MIN-2)
    [{ ...goodRun, workflow_path: '.github/workflows/other.yml' }, /pinned workflow/],
    [{ ...goodRun, event: 'push' }, /scheduled or manual/],
    [{ ...goodRun, head_branch: 'card/x' }, /not on main/],
    [null, /could not be read/],
  ];
  for (const [run, re] of runCases) {
    const { r, issues } = await gate({ readRun: async () => run });
    assert.equal(r.ok, false); assert.match(r.reason, re); assert.equal(issues.length, 1);
  }
  const t = await gate({ readRun: async () => { throw new Error('offline'); } });
  assert.equal(t.r.ok, false);
  for (const rule of [undefined, async () => ({ ok: false, reason: 'bad' }), async () => { throw new Error('boom'); }]) {
    const { r, issues } = await gate({ workflowRule: rule });
    assert.equal(r.ok, false); assert.equal(issues.length, 1);
  }
  for (const kind of ['vercel_skip', 'vercel_env']) {
    const good = { product: PRODUCT, vercel_project: 'prj_1', read_at: iso(now - 1000), result: true };
    for (const [doc, re] of [[{ ...good, result: false }, /fails/], [{ ...good, read_at: iso(now - 10 * 60 * 1000 - 1000) }, /10 minutes/], [{ ...good, read_at: iso(now + 2 * 60 * 1000) }, /10 minutes/], [{ ...good, vercel_project: 'prj_2' }, /another project/], [{ ...good, product: 'p2' }, /another project/], [{ ...good, read_at: 'soon' }, /10 minutes/]]) {
      w.writeFact(kind, doc);
      const { r, issues } = await gate({});
      assert.equal(r.ok, false, `${kind} ${JSON.stringify(doc)}`); assert.match(r.reason, re); assert.equal(issues.length, 1);
      w.writeFact(kind, good);
    }
  }
  // Just inside each limit is still open, so the limits are not shorter than the review's either.
  const inside = await gate({ readRun: async () => ({ ...goodRun, run_at: iso(now - 2 * 3600 * 1000 + 60 * 1000) }) });
  assert.equal(inside.r.ok, true, inside.r.reason);
  for (const kind of ['vercel_skip', 'vercel_env']) w.writeFact(kind, { product: PRODUCT, vercel_project: 'prj_1', read_at: iso(now - 10 * 60 * 1000 + 60 * 1000), result: true });
  assert.equal((await gate({})).r.ok, true);
  const empty = await startGate({ ...base, record: memoryRecord(), readRun: async () => goodRun, cache: {}, issues: { upsert: async () => {} } });
  assert.match(empty.reason, /no fact yet/);
});

test('start gate: the outside check run is read at most once an hour', async () => {
  const w = await world();
  let reads = 0;
  const now = Date.now();
  const cache = {};
  const readRun = async () => { reads += 1; return { ...w.run, run_at: new Date(now).toISOString() }; };
  const g = (at) => startGate({ product: PRODUCT, mirror: w.mirror, record: w.record, readRun, workflowPath: WF, workflowRule: async () => ({ ok: true }), vercelProject: 'prj_1', cache, issues: { upsert: async () => {} }, now: at });
  await g(now); await g(now + 59 * 60 * 1000);
  assert.equal(reads, 1);
  await g(now + 61 * 60 * 1000);
  assert.equal(reads, 2);
});

test('the branch on GitHub moved (a catch-up merge): a plain push is refused; a fix round built on it fast-forwards (L4)', async () => {
  const w = await world();
  await w.commit('one', (c) => writeFileSync(join(c, 'a.txt'), '1\n'));
  await w.bundle();
  assert.equal((await w.push()).ok, true);
  // GitHub's "update branch" adds a merge on the card branch.
  const other = join(w.root, 'other');
  mkdirSync(other);
  const og = { gitDir: join(other, '.git'), workTree: other, cwd: other };
  await gitOk(['init', '-q', other], og);
  await gitOk(['fetch', '-q', '--update-head-ok', w.gh, 'refs/heads/main:refs/heads/main', 'refs/heads/card/c-1:refs/heads/card/c-1'], og);
  await gitOk(['checkout', '-q', 'main'], og);
  writeFileSync(join(other, 'm.txt'), 'm\n');
  await gitOk(['add', '-A'], og); await gitOk(['commit', '-q', '-m', 'main moves'], og);
  await gitOk(['checkout', '-q', 'card/c-1'], og);
  await gitOk(['merge', '-q', '--no-ff', '-m', 'update branch', 'main'], og);
  await gitOk(['push', '-q', w.gh, 'main:refs/heads/main', 'card/c-1:refs/heads/card/c-1'], og);
  // A fix round built on the old bundle: refused, GitHub untouched.
  await w.commit('two', (c) => writeFileSync(join(c, 'a.txt'), '2\n'));
  await w.bundle();
  const before = await w.ghRefs();
  const r = await createPushScript(w.ports)('S-1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /has moved/);
  assert.equal(await w.ghRefs(), before);
  // The fix round done right: start from GitHub's branch, then commit (the merge is GitHub's, not new).
  await gitOk(['fetch', '-q', w.gh, '+refs/heads/card/c-1:refs/heads/card/c-1-gh', '+refs/heads/main:refs/heads/main'], w.cg);
  await gitOk(['reset', '-q', '--hard', 'card/c-1-gh'], w.cg);
  await w.commit('two again', (c) => writeFileSync(join(c, 'a.txt'), '2\n'));
  await w.bundle(['refs/heads/card/c-1', '^refs/heads/card/c-1-gh']);
  const r2 = await createPushScript(w.ports)('S-1');
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.commits, 1);
});

test('inputs come from the record only; the branch, product and rules are checked; production addresses are github.com only', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /not allow/, { rules: fakeRules({ answers: { push_branch: deny('frozen') }, values: w.values }) });
  await refusedAndUntouched(w, /not onboarded/, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.onboarded': false } }) });
  // The rules hand the flag back as the file's text; anything but an exact true is not onboarded, a missing key too.
  for (const onboarded of ['yes', 'TRUE', 1]) await refusedAndUntouched(w, /not onboarded/, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.onboarded': onboarded } }) });
  { const { 'product.onboarded': _, ...unset } = w.values; await refusedAndUntouched(w, /not onboarded/, { rules: fakeRules({ answers: w.answers, values: unset }) }); }
  for (const repo of ['../x', 'a/b/c', 'evil.com:x/y', 'a b/c', 'owner/..']) {
    const r = await createPushScript({ ...w.ports, testRemote: undefined, rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.repo': repo } }) })('S-1');
    assert.equal(r.ok, false, repo); assert.match(r.reason, /valid GitHub repo/);
  }
  assert.equal(githubUrl(REPO), `https://github.com/${REPO}.git`);
  await refusedAndUntouched(w, /robot key/, { getRobotToken: async () => '' });
  for (const [doc, re] of [[{ product: PRODUCT, card: 'C-1', branch: 'main', outbox: w.outbox, attempt: 'a1' }, /not the card's branch/], [{ product: PRODUCT, card: 'C-1', branch: 'card/c-2', outbox: w.outbox, attempt: 'a1' }, /not the card's branch/], [{ product: PRODUCT, card: '../x', branch: 'card/x', outbox: w.outbox, attempt: 'a1' }, /bad card id/]]) {
    const cur = w.record.read('session', 'S-1');
    assert.equal(w.record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: cur.rev, doc: { state: cur.doc.state, ...doc } }).ok, true);
    const r = await w.push();
    assert.equal(r.ok, false); assert.match(r.reason, re);
  }
  const r = await createPushScript(w.ports)('S-404');
  assert.match(r.reason, /no launch record/);
  // No fact without a real card and attempt (L325 m3): never a shared "unknown", never String(undefined).
  assert.equal(w.record.read('fact', 'push.unknown.unknown'), null);
  assert.equal(w.record.read('fact', 'push.undefined.undefined'), null);
});

test('R-0b-47 MIN-5: a bundle over the size cap, or with a second hard link, is refused', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /larger than 10 bytes/, { bundleCap: 10 });
  linkSync(join(w.outbox, 'bundle-C-1.bundle'), join(w.root, 'second-name.bundle'));
  await refusedAndUntouched(w, /more than one link/);
});

test('R-0b-47 MIN-11: a mirror holding grafts, shallow or a commit-graph refuses', async () => {
  for (const f of ['info/grafts', 'shallow', 'objects/info/commit-graph', 'objects/info/commit-graphs']) {
    const w = await world();
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    await w.bundle();
    mkdirSync(dirname(join(w.mirror, f)), { recursive: true });
    if (f.endsWith('commit-graphs')) mkdirSync(join(w.mirror, f)); else writeFileSync(join(w.mirror, f), '');
    await refusedAndUntouched(w, new RegExp(`mirror has ${f}`));
  }
});

test('R-0b-47 MIN-1: a program that quits before reading its input is refused, and the process lives on', async () => {
  const r = await git(['version'], { gitDir: tmp(), input: Buffer.alloc(16 * 1024 * 1024, 'x'), purpose: 'test' });
  assert.equal(r.code, 0);
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  w.fake.setMode('stdinquit');
  const s = await scanSecrets({ setup: w.ports.scanner, mirror: w.mirror, shas: [sha], messages: [[sha, 'x'.repeat(16 * 1024 * 1024)]], privateDir: tmp() });
  assert.equal(s.ok, false);
  assert.match(s.reason, /header lines or file names: .*did not finish cleanly/);
});

test('the mirror is checked before every push: a planted alternates file refuses', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  writeFileSync(join(w.mirror, 'objects/info/alternates'), join(w.clone, '.git/objects') + '\n');
  await refusedAndUntouched(w, /alternates/);
});

// ---- R-0b-46: git never runs inside a worker's copy (save-work is the one, after its reset) ----
import { createSaveWork, CLONE_CONFIG_TEMPLATE } from './save-work.mjs';
import { prepareWorkerCopy } from '../launcher/worker-copy.mjs';
import { readdirSync, statSync } from 'node:fs';
import { fakeAlert } from '../../../test/fake-alert.test-helper.mjs';

const HOOK_NAMES = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction',
  'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-pre-submit', 'post-index-change'];

/** Plants every program-running setting git has in the clone; each program writes a marker. */
async function boobyTrap(w) {
  const markers = join(w.root, 'markers');
  mkdirSync(markers);
  const prog = (name) => { const p = join(w.root, 'traps', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\ncat\n`); chmodSync(p, 0o755); return p; };
  // Committed first, so committing does not itself run the filter.
  await w.commit('attributes', (c) => { writeFileSync(join(c, '.gitattributes'), '* filter=x diff=x\n'); writeFileSync(join(c, 'app.txt'), 'changed\n'); });
  const hooks = join(w.root, 'traps', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const h of HOOK_NAMES) { writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${JSON.stringify(join(markers, `hook-${h}`))}\n`); chmodSync(join(hooks, h), 0o755); }
  const gd = join(w.clone, '.git');
  // Read before the traps go in: safe-git refuses a repository whose config names a program (L36).
  const head = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  mkdirSync(join(gd, 'hooks'), { recursive: true });
  for (const h of HOOK_NAMES) copyFileSync(join(hooks, h), join(gd, 'hooks', h));
  chmodSync(join(gd, 'hooks'), 0o755);
  for (const h of HOOK_NAMES) chmodSync(join(gd, 'hooks', h), 0o755);
  const inc = join(w.root, 'traps', 'included.cfg');
  writeFileSync(inc, `[core]\n\tpager = ${prog('pager-inc')}\n[diff]\n\texternal = ${prog('diff-inc')}\n`);
  const cfg = readFileSync(join(gd, 'config'), 'utf8') + [
    '[core]', `\tfsmonitor = ${prog('fsmonitor')}`, `\thooksPath = ${hooks}`, `\tpager = ${prog('pager')}`, `\tsshCommand = ${prog('ssh')}`, `\taskPass = ${prog('askpass')}`,
    '[diff]', `\texternal = ${prog('diff-external')}`, '[diff "x"]', `\ttextconv = ${prog('textconv')}`, `\tcommand = ${prog('diff-driver')}`,
    '[filter "x"]', `\tclean = ${prog('clean')}`, `\tsmudge = ${prog('smudge')}`, `\tprocess = ${prog('process')}`, '\trequired = true',
    '[remote "origin"]', '\turl = https://example.invalid/evil.git', '\tpushurl = https://example.invalid/evil.git',
    '[uploadpack]', `\tpackObjectsHook = ${prog('pack-objects-hook')}`, '[credential]', `\thelper = !${prog('credential')}`,
    '[include]', `\tpath = ${inc}`, '[includeIf "gitdir:/"]', `\tpath = ${inc}`, ''].join('\n');
  writeFileSync(join(gd, 'config'), cfg);
  mkdirSync(join(gd, 'info'), { recursive: true });
  writeFileSync(join(gd, 'info', 'attributes'), '* filter=x diff=x\n');
  writeFileSync(join(gd, 'config.worktree'), `[core]\n\tfsmonitor = ${prog('fsmonitor-wt')}\n`);
  // The clone moves its own idea of GitHub's main.
  writeFileSync(join(gd, 'packed-refs'), `${head} refs/remotes/origin/main\n`);
  return { markers, fired: () => readdirSync(markers) };
}

const lockedRunner = () => { const r = { calls: 0 }; r.run = async (fn) => { r.calls++; return fn(); }; return r; };
const underClone = (w, c) => [c.gitDir, c.cwd, c.workTree].some((p) => p && (p === w.clone || p.startsWith(w.clone + '/')));

test('R-0b-46: a booby-trapped clone: save-work, the push, the launch check and the restart check run none of its programs', async () => {
  const w = await world();
  const mirrorCfg = readFileSync(join(w.mirror, 'config'));
  const mirrorRefs = await gitOk(['for-each-ref'], { gitDir: w.mirror });
  const trap = await boobyTrap(w);
  callLog.length = 0;
  const lock = lockedRunner();
  const saved = await createSaveWork({ runLocked: lock.run })({ clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(lock.calls, 1, 'save-work did not run inside the lock-down');
  assert.equal(readFileSync(join(w.clone, '.git', 'config'), 'utf8'), CLONE_CONFIG_TEMPLATE);
  for (const f of ['hooks', 'config.worktree', 'info/attributes']) assert.ok(!existsSync(join(w.clone, '.git', f)), `${f} was left`);

  const pushed = await w.push();
  assert.equal(pushed.ok, true, pushed.reason);
  // The push moved the mirror's card branch only; its config and every other ref are untouched.
  assert.deepEqual(readFileSync(join(w.mirror, 'config')), mirrorCfg);
  const refsNow = (await gitOk(['for-each-ref'], { gitDir: w.mirror })).split('\n').filter((l) => l && !l.includes('refs/heads/card/'));
  assert.deepEqual(refsNow.join('\n'), mirrorRefs.trimEnd());

  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main, branch: 'card/c-1' };
  const launch = await prepareWorkerCopy({ product, card, dest: join(w.root, 'fresh') });
  assert.equal(launch.ok, true, launch.reason);
  // Restart from the bundle made out of the trapped clone (it carries `* filter=x`).
  const restart = await prepareWorkerCopy({ product, card, dest: join(w.root, 'restarted'), lastBundle: saved.bundle });
  assert.equal(restart.ok, true, restart.reason);
  assert.ok(existsSync(join(w.root, 'restarted', '.gitattributes')), 'the restart did not check out the branch');

  assert.deepEqual(trap.fired(), [], 'a planted program ran');
  const inClone = callLog.filter((c) => underClone(w, c));
  assert.ok(inClone.length > 0 && inClone.every((c) => c.purpose === 'save-work'), `git ran inside the worker copy: ${inClone.map((c) => c.purpose).join(', ')}`);
});

test('R-0b-46: positive control: the planted programs do run when git is used inside the clone the careless way', async () => {
  const w = await world();
  const trap = await boobyTrap(w);
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['-C', w.clone, 'status'], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: tmp(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GCM_INTERACTIVE: 'never' }, timeout: 60_000 });
  spawnSync('git', ['-C', w.clone, 'diff', 'HEAD~1'], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: tmp(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GCM_INTERACTIVE: 'never' }, timeout: 60_000 });
  assert.ok(trap.fired().length > 0, 'the traps are not live, so the main test would prove nothing');
});

test('R-0b-46: save-work refuses a .git pointer file, a .git link, a foreign alternates file, and running outside the lock-down', async () => {
  const w = await world();
  const args = { clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox };
  const lock = lockedRunner();
  const save = createSaveWork({ runLocked: lock.run });
  assert.match((await createSaveWork({})(args)).reason, /lock-down/);
  assert.match((await save({ ...args, branch: 'card/c-2' })).reason, /bad card branch/);

  // Alternates naming the mirror's objects is allowed; anything else is refused.
  const alt = join(w.clone, '.git', 'objects', 'info', 'alternates');
  mkdirSync(dirname(alt), { recursive: true });
  writeFileSync(alt, `${join(w.mirror, 'objects')}\n`);
  assert.equal((await save(args)).ok, true);
  writeFileSync(alt, `${join(w.gh, 'objects')}\n`);
  assert.match((await save(args)).reason, /borrows objects/);
  rmSync(alt);

  // A gitdir: pointer to another repository.
  const real = join(w.root, 'real-git');
  renameSync(join(w.clone, '.git'), real);
  writeFileSync(join(w.clone, '.git'), `gitdir: ${real}\n`);
  callLog.length = 0;
  assert.match((await save(args)).reason, /not a real folder/);
  assert.equal(callLog.length, 0, 'git ran on a pointer file');
  rmSync(join(w.clone, '.git'));
  symlinkSync(real, join(w.clone, '.git'));
  assert.match((await save(args)).reason, /not a real folder/);
  assert.equal(callLog.length, 0);
});

test('R-0b-46: a worker changing origin and its own main affects no other copy, the mirror, or the Do-plane read of main', async () => {
  const w = await world();
  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main };
  const second = await prepareWorkerCopy({ product, card: { ...card, id: 'C-2' }, dest: join(w.root, 'second') });
  assert.equal(second.ok, true, second.reason);
  const snap = (dir) => readdirSync(dir, { recursive: true }).filter((p) => !String(p).startsWith('.git/objects') && !String(p).includes('index')).map((p) => { const f = join(dir, String(p)); return statSync(f).isFile() ? `${p}:${readFileSync(f, 'base64')}` : String(p); }).sort();
  const before = { second: snap(join(w.root, 'second')), mirror: snap(w.mirror) };
  await gitOk(['config', 'remote.origin.url', 'https://example.invalid/evil.git'], w.cg); // safe-git never runs `git remote` (L51)
  await gitOk(['update-ref', 'refs/remotes/origin/main', (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim()], w.cg);
  await gitOk(['update-ref', 'refs/heads/main', (await gitOk(['commit-tree', '-m', 'evil', `${main}^{tree}`], w.cg)).trim()], w.cg);
  // Last: once its config names a hooks folder, safe-git refuses the copy (L49).
  await gitOk(['config', 'core.hooksPath', '/tmp/evil-hooks'], w.cg);
  assert.deepEqual(snap(join(w.root, 'second')), before.second);
  assert.deepEqual(snap(w.mirror), before.mirror);
  assert.equal((await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim(), main);
});

test('R-0b-46: a planted alternates file in the mirror refuses the launch check and the restart check too', async () => {
  const w = await world();
  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  writeFileSync(join(w.mirror, 'objects', 'info', 'alternates'), `${join(w.clone, '.git', 'objects')}\n`);
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main };
  assert.match((await prepareWorkerCopy({ product, card, dest: join(w.root, 'x1') })).reason, /alternates/);
  await w.bundle(['refs/heads/card/c-1']);
  assert.match((await prepareWorkerCopy({ product, card, dest: join(w.root, 'x2'), lastBundle: join(w.outbox, 'bundle-C-1.bundle') })).reason, /alternates/);
  assert.match((await w.push()).reason, /alternates/);
});

test('L4 restart: the copy fast-forwards to GitHub\'s branch kept in the mirror; a branch that went another way is refused', async () => {
  const w = await world();
  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  await w.commit('one', (c) => writeFileSync(join(c, 'app.txt'), 'one\n'));
  await w.bundle(['refs/heads/card/c-1']);
  const bundleHead = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.commit('two, on GitHub', (c) => writeFileSync(join(c, 'app.txt'), 'two\n'));
  const ahead = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['fetch', '-q', w.clone, `refs/heads/card/c-1:refs/orchestrate/remote/card/c-1`], { gitDir: w.mirror });
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main };
  const lastBundle = join(w.outbox, 'bundle-C-1.bundle');
  const r = await prepareWorkerCopy({ product, card, dest: join(w.root, 'ff'), lastBundle });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.head, ahead);
  assert.notEqual(r.head, bundleHead);
  // GitHub's copy behind the bundle: the bundle's head is kept.
  await gitOk(['update-ref', 'refs/orchestrate/remote/card/c-1', main], { gitDir: w.mirror });
  assert.equal((await prepareWorkerCopy({ product, card, dest: join(w.root, 'behind'), lastBundle })).head, bundleHead);
  // Went another way: refused, nothing rewritten.
  const other = (await gitOk(['commit-tree', '-p', main, '-m', 'elsewhere', `${main}^{tree}`], { gitDir: w.mirror })).trim();
  await gitOk(['update-ref', 'refs/orchestrate/remote/card/c-1', other], { gitDir: w.mirror });
  assert.match((await prepareWorkerCopy({ product, card, dest: join(w.root, 'diverged'), lastBundle })).reason, /went another way/);
});

// A one-file zip, stored (not packed); `locked` sets the "encrypted" flag a password lock sets.
function makeZip(name, data, { locked = false } = {}) {
  const n = Buffer.from(name); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(locked ? 1 : 0, 6);
  h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(locked ? 1 : 0, 8);
  c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
  const local = Buffer.concat([h, n, data]); const central = Buffer.concat([c, n]);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(central.length, 12); e.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, e]);
}

test('L28: a file the scan cannot fully read is refused by default: a .tgz, a renamed archive, a locked zip, a zip, UTF-16 text, a zip renamed to .png', async () => {
  const secret = Buffer.from(`key = "${fakeSecret()}"\n`);
  const tgz = gzipSync(secret);
  const cases = {
    'pack.tgz': tgz,
    'data.txt': tgz, // a packed file renamed
    'locked.zip': makeZip('cfg.txt', randomBytes(64), { locked: true }),
    'plain.zip': makeZip('cfg.txt', secret),
    'notes16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([...secret].flatMap((b) => [b, 0]))]),
    'docs/pic.png': makeZip('cfg.txt', secret), // inside an allowed path, but not really a PNG
    'docs/tail.png': Buffer.concat([makePng(), makeZip('cfg.txt', secret)]), // a real PNG with an archive after its end
    'docs/ztxt.png': makePng({ extra: [chunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(secret)]))] }), // packed text inside
  };
  for (const [path, bytes] of Object.entries(cases)) {
    const w = await world();
    w.values['product.allowed_binaries'] = [{ path: 'docs/**/*.png', type: 'png' }];
    await w.commit('one', (c) => { mkdirSync(dirname(join(c, path)), { recursive: true }); writeFileSync(join(c, path), bytes); });
    await w.bundle();
    const r = await refusedAndUntouched(w, /cannot be scanned for secrets/);
    assert.ok(r.reason.includes(path), `${path}: ${r.reason}`);
  }
});

test('L28: a real image is allowed only where the rules entry names its type and path, and it is listed in the read-back', async () => {
  const png = makePng();
  // No entry (the first cutover's default), a malformed entry, the wrong type, the wrong path: refused.
  for (const entry of [undefined, 'docs/**/*.png', [{ path: 'docs/**/*.png' }], [{ path: '/docs/*.png', type: 'png' }], [{ path: 'docs/**/*.png', type: 'jpeg' }], [{ path: 'img/*.png', type: 'png' }]]) {
    const w = await world();
    w.values['product.allowed_binaries'] = entry;
    await w.commit('pic', (c) => { mkdirSync(join(c, 'docs', 'a'), { recursive: true }); writeFileSync(join(c, 'docs', 'a', 'pic.png'), png); });
    await w.bundle();
    await refusedAndUntouched(w, /docs\/a\/pic\.png cannot be scanned for secrets/);
  }
  // Planted fault: with the entry, the same push goes through and the image is in the read-back.
  const w = await world();
  w.values['product.allowed_binaries'] = [{ path: 'docs/**/*.png', type: 'png' }];
  await w.commit('pic', (c) => { mkdirSync(join(c, 'docs', 'a'), { recursive: true }); writeFileSync(join(c, 'docs', 'a', 'pic.png'), png); writeFileSync(join(c, 'a.txt'), 'text\n'); });
  await w.bundle();
  const r = await w.push();
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.binaries, [{ path: 'docs/a/pic.png', type: 'png' }]);
  const fact = w.record.list('fact').find((f) => f.id.startsWith('push.'));
  assert.deepEqual(fact.doc.binaries, [{ path: 'docs/a/pic.png', type: 'png' }]);
});

// Files gitleaks dir skips or misreads when given as they are (round 2 MAT-A).
const typed = (secret) => {
  const s = Buffer.from(`key = "${secret}"\n`);
  const pad = (n) => Buffer.alloc(n, 0);
  const tar = Buffer.alloc(512, 0); tar.write('cfg.txt', 0); tar.write('ustar', 257);
  // A packed .tar.gz: the secret is unreadable until the archive is opened.
  const h = Buffer.alloc(512, 0);
  h.write('cfg.txt', 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${s.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  const tgz = gzipSync(Buffer.concat([h, s, pad(512 - s.length), pad(1024)]));
  return {
    'pack.tar.gz': tgz,
    'db.sqlite': Buffer.concat([Buffer.from('SQLite format 3\0'), pad(84), s]),
    'pack.tar': Buffer.concat([tar, s, pad(100)]),
    'pack.zip': Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), pad(26), s]),
    'tool.bin': Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), pad(56), s]),
    'doc.pdf': Buffer.concat([Buffer.from('%PDF-1.4\n%\0\n'), s]),
    'notes16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([...s].flatMap((b) => [b, 0]))]),
  };
};

test('R-0b-47 round 2 MAT-A (L28), real gitleaks: a file that looks like an archive, a program, a database, a PDF or UTF-16 text is refused unread', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  for (const [name, bytes] of Object.entries(typed(fakeSecret()))) {
    // Positive control: gitleaks dir on the file as it is finds nothing.
    const d = tmp(); mkdirSync(join(d, 'f')); writeFileSync(join(d, 'f', name), bytes);
    const { spawnSync } = await import('node:child_process');
    const c = spawnSync(realGitleaks, ['dir', join(d, 'f'), '--config', scanner.config, '--no-banner', '--exit-code', '1']);
    assert.equal(c.status, 0, `control: gitleaks dir alone misses ${name}`);
    const w = await world({ scanner });
    await w.commit('typed', (c2) => { mkdirSync(join(c2, 'deep'), { recursive: true }); writeFileSync(join(c2, 'deep', name), bytes); });
    await w.bundle();
    const r = await refusedAndUntouched(w, /cannot be scanned for secrets/);
    assert.ok(r.reason.includes(`deep/${name}`), `${name}: ${r.reason}`);
  }
});

test('R-0b-47 round 2 MAT-B, real gitleaks: a secret in an extra commit header line or in a file name is stopped', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  // (a) An invented header line, and a signature block, written straight into the commit object.
  let w;
  for (const header of [(x) => `x-note key = "${x}"`, (x) => `gpgsig -----BEGIN PGP SIGNATURE-----\n \n key = "${x}"\n -----END PGP SIGNATURE-----`]) {
    w = await world({ scanner });
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    const head = (await gitOk(['cat-file', 'commit', 'HEAD'], w.cg)).toString();
    const secret = fakeSecret();
    const forged = head.replace(/\n\n/, `\n${header(secret)}\n\n`);
    const sha = (await gitOk(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { ...w.cg, input: forged })).trim();
    await gitOk(['update-ref', 'refs/heads/card/c-1', sha], w.cg);
    // Positive control: the message and author view the old scan read does not hold it.
    assert.doesNotMatch(await gitOk(['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B', sha], w.cg), new RegExp(secret));
    await w.bundle();
    await refusedAndUntouched(w, /header lines or file names: .*likely secret/);
  }
  // (b) A file whose name is the secret.
  w = await world({ scanner });
  const s2 = fakeSecret();
  await w.commit('named', (c) => writeFileSync(join(c, `${s2}.txt`), 'nothing here\n'));
  await w.bundle();
  await refusedAndUntouched(w, /header lines or file names: .*likely secret/);
});

test('R-0b-47 round 2 MIN-a, MIN-c, real gitleaks: an allowed image is still scanned, under each of its names, executable or not', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const w = await world({ scanner });
  w.values['product.allowed_binaries'] = [{ path: 'docs/**/*.png', type: 'png' }];
  const bytes = makePng({ text: `key = "${fakeSecret()}"` });
  await w.commit('twice', (c) => { mkdirSync(join(c, 'docs'), { recursive: true }); for (const n of ['one.png', 'two.png', 'run.png']) writeFileSync(join(c, 'docs', n), bytes); chmodSync(join(c, 'docs', 'run.png'), 0o755); });
  assert.match(await gitOk(['ls-files', '-s', 'docs/run.png'], w.cg), /^100755/);
  await w.bundle();
  const r = await refusedAndUntouched(w, /the file scan: .*likely secret/);
  for (const n of ['one.png', 'two.png', 'run.png']) assert.ok(r.reason.includes(`docs/${n}`), `${n}: ${r.reason}`);
  // MIN-b: a finding names the repo path, never the private scan folder (moved here, round 3 COS-2).
  assert.doesNotMatch(r.reason, /scan-|files\/(raw|text|nul|img)/);
});

test('R-0b-47 round 3 MIN-2 and MAT-1, real gitleaks: an allowed PNG hiding a secret as UTF-16 text or in its image data is refused', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const line = Buffer.from(`key = "${fakeSecret()}"\n`);
  const pixels = Buffer.concat([Buffer.from([0]), line]);
  const cases = {
    'docs/utf16.png': makePng({ text: Buffer.from([...line].flatMap((b) => [b, 0])) }), // only the zero-bytes-removed view reads it
    'docs/pixels.png': makePng({ head: ihdr({ w: line.length }), pixels }), // only the unpacked view reads it
  };
  for (const [path, bytes] of Object.entries(cases)) {
    const w = await world({ scanner });
    w.values['product.allowed_binaries'] = [{ path: 'docs/*.png', type: 'png' }];
    await w.commit('img', (c) => { mkdirSync(join(c, 'docs'), { recursive: true }); writeFileSync(join(c, path), bytes); });
    await w.bundle();
    const r = await refusedAndUntouched(w, /the file scan: .*likely secret/);
    assert.ok(r.reason.includes(path), `${path}: ${r.reason}`);
  }
});

test('R-0b-47 round 3 MIN-1 and MIN-3: base64 of a packed file is refused, and a secret used as a file name never reaches the record in full', async () => {
  let w = await world();
  await w.commit('b64', (c) => writeFileSync(join(c, 'blob.txt'), `${gzipSync(Buffer.from(`key = "${fakeSecret()}"`)).toString('base64')}\n`));
  await w.bundle();
  await refusedAndUntouched(w, /blob\.txt holds packed data written out as text/);
  w = await world();
  const secret = fakeSecret();
  await w.commit('named', (c) => writeFileSync(join(c, `${secret}.zip`), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])));
  await w.bundle();
  const r = await refusedAndUntouched(w, /cannot be scanned for secrets/);
  assert.ok(!r.reason.includes(secret.slice(4)), r.reason);
  assert.ok(!JSON.stringify(w.record.read('fact', 'push.C-1.a1').doc).includes(secret.slice(4)), 'the record holds the secret');  // A finding in a file whose name is secret-shaped: the scan's own reason is masked the same way.
  w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  w.fake.setMode('leakname');
  const f = await refusedAndUntouched(w, /found 1 likely secret.*ghp_…\.txt/);
  assert.ok(!f.reason.includes('A1'.repeat(18)), f.reason);
});

test('R-0b-47 round 2 MIN-d: a new file over the size cap, or new files over the total cap, are refused before they are read', async () => {
  const w = await world();
  await w.commit('big', (c) => { writeFileSync(join(c, 'a.txt'), 'a'.repeat(5000)); writeFileSync(join(c, 'b.txt'), 'b'.repeat(3000)); });
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  const ls = await gitOk(['ls-tree', 'HEAD'], w.cg);
  const blobs = ls.trim().split('\n').map((l) => ({ id: l.split(/\s+/)[2], path: l.split('\t')[1] })).filter((b) => /^[ab]\.txt$/.test(b.path));
  const scan = (o) => scanSecrets({ setup: w.ports.scanner, mirror: w.mirror, shas: [sha], blobs, messages: [], privateDir: tmp(), ...o });
  const before = callLog.length;
  let r = await scan({ maxFileBytes: 4000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /a\.txt is larger than 4000 bytes/);
  assert.ok(!callLog.slice(before).some((c) => c.args[0] === 'cat-file' && c.args[1] === 'blob' && c.args[2] === blobs.find((b) => b.path === 'a.txt').id), 'the big file is never read');
  r = await scan({ maxTotalBytes: 7000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than 7000 bytes/);
  // Planted fault: under both caps the same scan passes.
  assert.deepEqual(await scan({}), { ok: true, binaries: [] });
});

test('R-0b-47 round 4 MIN-3: a git failure\'s reason carries no folder path, and the private folder is left empty', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  // A lock file on the mirror's branch makes the last git step fail with git's own error text.
  const r = await w.push({ afterStage: () => { mkdirSync(join(w.mirror, 'refs/heads/card'), { recursive: true }); writeFileSync(join(w.mirror, 'refs/heads/card/c-1.lock'), ''); } });
  assert.equal(r.ok, false);
  // L680: the push went out, and the mirror could not be written: the mirror's, so a wait that says so.
  assert.equal(r.retry, true, r.reason);
  assert.match(r.reason, /pushed, but the mirror's copy of the branch could not be moved/);
  assert.ok(!r.reason.includes(w.root), r.reason);
  assert.ok(!JSON.stringify(w.record.read('fact', 'push.C-1.a1').doc).includes(w.root), 'the record holds a folder path');
  assert.deepEqual(readdirSync(w.ports.privateDir), []);
});

test('R-0b-47 round 4 MIN-1, real gitleaks: a secret laid across two rows of an allowed PNG is refused', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const line = Buffer.from(`key = "${fakeSecret()}"\n`);
  const half = Math.ceil(line.length / 2);
  const rows = [line.subarray(0, half), Buffer.concat([line.subarray(half), Buffer.alloc(2 * half - line.length, 0x20)])];
  const w = await world({ scanner });
  w.values['product.allowed_binaries'] = [{ path: 'docs/*.png', type: 'png' }];
  const png = makePng({ head: ihdr({ w: half, h: 2 }), pixels: Buffer.concat([Buffer.from([0]), rows[0], Buffer.from([0]), rows[1]]) });
  await w.commit('img', (c) => { mkdirSync(join(c, 'docs'), { recursive: true }); writeFileSync(join(c, 'docs/rows.png'), png); });
  await w.bundle();
  await refusedAndUntouched(w, /the file scan: .*likely secret.*docs\/rows\.png/);
});

// #32 round 3 (L51): safe-git runs a network command only to a local path or the one address the call allows. The
// tests push to local folders, so this checks the source: every call that names GitHub's address allows exactly it.
test('#32 round 3 (L51): every push-script call that names the GitHub address passes it as the allowed address', () => {
  const src = readFileSync(new URL('./push.mjs', import.meta.url), 'utf8');
  assert.match(src, /const auth = \{ extraConfig: tokenConfig\(token\), address: url \};/);
  const calls = src.split('\n').filter((l) => /\b(git|gitOk|gitDo|gitText|run)\(\[/.test(l) && /, url[,\]]/.test(l));
  assert.equal(calls.length, 3, calls.join('\n'));
  for (const l of calls) assert.match(l, /\.\.\.auth \}/, l);
});

// ---- R-0b-127: a bundle from Joe's own tab, through the proposals folder ----
// A stat of the bundle's own handle that says it is owned by `uid` (tests can't chown).
const ownedBy = (uid) => (fd) => { const st = fstatSync(fd); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid }); };
const ORCHESTRATE_UID = ME + 1; // the worker user in pushP's default
const REVIEW_UID = ME + 2;

test('R-0b-127: a proposal bundle is verified, fetched for its card\'s branch only, scanned and pushed exactly like a worker\'s', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const sha256 = await w.propose();
  callLog.length = 0;
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(r.ok, true, r.reason);
  const tip = (await gitOk(['rev-parse', 'refs/heads/card/c-1'], w.cg)).trim();
  assert.equal(r.tip, tip);
  const refs = await w.ghRefs();
  assert.deepEqual(refs.split('\n').map((l) => l.split(' ')[0]).sort(), ['refs/heads/card/c-1', 'refs/heads/main']);
  assert.match(refs, new RegExp(`refs/heads/card/c-1 ${tip}`));
  assert.equal((await gitOk(['rev-parse', 'refs/heads/card/c-1'], { gitDir: w.mirror })).trim(), tip);
  assert.equal(w.prs.length, 1);
  assert.equal(w.prs[0].branch, 'card/c-1');
  assert.match(w.fake.calls(), /git\ndir\nstdin/, 'the secret scan ran');
  const f = w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`).doc;
  assert.equal(f.result, 'pushed');
  assert.equal(f.from, 'proposal');
  assert.equal(w.record.read('fact', 'push.C-1.a1'), null, 'a proposal must not write a worker\'s fact');
  // Only the card's branch is fetched from the bundle, into the attempt's holding ref, which is gone afterwards.
  const fetches = callLog.filter((c) => c.purpose === 'push-fetch-bundle' && c.args[0] === 'fetch');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].args.at(-1), `refs/heads/card/c-1:refs/orchestrate/incoming/C-1/p-${sha256.slice(0, 12)}`);
  assert.notEqual((await git(['rev-parse', '--verify', `refs/orchestrate/incoming/C-1/p-${sha256.slice(0, 12)}`], { gitDir: w.mirror })).code, 0);
  assert.deepEqual(readdirSync(w.ports.privateDir), []);
});

test('L274 (6): the same bytes pushed twice answer the recorded push: no second push, no second pull request, the fact unchanged; new bytes are a new attempt', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const sha256 = await w.propose();
  const first = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(first.ok, true, first.reason);
  const id = `push.C-1.p-${sha256.slice(0, 12)}`;
  const fact = w.record.read('fact', id);
  const refs = await w.ghRefs();
  callLog.length = 0;
  const again = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.deepEqual(again, { ok: true, already: true, product: PRODUCT, card: 'C-1', branch: first.branch, tip: first.tip, binaries: first.binaries ?? [] });
  assert.equal(callLog.length, 0, 'git ran for bytes already pushed');
  assert.equal(await w.ghRefs(), refs);
  assert.equal(w.prs.length, 1);
  assert.deepEqual(w.record.read('fact', id), fact, 'the push fact was rewritten');
  assert.equal(fact.doc.product, PRODUCT);
  // The proposal's own checks still run first (#170 r1 m1): another product, or the card gone from the Record, is
  // refused, not answered from the fact; a corrupt fact is not a push (m2).
  const view = (read) => ({ ...w.record, read });
  w.hold(sha256, 'C-1', 'other-app');
  const other = await w.pushP({ product: 'other-app', card: 'C-1' });
  assert.equal(other.ok, false);
  assert.equal(other.already, undefined);
  const gone = await w.pushP({ product: PRODUCT, card: 'C-1' }, { record: view((e, i) => (e === 'card' ? null : w.record.read(e, i))) });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /card C-1 is not in the Record/);
  // Those refusals are added to the recorded push, never written over it.
  const kept = w.record.read('fact', id).doc;
  assert.deepEqual({ ...kept, last_refusal: undefined }, { ...fact.doc, last_refusal: undefined });
  assert.match(kept.last_refusal.reason, /card C-1 is not in the Record/);
  // New bytes for the same card are a new attempt, pushed and recorded beside the first.
  await w.commit('more docs', (c) => writeFileSync(join(c, 'README.md'), 'better still\n'));
  const sha2 = await w.propose();
  const next = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(next.ok, true, next.reason);
  assert.equal(next.already, undefined);
  assert.equal(w.record.read('fact', `push.C-1.p-${sha2.slice(0, 12)}`).doc.result, 'pushed');
  assert.deepEqual(w.record.read('fact', id).doc, kept);
  w.hold(sha256);
  // Rules that throw (not a refusal) still go through settle: refused, recorded, never thrown out (#170 r2).
  const broke = await w.pushP({ product: PRODUCT, card: 'C-1' }, { rules: { ...w.ports.rules, get: () => { throw new Error('rules broke'); } } });
  assert.equal(broke.ok, false);
  assert.match(w.record.read('fact', id).doc.last_refusal.reason, /rules broke/);
  // So does the shortcut's read of the push fact, when it throws (once, here): it answers, never throws (L344).
  let throws = 1;
  const factBroke = await w.pushP({ product: PRODUCT, card: 'C-1' }, { record: view((e, i) => { if (e === 'fact' && i === id && throws-- > 0) throw new Error('record broke'); return w.record.read(e, i); }) });
  assert.equal(factBroke.ok, false);
  assert.equal(factBroke.already, undefined);
  const corrupt = await w.pushP({ product: PRODUCT, card: 'C-1' }, { record: view((e, i) => { const r = w.record.read(e, i); return e === 'fact' && i === id ? { ...r, corrupt: true } : r; }) });
  assert.equal(corrupt.already, undefined, 'a corrupt fact answered as a push');
  // A refused attempt is not "already": the same bytes are tried again.
  const w2 = await world();
  await w2.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const sha3 = await w2.propose();
  assert.equal((await w2.pushP({ product: PRODUCT, card: 'C-1' }, { testFstat: ownedBy(ME + 7) })).ok, false);
  const retry = await w2.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(retry.ok, true, retry.reason);
  assert.equal(retry.already, undefined);
});

test('L274 (2): a proposal for a card the Record lacks is refused at the push script, and says so; GitHub untouched', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const sha256 = await w.propose();
  w.hold(sha256, 'C-9');
  const refs = await w.ghRefs();
  // The look first: refused, and it records nothing.
  for (const look of [true, false]) {
    const r = await w.pushP({ product: PRODUCT, card: 'C-9' }, { look });
    assert.equal(r.ok, false);
    assert.match(r.reason, /card C-9 is not in the Record/);
    if (look) assert.equal(w.record.read('fact', `push.C-9.p-${sha256.slice(0, 12)}`), null, 'a look recorded a refusal');
  }
  assert.equal(await w.ghRefs(), refs);
  assert.equal(w.prs.length, 0);
  assert.equal(w.record.read('fact', `push.C-9.p-${sha256.slice(0, 12)}`).doc.result, 'refused');
});

test('R-0b-127: look answers the net change\'s files and pushes, asks and records nothing', async () => {
  const w = await world();
  await w.commit('docs', (c) => { writeFileSync(join(c, 'README.md'), 'better\n'); writeFileSync(join(c, 'notes.md'), 'new\n'); });
  await w.commit('more', (c) => rmSync(join(c, 'notes.md')));
  const sha256 = await w.propose();
  const before = await w.ghRefs();
  pushAsked.length = 0;
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, { look: true });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.files, [{ path: 'README.md', status: 'modified', mode: '100644' }], 'the net change, not each commit\'s');
  assert.equal(r.sha256, sha256, 'it says which bytes it looked at');
  assert.equal(await w.ghRefs(), before);
  assert.equal(w.prs.length, 0);
  assert.equal(pushAsked.length, 0, 'the rules were asked');
  assert.equal(w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`), null, 'a look wrote a fact');
  assert.deepEqual(readdirSync(w.ports.privateDir), []);
  // A look at a refused change is refused the same way.
  const w2 = await world();
  await w2.commit('wf', (c) => writeFileSync(join(c, '.github/workflows/x.yml'), 'on: push\n'));
  await w2.propose();
  const l2 = await w2.pushP({ product: PRODUCT, card: 'C-1' }, { look: true });
  assert.equal(l2.ok, false);
  assert.match(l2.reason, /\.github\/workflows\/x\.yml/);
});

test('R-0b-127 planted (D3): a proposal touching a workflow file, and one adding a link, are refused at the push script; GitHub untouched', async () => {
  for (const [what, fn, re] of [
    ['workflow', (c) => writeFileSync(join(c, '.github/workflows/x.yml'), 'on: push\n'), /files no card may: .*\.github\/workflows\/x\.yml/],
    ['changed workflow', (c) => writeFileSync(join(c, '.github/workflows/ci.yml'), 'name: changed\n'), /\.github\/workflows\/ci\.yml/],
    ['link', (c) => symlinkSync('app.txt', join(c, 'l')), /link/],
    ['link to /etc', (c) => symlinkSync('/etc', join(c, 'etc')), /link/],
  ]) {
    const w = await world();
    await w.commit(what, fn);
    const sha256 = await w.propose();
    const before = await w.ghRefs();
    const r = await w.pushP({ product: PRODUCT, card: 'C-1' });
    assert.equal(r.ok, false, `${what} was not refused`);
    assert.match(r.reason, re, what);
    assert.equal(await w.ghRefs(), before, `GitHub changed on ${what}`);
    assert.equal(w.prs.length, 0);
    const f = w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`).doc;
    assert.equal(f.result, 'refused');
    assert.equal(f.from, 'proposal');
  }
});

test('R-0b-127 planted (L76 (3), L77 m2): a proposals bundle owned by orchestrate or by review is refused; a worker bundle owned by Joe is refused; a normal worker bundle still pushes', async () => {
  for (const [who, uid] of [['orchestrate', ORCHESTRATE_UID], ['review', REVIEW_UID]]) {
    const w = await world();
    await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
    const sha256 = await w.propose();
    const before = await w.ghRefs();
    const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, { testFstat: ownedBy(uid) });
    assert.equal(r.ok, false, `a bundle owned by ${who} was pushed`);
    assert.equal(r.reason, `the bundle is owned by user ${uid}, not user ${ME}`);
    assert.equal(await w.ghRefs(), before);
  }
  // The worker's door expects the worker: a bundle in its outbox owned by Joe is refused.
  let w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  const joe = w.ports.ownerUid;
  const r = await refusedAndUntouched(w, /owned by user/, { testFstat: ownedBy(joe) });
  assert.equal(r.reason, `the bundle is owned by user ${joe}, not user ${ME}`);
  // And the normal worker bundle, owned by the worker, pushes.
  w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  const ok = await w.push();
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(w.record.read('fact', 'push.C-1.a1').doc.result, 'pushed');
  assert.equal(w.record.read('fact', 'push.C-1.a1').doc.from, undefined);
});

test('R-0b-127: the proposal\'s bytes must be the ones the intake recorded; a swap after intake, or a wrong hash, is refused', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const recorded = await w.propose();
  await w.commit('more', (c) => writeFileSync(join(c, 'app.txt'), 'sneaked in\n'));
  const swapped = await w.propose();
  assert.notEqual(swapped, recorded);
  w.hold(recorded);
  const before = await w.ghRefs();
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'the bundle\'s bytes are not the ones the intake recorded');
  assert.equal(await w.ghRefs(), before);
  const l = await w.pushP({ product: PRODUCT, card: 'C-1' }, { look: true });
  assert.equal(l.reason, 'the bundle\'s bytes are not the ones the intake recorded', 'a look checks the bytes too');
  assert.equal(w.record.read('fact', `push.C-1.p-${recorded.slice(0, 12)}`).doc.result, 'refused');
  // The bytes now in the folder, once the intake holds their own hash, are a new attempt and go through.
  w.hold(swapped);
  const ok = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(w.record.read('fact', `push.C-1.p-${swapped.slice(0, 12)}`).doc.result, 'pushed');
});

// ---- R-0b-128 part 2: the conditions on the proposal door (L325)

const bundleFile = (w) => join(w.proposals, 'bundle-C-1.bundle');
const docChange = async (w) => { await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n')); return w.propose(); };

test('L325 m1: the push script reads which bytes from the intake\'s fact: nothing held, or a hash from the caller, pushes nothing', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const p = join(w.proposals, 'bundle-C-1.bundle');
  await gitOk(['bundle', 'create', '-q', p, 'refs/heads/card/c-1', '^refs/heads/main'], w.cg);
  const sha256 = createHash('sha256').update(readFileSync(p)).digest('hex');
  const before = await w.ghRefs();
  // No fact: even the right hash, named by the caller, is nothing.
  const none = await w.pushP({ product: PRODUCT, card: 'C-1', sha256 });
  // A wait, never final: the intake read it held this same pass, so only a Record fault or a race says otherwise (L680).
  assert.deepEqual(none, { ok: false, reason: 'the intake holds no bundle for this card', retry: true });
  assert.equal(await w.ghRefs(), before);
  // A file the intake refused is not held.
  w.hold(sha256, 'C-1', PRODUCT, 'refused');
  assert.equal((await w.pushP({ product: PRODUCT, card: 'C-1' })).reason, 'the intake holds no bundle for this card');
  // Another product's fact holds nothing for this one.
  w.hold(sha256, 'C-1', 'other-app');
  assert.equal((await w.pushP({ product: PRODUCT, card: 'C-1' })).reason, 'the intake holds no bundle for this card');
  // A hash that isn't one, however the fact came to say so.
  w.hold('x'.repeat(64));
  assert.equal((await w.pushP({ product: PRODUCT, card: 'C-1' })).reason, 'the intake holds no bundle for this card');
  // A held fact that reads back corrupt holds nothing, though its hash is the right one (L597 minor).
  w.hold(sha256);
  const heldId = intakeFactId(PRODUCT, 'bundle-C-1.bundle');
  const corruptView = { ...w.record, read: (e, i) => { const r = w.record.read(e, i); return e === 'fact' && i === heldId ? { ...r, corrupt: true } : r; } };
  assert.equal((await w.pushP({ product: PRODUCT, card: 'C-1' }, { record: corruptView })).reason, 'the intake holds no bundle for this card');
  w.hold('x'.repeat(64));
  assert.equal(await w.ghRefs(), before);
  assert.deepEqual(w.record.list('fact').filter((f) => f.id.startsWith('push.')), [], 'a refusal with no attempt files no fact');
  // Held: a caller's other hash changes nothing, and the fact is what is checked.
  w.hold(sha256);
  const r = await w.pushP({ product: PRODUCT, card: 'C-1', sha256: 'a'.repeat(64) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`).doc.result, 'pushed');
});

test('L325 m2: a refusal that may pass by itself says retry: true and files that; a final one does not', async () => {
  const ok = async () => { const w = await world(); await docChange(w); return w; };
  const answer = async (w, over) => { const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, over); assert.equal(r.ok, false); return r; };
  const cases = [
    ['no robot key', async (w) => ({ getRobotToken: async () => '' }), /^no robot key/],
    ['a robot key that throws', async () => ({ getRobotToken: async () => { throw new Error('no'); } }), /^no robot key/],
    ['GitHub unreadable', async (w) => ({ testRemote: () => join(w.root, 'nowhere.git') }), /^could not read GitHub$/],
    ['fetch failed', async (w) => { await gitOk(['update-ref', '-d', 'refs/heads/main'], { gitDir: w.gh }); return {}; }, /^could not fetch main from GitHub$/],
    ['the mirror', async (w) => { w.values['product.mirror'] = join(w.root, 'no-mirror'); return {}; }, /^mirror: /],
    ['a mirror that fails its own check', async (w) => { mkdirSync(join(w.mirror, 'hooks'), { recursive: true }); writeFileSync(join(w.mirror, 'hooks', 'post-update'), '#!/bin/sh\n'); return {}; }, /^mirror: mirror has hooks: post-update$/],
    ['the start gate', async () => ({ workflowRule: async () => ({ ok: false, reason: 'no rule' }) }), /^the start gate is shut: /],
    ['GitHub refused', async (w) => { const h = join(w.gh, 'hooks', 'pre-receive'); writeFileSync(h, '#!/bin/sh\nexit 1\n'); chmodSync(h, 0o755); return {}; }, /^GitHub refused the push$/],
  ];
  for (const [name, set, re] of cases) {
    const w = await ok();
    const r = await answer(w, await set(w));
    assert.match(r.reason, re, name);
    assert.equal(r.retry, true, name);
    const [f] = w.record.list('fact').filter((x) => x.id.startsWith('push.C-1.p-'));
    assert.equal(f.doc.retry, true, `${name}: the fact says so`);
  }
  // Final ones: no retry.
  const w = await world();
  await w.commit('wf', (c) => writeFileSync(join(c, '.github/workflows/x.yml'), 'on: push\n'));
  await w.propose();
  const end = await answer(w, {});
  assert.equal(end.retry, undefined);
  assert.equal(w.record.list('fact').filter((x) => x.id.startsWith('push.C-1.p-'))[0].doc.retry, undefined);
  const w2 = await world();
  w2.hold('a'.repeat(64));
  // No bundle in the folder at the moment: it may yet be there (the owner's tab rewriting it), so it is a wait (L669 M1).
  const gone = await answer(w2, {});
  assert.equal(gone.reason, 'no bundle in the outbox');
  assert.equal(gone.retry, true);
});

test('L669 M1: a fault outside the bundle (the Record, the rules, the folder, the script itself) is a wait, never a final no', async () => {
  const view = (w, read) => ({ ...w.record, read });
  const cases = [
    ['the Record throwing', (w) => ({ record: view(w, (e, i) => { if (e === 'fact') throw new Error(`EIO: ${w.root}/record/x.json`); return w.record.read(e, i); }) }), /^the push script failed: EIO: <path>/],
    ['the card not there this once', (w) => ({ record: view(w, (e, i) => (e === 'card' ? null : w.record.read(e, i))) }), /^card C-1 is not in the Record$/],
    ['not onboarded yet', (w) => ({ rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.onboarded': false } }) }), /not onboarded/],
    ['no proposals folder in the rules', (w) => ({ rules: fakeRules({ answers: w.answers, values: { ...w.values, 'proposals.outbox': undefined } }) }), /no proposals folder in the rules/],
    ['the outbox gone', (w) => { rmSync(w.proposals, { recursive: true, force: true }); return {}; }, /^the outbox is missing$/],
    // L680 (plants R5, R6): the product's setup is fixed in the rules, and the same bytes go on.
    ['no repo in the rules', (w) => ({ rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.repo': undefined } }) }), /no valid GitHub repo in the rules/],
    ['no mirror in the rules', (w) => ({ rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.mirror': undefined } }) }), /no mirror in the rules/],
  ];
  for (const [name, set, re] of cases) {
    const w = await world();
    await docChange(w);
    const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, set(w));
    assert.equal(r.ok, false, name);
    assert.match(r.reason, re, name);
    assert.ok(!r.reason.includes(w.root), `${name}: no local path`);
    assert.equal(r.retry, true, `${name}: may pass by itself`);
    assert.ok(!(await w.ghRefs()).includes('refs/heads/card/c-1'), `${name}: nothing pushed`);
  }
});

// ---- L680: one rule for every git call. A git that did not finish or start is a wait; git's own answer is final when
// the command asks about the bundle, and a wait when it asks about GitHub or the mirror. ----
const nothingPushed = async (w, name) => assert.ok(!(await w.ghRefs()).includes('refs/heads/card/c-1'), `${name}: nothing pushed`);
const withFake = async (rules, testGit = {}) => {
  const w = await world();
  await docChange(w);
  const fake = makeFakeGit(join(w.root, 'fake-git'), rules);
  return { w, fake, push: () => w.pushP({ product: PRODUCT, card: 'C-1' }, { testGit: { bin: fake.bin, ...testGit } }) };
};

test('L680: the fake git runs the real one for a command it has no rule for, so a push through it passes', async () => {
  const { w, fake, push } = await withFake([]);
  const r = await push();
  assert.equal(r.ok, true, r.reason);
  assert.ok(fake.calls().includes('diff-tree') && fake.calls().includes('ls-remote'), fake.calls().join(' '));
  assert.ok((await w.ghRefs()).includes('refs/heads/card/c-1'));
});

test('L680: a git that runs past its time limit is a wait, whatever it was asked', async () => {
  for (const [cmd, has] of [['check-ref-format'], ['ls-remote'], ['bundle'], ['fetch', '.bundle'], ['rev-list'], ['diff-tree'], ['cat-file'], ['push']]) {
    const { w, push } = await withFake([{ cmd, has, sleep: true }], { timeouts: { [cmd]: 1500 } });
    const r = await push();
    assert.equal(r.ok, false, cmd);
    assert.match(r.reason, /git did not finish/, cmd);
    assert.equal(r.retry, true, `${cmd}: a stall may pass by itself`);
    await nothingPushed(w, cmd);
  }
});

test('L680: a git that does not start is a wait, and so is a git too old to trust', async () => {
  for (const cmd of ['check-ref-format', 'diff-tree', 'bundle', 'fetch']) {
    const { w, push } = await withFake([], { failStart: [cmd] });
    const r = await push();
    assert.equal(r.ok, false, cmd);
    assert.equal(r.retry, true, `${cmd}: ${r.reason}`);
    await nothingPushed(w, cmd);
  }
  const { w, push } = await withFake([{ cmd: '--version', stdout: 'git version 1.0.0\n' }]);
  const r = await push();
  assert.equal(r.ok, false);
  assert.match(r.reason, /older than/);
  assert.equal(r.retry, true);
  await nothingPushed(w, 'version');
});

// git's and the system's words for a fault of the Mac (push.mjs MAC_FAULT), each as git says it (L702 M1: pinned). Each
// text holds only its own word, so taking any one word out of MAC_FAULT fails its row (the first three once all held two).
const MAC_WORDS = [
  "error: cannot lock ref 'refs/orchestrate/incoming/C-1/p-x': is at 0123456 but expected 89abcde\n",
  "fatal: Unable to create '/m/refs/orchestrate/incoming/C-1/p-x.lock': Not a directory\n",
  "error: unable to write file /m/x.lock': File exists\n",
  'fatal: write error: No space left on device\n',
  'fatal: write error: Disk quota exceeded\n',
  'error: unable to create temporary file: Read-only file system\n',
  'error: index-pack died of signal 9\n',
  'fatal: Out of memory, malloc failed (tried to allocate 8388608 bytes)\n',
  "fatal: Unable to create temporary file '/m/objects/pack/tmp_pack_XXXXXX': Permission denied\n",
  'fatal: Too many open files\n',
  'fatal: cannot fork() for index-pack\n',
  'fatal: mmap failed: Cannot allocate memory\n',
  "error: unable to write file '/m/objects/pack/x.pack': Operation not permitted\n",
  'fatal: read error: Input/output error\n',
  'error: unable to fork\n',
  'error: Resource temporarily unavailable\n',
];

test('L680: git\'s own answer is final about the bundle, and a wait about GitHub or the mirror', async () => {
  const cases = [
    // About the bundle's own names and commits: final.
    [{ cmd: 'check-ref-format', code: 128, stderr: "fatal: 'card/c-1' is not a valid branch name\n" }, /is not a valid name/, undefined],
    [{ cmd: 'diff-tree', code: 128, stderr: 'fatal: bad object\n' }, /could not list a commit's changes/, undefined],
    [{ cmd: 'rev-list', code: 128, stderr: 'fatal: bad object\n' }, /could not list the branch's commits/, undefined],
    [{ cmd: 'cat-file', code: 128, stderr: 'fatal: bad object\n' }, /could not read commit/, undefined],
    [{ cmd: 'bundle', code: 1, stderr: 'error: missing prerequisite\n' }, /does not verify/, undefined],
    [{ cmd: 'fetch', has: '.bundle', code: 128, stderr: 'fatal: early EOF\n' }, /its pack is cut off or missing objects/, undefined],
    // A commit's added lines, read for an allow comment, are the bundle's own (L702 minor 6, plant X14).
    [{ cmd: 'diff-tree', has: '--no-color', code: 128, stderr: 'fatal: bad object\n' }, /could not read a commit's changes/, undefined],
    // A real git's answer to a bundle missing an earlier commit says so (verify without -q): final.
    [{ cmd: 'bundle', code: 1, stderr: 'error: Repository lacks these prerequisite commits:\nerror: 0123456789012345678901234567890123456789\n' }, /does not verify/, undefined],
    // About GitHub or the mirror: a wait.
    // The bundle's command failing for a reason of the Mac's, or with no words at all: a wait (L702 M1, minor 1).
    ...MAC_WORDS.map((stderr) => [{ cmd: 'fetch', has: '.bundle', code: 1, stderr }, /git failed on this Mac, not on the bundle/, true]),
    [{ cmd: 'fetch', has: '.bundle', code: 1, stderr: '' }, /git failed with no message/, true],
    [{ cmd: 'fetch', has: '.bundle', code: 1, stderr: '  \n' }, /git failed with no message/, true],
    [{ cmd: 'diff-tree', code: 128, stderr: 'fatal: Out of memory, malloc failed (tried to allocate 1048576 bytes)\n' }, /not on the bundle/, true],
    [{ cmd: 'bundle', code: 1, stderr: 'error: Too many open files\n' }, /not on the bundle/, true],
    [{ cmd: 'rev-list', code: 128, stderr: '' }, /git failed with no message/, true],
    [{ cmd: 'ls-remote', code: 128 }, /could not read GitHub/, true],
    // Where the branch leaves main, and the mirror after the push: the mirror's, a wait (L702 minor 6, plant X8).
    [{ cmd: 'merge-base', has: 'refs/heads/main', code: 128, stderr: 'fatal: bad object\n' }, /could not find where the branch leaves main/, true],
    [{ cmd: 'fetch', has: 'refs/heads/main', code: 128, stderr: 'fatal: unable to access\n' }, /could not fetch main from GitHub/, true],
    [{ cmd: 'push', code: 1 }, /^GitHub refused the push$/, true],
    // GitHub's own words go in the reason, path-cut (L702 minor 2); its size limit and secret blocking are final.
    [{ cmd: 'push', code: 1, stderr: 'remote: error: GH001: Large files detected. You may want to try Git Large File Storage.\nremote: error: File docs/big.bin is 120.00 MB\n' }, /^GitHub refused the push: error: GH001: Large files detected\..* is 120\.00 MB$/, undefined],
    // In GitHub's own order GH001 comes last, after the trace and one line per large file (#262 r4 N1, L713): still final,
    // and its line is told first.
    [{ cmd: 'push', code: 1, stderr: 'remote: error: Trace: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nremote: error: See https://gh.io/lfs for more information.\nremote: error: File docs/a-very-long-folder-name/and-a-long-file-name-number-one.bin is 120.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB\nremote: error: File docs/a-very-long-folder-name/and-a-long-file-name-number-two.bin is 130.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB\nremote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.\n' }, /^GitHub refused the push: error: GH001: Large files detected\./, undefined],
    // A bundle whose object asks for more memory than any Mac has is broken: final (#262 r4 N2).
    [{ cmd: 'fetch', has: '.bundle', code: 128, stderr: 'fatal: Out of memory, malloc failed (tried to allocate 1152921504606846977 bytes)\n' }, /its pack is cut off or missing objects|does not|could not/, undefined],
    [{ cmd: 'push', code: 1, stderr: 'remote: error: GH013: Repository rule violations found for refs/heads/card/c-1.\nremote: - Push cannot contain secrets\n' }, /^GitHub refused the push: error: GH013: Repository rule violations/, undefined],
    [{ cmd: 'push', code: 1, stderr: 'remote: Internal Server Error /Users/someone/x\nTo /some/where\n ! [remote rejected] card/c-1 (failed)\n' }, /^GitHub refused the push: Internal Server Error <path>$/, true],
  ];
  for (const [rule, re, retry] of cases) {
    const name = `${rule.cmd} ${rule.code} ${JSON.stringify(rule.stderr ?? '')}`;
    const { w, push } = await withFake([rule]);
    const r = await push();
    assert.equal(r.ok, false, name);
    assert.match(r.reason, re, name);
    // git's words reach Joe path-cut (L702: the Mac-fault reason through plainError).
    assert.doesNotMatch(r.reason, /\/m\/|\/Users\//, name);
    assert.equal(r.retry, retry, `${name}: ${r.reason}`);
    await nothingPushed(w, name);
  }
});

test('L680 minor: merge-base --is-ancestor\'s exit 1 is "moved" (final); any other failure of it is a wait', async () => {
  for (const [code, re, retry] of [[1, /has moved/, undefined], [128, /could not compare the branch on GitHub/, true]]) {
    const w = await world();
    await docChange(w);
    assert.equal((await w.pushP({ product: PRODUCT, card: 'C-1' })).ok, true);
    await w.commit('more', (c) => writeFileSync(join(c, 'README.md'), 'better still\n'));
    await w.propose();
    const before = await w.ghRefs();
    const fake = makeFakeGit(join(w.root, 'fake-git'), [{ cmd: 'merge-base', has: '--is-ancestor', code }]);
    const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, { testGit: { bin: fake.bin } });
    assert.equal(r.ok, false, String(code));
    assert.match(r.reason, re, String(code));
    assert.equal(r.retry, retry, `${code}: ${r.reason}`);
    assert.equal(await w.ghRefs(), before);
  }
});

test('L702 minor 3: merge-base main <tip>\'s exit 1 is "no shared history" (final); any other failure of it is a wait', async () => {
  for (const [code, re, retry] of [[1, /^the branch shares no history with main$/, undefined], [128, /could not find where the branch leaves main/, true]]) {
    const { w, push } = await withFake([{ cmd: 'merge-base', has: 'refs/heads/main', code, stderr: code === 128 ? 'fatal: bad object\n' : '' }]);
    const r = await push();
    assert.equal(r.ok, false, String(code));
    assert.match(r.reason, re, String(code));
    assert.equal(r.retry, retry, `${code}: ${r.reason}`);
    await nothingPushed(w, String(code));
  }
});

// Each git call of the research copy is about main in the mirror, not the report's bytes: a wait (L702 minor 6, plants
// X9-X12, X15, X16).
test('L702 minor 6: each git call of the research copy that fails is a wait, and nothing is pushed', async () => {
  for (const [rule, re] of [
    [{ cmd: 'ls-tree' }, /could not read main's files/],
    [{ cmd: 'mktree' }, /could not build the copy's files/],
    [{ cmd: 'hash-object' }, /could not store the report/],
    [{ cmd: 'rev-parse', has: 'main^{commit}' }, /could not read main in the mirror/],
    [{ cmd: 'rev-parse', has: 'main^{tree}' }, /could not read main in the mirror/],
    [{ cmd: 'commit-tree' }, /could not make the copy's commit/],
    [{ cmd: 'update-ref', has: 'refs/orchestrate/incoming/' }, /could not hold the copy's commit/],
  ]) {
    const name = `${rule.cmd} ${rule.has ?? ''}`;
    const w = await researchWorld();
    const fake = makeFakeGit(join(w.root, 'fake-git'), [{ ...rule, code: 128, stderr: 'fatal: bad object\n' }]);
    const r = await researchRefused(w, re, undefined, { testGit: { bin: fake.bin } });
    assert.equal(r.retry, true, `${name}: ${r.reason}`);
    assert.ok(fake.calls().includes(rule.cmd), name);
  }
});

test('L680 (plant R4): a bundle in the outbox that is a link is refused for good; one not there is a wait', async () => {
  const w = await world();
  const sha256 = await docChange(w);
  const p = join(w.proposals, 'bundle-C-1.bundle');
  renameSync(p, join(w.root, 'real.bundle'));
  symlinkSync(join(w.root, 'real.bundle'), p);
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'the bundle in the outbox is a link');
  assert.equal(r.retry, undefined, 'final');
  await nothingPushed(w, 'link');
  assert.ok(sha256);
});

// The auditor's three broken bundles (r2): `bundle verify` reads only the header, so each fails at the fetch, and each is
// the bundle's own fault: refused, never a wait (L680 M1).
const rehold = (w) => w.hold(createHash('sha256').update(readFileSync(join(w.proposals, 'bundle-C-1.bundle'))).digest('hex'));
const raw = async (w, args, input) => { const r = await git(args, { ...w.cg, input }); assert.equal(r.code, 0, r.stderr); return r.stdout; };

test('L680 M1: a cut-off bundle, one whose branch names a tree, and one missing an object are each refused, never a wait', async () => {
  const control = await world();
  await docChange(control);
  assert.equal((await control.pushP({ product: PRODUCT, card: 'C-1' })).ok, true, 'control: a whole bundle passes');
  const breaks = {
    'cut off': async (w) => { const p = join(w.proposals, 'bundle-C-1.bundle'); const b = readFileSync(p); writeFileSync(p, b.subarray(0, b.length - 30)); },
    'a tree for a branch': async (w) => {
      const tree = (await raw(w, ['rev-parse', 'card/c-1^{tree}'])).toString().trim();
      const objs = (await raw(w, ['ls-tree', '-r', 'card/c-1'])).toString().trim().split('\n').map((l) => l.split(/\s+/)[2]);
      const pack = await raw(w, ['pack-objects', '-q', '--stdout'], Buffer.from(`${[...objs, tree].join('\n')}\n`));
      writeFileSync(join(w.proposals, 'bundle-C-1.bundle'), Buffer.concat([Buffer.from(`# v2 git bundle\n${tree} refs/heads/card/c-1\n\n`), pack]));
    },
    'a missing object': async (w) => {
      const tip = (await raw(w, ['rev-parse', 'card/c-1'])).toString().trim();
      const main = (await raw(w, ['rev-parse', 'main'])).toString().trim();
      const pack = await raw(w, ['pack-objects', '-q', '--stdout'], Buffer.from(`${tip}\n`));
      writeFileSync(join(w.proposals, 'bundle-C-1.bundle'), Buffer.concat([Buffer.from(`# v2 git bundle\n-${main} first\n${tip} refs/heads/card/c-1\n\n`), pack]));
    },
  };
  for (const [name, spoil] of Object.entries(breaks)) {
    const w = await world();
    await docChange(w);
    await spoil(w);
    rehold(w);
    const r = await w.pushP({ product: PRODUCT, card: 'C-1' });
    assert.equal(r.ok, false, name);
    assert.equal(r.retry, undefined, `${name}: the bundle's own fault is final: ${r.reason}`);
    assert.ok(!r.reason.includes(w.root), `${name}: no local path`);
    await nothingPushed(w, name);
  }
});

test('L325 m3: refusals with no real card or attempt share no fact, at any door', async () => {
  const w = await world();
  const before = w.record.list('fact').length;
  assert.equal((await w.pushP({ product: PRODUCT, card: 'no/such' })).ok, false);
  assert.equal((await w.pushP({ product: PRODUCT, card: 'C-77' })).ok, false);
  assert.equal((await createPushScript(w.ports)('S-404')).ok, false);
  assert.equal((await createPushScript(w.ports).pushResearch({ product: PRODUCT, card: 'no/such' })).ok, false);
  assert.equal(w.record.list('fact').length, before);
});

test('L325 m4: the branch already at this tip is an answer of ok, and a pushed fact is never written over', async () => {
  const w = await world();
  const sha256 = await docChange(w);
  const first = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(first.ok, true, first.reason);
  const id = `push.C-1.p-${sha256.slice(0, 12)}`;
  const fact = structuredClone(w.record.read('fact', id));
  const noFact = { record: { ...w.record, read: (e, i) => (e === 'fact' && i === id ? null : w.record.read(e, i)) } };
  // The fact lost after the push: the branch is checked again and stays where it is.
  const refs = await w.ghRefs();
  const again = await w.pushP({ product: PRODUCT, card: 'C-1' }, noFact);
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.tip, first.tip);
  assert.equal(await w.ghRefs(), refs);
  // Main has since taken that commit: no new commits, and still ok, with nothing pushed.
  await gitOk(['update-ref', 'refs/heads/main', first.tip], { gitDir: w.gh });
  const merged = await w.pushP({ product: PRODUCT, card: 'C-1' }, noFact);
  assert.equal(merged.ok, true, merged.reason);
  assert.equal(merged.commits, 0);
  assert.equal(merged.tip, first.tip);
  assert.deepEqual(w.record.read('fact', id).doc, fact.doc, 'the pushed fact is kept');
  // A look at that same state has no change to show, and a worker's door keeps its refusal.
  const look = await w.pushP({ product: PRODUCT, card: 'C-1' }, { look: true, ...noFact });
  assert.equal(look.ok, false);
  assert.match(look.reason, /no new commits/);
});

test('L325 m5: a rename over the bundle after the open pushes what was opened', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const sha256 = await w.propose();
  const tip = (await gitOk(['rev-parse', 'refs/heads/card/c-1'], w.cg)).trim();
  const other = join(w.root, 'other.bundle');
  await w.commit('more', (c) => writeFileSync(join(c, 'app.txt'), 'sneaked in\n'));
  await gitOk(['bundle', 'create', '-q', other, 'refs/heads/card/c-1', '^refs/heads/main'], w.cg);
  const swap = (fd) => { const st = fstatSync(fd); renameSync(other, bundleFile(w)); return st; };
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, { testFstat: swap });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.tip, tip, 'the bytes on the handle, not the name');
  assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${tip}`));
  assert.equal(w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`).doc.tip, tip);
});

test('L325 m5: a bundle that grows past the cap while it is read is refused', async () => {
  const w = await world();
  await docChange(w);
  const size = statSync(bundleFile(w)).size;
  const before = await w.ghRefs();
  const grow = (fd) => { const st = fstatSync(fd); appendFileSync(bundleFile(w), 'x'.repeat(2 << 20)); return st; };
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, { testFstat: grow, bundleCap: size + 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, `the bundle is larger than ${size + 100} bytes`);
  assert.equal(await w.ghRefs(), before);
});

test('L325 m5: a sha that differs only in its last character is another hash', async () => {
  const w = await world();
  const sha256 = await docChange(w);
  w.hold(`${sha256.slice(0, -1)}${sha256.endsWith('0') ? '1' : '0'}`);
  const before = await w.ghRefs();
  const r = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'the bundle\'s bytes are not the ones the intake recorded');
  assert.equal(await w.ghRefs(), before);
});

test('L325 m6: the push script and the intake agree on how loose a proposals folder may be', async () => {
  const w = await world();
  await docChange(w);
  for (const mode of [0o700, 0o750, 0o755, 0o770, 0o777, 0o751, 0o760]) {
    chmodSync(w.proposals, mode);
    const r = await w.pushP({ product: PRODUCT, card: 'C-1' }, { look: true });
    const intake = folderProblem(w.proposals, ME);
    assert.equal(r.ok, intake === null, `mode ${mode.toString(8)}: ${r.reason} / ${intake}`);
    if (!r.ok) assert.equal(r.reason, 'the folder is looser than 750');
  }
});

test('L325 cosmetics: no root as the worker or owner; the test fstat port outside tests; a worker attempt can\'t take a door\'s prefix', async () => {
  const w = await world();
  assert.throws(() => createPushScript({ ...w.ports, ownerUid: 0 }), /ownerUid must be a Mac user id/);
  assert.throws(() => createPushScript({ ...w.ports, uids: { worker: 0 } }), /uids\.worker must be a Mac user id/);
  const ctx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.throws(() => createPushScript({ ...w.ports, testFstat: fstatSync }), /testFstat is for tests only/);
    assert.equal(typeof createPushScript(w.ports), 'function');
  } finally { process.env.NODE_TEST_CONTEXT = ctx; }
  for (const attempt of ['p-abc', 'r-abc']) {
    const cur = w.record.read('session', 'S-1');
    assert.equal(w.record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: cur.rev, doc: { ...cur.doc, attempt } }).ok, true);
    assert.equal((await w.push()).reason, 'the launch record has a bad attempt id');
  }
  const cur = w.record.read('session', 'S-1');
  assert.equal(w.record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: cur.rev, doc: { ...cur.doc, card: 7 } }).ok, true);
  assert.equal((await w.push()).reason, 'the launch record has a bad card id');
});

// ---- R-0b-128 part 2: the real docs check: the push script's own list, M10's own answer (L77 m1)

// The card as its creator would have written it, declared Tier 2.
const tierTwo = (w) => ({ ...w.record, read: (e, i) => { const r = w.record.read(e, i); return e === 'card' && r ? { ...r, doc: { ...r.doc, tier: 2 } } : r; } });
const realDocsCheck = (w, rules = { may: (a, s) => realEngine().may(a, s) }, over = {}) => createDocsCheck({ record: tierTwo(w), rules, pushProposal: createPushScript({ ...w.ports, uids: { worker: ME + 1 }, ownerUid: ME, ...over }).pushProposal });
const check = (w, sha256, ...args) => realDocsCheck(w, ...args)({ product: PRODUCT, card: 'C-1', bundle: { path: join(w.proposals, 'bundle-C-1.bundle'), sha256 } });
const added = async (w, file, mode) => {
  await w.commit('change', (c) => { mkdirSync(dirname(join(c, file)), { recursive: true }); writeFileSync(join(c, file), 'text\n'); if (mode) chmodSync(join(c, file), mode); });
  return w.propose();
};

test('R-0b-128: the docs check passes a real docs change, and nothing is pushed or recorded by asking', async () => {
  const w = await world();
  const sha256 = await added(w, 'docs/notes.md');
  const before = await w.ghRefs();
  assert.equal(await check(w, sha256), null);
  assert.equal(await w.ghRefs(), before);
  assert.equal(w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`), null);
});

test('R-0b-128: the docs check says no to code and to a runnable doc, from the bundle\'s own files', async () => {
  for (const [file, mode, re] of [['app.txt', undefined, /outside the docs and research lane/], ['docs/run.md', 0o755, /mode "?100755"? is a link, submodule or runnable file/]]) {
    const w = await world();
    const sha256 = await added(w, file, mode);
    assert.match(await check(w, sha256), re, file);
  }
});

test('R-0b-128: the docs check asks M10 with the list the push script read', async () => {
  const w = await world();
  const sha256 = await added(w, 'docs/notes.md');
  const asked = [];
  const answer = await check(w, sha256, { may: (a, s) => { asked.push([a, s]); return { decision: 'deny', reason: 'not this lane\'s change' }; } });
  assert.equal(answer, 'not this lane\'s change');
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], 'merge');
  assert.deepEqual(asked[0][1].files, [{ path: 'docs/notes.md', status: 'added', mode: '100644' }]);
  assert.equal(asked[0][1].declared_tier, 2);
  assert.equal(asked[0][1].truncated, false);
});

test('R-0b-128, L597 (2): a look that could not finish is a wait, and so are bytes moved since the pass checked them; a final look refusal is a refusal', async () => {
  const w = await world();
  const sha256 = await added(w, 'docs/notes.md');
  assert.deepEqual(await check(w, sha256, undefined, { getRobotToken: async () => '' }), { retry: 'no robot key for this product' });
  assert.deepEqual(await check(w, 'a'.repeat(64)), { retry: 'the bundle held changed while it was checked' });
  w.hold('b'.repeat(64));
  assert.deepEqual(await check(w, sha256), { retry: 'the bundle\'s bytes are not the ones the intake recorded' });
  w.hold(sha256);
  await w.commit('ci', (c) => writeFileSync(join(c, '.github/workflows/ci.yml'), 'name: other\n'));
  const code = await w.propose();
  assert.match((await check(w, code)).refuse, /touches files no card may/);
});

test('L597 (2): M10 saying no for a reason that is not the change (a pause, its own error) is a wait; its answer about the change is final', async () => {
  const w = await world();
  const sha256 = await added(w, 'docs/notes.md');
  const said = (decision, reason) => ({ may: () => ({ decision, reason }) });
  assert.deepEqual(await check(w, sha256, said('deny', 'product is paused: only an exact reverse may merge')), { retry: 'the rules said no for now: product is paused: only an exact reverse may merge' });
  assert.deepEqual(await check(w, sha256, makeRules({ may: () => { throw new Error('rules unreadable for p1'); } })), { retry: 'the rules said no for now: rules error: rules unreadable for p1' });
  assert.equal(await check(w, sha256, said('deny', 'not this lane\'s change; MAIN merges it as today: x')), 'not this lane\'s change; MAIN merges it as today: x');
  assert.equal(await check(w, sha256, said('ask', 'Tier 1')), 'Tier 1');
});

test('L597 (4): the docs check sends the card\'s own tier: a Tier 1 card\'s docs change is not the docs lane\'s', async () => {
  const w = await world();
  const sha256 = await added(w, 'docs/notes.md');
  const tier = (t) => ({ ...w.record, read: (e, i) => { const r = w.record.read(e, i); return e === 'card' && r ? { ...r, doc: { ...r.doc, tier: t } } : r; } });
  const pushProposal = createPushScript({ ...w.ports, uids: { worker: ME + 1 }, ownerUid: ME }).pushProposal;
  const rules = { may: (a, s) => realEngine().may(a, s) };
  const bundle = { path: join(w.proposals, 'bundle-C-1.bundle'), sha256 };
  assert.equal(await createDocsCheck({ record: tier(2), rules, pushProposal })({ product: PRODUCT, card: 'C-1', bundle }), null);
  for (const t of [1, undefined]) assert.match(await createDocsCheck({ record: tier(t), rules, pushProposal })({ product: PRODUCT, card: 'C-1', bundle }), /not declared Tier 2/, String(t));
});

test('R-0b-127: the proposal door\'s own inputs: no product, a bad card, no or a bad sha256, no proposals folder, a folder not the owner\'s', async () => {
  const w = await world();
  await w.commit('docs', (c) => writeFileSync(join(c, 'README.md'), 'better\n'));
  const sha256 = await w.propose();
  const before = await w.ghRefs();
  const cases = [
    [{ card: 'C-1' }, {}, 'the proposal names no product'],
    [{ product: PRODUCT, card: '../C-1' }, {}, 'the proposal has a bad card id'],
    [{ product: PRODUCT, card: 7 }, {}, 'the proposal has a bad card id'],
    [{ product: PRODUCT, card: ['C-1'] }, {}, 'the proposal has a bad card id'],
    [{ product: PRODUCT, card: 'C-1' }, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'proposals.outbox': undefined } }) }, 'the product has no proposals folder in the rules'],
    [{ product: PRODUCT, card: 'C-1' }, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'proposals.outbox': 'proposals' } }) }, 'the product has no proposals folder in the rules'],
    [{ product: PRODUCT, card: 'C-1' }, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'proposals.outbox': `${w.proposals}/../proposals` } }) }, 'the product has no proposals folder in the rules'],
    // The owner is someone else and so is the bundle (as faked): the folder, really the test user's, is refused first.
    [{ product: PRODUCT, card: 'C-1' }, { ownerUid: ME + 5, uids: { worker: ME + 1 }, testFstat: ownedBy(ME + 5) }, `the folder is owned by user ${ME}, not user ${ME + 5}`],
  ];
  for (const [input, over, reason] of cases) {
    const r = await w.pushP(input, over);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason);
  }
  assert.equal(await w.ghRefs(), before);
  assert.equal(w.prs.length, 0);
  // Input that can't name a fact writes none (L325 m3); the caller has the answer. A real one still does.
  assert.equal(w.record.read('fact', 'push.C-1.unknown'), null);
  assert.equal(w.record.read('fact', `push.unknown.p-${sha256.slice(0, 12)}`), null);
  assert.equal(w.record.read('fact', `push.C-1.p-${sha256.slice(0, 12)}`).doc.result, 'refused');
});

test('R-0b-127: a push script is never made without the worker\'s and the owner\'s users, or with one user for both', async () => {
  const w = await world();
  const { uids, ownerUid, ...rest } = w.ports;
  assert.throws(() => createPushScript(rest), /uids\.worker must be a Mac user id/);
  assert.throws(() => createPushScript({ ...rest, uids: { worker: '501' }, ownerUid }), /uids\.worker must be a Mac user id/);
  assert.throws(() => createPushScript({ ...rest, uids }), /ownerUid must be a Mac user id/);
  assert.throws(() => createPushScript({ ...rest, uids, ownerUid: -1 }), /ownerUid must be a Mac user id/);
  assert.throws(() => createPushScript({ ...rest, uids: { worker: ME }, ownerUid: ME }), /different users/);
  const p = createPushScript(w.ports);
  assert.equal(typeof p, 'function');
  assert.equal(p.pushCard, p);
  assert.equal(typeof p.pushProposal, 'function');
});

// ---- the research copy (L286, L290, L313): the third door. The script makes the one commit itself, from the bytes ----
// A BOM, Windows line ends, a character past ASCII and no last line end: any text handling on the way changes one.
const REPORT_BYTES = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Rivals\r\n\r\nPlans run 20% under the caf\u00e9.\r\nNo last line end')]);
const RC = RESEARCH_CARD('R-1');
const RBRANCH = 'card/research-r-1';
const RPATH = 'docs/research/research-R-1.md';
const blobOf = (b) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const sha256Of = (b) => createHash('sha256').update(b).digest('hex');
const SETTLED = new Date(Date.now() - 3_600_000);

// A world with a ready research_copy card, made by the one card shape, and its report in the proposals folder.
async function researchWorld(bytes = REPORT_BYTES, { over = {} } = {}) {
  const w = await world();
  const file = join(w.proposals, 'research-R-1.md');
  const put = (b = bytes) => { rmSync(file, { force: true }); writeFileSync(file, b); utimesSync(file, SETTLED, SETTLED); };
  put();
  const doc = { ...researchCardDoc({ askId: 'R-1', product: PRODUCT, name: 'research-R-1.md', sha256: sha256Of(bytes), blob: blobOf(bytes), size: bytes.length }), ...over };
  // A card is created in draft and moved, as the Record takes it.
  assert.equal(w.record.write({ actor: 'dispatcher', entity: 'card', id: RC, expectRev: 0, doc: { ...doc, state: 'draft' } }).ok, true);
  if (over.state !== 'draft') { const m = w.record.write({ actor: 'dispatcher', entity: 'card', id: RC, expectRev: 1, doc: { ...doc, state: over.state ?? 'ready' } }); assert.equal(m.ok, true, m.reason); }
  const factOf = () => `push.${RC}.r-${sha256Of(bytes).slice(0, 12)}`;
  const pushR = (input = { product: PRODUCT, card: RC }, ports = {}) => createPushScript({ ...w.ports, uids: { worker: ME + 1 }, ownerUid: ME, ...ports }).pushResearch(input);
  const mainTip = async () => (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.gh })).trim();
  // A branch or a main commit put on "GitHub" by something other than this script.
  const onGitHub = async (ref, fn) => {
    const cg = w.cg;
    await gitOk(['checkout', '-q', '-B', 'side', 'main'], cg);
    fn(w.clone);
    await gitOk(['add', '-A'], cg);
    await gitOk(['commit', '-q', '-m', 'side'], cg);
    await gitOk(['push', '-q', '-f', w.gh, `HEAD:${ref}`], cg);
  };
  return { ...w, file, put, pushR, factOf, mainTip, onGitHub };
}

async function researchRefused(w, re, input, ports) {
  const before = await w.ghRefs();
  const r = await w.pushR(input, ports);
  assert.equal(r.ok, false, 'should be refused');
  assert.match(r.reason, re);
  assert.equal(await w.ghRefs(), before, 'GitHub changed on a refusal');
  assert.deepEqual(readdirSync(w.ports.privateDir), [], 'a work folder was left behind');
  return r;
}

test('L286: one commit on main, made by the script: the report byte for byte at its one path, and the merge gate\'s refusal 10 passes', async () => {
  const w = await researchWorld();
  const main = await w.mainTip();
  pushAsked.length = 0;
  const r = await w.pushR();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.branch, RBRANCH);
  const g = { gitDir: w.gh };
  assert.equal((await gitOk(['rev-parse', `refs/heads/${RBRANCH}`], g)).trim(), r.tip);
  assert.equal((await gitOk(['rev-parse', `${r.tip}^`], g)).trim(), main, 'its one parent is main as fetched');
  assert.equal((await gitOk(['rev-list', '--count', `${main}..${r.tip}`], g)).trim(), '1');
  assert.equal((await gitOk(['log', '-1', '--format=%an', r.tip], g)).trim(), 'orchestrate');
  // Every byte, as git holds them: the BOM, the \r\n and the missing last line end.
  const held = await git(['cat-file', 'blob', `${r.tip}:${RPATH}`], g);
  assert.deepEqual(held.stdout, REPORT_BYTES);
  const change = (await gitOk(['diff-tree', '-r', '--no-renames', '--no-commit-id', '--raw', main, r.tip], g)).trim();
  assert.equal(change, `:000000 100644 ${'0'.repeat(40)} ${blobOf(REPORT_BYTES)} A\t${RPATH}`);
  // What the merge gate will judge: refusal 10, on the change as made.
  const card = w.record.read('card', RC);
  assert.equal(researchCopyProblem({ card, files: [{ path: RPATH, status: 'added', mode: '100644', blob: blobOf(REPORT_BYTES) }] }), null);
  // M10's real push_branch was asked, and took the card by its docs lane (L384 5).
  assert.equal(pushAsked.length, 1);
  assert.deepEqual(pushAsked[0].card, { id: RC, kind: 'research_copy', rows: [], doc: { lane: 'docs', files: [RPATH] } });
  assert.deepEqual(pushAsked[0].files, [{ path: RPATH, status: 'added' }]);
  // The same core: the scan ran, a PR opened with the card's words, the fact says what door it came by.
  assert.match(w.fake.calls(), /git\ndir\nstdin/, 'the secret scan ran');
  assert.equal(w.prs.length, 1);
  assert.equal(w.prs[0].branch, RBRANCH);
  assert.match(w.prs[0].title, /copy research ask R-1's report/);
  const f = w.record.read('fact', w.factOf()).doc;
  assert.deepEqual([f.result, f.from, f.product, f.tip], ['pushed', 'research', PRODUCT, r.tip]);
  assert.equal((await gitOk(['rev-parse', `refs/heads/${RBRANCH}`], { gitDir: w.mirror })).trim(), r.tip, 'the mirror\'s branch moved');
  assert.equal((await git(['rev-parse', '--verify', '-q', `refs/orchestrate/incoming/${RC}/${w.factOf().split('.')[2]}`], { gitDir: w.mirror })).code === 0, false, 'the holding ref is gone');
});

test('L286: main\'s other files stay as they are, and a report already at the path is updated, not replaced with a new tree', async () => {
  const w = await researchWorld();
  await w.onGitHub('refs/heads/main', (c) => {
    mkdirSync(join(c, 'docs/research'), { recursive: true });
    writeFileSync(join(c, 'docs/research/research-R-1.md'), 'an older copy\n');
    writeFileSync(join(c, 'docs/research/other.md'), 'keep me\n');
    writeFileSync(join(c, 'docs/top.md'), 'keep me too\n');
    chmodSync(join(c, 'app.txt'), 0o755);
  });
  const main = await w.mainTip();
  const r = await w.pushR();
  assert.equal(r.ok, true, r.reason);
  const g = { gitDir: w.gh };
  const diff = (await gitOk(['diff-tree', '-r', '--no-renames', '--no-commit-id', '--name-status', main, r.tip], g)).trim();
  assert.equal(diff, `M\t${RPATH}`);
  assert.equal((await gitOk(['ls-tree', r.tip, 'app.txt'], g)).split(' ')[0], '100755', 'a file\'s mode is left as it was');
});

test('L286: the same bytes answer the recorded push again: nothing goes to GitHub twice', async () => {
  const w = await researchWorld();
  const first = await w.pushR();
  const refs = await w.ghRefs();
  const rev = w.record.read('fact', w.factOf()).rev;
  const again = await w.pushR();
  assert.deepEqual([again.ok, again.already, again.tip], [true, true, first.tip]);
  assert.equal(await w.ghRefs(), refs);
  assert.equal(w.record.read('fact', w.factOf()).rev, rev, 'the fact is left as it is');
  assert.equal(w.prs.length, 1);
});

test('L286: a push whose fact was lost: the one commit on GitHub counts as it, through the same checks, and nothing moves', async () => {
  const w = await researchWorld();
  const first = await w.pushR();
  const f = w.record.read('fact', w.factOf());
  assert.equal(w.record.write({ actor: 'workshop', entity: 'fact', id: w.factOf(), expectRev: f.rev, doc: { result: 'refused', reason: 'stand-in for a lost fact', at: new Date().toISOString() } }).ok, true);
  const refs = await w.ghRefs();
  w.fake.setMode('leak');
  const scanned = await w.pushR();
  assert.equal(scanned.ok, false, 'a branch already on GitHub is scanned like any other');
  w.fake.setMode('clean');
  const r = await w.pushR();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.tip, first.tip);
  assert.equal(await w.ghRefs(), refs);
  assert.equal(w.record.read('fact', w.factOf()).doc.tip, first.tip);
});

test('L286: a card branch on GitHub holding anything else is refused and left there, never forced', async () => {
  const cases = [
    ['other bytes at the path', (c) => { mkdirSync(join(c, 'docs/research'), { recursive: true }); writeFileSync(join(c, RPATH), 'not the report\n'); }, /not exactly the report/],
    ['the report plus another file', (c) => { mkdirSync(join(c, 'docs/research'), { recursive: true }); writeFileSync(join(c, RPATH), REPORT_BYTES); writeFileSync(join(c, 'app.txt'), 'and this\n'); }, /not exactly the report/],
    ['another file only', (c) => { writeFileSync(join(c, 'app.txt'), 'only this\n'); }, /not exactly the report/],
    // L441 m1, m2: the report is first by name here, so only the count and the mode refuse these.
    ['the report plus a later file', (c) => { mkdirSync(join(c, 'docs/research'), { recursive: true }); writeFileSync(join(c, RPATH), REPORT_BYTES); writeFileSync(join(c, 'z-later.txt'), 'and this\n'); }, /not exactly the report/],
    ['the report, executable', (c) => { mkdirSync(join(c, 'docs/research'), { recursive: true }); writeFileSync(join(c, RPATH), REPORT_BYTES); chmodSync(join(c, RPATH), 0o755); }, /not exactly the report/],
  ];
  for (const [name, fn, re] of cases) {
    const w = await researchWorld();
    await w.onGitHub(`refs/heads/${RBRANCH}`, fn);
    await researchRefused(w, re, undefined, undefined);
    assert.equal(w.prs.length, 0, name);
  }
  // L441 m1: a file renamed onto the path, the report's bytes and all, takes the old name off main with it.
  const moved = await researchWorld();
  await moved.onGitHub('refs/heads/main', (c) => writeFileSync(join(c, 'z-plan.md'), REPORT_BYTES));
  mkdirSync(join(moved.clone, 'docs/research'), { recursive: true });
  renameSync(join(moved.clone, 'z-plan.md'), join(moved.clone, RPATH));
  await gitOk(['add', '-A'], moved.cg);
  await gitOk(['commit', '-q', '-m', 'renamed'], moved.cg);
  await gitOk(['push', '-q', '-f', moved.gh, `HEAD:refs/heads/${RBRANCH}`], moved.cg);
  await researchRefused(moved, /not exactly the report/, undefined, undefined);
  // The right net change, in two commits, is still not the one copy commit.
  const w = await researchWorld();
  await w.onGitHub(`refs/heads/${RBRANCH}`, (c) => writeFileSync(join(c, 'app.txt'), 'first\n'));
  await gitOk(['checkout', '-q', 'side'], w.cg);
  await gitOk(['revert', '--no-edit', 'HEAD'], w.cg);
  mkdirSync(join(w.clone, 'docs/research'), { recursive: true });
  writeFileSync(join(w.clone, RPATH), REPORT_BYTES);
  await gitOk(['add', '-A'], w.cg);
  await gitOk(['commit', '-q', '--amend', '-m', 'two'], w.cg);
  await gitOk(['push', '-q', '-f', w.gh, `HEAD:refs/heads/${RBRANCH}`], w.cg);
  await researchRefused(w, /more than the one copy commit/, undefined, undefined);
});

test('L290: a report that is not the bytes the intake recorded is refused before anything is staged, with the one reason M11 tells', async () => {
  const REASON = /the report's bytes are not the ones the intake recorded/;
  const same = Buffer.from(REPORT_BYTES); same[10] ^= 1;
  for (const b of [same, Buffer.concat([REPORT_BYTES, Buffer.from('x')]), REPORT_BYTES.subarray(1)]) {
    const w = await researchWorld();
    w.put(b);
    await researchRefused(w, REASON);
    assert.equal(w.fake.calls(), '', 'no scan ran: it stopped at the read');
    assert.equal(w.record.read('fact', w.factOf()).doc.result, 'refused');
  }
  // Written over after the file was opened: the read is of that one handle, so the new bytes are what is judged.
  const w = await researchWorld();
  await researchRefused(w, REASON, undefined, { testFstat: (fd) => { writeFileSync(w.file, same); utimesSync(w.file, SETTLED, SETTLED); return fstatSync(fd); } });
});

test('L286: a report the secret scan can\'t read is refused like any file, and nothing is staged', async () => {
  const bad = Buffer.concat([Buffer.from('# Report\n'), Buffer.from([0xff, 0xfe, 0x41])]);
  await researchRefused(await researchWorld(bad), /cannot be scanned for secrets/);
});

test('L290: the one safe open: a link, a second name, the wrong owner, a folder that is a link or anyone else\'s, or a file still settling', async () => {
  const w = await researchWorld();
  await researchRefused(w, /owned by user/, undefined, { testFstat: ownedBy(ME + 7) });
  await researchRefused(w, /owned by user/, undefined, { ownerUid: ME + 7, uids: { worker: ME } });
  writeFileSync(w.file, REPORT_BYTES); // written just now
  await researchRefused(w, /changed a moment ago/);
  const ahead = new Date(Date.now() + 3_600_000);
  utimesSync(w.file, ahead, ahead);
  await researchRefused(w, /changed a moment ago/);
  utimesSync(w.file, SETTLED, SETTLED);
  const elsewhere = join(w.root, 'elsewhere.md');
  writeFileSync(elsewhere, REPORT_BYTES);
  rmSync(w.file);
  symlinkSync(elsewhere, w.file);
  await researchRefused(w, /missing, a link, or has more than one name/);
  rmSync(w.file);
  await researchRefused(w, /missing, a link, or has more than one name/);
  writeFileSync(w.file, REPORT_BYTES); utimesSync(w.file, SETTLED, SETTLED);
  linkSync(w.file, join(w.root, 'second-name.md'));
  const r = await researchRefused(w, /missing, a link, or has more than one name/);
  assert.doesNotMatch(r.reason, new RegExp(w.root), 'no machine path in the reason');
  const w2 = await researchWorld();
  renameSync(w2.proposals, `${w2.proposals}-real`);
  symlinkSync(`${w2.proposals}-real`, w2.proposals);
  await researchRefused(w2, /not a plain folder/);
});

test('L286: the card alone says what is copied: only a ready research_copy card of this product, naming its ask\'s one file, with proof', async () => {
  const none = await researchWorld();
  await researchRefused(none, /not in the Record/, { product: PRODUCT, card: 'research-R-9' });
  await researchRefused(none, /names no product/, { card: RC });
  await researchRefused(none, /bad card id/, { product: PRODUCT, card: '../x' });
  await researchRefused(none, /another product's/, { product: 'p2', card: RC });
  await researchRefused(none, /not a research_copy card/, { product: PRODUCT, card: 'C-1' });
  for (const [over, re] of [
    [{ state: 'draft' }, /is draft, not ready/],
    [{ files: [RPATH, 'app.txt'] }, /does not name its ask's one file/],
    [{ files: ['docs/research/research-R-2.md'] }, /does not name its ask's one file/],
    [{ research_ask: 'R-2' }, /does not name its ask's one file/],
    // L441 m8: names that agree with each other, for an ask id that is no id.
    [{ research_ask: '../../x', files: ['docs/research/research-../../x.md'], source: { file: 'research-../../x.md', sha256: sha256Of(REPORT_BYTES), blob: blobOf(REPORT_BYTES), size: REPORT_BYTES.length } }, /does not name its ask's one file/],
    [{ source: { file: 'other.md', sha256: sha256Of(REPORT_BYTES), blob: blobOf(REPORT_BYTES), size: REPORT_BYTES.length } }, /does not name its ask's one file/],
    [{ source: { file: 'research-R-1.md', sha256: 'x', blob: blobOf(REPORT_BYTES), size: REPORT_BYTES.length } }, /no proof of the report's bytes/],
    [{ source: { file: 'research-R-1.md', sha256: sha256Of(REPORT_BYTES), blob: 'x', size: REPORT_BYTES.length } }, /no proof of the report's bytes/],
    [{ source: { file: 'research-R-1.md', sha256: sha256Of(REPORT_BYTES), blob: blobOf(REPORT_BYTES), size: 0 } }, /no proof of the report's bytes/],
  ]) await researchRefused(await researchWorld(REPORT_BYTES, { over }), re);
  // A blob id that isn't these bytes': the sha256 matches, the blob doesn't, and no commit is made.
  await researchRefused(await researchWorld(REPORT_BYTES, { over: { source: { file: 'research-R-1.md', sha256: sha256Of(REPORT_BYTES), blob: 'a'.repeat(40), size: REPORT_BYTES.length } } }), /not the ones the intake recorded/);
  // The other way round: the blob matches and the sha256 doesn't. Both proofs are checked; neither stands in for the other.
  await researchRefused(await researchWorld(REPORT_BYTES, { over: { source: { file: 'research-R-1.md', sha256: sha256Of(Buffer.from('other bytes')), blob: blobOf(REPORT_BYTES), size: REPORT_BYTES.length } } }), /not the ones the intake recorded/);
  const w = await researchWorld();
  await researchRefused(w, /no proposals folder/, undefined, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'proposals.outbox': undefined } }) });
});

test('L286: it meets the same core as any commit: the scan, a gitleaks:allow line, the rules, the start gate', async () => {
  const leak = await researchWorld();
  leak.fake.setMode('leak');
  await researchRefused(leak, /secret/i);
  const allow = Buffer.from('# Report\n\nkey = x # gitleaks:allow\n');
  await researchRefused(await researchWorld(allow), /gitleaks:allow/);
  const w = await researchWorld();
  await researchRefused(w, /not allow/, undefined, { rules: fakeRules({ answers: { push_branch: deny('frozen') }, values: w.values }) });
  const noLane = await researchWorld(REPORT_BYTES, { over: { lane: undefined } });
  await researchRefused(noLane, /card has no lane/);
  const shut = await researchWorld();
  await researchRefused(shut, /start gate/, undefined, { workflowRule: async () => ({ ok: false, reason: 'shut' }) });
  // A report that can't sit where its folder should be: main has `docs` as a file.
  const file = await researchWorld();
  await file.onGitHub('refs/heads/main', (c) => writeFileSync(join(c, 'docs'), 'a file\n'));
  await researchRefused(file, /main has docs as a file/);
  // Main already holds these bytes: nothing to copy.
  const held = await researchWorld();
  await held.onGitHub('refs/heads/main', (c) => { mkdirSync(join(c, 'docs/research'), { recursive: true }); writeFileSync(join(c, RPATH), REPORT_BYTES); });
  await researchRefused(held, /main already holds these bytes/);
});

test('SETTLE_MS is one value: the intake\'s is the push script\'s', () => {
  assert.equal(INTAKE_SETTLE_MS, SETTLE_MS);
});

// ---- The card's head (L387): the merge path reads it for a review ask and a merge request, and only the push may write it ----
const moveCard = (rec, id, fields) => {
  const c = rec.read('card', id);
  const m = rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: c.rev, doc: { ...c.doc, ...fields } });
  assert.equal(m.ok, true, m.reason);
};
const toReview = (rec, id) => {
  if (rec.read('card', id).doc.state === 'draft') moveCard(rec, id, { state: 'ready' });
  moveCard(rec, id, { state: 'claimed', claim: { kind: 'tab', claim_id: 'c-1', host: 'the-host' } });
  moveCard(rec, id, { state: 'running' });
  moveCard(rec, id, { state: 'in_review' });
};
async function askedAfter(rec) {
  const asked = [];
  await timeLimits({ rec, rules: rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) }), now: Date.now() + 86_400_000,
    b: { band: 'green', own_building: 'open', pace: 0.5, prodBlocked: false }, gateAlive: () => true, hasReviewer: async () => false,
    requestReview: async (x) => { asked.push(x); return { ok: true }; }, alert: fakeAlert() });
  return asked;
}

test('L387: a worker\'s push reaches the review request with the pushed head, and nothing here writes it by hand', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  const r = await w.push();
  assert.equal(r.ok, true, r.reason);
  toReview(w.record, 'C-1');
  const asked = await askedAfter(w.record);
  assert.ok(asked.length > 0, 'a reviewer was asked for');
  for (const a of asked) assert.equal(a.head, r.tip);
});

test('L387: all three doors write the head they pushed, and a repeat of it writes nothing', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  const sha256 = await w.propose();
  const p = await w.pushP({ product: PRODUCT, card: 'C-1' });
  assert.equal(p.ok, true, p.reason);
  assert.equal(w.record.read('card', 'C-1').doc.head, p.tip);
  const rev = w.record.read('card', 'C-1').rev;
  assert.equal((await w.pushP({ product: PRODUCT, card: 'C-1' })).already, true);
  assert.equal(w.record.read('card', 'C-1').rev, rev);
  const rw = await researchWorld();
  const r = await rw.pushR();
  assert.equal(r.ok, true, r.reason);
  const card = rw.record.read('card', RC).doc;
  assert.deepEqual([card.head, card.state], [r.tip, 'ready'], 'the head is written and the card makes no move');
  // A refused push writes no head.
  const leak = await researchWorld();
  leak.fake.setMode('leak');
  await researchRefused(leak, /secret/i);
  assert.equal(leak.record.read('card', RC).doc.head, undefined);
});

test('L387: a new head on a verified card sends it back to in_review, as M9 asks', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  const one = await w.pushP({ product: PRODUCT, card: 'C-1', sha256: await w.propose() });
  assert.equal(one.ok, true, one.reason);
  toReview(w.record, 'C-1');
  moveCard(w.record, 'C-1', { state: 'verified' });
  await w.commit('more', (c) => writeFileSync(join(c, 'app.txt'), 'changed again\n'));
  const two = await w.pushP({ product: PRODUCT, card: 'C-1', sha256: await w.propose() });
  assert.equal(two.ok, true, two.reason);
  assert.notEqual(two.tip, one.tip);
  const c = w.record.read('card', 'C-1').doc;
  assert.deepEqual([c.head, c.state], [two.tip, 'in_review']);
});

test('L387: a refused head write is finished by the next try of the same bytes, at each door that remembers a push', async () => {
  const refusing = (t) => ({ ...Object.fromEntries(Object.keys(t).map((k) => [k, typeof t[k] === 'function' ? t[k].bind(t) : t[k]])),
    write: (x) => (x.entity === 'card' ? { ok: false, reason: 'no push while the card is merging' } : t.write(x)) });
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  const sha256 = await w.propose();
  const input = { product: PRODUCT, card: 'C-1' };
  assert.equal((await w.pushP(input, { record: refusing(w.record) })).ok, true);
  assert.equal(w.record.read('card', 'C-1').doc.head, undefined);
  const p = await w.pushP(input);
  assert.deepEqual([p.ok, p.already, w.record.read('card', 'C-1').doc.head], [true, undefined, p.tip], p.reason);
  assert.equal((await w.pushP(input)).already, true, 'with the head written, the bytes answer the recorded push again');
  const rw = await researchWorld();
  assert.equal((await rw.pushR(undefined, { record: refusing(rw.record) })).ok, true);
  assert.equal(rw.record.read('card', RC).doc.head, undefined);
  const r = await rw.pushR();
  assert.deepEqual([r.ok, r.already, rw.record.read('card', RC).doc.head], [true, undefined, r.tip], r.reason);
});

test('L387: a refused head write leaves the push pushed and says so in its fact; a lost race is tried again', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  const t = w.record;
  const wrap = (write) => ({ ...Object.fromEntries(Object.keys(t).map((k) => [k, typeof t[k] === 'function' ? t[k].bind(t) : t[k]])), write });
  let tries = 0;
  const refused = wrap((x) => { if (x.entity === 'card') { tries += 1; return { ok: false, reason: 'no push while the card is merging' }; } return t.write(x); });
  const r = await w.push({ record: refused });
  assert.equal(r.ok, true, r.reason);
  assert.equal(tries, 2);
  assert.equal(t.read('card', 'C-1').doc.head, undefined);
  assert.deepEqual([t.read('fact', 'push.C-1.a1').doc.result, t.read('fact', 'push.C-1.a1').doc.head_refused], ['pushed', 'no push while the card is merging']);
  let first = true;
  const raced = wrap((x) => { if (x.entity === 'card' && first) { first = false; return { ok: false, reason: 'the card changed' }; } return t.write(x); });
  const again = await w.push({ record: raced });
  assert.equal(again.ok, true, again.reason);
  assert.equal(t.read('card', 'C-1').doc.head, again.tip);
  assert.equal(t.read('fact', 'push.C-1.a1').doc.head_refused, undefined, 'a later good write clears the note');
});
