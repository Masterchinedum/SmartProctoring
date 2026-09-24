"""
Parity of prep.py (Python port of embed-prep.ts) with the server: for a sample of analysed webcam frames, the
server's cached recipe embeddings (analysis-*.jsonl: flip, stretch, stretch-flip, gamma-flip, clahe-flip) are
compared with Python recipe embeddings computed from the same frame and landmarks.

  python tools/recognizer/check_recipes.py [--n 300]
"""
from __future__ import annotations

import argparse
import base64

import numpy as np

from common import SFACE_ONNX, Face, OrtEmbedder, decode_image, l2n, load_rgb
from eval import FRAMES, SIM_DIR, _align_valid, _safe, load_records
from prep import views

RECIPES = {"flip": ("none", True), "stretch": ("stretch", False), "stretch-flip": ("stretch", True), "gamma-flip": ("gamma", True), "clahe-flip": ("clahe", True)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    args = ap.parse_args()
    recs = [r for r in load_records(FRAMES) if r.get("faces") and r.get("embeddings")]
    rng = np.random.default_rng(0)
    recs = [recs[i] for i in rng.choice(len(recs), min(args.n, len(recs)), replace=False)]
    emb = OrtEmbedder(SFACE_ONNX)
    cos = {k: [] for k in RECIPES}
    for r in recs:
        file = FRAMES / SIM_DIR / _safe(r["photoKey"]) / f"{r['role']}-{r['condition']}-{r['resolution']}-s{r['scene']}-f{r['frame']}.jpg"
        lm = np.array([[p["x"], p["y"]] for p in r["faces"][0]["landmarks"]])
        crop, valid = _align_valid(decode_image(load_rgb(file)), Face(box=(0, 0, 1, 1), score=1, landmarks=lm))
        for name, (norm, flip) in RECIPES.items():
            if name not in r["embeddings"]:
                continue
            vs = views(crop, valid, norm, flip)
            e = l2n(emb(np.stack(vs).transpose(0, 3, 1, 2)).sum(0))
            ts = np.frombuffer(base64.b64decode(r["embeddings"][name]), np.float32)
            cos[name].append(float(e @ ts))
    for k, v in cos.items():
        if v:
            v = np.array(v)
            print(f"{k:13s} n={len(v)}  cosine(python, server): min {v.min():.5f}  p01 {np.quantile(v, 0.01):.5f}  median {np.median(v):.6f}")


if __name__ == "__main__":
    main()
