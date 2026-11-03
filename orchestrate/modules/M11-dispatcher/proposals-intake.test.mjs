// proposals-intake.test.mjs — R-0b-128 part 1: the proposals folder Joe's own tabs write, taken in by the Dispatcher.
// Each plant the row's done_when names is made here and shown caught.
// Run: node --test orchestrate/modules/M11-dispatcher/proposals-intake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, linkSync, mkdirSync, chmodSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import {
  intakeProposals, proposalsReadBack, intakeFactId, folderFactId, folderProblem, proposalName,
  FIRST_CUTOVER, IDEAS_OFF, SETTLE_MS,
} from './proposals-intake.mjs';
import { recWith, seed } from './fixtures.test-helper.mjs';
import { outbox, sendAlerts } from './alerts.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { renderRoleSettings } from '../M4-workshop/launcher/render-settings.mjs';
import { DESIGN_PROFILES } from '../M4-workshop/launcher/role-profiles.mjs';

const UID = process.getuid();
const NOW = Date.parse('2026-11-02T12:00:00Z');

// The rules give each product its own folder; `stage` is product.cutover_stage.
const rulesFor = (dirs, stage = {}) => ({
  get(key, { product } = {}) {
    if (key === 'proposals.outbox') return dirs[product];
    if (key === 'product.cutover_stage') return stage[product];
    return undefined;
  },
});

function world({ products = ['a'] } = {}) {
  const root = tempDir('m11-proposals-');
  const dirs = {};
  for (const p of products) { const d = join(root, p); mkdirSync(d); chmodSync(d, 0o750); dirs[p] = d; }
  const rec = recWith();
  // The real outbox queues each alert; after every pass the queue is sent to a fakeAlert() port, so a delivered
  // alert's mark is written by sendAlerts, as in the tick. calls.alerts is what the port was handed.
  const port = fakeAlert();
  const alert = outbox(rec, NOW);
  const calls = { get alerts() { return port.texts; }, notes: [], handed: [] };
  const handler = (kind) => (x) => { calls.handed.push({ kind, name: x.name, text: x.text }); return { ok: true }; };
  const base = {
    rules: rulesFor(dirs), products, ownerUid: UID, wait: async () => {},
    alert, note: (t) => calls.notes.push(t),
    handlers: { research: handler('research'), claim: handler('claim'), heartbeat: handler('heartbeat') },
  };
  const pass = async (over = {}) => { const out = await intakeProposals({ rec, ...base, ...over }); await sendAlerts(rec, port, NOW); return out; };
  return { root, dirs, calls, rec, pass, base };
}
const put = (w, name, text, p = 'a') => writeFileSync(join(w.dirs[p], name), text);
const one = (out, name) => out.find((r) => r.name === name);
const fact = (w, name, p = 'a') => w.rec.read('fact', intakeFactId(p, name))?.doc;

test('the owner\'s uid must come from the config: missing or not a positive whole number, the pass throws', async () => {
  const w = world();
  for (const ownerUid of [undefined, null, 0, -1, 1.5, '501']) await assert.rejects(() => w.pass({ ownerUid }), /ownerUid/);
});

test('the six names, and nothing else', () => {
  assert.deepEqual(proposalName('proposal-C-12.md'), { kind: 'proposal', id: 'C-12' });
  assert.deepEqual(proposalName('bundle-C-12.bundle'), { kind: 'bundle', id: 'C-12' });
  for (const k of ['research', 'idea', 'claim', 'heartbeat']) assert.equal(proposalName(`${k}-x1.md`).kind, k);
  for (const bad of ['proposal-.md', 'proposal-C 1.md', 'proposal-C-1.md.bak', 'verdict-C-1.md', 'notes.md', 'research-../x.md', `research-${'a'.repeat(65)}.md`]) assert.equal(proposalName(bad), null, bad);
});

test('a file with an odd name, or a verdict, is refused with a logged reason and told once; a dot-name is skipped unread', async () => {
  const w = world();
  put(w, 'notes.md', 'hello');
  put(w, 'verdict-C-1.md', 'PASS');
  put(w, '.DS_Store', 'x');
  const out = await w.pass();
  assert.match(one(out, 'notes.md').refused, /not a proposals file name/);
  assert.match(one(out, 'verdict-C-1.md').refused, /a verdict comes only from a review session's own outbox/);
  assert.equal(one(out, '.DS_Store'), undefined);
  assert.equal(w.calls.alerts.length, 2);
  assert.equal(w.calls.notes.length, 2);
  assert.equal(fact(w, 'notes.md').state, 'refused');
  await w.pass();
  assert.equal(w.calls.alerts.length, 2, 'a refusal is told once, not every pass the file sits there');
});

test('plant: a link to a file elsewhere is refused (opened without following a link), and nothing is handed on', async () => {
  const w = world();
  const outside = join(w.root, 'outside.md');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(w.dirs.a, 'research-r1.md'));
  const out = await w.pass();
  assert.match(one(out, 'research-r1.md').refused, /could not be opened without following a link/);
  assert.deepEqual(w.calls.handed, []);
});

