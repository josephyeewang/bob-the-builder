#!/usr/bin/env python3
"""Check evaluation evidence/state consistency; does not establish semantic truth."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import re
from pathlib import Path

DECISIONS = {"TAKE AS-IS", "TAKE AND ADAPT", "TAKE THE IDEA, WRITE OUR OWN",
             "OURS IS BETTER", "DON'T NEED", "INVESTIGATE"}
USEFUL = {"TAKE AS-IS", "TAKE AND ADAPT", "TAKE THE IDEA, WRITE OUR OWN"}


def text(value):
    return isinstance(value, str) and bool(value.strip())


def date_or_unknown(value):
    if value == "unknown":
        return True
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        dt.date.fromisoformat(value)
        return True
    except ValueError:
        return False


def receipt(value, base):
    if not text(value):
        return False
    path = base / value
    return path.is_file() and not path.is_symlink() and path.stat().st_size > 0


def validate(record, base):
    errors = []
    def need(condition, message):
        if not condition:
            errors.append(message)
    need(record.get("schema_version") == 2, "schema_version must be 2")
    need(text(record.get("tool")), "tool is required")
    need(type(record.get("complete")) is bool, "complete must be boolean")
    complete = record.get("complete") is True
    need(text(record.get("source_revision")) or (not complete and text(record.get("source_access_limits"))),
         "source revision or explicit partial source-access limits required")
    for key in ("usefulness", "security", "qualitative"):
        need(isinstance(record.get(key), dict) and text(record[key].get("conclusion")),
             key + " requires an independent conclusion")
    if errors:
        return errors
    for key in ("coverage", "alternative_search", "runtime"):
        need(isinstance(record.get(key), dict), key + " must be an object")
    if errors:
        return errors
    coverage = record.get("coverage", {})
    need(isinstance(coverage.get("inspected"), list) and
         (bool(coverage["inspected"]) or not complete), "complete review needs inspected areas")
    need(isinstance(coverage.get("omitted"), list), "coverage.omitted must disclose omissions")
    need(bool(record.get("context_evidence")) or not complete,
         "complete review needs project/context evidence")
    search = record.get("alternative_search", {})
    focused = record.get("opportunity_schema_version") == 1 and record.get("request_mode") in {"learn", "recheck"}
    need(bool(search.get("queries")) or not complete or (focused and text(search.get("scope_reason"))),
         "record alternative search, or focused-scope reason")
    need(isinstance(search.get("results"), list), "alternative search results must be a list")
    qual = record["qualitative"]
    need(isinstance(qual.get("sources"), list), "qualitative sources must be a list")
    need(bool(qual.get("sources")) or text(qual.get("limitations")),
         "missing public feedback needs an explicit limitation, not a low-quality inference")
    sec = record["security"]
    need(isinstance(sec.get("checks"), list) and (bool(sec["checks"]) or not complete),
         "security checks and outcomes required")
    need(isinstance(sec.get("unknowns"), list), "security unknowns must be recorded")
    findings = sec.get("findings", [])
    need(isinstance(findings, list), "security findings must be a list")
    for finding in findings if isinstance(findings, list) else []:
        need(isinstance(finding, dict) and finding.get("severity") in {"material", "minor", "cosmetic"},
             "finding severity must be material/minor/cosmetic")
        if not isinstance(finding, dict):
            continue
        for field in ("evidence", "trigger", "consequence", "repair", "verification", "remaining_risk"):
            need(text(finding.get(field)), "security finding requires " + field)
        need(isinstance(finding.get("components"), list) and bool(finding["components"]),
             "finding must name affected component IDs, or '*' for all")
        if finding.get("resolved") is True:
            need(receipt(finding.get("verification_receipt"), base), "resolved finding needs test receipt")
    components = record["usefulness"].get("components")
    need(isinstance(components, list), "components must be a list")
    if not isinstance(components, list):
        return errors
    contextual = record.get("context_schema_version") == 1
    if contextual:
        need(record.get("checked_on") != "unknown" and date_or_unknown(record.get("checked_on")),
             "new context records require actual checked_on date")
        context = record.get("project_context")
        need(isinstance(context, dict), "project_context must be an object")
        if isinstance(context, dict):
            pains = context.get("pains")
            need(isinstance(pains, list), "project_context.pains must be a list")
            need(bool(pains) or text(context.get("limitations")), "missing pain observations need source/context limits")
            pain_ids = set()
            for pain in pains if isinstance(pains, list) else []:
                if not isinstance(pain, dict):
                    errors.append("pain observation must be an object")
                    continue
                for field in ("id", "project", "problem", "source"):
                    need(text(pain.get(field)), "pain observation requires " + field)
                need(pain.get("basis") in {"user-stated", "joe-stated", "observed", "inferred"}, "pain basis must distinguish statement/observation/inference")
                need(pain.get("status") in {"open", "resolved", "unknown"}, "pain status required")
                need(date_or_unknown(pain.get("observed_on")), "pain observed_on needs source date or unknown")
                identity = json.dumps(pain, sort_keys=True, ensure_ascii=False)
                need(identity not in pain_ids, "duplicate identical pain observation")
                pain_ids.add(identity)
        angle = record.get("product_angle")
        need(isinstance(angle, dict), "product_angle must be assessed separately from feedback")
        if isinstance(angle, dict):
            for field in ("claimed_angle", "delivered_behavior", "conclusion"):
                need(text(angle.get(field)), "product_angle requires " + field)
            evidence = angle.get("evidence")
            need(isinstance(evidence, list) and (bool(evidence) or text(angle.get("limitations"))),
                 "product_angle needs evidence or explicit source limits")
            need(isinstance(angle.get("opportunities"), list), "product_angle opportunity IDs must be a list")
        if record.get("request_mode") == "recheck":
            recheck = record.get("recheck")
            need(isinstance(recheck, dict), "recheck requires prior/current comparison")
            if isinstance(recheck, dict):
                need(date_or_unknown(recheck.get("previous_checked_on")), "recheck requires previous date or unknown")
                for field in ("previous_revision", "changes", "decision_effect"):
                    need(text(recheck.get(field)), "recheck requires " + field)
                need(bool(recheck.get("evidence")) or text(recheck.get("limitations")), "recheck needs changed-source evidence or limits")
    application = record.get("application_schema_version") == 1
    if "application_schema_version" in record:
        need(type(record["application_schema_version"]) is int and application,
             "application_schema_version must be 1 when present")
    if application:
        need(record.get("checked_on") != "unknown" and date_or_unknown(record.get("checked_on")),
             "application records require actual checked_on date")
    modern = record.get("opportunity_schema_version") == 1
    if modern:
        need(record.get("request_mode") in {"adopt", "scan", "learn", "recheck"}, "request_mode required for new evaluations")
        visual = record.get("visual_review", {})
        need(isinstance(visual, dict), "visual_review must be an object")
        if isinstance(visual, dict):
            need(visual.get("applicability") in {"user-facing", "headless", "unknown"}, "visual applicability required")
            need(text(visual.get("conclusion")), "UI/UX and visuals conclusion required")
            need(isinstance(visual.get("opportunities"), list), "visual opportunity component IDs required")
            evidence = visual.get("evidence", [])
            need(isinstance(evidence, list), "visual evidence must be a list")
            for item in evidence if isinstance(evidence, list) else []:
                need(isinstance(item, dict) and item.get("kind") in {"screenshot", "interaction", "source", "promotional"}
                     and text(item.get("ref")) if isinstance(item, dict) else False, "visual evidence needs kind and reference")
            if visual.get("applicability") == "user-facing":
                need(bool(evidence) or text(visual.get("limitations")), "user-facing UI needs evidence or explicit access limit")
            else:
                need(text(visual.get("reason")), "headless/unknown visual applicability requires reason")
    ids = set()
    for component in components:
        if not isinstance(component, dict):
            errors.append("each component must be an object")
            continue
        cid = component.get("id")
        need(text(cid) and cid not in ids, "unique component id required")
        if text(cid):
            ids.add(cid)
        prefix = str(cid) + ": "
        decision = component.get("decision")
        need(decision in DECISIONS, prefix + "unknown decision")
        need(text(component.get("reason")), prefix + "decision reason required")
        need(bool(component.get("source_evidence")), prefix + "source evidence required")
        if decision in USEFUL:
            need(text(component.get("benefit")), prefix + "benefit required")
            need(text(component.get("destination")) or text(component.get("destination_unknown_reason")),
                 prefix + "destination or explicit unknown reason required")
            need(bool(component.get("supporting_files")) or text(component.get("supporting_files_reason")),
                 prefix + "supporting files inspection required")
            if modern:
                need(text(component.get("before")) or text(component.get("before_unknown_reason")), prefix + "current target behavior or explicit unknown required")
                for field in ("after", "adaptation_burden", "next_action", "prerequisite"):
                    need(text(component.get(field)), prefix + "concrete opportunity requires " + field)
                for field in ("projects", "tags"):
                    value = component.get(field)
                    need(isinstance(value, list) and all(text(item) for item in value), prefix + field + " must list explicit labels")
                need(bool(component.get("projects")) or text(component.get("destination_unknown_reason")), prefix + "project association or unknown reason required")
        if application and decision in USEFUL:
            need(component.get("application_type") in ("current", "reusable", "future"),
                 prefix + "application_type must be current/reusable/future")
            timing = component.get("recommendation_timing")
            need(timing in ("act-now", "preserve", "defer"),
                 prefix + "recommendation_timing must be act-now/preserve/defer")
            trigger = component.get("revisit_trigger")
            need(text(trigger) and (trigger.strip().casefold() != "none" or timing == "act-now"),
                 prefix + "revisit_trigger required; none is allowed only for act-now")
            if component.get("application_type") == "future":
                scenario = component.get("future_scenario")
                need(isinstance(scenario, dict), prefix + "future_scenario must be an object")
                if isinstance(scenario, dict):
                    for field in ("user", "task", "enabling_value"):
                        need(text(scenario.get(field)), prefix + "future_scenario requires " + field)
        if decision == "TAKE THE IDEA, WRITE OUR OWN":
            need(text(component.get("idea_only_reason")), prefix + "idea-only tradeoff required")
        if decision == "OURS IS BETTER":
            need(bool(component.get("our_evidence")), prefix + "our implementation evidence required")
        capture = component.get("capture", {})
        integration = component.get("integration", {})
        if not isinstance(capture, dict) or not isinstance(integration, dict):
            errors.append(prefix + "capture and integration must be objects")
            continue
        need(capture.get("state") in {"not-needed", "blocked", "captured"}, prefix + "capture state required")
        if capture.get("state") == "blocked":
            need(text(capture.get("reason")), prefix + "blocked capture reason required")
        if decision in {"TAKE AS-IS", "TAKE AND ADAPT"}:
            need(capture.get("state") in {"blocked", "captured"}, prefix + "reuse requires capture or explicit block")
        if capture.get("state") == "captured":
            try:
                manifest = verify_capture(base / capture.get("path", ""))
                need(manifest.get("revision") == capture.get("revision") == record.get("source_revision"),
                     prefix + "capture revision must match evaluated source")
                need(manifest.get("source_url") == capture.get("source_url"), prefix + "capture source URL mismatch")
                selected = capture.get("source_files")
                need(isinstance(selected, list) and bool(selected), prefix + "captured component source_files required")
                manifest_files = {f["path"] for f in manifest["files"]}
                if isinstance(selected, list):
                    need(all(isinstance(p, str) and p in manifest_files for p in selected),
                         prefix + "claimed component files absent from capture")
            except (OSError, ValueError, KeyError, TypeError) as exc:
                errors.append(prefix + "invalid capture: " + str(exc))
        integration = component.get("integration", {})
        need(integration.get("state") in {"not-integrated", "integrated", "verified"}, prefix + "integration state required")
        if integration.get("state") in {"integrated", "verified"}:
            if decision in {"TAKE AS-IS", "TAKE AND ADAPT"}:
                need(capture.get("state") == "captured", prefix + "source reuse integration requires validated capture")
            need(receipt(integration.get("mapping_receipt"), base), prefix + "integration source mapping receipt required")
            need(text(component.get("destination")), prefix + "integrated part needs actual destination")
            for finding in findings if isinstance(findings, list) else []:
                if isinstance(finding, dict) and finding.get("severity") == "material" and finding.get("resolved") is not True:
                    need(cid not in finding.get("components", []) and "*" not in finding.get("components", []),
                         prefix + "unresolved material issue blocks integration")
        if integration.get("state") == "verified":
            for field in ("behavior_receipt", "safety_receipt", "attribution_receipt"):
                need(receipt(integration.get(field), base), prefix + "verified integration needs " + field)
    for finding in findings if isinstance(findings, list) else []:
        if isinstance(finding, dict):
            need(all(cid == "*" or cid in ids for cid in finding.get("components", [])),
                 "security finding names an unknown component")
    if modern and isinstance(record.get("visual_review"), dict):
        need(all(cid in ids for cid in record["visual_review"].get("opportunities", [])), "visual opportunity names unknown component")
    if contextual and isinstance(record.get("product_angle"), dict):
        angle_ids = record["product_angle"].get("opportunities", [])
        if isinstance(angle_ids, list):
            need(all(isinstance(cid, str) and cid in ids for cid in angle_ids), "product-angle opportunity names unknown component")
    if complete and not components:
        need(text(record["usefulness"].get("no_parts_reason")), "no useful parts needs evidence-backed explanation")
    choice = record.get("whole_tool_decision")
    need(choice in {"adopt", "try", "harvest-parts", "skip", "investigate"}, "unknown whole-tool decision")
    if application and (choice == "try" or "trial" in record):
        trial = record.get("trial")
        need(isinstance(trial, dict), "try requires a trial object; supplied trial must be an object")
        if isinstance(trial, dict):
            state = trial.get("state")
            need(state in ("proposed", "active", "completed"), "trial state must be proposed/active/completed")
            for field in ("task", "keep_criteria", "drop_criteria"):
                need(text(trial.get(field)), "trial requires " + field)
            need(trial.get("review_on") != "unknown" and date_or_unknown(trial.get("review_on")),
                 "trial requires actual review_on date")
            if state in ("proposed", "active"):
                need(choice == "try", "proposed/active trial requires whole-tool decision try")
            if state in ("active", "completed"):
                need(trial.get("started_on") != "unknown" and date_or_unknown(trial.get("started_on")),
                     "active/completed trial requires actual started_on date")
            if state == "completed":
                need(trial.get("ended_on") != "unknown" and date_or_unknown(trial.get("ended_on")),
                     "completed trial requires actual ended_on date")
                need(text(trial.get("result")), "completed trial requires observed result")
                need(choice != "try", "completed trial requires a new whole-tool decision beyond try")
                started, ended = trial.get("started_on"), trial.get("ended_on")
                if started != "unknown" and ended != "unknown" and date_or_unknown(started) and date_or_unknown(ended):
                    need(ended >= started, "trial ended_on cannot precede started_on")
    runtime = record.get("runtime", {})
    need(runtime.get("status") in {"passed", "failed", "not-tested"}, "runtime status required")
    if runtime.get("status") in {"passed", "failed"}:
        need(receipt(runtime.get("receipt"), base), "runtime claim needs a receipt")
    if choice == "adopt":
        need(complete and runtime.get("status") == "passed", "adopt needs complete review and successful safe runtime")
        need(not any(isinstance(f, dict) and f.get("severity") == "material" and f.get("resolved") is not True
                     for f in findings), "adopt blocked by unresolved material findings")
    review_required = choice == "adopt" or record.get("publishing") is True or record.get("paid_use") is True or record.get("setup_change") is True or any(
        c.get("integration", {}).get("state") in {"integrated", "verified"} for c in components
        if isinstance(c, dict) and isinstance(c.get("integration", {}), dict))
    if review_required:
        need(receipt(record.get("independent_review_receipt"), base), "independent review receipt required")
    return errors


def verify_capture(folder):
    helper_path = Path(__file__).with_name("capture-source.py")
    spec = importlib.util.spec_from_file_location("verdict_capture", helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    manifest_path = folder / "manifest.json"
    if folder.is_symlink() or (folder / "originals").is_symlink() or manifest_path.is_symlink():
        raise ValueError("manifest is a symlink")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema_version") != 1 or manifest.get("license_reviewed") is not True:
        raise ValueError("capture manifest lacks schema/permission attestation")
    if not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', manifest.get("revision", "")):
        raise ValueError("capture lacks immutable source revision")
    helper.public_url(manifest.get("source_url", ""))
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("capture has no files")
    original_root = (folder / "originals").resolve()
    seen = set()
    total_bytes = 0
    for entry in files:
        rel = str(helper.validate_path(entry["path"]))
        if rel in seen:
            raise ValueError("duplicate capture file")
        seen.add(rel)
        path = folder / "originals" / rel
        if any(p.is_symlink() for p in [path, *path.parents] if p != folder and folder in p.parents) or not path.resolve().is_relative_to(original_root):
            raise ValueError("capture path escapes originals")
        if path.stat().st_size > 1024 * 1024:
            raise ValueError("capture file exceeds size limit")
        data = path.read_bytes()
        total_bytes += len(data)
        if total_bytes > helper.MAX_TOTAL_BYTES:
            raise ValueError("capture exceeds total size limit")
        if hashlib.sha256(data).hexdigest() != entry["sha256"] or len(data) != entry["bytes"]:
            raise ValueError("captured original changed: " + rel)
    if not any(helper.license_path(path) for path in seen):
        raise ValueError("capture lacks license/notice files")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", type=Path)
    args = parser.parse_args()
    try:
        record = json.loads(args.record.read_text())
        if not isinstance(record, dict):
            raise ValueError("record must be an object")
        errors = validate(record, args.record.parent)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        errors = [str(exc)]
    for error in errors:
        print("ERROR: " + error)
    if errors:
        return 1
    status = "complete" if record.get("complete") else "PARTIAL"
    print(status + ": evidence states consistent; semantic quality and review independence require human/agent inspection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
