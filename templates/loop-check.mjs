#!/usr/bin/env node
// loop-check.mjs — the daily dropped-work check (Bob D-018). Copied by bob-init to scripts/loop-check.mjs and run
// once a day by .github/workflows/loop-check.yml (template: templates/loop-check.yml). Read-only. Needs Node 18+ and,
// for the GitHub checks, the `gh` command (preinstalled on GitHub's runners).
//
// Adapted by Joe Wang (MIT, as the rest of Bob) from the daily loop check he wrote for one of his own private
// projects. The stale-PR rules (72 hours, a dated hold label, a malformed or far-off hold exempts nothing) are kept
// as written there; the project-specific checks were dropped, and the open-loops, intake-cap, scheduled-job and
// heartbeat checks were generalised from that project's coordination rules.
//
// WHY. In the source project a plan sat in an open pull request for more than a week and its findings never reached the
// roadmap; nobody noticed, because noticing depended on a session that happened to be running. Two rulings came out
// of it: a diagnosis is done only when every finding has a home, and coordination must not depend on any one session
// staying alive. This is the mechanical half — it runs whether or not anyone is working.
//
// WHAT IT FLAGS:
//   1. STALE PULL REQUESTS — open and not updated for more than 72 hours, unless labelled `hold-until:YYYY-MM-DD` with a
//      date that has not passed. "HOLD" in the title does not count (it has no date, so it can hold forever). A hold
//      label that is not a real date, or is more than 60 days out, exempts nothing and is named.
//   2. FINDINGS WITH NOWHERE TO GO — the open-loops list (templates/open-loops.md; default docs/open-loops.md):
//      an open/waiting row with no owner, no next action or no due date; a row past its due date; a closed row with no
//      closing proof; a status word other than open / waiting / closed; a duplicate row ID; a row over 600 bytes.
//   3. AN INTAKE LIST OVER ITS CAP — more open rows in the intake list (default docs/deferred-actions.md) than its cap.
//   4. A SCHEDULED JOB FAILING OR SILENT — for every workflow with a `schedule:` trigger: its last two finished runs both
//      failed, or it has not run at all for longer than its silence limit. A silent run is itself a finding.
//      Known blind spot, stated: a step marked `continue-on-error: true` or ending `|| true` reports success even when
//      it failed, so its job looks green here. Such workflows are named as a warning; record the real exit code
//      (`… || echo "tolerated_rc=$?" >> "$GITHUB_OUTPUT"`) instead of swallowing it.
//   5. A MISSING HEARTBEAT — for unattended jobs that run on a machine rather than on GitHub: each heartbeat file
//      listed in the config must have been written within its max age (templates/scheduled-work-protocol.md §7).
//
// CONFIG (optional) — .github/loop-check.json:
//   { "stale_hours": 72, "max_hold_days": 60, "open_loops": "docs/open-loops.md", "row_bytes": 600,
//     "intake": { "file": "docs/deferred-actions.md", "cap": 150 },
//     "watch": { "nightly.yml": { "max_silence_hours": 50 } },
//     "heartbeats": [ { "path": "logs/heartbeat-nightly.txt", "max_age_hours": 30 } ] }
// Silence limits default from the cron line: hourly-ish → 6 h, daily → 50 h, weekly/monthly → 8 days + 2 h.
//
// EXIT: 0 = nothing flagged · 1 = something flagged (on GitHub a failed scheduled run emails the workflow's owner —
// that email IS the alarm) · 2 = the check itself could not run. `--report-only` exits 0 when flagged.
// TESTING: --now ISO · --prs-file gh-pr-list.json · --runs-file {"file.yml": [runs]} · --root DIR (no network then).

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const HOLD_LABEL_RE = /^hold-until:(\d{4}-\d{2}-\d{2})$/;
const STATUS_WORDS = ["open", "waiting", "closed"];
const DAY_MS = 86_400_000;

