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

def load_config():
    p = os.environ.get("DESIGN_MOCKUP_CONFIG") or ("mockup.config.json" if pathlib.Path("mockup.config.json").exists() else None)
    if not p or not pathlib.Path(p).exists():
        sys.exit("No config: set DESIGN_MOCKUP_CONFIG or create ./mockup.config.json (see config.example.json)")
    return json.loads(pathlib.Path(p).read_text())

CFG   = load_config()
MODEL = CFG.get("model", "gemini-3-pro-image")
OUT   = pathlib.Path(CFG.get("out_dir", "mockups_out")); OUT.mkdir(parents=True, exist_ok=True)
ASPECT_DEFAULT = CFG.get("aspect", "3:4")

def _api_key():
    env = CFG.get("api_key_env", "GOOGLE_AI_API_KEY")
    if os.environ.get(env): return os.environ[env]
    f = CFG.get("api_key_file")
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

def gen(prompt, out_name, refs=None, aspect=None):
    aspect = aspect or ASPECT_DEFAULT
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
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key()}"
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
                (OUT / f"{out_name}.png").write_bytes(base64.b64decode(node["data"]))
                return out_name, "OK"
        return out_name, f"no image part: {json.dumps(d)[:200]}"
    except Exception as e:
        return out_name, f"parse-fail {e}"

def run_batch(jobs, workers=5):
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(gen, j["prompt"], j["name"], j.get("refs"), j.get("aspect")) for j in jobs]
        for f in concurrent.futures.as_completed(futs):
            name, status = f.result(); print(f"  [{status[:60]}] {name}")
    missing = [j for j in jobs if not (OUT / f"{j['name']}.png").exists()]
    if missing:
        print(f"  retrying {len(missing)} missing...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(2, workers // 2)) as ex:
            for f in concurrent.futures.as_completed([ex.submit(gen, j["prompt"], j["name"], j.get("refs"), j.get("aspect")) for j in missing]):
                name, status = f.result(); print(f"  [retry {status[:50]}] {name}")

def anchor():
    """Compose the project anchor text from config."""
    c = CFG
    a = f"Homepage hero for '{c.get('product_name','the product')}'"
    if c.get("product_desc"): a += f" — {c['product_desc']}"
    a += ". "
    if c.get("headline"): a += f"Hero headline '{c['headline']}'. "
    if c.get("data_points"): a += "Real data: " + ", ".join(f"'{d}'" for d in c["data_points"]) + ". "
    return a

def rules():
    return CFG.get("rules", " Sophisticated, gallery-grade, art-directed, high craft. Flat full-bleed "
        "desktop homepage, not in a device frame. AVOID generic AI SaaS boilerplate and lifestyle/interior "
        "stock. Only headline text legible.")
