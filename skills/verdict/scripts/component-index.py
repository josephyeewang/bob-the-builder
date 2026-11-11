#!/usr/bin/env python3
"""Generate component recall and pending opportunities from existing tool sidecars.

Search is literal, case-insensitive, AND across whitespace-separated query terms.
Project filters match complete project labels, never substrings. Destination-derived
project labels are explicitly heuristic. No score, semantic search or authorization
is inferred. All capture/integration states are reported, not freshly verified.
"""
import argparse
import datetime as dt
import json
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import quote

USEFUL = {"TAKE AS-IS", "TAKE AND ADAPT", "TAKE THE IDEA, WRITE OUR OWN"}
KNOWN = USEFUL | {"OURS IS BETTER", "DON'T NEED", "INVESTIGATE"}
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_LEGACY_SEARCH_BYTES = 16 * 1024 * 1024
PAIN_BASES = {"user-stated", "joe-stated", "observed", "inferred"}
PAIN_STATUSES = {"open", "resolved", "unknown"}


def string(value):
    return value.strip() if isinstance(value, str) else ""


def strings(value):
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    return [v.strip() for v in value if isinstance(v, str) and v.strip()] if isinstance(value, list) else []


def destinations(component):
    return list(dict.fromkeys(strings(component.get("destination")) + strings(component.get("destinations"))))


def project_labels(component, dests):
    explicit = strings(component.get("projects"))
    if explicit:
        return list(dict.fromkeys(explicit)), "explicit"
    # Unassigned reusable/future applications deliberately have no project. Their
    # capability destination is not evidence of a real project association.
    if component.get("application_type") in ("reusable", "future"):
        return [], "unassigned application"
    labels = []
    for destination in dests:
        parts = PurePosixPath(destination).parts
        if "Desktop" in parts and parts.index("Desktop") + 1 < len(parts):
            labels.append(parts[parts.index("Desktop") + 1])
        elif parts and not destination.startswith("/"):
            labels.append(parts[0])
    return list(dict.fromkeys(labels)), "destination-heuristic" if labels else "unknown"


def material_blockers(record, cid):
    security = record.get("security")
    findings = security.get("findings", []) if isinstance(security, dict) else []
    if not isinstance(findings, list):
        return ["Security findings format unknown; inspect source record before use."]
    blockers = []
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        affected = strings(finding.get("components"))
        if finding.get("severity") == "material" and finding.get("resolved") is not True and (cid in affected or "*" in affected):
            blockers.append({key: finding.get(key) for key in
                             ("evidence", "trigger", "consequence", "repair", "verification", "remaining_risk")})
    return blockers


def security_limits(record):
    security = record.get("security")
    if not isinstance(security, dict) or not isinstance(security.get("findings"), list):
        return ["Security findings missing or unknown format; no safety conclusion inferred."]
    if any(not isinstance(item, dict) for item in security["findings"]):
        return ["Some security findings use an unknown format; inspect original record."]
    return strings(security.get("unknowns"))


