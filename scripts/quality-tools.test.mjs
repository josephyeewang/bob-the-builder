// Unit tests for Bob's quality checks (templates/quality/), standard-library Node only: node --test scripts/quality-tools.test.mjs
// The browser, Knip and jscpd runs are proven end to end by scripts/quality-tools-e2e.mjs (its own CI job).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { checkConfig, parseTestData, startServer, ConfigError } from '../templates/quality/quality-lib.mjs';
import { smoke } from '../templates/quality/smoke.mjs';
import { decodePng, compareImages } from '../templates/quality/png.mjs';
import { judge } from '../templates/quality/speed-budget.mjs';
import { knipKeys, duplicateCounts, newFindings, checkBaseline } from '../templates/quality/code-scan.mjs';
import { checkLiveFigures } from '../templates/quality/live-figures-check.mjs';
import { main as runMain } from '../templates/quality/run.mjs';

const BOB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = join(BOB, 'templates/quality');
const FIX = join(BOB, 'fixtures/quality-app');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fixtureConfig = () => readJson(join(FIX, '.quality/config.json'));

// ── config ───────────────────────────────────────────────────────────────────
test('the test product\'s config is valid and gets the defaults', () => {
  const c = checkConfig(fixtureConfig());
  assert.equal(c.speed.defaultBudgetMs, 1000);
  assert.deepEqual(c.a11y.failOn, ['serious', 'critical']);
  assert.equal(c.pages[0].visual, true);
});

test('config: anything unknown, empty or unsafe is refused (allowed lists, fail closed)', () => {
  const cases = [
    [(c) => { c.pagez = []; }, /unknown key "pagez"/],
    [(c) => { c.start.secretKey = 'x'; }, /unknown key "secretKey"/],
    [(c) => { c.pages = []; }, /at least one page/],
    [(c) => { delete c.pages; }, /at least one page/],
    [(c) => { c.start.url = 'https://my-product.example.com'; }, /must be on localhost/],
    [(c) => { c.start.url = 'not a url'; }, /not a URL/],
    [(c) => { c.pages[1].name = 'home'; }, /used twice/],
    [(c) => { c.pages[0].path = 'no-slash'; }, /must start with \//],
    [(c) => { c.routes[0].expectStatus = 500; }, /server error is never expected/],
    [(c) => { c.visual = { maxDiffRatio: 2 }; }, /from 0 to 1/],
    [(c) => { c.a11y = { failOn: ['loud'] }; }, /impacts from/],
    [(c) => { c.speed = { runs: 0 }; }, /1 to 9/],
    [(c) => { c.start.build = ''; }, /start.build must be a non-empty string/],
  ];
  for (const [mutate, want] of cases) {
    const c = fixtureConfig();
    mutate(c);
    assert.throws(() => checkConfig(c), (e) => e instanceof ConfigError && want.test(e.message), String(want));
  }
});

test('test-data file: KEY=VALUE lines, comments skipped, anything else refused', () => {
  assert.deepEqual(parseTestData('# c\n\nA=1\nB="two words"\n'), { A: '1', B: 'two words' });
  assert.throws(() => parseTestData('export A=1'), /line 1 is not KEY=VALUE/);
});

// ── run.mjs entry ────────────────────────────────────────────────────────────
test('run.mjs: no config, an unknown check or a mixed --update-references fails, never passes', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(await runMain(['smoke'], { log, configPath: '/nonexistent/config.json' }), 1);
  assert.match(lines.join('\n'), /FAIL config: cannot read/);
  assert.equal(await runMain([], { log }), 2);
  assert.equal(await runMain(['smok'], { log, configPath: join(FIX, '.quality/config.json') }), 2);
  assert.equal(await runMain(['smoke', 'visual', '--update-references'], { log, configPath: join(FIX, '.quality/config.json') }), 2);
  assert.equal(await runMain(['smoke', '--fast'], { log }), 2);
});

