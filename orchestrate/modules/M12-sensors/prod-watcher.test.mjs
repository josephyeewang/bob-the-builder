import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { makeFactWriter } from './facts.mjs';
import { makeAlerts, fakeIssues } from '../M13-ledger/alerts.mjs';
import { makeVercelReader } from './vercel-reader.mjs';
import { watchOnce, stateFactId } from './prod-watcher.mjs';
import { resolveStage, isSupported } from './supported.mjs';
import { FAKE } from './fakes.mjs';

const MAIN = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
const BRANCH = 'f'.repeat(40);

// A fake Vercel API behind the real reader, so the watcher sees exactly what the reader passes on.
function fakeVercel() {
  const s = {
    deployments: [], live: null,
    envs: [{ id: 'env_1', key: 'DATABASE_URL', target: ['production'], type: 'encrypted', updatedAt: 1, value: FAKE.dbPassword }],
    project: { commandForIgnoringBuildStep: 'node scripts/skip.mjs', buildCommand: null, framework: 'nextjs', nodeVersion: '22.x', link: { type: 'github', org: 'o', repo: 'r', productionBranch: 'main' } },
    domains: [{ name: 'example.test' }],
    answer: {}, // per list: an answer body that replaces the normal one (an error body, a renamed field)
  };
  const paths = [];
  const fetchJson = async (path) => {
    paths.push(path);
    if (path.startsWith('/v6/deployments')) return s.answer.deployments ?? { deployments: s.deployments };
    if (/\/env\?/.test(path)) return s.answer.envs ?? { envs: s.envs };
    if (/\/domains\?/.test(path)) return s.answer.domains ?? { domains: s.domains };
    return { ...s.project, targets: { production: { id: s.live } } };
  };
  return { s, paths, reader: makeVercelReader(fetchJson, { projectId: 'prj_test' }) };
}
let n = 0;
const dep = (sha, source = 'git', state = 'READY') => ({ uid: `dpl_${++n}`, created: n, readyState: state, target: 'production', source, meta: sha ? { githubCommitSha: sha } : {} });

function setup(rulesEntry = { stage: 'first' }) {
  const rec = memoryRecord();
  const gh = fakeIssues();
  const v = fakeVercel();
  const writer = makeFactWriter(rec);
  const alerts = makeAlerts({ rec, gh, owner: 'owner' });
  const pass = () => watchOnce({ vercel: v.reader, rulesEntry, mainFirstParent: new Set(MAIN), evidence: new Set(), writer, alerts, product: 'product 1' });
  return { rec, gh, v, pass, writer };
}
const kinds = (out) => out.map((o) => o.kind);

test('first pass is a baseline: history already there raises nothing', async () => {
  const t = setup();
  t.v.s.deployments = [dep(BRANCH, 'cli'), dep(MAIN[0])];
  t.v.s.live = t.v.s.deployments[1].uid;
  assert.deepEqual(await t.pass(), []);
  assert.equal(t.writer.get(stateFactId('product 1')).baseline, true);
});

test('case 1: a Git deploy of a main commit, served live → no alert', async () => {
  const t = setup();
  await t.pass();
  const d = dep(MAIN[1]); t.v.s.deployments = [d]; t.v.s.live = d.uid;
  assert.deepEqual(await t.pass(), []);
  assert.equal(t.gh.issues.size, 0);
});

test('case 2: a deploy of a non-main commit → unsupported-deploy alert', async () => {
  const t = setup();
  await t.pass();
  const d = dep(BRANCH); t.v.s.deployments = [d]; t.v.s.live = d.uid;
  const out = await t.pass();
  assert.deepEqual(kinds(out), ['unsupported-deploy']);
  assert.match(t.gh.issues.get(1).body, /not on main/);
});

test('M3: a CLI deploy carrying a MAIN commit is still unsupported (judged by source)', async () => {
  const t = setup();
  await t.pass();
  const d = dep(MAIN[2], 'cli'); t.v.s.deployments = [d]; t.v.s.live = d.uid;
  assert.deepEqual(kinds(await t.pass()), ['unsupported-deploy']);
  assert.match(t.gh.issues.get(1).body, /from cli, not the Git integration/);
  for (const src of ['redeploy', 'import', 'api', undefined]) assert.equal(isSupported({ source: src, sha: MAIN[0] }, { stage: 'first', mainFirstParent: new Set(MAIN) }).ok, false);
});