test('plant: a hard link (two names, one file) is refused', async () => {
  const w = world();
  const outside = join(w.root, 'outside.md');
  writeFileSync(outside, 'secret');
  linkSync(outside, join(w.dirs.a, 'research-r1.md'));
  assert.match(one(await w.pass(), 'research-r1.md').refused, /more than one link/);
  assert.deepEqual(w.calls.handed, []);
});

test('plant: a file owned by another user (orchestrate, or review) is refused', async () => {
  for (const other of [UID + 1, UID + 2]) {
    const w = world();
    put(w, 'research-r1.md', 'look into x');
    // fstat answers as if another user owned the file; the other three calls are the real ones.
    const fs = { openSync, readSync, closeSync, fstatSync: (fd) => { const s = fstatSync(fd); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: other }); } };
    const out = await w.pass({ fs });
    assert.equal(one(out, 'research-r1.md').refused, `"research-r1.md" is owned by user ${other}, not the owner's user`);
    assert.deepEqual(w.calls.handed, []);
  }
});

test('plant: a file still being written waits for the next pass, and nothing is recorded', async () => {
  const w = world();
  put(w, 'research-r1.md', 'half');
  let waited = 0;
  const out = await w.pass({ wait: async (ms) => { waited = ms; put(w, 'research-r1.md', 'half and the rest'); } });
  assert.equal(waited, SETTLE_MS);
  assert.equal(one(out, 'research-r1.md').waiting, 'still being written');
  assert.equal(fact(w, 'research-r1.md'), undefined);
  assert.equal(one(await w.pass(), 'research-r1.md').applied, true);
});

test('a research file is handed on once; the same bytes again are already taken; new bytes on the name are refused and told once', async () => {
  const w = world();
  put(w, 'research-r1.md', 'look into x');
  assert.equal(one(await w.pass(), 'research-r1.md').applied, true);
  assert.deepEqual(w.calls.handed, [{ kind: 'research', name: 'research-r1.md', text: 'look into x' }]);
  assert.equal(fact(w, 'research-r1.md').state, 'applied');
  assert.equal(fact(w, 'research-r1.md').session, 'proposals-a');
  assert.equal(one(await w.pass(), 'research-r1.md').already, true);
  put(w, 'research-r1.md', 'look into y instead');
  assert.equal(one(await w.pass(), 'research-r1.md').refused, 'the same name with new content');
  assert.equal(one(await w.pass(), 'research-r1.md').refused, 'the same name with new content');
  assert.equal(w.calls.handed.length, 1);
  assert.equal(w.calls.alerts.filter((t) => /written again with different content/.test(t)).length, 1, 'told once for those bytes');
});

test('plant: a heartbeat with new bytes is a new poll, its one fact updated in place (L78 n2)', async () => {
  const w = world();
  put(w, 'heartbeat-tab1.md', 't=1');
  await w.pass();
  put(w, 'heartbeat-tab1.md', 't=2');
  assert.equal(one(await w.pass(), 'heartbeat-tab1.md').applied, true);
  assert.deepEqual(w.calls.handed.map((h) => h.text), ['t=1', 't=2']);
  assert.equal(w.calls.alerts.length, 0);
});

test('plant: an idea file is refused while idea filing is off (L215 2)', async () => {
  const w = world();
  put(w, 'idea-dark-mode.md', 'add dark mode');
  const out = await w.pass({ handlers: { ...w.base.handlers, idea: () => { throw new Error('never called'); } } });
  assert.equal(one(out, 'idea-dark-mode.md').refused, IDEAS_OFF);
  assert.equal(w.calls.handed.length, 0);
});

test('plant: on day 1 a proposal is refused with the first-cutover reason before any review starts', async () => {
  const w = world();
  put(w, 'proposal-C-1.md', 'change the footer');
  put(w, 'bundle-C-1.bundle', 'bytes');
  let reviews = 0;
  const out = await w.pass({ toReview: () => { reviews += 1; return { ok: true }; } });
  assert.match(one(out, 'proposal-C-1.md').refused, new RegExp(`^${FIRST_CUTOVER.replace(/\./g, '\\.')}`));
  assert.equal(one(out, 'bundle-C-1.bundle').held, 'taken in with proposal-C-1.md');
  assert.equal(reviews, 0);
  // The stage reads `second` only exactly: anything else is the first cutover.
  const odd = await w.pass({ rules: rulesFor(w.dirs, { a: 'Second' }), toReview: () => { reviews += 1; return { ok: true }; } });
  assert.match(one(odd, 'proposal-C-1.md').refused, /^First cutover/);
  assert.equal(reviews, 0);
});

