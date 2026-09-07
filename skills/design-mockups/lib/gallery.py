#!/usr/bin/env python3
"""Reusable gallery builders + the numbering SSOT.

canonical_files()/num2file() define THE stable gallery numbering (ported from the
EMBT source: explain-my-blood-test/_mockups/imggen/run_winners.py lines 8-29 and
run_soph.py lines 6-26). Every board (consolidated / grouped / curated) numbers
figures from this same map, so "the user said #117" always resolves to the same
file — gallery numbers and ref-resolver numbers can never drift.
"""
import glob, os, re, pathlib
from PIL import Image, ImageDraw, ImageFont

def _nat(f): return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', os.path.basename(f))]
def _font(sz):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

# ---------------------------------------------------------------- numbering SSOT
# Ordered glob patterns -> natural sort within each -> dedupe (ported from
# run_winners.py:9-14 / run_soph.py:7-12). A final "*.png" catch-all is ADDED so
# project-agnostic names (win*-, soph-, custom names) still get stable numbers.
CANON_PATTERNS = ["A[0-9]*.png", "B[0-9]*.png", "arch-[0-9]*.png", "arch-C*.png", "arch-M*.png",
                  "AD*.png", "theme-*.png", "s2-*.png", "S[0-9]*.png", "final-*.png",
                  "hyb-*.png", "ad-*.png", "recipe-*.png", "*.png"]

# The 13-bucket keyword classifier, verbatim from run_winners.py:15 / run_soph.py:13.
GROUPS = [("phys", ["phys", "hands"]),
          ("prod", ["product", "glass", "bento", "depth-glass", "glassmorph", "neumorph", "premium-dark-ui"]),
          ("sci", ["scientific", "science", "data-art", "data-ui", "data-dense", "data-lightart", "data-sculpture", "editorial-data", "dark-data"]),
          ("fash", ["fashion", "studio-photo", "photo-human", "photography", "filmic-photo", "filmic-graded", "photo"]),
          ("pers", ["person", "human", "wellness"]),
          ("blood", ["blood", "vial", "drop", "artful", "abstract", "lightart", "lightfield", "volumetric"]),
          ("mono", ["mono", "obys", "monochrome", "chiaroscuro"]),
          ("cine", ["cinematic", "cine", "film", "a24", "dark", "atmospheric", "immersive", "luxe", "title"]),
          ("warm", ["warm"]),
          ("clean", ["clean", "apple", "minimal", "swiss", "museum", "kinfolk", "quiet", "architectural", "scandinav", "spa", "aurora", "gradient", "futur"]),
          ("bold", ["bold", "type", "kinetic", "grotesk", "colorfield", "color-field"]),
          ("paint", ["painterly", "fineart", "fine-art"])]

# Human section titles per bucket, from the source gallery-grouped.html nav.
BUCKET_TITLES = {"phys": "Physical report & hands", "prod": "Product-hero & glass panels",
                 "sci": "Scientific & data-viz", "fash": "Fashion & studio photography",
                 "pers": "Person / human-in-use", "blood": "Artful lab / blood / abstract",
                 "mono": "Monochrome / B&W editorial", "cine": "Cinematic / dark / film",
                 "warm": "Warm editorial", "clean": "Clean / minimal / museum / apple",
                 "bold": "Bold editorial & kinetic type", "paint": "Painterly / fine-art",
                 "z": "Other"}

def classify(filename):
    """Keyword -> style bucket; 'z' = other. Ported verbatim from run_winners.py:16-20."""
    n = os.path.basename(str(filename)).lower()
    for t, ks in GROUPS:
        if any(k in n for k in ks):
            return t
    return "z"

def _is_render(f):
    """A numberable render: excludes board outputs living in out_dir (contact/round
    sheets) and anything moved to _deleted (prune-not-delete convention)."""
    b = os.path.basename(f)
    return not (b.startswith("_") or b.endswith("-sheet.png"))

def canonical_files(out_dir):
    """The stable numbering pool, in canonical order. Ported from run_winners.py:8-26:
    pattern order -> natural sort -> dedupe -> classifier buckets in GROUPS order,
    'z' (other) last. out_dir/_deleted is excluded (glob doesn't descend)."""
    seen = set(); allf = []
    for p in CANON_PATTERNS:
        for f in sorted(glob.glob(os.path.join(str(out_dir), p)), key=_nat):
            if f not in seen and _is_render(f):
                seen.add(f); allf.append(f)
    bk = {t: [] for t, _ in GROUPS}; bk["z"] = []          # run_winners.py:21-22
    for f in allf:
        bk[classify(f)].append(f)
    ordered = []
    for t, _ in GROUPS:                                     # run_winners.py:23-25
        ordered += bk[t]
    ordered += bk["z"]
    return [pathlib.Path(f) for f in ordered]

def num2file(out_dir):
    """Stable gallery number -> file path (ported from run_winners.py:26)."""
    return {i + 1: f for i, f in enumerate(canonical_files(out_dir))}