function args(argv) {
  const o = { now: null, prsFile: null, runsFile: null, root: process.cwd(), reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--now") o.now = argv[++i];
    else if (a === "--prs-file") o.prsFile = argv[++i];
    else if (a === "--runs-file") o.runsFile = argv[++i];
    else if (a === "--root") o.root = resolve(argv[++i]);
    else if (a === "--report-only") o.reportOnly = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

function checkNow(raw) {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`--now is not an ISO instant: "${raw}"`);
  return d;
}

// ── 1. Stale pull requests ─────────────────────────────────────────────────────────────────────────────────────

/** The hold date a PR's labels grant — the latest valid one; malformed `hold-until:` labels grant nothing. */
function holdOf(labels) {
  let until = null;
  const malformed = [];
  for (const { name } of labels) {
    if (!String(name).startsWith("hold-until:")) continue;
    const m = HOLD_LABEL_RE.exec(name);
    const d = m ? new Date(`${m[1]}T00:00:00Z`) : null;
    if (!m || !d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1]) { malformed.push(name); continue; }
    if (until == null || m[1] > until) until = m[1];
  }
  return { until, malformed };
}

function stalePrs(prs, now, staleHours, maxHoldDays) {
  const today = now.toISOString().slice(0, 10);
  const maxHold = new Date(now.getTime() + maxHoldDays * DAY_MS).toISOString().slice(0, 10);
  const flagged = [];
  const held = [];
  for (const pr of prs) {
    const labels = Array.isArray(pr.labels) ? pr.labels : [];
    const { until, malformed } = holdOf(labels);
    const inForce = until != null && until >= today && until <= maxHold;
    if (inForce) held.push(`#${pr.number} held until ${until}: ${pr.title}`);
    const updated = Date.parse(pr.updatedAt);
    if (!Number.isFinite(updated)) { flagged.push(`#${pr.number} ${pr.title} — unreadable last-update time "${pr.updatedAt}"`); continue; }
    const hours = (now.getTime() - updated) / 3_600_000;
    if (hours <= staleHours || inForce) continue;
    const notes = [];
    if (until != null && until < today) notes.push(`its hold ran out on ${until}`);
    if (until != null && until > maxHold) notes.push(`hold too far out: ${until} is more than ${maxHoldDays} days away`);
    if (malformed.length) notes.push(`label ${malformed.map((l) => `"${l}"`).join(", ")} is not a valid hold-until:YYYY-MM-DD date`);
    flagged.push(`#${pr.number} ${pr.title} — not updated for ${(hours / 24).toFixed(1)} days${pr.isDraft ? " (draft)" : ""}${notes.length ? `; ${notes.join("; ")}` : ""}`);
  }
  return { flagged, held };
}

// ── 2/3. The open-loops list and the intake cap (markdown tables) ─────────────────────────────────────────────────