test('plant: a docs proposal needs its own bundle; a bundle for another card is refused; the docs check\'s no is a refusal', async () => {
  const w = world();
  put(w, 'proposal-C-1.md', 'docs change');
  put(w, 'bundle-C-2.bundle', 'bytes');
  const docsCheck = async () => null;
  const out = await w.pass({ docsCheck, toReview: () => ({ ok: true }) });
  assert.equal(one(out, 'proposal-C-1.md').refused, 'no bundle-C-1.bundle carries this proposal\'s change');
  assert.equal(one(out, 'bundle-C-2.bundle').refused, 'no proposal-C-2.md names this bundle\'s card');
  const w2 = world();
  put(w2, 'proposal-C-1.md', 'code change');
  put(w2, 'bundle-C-1.bundle', 'bytes');
  const out2 = await w2.pass({ docsCheck: async () => 'app/x.ts is not a docs file', toReview: () => ({ ok: true }) });
  assert.equal(one(out2, 'proposal-C-1.md').refused, `${FIRST_CUTOVER} (app/x.ts is not a docs file)`);
});

test('at the second cutover a proposal goes to review once; with no route to review it is refused', async () => {
  const w = world();
  put(w, 'proposal-C-1.md', 'change');
  put(w, 'bundle-C-1.bundle', 'bytes');
  const rules = rulesFor(w.dirs, { a: 'second' });
  assert.match(one(await w.pass({ rules }), 'proposal-C-1.md').refused, /route to review is not built yet/);
  const w2 = world();
  put(w2, 'proposal-C-1.md', 'change');
  put(w2, 'bundle-C-1.bundle', 'bytes');
  const sent = [];
  const toReview = (x) => { sent.push(x); return { ok: true }; };
  assert.equal(one(await w2.pass({ rules: rulesFor(w2.dirs, { a: 'second' }), toReview }), 'proposal-C-1.md').applied, true);
  await w2.pass({ rules: rulesFor(w2.dirs, { a: 'second' }), toReview });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].card, 'C-1');
  assert.equal(sent[0].bundle, join(w2.dirs.a, 'bundle-C-1.bundle'));
});

test('a kind with no handler yet is left untouched and unrecorded, so it is taken once the handler lands', async () => {
  const w = world();
  put(w, 'claim-C-9.md', 'mine');
  const out = await w.pass({ handlers: {} });
  assert.equal(one(out, 'claim-C-9.md').waiting, 'no claim handler yet');
  assert.equal(fact(w, 'claim-C-9.md'), undefined);
  assert.equal(one(await w.pass(), 'claim-C-9.md').applied, true);
});

test('a handler that fails or throws is a refusal; a claim a crash left behind is interrupted and never used again', async () => {
  const w = world();
  put(w, 'research-r1.md', 'x');
  const out = await w.pass({ handlers: { research: () => { throw new Error('boom'); } } });
  assert.equal(one(out, 'research-r1.md').refused, 'boom');
  const w2 = world();
  put(w2, 'research-r2.md', 'y');
  const { createHash } = await import('node:crypto');
  seed(w2.rec, 'fact', intakeFactId('a', 'research-r2.md'), { session: 'proposals-a', product: 'a', name: 'research-r2.md', sha256: createHash('sha256').update('y').digest('hex'), state: 'applying' });
  const o2 = await w2.pass();
  assert.equal(one(o2, 'research-r2.md').already, true);
  assert.equal(fact(w2, 'research-r2.md').state, 'interrupted');
  assert.deepEqual(w2.calls.handed, []);
  assert.equal(w2.calls.alerts.filter((t) => /was interrupted/.test(t)).length, 1);
  await w2.pass();
  assert.equal(w2.calls.alerts.filter((t) => /was interrupted/.test(t)).length, 1);
});

