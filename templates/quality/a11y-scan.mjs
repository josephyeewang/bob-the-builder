// a11y-scan.mjs — run the axe-core accessibility scan on each declared page. A problem whose impact is on
// a11y.failOn (default: serious and critical) fails the check; lesser ones are listed and pass.

import { createRequire } from 'node:module';
import { pageUrl, needTool } from './quality-lib.mjs';

export async function a11yScan({ config, browser, log = () => {} }) {
  await needTool('axe-core');
  const axePath = createRequire(`${process.cwd()}/`).resolve('axe-core/axe.min.js');
  const failOn = config.a11y.failOn;
  const failures = [];
  for (const page of config.pages) {
    const context = await browser.newContext({ viewport: { width: config.visual.width, height: config.visual.height } });
    let violations;
    try {
      const tab = await context.newPage();
      await tab.goto(pageUrl(config, page.path), { waitUntil: 'networkidle', timeout: 60000 });
      await tab.addScriptTag({ path: axePath });
      const result = await tab.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
      if (!result || !Array.isArray(result.violations)) throw new Error('axe returned no result');
      violations = result.violations;
    } finally {
      await context.close();
    }
    const serious = violations.filter((v) => failOn.includes(v.impact));
    for (const v of violations) {
      const where = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ');
      const line = `page ${page.name}: ${v.impact} — ${v.id}: ${v.help} (${where})`;
      if (serious.includes(v)) failures.push(line); else log(`  note  ${line}`);
    }
    if (serious.length === 0) log(`  ok    page ${page.name}: no ${failOn.join(' or ')} problems`);
  }
  return failures;
}