test('case 3: an older deployment promoted (or rolled back) → old-version-live; cleared when the newest is live again', async () => {
  const t = setup();
  const d1 = dep(MAIN[0]); const d2 = dep(MAIN[1]);
  t.v.s.deployments = [d2, d1]; t.v.s.live = d2.uid;
  await t.pass();
  t.v.s.live = d1.uid;
  assert.deepEqual(kinds(await t.pass()), ['old-version-live']);
  t.v.s.live = d2.uid;
  await t.pass();
  assert.equal(t.gh.issues.get(1).closed, true);
});

test('case 4: a production env variable updated → setting-changed naming the key, never the value', async () => {
  const t = setup();
  await t.pass();
  t.v.s.envs[0] = { ...t.v.s.envs[0], updatedAt: 2, value: FAKE.supabaseSecret };
  const out = await t.pass();
  assert.deepEqual(kinds(out), ['setting-changed']);
  assert.match(t.gh.issues.get(1).title, /DATABASE_URL updated/);
  t.v.s.envs.push({ id: 'env_2', key: 'NEW_FLAG', target: ['production', 'preview'], type: 'plain', updatedAt: 3, value: 'on' });
  assert.match((await t.pass())[0].subject, /^env:env_2:/);
  t.v.s.envs.push({ id: 'env_3', key: 'PREVIEW_ONLY', target: ['preview'], type: 'plain', updatedAt: 3, value: 'x' });
  assert.deepEqual(await t.pass(), [], 'a preview-only variable is not production');
});

test('M4: a project setting changed (the build-skip command) → alert names the field', async () => {
  const t = setup();
  await t.pass();
  t.v.s.project.commandForIgnoringBuildStep = 'exit 1';
  const out = await t.pass();
  assert.deepEqual(kinds(out), ['setting-changed']);
  assert.match(t.gh.issues.get(1).title, /commandForIgnoringBuildStep/);
  assert.doesNotMatch(t.gh.issues.get(1).body, /exit 1/);
  t.v.s.domains.push({ name: 'other.test' });
  assert.match((await t.pass())[0].subject, /^project:productionDomains:/);
  t.v.s.domains.push({ name: 'preview.test', gitBranch: 'dev' });
  assert.deepEqual(await t.pass(), [], 'a branch domain is not a production domain');
});

test('case 5: a cancelled build (build-skip refused it) or a failed one raises nothing', async () => {
  const t = setup();
  await t.pass();
  t.v.s.deployments = [dep(BRANCH, 'cli', 'CANCELED'), dep(BRANCH, 'git', 'ERROR'), dep(BRANCH, 'git', 'BUILDING')];
  assert.deepEqual(await t.pass(), []);
});

test('no env value ever reaches the record or an issue (planted fake keys)', async () => {
  const t = setup();
  t.v.s.envs.push({ id: 'env_9', key: 'PLAIN_ONE', target: ['production'], type: 'plain', updatedAt: 1, value: FAKE.anthropic, decryptedValue: FAKE.github });
  await t.pass();
  t.v.s.envs[1] = { ...t.v.s.envs[1], updatedAt: 5, value: FAKE.vercelClassic };
  await t.pass();
  const all = JSON.stringify(t.rec.diary()) + JSON.stringify([...t.gh.issues.values()]);
  for (const k of [FAKE.anthropic, FAKE.github, FAKE.vercelClassic, FAKE.dbPassword, FAKE.supabaseSecret]) assert.equal(all.includes(k), false);
  const env = await t.v.reader.envMeta();
  for (const e of env) assert.deepEqual(Object.keys(e).sort(), ['id', 'key', 'target', 'type', 'updatedAt']);
});

test('the reader only asks for GET-able read paths, never a decrypt', async () => {
  const t = setup();
  await t.pass();
  assert.ok(t.v.paths.length > 0);
  for (const p of t.v.paths) { assert.doesNotMatch(p, /decrypt/); assert.match(p, /^\/v\d+\/(deployments|projects)\b/); }
});

test('a persistent unsupported deploy over 60 passes → one issue, no extra comments', async () => {
  const t = setup();
  await t.pass();
  const d1 = dep(MAIN[0]); const bad = dep(BRANCH, 'cli');
  t.v.s.deployments = [bad, d1]; t.v.s.live = bad.uid;
  for (let i = 0; i < 60; i++) await t.pass();
  assert.equal(t.gh.calls.filter(([c]) => c === 'open').length, 2, 'one for the deploy, one for old-version-live');
  assert.equal(t.gh.calls.filter(([c]) => c === 'comment').length, 0);
});

