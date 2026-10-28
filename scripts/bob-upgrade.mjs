#!/usr/bin/env node
// bob-upgrade.mjs — /bob UPGRADE: bring an existing project up to date with the current Bob (D-019).
//
// Run it FROM THE PROJECT FOLDER:
//   node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs                 # report only — changes nothing
//   node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs --apply all     # apply every safe update
//   node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs --apply merge-guard,reviewer-agent
//   node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs --interactive   # ask yes/no per item
//   node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs --enforce guard-settings-block-no-verify
//   (bob-init calls it with --record-install; you never need to.)
//
// What it looks at — ONLY the pieces Bob installs into a project (the list is PIECES below):
// the hooks and helper in .claude/hooks/, their entries in .claude/settings.json, the reviewer in
// .claude/agents/, the daily dropped-work check, the project-owned lists Bob creates once
// (required checks, audit ledger, optional pointers), the Bob pointer in CLAUDE.md, two optional
// templates, and whether the commit-time document check blocks or only warns.
//
// For each piece it says one of: up to date · Bob has a newer version · missing (new in Bob) ·
// changed here on purpose (listed in .bob/differences.md — left alone) · changed here, reason not
// written down. "What Bob's current version is" comes from running bob-init in a throw-away folder,
// so bob-init stays the one source of truth. What the project had at install time comes from
// .bob/installed.json (written by bob-init and by every apply); with no such record, each file is
// compared against every past version of it in Bob's own history.
//
// Safety: it never touches a file outside that list (plus its own .bob/ folder); every file it
// replaces is copied to .bob/backups/<date>/ first; a hook that can stop work is added in
// warn-only mode first (except the merge guard, which has no off switch — D-018 — and starts in its
// own "no CI yet" stage). Exit code: 0 = report printed / changes applied; 2 = it could not run.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BOB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CMD = "node ~/.claude/skills/bob/../scripts/bob-upgrade.mjs";
const FORMAT = 1;

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { project: process.cwd(), apply: null, enforce: null, interactive: false, record: false, today: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--project") opt.project = resolve(argv[++i] || ".");
  else if (a === "--apply") opt.apply = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  else if (a === "--enforce") opt.enforce = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  else if (a === "--interactive" || a === "-i") opt.interactive = true;
  else if (a === "--record-install") opt.record = true;
  else if (a === "--today") opt.today = argv[++i];
  else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
  else { console.error(`bob-upgrade: unknown option "${a}"`); usage(); process.exit(2); }
}
function usage() {
  console.log(`Usage (from your project folder):
  ${CMD}                      report only — changes nothing
  ${CMD} --apply all          apply every safe update (newer versions + missing pieces)
  ${CMD} --apply <a,b>        apply just the named items (names are in the report)
  ${CMD} --interactive        ask yes/no for each item
  ${CMD} --enforce <a,b>      switch warn-only hooks (or the commit-time check) to blocking`);
}
const fail = (msg) => { console.error(`bob-upgrade: ${msg}`); process.exit(2); };

