#!/usr/bin/env node
// gate-capture.mjs — capture a candidate page for the screenshot gate (references/screenshot-gate.md).
//
//   node gate-capture.mjs PAGE --out DIR [--tools DIR] [--fonts "Face A,Face B"] [--lcp-ms 2500]
//                         [--max-kb N] [--stops "CSS selector"] [--settle-ms 600]
//
// PAGE is an http(s) URL or a local .html file (served from its own folder on 127.0.0.1, so the
// throttled load and the byte count are real). Writes into DIR:
//   w1440-s00.png …  every scroll stop at 1440 / 1024 / 768 / 390 px wide
//   rm-w1440-s00.png …  the same stops with reduced motion, at 1440 and 390
//   gate-report.json  drawn fonts, phone paint time and weight, failures, and the items left for eyes
// Scroll stops are the tops of the elements matching --stops, else one per screen height.
// Fails (exit 1) on what can be measured: a drawn font outside --fonts, main content painted later
// than --lcp-ms on the throttled phone profile (or no paint time at all), weight over --max-kb.
// Every other gate item needs a person or a fresh agent to look at the images. Exit 2: usage or tool error.
//
// Needs Playwright with Chromium (fonts and throttling use Chromium's DevTools protocol). It is not
// installed by this script: pass --tools DIR where DIR/node_modules holds playwright, or run from a
// folder that has it.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, join, extname, sep } from 'node:path';

export const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844, isMobile: true, hasTouch: true },
];
const REDUCED_WIDTHS = [1440, 390];
// A slow mobile profile: ~1.6 Mbps down, 750 Kbps up, 150 ms round trip, processor slowed 4x.
const PHONE_NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const PHONE_CPU_SLOWDOWN = 4;
const MAX_STOPS = 40;

export function parseArgs(argv) {
  const opts = { lcpMs: 2500, settleMs: 600, fonts: null, maxKb: null, stops: null, tools: null, out: null, page: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--out') opts.out = resolve(next());
    else if (a === '--tools') opts.tools = resolve(next());
    else if (a === '--fonts') opts.fonts = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--lcp-ms') opts.lcpMs = Number(next());
    else if (a === '--max-kb') opts.maxKb = Number(next());
    else if (a === '--stops') opts.stops = next();
    else if (a === '--settle-ms') opts.settleMs = Number(next());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.page === null) opts.page = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.page) throw new Error('give the page to capture (a URL or an .html file)');
  if (!opts.out) throw new Error('--out DIR is required');
  for (const [k, v] of [['--lcp-ms', opts.lcpMs], ['--settle-ms', opts.settleMs], ['--max-kb', opts.maxKb]]) {
    if (v !== null && !(Number.isFinite(v) && v >= 0)) throw new Error(`${k} must be a number of 0 or more`);
  }
  return opts;
}

const norm = (f) => f.toLowerCase().replace(/["']/g, '').trim();

/** @public The self-test calls it directly. Returns the list of measured failures (empty = pass). */
export function judge({ drawnFonts, lockedFonts, lcpMs, lcpBudgetMs, bytes, maxKb }) {
  const failures = [];
  if (lockedFonts && lockedFonts.length) {
    const allowed = new Set(lockedFonts.map(norm));
    const stray = Object.keys(drawnFonts).filter((f) => !allowed.has(norm(f)));
    if (stray.length) failures.push(`fonts: drawn ${stray.join(', ')} — not in the locked fonts (${lockedFonts.join(', ')})`);
  }
  if (!Number.isFinite(lcpMs) || lcpMs <= 0) failures.push('paint: no main-content paint time was measured on the phone profile');
  else if (lcpMs > lcpBudgetMs) failures.push(`paint: main content painted at ${Math.round(lcpMs)} ms on the throttled phone profile, over the ${lcpBudgetMs} ms budget`);
  if (maxKb !== null && maxKb !== undefined) {
    if (!Number.isFinite(bytes) || bytes <= 0) failures.push('weight: no transferred bytes were measured');
    else if (bytes / 1024 > maxKb) failures.push(`weight: ${(bytes / 1024).toFixed(1)} KB transferred, over the ${maxKb} KB budget`);
  }
  return failures;
}

function loadPlaywright(tools) {
  const base = tools ? join(tools, 'package.json') : join(process.cwd(), 'package.json');
  try {
    return createRequire(base)('playwright');
  } catch {
    throw new Error(`playwright not found from ${dirname(base)} — install it there (npm install playwright, then npx playwright install chromium) or pass --tools DIR`);
  }
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4', '.webm': 'video/webm' };

// Serve one folder read-only on 127.0.0.1; paths outside it are refused.
function serveFolder(root) {
  const server = createServer((req, res) => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!(path === root || path.startsWith(root + sep)) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' });
    res.end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function stopPositions(tab, selector) {
  return tab.evaluate(({ selector, max }) => {
    const vh = window.innerHeight;
    const end = Math.max(0, document.documentElement.scrollHeight - vh);
    let ys;
    if (selector) ys = [0, ...[...document.querySelectorAll(selector)].map((el) => Math.round(el.getBoundingClientRect().top + window.scrollY))];
    else { ys = []; for (let y = 0; y < end + 1; y += vh) ys.push(y); if (ys[ys.length - 1] !== end) ys.push(end); }
    return [...new Set(ys.map((y) => Math.min(Math.max(0, y), end)))].sort((a, b) => a - b).slice(0, max);
  }, { selector, max: MAX_STOPS });
}

async function captureStops(context, url, opts, prefix, files) {
  const tab = await context.newPage();
  await tab.goto(url, { waitUntil: 'load', timeout: 60000 });
  await tab.evaluate(() => document.fonts.ready);
  const ys = await stopPositions(tab, opts.stops);
  for (const [i, y] of ys.entries()) {
    await tab.evaluate((y) => window.scrollTo(0, y), y);
    await tab.waitForTimeout(opts.settleMs);
    const name = `${prefix}-s${String(i).padStart(2, '0')}.png`;
    await tab.screenshot({ path: join(opts.out, name) });
    files.push(name);
  }
  return tab;
}

// The fonts the rendering engine actually drew for text on the page, with glyph counts.
async function drawnFonts(context, tab) {
  const cdp = await context.newCDPSession(tab);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'h1,h2,h3,h4,h5,h6,p,li,a,button,label,blockquote,figcaption,td,th,span,small,strong,em' });
  const fonts = {};
  for (const nodeId of nodeIds.slice(0, 400)) {
    const { fonts: used } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    for (const f of used) if (f.glyphCount > 0) fonts[f.familyName] = (fonts[f.familyName] ?? 0) + f.glyphCount;
  }
  return fonts;
}

async function phoneLoad(browser, url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    await context.addInitScript(() => {
      window.__gateLcp = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__gateLcp = e.startTime; })
        .observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const tab = await context.newPage();
    const cdp = await context.newCDPSession(tab);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', PHONE_NETWORK);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PHONE_CPU_SLOWDOWN });
    let bytes = 0;
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength || 0; });
    await tab.goto(url, { waitUntil: 'load', timeout: 120000 });
    await tab.waitForTimeout(1500);
    const lcpMs = await tab.evaluate(() => window.__gateLcp);
    return { lcpMs, bytes };
  } finally {
    await context.close();
  }
}

