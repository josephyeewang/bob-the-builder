// quality-lib.mjs — the one home for what Bob's quality checks share: reading the product's declared config, starting
// the product with test data, and fail-closed helpers. Copied into a product as scripts/quality/ (templates/quality/README.md).
//
// Fail closed (every check): a missing, unreadable or unknown config, a page list that is empty, a server that never
// answers, a tool that is not installed — each is a FAIL with the reason, never "all clear".
// Standard-library Node only (>= 22).

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const CONFIG_PATH = '.quality/config.json';
const DEFAULT_SPEED_BUDGET_MS = 1000;

// Allowed lists: a key not named here is refused, so a typo can't silently switch a check off.
const TOP_KEYS = ['_doc', 'start', 'pages', 'routes', 'visual', 'speed', 'a11y'];
const START_KEYS = ['build', 'command', 'url', 'readyPath', 'readyTimeoutSeconds', 'testDataFile'];
const PAGE_KEYS = ['name', 'path', 'speedBudgetMs', 'visual'];
const ROUTE_KEYS = ['path', 'expectStatus'];
const VISUAL_KEYS = ['referenceDir', 'outDir', 'width', 'height', 'maxDiffRatio', 'pixelThreshold'];
const SPEED_KEYS = ['defaultBudgetMs', 'runs'];
const A11Y_KEYS = ['failOn'];
const A11Y_IMPACTS = ['minor', 'moderate', 'serious', 'critical'];

export class ConfigError extends Error {}

