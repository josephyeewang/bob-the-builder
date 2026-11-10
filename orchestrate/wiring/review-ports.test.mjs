// review-ports.test.mjs — group A's GitHub reads (A1, L615), against the fake GitHub; no test reaches the network.
// Run: node --test orchestrate/wiring/review-ports.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyClient } from '../modules/M6-merge-gate/watch-only.mjs';
import { ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { fakeGitHubFetch } from './fake-github.test-helper.mjs';
import { githubReads, reviewPorts, wait, NOT_WIRED_REVIEW, reviewRunner, MAIN_SEEN_STALE_MS, planRows } from './review-ports.mjs';
import { doneBar } from '../modules/M2-approvals/go.mjs';
import { reviewConfig, writeSeen, writeStatus } from './review-ports.test-helper.mjs';
import { readdirSync, readFileSync, chmodSync } from 'node:fs';
import { UPDATE_EVERY_S } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { GIT_MS } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';

const COMMIT = 'c'.repeat(40);
const TOKEN = 't'.repeat(40);
const client = (over = {}) => readOnlyClient({ token: () => TOKEN, fetchFn: fakeGitHubFetch({ owner: ENTRY.owner, repo: ENTRY.repo, commit: COMMIT, text: 'x', ...over }) });
// A client that answers each path from a table, and counts its reads.
const table = (paths) => {
  const asked = [];
  return { asked, get: async (p) => { asked.push(p); const a = paths[p]; if (a instanceof Error) throw a; return a ?? { status: 404, json: null }; } };
};
const base = `/repos/${ENTRY.owner}/${ENTRY.repo}`;
// Stands in for the Dispatcher's own user: a test's files are all this user's, so the review user here is this user,
// and the Dispatcher's must be someone else (L674).
const SELF = process.getuid() + 2;

test('A1: mainSha reads the product\'s main branch through the read-only client', async () => {
  const r = githubReads({ gh: client(), entry: ENTRY });
  assert.equal(await r.mainSha({ product: ENTRY.product }), COMMIT);
});

test('A1: another product, or none, is refused before anything is read', async () => {
  const gh = table({});
  const r = githubReads({ gh, entry: ENTRY });
  for (const product of ['other', null, undefined]) {
    await assert.rejects(r.mainSha({ product }), new RegExp(`runs product ${ENTRY.product}, so it can't read product ${product}`));
    await assert.rejects(r.planView({ product }), /can't read product/);
  }
  await assert.rejects(r.mainSha(), /can't read product undefined/);
  assert.deepEqual(gh.asked, []);
});

test('A1: a main read that fails, answers oddly or names no commit throws, never a made-up commit', async () => {
  const ref = `${base}/git/ref/heads/main`;
  for (const [answer, why] of [
    [{ status: 404, json: null }, /GitHub answered 404 for the main branch/],
    [{ status: 200, json: {} }, /named no commit/],
    [{ status: 200, json: { object: { sha: 'abc' } } }, /named no commit/],
    [{ status: 200, json: { object: { sha: 'C'.repeat(40) } } }, /named no commit/],
  ]) await assert.rejects(githubReads({ gh: table({ [ref]: answer }), entry: ENTRY }).mainSha({ product: ENTRY.product }), why);
  // A client that threw gave no answer: marked unreadable, as M10's git view marks it (S16).
  await assert.rejects(githubReads({ gh: table({ [ref]: new Error('socket hang up') }), entry: ENTRY }).mainSha({ product: ENTRY.product }),
    (e) => e.unreadable === true && /socket hang up/.test(e.message));
});

test('A1: mainSha reads main afresh on each call, never a kept answer (audit #256 r1 m3)', async () => {
  const shas = ['a'.repeat(40), 'b'.repeat(40)];
  let n = 0;
  const gh = { get: async () => ({ status: 200, json: { object: { sha: shas[n++] } } }) };
  const r = githubReads({ gh, entry: ENTRY });
  assert.equal(await r.mainSha({ product: ENTRY.product }), shas[0]);
  assert.equal(await r.mainSha({ product: ENTRY.product }), shas[1]);
});

test('A1: planView answers isDir from the commit\'s tree, a fresh view each call', async () => {
  const tree = 'd'.repeat(40);
  const blob = 'b'.repeat(40);
  const gh = table({
    [`${base}/git/commits/${COMMIT}`]: { status: 200, json: { sha: COMMIT, tree: { sha: tree }, parents: [] } },
    [`${base}/git/trees/${tree}?recursive=1`]: { status: 200, json: { truncated: false, tree: [{ type: 'blob', path: 'src/a.mjs', sha: blob, mode: '100644' }] } },
  });
  const r = githubReads({ gh, entry: ENTRY });
  const v = await r.planView({ product: ENTRY.product });
  assert.equal(await v.isDir(COMMIT, 'src'), true);
  assert.equal(await v.isDir(COMMIT, 'src/a.mjs'), false);
  const reads = gh.asked.length;
  await (await r.planView({ product: ENTRY.product })).isDir(COMMIT, 'src');
  assert.equal(gh.asked.length, reads * 2, 'a later pass reads GitHub again');
});

test('A1: the read-only client refuses anything but a repository read, so these ports can\'t write', async () => {
  const gh = client();
  await assert.rejects(gh.get('/user'), /only repository reads/);
  await assert.rejects(gh.post(`${base}/pulls`, {}), /only write-shaped call/);
  assert.throws(() => githubReads({ gh: null, entry: ENTRY }), /need the read-only client/);
});

test('A1: wait waits', { timeout: 5000 }, async () => {
  const t = Date.now();
  await wait(30);
  assert.ok(Date.now() - t >= 25);
});

// On fake timers, so a wait that would run for days fails the test and leaves no real timer behind to hold the run
// open (audit #256 r2 m1). Text and a BigInt too: the timer itself would wait '1500' out, and throw on 5n (r1 m2).
test('A1: a wait it can\'t read waits no time', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const ms of [-5, NaN, undefined, 'x', Infinity, '1500', 5n]) {
    let done = false;
    const p = wait(ms).then(() => { done = true; });
    t.mock.timers.tick(0);
    await new Promise((r) => setImmediate(r));
    assert.ok(done, String(ms));
    await p;
  }
});

test('A1, A2: the port file answers exactly what it took off its list', () => {
  const answered = Object.keys(reviewPorts({ gh: client(), entry: ENTRY, rec: { read: () => null }, config: reviewConfig(temp()), now: Date.now, selfUid: SELF }));
  assert.deepEqual(answered.sort(), ['hasReviewer', 'mainSha', 'planReviewAnswer', 'planReviewsRunning', 'planRows', 'planView', 'requestReview', 'reviewAlerts', 'startPlanReview', 'wait']);
  for (const k of answered) assert.ok(!NOT_WIRED_REVIEW.includes(k), k);
});

// ---- A2 (L615, L639): the review runner's ports, against a throwaway runner folder of this user's.
const temp = () => tempDir('orch-review-ports-');
const T0 = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60_000;
const D = 'd'.repeat(40);
function runner({ status = {}, seen = {}, at = T0, reviewUid } = {}) {
  const dir = temp();
  const config = reviewConfig(dir, { now: T0, status, seen, reviewUid });
  let t = at;
  const ports = reviewRunner({ config, now: () => t, owner: process.getuid(), top: dir, selfUid: SELF });
  return { config, ports, dir, setNow: (v) => { t = v; } };
}
const stamp = (list) => list.find((a) => a.id === 'stamp');

test('A2: requestReview writes one whole request into the runner\'s requests folder, and starts nothing', () => {
  const w = runner();
  const r = w.ports.requestReview({ card: 'c-1', head: 'a'.repeat(40), role: 'reviewer' });
  assert.equal(r.ok, true, r.reason);
  const files = readdirSync(w.config.reviewRequestsDir);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(w.config.reviewRequestsDir, files[0]), 'utf8')).card, 'c-1');
});

