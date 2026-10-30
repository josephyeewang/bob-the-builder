// workflow-rule.mjs — the audit rule for a product's GitHub workflows: every one read-only but the audit (R-0b-92).
//
// WHY. A workflow that can write can push, so GitHub's own test runs on a pull request could change main behind the
// Merge Gate. So every product workflow is read-only except the audit workflow, which must ask for exactly the
// permissions the rules give it (product_profile.audit_workflow { path, permissions }): more or fewer fails. On top,
// the patterns that let outside text steer a workflow fail outright: pull_request_target and workflow_run triggers,
// an issue or comment trigger with write, a checkout that keeps its key for later steps, outside text pasted into a
// script (`${{ github.event.issue.body }}` in run:), and a secret in a workflow that anyone's pull request can start.
//
//   checkWorkflow({ path, text, auditWorkflow, secretsAllowedTriggers? }) → { ok: true } | { ok: false, problems: [string] }
//   checkWorkflows([{ path, text }], auditWorkflow) → { ok, problems: [{ path, problem }] }
//   checkWorkflowDir(dir, auditWorkflow) → the same, for every .yml/.yaml in a folder (reads only, never writes)
// auditWorkflow = { path: '.github/workflows/<name>.yml', permissions: { scope: 'read'|'write'|'none' } | 'read-all' }
// secretsAllowedTriggers defaults to ['schedule', 'workflow_dispatch', 'push-to-main'] (push with branches [main] only).
//
// PARSING. Workflows are read with Bob's scripts/blueprint/yaml-lite.mjs, which refuses what it doesn't know. It has
// no flow maps (`permissions: {}`, `with: { a: b }`; workflow-rule.test.mjs shows the gap), so a narrow pre-pass
// rewrites a one-line flow map of plain values into block form first. Anything still unreadable fails the rule.
// Never throws: a bad input is a problem.

import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../../../scripts/blueprint/yaml-lite.mjs';

const WF_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const LEVELS = new Set(['read', 'write', 'none']);
const SCOPE = /^[a-z][a-z-]{0,40}$/;
const EMPTY = '';                       // stands for `{}` between the pre-pass and the parse; refused in input
const MAX_TEXT = 512 * 1024;
const DEFAULT_SECRET_TRIGGERS = ['schedule', 'workflow_dispatch', 'push-to-main'];
// Outside text a pull request or issue author controls; inside a script it runs as code (normalised expression text).
const UNTRUSTED = /github\.event\.(issue|comment|pull_request|review|review_comment|discussion|discussion_comment)\.(title|body)|github\.event\.pull_request\.head\.(ref|label)|head_ref/;
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (s) => JSON.stringify(String(s).slice(0, 80));

