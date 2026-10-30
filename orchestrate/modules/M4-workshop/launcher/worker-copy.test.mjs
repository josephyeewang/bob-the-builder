// R-0b-31 done-when: launch checks 1–2, Archon's right-repo and path-safety tests (rewritten from
// their description, not ported code), and the Claude-only agent seam. All repos are throwaway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOk, initMirror } from '../git/safe-git.mjs';
import { prepareWorkerCopy, safeJoin, removeProtected, isProtectedName } from './worker-copy.mjs';
import { agentAdapter, adapterNames, SEAM_CALLS } from './agent-seam.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'orch-wc-'));
const REPO = 'example-owner/example-repo';

async function commitAll(dir, msg) {
  const o = { gitDir: join(dir, '.git'), workTree: dir, cwd: dir };
  await gitOk(['add', '-A'], o);
  await gitOk(['commit', '-q', '-m', msg], o);
  return (await gitOk(['rev-parse', 'HEAD'], o)).trim();
}

// A source repo whose main holds main's own Claude files, mirrored into a bare mirror.
async function fixture() {
  const root = tmp();
  const src = join(root, 'src');
  mkdirSync(src);
  await gitOk(['init', '-q', src], { gitDir: join(src, '.git') });
  mkdirSync(join(src, '.claude'));
  writeFileSync(join(src, '.claude', 'settings.json'), '{"main":true}\n');
  writeFileSync(join(src, '.mcp.json'), '{"mainServers":{}}\n');
  mkdirSync(join(src, 'pkg'));
  writeFileSync(join(src, 'pkg', 'CLAUDE.local.md'), 'main local notes\n');
  writeFileSync(join(src, 'a.txt'), 'a\n');
  const c1 = await commitAll(src, 'main 1');
  const mirror = join(root, 'mirror.git');
  await initMirror(mirror);
  await gitOk(['fetch', '-q', src, 'refs/heads/main:refs/heads/main'], { gitDir: mirror });
  return { root, src, mirror, c1, product: { repo: REPO, mirror } };
}

const card = (c, extra = {}) => ({ id: 'C-12', repo: REPO, commit: c, ...extra });

test('check 1: the right repo at the card commit gives a clean copy on the card branch', async () => {
  const f = await fixture();
  const dest = join(f.root, 'w1');
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.head, f.c1);
  assert.equal(r.branch, 'card/c-12');
  assert.equal(readFileSync(join(dest, '.claude', 'settings.json'), 'utf8'), '{"main":true}\n');
  assert.deepEqual(r.restored.sort(), ['.claude/settings.json', '.mcp.json', 'pkg/CLAUDE.local.md']);
});

test('check 1: a card for the wrong repo is refused (right-repo)', async () => {
  const f = await fixture();
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1, { repo: 'other-owner/other-repo' }), dest: join(f.root, 'w') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not the product's repo/);
  assert.equal(existsSync(join(f.root, 'w')), false);
});

test('check 1: a wrong commit is refused (unknown, or not on main)', async () => {
  const f = await fixture();
  const unknown = await prepareWorkerCopy({ product: f.product, card: card('0'.repeat(40)), dest: join(f.root, 'w') });
  assert.match(unknown.reason, /not in the mirror/);
  // A commit that exists in the mirror but only on a side branch.
  writeFileSync(join(f.src, 'b.txt'), 'b\n');
  await gitOk(['checkout', '-q', '-b', 'side'], { gitDir: join(f.src, '.git'), workTree: f.src, cwd: f.src });
  const side = await commitAll(f.src, 'side');
  await gitOk(['fetch', '-q', f.src, 'refs/heads/side:refs/heads/side'], { gitDir: f.mirror });
  const off = await prepareWorkerCopy({ product: f.product, card: card(side), dest: join(f.root, 'w') });
  assert.match(off.reason, /not on main/);
  const short = await prepareWorkerCopy({ product: f.product, card: card('abc123'), dest: join(f.root, 'w') });
  assert.match(short.reason, /full commit id/);
});

test('check 1: an existing folder, a bad card id or a mirror with planted config is refused', async () => {
  const f = await fixture();
  mkdirSync(join(f.root, 'taken'));
  assert.match((await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: join(f.root, 'taken') })).reason, /already exists/);
  assert.match((await prepareWorkerCopy({ product: f.product, card: card(f.c1, { id: '../x' }), dest: join(f.root, 'w') })).reason, /bad card id/);
  writeFileSync(join(f.mirror, 'config'), readFileSync(join(f.mirror, 'config'), 'utf8') + '[core]\n\tfsmonitor = x\n');
  assert.match((await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: join(f.root, 'w') })).reason, /mirror: .*differs/);
});