// ── smoke + server start, against a real local server ────────────────────────
function serve(handler) {
  return new Promise((res) => {
    const s = createServer(handler).listen(0, '127.0.0.1', () => res(s));
  });
}
function cfgFor(port, extra = {}) {
  return checkConfig({
    start: { build: 'true', command: 'true', url: `http://127.0.0.1:${port}` },
    pages: [{ name: 'home', path: '/' }, { name: 'form', path: '/form' }],
    routes: [{ path: '/api/ok' }, { path: '/api/private', expectStatus: 401 }],
    ...extra,
  });
}

test('smoke: a clean product passes; a server error, a missing page, a wrong status and no answer each fail', async () => {
  let plant = null;
  const s = await serve((req, res) => {
    if (req.url === plant?.path) { res.writeHead(plant.status); return res.end('x'); }
    if (req.url === '/api/private') { res.writeHead(401); return res.end(); }
    if (['/', '/form', '/api/ok'].includes(req.url)) { res.writeHead(200); return res.end('ok'); }
    res.writeHead(404); res.end();
  });
  const config = cfgFor(s.address().port);
  try {
    assert.deepEqual(await smoke({ config }), []);
    plant = { path: '/api/ok', status: 500 };
    assert.match((await smoke({ config })).join(), /route \/api\/ok \(\/api\/ok\) answered 500/);
    plant = { path: '/form', status: 404 };
    assert.match((await smoke({ config })).join(), /page form \(\/form\) answered 404/);
    plant = { path: '/api/private', status: 200 };
    assert.match((await smoke({ config })).join(), /answered 200, expected 401/);
  } finally {
    s.close();
  }
  assert.match((await smoke({ config })).join(), /did not answer/);
});

test('startServer: refuses when something already answers at the address (it would test the wrong product)', async () => {
  const s = await serve((req, res) => { res.writeHead(200); res.end(); });
  try {
    await assert.rejects(startServer(cfgFor(s.address().port), { env: process.env }), /already answering/);
  } finally {
    s.close();
  }
});

test('startServer: a start command that exits, or never answers, is a failure', async () => {
  const exits = checkConfig({ start: { build: 'true', command: 'exit 3', url: 'http://127.0.0.1:4391', readyTimeoutSeconds: 10 }, pages: [{ name: 'a', path: '/' }] });
  await assert.rejects(startServer(exits, { env: process.env }), /exited \(3\)/);
  const silent = checkConfig({ start: { build: 'true', command: 'sleep 30', url: 'http://127.0.0.1:4392', readyTimeoutSeconds: 1 }, pages: [{ name: 'a', path: '/' }] });
  const t0 = Date.now();
  await assert.rejects(startServer(silent, { env: process.env }), /nothing answered/);
  assert.ok(Date.now() - t0 < 10000, 'stop() ended the silent process instead of waiting it out');
});

