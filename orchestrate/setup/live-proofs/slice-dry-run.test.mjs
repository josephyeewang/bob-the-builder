// slice-dry-run.test.mjs — step 1's rows on a slice-shaped rules file (the first-cutover sample with the slice's caps
// and the owner's test_product yes), and each N5 plant the auditor named (L1122 m6: P8, P11, P16, P20) turning its own
// row FAIL. Plus the reader's state: an unlisted blob, a damaged copy, a missing copy, an unreadable list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST, swap } from '../../modules/M10-rules/first-cutover.test-helper.mjs';
import { blobSha } from '../../modules/M10-rules/reader.mjs';
import { rulesRows, mergeRow, dryRun, parseArgs, main, NOT_WIRED } from './slice-dry-run.mjs';

const P = 'sample-app';
const BOT = '1000099';
const COMMIT = 'c'.repeat(40);

// The slice's rules: one editing session while active, none away/light/amber, and the owner's test_product yes.
const SLICE = [
  (t) => swap(t, '\n  editing_per_product: 0\n', '\n  editing_per_product: 1\n'),
  (t) => swap(t, '    active: 1\n    away: 1\n    paused: 0\n    light: 1\n', '    active: 1\n    away: 0\n    paused: 0\n    light: 0\n'),
  (t) => swap(t, '      editing_per_product: 1\n', '      editing_per_product: 0\n'),
  (t) => swap(t, '  cutover_stage: first\n', "  cutover_stage: first\n  test_product: 'true'\n"),
].reduce((t, f) => f(t), FIRST);

const state = (text, { list } = {}) => {
  const blob = blobSha(Buffer.from(text, 'utf8'));
  return { approved: { [P]: list ?? [blob] }, lastGood: { text, commit: COMMIT, blob } };
};
const rows = (text, o = {}) => rulesRows({ product: P, bot: BOT, ...state(text, o), ...o.over });
const failed = (rs) => rs.filter((r) => !r.ok).map((r) => r.what);
const only = (rs, re) => { const f = failed(rs); assert.equal(f.length, 1, `one FAIL row, got: ${JSON.stringify(f)}`); assert.match(f[0], re); };

test('the slice rules: every step-1 row PASSes', () => {
  const rs = rows(SLICE);
  assert.deepEqual(failed(rs), []);
  assert.ok(rs.length >= 18, `all rows were tried (${rs.length})`);
});

test('the first-cutover sample as is fails: no test_product, no editing session while active', () => {
  const f = failed(rows(FIRST));
  assert.ok(f.some((w) => /test_product/.test(w)));
  assert.ok(f.some((w) => /one editing session while the product is active/.test(w)));
});

test('P8: an editing session while away fails its own row', () => {
  only(rows(swap(SLICE, '    away: 0\n    paused: 0', '    away: 1\n    paused: 0')), /while it is away/);
});

test('an editing session while light fails its own row', () => {
  only(rows(swap(SLICE, '    light: 0\n', '    light: 1\n')), /while it is light/);
});

test('P11: an editing session at the amber band fails its own row', () => {
  only(rows(swap(SLICE, '      editing_per_product: 0\n', '      editing_per_product: 1\n')), /amber/);
});

test('two editing sessions while active fails its own row; shakedown\'s one worker alone still holds it to one', () => {
  const two = swap(swap(SLICE, '    active: 1\n', '    active: 2\n'), '\n  editing_per_product: 1\n', '\n  editing_per_product: 2\n');
  assert.deepEqual(failed(rows(two)), []);
  only(rows(swap(two, '  shakedown_workers: 1\n', '  shakedown_workers: 2\n')), /one editing session while the product is active/);
});

test('P16: away merging Tier 1 at any hour fails its own row', () => {
  const t = SLICE.replace(/(\n  away:\n(?:    .*\n)*?    tier1_merge: )tier1_hours_only/, '$1rules');
  assert.notEqual(t, SLICE, 'the plant found its target');
  only(rows(t), /Tier 1 merges wait for Tier 1 hours/);
});

test('P20: a bot id in the file that is not the App\'s fails its own row', () => {
  only(rows(swap(SLICE, 'bot_user_id: 1000099', 'bot_user_id: 1')), /bot id is 1000099/);
});

