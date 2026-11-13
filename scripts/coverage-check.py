#!/usr/bin/env python3
"""coverage-check.py — checks an audit's coverage record (audit-lenses/_evidence-accounting.md).

Turns the written rules of _evidence-accounting.md §1-§2 into a check that fails loudly,
because the rules that held in Bob were the ones turned into code. Bob's own script; the idea
(a checker for the coverage record) comes from cloudflare/security-audit-skill, whose checker
is security-specific and was not copied.

What it refuses (each line is one rule in _evidence-accounting.md):
  1  a unit with no id, a repeated id, or a state that is not one of the seven
  2  a `covered` unit without evidence: no files read, or no checks made          (§1 rule 2)
  2b a `covered` unit without a `source` of 'self_reported' or 'observed' —
     whether "clean" is an agent's claim or a tool/runtime fact must be stamped,
     because a hallucinated "clean" read as fact is worse than no record          (§1 rule 2)
  3  a `deferred` / `out_of_scope` unit with no reason, or a `deferred` unit
     hiding partial evidence (put partial work in `blocked`, not `deferred`)      (§1 rule 3)
  4  a `blocked` unit that does not name the missing fact                          (§1 states)
  5  a unit still `planned` / `in_progress` at close — unreached work must be
     `deferred` with a reason, never silently dropped                            (§1 rule 3)
  6  a "needs checking" finding that carries a severity, or lacks the missing
     fact or a safe way to find out                                               (§2)
  7  a closing statement that is missing or whose counts do not match the units  (closing statement)

The `source` idea (rule 2b) is adapted from usestrix/strix (strix/report/coverage.py, which keeps
self-reported closures apart from machine-observed ones; its finish step refuses to call an
unexamined area clean). Apache-2.0, Copyright 2025 OmniSecure Inc.; licence in third_party/strix/LICENSE.
The idea only — no code was copied; this is Bob's own Python.

Record format (JSON):
  {"units": [{"id": "U1", "state": "covered", "source": "observed",
              "files": ["api/orders.ts"], "checks": ["owner check on GET"],
              "reason": "", "missing_fact": ""}, ...],
   # source: "self_reported" (an agent says it is clean) | "observed" (a tool/runtime confirmed it)
   "findings": [{"id": "F1", "verdict": "confirmed|needs_checking|rejected", "severity": "Major",
                 "missing_fact": "", "safe_check": ""}, ...],
   "statement": {"planned": 12, "covered": 8, "candidate": 0, "blocked": 1, "deferred": 2, "out_of_scope": 1}}
  `statement.planned` is the total number of units; each other count must equal the units in that state.

Optional unit.run: {"report": "reports/task.json", "expected_run_id": "caller-created-unique-id",
  "expected_subject": "source-freshness", "not_before": "2026-11-13T00:00:00Z"}.
The caller fixes expectations before executing the task; never copy them from its report.
Report: {"schema": "bob-task-result/v1", "run_id": "caller-created-unique-id",
  "subject": "source-freshness", "completed_at": "2026-11-13T00:01:00Z",
  "verdict": "pass", "exit_code": 0}. Verdicts: pass/fail/blocked/in_progress.
Incomplete reports may use null completed_at and exit_code. Covered requires a completed
pass with exit_code 0. This checks evidence consistency, not the truth of its assertions.
Report paths must stay below the record directory, without symlinks, sensitive names,
or files larger than 64 KiB. Legacy units still work but establish no domain verdict.
The run object permits only its four documented fields; report extras are permitted
for diagnostics. Completion cannot be in the future. The caller's record directory
is a trusted boundary; link checks apply to the report path beneath that directory.

Usage:  python3 coverage-check.py RECORD.json [--draft]
        --draft  mid-run: skip rules 5 and 7 (work may still be in flight)
Exit:   0 = record is sound · 1 = at least one rule broken · 2 = cannot read the file
"""
import json, sys, os, stat
from pathlib import Path
from datetime import datetime, timezone