test('startServer: starts the product with the test data and stop() leaves nothing answering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bob-q-'));
  try {
    writeFileSync(join(dir, 'td'), 'GREETING=hello from test data\n');
    writeFileSync(join(dir, 's.mjs'), "import { createServer } from 'node:http';\ncreateServer((q, r) => r.end(process.env.GREETING)).listen(4393, '127.0.0.1');\n");
    const config = checkConfig({ start: { build: 'true', command: `node ${join(dir, 's.mjs')}`, url: 'http://127.0.0.1:4393', testDataFile: join(dir, 'td'), readyTimeoutSeconds: 20 }, pages: [{ name: 'a', path: '/' }] });
    const server = await startServer(config);
    assert.equal(await (await fetch('http://127.0.0.1:4393/')).text(), 'hello from test data');
    await server.stop();
    await assert.rejects(fetch('http://127.0.0.1:4393/', { signal: AbortSignal.timeout(2000) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── PNG decoding and comparison ──────────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
// Encode RGBA pixels; each row uses filter (y % 5), so all five PNG filters are exercised.
function encodePng(width, height, rgba, { colorType = 6, depth = 8 } = {}) {
  const ch = colorType === 6 ? 4 : 3, stride = width * ch;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) line[x * ch + c] = rgba[(y * width + x) * 4 + c];
    const f = y % 5, out = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[i] = (line[i] - pred) & 0xff;
    }
    rows.push(Buffer.from([f]), out);
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function pixels(w, h, seed = 1) {
  const d = Buffer.alloc(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * 37 + seed * 11) & 0xff;
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return d;
}

test('PNG: decodes RGBA and RGB through all five row filters, pixel for pixel', () => {
  const px = pixels(13, 11);
  assert.deepEqual(decodePng(encodePng(13, 11, px)).data, px);
  assert.deepEqual(decodePng(encodePng(13, 11, px, { colorType: 2 })).data, px);
});

test('PNG: anything it cannot read is refused, never compared as a match', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/);
  assert.throws(() => decodePng(encodePng(4, 4, pixels(4, 4), { depth: 16 })), /unsupported PNG/);
  const good = encodePng(8, 8, pixels(8, 8));
  assert.throws(() => decodePng(good.subarray(0, good.length - 30)));
});

test('compare: identical passes, one changed pixel counts, small shifts sit under the threshold, size changes never match', () => {
  const a = { width: 10, height: 10, data: pixels(10, 10) };
  assert.equal(compareImages(a, a).diffPixels, 0);
  const b = { ...a, data: Buffer.from(a.data) };
  b.data[0] = (b.data[0] + 128) & 0xff;
  assert.equal(compareImages(a, b).diffPixels, 1);
  assert.equal(compareImages(a, b).diffRatio, 0.01);
  const c = { ...a, data: Buffer.from(a.data) };
  c.data[4] = Math.min(255, c.data[4] + 5); // under 10% of 255
  assert.equal(compareImages(a, c, { pixelThreshold: 0.1 }).diffPixels, 0);
  assert.equal(compareImages(a, { width: 10, height: 11, data: pixels(10, 11) }).sameSize, false);
});

// ── speed ────────────────────────────────────────────────────────────────────
test('speed: the middle run counts; over budget fails; a missing or impossible reading fails (fail closed)', () => {
  assert.equal(judge('home', 1000, [120, 3000, 140]), null); // one slow run alone does not fail
  assert.match(judge('home', 1000, [1500, 1600, 900]), /loads in 1500 ms, over its 1000 ms budget/);
  assert.match(judge('home', 1000, []), /no usable load time/);
  assert.match(judge('home', 1000, [100, null, 100]), /no usable load time/);
  assert.match(judge('home', 1000, [0, 0, 0]), /no usable load time/);
});

// ── code scan ────────────────────────────────────────────────────────────────
const KNIP = { issues: [
  { file: 'src/a.mjs', exports: [{ name: 'unused', line: 3 }], files: [], duplicates: [[{ name: 'x' }, { name: 'y' }]] },
  { file: 'src/old.mjs', files: [{ name: 'src/old.mjs' }], exports: [] },
] };
const DUPS = { duplicates: [
  { firstFile: { name: 'src/b.mjs' }, secondFile: { name: 'src/a.mjs' } },
  { firstFile: { name: 'src/a.mjs' }, secondFile: { name: 'src/b.mjs' } },
] };

test('code scan: findings get keys that survive moved lines; pairs are counted in either order', () => {
  assert.deepEqual(knipKeys(KNIP), ['duplicates:src/a.mjs:x+y', 'exports:src/a.mjs:unused', 'files:src/old.mjs:src/old.mjs']);
  assert.deepEqual(duplicateCounts(DUPS), { 'src/a.mjs | src/b.mjs': 2 });
});

test('code scan: only findings beyond the baseline fail', () => {
  const found = { deadCode: knipKeys(KNIP), duplicates: duplicateCounts(DUPS) };
  assert.deepEqual(newFindings(found, found), []);
  const base = { deadCode: ['files:src/old.mjs:src/old.mjs'], duplicates: { 'src/a.mjs | src/b.mjs': 1 } };
  const fresh = newFindings(found, base);
  assert.equal(fresh.length, 3);
  assert.match(fresh.join('\n'), /dead code: exports:src\/a.mjs:unused/);
  assert.match(fresh.join('\n'), /duplicated code: src\/a.mjs \| src\/b.mjs \(2 clones, baseline 1\)/);
  assert.deepEqual(newFindings({ deadCode: [], duplicates: {} }, base), [], 'fixing an old finding never fails');
});

test('code scan: unreadable tool output or baseline throws (fail closed)', () => {
  assert.throws(() => knipKeys({}), /no "issues"/);
  assert.throws(() => knipKeys({ issues: [{ file: 'a', exports: [{}] }] }), /has no name/);
  assert.throws(() => duplicateCounts({ duplicates: [{ firstFile: {} }] }), /no file names/);
  assert.throws(() => checkBaseline({ deadCode: [] }), /must hold/);
  assert.throws(() => checkBaseline({ deadCode: [], duplicates: { p: 0 } }), /must hold/);
});

// ── live figures ─────────────────────────────────────────────────────────────
test('live figures: the test product\'s filled copy validates; the blank template does not', () => {
  assert.deepEqual(checkLiveFigures(readJson(join(FIX, '.quality/live-figures.json'))), []);
  const blank = checkLiveFigures(readJson(join(T, 'live-figures.json')));
  for (const f of ['product', 'figure', 'liveAddress', 'readAt', 'secondWayQuery', 'tolerance']) assert.ok(blank.some((p) => p.includes(`${f} is empty`)), f);
});

test('live figures: an empty, unknown or malformed field fails', () => {
  const filled = () => readJson(join(FIX, '.quality/live-figures.json'));
  const cases = [
    [(d) => { d.figures[0].tolerance = ' '; }, /tolerance is empty/],
    [(d) => { delete d.figures[0].readAt; }, /readAt is empty/],
    [(d) => { d.figures[0].owner = 'x'; }, /unknown field "owner"/],
    [(d) => { d.figurez = []; }, /unknown key "figurez"/],
    [(d) => { d.figures[0].liveAddress = 'http://quality-app.example.com/x'; }, /must be an https/],
    [(d) => { d.figures[0].tolerance = 'about 1'; }, /must be a number/],
    [(d) => { d.figures = []; }, /at least one figure/],
    [(d) => { d.figures.push({ ...d.figures[0] }); }, /listed twice/],
  ];
  for (const [mutate, want] of cases) {
    const d = filled();
    mutate(d);
    assert.match(checkLiveFigures(d).join('\n'), want);
  }
});

// ── the workflow template and what a product copies ──────────────────────────
test('the check-job template reads no secret, can only read the repository, and runs on pull requests', () => {
  const yml = readFileSync(join(T, 'quality-check.yml'), 'utf8');
  const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /secrets\./);
  assert.doesNotMatch(code, /pull_request_target|workflow_run/);
  assert.match(code, /^permissions:\n {2}contents: read\n\n/m);
  assert.match(code, /persist-credentials: false/);
  assert.match(code, /^ {2}pull_request:$/m);
});