test('A2: hasReviewer reads what the runner says runs, and a status it can\'t trust is an error, never a no', () => {
  const head = 'a'.repeat(40);
  const w = runner({ status: { running: [{ card: 'c-1', role: 'reviewer', head }] } });
  assert.equal(w.ports.hasReviewer('c-1', 'reviewer', head), true);
  assert.equal(w.ports.hasReviewer('c-1', 'auditor', head), false);
  w.setNow(T0 + 4 * MIN);
  assert.throws(() => w.ports.hasReviewer('c-1', 'reviewer', head), /4 minutes old/);
  const gone = runner({ status: null });
  assert.throws(() => gone.ports.hasReviewer('c-1', 'reviewer', head), /status is missing/);
  const open = runner();
  chmodSync(open.config.reviewStatusFile, 0o666);
  assert.throws(() => open.ports.hasReviewer('c-1', 'reviewer', head), /written by others/);
});

test('A2: reviewAlerts carries the runner\'s alerts and holds, and a copy at main says nothing about its stamp', () => {
  const w = runner({ status: { alerts: [{ id: 'a1', at: 'x', text: 'hello' }], holds: [{ id: 'h1', since: 's', text: 'held' }] } });
  const list = w.ports.reviewAlerts();
  assert.deepEqual(list.map((a) => a.id), ['a1', 'h1']);
  assert.equal(list[1].hold, true);
});