STATES = ["planned", "in_progress", "covered", "candidate", "blocked", "deferred", "out_of_scope"]
VERDICTS = {"confirmed", "needs_checking", "rejected"}
SOURCES = {"self_reported", "observed"}

def full(x):
    return isinstance(x, str) and x.strip() != "" or isinstance(x, list) and any(str(i).strip() for i in x)

MAX_REPORT_BYTES = 65536

def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("timestamp must be a timezone-aware string")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return dt

def read_report(base_dir, name):
    # Open each component without following links, including at read time.
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("report must be a relative JSON path")
    parts = name.split("/")
    if any(p in ("", ".", "..") for p in parts) or not name.endswith(".json"):
        raise ValueError("report must be a relative JSON path without traversal")
    for part in parts:
        low = part.lower()
        if (low.startswith(".env") or low in {".ssh", ".aws", "keys"}
                or any(word in low for word in ("password", "credential", "cookie", "wallet", "secret", "token", "api-key", "api_key", "private-key", "private_key"))
                or low.endswith((".pem", ".key", ".p12", ".pfx"))):
            raise ValueError("report path names a sensitive location")
    if base_dir is None:
        raise ValueError("run evidence needs the record's base_dir")
    # The caller's record directory is the trusted root (ancestors may include OS aliases).
    # Every report component below that root must be link-free.
    fd = os.open(base_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        report_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(report_fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPORT_BYTES:
                raise ValueError("report must be a bounded regular file")
            data = stream.read(MAX_REPORT_BYTES + 1)
            if len(data) > MAX_REPORT_BYTES:
                raise ValueError("report is too large")
        return json.loads(data)
    finally:
        os.close(fd)

def check_run(run, state, base_dir):
    try:
        if not isinstance(run, dict):
            raise ValueError("run must be an object")
        if set(run) - {"report", "expected_run_id", "expected_subject", "not_before"}:
            raise ValueError("run contains unknown fields")
        for field in ("expected_run_id", "expected_subject"):
            if not isinstance(run.get(field), str) or not run[field].strip():
                raise ValueError(f"run needs nonempty {field}")
        cutoff = timestamp(run.get("not_before"))
        report = read_report(base_dir, run.get("report"))
        if not isinstance(report, dict) or report.get("schema") != "bob-task-result/v1":
            raise ValueError("report needs schema bob-task-result/v1")
        if report.get("run_id") != run["expected_run_id"]:
            raise ValueError("report run_id differs from expected_run_id")
        if report.get("subject") != run["expected_subject"]:
            raise ValueError("report subject differs from expected_subject")
        verdict = report.get("verdict")
        if not isinstance(verdict, str) or verdict not in {"pass", "fail", "blocked", "in_progress"}:
            raise ValueError("report has invalid verdict")
        if "exit_code" not in report or (report["exit_code"] is not None and type(report["exit_code"]) is not int):
            raise ValueError("report exit_code must be integer or null")
        if "completed_at" not in report:
            raise ValueError("report needs completed_at (null when incomplete)")
        completed = None if report["completed_at"] is None else timestamp(report["completed_at"])
        if completed is not None and completed > datetime.now(timezone.utc):
            raise ValueError("report completion is in the future")
        if completed is not None and completed < cutoff:
            raise ValueError("report completed before not_before")
        if verdict == "pass" and (report["exit_code"] != 0 or completed is None):
            raise ValueError("passing report needs exit_code 0 and completion timestamp")
        if state == "covered" and (verdict != "pass" or report["exit_code"] != 0 or completed is None):
            raise ValueError("covered run needs a completed passing task result with exit_code 0")
    except (OSError, ValueError, TypeError, OverflowError, RecursionError) as exc:
        return str(exc)
    return None

def check(rec, draft=False, base_dir=None):
    errs, seen = [], set()
    if not isinstance(rec, dict):
        return ["record must be an object"]
    units = rec.get("units")
    if not isinstance(units, list) or not units:
        return ["record has no units — an audit with nothing planned has not been planned"]
    for i, u in enumerate(units):
        if not isinstance(u, dict):
            errs.append(f"unit #{i + 1}: must be an object"); continue
        uid, st = u.get("id"), u.get("state")
        tag = f"unit {uid or '#' + str(i + 1)}"
        if not isinstance(uid, str) or not uid.strip(): errs.append(f"{tag}: no string id")
        elif uid in seen: errs.append(f"{tag}: id used twice")
        if isinstance(uid, str): seen.add(uid)
        if st not in STATES:
            errs.append(f"{tag}: state {st!r} is not one of {', '.join(STATES)}"); continue
        if "run" in u:
            problem = check_run(u["run"], st, base_dir)
            if problem: errs.append(f"{tag}: {problem}")
        has_ev = full(u.get("files")) or full(u.get("checks")) or "run" in u
        if st == "covered" and not (full(u.get("files")) and full(u.get("checks"))):
            errs.append(f"{tag}: 'covered' needs both the files read and the checks made")
        if st == "covered" and u.get("source") not in tuple(SOURCES):
            errs.append(f"{tag}: 'covered' needs source 'self_reported' or 'observed' — "
                        f"stamp whether 'clean' is a claim or an observed fact")
        if st in ("deferred", "out_of_scope") and not full(u.get("reason")):
            errs.append(f"{tag}: '{st}' needs a reason")
        if st == "deferred" and has_ev:
            errs.append(f"{tag}: 'deferred' carries evidence — partial work belongs in 'blocked'")
        if st == "blocked" and not full(u.get("missing_fact")):
            errs.append(f"{tag}: 'blocked' must name the missing fact")
        if not draft and st in ("planned", "in_progress"):
            errs.append(f"{tag}: still '{st}' at close — mark it 'deferred' with a reason")
    findings = rec.get("findings")
    if findings is None: findings = []
    if not isinstance(findings, list):
        errs.append("findings must be a list"); findings = []
    for f in findings:
        if not isinstance(f, dict):
            errs.append("finding must be an object"); continue
        tag = f"finding {f.get('id', '?')}"
        v = f.get("verdict")
        if v not in tuple(VERDICTS):
            errs.append(f"{tag}: verdict {v!r} is not confirmed / needs_checking / rejected"); continue
        if v == "needs_checking":
            if full(f.get("severity")): errs.append(f"{tag}: 'needs checking' must carry no severity")
            if not full(f.get("missing_fact")): errs.append(f"{tag}: 'needs checking' must name the missing fact")
            if not full(f.get("safe_check")): errs.append(f"{tag}: 'needs checking' must give a safe way to find out")
    if not draft:
        s = rec.get("statement")
        if not isinstance(s, dict):
            errs.append("no closing statement — say what was checked, what was not, and why")
        else:
            want = {"planned": len(units)}
            for st in STATES[2:]: want[st] = sum(1 for u in units if isinstance(u, dict) and u.get("state") == st)
            for k, n in want.items():
                if s.get(k) != n: errs.append(f"statement says {k} = {s.get(k)!r}, the units say {n}")
    return errs

def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.split("Usage:")[1].split("Exit:")[0].strip()); return 2
    try:
        rec = json.load(open(args[0], encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as e:
        print(f"coverage-check: cannot read {args[0]}: {e}"); return 2
    errs = check(rec, draft="--draft" in argv, base_dir=Path(args[0]).absolute().parent)
    for e in errs: print("  FAIL  " + e)
    units = rec.get("units") if isinstance(rec, dict) else None
    n = len(units) if isinstance(units, list) else 0
    if isinstance(units, list) and any(isinstance(u, dict) and "run" not in u for u in units):
        print("  NOTE  units without run evidence do not establish domain verdicts")
    print(f"coverage-check: {n} units, {len(errs)} problem(s)" + (" — OK" if not errs else ""))
    return 1 if errs else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