def pain_observations(record, stem, link, warnings):
    """Preserve sourced snapshots, not a new current-truth or complaint registry."""
    context = record.get("project_context")
    if context is None:
        return [], "missing"
    if not isinstance(context, dict) or not isinstance(context.get("pains"), list):
        warnings.append({"record": link, "problem": "Project pain context has unknown format; no pain-free conclusion inferred."})
        return [], "malformed"
    result, seen = [], set()
    for ordinal, pain in enumerate(context["pains"]):
        if not isinstance(pain, dict):
            warnings.append({"record": link, "problem": "Pain position " + str(ordinal) + " is not an object; inspect original."})
            continue
        pid, project = string(pain.get("id")), string(pain.get("project"))
        identity = quote(stem, safe="") + "#pain#" + quote(project, safe="") + "#" + (quote(pid, safe="") if pid else "@missing-" + str(ordinal))
        key = (project, pid)
        missing = [field for field in ("id", "project", "problem", "source", "observed_on") if not string(pain.get(field))]
        if not pid or not project or key in seen:
            identity += "@" + str(ordinal)
            warnings.append({"record": link, "problem": "Missing/duplicate project pain identity at position " + str(ordinal) + "; snapshot preserved with ordinal identity."})
        seen.add(key)
        basis = string(pain.get("basis"))
        status = string(pain.get("status"))
        if basis not in PAIN_BASES:
            missing.append("valid basis")
            basis = "unknown"
        if status not in PAIN_STATUSES:
            missing.append("valid status")
            status = "unknown"
        reported_basis = basis
        if basis in {"user-stated", "joe-stated"} and not string(pain.get("source")):
            basis = "unknown"
        observed = string(pain.get("observed_on"))
        if observed and observed != "unknown":
            try:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", observed):
                    raise ValueError("not ISO date")
                dt.date.fromisoformat(observed)
            except ValueError:
                missing.append("valid observed_on date")
        if missing:
            warnings.append({"record": link, "problem": "Incomplete pain snapshot " + identity + ": " + ", ".join(missing) + "; recheck source, do not treat as the user-stated/current."})
        result.append({"identity": identity, "id": pid or "unknown", "project": project or "Unassigned — project context needed",
                       "problem": string(pain.get("problem")), "basis": basis, "reported_basis": reported_basis,
                       "source": string(pain.get("source")), "checked_on": string(record.get("checked_on")),
                       "source_revision": string(record.get("source_revision")),
                       "observed_on": observed, "status": status, "reported_open": status == "open",
                       "next_check": string(pain.get("next_check")), "record": link,
                       "context_limitations": string(context.get("limitations")), "missing_evidence": missing,
                       "evaluation_complete": record.get("complete") is True,
                       "state_basis": "dated source observation; current project state must be rechecked"})
    return result, "present"


def pain_conflict_warnings(pains):
    groups = {}
    for pain in pains:
        # A missing identifier cannot establish that two observations concern one pain.
        if pain["id"] == "unknown" or pain["project"] == "Unassigned — project context needed":
            continue
        groups.setdefault((pain["project"].casefold(), pain["id"]), []).append(pain)
    warnings = []
    for observations in groups.values():
        values = {(p["problem"], p["basis"], p["status"]) for p in observations}
        if len(values) > 1:
            warnings.append({"record": ", ".join(sorted({p["record"] for p in observations})),
                             "problem": "Project pain observations differ for " + observations[0]["project"] + " / " + observations[0]["id"] + "; snapshots retained, no newest-date winner or current-state inference."})
    return warnings


