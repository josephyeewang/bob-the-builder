#!/usr/bin/env python3
"""design-mockups CLI — generate homepage design comps for ANY project.

Usage (from a project dir containing mockup.config.json, or with DESIGN_MOCKUP_CONFIG set):
  python mockup.py archetypes [core|cinematic|modern|all]   # one comp per archetype (default all)
  python mockup.py recipe                                   # config.content_recipe across the 12 STYLES
  python mockup.py custom jobs.json                         # [{name,prompt,refs?,aspect?}, ...]
  python mockup.py gallery ["Title"]                        # (re)build consolidated searchable gallery of out_dir
The archetype/style library lives in lib/archetypes.py. Prompt-craft heuristics are in SKILL.md.
"""
import sys, os, json, pathlib
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "lib"))
import gen, archetypes, gallery  # noqa

def _open(p):
    try: os.system(f'open "{p}"')
    except Exception: pass

def cmd_archetypes(which="all"):
    pool = {"core": archetypes.ARCHETYPES, "cinematic": archetypes.CINEMATIC, "modern": archetypes.MODERN,
            "all": archetypes.ARCHETYPES + archetypes.CINEMATIC + archetypes.MODERN}[which]
    jobs = [{"name": f"arch-{name}", "prompt": gen.anchor() + "STYLE — " + frag + gen.rules()} for name, frag in pool]
    print(f"Generating {len(jobs)} archetypes -> {gen.OUT}")
    gen.run_batch(jobs, workers=int(gen.CFG.get("workers", 6)))
    _sheet_and_gallery()

def cmd_recipe():
    recipe = gen.CFG.get("content_recipe")
    if not recipe: sys.exit("Set 'content_recipe' in mockup.config.json to use recipe mode.")
    jobs = [{"name": f"recipe-{code}", "prompt": gen.anchor() + "CONTENT: " + recipe + " ART DIRECTION: " + desc + gen.rules()}
            for code, desc in archetypes.STYLES]
    print(f"Generating recipe across {len(jobs)} styles -> {gen.OUT}")
    gen.run_batch(jobs, workers=int(gen.CFG.get("workers", 5)))
    _sheet_and_gallery()

def cmd_custom(path):
    jobs = json.loads(pathlib.Path(path).read_text())
    for j in jobs:  # allow shorthand: prompt gets anchor+rules unless it already looks composed
        if j.get("compose", True):
            j["prompt"] = gen.anchor() + j["prompt"] + gen.rules()
    print(f"Generating {len(jobs)} custom comps -> {gen.OUT}")
    gen.run_batch(jobs, workers=int(gen.CFG.get("workers", 5)))
    _sheet_and_gallery()

def _sheet_and_gallery():
    out = str(gen.OUT)
    gallery.contact_sheet(os.path.join(out, "*.png"), os.path.join(out, "_contact.png"))
    p, n = gallery.consolidated(out, os.path.join(out, "gallery-ALL.html"),
                                title=f"{gen.CFG.get('product_name','Project')} — mockups")
    print(f"gallery: {p} ({n})"); _open(p)

def cmd_gallery(title=None):
    out = str(gen.OUT)
    p, n = gallery.consolidated(out, os.path.join(out, "gallery-ALL.html"),
                                title=title or f"{gen.CFG.get('product_name','Project')} — mockups")
    print(f"gallery: {p} ({n})"); _open(p)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "archetypes": cmd_archetypes(sys.argv[2] if len(sys.argv) > 2 else "all")
    elif cmd == "recipe": cmd_recipe()
    elif cmd == "custom": cmd_custom(sys.argv[2])
    elif cmd == "gallery": cmd_gallery(sys.argv[2] if len(sys.argv) > 2 else None)
    else: print(__doc__)