const PROJ = resolve(opt.project);
if (!existsSync(PROJ) || !statSync(PROJ).isDirectory()) fail(`${PROJ} is not a folder.`);
if (PROJ === BOB_ROOT) fail("run this from your project's folder, not from Bob's own folder.");
const TODAY = opt.today || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────
const sha = (s) => createHash("sha256").update(s).digest("hex");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const pj = (rel) => join(PROJ, rel);
function git(...args) {
  const r = spawnSync("git", ["-C", BOB_ROOT, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}`;
  return JSON.stringify(v);
}
const short = (c) => (c ? String(c).slice(0, 7) : "unknown");

const BOB_COMMIT = (git("rev-parse", "HEAD") || "").trim() || null;
const BOB_VERSION = (() => {
  const m = /Core Reference for Build Protocol (v[0-9]+(?:\.[0-9]+)+)/.exec(read(join(BOB_ROOT, "build-protocol-core.md")) || "");
  return m ? m[1] : "unknown";
})();
const DECISIONS = (() => {
  const map = {};
  for (const line of (read(join(BOB_ROOT, "decision-log.md")) || "").split("\n")) {
    const m = /^### (D-\d{3}): (.+)$/.exec(line);
    if (m && !map[m[1]]) map[m[1]] = m[2].replace(/\*\*/g, "");
  }
  return map;
})();
const CITED = new Set();
const explain = (ids) => { const u = [...new Set(ids)].sort(); u.forEach((d) => CITED.add(d)); return u.join(", "); };

// ── Bob's current version of every piece: run bob-init in a throw-away folder ────────────────────
let REF = null;
function ref() {
  if (REF) return REF;
  const box = mkdtempSync(join(tmpdir(), "bob-upgrade-ref-"));
  process.on("exit", () => rmSync(box, { recursive: true, force: true }));
  const r = spawnSync("bash", [join(BOB_ROOT, "scripts", "bob-init.sh"), "bob-reference"], {
    cwd: box, encoding: "utf8", env: { ...process.env, BOB_INIT_REFERENCE: "1" },
  });
  if (r.status !== 0) fail(`could not build Bob's reference copy (bob-init failed):\n${r.stdout}${r.stderr}`);
  REF = join(box, "bob-reference");
  return REF;
}

// ── The pieces Bob installs (the ONE list — bob-init's output is the content, this is the index) ─
const TESTCMD = /^TEST_CMD=.*$/m;
const PIECES = [
  { id: "guard-block-no-verify", kind: "file", path: ".claude/hooks/block-no-verify.js", source: "scripts/hooks/block-no-verify.js", decisions: ["D-017"], exec: true,
    what: "hook file: stops Claude skipping the commit checks (git commit --no-verify)" },
  { id: "guard-config-protection", kind: "file", path: ".claude/hooks/config-protection.js", source: "scripts/hooks/config-protection.js", decisions: ["D-017", "D-018"], exec: true,
    what: "hook file: stops Claude loosening lint settings (or the required-checks list) to get a green build" },
  { id: "guard-shell-scan", kind: "file", path: ".claude/hooks/lib/shell-scan.js", source: "scripts/hooks/lib/shell-scan.js", decisions: ["D-017"],
    what: "helper the guard hooks use to read shell commands" },
  { id: "merge-guard", kind: "file", path: ".claude/hooks/merge-guard.mjs", source: "scripts/hooks/merge-guard.mjs", decisions: ["D-018"], exec: true,
    what: "hook file: stops Claude merging a pull request past a failing required check" },
  { id: "merge-guard-lib", kind: "file", path: ".claude/hooks/lib/merge-guard.mjs", source: "scripts/hooks/lib/merge-guard.mjs", decisions: ["D-018"],
    what: "the merge guard's command reader" },
  { id: "green-gate", kind: "file", path: ".claude/hooks/green-gate.sh", decisions: ["D-011"], exec: true,
    normalize: (s) => s.replace(TESTCMD, "TEST_CMD=<this project's own command>"),
    what: "the \"don't stop until the build is green\" script (your own test command line is kept)" },
  { id: "reviewer-agent", kind: "file", path: ".claude/agents/reviewer.md", decisions: ["D-011", "D-016"],
    what: "the fresh-eyes reviewer Claude calls at every build milestone" },
  { id: "loop-check-script", kind: "file", path: "scripts/loop-check.mjs", source: "templates/loop-check.mjs", decisions: ["D-018"],
    what: "the daily dropped-work check (stale pull requests, open items with no owner, a silent nightly job)" },
  { id: "loop-check-workflow", kind: "file", path: ".github/workflows/loop-check.yml", source: "templates/loop-check.yml", decisions: ["D-018"],
    what: "runs the daily dropped-work check on GitHub once a day" },
  { id: "warn-only-helper", kind: "file", path: ".claude/hooks/warn-only.mjs", source: "scripts/hooks/warn-only.mjs", bobPath: "scripts/hooks/warn-only.mjs", decisions: ["D-019"], onlyIfWarn: true,
    what: "runs a hook in warn-only mode (says what it would have blocked, blocks nothing)" },

  { id: "guard-settings-block-no-verify", kind: "setting", event: "PreToolUse", matcher: "Bash", marker: "block-no-verify.js", hookFile: "block-no-verify.js",
    needs: ["guard-block-no-verify", "guard-shell-scan"], warnable: true, decisions: ["D-017"],
    what: "switches on the no-skipping-checks hook (.claude/settings.json)" },
  { id: "guard-settings-config-protection", kind: "setting", event: "PreToolUse", matcher: "Edit|MultiEdit|Write", marker: "config-protection.js", hookFile: "config-protection.js",
    needs: ["guard-config-protection"], warnable: true, decisions: ["D-017"],
    what: "switches on the no-loosening-lint-settings hook (.claude/settings.json)" },
  { id: "merge-guard-settings-bash", kind: "setting", event: "PreToolUse", matcher: "Bash", marker: "merge-guard.mjs",
    needs: ["merge-guard", "merge-guard-lib", "required-checks"], warnable: false, decisions: ["D-018"],
    what: "switches on the merge guard for shell commands (.claude/settings.json)" },
  { id: "merge-guard-settings-monitor", kind: "setting", event: "PreToolUse", matcher: "Monitor", marker: "merge-guard.mjs",
    needs: ["merge-guard", "merge-guard-lib", "required-checks"], warnable: false, decisions: ["D-018"],
    what: "switches on the merge guard for watch commands (.claude/settings.json)" },
  { id: "green-gate-settings", kind: "setting", event: "Stop", matcher: null, marker: "green-gate.sh", hookFile: "green-gate.sh",
    needs: ["green-gate"], warnable: true, decisions: ["D-011"],
    what: "switches on \"don't stop until green\" (.claude/settings.json)" },

  { id: "required-checks", kind: "owned", path: ".claude/required-checks.json", template: "templates/required-checks.json", decisions: ["D-018"],
    what: "this project's list of checks a merge must pass (starts empty = \"no CI yet\")" },
  { id: "audit-ledger", kind: "owned", path: "docs/audit-ledger.json", template: "templates/audit-ledger.json", decisions: ["D-018"],
    what: "this project's record of every audit and what it found" },
  { id: "optional-pointers", kind: "owned", path: ".bob-optional-pointers", decisions: ["D-018"],
    what: "files CLAUDE.md may name before they exist (read by the document check)" },
  { id: "bob-pointer", kind: "pointer", path: "CLAUDE.md", decisions: ["D-019"],
    what: "a line in CLAUDE.md (or AGENTS.md) that tells every session this project follows Bob" },
  { id: "open-loops", kind: "optional", path: "docs/open-loops.md", template: "templates/open-loops.md", decisions: ["D-018"],
    what: "optional: the one open-items list, for when several sessions work at once" },
  { id: "deferred-actions", kind: "optional", path: "docs/deferred-actions.md", template: "templates/deferred-actions.md", decisions: ["D-018"],
    what: "optional: the list of everything promised but not yet done" },
  { id: "commit-sweep", kind: "sweep", decisions: ["D-019"],
    what: "the document check that runs on every commit — blocks the commit, or only warns" },
];
const byId = Object.fromEntries(PIECES.map((p) => [p.id, p]));

// ── The project's install record and its list of deliberate differences ─────────────────────────
const MANIFEST = ".bob/installed.json";
let manifest = null;
try { manifest = JSON.parse(read(pj(MANIFEST)) || "null"); } catch { fail(`${MANIFEST} is not valid JSON — fix or delete it (a backup of nothing is lost: it only records what Bob installed).`); }
const hadManifest = !!manifest;

function readDifferences() {
  const out = {};
  const text = (read(pj(".bob/differences.md")) || "").replace(/<!--[\s\S]*?-->/g, "");
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s+`?([A-Za-z0-9_./|-]+)`?\s*(?::|—|–| - )\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const piece = byId[key] || PIECES.find((p) => p.path && p.path === key);
    if (piece) out[piece.id] = m[2].trim();
  }
  return out;
}
const DIFFS = readDifferences();