// A restart: the worker's branch, with planted Claude files, comes back as a bundle.
async function plantedBundle(f) {
  const w = join(f.root, 'w-first');
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: w });
  assert.equal(r.ok, true, r.reason);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'untouched\n');
  writeFileSync(join(w, '.claude', 'settings.json'), '{"planted":true}\n');
  mkdirSync(join(w, 'src', '.claude', 'skills', 'evil'), { recursive: true });
  writeFileSync(join(w, 'src', '.claude', 'skills', 'evil', 'SKILL.md'), 'planted\n');
  mkdirSync(join(w, 'lib'));
  symlinkSync(outside, join(w, 'lib', '.claude'));
  mkdirSync(join(w, 'pkg2'));
  writeFileSync(join(w, 'pkg2', '.MCP.json'), '{"planted":1}\n');
  writeFileSync(join(w, 'work.txt'), 'real work\n');
  const head = await commitAll(w, 'worker work');
  const bundle = join(f.root, 'bundle-C-12.bundle');
  await gitOk(['bundle', 'create', '-q', bundle, 'refs/heads/card/c-12'], { gitDir: join(w, '.git'), cwd: w });
  return { bundle, head, outside };
}

test('check 1–2: a restart takes the branch from the last bundle and strips planted Claude files', async () => {
  const f = await fixture();
  const { bundle, head, outside } = await plantedBundle(f);
  const dest = join(f.root, 'w2');
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest, lastBundle: bundle });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.head, head);
  assert.equal(readFileSync(join(dest, 'work.txt'), 'utf8'), 'real work\n');
  // Nested skills folder and the .claude link are gone; the link's target is untouched.
  assert.equal(existsSync(join(dest, 'src', '.claude')), false);
  assert.throws(() => lstatSync(join(dest, 'lib', '.claude')));
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched\n');
  // A case variant is removed too, and main's copies are back.
  assert.equal(existsSync(join(dest, 'pkg2', '.MCP.json')), false);
  assert.ok(r.removed.includes('pkg2/.MCP.json'));
  assert.equal(readFileSync(join(dest, '.mcp.json'), 'utf8'), '{"mainServers":{}}\n');
  assert.equal(readFileSync(join(dest, '.claude', 'settings.json'), 'utf8'), '{"main":true}\n');
  assert.ok(r.removed.includes('src/.claude') && r.removed.includes('lib/.claude'));
});

test('a bundle with another branch, or one not built on the card commit, is refused', async () => {
  const f = await fixture();
  const { bundle } = await plantedBundle(f);
  const other = await prepareWorkerCopy({ product: f.product, card: card(f.c1, { id: 'C-13' }), dest: join(f.root, 'w3'), lastBundle: bundle });
  assert.equal(other.ok, false);
  assert.match(other.reason, /exactly the card branch/);
  assert.equal(existsSync(join(f.root, 'w3')), false, 'a refused copy leaves nothing behind');
  // A bundle of the right branch name from unrelated history.
  const stray = join(f.root, 'stray');
  mkdirSync(stray);
  await gitOk(['init', '-q', '-b', 'card/c-12', stray], { gitDir: join(stray, '.git') });
  writeFileSync(join(stray, 'x.txt'), 'x\n');
  await commitAll(stray, 'unrelated');
  const strayBundle = join(f.root, 'stray.bundle');
  await gitOk(['bundle', 'create', '-q', strayBundle, 'refs/heads/card/c-12'], { gitDir: join(stray, '.git'), cwd: stray });
  assert.match((await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: join(f.root, 'w6'), lastBundle: strayBundle })).reason, /not built on the card commit/);
  const junk = join(f.root, 'junk.bundle');
  writeFileSync(junk, 'not a bundle');
  assert.match((await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: join(f.root, 'w4'), lastBundle: junk })).reason, /does not verify/);
});

test('planted fault: without check 2, the planted skills and link would survive', async () => {
  const f = await fixture();
  const { bundle } = await plantedBundle(f);
  const dest = join(f.root, 'w5');
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest, lastBundle: bundle });
  assert.equal(r.ok, true);
  // Re-checking out the branch brings the planted files back, and removeProtected catches them again.
  await gitOk(['checkout', '-q', '-f', 'card/c-12'], { gitDir: join(dest, '.git'), workTree: dest, cwd: dest });
  assert.equal(existsSync(join(dest, 'src', '.claude', 'skills', 'evil', 'SKILL.md')), true);
  assert.ok(lstatSync(join(dest, 'lib', '.claude')).isSymbolicLink());
  const again = removeProtected(dest);
  assert.ok(again.includes('src/.claude') && again.includes('lib/.claude'));
});