/** Rows of every markdown table in a file whose header has the named columns: [{cells: {col: value}, raw, line}]. */
function tableRows(text) {
  const rows = [];
  let header = null;
  text.split("\n").forEach((line, n) => {
    if (!/^\s*\|/.test(line)) { header = null; return; }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // the separator row
    if (!header) { header = cells.map((c) => c.toLowerCase().replace(/[*_`]/g, "")); return; }
    const obj = {};
    header.forEach((h, k) => { obj[h] = cells[k] ?? ""; });
    rows.push({ cells: obj, raw: line, line: n + 1 });
  });
  return rows;
}

const col = (cells, ...names) => {
  for (const n of names) for (const k of Object.keys(cells)) if (k === n || k.startsWith(n)) return cells[k];
  return undefined;
};
const plain = (s) => String(s ?? "").replace(/~~/g, "").replace(/[*_`]/g, "").trim();
const EMPTY = /^(|-|—|–|tbd|\?|n\/a|none)$/i;

function checkOpenLoops(text, file, now, rowBytes) {
  const flagged = [];
  const rows = tableRows(text).filter((r) => col(r.cells, "id") !== undefined && col(r.cells, "status") !== undefined);
  if (!rows.length) return { flagged: [`${file}: no table with ID and Status columns — the list cannot be checked`], open: 0 };
  const today = now.toISOString().slice(0, 10);
  const seen = new Map();
  let open = 0;
  for (const r of rows) {
    const id = plain(col(r.cells, "id"));
    const where = `${file}:${r.line} ${id || "(no id)"}`;
    if (!id) flagged.push(`${where}: the row has no ID`);
    else if (seen.has(id)) flagged.push(`${where}: duplicate ID (also on line ${seen.get(id)})`);
    else seen.set(id, r.line);
    const bytes = Buffer.byteLength(r.raw, "utf8");
    if (bytes > rowBytes) flagged.push(`${where}: row is ${bytes} bytes (limit ${rowBytes}) — move the detail to a linked note and keep the row to one line`);
    const status = plain(col(r.cells, "status")).toLowerCase();
    if (!STATUS_WORDS.includes(status)) { flagged.push(`${where}: status "${status}" — use exactly one of ${STATUS_WORDS.join(" / ")}`); continue; }
    if (status === "closed") {
      const proof = plain(col(r.cells, "closing proof", "proof", "receipt"));
      if (EMPTY.test(proof) || /^(done|fixed|ok|yes|complete[d]?)$/i.test(proof)) flagged.push(`${where}: closed with no closing proof (a PR, commit, run or row — "done" is not proof)`);
      continue;
    }
    open++;
    for (const [label, names] of [["owner", ["owner"]], ["next action", ["next action", "next"]], ["due date", ["due"]]]) {
      if (EMPTY.test(plain(col(r.cells, ...names)))) flagged.push(`${where}: ${status} with no ${label} — a finding with nowhere to go`);
    }
    const due = plain(col(r.cells, "due"));
    if (/^\d{4}-\d{2}-\d{2}$/.test(due) && due < today) flagged.push(`${where}: past its due date (${due})`);
    else if (due && !EMPTY.test(due) && !/^\d{4}-\d{2}-\d{2}$/.test(due)) flagged.push(`${where}: due "${due}" is not a YYYY-MM-DD date`);
  }
  return { flagged, open };
}

function countOpenIntake(text) {
  return tableRows(text).filter((r) => /^open\b/i.test(plain(col(r.cells, "status")))).length;
}

// ── 4. Scheduled jobs ───────────────────────────────────────────────────────────────────────────────────────────

/** Default silence limit (hours) from a cron line: minute hour day-of-month month day-of-week. */
function silenceFromCron(cron) {
  const f = cron.trim().split(/\s+/);
  if (f.length < 5) return 50;
  const [, hour, dom, , dow] = f;
  if (dom !== "*" || dow !== "*") return 8 * 24 + 2; // weekly or monthly
  if (hour === "*" || hour.includes("/") || hour.includes(",")) return 6; // several times a day
  return 50; // daily
}

function scheduledWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((file) => {
    const text = readText(join(dir, file)) ?? "";
    const crons = [...text.matchAll(/^\s*-\s*cron:\s*["']?([^"'\n]+)["']?/gm)].map((m) => m[1]);
    const swallows = /continue-on-error:\s*true|\|\|\s*true\b/.test(text);
    return { file, crons, swallows };
  }).filter((w) => w.crons.length);
}

function checkWorkflow(w, runs, now, overrideHours) {
  const flagged = [];
  const limit = overrideHours ?? Math.min(...w.crons.map(silenceFromCron));
  const finished = runs.filter((r) => r.status === "completed");
  const newest = runs.map((r) => Date.parse(r.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (newest == null) flagged.push(`${w.file}: no run on record — a scheduled job that has never run is silent, not fine`);
  else {
    const hours = (now.getTime() - newest) / 3_600_000;
    if (hours > limit) flagged.push(`${w.file}: silent — the last run started ${(hours / 24).toFixed(1)} days ago (limit ${limit} hours)`);
  }
  const lastTwo = finished.slice(0, 2);
  if (lastTwo.length === 2 && lastTwo.every((r) => r.conclusion !== "success" && r.conclusion !== "skipped")) {
    flagged.push(`${w.file}: the last two finished runs both ended "${lastTwo.map((r) => r.conclusion).join('", "')}"`);
  }
  return flagged;
}

// ── 5. Heartbeats ───────────────────────────────────────────────────────────────────────────────────────────────

function checkHeartbeat(hb, root, now) {
  const p = resolve(root, hb.path.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (!existsSync(p)) {
    return process.env.GITHUB_ACTIONS === "true" && !p.startsWith(root)
      ? { warn: `heartbeat ${hb.path}: not visible from GitHub's runner — run this check on the machine that writes it` }
      : { flag: `heartbeat ${hb.path}: missing — the job it belongs to has never reported` };
  }
  const hours = (now.getTime() - statSync(p).mtimeMs) / 3_600_000;
  const max = hb.max_age_hours ?? 30;
  return hours > max ? { flag: `heartbeat ${hb.path}: last written ${(hours / 24).toFixed(1)} days ago (limit ${max} hours) — a silent run is a finding` } : {};
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────

function gh(argsList) {
  return execFileSync("gh", argsList, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  const o = args(process.argv.slice(2));
  const now = checkNow(o.now);
  const root = o.root;
  const cfg = JSON.parse(readText(join(root, ".github", "loop-check.json")) ?? "{}");
  const staleHours = cfg.stale_hours ?? 72;
  const maxHoldDays = cfg.max_hold_days ?? 60;
  const sections = [];
  const warnings = [];
  let flaggedCount = 0;
  const section = (title, items) => { flaggedCount += items.length; sections.push({ title, items }); };

  // 1. stale PRs
  let prs = null;
  try {
    prs = o.prsFile ? JSON.parse(readFileSync(o.prsFile, "utf8"))
      : JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,updatedAt,isDraft,labels"]));
  } catch (e) {
    section("Pull requests", [`could not list open pull requests (${String(e.stderr || e.message).split("\n")[0]}) — the stale check did not run`]);
  }
  if (prs) {
    const { flagged, held } = stalePrs(prs, now, staleHours, maxHoldDays);
    section(`Pull requests open more than ${staleHours} hours with no dated hold`, flagged);
    if (held.length) warnings.push(...held.map((h) => `on hold: ${h}`));
  }

  // 2. open loops
  const loopsFile = cfg.open_loops ?? "docs/open-loops.md";
  const loopsText = readText(join(root, loopsFile));
  if (loopsText != null) section(`Open loops (${loopsFile})`, checkOpenLoops(loopsText, loopsFile, now, cfg.row_bytes ?? 600).flagged);

  // 3. intake cap
  const intake = { file: "docs/deferred-actions.md", cap: 150, ...(cfg.intake ?? {}) };
  const intakeText = readText(join(root, intake.file));
  if (intakeText != null) {
    const n = countOpenIntake(intakeText);
    section(`Intake list (${intake.file})`, n > intake.cap ? [`${n} open rows, over the cap of ${intake.cap} — archive closed rows; a new row must close, merge or park another`] : []);
  }

  // 4. scheduled jobs (this check's own workflow excluded: a failing run of it is already the alarm)
  const runsFixture = o.runsFile ? JSON.parse(readFileSync(o.runsFile, "utf8")) : null;
  const jobItems = [];
  for (const w of scheduledWorkflows(root).filter((x) => !/^loop-check\.ya?ml$/.test(x.file))) {
    if (w.swallows) warnings.push(`${w.file} swallows failures (continue-on-error / || true) — a failing step there can show as green here`);
    let runs;
    try {
      runs = runsFixture ? (runsFixture[w.file] ?? [])
        : JSON.parse(gh(["run", "list", "--workflow", w.file, "--limit", "5", "--json", "status,conclusion,createdAt,event"]));
    } catch (e) {
      jobItems.push(`${w.file}: could not read its runs (${String(e.stderr || e.message).split("\n")[0]})`);
      continue;
    }
    jobItems.push(...checkWorkflow(w, runs, now, cfg.watch?.[w.file]?.max_silence_hours));
  }
  section("Scheduled jobs failing or silent", jobItems);

  // 5. heartbeats
  const hbItems = [];
  for (const hb of cfg.heartbeats ?? []) {
    const r = checkHeartbeat(hb, root, now);
    if (r.flag) hbItems.push(r.flag);
    if (r.warn) warnings.push(r.warn);
  }
  if ((cfg.heartbeats ?? []).length) section("Heartbeats", hbItems);

  const lines = [`# Daily loop check — ${now.toISOString().slice(0, 16)}Z`, "", flaggedCount ? `**${flaggedCount} item(s) flagged.**` : "**Nothing flagged.**", ""];
  for (const s of sections) {
    lines.push(`## ${s.title}: ${s.items.length ? s.items.length : "OK"}`);
    for (const i of s.items) lines.push(`- ${i}`);
    lines.push("");
  }
  if (warnings.length) { lines.push("## Notes"); for (const w of warnings) lines.push(`- ${w}`); }
  const report = lines.join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  process.exit(flaggedCount && !o.reportOnly ? 1 : 0);
}

try { main(); } catch (e) {
  console.error(`loop-check could not run: ${e.stack ?? e}`);
  process.exit(2);
}