// ── Settings helpers ─────────────────────────────────────────────────────────────────────────────
function loadSettings(dir) {
  const p = join(dir, ".claude", "settings.json");
  const text = read(p);
  if (text === null) return { obj: {}, exists: false };
  try { return { obj: JSON.parse(text), exists: true }; }
  catch { fail(`${dir === PROJ ? "" : "Bob's "}.claude/settings.json is not valid JSON, so its hooks cannot be compared. Fix it first (nothing was changed).`); }
}
function findEntry(obj, piece) {
  const list = obj?.hooks?.[piece.event];
  if (!Array.isArray(list)) return -1;
  return list.findIndex((e) => (piece.matcher ? e.matcher === piece.matcher : true) &&
    Array.isArray(e.hooks) && e.hooks.some((h) => typeof h.command === "string" && h.command.includes(piece.marker)));
}
const warnCommand = (piece) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/warn-only.mjs" ${piece.hookFile}`;
function refEntry(piece) {
  const { obj } = loadSettings(ref());
  const i = findEntry(obj, piece);
  if (i < 0) fail(`Bob's own scaffold has no ${piece.id} entry — Bob's piece list is out of step with bob-init (a Bob bug).`);
  return obj.hooks[piece.event][i];
}
function entryMode(entry) {
  return entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("warn-only.mjs")) ? "warn" : "enforce";
}
function normalizeEntry(entry, piece) {
  const e = JSON.parse(JSON.stringify(entry));
  const refCmd = refEntry(piece).hooks.find((h) => h.command.includes(piece.marker)).command;
  for (const h of e.hooks || []) if (piece.hookFile && h.command === warnCommand(piece)) h.command = refCmd;
  return e;
}