def build_index(memory_root):
    root = Path(memory_root)
    tool_dir = root / "tools"
    warnings, components, pains, trials = [], [], [], []
    missing_pain_context, malformed_pain_context = [], []
    if tool_dir.is_symlink():
        return {"schema_version": 1, "memory_root": str(root.absolute()), "legacy_records": [], "components": [], "pains": [], "coverage": {"sidecars_found": 0,
                "sidecars_loaded": 0, "legacy_records_without_sidecar": []},
                "warnings": [{"record": "tools/", "problem": "Symlinked tool-record directory not read; no completeness claim."}]}
    records = sorted(tool_dir.glob("*.json")) if tool_dir.is_dir() else []
    if not tool_dir.is_dir():
        warnings.append({"record": "tools/", "problem": "Tool-record directory unavailable; no completeness claim."})
    record_names = {path.stem for path in records}
    legacy = sorted(str(path.relative_to(root)) for path in tool_dir.glob("*.md") if path.stem not in record_names) if tool_dir.is_dir() else []
    without_sidecar = list(legacy)
    for path in legacy:
        warnings.append({"record": path, "problem": "Legacy Markdown has no component sidecar; available as unverified lexical recall, not structured component status."})
    loaded = 0
    structured_names = set()
    for path in records:
        link = str(path.relative_to(root))
        try:
            if path.is_symlink():
                raise ValueError("Symlinked sidecar not read")
            if path.stat().st_size > MAX_RECORD_BYTES:
                raise ValueError("Sidecar exceeds bounded read size")
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record, dict):
                raise ValueError("Expected a JSON object")
        except (OSError, ValueError, UnicodeError) as exc:
            warnings.append({"record": link, "problem": "Cannot index: " + str(exc)})
            continue
        loaded += 1
        if record.get("schema_version") != 2:
            warnings.append({"record": link, "problem": "Unknown/legacy schema; available component fields shown without completeness claim."})
        if record.get("complete") is not True:
            warnings.append({"record": link, "problem": "Partial/unknown evaluation; component decisions require recheck."})
        if "trial" in record:
            trial = record["trial"]
            if isinstance(trial, dict):
                trial_parts = record.get("usefulness", {})
                trial_parts = trial_parts.get("components", []) if isinstance(trial_parts, dict) else []
                labels = sorted({label for part in trial_parts if isinstance(part, dict)
                                 for label in strings(part.get("projects"))}) if isinstance(trial_parts, list) else []
                trials.append({"tool": string(record.get("tool")) or path.stem, "record": link,
                               "checked_on": string(record.get("checked_on")),
                               "whole_tool_decision": string(record.get("whole_tool_decision")),
                               "projects": labels,
                               **{field: string(trial.get(field)) for field in
                                  ("state", "task", "keep_criteria", "drop_criteria", "review_on", "started_on", "ended_on", "result")}})
            else:
                warnings.append({"record": link, "problem": "Trial has unknown format; no active/completed state inferred."})
        observations, context_state = pain_observations(record, path.stem, link, warnings)
        pains.extend(observations)
        if context_state == "missing":
            missing_pain_context.append(link)
        elif context_state == "malformed":
            malformed_pain_context.append(link)
        usefulness = record.get("usefulness")
        parts = usefulness.get("components") if isinstance(usefulness, dict) else None
        if not isinstance(parts, list):
            warnings.append({"record": link, "problem": "Missing/unknown component inventory; no parts inferred."})
            continue
        structured_names.add(path.stem)
        seen = set()
        for ordinal, component in enumerate(parts):
            if not isinstance(component, dict):
                warnings.append({"record": link, "problem": "Component position " + str(ordinal) + " is not an object; inspect original."})
                continue
            cid = string(component.get("id"))
            identity = quote(path.stem, safe="") + "#" + (quote(cid, safe="") if cid else "@missing-" + str(ordinal))
            if not cid or cid in seen:
                warnings.append({"record": link, "problem": "Missing/duplicate component ID at position " + str(ordinal) + "; preserved with ordinal identity."})
                identity += "@" + str(ordinal)
            seen.add(cid)
            decision = string(component.get("decision")) or "unknown"
            if decision not in KNOWN:
                warnings.append({"record": link, "problem": "Unknown component decision for " + identity + "; investigate rather than dismiss."})
            dests = destinations(component)
            projects, association = project_labels(component, dests)
            capture = component.get("capture") if isinstance(component.get("capture"), dict) else {"state": "unknown"}
            integration = component.get("integration") if isinstance(component.get("integration"), dict) else {"state": "unknown"}
            missing = [key for key in ("before", "after", "next_action", "prerequisite") if not string(component.get(key))]
            if not strings(component.get("projects")) and not (
                    component.get("application_type") in ("reusable", "future") and
                    string(component.get("destination_unknown_reason"))):
                missing.append("explicit projects")
            if not strings(component.get("tags")):
                missing.append("tags")
            pending = (decision in USEFUL or decision == "INVESTIGATE" or decision not in KNOWN) and integration.get("state") != "verified"
            components.append({
                "identity": identity, "tool": string(record.get("tool")) or path.stem,
                "component": cid or "unknown", "kind": string(component.get("kind")) or "unknown",
                "decision": decision, "useful": decision in USEFUL, "pending": pending,
                "benefit": string(component.get("benefit")), "before": string(component.get("before")),
                "after": string(component.get("after")), "destinations": dests,
                "projects": projects, "project_association": association,
                "tags": strings(component.get("tags")), "next_action": string(component.get("next_action")),
                "prerequisite": string(component.get("prerequisite")), "capture": capture,
                "integration": integration, "source_revision": string(record.get("source_revision")),
                "checked_on": string(record.get("checked_on")),
                "application_type": string(component.get("application_type")) or "unknown",
                "recommendation_timing": string(component.get("recommendation_timing")) or "unknown",
                "revisit_trigger": string(component.get("revisit_trigger")),
                "future_scenario": component.get("future_scenario") if isinstance(component.get("future_scenario"), dict) else {},
                "destination_unknown_reason": string(component.get("destination_unknown_reason")),
                "source_evidence": component.get("source_evidence", []),
                "material_blockers": material_blockers(record, cid),
                "security_evidence_limits": security_limits(record),
                "record": link, "evaluation_complete": record.get("complete") is True,
                "missing_followthrough": missing,
            })
    # A broken sidecar must not remove the last usable route into old prose.
    # Keep prose independently searchable even if a partial/new sidecar exists.
    # Structured fields are never evidence that all historical parts were captured.
    fallback = sorted(str(path.relative_to(root)) for path in tool_dir.glob("*.md")) if tool_dir.is_dir() else []
    for path in fallback:
        if path not in legacy:
            if Path(path).stem not in structured_names:
                warnings.append({"record": path, "problem": "Component sidecar unusable; Markdown retained as an unverified historical search hint."})
    legacy = fallback
    components.sort(key=lambda item: item["identity"])
    pains.sort(key=lambda item: item["identity"])
    warnings.extend(pain_conflict_warnings(pains))
    if missing_pain_context or without_sidecar:
        warnings.append({"record": "tools/", "problem": "Pain recall coverage incomplete: " + str(len(missing_pain_context)) +
                         " sidecars lack project_context and " + str(len(without_sidecar)) +
                         " Markdown records lack sidecars. Search historical text and current project sources; this is not evidence of no pain points."})
    return {
        "schema_version": 1, "memory_root": str(root.absolute()),
        "legacy_records": [{"record": path, "basis": "historical hint; recheck source and fit"} for path in legacy],
        "generated_from": "tools/*.json plus independent Markdown references (including partial sidecar history); no manually maintained component state",
        "state_basis": "reported source records; capture/integration/safety not reverified by index",
        "search": "case-insensitive literal AND terms; project label exact; no popularity/semantic ranking",
        "coverage": {"sidecars_found": len(records), "sidecars_loaded": loaded,
                     "legacy_records_without_sidecar": without_sidecar,
                     "legacy_records_available_for_search": legacy,
                     "records_without_project_context": missing_pain_context,
                     "records_with_malformed_project_context": malformed_pain_context},
        "components": components, "pains": pains, "trials": trials, "warnings": warnings,
    }


