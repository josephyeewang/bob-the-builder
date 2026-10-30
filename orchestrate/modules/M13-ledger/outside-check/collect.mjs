// collect.mjs — turns the check steps' result lines into the check job's two outputs: `ran` and `failed`, each a
// comma-separated list of "product N / <check>" step names (no product data). An empty `ran` means no product slot was
// filled, so notify skips.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function collect(text) {
  const ran = []; const failed = [];
  for (const line of text.split('\n')) {
    const m = /^(product \d+ \/ [a-z-]+): (ok|FAIL)\b/.exec(line);
    if (!m) continue;
    ran.push(m[1]);
    if (m[2] === 'FAIL') failed.push(m[1]);
  }
  return { ran: ran.join(','), failed: failed.join(',') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = process.env.RESULTS;
  const { ran, failed } = collect(f && existsSync(f) ? readFileSync(f, 'utf8') : '');
  appendFileSync(process.env.GITHUB_OUTPUT, `ran=${ran}\nfailed=${failed}\n`);
  console.log(`ran ${ran ? ran.split(',').length : 0}, failed ${failed ? failed.split(',').length : 0}`);
}