test('M2: a rules entry with no stage → strict rule plus one deduped no-stage alert', async () => {
  const t = setup({});
  await t.pass(); await t.pass();
  assert.equal([...t.gh.issues.values()].filter((i) => /no stage/.test(i.title)).length, 1);
  const d = dep(MAIN[0]); t.v.s.deployments = [d]; t.v.s.live = d.uid;
  assert.ok(kinds(await t.pass()).includes('unsupported-deploy'), 'main commit without evidence fails the strict rule');
  assert.deepEqual(resolveStage({ stage: 'bogus' }), { stage: 'second', fallback: true, auditCheck: true });
  assert.deepEqual(resolveStage({ stage: 'first' }), { stage: 'first', fallback: false, auditCheck: false });
  assert.equal(resolveStage({ stage: 'first', post_merge_audit: true }).auditCheck, true);
});

test('stage second: a main Git deploy needs the merge-gate evidence', () => {
  const base = { source: 'git', sha: MAIN[0] };
  assert.equal(isSupported(base, { stage: 'second', mainFirstParent: new Set(MAIN) }).ok, false);
  assert.equal(isSupported(base, { stage: 'second', mainFirstParent: new Set(MAIN), evidence: new Set([MAIN[0]]) }).ok, true);
  assert.equal(isSupported({ source: 'git', sha: null }, { stage: 'first', mainFirstParent: new Set(MAIN) }).ok, false);
});

test('0b-7 audit M-1: a CLI deploy first seen while building is judged when it turns READY', async () => {
  const t = setup();
  await t.pass();
  const d = dep(MAIN[2], 'cli', 'BUILDING'); t.v.s.deployments = [d];
  assert.deepEqual(await t.pass(), []);
  d.readyState = 'READY'; t.v.s.live = d.uid;
  assert.deepEqual(kinds(await t.pass()), ['unsupported-deploy']);
  assert.deepEqual(kinds(await t.pass()).filter((k) => k === 'unsupported-deploy'), [], 'judged once, not every pass');
});

test('a Vercel read error raises one "cannot read" alert, cleared when reading works again', async () => {
  const t = setup();
  await t.pass();
  const good = t.v.s.deployments;
  Object.defineProperty(t.v.s, 'deployments', { configurable: true, get() { throw Object.assign(new Error('x'), { status: 403 }); } });
  assert.deepEqual(kinds(await t.pass()), ['watcher-cannot-read']);
  await t.pass();
  assert.equal(t.gh.issues.size, 1);
  assert.match([...t.gh.issues.values()][0].body, /HTTP 403/);
  Object.defineProperty(t.v.s, 'deployments', { configurable: true, writable: true, value: good });
  await t.pass();
  assert.equal([...t.gh.issues.values()][0].closed, true);
});

test('0b-7 audit round 2 M-2: a Vercel answer missing the fields the watcher reads raises "cannot read", never a quiet pass', async () => {
  const cases = [
    ['state under another name', (t) => { for (const d of t.v.s.deployments) { d.status = d.readyState; delete d.readyState; } }],
    ['live id absent', (t) => { t.v.s.live = null; }],
    ['production branch absent', (t) => { delete t.v.s.project.link.productionBranch; }],
    ['link absent', (t) => { delete t.v.s.project.link; }],
  ];
  for (const [name, breakIt] of cases) {
    const t = setup();
    const d1 = dep(MAIN[0]);
    t.v.s.deployments = [d1]; t.v.s.live = d1.uid;
    await t.pass();
    const rb = dep(BRANCH, 'cli'); t.v.s.deployments = [rb, d1]; t.v.s.live = rb.uid;
    breakIt(t);
    assert.deepEqual(kinds(await t.pass()), ['watcher-cannot-read'], name);
    assert.match([...t.gh.issues.values()][0].body, /shape the production watcher does not know/, name);
  }
});

