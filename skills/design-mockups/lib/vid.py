#!/usr/bin/env python3
"""Motion previews via Veo (image->video), config-driven. Turns a chosen comp into a short
clip to preview the motion FEEL before building. Impressionistic (warps text) — direction, not spec.

  from lib import vid
  vid.make_video("mockups_out/recipe-04-clean.png",
                 "gentle parallax on the floating panels, slow cinematic push-in", "motion-04", aspect="9:16")
"""
import json, base64, time, pathlib, urllib.request, urllib.error
import gen  # config-driven core (KEY, CFG, OUT)

MODEL = gen.CFG.get("video_model", "veo-3.1-generate-preview")
VOUT = gen.OUT / "vid"; VOUT.mkdir(parents=True, exist_ok=True)
B = "https://generativelanguage.googleapis.com/v1beta"

def make_video(img_path, prompt, name, aspect="9:16"):
    img = base64.b64encode(pathlib.Path(img_path).read_bytes()).decode()
    body = {"instances": [{"prompt": prompt, "image": {"bytesBase64Encoded": img, "mimeType": "image/png"}}],
            "parameters": {"aspectRatio": aspect}}
    try:
        op = json.load(urllib.request.urlopen(urllib.request.Request(
            f"{B}/models/{MODEL}:predictLongRunning?key={gen.key()}",
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}), timeout=120))
    except urllib.error.HTTPError as e:
        return f"SUBMIT HTTP {e.code}: {e.read().decode()[:300]}"
    opname = op.get("name")
    if not opname: return f"no operation: {json.dumps(op)[:200]}"
    for i in range(40):
        time.sleep(10)
        st = json.load(urllib.request.urlopen(f"{B}/{opname}?key={gen.key()}", timeout=120))
        if st.get("done"):
            resp = st.get("response", {})
            vids = (resp.get("generateVideoResponse", {}).get("generatedSamples")
                    or resp.get("predictions") or resp.get("videos") or [])
            for v in vids:
                node = v.get("video", v)
                data = node.get("bytesBase64Encoded") or node.get("videoBytes")
                uri = node.get("uri") or node.get("videoUri")
                if data:
                    (VOUT / f"{name}.mp4").write_bytes(base64.b64decode(data)); return f"OK -> {name}.mp4"
                if uri:
                    dl = uri + (("&" if "?" in uri else "?") + f"key={gen.key()}")
                    (VOUT / f"{name}.mp4").write_bytes(urllib.request.urlopen(dl, timeout=180).read()); return f"OK -> {name}.mp4"
            return f"done, no video: {json.dumps(resp)[:200]}"
    return "TIMEOUT"
