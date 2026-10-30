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
//   4. permissions.ask stops at the milestone actions: git push, and deploy or migrate;
//   5. a Stop hook runs a green-gate script that exists, has a numeric retry limit it compares against, and no
//      longer holds bob-init's "EDIT … set TEST_CMD" placeholder;
//   6. .claude/agents/reviewer.md exists and its tools do not include Edit, Write or NotebookEdit;
//   7. the settings' "env" block names no production credential (a key with PROD, PRODUCTION or LIVE in it).
//
// Usage: node "$(realpath ~/.claude/skills/bob/..)/scripts/autonomy-check.mjs" [DIR]
// Exit: 0 = ready for a hands-off phase · 1 = REFUSED (each problem listed) · 2 = cannot run (no settings file:
//       not set up yet, which is not a pass — Rule 29).

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] ?? '.');
const at = (p) => path.join(DIR, p);
const problems = [];
const bad = (n, what) => problems.push(`  ✗ [${n}] ${what}`);

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

if (settings) {
  const perms = settings.permissions ?? {};
  const list = (k) => (Array.isArray(perms[k]) ? perms[k] : []);
  const covers = (k, needle) => list(k).some((r) => r.replace(/\s+/g, ' ').includes(needle));

  if (perms.defaultMode === 'auto')
    bad(2, `${SETTINGS} sets defaultMode "auto", which Claude Code ignores in a project file — auto is NOT on. Turn it on with Shift+Tab (⏵⏵ auto mode on) or in ~/.claude/settings.json`);

  for (const needle of ['rm -rf', 'git push --force', 'git reset --hard'])
    if (!covers('deny', needle)) bad(3, `permissions.deny has no rule for "${needle}"`);

  if (!covers('ask', 'git push')) bad(4, 'permissions.ask does not stop at "git push" — a milestone gate is missing');
  if (!list('ask').some((r) => /deploy|migrate/.test(r))) bad(4, 'permissions.ask does not stop at deploy or migrate commands');

  const stopCmds = (settings.hooks?.Stop ?? []).flatMap((h) => (h.hooks ?? []).map((x) => x.command ?? ''));
  const gatePaths = stopCmds
    .map((c) => c.match(/["']?(?:\$CLAUDE_PROJECT_DIR\/|\$\{CLAUDE_PROJECT_DIR\}\/)?([\w./-]+\.(?:sh|mjs|js|py))["']?/)?.[1])
    .filter(Boolean);
  if (!gatePaths.length) bad(5, 'no Stop hook runs a green-gate script — nothing forces the build to be green before a phase ends');
  for (const g of gatePaths) {
    if (!fs.existsSync(at(g))) { bad(5, `the Stop hook runs ${g}, which does not exist`); continue; }
    const src = fs.readFileSync(at(g), 'utf8');
    const limit = src.match(/\b([A-Z_]*(?:MAX|LIMIT)[A-Z_]*)=(\d+)/);
    if (!limit || !new RegExp(`\\$\\{?${limit[1]}\\b`).test(src))
      bad(5, `${g} has no numeric retry limit it checks (e.g. MAX_ATTEMPTS=8 … -gt "$MAX_ATTEMPTS") — stop_hook_active alone can loop forever`);
    if (/EDIT \.claude\/hooks\/green-gate\.sh: set TEST_CMD/.test(src))
      bad(5, `${g} still has bob-init's placeholder test command — set TEST_CMD to your build and tests, or the gate blocks every stop`);
  }

  const env = settings.env && typeof settings.env === 'object' ? Object.keys(settings.env) : [];
  for (const k of env) if (/PROD|PRODUCTION|LIVE/i.test(k)) bad(7, `settings.env sets ${k} — never give an autonomous run production credentials; keep prod and dev separate`);
}

const REVIEWER = '.claude/agents/reviewer.md';
if (!fs.existsSync(at(REVIEWER))) bad(6, `no ${REVIEWER} — there is no fresh-context reviewer to invoke at the milestone`);
else {
  const tools = fs.readFileSync(at(REVIEWER), 'utf8').match(/^tools:\s*(.+)$/m)?.[1] ?? '';
  const editing = tools.split(/[,\s]+/).filter((t) => /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(t));
  if (editing.length) bad(6, `${REVIEWER} can use ${editing.join(', ')} — a reviewer reviews; it must not edit the work it judges`);
}

if (problems.length) {
  console.log(`autonomy-check: REFUSED — ${DIR} is not ready for a hands-off build phase (${problems.length} problem(s))`);
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log(`autonomy-check: OK — ${DIR} has the Rule 27 safety setup (deny/ask rules, a bounded green-gate, a read-only reviewer)`);