test('0b-7 audit round 3 M-C: an error body or renamed list field from Vercel raises "cannot read" on every pass, never "no deploys"', async () => {
  for (const list of ['deployments', 'envs', 'domains']) {
    const t = setup();
    t.v.s.deployments = [dep(MAIN[0])]; t.v.s.live = t.v.s.deployments[0].uid;
    await t.pass();
    t.v.s.answer[list] = { error: { code: 'forbidden' } };
    const d = dep(BRANCH, 'cli'); t.v.s.deployments = [d, ...t.v.s.deployments]; t.v.s.live = d.uid;
    for (let i = 0; i < 2; i++) assert.deepEqual(kinds(await t.pass()), ['watcher-cannot-read'], list);
    t.v.s.answer[list] = { [`${list}V2`]: [] };
    assert.deepEqual(kinds(await t.pass()), ['watcher-cannot-read'], `${list} renamed`);
    assert.equal(t.gh.issues.get(1).closed, false);
  }
});

// ---- L143: what the pass saves after a raise (a deploy seen, a setting's baseline) is saved only when it went out ----

// A plain alert stand-in that can lose the alert (L145): `decide(alert)` gives the raise's answer, or throws. It answers
// what the real raise answers ('opened' … or false), never `true` (L152 m1, Principle 10).
function sink(decide = () => 'opened') {
  const raise = async (a) => { raise.texts.push(a); const r = decide(a); raise.answers.push(r); return r; };
  raise.texts = []; raise.answers = [];
  raise.reset = () => { raise.texts.length = 0; raise.answers.length = 0; };
  return raise;
}
const downWhen = (cond) => (a) => { if (cond(a)) throw new Error('github down'); return 'opened'; };

// The watcher's record writer runs on its own fixed clock, apart from the alerts' tick (L143).
function lossSetup(raise, rulesEntry = { stage: 'first' }) {
  const rec = memoryRecord();
  const v = fakeVercel();
  const writer = makeFactWriter(rec, { now: () => new Date('2026-01-01T00:00:00Z') });
  // The real clear can answer false (L143); nothing the pass saves may hang on it (L152 m1).
  const alerts = { raise, clear: async () => false, reportTrouble: async () => 'none' };
  const pass = () => watchOnce({ vercel: v.reader, rulesEntry, mainFirstParent: new Set(MAIN), evidence: new Set(), writer, alerts, product: 'product 1' });
  return { v, pass, writer };
}
const subjects = (raise, kind) => raise.texts.filter((a) => a.key.includes(`|${kind}|`)).map((a) => a.key.split('|')[2]);

test('L143: an env change whose raise answered false is raised again next pass; a sent one beside it is not', async () => {
  let lose = true;
  const raise = sink((a) => (lose && a.key.includes('|setting-changed|env:env_1:') ? false : 'opened'));
  const t = lossSetup(raise);
  await t.pass();
  t.v.s.envs[0] = { ...t.v.s.envs[0], updatedAt: 2 };
  t.v.s.envs.push({ id: 'env_2', key: 'NEW_FLAG', target: ['production'], type: 'plain', updatedAt: 3 });
  await t.pass();
  assert.equal(subjects(raise, 'setting-changed').length, 2);
  assert.deepEqual(raise.answers, [false, 'opened']);
  raise.reset(); lose = false;
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed').map((s) => s.split(':')[1]), ['env_1'], 'only the lost one again');
  raise.reset();
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed'), [], 'sent: not raised a third time');
});

test('L143: a removed env var and a project setting whose raises answered false are raised again next pass', async () => {
  let lose = true;
  const raise = sink(() => (lose ? false : 'opened'));
  const t = lossSetup(raise);
  await t.pass();
  t.v.s.envs = [];
  t.v.s.project.commandForIgnoringBuildStep = 'exit 1';
  await t.pass();
  const first = subjects(raise, 'setting-changed');
  assert.equal(first.length, 2);
  raise.reset(); lose = false;
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed'), first, 'both raised again, the same keys');
  raise.reset();
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed'), []);
});

test('L143: an unsupported deploy whose raise answered false is not marked seen, so it is raised again next pass', async () => {
  let lose = true;
  const raise = sink((a) => (lose && a.key.includes('|unsupported-deploy|') ? false : 'opened'));
  const t = lossSetup(raise);
  await t.pass();
  const d = dep(BRANCH);
  t.v.s.deployments = [d]; t.v.s.live = d.uid;
  await t.pass();
  assert.deepEqual(subjects(raise, 'unsupported-deploy'), [d.uid]);
  assert.ok(!t.writer.get(stateFactId('product 1')).seen.includes(d.uid));
  raise.reset(); lose = false;
  await t.pass();
  assert.deepEqual(subjects(raise, 'unsupported-deploy'), [d.uid], 'raised again');
  raise.reset();
  await t.pass();
  assert.deepEqual(subjects(raise, 'unsupported-deploy'), [], 'sent: judged once');
});