test('one pinned version per tool: Bob\'s own CI installs exactly what the template installs', () => {
  const pins = (text) => [...text.matchAll(/\b(playwright|axe-core|knip|jscpd)@(\d+\.\d+\.\d+)/g)].map((m) => m[0]).sort();
  const template = [...new Set(pins(readFileSync(join(T, 'quality-check.yml'), 'utf8')))];
  const ci = [...new Set(pins(readFileSync(join(BOB, '.github/workflows/scripts-ci.yml'), 'utf8')))];
  assert.equal(template.length, 4);
  assert.deepEqual(ci, template);
});

test('every check file in templates/quality is in the adoption list the end-to-end test copies', async () => {
  const src = readFileSync(join(BOB, 'scripts/quality-tools-e2e.mjs'), 'utf8');
  const listed = [...src.matchAll(/'([a-z0-9-]+\.(?:mjs|yml))'/g)].map((m) => m[1]);
  for (const f of readdirSync(T).filter((f) => f.endsWith('.mjs') || f.endsWith('.yml'))) assert.ok(listed.includes(f), `${f} is not adopted`);
  const readme = readFileSync(join(T, 'README.md'), 'utf8');
  for (const f of readdirSync(T).filter((f) => f.endsWith('.mjs'))) assert.ok(readme.includes(f), `README.md does not mention ${f}`);
});
