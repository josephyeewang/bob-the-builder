// visual-check.mjs — screenshot each declared page and compare it with its reference image from the locked design.
// A page fails when more than visual.maxDiffRatio of its pixels differ (a pixel differs when a channel moves by more
// than visual.pixelThreshold), when its size changed, or when it has no reference image (fail closed).
// Every screenshot is written to visual.outDir so the check job can attach them for a person to look at.
// --update-references writes the screenshots as the new references instead: run it in the check job (fonts differ
// between machines), download the files, and commit them only as part of a change whose approval names them.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pageUrl } from './quality-lib.mjs';
import { decodePng, compareImages } from './png.mjs';

async function screenshot(browser, config, page) {
  const context = await browser.newContext({
    viewport: { width: config.visual.width, height: config.visual.height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  try {
    const tab = await context.newPage();
    await tab.goto(pageUrl(config, page.path), { waitUntil: 'networkidle', timeout: 60000 });
    return await tab.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  } finally {
    await context.close();
  }
}

export async function visualCheck({ config, browser, log = () => {}, updateReferences = false }) {
  const { referenceDir, outDir, maxDiffRatio, pixelThreshold } = config.visual;
  const pages = config.pages.filter((p) => p.visual);
  if (pages.length === 0) return ['no page has visual checking on (every page has "visual": false)'];
  mkdirSync(updateReferences ? referenceDir : outDir, { recursive: true });
  const failures = [];
  for (const page of pages) {
    const shot = await screenshot(browser, config, page);
    if (updateReferences) {
      writeFileSync(join(referenceDir, `${page.name}.png`), shot);
      log(`  wrote reference ${page.name}.png`);
      continue;
    }
    writeFileSync(join(outDir, `${page.name}.png`), shot);
    const refPath = join(referenceDir, `${page.name}.png`);
    if (!existsSync(refPath)) { failures.push(`page ${page.name}: no reference image at ${refPath}`); continue; }
    let result;
    try {
      result = compareImages(decodePng(shot), decodePng(readFileSync(refPath)), { pixelThreshold });
    } catch (e) {
      failures.push(`page ${page.name}: cannot compare (${e.message})`);
      continue;
    }
    if (result.sameSize && result.diffRatio <= maxDiffRatio) log(`  ok    page ${page.name}: ${result.detail}`);
    else failures.push(`page ${page.name} drifts from its reference: ${result.detail} (allowed: ${(maxDiffRatio * 100).toFixed(2)}%)`);
  }
  return failures;
}
