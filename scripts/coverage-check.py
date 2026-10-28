#!/usr/bin/env python3
"""coverage-check.py — checks an audit's coverage record (audit-lenses/_evidence-accounting.md).

Turns the written rules of _evidence-accounting.md §1-§2 into a check that fails loudly,
because the rules that held in Bob were the ones turned into code. Bob's own script; the idea
(a checker for the coverage record) comes from cloudflare/security-audit-skill, whose checker
is security-specific and was not copied.

What it refuses (each line is one rule in _evidence-accounting.md):
  1  a unit with no id, a repeated id, or a state that is not one of the seven
  2  a `covered` unit without evidence: no files read, or no checks made          (§1 rule 2)
  3  a `deferred` / `out_of_scope` unit with no reason, or a `deferred` unit
     hiding partial evidence (put partial work in `blocked`, not `deferred`)      (§1 rule 3)
  4  a `blocked` unit that does not name the missing fact                          (§1 states)
  5  a unit still `planned` / `in_progress` at close — unreached work must be
     `deferred` with a reason, never silently dropped                            (§1 rule 3)
  6  a "needs checking" finding that carries a severity, or lacks the missing
     fact or a safe way to find out                                               (§2)
  7  a closing statement that is missing or whose counts do not match the units  (closing statement)

Record format (JSON):
  {"units": [{"id": "U1", "state": "covered", "files": ["api/orders.ts"], "checks": ["owner check on GET"],
              "reason": "", "missing_fact": ""}, ...],
   "findings": [{"id": "F1", "verdict": "confirmed|needs_checking|rejected", "severity": "Major",
                 "missing_fact": "", "safe_check": ""}, ...],
   "statement": {"planned": 12, "covered": 8, "candidate": 0, "blocked": 1, "deferred": 2, "out_of_scope": 1}}
  `statement.planned` is the total number of units; each other count must equal the units in that state.

Usage:  python3 coverage-check.py RECORD.json [--draft]
        --draft  mid-run: skip rules 5 and 7 (work may still be in flight)
Exit:   0 = record is sound · 1 = at least one rule broken · 2 = cannot read the file
"""
import json, sys

STATES = ["planned", "in_progress", "covered", "candidate", "blocked", "deferred", "out_of_scope"]
VERDICTS = {"confirmed", "needs_checking", "rejected"}

def full(x):
    return isinstance(x, str) and x.strip() != "" or isinstance(x, list) and any(str(i).strip() for i in x)

def check(rec, draft=False):
    errs, seen = [], set()
    units = rec.get("units")
    if not isinstance(units, list) or not units:
        return ["record has no units — an audit with nothing planned has not been planned"]
    for i, u in enumerate(units):
        uid, st = u.get("id"), u.get("state")
        tag = f"unit {uid or '#' + str(i + 1)}"
        if not full(uid): errs.append(f"{tag}: no id")
        elif uid in seen: errs.append(f"{tag}: id used twice")
        seen.add(uid)
        if st not in STATES:
            errs.append(f"{tag}: state {st!r} is not one of {', '.join(STATES)}"); continue
        has_ev = full(u.get("files")) or full(u.get("checks"))
        if st == "covered" and not (full(u.get("files")) and full(u.get("checks"))):
            errs.append(f"{tag}: 'covered' needs both the files read and the checks made")
        if st in ("deferred", "out_of_scope") and not full(u.get("reason")):
            errs.append(f"{tag}: '{st}' needs a reason")
        if st == "deferred" and has_ev:
            errs.append(f"{tag}: 'deferred' carries evidence — partial work belongs in 'blocked'")
        if st == "blocked" and not full(u.get("missing_fact")):
            errs.append(f"{tag}: 'blocked' must name the missing fact")
        if not draft and st in ("planned", "in_progress"):
            errs.append(f"{tag}: still '{st}' at close — mark it 'deferred' with a reason")
    for f in rec.get("findings") or []:
        tag = f"finding {f.get('id', '?')}"
        v = f.get("verdict")
        if v not in VERDICTS:
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
            for st in STATES[2:]: want[st] = sum(1 for u in units if u.get("state") == st)
            for k, n in want.items():
                if s.get(k) != n: errs.append(f"statement says {k} = {s.get(k)!r}, the units say {n}")
    return errs

def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.split("Usage:")[1].split("Exit:")[0].strip()); return 2
    try:
        rec = json.load(open(args[0], encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"coverage-check: cannot read {args[0]}: {e}"); return 2
    errs = check(rec, draft="--draft" in argv)
    for e in errs: print("  FAIL  " + e)
    n = len(rec.get("units") or [])
    print(f"coverage-check: {n} units, {len(errs)} problem(s)" + (" — OK" if not errs else ""))
    return 1 if errs else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
