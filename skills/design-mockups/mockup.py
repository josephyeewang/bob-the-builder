#!/usr/bin/env python3
"""design-mockups CLI — generate homepage design comps for ANY project.

Usage (from a project dir containing mockup.config.json, or with DESIGN_MOCKUP_CONFIG set):
  python mockup.py archetypes [core|cinematic|modern|all]   # one comp per archetype (default all)
  python mockup.py recipe                                   # config.content_recipe across the 12 STYLES
  python mockup.py custom jobs.json [round-name]            # [{name,prompt,refs?,aspect?}, ...]
                                                            #   refs = paths OR gallery NUMBERS (e.g. 117)
  python mockup.py gallery ["Title"]                        # rebuild gallery-ALL.html (canonical numbering)
  python mockup.py grouped [out_dir]                        # gallery-grouped.html — sections by style bucket
  python mockup.py curated curation.json [out_dir]          # gallery-curated.html — your themes on top
  python mockup.py reject <name-or-number>...               # prune: MOVE renders to out_dir/_deleted
                                                            #   (never deleted; excluded from numbering)

Gallery-only verbs (gallery/grouped/curated/reject) need no API key; out_dir comes from
the argument, $MOCKUP_OUT_DIR, or the config. Board numbers are the STABLE canonical
numbering (lib/gallery.py canonical_files) — cite them in feedback, refs and curation.

curation.json: [{"title": "THEME 1 — report hero (like #117)", "nums": [117, 94],
                 "names": ["win1-bold-color"], "star": true}, ...]
A "— Remainder (everything else)" section is always appended — no render is dropped.
Each generation run with a batch name also writes {round}-sheet.png + {round}-gallery.html.

The archetype/style library lives in lib/archetypes.py. Prompt-craft heuristics are in SKILL.md.
"""
import sys, os, json, pathlib
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "lib"))
import gen, archetypes, gallery  # noqa  (gen is config-LAZY: importing needs no config)

def _open(p):
    try: os.system(f'open "{p}"')
    except Exception: pass

def _resolve_out(explicit=None):
    """out_dir for the pure-gallery verbs: arg > $MOCKUP_OUT_DIR > config."""
    if explicit: return explicit
    if os.environ.get("MOCKUP_OUT_DIR"): return os.environ["MOCKUP_OUT_DIR"]
    if gen.find_config(): return str(gen.out())
    sys.exit("No out_dir: pass it as an argument, set MOCKUP_OUT_DIR, or provide mockup.config.json")

def _title(suffix="mockups"):
    name = gen.cfg().get("product_name", "Project") if gen.find_config() else "Project"
    return f"{name} — {suffix}"

def cmd_archetypes(which="all"):
    pool = {"core": archetypes.ARCHETYPES, "cinematic": archetypes.CINEMATIC, "modern": archetypes.MODERN,
            "all": archetypes.ARCHETYPES + archetypes.CINEMATIC + archetypes.MODERN}[which]
    jobs = [{"name": f"arch-{name}", "prompt": gen.anchor() + "STYLE — " + frag + gen.rules()} for name, frag in pool]
    print(f"Generating {len(jobs)} archetypes -> {gen.out()}")
    gen.run_batch(jobs, workers=int(gen.cfg().get("workers", 6)))
    _sheet_and_gallery(round_name=f"arch-{which}", jobs=jobs)

def cmd_recipe():
    recipe = gen.cfg().get("content_recipe")
    if not recipe: sys.exit("Set 'content_recipe' in mockup.config.json to use recipe mode.")
    jobs = [{"name": f"recipe-{code}", "prompt": gen.anchor() + "CONTENT: " + recipe + " ART DIRECTION: " + desc + gen.rules()}
            for code, desc in archetypes.STYLES]
    print(f"Generating recipe across {len(jobs)} styles -> {gen.out()}")
    gen.run_batch(jobs, workers=int(gen.cfg().get("workers", 5)))
    _sheet_and_gallery(round_name="recipe", jobs=jobs)