export function checkWorkflow({ path, text, auditWorkflow, secretsAllowedTriggers } = {}) {
  let problems;
  try { problems = check(path, text, auditWorkflow, secretsAllowedTriggers); } catch (e) {
    let why = 'unknown error';
    try { const m = e?.message; if (typeof m === 'string') why = m.slice(0, 200); } catch { /* keep the fixed text */ }
    problems = [`could not be read (${why})`];
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

export function checkWorkflows(files, auditWorkflow) {
  const problems = [];
  try {
    if (!Array.isArray(files)) return { ok: false, problems: [{ path: null, problem: 'no workflow list' }] };
    const seen = new Set();
    for (const f of files) {
      const path = f?.path;
      if (seen.has(path)) { problems.push({ path, problem: 'listed twice' }); continue; }
      seen.add(path);
      const r = checkWorkflow({ path, text: f?.text, auditWorkflow });
      if (!r.ok) for (const problem of r.problems) problems.push({ path, problem });
    }
    const audit = normAudit(auditWorkflow);
    if (typeof audit !== 'string' && !seen.has(audit.path)) problems.push({ path: audit.path, problem: 'the audit workflow is missing' });
  } catch (e) { problems.push({ path: null, problem: `could not be read (${String(e?.message ?? e).slice(0, 200)})` }); }
  return { ok: problems.length === 0, problems };
}

// `dir` is a product's .github/workflows folder. Reads only; a link or a folder named like a workflow is a problem.
export function checkWorkflowDir(dir, auditWorkflow) {
  try {
    const files = [];
    const problems = [];
    for (const name of readdirSync(dir).sort()) {
      if (!/\.ya?ml$/.test(name)) continue;
      const st = lstatSync(join(dir, name));
      if (!st.isFile()) { problems.push({ path: `.github/workflows/${name}`, problem: st.isSymbolicLink() ? 'a link, not a file' : 'not a plain file' }); continue; }
      files.push({ path: `.github/workflows/${name}`, text: readFileSync(join(dir, name), 'utf8') });
    }
    const r = checkWorkflows(files, auditWorkflow);
    const all = [...problems, ...r.problems];
    return { ok: all.length === 0, problems: all };
  } catch (e) { return { ok: false, problems: [{ path: null, problem: `workflow folder unreadable (${String(e?.code ?? e?.message ?? e).slice(0, 80)})` }] }; }
}

function check(path, text, auditWorkflow, secretsAllowedTriggers) {
  if (typeof path !== 'string' || !WF_PATH.test(path)) return [`not a workflow file (${short(path)}): workflows are .github/workflows/<name>.yml or .yaml`];
  const audit = normAudit(auditWorkflow);
  if (typeof audit === 'string') return [audit];
  const allowed = secretsAllowedTriggers ?? DEFAULT_SECRET_TRIGGERS;
  if (!Array.isArray(allowed) || !allowed.every((t) => typeof t === 'string')) return ['the triggers allowed secrets are not a list of names'];
  if (typeof text !== 'string') return ['no workflow text'];
  if (text.length > MAX_TEXT) return ['workflow text too long to check'];
  if (text.includes(EMPTY)) return ['workflow text holds a reserved character'];
  // yaml-lite stores keys on plain objects, where `__proto__` would hide a job from the checks below.
  if (text.includes('__proto__')) return ['workflow text names __proto__'];

  let doc;
  try { doc = parseYaml(expandFlowMaps(text), path); } catch (e) { return [`unreadable workflow: ${String(e?.message ?? e).slice(0, 200)}`]; }
  doc = restoreEmpty(doc);
  if (!isMap(doc)) return ['the workflow is not a map'];
  if (!own(doc, 'on')) return ['the workflow names no trigger (on:)'];
  if (!isMap(doc.jobs)) return ['the workflow has no jobs map'];

  const problems = [];
  const isAudit = path === audit.path;

  // Triggers, in any form.
  const triggers = triggerNames(doc.on);
  if (!triggers) problems.push('triggers (on:) are not a name, a list or a map');
  const names = triggers ?? [];
  for (const t of ['pull_request_target', 'workflow_run']) {
    if (names.includes(t) || new RegExp(`\\b${t}\\b`).test(text)) problems.push(`started by ${t} (outside code would run with this repository's access)`);
  }

  // Permissions: top level, then each job.
  const blocks = [];
  if (!own(doc, 'permissions')) problems.push('no top-level permissions: GitHub\'s default may let it write');
  else blocks.push(['top level', doc.permissions]);
  for (const [job, def] of Object.entries(doc.jobs)) {
    if (!isMap(def)) { problems.push(`job ${short(job)} is not a map`); continue; }
    if (own(def, 'permissions')) blocks.push([`job ${job}`, def.permissions]);
  }
  let writes = false;
  let permsBad = !own(doc, 'permissions');
  for (const [where, raw] of blocks) {
    const p = normPerms(raw);
    if (typeof p === 'string') { problems.push(`${where} permissions ${p}`); writes = true; permsBad = true; continue; }
    const w = writeScopes(p);
    if (w.length) writes = true;
    if (isAudit) {
      // The top level is exactly the rules' set; a job may repeat it or narrow it to no write.
      const exact = same(p, audit.permissions);
      if (where === 'top level' && !exact) { permsBad = true; problems.push(`the audit workflow's permissions must be exactly ${canon(audit.permissions)}, not ${canon(p)}`); }
      else if (where !== 'top level' && !exact && w.length) { permsBad = true; problems.push(`${where} in the audit workflow asks for write beyond the audit's own set (${w.join(', ')})`); }
    } else if (w.length) problems.push(`${where} asks for write (${w.join(', ')}); only the audit workflow may`);
  }
  // The audit workflow's write is the rules' to give, so an issue trigger passes there only when its set is exact.
  const writeOutsideRules = writes && !(isAudit && !permsBad);
  for (const t of ['issue_comment', 'issues']) if (names.includes(t) && writeOutsideRules) problems.push(`started by ${t} and asks for write`);

  // Checkout keeping its key, and outside text in a script.
  for (const [job, def] of Object.entries(doc.jobs)) {
    if (!isMap(def) || !own(def, 'steps')) continue;
    if (!Array.isArray(def.steps)) { problems.push(`job ${short(job)} steps are not a list`); continue; }
    for (const step of def.steps) {
      if (!isMap(step) || typeof step.uses !== 'string' || !/^actions\/checkout(@|$)/i.test(step.uses.trim()) || isAudit) continue;
      const keep = isMap(step.with) ? step.with['persist-credentials'] : undefined;
      if (typeof keep !== 'string' || !/^false$/i.test(keep.trim())) problems.push(`job ${short(job)}: actions/checkout keeps the checkout key (set persist-credentials: false)`);
    }
  }
  for (const script of scripts(doc)) {
    for (const ex of expressions(script)) if (UNTRUSTED.test(ex)) problems.push(`script injection: \${{ ${ex.slice(0, 80)} }} inside run:`);
  }

  // Secrets only in workflows nobody else can start.
  if (usesSecret(doc, text) && !(triggers && secretsAllowed(doc.on, names, allowed))) {
    problems.push('a secret outside a schedule, dispatch or push-to-main workflow');
  }
  return [...new Set(problems)];
}

function normAudit(a) {
  if (!isMap(a)) return 'no audit workflow rule (product_profile.audit_workflow)';
  if (typeof a.path !== 'string' || !WF_PATH.test(a.path)) return 'the audit workflow rule names no workflow path';
  const permissions = normPerms(a.permissions);
  if (typeof permissions === 'string') return `the audit workflow rule's permissions ${permissions}`;
  return { path: a.path, permissions };
}

// A permissions value → { all: 'read'|'write' } or { scopes: { scope: level } }, or a string saying what's wrong.
function normPerms(v) {
  if (v === 'read-all') return { all: 'read' };
  if (v === 'write-all') return { all: 'write' };
  if (!isMap(v)) return `are not read-all, write-all or a map (${short(v)})`;
  const scopes = {};
  for (const [k, lvl] of Object.entries(v)) {
    if (!SCOPE.test(k)) return `name an odd scope ${short(k)}`;
    if (!LEVELS.has(lvl)) return `give ${k} an odd level ${short(lvl)}`;
    scopes[k] = lvl;
  }
  return { scopes };
}
const writeScopes = (p) => (p.all ? (p.all === 'write' ? ['write-all'] : []) : Object.keys(p.scopes).filter((k) => p.scopes[k] === 'write').sort());
const canon = (p) => (p.all ? `${p.all}-all` : JSON.stringify(Object.fromEntries(Object.entries(p.scopes).sort(([a], [b]) => (a < b ? -1 : 1)))));
const same = (a, b) => canon(a) === canon(b);

function triggerNames(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.every((t) => typeof t === 'string') ? on : null;
  if (isMap(on)) return Object.keys(on);
  return null;
}

// True when every trigger is one that only the repository's own people start: a schedule, a manual run, or a push to
// main and nothing else (no tags, no other branches).
function secretsAllowed(on, names, allowed) {
  if (!names.length) return false;
  for (const t of names) {
    if (t === 'push') {
      if (!allowed.includes('push-to-main') || !isMap(on)) return false;
      const p = on.push;
      if (!isMap(p)) return false;
      const b = p.branches;
      const onlyMain = b === 'main' || (Array.isArray(b) && b.length === 1 && b[0] === 'main');
      if (!onlyMain || own(p, 'tags') || own(p, 'tags-ignore') || own(p, 'branches-ignore')) return false;
    } else if (t === 'push-to-main' || !allowed.includes(t)) return false;
  }
  return true;
}

function usesSecret(doc, text) {
  for (const ex of expressions(text)) {
    for (const m of ex.matchAll(/\bsecrets\b(\.([a-z0-9_-]+))?/g)) if (m[2] !== 'github_token') return true;
  }
  for (const def of Object.values(doc.jobs)) if (isMap(def) && own(def, 'secrets')) return true;   // a reusable call handed secrets
  return false;
}

// Every `${{ … }}` in a text, normalised: no spaces, lower case, ['x'] read as .x.
function expressions(s) {
  const out = [];
  for (const m of String(s).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    out.push(m[1].replace(/\s+/g, '').toLowerCase().replace(/\[['"]([a-z0-9_-]+)['"]\]/g, '.$1'));
  }
  return out;
}

// Every script text: each `run:` value anywhere, and actions/github-script's `script:` input.
function scripts(node, out = []) {
  if (Array.isArray(node)) { for (const v of node) scripts(v, out); return out; }
  if (!isMap(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'run' && typeof v === 'string') out.push(v);
    else scripts(v, out);
  }
  if (typeof node.uses === 'string' && /^actions\/github-script(@|$)/i.test(node.uses.trim()) && isMap(node.with) && typeof node.with.script === 'string') out.push(node.with.script);
  return out;
}

// The pre-pass: `key: { a: b, c: 'd' }` on one line becomes `key:` plus indented `a: b` lines, and `key: {}` becomes
// a placeholder turned back into an empty map after the parse. Block text (`run: |`) is left alone. A flow map it
// can't split cleanly (nested, multi-line, odd keys) is left as is, and yaml-lite refuses it.
function expandFlowMaps(text) {
  const out = [];
  let block = null;   // the indent of the key that owns a block text, while inside it
  for (const raw of text.split(/\r?\n/)) {
    const ind = raw.match(/^ */)[0].length;
    if (block !== null) { if (raw.trim() === '' || ind > block) { out.push(raw); continue; } block = null; }
    const dashBlock = /^( *)- +[|>]/.exec(raw);
    if (dashBlock) { block = dashBlock[1].length; out.push(raw); continue; }
    const m = /^( *)(- +)?([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s+(.*)$/.exec(raw);
    if (m) {
      const keyIndent = m[1].length + (m[2]?.length ?? 0);
      const v = m[4].trim();
      if (/^[|>]/.test(v)) block = keyIndent;
      else if (v.startsWith('{')) {
        const pairs = flowPairs(v);
        if (pairs) {
          const head = `${m[1]}${m[2] ?? ''}${m[3]}:`;
          if (!pairs.length) out.push(`${head} '${EMPTY}'`);
          else { out.push(head); for (const [k, val] of pairs) out.push(`${' '.repeat(keyIndent + 2)}${k}: ${val}`); }
          continue;
        }
      }
    }
    out.push(raw);
  }
  return out.join('\n');
}

// `{ a: b, c: 'd' }` (with an optional trailing comment) → [[a, b], [c, 'd']]; null when it isn't that simple shape.
function flowPairs(v) {
  let i = 1, q = null, expr = false, part = '';
  const parts = [];
  for (; i < v.length; i++) {
    const c = v[i];
    if (q) { part += c; if (c === q) q = null; continue; }
    if (expr) { part += c; if (c === '}' && v[i + 1] === '}') { part += '}'; i++; expr = false; } continue; }
    if (c === '$' && v.startsWith('${{', i)) { part += '${{'; i += 2; expr = true; continue; }
    if (c === '"' || c === "'") { q = c; part += c; continue; }
    if (c === ',') { parts.push(part); part = ''; continue; }
    if (c === '}') break;
    if (c === '{' || c === '[' || c === ']') return null;
    part += c;
  }
  if (i >= v.length || q || expr) return null;
  const rest = v.slice(i + 1).trim();
  if (rest && !rest.startsWith('#')) return null;
  parts.push(part);
  if (parts.length === 1 && parts[0].trim() === '') return [];
  const pairs = [];
  for (const p of parts) {
    const m = /^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s+(\S.*?)\s*$/.exec(p);
    if (!m) return null;
    if (!/^['"]/.test(m[2]) && /:\s|\s#/.test(m[2])) return null;
    pairs.push([m[1], m[2]]);
  }
  return pairs;
}

function restoreEmpty(node) {
  if (node === EMPTY) return {};
  if (Array.isArray(node)) return node.map(restoreEmpty);
  if (isMap(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, restoreEmpty(v)]));
  return node;
}
