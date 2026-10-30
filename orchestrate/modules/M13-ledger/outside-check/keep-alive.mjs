// keep-alive.mjs — GitHub switches a public repo's scheduled workflows off after 60 days without repo activity. When
// the default branch's newest commit is 50+ days old, this updates `keepalive.txt` through the contents API.
// Whether a GITHUB_TOKEN commit counts as activity is NOT verified (GitHub docs, 29 Oct 2026, don't say): the owner's
// day-61 re-check (README) is the real test, and this note is void once it has run either way (Principle 9).
import { fileURLToPath } from 'node:url';

export const QUIET_DAYS = 50;

export async function keepAlive({ api, now = () => Date.now() }) {
  const repo = await api('GET', '');
  const [head] = await api('GET', `/commits?sha=${encodeURIComponent(repo.default_branch)}&per_page=1`);
  const age = (now() - Date.parse(head.commit.committer.date)) / 86400e3;
  if (age < QUIET_DAYS) return { committed: false, age: Math.floor(age) };
  let sha;
  try { sha = (await api('GET', '/contents/keepalive.txt')).sha; } catch { sha = undefined; }
  const content = Buffer.from(`${new Date(now()).toISOString()}\n`).toString('base64');
  await api('PUT', '/contents/keepalive.txt', { message: 'keep the schedule alive', content, ...(sha ? { sha } : {}) });
  return { committed: true, age: Math.floor(age) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`keep-alive: http ${r.status}`);
    return r.json();
  };
  const r = await keepAlive({ api });
  console.log(r.committed ? `quiet ${r.age} days: committed` : `last commit ${r.age} days ago: nothing to do`);
}
