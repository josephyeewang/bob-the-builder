#!/usr/bin/env node
// audit-ledger-check.mjs — checks a project's audit-ledger.json and counts clean-audit streaks (Rule 30(d), D-018).
//
// Adapted by Joe Wang (MIT, as the rest of Bob) from a format test and a streak script he wrote for one of his own
// private projects. The checks, the streak walk and its stop rules are kept; the project's own vocabulary and test
// runner were removed so this runs with bare `node` in any project.
//
// WHY. Rule 30(d) says: five consecutive Tier-1 audits with zero Material findings on the same class of work →
// propose demoting that class to Tier 2. In the source project that rule could not be computed for weeks: most
// entries had no class of work, every class was unique free text, and the Material count was spread over three
// differently named fields. A rule nobody can compute is a wish. This makes it computable — it never demotes
// anything itself (D-005: the loop surfaces, the human decides).
//
// FORMAT CHECK (always): every entry carries every field in format.required_fields; tier is 1/2/3; class_of_work is
// one value of the fixed vocabulary (3–12 values, "mixed" present); the counts are whole numbers ≥ 0;
// material_remaining ≤ material_found; `ran` is YYYY-MM-DD; no old count field names ("material", "material_findings").
// A NEW entry (index ≥ format.legacy_entry_count) may not leave tier, class or counts null. A migrated (legacy) entry
// may, but only when its `unrecorded` list names exactly the null fields — so a gap is declared, never silent.
// STREAKS (--streaks): per class, newest first; skip Tier 2/3 and rounds = 0; a clean Tier-1 entry extends; anything
// else (Material found, tier or count unrecorded) stops. Five → "propose Tier 2".
//
// Usage:  node audit-ledger-check.mjs [docs/audit-ledger.json] [--streaks]
// Exit:   0 = format OK · 1 = format problems (each printed) · 2 = file missing or not JSON.

import { readFileSync } from "node:fs";

const DEMOTION_THRESHOLD = 5;
const OLD_FIELDS = ["material", "material_findings"];
const NULLABLE = ["tier", "class_of_work", "material_found", "material_remaining", "minor", "cosmetic"];
const COUNTS = ["material_found", "material_remaining", "minor", "cosmetic"];

function vocabularyProblems(ledger) {
  const p = [];
  const fmt = ledger?.format;
  if (!fmt || typeof fmt !== "object") return ["no `format` block"];
  if (!Array.isArray(fmt.required_fields) || !fmt.required_fields.length) p.push("format.required_fields is missing or empty");
  const vocab = fmt.class_of_work_vocabulary;
  if (!vocab || typeof vocab !== "object") p.push("format.class_of_work_vocabulary is missing");
  else {
    const n = Object.keys(vocab).length;
    if (n < 3 || n > 12) p.push(`the class_of_work vocabulary has ${n} values; keep it between 3 and 12`);
    if (!("mixed" in vocab)) p.push('the class_of_work vocabulary has no "mixed" value');
  }
  if (!Number.isInteger(fmt.legacy_entry_count) || fmt.legacy_entry_count < 0) p.push("format.legacy_entry_count must be a whole number (0 for a new ledger)");
  if (!Array.isArray(ledger.entries)) p.push("no `entries` list");
  return p;
}

/** The problems with one entry; `legacy` entries may use null when `unrecorded` names exactly those fields. */
function entryProblems(e, ledger, legacy) {
  const p = [];
  const vocab = Object.keys(ledger.format.class_of_work_vocabulary ?? {});
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["not an object"];
  for (const f of ledger.format.required_fields ?? []) if (!(f in e)) p.push(`missing ${f}`);
  for (const old of OLD_FIELDS) if (old in e) p.push(`old field name "${old}" — use material_found / material_remaining`);
  if (e.tier != null && ![1, 2, 3].includes(e.tier)) p.push(`tier ${String(e.tier)} (must be 1, 2 or 3)`);
  if (e.class_of_work != null && !vocab.includes(e.class_of_work)) p.push(`class_of_work "${String(e.class_of_work)}" is not in the vocabulary`);
  for (const f of COUNTS) {
    const v = e[f];
    if (v != null && !(Number.isInteger(v) && v >= 0)) p.push(`${f} ${JSON.stringify(v)} (must be a whole number ≥ 0)`);
  }
  if (Number.isInteger(e.material_found) && Number.isInteger(e.material_remaining) && e.material_remaining > e.material_found) {
    p.push("material_remaining > material_found");
  }
  if (e.rounds != null && !(Number.isInteger(e.rounds) && e.rounds >= 0)) p.push(`rounds ${JSON.stringify(e.rounds)}`);
  const nulls = NULLABLE.filter((f) => f in e && e[f] === null);
  if (!legacy && nulls.length) p.push(`new entry has null ${nulls.join(", ")} (only migrated entries may)`);
  const unrec = Array.isArray(e.unrecorded) ? e.unrecorded : [];
  if (legacy && [...unrec].sort().join() !== [...nulls].sort().join()) p.push(`unrecorded [${unrec}] does not match the null fields [${nulls}]`);
  if (typeof e.ran !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.ran) || Number.isNaN(Date.parse(e.ran))) p.push(`ran ${JSON.stringify(e.ran)} (must be YYYY-MM-DD)`);
  if (typeof e.audit !== "string" || !e.audit.trim()) p.push("audit is empty");
  return p;
}