def legacy_search(index, terms, project=None):
    """Bounded on-demand recall; never extract capture, integration or project claims."""
    result = {"available_records": len(index.get("legacy_records", [])), "searched_records": 0,
              "skipped_records": [], "matches": [], "basis": "historical hints; recheck original source and current fit",
              "project_filter": "not applied to unstructured legacy text; associations unverified" if project else "not requested"}
    if not terms:
        result["note"] = "Use --query with a behavior or visual need to search historical text; no legacy project association is inferred."
        return result
    root_value = index.get("memory_root")
    if not isinstance(root_value, str):
        result["note"] = "Legacy source root unavailable; historical records not searched."
        return result
    tool_dir = Path(root_value) / "tools"
    if tool_dir.is_symlink():
        result["note"] = "Symlinked legacy directory refused; historical records not searched."
        return result
    read_bytes = 0
    for record in index.get("legacy_records", []):
        reference = record.get("record", "") if isinstance(record, dict) else ""
        parts = PurePosixPath(reference).parts
        if len(parts) != 2 or parts[0] != "tools" or not parts[1].endswith(".md") or parts[1] in (".", ".."):
            result["skipped_records"].append({"record": reference, "reason": "Invalid legacy record path"})
            continue
        path = tool_dir / parts[1]
        try:
            if path.is_symlink() or not path.is_file():
                raise ValueError("Legacy record is missing, non-file or symlink; not read")
            size = path.stat().st_size
            if size > MAX_RECORD_BYTES or read_bytes + size > MAX_LEGACY_SEARCH_BYTES:
                raise ValueError("Legacy search size limit; record not searched")
            with path.open("rb") as handle:
                raw = handle.read(MAX_RECORD_BYTES + 1)
            read_bytes += len(raw)
            if len(raw) > MAX_RECORD_BYTES or read_bytes > MAX_LEGACY_SEARCH_BYTES:
                raise ValueError("Legacy search size limit; record not searched")
            content = raw.decode("utf-8")
        except (OSError, ValueError, UnicodeError) as exc:
            result["skipped_records"].append({"record": reference, "reason": str(exc)})
            continue
        result["searched_records"] += 1
        folded = content.casefold()
        if not all(term in folded for term in terms):
            continue
        offset = min(folded.find(term) for term in terms)
        start, end = max(0, offset - 80), min(len(content), offset + 240)
        snippet = content[start:end].replace("\n", " ").replace("\r", " ")
        result["matches"].append({"record": reference, "snippet": snippet, "matched_terms": terms,
                                  "basis": "unverified historical text match; recheck source and current relevance",
                                  "project_association": "unverified"})
    return result


