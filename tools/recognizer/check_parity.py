"""
Parity check: Python decode -> YuNet -> align -> SFace (common.py) versus the production TypeScript engine.

  apps/server/node_modules/.bin/tsx tools/recognizer/ts/dump_embeddings.mts list.txt > ts.jsonl
  python tools/recognizer/check_parity.py ts.jsonl [--model <onnx>]

For every image both paths embed, reports
  (a) the cosine between the server embedding and the Python embedding computed from the server's landmarks
      (decode + alignment + SFace parity; requirement >= 0.99, observed >= 0.9999), and
  (b) the cosine for the fully independent Python path. (b) is lower on small / heavily resized photos because
      PIL's Lanczos and libvips' resamplers differ (mean |diff| ~1.5 grey levels on a 150->640 upscale), which moves
      YuNet landmarks by ~1-8 px. The evaluation therefore uses the SERVER's landmarks for its crops
      (eval.py), so evaluated crops are production-exact; training crops use the Python detector. `--model` embeds the Python crops with another SFace-compatible ONNX file (use it
together with dump_embeddings.mts --models <dir> to check a candidate model end-to-end).
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from common import SFACE_ONNX, OrtEmbedder, YuNet, align_primary, decode_image, detect_and_align, to_planar, Face


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ts_jsonl")
    ap.add_argument("--model", default=str(SFACE_ONNX))
    ap.add_argument("--min-cos", type=float, default=0.99)
    args = ap.parse_args()
    det = YuNet()
    emb = OrtEmbedder(args.model)
    rows = [json.loads(l) for l in open(args.ts_jsonl) if l.strip()]
    cos_align, cos_full, lmd, both_missing, mismatched = [], [], [], 0, []
    for r in rows:
        crop, face = detect_and_align(det, r["file"])
        if not r.get("ok") or crop is None:
            if (crop is None) != (not r.get("ok")):
                mismatched.append(r["file"])
            else:
                both_missing += 1
            continue
        e_ts = np.asarray(r["embedding"], np.float32)
        # (a) alignment + embedding parity: Python decode/align/embed from the SERVER's landmarks.
        ts_face = Face(box=face.box, score=face.score, landmarks=np.asarray(r["landmarks"], np.float64))
        e_al = emb(to_planar(align_primary(decode_image(r["file"]), ts_face))[None])[0]
        cos_align.append(float(e_al @ e_ts))
        # (b) the fully independent Python path (own detector-input resampling -> slightly different landmarks).
        e_py = emb(to_planar(crop)[None])[0]
        cos_full.append(float(e_py @ e_ts))
        lmd.append(float(np.abs(face.landmarks - np.asarray(r["landmarks"])).max()))
    ca, cf, lmd = np.array(cos_align), np.array(cos_full), np.array(lmd)
    print(f"images {len(rows)}  compared {len(ca)}  no face in both {both_missing}  detection disagrees {len(mismatched)} {mismatched[:5]}")
    print(f"(a) align+embed from server landmarks, cosine(python, ts): min {ca.min():.5f}  median {np.median(ca):.6f}")
    print(f"(b) full python path (PIL vs libvips detector-input resampling), cosine: min {cf.min():.4f}  p05 {np.quantile(cf, 0.05):.4f}  median {np.median(cf):.5f}")
    print(f"    landmark max |diff| px: median {np.median(lmd):.3f}  p95 {np.quantile(lmd, 0.95):.3f}  max {lmd.max():.3f}")
    bad = int((ca < args.min_cos).sum())
    print(f"(a) images below {args.min_cos}: {bad}")
    raise SystemExit(1 if bad or mismatched else 0)


if __name__ == "__main__":
    main()