function onlyKeys(obj, allowed, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ConfigError(`${where} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ConfigError(`${where} has an unknown key "${k}" (allowed: ${allowed.join(', ')})`);
  }
}
const isPath = (p) => typeof p === 'string' && p.startsWith('/') && !/\s/.test(p);
const posInt = (n) => Number.isInteger(n) && n > 0;
const ratio = (n) => typeof n === 'number' && n >= 0 && n <= 1;

/** @public Bob's self-tests call it directly. */
// Parse and check a config object. Returns it with defaults filled in; throws ConfigError on anything unknown or wrong.
export function checkConfig(raw) {
  onlyKeys(raw, TOP_KEYS, 'config');
  const s = raw.start;
  onlyKeys(s, START_KEYS, 'start');
  for (const k of ['build', 'command', 'url']) {
    if (typeof s[k] !== 'string' || !s[k].trim()) throw new ConfigError(`start.${k} must be a non-empty string`);
  }
  let url;
  try { url = new URL(s.url); } catch { throw new ConfigError(`start.url is not a URL: ${s.url}`); }
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new ConfigError(`start.url must be on localhost (the check job tests the product it started, never a live site): ${s.url}`);
  }
  if (s.readyPath !== undefined && !isPath(s.readyPath)) throw new ConfigError('start.readyPath must start with /');
  if (s.readyTimeoutSeconds !== undefined && !posInt(s.readyTimeoutSeconds)) throw new ConfigError('start.readyTimeoutSeconds must be a whole number above 0');
  if (s.testDataFile !== undefined && (typeof s.testDataFile !== 'string' || !s.testDataFile)) throw new ConfigError('start.testDataFile must be a file path');

  if (!Array.isArray(raw.pages) || raw.pages.length === 0) throw new ConfigError('pages must list at least one page (nothing declared means nothing checked)');
  const names = new Set();
  for (const [i, p] of raw.pages.entries()) {
    onlyKeys(p, PAGE_KEYS, `pages[${i}]`);
    if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.name)) throw new ConfigError(`pages[${i}].name must be lower-case letters, digits and dashes`);
    if (names.has(p.name)) throw new ConfigError(`pages[${i}].name "${p.name}" is used twice`);
    names.add(p.name);
    if (!isPath(p.path)) throw new ConfigError(`pages[${i}].path must start with /`);
    if (p.speedBudgetMs !== undefined && !posInt(p.speedBudgetMs)) throw new ConfigError(`pages[${i}].speedBudgetMs must be a whole number of milliseconds`);
    if (p.visual !== undefined && typeof p.visual !== 'boolean') throw new ConfigError(`pages[${i}].visual must be true or false`);
  }
  const routes = raw.routes ?? [];
  if (!Array.isArray(routes)) throw new ConfigError('routes must be a list');
  for (const [i, r] of routes.entries()) {
    onlyKeys(r, ROUTE_KEYS, `routes[${i}]`);
    if (!isPath(r.path)) throw new ConfigError(`routes[${i}].path must start with /`);
    if (r.expectStatus !== undefined && !(Number.isInteger(r.expectStatus) && r.expectStatus >= 200 && r.expectStatus < 500)) {
      throw new ConfigError(`routes[${i}].expectStatus must be a status from 200 to 499 (a server error is never expected)`);
    }
  }
  const visual = raw.visual ?? {};
  onlyKeys(visual, VISUAL_KEYS, 'visual');
  for (const k of ['width', 'height']) if (visual[k] !== undefined && !posInt(visual[k])) throw new ConfigError(`visual.${k} must be a whole number of pixels`);
  for (const k of ['maxDiffRatio', 'pixelThreshold']) if (visual[k] !== undefined && !ratio(visual[k])) throw new ConfigError(`visual.${k} must be a number from 0 to 1`);
  const speed = raw.speed ?? {};
  onlyKeys(speed, SPEED_KEYS, 'speed');
  if (speed.defaultBudgetMs !== undefined && !posInt(speed.defaultBudgetMs)) throw new ConfigError('speed.defaultBudgetMs must be a whole number of milliseconds');
  if (speed.runs !== undefined && !(posInt(speed.runs) && speed.runs <= 9)) throw new ConfigError('speed.runs must be 1 to 9');
  const a11y = raw.a11y ?? {};
  onlyKeys(a11y, A11Y_KEYS, 'a11y');
  if (a11y.failOn !== undefined && !(Array.isArray(a11y.failOn) && a11y.failOn.length && a11y.failOn.every((x) => A11Y_IMPACTS.includes(x)))) {
    throw new ConfigError(`a11y.failOn must list impacts from: ${A11Y_IMPACTS.join(', ')}`);
  }
  return {
    start: { readyPath: '/', readyTimeoutSeconds: 120, ...s },
    pages: raw.pages.map((p) => ({ visual: true, ...p })),
    routes,
    visual: { referenceDir: '.quality/reference', outDir: '.quality/out', width: 1280, height: 800, maxDiffRatio: 0.001, pixelThreshold: 0.1, ...visual },
    speed: { defaultBudgetMs: DEFAULT_SPEED_BUDGET_MS, runs: 3, ...speed },
    a11y: { failOn: ['serious', 'critical'], ...a11y },
  };
}

export function readConfig(path = CONFIG_PATH) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new ConfigError(`cannot read ${path}: ${e.code ?? e.message}`); }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new ConfigError(`${path} is not valid JSON: ${e.message}`); }
  return checkConfig(raw);
}

/** @public Bob's self-tests call it directly. */
// KEY=VALUE lines; blank lines and # comments skipped. The test-data file is committed, so it holds no secrets.
export function parseTestData(text) {
  const env = {};
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
    if (!m) throw new ConfigError(`test-data file line ${i + 1} is not KEY=VALUE`);
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function testDataEnv(config, base = process.env) {
  const env = { ...base };
  if (config.start.testDataFile) {
    let text;
    try { text = readFileSync(config.start.testDataFile, 'utf8'); } catch (e) { throw new ConfigError(`cannot read start.testDataFile ${config.start.testDataFile}: ${e.code ?? e.message}`); }
    Object.assign(env, parseTestData(text));
  }
  return env;
}

export function pageUrl(config, path) {
  return new URL(path, config.start.url).href;
}

// Run the declared build command with the test data. Resolves to the exit code.
export function runBuild(config, { env = testDataEnv(config), stdio = 'inherit' } = {}) {
  return new Promise((res) => {
    const child = spawn(config.start.build, { shell: true, env, stdio });
    child.on('error', () => res(127));
    child.on('exit', (code, signal) => res(signal ? 1 : code));
  });
}

async function answers(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return r.status;
  } catch {
    return null;
  }
}

// Start the product, wait until readyPath answers (any status below 500), and return { stop }. Throws if something
// already answers there (the checks would test that instead of this build), if the process exits first, or if nothing
// answers within readyTimeoutSeconds. stop() ends the whole process group and resolves once it has exited.
export async function startServer(config, { env = testDataEnv(config), log = () => {} } = {}) {
  const ready = pageUrl(config, config.start.readyPath);
  if ((await answers(ready)) !== null) throw new Error(`something is already answering at ${ready}; stop it first, or the checks would test it instead of this build`);
  const child = spawn(config.start.command, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  const keep = (d) => { output = (output + d).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  const gone = new Promise((res) => {
    child.on('exit', (code, signal) => { exited = signal ?? code; res(); });
    child.on('error', (e) => { exited = e.message; res(); });
  });
  const signalGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
  const stop = async () => {
    signalGroup('SIGTERM');
    const timer = setTimeout(() => signalGroup('SIGKILL'), 5000);
    await gone;
    clearTimeout(timer);
    signalGroup('SIGKILL'); // anything the start command left behind in its group
    for (let i = 0; i < 20 && (await answers(ready)) !== null; i++) await new Promise((r) => setTimeout(r, 250));
  };
  const deadline = Date.now() + config.start.readyTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`the start command exited (${exited}) before answering ${ready}\n${output}`);
    const status = await answers(ready);
    if (status !== null && status < 500) { log(`started: ${ready} answered ${status}`); return { stop }; }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`nothing answered ${ready} within ${config.start.readyTimeoutSeconds}s\n${output}`);
}

// Load an optional tool (playwright, axe-core) from the product's node_modules. Missing → a FAIL that says how to install.
export async function needTool(name) {
  try {
    return await import(name);
  } catch {
    throw new Error(`${name} is not installed; the check job installs it (templates/quality/quality-check.yml). Locally: npm install --no-save ${name}`);
  }
}


// True when the file whose import.meta.url is given was run directly (node file.mjs), not imported.
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
}