def cmd_custom(path, round_name=None):
    jobs = json.loads(pathlib.Path(path).read_text())
    for j in jobs:  # allow shorthand: prompt gets anchor+rules unless it already looks composed
        if j.get("compose", True):
            j["prompt"] = gen.anchor() + j["prompt"] + gen.rules()
    print(f"Generating {len(jobs)} custom comps -> {gen.out()}")
    gen.run_batch(jobs, workers=int(gen.cfg().get("workers", 5)))
    _sheet_and_gallery(round_name=round_name or pathlib.Path(path).stem, jobs=jobs)

def _sheet_and_gallery(round_name=None, jobs=None):
    out = str(gen.out())
    gallery.contact_sheet(gallery.canonical_files(out), os.path.join(out, "_contact.png"))
    if round_name and jobs:  # per-round board pair ({round}-sheet.png + {round}-gallery.html)
        files = [str(gen.out() / f"{j['name']}.png") for j in jobs]
        rb = gallery.round_board(out, round_name, files, title=_title(round_name))
        if rb: print(f"round board: {rb[1]}")
    p, n = gallery.consolidated(out, os.path.join(out, "gallery-ALL.html"), title=_title())
    print(f"gallery: {p} ({n})"); _open(p)

def cmd_gallery(title=None):
    out = _resolve_out(None)
    p, n = gallery.consolidated(out, os.path.join(out, "gallery-ALL.html"), title=title or _title())
    print(f"gallery: {p} ({n})"); _open(p)

def cmd_grouped(out_dir=None):
    out = _resolve_out(out_dir)
    p, n = gallery.grouped(out, title=_title("grouped by style"))
    print(f"grouped: {p} ({n})"); _open(p)

def cmd_curated(curation_path, out_dir=None):
    out = _resolve_out(out_dir)
    spec = json.loads(pathlib.Path(curation_path).read_text())
    sections = spec.get("sections", spec) if isinstance(spec, dict) else spec
    p, n = gallery.curated(out, sections, title=_title("your themes on top, remainder below"))
    print(f"curated: {p} ({n})"); _open(p)

def cmd_reject(tokens):
    """Prune-not-delete (source convention: out/_deleted): MOVE renders out of the
    numbering pool, never os.remove. Numbers/names resolve against the CURRENT board."""
    if not tokens: sys.exit("reject: give at least one render name or gallery number")
    out = _resolve_out(None)
    n2f = gallery.num2file(out)
    byname = {}
    for f in gallery.canonical_files(out):
        byname[f.name] = f; byname[f.stem] = f
    picks = []
    for t in tokens:  # resolve ALL tokens against the pre-move map first
        s = str(t).lstrip("#")
        if s.isdigit():
            f = n2f.get(int(s))
            if f is None: sys.exit(f"reject: #{s} is not on the board (pool is 1..{len(n2f)} in {out})")
        else:
            f = byname.get(s)
            if f is None: sys.exit(f"reject: '{t}' not found in {out}")
        picks.append(f)
    dest = pathlib.Path(out) / "_deleted"; dest.mkdir(exist_ok=True)
    for f in picks:
        f.rename(dest / f.name); print(f"  moved {f.name} -> _deleted/")
    print(f"{len(picks)} render(s) pruned. Numbering shifted — rebuild boards (mockup.py grouped) before citing new numbers.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "archetypes": cmd_archetypes(sys.argv[2] if len(sys.argv) > 2 else "all")
    elif cmd == "recipe": cmd_recipe()
    elif cmd == "custom":
        if len(sys.argv) < 3: sys.exit("custom: give a jobs.json path")
        cmd_custom(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "gallery": cmd_gallery(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "grouped": cmd_grouped(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "curated":
        if len(sys.argv) < 3: sys.exit("curated: give a curation.json path (shape documented above — run with no args)")
        cmd_curated(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "reject": cmd_reject(sys.argv[2:])
    else: print(__doc__)
