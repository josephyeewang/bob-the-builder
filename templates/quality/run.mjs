#!/usr/bin/env node
// run.mjs — the one entry point of Bob's quality checks (templates/quality/README.md).
//
//   node scripts/quality/run.mjs build                       run the declared build with the test data
//   node scripts/quality/run.mjs smoke visual a11y speed     start the product with the test data, run the named checks
//   node scripts/quality/run.mjs visual --update-references  write each page's screenshot as its new reference image
//
// Exit 0 only when every named check ran and passed. Anything that stops a check from running (no config, the product
// never starts, a tool not installed) is a failure, never a pass. The product is started once and stopped at the end.

import { readConfig, runBuild, startServer, needTool, isMain, ConfigError, CONFIG_PATH } from './quality-lib.mjs';
import { smoke } from './smoke.mjs';
import { visualCheck } from './visual-check.mjs';
import { a11yScan } from './a11y-scan.mjs';
import { speedBudget } from './speed-budget.mjs';

const CHECKS = { smoke, visual: visualCheck, a11y: a11yScan, speed: speedBudget };
const BROWSER_CHECKS = ['visual', 'a11y', 'speed'];

export async function main(argv, { log = console.log, configPath = process.env.QUALITY_CONFIG || CONFIG_PATH } = {}) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const names = argv.filter((a) => !a.startsWith('--'));
  for (const f of flags) if (f !== '--update-references') { log(`FAIL unknown option ${f}`); return 2; }
  const updateReferences = flags.includes('--update-references');
  if (names.length === 0) { log('FAIL name the checks to run: build, or any of smoke visual a11y speed'); return 2; }

  let config;
  try { config = readConfig(configPath); } catch (e) {
    log(`FAIL ${e instanceof ConfigError ? 'config: ' : ''}${e.message}`);
    return 1;
  }

  if (names.includes('build')) {
    if (names.length > 1) { log('FAIL run build on its own'); return 2; }
    const code = await runBuild(config);
    log(code === 0 ? 'PASS build' : `FAIL build exited ${code}`);
    return code === 0 ? 0 : 1;
  }
  for (const n of names) if (!CHECKS[n]) { log(`FAIL unknown check "${n}" (known: ${Object.keys(CHECKS).join(', ')})`); return 2; }
  if (updateReferences && names.join() !== 'visual') { log('FAIL --update-references goes with the visual check alone'); return 2; }

  let server, browser;
  const results = [];
  try {
    server = await startServer(config, { log });
    if (names.some((n) => BROWSER_CHECKS.includes(n))) {
      const { chromium } = await needTool('playwright');
      browser = await chromium.launch();
    }
    for (const n of names) {
      log(`— ${n}`);
      let failures;
      try {
        failures = await CHECKS[n]({ config, browser, log, updateReferences });
      } catch (e) {
        failures = [`the ${n} check could not run: ${e.message}`];
      }
      results.push([n, failures]);
    }
  } catch (e) {
    log(`FAIL ${e.message}`);
    return 1;
  } finally {
    await browser?.close().catch(() => {});
    await server?.stop();
  }

  let failed = 0;
  for (const [n, failures] of results) {
    if (failures.length === 0) { log(`PASS ${n}`); continue; }
    failed++;
    log(`FAIL ${n}`);
    for (const f of failures) log(`      ${f}`);
  }
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
