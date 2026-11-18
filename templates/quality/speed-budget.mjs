// speed-budget.mjs — load each declared page in the browser and compare its load time with its budget
// (pages[].speedBudgetMs, else speed.defaultBudgetMs, else 1 second). Each page is loaded once to warm up, then
// speed.runs times; the middle value counts, so one slow run on a busy machine doesn't fail the check.
// Load time = the browser's own navigation timing, from the request to the end of the page's load event.

import { pageUrl } from './quality-lib.mjs';

function budgetFor(config, page) {
  return page.speedBudgetMs ?? config.speed.defaultBudgetMs;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** @public Bob's self-tests call it directly. */
// A reading that is missing, not a number, zero or negative can't show the page was fast: it fails (fail closed).
export function judge(pageName, budget, timings) {
  if (!timings.length || timings.some((t) => !Number.isFinite(t) || t <= 0)) {
    return `page ${pageName}: no usable load time (${JSON.stringify(timings)})`;
  }
  const m = Math.round(median(timings));
  return m > budget ? `page ${pageName} loads in ${m} ms, over its ${budget} ms budget (runs: ${timings.map(Math.round).join(', ')})` : null;
}

export async function speedBudget({ config, browser, log = () => {} }) {
  const failures = [];
  for (const page of config.pages) {
    const budget = budgetFor(config, page);
    const context = await browser.newContext({ viewport: { width: config.visual.width, height: config.visual.height } });
    const timings = [];
    try {
      const tab = await context.newPage();
      for (let i = 0; i <= config.speed.runs; i++) {
        await tab.goto(pageUrl(config, page.path), { waitUntil: 'load', timeout: 60000 });
        const t = await tab.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          return nav ? nav.loadEventEnd - nav.startTime : null;
        });
        if (i > 0) timings.push(t); // the first load warms the server up and is not counted
      }
    } finally {
      await context.close();
    }
    const failure = judge(page.name, budget, timings);
    if (failure) failures.push(failure);
    else log(`  ok    page ${page.name}: ${Math.round(median(timings))} ms (budget ${budget} ms)`);
  }
  return failures;
}
