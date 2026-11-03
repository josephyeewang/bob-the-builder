// plan-fingerprint.test.mjs — the one fingerprint the owner's go binds to (0b-5 M7, 0b-2 R2-M12, R2-M5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER1_BAR, canonicalJson, planFingerprint, cleanPath, pathKey, foldKey } from './plan-fingerprint.mjs';
import { pathKey as m3PathKey } from '../modules/M3-lead/task-brief.mjs';
import { normPath, matches, disjoint } from '../modules/M11-dispatcher/gate.mjs';
import { rulesWith, recWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { KEYS } from '../modules/M11-dispatcher/keys.mjs';

const T2 = { product: 'sample-app', card_id: 'C-1', tier: 2, files: ['src/a.mjs'], done_when: 'tests pass' };
const T1 = { ...T2, tier: 1, plan_sha256: 'a'.repeat(64), main_commit: 'b'.repeat(40) };
const fp = (over) => planFingerprint({ ...T2, ...over });

test('the hash is sha256 of the canonical JSON, which is stable and spells out every input', () => {
  const r = planFingerprint(T2);
  assert.equal(r.ok, true);
  assert.equal(r.sha256, createHash('sha256').update(r.canonical, 'utf8').digest('hex'));
  assert.equal(r.canonical, '{"card_id":"C-1","done_bar":["tests pass"],"files":["src/a.mjs"],"main_commit":null,"plan_sha256":null,"product":"sample-app","tier":2}');
  assert.deepEqual(planFingerprint(T1).inputs.done_bar, ['tests pass', TIER1_BAR]);
});

test('file lists: order, duplicates and a leading ./ don\'t matter; case does', () => {
  const base = fp({ files: ['src/a.mjs', 'src/b.mjs'] }).sha256;
  assert.equal(fp({ files: ['src/b.mjs', './src/a.mjs', 'src/a.mjs'] }).sha256, base);
  assert.notEqual(fp({ files: ['src/A.mjs', 'src/b.mjs'] }).sha256, base);
  assert.notEqual(fp({ files: ['src/a.mjs'] }).sha256, base);
});

test('Unicode is compared in NFC, so the same text typed two ways is one plan', () => {
  assert.equal(fp({ done_when: 'café works' }).sha256, fp({ done_when: 'café works' }).sha256);
  assert.equal(fp({ files: ['src/café.mjs'] }).sha256, fp({ files: ['src/café.mjs'] }).sha256);
});

test('each input changes the hash', () => {
  const base = planFingerprint(T1).sha256;
  for (const over of [{ product: 'other' }, { card_id: 'C-2' }, { files: ['src/b.mjs'] }, { done_when: 'other' }, { plan_sha256: 'c'.repeat(64) }, { main_commit: 'd'.repeat(40) }]) {
    assert.notEqual(planFingerprint({ ...T1, ...over }).sha256, base, JSON.stringify(over));
  }
  assert.notEqual(planFingerprint({ ...T1, tier: 2 }).sha256, base, 'tier');
  // Tier 2 ignores plan_sha256 and main_commit.
  assert.equal(planFingerprint({ ...T2, plan_sha256: 'c'.repeat(64), main_commit: 'd'.repeat(40) }).sha256, planFingerprint(T2).sha256);
});

test('refused: missing inputs, a folder pattern, odd paths, and Tier 1 without its hashes', () => {
  const bad = [
    [{ product: '' }, /no product/], [{ card_id: undefined }, /no card id/], [{ tier: 3 }, /tier must be 1 or 2/],
    [{ files: [] }, /no file list/], [{ files: 'src/a.mjs' }, /no file list/], [{ done_when: '  ' }, /no done_when/],
    [{ tier: 1 }, /plan_sha256/], [{ tier: 1, plan_sha256: 'a'.repeat(64) }, /main_commit/],
  ];
  for (const p of ['src/*', 'src/?.mjs', 'src/[ab].mjs', 'src/{a,b}.mjs', '/abs/a.mjs', 'src/', '../a.mjs', 'src/../a.mjs', 'src//a.mjs', 'src\\a.mjs', '', 7,
    // Control characters and the two Unicode line breaks (L84 fix 5): M9 has no check of its own.
    'src/a\nb.mjs', 'src/a\u2028b.mjs', 'src/a\u2029b.mjs', 'src/a\u0000.mjs', 'src/a\u007f.mjs', 'src/\u009fx.mjs']) {
    bad.push([{ files: [p] }, /is not one plain path/]);
  }
  for (const [over, pattern] of bad) {
    const r = fp(over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.reason, pattern, JSON.stringify(over));
  }
  assert.equal(planFingerprint(undefined).ok, false);
  assert.equal(fp({ files: ['src/a-b_c.mjs'] }).ok, true);
});

test('canonicalJson sorts keys at every level and refuses what JSON can\'t say', () => {
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
  assert.throws(() => canonicalJson(NaN), /finite/);
  assert.throws(() => canonicalJson(undefined), /cannot fingerprint/);
  assert.throws(() => canonicalJson(() => 1), /cannot fingerprint/);
});

// Every code point in each named range, one by one, at the start, the middle and the end of a path (L95 Minor 4).
const FORMAT_RANGES = [
  ['zero-width spaces, joiners and marks', 0x200b, 0x200f],
  ['direction embeddings and overrides', 0x202a, 0x202e],
  ['direction isolates', 0x2066, 0x2069],
  ['byte-order mark', 0xfeff, 0xfeff],
];
for (const [name, lo, hi] of FORMAT_RANGES) {
  test(`L95 Minor 4: a path holding a Unicode format character is refused: ${name}`, () => {
    for (let c = lo; c <= hi; c++) {
      const ch = String.fromCodePoint(c);
      for (const p of [`${ch}src/a.mjs`, `src/a${ch}b.mjs`, `src/a.mjs${ch}`]) {
        assert.equal(cleanPath(p), null, `U+${c.toString(16).toUpperCase()} in ${JSON.stringify(p)}`);
        assert.equal(pathKey(p), null);
        assert.match(fp({ files: [p] }).reason ?? '', /is not one plain path/);
      }
    }
  });
}

test('L95 Minor 4: the rest of \\p{Cf} is refused too', () => {
  for (const c of [0x00ad, 0x061c, 0x180e, 0x2060, 0xfff9, 0xe0001]) assert.equal(cleanPath(`a${String.fromCodePoint(c)}b.mjs`), null, c.toString(16));
  // The reported case: an override makes "a" + U+202E + "b.mjs" read as a different name.
  assert.equal(cleanPath('a\u202eb.mjs'), null);
});

// L105 M-1 (audit-pr84 r1): a plan path is plain printable ASCII, the rule M10's pathProblem applies to a change's files.
// The audit's missed plants each become a case here: tag characters, the Arabic number signs, and a path with no NFC step.
test('L105: a plan path is plain printable ASCII only, like M10 pathProblem; everything else is refused', () => {
  for (const p of ['src/a-b_c.mjs', 'docs/Read Me.md', 'src/x~y@1,2=3+4.js', "src/it's.js"]) assert.equal(cleanPath(p), p, p);
  for (const p of ['src/café.mjs', 'docs/日本.md', 'src/straße.js', 'src/a\u00a0b.js', 'src/a\u3000b.js', 'src/a\uff0fb.js',
    'src/e\u0301.js', 'src/a\ufe0fb.js', 'src/a\u3164b.js', 'src/\u{1d5ba}.js']) {
    assert.equal(cleanPath(p), null, JSON.stringify(p));
    assert.match(fp({ files: [p] }).reason ?? '', /is not one plain path/, JSON.stringify(p));
  }
  // Every tag character (U+E0020-E007F) and every Arabic number sign (U+0600-0605), at the start, middle and end.
  for (const [lo, hi] of [[0xe0020, 0xe007f], [0x0600, 0x0605]]) {
    for (let c = lo; c <= hi; c++) {
      const ch = String.fromCodePoint(c);
      for (const p of [`${ch}src/a.mjs`, `src/a${ch}b.mjs`, `src/a.mjs${ch}`]) assert.equal(cleanPath(p), null, `U+${c.toString(16).toUpperCase()}`);
    }
  }
  // The whole printable ASCII range passes except the folder-pattern and backslash characters.
  for (let c = 0x20; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    assert.equal(cleanPath(`src/a${ch}b.js`) !== null, !'*?[]{}\\'.includes(ch), JSON.stringify(ch));
  }
});

test('L105 M-2: a string that is not well formed (a lone surrogate) is refused, never written as U+FFFD', () => {
  for (const p of ['src/a\ud800.js', 'src/\udc00b.js', 'src/a\ud83d']) {
    assert.equal(cleanPath(p), null, JSON.stringify(p));
    assert.equal(pathKey(p), null, JSON.stringify(p));
    assert.equal(foldKey(p), null, JSON.stringify(p));
    assert.equal(normPath(p), null, JSON.stringify(p));
    assert.match(fp({ files: [p] }).reason ?? '', /is not one plain path/);
  }
});

test('L105: the fingerprint is the same for a path typed in NFD or NFC (cleanPath puts it in NFC first)', () => {
  // A plan path is ASCII, so NFD vs NFC reaches only pathKey; still, the NFC step is what makes two spellings one key.
  assert.equal(pathKey('src/cafe\u0301.js'), pathKey('src/caf\u00e9.js'));
  assert.equal(pathKey('src/cafe\u0301.js'), 'src/caf\u00e9.js');
  assert.equal(canonicalJson('cafe\u0301'), canonicalJson('caf\u00e9'));
});

test('L93 m-1: pathKey is the cleaned path fully case-folded, in NFC, so one file has one key', () => {
  for (const [a, b] of [['straße.js', 'STRASSE.js'], ['ς.js', 'σ.js'], ['ς.js', 'Σ.js'], ['src/A.js', './src/a.js'],
    ['ﬁle.js', 'FILE.js'], ['src/café.js', 'SRC/CAFÉ.js'], ['src/café.js', 'src/cafe\u0301.js'], ['K.js', '\u212a.js'],
    // L105 M-1: the capital sharp S. Upper-then-lower alone gives ẞ → ß but ß → ss, so ẞ.js missed both.
    ['ẞ.js', 'ss.js'], ['ẞ.js', 'ß.js'], ['ẞ.js', 'SS.js']]) {
    assert.ok(pathKey(a) !== null, a);
    assert.equal(pathKey(a), pathKey(b), `${a} / ${b}`);
  }
  // NFC after the fold: the key is always in NFC.
  for (const p of ['src/ǅ.js', 'src/İ.js', 'src/ΐ.js']) assert.equal(pathKey(p), pathKey(p).normalize('NFC'), p);
  assert.notEqual(pathKey('src/a.js'), pathKey('src/b.js'));
  for (const bad of ['', '/abs', 'src/*', 'a\u200bb.js', 7]) assert.equal(pathKey(bad), null, String(bad));
  // The fingerprint itself keeps case: pathKey is only for "is it the same file".
  assert.notEqual(fp({ files: ['src/A.js'] }).sha256, fp({ files: ['src/a.js'] }).sha256);
});

test('L105: M3 compares paths by the shared pathKey, and M11\'s start gate folds by the shared foldKey', () => {
  assert.equal(m3PathKey, pathKey, 'M3 task-brief pathKey is not the shared one');
  for (const [a, b] of [['ẞ.js', 'ss.js'], ['straße.js', 'STRASSE.js'], ['ς.js', 'σ.js'], ['src/café.js', 'src/cafe\u0301.js'], ['src/A.js', 'src/a.js']]) {
    assert.equal(normPath(a), normPath(b), `M11 normPath ${a} / ${b}`);
    assert.equal(normPath(a), pathKey(a), `M11 normPath and pathKey disagree on ${a}`);
  }
  // A daily pattern is folded the same way; one that can't be folded counts as touching every file, never none.
  assert.equal(matches('SRC/STRASSE/*', normPath('src/straße/a.js')), true);
  assert.equal(matches('src/ẞ*', normPath('src/ss.js')), true);
  assert.equal(matches('src/\ud800*', normPath('src/a.js')), true);
});

test('L247: a daily pattern that can\'t be folded holds the overlap, and the refusal names the pattern', () => {
  const rec = recWith([['card', 'W', { state: 'running', files: ['src/a.js'] }]]);
  const others = [{ id: 's1', kind: 'editing', card: 'W' }];
  const ask = (patterns) => disjoint({ rules: rulesWith({ [KEYS.leadDailyCard]: patterns }), card: { id: 'D', kind: 'daily' }, product: 'p1', others, rec });
  const r = ask(['src/\ud800*']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^shares src\/a\.js \(daily pattern "src\/\\ud800\*" can't be folded, so it counts as every file\) with running card W$/);
  assert.match(ask(['src/*']).reason, /^shares src\/a\.js with running card W$/, 'a plain pattern hit reads as before');
  assert.equal(ask(['docs/*']).ok, true);
});

test('lane 2 review of #133: a row id or a path that is not well formed refuses the card, with its own reason', () => {
  const rec = recWith([]);
  const ask = (card) => disjoint({ rules: rulesWith({}), card: { id: 'C', ...card }, product: 'p1', others: [], rec });
  assert.deepEqual(ask({ files: ['src/a.js'], rows: ['R-\ud800'] }), { ok: false, reason: 'the card names a row id that is not well formed' });
  assert.deepEqual(ask({ files: ['src/a\ud800.js'] }), { ok: false, reason: 'the card names a path that is not well formed ("src/a\\ud800.js")' });
  assert.match(ask({ files: ['../a.js'] }).reason, /outside the repo/, 'a path outside the repo reads as before');
  assert.equal(ask({ files: ['src/a.js'], rows: ['R-1'] }).ok, true);
});

// L105 guard: no module outside shared/ builds its own path key. A case change or a Unicode normalization on a value
// whose name says it is a path or file is a second fold; it must call shared/plan-fingerprint.mjs foldKey or pathKey.
// Lines that fold something other than a repo path are listed with the reason, so a new one fails until it is read.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOT_REPO_PATHS = new Map([
  ['setup/layout.mjs', 'a Mac folder from the config, compared against fixed system folders'],
  ['modules/M4-workshop/launcher/review-runner-main.mjs', 'real Mac folders, compared for nesting'],
  ['modules/M4-workshop/launcher/review-settings.mjs', 'a Mac folder, compared for nesting'],
  ['modules/M4-workshop/launcher/launch.mjs', 'skill file names in the Bob folder, refused in any case'],
  ['modules/M4-workshop/launcher/review-walls-proof.mjs', 'a tool name, not a path'],
  ['modules/M12-sensors/shell-guard/runner.mjs', 'a probe for a case-insensitive disk'],
  ['modules/M10-rules/paths.mjs', 'M10 refuses every non-ASCII changed path first (pathProblem), so its fold only meets ASCII'],
  ['modules/M6-merge-gate/checker-entry.mjs', 'the rules file path, ASCII, after M10 pathProblem'],
  ['modules/M10-rules/repair-plain.mjs', 'a word in a repair file\'s text, not a path'],
  ['modules/M6-merge-gate/github-checker.mjs', 'generated from M10 and M6 (build-checker.mjs)'],
]);
// A case change, or a Unicode normalization (not posix.normalize, which only tidies slashes and dots).
const FOLD = /\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase)\(|\.normalize\(\s*['"]NF/;
const PATHY = /path|file|(?<![a-z])dir/i;
function sources(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (statSync(f).isDirectory()) sources(f, out);
    else if (n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !n.endsWith('.test-helper.mjs')) out.push(relative(ROOT, f));
  }
  return out;
}
test('L105 guard: no module outside shared/ builds its own path key', () => {
  const found = [];
  for (const f of sources(ROOT)) {
    if (f.startsWith('shared/') || f.startsWith('test/') || f.includes('/fixtures/') || NOT_REPO_PATHS.has(f)) continue;
    // A fold counts when the line, or the function it sits in (`return n.toLowerCase()` inside normPath), names a path.
    let fn = '';
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      const head = /^\s*(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let)\s+(\w+)\s*=)/.exec(line);
      if (head) fn = head[1] ?? head[2];
      if (FOLD.test(line) && (PATHY.test(line) || PATHY.test(fn))) found.push(`${f}:${i + 1} (in ${fn || 'top level'}): ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], `fold a path with shared/plan-fingerprint.mjs foldKey or pathKey instead:\n${found.join('\n')}`);
  // The guard sees a fold when there is one (a plant through the same test).
  assert.ok(FOLD.test('const k = file.toLowerCase();') && PATHY.test('const k = file.toLowerCase();'));
});
