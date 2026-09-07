#!/usr/bin/env python3
"""Config-driven image generator (Nano Banana Pro / Gemini 3 Pro Image).
Project-agnostic core for the design-mockups capability. Reads a per-project
mockup.config.json. Never prints the API key.

Config resolution order:
  1) env DESIGN_MOCKUP_CONFIG=/path/to/mockup.config.json
  2) ./mockup.config.json in the current working directory
API key resolution:
  1) env named by config.api_key_env (default GOOGLE_AI_API_KEY)
  2) config.api_key_file (a .env-style file) -> line "<api_key_env>=..."
"""
import os, sys, json, base64, time, pathlib, urllib.request, urllib.error, concurrent.futures

def find_config():
    """Path to the config if one is resolvable, else None (no exit)."""
    p = os.environ.get("DESIGN_MOCKUP_CONFIG") or ("mockup.config.json" if pathlib.Path("mockup.config.json").exists() else None)
    return p if p and pathlib.Path(p).exists() else None

def load_config():
    p = find_config()
    if not p:
        sys.exit("No config: set DESIGN_MOCKUP_CONFIG or create ./mockup.config.json (see config.example.json)")
    return json.loads(pathlib.Path(p).read_text())

# Config is LAZY: pure-gallery verbs (gallery/grouped/curated/reject) must work
# with no config and no API key. First touch of cfg()/out() loads it.
_CFG = None
def cfg():
    global _CFG
    if _CFG is None: _CFG = load_config()
    return _CFG

def out():
    o = pathlib.Path(cfg().get("out_dir", "mockups_out")); o.mkdir(parents=True, exist_ok=True); return o

def model(): return cfg().get("model", "gemini-3-pro-image")
def aspect_default(): return cfg().get("aspect", "3:4")

def __getattr__(name):  # back-compat: gen.CFG / gen.OUT / gen.MODEL still work (PEP 562), lazily
    lazy = {"CFG": cfg, "OUT": out, "MODEL": model, "ASPECT_DEFAULT": aspect_default}
    if name in lazy: return lazy[name]()
    raise AttributeError(name)

def _api_key():
    env = cfg().get("api_key_env", "GOOGLE_AI_API_KEY")
    if os.environ.get(env): return os.environ[env]
    f = cfg().get("api_key_file")
    if f:
        fp = pathlib.Path(f).expanduser()
        if fp.exists():
            for line in fp.read_text().splitlines():
                if line.startswith(env + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit(f"No API key: set ${env} in the environment or api_key_file in config")

_KEY = None
def key():
    global _KEY
    if _KEY is None: _KEY = _api_key()
    return _KEY

def resolve_refs(refs):
    """Refs may be paths OR stable gallery NUMBERS (int, or '#117'/'117' strings when
    no such path exists) — numbers resolve via gallery.num2file. Ported from the
    num2file + R() mechanism in run_winners.py:8-29 / run_soph.py:6-26 (EMBT source)."""
    if not refs: return refs
    n2f = None; resolved = []
    for r in refs:
        n = None
        if isinstance(r, int):
            n = r
        elif isinstance(r, str):
            s = r.lstrip("#")
            if s.isdigit() and not pathlib.Path(r).exists(): n = int(s)
        if n is None:
            resolved.append(r); continue
        if n2f is None:
            import gallery                     # lazy, avoids import cycles
            n2f = gallery.num2file(str(out()))
        p = n2f.get(n)
        if not p or not pathlib.Path(p).exists():
            sys.exit(f"Ref #{n} not found in the gallery numbering of {out()} "
                     f"(pool is 1..{len(n2f)}). Check the number against the board, "
                     f"or rebuild it: mockup.py grouped")
        resolved.append(str(p))
    return resolved

def gen(prompt, out_name, refs=None, aspect=None):
    aspect = aspect or aspect_default()
    refs = resolve_refs(refs)
    parts = [{"text": prompt}]
    for r in (refs or []):
        p = pathlib.Path(r)
        if not p.exists():  # skip missing refs rather than crash the batch
            continue
        parts.append({"inline_data": {
            "mime_type": "image/jpeg" if p.suffix.lower() in (".jpg", ".jpeg") else "image/png",
            "data": base64.b64encode(p.read_bytes()).decode()}})
    body = {"contents": [{"parts": parts}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model()}:generateContent?key={key()}"
    d = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                d = json.load(resp); break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 5:
                time.sleep(8 * (attempt + 1)); continue
            return out_name, f"HTTP {e.code}: {e.read().decode()[:200]}"
        except Exception as e:
            if attempt < 5: time.sleep(6); continue
            return out_name, f"ERR {e}"
    try:
        for part in d["candidates"][0]["content"]["parts"]:
            node = part.get("inlineData") or part.get("inline_data")
            if node:
                (out() / f"{out_name}.png").write_bytes(base64.b64decode(node["data"]))
                return out_name, "OK"
        return out_name, f"no image part: {json.dumps(d)[:200]}"
    except Exception as e:
        return out_name, f"parse-fail {e}"

def run_batch(jobs, workers=5):
    for j in jobs:  # resolve gallery-number refs up front (main thread -> clear, fail-fast error)
        j["refs"] = resolve_refs(j.get("refs"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(gen, j["prompt"], j["name"], j.get("refs"), j.get("aspect")) for j in jobs]
        for f in concurrent.futures.as_completed(futs):
            name, status = f.result(); print(f"  [{status[:60]}] {name}")
    missing = [j for j in jobs if not (out() / f"{j['name']}.png").exists()]
    if missing:
        print(f"  retrying {len(missing)} missing...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(2, workers // 2)) as ex:
            for f in concurrent.futures.as_completed([ex.submit(gen, j["prompt"], j["name"], j.get("refs"), j.get("aspect")) for j in missing]):
                name, status = f.result(); print(f"  [retry {status[:50]}] {name}")

def anchor():
    """Compose the project anchor text from config."""
    c = cfg()
    a = f"Homepage hero for '{c.get('product_name','the product')}'"
    if c.get("product_desc"): a += f" — {c['product_desc']}"
    a += ". "
    if c.get("headline"): a += f"Hero headline '{c['headline']}'. "
    if c.get("data_points"): a += "Real data: " + ", ".join(f"'{d}'" for d in c["data_points"]) + ". "
    return a

def rules():
    return cfg().get("rules", " Sophisticated, gallery-grade, art-directed, high craft. Flat full-bleed "
        "desktop homepage, not in a device frame. AVOID generic AI SaaS boilerplate and lifestyle/interior "
        "stock. Only headline text legible.")