// ── Bob's version and the project's version of one piece, as comparable text ────────────────────
function bobContent(piece) {
  if (piece.kind === "file") {
    const t = piece.bobPath ? read(join(BOB_ROOT, piece.bobPath)) : read(join(ref(), piece.path));
    if (t === null) fail(`Bob's scaffold has no ${piece.path} — Bob's piece list is out of step with bob-init (a Bob bug).`);
    return t;
  }
  if (piece.kind === "setting") return canon(refEntry(piece));
  return null;
}
function projectContent(piece) {
  if (piece.kind === "file") return read(pj(piece.path));
  if (piece.kind === "setting") {
    const { obj } = loadSettings(PROJ);
    const i = findEntry(obj, piece);
    return i < 0 ? null : canon(normalizeEntry(obj.hooks[piece.event][i], piece));
  }
  return null;
}
const norm = (piece, text) => (piece.normalize ? piece.normalize(text) : text);
const hashOf = (piece, text) => sha(norm(piece, text));

// A file with no install record: does it match an OLDER version of the same file in Bob's history?
function historyMatch(piece, h) {
  if (!piece.source) return null;
  const log = git("log", "--format=%H", "--", piece.source);
  if (!log) return null;
  for (const c of log.trim().split("\n").filter(Boolean)) {
    const old = git("show", `${c}:${piece.source}`);
    if (old !== null && hashOf(piece, old) === h) return c;
  }
  return null;
}
// Which decisions changed a piece between an older Bob commit and now.
function decisionsSince(piece, fromCommit) {
  const paths = [piece.source || piece.bobPath, piece.kind === "setting" || !piece.source ? "scripts/bob-init.sh" : null].filter(Boolean);
  if (!fromCommit || git("cat-file", "-e", `${fromCommit}^{commit}`) === null) return piece.decisions;
  const log = git("log", "--format=%s%n%b", `${fromCommit}..HEAD`, "--", ...paths);
  const found = log ? [...log.matchAll(/\bD-\d{3}\b/g)].map((m) => m[0]) : [];
  return found.length ? found : piece.decisions;
}