test('a --bot-id that is not a bot id fails, and says so', () => {
  const rs = rulesRows({ product: P, bot: 'robot', ...state(SLICE) });
  const f = rs.filter((r) => !r.ok);
  assert.equal(f.length, 1);
  assert.match(f[0].why, /is not a bot id/);
});

test('test_product unquoted reads the same as quoted (the parser gives text)', () => {
  assert.deepEqual(failed(rows(swap(SLICE, "  test_product: 'true'\n", '  test_product: true\n'))), []);
});

test('test_product missing, false or yes fails its own row', () => {
  for (const to of ['', "  test_product: 'false'\n", '  test_product: yes\n']) {
    const t = swap(SLICE, "  test_product: 'true'\n", to);
    const f = failed(rows(t));
    assert.ok(f.length >= 1 && f.every((w) => /test_product|module checks/.test(w)) && f.some((w) => /test_product/.test(w)), `${JSON.stringify(to)}: ${JSON.stringify(f)}`);
  }
});

test('a third lane fails the lanes row', () => {
  const t = SLICE.replace(/\nlanes:\n/, '\nlanes:\n  code:\n    - src/**\n');
  assert.notEqual(t, SLICE);
  const f = failed(rows(t));
  assert.ok(f.some((w) => /docs and research only/.test(w)), JSON.stringify(f));
});

test('P3: a lane widened to the whole repo fails its own row', () => {
  const t = SLICE.replace(/(\n  docs:\n    - )[^\n]+/, "$1'**'");
  assert.notEqual(t, SLICE);
  only(rows(t), /no lane covers the whole repo/);
});

test('P17: shakedown off fails its own row', () => {
  only(rows(swap(SLICE, '  shakedown: true\n', '  shakedown: false\n')), /shakedown is on/);
});

test('the approval list: a blob not on it, no entry for the product, or a list that cannot be read, each FAIL', () => {
  only(rows(SLICE, { list: ['f'.repeat(40)] }), /on the approval list/);
  const s = state(SLICE);
  only(rulesRows({ product: P, bot: BOT, lastGood: s.lastGood, approved: { other: s.approved[P] } }), /on the approval list/);
  const e = Object.assign(new Error('no'), { code: 'ENOENT' });
  const rs = rulesRows({ product: P, bot: BOT, lastGood: s.lastGood, approved: e });
  only(rs, /on the approval list/);
  assert.match(rs.find((r) => !r.ok).why, /ENOENT/);
});

test('a damaged copy (text not matching its blob) fails, even when its blob is on the list', () => {
  const s = state(SLICE);
  const lastGood = { ...s.lastGood, text: SLICE + '# changed\n' };
  only(rulesRows({ product: P, bot: BOT, approved: s.approved, lastGood }), /hashes to its blob/);
});

test('no copy in force: the first row fails and the rest are not tried, never passed', () => {
  for (const lastGood of [Object.assign(new Error('x'), { code: 'ENOENT' }), {}, { text: SLICE, commit: 'x', blob: 'y' }, null]) {
    const rs = rulesRows({ product: P, bot: BOT, approved: {}, lastGood });
    assert.equal(rs.length, 2);
    assert.ok(rs.every((r) => !r.ok));
  }
});

test('rules that do not parse fail, and the rest are not tried', () => {
  const rs = rows('this: [is not\n');
  assert.ok(rs.some((r) => !r.ok && /parse/.test(r.what)));
  assert.match(rs.at(-1).why, /not tried/);
});