test('L143: a raise that throws stops the pass and saves no baseline, so the next pass raises the change', async () => {
  let down = true;
  const raise = sink(downWhen((a) => down && a.key.includes('|setting-changed|')));
  const t = lossSetup(raise);
  await t.pass();
  const base = t.writer.get(stateFactId('product 1'));
  t.v.s.envs[0] = { ...t.v.s.envs[0], updatedAt: 2 };
  await assert.rejects(t.pass(), /github down/);
  assert.deepEqual(t.writer.get(stateFactId('product 1')), base);
  raise.reset(); down = false;
  await t.pass();
  assert.equal(subjects(raise, 'setting-changed').length, 1);
});

test('L143: through the real M13 alerts, a GitHub open with no issue number makes the next pass open it', async () => {
  let t0 = Date.parse('2026-11-03T08:00:00Z');
  const rec = memoryRecord();
  const gh = fakeIssues();
  const open = gh.open;
  gh.open = async () => undefined;
  const alerts = makeAlerts({ rec, gh, owner: 'owner', now: () => new Date(t0) });
  const t = lossSetup(alerts.raise);
  await t.pass();
  t.v.s.envs[0] = { ...t.v.s.envs[0], updatedAt: 2 };
  await t.pass();
  assert.equal(gh.issues.size, 0);
  gh.open = open; t0 += 60e3;
  await t.pass();
  assert.equal(gh.issues.size, 1, 'opened on the next pass, not suppressed');
  assert.match(gh.issues.get(1).title, /production setting DATABASE_URL updated/);
  await t.pass();
  assert.equal(gh.issues.size, 1, 'and once');
});

test('L143: an added env var whose raise answered false stays out of the baseline, so it is raised again next pass', async () => {
  let lose = true;
  const raise = sink(() => (lose ? false : 'opened'));
  const t = lossSetup(raise);
  await t.pass();
  t.v.s.envs.push({ id: 'env_2', key: 'NEW_FLAG', target: ['production'], type: 'plain', updatedAt: 3 });
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed').map((s) => s.split(':')[1]), ['env_2']);
  assert.equal(t.writer.get(stateFactId('product 1')).env.env_2, undefined, 'not in the baseline');
  raise.reset(); lose = false;
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed').map((s) => s.split(':')[1]), ['env_2'], 'raised again');
  raise.reset();
  await t.pass();
  assert.deepEqual(subjects(raise, 'setting-changed'), []);
});

// ---- L153: every watchOnce raise, lost (false, then a throw), is tried again on the next pass ----

// `lossy(kind)` answers false or throws for that kind's raise while `on` (set after the baseline pass); every other
// raise answers 'opened'.
function lossy(kind, how) {
  const st = { on: false };
  const raise = sink((a) => {
    if (st.on && a.key.includes(`|${kind}|`)) { if (how === 'throw') throw new Error('github down'); return false; }
    return 'opened';
  });
  return { raise, st };
}
// Sets the world so the kind's condition holds on the next pass (after a baseline pass).
const CONDITIONS = {
  'watcher-cannot-read': { rules: { stage: 'first' }, make: (t) => { t.v.s.answer.deployments = { error: { code: 'forbidden' } }; } },
  'watcher-cannot-read (odd shape)': { kind: 'watcher-cannot-read', rules: { stage: 'first' }, make: (t) => { t.v.s.deployments = [dep(MAIN[0], 'git', 'NEW_STATE')]; } },
  // The no-stage condition already holds on the baseline pass, so its "lost" raise is a repeat, not a first notice (#98
  // r1 c3); it still demands a raise on every pass, which is what a "remember it" plant breaks.
  'no-stage': { rules: {}, make: () => {}, repeat: true },
  'old-version-live': { rules: { stage: 'first' }, before: (t) => { const d1 = dep(MAIN[0]); const d2 = dep(MAIN[1]); t.v.s.deployments = [d2, d1]; t.v.s.live = d2.uid; t.d1 = d1; }, make: (t) => { t.v.s.live = t.d1.uid; } },
  'unsupported-deploy': { rules: { stage: 'first' }, make: (t) => { const d = dep(BRANCH, 'cli'); t.v.s.deployments = [d, ...t.v.s.deployments]; t.v.s.live = d.uid; } },
};
for (const [name, c] of Object.entries(CONDITIONS)) {
  const kind = c.kind ?? name;
  for (const how of ['false', 'throw']) {
    const what = `${c.repeat ? 'repeat ' : ''}${name}`;
    test(`L153: ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} raise that ${how === 'throw' ? 'threw' : 'answered false'} is raised again on the next pass`, async () => {
      const { raise, st } = lossy(kind, how);
      const t = lossSetup(raise, c.rules);
      c.before?.(t);
      await t.pass();
      c.make(t);
      raise.reset(); st.on = true;
      if (how === 'throw') await assert.rejects(t.pass(), /github down/); else await t.pass();
      const firstKeys = raise.texts.filter((a) => a.key.includes(`|${kind}|`)).map((a) => a.key);
      assert.equal(firstKeys.length, 1, 'raised once and lost');
      raise.reset(); st.on = false;
      await t.pass();
      assert.deepEqual(raise.texts.filter((a) => a.key.includes(`|${kind}|`)).map((a) => a.key), firstKeys, 'tried again, the same key');
      if (kind === 'unsupported-deploy') {
        raise.reset();
        await t.pass();
        assert.equal(raise.texts.filter((a) => a.key.includes(`|${kind}|`)).length, 0, 'sent: judged once');
      }
    });
  }
}