const decisionNumber = (d) => {
  const m = /^D-(\d+)$/.exec(d ?? "");
  return m ? Number(m[1]) : Number.NEGATIVE_INFINITY;
};

/** Oldest → newest: by ran date, then decision number, then position in the file. */
function chronological(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.ran ?? "").localeCompare(b.e.ran ?? "") || decisionNumber(a.e.at_decision) - decisionNumber(b.e.at_decision) || a.i - b.i)
    .map(({ e }) => e);
}

function computeStreaks(ledger) {
  const ordered = chronological(ledger.entries).reverse();
  return Object.keys(ledger.format.class_of_work_vocabulary)
    .filter((c) => c !== "mixed")
    .map((classOfWork) => {
      let streak = 0;
      let stoppedBy = null;
      for (const e of ordered) {
        if (e.class_of_work !== classOfWork) continue;
        if (e.tier === 2 || e.tier === 3) continue; // not a Tier-1 audit
        if (e.rounds === 0) continue; // no audit ran
        if (e.tier === 1 && e.material_found === 0) { streak += 1; continue; }
        const why = e.tier == null ? "tier unrecorded" : e.material_found == null ? "Material count unrecorded" : `${e.material_found} Material`;
        stoppedBy = `${e.audit ?? "(unnamed)"} (${e.ran ?? "no date"}): ${why}`;
        break;
      }
      return { classOfWork, streak, stoppedBy, proposeDemotion: streak >= DEMOTION_THRESHOLD };
    });
}

function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--")) ?? "docs/audit-ledger.json";
  let ledger;
  try { ledger = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) {
    console.error(`audit-ledger-check: cannot read ${path} as JSON (${e.code ?? e.message}). A gate cannot block on a ledger that does not exist — create it from templates/audit-ledger.json.`);
    process.exit(2);
  }
  const top = vocabularyProblems(ledger);
  if (top.length) {
    for (const t of top) console.log(`  ✗ ${t}`);
    console.log(`audit-ledger-check: FAIL (${top.length})`);
    process.exit(1);
  }
  const legacyCount = ledger.format.legacy_entry_count;
  const bad = [];
  ledger.entries.forEach((e, i) => {
    const p = entryProblems(e, ledger, i < legacyCount);
    if (p.length) bad.push(`#${i} ${String(e?.audit ?? "").slice(0, 60)}: ${p.join("; ")}`);
  });
  console.log(`audit ledger: ${path} — ${ledger.entries.length} entr${ledger.entries.length === 1 ? "y" : "ies"}, ${bad.length} with problems`);
  for (const b of bad) console.log(`  ✗ ${b}`);
  if (args.includes("--streaks")) {
    console.log(`clean Tier-1 streaks (newest first; ${DEMOTION_THRESHOLD} in a row → propose Tier 2, never applied automatically):`);
    for (const s of computeStreaks(ledger)) {
      const flag = s.proposeDemotion ? "  → propose Tier 2" : "";
      console.log(`  ${s.classOfWork.padEnd(18)} ${String(s.streak).padStart(2)}${flag}${s.stoppedBy ? `   stopped by: ${s.stoppedBy}` : ""}`);
    }
  }
  if (bad.length) { console.log(`audit-ledger-check: FAIL (${bad.length})`); process.exit(1); }
  console.log("audit-ledger-check: OK");
}

// Called unconditionally (see doc-pointers-check.mjs for why there is no "am I the main module?" test).
main();