test('A2: a copy behind root\'s record of main is told once past the grace, by the installed commit', () => {
  const w = runner({ status: { installed_commit: 'c'.repeat(40) }, seen: { commit: D, installed: 'c'.repeat(40), since: T0 - 40 * MIN, checked_at: T0 - 2 * MIN } });
  assert.match(stamp(w.ports.reviewAlerts()).text, /installed copy is at ccccccc, but main is at ddddddd/);
});

test('A2: a stale record of main, or none, keeps the stamp hold and leads with the updater, never "at main"', () => {
  const stale = runner({ seen: { checked_at: T0 - MAIN_SEEN_STALE_MS - MIN } });
  const s = stamp(stale.ports.reviewAlerts());
  assert.equal(s.keep, true);
  assert.match(s.text, /^Root's updater may have stopped: it last checked main 26 min ago; it checks every 10 min\. Main can't be read, so whether its installed copy is behind can't be checked/);
  const fine = runner({ seen: { checked_at: T0 - MAIN_SEEN_STALE_MS + MIN } });
  assert.equal(stamp(fine.ports.reviewAlerts()), undefined, 'inside the limit: fine');
  const ahead = runner({ seen: { checked_at: T0 + 60 * MIN } });
  assert.match(stamp(ahead.ports.reviewAlerts()).text, /^Root's updater may have stopped: its last check of main has a time that can't be read\. Main can't be read/);
  const none = runner({ seen: null });
  assert.match(stamp(none.ports.reviewAlerts()).text, /^Root's updater may have stopped: its record of main is missing or can't be trusted\. Main can't be read/);
  const open = runner();
  chmodSync(`${open.config.reviewInstallRoot}.main-seen.json`, 0o666);
  assert.equal(stamp(open.ports.reviewAlerts()).keep, true, 'a record others could write is not trusted');
});

// Audit #263 c1: a time beyond Date's range reads in words, never as a raw "Invalid time value".
test('A2: a last check at a time beyond Date\'s range is a time that can\'t be read', () => {
  const far = runner({ seen: { checked_at: 9e15 } });
  const s = stamp(far.ports.reviewAlerts());
  assert.equal(s.keep, true);
  assert.match(s.text, /its last check of main has a time that can't be read/);
  assert.doesNotMatch(s.text, /Invalid/);
});

// Audit #263 m3: exactly at the limit is fresh, and one ms past it is stale, told rounded up, never as the limit itself.
test('A2: the stale limit is exact: at it is fresh, one ms past it is stale', () => {
  const at = runner({ seen: { checked_at: T0 - MAIN_SEEN_STALE_MS } });
  assert.equal(stamp(at.ports.reviewAlerts()), undefined, 'exactly at the limit: fresh');
  const past = runner({ seen: { checked_at: T0 - MAIN_SEEN_STALE_MS - 1 } });
  const s = stamp(past.ports.reviewAlerts());
  assert.equal(s.keep, true);
  assert.match(s.text, new RegExp(`last checked main ${MAIN_SEEN_STALE_MS / MIN + 1} min ago`));
});

// Audit #263 m4 (L668): two of the updater's turns, plus the longest a run takes, since it stamps its record at a run's end.
test('A2: the stale limit is two of the updater\'s turns plus its fetch limit: 25 min', () => {
  assert.equal(MAIN_SEEN_STALE_MS, 2 * UPDATE_EVERY_S * 1000 + GIT_MS);
  assert.equal(MAIN_SEEN_STALE_MS, 25 * MIN);
});

// Audit #263 m3: the ports the Dispatcher builds read root's record as root's. A fresh, well-formed record of this user's
// is not trusted, so the stamp hold stays.
test('A2: reviewPorts reads root\'s record only if root owns it, so a fresh record of this user\'s keeps the hold', () => {
  const config = reviewConfig(temp());
  const ports = reviewPorts({ gh: client(), entry: ENTRY, rec: { read: () => null }, config, now: Date.now, selfUid: SELF });
  const s = stamp(ports.reviewAlerts());
  assert.equal(s?.keep, true);
  assert.match(s.text, /its record of main is missing or can't be trusted/);
});

// Audit #263 m2a: a status the review user doesn't own is never read.
test('A2: a status file not owned by the review user is an error, never a reviewer', () => {
  const w = runner({ reviewUid: process.getuid() + 1, status: { running: [{ card: 'c-1', role: 'reviewer', head: 'a'.repeat(40) }] } });
  assert.throws(() => w.ports.hasReviewer('c-1', 'reviewer', 'a'.repeat(40)), /not owned by the review user/);
});

// Audit #263 m2b (L674): the review user must be neither the Dispatcher's own nor the workers'; either could write the
// status that says a reviewer runs.
test('A2: a review uid that is the Dispatcher\'s own or the workers\' stops the start; another user\'s starts', () => {
  const config = reviewConfig(temp());
  const me = process.getuid();
  assert.throws(() => reviewRunner({ config, now: Date.now, selfUid: me }), /config: reviewUid is the Dispatcher's own user/);
  assert.throws(() => reviewRunner({ config: { ...config, ownerUid: me }, now: Date.now, selfUid: SELF }), /config: reviewUid is the workers' user \(ownerUid\)/);
  assert.doesNotThrow(() => reviewRunner({ config: { ...config, ownerUid: me + 1 }, now: Date.now, selfUid: SELF }));
  // With no stand-in, the Dispatcher's own user is this process's (main.mjs passes none).
  assert.throws(() => reviewRunner({ config, now: Date.now }), /Dispatcher's own user/);
  assert.throws(() => reviewPorts({ gh: client(), entry: ENTRY, rec: { read: () => null }, config, now: Date.now }), /Dispatcher's own user/);
});

test('A2: a review uid that is not a Mac user id stops the start', () => {
  for (const reviewUid of [undefined, -1, 1.5, '501']) {
    const config = { ...reviewConfig(temp()), reviewUid };
    assert.throws(() => reviewRunner({ config, now: Date.now, selfUid: SELF }), /config: reviewUid must be a Mac user id/, String(reviewUid));
  }
});

// ---- A3a: planRows, the row files among a card's files (M2's ROW_FILE, as the gate reads them), read at main's
// current commit with the Merge Gate's row reader.
const MAIN = 'e'.repeat(40);
const rowAnswer = (text) => ({ status: 200, json: { encoding: 'base64', content: Buffer.from(text).toString('base64') } });
const rowPath = (id, sha = MAIN) => `${base}/contents/docs/blueprint/rows/${id}.yaml?ref=${sha}`;
const rf = (id) => `docs/blueprint/rows/${id}.yaml`;
const cardRec = (cards) => ({ read: (entity, id) => (entity === 'card' && cards[id] ? { doc: cards[id] } : null) });
function rowsWorld(answers, cards = { 'C-1': { files: ['src/a.mjs', rf('R-2'), rf('R-1')] } }) {
  const gh = table({ [`${base}/git/ref/heads/main`]: { status: 200, json: { object: { sha: MAIN } } }, ...answers });
  return { gh, read: planRows({ gh, entry: ENTRY, rec: cardRec(cards) }) };
}

test('A3a: planRows reads each row the card names at main\'s one commit, and their pass tests are the card\'s bar', async () => {
  const w = rowsWorld({ [rowPath('R-1')]: rowAnswer('id: R-1\ndone_when: "one passes"\n'), [rowPath('R-2')]: rowAnswer('id: R-2\ndone_when: two passes\n') });
  const rows = await w.read({ product: ENTRY.product, card: 'C-1' });
  assert.deepEqual(rows, { 'R-1': { id: 'R-1', done_when: 'one passes' }, 'R-2': { id: 'R-2', done_when: 'two passes' } });
  assert.equal(doneBar(rows), 'one passes\n---\ntwo passes');
  assert.deepEqual(w.gh.asked, [`${base}/git/ref/heads/main`, rowPath('R-1'), rowPath('R-2')], 'main once, then every row at that commit');
});

test('A3a: planRows refuses another product before reading anything', async () => {
  const w = rowsWorld({});
  await assert.rejects(w.read({ product: 'other', card: 'C-1' }), /can't read product other/);
  assert.deepEqual(w.gh.asked, []);
});

test('A3a: a card the Record lacks, with no file list, or with no row file among its files, throws; no rows are made up', async () => {
  const w = rowsWorld({}, {
    'C-0': { files: [] }, 'C-5': { files: ['src/a.mjs', 'docs/blueprint/rows/R-1.yml', 'docs/blueprint/rows/sub/R-1.yaml', 'x/docs/blueprint/rows/R-1.yaml', './docs/blueprint/rows/R-1.yaml', '../docs/blueprint/rows/R-1.yaml', 5] },
    'C-2': {}, 'C-3': { files: rf('R-1') }, 'C-4': { files: [rf('.hidden')] }, 'C-6': { rows: ['R-1'], files: ['src/a.mjs'] },
  });
  await assert.rejects(w.read({ product: ENTRY.product, card: 'C-9' }), /the Record has no card C-9/);
  for (const c of ['C-0', 'C-5', 'C-6']) await assert.rejects(w.read({ product: ENTRY.product, card: c }), new RegExp(`card ${c} names no row file \\(docs/blueprint/rows/<id>\\.yaml\\) among its files`), c);
  for (const c of ['C-2', 'C-3']) await assert.rejects(w.read({ product: ENTRY.product, card: c }), new RegExp(`card ${c} has no file list`), c);
  assert.deepEqual(w.gh.asked, Array(6).fill(`${base}/git/ref/heads/main`), 'no row is read for any of them');
  // L696 m1: an id that is not plain is read like any other, its path encoded; M2's go refuses it (checkRows)
  w.gh.asked.length = 0;
  await assert.rejects(w.read({ product: ENTRY.product, card: 'C-4' }), /row \.hidden is missing at main/);
  assert.equal(w.gh.asked.length, 2);
  assert.match(w.gh.asked[1], /\/contents\/docs\/blueprint\/rows\/\.hidden\.yaml\?ref=/);
});

test('A3a: a row file listed twice, or under its old and new spelling of case, is read once per id', async () => {
  const w = rowsWorld({ [rowPath('R-1')]: rowAnswer('id: R-1\ndone_when: x\n') }, { 'C-1': { files: [rf('R-1'), rf('R-1'), 'DOCS/Blueprint/rows/R-1.YAML'] }, 'C-7': { files: ['DOCS/Blueprint/rows/R-1.YAML'] } });
  assert.deepEqual(Object.keys(await w.read({ product: ENTRY.product, card: 'C-1' })), ['R-1']);
  assert.equal(w.gh.asked.filter((p) => p.includes('/contents/')).length, 1);
  // The gate's pattern ignores case (M2 ROW_FILE), so a row file spelled in capitals is still a row file here.
  assert.deepEqual(Object.keys(await w.read({ product: ENTRY.product, card: 'C-7' })), ['R-1']);
});

test('A3a: the wired review ports read the card from the Record they are given', async () => {
  const gh = table({ [`${base}/git/ref/heads/main`]: { status: 200, json: { object: { sha: MAIN } } }, [rowPath('R-1')]: rowAnswer('id: R-1\ndone_when: x\n') });
  const ports = reviewPorts({ gh, entry: ENTRY, rec: cardRec({ 'C-1': { files: [rf('R-1')] } }), config: reviewConfig(temp()), now: Date.now, selfUid: SELF });
  assert.deepEqual(await ports.planRows({ product: ENTRY.product, card: 'C-1' }), { 'R-1': { id: 'R-1', done_when: 'x' } });
});

test('A3a: a row missing, unparsed or unread at main throws, naming the row and the commit', async () => {
  const ok = rowAnswer('id: R-1\ndone_when: x\n');
  for (const [answer, why] of [
    [{ status: 404, json: null }, /row R-2 is missing at main eeeeeee, or can't be read/],
    [rowAnswer('a: [unclosed\n\tb'), /row R-2 is missing at main eeeeeee, or can't be read/],
    [{ status: 200, json: [{ name: 'x' }] }, /row R-2 is missing at main eeeeeee, or can't be read/],
    [{ status: 500, json: null }, /answered 500/],
    [new Error('socket hang up'), /socket hang up/],
  ]) await assert.rejects(rowsWorld({ [rowPath('R-1')]: ok, [rowPath('R-2')]: answer }).read({ product: ENTRY.product, card: 'C-1' }), why);
});

test('A3a: a main that can\'t be read throws before any row is read', async () => {
  const gh = table({ [`${base}/git/ref/heads/main`]: { status: 404, json: null } });
  await assert.rejects(planRows({ gh, entry: ENTRY, rec: cardRec({ 'C-1': { files: [rf('R-1')] } }) })({ product: ENTRY.product, card: 'C-1' }), /answered 404/);
  assert.equal(gh.asked.length, 1);
  assert.throws(() => planRows({ gh, entry: ENTRY }), /planRows needs the Record/);
});

// ---- A3b (L703): the plan reviewer's two ports.
test('A3b: startPlanReview writes one plan request, the same one for the same plan, and refuses another product', async () => {
  const config = reviewConfig(temp());
  const ports = reviewPorts({ gh: client(), entry: ENTRY, rec: { read: () => null }, config, now: Date.now, selfUid: SELF });
  const fp = 'f'.repeat(64);
  const ask = (over = {}) => ports.startPlanReview({ lead: 'plan-review', product: ENTRY.product, card: 'C-7', fingerprint: fp, plan_sha256: 'a'.repeat(64), key: `C-7-${fp}`, ...over });
  const r = ask();
  assert.equal(r.ok, true, r.reason);
  assert.match(r.session, /^[0-9a-f]{64}$/);
  const files = readdirSync(config.reviewRequestsDir);
  assert.deepEqual(files, [`${r.session}.json`], 'one whole file, no hidden copy left');
  assert.deepEqual(JSON.parse(readFileSync(join(config.reviewRequestsDir, files[0]), 'utf8')), { card: 'C-7', fingerprint: fp, request_id: r.session, role: 'plan_reviewer' });
  assert.deepEqual(ask(), { ok: true, session: r.session }, 'asked again for the same plan: the same request, still one file');
  assert.deepEqual(readdirSync(config.reviewRequestsDir), files);
  assert.notEqual(ask({ fingerprint: 'e'.repeat(64), key: `C-7-${'e'.repeat(64)}` }).session, r.session, 'a new plan is a new request');
  assert.match(ask({ fingerprint: 'F'.repeat(64) }).reason, /no fingerprint/);
  assert.match(ask({ card: '../x' }).reason, /not a card id/);
  assert.match(ask({ key: `C-8-${fp}` }).reason, /the start's key is not its card and plan/, 'the one id is the card and plan the key names (L726 m1)');
  assert.throws(() => ask({ product: 'other' }), /can't ask about product other's plans/);
  assert.throws(() => ports.planReviewAnswer({ product: 'other', card: 'C-7', fingerprint: fp, session: r.session }), /can't ask about product other's plans/);
  // Nothing launched yet: still working.
  assert.deepEqual(ports.planReviewAnswer({ product: ENTRY.product, card: 'C-7', fingerprint: fp, session: r.session }), { ok: true });
  // A runner folder another user could write: an error, never "still working".
  chmodSync(join(config.reviewRequestsDir, '..'), 0o777);
  assert.throws(() => ports.planReviewAnswer({ product: ENTRY.product, card: 'C-7', fingerprint: fp, session: r.session }), /the review runner's folder/);
});