// L376: which HTTP code or shape problem it is goes in the body, not in the cause. Otherwise a flapping upstream opens a
// new issue on every close. A different deploy live, in old-version-live, is a new event and does open one.
const failWith = (t, status) => Object.defineProperty(t.v.s, 'deployments', { configurable: true, get() { throw Object.assign(new Error('x'), { status }); } });
const readsAgain = (t, good) => Object.defineProperty(t.v.s, 'deployments', { configurable: true, writable: true, value: good });

test('L376: 502, closed by the owner, then 503: no new issue; a clean read, then 502 again: one new issue', async () => {
  const t = setup();
  await t.pass();
  const good = t.v.s.deployments;
  failWith(t, 502); await t.pass();
  assert.equal(t.gh.issues.size, 1);
  t.gh.ownerCloses(1);
  failWith(t, 503); await t.pass(); await t.pass();
  assert.equal(t.gh.issues.size, 1, 'the same problem, and the owner answered it');
  readsAgain(t, good); await t.pass();
  failWith(t, 502); await t.pass();
  assert.equal(t.gh.issues.size, 2, 'it came back after reading fine');
  assert.equal(t.gh.issues.get(2).closed, false);
});

test('L376: a shape problem after a closed HTTP error is the same cause: no new issue', async () => {
  const t = setup();
  await t.pass();
  const good = t.v.s.deployments;
  failWith(t, 502); await t.pass();
  t.gh.ownerCloses(1);
  readsAgain(t, [dep(MAIN[0], 'git', 'NEW_STATE')]);
  assert.deepEqual(await t.pass(), [{ kind: 'watcher-cannot-read', subject: 'vercel', result: 'suppressed' }]);
  assert.equal(t.gh.issues.size, 1);
});

test('L376: on an open issue, 502 then 503 updates the body and sends no comment', async () => {
  const t = setup();
  await t.pass();
  failWith(t, 502); await t.pass();
  failWith(t, 503); await t.pass();
  const issue = t.gh.issues.get(1);
  assert.match(issue.body, /HTTP 503/);
  assert.equal(issue.comments.length, 0);
});

test('L376: after a close, a different old deploy live opens a new issue, and the same one stays quiet', async () => {
  const t = setup();
  const a = dep(MAIN[0]); const b = dep(MAIN[1]); const c = dep(MAIN[2]);
  t.v.s.deployments = [a, b, c]; t.v.s.live = c.uid;
  await t.pass();
  t.v.s.live = a.uid; await t.pass();
  const opened = t.gh.issues.size;
  assert.equal(opened, 1);
  t.gh.ownerCloses(1);
  await t.pass();
  assert.equal(t.gh.issues.size, 1);
  t.v.s.live = b.uid; await t.pass();
  assert.equal(t.gh.issues.size, 2);
});