# ---------------------------------------------------------------- contact sheets
def contact_sheet(pattern, out_path, cols=4, tw=400, label_strip=""):
    """pattern: a glob string OR an explicit list of file paths."""
    files = [str(f) for f in pattern] if isinstance(pattern, (list, tuple)) else sorted(glob.glob(pattern), key=_nat)
    files = [f for f in files if os.path.exists(f)]
    if not files: return None
    thumbs = [Image.open(f).convert("RGB") for f in files]
    thumbs = [t.resize((tw, int(t.height * (tw / t.width)))) for t in thumbs]
    labs = [os.path.basename(f).replace(label_strip, "").replace(".png", "") for f in files]
    rowh = max(t.height for t in thumbs) + 30; rows = (len(thumbs) + cols - 1) // cols
    s = Image.new("RGB", (cols * tw, rows * rowh), (244, 243, 241)); d = ImageDraw.Draw(s); font = _font(17)
    for i, (t, l) in enumerate(zip(thumbs, labs)):
        r, c = divmod(i, cols); x, y = c * tw, r * rowh
        d.text((x + 6, y + 5), l, fill=(15, 15, 15), font=font); s.paste(t, (x, y + 26))
    s.save(out_path); return out_path

# ---------------------------------------------------------------- board renderer
def _render(html_path, title, built, numof):
    """Shared searchable dark board. built: [(section_title, files, star)]; numof:
    str(path)->stable number. Star sections get the green #7CFC7C h2 accent, others
    the #ffdc78 yellow — both from the source gallery-curated.html/gallery-grouped.html."""
    total = sum(len(fs) for _, fs, _ in built)
    base = os.path.dirname(os.path.abspath(html_path))
    sid = lambda t: re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')
    nav, body = [], []
    for t, fs, star in built:
        label = ("★ " if star else "") + t
        nav.append(f'<a href="#{sid(t)}">{label} ({len(fs)})</a>')
        style = ' style="color:#7CFC7C"' if star else ''       # gallery-curated.html: starred h2s are green
        body.append(f'<h2 id="{sid(t)}"{style}>{label} <span class=c>· {len(fs)}</span></h2><div class=grid>')
        for f in fs:
            f = str(f); num = numof[f]
            n = os.path.basename(f).replace(".png", "")
            src = os.path.relpath(os.path.abspath(f), base)
            body.append(f'<figure data-n="{num} {n.lower()}"><span class=num>{num}</span>'
                        f'<img loading=lazy src="{src}"><figcaption><b>#{num}</b> · {n}</figcaption></figure>')
        body.append("</div>")
    html = f'''<!doctype html><meta charset=utf8><title>{title} ({total})</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#0c0c0e;color:#eee;font:13px -apple-system,system-ui,sans-serif}}
header{{position:sticky;top:0;z-index:9;background:#141416ee;backdrop-filter:blur(8px);padding:12px 20px;border-bottom:1px solid #262629}}
header h1{{margin:0 0 8px;font-size:16px}}#search{{width:100%;max-width:420px;padding:8px 12px;border-radius:8px;border:1px solid #333;background:#1c1c1f;color:#eee;font-size:14px}}
nav{{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}}nav a{{color:#bbb;text-decoration:none;font-size:11.5px;background:#1c1c1f;border:1px solid #2a2a2d;padding:4px 9px;border-radius:999px}}nav a:hover{{color:#fff}}
h2{{padding:22px 22px 6px;font-size:15px;color:#ffdc78}}h2 .c{{color:#777;font-weight:400}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:4px 20px 18px}}
figure{{margin:0;background:#161618;border:1px solid #232326;border-radius:9px;overflow:hidden;position:relative}}img{{width:100%;display:block}}
.num{{position:absolute;top:8px;left:8px;background:#000c;color:#ffdc78;font:800 15px ui-monospace,Menlo,monospace;padding:3px 9px;border-radius:7px;border:1px solid #ffffff22}}
figcaption{{padding:7px 9px;font:600 11.5px ui-monospace,Menlo,monospace;color:#cfcfd2;user-select:all;word-break:break-all}}
figure.hide{{display:none}}@media(max-width:900px){{.grid{{grid-template-columns:repeat(2,1fr)}}}}</style>
<header><h1>{title} · {total} designs</h1><input id=search placeholder="filter by number or name…"><nav>{"".join(nav)}</nav></header>
{"".join(body)}
<script>const q=document.getElementById('search');q.addEventListener('input',()=>{{const v=q.value.trim().toLowerCase();
document.querySelectorAll('figure').forEach(f=>f.classList.toggle('hide',v&&!f.dataset.n.includes(v)));
document.querySelectorAll('h2').forEach(h=>{{let n=h.nextElementSibling,a=[...n.children].some(f=>!f.classList.contains('hide'));h.style.display=a?'':'none';n.style.display=a?'':'none';}});}});</script>'''
    open(html_path, "w").write(html); return html_path, total