export async function run(opts, log = console.log) {
  const { chromium } = loadPlaywright(opts.tools);
  mkdirSync(opts.out, { recursive: true });
  let server = null;
  let url = opts.page;
  if (!/^https?:\/\//i.test(url)) {
    const file = resolve(url);
    if (!existsSync(file)) throw new Error(`no such page: ${file}`);
    server = await serveFolder(realpathSync(dirname(file)));
    url = `http://127.0.0.1:${server.address().port}/${encodeURIComponent(basename(file))}`;
  }
  const browser = await chromium.launch();
  const files = [];
  try {
    let fonts = {};
    for (const vp of WIDTHS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
      try {
        const tab = await captureStops(context, url, opts, `w${vp.width}`, files);
        if (vp.width === 1440) fonts = await drawnFonts(context, tab);
      } finally {
        await context.close();
      }
    }
    for (const w of REDUCED_WIDTHS) {
      const vp = WIDTHS.find((v) => v.width === w);
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, reducedMotion: 'reduce' });
      try { await captureStops(context, url, opts, `rm-w${w}`, files); } finally { await context.close(); }
    }
    const phone = await phoneLoad(browser, url);
    const failures = judge({ drawnFonts: fonts, lockedFonts: opts.fonts, lcpMs: phone.lcpMs, lcpBudgetMs: opts.lcpMs, bytes: phone.bytes, maxKb: opts.maxKb });
    const report = {
      page: opts.page,
      captured: files,
      fonts: { drawn: fonts, locked: opts.fonts ?? 'not given — font check skipped' },
      phone: { lcpMs: Math.round(phone.lcpMs), lcpBudgetMs: opts.lcpMs, bytes: phone.bytes, maxKb: opts.maxKb ?? 'not given — weight check skipped' },
      failures,
      needsEyes: ['banned patterns', 'signature in the first two screens', 'neighbouring sections share a skeleton', 'more than one plain fade-up',
        'empty / stuck scroll or unreadable text over motion', 'phone is a shrunk desktop', 'reduced motion loses content', 'blind "which template made this?" test'],
    };
    writeFileSync(join(opts.out, 'gate-report.json'), JSON.stringify(report, null, 2) + '\n');
    log(`captured ${files.length} images into ${opts.out}`);
    log(`drawn fonts: ${Object.keys(fonts).join(', ') || '(none found)'} · phone paint ${report.phone.lcpMs} ms · ${(phone.bytes / 1024).toFixed(1)} KB`);
    for (const f of failures) log(`FAIL ${f}`);
    log(failures.length ? `${failures.length} measured failure(s)` : 'measured checks pass; the other gate items still need eyes on the images');
    return report;
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

if (process.argv[1] && realpathSync(new URL(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`gate-capture: ${e.message}`);
    process.exit(2);
  }
  run(opts).then((r) => process.exit(r.failures.length ? 1 : 0), (e) => { console.error(`gate-capture: ${e.message}`); process.exit(2); });
}