// L393: what the watcher can't save. The Record refuses what `world.refuse` says; alerts and the watcher share that.
function refusingWatch() {
  const t = setup();
  const world = { refuse: () => false };
  const refusing = (w) => ({ get: w.get, put: (id, doc) => (world.refuse(doc) ? { ok: false, reason: 'the store is full' } : w.put(id, doc)) });
  const writer = refusing(t.writer);
  const alerts = makeAlerts({ rec: t.rec, gh: t.gh, owner: 'owner', writer: refusing(makeFactWriter(t.rec, { actor: 'ledger' })) });
  const pass = () => watchOnce({ vercel: t.v.reader, rulesEntry: { stage: 'first' }, mainFirstParent: new Set(MAIN), evidence: new Set(), writer, alerts, product: 'product 1' });
  return { ...t, world, pass };
}
const heal = (t) => Object.defineProperty(t.v.s, 'deployments', { configurable: true, writable: true, value: [] });
const ofKind = (out, kind) => out.filter((o) => o.kind === kind).map((o) => o.result);
const readIssues = (t) => [...t.gh.issues.values()].filter((i) => /cannot read Vercel/.test(i.title));
const savedIssues = (t) => [...t.gh.issues.values()].filter((i) => /cannot save what it saw/.test(i.title));
const troubleIssues = (t) => [...t.gh.issues.values()].filter((i) => /refusing alert writes/.test(i.title));

