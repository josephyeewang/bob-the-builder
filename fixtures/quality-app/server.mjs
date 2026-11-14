// A tiny test product for Bob's quality checks (templates/quality/). Standard-library Node only.
// The self-test (templates/quality/e2e-selftest.mjs) copies this folder, plants one fault at a time, and checks
// that the matching check fails while the clean copy passes.
import { createServer } from 'node:http';
import { pages } from './src/pages.mjs';
import { total } from './src/figures.mjs';

const port = Number(process.env.PORT || 4173);
const greeting = process.env.APP_GREETING || 'missing test data';

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, total: total([1, 2, 3]) }));
  }
  const page = pages[url.pathname];
  if (!page) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const delayMs = 0;
  await new Promise((r) => setTimeout(r, delayMs));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(greeting));
}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