test('plant: the folder itself — loose mode, a link, missing, no key — is not taken in, and its problem is told once', async () => {
  const w = world({ products: ['a', 'b'] });
  chmodSync(w.dirs.a, 0o755);
  put(w, 'research-r1.md', 'x', 'a');
  let out = await w.pass();
  assert.equal(out.find((r) => r.product === 'a').skipped, 'the proposals folder\'s mode 755 is looser than 750');
  assert.deepEqual(w.calls.handed, []);
  await w.pass();
  assert.equal(w.calls.alerts.filter((t) => /a's proposals folder is not taken in/.test(t)).length, 1, 'told once while the reason holds');
  chmodSync(w.dirs.a, 0o750);
  out = await w.pass();
  assert.equal(one(out, 'research-r1.md').applied, true);
  assert.equal(w.rec.read('fact', folderFactId('a')).doc.why, null, 'the end of the problem is recorded');
  // A link, a missing folder, a relative path and no key at all.
  const real = join(w.root, 'real');
  mkdirSync(real); chmodSync(real, 0o750);
  const link = join(w.root, 'link');
  symlinkSync(real, link);
  const rules = rulesFor({ a: link, b: join(w.root, 'nope'), c: 'rel/dir' });
  const o = await w.pass({ rules, products: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(o.map((r) => r.skipped), [
    'the proposals folder is not a plain folder', 'the proposals folder is missing',
    'proposals.outbox is not a plain absolute folder path', 'no proposals.outbox in the rules',
  ]);
});

test('plant: a folder owned by another user is refused (Joe\'s uid comes from the config, never from the folder)', () => {
  const w = world();
  assert.equal(folderProblem(w.dirs.a, UID), null);
  assert.match(folderProblem(w.dirs.a, UID + 1), /is owned by user \d+, not the owner's user/);
  chmodSync(w.dirs.a, 0o770);
  assert.match(folderProblem(w.dirs.a, UID), /looser than 750/);
  chmodSync(w.dirs.a, 0o700);
  assert.equal(folderProblem(w.dirs.a, UID), null);
  for (const bad of ['/x/../y', 'x', '', null]) assert.match(folderProblem(bad, UID), /not a plain absolute folder path/);
});

test('an odd file name is still recorded under a legal fact id', () => {
  assert.equal(intakeFactId('a', 'research-r1.md'), 'intake-applied-proposals-a-research-r1.md');
  assert.match(intakeFactId('a', 'my notes.md'), /^intake-applied-proposals-a-name-[0-9a-f]{16}$/);
  assert.match(intakeFactId('a', '..'), /-name-/);
});

// ---- the read-deny wall (render-settings.mjs, L78 n5) ----

const PATHS = (proposals) => ({
  copy: '/w/copy', outbox: '/w/outbox', hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes',
  deny: { secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record', otherCopies: [], proposals },
  bobFolder: '/w/bob', mirror: '/w/mirror.git', reviewWalls: { outboxRoot: '/r/outbox', runnerRoot: '/r/review' },
});
const render = (role, proposals, proposalOutboxes) => renderRoleSettings({
  productionFiles: [], proposalOutboxes, role, profile: DESIGN_PROFILES[role], paths: PATHS(proposals),
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [],
});

test('plant: every product\'s proposals folder, its own and the others\', is on a worker\'s read-deny; one left off refuses the launch', () => {
  const both = ['/p/a/proposals', '/p/b/proposals'];
  const ok = render('worker', both, both);
  assert.equal(ok.ok, true, ok.reason);
  const deny = ok.settings.permissions.deny;
  for (const d of both) assert.ok(deny.includes(`Read(/${d}/**)`), d);
  const off = render('worker', ['/p/a/proposals'], both);
  assert.equal(off.ok, false);
  assert.match(off.reason, /proposals folders are not all on the read-deny list: \/p\/b\/proposals/);
  assert.match(render('worker', both, undefined).reason, /proposals folders were not given/);
  assert.match(render('worker', both, '/p/a/proposals').reason, /not a list/);
});

test('proposalsReadBack: the setup batch\'s check passes only the whole wall', () => {
  const w = world();
  const dir = w.dirs.a;
  const settings = { permissions: { deny: [`Read(/${dir}/**)`] } };
  const good = { dir, ownerUid: UID, canRead: (u) => u === 'orchestrate', canWrite: () => false, settings };
  assert.deepEqual(proposalsReadBack(good), []);
  assert.deepEqual(proposalsReadBack({ ...good, canWrite: (u) => u === 'orchestrate' }), ['orchestrate can write the proposals folder']);
  assert.deepEqual(proposalsReadBack({ ...good, canRead: () => true }), ['review can read the proposals folder']);
  assert.deepEqual(proposalsReadBack({ ...good, canRead: () => false }), ['orchestrate can\'t read the proposals folder']);
  // An answer that is not true or false counts as the unsafe one.
  assert.equal(proposalsReadBack({ ...good, canRead: () => 'yes', canWrite: () => { throw new Error('x'); } }).length, 3);
  assert.match(proposalsReadBack({ ...good, settings: { permissions: { deny: [] } } })[0], /do not deny Read\(\/\//);
  assert.match(proposalsReadBack({ ...good, ownerUid: UID + 1 })[0], /owned by user/);
});
