// collect.mjs — turns the check steps' result lines into the check job's two outputs: `ran` and `failed`, each a
// comma-separated list of "product N / <check>" step names (no product data). An empty `ran` means no product slot was
// filled, so notify skips.
import { readFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

// Run as a script, also through a link such as an installed copy (#261 r2 Minor 1): node gives import.meta.url as the
// real file but keeps argv[1] as typed, so argv[1] is resolved before the two are compared.
function isScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isScript()) {
  const f = process.env.RESULTS;
  const { ran, failed } = collect(f && existsSync(f) ? readFileSync(f, 'utf8') : '');
  appendFileSync(process.env.GITHUB_OUTPUT, `ran=${ran}\nfailed=${failed}\n`);
  console.log(`ran ${ran ? ran.split(',').length : 0}, failed ${failed ? failed.split(',').length : 0}`);
}