// ── The commit-time document check (Bob's coherence sweep) ──────────────────────────────────────
function runSweep() {
  const r = spawnSync("bash", [join(BOB_ROOT, "scripts", "coherence-check.sh"), "docs"], { cwd: PROJ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const problems = (r.stdout + r.stderr).split("\n").filter((l) => /^\s*✗/.test(l)).map((l) => l.trim());
  return { ok: r.status === 0, problems };
}

// ── Status of every piece ────────────────────────────────────────────────────────────────────────
const LABEL = {
  current: "Up to date",
  newer: "Bob has a newer version",
  missing: "Missing — added to Bob since this project was set up",
  removed: "Missing — it was installed once and has been deleted here",
  purpose: "Changed here on purpose (listed in .bob/differences.md) — left alone",
  changed: "Changed here since Bob installed it — reason not written down",
  differs: "Different from Bob's version — no install record, so it can't tell who changed it",
  "owned-present": "Present — this project's own list (Bob never overwrites it)",
  "owned-missing": "Missing — Bob creates an empty one",
  "pointer-present": "Present",
  "pointer-missing": "Missing — CLAUDE.md / AGENTS.md does not mention Bob",
  "optional-present": "Present",
  "optional-absent": "Optional — not installed (only added if you name it)",
  "sweep-block": "On — a commit with hard document problems is blocked",
  "sweep-ready": "Warn-only — the check passes today, so it can safely be switched to blocking",
  "sweep-failing": "Warn-only — the check finds hard problems today; fix them before switching it to blocking",
  "sweep-na": "Not used here (no docs/build-manifest.md)",
};
let settingsWarn = false;
function statusOf(piece, { runChecks = true } = {}) {
  const rec = manifest?.pieces?.[piece.id];
  if (piece.kind === "file" || piece.kind === "setting") {
    const cur = projectContent(piece);
    if (piece.kind === "setting" && cur !== null) {
      const { obj } = loadSettings(PROJ);
      if (entryMode(obj.hooks[piece.event][findEntry(obj, piece)]) === "warn") settingsWarn = true;
    }
    if (piece.onlyIfWarn && cur === null && !settingsWarn) return { status: "hidden" };
    const bob = bobContent(piece);
    if (cur === null) {
      if (DIFFS[piece.id] !== undefined) return { status: "purpose" };
      return { status: rec ? "removed" : "missing", since: null };
    }
    const h = hashOf(piece, cur);
    if (h === hashOf(piece, bob)) return { status: "current" };
    if (DIFFS[piece.id] !== undefined) return { status: "purpose" };
    if (rec && rec.sha256 === h) return { status: "newer", since: rec.bob_commit };
    if (!rec) {
      const c = historyMatch(piece, h);
      return c ? { status: "newer", since: c, inferred: true } : { status: "differs" };
    }
    return { status: "changed" };
  }
  if (piece.kind === "owned") return { status: existsSync(pj(piece.path)) ? "owned-present" : (DIFFS[piece.id] !== undefined ? "purpose" : "owned-missing") };
  if (piece.kind === "optional") return { status: existsSync(pj(piece.path)) ? "optional-present" : "optional-absent" };
  if (piece.kind === "pointer") {
    const text = (read(pj("CLAUDE.md")) || "") + (read(pj("AGENTS.md")) || "");
    if (/build-protocol(-core)?\.md|Bob the Builder|skills\/bob/i.test(text)) return { status: "pointer-present" };
    return { status: DIFFS[piece.id] !== undefined ? "purpose" : "pointer-missing" };
  }
  if (piece.kind === "sweep") {
    if (manifest?.commit_sweep === "block") return { status: "sweep-block" };
    if (!existsSync(pj("docs/build-manifest.md"))) return { status: "sweep-na" };
    if (!runChecks) return { status: "sweep-ready" };
    const s = runSweep();
    return s.ok ? { status: "sweep-ready" } : { status: "sweep-failing", problems: s.problems };
  }
  return { status: "hidden" };
}
// Settings entries first, so the warn-only helper knows whether it is needed.
const ORDER = [...PIECES.filter((p) => p.kind === "setting"), ...PIECES.filter((p) => p.kind !== "setting")];

// ── Applying ─────────────────────────────────────────────────────────────────────────────────────
const SAFE_FOR_ALL = new Set(["newer", "missing", "owned-missing", "pointer-missing"]);
const backupDir = pj(join(".bob", "backups", TODAY));
const changedFiles = [];
function backup(rel) {
  const src = pj(rel);
  if (!existsSync(src)) return;
  const dst = join(backupDir, rel);
  if (existsSync(dst)) return; // keep the first (original) copy of the day
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
function writeProject(rel, text, exec = false) {
  backup(rel);
  mkdirSync(dirname(pj(rel)), { recursive: true });
  writeFileSync(pj(rel), text);
  if (exec) chmodSync(pj(rel), 0o755);
  if (!changedFiles.includes(rel)) changedFiles.push(rel);
}
function ensureManifest() {
  if (!manifest) manifest = { format: FORMAT, first_recorded: TODAY, commit_sweep: "warn", pieces: {} };
  manifest.pieces ||= {};
}
function record(piece, text, mode) {
  ensureManifest();
  manifest.pieces[piece.id] = { path: piece.path || ".claude/settings.json", sha256: hashOf(piece, text), bob_commit: BOB_COMMIT, recorded: TODAY, ...(mode ? { mode } : {}) };
}
function applyFile(piece) {
  let text = bobContent(piece);
  if (piece.normalize) { // keep the project's own customised line (e.g. TEST_CMD)
    const mine = read(pj(piece.path));
    const line = mine && TESTCMD.exec(mine);
    if (line) text = text.replace(TESTCMD, () => line[0]);
  }
  writeProject(piece.path, text, !!piece.exec);
  record(piece, text);
  return "installed Bob's current version";
}
function applySetting(piece, forceMode) {
  const { obj } = loadSettings(PROJ);
  obj.hooks ||= {};
  obj.hooks[piece.event] ||= [];
  const list = obj.hooks[piece.event];
  const i = findEntry(obj, piece);
  const prevMode = i >= 0 ? entryMode(list[i]) : null;
  let mode = forceMode || prevMode || (piece.warnable ? "warn" : "enforce");
  if (!piece.warnable) mode = "enforce";
  const entry = JSON.parse(JSON.stringify(refEntry(piece)));
  if (mode === "warn") for (const h of entry.hooks) if (h.command.includes(piece.marker)) h.command = warnCommand(piece);
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeProject(".claude/settings.json", JSON.stringify(obj, null, 2) + "\n");
  record(piece, canon(refEntry(piece)), mode);
  return mode === "warn" ? "added in WARN-ONLY mode (it says what it would block, blocks nothing)" : (i >= 0 ? "updated" : "added");
}
function applyOwned(piece) {
  if (existsSync(pj(piece.path))) return "already present — left alone";
  let text;
  if (piece.template) text = read(join(BOB_ROOT, piece.template)).replace("{project-name}", basename(PROJ)).replace("{Project Name}", basename(PROJ));
  else text = read(join(ref(), piece.path));
  writeProject(piece.path, text);
  return "created";
}
function applyPointer() {
  const target = existsSync(pj("CLAUDE.md")) ? "CLAUDE.md" : existsSync(pj("AGENTS.md")) ? "AGENTS.md" : "CLAUDE.md";
  const before = read(pj(target)) || `# ${basename(PROJ)}\n`;
  const add = `\n## Build protocol\n\nThis project follows the **Bob the Builder** protocol — load \`~/.claude/skills/bob/../build-protocol-core.md\` at session start. Bob is the one current method; this file holds only facts about this project and its deliberate differences from Bob (listed, with reasons, in \`.bob/differences.md\`). Bring Bob's newer improvements in with \`/bob UPGRADE\`.\n`;
  writeProject(target, before.replace(/\s*$/, "\n") + add);
  return `added a short "Build protocol" section to ${target}`;
}
function applySweep() {
  if (!existsSync(pj("docs/build-manifest.md"))) return "skipped — this project has no docs/build-manifest.md, so the check never runs here";
  const s = runSweep();
  if (!s.ok) return `NOT switched — the check finds ${s.problems.length} hard problem(s) today; fix them first:\n${s.problems.map((p) => `        ${p}`).join("\n")}`;
  ensureManifest();
  manifest.commit_sweep = "block";
  return "switched to blocking: a commit with hard document problems is now stopped";
}

function applyOne(piece, st, { explicit }) {
  if (st.status === "purpose") return `left alone — listed in .bob/differences.md ("${DIFFS[piece.id] || "no reason given"}"). Remove that line first if you want Bob's version.`;
  if (st.status === "current" || st.status === "owned-present" || st.status === "pointer-present" || st.status === "optional-present" || st.status === "sweep-block") return "already up to date";
  if (!explicit && !SAFE_FOR_ALL.has(st.status)) return null;
  for (const dep of piece.needs || []) {
    const d = byId[dep];
    const ds = statusOf(d, { runChecks: false });
    if (["missing", "removed", "newer", "owned-missing"].includes(ds.status)) {
      const res = d.kind === "owned" ? applyOwned(d) : applyFile(d);
      console.log(`  ${d.id}: ${res} (needed by ${piece.id})`);
    }
  }
  if (piece.kind === "file") return applyFile(piece);
  if (piece.kind === "setting") {
    const res = applySetting(piece);
    if (res.includes("WARN-ONLY")) {
      const helper = byId["warn-only-helper"];
      if (projectContent(helper) === null || hashOf(helper, projectContent(helper)) !== hashOf(helper, bobContent(helper))) console.log(`  warn-only-helper: ${applyFile(helper)} (needed by ${piece.id})`);
    }
    return res;
  }
  if (piece.kind === "owned" || piece.kind === "optional") return applyOwned(piece);
  if (piece.kind === "pointer") return applyPointer();
  if (piece.kind === "sweep") return applySweep();
  return null;
}

function enforceOne(id) {
  const piece = byId[id];
  if (!piece) return `unknown item "${id}"`;
  if (piece.kind === "sweep") return applySweep();
  if (piece.kind !== "setting") return `${id} is not a hook switch — nothing to enforce`;
  const { obj } = loadSettings(PROJ);
  const i = findEntry(obj, piece);
  if (i < 0) return `${id} is not installed — apply it first`;
  if (entryMode(obj.hooks[piece.event][i]) !== "warn") return `${id} already blocks`;
  return applySetting(piece, "enforce").replace("updated", "switched to blocking");
}

function saveManifest() {
  ensureManifest();
  // Anything that already matches Bob and has no record gets one, so the next upgrade can tell
  // "Bob changed it" from "this project changed it".
  for (const p of PIECES) {
    if ((p.kind !== "file" && p.kind !== "setting") || manifest.pieces[p.id]) continue;
    const cur = projectContent(p);
    if (cur !== null && !(p.onlyIfWarn && !settingsWarn) && hashOf(p, cur) === hashOf(p, bobContent(p))) {
      let mode;
      if (p.kind === "setting") { const { obj } = loadSettings(PROJ); mode = entryMode(obj.hooks[p.event][findEntry(obj, p)]); }
      record(p, cur, mode);
    }
  }
  manifest.format = FORMAT;
  manifest.note = "Written by Bob (bob-init / bob-upgrade). Records which Bob pieces this project has and from which Bob commit, so /bob UPGRADE can tell Bob's changes from this project's. Deliberate differences go in .bob/differences.md, not here.";
  manifest.bob_commit = BOB_COMMIT;
  manifest.bob_version = BOB_VERSION;
  manifest.last_upgrade = TODAY;
  const ordered = { format: manifest.format, note: manifest.note, bob_version: manifest.bob_version, bob_commit: manifest.bob_commit,
    first_recorded: manifest.first_recorded || TODAY, last_upgrade: manifest.last_upgrade, commit_sweep: manifest.commit_sweep || "warn", pieces: manifest.pieces };
  mkdirSync(pj(".bob"), { recursive: true });
  writeFileSync(pj(MANIFEST), JSON.stringify(ordered, null, 2) + "\n");
  if (!existsSync(pj(".bob/differences.md"))) writeFileSync(pj(".bob/differences.md"), read(join(BOB_ROOT, "templates", "bob-differences.md")));
  if (!existsSync(pj(".bob/.gitignore"))) writeFileSync(pj(".bob/.gitignore"), "# Bob's backups of files it replaced during /bob UPGRADE — local only.\nbackups/\n");
}

// ── Modes ────────────────────────────────────────────────────────────────────────────────────────
if (opt.record) {
  // bob-init just wrote the scaffold: record every piece that matches Bob's current version.
  ensureManifest();
  // A brand-new project starts with the commit-time check blocking. A project that already has
  // documents (bob-init re-run on it) blocks only if the check passes today; otherwise it warns.
  if (!hadManifest) manifest.commit_sweep = !existsSync(pj("docs/build-manifest.md")) || runSweep().ok ? "block" : "warn";
  for (const p of ORDER) statusOf(p, { runChecks: false });
  saveManifest();
  console.log(`📌 Recorded what Bob installed (Bob ${BOB_VERSION}, commit ${short(BOB_COMMIT)}) in ${MANIFEST}; deliberate differences go in .bob/differences.md.`);
  process.exit(0);
}

const statuses = {};
for (const p of ORDER) statuses[p.id] = statusOf(p);

if (opt.enforce) {
  console.log(`Switching to blocking in ${PROJ}:`);
  for (const id of opt.enforce) console.log(`  ${id}: ${enforceOne(id)}`);
  saveManifest();
  process.exit(0);
}

async function chooseInteractively() {
  if (!process.stdin.isTTY) fail("--interactive needs a terminal. Use --apply <items> instead (names are in the report).");
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const picked = [];
  for (const p of PIECES) {
    const st = statuses[p.id];
    if (!["newer", "missing", "removed", "changed", "differs", "owned-missing", "pointer-missing", "sweep-ready", "optional-absent"].includes(st.status)) continue;
    const ans = await rl.question(`${p.id} — ${LABEL[st.status]}. ${p.what}. Apply? [y/N] `);
    if (/^y/i.test(ans.trim())) picked.push(p.id);
  }
  rl.close();
  return picked;
}

if (opt.apply || opt.interactive) {
  const names = opt.interactive ? await chooseInteractively() : opt.apply;
  const all = names.includes("all");
  const unknown = names.filter((n) => n !== "all" && !byId[n]);
  if (unknown.length) fail(`unknown item(s): ${unknown.join(", ")}. Item names are in square brackets in the report.`);
  console.log(`Applying Bob ${BOB_VERSION} (commit ${short(BOB_COMMIT)}) to ${PROJ}:`);
  let n = 0;
  for (const p of ORDER) {
    const explicit = names.includes(p.id);
    if (!explicit && !all) continue;
    if (all && !explicit && (p.kind === "optional" || p.kind === "sweep" || p.onlyIfWarn)) continue;
    const res = applyOne(p, statusOf(p, { runChecks: false }), { explicit });
    if (res) { console.log(`  ${p.id}: ${res}`); n++; }
  }
  saveManifest();
  if (!n) console.log("  nothing to apply.");
  if (changedFiles.length) {
    console.log(`\nFiles changed: ${changedFiles.join(", ")}`);
    if (existsSync(backupDir)) console.log(`Backups of the previous copies: ${join(".bob", "backups", TODAY)}/`);
  }
  console.log(`Install record updated: ${MANIFEST}. Commit these changes like any other change.`);
  if (PIECES.some((p) => p.kind === "setting" && manifest.pieces?.[p.id]?.mode === "warn")) {
    console.log(`\nWarn-only hooks: ${PIECES.filter((p) => manifest.pieces?.[p.id]?.mode === "warn").map((p) => p.id).join(", ")}.`);
    console.log(`  Once you have seen them behave, make them block: ${CMD} --enforce <item>`);
  }
  process.exit(0);
}

// ── Report (default) ─────────────────────────────────────────────────────────────────────────────
console.log("════════════════════════════════════════════════════════════════");
console.log(` BOB UPGRADE CHECK — ${basename(PROJ)}`);
console.log("════════════════════════════════════════════════════════════════");
console.log(`Bob available here: ${BOB_VERSION} (commit ${short(BOB_COMMIT)}).`);
if (hadManifest) console.log(`This project's install record (${MANIFEST}): last brought up to date from Bob commit ${short(manifest.bob_commit)} on ${manifest.last_upgrade || manifest.first_recorded || "?"}.`);
else console.log(`This project has no install record (${MANIFEST}), so each file was compared with Bob's current and past versions.`);
const reasonless = Object.entries(DIFFS).filter(([, r]) => !r).map(([id]) => id);
if (reasonless.length) console.log(`⚠ .bob/differences.md lists ${reasonless.join(", ")} with no reason — add one line saying why.`);

const GROUPS = ["newer", "missing", "removed", "owned-missing", "pointer-missing", "changed", "differs", "purpose", "sweep-failing", "sweep-ready", "sweep-block", "optional-absent", "current", "owned-present", "pointer-present", "optional-present", "sweep-na"];
const QUIET = new Set(["current", "owned-present", "pointer-present", "optional-present", "sweep-na"]);
for (const g of GROUPS) {
  const items = PIECES.filter((p) => statuses[p.id].status === g);
  if (!items.length) continue;
  console.log(`\n${LABEL[g]} (${items.length})`);
  if (QUIET.has(g)) { console.log(`  ${items.map((p) => p.id).join(", ")}`); continue; }
  for (const p of items) {
    const st = statuses[p.id];
    console.log(`  [${p.id}] ${p.path ? p.path + " — " : ""}${p.what}`);
    if (g === "newer") {
      console.log(`      Why Bob changed it: ${explain(decisionsSince(p, st.since))}`);
      if (st.inferred) console.log(`      (matches Bob's copy from commit ${short(st.since)})`);
    } else if (g === "missing" || g === "owned-missing" || g === "pointer-missing" || g === "removed") {
      console.log(`      Why Bob has it: ${explain(p.decisions)}`);
      if (p.kind === "setting") console.log(p.warnable ? "      Goes in WARN-ONLY first: it says what it would have blocked and blocks nothing, until you switch it with --enforce." : "      The merge guard has no warn-only mode (no off switch, D-018); with an empty .claude/required-checks.json it only prints a notice until you name your CI checks.");
      if (g === "removed") console.log(`      If it was removed on purpose, add a line to .bob/differences.md: - ${p.id}: <why>`);
    } else if (g === "changed" || g === "differs") {
      console.log(`      Keep yours: add a line to .bob/differences.md — "- ${p.id}: <why>". Take Bob's: --apply ${p.id} (your copy is backed up first).`);
    } else if (g === "purpose") {
      console.log(`      Reason recorded: ${DIFFS[p.id] || "(none — add one)"}`);
    } else if (g === "sweep-failing") {
      for (const pr of st.problems.slice(0, 12)) console.log(`      ${pr}`);
      console.log(`      Until these are fixed the commit check only warns. Then: --enforce commit-sweep`);
    } else if (g === "sweep-ready") {
      console.log(`      Switch it on: --apply commit-sweep`);
    }
  }
}
if (CITED.size) {
  console.log("\nBob's reasons (decision-log.md in Bob — each entry says what went wrong without it)");
  for (const d of [...CITED].sort()) console.log(`  ${d} — ${DECISIONS[d] || "see decision-log.md"}`);
}
const actionable = PIECES.filter((p) => SAFE_FOR_ALL.has(statuses[p.id].status));
console.log("\nWhat to do next");
if (actionable.length) {
  console.log(`  Apply every safe update (${actionable.map((p) => p.id).join(", ")}):`);
  console.log(`    ${CMD} --apply all`);
} else console.log("  Nothing is out of date that Bob can update safely.");
console.log(`  Apply only some:         ${CMD} --apply <item>,<item>`);
console.log(`  Decide one at a time:    ${CMD} --interactive`);
console.log("  Items marked \"changed here\" and anything optional are never touched unless you name them.");

console.log("\nDoes this project do something better than Bob?");
console.log("  If a rule, check, hook or file here works better than Bob's version, bring it back to Bob so every project gets it:");
console.log("  1. Write it in general terms — no project names, numbers or internals (Bob is public).");
console.log("  2. Add an entry to Bob's decision-log.md (next D-number): what it replaces and why, with the failure it prevents.");
console.log("  3. Change Bob, then run /bob UPGRADE here so this project matches Bob again — and drop its line from .bob/differences.md.");
const purposeful = Object.keys(DIFFS);
if (purposeful.length) console.log(`  First candidates — this project's recorded differences: ${purposeful.join(", ")}.`);
process.exit(0);