def filtered(index, queries=(), project=None):
    # Search all meaningful recall fields; do not use overall tool call/rating to filter.
    terms = [term.casefold() for query in queries for term in query.split()]
    result = dict(index)
    found = []
    for item in index["components"]:
        if project and project.casefold() not in [label.casefold() for label in item["projects"]]:
            continue
        corpus = json.dumps({key: item.get(key) for key in (
            "identity", "tool", "component", "kind", "benefit", "before", "after", "destinations",
            "projects", "tags", "next_action", "prerequisite", "source_evidence", "decision",
            "capture", "integration", "material_blockers", "security_evidence_limits", "checked_on",
            "application_type", "recommendation_timing", "revisit_trigger", "future_scenario",
            "destination_unknown_reason")}, ensure_ascii=False).casefold()
        if all(term in corpus for term in terms):
            found.append(item)
    result["components"] = found
    result["query"] = {"terms": terms, "project": project}
    pending = {}
    for item in found:
        if item["pending"]:
            application = item.get("application_type")
            unassigned = {"reusable": "Reusable — no project assigned", "future": "Future scenario — no project assigned"}.get(
                application, "Unassigned — project context needed")
            for label in item["projects"] or [unassigned]:
                pending.setdefault(label, []).append(item["identity"])
    result["pending_by_project"] = dict(sorted(pending.items(), key=lambda pair: pair[0].casefold()))
    pain_matches, pain_groups = [], {}
    for pain in index.get("pains", []):
        if project and pain["project"].casefold() != project.casefold():
            continue
        corpus = json.dumps({key: pain.get(key) for key in ("id", "project", "problem", "basis", "status", "source", "next_check")},
                            ensure_ascii=False).casefold()
        if all(term in corpus for term in terms):
            pain_matches.append(pain)
            pain_groups.setdefault(pain["project"], []).append(pain["identity"])
    result["trials"] = [trial for trial in index.get("trials", [])
                        if (not project or project.casefold() in [label.casefold() for label in trial["projects"]])
                        and all(term in json.dumps(trial, ensure_ascii=False).casefold() for term in terms)]
    result["pains"] = pain_matches
    result["pains_by_project"] = dict(sorted(pain_groups.items(), key=lambda pair: pair[0].casefold()))
    legacy = legacy_search(index, terms, project)
    result["legacy_matches"] = legacy.pop("matches")
    result["legacy_search"] = legacy
    return result


