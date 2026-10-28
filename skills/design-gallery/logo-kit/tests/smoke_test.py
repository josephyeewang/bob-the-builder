#!/usr/bin/env python3
# Adapted from kaankiziltug/logo-design-skill @ 7340903 (v1.4.5), tools/smoke_test.py.
# Copyright (c) 2026 kaankiziltug. MIT License — full text in ../LICENSE (logo-kit/LICENSE).
# Changes (2026-10-27): paths point at logo-kit/scripts; dropped the checks for parts logo-kit does not ship
# (plugin manifests/SKILL.md frontmatter, the logo library, build_catalog, search_library, presentation_board,
# package_skill); preview_sheet uses --refs with local fixtures instead of --refs-industry.
"""Smoke-test every logo-kit script the way an agent runs them.

  python3 tests/smoke_test.py            # from the logo-kit/ folder; PNG checks run when a renderer is available

Each script runs in a subprocess with the platform's default console encoding, so crashes such as
UnicodeEncodeError on report symbols are caught. Standard library only.
"""
import os
import shutil
import subprocess
import sys
import tempfile

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(KIT, "scripts")

SYMBOL = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>Test symbol</title>
<circle cx="128" cy="128" r="96" fill="#0F7C80"/>
<path d="M80 150 L176 146 L176 170 L80 174 Z" fill="#FFFFFF"/></svg>
"""
LOCKUP = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 256"><title>Test lockup</title>
<circle cx="128" cy="128" r="96" fill="#0F7C80"/>
<rect x="280" y="100" width="560" height="56" rx="8" fill="#161616"/></svg>
"""
REF = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>Reference</title>
<rect x="48" y="48" width="160" height="160" rx="24" fill="#333333"/></svg>
"""

failures = []


def run(name, args, expect=(), cwd=None):
    """Run a script; fail on non-zero exit, a traceback, or missing expected text/files."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONIOENCODING", "PYTHONUTF8")}
    p = subprocess.run([sys.executable] + args, cwd=cwd or KIT, env=env, capture_output=True)
    out = (p.stdout + p.stderr).decode("utf-8", "replace")
    problems = []
    if p.returncode != 0:
        problems.append(f"exit code {p.returncode}")
    if "Traceback (most recent call last)" in out:
        problems.append("traceback")
    for e in expect:
        if os.path.isabs(e):
            if not os.path.exists(e):
                problems.append(f"missing file {e}")
        elif e not in out:
            problems.append(f"output lacks {e!r}")
    status = "ok  " if not problems else "FAIL"
    print(f"[{status}] {name}")
    if problems:
        failures.append(name)
        print("       " + "; ".join(problems))
        print("       " + out.strip().replace("\n", "\n       ")[-2500:])
    return out


def main():
    tmp = tempfile.mkdtemp(prefix="logo-smoke-")
    try:
        sym, lock, ref = (os.path.join(tmp, f) for f in ("a-symbol.svg", "a-lockup.svg", "ref.svg"))
        for path, body in ((sym, SYMBOL), (lock, LOCKUP), (ref, REF)):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
        S = lambda f: os.path.join(SCRIPTS, f)

        run("svg_audit (fixtures)", [S("svg_audit.py"), sym, lock], ["production-readiness score"])
        run("svg_audit --json", [S("svg_audit.py"), "--json", sym])
        run("concept_sheet", [S("concept_sheet.py"), sym, sym, "--lockups", lock, lock, "--names", "A", "B",
                              "--notes", "One.", "Two.", "--recommend", "1", "-o", os.path.join(tmp, "concepts.png")],
            [os.path.join(tmp, "concepts.svg")])
        run("preview_sheet", [S("preview_sheet.py"), sym, lock, "--refs", ref,
                              "-o", os.path.join(tmp, "preview.html")], [os.path.join(tmp, "preview.html")])
        run("preview_sheet --compare-only", [S("preview_sheet.py"), sym, lock, "--compare-only",
                                             "-o", os.path.join(tmp, "compare.html")], [os.path.join(tmp, "compare.html")])
        run("export_variants (SVG)", [S("export_variants.py"), sym, "--out-dir", os.path.join(tmp, "export"),
                                      "--mono", "#0F7C80", "--icon-bg", "#0F7C80"])
        which = run("render_png --which", [S("render_png.py"), "--which"])
        if "available backends: none" not in which and "available backends:" in which:
            png = os.path.join(tmp, "a.png")
            run("render_png (PNG)", [S("render_png.py"), sym, "-o", png, "--size", "64"], [png])
            run("export_variants --web-icons", [S("export_variants.py"), sym, "--out-dir", os.path.join(tmp, "web"),
                                               "--icon-bg", "#0F7C80", "--web-icons"],
                [os.path.join(tmp, "web", "favicon.ico")])
        else:
            print("[skip] PNG checks (no renderer on this machine)")

        caches = [d for d, _, _ in os.walk(KIT) if os.path.basename(d) == "__pycache__"]
        print(f"[{'ok  ' if not caches else 'FAIL'}] no __pycache__ written into the logo-kit folder")
        if caches:
            failures.append("__pycache__ in logo-kit folder: " + ", ".join(caches))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    main()
