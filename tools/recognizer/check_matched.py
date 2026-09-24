"""
MATCHED-DEGRADATION impostor check on validation portraits rendered by the TypeScript simulator
(ts/render_val_frames.mts): a reference enrolled in a poor condition (3-frame template, 640x480) against probes of
OTHER people in the SAME condition. SFace's impostor similarity inflates there (e2e found a missed swap), so a
candidate must not make it worse.

  python tools/recognizer/check_matched.py --model base=<onnx> --model A=<onnx> [--recipe none]

Reported per model and condition (dim, backlit; good as the reference condition):
  impostor mean / p99 / p99.9 / max (single probe frame, and 1280x720 probe of another scene)
  FMR of matched pairs at (a) the model's OWN good-light threshold (good/good impostors, FAR 1e-3) and
  (b) the fixed product match threshold 0.45: the false matches a dim room adds if one calibration is used
  genuine (same person, other scene 1280x720) mean / p05, for context.
Identities: the 150 held-out training-source portraits (public domain), never the evaluation identities.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from common import WORK, Face, OrtEmbedder, decode_image, l2n, load_rgb
from eval import _align_valid
from prep import views


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--recipe", default="none")
    ap.add_argument("--frames", default=str(WORK / "valframes" / "frames.jsonl"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    rows = [json.loads(l) for l in open(args.frames) if l.strip()]
    rows = [r for r in rows if r["landmarks"]]
    crops = []
    for r in rows:
        c, v = _align_valid(decode_image(load_rgb(r["file"])), Face(box=(0, 0, 1, 1), score=1, landmarks=np.array(r["landmarks"])))
        crops.append((c, v))
    norm, _, flip = args.recipe.partition("+")
    port = np.array([r["portrait"] for r in rows])
    cond = np.array([r["condition"] for r in rows])
    res = np.array([r["resolution"] for r in rows])
    out = {}
    for spec in args.model:
        name, path = spec.split("=", 1)
        emb = OrtEmbedder(path)
        E = np.stack([l2n(emb(np.stack(views(c, v, norm, flip == "flip")).transpose(0, 3, 1, 2)).sum(0)) for c, v in crops])
        res_m = {}
        thr_good = None
        for c in ("good", "dim", "backlit"):
            m480 = (cond == c) & (res == "640x480")
            ps = sorted(set(port[m480]))
            T = {p: l2n(E[m480 & (port == p)].mean(0)) for p in ps if (m480 & (port == p)).sum() >= 2}
            pl = list(T)
            Tm = np.stack([T[p] for p in pl])
            # impostor: template of i vs single 640x480 frames of j != i (same condition)
            fi = np.nonzero(m480)[0]
            S = Tm @ E[fi].T
            imp = S[np.array(pl)[:, None] != port[fi][None, :]]
            # other-scene probes (1280x720, scene 2): genuine = same portrait, impostor = others
            f7 = np.nonzero((cond == c) & (res == "1280x720"))[0]
            gen, imp7 = np.array([]), np.array([])
            if len(f7):
                S7 = Tm @ E[f7].T
                same = np.array(pl)[:, None] == port[f7][None, :]
                gen, imp7 = S7[same], S7[~same]
            if c == "good":
                thr_good = float(np.quantile(imp, 1 - 1e-3))
            q = lambda v, p: float(np.quantile(v, p)) if len(v) else None  # noqa: E731
            res_m[c] = {
                "templates": len(pl), "n_impostor": int(len(imp)),
                "impostor_mean": float(imp.mean()), "impostor_p99": q(imp, 0.99), "impostor_p999": q(imp, 0.999), "impostor_max": float(imp.max()),
                "fmr_at_own_good_thr": float((imp >= thr_good).mean()) if thr_good is not None else None,
                "fmr_at_0.45": float((imp >= 0.45).mean()), "fmr_at_0.40": float((imp >= 0.40).mean()),
                "other_scene_impostor_p99": q(imp7, 0.99), "genuine_other_scene_mean": float(gen.mean()) if len(gen) else None, "genuine_other_scene_p05": q(gen, 0.05),
            }
        res_m["own_good_thr_far1e-3"] = thr_good
        out[name] = res_m
        print(name, f"good-light thr(FAR1e-3)={thr_good:.3f}")
        for c in ("good", "dim", "backlit"):
            r = res_m[c]
            print(f"  {c:8s} n_imp={r['n_impostor']:6d} imp mean {r['impostor_mean']:.3f} p99 {r['impostor_p99']:.3f} p99.9 {r['impostor_p999']:.3f} max {r['impostor_max']:.3f} | "
                  f"FMR@own-good-thr {100 * r['fmr_at_own_good_thr']:.2f}% FMR@0.45 {100 * r['fmr_at_0.45']:.3f}% | genuine(other scene) mean {r['genuine_other_scene_mean']:.3f} p05 {r['genuine_other_scene_p05']:.3f}")
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