def _numof(out_dir):
    """str(path) -> canonical number, shared by every board (no drift)."""
    return {str(f): i + 1 for i, f in enumerate(canonical_files(out_dir))}

# ---------------------------------------------------------------- the 3 boards
def consolidated(out_dir, html_path, sections=None, title="All renders"):
    """One searchable board. Figure numbers come from the canonical numbering
    (num2file), NOT a per-board counter, so they match grouped/curated and refs.
    sections: optional list of (title, glob) in order; defaults to the canonical pool."""
    numof = _numof(out_dir); extra = len(numof)
    if sections is None:
        built = [("All", canonical_files(out_dir), False)]
    else:
        seen = set(); built = []
        for t, pat in sections:
            fs = [f for f in sorted(glob.glob(pat), key=_nat) if f not in seen and _is_render(f)]
            for f in fs:
                seen.add(f)
                if f not in numof:            # a file outside the canonical pool still gets a number
                    extra += 1; numof[f] = extra
            if fs: built.append((t, fs, False))
    return _render(html_path, title, built, numof)

def grouped(out_dir, html_path=None, title="Grouped by style"):
    """gallery-grouped.html — auto-sections from classify() in GROUPS order, 'Other'
    last (structure ported from the source gallery-grouped.html; classifier from
    run_winners.py:15-25). Section order == canonical order, so numbers run 1..N."""
    canon = canonical_files(out_dir)
    built = []
    for t in [g for g, _ in GROUPS] + ["z"]:
        fs = [f for f in canon if classify(f.name) == t]
        if fs: built.append((BUCKET_TITLES[t], fs, False))
    html_path = html_path or os.path.join(str(out_dir), "gallery-grouped.html")
    return _render(html_path, title, built, _numof(out_dir))

def curated(out_dir, sections, html_path=None, title="Curated — your themes on top"):
    """gallery-curated.html — hand-authored themed board (structure ported from the
    source gallery-curated.html; number resolution from run_winners.py:26-29).
    sections: [{title, nums?: [int], names?: [str], star?: bool}]. Starred h2s get
    the green #7CFC7C accent. A '— Remainder (everything else)' section is ALWAYS
    appended so no render is ever dropped from the board."""
    canon = canonical_files(out_dir)
    n2f = {i + 1: f for i, f in enumerate(canon)}
    byname = {}
    for f in canon:
        byname[f.name] = f; byname[f.stem] = f
    used = set(); built = []
    for s in sections:
        fs = []
        for n in (s.get("nums") or []):
            f = n2f.get(int(n))
            if f is None:
                raise SystemExit(f"curated: #{n} is not on the board (numbering is 1..{len(canon)} in {out_dir})")
            fs.append(f)
        for nm in (s.get("names") or []):
            f = byname.get(nm)
            if f is None:
                raise SystemExit(f"curated: '{nm}' not found in {out_dir}")
            fs.append(f)
        fs = [f for f in fs if str(f) not in used]
        used.update(str(f) for f in fs)
        built.append((s["title"], fs, bool(s.get("star"))))
    rem = [f for f in canon if str(f) not in used]           # never drop a render
    built.append(("— Remainder (everything else)", rem, False))
    html_path = html_path or os.path.join(str(out_dir), "gallery-curated.html")
    return _render(html_path, title, built, _numof(out_dir))

# ---------------------------------------------------------------- per-round board
def round_board(out_dir, round_name, files=None, title=None):
    """Per-round pair: {round}-sheet.png + {round}-gallery.html. Ported from the
    source's per-round pairs (winners-sheet.png + winners-gallery.html, soph-sheet.png
    + soph-gallery.html); the light mini-gallery form is winners-gallery.html verbatim."""
    out_dir = str(out_dir)
    if files is None:
        files = sorted(glob.glob(os.path.join(out_dir, f"{round_name}*.png")), key=_nat)
    files = [str(f) for f in files if os.path.exists(str(f)) and _is_render(str(f))]
    if not files: return None
    sheet = os.path.join(out_dir, f"{round_name}-sheet.png")
    contact_sheet(files, sheet)
    hp = os.path.join(out_dir, f"{round_name}-gallery.html")
    figs = "".join(f'<figure><figcaption>{os.path.basename(f)[:-4]}</figcaption>'
                   f'<img src="{os.path.relpath(os.path.abspath(f), os.path.abspath(out_dir))}"></figure>' for f in files)
    html = (f'<!doctype html><meta charset=utf8><title>{title or round_name}</title>'
            '<style>body{margin:0;background:#0d0d0d;color:#eee;font:13px sans-serif}h1{padding:18px 26px}'
            '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:0 26px 40px}'
            'figure{margin:0;background:#1a1a1a;border-radius:9px;overflow:hidden}'
            'figcaption{padding:8px 11px;font:600 12px monospace;color:#ccc}img{width:100%;display:block}</style>'
            f'<h1>{title or round_name} ({len(files)})</h1><div class=grid>{figs}</div>')
    open(hp, "w").write(html)
    return sheet, hp