test('L393 MAT-A, L401: a clear the Record refused stands on the issue, so when reading fails again the owner gets a new issue', async () => {
  const t = refusingWatch();
  await t.pass();
  failWith(t, 500);
  assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-read'), ['opened']);
  heal(t);
  t.world.refuse = (doc) => doc.kind === 'fact.alert';
  assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-read'), ['cleared']);
  assert.equal(t.gh.issues.get(1).closed, true);
  t.world.refuse = () => false;
  failWith(t, 502);
  assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-read'), ['opened']);
  for (const code of [503, 500]) { failWith(t, code); assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-read'), ['updated']); }
  assert.equal(t.gh.issues.get(2).closed, false);
  assert.equal(t.gh.issues.get(2).comments.length, 0);
});

test('L401: the same with the Record still refusing when reading fails again: one new issue, and the Record gets one alert of its own', async () => {
  const t = refusingWatch();
  await t.pass();
  failWith(t, 500);
  await t.pass();
  heal(t);
  t.world.refuse = (doc) => doc.kind === 'fact.alert';
  await t.pass();
  failWith(t, 502);
  const answers = [];
  for (let i = 0; i < 5; i++) { const out = await t.pass(); answers.push(...ofKind(out, 'watcher-cannot-read')); }
  assert.deepEqual(answers, ['opened', 'updated', 'updated', 'updated', 'updated']);
  assert.equal(readIssues(t).length, 2);
  assert.equal(troubleIssues(t).length, 1);
  t.world.refuse = () => false;
  assert.deepEqual(ofKind(await t.pass(), 'alerts'), ['cleared']);
  assert.equal(troubleIssues(t)[0].closed, true);
  assert.equal(readIssues(t).length, 2);
});

test('L393: a baseline the Record refuses is raised, once, and cleared when it saves; the watcher then alerts again', async () => {
  const t = refusingWatch();
  const live = dep(MAIN[0]);
  t.v.s.deployments = [live]; t.v.s.live = live.uid;
  t.world.refuse = (doc) => doc.kind === 'fact.prod-watch';
  assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-save'), ['opened']);
  assert.match(t.gh.issues.get(1).body, /The Record refused what the production watcher saw \(the store is full\)/);
  for (let i = 0; i < 4; i++) assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-save'), ['updated']);
  assert.equal(t.gh.issues.size, 1);
  t.world.refuse = () => false;
  assert.deepEqual(ofKind(await t.pass(), 'watcher-cannot-save'), ['cleared']);
  assert.equal(t.gh.issues.get(1).closed, true);
  assert.deepEqual(await t.pass(), [], 'a pass that saved the same again is quiet');
  const bad = dep(BRANCH, 'cli');
  t.v.s.deployments = [live, bad];
  assert.ok(kinds(await t.pass()).includes('unsupported-deploy'));
});

test('L401: a baseline refused with the alert\'s cache refused too: one issue however many passes', async () => {
  const t = refusingWatch();
  t.world.refuse = () => true;
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push(...ofKind(await t.pass(), 'watcher-cannot-save'));
  assert.deepEqual(answers, ['opened', 'updated', 'updated', 'updated', 'updated']);
  assert.equal(savedIssues(t).length, 1);
  assert.equal(troubleIssues(t).length, 1);
});

// L402 m5: which reason the Record gives goes in the body, not in the cause.
test('L402 m5: two refusal reasons are one cause: no comment on an open issue, and no new issue after the owner closed it', async () => {
  const t = setup();
  const reason = { now: 'the store is full' };
  const writer = { get: t.writer.get, put: () => ({ ok: false, reason: reason.now }) };
  const alerts = makeAlerts({ rec: t.rec, gh: t.gh, owner: 'owner' });
  const pass = () => watchOnce({ vercel: t.v.reader, rulesEntry: { stage: 'first' }, mainFirstParent: new Set(MAIN), evidence: new Set(), writer, alerts, product: 'product 1' });
  assert.deepEqual(ofKind(await pass(), 'watcher-cannot-save'), ['opened']);
  reason.now = 'a different reason';
  assert.deepEqual(ofKind(await pass(), 'watcher-cannot-save'), ['updated']);
  assert.match(t.gh.issues.get(1).body, /a different reason/);
  assert.equal(t.gh.issues.get(1).comments.length, 0);
  t.gh.ownerCloses(1);
  reason.now = 'a third reason';
  assert.deepEqual(ofKind(await pass(), 'watcher-cannot-save'), ['suppressed']);
  assert.equal(t.gh.issues.size, 1);
});

// L402 condition: a notice left owed answers false, and the watcher shows that on every pass.
test('L402 owed: a daily reminder stuck on a failed read is in the pass\'s answer every time, with one comment over them all', async () => {
  let at = Date.parse('2026-11-03T12:00:00Z');
  const now = () => new Date(at);
  const t = setup();
  const gh = fakeIssues({ now });
  const alerts = makeAlerts({ rec: t.rec, gh, owner: 'owner', now });
  const pass = () => watchOnce({ vercel: t.v.reader, rulesEntry: { stage: 'first' }, mainFirstParent: new Set(MAIN), evidence: new Set(), writer: t.writer, alerts, product: 'product 1' });
  await pass();
  failWith(t, 502);
  await pass();
  at += 25 * 3600e3;
  const { edit, latestOwnComment } = gh;
  let n = 0;
  gh.edit = async (...a) => { n += 1; return n === 2 ? false : edit(...a); };
  assert.deepEqual(ofKind(await pass(), 'watcher-cannot-read'), [false]);
  gh.edit = edit;
  gh.latestOwnComment = async () => false;
  for (let i = 0; i < 3; i++) { at += 60e3; assert.deepEqual(ofKind(await pass(), 'watcher-cannot-read'), [false], `pass ${i}`); }
  assert.equal(gh.issues.get(1).comments.length, 1);
  gh.latestOwnComment = latestOwnComment;
  assert.notDeepEqual(ofKind(await pass(), 'watcher-cannot-read'), [false]);
  assert.equal(gh.issues.get(1).comments.length, 1, 'found on GitHub, so not sent twice');
});

test('r4 m2: a robot login that could not be read is in the pass\'s answer, and a known one is not', async () => {
  for (const [why, want] of [['the robot\'s own login could not be read', ['the robot\'s own login could not be read']], [null, []]]) {
    const t = setup();
    const alerts = { raise: async () => 'opened', clear: async () => 'none', reportTrouble: async () => 'none', loginTrouble: () => why };
    const out = await watchOnce({ vercel: t.v.reader, rulesEntry: { stage: 'first' }, mainFirstParent: new Set(MAIN), evidence: new Set(), writer: t.writer, alerts, product: 'product 1' });
    assert.deepEqual(ofKind(out, 'alerts'), want);
  }
});

test('L402: an alert about the Record that GitHub lost is in the pass\'s answer, and a quiet one is not', async () => {
  for (const [answer, want] of [[false, [false]], ['none', []], ['opened', ['opened']], ['cleared', ['cleared']]]) {
    const t = setup();
    const alerts = { raise: async () => 'opened', clear: async () => 'none', reportTrouble: async () => answer };
    const out = await watchOnce({ vercel: t.v.reader, rulesEntry: { stage: 'first' }, mainFirstParent: new Set(MAIN), evidence: new Set(), writer: t.writer, alerts, product: 'product 1' });
    assert.deepEqual(ofKind(out, 'alerts'), want);
  }
});
