#!/usr/bin/env python3
"""Reusable gallery builders: a labeled contact sheet for a glob, and one
consolidated searchable HTML gallery of an entire output dir."""
import glob, os, re
from PIL import Image, ImageDraw, ImageFont

def _nat(f): return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', os.path.basename(f))]
def _font(sz):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

def contact_sheet(pattern, out_path, cols=4, tw=400, label_strip=""):
    files = sorted(glob.glob(pattern), key=_nat)
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

def consolidated(out_dir, html_path, sections=None, title="All renders"):
    """sections: list of (title, glob) in order; defaults to everything in out_dir."""
    if sections is None:
        sections = [("All", os.path.join(out_dir, "*.png"))]
    seen = set(); built = []; total = 0
    for t, pat in sections:
        fs = [f for f in sorted(glob.glob(pat), key=_nat) if f not in seen]
        for f in fs: seen.add(f)
        if fs: built.append((t, fs)); total += len(fs)
    sid = lambda t: re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')
    nav = "".join(f'<a href="#{sid(t)}">{t} ({len(fs)})</a>' for t, fs in built)
    body = []
    for t, fs in built:
        body.append(f'<h2 id="{sid(t)}">{t} <span class=c>· {len(fs)}</span></h2><div class=grid>')
        for f in fs:
            n = os.path.basename(f).replace(".png", "")
            body.append(f'<figure data-n="{n.lower()}"><img loading=lazy src="{f}"><figcaption>{n}</figcaption></figure>')
        body.append("</div>")
    html = f'''<!doctype html><meta charset=utf8><title>{title} ({total})</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#0c0c0e;color:#eee;font:13px -apple-system,system-ui,sans-serif}}
header{{position:sticky;top:0;z-index:9;background:#141416ee;backdrop-filter:blur(8px);padding:12px 20px;border-bottom:1px solid #262629}}
header h1{{margin:0 0 8px;font-size:16px}}#search{{width:100%;max-width:420px;padding:8px 12px;border-radius:8px;border:1px solid #333;background:#1c1c1f;color:#eee;font-size:14px}}
nav{{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}}nav a{{color:#bbb;text-decoration:none;font-size:11.5px;background:#1c1c1f;border:1px solid #2a2a2d;padding:4px 9px;border-radius:999px}}nav a:hover{{color:#fff}}
h2{{padding:22px 22px 6px;font-size:15px;color:#ffdc78}}h2 .c{{color:#777;font-weight:400}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:4px 20px 18px}}
figure{{margin:0;background:#161618;border:1px solid #232326;border-radius:9px;overflow:hidden}}img{{width:100%;display:block}}
figcaption{{padding:7px 9px;font:600 11.5px ui-monospace,Menlo,monospace;color:#cfcfd2;user-select:all;word-break:break-all}}
figure.hide{{display:none}}@media(max-width:900px){{.grid{{grid-template-columns:repeat(2,1fr)}}}}</style>
<header><h1>{title} · {total} designs</h1><input id=search placeholder="filter by name…"><nav>{nav}</nav></header>
{"".join(body)}
<script>const q=document.getElementById('search');q.addEventListener('input',()=>{{const v=q.value.trim().toLowerCase();
document.querySelectorAll('figure').forEach(f=>f.classList.toggle('hide',v&&!f.dataset.n.includes(v)));
document.querySelectorAll('h2').forEach(h=>{{let n=h.nextElementSibling,a=[...n.children].some(f=>!f.classList.contains('hide'));h.style.display=a?'':'none';n.style.display=a?'':'none';}});}});</script>'''
    open(html_path, "w").write(html); return html_path, total