test('path safety: only plain relative paths inside the root are allowed', () => {
  const root = tmp();
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'a//b', './a', '', 'a/\0b', 'a/..']) assert.equal(safeJoin(root, bad), null, bad);
  assert.equal(safeJoin(root, 'a/b.txt'), join(root, 'a', 'b.txt'));
});

test('protected names match in any case and with hidden characters', () => {
  for (const n of ['.claude', '.Claude', '.CLAUDE', '.mcp.json', '.MCP.JSON', 'CLAUDE.local.md', 'claude.LOCAL.md', '.cl​aude']) assert.equal(isProtectedName(n), true, n);
  for (const n of ['claude', '.claudex', 'mcp.json', 'CLAUDE.md']) assert.equal(isProtectedName(n), false, n);
});

test('agent seam: only the Claude adapter exists, and it needs all five calls', () => {
  assert.deepEqual(adapterNames(), ['claude']);
  assert.equal(agentAdapter('cursor', {}).ok, false);
  const parts = Object.fromEntries(SEAM_CALLS.map((c) => [c, () => c]));
  const a = agentAdapter('claude', parts);
  assert.equal(a.ok, true);
  assert.deepEqual(Object.keys(a.adapter), ['start', 'stop', 'status', 'report', 'usage']);
  assert.throws(() => agentAdapter('claude', { start() {} }), /needs stop/);
});

// ---- planted failures for each refusal line, checked by their own reasons (audit R-0b-44 M-6) ----

test('check 1: a product with no mirror, and a card naming another branch, refuse with their own reason', async () => {
  const dest = join(tmp(), 'w');
  const c = 'a'.repeat(40);
  assert.equal((await prepareWorkerCopy({ product: { repo: REPO }, card: card(c), dest })).reason, 'product has no repo or mirror in the rules');
  assert.equal((await prepareWorkerCopy({ product: { repo: REPO, mirror: join(tmp(), 'none.git') }, card: card(c, { branch: 'card/other' }), dest })).reason,
    'card branch "card/other" is not card/c-12');
});

// Main moves on with a change to its own Claude files; the card stays on the first commit.
async function mainMovesOn(f, change) {
  change(f.src);
  const c2 = await commitAll(f.src, 'main 2');
  await gitOk(['fetch', '-q', f.src, '+refs/heads/main:refs/heads/main'], { gitDir: f.mirror });
  return c2;
}

test('check 2: main\'s protected file that is a link is never written as a file', async () => {
  const f = await fixture();
  const c2 = await mainMovesOn(f, (src) => symlinkSync('settings.json', join(src, '.claude', 'link.json')));
  const dest = join(f.root, 'w');
  const r = await prepareWorkerCopy({ product: f.product, card: card(c2), dest });
  assert.equal(r.reason, 'main\'s .claude/link.json is not a plain file (mode 120000)');
  assert.equal(existsSync(dest), false);
});

test('check 2: a branch that turns a folder into a link cannot get main\'s files written through it', async () => {
  const f = await fixture();
  const w = join(f.root, 'w-first');
  assert.equal((await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: w })).ok, true);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  rmSync(join(w, 'pkg'), { recursive: true });
  symlinkSync(outside, join(w, 'pkg'));
  await commitAll(w, 'pkg becomes a link');
  const bundle = join(f.root, 'bundle-C-12.bundle');
  await gitOk(['bundle', 'create', '-q', bundle, 'refs/heads/card/c-12'], { gitDir: join(w, '.git'), cwd: w });
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: join(f.root, 'w2'), lastBundle: bundle });
  assert.equal(r.reason, 'a link is on the way to pkg/CLAUDE.local.md');
  assert.equal(existsSync(join(outside, 'CLAUDE.local.md')), false, 'nothing written outside the copy');
});

test('check 2: a protected file main names but the mirror cannot give refuses', async () => {
  const f = await fixture();
  // A main whose tree names a blob the mirror does not hold.
  const o = { gitDir: f.mirror, purpose: 'test' };
  const tree = (await gitOk(['mktree', '--missing'], { ...o, input: `100644 blob ${'b'.repeat(40)}\t.mcp.json\n` })).trim();
  const c2 = (await gitOk(['commit-tree', tree, '-p', f.c1, '-m', 'main 2'], o)).trim();
  await gitOk(['update-ref', 'refs/heads/main', c2], o);
  const r = await prepareWorkerCopy({ product: f.product, card: card(f.c1), dest: join(f.root, 'w') });
  assert.equal(r.reason, 'cannot read main\'s .mcp.json');
});
