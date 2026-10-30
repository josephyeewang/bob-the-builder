#!/usr/bin/env node
// autonomy-check.mjs — Bob Rule 27 (supervised autonomy): before a build phase runs hands-off, check that the
// project's safety setup is really in place, not just described.
//
// WHY. Rule 27's runbook lists traps that prose kept failing to prevent: `defaultMode: "auto"` in a project's
// .claude/settings.json is silently IGNORED; a green-gate guarded only by `stop_hook_active` can loop forever; the
// reviewer subagent does nothing useful if it can edit; the gate bob-init writes blocks every stop until its test
// command is filled in; and an autonomous run must never hold production credentials. Each is one line in a file,
// so each is checked here (D-033).
//
// CHECKS on the project at DIR (default: the current folder):
//   1. .claude/settings.json exists and is valid JSON (bob-init writes it);
//   2. it does not set permissions.defaultMode to "auto" (ignored there — turn auto on with Shift+Tab or in
//      ~/.claude/settings.json);
//   3. permissions.deny holds the destructive basics: rm -rf, git push --force, git reset --hard;
//   4. permissions.ask stops at git push (refused if missing) and at a deploy or migrate command (a warning if none
//      is recognised — deploy tools vary);
//   5. a Stop hook runs a project green-gate script with a numeric retry limit it compares against (MAX_ATTEMPTS=8 or
//      MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}") and no longer holding bob-init's "EDIT … set TEST_CMD" placeholder. Other
//      Stop hooks (a notifier in ~/.claude, say) are left alone; a gate run through `npm run …` or `make …` cannot be
//      read, so it is a warning to check by hand;
//   6. .claude/agents/reviewer.md exists and lists its tools, none of them Edit, Write, MultiEdit or NotebookEdit (a
//      reviewer with no tools line inherits every tool, including Edit). Bash is allowed — the reviewer runs the tests;
//   7. the settings' "env" block names no production credential (a key with PROD or PRODUCTION as a word, or LIVE on a key, secret, token, password, DSN or URL).
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/autonomy-check.mjs" [DIR]
// Exit: 0 = ready for a hands-off phase (warnings, if any, printed) · 1 = REFUSED (each problem listed) · 2 = cannot
//       run (no settings file, or neither a Stop hook nor a reviewer: not set up yet, which is not a pass — Rule 29).
// Only the project's own .claude/settings.json is read: personal rules do not travel with the project.

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const at = (p) => path.join(DIR, p);
const problems = [];
const warnings = [];
const bad = (n, what) => problems.push(`  ✗ [${n}] ${what}`);
const warn = (n, what) => warnings.push(`  ⚠ [${n}] ${what}`);

const SETTINGS = '.claude/settings.json';
if (!fs.existsSync(at(SETTINGS))) {
  process.stderr.write(`autonomy-check: no ${SETTINGS} in ${DIR} — the project is not set up for supervised autonomy yet (bob-init writes it). Not a pass.\n`);
  process.exit(2);
}
let settings;
try {
  settings = JSON.parse(fs.readFileSync(at(SETTINGS), 'utf8'));
} catch (e) {
  bad(1, `${SETTINGS} is not valid JSON (${e.message}) — Claude Code will not load any of it`);
}

const REVIEWER = '.claude/agents/reviewer.md';
// Nothing of the setup at all (no Stop hook, no reviewer) means "never set up", not six separate failures.
if (settings && !(settings.hooks?.Stop ?? []).length && !fs.existsSync(at(REVIEWER))) {
  process.stderr.write(`autonomy-check: ${DIR} has no Stop hook and no ${REVIEWER} — it is not set up for supervised autonomy (bob-init writes both). Not a pass.\n`);
  process.exit(2);
}

