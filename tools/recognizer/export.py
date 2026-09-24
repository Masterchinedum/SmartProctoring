"""
Export a trained student to an SFace-compatible ONNX file and check it.

  python tools/recognizer/export.py --run A_upto7 --method A --out $RECOG_WORK/export/A_upto7.onnx

Contract of the exported model (identical to face_recognition_sface_2021dec.onnx, so it is a drop-in file):
  input  'data'  float32 [N, 3, 112, 112]  RGB planar, 0..255, un-normalised, ArcFace-aligned crop (align.ts)
  output 'fc1'   float32 [N, 128]          raw embedding; L2-normalise it (engine.ts already does)
(N is dynamic; the server feeds N = 1.)

Checks written to <out>.json:
  parity   PyTorch vs onnxruntime on real aligned crops (clean + degraded): min cosine (requirement >= 0.999)
  latency  onnxruntime CPU, batch 1, 1 and 2 intra-op threads, median ms per face, versus the original SFace
           loaded the way the server loads it (initializers removed from the graph inputs)
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import onnx
import torch

from common import SFACE_ONNX, WORK, OrtEmbedder, l2n, sha256_file, write_json
from train import build_student


def latency(path: str, threads: int, runs: int = 300) -> float:
    import onnxruntime as ort

    m = onnx.load(path)
    init = {t.name for t in m.graph.initializer}
    keep = [i for i in m.graph.input if i.name not in init]
    del m.graph.input[:]
    m.graph.input.extend(keep)
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    so.log_severity_level = 3
    s = ort.InferenceSession(m.SerializeToString(), sess_options=so, providers=["CPUExecutionProvider"])
    x = {s.get_inputs()[0].name: (np.random.rand(1, 3, 112, 112) * 255).astype(np.float32)}
    for _ in range(20):
        s.run(None, x)
    ts = []
    for _ in range(runs):
        t = time.perf_counter()
        s.run(None, x)
        ts.append((time.perf_counter() - t) * 1000)
    return float(np.median(ts))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--method", choices=["A", "B"], required=True)
    ap.add_argument("--train-upto", default="conv_7")
    ap.add_argument("--out", required=True)
    ap.add_argument("--data", default=str(WORK / "train" / "dataset.npz"))
    ap.add_argument("--enh-c1", type=int, default=16)
    ap.add_argument("--enh-c2", type=int, default=32)
    ap.add_argument("--enh-blocks", type=int, default=2)
    ap.add_argument("--description", default="")
    ap.add_argument("--alpha", type=float, default=1.0, help="WiSE-FT: theta = alpha * student + (1 - alpha) * teacher (method B: residual scaled by alpha)")
    ap.add_argument("--checkpoint", default="best.pt")
    args = ap.parse_args()
    torch.set_num_threads(4)
    model, _ = build_student(args.method, args.train_upto, args.enh_c1, args.enh_c2, args.enh_blocks)
    sd = torch.load(WORK / "runs" / args.run / args.checkpoint)
    if args.alpha != 1.0:
        if args.method == "A":
            teacher = build_student("A", args.train_upto)[0].state_dict()
            sd = {k: (args.alpha * v + (1 - args.alpha) * teacher[k]) if v.is_floating_point() else v for k, v in sd.items()}
        else:
            sd = dict(sd)
            for k in ("enhancer.out.weight", "enhancer.out.bias"):
                sd[k] = sd[k] * args.alpha
    model.load_state_dict(sd)
    model.eval()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.rand(1, 3, 112, 112) * 255
    torch.onnx.export(
        model, (dummy,), str(out), input_names=["data"], output_names=["fc1"], dynamic_axes={"data": {0: "N"}, "fc1": {0: "N"}},
        opset_version=13, do_constant_folding=True, dynamo=False,
    )
    m = onnx.load(str(out))
    onnx.checker.check_model(m)
    meta = {
        "name": out.stem,
        "base_model": "OpenCV Zoo face_recognition_sface_2021dec.onnx (Apache-2.0)",
        "license": "Apache-2.0 (derivative work; see THIRD_PARTY_NOTICES.md)",
        "training": "label-free self-distillation for webcam robustness (tools/recognizer), public-domain US Congress portraits",
        "io": "data float32[N,3,112,112] RGB 0..255 aligned (ArcFace 112 template) -> fc1 float32[N,128] (L2-normalise)",
        "description": args.description,
        "wise_ft_alpha": str(args.alpha),
    }
    del m.metadata_props[:]
    for k, v in meta.items():
        p = m.metadata_props.add()
        p.key, p.value = k, v
    m.producer_name = "SmartProctoring tools/recognizer"
    onnx.save(m, str(out))

    # parity on real crops
    d = np.load(args.data)
    xs = np.concatenate([d["clean"][:64], d["deg"][:: max(1, len(d["deg"]) // 192)][:192]]).transpose(0, 3, 1, 2).astype(np.float32)
    with torch.no_grad():
        e_pt = l2n(model(torch.from_numpy(xs)).numpy())
    e_ort = OrtEmbedder(str(out))(xs)
    cos = (e_pt * e_ort).sum(1)
    res = {
        "file": str(out), "sha256": sha256_file(out), "bytes": out.stat().st_size,
        "parity": {"n": len(cos), "cos_min": float(cos.min()), "cos_median": float(np.median(cos))},
        "latency_ms_per_face": {
            f"{t}_thread": {"candidate": latency(str(out), t), "original": latency(str(SFACE_ONNX), t)} for t in (1, 2)
        },
        "metadata": meta,
    }
    for k, v in res["latency_ms_per_face"].items():
        v["ratio"] = v["candidate"] / v["original"]
    write_json(out.with_suffix(".json"), res)
    print(res)
    if cos.min() < 0.999:
        raise SystemExit("parity check failed")


if __name__ == "__main__":
    main()