test('dryRun reads the reader\'s own files under rulesStateDir, and is never a PASS while steps are NOT WIRED', () => {
  const s = state(SLICE);
  const files = { '/c.json': { rulesStateDir: '/rs' }, '/rs/approved-rules.json': s.approved, [`/rs/${P}.last-good.json`]: s.lastGood };
  const seen = [];
  const read = (f) => { seen.push(f); if (!(f in files)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return files[f]; };
  const r = dryRun({ config: '/c.json', product: P, bot: BOT, read });
  assert.deepEqual(seen.sort(), Object.keys(files).sort());
  assert.equal(r.pass, false);
  assert.ok(!r.lines.some((l) => /^\s+FAIL/.test(l)), r.lines.join('\n'));
  assert.equal(r.lines.filter((l) => /^\s+NOT WIRED/.test(l)).length, NOT_WIRED.length);
  assert.match(r.lines.at(-1), /^RESULT: NOT DONE \(1\/6 steps PASS; 5 NOT WIRED\)$/);
  delete files[`/rs/${P}.last-good.json`];
  assert.match(dryRun({ config: '/c.json', product: P, bot: BOT, read }).lines.at(-1), /^RESULT: FAIL /);
});

test('the merge row passes only refusal 9: another refusal, an allow, an ask or no answer each FAIL', () => {
  const r9 = "not this lane's change; MAIN merges it as today: slice/card.md is outside the docs and research lane";
  assert.equal(mergeRow({ decision: 'deny', reason: r9 }).ok, true);
  for (const m of [{ decision: 'deny', reason: 'protected path: slice/card.md' }, { decision: 'deny', reason: r9 + ' (x)' }, { decision: 'allow', reason: r9 },
    { decision: 'ask', reason: r9 }, { decision: 'deny' }, {}, undefined]) assert.equal(mergeRow(m).ok, false, JSON.stringify(m));
});

test('dryRun says why a list or copy could not be read, with its error code', () => {
  const s = state(SLICE);
  const files = { '/c.json': { rulesStateDir: '/rs' }, [`/rs/${P}.last-good.json`]: s.lastGood };
  const read = (f) => { if (!(f in files)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return files[f]; };
  const out = dryRun({ config: '/c.json', product: P, bot: BOT, read }).lines.join('\n');
  assert.match(out, /FAIL  blob .* is on the approval list .* the list can't be read \(ENOENT\)/);
});

test('dryRun stops on a config with no full rulesStateDir', () => {
  for (const c of [{}, { rulesStateDir: 'rel' }, { rulesStateDir: 3 }]) {
    assert.throws(() => dryRun({ config: '/c.json', product: P, bot: BOT, read: () => c }), /no full rulesStateDir/);
  }
});

test('parseArgs needs a full config path, a product and a bot id; nothing else', () => {
  assert.deepEqual(parseArgs(['/c.json', '--product', P, '--bot-id', BOT]), { config: '/c.json', product: P, bot: BOT });
  assert.equal(parseArgs(['/c.json', '--product', P, '--bot-id', BOT, '--result', '/r.txt']).result, '/r.txt');
  for (const a of [[], ['c.json', '--product', P, '--bot-id', BOT], ['/c.json', '--product', P], ['/c.json', '--bot-id', BOT],
    ['/c.json', '--product', P, '--bot-id', BOT, '--write', 'x'], ['/c.json', '--product', P, '--bot-id']]) {
    assert.throws(() => parseArgs(a), undefined, JSON.stringify(a));
  }
});

test('main: exit 1 while not done, writes only the result file asked for (0600), exit 2 on bad arguments', () => {
  const s = state(SLICE);
  const files = { '/c.json': { rulesStateDir: '/rs' }, '/rs/approved-rules.json': s.approved, [`/rs/${P}.last-good.json`]: s.lastGood };
  const read = (f) => files[f];
  const outs = []; const writes = [];
  const code = main(['/c.json', '--product', P, '--bot-id', BOT, '--result', '/r.txt'], { out: (l) => outs.push(l), err: () => {}, write: (...a) => writes.push(a), read });
  assert.equal(code, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], '/r.txt');
  assert.deepEqual(writes[0][2], { mode: 0o600 });
  assert.match(writes[0][1], /RESULT: NOT DONE/);
  assert.match(outs.at(-1), /RESULT: NOT DONE/);
  const errs = [];
  assert.equal(main(['c.json'], { out: () => {}, err: (l) => errs.push(l), write: () => assert.fail('wrote'), read }), 2);
  assert.match(errs[0], /usage/);
  assert.equal(main(['/c.json', '--product', P, '--bot-id', BOT], { out: () => {}, err: () => {}, write: () => assert.fail('wrote'), read: () => ({}) }), 2);
});
