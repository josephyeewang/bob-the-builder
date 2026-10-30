// vercel-reader.mjs — the production watcher's only window onto Vercel (R-0b-71; review-0b-7 M3, M4; design B10).
//
// The Sensors' one Vercel key can also write (B10); this reader only ever issues GET requests, and it is the one place
// that sees Vercel's raw answers. It returns only the fields the watcher needs and DROPS every env value: it never asks
// to decrypt, and it strips `value` and any `decrypted*` field before returning (Vercel returns plain-type values in
// clear even without decrypting). Nothing past this file can see a value, so nothing can store or print one.
//
// fetchJson(path) is injected: on the Mini a ten-line wrapper adds the key from the Sensors' environment; tests pass a
// fake. Endpoint paths and field names are assumed from Vercel's API docs, 29 Oct 2026; check them on the test project
// (owner step) and treat them as void on a Vercel API change (Principle 9).

const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)).toString();

// The project settings whose change could switch a guard off (M4). The build-skip ("ignored build step") command is
// the guard E4 relies on.
export const SETTING_FIELDS = Object.freeze([
  ['commandForIgnoringBuildStep', (p) => p.commandForIgnoringBuildStep],
  ['buildCommand', (p) => p.buildCommand],
  ['installCommand', (p) => p.installCommand],
  ['outputDirectory', (p) => p.outputDirectory],
  ['devCommand', (p) => p.devCommand],
  ['rootDirectory', (p) => p.rootDirectory],
  ['framework', (p) => p.framework],
  ['nodeVersion', (p) => p.nodeVersion],
  ['productionBranch', (p) => p.link?.productionBranch],
  ['linkedRepo', (p) => (p.link ? `${p.link.type ?? ''}:${p.link.org ?? ''}/${p.link.repo ?? ''}` : null)],
  ['autoAssignCustomDomains', (p) => p.autoAssignCustomDomains],
]);

// A list field that is missing or not a list is an unreadable answer, never "none" (round 3 M-C): the watcher's
// catch raises "cannot read Vercel". The Mini's fetchJson must throw on any non-2xx answer.
function list(r, field) {
  if (!Array.isArray(r?.[field])) throw Object.assign(new Error(`Vercel answer has no ${field} list`), { shape: field });
  return r[field];
}

export function makeVercelReader(fetchJson, { projectId, teamId } = {}) {
  const team = teamId ? { teamId } : {};
  return Object.freeze({
    async deployments() {
      const r = await fetchJson(`/v6/deployments?${q({ projectId, target: 'production', limit: 50, ...team })}`);
      return list(r, 'deployments').map((d) => ({
        uid: d.uid, created: d.created ?? d.createdAt, state: d.readyState ?? d.state, target: d.target ?? 'production',
        source: d.source ?? null, sha: d.meta?.githubCommitSha ?? null,
      }));
    },
    async live() {
      const p = await fetchJson(`/v9/projects/${encodeURIComponent(projectId)}?${q(team)}`);
      return { uid: p.targets?.production?.id ?? null };
    },
    async envMeta() {
      const r = await fetchJson(`/v10/projects/${encodeURIComponent(projectId)}/env?${q(team)}`);
      return list(r, 'envs').map((e) => ({ id: e.id, key: e.key, target: Array.isArray(e.target) ? e.target : [e.target], type: e.type, updatedAt: e.updatedAt }));
    },
    async settings() {
      const p = await fetchJson(`/v9/projects/${encodeURIComponent(projectId)}?${q(team)}`);
      const d = await fetchJson(`/v9/projects/${encodeURIComponent(projectId)}/domains?${q(team)}`);
      const out = {};
      for (const [name, get] of SETTING_FIELDS) out[name] = get(p) ?? null;
      out.productionDomains = list(d, 'domains').filter((x) => !x.gitBranch).map((x) => x.name).sort();
      return out;
    },
  });
}