if (settings) {
  // Only the project's own rules count: rules in a personal settings file do not travel with the project, so a run
  // on another machine or in CI would not have them.
  const perms = settings.permissions ?? {};
  const list = (k) => (Array.isArray(perms[k]) ? perms[k] : []);
  const covers = (k, needle) => list(k).some((r) => r.replace(/\s+/g, ' ').includes(needle));

  if (perms.defaultMode === 'auto')
    bad(2, `${SETTINGS} sets defaultMode "auto", which Claude Code ignores in a project file — auto is NOT on. Turn it on with Shift+Tab (⏵⏵ auto mode on) or in ~/.claude/settings.json`);

  for (const needle of ['rm -rf', 'git push --force', 'git reset --hard'])
    if (!covers('deny', needle)) bad(3, `permissions.deny has no rule for "${needle}"`);

  if (!covers('ask', 'git push')) bad(4, 'permissions.ask does not stop at "git push" — a milestone gate is missing');
  if (!list('ask').some((r) => /deploy|migrate|vercel|netlify|flyctl|\bfly\b|wrangler|heroku|db push|prisma|terraform apply|kubectl apply|supabase/.test(r)))
    warn(4, 'permissions.ask names no deploy or migrate command that this check recognises — make sure your deploy and database-change commands ask first');

  const stopCmds = (settings.hooks?.Stop ?? []).flatMap((h) => (h.hooks ?? []).map((x) => x.command ?? ''));
  const gates = [];
  for (const c of stopCmds) {
    const script = c.match(/["']?((?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}|~|\$HOME|\/)?[\w./${}-]*\.(?:sh|mjs|js|py))["']?/)?.[1];
    if (!script) { if (/\b(npm|pnpm|yarn|bun) run\b|\bmake\b/.test(c)) warn(5, `the Stop hook "${c.slice(0, 60)}" runs through a task runner, so this check cannot see whether it is bounded — check it by hand`); continue; }
    const local = script.replace(/^(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})\//, '');
    if (/^(~|\$HOME|\/)/.test(local)) continue; // a personal hook outside the project, e.g. a notifier
    if (!fs.existsSync(at(local))) { bad(5, `the Stop hook runs ${local}, which does not exist`); continue; }
    gates.push({ local, src: fs.readFileSync(at(local), 'utf8') });
  }
  const limitOf = (src) => {
    const m = src.match(/\b([A-Z_]*(?:MAX|LIMIT)[A-Z_]*)=["']?(?:\$\{\1:-)?(\d+)/);
    return m && new RegExp(`\\$\\{?${m[1]}\\b`).test(src.replace(m[0], '')) ? m : null;
  };
  if (!gates.length && !warnings.some((w) => w.includes('[5]')))
    bad(5, 'no Stop hook runs a green-gate script in the project — nothing forces the build to be green before a phase ends');
  else if (gates.length && !gates.some((g) => limitOf(g.src)))
    bad(5, `no Stop hook script (${gates.map((g) => g.local).join(', ')}) has a numeric retry limit it checks (e.g. MAX_ATTEMPTS=8 … -gt "$MAX_ATTEMPTS") — stop_hook_active alone can loop forever`);
  for (const g of gates)
    if (/EDIT \.claude\/hooks\/green-gate\.sh: set TEST_CMD/.test(g.src))
      bad(5, `${g.local} still has bob-init's placeholder test command — set TEST_CMD to your build and tests, or the gate blocks every stop`);

  const env = settings.env && typeof settings.env === 'object' ? Object.keys(settings.env) : [];
  for (const k of env)
    // PROD / PRODUCTION as a word; LIVE only on a secret-looking key (STRIPE_LIVE_KEY, not ENABLE_LIVE_PREVIEW).
    if (/(^|[_-])(PROD|PRODUCTION)($|[_-])/i.test(k) || (/(^|[_-])LIVE($|[_-])/i.test(k) && /KEY|SECRET|TOKEN|PASSWORD|DSN|URL/i.test(k))) bad(7, `settings.env sets ${k} — never give an autonomous run production credentials; keep prod and dev separate`);
}

if (!fs.existsSync(at(REVIEWER))) bad(6, `no ${REVIEWER} — there is no fresh-context reviewer to invoke at the milestone`);
else {
  const front = fs.readFileSync(at(REVIEWER), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const line = front.match(/^tools:[ \t]*(.*)$/m);
  if (!line) bad(6, `${REVIEWER} has no tools: line, so it inherits every tool, including Edit — list its tools (e.g. Read, Grep, Glob, Bash)`);
  else {
    let tools = line[1].trim();
    if (!tools) { // YAML list form: "tools:" then "  - Read" lines
      const after = front.slice(front.indexOf(line[0]) + line[0].length).split('\n').slice(1);
      tools = after.filter((l, i) => after.slice(0, i + 1).every((x) => /^\s*-\s/.test(x))).map((l) => l.replace(/^\s*-\s*/, '')).join(',');
    }
    const editing = tools.replace(/[[\]"']/g, '').split(/[,\s]+/).filter((t) => /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(t));
    if (editing.length) bad(6, `${REVIEWER} can use ${editing.join(', ')} — a reviewer reviews; it must not edit the work it judges`);
  }
}

const tail = warnings.length ? `\n${warnings.join('\n')}` : '';
if (problems.length) {
  console.log(`autonomy-check: REFUSED — ${DIR} is not ready for a hands-off build phase (${problems.length} problem(s))`);
  console.log(problems.join('\n') + tail);
  process.exit(1);
}
console.log(`autonomy-check: OK — ${DIR} has the Rule 27 safety setup (deny/ask rules, a bounded green-gate, a read-only reviewer)${tail}`);