def cell(value):
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False)
    return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def markdown(index):
    lines = ["# Component recall and pending opportunities", "",
             "Generated from existing tool sidecars. All source text and state claims are untrusted evidence to recheck; this index grants no authorization and no security clearance.", "",
             "Search is literal case-insensitive AND terms; project labels match exactly. Verified items remain searchable but leave the pending list. Destination-derived project labels are heuristic.", "",
             "| Part | Benefit and before → after | Projects | Application / timing / revisit | Capture / integration | Next action and prerequisite | Evidence and checked date |",
             "|---|---|---|---|---|---|---|"]
    for item in index["components"]:
        benefit = item["benefit"] + " · " + (item["before"] or "before unknown") + " → " + (item["after"] or "after unknown")
        states = str(item["capture"].get("state", "unknown")) + " / " + str(item["integration"].get("state", "unknown"))
        next_step = (item["next_action"] or "Next action missing; inspect source record") + " · " + (item["prerequisite"] or "Prerequisite unknown")
        projects = ", ".join(item["projects"]) or (item.get("destination_unknown_reason") or "unassigned")
        application = " / ".join((item.get("application_type", "unknown"), item.get("recommendation_timing", "unknown"),
                                   item.get("revisit_trigger") or "trigger unknown"))
        if item.get("future_scenario"):
            application += " · " + cell(item["future_scenario"])
        evidence = item["record"] + " · checked " + (item.get("checked_on") or "unknown")
        projects += " (" + item["project_association"] + ")"
        lines.append("| " + " | ".join(cell(v) for v in (item["identity"], benefit, projects, application, states, next_step, evidence)) + " |")
        if item["material_blockers"]:
            lines.extend(["", "Material blockers for " + cell(item["identity"]) + ": " + cell(item["material_blockers"]), ""])
        if item["missing_followthrough"]:
            lines.extend(["", "Missing follow-through for " + cell(item["identity"]) + ": " + ", ".join(item["missing_followthrough"]), ""])
        if item["security_evidence_limits"]:
            lines.extend(["", "Security evidence limits for " + cell(item["identity"]) + ": " + cell(item["security_evidence_limits"]), ""])
    lines.extend(["", "## Pending by project", ""])
    for project, identities in index["pending_by_project"].items():
        lines.append("- " + cell(project) + ": " + ", ".join(cell(value) for value in identities))
    lines.extend(["", "## Whole-tool trials", "",
                  "Reported trial plans/results from evaluations; not proof of execution or an authorization to start.", "",
                  "| Tool and source | State and dates | Task and keep/drop criteria | Observed result and decision |",
                  "|---|---|---|---|"])
    for trial in index.get("trials", []):
        lines.append("| " + " | ".join(cell(v) for v in (
            trial["tool"] + " · " + trial["record"] + " · checked " + (trial["checked_on"] or "unknown"),
            trial["state"] + " · review " + trial["review_on"] + " · started " + (trial["started_on"] or "unknown") +
            " · ended " + (trial["ended_on"] or "unknown"),
            trial["task"] + " · keep: " + trial["keep_criteria"] + " · drop: " + trial["drop_criteria"],
            (trial["result"] or "No result recorded") + " · " + trial["whole_tool_decision"])) + " |")
    lines.extend(["", "## Project pain observations", "",
                  "Dated evidence snapshots, not a new project source of truth. the user-stated, observed and inferred problems stay distinct. Resolved/unknown observations remain visible; differing snapshots require source recheck, never a newest-date winner.", "",
                  "| Project and pain | Problem | Evidence basis | Reported status and source date | Source and next check | Evaluation snapshot and limits |",
                  "|---|---|---|---|---|---|"])
    for pain in index.get("pains", []):
        lines.append("| " + " | ".join(cell(v) for v in (
            pain["project"] + " / " + pain["id"], pain["problem"], pain["basis"],
            pain["status"] + " · " + (pain["observed_on"] or "date unknown"),
            pain["source"] + " · " + (pain["next_check"] or "Recheck current project source before use"),
            pain["record"] + " · checked " + (pain["checked_on"] or "unknown") + " · " +
            (pain["context_limitations"] or "See source record") +
            (" · missing: " + ", ".join(pain["missing_evidence"]) if pain["missing_evidence"] else ""))) + " |")
    lines.extend(["", "## Historical recall", "",
                  "Legacy Markdown is searchable on demand with --query and --stdout. Matches are historical hints: recheck source and fit. No captured, integrated, verified or pending status is inferred from old prose. Project filters do not establish associations in unstructured text.", ""])
    for match in index.get("legacy_matches", []):
        lines.append("- " + cell(match["record"]) + ": " + cell(match["snippet"]) + " (unverified historical hint)")
    if index.get("legacy_search", {}).get("note"):
        lines.append(cell(index["legacy_search"]["note"]))
    lines.extend(["", "## Coverage and warnings", "", cell(index["coverage"]), ""])
    for warning in index["warnings"]:
        lines.append("- " + cell(warning["record"]) + ": " + cell(warning["problem"]))
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="Output directory; defaults to memory root")
    parser.add_argument("--query", action="append", default=[])
    parser.add_argument("--project")
    parser.add_argument("--stdout", action="store_true", help="Print filtered JSON without writing")
    args = parser.parse_args()
    index = filtered(build_index(args.memory_root), args.query, args.project)
    if args.stdout:
        print(json.dumps(index, indent=2, ensure_ascii=False))
        return 0
    if args.query or args.project:
        parser.error("Filtered searches require --stdout; do not replace the full generated index with a partial view")
    output = args.output or args.memory_root
    output.mkdir(parents=True, exist_ok=True)
    for name in ("component-index.json", "component-index.md"):
        if (output / name).is_symlink():
            raise ValueError("Refusing symlink output")
    (output / "component-index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "component-index.md").write_text(markdown(index), encoding="utf-8")
    print("Generated component-index.json and component-index.md; read coverage warnings before relying on recall.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print("Component index failed: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
